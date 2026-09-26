// Keep every peer connection so the LiveKit scenario can dump raw RTP stats.
// Call before livekit-client creates connections (idempotent).
function lkRecordPcs() {
  window.__pcs = window.__pcs || [];
  const P = window.RTCPeerConnection;
  if (!P || P.__recording) return;
  const proxy = new Proxy(P, { construct(t, a, nt) { const pc = Reflect.construct(t, a, nt); window.__pcs.push(pc); return pc; } });
  Object.defineProperty(proxy, '__recording', { value: true });
  window.RTCPeerConnection = proxy;
}
lkRecordPcs();
