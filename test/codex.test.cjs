const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createConnection } = require('node:net');
const { join } = require('node:path');
const { openMachine } = require('@lengmoxxl/sdk');
const { until, wangcaiApp, withHome, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { activate } = require('../main.cjs');
const { lists, openWorkspaceMenu, pluginDirectory, storedWorkspace, tabs } = require('./terminal-agent-ui.cjs');

test('a codex workspace asks for its remote directory before it starts', { timeout: 180000 }, () => withHome('wangcai-codex', {}, async ({ home, open }) => {
  const init = join(home, '.config/wangcai/init.ts');
  writeFileSync(init, `
    export default {
      workspaces: [
        { id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { codex: { enabled: true }, machines: [{ name: '测试服务器', host: 'wangcai-test.invalid' }] } },
      ],
      tabs: [],
    };
  `);
  const { page, close } = await open();
  await openWorkspaceMenu(page);
  const menu = page.locator('#workspace-row-menu');
  await menu.getByRole('menuitem', { name: '新建 codex + 测试服务器' }).click();
  const prompt = page.locator('.codex-prompt');
  await prompt.waitFor();
  assert.equal(await prompt.locator('input').inputValue(), '~/');
  // The workspace is kept as a codex one on the remote machine, with no terminal yet.
  await until(() => storedWorkspace(home).type === 'codex');
  assert.equal(storedWorkspace(home).machineId, 'wangcai-test.invalid');
  assert.equal(storedWorkspace(home).sessionId, undefined);
  await tabs(page).filter({ hasText: 'codex + 测试服务器' }).waitFor();
  // The machine cannot be reached, so the answer is refused in place and the directory stays unanswered.
  await prompt.locator('input').fill('~/project');
  await page.keyboard.press('Enter');
  await prompt.locator('.codex-prompt-error').waitFor();
  assert.equal(storedWorkspace(home).cwd, undefined);
  await close();
}));

test('a local codex workspace completes directories from the local home', { timeout: 180000 }, () => withHome('wangcai-codex-local', {}, async ({ home, open }) => {
  mkdirSync(join(home, 'project', 'sub'), { recursive: true });
  const init = join(home, '.config/wangcai/init.ts');
  writeFileSync(init, `
    export default {
      workspaces: [
        { id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { codex: { enabled: true } } },
      ],
      tabs: [],
    };
  `);
  const { page, close } = await open();
  await openWorkspaceMenu(page);
  const menu = page.locator('#workspace-row-menu');
  await menu.getByRole('menuitem', { name: '新建 codex + 本机' }).click();
  const prompt = page.locator('.codex-prompt');
  await prompt.waitFor();
  assert.equal(await prompt.locator('input').inputValue(), '~/');
  // Tab completes the single directory under home that matches the typed prefix.
  await prompt.locator('input').fill('~/pro');
  await prompt.locator('.codex-prompt-list button', { hasText: 'project/' }).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await prompt.locator('input').inputValue(), '~/project/');
  // A relative path is read against home as well.
  await prompt.locator('input').fill('project/');
  await prompt.locator('.codex-prompt-list button', { hasText: 'sub/' }).waitFor();
  await close();
}));

test('a codex workspace opens its directory through a custom codex command', { timeout: 180000 }, () => withHome('wangcai-codex-custom', {}, async ({ home, open }) => {
  mkdirSync(join(home, 'project'), { recursive: true });
  // A stand-in for codex: the daemon call answers with a socket, the TUI call just stays up.
  const mock = join(home, 'fake-codex');
  writeFileSync(mock, '#!/bin/bash\nif [ "$1" = "app-server" ]; then printf \'{"socketPath":"/tmp/wangcai-fake-codex.sock"}\'; else sleep 30; fi\n');
  chmodSync(mock, 0o755);
  const init = join(home, '.config/wangcai/init.ts');
  writeFileSync(init, `
    export default {
      workspaces: [
        { id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { codex: { enabled: true, command: ${JSON.stringify(mock)}, remoteCommand: ${JSON.stringify(mock)} } } },
      ],
      tabs: [],
    };
  `);
  const { page, close } = await open();
  await openWorkspaceMenu(page);
  const menu = page.locator('#workspace-row-menu');
  await menu.getByRole('menuitem', { name: '新建 codex + 本机' }).click();
  const prompt = page.locator('.codex-prompt');
  await prompt.waitFor();
  await prompt.locator('input').fill('~/project');
  await page.keyboard.press('Enter');
  await until(() => storedWorkspace(home).cwd === join(home, 'project'));
  await close();
}));

test('without codex enabled the menu offers no codex entries', { timeout: 180000 }, () => withWindow('wangcai-codex-off', lists, async ({ page }) => {
  await openWorkspaceMenu(page);
  const menu = page.locator('#workspace-row-menu');
  await menu.getByRole('menuitem', { name: '新建 本机' }).waitFor();
  assert.equal(await menu.getByRole('menuitem').filter({ hasText: 'codex' }).count(), 0);
}));

