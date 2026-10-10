const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspace, launchApp, run, testEnv, waitForShell, wangcaiApp, writeInit } = require('./harness.cjs');

/** The checkout next to this repository, which these tests drive. */
const app = wangcaiApp();

const cell = (chars) => ({ getChars: () => chars, getWidth: () => 1 });

/**
 * A terminal holding one printed line, cut into the rows a terminal of so many columns shows. Enough
 * of xterm's buffer for a link provider, and a resize that cuts the line again — the rows of the
 * scrollback are what a resize rewraps, and a link has to follow them.
 */
function lineBuffer(text, cols) {
  const lines = [];
  const cut = (width) => {
    lines.length = 0;
    for (let at = 0; at < text.length; at += width) lines.push({ text: text.slice(at, at + width), wrapped: at > 0, cells: [...text.slice(at, at + width)].map(cell) });
  };
  cut(cols);
  const term = {
    cols,
    options: {},
    providers: [],
    buffer: {
      active: {
        getLine: (at) => lines[at] && {
          isWrapped: lines[at].wrapped,
          length: lines[at].cells.length,
          translateToString: (trim) => (trim ? lines[at].text.trimEnd() : lines[at].text),
          getCell: (x, into) => Object.assign(into, lines[at].cells[x]),
        },
        getNullCell: () => cell(' '),
      },
    },
    registerLinkProvider(provider) { this.providers.push(provider); return { dispose() {} }; },
  };
  return {
    term,
    links: (row) => new Promise((resolve) => term.providers.at(-1).provideLinks(row, (found) => resolve(found ?? []))),
    resize: (width) => { cut(width); term.cols = width; },
  };
}

test('a wrapped path is one line to the links, and a rewrap while a look is out is read off the rows it has now', async () => {
  const { registerFileLinks } = await import('../file-links/links.ts');
  const path = '/home/user/projects/deep/inside/tree/file.ts';
  const printed = `open ${path}:12:3 here`;
  const link = `${path}:12:3`;

  const wrapped = lineBuffer(printed, 24);
  let looks = 0;
  registerFileLinks(wrapped.term, {
    resolve: async (paths) => { looks++; return Object.fromEntries(paths.map((one) => [one, one])); },
    activate: () => {},
  });
  for (const row of [1, 2, 3]) {
    const found = await wrapped.links(row);
    assert.deepEqual(found.map((one) => one.text), [link], `row ${row} of the wrapped path is a link`);
  }
  assert.equal(looks, 1, 'the wrapped line is looked at once, however many rows it covers');

  // The look is answered a resize late, which is what a slow machine makes of the same line.
  const second = lineBuffer(printed, 24);
  let release;
  registerFileLinks(second.term, { resolve: () => new Promise((resolve) => { release = resolve; }), activate: () => {} });
  const answered = second.links(2);
  second.resize(16);
  release({ [path]: path });
  const found = await answered;
  const at = printed.indexOf(link);
  // Where a character of the printed line lands once the rows are cut at 16 columns.
  const cellOf = (character) => ({ x: (character % 16) + 1, y: Math.floor(character / 16) + 1 });
  assert.deepEqual(found.map((one) => one.text), [link], 'the line is still a link once the rows have been cut again');
  assert.deepEqual(found[0].range, { start: cellOf(at), end: cellOf(at + link.length - 1) }, 'the link covers the rows the path has now');
});

/** What the terminal shows: every row, and the part of it a hover left a link on. */
const screen = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')];
  return {
    rows: rows.map((row) => row.textContent),
    links: rows.map((row) => [...row.querySelectorAll('span')].filter((span) => span.style.textDecoration === 'underline').map((span) => span.textContent).join('')),
  };
});

/** Which rows carry a link now. */
const linked = async (page) => (await screen(page)).links.map((text, row) => (text ? row : -1)).filter((row) => row >= 0);

/** Every row of a block, top to bottom. */
const covers = ({ first, last }) => Array.from({ length: last - first + 1 }, (_, at) => first + at);

/** The rows a printed line covers, which are the rows that say it between them. */
async function printedBlock(page, text) {
  const { rows } = await screen(page);
  const last = rows.findLastIndex((row) => row.includes(text.slice(-16)));
  assert.notEqual(last, -1, `no row holds the end of ${text}: ${JSON.stringify(rows)}`);
  let first = last;
  while (first > 0 && rows[first - 1] && text.includes(rows[first - 1])) first--;
  assert.equal(rows.slice(first, last + 1).join(''), text, `the rows of ${text} do not say it together`);
  return { first, last };
}

