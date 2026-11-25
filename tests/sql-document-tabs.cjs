const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function verifySqlDocumentTabs(page, workspace, editorName) {
  const folder = fs.mkdtempSync(path.join(process.env.STACKPORT_TEST_ROOT || os.tmpdir(), 'stackport-sql-documents-'));
  const source = path.join(folder, '원본.sql');
  const copy = path.join(folder, '저장본.sql');
  const raw = "\uFEFFSELECT '파일의 한글';\r\n";
  const originalText = "SELECT '기존 초안';";
  const openedText = "SELECT '파일의 한글';\n";
  const changedText = "SELECT '파일의 변경';\n";
  const tabs = workspace.getByRole('tablist', { name: 'SQL 문서', exact: true });
  const originalTab = tabs.getByRole('tab', { name: 'SQL 1', exact: true });
  const currentEditor = () => workspace.getByRole('tabpanel').getByRole('textbox', { name: editorName, exact: true });
  const open = page.getByRole('dialog', { name: 'SQL 파일 열기', exact: true });
  const save = page.getByRole('dialog', { name: 'SQL 파일로 저장', exact: true });
  const close = page.getByRole('alertdialog', { name: 'SQL 탭 닫기', exact: true });
  try {
    fs.writeFileSync(source, raw, { flag: 'wx' });
    const previous = await currentEditor().inputValue();
    await currentEditor().fill(originalText);
    await workspace.getByRole('button', { name: 'SQL 파일 열기', exact: true }).click();
    await open.getByLabel('SQL 파일 경로', { exact: true }).fill(source);
    await open.getByRole('button', { name: '새 탭에서 열기', exact: true }).click();
    await open.waitFor({ state: 'detached' });
    const opened = tabs.getByRole('tab', { name: '원본.sql', exact: true });
    assert.equal(await opened.getAttribute('aria-selected'), 'true');
    assert.equal(await currentEditor().inputValue(), openedText);
    const id = await currentEditor().getAttribute('id');
    await page.waitForFunction(id => document.activeElement?.id === id, id);

    await opened.press('ArrowLeft');
    assert.equal(await originalTab.getAttribute('aria-selected'), 'true');
    assert.equal(await currentEditor().inputValue(), originalText);
    await originalTab.press('ArrowRight');
    assert.equal(await currentEditor().inputValue(), openedText);
    await currentEditor().fill(changedText);
    await currentEditor().press('Control+s');
    const destination = save.getByLabel('새 SQL 파일 경로', { exact: true });
    const saveNew = save.getByRole('button', { name: '새 파일에 저장', exact: true });
    await destination.fill(source);
    await saveNew.click();
    await save.getByRole('alert').filter({ hasText: '같은 이름의 파일' }).waitFor();
    await destination.fill(copy);
    await saveNew.click();
    await save.waitFor({ state: 'detached' });
    assert.equal(fs.readFileSync(source, 'utf8'), raw);
    assert.equal(fs.readFileSync(copy, 'utf8'), "\uFEFFSELECT '파일의 변경';\r\n");

    const saved = tabs.getByRole('tab', { name: '저장본.sql', exact: true });
    assert.equal(await saved.getAttribute('aria-selected'), 'true');
    await currentEditor().fill("SELECT '저장하지 않은 변경';");
    await saved.press('Delete');
    await close.getByRole('button', { name: '계속 편집', exact: true }).click();
    await close.waitFor({ state: 'detached' });
    assert.equal(await currentEditor().inputValue(), "SELECT '저장하지 않은 변경';");
    await saved.press('Delete');
    await close.getByRole('button', { name: '변경 버리고 닫기', exact: true }).click();
    await close.waitFor({ state: 'detached' });
    assert.equal(await originalTab.getAttribute('aria-selected'), 'true');
    assert.equal(await currentEditor().inputValue(), originalText);
    await currentEditor().fill(previous);
  } finally {
    for (const file of [source, copy]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
}

module.exports = { verifySqlDocumentTabs };
