const { test } = require('node:test');
const { ACTIVE_TERMINAL, activeTerminal, createWorkspace, until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lists, screen } = require('./terminal-agent-ui.cjs');

test('the workspace takes the keys when its own key asks for it', { timeout: 180000 }, () => withWindow('wangcai-terminal-agent-keys', lists, async ({ page }) => {
  await createWorkspace(page);
  // The keys are elsewhere: nothing in the window holds them until the key asks for the workspace.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  for (const key of ['Space', 'a', 'a']) await page.keyboard.press(key);
  // The key reaches the view through the main process, so the keys are its terminal's only once the round trip is back.
  await until(() => page.evaluate((selector) => document.querySelector(`${selector} .xterm-helper-textarea`) === document.activeElement, ACTIVE_TERMINAL));
  // Nothing is clicked between the key and the typing: showing the workspace is what puts the keys in its terminal.
  await page.keyboard.type("printf 'KEYS_%s\\n' ok");
  await page.keyboard.press('Enter');
  await until(async () => (await screen(page)).includes('KEYS_ok'));
}));

test('two Escapes leave the terminal', { timeout: 180000 }, () => withWindow('wangcai-terminal-agent-escape', lists, async ({ page }) => {
  await createWorkspace(page);
  await activeTerminal(page).locator('.xterm-helper-textarea').click();
  // A pair has to land inside the 300ms the window allows, so both presses go out in one go.
  await page.evaluate((selector) => {
    const field = document.querySelector(`${selector} .xterm-helper-textarea`);
    for (let index = 0; index < 2; index += 1) field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }, ACTIVE_TERMINAL);
  await until(() => page.evaluate(() => document.querySelector('[data-plugin="terminal-agent"]') === document.activeElement));
}));
