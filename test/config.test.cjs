const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, openWorkspaceMenu, pluginDirectory, testEnv, waitForShell, wangcaiApp } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

test('user config: init.ts drives the plugins, the UI theme, their own config and the terminal', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-config-')));
  const env = testEnv(home);
  const init = join(home, '.config/wangcai/init.ts');
  let desktop;
  const launch = async () => {
    desktop = await launchApp(home, env);
    return desktop.firstWindow();
  };
  try {
    mkdirSync(join(home, '.config/wangcai'), { recursive: true });
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
    let page = await launch();
    await waitForShell(page);
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map((plugin) => plugin.id)), ['terminal', 'terminal-agent']);
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map(({ id, config }) => [id, config])), [
      ['terminal', { font: { family: 'Config Mono', size: 20, lineHeight: 1.5 } }],
      ['terminal-agent', { font: { family: 'Config UI Font', size: 13, lineHeight: 1 }, machines: [{ name: '测试服务器', host: 'wangcai-test.invalid' }], images: { maxCount: 100 } }],
    ]);
    assert.deepEqual(await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return [body.backgroundColor, body.color, body.fontFamily, getComputedStyle(document.documentElement).getPropertyValue('--wc-border'), document.documentElement.style.colorScheme];
    }), ['rgb(247, 248, 250)', 'rgb(32, 48, 64)', '"DejaVuSansM Nerd Font Mono", monospace', '#333536', 'light']);
    const menu = page.locator('#workspace-row-menu');
    await openWorkspaceMenu(page);
    await menu.getByRole('menuitem', { name: '新建 本机', exact: true }).waitFor();
    await menu.getByRole('menuitem', { name: '测试服务器' }).waitFor();
    await menu.getByRole('menuitem', { name: '测试服务器' }).click();
    await page.waitForFunction(() => {
      const entry = document.querySelectorAll('#workspace-row-menu [role=menuitem]')[1];
      return entry?.disabled === false && entry.title.length > 0;
    });
    await page.keyboard.press('Escape');
    await openWorkspaceMenu(page);
    assert.equal(await menu.getByRole('menuitem', { name: '测试服务器' }).isDisabled(), false);
    assert.ok(await menu.getByRole('menuitem', { name: '测试服务器' }).getAttribute('title'));
    await page.keyboard.press('Escape');
    await createWorkspace(page);
    assert.equal(await page.locator('.desktop-main .plugin[data-plugin=terminal-agent]').evaluate((element) => getComputedStyle(element).fontFamily), '"Config UI Font"');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.xterm-scrollable-element')).backgroundColor === 'rgb(247, 248, 250)');
    assert.deepEqual(await page.evaluate(() => {
      const rows = getComputedStyle(document.querySelector('.xterm-rows'));
      return [rows.fontFamily, rows.fontSize, rows.color];
    }), ['"Config UI Font"', '13px', 'rgb(32, 48, 64)']);
    await desktop.close(); desktop = undefined;

    writeFileSync(init, 'export default { theme: ');
    page = await launch();
    await page.waitForFunction(() => document.querySelector('#root').textContent.trim());
    assert.match(await page.locator('#root').innerText(), /未安装插件/);
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, document.documentElement.style.colorScheme]), ['rgb(18, 19, 20)', 'dark']);
    assert.deepEqual(await page.evaluate(async () => Object.keys(await window.wangcai.config()).sort()), ['theme']);
    await desktop.close(); desktop = undefined;
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
