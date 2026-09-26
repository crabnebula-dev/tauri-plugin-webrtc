# tauri-plugin-webrtc

WebRTC for Tauri apps on Linux, without CEF. WebKitGTK ships no `RTCPeerConnection`
(2.52 and 2.54 tested). This plugin injects a standards-shaped JS shim, installed
only when the webview lacks native WebRTC, and backs it with GStreamer `webrtcbin`.

Status: fidelity level **L1** (peer connections, data channels). Media tracks throw
`NotSupportedError` until L2. See the design spec for the roadmap.

## Use

```rust
tauri::Builder::default().plugin(tauri_plugin_webrtc::init())
```

Capability: `"webrtc:default"` (peer connections and data channels, no capture).

Runtime packages (Debian/Ubuntu): `gstreamer1.0-plugins-bad`, `gstreamer1.0-nice`,
`gstreamer1.0-plugins-good`. If any element is missing the shim stays off and the
reason is logged.

## Layout

- `crates/engine`: `PeerEngine` trait and the `webrtcbin` adapter.
- `plugin`: Tauri plugin, commands, and `guest-js/shim.js`.
- `examples/e2e-app`: Tauri app used by the end-to-end test.
- `tests`: Node harnesses (Playwright + Chromium).

## Test

```sh
cargo test -p tauri-webrtc-engine                 # includes webrtcbin loopback
cargo build -p tauri-webrtc-engine --example stdio_peer -p e2e-app
cd tests && npm install
node engine-chromium.mjs [--mdns]                 # engine <-> Chromium
node shim-e2e.mjs [--mdns]                        # WebKitGTK shim <-> Chromium, both roles
```
