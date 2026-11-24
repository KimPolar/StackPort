/* Use only an isolated StackPort instance with its own application data directory. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const assert = require('node:assert/strict');

const dataDirectory = process.env.STACKPORT_DATA_DIR;
const windowPid = Number(process.env.STACKPORT_TEST_WINDOW_PID);

function powershell(source, env = {}) {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', source], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000,
  }).trim();
}

function processCommand(pid) {
  const output = powershell(`Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`);
  return output ? JSON.parse(output) : null;
}

function profiles() {
  return fs.readdirSync(dataDirectory).filter(file => /^\.stackport-rdp-.*\.rdp$/.test(file)).map(file => {
    const filePath = path.join(dataDirectory, file);
    const data = fs.readFileSync(filePath);
    assert.equal(data.readUInt16LE(0), 0xfeff);
    return { filePath, lines: data.subarray(2).toString('utf16le').split('\r\n') };
  });
}

async function waitUntil(predicate, description) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(description);
}

async function main() {
  assert.ok(dataDirectory && path.isAbsolute(dataDirectory));
  assert.ok(Number.isSafeInteger(windowPid) && windowPid > 0);
  assert.equal(profiles().length, 0);
  const sockets = new Set();
  const makeServer = () => net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  const first = makeServer();
  const second = makeServer();
  first.listen(0, '127.0.0.1');
  second.listen(0, '127.0.0.1');
  await Promise.all([once(first, 'listening'), once(second, 'listening')]);
  const firstAddress = `127.0.0.1:${first.address().port}`;
  const secondAddress = `127.0.0.1:${second.address().port}`;
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const pids = [];

  async function openClient(address, port) {
    await page.getByLabel('포트', { exact: true }).fill(String(port));
    await page.getByRole('button', { name: 'Windows RDP 열기' }).click();
    const row = page.getByRole('region', { name: '열린 RDP 클라이언트' }).getByRole('listitem').filter({ hasText: address });
    await row.waitFor();
    const pid = Number((await row.textContent()).match(/PID (\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const profile = profiles().find(({ lines }) => lines.includes(`full address:s:${address}`));
    assert.ok(profile);
    pids.push({ pid, profile: profile.filePath });
    const native = processCommand(pid);
    assert.equal(native?.Name.toLowerCase(), 'mstsc.exe');
    assert.ok(native.ExecutablePath.toLowerCase().endsWith('\\system32\\mstsc.exe'));
    assert.ok(native.CommandLine.includes(profile.filePath));
    assert.match(native.CommandLine, /\/prompt.*\/public/);
    return { row, pid, profile, native };
  }

  try {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.getByRole('button', { name: '원격 화면', exact: true }).click();
    await page.getByRole('heading', { name: '원격 데스크톱 (RDP)' }).waitFor();
    await page.getByLabel('대상 호스트 또는 IP').fill('127.0.0.1');
    await page.getByLabel('사용자 이름 (선택)').fill('테스트 사용자');
    await page.getByLabel('도메인 (선택)').fill('LAB');
    await page.getByLabel('포트', { exact: true }).fill(String(first.address().port));
    const displaySettings = page.locator('summary').filter({ hasText: '화면 설정' });
    const width = page.getByLabel('가로 (픽셀)');
    await width.waitFor({ state: 'hidden' });
    await displaySettings.click();
    await width.fill('100');
    await displaySettings.click();
    await page.getByRole('button', { name: 'Windows RDP 열기' }).click();
    await width.waitFor({ state: 'visible' });
    assert.equal(profiles().length, 0);
    await width.fill('1280');
    await displaySettings.click();
    await page.getByText('인증·리디렉션·입력 설정').click();
    await page.getByLabel('공유할 드라이브').fill('*');
    await page.getByRole('button', { name: 'Windows RDP 열기' }).click();
    await page.getByRole('alert').getByText(/드라이브 문자/).waitFor();
    assert.equal(profiles().length, 0);
    await page.getByLabel('공유할 드라이브').clear();

    const window = await openClient(firstAddress, first.address().port);
    for (const expected of ['username:s:테스트 사용자', 'domain:s:LAB', 'authentication level:i:1', 'enablecredsspsupport:i:1', 'screen mode id:i:1', 'desktopwidth:i:1280', 'redirectclipboard:i:0', 'drivestoredirect:s:']) {
      assert.ok(window.profile.lines.includes(expected), expected);
    }
    assert.doesNotMatch(window.native.CommandLine, /\/admin/);

    await page.setViewportSize({ width: 1440, height: 900 });
    await displaySettings.click();
    await page.getByLabel('화면 모드').selectOption('multiple_monitors');
    await page.getByLabel('색 깊이').selectOption('24');
    await page.getByLabel('관리 콘솔 세션').check();
    await page.getByLabel('클립보드 공유').check();
    await page.getByLabel('공유할 드라이브').fill('C:, D:');
    const multiple = await openClient(secondAddress, second.address().port);
    assert.notEqual(window.pid, multiple.pid);
    assert.match(multiple.native.CommandLine, /\/admin/);
    for (const expected of ['screen mode id:i:2', 'use multimon:i:1', 'session bpp:i:24', 'redirectclipboard:i:1', 'drivestoredirect:s:C:\\;D:\\;']) {
      assert.ok(multiple.profile.lines.includes(expected), expected);
    }
    assert.equal(profiles().length, 2);
    const status = page.getByRole('contentinfo', { name: '작업 공간 상태' });
    await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
    await status.getByRole('button', { name: 'RDP 창 2개', exact: true }).click();
    await multiple.row.waitFor();
    await window.row.getByRole('button', { name: `${firstAddress} 연결 끊기` }).click();
    await window.row.waitFor({ state: 'detached' });
    await status.getByRole('button', { name: 'RDP 창 1개', exact: true }).waitFor();
    await waitUntil(() => !processCommand(window.pid), 'The disconnected native RDP process did not exit.');
    assert.equal(fs.existsSync(window.profile.filePath), false);
    assert.ok(fs.existsSync(multiple.profile.filePath));
    assert.ok(processCommand(multiple.pid));

    await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
    const confirmation = page.waitForEvent('dialog');
    const closed = page.waitForEvent('close', { timeout: 15000 });
    powershell(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TestRdpWindow { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'; $p = Get-Process -Id ${windowPid} -ErrorAction Stop; if ($p.ProcessName -ne 'stackport' -or $p.MainWindowHandle -eq 0) { throw 'Invalid isolated StackPort window' }; [TestRdpWindow]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`);
    const prompt = await confirmation;
    assert.match(prompt.message(), /열린 RDP 클라이언트 1개/);
    await prompt.accept();
    await closed;
    await waitUntil(() => !processCommand(multiple.pid), 'Exiting StackPort did not close its RDP client.');
    assert.equal(profiles().length, 0);
    assert.deepEqual(errors, []);
    console.log('Two native Windows RDP clients, settings validation, independent disconnect and exit cleanup passed.');
  } finally {
    for (const { pid, profile } of pids) {
      const local = processCommand(pid);
      if (local?.Name.toLowerCase() === 'mstsc.exe' && local.CommandLine.includes(profile)) {
        powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'mstsc') { Stop-Process -InputObject $p }`);
      }
    }
    for (const socket of sockets) socket.destroy();
    first.close();
    second.close();
    await browser.close().catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exit(1); });
