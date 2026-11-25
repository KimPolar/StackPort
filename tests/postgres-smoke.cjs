const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { crc32 } = require('node:zlib');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { startGateway } = require('./ssh-forward-fixture.cjs');

const root = process.env.STACKPORT_TEST_ROOT;
const bin = process.env.STACKPORT_POSTGRES_BIN;
const backupTools = process.env.STACKPORT_POSTGRES_TOOLS_DIR;
const openssl = process.env.STACKPORT_TEST_OPENSSL || 'openssl';
const password = 'fixture-reader-password';
const otherPassword = 'fixture-unrelated-role-password';
const binaryCell = Buffer.from('007fff5c00a1'.repeat(15_000) + 'cafe', 'hex');
const unicodeCell = '한😀'.repeat(36_000) + '\r\n끝';
const staticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIqIgCAAI+ASOK5tZ4AAAAAElFTkSuQmCC', 'base64');
const pngMetadata = Buffer.from('tEXtComment\0fixture-only metadata');
const textChunk = Buffer.alloc(pngMetadata.length + 8);
textChunk.writeUInt32BE(pngMetadata.length - 4);
pngMetadata.copy(textChunk, 4);
textChunk.writeUInt32BE(crc32(pngMetadata), textChunk.length - 4);
const pngCell = Buffer.concat([staticPng.subarray(0, 33), textChunk, staticPng.subarray(33)]);
const oversizedRaster = Buffer.from(staticPng);
oversizedRaster.writeUInt32BE(2049, 16);
const typedJson = '{"id":9007199254740993,"id":9007199254740995,"padding":"' + '한'.repeat(6000) + '"}';
if (!root || !bin) throw new Error('Set STACKPORT_TEST_ROOT and STACKPORT_POSTGRES_BIN.');

const readStatementStats = (command, id, options = {}) => command('postgres_statement_stats', { id,
  input: { order: 'maximum', own_only: false, minimum_ms: 0, page: 0, ...options } });

async function startPostgres(preloadStats = true) {
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
    `CREATE ROLE fixture_unrelated LOGIN PASSWORD '${otherPassword}';`,
    'CREATE SCHEMA "monitor ""catalog""";',
    'CREATE EXTENSION pg_stat_statements WITH SCHEMA "monitor ""catalog""";',
    'GRANT USAGE ON SCHEMA "monitor ""catalog""" TO fixture_reader;',
    'CREATE SCHEMA report;',
    'CREATE SCHEMA archive;',
    'CREATE SCHEMA restricted;',
    "CREATE VIEW report.pg_stat_statements AS SELECT 'test shadow view'::text AS marker;",
    'GRANT SELECT ON report.pg_stat_statements TO fixture_reader;',
    'GRANT USAGE ON SCHEMA report TO fixture_reader;',
    'GRANT USAGE ON SCHEMA archive TO fixture_reader;',
    'CREATE TABLE archive.meta_child (archive_only integer);',
    'CREATE TABLE archive."match%_literal" (id integer);',
    ...Array.from({ length: 41 }, (_, index) => `CREATE VIEW archive.object_search_${String(index).padStart(2, '0')} AS SELECT 1 AS id;`),
    'GRANT SELECT ON ALL TABLES IN SCHEMA archive TO fixture_reader;',
    'CREATE TABLE restricted.hidden_object (id integer);',
    'GRANT SELECT ON restricted.hidden_object TO fixture_reader;',
    "COMMENT ON TABLE restricted.hidden_object IS 'catalog hidden marker';",
    "CREATE TYPE report.grade AS ENUM ('silver', 'gold');",
    `CREATE TABLE report."quoted table" (id integer PRIMARY KEY, note text, precise numeric(30,3), ${extra});`,
    `INSERT INTO report."quoted table" (id, note, precise, extra_23)
       SELECT i, CASE i WHEN 1 THEN NULL WHEN 2 THEN repeat('한', 513) WHEN 3 THEN '' ELSE '행 ' || i END,
       9007199254740993.123, '마지막 열' FROM generate_series(1, 105) AS series(i);`.replace(/\s+/g, ' '),
    'CREATE VIEW report.visible AS SELECT id FROM report."quoted table" WHERE id=4;',
    'CREATE TABLE report.filtered_dates (id integer PRIMARY KEY, "due date" date);',
    "INSERT INTO report.filtered_dates VALUES (1, NULL), (2, '2025-12-31'), (3, '2026-01-02'), (4, '2026-01-31');",
    'GRANT SELECT ON report.filtered_dates TO fixture_reader;',
    'CREATE TABLE report.raw_cells (id integer, note text, payload bytea);',
    "INSERT INTO report.raw_cells VALUES (1, repeat('한😀', 36000) || chr(13) || chr(10) || '끝', decode(repeat('007fff5c00a1',15000) || 'cafe','hex'))," +
      "(2, '', decode('','hex')), (3, NULL, NULL), (4, 'private source cell', decode('0100','hex'));",
    'ALTER TABLE report.raw_cells ENABLE ROW LEVEL SECURITY;',
    'GRANT SELECT ON report.raw_cells TO fixture_reader, fixture_unrelated;',
    'GRANT USAGE ON SCHEMA report TO fixture_unrelated;',
    'CREATE POLICY raw_reader_cells ON report.raw_cells FOR SELECT TO fixture_reader USING (id < 4);',
    'CREATE POLICY raw_other_cell ON report.raw_cells FOR SELECT TO fixture_unrelated USING (id = 4);',
    'CREATE TABLE report.typed_cells (id integer PRIMARY KEY, payload bytea, document json, document_binary jsonb, markup xml);',
    `INSERT INTO report.typed_cells VALUES
      (1, decode('${pngCell.toString('hex')}', 'hex'), '${typedJson}', '{"count":9007199254740993}', '<report id="17"><section>한글</section></report>'),
      (2, decode('${oversizedRaster.toString('hex')}', 'hex'), NULL, NULL, '<?fixture inert?><report>원문 유지</report>'),
      (3, decode('${staticPng.toString('hex')}', 'hex') || decode(repeat('00',1048576),'hex'), NULL, jsonb_build_object('large',repeat('x',262145)), '<empty/>');`,
    'GRANT SELECT ON report.typed_cells TO fixture_reader;',
    'CREATE TABLE report.denied (id integer);',
    "COMMENT ON TABLE report.denied IS 'catalog hidden marker';",
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
    'CREATE TABLE report."row actions" (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "row label" text NOT NULL UNIQUE, ' +
      "empty_text text DEFAULT 'default text', optional text DEFAULT 'not null', amount numeric(30,2) DEFAULT 7, due date DEFAULT DATE '2026-01-02', observed timestamptz);",
    'ALTER TABLE report."row actions" ENABLE ROW LEVEL SECURITY;',
    'CREATE POLICY row_action_read ON report."row actions" FOR SELECT TO fixture_reader USING (true);',
    'CREATE POLICY row_action_insert ON report."row actions" FOR INSERT TO fixture_reader WITH CHECK ("row label" <> \'deny\');',
    'CREATE POLICY row_action_delete ON report."row actions" FOR DELETE TO fixture_reader USING (true);',
    'GRANT SELECT, INSERT, DELETE ON report."row actions" TO fixture_reader;',
    "CREATE TABLE report.json_source (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, amount numeric(38,9), " +
      "payload json, flag boolean, note text DEFAULT 'DB 기본값', binary_data bytea);",
    'CREATE TABLE report.json_replay (LIKE report.json_source INCLUDING ALL);',
    'INSERT INTO report.json_source (amount, payload, flag, note, binary_data) ' +
      "VALUES (0.5, '{\"seed\":true}', false, NULL, decode('00ff5c','hex'));",
    'GRANT SELECT, INSERT ON report.json_source, report.json_replay TO fixture_reader;',
    'CREATE TABLE report.xml_import (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code text NOT NULL UNIQUE, ' +
      "amount numeric(38,9) NOT NULL, note text DEFAULT 'DB 기본값', markup xml);",
    'GRANT SELECT, INSERT ON report.xml_import TO fixture_reader;',
    "CREATE TABLE report.row_guard (id integer PRIMARY KEY, label text); INSERT INTO report.row_guard VALUES (1, 'before');",
    'GRANT SELECT, UPDATE, DELETE ON report.row_guard TO fixture_reader;',
    "CREATE TABLE report.grid_updates (id int PRIMARY KEY, note text DEFAULT '서버 기본값', " +
      'amount numeric(30,3) NOT NULL CHECK (amount >= 0), large_note text, ' +
      'parent_id int REFERENCES report.row_guard(id) DEFERRABLE INITIALLY DEFERRED, observed timestamptz);',
    "INSERT INTO report.grid_updates (id, note, amount, large_note) VALUES (1, '첫 값', 3, repeat('가', 4097)), (2, '둘째 값', 4, '짧은 값');",
    'GRANT SELECT, UPDATE ON report.grid_updates TO fixture_reader;',
    'CREATE TABLE report.paste_refs (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id integer NOT NULL REFERENCES report.row_guard(id) DEFERRABLE INITIALLY DEFERRED);',
    'GRANT SELECT, INSERT ON report.paste_refs TO fixture_reader;',
    'CREATE TABLE report.row_cascade (id integer PRIMARY KEY); INSERT INTO report.row_cascade VALUES (1);',
    'CREATE TABLE report.row_cascade_child (parent integer REFERENCES report.row_cascade(id) ON DELETE CASCADE);',
    'GRANT SELECT, DELETE ON report.row_cascade TO fixture_reader;',
    'CREATE TABLE report.meta_parent (parent_id integer, tenant integer, CONSTRAINT meta_parent_pk PRIMARY KEY (parent_id, tenant));',
    'ALTER TABLE archive.meta_child ADD COLUMN tenant integer, ADD CONSTRAINT diagram_cross_schema ' +
      'FOREIGN KEY (archive_only, tenant) REFERENCES report.meta_parent (parent_id, tenant) ON UPDATE CASCADE;',
    'ALTER TABLE restricted.hidden_object ADD COLUMN hidden_fk integer REFERENCES report.row_guard(id);',
    'CREATE TABLE report."diagram.Case" ("Key" integer PRIMARY KEY, "key" integer REFERENCES report."diagram.Case" ("Key"));',
    'GRANT SELECT ON report."diagram.Case" TO fixture_reader;',
    'CREATE TABLE report.meta_child (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id integer, tenant integer, ' +
      "status text COLLATE \"C\" DEFAULT '대기', normalized text GENERATED ALWAYS AS (lower(status)) STORED, " +
      'CONSTRAINT meta_fk FOREIGN KEY (parent_id, tenant) REFERENCES report.meta_parent (parent_id, tenant) DEFERRABLE INITIALLY DEFERRED);',
    'ALTER TABLE report.meta_child ADD CONSTRAINT tenant_positive CHECK (tenant > 0) NOT VALID;',
    "COMMENT ON TABLE report.meta_child IS '구조 검증 테이블';",
    "COMMENT ON COLUMN report.meta_child.normalized IS '검색용 열 주석';",
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
    "CREATE VIEW report.meta_large AS SELECT '" + '한'.repeat(16_420) + "definition_tail_marker'::text AS payload;",
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
    '-c', `ssl_cert_file=${path.join(directory, 'server.pem')}`, '-c', `ssl_key_file=${path.join(directory, 'server.key')}`,
    ...(preloadStats ? ['-c', 'shared_preload_libraries=pg_stat_statements'] : [])],
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

