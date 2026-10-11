//! Real-valued DSP helpers. Everything the UI shows as a "metric" is computed
//! here from samples, not invented.

/// RBJ biquad. Used for the band split behind the clarity score.
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    fn new(b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) -> Self {
        Biquad { b0, b1, b2, a1, a2, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 }
    }

    pub fn lowpass(sr: f64, f: f64, q: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * f / sr;
        let (cw, sw) = (w.cos(), w.sin());
        let al = sw / (2.0 * q);
        let a0 = 1.0 + al;
        Biquad::new(
            (1.0 - cw) / 2.0 / a0,
            (1.0 - cw) / a0,
            (1.0 - cw) / 2.0 / a0,
            -2.0 * cw / a0,
            (1.0 - al) / a0,
        )
    }

    pub fn highpass(sr: f64, f: f64, q: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * f / sr;
        let (cw, sw) = (w.cos(), w.sin());
        let al = sw / (2.0 * q);
        let a0 = 1.0 + al;
        Biquad::new(
            (1.0 + cw) / 2.0 / a0,
            -(1.0 + cw) / a0,
            (1.0 + cw) / 2.0 / a0,
            -2.0 * cw / a0,
            (1.0 - al) / a0,
        )
    }

    pub fn bandpass(sr: f64, f: f64, q: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * f / sr;
        let (cw, sw) = (w.cos(), w.sin());
        let al = sw / (2.0 * q);
        let a0 = 1.0 + al;
        Biquad::new(al / a0, 0.0, -al / a0, -2.0 * cw / a0, (1.0 - al) / a0)
    }

    pub fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Cascaded highpass+lowpass = band energy.
pub fn band_energy(x: &[f64], sr: f64, lo: f64, hi: f64) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    let mut hp = Biquad::highpass(sr, lo, 0.7071);
    let mut lp = Biquad::lowpass(sr, hi.min(sr / 2.0 - 100.0).max(lo + 20.0), 0.7071);
    let mut acc = 0.0;
    for &v in x {
        let y = lp.run(hp.run(v));
        acc += y * y;
    }
    acc / x.len() as f64
}

pub fn total_energy(x: &[f64]) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    x.iter().map(|v| v * v).sum::<f64>() / x.len() as f64
}

pub fn rms(x: &[f64]) -> f64 {
    total_energy(x).sqrt()
}

pub fn db(v: f64) -> f64 {
    20.0 * (v.max(1e-9)).log10()
}

pub fn db_gain(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// Percentile of a copy of `v` (0..=100).
pub fn pct(v: &[f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let i = ((s.len() - 1) as f64 * (p / 100.0)).round() as usize;
    s[i]
}

/// Frame RMS in dBFS, one value per `hop` samples (zero-padded windows).
pub fn frame_db(x: &[f64], win: usize, hop: usize) -> Vec<f64> {
    if x.is_empty() {
        return vec![];
    }
    let mut out = Vec::with_capacity(x.len() / hop + 1);
    let mut i = 0usize;
    while i < x.len() {
        let end = (i + win).min(x.len());
        let sl = &x[i..end];
        let r = rms(sl);
        out.push(db(r));
        i += hop;
    }
    out
}

pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

/// Map a metric onto 0..=100 with a floor and ceiling, linear in between.
pub fn map_score(v: f64, bad: f64, good: f64, lo: f64, hi: f64) -> f64 {
    let t = (v - bad) / (good - bad);
    clamp(lo + t * (hi - lo), lo, hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowpass_kills_a_high_tone() {
        let sr = 8000.0;
        let n = 4000;
        let hi: Vec<f64> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * 3000.0 * i as f64 / sr).sin())
            .collect();
        let mut f = Biquad::lowpass(sr, 200.0, 0.7071);
        let out: Vec<f64> = hi.iter().map(|&v| f.run(v)).collect();
        let after = rms(&out[n / 2..]);
        assert!(after < 0.05, "lp leaked: {}", after);
        assert!(band_energy(&hi, sr, 2500.0, 3500.0) > 0.3);
    }

    #[test]
    fn percentile_and_db() {
        let v: Vec<f64> = (0..101).map(|i| i as f64).collect();
        assert_eq!(pct(&v, 50.0), 50.0);
        assert!((db(1.0) - 0.0).abs() < 1e-6);
        assert!((db(0.5) + 6.0206).abs() < 0.01);
        assert!((db_gain(-6.0) - 0.5012).abs() < 0.01);
    }

    #[test]
    fn map_score_bounds() {
        assert_eq!(map_score(0.0, 0.0, 1.0, 20.0, 99.0), 20.0);
        assert_eq!(map_score(1.0, 0.0, 1.0, 20.0, 99.0), 99.0);
        assert_eq!(map_score(-5.0, 0.0, 1.0, 20.0, 99.0), 20.0);
    }
}
