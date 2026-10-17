const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { transformSync } = require('esbuild');
const { createWorkspace, launchApp, run, testEnv, waitForShell, writeInit } = require('./harness.cjs');

/** The files this repository ships for the agents to load, which the plugin installs on a machine. */
const shipped = (name) => readFileSync(join(__dirname, '../integrations', name), 'utf8');

test('the agent integrations land on the machine, and what they report reaches the row', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-agent-state-')));
  const env = testEnv(home);
  const reportDirectory = join(home, '.local/share/wangcai/agent-state');
  let desktop;
  const launch = async () => {
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    page.on('pageerror', (error) => console.error('UI error:', error));
    await waitForShell(page);
    return page;
  };
  try {
    mkdirSync(join(home, '.pi/agent/extensions'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    // Files another tool already wrote its own entries into: installing must merge, not replace.
    const foreign = '/bin/sh /Users/nobody/orca-codex-hook.sh';
    writeFileSync(join(home, '.codex/hooks.json'), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign, timeout: 10 }] }] } }, null, 2)}\n`);
    const foreignTrust = '[hooks.state."/Users/nobody/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:other"';
    writeFileSync(join(home, '.codex/config.toml'), `model = "gpt-5"\n\n${foreignTrust}\n`);
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    let page = await launch();
    await createWorkspace(page);
    const row = page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab').first();
    const badge = row.locator('.agent-state');
    const drawn = (index, state) => page.waitForFunction(([index, state]) => document.querySelectorAll('.workspace .agent-state')[index]?.dataset.state === state, [index, state]);
    assert.equal(await badge.getAttribute('data-state'), 'idle', 'a workspace whose agent has said nothing is idle');
    // This proves only that the variable reached the shell; the reports below are what put its path to work.
    await run(page, "printf 'ENV_%s\\n' \"${WANGCAI_AGENT_STATE:+set}\"");
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('ENV_set'));
    const id = await row.evaluate((element) => element.dataset.workspace);

    // What the machine is given: the file pi loads, the hook codex runs, and the entries that run it.
    const extensionPath = join(home, '.pi/agent/extensions/wangcai-agent-state.ts');
    const hookPath = join(home, '.codex/wangcai-agent-state.sh');
    assert.equal(readFileSync(extensionPath, 'utf8'), shipped('pi-agent-state.ts'), 'pi loads what this repository ships');
    assert.equal(readFileSync(hookPath, 'utf8'), shipped('codex-agent-state.sh'), 'codex runs what this repository ships');
    const hooksFile = join(home, '.codex/hooks.json');
    const storedHooks = readFileSync(hooksFile, 'utf8');
    const hooks = JSON.parse(storedHooks).hooks;
    const commands = (event) => hooks[event].map((group) => group.hooks[0].command);
    assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.deepEqual(commands('SessionStart'), [`/bin/sh '${hookPath}' clear`]);
    assert.deepEqual(commands('UserPromptSubmit'), [`/bin/sh '${hookPath}' working`]);
    assert.deepEqual(commands('Stop'), [foreign, `/bin/sh '${hookPath}' finished`], 'the entry another tool wrote is kept');
    // A machine that lost those files, or kept them from an older plugin, gets them back before a session reads them.
    writeFileSync(extensionPath, '// from an older plugin\n');
    writeFileSync(hookPath, 'echo stale\n');
    await createWorkspace(page);
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="工作区"] [role=tab]').length === 2);
    assert.equal(readFileSync(extensionPath, 'utf8'), shipped('pi-agent-state.ts'), 'a session brings the extension up to what this plugin ships');
    assert.equal(readFileSync(hookPath, 'utf8'), shipped('codex-agent-state.sh'), 'and the hook codex runs');

    // Codex runs a hook only once it has recorded trust for it, so the records are written with the entries.
    const configFile = join(home, '.codex/config.toml');
    const storedConfig = readFileSync(configFile, 'utf8');
    assert.ok(storedConfig.startsWith('model = "gpt-5"\n'), 'the rest of the config file stays as it was');
    assert.ok(storedConfig.includes(foreignTrust), 'a record another tool wrote stays as it was');
    // Each record names the place this plugin's entry sits in, which is after whatever another tool had there.
    for (const [label, at] of [['session_start', 0], ['user_prompt_submit', 0], ['stop', 1]]) {
      assert.ok(storedConfig.includes(`[hooks.state."${join(home, '.codex/hooks.json')}:${label}:${at}:0"]\ntrusted_hash = "sha256:`), `${label} is recorded as trusted where its entry sits`);
    }

    // Codex runs that hook with the session's own environment. The test names the same path the plugin's rules
    // produce, so a path the plugin did not watch would leave that row as it is.
    const report = (action) => execFileSync('/bin/sh', [hookPath, action], { env: { ...env, WANGCAI_AGENT_STATE: join(reportDirectory, id) }, input: JSON.stringify({ hook_event_name: action }) });
    report('working');
    await drawn(0, 'working');
    report('finished');
    await drawn(0, 'finished');
    // The click clears what the window drew, not what the machine wrote: the file still says finished, and the
    // row follows whatever that file names next.
    await badge.click();
    await drawn(0, 'idle');
    report('working');
    await drawn(0, 'working');
    // The file outlives the window: what the machine wrote is where the next window starts.
    await desktop.close(); desktop = undefined;
    page = await launch();
    await page.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab').first().waitFor();
    assert.equal(readFileSync(hooksFile, 'utf8'), storedHooks, 'a machine that is already set up is left as it was');
    assert.equal(readFileSync(configFile, 'utf8'), storedConfig, 'its trust is left as it already is');
    await drawn(0, 'working');
    // Cleared is no report at all, which is the row the app draws as idle.
    report('clear');
    await drawn(0, 'idle');
    assert.equal(existsSync(join(reportDirectory, id)), false, 'a cleared row leaves no report behind');
    // Closing the workspace takes the report its agent left on the machine with it.
    report('finished');
    await drawn(0, 'finished');
    await page.evaluate((id) => window.wangcai.request('terminal-agent', 'workspace-close', { id }), id);
    assert.equal(existsSync(join(reportDirectory, id)), false, 'a closed workspace leaves no report behind');
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the pi integration reports two states, and nothing at all for an idle row', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-pi-state-'));
  const statePath = join(home, 'agent-state', 'w1');
  // The plugin makes that directory when it hands a session the variable.
  mkdirSync(dirname(statePath), { recursive: true });
  /** The integration as pi loads it, with the handlers a test then fires. */
  const load = () => {
    process.env.WANGCAI_AGENT_STATE = statePath;
    const module = { exports: {} };
    const { code } = transformSync(shipped('pi-agent-state.ts'), { loader: 'ts', format: 'cjs' });
    new Function('exports', 'require', 'module', code)(module.exports, require, module);
    const handlers = {};
    module.exports.default({ on: (event, handler) => { (handlers[event] ??= []).push(handler); } });
    return (event, ctx) => handlers[event]?.forEach((handler) => handler({}, ctx));
  };
  const written = () => existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined;
  try {
    // A subagent is headless and shares this environment: nothing it does may reach the file.
    let fire = load();
    fire('session_start', { mode: 'rpc' });
    fire('agent_start', { mode: 'rpc' });
    fire('agent_settled', { mode: 'rpc', isIdle: () => true });
    assert.equal(written(), undefined, 'a session pi did not open reports nothing');

    // pi can pick an extension up after a session began, and that session never reports its start.
    fire = load();
    fire('agent_start', { mode: 'tui' });
    assert.equal(written(), 'working\n', 'a run reports even when no start came before it');

    fire = load();
    fire('session_start', { mode: 'tui' });
    assert.equal(written(), undefined, 'a session that starts leaves no report, which the app draws as idle');
    fire('agent_start', { mode: 'tui' });
    assert.equal(written(), 'working\n');
    fire('session_start', { mode: 'tui', isIdle: () => false });
    assert.equal(written(), 'working\n', 'a reload in the middle of a run keeps it working');
    fire('agent_settled', { mode: 'tui', isIdle: () => false });
    assert.equal(written(), 'working\n', 'a settle that is not idle is not the end of a run');
    // A run that asked for a tool is not over when pi settles: the tool call comes right after and cancels it.
    fire('agent_settled', { mode: 'tui', isIdle: () => true });
    fire('tool_call', { mode: 'tui' });
    await new Promise((rest) => setTimeout(rest, 700));
    assert.equal(written(), 'working\n', 'a run with a tool to run is not finished');
    fire('agent_start', { mode: 'tui' });
    fire('agent_settled', { mode: 'tui', isIdle: () => true });
    await new Promise((rest) => setTimeout(rest, 700));
    assert.equal(written(), 'finished\n');
    fire('session_shutdown', { mode: 'tui' });
    assert.equal(written(), undefined, 'a session that ends leaves nothing behind');

    // A report a previous app run left on the machine is cleared by the session that starts now.
    writeFileSync(statePath, 'finished\n');
    fire = load();
    fire('session_start', { mode: 'tui' });
    assert.equal(written(), undefined);

    // An ending session only takes back what it wrote: the report may belong to another session in that workspace.
    writeFileSync(statePath, 'working\n');
    fire = load();
    fire('session_shutdown', { mode: 'tui' });
    assert.equal(written(), 'working\n', 'a session that reported nothing leaves the report it found');
    fire('agent_start', { mode: 'tui' });
    fire('session_shutdown', { mode: 'tui' });
    assert.equal(written(), undefined, 'a session that reported takes its report back when it ends');
  } finally {
    delete process.env.WANGCAI_AGENT_STATE;
    rmSync(home, { recursive: true, force: true });
  }
});
