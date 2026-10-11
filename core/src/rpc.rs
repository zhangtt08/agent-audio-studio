//! The whole product surface, as one method table. CLI, MCP, HTTP and the
//! Tauri window all call `call()` so there is exactly one behaviour to test.

use crate::error::{Fail, R};
use crate::{analysis, ff, jobs, measure, media, ops, peaks, score, session, util};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default)]
pub struct Ctx {
    pub root: Option<PathBuf>,
    /// Who issued the call. Empty means an agent (CLI / MCP / HTTP); `"ui"` is the
    /// desktop window, whose own polling would otherwise bury real agent activity.
    pub via: &'static str,
}

pub fn call(m: &str, p: &Value) -> R<Value> {
    call_in(m, p, &Ctx::default())
}

pub fn call_in(m: &str, p: &Value, ctx: &Ctx) -> R<Value> {
    let t0 = util::now_ms();
    let r = dispatch(m, p, ctx);
    session::log_call(m, p, &r, util::now_ms().saturating_sub(t0), ctx.via);
    r
}

fn job<F: FnOnce(&ff::JobHandle) -> R<Value>>(op: &str, arg: String, stage: &str, f: F) -> R<Value> {
    let (id, h) = jobs::begin(op, arg, stage);
    match f(&h) {
        Ok(v) => {
            let out = v.get("out").and_then(|x| x.as_str()).unwrap_or("").to_string();
            jobs::finish(id, Some(&out), None);
            Ok(v)
        }
        Err(e) => {
            jobs::finish(id, None, Some(&e.msg));
            Err(e)
        }
    }
}

fn src(p: &Value, ctx: &Ctx) -> R<PathBuf> {
    let raw = util::ps(p, "in")
        .or_else(|| util::ps(p, "path"))
        .or_else(|| util::ps(p, "file"))
        .ok_or_else(|| Fail::new("param", "missing \"in\"").hint("every media method takes in=<file>"))?;
    util::inp(raw, ctx.root.as_deref())
}

fn dst(p: &Value, ctx: &Ctx, from: &Path, ext: &str) -> PathBuf {
    match util::ps(p, "out").filter(|o| !o.is_empty()) {
        Some(o) => util::outp(o, ctx.root.as_deref()),
        None => {
            let e = if ext.is_empty() { util::ext(from) } else { ext.to_string() };
            let e = if e.is_empty() { "wav".to_string() } else { e };
            session::workspace().join(format!("{}.{}", util::stem(from), e))
        }
    }
}

fn enc_of(p: &Value) -> ops::Enc {
    ops::Enc {
        sr: util::f(p, "sr").map(|x| x as u32),
        ch: util::f(p, "ch").map(|x| x as u32),
        br: util::f(p, "br").map(|x| x as u32),
        q: util::f(p, "q").map(|x| x as u32),
    }
}

fn s(p: &Path) -> String {
    p.display().to_string()
}

/// The wire shape for failures: one line, plus a stable code.
pub fn util_err(e: &Fail) -> Value {
    util::human_err(e)
}

fn out_summary(out: &Path) -> R<Value> {
    let i = media::probe(out)?;
    let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "out": util::short(out, None),
        "path": s(out),
        "dur": util::round(i.dur, 3),
        "sr": i.sr,
        "ch": i.ch,
        "fmt": util::ext(out),
        "codec": i.codec,
        "size": size,
    }))
}

fn chain_of(p: &Value) -> R<Vec<Value>> {
    if let Some(c) = p.get("chain").and_then(|x| x.as_array()) {
        return Ok(c.clone());
    }
    if let Some(c) = p.get("ops").and_then(|x| x.as_array()) {
        return Ok(c.clone());
    }
    if let Some(pr) = util::ps(p, "preset") {
        return ops::preset(pr);
    }
    Ok(vec![])
}

/// Decide how to make `src_d` become `tgt` without the caller having to know
/// about tempo math, loop seams or frame rounding.
fn decide_mode(src_d: f64, tgt: f64, req: &str, max_rate: f64, tol: f64) -> (&'static str, f64) {
    if (src_d - tgt).abs() <= tol {
        return ("none", 1.0);
    }
    let mut m = req.to_string();
    if m == "auto" {
        m = if src_d > tgt {
            if src_d / tgt <= max_rate {
                "rate".into()
            } else {
                "trim".into()
            }
        } else if tgt / src_d <= 2.0 {
            "rate".into()
        } else {
            "loop".into()
        };
    }
    let tempo = if m == "rate" { src_d / tgt } else { 1.0 };
    let m: &'static str = match m.as_str() {
        "trim" => "trim",
        "loop" | "pad" => "loop",
        "rate" => "rate",
        "none" => "none",
        _ => "trim",
    };
    (m, tempo)
}

