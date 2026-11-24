/* Run each phase in an isolated StackPort process with the same metadata directory. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const projectName = 'Z 재시작 복원 검증';
const profileName = '복구 SQLite';
const draft = "SELECT 'SYNTHETIC_RESUME_PRIVATE_DRAFT'";

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
  await invoke('create_project', { name: 'A 재시작 기본 프로젝트' });
  const project = await invoke('create_project', { name: projectName });
  await invoke('create_sqlite_profile', {
    projectId: project.id, name: profileName, path: process.env.STACKPORT_TEST_DATABASE, environment: 'DEV',
  });
  await invoke('create_ssh_profile', {
    projectId: project.id,
    input: { name: '복구 SSH 정의', host: 'example.test', port: 22, username: 'stackport', environment: 'PROD' },
  });
  await page.reload();
  await page.getByLabel('프로젝트', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: new RegExp(profileName) }).click();
  await page.getByLabel('SQL 쿼리').fill(draft);
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
  const prompt = page.waitForEvent('dialog');
  const closed = page.waitForEvent('close');
  requestClose(process.env.STACKPORT_TEST_WINDOW_PID);
  const confirmation = await prompt;
  assert.match(confirmation.message(), /열린 터미널 1개/);
  assert.match(confirmation.message(), /SQL 초안/);
  await confirmation.accept();
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
