const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');

const root = process.env.STACKPORT_TEST_ROOT;
const binary = process.env.STACKPORT_REDIS_BIN;
const openssl = process.env.STACKPORT_TEST_OPENSSL || 'openssl';
const secret = 'stackport-redis-fixture-password';
const binaryKey = Buffer.from([0, 255, 42, 13, 10]);
const keyId = key => Buffer.from(key).toString('base64');
assert.ok(root && path.isAbsolute(root) && binary && path.isAbsolute(binary));

function encode(args) {
  const values = args.map(arg => Buffer.from(arg));
  return Buffer.concat([Buffer.from('*' + values.length + '\r\n'),
    ...values.flatMap(value => [Buffer.from('$' + value.length + '\r\n'), value, Buffer.from('\r\n')])]);
}

function cli(port, commands) {
  const output = execFileSync(path.join(path.dirname(binary), 'redis-cli.exe'), ['-h', '127.0.0.1', '-p', String(port), '--pipe'], {
    input: Buffer.concat(commands.map(encode)), cwd: root, windowsHide: true, encoding: 'utf8', timeout: 12_000,
  });
  assert.match(output, /errors: 0,/i);
}

async function availablePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function ready(port, child) {
  for (let attempt = 0; attempt < 70 && child.exitCode === null; attempt++) {
    const reached = await new Promise(resolve => {
      const connection = net.connect(port, '127.0.0.1');
      connection.once('connect', () => { connection.destroy(); resolve(true); });
      connection.once('error', () => resolve(false));
      connection.setTimeout(500, () => { connection.destroy(); resolve(false); });
    });
    if (reached) return;
    await delay(100);
  }
  throw new Error('The Redis fixture did not start.');
}

async function proxy(port) {
  const ca = path.join(root, 'ca.pem');
  const caKey = path.join(root, 'ca.key');
  const cert = path.join(root, 'certificate.pem');
  const key = path.join(root, 'certificate.key');
  const run = args => execFileSync(openssl, args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', caKey, '-out', ca,
    '-subj', '/CN=StackPort Redis test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', 'server.csr', '-subj', '/CN=localhost']);
  fs.writeFileSync(path.join(root, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  run(['x509', '-req', '-in', 'server.csr', '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '2', '-out', cert, '-extfile', 'server.ext']);
  const clients = new Set();
  const listener = tls.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key), minVersion: 'TLSv1.2' }, client => {
    clients.add(client);
    const target = net.connect(port, '127.0.0.1');
    client.on('error', () => target.destroy());
    target.on('error', () => client.destroy());
    client.on('close', () => { clients.delete(client); target.destroy(); });
    target.on('close', () => client.destroy());
    client.pipe(target).pipe(client);
  }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const dropClients = () => { for (const client of clients) client.destroy(); };
  return { port: listener.address().port, ca, dropClients, close: () => { dropClients(); listener.close(); } };
}

async function verify(browser, serverPort, secure) {
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'Redis 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: 'Redis 연결 추가', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Redis 연결 추가', exact: true });
  await create.getByLabel('연결 이름').fill('캐시 검증');
  await create.getByLabel('호스트 이름 또는 IP').fill('localhost');
  await create.getByLabel('포트').fill(String(secure.port));
  await create.getByLabel('DB 번호').fill('3');
  await create.getByLabel('ACL 사용자 이름').fill('fixture_reader');
  await create.getByLabel('환경').selectOption('PROD');
  await create.getByLabel('CA 인증서 경로 (선택)').fill(secure.ca);
  await create.getByRole('button', { name: '저장', exact: true }).click();
  await create.waitFor({ state: 'detached' });
  const workspace = page.getByRole('region', { name: 'Redis 작업 공간', exact: true });
  await workspace.getByRole('heading', { name: /캐시 검증/ }).waitFor();
  const [profile] = await command('list_redis_profiles', { projectId: project.id });
  assert.ok(!JSON.stringify(profile).includes(secret));
  assert.equal(profile.settings.database, 3);
  const open = (item, password = secret, confirmation = 'PROD') => command('open_redis', {
    profileId: item.id, revision: item.revision, password, confirmation,
  });
  const alternate = (name, change) => command('create_redis_profile', { projectId: project.id, input: { ...profile.settings, ...change, name } });
  await assert.rejects(open(profile, secret, ''), /PROD/);
  await assert.rejects(open(profile, 'wrong-redis-password'), /사용자 또는 암호/);
  const wrongHost = await alternate('잘못된 호스트', { host: '127.0.0.1' });
  await assert.rejects(open(wrongHost), /TLS 인증서/);
  const plain = await alternate('일반 TCP', { host: '127.0.0.1', port: serverPort, tls: false, ca_path: null, username: '', environment: 'DEV' });
  const plainSession = await open(plain, '', '');
  await command('close_redis', { id: plainSession.id });

  const { id } = await open(profile);
  const scan = (cursor, pattern, kind = null) => command('redis_keys', { id, input: { cursor, pattern, kind } });
  const read = (key, position = null) => command('redis_value', { id, input: { key: keyId(key), position } });
  let cursor = '0';
  let visits = 0;
  const all = new Map();
  do {
    const result = await scan(cursor, '*');
    assert.ok(result.total > 300);
    cursor = result.cursor;
    for (const key of result.keys) all.set(key.id, key.display);
    assert.ok(++visits < 20);
  } while (cursor !== '0');
  assert.ok(visits > 1);
  assert.equal(all.has(keyId('db0:only')), false);
  assert.equal(all.get(keyId(binaryKey)).text, '00ff2a0d0a');
  assert.equal(all.get(keyId(binaryKey)).encoding, 'hex');
  assert.equal((await read(binaryKey)).rows[0][0].text, '00ff61');
  assert.equal((await read('cache:string')).rows[0][0].text, '문자열 값');
  const expiring = await read('cache:ttl');
  assert.ok(expiring.ttl_ms > 0 && expiring.ttl_ms <= 180000);
  assert.ok(expiring.memory_bytes > 0);
  assert.equal((await read('no-longer-exists')).kind, 'none');
  assert.deepEqual((await read('cache:hash')).rows.map(row => row.map(cell => cell.text)), [['region', '서울']]);
  const set = await read('cache:set');
  assert.deepEqual(set.rows.map(row => row[0].text).sort(), ['alpha', 'beta']);
  assert.deepEqual((await read('cache:zset')).rows.map(row => row.map(cell => cell.text)), [['alpha', '1.25'], ['beta', '3.5']]);
  const list = await read('cache:list');
  assert.equal(list.rows.length, 32);
  assert.equal((await read('cache:list', list.next)).rows[0][0].text, 'entry-32');
  const stream = await read('cache:stream');
  assert.equal(stream.rows.length, 32);
  assert.equal((await read('cache:stream', stream.next)).rows[0][0].text, '33-0');
  const matching = new Set();
  do {
    const result = await scan(cursor, 'cache:*', 'hash');
    cursor = result.cursor;
    result.keys.forEach(key => matching.add(key.display.text));
  } while (cursor !== '0');
  assert.deepEqual([...matching], ['cache:hash']);
  await command('close_redis', { id });
  await assert.rejects(scan('0', '*'), /연결이 닫혔습니다/);

  await workspace.getByRole('button', { name: 'Redis 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'Redis 연결', exact: true });
  await login.getByLabel('Redis 암호').fill(secret);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  await workspace.getByText(/Redis 8\.4\.7 · DB 3 · TLS/).waitFor();
  const search = workspace.getByRole('region', { name: 'Redis 키 탐색', exact: true });
  await search.getByLabel('검색 패턴').fill('cache:list');
  await search.getByLabel('타입').selectOption('list');
  await search.getByRole('button', { name: '검색', exact: true }).click();
  const match = search.getByRole('button', { name: 'cache:list', exact: true });
  const next = search.getByRole('button', { name: '다음 키', exact: true });
  for (let step = 0; step < 10 && !(await match.count()); step++) {
    await Promise.race([match.waitFor({ timeout: 3000 }), page.waitForFunction(() => {
      const button = [...document.querySelectorAll('.redis-keys button')].find(item => item.textContent === '다음 키');
      return button && !button.disabled;
    }, undefined, { timeout: 3000 })]);
    if (!(await match.count())) await next.click();
  }
  await match.click();
  const detail = workspace.getByRole('region', { name: 'Redis 키 상세', exact: true });
  await detail.getByText('entry-0', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '다음 값', exact: true }).click();
  await detail.getByText('entry-32', { exact: true }).waitFor();
  secure.dropClients();
  await detail.getByRole('button', { name: '값 새로고침', exact: false }).click();
  await workspace.getByRole('alert').filter({ hasText: '연결이 끊겼습니다' }).waitFor();
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: 'Redis 캐시 검증 열기', exact: true }).click();
  await workspace.getByRole('button', { name: 'Redis 연결', exact: true }).waitFor();
  assert.deepEqual(errors, []);
}

