/* Start an isolated StackPort app and exercise a synthetic loopback SFTP server. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { Server, utils } = require('ssh2');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.STACKPORT_TEST_ROOT;
const password = 'fixture-sftp-password';
const passphrase = 'fixture-encrypted-key';
const { STATUS_CODE: code } = utils.sftp;
const downloadFixtures = new Map([
  ['대시보드.txt', { data: Buffer.from('0123456789abcdef!') }],
  ['빈 파일.txt', { data: Buffer.alloc(0) }],
  ['전송.bin', { data: Buffer.from(Array.from({ length: 145_000 }, (_, index) => index % 251)) }],
  ['느린 파일.bin', { data: Buffer.alloc(384 * 1024, 17), delay: 70 }],
  ['전송 중 수정.txt', { data: Buffer.from('fixture mutation'), changed: true }],
  ['잘린 파일.txt', { data: Buffer.from('short'), short: true }],
]);

const directory = (filename) => ({ filename, longname: filename, attrs: { mode: 0o40750, uid: 42, gid: 9, mtime: 1700000000, atime: 1700000000 } });
const file = (filename) => {
  const fixture = downloadFixtures.get(filename);
  return { filename, longname: filename, attrs: { mode: 0o100640, size: (fixture?.data.length ?? 17) + (fixture?.short ? 8 : 0), uid: 42, gid: 9, mtime: 1700000000, atime: 1700000000 } };
};

function sftpChannel(channel, uploads) {
  const directories = new Map([
    ['/home', [directory('stackport')]],
    ['/home/stackport', [directory('.'), directory('..'), file('.숨김'), directory('문서'), ...Array.from(downloadFixtures.keys(), file)]],
    ['/home/stackport/문서', [file('보고서.txt')]],
  ]);
  const handles = new Map();
  let next = 0;
  const lookup = remotePath => {
    const uploaded = uploads.files.get(remotePath);
    if (uploaded) return uploaded;
    const name = remotePath.startsWith('/home/stackport/') ? remotePath.slice('/home/stackport/'.length) : '';
    const fixture = downloadFixtures.get(name);
    return fixture && { ...fixture, attrs: file(name).attrs };
  };
  function newHandle(id, value) {
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(++next);
    handles.set(handle.toString('hex'), value);
    channel.handle(id, handle);
  }
  channel.on('REALPATH', (id, requested) => {
    const resolved = requested === '.' ? '/home/stackport' : requested;
    if (directories.has(resolved)) channel.name(id, [directory(resolved)]);
    else channel.status(id, code.NO_SUCH_FILE);
  });
  channel.on('OPENDIR', (id, requested) => {
    const entries = directories.get(requested);
    if (!entries) return channel.status(id, code.NO_SUCH_FILE);
    const added = Array.from(uploads.files).filter(([name]) => path.posix.dirname(name) === requested)
      .map(([name, fixture]) => ({ filename: path.posix.basename(name), longname: name, attrs: fixture.attrs }));
    newHandle(id, { entries: [...entries, ...added] });
  });
  channel.on('READDIR', (id, handle) => {
    const entries = handles.get(handle.toString('hex'))?.entries;
    if (!entries) return channel.status(id, code.FAILURE);
    if (!entries.length) return channel.status(id, code.EOF);
    channel.name(id, entries.splice(0, 2));
  });
  channel.on('CLOSE', (id, handle) => {
    channel.status(id, handles.delete(handle.toString('hex')) ? code.OK : code.FAILURE);
  });
  channel.on('LSTAT', (id, remotePath) => {
    const existing = lookup(remotePath);
    if (directories.has(remotePath)) channel.attrs(id, directory(remotePath).attrs);
    else if (existing) channel.attrs(id, existing.attrs);
    else channel.status(id, code.NO_SUCH_FILE);
  });
  channel.on('OPEN', (id, remotePath, flags, attributes) => {
    const { READ, WRITE, CREAT, EXCL } = utils.sftp.OPEN_MODE;
    if (flags === READ) {
      const fixture = lookup(remotePath);
      if (!fixture) return channel.status(id, code.NO_SUCH_FILE);
      return newHandle(id, { fixture, stats: 0 });
    }
    if (flags !== (READ | WRITE | CREAT | EXCL) || !directories.has(path.posix.dirname(remotePath))
      || !path.posix.basename(remotePath).startsWith('.stackport-upload-') || lookup(remotePath)) {
      return channel.status(id, code.PERMISSION_DENIED);
    }
    const fixture = { data: Buffer.alloc(0), attrs: { ...file('').attrs, size: 0, mode: 0o100000 | attributes.mode }, behavior: uploads.behavior };
    uploads.behavior = '';
    uploads.files.set(remotePath, fixture);
    newHandle(id, { fixture, stats: 0, writable: true });
  });
  channel.on('FSTAT', (id, handle) => {
    const open = handles.get(handle.toString('hex'));
    if (!open?.fixture) return channel.status(id, code.FAILURE);
    const attrs = { ...open.fixture.attrs };
    if (open.fixture.changed && open.stats++ > 0) attrs.mtime++;
    channel.attrs(id, attrs);
  });
  channel.on('READ', (id, handle, offset, length) => {
    const open = handles.get(handle.toString('hex'));
    if (!open?.fixture) return channel.status(id, code.FAILURE);
    const { data, delay } = open.fixture;
    if (offset >= data.length) return channel.status(id, code.EOF);
    const respond = () => {
      if (!channel.destroyed) channel.data(id, data.subarray(offset, offset + Math.min(length, 7000)));
    };
    if (delay) setTimeout(respond, delay);
    else respond();
  });
  channel.on('WRITE', (id, handle, offset, data) => {
    const open = handles.get(handle.toString('hex'));
    if (!open?.writable || open.fixture.data.length !== offset) return channel.status(id, code.FAILURE);
    const fixture = open.fixture;
    fixture.data = Buffer.concat([fixture.data, data]);
    fixture.attrs.size = fixture.data.length;
    if (offset === 0 && fixture.behavior === 'corrupt') fixture.data[0] ^= 0xff;
    const respond = () => { if (!channel.destroyed) channel.status(id, code.OK); };
    if (fixture.behavior === 'slow') setTimeout(respond, 90);
    else respond();
  });
  channel.on('RENAME', (id, from, to) => {
    const fixture = uploads.files.get(from);
    if (!fixture || !path.posix.basename(from).startsWith('.stackport-upload-')) return channel.status(id, code.FAILURE);
    if (fixture.behavior === 'collision') uploads.files.set(to, { data: Buffer.from('keep'), attrs: { ...file('').attrs, size: 4 } });
    if (lookup(to) || !directories.has(path.posix.dirname(to))) return channel.status(id, code.FAILURE);
    uploads.files.set(to, fixture);
    uploads.files.delete(from);
    channel.status(id, code.OK);
  });
  channel.on('REMOVE', (id, remotePath) => {
    if (!path.posix.basename(remotePath).startsWith('.stackport-upload-')) return channel.status(id, code.PERMISSION_DENIED);
    channel.status(id, uploads.files.delete(remotePath) ? code.OK : code.NO_SUCH_FILE);
  });
}

function makeHost() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const key = utils.parseKey(privateKey);
  return { privateKey, fingerprint: 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '') };
}

async function startHost(host, identity, port = 0) {
  const clients = new Set();
  const stats = { passwords: 0, signatures: 0, subsystem: 0 };
  const uploads = { files: new Map(), behavior: '' };
  const server = new Server({ hostKeys: [host.privateKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.username !== 'stackport') return context.reject(['password', 'publickey']);
      if (context.method === 'password') {
        stats.passwords++;
        if (context.password === password) return context.accept();
      }
      if (context.method === 'publickey' && context.key.data.equals(identity.getPublicSSH())) {
        if (!context.signature) return context.accept();
        if (identity.verify(context.blob, context.signature, context.hashAlgo) === true) {
          stats.signatures++;
          return context.accept();
        }
      }
      context.reject(['password', 'publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      accept().on('sftp', acceptSftp => {
        stats.subsystem++;
        sftpChannel(acceptSftp(), uploads);
      });
    }));
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  let closing;
  return {
    port: server.address().port,
    stats,
    uploads,
    close() {
      if (closing) return closing;
      closing = once(server, 'close');
      for (const client of clients) client.end();
      server.close();
      return closing;
    },
  };
}

async function main() {
  assert.ok(root && path.isAbsolute(root), 'The test requires a fresh isolated root.');
  const local = path.join(root, '로컬 폴더');
  fs.mkdirSync(local);
  fs.mkdirSync(path.join(local, '하위 폴더'));
  fs.writeFileSync(path.join(local, '로컬 파일.txt'), 'fixture');
  const keyFile = path.join(root, 'encrypted-identity');
  const sshKeygen = path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe');
  execFileSync(sshKeygen, ['-q', '-t', 'ed25519', '-N', passphrase, '-f', keyFile], { stdio: 'pipe' });
  const identity = utils.parseKey(fs.readFileSync(keyFile + '.pub'));
  if (identity instanceof Error) throw identity;
  const original = makeHost();
  let server = await startHost(original, identity);
  const port = server.port;
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const command = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const remote = page.getByRole('region', { name: '원격 파일', exact: true });
  const connect = page.getByRole('button', { name: 'SFTP 연결', exact: true });
  const confirm = page.getByLabel('운영 환경 확인');

  try {
    await page.getByRole('button', { name: '새 프로젝트' }).click();
    await page.getByLabel('이름', { exact: true }).fill('SFTP 검증');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('button', { name: 'SSH 연결 추가' }).click();
    await page.getByLabel('연결 이름').fill('운영 파일 서버');
    await page.getByLabel('호스트 또는 IP').fill('127.0.0.1');
    await page.getByLabel('포트', { exact: true }).fill(String(port));
    await page.getByLabel('사용자 이름').fill('stackport');
    await page.getByRole('dialog').locator('select').selectOption('PROD');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('button', { name: 'SSH 운영 파일 서버 연결' }).waitFor();
    await page.getByRole('button', { name: '파일 탐색', exact: true }).click();
    await page.getByRole('button', { name: 'SSH 호스트 키 확인' }).click();
    await page.getByText(original.fingerprint, { exact: true }).waitFor();
    await page.getByLabel('별도로 받은 지문과 일치합니다').check();
    await page.getByRole('button', { name: '확인한 키 신뢰' }).click();

    const [project] = await command('list_projects');
    const [profile] = await command('list_ssh_profiles', { projectId: project.id });
    const authentication = { kind: 'password', password };
    await assert.rejects(command('open_sftp', { profile, confirmation: '', authentication }), /운영 환경/);
    await assert.rejects(command('open_sftp', { profile: { ...profile, revision: profile.revision + 1 }, confirmation: 'PROD', authentication }), /변경/);
    assert.equal(server.stats.passwords, 0);
    await page.getByLabel('SSH 암호', { exact: true }).fill(password);
    await confirm.fill('PROD');
    await connect.click();
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    assert.equal(await remote.getByLabel('원격 파일 경로').inputValue(), '/home/stackport');
    await remote.getByRole('row').filter({ has: page.getByRole('cell', { name: '대시보드.txt', exact: true }) })
      .getByText('0640 · 42/9', { exact: true }).waitFor();
    assert.equal(await remote.getByText('.숨김', { exact: true }).count(), 0);
    await remote.getByLabel('숨김 파일 표시').check();
    await remote.getByText('.숨김', { exact: true }).waitFor();
    await remote.getByRole('button', { name: '문서' }).click();
    await remote.getByText('보고서.txt', { exact: true }).waitFor();
    await remote.getByRole('button', { name: '원격 파일 상위 폴더' }).click();
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    await remote.getByLabel('원격 파일 경로').fill('/missing');
    await remote.getByRole('button', { name: '이동', exact: true }).click();
    await remote.getByRole('alert').getByText(/경로가 없거나/).waitFor();
    await remote.getByRole('button', { name: '원격 파일 새로고침' }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="원격 파일 경로"]').value === '/home/stackport');
    assert.equal(server.stats.passwords, 1);
    assert.equal(server.stats.subsystem, 1);

    const localPane = page.getByRole('region', { name: '로컬 파일' });
    await localPane.getByLabel('로컬 파일 경로').fill(local);
    await localPane.getByRole('button', { name: '이동', exact: true }).click();
    await localPane.getByText('로컬 파일.txt', { exact: true }).waitFor();
    await localPane.getByRole('button', { name: '하위 폴더' }).click();
    await localPane.getByText('표시할 파일이 없습니다.').waitFor();
    await localPane.getByRole('button', { name: '로컬 파일 상위 폴더' }).click();
    await localPane.getByText('로컬 파일.txt', { exact: true }).waitFor();

    await verifyDownloads(page, remote, local);
    await verifyUploads(page, remote, localPane, local, server.uploads);

    await page.getByRole('button', { name: 'SFTP 연결 끊기' }).click();
    await page.getByRole('button', { name: 'SSH 호스트 키 확인' }).click();
    await page.getByLabel('인증 방식').selectOption('private_key');
    await page.getByLabel('개인 키 파일 경로').fill(keyFile);
    await page.getByLabel('개인 키 암호 (선택)').fill(passphrase);
    await confirm.fill('PROD');
    await connect.click();
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    assert.equal(server.stats.signatures, 1);
    assert.equal(server.stats.subsystem, 2);
    await page.getByRole('button', { name: 'SFTP 연결 끊기' }).click();
    await connect.waitFor({ state: 'detached' });

    await server.close();
    server = await startHost(makeHost(), identity, port);
    await assert.rejects(command('open_sftp', { profile, confirmation: 'PROD', authentication }), /호스트 키/);
    assert.equal(server.stats.passwords, 0);
    assert.equal(server.stats.subsystem, 0);
    assert.deepEqual(errors, []);
    console.log('Pinned SFTP host, file navigation, verified uploads/downloads, cancellation, collision protection, and changed-key blocking passed.');
  } finally {
    await browser.close();
    await server.close();
  }
}

async function verifyDownloads(page, remote, local) {
  const dialog = page.getByRole('dialog', { name: '원격 파일 다운로드' });
  const destination = dialog.getByLabel('로컬 저장 경로');
  const start = dialog.getByRole('button', { name: '다운로드', exact: true });
  const done = page.getByRole('status').getByText('다운로드 완료', { exact: true });
  const close = () => dialog.getByRole('button', { name: '닫기', exact: true }).last().click();
  const click = name => remote.getByRole('button', { name: `${name} 다운로드`, exact: true }).click();
  const noPartials = () => assert.equal(fs.readdirSync(local).filter(name => name.startsWith('.stackport-download-')).length, 0);

  await click('전송.bin');
  const complete = path.join(local, '전송.bin');
  assert.equal(path.normalize(await destination.inputValue()).toLowerCase(), complete.toLowerCase());
  await start.click();
  await done.waitFor();
  const expected = downloadFixtures.get('전송.bin').data;
  assert.deepEqual(fs.readFileSync(complete), expected);
  await page.getByText('SHA-256', { exact: true }).click();
  await page.getByText(createHash('sha256').update(expected).digest('hex'), { exact: true }).waitFor();
  noPartials();

  await click('빈 파일.txt');
  await start.click();
  await done.waitFor();
  assert.equal(fs.statSync(path.join(local, '빈 파일.txt')).size, 0);

  await click('전송.bin');
  await start.click();
  await dialog.getByRole('alert').getByText(/같은 이름/).waitFor();
  assert.deepEqual(fs.readFileSync(complete), expected);
  await close();

  const slow = path.join(local, '느린 파일.bin');
  await click('느린 파일.bin');
  await start.click();
  await dialog.getByText(/KiB\/s/).waitFor();
  assert.equal(fs.existsSync(slow), false);
  await dialog.getByRole('button', { name: '다운로드 중단' }).click();
  await dialog.getByText('다운로드가 중단되었습니다.', { exact: true }).waitFor();
  assert.equal(fs.existsSync(slow), false);
  noPartials();

  await start.click();
  await dialog.getByText(/KiB\/s/).waitFor();
  fs.writeFileSync(slow, 'keep');
  await dialog.getByRole('alert').getByText(/같은 이름/).waitFor();
  assert.equal(fs.readFileSync(slow, 'utf8'), 'keep');
  noPartials();
  await close();

  for (const [name, error] of [['전송 중 수정.txt', /전송 중 변경/], ['잘린 파일.txt', /예상 크기보다 먼저 끝/]]) {
    await click(name);
    await start.click();
    await dialog.getByRole('alert').getByText(error).waitFor();
    assert.equal(fs.existsSync(path.join(local, name)), false);
    noPartials();
    await close();
  }
}

async function verifyUploads(page, remote, localPane, local, uploads) {
  const dialog = page.getByRole('dialog', { name: '로컬 파일 업로드' });
  const filename = dialog.getByLabel('원격 파일 이름');
  const start = dialog.getByRole('button', { name: '업로드', exact: true });
  const done = page.getByRole('status').getByText('업로드 완료', { exact: true });
  const close = () => dialog.getByRole('button', { name: '닫기', exact: true }).last().click();
  const noPartials = () => assert.ok(Array.from(uploads.files.keys()).every(name => !path.posix.basename(name).startsWith('.stackport-upload-')));
  const payload = Buffer.from(Array.from({ length: 310_000 }, (_, index) => index % 197));
  fs.writeFileSync(path.join(local, '업로드.bin'), payload);
  fs.writeFileSync(path.join(local, '로컬 빈 파일.txt'), '');
  await localPane.getByRole('button', { name: '로컬 파일 새로고침' }).click();
  await remote.getByRole('button', { name: '문서' }).click();
  await remote.getByText('보고서.txt', { exact: true }).waitFor();
  const directoryPath = '/home/stackport/문서';
  const open = () => localPane.getByRole('button', { name: '업로드.bin 업로드', exact: true }).click();

  await open();
  await dialog.getByText(directoryPath, { exact: false }).waitFor();
  await filename.fill('../escape.bin');
  await start.click();
  await dialog.getByRole('alert').getByText(/경로 구분자/).waitFor();
  assert.equal(uploads.files.size, 0);
  await filename.fill('새 원격 파일.bin');
  await start.click();
  await done.waitFor();
  await remote.getByText('새 원격 파일.bin', { exact: true }).waitFor();
  const saved = uploads.files.get(`${directoryPath}/새 원격 파일.bin`);
  assert.deepEqual(saved.data, payload);
  assert.equal(saved.attrs.mode & 0o777, 0o600);
  await page.getByText('SHA-256', { exact: true }).click();
  await page.getByText(createHash('sha256').update(payload).digest('hex'), { exact: true }).waitFor();
  noPartials();

  await localPane.getByRole('button', { name: '로컬 빈 파일.txt 업로드', exact: true }).click();
  await start.click();
  await done.waitFor();
  assert.equal(uploads.files.get(`${directoryPath}/로컬 빈 파일.txt`).data.length, 0);

  await open();
  await filename.fill('새 원격 파일.bin');
  await start.click();
  await dialog.getByRole('alert').getByText(/같은 이름/).waitFor();
  assert.deepEqual(saved.data, payload);
  noPartials();
  await close();

  await open();
  await filename.fill('중단.bin');
  uploads.behavior = 'slow';
  await start.click();
  await dialog.getByText(/KiB\/s/).waitFor();
  await dialog.getByRole('button', { name: '업로드 중단' }).click();
  await dialog.getByText('업로드가 중단되었습니다.', { exact: true }).waitFor();
  assert.equal(uploads.files.has(`${directoryPath}/중단.bin`), false);
  noPartials();

  await filename.fill('검증 실패.bin');
  uploads.behavior = 'corrupt';
  await start.click();
  await dialog.getByRole('alert').getByText(/SHA-256/).waitFor();
  assert.equal(uploads.files.has(`${directoryPath}/검증 실패.bin`), false);
  noPartials();

  await filename.fill('게시 충돌.bin');
  uploads.behavior = 'collision';
  await start.click();
  await dialog.getByRole('alert').getByText(/같은 이름/).waitFor();
  assert.equal(uploads.files.get(`${directoryPath}/게시 충돌.bin`).data.toString('utf8'), 'keep');
  noPartials();
  await close();
}

main().catch(error => { console.error(error); process.exit(1); });
