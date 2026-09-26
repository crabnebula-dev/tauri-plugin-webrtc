// Shared e2e scenarios. Runs unchanged in WebKitGTK (through the shim) and in
// Chromium (native WebRTC). Uses only standard WebRTC APIs.

function describeEnv() {
  const shim = window.RTCPeerConnection && RTCPeerConnection.__tauriShim;
  return { shim: shim || null, ua: navigator.userAgent };
}

// Checks that only make sense against the shim: error mapping and states.
async function shimConformance() {
  const out = {};
  const pc = new RTCPeerConnection();
  out.initialStates = [pc.signalingState, pc.iceGatheringState, pc.connectionState].join('/');
  try { await pc.createAnswer(); out.createAnswerInStable = 'resolved'; } catch (e) { out.createAnswerInStable = e.name; }
  try { pc.addTrack({}); out.addTrack = 'ok'; } catch (e) { out.addTrack = e.name; }
  try { await pc.addIceCandidate({ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0' }); out.addIceNoRemote = 'resolved'; } catch (e) { out.addIceNoRemote = e.name; }
  try { await pc.setRemoteDescription({ type: 'offer', sdp: 'garbage' }); out.badSdp = 'resolved'; } catch (e) { out.badSdp = e.name; }
  out.badSdpState = pc.signalingState;
  const dc = pc.createDataChannel('x');
  out.dcInitial = dc.readyState;
  try { dc.send('too early'); out.sendBeforeOpen = 'ok'; } catch (e) { out.sendBeforeOpen = e.name; }
  const nn = await new Promise((r) => { pc.onnegotiationneeded = () => r(true); setTimeout(() => r(false), 3000); });
  out.negotiationNeeded = nn;
  const offer = await pc.createOffer();
  out.offerHasApplication = /m=application/.test(offer.sdp);
  await pc.setLocalDescription(offer);
  out.afterSetLocal = pc.signalingState;
  out.pendingLocalIsOffer = pc.pendingLocalDescription && pc.pendingLocalDescription.type === 'offer';
  pc.close();
  out.afterClose = [pc.signalingState, pc.connectionState, dc.readyState].join('/');
  try { pc.createDataChannel('y'); out.createAfterClose = 'ok'; } catch (e) { out.createAfterClose = e.name; }
  // The exact shape matrix-js-sdk MatrixCall.createPeerConnection() passes.
  try {
    const m = new window.RTCPeerConnection({
      iceTransportPolicy: undefined,
      iceServers: [{ urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:443?transport=tcp'], username: '1790000000:@u:example.org', credential: 'a/b+c=' }],
      iceCandidatePoolSize: 0,
      bundlePolicy: 'max-bundle',
    });
    m.createDataChannel('m');
    const o = await m.createOffer();
    await m.setLocalDescription(o);
    out.matrixConfig = m.signalingState === 'have-local-offer' ? 'ok' : m.signalingState;
    m.close();
  } catch (e) { out.matrixConfig = e.name + ': ' + e.message; }
  return out;
}

function makeSignal(ws) {
  const handlers = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'signal') handlers.forEach((h) => h(m.body));
  });
  return {
    send: (body) => ws.send(JSON.stringify({ t: 'signal', body })),
    on: (h) => handlers.push(h),
    reset: () => { handlers.length = 0; },
  };
}

function wirePeer(pc, sig) {
  const early = [];
  pc.onicecandidate = (e) => { if (e.candidate) sig.send({ kind: 'cand', c: e.candidate.toJSON() }); };
  sig.on(async (m) => {
    if (m.kind === 'cand') {
      if (pc.remoteDescription) await pc.addIceCandidate(m.c).catch((err) => console.error('addIce', err));
      else early.push(m.c);
    }
  });
  return async () => { for (const c of early.splice(0)) await pc.addIceCandidate(c).catch(() => {}); };
}

// Offerer: creates channels, runs the measurements, reports results.
async function roleOffer(sig, opts = {}) {
  const N = opts.n || 300; const SZ = opts.size || 16384;
  const pc = new RTCPeerConnection({ iceServers: [] });
  const states = [];
  pc.addEventListener('connectionstatechange', () => states.push(pc.connectionState));
  const flush = wirePeer(pc, sig);
  const dc = pc.createDataChannel('echo');
  dc.binaryType = 'arraybuffer';
  const lossy = pc.createDataChannel('lossy', { ordered: false, maxRetransmits: 0 });
  const answered = new Promise((res) => sig.on(async (m) => {
    if (m.kind === 'sdp') { await pc.setRemoteDescription(m.desc); await flush(); res(); }
  }));
  await pc.setLocalDescription(await pc.createOffer());
  sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
  await answered;
  await new Promise((r) => (dc.readyState === 'open' ? r() : (dc.onopen = r)));
  const lossyOpen = lossy.readyState === 'open' || await new Promise((r) => { lossy.onopen = () => r(true); setTimeout(() => r(false), 5000); });

  const next = () => new Promise((r) => (dc.onmessage = (e) => r(e.data)));
  dc.send('ping ü 🦀');
  const text = await next();
  const bin = new Uint8Array(1000).map((_, i) => i & 255);
  dc.send(bin);
  const back = new Uint8Array(await next());
  const binOk = back.length === bin.length && back.every((v, i) => v === bin[i]);

  // Ordered burst with sequence numbers: detects reordering and loss.
  const burst = 200; const seen = [];
  const burstDone = new Promise((r) => (dc.onmessage = (e) => { seen.push(Number(e.data)); if (seen.length === burst) r(); }));
  for (let i = 0; i < burst; i++) dc.send(String(i));
  await burstDone;
  const inOrder = seen.every((v, i) => v === i);

  let sent = 0, recvd = 0, sumOut = 0, sumIn = 0, maxBuffered = 0;
  const done = new Promise((r) => (dc.onmessage = (e) => {
    const a = new Uint8Array(e.data); sumIn = (sumIn + a[0] + a[SZ - 1]) >>> 0; if (++recvd === N) r();
  }));
  dc.bufferedAmountLowThreshold = 256 * 1024;
  const t = performance.now();
  while (sent < N) {
    maxBuffered = Math.max(maxBuffered, dc.bufferedAmount);
    if (dc.bufferedAmount > 1024 * 1024) { await new Promise((r) => (dc.onbufferedamountlow = r)); continue; }
    const a = new Uint8Array(SZ); a[0] = sent & 255; a[SZ - 1] = (sent * 7) & 255;
    sumOut = (sumOut + a[0] + a[SZ - 1]) >>> 0; dc.send(a); sent++;
  }
  await done;
  const secs = (performance.now() - t) / 1000;
  let pair = null; const statTypes = new Set();
  try { (await pc.getStats()).forEach((s) => { statTypes.add(s.type); if (s.type === 'candidate-pair' && (s.nominated || s.selected)) pair = pair || { state: s.state || null }; }); } catch (e) { pair = { error: e.name }; }
  sig.send({ kind: 'done' });
  const closed = new Promise((r) => { dc.onclose = () => r(true); setTimeout(() => r(false), 3000); });
  dc.close();
  const dcClosed = await closed;
  pc.close();
  return {
    ok: text === 'ping ü 🦀' && binOk && inOrder && sumIn === sumOut && lossyOpen,
    text, binOk, inOrder, lossyOpen, echoIntegrity: sumIn === sumOut, dcClosed,
    echoMbitPerSec: +((N * SZ * 2 * 8) / secs / 1e6).toFixed(1), maxBuffered,
    connectionStates: states.join('>'), statsPair: pair, statTypes: [...statTypes].sort().join(','),
  };
}

// Answerer: echoes every message on every channel until told it is done.
async function roleAnswer(sig) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const flush = wirePeer(pc, sig);
  const labels = []; let echoed = 0;
  pc.ondatachannel = (e) => {
    const ch = e.channel; ch.binaryType = 'arraybuffer'; labels.push(ch.label);
    ch.onmessage = (m) => { ch.send(m.data); echoed++; };
  };
  const finished = new Promise((res) => sig.on(async (m) => {
    if (m.kind === 'sdp') {
      await pc.setRemoteDescription(m.desc);
      await pc.setLocalDescription(await pc.createAnswer());
      sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
      await flush();
    } else if (m.kind === 'done') res();
  }));
  await finished;
  await new Promise((r) => setTimeout(r, 300));
  const result = { ok: labels.includes('echo') && echoed > 0, labels, echoed, finalState: pc.connectionState };
  pc.close();
  return result;
}

function connectHarness(name, url, log = console.log) {
  const ws = new WebSocket(url);
  const sig = makeSignal(ws);
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', name, env: describeEnv() })); log('connected'); };
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.t !== 'run') return;
    log('run ' + m.what);
    sig.reset();
    let result;
    try {
      if (m.what === 'conformance') result = await shimConformance();
      else if (m.what === 'offer') result = await roleOffer(sig, m.opts);
      else if (m.what === 'answer') result = await roleAnswer(sig);
    } catch (err) {
      result = { ok: false, error: `${err && err.name}: ${err && err.message}` };
    }
    log(JSON.stringify(result));
    ws.send(JSON.stringify({ t: 'result', name, what: m.what, result }));
  };
  return ws;
}
