const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, pluginDirectory, run, testEnv, waitForShell, wangcaiApp } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

test('a node started again carries what init.ts asks for, and its terminals have it', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-env-')));
  const env = testEnv(home);
  const init = join(home, '.config/wangcai/init.ts');
  const wangcai = join(app, 'wangcaicli/dist/debug/wangcai');
  // The environment init.ts asks for, with a value only the machine that runs it can expand.
  const configured = (value) => writeFileSync(init, `
    export default {
      workspaces: [{ id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { machines: [{ host: 'local', env: { WANGCAI_TEST_ENV: '${value}', WANGCAI_TEST_PATH: '$HOME/asked' } }] } }],
      tabs: [{ id: 'terminal', directory: ${JSON.stringify(pluginDirectory('terminal'))} }],
    };
  `);
  const state = join(home, '.local/share/wangcai/server.json');
  const nodePid = () => { try { return JSON.parse(readFileSync(state, 'utf8')).pid; } catch { return undefined; } };
  const printed = () => page.evaluate(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '');
  // The line is typed until the screen shows what it asked: a pane whose shell is still attaching drops input.
  const shows = async (wanted) => {
    for (let attempt = 0; attempt < 40 && !(await printed()).includes(wanted); attempt++) {
      await run(page, 'printf \'ASKED_%s_%s\\n\' "$WANGCAI_TEST_ENV" "$WANGCAI_TEST_PATH"').catch(() => {});
      await page.waitForTimeout(250);
    }
    assert.ok((await printed()).includes(wanted), `the terminal holds ${wanted}`);
  };
  let desktop;
  let page;
  const open = async () => {
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await waitForShell(page);
  };
  try {
    mkdirSync(join(home, '.config/wangcai'), { recursive: true });
    configured('first');
    await open();
    await createWorkspace(page);
    await shows(`ASKED_first_${home}/asked`);
    const first = nodePid();
    assert.equal(typeof first, 'number', 'a workspace opened a node of its own');
    await desktop.close(); desktop = undefined;

    // What a node holds is what it was started with, so a new environment is a new node: this one is stopped by
    // hand, the way a person restarts it.
    configured('second');
    execFileSync(wangcai, ['server', 'stop'], { env, stdio: 'ignore' });
    await open();
    for (let attempt = 0; attempt < 200 && !nodePid(); attempt++) await page.waitForTimeout(100);
    assert.notEqual(nodePid(), first, 'the node is another process than the one that was stopped');
    await page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab').filter({ hasText: '~' }).waitFor();
    // The terminal the stopped node held is gone with it, so the workspace opens another one on the new node.
    await page.locator('.terminal-pane.active .xterm-helper-textarea').waitFor({ timeout: 60000 });
    await shows(`ASKED_second_${home}/asked`);
  } finally {
    await desktop?.close().catch(() => {});
    try { execFileSync(wangcai, ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});