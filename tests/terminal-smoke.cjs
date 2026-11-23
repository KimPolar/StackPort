/* Attach only to an isolated test instance. See docs/IMPLEMENTATION.md. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { execFileSync } = require('child_process');

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
  await page.getByRole('heading', { name: '로컬 터미널' }).waitFor();
  await page.getByLabel('셸', { exact: true }).selectOption('cmd');
  await page.getByRole('button', { name: '새 터미널' }).click();
  await page.getByRole('tab', { name: 'CMD 1' }).waitFor();
  const cmd = page.locator('[role=tabpanel]:visible .xterm-helper-textarea');
  await cmd.focus();
  await page.keyboard.type('set /a 137*193');
  await page.keyboard.press('Enter');
  await page.locator('[role=tabpanel]:visible .xterm-rows').getByText('26441', { exact: false }).waitFor();

  await page.getByLabel('셸', { exact: true }).selectOption('powershell');
  await page.getByRole('button', { name: '새 터미널' }).click();
  await page.getByRole('tab', { name: 'PowerShell 2' }).waitFor();
  await page.locator('[role=tabpanel]:visible .xterm-helper-textarea').focus();
  await page.keyboard.type("[Console]::WriteLine('STACKPORT-PS-' + $PID)");
  await page.keyboard.press('Enter');
  const rows = page.locator('[role=tabpanel]:visible .xterm-rows');
  await rows.getByText(/STACKPORT-PS-\d+/).waitFor();
  const shellText = await rows.innerText();
  const shellPid = shellText.match(/STACKPORT-PS-(\d+)/)?.[1];
  if (!shellPid) throw new Error(`PowerShell PID missing: ${shellText}`);
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
  if (process.env.STACKPORT_TEST_SCREENSHOT) await page.screenshot({ path: process.env.STACKPORT_TEST_SCREENSHOT });

  await page.getByRole('tab', { name: 'PowerShell 2' }).focus();
  await page.keyboard.press('ArrowLeft');
  if (await page.getByRole('tab', { name: 'CMD 1' }).getAttribute('aria-selected') !== 'true') throw new Error('Keyboard tab navigation failed.');
  await page.locator('[role=tabpanel]:visible .xterm-rows').getByText('26441', { exact: false }).waitFor();
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
  await page.getByRole('button', { name: '워크스페이스', exact: true }).click();
  await page.getByRole('button', { name: '터미널', exact: true }).click();
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
  console.log('Desktop local terminals, input, tabs, process cleanup, and close protection passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