async function main() {
  const port = await availablePort();
  const server = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--loglevel', 'warning'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const channel of [server.stdout, server.stderr]) channel.on('data', chunk => { log = (log + chunk).slice(-3000); });
  let browser;
  let secure;
  try {
    await ready(port, server);
    cli(port, [
      ['SET', 'db0:only', 'other'],
      ['SELECT', '3'],
      ['SET', binaryKey, Buffer.from([0, 255, 97])],
      ['SET', 'cache:string', '문자열 값'], ['SET', 'cache:ttl', 'temporary', 'PX', '180000'],
      ['HSET', 'cache:hash', 'region', '서울'], ['SADD', 'cache:set', 'alpha', 'beta'],
      ['ZADD', 'cache:zset', '1.25', 'alpha', '3.5', 'beta'],
      ['RPUSH', 'cache:list', ...Array.from({ length: 40 }, (_, index) => 'entry-' + index)],
      ...Array.from({ length: 34 }, (_, index) => ['XADD', 'cache:stream', (index + 1) + '-0', 'status', 'ready']),
      ...Array.from({ length: 330 }, (_, index) => ['SET', 'noise:' + index, 'fixture']),
      ['ACL', 'SETUSER', 'fixture_reader', 'on', '>' + secret, '~*', '+info', '+select', '+scan', '+dbsize', '+type',
        '+pttl', '+memory|usage', '+strlen', '+getrange', '+llen', '+lrange', '+zcard', '+zrange', '+hlen', '+hscan', '+scard',
        '+sscan', '+xlen', '+xrange'],
    ]);
    secure = await proxy(port);
    browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
    await verify(browser, port, secure);
    console.log('Windows Redis E2E passed (ACL, TLS hostname, logical DB, cursors, six value types, binary keys and disconnect).');
  } catch (error) {
    if (server.exitCode !== null) console.error(log);
    throw error;
  } finally {
    if (browser) await browser.close();
    secure?.close();
    if (server.exitCode === null) server.kill();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
