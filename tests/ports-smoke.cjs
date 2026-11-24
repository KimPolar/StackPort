/* Uses only synthetic loopback sockets in an isolated Windows app. */
const net = require('net');
const dgram = require('dgram');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { once } = require('events');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');

async function main() {
  let accepted;
  const tcp = net.createServer(socket => { accepted = socket; });
  const tcp6 = net.createServer();
  const udp = dgram.createSocket('udp6');
  tcp.listen(0, '127.0.0.1');
  tcp6.listen(0, '::1');
  udp.bind(0, '::1');
  await Promise.all([once(tcp, 'listening'), once(tcp6, 'listening'), once(udp, 'listening')]);
  const client = net.connect(tcp.address().port, '127.0.0.1');
  await once(client, 'connect');
  const browser = await chromium.connectOverCDP(process.env.STACKPORT_CDP_URL || 'http://127.0.0.1:9331');
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (!page) throw new Error('No isolated WebView2 page.');
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.getByRole('button', { name: '네트워크', exact: true }).click();
  await page.getByRole('heading', { name: '로컬 포트', exact: true }).waitFor();
  const filter = page.getByLabel('주소·포트·PID·프로세스 찾기');
  const transport = page.getByLabel('전송 프로토콜');
  const ipVersion = page.getByLabel('IP 버전');
  const state = page.getByLabel('연결 상태');
  const table = page.getByRole('table', { name: '로컬 포트 목록' });
  const rowAt = endpoint => table.getByRole('row').filter({ has: page.getByRole('cell', { name: endpoint, exact: true }) });
  const endpoint4 = '127.0.0.1:' + tcp.address().port;
  await filter.fill(endpoint4);
  await table.waitFor();
  await state.selectOption('LISTEN');
  await rowAt(endpoint4).getByRole('cell', { name: 'TCP IPv4', exact: true }).waitFor();
  await rowAt(endpoint4).getByRole('cell', { name: String(process.pid), exact: true }).waitFor();
  await rowAt(endpoint4).getByRole('cell', { name: 'node.exe', exact: true }).waitFor();
  await filter.fill(endpoint4);
  await state.selectOption('ESTABLISHED');
  const serverConnection = table.getByRole('row').filter({
    has: page.getByRole('cell', { name: '127.0.0.1:' + client.localPort, exact: true }),
  }).filter({ has: page.getByRole('cell', { name: endpoint4, exact: true }) });
  if (await serverConnection.count() !== 2) throw new Error('Established loopback endpoints were not visible.');
  const endpoint6 = '[::1]:' + tcp6.address().port;
  await filter.fill(endpoint6);
  await ipVersion.selectOption('IPv6');
  await state.selectOption('LISTEN');
  await rowAt(endpoint6).getByRole('cell', { name: 'TCP IPv6', exact: true }).waitFor();

  const udpEndpoint = '[::1]:' + udp.address().port;
  await filter.fill(udpEndpoint);
  await transport.selectOption('UDP');
  await state.selectOption('BOUND');
  await rowAt(udpEndpoint).getByRole('cell', { name: 'UDP IPv6', exact: true }).waitFor();
  await rowAt(udpEndpoint).getByRole('cell', { name: String(process.pid), exact: true }).waitFor();
  const udpClosed = once(udp, 'close');
  udp.close();
  await udpClosed;
  await page.getByRole('button', { name: '포트 새로고침' }).click();
  await rowAt(udpEndpoint).waitFor({ state: 'detached' });
  await page.getByText('표시할 포트가 없습니다.', { exact: true }).waitFor();
  await page.getByRole('button', { name: '연결 진단', exact: true }).click();
  const tool = page.getByLabel('진단 유형');
  const target = page.getByLabel('대상 호스트 또는 IP');
  const run = page.getByRole('button', { name: '진단 실행', exact: true });
  await target.fill('127.0.0.1');
  await page.getByLabel('대상 포트').fill(String(tcp.address().port));
  await run.click();
  const tcpSuccess = page.getByRole('status', { name: '연결 진단 결과' }).getByText(/TCP 연결 성공/);
  await tcpSuccess.waitFor();
  await page.getByRole('button', { name: '데이터베이스', exact: true }).click();
  await page.getByRole('button', { name: '네트워크', exact: true }).click();
  await tcpSuccess.waitFor();
  if (await target.inputValue() !== '127.0.0.1') throw new Error('Leaving the network tool cleared the diagnostic target.');
  await page.getByRole('button', { name: '로컬 포트', exact: true }).click();
  if (await filter.inputValue() !== udpEndpoint) throw new Error('Leaving the ports view cleared its filter.');
  await page.getByRole('button', { name: '연결 진단', exact: true }).click();
  const route = page.getByRole('status', { name: '경로 진단 결과' });
  await tool.selectOption('ping');
  await target.fill('::1');
  await page.getByLabel('진단 IP 버전').selectOption('ipv6');
  await run.click();
  await route.getByText(/종료 코드 0/).waitFor();
  if (!(await route.locator('pre').first().innerText()).includes('::1')) throw new Error('IPv6 ping output was not displayed.');
  await tool.selectOption('trace');
  await target.fill('127.0.0.1');
  await page.getByLabel('진단 IP 버전').selectOption('ipv4');
  await run.click();
  await route.getByText(/종료 코드 0/).waitFor();
  if (!(await route.locator('pre').first().innerText()).includes('127.0.0.1')) throw new Error('IPv4 route output was not displayed.');
  await verifyWebDiagnostics(page);
  if (errors.length) throw new Error(errors.join('\n'));
  await browser.close();
  client.destroy();
  accepted?.destroy();
  tcp.close();
  tcp6.close();
  console.log('Local TCP and UDP ports, DNS/TCP, ping, route tracing, and HTTP status samples passed.');
}

