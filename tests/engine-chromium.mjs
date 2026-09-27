// Interop: the qrtc engine (its stdio_peer example) <-> headless Chromium.
// The binary is QRTC_STDIO_PEER, or target/debug/examples/stdio_peer in a qrtc
// checkout next to this repository (../qrtc).
// Usage: node engine-chromium.mjs [--mdns]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.QRTC_STDIO_PEER || path.join(root, '../qrtc/target/debug/examples/stdio_peer');
const mdns = process.argv.includes('--mdns');
const argVal = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const engineConfig = argVal('--engine-config');
const browserConfig = JSON.parse(argVal('--browser-config') || '{}');
const exe = process.env.CHROMIUM || undefined /* Playwright bundled Chromium */;

function startPeer(role) {
  const child = spawn(bin, [role], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...(engineConfig ? { WEBRTC_CONFIG: engineConfig } : {}) } });
  const listeners = new Set();
  const early = []; // lines printed before anyone listens (fast engines emit the offer at once)
  createInterface({ input: child.stdout }).on('line', (l) => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (!listeners.size) early.push(m);
    for (const f of listeners) f(m);
  });
  return {
    send: (m) => child.stdin.write(JSON.stringify(m) + '\n'),
    on: (f) => { listeners.add(f); early.splice(0).forEach(f); },
    stop: () => child.kill(),
  };
}

const args = ['--use-fake-ui-for-media-stream', ...(process.env.CHROMIUM_ARGS ? process.env.CHROMIUM_ARGS.split(' ') : [])];
if (!mdns) args.push('--disable-features=WebRtcHideLocalIpsWithMdns');
const browser = await chromium.launch({ executablePath: exe, args });
const results = {};

async function run(name, role, pageFn) {
  const peer = startPeer(role);
  const page = await browser.newPage();
  await page.addInitScript((c) => { window.__PC_CONFIG = c; }, browserConfig);
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}] console:`, m.text()); });
  let ready = false; const backlog = [];
  const deliver = (m) => page.evaluate((mm) => window.fromEngine && window.fromEngine(mm), m).catch(() => {});
  await page.exposeFunction('toEngine', (m) => { if (m.op === 'ready') { ready = true; backlog.splice(0).forEach(deliver); } else peer.send(m); });
  peer.on((m) => {
    if (m.op === 'event' && m.event.type === 'connectionstatechange') console.log(`[${name}] engine connectionState=${m.event.state}`);
    if (m.op === 'error' || m.op === 'fatal') console.log(`[${name}] engine`, m);
    if (ready) deliver(m); else backlog.push(m);
  });
  const t0 = Date.now();
  try {
    results[name] = await Promise.race([
      page.evaluate(pageFn),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30s')), 30000)),
    ]);
  } catch (e) {
    results[name] = { ok: false, error: String(e.message || e) };
  }
  results[name].ms = Date.now() - t0;
  peer.send({ op: 'close' });
  await page.close();
  peer.stop();
}

// Browser offers, engine answers and echoes.
await run('browser-offers', 'answerer', async () => {
  const pc = new RTCPeerConnection(window.__PC_CONFIG);
  const queue = [];
  window.fromEngine = async (m) => {
    if (m.op === 'answer') { await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); for (const c of queue.splice(0)) await pc.addIceCandidate(c); }
    else if (m.op === 'event' && m.event.type === 'icecandidate' && m.event.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(m.event.candidate); else queue.push(m.event.candidate);
    }
  };
  pc.onicecandidate = (e) => { if (e.candidate) toEngine({ op: 'candidate', candidate: e.candidate.toJSON() }); };
  toEngine({ op: 'ready' });
  const dc = pc.createDataChannel('echo');
  dc.binaryType = 'arraybuffer';
  const lossy = pc.createDataChannel('lossy', { ordered: false, maxRetransmits: 0 });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  toEngine({ op: 'offer', sdp: offer.sdp });
  await new Promise((r) => (dc.onopen = r));
  const lossyOpen = lossy.readyState === 'open' || await new Promise((r) => { lossy.onopen = () => r(true); setTimeout(() => r(false), 5000); });

  const next = () => new Promise((r) => (dc.onmessage = (e) => r(e.data)));
  dc.send('ping ü 🦀');
  const text = await next();
  const bin = new Uint8Array(1000).map((_, i) => i & 255);
  dc.send(bin);
  const back = new Uint8Array(await next());
  const binOk = back.length === bin.length && back.every((v, i) => v === bin[i]);

  // Throughput: N x 16 KiB, all echoed, integrity by rolling sum.
  const N = 400, SZ = 16384;
  let sent = 0, recvd = 0, sumOut = 0, sumIn = 0;
  const done = new Promise((r) => (dc.onmessage = (e) => { const a = new Uint8Array(e.data); sumIn = (sumIn + a[0] + a[SZ - 1]) >>> 0; if (++recvd === N) r(); }));
  dc.bufferedAmountLowThreshold = 256 * 1024;
  const t = performance.now();
  while (sent < N) {
    if (dc.bufferedAmount > 1024 * 1024) { await new Promise((r) => (dc.onbufferedamountlow = r)); continue; }
    const a = new Uint8Array(SZ); a[0] = sent & 255; a[SZ - 1] = (sent * 7) & 255;
    sumOut = (sumOut + a[0] + a[SZ - 1]) >>> 0; dc.send(a); sent++;
  }
  await done;
  const secs = (performance.now() - t) / 1000;
  const stats = [];
  (await pc.getStats()).forEach((s) => { if (s.type === 'candidate-pair' && s.nominated) stats.push({ state: s.state, rtt: s.currentRoundTripTime }); });
  const local = [];
  (await pc.getStats()).forEach((s) => { if (s.type === 'local-candidate' || s.type === 'remote-candidate') local.push(`${s.type}:${s.candidateType}:${s.address}`); });
  pc.close();
  return {
    ok: text === 'ping ü 🦀' && binOk && sumIn === sumOut,
    text, binOk, lossyOpen, echoIntegrity: sumIn === sumOut,
    echoMbitPerSec: +((N * SZ * 2 * 8) / secs / 1e6).toFixed(1),
    pair: stats, candidates: local,
  };
});

// Engine offers with its own channel; browser answers.
await run('engine-offers', 'offerer', async () => {
  const pc = new RTCPeerConnection(window.__PC_CONFIG);
  const queue = [];
  pc.onicecandidate = (e) => { if (e.candidate) toEngine({ op: 'candidate', candidate: e.candidate.toJSON() }); };
  const got = new Promise((resolve) => {
    pc.ondatachannel = (e) => {
      const ch = e.channel; const msgs = [];
      ch.onmessage = (m) => { msgs.push(m.data); if (msgs.length === 1) ch.send('ack'); if (msgs.length === 2) resolve({ label: ch.label, msgs }); };
    };
  });
  window.fromEngine = async (m) => {
    if (m.op === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      const a = await pc.createAnswer(); await pc.setLocalDescription(a);
      toEngine({ op: 'answer', sdp: a.sdp });
      for (const c of queue.splice(0)) await pc.addIceCandidate(c);
    } else if (m.op === 'event' && m.event.type === 'icecandidate' && m.event.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(m.event.candidate); else queue.push(m.event.candidate);
    }
  };
  toEngine({ op: 'ready' });
  const r = await got;
  pc.close();
  return { ok: r.label === 'engine' && r.msgs[0] === 'hello from engine' && r.msgs[1] === 'ack', ...r };
});

await browser.close();
console.log(JSON.stringify({ mdns, engineConfig, browserConfig, results }, null, 2));
process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1);
