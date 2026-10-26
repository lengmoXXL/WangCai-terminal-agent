const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { ACTIVE_TERMINAL, createWorkspace, run, until, withHome } = require('@lengmoxxl/wangcai-testkit');
const { lists, runUntilShown } = require('./terminal-agent-ui.cjs');

const cell = (chars) => ({ getChars: () => chars, getWidth: () => 1 });

// A terminal holding one printed line, cut into the rows a terminal of so many columns shows. Enough
// of xterm's buffer for a link provider, and a resize that cuts the line again — the rows of the
// scrollback are what a resize rewraps, and a link has to follow them.
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
  const clicks = [];
  const handle = registerFileLinks(wrapped.term, {
    resolve: async (paths) => { looks++; return Object.fromEntries(paths.map((one) => [one, one])); },
    activate: (one) => clicks.push(one),
  });
  for (const row of [1, 2, 3]) {
    const found = await wrapped.links(row);
    assert.deepEqual(found.map((one) => one.text), [link], `row ${row} of the wrapped path is a link`);
  }
  assert.equal(looks, 1, 'the wrapped line is looked at once, however many rows it covers');
  // The click opens the path once it holds Command: on its own it opens nothing.
  const [first] = await wrapped.links(2);
  first.activate({ metaKey: false });
  assert.deepEqual(clicks, []);
  first.activate({ metaKey: true });
  assert.deepEqual(clicks, [path]);

  assert.deepEqual(first.decorations, { underline: false, pointerCursor: false }, 'a link waits for Command');
  first.hover();
  handle.setCommand(true);
  assert.deepEqual(first.decorations, { underline: true, pointerCursor: true }, 'the key shows the link under the pointer');
  assert.deepEqual((await wrapped.links(2))[0].decorations, { underline: true, pointerCursor: true }, 'and a line read while it is held');
  handle.setCommand(false);
  assert.deepEqual(first.decorations, { underline: false, pointerCursor: false }, 'releasing it hides the link again');

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

// What the terminal shows: every row, and the part of it a hover left a link on.
const drawn = (page) => page.evaluate((selector) => {
  const rows = [...document.querySelectorAll(`${selector} .xterm-rows > div`)];
  return {
    rows: rows.map((row) => row.textContent),
    links: rows.map((row) => [...row.querySelectorAll('span')].filter((span) => span.style.textDecoration === 'underline').map((span) => span.textContent).join('')),
  };
}, ACTIVE_TERMINAL);

// Which rows carry a link now.
const linked = async (page) => (await drawn(page)).links.map((text, row) => (text ? row : -1)).filter((row) => row >= 0);

// Every row of a block, top to bottom.
const covers = ({ first, last }) => Array.from({ length: last - first + 1 }, (_, at) => first + at);

// The rows a printed line covers, which are the rows that say it between them.
const printedBlock = async (page, text) => {
  const { rows } = await drawn(page);
  const last = rows.findLastIndex((row) => row.includes(text.slice(-16)));
  assert.notEqual(last, -1, `no row holds the end of ${text}: ${JSON.stringify(rows)}`);
  let first = last;
  while (first > 0 && rows[first - 1] && text.includes(rows[first - 1])) first--;
  assert.equal(rows.slice(first, last + 1).join(''), text, `the rows of ${text} do not say it together`);
  return { first, last };
};

// The point one character of a row sits at, which is where a pointer goes to touch that cell.
const point = (page, row, at) => page.evaluate(([selector, row, at]) => {
  const element = document.querySelectorAll(`${selector} .xterm-rows > div`)[row];
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
}, [ACTIVE_TERMINAL, row, at]);

// Puts the pointer on one character of a row, after leaving the terminal so the line is read again. A link does not
// always mark the screen, so this waits the look out rather than for a mark to appear.
const hover = async (page, row, at) => {
  const [x, y] = await point(page, row, at);
  await page.mouse.move(0, 0);
  await page.mouse.move(x, y);
  await page.waitForTimeout(500);
};

// Waits until every one of these rows shows a link, hovering what `act` names on each round.
const revealed = (page, rows, act) => until(async () => {
  const { links } = await drawn(page);
  return rows.every((at) => links[at]);
}, { act });

