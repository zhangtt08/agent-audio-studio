use crate::error::{Fail, R};
use crate::ff;
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct Info {
    pub dur: f64,
    pub sr: u32,
    pub ch: u32,
    pub codec: String,
    pub fmt: String,
    pub size: u64,
    pub bitrate: u64,
    pub has_audio: bool,
    pub has_video: bool,
    pub astreams: usize,
    pub vstreams: usize,
}

fn f64v(v: &Value, k: &str) -> Option<f64> {
    match v.get(k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn u32v(v: &Value, k: &str) -> Option<u32> {
    f64v(v, k).map(|x| x as u32)
}

pub fn probe(path: &Path) -> R<Info> {
    if !path.exists() {
        return Err(Fail::new("nofile", format!("{}", path.display())));
    }
    let j = ff::probe_json(path)?;
    let fmt = j.get("format").cloned().unwrap_or(Value::Null);
    let streams = j
        .get("streams")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    let mut i = Info::default();
    i.dur = f64v(&fmt, "duration").unwrap_or(0.0);
    i.size = u32v(&fmt, "size").map(|x| x as u64).unwrap_or(0);
    i.bitrate = u32v(&fmt, "bit_rate").map(|x| x as u64).unwrap_or(0);
    i.fmt = fmt
        .get("format_name")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    let mut best: Option<&Value> = None;
    for s in &streams {
        match s.get("codec_type").and_then(|t| t.as_str()) {
            Some("audio") => {
                i.has_audio = true;
                i.astreams += 1;
                if best.is_none() {
                    best = Some(s);
                }
            }
            Some("video") => {
                i.has_video = true;
                i.vstreams += 1;
            }
            _ => {}
        }
    }
    if let Some(s) = best {
        i.sr = u32v(s, "sample_rate").unwrap_or(0);
        i.ch = u32v(s, "channels").unwrap_or(0);
        i.codec = s
            .get("codec_name")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        if i.dur == 0.0 {
            i.dur = f64v(s, "duration").unwrap_or(0.0);
        }
    }
    if i.dur <= 0.0 {
        // Containers without a duration header: ask ffmpeg to decode-count it.
        i.dur = duration_by_decode(path)?;
    }
    Ok(i)
}

fn duration_by_decode(path: &Path) -> R<f64> {
    let out = ff::measure(&[
        "-i".into(),
        path.display().to_string(),
        "-map".into(),
        "a?".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ])?;
    let mut best = 0f64;
    for l in out.lines().rev() {
        if let Some(i) = l.find("time=") {
            let t = l[i + 5..].trim().split(|c| c == ' ' || c == '\r').next().unwrap_or("");
            if let Some(sec) = hms(t) {
                best = best.max(sec);
                break;
            }
        }
    }
    Ok(best)
}

fn hms(t: &str) -> Option<f64> {
    let mut acc = 0f64;
    let mut n = 0;
    for p in t.split(':') {
        acc *= 60.0;
        acc += p.trim().parse::<f64>().ok()?;
        n += 1;
    }
    if n == 0 {
        None
    } else {
        Some(acc)
    }
}

pub fn dur(path: &Path) -> R<f64> {
    Ok(probe(path)?.dur)
}

/// Terse agent-facing shape. `vid` is the video duration when the file has one.
pub fn value(i: &Info, path: &Path) -> Value {
    serde_json::json!({
        "p": crate::util::dbg_path(path),
        "dur": crate::util::round(i.dur, 3),
        "sr": i.sr,
        "ch": i.ch,
        "codec": i.codec,
        "fmt": i.fmt,
        "size": i.size,
        "vid": if i.has_video { Value::from(crate::util::round(i.dur, 3)) } else { Value::Null },
        "aud": i.has_audio,
        "va": i.astreams,
    })
}

pub fn audio_streams(path: &Path) -> R<Vec<Value>> {
    let j = ff::probe_json(path)?;
    let mut out = vec![];
    if let Some(arr) = j.get("streams").and_then(|s| s.as_array()) {
        for (n, s) in arr.iter().enumerate() {
            if s.get("codec_type").and_then(|t| t.as_str()) == Some("audio") {
                out.push(serde_json::json!({
                    "i": out.len(),
                    "idx": n,
                    "lang": s.get("tags").and_then(|t| t.get("language")).and_then(|l| l.as_str()).unwrap_or(""),
                    "codec": s.get("codec_name").and_then(|c| c.as_str()).unwrap_or(""),
                    "ch": s.get("channels").and_then(|c| c.as_f64()).unwrap_or(0.0) as u32,
                    "sr": s.get("sample_rate").and_then(|c| c.as_str()).and_then(|x| x.parse::<u32>().ok()).unwrap_or(0),
                }));
            }
        }
    }
    Ok(out)
}

/// Put an audio track back onto a video without touching the picture.
pub fn mux(video: &Path, audio: &Path, out: &Path, job: Option<&ff::JobHandle>) -> R<f64> {
    crate::util::ensure_parent(out)?;
    let vd = probe(video)?.dur;
    ff::run(
        &[
            "-i".into(),
            video.display().to_string(),
            "-i".into(),
            audio.display().to_string(),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
            "-c:v".into(),
            "copy".into(),
            "-shortest".into(),
            "-movflags".into(),
            "+faststart".into(),
            out.display().to_string(),
        ],
        Some(vd),
        job,
    )?;
    probe(out).map(|i| i.dur)
}

/// Silent audio of a given length — lets a trackless video still be a mix layer.
pub fn silence(out: &Path, d: f64, sr: u32, ch: u32, job: Option<&ff::JobHandle>) -> R<()> {
    crate::util::ensure_parent(out)?;
    ff::run(
        &[
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("anullsrc=r={}:cl={}", sr, if ch >= 6 { "5.1" } else if ch == 1 { "mono" } else { "stereo" }),
            "-t".into(),
            crate::util::t3(d).to_string(),
            "-c:a".into(),
            "pcm_s16le".into(),
            out.display().to_string(),
        ],
        Some(d),
        job,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hms_parses() {
        assert_eq!(hms("00:01:02.500000"), Some(62.5));
        assert_eq!(hms("00:00:40.000000"), Some(40.0));
        assert_eq!(hms("nope"), None);
    }

    #[test]
    fn missing_file_is_nofile() {
        let e = probe(Path::new("Z:/definitely/not/here.wav")).unwrap_err();
        assert_eq!(e.code, "nofile");
    }
}
