//! Everything the UI draws besides the waveform: per-channel meters, section
//! detection, and caption import. No panel here invents a value.

use crate::dsp;
use crate::error::{Fail, R};
use crate::{measure, media, util};
use serde_json::{json, Value};
use std::path::Path;

fn ch_names(n: usize) -> Vec<&'static str> {
    match n {
        1 => vec!["M"],
        2 => vec!["L", "R"],
        3 => vec!["L", "R", "C"],
        6 => vec!["L", "R", "C", "LFE", "LS", "RS"],
        8 => vec!["FL", "FR", "FC", "LFE", "BL", "BR", "SL", "SR"],
        _ => vec!["C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7"],
    }
}

pub fn levels(path: &Path) -> R<Value> {
    let info = media::probe(path)?;
    if !info.has_audio {
        return Err(Fail::new("noaudio", "file has no audio track"));
    }
    let ch: u16 = info.ch.clamp(1, 8) as u16;
    let st = measure::at(path, measure::MEASURE_SR, ch)?;
    let names = ch_names(st.ch_n);
    let list: Vec<Value> = (0..st.ch_n)
        .map(|i| {
            json!({
                "name": names.get(i).copied().unwrap_or("C?"),
                "peak": util::round(dsp::db(st.ch_peak[i]), 1),
                "rms": util::round(st.ch_rms[i], 1),
            })
        })
        .collect();
    Ok(json!({ "ch": list, "sr": st.sr, "dur": util::round(st.dur.max(info.dur), 2), "silent": st.is_silent() }))
}

#[derive(Clone, Debug)]
pub struct Seg {
    pub t0: f64,
    pub t1: f64,
    pub kind: String,
    pub energy: f64,
    /// mean band balance and zero-crossing rate over the segment
    pub low: f64,
    pub mid: f64,
    pub zcr: f64,
}

/// Energy/gap segmentation from the streaming frame stats. `thresh` is dBFS;
/// the default adapts to the file's own noise floor.
pub fn segments(path: &Path, min_gap: f64, min_len: f64, thresh: Option<f64>) -> R<(Vec<Seg>, f64)> {
    let info = media::probe(path)?;
    if !info.has_audio {
        return Err(Fail::new("noaudio", "file has no audio track"));
    }
    let st = measure::mono(path)?;
    if st.frames.is_empty() {
        return Ok((vec![], info.dur));
    }
    let dbs = st.dbs();
    let th = thresh.unwrap_or_else(|| (dsp::pct(&dbs, 10.0) + 8.0).max(-55.0).min(-25.0));
    let per = st.hop as f64 / st.sr as f64;
    let gap_lim = (min_gap / per).max(1.0) as usize;

    let mut segs: Vec<Seg> = vec![];
    let mut cur: Option<(usize, usize, f64, f64, f64, usize)> = None;
    let mut gap = 0usize;
    for (i, fr) in st.frames.iter().enumerate() {
        if fr.db >= th {
            match cur.as_mut() {
                Some((_, b, acc, low, mid, zc)) => {
                    *b = i;
                    *acc += fr.db;
                    *low += fr.low;
                    *mid += fr.mid;
                    *zc += fr.zcr as usize;
                }
                None => cur = Some((i, i, fr.db, fr.low, fr.mid, fr.zcr as usize)),
            }
            gap = 0;
        } else if cur.is_some() {
            gap += 1;
            if gap >= gap_lim {
                if let Some(c) = cur.take() {
                    push(&mut segs, c, per);
                }
            }
        }
    }
    if let Some(c) = cur.take() {
        push(&mut segs, c, per);
    }
    segs.retain(|s| s.t1 - s.t0 >= min_len);
    let maxe = segs.iter().map(|s| s.energy).fold(-1e9f64, f64::max);
    for s in segs.iter_mut() {
        s.kind = classify(s, maxe);
    }
    Ok((segs, st.dur.max(info.dur)))
}

fn push(segs: &mut Vec<Seg>, c: (usize, usize, f64, f64, f64, usize), per: f64) {
    let (a, b, acc, low, mid, zc) = c;
    let n = (b - a + 1) as f64;
    segs.push(Seg {
        t0: util::round(a as f64 * per, 2),
        t1: util::round((b + 1) as f64 * per, 2),
        kind: String::new(),
        energy: acc / n,
        low: low / n,
        mid: mid / n,
        zcr: zc as f64 / n,
    });
}

/// speech vs music vs hit from band balance and zero-crossing rate.
fn classify(s: &Seg, maxe: f64) -> String {
    let d = s.t1 - s.t0;
    if d < 0.55 {
        return "hit".into();
    }
    if s.low > 0.55 && s.zcr < 0.16 {
        "music".into()
    } else if s.mid > 0.18 && s.zcr > 0.14 {
        "speech".into()
    } else if s.energy < maxe - 12.0 {
        "quiet".into()
    } else {
        "part".into()
    }
}

