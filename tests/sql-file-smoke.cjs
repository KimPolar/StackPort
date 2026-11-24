/* Connect only to an isolated Windows StackPort instance. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { DatabaseSync } = require('node:sqlite');
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
    const isolatedPath = path.join(root, 'completion-isolated.sqlite');
    const isolated = new DatabaseSync(isolatedPath);
    isolated.exec('CREATE TABLE source (value TEXT); CREATE VIEW "web view" AS SELECT value FROM source;');
    isolated.exec(`
      CREATE TABLE departments (dept_id INTEGER PRIMARY KEY, dept_name TEXT);
      CREATE TABLE staff (staff_id INTEGER PRIMARY KEY, department_id INTEGER REFERENCES departments(dept_id));
      INSERT INTO departments VALUES (1, '영업'), (2, '기획'), (3, '운영');
      INSERT INTO staff VALUES (1, 1), (2, 1), (3, 2);
    `);
    isolated.close();
    await invoke('create_sqlite_profile', { projectId: project.id, name: '격리 DB', path: isolatedPath, environment: 'DEV' });
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
    await verifySqlCompletion(page, editor, dev);
    await verifySqlDiagnostics(page, editor, dev);
    await verifySqlDefinition(page, editor, dev);
    await verifySqlHover(page, editor, dev);
    await verifySqlFormatting(page, editor);
    await verifySqlAliasRename(page, editor);
    const colored = "\tSELECT \"FROM\", '한😀 ''x''' AS 값, ?12, 0xff; -- SELECT\n/* 첫 줄\n둘째 줄 */";
    await editor.fill(colored);
    const syntax = page.locator('.code-highlight-lines');
    await syntax.locator('[data-syntax="keyword"]').getByText('SELECT', { exact: true }).waitFor();
    assert.equal(await syntax.locator('[data-syntax="identifier"]').textContent(), '"FROM"');
    assert.equal(await syntax.locator('[data-syntax="string"]').textContent(), "'한😀 ''x'''");
    assert.equal(await syntax.locator(':scope > div').allTextContents().then(lines => lines.join('\n')), colored);
    assert.equal(await editor.inputValue(), colored);
    const display = () => editor.evaluate(node => getComputedStyle(node).color);
    assert.equal(await display(), 'rgba(0, 0, 0, 0)');
    await editor.dispatchEvent('compositionstart');
    await syntax.waitFor({ state: 'detached' });
    assert.notEqual(await display(), 'rgba(0, 0, 0, 0)');
    await editor.dispatchEvent('compositionend');
    await syntax.waitFor();
    await page.emulateMedia({ forcedColors: 'active' });
    await syntax.waitFor({ state: 'hidden' });
    assert.notEqual(await display(), 'rgba(0, 0, 0, 0)');
    await page.emulateMedia({ forcedColors: 'none' });
    const lineTest = [...Array.from({ length: 179 }, (_, index) => `-- fixture line ${index + 1}`), '한😀'].join('\n');
    await editor.fill(lineTest);
    await editor.press('Control+End');
    await page.getByText('180줄 · 3열', { exact: true }).waitFor();
    const gutter = page.locator('.code-gutter-lines > div');
    await page.locator('.code-gutter-lines > [data-active="true"]').getByText('180', { exact: true }).waitFor();
    await syntax.getByText('-- fixture line 179', { exact: true }).waitFor();
    assert.ok(await syntax.locator(':scope > div').count() < 25);
    assert.ok(await gutter.count() < 25);
    assert.ok(await editor.evaluate(node => node.scrollTop) > 0);
    await editor.press('Control+Home');
    await page.getByText('1줄 · 1열', { exact: true }).waitFor();
    await page.locator('.code-gutter-lines > [data-active="true"]').getByText('1', { exact: true }).waitFor();
    await editor.fill('SELECT ' + 'x'.repeat(2041));
    await editor.press('End');
    await page.getByText('1줄 · 2,049열', { exact: true }).waitFor();
    assert.ok(await editor.evaluate(node => node.scrollLeft) > 0);
    await page.waitForFunction(() => {
      const input = document.querySelector('#sql-editor');
      const layer = input.parentElement.querySelector('.code-highlight-lines');
      return layer && Math.abs(new DOMMatrixReadOnly(getComputedStyle(layer).transform).m41 + input.scrollLeft) < 0.5;
    });
    const distant = ' '.repeat(1200) + 'hit [x].';
    await editor.fill(['hit [x].', ...Array(149).fill('-- filler'), distant, 'HIT [X].'].join('\n'));
    await editor.press('Control+Home');
    await editor.press('Control+f');
    const find = page.getByRole('group', { name: '편집기 찾기', exact: true });
    const search = find.getByRole('searchbox', { name: '찾을 텍스트', exact: true });
    await search.fill('hit [x].');
    await find.getByText('3개 일치', { exact: true }).waitFor();
    await search.press('Enter');
    await find.getByText('1 / 3', { exact: true }).waitFor();
    await editor.press('F3');
    await find.getByText('2 / 3', { exact: true }).waitFor();
    await page.getByText('151줄 · 1,209열', { exact: true }).waitFor();
    assert.ok(await editor.evaluate(node => node.scrollTop > 0 && node.scrollLeft > 0));
    await editor.press('Shift+F3');
    await find.getByText('1 / 3', { exact: true }).waitFor();
    await editor.press('Shift+F3');
    await find.getByText('3 / 3', { exact: true }).waitFor();
    assert.equal(await editor.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), 'HIT [X].');
    await find.getByRole('checkbox', { name: '대소문자 구분', exact: true }).check();
    await find.getByText('2개 일치', { exact: true }).waitFor();
    await search.fill('없음');
    await find.getByText('일치 항목 없음', { exact: true }).waitFor();
    assert.equal(await find.getByRole('button', { name: '다음 일치 항목', exact: true }).isDisabled(), true);
    await search.press('Escape');
    await find.waitFor({ state: 'detached' });
    const toReplace = 'target [v].\nTARGET [V].\nprefix target [v]. suffix';
    const once = '$& 한😀\nTARGET [V].\nprefix target [v]. suffix';
    await editor.fill(toReplace);
    await editor.press('Control+Home');
    await editor.press('Control+h');
    const replace = find.getByRole('group', { name: '편집기 바꾸기', exact: true });
    const replacement = replace.getByRole('textbox', { name: '바꿀 내용', exact: true });
    await find.getByRole('checkbox', { name: '대소문자 구분', exact: true }).uncheck();
    await search.fill('target [v].');
    await replacement.fill('$& 한😀');
    await replace.getByRole('button', { name: '한 건 바꾸기', exact: true }).click();
    await replace.getByRole('status').getByText('1개 위치를 바꿨습니다.', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), once);
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), toReplace);
    await replace.getByRole('button', { name: '한 건 바꾸기', exact: true }).click();
    assert.equal(await editor.inputValue(), once);
    await replacement.fill('$1 글자');
    await replace.getByRole('button', { name: '모두 바꾸기', exact: true }).click();
    await replace.getByRole('status').getByText('2개 위치를 바꿨습니다.', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), '$& 한😀\n$1 글자\nprefix $1 글자 suffix');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), once);
    await replacement.fill('');
    await replace.getByRole('button', { name: '모두 바꾸기', exact: true }).click();
    assert.equal(await editor.inputValue(), '$& 한😀\n\nprefix  suffix');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), once);
    await editor.fill('token TOKEN');
    await editor.press('Control+Home');
    await search.fill('token');
    await replacement.fill('token');
    await replace.getByRole('button', { name: '모두 바꾸기', exact: true }).click();
    await replace.getByRole('status').getByText('1개 위치를 바꿨습니다.', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), 'token token');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), 'token TOKEN');
    await find.getByRole('checkbox', { name: '대소문자 구분', exact: true }).check();
    await search.fill('TOKEN');
    await replacement.fill('');
    await replace.getByRole('button', { name: '한 건 바꾸기', exact: true }).click();
    assert.equal(await editor.inputValue(), 'token ');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), 'token TOKEN');
    await editor.press('Escape');
    await find.waitFor({ state: 'detached' });
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

    const script = "SELECT * FROM missing_table;\n-- skip ;\nSELECT '한글😀; ''문자열''';\nSELECT name FROM people WHERE id = 2;";
    const current = page.getByRole('button', { name: '현재 문장 실행', exact: true });
    const caret = (source, word) => editor.evaluate((element, offset) => element.setSelectionRange(offset, offset), source.indexOf(word));
    await editor.fill(script);
    await caret(script, '문자열');
    await current.click();
    const copiedResult = results('새 쿼리.sql');
    await copiedResult.getByRole('cell', { name: "한글😀; '문자열'", exact: true }).waitFor();
    await caret(script, 'skip');
    await current.click();
    await page.getByRole('alert').getByText(/커서를 실행할 SQL 문장 안에/).waitFor();
    await copiedResult.getByRole('cell', { name: "한글😀; '문자열'", exact: true }).waitFor();
    const trigger = 'CREATE TEMP TRIGGER t AFTER INSERT ON people BEGIN SELECT 1; SELECT 2; END;';
    await editor.fill(trigger);
    await caret(trigger, 'SELECT 2');
    await current.click();
    await page.getByRole('alert').getByText(/읽기 전용/).waitFor();
    assert.equal(await copiedResult.getByRole('cell', { name: '2', exact: true }).count(), 0);
    await editor.fill(script);
    await editor.press('Control+End');
    await editor.press('Control+Shift+Enter');
    await copiedResult.getByRole('cell', { name: '사용자 2', exact: true }).waitFor();

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
    await verifySqlBatch(page, editor, exportJson);
    await verifySqlResultPins(page, editor, sqlTabs, add, exportJson);
    await verifySqlTemplates(page, editor, sqlTabs);
    await verifySqlHistory(page, editor, sqlTabs, dev, prod);
    await verifySqlQueryBuilder(page, editor, sqlTabs);
    await verifySqlSchemaDiagram(page, editor, isolatedPath);
    assert.deepEqual(errors, []);
    console.log('SQL tabs, drafts, templates, history, query builder, schema diagram, plans, batches, result pins, comparisons and exact exports passed.');
  } finally {
    await browser.close();
  }
}

