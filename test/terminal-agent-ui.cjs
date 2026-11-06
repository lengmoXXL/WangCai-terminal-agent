const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { until } = require('@lengmoxxl/wangcai-testkit');

// What a case does to the window's own chrome.
//
// The menu that makes a workspace is the space under the rows: the rows have to end above the list's bottom edge, so the
// click lands on the list rather than on a row.
const openWorkspaceMenu = async (page) => {
  const list = page.locator('.workspaces');
  const box = await list.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 4, { button: 'right' });
};

/** The terminal of the workspace in front: the app's own pane, not a plugin's panel. */
const ACTIVE_TERMINAL = '.terminal-pane.active';
const activeTerminal = (page) => page.locator(ACTIVE_TERMINAL);

/** Types a line into the pane in front and runs it, the way a person does. */
const run = async (page, line) => {
  await activeTerminal(page).locator('.xterm-helper-textarea').click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};

/** Opens a view in the sidebar, showing the sidebar first when it is off screen. */
const openView = async (page, name) => {
  const newTab = page.getByRole('button', { name: '新建侧栏标签页' });
  if (!(await newTab.isVisible())) await page.getByRole('button', { name: '切换右侧栏' }).click();
  await newTab.click();
  await page.locator('#view-menu').getByRole('button', { name, exact: true }).click();
};

// What a case's window lists: the workspace the agent watches, and the views the sidebar picks from.
const lists = { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };

// A plugin checkout beside this one, which an init.ts written by a case points at.
const pluginDirectory = (id) => resolve(__dirname, `../../WangCai-${id}`);

// What the terminal in front draws.
const screen = (page) => page.evaluate((selector) => document.querySelector(`${selector} .xterm-rows`)?.textContent ?? '', ACTIVE_TERMINAL);

// What the pane reports as wrong, which a healthy one leaves empty.
const paneErrors = (page) => activeTerminal(page).locator('.terminal-message.error').count();

// The workspaces the agent holds now.
const openWorkspaces = (page) => page.evaluate(async () => (await window.wangcai.call('request', 'terminal-agent', 'config')).workspaces);

// What the plugin keeps in this home.
const storedConfig = (home) => JSON.parse(readFileSync(join(home, '.local/share/wangcai/data/terminal-agent/config.json'), 'utf8'));

// The workspace it keeps there.
const storedWorkspace = (home) => storedConfig(home).workspaces[0];

// The workspace rows, in the order the window draws them.
const tabs = (page) => page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab');

// Closes a workspace through the row's own menu, the way a person does.
const closeWorkspace = async (tab) => {
  await tab.click({ button: 'right' });
  await tab.page().getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
};

// The name each workspace row shows.
const names = (page) => tabs(page).locator('.name');

// Waits until the workspace rows show these names, in this order.
const settled = (page, expected) => until(async () => (await names(page).allTextContents()).join() === expected.join());

// Types a line into the pane in front until the screen shows what it printed: a pane drops input until it attaches.
const runUntilShown = (page, line, text) => until(async () => (await screen(page)).includes(text), { act: () => run(page, line) });

/** Opens a local workspace, and waits for the shell its pane draws a moment after the workspace appears. */
const createWorkspace = async (page) => {
  await openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await until(async () => /\S/.test(await screen(page)));
};

module.exports = { lists, pluginDirectory, openWorkspaceMenu, ACTIVE_TERMINAL, activeTerminal, run, createWorkspace, openView, screen, paneErrors, openWorkspaces, storedConfig, storedWorkspace, tabs, closeWorkspace, names, settled, runUntilShown };
