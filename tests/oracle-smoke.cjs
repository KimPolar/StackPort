const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { chooseDatabase } = require('./database-picker.cjs');
const { comparison, range, sort, verifyGridFilter } = require('./relational-grid.cjs');
const { openFromObjectSearch } = require('./relational-object-search.cjs');
const { verifyDefinitionPanel } = require('./relational-definition.cjs');

const port = Number(process.env.STACKPORT_ORACLE_PORT);
const service = process.env.STACKPORT_ORACLE_SERVICE || 'FREEPDB1';
const sid = process.env.STACKPORT_ORACLE_TEST_SID;
const tcpsPort = Number(process.env.STACKPORT_ORACLE_TCPS_PORT);
const ca = process.env.STACKPORT_ORACLE_CA;
const tcpOnly = process.env.STACKPORT_ORACLE_TEST_TCP_ONLY === '1';
const run = randomBytes(6).toString('hex').toUpperCase();
const owner = 'SP_OWNER_' + run;
const reader = 'SP_READER_' + run;
const password = 'StackPortReader84Za';
const ownerPassword = 'StackPortOwner84Za';
const engine = 'Oracle Database';

async function verify(page, hiddenObject, exportFolder) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(15_000);
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'Oracle 실제 서버 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await chooseDatabase(page, engine);
  const form = page.getByRole('dialog', { name: engine + ' 연결 추가', exact: true });
  await form.getByLabel('연결 이름').fill('계정 권한 검증');
  await form.getByLabel('호스트 이름 또는 IP').fill('localhost');
  await form.getByLabel('접속 대상 종류').selectOption('sid');
  assert.equal(await form.getByLabel('SID', { exact: true }).count(), 1);
  await form.getByLabel('접속 대상 종류').selectOption('service_name');
  await form.getByLabel('서비스 이름', { exact: true }).fill(service);
  await form.getByLabel('사용자 이름').fill(reader);
  await form.getByLabel('환경').selectOption('PROD');
  assert.equal(await form.getByLabel('전송 방식').inputValue(), 'tcps');
  if (tcpOnly) await form.getByLabel('전송 방식').selectOption('tcp');
  await form.getByLabel('포트').fill(String(tcpOnly ? port : tcpsPort));
  if (!tcpOnly) await form.getByLabel('CA 인증서 경로 (선택)').fill(ca);
  await form.getByRole('button', { name: '저장', exact: true }).click();
  await form.waitFor({ state: 'detached' });

  const explorer = page.getByRole('complementary', { name: '작업 공간 탐색기', exact: true });
  await explorer.getByRole('button', { name: engine + ' 계정 권한 검증 열기', exact: true }).waitFor();
  assert.equal(await explorer.getByRole('button', { name: '데이터베이스 연결 목록', exact: true }).getAttribute('aria-description'), '연결 1개');
  assert.equal(await explorer.getByRole('button', { name: engine, exact: true }).count(), 0);

  const [profile] = await command('list_oracle_profiles', { projectId: project.id });
  assert.doesNotMatch(JSON.stringify(profile), /password|StackPortReader/);
  const other = changes => command('create_oracle_profile', { projectId: project.id, input: { ...profile.settings, ...changes } });
  const open = (target, secret = password, confirmation = 'PROD') => command('open_oracle', { profileId: target.id, revision: target.revision, password: secret, confirmation });
  await assert.rejects(open(profile, password, ''), /PROD/);
  await assert.rejects(open(profile, 'Incorrect85Z'), /암호/);
  if (!tcpOnly) {
    await assert.rejects(open(await other({ name: '미등록 CA', ca_path: null })), /TCPS/);
    await assert.rejects(open(await other({ name: '호스트 이름 불일치', host: '127.0.0.1' })), /TCPS/);
    const tcp = await open(await other({ name: 'TCP', transport: 'tcp', port, ca_path: null }));
    try { assert.match(tcp.version, /^\d+[.]/); }
    finally { await command('close_oracle', { id: tcp.id }); }
  }
  if (sid) {
    const instance = await open(await other({ name: 'SID', target: 'sid', service: sid,
      username: 'C##SP_SID_' + run, transport: 'tcp', port, ca_path: null }));
    try { assert.match(instance.version, /^\d+[.]/); }
    finally { await command('close_oracle', { id: instance.id }); }
  }
  const session = await open(profile);
  assert.equal(session.database.toUpperCase(), service.toUpperCase());
  const { id } = session;
  try {
    const schemas = await command('oracle_schemas', { id, search: 'sp_owner_', page: 0 });
    assert.deepEqual(schemas.items, [owner]);
    assert.deepEqual((await command('oracle_schemas', { id, search: '%', page: 0 })).items, []);
    const catalog = (await command('oracle_objects', { id, schema: owner, search: '', page: 0 })).items;
    const objects = catalog.filter(item => ['Daily Summary', 'Order Daily', 'Recent View'].includes(item.name));
    assert.deepEqual(objects.map(item => [item.name, item.kind]), [
      ['Daily Summary', 'materialized_view'], ['Order Daily', 'table'], ['Recent View', 'view'],
    ]);
    const table = objects[1].id;
    const definition = object => command('oracle_definition', { id, object });
    await assert.rejects(definition(table), /메타데이터 권한/);
    await assert.rejects(definition(hiddenObject), /공개되지/);
    const search = (overrides = {}) => command('oracle_search_objects', { id, input: {
      schema: null, field: 'name', kind: null, term: 'order daily', page: 0, ...overrides,
    } });
    assert.deepEqual((await search()).items.map(row => [row.schema, row.kind]), [
      [owner, 'table'], [reader, 'view'],
    ]);
    assert.deepEqual((await search({ schema: owner })).items.map(row => row.id), [table]);
    assert.deepEqual((await search({ schema: owner, kind: 'view' })).items, []);
    assert.deepEqual((await search({ schema: owner, kind: 'materialized_view', term: '' })).items
      .map(row => row.name), ['Daily Summary']);
    assert.deepEqual((await search({ term: 'hidden_data' })).items, []);
    assert.deepEqual((await search({ field: 'column', term: '%_' })).items
      .map(row => [row.schema, row.name]), [[reader, 'Order Daily']]);
    const data = (object, page, clauses) => command('oracle_data', { id, object, page, clauses });
    const columns = await command('oracle_columns', { id, object: table });
    assert.equal(columns.items.find(column => column.name === 'EXACT_VALUE').data_type, 'NUMBER(30,6)');
    const first = await data(table, 0);
    assert.equal(first.rows.length, 50);
    assert.equal(first.stable_order, true);
    assert.equal(first.has_next, true);
    assert.equal(first.rows[0][1].text, '9223372036854775747');
    assert.equal(first.rows[0][2].text, '123456789012345678901234.567891');
    assert.deepEqual(first.rows[0][3], { text: '00FFA1', encoding: 'hex', bytes: 3, truncated: false });
    assert.equal(first.rows[0][4].text, '한'.repeat(255) + '🚀');
    assert.equal(first.rows[0][4].truncated, true);
    assert.equal(first.rows[0][5].text, '2026-09-18T04:12:33.123456');
    assert.deepEqual(first.rows[0][6], { text: 'a'.repeat(256), encoding: 'utf8', bytes: null, truncated: true });
    assert.equal(first.rows[0][7].text, '00FF11');
    assert.equal(first.rows[1][3], null);
    const next = await data(table, 1);
    assert.equal(next.rows.length, 11);
    assert.equal(next.rows[0][1].text, '9223372036854775797');
    assert.equal(next.has_next, false);
    assert.equal((await data(objects[0].id, 0)).rows[0][1].text, '61');
    assert.equal((await data(objects[2].id, 0)).stable_order, false);
    await assert.rejects(data(objects[2].id, 1), /기본 키/);
    await assert.rejects(data(hiddenObject, 0), /공개되지/);
    const typed = {
      filters: [comparison('EXACT_VALUE', 'eq', '123456789012345678901234.567891'),
        range('LOGGED_AT', '2026-09-18T04:12:33.123455', '2026-09-18T04:12:33.123457')],
      conjunction: 'all',
      sort: [sort('PAYLOAD', 'asc', 'last'), sort('ID', 'desc')],
    };
    const sorted = await data(table, 0, typed);
    assert.equal(sorted.rows[0][1].text, '9223372036854775747');
    assert.equal(sorted.rows[1][1].text, '9223372036854775807');
    assert.equal(sorted.has_next, true);
    assert.match(sorted.query_sql, /NULLS LAST/);
    assert.doesNotMatch(sorted.query_sql, /123456789012345678901234/);
    assert.equal((await data(table, 1, typed)).rows.length, 11);
    const found = await data(table, 0, {
      filters: [{ column: 'LONG_NOTE', condition: { kind: 'contains', value: 'a'.repeat(200) } }],
      conjunction: 'all', sort: [],
    });
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0][1].text, '9223372036854775747');
    await verifyExports(command, id, profile, exportFolder, catalog, hiddenObject);
  } finally { await command('close_oracle', { id }); }
  await assert.rejects(command('oracle_schemas', { id, search: '', page: 0 }), /닫혔습니다/);
  const owned = await open(await other({ name: '소유자 정의 확인', username: owner }), ownerPassword);
  try {
    const objects = await command('oracle_objects', { id: owned.id, schema: owner, search: '', page: 0 });
    const definition = async name => command('oracle_definition', { id: owned.id,
      object: objects.items.find(object => object.name === name).id });
    const table = await definition('Order Daily');
    assert.match(table, /CREATE TABLE\s+"SP_OWNER_[A-F0-9]+"\."Order Daily"/);
    assert.match(table, /PRIMARY KEY\s*\("TENANT",\s*"ID"\)/);
    assert.match(await definition('Recent View'), /VIEW\s+"SP_OWNER_[A-F0-9]+"\."Recent View"/);
    assert.match(await definition('Daily Summary'), /CREATE MATERIALIZED VIEW\s+"SP_OWNER_[A-F0-9]+"\."Daily Summary"/);
  } finally { await command('close_oracle', { id: owned.id }); }

  const workspace = page.getByRole('region', { name: engine + ' 작업 공간', exact: true });
  await workspace.getByRole('button', { name: engine + ' 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: engine + ' 연결', exact: true });
  await login.getByLabel(engine + ' 암호').fill(password);
  assert.equal(await login.getByRole('button', { name: '연결', exact: true }).isEnabled(), false);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  const detail = await openFromObjectSearch(page, workspace, engine, {
    schema: owner, name: 'Order Daily', kind: '테이블', term: 'logged_at', field: 'column',
  });
  await detail.getByRole('button', { name: '데이터', exact: true }).click();
  const grid = detail.getByRole('table', { name: engine + ' 데이터 미리보기', exact: true });
  await grid.getByText('9223372036854775747', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '다음 데이터 페이지', exact: true }).click();
  await grid.getByText('9223372036854775797', { exact: true }).waitFor();
  await verifyGridFilter(page, detail, grid, 'ID', '9223372036854775747');
  const exportedFile = path.join(exportFolder, 'filtered-ui.json');
  await detail.getByRole('button', { name: '결과 내보내기', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '결과 내보내기', exact: true });
  await exportDialog.getByLabel('파일 형식').selectOption('JSON');
  await exportDialog.getByLabel('새 JSON 파일 경로', { exact: true }).fill(exportedFile);
  await exportDialog.getByRole('button', { name: 'JSON 저장', exact: true }).click();
  await exportDialog.waitFor({ state: 'detached' });
  await detail.getByRole('status').getByText(/JSON 저장 완료 · 1행/).waitFor();
  const [exportedRow] = JSON.parse(fs.readFileSync(exportedFile, 'utf8')).rows;
  assert.equal(exportedRow[1], '9223372036854775747');
  assert.equal(exportedRow[4], '한'.repeat(255) + '🚀next');
  assert.deepEqual(exportedRow.slice(6), ['a'.repeat(700), '00FF11']);
  await detail.getByRole('button', { name: '열 구조', exact: true }).click();
  await detail.getByRole('table', { name: engine + ' 열 구조', exact: true }).getByText('NUMBER(30,6)', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: 'Daily Summary 구체화 뷰', exact: true }).click();
  await grid.getByText('61', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '정의 SQL', exact: true }).click();
  await detail.getByRole('alert').filter({ hasText: '메타데이터 권한' }).waitFor();
  const ownView = await openFromObjectSearch(page, workspace, engine, {
    schema: reader, name: 'Order Daily', kind: '뷰', term: '%_', field: 'column',
  });
  const ownDefinition = await verifyDefinitionPanel(page, ownView, engine);
  assert.match(ownDefinition, /"X%_Y"/);
  assert.match(ownDefinition, /"한글 정의"/);
  await workspace.getByRole('button', { name: engine + ' 연결 끊기', exact: true }).click();
  await detail.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
}

