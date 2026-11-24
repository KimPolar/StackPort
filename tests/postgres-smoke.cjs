const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { Server, utils } = require('ssh2');

const root = process.env.STACKPORT_TEST_ROOT;
const bin = process.env.STACKPORT_POSTGRES_BIN;
const openssl = process.env.STACKPORT_TEST_OPENSSL || 'openssl';
const password = 'fixture-reader-password';
if (!root || !bin) throw new Error('Set STACKPORT_TEST_ROOT and STACKPORT_POSTGRES_BIN.');

async function startPostgres() {
  const directory = fs.mkdtempSync(path.join(root, 'postgres-'));
  const data = path.join(directory, 'data');
  const ca = path.join(directory, 'ca.pem');
  const run = (executable, args) => execFileSync(executable, args, { cwd: directory, windowsHide: true, stdio: 'pipe' });
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', 'ca.key', '-out', 'ca.pem',
    '-subj', '/CN=StackPort temporary test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr',
    '-subj', '/CN=localhost']);
  fs.writeFileSync(path.join(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  run(openssl, ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-days', '2', '-out', 'server.pem', '-extfile', 'server.ext']);
  fs.chmodSync(path.join(directory, 'server.key'), 0o600);
  const adminPassword = path.join(directory, 'init-password');
  const adminSecret = 'fixture-administrator-password';
  fs.writeFileSync(adminPassword, adminSecret + '\n');
  run(path.join(bin, 'initdb.exe'), ['-D', data, '-U', 'fixture_admin', '--no-instructions', '--no-locale',
    '--encoding=UTF8', '--auth=scram-sha-256', `--pwfile=${adminPassword}`]);
  fs.unlinkSync(adminPassword);
  const extra = Array.from({ length: 23 }, (_, index) => `extra_${index + 1} text`).join(', ');
  const seed = [
    `CREATE ROLE fixture_reader LOGIN PASSWORD '${password}';`,
    'CREATE SCHEMA report;',
    'CREATE SCHEMA restricted;',
    'GRANT USAGE ON SCHEMA report TO fixture_reader;',
    "CREATE TYPE report.grade AS ENUM ('silver', 'gold');",
    `CREATE TABLE report."quoted table" (id integer PRIMARY KEY, note text, precise numeric(30,3), ${extra});`,
    `INSERT INTO report."quoted table" (id, note, precise, extra_23)
       SELECT i, CASE i WHEN 1 THEN NULL WHEN 2 THEN repeat('한', 513) WHEN 3 THEN '' ELSE '행 ' || i END,
       9007199254740993.123, '마지막 열' FROM generate_series(1, 105) AS series(i);`.replace(/\s+/g, ' '),
    'CREATE VIEW report.visible AS SELECT id FROM report."quoted table" WHERE id=4;',
    'CREATE TABLE report.filtered_dates (id integer PRIMARY KEY, "due date" date);',
    "INSERT INTO report.filtered_dates VALUES (1, NULL), (2, '2025-12-31'), (3, '2026-01-02'), (4, '2026-01-31');",
    'GRANT SELECT ON report.filtered_dates TO fixture_reader;',
    'CREATE TABLE report.denied (id integer);',
    'CREATE TABLE report.write_probe (id integer);',
    'CREATE TABLE report.plan_events (id integer PRIMARY KEY, payload text);',
    "INSERT INTO report.plan_events SELECT i, repeat('abcd', 16) FROM generate_series(1, 4096) AS series(i);",
    'ANALYZE report.plan_events;',
    'GRANT SELECT ON report."quoted table", report.visible TO fixture_reader;',
    'GRANT SELECT ON report.plan_events TO fixture_reader;',
    'GRANT SELECT, INSERT, UPDATE ON report.write_probe TO fixture_reader;',
    'CREATE TABLE report."edit demo" ("tenant key" integer, "row key" uuid, "public note" text DEFAULT \'기본값\', ' +
      'amount numeric(30,3) NOT NULL CHECK(amount >= 0), "unique note" text UNIQUE, PRIMARY KEY ("tenant key", "row key"), ' +
      'CHECK ("public note" IS DISTINCT FROM \'조합\' OR amount = 8.000));',
    "INSERT INTO report.\"edit demo\" VALUES (1, '9a048887-22a5-4c98-bbc1-7ceee4ee725d', '초기값', 9007199254740993.123, 'unique-a'), " +
      "(2, '9a048887-22a5-4c98-bbc1-7ceee4ee725d', '다른 행', 2, 'unique-b');",
    'ALTER TABLE report."edit demo" ENABLE ROW LEVEL SECURITY;',
    'CREATE POLICY edit_visible ON report."edit demo" FOR SELECT TO fixture_reader USING (true);',
    'CREATE POLICY edit_allowed ON report."edit demo" FOR UPDATE TO fixture_reader USING ("tenant key" = 1);',
    'GRANT SELECT, UPDATE ON report."edit demo" TO fixture_reader;',
    'CREATE TABLE report.meta_parent (parent_id integer, tenant integer, CONSTRAINT meta_parent_pk PRIMARY KEY (parent_id, tenant));',
    'CREATE TABLE report.meta_child (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id integer, tenant integer, ' +
      "status text COLLATE \"C\" DEFAULT '대기', normalized text GENERATED ALWAYS AS (lower(status)) STORED, " +
      'CONSTRAINT meta_fk FOREIGN KEY (parent_id, tenant) REFERENCES report.meta_parent (parent_id, tenant) DEFERRABLE INITIALLY DEFERRED);',
    'ALTER TABLE report.meta_child ADD CONSTRAINT tenant_positive CHECK (tenant > 0) NOT VALID;',
    "COMMENT ON TABLE report.meta_child IS '구조 검증 테이블';",
    "COMMENT ON COLUMN report.meta_child.status IS '업무 상태';",
    "CREATE INDEX meta_status_idx ON report.meta_child (lower(status)) WHERE status <> '대기';",
    'CREATE FUNCTION report.meta_touch() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN NEW; END; $body$;',
    'CREATE TABLE report.edit_trigger (id integer PRIMARY KEY, value text);',
    'CREATE TRIGGER edit_block BEFORE UPDATE ON report.edit_trigger FOR EACH ROW EXECUTE FUNCTION report.meta_touch();',
    'GRANT SELECT, UPDATE ON report.edit_trigger TO fixture_reader;',
    'CREATE TRIGGER meta_touch_row BEFORE UPDATE ON report.meta_child FOR EACH ROW EXECUTE FUNCTION report.meta_touch();',
    'ALTER TABLE report.meta_child DISABLE TRIGGER meta_touch_row;',
    'ALTER TABLE report.meta_child ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE report.meta_child FORCE ROW LEVEL SECURITY;',
    'CREATE VIEW report.meta_view AS SELECT status AS payload FROM report.meta_child;',
    'CREATE MATERIALIZED VIEW report.meta_cache AS SELECT count(*) AS tally FROM report.meta_child WITH NO DATA;',
    "CREATE VIEW report.meta_large AS SELECT '" + '한'.repeat(16_420) + "'::text AS payload;",
    'CREATE TABLE report.meta_ranges (id integer) PARTITION BY RANGE (id);',
    'CREATE TABLE report.meta_low PARTITION OF report.meta_ranges FOR VALUES FROM (0) TO (10);',
    'CREATE TABLE report.meta_high PARTITION OF report.meta_ranges DEFAULT;',
    'CREATE TABLE report.meta_wide (' + Array.from({ length: 35 }, (_, index) => 'col_' + (index + 1) + ' integer').join(', ') + ');',
    'GRANT SELECT ON report.meta_parent, report.meta_child, report.meta_view, report.meta_cache, report.meta_large, report.meta_ranges, report.meta_low, report.meta_wide TO fixture_reader;',
  ].join('\n') + '\n';
  const postgres = path.join(bin, 'postgres.exe');
  fs.writeFileSync(path.join(data, 'pg_hba.conf'), 'hostssl all all 127.0.0.1/32 scram-sha-256\n');
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const server = spawn(postgres, ['-D', data, '-h', '127.0.0.1', '-p', String(port), '-c', 'ssl=on',
    '-c', `ssl_cert_file=${path.join(directory, 'server.pem')}`, '-c', `ssl_key_file=${path.join(directory, 'server.key')}`],
  { cwd: directory, windowsHide: true });
  server.stdout.resume();
  let log = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`PostgreSQL startup timed out. ${log}`)), 20_000);
      const fail = error => { clearTimeout(timer); reject(error); };
      server.once('error', fail);
      server.once('exit', code => fail(new Error(`PostgreSQL exited with ${code}. ${log}`)));
      server.stderr.on('data', chunk => {
        log = (log + chunk).slice(-20_000);
        if (log.includes('ready to accept connections')) { clearTimeout(timer); resolve(); }
      });
    });
    // Create ordinary user objects through a live connection so row security
    // is exercised as it would be on a normally initialized server.
    const seedFile = path.join(directory, 'seed.sql');
    fs.writeFileSync(seedFile, seed);
    const python = process.env.STACKPORT_TEST_PYTHON;
    const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PG/i.test(name)));
    const initialized = spawnSync(python || 'py.exe', [
      ...(python ? [] : ['-3']), path.join(__dirname, 'postgres-seed.py'), bin, seedFile,
    ], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 40_000,
      env: { ...fixtureEnv, PGHOST: 'localhost', PGHOSTADDR: '127.0.0.1', PGPORT: String(port),
        PGUSER: 'fixture_admin', PGPASSWORD: adminSecret, PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5',
        PGSSLMODE: 'verify-full', PGSSLROOTCERT: ca, PGCLIENTENCODING: 'UTF8' },
    });
    assert.equal(initialized.status, 0, initialized.error?.message ?? initialized.stderr);
  } catch (error) { server.kill(); throw error; }
  return { ca, port, close() {
    const stopped = spawnSync(path.join(bin, 'pg_ctl.exe'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '10'],
      { cwd: directory, timeout: 12_000, windowsHide: true });
    if (stopped.status !== 0) server.kill();
  } };
}