async function verify(browser, fixture, gateway, jump) {
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'PostgreSQL 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await page.keyboard.press('Control+Shift+P');
  const palette = page.getByRole('dialog', { name: '명령 팔레트', exact: true });
  await palette.getByLabel('명령 검색').fill('빠른 연결');
  await palette.getByRole('option', { name: /빠른 연결/ }).click();
  const quickConnect = page.getByRole('dialog', { name: '빠른 연결', exact: true });
  const postgresAddress = `postgresql://fixture_reader@localhost:${fixture.port}/postgres`;
  await quickConnect.getByLabel('연결 주소').fill(postgresAddress);
  await quickConnect.getByRole('button', { name: 'PostgreSQL 연결 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'PostgreSQL 연결 추가' });
  await form.getByLabel('연결 이름').fill('PG 검증');
  assert.equal(await form.getByLabel('호스트 이름 또는 IP').inputValue(), 'localhost');
  assert.equal(await form.getByLabel('포트').inputValue(), String(fixture.port));
  assert.equal(await form.getByLabel('데이터베이스 이름').inputValue(), 'postgres');
  assert.equal(await form.getByLabel('사용자 이름').inputValue(), 'fixture_reader');
  await form.getByLabel('환경').selectOption('PROD');
  await form.getByLabel('CA 인증서 경로 (선택)').fill(fixture.ca);
  await form.getByRole('button', { name: '저장', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  const [profile] = await command('list_postgres_profiles', { projectId: project.id });
  assert.ok(!JSON.stringify(profile).includes(password));
  const visibleTarget = { kind: 'postgres_object', profile_id: profile.id, schema_name: 'report', object_name: 'visible' };
  const pinObject = (target, sessionId) => command('set_workspace_favorite', {
    projectId: project.id, scope: 'project', target, present: true, sessionId,
  });
  await assert.rejects(pinObject(visibleTarget, null), /연결한 뒤/);
  await page.getByRole('button', { name: '빠른 연결', exact: true }).click();
  await quickConnect.getByLabel('연결 주소').fill(postgresAddress);
  await quickConnect.getByRole('button', { name: 'PG 검증 PROD', exact: true }).click();
  await quickConnect.waitFor({ state: 'detached' });
  const explorer = page.getByRole('complementary', { name: '작업 공간 탐색기' });
  const explorerSearch = explorer.getByRole('searchbox', { name: '탐색기 검색' });
  await explorerSearch.fill(`postgres localhost ${fixture.port} prod`);
  await explorer.getByRole('status').getByText('연결 1개 · 객체 0개', { exact: true }).waitFor();
  await explorer.getByRole('button', { name: 'PostgreSQL PG 검증 열기', exact: true }).click();
  await explorerSearch.fill('fixture_reader');
  await explorer.getByRole('status').getByText('일치하는 연결이나 객체가 없습니다.').waitFor();
  await explorerSearch.press('Escape');
  const scopes = explorer.getByRole('group', { name: '즐겨찾기 범위', exact: true });
  await scopes.getByRole('button', { name: '프로젝트', exact: true }).click();
  await explorer.getByRole('button', { name: 'PG 검증 프로젝트 즐겨찾기', exact: true }).click();
  await explorer.getByRole('button', { name: '프로젝트 즐겨찾기 PG 검증 열기', exact: true }).click();
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
  const resolve = (schema, name, profileId = profile.id) => command('resolve_postgres_catalog_object', {
    id: session.id, profileId, schema, name,
  });
  assert.equal((await resolve('report', 'visible')).kind, 'view');
  await assert.rejects(resolve('report', 'VISIBLE'), /찾을 수 없거나 조회 권한/);
  await assert.rejects(resolve('report', 'visible', wrongCa.id), /연결을 다시 확인/);
  await assert.rejects(pinObject({ ...visibleTarget, schema_name: 'restricted', object_name: 'hidden_object' }, session.id), /조회 권한/);
  const schemas = await command('postgres_schemas', { id: session.id, page: 0 });
  assert.equal(schemas.schemas.find(schema => schema.name === 'restricted').accessible, false);
  assert.ok(!schemas.schemas.some(schema => schema.name === 'pg_catalog'));
  const report = schemas.schemas.find(schema => schema.name === 'report');
  const archive = schemas.schemas.find(schema => schema.name === 'archive');
  const diagramFor = schema => command('postgres_schema_diagram', { id: session.id, schema });
  await assert.rejects(diagramFor(schemas.schemas.find(schema => schema.name === 'restricted').id), /스키마를 찾을 수/);
  const diagram = await diagramFor(report.id);
  const diagramTable = label => diagram.tables.find(table => table.label === label);
  const keyFields = (source, target) => diagram.foreign_keys
    .filter(key => key.source === diagramTable(source).id && key.target === diagramTable(target).id)
    .map(key => [key.sequence, key.from_column, key.to_column, key.on_update]);
  assert.deepEqual(keyFields('report.meta_child', 'report.meta_parent'), [[0, 'parent_id', 'parent_id', 'NO ACTION'], [1, 'tenant', 'tenant', 'NO ACTION']]);
  assert.deepEqual(keyFields('archive.meta_child', 'report.meta_parent'), [[0, 'archive_only', 'parent_id', 'CASCADE'], [1, 'tenant', 'tenant', 'CASCADE']]);
  assert.deepEqual(keyFields('report."diagram.Case"', 'report."diagram.Case"'), [[0, 'key', 'Key', 'NO ACTION']]);
  assert.deepEqual(diagramTable('report.meta_parent').columns.map(column => [column.name, column.primary_key_position]), [['parent_id', 1], ['tenant', 2]]);
  assert.equal(diagramTable('restricted.hidden_object'), undefined);
  assert.equal(diagramTable('report.row_cascade_child'), undefined);
  assert.equal(diagramTable('report.meta_view'), undefined);
  const searchObjects = (term, options = {}) => command('search_postgres_objects', { id: session.id,
    input: { term, field: 'name', schema: null, kind: null, page: 0, ...options } });
  const hits = async (term, options) => (await searchObjects(term, options)).hits;
  assert.deepEqual((await hits('META_CHILD')).map(hit => hit.schema), ['archive', 'report']);
  assert.deepEqual((await hits('META_CHILD', { schema: report.id })).map(hit => hit.schema), ['report']);
  assert.deepEqual((await hits('%_')).map(hit => hit.name), ['match%_literal']);
  assert.deepEqual((await hits('NORMALIZED', { field: 'column' })).map(hit => [hit.name, hit.section, hit.excerpt]),
    [['meta_child', 'columns', 'normalized']]);
  assert.deepEqual((await hits('구조 검증', { field: 'comment' })).map(hit => [hit.name, hit.section]), [['meta_child', 'overview']]);
  assert.deepEqual((await hits('검색용 열', { field: 'comment' })).map(hit => [hit.name, hit.section]), [['meta_child', 'columns']]);
  for (const [term, name, section] of [
    ['definition_tail_marker', 'meta_large', 'overview'], ['lower(status)', 'meta_child', 'columns'],
    ['tenant > 0', 'meta_child', 'constraints'], ['meta_status_idx', 'meta_child', 'indexes'], ['meta_touch()', 'meta_child', 'triggers'],
  ]) {
    const match = (await hits(term, { field: 'definition' })).find(hit => hit.name === name);
    assert.equal(match?.section, section, term);
    assert.ok(match.excerpt.includes(term), term);
  }
  assert.deepEqual(await hits('catalog hidden marker', { field: 'comment' }), []);
  assert.deepEqual(await hits('hidden_object'), []);
  assert.deepEqual(await hits('denied'), []);
  assert.deepEqual(await hits('pg_class', { schema: null }), []);
  await assert.rejects(searchObjects(''), /검색어/);
  await assert.rejects(searchObjects('x\0y'), /검색어/);
  const archiveViews = await searchObjects('', { schema: archive.id, kind: 'view' });
  assert.equal(archiveViews.hits.length, 40);
  assert.equal(archiveViews.has_next, true);
  assert.equal(archiveViews.hits[0].name, 'object_search_00');
  const lastArchiveViews = await searchObjects('', { schema: archive.id, kind: 'view', page: 1 });
  assert.deepEqual(lastArchiveViews.hits.map(hit => hit.name), ['object_search_40']);
  assert.equal(lastArchiveViews.has_next, false);
  const objects = await command('postgres_objects', { id: session.id, schema: report.id, search: '', page: 0 });
  const denied = objects.objects.find(object => object.name === 'denied');
  assert.equal(denied.readable, false);
  await assert.rejects(command('postgres_page', { id: session.id, object: denied.id, rowPage: 0, columnPage: 0 }), /권한/);
  const findObject = name => objects.objects.find(object => object.name === name).id;
  if (backupTools) await verifyBackups({ command, open, close, alternate, session, findObject, archive });
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
  const grid = (clauses, rowPage = 0, columnPage = 0, object = table.id, layout) => command('postgres_page', {
    id: session.id, object, rowPage, columnPage, layout, query: { conjunction: 'all', filters: [], sort: [], ...clauses },
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
  const columnLayout = { order: ['extra_23', 'precise', 'missing', 'precise'], hidden: ['note'], pinned: ['extra_23', 'note'] };
  const arranged = await grid(gridClauses, 1, 0, table.id, columnLayout);
  assert.equal(arranged.total_columns, 26);
  assert.equal(arranged.visible_columns, 25);
  assert.equal(arranged.pinned_columns, 1);
  assert.equal(arranged.has_next_columns, true);
  assert.deepEqual(arranged.columns.slice(0, 3).map(column => column.name), ['extra_23', 'precise', 'id']);
  assert.deepEqual(arranged.rows[0].slice(0, 3).map(cell => cell.value), ['마지막 열', '9007199254740993.123', '5']);
  assert.equal(arranged.source, secondFiltered.source);
  assert.deepEqual(arranged.parameter_types, secondFiltered.parameter_types);
  assert.ok(arranged.column_names.includes('note'));
  const nextArrangement = await grid(gridClauses, 1, 1, table.id, columnLayout);
  assert.deepEqual(nextArrangement.columns.map(column => column.name), ['extra_23', 'extra_22']);
  assert.equal(nextArrangement.pinned_columns, 1);
  assert.equal(nextArrangement.has_next_columns, false);
  assert.equal(nextArrangement.rows[0][0].value, '마지막 열');
  assert.deepEqual((await grid({}, 0, 0, table.id, { hidden: first.column_names })).columns.map(column => column.name), ['id']);
  await assert.rejects(grid({}, 0, 2, table.id, columnLayout), /열 페이지/);
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
    const latinDelay = await command('execute_postgres_sql', { id: latin.id, request: randomUUID(),
      source: 'SELECT pg_sleep(0.16), 1 AS other_database_stat', scope: { kind: 'document' } });
    assert.equal(latinDelay.status, 'completed');
    const latinMonitor = await command('open_postgres_monitor', { id: latin.id, password, confirmation: 'PROD' });
    try {
      assert.deepEqual(await readStatementStats(command, latinMonitor.id), { status: 'unavailable', reason: 'not_installed' });
      assert.ok((await command('postgres_server_activity', { id: latinMonitor.id,
        input: { filter: 'all', slow_seconds: 5, page: 0 } })).database_backends >= 2);
    } finally { await close(latinMonitor.id); }
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
  const unrelated = await alternate('Unrelated monitor role', { username: 'fixture_unrelated' });
  await verifyCellFiles({ command, open, close, session, unrelated, findObject });
  await verifyCellRepresentations(command, session.id, findObject('typed_cells'));
  await verifyServerMonitor({ command, open, close, unrelated });
  await verifyStatementStats({ command, query, open, close, session, unrelated });
  await verifyGridWrites({ command, open, close, profile, session, findObject });
  await verifyScripts({ command, query, open, close, session });
  await close(session.id);
  await assert.rejects(command('postgres_schemas', { id: session.id, page: 0 }), /연결이 닫혔습니다/);

  const connection = page.getByRole('dialog', { name: 'PostgreSQL 연결', exact: true });
  const postgresConnected = page.getByRole('contentinfo', { name: '작업 공간 상태' })
    .getByRole('button', { name: 'PostgreSQL 연결됨', exact: true });
  async function connect(tunnel, gridEdit = false) {
    await page.getByRole('button', { name: 'PostgreSQL 연결', exact: true }).click();
    if (tunnel) await connection.getByLabel('연결 경로').selectOption(tunnel.id);
    await connection.getByLabel('PostgreSQL 암호').fill(password);
    await connection.getByLabel('운영 환경 확인').fill('PROD');
    if (gridEdit) await connection.getByLabel('이 연결에서 데이터 그리드 편집 허용').check();
    await connection.getByRole('button', { name: '연결', exact: true }).click();
    await connection.waitFor({ state: 'detached' });
    await postgresConnected.waitFor();
  }
  const data = page.getByRole('table', { name: 'PostgreSQL 데이터', exact: true });
  const disconnect = () => page.getByRole('button', { name: 'PostgreSQL 연결 끊기', exact: true }).click();
  const monitorPane = page.getByRole('region', { name: 'PostgreSQL 서버 모니터', exact: true });
  const monitorButton = page.getByRole('button', { name: '서버 모니터', exact: true });
  const monitorLogin = page.getByRole('dialog', { name: 'PostgreSQL 모니터 연결', exact: true });
  async function connectMonitor(tunnelName) {
    await monitorButton.click();
    await monitorPane.getByRole('button', { name: '모니터 연결', exact: true }).click();
    await monitorLogin.getByText(tunnelName ? `읽기 전용 · SSH 터널 ${tunnelName}` : '읽기 전용 · 직접 연결', { exact: true }).waitFor();
    await monitorLogin.getByLabel('PostgreSQL 암호').fill(password);
    await monitorLogin.getByLabel('운영 환경 확인').fill('PROD');
    await monitorLogin.getByRole('button', { name: '연결', exact: true }).click();
    await monitorLogin.waitFor({ state: 'detached' });
    await monitorPane.getByRole('table', { name: 'PostgreSQL 세션 활동', exact: true }).getByText(/fixture_reader/).first().waitFor();
  }
  await connect();
  await page.getByText(/TLS 연결됨 · PostgreSQL/).waitFor();
  await page.getByRole('button', { name: '네트워크', exact: true }).click();
  await explorerSearch.fill('report.visible');
  const serverSearch = explorer.getByRole('button', { name: 'PostgreSQL PG 검증에서 객체 검색', exact: true });
  const serverResults = explorer.getByRole('group', { name: 'PostgreSQL 서버 검색 결과', exact: true });
  assert.equal(await serverResults.count(), 0);
  await serverSearch.click();
  const visibleHit = serverResults.getByRole('button', { name: 'PostgreSQL 객체 report.visible 열기', exact: true });
  await visibleHit.waitFor();
  await serverResults.getByRole('button', { name: '검색 결과 report.visible 프로젝트 즐겨찾기', exact: true }).click();
  const favoriteVisible = explorer.getByRole('button', { name: '프로젝트 즐겨찾기 report.visible 열기', exact: true });
  await favoriteVisible.waitFor();
  await visibleHit.click();
  await data.getByText('4', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'report.visible 프로젝트 즐겨찾기', exact: true }).getAttribute('aria-pressed'), 'true');
  await explorerSearch.press('Escape');
  await disconnect();
  await postgresConnected.waitFor({ state: 'detached' });
  await favoriteVisible.click();
  await connection.waitFor();
  assert.equal(await connection.getByLabel('운영 환경 확인').inputValue(), '');
  await connection.getByLabel('PostgreSQL 암호').fill(password);
  await connection.getByLabel('운영 환경 확인').fill('PROD');
  await connection.getByRole('button', { name: '연결', exact: true }).click();
  await connection.waitFor({ state: 'detached' });
  await data.getByText('4', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'report.visible 프로젝트 즐겨찾기', exact: true }).click();
  await favoriteVisible.waitFor({ state: 'detached' });
  await connectMonitor();
  await monitorPane.getByText('서버 가동 시간', { exact: true }).waitFor();
  await monitorPane.getByLabel('세션 범위').selectOption('blocked');
  await monitorPane.getByText('조건에 맞는 세션이 없습니다.', { exact: true }).waitFor();
  const sampleLabel = await monitorPane.locator('.postgres-monitor-sample').textContent();
  const automatic = monitorPane.getByLabel('5초마다 새로 고침');
  await automatic.check();
  await page.waitForFunction(previous => {
    const sample = document.querySelector('.postgres-monitor-sample');
    return sample?.textContent && sample.textContent !== previous;
  }, sampleLabel, { timeout: 10000 });
  await automatic.uncheck();
  await monitorPane.getByRole('button', { name: '누적 쿼리', exact: true }).click();
  const statementsPane = monitorPane.getByRole('region', { name: 'PostgreSQL 누적 쿼리 통계', exact: true });
  await statementsPane.getByLabel('정렬').selectOption('mean');
  await statementsPane.getByLabel('최대 실행 시간 하한(ms)').fill('120');
  await statementsPane.getByLabel('현재 역할의 쿼리만').check();
  await statementsPane.getByRole('button', { name: '기준 적용', exact: true }).click();
  const statementRow = statementsPane.getByRole('row').filter({ hasText: 'historical_fixture_marker' });
  await statementRow.getByText('SQL 보기', { exact: true }).click();
  await statementRow.getByText(/historical_fixture_marker/).waitFor();
  await monitorPane.getByRole('button', { name: '활동 세션', exact: true }).click();
  await monitorPane.getByRole('button', { name: '누적 쿼리', exact: true }).click();
  assert.equal(await statementsPane.getByLabel('최대 실행 시간 하한(ms)').inputValue(), '120');
  assert.equal(await statementsPane.getByLabel('정렬').inputValue(), 'mean');
  await monitorPane.getByRole('button', { name: '활동 세션', exact: true }).click();
  await monitorPane.getByRole('button', { name: '모니터 연결 끊기', exact: true }).click();
  await monitorPane.getByRole('button', { name: '모니터 연결', exact: true }).waitFor();
  await page.getByRole('button', { name: '객체 탐색', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /restricted/ }).isEnabled(), false);
  await page.getByRole('button', { name: 'report', exact: true }).click();
  await page.getByRole('button', { name: /raw_cells 테이블/ }).click();
  const originalDialog = page.getByRole('dialog', { name: 'PostgreSQL 셀 원본', exact: true });
  const rawButton = data.getByRole('button', { name: '1행 payload 원본 열기', exact: true });
  await rawButton.click();
  const hex = originalDialog.getByLabel('셀 HEX', { exact: true });
  await hex.waitFor();
  assert.match(await hex.textContent(), /00000000  00 7F FF 5C/);
  await originalDialog.getByRole('button', { name: '다음 셀 원본 페이지', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="셀 HEX"]')?.textContent?.startsWith('00001000'));
  const cellOutput = path.join(root, 'postgres-ui-cell.bin');
  await originalDialog.getByLabel('새 파일 경로', { exact: true }).fill(cellOutput);
  await originalDialog.getByRole('button', { name: '전체 값 저장', exact: true }).click();
  await originalDialog.getByText(/전체 값 저장 완료/).waitFor();
  assert.deepEqual(fs.readFileSync(cellOutput), binaryCell);
  await originalDialog.getByRole('button', { name: '닫기', exact: true }).last().click();
  await originalDialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '1행 payload 원본 열기');
  await data.getByRole('button', { name: '1행 note 원본 열기', exact: true }).click();
  await originalDialog.getByLabel('셀 원본 텍스트', { exact: true }).waitFor();
  await originalDialog.getByRole('button', { name: '닫기', exact: true }).last().click();
  await originalDialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /typed_cells 테이블/ }).click();
  const closeCell = async () => {
    await originalDialog.getByRole('button', { name: '닫기', exact: true }).last().click();
    await originalDialog.waitFor({ state: 'detached' });
  };
  const mode = label => originalDialog.getByRole('button', { name: label, exact: true });
  await data.getByRole('button', { name: '1행 document 원본 열기', exact: true }).click();
  await originalDialog.getByRole('button', { name: '다음 셀 원본 페이지', exact: true }).click();
  await mode('JSON 들여쓰기').click();
  const json = originalDialog.getByLabel('JSON 들여쓰기', { exact: true });
  await json.waitFor();
  assert.match(await json.textContent(), /\n\s+"id": 9007199254740993,\n\s+"id": 9007199254740995/);
  await mode('원문').click();
  await originalDialog.getByText(/4,097–6,0/).waitFor();
  await closeCell();
  await data.getByRole('button', { name: '1행 markup 원본 열기', exact: true }).click();
  await mode('XML 구조').click();
  const tree = originalDialog.getByRole('region', { name: 'XML 구조', exact: true });
  await tree.getByText('<report>', { exact: true }).waitFor();
  await tree.getByText('<section>', { exact: true }).click();
  await tree.getByText('한글', { exact: true }).waitFor();
  await closeCell();
  await data.getByRole('button', { name: '2행 markup 원본 열기', exact: true }).click();
  await mode('XML 구조').click();
  await originalDialog.getByText(/DTD 또는 처리 지시문/).waitFor();
  assert.equal(await originalDialog.getByLabel('셀 원본 텍스트', { exact: true }).isVisible(), true);
  await closeCell();
  await data.getByRole('button', { name: '1행 payload 원본 열기', exact: true }).click();
  await mode('PNG 이미지').click();
  const image = originalDialog.getByRole('img', { name: '셀 PNG 미리보기', exact: true });
  await image.waitFor();
  await page.waitForFunction(() => document.querySelector('img[alt="셀 PNG 미리보기"]')?.naturalWidth === 1);
  await mode('HEX').click();
  assert.match(await hex.textContent(), /89 50 4E 47/);
  await closeCell();
  const catalogSearch = page.getByRole('dialog', { name: 'PostgreSQL 객체 검색', exact: true });
  await page.getByRole('button', { name: '객체 검색', exact: true }).click();
  await catalogSearch.getByLabel('검색어').fill('meta_child');
  await catalogSearch.getByRole('button', { name: '검색', exact: true }).click();
  await catalogSearch.getByRole('button', { name: /archive\.meta_child/ }).waitFor();
  await catalogSearch.getByLabel('검색 범위').selectOption('schema');
  await catalogSearch.getByLabel('검색 기준').selectOption('comment');
  await catalogSearch.getByLabel('검색어').fill('검색용 열 주석');
  await catalogSearch.getByRole('button', { name: '검색', exact: true }).click();
  await catalogSearch.getByText('검색용 열 주석', { exact: true }).waitFor();
  assert.equal(await catalogSearch.getByRole('button', { name: /archive\.meta_child/ }).count(), 0);
  await catalogSearch.getByRole('button', { name: /report\.meta_child.*열 열기/ }).click();
  await catalogSearch.waitFor({ state: 'detached' });
  await page.getByRole('table', { name: 'PostgreSQL 열 구조', exact: true }).getByRole('rowheader', { name: /normalized/ }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'PostgreSQL 조회 결과' }).evaluate(element => element === document.activeElement), true);
  await page.getByRole('button', { name: '데이터', exact: true }).click();
  await page.getByText('조회된 행이 없습니다.', { exact: true }).waitFor();
  await page.getByRole('button', { name: '관계도', exact: true }).click();
  const erd = page.getByRole('dialog', { name: 'PostgreSQL 관계도', exact: true });
  const canvas = erd.getByRole('region', { name: '관계도 캔버스' });
  await canvas.getByRole('button', { name: 'report.meta_child', exact: true, pressed: true }).waitFor();
  await canvas.getByRole('button', { name: 'report.meta_parent', exact: true }).click();
  await canvas.getByRole('button', { name: 'archive.meta_child', exact: true }).waitFor();
  const crossSchema = erd.getByText('archive.meta_child → report.meta_parent', { exact: true });
  await crossSchema.click();
  await erd.getByText('archive_only → parent_id', { exact: true }).waitFor();
  await erd.getByLabel('관계도 테이블 검색').fill('archive.meta_child');
  await erd.getByRole('complementary', { name: '관계도 테이블 목록' })
    .getByRole('button', { name: 'archive.meta_child', exact: true }).click();
  await erd.getByRole('button', { name: '테이블 열기', exact: true }).click();
  await erd.waitFor({ state: 'detached' });
  await data.getByRole('columnheader', { name: /archive_only/ }).waitFor();
  await page.getByRole('button', { name: 'report', exact: true }).click();
  await page.getByRole('button', { name: /denied SELECT 권한 없음/ }).waitFor();
  await page.getByRole('button', { name: /quoted table/ }).click();
  await data.getByRole('columnheader', { name: /id.*PK 1/ }).waitFor();
  if (backupTools) {
    await page.getByRole('button', { name: '테이블 백업', exact: true }).click();
    const backup = page.getByRole('dialog', { name: 'PostgreSQL 백업', exact: true });
    await backup.getByText('"report"."quoted table"', { exact: false }).waitFor();
    const destination = path.join(root, '테이블 백업.backup');
    await backup.getByLabel('새 백업 파일 경로').fill(destination);
    await backup.getByLabel('백업 내용').selectOption('data');
    await backup.getByLabel('PostgreSQL 암호').fill(password);
    const create = backup.getByRole('button', { name: '백업 만들기', exact: true });
    assert.equal(await create.isDisabled(), true);
    await backup.getByLabel('운영 확인 문구 PROD').fill('PROD');
    await create.click();
    await backup.waitFor({ state: 'detached' });
    await page.getByText('백업 저장 완료 · 아카이브 검사 통과', { exact: true }).waitFor();
    const list = backupList(destination);
    assert.match(list, /TABLE DATA report quoted table/);
    assert.doesNotMatch(list, / TABLE report quoted table|TABLE DATA report denied/);
  }
  const columnButton = page.getByRole('button', { name: '열 설정', exact: true });
  const columnDialog = page.getByRole('dialog', { name: '열 설정', exact: true });
  const applyColumns = async () => {
    await columnDialog.getByRole('button', { name: '적용', exact: true }).click();
    await columnDialog.waitFor({ state: 'detached' });
  };
  await columnButton.click();
  await columnDialog.getByLabel('note 표시', { exact: true }).uncheck();
  await columnDialog.getByLabel('extra_23 고정', { exact: true }).check();
  await columnDialog.getByLabel('extra_23 폭', { exact: true }).fill('170');
  await columnDialog.getByLabel('precise 표시 형식', { exact: true }).selectOption('number');
  await columnDialog.getByLabel('precise 소수 자릿수', { exact: true }).fill('2');
  await columnDialog.getByLabel('타입별 색상', { exact: true }).check();
  await columnDialog.getByRole('button', { name: 'precise 위로', exact: true }).click();
  await columnDialog.getByRole('button', { name: 'precise 위로', exact: true }).click();
  await columnDialog.getByLabel('프로필 이름').fill('PG 요약');
  await columnDialog.getByRole('button', { name: '프로필 저장', exact: true }).click();
  await applyColumns();
  const lockedHeader = data.getByRole('columnheader', { name: /extra_23/ });
  await lockedHeader.waitFor();
  assert.match(await data.getByRole('columnheader').first().textContent(), /^extra_23/);
  assert.match(await data.getByRole('columnheader').nth(1).textContent(), /^precise/);
  assert.equal(await data.getByRole('columnheader', { name: /^note\b/ }).count(), 0);
  assert.ok(Math.abs((await lockedHeader.boundingBox()).width - 170) < 2);
  const preciseDisplay = data.getByRole('cell', { name: '9,007,199,254,740,993.12', exact: true }).first();
  await preciseDisplay.waitFor();
  assert.equal(await preciseDisplay.getAttribute('title'), '원본 9007199254740993.123');
  assert.equal(await preciseDisplay.getAttribute('data-grid-value-type'), 'number');
  const originalNumbers = path.join(root, 'postgres-formatted-original.csv');
  await page.getByRole('button', { name: '결과 내보내기', exact: true }).click();
  const layoutExport = page.getByRole('dialog', { name: '결과 내보내기', exact: true });
  await layoutExport.getByLabel('새 CSV 파일 경로', { exact: true }).fill(originalNumbers);
  await layoutExport.getByRole('button', { name: 'CSV 저장', exact: true }).click();
  await layoutExport.waitFor({ state: 'detached' });
  assert.match(fs.readFileSync(originalNumbers, 'utf8'), /"id","note","precise".*\r\n1,\\N,9007199254740993\.123,/);
  const gridScroller = page.getByRole('region', { name: 'PostgreSQL 데이터 스크롤', exact: true });
  await gridScroller.evaluate(element => { element.scrollLeft = 400; });
  assert.ok(await gridScroller.evaluate(element => element.scrollLeft > 200));
  assert.ok(Math.abs((await lockedHeader.boundingBox()).x - (await gridScroller.boundingBox()).x) < 4);
  const selectGridRows = page.getByRole('button', { name: '행 선택', exact: true });
  const copyGridRows = page.getByRole('button', { name: '선택한 행 복사', exact: true });
  const captureGridClipboard = () => page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => {
      window.stackPortGridCopied = text;
    } });
  });
  const releaseGridClipboard = () => page.evaluate(() => {
    delete navigator.clipboard.writeText;
    delete window.stackPortGridCopied;
  });
  await captureGridClipboard();
  await selectGridRows.click();
  await data.getByLabel('2행 선택', { exact: true }).check();
  await data.getByLabel('1행 선택', { exact: true }).check();
  await copyGridRows.click();
  await page.getByRole('status').getByText('행 2개 복사 완료', { exact: true }).waitFor();
  const [copyHeader, firstCopyRow, secondCopyRow] = (await page.evaluate(() => window.stackPortGridCopied)).split('\n');
  assert.deepEqual(copyHeader.split('\t').slice(0, 3), ['extra_23', 'precise', 'id']);
  assert.ok(!copyHeader.split('\t').includes('note'));
  assert.deepEqual(firstCopyRow.split('\t').slice(0, 3), ['마지막 열', '9007199254740993.123', '1']);
  assert.deepEqual(secondCopyRow.split('\t').slice(0, 3), ['마지막 열', '9007199254740993.123', '2']);
  await page.getByRole('button', { name: '다음 열 페이지', exact: true }).click();
  await data.getByRole('columnheader', { name: /extra_22/ }).waitFor();
  assert.equal(await copyGridRows.isDisabled(), true);
  await selectGridRows.click();
  await releaseGridClipboard();
  assert.equal(await data.getByRole('columnheader').count(), 2);
  assert.match(await data.getByRole('columnheader').first().textContent(), /^extra_23/);
  await data.getByText('마지막 열', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '다시 조회', exact: true }).click();
  await data.getByRole('columnheader', { name: /extra_22/ }).waitFor();
  assert.equal(await data.getByRole('columnheader').count(), 2);
  await columnButton.click();
  await columnDialog.getByLabel('보기 프로필').selectOption('PG 요약');
  assert.equal(await columnDialog.getByLabel('extra_23 폭', { exact: true }).inputValue(), '170');
  assert.equal(await columnDialog.getByLabel('precise 소수 자릿수', { exact: true }).inputValue(), '2');
  assert.equal(await columnDialog.getByLabel('타입별 색상', { exact: true }).isChecked(), true);
  await columnDialog.getByRole('button', { name: '기본 배치', exact: true }).click();
  await applyColumns();
  await data.getByRole('columnheader', { name: /^note\b/ }).waitFor();
  assert.equal(await data.getByRole('row').count(), 101);
  await data.getByText('9007199254740993.123', { exact: true }).first().waitFor();
  assert.equal(await data.locator('td[data-grid-value-type]').count(), 0);
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
  await columnButton.click();
  await columnDialog.getByLabel('타입별 색상', { exact: true }).check();
  await columnDialog.getByLabel('due date 표시 형식', { exact: true }).selectOption('date');
  await columnDialog.getByLabel('due date 날짜 형식', { exact: true }).selectOption('year_first');
  await applyColumns();
  const formattedDate = data.getByRole('cell', { name: '2026/01/02', exact: true });
  await formattedDate.waitFor();
  assert.equal(await formattedDate.getAttribute('data-grid-value-type'), 'date');
  assert.equal(await formattedDate.getAttribute('title'), '원본 2026-01-02');
  await columnButton.click();
  await columnDialog.getByRole('button', { name: '기본 배치', exact: true }).click();
  await applyColumns();
  await data.getByText('2026-01-02', { exact: true }).waitFor();
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
  await page.getByRole('button', { name: 'SQL 스크립트', exact: true }).click();
  const autocommit = page.getByRole('checkbox', { name: '자동 커밋', exact: true });
  assert.equal(await autocommit.isChecked(), true);
  await autocommit.uncheck();
  await sql.fill("SELECT '첫 결과' AS marker;\nSELECT $2::text AS marker;");
  await page.getByRole('button', { name: '실행 및 저장', exact: true }).click();
  const scriptConfirmation = page.getByRole('dialog', { name: '스크립트 실행 및 저장', exact: true });
  const confirmScript = scriptConfirmation.getByRole('button', { name: '실행 및 JSON 저장', exact: true });
  const scriptFile = path.join(root, 'postgres-script-editor.json');
  assert.equal(await confirmScript.isEnabled(), false);
  await scriptConfirmation.getByLabel('새 JSON 파일 경로', { exact: true }).fill(scriptFile);
  assert.equal(await confirmScript.isEnabled(), false);
  await scriptConfirmation.getByLabel('운영 확인', { exact: true }).fill('PROD');
  await confirmScript.click();
  const scriptParameters = page.getByRole('dialog', { name: 'PostgreSQL 매개변수', exact: true });
  await scriptParameters.getByLabel('$2 값 숨기기', { exact: true }).check();
  const scriptValue = scriptParameters.getByLabel('$2 값', { exact: true });
  assert.equal(await scriptValue.getAttribute('type'), 'password');
  await scriptValue.fill('둘째 결과');
  await scriptParameters.getByRole('button', { name: '매개변수로 실행', exact: true }).click();
  const scriptResults = page.getByRole('region', { name: 'PostgreSQL 스크립트 결과', exact: true });
  await scriptResults.getByRole('cell', { name: '첫 결과', exact: true }).waitFor();
  await scriptResults.getByRole('status').filter({ hasText: /JSON 저장 완료 · 2행/ }).waitFor();
  assert.deepEqual(JSON.parse(fs.readFileSync(scriptFile, 'utf8')).statements.map(item => item.rows), [[['첫 결과']], [['둘째 결과']]]);
  await scriptResults.getByRole('combobox', { name: '문장 결과', exact: true }).selectOption('1');
  await scriptResults.getByRole('cell', { name: '둘째 결과', exact: true }).waitFor();
  await page.getByRole('button', { name: '읽기 전용 조회', exact: true }).click();
  await page.getByRole('button', { name: '조회 결과', exact: true }).click();
  await results.getByText('4', { exact: true }).waitFor();
  await sql.fill('SELECT *\nFROM "report"."visible";');
  await page.getByRole('button', { name: '새 SQL 탭', exact: true }).click();
  const multiline = 'SELECT 123;\nSELECT id FROM report."quoted table" ORDER BY id;';
  await sql.fill(multiline);
  await sql.evaluate((input, selection) => input.setSelectionRange(selection, input.value.length), multiline.indexOf('SELECT id'));
  await sql.press('Control+Enter');
  await results.getByText('25', { exact: true }).waitFor();
  await captureGridClipboard();
  await selectGridRows.click();
  await results.getByLabel('25행 선택', { exact: true }).check();
  await copyGridRows.click();
  await page.getByRole('status').getByText('행 1개 복사 완료', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.stackPortGridCopied), 'id\n25');
  await releaseGridClipboard();
  await page.getByRole('button', { name: '다음 SQL 결과 페이지' }).click();
  await results.getByText('26', { exact: true }).waitFor();
  assert.equal(await copyGridRows.isDisabled(), true);
  await selectGridRows.click();
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
  await page.getByRole('button', { name: 'row actions 테이블', exact: true }).click();
  await page.getByRole('button', { name: '행 추가', exact: true }).click();
  const rowInsert = page.getByRole('dialog', { name: 'PostgreSQL 행 추가', exact: true });
  await rowInsert.getByLabel('row label 값', { exact: true }).fill('화면 추가 행');
  await rowInsert.getByLabel('empty_text 값 형식', { exact: true }).selectOption('text');
  await rowInsert.getByLabel('optional 값 형식', { exact: true }).selectOption('null');
  await rowInsert.getByLabel('amount 값 형식', { exact: true }).selectOption('text');
  await rowInsert.getByLabel('amount 값', { exact: true }).fill('0');
  await page.keyboard.press('Escape');
  await rowInsert.getByRole('button', { name: '계속 편집', exact: true }).click();
  assert.equal(await rowInsert.getByLabel('row label 값', { exact: true }).inputValue(), '화면 추가 행');
  await rowInsert.getByRole('button', { name: '행 추가 미리보기', exact: true }).click();
  const previewRow = rowInsert.getByRole('region', { name: '추가할 행', exact: true });
  await previewRow.getByText('빈 문자열', { exact: true }).waitFor();
  await previewRow.getByText('NULL', { exact: true }).waitFor();
  await previewRow.getByText('0.00', { exact: true }).waitFor();
  await previewRow.getByText('자동 생성', { exact: true }).waitFor();
  await previewRow.getByText(/DB 기본값.*2026-01-02/).waitFor();
  await rowInsert.getByLabel('운영 환경 확인 · PROD 입력', { exact: true }).fill('PROD');
  await rowInsert.getByRole('button', { name: '행 추가 적용', exact: true }).click();
  await rowInsert.waitFor({ state: 'detached' });
  await page.getByText('행 1개 추가 완료', { exact: true }).waitFor();
  await data.getByText('화면 추가 행', { exact: true }).waitFor();
  await page.getByText('저장된 행 보기', { exact: true }).click();
  await page.locator('.row-change-report').getByText('2026-01-02', { exact: true }).waitFor();
  const rowDelete = page.getByRole('dialog', { name: 'PostgreSQL 행 삭제', exact: true });
  const deleteRow = data.getByRole('button', { name: '1행 삭제', exact: true });
  await deleteRow.click();
  await rowDelete.getByText('화면 추가 행', { exact: true }).waitFor();
  await rowDelete.getByRole('button', { name: '취소', exact: true }).click();
  await rowDelete.waitFor({ state: 'detached' });
  await data.getByText('화면 추가 행', { exact: true }).waitFor();
  await deleteRow.click();
  await rowDelete.getByLabel('운영 환경 확인 · PROD 입력', { exact: true }).fill('PROD');
  await rowDelete.getByRole('button', { name: '행 삭제 적용', exact: true }).click();
  await rowDelete.waitFor({ state: 'detached' });
  await page.getByText('행 1개 삭제 완료', { exact: true }).waitFor();
  await data.getByText('화면 추가 행', { exact: true }).waitFor({ state: 'detached' });

  const pasteRows = page.getByRole('button', { name: '행 붙여넣기', exact: true });
  const pasteDialog = page.getByRole('dialog', { name: 'PostgreSQL 행 붙여넣기', exact: true });
  const pasteText = pasteDialog.getByLabel('붙여넣을 범위', { exact: true });
  const mapPaste = pasteDialog.getByRole('button', { name: '열 매핑', exact: true });
  const previewPaste = pasteDialog.getByRole('button', { name: '붙여넣기 미리보기', exact: true });
  const applyPaste = pasteDialog.getByRole('button', { name: '붙여넣기 적용', exact: true });
  await pasteRows.click();
  await pasteText.fill('이름\tempty_text\toptional\tamount\n"테스트\t붙여넣기"\t\t\t9007199254740993.125\n다음 붙여넣기\t\t\t\n');
  await pasteDialog.getByLabel('첫 행에 열 이름이 있음').check();
  await mapPaste.click();
  await pasteDialog.getByLabel('원본 열 1 대상', { exact: true }).selectOption('column:row label');
  await pasteDialog.getByLabel('원본 열 3 빈 셀', { exact: true }).selectOption('null');
  await previewPaste.click();
  const pasteTable = pasteDialog.getByRole('table', { name: '붙여넣기 미리보기', exact: true });
  await pasteTable.getByText('9007199254740993.13', { exact: true }).waitFor();
  await pasteTable.getByText('(빈 문자열)', { exact: true }).first().waitFor();
  await pasteTable.getByText('NULL', { exact: true }).first().waitFor();
  await pasteTable.getByText('DB 기본값', { exact: true }).waitFor();
  await applyPaste.click();
  await pasteDialog.getByRole('alert').getByText(/PROD를 입력/).waitFor();
  await pasteDialog.getByLabel('운영 환경 확인 · PROD 입력').fill('PROD');
  await applyPaste.click();
  await pasteDialog.waitFor({ state: 'detached' });
  await page.getByText('행 2개 붙여넣기 완료', { exact: true }).waitFor();
  await data.getByText('9007199254740993.13', { exact: true }).waitFor();
  await data.getByRole('row').filter({ hasText: '다음 붙여넣기' }).getByText('7.00', { exact: true }).waitFor();
  await pasteRows.click();
  await pasteText.fill('남으면 안 되는 행\n다음 붙여넣기');
  await mapPaste.click();
  await previewPaste.click();
  await pasteTable.getByText('남으면 안 되는 행', { exact: true }).waitFor();
  await pasteDialog.getByLabel('운영 환경 확인 · PROD 입력').fill('PROD');
  await applyPaste.click();
  await pasteDialog.getByRole('alert').getByText(/전체를 롤백.*23505/).waitFor();
  await pasteDialog.getByRole('button', { name: '닫기', exact: true }).last().click();
  await pasteDialog.getByRole('button', { name: '변경 버리기', exact: true }).click();
  await pasteDialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '다시 조회', exact: true }).click();
  await data.getByText('다음 붙여넣기', { exact: true }).waitFor();
  assert.equal(await data.getByText('남으면 안 되는 행', { exact: true }).count(), 0);

  const fileImport = page.getByRole('button', { name: '파일 가져오기', exact: true });
  const importDialog = page.getByRole('dialog', { name: 'PostgreSQL 파일 가져오기', exact: true });
  const importPicker = importDialog.getByLabel('가져올 파일');
  const mapFile = importDialog.getByRole('button', { name: '열 매핑', exact: true });
  const previewFile = importDialog.getByRole('button', { name: '가져오기 미리보기', exact: true });
  const applyFile = importDialog.getByRole('button', { name: '가져오기 적용', exact: true });
  const confirmFile = importDialog.getByLabel('운영 환경 확인 · PROD 입력');
  const inputFile = path.join(root, 'postgres-import-949.tsv');
  const remainingRows = Array.from({ length: 104 }, (_, index) => 'file-entry-' + (index + 2) + '\t\t\t');
  fs.writeFileSync(inputFile, Buffer.concat([
    Buffer.from('row label\tempty_text\toptional\tamount\r\n', 'ascii'),
    Buffer.from([0xb0, 0xa1]),
    Buffer.from('\t""\t\\N\t9007199254740993.125\r\n' + remainingRows.join('\r\n'), 'ascii'),
  ]));
  await fileImport.click();
  await importPicker.setInputFiles(inputFile);
  await importDialog.getByLabel('StackPort의 NULL과 빈 문자열 복원').check();
  await mapFile.click();
  await importDialog.getByRole('alert').getByText(/UTF-8로 읽을 수 없습니다/).waitFor();
  await importDialog.getByLabel('파일 인코딩').selectOption('euc-kr');
  await mapFile.click();
  await importDialog.getByText('postgres-import-949.tsv · 한국어 Windows-949 (EUC-KR) · 탭', { exact: true }).waitFor();
  await previewFile.click();
  const importPreview = importDialog.getByRole('table', { name: '가져오기 미리보기', exact: true });
  await importPreview.getByText('9007199254740993.13', { exact: true }).waitFor();
  assert.equal(await importPreview.getByRole('row').count(), 26);
  await importDialog.getByText(/105개 행을 새로 추가/).waitFor();
  await applyFile.click();
  await importDialog.getByRole('alert').getByText(/PROD/).waitFor();
  await confirmFile.fill('PROD');
  await applyFile.click();
  await importDialog.waitFor({ state: 'detached' });
  await page.getByRole('status').getByText('행 105개 가져오기 완료', { exact: true }).waitFor();
  await data.getByText('가', { exact: true }).waitFor();

  await fileImport.click();
  await importPicker.setInputFiles({
    name: 'reject-last.csv', mimeType: 'text/csv',
    buffer: Buffer.from('row label\n' + Array.from({ length: 104 }, (_, index) => 'reject-entry-' + index).join('\n') + '\ndeny'),
  });
  await mapFile.click();
  await previewFile.click();
  await importDialog.getByText(/105개 행을 새로 추가/).waitFor();
  await confirmFile.fill('PROD');
  await applyFile.click();
  await importDialog.getByRole('alert').getByText(/가져오기 전체를 롤백/).waitFor();
  await importDialog.getByRole('button', { name: '닫기', exact: true }).last().click();
  await importDialog.getByRole('button', { name: '변경 버리기', exact: true }).click();
  await importDialog.waitFor({ state: 'detached' });
  const importReader = await open();
  try {
    const imported = await command('execute_postgres_sql', {
      id: importReader.id, request: randomUUID(), scope: { kind: 'document' },
      source: "SELECT count(*) FILTER (WHERE \"row label\" LIKE 'file-entry-%' OR \"row label\" = '가'), " +
        "count(*) FILTER (WHERE \"row label\" LIKE 'reject-entry-%'), " +
        "count(*) FILTER (WHERE \"row label\" = '가' AND empty_text = '' AND optional IS NULL AND amount = 9007199254740993.13) " +
        'FROM report."row actions"',
    });
    assert.deepEqual(imported.rows[0].map(cell => cell.value), ['105', '0', '1']);
  } finally {
    await close(importReader.id);
  }
  const importHistory = (await command('list_audit_events', { before: null })).events.filter(event => event.operation === 'postgres.row.import');
  assert.ok(importHistory.some(event => event.outcome === 'succeeded' && event.affected_count === 105));
  assert.ok(importHistory.some(event => event.outcome === 'failed'));
  assert.doesNotMatch(JSON.stringify(importHistory), /postgres-import-949|file-entry|reject-entry/);

  await page.getByRole('button', { name: 'json_source 테이블', exact: true }).click();
  await data.getByText('0.500000000', { exact: true }).waitFor();
  const objectJson = path.join(root, 'postgres-object-array.json');
  fs.writeFileSync(objectJson, [
    '[{"amount":9007199254740993.123456789,"payload":{"n":9223372036854775808},"flag":true,"note":""},',
    '{"amount":2.250000001,"payload":[1e77,"text"],"flag":false},',
    '{"amount":3,"note":null,"flag":true}]',
  ].join('\n'), 'utf8');
  await fileImport.click();
  await importPicker.setInputFiles(objectJson);
  await mapFile.click();
  await importDialog.getByText('postgres-object-array.json · UTF-8 · JSON 객체 배열', { exact: true }).waitFor();
  await previewFile.click();
  await importPreview.getByText('9007199254740993.123456789', { exact: true }).waitFor();
  await importPreview.getByText('{"n":9223372036854775808}', { exact: true }).waitFor();
  await importPreview.getByText('(빈 문자열)', { exact: true }).waitFor();
  await confirmFile.fill('PROD');
  await applyFile.click();
  await importDialog.waitFor({ state: 'detached' });
  await data.getByText('9007199254740993.123456789', { exact: true }).waitFor();
  const postgresRoundTrip = path.join(root, 'postgres-roundtrip.json');
  await page.getByRole('button', { name: '결과 내보내기', exact: true }).click();
  await exportDialog.getByLabel('파일 형식').selectOption('JSON');
  await exportDialog.getByLabel('새 JSON 파일 경로', { exact: true }).fill(postgresRoundTrip);
  await exportDialog.getByRole('button', { name: 'JSON 저장', exact: true }).click();
  await page.getByText('JSON 저장 완료 · 4행', { exact: true }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(postgresRoundTrip, 'utf8')).format, 'stackport.postgres-results');
  await page.getByRole('button', { name: 'json_replay 테이블', exact: true }).click();
  await fileImport.click();
  await importPicker.setInputFiles(postgresRoundTrip);
  await mapFile.click();
  await importDialog.getByText('postgres-roundtrip.json · UTF-8 · StackPort PostgreSQL JSON', { exact: true }).waitFor();
  await previewFile.click();
  await importPreview.getByText('\\x00ff5c', { exact: true }).waitFor();
  await confirmFile.fill('PROD');
  await applyFile.click();
  await importDialog.waitFor({ state: 'detached' });
  await page.getByRole('status').getByText('행 4개 가져오기 완료', { exact: true }).waitFor();
  await fileImport.click();
  await importPicker.setInputFiles({
    name: 'from-sqlite.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      format: 'stackport.sqlite-results', version: 1, columns: ['amount', 'payload', 'binary_data', 'note'],
      rows: [[{ integer: '9223372036854775807' }, '{"engine":"sqlite"}', { blob_hex: 'AABB' }, '']],
    })),
  });
  await mapFile.click();
  await importDialog.getByText('from-sqlite.json · UTF-8 · StackPort SQLite JSON', { exact: true }).waitFor();
  await previewFile.click();
  await importPreview.getByText('9223372036854775807.000000000', { exact: true }).waitFor();
  await confirmFile.fill('PROD');
  await applyFile.click();
  await importDialog.waitFor({ state: 'detached' });
  await page.getByRole('status').getByText('행 1개 가져오기 완료', { exact: true }).waitFor();
  const jsonReader = await open();
  try {
    const replay = await command('execute_postgres_sql', {
      id: jsonReader.id, request: randomUUID(), scope: { kind: 'document' },
      source: "SELECT amount::text, payload::text, flag::text, note, pg_catalog.encode(binary_data, 'hex') FROM report.json_replay ORDER BY id",
    });
    assert.deepEqual(replay.rows.map(row => row.map(cell => cell.value)), [
      ['0.500000000', '{"seed":true}', 'false', null, '00ff5c'],
      ['9007199254740993.123456789', '{"n":9223372036854775808}', 'true', '', null],
      ['2.250000001', '[1e77,"text"]', 'false', 'DB 기본값', null],
      ['3.000000000', null, 'true', null, null],
      ['9223372036854775807.000000000', '{"engine":"sqlite"}', null, '', 'aabb'],
    ]);
  } finally {
    await close(jsonReader.id);
  }

  await page.getByRole('button', { name: 'xml_import 테이블', exact: true }).click();
  await fileImport.click();
  await importPicker.setInputFiles({
    name: 'postgres-import.xml', mimeType: 'application/xml',
    buffer: Buffer.from('<feed xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:m="urn:meta">' +
      '<entries><entry code="PG XML 1"><amount>9007199254740993.123456789</amount><note xsi:nil="true"/>' +
      '<markup><m:value>한글 &amp; XML</m:value></markup></entry>' +
      '<entry code="PG XML 2"><amount>0</amount><note/></entry>' +
      '<entry code="PG XML 3"><amount>-0.01</amount></entry></entries><other><entry code="ignored"/></other></feed>'),
  });
  await importDialog.getByRole('button', { name: '레코드 경로 읽기', exact: true }).click();
  const xmlPath = importDialog.getByLabel('XML 레코드 경로');
  await xmlPath.selectOption({ label: '/feed/entries/entry · 3행' });
  await mapFile.click();
  await importDialog.getByText('postgres-import.xml · UTF-8 · XML · /feed/entries/entry', { exact: true }).waitFor();
  await previewFile.click();
  await importPreview.getByText('9007199254740993.123456789', { exact: true }).waitFor();
  await importPreview.getByText('NULL', { exact: true }).first().waitFor();
  await importPreview.getByText('(빈 문자열)', { exact: true }).waitFor();
  assert.equal(await applyFile.isEnabled(), true);
  await confirmFile.fill('PROD');
  await applyFile.click();
  await importDialog.waitFor({ state: 'detached' });
  await page.getByRole('status').getByText('행 3개 가져오기 완료', { exact: true }).waitFor();
  const xmlReader = await open();
  try {
    const result = await command('execute_postgres_sql', {
      id: xmlReader.id, request: randomUUID(), scope: { kind: 'document' },
      source: "SELECT code, amount::text, note, (xpath('string(/markup/m:value) = \"한글 & XML\"', markup, ARRAY[ARRAY['m','urn:meta']]))[1]::text FROM report.xml_import ORDER BY id",
    });
    assert.deepEqual(result.rows.map(row => row.map(cell => cell.value)), [
      ['PG XML 1', '9007199254740993.123456789', null, 'true'],
      ['PG XML 2', '0.000000000', '', null],
      ['PG XML 3', '-0.010000000', 'DB 기본값', null],
    ]);
  } finally {
    await close(xmlReader.id);
  }

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
  await page.getByRole('button', { name: 'grid_updates 테이블', exact: true }).click();
  await data.getByText('짧은 값', { exact: true }).waitFor();
  const editSelected = page.getByRole('button', { name: '선택한 행 편집', exact: true });
  await selectGridRows.click();
  assert.equal(await editSelected.isDisabled(), true);
  await data.getByLabel('이 페이지의 행 모두 선택', { exact: true }).check();
  await editSelected.click();
  const gridEditor = page.getByRole('dialog', { name: 'PostgreSQL 여러 행 편집', exact: true });
  const gridColumn = gridEditor.getByLabel('변경할 열');
  const gridRow = gridEditor.getByLabel('편집할 행');
  const gridInput = gridEditor.getByLabel('변경할 값');
  await gridColumn.selectOption('large_note');
  await gridEditor.getByText(/4,096자를 초과합니다/).waitFor();
  await gridRow.selectOption('1');
  assert.equal(await gridInput.inputValue(), '짧은 값');
  await gridRow.selectOption('0');
  await gridColumn.selectOption('note');
  await gridInput.fill('화면 일괄 저장');
  await gridEditor.getByRole('button', { name: '선택한 모든 행의 이 열에 입력', exact: true }).click();
  await gridRow.selectOption('1');
  assert.equal(await gridInput.inputValue(), '화면 일괄 저장');
  await gridColumn.selectOption('amount');
  await gridInput.fill('9007199254740993.1237');
  await page.keyboard.press('Escape');
  await gridEditor.getByText('적용하지 않은 변경이 있습니다.', { exact: true }).waitFor();
  await gridEditor.getByRole('button', { name: '계속 편집', exact: true }).click();
  await gridEditor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await gridEditor.getByText('변경 미리보기 · 2행 / 3셀', { exact: true }).waitFor();
  await gridEditor.getByRole('region', { name: '1행 note 변경 비교', exact: true }).getByText('화면 일괄 저장').waitFor();
  await gridEditor.getByRole('region', { name: '2행 amount 변경 비교', exact: true }).getByText('9007199254740993.124').waitFor();
  await gridEditor.getByLabel('운영 환경 확인').fill('PROD');
  await gridEditor.getByRole('button', { name: '변경 적용', exact: true }).click();
  await gridEditor.waitFor({ state: 'detached' });
  await page.getByText('행 2개 · 3개 셀 변경 완료', { exact: true }).waitFor();
  await data.getByText('9007199254740993.124', { exact: true }).waitFor();
  assert.equal(await data.getByText('화면 일괄 저장', { exact: true }).count(), 2);
  assert.equal(await editSelected.isDisabled(), true);
  await selectGridRows.click();
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
    const activity = page.locator('#workspace-status .workspace-activity');
    await activity.getByText('PostgreSQL 쿼리 실행 중', { exact: true }).waitFor();
    await new Promise(resolve => setTimeout(resolve, 350));
    await cancel.click();
    await page.getByText('PostgreSQL 서버에서 쿼리 중단을 확인했습니다.', { exact: true }).waitFor();
    await activity.getByText(/PostgreSQL 쿼리/).waitFor({ state: 'hidden' });
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

    await connectMonitor('보고서 터널');
    assert.equal(gateway.forwarded(), 3);
    await page.getByRole('button', { name: 'SQL 편집기', exact: true }).click();

    const draft = 'SELECT $1::int + 90';
    await sql.fill(draft);
    await sql.press('Control+Enter');
    await parameters.getByLabel('$1 값', { exact: true }).waitFor();
    await command('stop_ssh_tunnel', { id: tunnel.id });
    const lossMessage = /SSH 터널 ‘보고서 터널’이 중단되어 PostgreSQL 연결/;
    const loss = page.locator('.postgres-recovery').getByRole('alert').filter({ hasText: lossMessage });
    const reconnect = page.getByRole('button', { name: 'PostgreSQL 다시 연결', exact: true });
    await loss.waitFor();
    await postgresConnected.waitFor({ state: 'hidden' });
    assert.equal(await monitorButton.isEnabled(), false);
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
  if (backupTools) await verifyRestoreDialog(page, project.id);
  assert.deepEqual(errors, []);
}

