const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace, until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lists, paneErrors, runUntilShown } = require('./terminal-agent-ui.cjs');

test('a workspace terminal attaches again when the socket to the node drops', { timeout: 180000 }, () => withWindow('wangcai-terminal-agent-socket', lists, async ({ page }) => {
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
  await runUntilShown(page, "printf 'BEFORE_DROP_%s\\n' ok", 'BEFORE_DROP_ok');
  assert.equal(await page.evaluate(() => window.__sockets.length), 1, 'the pane reads from a socket of its own');
  await page.evaluate(() => window.__sockets.at(-1).close());
  await until(() => page.evaluate(() => window.__sockets.length === 2));
  await runUntilShown(page, "printf 'AFTER_DROP_%s\\n' ok", 'AFTER_DROP_ok');
  assert.equal(await paneErrors(page), 0, 'a recovered pane says nothing about the drop');
}));
