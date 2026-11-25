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
      CREATE DATABASE linked_db;
      CREATE TABLE hidden_db.hidden_table (id INT);
      CREATE TABLE hidden_db.hidden_parent (id INT PRIMARY KEY) ENGINE=InnoDB;
      CREATE TABLE linked_db.catalog_parent (tenant_id INT, part_id INT, PRIMARY KEY(part_id, tenant_id)) ENGINE=InnoDB;
      CREATE TABLE visible_db.\`orders\`\`daily\` (id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        title VARCHAR(80), exact_value DECIMAL(30,6), payload VARBINARY(10), optional_text LONGTEXT, long_text LONGTEXT);
      INSERT INTO visible_db.\`orders\`\`daily\` VALUES
        (18446744073709551615, CONVERT(0xED959CEAB880 USING utf8mb4), 123456789012345678901234.567890,
         0x00ff21, NULL, REPEAT(CONVERT(0xEAB880 USING utf8mb4), 190));
      CREATE VIEW visible_db.order_view AS SELECT id, title FROM visible_db.\`orders\`\`daily\`;
      CREATE VIEW visible_db.private_definition_view AS SELECT id FROM visible_db.\`orders\`\`daily\`;
      CREATE TABLE visible_db.catalog_child (
        id INT PRIMARY KEY, parent_tenant INT, parent_part INT, supervisor_id INT, hidden_id INT,
        code VARCHAR(80) CHARACTER SET utf8mb4, amount INT NOT NULL DEFAULT 0,
        CONSTRAINT uq_tenant_code UNIQUE (parent_tenant, code),
        CONSTRAINT ck_catalog_amount CHECK (amount >= 0),
        CONSTRAINT fk_catalog_parent FOREIGN KEY (parent_part, parent_tenant)
          REFERENCES linked_db.catalog_parent(part_id, tenant_id) ON UPDATE CASCADE ON DELETE SET NULL,
        CONSTRAINT fk_catalog_self FOREIGN KEY (supervisor_id) REFERENCES visible_db.catalog_child(id),
        CONSTRAINT fk_catalog_hidden FOREIGN KEY (hidden_id) REFERENCES hidden_db.hidden_parent(id),
        INDEX idx_catalog_prefix (code(4) DESC, id) ${maria ? 'IGNORED' : 'INVISIBLE'}
      ) ENGINE=InnoDB;
      ${maria ? 'ALTER TABLE visible_db.catalog_child ADD COLUMN code_lower VARCHAR(80) AS (LOWER(code)) VIRTUAL, ADD INDEX idx_catalog_expression (code_lower);'
        : 'CREATE INDEX idx_catalog_expression ON visible_db.catalog_child ((LOWER(code)));'}
      CREATE TABLE visible_db.check_pages (
        id INT, ${Array.from({ length: 101 }, (_, i) => `CONSTRAINT chk_${String(i).padStart(3, '0')} CHECK (id <> ${i})`).join(',')}
      ) ENGINE=InnoDB;
      CREATE TABLE visible_db.sample_limit (number INT NOT NULL PRIMARY KEY);
      INSERT INTO visible_db.sample_limit VALUES ${Array.from({ length: 65 }, (_, i) => `(${i})`).join(',')};
      CREATE TABLE visible_db.grid_filter (
        id BIGINT UNSIGNED, part INT, \`tag\`\`text\` VARCHAR(60), amount DECIMAL(30,6),
        booked DATE, touched DATETIME(6), elapsed TIME(6), weight DOUBLE, ratio FLOAT, PRIMARY KEY (part, id)
      );
      INSERT INTO visible_db.grid_filter VALUES
        (18446744073709551615, 0, NULL, 123456789012345678901234.567890, '2024-02-29', '2024-02-29 12:30:00.125000', '-100:01:00.250000', 0.5, 0.1),
        (18446744073709551614, 1, '%_need''le', 123456789012345678901234.567891, '2024-03-01', '2024-03-01 07:00:00', '00:00:00', 10.25, 0.2),
        (1, 2, '%Xneed''le', 1.000001, '2024-03-02', '2024-03-02 00:00:00', '12:30:00', 2.5, 0.3);
      CREATE TABLE visible_db.wide_filter (
        id INT PRIMARY KEY, ${Array.from({ length: 128 }, (_, i) => `col_${i + 1} INT`).join(',')}
      );
      INSERT INTO visible_db.wide_filter(id, col_128) VALUES (1, 100), (2, 200);
      CREATE USER 'catalog_reader'@'%' IDENTIFIED BY '${secret}' REQUIRE SSL;
      GRANT SELECT ON visible_db.* TO 'catalog_reader'@'%';
      GRANT SELECT ON linked_db.catalog_parent TO 'catalog_reader'@'%';
      GRANT SHOW VIEW ON visible_db.order_view TO 'catalog_reader'@'%';
      ${maria ? `CREATE USER 'metadata_reader'@'%' IDENTIFIED BY '${secret}' REQUIRE SSL;
        GRANT SELECT, REFERENCES ON visible_db.catalog_child TO 'metadata_reader'@'%';
        GRANT SELECT ON linked_db.catalog_parent TO 'metadata_reader'@'%';` : ''}`);
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
  await verifyStructure(command, id);
  if (maria) {
    const metadata = await open(await alternate('제약조건 메타데이터 권한', { username: 'metadata_reader' }));
    const rules = await command('mysql_structure', { id: metadata.id, database: 'visible_db', table: 'catalog_child', section: 'constraints', page: 0 });
    const foreign = rules.items.find(item => item.name === 'fk_catalog_parent');
    assert.deepEqual([foreign?.on_update, foreign?.on_delete], ['CASCADE', 'SET NULL']);
    assert.equal(rules.items.filter(item => item.name === 'fk_catalog_parent').length, 1);
    const incoming = await command('mysql_structure', { id: metadata.id, database: 'linked_db', table: 'catalog_parent', section: 'references', page: 0 });
    assert.deepEqual([incoming.items[0].on_update, incoming.items[0].on_delete], ['CASCADE', 'SET NULL']);
    await command('close_mysql', { id: metadata.id });
  }
  await verifyDataGrid(command, id, profile);
  await verifyExports(command, id, profile);
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
  await verifyStructureControls(page, workspace, list);
  await verifySqlEditor(page, workspace);
  await verifyGridControls(page, workspace, list);
  await workspace.getByRole('button', { name: 'MySQL 연결 끊기', exact: true }).click();
  await grid.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
}

