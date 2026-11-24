/* Connect only to an isolated Windows StackPort instance. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const root = process.env.STACKPORT_TEST_ROOT;
  assert.ok(root && path.isAbsolute(root));
  const source = path.join(root, '원본 쿼리.sql');
  const copy = path.join(root, '새 쿼리.sql');
  const invalid = path.join(root, '잘못된 쿼리.sql');
  const raw = "\uFEFFSELECT '한글';\r\n";
  fs.writeFileSync(source, raw);
  fs.writeFileSync(invalid, Buffer.from([255]));

  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  try {
    const page = browser.contexts().flatMap(context => context.pages())[0];
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.getByRole('button', { name: '명령 팔레트', exact: true }).waitFor();
    const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
    const project = await invoke('create_project', { name: 'SQL 파일 검증' });
    for (const name of ['개발 DB', '운영 DB']) {
      await invoke('create_sqlite_profile', { projectId: project.id, name, path: process.env.STACKPORT_TEST_DATABASE, environment: name === '개발 DB' ? 'DEV' : 'PROD' });
    }
    await page.reload();
    const dev = page.getByRole('button', { name: /개발 DB DEV/ });
    const prod = page.getByRole('button', { name: /운영 DB PROD/ });
    const editor = page.getByLabel('SQL 쿼리');
    const open = page.getByRole('button', { name: 'SQL 파일 열기', exact: true });
    const inputDialog = page.getByRole('dialog', { name: 'SQL 파일 열기', exact: true });
    const saveDialog = page.getByRole('dialog', { name: 'SQL 파일로 저장', exact: true });

    await dev.click();
    await editor.fill("SELECT '기존 초안';");
    await open.click();
    await inputDialog.getByLabel('SQL 파일 경로').fill(invalid);
    const replace = inputDialog.getByRole('button', { name: '열고 초안 교체', exact: true });
    await replace.click();
    await inputDialog.getByRole('alert').getByText(/UTF-8 SQL/).waitFor();
    await inputDialog.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await editor.inputValue(), "SELECT '기존 초안';");

    await open.click();
    await inputDialog.getByLabel('SQL 파일 경로').fill(source);
    await replace.click();
    await inputDialog.waitFor({ state: 'detached' });
    assert.equal(await editor.inputValue(), "SELECT '한글';\n");
    await page.getByText('아직 조회 결과가 없습니다', { exact: true }).waitFor();
    await page.getByRole('status').getByText('원본 쿼리.sql', { exact: true }).waitFor();
    await editor.fill("SELECT '저장할 쿼리';\n");
    await prod.click();
    assert.equal(await editor.inputValue(), '');
    await dev.click();
    assert.equal(await editor.inputValue(), "SELECT '저장할 쿼리';\n");
    await editor.press('Control+s');
    const destination = saveDialog.getByLabel('새 SQL 파일 경로');
    const save = saveDialog.getByRole('button', { name: '새 파일에 저장', exact: true });
    await destination.fill(source);
    await save.click();
    await saveDialog.getByRole('alert').getByText(/같은 이름의 파일/).waitFor();
    await destination.fill(copy);
    await save.click();
    await saveDialog.waitFor({ state: 'detached' });
    await page.getByRole('status').getByText('새 쿼리.sql', { exact: true }).waitFor();
    assert.equal(fs.readFileSync(source, 'utf8'), raw);
    assert.equal(fs.readFileSync(copy, 'utf8'), "\uFEFFSELECT '저장할 쿼리';\r\n");
    await page.getByRole('button', { name: '쿼리 실행', exact: true }).click();
    await page.getByRole('cell', { name: '저장할 쿼리', exact: true }).waitFor();

    await editor.fill("SELECT '선택하지 않은 쿼리';\nSELECT name FROM people WHERE id = 2;");
    await editor.press('Control+End');
    await editor.press('Shift+Home');
    const runSelection = page.getByRole('button', { name: '선택 영역 실행', exact: true });
    await runSelection.waitFor();
    await page.getByRole('button', { name: '실행 계획', exact: true }).click();
    const plan = page.getByRole('region', { name: 'SQLite 실행 계획', exact: true });
    await plan.getByText(/SEARCH people USING INTEGER PRIMARY KEY/).waitFor();
    await runSelection.click();
    await page.getByRole('cell', { name: '사용자 2', exact: true }).waitFor();
    assert.equal(await page.getByRole('cell', { name: '선택하지 않은 쿼리', exact: true }).count(), 0);
    await editor.press('Control+Enter');
    await page.getByRole('button', { name: '결과 내보내기', exact: true }).click();
    const exportDialog = page.getByRole('dialog', { name: '결과 내보내기', exact: true });
    const jsonPath = path.join(root, '선택 영역.json');
    await exportDialog.getByLabel('파일 형식').selectOption('JSON');
    await exportDialog.getByLabel('새 JSON 파일 경로').fill(jsonPath);
    await exportDialog.getByRole('button', { name: 'JSON 저장', exact: true }).click();
    await page.getByRole('status').getByText('JSON 내보내기 완료').waitFor();
    const exported = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.deepEqual(exported.columns, ['name']);
    assert.deepEqual(exported.rows, [['사용자 2']]);
    await editor.press('End');
    await page.getByRole('button', { name: '쿼리 실행', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('SQL open, draft protection, copy format, and selection plan, execution and export passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
