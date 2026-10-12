const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, run, testEnv, waitForShell, wangcaiApp, writeInit } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

test('a workspace named by hand keeps that name, and an empty one follows the directory again', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-rename-')));
  const env = testEnv(home);
  const beta = join(home, 'beta');
  const stored = () => JSON.parse(readFileSync(join(home, '.local/share/wangcai/data/terminal-agent/config.json'), 'utf8')).workspaces[0];
  let desktop;
  let page;
  const NAMES = '[aria-label="工作区"] [role=tab] .name';
  const settled = (expected) => page.waitForFunction(([selector, want]) => [...document.querySelectorAll(selector)].map((node) => node.textContent).join() === want, [NAMES, expected.join()]);
  const open = async () => {
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await waitForShell(page);
  };
  const rename = async (name) => {
    await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名工作区' });
    const input = dialog.getByRole('textbox');
    await dialog.waitFor();
    assert.equal(await input.inputValue(), await page.locator(NAMES).first().textContent(), 'the dialog opens on the name the row shows');
    await input.fill(name);
    await input.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
  };
  try {
    writeInit(home);
    for (const name of ['alpha', 'beta']) mkdirSync(join(home, name));
    await open();
    await createWorkspace(page);
    await settled(['~']);
    await run(page, 'cd alpha');
    await settled(['alpha']);
    await rename('手写的名字');
    await settled(['手写的名字']);
    assert.equal(stored().name, '手写的名字');
    // The directory is polled from the shell, so this waits for the follower rather than the cd.
    await run(page, 'cd ../beta');
    for (let attempt = 0; attempt < 100 && stored().cwd !== beta; attempt++) await page.waitForTimeout(100);
    assert.equal(stored().cwd, beta, 'the workspace keeps up with its shell');
    assert.equal(stored().name, '手写的名字', 'a name written by hand stays');
    await settled(['手写的名字']);
    await desktop.close(); desktop = undefined;
    await open();
    await settled(['手写的名字']);
    await rename('');
    await settled(['beta']);
    assert.equal(stored().name, 'beta', 'an empty name follows the directory again');
  } finally {
    await desktop?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});