import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MachineConnection, WorkspaceActive, WorkspaceRow, WorkspaceStatus } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { registerFilePaths } from './file-links/paths';
import { registerImages } from './images';
import type { Machine, MachineState, Workspace } from './shared';

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
  // What each workspace's agent last said it was doing, and the directory on a machine it says it in.
  const agentStates = new Map<string, WorkspaceStatus>();
  const roots = new Map<string, string>();
  // The watch armed on each machine's report directory, and the machines whose integrations are in place.
  const watching = new Map<string, () => void>();
  const installed = new Set<string>();
  // A machine that goes away takes its watch with it; what is left has to be let go when the plugin stops.
  handlers.push(() => {
    for (const unwatch of watching.values()) unwatch();
    watching.clear();
  });

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
          if (value.status === 'connected') {
            void watchAgentStates(id, node);
            // A machine that cannot be set up still opens its terminals; its rows just say nothing.
            void installAgents(id, node).catch((error: Error) => console.error('Cannot install the agent integrations:', error));
          }
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

  /** A workspace needs a live terminal on a connected machine; a dead or missing one is replaced. */
  async function ensure(workspace: Workspace) {
    const node = connections.get(workspace.machineId)!;
    const session = workspace.sessionId === undefined ? undefined : (await node.pty.list()).find((item) => item.id === workspace.sessionId);
    if (session && session.exit_code === null) return;
    if (workspace.sessionId !== undefined) await node.pty.close(workspace.sessionId).catch(() => {});
    // A cwd that is not a directory fails the create outright.
    const cwd = workspace.cwd && (await node.fs.stat(workspace.cwd))?.isDirectory ? workspace.cwd : undefined;
    // What the agent in this workspace is asked to report into: the file it writes, which the app reads back.
    const root = await agentRoot(workspace.machineId, node);
    const home = await homeOf(workspace.machineId, node);
    if (home) await syncIntegrations(node, home);
    const env = root ? { WANGCAI_AGENT_STATE: posix.join(root, workspace.id) } : undefined;
    workspace.sessionId = (await node.pty.create({ rows: 24, cols: 80 }, { cwd, env })).id;
  }

  function sessionFor(workspace: Workspace) {
    return states.get(workspace.machineId)?.sessions.find((item) => item.id === workspace.sessionId);
  }

  function rows(): WorkspaceRow[] {
    return workspaces.map((workspace, index) => {
      const session = sessionFor(workspace);
      return {
        id: workspace.id,
        label: workspace.name ?? `工作区 ${index + 1}`,
        machine: machines.find((machine) => machine.id === workspace.machineId)!.name,
        running: session?.exit_code === null,
        status: agentStates.get(workspace.id) ?? 'idle',
      };
    });
  }

  let announced = '';
  // The window draws the list from this, and the tab views follow whichever workspace is in front.
  async function announce() {
    context.ui.publish('config', { workspaces, active });
    const list = rows();
    // A listener acts on a change; republishing a list it already has only sends it round again.
    const current = JSON.stringify(list);
    if (current !== announced) {
      announced = current;
      await context.global.publish('workspaces', list);
    }
    const workspace = workspaces.find((item) => item.id === active);
    const machine = workspace && machines.find((machine) => machine.id === workspace.machineId);
    const session = workspace && sessionFor(workspace);
    // A tab view that opens later asks for this again, so it is answered every time it is asked.
    const front: WorkspaceActive | null = machine && workspace && session?.exit_code === null ? { machine, sessionId: session.id, workspaceId: workspace.id } : null;
    await context.global.publish('workspace:active', front);
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
    // The report its agent left on the machine goes with the workspace that made it.
    const root = roots.get(workspace.machineId);
    if (node && root) await shell(node, 'rm -f "$1"', posix.join(root, id)).catch(() => undefined);
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
  handlers.push(context.global.subscribe('workspace:query', () => { void announce(); }));
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

  // The directory an agent reports into on a machine, made once and kept: a workspace hands its shell the file
  // inside it that belongs to that workspace.
  async function agentRoot(machineId: string, node: MachineConnection) {
    const known = roots.get(machineId);
    if (known) return known;
    const home = await homeOf(machineId, node);
    if (!home) return undefined;
    const root = posix.join(home, '.local/share/wangcai/agent-state');
    // A watch on a path that is not there yet reports nothing, so the directory is made before it is armed.
    const made = await shell(node, 'mkdir -p "$1"', root).catch(() => undefined);
    if (made?.code !== 0) return undefined;
    roots.set(machineId, root);
    return root;
  }

  /** Arms a machine's report directory: what the files there hold is what its rows show, now and after every
   *  write the watch reports. A machine that comes back is armed and read again, since its watch died with it. */
  async function watchAgentStates(machineId: string, node: MachineConnection) {
    watching.get(machineId)?.();
    watching.delete(machineId);
    const root = await agentRoot(machineId, node);
    if (!root) return;
    const update = async (path: string) => {
      const workspace = workspaces.find((item) => item.machineId === machineId && item.id === posix.basename(path));
      if (!workspace) return;
      const written = await node.fs.readFile(path).then((data) => Buffer.from(data).toString().trim()).catch(() => '');
      const status: WorkspaceStatus = written === 'working' || written === 'finished' ? written : 'idle';
      if (status === (agentStates.get(workspace.id) ?? 'idle')) return;
      agentStates.set(workspace.id, status);
      await announce();
    };
    const unwatch = await node.fs.watch(root, { recursive: true }, (changes) => {
      for (const path of [...changes.created, ...changes.modified, ...changes.removed]) void update(path);
    }).catch(() => undefined);
    if (!unwatch) return;
    watching.set(machineId, unwatch);
    // A machine that kept reporting while the app was away: what it wrote is where its rows start.
    for (const entry of await node.fs.readDirectory(root).catch(() => [])) void update(posix.join(root, entry.name));
  }

  /** What a file on a machine holds, and nothing at all when that machine has no such file. */
  async function readFile(node: MachineConnection, path: string) {
    if (!(await node.fs.stat(path).catch(() => null))) return undefined;
    return node.fs.readFile(path).then((data) => Buffer.from(data).toString());
  }

  /** Writes a file on a machine when it is not already what it should be. The SDK has no write of its own, so
   *  the bytes go over as base64 through the machine's shell, and land under the name they are meant to have. */
  async function putFile(node: MachineConnection, path: string, content: string) {
    if (await readFile(node, path) === content) return;
    // The name the bytes land under is the shell's own, so two writes of one file do not take each other's.
    const script = `set -eu
mkdir -p "$1"
printf %s "$3" | base64 -d > "$1/$2.$$.tmp"
mv "$1/$2.$$.tmp" "$1/$2"`;
    const result = await shell(node, script, posix.dirname(path), posix.basename(path), Buffer.from(content).toString('base64'));
    if (result.code !== 0) throw new Error(Buffer.from(result.stderr).toString().trim() || `Cannot write ${path}`);
  }

  /** The path codex files this machine's hooks under, which a home behind a symlink does not show. */
  async function realDirectory(node: MachineConnection, path: string) {
    const result = await shell(node, 'cd "$1" && pwd -P', path).catch(() => undefined);
    return result?.code === 0 ? Buffer.from(result.stdout).toString().trim() || path : path;
  }

  /** The trust codex records for one hook when it is approved by hand: its event, its timeout and its command,
   *  hashed the way codex hashes them, with the keys in the order codex sorts them. A hook it holds no trust
   *  for does not run. */
  function hookHash(label: string, command: string, timeout: number) {
    const identity = { event_name: label, hooks: [{ async: false, command, timeout, type: 'command' }] };
    return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  }

  /** Adds those trust records to codex's config file, and leaves every other line of it where it was. */
  function withHookState(config: string, records: { key: string; hash: string }[]) {
    const lines = config ? config.split('\n') : [];
    for (const { key, hash } of records) {
      const header = `[hooks.state."${key}"]`;
      // What the file does not have yet goes at its end; a table it has is rewritten where it stands.
      const tableStart = lines.indexOf(header);
      if (tableStart === -1) {
        lines.push(header, `trusted_hash = "${hash}"`, '');
        continue;
      }
      const nextTable = lines.findIndex((line, index) => index > tableStart && line.startsWith('['));
      const tableEnd = nextTable === -1 ? lines.length : nextTable;
      lines.splice(tableStart + 1, tableEnd - tableStart - 1, `trusted_hash = "${hash}"`, '');
    }
    return `${lines.join('\n').replace(/\n+$/, '')}\n`;
  }

  /** What codex needs on a machine besides its hook: the entries in hooks.json that run it, and the trust to run
   *  those. */
  async function installCodexHooks(home: string, node: MachineConnection) {
    const directory = posix.join(home, '.codex');
    const scriptFile = posix.join(directory, 'wangcai-agent-state.sh');
    const hooksFile = posix.join(directory, 'hooks.json');
    const stored = await readFile(node, hooksFile);
    let settings: Record<string, unknown> = {};
    if (stored !== undefined) {
      try {
        settings = JSON.parse(stored) as Record<string, unknown>;
      } catch {
        // Another tool's file in a shape this cannot merge into: leaving it alone beats replacing it.
        throw new Error(`Cannot read ${hooksFile}`);
      }
    }
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    // The three events codex runs this for, the action each passes the hook, and the label codex files trust under.
    const reports = [
      { event: 'SessionStart', label: 'session_start', action: 'clear' },
      { event: 'UserPromptSubmit', label: 'user_prompt_submit', action: 'working' },
      { event: 'Stop', label: 'stop', action: 'finished' },
    ];
    const timeout = 10;
    // Trust is filed under the path codex resolved, which a home behind a symlink spells differently.
    const resolved = await realDirectory(node, directory);
    const records: { key: string; hash: string }[] = [];
    for (const { event, label, action } of reports) {
      // The entries this plugin wrote before are replaced, and what another tool put there is kept.
      const kept = (hooks[event] ?? []).filter((group) => !JSON.stringify(group).includes(scriptFile));
      const command = `/bin/sh '${scriptFile}' ${action}`;
      hooks[event] = [...kept, { hooks: [{ type: 'command', command, timeout }] }];
      // Trust belongs to the hook's own place in that file: which file it came from, the event, its row.
      records.push({ key: `${resolved}/hooks.json:${label}:${kept.length}:0`, hash: hookHash(label, command, timeout) });
    }
    settings.hooks = hooks;
    await putFile(node, hooksFile, `${JSON.stringify(settings, null, 2)}\n`);
    const configFile = posix.join(directory, 'config.toml');
    await putFile(node, configFile, withHookState((await readFile(node, configFile)) ?? '', records));
  }

  /** Whether a machine has the tool a file of ours belongs to: one without it is left alone. */
  async function hasTool(node: MachineConnection, home: string, name: string) {
    return (await node.fs.stat(posix.join(home, name)).catch(() => null))?.isDirectory === true;
  }

  /** The files the agents on a machine load, brought to what this plugin ships: a machine that lost one, or kept
   *  one from an older plugin, gets it back before the next session reads it. */
  async function syncIntegrations(node: MachineConnection, home: string) {
    if (await hasTool(node, home, '.pi')) {
      await putFile(node, posix.join(home, '.pi/agent/extensions/wangcai-agent-state.ts'), readFileSync(join(__dirname, 'integrations/pi-agent-state.ts'), 'utf8'));
    }
    if (await hasTool(node, home, '.codex')) {
      await putFile(node, posix.join(home, '.codex/wangcai-agent-state.sh'), readFileSync(join(__dirname, 'integrations/codex-agent-state.sh'), 'utf8'));
    }
  }

  /** What the agents on a machine need to report: their files, and for codex the entries and trust that run one. */
  async function installAgents(machineId: string, node: MachineConnection) {
    if (installed.has(machineId)) return;
    const home = await homeOf(machineId, node);
    if (!home) return;
    await syncIntegrations(node, home);
    if (await hasTool(node, home, '.codex')) await installCodexHooks(home, node);
    installed.add(machineId);
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
    for (const remove of handlers) remove();
    for (const id of new Set([...connections.keys(), ...pending.keys()])) disconnect(id);
  };
}
