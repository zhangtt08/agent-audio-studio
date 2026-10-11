//! Op -> ffmpeg filter translation. This is the single definition of the effect
//! set: the UI chain editor, the CLI `fx` verb and the MCP `fx` tool all end up here.

use crate::dsp;
use crate::error::{Fail, R};
use crate::{ff, media, util};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Clone, Copy, Debug)]
pub struct Ctx {
    pub dur: f64,
    pub sr: f64,
    pub ch: u32,
}

pub fn ctx_for(path: &Path) -> R<Ctx> {
    let i = media::probe(path)?;
    Ok(Ctx {
        dur: i.dur,
        sr: if i.sr > 0 { i.sr as f64 } else { 44100.0 },
        ch: i.ch.max(1),
    })
}

#[derive(Clone, Debug, Default)]
pub struct Enc {
    pub sr: Option<u32>,
    pub ch: Option<u32>,
    pub br: Option<u32>,
    pub q: Option<u32>,
}

pub fn enc_args(out: &Path, e: &Enc) -> Vec<String> {
    let ext = util::ext(out);
    let mut a: Vec<String> = vec![];
    let codec = match ext.as_str() {
        "wav" => Some("pcm_s16le"),
        "flac" => Some("flac"),
        "mp3" => Some("libmp3lame"),
        "ogg" => Some("libvorbis"),
        "opus" => Some("libopus"),
        "m4a" | "aac" => Some("aac"),
        _ => None,
    };
    if let Some(c) = codec {
        a.push("-c:a".into());
        a.push(c.into());
    }
    if ext == "m4a" || ext == "aac" {
        a.push("-bsf:a".into());
        a.push("aac_adtstoasc".into());
    }
    if let Some(b) = e.br {
        a.push("-b:a".into());
        a.push(format!("{}k", b));
    } else if ext == "mp3" {
        a.push("-b:a".into());
        a.push("192k".into());
    }
    if let Some(q) = e.q {
        if ext == "ogg" || ext == "opus" {
            a.push("-q:a".into());
            a.push(q.to_string());
        }
    }
    if let Some(sr) = e.sr {
        a.push("-ar".into());
        a.push(sr.to_string());
    }
    if let Some(c) = e.ch {
        a.push("-ac".into());
        a.push(c.to_string());
    }
    a
}

pub fn kind(op: &Value) -> String {
    util::ps(op, "k")
        .or_else(|| util::ps(op, "op"))
        .or_else(|| util::ps(op, "name"))
        .unwrap_or("")
        .to_lowercase()
}

fn g(op: &Value, k: &str) -> Option<f64> {
    util::f(op, k)
}

