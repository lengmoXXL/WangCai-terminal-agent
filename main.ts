import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MachineConnection, WorkspaceActive, WorkspaceRow, WorkspaceStatus } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { registerFilePaths } from './file-links/paths';
import { registerImages } from './images';
import type { Machine, MachineState, Workspace } from './shared';

export const keys = { '<leader>aa': { global: true, desc: '切到工作区终端', event: 'core:show-view', data: { plugin: 'terminal-agent' } } };

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 13 },
    lineHeight: { type: 'number', default: 1 },
  },
  machines: { type: 'array', default: [] },
  images: { maxCount: { type: 'number', default: 100 } },
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

export async function activate(context: MainContext) {
  const path = join(context.host.dataDirectory, 'config.json');
  const settings: { machines: unknown[]; images: { maxCount: number } } = context.host.config;
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
  // What the sidebar was told a workspace draws.
  const reported = new Map<string, WorkspaceStatus>();
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
    const status = drawnStatus(id);
    if (reported.get(id) === status) return;
    reported.set(id, status);
    void context.global.publish('workspace-status', { id, status });
  }
  function setStatus(id: string, status: WorkspaceStatus) {
    // Only work in the background can raise a check again.
    if (status === 'working' && id !== active) acknowledged.delete(id);
    agentStates.set(id, status);
    reportStatus(id);
  }
  // Two seconds without a report is a terminal that stopped: agent TUIs repaint while they work.
  const QUIET = 2000;
  const quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function sawOutput(sessionId: string) {
    const workspace = workspaces.find((item) => item.sessionId === sessionId);
    if (!workspace) return;
    clearTimeout(quietTimers.get(workspace.id));
    quietTimers.set(workspace.id, setTimeout(() => {
      quietTimers.delete(workspace.id);
      setStatus(workspace.id, 'finished');
    }, QUIET));
    setStatus(workspace.id, 'working');
  }

  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { workspaces: Workspace[] };
    const kept: Workspace[] = [];
    // A workspace on a machine init.ts no longer names has nowhere to run, so it is dropped.
    for (const workspace of stored.workspaces) {
      if (typeof workspace?.id !== 'string' || !machines.some((machine) => machine.id === workspace.machineId) || kept.some((item) => item.id === workspace.id)) continue;
      kept.push(workspace);
    }
    workspaces = kept;
  }

  function save() {
    writeFileSync(`${path}.tmp`, JSON.stringify({ workspaces }, null, 2));
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

  /** A workspace needs a live terminal on a connected machine; a dead or missing one is replaced. */
  async function ensure(workspace: Workspace) {
    const node = connections.get(workspace.machineId)!;
    const session = workspace.sessionId === undefined ? undefined : (await node.pty.list()).find((item) => item.id === workspace.sessionId);
    if (session && session.exit_code === null) return;
    if (workspace.sessionId !== undefined) await node.pty.close(workspace.sessionId).catch(() => {});
    // A cwd that is not a directory fails the create outright.
    const cwd = workspace.cwd && (await node.fs.stat(workspace.cwd))?.isDirectory ? workspace.cwd : undefined;
    workspace.sessionId = (await node.pty.create({ rows: 24, cols: 80 }, { cwd, label: `${nameOf(workspace)} - agent` })).id;
  }

  function sessionFor(workspace: Workspace) {
    return states.get(workspace.machineId)?.sessions.find((item) => item.id === workspace.sessionId);
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
    const machine = machines.find((machine) => machine.id === workspace?.machineId);
    const node = machine && connections.get(machine.id);
    return machine && node ? { machine, node } : undefined;
  }

  handlers.push(...registerFilePaths(context, hostOf));
  handlers.push(registerImages(context, hostOf, settings.images.maxCount));
  handlers.push(context.ui.handle('config', () => ({ workspaces, active })));
  handlers.push(context.ui.handle('workspaces', rows));
  handlers.push(context.ui.handle('states', () => [...states.values()]));
  handlers.push(context.ui.handle('activity', ({ sessionId }: { sessionId: string }) => sawOutput(sessionId)));
  handlers.push(context.ui.handle('workspace-menu', () => machines.map((machine) => ({
    key: machine.id,
    label: machine.name,
    hint: machine.host,
    error: failures.get(machine.id),
  }))));
  handlers.push(context.ui.handle('workspace-create', async ({ key }: { key: string }) => {
    const machine = machines.find((machine) => machine.id === key);
    if (!machine) throw new Error('Unknown machine');
    try {
      await open(machine.id);
      failures.delete(machine.id);
    } catch (error) {
      failures.set(machine.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    const workspace: Workspace = { id: randomUUID(), machineId: machine.id };
    workspaces.push(workspace);
    active = workspace.id;
    await ensure(workspace);
    save();
    await announce();
    return { id: workspace.id };
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
    const node = connections.get(workspace.machineId);
    if (workspace.sessionId !== undefined) {
      await node?.pty.close(workspace.sessionId).catch(() => {});
    }
    workspaces = workspaces.filter((item) => item.id !== id);
    agentStates.delete(id);
    reported.delete(id);
    acknowledged.delete(id);
    clearTimeout(quietTimers.get(id));
    quietTimers.delete(id);
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

  let following = false;
  async function follow() {
    if (following) return;
    following = true;
    try {
      let changed = false;
      for (const workspace of workspaces) {
        const node = connections.get(workspace.machineId);
        if (!node || !workspace.sessionId) continue;
        let cwd: string;
        try { cwd = await node.pty.cwd(workspace.sessionId); } catch { continue; }
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
    } finally {
      following = false;
    }
  }
  const follower = setInterval(() => void follow(), 1000);
  return () => {
    clearInterval(follower);
    for (const timer of quietTimers.values()) clearTimeout(timer);
    quietTimers.clear();
    for (const remove of handlers) remove();
    for (const id of new Set([...connections.keys(), ...pending.keys()])) disconnect(id);
  };
}
