//! WebRTC for Tauri webviews that lack it (WebKitGTK on Linux).
//!
//! Injects a W3C-shaped `RTCPeerConnection` / `RTCDataChannel` shim that is
//! installed only when the webview has no native implementation, and backs it
//! with a pure Rust engine (str0m-based, see `tauri-webrtc-engine`).
//!
//! ```ignore
//! tauri::Builder::default().plugin(tauri_plugin_webrtc::init())
//! ```

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, Runtime, State, Webview};
use tauri_webrtc_engine::*;

const SHIM: &str = include_str!("../guest-js/shim.js");

/// Error returned to the shim, which rethrows it as a `DOMException`.
#[derive(Debug, Serialize)]
pub struct DomError {
    name: &'static str,
    message: String,
}

impl From<Error> for DomError {
    fn from(e: Error) -> Self {
        DomError {
            name: e.dom_name(),
            message: e.to_string(),
        }
    }
}

fn dom(name: &'static str, message: impl Into<String>) -> DomError {
    DomError {
        name,
        message: message.into(),
    }
}

type CmdResult<T> = std::result::Result<T, DomError>;

struct Entry {
    peer: Arc<dyn Peer>,
    webview: String,
}

/// Plugin state: the engine and every live peer connection.
pub struct WebrtcState {
    engine: std::result::Result<Arc<dyn PeerEngine>, String>,
    peers: Mutex<HashMap<u32, Entry>>,
    next_id: AtomicU32,
    max_peers_per_webview: usize,
}

impl WebrtcState {
    fn peer(&self, webview: &str, id: u32) -> CmdResult<Arc<dyn Peer>> {
        let peers = self.peers.lock().unwrap();
        match peers.get(&id) {
            Some(e) if e.webview == webview => Ok(e.peer.clone()),
            _ => Err(dom(
                "InvalidStateError",
                format!("unknown peer connection {id}"),
            )),
        }
    }

    /// Close every peer connection owned by a webview (navigation, reload, destroy).
    fn close_webview(&self, webview: &str) {
        let closing: Vec<Arc<dyn Peer>> = {
            let mut peers = self.peers.lock().unwrap();
            let ids: Vec<u32> = peers
                .iter()
                .filter(|(_, e)| e.webview == webview)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| peers.remove(&id))
                .map(|e| e.peer)
                .collect()
        };
        if !closing.is_empty() {
            log::debug!(
                "closing {} peer connection(s) for webview {webview}",
                closing.len()
            );
            std::thread::spawn(move || closing.iter().for_each(|p| p.close()));
        }
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| dom("OperationError", e.to_string()))?
        .map_err(DomError::from)
}

/// Media frame on the peer's channel:
/// `[u32 LE tx][u8 2][u8 flags: bit0 keyframe][u8 codec][u8 outbound][u64 LE timestamp_us][payload]`.
/// `outbound` 1 marks an engine-encoded frame for a sender in transform mode.
fn media_frame(f: EncodedFrame, outbound: bool) -> Vec<u8> {
    let mut buf = Vec::with_capacity(16 + f.data.len());
    buf.extend_from_slice(&f.tx.to_le_bytes());
    buf.push(2);
    buf.push(f.keyframe as u8);
    buf.push(f.codec.wire_id());
    buf.push(outbound as u8);
    buf.extend_from_slice(&f.timestamp_us.to_le_bytes());
    buf.extend_from_slice(&f.data);
    buf
}

