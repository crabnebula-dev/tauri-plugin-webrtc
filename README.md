# tauri-plugin-webrtc

WebRTC for Tauri apps on Linux, without CEF. WebKitGTK ships no `RTCPeerConnection`
(2.52 and 2.54 tested). This plugin injects a standards-shaped JS shim, installed
only when the webview lacks native WebRTC. A pure Rust engine sits behind it: no
GStreamer WebRTC elements, no libwebrtc, no system packages beyond what WebKitGTK
already needs.

The target is a Matrix client such as [Tchap](https://github.com/tchapgouv/tchap-desktop):
1:1 calls through matrix-js-sdk, and group calls through Element Call on LiveKit,
with end-to-end encryption.

## Use

```rust
tauri::Builder::default().plugin(tauri_plugin_webrtc::init())
```

Capability: `"webrtc:default"` (peer connections, data channels, media transport).
Camera, microphone and screen capture stay under the webview's own permission
handling.

The shim runs in every same-origin frame, so an embedded Element Call widget gets
WebRTC too. Cross-origin frames get nothing.

## What is covered

| Area | Status |
| --- | --- |
| `RTCPeerConnection` JSEP | Offers, answers, renegotiation, implicit and explicit rollback (perfect negotiation), re-offers of an unchanged session, `restartIce()` |
| ICE | Host, mDNS `.local` resolution, STUN, TURN over UDP (long-term credentials, channels), relay-only policy |
| Data channels | Reliable and unreliable, ordered and unordered, negotiated ids, `bufferedAmount` and low-threshold events |
| Transceivers | W3C `addTrack` reuse, `removeTrack`, `addTransceiver`, directions, `currentDirection`, `replaceTrack`, `setCodecPreferences`, msid stream ids |
| Audio | Opus, echo cancellation (AEC3), noise suppression and AGC in the engine, one playout clock for all receivers, adaptive jitter buffer, in-band FEC |
| Video | VP8 both ways via WebCodecs in the page, keyframe requests, bandwidth estimate drives bitrate and resolution, screen-share profile (1080p, 15 fps) |
| Simulcast | Send side sends one layer, the best active encoding |
| Encoded transforms | `RTCRtpScriptTransform` (LiveKit E2EE), audio and video, send and receive |
| Stats | `getStats()` with candidate pairs, `inbound-rtp` and `outbound-rtp` |
| Not yet | DTMF (`canInsertDTMF` is false), TURN over TCP/TLS, H.264/VP9/AV1 send, receive-side simulcast layers |

### How media flows

- Video: the page captures frames from a hidden `<video>`, encodes VP8 with
  WebCodecs and hands encoded frames to the engine. Received frames are decoded
  with WebCodecs and drawn into a canvas whose `captureStream()` is the remote track.
- Audio: AudioWorklets move raw PCM between the page and the engine. The engine
  runs the audio processing, Opus and the playout clock.
- All engine traffic for one peer connection uses one ordered Tauri channel.

### Content Security Policy

The AudioWorklet and the worker polyfill load from `blob:` URLs. Under a CSP
without `blob:` in `script-src` (Tchap's main window, for one):

- audio switches to `ScriptProcessorNode`s with the same logic;
- workers are not wrapped and `RTCRtpScriptTransform` is withdrawn, so encoded
  transforms are unavailable in that document. Element Call's own iframe has no
  such CSP and keeps E2EE.

## Engine

`crates/engine` is sans-I/O WebRTC from [str0m](https://github.com/algesten/str0m)
driven by tokio, with:

- [rusty-opus](https://crates.io/crates/rusty-opus) for Opus (pure Rust);
- [sonora](https://crates.io/crates/sonora) for AEC3, noise suppression and AGC2
  (pure Rust port of the WebRTC audio processing module);
- our own STUN/TURN client, mDNS resolver and JSEP layer.

`vendor/str0m` is str0m 0.24.0 with small patches (VP8 PictureID for SFUs, JSEP
re-offers), and `vendor/str0m-rust-crypto` builds the DTLS certificate with
RustCrypto, so no C crypto library (AWS-LC) is compiled in. The engine's
dependency tree has no `-sys` crates. See `vendor/str0m/PATCHES.md`. Minimum
Rust: 1.91.

`sbom/` holds CycloneDX SBOMs of the engine and the plugin (`cargo cyclonedx`).

## Layout

- `crates/engine`: `PeerEngine` trait and the native engine.
- `plugin`: Tauri plugin, commands, and `guest-js/shim.js`.
- `examples/e2e-app`: Tauri app used by the end-to-end tests.
- `tests`: Node harnesses (Playwright with Chromium as the other peer).
- `vendor/str0m`, `vendor/str0m-rust-crypto`: patched str0m.
- `sbom`: CycloneDX SBOMs.

## Test

```sh
cargo test -p tauri-webrtc-engine                 # JSEP, media, TURN codec, audio processing
cd tests && npm install
node matrix/build.mjs                             # bundles matrix-js-sdk for the Matrix test
mkdir -p ../examples/e2e-app/dist/lk && cp node_modules/livekit-client/dist/livekit-client.{umd.js,e2ee.worker.mjs} ../examples/e2e-app/dist/lk/
cargo build --release -p e2e-app
APP=../target/release/e2e-app
node shim-e2e.mjs --app $APP                      # p2p: data, video, audio, both roles
node shim-e2e.mjs --app $APP --page index-csp.html  # same, under Tchap's CSP
node livekit-e2e.mjs --app $APP [--iframe]        # LiveKit room, plain and E2EE (LIVEKIT_SERVER)
node matrix-e2e.mjs --app $APP                    # matrix-js-sdk 1:1 calls (SYNAPSE_PY)
```

The harnesses also drive a Tchap build that carries the test hook: point `--app`
at it, and add `--tchap` for the LiveKit and Matrix tests.

The LiveKit test needs a `livekit-server` binary. The Matrix test runs Synapse as
a fixture; `SYNAPSE_PY` points at a Python with `matrix-synapse` installed.
