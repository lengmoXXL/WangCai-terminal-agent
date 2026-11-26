import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { request } from 'node:http';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MachineConnection, WorkspaceActive, WorkspaceRow, WorkspaceStatus } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { registerFilePaths } from './file-links/paths';
import { registerImages } from './images';
import { terminalMachineOf } from './shared';
import type { CodexSettings, Machine, MachineState, Workspace } from './shared';

export const keys = { '<leader>a': { global: true, insert: true, desc: '切到工作区终端', event: 'core:show-view', data: { plugin: 'terminal-agent' } } };

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: 'Menlo, monospace' },
    size: { type: 'number', default: 13 },
    lineHeight: { type: 'number', default: 1 },
  },
  machines: { type: 'array', default: [] },
  images: { maxCount: { type: 'number', default: 100 } },
  codex: {
    enabled: { type: 'boolean', default: false },
    command: { type: 'string', default: 'codex' },
    remoteCommand: { type: 'string', default: 'codex' },
    port: { type: 'number', default: 4500 },
    args: { type: 'array', default: [] },
  },
};

const LOCAL: Machine = { id: 'local', name: '本机' };

// The environment a machine asks for: strings only, so a mistyped value drops out instead of reaching a node.
function machineEnvironment(input: unknown): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string') env[name] = value;
  }
  return Object.keys(env).length ? env : undefined;
}

/** The machines init.ts names, local first: a host is both the id and the ssh target, and 'local' is reserved. */
function machineList(given: unknown[]): Machine[] {
  const machines = [LOCAL];
  for (const entry of given) {
    const { name, host, env } = (entry ?? {}) as { name?: unknown; host?: unknown; env?: unknown };
    if (host === 'local') {
      const label = typeof name === 'string' ? name.trim() : '';
      machines[0] = { ...LOCAL, name: label || LOCAL.name, env: machineEnvironment(env) };
      continue;
    }
    if (typeof name !== 'string' || !name.trim() || typeof host !== 'string' || host.startsWith('-') || !/^[\w.@:+-]+$/.test(host)) {
      console.error('Unusable machine in init.ts, expected { name, host }:', entry);
      continue;
    }
    if (machines.some((machine) => machine.id === host)) continue;
    machines.push({ id: host, name: name.trim(), host, env: machineEnvironment(env) });
  }
  return machines;
}

/** What a provider reports in the `git` of a `workspace-git` payload, as the `@lengmoxxl/sdk` README describes it. */
type WorkspaceGit = { branch: string; ahead: number; behind: number; dirty: boolean };

/** What `git status --porcelain=v2 --branch` printed in a repository. */
function parseGitStatus(stdout: Uint8Array): WorkspaceGit {
  const lines = Buffer.from(stdout).toString().split('\n');
  const head = lines.find((line) => line.startsWith('# branch.head '));
  const counts = lines.find((line) => line.startsWith('# branch.ab '))?.split(/\s+/).slice(2) ?? [];
  return {
    branch: head?.slice('# branch.head '.length).trim() ?? '',
    ahead: Number(counts[0]?.slice(1)) || 0,
    behind: Number(counts[1]?.slice(1)) || 0,
    dirty: lines.some((line) => line !== '' && !line.startsWith('#')),
  };
}