test('a path the terminal wrapped is one link on every row it covers, and the wrap follows a resize', { timeout: 180000 }, () => withHome('wangcai-links', lists, async ({ home, open }) => {
  const { desktop, page } = await open();
  // A path no terminal is wide enough to hold on one row.
  const directory = join(home, ...Array.from({ length: 8 }, (_, at) => `directory-named-${at}-for-wrapping`));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'linked-file.ts');
  writeFileSync(path, '');
  await createWorkspace(page);
  // The echo of a typed line would sit in the buffer beside the path, so it is printed with echo off.
  await run(page, 'stty -echo');
  await runUntilShown(page, `clear; printf '%s\\n' '${path}'`, 'linked-file.ts');

  const wrapped = await printedBlock(page, path);
  assert.ok(wrapped.last > wrapped.first, 'the printed path wraps');
  // The pointer finds the path as a link on every row the wrap put it on.
  for (const row of covers(wrapped)) await hover(page, row, 1);
  assert.deepEqual(await linked(page), [], 'the path stays text while Command is not held');
  await page.keyboard.down('Meta');
  await revealed(page, covers(wrapped));
  assert.deepEqual(await linked(page), covers(wrapped), 'Command reveals the link on every row of the path');
  assert.equal((await drawn(page)).links.join(''), path, 'the link is the whole path');

  // A resize rewraps the buffer: the link has to cover the rows the path has now, not the old ones.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 800));
  await until(async () => (await drawn(page)).rows.filter((row) => row && path.includes(row)).length !== covers(wrapped).length);
  const rewrapped = await printedBlock(page, path);
  assert.notEqual(covers(rewrapped).length, covers(wrapped).length, 'the resize changes how the path wraps');
  await revealed(page, covers(rewrapped), async () => {
    for (const row of covers(rewrapped)) await hover(page, row, 1);
  });
  assert.deepEqual(await linked(page), covers(rewrapped), 'the resize links the rows the path wraps now');
  assert.equal((await drawn(page)).links.join(''), path, 'after the resize the link is the path and nothing else');
  await page.keyboard.up('Meta');
}));

test('a printed web address is a link on every row it covers, and the app opens it', { timeout: 180000 }, () => withHome('wangcai-links-address', lists, async ({ open }) => {
  const { desktop, page } = await open();
  // An address longer than any terminal is wide, so it prints across a wrap.
  const address = `https://example.com/${'a-very-long-address-segment/'.repeat(7)}page.html`;
  // The window hands a link to the system browser: the test takes that call instead.
  await desktop.evaluate(({ shell }) => { shell.openExternal = async (url) => { globalThis.opened = url; }; });
  await createWorkspace(page);
  await run(page, 'stty -echo');
  await runUntilShown(page, `clear; printf '%s\\n' '${address}'`, address.slice(-12));

  const wrapped = await printedBlock(page, address);
  assert.ok(wrapped.last > wrapped.first, 'the printed address wraps');

  // The pointer finds the address as a link on every row the wrap put it on.
  for (const row of covers(wrapped)) await hover(page, row, 1);
  await revealed(page, covers(wrapped));
  assert.deepEqual(await linked(page), covers(wrapped), 'the address is one link on every row it covers');
  assert.equal((await drawn(page)).links.join(''), address, 'the link is the whole address');

  // The click that holds Command is what opens the address.
  const [x, y] = await point(page, wrapped.first, 1);
  await page.keyboard.down('Meta');
  await page.mouse.click(x, y);
  let opened;
  await until(async () => (opened = await desktop.evaluate(() => globalThis.opened)) !== undefined);
  assert.equal(opened, address, 'the app is handed the address');

  await page.keyboard.up('Meta');
  await desktop.evaluate(() => { globalThis.opened = undefined; });
  await page.mouse.click(x, y);
  // The click reaches the app either way; what this gives it is the time to have taken it and opened nothing, which is
  // the only way a refusal can show.
  await page.waitForTimeout(500);
  assert.equal(await desktop.evaluate(() => globalThis.opened), undefined, 'a click that holds no Command opens nothing');
}));
