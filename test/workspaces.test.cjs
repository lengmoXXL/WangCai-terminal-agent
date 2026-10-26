const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { ACTIVE_TERMINAL, createWorkspace, openView, run, serveRenderer, until, withHome, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { closeWorkspace, lists, openWorkspaces, runUntilShown, screen, settled, storedConfig, storedWorkspace, tabs } = require('./terminal-agent-ui.cjs');

// The sidebar's own tab for the view the files plugin draws.
const fileTab = (page) => page.getByRole('tab', { name: '文件', exact: true });

test('local terminal, reconnect and relaunch', { timeout: 180000 }, () => withHome('wangcai-workspaces', lists, async ({ home, env, open }) => {
  let desktop;
  let page;
  let close;
  const launch = async () => {
    ({ desktop, page, close } = await open());
    assert.equal(await page.title(), '旺财');
    assert.equal(await desktop.evaluate(({ app }) => app.getName()), '旺财');
  };
  await launch();
  await createWorkspace(page);
  await tabs(page).filter({ hasText: '~' }).waitFor();
  await runUntilShown(page, "printf 'WORKSPACE_%s\\n' success", 'WORKSPACE_success');
  await run(page, "printf 'X%.0s' {1..400}; echo");
  // Each row as drawn: what it says, and how far its last column runs past the row.
  let drawnRows;
  await until(async () => (drawnRows = await page.evaluate((selector) => [...document.querySelectorAll(`${selector} .xterm-rows > div`)].map((row) => ({
    text: row.textContent,
    overhang: (row.lastElementChild?.getBoundingClientRect().right ?? 0) - row.getBoundingClientRect().right,
  })), ACTIVE_TERMINAL)).some((row) => row.text.length > 60 && /^X+$/.test(row.text)));
  const overhang = Math.max(...drawnRows.map((row) => row.overhang));
  assert.ok(overhang <= 0.5, `terminal rows clip their last column by ${overhang.toFixed(2)}px`);
  const terminalShape = await page.evaluate((selector) => {
    const surface = document.querySelector(`${selector} .terminal-surface`);
    const bar = surface.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
    const ruler = surface.querySelector('.xterm-decoration-overview-ruler');
    return {
      bar: [getComputedStyle(bar).width, getComputedStyle(bar.querySelector('.slider')).width],
      overlap: surface.querySelector('.xterm-screen').offsetWidth - surface.querySelector('.xterm-viewport').clientWidth,
      outline: [...ruler.getContext('2d').getImageData(0, 0, 1, 1).data],
    };
  }, ACTIVE_TERMINAL);
  assert.deepEqual(terminalShape.bar, ['10px', '10px'], 'the terminal scrollbar is 10px wide');
  assert.ok(terminalShape.overlap <= 0, `the terminal grid runs ${terminalShape.overlap}px under the viewport scrollbar`);
  assert.deepEqual(terminalShape.outline, [18, 19, 20, 255], 'the overview ruler outline hides in the terminal background');
  const workspaces = await openWorkspaces(page);
  assert.equal(workspaces.length, 1);
  assert.equal(await tabs(page).count(), 1);
  await createWorkspace(page);
  await tabs(page).nth(1).waitFor();
  await tabs(page).nth(0).click();
  await until(async () => (await screen(page)).includes('WORKSPACE_success'));
  await closeWorkspace(tabs(page).nth(1));
  await settled(page, ['~']);
  await until(async () => (await screen(page)).includes('WORKSPACE_success'));
  // What the plugin keeps of its own is the workspaces it holds, not the machines init.ts names.
  const config = storedConfig(home);
  assert.deepEqual(Object.keys(config), ['workspaces']);
  assert.equal(config.workspaces[0].sessionId, workspaces[0].sessionId);
  await openView(page, '文件');
  await fileTab(page).waitFor();
  const storedTabs = JSON.parse(readFileSync(join(home, '.local/share/wangcai/data/core/tabs.json'), 'utf8'));
  assert.deepEqual(storedTabs, [{ plugin: 'files', id: 'directory', workspaceId: workspaces[0].id }]);
  await page.screenshot({ path: 'tests/dist/screenshots/workspaces.png' });
  await close();
  await launch();
  await tabs(page).filter({ hasText: '~' }).waitFor();
  await until(async () => (await screen(page)).includes('WORKSPACE_success'));
  assert.equal((await openWorkspaces(page))[0].sessionId, workspaces[0].sessionId);
  // The tab is part of what the workspace was stored with, so the window that launches draws it again.
  await fileTab(page).waitFor();
  await closeWorkspace(tabs(page).filter({ hasText: '~' }));
  await settled(page, []);
  assert.deepEqual(await openWorkspaces(page), []);
  await close();
  const stopRenderer = await serveRenderer(env);
  await launch();
  await settled(page, []);
  await stopRenderer();
}));

test('workspaces can be dragged into a new order', { timeout: 180000 }, () => withHome('wangcai-workspace-order', lists, async ({ home, open }) => {
  for (const name of ['alpha', 'beta', 'gamma']) mkdirSync(join(home, name));
  let { page, close } = await open();
  await createWorkspace(page);
  await settled(page, ['~']);
  await run(page, 'cd alpha');
  await settled(page, ['alpha']);
  await createWorkspace(page);
  await settled(page, ['alpha', '~']);
  await run(page, 'cd beta');
  await settled(page, ['alpha', 'beta']);
  await createWorkspace(page);
  await settled(page, ['alpha', 'beta', '~']);
  await run(page, 'cd gamma');
  await settled(page, ['alpha', 'beta', 'gamma']);
  // A row is found by the name it shows, which is its workspace's, and the list drops it on a line between entries,
  // so it stands where the line it was dropped on is.
  const row = (name) => tabs(page).filter({ hasText: name });
  const lineBeside = async (name, step) => {
    const at = await row(name).evaluate((element, step) => [...element.parentElement.children].indexOf(element) + step, step);
    return page.locator(`.workspaces > :nth-child(${at + 1})`);
  };
  const onLine = { x: 40, y: 0 };
  await row('beta').dragTo(await lineBeside('alpha', -1), { targetPosition: onLine });
  await settled(page, ['beta', 'alpha', 'gamma']);
  // Dropping a row on the line below another one puts it after that row.
  await row('gamma').dragTo(await lineBeside('beta', 1), { targetPosition: onLine });
  await settled(page, ['beta', 'gamma', 'alpha']);
  await close();
  ({ page, close } = await open());
  await settled(page, ['beta', 'gamma', 'alpha']);
}));

test('a workspace whose terminal is gone opens again where it was', { timeout: 180000 }, () => withWindow('wangcai-workspace-cwd', lists, async ({ home, page }) => {
  const directory = join(home, 'alpha');
  mkdirSync(directory);
  await createWorkspace(page);

  await run(page, 'cd alpha');
  // The directory is polled from the shell, so this waits for the poll rather than the cd.
  await until(() => storedWorkspace(home).cwd === directory);

  // The shell the workspace had exits, so the next terminal it opens is a replacement.
  await run(page, 'exit');
  await page.getByRole('button', { name: '重新打开终端' }).click();

  await runUntilShown(page, 'pwd', directory);
}));
