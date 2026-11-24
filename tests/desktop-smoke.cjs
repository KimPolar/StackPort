/*
 * Opt-in Windows E2E test. It attaches to a separately started, isolated
 * WebView2 instance and uses the real Tauri commands and SQLite adapter.
 * See docs/IMPLEMENTATION.md for setup and security boundaries.
 */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const path = require('path');
const fs = require('fs');
const { createHash, randomUUID } = require('crypto');
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

  await page.getByText('필터 및 정렬', { exact: true }).click();
  await page.getByRole('button', { name: '조건 추가' }).click();
  await page.getByLabel('필터 1 열').selectOption('note');
  await page.getByLabel('필터 1 연산자').selectOption('is_null');
  await page.getByRole('button', { name: '조건 추가' }).click();
  await page.getByLabel('필터 2 연산자').selectOption('ge');
  await page.getByLabel('필터 2 값 형식').selectOption('integer');
  await page.getByLabel('필터 2 값', { exact: true }).fill('90');
  await page.getByLabel('일치 조건').selectOption('any');
  await page.getByRole('button', { name: '정렬 열 추가' }).click();
  await page.getByLabel('정렬 1 열').selectOption('note');
  await page.getByLabel('정렬 1 NULL 순서').selectOption('first');
  await page.getByRole('button', { name: '정렬 열 추가' }).click();
  await page.getByLabel('정렬 2 방향').selectOption('desc');
  await page.getByRole('button', { name: '정렬 2 위로' }).click();
  if (await page.getByLabel('정렬 1 열').inputValue() !== 'id') throw new Error('Reordering sort columns did not change their priority.');
  await page.getByRole('button', { name: '정렬 1 아래로' }).click();
  await page.getByRole('button', { name: '적용', exact: true }).click();
  const resultRows = page.locator('.results-card tbody tr');
  await resultRows.first().getByText('사용자 205', { exact: true }).waitFor();
  await page.getByText('people · 조회 SQL · 필터 2개 · 정렬 2개', { exact: true }).click();
  const generatedSql = page.locator('.table-query-sql pre');
  await generatedSql.getByText(/WHERE sp_source\."note" IS NULL OR sp_source\."id" >= \?/).waitFor();
  // Editing the form without applying it must not change the next page.
  await page.getByLabel('필터 2 값', { exact: true }).fill('205');
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await resultRows.first().getByText('사용자 5', { exact: true }).waitFor();
  await resultRows.nth(3).getByText('사용자 204', { exact: true }).waitFor();
  await page.getByText('61개 행', { exact: true }).waitFor();
  await page.getByRole('button', { name: '101행 편집', exact: true }).click();
  await page.getByLabel('변경할 열').selectOption('name');
  await page.getByLabel('변경할 값').fill('필터에서 수정');
  await page.getByRole('button', { name: '변경 미리보기' }).click();
  await page.getByRole('button', { name: '변경 적용' }).click();
  await resultRows.first().getByText('필터에서 수정', { exact: true }).waitFor();
  if (scalar('SELECT name FROM people WHERE id=5') !== '필터에서 수정') throw new Error('Filtered grid edited a different row.');
  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await resultRows.first().getByText('사용자 1', { exact: true }).waitFor();
  await page.getByText('필터 및 정렬', { exact: true }).click();

  await page.getByLabel('SQL 쿼리').fill('SELECT name FROM people WHERE id >= :first AND :key = :key ORDER BY id');
  await page.getByRole('button', { name: '쿼리 실행' }).click();
  await page.getByRole('heading', { name: 'SQL 매개변수' }).waitFor();
  await page.getByLabel(':first 형식').selectOption('integer');
  await page.getByLabel(':first 값', { exact: true }).fill('9223372036854775808');
  const parameterSecret = "synthetic' filter %_";
  await page.getByLabel(':key 값 숨기기').check();
  const secretField = page.getByLabel(':key 값', { exact: true });
  if (await secretField.getAttribute('type') !== 'password') throw new Error('SQL parameter mask did not apply.');
  await secretField.fill(parameterSecret);
  await page.getByRole('button', { name: '매개변수로 실행' }).click();
  await page.getByRole('alert').getByText(/64비트 정수 범위/).waitFor();
  if (await secretField.inputValue() !== parameterSecret) throw new Error('Correctable input was lost after validation failure.');
  await page.getByLabel(':first 값', { exact: true }).fill('2');
  await page.getByRole('button', { name: '매개변수로 실행' }).click();
  await resultRows.first().getByText('사용자 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await resultRows.first().getByText('사용자 102', { exact: true }).waitFor();

  await page.getByRole('button', { name: '실행 계획', exact: true }).click();
  await page.getByLabel(':first 형식').selectOption('integer');
  await page.getByLabel(':first 값', { exact: true }).fill('2');
  await page.getByLabel(':key 값', { exact: true }).fill(parameterSecret);
  await page.getByRole('button', { name: '매개변수로 실행' }).click();
  const plan = page.getByRole('region', { name: 'SQLite 실행 계획' });
  await plan.getByText(/SEARCH people USING INTEGER PRIMARY KEY/).waitFor();
  await resultRows.first().getByText('사용자 102', { exact: true }).waitFor();
  if ((await plan.innerText()).includes(parameterSecret)) throw new Error('Query plan exposed a parameter value.');
  await page.getByLabel('SQL 쿼리').fill('SELECT name FROM people ORDER BY note DESC');
  await plan.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '실행 계획', exact: true }).click();
  await plan.getByText('USE TEMP B-TREE FOR ORDER BY', { exact: true }).waitFor();
  await page.getByLabel('SQL 쿼리').fill('SELECT name FROM people WHERE id = 1 UNION ALL SELECT name FROM people WHERE id = 2');
  await page.getByRole('button', { name: '실행 계획', exact: true }).click();
  await plan.getByText('COMPOUND QUERY', { exact: true }).waitFor();
  await plan.locator('.sqlite-plan-branch').first().waitFor();
  await plan.getByRole('button', { name: '실행 계획 닫기' }).click();
  await plan.waitFor({ state: 'detached' });

  await page.getByLabel('SQL 쿼리').fill('DELETE FROM people');
  await page.getByRole('button', { name: '실행 계획', exact: true }).click();
  await page.getByRole('alert').getByText('이 연결에서는 읽기 전용 쿼리만 실행할 수 있습니다.').waitFor();
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
  const restoredPath = path.join(path.dirname(database), `restored-${randomUUID()}.sqlite`);
  const originalBackup = fs.readFileSync(backupPath);
  const backupSha = createHash('sha256').update(originalBackup).digest('hex');
  mutateFixture("UPDATE people SET name='백업 이후 변경' WHERE id=1");
  await page.getByRole('button', { name: 'SQLite 백업 복원' }).click();
  await page.getByLabel('백업 파일 경로').fill(backupPath);
  await page.getByLabel('새 복원 파일 경로').fill(database);
  await page.getByRole('button', { name: '복원 미리보기' }).click();
  await page.getByRole('alert').getByText('복원 대상 파일이 이미 있습니다.', { exact: false }).waitFor();
  await page.getByLabel('새 복원 파일 경로').fill(restoredPath);
  await page.getByRole('button', { name: '복원 미리보기' }).click();
  const restoreDialog = page.getByRole('dialog', { name: 'SQLite 백업 복원' });
  await restoreDialog.getByText(backupSha, { exact: true }).waitFor();
  await restoreDialog.getByText('객체 1개 · 일반 테이블 1개 · 205행', { exact: false }).waitFor();
  await page.keyboard.press('Enter');
  if (fs.existsSync(restoredPath)) throw new Error('Preview published a file before restore confirmation.');
  await page.getByRole('button', { name: '새 파일로 복원' }).click();
  await page.getByRole('status').getByText('SQLite 복원 완료 · 검증 통과').waitFor();
  if (!fs.readFileSync(restoredPath).equals(originalBackup)) throw new Error('Restored database differs from the verified backup.');
  if (scalar('SELECT name FROM people WHERE id=1') !== '백업 이후 변경') throw new Error('Restore altered the active database.');
  await page.getByRole('button', { name: 'SQLite 연결 추가', exact: true }).first().click();
  await page.getByLabel('이름', { exact: true }).fill('복원 검증');
  await page.getByLabel('SQLite 파일 경로').fill(restoredPath);
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
  await page.getByText('SQLite 복원', { exact: true }).first().waitFor();
  await page.getByText('SQLite 셀 변경', { exact: true }).first().waitFor();
  await page.getByText('실패', { exact: true }).first().waitFor();
  await page.getByText('완료', { exact: true }).first().waitFor();
  const history = await page.locator('.audit-panel').innerText();
  if ([database, backupPath, restoredPath, backupSha, parameterSecret, 'DELETE FROM people', '수정된 사용자', '운영 메모', 'concurrent-change'].some(privateValue => history.includes(privateValue))) {
    throw new Error('Audit UI unexpectedly included a file path, SQL text, or row data.');
  }
  if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`);
  console.log('SQLite browsing, query cancellation, editing, PROD confirmation, backup, verified restore, and audit passed.');
  await browser.close();
}

main().catch(error => { console.error(error); process.exit(1); });
