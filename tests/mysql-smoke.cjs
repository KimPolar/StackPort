const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');

const root = process.env.STACKPORT_TEST_ROOT;
const binary = process.env.STACKPORT_MYSQL_BIN;
const openssl = process.env.STACKPORT_TEST_OPENSSL || 'openssl';
const maria = process.env.STACKPORT_MYSQL_ENGINE === 'MariaDB';
const engine = maria ? 'MariaDB' : 'MySQL';
const secret = 'stackport-mysql-catalog-test';
const rootPassword = 'stackport-mariadb-root-test';
const binaryDir = path.dirname(binary);
const client = path.join(binaryDir, maria ? 'mariadb.exe' : 'mysql.exe');
assert.ok(path.isAbsolute(root) && path.isAbsolute(binary));

function run(file, args, options = {}) {
  return execFileSync(file, args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 90_000, ...options });
}

async function availablePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function certificates() {
  const ca = path.join(root, 'ca.pem');
  const cert = path.join(root, 'server.pem');
  const key = path.join(root, 'server.key');
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', 'ca.key', '-out', ca,
    '-subj', '/CN=StackPort MySQL Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', 'server.csr', '-subj', '/CN=localhost']);
  fs.writeFileSync(path.join(root, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  run(openssl, ['x509', '-req', '-in', 'server.csr', '-CA', ca, '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-out', cert, '-extfile', 'server.ext']);
  return { ca, cert, key };
}

function admin(port, sql) {
  return run(client, ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root',
    maria ? '--skip-ssl' : '--ssl-mode=DISABLED', '--batch', '--silent', '--skip-column-names'], {
    env: { ...process.env, MYSQL_PWD: maria ? rootPassword : '' }, input: sql, timeout: 10_000,
  });
}

async function stopServer(server, port) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const stopped = once(server, 'exit');
  try { admin(port, 'SHUTDOWN;'); } catch { server.kill(); }
  await Promise.race([stopped, delay(5000, undefined, { ref: false })]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill();
    await stopped;
  }
}

async function fixture() {
  const port = await availablePort();
  const tls = certificates();
  const base = path.dirname(binaryDir);
  const data = path.join(root, 'data');
  if (maria) run(path.join(binaryDir, 'mariadb-install-db.exe'), [`--datadir=${data}`, `--password=${rootPassword}`, `--port=${port}`]);
  else run(binary, ['--no-defaults', '--initialize-insecure', `--basedir=${base}`, `--datadir=${data}`]);
  const args = ['--no-defaults', `--basedir=${base}`, `--datadir=${data}`, '--bind-address=127.0.0.1', `--port=${port}`,
    `--ssl-ca=${tls.ca}`, `--ssl-cert=${tls.cert}`, `--ssl-key=${tls.key}`, `--log-error=${path.join(root, 'server.log')}`];
  if (!maria) args.push('--mysqlx=OFF', '--no-monitor');
  const server = spawn(binary, args, { cwd: root, windowsHide: true, stdio: 'ignore' });
  try {
    let connected = false;
    for (let attempt = 0; attempt < 80 && server.exitCode === null; attempt++) {
      try { connected = admin(port, 'SELECT 1;').trim() === '1'; } catch {}
      if (connected) break;
      await delay(250);
    }
    assert.ok(connected, 'The isolated ' + engine + ' server did not start.');
    admin(port, `CREATE DATABASE visible_db CHARACTER SET utf8mb4;
      CREATE DATABASE hidden_db;
      CREATE TABLE hidden_db.hidden_table (id INT);
      CREATE TABLE visible_db.\`orders\`\`daily\` (id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        title VARCHAR(80), exact_value DECIMAL(30,6), payload VARBINARY(10), optional_text LONGTEXT, long_text LONGTEXT);
      INSERT INTO visible_db.\`orders\`\`daily\` VALUES
        (18446744073709551615, CONVERT(0xED959CEAB880 USING utf8mb4), 123456789012345678901234.567890,
         0x00ff21, NULL, REPEAT(CONVERT(0xEAB880 USING utf8mb4), 190));
      CREATE VIEW visible_db.order_view AS SELECT id, title FROM visible_db.\`orders\`\`daily\`;
      CREATE TABLE visible_db.sample_limit (number INT NOT NULL PRIMARY KEY);
      INSERT INTO visible_db.sample_limit VALUES ${Array.from({ length: 65 }, (_, i) => `(${i})`).join(',')};
      CREATE USER 'catalog_reader'@'%' IDENTIFIED BY '${secret}' REQUIRE SSL;
      GRANT SELECT ON visible_db.* TO 'catalog_reader'@'%';`);
    return { server, port, ca: tls.ca };
  } catch (cause) {
    await stopServer(server, port);
    throw cause;
  }
}

