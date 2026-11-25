const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function verifyDefinitionPanel(page, detail, engine) {
  await detail.getByRole('button', { name: '정의 SQL', exact: true }).click();
  const panel = detail.getByRole('region', { name: engine + ' 정의 SQL', exact: true });
  const text = await panel.getByLabel('정의 SQL 원문', { exact: true }).textContent({ timeout: 65_000 });
  assert.match(text, /create\b/i);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.testCopiedDefinition = text; },
    } });
  });
  try {
    await panel.getByRole('button', { name: 'SQL 복사', exact: true }).click();
    await panel.getByText('정의 SQL을 복사했습니다.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.testCopiedDefinition), text);
  } finally {
    await page.evaluate(() => { delete navigator.clipboard; delete window.testCopiedDefinition; });
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stackport-definition-'));
  const destination = path.join(directory, '정의.sql');
  try {
    await panel.getByRole('button', { name: '정의 파일 저장', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'SQL 파일로 저장', exact: true });
    await dialog.getByLabel('새 SQL 파일 경로', { exact: true }).fill(destination);
    await dialog.getByRole('button', { name: '새 파일에 저장', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await fs.readFile(destination, 'utf8'), text);
  } finally {
    await fs.rm(destination, { force: true });
    await fs.rmdir(directory);
  }
  return text;
}

module.exports = { verifyDefinitionPanel };