async function verifyStructure(command, id) {
  const read = (table, section, database = 'visible_db', page = 0) => command('mysql_structure', { id, database, table, section, page });
  const byName = (items, name) => {
    const item = items.find(item => item.name === name);
    assert.ok(item, 'Missing catalog entry: ' + name);
    return item;
  };
  const indexes = await read('catalog_child', 'indexes');
  assert.equal(indexes.section, 'indexes');
  assert.equal(indexes.has_next, false);
  const prefix = byName(indexes.items, 'idx_catalog_prefix');
  assert.equal(prefix.method, 'BTREE');
  assert.equal(prefix.visible, false);
  assert.equal(prefix.unique, false);
  assert.deepEqual(prefix.parts.map(part => [part.column, part.order, part.prefix]), [['code', 'D', 4], ['id', 'A', null]]);
  const expression = byName(indexes.items, 'idx_catalog_expression').parts[0];
  if (maria) assert.equal(expression.column, 'code_lower');
  else {
    assert.equal(expression.column, null);
    assert.match(expression.expression.text, /lower\(.?code.?\)/i);
  }
  assert.equal(byName(indexes.items, 'uq_tenant_code').unique, true);

  const { items: constraints } = await read('catalog_child', 'constraints');
  const foreign = byName(constraints, 'fk_catalog_parent');
  assert.equal(foreign.kind, 'FOREIGN KEY');
  assert.deepEqual(foreign.columns, [
    { local: 'parent_part', referenced: 'part_id' },
    { local: 'parent_tenant', referenced: 'tenant_id' },
  ]);
  assert.equal(foreign.reference.database, 'linked_db');
  assert.equal(foreign.reference.object.name, 'catalog_parent');
  assert.equal(foreign.on_update, maria ? null : 'CASCADE');
  assert.equal(foreign.on_delete, maria ? null : 'SET NULL');
  assert.equal(byName(constraints, 'fk_catalog_hidden').reference.object, null);
  assert.deepEqual(byName(constraints, 'uq_tenant_code').columns.map(column => column.local), ['parent_tenant', 'code']);
  const check = byName(constraints, 'ck_catalog_amount');
  assert.equal(check.kind, 'CHECK');
  assert.match(check.expression.text, /amount.*>=\s*0/i);
  if (!maria) assert.equal(check.enforced, true);
  const parent = await read('catalog_parent', 'references', 'linked_db');
  assert.equal(parent.items.length, 1);
  assert.equal(parent.items[0].source.object.name, 'catalog_child');
  assert.deepEqual(parent.items[0].columns, foreign.columns);
  assert.equal(parent.items[0].on_delete, maria ? null : 'SET NULL');
  const self = await read('catalog_child', 'references');
  assert.deepEqual(self.items.map(item => item.name), ['fk_catalog_self']);
  assert.deepEqual((await read('catalog_parent', 'references', 'linked_db', 1)).items, []);

  const firstPage = await read('check_pages', 'constraints');
  assert.equal(firstPage.items.length, 100);
  assert.equal(firstPage.has_next, true);
  assert.equal(firstPage.items[0].name, 'chk_000');
  assert.equal(firstPage.items[99].name, 'chk_099');
  const secondPage = await read('check_pages', 'constraints', 'visible_db', 1);
  assert.deepEqual(secondPage.items.map(item => item.name), ['chk_100']);
  assert.equal(secondPage.has_next, false);

  const tableSql = (await read('orders`daily', 'definition')).definition;
  assert.equal(tableSql.truncated, false);
  assert.match(tableSql.text, /^CREATE TABLE \`orders\`\`daily\`/);
  const viewSql = (await read('order_view', 'definition')).definition;
  assert.match(viewSql.text, /VIEW .+order_view/i);
  await assert.rejects(read('private_definition_view', 'definition'), /SHOW VIEW/);
  await assert.rejects(read('hidden_table', 'definition', 'hidden_db'), /권한/);
}

async function verifyStructureControls(page, workspace, list) {
  const detail = workspace.getByRole('region', { name: 'MySQL 객체 상세' });
  await list.getByRole('button', { name: /catalog_child/ }).click();
  await detail.getByRole('button', { name: '인덱스', exact: true }).click();
  await detail.locator('summary').filter({ hasText: 'idx_catalog_prefix' }).click();
  const index = detail.getByRole('table', { name: 'idx_catalog_prefix 인덱스 구성' });
  await index.getByText('내림차순', { exact: true }).waitFor();
  await index.getByRole('cell', { name: '4', exact: true }).first().waitFor();

  await detail.getByRole('button', { name: '제약조건', exact: true }).click();
  const foreign = detail.locator('details').filter({ has: page.getByText('fk_catalog_parent', { exact: true }) });
  await foreign.locator('summary').click();
  await foreign.getByText(maria ? '현재 계정에 공개된 갱신·삭제 규칙이 없습니다.' : 'ON UPDATE CASCADE · ON DELETE SET NULL', { exact: true }).waitFor();
  await foreign.getByRole('button', { name: '구조 열기', exact: true }).click();
  await detail.getByRole('heading', { name: 'catalog_parent', exact: true }).waitFor();
  await detail.getByRole('button', { name: '들어오는 외래 키', exact: true }).click();
  await detail.locator('summary').filter({ hasText: 'fk_catalog_parent' }).click();
  await detail.getByRole('button', { name: '구조 열기', exact: true }).click();
  await detail.getByRole('heading', { name: 'catalog_child', exact: true }).waitFor();

  await detail.getByRole('button', { name: '생성 SQL', exact: true }).click();
  const definition = detail.getByRole('region', { name: 'MySQL 생성 SQL', exact: true });
  const sql = await definition.locator('pre').textContent();
  assert.match(sql, /CREATE TABLE/);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { window.catalogCopiedSql = text; } },
    });
  });
  try {
    await definition.getByRole('button', { name: 'SQL 복사', exact: true }).click();
    await definition.getByText('생성 SQL을 복사했습니다.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.catalogCopiedSql), sql);
  } finally {
    await page.evaluate(() => { delete navigator.clipboard; delete window.catalogCopiedSql; });
  }
  await definition.getByRole('button', { name: '정의 파일 저장', exact: true }).click();
  const save = page.getByRole('dialog', { name: 'SQL 파일로 저장', exact: true });
  const destination = path.join(root, 'catalog-child.sql');
  await save.getByLabel('새 SQL 파일 경로').fill(destination);
  await save.getByRole('button', { name: '새 파일에 저장', exact: true }).click();
  await save.waitFor({ state: 'detached' });
  assert.equal(fs.readFileSync(destination, 'utf8'), sql);
}

async function verifyExports(command, id, profile) {
  const run = (source, file, format = 'json', requestId = randomUUID()) => command('export_mysql', {
    id, requestId, source,
    options: { destination: path.join(root, file), format, include_header: true, spreadsheet_safe: true },
  });
  const output = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const table = (name, clauses = { filters: [], sort: [], conjunction: 'all' }) => ({
    kind: 'table', database: 'visible_db', table: name, clauses,
  });
  const sql = (text, parameters = []) => ({ kind: 'sql', database: 'visible_db', sql: text, parameters });
  const trackedExport = randomUUID();
  const result = await run(table('sample_limit', {
    filters: [{ column: 'number', condition: { kind: 'ge', value: { kind: 'text', value: '5' } } }],
    sort: [{ column: 'number', direction: 'desc', nulls: 'default' }],
    conjunction: 'all',
  }), 'full-filtered.json', 'json', trackedExport);
  assert.equal(result.status, 'exported');
  assert.equal(result.report.rows, 60);
  assert.equal(result.report.audit_warning, null);
  assert.equal(result.report.size_bytes, fs.statSync(path.join(root, 'full-filtered.json')).size);
  assert.deepEqual(output('full-filtered.json').rows, Array.from({ length: 60 }, (_, i) => [String(64 - i)]));
  const event = (await command('list_audit_events', {})).events.find(item => item.correlation_id === trackedExport);
  assert.deepEqual([event.operation, event.profile_id, event.environment, event.object_name, event.affected_count],
    ['mysql.export.json', profile.id, 'PROD', null, 60]);

  await run(table('orders`daily'), 'typed-values.json');
  const typed = output('typed-values.json');
  assert.equal(typed.format, 'stackport.mysql-results');
  assert.equal(typed.version, 1);
  assert.equal(typed.columns[3].encoding, 'hex');
  assert.deepEqual(typed.rows[0], ['18446744073709551615', '한글', '123456789012345678901234.567890', '00FF21', null, '글'.repeat(190)]);

  await run(table('wide_filter'), 'wide.json');
  assert.equal(output('wide.json').columns.length, 129);
  assert.equal(output('wide.json').rows[1][128], '200');
  await run(sql("SELECT ? AS repeated, '' AS repeated", [{ kind: 'text', value: '내보낼 값' }]), 'duplicates.json');
  assert.deepEqual(output('duplicates.json').columns.map(column => column.name), ['repeated', 'repeated']);
  assert.deepEqual(output('duplicates.json').rows, [['내보낼 값', '']]);
  assert.equal((await run(sql('SELECT 1 AS empty_result WHERE 0'), 'empty.json')).report.rows, 0);
  assert.deepEqual(output('empty.json').columns.map(column => column.name), ['empty_result']);
  assert.deepEqual(output('empty.json').rows, []);

  const csv = await run(sql("SELECT ? AS formula, CAST('-1.250' AS DECIMAL(10,3)) AS exact_value, CAST(NULL AS CHAR) AS missing_value, '' AS empty_value, 0x00ff AS raw",
    [{ kind: 'text', value: '=1+1' }]), 'typed-values.csv', 'csv');
  assert.equal(csv.report.protected_fields, 1);
  assert.equal(fs.readFileSync(path.join(root, 'typed-values.csv'), 'utf8'),
    '"formula","exact_value","missing_value","empty_value","raw"\r\n' + `"'=1+1",-1.250,\\N,"","X'00FF'"\r\n`);
  await assert.rejects(run(sql('SELECT 1'), 'typed-values.csv', 'csv'), /같은 이름의 파일/);
  assert.ok(fs.readFileSync(path.join(root, 'typed-values.csv'), 'utf8').includes("-1.250"));
  await assert.rejects(run(sql('DELETE FROM sample_limit'), 'rejected.json'), /읽기 전용 SQL/);
  assert.equal(fs.existsSync(path.join(root, 'rejected.json')), false);

  const readProgress = requestId => command('mysql_export_progress', { id, requestId });
  const requestId = randomUUID();
  const pending = run(sql("SELECT number, REPEAT('x', 32768), SLEEP(0.15) FROM sample_limit"), 'cancelled.json', 'json', requestId);
  void pending.catch(() => {});
  let progress = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    progress = await readProgress(requestId);
    if (progress > 0) break;
    await delay(100);
  }
  assert.ok(progress > 0 && progress < 65, 'export must write at least one row before cancellation');
  assert.equal(await command('cancel_mysql_sql', { id, requestId }), true);
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(await readProgress(requestId), null);
  for (let attempt = 0; attempt < 25 && fs.readdirSync(root).some(name => name.startsWith('.stackport-json-')); attempt++) await delay(100);
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.stackport-json-')));
  assert.equal(fs.existsSync(path.join(root, 'cancelled.json')), false);
}