fn fit_args(inp: &Path, out: &Path, tgt: f64, mode: &str, tempo: f64, fi: f64, fo: f64, enc: &ops::Enc, loop_samples: u64, rubber: bool) -> Vec<String> {
    let mut a: Vec<String> = vec![];
    a.push("-i".into());
    a.push(s(inp));
    let mut af: Vec<String> = vec![];
    if mode == "rate" {
        // `atempo` is WSOLA: fine for speech, but a 70s song squeezed to 40s gets
        // swishy transients. rubberband's phase vocoder keeps music intact.
        if rubber {
            af.push(format!("rubberband=tempo={:.6}:pitch=1", tempo));
        } else {
            for x in util::atempo_chain(tempo) {
                af.push(format!("atempo={:.6}", x));
            }
        }
    }
    if mode == "loop" {
        // `-stream_loop` is *not* sample-accurate on lossy inputs: every MP3 loop
        // iteration re-pays the decoder's encoder delay, so `-t 40` stops ~1.3%
        // early. `aloop` repeats already-decoded samples, so `-t` is exact.
        af.push(format!("aloop=loop=-1:size={}", loop_samples.max(1)));
    }
    if fi > 0.0 {
        af.push(format!("afade=t=in:st=0:d={:.4}", fi));
    }
    if fo > 0.0 {
        af.push(format!("afade=t=out:st={:.4}:d={:.4}", (tgt - fo).max(0.0), fo));
    }
    if !af.is_empty() {
        a.push("-af".into());
        a.push(af.join(","));
    }
    a.push("-map".into());
    a.push("0:a:0".into());
    a.push("-vn".into());
    a.push("-t".into());
    a.push(util::t3(tgt).to_string());
    a.extend(ops::enc_args(out, enc));
    a.push(s(out));
    a
}