/// Decoded audio on the peer's channel:
/// `[u32 LE tx][u8 3][u8 0][u8 0][u8 0][u64 0][i16 LE samples, 48 kHz mono]`.
fn audio_frame(tx: TxId, samples: &[i16]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(16 + samples.len() * 2);
    buf.extend_from_slice(&tx.to_le_bytes());
    buf.extend_from_slice(&[3, 0, 0, 0]);
    buf.extend_from_slice(&0u64.to_le_bytes());
    for s in samples {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

/// Wire format for data channel messages on the peer's channel:
/// `[u32 LE handle][u8 kind: 0 text, 1 binary][payload]`.
fn frame(handle: DcHandle, payload: Payload) -> Vec<u8> {
    let (kind, bytes) = match payload {
        Payload::Text(s) => (0u8, s.into_bytes()),
        Payload::Binary(b) => (1u8, b),
    };
    let mut buf = Vec::with_capacity(5 + bytes.len());
    buf.extend_from_slice(&handle.to_le_bytes());
    buf.push(kind);
    buf.extend_from_slice(&bytes);
    buf
}

#[tauri::command]
async fn pc_create<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    config: RtcConfiguration,
    channel: Channel<InvokeResponseBody>,
) -> CmdResult<u32> {
    let engine = state
        .engine
        .clone()
        .map_err(|e| dom("NotSupportedError", e))?;
    let label = webview.label().to_string();
    {
        let peers = state.peers.lock().unwrap();
        if peers.values().filter(|e| e.webview == label).count() >= state.max_peers_per_webview {
            return Err(dom(
                "OperationError",
                "too many peer connections for this webview",
            ));
        }
    }
    // One ordered channel carries both JSON events and raw message frames,
    // so a data channel's `open` can never overtake its first message.
    let sink: EventSink = Arc::new(move |e: PeerEvent| {
        let body = match e {
            PeerEvent::DcMessage { handle, payload } => {
                InvokeResponseBody::Raw(frame(handle, payload))
            }
            PeerEvent::MediaFrame(f) => InvokeResponseBody::Raw(media_frame(f, false)),
            PeerEvent::EncodedOut(f) => InvokeResponseBody::Raw(media_frame(f, true)),
            PeerEvent::AudioPcm { tx, samples } => {
                InvokeResponseBody::Raw(audio_frame(tx, &samples))
            }
            other => match serde_json::to_string(&other) {
                Ok(s) => InvokeResponseBody::Json(s),
                Err(err) => {
                    log::warn!("event serialise: {err}");
                    return;
                }
            },
        };
        let _ = channel.send(body);
    });
    let peer: Arc<dyn Peer> =
        blocking(move || engine.create_peer(&config, sink).map(Arc::from)).await?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.peers.lock().unwrap().insert(
        id,
        Entry {
            peer,
            webview: label,
        },
    );
    Ok(id)
}

#[tauri::command]
async fn pc_create_offer<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
) -> CmdResult<SessionDescription> {
    let p = state.peer(webview.label(), id)?;
    blocking(move || p.create_offer()).await
}

#[tauri::command]
async fn pc_create_answer<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
) -> CmdResult<SessionDescription> {
    let p = state.peer(webview.label(), id)?;
    blocking(move || p.create_answer()).await
}

#[tauri::command]
async fn pc_set_local<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    desc: SessionDescription,
) -> CmdResult<Vec<TransceiverState>> {
    let p = state.peer(webview.label(), id)?;
    blocking(move || p.set_local_description(&desc)).await
}

#[tauri::command]
async fn pc_set_remote<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    desc: SessionDescription,
) -> CmdResult<Vec<TransceiverState>> {
    let p = state.peer(webview.label(), id)?;
    blocking(move || p.set_remote_description(&desc)).await
}

#[tauri::command]
async fn pc_add_ice<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    candidate: IceCandidate,
) -> CmdResult<()> {
    let p = state.peer(webview.label(), id)?;
    blocking(move || p.add_ice_candidate(&candidate)).await
}

#[tauri::command]
async fn pc_get_stats<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
) -> CmdResult<serde_json::Value> {
    let p = state.peer(webview.label(), id)?;
    blocking(move || p.stats()).await
}

#[tauri::command]
async fn pc_close<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
) -> CmdResult<()> {
    let removed = {
        let mut peers = state.peers.lock().unwrap();
        match peers.get(&id) {
            Some(e) if e.webview == webview.label() => peers.remove(&id),
            _ => None,
        }
    };
    if let Some(e) = removed {
        blocking(move || {
            e.peer.close();
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
async fn dc_create<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    label: String,
    init: DataChannelInit,
) -> CmdResult<DataChannelInfo> {
    let p = state.peer(webview.label(), id)?;
    blocking(move || p.create_data_channel(&label, &init)).await
}

fn header<T: std::str::FromStr>(req: &Request<'_>, name: &str) -> CmdResult<T> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| dom("TypeError", format!("missing or invalid header {name}")))
}

/// Parse a batch of outgoing messages: repeated `[u8 kind][u32 LE len][bytes]`.
fn parse_batch(mut body: &[u8]) -> CmdResult<Vec<Payload>> {
    let mut out = Vec::new();
    while !body.is_empty() {
        if body.len() < 5 {
            return Err(dom("TypeError", "truncated dc_send batch"));
        }
        let kind = body[0];
        let len = u32::from_le_bytes([body[1], body[2], body[3], body[4]]) as usize;
        let rest = &body[5..];
        if rest.len() < len {
            return Err(dom("TypeError", "truncated dc_send record"));
        }
        let bytes = rest[..len].to_vec();
        out.push(match kind {
            0 => Payload::Text(
                String::from_utf8(bytes)
                    .map_err(|_| dom("TypeError", "text payload is not UTF-8"))?,
            ),
            _ => Payload::Binary(bytes),
        });
        body = &rest[len..];
    }
    Ok(out)
}

/// Send a batch of messages on one data channel, in order.
///
/// Raw body: see [`parse_batch`]. Headers: `x-pc`, `x-dc`. The shim keeps
/// one call in flight per channel and batches behind it, because concurrent
/// IPC calls are not guaranteed to complete in order.
#[tauri::command]
async fn dc_send<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    request: Request<'_>,
) -> CmdResult<u64> {
    let id: u32 = header(&request, "x-pc")?;
    let handle: DcHandle = header(&request, "x-dc")?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err(dom("TypeError", "dc_send expects a raw body"));
    };
    let batch = parse_batch(body)?;
    let p = state.peer(webview.label(), id)?;
    // The engine's send only queues a command; no need for the blocking pool.
    for payload in batch {
        p.dc_send(handle, payload)?;
    }
    // Report the engine-side buffer so the shim can keep bufferedAmount honest.
    p.dc_buffered_amount(handle).map_err(DomError::from)
}

#[tauri::command]
async fn pc_upsert_transceiver<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    spec: TransceiverSpec,
) -> CmdResult<()> {
    let p = state.peer(webview.label(), id)?;
    blocking(move || p.upsert_transceiver(spec)).await
}