export async function activate(context: MainContext) {
  const path = join(context.host.dataDirectory, 'config.json');
  const settings: { machines: unknown[]; images: { maxCount: number }; codex: CodexSettings } = context.host.config;
  const machines = machineList(settings.machines);
  let workspaces: Workspace[] = [];
  let active: string | undefined;
  const connections = new Map<string, MachineConnection>();
  const pending = new Map<string, { controller: AbortController; result: Promise<MachineState> }>();
  const states = new Map<string, MachineState>();
  const failures = new Map<string, string>();
  const handlers: (() => void)[] = [];
  // What each workspace's terminal last showed. A workspace with no entry has said nothing yet.
  const agentStates = new Map<string, WorkspaceStatus>();
  // What the sidebar was told about each workspace, by topic: a value goes out only when it changes, and a value that
  // cannot be worked out is not sent at all — the row keeps what it last said until it is told again.
  const reported = new Map<string, string>();
  const toldKey = (topic: string, id: string) => `${topic} ${id}`;
  function report(topic: string, id: string, payload: Record<string, unknown>) {
    const key = toldKey(topic, id);
    const shape = JSON.stringify(payload);
    if (reported.get(key) === shape) return;
    reported.set(key, shape);
    void context.global.publish(topic, { id, ...payload });
  }
  function forget(topic: string, id: string) {
    reported.delete(toldKey(topic, id));
  }
  // Completions the person has already looked at, by workspace.
  const acknowledged = new Set<string>();
  function drawnStatus(id: string) {
    const status = agentStates.get(id) ?? 'idle';
    if (status !== 'finished') return status;
    // The front is being watched, so its completion has been looked at.
    if (id === active) acknowledged.add(id);
    return acknowledged.has(id) ? 'idle' : status;
  }
  function reportStatus(id: string) {
    report('workspace-status', id, { status: drawnStatus(id) });
  }
  function setStatus(id: string, status: WorkspaceStatus) {
    // Only work in the background can raise a check again.
    if (status === 'working' && id !== active) acknowledged.delete(id);
    agentStates.set(id, status);
    reportStatus(id);
  }
  // Two seconds without a report is a terminal that stopped: agent TUIs repaint while they work.
  const QUIET = 2000;
  // One second: reports further apart than that start a new burst, and only a burst that lasts that long is work.
  const SUSTAINED = 1000;
  const bursts = new Map<string, { start: number; last: number }>();
  const quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function sawOutput(sessionId: string) {
    const workspace = workspaces.find((item) => item.sessionId === sessionId);
    if (!workspace) return;
    const now = Date.now();
    const burst = bursts.get(workspace.id);
    const continued = burst !== undefined && now - burst.last <= SUSTAINED;
    const start = continued ? burst.start : now;
    bursts.set(workspace.id, { start, last: now });
    if (now - start >= SUSTAINED) setStatus(workspace.id, 'working');
    clearTimeout(quietTimers.get(workspace.id));
    quietTimers.set(workspace.id, setTimeout(() => {
      quietTimers.delete(workspace.id);
      if (agentStates.get(workspace.id) === 'working') setStatus(workspace.id, 'finished');
    }, QUIET));
  }

  // The app-server and ssh forward a machine's codex uses, as the daemon holds them: enough to attach again after a restart.
  const codexStored: Record<string, { processId: string; port: number; forwardId?: string; localPort?: number }> = {};
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { workspaces: Workspace[]; codexServers?: Record<string, { processId: string; port: number; forwardId?: string; localPort?: number }> };
    const kept: Workspace[] = [];
    // A workspace on a machine init.ts no longer names has nowhere to run, so it is dropped.
    for (const workspace of stored.workspaces) {
      if (typeof workspace?.id !== 'string' || !machines.some((machine) => machine.id === workspace.machineId) || kept.some((item) => item.id === workspace.id)) continue;
      kept.push(workspace);
    }
    workspaces = kept;
    for (const [id, server] of Object.entries(stored.codexServers ?? {})) {
      if (machines.some((machine) => machine.id === id) && typeof server?.processId === 'string' && typeof server?.port === 'number') codexStored[id] = server;
    }
  }

  function save() {
    writeFileSync(`${path}.tmp`, JSON.stringify({ workspaces, ...(Object.keys(codexStored).length ? { codexServers: codexStored } : {}) }, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  function disconnect(id: string) {
    pending.get(id)?.controller.abort();
    pending.delete(id);
    connections.get(id)?.disconnect();
    connections.delete(id);
  }

  async function open(id: string): Promise<MachineState> {
    const connected = connections.get(id);
    if (connected) return { ...connected.state, machineId: id };
    const opening = pending.get(id);
    if (opening) return opening.result;
    const machine = machines.find((machine) => machine.id === id);
    if (!machine) throw new Error('Unknown machine');
    const state: MachineState = { machineId: id, status: 'connecting', sessions: states.get(id)?.sessions ?? [], generation: 0 };
    states.set(id, state);
    context.ui.publish('state', state);
    const controller = new AbortController();
    const result = (async () => {
      try {
        const node = await context.connect(machine, controller.signal);
        if (controller.signal.aborted) { node.disconnect(); throw new Error('Connection cancelled'); }
        connections.set(id, node);
        node.onState((value) => {
          const state = { ...value, machineId: id };
          states.set(id, state);
          context.ui.publish('state', state);
          void announce();
        });
        return { ...node.state, machineId: id };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const failed: MachineState = { ...state, status: 'disconnected', error: String(error) };
        states.set(id, failed);
        context.ui.publish('state', failed);
        throw error;
      } finally {
        if (pending.get(id)?.controller === controller) pending.delete(id);
      }
    })();
    pending.set(id, { controller, result });
    return result;
  }

  /** What the sidebar calls a workspace: the name it was given, or where it sits in the list. */
  function nameOf(workspace: Workspace) {
    return workspace.name ?? `工作区 ${workspaces.indexOf(workspace) + 1}`;
  }

  // Codex mode: the TUI runs locally, a remote `codex app-server` does the work.
  type CodexServer = { processId: string; port: number; localPort: number; forwardId: string; forwardExited: boolean };
  const codexLive = new Map<string, CodexServer>();
  const codexStarting = new Map<string, Promise<CodexServer>>();

  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
  }

  /** Any HTTP answer on the forwarded port means the app-server is listening on the far side. */
  function codexUp(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(true); });
      req.once('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  /** One app-server per machine, shared by its codex workspaces; the daemon holds it and the ssh forward, so both survive a restart. */
  function codexServer(machine: Machine, node: MachineConnection): Promise<CodexServer> {
    const live = codexLive.get(machine.id);
    if (live && !live.forwardExited) return Promise.resolve(live);
    const starting = codexStarting.get(machine.id);
    if (starting) return starting;
    const result = (async () => {
      const local = connections.get('local')!;
      let stderr = '';
      const note = (chunk: Uint8Array) => { stderr = (stderr + Buffer.from(chunk).toString()).slice(-2000); };
      let processId = codexStored[machine.id]?.processId;
      let port = codexStored[machine.id]?.port ?? settings.codex.port;
      let proc = processId === undefined ? undefined : await node.subprocess.attach(processId).catch(() => undefined);
      const spawned = proc === undefined;
      if (!proc) {
        port = settings.codex.port;
        processId = (await node.subprocess.spawn(settings.codex.remoteCommand, ['app-server', '--listen', `ws://127.0.0.1:${port}`], { cwd: '/', env: machine.env })).id;
        proc = await node.subprocess.attach(processId);
      }
      let exited = false;
      proc.onData((event) => { if (event.stream === 'stderr') note(event.data); });
      proc.onExit(() => {
        exited = true;
        const server = codexLive.get(machine.id);
        if (server?.processId === processId) { connections.get('local')?.subprocess.close(server.forwardId).catch(() => {}); codexLive.delete(machine.id); }
        if (codexStored[machine.id]?.processId === processId) { delete codexStored[machine.id]; save(); }
      });
      let forwardId = codexStored[machine.id]?.forwardId;
      let forward = forwardId === undefined ? undefined : await local.subprocess.attach(forwardId).catch(() => undefined);
      let localPort: number;
      if (!forward) {
        localPort = await freePort();
        forwardId = (await local.subprocess.spawn('ssh', [
          '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
          '-L', `127.0.0.1:${localPort}:127.0.0.1:${port}`, machine.host!,
        ], { cwd: '/' })).id;
        forward = await local.subprocess.attach(forwardId);
      } else {
        localPort = codexStored[machine.id]!.localPort!;
      }
      const server: CodexServer = { processId: processId!, port, localPort, forwardId: forwardId!, forwardExited: false };
      forward.onData((event) => { if (event.stream === 'stderr') note(event.data); });
      forward.onExit(() => { server.forwardExited = true; if (codexLive.get(machine.id) === server) codexLive.delete(machine.id); });
      try {
        const deadline = Date.now() + 30_000;
        while (!(await codexUp(localPort))) {
          if (exited || server.forwardExited || Date.now() > deadline) throw new Error(stderr.trim() || 'codex app-server 未就绪');
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      } catch (error) {
        await local.subprocess.close(forwardId!).catch(() => {});
        if (spawned) await node.subprocess.close(processId!).catch(() => {});
        throw error;
      }
      codexLive.set(machine.id, server);
      codexStored[machine.id] = { processId: processId!, port, forwardId: forwardId!, localPort };
      save();
      return server;
    })();
    codexStarting.set(machine.id, result);
    void result.catch(() => {}).finally(() => { if (codexStarting.get(machine.id) === result) codexStarting.delete(machine.id); });
    return result;
  }

  /** The last codex workspace on a machine takes its app-server and forward down with it. */
  function releaseCodex(machineId: string) {
    if (workspaces.some((workspace) => workspace.type === 'codex' && workspace.machineId === machineId)) return;
    codexLive.delete(machineId);
    const stored = codexStored[machineId];
    if (stored) {
      connections.get(machineId)?.subprocess.close(stored.processId).catch(() => {});
      if (stored.forwardId) connections.get('local')?.subprocess.close(stored.forwardId).catch(() => {});
      delete codexStored[machineId];
    }
  }

  async function ensureCodex(workspace: Workspace) {
    if (!workspace.cwd) return;
    const machine = machines.find((item) => item.id === workspace.machineId)!;
    await open(machine.id);
    await open('local');
    const node = connections.get('local')!;
    const live = codexLive.get(machine.id);
    const session = workspace.sessionId === undefined ? undefined : (await node.pty.list()).find((item) => item.id === workspace.sessionId);
    if (live && !live.forwardExited && session && session.exit_code === null) return;
    const prior = codexStored[machine.id];
    const server = await codexServer(machine, connections.get(machine.id)!);
    // The app-server, forward and TUI are daemon-held: if all survived the restart, rejoin rather than relaunch.
    if (session && session.exit_code === null && server.processId === prior?.processId && server.forwardId === prior?.forwardId) return;
    if (workspace.sessionId !== undefined) await node.pty.close(workspace.sessionId).catch(() => {});
    const created = await node.pty.create({ rows: 24, cols: 80 }, { label: `${nameOf(workspace)} - codex` });
    workspace.sessionId = created.id;
    const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
    const args = settings.codex.args.filter((arg): arg is string => typeof arg === 'string');
    const pty = await node.pty.attach(created.id);
    // exec replaces the shell, so the session exits when codex does.
    await pty.write(`exec ${settings.codex.command} --remote ${quote(`ws://127.0.0.1:${server.localPort}`)} --cd ${quote(workspace.cwd)}${args.map((arg) => ` ${quote(arg)}`).join(' ')}\n`);
    await pty.detach();
  }

  /** Answers a codex workspace's directory: validate it on the machine, name the row, start the terminal. The caller opens the machine and saves. */
  async function openCodex(workspace: Workspace, given: string) {
    const trimmed = given.trim();
    if (!trimmed) throw new Error('请输入远程目录');
    const node = connections.get(workspace.machineId)!;
    const home = await homeOf(workspace.machineId, node);
    const path = trimmed === '~' && home ? home : trimmed.startsWith('~/') && home ? posix.join(home, trimmed.slice(2)) : trimmed;
    if (!posix.isAbsolute(path)) throw new Error('请输入远程绝对路径');
    if (!(await node.fs.stat(path))?.isDirectory) throw new Error(`远程目录不存在: ${path}`);
    workspace.cwd = posix.resolve(path);
    if (!workspace.manual) workspace.name = posix.basename(workspace.cwd) || '/';
    await ensure(workspace);
  }

  /** A workspace needs a live terminal on a connected machine; a dead or missing one is replaced. */
  async function ensure(workspace: Workspace) {
    if (workspace.type === 'codex') return ensureCodex(workspace);
    const node = connections.get(workspace.machineId)!;
    const session = workspace.sessionId === undefined ? undefined : (await node.pty.list()).find((item) => item.id === workspace.sessionId);
    if (session && session.exit_code === null) return;
    if (workspace.sessionId !== undefined) await node.pty.close(workspace.sessionId).catch(() => {});
    // A cwd that is not a directory fails the create outright.
    const cwd = workspace.cwd && (await node.fs.stat(workspace.cwd))?.isDirectory ? workspace.cwd : undefined;
    workspace.sessionId = (await node.pty.create({ rows: 24, cols: 80 }, { cwd, label: `${nameOf(workspace)} - agent` })).id;
  }

  function sessionFor(workspace: Workspace) {
    return states.get(terminalMachineOf(workspace))?.sessions.find((item) => item.id === workspace.sessionId);
  }

  function rows(): WorkspaceRow[] {
    return workspaces.map((workspace) => {
      const session = sessionFor(workspace);
      return {
        id: workspace.id,
        label: nameOf(workspace),
        machine: machines.find((machine) => machine.id === workspace.machineId)!.name,
        running: session?.exit_code === null,
        status: drawnStatus(workspace.id),
      };
    });
  }

  // A workspace list and a terminal's report are two kinds of change: the rows themselves, and what one row's
  // terminal last showed. Only the first is worth every listener pulling the list again, so the second goes out
  // on a topic of its own. Status is left out of this comparison for the same reason.
  const shapeOf = (list: WorkspaceRow[]) => JSON.stringify(list.map(({ status, ...rest }) => rest));
  let announced = '';
  let announcedFront = '';
  // The window draws the list from this, and the tab views follow whichever workspace is in front.
  async function announce() {
    context.ui.publish('config', { workspaces, active });
    // The front decides what each row draws, so every row is worked out again here.
    for (const workspace of workspaces) reportStatus(workspace.id);
    const list = rows();
    const shape = shapeOf(list);
    if (shape !== announced) {
      announced = shape;
      await context.global.publish('workspaces', list);
    }
    const workspace = workspaces.find((item) => item.id === active);
    const machine = workspace && machines.find((machine) => machine.id === workspace.machineId);
    const session = workspace && sessionFor(workspace);
    const front: WorkspaceActive | null = machine && workspace && session?.exit_code === null
      ? { machine, sessionId: session.id, workspaceId: workspace.id, name: nameOf(workspace) }
      : null;
    const frontShape = JSON.stringify(front);
    if (frontShape !== announcedFront) {
      announcedFront = frontShape;
      await context.global.publish('workspace:active', front);
    }
  }

  function hostOf(sessionId: string) {
    const workspace = workspaces.find((workspace) => workspace.sessionId === sessionId);
    // A codex workspace's shell is local, so its paths resolve in the workspace's own cwd rather than the shell's.
    const machine = machines.find((machine) => machine.id === workspace?.machineId);
    const node = machine && connections.get(machine.id);
    if (!machine || !node) return undefined;
    return workspace?.type === 'codex' ? { machine, node, cwd: workspace.cwd } : { machine, node };
  }

  /** Runs one script on a machine, with the arguments it reads as `$1`, `$2`, and so on. */
  function shell(node: MachineConnection, script: string, ...args: string[]) {
    // `$0` only names the script to the shell, and `/` is a directory every machine has, so nothing here
    // depends on where the node itself was started.
    return node.subprocess.exec('/bin/sh', ['-c', script, 'wangcai-terminal-agent', ...args], { cwd: '/' });
  }

  const homes = new Map<string, Promise<string>>();
  function homeOf(machineId: string, node: MachineConnection) {
    let value = homes.get(machineId);
    if (!value) {
      value = shell(node, 'printf %s "$HOME"')
        .then((result) => result.code === 0 ? Buffer.from(result.stdout).toString().trim() : '')
        .catch(() => '');
      homes.set(machineId, value);
    }
    return value;
  }

  // Where a workspace's work sits now, and the connection that reaches it: a codex workspace keeps the directory it
  // was opened with on its remote machine, a shell workspace is wherever its shell is. Undefined when unreadable.
  async function located(workspace: Workspace): Promise<{ node: MachineConnection; cwd: string } | undefined> {
    const node = connections.get(workspace.machineId);
    if (!node) return undefined;
    if (workspace.type === 'codex') return workspace.cwd ? { node, cwd: workspace.cwd } : undefined;
    if (!workspace.sessionId) return undefined;
    const cwd = await node.pty.cwd(workspace.sessionId).catch(() => undefined);
    return cwd === undefined ? undefined : { node, cwd };
  }

  // Walks the workspaces whose terminal is up, each with the directory its shell is in now.
  async function* terminals() {
    for (const workspace of workspaces) {
      const at = await located(workspace);
      if (at) yield { workspace, node: at.node, cwd: at.cwd };
    }
  }

  // A pass that takes a while is not run on top of the one still going.
  function alone(pass: () => Promise<void>) {
    let running = false;
    return async () => {
      if (running) return;
      running = true;
      try {
        await pass();
      } finally {
        running = false;
      }
    };
  }

  // A row is named after the directory its shell is in, and a directory read is cheap enough to keep that a second behind at
  // most.
  const FOLLOW_REFRESH = 1000;
  // A commit made in a terminal, or a fetch made elsewhere, changes what the row should say.
  const GIT_REFRESH = 5000;
  const follow = alone(async () => {
    let changed = false;
    for await (const { workspace, node, cwd } of terminals()) {
      // The local shell of a codex workspace says nothing about where its work happens.
      if (workspace.type === 'codex') continue;
      // A replacement terminal opens where this shell is.
      if (cwd !== workspace.cwd) {
        workspace.cwd = cwd;
        changed = true;
      }
      // A name given by hand stays what it is, wherever the shell goes.
      if (workspace.manual) continue;
      const home = await homeOf(workspace.machineId, node);
      const name = cwd === home ? '~' : posix.basename(cwd) || '/';
      if (name !== workspace.name) {
        workspace.name = name;
        changed = true;
      }
    }
    if (changed) {
      save();
      await announce();
    }
  });
  const readGit = alone(async () => {
    for await (const { workspace, node, cwd } of terminals()) {
      try {
        const env = { GIT_OPTIONAL_LOCKS: '0' };
        const run = (...args: string[]) => node.subprocess.exec('git', args, { cwd, env });
        const status = await run('-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch');
        if (status.code === 0) report('workspace-git', workspace.id, { git: parseGitStatus(status.stdout) });
        // When `status` fails, only a directory git cannot work in is no repository; the exit code decides, because the
        // message git prints is translated.
        else if ((await run('rev-parse', '--is-inside-work-tree')).code !== 0) report('workspace-git', workspace.id, { git: null });
      } catch {
        // Nothing to say: the machine or the directory is gone.
      }
    }
  });
  const followTimer = setInterval(() => void follow(), FOLLOW_REFRESH);
  const gitTimer = setInterval(() => void readGit(), GIT_REFRESH);

  handlers.push(...registerFilePaths(context, hostOf));
  handlers.push(registerImages(context, hostOf, settings.images.maxCount));
  handlers.push(context.ui.handle('config', () => ({ workspaces, active })));
  handlers.push(context.ui.handle('workspaces', rows));
  handlers.push(context.ui.handle('states', () => [...states.values()]));
  handlers.push(context.ui.handle('activity', ({ sessionId }: { sessionId: string }) => sawOutput(sessionId)));
  handlers.push(context.ui.handle('cwd', async ({ workspaceId }: { workspaceId: string }) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error('Unknown workspace');
    const at = await located(workspace);
    if (at) return at.cwd;
    if (!workspace.cwd) throw new Error('Workspace has no directory yet');
    return workspace.cwd;
  }));
  handlers.push(context.ui.handle('workspace-menu', () => [
    ...machines.map((machine) => ({
      key: machine.id,
      label: machine.name,
      hint: machine.host,
      error: failures.get(machine.id),
    })),
    ...(settings.codex.enabled ? machines.filter((machine) => machine.host).map((machine) => ({
      key: `codex:${machine.id}`,
      label: `codex + ${machine.name}`,
      hint: machine.host,
      error: failures.get(machine.id),
    })) : []),
  ]));
  handlers.push(context.ui.handle('workspace-create', async ({ key, cwd, type }: { key: string; cwd?: string; type?: string }) => {
    // Menu entries carry the type in the key; a programmatic caller passes it beside a plain machine key.
    const codex = type === 'codex' || key.startsWith('codex:');
    const machineId = key.startsWith('codex:') ? key.slice('codex:'.length) : key;
    const machine = machines.find((item) => item.id === machineId);
    if (!machine) throw new Error('Unknown machine');
    if (codex && !machine.host) throw new Error('codex 工作区需要远程机器');
    // A codex workspace without a directory waits for the pane's prompt instead of connecting now.
    if (codex && !cwd) {
      const workspace: Workspace = { id: randomUUID(), machineId: machine.id, type: 'codex', name: `codex + ${machine.name}` };
      workspaces.push(workspace);
      active = workspace.id;
      save();
      await announce();
      return { id: workspace.id };
    }
    try {
      await open(machine.id);
      failures.delete(machine.id);
    } catch (error) {
      failures.set(machine.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    const workspace: Workspace = codex
      ? { id: randomUUID(), machineId: machine.id, type: 'codex', name: `codex + ${machine.name}` }
      : { id: randomUUID(), machineId: machine.id, cwd };
    workspaces.push(workspace);
    active = workspace.id;
    if (codex) await openCodex(workspace, cwd!);
    else await ensure(workspace);
    save();
    await announce();
    return { id: workspace.id };
  }));
  handlers.push(context.ui.handle('codex-open', async ({ id, cwd }: { id: string; cwd: string }) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace || workspace.type !== 'codex') throw new Error('Unknown workspace');
    await open(workspace.machineId);
    await openCodex(workspace, cwd);
    save();
    await announce();
  }));
  handlers.push(context.ui.handle('codex-directories', async ({ id, path }: { id: string; path: string }) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace || workspace.type !== 'codex' || !posix.isAbsolute(path)) return [];
    await open(workspace.machineId);
    const entries = await connections.get(workspace.machineId)!.fs.readDirectory(path).catch(() => []);
    return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  }));
  handlers.push(context.ui.handle('workspace-select', async ({ id }: { id: string }) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error('Unknown workspace');
    active = id;
    try {
      await open(workspace.machineId);
      failures.delete(workspace.machineId);
      await ensure(workspace);
      save();
    } catch (error) {
      failures.set(workspace.machineId, error instanceof Error ? error.message : String(error));
      await announce();
      throw error;
    }
    await announce();
  }));
  handlers.push(context.ui.handle('workspace-close', async ({ id }: { id: string }) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    const node = connections.get(terminalMachineOf(workspace));
    if (workspace.sessionId !== undefined) {
      await node?.pty.close(workspace.sessionId).catch(() => {});
    }
    workspaces = workspaces.filter((item) => item.id !== id);
    if (workspace.type === 'codex') releaseCodex(workspace.machineId);
    agentStates.delete(id);
    forget('workspace-status', id);
    forget('workspace-git', id);
    acknowledged.delete(id);
    clearTimeout(quietTimers.get(id));
    quietTimers.delete(id);
    bursts.delete(id);
    if (active === id) active = undefined;
    save();
    await announce();
  }));

  handlers.push(context.ui.handle('workspace-rename', async ({ id, name }: { id: string; name: string }) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    workspace.name = name.trim() || undefined;
    workspace.manual = workspace.name !== undefined;
    // Recompute at once, or the row falls back to its numbered name until the next tick.
    if (!workspace.manual) void follow();
    save();
    await announce();
  }));
  handlers.push(context.ui.handle('workspace-move', ({ id, before }: { id: string; before?: string }) => {
    if (id === before) return;
    const index = workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) return;
    const [workspace] = workspaces.splice(index, 1);
    const target = workspaces.findIndex((item) => item.id === before);
    workspaces.splice(target < 0 ? workspaces.length : target, 0, workspace);
    save();
    void announce();
  }));
  handlers.push(context.global.subscribe('workspace:query', () => {
    // A tab that opens later asks for what it missed: this answer goes out even when nothing moved since.
    announcedFront = '';
    void announce();
  }));
  handlers.push(context.ui.handle('address', ({ machineId }: { machineId: string }) => {
    const node = connections.get(machineId);
    if (!node) throw new Error('Machine is not connected');
    return `ws://localhost:${node.port}`;
  }));
  return () => {
    clearInterval(followTimer);
    clearInterval(gitTimer);
    for (const timer of quietTimers.values()) clearTimeout(timer);
    quietTimers.clear();
    for (const remove of handlers) remove();
    for (const id of new Set([...connections.keys(), ...pending.keys()])) disconnect(id);
    // The app-servers and forwards belong to the daemon and are attached again on the next run.
  };
}
