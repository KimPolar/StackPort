const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require(process.env.STACKPORT_PLAYWRIGHT_PATH || 'playwright');

async function withSecondDesktopInstance(root, run) {
  const executable = process.env.STACKPORT_TEST_APP_EXE;
  assert.ok(executable && path.isAbsolute(root), 'Set the executable and use an isolated desktop test root.');
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const child = spawn(executable, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'second-webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port + ' --disable-background-networking',
  } });
  let browser;
  let launchError;
  child.on('error', error => { launchError = error; });
  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (!ready && !launchError && child.exitCode === null && Date.now() < deadline) {
      ready = await fetch(url + '/json/version').then(response => response.ok, () => false);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (launchError) throw launchError;
    assert.ok(ready, 'Second isolated WebView2 instance did not start.');
    browser = await chromium.connectOverCDP(url);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
    const command = (name, args) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
    return await run(command);
  } finally {
    try { await browser?.close(); }
    finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'exit');
        child.kill();
        await closed;
      }
    }
  }
}

module.exports = { withSecondDesktopInstance };
