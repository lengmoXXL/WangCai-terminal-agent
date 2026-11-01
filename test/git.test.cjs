const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createWorkspace, until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lists, tabs } = require('./terminal-agent-ui.cjs');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });

test('the row says what git makes of the workspace', { timeout: 180000 }, () => withWindow('wangcai-terminal-agent-git', lists, async ({ home, page }) => {
  // A repository whose branch is one commit ahead (not pushed) and one behind (not pulled), with a change in the tree. The
  // workspace's own directory is the repository, so its remote and the second clone live beside the home, not in it.
  const outside = mkdtempSync(join(tmpdir(), 'wangcai-git-'));
  try {
    const origin = join(outside, 'origin.git');
    git(home, 'init', '-q', '--bare', origin);
    git(home, 'init', '-q', '-b', 'main');
    // The home is also the app's, so what the app installs and writes is ignored: the tree then says only what this case does.
    writeFileSync(join(home, '.gitignore'), '.config/\n.local/\nelectron/\n');
    writeFileSync(join(home, 'a.txt'), 'a');
    git(home, 'add', '.gitignore', 'a.txt');
    git(home, 'commit', '-qm', 'one');
    git(home, 'remote', 'add', 'origin', origin);
    git(home, 'push', '-q', '-u', 'origin', 'main');
    writeFileSync(join(home, 'b.txt'), 'b');
    git(home, 'add', 'b.txt');
    git(home, 'commit', '-qm', 'two');
    const other = join(outside, 'other');
    git(home, 'clone', '-q', origin, other);
    writeFileSync(join(other, 'c.txt'), 'c');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'three');
    git(other, 'push', '-q', 'origin', 'main');
    git(home, 'fetch', '-q', 'origin');
    writeFileSync(join(home, 'dirty.txt'), 'dirty');
    await createWorkspace(page);
    const row = tabs(page).first();
    const cell = row.locator('.git');
    // The repository is asked about on a timer, and the row is patched where it stands.
    await until(async () => (await cell.textContent()) === '↓1↑1');
    assert.equal(await cell.getAttribute('title'), 'main · 1 个提交待拉取 · 1 个提交待推送 · 有未提交的修改');
    assert.equal(await row.locator('.changes').textContent(), '*', 'the change in the tree marks the name');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));