pub fn dispatch(m: &str, p: &Value, ctx: &Ctx) -> R<Value> {
    let m = m.trim().to_lowercase().replace('-', "_");
    match m.as_str() {
        "ping" | "version" => Ok(json!({ "ok": true, "v": crate::VERSION })),

        "probe" | "info" => {
            let f = src(p, ctx)?;
            let i = media::probe(&f)?;
            let mut v = media::value(&i, &f);
            if util::opt_b(p, "streams", false) {
                v["a"] = json!(media::audio_streams(&f)?);
            }
            Ok(v)
        }

        "peaks" => {
            let f = src(p, ctx)?;
            let n = util::f(p, "n").unwrap_or(600.0) as usize;
            let ch = util::f(p, "ch").unwrap_or(0.0) as u32;
            let enc = util::ps(p, "enc").unwrap_or("b64");
            let sr = util::f(p, "sr").unwrap_or(0.0) as u32;
            job("peaks", s(&f), "波形", move |_| peaks::get(&f, n, ch, enc, sr))
        }

        "score" => {
            let f = src(p, ctx)?;
            let want = util::opt_b(p, "lufs", true);
            job("score", s(&f), "评分", move |j| score::metrics(&f, want, Some(j)))
        }

        "levels" => {
            let f = src(p, ctx)?;
            job("levels", s(&f), "电平", move |_| analysis::levels(&f))
        }

        "sections" => {
            let f = src(p, ctx)?;
            let min = util::f(p, "min").unwrap_or(0.35);
            let len = util::f(p, "len").unwrap_or(0.25);
            let noise = util::f(p, "noise");
            job("sections", s(&f), "分段", move |_| {
                analysis::sections_json(&f, min, len, noise)
            })
        }

        "transcribe" => {
            let f = src(p, ctx)?;
            let from = util::ps(p, "from")
                .map(|x| util::inp(x, ctx.root.as_deref()))
                .transpose()?;
            analysis::transcript(&f, from.as_deref())
        }

        "extract" => {
            let f = src(p, ctx)?;
            let i = media::probe(&f)?;
            let o = dst(p, ctx, &f, util::ps(p, "fmt").unwrap_or("wav"));
            let stream = util::f(p, "stream").unwrap_or(0.0) as usize;
            let silence = util::opt_b(p, "silence", false);
            let sr = util::f(p, "sr").unwrap_or(48000.0) as u32;
            let ch = util::f(p, "ch").unwrap_or(2.0) as u32;
            let enc = enc_of(p);
            let mut args: Vec<String> = vec![];
            if !i.has_audio && silence {
                args.push("-f".into());
                args.push("lavfi".into());
                args.push("-i".into());
                args.push(format!(
                    "anullsrc=r={}:cl={}",
                    sr,
                    if ch >= 6 { "5.1" } else if ch == 1 { "mono" } else { "stereo" }
                ));
                args.push("-t".into());
                args.push(util::t3(i.dur.max(0.1)).to_string());
                args.extend(ops::enc_args(&o, &enc_of(&json!({"sr": sr, "ch": ch}))));
            } else {
                args.push("-i".into());
                args.push(s(&f));
                args.push("-map".into());
                args.push(format!("0:a:{}", stream));
                args.push("-vn".into());
                args.extend(ops::enc_args(&o, &enc));
            }
            args.push(s(&o));
            let total = i.dur;
            let oo = o.clone();
            job("extract", s(&f), "提取音轨", move |j| {
                if !i.has_audio {
                    if !silence {
                        return Err(Fail::new("noaudio", "source has no audio track")
                            .hint("pass silence:true to create a silent bed for a voice-over"));
                    }
                }
                util::ensure_parent(&oo)?;
                ff::run(&args, Some(total), Some(j))?;
                out_summary(&oo)
            })
        }

        "fit" => {
            let f = src(p, ctx)?;
            let i = media::probe(&f)?;
            if !i.has_audio {
                return Err(Fail::new("noaudio", "source has no audio track").hint("run extract first"));
            }
            let video = util::ps(p, "video")
                .map(|v| util::inp(v, ctx.root.as_deref()))
                .transpose()?;
            let vi = video.as_ref().map(|v| media::probe(v)).transpose()?;
            let target = util::time(p, "dur")
                .or_else(|| util::time(p, "target"))
                .or_else(|| vi.as_ref().map(|x| x.dur))
                .ok_or_else(|| {
                    Fail::new("param", "fit needs \"dur\" or \"video\"")
                        .hint("fit in=song.mp3 video=clip.mp4 out=bed.wav")
                })?;
            if target <= 0.05 {
                return Err(Fail::new("param", "target duration must be > 0.05"));
            }
            // An agent that passes milliseconds, or a frame count, instead of seconds
            // would otherwise loop ffmpeg until the disk is gone. Reject it here.
            if target > 43200.0 {
                return Err(Fail::new("param", "implausible target duration")
                    .hint("dur is in seconds (max 43200 = 12h); to match a clip pass video=<file>"));
            }
            let fps = util::f(p, "fps");
            let tgt = match fps {
                Some(fr) if fr > 0.0 => util::snap_to(target, 1.0 / fr),
                _ => target,
            };
            let tol = util::f(p, "tol").unwrap_or(if fps.is_some() { 0.5 / fps.unwrap_or(30.0) } else { 0.05 });
            let max_rate = util::f(p, "max").unwrap_or(4.0);
            let fade = util::opt_b(p, "fade", true);
            let fo = util::time(p, "fo").unwrap_or(if fade { 0.35 } else { 0.0 });
            let fi = util::time(p, "fi").unwrap_or(0.0);
            let (mode, tempo) = decide_mode(i.dur, tgt, util::ps(p, "mode").unwrap_or("auto"), max_rate, tol);
            // Probed lazily: a one-shot CLI call should not pay for `ffmpeg -filters`
            // unless the job is actually a time-stretch.
            let mut rubber = false;
            if mode == "rate" {
                let want = util::ps(p, "engine").unwrap_or("auto");
                let have = ff::have_filter("rubberband");
                if want == "rubberband" && !have {
                    return Err(Fail::new("engine", "this ffmpeg build has no rubberband filter")
                        .hint("pass engine:\"atempo\", or use an ffmpeg built with --enable-librubberband"));
                }
                rubber = have && (want == "rubberband" || (want != "atempo" && (tempo - 1.0).abs() > 0.02));
            }
            let o = dst(p, ctx, &f, util::ps(p, "fmt").unwrap_or(""));
            let enc = enc_of(p);
            let loop_samples = ((i.dur * i.sr.max(1) as f64).ceil() as u64).max(1);
            let args = fit_args(&f, &o, tgt, mode, tempo, fi, fo, &enc, loop_samples, rubber);
            let mux = util::opt_b(p, "mux", false);
            let vid = video.clone();
            let oo = o.clone();
            let src_d = i.dur;
            job("fit", s(&f), "适配时长", move |j| {
                util::ensure_parent(&oo)?;
                ff::run(&args, Some(tgt.max(src_d)), Some(j))?;
                let got = media::probe(&oo)?.dur;
                let mut v = out_summary(&oo)?;
                v["target"] = json!(util::round(tgt, 3));
                v["mode"] = json!(mode);
                v["tempo"] = json!(util::round(tempo, 4));
                if mode == "rate" {
                    v["engine"] = json!(if rubber { "rubberband" } else { "atempo" });
                }
                v["err"] = json!(util::round(got - tgt, 3));
                v["from"] = json!(util::round(src_d, 3));
                if (got - tgt).abs() > tol {
                    v["note"] = json!("duration off target; add fps or check the source");
                }
                if mux {
                    let vd = vid.ok_or_else(|| Fail::new("param", "mux needs \"video\""))?;
                    let ext = {
                        let e = util::ext(&vd);
                        if e.is_empty() { "mp4".to_string() } else { e }
                    };
                    let final_out = oo.with_extension(&ext);
                    let d = media::mux(&vd, &oo, &final_out, Some(j))?;
                    v["mux"] = json!(util::round(d, 3));
                    v["final"] = json!(s(&final_out));
                }
                Ok(v)
            })
        }

        "cut" | "clip" | "trim" => {
            let f = src(p, ctx)?;
            let i = media::probe(&f)?;
            let a = util::time(p, "start").or_else(|| util::time(p, "from")).unwrap_or(0.0);
            let b = util::time(p, "end")
                .or_else(|| util::time(p, "to"))
                // `dur` is the spelling every other method uses; without it here an agent
                // passing start+dur silently got the rest of the file instead of a slice.
                .or_else(|| util::time(p, "start").zip(util::time(p, "len").or_else(|| util::time(p, "dur"))).map(|(x, l)| x + l))
                .unwrap_or(i.dur);
            if b <= a {
                return Err(Fail::new("param", format!("end {} must be after start {}", b, a)));
            }
            let mut ch = vec![json!({ "k": "trim", "start": a, "end": b })];
            if let Some(x) = util::time(p, "fi") {
                ch.push(json!({ "k": "fade", "v": x }));
            }
            if let Some(x) = util::time(p, "fo") {
                ch.push(json!({ "k": "fadeout", "v": x }));
            }
            let o = dst(p, ctx, &f, util::ps(p, "fmt").unwrap_or(""));
            let oo = o.clone();
            let enc = enc_of(p);
            job("cut", s(&f), "剪辑", move |j| {
                ops::apply(&f, &oo, &ch, &enc, Some(b - a), Some(j))?;
                out_summary(&oo)
            })
        }

        "silence" | "strip_silence" => {
            let f = src(p, ctx)?;
            let i = media::probe(&f)?;
            let o = dst(p, ctx, &f, util::ps(p, "fmt").unwrap_or(""));
            let noise = util::f(p, "noise");
            let enc = enc_of(p);
            let oo = o.clone();
            job("silence", s(&f), "去静音", move |j| {
                let st = measure::mono(&f)?;
                let dbs = st.dbs();
                if dbs.is_empty() {
                    return Err(Fail::new("empty", "no frames to analyse"));
                }
                let th = noise.unwrap_or_else(|| (crate::dsp::pct(&dbs, 10.0) + 8.0).max(-55.0).min(-25.0));
                let per = st.hop as f64 / st.sr as f64;
                let a = dbs.iter().position(|&d| d >= th).unwrap_or(0) as f64 * per;
                let b = dbs
                    .iter()
                    .rposition(|&d| d >= th)
                    .map(|k| (k + 1) as f64 * per)
                    .unwrap_or(i.dur)
                    .min(i.dur);
                if b <= a + 0.05 {
                    return Err(Fail::new("silent", "file is silent throughout"));
                }
                ops::apply(
                    &f,
                    &oo,
                    &[json!({ "k": "trim", "start": util::round(a, 3), "end": util::round(b, 3) })],
                    &enc,
                    Some(b - a),
                    Some(j),
                )?;
                let mut v = out_summary(&oo)?;
                v["removed"] = json!(util::round(i.dur - (b - a), 2));
                v["kept"] = json!([util::round(a, 2), util::round(b, 2)]);
                Ok(v)
            })
        }

        "separate" => {
            let f = src(p, ctx)?;
            let i = media::probe(&f)?;
            if !i.has_audio {
                return Err(Fail::new("noaudio", "source has no audio track"));
            }
            let mode = util::ps(p, "mode").unwrap_or("center").to_string();
            let dir = match util::ps(p, "out") {
                Some(d) => util::outp(d, ctx.root.as_deref()),
                None => session::workspace().join(format!("{}-stems", util::stem(&f))),
            };
            let keep = util::arr(p, "stems");
            let enc = enc_of(p);
            if mode == "ai" {
                return ai_separate(&f, &dir, &enc);
            }
            let mut plan: Vec<(String, Vec<Value>)> = vec![];
            let wants = |k: &str| keep.is_empty() || keep.iter().any(|x| x.as_str() == Some(k));
            if wants("vocal") && mode != "karaoke" {
                plan.push(("vocal".into(), vec![json!({ "k": "vocal" })]));
            }
            if wants("instrumental") || mode == "karaoke" {
                plan.push(("instrumental".into(), vec![json!({ "k": "karaoke" })]));
            }
            if wants("bass") {
                plan.push(("bass".into(), vec![json!({ "k": "lowpass", "v": 250.0 }), json!({ "k": "gain", "v": 2.0 })]));
            }
            if wants("treble") || wants("high") {
                plan.push(("high".into(), vec![json!({ "k": "highpass", "v": 4000.0 })]));
            }
            let dd = dir.clone();
            job("separate", s(&f), "分离", move |j| {
                std::fs::create_dir_all(&dd)?;
                let mut out = json!({ "dir": s(&dd), "engine": "center-channel" });
                let total = plan.len().max(1);
                for (qi, (n, chain)) in plan.iter().enumerate() {
                    let o = dd.join(format!("{}.wav", n));
                    j.set_stage(&format!("分离 {}", n));
                    j.set_range((qi * 100 / total) as u32, (100 / total) as u32);
                    ops::apply(&f, &o, chain, &enc, Some(i.dur), Some(j))?;
                    out[n.as_str()] = json!(s(&o));
                }
                out["note"] = json!("phase-cancel split; needs a mono-compatible source. separate mode:ai uses demucs when installed");
                Ok(out)
            })
        }

        "split" => {
            let f = src(p, ctx)?;
            let i = media::probe(&f)?;
            let by = util::ps(p, "by").unwrap_or("silence").to_string();
            let dir = match util::ps(p, "out") {
                Some(d) => util::outp(d, ctx.root.as_deref()),
                None => session::workspace().join(format!("{}-parts", util::stem(&f))),
            };
            let min = util::f(p, "min").unwrap_or(0.35);
            let len = util::f(p, "len").unwrap_or(0.25);
            let cap = util::f(p, "cap").unwrap_or(60.0) as usize;
            let enc = enc_of(p);
            let parts: Vec<(f64, f64, String)> = if by == "n" {
                let n = util::f(p, "n").unwrap_or(4.0).clamp(1.0, 200.0) as usize;
                let step = i.dur / n as f64;
                (0..n)
                    .map(|k| (util::round(k as f64 * step, 3), util::round((k + 1) as f64 * step, 3), "part".into()))
                    .collect()
            } else {
                analysis::segments(&f, min, len, util::f(p, "noise"))?
                    .0
                    .iter()
                    .map(|x| (x.t0, x.t1, x.kind.clone()))
                    .collect()
            };
            let dd = dir.clone();
            let ff2 = f.clone();
            job("split", s(&f), "拆分", move |j| {
                std::fs::create_dir_all(&dd)?;
                let mut files = vec![];
                let total = cap.min(parts.len()).max(1);
                for (k, (a, b, kind)) in parts.iter().enumerate().take(cap) {
                    let o = dd.join(format!("{:02}-{}-{:.1}s.wav", k + 1, kind, b - a));
                    j.set_stage(&format!("拆分 {}/{}", k + 1, total));
                    // claim this file's slice of the bar, then let ffmpeg fill it
                    j.set_range((k * 100 / total) as u32, (100 / total) as u32);
                    ops::apply(&ff2, &o, &[json!({ "k": "trim", "start": a, "end": b })], &enc, Some(b - a), Some(j))?;
                    files.push(json!({ "i": k + 1, "t0": a, "t1": b, "dur": util::round(b - a, 2), "kind": kind, "path": s(&o) }));
                }
                let mut v = json!({ "dir": s(&dd), "n": files.len(), "of": parts.len(), "files": files });
                if parts.is_empty() {
                    // An empty list with no explanation leaves the agent with nothing to act on.
                    v["note"] = json!("no segments found: nothing crosses the silence threshold. use by=n to split evenly, or raise noise/min");
                }
                Ok(v)
            })
        }

        "mix" => {
            let tracks = p
                .get("tracks")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            if tracks.is_empty() {
                return Err(Fail::new("param", "mix needs \"tracks\"")
                    .hint("tracks:[{in:bed.wav,start:0,gain:-6},{in:voice.wav}]"));
            }
            let mut inputs: Vec<(PathBuf, f64, f64)> = vec![];
            for t in &tracks {
                let f = src(t, ctx)?;
                inputs.push((
                    f.clone(),
                    util::time(t, "start").unwrap_or(0.0),
                    util::f(t, "gain").unwrap_or(0.0),
                ));
            }
            let first = inputs[0].0.clone();
            let o = dst(&json!({ "out": util::ps(p, "out").unwrap_or("") }), ctx, &first, util::ps(p, "fmt").unwrap_or("wav"));
            let target = match util::time(p, "target") {
                Some(t) => Some(t),
                None => util::ps(p, "video")
                    .map(|v| util::inp(v, ctx.root.as_deref()))
                    .transpose()?
                    .as_ref()
                    .map(|x| media::probe(x))
                    .transpose()?
                    .map(|i| i.dur),
            };
            let duck = util::opt_b(p, "duck", false);
            let norm = util::f(p, "norm");
            let fade = util::f(p, "fade").unwrap_or(0.0);
            let enc = enc_of(p);
            let oo = o.clone();
            let n = inputs.len();
            job("mix", format!("{} tracks", n), "混音", move |j| {
                util::ensure_parent(&oo)?;
                let mut a: Vec<String> = vec![];
                for (f, _, _) in inputs.iter() {
                    a.push("-i".into());
                    a.push(s(f));
                }
                let mut fc: Vec<String> = vec![];
                let mut lab: Vec<String> = vec![];
                for (i, (_, st, gn)) in inputs.iter().enumerate() {
                    let ms = (st * 1000.0).max(0.0) as u64;
                    fc.push(format!("[{}:a]volume={:.3}dB,adelay={}|{}[p{}]", i, gn, ms, ms, i));
                    lab.push(format!("[p{}]", i));
                }
                if duck && n >= 2 {
                    let si = n - 1;
                    let bed: Vec<String> = lab.iter().take(si).cloned().collect();
                    fc.push(format!("{}amix=inputs={}:duration=longest:normalize=0[bd]", bed.join(""), bed.len()));
                    fc.push(format!("[bd][p{}]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[dg]", si));
                    fc.push(format!("[dg][p{}]amix=inputs=2:duration=longest:normalize=0[mx]", si));
                } else {
                    fc.push(format!("{}amix=inputs={}:duration=longest:normalize=0[mx]", lab.join(""), n));
                }
                let mut cur = "[mx]".to_string();
                if let Some(i) = norm {
                    fc.push(format!("{}loudnorm=I={}:TP=-1.5:LRA=11[fx]", cur, i));
                    cur = "[fx]".into();
                }
                if fade > 0.0 {
                    if let Some(t) = target.filter(|x| *x > fade) {
                        fc.push(format!("{}afade=t=out:st={:.3}:d={:.3}[fx2]", cur, t - fade, fade));
                        cur = "[fx2]".into();
                    }
                }
                a.push("-filter_complex".into());
                a.push(fc.join(";"));
                a.push("-map".into());
                a.push(cur);
                if let Some(t) = target {
                    a.push("-t".into());
                    a.push(util::t3(t).to_string());
                }
                a.extend(ops::enc_args(&oo, &enc));
                a.push(s(&oo));
                ff::run(&a, target, Some(j))?;
                let mut v = out_summary(&oo)?;
                v["tracks"] = json!(n);
                Ok(v)
            })
        }

        "fx" | "render" | "convert" | "export" => {
            let f = src(p, ctx)?;
            let mut ch = chain_of(p)?;
            let fdur = media::probe(&f)?.dur;
            if let Some(x) = util::time(p, "fi") {
                ch.insert(0, json!({ "k": "fade", "v": x }));
            }
            if let Some(x) = util::time(p, "fo") {
                ch.push(json!({ "k": "fadeout", "v": x }));
            }
            if let Some(x) = util::time(p, "start") {
                ch.insert(0, json!({ "k": "trim", "start": x, "end": util::time(p, "end").unwrap_or(fdur) }));
            }
            let ext = util::ps(p, "fmt")
                .map(|x| x.to_string())
                .or_else(|| util::ps(p, "out").map(|o| util::ext(&PathBuf::from(o))))
                .unwrap_or_default();
            let o = dst(p, ctx, &f, &ext);
            let enc = enc_of(p);
            let oo = o.clone();
            let n = ch.len();
            job(if m == "fx" { "fx" } else { "render" }, s(&f), "渲染", move |j| {
                ops::apply(&f, &oo, &ch, &enc, None, Some(j))?;
                let mut v = out_summary(&oo)?;
                v["applied"] = json!(n);
                Ok(v)
            })
        }

        "batch" => {
            let list = p.get("jobs").or_else(|| p.get("calls")).cloned().unwrap_or(Value::Null);
            let arr = list.as_array().cloned().ok_or_else(|| {
                Fail::new("param", "batch needs \"jobs\"").hint("jobs:[{\"op\":\"fit\",\"args\":{...}},{\"op\":\"score\",\"args\":{...}}]")
            })?;
            let mut out = vec![];
            let mut n_ok = 0usize;
            for (i, j) in arr.iter().enumerate() {
                let op = util::ps(j, "op").or_else(|| util::ps(j, "m")).unwrap_or("");
                let args = j.get("args").cloned().unwrap_or_else(|| json!({}));
                match dispatch(op, &args, ctx) {
                    Ok(v) => {
                        n_ok += 1;
                        out.push(json!({ "i": i, "op": op, "ok": true, "out": v.get("out").cloned().unwrap_or(v.get("path").cloned().unwrap_or(Value::Null)), "dur": v.get("dur").cloned().unwrap_or(Value::Null) }));
                    }
                    Err(e) => out.push(json!({ "i": i, "op": op, "ok": false, "e": e.msg, "code": e.code })),
                }
            }
            Ok(json!({ "n": arr.len(), "ok": n_ok, "r": out }))
        }

        "config" => {
            if p.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                session::write_config(p)
            } else {
                let mut c = session::read_config();
                if let Some(o) = c.as_object_mut() {
                    o.insert("_ffmpeg".into(), json!(s(&ff::which("ffmpeg"))));
                    o.insert("_work".into(), json!(s(&session::workspace())));
                }
                Ok(json!({ "config": c }))
            }
        }

        "presets" => Ok(json!({
            "presets": ops::preset_names().iter().map(|n| json!({"n": n, "chain": ops::preset(n).map(|c| c.iter().map(|x| x["k"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>().join(">")).unwrap_or_default()})).collect::<Vec<_>>()
        })),

        "ops" => Ok(ops::ops_json()),

        "caps" => Ok(caps()?),

        "doctor" => Ok(doctor()?),

        "jobs" => Ok(jobs::snapshot()),

        "cancel" => {
            let id = util::req_f(p, "id")? as u64;
            let ok = jobs::cancel(id);
            Ok(json!({ "ok": ok, "id": id }))
        }

        "log" => Ok(session::read_log(
            util::f(p, "n").unwrap_or(20.0) as usize,
            util::opt_b(p, "ui", false),
        )),
        "clear" => {
            if util::ps(p, "what").unwrap_or("log") == "log" {
                Ok(session::clear_log())
            } else {
                Ok(json!({ "ok": false, "e": "what must be log" }))
            }
        }

        "project" => {
            if p.get("data").is_some() || util::ps(p, "save").is_some() {
                let name = util::ps(p, "name")
                    .or_else(|| util::ps(p, "save"))
                    .unwrap_or("untitled");
                let r = session::save_project(name, p.get("data").unwrap_or(&Value::Null))?;
                // remember it, so a bare `{load:true}` from the UI gets the same one back
                let _ = session::write_config(&json!({ "last_project": name }));
                return Ok(r);
            }
            match p.get("load") {
                Some(Value::Bool(true)) => {
                    let name = session::config_str("last_project").unwrap_or_else(|| "untitled".into());
                    session::load_project(&name)
                }
                Some(Value::String(n)) => session::load_project(n),
                _ => Ok(session::list_projects()),
            }
        }

        "demo" => demo(ctx),

        "pick" => Ok(json!({ "path": Value::Null, "note": "native dialog only inside the desktop app" })),

        "reveal" => {
            let f = src(p, ctx)?;
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("explorer").arg(format!("/select,{}", s(&f))).spawn();
                Ok(json!({ "ok": true }))
            }
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("open").args(["-R", &s(&f)]).spawn();
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                let _ = std::process::Command::new("xdg-open").arg(f.parent().map(s).unwrap_or_default()).spawn();
                Ok(json!({ "ok": true }))
            }
        }

        "help" => Ok(json!({ "use": cheatsheet() })),

        _ => Err(Fail::new("method", format!("unknown method \"{}\"", m)).hint("agentaudio caps  ->  method list")),
    }
}

