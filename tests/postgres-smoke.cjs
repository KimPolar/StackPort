const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
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
  fs.writeFileSync(adminPassword, 'fixture-administrator-password\n');
  run(path.join(bin, 'initdb.exe'), ['-D', data, '-U', 'fixture_admin', '--no-instructions', '--no-locale',
    '--encoding=UTF8', '--auth=scram-sha-256', `--pwfile=${adminPassword}`]);
  fs.unlinkSync(adminPassword);
  const extra = Array.from({ length: 23 }, (_, index) => `extra_${index + 1} text`).join(', ');
  const seed = [
    `CREATE ROLE fixture_reader LOGIN PASSWORD '${password}';`,
    'CREATE SCHEMA report;',
    'CREATE SCHEMA restricted;',
    'GRANT USAGE ON SCHEMA report TO fixture_reader;',
    `CREATE TABLE report."quoted table" (id integer PRIMARY KEY, note text, precise numeric(30,3), ${extra});`,
    `INSERT INTO report."quoted table" (id, note, precise, extra_23)
       SELECT i, CASE i WHEN 1 THEN NULL WHEN 2 THEN repeat('한', 513) WHEN 3 THEN '' ELSE '행 ' || i END,
       9007199254740993.123, '마지막 열' FROM generate_series(1, 105) AS series(i);`.replace(/\s+/g, ' '),
    'CREATE VIEW report.visible AS SELECT id FROM report."quoted table" WHERE id=4;',
    'CREATE TABLE report.denied (id integer);',
    'GRANT SELECT ON report."quoted table", report.visible TO fixture_reader;',
  ].join('\n') + '\n';
  const postgres = path.join(bin, 'postgres.exe');
  const initialized = spawnSync(postgres, ['--single', '-D', data, 'postgres'], {
    cwd: directory, encoding: 'utf8', input: seed, windowsHide: true,
  });
  assert.equal(initialized.status, 0, initialized.error?.message ?? initialized.stderr);
  assert.doesNotMatch(initialized.stderr, /ERROR|FATAL|PANIC/);
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
  } catch (error) { server.kill(); throw error; }
  return { ca, port, close() {
    const stopped = spawnSync(path.join(bin, 'pg_ctl.exe'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '10'],
      { cwd: directory, timeout: 12_000, windowsHide: true });
    if (stopped.status !== 0) server.kill();
  } };
}

async function startGateway(target) {
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
      if (info.destIP !== 'localhost' || info.destPort !== target) return reject();
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
  return { port: server.address().port, fingerprint, forwarded: () => forwards, close() {
    for (const client of clients) client.end();
    server.close();
  } };
}

async function verify(browser, fixture, gateway) {
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
  const open = (settings = profile, secret = password, confirmation = 'PROD', tunnelId = null) =>
    command('open_postgres', { profile: settings, password: secret, confirmation, tunnelId });
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
  const table = objects.objects.find(object => object.name === 'quoted table');
  const first = await command('postgres_page', { id: session.id, object: table.id, rowPage: 0, columnPage: 0 });
  assert.equal(first.rows[1][1].truncated, true);
  assert.equal(first.rows[1][1].value.length, 512);
  assert.equal(first.rows[2][1].value, '');
  await close(session.id);
  await assert.rejects(command('postgres_schemas', { id: session.id, page: 0 }), /연결이 닫혔습니다/);

  const connection = page.getByRole('dialog', { name: 'PostgreSQL 연결', exact: true });
  async function connect(tunnel) {
    await page.getByRole('button', { name: 'PostgreSQL 연결', exact: true }).click();
    if (tunnel) await connection.getByLabel('연결 경로').selectOption(tunnel.id);
    await connection.getByLabel('PostgreSQL 암호').fill(password);
    await connection.getByLabel('운영 환경 확인').fill('PROD');
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
  await page.getByLabel('PostgreSQL 객체 검색').fill('visible');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await page.getByRole('button', { name: /visible 뷰/ }).click();
  await data.getByText('4', { exact: true }).waitFor();
  await disconnect();

  const ssh = await command('create_ssh_profile', { projectId: project.id, input: {
    name: 'PG 게이트웨이', host: '127.0.0.1', port: gateway.port, username: 'fixture', environment: 'DEV',
  } });
  const tunnel = await command('create_ssh_tunnel', { projectId: project.id, input: {
    name: '보고서 터널', ssh_profile_id: ssh.id, kind: 'local', listen_port: 0, target_host: 'localhost', target_port: fixture.port,
  } });
  const start = () => command('start_ssh_tunnel', { tunnel, profile: ssh, authentication: { kind: 'password', password: 'fixture-gateway' }, hops: [], confirmation: '' });
  const trust = await start();
  assert.equal(trust.status, 'trust_required');
  assert.ok(trust.host.keys.some(key => key.fingerprint === gateway.fingerprint));
  await command('trust_ssh_host', { token: trust.host.token, fingerprint: gateway.fingerprint, confirmation: '' });
  const running = await start();
  assert.equal(running.status, 'open');
  try {
    await connect(tunnel);
    await page.getByText(/TLS 연결됨.*SSH 터널 보고서 터널/).waitFor();
    await page.getByRole('button', { name: 'report', exact: true }).click();
    await page.getByRole('button', { name: /visible 뷰/ }).click();
    await data.getByText('4', { exact: true }).waitFor();
    assert.equal(gateway.forwarded(), 1);
    await disconnect();
  } finally { await command('stop_ssh_tunnel', { id: tunnel.id }); }
  await assert.rejects(open(profile, password, 'PROD', tunnel.id), /실행 중인 로컬 SSH 터널/);
  assert.deepEqual(errors, []);
}

async function main() {
  const fixture = await startPostgres();
  let gateway;
  let browser;
  try {
    gateway = await startGateway(fixture.port);
    browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
    await verify(browser, fixture, gateway);
    console.log('Windows PostgreSQL E2E passed (verified TLS, SSH tunnel, catalog permissions, paging and exact values).');
  } finally {
    await browser?.close();
    gateway?.close();
    fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