async function verifySqlCompletion(page, editor, dev) {
  const choices = page.getByRole('listbox', { name: 'SQL 자동완성 후보', exact: true });
  const option = label => choices.getByRole('option').filter({ has: page.getByText(label, { exact: true }) });
  await editor.fill('SELECT * FROM pe');
  await editor.press('Control+Space');
  await option('people').getByText('테이블', { exact: true }).waitFor();
  await editor.press('Tab');
  assert.equal(await editor.inputValue(), 'SELECT * FROM people');
  await editor.press('Control+z');
  assert.equal(await editor.inputValue(), 'SELECT * FROM pe');

  await editor.fill('SELECT p FROM people AS p');
  await editor.evaluate(node => node.setSelectionRange('SELECT p'.length, 'SELECT p'.length));
  await editor.press('.');
  await option('name').getByText('p · 열', { exact: true }).waitFor();
  await editor.press('n');
  await option('note').waitFor();
  assert.equal(await option('id').count(), 0);
  await editor.press('ArrowDown');
  await editor.press('Enter');
  assert.equal(await editor.inputValue(), 'SELECT p.note FROM people AS p');
  await choices.waitFor({ state: 'detached' });

  await editor.fill('SELECT cou');
  await page.getByRole('button', { name: '자동완성', exact: true }).click();
  await option('count').getByText('함수', { exact: true }).click();
  assert.equal(await editor.inputValue(), 'SELECT count()');
  assert.equal(await editor.evaluate(node => node.selectionStart), 'SELECT count('.length);

  await editor.fill('SELECT * FROM pe');
  await editor.press('Control+Space');
  await option('people').waitFor();
  await page.getByRole('button', { name: /격리 DB DEV/ }).click();
  await choices.waitFor({ state: 'detached' });
  await editor.fill('SELECT * FROM pe');
  await editor.press('Control+Space');
  await page.getByRole('status').getByText('일치하는 자동완성 후보가 없습니다.', { exact: true }).waitFor();
  await editor.press('Escape');
  await editor.fill('SELECT * FROM main.we');
  await editor.press('Control+Space');
  await option('web view').getByText('뷰', { exact: true }).waitFor();
  await editor.press('Tab');
  assert.equal(await editor.inputValue(), 'SELECT * FROM main."web view"');
  await dev.click();
}

