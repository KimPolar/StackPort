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
    assert.deepEqual(errors, []);
    console.log('SQL tabs, draft recovery, independent plans and results, pagination and exact exports passed.');
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

main().catch(error => { console.error(error); process.exit(1); });
