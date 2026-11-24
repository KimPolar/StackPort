/* Uses only synthetic loopback sockets in an isolated Windows app. */
const net = require('net');
const dgram = require('dgram');
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
  if (errors.length) throw new Error(errors.join('\n'));
  await browser.close();
  client.destroy();
  accepted?.destroy();
  tcp.close();
  tcp6.close();
  console.log('Local TCP listening and established sockets, IPv6 UDP, PID/process names, filtering and refresh passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
