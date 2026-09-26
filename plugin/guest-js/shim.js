// tauri-plugin-webrtc JS shim: peer connections, data channels, transceivers and media.
//
// Installed only when the webview has no native RTCPeerConnection (or when the
// plugin was built with force_shim). Every object is a handle to a resource in
// the Rust engine. Plain ES2020, no dependencies, runs before page scripts.
(() => {
  'use strict';
  const info = window.__TAURI_WEBRTC__ || {};
  // Same-origin iframes (Element Call is embedded as a widget) have no Tauri
  // internals of their own; they use the nearest same-origin ancestor's IPC.
  // Cross-origin frames throw on access and get no shim.
  const T = (() => {
    if (window.__TAURI_INTERNALS__) return window.__TAURI_INTERNALS__;
    try {
      for (let w = window; w !== w.parent;) { w = w.parent; if (w.__TAURI_INTERNALS__) return w.__TAURI_INTERNALS__; }
    } catch { /* cross-origin ancestor */ }
    return null;
  })();
  // Values from the parent realm fail instanceof checks against ours.
  const isArrayBuffer = (v) => Object.prototype.toString.call(v) === '[object ArrayBuffer]';
  if (!T || !info.available) return;
  if (typeof window.RTCPeerConnection === 'function' && !info.force) return;

  const MAX_MESSAGE_SIZE = 262144;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toDom(e) {
    if (e instanceof DOMException || e instanceof TypeError) return e;
    if (e && typeof e === 'object' && e.name) {
      return e.name === 'TypeError' ? new TypeError(e.message) : new DOMException(e.message, e.name);
    }
    return new DOMException(String(e), 'OperationError');
  }
  const invoke = (cmd, args, opts) =>
    T.invoke(`plugin:webrtc|${cmd}`, args, opts).catch((e) => { throw toDom(e); });

  // Minimal ordered channel, wire-compatible with @tauri-apps/api Channel.
  class OrderedChannel {
    constructor(onmessage) {
      let next = 0; let end; const pending = {};
      this.id = T.transformCallback((raw) => {
        const i = raw.index;
        if ('end' in raw) { if (i === next) T.unregisterCallback(this.id); else end = i; return; }
        if (i !== next) { pending[i] = raw.message; return; }
        onmessage(raw.message); next++;
        while (next in pending) { const m = pending[next]; delete pending[next]; onmessage(m); next++; }
        if (next === end) T.unregisterCallback(this.id);
      });
    }
    toJSON() { return `__CHANNEL__:${this.id}`; }
  }

  function defineHandlers(proto, names) {
    for (const name of names) {
      const key = Symbol(name);
      Object.defineProperty(proto, 'on' + name, {
        configurable: true, enumerable: true,
        get() { return this[key] ? this[key].fn : null; },
        set(fn) {
          if (this[key]) this.removeEventListener(name, this[key].wrap);
          this[key] = null;
          if (typeof fn === 'function') {
            const wrap = (e) => fn.call(this, e);
            this[key] = { fn, wrap };
            this.addEventListener(name, wrap);
          }
        },
      });
    }
  }

  class RTCSessionDescription {
    constructor(init = {}) { this.type = init.type; this.sdp = init.sdp || ''; }
    toJSON() { return { type: this.type, sdp: this.sdp }; }
  }

  class RTCIceCandidate {
    constructor(init = {}) {
      if (init.sdpMid == null && init.sdpMLineIndex == null) throw new TypeError('sdpMid and sdpMLineIndex are both null');
      this.candidate = init.candidate || '';
      this.sdpMid = init.sdpMid ?? null;
      this.sdpMLineIndex = init.sdpMLineIndex ?? null;
      this.usernameFragment = init.usernameFragment ?? null;
      const f = this.candidate.replace(/^a=/, '').replace(/^candidate:/, '').split(' ');
      const typIdx = f.indexOf('typ');
      this.foundation = f[0] || null;
      this.component = f[1] === '1' ? 'rtp' : f[1] === '2' ? 'rtcp' : null;
      this.protocol = f[2] ? f[2].toLowerCase() : null;
      this.priority = f[3] ? Number(f[3]) : null;
      this.address = f[4] || null;
      this.port = f[5] ? Number(f[5]) : null;
      this.type = typIdx > 0 ? f[typIdx + 1] : null;
    }
    toJSON() {
      return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex, usernameFragment: this.usernameFragment };
    }
  }

  class RTCPeerConnectionIceEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.candidate = init.candidate ?? null; this.url = init.url ?? null; }
  }
  class RTCDataChannelEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.channel = init.channel; }
  }

  const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  const PC = Symbol('pc');

  class RTCDataChannel extends EventTarget {
    constructor(pc, label, init, handle) {
      super();
      this[PC] = pc;
      this.label = String(label);
      this.ordered = init.ordered ?? true;
      this.maxPacketLifeTime = init.maxPacketLifeTime ?? null;
      this.maxRetransmits = init.maxRetransmits ?? null;
      this.protocol = init.protocol ?? '';
      this.negotiated = !!init.negotiated;
      this.id = init.id ?? null;
      this.readyState = 'connecting';
      this.binaryType = 'arraybuffer';
      this.bufferedAmountLowThreshold = 0;
      this._handle = handle;      // Promise<number> for local channels, number for remote
      this._queued = 0;           // bytes queued in JS or in flight over IPC
      this._engineBuffered = 0;   // last engine-side buffered amount
      this._out = [];             // pending records
      this._inflight = false;
    }
    get bufferedAmount() { return this._queued + this._engineBuffered; }

    send(data) {
      if (this.readyState !== 'open') throw new DOMException('RTCDataChannel is not open', 'InvalidStateError');
      let kind; let bytes;
      if (typeof data === 'string') { kind = 0; bytes = enc.encode(data); }
      else if (isArrayBuffer(data)) { kind = 1; bytes = new Uint8Array(data.slice(0)); }
      else if (ArrayBuffer.isView(data)) { kind = 1; bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)); }
      else if (data instanceof Blob) {
        // Keep order: reserve a slot now, fill it when the Blob is read.
        const rec = { kind: 1, bytes: null };
        this._out.push(rec);
        this._queued += data.size;
        data.arrayBuffer().then((b) => { rec.bytes = new Uint8Array(b); this._flush(); });
        return;
      }
      else throw new TypeError('unsupported data type');
      if (bytes.byteLength > MAX_MESSAGE_SIZE) throw new TypeError(`message exceeds ${MAX_MESSAGE_SIZE} bytes`);
      this._out.push({ kind, bytes });
      this._queued += bytes.byteLength;
      this._flush();
    }

    async _flush() {
      if (this._inflight) return;
      const ready = [];
      while (this._out.length && this._out[0].bytes) ready.push(this._out.shift());
      if (!ready.length) return;
      this._inflight = true;
      const size = ready.reduce((n, r) => n + 5 + r.bytes.byteLength, 0);
      const body = new Uint8Array(size);
      const dv = new DataView(body.buffer);
      let o = 0; let payloadBytes = 0;
      for (const r of ready) {
        body[o] = r.kind; dv.setUint32(o + 1, r.bytes.byteLength, true); body.set(r.bytes, o + 5);
        o += 5 + r.bytes.byteLength; payloadBytes += r.bytes.byteLength;
      }
      const before = this.bufferedAmount;
      try {
        const pcId = await this[PC]._id;
        const handle = await this._handle;
        this._engineBuffered = await invoke('dc_send', body, { headers: { 'x-pc': String(pcId), 'x-dc': String(handle) } });
      } catch (e) {
        this.dispatchEvent(Object.assign(new Event('error'), { error: toDom(e) }));
      } finally {
        this._queued -= payloadBytes;
        this._inflight = false;
      }
      this._checkLow(before);
      if (this._out.length) this._flush();
    }

    _checkLow(before) {
      const now = this.bufferedAmount;
      if (before > this.bufferedAmountLowThreshold && now <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event('bufferedamountlow'));
      }
    }

    async _refreshBuffered() {
      const before = this.bufferedAmount;
      try {
        this._engineBuffered = await invoke('dc_buffered_amount', { id: await this[PC]._id, handle: await this._handle });
      } catch { /* closed */ }
      this._checkLow(before);
    }

    close() {
      if (this.readyState === 'closing' || this.readyState === 'closed') return;
      this.readyState = 'closing';
      Promise.all([this[PC]._id, this._handle])
        .then(([id, handle]) => invoke('dc_close', { id, handle }))
        .catch(() => {});
    }

    _onOpen(id) {
      if (id != null) this.id = id;
      if (this.readyState !== 'connecting') return;
      this.readyState = 'open';
      this.dispatchEvent(new Event('open'));
    }
    _onMessage(kind, bytes) {
      if (this.readyState !== 'open') return;
      let data;
      if (kind === 0) data = dec.decode(bytes);
      else if (this.binaryType === 'blob') data = new Blob([bytes]);
      else data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
    _onClose() {
      if (this.readyState === 'closed') return;
      if (this.readyState !== 'closing') { this.readyState = 'closing'; this.dispatchEvent(new Event('closing')); }
      this.readyState = 'closed';
      this.dispatchEvent(new Event('close'));
    }
  }
  defineHandlers(RTCDataChannel.prototype, ['open', 'message', 'close', 'closing', 'error', 'bufferedamountlow']);

  // ================================================================ media
  //
  // Tracks stay native MediaStreamTracks, so the rest of the app (voice
  // messages, level meters, device pickers) keeps working. The page does
  // device I/O; video is coded with WebCodecs (VP8); the engine does transport.

  const CODEC = { vp8: 1, vp9: 2, h264: 3, av1: 4, opus: 10 };
  const MAX_W = 1280; const MAX_H = 720; const MAX_FPS = 30;
  let audioCtx = null;
  const ctx = () => (audioCtx = audioCtx || new AudioContext({ sampleRate: 48000 }));
  const nowUs = () => Math.round(performance.now() * 1000);

  function mediaHost() {
    let el = document.getElementById('__tauri_webrtc_media');
    if (!el) {
      el = document.createElement('div');
      el.id = '__tauri_webrtc_media';
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, { position: 'fixed', left: '-4px', top: '-4px', width: '2px', height: '2px', overflow: 'hidden', opacity: '0.01', pointerEvents: 'none' });
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  // Sequential IPC for one sender: frames must reach the engine in order.
  class FramePusher {
    constructor(pc, txId, extra) { this.pc = pc; this.txId = txId; this.extra = extra || {}; this.q = []; this.busy = false; this.sent = 0; this.bytes = 0; this.dropped = 0; }
    push(frame) {
      if (this.q.length > 8) { // bounded latency: drop the backlog, ask for a keyframe
        this.dropped += this.q.length; this.q.length = 0; this.onBacklog && this.onBacklog();
        if (!frame.key) return;
      }
      this.q.push(frame); this._pump();
    }
    async _pump() {
      if (this.busy) return; this.busy = true;
      try {
        const id = await this.pc._id;
        while (this.q.length) {
          const f = this.q.shift();
          const t0 = performance.now();
          await invoke('media_push', f.data, { headers: { ...this.extra, 'x-pc': String(id), 'x-tx': String(this.txId), 'x-codec': String(f.codec), 'x-key': f.key ? '1' : '0', 'x-ts': String(f.ts) } });
          this.ipcMs = (this.ipcMs || 0) + (performance.now() - t0);
          this.sent++; this.bytes += f.data.byteLength;
        }
      } catch (e) { /* pc closed */ } finally { this.busy = false; }
    }
  }

  class VideoSendPipe {
    constructor(sender) {
      this.sender = sender; this.track = null; this.video = null; this.encoder = null;
      this.w = 0; this.h = 0; this.forceKey = true; this.lastFrameAt = 0; this.stopped = false;
      this.bitrate = 1_000_000; this.maxBitrate = null; this.scale = 1; this.active = true;
      this.framesEncoded = 0; this.keyFramesEncoded = 0;
      this.pusher = new FramePusher(sender._tx._pc, sender._tx._id);
      this.pusher.onBacklog = () => { this.forceKey = true; };
    }
    setTrack(track) {
      if (track === this.track) return;
      this.track = track; this.forceKey = true;
      // Screen content: favour resolution over frame rate, like browsers do.
      let settings = {};
      try { settings = (track && track.getSettings && track.getSettings()) || {}; } catch {}
      this.screen = !!track && (!!settings.displaySurface || track.contentHint === 'detail' || track.contentHint === 'text');
      this.maxW = this.screen ? 1920 : MAX_W; this.maxH = this.screen ? 1080 : MAX_H; this.fps = this.screen ? 15 : MAX_FPS;
      if (this.screen && this.bitrate < 1_500_000) this.bitrate = 1_500_000;
      if (!track) { if (this.video) this.video.srcObject = null; return; }
      if (!this.video) {
        this.video = document.createElement('video');
        this.video.muted = true; this.video.playsInline = true; this.video.autoplay = true;
        mediaHost().appendChild(this.video);
      }
      this.video.srcObject = new MediaStream([track]);
      this.video.play().catch(() => {});
      this._schedule();
    }
    _schedule() {
      if (this.stopped || !this.video) return;
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(() => this._tick());
      else setTimeout(() => this._tick(), 1000 / (this.fps || MAX_FPS));
    }
    _configure(w, h) {
      // Pixel budget from the bitrate: about 0.08 bits per pixel per frame for VP8.
      const budget = Math.max(160 * 120, this.bitrate / ((this.fps || MAX_FPS) * 0.08));
      const bw = Math.min(1, Math.sqrt(budget / (w * h)));
      const s = Math.min(1, (this.maxW || MAX_W) / w, (this.maxH || MAX_H) / h, bw) / this.scale;
      this.w = Math.max(2, Math.round((w * s) / 2) * 2); this.h = Math.max(2, Math.round((h * s) / 2) * 2);
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
      this.encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
          const key = chunk.type === 'key'; this.framesEncoded++; if (key) this.keyFramesEncoded++;
          this.sender._out({ data, key, ts: chunk.timestamp, codec: CODEC.vp8, video: true, width: this.w, height: this.h });
        },
        error: (e) => { console.warn('[tauri-webrtc] video encoder', e); this.encoder = null; },
      });
      const bitrate = Math.max(50_000, Math.min(this.bitrate, this.maxBitrate || Infinity));
      this.encoder.configure({ codec: 'vp8', width: this.w, height: this.h, bitrate, framerate: this.fps || MAX_FPS, latencyMode: 'realtime' });
      this.srcW = w; this.srcH = h; this.forceKey = true;
    }
    _tick() {
      if (this.stopped) return;
      const v = this.video; const t = this.track;
      try {
        const now = performance.now();
        if (t && t.readyState === 'live' && this.active && v.videoWidth && now - this.lastFrameAt >= 1000 / (this.fps || MAX_FPS) - 2) {
          if (!this.encoder || v.videoWidth !== this.srcW || v.videoHeight !== this.srcH) this._configure(v.videoWidth, v.videoHeight);
          if (this.encoder && this.encoder.encodeQueueSize < 3) {
            this.lastFrameAt = now;
            let frame;
            if (!t.enabled) { // disabled tracks send black, like browsers
              const c = this._black || (this._black = document.createElement('canvas'));
              c.width = this.w; c.height = this.h; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, this.w, this.h);
              frame = new VideoFrame(c, { timestamp: nowUs() });
            } else if (this.w === v.videoWidth && this.h === v.videoHeight) {
              frame = new VideoFrame(v, { timestamp: nowUs() });
            } else {
              const c = this._scaled || (this._scaled = document.createElement('canvas'));
              if (c.width !== this.w || c.height !== this.h) { c.width = this.w; c.height = this.h; }
              c.getContext('2d').drawImage(v, 0, 0, this.w, this.h);
              frame = new VideoFrame(c, { timestamp: nowUs() });
            }
            this.encoder.encode(frame, { keyFrame: this.forceKey }); this.forceKey = false; frame.close();
          }
        }
      } catch (e) { console.warn('[tauri-webrtc] video send', e); }
      this._schedule();
    }
    // Follow the engine's bandwidth estimate. A WebCodecs reconfigure forces a
    // keyframe, so only react to real changes and at most every two seconds.
    setBitrate(bps) {
      const b = Math.max(60_000, Math.round(bps));
      const now = performance.now();
      if (Math.abs(b - this.bitrate) / this.bitrate < 0.2 || now - (this._lastRate || 0) < 2000) return;
      this._lastRate = now; this.bitrate = b;
      // Resolution follows the bitrate (see _configure) so low-bandwidth calls stay smooth.
      if (this.encoder) this._configure(this.srcW, this.srcH);
    }
    stop() { this.stopped = true; if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); if (this.video) { this.video.srcObject = null; this.video.remove(); } }
    stats() { return { framesEncoded: this.framesEncoded, keyFramesEncoded: this.keyFramesEncoded, framesSent: this.pusher.sent, bytesSent: this.pusher.bytes, frameWidth: this.w, frameHeight: this.h, targetBitrate: this.bitrate, framesDropped: this.pusher.dropped, ipcMsPerFrame: this.pusher.sent ? +(this.pusher.ipcMs / this.pusher.sent).toFixed(2) : null }; }
  }

  class VideoRecvPipe {
    constructor(tx) {
      this.tx = tx;
      this.canvas = document.createElement('canvas'); this.canvas.width = 2; this.canvas.height = 2;
      this.c2d = this.canvas.getContext('2d');
      this.track = this.canvas.captureStream().getVideoTracks()[0];
      this.decoder = null; this.needKey = true; this.framesReceived = 0; this.framesDecoded = 0; this.bytes = 0; this.keyFramesDecoded = 0;
      this.lastKeyReq = 0;
    }
    _decoder() {
      if (this.decoder && this.decoder.state === 'configured') return this.decoder;
      this.decoder = new VideoDecoder({
        output: (f) => {
          if (this.canvas.width !== f.displayWidth || this.canvas.height !== f.displayHeight) {
            this.canvas.width = f.displayWidth; this.canvas.height = f.displayHeight;
          }
          this.c2d.drawImage(f, 0, 0); f.close(); this.framesDecoded++;
        },
        error: (e) => { console.warn('[tauri-webrtc] video decoder', e); this.needKey = true; this._askKey(); },
      });
      this.decoder.configure({ codec: 'vp8', optimizeForLatency: true });
      return this.decoder;
    }
    _askKey() {
      const now = performance.now(); if (now - this.lastKeyReq < 500) return; this.lastKeyReq = now;
      this.tx._pc._id.then((id) => invoke('pc_request_keyframe', { id, tx: this.tx._id })).catch(() => {});
    }
    frame(codec, key, ts, data) {
      this.framesReceived++; this.bytes += data.byteLength;
      const t = this.tx.receiver && this.tx.receiver._transform;
      if (t) { t._process({ video: true, key, ts, codec, ssrc: this.tx.receiver._ssrc, pt: 96 }, data); return; }
      this._decode(codec, key, ts, data);
    }
    _decode(codec, key, ts, data) {
      if (codec !== CODEC.vp8) return;
      if (this.needKey && !key) { this._askKey(); return; }
      this.needKey = false; if (key) this.keyFramesDecoded++;
      try { this._decoder().decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data })); }
      catch (e) { this.needKey = true; this.decoder = null; this._askKey(); }
    }
    stop() { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); this.track.stop(); }
    stats() { return { framesReceived: this.framesReceived, framesDecoded: this.framesDecoded, keyFramesDecoded: this.keyFramesDecoded, bytesReceived: this.bytes, frameWidth: this.canvas.width, frameHeight: this.canvas.height }; }
  }

  // Audio: the page does device I/O through AudioWorklets; the engine runs
  // echo cancellation, noise suppression, AGC, Opus and the playout clock.
  const WORKLET = `
    class Capture extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Int16Array(960); this.n = 0; }
      process(inputs) {
        const ch = inputs[0];
        if (ch && ch.length) {
          const a = ch[0]; const b = ch[1];
          for (let i = 0; i < a.length; i++) {
            let v = b ? (a[i] + b[i]) * 0.5 : a[i];
            v = v < -1 ? -1 : v > 1 ? 1 : v;
            this.buf[this.n++] = v * 32767;
            if (this.n === 960) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Int16Array(960); this.n = 0; }
          }
        }
        return true;
      }
    }
    class Playout extends AudioWorkletProcessor {
      constructor() {
        super();
        this.ring = new Float32Array(48000); this.r = 0; this.w = 0; this.size = 0; this.primed = false;
        this.underruns = 0; this.skipped = 0;
        this.port.onmessage = (e) => {
          const s = new Int16Array(e.data);
          for (let i = 0; i < s.length; i++) {
            if (this.size === this.ring.length) { this.r = (this.r + 1) % this.ring.length; this.size--; }
            this.ring[this.w] = s[i] / 32768; this.w = (this.w + 1) % this.ring.length; this.size++;
          }
          // Drift and burst control: keep latency near 60 ms.
          if (this.size > 7200) { const d = this.size - 2880; this.r = (this.r + d) % this.ring.length; this.size -= d; this.skipped += d; }
        };
      }
      process(_, outputs) {
        const out = outputs[0][0];
        if (!this.primed && this.size >= 2880) this.primed = true;
        for (let i = 0; i < out.length; i++) {
          if (this.primed && this.size > 0) { out[i] = this.ring[this.r]; this.r = (this.r + 1) % this.ring.length; this.size--; }
          else { out[i] = 0; }
        }
        if (this.primed && this.size === 0) { this.primed = false; this.underruns++; }
        for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
        return true;
      }
    }
    registerProcessor('tauri-webrtc-capture', Capture);
    registerProcessor('tauri-webrtc-playout', Playout);
  `;
  let workletReady = null;
  function audioWorklets() {
    if (!workletReady) {
      const c = ctx();
      workletReady = c.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })))
        .then(() => { c.resume().catch(() => {}); return c; });
    }
    return workletReady;
  }

  class AudioSendPipe {
    constructor(sender) {
      this.sender = sender; this.track = null; this.src = null; this.node = null; this.stopped = false;
      this.q = []; this.busy = false; this.sent = 0; this.bytes = 0; this.silentFrames = 0;
    }
    setTrack(track) {
      if (track === this.track) return;
      this.track = track;
      if (this.src) { try { this.src.disconnect(); } catch {} this.src = null; }
      if (!track) return;
      audioWorklets().then((c) => {
        if (this.stopped || this.track !== track) return;
        if (!this.node) {
          this.node = new AudioWorkletNode(c, 'tauri-webrtc-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
          this.node.port.onmessage = (e) => this._frame(e.data);
        }
        this.src = c.createMediaStreamSource(new MediaStream([track]));
        this.src.connect(this.node);
      }).catch((e) => console.warn('[tauri-webrtc] audio capture', e));
    }
    _frame(buf) {
      if (this.stopped || !this.track) return;
      // Disabled tracks send silence, like browsers.
      if (!this.track.enabled || this.track.readyState !== 'live') { new Int16Array(buf).fill(0); this.silentFrames++; }
      if (this.q.length > 10) this.q.splice(0, this.q.length - 5);
      this.q.push(buf); this._pump();
    }
    async _pump() {
      if (this.busy) return; this.busy = true;
      try {
        const id = await this.sender._tx._pc._id;
        while (this.q.length) {
          const bufs = this.q.splice(0, this.q.length);
          const body = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0));
          let o = 0; for (const b of bufs) { body.set(new Uint8Array(b), o); o += b.byteLength; }
          await invoke('audio_push', body, { headers: { 'x-pc': String(id), 'x-tx': String(this.sender._tx._id) } });
          this.sent += bufs.length; this.bytes += body.byteLength;
        }
      } catch (e) { /* closed */ } finally { this.busy = false; }
    }
    stop() { this.stopped = true; if (this.src) try { this.src.disconnect(); } catch {} if (this.node) { this.node.port.onmessage = null; } }
    stats() { return { framesSent: this.sent, silentFrames: this.silentFrames }; }
  }

  class AudioRecvPipe {
    constructor(tx) {
      this.tx = tx; this.framesReceived = 0; this.samples = 0; this.pending = [];
      try {
        const c = ctx();
        this.dest = c.createMediaStreamDestination();
        this.track = this.dest.stream.getAudioTracks()[0];
        audioWorklets().then((c2) => {
          this.node = new AudioWorkletNode(c2, 'tauri-webrtc-playout', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
          this.node.connect(this.dest);
          for (const p of this.pending.splice(0)) this.node.port.postMessage(p, [p]);
        }).catch((e) => console.warn('[tauri-webrtc] audio playout', e));
      } catch (e) { this.track = null; }
    }
    pcm(bytes) {
      this.framesReceived++; this.samples += bytes.byteLength / 2;
      const buf = bytes.slice().buffer;
      if (this.node) this.node.port.postMessage(buf, [buf]); else if (this.pending.length < 50) this.pending.push(buf);
    }
    // Encoded Opus arrives here only in transform mode; it goes back to the
    // engine for decoding once the page's transform is done with it.
    frame(codec, key, ts, data) {
      const t = this.tx.receiver && this.tx.receiver._transform;
      if (t) t._process({ video: false, key: true, ts, codec, ssrc: this.tx.receiver._ssrc, pt: 111 }, data);
      else this._decode(codec, key, ts, data);
    }
    _decode(codec, key, ts, data) {
      this.back = this.back || new FramePusher(this.tx._pc, this.tx._id, { 'x-dir': 'recv' });
      this.back.push({ data: data.slice(), key: true, ts, codec });
    }
    stop() { if (this.node) try { this.node.disconnect(); } catch {} if (this.track) this.track.stop(); }
    stats() { return { packetsReceived: this.framesReceived, totalSamplesReceived: this.samples }; }
  }

  // ================================================ encoded transforms
  // RTCRtpScriptTransform (the WebKit/Firefox shape of insertable streams),
  // used by LiveKit E2EE. The page's worker receives an `rtctransform` event
  // with readable/writable streams of encoded frames. WebKitGTK workers have
  // no WebRTC globals, so every Worker is started through a small wrapper that
  // loads the polyfill below first. Frames cross to the worker on a
  // MessagePort, tagged so the main thread can match them on the way back.
  const WORKER_POLYFILL = `(() => {
    if (self.RTCTransformEvent) return;
    const base = self.__tauriWorkerUrl;
    if (base) {
      // The worker runs from a blob: wrapper; keep relative URLs resolving
      // against the real script, as they would without the wrapper.
      const real = new URL(base);
      const loc = { href: real.href, origin: real.origin, protocol: real.protocol, host: real.host, hostname: real.hostname,
        port: real.port, pathname: real.pathname, search: real.search, hash: real.hash, toString() { return real.href; } };
      try { Object.defineProperty(self, 'location', { get: () => loc, configurable: true }); } catch {}
      const rel = (u) => (typeof u === 'string' ? new URL(u, real).href : u);
      const f = self.fetch; if (f) self.fetch = (u, o) => f.call(self, u instanceof Request ? u : rel(String(u)), o);
      const is = self.importScripts; if (is) self.importScripts = (...u) => is.apply(self, u.map((x) => rel(String(x))));
      if (self.XMLHttpRequest) { const o = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u, ...r) { return o.call(this, m, rel(String(u)), ...r); }; }
    }
    class RTCEncodedVideoFrame {
      constructor(d) { this.type = d.type; this.timestamp = d.timestamp; this.data = d.data; this._m = d.metadata; }
      getMetadata() { return { ...this._m }; }
    }
    class RTCEncodedAudioFrame {
      constructor(d) { this.timestamp = d.timestamp; this.data = d.data; this._m = d.metadata; }
      getMetadata() { return { ...this._m }; }
    }
    class RTCRtpScriptTransformer extends EventTarget {
      constructor(port, options) {
        super(); this.options = options; this._port = port;
        const tags = new WeakMap();
        this.readable = new ReadableStream({
          start(c) {
            port.onmessage = (e) => {
              const d = e.data;
              if (d.kf) return;
              const f = d.video ? new RTCEncodedVideoFrame(d) : new RTCEncodedAudioFrame(d);
              tags.set(f, d.tag); c.enqueue(f);
            };
          },
        });
        this.writable = new WritableStream({
          write(f) {
            const tag = tags.get(f);
            if (tag === undefined) return; // frames must come from our readable
            const data = f.data instanceof ArrayBuffer ? f.data : new Uint8Array(f.data).slice().buffer;
            port.postMessage({ tag, data }, [data]);
          },
        });
      }
      generateKeyFrame() { this._port.postMessage({ kf: 'generate' }); return Promise.resolve(); }
      sendKeyFrameRequest() { this._port.postMessage({ kf: 'request' }); return Promise.resolve(); }
    }
    class RTCTransformEvent extends Event {
      constructor(type, init) { super(type, init); this.transformer = init && init.transformer; }
    }
    let handler = null;
    Object.defineProperty(self, 'onrtctransform', {
      configurable: true,
      get: () => handler,
      set: (v) => { if (handler) self.removeEventListener('rtctransform', handler); handler = typeof v === 'function' ? v : null; if (handler) self.addEventListener('rtctransform', handler); },
    });
    Object.assign(self, { RTCTransformEvent, RTCEncodedVideoFrame, RTCEncodedAudioFrame, RTCRtpScriptTransformer });
    self.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.__tauriRtcTransform !== 1) return;
      e.stopImmediatePropagation();
      const transformer = new RTCRtpScriptTransformer(d.port, d.options);
      self.dispatchEvent(new RTCTransformEvent('rtctransform', { transformer }));
    });
  })();`;
  const NativeWorker = window.Worker;
  const TauriWorker = NativeWorker && info.wrapWorkers !== false ? class Worker extends NativeWorker {
    constructor(url, options) {
      let wrapped = null;
      try {
        const real = new URL(String(url), document.baseURI).href;
        if (!real.startsWith('blob:') && !real.startsWith('data:')) {
          // Imports evaluate in order, so the polyfill (with the real URL baked
          // in) runs before the worker script defines its handlers.
          const poly = URL.createObjectURL(new Blob([`self.__tauriWorkerUrl = ${JSON.stringify(real)};\n${WORKER_POLYFILL}`], { type: 'text/javascript' }));
          const src = options && options.type === 'module'
            ? `import ${JSON.stringify(poly)};\nimport ${JSON.stringify(real)};\n`
            : `importScripts(${JSON.stringify(poly)});\nimportScripts(${JSON.stringify(real)});\n`;
          wrapped = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        }
      } catch { wrapped = null; }
      if (wrapped) {
        try { super(wrapped, options); return; } catch (e) { console.warn('[tauri-webrtc] worker wrapper refused, transforms unavailable in it', e); }
      }
      super(url, options);
    }
  } : null;

  let transformSsrc = 0x1000;
  class RTCRtpScriptTransform {
    constructor(worker, options, transfer) {
      if (!worker || typeof worker.postMessage !== 'function') throw new TypeError('RTCRtpScriptTransform needs a Worker');
      const ch = new MessageChannel();
      this._port = ch.port1; this._pending = new Map(); this._seq = 0; this._sink = null; this._owner = null;
      this._port.onmessage = (e) => {
        const m = e.data;
        if (m.kf) { if (this._owner && this._owner._onTransformKeyFrame) this._owner._onTransformKeyFrame(m.kf); return; }
        const meta = this._pending.get(m.tag);
        if (!meta) return;
        this._pending.delete(m.tag);
        if (this._sink) this._sink(meta, new Uint8Array(m.data));
      };
      worker.postMessage({ __tauriRtcTransform: 1, port: ch.port2, options }, [ch.port2, ...(transfer || [])]);
    }
    // meta: { video, key, ts (µs), codec, ssrc, pt }
    _process(meta, bytes) {
      const tag = ++this._seq;
      this._pending.set(tag, meta);
      if (this._pending.size > 600) this._pending.delete(this._pending.keys().next().value); // frames the transform dropped
      const data = bytes.slice().buffer;
      const clock = meta.video ? 90 : 48;
      const rtpTimestamp = Math.floor((meta.ts * clock) / 1000) % 0x100000000;
      const metadata = {
        synchronizationSource: meta.ssrc, payloadType: meta.pt, contributingSources: [], rtpTimestamp,
        mimeType: meta.video ? 'video/VP8' : 'audio/opus',
      };
      if (meta.video) Object.assign(metadata, { frameId: tag, dependencies: [], width: meta.width || 0, height: meta.height || 0, spatialIndex: 0, temporalIndex: 0 });
      this._port.postMessage({ tag, video: meta.video, type: meta.video ? (meta.key ? 'key' : 'delta') : undefined, timestamp: rtpTimestamp, data, metadata }, [data]);
    }
    _detach() { this._sink = null; this._owner = null; }
  }
  const nextSsrc = () => (transformSsrc = (transformSsrc * 1103515245 + 12345) >>> 0) || 1;

  const AUDIO_CAPS = { codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10;useinbandfec=1' }], headerExtensions: [] };
  const VIDEO_CAPS = { codecs: [{ mimeType: 'video/VP8', clockRate: 90000 }, { mimeType: 'video/rtx', clockRate: 90000 }], headerExtensions: [] };
  const capabilities = (kind) => (kind === 'audio' ? structuredClone(AUDIO_CAPS) : kind === 'video' ? structuredClone(VIDEO_CAPS) : null);

  class RTCDTMFSender extends EventTarget {
    constructor() { super(); this.toneBuffer = ''; }
    get canInsertDTMF() { return false; }
    insertDTMF() { throw new DOMException('DTMF is not supported yet', 'InvalidStateError'); }
  }
  defineHandlers(RTCDTMFSender.prototype, ['tonechange']);

  class RTCRtpSender {
    constructor(tx, track) {
      this._tx = tx; this.track = track || null; this.transport = null; this.rtcpTransport = null;
      this._everSent = !!track;
      this.dtmf = tx.kind === 'audio' ? new RTCDTMFSender() : null;
      this._params = { transactionId: '', encodings: [{ active: true }], codecs: [], headerExtensions: [], rtcp: { cname: '', reducedSize: true }, degradationPreference: 'balanced' };
      this._pipe = null;
    }
    _setTrack(track) {
      this.track = track || null; if (track) this._everSent = true;
      if (!this._pipe && track) {
        this._pipe = this._tx.kind === 'video' ? new VideoSendPipe(this) : new AudioSendPipe(this);
        if (this._tx.kind === 'video') this.setParameters(this._params).catch(() => {}); // sendEncodings from addTransceiver
      }
      if (this._pipe) this._pipe.setTrack(this.track);
    }
    get transform() { return this._transform || null; }
    set transform(t) {
      if (t != null && !(t instanceof RTCRtpScriptTransform)) throw new TypeError('transform must be an RTCRtpScriptTransform');
      if (t && t._owner && t._owner !== this) throw new DOMException('transform is already in use', 'InvalidStateError');
      if (this._transform && this._transform !== t) this._transform._detach();
      this._transform = t || null; this._ssrc = this._ssrc || nextSsrc();
      if (t) { t._owner = this; t._sink = (meta, data) => this._send(meta, data); }
      if (this._tx.kind === 'audio') this._tx._syncTransform();
    }
    // An encoded frame from our video encoder or the engine's Opus encoder.
    _out(f) {
      const t = this._transform;
      if (t) t._process({ video: f.video, key: f.key, ts: f.ts, codec: f.codec, ssrc: this._ssrc, pt: f.video ? 96 : 111, width: f.width, height: f.height }, f.data);
      else this._send(f, f.data);
    }
    _send(meta, data) {
      if (this._tx.kind === 'video') { if (this._pipe) this._pipe.pusher.push({ data, key: meta.key, ts: meta.ts, codec: meta.codec }); return; }
      this._encPusher = this._encPusher || new FramePusher(this._tx._pc, this._tx._id);
      this._encPusher.push({ data, key: true, ts: meta.ts, codec: meta.codec });
    }
    _onTransformKeyFrame() { if (this._pipe && this._tx.kind === 'video') this._pipe.forceKey = true; }
    async replaceTrack(track) {
      if (this._tx._pc._closed) throw new DOMException('RTCPeerConnection is closed', 'InvalidStateError');
      if (track && track.kind !== this._tx.kind) throw new TypeError('track kind does not match the sender');
      if (this._tx._stopping) throw new DOMException('transceiver is stopped', 'InvalidStateError');
      this._setTrack(track);
    }
    getParameters() { return structuredClone({ ...this._params, transactionId: String(Math.random()).slice(2), codecs: capabilities(this._tx.kind).codecs }); }
    async setParameters(p) {
      if (!p || !Array.isArray(p.encodings)) throw new TypeError('encodings are required');
      this._params.encodings = p.encodings.map((e) => ({ ...e }));
      // We send one layer. With simulcast encodings, it is the best active one.
      const act = p.encodings.filter((e) => e.active !== false);
      const e0 = (act.length ? act : p.encodings).reduce((best, e) => ((e.scaleResolutionDownBy || 1) < (best.scaleResolutionDownBy || 1) ? e : best), (act[0] || p.encodings[0] || {}));
      if (this._pipe && this._tx.kind === 'video') {
        this._pipe.active = e0.active !== false;
        this._pipe.maxBitrate = e0.maxBitrate || null;
        const sc = e0.scaleResolutionDownBy || 1;
        if (sc !== this._pipe.scale) { this._pipe.scale = sc; this._pipe.srcW = 0; }
      }
    }
    setStreams(...streams) {
      this._tx._streamIds = streams.map((s) => s.id);
      this._tx._pc._syncTx(this._tx); this._tx._pc._updateNegotiationNeeded();
    }
    async getStats() { return this._tx._pc.getStats(); }
    static getCapabilities(kind) { return capabilities(kind); }
  }

  class RTCRtpReceiver {
    constructor(tx) {
      this._tx = tx; this.transport = null; this.rtcpTransport = null; this.jitterBufferTarget = null;
      this._pipe = tx.kind === 'video' ? new VideoRecvPipe(tx) : new AudioRecvPipe(tx);
      this.track = this._pipe.track;
    }
    get transform() { return this._transform || null; }
    set transform(t) {
      if (t != null && !(t instanceof RTCRtpScriptTransform)) throw new TypeError('transform must be an RTCRtpScriptTransform');
      if (t && t._owner && t._owner !== this) throw new DOMException('transform is already in use', 'InvalidStateError');
      if (this._transform && this._transform !== t) this._transform._detach();
      this._transform = t || null; this._ssrc = this._ssrc || nextSsrc();
      if (t) { t._owner = this; t._sink = (meta, data) => this._pipe._decode(meta.codec, meta.key, meta.ts, data); }
      if (this._tx.kind === 'audio') this._tx._syncTransform();
      else if (t) this._pipe._askKey(); // decoding restarts with the transformed stream
    }
    _onTransformKeyFrame() { if (this._pipe._askKey) this._pipe._askKey(); }
    getContributingSources() { return []; }
    getSynchronizationSources() { return []; }
    getParameters() { return { codecs: capabilities(this._tx.kind).codecs, headerExtensions: [], rtcp: { cname: '', reducedSize: true } }; }
    async getStats() { return this._tx._pc.getStats(); }
    static getCapabilities(kind) { return capabilities(kind); }
  }

  const DIRECTIONS = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];
  class RTCRtpTransceiver {
    constructor(pc, { id, kind, direction, streamIds, senderTrackId, fromAddTrack, createdByRemote, track }) {
      this._pc = pc; this._id = id; this.kind = kind;
      this._direction = direction; this._streamIds = streamIds || [];
      this._senderTrackId = senderTrackId || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
      this._fromAddTrack = !!fromAddTrack; this._createdByRemote = !!createdByRemote;
      this._mid = null; this._currentDirection = null; this._negotiatedDirection = null;
      this._stopping = false; this._stopped = false; this._receiving = false; this._recvStreams = [];
      this._remote = { dir: null, streams: [], track: null };
      this.sender = new RTCRtpSender(this, null);
      this.receiver = new RTCRtpReceiver(this);
      if (track) this.sender._setTrack(track);
      this._codecPrefs = null;
    }
    get mid() { return this._mid; }
    get currentDirection() { return this._stopped ? 'stopped' : this._currentDirection; }
    get direction() { return this._stopping ? 'stopped' : this._direction; }
    set direction(d) {
      if (!DIRECTIONS.includes(d)) throw new TypeError(`invalid direction ${d}`);
      if (this._stopping) throw new DOMException('transceiver is stopped', 'InvalidStateError');
      if (d === this._direction) return;
      this._direction = d; this._pc._syncTx(this); this._pc._updateNegotiationNeeded();
    }
    get stopped() { return this._stopped; }
    stop() {
      if (this._pc._closed) throw new DOMException('RTCPeerConnection is closed', 'InvalidStateError');
      if (this._stopping) return;
      this._stopping = true;
      if (this.sender._pipe) this.sender._pipe.stop();
      this.sender.track = null;
      this.receiver._pipe.stop();
      this._pc._removeRemoteTrack(this);
      this._pc._syncTx(this); this._pc._updateNegotiationNeeded();
    }
    setCodecPreferences(codecs) {
      const caps = capabilities(this.kind).codecs.map((c) => c.mimeType.toLowerCase());
      for (const c of codecs || []) {
        if (!caps.includes(String(c.mimeType).toLowerCase())) throw new DOMException(`unsupported codec ${c.mimeType}`, 'InvalidModificationError');
      }
      this._codecPrefs = codecs && codecs.length ? codecs : null;
    }
    _syncTransform() {
      const send = !!this.sender._transform; const recv = !!this.receiver._transform;
      this._pc._id.then((id) => invoke('pc_set_transform', { id, tx: this._id, send, recv })).catch(() => {});
    }
    _spec() {
      return {
        id: this._id, kind: this.kind, direction: this._stopping ? 'stopped' : this._direction,
        streamIds: this._streamIds, senderTrackId: this._senderTrackId, fromAddTrack: this._fromAddTrack, stopped: this._stopping,
      };
    }
  }

  class RTCTrackEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.receiver = init.receiver; this.track = init.track; this.streams = init.streams || []; this.transceiver = init.transceiver;
    }
  }

  function trackEvent(type, track) {
    try { return new MediaStreamTrackEvent(type, { track }); } catch { return Object.assign(new Event(type), { track }); }
  }

  // ======================================================= peer connection

  // Close this frame's connections when it goes away: an iframe's peers
  // would otherwise outlive it in the engine until the window reloads.
  const livePeers = new Set();
  window.addEventListener('pagehide', (e) => { if (!e.persisted) for (const pc of [...livePeers]) { try { pc.close(); } catch {} } });

  class RTCPeerConnection extends EventTarget {
    constructor(configuration = {}) {
      super();
      livePeers.add(this);
      this._config = {
        iceServers: (configuration.iceServers || []).map((s) => ({ urls: s.urls ?? s.url, username: s.username, credential: s.credential })),
        iceTransportPolicy: configuration.iceTransportPolicy || 'all',
        bundlePolicy: configuration.bundlePolicy || 'max-bundle',
        rtcpMuxPolicy: 'require',
      };
      this.signalingState = 'stable';
      this.iceGatheringState = 'new';
      this.iceConnectionState = 'new';
      this.connectionState = 'new';
      this.canTrickleIceCandidates = null;
      this._local = null; this._remote = null;
      this._currentLocal = null; this._currentRemote = null;
      this._channels = new Map();   // handle -> RTCDataChannel
      this._orphans = new Map();    // handle -> [events] that arrived before registration
      this._txs = new Map();        // id -> RTCRtpTransceiver, in creation order
      this._nextTx = 1;
      this._trackStreams = new Map(); // remote msid stream id -> MediaStream
      this._closed = false;
      this._chain = Promise.resolve();
      this._opsPending = 0;
      this._negotiationNeeded = false;
      this._nnFired = false;
      this._pendingDataNegotiation = false;
      const channel = new OrderedChannel((m) => this._onEngine(m));
      this._id = invoke('pc_create', { config: this._config, channel });
      this._id.catch(() => {});
    }

    get localDescription() { return this._local; }
    get remoteDescription() { return this._remote; }
    get currentLocalDescription() { return this._currentLocal; }
    get currentRemoteDescription() { return this._currentRemote; }
    get pendingLocalDescription() { return this.signalingState === 'stable' ? null : this._local; }
    get pendingRemoteDescription() { return this.signalingState === 'stable' ? null : this._remote; }
    get sctp() { return this._remote ? { maxMessageSize: MAX_MESSAGE_SIZE, maxChannels: 65535, state: this.connectionState === 'connected' ? 'connected' : 'connecting', transport: null } : null; }

    getConfiguration() { return { ...this._config }; }
    setConfiguration(c) { if (c && c.iceServers) this._config.iceServers = c.iceServers; }

    _check() { if (this._closed) throw new DOMException('RTCPeerConnection is closed', 'InvalidStateError'); }
    _enqueue(fn) {
      if (this._closed) return Promise.reject(new DOMException('RTCPeerConnection is closed', 'InvalidStateError'));
      this._opsPending++;
      const p = this._chain.then(fn).finally(() => {
        if (--this._opsPending === 0) setTimeout(() => this._maybeFireNegotiationNeeded(), 0);
      });
      this._chain = p.catch(() => {});
      return p;
    }
    _setSignaling(s) {
      if (this.signalingState === s) return;
      this.signalingState = s;
      this.dispatchEvent(new Event('signalingstatechange'));
      if (s === 'stable') { this._negotiationNeeded = false; this._updateNegotiationNeeded(); }
    }

    // ---- negotiation-needed (W3C "check if negotiation is needed") ----
    _hasSctp() {
      const has = (d) => d && /\r?\nm=application /.test('\n' + d.sdp);
      return has(this._currentLocal) || has(this._currentRemote) || has(this._local);
    }
    _needsNegotiation() {
      if (this._pendingDataNegotiation && !this._hasSctp()) return true;
      for (const t of this._txs.values()) {
        if (t._stopping && t._mid && !t._stopped) return true;
        if (t._stopping) continue;
        if (!t._mid) return true;
        if (t._negotiatedDirection !== null && t._direction !== t._negotiatedDirection) return true;
      }
      return false;
    }
    _updateNegotiationNeeded() {
      if (this._closed) return;
      setTimeout(() => this._maybeFireNegotiationNeeded(), 0);
    }
    _maybeFireNegotiationNeeded() {
      if (this._closed || this._opsPending > 0 || this.signalingState !== 'stable') return;
      if (!this._needsNegotiation()) { this._negotiationNeeded = false; this._nnFired = false; return; }
      if (this._negotiationNeeded && this._nnFired) return;
      this._negotiationNeeded = true; this._nnFired = true;
      this.dispatchEvent(new Event('negotiationneeded'));
    }

    // ---- transceivers ----
    _syncTx(t) {
      const spec = t._spec();
      this._enqueue(async () => invoke('pc_upsert_transceiver', { id: await this._id, spec })).catch(() => {});
    }
    _addTransceiverInternal(kind, init) {
      const t = new RTCRtpTransceiver(this, { id: this._nextTx++, kind, ...init });
      this._txs.set(t._id, t);
      this._syncTx(t);
      return t;
    }
    getTransceivers() { return [...this._txs.values()]; }
    getSenders() { return this.getTransceivers().filter((t) => !t._stopped).map((t) => t.sender); }
    getReceivers() { return this.getTransceivers().filter((t) => !t._stopped).map((t) => t.receiver); }

    addTrack(track, ...streams) {
      this._check();
      if (!track || (track.kind !== 'audio' && track.kind !== 'video')) throw new TypeError('addTrack needs a MediaStreamTrack');
      if (this.getSenders().some((s) => s.track === track)) throw new DOMException('track already added', 'InvalidAccessError');
      const streamIds = streams.map((s) => s.id);
      const reuse = this.getTransceivers().find((t) => !t._stopping && t.kind === track.kind && !t.sender.track && !t.sender._everSent
        && !(t._currentDirection && (t._currentDirection === 'sendrecv' || t._currentDirection === 'sendonly')));
      if (reuse) {
        reuse._streamIds = streamIds;
        reuse.sender._setTrack(track);
        if (reuse._direction === 'recvonly') reuse._direction = 'sendrecv';
        else if (reuse._direction === 'inactive') reuse._direction = 'sendonly';
        this._syncTx(reuse); this._updateNegotiationNeeded();
        return reuse.sender;
      }
      const t = this._addTransceiverInternal(track.kind, { direction: 'sendrecv', streamIds, fromAddTrack: true, track });
      this._updateNegotiationNeeded();
      return t.sender;
    }
    removeTrack(sender) {
      this._check();
      const t = this.getTransceivers().find((x) => x.sender === sender);
      if (!t) throw new DOMException('sender does not belong to this connection', 'InvalidAccessError');
      if (!sender.track) return;
      sender._setTrack(null);
      if (t._direction === 'sendrecv') t._direction = 'recvonly';
      else if (t._direction === 'sendonly') t._direction = 'inactive';
      this._syncTx(t); this._updateNegotiationNeeded();
    }
    addTransceiver(trackOrKind, init = {}) {
      this._check();
      const track = typeof trackOrKind === 'string' ? null : trackOrKind;
      const kind = track ? track.kind : trackOrKind;
      if (kind !== 'audio' && kind !== 'video') throw new TypeError(`invalid kind ${kind}`);
      const direction = init.direction || 'sendrecv';
      if (!DIRECTIONS.includes(direction)) throw new TypeError(`invalid direction ${direction}`);
      const streamIds = (init.streams || []).map((s) => s.id);
      const t = this._addTransceiverInternal(kind, { direction, streamIds, fromAddTrack: false, track });
      if (init.sendEncodings && init.sendEncodings.length) t.sender._params.encodings = init.sendEncodings.map((e) => ({ ...e }));
      this._updateNegotiationNeeded();
      return t;
    }

    _stream(id) {
      let s = this._trackStreams.get(id);
      if (!s) {
        s = new MediaStream();
        // matrix-js-sdk keys sdp_stream_metadata on the remote msid stream id.
        Object.defineProperty(s, 'id', { value: id, configurable: true });
        this._trackStreams.set(id, s);
      }
      return s;
    }
    _removeRemoteTrack(t) {
      if (!t._receiving) return;
      t._receiving = false;
      const track = t.receiver.track;
      for (const s of t._recvStreams) {
        if (track) { try { s.removeTrack(track); } catch {} s.dispatchEvent(trackEvent('removetrack', track)); }
      }
      t._recvStreams = [];
    }
    // W3C "process remote tracks" after a remote description is applied.
    _processRemoteTracks() {
      const events = [];
      for (const t of this._txs.values()) {
        if (!t._mid || t._stopping) continue;
        const d = t._remote.dir;
        const sends = d === 'sendrecv' || d === 'sendonly';
        const track = t.receiver.track;
        if (sends && track) {
          const streams = (t._remote.streams.length ? t._remote.streams : []).map((id) => this._stream(id));
          if (!t._receiving) {
            t._receiving = true;
            for (const s of streams) if (!s.getTracks().includes(track)) s.addTrack(track);
            t._recvStreams = streams;
            events.push(new RTCTrackEvent('track', { receiver: t.receiver, track, streams, transceiver: t }));
          } else {
            for (const s of t._recvStreams) if (!streams.includes(s)) { try { s.removeTrack(track); } catch {} s.dispatchEvent(trackEvent('removetrack', track)); }
            for (const s of streams) if (!t._recvStreams.includes(s)) { s.addTrack(track); s.dispatchEvent(trackEvent('addtrack', track)); }
            t._recvStreams = streams;
          }
        } else if (!sends) {
          this._removeRemoteTrack(t);
        }
      }
      for (const e of events) this.dispatchEvent(e);
    }
    _applyStates(states, { remote, answerApplied }) {
      const seen = new Set();
      for (const st of states) {
        seen.add(st.id);
        let t = this._txs.get(st.id);
        if (!t) {
          t = new RTCRtpTransceiver(this, { id: st.id, kind: st.kind, direction: st.direction, streamIds: [], senderTrackId: st.senderTrackId, fromAddTrack: false, createdByRemote: true });
          this._txs.set(st.id, t);
        }
        const wasSending = t._currentDirection === 'sendrecv' || t._currentDirection === 'sendonly';
        t._mid = st.mid;
        if (st.currentDirection === 'stopped') { t._stopped = true; t._stopping = true; }
        else t._currentDirection = st.currentDirection;
        t._remote = { dir: st.remoteDirection, streams: st.remoteStreamIds || [], track: st.remoteTrackId };
        if (answerApplied && t._mid) t._negotiatedDirection = t._direction;
        const sending = t._currentDirection === 'sendrecv' || t._currentDirection === 'sendonly';
        if (sending && !wasSending && t.sender._pipe) t.sender._pipe.forceKey = true;
      }
      for (const [id, t] of this._txs) {
        if (!seen.has(id) && t._createdByRemote) { this._removeRemoteTrack(t); t.receiver._pipe.stop(); this._txs.delete(id); }
      }
      if (remote) this._processRemoteTracks();
    }

    createOffer(options) {
      if (typeof options === 'function') return Promise.reject(new TypeError('legacy callback API is not supported'));
      return this._enqueue(async () => {
        const id = await this._id;
        if (options && options.iceRestart) await invoke('pc_restart_ice', { id });
        return new RTCSessionDescription(await invoke('pc_create_offer', { id }));
      });
    }
    createAnswer(options) {
      if (typeof options === 'function') return Promise.reject(new TypeError('legacy callback API is not supported'));
      return this._enqueue(async () => {
        if (this.signalingState !== 'have-remote-offer' && this.signalingState !== 'have-local-pranswer') {
          throw new DOMException('createAnswer needs a remote offer', 'InvalidStateError');
        }
        return new RTCSessionDescription(await invoke('pc_create_answer', { id: await this._id }));
      });
    }

    setLocalDescription(desc) {
      return this._enqueue(async () => {
        const id = await this._id;
        let d = desc && desc.sdp ? { type: desc.type, sdp: desc.sdp } : null;
        if (desc && desc.type === 'rollback') d = { type: 'rollback', sdp: '' };
        if (!d) {
          const type = desc && desc.type ? desc.type
            : (this.signalingState === 'have-remote-offer' || this.signalingState === 'have-local-pranswer') ? 'answer' : 'offer';
          const made = await invoke(type === 'offer' ? 'pc_create_offer' : 'pc_create_answer', { id });
          d = { type, sdp: made.sdp };
        }
        const states = await invoke('pc_set_local', { id, desc: d });
        if (d.type === 'rollback') {
          const wasRemote = this.signalingState === 'have-remote-offer';
          if (wasRemote) this._remote = this._currentRemote; else this._local = this._currentLocal;
          this._applyStates(states, { remote: wasRemote, answerApplied: false });
          this._setSignaling('stable');
          return;
        }
        if (d.type === 'offer') { this._negotiationNeeded = false; this._nnFired = false; }
        if (/\r?\nm=application /.test('\n' + d.sdp)) this._pendingDataNegotiation = false;
        this._local = new RTCSessionDescription(d);
        this._applyStates(states, { remote: false, answerApplied: d.type === 'answer' });
        if (d.type === 'answer') {
          this._currentLocal = this._local; this._currentRemote = this._remote;
          this._setSignaling('stable');
        } else if (d.type === 'offer') this._setSignaling('have-local-offer');
        else this._setSignaling('have-local-pranswer');
      });
    }

    setRemoteDescription(desc) {
      return this._enqueue(async () => {
        if (!desc || !desc.type) throw new TypeError('description needs a type');
        const d = { type: desc.type, sdp: desc.sdp || '' };
        const id = await this._id;
        if (d.type === 'offer' && this.signalingState === 'have-local-offer') {
          // Implicit rollback (perfect negotiation, polite side).
          this._local = this._currentLocal;
        }
        const states = await invoke('pc_set_remote', { id, desc: d });
        if (d.type === 'rollback') {
          this._remote = this._currentRemote;
          this._applyStates(states, { remote: true, answerApplied: false });
          this._setSignaling('stable');
          return;
        }
        this._remote = new RTCSessionDescription(d);
        if (this.canTrickleIceCandidates === null) this.canTrickleIceCandidates = /a=ice-options:[^\r\n]*trickle/.test(d.sdp);
        if (d.type === 'answer') {
          this._currentLocal = this._local; this._currentRemote = this._remote;
          this._applyStates(states, { remote: true, answerApplied: true });
          this._setSignaling('stable');
        } else if (d.type === 'offer') {
          if (this.signalingState === 'have-local-offer') this.signalingState = 'stable'; // rolled back
          this._applyStates(states, { remote: true, answerApplied: false });
          this._setSignaling('have-remote-offer');
        } else this._setSignaling('have-remote-pranswer');
      });
    }

    addIceCandidate(candidate) {
      return this._enqueue(async () => {
        if (!this._remote) throw new DOMException('addIceCandidate needs a remote description', 'InvalidStateError');
        if (!candidate || !candidate.candidate) return; // end-of-candidates
        const c = candidate instanceof RTCIceCandidate ? candidate.toJSON() : candidate;
        if (c.sdpMid == null && c.sdpMLineIndex == null) throw new TypeError('candidate needs sdpMid or sdpMLineIndex');
        await invoke('pc_add_ice', { id: await this._id, candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } });
      });
    }

    restartIce() {
      if (this._closed) return;
      this._id.then((id) => invoke('pc_restart_ice', { id })).catch(() => {});
      this._restartPending = true;
      // A restart needs an offer even if nothing else changed.
      this._negotiationNeeded = false; this._nnFired = false;
      setTimeout(() => { if (!this._closed && this.signalingState === 'stable') { this._nnFired = true; this.dispatchEvent(new Event('negotiationneeded')); } }, 0);
    }

    createDataChannel(label, init = {}) {
      this._check();
      if (init.maxPacketLifeTime != null && init.maxRetransmits != null) {
        throw new TypeError('maxPacketLifeTime and maxRetransmits are mutually exclusive');
      }
      if (init.negotiated && init.id == null) throw new TypeError('negotiated channels need an id');
      const opts = {
        ordered: init.ordered ?? true,
        maxPacketLifeTime: init.maxPacketLifeTime ?? null,
        maxRetransmits: init.maxRetransmits ?? null,
        protocol: init.protocol ?? '',
        negotiated: !!init.negotiated,
        id: init.id ?? null,
      };
      let resolveHandle, rejectHandle;
      const handle = new Promise((res, rej) => { resolveHandle = res; rejectHandle = rej; });
      handle.catch(() => {});
      const dc = new RTCDataChannel(this, label, opts, handle);
      if (!opts.negotiated && !this._hasSctp()) { this._pendingDataNegotiation = true; this._updateNegotiationNeeded(); }
      // In the operations chain so a following createOffer includes it.
      this._enqueue(async () => {
        const info = await invoke('dc_create', { id: await this._id, label: String(label), init: opts });
        dc._handle = info.handle;
        if (info.id != null) dc.id = info.id;
        this._register(info.handle, dc);
        resolveHandle(info.handle);
      }).catch((e) => { rejectHandle(e); dc._onClose(); });
      return dc;
    }

    _register(handle, dc) {
      this._channels.set(handle, dc);
      const early = this._orphans.get(handle);
      if (early) { this._orphans.delete(handle); early.forEach((m) => this._onEngine(m)); }
    }

    _dc(handle, m) {
      const dc = this._channels.get(handle);
      if (!dc) {
        if (!this._orphans.has(handle)) this._orphans.set(handle, []);
        this._orphans.get(handle).push(m);
      }
      return dc;
    }

    _onEngine(m) {
      if (this._closed) return;
      if (isArrayBuffer(m) || ArrayBuffer.isView(m) || Array.isArray(m)) {
        const bytes = isArrayBuffer(m) ? new Uint8Array(m) : Array.isArray(m) ? Uint8Array.from(m) : new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const handle = dv.getUint32(0, true);
        const kind = bytes[4];
        if (kind === 3) { // decoded audio for a receiver
          const t = this._txs.get(handle);
          if (t && !t._stopping && t.receiver._pipe.pcm) t.receiver._pipe.pcm(bytes.subarray(16));
          return;
        }
        if (kind === 2) { // media frame
          const t = this._txs.get(handle);
          if (t && !t._stopping && bytes[7] === 1) { // our own Opus, for the sender's transform
            t.sender._out({ data: bytes.slice(16), key: true, ts: Number(dv.getBigUint64(8, true)), codec: bytes[6], video: false });
            return;
          }
          if (t && !t._stopping) t.receiver._pipe.frame(bytes[6], (bytes[5] & 1) === 1, Number(dv.getBigUint64(8, true)), bytes.subarray(16));
          return;
        }
        const dc = this._dc(handle, m);
        if (dc) dc._onMessage(kind, bytes.subarray(5));
        return;
      }
      switch (m.type) {
        case 'icecandidate':
          this.dispatchEvent(new RTCPeerConnectionIceEvent('icecandidate', { candidate: m.candidate ? new RTCIceCandidate(m.candidate) : null }));
          break;
        case 'icegatheringstatechange':
          if (this.iceGatheringState !== m.state) { this.iceGatheringState = m.state; this.dispatchEvent(new Event('icegatheringstatechange')); }
          break;
        case 'iceconnectionstatechange':
          if (this.iceConnectionState !== m.state) { this.iceConnectionState = m.state; this.dispatchEvent(new Event('iceconnectionstatechange')); }
          break;
        case 'connectionstatechange':
          if (this.connectionState !== m.state) { this.connectionState = m.state; this.dispatchEvent(new Event('connectionstatechange')); }
          break;
        case 'signalingstatechange':
          break; // tracked in JS so it is correct when each promise resolves
        case 'negotiationneeded':
          this._updateNegotiationNeeded();
          break;
        case 'keyframerequest': {
          const t = this._txs.get(m.tx);
          if (t && t.sender._pipe) t.sender._pipe.forceKey = true;
          break;
        }
        case 'targetbitrate': {
          // Split what remains after audio across active video senders.
          const video = [...this._txs.values()].filter((t) => t.kind === 'video' && t.sender._pipe && t.sender.track && t.sender._pipe.setBitrate);
          const audio = [...this._txs.values()].filter((t) => t.kind === 'audio' && t.sender.track).length;
          const share = Math.max(0, m.bps - audio * 40_000) / Math.max(1, video.length);
          for (const t of video) t.sender._pipe.setBitrate(share);
          this._targetBitrate = m.bps;
          break;
        }
        case 'datachannel': {
          const c = m.channel;
          const dc = new RTCDataChannel(this, c.label, {
            ordered: c.ordered, maxPacketLifeTime: c.maxPacketLifeTime, maxRetransmits: c.maxRetransmits,
            protocol: c.protocol, negotiated: c.negotiated, id: c.id,
          }, c.handle);
          this._register(c.handle, dc);
          this.dispatchEvent(new RTCDataChannelEvent('datachannel', { channel: dc }));
          break;
        }
        case 'dc.open': { const dc = this._dc(m.handle, m); if (dc) dc._onOpen(m.id); break; }
        case 'dc.close': { const dc = this._dc(m.handle, m); if (dc) dc._onClose(); break; }
        case 'dc.error': {
          const dc = this._dc(m.handle, m);
          if (dc) dc.dispatchEvent(Object.assign(new Event('error'), { error: new DOMException(m.message, 'OperationError') }));
          break;
        }
        case 'dc.bufferedamountlow': { const dc = this._dc(m.handle, m); if (dc) dc._refreshBuffered(); break; }
      }
    }

    async getStats(selector) {
      const raw = await invoke('pc_get_stats', { id: await this._id });
      const report = new Map();
      const ts = performance.timeOrigin + performance.now();
      for (const [key, entry] of Object.entries(raw)) {
        const s = { timestamp: ts };
        for (const [k, v] of Object.entries(entry)) s[camel(k)] = v;
        s.id = s.id || key;
        report.set(s.id, s);
      }
      for (const t of this._txs.values()) {
        if (!t._mid) continue;
        if (t.receiver._pipe) report.set(`IN${t._id}`, { id: `IN${t._id}`, type: 'inbound-rtp', kind: t.kind, mid: t._mid, timestamp: ts, trackIdentifier: t.receiver.track && t.receiver.track.id, ...t.receiver._pipe.stats() });
        if (t.sender._pipe) report.set(`OUT${t._id}`, { id: `OUT${t._id}`, type: 'outbound-rtp', kind: t.kind, mid: t._mid, timestamp: ts, ...t.sender._pipe.stats() });
      }
      if (selector) for (const [k, v] of [...report]) if (v.kind && v.kind !== selector.kind) report.delete(k);
      return report;
    }

    close() {
      if (this._closed) return;
      this._closed = true; livePeers.delete(this);
      this.signalingState = 'closed';
      this.iceConnectionState = 'closed';
      this.connectionState = 'closed';
      for (const dc of this._channels.values()) dc.readyState = 'closed';
      for (const t of this._txs.values()) {
        t._stopping = true; t._stopped = true;
        if (t.sender._pipe) t.sender._pipe.stop();
        t.receiver._pipe.stop();
      }
      this._id.then((id) => invoke('pc_close', { id })).catch(() => {});
    }

    static generateCertificate() {
      return Promise.reject(new DOMException('generateCertificate is not supported', 'NotSupportedError'));
    }
  }
  defineHandlers(RTCPeerConnection.prototype, [
    'icecandidate', 'icecandidateerror', 'icegatheringstatechange', 'iceconnectionstatechange',
    'connectionstatechange', 'signalingstatechange', 'negotiationneeded', 'datachannel', 'track',
  ]);

  const expose = {
    RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel,
    RTCPeerConnectionIceEvent, RTCDataChannelEvent, RTCTrackEvent,
    RTCRtpSender, RTCRtpReceiver, RTCRtpTransceiver, RTCDTMFSender, RTCRtpScriptTransform,
  };
  if (TauriWorker) expose.Worker = TauriWorker;
  for (const [name, value] of Object.entries(expose)) {
    Object.defineProperty(window, name, { value, writable: true, configurable: true, enumerable: false });
  }
  Object.defineProperty(window, 'webkitRTCPeerConnection', { value: RTCPeerConnection, writable: true, configurable: true });
  // Marker on the constructor and its prototype (wrappers such as webrtc-adapter
  // replace the constructor but keep the prototype).
  const marker = { level: 'L3', engine: info.engine };
  Object.defineProperty(RTCPeerConnection, '__tauriShim', { value: marker });
  Object.defineProperty(RTCPeerConnection.prototype, '__tauriShim', { value: marker });
})();
