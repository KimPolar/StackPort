const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { startGateway } = require('./ssh-forward-fixture.cjs');
const { chooseDatabase } = require('./database-picker.cjs');

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
  const clientCertificate = path.join(root, 'client.pem');
  const clientKey = path.join(root, 'client.key');
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', 'ca.key', '-out', ca,
    '-subj', '/CN=StackPort MySQL Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', 'server.csr', '-subj', '/CN=localhost']);
  fs.writeFileSync(path.join(root, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  run(openssl, ['x509', '-req', '-in', 'server.csr', '-CA', ca, '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-out', cert, '-extfile', 'server.ext']);
  run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', clientKey, '-out', 'client.csr', '-subj', '/CN=StackPort Test Client']);
  fs.writeFileSync(path.join(root, 'client.ext'), 'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=clientAuth\n');
  run(openssl, ['x509', '-req', '-in', 'client.csr', '-CA', ca, '-CAkey', 'ca.key', '-days', '2', '-out', clientCertificate, '-extfile', 'client.ext']);
  return { ca, cert, key, clientCertificate, clientKey };
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
      CREATE TABLE visible_db.monitor_case (id INT PRIMARY KEY, watch_counter INT NOT NULL) ENGINE=InnoDB;
      INSERT INTO visible_db.monitor_case VALUES (1, 0);
      CREATE TABLE visible_db.grid_edit_records (
        tenant VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
        id BIGINT UNSIGNED, title VARCHAR(20) NOT NULL, quantity INT NOT NULL DEFAULT 7,
        note VARCHAR(20), payload BLOB, generated_value INT AS (quantity * 2) STORED,
        PRIMARY KEY (tenant, id), CHECK (quantity > 0)
      ) ENGINE=InnoDB;
      INSERT INTO visible_db.grid_edit_records(tenant, id, title, quantity, note, payload) VALUES
        ('native', 18446744073709551615, 'before-native', 9, 'old', REPEAT('a', 900)),
        ('native', 18446744073709551614, 'neighbor', 8, '', NULL), ('ui', 1, 'before-ui', 3, 'note-ui', NULL);
      CREATE TABLE visible_db.grid_edit_no_key (title VARCHAR(20)) ENGINE=InnoDB;
      INSERT INTO visible_db.grid_edit_no_key VALUES ('no key');
      CREATE TABLE visible_db.grid_edit_myisam (id INT PRIMARY KEY, title VARCHAR(20)) ENGINE=MyISAM;
      INSERT INTO visible_db.grid_edit_myisam VALUES (1, 'nontransactional');
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
      CREATE USER 'monitor_reader'@'%' IDENTIFIED BY '${secret}' REQUIRE SSL;
      CREATE USER 'certificate_reader'@'%' IDENTIFIED BY '${secret}' REQUIRE X509;
      CREATE DATABASE script_db CHARACTER SET utf8mb4;
      CREATE TABLE script_db.script_rows (id INT PRIMARY KEY) ENGINE=InnoDB;
      CREATE USER 'script_writer'@'%' IDENTIFIED BY '${secret}' REQUIRE SSL;
      GRANT SELECT, INSERT, CREATE ROUTINE, EXECUTE ON script_db.* TO 'script_writer'@'%';
      GRANT SELECT ON visible_db.* TO 'catalog_reader'@'%';
      GRANT UPDATE ON visible_db.grid_edit_records TO 'catalog_reader'@'%';
      GRANT SELECT ON visible_db.* TO 'monitor_reader'@'%';
      GRANT SELECT ON visible_db.* TO 'certificate_reader'@'%';
      GRANT PROCESS ON *.* TO 'monitor_reader'@'%';
      ${maria ? '' : `CREATE USER 'monitor_limited'@'%' IDENTIFIED BY '${secret}' REQUIRE SSL;
        GRANT SELECT, UPDATE ON visible_db.monitor_case TO 'monitor_limited'@'%';
        GRANT SELECT ON performance_schema.data_lock_waits TO 'monitor_reader'@'%';
        GRANT SELECT ON performance_schema.threads TO 'monitor_reader'@'%';
        GRANT SELECT ON performance_schema.data_lock_waits TO 'monitor_limited'@'%';
        GRANT SELECT ON performance_schema.threads TO 'monitor_limited'@'%';`}
      GRANT SELECT ON linked_db.catalog_parent TO 'catalog_reader'@'%';
      GRANT SHOW VIEW ON visible_db.order_view TO 'catalog_reader'@'%';
      ${maria ? `CREATE USER 'metadata_reader'@'%' IDENTIFIED BY '${secret}' REQUIRE SSL;
        GRANT SELECT, REFERENCES ON visible_db.catalog_child TO 'metadata_reader'@'%';
        GRANT SELECT ON linked_db.catalog_parent TO 'metadata_reader'@'%';` : ''}`);
    return { server, port, ...tls };
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
  await chooseDatabase(page, 'MySQL · MariaDB');
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
  await verifyGridWrites(command, id, profile, server.port);
  const writer = await open(await alternate('스크립트 실행 권한', { username: 'script_writer', database: 'script_db' }));
  try { await verifyScript(command, writer.id, id, server.port); }
  finally { await command('close_mysql', { id: writer.id }); }
  await verifyPlans(command, id);
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
  await verifyMonitor(command, id, async user => open(await alternate(user, { username: user })), server);
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
  await verifyMonitorControls(page, workspace);
  await verifySqlEditor(page, workspace);
  await verifyGridControls(page, workspace, list);
  await workspace.getByRole('button', { name: 'MySQL 연결 끊기', exact: true }).click();
  await grid.waitFor({ state: 'detached' });
  await verifyGridWriteControls(page, workspace, server.port);
  await verifyTunnel(page, command, workspace, project, profile, server, alternate);
  await verifyClientIdentity(page, command, project, server, alternate);
  assert.deepEqual(errors, []);
}

async function verifyGridWrites(command, reader, profile, port) {
  const session = await command('open_mysql', {
    profileId: profile.id, revision: profile.revision, password: secret, confirmation: 'PROD', gridEdit: true,
  });
  assert.equal(session.grid_edit, true);
  const { id } = session;
  const table = 'grid_edit_records';
  const database = 'visible_db';
  const load = (name = table, connection = id) => command('mysql_table', { id: connection, database, table: name, includeRows: true });
  const stamp = async () => (await load()).edit.rows.find(row => row.keys[1] === '18446744073709551615');
  const text = (column, value) => ({ column, value: { kind: 'text', value } });
  const preview = (stamp, changes, connection = id) => command('preview_mysql_grid_edit', { id: connection, database, table, stamp, changes });
  const apply = (token, confirmation = 'PROD') => command('apply_mysql_grid_edit', { id, token, confirmation });
  const stored = () => admin(port, "SELECT title, quantity, IFNULL(note, '<null>'), LENGTH(payload) FROM visible_db.grid_edit_records WHERE tenant='native' AND id=18446744073709551615;").trimEnd();
  try {
    const data = await load();
    assert.deepEqual(data.edit.keys, ['tenant', 'id']);
    assert.deepEqual(data.edit.columns, ['title', 'quantity', 'note']);
    assert.equal((await load(table, reader)).edit, undefined);
    assert.equal((await load('grid_edit_no_key')).edit, undefined);
    assert.equal((await load('grid_edit_myisam')).edit, undefined);
    assert.equal((await load('order_view')).edit, undefined);
    const original = await stamp();
    await assert.rejects(preview(original, [text('title', 'no-opt-in')], reader), /그리드 편집을 허용/);
    await assert.rejects(command('run_mysql_sql', { id, requestId: randomUUID(), database,
      sql: "UPDATE grid_edit_records SET quantity=1", parameters: [] }), /읽기 전용/);
    await assert.rejects(preview(original, [text('tenant', 'new-key')]), /편집할 수 없습니다/);
    await assert.rejects(preview(original, [text('generated_value', '1')]), /편집할 수 없습니다/);
    const cancelled = await preview(original, [text('title', 'cancelled')]);
    await command('discard_mysql_grid_edit', { id, token: cancelled.token });
    await assert.rejects(apply(cancelled.token), /만료/);
    assert.equal(stored(), 'before-native\t9\told\t900');

    const diff = await preview(original, [text('title', 'changed-native'), { column: 'quantity', value: { kind: 'default' } },
      { column: 'note', value: { kind: 'null' } }]);
    assert.deepEqual(diff.changes.map(cell => [cell.column, cell.before.text, cell.after.kind]),
      [['title', 'before-native', 'text'], ['quantity', '9', 'default'], ['note', 'old', 'null']]);
    await assert.rejects(apply(diff.token, ''), /PROD/);
    assert.equal(stored(), 'before-native\t9\told\t900');
    assert.deepEqual(await apply(diff.token), { status: 'applied', affected_rows: 1, audit_warning: false });
    await assert.rejects(apply(diff.token), /만료/);
    assert.equal(stored(), 'changed-native\t7\t<null>\t900');
    assert.equal(admin(port, "SELECT title FROM visible_db.grid_edit_records WHERE tenant='native' AND id=18446744073709551614;").trimEnd(), 'neighbor');

    const conflict = await preview(await stamp(), [text('title', 'after-conflict')]);
    admin(port, "UPDATE visible_db.grid_edit_records SET payload=CONCAT(REPEAT('a', 899),'z') WHERE tenant='native' AND id=18446744073709551615;");
    await assert.rejects(apply(conflict.token), /행 또는 테이블 구조가 바뀌었습니다/);
    assert.equal(stored(), 'changed-native\t7\t<null>\t900');
    const changedSchema = await preview(await stamp(), [text('title', 'stale-definition')]);
    admin(port, 'ALTER TABLE visible_db.grid_edit_records MODIFY title VARCHAR(22) NOT NULL;');
    try { await assert.rejects(apply(changedSchema.token), /행 또는 테이블 구조가 바뀌었습니다/); }
    finally { admin(port, 'ALTER TABLE visible_db.grid_edit_records MODIFY title VARCHAR(20) NOT NULL;'); }
    const bad = await preview(await stamp(), [text('title', 'rollback-title'), text('quantity', '-1')]);
    await assert.rejects(apply(bad.token), /제약/);
    assert.equal(stored(), 'changed-native\t7\t<null>\t900');
    const overflow = await preview(await stamp(), [text('title', 'x'.repeat(21)), text('quantity', '13')]);
    await assert.rejects(apply(overflow.token), /형식, 범위 또는 길이|경고/);
    assert.equal(stored(), 'changed-native\t7\t<null>\t900');
    const empty = await preview(await stamp(), [text('note', '')]);
    await apply(empty.token);
    assert.equal(stored(), 'changed-native\t7\t\t900');
    const events = (await command('list_audit_events', {})).events.filter(event => event.operation === 'mysql.grid.update');
    assert.deepEqual(events.filter(event => event.correlation_id === diff.token).map(event => event.outcome).sort(), ['started', 'succeeded']);
    assert.ok(events.some(event => event.correlation_id === bad.token && event.outcome === 'failed'));
    assert.doesNotMatch(JSON.stringify(events), /changed-native|rollback-title|after-conflict/);
  } finally { await command('close_mysql', { id }); }
}

async function verifyGridWriteControls(page, workspace, port) {
  await workspace.getByRole('button', { name: 'MySQL 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'MySQL 계열 연결', exact: true });
  const optIn = login.getByLabel('이 연결에서 데이터 그리드 편집 허용');
  assert.equal(await optIn.isChecked(), false);
  await optIn.check();
  await login.getByLabel('MySQL 암호').fill(secret);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  const objects = workspace.getByRole('region', { name: 'MySQL 테이블과 뷰' });
  await objects.getByRole('button', { name: /grid_edit_records/ }).click();
  await workspace.getByRole('button', { name: '데이터 미리보기', exact: true }).click();
  const grid = workspace.getByRole('table', { name: 'MySQL 데이터 미리보기', exact: true });
  const enter = () => grid.getByRole('row').filter({ hasText: 'before-ui' }).getByRole('button', { name: /행 편집/ }).click();
  await enter();
  const edit = page.getByRole('dialog', { name: 'MySQL 행 편집', exact: true });
  await edit.getByLabel('title 변경 방식').selectOption('text');
  await edit.getByLabel('title 새 값').fill('cancelled-ui');
  await page.keyboard.press('Escape');
  await edit.getByText('적용하지 않은 변경이 있습니다.', { exact: true }).waitFor();
  await edit.getByRole('button', { name: '변경 버리기', exact: true }).click();
  await enter();
  await edit.getByLabel('title 변경 방식').selectOption('text');
  await edit.getByLabel('title 새 값').fill('saved-ui');
  await edit.getByLabel('quantity 변경 방식').selectOption('default');
  await edit.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  const diff = edit.getByRole('table', { name: '변경 전후', exact: true });
  await diff.getByText('saved-ui', { exact: true }).waitFor();
  await diff.getByText('서버 기본값', { exact: true }).waitFor();
  const apply = edit.getByRole('button', { name: '변경 적용', exact: true });
  assert.equal(await apply.isDisabled(), true);
  await edit.getByLabel('운영 환경 확인').fill('PROD');
  await apply.click();
  await edit.waitFor({ state: 'detached' });
  await grid.getByText('saved-ui', { exact: true }).waitFor();
  assert.equal(admin(port, "SELECT title, quantity FROM visible_db.grid_edit_records WHERE tenant='ui' AND id=1;").trimEnd(), 'saved-ui\t7');
  await workspace.getByRole('button', { name: 'MySQL 연결 끊기', exact: true }).click();
}

function identitySettings(server) {
  return { username: 'certificate_reader', client_certificate_path: server.clientCertificate, client_key_path: server.clientKey };
}

async function verifyClientIdentity(page, command, project, server, alternate) {
  const open = profile => command('open_mysql', { profileId: profile.id, revision: profile.revision, password: secret, confirmation: 'PROD' });
  await assert.rejects(open(await alternate('인증서 없는 계정', { username: 'certificate_reader' })), /사용자 이름과 암호/);
  await assert.rejects(open(await alternate('일치하지 않는 개인 키', { ...identitySettings(server), client_key_path: server.key })), /인증서와 개인 키가 서로 일치/);
  await assert.rejects(open(await alternate('사라진 개인 키', { ...identitySettings(server), client_key_path: path.join(root, 'absent.key') })), /클라이언트 개인 키 파일/);
  const invalidKey = path.join(root, 'not-a-key.pem');
  fs.writeFileSync(invalidKey, 'This test file is not a private key.');
  await assert.rejects(open(await alternate('잘못된 개인 키 형식', { ...identitySettings(server), client_key_path: invalidKey })), /개인 키의 PEM 형식/);

  const name = engine + ' 클라이언트 인증 검증';
  await chooseDatabase(page, 'MySQL · MariaDB');
  const create = page.getByRole('dialog', { name: 'MySQL 계열 연결 추가', exact: true });
  await create.getByLabel('연결 이름').fill(name);
  await create.getByLabel('호스트 이름 또는 IP').fill('localhost');
  await create.getByLabel('포트').fill(String(server.port));
  await create.getByLabel('사용자 이름').fill('certificate_reader');
  await create.getByLabel('시작 데이터베이스 (선택)').fill('visible_db');
  await create.getByLabel('CA 인증서 경로 (선택)').fill(server.ca);
  await create.getByText('클라이언트 인증서 (선택)', { exact: true }).click();
  await create.getByLabel('클라이언트 인증서 경로').fill(server.clientCertificate);
  await create.getByLabel('클라이언트 개인 키 경로').fill(server.clientKey);
  await create.getByRole('button', { name: '저장', exact: true }).click();
  await create.waitFor({ state: 'detached' });
  const saved = (await command('list_mysql_profiles', { projectId: project.id })).find(item => item.settings.name === name);
  assert.equal(saved.settings.client_certificate_path, server.clientCertificate);
  assert.equal(saved.settings.client_key_path, server.clientKey);
  assert.doesNotMatch(JSON.stringify(saved), /BEGIN .*PRIVATE KEY|stackport-mysql-catalog-test/);
  const workspace = page.getByRole('region', { name: 'MySQL 작업 공간', exact: true });
  await workspace.getByRole('heading', { name, exact: false }).waitFor();
  await workspace.getByRole('button', { name: 'MySQL 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'MySQL 계열 연결', exact: true });
  await login.getByText('TLS 클라이언트 인증서 사용', { exact: true }).waitFor();
  await login.getByLabel('MySQL 암호').fill(secret);
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await workspace.getByRole('button', { name: 'MySQL 연결 끊기', exact: true }).click();
}

async function verifyTunnel(page, command, workspace, project, profile, server, alternate) {
  const gateway = await startGateway(server.port, ['localhost', '127.0.0.1']);
  let jump;
  const running = new Set();
  const stop = async tunnel => {
    await command('stop_ssh_tunnel', { id: tunnel.id });
    running.delete(tunnel.id);
  };
  try {
    jump = await startGateway(gateway.port, ['127.0.0.1']);
    const ssh = (name, port) => command('create_ssh_profile', { projectId: project.id, input: {
      name, host: '127.0.0.1', port, username: 'fixture', environment: 'DEV',
    } });
    const gatewayProfile = await ssh('DB 게이트웨이', gateway.port);
    const jumpProfile = await ssh('DB 점프', jump.port);
    const create = (name, host) => command('create_ssh_tunnel', { projectId: project.id, input: {
      name, ssh_profile_id: gatewayProfile.id, kind: 'local', listen_port: 0, target_host: host, target_port: server.port,
    } });
    const tunnel = await create('데이터베이스 보고서 터널', 'localhost');
    const mismatchedTunnel = await create('이름 불일치 터널', '127.0.0.1');
    const authentication = { kind: 'password', password: 'fixture-gateway' };
    const start = entry => command('start_ssh_tunnel', {
      tunnel: entry, profile: gatewayProfile, authentication, hops: [{ profile: jumpProfile, authentication }], confirmation: '',
    });
    const startRunning = async entry => {
      assert.equal((await start(entry)).status, 'open');
      running.add(entry.id);
    };
    const profileArgs = item => ({ profileId: item.id, revision: item.revision });
    const options = item => command('mysql_tunnel_options', profileArgs(item));
    const open = (item, route = tunnel) => command('open_mysql', {
      ...profileArgs(item), password: secret, confirmation: 'PROD', tunnelId: route.id,
    });
    assert.deepEqual(await options(profile), []);
    await assert.rejects(open(profile), /실행 중인 로컬 SSH 터널/);
    for (const [stage, host] of [['경유 1 · DB 점프', jump], ['대상 · DB 게이트웨이', gateway]]) {
      const trust = await start(tunnel);
      assert.equal(trust.status, 'trust_required');
      assert.equal(trust.stage, stage);
      assert.ok(trust.host.keys.some(key => key.fingerprint === host.fingerprint));
      await command('trust_ssh_host', { token: trust.host.token, fingerprint: host.fingerprint, confirmation: '' });
    }
    await startRunning(tunnel);
    await startRunning(mismatchedTunnel);
    assert.deepEqual((await options(profile)).map(route => route.id), [tunnel.id]);
    await assert.rejects(open(profile, mismatchedTunnel), /실행 중인 로컬 SSH 터널/);
    const wrongHost = await alternate('터널 TLS 이름 불일치', { host: '127.0.0.1' });
    await assert.rejects(open(wrongHost, mismatchedTunnel), /TLS 인증서/);
    await assert.rejects(open(await alternate('터널 CA 불일치', { ca_path: null })), /TLS 인증서/);
    const other = await command('create_project', { name: engine + ' 다른 프로젝트' });
    const otherProfile = await command('create_mysql_profile', { projectId: other.id, input: profile.settings });
    assert.deepEqual(await options(otherProfile), []);
    await assert.rejects(open(otherProfile), /실행 중인 로컬 SSH 터널/);

    const before = gateway.forwarded();
    const session = await open(await alternate('터널 클라이언트 인증', identitySettings(server)));
    assert.equal(session.tunnel.id, tunnel.id);
    assert.ok((await command('mysql_databases', { id: session.id, search: '', page: 0 })).items.includes('visible_db'));
    const monitorId = await command('open_mysql_monitor', { id: session.id });
    const activity = await command('mysql_server_activity', {
      id: session.id, monitorId, input: { filter: 'all', slow_seconds: 1, page: 0, include_sql: false },
    });
    assert.equal(activity.server.version, session.version);
    const exportResult = await command('export_mysql', {
      id: session.id, requestId: randomUUID(),
      source: { kind: 'sql', sql: 'SELECT 19 AS tunneled_export', database: null, parameters: [] },
      options: { destination: path.join(root, 'tunneled-export.json'), format: 'json', include_header: true, spreadsheet_safe: true },
    });
    assert.equal(exportResult.status, 'exported');
    assert.equal(gateway.forwarded(), before + 3);
    assert.ok(jump.forwarded() > 0);

    const login = page.getByRole('dialog', { name: 'MySQL 계열 연결', exact: true });
    const submit = login.getByRole('button', { name: '연결', exact: true });
    const route = login.getByLabel('연결 경로');
    const enterLogin = async () => {
      await workspace.getByRole('button', { name: 'MySQL 연결', exact: true }).click();
      await login.getByLabel('MySQL 암호').fill(secret);
      await login.getByLabel('운영 환경 확인').fill('PROD');
    };
    await enterLogin();
    await route.selectOption(tunnel.id);
    await submit.click();
    await workspace.getByText(/SSH 터널 데이터베이스 보고서 터널/).waitFor();
    await workspace.getByRole('button', { name: 'SQL 편집기', exact: true }).click();
    const editor = workspace.getByLabel('MySQL SQL 문장', { exact: true });
    const run = workspace.getByRole('button', { name: '문장 실행', exact: true });
    const sql = "SELECT 'ssh-jump-fixture' AS routed_value";
    await editor.fill(sql);
    await run.click();
    await workspace.getByRole('table', { name: 'MySQL SQL 결과 표' }).getByText('ssh-jump-fixture', { exact: true }).waitFor();
    assert.equal(gateway.forwarded(), before + 5);

    const interrupted = assert.rejects(command('run_mysql_sql', {
      id: session.id, requestId: randomUUID(), database: null, sql: 'SELECT SLEEP(10)', parameters: [],
    }), /중단|통신/);
    for (let attempt = 0; attempt < 30 && gateway.forwarded() === before + 5; attempt++) await delay(100);
    assert.equal(gateway.forwarded(), before + 6);
    await stop(tunnel);
    await interrupted;
    await workspace.getByRole('alert').filter({ hasText: /SSH 터널.*중단되어 MySQL 연결이 닫혔습니다/ }).waitFor();
    await assert.rejects(command('mysql_databases', { id: session.id, search: '', page: 0 }), /연결이 닫혔습니다/);
    await enterLogin();
    await route.getByRole('option', { name: /사용할 수 없음/ }).waitFor({ state: 'attached' });
    assert.equal(await route.inputValue(), tunnel.id);
    assert.equal(await submit.isDisabled(), true);
    await startRunning(tunnel);
    await login.getByRole('button', { name: '터널 목록 새로 고침', exact: true }).click();
    await submit.click();
    await editor.waitFor();
    assert.equal(await editor.inputValue(), sql);
    await run.click();
    await workspace.getByRole('table', { name: 'MySQL SQL 결과 표' }).getByText('ssh-jump-fixture', { exact: true }).waitFor();
    assert.equal(gateway.forwarded(), before + 8);
    await assert.rejects(command('mysql_databases', { id: session.id, search: '', page: 0 }), /연결이 닫혔습니다/);
    await workspace.getByRole('button', { name: 'MySQL 연결 끊기', exact: true }).click();
  } finally {
    try { for (const id of running) await stop({ id }); }
    finally { jump?.close(); gateway.close(); }
  }
}

async function verifyMonitor(command, id, openAs, server) {
  const openMonitor = id => command('open_mysql_monitor', { id });
  const closeMonitor = (id, monitorId) => command('close_mysql_monitor', { id, monitorId });
  const read = (id, monitorId, filter = 'all', includeSql = false, slow = 1) => command('mysql_server_activity', {
    id, monitorId, input: { filter, slow_seconds: slow, page: 0, include_sql: includeSql },
  });
  const processes = [];
  const monitors = [];
  const extraSessions = [];
  const start = (user, sql) => {
    const rootUser = user === 'root';
    const tls = rootUser ? [maria ? '--skip-ssl' : '--ssl-mode=DISABLED']
      : [`--ssl-ca=${server.ca}`, maria ? '--ssl-verify-server-cert' : '--ssl-mode=VERIFY_IDENTITY'];
    const child = spawn(client, ['--no-defaults', '--protocol=TCP', '-h', rootUser ? '127.0.0.1' : 'localhost',
      '-P', String(server.port), '-u', user, ...tls, '--batch', `--execute=${sql}`], {
      cwd: root, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, MYSQL_PWD: rootUser ? (maria ? rootPassword : '') : secret },
    });
    const entry = { process: child, id: null };
    processes.push(entry);
    return entry;
  };
  async function awaitProcess(entry, marker) {
    for (let attempt = 0; attempt < 40 && entry.process.exitCode === null; attempt++) {
      const result = admin(server.port, `SELECT ID FROM information_schema.PROCESSLIST
        WHERE ID <> CONNECTION_ID() AND INFO LIKE '%${marker}%' ORDER BY ID LIMIT 1;`).trim();
      if (/^\d+$/.test(result)) { entry.id = result; return result; }
      await delay(100);
    }
    throw new Error('The isolated lock fixture did not start: ' + marker);
  }
  async function monitorFor(base) {
    const monitorId = await openMonitor(base);
    monitors.push([base, monitorId]);
    return monitorId;
  }
  try {
    const limited = await monitorFor(id);
    const first = await read(id, limited);
    assert.match(first.server.version, maria ? /MariaDB/ : /^8\./);
    assert.match(first.server.max_connections, /^\d+$/);
    assert.match(first.counters.uptime, /^\d+$/);
    assert.match(first.counters.connections, /^\d+$/);
    assert.equal(first.lock_metadata, 'restricted');
    assert.ok(first.sessions.some(session => session.username === 'catalog_reader'));
    assert.ok(first.sessions.every(session => session.sql === null));
    await assert.rejects(read(id, limited, 'slow', false, 0), /느린 실행 기준/);

    const authorized = (await openAs('monitor_reader')).id;
    extraSessions.push(authorized);
    const monitor = await monitorFor(authorized);
    const holder = await awaitProcess(start('root',
      `START TRANSACTION; UPDATE visible_db.monitor_case SET watch_counter=watch_counter+1 WHERE id=1;
       SELECT SLEEP(90) AS monitor_lock_holder, '${'x'.repeat(2300)}' AS monitor_preview; ROLLBACK;`),
    'monitor_lock_holder');
    const waiter = await awaitProcess(start(maria ? 'root' : 'monitor_limited',
      'START TRANSACTION; UPDATE visible_db.monitor_case SET watch_counter=watch_counter+2 WHERE id=1; ROLLBACK;'),
    'watch_counter+2');
    let blocked;
    for (let attempt = 0; attempt < 12; attempt++) {
      const snapshot = await read(authorized, monitor, 'blocked', true);
      assert.equal(snapshot.lock_metadata, 'available');
      blocked = snapshot.sessions.find(row => row.id === waiter && row.blocker_ids.includes(holder));
      if (blocked) break;
      await delay(150);
    }
    assert.ok(blocked, 'A real InnoDB waiter should identify the lock holder');
    assert.equal(blocked.lock_wait, true);
    assert.match(blocked.sql, /watch_counter\+2/);
    assert.equal(blocked.hidden_blocker, false);
    let slow;
    for (let attempt = 0; attempt < 10; attempt++) {
      slow = (await read(authorized, monitor, 'slow', true)).sessions.find(row => row.id === holder);
      if (slow) break;
      await delay(150);
    }
    assert.ok(slow, 'An active query should appear after crossing the slow execution threshold');
    assert.match(slow.sql, /monitor_lock_holder/);
    assert.equal(slow.sql.length, 2048);
    assert.equal(slow.sql_truncated, true);
    const restricted = await read(id, limited, 'all', true);
    assert.ok(!restricted.sessions.some(row => row.id === waiter || row.id === holder));

    if (!maria) {
      const privateBase = (await openAs('monitor_limited')).id;
      extraSessions.push(privateBase);
      const privateMonitor = await monitorFor(privateBase);
      const ownWait = (await read(privateBase, privateMonitor, 'blocked', true)).sessions.find(row => row.id === waiter);
      assert.ok(ownWait);
      assert.equal(ownWait.hidden_blocker, true);
      assert.deepEqual(ownWait.blocker_ids, []);
    }
    await closeMonitor(id, limited);
    await assert.rejects(read(id, limited), /모니터 연결이 닫혔습니다/);
    const reopened = await monitorFor(id);
    await closeMonitor(id, limited);
    assert.ok((await read(id, reopened)).sessions.length > 0);
    assert.ok((await command('mysql_databases', { id, search: 'visible', page: 0 })).items.includes('visible_db'));
  } finally {
    for (const [base, monitor] of monitors) await closeMonitor(base, monitor);
    for (const session of extraSessions) await command('close_mysql', { id: session });
    for (const { process, id } of processes.reverse()) {
      if (process.exitCode !== null) continue;
      if (id) {
        try { admin(server.port, `KILL ${id};`); } catch {}
      }
      if (process.exitCode === null) process.kill();
    }
  }
}

async function verifyMonitorControls(page, workspace) {
  const toggle = workspace.getByRole('button', { name: '서버 모니터', exact: true });
  await toggle.click();
  const monitor = workspace.getByRole('region', { name: 'MySQL 서버 모니터', exact: true });
  await monitor.getByRole('button', { name: '모니터 연결', exact: true }).click();
  const sessions = monitor.getByRole('table', { name: 'MySQL 세션 활동', exact: true });
  await sessions.getByText('catalog_reader', { exact: true }).waitFor();
  await monitor.getByText('현재 계정에 잠금 관계 조회 권한이 없습니다.', { exact: false }).waitFor();
  assert.equal(await sessions.getByRole('columnheader', { name: '실행 SQL', exact: true }).count(), 0);
  await monitor.getByLabel('실행 SQL 가져오기').check();
  await sessions.getByRole('columnheader', { name: '실행 SQL', exact: true }).waitFor();
  const stamp = monitor.getByText(/서버 시간대.*조회/);
  const previous = await stamp.textContent();
  await monitor.getByLabel('5초마다 새로 고침').check();
  await page.waitForFunction(prior => {
    const text = document.querySelector('.mysql-monitor [aria-label="MySQL 세션 활동"]');
    const notes = Array.from(document.querySelectorAll('.mysql-monitor .mysql-monitor-note'));
    return text && notes.some(note => note.textContent.includes('서버 시간대') && note.textContent !== prior);
  }, previous, { timeout: 12000 });
  await toggle.click();
  await monitor.waitFor({ state: 'detached' });
  await workspace.getByRole('region', { name: 'MySQL 객체 상세' }).getByRole('heading', { name: 'catalog_child', exact: true }).waitFor();
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

async function verifyPlans(command, id) {
  const plan = (sql, analyzed, parameters = [], requestId = randomUUID()) => command('mysql_sql_plan', {
    id, requestId, database: 'visible_db', sql, analyzed, parameters,
  });
  const source = '-- 계획 대상\nSELECT number FROM sample_limit WHERE number BETWEEN ? AND 31 ORDER BY number DESC LIMIT 7;';
  const params = [{ kind: 'integer', value: '3' }];
  const estimated = await plan(source, false, params);
  assert.equal(estimated.analyzed, false);
  assert.equal(estimated.time_per_loop, !maria);
  assert.ok(estimated.steps.some(step => step.relation === 'sample_limit' && step.index === 'PRIMARY'));
  assert.ok(estimated.steps.some(step => step.depth > 0 && step.estimated_rows !== null));
  assert.equal(estimated.steps.some(step => step.actual_rows !== null), false);
  const measured = await plan(source, true, params);
  assert.equal(measured.analyzed, true);
  assert.ok(measured.steps.some(step => step.actual_rows >= 7 && step.loops > 0 && step.time_ms !== null));
  const sensitive = await plan("SELECT number FROM sample_limit WHERE CAST(number AS CHAR) = ?", false,
    [{ kind: 'text', value: 'hidden-plan-fixture' }]);
  assert.doesNotMatch(JSON.stringify(sensitive), /hidden-plan-fixture|CAST\(number/);
  await assert.rejects(plan("SHOW TABLES", false), /SELECT/);
  await assert.rejects(plan("DELETE FROM sample_limit", true), /SELECT/);
  await assert.rejects(plan("SELECT 1; SELECT 2", true), /한 번에 한 문장/);
  await assert.rejects(plan("SELECT 1 INTO OUTFILE 'fixture.txt'", true), /파일 입출력/);
  await assert.rejects(plan(source, false), /매개변수 개수/);

  const requestId = randomUUID();
  const interrupted = assert.rejects(plan('SELECT number FROM sample_limit WHERE SLEEP(10) = 0 LIMIT 1', true, [], requestId), /요청을 중단했습니다/);
  let stopped = false;
  for (let attempt = 0; attempt < 35 && !stopped; attempt++) {
    await delay(120);
    stopped = await command('cancel_mysql_sql', { id, requestId });
  }
  assert.ok(stopped);
  await interrupted;
  assert.ok((await plan(source, false, params)).steps.length > 0);
}

async function verifyScript(command, writer, reader, port) {
  const document = { kind: 'document' };
  const config = { database: 'script_db', autocommit: false, confirmation: 'PROD', parameters: [] };
  const run = (sql, overrides = {}, requestId = randomUUID(), id = writer) =>
    command('run_mysql_script', { id, requestId, input: { sql, scope: document, ...config, ...overrides } });
  await assert.rejects(run('INSERT INTO script_rows VALUES (99);', { confirmation: '' }), /PROD/);
  const denied = await run('INSERT INTO visible_db.sample_limit(number) VALUES (9999);', { database: 'visible_db' }, randomUUID(), reader);
  assert.equal(denied.status, 'failed');
  assert.ok([1044, 1142].includes(denied.error.code));
  assert.equal(denied.error.line, 1);

  const sql = `-- 한글 주석
DELIMITER $$
CREATE PROCEDURE script_sets()
BEGIN
  SELECT '첫 번째;';
  SELECT '두 번째;';
END$$
DELIMITER ;
START TRANSACTION;
INSERT INTO script_rows VALUES (?);
SAVEPOINT item;
INSERT INTO script_rows VALUES (102);
ROLLBACK TO SAVEPOINT item;
COMMIT;
INSERT INTO script_rows VALUES (103);
CALL script_sets();`;
  const requestId = randomUUID();
  assert.equal(await command('mysql_script_parameters', { id: writer, sql, scope: document }), 1);
  const response = await run(sql, { parameters: [{ kind: 'integer', value: '101' }] }, requestId);
  assert.equal(response.status, 'succeeded', JSON.stringify(response.error));
  assert.equal(response.transaction, 'cleanup_confirmed');
  assert.deepEqual(response.statements.map(statement => statement.line), [3, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(response.statements[2].sets[0].affected_rows, 1);
  assert.deepEqual(response.statements.at(-1).sets.filter(set => set.columns.length).map(set => set.rows[0][0].text), ['첫 번째;', '두 번째;']);
  assert.equal(admin(port, 'SELECT id FROM script_db.script_rows ORDER BY id;').trim(), '101');
  const audit = (await command('list_audit_events', {})).events.find(event => event.correlation_id === requestId);
  assert.deepEqual([audit.operation, audit.outcome, audit.policy], ['mysql.sql.script', 'succeeded', 'mysql-script-prod-confirmed']);
  assert.doesNotMatch(JSON.stringify(audit), /script_rows|SELECT|첫 번째/);

  const scoped = "SELECT '한글';\nSELECT ? AS target;\nINSERT INTO script_rows VALUES (99);";
  const start = Buffer.byteLength(scoped.slice(0, scoped.indexOf('SELECT ?')));
  const end = start + Buffer.byteLength('SELECT ? AS target;');
  for (const scope of [{ kind: 'current', cursor_byte: start + 7 }, { kind: 'selection', start_byte: start, end_byte: end }]) {
    const selected = await run(scoped, { scope, parameters: [{ kind: 'text', value: '선택값' }], autocommit: true });
    assert.equal(selected.status, 'succeeded', JSON.stringify(selected.error));
    assert.equal(selected.statements.length, 1);
    assert.equal(selected.statements[0].line, 2);
    assert.equal(selected.statements[0].sets[0].rows[0][0].text, '선택값');
  }
  const failed = await run('INSERT INTO script_rows VALUES (105);\nSELECT invalid_sql_column;\nCOMMIT;');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.line, 2);
  assert.equal(failed.error.code, 1054);
  assert.equal(failed.statements.length, 1);
  assert.equal(failed.transaction, 'cleanup_confirmed');

  const partial = await run(`DELIMITER //
CREATE PROCEDURE script_partial()
BEGIN
  SELECT 'retained first result';
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture error';
END//
DELIMITER ;
CALL script_partial();
COMMIT;`);
  assert.equal(partial.status, 'failed');
  assert.equal(partial.error.sql_state, '45000');
  assert.equal(partial.statements.length, 2);
  assert.equal(partial.statements.at(-1).sets[0].rows[0][0].text, 'retained first result');

  const stopId = randomUUID();
  const query = 'SELECT id FROM script_rows WHERE SLEEP(12) = 0 /* cancel-script-fixture */';
  const running = run(`INSERT INTO script_rows VALUES (106);\n${query};\nCOMMIT;`, {}, stopId);
  let active = false;
  for (let attempt = 0; attempt < 40 && !active; attempt++) {
    active = Number(admin(port, "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = 'script_writer' AND INFO LIKE '%cancel-script-fixture%';")) > 0;
    if (!active) await delay(100);
  }
  assert.ok(active, 'Script query must reach the fixture server before cancellation.');
  assert.equal(await command('cancel_mysql_sql', { id: writer, requestId: stopId }), true);
  const stopped = await running;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.server_interrupted, true, JSON.stringify(stopped));
  assert.equal(stopped.transaction, 'cleanup_confirmed');
  assert.equal(admin(port, 'SELECT id FROM script_db.script_rows ORDER BY id;').trim(), '101');

  const limit = maria
    ? 'SET STATEMENT max_statement_time = 0.1 FOR SELECT id FROM script_rows WHERE SLEEP(8) = 0'
    : 'SELECT /*+ MAX_EXECUTION_TIME(100) */ id FROM script_rows WHERE SLEEP(8) = 0';
  const timed = await run(`INSERT INTO script_rows VALUES (107);\n${limit};\nCOMMIT;`);
  assert.equal(timed.status, 'timed_out', JSON.stringify(timed));
  assert.equal(timed.server_interrupted, true);
  assert.equal(timed.transaction, 'cleanup_confirmed');
  assert.equal(admin(port, 'SELECT id FROM script_db.script_rows ORDER BY id;').trim(), '101');
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
  await input.fill('SELECT ignored;\nSELECT number FROM sample_limit WHERE number BETWEEN 3 AND 31 LIMIT 7;');
  await input.press('Control+End');
  await input.press('Home');
  await input.press('Shift+End');
  await editor.getByRole('button', { name: '실행 계획', exact: true }).click();
  const plan = editor.getByRole('region', { name: 'MySQL 실행 계획', exact: true });
  await plan.getByText('예상 실행 계획', { exact: true }).waitFor();
  await plan.getByRole('table', { name: 'MySQL 실행 단계' }).getByText('sample_limit · PRIMARY', { exact: true }).waitFor();
  await plan.getByRole('button', { name: '텍스트', exact: true }).click();
  assert.match(await plan.getByLabel('MySQL 계획 텍스트').textContent(), /예상/);
  await editor.getByRole('button', { name: '데이터 결과', exact: true }).click();
  await result.getByText('selected-query', { exact: true }).waitFor();

  await input.fill('SELECT number FROM sample_limit WHERE number BETWEEN ? AND 31 LIMIT 7;');
  await editor.getByRole('button', { name: '실행 분석', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'MySQL 실행 분석', exact: true });
  await confirm.getByRole('button', { name: '취소', exact: true }).click();
  await result.getByText('selected-query', { exact: true }).waitFor();
  await editor.getByRole('button', { name: '실행 분석', exact: true }).click();
  await confirm.getByRole('button', { name: '분석 실행', exact: true }).click();
  await editor.getByRole('heading', { name: '실행 분석 매개변수', exact: true }).waitFor();
  await editor.getByLabel('타입').selectOption('integer');
  await parameter.fill('3');
  await editor.getByRole('button', { name: '바인딩하고 실행', exact: true }).click();
  await plan.getByRole('columnheader', { name: '실제 행 / 회' }).waitFor();

  await editor.getByRole('button', { name: 'SQL 스크립트', exact: true }).click();
  await editor.getByLabel('자동 커밋', { exact: true }).uncheck();
  await input.fill("SELECT '스크립트 첫 결과';\nSELECT '스크립트 다음 결과';");
  await editor.getByRole('button', { name: '전체 실행', exact: true }).click();
  const production = page.getByRole('dialog', { name: '운영 스크립트 실행', exact: true });
  const proceed = production.getByRole('button', { name: '계속', exact: true });
  assert.equal(await proceed.isDisabled(), true);
  await production.getByLabel('운영 환경 확인').fill('PROD');
  await proceed.click();
  const scriptResult = editor.getByRole('region', { name: 'MySQL 스크립트 결과', exact: true });
  const scriptGrid = scriptResult.getByRole('table', { name: 'MySQL 스크립트 결과 표', exact: true });
  await scriptGrid.getByRole('cell', { name: '스크립트 첫 결과', exact: true }).waitFor();
  await scriptResult.getByRole('status').filter({ hasText: '결과를 받은 문장 2개' }).waitFor();
  await scriptResult.getByRole('combobox').selectOption('1');
  await scriptGrid.getByRole('cell', { name: '스크립트 다음 결과', exact: true }).waitFor();
  await editor.getByRole('button', { name: '읽기 전용 조회', exact: true }).click();
  await plan.getByRole('columnheader', { name: '실제 행 / 회' }).waitFor();
  await toggle.click();
}

async function main() {
  let server, browser;
  try {
    server = await fixture();
    browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
    await verify(browser.contexts()[0].pages()[0], server);
    console.log(`${engine} Windows E2E passed (TLS, SSH, catalog, activity, grid, read-only SQL, scripts, transactions, cancellation, execution plans and export).`);
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
