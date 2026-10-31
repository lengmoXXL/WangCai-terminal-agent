const { test } = require('node:test');
const { ACTIVE_TERMINAL, activeTerminal, createWorkspace, until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lists } = require('./terminal-agent-ui.cjs');

// What the terminal in front draws.
const screen = (page) => page.evaluate((selector) => document.querySelector(`${selector} .xterm-rows`)?.textContent ?? '', ACTIVE_TERMINAL);

test('the workspace takes the keys when its own key brings it forward', { timeout: 180000 }, () => withWindow('wangcai-terminal-agent-keys', lists, async ({ page }) => {
  await createWorkspace(page);
  // The keys are elsewhere: the page has them, not the terminal the key is about to bring forward.
  await activeTerminal(page).locator('.xterm-helper-textarea').click();
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  for (const key of ['Space', 'a', 'a']) await page.keyboard.press(key);
  // Nothing is clicked between the key and the typing: showing the workspace is what put the keys in its terminal.
  await page.keyboard.type("printf 'KEYS_%s\\n' ok");
  await page.keyboard.press('Enter');
  await until(async () => (await screen(page)).includes('KEYS_ok'));
}));
