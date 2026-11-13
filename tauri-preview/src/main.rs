#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};

#[tauri::command]
fn preview_state() -> Value {
    json!({
        "connected": true,
        "device": "Tauri 미리보기",
        "profile": {"provider": "synology", "url": "https://nas.example.test", "user": "demo"},
        "settings": {
            "remote": "", "local": "", "interval": 5, "automatic": false,
            "layout": {"version": 1, "links": {}, "shortcuts": []},
            "areas": [{
                "id": "preview", "name": "샘플 동기화 영역", "source": "nas",
                "remote": "/Shared", "automatic": false,
                "last": {"fileCount": 2, "files": ["README.txt", "media/demo.txt"]}
            }]
        },
        "runningAreas": []
    })
}

#[tauri::command]
fn preview_files(folder: &str) -> Vec<Value> {
    match folder {
        "/" => vec![json!({"name": "Shared", "path": "/Shared", "directory": true})],
        "/Shared" => vec![
            json!({"name": "media", "path": "/Shared/media", "directory": true}),
            json!({"name": "README.txt", "path": "/Shared/README.txt", "directory": false, "size": 128})
        ],
        "/Shared/media" => vec![json!({"name": "demo.txt", "path": "/Shared/media/demo.txt", "directory": false, "size": 96})],
        _ => Vec::new(),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![preview_state, preview_files])
        .run(tauri::generate_context!())
        .expect("failed to start the sonac launcher Tauri preview");
}
