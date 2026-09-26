// LiveKit (Element Call's media stack) scenario. Runs unchanged in WebKitGTK
// through the shim and in Chromium natively, against a real livekit-server.
// Needs lk/livekit-client.umd.js and lk/livekit-client.e2ee.worker.mjs, which
// tests/livekit-e2e.mjs copies from node_modules.

let lkLog = () => {};

function lkTone(freq) {
  const ac = new AudioContext({ sampleRate: 48000 });
  const osc = ac.createOscillator(); osc.frequency.value = freq;
  const gain = ac.createGain(); gain.gain.value = 0.3;
  const dest = ac.createMediaStreamDestination();
  osc.connect(gain).connect(dest); osc.start(); ac.resume().catch(() => {});
  return { track: dest.stream.getAudioTracks()[0], stop: () => { osc.stop(); ac.close(); } };
}

// A moving colour field with a solid marker colour in the top-left corner,
// so the receiver can tell whose video it decoded.
function lkCanvas(marker) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360;
  const x = c.getContext('2d'); let i = 0;
  const iv = setInterval(() => {
    x.fillStyle = `hsl(${(i * 7) % 360},60%,40%)`; x.fillRect(0, 0, 640, 360);
    x.fillStyle = marker; x.fillRect(0, 0, 160, 120);
    x.fillStyle = '#fff'; x.font = '32px sans-serif'; x.fillText(`frame ${i++}`, 220, 200);
  }, 33);
  const track = c.captureStream(30).getVideoTracks()[0];
  return { track, stop: () => { clearInterval(iv); track.stop(); } };
}

async function lkAnalyse(mediaTrack, ms = 3000) {
  const stream = new MediaStream([mediaTrack]);
  const el = new Audio(); el.muted = true; el.srcObject = stream; el.play().catch(() => {});
  const ac = new AudioContext({ sampleRate: 48000 });
  await ac.resume().catch(() => {});
  const an = ac.createAnalyser(); an.fftSize = 8192; ac.createMediaStreamSource(stream).connect(an);
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
  return { peakHz: peaks.length ? peaks[Math.floor(peaks.length / 2)] : null, rmsMax: +rmsMax.toFixed(3) };
}

