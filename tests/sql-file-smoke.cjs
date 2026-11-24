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
    const editor = page.getByRole('textbox', { name: 'SQL 쿼리', exact: true });
    const sqlTabs = page.getByRole('tablist', { name: 'SQL 문서', exact: true });
    const initialTab = sqlTabs.getByRole('tab', { name: 'SQL 1', exact: true });
    const open = page.getByRole('button', { name: 'SQL 파일 열기', exact: true });
    const inputDialog = page.getByRole('dialog', { name: 'SQL 파일 열기', exact: true });
    const saveDialog = page.getByRole('dialog', { name: 'SQL 파일로 저장', exact: true });

    await dev.click();
    await editor.fill("SELECT '기존 초안';");
    await open.click();
    await inputDialog.getByLabel('SQL 파일 경로').fill(invalid);
    const openInTab = inputDialog.getByRole('button', { name: '새 탭에서 열기', exact: true });
    await openInTab.click();
    await inputDialog.getByRole('alert').getByText(/UTF-8 SQL/).waitFor();
    await inputDialog.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await editor.inputValue(), "SELECT '기존 초안';");

    await open.click();
    await inputDialog.getByLabel('SQL 파일 경로').fill(source);
    await openInTab.click();
    await inputDialog.waitFor({ state: 'detached' });
    assert.equal(await editor.inputValue(), "SELECT '한글';\n");
    await page.getByText('아직 조회 결과가 없습니다', { exact: true }).waitFor();
    const importedTab = sqlTabs.getByRole('tab', { name: '원본 쿼리.sql', exact: true });
    assert.equal(await importedTab.getAttribute('aria-selected'), 'true');
    await importedTab.press('ArrowLeft');
    assert.equal(await editor.inputValue(), "SELECT '기존 초안';");
    assert.equal(await initialTab.getAttribute('aria-selected'), 'true');
    await initialTab.press('ArrowRight');
    assert.equal(await editor.inputValue(), "SELECT '한글';\n");
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
    const copiedTab = sqlTabs.getByRole('tab', { name: '새 쿼리.sql', exact: true });
    assert.equal(await copiedTab.getAttribute('aria-selected'), 'true');
    await page.getByRole('status').getByText('파일과 동일', { exact: true }).waitFor();
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
    const results = title => page.getByRole('region', { name: `${title} 쿼리 결과`, exact: true });
    async function exportJson(result, fileName) {
      const jsonPath = path.join(root, fileName);
      await result.getByRole('button', { name: '결과 내보내기', exact: true }).click();
      const exportDialog = page.getByRole('dialog', { name: '결과 내보내기', exact: true });
      await exportDialog.getByLabel('파일 형식').selectOption('JSON');
      await exportDialog.getByLabel('새 JSON 파일 경로').fill(jsonPath);
      await exportDialog.getByRole('button', { name: 'JSON 저장', exact: true }).click();
      await page.getByRole('status').getByText('JSON 내보내기 완료').waitFor();
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
    const exported = await exportJson(results('새 쿼리.sql'), '선택 영역.json');
    assert.deepEqual(exported.columns, ['name']);
    assert.deepEqual(exported.rows, [['사용자 2']]);
    await editor.press('End');
    await page.getByRole('button', { name: '쿼리 실행', exact: true }).waitFor();

    await initialTab.click();
    const mainResult = results('SQL 1');
    await mainResult.getByText('아직 조회 결과가 없습니다', { exact: true }).waitFor();
    await editor.fill('SELECT name FROM people WHERE id >= :first ORDER BY id;');
    async function runWithStart(button) {
      await page.getByRole('button', { name: button, exact: true }).click();
      await page.getByLabel(':first 형식').selectOption('integer');
      await page.getByLabel(':first 값', { exact: true }).fill('3');
      await page.getByRole('button', { name: '매개변수로 실행', exact: true }).click();
    }
    await runWithStart('쿼리 실행');
    await mainResult.getByRole('cell', { name: '사용자 3', exact: true }).waitFor();
    await mainResult.getByRole('button', { name: '다음 페이지', exact: true }).click();
    await mainResult.getByRole('cell', { name: '사용자 103', exact: true }).waitFor();
    await runWithStart('실행 계획');
    await plan.getByText(/SEARCH people USING INTEGER PRIMARY KEY/).waitFor();
    await copiedTab.click();
    await results('새 쿼리.sql').getByRole('cell', { name: '사용자 2', exact: true }).waitFor();
    assert.equal(await plan.count(), 0);
    await initialTab.click();
    await mainResult.getByRole('cell', { name: '사용자 103', exact: true }).waitFor();
    await plan.getByText(/SEARCH people USING INTEGER PRIMARY KEY/).waitFor();
    await prod.click();
    await results('SQL 1').getByText('아직 조회 결과가 없습니다', { exact: true }).waitFor();
    await dev.click();
    await mainResult.getByRole('cell', { name: '사용자 103', exact: true }).waitFor();
    await editor.fill('WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT sum(n) FROM numbers');
    await page.getByRole('button', { name: '쿼리 실행', exact: true }).click();
    await page.getByRole('button', { name: '쿼리 중단', exact: true }).waitFor();
    await copiedTab.click();
    await results('새 쿼리.sql').getByRole('cell', { name: '사용자 2', exact: true }).waitFor();
    await initialTab.click();
    await mainResult.getByRole('cell', { name: '사용자 103', exact: true }).waitFor();
    const unexecuted = "SELECT '실행하지 않은 변경';";
    await editor.fill(unexecuted);
    assert.equal(await plan.count(), 0);
    const storedResult = await exportJson(mainResult, '실행한 결과.json');
    assert.deepEqual(storedResult.columns, ['name']);
    assert.equal(storedResult.rows.length, 203);
    assert.deepEqual(storedResult.rows[0], ['사용자 3']);
    assert.deepEqual(storedResult.rows.at(-1), ['사용자 205']);
    await copiedTab.click();

    const pendingClose = page.getByRole('alertdialog', { name: 'SQL 탭 닫기', exact: true });
    const closingText = await editor.inputValue();
    await copiedTab.press('Delete');
    await pendingClose.getByRole('button', { name: '계속 편집', exact: true }).click();
    assert.equal(await editor.inputValue(), closingText);
    await sqlTabs.getByRole('button', { name: '새 쿼리.sql 탭 닫기', exact: true }).click();
    await pendingClose.getByRole('button', { name: '파일로 저장 후 닫기', exact: true }).click();
    await destination.fill(copy);
    await save.click();
    await saveDialog.getByRole('alert').getByText(/같은 이름의 파일/).waitFor();
    assert.equal(await copiedTab.count(), 1);
    const recovery = path.join(root, '닫기 전에 저장한 쿼리.sql');
    await destination.fill(recovery);
    await save.click();
    await pendingClose.waitFor({ state: 'detached' });
    assert.equal(fs.readFileSync(recovery, 'utf8'), '\uFEFF' + closingText.replace(/\n/g, '\r\n'));
    assert.equal(await copiedTab.count(), 0);
    assert.equal(await editor.inputValue(), unexecuted);

    const add = page.getByRole('button', { name: '새 SQL 탭', exact: true });
    await add.click();
    await editor.fill("SELECT '버릴 초안';");
    const extra = sqlTabs.getByRole('tab', { name: 'SQL 3', exact: true });
    await extra.press('Delete');
    await pendingClose.getByRole('button', { name: '변경 버리고 닫기', exact: true }).click();
    assert.equal(await extra.count(), 0);
    assert.equal(await editor.inputValue(), unexecuted);
    await initialTab.press('Delete');
    await pendingClose.getByRole('button', { name: '변경 버리고 닫기', exact: true }).click();
    await page.getByText('열린 SQL 탭이 없습니다.', { exact: true }).waitFor();
    await add.click();
    assert.equal(await editor.inputValue(), '');
    assert.deepEqual(errors, []);
    console.log('SQL tabs, draft recovery, independent plans and results, pagination and exact exports passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
