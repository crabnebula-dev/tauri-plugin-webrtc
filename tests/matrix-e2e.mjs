// Matrix 1:1 calls end to end: the Tauri app (WebKitGTK + shim) and Chromium
// log in to a local homeserver as two users and call each other with the real
// matrix-js-sdk, in both directions, including a screen-share renegotiation.
//
// The homeserver is Synapse, used as an external test fixture (set
// SYNAPSE_PY to a Python with matrix-synapse installed).
// Usage: node matrix-e2e.mjs [--app path/to/e2e-app] [--only webkit-calls|chromium-calls]
//        [--tchap]  (--app is a Tchap build with the TEST ONLY harness hook)
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const appBin = arg('--app', path.join(root, 'target/debug/e2e-app'));
const only = arg('--only', null);
const tchap = argv.includes('--tchap');
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const py = process.env.SYNAPSE_PY || '/home/claude/synapse-venv/bin/python';
const dist = path.join(root, 'examples/e2e-app/dist');
if (!existsSync(path.join(dist, 'mx/matrix.js'))) {
  console.error('missing dist/mx/matrix.js: run node tests/matrix/build.mjs and rebuild e2e-app');
  process.exit(2);
}

// ------------------------------------------------------------- homeserver
const hsDir = process.env.SYNAPSE_DIR || '/tmp/tauri-webrtc-synapse';
const hsPort = 8008;
const hsUrl = `http://127.0.0.1:${hsPort}`;
if (!existsSync(path.join(hsDir, 'homeserver.yaml'))) {
  mkdirSync(hsDir, { recursive: true });
  execFileSync(py, ['-m', 'synapse.app.homeserver', '--server-name', 'localhost', '--config-path', path.join(hsDir, 'homeserver.yaml'),
    '--data-directory', hsDir, '--generate-config', '--report-stats=no'], { stdio: 'ignore' });
  appendFileSync(path.join(hsDir, 'homeserver.yaml'), `
# tauri-plugin-webrtc test overrides
listeners:
  - port: ${hsPort}
    bind_addresses: ['127.0.0.1']
    type: http
    x_forwarded: false
    resources:
      - names: [client]
        compress: false
registration_shared_secret: "webrtc-e2e-secret"
rc_message: { per_second: 1000, burst_count: 1000 }
rc_login:
  address: { per_second: 1000, burst_count: 1000 }
  account: { per_second: 1000, burst_count: 1000 }
  failed_attempts: { per_second: 1000, burst_count: 1000 }
rc_joins:
  local: { per_second: 1000, burst_count: 1000 }
rc_invites: { per_room: { per_second: 1000, burst_count: 1000 }, per_user: { per_second: 1000, burst_count: 1000 } }
`);
}
const hs = spawn(py, ['-m', 'synapse.app.homeserver', '-c', path.join(hsDir, 'homeserver.yaml')], { cwd: hsDir, stdio: ['ignore', 'ignore', 'pipe'] });
let hsErr = ''; hs.stderr.on('data', (d) => { hsErr += d; });
const portOpen = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
for (let i = 0; i < 300 && !(await portOpen(hsPort)); i++) await new Promise((r) => setTimeout(r, 100));

const api = async (method, p, body, token) => {
  const r = await fetch(hsUrl + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
// Shared-secret registration (Synapse admin API), then a fresh login.
async function user(name) {
  const password = `pw-${name}`;
  const { nonce } = await api('GET', '/_synapse/admin/v1/register');
  const mac = createHmac('sha1', 'webrtc-e2e-secret').update(`${nonce}\0${name}\0${password}\0notadmin`).digest('hex');
  try { await api('POST', '/_synapse/admin/v1/register', { nonce, username: name, password, admin: false, mac }); } catch (e) { if (!/User ID already taken/.test(e.message)) throw e; }
  const l = await api('POST', '/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: name }, password });
  return { userId: l.user_id, accessToken: l.access_token, deviceId: l.device_id };
}

// ------------------------------------------------------------- harness
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const http = createServer((req, res) => {
  const p = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(dist) || !existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }).end(readFileSync(p));
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => wss.on('listening', r));
const wsUrl = `ws://127.0.0.1:${wss.address().port}`;
const clients = {}; const hello = {}; const waiters = []; const barriers = {};
wss.on('connection', (ws) => ws.on('message', (data) => {
  const m = JSON.parse(data);
  if (m.t === 'log') console.error(`[${m.name}] ${m.msg}`);
  else if (m.t === 'hello') { clients[m.name] = ws; hello[m.name] = m.env; }
  else if (m.t === 'barrier') {
    const b = (barriers[m.id] = barriers[m.id] || new Set()); b.add(m.name);
    if (b.size === 2) { delete barriers[m.id]; for (const c of Object.values(clients)) c.send(JSON.stringify({ t: 'barrier', id: m.id })); }
  } else if (m.t === 'result') waiters.filter((w) => w.name === m.name).forEach((w) => w.resolve(m.result));
}));
const run = (name, opts, ms = 120000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, error: `timeout ${ms}ms` }), ms);
  const w = { name, resolve: (r) => { clearTimeout(timer); waiters.splice(waiters.indexOf(w), 1); resolve(r); } };
  waiters.push(w);
  clients[name].send(JSON.stringify({ t: 'run', what: 'matrix', opts }));
});

