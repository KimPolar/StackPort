const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { chooseDatabase } = require('./database-picker.cjs');

const root = process.env.STACKPORT_TEST_ROOT;
const binary = process.env.STACKPORT_MONGO_BIN;
const openssl = process.env.STACKPORT_TEST_OPENSSL || 'openssl';
const python = process.env.STACKPORT_TEST_PYTHON || 'python';
const secret = 'stackport-mongo-catalog-test';
const editSecret = 'stackport-mongo-edit-test';
const indexSecret = 'stackport-mongo-index-test';
const log = path.join(root, 'mongo-server.log');
assert.ok(path.isAbsolute(root) && path.isAbsolute(binary));

function run(file, args) {
  execFileSync(file, args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
}

async function availablePort() {
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function certificates() {
  const ca = path.join(root, 'mongo-ca.pem');
  const cert = path.join(root, 'mongo-server.pem');
  const key = path.join(root, 'mongo-server.key');
  const combined = path.join(root, 'mongo-identity.pem');
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', 'mongo-ca.key', '-out', ca,
    '-subj', '/CN=StackPort MongoDB Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', 'mongo-server.csr', '-subj', '/CN=localhost']);
  fs.writeFileSync(path.join(root, 'mongo-server.ext'), 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  run(openssl, ['x509', '-req', '-in', 'mongo-server.csr', '-CA', ca, '-CAkey', 'mongo-ca.key', '-CAcreateserial', '-days', '2',
    '-out', cert, '-extfile', 'mongo-server.ext']);
  fs.writeFileSync(combined, fs.readFileSync(cert, 'utf8') + fs.readFileSync(key, 'utf8'));
  return { ca, combined };
}

async function stop(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null || !server.pid) return;
  const stopped = once(server, 'exit');
  server.kill();
  await stopped;
}

