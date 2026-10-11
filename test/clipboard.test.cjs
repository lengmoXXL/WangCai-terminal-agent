const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync } = require('node:fs');
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
    const copied = () => desktop.evaluate(({ clipboard }, want) => clipboard.readText() === want, text);
    for (let attempt = 0; attempt < 50 && !await copied(); attempt++) await page.waitForTimeout(100);
    assert.ok(await copied(), 'the clipboard never took what the program copied');
  } finally {
    await desktop?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('pasting clipboard images writes a rotated cache and inserts its path into terminal-agent', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-image-clipboard-')));
  const env = testEnv(home);
  let desktop;
  try {
    writeInit(home, { workspaces: [{ id: 'terminal-agent', config: { images: { maxCount: 1 } } }], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await waitForShell(page);
    await createWorkspace(page);
    const directory = join(home, '.cache/WangCai-terminal-agent/images');
    let first;
    for (const [index, color] of [[1, [0, 0, 255, 255]], [2, [255, 0, 0, 255]]]) {
      await desktop.evaluate(({ clipboard, nativeImage }, color) => {
        const image = nativeImage.createFromBitmap(Buffer.from(color), { width: 1, height: 1 });
        clipboard.write({ text: 'IGNORE_CLIPBOARD_TEXT', image });
      }, color);
      await page.locator('.terminal-pane.active .xterm-helper-textarea').click();
      await page.keyboard.type(`printf 'IMAGE_${index}:%s\\n' `);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
      await page.waitForFunction((previous) => {
        const text = document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '';
        return [...text.matchAll(/image-\d+-[0-9a-f-]+\.png/g)].some(([name]) => name !== previous);
      }, first);
      const files = readdirSync(directory);
      assert.equal(files.length, 1);
      assert.notEqual(files[0], first);
      first = files[0];
      const path = join(directory, first);
      const bytes = readFileSync(path);
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      const pixels = await desktop.evaluate(({ nativeImage }, bytes) => [...nativeImage.createFromBuffer(Buffer.from(bytes)).toBitmap()], [...bytes]);
      assert.deepEqual(pixels, color);
      await page.waitForFunction((path) => (document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '').includes(path), path);
      await page.keyboard.press('Enter');
      await page.waitForFunction((output) => (document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '').includes(output), `IMAGE_${index}:${path}`);
    }
    await desktop.evaluate(({ clipboard }) => clipboard.writeText('TEXT_PASTE_UNCHANGED'));
    await page.keyboard.type("printf '%s\\n' ");
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '').includes('TEXT_PASTE_UNCHANGED'));
    assert.equal(readdirSync(directory).length, 1);
    assert.equal((await page.locator('.terminal-pane.active .xterm-rows').innerText()).includes('IGNORE_CLIPBOARD_TEXT'), false);
    assert.equal(await page.locator('.terminal-pane.active .terminal-message.error').count(), 0);
  } finally {
    await desktop?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