const browser = await chromium.launch({ executablePath: exe, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[chromium console]', m.text().slice(0, 300)); });
await page.addInitScript((u) => { window.__E2E_WS__ = u; window.__E2E_NAME__ = 'chromium'; }, wsUrl);
await page.goto(`http://127.0.0.1:${http.address().port}/mx.html`);

const killGroup = (p) => { try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill('SIGTERM'); } };
const app = spawn('xvfb-run', ['-a', appBin], {
  detached: true,
  env: {
    ...process.env, E2E_WS: wsUrl, E2E_PAGE: 'mx.html', RUST_LOG: process.env.RUST_LOG || 'warn',
    ...(tchap ? {
      TCHAP_WEBRTC_E2E_WS: wsUrl,
      TCHAP_WEBRTC_E2E_SCRIPTS: ['mx/matrix.js', 'mx.js'].map((f) => path.join(dist, f)).join(':'),
      TCHAP_WEBRTC_E2E_BOOT: "mxHarness('webkit', window.__E2E_WS__)",
    } : {}),
  },
  stdio: ['ignore', 'inherit', 'pipe'],
});
app.stderr.on('data', (d) => { const s = String(d); if (!/libEGL|MESA|DRI3|dbus|D-Bus|EGL display|AT-SPI|GStreamer-CRITICAL|ALSA|pw\.conf|ALSOFT|^\s*$/i.test(s)) process.stderr.write('[app] ' + s); });

const RED = [255, 0, 0]; const BLUE = [0, 0, 255]; const GREEN = [0, 255, 0]; const YELLOW = [255, 255, 0];
const results = {};
let exitCode = 1;
try {
  const alice = await user('alice'); const bob = await user('bob');
  const t0 = Date.now();
  while (!(clients.webkit && clients.chromium)) {
    if (Date.now() - t0 > 60000) throw new Error('peers did not connect to the harness');
    await new Promise((r) => setTimeout(r, 100));
  }
  results.env = hello;
  // WebKit is alice (440 Hz, red camera, green screen); Chromium is bob (660 Hz, blue, yellow).
  const side = {
    webkit: { ...alice, baseUrl: hsUrl, freq: 440, marker: '#ff0000', screenMarker: '#00ff00' },
    chromium: { ...bob, baseUrl: hsUrl, freq: 660, marker: '#0000ff', screenMarker: '#ffff00' },
  };
  const expect = { webkit: { expectFreq: 660, expectMarker: BLUE, expectScreenMarker: YELLOW }, chromium: { expectFreq: 440, expectMarker: RED, expectScreenMarker: GREEN } };
  for (const [mode, caller, callee] of [['webkit-calls', 'webkit', 'chromium'], ['chromium-calls', 'chromium', 'webkit']]) {
    if (only && only !== mode) continue;
    // Fresh pages for every round: no clients, feeds or audio graphs left over.
    if (Object.keys(results).length > 1) {
      for (const n of (process.env.MX_RESET || 'webkit,chromium').split(',')) { const old = clients[n]; delete clients[n]; old.send(JSON.stringify({ t: 'reset' })); }
      const t1 = Date.now();
      while (!(clients.webkit && clients.chromium)) {
        if (Date.now() - t1 > 60000) throw new Error('pages did not come back after reset');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const room = await api('POST', '/_matrix/client/v3/createRoom', { preset: 'private_chat', is_direct: true, invite: [side[callee].userId] }, side[caller].accessToken);
    await api('POST', `/_matrix/client/v3/join/${encodeURIComponent(room.room_id)}`, {}, side[callee].accessToken);
    console.error(`[harness] ${mode} in ${room.room_id}`);
    // The callee syncs and listens first; the caller dials a few seconds later.
    const [b, a] = await Promise.all([
      run(callee, { ...side[callee], ...expect[callee], roomId: room.room_id, role: 'callee' }),
      new Promise((r) => setTimeout(r, 4000)).then(() => run(caller, { ...side[caller], ...expect[caller], roomId: room.room_id, role: 'caller' })),
    ]);
    results[mode] = { caller: { name: caller, ...a }, callee: { name: callee, ...b } };
  }
  results.summary = Object.fromEntries(['webkit-calls', 'chromium-calls'].filter((m) => results[m]).map((m) => [m, !!(results[m].caller.ok && results[m].callee.ok)]));
  exitCode = Object.values(results.summary).every(Boolean) ? 0 : 1;
} catch (e) {
  results.error = String(e.stack || e.message || e);
  results.homeserverLog = hsErr.slice(-2000);
} finally {
  console.log(JSON.stringify(results, null, 2));
  if (process.env.RESULT_FILE) writeFileSync(process.env.RESULT_FILE, JSON.stringify(results, null, 2));
  killGroup(app); hs.kill('SIGTERM');
  await browser.close(); wss.close(); http.close();
  setTimeout(() => process.exit(exitCode), 500);
}
