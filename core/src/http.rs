//! A deliberately small HTTP/1.1 server: it is the desktop app's audio source
//! (range requests, so seeking works) and the agent's REST API at the same time.

use crate::error::{Fail, R};
use crate::{rpc, util};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread;

pub const DEFAULT_PORT: u16 = 8787;

/// Port this process is serving on, 0 when it is not a server. Reported by
/// `caps` so the UI's connection state reflects reality.
static BOUND: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

pub fn port() -> u16 {
    BOUND.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn start(port: u16, root: Option<PathBuf>) -> R<u16> {
    let l = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| Fail::new("bind", format!("127.0.0.1:{}: {}", port, e)))?;
    let bound = l.local_addr().map(|a| a.port()).unwrap_or(port);
    BOUND.store(bound, std::sync::atomic::Ordering::Relaxed);
    thread::spawn(move || {
        for stream in l.incoming() {
            if let Ok(s) = stream {
                let r = root.clone();
                thread::spawn(move || {
                    let _ = handle(s, r);
                });
            }
        }
    });
    Ok(bound)
}

fn mime(p: &str) -> &'static str {
    match p.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "json" => "application/json",
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        _ => "application/octet-stream",
    }
}

fn write_all(s: &mut TcpStream, status: &str, headers: &[(&str, String)], body: &[u8]) {
    let mut h = format!("HTTP/1.1 {} {}\r", status, "");
    h = format!("HTTP/1.1 {}\r\n", status);
    h.push_str(&format!("Content-Length: {}\r\n", body.len()));
    h.push_str("Access-Control-Allow-Origin: *\r\n");
    h.push_str("Access-Control-Allow-Headers: Content-Type, Range\r\n");
    h.push_str("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
    h.push_str("Connection: close\r\n");
    for (k, v) in headers {
        h.push_str(&format!("{}: {}\r\n", k, v));
    }
    h.push_str("\r\n");
    let _ = s.write_all(h.as_bytes());
    let _ = s.write_all(body);
    let _ = s.flush();
}

fn json_resp(s: &mut TcpStream, status: &str, v: &Value) {
    let body = serde_json::to_vec(v).unwrap_or_else(|_| b"{}".to_vec());
    write_all(s, status, &[("Content-Type", "application/json".into())], &body);
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = vec![];
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn coerce(v: &str) -> Value {
    let t = v.trim();
    if t.starts_with('{') || t.starts_with('[') || t.starts_with('"') {
        if let Ok(j) = serde_json::from_str::<Value>(t) {
            return j;
        }
    }
    match t {
        "true" => json!(true),
        "false" => json!(false),
        _ => t.parse::<f64>().map(|x| json!(x)).unwrap_or_else(|_| json!(v)),
    }
}

fn query_params(q: &str) -> Value {
    let mut m = serde_json::Map::new();
    for pair in q.split('&').filter(|x| !x.is_empty()) {
        let mut kv = pair.splitn(2, '=');
        let k = urldecode(kv.next().unwrap_or(""));
        let v = kv.next().unwrap_or("");
        if k == "p" || k == "params" {
            if let Ok(j) = serde_json::from_str::<Value>(&urldecode(v)) {
                if let Some(o) = j.as_object() {
                    for (a, b) in o {
                        m.insert(a.clone(), b.clone());
                    }
                }
            }
            continue;
        }
        m.insert(k, coerce(&urldecode(v)));
    }
    Value::Object(m)
}

fn serve_file(s: &mut TcpStream, path: &str, range: Option<&str>) {
    let p = PathBuf::from(urldecode(path));
    if !p.is_file() {
        json_resp(s, "404 Not Found", &json!({ "e": "not found", "code": "nofile" }));
        return;
    }
    let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    let mut f = match std::fs::File::open(&p) {
        Ok(f) => f,
        Err(_) => return json_resp(s, "500 Error", &json!({ "e": "unreadable" })),
    };
    let ctype = mime(path).to_string();
    let (start, end) = match parse_range(range, len) {
        Some((a, b)) => (a, b),
        None => {
            let mut body = vec![];
            let _ = f.read_to_end(&mut body);
            write_all(
                s,
                "200 OK",
                &[("Content-Type", ctype), ("Accept-Ranges", "bytes".into())],
                &body,
            );
            return;
        }
    };
    let mut buf = vec![0u8; (end - start + 1) as usize];
    use std::io::Seek;
    if f.seek(std::io::SeekFrom::Start(start)).is_err() {
        return json_resp(s, "500 Error", &json!({ "e": "seek" }));
    }
    let _ = f.read_exact(&mut buf);
    write_all(
        s,
        "206 Partial Content",
        &[
            ("Content-Type", ctype),
            ("Accept-Ranges", "bytes".into()),
            ("Content-Range", format!("bytes {}-{}/{}", start, end, len)),
        ],
        &buf,
    );
}

fn parse_range(r: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let r = r?.trim().strip_prefix("bytes=")?;
    let mut parts = r.split('-');
    let a = parts.next()?.trim();
    let b = parts.next().unwrap_or("").trim();
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        Some((len.saturating_sub(n), len.saturating_sub(1)))
    } else {
        let start: u64 = a.parse().ok()?;
        let end: u64 = if b.is_empty() { len.saturating_sub(1) } else { b.parse().ok()? };
        if start > end || start >= len {
            return None;
        }
        Some((start, end.min(len.saturating_sub(1))))
    }
}

fn handle(mut s: TcpStream, root: Option<PathBuf>) -> std::io::Result<()> {
    let mut buf = vec![0u8; 8192];
    let mut filled = 0usize;
    let mut head_end = None;
    for _ in 0..64 {
        let n = s.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
        if let Some(i) = find_sub(&buf[..filled], b"\r\n\r\n") {
            head_end = Some(i);
            break;
        }
    }
    let head_end = match head_end {
        Some(i) => i,
        None => return Ok(()),
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let req = lines.next().unwrap_or("").to_string();
    let mut it = req.split_whitespace();
    let method = it.next().unwrap_or("GET").to_string();
    let target = it.next().unwrap_or("/").to_string();
    let mut content_length = 0usize;
    let mut range: Option<String> = None;
    for l in lines {
        let (k, v) = match l.split_once(':') {
            Some(x) => (x.0.trim().to_lowercase(), x.1.trim().to_string()),
            None => continue,
        };
        if k == "content-length" {
            content_length = v.parse().unwrap_or(0);
        }
        if k == "range" {
            range = Some(v);
        }
    }
    let mut body: Vec<u8> = buf[head_end + 4..filled].to_vec();
    while body.len() < content_length {
        let mut more = [0u8; 4096];
        let n = s.read(&mut more)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&more[..n]);
    }
    if method == "OPTIONS" {
        write_all(&mut s, "204 No Content", &[], b"");
        return Ok(());
    }
    let (path, query) = match target.split_once('?') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (target.clone(), String::new()),
    };
    let ctx = rpc::Ctx { root: root.clone(), ..Default::default() };

    if path == "/f" {
        let q = query_params(&query);
        if let Some(p) = util::ps(&q, "path") {
            serve_file(&mut s, p, range.as_deref());
        } else {
            json_resp(&mut s, "400 Bad Request", &json!({ "e": "path required" }));
        }
        return Ok(());
    }
    if path == "/" || path == "/index.html" {
        let v = json!({ "app": "AgentAudio", "v": crate::VERSION, "endpoints": ["/caps", "/tools", "/jobs", "/log", "/f?path=", "/api/<method>"] });
        json_resp(&mut s, "200 OK", &v);
        return Ok(());
    }
    if path == "/health" {
        json_resp(&mut s, "200 OK", &json!({ "ok": true, "v": crate::VERSION }));
        return Ok(());
    }
    if path == "/caps" {
        let v = rpc::caps().unwrap_or_else(|e| rpc::util_err(&e));
        json_resp(&mut s, "200 OK", &v);
        return Ok(());
    }
    if path == "/tools" {
        json_resp(&mut s, "200 OK", &rpc::mcp_tools());
        return Ok(());
    }
    if path == "/events" {
        // one-shot snapshot; agents that want live progress poll /jobs
        let v = rpc::call_in("jobs", &json!({}), &ctx).unwrap_or_else(|e| rpc::util_err(&e));
        json_resp(&mut s, "200 OK", &v);
        return Ok(());
    }
    if path.starts_with("/api/") {
        let m = path.trim_start_matches("/api/").to_string();
        let mut params = if method == "POST" && !body.is_empty() {
            serde_json::from_slice(&body).unwrap_or_else(|_| json!({}))
        } else {
            query_params(&query)
        };
        if let Some(o) = params.as_object_mut() {
            if let Some(a) = o.remove("args").take() {
                if let Some(aa) = a.as_object() {
                    for (k, v) in aa {
                        o.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        match rpc::call_in(&m, &params, &ctx) {
            Ok(v) => json_resp(&mut s, "200 OK", &v),
            Err(e) => json_resp(&mut s, "400 Bad Request", &rpc::util_err(&e)),
        }
        return Ok(());
    }
    // bare /<method> also works, for people who hate typing api
    let m = path.trim_start_matches('/').to_string();
    if !m.is_empty() {
        let params = query_params(&query);
        let out = match rpc::call_in(&m, &params, &ctx) {
            Ok(v) => json_resp(&mut s, "200 OK", &v),
            Err(e) => json_resp(&mut s, "400 Bad Request", &rpc::util_err(&e)),
        };
        let _ = out;
        return Ok(());
    }
    json_resp(&mut s, "404 Not Found", &json!({ "e": "unknown path", "code": "route" }));
    Ok(())
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range(Some("bytes=0-499"), 1000), Some((0, 499)));
        assert_eq!(parse_range(Some("bytes=500-"), 1000), Some((500, 999)));
        assert_eq!(parse_range(Some("bytes=-100"), 1000), Some((900, 999)));
        assert_eq!(parse_range(Some("bytes=2000-3000"), 1000), None);
        assert_eq!(parse_range(None, 10), None);
    }

    #[test]
    fn query_types() {
        let q = query_params("dur=40&fade=true&mode=rate&chain=%5B%7B%22k%22%3A%22gain%22%7D%5D");
        assert_eq!(q["dur"], json!(40.0));
        assert_eq!(q["fade"], json!(true));
        assert_eq!(q["mode"], json!("rate"));
        assert!(q["chain"].is_array());
    }

    #[test]
    fn decoder() {
        assert_eq!(urldecode("a%20b"), "a b");
        assert_eq!(urldecode("C%3A%2Ftmp%2Fx.wav"), "C:/tmp/x.wav");
    }
}
