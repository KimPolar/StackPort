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
  const open = (item, password = secret, confirmation = 'PROD') => command('open_mongo', { profileId: item.id, revision: item.revision, password, confirmation });
  await assert.rejects(open(profile, secret, ''), /PROD/);
  await assert.rejects(open(profile, 'wrong-mongo-password'), /암호|TLS/);
  const badHostname = await alternate({ name: '인증서 호스트 이름 불일치', uri: profile.settings.uri.replace('localhost', '127.0.0.1') });
  await assert.rejects(open(badHostname), /TLS/);

  const session = await open(profile);
  assert.equal(session.database, 'visible');
  const id = session.id;
  try {
    assert.deepEqual((await command('mongo_databases', { id, search: '', page: 0 })).items, ['visible']);
    assert.deepEqual((await command('mongo_databases', { id, search: '.*', page: 0 })).items, []);
    const database = 'visible';
    const collections = (await command('mongo_collections', { id, database, search: 'records', page: 0 })).items;
    assert.deepEqual(collections.map(item => [item.name, item.kind]).sort(), [['recent_records', 'view'], ['records', 'collection']]);
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
  assert.deepEqual(errors, []);
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
    console.log('MongoDB Windows E2E passed (TLS, permissions, catalog, BSON, querying, schema analysis and aggregation pipelines).');
  } catch (cause) {
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-3500));
    throw cause;
  } finally {
    try { if (browser) await browser.close(); }
    finally { await stop(server); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
