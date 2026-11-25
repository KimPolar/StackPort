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
  await workspace.getByRole('button', { name: 'recent_records 뷰', exact: true }).click();
  await detail.getByRole('heading', { name: 'recent_records' }).waitFor();
  await detail.locator('pre[aria-label="Canonical Extended JSON"]').filter({ hasText: '문서 20' }).waitFor();
  await workspace.getByRole('button', { name: 'MongoDB 연결 끊기', exact: true }).click();
  await detail.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
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
    console.log('MongoDB Windows E2E passed (verified TLS, restricted access, catalog, BSON, paging, filters and indexes).');
  } catch (cause) {
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-3500));
    throw cause;
  } finally {
    try { if (browser) await browser.close(); }
    finally { await stop(server); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
