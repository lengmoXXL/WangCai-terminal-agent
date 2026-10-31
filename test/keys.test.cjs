const { test } = require('node:test');
const { activeTerminal, createWorkspace, until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lists, screen } = require('./terminal-agent-ui.cjs');

test('the workspace takes the keys when its own key asks for it', { timeout: 180000 }, () => withWindow('wangcai-terminal-agent-keys', lists, async ({ page }) => {
  await createWorkspace(page);
  // The keys are elsewhere: nothing in the window holds them until the key asks for the workspace.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  for (const key of ['Space', 'a', 'a']) await page.keyboard.press(key);
  // Nothing is clicked between the key and the typing: showing the workspace is what put the keys in its terminal.
  await page.keyboard.type("printf 'KEYS_%s\\n' ok");
  await page.keyboard.press('Enter');
  await until(async () => (await screen(page)).includes('KEYS_ok'));
}));

test('two Escapes leave the terminal', { timeout: 180000 }, () => withWindow('wangcai-terminal-agent-escape', lists, async ({ page }) => {
  await createWorkspace(page);
  await activeTerminal(page).locator('.xterm-helper-textarea').click();
  // A pair has to land inside the 300ms the window allows, so both presses go out in one go.
  await page.evaluate(() => {
    for (let press = 0; press < 2; press += 1) {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  });
  await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-plugin'))) === 'terminal-agent');
}));
