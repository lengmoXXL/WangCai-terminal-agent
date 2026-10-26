const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { activeTerminal, createWorkspace, run, until, withHome } = require('@lengmoxxl/wangcai-testkit');
const { lists, paneErrors, screen } = require('./terminal-agent-ui.cjs');

test('what a program in the terminal copies reaches the system clipboard', { timeout: 180000 }, () => withHome('wangcai-clipboard', lists, async ({ open }) => {
  const { page } = await open();
  await createWorkspace(page);
  const text = 'OSC52_COPY_ME';
  // What a program copies with: an OSC 52 sequence, which the shell prints for it here.
  const sequence = `\\033]52;c;${Buffer.from(text).toString('base64')}\\007`;
  // The clipboard is the machine's, so it is told apart from what the same test copied before.
  await page.evaluate(() => navigator.clipboard.writeText('not copied yet'));
  await run(page, `printf '${sequence}'`);
  await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === text);
}));

test('pasting clipboard images writes a rotated cache and inserts its path into terminal-agent', { timeout: 180000 }, () => withHome('wangcai-image-clipboard', { workspaces: [{ id: 'terminal-agent', config: { images: { maxCount: 1 } } }], tabs: [] }, async ({ home, open }) => {
  const { desktop, page } = await open();
  await createWorkspace(page);
  const directory = join(home, '.cache/WangCai-terminal-agent/images');
  let previousName;
  for (const [index, color] of [[1, [0, 0, 255, 255]], [2, [255, 0, 0, 255]]]) {
    await desktop.evaluate(({ clipboard, nativeImage }, color) => {
      const image = nativeImage.createFromBitmap(Buffer.from(color), { width: 1, height: 1 });
      clipboard.write({ text: 'IGNORE_CLIPBOARD_TEXT', image });
    }, color);
    await activeTerminal(page).locator('.xterm-helper-textarea').click();
    await page.keyboard.type(`printf 'IMAGE_${index}:%s\\n' `);
    await page.keyboard.press('ControlOrMeta+v');
    await until(async () => [...(await screen(page)).matchAll(/image-\d+-[0-9a-f-]+\.png/g)].some(([name]) => name !== previousName));
    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    assert.notEqual(files[0], previousName);
    previousName = files[0];
    const path = join(directory, previousName);
    const bytes = readFileSync(path);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const pixels = await desktop.evaluate(({ nativeImage }, bytes) => [...nativeImage.createFromBuffer(Buffer.from(bytes)).toBitmap()], [...bytes]);
    assert.deepEqual(pixels, color);
    await until(async () => (await screen(page)).includes(path));
    await page.keyboard.press('Enter');
    await until(async () => (await screen(page)).includes(`IMAGE_${index}:${path}`));
  }
  await desktop.evaluate(({ clipboard }) => clipboard.writeText('TEXT_PASTE_UNCHANGED'));
  await page.keyboard.type("printf '%s\\n' ");
  await page.keyboard.press('ControlOrMeta+v');
  await page.keyboard.press('Enter');
  await until(async () => (await screen(page)).includes('TEXT_PASTE_UNCHANGED'));
  assert.equal(readdirSync(directory).length, 1);
  assert.ok(!(await screen(page)).includes('IGNORE_CLIPBOARD_TEXT'));
  assert.equal(await paneErrors(page), 0);
}));
