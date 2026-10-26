const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { activeTerminal, createWorkspace, until, wangcaiApp, withHome } = require('@lengmoxxl/wangcai-testkit');
const { pluginDirectory, runUntilShown, storedWorkspace, tabs } = require('./terminal-agent-ui.cjs');

test('a node started again carries what init.ts asks for, and its terminals have it', { timeout: 180000 }, () => withHome('wangcai-env', {}, async ({ home, env, open }) => {
  const wangcai = join(wangcaiApp(), 'wangcaicli/dist/debug/wangcai');
  const init = join(home, '.config/wangcai/init.ts');
  // The environment init.ts asks for, with a value only the machine that runs it can expand.
  const configured = (value) => writeFileSync(init, `
    export default {
      workspaces: [{ id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { machines: [{ host: 'local', env: { WANGCAI_TEST_ENV: '${value}', WANGCAI_TEST_PATH: '$HOME/asked' } }] } }],
      tabs: [{ id: 'terminal', directory: ${JSON.stringify(pluginDirectory('terminal'))} }],
    };
  `);
  const serverPath = join(home, '.local/share/wangcai/server.json');
  const nodePid = () => { try { return JSON.parse(readFileSync(serverPath, 'utf8')).pid; } catch { return undefined; } };
  // The line this case types, and the text that answers it, which carries the value the shell was started with.
  const command = 'printf \'ASKED_%s_%s\\n\' "$WANGCAI_TEST_ENV" "$WANGCAI_TEST_PATH"';
  const answer = (value) => `ASKED_${value}_${home}/asked`;
  configured('first');
  let { page, close } = await open();
  await createWorkspace(page);
  await runUntilShown(page, command, answer('first'));
  const firstPid = nodePid();
  assert.equal(typeof firstPid, 'number', 'a workspace opened a node of its own');
  // The directory is what the shell of the workspace reports, so the entry carries it once that shell has answered.
  await until(() => Boolean(storedWorkspace(home).cwd));
  const workspace = storedWorkspace(home);
  await close();

  // What a node holds is what it was started with, so a new environment is a new node: this one is stopped by
  // hand, the way a person restarts it.
  configured('second');
  execFileSync(wangcai, ['server', 'stop'], { env, stdio: 'ignore' });
  ({ page, close } = await open());
  await until(() => Boolean(nodePid()));
  assert.notEqual(nodePid(), firstPid, 'the node is another process than the one that was stopped');
  await tabs(page).filter({ hasText: '~' }).waitFor();
  // The terminal the stopped node held is gone with it, so the workspace opens another one on the new node.
  await activeTerminal(page).locator('.xterm-helper-textarea').waitFor({ timeout: 60000 });
  await runUntilShown(page, command, answer('second'));
  // The workspace the run before left is the one that opened again, with a terminal the new node started.
  assert.equal(storedWorkspace(home).id, workspace.id, 'the same workspace');
  assert.equal(storedWorkspace(home).cwd, workspace.cwd, 'the shell opens where the workspace was');
  assert.notEqual(storedWorkspace(home).sessionId, workspace.sessionId, 'a terminal of the new node, not the one of the old');
}));