function backupList(destination) {
  return execFileSync(path.join(backupTools, 'pg_restore.exe'), ['--list', destination], {
    windowsHide: true, encoding: 'utf8', timeout: 15_000,
  });
}

async function verifyScripts({ command, query, open, close, session }) {
  const document = { kind: 'document' };
  const execute = (source, {
    autocommit = true, scope = document, confirmation = 'PROD', request = randomUUID(), bindings, exportDestination,
  } = {}) => command('execute_postgres_script', {
    id: session.id, request, input: { source, scope, autocommit, confirmation, bindings, export_destination: exportDestination },
  });
  const probe = id => `INSERT INTO report.write_probe VALUES (${id}) RETURNING id`;
  const ids = async () => (await query('SELECT id FROM report.write_probe ORDER BY id')).rows.map(row => row[0].value);
  await assert.rejects(execute(probe(900), { confirmation: '' }), /PROD/);
  assert.deepEqual(await ids(), []);

  const manual = await execute([
    "SET search_path = report, pg_catalog",
    "CREATE TEMP TABLE stackport_script_temp (id int)",
    "CREATE FUNCTION pg_temp.stackport_script_value() RETURNS int LANGUAGE SQL BEGIN ATOMIC SELECT CASE WHEN true THEN 7 ELSE 0 END; END",
    probe(901), "SAVEPOINT script_middle", probe(902), "ROLLBACK TO SAVEPOINT script_middle",
    "COMMIT", probe(903),
    "DO $script$ BEGIN RAISE NOTICE '스택포트; 알림'; END $script$",
    "SELECT pg_temp.stackport_script_value(), 9007199254740993.123::numeric, NULL::text, ''::text",
  ].join(";\n"), { autocommit: false });
  assert.equal(manual.status, 'succeeded', JSON.stringify(manual));
  assert.equal(manual.transaction, 'cleanup_confirmed');
  assert.equal(manual.connection_closed, false);
  assert.equal(manual.statements.length, 11);
  assert.equal(manual.statements[3].affected_rows, 1);
  assert.deepEqual(manual.statements[9].notices.map(notice => notice.message), ['스택포트; 알림']);
  assert.deepEqual(manual.statements[10].rows[0].map(cell => cell.value), ['7', '9007199254740993.123', null, '']);
  assert.deepEqual(await ids(), ['901']);
  const clean = await execute("SHOW search_path; SHOW default_transaction_read_only; SELECT to_regclass('pg_temp.stackport_script_temp')");
  assert.equal(clean.statements[0].rows[0][0].value, 'pg_catalog');
  assert.equal(clean.statements[1].rows[0][0].value, 'off');
  assert.equal(clean.statements[2].rows[0][0].value, null);
  assert.match((await query("INSERT INTO report.write_probe VALUES (909)")).error, /읽기 전용/);

  const invalid = `${probe(904)};\nSELECT '😀', missing_script_column;\n${probe(905)}`;
  const failed = await execute(invalid);
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  assert.equal(failed.statements.length, 1);
  assert.equal(failed.error.sql_state, '42703');
  assert.equal(failed.error.position, invalid.indexOf('missing_script_column'));
  assert.equal(failed.error.line, 2);
  assert.deepEqual(await ids(), ['901', '904']);

  const scopeSource = "SELECT '😀skip'; SELECT 11; SELECT 22; SELECT 33;";
  const start = scopeSource.indexOf('SELECT 11');
  const end = scopeSource.indexOf('SELECT 33');
  const selection = await execute(scopeSource, { scope: { kind: 'selection', start, end } });
  assert.deepEqual(selection.statements.map(part => part.rows[0][0].value), ['11', '22']);
  const current = await execute(scopeSource, { scope: { kind: 'current', cursor: end + 3 } });
  assert.deepEqual(current.statements.map(part => part.rows[0][0].value), ['33']);
  const limited = await execute("SELECT repeat('한', 513) FROM generate_series(1, 101)");
  assert.equal(limited.statements[0].rows.length, 100);
  assert.equal(limited.statements[0].more_rows, true);
  assert.equal(limited.statements[0].rows[0][0].truncated, true);
  await assert.rejects(execute('SELECT 1;'.repeat(101)), /100/);

  const observer = await open();
  const request = randomUUID();
  try {
    const inFlight = execute(`BEGIN; ${probe(906)}; SELECT pg_sleep(6) AS script_cancel_marker; COMMIT`, { request });
    let sleeping = false;
    for (let attempt = 0; attempt < 25 && !sleeping; attempt++) {
      const observed = await command('execute_postgres_sql', { id: observer.id, request: randomUUID(), scope: document,
        source: "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event='PgSleep' AND query LIKE '%script_cancel_marker%')" });
      sleeping = observed.rows?.[0][0].value === 'true';
      if (!sleeping) await new Promise(resolve => setTimeout(resolve, 45));
    }
    assert.equal(sleeping, true);
    assert.equal(await command('cancel_postgres_sql', { id: session.id, request }), true);
    const stopped = await inFlight;
    assert.equal(stopped.status, 'cancelled', JSON.stringify(stopped));
    assert.equal(stopped.server_confirmed, true);
    assert.equal(stopped.transaction, 'cleanup_confirmed');
  } finally { await close(observer.id); }
  assert.deepEqual(await ids(), ['901', '904']);
  const audit = (await command('list_audit_events', { before: null })).events;
  const cancelled = audit.find(event => event.correlation_id === request);
  assert.equal(cancelled?.operation, 'postgres.sql.script.cancel');
  assert.equal(cancelled.policy, 'postgres-script-prod-confirmed');
  assert.equal(cancelled.object_name, null);
  const timed = await execute(`${probe(907)}; SELECT pg_sleep(12); COMMIT`, { autocommit: false });
  assert.equal(timed.status, 'timed_out', JSON.stringify(timed));
  assert.equal(timed.server_confirmed, true);
  assert.equal(timed.transaction, 'cleanup_confirmed');
  assert.deepEqual(await ids(), ['901', '904']);
  await verifyScriptParameters({ command, execute, ids, probe });
  await verifyScriptExport({ command, execute, ids, probe, id: session.id });
  console.log('PostgreSQL scripts passed (routine bodies, autocommit, savepoints, rollback, Unicode diagnostics and server cancellation).');
}