fn ai_separate(f: &Path, dir: &Path, enc: &ops::Enc) -> R<Value> {
    use std::process::Command;
    let found = ["demucs", "demucs.exe"]
        .iter()
        .any(|e| Command::new(e).arg("--help").output().is_ok());
    if !found {
        return Err(Fail::new("engine", "demucs is not installed")
            .hint("pip install demucs, or use mode:center for a phase-cancel split"));
    }
    std::fs::create_dir_all(dir)?;
    let mut c = Command::new("demucs");
    c.args(["-o", &s(dir), "--two", &s(f)]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let o = c.output().map_err(|e| Fail::new("engine", e.to_string()))?;
    if !o.status.success() {
        return Err(Fail::new("engine", String::from_utf8_lossy(&o.stderr).lines().next_back().unwrap_or("demucs failed").to_string()));
    }
    let base = dir.join("htdemucs").join(util::stem(f));
    let mut v = json!({ "engine": "demucs", "dir": s(&base) });
    for n in ["vocals", "no_vocals", "drums", "bass", "other"] {
        let p = base.join(format!("{}.wav", n));
        if p.exists() {
            v[n] = json!(s(&p));
        }
    }
    let _ = enc;
    Ok(v)
}

pub const TOOLS: &[(&str, &str, &str)] = &[
    ("probe", "duration, sample rate, channels, codec of an audio or video file", "path:s"),
    ("peaks", "waveform envelope for drawing", "path:s n:n ch:n enc:s"),
    ("score", "measured quality: score, clarity, balance, dynamics, noise, LUFS", "path:s"),
    ("levels", "per-channel peak and RMS in dB", "path:s"),
    ("sections", "energy segmentation with kinds", "path:s min:n len:n noise:n"),
    ("transcribe", "timed lines from a cue file, or a local whisper engine", "path:s from:s"),
    ("extract", "pull the audio track out of a video", "in:s out:s stream:n silence:b fmt:s sr:n ch:n"),
    ("fit", "make audio exactly match a target or a video's duration", "in:s out:s video:s dur:n mode:s engine:s fps:n fade:b fi:n fo:n max:n tol:n mux:b fmt:s"),
    ("cut", "clip a time range with fades", "in:s out:s start:s end:s len:s|dur:s fi:s fo:s fmt:s"),
    ("silence", "trim leading and trailing silence", "in:s out:s noise:n fmt:s"),
    ("separate", "split vocal and instrumental (center channel or demucs)", "in:s out:s mode:s stems:a"),
    ("split", "cut into separate files at silences, or into n equal parts", "in:s out:s by:s min:n n:n cap:n"),
    ("mix", "mix layers with offsets, gain and ducking", "tracks:a out:s target:n duck:n norm:n fade:n fmt:s"),
    ("fx", "apply an effect chain", "in:s out:s chain:a preset:s fi:s fo:s sr:n ch:n br:n"),
    ("render", "convert format and sample rate, optionally with a chain", "in:s out:s fmt:s sr:n ch:n br:n chain:a preset:s"),
    ("batch", "run many calls in one round trip", "jobs:a"),
    ("presets", "named effect chains", ""),
    ("config", "read or set saved settings (ffmpeg path, out dir)", "ffmpeg:s work:s"),
    ("caps", "methods, ops, presets, short keys, MCP config", ""),
    ("doctor", "environment check", ""),
    ("jobs", "running and finished jobs with progress", ""),
    ("cancel", "stop a running job", "id:n"),
    ("log", "recent agent calls", "n:n ui:t"),
    ("clear", "empty the call log", "what:s"),
    ("project", "save, load or list a session", "name:s data:o load:s"),
    ("demo", "create sample media to test the pipeline", ""),
    ("reveal", "show a file in the file manager", "in:s"),
];

fn typ(c: char) -> &'static str {
    match c {
        'n' => "number",
        'b' => "boolean",
        'a' => "array",
        'o' => "object",
        _ => "string",
    }
}

