const assert = require('node:assert/strict');

async function openFromObjectSearch(page, workspace, engine, { schema, name, kind, term, field = 'name', scope }) {
  const trigger = workspace.getByRole('button', { name: '객체 검색', exact: true });
  const dialog = page.getByRole('dialog', { name: engine + ' 객체 검색', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const input = dialog.getByRole('searchbox', { name: '검색어', exact: true });
  await input.waitFor();
  assert.ok(await input.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await trigger.evaluate(element => document.activeElement === element));

  await page.keyboard.press('Enter');
  if (scope !== undefined) await dialog.getByLabel('검색 범위').selectOption(scope);
  await dialog.getByLabel('검색 기준').selectOption(field);
  await input.fill(term);
  await input.press('Enter');
  const result = dialog.getByRole('button', { name: `${schema}.${name} ${kind}`, exact: true });
  await result.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'detached' });
  const detail = workspace.getByRole('region', { name: engine + ' 객체 상세', exact: true });
  const heading = detail.getByRole('heading', { name, exact: true });
  assert.ok(await heading.evaluate(element => document.activeElement === element));
  const view = detail.getByRole('button', { name: field === 'column' ? '열 구조' : '데이터', exact: true });
  assert.equal(await view.getAttribute('aria-pressed'), 'true');
  return detail;
}

module.exports = { openFromObjectSearch };
