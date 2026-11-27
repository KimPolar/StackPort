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
  const stats = { authentications: 0, forwards: 0, denied: false, remoteDenied: false, cancelled: 0 };
  const remotePorts = new Map();
  function unregister(port, owner) {
    const entry = remotePorts.get(port);
    if (!entry || entry.owner !== owner) return false;
    remotePorts.delete(port);
    entry.listener.close();
    return true;
  }
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => {
      clients.delete(client);
      for (const port of remotePorts.keys()) unregister(port, client);
    });
    client.on('authentication', context => {
      if (context.method === 'password') stats.authentications++;
      if (context.username === 'stackport' && context.method === 'password' && context.password === secret) context.accept();
      else context.reject(['password']);
    });
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      if (stats.denied || ![target.host, ...(target.alternateHosts ?? [])].includes(info.destIP) || info.destPort !== target.port) return reject();
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
    client.on('request', (accept, reject, name, info) => {
      if (name === 'cancel-tcpip-forward' && info.bindAddr === '127.0.0.1' && unregister(info.bindPort, client)) {
        stats.cancelled++;
        return accept();
      }
      if (name !== 'tcpip-forward' || stats.remoteDenied || info.bindAddr !== '127.0.0.1') return reject?.();
      const listener = net.createServer(socket => {
        socket.on('error', () => {});
        socket.pause();
        client.forwardOut('127.0.0.1', listener.address().port, socket.remoteAddress, socket.remotePort, (error, channel) => {
          if (error) return socket.destroy();
          socket.pipe(channel).pipe(socket);
          socket.once('close', () => channel.destroy());
          channel.once('close', () => socket.destroy());
          channel.on('error', () => socket.destroy());
        });
      });
      listener.once('error', () => reject());
      listener.listen(info.bindPort, '127.0.0.1', () => {
        const port = listener.address().port;
        remotePorts.set(port, { owner: client, listener });
        if (info.bindPort === 0) accept(port);
        else accept();
      });
    });
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
  socket.write(payload);
  assert.deepEqual(await readBytes(socket, payload.length), payload);
}

async function readBytes(socket, size) {
  const signal = AbortSignal.timeout(5_000);
  while (true) {
    const bytes = socket.read(size);
    if (bytes !== null) return bytes;
    if (socket.readableEnded) throw new Error('Unexpected end of TCP fixture');
    await once(socket, 'readable', { signal });
  }
}

async function socksRequest(socket, address, port, command = 1) {
  socket.write(Buffer.from([5, 1, 0]));
  assert.deepEqual(await readBytes(socket, 2), Buffer.from([5, 0]));
  socket.write(Buffer.concat([Buffer.from([5, command, 0]), address, Buffer.from([port >> 8, port & 255])]));
  const reply = await readBytes(socket, 10);
  assert.equal(reply[0], 5);
  return reply[1];
}

