import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { FitAddon } from '@xterm/addon-fit';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { trackCommand } from './command';
import { registerFileLinks } from './file-links/links';
import { maxImageBytes } from './shared';
import type { Config, MachineState, Session, Settings, WangcaiAPI, Workspace } from './shared';
import '@xterm/xterm/css/xterm.css';
import './style.css';

let api: WangcaiAPI;

const OUTPUT_REPORT = 250;

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
    const openAddress = (uri: string) => { void context.host.open(uri).catch((error: Error) => setError(error.message)); };
    // What the terminal prints as a web address is a link the app opens in a browser, on the click that holds
    // Command: on its own the click stays a click in the terminal.
    term.loadAddon(new WebLinksAddon((event, uri) => { if (event.metaKey) openAddress(uri); }));
    term.open(element.current!);
    const links = registerFileLinks(term, {
      resolve: (paths) => api.resolve(session.id, paths),
      activate: (path, line, column) => { void api.click(session.id, { path, line, column }).catch((error: Error) => setError(error.message)); },
      openAddress,
    });
    // Command is what shows a link, and what the click on it opens with.
    const command = trackCommand(term.element!, links.setCommand);
    terminal.current = term;
    fit.current = addon;
    let alive = true;
    let replaying = false;
    let ready = false;
    let socket: WebSocket | undefined;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastReport = 0;
    setError('');
    const send = (op: string, params: Record<string, unknown> = {}) => {
      socket!.send(JSON.stringify({ op, session_id: session.id, ...params }));
    };
    const sendSize = () => {
      if (!ready || replaying) return;
      send('resize', { rows: term.rows, cols: term.cols });
    };
    if (connected) {
      const reconnect = (error: Error) => {
        if (!alive || retry !== undefined) return;
        ready = false;
        setError(`${error.message}，正在重连…`);
        retry = setTimeout(() => void connect(), Math.min(1000 * 2 ** attempt++, 5000));
      };
      // The app hands out another port when it reconnects, so every attempt asks for the address again.
      const connect = async () => {
        retry = undefined;
        if (!alive) return;
        let url: string;
        try { url = await api.address(machineId); }
        catch (error) { reconnect(error as Error); return; }
        if (!alive) return;
        socket = new WebSocket(url);
        // Chromium hands binary frames over as blobs unless it is told otherwise.
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => { attempt = 0; send('attach'); };
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
            setError('');
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
          // The app reads the quiet after the last report as the end, so output is reported at most once per interval.
          const now = Date.now();
          if (now - lastReport >= OUTPUT_REPORT) {
            lastReport = now;
            void api.activity(session.id).catch(() => {});
          }
          term.write(payload);
        };
        socket.onclose = () => { if (alive) reconnect(new Error('终端连接已断开')); };
      };
      void connect();
    }
    const input = term.onData((data) => {
      if (!ready || replaying) return;
      send('input', { data });
    });
    const resize = term.onResize(sendSize);
    let pasting = Promise.resolve();
    const paste = (event: ClipboardEvent) => {
      const image = [...(event.clipboardData?.items ?? [])].find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
      if (!image) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pasting = pasting.then(async () => {
        if (!alive || !ready || replaying || socket?.readyState !== WebSocket.OPEN) return;
        if (image.size > maxImageBytes) throw new Error('Image exceeds 16 MiB');
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(image);
        });
        if (!alive) return;
        const path = await api.image(session.id, dataUrl);
        if (!alive || !ready || replaying || socket?.readyState !== WebSocket.OPEN) return;
        term.paste(/^[\w/.-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`);
      }).catch((error: Error) => { if (alive) setError(error.message); });
    };
    const surface = element.current!;
    term.attachCustomKeyEventHandler((event) => !(event.key.toLowerCase() === 'v' && (event.metaKey || event.ctrlKey) && !event.altKey));
    // Capture image pastes before xterm consumes the clipboard as plain text.
    surface.addEventListener('paste', paste, true);
    const observer = new ResizeObserver(() => {
      if (!replaying && element.current?.offsetWidth && element.current.offsetHeight) addon.fit();
    });
    observer.observe(element.current!);
    return () => {
      alive = false;
      clearTimeout(retry);
      surface.removeEventListener('paste', paste, true);
      input.dispose(); resize.dispose(); observer.disconnect();
      command.dispose(); links.dispose(); socket?.close(); term.dispose(); terminal.current = null;
    };
  }, [session.id, connected, generation, profile]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => { fit.current?.fit(); terminal.current?.focus(); });
  }, [active, connected, generation]);

  // A key that shows this workspace puts the focus on the page, and what the page draws is a terminal.
  useEffect(() => {
    const page = element.current?.closest<HTMLElement>('[data-plugin]');
    if (!page) return;
    const focus = () => { if (active) terminal.current?.focus(); };
    page.addEventListener('focus', focus);
    return () => page.removeEventListener('focus', focus);
  }, [active]);

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
    activity: (sessionId) => context.ui.request('activity', { sessionId }),
    selectWorkspace: (id) => context.ui.request('workspace-select', { id }),
    address: (machineId) => context.ui.request('address', { machineId }),
    resolve: (sessionId, paths) => context.ui.request('resolve', { sessionId, paths }),
    image: (sessionId, dataUrl) => context.ui.request('image', { sessionId, dataUrl }),
    onConfig: (callback) => context.ui.subscribe('config', callback),
    onState: (callback) => context.ui.subscribe('state', callback),
  };
  const profile: Settings = context.host.config;
  container.style.fontFamily = profile.font.family;
  const root = createRoot(container);
  root.render(<App context={context} profile={profile} />);
  return () => root.unmount();
}
