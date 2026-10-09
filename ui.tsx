import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { FitAddon } from '@xterm/addon-fit';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { registerFileLinks } from './file-links/links';
import type { Config, MachineState, Session, Settings, WangcaiAPI, Workspace } from './shared';
import '@xterm/xterm/css/xterm.css';
import './style.css';

let api: WangcaiAPI;

function TerminalPane({ context, session, active, connected, generation, profile }: {
  context: UiContext; session: Session; active: boolean; connected: boolean; generation: number; profile: Settings;
}) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const fit = useRef<FitAddon>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true, fontSize: profile.font.size, lineHeight: profile.font.lineHeight,
      fontFamily: profile.font.family,
      // xterm takes its scrollbar width from the overview ruler, which also paints the ruler outline.
      overviewRuler: { width: 10 },
      scrollback: 10_000, cols: session.cols, rows: session.rows,
      theme: { ...profile.theme, overviewRulerBorder: profile.theme.background, selectionBackground: profile.theme.selection },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    // What a program in the terminal copies goes to the system clipboard: OSC 52.
    term.loadAddon(new ClipboardAddon());
    // What the terminal prints as a web address is a link the app opens in a browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => { void context.host.open(uri).catch((error: Error) => setError(error.message)); }));
    term.open(element.current!);
    const links = registerFileLinks(term, {
      resolve: (paths) => api.resolve(session.id, paths),
      activate: (path, line, column) => { void api.click(session.id, { path, line, column }).catch((error: Error) => setError(error.message)); },
    });
    terminal.current = term;
    fit.current = addon;
    let alive = true;
    let replaying = false;
    let ready = false;
    setError('');
    const sendSize = () => {
      if (!alive || !ready || replaying) return;
      void api.pty('resize', session.id, { rows: term.rows, cols: term.cols }).catch((error: Error) => { if (alive) setError(error.message); });
    };
    const unsubscribe = api.onTerminal((event) => {
      if (!alive || event.session_id !== session.id) return;
      if (event.event === 'snapshot') {
        replaying = true;
        term.reset();
        term.resize(event.cols, event.rows);
        term.write(event.data, () => {
          if (!alive) return;
          replaying = false;
          if (!element.current?.offsetWidth) return;
          addon.fit();
          sendSize();
        });
      } else {
        term.write(event.data);
      }
    });
    const input = term.onData((data) => {
      if (!ready || replaying) return;
      void api.pty('input', session.id, { data }).catch((error: Error) => { if (alive) setError(error.message); });
    });
    const resize = term.onResize(sendSize);
    const observer = new ResizeObserver(() => {
      if (!replaying && element.current?.offsetWidth && element.current.offsetHeight) addon.fit();
    });
    observer.observe(element.current!);
    if (connected) {
      void api.pty('attach', session.id).then(() => {
        if (!alive) return;
        ready = true;
        sendSize();
      }).catch((error: Error) => { if (alive) setError(error.message); });
    }
    return () => {
      alive = false;
      ready = false;
      unsubscribe(); input.dispose(); resize.dispose(); observer.disconnect();
      links.dispose(); term.dispose(); terminal.current = null;
      if (connected) void api.pty('detach', session.id).catch(() => {});
    };
  }, [session.id, connected, generation, profile]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => { fit.current?.fit(); terminal.current?.focus(); });
  }, [active, connected, generation]);

  return <div className={`terminal-pane ${active ? 'active' : ''}`}>
    <div className="terminal-surface" ref={element} />
    {error && <div className="terminal-message error">{error}</div>}
    {session.exit_code !== null && <div className="terminal-message">进程已退出 · exit {session.exit_code}</div>}
  </div>;
}

function App({ context, profile }: { context: UiContext; profile: Settings }) {
  const [config, setConfig] = useState<Config>();
  const [states, setStates] = useState<Record<string, MachineState>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    const off = api.onState((state) => setStates((states) => ({ ...states, [state.machineId]: state })));
    const offConfig = api.onConfig(setConfig);
    // The window may mount after a machine is already connected: ask for what happened before it listened.
    void api.states().then((list) => setStates((states) => ({ ...Object.fromEntries(list.map((state) => [state.machineId, state])), ...states }))).catch((error: Error) => setError(error.message));
    void api.config().then(setConfig).catch((error: Error) => setError(error.message));
    return () => { off(); offConfig(); };
  }, []);
  if (!config) return <div className="loading">{error || '正在打开 旺财…'}</div>;
  // The window says which workspace is in front; what runs in it is this plugin's business.
  const front = config.workspaces.find((workspace) => workspace.id === config.active);
  const sessionFor = (workspace: Workspace) => (states[workspace.machineId]?.sessions ?? []).find((session) => session.id === workspace.sessionId);
  const frontSession = front ? sessionFor(front) : undefined;
  const errorMessage = error || (front ? states[front.machineId]?.error : undefined);
  return <div className="terminal-area">
    {errorMessage && <div className="error-banner"><span>{errorMessage}</span>{error && <button onClick={() => setError('')}>×</button>}</div>}
    {config.workspaces.map((workspace) => {
      const session = sessionFor(workspace);
      return session ? <TerminalPane
        key={`${workspace.id}:${session.id}`}
        context={context}
        session={session}
        active={workspace.id === config.active}
        connected={states[workspace.machineId]?.status === 'connected'}
        generation={states[workspace.machineId]?.generation ?? 0}
        profile={profile}
      /> : null;
    })}
    {front && frontSession?.exit_code !== null && <div className="terminal-message">
      终端未运行
      <button onClick={() => void api.selectWorkspace(front.id).catch((error: Error) => setError(error.message))}>重新打开终端</button>
    </div>}
  </div>;
}

export function mount(container: HTMLElement, context: UiContext) {
  container.classList.add('wangcai-terminal-agent');
  api = {
    click: (sessionId, location) => context.ui.request('click', { sessionId, location }),
    config: () => context.ui.request('config'),
    states: () => context.ui.request('states'),
    selectWorkspace: (id) => context.ui.request('workspace-select', { id }),
    pty: (op, sessionId, params = {}) => context.ui.request('pty', { op, sessionId, params }),
    resolve: (sessionId, paths) => context.ui.request('resolve', { sessionId, paths }),
    onConfig: (callback) => context.ui.subscribe('config', callback),
    onState: (callback) => context.ui.subscribe('state', callback),
    onTerminal: (callback) => context.ui.subscribe('terminal', callback),
  };
  const profile: Settings = context.host.config;
  container.style.fontFamily = profile.font.family;
  const root = createRoot(container);
  root.render(<App context={context} profile={profile} />);
  return () => root.unmount();
}
