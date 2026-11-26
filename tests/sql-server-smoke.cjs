const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { chooseDatabase } = require('./database-picker.cjs');
const { saveDefaultSet } = require('./parameter-set-fixture.cjs');
const { verifySqlDocumentTabs } = require('./sql-document-tabs.cjs');
const { comparison, range, sort, verifyGridFilter } = require('./relational-grid.cjs');
const { openFromObjectSearch } = require('./relational-object-search.cjs');
const { verifyDefinitionPanel } = require('./relational-definition.cjs');

const port = Number(process.env.STACKPORT_SQL_SERVER_PORT);
const ca = process.env.STACKPORT_SQL_SERVER_CA;
const testStrict = process.env.STACKPORT_SQL_SERVER_TEST_STRICT === '1';
const testRun = randomBytes(6).toString('hex');
const database = `StackPortFixture_${testRun}`;
const account = `stackport_catalog_${testRun}`;
const secret = 'StackPort-reader-Q8!f2';

async function verify(page, hiddenObject, exportFolder) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(15_000);
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'SQL Server 실제 서버 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await chooseDatabase(page, 'SQL Server');
  const create = page.getByRole('dialog', { name: 'SQL Server 연결 추가', exact: true });
  await create.getByLabel('연결 이름').fill('계정 권한 검증');
  await create.getByLabel('호스트 이름 또는 IP').fill('localhost');
  await create.getByLabel('포트').fill(String(port));
  await create.getByLabel('데이터베이스 이름').fill(database);
  await create.getByLabel('인증 방식').selectOption('windows');
  assert.equal(await create.getByLabel('로그인 이름').count(), 0);
  await create.getByLabel('인증 방식').selectOption('sql_login');
  await create.getByLabel('로그인 이름').fill(account);
  await create.getByLabel('환경').selectOption('PROD');
  await create.getByLabel('CA 인증서 경로 (선택)').fill(ca);
  await create.getByRole('button', { name: '저장', exact: true }).click();
  await create.waitFor({ state: 'detached' });

  const explorer = page.getByRole('complementary', { name: '작업 공간 탐색기', exact: true });
  await explorer.getByRole('button', { name: 'SQL Server 계정 권한 검증 열기', exact: true }).waitFor();
  assert.equal(await explorer.getByRole('button', { name: '데이터베이스 연결 목록', exact: true }).getAttribute('aria-description'), '연결 1개');
  assert.equal(await explorer.getByRole('button', { name: 'SQL Server', exact: true }).count(), 0);

  const [profile] = await command('list_sql_server_profiles', { projectId: project.id });
  assert.equal(profile.settings.database, database);
  assert.doesNotMatch(JSON.stringify(profile), /password|StackPort-reader/);
  const alternate = changes => command('create_sql_server_profile', { projectId: project.id, input: { ...profile.settings, ...changes } });
  const open = (target, password = secret, confirmation = 'PROD') => command('open_sql_server', { profileId: target.id, revision: target.revision, password, confirmation });
  await assert.rejects(open(profile, secret, ''), /PROD/);
  await assert.rejects(open(profile, 'wrong-password'), /인증/);
  await assert.rejects(open(await alternate({ name: '미등록 CA', ca_path: null })), /TLS/);
  await assert.rejects(open(await alternate({ name: '다른 호스트 이름', host: '127.0.0.1' })), /TLS/);

  const session = await open(profile);
  assert.equal(session.database, database);
  assert.match(session.version, /^\d+[.]\d+[.]/);
  const { id } = session;
  let generatedTable;
  try {
    const schemas = search => command('sql_server_schemas', { id, search, page: 0 });
    assert.deepEqual((await schemas('')).items, ['archive', 'catalog']);
    assert.deepEqual((await schemas('%')).items, []);
    await verifySqlExecution(command, id);
    await verifySqlParameters(command, id);
    const objects = await command('sql_server_objects', { id, schema: 'catalog', search: '', page: 0 });
    assert.deepEqual(objects.items.map(row => [row.kind, row.name]), [['table', 'metadata_only'], ['table', 'order]daily'], ['view', 'recent']]);
    const table = objects.items.find(row => row.name === 'order]daily');
    await verifyStructureCommands(command, id, table, objects.items[0], hiddenObject);
    const search = (overrides = {}) => command('sql_server_search_objects', { id, input: {
      schema: null, field: 'name', kind: null, term: 'order]daily', page: 0, ...overrides,
    } });
    assert.deepEqual((await search()).items.map(row => [row.schema, row.name]), [
      ['archive', 'order]daily'], ['catalog', 'order]daily'],
    ]);
    assert.deepEqual((await search({ schema: 'catalog' })).items.map(row => row.id), [table.id]);
    assert.deepEqual((await search({ term: 'hidden_data' })).items, []);
    assert.deepEqual((await search({ field: 'column', term: '%_' })).items.map(row => row.schema), ['archive']);
    assert.deepEqual((await search({ field: 'column', term: '%_', schema: 'catalog' })).items, []);
    const paged = { schema: 'archive', term: 'match_', field: 'column', kind: 'view' };
    const matchingViews = await search(paged);
    assert.equal(matchingViews.items.length, 50);
    assert.equal(matchingViews.items.at(-1).name, 'report_50');
    assert.equal(matchingViews.has_next, true);
    const remaining = await search({ ...paged, page: 1 });
    assert.deepEqual(remaining.items.map(row => row.name), ['report_51']);
    assert.equal(remaining.has_next, false);
    const data = (object, page, clauses) => command('sql_server_data', { id, object, page, clauses });
    const columns = await command('sql_server_columns', { id, object: table.id });
    assert.equal(columns.items.find(row => row.name === 'exact_value').data_type, 'decimal(30,6)');
    assert.equal(columns.items.find(row => row.name === 'seq').identity, true);
    const first = await data(table.id, 0);
    assert.equal(first.rows.length, 50);
    assert.equal(first.stable_order, true);
    assert.equal(first.has_next, true);
    assert.equal(first.rows[0][0].text, '9223372036854775807');
    assert.equal(first.rows[0][2].text, '123456789012345678901234.567890');
    assert.deepEqual(first.rows[0][3], { text: '00FF11', encoding: 'hex', bytes: 3, truncated: false });
    assert.equal(first.rows[0][4].text, '한'.repeat(255) + '🚀');
    assert.equal(first.rows[0][4].truncated, true);
    assert.equal(first.rows[0][5].text, '2026-09-18T04:12:33.123456');
    assert.equal(first.rows[1][3], null);
    const last = await data(table.id, 1);
    assert.equal(last.rows.length, 11);
    assert.equal(last.rows[0][0].text, '9223372036854775757');
    assert.equal(last.has_next, false);
    const view = objects.items.find(row => row.kind === 'view');
    const definition = object => command('sql_server_definition', { id, object });
    assert.equal(await definition(view.id),
      'CREATE VIEW [catalog].[recent] AS\r\nSELECT id, seq, exact_value FROM [catalog].[order]]daily] WHERE seq <= 2\r\n-- 한글 정의');
    await assert.rejects(definition(table.id), /외래 키 대상/);
    await assert.rejects(definition(hiddenObject), /공개되지/);
    await assert.rejects(definition(remaining.items[0].id), /VIEW DEFINITION/);
    const archiveObject = async term => (await search({ schema: 'archive', term, kind: 'table' })).items[0].id;
    await assert.rejects(definition(await archiveObject('accounts')), /VIEW DEFINITION/);
    await assert.rejects(definition(await archiveObject('analytics_fixture')), /COLUMNSTORE/);
    assert.match(await definition(objects.items[0].id), /CREATE TABLE \[catalog\]\.\[metadata_only\]/);
    generatedTable = await definition(await archiveObject('script]sample'));
    assert.match(generatedTable, /CREATE TABLE \[archive\]\.\[script\]\]sample\]/);
    assert.match(generatedTable, /IDENTITY\(100, 7\) NOT FOR REPLICATION/);
    assert.match(generatedTable, /\[금액\] decimal\(30,6\).*DEFAULT/);
    assert.match(generatedTable, /\[scaled\] AS .* PERSISTED/);
    assert.match(generatedTable, /xml\(DOCUMENT \[archive\]\.\[fixture_xml\]\)/);
    assert.match(generatedTable, /MASKED WITH \(FUNCTION = 'email\(\)'\)/);
    assert.match(generatedTable, /PRIMARY KEY CLUSTERED \(\[id\] DESC\) WITH \(FILLFACTOR = 85\)/);
    assert.match(generatedTable, /INCLUDE \(\[payload\]\) WHERE .*\[title\].*IS NOT NULL/);
    assert.match(generatedTable, /REFERENCES \[archive\]\.\[accounts\] \(\[tenant\], \[account\]\) ON DELETE NO ACTION ON UPDATE CASCADE NOT FOR REPLICATION/);
    assert.match(generatedTable, /ALTER INDEX \[ix_script_disabled\] .* DISABLE;/);
    const sealed = (await search({ schema: 'archive', term: 'sealed_report', kind: 'view' })).items[0];
    await assert.rejects(definition(sealed.id), /암호화/);
    assert.equal((await data(view.id, 0)).stable_order, false);
    await assert.rejects(data(view.id, 1), /기본 키/);
    await assert.rejects(data(hiddenObject, 0), /공개되지/);
    await assert.rejects(data(objects.items[0].id, 0), /조회 권한/);
    const typed = {
      filters: [comparison('exact_value', 'eq', '123456789012345678901234.567890'),
        range('logged_at', '2026-09-18T04:12:33.123455', '2026-09-18T04:12:33.123457')],
      conjunction: 'all',
      sort: [sort('payload', 'asc', 'last'), sort('id', 'asc')],
    };
    const sorted = await data(table.id, 0, typed);
    assert.equal(sorted.rows[0][0].text, '9223372036854775807');
    assert.equal(sorted.rows[1][0].text, '9223372036854775747');
    assert.equal(sorted.has_next, true);
    assert.match(sorted.query_sql, /CASE WHEN sp_source.\[payload\] IS NULL/);
    assert.doesNotMatch(sorted.query_sql, /123456789012345678901234/);
    assert.equal((await data(table.id, 1, typed)).rows.length, 11);
    const keyless = await data(view.id, 0, { filters: [], conjunction: 'all', sort: [sort('id', 'asc')] });
    assert.equal(keyless.rows[0][0].text, '9223372036854775806');
    assert.equal(keyless.has_next, false);
    const matched = await data(table.id, 0, {
      filters: [{ column: 'title', condition: { kind: 'contains', value: 'row 6' } },
        { column: 'payload', condition: { kind: 'is_not_null' } }],
      conjunction: 'any', sort: [],
    });
    assert.equal(matched.rows.length, 3);
    await verifyExportCommands(command, id, profile, exportFolder, {
      table: table.id, view: view.id, hidden: hiddenObject, metadataOnly: objects.items[0].id,
      wide: await archiveObject('export_fixture'),
      oversized: (await search({ schema: 'archive', term: 'oversized_export' })).items[0].id,
      variant: (await search({ schema: 'archive', term: 'variant_export' })).items[0].id,
    });
  } finally { await command('close_sql_server', { id }); }
  await assert.rejects(command('sql_server_schemas', { id, search: '', page: 0 }), /닫혔습니다/);

  if (testStrict) {
    const strict = await open(await alternate({ name: '엄격한 TLS', encryption: 'strict' }));
    try { assert.equal(strict.database, database); }
    finally { await command('close_sql_server', { id: strict.id }); }
    const strictUnknownIssuer = await alternate({ name: '엄격한 TLS의 미등록 CA', encryption: 'strict', ca_path: null });
    await assert.rejects(open(strictUnknownIssuer), /TLS/);
  }

  const workspace = page.getByRole('region', { name: 'SQL Server 작업 공간', exact: true });
  await workspace.getByRole('button', { name: 'SQL Server 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'SQL Server 연결', exact: true });
  await login.getByLabel('SQL Server 암호').fill(secret);
  assert.equal(await login.getByRole('button', { name: '연결', exact: true }).isEnabled(), false);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  const detail = await openFromObjectSearch(page, workspace, 'SQL Server', {
    schema: 'catalog', name: 'order]daily', kind: '테이블', term: 'logged_at', field: 'column',
  });
  await detail.getByRole('button', { name: '데이터', exact: true }).click();
  const grid = detail.getByRole('table', { name: 'SQL Server 데이터 미리보기', exact: true });
  await grid.getByText('9223372036854775807', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '다음 데이터 페이지', exact: true }).click();
  await grid.getByText('9223372036854775757', { exact: true }).waitFor();
  await verifyGridFilter(page, detail, grid, 'id', '9223372036854775807');
  const exportedFile = path.join(exportFolder, 'filtered-ui.json');
  await detail.getByRole('button', { name: '결과 내보내기', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '결과 내보내기', exact: true });
  await exportDialog.getByLabel('파일 형식').selectOption('JSON');
  await exportDialog.getByLabel('새 JSON 파일 경로', { exact: true }).fill(exportedFile);
  await exportDialog.getByRole('button', { name: 'JSON 저장', exact: true }).click();
  await exportDialog.waitFor({ state: 'detached' });
  await detail.getByRole('status').getByText(/JSON 저장 완료 · 1행/).waitFor();
  const [exportedRow] = JSON.parse(fs.readFileSync(exportedFile, 'utf8')).rows;
  assert.equal(exportedRow[0], '9223372036854775807');
  assert.equal(exportedRow[4], '한'.repeat(255) + '🚀next');
  await detail.getByRole('button', { name: '열 구조', exact: true }).click();
  await detail.getByRole('table', { name: 'SQL Server 열 구조', exact: true }).getByText('decimal(30,6)', { exact: true }).waitFor();
  await verifyStructurePanel(workspace, detail);
  await workspace.getByRole('button', { name: 'recent 뷰', exact: true }).click();
  await detail.getByText('기본 키가 없어 최대 50행을 한 번에 표시합니다.', { exact: true }).waitFor();
  assert.match(await verifyDefinitionPanel(page, detail, 'SQL Server'), /AS\r\nSELECT/);
  const tableDetail = await openFromObjectSearch(page, workspace, 'SQL Server', {
    schema: 'archive', name: 'script]sample', kind: '테이블', term: 'script]sample',
  });
  const script = await verifyDefinitionPanel(page, tableDetail, 'SQL Server', '생성 SQL');
  assert.equal(script, generatedTable);
  const observer = await open(profile);
  try { await verifySqlEditor(workspace, command, observer.id); }
  finally { await command('close_sql_server', { id: observer.id }); }
  await tableDetail.getByRole('heading', { name: 'script]sample', exact: true }).waitFor();
  await workspace.getByRole('button', { name: 'SQL Server 연결 끊기', exact: true }).click();
  await detail.waitFor({ state: 'detached' });
  const replayDatabase = database + '_replay';
  const { recreateSqlServerTable } = require('./sql-server-fixture.cjs');
  await recreateSqlServerTable({ port, ca, database: replayDatabase, account, script });
  const replay = await open(await alternate({ name: '생성 SQL 재실행 확인', database: replayDatabase }));
  try {
    const objects = await command('sql_server_objects', { id: replay.id, schema: 'archive', search: 'script]sample', page: 0 });
    const rebuilt = await command('sql_server_definition', { id: replay.id, object: objects.items[0].id });
    assert.equal(rebuilt, script);
  } finally { await command('close_sql_server', { id: replay.id }); }
  assert.deepEqual(errors, []);
}

