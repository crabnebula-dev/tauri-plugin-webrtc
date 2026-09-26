//! End-to-end harness app: mirrors how Tchap desktop builds its window.
use tauri::{utils::config::WebviewUrl, webview::WebviewWindowBuilder};

fn main() {
    env_logger::init();
    let ws = std::env::var("E2E_WS").unwrap_or_else(|_| "ws://127.0.0.1:9777".into());
    tauri::Builder::default()
        .plugin(tauri_plugin_webrtc::init())
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App(std::env::var("E2E_PAGE").unwrap_or_else(|_| "index.html".into()).into()))
                .initialization_script(format!("window.__E2E_WS__ = {};", serde_json::json!(ws)))
                .title("webrtc-e2e")
                .inner_size(800.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running e2e app");
}
