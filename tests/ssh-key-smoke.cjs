/* Attach only to an isolated Windows test instance. See docs/IMPLEMENTATION.md. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { Server, utils } = require('ssh2');
const { createHash, generateKeyPairSync } = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.env.STACKPORT_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Set STACKPORT_TEST_ROOT to the isolated test directory.');
const passphrase = 'stackport-synthetic-key-passphrase';

function keyPair(encrypted) {
  const options = { type: 'pkcs1', format: 'pem' };
  if (encrypted) Object.assign(options, { cipher: 'aes-256-cbc', passphrase });
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: options, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const parsed = utils.parseKey(pair.privateKey, encrypted ? passphrase : undefined);
  if (parsed instanceof Error) throw parsed;
  return { privateKey: pair.privateKey, parsed };
}

function protectTestKey(file) {
  // Windows OpenSSH rejects keys inherited by other users. Restrict only this
  // synthetic fixture; never modify a user's real key or home directory.
  execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], { stdio: 'pipe' });
}

async function waitForRows(page, value, timeout = 20000) {
  await page.waitForFunction(text => document.querySelector('[role=tabpanel]:not([hidden]) .xterm-rows')?.textContent.includes(text), value, { timeout });
}

async function main() {
  const hostKey = keyPair(false);
  const identity = keyPair(true);
  const wrong = keyPair(false);
  const keyDir = path.join(root, 'synthetic key files');
  fs.mkdirSync(keyDir, { recursive: true });
  const identityPath = path.join(keyDir, 'encrypted identity.pem');
  const wrongPath = path.join(keyDir, 'wrong identity.pem');
  fs.writeFileSync(identityPath, identity.privateKey);
  fs.writeFileSync(wrongPath, wrong.privateKey);
  protectTestKey(identityPath);
  protectTestKey(wrongPath);

  const fingerprint = `SHA256:${createHash('sha256').update(hostKey.parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const stats = { publicKeys: 0, signatures: 0, passwords: 0, sessions: 0, clients: new Set() };
  const server = new Server({ hostKeys: [hostKey.privateKey] }, client => {
    stats.clients.add(client);
    client.on('error', () => {});
    client.on('close', () => stats.clients.delete(client));
    client.on('authentication', ctx => {
      if (ctx.method === 'password') stats.passwords++;
      if (ctx.method === 'publickey') {
        stats.publicKeys++;
        const matches = ctx.username === 'stackport' && ctx.key.data.equals(identity.parsed.getPublicSSH());
        const verified = !ctx.signature || identity.parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true;
        if (matches && verified) { if (ctx.signature) stats.signatures++; ctx.accept(); return; }
      }
      ctx.reject(['publickey', 'password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty());
      session.on('window-change', acceptResize => { if (acceptResize) acceptResize(); });
      session.on('shell', acceptShell => { stats.sessions++; acceptShell().write('STACKPORT_KEY_AUTH_READY\r\n'); });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (!page) throw new Error('No isolated WebView2 page found.');
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.getByRole('button', { name: '터미널', exact: true }).click();
  await page.getByLabel('셸', { exact: true }).selectOption('ssh');
  await page.getByRole('button', { name: 'SSH 연결', exact: true }).click();
  await page.getByLabel('호스트 또는 IP').fill('127.0.0.1');
  await page.getByLabel('포트', { exact: true }).fill(String(port));
  await page.getByLabel('사용자 이름').fill('stackport');
  await page.getByLabel('SSH 인증 방식').selectOption('key_file');
  await page.getByLabel('SSH 키 파일 경로').fill(identityPath);
  await page.getByRole('button', { name: '지문 확인' }).click();
  await page.getByText(fingerprint, { exact: true }).waitFor();
  await page.getByRole('radio').check();
  await page.getByRole('button', { name: '지문을 확인하고 신뢰' }).click();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 1/ }).waitFor();
  await waitForRows(page, 'Enter passphrase for key');
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type(passphrase);
  await page.keyboard.press('Enter');
  await waitForRows(page, 'STACKPORT_KEY_AUTH_READY');
  if ((await page.locator('[role=tabpanel]:visible .xterm-rows').innerText()).includes(passphrase)) throw new Error('Key passphrase appeared in terminal output.');
  if (stats.sessions !== 1 || stats.signatures !== 1 || stats.passwords !== 0) throw new Error('Encrypted key authentication did not complete as expected.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 1 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 1/ }).waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'SSH 연결', exact: true }).click();
  await page.getByLabel('호스트 또는 IP').fill('127.0.0.1');
  await page.getByLabel('포트', { exact: true }).fill(String(port));
  await page.getByLabel('사용자 이름').fill('stackport');
  await page.getByLabel('SSH 인증 방식').selectOption('key_file');
  await page.getByLabel('SSH 키 파일 경로').fill(wrongPath);
  await page.getByRole('button', { name: '지문 확인' }).click();
  await page.getByText(fingerprint, { exact: true }).waitFor();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 2/ }).waitFor();
  await page.getByRole('status').getByText(/종료 코드: 255/).waitFor();
  if (stats.passwords !== 0 || stats.sessions !== 1) throw new Error('A rejected key fell back to password authentication.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 2 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 2/ }).waitFor({ state: 'detached' });

  await page.getByRole('button', { name: '워크스페이스', exact: true }).click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByLabel('이름', { exact: true }).fill('키 인증 검증');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: 'SSH 연결 추가' }).click();
  await page.getByLabel('연결 이름').fill('저장된 운영 서버');
  await page.getByLabel('호스트 또는 IP').fill('127.0.0.1');
  await page.getByLabel('포트', { exact: true }).fill(String(port));
  await page.getByLabel('사용자 이름').fill('stackport');
  await page.getByRole('dialog').locator('select').selectOption('PROD');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: 'SSH 저장된 운영 서버 연결' }).click();
  await page.getByLabel('SSH 인증 방식').selectOption('key_file');
  await page.getByLabel('SSH 키 파일 경로').fill(identityPath);
  await page.getByRole('button', { name: '지문 확인' }).click();
  await page.getByLabel('운영 환경 확인: PROD 입력').fill('PROD');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 3/ }).waitFor();
  await waitForRows(page, 'Enter passphrase for key');
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type(passphrase);
  await page.keyboard.press('Enter');
  await waitForRows(page, 'STACKPORT_KEY_AUTH_READY');
  if (stats.sessions !== 2 || stats.signatures !== 2 || stats.passwords !== 0) throw new Error('Saved PROD profile did not authenticate with the selected key.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 3 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 3/ }).waitFor({ state: 'detached' });
  for (const name of fs.readdirSync(path.join(root, 'workspace')).filter(name => name.includes('.sqlite'))) {
    const content = fs.readFileSync(path.join(root, 'workspace', name));
    if (content.includes(Buffer.from(passphrase)) || content.includes(Buffer.from(identity.privateKey)) || content.includes(Buffer.from(identityPath))) throw new Error('SSH key material, passphrase or selected path was saved in workspace metadata.');
  }
  if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`);
  for (const client of stats.clients) client.end();
  await new Promise(resolve => server.close(resolve));
  await browser.close();
  console.log('Encrypted SSH key login, selected-key-only failure, saved PROD profile, and credential exclusion passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
