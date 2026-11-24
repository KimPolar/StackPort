/* Run each phase in an isolated StackPort process with the same metadata directory. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectName = 'Z 재시작 복원 검증';
const secondProjectName = 'A 재시작 기본 프로젝트';
const profileName = '복구 SQLite';
const secondProfileName = '다른 프로젝트 SQLite';
const draft = "SELECT 'SYNTHETIC_RESUME_PRIVATE_DRAFT'";
const discardedDraft = "SELECT 'SYNTHETIC_DISCARDED_DRAFT'";
const savedFile = () => path.join(path.dirname(process.env.STACKPORT_TEST_DATABASE), '복원할 SQL.sql');

function requestClose(pid) {
  if (!/^\d+$/.test(pid)) throw new Error('Set STACKPORT_TEST_WINDOW_PID to the isolated app PID.');
  const source = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ResumeTest { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'; $p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p.ProcessName -ne 'stackport' -or $p.MainWindowHandle -eq 0) { throw 'Invalid isolated StackPort window' }; [ResumeTest]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', source], { stdio: 'pipe' });
}

async function waitForSavedLayout(invoke, verify) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const record = await invoke('get_workspace_resume');
    if (verify(record.state?.layout)) return record;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The expected layout was not saved.');
}

async function writeLayout(page, invoke) {
  const secondProject = await invoke('create_project', { name: secondProjectName });
  const project = await invoke('create_project', { name: projectName });
  await invoke('create_sqlite_profile', {
    projectId: project.id, name: profileName, path: process.env.STACKPORT_TEST_DATABASE, environment: 'DEV',
  });
  await invoke('create_ssh_profile', {
    projectId: project.id,
    input: { name: '복구 SSH 정의', host: 'example.test', port: 22, username: 'stackport', environment: 'PROD' },
  });
  await invoke('create_sqlite_profile', {
    projectId: secondProject.id, name: secondProfileName, path: process.env.STACKPORT_TEST_DATABASE, environment: 'DEV',
  });
  await page.reload();
  const projectSelect = page.getByLabel('프로젝트', { exact: true });
  await projectSelect.selectOption(secondProject.id);
  await page.getByRole('button', { name: new RegExp(secondProfileName) }).click();
  await page.getByLabel('SQL 쿼리').fill(discardedDraft);
  await projectSelect.selectOption(project.id);
  await page.getByRole('button', { name: new RegExp(profileName) }).click();
  await page.getByLabel('SQL 쿼리').fill(draft);
  await page.getByRole('button', { name: '새 SQL 탭', exact: true }).click();
  await page.getByLabel('SQL 쿼리').fill(discardedDraft + ' -- same connection');
  await page.getByRole('tab', { name: 'SQL 1', exact: true }).click();
  await page.getByRole('button', { name: '화면 분할', exact: true }).click();
  await page.getByText('배치 설정', { exact: true }).click();
  await page.getByRole('button', { name: '2×2 배치', exact: true }).click();
  await page.getByText('배치 설정', { exact: true }).press('Escape');
  await page.getByRole('button', { name: 'CMD 열기', exact: true }).click();
  await page.getByRole('tab', { name: 'CMD 1', exact: true }).waitFor();
  const rootSeparator = page.getByRole('separator', { name: '데이터베이스 · 터미널 창 크기', exact: true });
  await rootSeparator.waitFor();

  const current = await waitForSavedLayout(invoke, layout => layout?.first?.kind === 'split');
  const competing = await invoke('save_workspace_resume', { expectedRevision: current.revision, state: current.state });
  assert.equal(competing.status, 'saved');
  await rootSeparator.press('ArrowDown');
  await page.getByRole('status').getByText('다른 창에서 작업 공간 배치를 저장했습니다.').waitFor();
  assert.equal((await invoke('get_workspace_resume')).state.layout.size, 50);
  await page.getByRole('button', { name: '이 창의 배치 저장', exact: true }).click();
  await waitForSavedLayout(invoke, layout => layout?.size === 55);

  await rootSeparator.press('ArrowDown');
  await page.getByRole('button', { name: '탐색기 접기', exact: true }).click();
  const exit = page.getByRole('dialog', { name: '앱 종료', exact: true });
  const fileDialog = page.getByRole('dialog', { name: 'SQL 파일로 저장', exact: true });
  const toClose = () => requestClose(process.env.STACKPORT_TEST_WINDOW_PID);
  const pending = exit.getByRole('list', { name: '미저장 SQL 초안' });
  toClose();
  await exit.getByRole('status').getByText('저장하지 않은 SQL 초안 3개', { exact: true }).waitFor();
  await exit.getByText(/열린 터미널 1개/).waitFor();
  await pending.getByText(`${secondProjectName} · ${secondProfileName}`, { exact: true }).waitFor();
  await exit.getByRole('button', { name: '계속 작업', exact: true }).click();
  await exit.waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('SQL 쿼리').inputValue(), draft);

  toClose();
  await pending.getByRole('button', { name: `${projectName} · ${profileName} · SQL 1 SQL 파일로 저장`, exact: true }).click();
  const occupied = path.join(path.dirname(savedFile()), '기존 파일.sql');
  fs.writeFileSync(occupied, 'SELECT 1;');
  const filePath = fileDialog.getByLabel('새 SQL 파일 경로', { exact: true });
  await filePath.fill(occupied);
  const save = fileDialog.getByRole('button', { name: '새 파일에 저장', exact: true });
  await save.click();
  await fileDialog.getByRole('alert').getByText(/같은 이름의 파일/).waitFor();
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'SELECT 1;');
  await filePath.fill(savedFile());
  await save.click();
  await fileDialog.waitFor({ state: 'detached' });
  assert.equal(fs.readFileSync(savedFile(), 'utf8'), draft);
  await exit.getByRole('status').getByText('저장하지 않은 SQL 초안 2개', { exact: true }).waitFor();
  await pending.getByText('SQL 2', { exact: true }).waitFor();
  await pending.getByText(`${secondProjectName} · ${secondProfileName}`, { exact: true }).waitFor();
  const closed = page.waitForEvent('close');
  await exit.getByRole('button', { name: '남은 초안 버리고 종료', exact: true }).click();
  await closed;
}

async function readLayout(page, invoke) {
  await page.getByRole('heading', { name: new RegExp(profileName) }).waitFor();
  const record = await invoke('get_workspace_resume');
  assert.deepEqual(Object.keys(record.state).sort(), ['explorer_open', 'layout', 'profile_id', 'project_id']);
  assert.equal(record.state.layout.direction, 'stack');
  assert.equal(record.state.layout.size, 60);
  assert.equal(record.state.explorer_open, false);
  assert.equal(JSON.stringify(record).includes(draft), false);
  assert.equal(JSON.stringify(record).includes(discardedDraft), false);
  const rootSeparator = page.getByRole('separator', { name: '데이터베이스 · 터미널 창 크기', exact: true });
  assert.equal(await rootSeparator.getAttribute('aria-valuenow'), '60');
  assert.equal(await page.locator('#workspace-panes > .workspace-pane-slot:visible').count(), 4);
  assert.equal(await page.getByLabel('SQL 쿼리').inputValue(), '');
  await page.getByText('열린 터미널이 없습니다', { exact: true }).waitFor();
  await page.getByText('열린 원격 데스크톱 창이 없습니다.', { exact: true }).waitFor();
  await page.getByRole('button', { name: '탐색기 펼치기', exact: true }).click();
  const project = page.getByLabel('프로젝트', { exact: true });
  assert.equal(await project.evaluate(select => select.selectedOptions[0].textContent), projectName);
  await page.getByRole('button', { name: 'SSH 복구 SSH 정의 연결', exact: true }).waitFor();
  await page.getByRole('button', { name: 'SQL 파일 열기', exact: true }).click();
  const fileDialog = page.getByRole('dialog', { name: 'SQL 파일 열기', exact: true });
  await fileDialog.getByLabel('SQL 파일 경로', { exact: true }).fill(savedFile());
  await fileDialog.getByRole('button', { name: '새 탭에서 열기', exact: true }).click();
  await fileDialog.waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('SQL 쿼리').inputValue(), draft);
  await project.selectOption({ label: secondProjectName });
  await page.getByRole('button', { name: new RegExp(secondProfileName) }).click();
  assert.equal(await page.getByLabel('SQL 쿼리').inputValue(), '');
}

async function main() {
  const phase = process.env.STACKPORT_RESUME_PHASE;
  assert.ok(['write', 'read'].includes(phase), 'Set STACKPORT_RESUME_PHASE to write or read.');
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  try {
    const page = browser.contexts().flatMap(context => context.pages())[0];
    const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
    await page.getByRole('button', { name: '명령 팔레트', exact: true }).waitFor();
    if (phase === 'write') await writeLayout(page, invoke);
    else await readLayout(page, invoke);
    console.log(`Workspace resume ${phase} phase passed.`);
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
