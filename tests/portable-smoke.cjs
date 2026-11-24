/* Run against an isolated copied executable. See docs/IMPLEMENTATION.md. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

async function main() {
  const expectedPath = process.env.STACKPORT_TEST_DATA_PATH;
  const mode = process.env.STACKPORT_TEST_DATA_MODE;
  if (!expectedPath || !path.isAbsolute(expectedPath) || !['portable', 'custom'].includes(mode)) {
    throw new Error('Use an isolated data path and choose the portable or custom mode.');
  }
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (!page) throw new Error('No isolated WebView2 page.');
  const info = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_runtime_info'));
  if (info.data_mode !== mode || fs.realpathSync(info.data_directory) !== fs.realpathSync(expectedPath)) {
    throw new Error("The app did not use the selected data location.");
  }
  const version = await page.getByLabel('StackPort 버전').innerText();
  if (version !== 'v' + info.version || !/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('Build version was not displayed.');
  await page.getByText(mode === 'portable' ? '휴대형 작업 공간' : '지정 작업 공간', { exact: true }).waitFor();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByLabel('이름', { exact: true }).fill('격리 경로 검증');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('option', { name: '격리 경로 검증' }).waitFor({ state: 'attached' });
  const db = new DatabaseSync(path.join(expectedPath, 'workspace.sqlite'), { readOnly: true });
  if (db.prepare('SELECT name FROM projects').get().name !== '격리 경로 검증') throw new Error('Project was not saved at the selected path.');
  db.close();
  if (mode === 'portable' && !fs.readdirSync(path.join(expectedPath, 'webview')).length) {
    throw new Error('WebView2 did not create a portable profile.');
  }
  await browser.close();
  console.log('Isolated ' + mode + ' workspace, native database persistence and app version passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
