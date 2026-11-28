const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { activeTerminal, closeWorkspace, createWorkspace, openWorkspaceMenu, run, runUntilShown, screen, tabs } = require('./terminal-agent-ui.cjs');

const lists = { workspaces: ['terminal-agent'] };
const canvas = '.xterm-screen > canvas:last-of-type';

test('WebGL is on by default, reuses renderers across switches and preserves history on context loss', { timeout: 180000 }, (t) => withWindow('wangcai-webgl', lists, async ({ home, page }) => {
  await page.locator('.workspaces').waitFor();
  if (!(await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const loss = gl?.getExtension('WEBGL_lose_context');
    loss?.loseContext();
    return Boolean(loss);
  }))) {
    t.skip('WebGL context loss is unavailable');
    return;
  }
  const panes = page.locator('.terminal-pane');
  const add = async () => {
    const index = await panes.count();
    await openWorkspaceMenu(page);
    await page.getByRole('menuitem', { name: '新建 本机', exact: true }).click();
    await panes.nth(index).locator(canvas).waitFor();
  };
  let sockets = 0;
  page.on('websocket', () => sockets++);
  await add();
  const firstCanvas = panes.first().and(activeTerminal(page)).locator(canvas);
  const firstContext = await firstCanvas.evaluateHandle((element) => element.getContext('webgl2'));
  const marker = join(home, 'rendered');
  await run(page, `printf 'GPU_%s\\n' history; touch '${marker.replaceAll("'", "'\\''")}'`);
  await until(() => existsSync(marker));

  for (let i = 1; i < 6; i++) await add();
  assert.equal(await page.locator(canvas).count(), 6);
  await tabs(page).first().click();
  assert.ok(await firstCanvas.evaluate((element, context) =>
    element.getContext('webgl2') === context && !context.isContextLost(), firstContext), 'switching reuses the first context');

  await firstCanvas.evaluate((element) => element.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await until(async () => (await screen(page)).includes('GPU_history'));
  const overflow = await activeTerminal(page).locator('.terminal-surface').evaluate((surface) =>
    surface.querySelector('.xterm-screen').getBoundingClientRect().right - surface.getBoundingClientRect().right);
  assert.ok(overflow <= 0, `the fallback grid extends ${overflow}px past the pane`);
  await runUntilShown(page, "printf 'GPU_%s\\n' recovered", 'GPU_recovered');
  assert.equal(sockets, 6, 'one socket per workspace');

  const lastPane = panes.last();
  const lastContext = await lastPane.locator(canvas).evaluateHandle((element) => element.getContext('webgl2'));
  const domRecreated = await lastPane.evaluateHandle((pane) => {
    let recreated = false;
    const observer = new MutationObserver((entries) => {
      recreated ||= entries.some(({ addedNodes }) => [...addedNodes].some((node) => node.classList?.contains('xterm-rows')));
    });
    observer.observe(pane, { childList: true, subtree: true });
    return () => { observer.disconnect(); return recreated; };
  });
  await closeWorkspace(tabs(page).last());
  await until(() => lastContext.evaluate((context) => context.isContextLost()));
  assert.equal(await domRecreated.evaluate((read) => read()), false, 'DOM renderer created during close');
}));

test('a failed WebGL initialization leaves the DOM renderer usable', { timeout: 180000 }, () => withWindow('wangcai-webgl-fallback', lists, async ({ page }) => {
  await page.locator('.workspaces').waitFor();
  await page.evaluate(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    window.webglAttempts = 0;
    HTMLCanvasElement.prototype.getContext = function (type, ...options) {
      if (type !== 'webgl2') return getContext.call(this, type, ...options);
      window.webglAttempts++;
      return null;
    };
  });
  await createWorkspace(page);
  await until(() => page.evaluate(() => window.webglAttempts > 0));
  await runUntilShown(page, "printf 'DOM_%s\\n' fallback", 'DOM_fallback');
  assert.equal(await page.evaluate(() => window.webglAttempts), 1);
}));

test('a failure in shader setup releases the partially initialized WebGL canvas', { timeout: 180000 }, (t) => withWindow('wangcai-webgl-shader', lists, async ({ page }) => {
  await page.locator('.workspaces').waitFor();
  if (!(await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const loss = gl?.getExtension('WEBGL_lose_context');
    if (!loss) return false;
    loss.loseContext();
    WebGL2RenderingContext.prototype.compileShader = function () {
      window.failedContext = this;
      throw new Error('shader setup failed');
    };
    return true;
  }))) {
    t.skip('WebGL context loss is unavailable');
    return;
  }
  await createWorkspace(page);
  await until(() => page.evaluate(() => window.failedContext?.isContextLost()));
  assert.equal(await activeTerminal(page).locator(canvas).count(), 0);
  await runUntilShown(page, "printf 'DOM_%s\\n' recovered", 'DOM_recovered');
}));