async function verifyScriptExport({ command, execute, ids, probe, id }) {
  const existing = path.join(root, 'script-existing.json');
  const destination = path.join(root, 'script-results.json');
  const baseline = await ids();
  fs.writeFileSync(existing, 'existing-script-export');
  await assert.rejects(execute(probe(920), { exportDestination: existing }), /같은 이름/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing-script-export');
  assert.deepEqual(await ids(), baseline);

  const source = [
    probe(920),
    "SELECT n AS duplicate, repeat('한', 513) AS duplicate, NULL::text, ''::text FROM generate_series(1, 130) AS n",
    "SELECT $1::numeric AS precise, repeat('9', 600)::numeric AS large, $2::bytea AS bytes",
    "SELECT id FROM report.write_probe WHERE false",
    "UPDATE report.write_probe SET id=920 WHERE id=920",
  ].join(";\n");
  assert.equal((await execute(source, { exportDestination: destination })).status, 'parameters_required');
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(await ids(), baseline);
  const request = randomUUID();
  const precise = '900719925474099312345678901.012300';
  const exported = await execute(source, { exportDestination: destination, request, bindings: [
    { index: 1, value: { kind: 'text', value: precise } },
    { index: 2, value: { kind: 'text', value: '\\x00ab' } },
  ] });
  assert.equal(exported.status, 'succeeded', JSON.stringify(exported).slice(0, 500));
  assert.equal(exported.export_report.rows, 132);
  assert.equal(exported.export_report.size_bytes, fs.statSync(destination).size);
  assert.equal(exported.statements[1].rows.length, 100);
  const result = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(result.format, 'stackport.postgres-script-results');
  assert.equal(result.version, 1);
  assert.deepEqual(result.statements.map(item => item.line), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.statements[1].columns.slice(0, 2), [
    { name: 'duplicate', data_type: 'int4' }, { name: 'duplicate', data_type: 'text' },
  ]);
  assert.equal(result.statements[1].rows.length, 130);
  assert.deepEqual(result.statements[1].rows[129], ['130', '한'.repeat(513), null, '']);
  assert.deepEqual(result.statements[2].rows[0], [precise, '9'.repeat(600), { binary_hex: '00AB' }]);
  assert.deepEqual(result.statements[3].rows, []);
  assert.deepEqual(result.statements[4], { line: 5, columns: [], rows: [], affected_rows: 1 });
  assert.deepEqual(await ids(), [...baseline, '920']);
  const audits = (await command('list_audit_events', { before: null })).events.filter(item => item.correlation_id === request);
  const saved = audits.find(item => item.operation === 'postgres.sql.script.export.json');
  assert.equal(saved?.affected_count, 132);
  assert.equal(saved.policy, 'postgres-script-result-json-no-overwrite');
  assert.ok(audits.some(item => item.operation === 'postgres.sql.script'));
  assert.doesNotMatch(JSON.stringify(audits), /script-results\.json/);

  const failedPath = path.join(root, 'script-export-failed.json');
  const failed = await execute(`${probe(921)}; SELECT missing_script_export; ${probe(922)}`, { exportDestination: failedPath });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.sql_state, '42703');
  assert.equal(fs.existsSync(failedPath), false);
  assert.deepEqual(await ids(), [...baseline, '920', '921']);

  const rowTooLarge = path.join(root, 'script-large-row.json');
  const writeFailed = await execute("SELECT repeat('x', 33554433); INSERT INTO report.write_probe VALUES (922)",
    { exportDestination: rowTooLarge });
  assert.equal(writeFailed.status, 'failed', JSON.stringify(writeFailed).slice(0, 500));
  assert.match(writeFailed.export_error, /32 MiB/);
  assert.equal(writeFailed.transaction, 'cleanup_confirmed');
  assert.equal(fs.existsSync(rowTooLarge), false);
  assert.deepEqual(await ids(), [...baseline, '920', '921']);

  const canceledPath = path.join(root, 'script-export-canceled.json');
  const cancelRequest = randomUUID();
  const running = execute(`BEGIN; ${probe(923)}; SELECT pg_sleep(6); COMMIT`,
    { exportDestination: canceledPath, request: cancelRequest });
  let recorded = 0;
  for (let attempt = 0; attempt < 40 && !recorded; attempt++) {
    recorded = await command('postgres_export_progress', { id, request: cancelRequest });
    if (!recorded) await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(recorded, 1);
  assert.equal(await command('cancel_postgres_sql', { id, request: cancelRequest }), true);
  assert.equal((await running).status, 'cancelled');
  assert.equal(fs.existsSync(canceledPath), false);
  assert.deepEqual(await ids(), [...baseline, '920', '921']);
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.stackport-json-')));
  console.log('PostgreSQL script export passed (full JSON results, progress, no replay, failure cleanup and cancellation).');
}

async function verifyScriptParameters({ command, execute, ids, probe }) {
  const text = (index, value) => ({ index, value: { kind: 'text', value } });
  const source = [
    probe(910),
    "CREATE TEMP TABLE stackport_bound (id int, amount numeric, note text, optional text)",
    "INSERT INTO stackport_bound VALUES ($4, $1, $8, $2) RETURNING id, amount, note, optional",
    "UPDATE report.write_probe SET id = $4 WHERE id = 910 RETURNING id",
    "SELECT $1::numeric, $4::int, $8::text, $2::text, ARRAY[1, 2], $5::timestamptz, $6::bytea, '$33'::text",
    "SELECT $8::text; -- $40 remains a comment",
  ].join(";\n");
  const detail = "-9007199254740993123456789012345678.0012300";
  const note = "O'Reilly; 👋";
  const bindings = [text(1, detail), { index: 2, value: { kind: 'null' } }, text(4, '911'),
    text(5, '2026-01-02 03:04:05+09'), text(6, '\\x00ab'), text(8, note)];
  const request = randomUUID();
  const needed = await execute(source, { request });
  assert.equal(needed.status, 'parameters_required');
  assert.deepEqual(needed.parameter_indexes, [1, 2, 4, 5, 6, 8]);
  assert.equal(needed.transaction, 'not_started');
  assert.deepEqual(await ids(), ['901', '904']);
  await assert.rejects(execute(source, { bindings: bindings.slice(0, -1) }), /번호와 값을 확인/);
  await assert.rejects(execute(source, { bindings: [...bindings.slice(0, -1), text(8, '\0')] }), /16 KiB/);
  assert.deepEqual(await ids(), ['901', '904']);
  assert.ok(!(await command('list_audit_events', { before: null })).events.some(event => event.correlation_id === request));

  const complete = await execute(source, { bindings, autocommit: true });
  assert.equal(complete.status, 'succeeded', JSON.stringify(complete));
  assert.deepEqual(complete.statements[2].rows[0].map(cell => cell.value), ['911', detail, note, null]);
  assert.equal(complete.statements[3].affected_rows, 1);
  const row = complete.statements[4].rows[0];
  assert.deepEqual(row.slice(0, 4).map(cell => cell.value), [detail, '911', note, null]);
  assert.equal(row[4].hex, true);
  assert.equal(row[5].value, '2026-01-01 18:04:05+00');
  assert.deepEqual(row[6], { value: '00ab', truncated: false, hex: true });
  assert.equal(row[7].value, '$33');
  assert.equal(complete.statements[5].rows[0][0].value, note);
  assert.deepEqual(await ids(), ['901', '904', '911']);

  const masked = await execute(`${probe(912)}; SELECT $2::int; ${probe(913)}`, {
    bindings: [text(2, 'private-fixture-bound-value')],
  });
  assert.equal(masked.status, 'failed', JSON.stringify(masked));
  assert.equal(masked.error.sql_state, '22P02');
  assert.equal(masked.error.line, 1);
  assert.doesNotMatch(JSON.stringify(masked), /private-fixture-bound-value/);
  assert.deepEqual(await ids(), ['901', '904', '911', '912']);

  const precision = await execute("SELECT $1::numeric, $1::numeric + 0.0001, 'Infinity'::numeric, 'NaN'::numeric, repeat('9', 600)::numeric",
    { bindings: [text(1, '0.000012300')] });
  const numbers = precision.statements[0].rows[0];
  assert.deepEqual(numbers.slice(0, 4).map(cell => cell.value), ['0.000012300', '0.000112300', 'Infinity', 'NaN']);
  assert.deepEqual(numbers[4], { value: '9'.repeat(512), truncated: true });
  console.log('PostgreSQL script bindings passed (preflight without writes, sparse slots, DML RETURNING, exact numeric and masked errors).');
}

async function verifyBackups({ command, open, close, alternate, session, findObject, archive }) {
  const adminPassword = 'fixture-administrator-password';
  const admin = await alternate('백업·복구 검증', { username: 'fixture_admin', environment: 'DEV' });
  const adminSession = await open(admin, adminPassword);
  const create = (id, options) => command('create_postgres_backup', {
    id, request: randomUUID(), target: { kind: 'database' }, contents: 'all',
    password: adminPassword, confirmation: '', ...options,
  });
  const destination = path.join(root, 'database-full.backup');
  const rejected = path.join(root, 'rejected.backup');
  try {
    await assert.rejects(create(session.id, { destination: rejected }), /PROD/);
    await assert.rejects(create(adminSession.id, { destination: rejected, password: 'wrong-backup-password' }), /pg_dump/);
    assert.equal(fs.existsSync(rejected), false);
    assert.equal(fs.readdirSync(root).some(name => name.startsWith('.stackport-postgres-')), false);
    const schema = path.join(root, 'archive-schema.backup');
    await create(adminSession.id, { destination: schema, target: { kind: 'schema', schema: archive.id }, contents: 'schema' });
    const schemaList = backupList(schema);
    assert.match(schemaList, / TABLE archive meta_child/);
    assert.doesNotMatch(schemaList, /TABLE DATA| TABLE report meta_parent/);
    const report = await create(adminSession.id, { destination });
    const bytes = fs.readFileSync(destination);
    assert.equal(bytes.subarray(0, 5).toString(), 'PGDMP');
    assert.equal(report.size_bytes, bytes.length);
    assert.equal(report.sha256, createHash('sha256').update(bytes).digest('hex'));
    await assert.rejects(create(adminSession.id, { destination }), /같은 이름/);
    assert.deepEqual(fs.readFileSync(destination), bytes);
    const events = (await command('list_audit_events', { before: null })).events.filter(event => event.operation === 'postgres.backup');
    assert.ok(events.some(event => event.outcome === 'succeeded'));
    assert.ok(events.some(event => event.outcome === 'failed'));
    assert.doesNotMatch(JSON.stringify(events), /wrong-backup-password|database-full\.backup/);

    const preview = (id, source, database) => command('preview_postgres_restore', { id, request: randomUUID(), source, database });
    const apply = (plan, options = {}) => command('apply_postgres_restore', {
      id: adminSession.id, request: randomUUID(), token: plan.token, databaseConfirmation: plan.database,
      trusted: true, password: adminPassword, confirmation: '', ...options,
    });
    const database = "fixture_restore='checked'";
    await assert.rejects(preview(session.id, destination, database), /CREATEDB/);
    await assert.rejects(preview(adminSession.id, destination, 'fixture_latin'), /이미 같은 이름/);
    const selectedArchive = path.join(root, 'approved-copy.backup');
    fs.copyFileSync(destination, selectedArchive);
    const plan = await preview(adminSession.id, selectedArchive, database);
    assert.equal(plan.archive_database, 'postgres');
    assert.equal(plan.sha256, report.sha256);
    assert.match(plan.toc, /TABLE DATA report quoted table/);
    await assert.rejects(apply(plan, { trusted: false }), /출처/);
    await assert.rejects(apply(plan, { databaseConfirmation: 'different_target' }), /같은 새 DB 이름/);
    fs.writeFileSync(selectedArchive, 'The reviewed archive was replaced on disk.');
    const recovered = await apply(plan);
    assert.equal(recovered.database, database);
    assert.equal(recovered.sha256, report.sha256);
    assert.ok(recovered.tables > 0);
    await assert.rejects(apply(plan), /만료되었거나 사용/);
    await assert.rejects(preview(adminSession.id, destination, database), /이미 같은 이름/);
    const denied = await alternate('격리 복원 접속 권한 검증', { database, environment: 'DEV' });
    await assert.rejects(open(denied), /SQLSTATE 42501/);

    const profile = await alternate('격리 복구본 검증', { username: 'fixture_admin', database, environment: 'DEV' });
    const restored = await open(profile, adminPassword);
    try {
      const object = await command('resolve_postgres_catalog_object', {
        id: restored.id, profileId: profile.id, schema: 'report', name: 'quoted table',
      });
      const rows = (id, oid) => command('postgres_page', { id, object: oid, rowPage: 0, columnPage: 0 });
      const expected = await rows(adminSession.id, findObject('quoted table'));
      const actual = await rows(restored.id, object.id);
      assert.deepEqual(actual.rows.map(row => row.map(cell => cell.value)), expected.rows.map(row => row.map(cell => cell.value)));
      const restoredChild = await command('resolve_postgres_catalog_object', {
        id: restored.id, profileId: profile.id, schema: 'report', name: 'meta_child',
      });
      const { constraints } = await command('postgres_structure', { id: restored.id, object: restoredChild.id, section: 'constraints', page: 0 });
      assert.deepEqual(constraints.find(value => value.name === 'meta_fk').reference.columns, ['parent_id', 'tenant']);
    } finally { await close(restored.id); }

    const incomplete = await preview(adminSession.id, schema, 'fixture_restore_rollback');
    let staging;
    await assert.rejects(apply(incomplete), error => {
      const match = /임시 DB '(stackport_restore_[a-f0-9]+)'.*pg_restore가 복원에 실패/.exec(error.message);
      assert.ok(match, error.message);
      staging = match[1];
      return true;
    });
    const retryPlan = await preview(adminSession.id, destination, incomplete.database);
    await command('discard_postgres_restore', { id: adminSession.id, token: retryPlan.token });
    const emptyProfile = await alternate('격리 복원 롤백 검증', {
      username: 'fixture_admin', database: staging, environment: 'DEV',
    });
    const empty = await open(emptyProfile, adminPassword);
    try {
      const { schemas } = await command('postgres_schemas', { id: empty.id, page: 0 });
      assert.deepEqual(schemas.map(schema => schema.name), ['public']);
    } finally { await close(empty.id); }
    const restoreEvents = (await command('list_audit_events', { before: null })).events.filter(event => event.operation === 'postgres.restore');
    assert.ok(restoreEvents.some(event => event.outcome === 'succeeded'));
    assert.ok(restoreEvents.some(event => event.outcome === 'failed'));
    assert.doesNotMatch(JSON.stringify(restoreEvents), /fixture-administrator-password|approved-copy\.backup/);
  } finally { await close(adminSession.id); }
}

async function verifyRestoreDialog(page, projectId) {
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(projectId);
  await page.getByRole('button', { name: 'PostgreSQL 백업·복구 검증 열기', exact: true }).click();
  await page.getByRole('button', { name: 'PostgreSQL 연결', exact: true }).click();
  const connection = page.getByRole('dialog', { name: 'PostgreSQL 연결', exact: true });
  await connection.getByLabel('PostgreSQL 암호').fill('fixture-administrator-password');
  await connection.getByRole('button', { name: '연결', exact: true }).click();
  await connection.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '백업 복원', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'PostgreSQL 백업 복원', exact: true });
  await dialog.getByRole('textbox', { name: /백업 파일/ }).fill(path.join(root, 'database-full.backup'));
  await dialog.getByLabel('새 데이터베이스 이름').fill('fixture_restore_ui');
  await dialog.getByRole('button', { name: '복원 미리보기', exact: true }).click();
  await dialog.getByText(/아카이브 목차 ·/).click();
  await dialog.getByLabel('PostgreSQL 아카이브 목차', { exact: true }).waitFor();
  const restore = dialog.getByRole('button', { name: '새 DB에 복원', exact: true });
  assert.equal(await restore.isDisabled(), true);
  await dialog.getByRole('checkbox', { name: '백업 출처를 확인했고 복원 실행에 동의합니다.' }).check();
  await dialog.getByLabel('새 DB 이름 확인').fill('fixture_restore_ui');
  await dialog.getByLabel('PostgreSQL 암호').fill('fixture-administrator-password');
  await restore.click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByText('새 DB 복원 완료 · fixture_restore_ui', { exact: true }).waitFor();
  await page.getByText(/다시 연결하여 테이블 \d+개 확인/).waitFor();
}

