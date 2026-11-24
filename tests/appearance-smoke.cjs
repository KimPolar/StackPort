/* Run write and read in separate isolated StackPort processes with one WebView2 profile. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

async function expectScheme(page, scheme) {
  await page.waitForFunction(expected =>
    document.documentElement.dataset.colorScheme === expected &&
    getComputedStyle(document.documentElement).colorScheme === expected, scheme);
}

async function expectNativeTheme(page, scheme) {
  await page.waitForFunction(async expected => {
    return await window.__TAURI_INTERNALS__.invoke('plugin:window|theme', { label: 'main' }) === expected;
  }, scheme);
}

async function useSettings(page) {
  await page.getByRole('button', { name: '화면 설정', exact: true }).click();
  return page.getByRole('dialog', { name: '화면 설정', exact: true });
}

async function closeSettings(page, dialog) {
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
}

async function expectTerminalColors(page, scheme) {
  const surface = scheme === 'dark' ? 'rgb(23, 37, 35)' : 'rgb(252, 254, 252)';
  const foreground = scheme === 'dark' ? 'rgb(228, 241, 233)' : 'rgb(36, 60, 50)';
  await page.waitForFunction(({ surface, foreground }) => {
    const card = document.querySelector('.terminal-card');
    const rows = card?.querySelector('.xterm-rows');
    return rows && getComputedStyle(card).backgroundColor === surface && getComputedStyle(rows).color === foreground;
  }, { surface, foreground });
}

async function main() {
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (!page) throw new Error('No isolated StackPort WebView2 page found.');
  const phase = process.env.STACKPORT_THEME_PHASE;
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.emulateMedia({ colorScheme: 'light' });
  if (phase === 'write') {
    const setup = await useSettings(page);
    assert.equal(await setup.getByRole('combobox', { name: '테마', exact: true }).inputValue(), 'system');
    await setup.getByRole('combobox', { name: '테마', exact: true }).selectOption('light');
    await expectScheme(page, 'light');
    await expectNativeTheme(page, 'light');
    await closeSettings(page, setup);
    await page.getByRole('button', { name: '터미널', exact: true }).click();
    await page.getByRole('button', { name: 'CMD 열기', exact: true }).click();
    const cmd = page.getByRole('tab', { name: 'CMD 1', exact: true });
    await cmd.waitFor();
    await expectTerminalColors(page, 'light');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('set /a 328*19');
    await page.keyboard.press('Enter');
    const output = page.locator('.xterm-rows').getByText('6232');
    await output.waitFor();
    const dialog = await useSettings(page);
    await dialog.getByRole('combobox', { name: '테마', exact: true }).selectOption('dark');
    await expectScheme(page, 'dark');
    await expectNativeTheme(page, 'dark');
    if (process.env.STACKPORT_TEST_ROOT) {
      await page.screenshot({ path: path.join(process.env.STACKPORT_TEST_ROOT, 'dark-terminal.png') });
    }
    await closeSettings(page, dialog);
    await expectTerminalColors(page, 'dark');
    await output.waitFor();
    assert.equal(await cmd.getAttribute('aria-selected'), 'true');
    page.once('dialog', confirmation => confirmation.accept());
    await page.getByRole('button', { name: 'CMD 1 터미널 닫기', exact: true }).click();
    await cmd.waitFor({ state: 'detached' });
  } else if (phase === 'read') {
    await expectScheme(page, 'dark');
    await expectNativeTheme(page, 'dark');
    await page.keyboard.press('Control+Shift+P');
    const search = page.getByRole('combobox', { name: '명령 검색' });
    await search.fill('테마');
    await page.getByRole('option', { name: /화면 설정/ }).waitFor();
    await search.press('Enter');
    const dialog = page.getByRole('dialog', { name: '화면 설정', exact: true });
    const theme = dialog.getByRole('combobox', { name: '테마', exact: true });
    assert.equal(await theme.inputValue(), 'dark');
    await theme.selectOption('system');
    await expectScheme(page, 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectScheme(page, 'dark');
    await theme.selectOption('light');
    await expectScheme(page, 'light');
    await expectNativeTheme(page, 'light');
    if (process.env.STACKPORT_TEST_ROOT) {
      await page.screenshot({ path: path.join(process.env.STACKPORT_TEST_ROOT, 'light-settings.png') });
    }
    await closeSettings(page, dialog);
  } else {
    throw new Error('Set STACKPORT_THEME_PHASE to write or read.');
  }
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(`Appearance ${phase} passed.`);
}

main().catch(error => { console.error(error); process.exit(1); });