/** The point one character of a row sits at, which is where a pointer goes to touch that cell. */
const point = (page, row, at) => page.evaluate(([row, at]) => {
  const element = document.querySelectorAll('.terminal-pane.active .xterm-rows > div')[row];
  let skip = at;
  for (const span of element.querySelectorAll('span')) {
    if (skip >= span.firstChild.length) { skip -= span.firstChild.length; continue; }
    const range = document.createRange();
    range.setStart(span.firstChild, skip);
    range.setEnd(span.firstChild, skip + 1);
    const rect = range.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  }
  throw new Error(`row ${row} is shorter than ${at + 1} characters`);
}, [row, at]);

/** Puts the pointer on one character of a row, after leaving the terminal so the line is read again. */
async function hover(page, row, at) {
  const [x, y] = await point(page, row, at);
  await page.mouse.move(0, 0);
  await page.mouse.move(x, y);
  await page.waitForFunction(() => [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div span')].some((span) => span.style.textDecoration === 'underline'));
}

test('a path the terminal wrapped is one link on every row it covers, and the wrap follows a resize', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-links-')));
  const env = testEnv(home);
  let desktop;
  try {
    // A path no terminal is wide enough to hold on one row.
    const directory = join(home, ...Array.from({ length: 8 }, (_, at) => `directory-named-${at}-for-wrapping`));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'linked-file.ts');
    writeFileSync(path, '');
    writeInit(home);
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    page.on('pageerror', (error) => console.error('UI error:', error));
    await waitForShell(page);
    await createWorkspace(page);
    // The echo of a typed line would sit in the buffer beside the path, so it is printed with echo off.
    await run(page, 'stty -echo');
    await run(page, `clear; printf '%s\\n' '${path}'`);
    await page.waitForFunction((name) => document.querySelector('.terminal-pane.active .xterm-rows').textContent.includes(name), 'linked-file.ts');

    const wrapped = await printedBlock(page, path);
    assert.ok(wrapped.last > wrapped.first, 'the printed path wraps');
    for (const row of covers(wrapped)) {
      await hover(page, row, 1);
      assert.deepEqual(await linked(page), covers(wrapped), `hovering row ${row} links every row of the path`);
      assert.equal((await screen(page)).links.join(''), path, `hovering row ${row} links the path and nothing else`);
    }

    // A resize rewraps the buffer: the link has to cover the rows the path has now, not the old ones.
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 800));
    await page.waitForFunction(([path, rows]) => [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].filter((row) => row.textContent && path.includes(row.textContent)).length !== rows, [path, covers(wrapped).length]);
    const rewrapped = await printedBlock(page, path);
    assert.notEqual(covers(rewrapped).length, covers(wrapped).length, 'the resize changes how the path wraps');
    for (const row of covers(rewrapped)) {
      await hover(page, row, 1);
      assert.deepEqual(await linked(page), covers(rewrapped), `hovering row ${row} after the resize links the rows the path has now`);
      assert.equal((await screen(page)).links.join(''), path, `hovering row ${row} after the resize links the path and nothing else`);
    }
  } finally {
    await desktop?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('a printed web address is a link on every row it covers, and the app opens it', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-links-')));
  const env = testEnv(home);
  let desktop;
  try {
    // An address longer than any terminal is wide, so it prints across a wrap.
    const address = `https://example.com/${'a-very-long-address-segment/'.repeat(7)}page.html`;
    writeInit(home);
    desktop = await launchApp(home, env);
    // The window hands a link to the system browser: the test takes that call instead.
    await desktop.evaluate(({ ipcMain }) => { ipcMain.removeHandler('wangcai:open'); ipcMain.handle('wangcai:open', (_event, url) => { globalThis.opened = url; }); });
    const page = await desktop.firstWindow();
    await waitForShell(page);
    await createWorkspace(page);
    await run(page, 'stty -echo');
    await run(page, `clear; printf '%s\\n' '${address}'`);
    await page.waitForFunction((end) => document.querySelector('.terminal-pane.active .xterm-rows').textContent.includes(end), address.slice(-12));

    const wrapped = await printedBlock(page, address);
    assert.ok(wrapped.last > wrapped.first, 'the printed address wraps');
    // The pointer finds the address as a link on every row the wrap put it on.
    for (const row of covers(wrapped)) await hover(page, row, 1);
    assert.deepEqual(await linked(page), covers(wrapped), 'the address is one link on every row it covers');
    assert.equal((await screen(page)).links.join(''), address, 'the link is the whole address');

    const [x, y] = await point(page, wrapped.first, 1);
    await page.mouse.click(x, y);
    let opened;
    for (let attempt = 0; attempt < 50 && !opened; attempt++) {
      opened = await desktop.evaluate(() => globalThis.opened);
      if (!opened) await page.waitForTimeout(100);
    }
    assert.equal(opened, address, 'the app is handed the address');
  } finally {
    await desktop?.close();
    try { execFileSync(join(app, 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
