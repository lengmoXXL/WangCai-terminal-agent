const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, openWorkspaceMenu, pluginDirectory, waitForShell, wangcaiApp } = require('./harness.cjs');

/** The checkout next to this repository runs these plugins; its Electron launches the app. */
const app = wangcaiApp();
const { _electron: electron } = require(join(app ?? '../WangCai', 'node_modules/playwright'));

test('user config: init.ts drives the plugins, the UI theme, their own config and the terminal', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-config-')));
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const init = join(home, '.config/wangcai/init.ts');
  let desktop;
  const launch = async () => {
    desktop = await electron.launch({ executablePath: require(join(app, 'node_modules/electron')), args: [join(app, 'desktop'), `--user-data-dir=${join(home, 'electron')}`], cwd: app, env });
    return desktop.firstWindow();
  };
  const launchReady = async () => {
    const page = await launch();
    await waitForShell(page);
    return page;
  };
  try {
    mkdirSync(join(home, '.config/wangcai'), { recursive: true });
    writeFileSync(init, `
      export const profiles = {
        day: {
          theme: { background: '#f7f8fa', foreground: '#203040', border: 42 },
          workspaces: [
            { id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { font: { family: 'Config UI Font' }, machines: [{ name: '测试服务器', host: 'dev-server' }] } },
          ],
          tabs: [
            { id: 'terminal', directory: ${JSON.stringify(pluginDirectory('terminal'))}, config: { font: { family: 'Config Mono', size: 20, lineHeight: 1.5 } } },
          ],
        },
      };
      export default profiles.day;
    `);
    let page = await launchReady();
    // The lists decide what loads: the plugins they do not name never run.
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map((plugin) => plugin.id)), ['terminal', 'terminal-agent']);
    // A plugin's schema fills in what its entry leaves out.
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map(({ id, config }) => [id, config])), [
      ['terminal', { font: { family: 'Config Mono', size: 20, lineHeight: 1.5 } }],
      ['terminal-agent', { font: { family: 'Config UI Font', size: 13, lineHeight: 1 }, machines: [{ name: '测试服务器', host: 'dev-server' }] }],
    ]);
    // The shell keeps its own font: the app's config has no say in it.
    assert.deepEqual(await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return [body.backgroundColor, body.color, body.fontFamily, getComputedStyle(document.documentElement).getPropertyValue('--wc-border'), document.documentElement.style.colorScheme];
    }), ['rgb(247, 248, 250)', 'rgb(32, 48, 64)', '"DejaVuSansM Nerd Font Mono", monospace', '#333536', 'light']);
    // The menu offers what init.ts names: the local machine first, then the hosts it lists.
    const menu = page.locator('#workspace-row-menu');
    await openWorkspaceMenu(page);
    await menu.getByRole('menuitem', { name: '本机', exact: true }).waitFor();
    // The entry carries the host it names, which is also what a screen reader reads out.
    await menu.getByRole('menuitem', { name: '测试服务器' }).waitFor();
    // A machine that will not connect says so on hover and stops being clickable.
    await menu.getByRole('menuitem', { name: '测试服务器' }).click();
    await page.waitForFunction(() => {
      const entry = document.querySelectorAll('#workspace-row-menu [role=menuitem]')[1];
      return entry?.disabled === true && entry.title.length > 0;
    });
    await page.keyboard.press('Escape');
    await openWorkspaceMenu(page);
    assert.equal(await menu.getByRole('menuitem', { name: '测试服务器' }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await createWorkspace(page);
    // A plugin's own font applies to the panel the shell gives it, and to the terminal it draws there.
    assert.equal(await page.locator('.desktop-main .plugin[data-plugin=terminal-agent]').evaluate((element) => getComputedStyle(element).fontFamily), '"Config UI Font"');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.xterm-scrollable-element')).backgroundColor === 'rgb(247, 248, 250)');
    assert.deepEqual(await page.evaluate(() => {
      const rows = getComputedStyle(document.querySelector('.xterm-rows'));
      return [rows.fontFamily, rows.fontSize, rows.color];
    }), ['"Config UI Font"', '13px', 'rgb(32, 48, 64)']);
    await desktop.close(); desktop = undefined;

    writeFileSync(init, 'export default { theme: ');
    page = await launch();
    // A broken config file leaves the app with no plugin at all.
    await page.waitForFunction(() => document.querySelector('#root').textContent.trim());
    assert.match(await page.locator('#root').innerText(), /未安装插件/);
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, document.documentElement.style.colorScheme]), ['rgb(18, 19, 20)', 'dark']);
    // The app's own profile carries no plugin fields: fonts belong to the plugins alone.
    assert.deepEqual(await page.evaluate(async () => Object.keys(await window.wangcai.config()).sort()), ['agent', 'theme']);
    await desktop.close(); desktop = undefined;
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
