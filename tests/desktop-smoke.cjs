/*
 * Opt-in Windows E2E test. It attaches to a separately started, isolated
 * WebView2 instance and uses the real Tauri commands and SQLite adapter.
 * See docs/IMPLEMENTATION.md for setup and security boundaries.
 */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const database = process.env.STACKPORT_TEST_DATABASE;
if (!database) throw new Error('Set STACKPORT_TEST_DATABASE to the isolated fixture path.');
const python = process.env.STACKPORT_TEST_PYTHON || 'python';
function scalar(sql) {
  return execFileSync(python, ['-c', 'import sqlite3,sys; sys.stdout.reconfigure(encoding="utf-8"); db=sqlite3.connect(sys.argv[1]); v=db.execute(sys.argv[2]).fetchone()[0]; print("NULL" if v is None else v); db.close()', database, sql], { encoding: 'utf8' }).trimEnd();
}
function mutateFixture(sql) {
  execFileSync(python, ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(sys.argv[2]); db.commit(); db.close()', database, sql]);
}

async function main() {
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (!page) throw new Error('No WebView2 page found.');
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));

  if (process.env.STACKPORT_EXPECT_PROJECT) {
    await page.getByRole('option', { name: process.env.STACKPORT_EXPECT_PROJECT, exact: true }).waitFor({ state: 'attached' });
  }

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
  await page.locator('details.schema-card summary').click();
  const columns = page.getByRole('table', { name: 'people 열 구조' });
  await columns.getByRole('cell', { name: 'PK 1' }).waitFor();
  await columns.getByRole('cell', { name: 'INTEGER' }).waitFor();
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

  await page.getByLabel('SQL 쿼리').fill('WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT sum(n) FROM numbers');
  await page.getByRole('button', { name: '쿼리 실행' }).click();
  await page.getByRole('button', { name: '쿼리 중단' }).waitFor();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '쿼리 중단' }).click();
  await page.getByRole('status').getByText('쿼리가 중단되었습니다. 읽기 전용 연결이 닫혔습니다.').waitFor();
  await page.getByRole('button', { name: '쿼리 실행' }).click();
  await page.getByRole('status').getByText('쿼리 실행 시간 10초를 초과해 중단되었습니다. 조건을 줄여 다시 실행하세요.').waitFor({ timeout: 20000 });
  await page.getByLabel('SQL 쿼리').fill('SELECT COUNT(*) AS total FROM people');
  await page.getByRole('button', { name: '쿼리 실행' }).click();
  await page.getByRole('cell', { name: '205', exact: true }).waitFor();

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'people' }).click();
  await page.getByRole('button', { name: '1행 편집', exact: true }).click();
  await page.getByLabel('변경할 열').selectOption('name');
  await page.getByLabel('변경할 값').fill('수정된 사용자');
  await page.getByRole('button', { name: '변경 미리보기' }).click();
  await page.getByText('변경 미리보기 · 1행 / 1열').waitFor();
  if (scalar('SELECT name FROM people WHERE id=1') !== '사용자 1') throw new Error('Preview unexpectedly modified the database.');
  await page.getByRole('button', { name: '변경 적용' }).click();
  await page.getByText('셀 변경 완료 · 저장 값 검증됨').waitFor();
  if (scalar('SELECT name FROM people WHERE id=1') !== '수정된 사용자') throw new Error('Confirmed edit was not saved.');

  await page.getByRole('button', { name: '2행 편집', exact: true }).click();
  await page.getByLabel('변경할 열').selectOption('name');
  await page.getByLabel('변경할 값').fill('충돌로 저장되면 안 됨');
  await page.getByRole('button', { name: '변경 미리보기' }).click();
  await page.getByText('변경 미리보기 · 1행 / 1열').waitFor();
  mutateFixture("UPDATE people SET note='concurrent-change' WHERE id=2");
  await page.getByRole('button', { name: '변경 적용' }).click();
  await page.getByRole('alert').getByText(/행이 변경되어 적용하지 않았습니다/).waitFor();
  if (scalar('SELECT name FROM people WHERE id=2') !== '사용자 2') throw new Error('A conflicting edit was saved.');
  await page.getByRole('button', { name: '닫기', exact: true }).last().click();

  await page.getByRole('button', { name: 'SQLite 연결 추가', exact: true }).first().click();
  await page.getByLabel('이름', { exact: true }).fill('운영 DB');
  await page.getByLabel('SQLite 파일 경로').fill(database);
  await page.getByLabel('환경').selectOption('PROD');
  await page.getByRole('button', { name: '저장' }).click();
  await page.getByRole('button', { name: 'people' }).click();
  await page.getByRole('button', { name: '1행 편집', exact: true }).click();
  await page.getByLabel('변경할 열').selectOption('note');
  await page.getByLabel('변경할 값').fill('운영 메모');
  await page.getByRole('button', { name: '변경 미리보기' }).click();
  await page.getByRole('button', { name: '변경 적용' }).click();
  await page.getByRole('alert').getByText('운영 환경을 확인하려면 PROD를 입력하세요.').waitFor();
  if (scalar('SELECT note FROM people WHERE id=1') !== 'NULL') throw new Error('PROD edit bypassed confirmation.');
  await page.getByLabel('운영 환경 확인: PROD 입력').fill('PROD');
  await page.getByRole('button', { name: '변경 적용' }).click();
  await page.getByText('셀 변경 완료 · 저장 값 검증됨').waitFor();
  if (scalar('SELECT note FROM people WHERE id=1') !== '운영 메모') throw new Error('Confirmed PROD edit was not saved.');

  const backupPath = path.join(path.dirname(database), `backup-${randomUUID()}.sqlite`);
  await page.getByRole('button', { name: '백업', exact: true }).click();
  await page.getByLabel('새 백업 파일 경로').fill(database);
  await page.getByRole('button', { name: '백업 만들기' }).click();
  await page.getByRole('alert').getByText('같은 이름의 파일이 이미 있습니다. 새 경로를 선택하세요.').waitFor();
  await page.getByLabel('새 백업 파일 경로').fill(backupPath);
  await page.getByRole('button', { name: '백업 만들기' }).click();
  await page.getByText('백업 생성 완료 · 무결성 검사 통과').waitFor();
  await page.getByRole('button', { name: 'SQLite 연결 추가', exact: true }).first().click();
  await page.getByLabel('이름', { exact: true }).fill('백업 검증');
  await page.getByLabel('SQLite 파일 경로').fill(backupPath);
  await page.getByRole('button', { name: '저장' }).click();
  await page.getByRole('button', { name: 'people' }).click();
  await page.getByText('100개 행', { exact: true }).waitFor();
  await page.getByLabel('SQL 쿼리').fill('SELECT COUNT(*) AS total FROM people');
  await page.getByRole('button', { name: '쿼리 실행' }).click();
  await page.getByRole('cell', { name: '205', exact: true }).waitFor();
  await page.getByLabel('SQL 쿼리').fill('SELECT name FROM people WHERE id=1');
  await page.getByRole('button', { name: '쿼리 실행' }).click();
  await page.getByRole('cell', { name: '수정된 사용자', exact: true }).waitFor();
  await page.getByRole('button', { name: '작업 기록' }).click();
  await page.getByRole('heading', { name: '작업 기록' }).waitFor();
  await page.getByText('SQLite 백업', { exact: true }).first().waitFor();
  await page.getByText('SQLite 셀 변경', { exact: true }).first().waitFor();
  await page.getByText('실패', { exact: true }).first().waitFor();
  await page.getByText('완료', { exact: true }).first().waitFor();
  const history = await page.locator('.audit-panel').innerText();
  if (history.includes(database) || history.includes('DELETE FROM people') || history.includes('수정된 사용자') || history.includes('운영 메모') || history.includes('concurrent-change')) {
    throw new Error('Audit UI unexpectedly included a file path, SQL text, or row data.');
  }
  if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`);
  console.log('Desktop query cancellation and timeout, SQLite preview, PROD confirmation, verified backup, and audit history passed.');
  await browser.close();
}

main().catch(error => { console.error(error); process.exit(1); });
