const { test } = require('node:test');
const { createWorkspace, until, withWindow, activeTerminal, ACTIVE_TERMINAL } = require('@lengmoxxl/wangcai-testkit');
const { lists } = require('./test/terminal-agent-ui.cjs');

test('probe', { timeout: 180000 }, () => withWindow('probe-focus', lists, async ({ page }) => {
  await createWorkspace(page);
  await activeTerminal(page).locator('.xterm-helper-textarea').click();
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Space');
  await page.keyboard.press('a');
  await page.keyboard.press('a');
  await page.keyboard.type("printf 'FOCUSED_%s\\n' ok");
  await page.keyboard.press('Enter');
  const text = () => page.evaluate((selector) => document.querySelector(`${selector} .xterm-rows`)?.textContent ?? '', ACTIVE_TERMINAL);
  await until(async () => (await text()).includes('FOCUSED_ok'));
  console.log('TYPED OK');
}));
