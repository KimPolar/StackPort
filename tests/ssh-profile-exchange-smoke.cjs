/* Attach only to an isolated test instance. See docs/IMPLEMENTATION.md. */
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const path = require('path');

const root = process.env.STACKPORT_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Set STACKPORT_TEST_ROOT to the isolated test directory.');

async function createProfile(page, name, host, environment) {
  await page.getByRole('button', { name: 'SSH 연결 추가' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('연결 이름').fill(name);
  await dialog.getByLabel('호스트 또는 IP').fill(host);
  await dialog.getByLabel('사용자 이름').fill('stackport');
  await dialog.locator('select').selectOption(environment);
  await dialog.getByRole('button', { name: '저장' }).click();
  await page.getByRole('button', { name: `SSH ${name} 연결` }).waitFor();
}

async function main() {
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (!page) throw new Error('No isolated WebView2 page found.');
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByLabel('이름', { exact: true }).fill('교환 테스트');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await createProfile(page, '공유 운영', 'prod.example.com', 'PROD');
  await createProfile(page, '선택하지 않음', 'other.example.com', 'DEV');

  const file = path.join(root, 'export.json');
  await page.getByRole('button', { name: 'SSH 연결 내보내기' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.locator('input[placeholder="절대 경로를 입력하세요"]').fill(file);
  await dialog.getByRole('checkbox', { name: /공유 운영/ }).check();
  await dialog.getByRole('button', { name: '선택한 연결 내보내기' }).click();
  await dialog.getByRole('status').getByText('SSH 연결 1개를 내보냈습니다.').waitFor();
  await dialog.getByRole('button', { name: '완료' }).click();
  const contents = fs.readFileSync(file, 'utf8');
  const document = JSON.parse(contents);
  if (document.format !== 'stackport.ssh-profiles' || document.version !== 1 || document.profiles.length !== 1 || document.profiles[0].name !== '공유 운영' || document.profiles[0].environment !== 'PROD') throw new Error('The selected profile was not exported correctly.');
  if (Object.keys(document.profiles[0]).sort().join(',') !== 'environment,host,name,port,username' || contents.includes('선택하지 않음')) throw new Error('Export included unexpected metadata or another profile.');

  await page.getByRole('button', { name: 'SSH 연결 내보내기' }).click();
  dialog = page.getByRole('dialog');
  await dialog.locator('input[placeholder="절대 경로를 입력하세요"]').fill(file);
  await dialog.getByRole('checkbox', { name: /공유 운영/ }).check();
  await dialog.getByRole('button', { name: '선택한 연결 내보내기' }).click();
  await dialog.getByRole('alert').getByText(/덮어쓰지 않습니다/).waitFor();
  if (fs.readFileSync(file, 'utf8') !== contents) throw new Error('Export overwrote an existing file.');
  await dialog.getByRole('button', { name: '취소' }).click();

  await page.getByRole('button', { name: 'SSH 연결 가져오기' }).click();
  dialog = page.getByRole('dialog');
  await dialog.locator('input[placeholder="절대 경로를 입력하세요"]').fill(file);
  await dialog.getByRole('button', { name: '파일 확인' }).click();
  await dialog.getByText('stackport@prod.example.com:22 · PROD').waitFor();
  await dialog.getByRole('checkbox', { name: /공유 운영/ }).check();
  document.profiles[0].host = 'changed.example.com';
  fs.writeFileSync(file, JSON.stringify(document));
  await dialog.getByRole('button', { name: '선택한 연결 가져오기' }).click();
  await dialog.getByRole('alert').getByText(/파일이 변경/).waitFor();
  if (await page.getByRole('button', { name: 'SSH 공유 운영 연결' }).count() !== 1) throw new Error('A changed file was imported without review.');
  await dialog.getByRole('button', { name: '취소' }).click();

  await page.getByRole('button', { name: 'SSH 연결 가져오기' }).click();
  dialog = page.getByRole('dialog');
  await dialog.locator('input[placeholder="절대 경로를 입력하세요"]').fill(file);
  await dialog.getByRole('button', { name: '파일 확인' }).click();
  await dialog.getByText('stackport@changed.example.com:22 · PROD').waitFor();
  await dialog.getByRole('checkbox', { name: /공유 운영/ }).check();
  await dialog.getByRole('button', { name: '선택한 연결 가져오기' }).click();
  await dialog.getByRole('status').getByText('SSH 연결 1개를 가져왔습니다.').waitFor();
  await dialog.getByRole('button', { name: '완료' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label="SSH 공유 운영 연결"]')].length === 2);
  const profiles = await page.evaluate(async () => {
    const projects = await window.__TAURI_INTERNALS__.invoke('list_projects');
    return window.__TAURI_INTERNALS__.invoke('list_ssh_profiles', { projectId: projects.find(item => item.name === '교환 테스트').id });
  });
  if (!profiles.some(item => item.name === '공유 운영' && item.host === 'changed.example.com' && item.environment === 'PROD')) throw new Error('Reviewed profile was not imported.');
  if (fs.readdirSync(root).some(name => name.startsWith('.stackport-ssh-export-'))) throw new Error('Temporary export file was left behind.');
  await page.getByRole('button', { name: '작업 기록' }).click();
  await page.getByText('SSH 연결 가져오기', { exact: true }).last().waitFor();
  await page.getByText('SSH 연결 내보내기', { exact: true }).last().waitFor();
  if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`);
  await browser.close();
  console.log('SSH profile selection, versioned export, overwrite protection, reviewed import, and audit history passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