async function verifySqlDiagnostics(page, editor, dev) {
  const region = page.getByRole('region', { name: 'SQL 실시간 진단', exact: true });
  const input = "SELECT '한😀';\nSELECT '한😀', FROM people;\nSELECT absent FROM people;\nSELECT * FROM missing;\nDELETE FROM people;\nSELECT abs(-9223372036854775808);";
  await editor.fill(input);
  await region.getByRole('status').getByText('6개 문장 검사 · 문제 4개', { exact: true }).waitFor();
  await region.getByRole('button', { name: /2줄 14열 문법 오류/ }).click();
  assert.equal(await editor.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), 'FROM');
  assert.equal(await editor.inputValue(), input);
  await region.getByRole('button', { name: /객체 참조 오류.*absent/ }).waitFor();
  await region.getByRole('button', { name: /객체 참조 오류.*missing/ }).waitFor();
  await region.getByRole('button', { name: /읽기 전용 정책/ }).waitFor();

  await editor.fill('SELECT name FROM people WHERE id = :id;');
  await region.getByText('1개 문장 검사 · 문제 0개', { exact: true }).waitFor();
  await editor.fill('SELECT value FROM source;');
  await region.getByRole('button', { name: /객체 참조 오류.*source/ }).waitFor();
  await page.getByRole('button', { name: /격리 DB DEV/ }).click();
  await editor.fill('SELECT value FROM source;');
  await region.getByText('1개 문장 검사 · 문제 0개', { exact: true }).waitFor();
  await dev.click();
}

async function verifySqlDefinition(page, editor, dev) {
  const dialog = page.getByRole('dialog', { name: 'SQL 정의', exact: true });
  const locate = async (input, fragment) => {
    await editor.fill(input);
    const position = input.indexOf(fragment) + 1;
    await editor.evaluate((node, offset) => node.setSelectionRange(offset, offset), position);
  };
  const close = () => dialog.getByRole('button', { name: '닫기', exact: true }).click();
  const query = "SELECT '한😀 p.name', p.name FROM main.PEOPLE AS p WHERE p.name <> 'p.name';";
  await locate(query, 'name FROM');
  await editor.press('F12');
  await dialog.getByText('people · name', { exact: true }).waitFor();
  const columns = dialog.getByRole('table', { name: 'people 열 구조', exact: true });
  await columns.locator('tr[aria-current="true"]').getByRole('cell', { name: 'name', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '생성 SQL로 이동', exact: true }).click();
  const ddl = dialog.getByLabel('생성 SQL', { exact: true });
  assert.match(await ddl.textContent(), /CREATE TABLE people/);
  assert.equal(await ddl.evaluate(element => element === document.activeElement), true);
  await dialog.getByText('현재 문장의 참조 위치 2개', { exact: true }).click();
  await dialog.getByRole('button', { name: /줄.*열 name$/ }).last().click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await editor.evaluate(node => node.selectionStart), query.indexOf('name <>'));
  assert.equal(await editor.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), 'name');
  assert.equal(await editor.inputValue(), query);

  await page.getByRole('button', { name: /격리 DB DEV/ }).click();
  await locate('SELECT * FROM "WEB VIEW";', 'WEB VIEW');
  await page.getByRole('button', { name: '정의 보기', exact: true }).click();
  await dialog.getByText('web view', { exact: true }).waitFor();
  assert.match(await ddl.textContent(), /CREATE VIEW "web view"/);
  await close();
  await locate('SELECT value FROM source s JOIN "web view" v ON s.value = v.value;', 'value FROM');
  await editor.press('F12');
  await dialog.getByRole('alert').getByText(/여러 테이블이 이 이름을 사용합니다/).waitFor();
  await close();
  await dev.click();
}

async function verifySqlFormatting(page, editor) {
  const dialog = page.getByRole('dialog', { name: 'SQL 서식', exact: true });
  const apply = dialog.getByRole('button', { name: '서식 적용', exact: true });
  const after = dialog.getByLabel('서식 결과 SQL', { exact: true });
  const source = "SELECT  id,  name FROM people;\nSELECT '한😀  그대로';";
  const formatted = "select\n    id,\n    name\nfrom\n    people;\nselect\n    '한😀  그대로';";
  const waitForPreview = async text => {
    await page.waitForFunction(expected => document.querySelector('[aria-label="서식 결과 SQL"]')?.textContent === expected, text);
    assert.equal(await after.textContent(), text);
  };

  await editor.fill(source);
  await editor.press('Control+Alt+f');
  await dialog.getByText('SQLite · 문서 전체', { exact: true }).waitFor();
  await dialog.getByLabel('키워드 대소문자').selectOption('lower');
  await dialog.getByLabel('들여쓰기').selectOption('4');
  await dialog.getByLabel('문장 사이 빈 줄').selectOption('0');
  await waitForPreview(formatted);
  assert.equal(await dialog.getByLabel('서식 적용 전 SQL', { exact: true }).textContent(), source);
  assert.equal(await editor.inputValue(), source);
  await apply.click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await editor.inputValue(), formatted);
  await editor.press('Control+z');
  assert.equal(await editor.inputValue(), source);

  const prefix = 'SELECT  1;\n';
  const fragment = "select   -- keep  \n    x'0a', $p::a(x;y);";
  const suffix = '\nSELECT  3;';
  const compacted = "select -- keep  \nx'0a', $p::a(x;y);";
  const selectionSource = prefix + fragment + suffix;
  await editor.fill(selectionSource);
  await editor.evaluate((node, [start, end]) => node.setSelectionRange(start, end), [prefix.length, prefix.length + fragment.length]);
  await page.getByRole('button', { name: 'SQL 서식', exact: true }).click();
  await dialog.getByText('SQLite · 선택 영역', { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('들여쓰기').inputValue(), '4');
  await dialog.getByLabel('방식').selectOption('compact');
  await waitForPreview(compacted);
  assert.equal(await editor.inputValue(), selectionSource);
  await apply.click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await editor.inputValue(), prefix + compacted + suffix);
  assert.equal(await editor.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), compacted);
  await editor.press('Control+z');
  assert.equal(await editor.inputValue(), selectionSource);

  await editor.press('Control+Alt+f');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await editor.inputValue(), selectionSource);
}

