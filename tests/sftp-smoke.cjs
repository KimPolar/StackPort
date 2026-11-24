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
const posixRename = 'posix-rename@openssh.com';

function requestNativeClose(pid) {
  if (!/^\d+$/.test(pid)) throw new Error('Set STACKPORT_TEST_WINDOW_PID to the isolated app PID.');
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class SftpEditorTestWindow { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'; $p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p.ProcessName -ne 'stackport' -or $p.MainWindowHandle -eq 0) { throw 'Invalid isolated StackPort window' }; [SftpEditorTestWindow]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], { stdio: 'pipe' });
}
const htmlSource = '<!doctype html><strong>보고서</strong>';
const downloadFixtures = new Map([
  ['대시보드.txt', { data: Buffer.from('0123456789abcdef!') }],
  ['보고서.html', { data: Buffer.from(htmlSource) }],
  ['미리보기.png', { data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIqIgCAAI+ASOK5tZ4AAAAAElFTkSuQmCC', 'base64') }],
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
  if (uploads.advertiseEdit) {
    // ssh2's test server sends an extension-free v3 VERSION packet by default.
    const protocol = channel._protocol;
    const sendData = protocol.channelData;
    const fields = [posixRename, '1'].map(value => {
      const data = Buffer.from(value);
      const field = Buffer.alloc(4 + data.length);
      field.writeUInt32BE(data.length);
      data.copy(field, 4);
      return field;
    });
    protocol.channelData = function (id, payload) {
      if (id === channel.outgoing.id && payload.length === 9 && payload[4] === 2) {
        protocol.channelData = sendData;
        const packet = Buffer.concat([payload, ...fields]);
        packet.writeUInt32BE(packet.length - 4);
        channel.outgoing.window -= packet.length - payload.length;
        return sendData.call(this, id, packet);
      }
      return sendData.call(this, id, payload);
    };
  }
  const directories = new Map([
    ['/home', [directory('stackport')]],
    ['/home/stackport', [directory('.'), directory('..'), file('.숨김'), directory('문서'), directory('정리'), ...Array.from(downloadFixtures.keys(), file)]],
    ['/home/stackport/문서', [file('보고서.txt')]],
    ['/home/stackport/정리', [directory('비어 있는 폴더'), directory('삭제 중 변경 폴더')]],
    ['/home/stackport/정리/비어 있는 폴더', [directory('.'), directory('..')]],
    ['/home/stackport/정리/삭제 중 변경 폴더', []],
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
    const resolved = requested === '.' ? '/home/stackport' : uploads.aliases.get(requested) ?? requested;
    if ((directories.has(resolved) || uploads.comparisonDirectories.has(resolved)) && !uploads.unavailableDirectories.has(resolved)) channel.name(id, [directory(resolved)]);
    else channel.status(id, code.NO_SUCH_FILE);
  });
  channel.on('OPENDIR', (id, requested) => {
    const entries = directories.get(requested) ?? uploads.comparisonDirectories.get(requested);
    if (!entries) return channel.status(id, code.NO_SUCH_FILE);
    const added = Array.from(uploads.files).filter(([name]) => path.posix.dirname(name) === requested)
      .map(([name, fixture]) => ({ filename: path.posix.basename(name), longname: name, attrs: fixture.attrs }));
    const nested = Array.from(uploads.comparisonDirectories.keys()).filter(name => path.posix.dirname(name) === requested)
      .map(name => directory(path.posix.basename(name)));
    newHandle(id, { entries: [...entries, ...added, ...nested] });
  });
  channel.on('READDIR', (id, handle) => {
    const entries = handles.get(handle.toString('hex'))?.entries;
    if (!entries) return channel.status(id, code.FAILURE);
    if (!entries.length) return channel.status(id, code.EOF);
    channel.name(id, entries.splice(0, 2));
  });
  channel.on('CLOSE', (id, handle) => {
    const opened = handles.get(handle.toString('hex'));
    if (opened?.writable && uploads.editRace) {
      const change = uploads.editRace;
      uploads.editRace = null;
      change();
    }
    channel.status(id, handles.delete(handle.toString('hex')) ? code.OK : code.FAILURE);
  });
  channel.on('LSTAT', (id, remotePath) => {
    const existing = lookup(remotePath);
    if (directories.has(remotePath) || uploads.comparisonDirectories.has(remotePath)) channel.attrs(id, directory(remotePath).attrs);
    else if (existing) channel.attrs(id, existing.attrs);
    else channel.status(id, code.NO_SUCH_FILE);
  });
  channel.on('MKDIR', (id, remotePath, attributes) => {
    const name = path.posix.basename(remotePath);
    const parent = path.posix.dirname(remotePath);
    const entries = directories.get(parent) ?? uploads.comparisonDirectories.get(parent);
    if (!entries) return channel.status(id, code.NO_SUCH_FILE);
    if (name === '권한 제한') return channel.status(id, code.PERMISSION_DENIED);
    if (name === '동시 생성') {
      uploads.files.set(remotePath, { data: Buffer.from('keep'), attrs: { ...file('').attrs, size: 4 } });
    }
    if (lookup(remotePath) || directories.has(remotePath) || uploads.comparisonDirectories.has(remotePath)) return channel.status(id, code.FAILURE);
    const entry = directory(name);
    entry.attrs.mode = 0o40000 | attributes.mode;
    if (uploads.comparisonDirectories.has(parent)) uploads.comparisonDirectories.set(remotePath, []);
    else {
      entries.push(entry);
      directories.set(remotePath, []);
    }
    channel.status(id, code.OK);
  });
  channel.on('OPEN', (id, remotePath, flags, attributes) => {
    const { READ, WRITE, CREAT, EXCL } = utils.sftp.OPEN_MODE;
    if (flags === READ) {
      const fixture = lookup(remotePath);
      if (!fixture) return channel.status(id, code.NO_SUCH_FILE);
      return newHandle(id, { fixture, stats: 0 });
    }
    if (flags !== (READ | WRITE | CREAT | EXCL) || !(directories.has(path.posix.dirname(remotePath)) || uploads.comparisonDirectories.has(path.posix.dirname(remotePath)))
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
  channel.on('FSETSTAT', (id, handle, attrs) => {
    const opened = handles.get(handle.toString('hex'));
    if (!opened?.writable) return channel.status(id, code.PERMISSION_DENIED);
    opened.fixture.attrs.mode = 0o100000 | attrs.mode;
    opened.fixture.attrs.uid = attrs.uid;
    opened.fixture.attrs.gid = attrs.gid;
    channel.status(id, code.OK);
  });
  channel.on('EXTENDED', (id, extension, data) => {
    if (!uploads.advertiseEdit || extension !== posixRename) return channel.status(id, code.OP_UNSUPPORTED);
    const firstLength = data.readUInt32BE();
    const secondOffset = 4 + firstLength;
    const from = data.toString('utf8', 4, secondOffset);
    const length = data.readUInt32BE(secondOffset);
    const to = data.toString('utf8', secondOffset + 4);
    if (secondOffset + 4 + length !== data.length || !path.posix.basename(from).startsWith('.stackport-upload-')
      || path.posix.dirname(from) !== path.posix.dirname(to) || !uploads.files.has(from) || !uploads.files.has(to)) {
      return channel.status(id, code.FAILURE);
    }
    uploads.files.set(to, uploads.files.get(from));
    uploads.files.delete(from);
    uploads.edits++;
    channel.status(id, code.OK);
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
    if (uploads.holdWrite) {
      const hold = uploads.holdWrite;
      uploads.holdWrite = null;
      hold(respond);
      return;
    }
    if (fixture.behavior === 'slow') setTimeout(respond, 90);
    else respond();
  });
  channel.on('RENAME', (id, from, to) => {
    const fixture = uploads.files.get(from);
    const isFolder = directories.has(from);
    const parent = path.posix.dirname(from);
    const destination = path.posix.dirname(to);
    if (destination !== parent) uploads.moves++;
    if ((!fixture && !isFolder) || !(directories.has(destination) || uploads.comparisonDirectories.has(destination)) || to.startsWith(from + '/')) {
      return channel.status(id, code.FAILURE);
    }
    if (path.posix.basename(to) === '변경 금지.bin') return channel.status(id, code.PERMISSION_DENIED);
    if (fixture?.behavior === 'collision' || path.posix.basename(to) === '이름 변경 경쟁.bin' || (destination !== parent && uploads.moveCollision)) {
      uploads.files.set(to, { data: Buffer.from('keep'), attrs: { ...file('').attrs, size: 4 } });
    }
    if (lookup(to) || directories.has(to) || uploads.comparisonDirectories.has(to)) return channel.status(id, code.FAILURE);
    if (isFolder) {
      const entries = directories.get(parent);
      const index = entries.findIndex(item => item.filename === path.posix.basename(from));
      const [entry] = entries.splice(index, 1);
      entry.filename = entry.longname = path.posix.basename(to);
      directories.get(destination).push(entry);
    }
    for (const objects of [directories, uploads.files]) {
      for (const [name, value] of Array.from(objects)) {
        if (name !== from && !name.startsWith(from + '/')) continue;
        objects.set(to + name.slice(from.length), value);
        objects.delete(name);
      }
    }
    channel.status(id, code.OK);
  });
  channel.on('REMOVE', (id, remotePath) => {
    const name = path.posix.basename(remotePath);
    if (!name.startsWith('.stackport-upload-')) uploads.deletions++;
    if (name === '삭제 금지.bin') return channel.status(id, code.PERMISSION_DENIED);
    channel.status(id, uploads.files.delete(remotePath) ? code.OK : code.NO_SUCH_FILE);
  });
  channel.on('RMDIR', (id, remotePath) => {
    uploads.deletions++;
    const entries = directories.get(remotePath);
    if (!entries) return channel.status(id, code.NO_SUCH_FILE);
    if (path.posix.basename(remotePath) === '삭제 중 변경 폴더') {
      uploads.files.set(remotePath + '/.새 파일', { data: Buffer.from('keep'), attrs: { ...file('').attrs, size: 4 } });
    }
    if (entries.some(entry => entry.filename !== '.' && entry.filename !== '..')
      || Array.from(uploads.files.keys()).some(name => path.posix.dirname(name) === remotePath)) {
      return channel.status(id, code.FAILURE);
    }
    directories.delete(remotePath);
    const parent = directories.get(path.posix.dirname(remotePath));
    parent.splice(parent.findIndex(entry => entry.filename === path.posix.basename(remotePath)), 1);
    channel.status(id, code.OK);
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
  const uploads = { files: new Map(), behavior: '', aliases: new Map(), unavailableDirectories: new Set(), comparisonDirectories: new Map(), moves: 0, moveCollision: false,
    deletions: 0, edits: 0, editRace: null, advertiseEdit: true };
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
  fs.writeFileSync(path.join(local, '로컬 문서.json'), '\uFEFF{"제목":"보고서"}');
  const two = path.join(local, 'sort-2.txt');
  const ten = path.join(local, 'sort-10.txt');
  fs.writeFileSync(two, '22');
  fs.writeFileSync(ten, '1234567890');
  fs.utimesSync(two, 1700000000, 1700000000);
  fs.utimesSync(ten, 1600000000, 1600000000);
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
  await page.setViewportSize({ width: 1440, height: 900 });
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
    assert.equal(await page.getByRole('button', { name: '폴더 비교', exact: true }).isDisabled(), true);
    const remotePath = remote.getByLabel('원격 파일 경로', { exact: true });
    const remoteBack = remote.getByRole('button', { name: '원격 파일 뒤로', exact: true });
    const remoteForward = remote.getByRole('button', { name: '원격 파일 앞으로', exact: true });
    const remoteFilter = remote.getByRole('searchbox', { name: '원격 파일 이름으로 찾기' });
    assert.equal(await remotePath.inputValue(), '/home/stackport');
    assert.equal(await remoteBack.isDisabled(), true);
    assert.equal(await remoteForward.isDisabled(), true);
    await remote.getByRole('row').filter({ has: page.getByRole('cell', { name: '대시보드.txt', exact: true }) })
      .getByText('0640 · 42/9', { exact: true }).waitFor();
    assert.equal(await remote.getByText('.숨김', { exact: true }).count(), 0);
    await remote.getByLabel('숨김 파일 표시').check();
    await remote.getByText('.숨김', { exact: true }).waitFor();
    await remote.getByRole('button', { name: '문서', exact: true }).click();
    await remote.getByText('보고서.txt', { exact: true }).waitFor();
    await remoteBack.click();
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    assert.equal(await remoteBack.isDisabled(), true);
    await remoteForward.click();
    await remote.getByText('보고서.txt', { exact: true }).waitFor();
    await remote.getByRole('button', { name: '원격 파일 상위 폴더' }).click();
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    server.uploads.unavailableDirectories.add('/home/stackport/문서');
    await remoteBack.click();
    await remote.getByRole('alert').getByText(/경로가 없거나/).waitFor();
    assert.equal(await remotePath.inputValue(), '/home/stackport');
    assert.equal(await remoteForward.isDisabled(), true);
    server.uploads.unavailableDirectories.clear();
    await remoteFilter.press('Alt+ArrowLeft');
    await remote.getByText('보고서.txt', { exact: true }).waitFor();
    assert.equal(await remoteForward.isEnabled(), true);
    await remoteFilter.press('Control+l');
    assert.equal(await remotePath.evaluate(input => input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length), true);
    await remotePath.fill('/home');
    await remotePath.press('Enter');
    await remote.getByRole('button', { name: 'stackport', exact: true }).waitFor();
    assert.equal(await remoteForward.isDisabled(), true);
    await remote.getByRole('button', { name: 'stackport', exact: true }).click();
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    await remotePath.fill('/missing');
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
    const localBack = localPane.getByRole('button', { name: '로컬 파일 뒤로', exact: true });
    const localForward = localPane.getByRole('button', { name: '로컬 파일 앞으로', exact: true });
    assert.equal(await localBack.isDisabled(), true);
    await localPane.getByRole('button', { name: '하위 폴더' }).click();
    await localPane.getByText('표시할 파일이 없습니다.').waitFor();
    await localBack.click();
    await localPane.getByText('로컬 파일.txt', { exact: true }).waitFor();
    assert.equal(await localBack.isDisabled(), true);
    await localForward.click();
    await localPane.getByText('표시할 파일이 없습니다.').waitFor();
    assert.equal(await remotePath.inputValue(), '/home/stackport');
    await localPane.getByRole('button', { name: '로컬 파일 상위 폴더' }).click();
    await localPane.getByText('로컬 파일.txt', { exact: true }).waitFor();

    const fileNames = pane => pane.locator('.files-table tbody td:first-child').allTextContents();
    const column = (pane, name) => pane.getByRole('columnheader', { name, exact: true });
    const sort = (pane, name) => column(pane, name).getByRole('button', { name, exact: true }).click();
    const localFilter = localPane.getByRole('searchbox', { name: '로컬 파일 이름으로 찾기' });
    await localFilter.fill('SORT-');
    assert.deepEqual(await fileNames(localPane), ['sort-2.txt', 'sort-10.txt']);
    assert.equal(await column(localPane, '이름').getAttribute('aria-sort'), 'ascending');
    await sort(localPane, '크기');
    assert.deepEqual(await fileNames(localPane), ['sort-2.txt', 'sort-10.txt']);
    await sort(localPane, '크기');
    assert.deepEqual(await fileNames(localPane), ['sort-10.txt', 'sort-2.txt']);
    assert.equal(await column(localPane, '크기').getAttribute('aria-sort'), 'descending');
    await sort(localPane, '수정');
    assert.deepEqual(await fileNames(localPane), ['sort-10.txt', 'sort-2.txt']);
    await sort(localPane, '수정');
    assert.deepEqual(await fileNames(localPane), ['sort-2.txt', 'sort-10.txt']);
    await remoteFilter.fill('BIN');
    await sort(remote, '크기');
    assert.deepEqual(await fileNames(remote), ['전송.bin', '느린 파일.bin']);
    assert.equal(await localFilter.inputValue(), 'SORT-');
    assert.equal(await column(localPane, '수정').getAttribute('aria-sort'), 'descending');
    await remote.getByRole('button', { name: '원격 파일 새로고침', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="원격 파일 새로고침"]').disabled);
    assert.equal(await remoteFilter.inputValue(), 'BIN');
    await remoteFilter.fill('없는 이름 [x]');
    await remote.getByText('이름이 일치하는 항목이 없습니다.', { exact: true }).waitFor();
    await remoteFilter.press('Escape');
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    await localPane.getByRole('button', { name: '로컬 파일 이름 검색 지우기', exact: true }).click();
    assert.equal(await localFilter.inputValue(), '');
    await localFilter.fill('하위');
    await localPane.getByRole('button', { name: '하위 폴더', exact: true }).click();
    await localPane.getByText('표시할 파일이 없습니다.', { exact: true }).waitFor();
    assert.equal(await localFilter.inputValue(), '');
    await localPane.getByRole('button', { name: '로컬 파일 상위 폴더', exact: true }).click();
    await localPane.getByText('로컬 파일.txt', { exact: true }).waitFor();

    await page.setViewportSize({ width: 900, height: 600 });
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    await localPane.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '로컬 파일 보기', exact: true }).press('Enter');
    await localPane.getByText('로컬 파일.txt', { exact: true }).waitFor();
    await localFilter.fill('SORT-');
    await remote.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '원격 파일 보기', exact: true }).press('Enter');
    assert.equal(await remote.getByLabel('원격 파일 경로').inputValue(), '/home/stackport');
    await page.getByRole('button', { name: '로컬 파일 보기', exact: true }).press('Enter');
    assert.equal(await localFilter.inputValue(), 'SORT-');
    await localFilter.press('Escape');
    await page.getByRole('button', { name: '원격 파일 보기', exact: true }).press('Enter');
    await remoteBack.click();
    await remote.getByRole('button', { name: 'stackport', exact: true }).waitFor();
    await remoteForward.click();
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });

    await verifyFolderComparison(page, local, server.uploads);
    await verifySyncAdditions(page, remote, localPane, local, server.uploads);
    await verifyPreviews(page, remote, localPane);
    await verifyDownloads(page, remote, local);
    await verifyUploads(page, remote, localPane, local, server.uploads);
    await verifyNewFolder(page, remote, server.uploads);
    await verifyRenames(page, remote, server.uploads);
    await verifyMoves(page, remote, server.uploads);
    await verifyCopies(page, remote, server.uploads, local);
    await verifyDeletes(page, remote, server.uploads);
    if (await verifyEditor(page, remote, server.uploads, local)) {
      assert.deepEqual(errors, []);
      console.log('Native Windows exit exported the draft before closing; the remote original was unchanged.');
      return;
    }

    await page.getByRole('button', { name: 'SFTP 연결 끊기' }).click();
    server.uploads.advertiseEdit = false;
    await page.getByRole('button', { name: 'SSH 호스트 키 확인' }).click();
    await page.getByLabel('인증 방식').selectOption('private_key');
    await page.getByLabel('개인 키 파일 경로').fill(keyFile);
    await page.getByLabel('개인 키 암호 (선택)').fill(passphrase);
    await confirm.fill('PROD');
    await connect.click();
    await remote.getByText('대시보드.txt', { exact: true }).waitFor();
    assert.equal(server.stats.signatures, 1);
    assert.equal(server.stats.subsystem, 2);
    await verifyEditorCopyOnly(page, remote, server.uploads);
    await page.getByRole('button', { name: 'SFTP 연결 끊기' }).click();
    await connect.waitFor({ state: 'detached' });
    const updatedProfile = await verifyDeleteToken(command, profile, authentication, server.uploads);

    await server.close();
    server = await startHost(makeHost(), identity, port);
    await assert.rejects(command('open_sftp', { profile: updatedProfile, confirmation: 'PROD', authentication }), /호스트 키/);
    assert.equal(server.stats.passwords, 0);
    assert.equal(server.stats.subsystem, 0);
    await verifyFileAudit(page, command, project, profile, local);
    assert.deepEqual(errors, []);
    console.log('Pinned SFTP host, previews, verified transfers, remote file edits and operations, production confirmation and audit passed.');
  } finally {
    await browser.close();
    await server.close();
  }
}

async function verifyNewFolder(page, remote, uploads) {
  const parent = '/home/stackport/문서';
  const folder = '새 테스트 폴더';
  const dialog = page.getByRole('dialog', { name: '원격 새 폴더' });
  const open = () => remote.getByRole('button', { name: '새 폴더', exact: true }).click();
  const input = dialog.getByLabel('폴더 이름');
  const submit = async name => {
    await input.fill(name);
    await dialog.getByRole('button', { name: '만들기', exact: true }).click();
  };
  await open();
  await dialog.getByText(parent).waitFor();
  await submit('../밖');
  await dialog.getByRole('alert').getByText(/경로 구분자/).waitFor();
  await submit(folder);
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('status').getByText('원격 폴더 생성 완료').waitFor();
  const entry = remote.getByRole('button', { name: folder, exact: true });
  await entry.waitFor();
  await remote.getByRole('row')
    .filter({ has: page.getByRole('button', { name: folder, exact: true }) })
    .getByText(/0700/).waitFor();
  await entry.click();
  await remote.getByText('표시할 파일이 없습니다.').waitFor();
  assert.equal(await remote.getByLabel('원격 파일 경로').inputValue(), `${parent}/${folder}`);
  await remote.getByRole('button', { name: '원격 파일 상위 폴더' }).click();
  await entry.waitFor();

  await open();
  await submit(folder);
  await dialog.getByRole('alert').getByText(/같은 이름/).waitFor();
  await submit('새 원격 파일.bin');
  await dialog.getByRole('alert').getByText(/같은 이름/).waitFor();
  await submit('권한 제한');
  await dialog.getByRole('alert').getByText(/접근을 거부/).waitFor();
  await submit('동시 생성');
  await dialog.getByRole('alert').getByText(/같은 이름/).waitFor();
  assert.equal(uploads.files.get(`${parent}/동시 생성`).data.toString(), 'keep');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await entry.waitFor();
}

async function verifyRenames(page, remote, uploads) {
  const parent = '/home/stackport/문서';
  const oldFile = '새 원격 파일.bin';
  const newFile = '변경한 파일.bin';
  const oldFolder = '새 테스트 폴더';
  const newFolder = '변경한 폴더';
  const dialog = page.getByRole('dialog', { name: '원격 이름 변경' });
  const open = name => remote.getByRole('button', { name: `${name} 이름 변경`, exact: true }).click();
  const submit = async name => {
    await dialog.getByLabel('새 이름').fill(name);
    await dialog.getByRole('button', { name: '이름 변경', exact: true }).click();
  };
  const cancel = () => dialog.getByRole('button', { name: '취소', exact: true }).click();
  const error = text => dialog.getByRole('alert').getByText(text).waitFor();
  const checkSaved = async (from, to) => {
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('status').getByText('원격 이름 변경 완료').waitFor();
    await remote.getByRole('button', { name: `${to} 이름 변경`, exact: true }).waitFor();
    assert.equal(await remote.getByRole('button', { name: `${from} 이름 변경`, exact: true }).count(), 0);
  };

  const original = uploads.files.get(`${parent}/${oldFile}`);
  const originalBytes = Buffer.from(original.data);
  await open(oldFile);
  await dialog.getByText(parent).waitFor();
  await dialog.getByText(oldFile, { exact: true }).waitFor();
  await submit('../밖');
  await error(/경로 구분자/);
  await submit(oldFile);
  await error(/다른 새 이름/);
  await submit(oldFolder);
  await error(/같은 이름/);
  await submit('변경 금지.bin');
  await error(/접근을 거부/);
  await submit('이름 변경 경쟁.bin');
  await error(/같은 이름/);
  assert.equal(uploads.files.get(`${parent}/이름 변경 경쟁.bin`).data.toString(), 'keep');
  assert.deepEqual(uploads.files.get(`${parent}/${oldFile}`).data, originalBytes);
  original.attrs.mtime++;
  await submit(newFile);
  await error(/목록을 읽은 뒤 변경/);
  assert.equal(uploads.files.has(`${parent}/${newFile}`), false);
  original.attrs.mtime--;
  await cancel();
  await dialog.waitFor({ state: 'detached' });

  await open(oldFile);
  await submit(newFile);
  await checkSaved(oldFile, newFile);
  assert.equal(uploads.files.has(`${parent}/${oldFile}`), false);
  assert.deepEqual(uploads.files.get(`${parent}/${newFile}`).data, originalBytes);

  const child = { data: Buffer.from('nested file'), attrs: { ...file('').attrs, size: 11 } };
  uploads.files.set(`${parent}/${oldFolder}/하위.txt`, child);
  await open(oldFolder);
  await submit(newFolder);
  await checkSaved(oldFolder, newFolder);
  await remote.getByRole('button', { name: newFolder, exact: true }).click();
  await remote.getByText('하위.txt', { exact: true }).waitFor();
  assert.deepEqual(uploads.files.get(`${parent}/${newFolder}/하위.txt`).data, child.data);
}

async function verifyMoves(page, remote, uploads) {
  const source = '/home/stackport/문서';
  const destination = '/home/stackport/정리';
  const fileName = '변경한 파일.bin';
  const folderName = '변경한 폴더';
  const dialog = page.getByRole('dialog', { name: '원격 이동' });
  const pathInput = dialog.getByLabel('대상 폴더 경로');
  const preview = dialog.getByLabel('확인한 이동 경로');
  const move = dialog.getByRole('button', { name: '이동', exact: true });
  const up = remote.getByRole('button', { name: '원격 파일 상위 폴더' });
  const choose = name => remote.getByRole('button', { name: `${name} 다른 폴더로 이동`, exact: true });
  const check = async path => {
    await pathInput.fill(path);
    await dialog.getByRole('button', { name: '경로 확인' }).click();
  };
  const error = text => dialog.getByRole('alert').getByText(text).waitFor();
  const confirmedPath = async value => {
    await preview.filter({ hasText: value }).waitFor();
    assert.equal(await preview.textContent(), value);
  };
  const done = async name => {
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('status').getByText('원격 이동 완료').waitFor();
    await choose(name).waitFor({ state: 'detached' });
  };

  // Create a real descendant to exercise the client-side directory cycle check.
  await remote.getByRole('button', { name: '새 폴더', exact: true }).click();
  const create = page.getByRole('dialog', { name: '원격 새 폴더' });
  await create.getByLabel('폴더 이름').fill('하위 폴더');
  await create.getByRole('button', { name: '만들기', exact: true }).click();
  await remote.getByRole('button', { name: '하위 폴더', exact: true }).waitFor();
  await up.click();
  await choose(fileName).click();
  assert.equal(await move.isDisabled(), true);
  await dialog.getByText(`${source}/${fileName}`, { exact: false }).waitFor();
  await check('/missing');
  await error(/경로가 없거나/);
  assert.equal(await move.isDisabled(), true);
  uploads.aliases.set('/home/stackport/별칭', destination);
  await check('/home/stackport/별칭');
  await confirmedPath(`${destination}/${fileName}`);
  assert.equal(await pathInput.inputValue(), destination);

  const oldPath = `${source}/${fileName}`;
  const newPath = `${destination}/${fileName}`;
  const original = Buffer.from(uploads.files.get(oldPath).data);
  uploads.aliases.set(destination, '/home/stackport');
  await move.click();
  await error(/폴더 경로가 바뀌었습니다/);
  uploads.aliases.delete(destination);
  assert.equal(uploads.moves, 0);
  assert.equal(uploads.files.has(newPath), false);
  assert.deepEqual(uploads.files.get(oldPath).data, original);

  uploads.files.set(newPath, { data: Buffer.from('existing'), attrs: { ...file('').attrs, size: 8 } });
  await move.click();
  await error(/같은 이름/);
  assert.equal(uploads.moves, 0);
  assert.equal(uploads.files.get(newPath).data.toString(), 'existing');
  uploads.files.delete(newPath);

  uploads.moveCollision = true;
  await move.click();
  await error(/같은 이름/);
  assert.equal(uploads.moves, 1);
  assert.equal(uploads.files.get(newPath).data.toString(), 'keep');
  assert.deepEqual(uploads.files.get(oldPath).data, original);
  uploads.moveCollision = false;
  uploads.files.delete(newPath);

  await move.click();
  await done(fileName);
  assert.equal(uploads.files.has(oldPath), false);
  assert.deepEqual(uploads.files.get(newPath).data, original);

  await choose(folderName).click();
  const children = dialog.getByLabel('하위 대상 폴더');
  await children.selectOption({ label: folderName });
  await children.selectOption({ label: '하위 폴더' });
  await move.click();
  await error(/자기 자신이나 하위 폴더/);
  assert.equal(uploads.moves, 2);
  const parentFolder = dialog.getByRole('button', { name: '상위 폴더', exact: true });
  await parentFolder.click();
  await confirmedPath(`${source}/${folderName}/${folderName}`);
  await parentFolder.click();
  await parentFolder.waitFor();
  assert.equal(await pathInput.inputValue(), source);
  assert.equal(await move.isDisabled(), true);
  await parentFolder.click();
  await children.selectOption({ label: '정리' });
  await confirmedPath(`${destination}/${folderName}`);
  await move.click();
  await done(folderName);
  await up.click();
  await remote.getByRole('button', { name: '정리', exact: true }).click();
  await remote.getByText(fileName, { exact: true }).waitFor();
  await remote.getByRole('button', { name: folderName, exact: true }).click();
  await remote.getByText('하위.txt', { exact: true }).waitFor();
  await remote.getByRole('button', { name: '하위 폴더', exact: true }).waitFor();
  assert.equal(uploads.files.get(`${destination}/${folderName}/하위.txt`).data.toString(), 'nested file');
}

async function verifyCopies(page, remote, uploads, local) {
  const parent = '/home/stackport/정리';
  const sourceName = '변경한 파일.bin';
  const sourcePath = `${parent}/${sourceName}`;
  const targetFolder = '변경한 폴더';
  const dialog = page.getByRole('dialog', { name: '원격 파일 복사' });
  const submit = dialog.getByRole('button', { name: '복사', exact: true });
  const name = dialog.getByLabel('복사본 이름');
  const done = async () => {
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('status').getByText('원격 복사 완료', { exact: true }).waitFor();
  };
  const open = fileName => remote.getByRole('button', { name: `${fileName} 복사`, exact: true }).click();
  const noPartials = () => assert.ok(Array.from(uploads.files.keys()).every(key => !path.posix.basename(key).startsWith('.stackport-upload-')));
  const error = pattern => dialog.getByRole('alert').getByText(pattern).waitFor();
  const original = uploads.files.get(sourcePath);
  const contents = Buffer.from(original.data);
  const localFiles = fs.readdirSync(local);
  const assertCopy = target => {
    const copied = uploads.files.get(target);
    assert.deepEqual(copied.data, contents);
    assert.equal(copied.attrs.mode & 0o777, 0o600);
    assert.deepEqual(uploads.files.get(sourcePath).data, contents);
    noPartials();
  };

  await remote.getByRole('button', { name: '원격 파일 상위 폴더' }).click();
  await open(sourceName);
  assert.equal(await submit.isDisabled(), true);
  await name.fill('../밖.bin');
  await submit.click();
  await error(/경로 구분자/);
  await name.fill('동일 폴더 복사.bin');
  await submit.click();
  await done();
  await remote.getByText('동일 폴더 복사.bin', { exact: true }).waitFor();
  assertCopy(`${parent}/동일 폴더 복사.bin`);
  await page.getByText('SHA-256', { exact: true }).click();
  await page.getByText(createHash('sha256').update(contents).digest('hex'), { exact: true }).waitFor();

  await open(sourceName);
  await dialog.getByLabel('하위 대상 폴더').selectOption({ label: targetFolder });
  await dialog.getByLabel('확인한 복사 경로').filter({ hasText: `${parent}/${targetFolder}/${sourceName}` }).waitFor();
  await submit.click();
  await done();
  assertCopy(`${parent}/${targetFolder}/${sourceName}`);

  await open(sourceName);
  await name.fill('동일 폴더 복사.bin');
  await submit.click();
  await error(/같은 이름/);
  assertCopy(`${parent}/동일 폴더 복사.bin`);

  await name.fill('복사 게시 경쟁.bin');
  uploads.behavior = 'collision';
  await submit.click();
  await error(/같은 이름/);
  assert.equal(uploads.files.get(`${parent}/복사 게시 경쟁.bin`).data.toString(), 'keep');
  noPartials();

  await name.fill('복사 검증 실패.bin');
  uploads.behavior = 'corrupt';
  await submit.click();
  await error(/SHA-256/);
  assert.equal(uploads.files.has(`${parent}/복사 검증 실패.bin`), false);
  noPartials();

  await name.fill('복사 중 원본 변경.bin');
  original.changed = true;
  await submit.click();
  await error(/전송 중 변경/);
  original.changed = false;
  assert.equal(uploads.files.has(`${parent}/복사 중 원본 변경.bin`), false);
  noPartials();

  await name.fill('중단할 복사.bin');
  uploads.behavior = 'slow';
  await submit.click();
  await dialog.getByText(/KiB\/s/).waitFor();
  await dialog.getByRole('button', { name: '복사 중단', exact: true }).click();
  await dialog.getByText('복사가 중단되었습니다.', { exact: true }).waitFor();
  assert.equal(uploads.files.has(`${parent}/중단할 복사.bin`), false);
  assert.deepEqual(uploads.files.get(sourcePath).data, contents);
  assert.deepEqual(fs.readdirSync(local), localFiles);
  noPartials();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });

  uploads.files.set(`${parent}/빈 원격 파일.txt`, { data: Buffer.alloc(0), attrs: { ...file('').attrs, size: 0 } });
  await remote.getByRole('button', { name: '원격 파일 새로고침', exact: true }).click();
  await open('빈 원격 파일.txt');
  await name.fill('빈 복사본.txt');
  await submit.click();
  await done();
  assert.equal(uploads.files.get(`${parent}/빈 복사본.txt`).data.length, 0);
  noPartials();
}

async function verifyDeletes(page, remote, uploads) {
  const parent = '/home/stackport/정리';
  const folderName = '변경한 폴더';
  const raceFolder = '삭제 중 변경 폴더';
  const emptyFolder = '비어 있는 폴더';
  const fileName = '동일 폴더 복사.bin';
  const deniedFile = '삭제 금지.bin';
  const dialog = page.getByRole('alertdialog', { name: '원격 항목 삭제' });
  const confirm = dialog.getByLabel('운영 환경 삭제 확인');
  const submit = dialog.getByRole('button', { name: '영구 삭제', exact: true });
  const rowAction = name => remote.getByRole('button', { name: `${name} 삭제`, exact: true });
  const error = pattern => dialog.getByRole('alert').getByText(pattern).waitFor();
  const close = async () => {
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  };
  const confirmDelete = async name => {
    await rowAction(name).click();
    await confirm.fill('PROD');
    await submit.click();
  };
  const done = async name => {
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('status').getByText('원격 삭제 완료', { exact: true }).waitFor();
    await rowAction(name).waitFor({ state: 'detached' });
  };
  uploads.files.set(`${parent}/${deniedFile}`, { data: Buffer.from('keep'), attrs: { ...file('').attrs, size: 4 } });
  await remote.getByRole('button', { name: '원격 파일 새로고침', exact: true }).click();
  await rowAction(deniedFile).waitFor();

  await rowAction(folderName).click();
  await error(/빈 폴더만 삭제/);
  assert.equal(await submit.isDisabled(), true);
  assert.equal(uploads.deletions, 0);
  assert.equal(uploads.files.get(`${parent}/${folderName}/하위.txt`).data.toString(), 'nested file');
  await close();

  await rowAction(fileName).click();
  await dialog.getByText(`${parent}/${fileName}`, { exact: false }).waitFor();
  await dialog.getByText(/파일 1개를 영구 삭제/).waitFor();
  await confirm.fill('prod');
  assert.equal(await submit.isDisabled(), true);
  await close();
  assert.equal(uploads.deletions, 0);
  const source = uploads.files.get(`${parent}/${fileName}`);

  await rowAction(fileName).click();
  await confirm.fill('PROD');
  source.attrs.mtime++;
  await submit.click();
  await error(/삭제 확인 이후 원격 항목이 변경/);
  assert.equal(uploads.deletions, 0);
  assert.deepEqual(uploads.files.get(`${parent}/${fileName}`).data, source.data);
  source.attrs.mtime--;
  await close();

  await confirmDelete(deniedFile);
  await error(/접근을 거부/);
  assert.equal(uploads.files.get(`${parent}/${deniedFile}`).data.toString(), 'keep');
  await close();

  await confirmDelete(raceFolder);
  await error(/빈 폴더만 삭제/);
  assert.equal(uploads.files.get(`${parent}/${raceFolder}/.새 파일`).data.toString(), 'keep');
  await close();

  await confirmDelete(emptyFolder);
  await done(emptyFolder);
  await confirmDelete(fileName);
  await done(fileName);
  assert.equal(uploads.files.has(`${parent}/${fileName}`), false);
  assert.equal(uploads.deletions, 4);
}

async function verifyDeleteToken(command, profile, authentication, uploads) {
  const name = '빈 복사본.txt';
  const path = '/home/stackport/정리';
  const session = await command('open_sftp', { profile, confirmation: 'PROD', authentication });
  const id = session.id;
  try {
    const folder = await command('list_sftp_directory', { id, path: { kind: 'text', value: path } });
    const prepare = (itemName = name) => {
      const { location, kind, size, modified } = folder.entries.find(entry => entry.name === itemName);
      return command('preview_sftp_delete', { id, parent: folder.location, source: { location, kind, size, modified } });
    };
    const apply = (token, confirmation = 'PROD') => command('delete_sftp_entry', { id, token, confirmation });
    await assert.rejects(apply('missing-token'), /만료되었거나/);
    const discarded = await prepare();
    await command('discard_sftp_delete', { id, token: discarded.token });
    await assert.rejects(apply(discarded.token), /만료되었거나/);
    const preview = await prepare();
    assert.equal(preview.path, `${path}/${name}`);
    await assert.rejects(apply(preview.token, ''), /PROD/);
    assert.equal(uploads.files.has(preview.path), true);
    await apply(preview.token);
    assert.equal(uploads.files.has(preview.path), false);
    await assert.rejects(apply(preview.token), /이미 사용/);
    const beforeChange = await prepare('빈 원격 파일.txt');
    const { host, port, username, environment } = profile;
    const updated = await command('update_ssh_profile', {
      id: profile.id,
      revision: profile.revision,
      input: { name: '설정이 변경된 운영 서버', host, port, username, environment },
    });
    await assert.rejects(apply(beforeChange.token), /연결 설정이 변경/);
    assert.equal(uploads.files.has(beforeChange.path), true);
    return updated;
  } finally {
    await command('close_sftp', { id });
  }
}

async function verifyEditor(page, remote, uploads, local) {
  const folder = '/home/stackport/정리';
  const fileName = '편집 원본.txt';
  const filePath = `${folder}/${fileName}`;
  const original = Buffer.from('\uFEFFalpha\r\nstart\r\n');
  const saved = Buffer.from('\uFEFFalpha\r\nsaved\r\n');
  const external = Buffer.from('\uFEFFalpha\r\nother\r\n');
  const draft = 'alpha\n편집 내용 유지\n';
  const dialog = page.getByRole('dialog', { name: '원격 텍스트 편집' });
  const text = dialog.getByLabel('파일 내용');
  const confirmation = dialog.getByLabel('운영 환경 저장 확인');
  const save = dialog.getByRole('button', { name: '저장', exact: true });
  const sourceMetadata = { ...file('').attrs, size: original.length, uid: 1001, gid: 1002, mode: 0o100640 };
  uploads.files.set(filePath, { data: original, attrs: sourceMetadata });
  uploads.files.set(`${folder}/편집 불가.bin`, { data: Buffer.from([0, 255]), attrs: { ...file('').attrs, size: 2 } });
  const tooBig = Buffer.alloc(512 * 1024 + 1, 65);
  uploads.files.set(`${folder}/편집 큰 파일.txt`, { data: tooBig, attrs: { ...file('').attrs, size: tooBig.length } });
  await remote.getByRole('button', { name: '원격 파일 새로고침', exact: true }).click();
  const open = name => remote.getByRole('button', { name: `${name} 편집`, exact: true }).click();
  const error = pattern => dialog.getByRole('alert').getByText(pattern).waitFor();
  const done = async () => {
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('status').getByText('원격 파일 저장 완료', { exact: true }).waitFor();
  };
  const noPartials = () => assert.ok(Array.from(uploads.files.keys()).every(name => !path.posix.basename(name).startsWith('.stackport-upload-')));

  for (const [name, message] of [['편집 불가.bin', /UTF-8 텍스트/], ['편집 큰 파일.txt', /512 KiB/]]) {
    await open(name);
    await error(message);
    await dialog.getByRole('button', { name: '닫기', exact: true }).last().click();
    await dialog.waitFor({ state: 'detached' });
  }

  await open(fileName);
  await text.waitFor();
  assert.equal(await text.inputValue(), 'alpha\nstart\n');
  await dialog.getByText(/UTF-8 BOM · CRLF/).waitFor();
  await text.press('Control+Home');
  await text.press('Shift+End');
  await text.press('Control+f');
  const search = dialog.getByRole('searchbox', { name: '찾을 텍스트', exact: true });
  assert.equal(await search.inputValue(), 'alpha');
  await search.press('Enter');
  await dialog.getByText('1 / 1', { exact: true }).waitFor();
  assert.equal(await text.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), 'alpha');
  await text.press('Control+h');
  const replace = dialog.getByRole('group', { name: '편집기 바꾸기', exact: true });
  await replace.getByRole('textbox', { name: '바꿀 내용', exact: true }).fill('edited-alpha');
  await replace.getByRole('button', { name: '한 건 바꾸기', exact: true }).click();
  await replace.getByRole('status').getByText('1개 위치를 바꿨습니다.', { exact: true }).waitFor();
  assert.equal(await text.inputValue(), 'edited-alpha\nstart\n');
  assert.deepEqual(uploads.files.get(filePath).data, original);
  await text.press('Control+z');
  assert.equal(await text.inputValue(), 'alpha\nstart\n');
  await text.press('Escape');
  await search.waitFor({ state: 'detached' });
  assert.equal(await text.inputValue(), 'alpha\nstart\n');
  const multiline = [...Array.from({ length: 199 }, () => 'fixture line'), '한😀'].join('\n');
  await text.fill(multiline);
  await text.press('Control+End');
  await dialog.getByText('200줄 · 3열', { exact: true }).waitFor();
  await dialog.locator('.code-gutter-lines > [data-active="true"]').getByText('200', { exact: true }).waitFor();
  assert.ok(await dialog.locator('.code-gutter-lines > div').count() < 30);
  await text.fill('alpha\nsaved\n');
  await confirmation.fill('prod');
  assert.equal(await save.isDisabled(), true);
  await confirmation.fill('PROD');
  await text.press('Control+s');
  await done();
  assert.equal(uploads.edits, 1);
  assert.deepEqual(uploads.files.get(filePath).data, saved);
  const attrs = uploads.files.get(filePath).attrs;
  assert.equal(attrs.mode, sourceMetadata.mode);
  assert.equal(attrs.uid, sourceMetadata.uid);
  assert.equal(attrs.gid, sourceMetadata.gid);
  await page.getByText('SHA-256', { exact: true }).click();
  await page.getByText(createHash('sha256').update(saved).digest('hex'), { exact: true }).waitFor();
  noPartials();

  await open(fileName);
  await text.waitFor();
  assert.equal(await text.inputValue(), 'alpha\nsaved\n');
  await text.fill(draft);
  await confirmation.fill('PROD');
  const version = uploads.files.get(filePath);
  assert.equal(saved.length, external.length);
  version.data = external;
  await save.click();
  await error(/원격 파일이 변경/);
  assert.equal(await text.inputValue(), draft);
  assert.equal(uploads.edits, 1);
  assert.deepEqual(uploads.files.get(filePath).data, external);

  version.data = saved;
  uploads.editRace = () => { version.data = external; };
  const windowPid = process.env.STACKPORT_TEST_WINDOW_PID;
  let releaseWrite;
  if (windowPid) uploads.holdWrite = respond => { releaseWrite = respond; };
  await save.click();
  if (windowPid) {
    for (let retries = 0; retries < 50 && !releaseWrite; retries++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(releaseWrite, 'The synthetic server did not pause the edit write.');
    try {
      requestNativeClose(windowPid);
      await dialog.getByRole('status').getByText('원격 파일 저장을 끝내거나 중단한 뒤 앱을 닫을 수 있습니다.').waitFor();
      assert.equal(page.isClosed(), false);
    } finally {
      releaseWrite();
    }
  }
  await error(/원격 파일이 변경/);
  assert.equal(uploads.editRace, null);
  assert.equal(uploads.edits, 1);
  assert.deepEqual(uploads.files.get(filePath).data, external);
  noPartials();

  if (windowPid) {
    requestNativeClose(windowPid);
    await dialog.getByRole('status').getByText(/앱을 닫기 전에 처리 방법/).waitFor();
    await dialog.getByRole('button', { name: '변경 버리고 앱 종료', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '계속 편집', exact: true }).click();
    assert.equal(page.isClosed(), false);
    assert.equal(await text.inputValue(), draft);
  }

  await dialog.getByRole('button', { name: '닫기', exact: true }).last().click();
  await text.press('Control+h');
  await search.waitFor();
  assert.equal(await dialog.getByRole('button', { name: '바꾸기 옵션', exact: true }).count(), 0);
  await search.press('Escape');
  await dialog.getByRole('button', { name: '계속 편집', exact: true }).click();
  assert.equal(await text.inputValue(), draft);

  const chooseDraft = dialog.getByRole('button', { name: '로컬에 초안 저장', exact: true });
  const draftPath = dialog.getByLabel('새 로컬 초안 파일 경로');
  const localFile = path.join(local, '복구 초안.txt');
  const occupied = path.join(local, '기존 초안.txt');
  fs.writeFileSync(occupied, 'keep this file');
  await chooseDraft.click();
  await draftPath.fill(occupied);
  await dialog.getByRole('button', { name: '초안 저장', exact: true }).click();
  await error(/같은 이름의 파일/);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'keep this file');
  assert.equal(await text.inputValue(), draft);
  await draftPath.fill(localFile);
  await dialog.getByRole('button', { name: '초안 저장', exact: true }).click();
  await dialog.getByRole('status').getByText(/로컬 초안 저장 완료/).waitFor();
  const expected = Buffer.from('\uFEFF' + draft.replace(/\n/g, '\r\n'));
  assert.deepEqual(fs.readFileSync(localFile), expected);
  assert.equal(await text.inputValue(), draft);
  assert.equal(uploads.edits, 1);
  assert.deepEqual(uploads.files.get(filePath).data, external);

  await dialog.getByLabel('저장 위치').selectOption('copy');
  await dialog.getByLabel('새 파일 이름').fill('편집 보존본.txt');
  await dialog.getByRole('button', { name: '새 이름으로 저장', exact: true }).click();
  await done();
  assert.deepEqual(uploads.files.get(filePath).data, external);
  assert.deepEqual(uploads.files.get(`${folder}/편집 보존본.txt`).data, expected);
  noPartials();

  await open(fileName);
  await text.fill(draft);
  const exit = process.env.STACKPORT_TEST_DRAFT_EXIT === '1';
  if (exit) {
    assert.ok(windowPid, 'Native draft exit requires STACKPORT_TEST_WINDOW_PID.');
    requestNativeClose(windowPid);
    await dialog.getByRole('status').getByText(/앱을 닫기 전에 처리 방법/).waitFor();
  } else {
    await text.press('Escape');
    await dialog.getByRole('status').getByText(/편집기를 닫기 전에 처리 방법/).waitFor();
  }
  await chooseDraft.click();
  const destination = path.join(local, '닫기 전 초안.txt');
  await draftPath.fill(destination);
  const closed = exit ? page.waitForEvent('close') : dialog.waitFor({ state: 'detached' });
  await dialog.getByRole('button', { name: exit ? '초안 저장 후 앱 종료' : '초안 저장 후 닫기', exact: true }).click();
  await closed;
  if (!exit) await page.getByRole('status').getByText('로컬 초안 저장 완료', { exact: true }).waitFor();
  assert.deepEqual(fs.readFileSync(destination), expected);
  assert.deepEqual(uploads.files.get(filePath).data, external);
  return exit;
}

