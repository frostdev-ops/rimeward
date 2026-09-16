import assert from 'node:assert/strict';

/** Exercise the real Workspace dialog and accessible Leylines, without native folder dialogs. */
export async function addWorkspaceUi(page, root, { name = 'Workspace fixture', wards = [], create = false, mounts = [] } = {}) {
  assert.equal(await page.getByRole('button', { name: 'Open project', exact: true }).count(), 0);
  await page.locator('[data-tb="edit"]').click();
  await page.getByRole('button', { name: 'Add ward', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Add ward', exact: true });
  await picker.locator('[data-type="workspace"]').click();
  await picker.locator('[data-aw-submit]').click();
  const workspace = page.getByRole('dialog', { name: 'Add Workspace', exact: true });
  await workspace.getByRole('textbox', { name: 'Workspace name', exact: true }).fill(name);
  await workspace.getByRole('button', { name: 'Choose another folder…', exact: true }).click();
  const folder = page.getByRole('dialog', { name: /^Folder · / });
  await folder.getByRole('textbox', { name: 'Folder path', exact: true }).fill(root);
  if (create) await folder.getByRole('checkbox', { name: 'Create this folder if it does not exist' }).check();
  await folder.getByRole('button', { name: 'Use folder', exact: true }).click();
  await folder.waitFor({ state: 'hidden' });
  for (const mount of mounts) {
    await workspace.getByRole('button', { name: 'Add folder', exact: true }).click();
    const row = workspace.locator('.workspace-mount').last();
    await row.getByRole('textbox', { name: 'Mount path', exact: true }).fill(mount.path);
    await row.getByRole('button', { name: 'Choose another folder…', exact: true }).click();
    const choice = page.getByRole('dialog', { name: /^Folder · / });
    await choice.getByRole('textbox', { name: 'Folder path', exact: true }).fill(mount.root);
    await choice.getByRole('button', { name: 'Use folder', exact: true }).click();
    await choice.waitFor({ state: 'hidden' });
  }
  await workspace.getByRole('button', { name: 'Add workspace', exact: true }).click();
  await workspace.waitFor({ state: 'hidden' });
  await page.locator('[data-tb="edit"]').click();
  const config = await page.evaluate(async name => {
    const current = await fetch('/api/runtime').then(r => r.json());
    return current.layout.find(w => w.type === 'workspace' && w.title === name);
  }, name);
  assert.ok(config?.i, 'Workspace ward saved');
  const card = page.locator(`[data-wd="${config.i}"]`);
  for (const ward of wards) {
    await card.getByRole('button', { name: 'Connect a ward…', exact: true }).click();
    const link = page.getByRole('dialog', { name: 'Connect a ward', exact: true });
    const index = await link.locator('select[aria-label="Ward"]').evaluate((select, id) => [...select.options].find(option => option.value === id)?.index, ward);
    await link.getByRole('button', { name: 'Ward', exact: true }).click();
    await page.locator(`.fd-ss-opt[data-index="${index}"]`).click();
    await link.getByRole('button', { name: 'Connect', exact: true }).click();
    await link.waitFor({ state: 'hidden' });
  }
  return config;
}

/** Explicitly arrange ordinary wards; a Workspace never creates or moves pages for the user. */
export async function workspaceToolsPage(page, { id = 'workspace-smoke', title = 'Workspace smoke' } = {}) {
  const wardIds = await page.evaluate(async ({ id, title }) => {
    const current = await fetch('/api/runtime').then(r => r.json());
    const tools = ['editor', 'agent', 'terminal', 'changes'].map(type => ({ i: `${id}-${type}`, type, page: id, size: type === 'editor' ? '4x4' : type === 'agent' ? '2x4' : '3x2' }));
    const response = await fetch('/api/dashboard', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: [...current.layout, ...tools], pages: [...current.pages, { id, title }], base: { layout: current.layout, pages: current.pages } }) });
    if (!response.ok) throw Error(await response.text());
    return tools.map(w => w.i);
  }, { id, title });
  await page.goto(new URL(`/dash#p=${id}`, page.url()).href);
  return { page: id, wardIds };
}
