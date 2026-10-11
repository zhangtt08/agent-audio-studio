use crate::error::{Fail, R};
use serde_json::Value;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// One running ffmpeg job. Shared with the UI so it can show real progress and
/// offer a stop button.
///
/// Multi-pass jobs (split, separate) narrow `base`/`span` so the reported
/// percent is always the whole job's progress, never the current file's.
#[derive(Clone, Debug)]
pub struct JobHandle {
    pub cancel: Arc<AtomicBool>,
    pub pct: Arc<AtomicU32>,
    pub stage: Arc<Mutex<String>>,
    pub base: Arc<AtomicU32>,
    pub span: Arc<AtomicU32>,
}

impl Default for JobHandle {
    fn default() -> Self {
        JobHandle {
            cancel: Arc::new(AtomicBool::new(false)),
            pct: Arc::new(AtomicU32::new(0)),
            stage: Arc::new(Mutex::new(String::new())),
            base: Arc::new(AtomicU32::new(0)),
            span: Arc::new(AtomicU32::new(100)),
        }
    }
}

impl JobHandle {
    pub fn new(stage: &str) -> Self {
        let j = JobHandle::default();
        if let Ok(mut g) = j.stage.lock() {
            *g = stage.to_string();
        }
        j
    }
    /// Claim a slice of the 0..100 bar for the current sub-step.
    pub fn set_range(&self, base: u32, span: u32) {
        self.base.store(base.min(100), Ordering::Relaxed);
        self.span.store(span.min(100 - base.min(100)), Ordering::Relaxed);
    }
    pub fn set_pct(&self, p: u32) {
        self.pct.store(p.clamp(0, 100), Ordering::Relaxed);
    }
    pub fn set_stage(&self, s: &str) {
        if let Ok(mut g) = self.stage.lock() {
            *g = s.to_string();
        }
    }
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// ffmpeg/ffprobe lookup order: env override, saved setting, sidecar next to
/// the executable, then PATH. Bundled builds drop a binary in `sidecars/`.
pub fn which(tool: &str) -> PathBuf {
    let key = format!("AGENTAUDIO_{}", tool.to_uppercase());
    if let Ok(v) = std::env::var(&key) {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    if let Some(v) = crate::session::config_str(tool) {
        let p = PathBuf::from(&v);
        if p.exists() {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [
                dir.join("sidecars").join(format!("{}.exe", tool)),
                dir.join("sidecars").join(tool),
                dir.join(format!("{}.exe", tool)),
                dir.join(tool),
            ] {
                if cand.exists() {
                    return cand;
                }
            }
        }
    }
    PathBuf::from(tool)
}

fn spawn_cmd(prog: &Path) -> Command {
    let mut c = Command::new(prog);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

fn read_tail(p: &Path, max: usize) -> String {
    let mut s = String::new();
    if let Ok(mut f) = std::fs::File::open(p) {
        let _ = f.read_to_string(&mut s);
    }
    if s.len() > max {
        s = s[s.len() - max..].to_string();
    }
    s
}

/// The one place ffmpeg is invoked. Progress goes to a file (never a pipe) so a
/// busy encoder can't deadlock us on a full stderr buffer.
pub fn run_with(
    extra: &[String],
    level: &str,
    total: Option<f64>,
    job: Option<&JobHandle>,
) -> R<String> {
    let prog = which("ffmpeg");
    // Temp names must be unique across *processes*: the CLI, the desktop app and
    // an MCP server can all be running ffmpeg at the same instant, and a shared
    // .prog file would cross-feed each other's progress.
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tag = format!("{}-{}-{}", std::process::id(), crate::util::now_ms(), n);
    let pf = crate::util::tmp_dir().join(format!("ff-{}.prog", tag));
    let ef = crate::util::tmp_dir().join(format!("ff-{}.err", tag));

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        level.into(),
        "-y".into(),
        "-nostdin".into(),
    ];
    args.extend(extra.iter().cloned());
    args.push("-progress".into());
    args.push(pf.display().to_string());

    let mut cmd = spawn_cmd(&prog);
    for a in &args {
        cmd.arg(a);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(
            std::fs::File::create(&ef)
                .map(Stdio::from)
                .unwrap_or(Stdio::null()),
        )
        .spawn()
        .map_err(|e| {
            Fail::new("noffmpeg", format!("cannot start ffmpeg: {}", e)).hint(
                "install ffmpeg, or set AGENTAUDIO_FFMPEG=<path to ffmpeg.exe>",
            )
        })?;

    let started = Instant::now();
    let code = loop {
        if let Some(j) = job {
            if j.cancelled() {
                let _ = child.kill();
                let _ = std::fs::remove_file(&pf);
                let _ = std::fs::remove_file(&ef);
                return Err(Fail::new("cancelled", "job cancelled"));
            }
        }
        if let Some(t) = total {
            if t > 0.0 {
                if let Some(sec) = progress_secs(&pf) {
                    let frac = ((sec / t) * 100.0).clamp(0.0, 99.9) as u32;
                    if let Some(j) = job {
                        let b = j.base.load(Ordering::Relaxed);
                        let sp = j.span.load(Ordering::Relaxed);
                        j.pct.store((b + sp * frac / 100).min(99), Ordering::Relaxed);
                    }
                }
            }
        }
        match child.try_wait() {
            Ok(Some(st)) => break st.code().unwrap_or(if st.success() { 0 } else { 1 }),
            Ok(None) => std::thread::sleep(Duration::from_millis(60)),
            Err(e) => {
                let _ = std::fs::remove_file(&pf);
                return Err(Fail::new("io", e.to_string()));
            }
        }
        if started.elapsed().as_secs() > 60 * 40 {
            let _ = child.kill();
            return Err(Fail::new("timeout", "ffmpeg exceeded 40 minutes"));
        }
    };

    let err = read_tail(&ef, 8000);
    let _ = std::fs::remove_file(&pf);
    let _ = std::fs::remove_file(&ef);

    if code != 0 {
        let line = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty() && !l.contains("At least"))
            .unwrap_or("ffmpeg failed")
            .trim()
            .to_string();
        return Err(Fail::new("ffmpeg", line).hint(hint_for(&err)));
    }
    if let Some(j) = job {
        j.pct.store(100, Ordering::Relaxed);
    }
    Ok(err)
}

fn hint_for(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("no such file") || e.contains("does not exist") || e.contains("not found") {
        return "input path is wrong or the file was moved".into();
    }
    if e.contains("invalid argument") || e.contains("option") {
        return "run `agentaudio caps` to check accepted parameters".into();
    }
    if e.contains("encoder") || e.contains("unknown encoder") {
        return "this ffmpeg build lacks that encoder; try out=<name>.wav".into();
    }
    if e.contains("output file #0 does not contain any stream") {
        return "the source has no audio track; run probe first".into();
    }
    "re-run with AGENTAUDIO_VERBOSE=1 for the full ffmpeg log".into()
}

fn progress_secs(pf: &Path) -> Option<f64> {
    let s = read_tail(pf, 4000);
    let mut best: Option<f64> = None;
    for l in s.lines().rev() {
        let l = l.trim();
        for k in ["out_time_us=", "out_time_ms="] {
            if let Some(v) = l.strip_prefix(k) {
                if let Ok(n) = v.trim().parse::<f64>() {
                    // out_time_ms in ffmpeg is really microseconds
                    let sec = if k == "out_time_us=" { n / 1e6 } else { n / 1e6 };
                    if sec > 0.0 {
                        best = Some(sec);
                        return best;
                    }
                }
            }
        }
    }
    best
}

static SEQ: AtomicU32 = AtomicU32::new(1);

pub fn probe_json(path: &Path) -> R<Value> {
    let prog = which("ffprobe");
    let mut cmd = spawn_cmd(&prog);
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ])
    .arg(path);
    let o = cmd.output().map_err(|e| {
        Fail::new("noffmpeg", format!("cannot start ffprobe: {}", e))
            .hint("install ffmpeg, or set AGENTAUDIO_FFPROBE=<path>")
    })?;
    if !o.status.success() {
        let s = String::from_utf8_lossy(&o.stderr).lines().next_back().map(|l| l.to_string());
        return Err(Fail::new(
            "unreadable",
            s.unwrap_or_else(|| "ffprobe failed".into()),
        )
        .hint("is the file a real audio/video file?"));
    }
    let v: Value = serde_json::from_slice(&o.stdout)?;
    Ok(v)
}

