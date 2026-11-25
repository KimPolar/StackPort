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
const { chooseDatabase } = require('./database-picker.cjs');

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

function jsonAvailable(port) {
  const result = execFileSync(path.join(path.dirname(binary), 'redis-cli.exe'),
    ['-h', '127.0.0.1', '-p', String(port), '--raw', 'COMMAND', 'INFO', 'JSON.GET', 'JSON.SET'], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 12_000,
    });
  const commands = result.toLowerCase().split(/\r?\n/);
  return commands.includes('json.get') && commands.includes('json.set');
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

async function verifyReplica({ command, open, alternate, serverPort }) {
  const port = await availablePort();
  const directory = path.join(root, 'replica');
  fs.mkdirSync(directory);
  const replica = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
    '--replicaof', '127.0.0.1', String(serverPort)], { cwd: directory, windowsHide: true, stdio: 'ignore' });
  try {
    await ready(port, replica);
    const fixture = await alternate('복제본 모니터', { host: '127.0.0.1', port, tls: false, ca_path: null, username: '', environment: 'DEV' });
    const { id } = await open(fixture, '', '');
    try {
      let snapshot;
      for (let attempt = 0; attempt < 40; attempt++) {
        snapshot = await command('redis_server_snapshot', { id });
        if (snapshot.upstream_link && snapshot.keyspace.some(database => database.database === 3)) break;
        await delay(250);
      }
      assert.equal(snapshot.role, 'replica');
      assert.equal(snapshot.upstream_link, true);
      assert.ok(snapshot.keyspace.find(database => database.database === 3).keys > 300);
    } finally {
      await command('close_redis', { id });
    }
  } finally {
    if (replica.exitCode === null) replica.kill();
  }
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
  const subscribers = new Set();
  let interruptCommand = null;
  let blockSubscriptions = false;
  const listener = tls.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key), minVersion: 'TLSv1.2' }, client => {
    clients.add(client);
    const target = net.connect(port, '127.0.0.1');
    client.on('error', () => target.destroy());
    target.on('error', () => client.destroy());
    client.on('close', () => { clients.delete(client); subscribers.delete(client); target.destroy(); });
    target.on('close', () => client.destroy());
    const relay = new Transform({
      transform(chunk, _encoding, callback) {
        if (chunk.includes(Buffer.from('$9\r\nSUBSCRIBE\r\n')) || chunk.includes(Buffer.from('$10\r\nPSUBSCRIBE\r\n'))) {
          if (blockSubscriptions) {
            client.destroy();
            target.destroy();
            callback();
            return;
          }
          subscribers.add(client);
        }
        if (interruptCommand && chunk.includes(interruptCommand)) {
          interruptCommand = null;
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
  return { port: listener.address().port, ca, dropClients,
    pauseSubscriptions: () => { blockSubscriptions = true; for (const client of subscribers) client.destroy(); },
    resumeSubscriptions: () => { blockSubscriptions = false; },
    subscriptionCount: () => subscribers.size,
    interruptNextExec: () => { interruptCommand = Buffer.from('$4\r\nEXEC\r\n'); },
    interruptNextPublish: () => { interruptCommand = Buffer.from('$7\r\nPUBLISH\r\n'); },
    close: () => { dropClients(); listener.close(); } };
}

async function verify(browser, serverPort, secure, hasJson) {
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const project = await command('create_project', { name: 'Redis 검증' });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await chooseDatabase(page, 'Redis');
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
  const open = (item, password = secret, confirmation = 'PROD', allowEdits, allowPublish) => command('open_redis', {
    profileId: item.id, revision: item.revision, password, confirmation, allowEdits, allowPublish,
  });
  const alternate = (name, change) => command('create_redis_profile', { projectId: project.id, input: { ...profile.settings, ...change, name } });
  await assert.rejects(open(profile, secret, ''), /PROD/);
  await assert.rejects(open(profile, 'wrong-redis-password'), /사용자 또는 암호/);
  const wrongHost = await alternate('잘못된 호스트', { host: '127.0.0.1' });
  await assert.rejects(open(wrongHost), /TLS 인증서/);
  const plain = await alternate('일반 TCP', { host: '127.0.0.1', port: serverPort, tls: false, ca_path: null, username: '', environment: 'DEV' });
  const plainSession = await open(plain, '', '');
  assert.equal(plainSession.json_support, hasJson ? 'read_write' : 'unavailable');
  await assert.rejects(command('redis_run_console', { id: plainSession.id, line: 'FLUSHALL' }), /데이터를 삭제/);
  const retained = await command('redis_run_console', { id: plainSession.id, line: 'GET cache:string' });
  assert.equal(retained.reply.kind, 'bulk');
  assert.equal(retained.reply.value.text, '문자열 값');
  await command('close_redis', { id: plainSession.id });

  const { id, json_support: restrictedJsonSupport } = await open(profile);
  assert.equal(restrictedJsonSupport, 'unknown');
  const monitor = await command('redis_server_snapshot', { id });
  assert.ok(monitor.used_memory > 0 && monitor.peak_memory >= monitor.used_memory);
  assert.ok(monitor.connected_clients >= 1);
  assert.equal(monitor.role, 'primary');
  assert.equal(monitor.connected_replicas, 0);
  assert.equal(monitor.upstream_link, null);
  assert.equal(monitor.keyspace.find(item => item.database === 0).keys, 1);
  const selectedDb = monitor.keyspace.find(item => item.database === 3);
  assert.ok(selectedDb.keys > 300 && selectedDb.expiring >= 2);
  assert.deepEqual(monitor.slow_log, { status: 'unavailable', reason: '현재 Redis 역할에 이 명령의 권한이 없습니다.' });
  await verifyConsole(command, id);
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
  const logSession = await open(writer);
  const withLog = await command('redis_server_snapshot', { id: logSession.id });
  assert.equal(withLog.slow_log.status, 'available');
  assert.ok(withLog.slow_log.entries.length <= 20);
  assert.ok(withLog.slow_log.entries.some(entry => entry.command === 'SET' && entry.duration_us >= 0));
  assert.doesNotMatch(JSON.stringify(withLog.slow_log), /example-private-slowlog-payload|db0:only|127\.0\.0\.1/);
  await command('close_redis', { id: logSession.id });
  await verifyReplica({ command, open, alternate, serverPort });
  await verifyPubSub({ command, open, profile, writer, secure, serverPort });
  await verifyEdits({ command, open, profile, writer, serverPort, secure });
  await verifyKeyLifecycle({ command, open, profile, writer, serverPort, secure });

  await workspace.getByRole('button', { name: 'Redis 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'Redis 연결', exact: true });
  await login.getByLabel('Redis 암호').fill(secret);
  await login.getByLabel('운영 환경 확인').fill('PROD');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  await workspace.getByText(/Redis .* · DB 3 · TLS · JSON 지원 미확인/).waitFor();
  assert.equal(await workspace.getByLabel('타입', { exact: true }).getByRole('option', { name: 'JSON', exact: true }).count(), 0);
  await workspace.getByRole('button', { name: '서버 모니터', exact: true }).click();
  const monitorDialog = page.getByRole('dialog', { name: 'Redis 서버 모니터', exact: true });
  await monitorDialog.getByText('사용 메모리', { exact: true }).waitFor();
  await monitorDialog.getByRole('row').filter({ hasText: '현재 DB' }).getByText('현재 DB', { exact: true }).waitFor();
  await monitorDialog.getByText(/현재 Redis 역할에 이 명령의 권한이 없습니다/).waitFor();
  const db0 = monitorDialog.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '0', exact: true }) });
  assert.equal(await db0.getByRole('cell').first().textContent(), '1');
  cli(serverPort, [['SET', 'db0:monitor-refresh', 'fixture']]);
  await monitorDialog.getByRole('button', { name: '새로 고침', exact: true }).click();
  await db0.getByRole('cell', { name: '2', exact: true }).waitFor();
  await monitorDialog.getByRole('button', { name: '닫기', exact: true }).click();
  await monitorDialog.waitFor({ state: 'detached' });
  await verifyConsoleDialog(page, workspace);
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
  await verifyKeyLifecycleDialog(page, workspace);
  await verifyPubSubDialog(page, workspace, secure);
  await page.getByRole('button', { name: '작업 기록', exact: true }).click();
  await page.getByRole('heading', { name: '작업 기록', exact: true }).waitFor();
  await page.getByText('Redis 키 삭제', { exact: true }).first().waitFor();
  await page.getByText('Redis 키 삭제 결과 미확인', { exact: true }).waitFor();
  if (hasJson) await verifyJson({ page, command, open, plain, serverPort });
  assert.deepEqual(errors, []);
}

async function verifyJson({ page, command, open, plain, serverPort }) {
  const key = 'json:typed';
  const original = '{"large":9007199254740993,"nested":[true,null]}';
  const edited = '{"large":9007199254740995,"nested":[false,null]}';
  const concurrent = '{"concurrent":true}';
  const { id } = await open(plain, '', '', true);
  const read = name => command('redis_value', { id, input: { key: keyId(name), position: null } });
  const preview = (before, document) => command('preview_redis_edit', {
    id, key: keyId(key), input: { kind: 'json', original: before, document },
  });
  try {
    assert.equal((await read(key)).rows[0][0].text, original);
    assert.equal((await read('json:large')).rows[0][0].truncated, true);
    await assert.rejects(preview(original, '{"incomplete":'), /올바른 Redis JSON/);
    await assert.rejects(preview('null', edited), /JSON 문서가 바뀌었습니다/);
    const plan = await preview(original, edited);
    cli(serverPort, [['SELECT', '3'], ['JSON.SET', key, '.', concurrent]]);
    const result = await command('apply_redis_edit', { id, token: plan.token, confirmation: '' });
    assert.equal(result.status, 'conflict');
    assert.equal((await read(key)).rows[0][0].text, concurrent);

    await page.getByRole('button', { name: 'Redis 일반 TCP 열기', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Redis 작업 공간', exact: true });
    await workspace.getByRole('button', { name: 'Redis 연결', exact: true }).click();
    const login = page.getByRole('dialog', { name: 'Redis 연결', exact: true });
    await login.getByRole('checkbox', { name: /키 편집/ }).check();
    await login.getByRole('button', { name: '연결', exact: true }).click();
    await workspace.getByText(/JSON 조회·편집 지원/).waitFor();
    await findKey(page, workspace, key, 'json');
    const detail = workspace.getByRole('region', { name: 'Redis 키 상세', exact: true });
    await detail.getByText(concurrent, { exact: true }).waitFor();
    await detail.getByRole('button', { name: '값 편집', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Redis 키 편집', exact: true });
    const input = editor.getByLabel('JSON 문서', { exact: true });
    assert.equal(await input.inputValue(), concurrent);
    await input.fill(edited);
    await editor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    await editor.getByText(edited, { exact: true }).waitFor();
    await editor.getByRole('button', { name: '변경 적용', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    await detail.getByText(edited, { exact: true }).waitFor();
    const stored = await read(key);
    assert.equal(stored.rows[0][0].text, edited);
    assert.ok(stored.ttl_ms > 0 && stored.ttl_ms <= 600000);
    await workspace.getByRole('button', { name: 'Redis 연결 끊기', exact: true }).click();
  } finally {
    await command('close_redis', { id });
  }
}

async function verifyConsole(command, id) {
  const catalog = await command('redis_console_commands');
  assert.ok(catalog.some(entry => entry.name === 'TYPE' && entry.warning === null));
  assert.ok(catalog.some(entry => entry.name === 'FLUSHDB' && entry.warning.includes('삭제')));
  const run = line => command('redis_run_console', { id, line });
  const status = await run('ping');
  assert.equal(status.reply.kind, 'simple');
  assert.equal(status.reply.value.text, 'PONG');
  const count = await run('DBSIZE');
  assert.equal(count.reply.kind, 'integer');
  assert.ok(Number(count.reply.value) > 300);

  const values = await run(String.raw`MGET "console:space key" "\x00\xff\x2a\x0d\x0a" "cache:missing"`);
  assert.equal(values.reply.kind, 'array');
  assert.deepEqual(values.reply.items.map(item => [item.kind, item.value?.encoding, item.value?.text]), [
    ['bulk', 'utf8', 'quoted-key-value'], ['bulk', 'hex', '00ff61'], ['null', undefined, undefined],
  ]);
  const stream = await run('XRANGE cache:stream - + COUNT 2');
  assert.equal(stream.reply.items.length, 2);
  assert.equal(stream.reply.items[0].items[0].value.text, '1-0');
  assert.equal(stream.reply.items[1].items[1].items[0].value.text, 'status');
  const bounded = await run('LRANGE console:wide 0 -1');
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.reply.length, 310);
  assert.equal(bounded.reply.items.length, 255);

  await assert.rejects(run('FLUSHDB ASYNC'), /데이터를 삭제/);
  await assert.rejects(run('CONFIG GET requirepass'), /서버 상태/);
  await assert.rejects(run('GET cache:string\nFLUSHDB'), /한 줄/);
  await assert.rejects(run('ECHO "no echo permission"'), /권한/);
  assert.equal((await run('GET cache:string')).reply.value.text, '문자열 값');
}

async function verifyConsoleDialog(page, workspace) {
  const open = workspace.getByRole('button', { name: '명령 콘솔', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Redis 명령 콘솔', exact: true });
  await open.click();
  const prompt = dialog.getByRole('textbox', { name: 'Redis 명령', exact: true });
  const run = dialog.getByRole('button', { name: '실행', exact: true });
  const output = dialog.getByRole('region', { name: 'Redis 응답 본문', exact: true });
  const close = dialog.getByRole('button', { name: '닫기', exact: true });
  await prompt.fill('typ');
  await dialog.getByRole('group', { name: '명령 자동 완성', exact: true }).getByRole('button', { name: 'TYPE', exact: true }).waitFor();
  await prompt.press('Tab');
  assert.equal(await prompt.inputValue(), 'TYPE ');
  await prompt.fill('TYPE cache:list');
  await prompt.press('Enter');
  await output.getByText('단순 문자열 · UTF8', { exact: true }).waitFor();
  await output.getByText('list', { exact: true }).waitFor();
  await prompt.press('ArrowUp');
  assert.equal(await prompt.inputValue(), 'TYPE cache:list');
  await prompt.press('ArrowDown');
  assert.equal(await prompt.inputValue(), '');
  await prompt.fill('FLUSHDB');
  await dialog.getByText(/데이터를 삭제하는 명령/).waitFor();
  assert.equal(await run.isDisabled(), true);
  await close.click();
  await dialog.waitFor({ state: 'detached' });
  await open.click();
  await output.getByText('list', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '기록 비우기', exact: true }).click();
  await output.waitFor({ state: 'detached' });
  await close.click();
  await dialog.waitFor({ state: 'detached' });
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
  await login.getByLabel('이 연결에서 메시지 발행 허용').check();
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

async function verifyKeyLifecycleDialog(page, workspace) {
  const detail = workspace.getByRole('region', { name: 'Redis 키 상세', exact: true });
  await findKey(page, workspace, 'lifecycle:screen-ttl', 'string');
  await detail.getByText('screen-ttl-value', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '만료 설정', exact: true }).click();
  const ttl = page.getByRole('dialog', { name: 'Redis 만료 설정', exact: true });
  await ttl.getByLabel('만료까지 남은 시간 (초)').fill('90');
  await ttl.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await ttl.getByText('90초', { exact: true }).waitFor();
  const apply = ttl.getByRole('button', { name: '변경 적용', exact: true });
  assert.equal(await apply.isDisabled(), true);
  await ttl.getByLabel('운영 환경 확인').fill('PROD');
  await apply.click();
  await ttl.waitFor({ state: 'detached' });
  await detail.getByText(/ms$/).waitFor();

  await findKey(page, workspace, 'lifecycle:screen-delete', 'string');
  const keys = workspace.getByRole('region', { name: 'Redis 키 탐색', exact: true });
  await keys.getByRole('button', { name: '키 선택', exact: true }).click();
  await keys.getByRole('checkbox', { name: 'lifecycle:screen-delete 선택', exact: true }).check();
  await keys.getByRole('button', { name: '선택 키 삭제', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Redis 키 삭제', exact: true });
  await dialog.getByRole('button', { name: '삭제 미리보기', exact: true }).click();
  await dialog.getByRole('region', { name: '삭제 대상 Redis 키', exact: true }).getByText('lifecycle:screen-delete', { exact: true }).waitFor();
  const remove = dialog.getByRole('button', { name: '키 삭제 적용', exact: true });
  await dialog.getByLabel('키 삭제 확인').fill('DELETE');
  assert.equal(await remove.isDisabled(), true);
  await dialog.getByLabel('운영 환경 확인').fill('PROD');
  await remove.click();
  await dialog.waitFor({ state: 'detached' });
  await detail.getByText('Redis 키 1개를 삭제했습니다.', { exact: true }).waitFor();
}

async function eventually(read, passes) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await read();
    if (passes(value)) return value;
    await delay(50);
  }
  assert.fail('The expected Redis Pub/Sub state did not arrive.');
}

async function verifyPubSub({ command, open, profile, writer, secure, serverPort }) {
  const start = (id, name, pattern = false, password = secret, confirmation = 'PROD') => command('redis_start_subscription', {
    id, name, pattern, password, confirmation,
  });
  const publish = (id, message, confirmed = true, confirmation = 'PROD') => command('redis_publish_message', {
    id, channel: 'events:operator', message, confirmed, confirmation,
  });
  const reader = await open(profile);
  await assert.rejects(start(reader.id, 'events:operator'), /권한/);
  await assert.rejects(publish(reader.id, 'read-only-should-fail'), /발행을 허용/);
  await command('close_redis', { id: reader.id });

  const { id } = await open(writer, secret, 'PROD', false, true);
  await assert.rejects(start(id, 'events:*', true, secret, ''), /PROD/);
  await assert.rejects(start(id, 'events:*', true, 'wrong-password'), /사용자 또는 암호/);
  await assert.rejects(start(id, 'outside:*', true), /권한/);
  const subscription = await start(id, 'events:*', true);
  await assert.rejects(start(id, 'events:second'), /기존 Redis 구독/);
  const snapshot = () => command('redis_subscription_snapshot', { id, subscription });
  assert.equal((await snapshot()).status, 'subscribed');
  await assert.rejects(publish(id, 'unconfirmed-should-fail', false), /발행 내용을 확인/);
  await assert.rejects(publish(id, 'prod-should-fail', true, ''), /PROD/);
  const delivered = await publish(id, 'private-fixture-message');
  assert.deepEqual(delivered, { receivers: 1, audit_warning: false });
  cli(serverPort, [['PUBLISH', 'events:binary', Buffer.from([0, 255, 97])]]);
  const received = await eventually(snapshot, result => result.messages.length === 2);
  assert.deepEqual(received.messages.map(item => [item.channel.text, item.payload.text, item.payload.encoding]),
    [['events:operator', 'private-fixture-message', 'utf8'], ['events:binary', '00ff61', 'hex']]);
  cli(serverPort, Array.from({ length: 102 }, (_, index) => ['PUBLISH', 'events:history', 'history-' + index]));
  const bounded = await eventually(snapshot, result => result.messages.at(-1)?.payload.text === 'history-101');
  assert.equal(bounded.messages.length, 100);
  assert.equal(bounded.evicted, 4);
  await command('redis_clear_subscription_history', { id, subscription });
  assert.deepEqual((await snapshot()).messages, []);
  secure.pauseSubscriptions();
  await eventually(snapshot, result => result.status === 'reconnecting' && result.interruptions === 1);
  assert.equal((await publish(id, 'during-interruption')).receivers, 0);
  secure.resumeSubscriptions();
  await eventually(snapshot, result => result.status === 'subscribed' && result.interruptions === 1);
  assert.equal((await publish(id, 'after-reconnect')).receivers, 1);
  const resumed = await eventually(snapshot, result => result.messages.length === 1);
  assert.equal(resumed.messages[0].payload.text, 'after-reconnect');
  await command('redis_stop_subscription', { id, subscription });
  await assert.rejects(snapshot(), /구독이 종료/);
  await eventually(async () => secure.subscriptionCount(), count => count === 0);

  secure.interruptNextPublish();
  await assert.rejects(publish(id, 'interrupted-publish'), /발행 결과를 확인할 수 없습니다/);
  const events = (await command('list_audit_events', { before: null })).events.filter(event => event.operation.startsWith('redis.pubsub.publish'));
  assert.ok(events.some(event => event.outcome === 'succeeded' && event.environment === 'PROD'));
  assert.ok(events.some(event => event.operation === 'redis.pubsub.publish.unconfirmed' && event.outcome === 'started'));
  assert.doesNotMatch(JSON.stringify(events), /events:operator|private-fixture-message|interrupted-publish|stackport-redis-fixture-password/);
}

async function verifyPubSubDialog(page, workspace, secure) {
  await workspace.getByRole('button', { name: 'Pub/Sub', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Redis Pub/Sub', exact: true });
  await dialog.getByLabel('구독 채널', { exact: true }).fill('events:screen');
  await dialog.getByLabel('구독 연결 암호').fill(secret);
  await dialog.getByLabel('구독 운영 환경 확인').fill('PROD');
  await dialog.getByRole('button', { name: '구독 시작', exact: true }).click();
  await dialog.getByText('구독 중', { exact: true }).waitFor();
  await dialog.getByLabel('발행 채널').fill('events:screen');
  await dialog.getByLabel('발행 메시지').fill('화면에서 보낸 메시지');
  await dialog.getByRole('button', { name: '발행 미리 보기', exact: true }).click();
  await dialog.getByRole('heading', { name: '발행 내용 확인', exact: true }).waitFor();
  const send = dialog.getByRole('button', { name: '메시지 발행', exact: true });
  assert.equal(await send.isDisabled(), true);
  await dialog.getByLabel('발행 운영 환경 확인').fill('PROD');
  await send.click();
  await dialog.getByText(/발행 완료.*수신 1건/).waitFor();
  const history = dialog.getByRole('region', { name: 'Redis 수신 메시지 목록', exact: true });
  await history.getByText('화면에서 보낸 메시지', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '기록 비우기', exact: true }).click();
  await history.waitFor({ state: 'detached' });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await eventually(async () => secure.subscriptionCount(), count => count === 0);
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

async function verifyKeyLifecycle({ command, open, profile, writer, serverPort, secure }) {
  const edit = (id, key, milliseconds) => command('preview_redis_edit', { id, key: keyId(key), input: { kind: 'ttl', milliseconds } });
  const previewDeletion = (id, keys) => command('preview_redis_key_delete', { id, keys: keys.map(keyId) });
  const applyEdit = (id, token) => command('apply_redis_edit', { id, token, confirmation: 'PROD' });
  const applyDelete = (id, token, approval = 'DELETE', confirmation = 'PROD') => command('apply_redis_key_delete', { id, token, approval, confirmation });
  const read = (id, name) => command('redis_value', { id, input: { key: keyId(name), position: null } });

  const limited = await open(profile, secret, 'PROD', true);
  const denied = await previewDeletion(limited.id, ['lifecycle:keep']);
  await assert.rejects(applyDelete(limited.id, denied.token), /권한/);
  assert.equal((await read(limited.id, 'lifecycle:keep')).kind, 'string');
  await command('close_redis', { id: limited.id });

  const { id } = await open(writer, secret, 'PROD', true);
  const ttlKey = 'lifecycle:ttl';
  await assert.rejects(edit(id, ttlKey, '0'), /1ms 이상/);
  await assert.rejects(edit(id, ttlKey, null), /설정되어 있지 않습니다/);
  const expiration = await edit(id, ttlKey, '120000');
  assert.equal(expiration.ttl_ms, null);
  assert.equal(expiration.next_ttl_ms, 120000);
  assert.equal((await read(id, ttlKey)).ttl_ms, null);
  await assert.rejects(applyDelete(id, expiration.token), /다시 미리 보세요/);
  assert.equal((await applyEdit(id, expiration.token)).status, 'applied');
  const expiring = await read(id, ttlKey);
  assert.ok(expiring.ttl_ms > 0 && expiring.ttl_ms <= 120000);
  const persistence = await edit(id, ttlKey, null);
  assert.ok(persistence.ttl_ms > 0);
  assert.equal(persistence.next_ttl_ms, null);
  assert.equal((await applyEdit(id, persistence.token)).status, 'applied');
  const persisted = await read(id, ttlKey);
  assert.equal(persisted.ttl_ms, null);
  assert.equal(persisted.rows[0][0].text, 'ttl-value');
  const competingTtl = await edit(id, ttlKey, '120000');
  cli(serverPort, [['SELECT', '3'], ['PEXPIRE', ttlKey, '300000']]);
  assert.equal((await applyEdit(id, competingTtl.token)).status, 'conflict');
  assert.ok((await read(id, ttlKey)).ttl_ms > 120000);

  const keep = 'lifecycle:keep';
  const changing = 'lifecycle:changing';
  await assert.rejects(previewDeletion(id, Array(51).fill(keep)), /1~50개/);
  await assert.rejects(previewDeletion(id, [keep, keep]), /중복/);
  await assert.rejects(previewDeletion(id, [keep, 'lifecycle:missing']), /사라졌습니다/);
  const conflict = await previewDeletion(id, [keep, changing]);
  cli(serverPort, [['SELECT', '3'], ['SET', changing, 'modified after review']]);
  assert.equal((await applyDelete(id, conflict.token)).status, 'conflict');
  assert.equal((await read(id, keep)).kind, 'string');
  assert.equal((await read(id, changing)).rows[0][0].text, 'modified after review');

  cli(serverPort, [['SELECT', '3'], ['SET', 'lifecycle:expiring', 'fixture', 'PX', '2200']]);
  const expired = await previewDeletion(id, [keep, 'lifecycle:expiring']);
  await delay((await read(id, 'lifecycle:expiring')).ttl_ms + 100);
  assert.equal((await applyDelete(id, expired.token)).status, 'conflict');
  assert.equal((await read(id, keep)).kind, 'string');

  const binary = Buffer.from([0xff, 0x21, 0x00]);
  const longName = 'lifecycle:' + '길'.repeat(180);
  cli(serverPort, [['SELECT', '3'], ['SET', binary, 'binary-fixture'], ['SET', longName, 'long-fixture']]);
  const reviewed = await previewDeletion(id, [binary, longName]);
  assert.deepEqual(reviewed.keys.map(key => [key.text, key.encoding, key.truncated]), [['ff2100', 'hex', false], [longName, 'utf8', false]]);
  await assert.rejects(applyDelete(id, reviewed.token, ''), /DELETE/);
  await assert.rejects(applyDelete(id, reviewed.token, 'DELETE', ''), /PROD/);
  await assert.rejects(applyEdit(id, reviewed.token), /다시 미리 보세요/);
  assert.equal((await read(id, binary)).kind, 'string');
  const applied = await applyDelete(id, reviewed.token);
  assert.deepEqual([applied.status, applied.affected_count, applied.audit_warning], ['applied', 2, false]);
  assert.equal((await read(id, binary)).kind, 'none');
  assert.equal((await read(id, longName)).kind, 'none');
  await assert.rejects(applyDelete(id, reviewed.token), /다시 미리 보세요/);
  const unknown = await previewDeletion(id, [keep]);
  secure.interruptNextExec();
  await assert.rejects(applyDelete(id, unknown.token), /변경 결과를 확인할 수 없습니다/);
  const audit = (await command('list_audit_events', { before: null })).events.filter(event => event.operation.startsWith('redis.key.delete'));
  assert.ok(audit.some(event => event.outcome === 'succeeded' && event.affected_count === 2 && event.environment === 'PROD'));
  assert.ok(audit.some(event => event.outcome === 'failed'));
  assert.ok(audit.some(event => event.operation === 'redis.key.delete.unconfirmed' && event.outcome === 'started'));
  assert.doesNotMatch(JSON.stringify(audit), /lifecycle:|ff2100|binary-fixture|long-fixture/);
}

async function main() {
  const port = await availablePort();
  const server = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
    '--repl-diskless-sync-delay', '0', '--loglevel', 'warning'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const channel of [server.stdout, server.stderr]) channel.on('data', chunk => { log = (log + chunk).slice(-3000); });
  let browser;
  let secure;
  try {
    await ready(port, server);
    const hasJson = jsonAvailable(port);
    cli(port, [
      ['SET', 'db0:only', 'other'],
      ['SELECT', '3'],
      ['SET', binaryKey, Buffer.from([0, 255, 97])],
      ['SET', 'cache:string', '문자열 값'], ['SET', 'cache:ttl', 'temporary', 'PX', '180000'],
      ['SET', 'console:space key', 'quoted-key-value'],
      ['RPUSH', 'console:wide', ...Array.from({ length: 310 }, (_, index) => 'console-' + index)],
      ['SET', 'lifecycle:ttl', 'ttl-value'], ['SET', 'lifecycle:keep', 'keep-value'],
      ['SET', 'lifecycle:changing', 'changing-value'], ['SET', 'lifecycle:screen-ttl', 'screen-ttl-value'],
      ['SET', 'lifecycle:screen-delete', 'screen-delete-value'],
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
        '+pttl', '+memory|usage', '+exists', '+get', '+mget', '+ping', '+strlen', '+getrange', '+llen', '+lrange', '+zcard', '+zrange', '+hlen', '+hscan', '+scard',
        '+sscan', '+xlen', '+xrange', '+watch', '+unwatch', '+multi', '+exec', '+discard'],
      ['ACL', 'SETUSER', 'fixture_writer', 'on', '>' + secret, '~*',
        '+@read', '-keys', '+info', '+select', '+dbsize', '+memory|usage', '+watch', '+unwatch', '+multi', '+exec', '+discard',
        '+set', '+hset', '+lset', '+sadd', '+zadd', '+xadd', '+pexpire', '+persist', '+unlink',
        '+slowlog|get', 'resetchannels', '&events:*', '+subscribe', '+psubscribe', '+publish'],
      ['CONFIG', 'SET', 'slowlog-log-slower-than', '0'],
      ['SET', 'slowlog:fixture', 'example-private-slowlog-payload'],
      ['CONFIG', 'SET', 'slowlog-log-slower-than', '-1'],
    ]);
    if (hasJson) cli(port, [
      ['SELECT', '3'],
      ['JSON.SET', 'json:typed', '.', '{"large":9007199254740993,"nested":[true,null]}'],
      ['PEXPIRE', 'json:typed', '600000'],
      ['JSON.SET', 'json:large', '.', JSON.stringify('가'.repeat(23000))],
    ]);
    secure = await proxy(port);
    browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
    await verify(browser, port, secure, hasJson);
    console.log('Windows Redis E2E passed (ACL, TLS, console, monitor, Pub/Sub, typed edits, TTL and reviewed key deletion).');
    console.log(hasJson ? 'Redis JSON module editing and TTL verified.' : 'Redis JSON module unavailable on the fixture server.');
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