async function startGateway(target, targetHost = 'localhost') {
  const key = utils.generateKeyPairSync('ed25519').private;
  const fingerprint = 'SHA256:' + createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const clients = new Set();
  let forwards = 0;
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    client.on('authentication', auth => {
      if (auth.method === 'password' && auth.username === 'fixture' && auth.password === 'fixture-gateway') auth.accept();
      else auth.reject(['password']);
    });
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== targetHost || info.destPort !== target) return reject();
      const socket = net.connect(target, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        const channel = accept();
        forwards++;
        channel.on('error', () => socket.destroy());
        socket.on('error', () => channel.destroy());
        channel.once('close', () => socket.destroy());
        socket.once('close', () => channel.destroy());
        socket.pipe(channel).pipe(socket);
      });
    }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  function dropClients() {
    for (const client of clients) client.end();
  }
  return { port: server.address().port, fingerprint, forwarded: () => forwards, dropClients, close() {
    dropClients();
    server.close();
  } };
}

async function verify(browser, fixture, gateway, jump) {
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'PostgreSQL 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: 'PostgreSQL 연결 추가', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'PostgreSQL 연결 추가' });
  await form.getByLabel('연결 이름').fill('PG 검증');
  await form.getByLabel('호스트 이름 또는 IP').fill('localhost');
  await form.getByLabel('포트').fill(String(fixture.port));
  await form.getByLabel('데이터베이스 이름').fill('postgres');
  await form.getByLabel('사용자 이름').fill('fixture_reader');
  await form.getByLabel('환경').selectOption('PROD');
  await form.getByLabel('CA 인증서 경로 (선택)').fill(fixture.ca);
  await form.getByRole('button', { name: '저장', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  const [profile] = await command('list_postgres_profiles', { projectId: project.id });
  assert.ok(!JSON.stringify(profile).includes(password));
  const close = id => command('close_postgres', { id });
  const open = (settings = profile, secret = password, confirmation = 'PROD', tunnelId = null, gridEdit = false) =>
    command('open_postgres', { profile: settings, password: secret, confirmation, tunnelId, gridEdit });
  await assert.rejects(open(profile, password, ''), /PROD/);
  await assert.rejects(open(profile, 'wrong-password'), /암호 또는 접속 권한/);
  const alternate = (name, settings) => command('create_postgres_profile', {
    projectId: project.id, input: { ...profile.settings, ...settings, name },
  });
  const wrongCa = await alternate('System roots', { ca_path: null });
  const wrongHost = await alternate('Wrong hostname', { host: '127.0.0.1' });
  await assert.rejects(open(wrongCa), /TLS/);
  await assert.rejects(open(wrongHost), /TLS/);
  const session = await open();
  const schemas = await command('postgres_schemas', { id: session.id, page: 0 });
  assert.equal(schemas.schemas.find(schema => schema.name === 'restricted').accessible, false);
  assert.ok(!schemas.schemas.some(schema => schema.name === 'pg_catalog'));
  const report = schemas.schemas.find(schema => schema.name === 'report');
  const objects = await command('postgres_objects', { id: session.id, schema: report.id, search: '', page: 0 });
  const denied = objects.objects.find(object => object.name === 'denied');
  assert.equal(denied.readable, false);
  await assert.rejects(command('postgres_page', { id: session.id, object: denied.id, rowPage: 0, columnPage: 0 }), /권한/);
  const findObject = name => objects.objects.find(object => object.name === name).id;
  const structure = (name, section, page = 0) => command('postgres_structure', { id: session.id, object: findObject(name), section, page });
  await assert.rejects(structure('denied', 'overview'), /SELECT 권한/);
  await assert.rejects(command('postgres_structure', { id: session.id, object: 0, section: 'columns', page: 0 }), /객체를 찾을 수/);
  const childOverview = (await structure('meta_child', 'overview')).overview;
  assert.equal(childOverview.owner, 'fixture_admin');
  assert.deepEqual(childOverview.access, ['SELECT']);
  assert.equal(childOverview.force_row_security, true);
  assert.equal(childOverview.comment.text, '구조 검증 테이블');
  assert.equal(childOverview.view_sql, null);
  const childColumns = (await structure('meta_child', 'columns')).columns;
  assert.equal(childColumns.find(column => column.name === 'id').identity, 'a');
  const statusColumn = childColumns.find(column => column.name === 'status');
  assert.match(statusColumn.expression.text, /대기/);
  assert.match(statusColumn.collation, /"C"/);
  assert.equal(statusColumn.comment.text, '업무 상태');
  const generated = childColumns.find(column => column.name === 'normalized');
  assert.equal(generated.generated, 's');
  assert.match(generated.expression.text, /lower\(status\)/);
  const constraints = (await structure('meta_child', 'constraints')).constraints;
  const foreign = constraints.find(item => item.name === 'meta_fk');
  assert.deepEqual(foreign.columns, ['parent_id', 'tenant']);
  assert.deepEqual(foreign.reference.columns, ['parent_id', 'tenant']);
  assert.equal(foreign.reference.target.id, findObject('meta_parent'));
  assert.equal(foreign.deferrable && foreign.initially_deferred, true);
  assert.equal(constraints.find(item => item.name === 'tenant_positive').validated, false);
  const indexes = (await structure('meta_child', 'indexes')).indexes;
  const partial = indexes.find(item => item.name === 'meta_status_idx');
  assert.equal(partial.partial, true);
  assert.equal(partial.valid && partial.ready, true);
  assert.ok(partial.size_bytes > 0);
  assert.match(partial.definition.text, /CREATE INDEX.*lower\(status\).*WHERE/);
  const triggers = (await structure('meta_child', 'triggers')).triggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].enabled, 'D');
  assert.match(triggers[0].definition.text, /BEFORE UPDATE/);
  const materialized = (await structure('meta_cache', 'overview')).overview;
  assert.equal(materialized.populated, false);
  assert.match(materialized.view_sql.text, /count\(\*\)/i);
  const large = (await structure('meta_large', 'overview')).overview.view_sql;
  assert.equal(large.truncated, true);
  assert.equal(large.text.length, 16_384);
  const partitioned = (await structure('meta_ranges', 'overview')).overview;
  assert.equal(partitioned.partition_key.text, 'RANGE (id)');
  const partitions = (await structure('meta_ranges', 'partitions')).partitions;
  const lowPartition = partitions.find(item => item.name === 'meta_low');
  assert.match(lowPartition.bound.text, /FOR VALUES FROM.*TO/);
  assert.equal(lowPartition.target.id, findObject('meta_low'));
  assert.equal(partitions.find(item => item.name === 'meta_high').target, null);
  const firstColumns = await structure('meta_wide', 'columns');
  assert.equal(firstColumns.columns.length, 32);
  assert.equal(firstColumns.has_next, true);
  const moreColumns = await structure('meta_wide', 'columns', 1);
  assert.deepEqual(moreColumns.columns.map(column => column.position), [33, 34, 35]);
  assert.equal(moreColumns.has_next, false);
  const table = objects.objects.find(object => object.name === 'quoted table');
  const first = await command('postgres_page', { id: session.id, object: table.id, rowPage: 0, columnPage: 0 });
  assert.equal(first.rows[1][1].truncated, true);
  assert.equal(first.rows[1][1].value.length, 512);
  assert.equal(first.rows[2][1].value, '');
  const grid = (clauses, rowPage = 0, columnPage = 0, object = table.id) => command('postgres_page', {
    id: session.id, object, rowPage, columnPage, query: { conjunction: 'all', filters: [], sort: [], ...clauses },
  });
  const filter = (column, condition) => ({ column, condition });
  const text = value => ({ kind: 'text', value });
  const exact = (column, value) => filter(column, { kind: 'eq', value: text(value) });
  const range = (column, from, to) => filter(column, { kind: 'between', from: text(from), to: text(to) });
  const sort = (column, direction = 'asc', nulls = 'default') => ({ column, direction, nulls });
  const gridClauses = {
    filters: [range('id', '2', '105'), exact('precise', '9007199254740993.123'), exact('extra_23', '마지막 열')],
    sort: [sort('id', 'desc')],
  };
  const firstFiltered = await grid(gridClauses);
  assert.ok(firstFiltered.column_names.includes('extra_23'));
  assert.deepEqual(firstFiltered.parameter_types, [23, 23, 1700, 25]);
  assert.match(firstFiltered.source, /WHERE "quoted table"\."id" BETWEEN \$1 AND \$2 AND .* \$4\nORDER BY "quoted table"\."id" DESC/);
  assert.ok(!firstFiltered.source.includes('9007199254740993.123'));
  assert.deepEqual([firstFiltered.rows[0][0].value, firstFiltered.rows[99][0].value, firstFiltered.has_next], ['105', '6', true]);
  const secondFiltered = await grid(gridClauses, 1);
  assert.deepEqual(secondFiltered.rows.map(row => row[0].value), ['5', '4', '3', '2']);
  assert.equal(secondFiltered.has_next, false);
  const lastColumns = await grid(gridClauses, 1, 1);
  assert.deepEqual(lastColumns.rows.map(row => row[1].value), Array(4).fill('마지막 열'));
  const either = await grid({
    conjunction: 'any',
    filters: [filter('note', { kind: 'is_null' }), filter('note', { kind: 'contains', value: '행 105' }), exact('note', '')],
    sort: [sort('note', 'asc', 'first'), sort('id', 'desc')],
  });
  assert.deepEqual(either.rows.map(row => row[0].value), ['1', '3', '105']);
  assert.match(either.source, /ORDER BY .*"note" ASC NULLS FIRST, .*"id" DESC/);
  assert.match((await grid({ sort: [sort('note')] })).source, /ORDER BY .*"note" ASC, .*"id" ASC/);
  const dates = await grid({
    filters: [range('due date', '2026-01-01', '2026-01-31')], sort: [sort('due date', 'desc', 'last')],
  }, 0, 0, findObject('filtered_dates'));
  assert.deepEqual(dates.parameter_types, [1082, 1082]);
  assert.deepEqual(dates.rows.map(row => row[0].value), ['4', '3']);
  await assert.rejects(grid({ filters: [exact('id', '잘못된 값')] }), /필터 값의 형식/);
  await assert.rejects(grid({ filters: [exact('missing', '1')] }), /표시되는 열/);
  await assert.rejects(grid({ sort: [sort('id'), sort('id')] }), /두 번 정렬/);
  assert.equal((await grid({ filters: [exact('note', "행 '105")] })).rows.length, 0);
  const query = (sql, scope = { kind: 'document' }, request = randomUUID(), bindings = null, mode = undefined, file = undefined) =>
    command('execute_postgres_sql', { id: session.id, request, source: sql, scope, bindings, mode, export: file });
  const explain = (sql, mode, bindings = null) => query(sql, undefined, undefined, bindings, mode);
  const textValue = value => ({ kind: 'text', value });
  const content = await query("/* outer /* nested ; */ end */ SELECT $tag$한;글$tag$ AS duplicate, 9007199254740993.123::numeric AS duplicate, NULL::text; -- tail");
  assert.equal(content.status, 'completed', JSON.stringify(content));
  assert.equal(content.connection_closed, false);
  assert.deepEqual(content.columns.map(column => column.name), ['duplicate', 'duplicate', 'text']);
  assert.deepEqual(content.rows[0].map(value => value.value), ['한;글', '9007199254740993.123', null]);
  const capped = await query('SELECT * FROM report."quoted table" ORDER BY id');
  assert.equal(capped.rows.length, 100);
  assert.equal(capped.rows[99][0].value, '100');
  assert.equal(capped.more_rows, true);
  assert.equal(capped.total_columns, 26);
  assert.equal(capped.columns.length, 24);
  assert.equal(capped.rows[1][1].truncated, true);
  const allRows = 'SELECT id FROM report."quoted table" ORDER BY id';
  const estimate = await explain(allRows, 'estimate');
  assert.equal(estimate.status, 'plan', JSON.stringify(estimate));
  assert.equal(estimate.connection_closed, false);
  assert.equal(estimate.plan.analyzed, false);
  assert.equal(estimate.plan.execution_ms, null);
  assert.ok(estimate.plan.planning_ms >= 0);
  assert.ok(estimate.plan.steps.every(step => step.actual_rows === null && step.loops === null));
  assert.ok(estimate.plan.steps.some(step => step.schema === 'report' && step.relation === 'quoted table'));
  const analysis = await explain(allRows, 'analyze');
  assert.equal(analysis.status, 'plan', JSON.stringify(analysis));
  assert.equal(analysis.plan.analyzed, true);
  assert.ok(analysis.plan.execution_ms >= 0);
  assert.equal(analysis.plan.steps[0].actual_rows, 105);
  assert.equal(analysis.plan.steps[0].loops, 1);
  assert.ok(analysis.plan.steps.some(step => step.shared_hits !== null && step.shared_reads !== null));
  const indexPlan = await explain('SELECT payload FROM report.plan_events WHERE id=2100', 'estimate');
  assert.ok(indexPlan.plan.steps.some(step => step.index === 'plan_events_pkey'));
  const joinPlan = await explain('SELECT a.id, b.payload FROM report."quoted table" a JOIN report.plan_events b ON a.id=b.id ORDER BY a.note', 'analyze');
  assert.ok(joinPlan.plan.steps.some(step => step.join_type === 'Inner'));
  assert.ok(joinPlan.plan.steps.some(step => step.operation === 'Sort' && step.sort_method));
  const estimatedSleep = await explain('SELECT pg_sleep(12)', 'estimate');
  assert.equal(estimatedSleep.status, 'plan');
  const analyzedSleep = await explain('SELECT pg_sleep(0.12)', 'analyze');
  assert.ok(analyzedSleep.plan.execution_ms >= 100);
  const blockedInto = await explain('SELECT id INTO TEMP copied_fixture FROM report.write_probe', 'analyze');
  assert.equal(blockedInto.status, 'failed');
  assert.match(blockedInto.error, /읽기 전용/);
  await assert.rejects(query('SELECT 1; SELECT 2;'), /한 번에 한 문장/);
  for (const write of [
    "INSERT INTO report.write_probe VALUES (1) RETURNING id",
    "INSERT INTO report.write_probe VALUES ($1) RETURNING id",
    "WITH inserted AS (INSERT INTO report.write_probe VALUES (2) RETURNING id) SELECT id FROM inserted",
    "SET TRANSACTION READ WRITE",
    "CREATE TEMP TABLE fixture_scratch (value integer)",
  ]) {
    const result = await query(write);
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.match(result.error, /읽기 전용/);
    for (const mode of ['estimate', 'analyze']) {
      const planned = await explain(write, mode);
      assert.equal(planned.status, 'failed', JSON.stringify(planned));
      assert.match(planned.error, /읽기 전용/);
    }
  }
  const unchanged = await query("SELECT count(*) FROM report.write_probe");
  assert.equal(unchanged.rows[0][0].value, '0');
  const deniedSelect = await query('SELECT * FROM report.denied');
  assert.match(deniedSelect.error, /SQLSTATE 42501/);
  const positioned = "SELECT '🧪';" + '\n' + "SELECT missing FROM report.visible;";
  const selectionStart = positioned.indexOf('SELECT missing');
  const error = await query(positioned, { kind: 'selection', start: selectionStart, end: positioned.length });
  assert.equal(error.position, positioned.indexOf('missing'));
  const setting = await query("SELECT set_config('search_path', 'public', false)");
  assert.equal(setting.rows[0][0].value, 'public');
  const defaults = await query("SELECT current_setting('search_path'), current_setting('transaction_read_only')");
  assert.deepEqual(defaults.rows[0].map(value => value.value), ['pg_catalog', 'on']);

  const parameterized = "SELECT $1::numeric AS amount, $2::date, $3::report.grade, $4::int[], $5::text, length($6::text), coalesce($7::text, 'fallback')";
  const required = await query(parameterized);
  assert.equal(required.status, 'parameters_required', JSON.stringify(required));
  assert.deepEqual(required.parameters.map(parameter => [parameter.index, parameter.data_type]), [
    [1, 'numeric'], [2, 'date'], [3, 'report.grade'], [4, 'int4[]'], [5, 'text'], [6, 'text'], [7, 'text'],
  ]);
  const literal = "'; SELECT '한글 🧪'\n두 번째 줄";
  const values = ['9007199254740993.123000', '2024-02-29', 'gold', '{1,2,3}', literal, ''].map(textValue);
  values.push({ kind: 'null' });
  const bindings = { types: required.parameters.map(parameter => parameter.oid), values };
  const bound = await query(parameterized, undefined, undefined, bindings);
  assert.equal(bound.status, 'completed', JSON.stringify(bound));
  assert.deepEqual(bound.rows[0].map(cell => cell.value), ['9007199254740993.123000', '2024-02-29', 'gold', '{1,2,3}', literal, '0', 'fallback']);
  const rejected = await query(parameterized, undefined, undefined, { ...bindings, values: [textValue('secret-fixture-invalid'), ...values.slice(1)] });
  assert.equal(rejected.status, 'parameters_required', JSON.stringify(rejected));
  assert.match(rejected.error, /22P02/);
  assert.ok(!JSON.stringify(rejected).includes('secret-fixture-invalid'));
  const stale = await query(parameterized, undefined, undefined, { ...bindings, types: [23, ...bindings.types.slice(1)] });
  assert.match(stale.error, /타입이 달라졌습니다/);
  await assert.rejects(query(parameterized, undefined, undefined, { ...bindings, values: values.slice(0, 1) }), /개수/);
  await assert.rejects(query(parameterized, undefined, undefined, { ...bindings, values: [textValue('\0'), ...values.slice(1)] }), /NUL/);
  const unknown = await query('SELECT $1 IS NULL');
  assert.match(unknown.error, /타입 캐스트/);
  const filtered = 'SELECT id FROM report."quoted table" WHERE note = $1::text ORDER BY id';
  const planParameters = await explain(filtered, 'estimate');
  assert.equal(planParameters.status, 'parameters_required', JSON.stringify(planParameters));
  const secretPlanValue = 'fixture-binding-secret-value';
  const planBindings = { types: planParameters.parameters.map(parameter => parameter.oid), values: [textValue(secretPlanValue)] };
  for (const mode of ['estimate', 'analyze']) {
    const plan = await explain(filtered, mode, planBindings);
    assert.equal(plan.status, 'plan', JSON.stringify(plan));
    assert.ok(!JSON.stringify(plan).includes(secretPlanValue));
  }
  const withLimits = await query('SELECT ' + Array.from({ length: 33 }, (_, index) => '$' + (index + 1) + '::int').join(', '));
  assert.match(withLimits.error, /32개/);

  const outputDirectory = fs.mkdtempSync(path.join(root, 'export-fixtures-'));
  const options = (name, format) => ({ destination: path.join(outputDirectory, name + '.' + format),
    format, include_header: true, spreadsheet_safe: true });
  const save = (sql, file, token, values = null) => query(sql, undefined, token, values, undefined, file);
  const wide = options('wide', 'json');
  const wideReport = await save('SELECT * FROM report."quoted table" ORDER BY id', wide);
  assert.equal(wideReport.status, 'exported', JSON.stringify(wideReport));
  assert.equal(wideReport.report.rows, 105);
  const wideData = JSON.parse(fs.readFileSync(wide.destination, 'utf8'));
  assert.equal(wideData.format, 'stackport.postgres-results');
  assert.equal(wideData.version, 1);
  assert.equal(wideData.rows.length, 105);
  assert.equal(wideData.columns.length, 26);
  assert.deepEqual(wideData.columns[2], { name: 'precise', data_type: 'numeric' });
  assert.deepEqual(wideData.rows[0].slice(0, 3), ['1', null, '9007199254740993.123']);
  assert.equal(wideData.rows[1][1], '한'.repeat(513));
  assert.equal(wideData.rows[2][1], '');
  assert.equal(wideData.rows[104][25], '마지막 열');
  const exists = await save('SELECT 1', wide);
  assert.equal(exists.status, 'failed');
  assert.match(exists.error, /이미 있습니다/);
  assert.equal(JSON.parse(fs.readFileSync(wide.destination, 'utf8')).rows.length, 105);

  const csv = options('spreadsheet', 'csv');
  const csvReport = await save("SELECT -123::numeric AS number, '=1+1'::text AS text, ''::text AS empty, NULL::text AS missing, '\\N'::text AS token", csv);
  assert.equal(csvReport.status, 'exported', JSON.stringify(csvReport));
  assert.equal(csvReport.report.protected_fields, 1);
  assert.equal(fs.readFileSync(csv.destination, 'utf8'),
    "\"number\",\"text\",\"empty\",\"missing\",\"token\"\r\n-123,\"'=1+1\",\"\",\\N,\"\\N\"\r\n");
  const boundFile = options('bindings', 'json');
  const duplicateSql = 'SELECT $1::numeric AS val, $2::text AS val';
  const needs = await save(duplicateSql, boundFile);
  assert.equal(needs.status, 'parameters_required');
  assert.equal(fs.existsSync(boundFile.destination), false);
  const boundExport = await save(duplicateSql, boundFile, undefined, {
    types: needs.parameters.map(parameter => parameter.oid), values: [textValue('9007199254740993.123000'), textValue(literal)],
  });
  assert.equal(boundExport.status, 'exported', JSON.stringify(boundExport));
  const duplicateData = JSON.parse(fs.readFileSync(boundFile.destination, 'utf8'));
  assert.deepEqual(duplicateData.columns.map(column => column.name), ['val', 'val']);
  assert.deepEqual(duplicateData.rows, [['9007199254740993.123000', literal]]);
  const empty = options('empty', 'json');
  const emptyReport = await save('SELECT 1 AS id WHERE false', empty);
  assert.equal(emptyReport.status, 'exported');
  assert.deepEqual(JSON.parse(fs.readFileSync(empty.destination, 'utf8')).rows, []);
  const writeFile = options('write-blocked', 'csv');
  const refusedExport = await save('INSERT INTO report.write_probe VALUES (10) RETURNING id', writeFile);
  assert.equal(refusedExport.status, 'failed');
  assert.match(refusedExport.error, /읽기 전용/);
  assert.equal(fs.existsSync(writeFile.destination), false);
  const faultFile = options('runtime-error', 'csv');
  const fault = await save("SELECT i, repeat('a', 2048), CASE WHEN i < 100 THEN i ELSE 1/(i-i) END FROM generate_series(1,200) AS g(i)", faultFile);
  assert.equal(fault.status, 'failed');
  assert.match(fault.error, /22012/);
  assert.equal(fs.existsSync(faultFile.destination), false);
  async function waitForWritten(token) {
    const limit = Date.now() + 7_000;
    while (Date.now() < limit) {
      const rows = await command('postgres_export_progress', { id: session.id, request: token });
      if (rows > 0) return;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    throw new Error('The PostgreSQL export did not report written rows.');
  }
  const slowFile = options('cancelled', 'csv');
  const exportRequest = randomUUID();
  const exporting = save("SELECT i, repeat('a', 2048), pg_sleep(0.01) FROM generate_series(1,1000) AS g(i)", slowFile, exportRequest);
  await waitForWritten(exportRequest);
  assert.equal(await command('cancel_postgres_sql', { id: session.id, request: exportRequest }), true);
  const cancelledExport = await exporting;
  assert.equal(cancelledExport.status, 'interrupted', JSON.stringify(cancelledExport));
  assert.equal(cancelledExport.timed_out, false);
  assert.equal(fs.existsSync(slowFile.destination), false);
  const rival = options('race', 'csv');
  const rivalRequest = randomUUID();
  const publishing = save("SELECT i, repeat('a', 2048), pg_sleep(0.01) FROM generate_series(1,100) AS g(i)", rival, rivalRequest);
  await waitForWritten(rivalRequest);
  fs.writeFileSync(rival.destination, 'another application', { flag: 'wx' });
  const collision = await publishing;
  assert.equal(collision.status, 'failed', JSON.stringify(collision));
  assert.equal(fs.readFileSync(rival.destination, 'utf8'), 'another application');
  assert.ok(!fs.readdirSync(outputDirectory).some(name => name.startsWith('.stackport-')));
  const audit = await command('list_audit_events', { before: null });
  assert.ok(audit.events.some(event => event.operation === 'postgres.export.json' && event.profile_id === profile.id &&
    event.outcome === 'succeeded' && event.affected_count === 105));
  assert.ok(!JSON.stringify(audit).includes(boundFile.destination) && !JSON.stringify(audit).includes('9007199254740993'));

  const latinProfile = await alternate('Latin-1 database', { database: 'fixture_latin' });
  const latin = await open(latinProfile);
  try {
    assert.equal(latin.encoding, 'LATIN1');
    const latinQuery = bindings => command('execute_postgres_sql', { id: latin.id, request: randomUUID(),
      source: 'SELECT $1::text', scope: { kind: 'document' }, bindings });
    const latinTypes = await latinQuery(null);
    const types = latinTypes.parameters.map(parameter => parameter.oid);
    const representable = await latinQuery({ types, values: [textValue('café')] });
    assert.equal(representable.rows[0][0].value, 'café');
    const unrepresentable = await latinQuery({ types, values: [textValue('한글')] });
    assert.equal(unrepresentable.status, 'parameters_required');
    assert.match(unrepresentable.error, /22P05/);
  } finally { await close(latin.id); }

  const request = randomUUID();
  const slow = query('SELECT pg_sleep(6)', { kind: 'document' }, request);
  await new Promise(resolve => setTimeout(resolve, 350));
  await assert.rejects(query('SELECT 1'), /실행 중/);
  assert.equal(await command('cancel_postgres_sql', { id: session.id, request: randomUUID() }), false);
  assert.equal(await command('cancel_postgres_sql', { id: session.id, request }), true);
  assert.deepEqual(await slow, { status: 'interrupted', server_confirmed: true, timed_out: false, connection_closed: false });
  const afterCancel = await query('SELECT 7');
  assert.equal(afterCancel.rows[0][0].value, '7');
  const deadline = await query('SELECT pg_sleep(12)');
  assert.deepEqual(deadline, { status: 'interrupted', server_confirmed: true, timed_out: true, connection_closed: false });
  await verifyGridWrites({ command, open, close, profile, session, findObject });
  await close(session.id);
  await assert.rejects(command('postgres_schemas', { id: session.id, page: 0 }), /연결이 닫혔습니다/);

  const connection = page.getByRole('dialog', { name: 'PostgreSQL 연결', exact: true });
  async function connect(tunnel, gridEdit = false) {
    await page.getByRole('button', { name: 'PostgreSQL 연결', exact: true }).click();
    if (tunnel) await connection.getByLabel('연결 경로').selectOption(tunnel.id);
    await connection.getByLabel('PostgreSQL 암호').fill(password);
    await connection.getByLabel('운영 환경 확인').fill('PROD');
    if (gridEdit) await connection.getByLabel('이 연결에서 데이터 그리드 편집 허용').check();
    await connection.getByRole('button', { name: '연결', exact: true }).click();
    await connection.waitFor({ state: 'detached' });
  }
  const data = page.getByRole('table', { name: 'PostgreSQL 데이터', exact: true });
  const disconnect = () => page.getByRole('button', { name: 'PostgreSQL 연결 끊기', exact: true }).click();
  await connect();
  await page.getByText(/TLS 연결됨 · PostgreSQL/).waitFor();
  assert.equal(await page.getByRole('button', { name: /restricted/ }).isEnabled(), false);
  await page.getByRole('button', { name: 'report', exact: true }).click();
  await page.getByRole('button', { name: /denied SELECT 권한 없음/ }).waitFor();
  await page.getByRole('button', { name: /quoted table/ }).click();
  await data.getByRole('columnheader', { name: /id.*PK 1/ }).waitFor();
  assert.equal(await data.getByRole('row').count(), 101);
  await data.getByText('9007199254740993.123', { exact: true }).first().waitFor();
  await data.getByRole('row').nth(1).getByRole('cell').nth(1).getByText('NULL', { exact: true }).waitFor();
  await page.getByRole('button', { name: '다음 데이터 페이지' }).click();
  await data.getByText('행 105', { exact: true }).waitFor();
  assert.equal(await data.getByRole('row').count(), 6);
  await page.getByRole('button', { name: '다음 열 페이지' }).click();
  await data.getByText('마지막 열', { exact: true }).first().waitFor();
  const structurePane = page.getByRole('region', { name: 'PostgreSQL 객체 구조', exact: true });
  const structureButton = () => page.getByRole('button', { name: '구조', exact: true }).click();
  const section = name => structurePane.getByRole('navigation', { name: '구조 항목', exact: true })
    .getByRole('button', { name, exact: true }).click();
  const detail = title => structurePane.locator('details').filter({
    has: page.locator('summary').getByText(title, { exact: true }),
  });
  const openObject = name => page.getByRole('complementary', { name: 'PostgreSQL 객체 탐색' })
    .getByRole('button', { name: new RegExp('^' + name + '\\s') }).click();
  await structureButton();
  await structurePane.getByText('fixture_admin', { exact: true }).waitFor();
  await page.getByRole('button', { name: '데이터', exact: true }).click();
  await data.getByText('마지막 열', { exact: true }).first().waitFor();
  const exportDialog = page.getByRole('dialog', { name: '결과 내보내기', exact: true });
  const tableExport = path.join(root, 'postgres-table.csv');
  await page.getByRole('button', { name: '결과 내보내기', exact: true }).click();
  await exportDialog.getByLabel('새 CSV 파일 경로', { exact: true }).fill(tableExport);
  await exportDialog.getByRole('button', { name: 'CSV 저장', exact: true }).click();
  await exportDialog.waitFor({ state: 'detached' });
  await page.getByText('CSV 저장 완료 · 105행', { exact: true }).waitFor();
  const exportedTable = fs.readFileSync(tableExport, 'utf8');
  assert.match(exportedTable, /"extra_23"\r\n1,\\N,9007199254740993\.123,/);
  assert.match(exportedTable, /\r\n105,"행 105",/);
  await page.getByRole('button', { name: '이전 열 페이지', exact: true }).click();
  await data.getByRole('columnheader', { name: /id.*PK 1/ }).waitFor();
  const gridPane = page.getByRole('region', { name: 'PostgreSQL 조회 결과', exact: true });
  const filters = gridPane.locator('.table-query-controls');
  await filters.getByText('필터 및 정렬', { exact: true }).click();
  await filters.getByRole('button', { name: '조건 추가', exact: true }).click();
  await filters.getByLabel('필터 1 값', { exact: true }).fill('wrong-integer');
  await filters.getByRole('button', { name: '적용', exact: true }).click();
  await gridPane.getByRole('alert').getByText(/필터 값의 형식/).waitFor();
  assert.equal(await filters.getByLabel('필터 1 값', { exact: true }).inputValue(), 'wrong-integer');
  await filters.getByLabel('필터 1 연산자').selectOption('between');
  await filters.getByLabel('필터 1 값', { exact: true }).fill('2');
  await filters.getByLabel('필터 1 끝 값', { exact: true }).fill('105');
  await filters.getByRole('button', { name: '조건 추가', exact: true }).click();
  await filters.getByLabel('필터 2 열').selectOption('extra_23');
  await filters.getByLabel('필터 2 값', { exact: true }).fill('마지막 열');
  await filters.getByRole('button', { name: '정렬 열 추가', exact: true }).click();
  await filters.getByLabel('정렬 1 방향').selectOption('desc');
  await filters.getByRole('button', { name: '적용', exact: true }).click();
  await data.getByRole('row').nth(1).getByRole('cell').first().getByText('105', { exact: true }).waitFor();
  await gridPane.getByText('조회 SQL', { exact: true }).click();
  const filterSql = await gridPane.getByLabel('PostgreSQL 그리드 조회 SQL').textContent();
  assert.match(filterSql, /BETWEEN \$1 AND \$2.*\$3\nORDER BY .*"id" DESC/);
  assert.ok(!filterSql.includes('마지막 열'));
  await gridPane.getByRole('button', { name: '다음 데이터 페이지', exact: true }).click();
  await data.getByRole('row').nth(1).getByRole('cell').first().getByText('5', { exact: true }).waitFor();
  assert.equal(await data.getByRole('row').count(), 5);
  const filteredExport = path.join(root, 'postgres-filtered.csv');
  await gridPane.getByRole('button', { name: '결과 내보내기', exact: true }).click();
  await exportDialog.getByLabel('새 CSV 파일 경로', { exact: true }).fill(filteredExport);
  await exportDialog.getByRole('button', { name: 'CSV 저장', exact: true }).click();
  await exportDialog.waitFor({ state: 'detached' });
  await page.getByText('CSV 저장 완료 · 104행', { exact: true }).waitFor();
  const filteredIds = fs.readFileSync(filteredExport, 'utf8').trimEnd().split('\r\n').slice(1)
    .map(row => Number(row.slice(0, row.indexOf(','))));
  assert.deepEqual(filteredIds, Array.from({ length: 104 }, (_, position) => 105 - position));
  const filteredJson = path.join(root, 'postgres-filtered.json');
  await gridPane.getByRole('button', { name: '결과 내보내기', exact: true }).click();
  await exportDialog.getByLabel('파일 형식').selectOption('JSON');
  await exportDialog.getByLabel('새 JSON 파일 경로', { exact: true }).fill(filteredJson);
  await exportDialog.getByRole('button', { name: 'JSON 저장', exact: true }).click();
  await exportDialog.waitFor({ state: 'detached' });
  await page.getByText('JSON 저장 완료 · 104행', { exact: true }).waitFor();
  const filteredJsonRows = JSON.parse(fs.readFileSync(filteredJson, 'utf8')).rows;
  assert.deepEqual(filteredJsonRows.map(row => Number(row[0])), filteredIds);
  assert.ok(filteredJsonRows.every(row => row[2] === '9007199254740993.123' && row[25] === '마지막 열'));
  await filters.getByRole('button', { name: '초기화', exact: true }).click();
  await data.getByRole('row').nth(1).getByRole('cell').first().getByText('1', { exact: true }).waitFor();
  await openObject('filtered_dates');
  await data.getByRole('columnheader', { name: /due date/ }).waitFor();
  await filters.getByText('필터 및 정렬', { exact: true }).click();
  await filters.getByRole('button', { name: '조건 추가', exact: true }).click();
  await filters.getByLabel('필터 1 열').selectOption('due date');
  await filters.getByLabel('필터 1 연산자').selectOption('between');
  await filters.getByLabel('필터 1 값 형식').selectOption('date');
  await filters.getByLabel('필터 1 값', { exact: true }).fill('2026-01-01');
  await filters.getByLabel('필터 1 끝 값', { exact: true }).fill('2026-01-31');
  await filters.getByRole('button', { name: '정렬 열 추가', exact: true }).click();
  await filters.getByLabel('정렬 1 열').selectOption('due date');
  await filters.getByLabel('정렬 1 방향').selectOption('desc');
  const savedConditions = page.getByRole('dialog', { name: '저장된 조회 조건', exact: true });
  const savedButton = filters.getByRole('button', { name: '저장된 조건', exact: true });
  await savedButton.click();
  await savedConditions.getByLabel('새 조건 이름').fill('1월 마감');
  await savedConditions.getByRole('button', { name: '조건 저장', exact: true }).click();
  await savedConditions.getByText('조회 조건을 저장했습니다.').waitFor();
  await savedConditions.getByRole('button', { name: '닫기', exact: true }).click();
  assert.equal(await data.getByRole('row').count(), 5, 'saving a draft must not apply it');
  await disconnect();
  await connect();
  await page.getByRole('button', { name: 'report', exact: true }).click();
  await openObject('filtered_dates');
  await data.getByRole('columnheader', { name: /due date/ }).waitFor();
  await filters.getByText('필터 및 정렬', { exact: true }).click();
  await savedButton.click();
  await savedConditions.getByLabel('조회 조건').selectOption({ label: '1월 마감' });
  await savedConditions.getByRole('button', { name: '적용', exact: true }).click();
  await savedConditions.waitFor({ state: 'detached' });
  await data.getByRole('row').nth(1).getByRole('cell').first().getByText('4', { exact: true }).waitFor();
  assert.equal(await data.getByRole('row').count(), 3);
  assert.equal(await filters.getByLabel('필터 1 값 형식').inputValue(), 'date');
  assert.equal(await filters.getByLabel('필터 1 끝 값', { exact: true }).inputValue(), '2026-01-31');
  await openObject('meta_child');
  await structureButton();
  await structurePane.getByText('강제 적용', { exact: true }).waitFor();
  await structurePane.getByText('구조 검증 테이블', { exact: true }).waitFor();
  await section('열');
  const columnsGrid = structurePane.getByRole('table', { name: 'PostgreSQL 열 구조' });
  await columnsGrid.getByText('IDENTITY ALWAYS', { exact: true }).waitFor();
  await columnsGrid.getByText('STORED 생성 열', { exact: true }).waitFor();
  await columnsGrid.getByText('status 세부 정보', { exact: true }).click();
  await columnsGrid.getByText('업무 상태', { exact: true }).waitFor();
  assert.match(await columnsGrid.getByLabel('기본값 SQL 원문').textContent(), /대기/);
  await section('인덱스');
  const partialIndex = detail('meta_status_idx');
  await partialIndex.locator('summary').click();
  assert.match(await partialIndex.getByLabel('인덱스 생성 SQL 원문').textContent(), /lower\(status\)/);
  await section('트리거');
  const disabledTrigger = detail('meta_touch_row');
  await disabledTrigger.locator('summary').click();
  await disabledTrigger.getByText('비활성', { exact: true }).waitFor();
  assert.match(await disabledTrigger.getByLabel('트리거 생성 SQL 원문').textContent(), /BEFORE UPDATE/);
  await section('제약조건');
  const foreignKey = detail('meta_fk');
  await foreignKey.locator('summary').click();
  await foreignKey.getByText('report.meta_parent (parent_id, tenant)', { exact: true }).waitFor();
  await foreignKey.getByRole('button', { name: '참조 객체 열기', exact: true }).click();
  await page.getByRole('region', { name: 'PostgreSQL 조회 결과', exact: true }).getByText('report.meta_parent', { exact: true }).waitFor();
  await openObject('meta_ranges');
  await structureButton();
  await section('파티션');
  const deniedPartition = detail('report.meta_high');
  await deniedPartition.locator('summary').click();
  await deniedPartition.getByText('직접 조회 권한 없음', { exact: true }).waitFor();
  const readablePartition = detail('report.meta_low');
  await readablePartition.locator('summary').click();
  await readablePartition.getByRole('button', { name: '파티션 구조 열기', exact: true }).click();
  await structurePane.getByLabel('파티션 범위 원문').waitFor();
  await openObject('meta_wide');
  await structureButton();
  await section('열');
  await columnsGrid.getByRole('rowheader', { name: /col_32/ }).waitFor();
  await structurePane.getByRole('button', { name: '다음 열 페이지', exact: true }).click();
  await columnsGrid.getByRole('rowheader', { name: /col_35/ }).waitFor();
  await openObject('meta_large');
  await structureButton();
  await structurePane.getByText('정의의 처음 16,384자까지 표시합니다.', { exact: true }).waitFor();
  assert.equal(await structurePane.getByRole('button', { name: '정의 파일 저장' }).count(), 0);
  await openObject('meta_view');
  await structureButton();
  const definitionText = await structurePane.getByLabel('뷰 조회 정의 원문').textContent();
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: text => {
      window.stackPortTestCopied = text;
      return Promise.resolve();
    } });
  });
  await structurePane.getByRole('button', { name: 'SQL 복사', exact: true }).click();
  await structurePane.getByText('정의 SQL을 복사했습니다.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.stackPortTestCopied), definitionText);
  await page.evaluate(() => { delete navigator.clipboard.writeText; delete window.stackPortTestCopied; });
  await structurePane.getByRole('button', { name: '정의 파일 저장', exact: true }).click();
  const viewDdlPath = path.join(root, 'postgres-view-definition.sql');
  await page.getByLabel('새 SQL 파일 경로', { exact: true }).fill(viewDdlPath);
  await page.getByRole('button', { name: '새 파일에 저장', exact: true }).click();
  await structurePane.getByText(/SQL 파일 저장 완료/).waitFor();
  assert.equal(fs.readFileSync(viewDdlPath, 'utf8'), definitionText);
  await page.getByLabel('PostgreSQL 객체 검색').fill('visible');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await page.getByRole('button', { name: /visible 뷰/ }).click();
  await data.getByText('4', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'SQL로 열기', exact: true }).click();
  const sql = page.getByRole('textbox', { name: 'PostgreSQL SQL 쿼리', exact: true });
  const results = page.getByRole('table', { name: 'PostgreSQL SQL 데이터', exact: true });
  assert.equal(await sql.inputValue(), 'SELECT *\nFROM "report"."visible";');
  await sql.press('Control+Enter');
  await results.getByText('4', { exact: true }).waitFor();
  await page.getByRole('button', { name: '새 SQL 탭', exact: true }).click();
  const multiline = 'SELECT 123;\nSELECT id FROM report."quoted table" ORDER BY id;';
  await sql.fill(multiline);
  await sql.evaluate((input, selection) => input.setSelectionRange(selection, input.value.length), multiline.indexOf('SELECT id'));
  await sql.press('Control+Enter');
  await results.getByText('25', { exact: true }).waitFor();
  await page.getByRole('button', { name: '다음 SQL 결과 페이지' }).click();
  await results.getByText('26', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'SQL 2', exact: true }).click();
  await results.getByText('4', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'SQL 3', exact: true }).click();
  await sql.evaluate(input => input.setSelectionRange(3, 3));
  await sql.press('Control+Shift+Enter');
  await results.getByText('123', { exact: true }).waitFor();
  await sql.fill('SELECT missing FROM report.visible');
  await sql.press('Control+Enter');
  await page.getByRole('button', { name: '오류 위치로 이동' }).click();
  assert.equal(await sql.evaluate(input => input.selectionStart), 'SELECT '.length);
  await page.getByRole('button', { name: 'SQL 파일로 저장', exact: true }).click();
  const savedPath = path.join(root, 'postgres-file.sql');
  await page.getByLabel('새 SQL 파일 경로', { exact: true }).fill(savedPath);
  await page.getByRole('button', { name: '새 파일에 저장', exact: true }).click();
  await page.getByRole('tab', { name: 'postgres-file.sql', exact: true }).waitFor();
  assert.equal(fs.readFileSync(savedPath, 'utf8'), 'SELECT missing FROM report.visible');
  const importedPath = path.join(root, 'postgres-import.sql');
  fs.writeFileSync(importedPath, 'SELECT 321 AS imported;');
  await page.getByRole('button', { name: 'SQL 파일 열기', exact: true }).click();
  await page.getByLabel('SQL 파일 경로', { exact: true }).fill(importedPath);
  await page.getByRole('button', { name: '새 탭에서 열기', exact: true }).click();
  await page.getByRole('tab', { name: 'postgres-import.sql', exact: true }).waitFor();
  await sql.press('Control+Enter');
  await results.getByText('321', { exact: true }).waitFor();
  const parameters = page.getByRole('dialog', { name: 'PostgreSQL 매개변수', exact: true });
  const submitValues = () => parameters.getByRole('button', { name: '매개변수로 실행', exact: true }).click();
  const withParameters = "SELECT 1;\nSELECT $1::numeric AS amount, coalesce($2::text, '기본값') AS note;";
  await sql.fill(withParameters);
  await sql.evaluate((input, start) => input.setSelectionRange(start, input.value.length), withParameters.indexOf('SELECT $1'));
  await sql.press('Control+Enter');
  await parameters.getByRole('group', { name: /\$1.*numeric/ }).waitFor();
  await parameters.getByLabel('$1 값 숨기기', { exact: true }).check();
  assert.equal(await parameters.getByLabel('$1 값', { exact: true }).getAttribute('type'), 'password');
  await parameters.getByLabel('$1 값', { exact: true }).fill('masked-invalid-value');
  await parameters.getByLabel('$2 형식', { exact: true }).selectOption('null');
  await submitValues();
  const bindingError = parameters.getByRole('alert');
  await parameters.getByText(/SQLSTATE 22P02/).waitFor();
  assert.ok(!(await bindingError.textContent()).includes('masked-invalid-value'));
  assert.equal(await parameters.getByLabel('$1 값', { exact: true }).inputValue(), 'masked-invalid-value');
  await parameters.getByLabel('$1 값', { exact: true }).fill('9007199254740993.123000');
  await submitValues();
  await parameters.waitFor({ state: 'detached' });
  await results.getByText('9007199254740993.123000', { exact: true }).waitFor();
  await results.getByText('기본값', { exact: true }).waitFor();
  await sql.press('Control+Enter');
  await parameters.waitFor();
  assert.equal(await parameters.getByLabel('$1 값', { exact: true }).inputValue(), '');
  await parameters.getByRole('button', { name: '취소', exact: true }).click();
  await sql.fill("SELECT 'draft replacement'");
  const editorExport = path.join(root, 'postgres-editor.json');
  await page.getByRole('button', { name: '결과 내보내기', exact: true }).click();
  await exportDialog.getByLabel('파일 형식').selectOption('JSON');
  await exportDialog.getByLabel('새 JSON 파일 경로', { exact: true }).fill(editorExport);
  await exportDialog.getByRole('button', { name: 'JSON 저장', exact: true }).click();
  await parameters.getByLabel('$1 값', { exact: true }).fill('42.0');
  await parameters.getByLabel('$2 형식', { exact: true }).selectOption('null');
  await submitValues();
  await exportDialog.waitFor({ state: 'detached' });
  assert.deepEqual(JSON.parse(fs.readFileSync(editorExport, 'utf8')).rows, [['42.0', '기본값']]);
  const plan = page.getByRole('region', { name: 'PostgreSQL 실행 계획', exact: true });
  const analyze = page.getByRole('button', { name: '실행 분석', exact: true });
  const analyzeDialog = page.getByRole('dialog', { name: 'PostgreSQL 실행 분석', exact: true });
  const planTable = plan.getByRole('table', { name: 'PostgreSQL 실행 단계', exact: true });
  await sql.fill('SELECT id FROM report."quoted table" ORDER BY id');
  await page.getByRole('button', { name: '실행 계획', exact: true }).click();
  await plan.getByText('예상 실행 계획', { exact: true }).waitFor();
  await planTable.getByText(/report\.quoted table/).waitFor();
  assert.equal(await planTable.getByRole('columnheader', { name: '실제 행 / 회' }).count(), 0);
  await plan.getByRole('button', { name: '텍스트', exact: true }).click();
  const textPlan = plan.getByLabel('PostgreSQL 계획 텍스트');
  await textPlan.waitFor();
  assert.match(await textPlan.textContent(), /예상/);
  await analyze.click();
  await analyzeDialog.getByRole('button', { name: '취소', exact: true }).click();
  await plan.getByText('예상 실행 계획', { exact: true }).waitFor();
  await analyze.click();
  await analyzeDialog.getByRole('button', { name: '분석 실행', exact: true }).click();
  await plan.getByText(/서버 실행.*ms/).waitFor();
  await planTable.getByRole('columnheader', { name: '실제 행 / 회' }).waitFor();
  await planTable.getByText('105', { exact: true }).first().waitFor();
  await plan.getByRole('button', { name: '텍스트', exact: true }).click();
  const resultViews = page.getByRole('group', { name: 'PostgreSQL 결과 보기', exact: true });
  await resultViews.getByRole('button', { name: '조회 결과', exact: true }).click();
  await results.getByText('9007199254740993.123000', { exact: true }).waitFor();
  await resultViews.getByRole('button', { name: '계획 결과', exact: true }).click();
  await plan.getByText(/서버 실행.*ms/).waitFor();
  await textPlan.waitFor();
  await page.getByRole('button', { name: '객체 탐색', exact: true }).click();
  await data.getByText('4', { exact: true }).waitFor();
  await disconnect();

  await connect(null, true);
  await page.getByText('그리드 편집 허용', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'report', exact: true }).click();
  await page.getByRole('button', { name: 'edit demo 테이블', exact: true }).click();
  const cellEditor = page.getByRole('dialog', { name: 'PostgreSQL 행 편집', exact: true });
  const editNote = data.getByRole('button', { name: '1행 public note 편집', exact: true });
  assert.equal(await data.getByRole('button', { name: '1행 tenant key 편집', exact: true }).count(), 0);
  await editNote.click();
  await cellEditor.getByLabel('값 입력 방식').selectOption('null');
  await cellEditor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await cellEditor.getByText('변경 미리보기 · 1행 / 1열', { exact: true }).waitFor();
  await cellEditor.getByRole('button', { name: '변경 적용', exact: true }).click();
  await cellEditor.getByLabel('운영 환경 확인').fill('PROD');
  await cellEditor.getByRole('button', { name: '변경 적용', exact: true }).click();
  await cellEditor.waitFor({ state: 'detached' });
  await page.getByText('셀 변경 완료', { exact: true }).waitFor();
  await data.getByRole('row').nth(1).getByText('NULL', { exact: true }).waitFor();
  await editNote.click();
  await cellEditor.getByLabel('값 입력 방식').selectOption('default');
  await cellEditor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await cellEditor.getByText('실제 기본값은 적용할 때 서버에서 계산합니다.', { exact: true }).waitFor();
  await cellEditor.getByLabel('운영 환경 확인').fill('PROD');
  await cellEditor.getByRole('button', { name: '변경 적용', exact: true }).click();
  await cellEditor.waitFor({ state: 'detached' });
  await data.getByText('기본값', { exact: true }).waitFor();
  await editNote.click();
  await cellEditor.getByLabel('추가할 열').selectOption('amount');
  await cellEditor.getByRole('button', { name: '열 추가', exact: true }).click();
  const noteDraft = cellEditor.getByRole('group', { name: /^public note / });
  const amountDraft = cellEditor.getByRole('group', { name: /^amount / });
  await noteDraft.getByLabel('변경할 값').fill('화면 다중 수정');
  await amountDraft.getByLabel('변경할 값').fill('25.125');
  await noteDraft.getByText(/변경됨/).waitFor();
  assert.equal(await page.evaluate(() => {
    const probe = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(probe);
    return probe.defaultPrevented;
  }), true);
  await page.keyboard.press('Escape');
  await cellEditor.getByText('적용하지 않은 변경이 있습니다.', { exact: true }).waitFor();
  await cellEditor.getByRole('button', { name: '계속 편집', exact: true }).click();
  await cellEditor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await cellEditor.getByText('변경 미리보기 · 1행 / 2열', { exact: true }).waitFor();
  await cellEditor.getByRole('region', { name: 'public note 변경 비교', exact: true }).getByText('화면 다중 수정').waitFor();
  await cellEditor.getByRole('region', { name: 'amount 변경 비교', exact: true }).getByText('25.125').waitFor();
  await cellEditor.getByRole('button', { name: '다시 편집', exact: true }).click();
  assert.equal(await amountDraft.getByLabel('변경할 값').inputValue(), '25.125');
  await cellEditor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await cellEditor.getByLabel('운영 환경 확인').fill('PROD');
  await cellEditor.getByRole('button', { name: '변경 적용', exact: true }).click();
  await cellEditor.waitFor({ state: 'detached' });
  await page.getByText('2개 셀 변경 완료', { exact: true }).waitFor();
  await data.getByText('화면 다중 수정', { exact: true }).waitFor();
  await data.getByText('25.125', { exact: true }).waitFor();
  await editNote.click();
  await cellEditor.getByLabel('변경할 값').fill('버릴 초안');
  await cellEditor.getByRole('button', { name: '닫기', exact: true }).last().click();
  await cellEditor.getByRole('button', { name: '변경 버리기', exact: true }).click();
  await cellEditor.waitFor({ state: 'detached' });
  await data.getByText('화면 다중 수정', { exact: true }).waitFor();
  await disconnect();

  const ssh = await command('create_ssh_profile', { projectId: project.id, input: {
    name: 'PG 게이트웨이', host: '127.0.0.1', port: gateway.port, username: 'fixture', environment: 'DEV',
  } });
  const jumpProfile = await command('create_ssh_profile', { projectId: project.id, input: {
    name: 'PG 점프', host: '127.0.0.1', port: jump.port, username: 'fixture', environment: 'DEV',
  } });
  const tunnel = await command('create_ssh_tunnel', { projectId: project.id, input: {
    name: '보고서 터널', ssh_profile_id: ssh.id, kind: 'local', listen_port: 0, target_host: 'localhost', target_port: fixture.port,
  } });
  const authentication = { kind: 'password', password: 'fixture-gateway' };
  const start = () => command('start_ssh_tunnel', {
    tunnel, profile: ssh, authentication, hops: [{ profile: jumpProfile, authentication }], confirmation: '',
  });
  for (const [stage, server] of [['경유 1 · PG 점프', jump], ['대상 · PG 게이트웨이', gateway]]) {
    const trust = await start();
    assert.equal(trust.status, 'trust_required');
    assert.equal(trust.stage, stage);
    assert.ok(trust.host.keys.some(key => key.fingerprint === server.fingerprint));
    await command('trust_ssh_host', { token: trust.host.token, fingerprint: server.fingerprint, confirmation: '' });
  }
  const running = await start();
  assert.equal(running.status, 'open');
  try {
    await connect(tunnel);
    await page.getByText(/TLS 연결됨.*SSH 터널 보고서 터널/).waitFor();
    await page.getByRole('button', { name: 'report', exact: true }).click();
    await page.getByRole('button', { name: /visible 뷰/ }).click();
    await data.getByText('4', { exact: true }).waitFor();
    assert.equal(gateway.forwarded(), 1);
    assert.ok(jump.forwarded() > 0);
    await page.getByRole('button', { name: 'SQL 편집기', exact: true }).click();
    await sql.fill('SELECT pg_sleep($1::float8)');
    await analyze.click();
    await analyzeDialog.getByRole('button', { name: '분석 실행', exact: true }).click();
    await parameters.getByLabel('$1 값', { exact: true }).fill('6');
    await submitValues();
    const cancel = parameters.getByRole('button', { name: '쿼리 취소', exact: true });
    await cancel.waitFor();
    await new Promise(resolve => setTimeout(resolve, 350));
    await cancel.click();
    await page.getByText('PostgreSQL 서버에서 쿼리 중단을 확인했습니다.', { exact: true }).waitFor();
    assert.equal(gateway.forwarded(), 2);
    await sql.fill('SELECT 123');
    await sql.press('Control+Enter');
    await results.getByText('123', { exact: true }).waitFor();
    const tunnelExport = path.join(root, 'postgres-tunnel.json');
    await page.getByRole('button', { name: '결과 내보내기', exact: true }).click();
    await exportDialog.getByLabel('파일 형식').selectOption('JSON');
    await exportDialog.getByLabel('새 JSON 파일 경로', { exact: true }).fill(tunnelExport);
    await exportDialog.getByRole('button', { name: 'JSON 저장', exact: true }).click();
    await exportDialog.waitFor({ state: 'detached' });
    assert.deepEqual(JSON.parse(fs.readFileSync(tunnelExport, 'utf8')).rows, [['123']]);
    assert.equal(gateway.forwarded(), 2);

    const draft = 'SELECT $1::int + 90';
    await sql.fill(draft);
    await sql.press('Control+Enter');
    await parameters.getByLabel('$1 값', { exact: true }).waitFor();
    await command('stop_ssh_tunnel', { id: tunnel.id });
    const lossMessage = /SSH 터널 ‘보고서 터널’이 중단되어 PostgreSQL 연결/;
    const loss = page.locator('.postgres-recovery').getByRole('alert').filter({ hasText: lossMessage });
    const reconnect = page.getByRole('button', { name: 'PostgreSQL 다시 연결', exact: true });
    await loss.waitFor();
    await parameters.waitFor({ state: 'detached' });
    assert.equal(await sql.inputValue(), draft);
    assert.equal(await page.getByRole('button', { name: '쿼리 실행', exact: true }).isEnabled(), false);
    await reconnect.click();
    const route = connection.getByLabel('연결 경로');
    assert.equal(await route.inputValue(), tunnel.id);
    await route.locator('option').filter({ hasText: '보고서 터널 · 사용할 수 없음' }).waitFor({ state: 'attached' });
    await connection.getByLabel('PostgreSQL 암호').fill(password);
    await connection.getByLabel('운영 환경 확인').fill('PROD');
    const connectButton = connection.getByRole('button', { name: '연결', exact: true });
    assert.equal(await connectButton.isEnabled(), false);
    await connection.getByRole('button', { name: 'SSH 터널 열기', exact: true }).click();
    await page.getByRole('table', { name: '저장된 SSH 터널' }).getByText('보고서 터널', { exact: true }).waitFor();
    assert.equal((await start()).status, 'open');
    const liveTunnel = page.getByRole('table', { name: '실행 중인 SSH 터널' }).getByRole('row').filter({ hasText: '보고서 터널' });
    await liveTunnel.getByText(/PG 점프.*PG 게이트웨이/).waitFor();
    await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
    await reconnect.click();
    assert.equal(await route.inputValue(), tunnel.id);
    await connection.getByLabel('PostgreSQL 암호').fill(password);
    await connection.getByLabel('운영 환경 확인').fill('PROD');
    await connectButton.click();
    await connection.waitFor({ state: 'detached' });
    assert.equal(await sql.inputValue(), draft);
    await sql.press('Control+Enter');
    await parameters.getByLabel('$1 값', { exact: true }).fill('7');
    await submitValues();
    await results.getByText('97', { exact: true }).waitFor();

    const interruptedExport = path.join(root, 'postgres-tunnel-interrupted.csv');
    await page.getByRole('button', { name: '결과 내보내기', exact: true }).click();
    await exportDialog.getByLabel('새 CSV 파일 경로', { exact: true }).fill(interruptedExport);
    await exportDialog.getByRole('button', { name: 'CSV 저장', exact: true }).click();
    await parameters.getByLabel('$1 값', { exact: true }).waitFor();
    jump.dropClients();
    await parameters.waitFor({ state: 'detached' });
    await exportDialog.getByRole('alert').filter({ hasText: lossMessage }).waitFor();
    assert.equal(await exportDialog.getByRole('button', { name: 'CSV 저장', exact: true }).isEnabled(), false);
    await exportDialog.getByRole('button', { name: '닫기', exact: true }).last().click();
    await loss.waitFor();
    assert.equal(await sql.inputValue(), draft);
    assert.equal(fs.existsSync(interruptedExport), false);
    await reconnect.waitFor();
  } finally { await command('stop_ssh_tunnel', { id: tunnel.id }); }
  await assert.rejects(open(profile, password, 'PROD', tunnel.id), /실행 중인 로컬 SSH 터널/);
  assert.deepEqual(errors, []);
}

