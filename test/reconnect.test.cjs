const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, run, testEnv, waitForShell, wangcaiApp, writeInit } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

test('a workspace terminal attaches again when the socket to the node drops', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-terminal-agent-')));
  const env = testEnv(home);
  let desktop;
  let page;
  try {
    writeInit(home);
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await waitForShell(page);
    // A slept laptop takes the pane's own socket with it while the machine itself stays connected, so the
    // test holds the sockets the pane opens and closes the one it is reading from.
    await page.evaluate(() => {
      const Native = window.WebSocket;
      window.__sockets = [];
      window.WebSocket = class extends Native {
        constructor(url) { super(url); window.__sockets.push(this); }
      };
    });
    await createWorkspace(page);
    const printed = () => page.evaluate(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '');
    // The pane drops input until it has attached, so the command is run until the screen shows it.
    const until = async (line, text) => {
      for (let attempt = 0; attempt < 30 && !(await printed()).includes(text); attempt++) {
        await run(page, line);
        await page.waitForTimeout(200);
      }
      assert.ok((await printed()).includes(text), `the shell never answered: ${line}`);
    };
    await until("printf 'BEFORE_DROP_%s\\n' ok", 'BEFORE_DROP_ok');
    assert.equal(await page.evaluate(() => window.__sockets.length), 1, 'the pane reads from a socket of its own');
    await page.evaluate(() => window.__sockets.at(-1).close());
    await page.waitForFunction(() => window.__sockets.length === 2);
    await until("printf 'AFTER_DROP_%s\\n' ok", 'AFTER_DROP_ok');
    assert.equal(await page.locator('.terminal-pane.active .terminal-message.error').count(), 0, 'a recovered pane says nothing about the drop');
  } finally {
    await desktop?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});