async function verifyServerMonitor({ command, open, close, unrelated }) {
  const workspace = await open();
  const waiter = await open();
  const other = await open(unrelated, otherPassword);
  let monitor;
  const run = (id, source, request = randomUUID()) => command('execute_postgres_sql', { id, request, source, scope: { kind: 'document' } });
  const read = (id, filter = 'all', seconds = 1) => command('postgres_server_activity', { id, input: { filter, slow_seconds: seconds, page: 0 } });
  async function sample(filter, predicate, timeout = 3500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const snapshot = await read(monitor.id, filter);
      const matched = snapshot.sessions.find(predicate);
      if (matched) return matched;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(`Expected PostgreSQL activity did not appear in ${filter}.`);
  }
  try {
    await assert.rejects(read(workspace.id), /서버 모니터 연결/);
    await assert.rejects(command('open_postgres_monitor', { id: workspace.id, password, confirmation: '' }), /PROD/);
    monitor = await command('open_postgres_monitor', { id: workspace.id, password, confirmation: 'PROD' });
    assert.equal(monitor.grid_edit, false);
    await assert.rejects(command('open_postgres_monitor', { id: workspace.id, password, confirmation: 'PROD' }), /이미 열려/);
    await assert.rejects(read(monitor.id, 'slow', 0), /1초에서 3600초/);
    const snapshot = await read(monitor.id);
    assert.ok(snapshot.server_uptime_seconds >= 0);
    assert.ok(snapshot.database_backends >= 4);
    assert.ok(snapshot.max_connections >= snapshot.database_backends);
    assert.match(snapshot.commits, /^\d+$/);
    assert.ok(snapshot.cache_hit_percent === null || (snapshot.cache_hit_percent >= 0 && snapshot.cache_hit_percent <= 100));
    assert.ok(!snapshot.sessions.some(item => item.application === 'StackPort Monitor'));
    const pid = async id => Number((await run(id, 'SELECT pg_backend_pid()')).rows[0][0].value);
    const [workspacePid, waiterPid, otherPid] = await Promise.all([pid(workspace.id), pid(waiter.id), pid(other.id)]);
    const holderRequest = randomUUID();
    const holder = run(workspace.id, 'SELECT pg_sleep(7) FROM pg_catalog.pg_advisory_xact_lock(8840291)', holderRequest);
    const unrelatedWork = run(other.id, "SELECT pg_sleep(7), 'hidden-monitor-query'");
    let blocked;
    try {
      const active = await sample('running', item => item.pid === workspacePid && item.wait_event === 'PgSleep'
        && item.query?.includes('pg_advisory_xact_lock'));
      assert.match(active.query, /pg_advisory_xact_lock/);
      blocked = run(waiter.id, 'SELECT 1 FROM pg_catalog.pg_advisory_xact_lock(8840291)');
      const waiting = await sample('blocked', item => item.pid === waiterPid && item.query?.includes('pg_advisory_xact_lock'), 1800);
      assert.equal(waiting.wait_type, 'Lock');
      assert.deepEqual(waiting.blocker_pids, [workspacePid]);
      assert.match(waiting.query, /pg_advisory_xact_lock/);
      const slow = await sample('slow', item => item.pid === workspacePid);
      assert.ok(slow.query_elapsed_ms >= 1000);
      const limited = await sample('all', item => item.pid === otherPid);
      assert.equal(limited.username, 'fixture_unrelated');
      assert.equal(limited.state, null);
      assert.equal(limited.query, null);
      assert.equal(limited.wait_type, null);
      assert.ok(!(await read(monitor.id, 'running')).sessions.some(item => item.pid === otherPid));
      assert.ok(!JSON.stringify(await read(monitor.id)).includes('hidden-monitor-query'));
    } finally {
      await command('cancel_postgres_sql', { id: workspace.id, request: holderRequest });
      await close(other.id);
      await Promise.allSettled([holder, unrelatedWork, blocked]);
    }
    const ended = command('wait_postgres_disconnect', { id: monitor.id });
    await close(workspace.id);
    assert.equal(await ended, 'closed');
    await assert.rejects(read(monitor.id), /연결이 닫혔습니다/);
  } finally {
    if (monitor) await close(monitor.id);
    await close(workspace.id);
    await close(waiter.id);
    await close(other.id);
  }
}

