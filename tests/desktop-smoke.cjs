/*
 * Opt-in Windows E2E test. It attaches to a separately started, isolated
 * WebView2 instance and uses the real Tauri commands and SQLite adapter.
 * See docs/IMPLEMENTATION.md for setup and security boundaries.
 */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const database = process.env.STACKPORT_TEST_DATABASE;
if (!database) throw new Error('Set STACKPORT_TEST_DATABASE to the isolated fixture path.');

async function main() {
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (!page) throw new Error('No WebView2 page found.');
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));

  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByLabel('이름', { exact: true }).fill('E2E 테스트');
  await page.getByRole('button', { name: '저장' }).click();
  await page.getByRole('button', { name: 'SQLite 연결 추가', exact: true }).last().click();
  await page.getByLabel('이름', { exact: true }).fill('테스트 DB');
  await page.getByLabel('SQLite 파일 경로').fill(database);
  await page.getByRole('button', { name: '저장' }).click();
  await page.getByRole('button', { name: 'people' }).click();
  await page.getByText('100개 행', { exact: true }).waitFor();
  await page.getByText('사용자 1', { exact: true }).waitFor();
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.getByText('사용자 101', { exact: true }).waitFor();
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.getByText('5개 행', { exact: true }).waitFor();

  await page.getByLabel('SQL 쿼리').fill('DELETE FROM people');
  await page.getByRole('button', { name: '쿼리 실행' }).click();
  await page.getByRole('alert').getByText('이 연결에서는 읽기 전용 쿼리만 실행할 수 있습니다.').waitFor();
  await page.getByLabel('SQL 쿼리').fill('SELECT COUNT(*) AS total FROM people');
  await page.getByRole('button', { name: '쿼리 실행' }).click();
  await page.getByRole('cell', { name: '205', exact: true }).waitFor();
  if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`);
  console.log('Desktop SQLite workflow and read-only protection passed.');
  await browser.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