async function main() {
  const echo = await tcpServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
  const reserved = await tcpServer(socket => socket.destroy());
  const remoteHost = 'private-service.invalid';
  const gateway = await sshGateway({ host: remoteHost, port: echo.address().port, alternateHosts: ['127.0.0.1', '::1'] });
  const jump = await sshGateway({ host: '127.0.0.1', port: gateway.port }, 'fixture-jump-secret');
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts()[0].pages()[0];
  const errors = [];
  const sockets = [];
  const credentialProfiles = [];
  const withVault = process.env.STACKPORT_SSH_TUNNEL_CREDENTIALS === '1';
  page.on('pageerror', error => errors.push(String(error)));
  const command = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  try {
    const project = await command('create_project', { name: 'SSH 터널 검증' });
    const createProfile = (name, port, environment) => command('create_ssh_profile', { projectId: project.id,
      input: { name, host: '127.0.0.1', port, username: 'stackport', environment } });
    const profile = await createProfile('터널 서버', gateway.port, 'PROD');
    const jumpProfile = await createProfile('별도 경유 서버', jump.port, 'DEV');
    if (withVault) credentialProfiles.push(profile, jumpProfile);
    const review = item => command('ssh_credential_review', { profileId: item.id, revision: item.revision });
    await page.reload();
    await page.getByLabel('프로젝트', { exact: true }).selectOption({ label: 'SSH 터널 검증' });
    await page.getByRole('button', { name: '네트워크', exact: true }).click();
    await page.getByRole('button', { name: 'SSH 터널', exact: true }).click();
    await page.getByRole('button', { name: '새 터널', exact: true }).click();
    const save = page.getByRole('dialog', { name: 'SSH 터널 등록' });
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
    const dialog = page.getByRole('dialog', { name: 'SSH 터널 시작', exact: true });
    const launch = dialog.getByRole('button', { name: '터널 시작', exact: true });
    const gatewayGroup = dialog.getByRole('group', { name: 'SSH 서버 · 터널 서버', exact: true });
    const jumpGroup = dialog.getByRole('group', { name: '경유 1', exact: true });
    async function enterCredentials() {
      await gatewayGroup.getByLabel('SSH 암호', { exact: true }).fill(password);
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
    if (withVault) await gatewayGroup.getByLabel('연결 성공 후 Windows에 암호 저장').check();
    await launch.click();
    const running = page.getByRole('table', { name: '실행 중인 SSH 터널', exact: true });
    await running.waitFor();
    if (withVault) {
      await dialog.waitFor({ state: 'detached' });
      assert.equal((await review(profile)).usable, true);
    }
    const status = page.getByRole('contentinfo', { name: '작업 공간 상태' });
    await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
    await status.getByRole('button', { name: '활성 SSH 터널 1개', exact: true }).click();
    await running.waitFor();
    const [first] = await command('ssh_tunnel_status');
    assert.ok(first.listen_port > 0);
    const socket = await connect(first.listen_port);
    sockets.push(socket);
    const payload = Buffer.from([0, 120, 255, 7, 65, 13, 10, 33]);
    await verifyTraffic(socket, payload);
    await running.getByText('연결 1개', { exact: true }).waitFor();
    await running.getByText('보냄 8 B · 받음 8 B', { exact: true }).waitFor();
    const [current] = await command('list_ssh_tunnels', { projectId: project.id });
    await assert.rejects(command('start_ssh_tunnel', { tunnel: current, profile, authentication, hops: [], confirmation: 'PROD' }), /이미 실행/);
    gateway.stats.denied = true;
    const denied = await connect(first.listen_port);
    sockets.push(denied);
    await running.getByText(/포트 전달 권한/).waitFor();
    gateway.stats.denied = false;
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(5_000) });
    await page.getByRole('button', { name: '보고서 전달 중단', exact: true }).click();
    await running.waitFor({ state: 'detached' });
    await status.getByRole('button', { name: '활성 SSH 터널 0개', exact: true }).waitFor();
    await closed;
    await assert.rejects(connect(first.listen_port), /ECONNREFUSED/);

    await start.click();
    await dialog.getByRole('button', { name: '경유 서버 추가', exact: true }).click();
    await dialog.getByLabel('경유 1 서버').selectOption(jumpProfile.id);
    await jumpGroup.getByLabel('SSH 암호', { exact: true }).fill('fixture-jump-secret');
    await enterCredentials();
    if (withVault) await gatewayGroup.getByLabel('저장한 암호 사용').check();
    await launch.click();
    await trust(jump.fingerprint);
    if (withVault) await jumpGroup.getByLabel('연결 성공 후 Windows에 암호 저장').check();
    await launch.click();
    await running.getByText(/별도 경유 서버 → 터널 서버/).waitFor();
    if (withVault) await dialog.waitFor({ state: 'detached' });
    const [second] = await command('ssh_tunnel_status');
    const routed = await connect(second.listen_port);
    sockets.push(routed);
    await verifyTraffic(routed, payload);
    assert.ok(jump.stats.forwards > 0);
    for (const client of gateway.clients) client.end();
    await running.waitFor({ state: 'detached' });
    await page.getByRole('table', { name: '저장된 SSH 터널' }).getByText('연결 끊김', { exact: true }).waitFor();
    await assert.rejects(connect(second.listen_port), /ECONNREFUSED/);
    if (withVault) {
      assert.equal((await review(jumpProfile)).usable, true);
      const saved = await command('start_ssh_tunnel', { tunnel: current, profile, confirmation: 'PROD',
        passwordChoice: { mode: 'saved', fingerprint: gateway.fingerprint },
        hops: [{ profile: jumpProfile, passwordChoice: { mode: 'saved', fingerprint: jump.fingerprint } }],
      });
      assert.equal(saved.status, 'open');
      const socket = await connect(saved.session.listen_port);
      sockets.push(socket);
      await verifyTraffic(socket, payload);
      await command('stop_ssh_tunnel', { id: current.id });
    }

    const startSaved = name => page.getByRole('button', { name: `${name} 시작`, exact: true }).click();
    const stopSaved = name => page.getByRole('button', { name: `${name} 중단`, exact: true }).click();
    async function register(name, kind) {
      await page.getByRole('button', { name: '새 터널', exact: true }).click();
      await save.getByLabel('터널 이름').fill(name);
      await save.getByLabel('전달 유형').selectOption(kind);
      await save.getByLabel('SSH 연결').selectOption(profile.id);
      if (kind === 'dynamic') assert.equal(await save.getByLabel('대상 호스트').count(), 0);
      else await save.getByLabel('대상 포트').fill(String(echo.address().port));
      await save.getByRole('button', { name: '저장', exact: true }).click();
      await save.waitFor({ state: 'detached' });
      return (await command('list_ssh_tunnels', { projectId: project.id })).find(item => item.settings.name === name);
    }

    const dynamic = await register('동적 전달', 'dynamic');
    await assert.rejects(command('start_ssh_tunnel', { tunnel: dynamic, profile, authentication, hops: [], confirmation: 'PROD' }), /수신 범위/);
    await startSaved('동적 전달');
    await enterCredentials();
    assert.equal(await launch.isDisabled(), true);
    await dialog.getByLabel(/SOCKS5 인증 없이/).check();
    await launch.click();
    const dynamicRow = running.getByRole('row').filter({ hasText: '동적 전달' });
    await dynamicRow.waitFor();
    const proxy = (await command('ssh_tunnel_status')).find(item => item.tunnel.id === dynamic.id);
    const domain = Buffer.from(remoteHost, 'ascii');
    const addresses = [Buffer.concat([Buffer.from([3, domain.length]), domain]), Buffer.from([1, 127, 0, 0, 1]), Buffer.from([4, ...Array(15).fill(0), 1])];
    for (const address of addresses) {
      const client = await connect(proxy.listen_port);
      sockets.push(client);
      assert.equal(await socksRequest(client, address, echo.address().port), 0);
      await verifyTraffic(client, payload);
    }
    await dynamicRow.getByText('보냄 24 B · 받음 24 B', { exact: true }).waitFor();
    const rejectedMethod = await connect(proxy.listen_port);
    sockets.push(rejectedMethod);
    rejectedMethod.write(Buffer.from([5, 1, 2]));
    assert.deepEqual(await readBytes(rejectedMethod, 2), Buffer.from([5, 255]));
    const unsupported = await connect(proxy.listen_port);
    sockets.push(unsupported);
    assert.equal(await socksRequest(unsupported, addresses[1], echo.address().port, 3), 7);
    gateway.stats.denied = true;
    const rejectedTarget = await connect(proxy.listen_port);
    sockets.push(rejectedTarget);
    assert.equal(await socksRequest(rejectedTarget, addresses[0], echo.address().port), 5);
    gateway.stats.denied = false;
    await stopSaved('동적 전달');
    await running.waitFor({ state: 'detached' });
    await assert.rejects(connect(proxy.listen_port), /ECONNREFUSED/);

    const remote = await register('원격 전달', 'remote');
    await startSaved('원격 전달');
    await enterCredentials();
    assert.equal(await launch.isDisabled(), true);
    await dialog.getByLabel(/루프백에서만 수신하도록/).check();
    gateway.stats.remoteDenied = true;
    await launch.click();
    await dialog.getByRole('alert').getByText(/원격 포트를 열지 못했습니다/).waitFor();
    gateway.stats.remoteDenied = false;
    await launch.click();
    const remoteRow = running.getByRole('row').filter({ hasText: '원격 전달' });
    await remoteRow.getByText('SSH 서버의', { exact: true }).waitFor();
    const onServer = (await command('ssh_tunnel_status')).find(item => item.tunnel.id === remote.id);
    const dialed = await connect(onServer.listen_port);
    sockets.push(dialed);
    await verifyTraffic(dialed, payload);
    await remoteRow.getByText('보냄 8 B · 받음 8 B', { exact: true }).waitFor();
    const [sshClient] = gateway.clients;
    const openForwarded = (port, host) => new Promise((resolve, reject) => {
      sshClient.forwardOut('127.0.0.1', port, host, 10000, (error, channel) => {
        if (error) reject(error);
        else { channel.end(); resolve(); }
      });
    });
    await assert.rejects(openForwarded(onServer.listen_port === 65535 ? 65534 : onServer.listen_port + 1, '127.0.0.1'));
    await assert.rejects(openForwarded(onServer.listen_port, '192.0.2.10'));
    const dialedClosed = once(dialed, 'close', { signal: AbortSignal.timeout(5_000) });
    await stopSaved('원격 전달');
    await running.waitFor({ state: 'detached' });
    await dialedClosed;
    assert.equal(gateway.stats.cancelled, 1);
    await assert.rejects(connect(onServer.listen_port), /ECONNREFUSED/);

    await page.reload();
    await page.getByLabel('프로젝트', { exact: true }).selectOption({ label: 'SSH 터널 검증' });
    await page.getByRole('button', { name: '네트워크', exact: true }).click();
    await page.getByRole('button', { name: 'SSH 터널', exact: true }).click();
    for (const name of ['보고서 전달', '동적 전달', '원격 전달']) {
      await page.getByRole('button', { name: `${name} 삭제`, exact: true }).click();
      await page.getByRole('dialog', { name: 'SSH 터널 삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
    }
    await page.getByText('이 프로젝트에 저장된 터널이 없습니다.', { exact: true }).waitFor();
    assert.deepEqual(await command('list_ssh_tunnels', { projectId: project.id }), []);
    assert.deepEqual(errors, []);
    console.log('Local, dynamic SOCKS5 and remote SSH forwarding, binary data, verification, rejection and shutdown passed.');
    if (withVault) console.log('Saved gateway and jump passwords reopened a tunnel and forwarded binary data.');
  } finally {
    for (const socket of sockets) socket.destroy();
    jump.close(); gateway.close(); reserved.close(); echo.close();
    try {
      await Promise.all(credentialProfiles.map(item => command('forget_ssh_password', { profileId: item.id, revision: item.revision })));
    } finally {
      await browser.close();
    }
  }
}

main().catch(error => { console.error(error); process.exit(1); });
