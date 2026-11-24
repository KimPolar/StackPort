/* Attach only to an isolated test instance. See docs/IMPLEMENTATION.md. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { execFileSync } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function postClose(pid) {
  if (!/^\d+$/.test(pid)) throw new Error('Set STACKPORT_TEST_WINDOW_PID to the isolated app PID.');
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class StackPortTestWindow { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'; $p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p.ProcessName -ne 'stackport' -or $p.MainWindowHandle -eq 0) { throw 'Invalid test window'; }; [StackPortTestWindow]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], { stdio: 'pipe' });
}

async function main() {
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (!page) throw new Error('No isolated WebView2 page found.');
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.getByRole('button', { name: '터미널', exact: true }).click();
  await page.getByRole('heading', { name: '터미널', exact: true }).waitFor();
  await page.getByRole('button', { name: 'CMD 열기', exact: true }).press('Enter');
  await page.getByRole('tab', { name: 'CMD 1' }).waitFor();
  const cmd = page.locator('[role=tabpanel]:visible .xterm-helper-textarea');
  await cmd.focus();
  await page.keyboard.type('set /a 137*193');
  await page.keyboard.press('Enter');
  await page.locator('[role=tabpanel]:visible .xterm-rows').getByText('26441', { exact: false }).waitFor();

  await page.getByRole('button', { name: 'PowerShell 열기', exact: true }).click();
  await page.getByRole('tab', { name: 'PowerShell 2' }).waitFor();
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type("[Console]::WriteLine('STACKPORT-PS-' + $PID)");
  await page.keyboard.press('Enter');
  const rows = page.locator('[role=tabpanel]:visible .xterm-rows');
  await rows.getByText(/STACKPORT-PS-\d+/).waitFor();
  const shellText = await rows.innerText();
  const shellPid = shellText.match(/STACKPORT-PS-(\d+)/)?.[1];
  if (!shellPid) throw new Error(`PowerShell PID missing: ${shellText}`);
  await verifyLocalDirectoryFollow(page);
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type("[Console]::WriteLine('");
  await page.keyboard.insertText('한글출력');
  await page.keyboard.type("')");
  await page.keyboard.press('Enter');
  await rows.locator(':scope > div').filter({ hasText: /^한글출력\s*$/ }).waitFor();
  await page.keyboard.type("[Console]::WriteLine(([char]27 + '[38;2;123;45;67m' + 'STACKPORT_COLOR' + [char]27 + '[0m'))");
  await page.keyboard.press('Enter');
  const colored = rows.locator(':scope > div').filter({ hasText: /^STACKPORT_COLOR\s*$/ }).getByText('STACKPORT_COLOR', { exact: true });
  await colored.waitFor();
  if (await colored.evaluate(element => getComputedStyle(element).color) !== 'rgb(123, 45, 67)') throw new Error('24-bit terminal color was not rendered.');
  await page.keyboard.type("[Console]::WriteLine('STACKPORT_SCROLLBACK_MARKER'); 1..150 | ForEach-Object { [Console]::WriteLine('STACKPORT_LINE_' + $_) }");
  await page.keyboard.press('Enter');
  await rows.getByText('STACKPORT_LINE_150', { exact: false }).waitFor();
  if ((await rows.innerText()).includes('STACKPORT_SCROLLBACK_MARKER')) throw new Error('Scrollback marker did not move off screen.');
  await page.getByRole('button', { name: /출력 찾기/ }).click();
  const search = page.getByLabel('터미널 출력 검색어');
  await search.fill('STACKPORT_SCROLLBACK_MARKER');
  await search.press('Enter');
  await page.getByRole('search').getByRole('status').getByText('일치하는 내용을 선택했습니다.').waitFor();
  await rows.getByText('STACKPORT_SCROLLBACK_MARKER', { exact: false }).first().waitFor();
  await search.fill('한글출력');
  await search.press('Enter');
  await page.getByRole('search').getByRole('status').getByText('일치하는 내용을 선택했습니다.').waitFor();
  await page.getByRole('button', { name: '이전 결과' }).click();
  await page.getByRole('search').getByRole('status').getByText('일치하는 내용을 선택했습니다.').waitFor();
  await search.fill('stackport_color');
  await page.getByLabel('대소문자 구분').check();
  await search.press('Enter');
  await page.getByRole('search').getByRole('status').getByText('일치하는 내용이 없습니다.').waitFor();
  await page.getByLabel('대소문자 구분').uncheck();
  await search.press('Enter');
  await page.getByRole('search').getByRole('status').getByText('일치하는 내용을 선택했습니다.').waitFor();
  await search.fill('[');
  await search.press('Enter');
  await page.getByRole('search').getByRole('status').getByText('일치하는 내용을 선택했습니다.').waitFor();
  if (process.env.STACKPORT_TEST_SCREENSHOT) await page.screenshot({ path: process.env.STACKPORT_TEST_SCREENSHOT });

  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type("[Console]::WriteLine(('W' * 215) + '");
  await page.keyboard.insertText('절');
  await page.keyboard.type("' + ('Q' * 175) + 'WRAPPED-TAIL')");
  await page.keyboard.press('Enter');
  await rows.getByText(/QWRAPPED-TAIL/).waitFor();
  await verifyTerminalOutput(page, Number(shellPid));

  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type("Start-Sleep -Seconds 2; [Console]::WriteLine('STACKPORT_BACKGROUND')");
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'PowerShell 2' }).focus();
  await page.keyboard.press('ArrowLeft');
  if (await page.getByRole('tab', { name: 'CMD 1' }).getAttribute('aria-selected') !== 'true') throw new Error('Keyboard tab navigation failed.');
  const backgroundTab = page.getByRole('tab', { name: 'PowerShell 2' });
  const activity = backgroundTab.getByText('새 출력', { exact: true });
  await activity.waitFor();
  if (!(await backgroundTab.getAttribute('aria-describedby'))) throw new Error('Background activity is not described to assistive technology.');
  if (await page.getByRole('tab', { name: 'CMD 1' }).getByText('새 출력').count()) throw new Error('Visible terminal was marked as having unread output.');
  if (await page.locator('[role=tabpanel]:visible').getByLabel('터미널 출력 검색어').count()) throw new Error('Search state leaked into another terminal tab.');
  await page.locator('[role=tabpanel]:visible .xterm-rows').getByText('26441', { exact: false }).waitFor();
  await backgroundTab.click();
  await activity.waitFor({ state: 'detached' });
  await page.locator('[role=tabpanel]:visible .xterm-rows').getByText('STACKPORT_BACKGROUND', { exact: false }).last().waitFor();
  if (await page.getByLabel('터미널 출력 검색어').inputValue() !== '[') throw new Error('Search state did not follow its terminal tab.');
  await page.getByLabel('터미널 출력 검색어').press('Escape');
  if (await page.getByLabel('터미널 출력 검색어').count()) throw new Error('Escape did not close terminal search.');
  await page.keyboard.press('Control+Shift+F');
  await page.getByLabel('터미널 출력 검색어').waitFor();
  if (await page.getByLabel('터미널 출력 검색어').inputValue() !== '') throw new Error('Closed search retained its previous term.');
  await page.getByRole('button', { name: '검색 닫기' }).click();
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type("Start-Sleep -Seconds 2; [Console]::WriteLine('STACKPORT_HIDDEN')");
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
  const terminalTool = page.getByRole('navigation', { name: '작업 도구' }).getByRole('button', { name: '터미널', exact: true });
  if (await terminalTool.getAttribute('aria-description') !== '열린 세션 2개') throw new Error('Open terminal tabs were not shown across workspace tools.');
  const hiddenActivity = page.locator('[role=tab]').filter({ hasText: 'PowerShell 2' }).getByText('새 출력', { exact: true });
  await hiddenActivity.waitFor({ state: 'attached' });
  await page.getByRole('contentinfo', { name: '작업 공간 상태' }).getByRole('button', { name: '터미널 탭 2개', exact: true }).press('Enter');
  await hiddenActivity.waitFor({ state: 'detached' });
  await page.locator('[role=tabpanel]:visible .xterm-rows').getByText('STACKPORT_HIDDEN', { exact: false }).last().waitFor();
  const terminalInput = page.locator('[role=tabpanel]:visible .xterm-helper-textarea');
  await terminalInput.focus();
  await page.keyboard.press('Control+Shift+P');
  await page.getByRole('dialog', { name: '명령 팔레트', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '명령 팔레트', exact: true }).waitFor({ state: 'hidden' });
  const split = page.getByRole('button', { name: '화면 분할', exact: true });
  await split.click();
  await page.getByRole('separator', { name: '터미널 창 크기', exact: true }).waitFor();
  await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
  await page.getByRole('separator', { name: '데이터베이스 창 크기', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'PowerShell 2', selected: true }).waitFor();
  await page.getByText('배치 설정', { exact: true }).click();
  await page.getByRole('button', { name: '2×2 배치', exact: true }).click();
  await page.getByLabel('편집할 영역', { exact: true }).selectOption('terminal');
  await page.getByRole('button', { name: '영역 닫기', exact: true }).click();
  await page.getByRole('tab', { name: 'PowerShell 2' }).waitFor({ state: 'hidden' });
  await page.getByText('배치 설정', { exact: true }).press('Escape');
  await split.click();
  await page.getByRole('tab', { name: 'PowerShell 2' }).waitFor({ state: 'hidden' });
  await terminalTool.click();
  await page.locator('[role=tabpanel]:visible .xterm-rows').getByText('STACKPORT_HIDDEN', { exact: false }).last().waitFor();
  await page.getByRole('button', { name: 'SSH 연결', exact: true }).click();
  await page.keyboard.press('Control+Shift+F');
  if (await page.getByLabel('터미널 출력 검색어').count()) throw new Error('Search shortcut opened behind an SSH dialog.');
  await page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();
  await page.getByRole('tab', { name: 'CMD 1' }).click();
  let pasteMessage = '';
  page.once('dialog', async dialog => { pasteMessage = dialog.message(); await dialog.dismiss(); });
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').evaluate(input => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', 'set /a 198+703\r\nset /a 600+302\r\n');
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  if (!pasteMessage.includes('여러 줄')) throw new Error(`Paste confirmation missing: ${pasteMessage}`);
  await page.waitForTimeout(300);
  if ((await page.locator('[role=tabpanel]:visible .xterm-rows').innerText()).includes('901')) throw new Error('Rejected multiline paste was executed.');
  await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
  await page.getByRole('button', { name: '터미널', exact: true }).click();
  await page.locator('[role=tabpanel]:visible .xterm-rows').getByText('26441', { exact: false }).waitFor();

  const cmdTab = page.getByRole('tab', { name: 'CMD 1', exact: true });
  const powershellTab = page.getByRole('tab', { name: 'PowerShell 2', exact: true });
  const tabOrder = () => page.locator('.terminal-tabs [role="tab"]')
    .evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')).join(','));
  await powershellTab.press('Alt+ArrowLeft');
  if (await tabOrder() !== 'PowerShell 2,CMD 1') throw new Error('Keyboard reorder did not move the terminal tab.');
  await powershellTab.dragTo(cmdTab);
  if (await tabOrder() !== 'CMD 1,PowerShell 2') throw new Error('Dragging did not reorder the terminal tab.');
  await powershellTab.press('Shift+F10');
  const tabManager = page.getByRole('dialog', { name: '터미널 탭 관리', exact: true });
  await tabManager.getByRole('button', { name: '탭 고정', exact: true }).click();
  if (await tabOrder() !== 'PowerShell 2,CMD 1') throw new Error('Pinning did not move the tab into the pinned group.');
  if (!await tabManager.getByRole('button', { name: '오른쪽으로 이동', exact: true }).isDisabled()) throw new Error('A pinned tab could leave its group without unpinning.');
  await tabManager.getByRole('button', { name: '고정 해제', exact: true }).click();
  await tabManager.getByRole('button', { name: '오른쪽으로 이동', exact: true }).click();
  await page.keyboard.press('Escape');
  await tabManager.waitFor({ state: 'hidden' });
  await cmdTab.click();
  await page.locator('[role=tabpanel]:visible .xterm-rows').getByText('26441', { exact: false }).waitFor();

  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'CMD 1 터미널 닫기' }).click();
  await page.getByRole('tab', { name: 'CMD 1' }).waitFor();
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type('exit /b 7');
  await page.keyboard.press('Enter');
  await page.getByRole('status').getByText('셸이 종료되었습니다. 종료 코드: 7').waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'CMD 1 터미널 닫기' }).click();
  await page.getByRole('tab', { name: 'CMD 1' }).waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'PowerShell 2' }).waitFor();

  const manageTabs = page.getByRole('button', { name: '터미널 탭 관리', exact: true });
  await manageTabs.click();
  await tabManager.getByRole('button', { name: 'CMD 1 다시 열기', exact: true }).click();
  await page.getByRole('tab', { name: 'CMD 3', exact: true, selected: true }).waitFor();
  const reopenedRows = page.locator('[role=tabpanel]:visible .xterm-rows');
  await reopenedRows.getByText(/Microsoft Windows/).waitFor();
  if ((await reopenedRows.innerText()).includes('26441')) throw new Error('Reopening restored the closed shell output.');
  await manageTabs.click();
  if (await tabManager.getByRole('button', { name: 'CMD 1 다시 열기', exact: true }).count()) throw new Error('A reopened entry stayed in recent history.');
  await tabManager.getByRole('button', { name: '탭 복제', exact: true }).click();
  await page.getByRole('tab', { name: 'CMD 4', exact: true, selected: true }).waitFor();
  await powershellTab.press('Shift+F10');
  await tabManager.getByRole('button', { name: '탭 고정', exact: true }).click();
  const closeUnpinned = tabManager.getByRole('button', { name: '고정하지 않은 탭 닫기 (2)', exact: true });
  const dismissBulk = page.waitForEvent('dialog').then(async dialog => {
    if (!dialog.message().includes('CMD 3') || !dialog.message().includes('CMD 4') || dialog.message().includes('PowerShell 2')) {
      await dialog.dismiss();
      throw new Error('Bulk close preview did not match the unpinned tabs.');
    }
    await dialog.dismiss();
  });
  await closeUnpinned.click();
  await dismissBulk;
  if (await tabOrder() !== 'PowerShell 2,CMD 3,CMD 4') throw new Error('Canceling bulk close removed tabs.');
  page.once('dialog', dialog => dialog.accept());
  await closeUnpinned.click();
  await page.getByRole('tab', { name: 'CMD 4', exact: true }).waitFor({ state: 'detached' });
  await powershellTab.waitFor();
  if (await tabOrder() !== 'PowerShell 2') throw new Error('Bulk close did not leave exactly the pinned tab.');

  if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`);
  if (process.env.STACKPORT_TEST_WINDOW_PID) {
    let dialogText = '';
    page.once('dialog', async dialog => { dialogText = dialog.message(); await dialog.dismiss(); });
    postClose(process.env.STACKPORT_TEST_WINDOW_PID);
    await page.waitForTimeout(700);
    if (!dialogText.includes('열린 터미널')) throw new Error(`Close confirmation missing: ${dialogText}`);
    if (process.env.STACKPORT_EXPECT_DRAFT_CLOSE && !dialogText.includes('SQL 초안')) throw new Error(`Unsaved SQL warning missing: ${dialogText}`);
    if (page.isClosed()) throw new Error('Dismissing the close confirmation still closed the window.');
    page.once('dialog', dialog => dialog.accept());
    const closed = page.waitForEvent('close', { timeout: 15000 });
    postClose(process.env.STACKPORT_TEST_WINDOW_PID);
    await closed;
    await new Promise(resolve => setTimeout(resolve, 600));
    const alive = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `if (Get-Process -Id ${shellPid} -ErrorAction SilentlyContinue) { 'alive' }`], { encoding: 'utf8' }).trim();
    if (alive) throw new Error('Closing the app left its PowerShell process running.');
  } else {
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'PowerShell 2 터미널 닫기' }).click();
    await browser.close();
  }
  console.log('Desktop terminals, directory follow, scrollback search, TXT/ANSI export, tabs, process cleanup, and close protection passed.');
}

async function verifyLocalDirectoryFollow(page) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackport-cwd-'));
  const nested = path.join(root, '폴더 % #');
  fs.mkdirSync(nested);
  const local = page.getByRole('region', { name: '로컬 파일', exact: true });
  const address = local.getByLabel('로컬 파일 경로');
  const follow = local.getByRole('checkbox', { name: '터미널 경로 따라가기' });
  const tools = page.getByRole('navigation', { name: '작업 도구' });
  const files = tools.getByRole('button', { name: '파일 탐색', exact: true });
  const terminal = tools.getByRole('button', { name: '터미널', exact: true });
  const input = page.locator('[role=tabpanel]:visible .xterm-helper-textarea');
  const rows = page.locator('[role=tabpanel]:visible .xterm-rows');
  async function run(source, marker) {
    await terminal.click();
    await input.focus();
    await page.keyboard.insertText(`${source}; Write-Output ('${marker.slice(0, -1)}' + '${marker.at(-1)}')`);
    await page.keyboard.press('Enter');
    await rows.getByText(marker, { exact: true }).waitFor();
    await files.click();
  }
  const change = value => `Set-Location -LiteralPath '${value.replaceAll("'", "''")}'`;
  const waitForPath = value => address.evaluate((input, value) => input.value === value, value);

  await run(change(root), 'CWD_ROOT_READY');
  if (await follow.isChecked() || await address.inputValue()) throw new Error('The file pane followed PowerShell without opt-in.');
  await follow.check();
  await local.getByRole('button', { name: '폴더 % #', exact: true }).waitFor();
  await run(change(nested), 'CWD_NESTED_READY');
  await page.waitForFunction(value => document.querySelector('[aria-label="로컬 파일 경로"]').value === value, nested);
  await run("[Console]::Write([char]27 + ']7;file:///C:/untrusted' + [char]7)", 'CWD_UNRELATED_READY');
  if (!await waitForPath(nested)) throw new Error('An unrelated terminal sequence changed the local directory.');
  await run('Set-Location HKCU:', 'CWD_REGISTRY_READY');
  await local.getByRole('status').getByText(/활성 PowerShell의 폴더 경로를 기다리는 중/).waitFor();
  await follow.uncheck();
  await run(change(root), 'CWD_DISABLED_READY');
  if (!await waitForPath(nested)) throw new Error('The file pane followed PowerShell after being disabled.');
  await terminal.click();
}

async function verifyTerminalOutput(page, shellPid) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackport-output-'));
  const plain = path.join(root, 'powershell.txt');
  const styled = path.join(root, 'powershell.ansi');
  const dialog = page.getByRole('dialog', { name: '터미널 출력 저장' });
  const open = page.getByRole('button', { name: '출력 저장', exact: true });
  const destination = dialog.getByLabel('새 출력 파일 경로');
  const save = dialog.getByRole('button', { name: '저장', exact: true });
  const saved = page.getByRole('status').getByText('출력을 저장했습니다.', { exact: true });
  try {
    await open.click();
    await dialog.getByText('PowerShell 2', { exact: true }).waitFor();
    await destination.fill(plain);
    await save.click();
    await saved.waitFor();
    const text = fs.readFileSync(plain, 'utf8');
    const lines = text.split('\r\n');
    if (!lines.includes(`STACKPORT-PS-${shellPid}`) || !lines.includes('한글출력') || !lines.includes('STACKPORT_COLOR') || !lines.includes('STACKPORT_SCROLLBACK_MARKER')) {
      throw new Error('TXT export lost scrollback, Unicode, or rendered output.');
    }
    if (!lines.includes(`${'W'.repeat(215)}절${'Q'.repeat(175)}WRAPPED-TAIL`)) throw new Error('TXT export broke a wrapped output line.');
    if (text.includes('\u001b') || lines.includes('26441')) throw new Error('TXT included ANSI controls or another terminal tab.');

    await open.click();
    await destination.fill(plain);
    await save.click();
    await dialog.getByRole('alert').getByText(/같은 이름/).waitFor();
    await dialog.getByLabel('파일 형식').selectOption('ansi');
    if (await destination.inputValue() !== styled) throw new Error('Changing export format did not switch the output extension.');
    await save.click();
    await saved.waitFor();
    const ansi = fs.readFileSync(styled, 'utf8');
    if (!ansi.includes('\u001b[38;2;123;45;67mSTACKPORT_COLOR') || !ansi.includes('STACKPORT_SCROLLBACK_MARKER')) {
      throw new Error('ANSI export lost color or scrollback.');
    }
    if (fs.readFileSync(plain, 'utf8') !== text) throw new Error('An existing snapshot was overwritten.');
  } finally {
    for (const file of [plain, styled]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
}

main().catch(error => { console.error(error); process.exit(1); });
