// LiveKit end to end: the Tauri app (WebKitGTK + shim) and Chromium join the
// same room on a local livekit-server, publish a tone and a marked video, and
// each checks it hears and sees the other. Runs without and with E2EE
// (livekit-client's own worker, RTCRtpScriptTransform on the WebKit side).
// Usage: node livekit-e2e.mjs [--app path/to/e2e-app] [--only plain|e2ee] [--no-simulcast] [--iframe]
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const appBin = arg('--app', path.join(root, 'target/debug/e2e-app'));
const only = arg('--only', null);
const simulcast = !argv.includes('--no-simulcast');
// --iframe: the WebKit side runs inside a sandboxed same-origin iframe, as
// Element Call does when embedded in Element Web / Tchap.
const iframe = argv.includes('--iframe');
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const lkBin = process.env.LIVEKIT_SERVER || '/home/claude/livekit/livekit-server';
const dist = path.join(root, 'examples/e2e-app/dist');
for (const f of ['lk/livekit-client.umd.js', 'lk/livekit-client.e2ee.worker.mjs']) {
  if (!existsSync(path.join(dist, f))) {
    console.error(`missing ${f}: copy it from tests/node_modules/livekit-client/dist and rebuild e2e-app`);
    process.exit(2);
  }
}

// livekit-server in dev mode (API key "devkey", secret "secret"). Media must
// use a non-loopback address: Chromium does not gather loopback candidates.
const nodeIp = process.env.LK_NODE_IP || Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;
if (!nodeIp) { console.error('no non-loopback IPv4 address; set LK_NODE_IP'); process.exit(2); }
const lk = spawn(lkBin, ['--dev', '--bind', '0.0.0.0', '--node-ip', nodeIp], { stdio: ['ignore', 'pipe', 'pipe'] });
let lkOut = '';
lk.stdout.on('data', (d) => { lkOut += d; });
lk.stderr.on('data', (d) => { lkOut += d; });
const portOpen = (port) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});
for (let i = 0; i < 100 && !(await portOpen(7880)); i++) await new Promise((r) => setTimeout(r, 100));
const lkUrl = 'ws://127.0.0.1:7880';
const token = async (identity, room) => {
  const t = new AccessToken('devkey', 'secret', { identity, ttl: '10m' });
  t.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
  return t.toJwt();
};

// Static server for Chromium (module workers do not load from file://).
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json' };
const http = createServer((req, res) => {
  const p = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(dist) || !existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }).end(readFileSync(p));
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => wss.on('listening', r));
const wsUrl = `ws://127.0.0.1:${wss.address().port}`;
const clients = {}; const hello = {}; const waiters = [];
wss.on('connection', (ws) => ws.on('message', (data) => {
  const m = JSON.parse(data);
  if (m.t === 'log') console.error(`[${m.name}] ${m.msg}`);
  else if (m.t === 'hello') { clients[m.name] = ws; hello[m.name] = m.env; }
  else if (m.t === 'result') waiters.filter((w) => w.name === m.name).forEach((w) => w.resolve(m.result));
}));
const run = (name, opts, ms = 90000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, error: `timeout ${ms}ms` }), ms);
  waiters.push({ name, resolve: (r) => { clearTimeout(timer); waiters.splice(waiters.findIndex((w) => w.name === name), 1); resolve(r); } });
  clients[name].send(JSON.stringify({ t: 'run', what: 'livekit', opts }));
});

const browser = await chromium.launch({ executablePath: exe, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[chromium console]', m.text()); });
await page.addInitScript((u) => { window.__E2E_WS__ = u; window.__E2E_NAME__ = 'chromium'; }, wsUrl);
await page.goto(`http://127.0.0.1:${http.address().port}/lk.html`);

const killGroup = (p) => { try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill('SIGTERM'); } };
const app = spawn('xvfb-run', ['-a', appBin], {
  detached: true, // own process group: xvfb-run, Xvfb and the app die together
  env: { ...process.env, E2E_WS: wsUrl, E2E_PAGE: iframe ? 'lk-frame.html' : 'lk.html', RUST_LOG: process.env.RUST_LOG || 'warn' },
  stdio: ['ignore', 'inherit', 'pipe'],
});
app.stderr.on('data', (d) => {
  const s = String(d);
  if (!/libEGL|MESA|DRI3|dbus|D-Bus|EGL display|AT-SPI/i.test(s)) process.stderr.write('[app] ' + s);
});

const RED = [255, 0, 0]; const BLUE = [0, 0, 255];
const results = { simulcast, iframe };
let exitCode = 1;
try {
  const t0 = Date.now();
  while (!(clients.webkit && clients.chromium)) {
    if (Date.now() - t0 > 60000) throw new Error('peers did not connect to the harness');
    await new Promise((r) => setTimeout(r, 100));
  }
  results.env = hello;
  const key = 'correct horse battery staple';
  for (const mode of ['plain', 'e2ee']) {
    if (only && only !== mode) continue;
    const room = `room-${mode}-${Date.now()}`;
    const e2ee = mode === 'e2ee';
    console.error(`[harness] ${mode}`);
    const [webkit, chrome] = await Promise.all([
      run('webkit', { url: lkUrl, token: await token('webkit', room), key, e2ee, simulcast, freq: 440, expectFreq: 660, marker: '#ff0000', expectMarker: BLUE }),
      run('chromium', { url: lkUrl, token: await token('chromium', room), key, e2ee, simulcast, freq: 660, expectFreq: 440, marker: '#0000ff', expectMarker: RED }),
    ]);
    results[mode] = { webkit, chromium: chrome };
  }
  results.summary = Object.fromEntries(['plain', 'e2ee'].filter((m) => results[m]).map((m) => [m, !!(results[m].webkit.ok && results[m].chromium.ok)]));
  exitCode = Object.values(results.summary).every(Boolean) ? 0 : 1;
} catch (e) {
  results.error = String(e.message || e);
} finally {
  console.log(JSON.stringify(results, null, 2));
  if (process.env.RESULT_FILE) writeFileSync(process.env.RESULT_FILE, JSON.stringify(results, null, 2));
  if (process.env.LK_LOG) writeFileSync(process.env.LK_LOG, lkOut);
  killGroup(app); lk.kill('SIGTERM');
  await browser.close(); wss.close(); http.close();
  setTimeout(() => process.exit(exitCode), 500);
}