/// Translate one op into one or more ffmpeg filters.
pub fn build(op: &Value, ctx: Ctx) -> R<String> {
    let k = kind(op);
    let v = g(op, "v").or_else(|| g(op, "value")).or_else(|| g(op, "amount"));
    let ok = |s: String| Ok(s);
    macro_rules! need {
        ($d:expr) => {
            v.ok_or_else(|| {
                Fail::new("param", format!("\"{}\" needs \"v\"", k)).hint(format!("example: {{\"k\":\"{}\",\"v\":{}}}", k, $d))
            })?
        };
    }
    match k.as_str() {
        "" => Err(Fail::new("param", "op missing \"k\"")),
        "gain" | "vol" | "volume" => {
            let x = need!(-3);
            if util::opt_b(op, "amp", false) {
                ok(format!("volume={:.6}", x))
            } else {
                ok(format!("volume={:.3}dB", x))
            }
        }
        "fade" | "fadein" | "fade_in" | "in" => {
            let d = v.unwrap_or(0.3);
            let st = util::f(op, "st").unwrap_or(0.0);
            ok(format!("afade=t=in:st={:.4}:d={:.4}", st, d))
        }
        "fadeout" | "fade_out" | "out" => {
            let d = v.unwrap_or(0.5);
            let st = util::f(op, "st").unwrap_or((ctx.dur - d).max(0.0));
            ok(format!("afade=t=out:st={:.4}:d={:.4}", st, d))
        }
        "trim" | "cut" => {
            let a = util::time(op, "start").or_else(|| util::time(op, "st")).unwrap_or(0.0);
            let b = util::time(op, "end")
                .or_else(|| util::time(op, "e"))
                .unwrap_or(ctx.dur);
            if b <= a {
                return Err(Fail::new("param", format!("trim end {} <= start {}", b, a)));
            }
            ok(format!(
                "atrim=start={:.4}:end={:.4},asetpts=PTS-STARTPTS",
                a, b
            ))
        }
        "head" => ok(format!(
            "atrim=end={:.4},asetpts=PTS-STARTPTS",
            need!(5.0)
        )),
        "tail" => ok(format!(
            "atrim=start={:.4},asetpts=PTS-STARTPTS",
            need!(5.0)
        )),
        "speed" | "tempo" => {
            let r = need!(1.05);
            if r <= 0.0 {
                return Err(Fail::new("param", "speed ratio must be > 0"));
            }
            let f: Vec<String> = util::atempo_chain(r)
                .iter()
                .map(|x| format!("atempo={:.6}", x))
                .collect();
            ok(f.join(","))
        }
        "pitch" => {
            let n = need!(2.0);
            let r = 2f64.powf(n / 12.0);
            let nsr = (ctx.sr * r).round().max(3000.0).min(384000.0) as u64;
            ok(format!("asetrate={},aresample={}", nsr, ctx.sr as u64))
        }
        "rate" => {
            let x = need!(48000);
            ok(format!("aresample={}", x as u64))
        }
        "highpass" | "hp" => ok(format!("highpass=f={}", need!(80.0))),
        "lowpass" | "lp" => ok(format!("lowpass=f={}", need!(12000.0))),
        "bandpass" | "bp" => ok(format!("bandpass=f={}:width={}", need!(1000.0), util::f(op, "w").unwrap_or(1.0))),
        "bass" => ok(format!("bass=g={}:f={}", need!(3.0), util::f(op, "f").unwrap_or(120.0))),
        "treble" => ok(format!("treble=g={}:f={}", need!(3.0), g(op, "freq").unwrap_or(6000.0))),
        "eq" => {
            let lo = g(op, "low").unwrap_or(0.0);
            let mi = g(op, "mid").unwrap_or(0.0);
            let hi = g(op, "high").unwrap_or(0.0);
            let mut f = vec![];
            if lo != 0.0 {
                f.push(format!("equalizer=f=100:t=q:w=1:g={}", lo));
            }
            if mi != 0.0 {
                f.push(format!("equalizer=f=1500:t=q:w=1:g={}", mi));
            }
            if hi != 0.0 {
                f.push(format!("equalizer=f=8000:t=q:w=1:g={}", hi));
            }
            if f.is_empty() {
                return Err(Fail::new("param", "eq needs low/mid/high"));
            }
            ok(f.join(","))
        }
        "denoise" | "dn" => {
            let n = v.unwrap_or(12.0);
            if !ff::have_filter("afftdn") {
                return Err(Fail::new("filter", "this ffmpeg build has no afftdn").hint("try `anlmdn` or update ffmpeg"));
            }
            ok(format!("afftdn=nr={:.1}:nf=-35", n))
        }
        "deesser" => ok(format!("deesser=i={}", v.unwrap_or(0.2))),
        "compress" | "comp" => ok(format!(
            "acompressor=threshold={}dB:ratio={}:attack={}:release={}:makeup={}",
            g(op, "thr").unwrap_or(-18.0),
            g(op, "ratio").unwrap_or(3.0),
            g(op, "attack").unwrap_or(20.0),
            g(op, "release").unwrap_or(250.0),
            g(op, "makeup").unwrap_or(1.0)
        )),
        "limiter" | "peak" => {
            let l = crate::dsp::db_gain(g(op, "db").unwrap_or(-1.0));
            ok(format!("alimiter=level_in=1:level_out=1:limit={:.4}:attack=5:release=50", l))
        }
        "loudnorm" | "ln" => {
            let i = g(op, "i").unwrap_or(-16.0);
            let tp = g(op, "tp").unwrap_or(-1.5);
            let lra = g(op, "lra").unwrap_or(11.0);
            if let (Some(mi), Some(mtp)) = (g(op, "measured_i"), g(op, "measured_tp")) {
                return ok(format!(
                    "loudnorm=I={}:TP={}:LRA={}:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear={}:print_format=summary",
                    i,
                    tp,
                    lra,
                    mi,
                    mtp,
                    g(op, "measured_lra").unwrap_or(11.0),
                    g(op, "measured_thresh").unwrap_or(-30.0),
                    g(op, "offset").unwrap_or(0.0),
                    if util::opt_b(op, "linear", true) { "true" } else { "false" }
                ));
            }
            ok(format!("loudnorm=I={}:TP={}:LRA={}", i, tp, lra))
        }
        "norm" | "normalize" => {
            let tgt = g(op, "db").unwrap_or(-0.1);
            let gain = g(op, "measured").ok_or_else(|| {
                Fail::new("internal", "normalize needs a measured peak; call through render()")
            })?;
            ok(format!("volume={:.3}dB", tgt - gain))
        }
        "rms" => ok(format!("loudnorm=I={}:TP=-1.5:LRA=11", need!(-18.0))),
        "reverse" => ok("areverse".into()),
        "mono" => ok(if ctx.ch == 1 {
            "anull".into()
        } else {
            "pan=mono|c0=.5*c0+.5*c1".into()
        }),
        "stereo" => ok(if ctx.ch == 1 {
            "pan=stereo|c0=c0|c1=c0".into()
        } else {
            "anull".into()
        }),
        "karaoke" | "unvoice" | "inst" => ok(if ctx.ch >= 2 {
            "pan=stereo|c0=c0-c1|c1=c1-c0".into()
        } else {
            "anull".into()
        }),
        "vocal" => ok(if ctx.ch >= 2 {
            "pan=mono|c0=.5*c0+.5*c1,highpass=f=90,lowpass=f=11000".into()
        } else {
            "highpass=f=90,lowpass=f=11000".into()
        }),
        "widen" => ok(if ctx.ch >= 2 {
            format!("stereowiden=delay={}:feedback={}:crossfeed={}", v.unwrap_or(15.0), 0.3, 0.3)
        } else {
            "pan=stereo|c0=c0|c1=c0".into()
        }),
        "reverb" => ok(format!(
            "aecho=0.8:0.88:{}:{}",
            g(op, "ms").unwrap_or(60.0) as u32,
            v.unwrap_or(0.25)
        )),
        "echo" => ok(format!("aecho=0.8:0.9:{}:{}", g(op, "ms").unwrap_or(250.0) as u32, v.unwrap_or(0.4))),
        "delay" => {
            let ms = need!(200.0) as u64;
            ok(if ctx.ch >= 2 {
                format!("adelay={}l|{}l", ms, ms)
            } else {
                format!("adelay={}", ms)
            })
        }
        "tremolo" => ok(format!("tremolo=f={}:d={}", v.unwrap_or(6.0), g(op, "depth").unwrap_or(0.5))),
        "vibrato" => ok(format!("vibrato=f={}:d={}", v.unwrap_or(6.0), g(op, "depth").unwrap_or(0.5))),
        "flanger" => ok("flanger".into()),
        "silence_remove" | "strip_silence" => ok(format!(
            "silenceremove=start_periods=1:stop_periods=-1:start_duration={}:start_threshold={}dB:stop_duration={}:stop_threshold={}dB:detection=peak",
            g(op, "dur").unwrap_or(0.5),
            g(op, "noise").unwrap_or(-40.0),
            g(op, "dur").unwrap_or(0.5),
            g(op, "noise").unwrap_or(-40.0) + 3.0
        )),
        "dynnorm" => ok(format!("dynaudnorm=f={}:g={}", g(op, "frame").unwrap_or(200.0) as u64, g(op, "gain").unwrap_or(15.0) as u64)),
        "pad" => ok("apad".into()),
        "pan_expr" | "pan" => {
            let e = util::ps(op, "expr").ok_or_else(|| Fail::new("param", "pan needs \"expr\""))?;
            if e.contains(';') || e.contains("-f") {
                return Err(Fail::new("param", "bad pan expression"));
            }
            ok(format!("pan={}", e))
        }
        "aformat" => ok(format!(
            "aformat=sample_fmts=fltp:sample_rates={}:channel_layouts={}",
            g(op, "sr").map(|x| x as u64).unwrap_or(ctx.sr as u64),
            match g(op, "ch").unwrap_or(ctx.ch as f64) as u32 {
                1 => "mono",
                6 => "5.1",
                _ => "stereo",
            }
        )),
        "anull" | "noop" => ok("anull".into()),
        "duck" | "sidechain" => Err(Fail::new("op", "\"duck\" needs two inputs").hint("use mix with duck:{source:..}")),
        "mix" => Err(Fail::new("op", "\"mix\" needs multiple inputs").hint("use the mix method")),
        other => Err(Fail::new("op", format!("unknown op \"{}\"", other)).hint("list ops with `agentaudio caps`")),
    }
}

