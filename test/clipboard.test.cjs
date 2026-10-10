const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, run, testEnv, waitForShell, wangcaiApp, writeInit } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

test('what a program in the terminal copies reaches the system clipboard', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-clipboard-')));
  const env = testEnv(home);
  let desktop;
  try {
    writeInit(home);
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await waitForShell(page);
    await createWorkspace(page);
    const text = 'OSC52_COPY_ME';
    // What a program copies with: an OSC 52 sequence, which the shell prints for it here.
    const sequence = `\\033]52;c;${Buffer.from(text).toString('base64')}\\007`;
    // The clipboard is the machine's, so it is told apart from what the same test copied before. The app's
    // own clipboard is read and written here: the window's needs focus, which a headless run cannot promise.
    await desktop.evaluate(({ clipboard }) => clipboard.writeText('not copied yet'));
    await run(page, `printf '${sequence}'`);
    // What the program copied shows up in the clipboard the window shares with the machine.
    const copied = () => desktop.evaluate(({ clipboard }, want) => clipboard.readText() === want, text);
    for (let attempt = 0; attempt < 50 && !await copied(); attempt++) await page.waitForTimeout(100);
    assert.ok(await copied(), 'the clipboard never took what the program copied');
  } finally {
    await desktop?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
