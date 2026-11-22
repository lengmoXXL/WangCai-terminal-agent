const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lists, createWorkspace, run, screen } = require('./terminal-agent-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

// This pane draws its glyphs as DOM rows, so the colours are read where they are computed. xterm writes its own
// background inline on the scrollable element; the rows over it are transparent and the viewport under it keeps
// xterm's own black, so neither is evidence of the theme the terminal was handed.
const painted = (page) => page.evaluate(() => {
  const pane = document.querySelector('.terminal-pane.active');
  const rows = pane.querySelector('.xterm-rows');
  const surface = pane.querySelector('.xterm-scrollable-element');
  const slider = surface.querySelector('.scrollbar.vertical .slider');
  const track = surface.querySelector('.scrollbar.vertical');
  return {
    text: getComputedStyle(rows).color,
    background: getComputedStyle(surface).backgroundColor,
    scheme: document.documentElement.style.colorScheme,
    // How much of the track the thumb covers: the deeper the scrollback, the shorter it is.
    thumb: slider ? parseFloat(slider.style.height) : 0,
    track: track ? parseFloat(getComputedStyle(track).height) : 0,
  };
});

const switchTo = async (page, name) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('u');
  await page.keyboard.press('t');
  await page.locator('.prompt-scrim:not([hidden])').waitFor();
  await page.locator('.prompt-list button', { hasText: name }).first().click();
  await page.locator('.prompt-scrim').waitFor({ state: 'hidden' });
};

test('a switch of theme recolours the running terminal without building it again', { timeout: 180000 }, () => withWindow('wangcai-agent-theme', lists, async ({ page, errors }) => {
  await createWorkspace(page);
  // More output than the screen holds. A terminal built again is handed the pty's snapshot, which carries the visible
  // screen only, so the scrollback above it is what a rebuild cannot bring back.
  await run(page, 'seq 1 300');
  await until(async () => (await screen(page)).includes('300'));
  const dark = await painted(page);
  assert.equal(dark.scheme, 'dark');
  assert.equal(dark.background, 'rgb(25, 26, 27)', 'the terminal is painted in the dark background');
  assert.ok(dark.thumb > 0 && dark.thumb < dark.track, `the output filled a scrollback: thumb ${dark.thumb} of ${dark.track}`);

  await switchTo(page, 'GitHub');
  await until(async () => (await painted(page)).scheme === 'light');
  const light = await painted(page);
  assert.equal(light.text, 'rgb(31, 35, 40)', 'the glyphs are drawn in GitHub foreground');
  assert.equal(light.background, 'rgb(255, 255, 255)', 'and the terminal itself in GitHub background');
  assert.equal(light.thumb, dark.thumb, 'the scrollback is as deep as it was, so the terminal was never built again');

  await switchTo(page, 'WangCai');
  await until(async () => (await painted(page)).scheme === 'dark');
  const back = await painted(page);
  assert.equal(back.text, dark.text, 'switching back restores the colours');
  assert.equal(back.background, dark.background);
  assert.equal(back.thumb, dark.thumb);
  assert.deepEqual(errors, []);
}));
