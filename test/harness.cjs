const { cpSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

/**
 * The WangCai checkout next to this repository, which runs this plugin, or the one WANGCAI_CHECKOUT names:
 * a worktree, for trying this plugin against a branch of the app. It has to be built: the app launches in
 * place and loads this plugin's files from this directory. A missing one is an error rather than a skip,
 * because every test here drives the app.
 */
exports.wangcaiApp = () => {
  const root = resolve(__dirname, process.env.WANGCAI_CHECKOUT ?? '../../WangCai');
  const built = ['desktop/dist/main/index.js', 'desktop/node/bin/node', 'wangcaicli/dist/debug/wangcai'];
  if (!built.every((name) => existsSync(join(root, name)))) throw new Error('build the WangCai checkout next to this repository');
  return root;
};

/** The environment a test runs the app in: its own home, and none of the variables a dev run exports. */
exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  // The agent a Core would download is taken from this checkout instead, so a case needs no network for it.
  const agent = join(exports.wangcaiApp(), 'wangcaicli/dist/debug/wangcai');
  if (existsSync(agent)) env.WANGCAI_AGENT_SOURCE = agent;
  return env;
};

/**
 * Puts a Core where the app would have installed one: the checkout next to this repository, or the one
 * WANGCAI_CORE_SOURCE names. A home without one opens the window that installs a Core first, which is a window
 * and a network no case here wants to wait for.
 */
const installCore = (home) => {
  const source = resolve(__dirname, process.env.WANGCAI_CORE_SOURCE ?? '../../WangCai-Core');
  // What a Core reads of its own sources: the snapshot an agent is set up from.
  if (!existsSync(join(source, 'dist/main.cjs'))) throw new Error(`build the Core checkout at ${source}`);
  const storage = join(home, '.local/share/wangcai');
  mkdirSync(storage, { recursive: true });
  cpSync(join(source, 'dist'), join(storage, 'core'), { recursive: true });
  for (const entry of ['main', 'ui']) cpSync(join(source, entry), join(storage, 'core-src', entry), { recursive: true });
};

/** Launches that checkout on this home, with the Electron the checkout depends on. The window it draws never comes
 *  to the front, so driving it does not take the focus of whoever works at the machine. */
exports.launchApp = (home, env) => {
  const app = exports.wangcaiApp();
  const { _electron: electron } = require(join(app, 'node_modules/playwright'));
  installCore(home);
  return electron.launch({ executablePath: require(join(app, 'node_modules/electron')), args: [join(app, 'desktop'), '--unfocused', `--user-data-dir=${join(home, 'electron')}`], cwd: app, env });
};

/** A plugin checkout next to this one, already built into the files the app loads. */
const checkout = (id) => {
  const directory = resolve(__dirname, `../../WangCai-${id}`);
  return existsSync(join(directory, 'main.cjs')) ? directory : undefined;
};

/** Where a plugin's files are, for a test that writes init.ts itself. */
exports.pluginDirectory = (id) => {
  const directory = checkout(id);
  if (!directory) throw new Error(`build WangCai-${id} first`);
  return directory;
};

/** The app loads only what init.ts lists, so a test names the plugins and where to read them from. */
exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs = [] } = lists ?? { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };
  const entry = (item) => {
    const spec = typeof item === 'string' ? { id: item } : item;
    if (!spec.directory && !spec.repo) {
      const directory = checkout(spec.id);
      if (directory) spec.directory = directory;
    }
    return JSON.stringify(spec);
  };
  const list = (entries) => entries.map(entry).join(', ');
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { workspaces: [${list(workspaces)}], tabs: [${list(tabs)}] };\n`);
};

exports.waitForShell = (page) => page.locator('.workspaces').waitFor();

/** A right-click on the workspace heading opens the menu of machines a workspace can be opened on. */
exports.openWorkspaceMenu = (page) => page.locator('.workspace-header').click({ button: 'right' });

/** Waits until the workspace in front has a terminal on screen: the pane draws the shell once it attaches. */
const waitForTerminal = async (page) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const drawn = await page.evaluate(() => (document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '').trim().length > 0);
    if (drawn) return;
    await page.waitForTimeout(50);
  }
  throw new Error('the pane never drew the shell');
};

/** Types a line into the pane in front and runs it, the way a person does: the pane reaches the shell itself. */
exports.run = async (page, line) => {
  await page.locator('.terminal-pane.active .xterm-helper-textarea').click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};

/** The list menu offers one entry per machine; picking the local one opens a workspace on it. */
exports.createWorkspace = async (page) => {
  await exports.openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await page.locator('.terminal-pane.active .xterm-helper-textarea').waitFor();
  await waitForTerminal(page);
};