async function verify(page, port, ca) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(15_000);
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'MongoDB 실제 서버 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await chooseDatabase(page, 'MongoDB');
  const create = page.getByRole('dialog', { name: 'MongoDB 연결 추가', exact: true });
  await create.getByLabel('연결 이름').fill('MongoDB 검증');
  await create.getByLabel('MongoDB 연결 주소').fill(`mongodb://localhost:${port}/visible?authSource=admin&directConnection=true`);
  await create.getByLabel('사용자 이름 (선택)').fill('catalog_reader');
  await create.getByLabel('환경').selectOption('PROD');
  await create.getByLabel('CA 인증서 경로 (선택)').fill(ca);
  await create.getByRole('button', { name: '저장', exact: true }).click();
  await create.waitFor({ state: 'detached' });
  const explorer = page.getByRole('complementary', { name: '작업 공간 탐색기', exact: true });
  const databaseGroup = explorer.getByRole('button', { name: '데이터베이스 연결 목록', exact: true });
  const entry = explorer.getByRole('button', { name: 'MongoDB MongoDB 검증 열기', exact: true });
  await entry.waitFor();
  assert.equal(await databaseGroup.getAttribute('aria-description'), '연결 1개');
  assert.equal(await explorer.getByRole('button', { name: 'MongoDB', exact: true }).count(), 0);
  await entry.click();
  const workspace = page.getByRole('region', { name: 'MongoDB 작업 공간', exact: true });
  await workspace.getByRole('heading', { name: /MongoDB 검증/ }).waitFor();

  const [profile] = await command('list_mongo_profiles', { projectId: project.id });
  assert.doesNotMatch(JSON.stringify(profile), new RegExp(secret));
  const alternate = changes => command('create_mongo_profile', { projectId: project.id, input: { ...profile.settings, ...changes } });
  const open = (item, password = secret, confirmation = 'PROD', allowEdits = false, allowIndexes = false, allowNamespaces = false) =>
    command('open_mongo', { profileId: item.id, revision: item.revision, password, confirmation, allowEdits, allowIndexes, allowNamespaces });
  await assert.rejects(open(profile, secret, ''), /PROD/);
  await assert.rejects(open(profile, 'wrong-mongo-password'), /암호|TLS/);
  const badHostname = await alternate({ name: '인증서 호스트 이름 불일치', uri: profile.settings.uri.replace('localhost', '127.0.0.1') });
  await assert.rejects(open(badHostname), /TLS/);

  const session = await open(profile);
  assert.equal(session.database, 'visible');
  const id = session.id;
  try {
    assert.equal(session.allow_edits, false);
    assert.equal(session.allow_namespaces, false);
    await assert.rejects(command('review_mongo_namespace_create', {
      id, database: 'visible', name: 'forbidden', input: { kind: 'collection', validator: '', level: 'strict', action: 'error' },
    }), /컬렉션·뷰 관리를 허용/);
    await assert.rejects(command('review_mongo_index_change', {
      id, database: 'visible', collection: 'records', input: { kind: 'drop', name: 'expiry' },
    }), /인덱스 관리를 허용/);
    await assert.rejects(command('begin_mongo_document_edit', {
      id, database: 'visible', collection: 'edit_records', change: { kind: 'insert' },
    }), /편집을 허용한/);
    assert.deepEqual((await command('mongo_databases', { id, search: '', page: 0 })).items, ['visible']);
    assert.deepEqual((await command('mongo_databases', { id, search: '.*', page: 0 })).items, []);
    const database = 'visible';
    const collections = (await command('mongo_collections', { id, database, search: 'records', page: 0 })).items;
    assert.deepEqual(collections.map(item => [item.name, item.kind]).sort(), [['edit_records', 'collection'], ['recent_records', 'view'], ['records', 'collection']]);
    const query = { filter: '', projection: '', sort_field: '_id', descending: false, page: 0 };
    const list = (changes = {}, target = database) => command('mongo_documents', { id, database: target, collection: 'records', query: { ...query, ...changes } });
    const first = await list();
    assert.equal(first.items.length, 20);
    assert.equal(first.has_next, true);
    assert.deepEqual(JSON.parse(first.items[0].json), {
      _id: { $oid: '000000000000000000000001' }, rank: { $numberInt: '0' }, title: '문서 0',
      exact: { $numberLong: '9223372036854775807' }, decimal: { $numberDecimal: '123.4500' },
      payload: { $binary: { base64: 'AP8=', subType: '00' } },
    });
    const last = await list({ page: 1 });
    assert.equal(last.items.length, 3);
    assert.equal(last.has_next, false);
    assert.equal(last.items[2].json, null);
    const filtered = await list({ filter: '{"rank":{"$gte":20}}', projection: '{"rank":1,"_id":0}', sort_field: 'rank', descending: true });
    assert.deepEqual(filtered.items.map(item => JSON.parse(item.json).rank.$numberInt), ['22', '21', '20']);
    const count = (filter, target = database, collection = 'records') =>
      command('count_mongo_documents', { id, database: target, collection, filter });
    assert.equal(await count(''), '23');
    assert.equal(await count('{"rank":{"$gte":20}}'), '3');
    assert.equal(await count('{"rank":{"$gte":21}}', database, 'recent_records'), '2');
    assert.equal(await count('{"rank":{"$gt":22}}'), '0');
    await assert.rejects(count('{"$where":"return true"}'), /필터/);
    await assert.rejects(count('', 'private', 'data'), /권한/);
    await assert.rejects(list({ filter: '{"$where":"return true"}' }), /필터/);
    await assert.rejects(list({}, 'private'), /권한/);
    const indexes = await command('mongo_indexes', { id, database, collection: 'records' });
    assert.equal(indexes.items.find(index => index.name === 'expiry').ttl_seconds, 600);
    assert.deepEqual(JSON.parse(indexes.items.find(index => index.name === 'rank_desc').keys), { rank: { $numberInt: '-1' } });
    const analyze = (sampleSize, db = database, collection = 'schema_samples') =>
      command('mongo_schema_sample', { id, database: db, collection, sampleSize });
    const schema = await analyze(100);
    assert.equal(schema.documents, 3);
    assert.equal(schema.oversized, 1);
    assert.equal(schema.structure_limited, false);
    const field = (...path) => schema.fields.find(item => JSON.stringify(item.path) === JSON.stringify(path.map(name =>
      name === null ? { kind: 'array_item' } : { kind: 'field', name })));
    assert.deepEqual(field('events').types, { Array: 3 });
    assert.equal(field('events', null, 'value').documents, 2);
    assert.deepEqual(field('events', null, 'value').types, { Int32: 1, String: 2 });
    assert.deepEqual(field('optional').types, { Int64: 1, Null: 1 });
    assert.deepEqual(field('name.with.dot').types, { Boolean: 1 });
    assert.deepEqual(field('name', 'with', 'dot').types, { String: 1 });
    assert.doesNotMatch(JSON.stringify(schema), /mixed-value|nested-value/u);
    const single = await analyze(1);
    assert.equal(single.documents + single.oversized, 1);
    await assert.rejects(analyze(0), /표본 크기/);
    await assert.rejects(analyze(101), /표본 크기/);
    await assert.rejects(analyze(20, 'private', 'data'), /권한/);
    const viewSchema = await analyze(50, database, 'recent_records');
    assert.equal(viewSchema.documents, 2);
    assert.equal(viewSchema.oversized, 1);
    const stage = (operator, expression, enabled = true) => ({ operator, expression, enabled });
    const preview = (stages, through = null, db = database, collection = 'records') =>
      command('mongo_pipeline_preview', { id, database: db, collection, request: { stages, through } });
    const pipeline = [
      stage('$match', '{"rank":{"$gte":20},"exact":{"$numberLong":"9223372036854775807"}}'),
      stage('$project', '{"rank":1,"exact":1,"_id":0}'),
      stage('$limit', '{아직 작성 중', false),
      stage('$group', '{"_id":null,"total":{"$sum":"$rank"},"exact":{"$max":"$exact"}}'),
    ];
    assert.equal((await preview(pipeline, 2)).items.length, 3);
    assert.deepEqual(JSON.parse((await preview(pipeline)).items[0].json), {
      _id: null, total: { $numberInt: '63' }, exact: { $numberLong: '9223372036854775807' },
    });
    const capped = await preview([stage('$match', '{}')]);
    assert.equal(capped.items.length, 20);
    assert.equal(capped.has_next, true);
    const groupedView = await preview([stage('$count', '"count"')], null, database, 'recent_records');
    assert.equal(JSON.parse(groupedView.items[0].json).count.$numberInt, '3');
    const facet = await preview([stage('$facet', '{"totals":[{"$count":"count"}]}')]);
    assert.equal(JSON.parse(facet.items[0].json).totals[0].count.$numberInt, '23');
    await assert.rejects(preview([stage('$group', '{'), stage('$limit', '1')]), /1단계.*Extended JSON/);
    await assert.rejects(preview([stage('$out', '"changed"')]), /1단계/);
    await assert.rejects(preview([stage('$facet', '{"unsafe":[{"$lookup":{"from":"records","as":"joined","pipeline":[{"$merge":"changed"}]}}]}')]), /읽기 전용/);
    await assert.rejects(preview([stage('$project', '{"calc":{"$function":{"body":"function() { return 1; }","args":[],"lang":"js"}}}')]), /JavaScript/);
    await assert.rejects(preview([stage('$count', '"count"')], null, 'private', 'data'), /권한/);
  } finally {
    await command('close_mongo', { id });
  }
  await assert.rejects(command('mongo_databases', { id, search: '', page: 0 }), /닫혔습니다/);

  await workspace.getByRole('button', { name: 'MongoDB 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'MongoDB 연결', exact: true });
  await login.getByLabel('MongoDB 암호').fill(secret);
  assert.equal(await login.getByRole('button', { name: '연결', exact: true }).isEnabled(), false);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  await workspace.getByRole('button', { name: 'records 컬렉션', exact: true }).click();
  const detail = workspace.getByRole('region', { name: 'MongoDB 컬렉션 상세' });
  await detail.locator('pre[aria-label="Canonical Extended JSON"]').filter({ hasText: '문서 0' }).waitFor();
  await detail.getByText('필터 및 정렬', { exact: true }).click();
  await detail.getByLabel('필터 JSON').fill('{"rank":{"$gte":20}}');
  await detail.getByLabel('표시 필드 JSON').fill('{"rank":1,"_id":0}');
  await detail.getByLabel('정렬 필드').fill('rank');
  await detail.getByLabel('정렬 방향').selectOption('desc');
  await detail.getByRole('button', { name: '조회 적용' }).click();
  await detail.locator('pre[aria-label="Canonical Extended JSON"]').filter({ hasText: '"22"' }).waitFor();
  await verifyFindBuilder(page, detail);
  await detail.getByRole('button', { name: '인덱스', exact: true }).click();
  await detail.getByRole('rowheader', { name: 'expiry', exact: true }).waitFor();
  await verifyPipeline(page, detail);
  await workspace.getByRole('button', { name: 'schema_samples 컬렉션', exact: true }).click();
  await detail.getByRole('button', { name: '스키마 분석', exact: true }).click();
  await detail.getByLabel('표본 크기', { exact: true }).selectOption('100');
  await detail.getByRole('button', { name: '표본 분석', exact: true }).click();
  await detail.getByText(/분석 문서 3개.*혼합 유형 2개/u).waitFor();
  await detail.getByText(/64 KiB를 넘은 문서 1개/u).waitFor();
  const schemaTable = detail.getByRole('table', { name: 'MongoDB 문서 스키마', exact: true });
  await schemaTable.getByRole('rowheader', { name: '["name.with.dot"]', exact: true }).waitFor();
  await schemaTable.getByRole('rowheader', { name: 'name.with.dot', exact: true }).waitFor();
  await detail.getByRole('checkbox', { name: '혼합 유형만', exact: true }).check();
  assert.deepEqual(await schemaTable.getByRole('rowheader').allTextContents(), ['events[].value', 'optional']);
  const searchField = detail.getByRole('searchbox', { name: '필드 경로 검색', exact: true });
  await searchField.fill('events');
  assert.deepEqual(await schemaTable.getByRole('rowheader').allTextContents(), ['events[].value']);
  assert.match(await schemaTable.innerText(), /66\.7%.*Int32.*1개.*String.*2개/su);
  await workspace.getByRole('button', { name: 'recent_records 뷰', exact: true }).click();
  await detail.getByRole('heading', { name: 'recent_records' }).waitFor();
  await detail.locator('pre[aria-label="Canonical Extended JSON"]').filter({ hasText: '문서 20' }).waitFor();
  await detail.getByRole('button', { name: '스키마 분석', exact: true }).click();
  assert.equal(await detail.getByRole('table', { name: 'MongoDB 문서 스키마', exact: true }).count(), 0);
  await workspace.getByRole('button', { name: 'MongoDB 연결 끊기', exact: true }).click();
  await detail.waitFor({ state: 'detached' });

  const editProfile = await alternate({ name: '편집 검증', username: 'document_editor' });
  const indexProfile = await alternate({ name: '인덱스 검증', username: 'index_editor' });
  await verifyDocumentCommands(command, open, profile, editProfile, port, ca);
  await verifyIndexCommands(command, () => open(indexProfile, indexSecret, 'PROD', false, true));
  await verifyNamespaceCommands(command, () => open(indexProfile, indexSecret, 'PROD', true, false, true));
  const limitedNamespace = await open(profile, secret, 'PROD', false, false, true);
  try {
    const denied = await command('review_mongo_namespace_create', { id: limitedNamespace.id, database: 'visible',
      name: 'denied_collection', input: { kind: 'collection', validator: '', level: 'strict', action: 'error' } });
    await assert.rejects(command('apply_mongo_namespace_create', { id: limitedNamespace.id, token: denied.token, confirmation: 'PROD' }), /생성할 권한/);
  } finally {
    await command('close_mongo', { id: limitedNamespace.id });
  }
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await explorer.getByRole('button', { name: 'MongoDB 편집 검증 열기', exact: true }).click();
  await verifyDocumentEditor(page, workspace, detail);
  await workspace.getByRole('button', { name: 'MongoDB 연결 끊기', exact: true }).click();
  await detail.waitFor({ state: 'detached' });
  await explorer.getByRole('button', { name: 'MongoDB 인덱스 검증 열기', exact: true }).click();
  await workspace.getByRole('button', { name: 'MongoDB 연결', exact: true }).click();
  const indexLogin = page.getByRole('dialog', { name: 'MongoDB 연결', exact: true });
  await indexLogin.getByLabel('MongoDB 암호').fill(indexSecret);
  await indexLogin.getByLabel('운영 환경 확인').fill('PROD');
  await indexLogin.getByRole('checkbox', { name: '이 연결에서 인덱스 관리 허용', exact: true }).check();
  await indexLogin.getByRole('checkbox', { name: '이 연결에서 컬렉션·뷰 관리 허용', exact: true }).check();
  await indexLogin.getByRole('button', { name: '연결', exact: true }).click();
  await indexLogin.waitFor({ state: 'detached' });
  await verifyIndexEditor(page, workspace, detail);
  await verifyNamespaceEditor(page, workspace, detail);
  const audit = await command('list_audit_events', { before: null });
  const edits = audit.events.filter(event => event.operation.startsWith('mongo.document.'));
  for (const kind of ['insert', 'duplicate', 'replace', 'delete']) {
    assert.ok(edits.some(event => event.operation === `mongo.document.${kind}` && event.outcome === 'succeeded'));
  }
  assert.ok(edits.some(event => event.operation === 'mongo.document.delete' && event.outcome === 'failed'));
  assert.doesNotMatch(JSON.stringify(edits), /9223372036854775807|write-fixture|편집한 문서/u);
  assert.ok(audit.events.some(event => event.operation === 'mongo.index.create' && event.outcome === 'succeeded'));
  assert.ok(audit.events.some(event => event.operation === 'mongo.index.drop' && event.outcome === 'succeeded'));
  assert.ok(audit.events.some(event => event.operation === 'mongo.index.modify' && event.outcome === 'succeeded'));
  assert.ok(audit.events.some(event => event.operation === 'mongo.index.modify' && event.outcome === 'failed'));
  for (const operation of ['mongo.namespace.create_collection', 'mongo.namespace.create_view']) {
    assert.ok(audit.events.some(event => event.operation === operation && event.outcome === 'succeeded'));
  }
  assert.deepEqual(errors, []);
}

async function verifyNamespaceCommands(command, openAdmin) {
  const first = await openAdmin();
  const second = await openAdmin();
  const database = 'namespace_new';
  const collection = 'validated_items';
  const available = async id => (await command('mongo_databases', { id, search: database, page: 0 })).items;
  const review = (id, name, input) => command('review_mongo_namespace_create', { id, database, name, input });
  const apply = (id, token, confirmation = 'PROD') => command('apply_mongo_namespace_create', { id, token, confirmation });
  const definition = { kind: 'collection', validator: '{"$jsonSchema":{"required":["qty"],"properties":{"qty":{"bsonType":"int"}}}}',
    level: 'strict', action: 'error' };
  const insert = async (id, input) => {
    const draft = await command('begin_mongo_document_edit', { id, database, collection, change: { kind: 'insert' } });
    const prepared = await command('review_mongo_document_edit', { id, token: draft.token, input });
    return command('apply_mongo_document_edit', { id, token: prepared.token, confirmation: 'PROD', approval: '' });
  };
  try {
    assert.equal(first.allow_namespaces, true);
    assert.equal(first.allow_indexes, false);
    assert.deepEqual(await available(first.id), []);
    await assert.rejects(review(first.id, 'invalid', { kind: 'view', source: 'missing', pipeline: '[]' }), /원본 이름/);
    const before = await review(first.id, collection, definition);
    const competitor = await review(second.id, collection, definition);
    assert.match(before.definition, /\$jsonSchema/);
    assert.deepEqual(await available(first.id), []);
    await assert.rejects(apply(second.id, before.token), /만료되었거나/);
    await assert.rejects(apply(first.id, before.token, ''), /PROD/);
    assert.deepEqual(await apply(first.id, before.token), { database, name: collection, kind: 'collection', audit_warning: false });
    assert.deepEqual(await available(first.id), [database]);
    await assert.rejects(apply(first.id, before.token), /만료되었거나/);
    await assert.rejects(apply(second.id, competitor.token), /이미 있습니다/);
    await assert.rejects(insert(first.id, '{"_id":"invalid","qty":"3"}'), /유효성 검사/);
    await insert(first.id, '{"_id":"keep","qty":{"$numberInt":"4"}}');
    await insert(first.id, '{"_id":"reject-by-view","qty":{"$numberInt":"1"}}');
    const view = { kind: 'view', source: collection, pipeline: '[{"$match":{"qty":{"$gte":3}}}]' };
    const preview = await review(first.id, 'filtered_items', view);
    assert.match(preview.definition, /"viewOn": "validated_items"/);
    assert.equal((await apply(first.id, preview.token)).kind, 'view');
    const { items } = await command('mongo_documents', { id: first.id, database, collection: 'filtered_items', query: {} });
    assert.deepEqual(items.map(item => JSON.parse(item.json)._id), ['keep']);
  } finally {
    await Promise.all([first, second].map(session => command('close_mongo', { id: session.id })));
  }
}

async function verifyNamespaceEditor(page, workspace, detail) {
  const button = (container, name) => container.getByRole('button', { name, exact: true });
  await button(workspace, '컬렉션·뷰 만들기').click();
  const dialog = page.getByRole('dialog', { name: 'MongoDB 컬렉션·뷰 만들기', exact: true });
  await dialog.getByLabel('컬렉션 이름', { exact: true }).fill('ui_collection');
  await dialog.getByLabel('유효성 규칙 (선택, Extended JSON)').fill('{"$jsonSchema":{"required":["title"]}}');
  await button(dialog, '생성 검토').click();
  await dialog.getByLabel('생성 명령', { exact: true }).filter({ hasText: '$jsonSchema' }).waitFor();
  const apply = button(dialog, '생성 적용');
  assert.equal(await apply.isDisabled(), true);
  await dialog.getByLabel('운영 환경 확인').fill('PROD');
  await apply.click();
  await dialog.waitFor({ state: 'detached' });
  await detail.getByRole('heading', { name: 'ui_collection', exact: true }).waitFor();
  await button(workspace, 'ui_collection 컬렉션').waitFor();

  await button(workspace, '컬렉션·뷰 만들기').click();
  await dialog.getByLabel('생성 유형', { exact: true }).selectOption('view');
  await dialog.getByLabel('뷰 이름', { exact: true }).fill('ui_view');
  await dialog.getByLabel('원본 컬렉션 또는 뷰 이름', { exact: true }).fill('records');
  await dialog.getByLabel('뷰 파이프라인 (Extended JSON 배열)').fill('[{"$match":{"rank":22}}]');
  await button(dialog, '생성 검토').click();
  await dialog.getByLabel('생성 명령', { exact: true }).filter({ hasText: '$match' }).waitFor();
  await dialog.getByLabel('운영 환경 확인').fill('PROD');
  await apply.click();
  await dialog.waitFor({ state: 'detached' });
  await detail.getByRole('heading', { name: 'ui_view', exact: true }).waitFor();
  await button(workspace, 'ui_view 뷰').waitFor();
  await detail.locator('summary').filter({ hasText: '"22"' }).waitFor();
}

async function verifyIndexCommands(command, openAdmin) {
  const primary = await openAdmin();
  assert.equal(primary.allow_indexes, true);
  assert.equal(primary.allow_edits, false);
  const other = await openAdmin();
  const scope = { database: 'visible', collection: 'records' };
  const review = (id, input) => command('review_mongo_index_change', { id, ...scope, input });
  const get = async name => (await command('mongo_indexes', { id: primary.id, ...scope })).items.find(index => index.name === name);
  const apply = (id, token, approval = '', confirmation = 'PROD') => command('apply_mongo_index_change', { id, token, approval, confirmation });
  const create = (name, keys, options = {}) => ({ kind: 'create', name, keys, unique: false, expire_after_seconds: null, ...options });
  const drop = name => ({ kind: 'drop', name });
  const modify = (name, hidden, expire_after_seconds) => ({ kind: 'modify', name, hidden, expire_after_seconds });
  try {
    await assert.rejects(review(primary.id, drop('*')), /이름/);
    await assert.rejects(review(primary.id, drop('_id_')), /이름/);
    await assert.rejects(command('review_mongo_index_change', {
      id: primary.id, ...scope, collection: 'recent_records', input: drop('expiry'),
    }), /일반 MongoDB 컬렉션/);
    for (const [draft, check] of [
      [create('compound_review', [{ field: 'title', kind: 'desc' }, { field: 'rank', kind: 'asc' }], { unique: true }),
        index => { assert.deepEqual(Object.keys(JSON.parse(index.keys)), ['title', 'rank']); assert.equal(index.unique, true); }],
      [create('ttl_review', [{ field: 'review_expiry', kind: 'asc' }], { expire_after_seconds: 120 }), index => assert.equal(index.ttl_seconds, 120)],
      [create('text_review', [{ field: 'title', kind: 'text' }]), index => assert.equal(JSON.parse(index.keys)._fts, 'text')],
      [create('geo_review', [{ field: 'location', kind: 'sphere' }]), index => assert.equal(JSON.parse(index.keys).location, '2dsphere')],
    ]) {
      const before = await review(primary.id, draft);
      assert.equal(await get(draft.name), undefined);
      await assert.rejects(apply(primary.id, before.token, '', ''), /PROD/);
      await apply(primary.id, before.token);
      await assert.rejects(apply(primary.id, before.token), /만료/);
      check(await get(draft.name));
      const impact = await review(primary.id, drop(draft.name));
      assert.equal(impact.unique, draft.unique);
      assert.equal(impact.ttl_seconds, draft.expire_after_seconds);
      await assert.rejects(apply(primary.id, impact.token), /DROP/);
      await apply(primary.id, impact.token, 'DROP');
      assert.equal(await get(draft.name), undefined);
    }

    const old = create('concurrent_review', [{ field: 'old_field', kind: 'asc' }]);
    await apply(primary.id, (await review(primary.id, old)).token);
    const stale = await review(primary.id, drop(old.name));
    await apply(other.id, (await review(other.id, drop(old.name))).token, 'DROP');
    await apply(other.id, (await review(other.id, create(old.name, [{ field: 'new_field', kind: 'asc' }]))).token);
    await assert.rejects(apply(primary.id, stale.token, 'DROP'), /바뀌었습니다/);
    assert.deepEqual(Object.keys(JSON.parse((await get(old.name)).keys)), ['new_field']);

    const name = 'option_review';
    await apply(primary.id, (await review(primary.id, create(name, [{ field: 'option_expiry', kind: 'asc' }]))).token);
    await assert.rejects(review(primary.id, modify(name, false, null)), /변경할 인덱스 옵션/);
    const planned = await review(primary.id, modify(name, true, 120));
    assert.equal(JSON.parse(planned.previous_definition).expireAfterSeconds, undefined);
    assert.equal(JSON.parse(planned.definition).hidden, true);
    assert.equal(planned.ttl_may_expire_documents, true);
    assert.equal(planned.visibility_changed, true);
    assert.equal((await get(name)).ttl_seconds, null);
    await assert.rejects(apply(primary.id, planned.token, '', ''), /PROD/);
    await apply(primary.id, planned.token);
    assert.equal((await get(name)).hidden, true);
    assert.equal((await get(name)).ttl_seconds, 120);
    const staleOptions = await review(primary.id, modify(name, false, 60));
    const extend = await review(other.id, modify(name, null, 300));
    assert.equal(extend.ttl_may_expire_documents, false);
    await apply(other.id, extend.token);
    await assert.rejects(apply(primary.id, staleOptions.token), /바뀌었습니다/);
    assert.equal((await get(name)).ttl_seconds, 300);
    assert.equal((await get(name)).hidden, true);
    await apply(primary.id, (await review(primary.id, modify(name, false, 60))).token);
    assert.equal((await get(name)).ttl_seconds, 60);
    assert.equal((await get(name)).hidden, false);
  } finally {
    await command('close_mongo', { id: primary.id });
    await command('close_mongo', { id: other.id });
  }
}

async function verifyIndexEditor(page, workspace, detail) {
  const button = (container, name) => container.getByRole('button', { name, exact: true });
  await button(workspace, 'records 컬렉션').click();
  await button(detail, '인덱스').click();
  await button(detail, '인덱스 생성').click();
  const create = page.getByRole('dialog', { name: 'MongoDB 인덱스 생성', exact: true });
  await create.getByLabel('인덱스 이름', { exact: true }).fill('ui_ttl');
  await create.getByLabel('필드 경로', { exact: true }).fill('ui_expiry');
  await create.getByLabel('TTL (초)', { exact: true }).fill('60');
  await button(create, '생성 검토').click();
  await create.getByText(/이미 만료된 문서/).waitFor();
  assert.equal(await button(create, '인덱스 생성 적용').isDisabled(), true);
  await create.getByLabel('운영 환경 확인', { exact: true }).fill('PROD');
  await button(create, '인덱스 생성 적용').click();
  await create.waitFor({ state: 'detached' });
  await detail.getByRole('rowheader', { name: 'ui_ttl', exact: true }).waitFor();
  await button(detail, 'ui_ttl 인덱스 옵션 변경').click();
  const modify = page.getByRole('dialog', { name: 'MongoDB 인덱스 옵션 변경', exact: true });
  assert.equal(await button(modify, '옵션 변경 검토').isDisabled(), true);
  await modify.getByRole('checkbox', { name: '쿼리 플래너에서 숨기기', exact: true }).check();
  await modify.getByRole('checkbox', { name: 'TTL 변경', exact: true }).check();
  await modify.getByLabel('TTL (초)', { exact: true }).fill('30');
  await button(modify, '옵션 변경 검토').click();
  await modify.getByLabel('변경 전 인덱스 정의', { exact: true }).filter({ hasText: /60/u }).waitFor();
  await modify.getByLabel('변경 후 인덱스 정의', { exact: true }).filter({ hasText: /30/u }).waitFor();
  await modify.getByText(/쿼리 플래너에서 이 인덱스를 제외/u).waitFor();
  await modify.getByText(/이미 만료된 문서/u).waitFor();
  await modify.getByLabel('운영 환경 확인', { exact: true }).fill('PROD');
  await button(modify, '인덱스 옵션 변경 적용').click();
  await modify.waitFor({ state: 'detached' });
  await detail.getByRole('rowheader', { name: /ui_ttl.*숨김/u }).waitFor();
  await detail.getByRole('cell', { name: '30초', exact: true }).first().waitFor();
  await button(detail, 'ui_ttl 인덱스 삭제').click();
  const drop = page.getByRole('dialog', { name: 'MongoDB 인덱스 삭제', exact: true });
  await button(drop, '삭제 영향 조회').click();
  await drop.getByText(/TTL 자동 만료가 중단/).waitFor();
  await drop.getByLabel('인덱스 삭제 승인', { exact: true }).fill('DROP');
  assert.equal(await button(drop, '검토한 인덱스 삭제').isDisabled(), true);
  await drop.getByLabel('운영 환경 확인', { exact: true }).fill('PROD');
  await button(drop, '검토한 인덱스 삭제').click();
  await drop.waitFor({ state: 'detached' });
  await detail.getByRole('rowheader', { name: /ui_ttl/u }).waitFor({ state: 'detached' });
}

async function verifyFindBuilder(page, detail) {
  const button = (container, name) => container.getByRole('button', { name, exact: true });
  const count = button(detail, '일치 건수 조회');
  const countText = value => detail.getByText(`일치 문서 ${value}개`, { exact: true });
  const filter = detail.getByLabel('필터 JSON');
  await filter.fill('{"rank":{"$lt":20}}');
  await count.click();
  await countText(3).waitFor();
  await filter.fill('{"rank":{"$gte":20}}');

  await button(detail, '찾기 빌더').click();
  const builder = page.getByRole('dialog', { name: 'MongoDB 찾기 빌더', exact: true });
  const condition = builder.getByRole('group', { name: '검색 조건', exact: true });
  const combine = builder.getByRole('checkbox', { name: '기존 필터도 함께 적용', exact: true });
  assert.equal(await combine.isChecked(), true);
  await condition.getByLabel('일치 방식').selectOption('any');
  await condition.getByLabel('필드', { exact: true }).fill('title');
  await condition.getByLabel('값', { exact: true }).fill('문서 22');
  await button(condition, '하위 그룹 추가').click();
  const group = builder.getByRole('group', { name: '하위 그룹', exact: true });
  await group.getByLabel('필드', { exact: true }).fill('rank');
  await group.getByLabel('연산자').selectOption('in');
  const list = group.getByLabel('목록 (Extended JSON)');
  await list.fill('[21]');
  await button(group, '조건 추가').click();
  await group.getByLabel('필드', { exact: true }).nth(1).fill('exact');
  await group.getByLabel('값 형식').selectOption('json');
  await group.getByLabel('값', { exact: true }).fill('{"$numberLong":"9223372036854775807"}');
  await button(builder, '조회 적용').click();
  await builder.waitFor({ state: 'detached' });
  const compiled = JSON.parse(await filter.inputValue());
  assert.equal(compiled.$and[1].$or[1].$and[1].exact.$eq.$numberLong, '9223372036854775807');
  assert.equal(await countText(3).count(), 0);
  await count.click();
  await countText(2).waitFor();
  const documents = detail.getByRole('list', { name: 'MongoDB 문서', exact: true });
  assert.equal(await documents.getByRole('listitem').count(), 2);
  const shown = await documents.getByLabel('Canonical Extended JSON', { exact: true }).first().textContent();
  assert.deepEqual(JSON.parse(shown), { rank: { $numberInt: '22' } });

  await button(detail, '찾기 빌더').click();
  assert.equal(await list.inputValue(), '[21]');
  await list.fill('21');
  await button(builder, '조회 적용').click();
  await builder.getByRole('alert').filter({ hasText: 'Extended JSON 배열' }).waitFor();
  await button(builder, '취소').click();
  await countText(2).waitFor();
}

async function verifyDocumentCommands(command, open, reader, writer, port, ca) {
  const database = 'visible';
  const collection = 'edit_records';
  const begin = (id, change, target = collection) => command('begin_mongo_document_edit', { id, database, collection: target, change });
  const review = (id, draft, input = draft.draft ?? '') => command('review_mongo_document_edit', { id, token: draft.token, input });
  const apply = (id, prepared, confirmation = 'PROD', approval = '') =>
    command('apply_mongo_document_edit', { id, token: prepared.token, confirmation, approval });
  const rows = (id, name = collection) => command('mongo_documents', { id, database, collection: name, query: {} });
  const first = await open(writer, editSecret, 'PROD', true);
  const second = await open(writer, editSecret, 'PROD', true);
  const limited = await open(reader, secret, 'PROD', true);
  try {
    assert.equal(first.allow_edits, true);
    const denied = await review(limited.id, await begin(limited.id, { kind: 'insert' }), '{"title":"denied"}');
    await assert.rejects(apply(limited.id, denied), /쓰기 권한/);
    await assert.rejects(begin(first.id, { kind: 'insert' }, 'recent_records'), /일반 MongoDB 컬렉션/);
    const originalId = (await rows(first.id)).items[0].id;
    assert.equal(originalId, '{"zone":"west","number":{"$numberLong":"7"}}');
    const target = { document_id: originalId };
    const obsolete = await review(first.id, await begin(first.id, { kind: 'delete', ...target }));
    const rival = await begin(second.id, { kind: 'replace', ...target });
    assert.match(rival.draft, /9223372036854775807/);
    const next = JSON.parse(rival.draft);
    next.z.values[0].precision = { $numberDouble: '5.0' };
    const changedType = await review(second.id, rival, JSON.stringify(next));
    assert.equal((await apply(second.id, changedType)).affected_count, 1);
    await assert.rejects(apply(first.id, obsolete, 'PROD', 'DELETE'), /변경되었거나/);
    assert.equal(JSON.parse((await rows(first.id)).items[0].json).z.values[0].precision.$numberDouble, '5.0');

    const generationDraft = await begin(first.id, { kind: 'insert' }, 'edit_generation');
    const oldCollection = await review(first.id, generationDraft, '{"title":"wrong-generation"}');
    run(python, [path.join(__dirname, 'mongo-fixture.py'), String(port), ca, 'recreate_edit_collection']);
    await assert.rejects(apply(first.id, oldCollection), /변경되었거나/);
    const recreated = await rows(first.id, 'edit_generation');
    assert.deepEqual(recreated.items.map(item => JSON.parse(item.json)._id), ['seed']);

    const newDocument = await begin(first.id, { kind: 'insert' });
    const input = '{"_id":"write-fixture","z":[{"n":{"$numberLong":"9223372036854775807"}}]}';
    const superseded = await review(first.id, newDocument, input);
    await assert.rejects(review(first.id, newDocument, '{"z":[{"n":1,"n":2}]}'), /중복/);
    await assert.rejects(apply(first.id, superseded), /다시 검토/);
    const insertion = await review(first.id, newDocument, input);
    await assert.rejects(apply(first.id, insertion, ''), /PROD/);
    assert.equal((await rows(first.id)).items.length, 1);
    assert.equal((await apply(first.id, insertion)).affected_count, 1);
    await assert.rejects(apply(first.id, insertion), /다시 검토/);
    const deleting = await begin(first.id, { kind: 'delete', document_id: '"write-fixture"' });
    const deletion = await review(first.id, deleting);
    await assert.rejects(apply(first.id, deletion), /DELETE/);
    assert.equal((await apply(first.id, deletion, 'PROD', 'DELETE')).affected_count, 1);
    assert.equal((await rows(first.id)).items.length, 1);
  } finally {
    for (const item of [first, second, limited]) await command('close_mongo', { id: item.id });
  }
}

async function verifyDocumentEditor(page, workspace, detail) {
  const button = (container, name) => container.getByRole('button', { name, exact: true });
  const dialog = name => page.getByRole('dialog', { name, exact: true });
  await button(workspace, 'MongoDB 연결').click();
  const login = dialog('MongoDB 연결');
  await login.getByLabel('MongoDB 암호').fill(editSecret);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByRole('checkbox', { name: '이 연결에서 문서 편집 허용', exact: true }).check();
  await button(login, '연결').click();
  await login.waitFor({ state: 'detached' });
  await button(workspace, 'edit_records 컬렉션').click();
  await detail.getByText('필터 및 정렬', { exact: true }).click();
  await detail.getByLabel('표시 필드 JSON').fill('{"title":1}');
  await button(detail, '조회 적용').click();
  const preview = detail.getByLabel('Canonical Extended JSON').first();
  await preview.waitFor();
  assert.deepEqual(Object.keys(JSON.parse(await preview.textContent())).sort(), ['_id', 'title']);
  await button(detail, '1행 문서 수정').click();
  const edit = dialog('MongoDB 문서 수정');
  const input = edit.getByLabel('문서 Extended JSON', { exact: true });
  await input.waitFor().catch(async error => { throw new Error(await edit.innerText(), { cause: error }); });
  const original = await input.inputValue();
  const source = JSON.parse(original);
  assert.equal(source.exact.$numberLong, '9223372036854775807');
  assert.equal(source.z['a.b'], 'literal');
  await input.fill('{"nested":');
  await button(edit, '그리드').click();
  await edit.getByRole('alert').waitFor();
  assert.equal(await input.inputValue(), '{"nested":');
  await input.fill(original);
  await verifyStructuredDraft(edit, input, button);
  await button(edit, '변경 검토').click();
  await edit.getByRole('region', { name: '변경 후 문서', exact: true }).getByText(/편집한 문서/u).waitFor();
  assert.equal(await button(edit, '검토한 변경 적용').isDisabled(), true);
  await edit.getByLabel('운영 환경 확인').fill('PROD');
  await button(edit, '검토한 변경 적용').click();
  await edit.waitFor({ state: 'detached' });
  await preview.filter({ hasText: '편집한 문서' }).waitFor();

  await button(detail, '1행 문서 복제').click();
  const copy = dialog('MongoDB 문서 복제');
  const copyInput = copy.getByLabel('문서 Extended JSON', { exact: true });
  await copyInput.waitFor();
  const copied = JSON.parse(await copyInput.inputValue());
  assert.equal('_id' in copied, false);
  assert.deepEqual(copied.z.values[1], { new_field: true });
  assert.equal(copied.z.values.at(-1), 'keep');
  assert.equal(copied.z['literal.dot'], 'literal');
  assert.equal(copied.added_long.$numberLong, '9223372036854775806');
  copied.title = '복제 문서';
  await copyInput.fill(JSON.stringify(copied));
  await button(copy, '변경 검토').click();
  await copy.getByLabel('운영 환경 확인').fill('PROD');
  await button(copy, '검토한 변경 적용').click();
  await copy.waitFor({ state: 'detached' });
  const second = detail.getByRole('list', { name: 'MongoDB 문서', exact: true }).getByRole('listitem').nth(1);
  await second.locator('summary').click();
  assert.equal(JSON.parse(await second.getByLabel('Canonical Extended JSON').textContent()).title, '복제 문서');
  await button(second, '2행 문서 삭제').click();
  const deleting = dialog('MongoDB 문서 삭제');
  await button(deleting, '변경 검토').click();
  await deleting.getByLabel('운영 환경 확인').fill('PROD');
  assert.equal(await button(deleting, '검토한 변경 적용').isDisabled(), true);
  await deleting.getByLabel('삭제 확인').fill('DELETE');
  await button(deleting, '검토한 변경 적용').click();
  await deleting.waitFor({ state: 'detached' });
  await second.waitFor({ state: 'detached' });

  await button(detail, '문서 삽입').click();
  const newDoc = dialog('MongoDB 문서 삽입');
  await newDoc.getByLabel('문서 Extended JSON', { exact: true }).fill('{"title":"새 문서"}');
  await button(newDoc, '변경 검토').click();
  await newDoc.getByRole('region', { name: '변경 후 문서', exact: true }).getByText(/\$oid/u).waitFor();
  await newDoc.getByLabel('운영 환경 확인').fill('PROD');
  await button(newDoc, '검토한 변경 적용').click();
  await newDoc.waitFor({ state: 'detached' });
  await second.locator('summary').click();
  assert.equal(JSON.parse(await second.getByLabel('Canonical Extended JSON').textContent()).title, '새 문서');
  await button(workspace, 'MongoDB 연결 끊기').click();
}

async function verifyStructuredDraft(edit, input, button) {
  await button(edit, '트리').click();
  const tree = edit.getByRole('group', { name: '문서 트리', exact: true });
  await button(tree, '문서._id 펼치기').click();
  await button(tree, '문서._id.number 선택').click();
  await edit.getByText('_id 유지', { exact: true }).waitFor();
  assert.equal(await button(edit, '값 바꾸기').count(), 0);
  await button(tree, '문서.z 펼치기').click();
  await button(tree, '문서.z["a.b"] 선택').click();
  await button(edit, '이름 변경').click();
  await edit.getByLabel('필드 이름', { exact: true }).fill('literal.dot');
  assert.equal(await button(edit, '변경 검토').isDisabled(), true);
  await button(edit, '초안에 반영').click();
  await button(tree, '문서.z["literal.dot"] 선택').waitFor();
  await button(tree, '문서.z.values 선택').click();
  await button(edit, '항목 추가').click();
  const value = edit.getByLabel('값 Extended JSON', { exact: true });
  await value.fill('{"new_field":true}');
  await button(edit, '초안에 반영').click();
  await tree.getByRole('button', { name: '문서.z.values[2] 선택', pressed: true, exact: true }).waitFor();
  await button(edit, '위로 이동').click();
  await tree.getByRole('button', { name: '문서.z.values[1] 선택', pressed: true, exact: true }).waitFor();

  await button(edit, '그리드').click();
  const grid = edit.getByRole('table', { name: '문서 그리드', exact: true });
  const path = edit.getByRole('navigation', { name: '문서 경로', exact: true });
  await grid.getByRole('rowheader', { name: 'new_field', exact: true }).waitFor();
  await button(path, '문서').click();
  await button(grid, '문서.title 값 편집').click();
  await value.fill('"편집한 문서"');
  await button(edit, '초안에 반영').click();
  await value.waitFor({ state: 'detached' });
  await button(path, '문서').click();
  await button(edit, '필드 추가').click();
  await edit.getByLabel('필드 이름', { exact: true }).fill('added_long');
  await edit.getByLabel('BSON 값 예시', { exact: true }).selectOption({ label: 'Int64' });
  assert.equal(await value.inputValue(), '{"$numberLong":"0"}');
  await value.fill('{"$numberLong":"9223372036854775806"}');
  await button(edit, '초안에 반영').click();
  await grid.getByRole('rowheader', { name: 'added_long', exact: true }).waitFor();
  await button(edit, 'JSON').click();
  const changed = JSON.parse(await input.inputValue());
  assert.equal(changed.title, '편집한 문서');
  assert.equal(changed.exact.$numberLong, '9223372036854775807');
  assert.equal(changed.added_long.$numberLong, '9223372036854775806');
  assert.deepEqual(changed.z.values[1], { new_field: true });
}

async function verifyPipeline(page, detail) {
  const button = (container, name) => container.getByRole('button', { name, exact: true });
  const dialog = name => page.getByRole('dialog', { name, exact: true });
  await button(detail, '집계 파이프라인').click();
  const editor = detail.getByRole('region', { name: 'MongoDB 집계 파이프라인', exact: true });
  const results = editor.getByRole('region', { name: 'MongoDB 집계 미리보기 결과' });
  const addOperator = editor.getByLabel('추가할 집계 연산자', { exact: true });
  const stageList = editor.getByRole('list', { name: '집계 단계', exact: true });
  const expressions = ['{"rank":{"$gte":20},"title":{"$exists":true}}', '{"rank":1,"_id":0}', '{"rank":-1}', '1'];
  for (const [index, operator] of ['$match', '$project', '$sort', '$limit'].entries()) {
    await addOperator.selectOption(operator);
    await button(editor, '단계 추가').click();
    await editor.getByLabel(`${index + 1}단계 Extended JSON`, { exact: true }).fill(expressions[index]);
  }
  await button(editor, '2단계까지 미리보기').click();
  await results.getByRole('heading', { name: '2단계까지 미리보기', exact: true }).waitFor();
  await results.getByText('문서 3개', { exact: true }).waitFor();
  await button(editor, '전체 미리보기').click();
  await results.getByText('문서 1개', { exact: true }).waitFor();
  const projected = await results.getByLabel('Canonical Extended JSON').first().textContent();
  assert.equal(JSON.parse(projected).rank.$numberInt, '22');
  await button(editor, '2단계 위로 이동').click();
  assert.equal(await editor.getByLabel('1단계 연산자', { exact: true }).inputValue(), '$project');
  await button(editor, '전체 미리보기').click();
  await results.getByText('집계 결과가 없습니다.', { exact: true }).waitFor();
  await button(editor, '1단계 아래로 이동').click();
  await editor.getByRole('checkbox', { name: '4단계 활성화', exact: true }).uncheck();
  await button(editor, '전체 미리보기').click();
  await results.getByText('문서 3개', { exact: true }).waitFor();

  await button(editor, '저장').click();
  const save = dialog('파이프라인 저장');
  await save.getByLabel('파이프라인 이름', { exact: true }).fill('랭크 검토');
  await button(save, '프로젝트에 저장').click();
  await editor.getByText('랭크 검토 파이프라인을 저장했습니다.', { exact: true }).waitFor();
  await button(editor, 'JSON 교환').click();
  const exchange = dialog('파이프라인 JSON 교환');
  const shared = await exchange.getByLabel('내보낼 파이프라인 JSON', { exact: true }).inputValue();
  assert.deepEqual(JSON.parse(shared).stages.map(item => item.expression), expressions);
  assert.equal(JSON.parse(shared).stages[3].enabled, false);
  await button(exchange, '닫기').click();
  await button(editor, '4단계 제거').click();
  assert.equal(await stageList.getByRole('listitem').count(), 3);
  await button(editor, 'JSON 교환').click();
  await button(exchange, '가져오기').click();
  const incoming = exchange.getByLabel('가져올 파이프라인 JSON', { exact: true });
  await incoming.fill('{"format":"other"}');
  await button(exchange, '편집기에 가져오기').click();
  await exchange.getByRole('alert').waitFor();
  await incoming.fill(shared);
  await button(exchange, '편집기에 가져오기').click();
  await exchange.waitFor({ state: 'detached' });
  assert.equal(await stageList.getByRole('listitem').count(), 4);
  assert.equal(await results.count(), 0);
  await button(editor, '4단계 제거').click();
  await button(editor, '저장된 파이프라인').click();
  const library = dialog('저장된 파이프라인');
  await button(library, '편집기에 불러오기').click();
  await library.waitFor({ state: 'detached' });
  assert.equal(await stageList.getByRole('listitem').count(), 4);
  assert.equal(await editor.getByRole('checkbox', { name: '4단계 활성화', exact: true }).isChecked(), false);
  assert.equal(await results.count(), 0);
}

async function main() {
  const port = await availablePort();
  const { ca, combined } = certificates();
  const db = path.join(root, 'mongo-data');
  fs.mkdirSync(db);
  const server = spawn(binary, ['--dbpath', db, '--bind_ip', '127.0.0.1', '--port', String(port), '--auth',
    '--tlsMode', 'requireTLS', '--tlsCertificateKeyFile', combined, '--tlsCAFile', ca, '--tlsAllowConnectionsWithoutCertificates',
    '--logpath', log], { cwd: root, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    await once(server, 'spawn');
    let listening = false;
    for (let attempt = 0; attempt < 60 && server.exitCode === null; attempt++) {
      const socket = net.connect(port, '127.0.0.1');
      try { await once(socket, 'connect'); listening = true; break; } catch {} finally { socket.destroy(); }
      await delay(250);
    }
    assert.ok(listening, 'The isolated MongoDB server did not start.');
    run(python, [path.join(__dirname, 'mongo-fixture.py'), String(port), ca]);
    browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
    await verify(browser.contexts()[0].pages()[0], port, ca);
    console.log('MongoDB Windows E2E passed (TLS, catalog, BSON, schema, pipelines, JSON/tree/grid editing and concurrent-change protection).');
  } catch (cause) {
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-3500));
    throw cause;
  } finally {
    try { if (browser) await browser.close(); }
    finally { await stop(server); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
