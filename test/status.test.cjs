const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { ACTIVE_TERMINAL, createWorkspace, run, until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lists, tabs } = require('./terminal-agent-ui.cjs');

// Core paints what this plugin reports on the workspace's row, so the state is the row's own attribute.
const row = (page, at) => tabs(page).nth(at);
const stateOf = (page, at) => row(page, at).getAttribute('data-state');
const inState = (page, state) => tabs(page).and(page.locator(`[data-state="${state}"]`)).first();
// Input typed into a pane only reaches its shell once that pane is the one in front.
const firstPaneInFront = (page) => until(() => page.evaluate((selector) => document.querySelector(selector) === document.querySelectorAll('.terminal-pane')[0], ACTIVE_TERMINAL));
// A terminal counts as done in the plugin's eyes after two seconds of quiet, and only then can a finish come. A shell
// that draws its prompt again counts as output, so the row it belongs to may report a working again right after.
const quiet = 2000;
// One row's turn through that window: it answers false the moment a finish is drawn, and true when a quiet passes.
const noFinish = async (page, at) => {
  let previous;
  let since = Date.now();
  while (Date.now() - since < quiet + 500) {
    const state = await stateOf(page, at);
    if (state === 'finished') return false;
    if (state !== previous || state === 'working') {
      previous = state;
      since = Date.now();
    }
    await page.waitForTimeout(300);
  }
  return true;
};

test('a workspace row follows its terminal output, and only a quiet behind it draws a finish', { timeout: 180000 }, () => withWindow('wangcai-status', lists, async ({ page }) => {
  await createWorkspace(page);
  // A command that keeps writing keeps the row working.
  await run(page, 'while :; do echo TICK; sleep 0.1; done');
  await inState(page, 'working').waitFor();
  // A quiet in the workspace in front draws nothing: whoever watches it needs no telling.
  await page.keyboard.press('Control+C');
  await inState(page, 'idle').waitFor();
  await createWorkspace(page);
  assert.ok(await noFinish(page, 1), 'a quiet seen in front is no finish later');
  // The one behind finishes while nobody watches it, so that is where the finish belongs.
  await row(page, 0).click();
  await firstPaneInFront(page);
  await run(page, 'sleep 3; echo DONE');
  await row(page, 1).click();
  await inState(page, 'working').waitFor();
  await inState(page, 'finished').waitFor();
  assert.match(await row(page, 0).getAttribute('aria-label'), /已完成/, 'the row names the state it draws');
}));

test('a finish is the row it is drawn on, and looking at it is what clears it', { timeout: 180000 }, () => withWindow('wangcai-check', lists, async ({ page }) => {
  await createWorkspace(page);
  await createWorkspace(page);
  // The first workspace finishes while the second one is in front.
  await row(page, 0).click();
  await firstPaneInFront(page);
  await run(page, 'sleep 3; echo DONE');
  await row(page, 1).click();
  await inState(page, 'finished').waitFor();
  // The row is the finish.
  await inState(page, 'finished').click();
  assert.equal(await tabs(page).evaluateAll((rows) => rows.findIndex((element) => element.classList.contains('selected'))), 0, 'the row clicked came in front');
  assert.equal(await stateOf(page, 0), 'idle', 'the finished row is idle again');
  // Looked at, the workspace reports nothing further: what a finish waits for has already been seen.
  assert.ok(await noFinish(page, 0), 'a workspace in front raises no finish');
}));

test('a workspace leaves the agent settings and the old report directory alone', { timeout: 180000 }, () => withWindow('wangcai-agents', lists, async ({ home, page }) => {
  // Agent settings directories: a session that wrote into either would leave it here.
  mkdirSync(join(home, '.pi/agent/extensions'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  await createWorkspace(page);
  assert.deepEqual(readdirSync(join(home, '.pi/agent/extensions')), [], 'nothing is installed for pi');
  assert.deepEqual(readdirSync(join(home, '.codex')), [], 'nothing is installed for codex');
  assert.equal(existsSync(join(home, '.local/share/wangcai/agent-state')), false, 'no report directory is made');
}));