async function verifySqlExecution(command, id) {
  const query = (sql, { confirmation = 'PROD', ...options } = {}) => command('run_sql_server_query', {
    id, requestId: randomUUID(), input: { sql, first_line: 1, cursor_line: null, confirmation }, ...options,
  });
  await assert.rejects(query('CREATE TABLE #unconfirmed (id int);', { confirmation: '' }), /PROD/);
  const script = await query(`
CREATE TABLE #steps (n int);
INSERT #steps VALUES (7);
GO
SELECT n FROM #steps;
SELECT n FROM #steps WHERE 1 = 0;
GO 2
SELECT CAST(-0.012340 AS decimal(12,6)) AS fixed, CONVERT(bigint, '9223372036854775807') AS big,
       CONVERT(nvarchar(max), N'한글 🚀') AS korean, 0x00FF11 AS bytes, CAST(NULL AS varbinary(max)) AS missing,
       CAST('2026-09-18T04:12:33.1234567+09:00' AS datetimeoffset(7)) AS with_offset,
       CAST('99999999999999999999999999999999999999' AS decimal(38,0)) AS scale_zero;
`);
  assert.equal(script.status, 'succeeded', JSON.stringify(script.error));
  assert.equal(script.completed_batches, 4);
  assert.equal(script.transaction, 'none_open');
  assert.deepEqual(script.result_sets.map(result => result.rows_received), [1, 0, 1, 0, 1]);
  assert.equal(script.result_sets[0].rows[0][0].text, '7');
  assert.equal(script.result_sets[1].columns[0].name, 'n');
  const [fixed, big, korean, bytes, missing, offset, scaleZero] = script.result_sets[4].rows[0];
  assert.equal(fixed.text, '-0.012340');
  assert.equal(big.text, '9223372036854775807');
  assert.equal(korean.text, '한글 🚀');
  assert.equal(bytes.encoding, 'hex');
  assert.equal(bytes.text, '00FF11');
  assert.equal(missing, null);
  assert.equal(offset.text, '2026-09-18 04:12:33.123456700 +09:00');
  assert.equal(scaleZero.text, '9'.repeat(38));

  const requestId = randomUUID();
  const rolledBack = await query('BEGIN TRAN; INSERT [archive].[execution_fixture] VALUES (10);', { requestId });
  assert.equal(rolledBack.transaction, 'rolled_back');
  const audit = (await command('list_audit_events', {})).events.find(event => event.correlation_id === requestId);
  assert.equal(audit.operation, 'sql_server.sql.execute');
  assert.equal(audit.outcome, 'succeeded');
  assert.doesNotMatch(JSON.stringify(audit), /execution_fixture|INSERT/);
  const present = async () => {
    const result = await query('SELECT id FROM [archive].[execution_fixture] ORDER BY id');
    assert.equal(result.status, 'succeeded');
    return result.result_sets[0].rows.map(row => row[0].text);
  };
  assert.deepEqual(await present(), []);
  const committed = await query(`BEGIN TRAN; INSERT [archive].[execution_fixture] VALUES (11); COMMIT; SELECT 11 AS committed;
GO
THROW 50009, 'batch error', 1;
GO
INSERT [archive].[execution_fixture] VALUES (12);`);
  assert.equal(committed.status, 'failed');
  assert.equal(committed.completed_batches, 1);
  assert.equal(committed.result_sets[0].rows[0][0].text, '11');
  assert.deepEqual(committed.error, { message: 'batch error', code: 50009, line: 3, procedure: null });
  assert.deepEqual(await present(), ['11']);
  const denied = await query('SELECT id FROM [private].[hidden_data];');
  assert.equal(denied.status, 'failed');
  assert.equal(denied.error.code, 229);

  const many = await query('SELECT id FROM [archive].[export_fixture] ORDER BY id;');
  assert.equal(many.status, 'succeeded');
  assert.equal(many.result_sets[0].rows_received, 121);
  assert.equal(many.result_sets[0].rows.length, 100);

  const timeoutId = randomUUID();
  const timedOut = await query(`BEGIN TRAN; INSERT [archive].[execution_fixture] VALUES (13);
SELECT @@TRANCOUNT AS open_transactions;
GO
WAITFOR DELAY '00:00:40';`, { requestId: timeoutId });
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(timedOut.completed_batches, 1);
  assert.equal(timedOut.result_sets[0].rows[0][0].text, '1');
  assert.ok(['confirmed', 'unconfirmed'].includes(timedOut.attention));
  assert.equal(timedOut.transaction, 'unknown');
  assert.equal(timedOut.audit_warning, false);
  const timeoutAudit = (await command('list_audit_events', {})).events.find(event => event.correlation_id === timeoutId);
  assert.equal(timeoutAudit.operation, 'sql_server.sql.execute.timeout');
  assert.equal(timeoutAudit.outcome, 'failed');
  assert.deepEqual(await present(), ['11']);
}