async function verifySqlAliasRename(page, editor) {
  const dialog = page.getByRole('dialog', { name: '테이블 별칭 변경', exact: true });
  const newName = dialog.getByRole('textbox', { name: '새 별칭', exact: true });
  const apply = dialog.getByRole('button', { name: '별칭 변경', exact: true });
  const source = "SELECT 9;\nSELECT P.id, 'p.id' AS label FROM main.people p\n"
    + "WHERE EXISTS (SELECT p.id FROM people p)\n"
    + "AND EXISTS (SELECT 1 FROM people q WHERE q.id = p.id); -- p.id\nSELECT 3;";
  const expected = 'SELECT 9;\nSELECT "한 팀".id, \'p.id\' AS label FROM main.people "한 팀"\n'
    + "WHERE EXISTS (SELECT p.id FROM people p)\n"
    + 'AND EXISTS (SELECT 1 FROM people q WHERE q.id = "한 팀".id); -- p.id\nSELECT 3;';
  async function selectAlias(sql, token) {
    await editor.fill(sql);
    await editor.evaluate((node, offset) => node.setSelectionRange(offset, offset), sql.indexOf(token) + 1);
  }

  await selectAlias(source, 'P.id');
  await editor.press('F2');
  await newName.waitFor();
  assert.equal(await newName.inputValue(), 'p');
  assert.equal(await newName.evaluate(node => node === document.activeElement && node.selectionStart === 0 && node.selectionEnd === node.value.length), true);
  await newName.fill('q');
  await dialog.getByRole('alert').getByText(/다른 테이블이나 별칭/).waitFor();
  assert.equal(await apply.isDisabled(), true);
  await newName.fill('한 팀');
  assert.equal(await dialog.getByRole('list', { name: '변경 위치', exact: true }).getByRole('listitem').count(), 3);
  assert.equal(await editor.inputValue(), source);
  await apply.click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await editor.inputValue(), expected);
  await editor.press('Control+z');
  assert.equal(await editor.inputValue(), source);

  const implicit = 'SELECT p.id + 1 FROM people p;';
  await selectAlias(implicit, 'p.id');
  await page.getByRole('button', { name: '별칭 변경', exact: true }).click();
  await newName.fill('changed');
  await apply.click();
  await dialog.getByRole('alert').getByText(/결과 열 이름이 바뀝니다/).waitFor();
  assert.equal(await editor.inputValue(), implicit);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}

async function verifySqlHover(page, editor, dev) {
  const popup = page.getByRole('region', { name: 'SQL 객체 정보', exact: true });
  const dialog = page.getByRole('dialog', { name: 'SQL 정의', exact: true });
  const lines = page.locator('.code-highlight-lines > div');
  async function pointAt(lineText, fragment) {
    const row = lines.filter({ hasText: lineText }).first();
    await row.waitFor({ state: 'attached' });
    return row.evaluate((row, fragment) => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const index = node.textContent.indexOf(fragment);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + fragment.length);
        const bounds = range.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      }
      throw new Error('Could not find text to hover: ' + fragment);
    }, fragment);
  }

  const source = "\tSELECT '한😀 p.name', p.name FROM people p;\n-- p.name";
  await editor.fill(source);
  await editor.press('Control+Home');
  let point = await pointAt('FROM people p', 'p.name ');
  await page.mouse.move(point.x, point.y);
  await popup.getByText('people · name', { exact: true }).waitFor();
  await popup.getByText('TEXT', { exact: true }).waitFor();
  assert.equal(await editor.evaluate(node => node.selectionStart), 0);

  point = await pointAt('-- p.name', 'p.name');
  await page.mouse.move(point.x, point.y);
  await popup.waitFor({ state: 'hidden' });
  await page.waitForTimeout(400);
  assert.equal(await popup.count(), 0);

  point = await pointAt('FROM people p', 'p.name ');
  await page.mouse.move(point.x, point.y);
  await popup.getByText('people · name', { exact: true }).waitFor();
  await editor.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await editor.inputValue(), source);

  await page.emulateMedia({ forcedColors: 'active' });
  point = await pointAt('FROM people p', 'p.name ');
  await page.mouse.move(5, 5);
  await page.mouse.move(point.x, point.y);
  await popup.getByText('people · name', { exact: true }).waitFor();
  const detailButton = popup.getByRole('button', { name: '정의 보기', exact: true });
  await detailButton.focus();
  await page.mouse.move(5, 5);
  assert.equal(await detailButton.evaluate(node => document.activeElement === node), true);
  await detailButton.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await editor.evaluate(node => document.activeElement === node), true);
  await page.emulateMedia({ forcedColors: 'none' });

  await page.getByRole('button', { name: /격리 DB DEV/ }).click();
  const finalLine = "\tSELECT '한😀 " + 'g'.repeat(230) + "', w.value FROM \"web view\" w;";
  await editor.fill(['-- first', ...Array(90).fill('-- filler'), finalLine].join('\n'));
  await editor.press('Control+End');
  point = await pointAt('FROM "web view"', 'value');
  await page.mouse.move(point.x, point.y);
  await popup.getByText('web view · value', { exact: true }).waitFor();
  point = await pointAt('FROM "web view"', '"web view"');
  await page.mouse.move(point.x, point.y);
  await popup.getByText('main · 뷰 · 열 1개', { exact: true }).waitFor();
  await popup.getByRole('button', { name: '정의 보기', exact: true }).click();
  await dialog.getByText('web view', { exact: true }).waitFor();
  assert.match(await dialog.getByLabel('생성 SQL', { exact: true }).textContent(), /CREATE VIEW "web view"/);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await popup.waitFor({ state: 'hidden' });
  await dev.click();
}

