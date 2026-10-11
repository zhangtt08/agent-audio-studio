//! The 音频评分 card. Every sub-score is derived from measured samples; the
//! weights are a documented heuristic, not a marketing number.

use crate::dsp::{self, clamp};
use crate::error::{Fail, R};
use crate::{ff, measure, media, util};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Clone, Copy, Debug, Default)]
pub struct Loud {
    pub i: f64,
    pub tp: f64,
    pub lra: f64,
    pub thresh: f64,
}

/// Real EBU R128, measured by ffmpeg's own loudnorm analysis pass.
/// This is the expensive part of `score` (~19x realtime), so callers may skip it.
pub fn loudness(path: &Path, job: Option<&ff::JobHandle>) -> R<Loud> {
    let txt = ff::measure_with(&[
        "-i".into(),
        util::dbg_path(path),
        "-map".into(),
        "0:a:0".into(),
        "-af".into(),
        "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ], job)?;
    let start = txt.rfind('{').ok_or_else(|| Fail::new("measure", "no loudnorm json"))?;
    let end = txt[start..]
        .rfind('}')
        .map(|i| start + i + 1)
        .ok_or_else(|| Fail::new("measure", "unterminated loudnorm json"))?;
    let v: Value = serde_json::from_str(&txt[start..end])
        .map_err(|e| Fail::new("measure", format!("loudnorm json: {}", e)))?;
    let g = |k: &str| v.get(k).and_then(|x| x.as_str()).and_then(|s| s.parse::<f64>().ok());
    Ok(Loud {
        i: g("input_i").unwrap_or(-70.0),
        tp: g("input_tp").unwrap_or(-70.0),
        lra: g("input_lra").unwrap_or(0.0),
        thresh: g("input_thresh").unwrap_or(-70.0),
    })
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

pub fn metrics(path: &Path, want_lufs: bool, job: Option<&ff::JobHandle>) -> R<Value> {
    let info = media::probe(path)?;
    if !info.has_audio {
        return Err(Fail::new("noaudio", "file has no audio track")
            .hint("run `extract` first, or `extract silence:true` for a silent bed"));
    }
    let st = measure::stereo(path)?;
    let dbs = st.dbs();
    if dbs.is_empty() {
        return Err(Fail::new("empty", "decoded audio is empty"));
    }
    let floor = dsp::pct(&dbs, 10.0);
    let level = dsp::pct(&dbs, 85.0);
    let hi = dsp::pct(&dbs, 95.0);
    let spread = hi - floor;
    let snr = level - floor;
    let clarity_ratio = mean(&st.frames.iter().map(|f| f.mid).collect::<Vec<f64>>());
    let peak_lin = st.ch_peak.iter().cloned().fold(0f64, f64::max);
    let peak_db = dsp::db(peak_lin);
    let rms_db = dsp::db(dsp::rms(&dbs.iter().map(|&d| dsp::db_gain(d)).collect::<Vec<f64>>()));
    let imbalance = if st.ch_rms.len() >= 2 { (st.ch_rms[0] - st.ch_rms[1]).abs() } else { 0.0 };

    let silent = st.is_silent();
    let base = |v: f64| v.round().clamp(0.0, 100.0) as u32;
    let (clarity, balance, dynamics, noise, score) = if silent {
        // A silent file has no clarity or dynamics to grade. Reporting a
        // confident mid-range score would be a fabricated number.
        (0, base(if peak_lin == 0.0 { 0.0 } else { 50.0 }), 0, 0, 0u32)
    } else {
        let c = dsp::map_score(clarity_ratio, 0.02, 0.30, 42.0, 98.0);
        let b = dsp::map_score(imbalance, 9.0, 0.2, 45.0, 99.0);
        let dy = dsp::map_score(spread, 2.0, 22.0, 48.0, 97.0);
        let nz = dsp::map_score(snr, 12.0, 45.0, 35.0, 98.0);
        let mut sc = 0.30 * c + 0.24 * b + 0.20 * dy + 0.26 * nz;
        if peak_db > -0.5 {
            sc -= 6.0;
        }
        (base(c), base(b), base(dy), base(nz), clamp(sc, 0.0, 100.0).round() as u32)
    };

    let mut out = json!({
        "score": score,
        "clarity": clarity,
        "balance": balance,
        "dynamics": dynamics,
        "noise": noise,
        "peak": util::round(peak_db, 1),
        "rms": util::round(rms_db, 1),
        "floor": util::round(floor, 1),
        "lufs": util::round(level, 1),
        "band": util::round(clarity_ratio, 3),
        "dur": util::round(if st.dur > 0.0 { st.dur } else { info.dur }, 2),
        "sr": info.sr,
        "ch": info.ch,
        "silent": silent,
    });
    if silent {
        out["note"] = json!("no audible signal");
    }
    // loudnorm is ~19x realtime; skip it for silent files and on request
    if want_lufs && !silent {
        if let Some(j) = job {
            j.set_stage("测量 LUFS");
        }
        if let Ok(l) = loudness(path, job) {
            out["lufs"] = json!(util::round(l.i, 1));
            out["tp"] = json!(util::round(l.tp, 1));
            out["lra"] = json!(util::round(l.lra, 1));
            out["lufs_src"] = json!("r128");
        } else {
            out["lufs_src"] = json!("estimate");
        }
    } else {
        // p85 frame RMS, not EBU R128 — `lufs_src` says which one the caller got
        out["lufs"] = json!(util::round(level, 1));
        out["lufs_src"] = json!("estimate");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mean_handles_empty() {
        assert_eq!(mean(&[]), 0.0);
        assert_eq!(mean(&[1.0, 2.0, 3.0]), 2.0);
    }
}