async function verifyExports(command, id, profile, folder, catalog, hiddenObject) {
  const objectId = name => catalog.find(item => item.name === name)?.id;
  const read = name => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
  const emptyClauses = { filters: [], conjunction: 'all', sort: [] };
  const save = (object, name, { format = 'json', clauses = emptyClauses, requestId = randomUUID() } = {}) =>
    command('export_oracle', { id, object, requestId, clauses, options: {
      destination: path.join(folder, name), format, include_header: true, spreadsheet_safe: true,
    } });
  const wide = objectId('Export Fixture');
  const requestId = randomUUID();
  const clauses = { filters: [comparison('ID', 'ge', '2')], conjunction: 'all', sort: [sort('ID', 'desc')] };
  const result = await save(wide, 'wide.json', { clauses, requestId });
  assert.equal(result.status, 'exported');
  assert.equal(result.report.rows, 120);
  assert.equal(result.report.size_bytes, fs.statSync(path.join(folder, 'wide.json')).size);
  const full = read('wide.json');
  assert.equal(full.format, 'stackport.oracle-results');
  assert.equal(full.version, 1);
  assert.equal(full.columns.length, 75);
  assert.deepEqual(full.columns[2], { name: 'AMOUNT', data_type: 'NUMBER(38,6)' });
  assert.equal(full.columns[4].encoding, 'hex');
  assert.equal(full.columns.at(-1).name, 'EXTRA_66');
  assert.deepEqual(full.rows.map(row => row[0]), Array.from({ length: 120 }, (_, i) => String(121 - i)));
  const first = full.rows[0];
  assert.equal(first[1], 'a'.repeat(21844) + '🚀' + '한'.repeat(20000) + '\n끝');
  assert.equal(first[2], '-12345678901234567890123456789012.345678');
  assert.equal(first[4], Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('hex').toUpperCase().repeat(280));
  assert.match(first[5], /^2026-09-18T04:12:33\.123456789\+09:00\[Asia\/Seoul\]$/i);
  assert.equal(first[6], '2026-09-17T19:12:33.123456789Z');
  assert.equal(first[7], 'P2DT3H4M5.123456789S');
  assert.equal(first[8], '국'.repeat(23000) + '🚀終');
  assert.equal(first.at(-1), '242');
  assert.equal(full.rows.at(-2)[1], null);
  assert.equal(full.rows.at(-1)[1], '');
  assert.equal(full.rows.at(-1)[4], '');
  const event = (await command('list_audit_events', {})).events.find(item => item.correlation_id === requestId);
  assert.deepEqual([event.operation, event.profile_id, event.environment, event.object_name, event.affected_count],
    ['oracle.export.json', profile.id, 'PROD', `"${owner}"."Export Fixture"`, 120]);

  const csv = await save(wide, 'safe.csv', { format: 'csv', clauses: {
    filters: [comparison('ID', 'le', '3')], conjunction: 'all', sort: [],
  } });
  assert.equal(csv.report.rows, 3);
  assert.equal(csv.report.protected_fields, 1);
  const csvPath = path.join(folder, 'safe.csv');
  const csvText = fs.readFileSync(csvPath, 'utf8');
  assert.match(csvText, /1,"'=SUM\(1,2\)",-12345678901234567890123456789012\.345678,"X'00FF11'",\\N,/);
  assert.match(csvText, /2,"",-12345678901234567890123456789012\.345678,\\N,"X''",/);
  assert.match(csvText, /3,\\N,-12345678901234567890123456789012\.345678,\\N,\\N,/);
  await assert.rejects(save(wide, 'safe.csv', { format: 'csv' }), /같은 이름의 파일이 이미 있습니다/);
  assert.equal(fs.readFileSync(csvPath, 'utf8'), csvText);
  assert.equal((await save(objectId('Recent View'), 'view.json')).report.rows, 2);
  assert.equal((await save(objectId('Daily Summary'), 'materialized.json')).report.rows, 1);
  assert.deepEqual(read('materialized.json').rows, [['1', '61']]);
  const native = objectId('Native Scalars');
  if (native !== undefined) {
    await save(native, 'native.json');
    const [row] = read('native.json').rows;
    assert.deepEqual(row.slice(0, 2), ['true', '1.25']);
    assert.match(row[2], /12345678901234567890123456789012345678/);
    assert.deepEqual(JSON.parse(row[2]).a, [null, true]);
    assert.equal(JSON.parse(row[2]).s, '한글');
    assert.deepEqual(row.slice(3), ['null', null]);
  }
  for (const [object, name, error] of [
    [hiddenObject, 'hidden.json', /공개되지/],
    [objectId('Oversize Export'), 'oversize.json', /32 MiB/],
    [objectId('Unsupported Export'), 'unsupported.json', /BFILE/],
  ]) {
    await assert.rejects(save(object, name), error);
    assert.equal(fs.existsSync(path.join(folder, name)), false);
  }

  const cancelled = randomUUID();
  const progress = () => command('oracle_export_progress', { id, requestId: cancelled });
  const cancel = requestId => command('cancel_oracle_export', { id, requestId });
  const stopped = save(objectId('Late Export'), 'cancelled.json', { requestId: cancelled,
    clauses: { ...emptyClauses, sort: [sort('ID', 'asc')] } });
  const settled = stopped.then(value => ({ value }), error => ({ error: String(error) }));
  try {
    const until = Date.now() + 10_000;
    while (!(await progress() > 0) && Date.now() < until) {
      const exited = await Promise.race([settled, new Promise(resolve => setTimeout(resolve, 40))]);
      if (exited) assert.fail(`Export finished before it could be interrupted: ${JSON.stringify(exited)}`);
    }
    assert.ok(await progress() > 0);
    await assert.rejects(save(wide, 'concurrent.json'), /이미 실행 중/);
    assert.ok((await command('oracle_schemas', { id, search: owner, page: 0 })).items.includes(owner));
    assert.equal(await cancel(randomUUID()), false);
    assert.equal(await cancel(cancelled), true);
    assert.deepEqual(await stopped, { status: 'cancelled' });
    assert.equal(await progress(), null);
  } finally { await cancel(cancelled).catch(() => {}); }
  assert.equal(fs.existsSync(path.join(folder, 'cancelled.json')), false);
  assert.ok(fs.readdirSync(folder).every(file => !file.startsWith('.stackport-')));
  assert.equal((await save(wide, 'after-cancel.json')).report.rows, 121);
}

