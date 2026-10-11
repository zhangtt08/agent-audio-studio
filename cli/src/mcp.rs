//! MCP over stdio. Hand-rolled JSON-RPC 2.0: one line in, one line out, no
//! framework, no async runtime, ~40 KB of binary.

use agentaudio_core::{rpc, util};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

const SUPPORTED: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

pub fn serve(root: Option<PathBuf>) -> i32 {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let ctx = rpc::Ctx { root, ..Default::default() };
    for line in stdin.lock().lines() {
        let l = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if l.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&l) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(
                    out,
                    "{}",
                    json!({ "jsonrpc": "2.0", "id": Value::Null, "error": { "code": -32700, "message": e.to_string() } })
                );
                let _ = out.flush();
                continue;
            }
        };
        // a notification has no id and must not be answered
        let id = match v.get("id") {
            Some(x) if !x.is_null() => x.clone(),
            _ => continue,
        };
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = v.get("params").cloned().unwrap_or_else(|| json!({}));
        let msg = json!({ "jsonrpc": "2.0", "id": id });
        let mut obj = match msg.as_object() {
            Some(o) => o.clone(),
            None => serde_json::Map::new(),
        };
        match route(method, &params, &ctx) {
            Ok(r) => {
                obj.insert("result".into(), r);
            }
            Err((code, msg)) => {
                obj.insert("error".into(), json!({ "code": code, "message": msg }));
            }
        }
        let _ = writeln!(out, "{}", Value::Object(obj));
        let _ = out.flush();
    }
    0
}

fn route(m: &str, p: &Value, ctx: &rpc::Ctx) -> Result<Value, (i32, String)> {
    match m {
        "initialize" => {
            let want = p.get("protocolVersion").and_then(|x| x.as_str()).unwrap_or(SUPPORTED[0]);
            let pv = if SUPPORTED.contains(&want) { want } else { SUPPORTED[0] };
            Ok(json!({
                "protocolVersion": pv,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "agentaudio", "version": crate::core_version(), "title": "AgentAudio" },
                "instructions": "Audio runtime for agents. fit=make audio match a video's length, extract=audio out of video, fx/preset=one-word processing, batch=N calls in one round trip. Durations are seconds, levels dB. Errors are {e,code,hint}. Call caps once instead of reading every schema."
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": rpc::mcp_tools() })),
        "tools/call" => {
            let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let args = p.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match rpc::call_in(name, &args, ctx) {
                Ok(v) => Ok(json!({
                    "content": [{ "type": "text", "text": compact(&v) }],
                    "isError": false
                })),
                Err(e) => Ok(json!({
                    "content": [{ "type": "text", "text": compact(&util::human_err(&e)) }],
                    "isError": true
                })),
            }
        }
        "resources/list" => Ok(json!({ "resources": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "logging/setLevel" => Ok(json!({})),
        other => Err((-32601, format!("method not found: {}", other))),
    }
}

fn compact(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
}
