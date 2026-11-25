const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { chooseDatabase } = require('./database-picker.cjs');
const { comparison, range, sort, verifyGridFilter } = require('./relational-grid.cjs');
const { openFromObjectSearch } = require('./relational-object-search.cjs');

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
const engine = 'Oracle Database';

async function verify(page, hiddenObject) {
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
    const objects = await command('oracle_objects', { id, schema: owner, search: '', page: 0 });
    assert.deepEqual(objects.items.map(item => [item.name, item.kind]), [
      ['Daily Summary', 'materialized_view'], ['Order Daily', 'table'], ['Recent View', 'view'],
    ]);
    const table = objects.items[1].id;
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
    assert.equal((await data(objects.items[0].id, 0)).rows[0][1].text, '61');
    assert.equal((await data(objects.items[2].id, 0)).stable_order, false);
    await assert.rejects(data(objects.items[2].id, 1), /기본 키/);
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
  } finally { await command('close_oracle', { id }); }
  await assert.rejects(command('oracle_schemas', { id, search: '', page: 0 }), /닫혔습니다/);

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
  await detail.getByRole('button', { name: '열 구조', exact: true }).click();
  await detail.getByRole('table', { name: engine + ' 열 구조', exact: true }).getByText('NUMBER(30,6)', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: 'Daily Summary 구체화 뷰', exact: true }).click();
  await grid.getByText('61', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: engine + ' 연결 끊기', exact: true }).click();
  await detail.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
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
  try { await verify(browser.contexts()[0].pages()[0], object); }
  finally { await browser.close(); }
  console.log(`Oracle Windows E2E passed (${tcpOnly ? 'native TCP' : 'native TCP and TCPS'}, scoped object search, permissions, native values, filters, sorting, saved conditions and paging).`);
}

main().catch(cause => { console.error(cause); process.exitCode = 1; });
