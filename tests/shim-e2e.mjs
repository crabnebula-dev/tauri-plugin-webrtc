// End to end: Tauri app (WebKitGTK + tauri-plugin-webrtc shim) <-> Chromium.
// Both sides run examples/e2e-app/dist/scenarios.js using standard APIs only.
// Usage: node shim-e2e.mjs [--mdns] [--app path/to/e2e-app]
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const appBin = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : path.join(root, 'target/debug/e2e-app');
const mdns = argv.includes('--mdns');
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const scenarios = readFileSync(path.join(root, 'examples/e2e-app/dist/scenarios.js'), 'utf8');

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => wss.on('listening', r));
const url = `ws://127.0.0.1:${wss.address().port}`;
const clients = {};
const waiters = [];
const hello = {};
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.t === 'hello') { clients[m.name] = ws; hello[m.name] = m.env; }
    else if (m.t === 'signal') {
      for (const [n, c] of Object.entries(clients)) if (c !== ws) c.send(JSON.stringify(m));
    } else if (m.t === 'result') {
      waiters.filter((w) => w.name === m.name && w.what === m.what).forEach((w) => w.resolve(m.result));
    }
  });
});
const waitFor = (pred, ms, what) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => (pred() ? res() : Date.now() - t0 > ms ? rej(new Error(`timeout: ${what}`)) : setTimeout(tick, 50));
  tick();
});
const run = (name, what, opts, ms = 60000) => new Promise((resolve) => {
  console.error(`[harness] ${name}: ${what}`);
  const timer = setTimeout(() => resolve({ ok: false, error: `timeout ${ms}ms` }), ms);
  waiters.push({ name, what, resolve: (r) => { clearTimeout(timer); resolve(r); } });
  clients[name].send(JSON.stringify({ t: 'run', what, opts }));
});

// Chromium side.
const args = mdns ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns'];
const browser = await chromium.launch({ executablePath: exe, args });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[chromium]', m.text()); });
await page.goto('about:blank');
await page.addScriptTag({ content: scenarios });
await page.evaluate((u) => connectHarness('chromium', u), url);

// WebKitGTK side: the Tauri app, as Tchap would ship it.
const app = spawn('xvfb-run', ['-a', appBin], {
  env: { ...process.env, E2E_WS: url, TCHAP_WEBRTC_E2E_WS: url, TCHAP_WEBRTC_E2E_SCENARIOS: path.join(root, 'examples/e2e-app/dist/scenarios.js'), RUST_LOG: process.env.RUST_LOG || 'warn' },
  stdio: ['ignore', 'inherit', 'pipe'],
});
app.stderr.on('data', (d) => {
  const s = String(d);
  if (!/libEGL|MESA|DRI3|dbus|D-Bus|EGL display/i.test(s)) process.stderr.write('[app] ' + s);
});

const results = {};
let exitCode = 1;
try {
  await waitFor(() => clients.webkit && clients.chromium, 60000, 'both peers connected');
  results.env = hello;
  results.conformance = await run('webkit', 'conformance');
  // WebKit (shim) offers; Chromium answers and echoes.
  let answer = run('chromium', 'answer');
  results.webkitOffers = await run('webkit', 'offer');
  results.webkitOffersChromiumSide = await answer;
  // Chromium offers; WebKit (shim) answers and echoes.
  answer = run('webkit', 'answer');
  results.chromiumOffers = await run('chromium', 'offer');
  results.chromiumOffersWebkitSide = await answer;
  const c = results.conformance;
  const conformanceOk = c.createAnswerInStable === 'InvalidStateError' && c.addTrack === 'NotSupportedError'
    && c.addIceNoRemote === 'InvalidStateError' && c.sendBeforeOpen === 'InvalidStateError'
    && c.afterSetLocal === 'have-local-offer' && c.createAfterClose === 'InvalidStateError' && c.offerHasApplication && c.negotiationNeeded === true && c.matrixConfig === 'ok' && c.badSdp === 'OperationError' && c.badSdpState === 'stable';
  results.summary = {
    shimInstalled: !!(hello.webkit && hello.webkit.shim),
    conformanceOk,
    webkitOffers: results.webkitOffers.ok && results.webkitOffersChromiumSide.ok,
    chromiumOffers: results.chromiumOffers.ok && results.chromiumOffersWebkitSide.ok,
  };
  exitCode = Object.values(results.summary).every(Boolean) ? 0 : 1;
} catch (e) {
  results.error = String(e.message || e);
} finally {
  console.log(JSON.stringify({ mdns, results }, null, 2));
  app.kill('SIGTERM');
  await browser.close();
  wss.close();
  setTimeout(() => process.exit(exitCode), 500);
}