async function verifyStatementStats({ command, query, open, close, session, unrelated }) {
  const benchmark = 'SELECT 1 AS historical_fixture_marker FROM (SELECT pg_sleep(0.18)) AS measured';
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await query(benchmark)).status, 'completed');
  }
  const other = await open(unrelated, otherPassword);
  let monitor;
  let otherMonitor;
  try {
    const otherQuery = await command('execute_postgres_sql', { id: other.id, request: randomUUID(),
      source: 'SELECT pg_sleep(0.24), 1 AS private_stat_marker', scope: { kind: 'document' } });
    assert.equal(otherQuery.status, 'completed');
    await assert.rejects(readStatementStats(command, session.id), /서버 모니터 연결/);
    monitor = await command('open_postgres_monitor', { id: session.id, password, confirmation: 'PROD' });
    otherMonitor = await command('open_postgres_monitor', { id: other.id, password: otherPassword, confirmation: 'PROD' });
    assert.deepEqual(await readStatementStats(command, otherMonitor.id), { status: 'unavailable', reason: 'permission_denied' });
    const report = await readStatementStats(command, monitor.id, { minimum_ms: 120 });
    assert.equal(report.status, 'available', JSON.stringify(report));
    assert.match(report.version, /^1\./);
    assert.equal(report.tracking, 'top');
    assert.ok(report.stats_reset_ms > 0 && report.stats_reset_ms <= report.sampled_at_ms);
    assert.match(report.evictions, /^\d+$/);
    assert.ok(report.rows.every(row => row.max_ms >= 120));
    assert.ok(report.rows.every((row, index, all) => index === 0 || all[index - 1].max_ms >= row.max_ms));
    const observed = report.rows.find(row => row.query?.includes('historical_fixture_marker'));
    assert.ok(observed, JSON.stringify(report.rows.map(row => [row.username, row.calls, row.max_ms])));
    assert.equal(observed.username, 'fixture_reader');
    assert.equal(observed.calls, '2');
    assert.equal(observed.rows, '2');
    assert.ok(observed.query_id && observed.mean_ms >= 150 && observed.total_ms >= 300);
    assert.match(observed.shared_reads, /^\d+$/);
    const hidden = report.rows.find(row => row.username === 'fixture_unrelated');
    assert.ok(hidden && hidden.max_ms >= 200);
    assert.equal(hidden.query, null);
    assert.equal(hidden.query_id, null);
    assert.equal(hidden.query_truncated, false);
    assert.ok(!JSON.stringify(report).includes('private_stat_marker'));
    assert.ok(!JSON.stringify(report).includes('other_database_stat'));
    const own = await readStatementStats(command, monitor.id, { minimum_ms: 120, own_only: true, order: 'mean' });
    assert.ok(own.rows.length > 0 && own.rows.every(row => row.username === 'fixture_reader'));
    assert.ok(own.rows.every((row, index, all) => index === 0 || all[index - 1].mean_ms >= row.mean_ms));
    assert.deepEqual((await readStatementStats(command, monitor.id, { minimum_ms: 86_400_000 })).rows, []);
    for (let width = 1; width <= 43; width++) {
      const columns = Array.from({ length: width }, (_, index) => String(index + 1));
      assert.equal((await query(`SELECT ${columns.join(', ')}`)).status, 'completed');
    }
    const firstPage = await readStatementStats(command, monitor.id, { own_only: true, order: 'calls' });
    assert.equal(firstPage.rows.length, 40);
    assert.equal(firstPage.has_next, true);
    assert.ok(firstPage.rows.every((row, index, all) => index === 0 || BigInt(all[index - 1].calls) >= BigInt(row.calls)));
    const secondPage = await readStatementStats(command, monitor.id, { own_only: true, order: 'calls', page: 1 });
    assert.ok(secondPage.rows.length > 0);
  } finally {
    if (otherMonitor) await close(otherMonitor.id);
    if (monitor) await close(monitor.id);
    await close(other.id);
  }
}

