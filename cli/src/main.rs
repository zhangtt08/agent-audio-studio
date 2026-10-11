mod mcp;

use agentaudio_core::{http, rpc, session, util};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;

pub fn core_version() -> &'static str {
    agentaudio_core::VERSION
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut pretty = false;
    let mut fields: Vec<String> = vec![];
    let mut root: Option<PathBuf> = None;
    let mut port: u16 = http::DEFAULT_PORT;
    let mut pos: Vec<String> = vec![];
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].clone();
        let a = a.as_str();
        if a == "--pretty" {
            pretty = true;
        } else if a == "--compact" || a == "--quiet" {
            // already the default; accepted so agents can pass it harmlessly
        } else if a == "--fields" || a == "--root" || a == "--port" {
            let key = a;
            if let Some(nx) = argv.get(i + 1) {
                match key {
                    "--fields" => fields = nx.split(',').map(|x| x.trim().to_string()).collect(),
                    "--root" => root = Some(PathBuf::from(nx)),
                    "--port" => port = nx.parse().unwrap_or(port),
                    _ => {}
                }
                i += 2;
                continue;
            }
        } else if let Some(v) = a.strip_prefix("--fields=") {
            fields = v.split(',').map(|x| x.trim().to_string()).collect();
        } else if let Some(v) = a.strip_prefix("--root=") {
            root = Some(PathBuf::from(v));
        } else if let Some(v) = a.strip_prefix("--port=") {
            port = v.parse().unwrap_or(port);
        } else {
            pos.push(a.to_string());
        }
        i += 1;
    }

    let cmd = pos.first().map(|x| x.as_str()).unwrap_or("");
    let ctx = rpc::Ctx { root: root.clone(), ..Default::default() };

    match cmd {
        "" | "--help" | "-h" | "help" if pos.is_empty() => {
            usage();
            0
        }
        "help" => {
            let v = rpc::call_in("help", &json!({}), &ctx).unwrap_or(json!(null));
            emit(&v, pretty, &fields);
            0
        }
        "mcp" => mcp::serve(root),
        "http" => match http::start(port, root) {
            Ok(p) => {
                println!(
                    "{}",
                    json!({ "ok": true, "url": format!("http://127.0.0.1:{}", p), "api": format!("http://127.0.0.1:{}/api/<method>", p) })
                );
                let _ = std::io::stdout().flush();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                }
            }
            Err(e) => {
                emit(&util::human_err(&e), pretty, &fields);
                1
            }
        },
        "version" | "--version" | "-V" => {
            println!("agentaudio {}", core_version());
            0
        }
        "tools" => {
            if fields.iter().any(|f| f == "md") || pos.get(1).map(|x| x.as_str()) == Some("--md") {
                for (n, d, sig) in rpc::TOOLS {
                    println!("### {}\n{}\nparams: {}\n", n, d, sig);
                }
            } else {
                emit(&rpc::mcp_tools(), pretty, &fields);
            }
            0
        }
        "doctor" => {
            let v = rpc::doctor().unwrap_or_else(|e| util::human_err(&e));
            emit(&v, true, &fields);
            if v.get("ok").and_then(|x| x.as_bool()) == Some(true) { 0 } else { 2 }
        }
        "caps" => {
            let v = rpc::caps().unwrap_or_else(|e| util::human_err(&e));
            emit(&v, pretty, &fields);
            0
        }
        method => {
            let params = match parse_params(&pos[1..]) {
                Ok(p) => p,
                Err(e) => {
                    emit(&util::human_err(&e), pretty, &fields);
                    return 1;
                }
            };
            match rpc::call_in(method, &params, &ctx) {
                Ok(mut v) => {
                    if !fields.is_empty() {
                        if let Some(o) = v.as_object() {
                            let mut m = serde_json::Map::new();
                            for k in &fields {
                                if let Some(x) = o.get(k) {
                                    m.insert(k.clone(), x.clone());
                                }
                            }
                            v = Value::Object(m);
                        }
                    }
                    emit(&v, pretty, &fields);
                    0
                }
                Err(e) => {
                    emit(&util::human_err(&e), pretty, &fields);
                    1
                }
            }
        }
    }
}

/// `k=v` pairs, a raw JSON object, or `@file.json`.
fn parse_params(toks: &[String]) -> agentaudio_core::R<Value> {
    let mut m = serde_json::Map::new();
    for t in toks {
        if t.starts_with('{') {
            let v: Value = serde_json::from_str(t)
                .map_err(|e| agentaudio_core::Fail::new("param", format!("bad json: {}", e)))?;
            if let Some(o) = v.as_object() {
                for (k, x) in o {
                    m.insert(k.clone(), x.clone());
                }
            }
            continue;
        }
        if t.starts_with('@') {
            let p = &t[1..];
            let txt = std::fs::read_to_string(p)
                .map_err(|e| agentaudio_core::Fail::new("nofile", format!("{}: {}", p, e)))?;
            let v: Value = serde_json::from_str(&txt)
                .map_err(|e| agentaudio_core::Fail::new("param", format!("{} is not json: {}", p, e)))?;
            if let Some(o) = v.as_object() {
                for (k, x) in o {
                    m.insert(k.clone(), x.clone());
                }
            }
            continue;
        }
        let (k, v) = t
            .split_once('=')
            .ok_or_else(|| agentaudio_core::Fail::new("param", format!("expected key=value, got \"{}\"", t)))?;
        m.insert(k.to_string(), coerce(v));
    }
    Ok(Value::Object(m))
}

fn coerce(v: &str) -> Value {
    let t = v.trim();
    if t.starts_with('{') || t.starts_with('[') {
        if let Ok(j) = serde_json::from_str(t) {
            return j;
        }
    }
    if t.starts_with('@') && t.ends_with(".json") {
        if let Ok(txt) = std::fs::read_to_string(&t[1..]) {
            if let Ok(j) = serde_json::from_str(&txt) {
                return j;
            }
        }
    }
    match t {
        "true" => return json!(true),
        "false" => return json!(false),
        _ => {}
    }
    if let Ok(n) = t.parse::<f64>() {
        return json!(n);
    }
    let un = t.trim_matches('"');
    if un.starts_with('[') || un.starts_with('{') {
        if let Ok(j) = serde_json::from_str(un) {
            return j;
        }
    }
    json!(un)
}

fn emit(v: &Value, pretty: bool, _fields: &[String]) {
    let s = if pretty {
        serde_json::to_string_pretty(v).unwrap_or_default()
    } else {
        serde_json::to_string(v).unwrap_or_default()
    };
    println!("{}", s);
}

fn usage() {
    println!(
        "AgentAudio {} - audio runtime for AI agents

  agentaudio <method> k=v k=v        one call, one line of JSON
  agentaudio mcp                     stdio MCP server (for Claude / Codex / etc)
  agentaudio http [--port 8787]      REST API on 127.0.0.1
  agentaudio caps                    every method, op and preset in one call
  agentaudio doctor                  environment check
  agentaudio demo                    create sample media to test with

  fit in=song.mp3 video=clip.mp4 out=bed.wav     70s of music -> exactly 40s
  extract in=clip.mp4 out=a.wav                  audio out of a video
  fx in=a.wav preset=voice out=v.wav             one word, six filters
  batch @jobs.json                               many calls, one round trip

  flags: --pretty  --fields a,b  --root DIR  --quiet
  work dir: {}",
        core_version(),
        session::workspace().display()
    );
}
