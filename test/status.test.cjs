const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, run, testEnv, waitForShell, wangcaiApp, writeInit } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

/** The first workspace row's badge, narrowed to the given state when one is passed. */
const badge = (page, state) => page.locator('.workspace').first().locator(`.agent-state${state ? `[data-state="${state}"]` : ''}`);
const tabs = (page) => page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab');
/** Input typed into a pane only reaches its shell once that pane is the one in front. */
const firstPaneInFront = (page) => page.waitForFunction(() => document.querySelectorAll('.terminal-pane')[0]?.classList.contains('active'));
// A terminal counts as done in the plugin's eyes after two seconds of quiet, and only then can a check come.
const quiet = 2000;
const noCheck = async (page) => {
  let previous;
  let since = Date.now();
  while (Date.now() - since < quiet + 500) {
    const state = await badge(page).getAttribute('data-state');
    if (state === 'finished') return false;
    if (state !== previous || state === 'working') {
      previous = state;
      since = Date.now();
    }
    await page.waitForTimeout(300);
  }
  return true;
};

test('a workspace row follows its terminal output, and only a quiet in the background draws a check', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-status-')));
  const env = testEnv(home);
  let desktop;
  try {
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    page.on('pageerror', (error) => console.error('UI error:', error));
    await waitForShell(page);
    await createWorkspace(page);
    // A command that keeps writing keeps the row working.
    await run(page, 'while :; do echo TICK; sleep 0.1; done');
    await badge(page, 'working').waitFor();
    // A quiet in the workspace in front draws a dot: whoever watches it needs no telling.
    await page.keyboard.press('Control+C');
    await badge(page, 'idle').waitFor();
    await createWorkspace(page);
    assert.ok(await noCheck(page), 'a quiet seen in front is no check later');
    // The one behind finishes while nobody watches it, so that is where the check belongs.
    await tabs(page).first().click();
    await firstPaneInFront(page);
    await run(page, 'sleep 3; echo DONE');
    await tabs(page).nth(1).click();
    await badge(page, 'working').waitFor();
    await badge(page, 'finished').waitFor();
  } finally {
    await desktop?.close().catch(() => {});
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('a check is cleared where it stands and never comes back', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-check-')));
  const env = testEnv(home);
  let desktop;
  try {
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    page.on('pageerror', (error) => console.error('UI error:', error));
    await waitForShell(page);
    await createWorkspace(page);
    await createWorkspace(page);
    const front = () => page.evaluate(() => [...document.querySelectorAll('.workspace')].findIndex((element) => element.classList.contains('selected')));
    // The first workspace finishes while the second one is in front.
    await tabs(page).first().click();
    await firstPaneInFront(page);
    await run(page, 'sleep 3; echo DONE');
    await tabs(page).nth(1).click();
    await badge(page, 'finished').waitFor();
    await badge(page).click();
    await badge(page, 'idle').waitFor();
    assert.equal(await front(), 1, 'the click on the check left the front workspace alone');
    await tabs(page).first().click();
    assert.equal(await front(), 0, 'the row clicked came in front');
    assert.ok(await noCheck(page), 'the cleared check does not come back with the workspace');
    await tabs(page).nth(1).click();
    assert.ok(await noCheck(page), 'nor by moving the front away again');
  } finally {
    await desktop?.close().catch(() => {});
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('a workspace leaves the agent settings and the old report directory alone', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-agents-')));
  const env = testEnv(home);
  let desktop;
  try {
    // Agent settings directories: a session that wrote into either would leave it here.
    mkdirSync(join(home, '.pi/agent/extensions'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await waitForShell(page);
    await createWorkspace(page);
    assert.deepEqual(readdirSync(join(home, '.pi/agent/extensions')), [], 'nothing is installed for pi');
    assert.deepEqual(readdirSync(join(home, '.codex')), [], 'nothing is installed for codex');
    assert.equal(existsSync(join(home, '.local/share/wangcai/agent-state')), false, 'no report directory is made');
  } finally {
    await desktop?.close().catch(() => {});
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});