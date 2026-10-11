use crate::error::{Fail, R};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn ps<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}

pub fn req_s<'a>(v: &'a Value, k: &str) -> R<&'a str> {
    ps(v, k).ok_or_else(|| Fail::new("param", format!("missing \"{}\"", k)))
}

pub fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| match x {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => num(s),
        _ => None,
    })
}

pub fn req_f(v: &Value, k: &str) -> R<f64> {
    f(v, k).ok_or_else(|| Fail::new("param", format!("missing \"{}\"", k)))
}

pub fn opt_b(v: &Value, k: &str, d: bool) -> bool {
    match v.get(k) {
        None => d,
        Some(Value::Bool(x)) => *x,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0).unwrap_or(d),
        Some(Value::String(s)) => matches!(s.as_str(), "1" | "true" | "yes" | "y" | "on"),
        Some(Value::Null) => d,
        Some(_) => true,
    }
}

pub fn arr(v: &Value, k: &str) -> Vec<Value> {
    match v.get(k) {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => serde_json::from_str::<Vec<Value>>(s).unwrap_or_else(|_| {
            s.split(',')
                .map(|x| Value::String(x.trim().to_string()))
                .collect()
        }),
        _ => vec![],
    }
}

pub fn num(s: &str) -> Option<f64> {
    let t = s.trim().trim_end_matches(['s', '秒']);
    let t = t.trim();
    t.parse::<f64>().ok()
}

/// Accepts `40`, `40.5`, `40s`, `1:23`, `1:23.5`, `0:01:23`.
pub fn time(v: &Value, k: &str) -> Option<f64> {
    let raw = v.get(k)?;
    if let Some(n) = raw.as_f64() {
        return Some(n);
    }
    let s = raw.as_str()?;
    let s = s.trim().trim_end_matches(['s', 'S']);
    if s.contains(':') {
        let mut acc = 0f64;
        for part in s.split(':') {
            acc *= 60.0;
            acc += part.trim().parse::<f64>().ok()?;
        }
        return Some(acc);
    }
    num(s)
}

pub fn req_time(v: &Value, k: &str) -> R<f64> {
    time(v, k).ok_or_else(|| Fail::new("param", format!("bad time \"{}\"", k)))
}

pub fn t2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

pub fn t3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// `0:42.3` — what the UI ruler and agent summaries both use.
pub fn mmss(t: f64) -> String {
    let t = t.max(0.0);
    let m = (t / 60.0).floor() as i64;
    let s = t - (m as f64) * 60.0;
    if s.fract() < 0.005 || s.fract() > 0.995 {
        format!("{}:{:02}", m, s.floor() as i64)
    } else {
        format!("{}:{:04.1}", m, s)
    }
}

pub fn home() -> PathBuf {
    if let Ok(p) = std::env::var("AGENTAUDIO_HOME") {
        return PathBuf::from(p);
    }
    #[cfg(windows)]
    {
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home_dir().join("AppData/Local"))
            .join("AgentAudio")
    }
    #[cfg(not(windows))]
    {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home_dir().join(".local/share"))
            .join("agentaudio")
    }
}

pub fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn tmp_dir() -> PathBuf {
    let p = home().join("tmp");
    let _ = std::fs::create_dir_all(&p);
    p
}

pub fn out_dir() -> PathBuf {
    let p = std::env::var("AGENTAUDIO_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join("Desktop").join("AgentAudioOut"));
    let _ = std::fs::create_dir_all(&p);
    p
}

/// Resolve an input path. Absolute paths pass through; relative ones are tried
/// against cwd then `root` so agents can use short names.
pub fn inp(p: &str, root: Option<&Path>) -> R<PathBuf> {
    let raw = PathBuf::from(expand(p));
    if raw.is_absolute() {
        if raw.exists() {
            return Ok(raw);
        }
        return Err(Fail::new("nofile", format!("{}", raw.display())).hint("check the path, or pass an absolute path"));
    }
    let mut tries: Vec<PathBuf> = vec![raw.clone()];
    if let Some(r) = root {
        tries.push(r.join(&raw));
    }
    tries.push(out_dir().join(&raw));
    tries.push(home().join("samples").join(&raw));
    for t in tries {
        if t.exists() {
            return Ok(t);
        }
    }
    Err(Fail::new("nofile", format!("\"{}\" not found", p)).hint(format!(
        "set --root, or use \"{}\"/samples/<file> after `agentaudio demo`",
        home().display()
    )))
}

/// Resolve an output path. Relative names land in `root` (or the out dir) and stay
/// inside it. An absolute `out=` is written exactly where it says: this tool exists to
/// drop audio next to the user's video, so `out` is a convenience, not a sandbox.
pub fn outp(p: &str, root: Option<&Path>) -> PathBuf {
    let raw = PathBuf::from(expand(p));
    if raw.is_absolute() {
        return raw;
    }
    match root {
        Some(r) => confine(r, &raw),
        None => out_dir().join(&raw),
    }
}

/// Climb-free join: `..` pops within the root and stops there, so `--root DIR`
/// cannot be walked out of with `out=../../x.wav`.
fn confine(root: &Path, rel: &Path) -> PathBuf {
    let mut segs: Vec<std::ffi::OsString> = Vec::new();
    for c in rel.components() {
        match c {
            std::path::Component::Normal(s) => segs.push(s.to_os_string()),
            std::path::Component::ParentDir => {
                segs.pop();
            }
            _ => {}
        }
    }
    let mut out = root.to_path_buf();
    for s in segs {
        out.push(s);
    }
    out
}

fn expand(p: &str) -> String {
    let p = p.trim_matches('"');
    if p == "~" {
        return home_dir().display().to_string();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return home_dir().join(rest).display().to_string();
    }
    p.to_string()
}

pub fn ensure_parent(p: &Path) -> R<()> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    Ok(())
}