async function verify(page, server) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(15_000);
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: engine + ' 실제 서버 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: 'MySQL 계열 연결 추가', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'MySQL 계열 연결 추가', exact: true });
  await create.getByLabel('연결 이름').fill(engine + ' 검증');
  await create.getByLabel('호스트 이름 또는 IP').fill('localhost');
  await create.getByLabel('포트').fill(String(server.port));
  await create.getByLabel('사용자 이름').fill('catalog_reader');
  await create.getByLabel('시작 데이터베이스 (선택)').fill('visible_db');
  await create.getByLabel('환경').selectOption('PROD');
  await create.getByLabel('CA 인증서 경로 (선택)').fill(server.ca);
  await create.getByRole('button', { name: '저장', exact: true }).click();
  await create.waitFor({ state: 'detached' });
  const workspace = page.getByRole('region', { name: 'MySQL 작업 공간', exact: true });
  await workspace.getByRole('heading', { name: new RegExp(engine + ' 검증') }).waitFor();

  const [profile] = await command('list_mysql_profiles', { projectId: project.id });
  assert.doesNotMatch(JSON.stringify(profile), new RegExp(secret));
  const alternate = (name, changes) => command('create_mysql_profile', { projectId: project.id, input: { ...profile.settings, name, ...changes } });
  const open = (item, password = secret, confirmation = 'PROD') => command('open_mysql', { profileId: item.id, revision: item.revision, password, confirmation });
  await assert.rejects(open(profile, secret, ''), /PROD/);
  await assert.rejects(open(profile, 'bad-catalog-password'), /사용자 이름과 암호/);
  await assert.rejects(open(await alternate('호스트 이름 불일치', { host: '127.0.0.1' })), /TLS 인증서/);
  await assert.rejects(open(await alternate('잘못된 CA', { ca_path: null })), /TLS 인증서/);
  const session = await open(profile);
  assert.equal(session.engine, engine);
  assert.equal(session.database, 'visible_db');
  const id = session.id;
  const schemas = await command('mysql_databases', { id, search: '', page: 0 });
  assert.ok(schemas.items.includes('visible_db'));
  assert.ok(!schemas.items.includes('hidden_db'));
  const objects = await command('mysql_objects', { id, database: 'visible_db', search: 'order', page: 0 });
  assert.deepEqual(objects.items.map(item => [item.name, item.kind]), [['order_view', 'VIEW'], ['orders`daily', 'BASE TABLE']]);
  const read = (database, table, includeRows) => command('mysql_table', { id, database, table, includeRows });
  const structure = await read('visible_db', 'orders`daily', false);
  assert.equal(structure.columns[0].key, 'PRI');
  assert.deepEqual(structure.rows, []);
  const sample = await read('visible_db', 'orders`daily', true);
  const [row] = sample.rows;
  assert.deepEqual(row.slice(0, 5).map(cell => cell && [cell.text, cell.encoding]), [
    ['18446744073709551615', 'utf8'], ['한글', 'utf8'], ['123456789012345678901234.567890', 'utf8'], ['00ff21', 'hex'], null,
  ]);
  assert.deepEqual(row[5], { text: '글'.repeat(170), encoding: 'utf8', bytes: 570, truncated: true });
  assert.equal((await read('visible_db', 'order_view', true)).rows[0][1].text, '한글');
  const capped = await read('visible_db', 'sample_limit', true);
  assert.equal(capped.rows.length, 50);
  assert.equal(capped.more_rows, true);
  await assert.rejects(read('hidden_db', 'hidden_table', true), /권한/);
  await verifySql(command, id, server.port);
  await command('close_mysql', { id });
  await assert.rejects(command('mysql_databases', { id, search: '', page: 0 }), /연결이 닫혔습니다/);

  await workspace.getByRole('button', { name: 'MySQL 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'MySQL 계열 연결', exact: true });
  const connect = login.getByRole('button', { name: '연결', exact: true });
  assert.equal(await connect.isDisabled(), true);
  await login.getByLabel('MySQL 암호').fill(secret);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await connect.click();
  await login.waitFor({ state: 'detached' });
  const list = workspace.getByRole('region', { name: 'MySQL 테이블과 뷰', exact: true });
  await list.getByRole('button', { name: /orders`daily/ }).click();
  await workspace.getByRole('table', { name: 'MySQL 열 구조', exact: true }).getByText('PRI', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: '데이터 미리보기', exact: true }).click();
  const grid = workspace.getByRole('table', { name: 'MySQL 데이터 미리보기', exact: true });
  await grid.getByText('한글', { exact: true }).waitFor();
  await grid.getByText('00ff21', { exact: true }).waitFor();
  await grid.getByText('NULL', { exact: true }).waitFor();
  await verifySqlEditor(workspace);
  await workspace.getByRole('button', { name: 'MySQL 연결 끊기', exact: true }).click();
  await grid.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
}

async function verifySql(command, id, port) {
  const run = (sql, parameters = [], requestId = randomUUID()) => command('run_mysql_sql', {
    id, requestId, database: 'visible_db', sql, parameters,
  });
  const count = sql => command('mysql_sql_parameters', { id, sql });
  const cancel = requestId => command('cancel_mysql_sql', { id, requestId });
  assert.equal(await count("# ?\n SELECT '?' AS literal, ? AS bound; -- ?"), 1);
  for (const sql of [
    'DELETE FROM sample_limit', 'SELECT 1; SELECT 2', 'SELECT 1 INTO @value',
    'SELECT * FROM sample_limit FOR UPDATE', 'SELECT GET_LOCK(\'fixture\', 0)',
    'SELECT /*!80000 1 */ 2', 'SELECT /*M! 1 */ 2', 'WITH cte AS (SELECT 1) DELETE FROM sample_limit',
  ]) await assert.rejects(run(sql));
  await assert.rejects(run('SELECT ?'), /매개변수 개수/);
  await assert.rejects(run('SELECT ? AS n', [{ kind: 'integer', value: '18446744073709551616' }]), /64비트/);
  await assert.rejects(run('SELECT FROM hidden_error_detail'), error => /SQL 구문/.test(String(error)) && !String(error).includes('hidden_error_detail'));

  const params = [{ kind: 'integer', value: '18446744073709551615' }, { kind: 'text', value: '문자열 매개변수' }, { kind: 'null' }, { kind: 'real', value: '0.125' }];
  const result = await run('WITH x AS (SELECT CAST(? AS UNSIGNED) AS target) SELECT o.id, o.title, o.exact_value, o.payload, ? AS label, ? AS empty_value, ? AS real_value FROM `orders``daily` o JOIN x ON x.target=o.id', params);
  assert.deepEqual(result.columns.map(column => column.name), ['id', 'title', 'exact_value', 'payload', 'label', 'empty_value', 'real_value']);
  assert.deepEqual(result.rows[0].map(cell => cell?.text ?? null), ['18446744073709551615', '한글', '123456789012345678901234.567890', '00ff21', '문자열 매개변수', null, '0.125']);
  assert.equal(result.rows[0][3].encoding, 'hex');
  assert.equal(result.more_rows, false);
  const readOnly = await run(maria ? 'SELECT @@SESSION.tx_read_only AS enabled' : 'SELECT @@SESSION.transaction_read_only AS enabled');
  assert.equal(readOnly.rows[0][0].text, '1');
  assert.ok((await run('SHOW TABLES')).rows.some(row => row[0].text === 'order_view'));
  assert.ok((await run('DESCRIBE `orders``daily`')).rows.some(row => row[0].text === 'payload'));
  assert.ok((await run('EXPLAIN SELECT * FROM sample_limit')).rows.length > 0);
  const cap = await run('SELECT number FROM sample_limit ORDER BY number');
  assert.equal(cap.rows.length, 50);
  assert.equal(cap.rows[49][0].text, '49');
  assert.equal(cap.more_rows, true);

  const requestId = randomUUID();
  const pending = run('SELECT SLEEP(10) AS cancellation_fixture', [], requestId);
  void pending.catch(() => {});
  let executing = false;
  for (let attempt = 0; attempt < 35; attempt++) {
    if (admin(port, "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='catalog_reader' AND INFO LIKE '%cancellation_fixture%';").trim() === '1') {
      executing = true;
      break;
    }
    await delay(100);
  }
  assert.equal(executing, true);
  assert.equal(await cancel(randomUUID()), false);
  assert.equal(await cancel(requestId), true);
  await assert.rejects(pending, /서버의 실행 중단 여부는 확인되지 않았습니다/);
  assert.equal((await run('SELECT 7 AS after_stop')).rows[0][0].text, '7');
  await assert.rejects(run('SELECT SLEEP(30) AS timeout_fixture'), /조회 시간이 초과되었습니다/);
  assert.equal((await run('SELECT 8 AS after_timeout')).rows[0][0].text, '8');
  assert.ok((await command('mysql_databases', { id, search: 'visible', page: 0 })).items.includes('visible_db'));
}

async function verifySqlEditor(workspace) {
  const toggle = workspace.getByRole('button', { name: 'SQL 편집기', exact: true });
  await toggle.click();
  const editor = workspace.getByRole('region', { name: 'MySQL SQL 편집기', exact: true });
  const input = editor.getByRole('textbox', { name: 'MySQL SQL 문장', exact: true });
  const result = editor.getByRole('table', { name: 'MySQL SQL 결과 표', exact: true });
  await input.fill('SELECT ? AS bound_value;');
  await editor.getByRole('button', { name: '문장 실행', exact: true }).click();
  await editor.getByRole('heading', { name: 'SQL 매개변수', exact: true }).waitFor();
  const parameter = editor.getByLabel('매개변수 1 값');
  await parameter.fill('bound-ui-fixture');
  await editor.getByLabel('값 숨기기').check();
  assert.equal(await parameter.getAttribute('type'), 'password');
  await editor.getByRole('button', { name: '바인딩하고 실행', exact: true }).click();
  await result.getByText('bound-ui-fixture', { exact: true }).waitFor();
  const selectedSql = "SELECT 'not-selected';\nSELECT 'selected-query' AS selection_value;";
  await input.fill(selectedSql);
  await input.press('Control+End');
  await input.press('Home');
  await input.press('Shift+End');
  await editor.getByRole('button', { name: '선택 실행', exact: true }).click();
  await result.getByText('selected-query', { exact: true }).waitFor();
  await toggle.click();
  await toggle.click();
  assert.equal(await input.inputValue(), selectedSql);
  await result.getByText('selected-query', { exact: true }).waitFor();
  await toggle.click();
}

async function main() {
  let server, browser;
  try {
    server = await fixture();
    browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
    await verify(browser.contexts()[0].pages()[0], server);
    console.log(`${engine} Windows E2E passed (TLS, catalog, typed previews, read-only SQL, binding, limits and client cancellation).`);
  } catch (cause) {
    const log = path.join(root, 'server.log');
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-3000));
    throw cause;
  } finally {
    try { if (browser) await browser.close(); }
    finally { if (server) await stopServer(server.server, server.port); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
