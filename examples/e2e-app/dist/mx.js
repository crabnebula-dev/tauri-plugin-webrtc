// Matrix 1:1 VoIP scenario with the real matrix-js-sdk (Tchap's call stack for
// 1:1 calls). Runs unchanged in WebKitGTK through the shim and in Chromium.
// Needs mx/matrix.js, built by tests/matrix/build.mjs.

let mxLog = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fake devices
// Test machines have no camera or microphone. The SDK asks enumerateDevices
// before getUserMedia, so both are replaced with synthetic sources.
function fakeDevices({ freq, marker, screenMarker }) {
  const ac = new AudioContext({ sampleRate: 48000 });
  const canvasTrack = (color, w, h, label) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); let i = 0;
    setInterval(() => {
      x.fillStyle = `hsl(${(i * 7) % 360},60%,40%)`; x.fillRect(0, 0, w, h);
      x.fillStyle = color; x.fillRect(0, 0, w / 4, h / 3);
      x.fillStyle = '#fff'; x.font = '32px sans-serif'; x.fillText(`${label} ${i++}`, w / 3, h / 2);
    }, 33);
    return c.captureStream(30).getVideoTracks()[0];
  };
  const tone = () => {
    const osc = ac.createOscillator(); osc.frequency.value = freq;
    const g = ac.createGain(); g.gain.value = 0.3;
    const d = ac.createMediaStreamDestination(); osc.connect(g).connect(d); osc.start(); ac.resume().catch(() => {});
    return d.stream.getAudioTracks()[0];
  };
  const md = navigator.mediaDevices;
  // Define on the prototype and the instance: plain assignment does not stick
  // for every method in WebKitGTK.
  const def = (name, fn) => {
    for (const target of [Object.getPrototypeOf(md), md]) {
      try { Object.defineProperty(target, name, { value: fn, writable: true, configurable: true }); } catch {}
    }
  };
  def('enumerateDevices', async () => [
    { kind: 'audioinput', deviceId: 'fake-mic', groupId: 'fake', label: 'Fake microphone', toJSON() { return this; } },
    { kind: 'videoinput', deviceId: 'fake-cam', groupId: 'fake', label: 'Fake camera', toJSON() { return this; } },
  ]);
  def('getUserMedia', async (c = {}) => {
    const tracks = [];
    if (c.audio) tracks.push(tone());
    if (c.video) tracks.push(canvasTrack(marker, 640, 360, 'cam'));
    return new MediaStream(tracks);
  });
  def('getDisplayMedia', async () => {
    const t = canvasTrack(screenMarker, 1280, 720, 'screen');
    try { t.contentHint = 'detail'; } catch {}
    return new MediaStream([t]);
  });
}

// ------------------------------------------------------------ measurements
async function mxAnalyse(stream, ms = 2500) {
  const a = stream.getAudioTracks()[0];
  if (!a) return { peakHz: null, rmsMax: 0, note: 'no audio track' };
  const s = new MediaStream([a]);
  const el = new Audio(); el.muted = true; el.srcObject = s; el.play().catch(() => {});
  const ac = new AudioContext({ sampleRate: 48000 }); await ac.resume().catch(() => {});
  const an = ac.createAnalyser(); an.fftSize = 8192; ac.createMediaStreamSource(s).connect(an);
  const bins = new Float32Array(an.frequencyBinCount); const td = new Float32Array(an.fftSize);
  const peaks = []; let rmsMax = 0; const end = performance.now() + ms;
  while (performance.now() < end) {
    await sleep(200);
    an.getFloatFrequencyData(bins); an.getFloatTimeDomainData(td);
    let bi = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[bi]) bi = i;
    const rms = Math.sqrt(td.reduce((q, v) => q + v * v, 0) / td.length); rmsMax = Math.max(rmsMax, rms);
    if (rms > 0.005) peaks.push(Math.round((bi * ac.sampleRate) / an.fftSize));
  }
  ac.close(); el.srcObject = null; peaks.sort((x, y) => x - y);
  return { peakHz: peaks.length ? peaks[Math.floor(peaks.length / 2)] : null, rmsMax: +rmsMax.toFixed(3) };
}