pub fn ext(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default()
}

pub fn stem(p: &Path) -> String {
    p.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("out")
        .to_string()
}

pub fn with_ext(p: &Path, e: &str) -> PathBuf {
    let mut f = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    if let Some(i) = f.rfind('.') {
        f.truncate(i);
    }
    p.with_file_name(format!("{}.{}", f, e))
}

pub fn dbg_path(p: &Path) -> String {
    p.display().to_string()
}

/// Shorten paths in agent-facing output: strip a common root prefix.
pub fn short(p: &Path, root: Option<&Path>) -> String {
    let s = p.display().to_string();
    if let Some(r) = root {
        if let Some(t) = s.strip_prefix(&format!("{}\\", r.display())) {
            return t.to_string();
        }
        if let Some(t) = s.strip_prefix(&format!("{}/", r.display())) {
            return t.to_string();
        }
    }
    s
}

pub fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn date_str() -> String {
    let ms = now_ms() / 1000;
    // compact UTC-ish stamp without pulling in chrono
    let secs = (ms % 86400) as u32;
    let days = ms / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        y,
        m,
        d,
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn round(v: f64, dp: u32) -> f64 {
    let m = 10f64.powi(dp as i32);
    (v * m).round() / m
}

/// `atempo` only accepts 0.5..=2.0, so a big ratio becomes a chain.
pub fn atempo_chain(r: f64) -> Vec<f64> {
    let mut out = vec![];
    let mut r = r;
    if r <= 0.0 {
        return out;
    }
    while r > 2.0 + 1e-9 {
        out.push(2.0);
        r /= 2.0;
    }
    while r < 0.5 - 1e-9 {
        out.push(0.5);
        r *= 2.0;
    }
    if (r - 1.0).abs() > 1e-6 || out.is_empty() {
        out.push(round(r, 6));
    }
    out
}

pub fn snap_to(v: f64, frame: f64) -> f64 {
    if frame <= 0.0 {
        return v;
    }
    (v / frame).round() * frame
}

pub fn human_err(e: &Fail) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("e".into(), Value::String(e.msg.clone()));
    m.insert("code".into(), Value::String(e.code.clone()));
    if let Some(h) = &e.hint {
        m.insert("hint".into(), Value::String(h.clone()));
    }
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_times() {
        assert_eq!(time(&json!({ "t": "1:23.5" }), "t"), Some(83.5));
        assert_eq!(time(&json!({ "t": 40 }), "t"), Some(40.0));
        assert_eq!(time(&json!({ "t": "40s" }), "t"), Some(40.0));
        assert_eq!(time(&json!({ "t": "0:01:30" }), "t"), Some(90.0));
    }

    #[test]
    fn root_fence_stops_dotdot() {
        let root = Path::new("C:/proj/out");
        assert_eq!(confine(root, Path::new("x.wav")), PathBuf::from("C:/proj/out/x.wav"));
        assert_eq!(confine(root, Path::new("sub/x.wav")), PathBuf::from("C:/proj/out/sub/x.wav"));
        assert_eq!(confine(root, Path::new("../../x.wav")), PathBuf::from("C:/proj/out/x.wav"));
        assert_eq!(confine(root, Path::new("a/../../x.wav")), PathBuf::from("C:/proj/out/x.wav"));
    }

    #[test]
    fn tempo_chain_stays_in_range() {
        let c = atempo_chain(7.5);
        assert!(c.iter().all(|x| *x >= 0.5 && *x <= 2.0));
        let p: f64 = c.iter().product();
        assert!((p - 7.5).abs() < 1e-6);
        assert_eq!(atempo_chain(1.0), vec![1.0]);
    }

    #[test]
    fn mmss_shapes() {
        assert_eq!(mmss(42.3), "0:42.3");
        assert_eq!(mmss(65.0), "1:05");
    }

    #[test]
    fn bool_forms() {
        assert!(opt_b(&json!({ "x": "1" }), "x", false));
        assert!(opt_b(&json!({ "x": true }), "x", false));
        assert!(!opt_b(&json!({}), "x", false));
        assert!(opt_b(&json!({}), "x", true));
    }
}
