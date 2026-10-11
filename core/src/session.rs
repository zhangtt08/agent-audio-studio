//! Durable state shared between the app and the agent: projects, the call log
//! the 智能体 panel reads, and the workspace the agent drops files into.

use crate::error::{Fail, R};
use crate::util;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static CALLS: AtomicU64 = AtomicU64::new(0);

pub fn root() -> PathBuf {
    let p = util::home();
    let _ = std::fs::create_dir_all(&p);
    p
}

pub fn projects_dir() -> PathBuf {
    let p = root().join("projects");
    let _ = std::fs::create_dir_all(&p);
    p
}

pub fn workspace() -> PathBuf {
    let p = std::env::var("AGENTAUDIO_WORK")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root().join("workspace"));
    let _ = std::fs::create_dir_all(&p);
    p
}

pub fn log_path() -> PathBuf {
    root().join("calls.jsonl")
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// User-saved settings, shared by the app's 设置 page and the agent. Only
/// `ffmpeg` affects the engine (it is how a bundled build finds the binary).
pub fn config_path() -> PathBuf {
    root().join("config.json")
}

pub fn read_config() -> Value {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}))
}

pub fn write_config(patch: &Value) -> R<Value> {
    let mut cur = read_config();
    let merged = match (cur.as_object_mut(), patch.as_object()) {
        (Some(a), Some(b)) => {
            for (k, v) in b {
                if v.is_null() {
                    a.remove(k);
                } else {
                    a.insert(k.clone(), v.clone());
                }
            }
            cur.clone()
        }
        _ => return Err(Fail::new("param", "config expects an object of settings")),
    };
    std::fs::write(config_path(), serde_json::to_vec(&merged)?)?;
    Ok(json!({ "ok": true, "path": util::dbg_path(&config_path()), "config": merged }))
}

pub fn config_str(key: &str) -> Option<String> {
    read_config().get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

pub fn save_project(name: &str, data: &Value) -> R<Value> {
    let n = if name.is_empty() { "untitled".to_string() } else { sanitize(name) };
    let p = projects_dir().join(format!("{}.json", n));
    let mut v = data.clone();
    if let Some(o) = v.as_object_mut() {
        o.insert("_name".into(), json!(n));
        o.insert("_at".into(), json!(util::date_str()));
    }
    std::fs::write(&p, serde_json::to_vec(&v)?)?;
    Ok(json!({ "ok": true, "name": n, "path": util::dbg_path(&p) }))
}

pub fn load_project(name: &str) -> R<Value> {
    let p = projects_dir().join(format!("{}.json", sanitize(name)));
    if !p.exists() {
        return Err(Fail::new("nofile", format!("no project \"{}\"", name)).hint("project list:true shows what exists"));
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&p)?)?;
    Ok(json!({ "ok": true, "name": name, "path": util::dbg_path(&p), "data": v }))
}

pub fn list_projects() -> Value {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(projects_dir()) {
        for e in rd.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) == Some("json") {
                out.push(json!({
                    "name": e.path().file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string(),
                    "size": e.metadata().map(|m| m.len()).unwrap_or(0),
                }));
            }
        }
    }
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    json!({ "ok": true, "projects": out })
}

/// One line per agent-visible call. The 智能体 card is a read of this file, so
/// what a human sees is exactly what the agent did.
pub fn log_call(method: &str, params: &Value, res: &Result<Value, Fail>, ms: u128, via: &str) {
    CALLS.fetch_add(1, Ordering::Relaxed);
    let mut e = json!({
        "t": util::date_str(),
        "ts": util::now_ms() as u64,
        "op": method,
        "ms": ms as u64,
        "ok": res.is_ok(),
    });
    if via == "ui" {
        e["ui"] = json!(1);
    }
    let pick = |k: &str| params.get(k).and_then(|x| x.as_str()).map(|s| s.to_string());
    if let Some(i) = pick("in").or_else(|| pick("path")) {
        e["in"] = json!(short_name(&i));
    }
    match res {
        Ok(v) => {
            if let Some(o) = v.get("out").and_then(|x| x.as_str()) {
                e["out"] = json!(short_name(o));
            }
            if let Some(d) = v.get("dur").and_then(|x| x.as_f64()) {
                e["dur"] = json!(crate::util::round(d, 2));
            }
        }
        Err(f) => {
            e["e"] = json!(f.code);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = f.write_all(serde_json::to_string(&e).unwrap_or_default().as_bytes());
        let _ = f.write_all(b"\n");
    }
    if CALLS.load(Ordering::Relaxed) % 200 == 0 {
        rotate();
    }
}

fn short_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(p)
        .to_string()
}

fn rotate() {
    let p = log_path();
    if let Ok(m) = std::fs::metadata(&p) {
        if m.len() > 4_000_000 {
            let _ = std::fs::rename(&p, root().join("calls.prev.jsonl"));
        }
    }
}

pub fn read_log(n: usize, with_ui: bool) -> Value {
    let txt = std::fs::read_to_string(log_path()).unwrap_or_default();
    summarize(&txt, n, with_ui)
}

/// Split out from `read_log` so the counting rules are testable without reading
/// whatever the machine's real call log happens to contain.
fn summarize(txt: &str, n: usize, with_ui: bool) -> Value {
    let all: Vec<Value> = txt
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    // Stats cover the window the caller asked to see; the list is only the newest
    // entries. `today` is deliberately not computed here: std has no local timezone,
    // so a UTC day boundary would be wrong for most users. The UI derives it from `ts`
    // in the viewer's own timezone.
    let shown: Vec<&Value> = if with_ui {
        all.iter().collect()
    } else {
        all.iter().filter(|c| c.get("ui").is_none()).collect()
    };
    let fails = shown
        .iter()
        .filter(|c| c["ok"].as_bool() == Some(false))
        .count();
    let take = n.clamp(1, 500).min(shown.len());
    let calls: Vec<Value> = shown.iter().rev().take(take).cloned().cloned().collect();
    json!({ "calls": calls, "n": shown.len(), "fails": fails })
}

pub fn clear_log() -> Value {
    let _ = std::fs::remove_file(log_path());
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_blocks_path_escape() {
        assert_eq!(sanitize("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize("ok name"), "ok name");
    }

    #[test]
    fn empty_log_reads_clean() {
        let v = summarize("", 10, true);
        assert!(v["calls"].is_array());
        assert_eq!(v["n"].as_i64(), Some(0));
        assert_eq!(v["fails"].as_i64(), Some(0));
    }

    #[test]
    fn log_summary_separates_the_windows_own_polling() {
        let txt = "{\"op\":\"fit\",\"ok\":true,\"ui\":1}\n{\"op\":\"fit\",\"ok\":false,\"e\":\"nofile\"}\n";
        let agents = summarize(txt, 10, false);
        assert_eq!(agents["n"].as_i64(), Some(1));
        assert_eq!(agents["fails"].as_i64(), Some(1));
        assert_eq!(agents["calls"][0]["ui"], Value::Null);
        let everything = summarize(txt, 10, true);
        assert_eq!(everything["n"].as_i64(), Some(2));
    }
}