async function lkWatchVideo(mediaTrack, ms = 3000) {
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true;
  v.style.width = '160px'; document.body.appendChild(v);
  v.srcObject = new MediaStream([mediaTrack]); await Promise.race([v.play().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  let frames = 0; const t0 = performance.now();
  const tick = () => { frames++; if (performance.now() - t0 < ms) v.requestVideoFrameCallback(tick); };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
  await new Promise((r) => setTimeout(r, ms));
  // Marker colour: average of the top-left block.
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

async function roleLivekit(opts) {
  const LK = window.LivekitClient;
  const { url, token, key, freq, expectFreq, marker, expectMarker, e2ee, holdMs = 4000 } = opts;
  const out = { e2ee: !!e2ee, errors: [] };
  const roomOpts = { adaptiveStream: false, dynacast: false, publishDefaults: { videoCodec: 'vp8', simulcast: opts.simulcast !== false } };
  let keyProvider = null;
  if (e2ee) {
    keyProvider = new LK.ExternalE2EEKeyProvider();
    roomOpts.e2ee = { keyProvider, worker: new Worker(new URL('lk/livekit-client.e2ee.worker.mjs', location.href), { type: 'module' }) };
  }
  const room = new LK.Room(roomOpts);
  room.on(LK.RoomEvent.EncryptionError, (e) => out.errors.push(`encryption: ${e && e.message}`));
  room.on(LK.RoomEvent.MediaDevicesError, (e) => out.errors.push(`devices: ${e && e.message}`));
  if (e2ee) { await keyProvider.setKey(key); await room.setE2EEEnabled(true); }
  const remote = { audio: null, video: null };
  const subscribed = new Promise((res) => room.on(LK.RoomEvent.TrackSubscribed, (track) => {
    remote[track.kind] = track;
    lkLog(`subscribed ${track.kind}`);
    if (remote.audio && remote.video) res();
  }));
  const t0 = performance.now();
  await room.connect(url, token);
  out.connectMs = Math.round(performance.now() - t0);
  lkLog(`connected in ${out.connectMs} ms`);
  const tone = lkTone(freq); const cam = lkCanvas(marker);
  await room.localParticipant.publishTrack(new LK.LocalAudioTrack(tone.track, undefined, false), { name: 'tone', source: LK.Track.Source.Microphone });
  await room.localParticipant.publishTrack(new LK.LocalVideoTrack(cam.track, undefined, false), { name: 'cam', source: LK.Track.Source.Camera });
  lkLog('published');
  await Promise.race([subscribed, new Promise((_, rej) => setTimeout(() => rej(new Error('no remote tracks within 20 s')), 20000))]);
  await new Promise((r) => setTimeout(r, 1500));
  const [heard, seen] = await Promise.all([lkAnalyse(remote.audio.mediaStreamTrack), lkWatchVideo(remote.video.mediaStreamTrack)]);
  out.heard = heard; out.seen = seen;
  const pick = (o, ks) => o && Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  try { out.recvVideo = pick(await remote.video.getReceiverStats(), ['framesDecoded', 'framesReceived', 'frameWidth', 'frameHeight', 'packetsLost', 'packetsReceived', 'pliCount', 'firCount', 'framesDropped']); } catch (e) { out.recvVideo = String(e); }
  try { const pubs = [...room.localParticipant.trackPublications.values()]; const v = pubs.find((p) => p.kind === 'video'); out.sendVideo = (await v.track.getSenderStats()).map((x) => pick(x, ['rid', 'frameWidth', 'frameHeight', 'framesSent', 'bytesSent', 'packetsSent', 'targetBitrate', 'framesEncoded', 'qualityLimitationReason'])); } catch (e) { out.sendVideo = String(e); }
  out.rtp = [];
  for (const pc of window.__pcs || []) {
    try {
      (await pc.getStats()).forEach((r) => {
        if (r.type !== 'outbound-rtp' && r.type !== 'inbound-rtp') return;
        out.rtp.push(pick(r, ['type', 'kind', 'mid', 'framesEncoded', 'keyFramesEncoded', 'framesSent', 'framesDecoded', 'keyFramesDecoded', 'framesReceived', 'frameWidth', 'frameHeight', 'packetsSent', 'packetsReceived', 'pliCount', 'firCount', 'framesDropped', 'ipcMsPerFrame', 'targetBitrate', 'bytesSent', 'bytesReceived']));
      });
    } catch {}
  }
  // Frames that went through an RTCRtpScriptTransform (the shim exposes _seq).
  out.transformed = [];
  for (const pc of window.__pcs || []) {
    try {
      for (const x of [...pc.getSenders(), ...pc.getReceivers()]) {
        if (x.transform && typeof x.transform._seq === 'number') out.transformed.push({ kind: x.track && x.track.kind, dir: x instanceof RTCRtpSender ? 'send' : 'recv', frames: x.transform._seq });
      }
    } catch {}
  }
  out.encrypted = e2ee ? { room: room.isE2EEEnabled, local: room.localParticipant.isEncrypted, remote: [...room.remoteParticipants.values()].map((p) => p.isEncrypted) } : null;
  await new Promise((r) => setTimeout(r, holdMs)); // keep publishing until the other side is done
  await room.disconnect();
  tone.stop(); cam.stop();
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // Level is only a presence check: AEC3 attenuates the near-end tone while the
  // far-end tone plays (permanent double talk), so the level varies run to run.
  out.audioOk = !!heard.peakHz && Math.abs(heard.peakHz - expectFreq) < 25 && heard.rmsMax > 0.01;
  out.videoOk = seen.width > 0 && seen.fps > 5 && d(seen.marker, expectMarker) < 60;
  out.ok = out.audioOk && out.videoOk && out.errors.length === 0;
  // Through the shim, E2EE must actually run our transforms both ways.
  if (e2ee && window.RTCPeerConnection.prototype.__tauriShim) out.ok = out.ok && out.transformed.filter((t) => t.frames > 50).length >= 4;
  return out;
}

function lkHarness(name, wsUrl, log = console.log) {
  const ws = new WebSocket(wsUrl);
  lkLog = (msg) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'log', name, msg }));
  ws.onopen = () => {
    const shim = window.RTCPeerConnection && RTCPeerConnection.prototype.__tauriShim;
    ws.send(JSON.stringify({ t: 'hello', name, env: { shim: shim || null, ua: navigator.userAgent, lk: window.LivekitClient && LivekitClient.version, e2eeSupported: window.LivekitClient && LivekitClient.isE2EESupported() } }));
    log('connected');
  };
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.t !== 'run') return;
    let result;
    try { result = await roleLivekit(m.opts); } catch (err) { result = { ok: false, error: `${err && err.name}: ${err && err.message}` }; }
    log(JSON.stringify(result));
    ws.send(JSON.stringify({ t: 'result', name, what: m.what, result }));
  };
  window.addEventListener('error', (e) => lkLog(`page error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => lkLog(`unhandled: ${e.reason && (e.reason.stack || e.reason.message || e.reason)}`));
}