async function verifyEditorCopyOnly(page, remote, uploads) {
  await remote.getByRole('button', { name: '대시보드.txt 편집', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '원격 텍스트 편집' });
  await dialog.getByText(/같은 폴더에 새 이름으로 저장/).waitFor();
  assert.equal(await dialog.getByLabel('저장 위치').count(), 0);
  await dialog.getByLabel('파일 내용').fill('편집 복사본');
  await dialog.getByLabel('새 파일 이름').fill('확장 없는 서버의 복사본.txt');
  await dialog.getByRole('button', { name: '새 이름으로 저장', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await remote.getByText('확장 없는 서버의 복사본.txt', { exact: true }).waitFor();
  assert.equal(uploads.files.get('/home/stackport/확장 없는 서버의 복사본.txt').data.toString(), '편집 복사본');
  assert.equal(uploads.edits, 1);
}

async function verifyFileAudit(page, command, project, profile, localPath) {
  const fileEvents = [];
  let before = null;
  do {
    const { events, next_cursor } = await command('list_audit_events', { before });
    fileEvents.push(...events.filter(event => event.operation.startsWith('sftp.')));
    before = next_cursor;
  } while (before !== null);
  const groups = Map.groupBy(fileEvents, event => event.correlation_id);
  for (const records of groups.values()) {
    assert.equal(records.length, 2);
    const [end, start] = records;
    assert.notEqual(start.id, end.id);
    assert.equal(start.outcome, 'started');
    assert.ok(end.operation === start.operation || end.operation === `${start.operation}.cancel`);
  }
  for (const operation of ['sftp.download', 'sftp.upload', 'sftp.copy']) {
    for (const outcome of ['started', 'succeeded', 'failed']) {
      assert.ok(fileEvents.some(event => event.operation === operation && event.outcome === outcome));
    }
    assert.ok(fileEvents.some(event => event.operation === `${operation}.cancel` && event.outcome === 'succeeded'));
  }
  for (const operation of ['sftp.mkdir', 'sftp.rename', 'sftp.move', 'sftp.delete']) {
    for (const outcome of ['started', 'succeeded', 'failed']) {
      assert.ok(fileEvents.some(event => event.operation === operation && event.outcome === outcome));
    }
  }
  for (const event of fileEvents) {
    assert.equal(event.project_id, project.id);
    assert.equal(event.profile_id, profile.id);
    assert.equal(event.environment, 'PROD');
    if (event.operation === 'sftp.delete') assert.equal(event.policy, 'sftp-delete-preview-prod-required');
    assert.equal(event.actor, 'local');
    assert.equal(event.object_name, null);
    if (event.operation === 'sftp.sync') {
      assert.equal(event.policy, 'sftp-pinned-host-sync-additions-no-overwrite');
      assert.equal(event.affected_count, event.outcome === 'failed' ? 4 : null);
    } else {
      assert.equal(event.affected_count, event.outcome === 'succeeded' && !event.operation.endsWith('.cancel') ? 1 : null);
    }
    assert.ok(Number.isFinite(Date.parse(event.occurred_at)));
  }
  const serialized = JSON.stringify(fileEvents);
  for (const privateValue of [localPath, '/home/stackport', '새 원격 파일.bin', '새 테스트 폴더', '변경한 파일.bin', '변경한 폴더', '전송.bin', '동일 폴더 복사.bin', '비어 있는 폴더', '빈 복사본.txt', '편집 원본.txt', '편집 내용 유지', password, passphrase]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  await page.getByRole('button', { name: '작업 기록', exact: true }).click();
  await page.getByRole('heading', { name: '작업 기록', exact: true }).waitFor();
  const expected = [];
  for (const action of ['SFTP 다운로드', 'SFTP 업로드', 'SFTP 복사']) {
    for (const state of ['시작', '완료', '실패', '중단']) {
      expected.push({ action, state });
    }
  }
  for (const action of ['SFTP 폴더 생성', 'SFTP 이름 변경', 'SFTP 이동', 'SFTP 삭제', 'SFTP 편집 저장']) {
    expected.push({ action, state: '완료' }, { action, state: '실패' });
  }
  expected.push({ action: 'SFTP 폴더 동기화', state: '시작' }, { action: 'SFTP 폴더 동기화', state: '실패' });
  const history = page.locator('.audit-card .audit-list');
  const older = page.getByRole('button', { name: '이전 기록 더 보기', exact: true });
  await history.waitFor();
  while (expected.length) {
    for (let i = expected.length - 1; i >= 0; i--) {
      const { action, state } = expected[i];
      const rows = history.getByRole('listitem').filter({ hasText: action });
      if (await rows.getByText(state, { exact: true }).count()) expected.splice(i, 1);
    }
    if (!expected.length || !await older.isEnabled()) break;
    const first = await history.locator('dd').first().textContent();
    await older.click();
    await page.waitForFunction(id => {
      const current = document.querySelector('.audit-card .audit-list dd');
      return current && current.textContent !== id;
    }, first);
  }
  assert.deepEqual(expected, []);
  assert.ok(fileEvents.some(event => event.operation === 'sftp.edit' && event.outcome === 'failed'));
  assert.ok(fileEvents.some(event => event.operation === 'sftp.edit' && event.outcome === 'succeeded'));
  assert.ok(fileEvents.some(event => event.operation === 'sftp.edit.copy' && event.outcome === 'succeeded'));
}

async function verifyFolderComparison(page, local, uploads) {
  const rootPath = '/home/stackport';
  const time = 1700000000;
  const remoteFixtures = [];
  function localFile(name, data) {
    const destination = path.join(local, name);
    fs.writeFileSync(destination, data);
    fs.utimesSync(destination, time, time);
  }
  function remoteEntry(name, entry) {
    const destination = `${rootPath}/${name}`;
    remoteFixtures.push(destination);
    uploads.files.set(destination, entry);
  }
  function remoteFile(name, data, modified = time) {
    const bytes = Buffer.from(data);
    remoteEntry(name, { data: bytes, attrs: { ...file('').attrs, size: bytes.length, mtime: modified } });
  }
  localFile('비교 일치.txt', 'abcd');
  remoteFile('비교 일치.txt', 'wxyz');
  localFile('비교 차이.txt', 'a');
  remoteFile('비교 차이.txt', 'long', time + 1);
  localFile('줄 비교.txt', '\uFEFF머리\r\n원래 줄\r\n그대로\r\n마지막');
  remoteFile('줄 비교.txt', '머리\n추가 줄\n다음 줄\n그대로\r\n마지막');
  const originalMergeLocal = '\uFEFF시작\r\n로컬 첫째\r\n공통\r\n로컬 둘째\r\n끝';
  const originalMergeRemote = '시작\r\n원격 첫째\n공통\r\n원격 둘째\n끝';
  localFile('병합 원본.conf', originalMergeLocal);
  remoteFile('병합 원본.conf', originalMergeRemote);
  const originalBinary = Buffer.alloc(18, 0);
  const changedBinary = Buffer.concat([originalBinary, Buffer.from([0xfe])]);
  changedBinary[17] = 0xff;
  localFile('바이트 비교.bin', originalBinary);
  remoteFile('바이트 비교.bin', changedBinary);
  localFile('큰 비교.bin', Buffer.alloc(65537, 0));
  remoteFile('큰 비교.bin', Buffer.alloc(65537, 0xff));
  localFile('속성 확인.txt', 'test');
  remoteEntry('속성 확인.txt', { data: Buffer.from('test'), attrs: { mode: 0o100640 } });
  localFile('정리', 'directory mismatch');
  fs.mkdirSync(path.join(local, '문서'));
  localFile('Case.txt', 'local case');
  remoteFile('case.txt', 'remote case');

  const compare = page.getByRole('dialog', { name: '폴더 비교', exact: true });
  const table = compare.getByRole('table', { name: '폴더 비교 결과', exact: true });
  const row = name => table.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
  const filter = compare.getByLabel('비교 결과 필터');
  const refresh = compare.getByRole('button', { name: '다시 비교', exact: true });
  const before = { edits: uploads.edits, moves: uploads.moves, deletions: uploads.deletions };
  await page.getByRole('button', { name: '폴더 비교', exact: true }).click();
  await compare.getByText(local, { exact: true }).waitFor();
  await compare.getByText(rootPath, { exact: true }).waitFor();
  await row('비교 차이.txt').getByText('크기 다름 · 원격 수정 시각이 더 최근', { exact: true }).waitFor();
  await row('속성 확인.txt').getByText('크기 또는 수정 시각 미확인', { exact: true }).waitFor();
  await row('정리').getByText('유형 다름', { exact: true }).waitFor();
  assert.equal(await row('비교 일치.txt').count(), 0);
  await filter.selectOption('all');
  await row('비교 일치.txt').getByText('크기·수정 시각 일치', { exact: true }).waitFor();
  await row('문서').getByText('양쪽 폴더', { exact: true }).waitFor();
  const compared = row('비교 일치.txt');
  const hash = compared.getByRole('button', { name: '비교 일치.txt 내용 비교', exact: true });
  await hash.click();
  await compared.getByText('내용 다름', { exact: true }).waitFor();
  await compared.getByText('SHA-256', { exact: true }).click();
  await compared.getByText(createHash('sha256').update('abcd').digest('hex'), { exact: true }).waitFor();
  await compared.getByText(createHash('sha256').update('wxyz').digest('hex'), { exact: true }).waitFor();
  await filter.selectOption('issues');
  await compared.getByText('내용 다름', { exact: true }).waitFor();

  const difference = page.getByRole('dialog', { name: '파일 차이', exact: true });
  async function openDifference(name) {
    const item = row(name);
    await item.getByRole('button', { name: `${name} 내용 비교`, exact: true }).click();
    await item.getByRole('button', { name: `${name} 차이 보기`, exact: true }).click();
    await difference.getByText(name, { exact: true }).waitFor();
  }
  await openDifference('줄 비교.txt');
  const text = difference.getByRole('table', { name: '텍스트 줄 비교', exact: true });
  await difference.getByText('UTF-8 · 2줄 삭제 · 3줄 추가', { exact: true }).waitFor();
  await text.getByText('BOM', { exact: true }).waitFor();
  await text.getByText('CRLF', { exact: true }).first().waitFor();
  const retained = text.getByRole('row').filter({ hasText: '그대로' });
  assert.deepEqual(await retained.getByRole('cell').allTextContents(), ['3', '4', '그대로']);
  await difference.getByRole('checkbox', { name: '공백 표시', exact: true }).check();
  await text.getByText('추가·줄', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await difference.waitFor({ state: 'hidden' });
  await compare.waitFor();

  await openDifference('병합 원본.conf');
  const mergeButton = difference.getByRole('button', { name: '텍스트 병합', exact: true });
  await mergeButton.click();
  const merge = page.getByRole('dialog', { name: '텍스트 병합', exact: true });
  await merge.getByText('1 / 2개 변경 구간', { exact: true }).waitFor();
  const localSide = merge.getByRole('radio', { name: '로컬 사용', exact: true });
  const remoteSide = merge.getByRole('radio', { name: '원격 사용', exact: true });
  assert.equal(await localSide.isChecked(), true);
  await remoteSide.check();
  await merge.getByRole('button', { name: '다음 구간', exact: true }).click();
  await merge.getByText('2 / 2개 변경 구간', { exact: true }).waitFor();
  await merge.getByRole('heading', { name: '로컬 · 4행부터 1줄', exact: true }).waitFor();
  assert.equal(await localSide.isChecked(), true);
  await merge.getByRole('button', { name: '이전 구간', exact: true }).click();
  assert.equal(await remoteSide.isChecked(), true);
  const output = '\uFEFF시작\r\n원격 첫째\n공통\r\n로컬 둘째\r\n끝';
  await merge.getByText(/병합 결과 미리보기/).click();
  const preview = merge.locator('pre[aria-label="병합 결과"]');
  assert.equal(await preview.textContent(), output);
  const bom = merge.getByRole('checkbox', { name: 'UTF-8 BOM 포함', exact: true });
  await bom.uncheck();
  assert.equal(await preview.textContent(), output.slice(1));
  await bom.check();
  const mergedFileInput = merge.getByRole('textbox', { name: '새 파일의 절대 경로', exact: true });
  const saveMerged = merge.getByRole('button', { name: '새 파일로 저장', exact: true });
  const sourceFile = path.join(local, '병합 원본.conf');
  await mergedFileInput.fill(sourceFile);
  await saveMerged.click();
  await merge.getByRole('alert').getByText(/같은 이름의 파일/).waitFor();
  assert.deepEqual(fs.readFileSync(sourceFile), Buffer.from(originalMergeLocal));
  const resultFile = path.join(local, '병합 결과.conf');
  await mergedFileInput.fill(resultFile);
  await saveMerged.click();
  await merge.getByText(/저장했습니다/).waitFor();
  assert.deepEqual(fs.readFileSync(resultFile), Buffer.from(output));
  assert.deepEqual(fs.readFileSync(sourceFile), Buffer.from(originalMergeLocal));
  assert.deepEqual(uploads.files.get(`${rootPath}/병합 원본.conf`).data, Buffer.from(originalMergeRemote));
  assert.equal(fs.readdirSync(local).some(file => file.startsWith('.stackport-merge-')), false);
  await page.keyboard.press('Escape');
  await merge.waitFor({ state: 'hidden' });
  await difference.waitFor();
  assert.equal(await mergeButton.evaluate(button => button === document.activeElement), true);
  await difference.getByRole('button', { name: '닫기', exact: true }).click();
  await compare.waitFor();

  await openDifference('바이트 비교.bin');
  await difference.getByText('바이너리 · 같은 오프셋에서 2바이트 차이', { exact: true }).waitFor();
  assert.equal(await mergeButton.count(), 0);
  const bytes = difference.getByRole('table', { name: '바이너리 바이트 비교', exact: true });
  const byteRow = bytes.getByRole('row').filter({ hasText: '00000010' });
  assert.deepEqual(await byteRow.locator('mark').allTextContents(), ['00', '──', 'FF', 'FE']);
  await difference.getByRole('button', { name: '닫기', exact: true }).click();
  await difference.waitFor({ state: 'hidden' });
  await compare.waitFor();

  await filter.selectOption('all');
  const large = row('큰 비교.bin');
  await large.getByRole('button', { name: '큰 비교.bin 내용 비교', exact: true }).click();
  await large.getByText('내용 다름', { exact: true }).waitFor();
  await large.getByText(/차이 보기는 양쪽 파일 64 KiB 이하/).waitFor();
  assert.equal(await large.getByRole('button', { name: '큰 비교.bin 차이 보기', exact: true }).count(), 0);
  await filter.selectOption('issues');

  const changed = uploads.files.get(`${rootPath}/비교 일치.txt`);
  changed.data = Buffer.from('abcd');
  changed.attrs.mtime = time + 1;
  await hash.click();
  await compared.getByRole('alert').getByText(/목록을 읽은 뒤 파일이 변경/).waitFor();
  await refresh.click();
  await compared.getByText('원격 수정 시각이 더 최근', { exact: true }).waitFor();
  await hash.click();
  await compared.getByText('내용 일치', { exact: true }).waitFor();
  await filter.selectOption('local');
  await row('Case.txt').getByText('로컬에만 있음', { exact: true }).waitFor();
  assert.equal(await row('case.txt').count(), 0);
  await filter.selectOption('remote');
  await row('case.txt').getByText('원격에만 있음', { exact: true }).waitFor();
  assert.equal(await row('Case.txt').count(), 0);
  uploads.unavailableDirectories.add(rootPath);
  await refresh.click();
  await compare.getByRole('alert').getByText(/원격 폴더.*경로가 없거나/).waitFor();
  assert.equal(await table.count(), 0);
  uploads.unavailableDirectories.clear();
  remoteFile('다시 읽은 파일.txt', 'fresh');
  await refresh.click();
  await row('다시 읽은 파일.txt').getByText('원격에만 있음', { exact: true }).waitFor();
  await compare.getByRole('button', { name: '닫기', exact: true }).click();

  await page.getByRole('button', { name: '파일 비교', exact: true }).click();
  const pair = page.getByRole('dialog', { name: '파일 비교', exact: true });
  const leftFile = pair.getByRole('combobox', { name: '로컬 파일', exact: true });
  const rightFile = pair.getByRole('combobox', { name: '원격 파일', exact: true });
  const runPair = pair.getByRole('button', { name: '내용 비교', exact: true });
  const viewPair = pair.getByRole('button', { name: '차이 보기', exact: true });
  await leftFile.selectOption({ label: 'Case.txt' });
  assert.equal(await runPair.isEnabled(), false);
  assert.equal(await leftFile.locator('option', { hasText: /^문서$/ }).count(), 0);
  await rightFile.selectOption({ label: '다시 읽은 파일.txt' });
  await runPair.click();
  await pair.getByText('내용 다름', { exact: true }).waitFor();
  await pair.getByText('SHA-256', { exact: true }).click();
  await pair.getByText(createHash('sha256').update('local case').digest('hex'), { exact: true }).waitFor();
  await pair.getByText(createHash('sha256').update('fresh').digest('hex'), { exact: true }).waitFor();
  await viewPair.click();
  await difference.getByText('Case.txt ↔ 다시 읽은 파일.txt', { exact: true }).waitFor();
  const pairText = difference.getByRole('table', { name: '텍스트 줄 비교', exact: true });
  await pairText.getByText('local case', { exact: true }).waitFor();
  await pairText.getByText('fresh', { exact: true }).waitFor();
  await difference.getByRole('button', { name: '닫기', exact: true }).click();
  await rightFile.selectOption({ label: 'case.txt' });
  assert.equal(await viewPair.count(), 0);
  uploads.files.get(`${rootPath}/case.txt`).attrs.mtime++;
  await runPair.click();
  await pair.getByRole('alert').getByText(/목록을 읽은 뒤 파일이 변경/).waitFor();
  await pair.getByRole('button', { name: '목록 새로고침', exact: true }).click();
  await leftFile.selectOption({ label: 'Case.txt' });
  await rightFile.selectOption({ label: 'case.txt' });
  await runPair.click();
  await pair.getByText('내용 다름', { exact: true }).waitFor();
  await pair.getByRole('button', { name: '닫기', exact: true }).click();

  for (const child of ['깊이', '열수없음', '바뀐 경로']) {
    fs.mkdirSync(path.join(local, '문서', child));
    uploads.comparisonDirectories.set(`${rootPath}/문서/${child}`, []);
  }
  localFile('문서/깊이/설정.txt', 'left');
  remoteFile('문서/깊이/설정.txt', 'rght');
  localFile('문서/깊이/지역.txt', 'local child');
  remoteFile('문서/깊이/원격.txt', 'remote child');
  localFile('문서/열수없음/보류.txt', 'unknown child');
  remoteFile('정리/경로 표식.txt', 'outside alias path');
  uploads.unavailableDirectories.add(`${rootPath}/문서/열수없음`);
  uploads.aliases.set(`${rootPath}/문서/바뀐 경로`, `${rootPath}/정리`);

  await page.getByRole('button', { name: '폴더 비교', exact: true }).click();
  const includeChildren = compare.getByRole('checkbox', { name: '하위 폴더 포함', exact: true });
  await row('Case.txt').waitFor();
  assert.equal(await row('문서/깊이/원격.txt').count(), 0);
  await includeChildren.check();
  await table.getByRole('columnheader', { name: '상대 경로', exact: true }).waitFor();
  await row('문서/깊이/지역.txt').getByText('로컬에만 있음', { exact: true }).waitFor();
  await row('문서/깊이/원격.txt').getByText('원격에만 있음', { exact: true }).waitFor();
  await row('정리/경로 표식.txt').getByText('원격에만 있음', { exact: true }).waitFor();
  const blocked = row('문서/열수없음/보류.txt');
  await blocked.getByText('확인 필요', { exact: true }).waitFor();
  await blocked.getByText(/원격 목록 미확인/).waitFor();
  await row('문서/바뀐 경로').getByText(/원격 폴더 경로가 바뀌었습니다/).waitFor();
  assert.equal(await row('문서/바뀐 경로/경로 표식.txt').count(), 0);
  await filter.selectOption('all');
  const nested = row('문서/깊이/설정.txt');
  await nested.getByText('크기·수정 시각 일치', { exact: true }).waitFor();
  await nested.getByRole('button', { name: '문서/깊이/설정.txt 내용 비교', exact: true }).click();
  await nested.getByText('내용 다름', { exact: true }).waitFor();
  await compare.getByRole('button', { name: '동기화 계획', exact: true }).click();
  const plan = page.getByRole('dialog', { name: '동기화 계획 미리보기', exact: true });
  const planTable = plan.getByRole('table', { name: '동기화 계획', exact: true });
  const planRow = name => planTable.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
  const direction = plan.getByRole('combobox', { name: '동기화 방향', exact: true });
  const deletions = plan.getByRole('checkbox', { name: '대상에만 있는 항목을 삭제 후보에 포함', exact: true });
  const exclusions = plan.getByRole('textbox', { name: '제외 패턴', exact: true });
  const planFilter = plan.getByRole('combobox', { name: '동기화 계획 필터', exact: true });
  await planRow('문서/깊이/지역.txt').getByText('파일 복사', { exact: true }).waitFor();
  await planRow('문서/깊이/설정.txt').getByText('파일 갱신', { exact: true }).waitFor();
  await planRow('문서/깊이/설정.txt').getByText('SHA-256이 다릅니다.', { exact: true }).waitFor();
  await planRow('문서/깊이/원격.txt').getByText('보존', { exact: true }).waitFor();
  await planRow('문서/열수없음/보류.txt').getByText('충돌', { exact: true }).waitFor();
  await planRow('Case.txt').getByText(/대소문자가 다른 이름/).waitFor();
  await deletions.check();
  await planRow('문서/깊이/원격.txt').getByText('삭제 후보', { exact: true }).waitFor();
  await exclusions.fill('**/원격.txt');
  await planFilter.selectOption('exclude');
  await planRow('문서/깊이/원격.txt').getByText('제외', { exact: true }).waitFor();
  await exclusions.fill('../*.txt');
  await plan.getByRole('alert').getByText(/상대 경로로 입력/).waitFor();
  assert.equal(await planTable.count(), 0);
  await exclusions.fill('');
  await planFilter.selectOption('all');
  await direction.selectOption('both');
  assert.equal(await deletions.isEnabled(), false);
  assert.equal(await deletions.isChecked(), false);
  await planRow('문서/깊이/원격.txt').getByText('파일 복사', { exact: true }).waitFor();
  await planRow('문서/깊이/원격.txt').getByText('로컬', { exact: true }).waitFor();
  await planRow('문서/깊이/설정.txt').getByText('충돌', { exact: true }).waitFor();
  await direction.selectOption('download');
  await planRow('문서/깊이/설정.txt').getByText('파일 갱신', { exact: true }).waitFor();
  await planRow('문서/깊이/지역.txt').getByText('보존', { exact: true }).waitFor();
  assert.equal(fs.readFileSync(path.join(local, '문서/깊이/설정.txt'), 'utf8'), 'left');
  assert.equal(fs.existsSync(path.join(local, '문서/깊이/원격.txt')), false);
  assert.equal(uploads.files.get(`${rootPath}/문서/깊이/설정.txt`).data.toString('utf8'), 'rght');
  assert.equal(uploads.files.has(`${rootPath}/문서/깊이/지역.txt`), false);
  assert.equal(uploads.files.has(`${rootPath}/문서/깊이/원격.txt`), true);
  await page.keyboard.press('Escape');
  await plan.waitFor({ state: 'hidden' });
  await compare.waitFor();
  uploads.unavailableDirectories.delete(`${rootPath}/문서/열수없음`);
  await refresh.click();
  await blocked.getByText('로컬에만 있음', { exact: true }).waitFor();

  fs.mkdirSync(path.join(local, '페이지 검증'));
  for (let index = 1; index <= 206; index++) localFile(`페이지 검증/항목 ${index}.txt`, '');
  await refresh.click();
  await filter.selectOption('local');
  const pagination = compare.getByRole('navigation', { name: '폴더 비교 결과 페이지', exact: true });
  await pagination.getByText('1 / 2 페이지', { exact: true }).waitFor();
  assert.equal(await table.getByRole('row').count(), 201);
  await pagination.getByRole('button', { name: '다음', exact: true }).click();
  await pagination.getByText('2 / 2 페이지', { exact: true }).waitFor();
  await row('페이지 검증/항목 206.txt').getByText('로컬에만 있음', { exact: true }).waitFor();
  await includeChildren.uncheck();
  await table.getByRole('columnheader', { name: '이름', exact: true }).waitFor();
  assert.equal(await row('문서/깊이/지역.txt').count(), 0);
  await compare.getByRole('button', { name: '닫기', exact: true }).click();
  uploads.aliases.delete(`${rootPath}/문서/바뀐 경로`);
  uploads.comparisonDirectories.clear();
  assert.deepEqual({ edits: uploads.edits, moves: uploads.moves, deletions: uploads.deletions }, before);
  for (const name of remoteFixtures) uploads.files.delete(name);
}

async function verifySyncAdditions(page, remote, localPane, local, uploads) {
  const rootPath = '/home/stackport/동기화 시험';
  const localRoot = path.join(local, '동기화 시험');
  fs.mkdirSync(path.join(localRoot, '송신'), { recursive: true });
  fs.mkdirSync(path.join(localRoot, '충돌 폴더'));
  fs.writeFileSync(path.join(localRoot, '송신/안내.bin'), 'local payload');
  fs.writeFileSync(path.join(localRoot, '충돌 폴더/건너뜀.bin'), 'must not copy');
  fs.writeFileSync(path.join(localRoot, '바뀐 원본.bin'), 'before');
  fs.writeFileSync(path.join(localRoot, '새 파일.bin'), 'new payload');
  uploads.comparisonDirectories.set(rootPath, []);
  uploads.comparisonDirectories.set(`${rootPath}/수신`, []);
  function remoteFile(relative, text) {
    const data = Buffer.from(text);
    uploads.files.set(`${rootPath}/${relative}`, { data, attrs: { ...file('').attrs, size: data.length } });
  }
  remoteFile('수신/값.bin', 'remote payload');
  const localPath = localPane.getByLabel('로컬 파일 경로', { exact: true });
  await localPath.fill(localRoot);
  await localPath.press('Enter');
  await localPane.getByRole('button', { name: '송신', exact: true }).waitFor();
  await remote.getByRole('button', { name: '원격 파일 새로고침' }).click();
  await remote.getByRole('button', { name: '동기화 시험', exact: true }).click();
  await remote.getByRole('button', { name: '수신', exact: true }).waitFor();
  await page.getByRole('button', { name: '폴더 비교', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: '폴더 비교', exact: true });
  await comparison.getByRole('checkbox', { name: '하위 폴더 포함', exact: true }).check();
  await comparison.getByRole('columnheader', { name: '상대 경로', exact: true }).waitFor();
  await comparison.getByRole('button', { name: '동기화 계획', exact: true }).click();
  const plan = page.getByRole('dialog', { name: '동기화 계획 미리보기', exact: true });
  await plan.getByRole('combobox', { name: '동기화 방향', exact: true }).selectOption('both');
  await plan.getByRole('button', { name: '새 항목 실행 (8)', exact: true }).click();
  const start = plan.getByRole('button', { name: '확인하고 시작', exact: true });
  assert.equal(await start.isEnabled(), false);
  await plan.getByRole('textbox', { name: '운영 연결 확인', exact: true }).fill('PROD');

  remoteFile('새 파일.bin', 'existing target');
  uploads.comparisonDirectories.set(`${rootPath}/충돌 폴더`, []);
  fs.writeFileSync(path.join(localRoot, '바뀐 원본.bin'), 'changed length after comparison');
  await start.click();
  const result = plan.getByRole('table', { name: '동기화 실행 결과', exact: true });
  const resultRow = name => result.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
  await plan.getByText('완료 4개 · 실패 3개 · 건너뜀 1개', { exact: true }).waitFor();
  await resultRow('바뀐 원본.bin').getByText(/원본의 크기 또는 수정 시각/).waitFor();
  await resultRow('새 파일.bin').getByText(/같은 이름/).waitFor();
  await resultRow('충돌 폴더/건너뜀.bin').getByText('건너뜀', { exact: true }).waitFor();
  await resultRow('수신/값.bin').getByText('완료', { exact: true }).waitFor();
  assert.equal(fs.readFileSync(path.join(localRoot, '수신/값.bin'), 'utf8'), 'remote payload');
  assert.equal(uploads.files.get(`${rootPath}/송신/안내.bin`).data.toString(), 'local payload');
  assert.equal(uploads.files.get(`${rootPath}/새 파일.bin`).data.toString(), 'existing target');
  assert.equal(uploads.files.has(`${rootPath}/충돌 폴더/건너뜀.bin`), false);
  assert.equal(uploads.files.has(`${rootPath}/바뀐 원본.bin`), false);
  assert.equal([...uploads.files.keys()].some(name => name.startsWith(rootPath) && name.includes('.stackport-upload-')), false);
  await plan.getByRole('button', { name: '닫기', exact: true }).click();
  await comparison.getByRole('columnheader', { name: '상대 경로', exact: true }).waitFor();
  await comparison.getByRole('button', { name: '닫기', exact: true }).click();
  await remote.getByRole('button', { name: '송신', exact: true }).waitFor();
  await localPane.getByRole('button', { name: '수신', exact: true }).waitFor();
  await remote.getByRole('button', { name: '원격 파일 상위 폴더' }).click();
  await remote.getByText('대시보드.txt', { exact: true }).waitFor();
  await localPane.getByRole('button', { name: '로컬 파일 상위 폴더' }).click();
  await localPane.getByText('로컬 파일.txt', { exact: true }).waitFor();
  for (const name of [...uploads.files.keys()]) if (name.startsWith(rootPath + '/')) uploads.files.delete(name);
  uploads.comparisonDirectories.clear();
}

async function verifyPreviews(page, remote, local) {
  const dialog = page.getByRole('dialog', { name: '파일 미리보기' });
  const open = async (pane, name) => {
    const button = pane.getByRole('button', { name: `${name} 미리보기`, exact: true });
    await button.click();
    await dialog.waitFor();
    return button;
  };
  const close = async () => {
    await dialog.getByRole('button', { name: '닫기' }).click();
    await dialog.waitFor({ state: 'detached' });
  };

  const localButton = await open(local, '로컬 문서.json');
  await dialog.getByText('{"제목":"보고서"}', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await localButton.evaluate(button => button === document.activeElement), true);

  await open(remote, '보고서.html');
  const source = dialog.getByLabel('UTF-8 원문', { exact: true });
  await source.waitFor();
  assert.equal(await source.textContent(), htmlSource);
  assert.equal(await source.locator('strong').count(), 0);
  await close();

  await open(remote, '미리보기.png');
  const image = dialog.getByRole('img', { name: '미리보기.png' });
  await image.waitFor();
  await page.waitForFunction(() => document.querySelector('img[alt="미리보기.png"]')?.naturalWidth === 1);
  await close();

  await open(remote, '전송.bin');
  await dialog.getByText(/처음 4,096 B 표시/).waitFor();
  const hex = await dialog.getByLabel('HEX', { exact: true }).textContent();
  assert.ok(hex.startsWith('00000000  00 01 02 03'));
  assert.ok(hex.split('\n').at(-2).startsWith('00000FF0'));
  await close();

  await open(remote, '빈 파일.txt');
  await dialog.getByText('빈 파일입니다.', { exact: true }).waitFor();
  await close();

  await open(remote, '전송 중 수정.txt');
  await dialog.getByRole('alert').getByText(/미리보기 중 변경되었습니다/).waitFor();
  await close();
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
  await remote.getByRole('button', { name: '문서', exact: true }).click();
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
  let releaseWrite;
  uploads.holdWrite = respond => {
    uploads.holdWrite = next => { releaseWrite = next; };
    setTimeout(respond, 240);
  };
  await start.click();
  try {
    await dialog.getByText(/KiB\/s/).waitFor();
    for (let retries = 0; retries < 40 && !releaseWrite; retries++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(releaseWrite, 'The synthetic server did not pause the upload write.');
    await dialog.getByRole('button', { name: '업로드 중단' }).click();
    await dialog.getByText('업로드 중단을 요청했습니다.', { exact: true }).waitFor();
  } finally {
    uploads.holdWrite = null;
    releaseWrite?.();
  }
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
