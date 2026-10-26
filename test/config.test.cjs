const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createWorkspace, openWorkspaceMenu, until, withHome } = require('@lengmoxxl/wangcai-testkit');
const { pluginDirectory } = require('./terminal-agent-ui.cjs');

test('user config: init.ts drives the plugins, the UI theme, their own config and the terminal', { timeout: 180000 }, () => withHome('wangcai-config', {}, async ({ home, open }) => {
  const init = join(home, '.config/wangcai/init.ts');
  writeFileSync(init, `
      export const profiles = {
        day: {
          theme: { background: '#f7f8fa', foreground: '#203040', border: 42 },
          workspaces: [
            { id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { font: { family: 'Config UI Font' }, machines: [{ name: '测试服务器', host: 'wangcai-test.invalid' }] } },
          ],
          tabs: [
            { id: 'terminal', directory: ${JSON.stringify(pluginDirectory('terminal'))}, config: { font: { family: 'Config Mono', size: 20, lineHeight: 1.5 } } },
          ],
        },
      };
      export default profiles.day;
    `);
  let { page, close } = await open();
  await until(() => page.evaluate(() => Boolean(window.wangcai)));
  assert.deepEqual(await page.evaluate(async () => (await window.wangcai.call('plugins')).map(({ id, config }) => [id, config])), [
    ['terminal', { font: { family: 'Config Mono', size: 20, lineHeight: 1.5 } }],
    ['terminal-agent', { font: { family: 'Config UI Font', size: 13, lineHeight: 1 }, machines: [{ name: '测试服务器', host: 'wangcai-test.invalid' }], images: { maxCount: 100 } }],
  ]);
  assert.deepEqual(await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    return [body.backgroundColor, body.color, body.fontFamily, getComputedStyle(document.documentElement).getPropertyValue('--wc-border'), document.documentElement.style.colorScheme];
  }), ['rgb(247, 248, 250)', 'rgb(32, 48, 64)', '"DejaVuSansM Nerd Font Mono", monospace', '#333536', 'light']);
  const menu = page.locator('#workspace-row-menu');
  await openWorkspaceMenu(page);
  const server = menu.getByRole('menuitem', { name: '测试服务器' });
  await server.click();
  await until(async () => (await server.isEnabled()) && Boolean(await server.getAttribute('title')));
  await page.keyboard.press('Escape');
  // The reopen draws the entry again, and it still is what the config named: usable, and titled for a pointing reader.
  await openWorkspaceMenu(page);
  assert.ok(await server.isEnabled());
  assert.ok(await server.getAttribute('title'));
  await page.keyboard.press('Escape');
  await createWorkspace(page);
  assert.equal(await page.locator('.desktop-main .plugin[data-plugin=terminal-agent]').evaluate((element) => getComputedStyle(element).fontFamily), '"Config UI Font"');
  await until(() => page.evaluate(() => getComputedStyle(document.querySelector('.xterm-scrollable-element')).backgroundColor === 'rgb(247, 248, 250)'));
  assert.deepEqual(await page.evaluate(() => {
    const rows = getComputedStyle(document.querySelector('.xterm-rows'));
    return [rows.fontFamily, rows.fontSize, rows.color];
  }), ['"Config UI Font"', '13px', 'rgb(32, 48, 64)']);
  await close();

  writeFileSync(init, 'export default { theme: ');
  ({ page, close } = await open());
  await until(() => page.evaluate(() => document.querySelector('#root').textContent.trim() !== ''));
  assert.match(await page.locator('#root').innerText(), /未安装插件/);
  assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, document.documentElement.style.colorScheme]), ['rgb(18, 19, 20)', 'dark']);
  assert.deepEqual(await page.evaluate(async () => Object.keys(await window.wangcai.call('config')).sort()), ['theme']);
}));