async function verifySqlBatch(page, editor, exportJson) {
  const grid = page.locator('.database-results');
  const batch = grid.getByRole('group', { name: '일괄 실행 결과', exact: true });
  const first = batch.getByRole('button', { name: '문장 1', exact: true });
  const second = batch.getByRole('button', { name: '문장 2', exact: true });
  const run = () => editor.press('Control+Enter');
  const cell = text => grid.getByRole('cell', { name: text, exact: true });
  await editor.fill("SELECT '첫😀; 결과' AS marker;\n-- 구분자 ;\nSELECT name FROM people ORDER BY id;");
  await run();
  await batch.getByText(/2개 문장 중 2개 완료/).waitFor();
  await cell('첫😀; 결과').waitFor();
  await second.click();
  await cell('사용자 1').waitFor();
  await grid.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await cell('사용자 101').waitFor();
  await first.click();
  await cell('첫😀; 결과').waitFor();
  await second.click();
  await cell('사용자 101').waitFor();
  const exported = await exportJson(grid, '일괄 문장 결과.json');
  assert.deepEqual(exported.columns, ['name']);
  assert.equal(exported.rows.length, 205);

  const outside = "SELECT '선택 영역 밖😀';\n";
  const selected = "SELECT '남은 결과😀;' AS marker;\n-- 내부 ;\nDELETE FROM people;\nSELECT '실행하지 않은 문장';";
  const source = outside + selected;
  await editor.fill(source);
  await editor.evaluate((node, start) => node.setSelectionRange(start, node.value.length), outside.length);
  await run();
  await batch.getByRole('alert').getByText(/문장 2.*읽기 전용/).waitFor();
  await batch.getByText(/3개 문장 중 1개 완료/).waitFor();
  await cell('남은 결과😀;').waitFor();
  assert.equal(await second.count(), 0);
  await batch.getByRole('button', { name: '중단 위치로 이동', exact: true }).click();
  await page.waitForFunction(() => {
    const sql = document.getElementById('sql-editor');
    return sql.value.slice(sql.selectionStart, sql.selectionEnd) === 'DELETE FROM people;';
  });
  await page.getByRole('button', { name: '문서 전체 실행', exact: true }).click();
  await batch.getByText(/4개 문장 중 2개 완료/).waitFor();
  await cell('선택 영역 밖😀').waitFor();

  await editor.fill("SELECT '중단 전 결과' AS marker;\nWITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;\nSELECT 9;");
  await run();
  const cancel = page.getByRole('button', { name: '쿼리 중단', exact: true });
  await cancel.waitFor();
  await page.waitForTimeout(150);
  await cancel.click();
  await batch.getByRole('status').getByText(/문장 2.*실행을 중단했습니다/).waitFor();
  await cell('중단 전 결과').waitFor();
  await run();
  await batch.getByRole('alert').getByText(/문장 2.*10초/).waitFor();
  await cell('중단 전 결과').waitFor();

  await editor.fill("SELECT '입력 전 결과'; SELECT :value; SELECT 3;");
  await run();
  await batch.getByRole('alert').getByText(/문장 2.*매개변수/).waitFor();
  await cell('입력 전 결과').waitFor();
}

async function verifySqlResultPins(page, editor, sqlTabs, add, exportJson) {
  const grid = page.locator('.database-results');
  const pins = grid.getByRole('group', { name: '고정 결과', exact: true });
  const pin = pins.getByRole('button', { name: /^고정 \d+$/ }).first();
  const pinPage = grid.getByRole('button', { name: '현재 페이지 고정', exact: true });
  const compare = grid.getByRole('button', { name: '결과 비교', exact: true });
  const comparison = page.getByRole('dialog', { name: 'SQL 결과 비교', exact: true });
  const cell = value => grid.getByRole('cell', { name: value, exact: true }).first();
  const query = 'SELECT name, :tag AS label FROM people ORDER BY id;';
  await editor.fill(query);
  await editor.press('Control+Enter');
  await page.getByLabel(':tag 값', { exact: true }).fill('고정할 입력');
  await page.getByRole('button', { name: '매개변수로 실행', exact: true }).click();
  await cell('사용자 1').waitFor();
  await grid.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await cell('사용자 101').waitFor();
  await pinPage.click();
  await pin.waitFor();

  const fixturePath = path.resolve(process.env.STACKPORT_TEST_DATABASE);
  assert.equal(path.dirname(fixturePath), path.resolve(process.env.STACKPORT_TEST_ROOT));
  const fixture = new DatabaseSync(fixturePath);
  try {
    assert.equal(fixture.prepare('UPDATE people SET name = ? WHERE id = 101').run('고정 이후 이름').changes, 1);
  } finally { fixture.close(); }
  const nextQuery = "SELECT '새 결과' AS other;";
  await editor.fill(nextQuery);
  await editor.press('Control+Enter');
  await cell('새 결과').waitFor();
  await pin.click();
  await grid.getByText('고정된 2페이지', { exact: true }).waitFor();
  await cell('사용자 101').waitFor();
  await cell('고정할 입력').waitFor();
  assert.equal(await grid.getByRole('button', { name: '결과 내보내기', exact: true }).count(), 0);
  assert.equal(await grid.getByRole('button', { name: '다음 페이지', exact: true }).count(), 0);
  await grid.getByText('고정된 SQL', { exact: true }).click();
  assert.equal(await grid.getByLabel('고정된 SQL', { exact: true }).textContent(), query);
  await compare.click();
  await comparison.getByText(/같은 페이지 번호/).waitFor();
  await comparison.getByRole('button', { name: '비교 닫기', exact: true }).click();

  await grid.getByRole('button', { name: '고정 쿼리 재실행', exact: true }).click();
  await cell('고정 이후 이름').waitFor();
  await grid.getByText(/^고정 \d+ 재실행$/).waitFor();
  await cell('고정할 입력').waitFor();
  assert.equal(await editor.inputValue(), nextQuery);
  assert.equal(await pins.getByRole('button', { name: '현재 결과', exact: true }).getAttribute('aria-pressed'), 'true');
  await compare.click();
  await comparison.getByRole('status').getByText(/셀 1개 변경/).waitFor();
  const changes = comparison.getByRole('table', { name: '결과 값 차이', exact: true });
  await changes.getByText('사용자 101', { exact: true }).waitFor();
  await changes.getByText('고정 이후 이름', { exact: true }).waitFor();
  await comparison.getByText('실행 통계 비교', { exact: true }).click();
  const metrics = comparison.getByRole('table', { name: 'SQLite 실행 통계 비교', exact: true });
  const rowsRead = metrics.getByRole('row').filter({ hasText: '읽은 결과 행' });
  assert.deepEqual(await rowsRead.getByRole('cell').allTextContents(), ['101', '101', '0']);
  await comparison.getByRole('button', { name: '비교 닫기', exact: true }).click();
  const exported = await exportJson(grid, '고정 쿼리 재실행 결과.json');
  assert.deepEqual(exported.columns, ['name', 'label']);
  assert.deepEqual(exported.rows[100], ['고정 이후 이름', '고정할 입력']);

  await pinPage.click();
  assert.equal(await pins.getByRole('button', { name: /^고정 \d+$/ }).count(), 2);
  const originalTab = await sqlTabs.getByRole('tab', { selected: true }).getAttribute('id');
  await add.click();
  assert.equal(await pins.count(), 0);
  await sqlTabs.locator(`[id="${originalTab}"]`).click();
  await pin.click();
  await cell('사용자 101').waitFor();
  await grid.getByRole('button', { name: '고정 해제', exact: true }).click();
  assert.equal(await pins.getByRole('button', { name: /^고정 \d+$/ }).count(), 1);
  await cell('고정 이후 이름').waitFor();
}