async function mxWatch(stream, ms = 2500) {
  const t = stream.getVideoTracks()[0];
  if (!t) return { width: 0, fps: 0, marker: [0, 0, 0], note: 'no video track' };
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true; v.style.width = '160px';
  document.body.appendChild(v); v.srcObject = new MediaStream([t]);
  await Promise.race([v.play().catch(() => {}), sleep(2000)]);
  // A large first keyframe (screen share) can take a few seconds at the initial bandwidth estimate.
  for (let i = 0; i < 80 && !v.videoWidth; i++) await new Promise((r) => setTimeout(r, 100));
  let frames = 0; const t0 = performance.now();
  const tick = () => { frames++; if (performance.now() - t0 < ms) v.requestVideoFrameCallback(tick); };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
  await sleep(ms);
  const c = document.createElement('canvas'); c.width = v.videoWidth || 2; c.height = v.videoHeight || 2;
  const x = c.getContext('2d'); x.drawImage(v, 0, 0);
  const bw = Math.max(1, Math.floor(c.width / 8)); const bh = Math.max(1, Math.floor(c.height / 6));
  const px = x.getImageData(Math.floor(bw / 2), Math.floor(bh / 2), bw, bh).data;
  let r = 0, g = 0, b = 0; for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
  const n = px.length / 4;
  const out = { width: v.videoWidth, height: v.videoHeight, fps: +((frames * 1000) / ms).toFixed(1), marker: [r / n, g / n, b / n].map(Math.round) };
  v.srcObject = null; v.remove();
  return out;
}
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 70;

// ------------------------------------------------------------------ roles
async function mxClient(o) {
  const { sdk } = window.MX;
  const client = sdk.createClient({ baseUrl: o.baseUrl, accessToken: o.accessToken, userId: o.userId, deviceId: o.deviceId });
  const ready = new Promise((res) => client.on(sdk.ClientEvent.Sync, (state) => { if (state === 'PREPARED') res(); }));
  await client.startClient({ initialSyncLimit: 1 });
  await ready;
  return client;
}

function waitFeeds(call, pred, ms, what) {
  return new Promise((res, rej) => {
    const check = () => { const f = call.getRemoteFeeds(); if (pred(f)) { cleanup(); res(f); } };
    const timer = setTimeout(() => { cleanup(); rej(new Error(`timeout: ${what}`)); }, ms);
    const cleanup = () => { clearTimeout(timer); call.off(window.MX.CallEvent.FeedsChanged, check); };
    call.on(window.MX.CallEvent.FeedsChanged, check); check();
  });
}

