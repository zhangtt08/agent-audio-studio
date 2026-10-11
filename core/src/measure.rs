//! One streaming pass over the decoded audio, shared by score / levels /
//! sections so a long track is measured in O(1) memory instead of being
//! materialised as f32 several times over.

use crate::dsp::Biquad;
use crate::error::R;
use crate::stream;
use std::path::Path;

/// 50 ms analysis windows: enough resolution for silence and section edges,
/// small enough that a one-hour track yields ~72k frames.
pub const HOP_SEC: f64 = 0.05;

#[derive(Clone, Copy, Debug, Default)]
pub struct Frame {
    /// RMS level of this window in dBFS
    pub db: f64,
    /// energy below 500 Hz, normalised by the window's total energy
    pub low: f64,
    /// energy in the 1.2k-8k presence band, likewise normalised
    pub mid: f64,
    /// sign changes per sample
    pub zcr: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub sr: u32,
    pub hop: usize,
    pub ch_n: usize,
    pub frames: Vec<Frame>,
    pub ch_peak: Vec<f64>,
    pub ch_rms: Vec<f64>,
    pub samples: u64,
    pub dur: f64,
}

impl Stats {
    pub fn is_silent(&self) -> bool {
        // digital silence, or a floor so low there is no usable signal
        self.frames.is_empty()
            || crate::dsp::pct(&self.dbs(), 95.0) < -70.0
    }
    pub fn dbs(&self) -> Vec<f64> {
        self.frames.iter().map(|f| f.db).collect()
    }
}

pub fn measure(path: &Path, sr: u32, ch: u16) -> R<Stats> {
    let ch_n = ch.max(1) as usize;
    let mut d = stream::open(path, sr, ch)?;
    let hop = ((sr as f64) * HOP_SEC).round() as usize;
    let hop = hop.max(1);

    let mut s = Stats {
        sr,
        hop,
        ch_n,
        frames: Vec::new(),
        ch_peak: vec![0f64; ch_n],
        ch_rms: vec![0f64; ch_n],
        samples: 0,
        dur: 0.0,
    };

    let srf = sr as f64;
    let mut low_hp = Biquad::highpass(srf, 20.0, 0.7071);
    let mut low_lp = Biquad::lowpass(srf, 500.0, 0.7071);
    let mut mid_hp = Biquad::highpass(srf, 1200.0, 0.7071);
    let mut mid_lp = Biquad::lowpass(srf, 8000.0f64.min(srf / 2.0 - 200.0), 0.7071);

    // window accumulators
    let mut e_tot = 0f64;
    let mut e_low = 0f64;
    let mut e_mid = 0f64;
    let mut zc = 0usize;
    let mut prev_sign = 0f64;
    let mut n_in_win = 0usize;
    let mut ch_e = vec![0f64; ch_n];
    let mut ch_frames = vec![0f64; ch_n];

    d.for_each_frame(512, &mut |buf| {
        let mut i = 0usize;
        while i < buf.len() {
            let mut mono = 0f64;
            for c in 0..ch_n {
                if i + c >= buf.len() {
                    break;
                }
                let v = buf[i + c] as f64;
                let a = v.abs();
                if a > s.ch_peak[c] {
                    s.ch_peak[c] = a;
                }
                ch_e[c] += v * v;
                ch_frames[c] += 1.0;
                mono += v;
            }
            mono /= ch_n as f64;
            i += ch_n;

            let tot = mono * mono;
            e_tot += tot;
            e_low += low_lp.run(low_hp.run(mono)).powi(2);
            e_mid += mid_lp.run(mid_hp.run(mono)).powi(2);
            let sign = if mono >= 0.0 { 1.0 } else { -1.0 };
            if sign != prev_sign {
                zc += 1;
            }
            prev_sign = sign;
            n_in_win += 1;

            if n_in_win >= hop {
                let denom = e_tot.max(1e-12);
                s.frames.push(Frame {
                    db: crate::dsp::db((e_tot / n_in_win as f64).sqrt()),
                    low: e_low / denom,
                    mid: e_mid / denom,
                    zcr: zc as f64 / n_in_win as f64,
                });
                e_tot = 0.0;
                e_low = 0.0;
                e_mid = 0.0;
                zc = 0;
                n_in_win = 0;
            }
        }
    })?;

    if n_in_win > 0 {
        let denom = e_tot.max(1e-12);
        s.frames.push(Frame {
            db: crate::dsp::db((e_tot / n_in_win as f64).sqrt()),
            low: e_low / denom,
            mid: e_mid / denom,
            zcr: zc as f64 / n_in_win.max(1) as f64,
        });
    }

    for c in 0..ch_n {
        let n = ch_frames[c].max(1.0);
        s.ch_rms[c] = crate::dsp::db((ch_e[c] / n).sqrt());
    }
    s.samples = d.frames * ch_n as u64;
    s.dur = d.seconds();
    d.finish()?;
    Ok(s)
}

/// Mono pass at a rate high enough for the 1.2k-8k presence band.
pub const MEASURE_SR: u32 = 22050;

pub fn at(path: &Path, sr: u32, ch: u16) -> R<Stats> {
    measure(path, sr, ch)
}

pub fn mono(path: &Path) -> R<Stats> {
    measure(path, MEASURE_SR, 1)
}

/// Two channels: needed for the L/R balance and per-channel meters.
pub fn stereo(path: &Path) -> R<Stats> {
    measure(path, MEASURE_SR, 2)
}