async function verifySqlEditor(workspace, command, observerId) {
  const mode = workspace.getByRole('group', { name: 'SQL Server 작업 보기' });
  await mode.getByRole('button', { name: 'SQL 편집기', exact: true }).click();
  const editorPane = workspace.getByRole('region', { name: 'SQL Server SQL 편집기', exact: true });
  const editor = editorPane.getByRole('textbox', { name: 'SQL Server SQL 문장', exact: true });
  const results = editorPane.getByRole('region', { name: 'SQL Server 실행 결과', exact: true });
  const grid = results.getByRole('table', { name: 'SQL Server SQL 결과 표', exact: true });
  await editor.fill('SELECT N\'first result\' AS answer;\nGO\nSELECT N\'second result\' AS answer;');
  await editorPane.getByRole('button', { name: '전체 실행', exact: true }).click();
  await grid.getByText('first result', { exact: true }).waitFor();
  await results.getByRole('combobox', { name: '결과 집합' }).selectOption('1');
  await grid.getByText('second result', { exact: true }).waitFor();
  await editor.press('Control+Home');
  await editor.press('Control+Enter');
  await grid.getByText('first result', { exact: true }).waitFor();
  assert.equal(await results.getByRole('combobox', { name: '결과 집합' }).count(), 0);
  await editor.press('Control+End');
  await editor.press('Shift+Home');
  await editorPane.getByRole('button', { name: '선택 실행', exact: true }).click();
  await grid.getByText('second result', { exact: true }).waitFor();

  await verifyBindForm(editorPane, editor, grid);
  assert.equal(await results.getByRole('combobox', { name: '결과 집합' }).count(), 0);

  await editor.fill(`INSERT [archive].[execution_fixture] VALUES (15);
WAITFOR DELAY '00:00:08'; INSERT [archive].[execution_fixture] VALUES (14);`);
  await editorPane.getByRole('button', { name: '전체 실행', exact: true }).click();
  const production = editorPane.getByRole('dialog', { name: '운영 SQL 실행 검토', exact: true });
  await production.getByLabel('운영 환경 확인', { exact: true }).fill('PROD');
  await production.getByRole('button', { name: 'SQL 실행', exact: true }).click();
  const cancel = editorPane.getByRole('button', { name: '실행 중단', exact: true });
  await cancel.waitFor();
  const started = performance.now();
  let running = false;
  while (performance.now() - started < 7000) {
    const marker = await command('run_sql_server_query', {
      id: observerId, requestId: randomUUID(),
      input: { sql: 'SELECT id FROM [archive].[execution_fixture] WHERE id = 15;', first_line: 1, cursor_line: null },
    });
    assert.equal(marker.status, 'succeeded', JSON.stringify(marker.error));
    if (marker.result_sets[0].rows_received === 1) {
      running = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(running, 'The server must commit the first statement before cancellation.');
  await cancel.click();
  const cancelStatus = results.getByRole('status');
  await cancelStatus.waitFor();
  assert.match(await cancelStatus.innerText(), /실행 중단[\s\S]*(서버가 중단 요청을 확인했습니다|서버의 중단 응답을 확인하지 못했습니다)/);
  assert.equal(await grid.count(), 0);
  const cancelAudit = (await command('list_audit_events', {})).events.find(event => event.operation === 'sql_server.sql.execute.cancel');
  assert.equal(cancelAudit.outcome, 'failed');
  await new Promise(resolve => setTimeout(resolve, 8500));
  const check = "SELECT N'after cancel' AS answer, COUNT(*) AS after_delay FROM [archive].[execution_fixture] WHERE id = 14;";
  await editor.fill(check);
  await editorPane.getByRole('button', { name: '전체 실행', exact: true }).click();
  await grid.getByText('after cancel', { exact: true }).waitFor();
  await grid.getByText('0', { exact: true }).waitFor();

  await mode.getByRole('button', { name: '객체 탐색', exact: true }).click();
  await mode.getByRole('button', { name: 'SQL 편집기', exact: true }).click();
  assert.equal(await editor.inputValue(), check);
  await grid.getByText('after cancel', { exact: true }).waitFor();
  await mode.getByRole('button', { name: '객체 탐색', exact: true }).click();
}

async function verifySqlParameters(command, id) {
  const input = (sql, parameters) => ({ sql, first_line: 1, cursor_line: null, parameters });
  const run = (target, requestId = randomUUID()) => command('run_sql_server_query', { id, requestId, input: target });
  const prepare = target => command('sql_server_query_parameters', { input: target });
  const param = (index, kind, value, masked = false) => ({ index, kind, value, masked });
  const content = "한글 🚀 ' ; -- literal";
  const sql = `SELECT @P3 AS value, @P1 AS big, @P12 AS exact, @P20 AS tiny, @P7 AS bytes, @P8 AS flag, @P6 AS missing, @P10 AS approximate;
SELECT @P3 AS again; -- @P64`;
  assert.deepEqual(await prepare(input(sql)), [1, 3, 6, 7, 8, 10, 12, 20]);
  const requestId = randomUUID();
  const outcome = await run(input(sql, [
    param(3, 'text', content, true), param(1, 'integer', '-9223372036854775808'),
    param(12, 'decimal', '99999999999999999999999999999999999999'),
    param(20, 'decimal', '0.12345678901234567890123456789012345678'),
    param(7, 'blob', '00ff'), param(8, 'boolean', 'true'), param(6, 'null'), param(10, 'real', '1.25'),
  ]), requestId);
  assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome.error));
  const [row] = outcome.result_sets[0].rows;
  assert.deepEqual(row.map(value => value?.text ?? null), [
    content, '-9223372036854775808', '9'.repeat(38), '0.12345678901234567890123456789012345678', '00FF', 'true', null, '1.25',
  ]);
  assert.equal(row[4].encoding, 'hex');
  assert.equal(outcome.result_sets[1].rows[0][0].text, content);
  const audit = (await command('list_audit_events', {})).events.find(event => event.correlation_id === requestId);
  assert.equal(audit.outcome, 'succeeded');
  assert.doesNotMatch(JSON.stringify(audit), /literal|9223372036854775808|SELECT/);

  const secret = 'private-parameter-error-value';
  const failed = await run(input("DECLARE @message nvarchar(2048) = @P1; THROW 50010, @message, 1;", [param(1, 'text', secret, true)]));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 50010);
  assert.doesNotMatch(JSON.stringify(failed), /private-parameter-error-value/);
  assert.match(failed.error.message, /서버 오류 상세를 숨겼습니다/);
  await assert.rejects(run(input('SELECT @P1;', [param(2, 'text', 'outside scope')])), /매개변수 값을 다시 확인/);
  await assert.rejects(run(input('SELECT @P1;', [param(1, 'integer', '9223372036854775808')])), /64비트 정수/);
  await assert.rejects(run(input('SELECT @P1;\nGO\nSELECT @P1;', [param(1, 'integer', '1')])), /배치 하나/);
  const ordinary = await run(input('DECLARE @P1 int = 42; SELECT @P1 AS local_variable;'));
  assert.equal(ordinary.result_sets[0].rows[0][0].text, '42');
}

