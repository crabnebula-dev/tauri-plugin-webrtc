//! End-to-end harness app: mirrors how Tchap desktop builds its window.
use tauri::{utils::config::WebviewUrl, webview::WebviewWindowBuilder};

fn main() {
    env_logger::init();
    let ws = std::env::var("E2E_WS").unwrap_or_else(|_| "ws://127.0.0.1:9777".into());
    // Harness name of this instance (two apps can join one run).
    let name = std::env::var("E2E_NAME").unwrap_or_else(|_| "webkit".into());
    tauri::Builder::default()
        .plugin(tauri_plugin_webrtc::init())
        .setup(move |app| {
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App(
                    std::env::var("E2E_PAGE")
                        .unwrap_or_else(|_| "index.html".into())
                        .into(),
                ),
            )
            .initialization_script(format!(
                "window.__E2E_WS__ = {}; window.__E2E_NAME__ = {};",
                serde_json::json!(ws),
                serde_json::json!(name)
            ))
            .title("webrtc-e2e")
            .inner_size(800.0, 600.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running e2e app");
}