pub fn chain(ops: &[Value], ctx: Ctx) -> R<String> {
    let mut parts: Vec<String> = vec![];
    for o in ops {
        let s = build(o, ctx)?;
        if s != "anull" {
            parts.push(s);
        }
    }
    if parts.is_empty() {
        parts.push("anull".into());
    }
    Ok(parts.join(","))
}

/// Ops that must measure the source before they can be expressed as a filter.

fn json_block(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut start: Option<usize> = None;
    let mut depth = 0i32;
    let mut best: Option<(usize, usize)> = None;
    for (i, c) in chars.iter().enumerate() {
        match c {
            '{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            '}' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(a) = start {
                        best = Some((a, i + 1));
                    }
                }
            }
            _ => {}
        }
    }
    best.map(|(a, b)| chars[a..b].iter().collect())
}

/// Rewrite ops that need a measurement pass into fully-specified ops.
pub fn pre_measure(in_path: &Path, ops: &[Value], ctx: Ctx) -> R<Vec<Value>> {
    let mut out = vec![];
    let mut measured_peak: Option<f64> = None;
    for o in ops {
        let k = kind(o);
        if matches!(k.as_str(), "norm" | "normalize") {
            if measured_peak.is_none() {
                let txt = ff::measure(&[
                    "-i".into(),
                    in_path.display().to_string(),
                    "-af".into(),
                    "volumedetect".into(),
                    "-f".into(),
                    "null".into(),
                    "-".into(),
                ])?;
                let p = txt
                    .lines()
                    .find_map(|l| {
                        let i = l.find("max_volume:")?;
                        l[i + 11..].trim().trim_end_matches("dB").trim().parse::<f64>().ok()
                    })
                    .ok_or_else(|| Fail::new("measure", "volumedetect returned no peak"))?;
                measured_peak = Some(p);
            }
            let mut n = o.clone();
            n["measured"] = json!(measured_peak.unwrap());
            out.push(n);
        } else if matches!(k.as_str(), "loudnorm" | "ln") && util::opt_b(o, "two", false) {
            let i = g(o, "i").unwrap_or(-16.0);
            let tp = g(o, "tp").unwrap_or(-1.5);
            let lra = g(o, "lra").unwrap_or(11.0);
            let txt = ff::measure(&[
                "-i".into(),
                in_path.display().to_string(),
                "-af".into(),
                format!("loudnorm=I={}:TP={}:LRA={}:print_format=json", i, tp, lra),
                "-f".into(),
                "null".into(),
                "-".into(),
            ])?;
            let blk = json_block(&txt).ok_or_else(|| Fail::new("measure", "loudnorm printed no json"))?;
            let m: Value = serde_json::from_str(&blk)?;
            let mut n = o.clone();
            for (dst, src) in [
                ("measured_i", "input_i"),
                ("measured_tp", "input_tp"),
                ("measured_lra", "input_lra"),
                ("measured_thresh", "input_thresh"),
                ("offset", "target_offset"),
            ] {
                if let Some(s) = m.get(src).and_then(|x| x.as_str()) {
                    if let Ok(x) = s.parse::<f64>() {
                        n[dst] = json!(x);
                    }
                }
            }
            out.push(n);
        } else {
            out.push(o.clone());
        }
    }
    let _ = ctx;
    Ok(out)
}