async function verifyExportCommands(command, id, profile, folder, { table, view, hidden, metadataOnly, wide, oversized, variant }) {
  const read = file => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
  const emptyClauses = { filters: [], conjunction: 'all', sort: [] };
  const exportFile = (object, name, { format = 'json', clauses = emptyClauses, requestId = randomUUID() } = {}) =>
    command('export_sql_server', { id, requestId, object, clauses, options: {
      destination: path.join(folder, name), format, include_header: true, spreadsheet_safe: true,
    } });
  const requestId = randomUUID();
  const clauses = { filters: [comparison('id', 'ge', '2')], conjunction: 'all', sort: [sort('id', 'desc')] };
  const result = await exportFile(wide, 'all-columns.json', { clauses, requestId });
  assert.equal(result.status, 'exported');
  assert.equal(result.report.rows, 120);
  assert.equal(result.report.size_bytes, fs.statSync(path.join(folder, 'all-columns.json')).size);
  const output = read('all-columns.json');
  assert.equal(output.format, 'stackport.sqlserver-results');
  assert.equal(output.version, 1);
  assert.equal(output.columns.length, 72);
  assert.deepEqual(output.columns[2], { name: 'amount', data_type: 'decimal(38,6)' });
  assert.equal(output.columns[3].encoding, 'hex');
  assert.equal(output.columns.at(-1).name, 'extra_66');
  assert.deepEqual(output.rows.map(row => row[0]), Array.from({ length: 120 }, (_, index) => String(121 - index)));
  assert.deepEqual(output.rows[0].slice(0, 6), ['121', '한'.repeat(300) + '🚀끝',
    '-12345678901234567890123456789012.345678', null, '1', '2026-09-18T04:12:33.1234567+09:00']);
  assert.equal(output.rows[0].at(-1), '242');
  assert.equal(output.rows.at(-2)[1], null);
  assert.equal(output.rows.at(-1)[1], '');
  assert.equal(output.rows.at(-1)[3], '');
  const event = (await command('list_audit_events', {})).events.find(item => item.correlation_id === requestId);
  assert.deepEqual([event.operation, event.profile_id, event.environment, event.object_name, event.affected_count],
    ['sql_server.export.json', profile.id, 'PROD', '[archive].[export_fixture]', 120]);

  const csv = await exportFile(wide, 'protected.csv', { format: 'csv', clauses: {
    filters: [comparison('id', 'le', '3')], conjunction: 'all', sort: [],
  } });
  assert.equal(csv.report.rows, 3);
  assert.equal(csv.report.protected_fields, 1);
  const csvText = fs.readFileSync(path.join(folder, 'protected.csv'), 'utf8');
  assert.match(csvText, /1,"'=SUM\(1,2\)",-12345678901234567890123456789012\.345678,"X'00FF11'",1,/);
  assert.match(csvText, /2,"",-12345678901234567890123456789012\.345678,"X''",1,/);
  assert.match(csvText, /3,\\N,-12345678901234567890123456789012\.345678,\\N,1,/);
  await assert.rejects(exportFile(wide, 'protected.csv', { format: 'csv' }), /같은 이름의 파일이 이미 있습니다/);
  assert.equal(fs.readFileSync(path.join(folder, 'protected.csv'), 'utf8'), csvText);

  assert.equal((await exportFile(view, 'view.json')).report.rows, 2);
  assert.equal((await exportFile(view, 'empty.json', { clauses: {
    filters: [comparison('seq', 'gt', '9')], conjunction: 'all', sort: [],
  } })).report.rows, 0);
  assert.deepEqual(read('empty.json').rows, []);
  assert.deepEqual(read('empty.json').columns.map(column => column.name), ['id', 'seq', 'exact_value']);
  assert.equal((await exportFile(table, 'table.json')).report.rows, 61);
  assert.equal(read('table.json').rows[0][0], '9223372036854775807');
  for (const [object, name, error] of [
    [hidden, 'hidden.json', /공개되지/],
    [metadataOnly, 'denied.json', /조회 권한/],
    [oversized, 'oversized.json', /32 MiB/],
    [variant, 'variant.json', /sql_variant/],
  ]) {
    await assert.rejects(exportFile(object, name), error);
    assert.equal(fs.existsSync(path.join(folder, name)), false);
  }

  const cancelled = randomUUID();
  const { withLockedExportRow } = require('./sql-server-fixture.cjs');
  await withLockedExportRow({ port, ca, database }, async () => {
    const progress = () => command('sql_server_export_progress', { id, requestId: cancelled });
    const run = exportFile(wide, 'cancelled.json', { requestId: cancelled });
    const result = run.then(value => ({ value }), error => ({ error }));
    try {
      const until = Date.now() + 8000;
      while (!(await progress() > 0) && Date.now() < until) {
        const exited = await Promise.race([result, new Promise(resolve => setTimeout(resolve, 40))]);
        if (exited) assert.fail(`Export finished before the fixture released its row: ${JSON.stringify(exited)}`);
      }
      assert.ok(await progress() > 0, 'A partial result should reach the temporary file before the row lock.');
      assert.ok((await command('sql_server_schemas', { id, search: '', page: 0 })).items.includes('archive'));
      await assert.rejects(exportFile(wide, 'concurrent.json'), /이미 실행 중/);
      assert.equal(await command('cancel_sql_server_export', { id, requestId: randomUUID() }), false);
      assert.equal(await command('cancel_sql_server_export', { id, requestId: cancelled }), true);
      assert.deepEqual(await run, { status: 'cancelled' });
      assert.equal(await progress(), null);
      const schemas = await command('sql_server_schemas', { id, search: '', page: 0 });
      assert.ok(schemas.items.includes('archive'));
    } finally {
      await command('cancel_sql_server_export', { id, requestId: cancelled }).catch(() => {});
    }
  });
  const events = (await command('list_audit_events', {})).events;
  assert.equal(events.some(event => event.correlation_id === cancelled), false);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['all-columns.json', 'empty.json', 'protected.csv', 'table.json', 'view.json']);
  assert.equal((await exportFile(wide, 'after-cancel.json')).report.rows, 121);
}

