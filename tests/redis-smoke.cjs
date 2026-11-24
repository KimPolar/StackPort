const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const { Transform } = require('node:stream');
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
  let interruptExec = false;
  const listener = tls.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key), minVersion: 'TLSv1.2' }, client => {
    clients.add(client);
    const target = net.connect(port, '127.0.0.1');
    client.on('error', () => target.destroy());
    target.on('error', () => client.destroy());
    client.on('close', () => { clients.delete(client); target.destroy(); });
    target.on('close', () => client.destroy());
    const relay = new Transform({
      transform(chunk, _encoding, callback) {
        if (interruptExec && chunk.includes(Buffer.from('$4\r\nEXEC\r\n'))) {
          interruptExec = false;
          client.destroy();
          target.destroy();
          callback();
        } else callback(null, chunk);
      },
    });
    client.pipe(relay).pipe(target).pipe(client);
  }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const dropClients = () => { for (const client of clients) client.destroy(); };
  return { port: listener.address().port, ca, dropClients, interruptNextExec: () => { interruptExec = true; },
    close: () => { dropClients(); listener.close(); } };
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
  const open = (item, password = secret, confirmation = 'PROD', allowEdits) => command('open_redis', {
    profileId: item.id, revision: item.revision, password, confirmation, allowEdits,
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
  await assert.rejects(command('preview_redis_edit', { id, key: keyId('edit:string'), input: {
    kind: 'string', value: { encoding: 'utf8', text: 'not submitted' },
  } }), /편집을 허용/);
  await command('close_redis', { id });
  await assert.rejects(scan('0', '*'), /연결이 닫혔습니다/);
  const writer = await alternate('편집 검증', { username: 'fixture_writer' });
  await verifyEdits({ command, open, profile, writer, serverPort, secure });

  await workspace.getByRole('button', { name: 'Redis 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'Redis 연결', exact: true });
  await login.getByLabel('Redis 암호').fill(secret);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  await workspace.getByText(/Redis 8\.4\.7 · DB 3 · TLS/).waitFor();
  await findKey(page, workspace, 'cache:list', 'list');
  const detail = workspace.getByRole('region', { name: 'Redis 키 상세', exact: true });
  await detail.getByText('entry-0', { exact: true }).waitFor();
  assert.equal(await detail.getByRole('button', { name: '값 편집', exact: true }).count(), 0);
  await detail.getByRole('button', { name: '다음 값', exact: true }).click();
  await detail.getByText('entry-32', { exact: true }).waitFor();
  secure.dropClients();
  await detail.getByRole('button', { name: '값 새로고침', exact: false }).click();
  await workspace.getByRole('alert').filter({ hasText: '연결이 끊겼습니다' }).waitFor();
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: 'Redis 캐시 검증 열기', exact: true }).click();
  await workspace.getByRole('button', { name: 'Redis 연결', exact: true }).waitFor();
  await verifyEditDialog(page, workspace);
  assert.deepEqual(errors, []);
}

async function findKey(page, workspace, key, kind) {
  const search = workspace.getByRole('region', { name: 'Redis 키 탐색', exact: true });
  await search.getByLabel('검색 패턴').fill(key);
  await search.getByLabel('타입').selectOption(kind);
  await search.getByRole('button', { name: '검색', exact: true }).click();
  const match = search.getByRole('button', { name: key, exact: true });
  const next = search.getByRole('button', { name: '다음 키', exact: true });
  for (let step = 0; step < 10 && !(await match.count()); step++) {
    await Promise.race([match.waitFor({ timeout: 3000 }), page.waitForFunction(() => {
      const button = [...document.querySelectorAll('.redis-keys button')].find(item => item.textContent === '다음 키');
      return button && !button.disabled;
    }, undefined, { timeout: 3000 })]);
    if (!(await match.count())) await next.click();
  }
  await match.click();
}

async function verifyEditDialog(page, workspace) {
  await page.getByRole('button', { name: 'Redis 편집 검증 열기', exact: true }).click();
  await workspace.getByRole('button', { name: 'Redis 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'Redis 연결', exact: true });
  await login.getByLabel('Redis 암호').fill(secret);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByLabel('이 연결에서 키 편집 허용').check();
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  await findKey(page, workspace, 'edit:string', 'string');
  const detail = workspace.getByRole('region', { name: 'Redis 키 상세', exact: true });
  await detail.getByRole('button', { name: '값 편집', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Redis 키 편집', exact: true });
  await editor.getByRole('textbox', { name: '새 값', exact: true }).fill('화면에서 적용한 값');
  await editor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  const review = editor.getByRole('table', { name: 'Redis 변경 내용', exact: true });
  await review.getByText(/00ff61/).waitFor();
  await review.getByText('화면에서 적용한 값', { exact: true }).waitFor();
  const apply = editor.getByRole('button', { name: '변경 적용', exact: true });
  assert.equal(await apply.isDisabled(), true);
  await editor.getByLabel('운영 환경 확인').fill('PROD');
  await apply.click();
  await editor.waitFor({ state: 'detached' });
  await detail.getByRole('status').getByText('Redis 변경 완료', { exact: true }).waitFor();
  await detail.getByRole('table', { name: 'Redis 값', exact: true }).getByText('화면에서 적용한 값', { exact: true }).waitFor();
}

async function verifyEdits({ command, open, profile, writer, serverPort, secure }) {
  const text = text => ({ encoding: 'utf8', text });
  const hex = text => ({ encoding: 'hex', text });
  const preview = (id, key, input) => command('preview_redis_edit', { id, key: keyId(key), input });
  const apply = (id, plan, confirmation = 'PROD') => command('apply_redis_edit', { id, token: plan.token, confirmation });
  const value = (id, key) => command('redis_value', { id, input: { key: keyId(key), position: null } });
  const fields = ({ rows }) => rows.map(row => row.map(cell => cell.text));
  const readOnly = await open(profile, secret, 'PROD', true);
  const denied = await preview(readOnly.id, 'edit:string', { kind: 'string', value: text('권한 없는 변경') });
  await assert.rejects(apply(readOnly.id, denied), /권한/);
  assert.deepEqual(fields(await value(readOnly.id, 'edit:string')), [['처음 값']]);
  await command('close_redis', { id: readOnly.id });

  const { id } = await open(writer, secret, 'PROD', true);
  const mutation = { kind: 'string', value: hex('00 ff 61') };
  await assert.rejects(preview(id, 'edit:string', { kind: 'string', value: hex('+1') }), /0–9/);
  const first = await preview(id, 'edit:string', mutation);
  assert.equal(first.changes[0].before.text, '처음 값');
  assert.equal(first.changes[0].after.text, '00ff61');
  await assert.rejects(apply(id, first, ''), /PROD/);
  assert.deepEqual(fields(await value(id, 'edit:string')), [['처음 값']]);
  cli(serverPort, [['SELECT', '3'], ['SET', 'edit:string', '다른 클라이언트', 'KEEPTTL']]);
  assert.equal((await apply(id, first)).status, 'conflict');
  await assert.rejects(apply(id, first), /사용되었습니다/);
  assert.deepEqual(fields(await value(id, 'edit:string')), [['다른 클라이언트']]);
  const second = await preview(id, 'edit:string', mutation);
  assert.equal(second.changes[0].before.text, '다른 클라이언트');
  assert.equal((await apply(id, second)).status, 'applied');
  const current = await value(id, 'edit:string');
  assert.ok(current.ttl_ms > 0 && current.ttl_ms <= second.ttl_ms);
  assert.deepEqual(fields(current), [['00ff61']]);

  const edit = async (key, change) => {
    const result = await apply(id, await preview(id, key, change));
    assert.equal(result.status, 'applied');
    return result;
  };
  await edit('edit:hash', { kind: 'hash', field: text('region'), value: text('부산') });
  assert.deepEqual(fields(await value(id, 'edit:hash')), [['region', '부산']]);
  await edit('edit:list', { kind: 'list', index: '-1', value: text('last replaced') });
  assert.deepEqual(fields(await value(id, 'edit:list')), [['first'], ['last replaced']]);
  await edit('edit:set', { kind: 'set', member: hex('FF AA') });
  assert.ok(fields(await value(id, 'edit:set')).some(row => row[0] === 'ffaa'));
  await edit('edit:zset', { kind: 'zset', member: text('alpha'), score: '7.5' });
  assert.deepEqual(fields(await value(id, 'edit:zset')), [['alpha', '7.5']]);
  await edit('edit:zset', { kind: 'zset', member: text('alpha'), score: '+inf' });
  assert.match(fields(await value(id, 'edit:zset'))[0][1], /^\+?inf$/);
  const stream = await edit('edit:stream', { kind: 'stream', fields: [
    { field: text('state'), value: text('updated') }, { field: text('code'), value: hex('ff') },
  ] });
  assert.ok(stream.entry_id);
  assert.deepEqual(fields(await value(id, 'edit:stream')).filter(row => row[0] === stream.entry_id),
    [[stream.entry_id, 'state', 'updated'], [stream.entry_id, 'code', 'ff']]);
  await assert.rejects(preview(id, 'edit:set', { kind: 'set', member: hex('FF AA') }), /이미 같은 멤버/);
  const cancelled = await preview(id, 'edit:string', { kind: 'string', value: text('discarded') });
  await command('discard_redis_edit', { id, token: cancelled.token });
  await assert.rejects(apply(id, cancelled), /사용되었습니다/);
  cli(serverPort, [['SELECT', '3'], ['SET', 'edit:expiring', 'expires after review', 'PX', '2000']]);
  const expiring = await preview(id, 'edit:expiring', { kind: 'string', value: text('must stay expired') });
  assert.ok(expiring.ttl_ms > 0);
  await delay(expiring.ttl_ms + 80);
  assert.equal((await apply(id, expiring)).status, 'conflict');
  assert.equal((await value(id, 'edit:expiring')).kind, 'none');
  const unknown = await preview(id, 'edit:string', { kind: 'string', value: text('unknown result') });
  secure.interruptNextExec();
  await assert.rejects(apply(id, unknown), /변경 결과를 확인할 수 없습니다/);
  const events = (await command('list_audit_events', { before: null })).events.filter(event => event.operation.startsWith('redis.key.edit'));
  assert.ok(events.some(event => event.outcome === 'succeeded' && event.environment === 'PROD'));
  assert.ok(events.some(event => event.outcome === 'failed'));
  assert.ok(events.some(event => event.operation === 'redis.key.edit.unconfirmed' && event.outcome === 'started'));
  assert.doesNotMatch(JSON.stringify(events), /다른 클라이언트|00ff61|stackport-redis-fixture-password/);
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
      ['SET', 'edit:string', '처음 값', 'PX', '180000'],
      ['HSET', 'edit:hash', 'region', '서울'], ['RPUSH', 'edit:list', 'first', 'last'],
      ['SADD', 'edit:set', 'initial'], ['ZADD', 'edit:zset', '1.5', 'alpha'],
      ['XADD', 'edit:stream', '1-0', 'state', 'initial'],
      ['RPUSH', 'cache:list', ...Array.from({ length: 40 }, (_, index) => 'entry-' + index)],
      ...Array.from({ length: 34 }, (_, index) => ['XADD', 'cache:stream', (index + 1) + '-0', 'status', 'ready']),
      ...Array.from({ length: 330 }, (_, index) => ['SET', 'noise:' + index, 'fixture']),
      ['ACL', 'SETUSER', 'fixture_reader', 'on', '>' + secret, '~*', '+info', '+select', '+scan', '+dbsize', '+type',
        '+pttl', '+memory|usage', '+strlen', '+getrange', '+llen', '+lrange', '+zcard', '+zrange', '+hlen', '+hscan', '+scard',
        '+sscan', '+xlen', '+xrange', '+watch', '+unwatch', '+multi', '+exec', '+discard'],
      ['ACL', 'SETUSER', 'fixture_writer', 'on', '>' + secret, '~*',
        '+@read', '-keys', '+info', '+select', '+dbsize', '+memory|usage', '+watch', '+unwatch', '+multi', '+exec', '+discard',
        '+set', '+hset', '+lset', '+sadd', '+zadd', '+xadd'],
    ]);
    secure = await proxy(port);
    browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
    await verify(browser, port, secure);
    console.log('Windows Redis E2E passed (ACL, TLS, cursor browsing, six typed edits, expiry, conflicts and unknown writes).');
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
