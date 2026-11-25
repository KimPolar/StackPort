const assert = require('node:assert/strict');

function comparison(column, kind, value) {
  return { column, condition: { kind, value: { kind: 'text', value } } };
}

function range(column, from, to) {
  return { column, condition: { kind: 'between', from: { kind: 'text', value: from }, to: { kind: 'text', value: to } } };
}

function sort(column, direction, nulls = 'default') {
  return { column, direction, nulls };
}

async function verifyGridFilter(page, detail, grid, column, value) {
  const filters = detail.locator('.table-query-controls');
  await filters.getByText('필터 및 정렬', { exact: true }).click();
  await filters.getByRole('button', { name: '조건 추가', exact: true }).click();
  await filters.getByLabel('필터 1 열', { exact: true }).selectOption(column);
  await filters.getByLabel('필터 1 값', { exact: true }).fill(value);
  await filters.getByRole('button', { name: '정렬 열 추가', exact: true }).click();
  await filters.getByLabel('정렬 1 열', { exact: true }).selectOption(column);
  await filters.getByLabel('정렬 1 방향', { exact: true }).selectOption('desc');
  await filters.getByRole('button', { name: '적용', exact: true }).click();
  const rows = grid.locator('tbody tr');
  await grid.getByText(value, { exact: true }).waitFor();
  assert.equal(await rows.count(), 1);
  const query = detail.locator('.table-query-sql');
  await query.getByText('조회 SQL', { exact: true }).click();
  assert.match(await query.locator('code').textContent(), /WHERE[\s\S]*ORDER BY/);
  assert.ok(!(await query.locator('code').textContent()).includes(value));

  await filters.getByRole('button', { name: '저장된 조건', exact: true }).click();
  const saved = page.getByRole('dialog', { name: '저장된 조회 조건', exact: true });
  await saved.getByRole('textbox', { name: /조건 이름/ }).fill('한 행 확인');
  await saved.getByRole('button', { name: '조건 저장', exact: true }).click();
  await saved.getByText('조회 조건을 저장했습니다.', { exact: true }).waitFor();
  await saved.getByRole('button', { name: '닫기', exact: true }).click();
  await filters.getByRole('button', { name: '초기화', exact: true }).click();
  await rows.nth(1).waitFor();
  await filters.getByRole('button', { name: '저장된 조건', exact: true }).click();
  await saved.getByRole('combobox', { name: '조회 조건', exact: true }).selectOption({ label: '한 행 확인' });
  await saved.getByRole('button', { name: '적용', exact: true }).click();
  await saved.waitFor({ state: 'detached' });
  await grid.getByText(value, { exact: true }).waitFor();
  assert.equal(await rows.count(), 1);
}

module.exports = { comparison, range, sort, verifyGridFilter };