/// Filters present in this ffmpeg build, so ops can degrade honestly instead of
/// emitting a command that fails at runtime.
///
/// `ffmpeg -filters` prints `.. loudnorm  A->A  description`; the flag column is
/// 2 chars in ffmpeg 9 and 3 in older builds, so the `->` link pattern is the
/// stable thing to key on.
pub fn filters() -> &'static HashSet<String> {
    static F: OnceLock<HashSet<String>> = OnceLock::new();
    F.get_or_init(|| {
        let mut set = HashSet::new();
        let prog = which("ffmpeg");
        if let Ok(o) = spawn_cmd(&prog).args(["-hide_banner", "-filters"]).output() {
            for l in String::from_utf8_lossy(&o.stdout).lines() {
                let t: Vec<&str> = l.split_whitespace().collect();
                if t.len() >= 3 && t[2].contains("->") {
                    set.insert(t[1].to_string());
                }
            }
        }
        set
    })
}

pub fn have_filter(name: &str) -> bool {
    filters().contains(name)
}

pub fn version() -> String {
    let prog = which("ffmpeg");
    spawn_cmd(&prog)
        .arg("-version")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
        })
        .unwrap_or_else(|| "ffmpeg: not found".into())
}

/// Quiet processing pass.
pub fn run(extra: &[String], total: Option<f64>, job: Option<&JobHandle>) -> R<String> {
    run_with(extra, "error", total, job)
}

/// Analysis pass: ffmpeg's own meters (`volumedetect`, `loudnorm=print_format=json`,
/// `astats`) only print at info level, so measurement runs need this.
/// A job handle makes the pass cancellable — loudnorm on a long file is slow
/// enough that the UI needs a way out.
pub fn measure_with(extra: &[String], job: Option<&JobHandle>) -> R<String> {
    run_with(extra, "info", None, job)
}

pub fn measure(extra: &[String]) -> R<String> {
    measure_with(extra, None)
}

/// Copy without re-encoding (used when a job needs no DSP).
pub fn copy_stream(in_path: &Path, out_path: &Path, extra: &[String], job: Option<&JobHandle>) -> R<()> {
    let mut a = vec!["-i".into(), in_path.display().to_string()];
    a.extend(extra.iter().cloned());
    a.push(out_path.display().to_string());
    run(&a, None, job)?;
    Ok(())
}
