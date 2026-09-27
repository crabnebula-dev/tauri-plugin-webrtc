// H.264 end to end between two app instances (WebKitGTK + shim on both
// sides): each allows only H.264 on its transceiver, sends a canvas track,
// and must decode the other's H.264. Needs an H.264 WebCodecs encoder in
// GStreamer (openh264, x264 or hardware).
//
// The bundled Playwright Chromium has no H.264 (no proprietary codecs), so
// interop with a browser needs Google Chrome: run shim-e2e.mjs with
// CHROMIUM=/path/to/google-chrome, which includes the same H.264 scenario.
// Usage: node h264-e2e.mjs [--app path/to/e2e-app]
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Linux runs the app under xvfb-run; other platforms launch it directly.
const headless = (bin) => (process.platform === 'linux' ? ['xvfb-run', ['-a', bin]] : [bin, []]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const appBin = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : path.join(root, 'target/debug/e2e-app');

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => wss.on('listening', r));
const url = `ws://127.0.0.1:${wss.address().port}`;
const clients = {}; const hello = {}; const waiters = [];
wss.on('connection', (ws) => ws.on('message', (d) => {
  // Signals go to the other instance (they carry no sender name).
  const m = JSON.parse(d);
  if (m.t === 'hello') { clients[m.name] = ws; hello[m.name] = m.env; }
  else if (m.t === 'signal') { for (const c of Object.values(clients)) if (c !== ws) c.send(JSON.stringify(m)); }
  else if (m.t === 'log') console.error(`[${m.name}] ${m.msg}`);
  else if (m.t === 'result') waiters.filter((w) => w.name === m.name).forEach((w) => w.resolve(m.result));
}));
const run = (name, what, opts, ms = 60000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, error: `timeout ${ms}ms` }), ms);
  const w = { name, resolve: (r) => { clearTimeout(timer); waiters.splice(waiters.indexOf(w), 1); resolve(r); } };
  waiters.push(w);
  clients[name].send(JSON.stringify({ t: 'run', what, opts }));
});

const apps = ['a', 'b'].map((n) => spawn(...headless(appBin), {
  detached: true,
  env: { ...process.env, E2E_WS: url, E2E_NAME: `webkit-${n}`, RUST_LOG: process.env.RUST_LOG || 'warn' },
  stdio: 'ignore',
}));
const results = {};
let code = 1;
try {
  const t0 = Date.now();
  while (!(clients['webkit-a'] && clients['webkit-b'])) {
    if (Date.now() - t0 > 60000) throw new Error('apps did not connect');
    await new Promise((r) => setTimeout(r, 100));
  }
  results.env = hello;
  let answer = run('webkit-b', 'h264', { offer: false });
  results.aOffers = await run('webkit-a', 'h264', { offer: true });
  results.aOffersBSide = await answer;
  answer = run('webkit-a', 'h264', { offer: false });
  results.bOffers = await run('webkit-b', 'h264', { offer: true });
  results.bOffersASide = await answer;
  results.summary = { aOffers: results.aOffers.ok && results.aOffersBSide.ok, bOffers: results.bOffers.ok && results.bOffersASide.ok };
  code = Object.values(results.summary).every(Boolean) ? 0 : 1;
} catch (e) {
  results.error = String(e.message || e);
} finally {
  console.log(JSON.stringify(results, null, 2));
  for (const a of apps) { try { process.kill(-a.pid, 'SIGTERM'); } catch {} }
  wss.close();
  setTimeout(() => process.exit(code), 300);
}
