// Shared e2e scenarios. Runs unchanged in WebKitGTK (through the shim) and in
// Chromium (native WebRTC). Uses only standard WebRTC APIs.

function describeEnv() {
  const shim = window.RTCPeerConnection && RTCPeerConnection.__tauriShim;
  // Under a CSP without blob: scripts the shim withdraws RTCRtpScriptTransform.
  return { shim: shim || null, ua: navigator.userAgent, scriptTransform: typeof window.RTCRtpScriptTransform };
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

let __log = () => {};
function plog(...a) { try { __log(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); } catch {} }

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
    if (m.kind === 'done') plog('mediaAnswer: done');
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
  __log = (msg) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'log', name, msg }));
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
      else if (m.what === 'mediaOffer') result = await roleMediaOffer(sig);
      else if (m.what === 'mediaAnswer') result = await roleMediaAnswer(sig);
      else if (m.what === 'audio') result = await roleAudio(sig, m.opts);
      else if (m.what === 'dtmf') result = await roleDtmf(sig, m.opts);
    } catch (err) {
      result = { ok: false, error: `${err && err.name}: ${err && err.message}` };
    }
    log(JSON.stringify(result));
    ws.send(JSON.stringify({ t: 'result', name, what: m.what, result }));
  };
  return ws;
}

// ------------------------------------------------------------------ media
function canvasTrack(label) {
  const c = document.createElement('canvas'); c.width = 320; c.height = 240;
  const x = c.getContext('2d'); let i = 0;
  const iv = setInterval(() => {
    x.fillStyle = `hsl(${(i * 7) % 360},70%,45%)`; x.fillRect(0, 0, 320, 240);
    x.fillStyle = '#fff'; x.font = '28px sans-serif'; x.fillText(`${label} ${i++}`, 20, 130);
  }, 33);
  const stream = c.captureStream(30);
  return { stream, track: stream.getVideoTracks()[0], stop: () => clearInterval(iv) };
}

async function watchRemote(track) {
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true;
  Object.assign(v.style, { width: '160px', height: '120px' }); document.body.appendChild(v);
  v.srcObject = new MediaStream([track]);
  v.play().catch(() => {});
  for (let k = 0; k < 100 && !v.videoWidth; k++) await new Promise((r) => setTimeout(r, 100));
  return `${v.videoWidth}x${v.videoHeight}`;
}