test('the local node keeps the shared Codex forward across desktop exits', { timeout: 180000 }, () => withHome('wc-fwd', {}, async ({ home, env }) => {
  const dataDirectory = join(home, 'd s');
  const bin = join(home, 'bin');
  mkdirSync(dataDirectory);
  mkdirSync(bin);
  writeFileSync(join(bin, 'ssh'), [
    `#!${process.execPath}`,
    "const { createServer } = require('node:net');",
    "const [socket, target] = process.argv[process.argv.indexOf('-L') + 1].split(':');",
    "createServer((client) => {",
    "  client.on('error', () => {});",
    "  client.once('data', () => client.end(`${process.pid} ${target}`));",
    "}).listen(socket);",
  ].join('\n'), { mode: 0o755 });
  const command = join(bin, 'codex');
  writeFileSync(command, '#!/bin/bash\nexec sleep 180\n', { mode: 0o755 });
  const shell = join(bin, 'shell');
  writeFileSync(shell, '#!/bin/bash\nexport PATH="$HOME/bin:$PATH"\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
  const connectLocal = () => openMachine({
    type: 'local', binary: join(wangcaiApp(), 'wangcaicli/dist/debug/wangcai'),
    env: { ...env, SHELL: shell, PATH: `${bin}:${env.PATH}` },
  });
  const state = { status: 'connected', sessions: [], generation: 1 };
  let remoteSocket = '/tmp/remote-codex.sock';
  const remote = {
    state, onState: (update) => update(state), disconnect() {},
    fs: { stat: async () => ({ isDirectory: true }) },
    subprocess: {
      exec: async (program) => ({
        code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(program === 'codex'
          ? JSON.stringify({ socketPath: remoteSocket }) : '/workspace'),
      }),
    },
  };
  const start = async (machines = [{ name: 'VM', host: 'fixture' }], connect = connectLocal) => {
    const handlers = new Map();
    const stop = await activate({
      host: { dataDirectory, config: {
        machines,
        codex: { enabled: true, command, remoteCommand: 'codex', args: [] },
        images: { maxCount: 1 },
      } },
      connect: async (machine) => machine.host ? remote : connect(),
      ui: { handle: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); }, publish() {} },
      global: { subscribe: () => () => {}, publish: async () => {} },
    });
    return { stop, request: (name, params) => handlers.get(name)(params) };
  };
  const inspect = await connectLocal();
  let plugin = await start();
  try {
    const create = (cwd) => plugin.request('workspace-create', { key: 'codex:fixture', cwd });
    const first = await create('/workspace/first');
    const saved = () => JSON.parse(readFileSync(join(dataDirectory, 'config.json'), 'utf8'));
    const forward = saved().codexServers.fixture;
    const sessionId = saved().workspaces[0].sessionId;
    const probe = () => new Promise((resolve, reject) => {
      const socket = createConnection(forward.localSocket);
      socket.setTimeout(2000, () => socket.destroy(new Error('Forward probe timed out')));
      socket.once('connect', () => socket.write('?'));
      let reply = '';
      socket.setEncoding('utf8');
      socket.on('data', (data) => { reply += data; });
      socket.once('end', () => resolve(reply));
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('Forward closed before replying')));
    });
    const reply = await probe();
    const [pid, target] = reply.split(' ');
    assert.equal((await inspect.pty.list()).find((session) => session.id === forward.forwardId)?.pid, Number(pid));
    assert.equal(target, remoteSocket);

    plugin.stop();
    assert.equal(await probe(), reply);
    plugin = await start();
    await plugin.request('workspace-select', first);
    assert.equal(saved().workspaces[0].sessionId, sessionId);
    assert.deepEqual(saved().codexServers.fixture, forward);
    const second = await create('/workspace/second');
    await plugin.request('workspace-close', first);
    assert.equal(await probe(), reply);

    const secondSession = saved().workspaces[0].sessionId;
    plugin.stop();
    remoteSocket = '/tmp/remote-codex-new.sock';
    plugin = await start();
    await plugin.request('workspace-select', second);
    const replaced = saved().codexServers.fixture;
    assert.notEqual(replaced.forwardId, forward.forwardId);
    assert.equal(replaced.localSocket, forward.localSocket);
    assert.equal((await probe()).split(' ')[1], remoteSocket);
    assert.equal(saved().workspaces[0].sessionId, secondSession);

    plugin.stop();
    plugin = await start();
    await plugin.request('workspace-close', second);
    assert.deepEqual(await inspect.pty.list(), []);
    await until(() => probe().then(() => false, () => true));
    assert.equal(saved().codexServers, undefined);

    await create('/workspace/removed');
    const unused = saved().codexServers.fixture;
    plugin.stop();
    let firstAttempt = true;
    plugin = await start([], () => {
      if (!firstAttempt) return connectLocal();
      firstAttempt = false;
      throw new Error('Local node temporarily unavailable');
    });
    const local = await plugin.request('workspace-create', { key: 'local' });
    await until(() => saved().codexServers === undefined);
    assert.ok(!(await inspect.pty.list()).some((session) => session.id === unused.forwardId));
    assert.deepEqual(saved().workspaces.map((workspace) => workspace.id), [local.id]);
  } finally {
    plugin.stop();
    inspect.disconnect();
  }
}));
