//! Streaming decode. Analysis used to materialise the whole file as f32, which
//! cost ~1.6 GB and 60 s on a 20-minute track and would OOM on a one-hour one.
//! Everything here is O(chunk): ffmpeg writes raw float PCM to a pipe and we
//! consume it incrementally.

use crate::error::{Fail, R};
use crate::ff;
use std::io::Read;
use std::path::Path;
use std::process::{Child, ChildStdout, Stdio};

const CHUNK: usize = 1 << 16;

pub struct Decoder {
    child: Child,
    out: Option<ChildStdout>,
    bytes: [u8; CHUNK],
    len: usize,
    pos: usize,
    pub ch: usize,
    pub sr: u32,
    pub frames: u64,
    err: Option<String>,
}

/// Decode `path` to interleaved f32 at `sr`/`ch` through a pipe.
pub fn open(path: &Path, sr: u32, ch: u16) -> R<Decoder> {
    let prog = ff::which("ffmpeg");
    let mut cmd = std::process::Command::new(&prog);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-vn", "-f", "f32le", "-ac"])
        .arg(ch.to_string())
        .args(["-ar"])
        .arg(sr.to_string())
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| {
        Fail::new("noffmpeg", format!("cannot start ffmpeg: {}", e))
            .hint("install ffmpeg, or set AGENTAUDIO_FFMPEG=<path to ffmpeg.exe>")
    })?;
    let out = child.stdout.take();
    if out.is_none() {
        let _ = child.kill();
        return Err(Fail::new("decode", "no stdout from ffmpeg"));
    }
    Ok(Decoder {
        child,
        out,
        bytes: [0u8; CHUNK],
        len: 0,
        pos: 0,
        ch: ch.max(1) as usize,
        sr,
        frames: 0,
        err: None,
    })
}

impl Decoder {
    /// Pull more bytes from the pipe into the front of the buffer.
    /// Returns false at EOF.
    fn pump(&mut self) -> R<bool> {
        let Some(o) = self.out.as_mut() else { return Ok(false) };
        if self.pos > 0 {
            let rest = self.len - self.pos;
            self.bytes.copy_within(self.pos..self.len, 0);
            self.len = rest;
            self.pos = 0;
        }
        if self.len >= CHUNK {
            return Ok(true);
        }
        let n = o.read(&mut self.bytes[self.len..CHUNK])?;
        self.len += n;
        Ok(n > 0)
    }

    /// Fill `dst` with as many whole frames as available (dst is interleaved
    /// samples, so it should be a multiple of `ch` for clean results).
    /// Returns the number of samples written; 0 means EOF.
    pub fn read(&mut self, dst: &mut [f32]) -> R<usize> {
        let mut w = 0;
        while w < dst.len() {
            let avail = (self.len - self.pos) / 4;
            if avail == 0 {
                if !self.pump()? {
                    break;
                }
                continue;
            }
            let take = avail.min(dst.len() - w);
            for k in 0..take {
                let off = self.pos + k * 4;
                let bits = u32::from_le_bytes([
                    self.bytes[off],
                    self.bytes[off + 1],
                    self.bytes[off + 2],
                    self.bytes[off + 3],
                ]);
                dst[w + k] = f32::from_bits(bits);
            }
            self.pos += take * 4;
            w += take;
        }
        Ok(w)
    }

    /// Read in `frames` chunks and hand each to `f`.
    pub fn for_each_frame<F: FnMut(&[f32])>(&mut self, frames: usize, f: &mut F) -> R<()> {
        let mut buf = vec![0f32; frames * self.ch];
        loop {
            let n = self.read(&mut buf)?;
            if n == 0 {
                break;
            }
            let got = n / self.ch;
            if got == 0 {
                break;
            }
            self.frames += got as u64;
            f(&buf[..got * self.ch]);
        }
        Ok(())
    }

    /// Reap the child so no ffmpeg process is left behind.
    pub fn finish(mut self) -> R<()> {
        drop(self.out.take());
        let st = self.child.wait()?;
        if !st.success() {
            return Err(Fail::new(
                "decode",
                format!("ffmpeg exited with {} while decoding", st.code().unwrap_or(-1)),
            )
            .hint("the file may be corrupt, truncated, or have no audio track"));
        }
        Ok(())
    }

    pub fn seconds(&self) -> f64 {
        if self.sr == 0 {
            0.0
        } else {
            self.frames as f64 / self.sr as f64
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // If a caller bails out mid-stream, don't leak the ffmpeg child.
        if self.child.id() != 0 {
            let _ = self.child.kill();
        }
    }
}
