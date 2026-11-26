/* Windows desktop test. The runner restarts StackPort between prepare and resume. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chooseDatabase } = require('./database-picker.cjs');

const root = process.env.STACKPORT_TEST_ROOT;
const phase = process.env.STACKPORT_BACKUP_TEST_PHASE;
const fixtureFile = root && path.join(root, 'schedule.json');
if (!root || !['prepare', 'resume'].includes(phase)) throw new Error('Set the isolated root and prepare/resume phase.');

const source = path.join(root, '예약 원본.sqlite');
const output = path.join(root, '예약 백업');
const displaced = path.join(root, '일시적으로 연결 해제한 폴더');

function dateInput(seconds) {
  const local = new Date(seconds * 1000);
  return new Date(local.getTime() - local.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function verifySnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT value FROM items WHERE id=1').get().value, '예약 검증 값');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='item_value'").get().n, 1);
  } finally { db.close(); }
}

async function main() {
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL);
  const page = browser.contexts().flatMap(context => context.pages())[0];
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const dialog = page.getByRole('dialog', { name: 'SQLite 백업 계획', exact: true });
  const history = dialog.getByRole('region', { name: '백업 실행 이력', exact: true });
  const instance = page.locator('#workspace-status');
  const openPlan = async () => {
    await page.getByRole('button', { name: '백업', exact: true }).click();
    await page.getByRole('dialog', { name: 'SQLite 백업', exact: true }).getByRole('button', { name: '백업 계획' }).click();
    await dialog.getByLabel('저장 폴더').waitFor();
  };
  const state = profileId => command('sqlite_backup_plan', { profileId });
  const storeRun = run => {
    assert.equal(run.status, 'succeeded');
    assert.ok(run.size_bytes > 0);
    assert.equal(run.expires_at - run.finished_at, 7 * 86_400);
    assert.match(path.basename(run.path), /^fixture-\d{8}T\d{6}Z-[\da-f-]{36}\.sqlite$/);
    verifySnapshot(path.join(output, path.basename(run.path)));
  };

  try {
    if (phase === 'prepare') {
      fs.mkdirSync(output);
      const db = new DatabaseSync(source);
      try {
        db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX item_value ON items(value); INSERT INTO items VALUES(1,'예약 검증 값');");
        assert.ok(fs.existsSync(source + '-wal'));
        await page.getByRole('button', { name: '새 프로젝트' }).click();
        await page.getByLabel('이름', { exact: true }).fill('SQLite 예약 검증');
        await page.getByRole('button', { name: '저장', exact: true }).click();
        await chooseDatabase(page, 'SQLite');
        await page.getByLabel('이름', { exact: true }).fill('예약 백업 원본');
        await page.getByLabel('SQLite 파일 경로').fill(source);
        await page.getByRole('button', { name: '저장', exact: true }).click();
        await page.getByRole('dialog', { name: 'SQLite 연결 추가', exact: true }).waitFor({ state: 'hidden' });
        const [project] = await command('list_projects');
        const [profile] = await command('list_profiles', { projectId: project.id });
        await openPlan();
        await dialog.getByLabel('저장 폴더').fill(output);
        await dialog.getByRole('button', { name: '용량 확인' }).click();
        const capacity = dialog.getByText(/예상 크기/);
        const capacityError = dialog.getByRole('alert');
        await capacity.or(capacityError).first().waitFor();
        if (await capacityError.isVisible()) throw new Error(await capacityError.innerText());
        assert.match(await capacity.innerText(), /사용 가능/);
        await dialog.getByLabel('파일 이름 접두어').fill('fixture');
        await dialog.getByLabel('보존 기간 (일)').fill('7');
        await dialog.getByLabel('실행 주기').selectOption('once');
        const due = Math.floor(Date.now() / 1000) + 20;
        await dialog.getByLabel('첫 실행 (이 장치 시각)').fill(dateInput(due));
        await dialog.getByRole('button', { name: '계획 저장', exact: true }).click();
        await dialog.getByRole('status').getByText('백업 계획을 저장했습니다.').waitFor();
        assert.equal((await state(profile.id)).plan.next_at, due);
        await dialog.getByRole('button', { name: '지금 백업', exact: true }).click();
        await history.getByText(/무결성 검사 통과 · 수동 실행/).waitFor();
        const beforeExit = await state(profile.id);
        assert.equal(beforeExit.runs.length, 1);
        storeRun(beforeExit.runs[0]);
        assert.equal(beforeExit.plan.next_at, due);
        fs.writeFileSync(fixtureFile, JSON.stringify({ projectId: project.id, profileId: profile.id, due }));
      } finally { db.close(); }
      console.log('Recorded a one-shot plan, checked capacity and created a verified WAL snapshot manually.');
    } else {
      const { projectId, profileId, due } = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
      assert.ok(Date.now() / 1000 >= due);
      await openPlan();
      await history.getByText(/무결성 검사 통과 · 예약 실행/).waitFor();
      const resumed = await state(profileId);
      assert.equal(resumed.plan.next_at, null);
      assert.equal(resumed.runs.length, 2);
      const scheduled = resumed.runs.find(run => run.trigger_kind === 'scheduled');
      assert.ok(scheduled.started_at >= due);
      storeRun(scheduled);
      const restored = path.join(root, '복원 검증.sqlite');
      const preview = await command('preview_sqlite_restore', { projectId, source: scheduled.path, destination: restored });
      const recovery = await command('restore_sqlite', { token: preview.token, confirmed: true });
      assert.equal(recovery.integrity, 'ok');
      assert.equal(recovery.sha256, preview.sha256);
      verifySnapshot(restored);

      await dialog.getByRole('checkbox', { name: '예약 실행', exact: true }).check();
      await dialog.getByLabel('첫 실행 (이 장치 시각)').fill(dateInput(Math.floor(Date.now() / 1000) + 7));
      await dialog.getByRole('button', { name: '계획 저장', exact: true }).click();
      await dialog.getByRole('status').getByText('백업 계획을 저장했습니다.').waitFor();
      fs.renameSync(output, displaced);
      await history.getByText(/실패 · 예약 실행/).waitFor();
      await instance.getByText('SQLite 예약 백업 실패', { exact: true }).waitFor();
      const failed = await state(profileId);
      assert.equal(failed.plan.retry_at, failed.runs[0].finished_at + 60);
      assert.equal(fs.readdirSync(displaced).length, 2);
      fs.renameSync(displaced, output);
      await history.getByText(/무결성 검사 통과 · 자동 재시도/).waitFor({ timeout: 75000 });
      const retried = await state(profileId);
      assert.equal(retried.plan.retry_at, null);
      assert.equal(retried.runs.length, 4);
      storeRun(retried.runs[0]);
      assert.equal(fs.readdirSync(output).length, 3);
      await instance.getByText('SQLite 예약 백업 완료', { exact: true }).waitFor();
      console.log('Ran the missed one-shot after restart once, restored it, reported a failed run and retried it successfully after one minute.');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exit(1); });
