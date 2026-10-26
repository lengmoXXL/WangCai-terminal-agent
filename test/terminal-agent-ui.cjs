const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { activeTerminal, ACTIVE_TERMINAL, run, until } = require('@lengmoxxl/wangcai-testkit');

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

module.exports = { lists, pluginDirectory, screen, paneErrors, openWorkspaces, storedConfig, storedWorkspace, tabs, closeWorkspace, names, settled, runUntilShown };
