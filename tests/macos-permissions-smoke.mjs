import assert from 'node:assert/strict';
import path from 'node:path';

/** Real editor recovery and page reload; macOS requests are a fixture, never TCC edits. */
export async function macosPermissionsSmoke(page, screenshots) {
  let restore = false;
  const calls = [];
  await page.exposeFunction('__permissionAction', action => {
    calls.push(action);
    if (action === 'relaunch') restore = true;
    return { screen: false, input: false };
  });
  await page.addInitScript(() => {
    window.__TAURI__ = { core: { invoke: async (command, { action }) => {
      if (command !== 'macos_permissions') throw Error('Unexpected native command');
      const result = await window.__permissionAction(action);
      if (action === 'relaunch') setTimeout(() => location.reload(), 50);
      return result;
    } } };
  });
  await page.route('**/dash**', async route => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(/<meta\b[^>]*name="fd-mac-user"[^>]*>/g, '');
    await route.fulfill({ response, body: html.replace('</head>', `<meta name="fd-mac-user" content="1" ${restore ? 'data-restore="1"' : ''}></head>`) });
    restore = false;
  });
  await page.route('**/api/agent/*', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { configured: true, provider: 'codex', transcript: [], pending: null, busy: false, tasks: [] } })
    : route.abort());
  await page.reload();
  const setup = page.getByRole('dialog', { name: 'Set up this Mac', exact: true });
  await setup.waitFor();
  assert.deepEqual(calls.filter(action => action !== 'status'), [], 'opening setup must not request permission');
  await setup.screenshot({ path: path.join(screenshots, 'rimeward-macos-permissions.png') });
  await setup.getByRole('button', { name: 'Done', exact: true }).click();
  const ward = page.locator('[data-wd-type=editor]:not([data-wd-off])');
  const code = ward.locator('.cm-content');
  await ward.getByRole('tab', { name: 'workspace.ts', exact: true }).click();
  await code.filter({ hasText: 'recovered' }).waitFor();
  const take = ward.getByRole('button', { name: 'Take over', exact: true });
  if (await take.isVisible()) await take.click();
  await ward.locator('.cm-content[contenteditable=true]').waitFor();
  await code.click();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(mod + '+a');
  await page.keyboard.insertText('export const permissionRecovery = 123;\n');
  const composer = page.locator('[data-wd-type=agent]:not([data-wd-off]) .ag-input');
  await composer.fill('Unsent task retained through permission relaunch');
  await page.locator('[data-tb=edit]').click();
  const order = await page.evaluate(() => {
    const grid = document.querySelector('#wd-grid');
    const editor = grid.querySelector('[data-wd-type=editor]:not([data-wd-off])');
    grid.append(editor);
    window.dispatchEvent(new CustomEvent('fd:pages-changed'));
    return [...grid.querySelectorAll('[data-wd]')].map(card => card.dataset.wd);
  });
  // Open setup over the expanded editor, preserving the same return surface.
  await ward.getByRole('button', { name: 'Expand editor', exact: true }).click();
  await page.evaluate(() => document.querySelector('#macos-permissions').click());
  await setup.waitFor();
  await page.evaluate(() => {
    window.__failedCheckpoint = e => e.detail.waitUntil(Promise.reject(Error('Recovery disk unavailable')));
    window.addEventListener('fd:before-workspace-navigation', window.__failedCheckpoint);
  });
  await setup.getByRole('button', { name: 'Request access', exact: true }).first().click();
  await setup.getByText(/Recovery disk unavailable/).waitFor();
  assert.equal(calls.includes('screen'), false, 'failed recovery prevents OS prompts');
  await page.evaluate(() => window.removeEventListener('fd:before-workspace-navigation', window.__failedCheckpoint));
  await setup.getByRole('button', { name: 'Request access', exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector('.macos-permissions-dialog button').disabled);
  assert.ok(calls.indexOf('checkpoint') < calls.indexOf('screen'), 'recovery precedes the native permission request');
  assert.equal(await setup.getByText('Not allowed in this app session', { exact: true }).count(), 2, 'denial is not reported as success');
  const before = page.url();
  await setup.getByRole('button', { name: 'Save & relaunch Rimeward', exact: true }).click();
  await page.waitForEvent('load');
  assert.equal(page.url(), before, 'the current workspace/page is retained');
  await setup.waitFor();
  assert.equal(calls.filter(action => action === 'screen').length, 1, 'restoring setup does not repeat the OS permission request');
  await setup.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.dev-expanded .cm-content').filter({ hasText: 'permissionRecovery' }).waitFor();
  assert.equal(await composer.inputValue(), 'Unsent task retained through permission relaunch');
  const restored = page.locator('.dev-expanded .cm-content');
  await restored.click(); await page.keyboard.press(mod + '+z');
  await page.waitForFunction(() => !document.querySelector('.dev-expanded .cm-content').textContent.includes('permissionRecovery'));
  assert.ok(calls.includes('relaunch'));
  assert.equal(await page.locator('#wd-grid').evaluate(grid => grid.classList.contains('editing')), true);
  assert.deepEqual(await page.locator('#wd-grid [data-wd]').evaluateAll(cards => cards.map(card => card.dataset.wd)), order, 'unsaved layout order is restored');
  await page.locator('.dev-expanded').getByRole('button', { name: 'Close', exact: true }).click();
  await page.unroute('**/dash**');
  console.log('macOS permission UI passed: no unsolicited request, denied state, failed-save gate, ordered checkpoint, setup modal/page/draft/editor/expanded restoration and undo.');
}
