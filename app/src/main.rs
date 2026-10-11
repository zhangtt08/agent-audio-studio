#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use agentaudio_core::{http, session};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;

struct AppState {
    root: PathBuf,
    port: std::sync::Mutex<u16>,
}

/// One command carries the entire product: the webview calls the same RPC the
/// agent calls, so there is no second implementation to keep in sync.
#[tauri::command]
async fn rpc(
    state: tauri::State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, Value> {
    let root = state.root.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        agentaudio_core::rpc::call_in(&method, &params, &agentaudio_core::rpc::Ctx { root: Some(root), via: "ui" })
    })
    .await;
    match task {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(agentaudio_core::rpc::util_err(&e)),
        Err(e) => Err(json!({ "e": e.to_string(), "code": "join" })),
    }
}

#[tauri::command]
fn endpoint(state: tauri::State<'_, AppState>) -> Value {
    let port = *state.port.lock().unwrap();
    json!({ "port": port, "base": format!("http://127.0.0.1:{}", port) })
}

fn main() {
    let root = session::workspace();
    let _ = std::fs::create_dir_all(&root);
    let setup_root = root.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            root,
            port: std::sync::Mutex::new(http::DEFAULT_PORT),
        })
        .setup(move |app| {
            // The UI streams audio and subtitles over HTTP, so the window is
            // built here (not in tauri.conf.json) to hand it the bound port
            // before any page script runs.
            let mut bound = http::DEFAULT_PORT;
            for p in http::DEFAULT_PORT..http::DEFAULT_PORT + 8 {
                if let Ok(got) = http::start(p, Some(setup_root.clone())) {
                    bound = got;
                    break;
                }
            }
            {
                let st = app.state::<AppState>();
                *st.port.lock().unwrap() = bound;
            }
            let win = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("AgentAudio")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1100.0, 720.0)
                .center()
                .resizable(true)
                .decorations(false)
                .initialization_script(&format!("window.__AA_PORT__ = {};", bound))
                .build()?;
            let _ = win;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc, endpoint])
        .run(tauri::generate_context!())
        .expect("AgentAudio failed to start");
}