async function verifyStructureCommands(command, id, table, metadataOnly, hiddenObject) {
  const read = (section, object = table.id, page = 0) => command('sql_server_structure', { id, object, section, page });
  const indexes = await read('indexes');
  assert.equal(indexes.section, 'indexes');
  const primary = indexes.items.find(item => item.name === 'fixture_pk');
  assert.deepEqual([primary.method, primary.primary_key, primary.unique, primary.partitions, primary.estimated_rows],
    ['CLUSTERED', true, true, 1, '61']);
  assert.deepEqual(primary.columns.map(column => [column.name, column.key_position, column.descending]),
    [['id', 1, true], ['seq', 2, false]]);
  const filtered = indexes.items.find(item => item.name === 'ix_fixture_filter');
  assert.equal(filtered.has_filter, true);
  assert.match(filtered.filter.text, /account_id.*IS NOT NULL/);
  assert.equal(filtered.filter.truncated, false);
  assert.deepEqual(filtered.columns.map(column => [column.name, column.key_position, column.descending, column.included]),
    [['exact_value', 1, true, false], ['logged_at', 2, false, false], ['seq', 0, null, true], ['account_id', 0, null, true]]);
  assert.equal(indexes.items.find(item => item.name === 'ix_fixture_disabled').disabled, true);
  assert.equal(indexes.items.find(item => item.name === 'uq_fixture_seq').unique_constraint, true);
  const archiveObject = async search => (await command('sql_server_objects', { id, schema: 'archive', search, page: 0 })).items[0].id;
  const columnstore = (await read('indexes', await archiveObject('analytics_fixture'))).items[0];
  assert.equal(columnstore.method, 'CLUSTERED COLUMNSTORE');
  assert.deepEqual(columnstore.columns.map(column => [column.name, column.key_position, column.descending, column.included]),
    [['event_id', 0, null, false], ['amount', 0, null, false]]);

  const constraints = await read('constraints');
  assert.equal(constraints.section, 'constraints');
  assert.deepEqual(constraints.items.map(item => [item.name, item.kind]),
    [['ck_fixture_amount', 'C'], ['df_fixture_badge', 'D'], ['fixture_pk', 'PK'], ['uq_fixture_seq', 'UQ']]);
  const check = constraints.items[0];
  assert.equal(check.disabled, true);
  assert.equal(check.untrusted, true);
  assert.match(check.expression.text, /exact_value/);
  assert.equal(constraints.items[1].column, 'badge');
  assert.match(constraints.items[1].expression.text, /7/);
  assert.deepEqual(constraints.items[2].columns.map(column => [column.name, column.descending]), [['id', true], ['seq', false]]);
  const disabled = (await read('constraints', await archiveObject('unique_disabled'))).items[0];
  assert.deepEqual([disabled.name, disabled.kind, disabled.disabled], ['uq_disabled_token', 'UQ', true]);
  const firstPage = await read('constraints', metadataOnly.id);
  assert.equal(firstPage.items.length, 50);
  assert.equal(firstPage.items.at(-1).name, 'check_50');
  assert.equal(firstPage.has_next, true);
  const lastPage = await read('constraints', metadataOnly.id, 1);
  assert.deepEqual(lastPage.items.map(item => item.name), ['check_51']);
  assert.equal(lastPage.has_next, false);

  const keys = await read('foreign_keys');
  assert.equal(keys.section, 'foreign_keys');
  assert.deepEqual(keys.items.map(item => [item.name, item.direction]), [
    ['fk_detail_order', 'incoming'], ['fk_fixture_account', 'outgoing'],
    ['fk_fixture_private', 'outgoing'], ['fk_fixture_self', 'self_reference'],
  ]);
  const incoming = keys.items[0];
  assert.equal(incoming.source.name, 'order_detail');
  assert.equal(incoming.target.id, table.id);
  assert.deepEqual(incoming.columns, [{ source: 'base_id', target: 'id' }, { source: 'base_seq', target: 'seq' }]);
  const related = keys.items[1];
  assert.deepEqual([related.target.schema, related.target.name, related.on_update, related.on_delete],
    ['archive', 'accounts', 'CASCADE', 'SET_NULL']);
  assert.deepEqual(related.columns, [{ source: 'account_region', target: 'tenant' }, { source: 'account_id', target: 'account' }]);
  assert.equal(keys.items[2].target, null);
  assert.deepEqual(keys.items[2].columns, [{ source: 'private_id', target: null }]);
  assert.doesNotMatch(JSON.stringify(keys), /hidden_data|hidden_order_detail/);
  await assert.rejects(read('indexes', hiddenObject), /공개되지/);
}

async function verifyStructurePanel(workspace, detail) {
  const open = () => detail.getByRole('button', { name: '키와 인덱스', exact: true }).click();
  const panel = detail.getByRole('region', { name: 'SQL Server 키와 인덱스', exact: true });
  const entry = name => panel.locator('summary').filter({ hasText: name }).locator('..');
  await open();
  const filtered = entry('ix_fixture_filter');
  await filtered.locator('summary').click();
  const included = filtered.getByRole('table', { name: 'ix_fixture_filter 구성', exact: true })
    .getByRole('row', { name: /seq.*포함 열/ });
  assert.equal(await included.getByRole('cell').nth(1).innerText(), '—');
  await filtered.getByLabel('인덱스 필터', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '제약조건', exact: true }).click();
  const check = entry('ck_fixture_amount');
  await check.getByText(/비활성.*기존 행 미검증/).waitFor();
  await panel.getByRole('button', { name: '외래 키', exact: true }).click();
  const restricted = entry('fk_fixture_private');
  await restricted.locator('summary').click();
  await restricted.getByText('현재 계정에 비공개', { exact: true }).waitFor();
  assert.equal(await restricted.getByRole('button', { name: /구조 열기/ }).count(), 0);
  const outgoing = entry('fk_fixture_account');
  await outgoing.locator('summary').click();
  await outgoing.getByRole('button', { name: 'archive.accounts 구조 열기', exact: true }).press('Enter');
  const accounts = detail.getByRole('heading', { name: 'accounts', exact: true });
  await accounts.waitFor();
  assert.ok(await accounts.evaluate(heading => document.activeElement === heading));
  await detail.getByRole('table', { name: 'SQL Server 열 구조', exact: true }).getByRole('rowheader', { name: 'tenant' }).waitFor();

  await open();
  await panel.getByRole('button', { name: '외래 키', exact: true }).click();
  const incoming = entry('fk_fixture_account');
  await incoming.locator('summary').click();
  await incoming.getByText('들어오는 외래 키', { exact: true }).waitFor();
  await incoming.getByRole('button', { name: 'catalog.order]daily 구조 열기', exact: true }).press('Enter');
  await workspace.getByRole('heading', { name: 'order]daily', exact: true }).waitFor();
}

