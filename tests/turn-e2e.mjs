// TURN over UDP, TCP and TLS: the engine (stdio_peer) gathers relay-only
// candidates through a local coturn and opens a data channel with Chromium.
// Needs `turnserver` (coturn) and `openssl` on PATH; the stdio_peer example
// must be built (cargo build -p tauri-webrtc-engine --example stdio_peer).
// Usage: node turn-e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const here = path.dirname(fileURLToPath(import.meta.url));
const ip = process.env.TURN_IP || Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;
if (!ip) { console.error('no non-loopback IPv4 address; set TURN_IP'); process.exit(2); }
const dir = mkdtempSync(path.join(os.tmpdir(), 'turn-e2e-'));
const ossl = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'ignore' });

// A throwaway CA and a server certificate for the IP (no DNS needed).
ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=turn-e2e CA', '-keyout', 'ca.key', '-out', 'ca.pem');
ossl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=turn-e2e', '-keyout', 'srv.key', '-out', 'srv.csr');
writeFileSync(path.join(dir, 'ext.cnf'), `subjectAltName=IP:${ip}\nextendedKeyUsage=serverAuth\n`);
ossl('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext.cnf', '-out', 'srv.pem');

const port = 34780 + Math.floor(Math.random() * 100) * 2;
const tlsPort = port + 1;
writeFileSync(path.join(dir, 'turnserver.conf'), [
  `listening-ip=${ip}`, `relay-ip=${ip}`, `listening-port=${port}`, `tls-listening-port=${tlsPort}`,
  'fingerprint', 'lt-cred-mech', 'user=alice:secret', 'realm=turn-e2e', 'no-dtls', 'no-cli',
  `cert=${dir}/srv.pem`, `pkey=${dir}/srv.key`, 'min-port=51000', 'max-port=51999',
  `log-file=${dir}/turn.log`, 'simple-log', `userdb=${dir}/turndb`, `pidfile=${dir}/turn.pid`,
].join('\n'));
const turn = spawn('turnserver', ['-c', path.join(dir, 'turnserver.conf')], { stdio: 'ignore' });
const open = (p) => new Promise((res) => { const s = net.connect(p, ip, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
for (let i = 0; i < 50 && !(await open(tlsPort)); i++) await new Promise((r) => setTimeout(r, 100));

const cases = {
  udp: `turn:${ip}:${port}?transport=udp`,
  tcp: `turn:${ip}:${port}?transport=tcp`,
  tls: `turns:${ip}:${tlsPort}?transport=tcp`,
};
const results = {};
for (const [name, url] of Object.entries(cases)) {
  const cfg = JSON.stringify({ iceServers: [{ urls: [url], username: 'alice', credential: 'secret' }], iceTransportPolicy: 'relay' });
  const out = await new Promise((res) => {
    const c = spawn('node', [path.join(here, 'engine-chromium.mjs'), '--engine-config', cfg], {
      // Only the throwaway CA is trusted for this run.
      env: { ...process.env, SSL_CERT_FILE: path.join(dir, 'ca.pem'), RUST_LOG: 'tauri_webrtc_engine=debug' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let s = ''; c.stdout.on('data', (d) => { s += d; }); c.stderr.on('data', (d) => { s += d; });
    c.on('exit', () => res(s));
  });
  const relays = (out.match(/allocated relay/g) || []).length;
  const oks = (out.match(/"ok": true/g) || []).length;
  results[name] = { url, relays, channelsOpened: oks, ok: relays >= 2 && oks >= 2 };
  if (!results[name].ok) results[name].tail = out.split('\n').filter((l) => /WARN|ERROR|error/.test(l)).slice(-5);
}
turn.kill('SIGTERM');
results.summary = Object.fromEntries(Object.keys(cases).map((k) => [k, results[k].ok]));
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results.summary).every(Boolean) ? 0 : 1);
