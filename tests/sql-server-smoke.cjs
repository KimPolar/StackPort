const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { chooseDatabase } = require('./database-picker.cjs');
const { seedSqlServer } = require('./sql-server-fixture.cjs');

const port = Number(process.env.STACKPORT_SQL_SERVER_PORT);
const ca = process.env.STACKPORT_SQL_SERVER_CA;
const testStrict = process.env.STACKPORT_SQL_SERVER_TEST_STRICT === '1';
const testRun = randomBytes(6).toString('hex');
const database = `StackPortFixture_${testRun}`;
const account = `stackport_catalog_${testRun}`;
const secret = 'StackPort-reader-Q8!f2';

async function verify(page, hiddenObject) {
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
  try {
    const schemas = search => command('sql_server_schemas', { id, search, page: 0 });
    assert.deepEqual((await schemas('')).items, ['catalog']);
    assert.deepEqual((await schemas('%')).items, []);
    const objects = await command('sql_server_objects', { id, schema: 'catalog', search: '', page: 0 });
    assert.deepEqual(objects.items.map(row => [row.kind, row.name]), [['table', 'metadata_only'], ['table', 'order]daily'], ['view', 'recent']]);
    const table = objects.items.find(row => row.name === 'order]daily');
    const data = (object, page) => command('sql_server_data', { id, object, page });
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
    assert.equal((await data(view.id, 0)).stable_order, false);
    await assert.rejects(data(view.id, 1), /기본 키/);
    await assert.rejects(data(hiddenObject, 0), /공개되지/);
    await assert.rejects(data(objects.items[0].id, 0), /조회 권한/);
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
  await workspace.getByRole('button', { name: 'catalog', exact: true }).click();
  await workspace.getByRole('button', { name: 'order]daily 테이블', exact: true }).click();
  const detail = workspace.getByRole('region', { name: 'SQL Server 객체 상세', exact: true });
  const grid = detail.getByRole('table', { name: 'SQL Server 데이터 미리보기', exact: true });
  await grid.getByText('9223372036854775807', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '다음 데이터 페이지', exact: true }).click();
  await grid.getByText('9223372036854775757', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '열 구조', exact: true }).click();
  await detail.getByRole('table', { name: 'SQL Server 열 구조', exact: true }).getByText('decimal(30,6)', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: 'recent 뷰', exact: true }).click();
  await detail.getByText('기본 키가 없어 최대 50행을 한 번에 표시합니다.', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: 'SQL Server 연결 끊기', exact: true }).click();
  await detail.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
}

async function main() {
  assert.ok(Number.isInteger(port) && port >= 1024 && path.isAbsolute(ca));
  const hidden = await seedSqlServer({ port, ca, database, account, password: secret });
  assert.ok(Number.isInteger(hidden) && hidden !== 0);
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
  try { await verify(browser.contexts()[0].pages()[0], hidden); }
  finally { await browser.close(); }
  console.log(`SQL Server Windows E2E passed (${testStrict ? 'required and strict TLS' : 'required TLS'}, login, metadata visibility, native values and paging).`);
}

main().catch(cause => { console.error(cause); process.exitCode = 1; });