async function inboundVideo(pc) {
  let r = null;
  (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') r = { framesDecoded: s.framesDecoded || 0, frameWidth: s.frameWidth, keyFramesDecoded: s.keyFramesDecoded }; });
  return r;
}

async function roleMediaOffer(sig) {
  const pc = new RTCPeerConnection();
  const flush = wirePeer(pc, sig);
  const peerReport = new Promise((res) => sig.on((m) => { if (m.kind === 'report') res(m); }));
  const src = canvasTrack('offer');
  const nnEvents = [];
  pc.onnegotiationneeded = () => nnEvents.push(pc.signalingState);
  const sender = pc.addTrack(src.track, src.stream);
  const txOk = pc.getTransceivers().some((t) => t.sender === sender);
  const gotTrack = new Promise((res) => (pc.ontrack = (e) => res({ streamId: e.streams[0] && e.streams[0].id, kind: e.track.kind, track: e.track, stream: e.streams[0] })));
  let remoteStreamId = null;
  const answered = new Promise((res) => sig.on(async (m) => {
    if (m.kind === 'sdp' && m.desc.type === 'answer' && !m.round) { remoteStreamId = m.streamId; await pc.setRemoteDescription(m.desc); await flush(); res(); }
  }));
  plog('mediaOffer: creating offer');
  await pc.setLocalDescription(await pc.createOffer());
  plog('mediaOffer: offer set', pc.signalingState);
  sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription, streamId: src.stream.id });
  await answered;
  plog('mediaOffer: answered', pc.signalingState, pc.getTransceivers().map((t) => [t.mid, t.currentDirection]));
  const t = await Promise.race([gotTrack, new Promise((r) => setTimeout(() => r(null), 8000))]);
  plog('mediaOffer: track', !!t, pc.connectionState);
  const tw = performance.now(); const rendered = t ? await watchRemote(t.track) : null; plog('watchRemote ms', Math.round(performance.now() - tw));
  plog('mediaOffer: rendered', rendered);
  await new Promise((r) => setTimeout(r, 3000));
  const inbound = await inboundVideo(pc);
  const tx = pc.getTransceivers()[0];
  { const t0 = performance.now(); const st = await pc.getStats(); let out = null; st.forEach((x) => { if (x.type === 'outbound-rtp') out = x; }); plog('mediaOffer: inbound', inbound, 'outbound', out, 'getStats ms', Math.round(performance.now() - t0)); }
  const state1 = { mid: tx.mid, currentDirection: tx.currentDirection, direction: tx.direction };

  // Renegotiate: remove our track; the remote must see removetrack.
  const reneg = new Promise((res) => sig.on(async (m) => {
    if (m.kind === 'sdp' && m.desc.type === 'answer' && m.round === 2) { plog('mediaOffer: round2 answer received'); try { await pc.setRemoteDescription(m.desc); plog('mediaOffer: round2 answer applied'); } catch (e) { plog('mediaOffer: round2 apply failed', e.name, e.message); } res(); }
  }));
  const nnBefore = nnEvents.length;
  pc.removeTrack(sender);
  await new Promise((r) => setTimeout(r, 100));
  const nnFired = nnEvents.length > nnBefore;
  await pc.setLocalDescription(await pc.createOffer());
  sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription, round: 2 });
  plog('mediaOffer: round2 offer sent', nnFired);
  await reneg;
  plog('mediaOffer: round2 answered', tx.currentDirection);
  const state2 = { currentDirection: tx.currentDirection, direction: tx.direction };
  const peerSaw = await Promise.race([peerReport, new Promise((r) => setTimeout(() => r({ removed: 'no report' }), 5000))]);
  src.stop(); sig.send({ kind: 'done' });
  pc.close();
  const ok = txOk && !!t && t.kind === 'video' && t.streamId === remoteStreamId && !!inbound && inbound.framesDecoded > 10
    && rendered && rendered !== '0x0' && state1.currentDirection === 'sendrecv' && nnFired && state2.currentDirection === 'recvonly'
    && peerSaw.removed === true;
  return { ok, txOk, ontrackStreamMatches: t && t.streamId === remoteStreamId, rendered, inbound, state1, state2, nnFired, peerSaw };
}

async function roleMediaAnswer(sig) {
  const pc = new RTCPeerConnection();
  const flush = wirePeer(pc, sig);
  const src = canvasTrack('answer');
  let remoteStreamId = null; let removed = false; let trackInfo = null; let measured = {};
  pc.ontrack = (e) => {
    const s = e.streams[0];
    trackInfo = { kind: e.track.kind, streamId: s && s.id, track: e.track, render: watchRemote(e.track) };
    if (s) s.addEventListener('removetrack', () => { removed = s.getTracks().length === 0; });
  };
  const done = new Promise((res) => sig.on(async (m) => {
    if (m.kind === 'sdp' && m.desc.type === 'offer' && !m.round) {
      remoteStreamId = m.streamId;
      plog('mediaAnswer: got offer');
      await pc.setRemoteDescription(m.desc);
      plog('mediaAnswer: remote set', pc.getTransceivers().length);         // matrix-js-sdk inbound flow:
      pc.addTrack(src.track, src.stream);            // tracks added after the offer
      await pc.setLocalDescription(await pc.createAnswer());
      plog('mediaAnswer: answer set', pc.signalingState);
      sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription, streamId: src.stream.id });
      await flush();
    } else if (m.kind === 'sdp' && m.round === 2) {
      measured = { rendered: trackInfo ? await trackInfo.render : null, inbound: await inboundVideo(pc) };
      plog('mediaAnswer: round2 offer');
      const wd = setTimeout(() => plog('mediaAnswer: round2 setRemote still pending', pc.signalingState, JSON.stringify(m.desc.sdp)), 3000);
      try { await pc.setRemoteDescription(m.desc); clearTimeout(wd); plog('mediaAnswer: round2 remote set'); } catch (e) { clearTimeout(wd); plog('mediaAnswer: round2 setRemote failed', e.name + ': ' + e.message); plog(m.desc.sdp); throw e; }
      try { const a = await pc.createAnswer(); plog('mediaAnswer: round2 answer created'); await pc.setLocalDescription(a); plog('mediaAnswer: round2 answer set', pc.signalingState); } catch (e) { plog('mediaAnswer: round2 answer failed', e.name + ': ' + e.message); throw e; }
      sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription, round: 2 });
      await new Promise((r) => setTimeout(r, 300));
      sig.send({ kind: 'report', removed });
    } else if (m.kind === 'done') res();
  }));
  await done;
  src.stop(); pc.close();
  const { rendered, inbound } = measured;
  return { ok: !!trackInfo && trackInfo.streamId === remoteStreamId && removed && rendered && rendered !== '0x0' && inbound && inbound.framesDecoded > 10, ontrackStreamMatches: trackInfo && trackInfo.streamId === remoteStreamId, removed, inbound, rendered };
}