async function verifyWebDiagnostics(page) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push([request.method, request.url, request.headers.cookie]);
    if (requests.length === 1) {
      response.writeHead(302, { Location: '/redirect', 'Set-Cookie': 'private=synthetic', 'X-Health': 'test-header' });
    } else {
      response.writeHead(503);
    }
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const tool = page.getByLabel('진단 유형');
  const address = page.getByLabel('대상 URL');
  const run = page.getByRole('button', { name: '진단 실행', exact: true });
  const result = page.getByRole('region', { name: '웹 상태 확인 결과' });
  try {
    await tool.selectOption('web');
    await address.fill(`http://127.0.0.1:${server.address().port}/health?source=desktop`);
    await page.getByLabel('요청 메서드').selectOption('GET');
    await page.getByLabel('요청 횟수').selectOption('2');
    await run.click();
    await result.getByRole('status').getByText('응답 2/2회 · HTTP 2xx 0회').waitFor();
    await result.getByText('HTTP 302', { exact: true }).click();
    await result.getByText('test-header', { exact: true }).waitFor();
    await result.getByText('[숨김]', { exact: true }).waitFor();
    await result.getByText('HTTP 503', { exact: true }).waitFor();
    if (requests.length !== 2 || requests.some(([method, url, cookie]) => method !== 'GET' || url !== '/health?source=desktop' || cookie !== undefined)) {
      throw new Error('Web check contacted another URL or sent a cookie.');
    }
    if ((await result.textContent()).includes('private=synthetic')) throw new Error('Sensitive response header was exposed.');
  } finally {
    server.close();
  }

  if (process.env.STACKPORT_TEST_TLS_CERT && process.env.STACKPORT_TEST_TLS_KEY) {
    let served = false;
    const untrusted = https.createServer({
      cert: fs.readFileSync(process.env.STACKPORT_TEST_TLS_CERT),
      key: fs.readFileSync(process.env.STACKPORT_TEST_TLS_KEY),
    }, () => { served = true; });
    untrusted.listen(0, '127.0.0.1');
    await once(untrusted, 'listening');
    try {
      await address.fill(`https://127.0.0.1:${untrusted.address().port}/`);
      await page.getByLabel('요청 횟수').selectOption('1');
      await run.click();
      await result.getByText('HTTPS 인증서 검증 실패', { exact: true }).waitFor();
      if (served) throw new Error('App sent an HTTP request to the untrusted server.');
      console.log('Untrusted loopback TLS certificate was rejected.');
    } finally {
      untrusted.close();
    }
  }
  if (process.env.STACKPORT_TEST_HTTPS_URL) {
    await address.fill(process.env.STACKPORT_TEST_HTTPS_URL);
    await page.getByLabel('요청 메서드').selectOption('HEAD');
    await page.getByLabel('요청 횟수').selectOption('1');
    await run.click();
    await result.getByText(/TLS 1\.[23] · 인증서 검증 통과 · TLS_/).waitFor();
    console.log('Trusted HTTPS handshake returned its protocol and cipher suite.');
  }
}

main().catch(error => { console.error(error); process.exit(1); });
