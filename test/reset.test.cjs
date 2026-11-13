const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');

// The leak is in xterm's common core, which runs without a DOM. The test script passes
// --expose-gc so a WeakRef can prove the old buffer is released, not just unlinked from the
// service: xterm 6.0.0 reset() keeps every OSC 8 marker, and a marker holds its whole buffer.
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
const linkLine = (i) => `\x1b]8;;https://example.com/${i}\x1b\\file-${i}.ts:12\x1b]8;;\x1b\\\r\n`;
const fill = (term, n) => write(term, Array.from({ length: n }, (_, i) => linkLine(i)).join(''));
const entries = (term) => term._core._oscLinkService._dataByLinkId.size;
const weakBuffer = (term) => new WeakRef(term._core._bufferService.buffer);
const collect = async () => { await new Promise(resolve => setTimeout(resolve, 0)); global.gc(); global.gc(); };
const options = { cols: 80, rows: 24, scrollback: 1000, linkHandler: { activate() {} } };

test('reset releases OSC 8 links and the old buffer', async () => {
  const { resetTerminal } = await import('../reset.ts');
  const term = new Terminal(options);
  await fill(term, 1200);
  assert.ok(entries(term) > 0);
  const old = weakBuffer(term);
  resetTerminal(term);
  assert.equal(entries(term), 0);
  await collect();
  assert.ok(old.deref() === undefined, 'the old buffer survived reset and gc');
  // The link service still works for what the next snapshot prints.
  await fill(term, 1);
  assert.equal(entries(term), 1);
  term.dispose();
});

test('reset releases links on both buffers while a TUI holds the alt screen', async () => {
  const { resetTerminal } = await import('../reset.ts');
  const term = new Terminal(options);
  await fill(term, 100);
  await write(term, '\x1b[?1049h');
  await fill(term, 100);
  const buffers = term._core._bufferService.buffers;
  const normal = new WeakRef(buffers.normal);
  const alt = new WeakRef(buffers.alt);
  assert.ok(entries(term) > 0);
  resetTerminal(term);
  assert.equal(entries(term), 0);
  await collect();
  assert.ok(normal.deref() === undefined, 'the normal buffer survived reset and gc');
  assert.ok(alt.deref() === undefined, 'the alt buffer survived reset and gc');
  term.dispose();
});

// A control for the WeakRef check: without links, a plain reset already collects the buffer.
test('a reset without links collects the old buffer', async () => {
  const term = new Terminal({ ...options, linkHandler: undefined });
  await write(term, Array.from({ length: 1200 }, (_, i) => `plain line ${i}\r\n`).join(''));
  const old = weakBuffer(term);
  term.reset();
  await collect();
  assert.ok(old.deref() === undefined, 'the old buffer survived reset and gc');
  term.dispose();
});