async function verifyBindForm(pane, editor, grid) {
  const sql = "SELECT N'outside selection' AS marker;\nSELECT @P3 AS entered, @P7 AS amount;";
  const reopen = async () => {
    await editor.press('Control+End');
    await editor.press('Shift+Home');
    await pane.getByRole('button', { name: '매개변수 실행', exact: true }).click();
  };
  await editor.fill(sql);
  await reopen();
  const dialog = pane.page().getByRole('dialog', { name: 'SQL Server 매개변수', exact: true });
  const secret = dialog.getByLabel('@P3 값', { exact: true });
  const amount = dialog.getByLabel('@P7 값', { exact: true });
  await secret.fill('hidden-test-value');
  await dialog.getByRole('checkbox', { name: '@P3 값 숨기기' }).check();
  await dialog.getByRole('combobox', { name: '@P7 형식' }).selectOption('decimal');
  await amount.fill('-0.000123400');
  const sets = await saveDefaultSet(dialog, 'SQL Server 배치 기본값');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await reopen();
  await sets.getByText('숨김 값은 다시 입력하세요.', { exact: true }).waitFor();
  assert.equal(await secret.getAttribute('type'), 'password');
  assert.equal(await secret.inputValue(), '');
  assert.equal(await amount.inputValue(), '-0.000123400');
  const run = dialog.getByRole('button', { name: '매개변수로 실행', exact: true });
  assert.equal(await run.isEnabled(), false);
  await secret.fill('한글 🚀');
  await run.click();
  await dialog.waitFor({ state: 'detached' });
  await grid.getByText('한글 🚀', { exact: true }).waitFor();
  await grid.getByText('-0.000123400', { exact: true }).waitFor();
  assert.equal(await editor.inputValue(), sql);
  const page = pane.page();
  await page.getByRole('button', { name: '최근 SQL', exact: true }).click();
  const history = page.getByRole('dialog', { name: '최근 SQL', exact: true });
  await history.getByRole('list', { name: '실행 기록 목록' }).getByText('선택 영역 · 완료', { exact: true }).waitFor();
  await history.getByRole('button', { name: 'SQL 원문 표시', exact: true }).click();
  assert.equal(await history.getByLabel('실행한 SQL 원문', { exact: true }).textContent(), "SELECT @P3 AS entered, @P7 AS amount;");
  await history.getByRole('button', { name: '닫기', exact: true }).click();
  await history.waitFor({ state: 'detached' });
}