async function verifySqlTemplates(page, editor, sqlTabs) {
  const open = page.getByRole('button', { name: 'SQL 템플릿', exact: true });
  const library = page.getByRole('dialog', { name: 'SQL 템플릿', exact: true });
  const list = library.getByRole('list', { name: '템플릿 목록', exact: true });
  const preview = library.getByLabel('저장된 템플릿 SQL', { exact: true });
  const save = library.getByRole('button', { name: '템플릿 저장', exact: true });
  const name = library.getByLabel('템플릿 이름', { exact: true });
  const previous = await sqlTabs.getByRole('tab', { selected: true }).getAttribute('id');
  const prefix = "SELECT '보존할 초안😀';\n";
  const snippet = 'SELECT :threshold AS saved_value;';
  await editor.fill(prefix + snippet);
  await editor.evaluate((node, start) => node.setSelectionRange(start, node.value.length), prefix.length);
  await open.click();
  await library.getByRole('button', { name: '선택 영역으로 만들기', exact: true }).click();
  assert.equal(await library.getByLabel('템플릿 SQL', { exact: true }).inputValue(), snippet);
  await name.fill('매개변수 조회');
  await library.getByLabel('폴더', { exact: true }).fill('보고서');
  await save.click();
  await preview.waitFor();
  assert.equal(await preview.textContent(), snippet);

  await library.getByRole('button', { name: '새 템플릿', exact: true }).click();
  await name.fill('상태 확인');
  await library.getByLabel('템플릿 SQL', { exact: true }).fill('SELECT 1 AS status;');
  await save.click();
  await list.getByRole('button', { name: /상태 확인/ }).waitFor();
  await library.getByLabel('템플릿 폴더', { exact: true }).selectOption({ label: '보고서' });
  assert.equal(await list.getByRole('button', { name: /상태 확인/ }).count(), 0);
  await library.getByRole('button', { name: '즐겨찾기', exact: true }).click();
  await library.getByLabel('즐겨찾기만', { exact: true }).check();
  await list.getByRole('button', { name: /매개변수 조회/ }).waitFor();
  await library.getByRole('button', { name: '템플릿 편집', exact: true }).click();
  await name.fill('보관한 조회');
  await save.click();
  await list.getByRole('button', { name: /보관한 조회/ }).waitFor();
  await library.getByRole('button', { name: '닫기', exact: true }).click();

  await page.getByRole('button', { name: '명령 팔레트', exact: true }).click();
  const command = page.getByRole('combobox', { name: '명령 검색', exact: true });
  await command.fill('SQL 템플릿');
  await command.press('Enter');
  await library.getByLabel('템플릿 검색', { exact: true }).fill('보관한');
  await list.getByRole('button', { name: /보관한 조회/ }).waitFor();
  await library.getByRole('button', { name: '새 탭에서 열기', exact: true }).click();
  const opened = sqlTabs.getByRole('tab', { name: '보관한 조회', exact: true });
  assert.equal(await opened.getAttribute('aria-selected'), 'true');
  assert.equal(await editor.inputValue(), snippet);
  await sqlTabs.locator(`[id="${previous}"]`).click();
  assert.equal(await editor.inputValue(), prefix + snippet);
  await opened.click();
  await editor.press('Control+Enter');
  await page.getByLabel(':threshold 형식', { exact: true }).selectOption('integer');
  await page.getByLabel(':threshold 값', { exact: true }).fill('42');
  await page.getByRole('button', { name: '매개변수로 실행', exact: true }).click();
  await page.getByRole('cell', { name: '42', exact: true }).waitFor();

  await open.click();
  await library.getByLabel('템플릿 검색', { exact: true }).fill('보관한');
  await library.getByRole('button', { name: '템플릿 삭제', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'SQL 템플릿', exact: true });
  await confirm.getByRole('button', { name: '취소', exact: true }).click();
  await preview.waitFor();
  await library.getByRole('button', { name: '템플릿 삭제', exact: true }).click();
  await confirm.getByRole('button', { name: '템플릿 삭제 확인', exact: true }).click();
  await library.getByText('조건에 맞는 템플릿이 없습니다.', { exact: true }).waitFor();
  await library.getByRole('button', { name: '닫기', exact: true }).click();
  assert.equal(await editor.inputValue(), snippet);
}