pub fn mcp_tools() -> Value {
    let mut out = vec![];
    for (n, d, sig) in TOOLS {
        let mut props = serde_json::Map::new();
        let mut req = vec![];
        for tok in sig.split_whitespace() {
            let mut kv = tok.splitn(2, ':');
            let k = kv.next().unwrap_or("");
            let t = kv.next().unwrap_or("s");
            props.insert(k.into(), json!({ "type": typ(t.chars().next().unwrap_or('s')) }));
            if matches!(k, "in" | "path" | "tracks" | "jobs" | "id") {
                req.push(json!(k));
            }
        }
        let consumes_file = !["caps","doctor","jobs","presets","log","clear","project","cancel","batch","ops","probe","peaks","score","levels","sections","transcribe","demo","reveal"].contains(n);
        if consumes_file && !props.contains_key("out") {
            props.insert("out".into(), json!({ "type": "string", "description": "output file; default is the workspace" }));
        }
        out.push(json!({
            "name": n,
            "description": d,
            "inputSchema": { "type": "object", "properties": props, "required": req, "additionalProperties": true }
        }));
    }
    Value::Array(out)
}

pub fn caps() -> R<Value> {
    let exe = std::env::current_exe().ok();
    let cli = exe
        .as_ref()
        .and_then(|p| p.parent().map(|d| d.join("agentaudio.exe")))
        .filter(|p| p.exists())
        .map(|p| s(&p))
        .or_else(|| exe.as_ref().map(|p| s(p)));
    Ok(json!({
        "v": crate::VERSION,
        "tools": TOOLS.iter().map(|(n, d, _)| json!({ "n": n, "d": d })).collect::<Vec<_>>(),
        "ops": ops::ops_json(),
        "presets": ops::preset_names(),
        "keys": {
            "dur": "seconds", "sr": "sample rate", "ch": "channels", "tp": "true peak dB",
            "lufs": "integrated loudness", "err": "seconds off target", "fmt": "file extension",
            "mode:rate": "time-stretch (rubberband when available)", "mode:trim": "cut to length", "mode:loop": "repeat to length"
        },
        "dir": s(&session::workspace()),
        "http": { "port": crate::http::port(), "up": crate::http::port() > 0 },
        "mcp": { "cmd": cli, "args": ["mcp"] },
        "use": cheatsheet(),
    }))
}