// ------------------------------------------------------------------ audio
function toneTrack(freq) {
  const ac = new AudioContext({ sampleRate: 48000 });
  const osc = ac.createOscillator(); osc.frequency.value = freq;
  const gain = ac.createGain(); gain.gain.value = 0.3;
  const dest = ac.createMediaStreamDestination();
  osc.connect(gain).connect(dest); osc.start(); ac.resume().catch(() => {});
  return { stream: dest.stream, track: dest.stream.getAudioTracks()[0], stop: () => { osc.stop(); ac.close(); } };
}

async function analyse(stream, ms = 2500) {
  // Chrome only feeds remote WebRTC audio into WebAudio while a media element plays it.
  const el = new Audio(); el.muted = true; el.srcObject = stream; el.play().catch(() => {});
  const ac = new AudioContext({ sampleRate: 48000 });
  await ac.resume().catch(() => {});
  const src = ac.createMediaStreamSource(stream);
  const an = ac.createAnalyser(); an.fftSize = 8192; src.connect(an);
  const bins = new Float32Array(an.frequencyBinCount); const td = new Float32Array(an.fftSize);
  const peaks = []; let rmsMax = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    an.getFloatFrequencyData(bins); an.getFloatTimeDomainData(td);
    let bi = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[bi]) bi = i;
    const rms = Math.sqrt(td.reduce((a, v) => a + v * v, 0) / td.length);
    rmsMax = Math.max(rmsMax, rms);
    if (rms > 0.01) peaks.push(Math.round((bi * ac.sampleRate) / an.fftSize));
  }
  ac.close(); el.srcObject = null;
  peaks.sort((a, b) => a - b);
  return { peakHz: peaks.length ? peaks[Math.floor(peaks.length / 2)] : null, rmsMax: +rmsMax.toFixed(3), state: ac.state, samples: peaks.length };
}