async function verifyDataGrid(command, id, profile) {
  const read = (table, grid) => command('mysql_table', { id, database: 'visible_db', table, includeRows: true, grid });
  const clauses = (filters = [], sort = [], conjunction = 'all') => ({ filters, sort, conjunction });
  const atom = (value, kind = 'text') => ({ kind, value });
  const equal = (column, value) => ({ column, condition: { kind: 'eq', value: atom(value) } });
  const order = (column, direction = 'asc', nulls = 'default') => ({ column, direction, nulls });
  const result = (query, table = 'grid_filter', page = 0) => read(table, { page, clauses: query });
  const ids = data => data.rows.map(row => row[0].text);
  const last = '18446744073709551615';
  const previous = '18446744073709551614';
  const initial = await result(clauses());
  assert.equal(initial.stable_order, true);
  assert.deepEqual(ids(initial), [last, previous, '1']);
  assert.match(initial.query_sql, /ORDER BY sp_source\.\x60part\x60 ASC, sp_source\.\x60id\x60 ASC/);
  const second = await result(clauses(), 'sample_limit', 1);
  assert.equal(second.more_rows, false);
  assert.deepEqual(ids(second), Array.from({ length: 15 }, (_, index) => String(index + 50)));
  assert.equal((await result(clauses(), 'order_view')).stable_order, false);

  assert.deepEqual(ids(await result(clauses([equal('id', previous)]))), [previous]);
  assert.deepEqual(ids(await result(clauses([equal('amount', '123456789012345678901234.567890')]))), [last]);
  assert.deepEqual(ids(await result(clauses([equal('touched', '2024-02-29T12:30:00.125')]))), [last]);
  assert.deepEqual(ids(await result(clauses([equal('elapsed', '-100:01:00.250000')]))), [last]);
  assert.deepEqual(ids(await result(clauses([equal('weight', '10.25')]))), [previous]);
  assert.deepEqual(ids(await result(clauses([equal('ratio', '0.1')]))), [last]);
  const range = { column: 'booked', condition: { kind: 'between', from: atom('2024-02-29', 'date'), to: atom('2024-03-01', 'date') } };
  const literal = { column: 'tag`text', condition: { kind: 'contains', value: "_need'le" } };
  const expectedQuery = clauses([literal, range], [order('tag`text', 'desc', 'first')], 'any');
  const filtered = await result(expectedQuery);
  assert.deepEqual(ids(filtered), [last, previous]);
  assert.match(filtered.query_sql, /LOCATE\(\?, sp_source\.\x60tag\x60\x60text\x60\)/);
  assert.doesNotMatch(filtered.query_sql, /need'le|2024-03-01/);
  assert.deepEqual(ids(await result(clauses([literal, range]))), [previous]);
  assert.deepEqual(ids(await result(clauses([], [order('tag`text', 'asc', 'last'), order('id', 'desc')]))).slice(-1), [last]);
  const nullFilter = { column: 'tag`text', condition: { kind: 'is_null' } };
  assert.deepEqual(ids(await result(clauses([nullFilter]))), [last]);
  const wide = await result(clauses([equal('col_128', '200')], [order('col_128')]), 'wide_filter');
  assert.equal(wide.more_columns, true);
  assert.equal(wide.columns.length, 128);
  assert.deepEqual(ids(wide), ['2']);
  await assert.rejects(result(clauses([equal('booked', '2023-02-29')])), /날짜·시간/);
  await assert.rejects(result(clauses([equal('id', '2-no')])), /형식이나 범위/);
  await assert.rejects(result(clauses([equal('not_a_column', 'x')])), /표시되는 열/);
  assert.deepEqual(ids(await result(clauses([equal('tag`text', "' OR 1=1 -- ")]))), []);

  const target = { engine: 'mysql', profile_id: profile.id, revision: profile.revision, schema: 'visible_db', object: 'grid_filter' };
  await command('write_table_query_preset', { target, write: { kind: 'create', name: 'Filtered grid', clauses: expectedQuery } });
  const [saved] = await command('list_table_query_presets', { target });
  assert.deepEqual(await command('read_table_query_preset', { target, id: saved.id, revision: saved.revision }), expectedQuery);
  assert.deepEqual(await command('list_table_query_presets', { target: { ...target, object: 'wide_filter' } }), []);
}

async function verifyGridControls(page, workspace, list) {
  const detail = workspace.getByRole('region', { name: 'MySQL 객체 상세' });
  const grid = detail.getByRole('table', { name: 'MySQL 데이터 미리보기', exact: true });
  await list.getByRole('button', { name: /sample_limit/ }).click();
  await detail.getByRole('button', { name: '데이터 미리보기' }).click();
  const pager = detail.getByRole('group', { name: '데이터 페이지' });
  await grid.getByRole('cell', { name: '49', exact: true }).waitFor();
  await pager.getByRole('button', { name: '다음' }).click();
  await grid.getByRole('cell', { name: '64', exact: true }).waitFor();
  assert.equal(await pager.getByRole('button', { name: '다음' }).isDisabled(), true);

  await detail.getByText('필터 및 정렬', { exact: true }).click();
  await detail.getByRole('button', { name: '조건 추가' }).click();
  await detail.getByLabel('필터 1 연산자').selectOption('ge');
  await detail.getByLabel('필터 1 값', { exact: true }).fill('63');
  await detail.getByRole('button', { name: '정렬 열 추가' }).click();
  await detail.getByLabel('정렬 1 방향').selectOption('desc');
  await detail.getByRole('button', { name: '적용', exact: true }).click();
  await detail.getByText('1–2행', { exact: true }).waitFor();
  assert.deepEqual(await grid.getByRole('cell').allTextContents(), ['64', '63']);
  await detail.getByText('조회 SQL', { exact: true }).click();
  assert.match(await detail.locator('.table-query-sql code').textContent(), /WHERE.+CAST\(\?/);
  await detail.getByRole('button', { name: '결과 내보내기' }).click();
  await saveJsonFromDialog(page, 'filtered-ui.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'filtered-ui.json'), 'utf8')).rows, [['64'], ['63']]);
  await detail.getByRole('button', { name: '초기화', exact: true }).click();
  await grid.getByRole('cell', { name: '0', exact: true }).waitFor();

  await list.getByRole('button', { name: /grid_filter/ }).click();
  await detail.getByRole('button', { name: '데이터 미리보기' }).click();
  await detail.getByText('필터 및 정렬', { exact: true }).click();
  await detail.getByRole('button', { name: '저장된 조건' }).click();
  const preset = page.getByRole('dialog', { name: '저장된 조회 조건', exact: true });
  const selected = preset.getByRole('combobox');
  await selected.selectOption({ label: 'Filtered grid' });
  await preset.getByRole('button', { name: '적용', exact: true }).click();
  await preset.waitFor({ state: 'detached' });
  await detail.getByText('1–2행', { exact: true }).waitFor();
  assert.equal(await grid.getByRole('row').count(), 3);
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

async function saveJsonFromDialog(page, output) {
  const dialog = page.getByRole('dialog', { name: '결과 내보내기', exact: true });
  await dialog.getByRole('combobox').selectOption('JSON');
  await dialog.getByRole('textbox', { name: '새 JSON 파일 경로' }).fill(path.join(root, output));
  await dialog.getByRole('button', { name: 'JSON 저장', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}

async function verifySqlEditor(page, workspace) {
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
  await input.fill('SELECT 404 AS unsaved_query;');
  await editor.getByRole('button', { name: '결과 내보내기', exact: true }).click();
  await editor.getByRole('heading', { name: '내보내기 매개변수 다시 입력' }).waitFor();
  assert.equal(await parameter.inputValue(), '');
  assert.equal(await parameter.getAttribute('type'), 'password');
  await parameter.fill('exported-ui-fixture');
  await editor.getByRole('button', { name: '파일 설정', exact: true }).click();
  await saveJsonFromDialog(page, 'sql-ui.json');
  const exported = JSON.parse(fs.readFileSync(path.join(root, 'sql-ui.json'), 'utf8'));
  assert.equal(exported.columns[0].name, 'bound_value');
  assert.deepEqual(exported.rows, [['exported-ui-fixture']]);
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
    console.log(`${engine} Windows E2E passed (structured catalog, DDL files, data grid, read-only SQL and export).`);
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
