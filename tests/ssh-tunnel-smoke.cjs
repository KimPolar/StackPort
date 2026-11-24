const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const net = require('node:net');
const { Server, utils } = require('ssh2');

const password = 'fixture-forward-secret';

async function tcpServer(listener) {
  const server = net.createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function sshGateway(target, secret = password) {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const key = utils.parseKey(hostKey);
  const fingerprint = 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '');
  const clients = new Set();
  const stats = { authentications: 0, forwards: 0, denied: false };
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.method === 'password') stats.authentications++;
      if (context.username === 'stackport' && context.method === 'password' && context.password === secret) context.accept();
      else context.reject(['password']);
    });
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      if (stats.denied || info.destIP !== target.host || info.destPort !== target.port) return reject();
      const socket = net.connect(target.port, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        const channel = accept();
        stats.forwards++;
        channel.on('error', () => socket.destroy());
        socket.on('error', () => channel.destroy());
        channel.once('close', () => socket.destroy());
        socket.once('close', () => channel.destroy());
        socket.pipe(channel).pipe(socket);
      });
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port, fingerprint, clients, stats,
    close() { for (const client of clients) client.end(); server.close(); },
  };
}

async function connect(port) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  try { await once(socket, 'connect', { signal: AbortSignal.timeout(5_000) }); return socket; }
  catch (error) { socket.destroy(); throw error; }
}

async function verifyTraffic(socket, payload) {
  const chunks = [];
  let count = 0;
  const signal = AbortSignal.timeout(5_000);
  socket.write(payload);
  while (count < payload.length) {
    const [chunk] = await once(socket, 'data', { signal });
    chunks.push(chunk);
    count += chunk.length;
  }
  assert.deepEqual(Buffer.concat(chunks), payload);
}