async function main() {
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  if (!tcpOnly) {
    assert.ok(Number.isInteger(tcpsPort) && tcpsPort >= 1024 && tcpsPort <= 65535 && port !== tcpsPort);
    assert.ok(ca && path.isAbsolute(ca));
  }
  assert.ok(process.env.STACKPORT_ORACLE_SYS_PASSWORD);
  const python = process.env.STACKPORT_TEST_PYTHON || 'python';
  const object = Number(execFileSync(python, [path.join(__dirname, 'oracle-fixture.py'), String(port), run, service], {
    encoding: 'utf8', windowsHide: true, timeout: 90_000,
  }).trim());
  assert.ok(Number.isSafeInteger(object) && object > 0);
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
  const exportFolder = fs.mkdtempSync(path.join(process.env.STACKPORT_TEST_ROOT || os.tmpdir(), 'stackport-oracle-export-'));
  try { await verify(browser.contexts()[0].pages()[0], object, exportFolder); }
  finally {
    await browser.close();
    for (const file of fs.readdirSync(exportFolder)) fs.unlinkSync(path.join(exportFolder, file));
    fs.rmdirSync(exportFolder);
  }
  console.log(`Oracle Windows E2E passed (${tcpOnly ? 'native TCP' : 'native TCP and TCPS'}, scoped object search, object definitions, permissions, native values, filters, sorting, saved conditions and paging, CSV and JSON exports with cancellation).`);
}

main().catch(cause => { console.error(cause); process.exitCode = 1; });
