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
const challengePassword = 'stackport-challenge-secret';
const challengeCode = '295810';
const location = 'test-zone';

function hostKey() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const publicKey = utils.parseKey(privateKey).getPublicSSH();
  return { privateKey, fingerprint: `SHA256:${createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '')}` };
}

async function startServer(key, port = 0, interactive = false) {
  const stats = { connections: 0, authentications: 0, passwordAttempts: 0, challengeAttempts: 0, sessions: 0, clients: new Set() };
  const server = new Server({ hostKeys: [key.privateKey] }, client => {
    stats.connections++; stats.clients.add(client);
    client.on('error', () => {});
    client.on('close', () => stats.clients.delete(client));
    client.on('authentication', ctx => {
      stats.authentications++;
      if (ctx.method === 'password') stats.passwordAttempts++;
      if (ctx.method === 'password' && ctx.username === 'stackport' && ctx.password === password) ctx.accept();
      else if (interactive && ctx.method === 'keyboard-interactive' && ctx.username === 'stackport') {
        stats.challengeAttempts++;
        ctx.prompt([
          { prompt: 'Access phrase: ', echo: false },
          { prompt: 'Location label: ', echo: true },
        ], 'StackPort test login', 'Synthetic MFA instructions', responses => {
          if (!Array.isArray(responses)) return;
          if (responses[0] !== challengePassword || responses[1] !== location) {
            ctx.reject(['keyboard-interactive', 'password']);
            return;
          }
          ctx.prompt({ prompt: 'Verification code: ', echo: false }, codes => {
            if (!Array.isArray(codes)) return;
            if (codes[0] === challengeCode) ctx.accept();
            else ctx.reject(['keyboard-interactive', 'password']);
          });
        });
      } else ctx.reject(interactive ? ['keyboard-interactive', 'password'] : ['password']);
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

  // The network test opens TCP only; it must not try SSH authentication.
  await page.getByRole('button', { name: 'SSH 연결', exact: true }).click();
  await page.getByLabel('호스트 또는 IP').fill('127.0.0.1');
  await page.getByLabel('포트', { exact: true }).fill(String(instance.port));
  await page.getByRole('button', { name: 'DNS·TCP 진단' }).click();
  const diagnostic = page.getByRole('status', { name: '연결 진단 결과' });
  await diagnostic.getByText(/IP 주소 · DNS 조회 불필요/).waitFor();
  await diagnostic.getByText(/TCP 연결 성공/).first().waitFor();
  await diagnostic.getByText(/SSH 호스트 키, 인증 및 서버 권한은 검사하지 않았습니다/).waitFor();
  await page.getByLabel('호스트 또는 IP').fill('localhost');
  await diagnostic.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'DNS·TCP 진단' }).click();
  await diagnostic.getByText(/이름 조회 성공/).waitFor();
  await diagnostic.getByText(/TCP 연결 성공/).first().waitFor();
  if (instance.stats.authentications !== 0) throw new Error('Network diagnosis attempted SSH authentication.');
  await page.getByRole('button', { name: '닫기', exact: true }).click();

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

  // Saved connections retain their environment and cannot be opened with a
  // stale snapshot or without the server-side PROD confirmation.
  await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByLabel('이름', { exact: true }).fill('SSH 프로필 검증');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: 'SSH 연결 추가' }).click();
  await page.getByLabel('연결 이름').fill('운영 서버');
  await page.getByLabel('호스트 또는 IP').fill('127.0.0.1');
  await page.getByLabel('포트', { exact: true }).fill(String(instance.port));
  await page.getByLabel('사용자 이름').fill('stackport');
  await page.getByRole('dialog').locator('select').selectOption('PROD');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: 'SSH 운영 서버 연결' }).waitFor();
  const project = await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_projects')).find(item => item.name === 'SSH 프로필 검증'));
  const originalProfile = await page.evaluate(async projectId => (await window.__TAURI_INTERNALS__.invoke('list_ssh_profiles', { projectId }))[0], project.id);
  const beforeBlocked = instance.stats.connections;
  const deniedProd = await page.evaluate(async profile => {
    try { await window.__TAURI_INTERNALS__.invoke('open_saved_ssh_terminal', { profile, confirmation: '', rows: 24, cols: 80 }); return ''; }
    catch (error) { return String(error); }
  }, originalProfile);
  if (!deniedProd.includes('PROD') || instance.stats.connections !== beforeBlocked) throw new Error(`PROD confirmation was bypassed: ${deniedProd}`);

  await page.getByRole('button', { name: '운영 서버 SSH 연결 수정' }).click();
  await page.getByLabel('연결 이름').fill('운영 SSH');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: 'SSH 운영 SSH 연결' }).waitFor();
  const staleResult = await page.evaluate(async profile => {
    try { await window.__TAURI_INTERNALS__.invoke('open_saved_ssh_terminal', { profile, confirmation: 'PROD', rows: 24, cols: 80 }); return ''; }
    catch (error) { return String(error); }
  }, originalProfile);
  if (!staleResult.includes('변경') || instance.stats.connections !== beforeBlocked) throw new Error(`Stale connection snapshot was accepted: ${staleResult}`);

  await page.getByRole('button', { name: 'SSH 운영 SSH 연결' }).click();
  await page.getByRole('heading', { name: 'SSH 연결', exact: true }).waitFor();
  await page.getByLabel('파일 탐색 함께 열기').uncheck();
  if (!await page.getByLabel('호스트 또는 IP').isDisabled() || !await page.getByLabel('사용자 이름').isDisabled()) throw new Error('Saved connection target was editable in the confirmation dialog.');
  await page.getByRole('button', { name: '지문 확인' }).click();
  await page.getByText(changedKey.fingerprint, { exact: true }).waitFor();
  if (!await page.getByRole('button', { name: '연결', exact: true }).isDisabled()) throw new Error('PROD confirmation was not required in the UI.');
  await page.getByLabel('운영 환경 확인: PROD 입력').fill('PROD');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 6/ }).waitFor();
  await page.locator('.terminal-remote').getByText(/PROD/).waitFor();
  await waitForRows(page, 'password:');
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');
  await waitForRows(page, 'STACKPORT_REMOTE_READY');
  const manage = page.getByRole('button', { name: '터미널 탭 관리', exact: true });
  const tabsDialog = page.getByRole('dialog', { name: '터미널 탭 관리', exact: true });
  const beforeDuplicate = instance.stats.connections;
  await manage.click();
  await tabsDialog.getByRole('button', { name: '탭 복제', exact: true }).click();
  const duplicateDialog = page.getByRole('dialog', { name: 'SSH 연결', exact: true });
  await duplicateDialog.getByText('운영 SSH', { exact: true }).waitFor();
  await duplicateDialog.getByRole('button', { name: '지문 확인', exact: true }).waitFor();
  if (instance.stats.connections !== beforeDuplicate || !await duplicateDialog.getByLabel('호스트 또는 IP').isDisabled()) {
    throw new Error('Duplicating the saved profile opened an unchecked connection.');
  }
  await duplicateDialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
  await page.getByRole('button', { name: '운영 SSH SSH 연결 삭제' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('button', { name: 'SSH 운영 SSH 연결' }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '터미널', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 6/ }).waitFor();
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await waitForRows(page, 'STACKPORT_REMOTE_ECHO');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 6 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 6/ }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '최근 닫은 탭', exact: true }).click();
  await tabsDialog.getByRole('button', { name: /SSH 6 .*다시 열기/ }).click();
  await page.getByRole('alert').getByText('저장된 SSH 연결을 찾을 수 없습니다.', { exact: true }).waitFor();
  if (instance.stats.connections !== beforeDuplicate) throw new Error('A deleted SSH profile was reopened.');
  if (fs.readFileSync(path.join(root, 'workspace', 'workspace.sqlite')).includes(Buffer.from(password))) throw new Error('Password was saved in the workspace database.');

  const trustDb = new DatabaseSync(trustFile, { readOnly: true });
  const events = trustDb.prepare('SELECT action, previous_fingerprint, fingerprint FROM trust_events ORDER BY rowid').all();
  trustDb.close();
  if (events.length !== 2 || events[0].action !== 'accepted' || events[0].fingerprint !== originalKey.fingerprint || events[1].action !== 'replaced' || events[1].previous_fingerprint !== originalKey.fingerprint || events[1].fingerprint !== changedKey.fingerprint) throw new Error('Host-key trust history is incorrect.');
  await stopServer(instance);
  instance = await startServer(originalKey, instance.port);
  await openDialog(page, instance.port);
  await page.getByText(changedKey.fingerprint, { exact: true }).waitFor();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 7/ }).waitFor();
  await waitForRows(page, 'REMOTE HOST IDENTIFICATION HAS CHANGED', 20000);
  if (instance.stats.authentications !== 0) throw new Error('Old key remained trusted after replacement.');
  await page.getByRole('status').getByText(/종료 코드: 255/).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /SSH 7 .*터미널 닫기/ }).click();
  await page.getByRole('tab', { name: /SSH 7/ }).waitFor({ state: 'detached' });
  if (fs.readdirSync(path.join(root, 'workspace')).some(name => name.startsWith('.stackport-known-hosts-'))) throw new Error('Temporary host-key pin file was not removed.');
  await page.getByRole('button', { name: '작업 기록' }).click();
  await page.locator('.ssh-history > summary').click();
  await page.getByText('호스트 키 교체', { exact: true }).waitFor();
  await page.getByText('호스트 키 신뢰', { exact: true }).waitFor();
  const historyText = await page.locator('.ssh-history').innerText();
  if (!historyText.includes('127.0.0.1') || historyText.includes(password) || historyText.includes('wrong-password')) throw new Error('SSH trust history did not protect credentials.');

  await stopServer(instance);
  instance = await startServer(changedKey, instance.port, true);
  await page.getByRole('button', { name: '터미널', exact: true }).click();
  const loginDialog = page.getByRole('dialog');
  async function startInteractive(tabNumber) {
    await openDialog(page, instance.port);
    await loginDialog.getByText(changedKey.fingerprint, { exact: true }).waitFor();
    await page.getByLabel('SSH 인증 방식').selectOption('keyboard_interactive');
    await page.getByRole('button', { name: '연결', exact: true }).click();
    await page.getByRole('tab', { name: new RegExp(`SSH ${tabNumber} ·`) }).waitFor();
    await waitForRows(page, 'Synthetic MFA instructions');
  }
  async function answer(prompt, value) {
    await waitForRows(page, prompt);
    await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  }
  async function closeInteractive(tabNumber) {
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: new RegExp(`SSH ${tabNumber} .*터미널 닫기`) }).click();
    await page.getByRole('tab', { name: new RegExp(`SSH ${tabNumber} ·`) }).waitFor({ state: 'detached' });
  }

  await startInteractive(8);
  await answer('Access phrase:', challengePassword);
  await answer('Location label:', location);
  await answer('Verification code:', challengeCode);
  await waitForRows(page, 'STACKPORT_REMOTE_READY');
  const challengeOutput = await page.locator('[role=tabpanel]:visible .xterm-rows').innerText();
  if (challengeOutput.includes(challengePassword) || challengeOutput.includes(challengeCode) || !challengeOutput.includes(location)) throw new Error('SSH did not honor the prompt echo settings.');
  await closeInteractive(8);

  await startInteractive(9);
  await answer('Access phrase:', 'wrong-challenge-phrase');
  await answer('Location label:', location);
  await page.getByRole('status').getByText(/종료 코드: 255/).waitFor();
  if (instance.stats.challengeAttempts !== 2 || instance.stats.passwordAttempts !== 0 || instance.stats.sessions !== 1) throw new Error('SSH repeated or fell back after an interactive failure.');
  await closeInteractive(9);

  await openDialog(page, instance.port);
  await loginDialog.getByText(changedKey.fingerprint, { exact: true }).waitFor();
  await page.getByLabel('SSH 인증 방식').selectOption('password');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: /SSH 10 ·/ }).waitFor();
  await answer('password:', password);
  await waitForRows(page, 'STACKPORT_REMOTE_READY');
  if (instance.stats.passwordAttempts !== 1 || instance.stats.challengeAttempts !== 2) throw new Error('Password-only mode tried the interactive method.');
  await closeInteractive(10);
  for (const file of [trustFile, path.join(root, 'workspace', 'workspace.sqlite')]) {
    const bytes = fs.readFileSync(file);
    if ([challengePassword, challengeCode].some(secret => bytes.includes(Buffer.from(secret)))) throw new Error('Interactive SSH answers were saved.');
  }
  if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`);
  await stopServer(instance);
  await browser.close();
  console.log('DNS/TCP diagnosis, SSH host-key verification, saved PROD profiles, password login, and multi-round keyboard-interactive login passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