/// One block an agent can read once instead of 26 tool schemas.
pub fn cheatsheet() -> Vec<String> {
    vec![
        "agentaudio <method> k=v k=v            terse CLI, JSON on stdout".into(),
        "agentaudio fit in=song.mp3 video=clip.mp4 out=bed.wav   # 70s -> 40s exactly".into(),
        "agentaudio extract in=clip.mp4 out=a.wav                # audio out of video".into(),
        "agentaudio fx in=a.wav preset=voice out=v.wav           # one word, six filters".into(),
        "agentaudio batch '[{\"op\":\"score\",\"args\":{\"path\":\"a.wav\"}}]'   # N calls, 1 round trip".into(),
        "agentaudio mcp                       # stdio MCP server for agents".into(),
        "agentaudio http --port 8787          # REST: POST /api/<method>, GET /caps, /f?path=".into(),
        "flags: --fields a,b  --pretty  --root DIR  --quiet".into(),
        "errors: {e,code,hint}; codes nofile noaudio param op ffmpeg engine measure method".into(),
        "numbers are seconds or dB unless the key says otherwise".into(),
    ]
}

pub fn doctor() -> R<Value> {
    let ver = ff::version();
    let ok = !ver.starts_with("ffmpeg: not found");
    let work = session::workspace();
    let probe_file = work.join(".write-test");
    let writable = std::fs::write(&probe_file, b"x").is_ok();
    let _ = std::fs::remove_file(&probe_file);
    let hint = if !ok {
        Some("install ffmpeg, or set it: agentaudio config ffmpeg=C:\\ffmpeg\\bin\\ffmpeg.exe")
    } else if !writable {
        Some("output folder is not writable; set AGENTAUDIO_WORK or change it in 设置")
    } else {
        None
    };
    Ok(json!({
        "ok": ok && writable,
        "ffmpeg": ok,
        "ver": ver.replacen("ffmpeg version ", "", 1).split(' ').next().unwrap_or("?").to_string(),
        "bin": s(&ff::which("ffmpeg")),
        "filters": ff::filters().len(),
        "loudnorm": ff::have_filter("loudnorm"),
        "afftdn": ff::have_filter("afftdn"),
        "sidechaincompress": ff::have_filter("sidechaincompress"),
        "rubberband": ff::have_filter("rubberband"),
        "home": s(&session::root()),
        "work": s(&work),
        "writable": writable,
        "running": jobs::running(),
        "hint": match hint { Some(h) => Value::String(h.to_string()), None => Value::Null },
    }))
}

