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

function TerminalPane({ context, session, active, connected, generation, profile, machineId }: {
  context: UiContext; session: Session; active: boolean; connected: boolean; generation: number; profile: Settings; machineId: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const fit = useRef<FitAddon>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const term = new Terminal({
      fontSize: profile.font.size, lineHeight: profile.font.lineHeight,
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
    let socket: WebSocket | undefined;
    setError('');
    const send = (op: string, params: Record<string, unknown> = {}) => {
      socket!.send(JSON.stringify({ op, session_id: session.id, ...params }));
    };
    const sendSize = () => {
      if (!ready || replaying) return;
      send('resize', { rows: term.rows, cols: term.cols });
    };
    if (connected) {
      void api.address(machineId).then((url) => {
        if (!alive) return;
        socket = new WebSocket(url);
        // Chromium hands binary frames over as blobs unless it is told otherwise.
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => send('attach');
        const decoder = new TextDecoder();
        socket.onmessage = ({ data }) => {
          if (!alive) return;
          if (typeof data === 'string') {
            const reply = JSON.parse(data);
            if (reply.error) setError(reply.error);
            return;
          }
          const bytes = new Uint8Array(data);
          const length = new DataView(data).getUint32(0);
          const event = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length))) as { event: string; rows: number; cols: number };
          const payload = bytes.subarray(4 + length);
          if (event.event === 'snapshot') {
            replaying = true;
            ready = true;
            term.reset();
            term.resize(event.cols, event.rows);
            term.write(payload, () => {
              if (!alive) return;
              replaying = false;
              if (!element.current?.offsetWidth) return;
              addon.fit();
              sendSize();
            });
            return;
          }
          term.write(payload);
        };
        socket.onclose = () => { if (alive) setError('终端连接已断开'); };
      }).catch((error: Error) => { if (alive) setError(error.message); });
    }
    const input = term.onData((data) => {
      if (!ready || replaying) return;
      send('input', { data });
    });
    const resize = term.onResize(sendSize);
    const observer = new ResizeObserver(() => {
      if (!replaying && element.current?.offsetWidth && element.current.offsetHeight) addon.fit();
    });
    observer.observe(element.current!);
    return () => {
      alive = false;
      input.dispose(); resize.dispose(); observer.disconnect();
      links.dispose(); socket?.close(); term.dispose(); terminal.current = null;
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
        machineId={workspace.machineId}
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
    address: (machineId) => context.ui.request('address', { machineId }),
    resolve: (sessionId, paths) => context.ui.request('resolve', { sessionId, paths }),
    onConfig: (callback) => context.ui.subscribe('config', callback),
    onState: (callback) => context.ui.subscribe('state', callback),
  };
  const profile: Settings = context.host.config;
  container.style.fontFamily = profile.font.family;
  const root = createRoot(container);
  root.render(<App context={context} profile={profile} />);
  return () => root.unmount();
}