async function roleAudio(sig, opts) {
  const { offer, freq, expect } = opts;
  const pc = new RTCPeerConnection();
  const flush = wirePeer(pc, sig);
  const src = toneTrack(freq);
  let remote = null;
  pc.ontrack = (e) => { remote = e.streams[0] || new MediaStream([e.track]); };
  const finished = new Promise((res) => sig.on((m) => { if (m.kind === 'done') res(); }));
  if (offer) {
    pc.addTrack(src.track, src.stream);
    const answered = new Promise((res) => sig.on(async (m) => { if (m.kind === 'sdp' && m.desc.type === 'answer') { await pc.setRemoteDescription(m.desc); await flush(); res(); } }));
    await pc.setLocalDescription(await pc.createOffer());
    sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
    await answered;
  } else {
    await new Promise((res) => sig.on(async (m) => {
      if (m.kind === 'sdp' && m.desc.type === 'offer') {
        await pc.setRemoteDescription(m.desc);
        pc.addTrack(src.track, src.stream);
        await pc.setLocalDescription(await pc.createAnswer());
        sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
        await flush(); res();
      }
    }));
  }
  for (let k = 0; k < 50 && (!remote || pc.connectionState !== 'connected'); k++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1500));
  const heard = remote ? await analyse(remote) : null;
  let stats = {};
  (await pc.getStats()).forEach((s) => { if ((s.type === 'inbound-rtp' || s.type === 'engine-audio-in') && (s.kind === 'audio' || s.type === 'engine-audio-in')) Object.assign(stats, s); });
  plog('audio inbound stats', JSON.stringify({ audioLevel: stats.audioLevel, totalAudioEnergy: stats.totalAudioEnergy, concealedSamples: stats.concealedSamples, totalSamplesReceived: stats.totalSamplesReceived, packetsLost: stats.packetsLost, jitter: stats.jitter, decoder: stats.decoderImplementation }));
  if (offer) sig.send({ kind: 'done' }); else await finished;
  if (offer) await new Promise((r) => setTimeout(r, 300));
  src.stop(); pc.close();
  const ok = !!heard && heard.peakHz !== null && Math.abs(heard.peakHz - expect) < 25 && heard.rmsMax > 0.05;
  return { ok, heard, expect, connectionState: pc.connectionState, stats: { packetsReceived: stats.packetsReceived, concealedPackets: stats.concealedPackets, underruns: stats.underruns, jitterBufferFrames: stats.jitterBufferFrames, jitterTargetFrames: stats.jitterTargetFrames, audioPath: stats.audioPath } };
}

// ------------------------------------------------------------------ DTMF
// Both sides send tones on their audio sender. Each checks its own
// tonechange sequence; the shim side also checks the tones it received
// (engine-dtmf-in stats; browsers have no receive API).
async function roleDtmf(sig, opts) {
  const { offer, tones, expect } = opts;
  const pc = new RTCPeerConnection();
  const flush = wirePeer(pc, sig);
  const src = toneTrack(offer ? 440 : 660);
  const finished = new Promise((res) => sig.on((m) => { if (m.kind === 'done') res(); }));
  const sender = pc.addTrack(src.track, src.stream);
  const out = { before: sender.dtmf.canInsertDTMF };
  if (offer) {
    const answered = new Promise((res) => sig.on(async (m) => { if (m.kind === 'sdp' && m.desc.type === 'answer') { await pc.setRemoteDescription(m.desc); await flush(); res(); } }));
    await pc.setLocalDescription(await pc.createOffer());
    sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
    await answered;
  } else {
    await new Promise((res) => sig.on(async (m) => {
      if (m.kind === 'sdp' && m.desc.type === 'offer') {
        await pc.setRemoteDescription(m.desc);
        await pc.setLocalDescription(await pc.createAnswer());
        sig.send({ kind: 'sdp', desc: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
        await flush(); res();
      }
    }));
  }
  for (let k = 0; k < 50 && pc.connectionState !== 'connected'; k++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 800));
  out.canInsert = sender.dtmf.canInsertDTMF;
  try { sender.dtmf.insertDTMF('12x'); out.badTone = 'accepted'; } catch (e) { out.badTone = e.name; }
  const changes = []; const t0 = performance.now();
  const ended = new Promise((res) => { sender.dtmf.ontonechange = (e) => { changes.push([e.tone, Math.round(performance.now() - t0)]); if (e.tone === '') res(); }; });
  sender.dtmf.insertDTMF(tones, 120, 80);
  out.toneBuffer = sender.dtmf.toneBuffer;
  await Promise.race([ended, new Promise((r) => setTimeout(r, 15000))]);
  out.toneChanges = changes;
  await new Promise((r) => setTimeout(r, 1500));
  if (RTCPeerConnection.__tauriShim) {
    (await pc.getStats()).forEach((s) => { if (s.type === 'engine-dtmf-in') out.received = s.tones; });
  }
  if (offer) sig.send({ kind: 'done' }); else await finished;
  if (offer) await new Promise((r) => setTimeout(r, 300));
  src.stop(); pc.close();
  const sentOk = changes.map((c) => c[0]).join('|') === [...tones.toUpperCase(), ''].join('|');
  out.ok = !out.before && out.canInsert && out.badTone === 'InvalidCharacterError' && sentOk
    && (!RTCPeerConnection.__tauriShim || out.received === expect);
  return out;
}
