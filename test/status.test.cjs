const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, run, testEnv, waitForShell, wangcaiApp, writeInit } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

test('a workspace row follows its terminal output, not an agent report', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-status-')));
  const env = testEnv(home);
  let desktop;
  try {
    // Settings directories for the agents this plugin used to set up: a session writes nothing into them now.
    mkdirSync(join(home, '.pi/agent/extensions'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    page.on('pageerror', (error) => console.error('UI error:', error));
    await waitForShell(page);
    await createWorkspace(page);
    const badge = page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab').first().locator('.agent-state');
    const drawn = (state) => page.waitForFunction((state) => document.querySelectorAll('.workspace .agent-state')[0]?.dataset.state === state, state);
    // A command that keeps writing keeps the row working.
    await run(page, 'while :; do echo TICK; sleep 0.1; done');
    await drawn('working');
    // The quiet after the last report makes the row finished.
    await page.keyboard.press('Control+C');
    await drawn('finished');
    // The click clears what the row drew, and the next output starts it working again.
    await badge.click();
    await drawn('idle');
    await run(page, 'echo AGAIN');
    await drawn('working');
    await drawn('finished');
    assert.deepEqual(readdirSync(join(home, '.pi/agent/extensions')), [], 'nothing is installed for pi');
    assert.deepEqual(readdirSync(join(home, '.codex')), [], 'nothing is installed for codex');
    assert.equal(existsSync(join(home, '.local/share/wangcai/agent-state')), false, 'no report directory is made');
  } finally {
    await desktop?.close().catch(() => {});
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});