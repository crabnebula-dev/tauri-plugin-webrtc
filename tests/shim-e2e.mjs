// End to end: Tauri app (WebKitGTK + tauri-plugin-webrtc shim) <-> Chromium.
// Both sides run examples/e2e-app/dist/scenarios.js using standard APIs only.
// Usage: node shim-e2e.mjs [--mdns] [--app path/to/e2e-app] [--page index-csp.html]
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
const pageName = argv.includes('--page') ? argv[argv.indexOf('--page') + 1] : 'index.html';
const exe = process.env.CHROMIUM || undefined /* Playwright bundled Chromium */;
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
    if (m.t === 'log') { console.error(`[${m.name}] ${m.msg}`); return; }
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
const args = ['--autoplay-policy=no-user-gesture-required', ...(mdns ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns'])];
const browser = await chromium.launch({ executablePath: exe, args });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[chromium]', m.text()); });
await page.goto('about:blank');
await page.addScriptTag({ content: scenarios });
await page.evaluate((u) => connectHarness('chromium', u), url);

// WebKitGTK side: the Tauri app, as Tchap would ship it.
const killGroup = (p) => { try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill('SIGTERM'); } };
const app = spawn('xvfb-run', ['-a', appBin], {
  detached: true, // own process group: xvfb-run, Xvfb and the app die together
  env: { ...process.env, E2E_WS: url, E2E_PAGE: pageName, TCHAP_WEBRTC_E2E_WS: url, TCHAP_WEBRTC_E2E_SCENARIOS: path.join(root, 'examples/e2e-app/dist/scenarios.js'), RUST_LOG: process.env.RUST_LOG || 'warn' },
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
  // Media: WebKit offers video, Chromium answers matrix-style; then the reverse.
  answer = run('chromium', 'mediaAnswer');
  results.mediaWebkitOffers = await run('webkit', 'mediaOffer');
  results.mediaWebkitOffersChromiumSide = await answer;
  answer = run('webkit', 'mediaAnswer');
  results.mediaChromiumOffers = await run('chromium', 'mediaOffer');
  results.mediaChromiumOffersWebkitSide = await answer;
  // Audio: WebKit sends 440 Hz, Chromium sends 660 Hz; each must hear the other.
  answer = run('chromium', 'audio', { offer: false, freq: 660, expect: 440 });
  results.audioWebkitOffers = await run('webkit', 'audio', { offer: true, freq: 440, expect: 660 });
  results.audioWebkitOffersChromiumSide = await answer;
  answer = run('webkit', 'audio', { offer: false, freq: 440, expect: 660 });
  results.audioChromiumOffers = await run('chromium', 'audio', { offer: true, freq: 660, expect: 440 });
  results.audioChromiumOffersWebkitSide = await answer;
  // DTMF both ways; each side sends different tones, the shim side checks what arrived.
  answer = run('chromium', 'dtmf', { offer: false, tones: '90#', expect: '1A*' });
  results.dtmfWebkitOffers = await run('webkit', 'dtmf', { offer: true, tones: '1A,*', expect: '90#' });
  results.dtmfWebkitOffersChromiumSide = await answer;
  answer = run('webkit', 'dtmf', { offer: false, tones: '7B', expect: '58D' });
  results.dtmfChromiumOffers = await run('chromium', 'dtmf', { offer: true, tones: '58D', expect: '7B' });
  results.dtmfChromiumOffersWebkitSide = await answer;
  // H.264 only, both directions of media, each side offering once. Skipped
  // when the browser has no H.264 (Playwright's Chromium has no proprietary
  // codecs; point CHROMIUM at Google Chrome to run it).
  const h264 = hello.chromium && hello.chromium.h264;
  if (h264) {
  answer = run('chromium', 'h264', { offer: false });
  results.h264WebkitOffers = await run('webkit', 'h264', { offer: true });
  results.h264WebkitOffersChromiumSide = await answer;
  answer = run('webkit', 'h264', { offer: false });
  results.h264ChromiumOffers = await run('chromium', 'h264', { offer: true });
  results.h264ChromiumOffersWebkitSide = await answer;
  } else results.h264 = 'skipped: the browser peer has no H.264';
  const c = results.conformance;
  const conformanceOk = c.createAnswerInStable === 'InvalidStateError' && c.addTrack === 'TypeError'
    && c.addIceNoRemote === 'InvalidStateError' && c.sendBeforeOpen === 'InvalidStateError'
    && c.afterSetLocal === 'have-local-offer' && c.createAfterClose === 'InvalidStateError' && c.offerHasApplication && c.negotiationNeeded === true && c.matrixConfig === 'ok' && c.badSdp === 'OperationError' && c.badSdpState === 'stable';
  results.summary = {
    shimInstalled: !!(hello.webkit && hello.webkit.shim),
    conformanceOk,
    webkitOffers: results.webkitOffers.ok && results.webkitOffersChromiumSide.ok,
    chromiumOffers: results.chromiumOffers.ok && results.chromiumOffersWebkitSide.ok,
    mediaWebkitOffers: results.mediaWebkitOffers.ok && results.mediaWebkitOffersChromiumSide.ok,
    mediaChromiumOffers: results.mediaChromiumOffers.ok && results.mediaChromiumOffersWebkitSide.ok,
    audioWebkitOffers: results.audioWebkitOffers.ok && results.audioWebkitOffersChromiumSide.ok,
    audioChromiumOffers: results.audioChromiumOffers.ok && results.audioChromiumOffersWebkitSide.ok,
    dtmfWebkitOffers: results.dtmfWebkitOffers.ok && results.dtmfWebkitOffersChromiumSide.ok,
    dtmfChromiumOffers: results.dtmfChromiumOffers.ok && results.dtmfChromiumOffersWebkitSide.ok,
    ...(h264 ? {
      h264WebkitOffers: results.h264WebkitOffers.ok && results.h264WebkitOffersChromiumSide.ok,
      h264ChromiumOffers: results.h264ChromiumOffers.ok && results.h264ChromiumOffersWebkitSide.ok,
    } : {}),
  };
  exitCode = Object.values(results.summary).every(Boolean) ? 0 : 1;
} catch (e) {
  results.error = String(e.message || e);
} finally {
  console.log(JSON.stringify({ mdns, results }, null, 2));
  if (process.env.RESULT_FILE) (await import('node:fs')).writeFileSync(process.env.RESULT_FILE, JSON.stringify({ mdns, results }, null, 2));
  killGroup(app);
  await browser.close();
  wss.close();
  setTimeout(() => process.exit(exitCode), 500);
}
