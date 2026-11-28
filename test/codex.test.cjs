const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withHome, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lists, openWorkspaceMenu, pluginDirectory, storedWorkspace, tabs } = require('./terminal-agent-ui.cjs');

test('a codex workspace asks for its remote directory before it starts', { timeout: 180000 }, () => withHome('wangcai-codex', {}, async ({ home, open }) => {
  const init = join(home, '.config/wangcai/init.ts');
  writeFileSync(init, `
    export default {
      workspaces: [
        { id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { codex: { enabled: true }, machines: [{ name: '测试服务器', host: 'wangcai-test.invalid' }] } },
      ],
      tabs: [],
    };
  `);
  const { page, close } = await open();
  await openWorkspaceMenu(page);
  const menu = page.locator('#workspace-row-menu');
  await menu.getByRole('menuitem', { name: '新建 codex + 测试服务器' }).click();
  const prompt = page.locator('.codex-prompt');
  await prompt.waitFor();
  assert.equal(await prompt.locator('input').inputValue(), '~/');
  // The workspace is kept as a codex one on the remote machine, with no terminal yet.
  await until(() => storedWorkspace(home).type === 'codex');
  assert.equal(storedWorkspace(home).machineId, 'wangcai-test.invalid');
  assert.equal(storedWorkspace(home).sessionId, undefined);
  await tabs(page).filter({ hasText: 'codex + 测试服务器' }).waitFor();
  // The machine cannot be reached, so the answer is refused in place and the directory stays unanswered.
  await prompt.locator('input').fill('~/project');
  await page.keyboard.press('Enter');
  await prompt.locator('.codex-prompt-error').waitFor();
  assert.equal(storedWorkspace(home).cwd, undefined);
  await close();
}));

test('a local codex workspace completes directories from the local home', { timeout: 180000 }, () => withHome('wangcai-codex-local', {}, async ({ home, open }) => {
  mkdirSync(join(home, 'project', 'sub'), { recursive: true });
  const init = join(home, '.config/wangcai/init.ts');
  writeFileSync(init, `
    export default {
      workspaces: [
        { id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { codex: { enabled: true } } },
      ],
      tabs: [],
    };
  `);
  const { page, close } = await open();
  await openWorkspaceMenu(page);
  const menu = page.locator('#workspace-row-menu');
  await menu.getByRole('menuitem', { name: '新建 codex + 本机' }).click();
  const prompt = page.locator('.codex-prompt');
  await prompt.waitFor();
  assert.equal(await prompt.locator('input').inputValue(), '~/');
  // Tab completes the single directory under home that matches the typed prefix.
  await prompt.locator('input').fill('~/pro');
  await prompt.locator('.codex-prompt-list button', { hasText: 'project/' }).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await prompt.locator('input').inputValue(), '~/project/');
  // A relative path is read against home as well.
  await prompt.locator('input').fill('project/');
  await prompt.locator('.codex-prompt-list button', { hasText: 'sub/' }).waitFor();
  await close();
}));

test('a codex workspace opens its directory through a custom codex command', { timeout: 180000 }, () => withHome('wangcai-codex-custom', {}, async ({ home, open }) => {
  mkdirSync(join(home, 'project'), { recursive: true });
  // A stand-in for codex: the daemon call answers with a socket, the TUI call just stays up.
  const mock = join(home, 'fake-codex');
  writeFileSync(mock, '#!/bin/bash\nif [ "$1" = "app-server" ]; then printf \'{"socketPath":"/tmp/wangcai-fake-codex.sock"}\'; else sleep 30; fi\n');
  chmodSync(mock, 0o755);
  const init = join(home, '.config/wangcai/init.ts');
  writeFileSync(init, `
    export default {
      workspaces: [
        { id: 'terminal-agent', directory: ${JSON.stringify(pluginDirectory('terminal-agent'))}, config: { codex: { enabled: true, command: ${JSON.stringify(mock)}, remoteCommand: ${JSON.stringify(mock)} } } },
      ],
      tabs: [],
    };
  `);
  const { page, close } = await open();
  await openWorkspaceMenu(page);
  const menu = page.locator('#workspace-row-menu');
  await menu.getByRole('menuitem', { name: '新建 codex + 本机' }).click();
  const prompt = page.locator('.codex-prompt');
  await prompt.waitFor();
  await prompt.locator('input').fill('~/project');
  await page.keyboard.press('Enter');
  await until(() => storedWorkspace(home).cwd === join(home, 'project'));
  await close();
}));

test('without codex enabled the menu offers no codex entries', { timeout: 180000 }, () => withWindow('wangcai-codex-off', lists, async ({ page }) => {
  await openWorkspaceMenu(page);
  const menu = page.locator('#workspace-row-menu');
  await menu.getByRole('menuitem', { name: '新建 本机' }).waitFor();
  assert.equal(await menu.getByRole('menuitem').filter({ hasText: 'codex' }).count(), 0);
}));