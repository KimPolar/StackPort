const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { withSecondDesktopInstance } = require('./desktop-instance.cjs');

const root = process.env.STACKPORT_TEST_ROOT;
assert.ok(root && path.isAbsolute(root));
const name = label => ({ name: label, exact: true });

async function verify(page) {
  const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const project = await invoke('create_project', { name: '연결 폴더 검증' });
  const projectId = project.id;
  const file = path.join(root, 'local.sqlite');
  const fixture = new DatabaseSync(file);
  fixture.exec('CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (17);');
  fixture.close();
  const sqlite = await invoke('create_sqlite_profile', { projectId, name: '원본 파일', path: file, environment: 'DEV' });
  const base = { host: 'localhost', username: 'fixture', environment: 'DEV', ca_path: null };
  const definition = [
    ['postgres', 'postgres', 'PostgreSQL', '분석 서버', { ...base, port: 5432, database: 'metrics' }],
    ['mysql', 'mysql', 'MySQL', '주문 서버', { ...base, port: 3306, database: 'orders', tls: true,
      client_certificate_path: null, client_key_path: null }],
    ['redis', 'redis', 'Redis', '캐시 서버', { ...base, port: 6379, database: 0, tls: true }],
    ['mongodb', 'mongo', 'MongoDB', '문서 서버', { uri: 'mongodb://localhost:27017/fixture?directConnection=true',
      username: 'fixture', auth_database: null, environment: 'DEV', tls: true, ca_path: null }],
    ['sql_server', 'sql_server', 'SQL Server', '회계 서버', { ...base, port: 1433, database: 'ledger', authentication: 'sql_login', encryption: 'required' }],
    ['oracle', 'oracle', 'Oracle Database', '재고 서버', { ...base, port: 1521, target: 'service_name', service: 'fixture', transport: 'tcps' }],
    ['snowflake', 'snowflake', 'Snowflake', '웨어하우스', { host: 'org-fixture', database: 'FIXTURE',
      warehouse: null, role: null, auth: 'pat', environment: 'DEV' }],
  ];
  const entries = [{ engine: 'sqlite', id: sqlite.id, label: '원본 파일 DEV', title: '원본 파일' }];
  for (const [engine, command, label, title, settings] of definition) {
    const profile = await invoke(`create_${command}_profile`, { projectId, input: { ...settings, name: title } });
    entries.push({ engine, id: profile.id, title, label: `${label} ${title} 열기` });
  }
  const state = (id = projectId) => invoke('list_database_folders', { projectId: id });
  await page.reload();
  const projectSelect = page.getByLabel('프로젝트', { exact: true });
  await projectSelect.selectOption(projectId);
  const explorer = page.getByRole('complementary', name('작업 공간 탐색기'));
  const button = label => explorer.getByRole('button', name(label));
  const group = label => explorer.getByRole('group', name(`${label} 폴더 내용`));
  const connection = explorer.getByRole('button', name('원본 파일 DEV'));
  await connection.click();
  const create = page.getByRole('dialog', name('연결 폴더 만들기'));
  const edit = page.getByRole('dialog', name('연결 폴더 설정'));
  const move = page.getByRole('dialog', name('연결을 폴더로 이동'));
  const createFolder = async label => {
    await create.getByLabel('폴더 이름').fill(label);
    await create.getByRole('button', name('폴더 만들기')).click();
    await create.waitFor({ state: 'detached' });
    await button(`${label} 폴더`).waitFor();
  };

  await button('연결 폴더 만들기').click();
  await createFolder('서비스');
  await button('서비스 폴더 설정').click();
  await edit.getByRole('button', name('하위 폴더 만들기')).click();
  assert.equal(await create.getByLabel('상위 폴더').locator('option:checked').textContent(), '서비스');
  await createFolder('검증 환경');
  await button('연결 폴더 만들기').click();
  await createFolder('운영');
  await button('서비스 폴더').click();

  for (const entry of entries) {
    const actions = button(entry.label).locator('..').getByRole('button', { name: /연결 작업$/ });
    await actions.press('Enter');
    assert.equal(await actions.getAttribute('aria-expanded'), 'true');
    await button(`${entry.title} 연결을 폴더로 이동`).click();
    await move.getByLabel('이동할 폴더').selectOption({ label: '서비스 / 검증 환경' });
    await move.getByRole('button', name('연결 이동')).click();
    await move.waitFor({ state: 'detached' });
    await group('검증 환경').getByRole('button', name(entry.label)).waitFor();
  }
  assert.equal(await connection.getAttribute('aria-current'), 'true');
  assert.equal(await button('서비스 폴더').getAttribute('aria-description'), '연결 8개');
  const firstState = await state();
  const folderId = firstState.folders.find(folder => folder.name === '검증 환경').id;
  assert.deepEqual(firstState.placements.map(item => item.engine).sort(), entries.map(entry => entry.engine).sort());
  assert.ok(firstState.placements.every(item => item.folder_id === folderId));

  await button('서비스 폴더').click();
  assert.equal(await button('서비스 폴더').getAttribute('aria-expanded'), 'false');
  await connection.waitFor({ state: 'hidden' });
  await explorer.getByRole('searchbox', name('탐색기 검색')).fill('검증 환경');
  await group('검증 환경').getByRole('button', name('MySQL 주문 서버 열기')).waitFor();
  await button('탐색기 검색 지우기').click();
  await connection.waitFor({ state: 'hidden' });
  await button('서비스 폴더').click();
  await connection.waitFor();
  await explorer.screenshot({ path: path.join(root, 'database-folders.png') });

  await button('검증 환경 폴더 설정').click();
  await edit.getByLabel('폴더 이름').fill('서버 점검');
  await edit.getByLabel('상위 폴더').selectOption({ label: '운영' });
  await edit.getByRole('button', name('저장')).click();
  await group('운영').getByRole('group', name('서버 점검 폴더 내용')).waitFor();
  await page.reload();
  await projectSelect.selectOption(projectId);
  await group('운영').getByRole('button', name('Snowflake 웨어하우스 열기')).waitFor();

  const duplicate = await invoke('duplicate_project', { source: projectId, name: '폴더 복제 검증' });
  await withSecondDesktopInstance(root, async command => {
    const original = await command('list_database_folders', { projectId });
    const copy = await command('list_database_folders', { projectId: duplicate.id });
    assert.equal(original.placements.length, 8);
    assert.equal(copy.placements.length, 8);
    assert.ok(copy.placements.every(item => !original.placements.some(other => other.profile_id === item.profile_id)));
    assert.deepEqual(copy.folders.map(item => item.name).sort(), ['서비스', '서버 점검', '운영'].sort());
    const parent = copy.folders.find(item => item.name === '운영');
    const child = copy.folders.find(item => item.name === '서버 점검');
    assert.equal(child.parent_id, parent.id);
    assert.ok(copy.placements.every(item => item.folder_id === child.id));
  });

  await button('운영 폴더 설정').click();
  await edit.getByRole('button', name('폴더 삭제…')).click();
  const removal = page.getByRole('alertdialog', name('연결 폴더 삭제'));
  await removal.getByRole('button', name('취소')).click();
  await edit.getByRole('button', name('폴더 삭제…')).click();
  await removal.getByRole('button', name('폴더 삭제')).click();
  await removal.waitFor({ state: 'detached' });
  await button('운영 폴더').waitFor({ state: 'detached' });
  assert.equal((await state()).placements.length, 0);
  for (const entry of entries) await button(entry.label).waitFor();
  assert.equal(await button('데이터베이스 연결 목록').getAttribute('aria-description'), '연결 8개');
  assert.equal((await state(duplicate.id)).placements.length, 8);
}

async function main() {
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL);
  try {
    await verify(browser.contexts()[0].pages()[0]);
    console.log('Windows database folders passed (eight profile types, nested search, move, reload, project copy, and deletion with preserved connections).');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
