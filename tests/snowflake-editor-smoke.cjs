const assert = require('node:assert/strict');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { chooseDatabase } = require('./database-picker.cjs');
const { saveDefaultSet } = require('./parameter-set-fixture.cjs');
const { verifySqlDocumentTabs } = require('./sql-document-tabs.cjs');

async function verify(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(15000);
  const project = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('create_project', { name: 'Snowflake 편집기 검증' }));
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('snowflake_query_parameters', {
    input: { sql: 'SELECT ?', first_line: 1, cursor_byte: null },
  })), 1);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const fetchNative = window.fetch.bind(window);
    const routes = new Map([
      'open_snowflake', 'snowflake_schemas', 'snowflake_objects', 'close_snowflake',
      'run_snowflake_query', 'cancel_snowflake_query',
    ].map(name => [bridge.convertFileSrc(name, 'ipc'), name]));
    let pending;
    const plan = (value, line) => ({
      line, query_id: '00000000-0000-4000-8000-000000000001', warning: null,
      data: {
        columns: [{ name: 'VALUE', data_type: 'TEXT' }],
        rows: [[{ text: value, encoding: 'utf8', bytes: null, truncated: false }]],
        rows_received: 1, more_columns: false,
      },
    });
    const reply = (overrides = {}) => ({
      status: 'succeeded', statements: [], elapsed_ms: 200, error: null,
      server_interrupted: null, server_completed: true, audit_warning: false, ...overrides,
    });
    async function respond(name, args) {
      if (name === 'open_snowflake') {
        if (args.token !== 'synthetic-token-for-local-ui-test') throw new Error('Wrong test token');
        return { id: 'snowflake-fixture', database: 'DEMO', version: 'fixture', context: 'READER / DEMO_WH' };
      }
      if (name === 'snowflake_schemas') return { items: ['PUBLIC'], has_next: false };
      if (name === 'snowflake_objects') return { items: [], has_next: false };
      if (name === 'close_snowflake') return;
      if (name === 'cancel_snowflake_query') {
        if (pending?.id !== args.requestId) return false;
        const { resolve, completed } = pending;
        pending = null;
        resolve(reply({
          status: 'cancelled', server_completed: completed, server_interrupted: completed ? null : true,
        }));
        return true;
      }
      if (name === 'run_snowflake_query') {
        if (args.id !== 'snowflake-fixture') throw new Error('Wrong test session');
        const { sql, first_line: line, cursor_byte: cursor } = args.input;
        if (sql.includes('BIND_TEST')) {
          const wanted = "SELECT '?', ?::NUMBER(38,6) AS BIND_TEST, ?::VARCHAR";
          if (sql !== wanted || line !== 2 || cursor !== null) throw new Error('Wrong selected binding scope');
          const parameters = args.input.parameters;
          if (JSON.stringify(parameters) !== JSON.stringify([
            { kind: 'decimal', value: '-12345678901234567890123456789012.345678', masked: true },
            { kind: 'null', masked: false },
          ])) throw new Error('Wrong typed Snowflake bindings');
          return reply({ statements: [plan(parameters[0].value, 2)] });
        }
        if (sql.includes('WAITING')) return new Promise(resolve => {
          pending = { id: args.requestId, resolve, completed: sql.includes('DOWNLOAD') };
        });
        if (sql.includes('ERROR')) return reply({
          status: 'failed', server_completed: false,
          error: { line, code: '000904', sql_state: '42000', message: 'SQL compilation error: invalid identifier' },
        });
        if (sql.includes('UPDATE')) return reply({
          statements: [{ line, data: null, warning: null, stats: { num_rows_updated: 2 } }],
        });
        if (cursor !== null) {
          const after = new TextEncoder().encode("SELECT '한글';\n").length;
          if (cursor !== after || line !== 1) throw new Error('Expected current statement byte offset');
          return reply({ statements: [plan('현재 문장', 2)] });
        }
        if (sql === "SELECT '두 번째';") {
          if (line !== 2) throw new Error('Expected selected statement line');
          return reply({ statements: [plan('선택 문장', line)] });
        }
        if (sql === "SELECT '한글';\nSELECT '두 번째';") {
          return reply({ statements: [plan('한글', 1), plan('두 번째', 2)] });
        }
        throw new Error('Unexpected Snowflake editor input');
      }
      throw new Error('Unexpected Snowflake IPC command');
    }
    // Tauri defines invoke as read-only. Intercept its Windows custom-protocol fetch.
    window.fetch = async (resource, options) => {
      const name = routes.get(resource);
      if (!name) return fetchNative(resource, options);
      try {
        const value = await respond(name, JSON.parse(options.body));
        return Response.json(value ?? null, { headers: { 'Tauri-Response': 'ok' } });
      } catch (error) {
        return Response.json(error.message, { headers: { 'Tauri-Response': 'error' } });
      }
    };
  });
  await chooseDatabase(page, 'Snowflake');
  const profile = page.getByRole('dialog', { name: 'Snowflake 연결 추가', exact: true });
  await profile.getByLabel('연결 이름').fill('Snowflake 편집기 픽스처');
  await profile.getByLabel('계정 식별자 또는 호스트').fill('stackport-fixture');
  await profile.getByLabel('데이터베이스 이름').fill('DEMO');
  await profile.getByRole('button', { name: '저장', exact: true }).click();
  await profile.waitFor({ state: 'detached' });
  const workspace = page.getByRole('region', { name: 'Snowflake 작업 공간', exact: true });
  await workspace.getByRole('button', { name: 'Snowflake 연결', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'Snowflake 연결', exact: true });
  await login.getByLabel('Snowflake 액세스 토큰 (PAT)', { exact: true }).fill('synthetic-token-for-local-ui-test');
  await login.getByRole('button', { name: '연결', exact: true }).click();
  await login.waitFor({ state: 'detached' });
  await workspace.getByRole('button', { name: 'PUBLIC', exact: true }).waitFor();

  const mode = workspace.getByRole('group', { name: 'Snowflake 작업 보기', exact: true });
  const showEditor = mode.getByRole('button', { name: 'SQL 편집기', exact: true });
  const browse = mode.getByRole('button', { name: '객체 탐색', exact: true });
  await showEditor.click();
  await verifySqlDocumentTabs(page, workspace, 'Snowflake SQL 문장');
  const pane = workspace.getByRole('region', { name: 'Snowflake SQL 편집기', exact: true });
  const editor = pane.getByRole('textbox', { name: 'Snowflake SQL 문장', exact: true });
  const results = pane.getByRole('region', { name: 'Snowflake 실행 결과', exact: true });
  const grid = results.getByRole('table', { name: 'Snowflake SQL 결과 표', exact: true });
  const all = pane.getByRole('button', { name: '전체 실행', exact: true });
  await editor.fill("SELECT '한글';\nSELECT '두 번째';");
  await all.click();
  await grid.getByText('한글', { exact: true }).waitFor();
  await results.getByRole('combobox', { name: '문장 결과' }).selectOption('1');
  await grid.getByText('두 번째', { exact: true }).waitFor();
  await results.getByText('00000000-0000-4000-8000-000000000001', { exact: true }).waitFor();
  const originalTab = workspace.getByRole('tab', { name: 'SQL 1', exact: true });
  await workspace.getByRole('button', { name: '새 SQL 탭', exact: true }).click();
  const newTab = workspace.getByRole('tab', { name: 'SQL 3', exact: true });
  assert.equal(await newTab.getAttribute('aria-selected'), 'true');
  assert.equal(await editor.inputValue(), '');
  assert.equal(await results.count(), 0);
  await newTab.press('Delete');
  assert.equal(await originalTab.getAttribute('aria-selected'), 'true');
  await grid.getByText('두 번째', { exact: true }).waitFor();
  await editor.press('Control+End');
  await editor.press('Home');
  await editor.press('Control+Enter');
  await grid.getByText('현재 문장', { exact: true }).waitFor();
  await results.getByRole('combobox', { name: '문장 결과' }).waitFor({ state: 'detached' });
  await editor.press('Shift+End');
  await pane.getByRole('button', { name: '선택 실행', exact: true }).click();
  await grid.getByText('선택 문장', { exact: true }).waitFor();

  const decimal = '-12345678901234567890123456789012.345678';
  const bindSql = "SELECT '앞 문장';\nSELECT '?', ?::NUMBER(38,6) AS BIND_TEST, ?::VARCHAR";
  const bindAction = pane.getByRole('button', { name: '매개변수 실행', exact: true });
  await editor.fill(bindSql);
  await editor.press('Control+a');
  await bindAction.click();
  await pane.getByRole('alert').filter({ hasText: '문장 하나' }).waitFor();
  await editor.press('Control+End');
  await editor.press('Shift+Home');
  await bindAction.click();
  const form = page.getByRole('dialog', { name: 'Snowflake SQL 바인드 변수', exact: true });
  await form.getByLabel('?1 형식', { exact: true }).selectOption('decimal');
  const decimalInput = form.getByLabel('?1 값', { exact: true });
  await decimalInput.fill(decimal);
  await form.getByLabel('?2 형식', { exact: true }).selectOption('null');
  const sets = await saveDefaultSet(form, 'Snowflake 정확 소수');
  await form.getByRole('button', { name: '취소', exact: true }).click();
  await editor.press('Control+End');
  await editor.press('Shift+Home');
  await bindAction.click();
  await sets.getByText('매개변수 세트를 불러왔습니다.', { exact: true }).waitFor();
  assert.equal(await form.getByLabel('?1 형식', { exact: true }).inputValue(), 'decimal');
  assert.equal(await form.getByLabel('?2 형식', { exact: true }).inputValue(), 'null');
  assert.equal(await decimalInput.inputValue(), decimal);
  await form.getByLabel('?1 값 숨기기', { exact: true }).check();
  assert.equal(await decimalInput.getAttribute('type'), 'password');
  await form.getByRole('button', { name: '매개변수로 실행', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  await grid.getByText(decimal, { exact: true }).waitFor();

  await editor.fill("UPDATE demo SET x = 1;");
  await all.click();
  await results.getByText('수정 2행', { exact: true }).waitFor();
  await editor.fill("SELECT ERROR;");
  await all.click();
  const alert = results.getByRole('alert');
  await alert.waitFor();
  assert.match(await alert.innerText(), /오류 000904.*SQLSTATE 42000/);
  for (const [sql, expected] of [
    ["SELECT 'WAITING';", /실행 중단.*서버가 실행 중단을 확인했습니다/],
    ["SELECT 'WAITING DOWNLOAD';", /서버 실행 완료 · 결과 수신 중단/],
  ]) {
    await editor.fill(sql);
    await all.click();
    assert.equal(await workspace.getByRole('button', { name: '새 SQL 탭', exact: true }).isDisabled(), true);
    await pane.getByRole('button', { name: '실행 중단', exact: true }).click();
    const status = results.getByRole('status');
    await status.waitFor();
    assert.match(await status.innerText(), expected);
  }
  await browse.click();
  await workspace.getByRole('button', { name: 'PUBLIC', exact: true }).waitFor();
  await showEditor.click();
  assert.equal(await editor.inputValue(), "SELECT 'WAITING DOWNLOAD';");
  await workspace.getByRole('button', { name: 'Snowflake 연결 끊기', exact: true }).click();
  assert.deepEqual(errors, []);
}

async function main() {
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9369');
  try {
    await verify(browser.contexts()[0].pages()[0]);
    console.log('Snowflake editor Windows E2E passed with mocked SQL IPC.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
