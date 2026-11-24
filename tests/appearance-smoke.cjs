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

async function openFixtureTable(page) {
  const database = process.env.STACKPORT_TEST_DATABASE;
  if (!database) throw new Error('Set STACKPORT_TEST_DATABASE to the isolated SQLite fixture.');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  const project = page.getByRole('dialog', { name: '새 프로젝트', exact: true });
  await project.getByRole('textbox', { name: '이름', exact: true }).fill('화면 검증');
  await project.getByRole('button', { name: '저장', exact: true }).click();
  await project.waitFor({ state: 'detached' });
  const explorer = page.getByRole('complementary', { name: '작업 공간 탐색기', exact: true });
  await explorer.getByRole('button', { name: 'SQLite 연결 추가', exact: true }).click();
  const connection = page.getByRole('dialog', { name: 'SQLite 연결 추가', exact: true });
  await connection.getByRole('textbox', { name: '이름', exact: true }).fill('화면 검증 DB');
  await connection.getByLabel('SQLite 파일 경로').fill(database);
  await connection.getByRole('button', { name: '저장', exact: true }).click();
  await explorer.getByRole('button', { name: 'people', exact: true }).click();
  await page.getByRole('button', { name: '1행 편집', exact: true }).waitFor();
}

async function verifyFocusMode(page, editor, draft, output, separator, splitRatio) {
  const focusMode = page.getByRole('button', { name: '집중 모드', exact: true });
  const explorer = page.getByRole('complementary', { name: '작업 공간 탐색기', exact: true });
  const panes = page.locator('#workspace-panes');
  const originalWidth = await panes.evaluate(element => element.getBoundingClientRect().width);
  await explorer.getByRole('button', { name: 'people', exact: true }).focus();
  await page.keyboard.press('Control+Shift+P');
  const search = page.getByRole('combobox', { name: '명령 검색' });
  await search.fill('집중 모드');
  await page.getByRole('option', { name: /집중 모드 켜기/ }).waitFor();
  await search.press('Enter');
  await page.locator('#workspace-toolbar').waitFor({ state: 'hidden' });
  await explorer.waitFor({ state: 'hidden' });
  await page.locator('#workspace-status').waitFor({ state: 'hidden' });
  assert.equal(await focusMode.getAttribute('aria-pressed'), 'true');
  assert.equal(await focusMode.evaluate(element => element === document.activeElement), true);
  assert.ok(await panes.evaluate(element => element.getBoundingClientRect().width) > originalWidth);
  assert.equal(await separator.getAttribute('aria-valuenow'), splitRatio);
  assert.equal(await editor.inputValue(), draft);
  await output.waitFor();
  if (process.env.STACKPORT_TEST_ROOT) {
    await page.screenshot({ path: path.join(process.env.STACKPORT_TEST_ROOT, 'focused-workspace.png') });
  }
  await focusMode.press('Enter');
  await explorer.waitFor();
  await page.locator('#workspace-toolbar').waitFor();
  assert.equal(await separator.getAttribute('aria-valuenow'), splitRatio);
  assert.equal(await focusMode.getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: '탐색기 접기', exact: true }).click();
  await focusMode.click();
  await page.locator('#workspace-toolbar').waitFor({ state: 'hidden' });
  await focusMode.click();
  await explorer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '탐색기 펼치기', exact: true }).click();
  await explorer.waitFor();
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
    await openFixtureTable(page);
    const row = page.locator('.database-results tbody tr').first();
    const defaultHeight = await row.evaluate(element => element.getBoundingClientRect().height);
    const setup = await useSettings(page);
    assert.equal(await setup.getByRole('combobox', { name: '테마', exact: true }).inputValue(), 'system');
    await setup.getByRole('combobox', { name: '테마', exact: true }).selectOption('light');
    const density = setup.getByRole('combobox', { name: '화면 밀도', exact: true });
    assert.equal(await density.inputValue(), 'default');
    await density.selectOption('compact');
    await page.locator('.app-shell[data-density="compact"]').waitFor();
    await expectScheme(page, 'light');
    await expectNativeTheme(page, 'light');
    await closeSettings(page, setup);
    assert.ok(await row.evaluate(element => element.getBoundingClientRect().height) < defaultHeight);
    await page.setViewportSize({ width: 960, height: 640 });
    await page.getByRole('button', { name: 'SQL 편집기', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'SQL 쿼리', exact: true });
    const draft = "SELECT '집중 모드에서 맨 처음 작성한 초안';";
    await editor.fill(draft);
    await page.getByRole('button', { name: '화면 분할', exact: true }).click();
    const separator = page.getByRole('separator', { name: '데이터베이스 창 크기', exact: true });
    await separator.press('ArrowRight');
    const splitRatio = await separator.getAttribute('aria-valuenow');
    assert.equal(splitRatio, '55');
    await page.getByRole('button', { name: 'CMD 열기', exact: true }).click();
    const cmd = page.getByRole('tab', { name: 'CMD 1', exact: true });
    await cmd.waitFor();
    await expectTerminalColors(page, 'light');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('set /a 328*19');
    await page.keyboard.press('Enter');
    const output = page.locator('.xterm-rows').getByText('6232');
    await output.waitFor();
    await verifyFocusMode(page, editor, draft, output, separator, splitRatio);
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
    await editor.fill('');
    page.once('dialog', confirmation => confirmation.accept());
    await page.getByRole('button', { name: 'CMD 1 터미널 닫기', exact: true }).click();
    await cmd.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '집중 모드', exact: true }).click();
    await page.locator('#workspace-toolbar').waitFor({ state: 'hidden' });
  } else if (phase === 'read') {
    await expectScheme(page, 'dark');
    await expectNativeTheme(page, 'dark');
    await page.locator('.app-shell[data-density="compact"]').waitFor();
    await page.locator('#workspace-toolbar').waitFor();
    await page.getByRole('complementary', { name: '작업 공간 탐색기', exact: true }).waitFor();
    const restoredSplit = page.getByRole('separator', { name: '데이터베이스 창 크기', exact: true });
    await restoredSplit.waitFor();
    assert.equal(await restoredSplit.getAttribute('aria-valuenow'), '55');
    const focusMode = page.getByRole('button', { name: '집중 모드', exact: true });
    assert.equal(await focusMode.getAttribute('aria-pressed'), 'false');
    await page.keyboard.press('Control+Shift+P');
    const search = page.getByRole('combobox', { name: '명령 검색' });
    await search.fill('테마');
    await page.getByRole('option', { name: /화면 설정/ }).waitFor();
    await search.press('Enter');
    const dialog = page.getByRole('dialog', { name: '화면 설정', exact: true });
    const theme = dialog.getByRole('combobox', { name: '테마', exact: true });
    assert.equal(await theme.inputValue(), 'dark');
    const density = dialog.getByRole('combobox', { name: '화면 밀도', exact: true });
    assert.equal(await density.inputValue(), 'compact');
    await density.selectOption('default');
    await page.locator('.app-shell[data-density="default"]').waitFor();
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
