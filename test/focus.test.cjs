const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ACTIVE_TERMINAL, activeTerminal, createWorkspace, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lists } = require('./terminal-agent-ui.cjs');

// A program in the terminal draws its own caret and keeps drawing it, so what shows the keys left is the whole
// surface going dim.
const opacity = (page) => page.evaluate((selector) => getComputedStyle(document.querySelector(`${selector} .terminal-surface`)).opacity, ACTIVE_TERMINAL);

test('two Escapes leave the terminal dim, and a click brings it back', { timeout: 180000 }, () => withWindow('wangcai-terminal-focus', lists, async ({ page }) => {
  await createWorkspace(page);
  const field = activeTerminal(page).locator('.xterm-helper-textarea');
  await field.click();
  assert.equal(await opacity(page), '1');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  assert.notEqual(await opacity(page), '1');
  await field.click();
  assert.equal(await opacity(page), '1');
}));
