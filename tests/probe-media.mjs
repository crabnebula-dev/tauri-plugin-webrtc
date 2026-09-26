import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => wss.on('listening', r));
const url = `ws://127.0.0.1:${wss.address().port}`;
const app = spawn('xvfb-run', ['-a', process.argv[2] || '../target/debug/e2e-app'], { env: { ...process.env, E2E_WS: url, E2E_PAGE: process.env.PAGE || 'probe-media.html' }, stdio: ['ignore', 'ignore', 'pipe'] });
let err = ''; app.stderr.on('data', (d) => (err += d));
const t = setTimeout(() => { console.log('timeout', err.slice(-1500)); app.kill(); process.exit(1); }, 150000);
wss.on('connection', (ws) => ws.on('message', (d) => { const m = JSON.parse(d); if (m.done) { clearTimeout(t); app.kill(); process.exit(0); } if (!m.step) return; console.log(m.step.padEnd(22), typeof m.value === 'string' ? m.value : JSON.stringify(m.value)); }));
