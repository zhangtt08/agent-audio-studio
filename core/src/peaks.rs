//! Waveform data, streamed: memory is O(buckets), never O(file length).

use crate::error::R;
use crate::{media, stream, util};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::path::Path;

/// 8 kHz is plenty for a drawn amplitude envelope and keeps a one-hour file at
/// ~4 MB of pipe traffic per minute instead of ~30 MB.
pub const PEAK_SR: u32 = 8000;

/// `chan`: 0 = mix of all channels, 1..n = that channel.
pub fn get(path: &Path, n: usize, chan: u32, enc: &str, sr: u32) -> R<Value> {
    let info = media::probe(path)?;
    let buckets = n.clamp(16, 20000);
    let sr_use = if sr == 0 { PEAK_SR } else { sr.clamp(4000, 48000) };
    let ch_dec: u16 = match chan {
        0 => 1,
        k => k.min(info.ch.max(1)).clamp(1, 8) as u16,
    };
    let pick = if chan <= 1 { 0usize } else { (chan - 1) as usize };

    let total = ((info.dur.max(0.05) * sr_use as f64) as u64).max(buckets as u64);
    let per = (total as f64 / buckets as f64).max(1.0);

    let mut mn = vec![0f32; buckets];
    let mut mx = vec![0f32; buckets];
    let mut rm = vec![0f32; buckets];
    let mut cnt = vec![0u32; buckets];
    let mut first = vec![true; buckets];

    let mut d = stream::open(path, sr_use, ch_dec)?;
    let mut frame_idx: u64 = 0;
    d.for_each_frame(1024, &mut |buf| {
        let mut k = 0usize;
        while k + pick < buf.len() {
            let v = buf[k + pick];
            let b = (((frame_idx as f64) / per) as usize).min(buckets - 1);
            if first[b] {
                mn[b] = v;
                mx[b] = v;
                first[b] = false;
            } else {
                if v < mn[b] {
                    mn[b] = v;
                }
                if v > mx[b] {
                    mx[b] = v;
                }
            }
            rm[b] += v * v;
            cnt[b] += 1;
            frame_idx += 1;
            k += ch_dec as usize;
        }
    })?;
    d.finish()?;

    for b in 0..buckets {
        let c = cnt[b].max(1) as f64;
        rm[b] = (rm[b] as f64 / c).sqrt() as f32;
    }
    let dur = if d_frames(&info) > 0.0 { info.dur } else { frame_idx as f64 / sr_use as f64 };

    if enc == "json" {
        Ok(json!({
            "dur": util::round(dur, 3),
            "sr": sr_use,
            "n": buckets,
            "enc": "json",
            "min": mn.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<f32>>(),
            "max": mx.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<f32>>(),
            "rms": rm.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<f32>>(),
        }))
    } else {
        let mut f = Vec::with_capacity(buckets * 3);
        f.extend_from_slice(&mn);
        f.extend_from_slice(&mx);
        f.extend_from_slice(&rm);
        let bytes: Vec<u8> = f.iter().flat_map(|v| v.to_le_bytes()).collect();
        Ok(json!({
            "dur": util::round(dur, 3),
            "sr": sr_use,
            "n": buckets,
            "enc": "b64",
            "d": STANDARD.encode(&bytes),
        }))
    }
}

fn d_frames(info: &media::Info) -> f64 {
    info.dur
}
