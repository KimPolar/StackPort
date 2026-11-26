/* Windows desktop test. The runner restarts StackPort between prepare and resume. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { chooseDatabase } = require('./database-picker.cjs');

const root = process.env.STACKPORT_TEST_ROOT;
const phase = process.env.STACKPORT_BACKUP_TEST_PHASE;
const fixtureFile = root && path.join(root, 'schedule.json');
if (!root || !['prepare', 'resume', 'calendar', 'retry'].includes(phase)) throw new Error('Set the isolated root and prepare/resume/calendar/retry phase.');

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
    const file = path.join(output, path.basename(run.path));
    assert.equal(run.artifact.sha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    assert.match(run.artifact.engine_version, /^\d+\.\d+\.\d+$/);
    verifySnapshot(file);
  };

  try {
    if (phase !== 'resume') {
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
        if (phase === 'calendar' || phase === 'retry') {
          const verify = phase === 'calendar' ? verifyCalendarPlan : verifyRetryPlan;
          await verify(dialog, history, () => state(profile.id), storeRun);
          assert.deepEqual(errors, []);
          return;
        }
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

      const artifactRun = retried.runs[0];
      const file = path.join(output, path.basename(artifactRun.path));
      const original = fs.readFileSync(file);
      const details = history.locator('details').filter({ hasText: '자동 재시도' });
      await details.locator('summary').click();
      await details.getByText(artifactRun.artifact.sha256, { exact: true }).waitFor();
      await details.getByRole('button', { name: '파일 지문 확인' }).click();
      await details.getByRole('status').getByText(/생성 당시 기록과 일치/).waitFor();
      assert.equal(await details.getByRole('button', { name: '만료 파일 삭제' }).count(), 0);
      await assert.rejects(command('preview_sqlite_backup_removal', { profileId, runId: artifactRun.id }), /보존 기간/);
      const metadata = new DatabaseSync(path.join(root, 'workspace', 'workspace.sqlite'));
      try { metadata.prepare('UPDATE backup_runs SET expires_at=0 WHERE id=?').run(artifactRun.id); }
      finally { metadata.close(); }
      await dialog.getByRole('button', { name: '만료 파일', exact: true }).click();
      await details.locator('summary').waitFor();
      if (await details.getAttribute('open') === null) await details.locator('summary').click();

      const remove = details.getByRole('button', { name: '만료 파일 삭제' });
      const approval = page.getByRole('dialog', { name: '만료 백업 영구 삭제', exact: true });
      await remove.click();
      await approval.getByText(file, { exact: true }).waitFor();
      await approval.getByText(artifactRun.artifact.sha256, { exact: true }).waitFor();
      await approval.getByRole('button', { name: '취소', exact: true }).click();
      assert.deepEqual(fs.readFileSync(file), original);

      await remove.click();
      await approval.getByRole('button', { name: '영구 삭제', exact: true }).waitFor();
      const changed = Buffer.from(original);
      changed[changed.length - 1] ^= 1;
      fs.writeFileSync(file, changed);
      await approval.getByRole('button', { name: '영구 삭제', exact: true }).click();
      await details.getByRole('alert').getByText(/파일이 변경/).waitFor();
      assert.deepEqual(fs.readFileSync(file), changed);

      fs.writeFileSync(file, original);
      await remove.click();
      await approval.getByRole('button', { name: '영구 삭제', exact: true }).click();
      await history.getByText('정리할 만료 파일이 없습니다.').waitFor();
      await dialog.getByRole('button', { name: '최근 실행', exact: true }).click();
      await details.locator('summary').click();
      await details.getByText(/파일 삭제 완료/).waitFor();
      assert.equal(fs.existsSync(file), false);
      assert.equal(fs.readdirSync(output).length, 2);
      const saved = (await state(profileId)).runs.find(run => run.id === artifactRun.id);
      assert.ok(saved.artifact.verified_at > 0 && saved.artifact.removed_at > 0);
      console.log('Verified stored SHA-256, blocked unexpired and changed files, and removed only the reviewed expired backup.');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

async function verifyCalendarPlan(dialog, history, state, storeRun) {
  await dialog.getByLabel('실행 주기').selectOption('calendar');
  await dialog.getByLabel('Cron 식', { exact: true }).fill('0 9 * * MON');
  const zone = dialog.getByLabel('예약 시간대', { exact: true });
  const preview = dialog.getByRole('button', { name: '일정 미리보기', exact: true });
  const dates = dialog.getByRole('list', { name: '다음 실행 시각', exact: true });
  const excluded = dialog.getByLabel('제외 날짜 (선택)');
  await zone.fill('Invalid/Place');
  await preview.click();
  await dialog.getByRole('alert').getByText(/IANA 시간대/).waitFor();
  await zone.fill('Asia/Seoul');
  await preview.click();
  await dates.getByRole('listitem').first().waitFor();
  const entries = await dates.getByRole('listitem').allTextContents();
  assert.equal(entries.length, 5);
  assert.match(entries[0], /^\d{4}-\d{2}-\d{2} 09:00 \+09:00$/);
  await excluded.fill(entries[0].slice(0, 10));
  await preview.click();
  await dates.getByText(entries[1], { exact: true }).waitFor();
  assert.equal((await dates.getByRole('listitem').first().innerText()), entries[1]);
  await dialog.getByLabel('Cron 식', { exact: true }).fill('* * * * *');
  await excluded.fill('2099-12-25');
  await dialog.getByRole('button', { name: '계획 저장', exact: true }).click();
  await dialog.getByText('백업 계획을 저장했습니다.', { exact: true }).waitFor();
  const { plan } = await state();
  assert.deepEqual(plan.calendar, { expression: '* * * * *', time_zone: 'Asia/Seoul', excluded_dates: ['2099-12-25'] });
  assert.equal(plan.interval_minutes, null);
  console.log('Validated the calendar preview and waiting for the next real minute tick.');
  await history.getByText(/무결성 검사 통과 · 예약 실행/).first().waitFor({ timeout: 75000 });
  const onward = await state();
  const run = onward.runs.find(item => item.trigger_kind === 'scheduled');
  storeRun(run);
  assert.ok(run.started_at >= plan.next_at && onward.plan.next_at > run.started_at);
  assert.equal(onward.plan.next_at % 60, 0);
  await dialog.getByRole('button', { name: '예약 중지', exact: true }).click();
  await dialog.getByText('예약 실행을 중지했습니다.', { exact: true }).waitFor();
  const paused = (await state()).plan;
  assert.equal(paused.next_at, null);
  assert.deepEqual(paused.calendar, plan.calendar);
  assert.equal(await zone.inputValue(), 'Asia/Seoul');
  console.log('Ran a real calendar backup and kept the calendar rule when paused.');
}

async function verifyRetryPlan(dialog, history, state, storeRun) {
  const scheduled = dialog.getByRole('checkbox', { name: '예약 실행', exact: true });
  const save = dialog.getByRole('button', { name: '계획 저장', exact: true });
  const savedNotice = dialog.getByText('백업 계획을 저장했습니다.', { exact: true });
  const gap = dialog.getByLabel('재시도 간격 (분)', { exact: true });
  await scheduled.uncheck();
  await dialog.getByLabel('최대 재시도 횟수', { exact: true }).fill('2');
  await gap.fill('3');
  await save.click();
  await savedNotice.waitFor();
  const paused = (await state()).plan;
  assert.equal(paused.retry_limit, 2);
  assert.equal(paused.retry_delay_minutes, 3);
  assert.equal(paused.next_at, null);

  await scheduled.check();
  await dialog.getByLabel('실행 주기').selectOption('once');
  await gap.fill('1');
  await dialog.getByLabel('첫 실행 (이 장치 시각)').fill(dateInput(Math.floor(Date.now() / 1000) + 9));
  await save.click();
  await savedNotice.waitFor();
  fs.renameSync(output, displaced);
  try {
    await history.getByText(/실패 · 예약 실행/).waitFor();
    const initial = await state();
    assert.equal(initial.runs[0].retry_attempt, null);
    assert.equal(initial.plan.retry_attempt, 1);
    assert.equal(initial.plan.retry_at - initial.runs[0].finished_at, 60);
    console.log('The initial failure queued retry 1, using the saved retry interval.');
    await history.getByText(/실패 · 자동 재시도 \(1차\)/).waitFor({ timeout: 80000 });
    const firstRetry = await state();
    assert.equal(firstRetry.runs[0].retry_attempt, 1);
    assert.equal(firstRetry.plan.retry_attempt, 2);
    assert.equal(firstRetry.plan.retry_at - firstRetry.runs[0].finished_at, 60);
    assert.equal(fs.readdirSync(displaced).length, 0);
  } finally { fs.renameSync(displaced, output); }
  await history.getByText(/무결성 검사 통과 · 자동 재시도 \(2차\)/).waitFor({ timeout: 80000 });
  const finished = await state();
  assert.equal(finished.plan.retry_at, null);
  assert.equal(finished.plan.retry_attempt, null);
  assert.deepEqual(finished.runs.map(run => run.retry_attempt), [2, 1, null]);
  storeRun(finished.runs[0]);
  assert.equal(fs.readdirSync(output).length, 1);
  console.log('Retry 2 published the verified backup and cleared the pending retry.');
}

main().catch(error => { console.error(error); process.exit(1); });
