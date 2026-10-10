const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, run, testEnv, waitForShell, wangcaiApp, writeInit } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

test('local terminal, reconnect and relaunch', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-workspaces-')));
  const env = testEnv(home);
  let desktop;
  let devServer;
  const launch = async () => {
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    page.on('pageerror', (error) => console.error('UI error:', error));
    await waitForShell(page);
    assert.equal(await page.title(), '旺财');
    assert.equal(await desktop.evaluate(({ app }) => app.getName()), '旺财');
    return page;
  };
  try {
    writeInit(home);
    let page = await launch();
    const localTabs = page.getByRole('tablist', { name: '工作区', exact: true });
    await createWorkspace(page);
    await localTabs.getByRole('tab').filter({ hasText: '~' }).waitFor();
    await run(page, "printf 'WORKSPACE_%s\\n' success");
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('WORKSPACE_success'));
    await run(page, "printf 'X%.0s' {1..400}; echo");
    await page.waitForFunction(() => [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].some((element) => element.textContent.length > 60 && /^X+$/.test(element.textContent)));
    const overhang = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].map((element) => (element.lastElementChild?.getBoundingClientRect().right ?? 0) - element.getBoundingClientRect().right)));
    assert.ok(overhang <= 0.5, `terminal rows clip their last column by ${overhang.toFixed(2)}px`);
    const terminal = await page.evaluate(() => {
      const surface = document.querySelector('.terminal-pane.active .terminal-surface');
      const bar = surface.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
      const ruler = surface.querySelector('.xterm-decoration-overview-ruler');
      return {
        bar: [getComputedStyle(bar).width, getComputedStyle(bar.querySelector('.slider')).width],
        overlap: surface.querySelector('.xterm-screen').offsetWidth - surface.querySelector('.xterm-viewport').clientWidth,
        outline: [...ruler.getContext('2d').getImageData(0, 0, 1, 1).data],
      };
    });
    assert.deepEqual(terminal.bar, ['10px', '10px'], 'the terminal scrollbar is 10px wide');
    assert.ok(terminal.overlap <= 0, `the terminal grid runs ${terminal.overlap}px under the viewport scrollbar`);
    assert.deepEqual(terminal.outline, [18, 19, 20, 255], 'the overview ruler outline hides in the terminal background');
    const workspaces = (await page.evaluate(() => window.wangcai.request('terminal-agent', 'config'))).workspaces;
    assert.equal(workspaces.length, 1);
    assert.equal(await localTabs.getByRole('tab').count(), 1);
    await createWorkspace(page);
    await localTabs.getByRole('tab').nth(1).waitFor();
    await localTabs.getByRole('tab').nth(0).click();
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('WORKSPACE_success'));
    await localTabs.getByRole('tab').nth(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.workspaces [role=tab]').length === 1);
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('WORKSPACE_success'));
    // What the plugin keeps of its own is the workspaces it holds, not the machines init.ts names.
    const stored = JSON.parse(readFileSync(join(home, '.local/share/wangcai/data/terminal-agent/config.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored), ['workspaces']);
    assert.equal(stored.workspaces[0].sessionId, workspaces[0].sessionId);
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await page.getByRole('tab', { name: '文件', exact: true }).waitFor();
    const storedTabs = JSON.parse(readFileSync(join(home, '.local/share/wangcai/tabs.json'), 'utf8'));
    assert.deepEqual(storedTabs, [{ plugin: 'files', id: 'directory', workspaceId: workspaces[0].id }]);
    await page.screenshot({ path: 'tests/dist/screenshots/workspaces.png' });
    await desktop.close(); desktop = undefined;
    page = await launch();
    await page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab').filter({ hasText: '~' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('WORKSPACE_success'));
    assert.equal((await page.evaluate(() => window.wangcai.request('terminal-agent', 'config'))).workspaces[0].sessionId, workspaces[0].sessionId);
    await page.getByRole('tab', { name: '文件', exact: true }).waitFor();
    await page.getByRole('tab', { name: '~' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.workspaces [role=tab]').length === 0);
    assert.deepEqual((await page.evaluate(() => window.wangcai.request('terminal-agent', 'config'))).workspaces, []);
    await desktop.close(); desktop = undefined;
    const { resolveConfig } = await import(pathToFileURL(require.resolve('electron-vite', { paths: [app] })).href);
    const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [app] })).href);
    const { config: viteConfig } = await resolveConfig({ root: join(app, 'desktop') }, 'serve');
    devServer = await createServer({ ...viteConfig.renderer, configFile: false, server: { port: 0, host: '127.0.0.1' } });
    await devServer.listen();
    env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${devServer.httpServer.address().port}`;
    page = await launch();
    await page.waitForFunction(() => document.querySelectorAll('.workspaces [role=tab]').length === 0);
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    await devServer?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('workspaces can be dragged into a new order', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-workspace-order-')));
  const env = testEnv(home);
  let desktop;
  let page;
  const open = async () => {
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await waitForShell(page);
  };
  const WORKSPACE_NAMES = '[aria-label="工作区"] [role=tab] .name';
  const settled = (expected) => page.waitForFunction(([selector, want]) => [...document.querySelectorAll(selector)].map((node) => node.textContent).join() === want, [WORKSPACE_NAMES, expected.join()]);
  try {
    writeInit(home);
    for (const name of ['alpha', 'beta', 'gamma']) mkdirSync(join(home, name));
    await open();
    await createWorkspace(page);
    await settled(['~']);
    await run(page, 'cd alpha');
    await settled(['alpha']);
    await createWorkspace(page);
    await settled(['alpha', '~']);
    await run(page, 'cd beta');
    await settled(['alpha', 'beta']);
    await createWorkspace(page);
    await settled(['alpha', 'beta', '~']);
    await run(page, 'cd gamma');
    await settled(['alpha', 'beta', 'gamma']);
    await page.getByRole('tab', { name: 'beta' }).dragTo(page.getByRole('tab', { name: 'alpha' }), { targetPosition: { x: 40, y: 4 } });
    await settled(['beta', 'alpha', 'gamma']);
    // dropping a row below a row ahead of it moves it after that row
    await page.getByRole('tab', { name: 'gamma' }).dragTo(page.getByRole('tab', { name: 'beta' }), { targetPosition: { x: 40, y: 20 } });
    await settled(['beta', 'gamma', 'alpha']);
    await desktop.close(); desktop = undefined;
    await open();
    await settled(['beta', 'gamma', 'alpha']);
  } finally {
    await desktop?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('a workspace whose terminal is gone opens again where it was', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-workspace-cwd-')));
  const env = testEnv(home);
  const directory = join(home, 'alpha');
  const stored = () => JSON.parse(readFileSync(join(home, '.local/share/wangcai/data/terminal-agent/config.json'), 'utf8')).workspaces[0];
  let desktop;
  let page;
  try {
    writeInit(home);
    mkdirSync(directory);
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await waitForShell(page);
    await createWorkspace(page);

    await run(page, 'cd alpha');
    // The directory is polled from the shell, so this waits for the poll rather than the cd.
    for (let attempt = 0; attempt < 100 && stored().cwd !== directory; attempt++) await page.waitForTimeout(100);
    assert.equal(stored().cwd, directory, 'the workspace keeps the directory its shell is in');

    // The shell the workspace had exits, so the next terminal it opens is a replacement.
    await run(page, 'exit');
    await page.getByRole('button', { name: '重新打开终端' }).click();

    // The pane drops input until its shell is attached, so pwd is printed until the screen shows it.
    const printed = () => page.evaluate(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '');
    for (let attempt = 0; attempt < 30 && !(await printed()).includes(directory); attempt++) {
      await run(page, 'pwd');
      await page.waitForTimeout(200);
    }
    assert.ok((await printed()).includes(directory), 'the replacement opens where the last terminal was');
  } finally {
    await desktop?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