/// One input, a chain of ops, one encoded output.
pub fn apply(
    in_path: &Path,
    out_path: &Path,
    ops: &[Value],
    enc: &Enc,
    total: Option<f64>,
    job: Option<&ff::JobHandle>,
) -> R<()> {
    util::ensure_parent(out_path)?;
    let ctx = ctx_for(in_path)?;
    let ops = pre_measure(in_path, ops, ctx)?;
    let af = chain(&ops, ctx)?;
    let mut a: Vec<String> = vec![
        "-i".into(),
        in_path.display().to_string(),
        "-vn".into(),
        "-map".into(),
        "0:a:0".into(),
        "-af".into(),
        af,
    ];
    a.extend(enc_args(out_path, enc));
    a.push(out_path.display().to_string());
    ff::run(&a, total.or(Some(ctx.dur)), job)?;
    Ok(())
}

pub const OPS: &[(&str, &str)] = &[
    ("gain", "v dB (amp:true=linear)"),
    ("fade", "v=secs in"),
    ("fadeout", "v=secs out"),
    ("trim", "start,end"),
    ("head", "v=secs"),
    ("tail", "v=secs"),
    ("speed", "v=ratio 1.05"),
    ("pitch", "v=semitones"),
    ("rate", "v=Hz"),
    ("highpass", "v=Hz"),
    ("lowpass", "v=Hz"),
    ("bandpass", "v=Hz w=Q"),
    ("bass", "v=dB"),
    ("treble", "v=dB"),
    ("eq", "low,mid,high dB"),
    ("denoise", "v=dB reduction"),
    ("deesser", "v=0..1"),
    ("compress", "thr,ratio,attack,release"),
    ("limiter", "db=-1"),
    ("loudnorm", "i,tp,lra two:true"),
    ("norm", "peak to db=-0.1"),
    ("rms", "v=target LUFS"),
    ("reverse", ""),
    ("mono", ""),
    ("stereo", ""),
    ("karaoke", "center cancel"),
    ("vocal", "center isolate"),
    ("widen", "v=ms"),
    ("reverb", "ms,v=feedback"),
    ("echo", "ms,v"),
    ("delay", "v=ms"),
    ("tremolo", "v=Hz depth"),
    ("vibrato", "v=Hz depth"),
    ("flanger", ""),
    ("silence_remove", "noise=dB dur=s"),
    ("dynnorm", "frame,gain"),
    ("pad", "with -t"),
    ("pan", "expr"),
    ("aformat", "sr,ch"),
];