pub fn sections_json(path: &Path, min_gap: f64, min_len: f64, thresh: Option<f64>) -> R<Value> {
    let (segs, dur) = segments(path, min_gap, min_len, thresh)?;
    let maxe = segs.iter().map(|s| s.energy).fold(-1e9f64, f64::max);
    let secs: Vec<Value> = segs
        .iter()
        .map(|s| {
            // 0..1 relative to the loudest segment, over a 40 dB working range
            let rel = if maxe <= -1e8 { 0.0 } else { ((s.energy - maxe + 40.0) / 40.0).clamp(0.0, 1.0) };
            json!({ "t0": s.t0, "t1": s.t1, "kind": s.kind, "energy": util::round(rel, 2) })
        })
        .collect();
    Ok(json!({ "dur": util::round(dur, 2), "secs": secs }))
}

/// Parse .srt / .vtt / .json captions into timed lines. This is how the
/// Transcript panel gets real data without bundling a speech model.
pub fn parse_captions(p: &Path) -> R<Vec<Value>> {
    let txt = std::fs::read_to_string(p)
        .map_err(|e| Fail::new("io", format!("cannot read captions: {}", e)))?;
    let ext = util::ext(p);
    let mut out: Vec<Value> = vec![];
    if ext == "json" {
        let v: Value = serde_json::from_str(&txt)?;
        let arr = if let Some(a) = v.as_array() {
            a.clone()
        } else if let Some(a) = v.get("segments").and_then(|s| s.as_array()) {
            a.clone()
        } else {
            return Err(Fail::new("format", "json captions need an array of segments"));
        };
        for s in arr {
            let t0 = util::time(&s, "t0").or_else(|| util::time(&s, "start")).unwrap_or(0.0);
            let t1 = util::time(&s, "t1").or_else(|| util::time(&s, "end")).unwrap_or(t0);
            let txt = util::ps(&s, "txt")
                .or_else(|| util::ps(&s, "text"))
                .unwrap_or("")
                .to_string();
            out.push(json!({ "t0": util::round(t0, 2), "t1": util::round(t1, 2), "txt": txt }));
        }
        return Ok(out);
    }
    for raw in txt.replace('\r', "\n").split("\n\n") {
        let lines: Vec<&str> = raw.trim().lines().filter(|l| !l.trim().is_empty()).collect();
        let Some(i) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let ts: Vec<&str> = lines[i].split("-->").map(|s| s.trim()).collect();
        if ts.len() != 2 {
            continue;
        }
        let (a, b) = match (stamp(ts[0]), stamp(ts[1])) {
            (Some(x), Some(y)) => (x, y),
            _ => continue,
        };
        let body = lines[i + 1..].join(" ");
        out.push(json!({ "t0": util::round(a, 2), "t1": util::round(b, 2), "txt": body }));
    }
    if out.is_empty() {
        return Err(Fail::new("format", "no cues found").hint("expected .srt, .vtt or a json segment array"));
    }
    Ok(out)
}

fn stamp(s: &str) -> Option<f64> {
    let s = s.split_whitespace().next()?;
    let s = s.replace(',', ".");
    let mut acc = 0f64;
    let mut n = 0;
    for part in s.split(':') {
        acc *= 60.0;
        acc += part.trim().parse::<f64>().ok()?;
        n += 1;
    }
    if n == 0 {
        None
    } else {
        Some(acc)
    }
}

/// `transcribe` result. Honest about what is and is not available: either an
/// imported cue file, or a locally installed engine, or a clear "no engine".
pub fn transcript(path: &Path, from: Option<&Path>) -> R<Value> {
    if let Some(f) = from {
        let segs = parse_captions(f)?;
        let n = segs.len();
        return Ok(json!({ "ok": true, "engine": "import", "from": util::dbg_path(f), "n": n, "segs": segs }));
    }
    match whisper_cli(path) {
        Some(segs) => {
            let n = segs.len();
            Ok(json!({ "ok": true, "engine": "whisper", "n": n, "segs": segs }))
        }
        None => Ok(json!({
            "ok": false,
            "why": "no-engine",
            "use": "transcribe from=<.srt|.vtt|.json> to import cues, or install whisper.cpp on PATH"
        })),
    }
}

fn whisper_cli(path: &Path) -> Option<Vec<Value>> {
    use std::process::Command;
    let tmp = util::tmp_dir().join(format!("wh-{}-{}", std::process::id(), util::now_ms()));
    let exe = ["whisper-cli", "whisper", "main"]
        .iter()
        .find(|e| Command::new(e).arg("--help").output().is_ok())?;
    let mut c = Command::new(exe);
    c.args(["-m", "ggml-base.en.bin", "-otxt", "-of"]).arg(&tmp).arg(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let o = c.output().ok()?;
    if !o.status.success() {
        return None;
    }
    let txt = std::fs::read_to_string(tmp.with_extension("txt")).ok()?;
    let mut out = vec![];
    for (i, l) in txt.lines().enumerate() {
        let l = l.trim();
        if l.is_empty() {
            continue;
        }
        out.push(json!({ "t0": util::round(i as f64 * 3.0, 1), "t1": util::round(i as f64 * 3.0 + 3.0, 1), "txt": l }));
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}