async function verifyStatsWithoutPreload(browser, fixture) {
  const page = browser.contexts()[0].pages()[0];
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'PostgreSQL 확장 미로드 검증' });
  const profile = await command('create_postgres_profile', { projectId: project.id, input: {
    name: '확장 미로드', host: 'localhost', port: fixture.port, database: 'postgres', username: 'fixture_reader', environment: 'DEV', ca_path: fixture.ca,
  } });
  const workspace = await command('open_postgres', { profile, password, confirmation: '' });
  try {
    const monitor = await command('open_postgres_monitor', { id: workspace.id, password, confirmation: '' });
    try {
      assert.deepEqual(await readStatementStats(command, monitor.id), { status: 'unavailable', reason: 'not_loaded' });
      assert.ok((await command('postgres_server_activity', { id: monitor.id,
        input: { filter: 'all', slow_seconds: 5, page: 0 } })).database_backends >= 2);
    } finally { await command('close_postgres', { id: monitor.id }); }
  } finally { await command('close_postgres', { id: workspace.id }); }
}

async function verifyCellFiles({ command, open, close, session, unrelated, findObject }) {
  const id = session.id;
  const object = findObject('raw_cells');
  const grid = (id, object) => command('postgres_page', { id, object, rowPage: 0, columnPage: 0 });
  const read = (target, page = 0) => command('postgres_value_page', { id, target, page });
  const save = (target, destination) => command('save_postgres_value', { id, target, destination });
  const page = await grid(id, object);
  assert.equal(page.primary_key_order, false);
  assert.equal(page.row_stamps, null);
  assert.deepEqual(page.columns.map(column => column.value_kind), [null, 'text', 'binary']);
  const first = page.rows.findIndex(row => row[0].value === '1');
  assert.equal(page.rows[first][2].value, '\\x' + binaryCell.subarray(0, 255).toString('hex'));
  assert.equal(page.rows[first][2].truncated, true);
  const row = page.value_rows[first];
  const text = { object, row, column: 'note' };
  const binary = { object, row, column: 'payload' };
  const firstText = await read(text);
  assert.equal(firstText.kind, 'text');
  assert.equal(firstText.text, '한😀'.repeat(2048));
  assert.equal(firstText.total_units, 72_003);
  assert.equal(firstText.has_next, true);
  assert.equal((await read(text, 17)).text, '한😀'.repeat(1184) + '\r\n끝');
  assert.equal((await read(text, 17)).has_next, false);
  await assert.rejects(read(text, 18), /페이지 범위/);
  const last = Math.floor((binaryCell.length - 1) / 4096);
  const lastBinary = await read(binary, last);
  assert.equal(lastBinary.total_units, binaryCell.length);
  assert.equal(lastBinary.offset, last * 4096);
  assert.equal(lastBinary.has_next, false);
  assert.deepEqual(Buffer.from(lastBinary.bytes), binaryCell.subarray(last * 4096));
  const empty = { object, column: 'payload', row: page.value_rows[page.rows.findIndex(row => row[0].value === '2')] };
  assert.deepEqual(await read(empty), { kind: 'binary', offset: 0, total_units: 0, has_next: false, bytes: [] });
  const nullCell = { object, column: 'note', row: page.value_rows[page.rows.findIndex(row => row[0].value === '3')] };
  await assert.rejects(read(nullCell), /NULL/);
  await assert.rejects(read({ ...text, column: 'id' }), /형식을 지원하지/);
  await assert.rejects(read({ ...text, object: findObject('denied') }), /SELECT 권한/);
  assert.equal((await grid(id, findObject('meta_view'))).value_rows, null);

  const other = await open(unrelated, otherPassword);
  try {
    const hidden = await grid(other.id, object);
    assert.deepEqual(hidden.rows.map(row => row[0].value), ['4']);
    const restricted = { object, column: 'note', row: hidden.value_rows[0] };
    await assert.rejects(read(restricted), /조회 권한/);
    await assert.rejects(command('postgres_value_representation', { id, target: { ...restricted, column: 'payload' } }), /조회 권한/);
    const hiddenFile = path.join(root, 'postgres-hidden-cell.txt');
    await assert.rejects(save(restricted, hiddenFile), /조회 권한/);
    assert.equal(fs.existsSync(hiddenFile), false);
  } finally { await close(other.id); }

  const textPath = path.join(root, 'postgres-native-cell.txt');
  const binaryPath = path.join(root, 'postgres-native-cell.bin');
  const emptyPath = path.join(root, 'postgres-empty-cell.bin');
  assert.equal((await save(text, textPath)).size_bytes, Buffer.byteLength(unicodeCell));
  assert.deepEqual(fs.readFileSync(textPath), Buffer.from(unicodeCell));
  assert.equal((await save(binary, binaryPath)).size_bytes, binaryCell.length);
  assert.deepEqual(fs.readFileSync(binaryPath), binaryCell);
  assert.equal((await save(empty, emptyPath)).size_bytes, 0);
  assert.equal(fs.statSync(emptyPath).size, 0);
  await assert.rejects(save(binary, textPath), /같은 이름/);
  assert.deepEqual(fs.readFileSync(textPath), Buffer.from(unicodeCell));
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.stackport-postgres-value-')));
  const audits = (await command('list_audit_events', { before: null })).events.filter(event => event.operation === 'postgres.export.cell');
  assert.equal(audits.length, 3);
  assert.ok(audits.every(event => event.affected_count === 1 && event.object_name === null));
  assert.ok(!JSON.stringify(audits).includes(textPath));
}

async function verifyCellRepresentations(command, id, object) {
  const page = await command('postgres_page', { id, object, rowPage: 0, columnPage: 0 });
  const field = (index, column) => ({ object, column, row: page.value_rows[index] });
  const view = target => command('postgres_value_representation', { id, target });
  assert.deepEqual(page.columns.map(column => column.value_kind), [null, 'binary', 'json', 'json', 'xml']);
  assert.deepEqual(await view(field(0, 'document')), { kind: 'json', text: typedJson });
  const normalized = await view(field(0, 'document_binary'));
  assert.equal(normalized.kind, 'json');
  assert.match(normalized.text, /9007199254740993/);
  assert.deepEqual(await view(field(0, 'markup')), { kind: 'xml', text: '<report id="17"><section>한글</section></report>' });
  const image = await view(field(0, 'payload'));
  assert.equal(image.kind, 'png');
  assert.deepEqual(Buffer.from(image.base64, 'base64'), staticPng);
  const original = path.join(root, 'postgres-image-cell.png');
  const saved = await command('save_postgres_value', { id, target: field(0, 'payload'), destination: original });
  assert.equal(saved.size_bytes, pngCell.length);
  assert.deepEqual(fs.readFileSync(original), pngCell);
  await assert.rejects(view(field(1, 'payload')), /정적 PNG/);
  await assert.rejects(view(field(2, 'payload')), /1 MiB/);
  await assert.rejects(view(field(2, 'document_binary')), /256 KiB/);
  await assert.rejects(view(field(1, 'document')), /NULL/);
  const fallback = await command('postgres_value_page', { id, target: field(2, 'document_binary'), page: 0 });
  assert.equal(fallback.has_next, true);
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
    const staleValue = { object, column: 'public note', row: view.value_rows[0] };
    await assert.rejects(command('postgres_value_page', { id, target: staleValue, page: 0 }), /행이 변경/);
    const staleFile = path.join(root, 'postgres-stale-cell.txt');
    await assert.rejects(command('save_postgres_value', { id, target: staleValue, destination: staleFile }), /행이 변경/);
    assert.equal(fs.existsSync(staleFile), false);

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
    await verifyGridUpdates({ command, page, id, peer: peer.id, findObject, readOnly: session.id });
    await verifyRowActions({ command, page, id, peer: peer.id, findObject, readOnly: session.id });
    await verifyRowPastes({ command, page, id, peer: peer.id, findObject, readOnly: session.id });
  } finally {
    await close(writer.id);
    await close(peer.id);
  }
}