async function verifyMockBindEditor(page) {
  page.setDefaultTimeout(15_000);
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'SQL Server 바인드 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  const sql = 'SELECT @P3 AS entered, @P7 AS amount;';
  const selected = await command('sql_server_query_parameters', {
    input: { sql, first_line: 2, cursor_line: null }, withScope: true,
  });
  assert.deepEqual(selected.parameters, [3, 7]);
  const current = await command('sql_server_query_parameters', {
    input: { sql: "SELECT '@P5';\nGO\n" + sql, first_line: 1, cursor_line: 3 }, withScope: true,
  });
  assert.equal(current.parameter_scope, selected.parameter_scope);
  assert.deepEqual(await command('sql_server_query_parameters', {
    input: { sql, first_line: 2, cursor_line: null },
  }), [3, 7]);

  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const fetchNative = window.fetch.bind(window);
    const responses = {
      open_sql_server: () => ({ id: 'tds-editor-fixture', database: 'sample', version: 'fixture', context: 'fixture' }),
      sql_server_schemas: () => ({ items: ['dbo'], has_next: false }),
      sql_server_objects: () => ({ items: [], has_next: false }),
      close_sql_server: () => null,
      run_sql_server_query: ({ id, input }) => {
        const [text, decimal] = input.parameters;
        if (id !== 'tds-editor-fixture' || input.first_line !== 2 || input.cursor_line !== null ||
            input.sql !== 'SELECT @P3 AS entered, @P7 AS amount;' ||
            text.index !== 3 || text.kind !== 'text' || text.value !== '한글 🚀' || !text.masked ||
            decimal.index !== 7 || decimal.kind !== 'decimal' || decimal.value !== '-0.000123400' || decimal.masked) {
          throw new Error('Invalid restored T-SQL bindings');
        }
        return {
          status: 'succeeded', completed_batches: 1, elapsed_ms: 5, more_sets: false, error: null, transaction: 'none_open',
          result_sets: [{
            columns: [{ name: 'entered', data_type: 'nvarchar' }, { name: 'amount', data_type: 'decimal' }],
            rows: [[text.value, decimal.value].map(value => ({ text: value, encoding: 'utf8', bytes: null, truncated: false }))],
            rows_received: 1, more_columns: false,
          }],
        };
      },
    };
    const routes = new Map(Object.entries(responses).map(([name, reply]) => [bridge.convertFileSrc(name, 'ipc'), reply]));
    window.fetch = async (resource, options) => {
      if (!routes.has(resource)) return fetchNative(resource, options);
      try {
        return Response.json(routes.get(resource)(JSON.parse(options.body)), { headers: { 'Tauri-Response': 'ok' } });
      } catch (error) {
        return Response.json(error.message, { headers: { 'Tauri-Response': 'error' } });
      }
    };
  });
  await chooseDatabase(page, 'SQL Server');
  const profile = page.getByRole('dialog', { name: 'SQL Server 연결 추가', exact: true });
  await profile.getByLabel('연결 이름').fill('SQL Server 바인드 픽스처');
  await profile.getByLabel('호스트 이름 또는 IP').fill('localhost');
  await profile.getByLabel('데이터베이스 이름').fill('sample');
  await profile.getByLabel('인증 방식').selectOption('sql_login');
  await profile.getByLabel('로그인 이름').fill('fixture');
  await profile.getByRole('button', { name: '저장', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'SQL Server 작업 공간', exact: true });
  await workspace.getByRole('button', { name: 'SQL Server 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'SQL Server 연결', exact: true });
  await login.getByLabel('SQL Server 암호', { exact: true }).fill('synthetic-fixture');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  await workspace.getByRole('button', { name: 'SQL 편집기', exact: true }).click();
  await verifySqlDocumentTabs(page, workspace, 'SQL Server SQL 문장');
  const pane = workspace.getByRole('region', { name: 'SQL Server SQL 편집기', exact: true });
  const input = pane.getByRole('textbox', { name: 'SQL Server SQL 문장', exact: true });
  const batch = "DROP TABLE dbo.fixture_only;\nGO\nUPDATE dbo.fixture_only SET x = 1\nGO 3\nSELECT 1;";
  await input.fill(batch);
  await pane.getByRole('button', { name: '전체 실행', exact: true }).click();
  const risk = page.getByRole('dialog', { name: 'SQL 실행 검토', exact: true });
  await risk.getByText('1줄 · DROP', { exact: true }).waitFor();
  await risk.getByText('3줄 · UPDATE · 3회 실행', { exact: true }).waitFor();
  await risk.getByRole('button', { name: '취소', exact: true }).click();
  await risk.waitFor({ state: 'detached' });
  await input.press('Control+End');
  await input.press('Home');
  await input.press('ArrowUp');
  await input.press('ArrowUp');
  await pane.getByRole('button', { name: '현재 배치 실행', exact: true }).click();
  await risk.getByText('3줄 · UPDATE', { exact: true }).waitFor();
  assert.equal(await risk.getByText('1줄 · DROP', { exact: true }).count(), 0);
  await risk.getByRole('button', { name: '취소', exact: true }).click();
  await risk.waitFor({ state: 'detached' });
  await verifyBindForm(pane, input,
    pane.getByRole('table', { name: 'SQL Server SQL 결과 표', exact: true }));
}

async function main() {
  if (process.env.STACKPORT_SQL_SERVER_TEST_MOCK_BIND_EDITOR === '1') {
    const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
    try { await verifyMockBindEditor(browser.contexts()[0].pages()[0]); }
    finally { await browser.close(); }
    console.log('SQL Server binding editor Windows E2E passed with mocked SQL execution IPC.');
    return;
  }
  assert.ok(Number.isInteger(port) && port >= 1024 && path.isAbsolute(ca));
  const { seedSqlServer } = require('./sql-server-fixture.cjs');
  const hidden = await seedSqlServer({ port, ca, database, account, password: secret });
  assert.ok(Number.isInteger(hidden) && hidden !== 0);
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
  const backupDir = process.env.STACKPORT_SQL_SERVER_BACKUP_DIR;
  const onlyBackup = process.env.STACKPORT_SQL_SERVER_BACKUP_ONLY === '1';
  const exportFolder = fs.mkdtempSync(path.join(process.env.STACKPORT_TEST_ROOT || os.tmpdir(), 'stackport-sql-export-'));
  try {
    const page = browser.contexts()[0].pages()[0];
    if (!onlyBackup) {
      await verify(page, hidden, exportFolder);
      console.log(`SQL Server Windows E2E passed (${testStrict ? 'required and strict TLS' : 'required TLS'}, object search, keys and indexes, table DDL round-trip, view definitions, permissions, data filters and paging, CSV and JSON streaming and cancellation, T-SQL execution, rollback, and typed parameter binding).`);
    }
    if (onlyBackup || backupDir) {
      assert.ok(backupDir);
      await verifyBackup(page, backupDir);
      console.log('SQL Server Windows backup and restore E2E passed (server paths, limited roles, preserved media, checksum verification, restore conflicts, and restored data).');
    }
  }
  finally {
    await browser.close();
    for (const file of fs.readdirSync(exportFolder)) fs.unlinkSync(path.join(exportFolder, file));
    fs.rmdirSync(exportFolder);
  }
}

async function verifyBackup(page, directory) {
  const { withAdmin } = require('./sql-server-fixture.cjs');
  const admin = action => withAdmin({ port, ca }, action);
  const sql = (execute, command) => execute(command).then(rows => rows.map(row => row.map(cell => cell.value)));
  const literal = value => "N'" + value.replaceAll("'", "''") + "'";
  const identify = value => "[" + value.replaceAll("]", "]]") + "]";
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'SQL Server 디스크 백업 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await chooseDatabase(page, 'SQL Server');
  const create = page.getByRole('dialog', { name: 'SQL Server 연결 추가', exact: true });
  await create.getByLabel('연결 이름').fill('격리 SQL Server');
  await create.getByLabel('호스트 이름 또는 IP').fill('localhost');
  await create.getByLabel('포트').fill(String(port));
  await create.getByLabel('데이터베이스 이름').fill(database);
  await create.getByLabel('인증 방식').selectOption('sql_login');
  await create.getByLabel('로그인 이름').fill('sa');
  await create.getByLabel('환경').selectOption('PROD');
  await create.getByLabel('CA 인증서 경로 (선택)').fill(ca);
  await create.getByRole('button', { name: '저장', exact: true }).click();
  await create.waitFor({ state: 'detached' });
  const [saved] = await command('list_sql_server_profiles', { projectId: project.id });
  const reader = await command('create_sql_server_profile', {
    projectId: project.id, input: { ...saved.settings, name: '백업 역할 검사', username: account },
  });
  const open = (profile, password) => command('open_sql_server', { profileId: profile.id, revision: profile.revision, password, confirmation: 'PROD' });
  const { id } = await open(reader, secret);
  const preview = (changes = {}) => command('preview_sql_server_backup', { id, options: { directory, compression: false, ...changes } });
  const run = (plan, args = {}) => command('run_sql_server_backup', {
    id, requestId: randomUUID(), token: plan.token, approved: true, confirmation: 'PROD', ...args,
  });
  const verify = (id, path, position, expectedName = null) => command('verify_sql_server_backup', {
    id, requestId: randomUUID(), input: { path, position, expected_name: expectedName },
  });
  let restrictedArchive;
  try {
    const capability = await command('sql_server_backup_capabilities', { id });
    assert.equal(capability.database, database);
    assert.equal(capability.disk_supported, true);
    assert.equal(capability.can_backup, false);
    await assert.rejects(preview(), /BACKUP DATABASE/);
    await assert.rejects(command('preview_sql_server_restore', {
      id, options: { path: directory.replace(/[\\/]$/, '') + (directory.startsWith('/') ? '/' : '\\') + 'no-access.bak',
        position: 1, database: database + '_restricted' },
    }), /복원.*권한/);
    await admin(execute => execute(`USE ${identify(database)}; ALTER ROLE [db_backupoperator] ADD MEMBER ${identify(account)};`));
    assert.equal((await command('sql_server_backup_capabilities', { id })).can_backup, true);
    await assert.rejects(preview({ directory: 'relative/path' }), /절대 경로/);
    const collision = await preview();
    await admin(execute => execute(`BACKUP DATABASE ${identify(database)} TO DISK = ${literal(collision.path)}
      WITH COPY_ONLY, CHECKSUM, NOFORMAT, NOINIT, NAME = N'fixture-existing-media';`));
    const preserved = await run(collision);
    assert.equal(preserved.status, 'failed', JSON.stringify(preserved));
    assert.match(preserved.message, /같은 이름/, JSON.stringify(preserved));
    await admin(async execute => {
      const rows = await execute(`RESTORE HEADERONLY FROM DISK = ${literal(collision.path)}`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0][0].value, 'fixture-existing-media');
    });
    const plan = await preview();
    await assert.rejects(run(plan, { approved: false }), /서버 파일 경로/);
    await assert.rejects(run(plan, { confirmation: '' }), /PROD/);
    restrictedArchive = await run(plan);
    assert.equal(restrictedArchive.status, 'succeeded', JSON.stringify(restrictedArchive));
    assert.equal(restrictedArchive.path, plan.path);
    assert.equal(restrictedArchive.audit_warning, false);
    await assert.rejects(run(plan), /미리보기/);
    assert.equal((await verify(id, plan.path, 1, restrictedArchive.backup_name)).status, 'failed');
  } finally { await command('close_sql_server', { id }); }

  const password = process.env.STACKPORT_SQL_SERVER_SA_PASSWORD;
  await page.getByRole('complementary', { name: '작업 공간 탐색기', exact: true })
    .getByRole('button', { name: 'SQL Server 격리 SQL Server 열기', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'SQL Server 작업 공간', exact: true });
  await workspace.getByRole('button', { name: 'SQL Server 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'SQL Server 연결', exact: true });
  await login.getByLabel('SQL Server 암호').fill(password);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  await workspace.getByRole('button', { name: 'DB 백업', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'SQL Server 백업 관리', exact: true });
  const folder = dialog.getByLabel('서버의 백업 폴더');
  await dialog.getByRole('button', { name: '백업 미리보기', exact: true }).waitFor();
  await folder.fill(directory);
  await dialog.getByRole('checkbox', { name: '백업 압축', exact: true }).check();
  await dialog.getByRole('button', { name: '백업 미리보기', exact: true }).click();
  const start = dialog.getByRole('button', { name: '백업 실행', exact: true });
  assert.equal(await start.isDisabled(), true);
  await dialog.getByRole('checkbox', { name: '백업할 DB와 서버 파일 경로를 확인했습니다.' }).check();
  assert.equal(await start.isDisabled(), true);
  await dialog.getByLabel('운영 확인 문구 PROD').fill('PROD');
  await start.click();
  await dialog.getByRole('status').filter({ hasText: '서버에 백업을 저장했습니다.' }).waitFor();
  await dialog.getByRole('button', { name: '이 백업 검증' }).click();
  const archive = await dialog.getByLabel('서버의 백업 파일 경로').inputValue();
  assert.ok(archive.startsWith(directory.replace(/[\\/]$/, '') + (directory.startsWith('/') ? '/' : '\\')));
  await dialog.getByRole('button', { name: '파일 검증', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '백업 체크섬 검증 완료' }).waitFor();
  await dialog.getByText('1 · 전체 DB · COPY_ONLY', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '닫기', exact: true }).last().click();

  const { id: adminId } = await open(saved, password);
  try {
    const checked = await verify(adminId, restrictedArchive.path, 1, restrictedArchive.backup_name);
    assert.equal(checked.status, 'succeeded', JSON.stringify(checked));
    assert.equal(checked.set.database, database);
    assert.equal(checked.set.backup_type, 1);
    assert.equal(checked.set.has_checksums, true);
    assert.equal(checked.set.copy_only, true);
    assert.equal((await verify(adminId, archive, 2)).status, 'failed');
    assert.equal((await verify(adminId, archive, 1, 'wrong-archive')).status, 'failed');
    const readable = archive.replace(/stackport-[a-f0-9]+\.bak$/, `fixture-${testRun}-readable.bak`);
    assert.notEqual(readable, archive);
    await admin(execute => execute(`BACKUP DATABASE ${identify(database)} TO DISK = ${literal(readable)}
      WITH COPY_ONLY, NO_CHECKSUM, NOFORMAT, NOINIT, NAME = N'fixture-readable';`));
    const readability = await verify(adminId, readable, 1, 'fixture-readable');
    assert.equal(readability.status, 'succeeded', JSON.stringify(readability));
    assert.equal(readability.set.has_checksums, false);
  } finally { await command('close_sql_server', { id: adminId }); }

  const { id: restoreId } = await open(saved, password);
  const restoreOptions = { path: archive, position: 1, database: database + '_Review' };
  const previewRestore = (changes = {}) => command('preview_sql_server_restore', {
    id: restoreId, options: { ...restoreOptions, ...changes },
  });
  const runRestore = (plan, changes = {}) => command('run_sql_server_restore', {
    id: restoreId, requestId: randomUUID(), token: plan.token, database: plan.database, approved: true, confirmation: 'PROD', ...changes,
  });
  try {
    await assert.rejects(previewRestore({ database }), /같은 이름/);
    await assert.rejects(previewRestore({ position: 2 }), /백업 세트/);
    await assert.rejects(previewRestore({ data_directory: 'relative' }), /절대 경로/);
    const plan = await previewRestore();
    assert.equal(plan.set.database, database);
    assert.equal(plan.set.has_checksums, true);
    assert.ok(plan.files.some(file => file.source.kind === 'D'));
    assert.ok(plan.files.some(file => file.source.kind === 'L'));
    assert.ok(plan.files.every(file => /^[1-9][0-9]*$/.test(file.source.size_bytes)));
    await assert.rejects(runRestore(plan, { database: database }), /새 DB 이름/);
    await assert.rejects(runRestore(plan, { approved: false }), /파일 위치/);
    await assert.rejects(runRestore(plan, { confirmation: '' }), /PROD/);
    await admin(async execute => {
      await execute(`CREATE DATABASE ${identify(plan.database)}`);
      await execute(`CREATE TABLE ${identify(plan.database)}.dbo.fixture_protected (id int);`);
      await execute(`INSERT ${identify(plan.database)}.dbo.fixture_protected VALUES (463);`);
    });
    const nameConflict = await runRestore(plan);
    assert.equal(nameConflict.status, 'failed', JSON.stringify(nameConflict));
    assert.match(nameConflict.message, /같은 이름/);
    assert.equal(nameConflict.restore.staging_database, null);
    await admin(async execute => {
      assert.deepEqual(await sql(execute, `SELECT id FROM ${identify(plan.database)}.dbo.fixture_protected`), [[463]]);
      assert.deepEqual(await sql(execute, `SELECT DB_ID(${literal(plan.staging_database)})`), [[null]]);
    });
    await assert.rejects(runRestore(plan), /미리보기/);

    const filePlan = await previewRestore({ database: database + '_FileConflict' });
    const occupiedFile = filePlan.files[0].destination;
    await admin(execute => execute(`BACKUP DATABASE ${identify(database)} TO DISK = ${literal(occupiedFile)}
      WITH COPY_ONLY, CHECKSUM, NOFORMAT, NOINIT, NAME = N'fixture-existing-restore-path';`));
    const fileConflict = await runRestore(filePlan);
    assert.equal(fileConflict.status, 'failed', JSON.stringify(fileConflict));
    assert.match(fileConflict.message, /같은 경로/);
    assert.equal(fileConflict.restore.staging_database, null);
    await admin(async execute => {
      const rows = await execute(`RESTORE HEADERONLY FROM DISK = ${literal(occupiedFile)}`);
      assert.equal(rows[0][0].value, 'fixture-existing-restore-path');
    });

    const mutableArchive = archive.replace(/stackport-[a-f0-9]+\.bak$/, `fixture-${testRun}-changed.bak`);
    assert.notEqual(mutableArchive, archive);
    const writeArchive = name => admin(execute => execute(`BACKUP DATABASE ${identify(database)} TO DISK = ${literal(mutableArchive)}
      WITH COPY_ONLY, CHECKSUM, FORMAT, NAME = ${literal(name)};`));
    await writeArchive('fixture-reviewed-set');
    const mediaPlan = await previewRestore({ path: mutableArchive, database: database + '_ChangedMedia' });
    await writeArchive('fixture-replaced-set');
    const mediaConflict = await runRestore(mediaPlan);
    assert.equal(mediaConflict.status, 'failed', JSON.stringify(mediaConflict));
    assert.match(mediaConflict.message, /백업 세트.*바뀌었습니다/);
    assert.equal(mediaConflict.restore.staging_database, null);
  } finally { await command('close_sql_server', { id: restoreId }); }

  await admin(execute => execute(`USE master; CREATE USER ${identify(account)} FOR LOGIN ${identify(account)};
    GRANT CREATE DATABASE TO ${identify(account)}; GRANT ALTER ANY DATABASE TO ${identify(account)};`));
  const { id: delegated } = await open(reader, secret);
  try {
    const options = { ...restoreOptions, database: database + '_Delegated' };
    const preview = () => command('preview_sql_server_restore', { id: delegated, options });
    await assert.rejects(preview(), /CONNECT ANY DATABASE/);
    await admin(execute => execute(`GRANT CONNECT ANY DATABASE TO ${identify(account)};`));
    const plan = await preview();
    const applied = await command('run_sql_server_restore', {
      id: delegated, requestId: randomUUID(), token: plan.token, database: plan.database, approved: true, confirmation: 'PROD',
    });
    assert.equal(applied.status, 'succeeded', JSON.stringify(applied));
    assert.equal(applied.restore.staging_database, null);
  } finally { await command('close_sql_server', { id: delegated }); }

  const target = database + '_복원]DB';
  await workspace.getByRole('button', { name: 'DB 복원', exact: true }).click();
  const restore = page.getByRole('dialog', { name: 'SQL Server DB 복원', exact: true });
  await restore.getByLabel('서버의 백업 파일 경로').fill(archive);
  await restore.getByLabel('새 데이터베이스 이름').fill(target);
  await restore.getByText('복원 파일 폴더 지정', { exact: true }).click();
  await restore.getByLabel('서버의 데이터 파일 폴더').fill(directory);
  await restore.getByLabel('서버의 로그 파일 폴더').fill(directory);
  await restore.getByRole('button', { name: '복원 미리보기', exact: true }).click();
  const apply = restore.getByRole('button', { name: '복원 실행', exact: true });
  await apply.waitFor();
  assert.equal(await apply.isDisabled(), true);
  await restore.getByText('서버의 복원 파일 2개', { exact: true }).waitFor();
  await restore.getByText('1 · 전체 DB · 체크섬 있음', { exact: true }).waitFor();
  await restore.getByRole('checkbox', { name: '원본 백업과 새 DB의 파일 위치를 확인했습니다.' }).check();
  await restore.getByLabel('새 DB 이름 확인').fill(target);
  assert.equal(await apply.isDisabled(), true);
  await restore.getByLabel('운영 확인 문구 PROD').fill('PROD');
  await apply.click();
  await restore.getByRole('status').filter({ hasText: '새 데이터베이스에 복원했습니다.' }).waitFor();
  await admin(async execute => {
    const [row] = await sql(execute, `SELECT COUNT(*), CONVERT(varchar(25),MAX(id)), MAX(CASE WHEN seq=1 THEN CONVERT(varchar(16),payload,2) END)
        FROM ${identify(target)}.[catalog].[order]]daily];`);
    assert.deepEqual(row, [61, '9223372036854775807', '00FF11']);
    assert.deepEqual(await sql(execute, `SELECT state_desc FROM sys.databases WHERE name=${literal(target)}`), [['ONLINE']]);
    const files = await sql(execute, `SELECT physical_name FROM sys.master_files WHERE database_id=DB_ID(${literal(target)})`);
    assert.equal(files.length, 2);
    assert.ok(files.every(([file]) => file.startsWith(directory.replace(/[\\/]$/, '') + (directory.startsWith('/') ? '/' : '\\'))));
  });
  const { events } = await command('list_audit_events', { before: null });
  const actions = events.filter(event => event.operation.startsWith('sql_server.backup'));
  assert.ok(actions.some(event => event.operation === 'sql_server.backup' && event.outcome === 'succeeded'));
  assert.ok(actions.some(event => event.operation === 'sql_server.backup.verify' && event.outcome === 'succeeded'));
  assert.doesNotMatch(JSON.stringify(actions), /\.bak|StackPortFixture_|fixture-existing-media/);
  const restores = events.filter(event => event.operation === 'sql_server.restore');
  assert.ok(restores.some(event => event.outcome === 'succeeded'));
  assert.ok(restores.some(event => event.outcome === 'failed'));
  assert.doesNotMatch(JSON.stringify(restores), /\.bak|StackPortFixture_|stackport_restore_/);
}

main().catch(cause => { console.error(cause); process.exitCode = 1; });
