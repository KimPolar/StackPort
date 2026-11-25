const assert = require('node:assert/strict');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { chooseDatabase } = require('./database-picker.cjs');
const { openFromObjectSearch } = require('./relational-object-search.cjs');

const account = process.env.STACKPORT_SNOWFLAKE_TEST_ACCOUNT;
const database = process.env.STACKPORT_SNOWFLAKE_TEST_DATABASE;
const schema = process.env.STACKPORT_SNOWFLAKE_TEST_SCHEMA;
const object = process.env.STACKPORT_SNOWFLAKE_TEST_OBJECT;
const warehouse = process.env.STACKPORT_SNOWFLAKE_TEST_WAREHOUSE;
const role = process.env.STACKPORT_SNOWFLAKE_TEST_ROLE;
const token = process.env.STACKPORT_SNOWFLAKE_TEST_TOKEN;
const auth = process.env.STACKPORT_SNOWFLAKE_TEST_AUTH || 'pat';

async function verify(page) {
  page.setDefaultTimeout(55_000);
  await chooseDatabase(page, 'Snowflake');
  const profile = page.getByRole('dialog', { name: 'Snowflake 연결 추가', exact: true });
  await profile.getByLabel('연결 이름').fill('Snowflake 실제 서버 검증');
  await profile.getByLabel('계정 식별자 또는 호스트').fill(account);
  await profile.getByLabel('데이터베이스 이름').fill(database);
  if (warehouse) await profile.getByLabel('웨어하우스 (선택)').fill(warehouse);
  if (role) await profile.getByLabel('역할 (선택)').fill(role);
  await profile.getByLabel('인증 방식', { exact: true }).selectOption(auth);
  await profile.getByRole('button', { name: '저장', exact: true }).click();
  await profile.waitFor({ state: 'detached' });

  const workspace = page.getByRole('region', { name: 'Snowflake 작업 공간', exact: true });
  await workspace.getByRole('button', { name: 'Snowflake 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'Snowflake 연결', exact: true });
  const label = auth === 'pat' ? 'Snowflake 액세스 토큰 (PAT)' : 'Snowflake OAuth 액세스 토큰';
  await login.getByLabel(label, { exact: true }).fill(token);
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  try {
    const schemas = workspace.getByRole('region', { name: 'Snowflake 스키마 목록' });
    await schemas.getByRole('searchbox').fill(schema);
    await schemas.getByRole('button', { name: '검색' }).click();
    await schemas.getByRole('button', { name: schema, exact: true }).click();

    const objects = workspace.getByRole('region', { name: 'Snowflake 테이블과 뷰 목록' });
    await objects.getByRole('searchbox').fill(object);
    await objects.getByRole('button', { name: '검색' }).click();
    const catalogObject = objects.getByText(object, { exact: true });
    const kind = await catalogObject.locator('..').locator('small').innerText();
    const detail = await openFromObjectSearch(page, workspace, 'Snowflake', {
      schema, name: object, kind, term: object, scope: schema,
    });
    const preview = detail.getByRole('table', { name: 'Snowflake 데이터 미리보기' });
    await preview.locator('tbody tr').first().waitFor();
    await detail.getByRole('button', { name: '열 구조', exact: true }).click();
    await detail.getByRole('table', { name: 'Snowflake 열 구조' }).getByRole('rowheader').first().waitFor();
  } finally {
    await workspace.getByRole('button', { name: 'Snowflake 연결 끊기', exact: true }).click();
  }
}

async function main() {
  assert.ok(account && database && schema && object && token, 'Snowflake test account, database, schema, object and token are required.');
  assert.ok(auth === 'pat' || auth === 'oauth');
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
  try {
    await verify(browser.contexts()[0].pages()[0]);
    console.log('Snowflake Windows E2E passed (live login, scoped object search, catalog, preview and columns).');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  const message = error.stack || String(error);
  console.error(token ? message.replaceAll(token, '[redacted]') : message);
  process.exitCode = 1;
});