pub fn ops_json() -> Value {
    json!(OPS.iter().map(|(k, d)| json!({ "k": k, "d": d })).collect::<Vec<_>>())
}

pub fn is_known(k: &str) -> bool {
    OPS.iter().any(|(n, _)| *n == k)
}

/// Presets collapse a whole chain into one word, which is the cheapest possible
/// agent call for a common goal.
pub fn preset(name: &str) -> R<Vec<Value>> {
    let name = name.trim().to_lowercase();
    let v = |k: &str, extra: Vec<(&str, f64)>| -> Value {
        let mut m = serde_json::Map::new();
        m.insert("k".into(), json!(k));
        for (a, b) in extra {
            m.insert(a.into(), json!(b));
        }
        Value::Object(m)
    };
    if name == "voice" {
        return Ok(vec![
            v("highpass", vec![("v", 80.0)]),
            v("denoise", vec![("v", 10.0)]),
            v("eq", vec![("low", -2.0), ("mid", 1.0), ("high", 2.0)]),
            v("compress", vec![("thr", -20.0), ("ratio", 3.0)]),
            v("loudnorm", vec![("i", -16.0)]),
            v("fadeout", vec![("v", 0.2)]),
        ]);
    }
    if name == "podcast" {
        return Ok(vec![
            v("highpass", vec![("v", 70.0)]),
            v("denoise", vec![("v", 12.0)]),
            v("deesser", vec![("v", 0.3)]),
            v("compress", vec![("thr", -22.0), ("ratio", 4.0)]),
            v("eq", vec![("low", -1.0), ("high", 2.5)]),
            v("loudnorm", vec![("i", -19.0)]),
        ]);
    }
    if name == "music" {
        return Ok(vec![
            v("eq", vec![("low", 1.0), ("high", 1.5)]),
            v("compress", vec![("thr", -18.0), ("ratio", 2.5)]),
            v("loudnorm", vec![("i", -14.0)]),
            v("fade", vec![("v", 0.5)]),
            v("fadeout", vec![("v", 1.5)]),
        ]);
    }
    if name == "phone" {
        return Ok(vec![
            v("highpass", vec![("v", 300.0)]),
            v("lowpass", vec![("v", 3400.0)]),
            v("eq", vec![("mid", 3.0)]),
            v("compress", vec![("thr", -20.0), ("ratio", 6.0)]),
            v("norm", vec![]),
        ]);
    }
    if name == "sfx" {
        return Ok(vec![
            v("norm", vec![("db", -1.0)]),
            v("fade", vec![("v", 0.005)]),
            v("fadeout", vec![("v", 0.02)]),
        ]);
    }
    if name == "clean" {
        return Ok(vec![v("highpass", vec![("v", 60.0)]), v("denoise", vec![("v", 10.0)]), v("norm", vec![])]);
    }
    if name == "loud" {
        return Ok(vec![v("compress", vec![("thr", -24.0), ("ratio", 4.0)]), v("limiter", vec![("db", -1.0)]), v("loudnorm", vec![("i", -9.0)])]);
    }
    if name == "quiet" {
        return Ok(vec![v("gain", vec![("v", -6.0)]), v("loudnorm", vec![("i", -24.0)])]);
    }
    if name == "intro" {
        return Ok(vec![v("fade", vec![("v", 1.2)]), v("fadeout", vec![("v", 1.2)]), v("loudnorm", vec![("i", -16.0)])]);
    }
    Err(Fail::new("preset", format!("unknown preset \"{}\"", name)).hint("presets: voice, podcast, music, phone, sfx, clean, loud, quiet, intro"))
}

pub fn preset_names() -> Vec<&'static str> {
    vec![
        "voice", "podcast", "music", "phone", "sfx", "clean", "loud", "quiet", "intro",
    ]
}

/// Validate a chain without touching audio (used by the UI before enabling a button).
pub fn validate(ops: &[Value], ctx: Ctx) -> R<()> {
    for o in ops {
        build(o, ctx)?;
    }
    Ok(())
}

pub fn db_of(v: f64) -> f64 {
    dsp::db(v)
}