/// Sample media so the whole pipeline is testable with zero user files. The
/// names mirror the real complaint: a 70s song and a 40s silent clip.
pub fn demo(ctx: &Ctx) -> R<Value> {
    let dir = ctx.root.clone().unwrap_or_else(|| session::root().join("samples"));
    std::fs::create_dir_all(&dir)?;
    let song = dir.join("song70.wav");
    let clip = dir.join("clip40.mp4");
    let voice = dir.join("voice8.wav");
    let mut made = vec![];
    let mut err = None;
    let _ = dur_of(0.0);
    for (name, args, want) in [
        (
            "song70.wav",
            vec![
                "-f".into(), "lavfi".into(),
                "-i".into(), format!("aevalsrc=0.2*sin(2*PI*220*t)+0.16*sin(2*PI*277.2*t)+0.12*sin(2*PI*329.6*t)+0.1*sin(2*PI*110*t):d=70"),
                "-ac".into(), "2".into(), "-ar".into(), "44100".into(),
                s(&song),
            ],
            song.clone(),
        ),
        (
            "voice8.wav",
            vec![
                "-f".into(), "lavfi".into(),
                "-i".into(), "anoisesrc=color=pink:amplitude=0.3:duration=8".into(),
                "-af".into(), "highpass=f=120,lowpass=f=7000".into(),
                "-ac".into(), "1".into(), "-ar".into(), "44100".into(),
                s(&voice),
            ],
            voice.clone(),
        ),
        (
            "clip40.mp4",
            vec![
                "-f".into(), "lavfi".into(), "-i".into(), "testsrc2=size=640x360:rate=30:duration=40".into(),
                "-an".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:v".into(), "libx264".into(), "-t".into(), "40".into(), s(&clip),
            ],
            clip.clone(),
        ),
    ] {
        if want.exists() {
            made.push(json!({ "f": name, "path": s(&want), "dur": util::round(media::probe(&want).map(|i| i.dur).unwrap_or(0.0), 2), "cached": true }));
            continue;
        }
        match ff::run(&args, Some(20.0), None) {
            Ok(_) => {
                let d = media::probe(&want).map(|i| i.dur).unwrap_or(0.0);
                made.push(json!({ "f": name, "path": s(&want), "dur": util::round(d, 2) }));
            }
            Err(e) => err = Some(e),
        }
    }
    let mut v = json!({ "dir": s(&dir), "files": made });
    if let Some(e) = err {
        v["e"] = json!(e.msg);
    }
    Ok(v)
}

fn dur_of(x: f64) -> String {
    format!("{}", x as i64)
}