const mxClients = [];
async function roleMatrixCall(o) {
  const { sdk, CallEvent, CallState, CallErrorCode, CallEventHandlerEvent } = window.MX;
  fakeDevices(o);
  const out = { role: o.role, supportsVoip: null, states: [] };
  const client = await mxClient(o);
  mxClients.push(client);
  const t0 = performance.now();
  out.supportsVoip = client.supportsVoip();
  let call;
  if (o.role === 'caller') {
    call = sdk.createNewMatrixCall(client, o.roomId);
    call.on(CallEvent.State, (s) => { out.states.push(s); mxLog(`state ${s}`); });
    call.on(CallEvent.Error, (e) => { out.error = `${e.code}: ${e.message}`; mxLog(`call error ${out.error} ${e.err && (e.err.stack || e.err.message || e.err)}`); });
    await call.placeVideoCall();
  } else {
    call = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no incoming call')), 30000);
      client.on(CallEventHandlerEvent.Incoming, (c) => { clearTimeout(t); res(c); });
    });
    call.on(CallEvent.State, (s) => { out.states.push(s); mxLog(`state ${s}`); });
    call.on(CallEvent.Error, (e) => { out.error = `${e.code}: ${e.message}`; mxLog(`call error ${out.error} ${e.err && (e.err.stack || e.err.message || e.err)}`); });
    await call.answer(true, true);
  }
  const hungUp = new Promise((res) => call.on(CallEvent.Hangup, () => res(true)));
  // Both directions: the peer's usermedia feed carries its tone and camera.
  const feeds = await waitFeeds(call, (f) => f.some((x) => x.purpose === 'm.usermedia' && x.stream.getTracks().length >= 2), 30000, 'remote usermedia feed');
  const um = feeds.find((x) => x.purpose === 'm.usermedia');
  await sleep(1500);
  const [heard, seen] = await Promise.all([mxAnalyse(um.stream), mxWatch(um.stream)]);
  out.usermedia = { heard, seen, streamIdFromMetadata: !!um.stream.id };
  out.audioSenders = [];
  try { (await call.peerConn.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'audio') out.audioSenders.push({ mid: r.mid, framesSent: r.framesSent, packetsSent: r.packetsSent }); }); } catch {}
  out.videoIn = [];
  try { (await call.peerConn.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') out.videoIn.push({ mid: r.mid, framesReceived: r.framesReceived, framesDecoded: r.framesDecoded, keyFramesDecoded: r.keyFramesDecoded, frameWidth: r.frameWidth, pliCount: r.pliCount }); }); } catch {}
  out.audioTransceivers = call.peerConn.getTransceivers().filter((t) => t.sender.track && t.sender.track.kind === 'audio').length;
  out.elapsedMs = Math.round(performance.now() - t0);
  out.audioOk = !!heard.peakHz && Math.abs(heard.peakHz - o.expectFreq) < 25 && heard.rmsMax > 0.1; // synthetic tracks get no capture processing
  out.videoOk = seen.width > 0 && seen.fps > 5 && near(seen.marker, o.expectMarker);
  // Caller starts screen sharing: a renegotiation adding a second video
  // transceiver, announced through sdp_stream_metadata.
  if (o.role === 'caller') {
    await sleep(500);
    out.screenshareStarted = await call.setScreensharingEnabled(true);
    mxLog(`screenshare started ${out.screenshareStarted}`);
    await o.sig('screen-on');
    await o.sig('screen-seen');
    out.outbound = [];
    try { (await call.peerConn.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') out.outbound.push({ mid: r.mid, framesEncoded: r.framesEncoded, keyFramesEncoded: r.keyFramesEncoded, framesSent: r.framesSent, frameWidth: r.frameWidth, framesDropped: r.framesDropped, targetBitrate: r.targetBitrate }); }); } catch (e) { out.outbound = String(e); }
    await call.setScreensharingEnabled(false);
    await o.sig('screen-off');
    await sleep(1500);
    call.hangup(CallErrorCode.UserHangup, false);
  } else {
    await o.sig('screen-on');
    const sf = await waitFeeds(call, (f) => f.some((x) => x.purpose === 'm.screenshare'), 20000, 'remote screenshare feed');
    await sleep(1500);
    out.screen = await mxWatch(sf.find((x) => x.purpose === 'm.screenshare').stream);
    out.screenOk = out.screen.width >= 640 && near(out.screen.marker, o.expectScreenMarker);
    await o.sig('screen-seen');
    await o.sig('screen-off');
    const gone = await waitFeeds(call, (f) => !f.some((x) => x.purpose === 'm.screenshare'), 20000, 'screenshare feed removed').then(() => true, () => false);
    out.screenRemoved = gone;
  }
  out.hungUp = await Promise.race([hungUp, sleep(15000).then(() => false)]);
  out.finalState = call.state;
  client.stopClient();
  out.ok = out.audioOk && out.videoOk && out.hungUp && out.states.includes(CallState.Connected)
    && (o.role === 'caller' ? out.screenshareStarted === true : out.screenOk && out.screenRemoved);
  return out;
}

// Surface negotiation errors with their DOMException name and message.
function traceNegotiation() {
  const P = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
  if (!P || P.__traced) return; P.__traced = true;
  for (const m of ['setLocalDescription', 'setRemoteDescription', 'createOffer', 'createAnswer']) {
    const orig = P[m];
    P[m] = async function (...a) {
      try { return await orig.apply(this, a); } catch (e) {
        mxLog(`${m} failed: ${e && e.name}: ${e && e.message}${a[0] && a[0].sdp ? '\n' + a[0].sdp : ''}`);
        throw e;
      }
    };
  }
}

function mxHarness(name, wsUrl, log = console.log) {
  traceNegotiation();
  const ws = new WebSocket(wsUrl);
  mxLog = (msg) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'log', name, msg }));
  const barriers = {};
  ws.onopen = () => {
    const shim = window.RTCPeerConnection && RTCPeerConnection.prototype.__tauriShim;
    ws.send(JSON.stringify({ t: 'hello', name, env: { shim: shim || null, ua: navigator.userAgent } }));
    log('connected');
  };
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'barrier') { (barriers[m.id] = barriers[m.id] || {}).done = true; if (barriers[m.id].res) barriers[m.id].res(); return; }
    if (m.t === 'reset') { location.reload(); return; }
    if (m.t !== 'run') return;
    // Barrier: both sides reach `id` before either continues.
    const sig = (name0) => new Promise((res) => {
      const id = `${m.opts.roomId}:${name0}`; // barriers are per round
      const b = (barriers[id] = barriers[id] || {});
      if (b.done) { res(); return; }
      b.res = res; ws.send(JSON.stringify({ t: 'barrier', name, id }));
    });
    let result;
    try { result = await roleMatrixCall({ ...m.opts, sig }); } catch (err) { result = { ok: false, error: `${err && err.name}: ${err && err.message}` }; }
    // A failed round must not leave a client behind to answer the next call.
    for (const c of mxClients.splice(0)) { try { c.stopClient(); } catch {} }
    log(JSON.stringify(result));
    ws.send(JSON.stringify({ t: 'result', name, what: m.what, result }));
  };
  window.addEventListener('error', (e) => mxLog(`page error: ${e.message}`));
  // WebKit console output is not visible to the harness: forward warnings and errors.
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => { orig(...a); if ((level === 'log' || level === 'info' || level === 'debug') && !/Call|Peer|call/.test(String(a[0]))) return; mxLog(`console.${level}: ${a.map((x) => (x && x.stack) || (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ').slice(0, 600)}`); };
  }
  window.addEventListener('unhandledrejection', (e) => mxLog(`unhandled: ${e.reason && (e.reason.stack || e.reason.message || e.reason)}`));
}