async function verifySqlHistory(page, editor, sqlTabs, dev, prod) {
  const open = page.getByRole('button', { name: '최근 SQL', exact: true });
  const dialog = page.getByRole('dialog', { name: '최근 SQL', exact: true });
  const list = dialog.getByRole('list', { name: '실행 기록 목록', exact: true });
  const records = list.getByRole('listitem');
  const raw = dialog.getByLabel('실행한 SQL 원문', { exact: true });
  const close = () => dialog.getByRole('button', { name: '닫기', exact: true }).click();
  async function clear() {
    await dialog.getByRole('button', { name: '이 연결 기록 지우기', exact: true }).click();
    await page.getByRole('alertdialog', { name: '최근 SQL', exact: true }).getByRole('button', { name: '기록 지우기', exact: true }).click();
    await dialog.getByText('이 연결의 최근 실행 기록이 없습니다.', { exact: true }).waitFor();
  }

  await open.click();
  await list.getByText('문서 전체 · 중단', { exact: true }).first().waitFor();
  await list.getByText('문서 전체 · 시간 초과', { exact: true }).first().waitFor();
  await clear();
  await close();
  const previous = await sqlTabs.getByRole('tab', { selected: true }).getAttribute('id');
  const prefix = "SELECT '선택 밖의 문장';\n";
  const query = "SELECT :fixture_parameter AS result, 'fixture-private-literal😀' AS label;";
  await editor.fill(prefix + query);
  await editor.evaluate((node, offset) => node.setSelectionRange(offset, node.value.length), prefix.length);
  await editor.press('Control+Enter');
  await page.getByLabel(':fixture_parameter 값', { exact: true }).fill('fixture-bound-value');
  await page.getByRole('button', { name: '매개변수로 실행', exact: true }).click();
  await page.getByRole('cell', { name: 'fixture-bound-value', exact: true }).waitFor();
  await open.click();
  await list.getByText('선택 영역 · 완료', { exact: true }).waitFor();
  assert.equal(await records.count(), 1);
  const masked = await dialog.getByLabel('값을 가린 SQL', { exact: true }).textContent();
  assert.match(masked, /SELECT/);
  assert.doesNotMatch(await dialog.textContent(), /fixture-private-literal|fixture_parameter|fixture-bound-value/);
  await dialog.getByRole('button', { name: 'SQL 원문 표시', exact: true }).click();
  assert.equal(await raw.textContent(), query);
  assert.doesNotMatch(await dialog.textContent(), /fixture-bound-value/);
  await dialog.getByRole('button', { name: '새 탭에서 열기', exact: true }).click();
  assert.equal(await editor.inputValue(), query);
  await page.getByText('아직 조회 결과가 없습니다', { exact: true }).waitFor();
  await editor.press('Control+Enter');
  const parameters = page.getByRole('dialog', { name: 'SQL 매개변수', exact: true });
  await parameters.getByRole('button', { name: '취소', exact: true }).click();
  await open.click();
  await list.waitFor();
  assert.equal(await records.count(), 1);
  await close();
  await sqlTabs.locator(`[id="${previous}"]`).click();
  assert.equal(await editor.inputValue(), prefix + query);

  await editor.fill('SELECT name FROM people WHERE id = 1;');
  await page.getByRole('button', { name: '실행 계획', exact: true }).click();
  await page.getByRole('region', { name: 'SQLite 실행 계획', exact: true }).waitFor();
  await editor.fill('SELECT 1; SELECT id FROM fixture_missing_private_table; SELECT 2;');
  await editor.press('Control+Enter');
  await page.getByRole('group', { name: '일괄 실행 결과', exact: true }).getByText(/3개 문장 중 1개 완료/).waitFor();
  await open.click();
  await list.getByText('문서 전체 · 오류', { exact: true }).waitFor();
  await list.getByText('실행 계획 · 계획 완료', { exact: true }).waitFor();
  await dialog.getByText(/3개 문장 중 1개 완료/).waitFor();
  assert.equal(await records.count(), 3);
  assert.doesNotMatch(await dialog.textContent(), /fixture_missing_private_table/);
  await close();

  await prod.click();
  await open.click();
  await dialog.getByText('이 연결의 최근 실행 기록이 없습니다.', { exact: true }).waitFor();
  await close();
  await editor.fill('SELECT 24 AS fresh;');
  await editor.press('Control+Enter');
  await page.getByRole('cell', { name: '24', exact: true }).waitFor();
  await dev.click();
  await open.click();
  await list.waitFor();
  assert.equal(await records.count(), 3);
  await clear();
  await close();
  await prod.click();
  await open.click();
  await list.waitFor();
  assert.equal(await records.count(), 1);
  await close();
  await page.reload();
  await prod.click();
  await open.click();
  await dialog.getByText('이 연결의 최근 실행 기록이 없습니다.', { exact: true }).waitFor();
  await close();
}

async function verifySqlQueryBuilder(page, editor, sqlTabs) {
  await page.getByRole('button', { name: /격리 DB DEV/ }).click();
  const previous = await sqlTabs.getByRole('tab', { selected: true }).getAttribute('id');
  const source = "SELECT '보존할 쿼리 빌더 초안';";
  await editor.fill(source);
  await page.getByRole('button', { name: '쿼리 빌더', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '쿼리 빌더', exact: true });
  const relations = dialog.getByRole('region', { name: '조회 테이블 관계', exact: true });
  const button = name => dialog.getByRole('button', { name, exact: true });
  const combo = name => dialog.getByRole('combobox', { name, exact: true });
  const preview = dialog.getByLabel('생성된 조회 SQL', { exact: true });
  await button('departments 추가').press('Enter');
  await relations.getByRole('button', { name: 't1 테이블 제거', exact: true }).waitFor();
  await button('staff 추가').dragTo(relations);
  await combo('조인 1 유형').selectOption('LEFT');
  assert.equal(await combo('조인 1 관계 1 기준 열').inputValue(), JSON.stringify('dept_id'));
  assert.equal(await combo('조인 1 관계 1 연결 열').inputValue(), JSON.stringify('department_id'));

  await button('조회 열 추가').click();
  await combo('조회 열 1 원본').selectOption({ label: 'dept_name' });
  await button('조회 열 추가').click();
  await combo('조회 열 2 함수').selectOption('COUNT');
  await combo('조회 열 2 원본').selectOption({ label: 'staff_id' });
  await dialog.getByRole('textbox', { name: '조회 열 2 별칭', exact: true }).fill('staff_count');
  await dialog.getByText('WHERE', { exact: true }).click();
  await button('WHERE 조건 추가').click();
  await combo('WHERE 1 연산자').selectOption('>=');
  await dialog.getByText('GROUP BY와 HAVING', { exact: true }).click();
  await button('그룹 열 추가').click();
  await combo('GROUP BY 1 열').selectOption({ label: 'dept_name' });
  await button('HAVING 조건 추가').click();
  await dialog.getByText('ORDER BY와 LIMIT', { exact: true }).click();
  await button('정렬 열 추가').click();
  await combo('ORDER BY 1 열').selectOption({ label: 'staff_count' });
  await combo('ORDER BY 1 방향').selectOption('DESC');
  await dialog.getByRole('textbox', { name: 'LIMIT', exact: true }).fill('1');
  const generated = await preview.textContent();
  assert.match(generated, /LEFT JOIN main\."staff" AS t2\n  ON t1\."dept_id" = t2\."department_id"/);
  assert.match(generated, /WHERE t1\."dept_id" >= :where_1\nGROUP BY t1\."dept_name"/);
  assert.match(generated, /HAVING COUNT\(t2\."staff_id"\) >= :having_1\nORDER BY COUNT\(t2\."staff_id"\) DESC\nLIMIT 1;/);
  await button('SQL을 새 탭에서 열기').click();
  assert.equal(await editor.inputValue(), generated);
  const generatedTab = await sqlTabs.getByRole('tab', { selected: true }).getAttribute('id');
  await sqlTabs.locator(`[id="${previous}"]`).click();
  assert.equal(await editor.inputValue(), source);
  await sqlTabs.locator(`[id="${generatedTab}"]`).click();
  await editor.press('Control+Enter');
  for (const [name, value] of [[':where_1', '1'], [':having_1', '2']]) {
    await page.getByLabel(`${name} 형식`, { exact: true }).selectOption('integer');
    await page.getByLabel(`${name} 값`, { exact: true }).fill(value);
  }
  await page.getByRole('button', { name: '매개변수로 실행', exact: true }).click();
  await page.getByRole('cell', { name: '영업', exact: true }).waitFor();
  const grid = page.locator('.database-results');
  assert.equal(await grid.getByRole('cell', { name: '기획', exact: true }).count(), 0);
  await grid.getByRole('cell', { name: '2', exact: true }).waitFor();
  await grid.locator('.sql-query-metrics summary').click();
  const metrics = grid.getByLabel('SQLite 실행 통계', { exact: true });
  assert.equal(await metrics.locator('div').filter({ hasText: '읽은 결과 행' }).locator('dd').textContent(), '1');
  const vmSteps = await metrics.locator('div').filter({ hasText: '가상 머신 단계' }).locator('dd').textContent();
  assert.ok(Number(vmSteps.replaceAll(',', '')) > 0, `예상한 SQLite VM 실행 단계가 없습니다: ${vmSteps}`);
}