async function main() {
  const echo = await tcpServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
  const reserved = await tcpServer(socket => socket.destroy());
  const remoteHost = 'private-service.invalid';
  const gateway = await sshGateway({ host: remoteHost, port: echo.address().port });
  const jump = await sshGateway({ host: '127.0.0.1', port: gateway.port }, 'fixture-jump-secret');
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts()[0].pages()[0];
  const errors = [];
  const sockets = [];
  page.on('pageerror', error => errors.push(String(error)));
  const command = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  try {
    const project = await command('create_project', { name: 'SSH 터널 검증' });
    const createProfile = (name, port, environment) => command('create_ssh_profile', { projectId: project.id,
      input: { name, host: '127.0.0.1', port, username: 'stackport', environment } });
    const profile = await createProfile('터널 서버', gateway.port, 'PROD');
    const jumpProfile = await createProfile('별도 경유 서버', jump.port, 'DEV');
    await page.reload();
    await page.getByLabel('프로젝트', { exact: true }).selectOption({ label: 'SSH 터널 검증' });
    await page.getByRole('button', { name: '네트워크', exact: true }).click();
    await page.getByRole('button', { name: 'SSH 터널', exact: true }).click();
    await page.getByRole('button', { name: '새 터널', exact: true }).click();
    const save = page.getByRole('dialog', { name: '로컬 SSH 터널 등록' });
    await save.getByLabel('터널 이름').fill('보고서 전달');
    await save.getByLabel('SSH 연결').selectOption(profile.id);
    await save.getByLabel('로컬 포트', { exact: true }).fill(String(reserved.address().port));
    await save.getByLabel('대상 호스트').fill(remoteHost);
    await save.getByLabel('대상 포트').fill(String(echo.address().port));
    await save.getByRole('button', { name: '저장', exact: true }).click();
    const [definition] = await command('list_ssh_tunnels', { projectId: project.id });
    assert.equal(definition.settings.target_host, remoteHost);
    const authentication = { kind: 'password', password };
    await assert.rejects(command('start_ssh_tunnel', { tunnel: definition, profile, authentication, hops: [], confirmation: '' }), /PROD/);
    const start = page.getByRole('button', { name: '보고서 전달 시작', exact: true });
    const dialog = page.getByRole('dialog', { name: '로컬 SSH 터널 시작', exact: true });
    const launch = dialog.getByRole('button', { name: '터널 시작', exact: true });
    async function enterCredentials() {
      await dialog.getByRole('group', { name: 'SSH 서버 · 터널 서버', exact: true }).getByLabel('SSH 암호', { exact: true }).fill(password);
      await dialog.getByLabel('운영 환경 확인').fill('PROD');
    }
    async function trust(fingerprint) {
      await dialog.getByText(fingerprint, { exact: true }).waitFor();
      await dialog.getByLabel('별도로 받은 지문과 일치합니다').check();
      await dialog.getByRole('button', { name: '확인한 키 신뢰', exact: true }).click();
      await launch.waitFor();
    }
    await start.click();
    await enterCredentials();
    await launch.click();
    await dialog.getByRole('alert').getByText(/로컬 포트.*사용 중/).waitFor();
    assert.equal(gateway.clients.size, 0);
    await dialog.getByRole('button', { name: '경유 연결 닫기', exact: true }).click();

    await page.getByRole('button', { name: '보고서 전달 수정', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'SSH 터널 수정' });
    await edit.getByLabel('로컬 포트', { exact: true }).fill('0');
    await edit.getByRole('button', { name: '저장', exact: true }).click();
    await edit.waitFor({ state: 'detached' });
    await page.getByText(/127\.0\.0\.1:자동 →/).waitFor();
    await assert.rejects(command('start_ssh_tunnel', { tunnel: definition, profile, authentication, hops: [], confirmation: 'PROD' }), /변경/);
    await start.click();
    await enterCredentials();
    await launch.click();
    await dialog.getByText(gateway.fingerprint, { exact: true }).waitFor();
    assert.equal(gateway.stats.authentications, 0);
    await trust(gateway.fingerprint);
    await launch.click();
    const running = page.getByRole('table', { name: '실행 중인 SSH 터널', exact: true });
    await running.waitFor();
    const [first] = await command('ssh_tunnel_status');
    assert.ok(first.local_port > 0);
    const socket = await connect(first.local_port);
    sockets.push(socket);
    const payload = Buffer.from([0, 120, 255, 7, 65, 13, 10, 33]);
    await verifyTraffic(socket, payload);
    await running.getByText('연결 1개', { exact: true }).waitFor();
    await running.getByText('보냄 8 B · 받음 8 B', { exact: true }).waitFor();
    const [current] = await command('list_ssh_tunnels', { projectId: project.id });
    await assert.rejects(command('start_ssh_tunnel', { tunnel: current, profile, authentication, hops: [], confirmation: 'PROD' }), /이미 실행/);
    gateway.stats.denied = true;
    const denied = await connect(first.local_port);
    sockets.push(denied);
    await running.getByText(/포트 전달 권한/).waitFor();
    gateway.stats.denied = false;
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(5_000) });
    await page.getByRole('button', { name: '보고서 전달 중단', exact: true }).click();
    await running.waitFor({ state: 'detached' });
    await closed;
    await assert.rejects(connect(first.local_port), /ECONNREFUSED/);

    await start.click();
    await dialog.getByRole('button', { name: '경유 서버 추가', exact: true }).click();
    await dialog.getByLabel('경유 1 서버').selectOption(jumpProfile.id);
    await dialog.getByRole('group', { name: '경유 1', exact: true }).getByLabel('SSH 암호', { exact: true }).fill('fixture-jump-secret');
    await enterCredentials();
    await launch.click();
    await trust(jump.fingerprint);
    await launch.click();
    await running.getByText(/별도 경유 서버 → 터널 서버/).waitFor();
    const [second] = await command('ssh_tunnel_status');
    const routed = await connect(second.local_port);
    sockets.push(routed);
    await verifyTraffic(routed, payload);
    assert.ok(jump.stats.forwards > 0);
    for (const client of gateway.clients) client.end();
    await running.waitFor({ state: 'detached' });
    await page.getByRole('table', { name: '저장된 SSH 터널' }).getByText('연결 끊김', { exact: true }).waitFor();
    await assert.rejects(connect(second.local_port), /ECONNREFUSED/);

    await page.reload();
    await page.getByLabel('프로젝트', { exact: true }).selectOption({ label: 'SSH 터널 검증' });
    await page.getByRole('button', { name: '네트워크', exact: true }).click();
    await page.getByRole('button', { name: 'SSH 터널', exact: true }).click();
    await page.getByRole('button', { name: '보고서 전달 삭제', exact: true }).click();
    await page.getByRole('dialog', { name: 'SSH 터널 삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
    await page.getByText('이 프로젝트에 저장된 터널이 없습니다.', { exact: true }).waitFor();
    assert.deepEqual(await command('list_ssh_tunnels', { projectId: project.id }), []);
    assert.deepEqual(errors, []);
    console.log('Saved tunnels, local port conflict, SSH key verification, binary forwarding and counters, shutdown and multi-hop disconnect passed.');
  } finally {
    for (const socket of sockets) socket.destroy();
    jump.close(); gateway.close(); reserved.close(); echo.close();
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
