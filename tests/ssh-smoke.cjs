/* Uses an isolated loopback SSH server and a separately started test app. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { Server, utils } = require('ssh2');
const { createHash, generateKeyPairSync } = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const root = process.env.STACKPORT_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Set STACKPORT_TEST_ROOT to the isolated test directory.');
const password = 'stackport-test-password';

function hostKey() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const publicKey = utils.parseKey(privateKey).getPublicSSH();
  return { privateKey, fingerprint: `SHA256:${createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '')}` };
}

async function startServer(key, port = 0) {
  const stats = { connections: 0, authentications: 0, passwordAttempts: 0, sessions: 0, clients: new Set() };
  const server = new Server({ hostKeys: [key.privateKey] }, client => {
    stats.connections++; stats.clients.add(client);
    client.on('error', () => {});
    client.on('close', () => stats.clients.delete(client));
    client.on('authentication', ctx => {
      stats.authentications++;
      if (ctx.method === 'password') stats.passwordAttempts++;
      if (ctx.method === 'password' && ctx.username === 'stackport' && ctx.password === password) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty());
      session.on('window-change', acceptResize => { if (acceptResize) acceptResize(); });
      session.on('shell', acceptShell => {
        stats.sessions++;
        const stream = acceptShell();
        let pending = '';
        stream.write('STACKPORT_REMOTE_READY\r\n');
        stream.on('data', chunk => {
          pending += chunk.toString('utf8');
          if (pending.includes('\r') || pending.includes('\n')) {
            const line = pending.trim(); pending = '';
            if (line === 'hello') stream.write('STACKPORT_REMOTE_ECHO\r\n');
          }
        });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, stats, port: server.address().port };
}

async function stopServer(instance) {
  for (const client of instance.stats.clients) client.end();
  await new Promise(resolve => instance.server.close(resolve));
}

async function waitForRows(page, pattern, timeout = 15000) {
  await page.waitForFunction(value => {
    const rows = document.querySelector('[role=tabpanel]:not([hidden]) .xterm-rows');
    return rows && rows.textContent.includes(value);
  }, pattern, { timeout });
}

async function openDialog(page, port) {
  await page.getByLabel('셸', { exact: true }).selectOption('ssh');
  await page.getByRole('button', { name: 'SSH 연결', exact: true }).click();
  await page.getByLabel('호스트 또는 IP').fill('127.0.0.1');
  await page.getByLabel('포트', { exact: true }).fill(String(port));
  await page.getByLabel('사용자 이름').fill('stackport');
  await page.getByRole('button', { name: '지문 확인', exact: true }).click();
}

async function main() {
  const sshDir = path.join(root, 'profile', '.ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(path.join(sshDir, 'config'), 'Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile NUL\n');
  const originalKey = hostKey();
  let instance = await startServer(originalKey);
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (!page) throw new Error('No isolated WebView2 page found.');
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.getByRole('button', { name: '터미널', exact: true }).click();
  await page.getByRole('heading', { name: '터미널', exact: true }).waitFor();

  const denied = await page.evaluate(async port => {
    try { await window.__TAURI_INTERNALS__.invoke('open_ssh_terminal', { host: '127.0.0.1', port, username: 'stackport', rows: 24, cols: 80 }); return ''; }
    catch (error) { return String(error); }
  }, instance.port);
  if (!denied.includes('호스트 키')) throw new Error(`Untrusted SSH session was not rejected: ${denied}`);
  if (instance.stats.connections !== 0) throw new Error('Untrusted session attempted a connection.');

  await openDialog(page, instance.port);
  await page.getByText('확인이 필요한 호스트 키', { exact: false }).waitFor();
  await page.getByText(originalKey.fingerprint, { exact: true }).waitFor();
  if (process.env.STACKPORT_TEST_SCREENSHOT) await page.screenshot({ path: process.env.STACKPORT_TEST_SCREENSHOT });
  if (!await page.getByRole('button', { name: '지문을 확인하고 신뢰' }).isDisabled()) throw new Error('Fingerprint selection was bypassed.');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  if (instance.stats.authentications !== 0) throw new Error('Fingerprint scan attempted authentication.');

  await openDialog(page, instance.port);
  await page.getByText(originalKey.fingerprint, { exact: true }).waitFor();
  await page.getByRole('radio').check();
  await page.getByRole('button', { name: '지문을 확인하고 신뢰' }).click();
  await page.getByText('저장된 호스트 키', { exact: false }).waitFor();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 1 · stackport@127\.0\.0\.1:/ }).waitFor();
  await page.getByText(/이 터미널의 명령은 원격 서버에서 실행됩니다/).waitFor();
  await waitForRows(page, 'password:');
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');
  await waitForRows(page, 'STACKPORT_REMOTE_READY');
  if ((await page.locator('[role=tabpanel]:visible .xterm-rows').innerText()).includes(password)) throw new Error('Password appeared in terminal output.');
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await waitForRows(page, 'STACKPORT_REMOTE_ECHO');
  if (instance.stats.sessions !== 1) throw new Error('Remote interactive shell was not opened.');
  const trustFile = path.join(root, 'workspace', 'ssh-trust.sqlite');
  if (fs.readFileSync(trustFile).includes(Buffer.from(password))) throw new Error('Password was saved in the trust database.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 1 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 1/ }).waitFor({ state: 'detached' });

  const connectionsBefore = instance.stats.connections;
  await openDialog(page, instance.port);
  await page.getByText('저장된 호스트 키', { exact: false }).waitFor();
  await page.getByText(originalKey.fingerprint, { exact: true }).waitFor();
  if (instance.stats.connections !== connectionsBefore) throw new Error('Known host was unnecessarily rescanned.');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 2/ }).waitFor();
  await waitForRows(page, 'password:');
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');
  await waitForRows(page, 'STACKPORT_REMOTE_READY');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 2 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 2/ }).waitFor({ state: 'detached' });

  const attemptsBefore = instance.stats.passwordAttempts;
  await openDialog(page, instance.port);
  await page.getByText(originalKey.fingerprint, { exact: true }).waitFor();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 3/ }).waitFor();
  await waitForRows(page, 'password:');
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type('wrong-password');
  await page.keyboard.press('Enter');
  await page.getByRole('status').getByText(/종료 코드: 255/).waitFor();
  if (instance.stats.passwordAttempts - attemptsBefore !== 1) throw new Error('Password authentication was retried automatically.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 3 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 3/ }).waitFor({ state: 'detached' });
  await stopServer(instance);

  const changedKey = hostKey();
  instance = await startServer(changedKey, instance.port);
  await openDialog(page, instance.port);
  await page.getByText(originalKey.fingerprint, { exact: true }).waitFor();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 4/ }).waitFor();
  await waitForRows(page, 'REMOTE HOST IDENTIFICATION HAS CHANGED', 20000);
  if (instance.stats.authentications !== 0) throw new Error('Changed host key reached authentication.');
  await page.getByRole('status').getByText(/종료 코드: 255/).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 4 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 4/ }).waitFor({ state: 'detached' });

  await openDialog(page, instance.port);
  await page.getByText(originalKey.fingerprint, { exact: true }).waitFor();
  await page.getByRole('button', { name: '다른 호스트 키 확인' }).click();
  await page.getByText('호스트 키 재확인', { exact: false }).waitFor();
  await page.getByText(originalKey.fingerprint, { exact: true }).waitFor();
  await page.getByText(changedKey.fingerprint, { exact: true }).waitFor();
  await page.getByRole('radio').check();
  if (!await page.getByRole('button', { name: '확인한 키로 교체' }).isDisabled()) throw new Error('Key replacement bypassed explicit confirmation.');
  await page.getByLabel('키를 바꾸려면 교체 입력').fill('교체');
  await page.getByRole('button', { name: '확인한 키로 교체' }).click();
  await page.getByText('저장된 호스트 키', { exact: false }).waitFor();
  await page.getByText(changedKey.fingerprint, { exact: true }).waitFor();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 5/ }).waitFor();
  await waitForRows(page, 'password:');
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');
  await waitForRows(page, 'STACKPORT_REMOTE_READY');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 5 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 5/ }).waitFor({ state: 'detached' });
  const trustDb = new DatabaseSync(trustFile, { readOnly: true });
  const events = trustDb.prepare('SELECT action, previous_fingerprint, fingerprint FROM trust_events ORDER BY rowid').all();
  trustDb.close();
  if (events.length !== 2 || events[0].action !== 'accepted' || events[0].fingerprint !== originalKey.fingerprint || events[1].action !== 'replaced' || events[1].previous_fingerprint !== originalKey.fingerprint || events[1].fingerprint !== changedKey.fingerprint) throw new Error('Host-key trust history is incorrect.');
  await stopServer(instance);
  instance = await startServer(originalKey, instance.port);
  await openDialog(page, instance.port);
  await page.getByText(changedKey.fingerprint, { exact: true }).waitFor();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 6/ }).waitFor();
  await waitForRows(page, 'REMOTE HOST IDENTIFICATION HAS CHANGED', 20000);
  if (instance.stats.authentications !== 0) throw new Error('Old key remained trusted after replacement.');
  await page.getByRole('status').getByText(/종료 코드: 255/).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 6 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 6/ }).waitFor({ state: 'detached' });
  if (fs.readdirSync(path.join(root, 'workspace')).some(name => name.startsWith('.stackport-known-hosts-'))) throw new Error('Temporary host-key pin file was not removed.');
  await page.getByRole('button', { name: '작업 기록' }).click();
  await page.locator('.ssh-history > summary').click();
  await page.getByText('호스트 키 교체', { exact: true }).waitFor();
  await page.getByText('호스트 키 신뢰', { exact: true }).waitFor();
  const historyText = await page.locator('.ssh-history').innerText();
  if (!historyText.includes('127.0.0.1') || historyText.includes(password) || historyText.includes('wrong-password')) throw new Error('SSH trust history did not protect credentials.');
  if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`);
  await stopServer(instance);
  await browser.close();
  console.log('SSH fingerprint confirmation, pinned login, authentication limit, key rotation, and changed-key rejection passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