async function verifyGridUpdates({ command, page, id, peer, findObject, readOnly }) {
  const target = findObject('grid_updates');
  const roleLimited = findObject('edit demo');
  const begin = (stamps, connection = id, object = target) => command('begin_postgres_grid_edit', { id: connection, object, stamps });
  const openColumn = (session, column) => command('open_postgres_grid_edit_column', { id, token: session.token, column });
  const preview = (session, changes) => command('preview_postgres_grid_edit', { id, token: session.token, changes });
  const apply = (session, proposal, confirmation = 'PROD') =>
    command('apply_postgres_grid_edit', { id, token: session.token, approval: proposal.approval, confirmation });
  const text = (column, value) => ({ column, input: { kind: 'text', value } });
  const changeBoth = (first, second) => [{ row: 0, cells: [first] }, { row: 1, cells: [second] }];
  const values = async () => (await page(peer, target)).rows.map(row => [row[1].value, row[2].value, row[4].value]);
  const current = await page(id, target);
  assert.equal(current.row_update, true);
  assert.equal((await page(readOnly, target)).row_update, false);
  await assert.rejects(begin(current.row_stamps, readOnly), /편집을 허용/);
  await assert.rejects(begin([current.row_stamps[0], current.row_stamps[0]]), /같은 행/);
  const columns = await begin(current.row_stamps);
  assert.deepEqual(columns.keys, [[['id', '1']], [['id', '2']]]);
  assert.deepEqual((await openColumn(columns, 'large_note')).map(field => field?.current.value ?? null), [null, '짧은 값']);
  await openColumn(columns, 'note');
  const previous = await preview(columns, changeBoth(text('note', '임시 A'), text('note', '임시 B')));
  await assert.rejects(preview(columns, [{ row: 0, cells: [text('large_note', '미허용')] }]), /열을 열어/);
  await assert.rejects(apply(columns, previous), /다시 미리/);
  await command('cancel_postgres_grid_edit', { id, token: columns.token });
  await assert.rejects(apply(columns, previous), /만료/);

  const blocked = await begin(current.row_stamps);
  await openColumn(blocked, 'note');
  await openColumn(blocked, 'amount');
  const check = await preview(blocked, changeBoth(text('note', '전부 롤백'), text('amount', '-1')));
  await assert.rejects(apply(blocked, check, ''), /PROD/);
  await assert.rejects(apply(blocked, check), /2번째 행.*23514.*전체 변경을 롤백/);
  await assert.rejects(apply(blocked, check), /만료/);
  assert.deepEqual(await values(), [['첫 값', '3.000', null], ['둘째 값', '4.000', null]]);

  const deferred = await begin((await page(id, target)).row_stamps);
  await openColumn(deferred, 'parent_id');
  const invalidReference = await preview(deferred, changeBoth(text('parent_id', '1'), text('parent_id', '999')));
  await assert.rejects(apply(deferred, invalidReference), /23503.*전체 변경을 롤백/);
  assert.deepEqual(await values(), [['첫 값', '3.000', null], ['둘째 값', '4.000', null]]);

  const limited = await begin((await page(id, roleLimited)).row_stamps, id, roleLimited);
  await openColumn(limited, 'public note');
  const denied = await preview(limited, changeBoth(text('public note', '권한 밖으로 롤백'), text('public note', '미허용')));
  await assert.rejects(apply(limited, denied), /2번째 행.*편집 권한.*전체 변경을 롤백/);
  assert.deepEqual((await page(peer, roleLimited)).rows.map(row => row[2].value), ['조합', '다른 행']);

  const fresh = (await page(id, target)).row_stamps;
  const stale = await begin(fresh);
  await openColumn(stale, 'note');
  const outdated = await preview(stale, changeBoth(text('note', '충돌로 롤백'), text('note', '동시 변경과 경쟁')));
  const other = await command('begin_postgres_edit', { id: peer, object: target, stamp: fresh[1], column: 'note' });
  const external = await command('preview_postgres_edit', { id: peer, token: other.token, input: { kind: 'text', value: '다른 연결에서 갱신' } });
  await command('apply_postgres_edit', { id: peer, token: other.token, approval: external.approval, confirmation: 'PROD' });
  await assert.rejects(apply(stale, outdated), /2번째 행.*행이 변경.*전체 변경을 롤백/);
  assert.deepEqual(await values(), [['첫 값', '3.000', null], ['다른 연결에서 갱신', '4.000', null]]);

  const ready = await begin((await page(id, target)).row_stamps);
  await openColumn(ready, 'note');
  await openColumn(ready, 'amount');
  await openColumn(ready, 'observed');
  const approved = await preview(ready, [
    { row: 0, cells: [{ column: 'note', input: { kind: 'default' } }] },
    { row: 1, cells: [text('amount', '5.1237'), text('observed', 'now')] },
  ]);
  assert.equal(approved.rows[0].changes[0].before.value, '첫 값');
  assert.match(approved.rows[0].changes[0].default_sql, /서버 기본값/);
  assert.equal(approved.rows[1].changes[0].after.value, '5.124');
  const previewTime = approved.rows[1].changes[1].after.value;
  assert.match(previewTime, /^\d{4}-\d{2}-\d{2} /);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(await apply(ready, approved), { status: 'applied', affected_rows: 2, affected_cells: 3, audit_warning: false });
  assert.deepEqual(await values(), [['서버 기본값', '3.000', null], ['다른 연결에서 갱신', '5.124', null]]);
  assert.equal((await page(peer, target)).rows[1][5].value, previewTime);
  const history = await command('list_audit_events', { before: null });
  const reports = history.events.filter(event => event.operation === 'postgres.edit.grid');
  assert.ok(reports.some(event => event.outcome === 'succeeded' && event.affected_count === 2 &&
    event.policy === 'postgres-grid-update-prod-confirmed'));
  assert.equal(reports.filter(event => event.outcome === 'failed').length, 4);
  assert.doesNotMatch(JSON.stringify(reports), /권한 밖으로|다른 연결에서|5\.124/);
}

async function verifyRowActions({ command, page, id, peer, findObject, readOnly }) {
  const target = findObject('row actions');
  const begin = (change, object = target, connection = id) => command('begin_postgres_row_change', { id: connection, object, change });
  const preview = (token, fields) => command('preview_postgres_row_insert', { id, token, fields });
  const apply = (session, approval, confirmation = 'PROD') => command('apply_postgres_row_change', {
    id, token: session.token, approval, confirmation,
  });
  const text = (column, value) => ({ column, input: { kind: 'text', value } });
  const actionView = await page(id, target);
  assert.equal(actionView.row_insert, true);
  assert.equal(actionView.row_delete, true);
  assert.ok(actionView.columns.every(column => !column.editable));
  assert.equal((await page(readOnly, target)).row_insert, false);
  await assert.rejects(begin({ kind: 'insert' }, target, readOnly), /편집을 허용/);
  const insert = await begin({ kind: 'insert' });
  assert.equal(insert.columns[0].editable, false);
  await assert.rejects(preview(insert.token, [text('id', '5')]), /직접 입력/);
  const inputs = [text('row label', 'native row action'), text('empty_text', ''), { column: 'optional', input: { kind: 'null' } }, text('amount', '0')];
  const original = await preview(insert.token, inputs);
  await assert.rejects(preview(insert.token, [...inputs, text('amount', '1')]), /두 번/);
  await assert.rejects(apply(insert, original.approval), /미리/);
  const approved = await preview(insert.token, inputs);
  assert.equal(approved.fields.find(field => field.name === 'amount').cell.display, '0.00');
  assert.equal((await page(peer, target)).rows.length, 0);
  await assert.rejects(apply(insert, approved.approval, ''), /PROD/);
  const added = await apply(insert, approved.approval);
  assert.equal(added.status, 'applied');
  assert.equal(added.result.fields.find(field => field.name === 'due').cell.display, '2026-01-02');
  await assert.rejects(apply(insert, approved.approval), /만료/);
  const stored = await page(peer, target);
  assert.deepEqual(stored.rows[0].slice(1, 6).map(cell => cell.value), ['native row action', '', null, '0.00', '2026-01-02']);
  const denied = await begin({ kind: 'insert' });
  const rejected = await preview(denied.token, [text('row label', 'deny')]);
  await assert.rejects(apply(denied, rejected.approval), /권한/);
  assert.equal((await page(peer, target)).rows.length, 1);
  const deleted = await begin({ kind: 'delete', stamp: stored.row_stamps[0] });
  await assert.rejects(apply(deleted, deleted.preview.approval, ''), /PROD/);
  assert.equal((await apply(deleted, deleted.preview.approval)).status, 'applied');
  assert.equal((await page(peer, target)).rows.length, 0);

  const cascade = findObject('row_cascade');
  const cascadeView = await page(id, cascade);
  assert.equal(cascadeView.row_delete, false);
  assert.match(cascadeView.row_delete_reason, /연쇄 변경/);
  await assert.rejects(begin({ kind: 'delete', stamp: stored.row_stamps[0] }, cascade), /연쇄 변경/);
  const guard = findObject('row_guard');
  const guardStamp = (await page(id, guard)).row_stamps[0];
  const stale = await begin({ kind: 'delete', stamp: guardStamp }, guard);
  const edit = await command('begin_postgres_edit', { id: peer, object: guard, stamp: guardStamp, column: 'label' });
  const changed = await command('preview_postgres_edit', { id: peer, token: edit.token, input: { kind: 'text', value: 'concurrent' } });
  await command('apply_postgres_edit', { id: peer, token: edit.token, approval: changed.approval, confirmation: 'PROD' });
  await assert.rejects(apply(stale, stale.preview.approval), /행이 변경/);
  assert.equal((await page(peer, guard)).rows[0][1].value, 'concurrent');
  const history = await command('list_audit_events', { before: null });
  const entries = history.events.filter(event => event.operation === 'postgres.row.insert' || event.operation === 'postgres.row.delete');
  assert.ok(entries.some(event => event.operation === 'postgres.row.insert' && event.outcome === 'succeeded'
    && event.affected_count === 1 && event.object_name === '"report"."row actions"'));
  assert.ok(entries.some(event => event.operation === 'postgres.row.delete' && event.outcome === 'succeeded'
    && event.policy === 'postgres-row-change-prod-confirmed' && event.affected_count === 1));
  assert.doesNotMatch(JSON.stringify(entries), /native row action|concurrent/);
}

async function verifyRowPastes({ command, page, id, peer, findObject, readOnly }) {
  const target = findObject('row actions');
  const begin = (object = target, connection = id) => command('begin_postgres_row_change', { id: connection, object, change: { kind: 'paste' } });
  const preview = (token, columns, rows) => command('preview_postgres_row_paste', { id, token, columns, rows });
  const apply = (session, approval, confirmation = 'PROD') => command('apply_postgres_row_paste', { id, token: session.token, approval, confirmation });
  const text = (column, value) => ({ column, input: { kind: 'text', value } });
  assert.equal((await page(id, target)).row_paste, true);
  assert.equal((await page(readOnly, target)).row_paste, false);
  await assert.rejects(begin(target, readOnly), /편집을 허용/);

  const bad = await begin();
  const rejected = await preview(bad.token, ['row label'], [[text('row label', 'valid before policy')], [text('row label', 'deny')]]);
  await assert.rejects(apply(bad, rejected.approval), /전체를 롤백.*권한/);
  assert.equal((await page(peer, target)).rows.length, 0);

  const session = await begin();
  const names = ['row label', 'empty_text', 'optional', 'amount', 'observed'];
  const input = [[text('row label', 'native paste row'), text('empty_text', ''), { column: 'optional', input: { kind: 'null' } },
    text('amount', '9007199254740993.125'), text('observed', 'now')], [text('row label', 'native paste defaults')]];
  const old = await preview(session.token, names, input);
  await assert.rejects(preview(session.token, ['row label', 'row label'], input), /두 번/);
  await assert.rejects(apply(session, old.approval), /미리/);
  const ready = await preview(session.token, names, input);
  assert.equal(ready.rows[0][3].display, '9007199254740993.13');
  assert.equal(ready.rows[1][3], null);
  assert.equal((await page(peer, target)).rows.length, 0);
  await assert.rejects(command('apply_postgres_row_change', { id, token: session.token, approval: ready.approval, confirmation: 'PROD' }), /미리/);
  await assert.rejects(apply(session, ready.approval, ''), /PROD/);
  const paused = await command('execute_postgres_sql', { id: peer, request: randomUUID(), source: 'SELECT pg_catalog.pg_sleep(0.05)', scope: { kind: 'document' } });
  assert.equal(paused.status, 'completed');
  const saved = await apply(session, ready.approval);
  assert.equal(saved.status, 'pasted');
  assert.equal(saved.result.rows, 2);
  await assert.rejects(apply(session, ready.approval), /만료/);
  const stored = await page(peer, target);
  assert.deepEqual(stored.rows.map(row => row.slice(1).map(cell => cell.value)), [
    ['native paste row', '', null, '9007199254740993.13', '2026-01-02', ready.rows[0][4].display],
    ['native paste defaults', 'default text', 'not null', '7.00', '2026-01-02', null],
  ]);

  const deferred = findObject('paste_refs');
  const pending = await begin(deferred);
  const blocked = await preview(pending.token, ['parent_id'], [[text('parent_id', '1')], [text('parent_id', '999')]]);
  await assert.rejects(apply(pending, blocked.approval), /전체를 롤백.*23503/);
  assert.equal((await page(peer, deferred)).rows.length, 0);
  const history = await command('list_audit_events', { before: null });
  const entries = history.events.filter(event => event.operation === 'postgres.row.paste');
  assert.ok(entries.some(event => event.outcome === 'succeeded' && event.affected_count === 2));
  assert.doesNotMatch(JSON.stringify(entries), /native paste row|valid before policy/);
  for (const stamp of stored.row_stamps) {
    const deletion = await command('begin_postgres_row_change', { id, object: target, change: { kind: 'delete', stamp } });
    await command('apply_postgres_row_change', { id, token: deletion.token, approval: deletion.preview.approval, confirmation: 'PROD' });
  }
}

async function main() {
  const fixture = await startPostgres();
  let withoutPreload;
  let gateway;
  let jump;
  let browser;
  try {
    gateway = await startGateway(fixture.port);
    jump = await startGateway(gateway.port, ['127.0.0.1']);
    browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
    await verify(browser, fixture, gateway, jump);
    if (backupTools) console.log('PostgreSQL backup scopes, digest, overwrite protection and isolated restore passed.');
    withoutPreload = await startPostgres(false);
    await verifyStatsWithoutPreload(browser, withoutPreload);
    console.log('Windows PostgreSQL E2E passed (column layouts, cell representations, statement stats, grid editing, file import and SSH jump recovery).');
  } finally {
    await browser?.close();
    withoutPreload?.close();
    jump?.close();
    gateway?.close();
    fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