#[tauri::command]
async fn pc_insert_dtmf<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    tx: TxId,
    event: u8,
    duration_ms: u32,
) -> CmdResult<()> {
    state
        .peer(webview.label(), id)?
        .insert_dtmf(tx, event, duration_ms)
        .map_err(DomError::from)
}

#[tauri::command]
async fn pc_set_transform<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    tx: TxId,
    send: bool,
    recv: bool,
) -> CmdResult<()> {
    state
        .peer(webview.label(), id)?
        .set_transform(tx, send, recv)
        .map_err(DomError::from)
}

#[tauri::command]
async fn pc_audio_processing<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    tx: TxId,
    echo_cancellation: bool,
    noise_suppression: bool,
    auto_gain_control: bool,
) -> CmdResult<()> {
    state
        .peer(webview.label(), id)?
        .set_audio_processing(tx, echo_cancellation, noise_suppression, auto_gain_control)
        .map_err(DomError::from)
}

#[tauri::command]
async fn pc_request_keyframe<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    tx: TxId,
) -> CmdResult<()> {
    state
        .peer(webview.label(), id)?
        .request_keyframe(tx)
        .map_err(DomError::from)
}

#[tauri::command]
async fn pc_restart_ice<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
) -> CmdResult<()> {
    state
        .peer(webview.label(), id)?
        .restart_ice()
        .map_err(DomError::from)
}

/// Encoded frames from the page (its encoder, or its transform). Headers:
/// `x-pc`, `x-tx`, `x-codec` (wire id), and `x-dir: recv` for received
/// frames coming back from a transform for engine decoding. Raw body: frames
/// back to back, each `[u8 keyframe][u64 LE timestamp_us][u32 LE len][bytes]`.
/// One call carries whatever queued up, so IPC latency cannot throttle the
/// frame rate.
#[tauri::command]
async fn media_push<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    request: Request<'_>,
) -> CmdResult<()> {
    let id: u32 = header(&request, "x-pc")?;
    let tx: TxId = header(&request, "x-tx")?;
    let codec: u8 = header(&request, "x-codec")?;
    let codec = CodecName::from_wire_id(codec).ok_or_else(|| dom("TypeError", "unknown codec"))?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err(dom("TypeError", "media_push expects a raw body"));
    };
    let recv = request
        .headers()
        .get("x-dir")
        .map(|v| v == "recv")
        .unwrap_or(false);
    let p = state.peer(webview.label(), id)?;
    let mut rest = &body[..];
    while !rest.is_empty() {
        if rest.len() < 13 {
            return Err(dom("TypeError", "truncated media frame header"));
        }
        let key = rest[0] == 1;
        let ts = u64::from_le_bytes(rest[1..9].try_into().expect("8 bytes"));
        let len = u32::from_le_bytes(rest[9..13].try_into().expect("4 bytes")) as usize;
        let Some(data) = rest.get(13..13 + len) else {
            return Err(dom("TypeError", "truncated media frame"));
        };
        rest = &rest[13 + len..];
        if recv {
            // A received frame back from the page's transform, for engine decode.
            p.decode_audio(tx, data.to_vec()).map_err(DomError::from)?;
        } else {
            p.send_frame(EncodedFrame {
                tx,
                codec,
                keyframe: key,
                timestamp_us: ts,
                data: data.into(),
            })
            .map_err(DomError::from)?;
        }
    }
    Ok(())
}

/// Captured PCM for an audio sender. Raw body: i16 LE, 48 kHz mono.
/// Headers: `x-pc`, `x-tx`.
#[tauri::command]
async fn audio_push<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    request: Request<'_>,
) -> CmdResult<()> {
    let id: u32 = header(&request, "x-pc")?;
    let tx: TxId = header(&request, "x-tx")?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err(dom("TypeError", "audio_push expects a raw body"));
    };
    let samples: Vec<i16> = body
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    state
        .peer(webview.label(), id)?
        .push_pcm(tx, samples)
        .map_err(DomError::from)
}

