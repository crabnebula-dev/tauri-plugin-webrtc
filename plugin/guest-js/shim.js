// tauri-plugin-webrtc JS shim (fidelity level L1: peer connections + data channels).
//
// Installed only when the webview has no native RTCPeerConnection (or when the
// plugin was built with force_shim). Every object is a handle to a resource in
// the Rust engine. Plain ES2020, no dependencies, runs before page scripts.
(() => {
  'use strict';
  const info = window.__TAURI_WEBRTC__ || {};
  const T = window.__TAURI_INTERNALS__;
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
      else if (data instanceof ArrayBuffer) { kind = 1; bytes = new Uint8Array(data.slice(0)); }
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

  class RTCPeerConnection extends EventTarget {
    constructor(configuration = {}) {
      super();
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
      this._closed = false;
      this._chain = Promise.resolve();
      this._negotiationNeeded = false;
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
      this._opsPending = (this._opsPending || 0) + 1;
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
      if (s === 'stable' && this._pendingDataNegotiation && !this._hasSctp()) {
        this._negotiationNeeded = false;
        this._updateNegotiationNeeded();
      }
    }

    // webrtcbin does not emit negotiation-needed for data channels, so apply
    // the W3C rule here: the first channel on a connection without an
    // application m-line needs negotiation, fired once the chain is idle and
    // signaling is stable.
    _hasSctp() {
      const has = (d) => d && /\r?\nm=application /.test("\n" + d.sdp);
      return has(this._currentLocal) || has(this._currentRemote) || has(this._local);
    }
    _updateNegotiationNeeded() {
      if (this._closed || this._negotiationNeeded) return;
      this._negotiationNeeded = true;
      this._nnFired = false;
      setTimeout(() => this._maybeFireNegotiationNeeded(), 0);
    }
    _maybeFireNegotiationNeeded() {
      if (this._closed || !this._negotiationNeeded || this._nnFired) return;
      if (this._opsPending > 0 || this.signalingState !== "stable") return;
      this._nnFired = true;
      this.dispatchEvent(new Event("negotiationneeded"));
    }

    createOffer(options) {
      if (typeof options === 'function') return Promise.reject(new TypeError('legacy callback API is not supported'));
      return this._enqueue(async () => new RTCSessionDescription(await invoke('pc_create_offer', { id: await this._id })));
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
        if (!d) {
          const type = desc && desc.type ? desc.type
            : (this.signalingState === 'have-remote-offer' || this.signalingState === 'have-local-pranswer') ? 'answer' : 'offer';
          const made = await invoke(type === 'offer' ? 'pc_create_offer' : 'pc_create_answer', { id });
          d = { type, sdp: made.sdp };
        }
        if (d.type === 'rollback') throw new DOMException('rollback is not supported', 'NotSupportedError');
        await invoke('pc_set_local', { id, desc: d });
        if (d.type === 'offer') { this._negotiationNeeded = false; this._nnFired = false; }
        if (/\r?\nm=application /.test('\n' + d.sdp)) this._pendingDataNegotiation = false;
        this._local = new RTCSessionDescription(d);
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
        if (desc.type === 'rollback') throw new DOMException('rollback is not supported', 'NotSupportedError');
        const d = { type: desc.type, sdp: desc.sdp || '' };
        await invoke('pc_set_remote', { id: await this._id, desc: d });
        this._remote = new RTCSessionDescription(d);
        if (this.canTrickleIceCandidates === null) this.canTrickleIceCandidates = /a=ice-options:[^\r\n]*trickle/.test(d.sdp);
        if (d.type === 'answer') {
          this._currentLocal = this._local; this._currentRemote = this._remote;
          this._setSignaling('stable');
        } else if (d.type === 'offer') this._setSignaling('have-remote-offer');
        else this._setSignaling('have-remote-pranswer');
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
      if (m instanceof ArrayBuffer || ArrayBuffer.isView(m) || Array.isArray(m)) {
        const bytes = m instanceof ArrayBuffer ? new Uint8Array(m) : Array.isArray(m) ? Uint8Array.from(m) : new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
        const handle = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
        const dc = this._dc(handle, m);
        if (dc) dc._onMessage(bytes[4], bytes.subarray(5));
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

    async getStats() {
      const raw = await invoke('pc_get_stats', { id: await this._id });
      const report = new Map();
      for (const [key, entry] of Object.entries(raw)) {
        const s = {};
        for (const [k, v] of Object.entries(entry)) s[camel(k)] = v;
        s.id = s.id || key;
        report.set(s.id, s);
      }
      return report;
    }

    getSenders() { return []; }
    getReceivers() { return []; }
    getTransceivers() { return []; }
    addTrack() { throw new DOMException('media tracks are not supported by this shim yet (fidelity level L1)', 'NotSupportedError'); }
    addTransceiver() { throw new DOMException('transceivers are not supported by this shim yet (fidelity level L1)', 'NotSupportedError'); }
    removeTrack() { throw new DOMException('media tracks are not supported by this shim yet (fidelity level L1)', 'NotSupportedError'); }
    restartIce() {}

    close() {
      if (this._closed) return;
      this._closed = true;
      this.signalingState = 'closed';
      this.iceConnectionState = 'closed';
      this.connectionState = 'closed';
      for (const dc of this._channels.values()) dc.readyState = 'closed';
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
    RTCPeerConnectionIceEvent, RTCDataChannelEvent,
  };
  for (const [name, value] of Object.entries(expose)) {
    Object.defineProperty(window, name, { value, writable: true, configurable: true, enumerable: false });
  }
  Object.defineProperty(window, 'webkitRTCPeerConnection', { value: RTCPeerConnection, writable: true, configurable: true });
  Object.defineProperty(RTCPeerConnection, '__tauriShim', { value: { level: 'L1', engine: info.engine } });
})();