async function verifyGridWrites({ command, open, close, profile, session, findObject }) {
  const object = findObject('edit demo');
  const page = (id, target = object) => command('postgres_page', { id, object: target, rowPage: 0, columnPage: 0 });
  const readOnly = await page(session.id);
  assert.equal(session.grid_edit, false);
  assert.equal(readOnly.row_stamps, null);
  await assert.rejects(command('begin_postgres_edit', {
    id: session.id, object, stamp: { tuple: '(0,1)', version: '1', keys: [] }, column: 'public note',
  }), /편집을 허용/);
  const writer = await open(profile, undefined, undefined, null, true);
  const peer = await open(profile, undefined, undefined, null, true);
  try {
    const id = writer.id;
    const view = await page(id);
    assert.equal(writer.grid_edit, true);
    assert.deepEqual(view.row_stamps.map(stamp => stamp.keys[0]), ['1', '2']);
    const securityState = await command('execute_postgres_sql', {
      id, request: randomUUID(), source: "SELECT current_user, pg_catalog.row_security_active('report.\"edit demo\"'::regclass)", scope: { kind: 'document' },
    });
    assert.deepEqual(securityState.rows[0].map(cell => cell.value), ['fixture_reader', 'true']);
    assert.deepEqual(view.columns.map(column => [column.name, column.editable]), [
      ['tenant key', false], ['row key', false], ['public note', true], ['amount', true], ['unique note', false],
    ]);
    assert.equal((await page(id, findObject('write_probe'))).row_stamps, null);
    assert.match((await page(id, findObject('edit_trigger'))).edit_reason, /트리거/);
    assert.match((await page(id, findObject('quoted table'))).edit_reason, /UPDATE 권한/);
    assert.equal((await page(id, findObject('meta_ranges'))).row_stamps, null);
    const begin = (id, stamp, column) => command('begin_postgres_edit', { id, object, stamp, column });
    const preview = (id, token, input) => command('preview_postgres_edit', { id, token, input });
    const apply = (id, token, approval, confirmation = 'PROD') => command('apply_postgres_edit', { id, token, approval, confirmation });
    const input = value => ({ kind: 'text', value });
    await assert.rejects(begin(id, view.row_stamps[0], 'unique note'), /편집할 수 없습니다/);
    const amount = await begin(id, view.row_stamps[0], 'amount');
    assert.deepEqual(amount.keys, [['tenant key', '1'], ['row key', '9a048887-22a5-4c98-bbc1-7ceee4ee725d']]);
    assert.equal(amount.current.value, '9007199254740993.123');
    const normalized = await preview(id, amount.token, input('9007199254740993.1247'));
    assert.equal(normalized.after.value, '9007199254740993.125');
    await assert.rejects(apply(id, amount.token, normalized.approval, ''), /PROD/);
    assert.equal((await page(peer.id)).rows[0][3].value, '9007199254740993.123');
    assert.equal((await apply(id, amount.token, normalized.approval)).actual.value, '9007199254740993.125');
    await assert.rejects(apply(id, amount.token, normalized.approval), /만료/);
    await assert.rejects(begin(id, view.row_stamps[0], 'public note'), /행이 변경/);

    const now = await page(id);
    const bad = await begin(id, now.row_stamps[0], 'amount');
    const oldApproval = await preview(id, bad.token, input('0'));
    await assert.rejects(preview(id, bad.token, input('fixture-secret-incompatible')), /열 타입/);
    await assert.rejects(apply(id, bad.token, oldApproval.approval), /다시 미리/);
    const constraint = await preview(id, bad.token, input('-1'));
    await assert.rejects(apply(id, bad.token, constraint.approval), /23514/);
    assert.equal((await page(peer.id)).rows[0][3].value, '9007199254740993.125');

    const stale = await begin(id, now.row_stamps[0], 'amount');
    const staleChange = await preview(id, stale.token, input('12.345'));
    const other = await begin(peer.id, now.row_stamps[0], 'public note');
    const otherChange = await preview(peer.id, other.token, input('동시 변경'));
    assert.equal((await apply(peer.id, other.token, otherChange.approval)).status, 'applied');
    await assert.rejects(apply(id, stale.token, staleChange.approval), /행이 변경/);

    const rls = await begin(id, now.row_stamps[1], 'public note');
    const rlsChange = await preview(id, rls.token, input('권한 밖의 행'));
    await assert.rejects(apply(id, rls.token, rlsChange.approval), /편집 권한/);
    const latest = await page(id);
    assert.deepEqual(latest.rows.map(row => [row[2].value, row[3].value]), [
      ['동시 변경', '9007199254740993.125'], ['다른 행', '2.000'],
    ]);
    const cancelled = await begin(id, latest.row_stamps[0], 'public note');
    const discarded = await preview(id, cancelled.token, input(''));
    assert.equal(discarded.after.value, '');
    await command('cancel_postgres_edit', { id, token: cancelled.token });
    await assert.rejects(apply(id, cancelled.token, discarded.approval), /만료/);
    const openField = (token, column) => command('open_postgres_edit_field', { id, token, column });
    const staged = (token, changes) => command('preview_postgres_row_edit', { id, token, changes });
    const change = (column, value) => ({ column, input: input(value) });
    const batch = await begin(id, latest.row_stamps[0], 'public note');
    assert.deepEqual(batch.columns, ['public note', 'amount']);
    await assert.rejects(openField(batch.token, 'unique note'), /편집할 수 없습니다/);
    await assert.rejects(staged(batch.token, [change('amount', '8')]), /열을 다시 열어/);
    assert.equal((await openField(batch.token, 'amount')).current.value, '9007199254740993.125');
    await assert.rejects(staged(batch.token, [change('amount', '8'), change('amount', '9')]), /같은 열/);
    const badBatch = await staged(batch.token, [change('public note', '저장되면 안 되는 값'), change('amount', '-1')]);
    assert.equal(badBatch.changes.length, 2);
    await assert.rejects(apply(id, batch.token, badBatch.approval), /23514/);
    assert.deepEqual((await page(peer.id)).rows[0].slice(2, 4).map(cell => cell.value),
      ['동시 변경', '9007199254740993.125']);
    const fresh = await page(id);
    const all = await begin(id, fresh.row_stamps[0], 'public note');
    await openField(all.token, 'amount');
    const onlyChanged = await staged(all.token, [change('public note', '동시 변경'), change('amount', '8')]);
    assert.deepEqual(onlyChanged.changes.map(cell => cell.column), ['amount']);
    const combined = await staged(all.token, [change('public note', '조합'), change('amount', '8')]);
    assert.deepEqual(combined.changes.map(cell => [cell.column, cell.after.value]), [['public note', '조합'], ['amount', '8.000']]);
    await assert.rejects(apply(id, all.token, onlyChanged.approval), /다시 미리/);
    assert.equal((await apply(id, all.token, combined.approval)).affected_cells, 2);
    assert.deepEqual((await page(peer.id)).rows[0].slice(2, 4).map(cell => cell.value), ['조합', '8.000']);
    const raw = await command('execute_postgres_sql', {
      id, request: randomUUID(), source: 'UPDATE report."edit demo" SET amount = 0 RETURNING amount', scope: { kind: 'document' },
    });
    assert.equal(raw.status, 'failed');
    const history = await command('list_audit_events', { before: null });
    const edits = history.events.filter(event => event.operation === 'postgres.edit.cell');
    assert.ok(edits.some(event => event.outcome === 'succeeded' && event.affected_count === 1));
    assert.ok(edits.some(event => event.outcome === 'failed'));
    assert.equal(edits.filter(event => event.outcome === 'started').length, 5);
    assert.doesNotMatch(JSON.stringify(edits), /9a048887|fixture-secret|동시 변경|권한 밖/);
    const rows = history.events.filter(event => event.operation === 'postgres.edit.row');
    assert.deepEqual(rows.map(event => event.outcome).sort(), ['failed', 'started', 'started', 'succeeded']);
    assert.equal(rows.find(event => event.outcome === 'succeeded').affected_count, 1);
  } finally {
    await close(writer.id);
    await close(peer.id);
  }
}

async function main() {
  const fixture = await startPostgres();
  let gateway;
  let jump;
  let browser;
  try {
    gateway = await startGateway(fixture.port);
    jump = await startGateway(gateway.port, '127.0.0.1');
    browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
    await verify(browser, fixture, gateway, jump);
    console.log('Windows PostgreSQL E2E passed (grid editing, rollback, SQL, TLS and SSH jump recovery).');
  } finally {
    await browser?.close();
    jump?.close();
    gateway?.close();
    fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