#[tauri::command]
async fn dc_close<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    handle: DcHandle,
) -> CmdResult<()> {
    state
        .peer(webview.label(), id)?
        .dc_close(handle)
        .map_err(DomError::from)
}

#[tauri::command]
async fn dc_buffered_amount<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    handle: DcHandle,
) -> CmdResult<u64> {
    state
        .peer(webview.label(), id)?
        .dc_buffered_amount(handle)
        .map_err(DomError::from)
}

#[tauri::command]
async fn dc_set_threshold<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, WebrtcState>,
    id: u32,
    handle: DcHandle,
    threshold: u64,
) -> CmdResult<()> {
    state
        .peer(webview.label(), id)?
        .dc_set_buffered_amount_low_threshold(handle, threshold)
        .map_err(DomError::from)
}

/// Plugin configuration.
pub struct Builder {
    force_shim: bool,
    max_peers_per_webview: usize,
    engine: Option<Arc<dyn PeerEngine>>,
}

impl Default for Builder {
    fn default() -> Self {
        Self {
            force_shim: false,
            max_peers_per_webview: 16,
            engine: None,
        }
    }
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Install the shim even when the webview has a native `RTCPeerConnection`.
    /// For testing the shim on webviews that already support WebRTC.
    pub fn force_shim(mut self, force: bool) -> Self {
        self.force_shim = force;
        self
    }

    /// Cap on concurrent peer connections per webview. Default 16.
    pub fn max_peers_per_webview(mut self, n: usize) -> Self {
        self.max_peers_per_webview = n;
        self
    }

    /// Use a different engine than the default (native, pure Rust) one.
    pub fn engine(mut self, engine: Arc<dyn PeerEngine>) -> Self {
        self.engine = Some(engine);
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let engine: std::result::Result<Arc<dyn PeerEngine>, String> = match self.engine {
            Some(e) => Ok(e),
            None => default_engine(),
        };
        if let Err(e) = &engine {
            log::warn!("tauri-plugin-webrtc: engine unavailable, shim disabled: {e}");
        }
        let info = serde_json::json!({
            "available": engine.is_ok(),
            "engine": engine.as_ref().map(|e| e.name()).ok(),
            "error": engine.as_ref().err(),
            "force": self.force_shim,
        });
        let script = format!("window.__TAURI_WEBRTC__ = {info};\n{SHIM}");
        let max = self.max_peers_per_webview;
        let engine = Mutex::new(Some(engine));

        PluginBuilder::new("webrtc")
            // All frames: Element Call runs in a same-origin widget iframe.
            .js_init_script_on_all_frames(script)
            .invoke_handler(tauri::generate_handler![
                pc_create,
                pc_create_offer,
                pc_create_answer,
                pc_set_local,
                pc_set_remote,
                pc_add_ice,
                pc_get_stats,
                pc_close,
                pc_upsert_transceiver,
                pc_request_keyframe,
                pc_set_transform,
                pc_insert_dtmf,
                pc_audio_processing,
                pc_restart_ice,
                media_push,
                audio_push,
                dc_create,
                dc_send,
                dc_close,
                dc_buffered_amount,
                dc_set_threshold,
            ])
            .setup(move |app, _api| {
                let engine = engine.lock().unwrap().take().expect("setup runs once");
                app.manage(WebrtcState {
                    engine,
                    peers: Mutex::new(HashMap::new()),
                    next_id: AtomicU32::new(1),
                    max_peers_per_webview: max,
                });
                Ok(())
            })
            .on_page_load(|webview, payload| {
                if payload.event() == PageLoadEvent::Started {
                    webview
                        .state::<WebrtcState>()
                        .close_webview(webview.label());
                }
            })
            .on_event(|app, event| {
                // A destroyed window takes its webview (same label) with it.
                if let tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } = event
                {
                    app.state::<WebrtcState>().close_webview(label);
                }
            })
            .on_drop(|app| {
                let state = app.state::<WebrtcState>();
                let all: Vec<Arc<dyn Peer>> = state
                    .peers
                    .lock()
                    .unwrap()
                    .drain()
                    .map(|(_, e)| e.peer)
                    .collect();
                all.iter().for_each(|p| p.close());
            })
            .build()
    }
}

#[cfg(target_os = "linux")]
fn default_engine() -> std::result::Result<Arc<dyn PeerEngine>, String> {
    tauri_webrtc_engine::native::NativeEngine::new()
        .map(|e| Arc::new(e) as Arc<dyn PeerEngine>)
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn default_engine() -> std::result::Result<Arc<dyn PeerEngine>, String> {
    Err("no default engine on this platform; the webview has native WebRTC".into())
}

/// Plugin with default settings.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::default().build()
}