async function verifySqlSchemaDiagram(page, editor, database) {
  const draft = await editor.inputValue();
  await page.getByRole('button', { name: '관계도', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'SQLite 관계도', exact: true });
  const tableList = dialog.getByRole('complementary', { name: '관계도 테이블 목록', exact: true });
  const canvas = dialog.getByRole('region', { name: '관계도 캔버스', exact: true });
  const relationScope = tableList.getByRole('combobox', { name: '관계 범위', exact: true });
  await tableList.getByRole('textbox', { name: '관계도 테이블 검색', exact: true }).fill('STAFF');
  await tableList.getByRole('button', { name: 'staff', exact: true }).click();
  await canvas.getByRole('button', { name: 'departments', exact: true }).waitFor();
  assert.equal(await canvas.locator('.erd-link').count(), 1);
  await dialog.getByText('staff → departments', { exact: true }).click();
  await dialog.getByText('department_id → dept_id', { exact: true }).waitFor();
  await dialog.getByRole('combobox', { name: '관계도 확대', exact: true }).selectOption('1.25');
  await canvas.locator('.erd-canvas[style*="1.25"]').waitFor();

  const external = new DatabaseSync(database);
  external.exec('CREATE TABLE broken_fk (ref INTEGER REFERENCES removed_parent(id)); CREATE TABLE relation_hub (id INTEGER PRIMARY KEY);');
  for (let i = 1; i <= 17; i++) {
    external.exec(`CREATE TABLE leaf_${i} (ref INTEGER REFERENCES relation_hub(id));`);
  }
  external.close();
  await dialog.getByRole('button', { name: '스키마 새로고침', exact: true }).click();
  await tableList.getByRole('textbox', { name: '관계도 테이블 검색', exact: true }).fill('');
  await relationScope.selectOption('issue');
  await tableList.getByRole('button', { name: 'broken_fk', exact: true }).click();
  await canvas.locator('.erd-table[data-missing]').getByText('removed_parent', { exact: true }).waitFor();
  await relationScope.selectOption('isolated');
  await tableList.getByRole('button', { name: 'source', exact: true }).waitFor();
  assert.equal(await tableList.getByRole('button', { name: 'departments', exact: true }).count(), 0);
  await relationScope.selectOption('all');
  await tableList.getByRole('button', { name: 'relation_hub', exact: true }).click();
  assert.equal(await canvas.locator('.erd-link').count(), 16);
  await dialog.getByRole('button', { name: '다음 관계', exact: true }).click();
  await dialog.getByRole('group', { name: '외래 키 페이지', exact: true }).getByText('2 / 2', { exact: true }).waitFor();
  assert.equal(await canvas.locator('.erd-link').count(), 1);
  await tableList.getByRole('button', { name: 'staff', exact: true }).click();
  await canvas.getByRole('button', { name: 'departments', exact: true }).click();
  await canvas.getByRole('button', { name: 'departments', exact: true, pressed: true }).waitFor();
  assert.ok(await tableList.getByRole('button', { name: 'departments', exact: true, pressed: true }).evaluate(button => {
    const list = button.closest('ul').getBoundingClientRect();
    const row = button.getBoundingClientRect();
    return row.top >= list.top - 1 && row.bottom <= list.bottom + 1;
  }));
  if (process.env.STACKPORT_TEST_ROOT) await page.screenshot({ path: path.join(process.env.STACKPORT_TEST_ROOT, 'sqlite-diagram.png') });
  await dialog.getByRole('button', { name: '테이블 열기', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.locator('details.schema-card[open]').getByRole('table', { name: 'departments 열 구조', exact: true }).waitFor();
  await page.getByRole('button', { name: 'SQL 편집기', exact: true }).click();
  assert.equal(await editor.inputValue(), draft);
  await page.keyboard.press('Control+Shift+P');
  const commands = page.getByRole('combobox', { name: '명령 검색', exact: true });
  await commands.fill('ERD');
  await page.getByRole('option', { name: /SQLite 관계도/ }).waitFor();
  await commands.press('Enter');
  await canvas.getByRole('button', { name: 'departments', exact: true, pressed: true }).waitFor();
  await dialog.getByRole('button', { name: '관계도 닫기', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}

main().catch(error => { console.error(error); process.exit(1); });
