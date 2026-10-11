const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname, basename } = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { promisify } = require('node:util');

const compiled = join(__dirname, '../tests/dist/images.cjs');
require('esbuild').buildSync({ entryPoints: [join(__dirname, '../images.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'cjs' });
const { registerImages } = require(compiled);
const exec = promisify(execFile);

function machine(home) {
  const calls = [];
  const node = {
    subprocess: {
      async exec(program, args, options) {
        calls.push({ program, args });
        try {
          const result = await exec(program, args, { cwd: options.cwd, env: { ...process.env, HOME: home }, encoding: 'buffer' });
          return { ...result, code: 0 };
        } catch (error) {
          return { stdout: error.stdout, stderr: error.stderr, code: error.code };
        }
      },
    },
    fs: {
      async readDirectory(path) {
        return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      },
    },
  };
  return { machine: { id: home, name: home }, node, calls };
}

function cache(hosts, maxCount) {
  let request;
  const dispose = registerImages({ ui: { handle(method, handler) { assert.equal(method, 'image'); request = handler; return () => { request = undefined; }; } } }, (sessionId) => hosts[sessionId], maxCount);
  return { paste: (sessionId, bytes, type = 'image/png') => request({ sessionId, dataUrl: `data:${type};base64,${bytes.toString('base64')}` }), request: (params) => request(params), dispose };
}

test('images are cached on the session machine, transferred in chunks and rotated across workspaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wangcai-images-'));
  try {
    const remote = machine(join(root, "remote home's $name"));
    const local = machine(join(root, 'local'));
    const directory = join(remote.machine.id, '.cache/WangCai-terminal-agent/images');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'unmanaged.png'), 'keep');
    mkdirSync(join(directory, 'image-100-aaaa.png'));
    const store = cache({ a: remote, b: remote, local }, 2);
    const large = randomBytes(180_001);
    const first = await store.paste('a', large);
    assert.equal(dirname(first), directory);
    assert.deepEqual(readFileSync(first), large);
    assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.ok(remote.calls.filter((call) => call.args[1].includes('base64 -d')).length > 1);
    assert.ok(remote.calls.every((call) => call.args.every((arg) => arg.length < 128 * 1024)));
    const second = await store.paste('b', Buffer.from('second'), 'image/jpeg');
    assert.equal(second.endsWith('.jpg'), true);
    const third = await store.paste('a', Buffer.from('third'));
    assert.deepEqual(readdirSync(directory).sort(), [basename(second), basename(third), 'image-100-aaaa.png', 'unmanaged.png'].sort());
    assert.deepEqual(readFileSync(second), Buffer.from('second'));
    const localPath = await store.paste('local', Buffer.from('local'));
    assert.equal(dirname(localPath), join(local.machine.id, '.cache/WangCai-terminal-agent/images'));
    assert.deepEqual(readFileSync(third), Buffer.from('third'));
    const restarted = cache({ a: remote }, 1);
    const fourth = await restarted.paste('a', Buffer.from('fourth'));
    assert.deepEqual(readdirSync(directory).sort(), [basename(fourth), 'image-100-aaaa.png', 'unmanaged.png'].sort());
    store.dispose();
    restarted.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent image pastes are serialized per machine and a failed transfer leaves no partial image', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-images-'));
  try {
    const host = machine(home);
    const store = cache({ a: host, b: host }, 2);
    const paths = await Promise.all(['one', 'two', 'three'].map((text, index) => store.paste(index % 2 ? 'b' : 'a', Buffer.from(text))));
    const directory = dirname(paths[0]);
    assert.deepEqual(readdirSync(directory).sort(), paths.slice(1).map((path) => basename(path)).sort());
    const originalExec = host.node.subprocess.exec;
    let fail = true;
    host.node.subprocess.exec = async (program, args, options) => {
      if (fail && args[1].includes('base64 -d')) { fail = false; return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('transfer failed') }; }
      return originalExec(program, args, options);
    };
    const broken = store.paste('a', Buffer.from('broken'));
    const recovered = store.paste('b', Buffer.from('recovered'));
    await assert.rejects(broken, /transfer failed/);
    const path = await recovered;
    assert.deepEqual(readFileSync(path), Buffer.from('recovered'));
    assert.deepEqual(readdirSync(directory).sort(), [paths[2], path].map((file) => basename(file)).sort());
    store.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('invalid clipboard payloads, disconnected sessions and invalid rotation limits are rejected before writing', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => registerImages({}, () => undefined, count), /positive integer/);
  const host = machine('/unused');
  const store = cache({ connected: host }, 2);
  assert.throws(() => store.paste('missing', Buffer.from('image')), /not connected/);
  for (const dataUrl of ['data:text/plain;base64,YQ==', 'data:image/png;base64,', 'data:image/png;base64,***=', 'data:image/png;base64,YQ=']) {
    assert.throws(() => store.request({ sessionId: 'connected', dataUrl }), /Invalid clipboard image/);
  }
  assert.throws(() => store.paste('connected', Buffer.alloc(16 * 1024 * 1024 + 1)), /exceeds 16 MiB/);
  assert.equal(host.calls.length, 0);
  store.dispose();
});

test('a relative machine home is rejected before creating the cache directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-images-'));
  try {
    const host = machine(home.slice(1));
    const store = cache({ connected: host }, 2);
    await assert.rejects(store.paste('connected', Buffer.from('image')), /Machine home must be an absolute path/);
    assert.deepEqual(readdirSync(home), []);
    assert.equal(host.calls.length, 1);
    store.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
