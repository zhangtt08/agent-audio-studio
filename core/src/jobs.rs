//! Live job registry. The UI's progress ring and 停止 button talk to this, and
//! it is the only place a running ffmpeg process can be observed.

use crate::ff::JobHandle;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Debug)]
pub struct Rec {
    pub id: u64,
    pub op: String,
    pub arg: String,
    pub handle: JobHandle,
    pub state: String,
    pub ms: u64,
    pub out: String,
    pub err: String,
    pub created: u128,
}

#[derive(Default)]
struct Store {
    seq: u64,
    map: HashMap<u64, Rec>,
    order: Vec<u64>,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store::default()))
}

pub fn begin(op: &str, arg: String, stage: &str) -> (u64, JobHandle) {
    let mut s = store().lock().unwrap();
    s.seq += 1;
    let id = s.seq;
    let h = JobHandle::new(stage);
    s.map.insert(
        id,
        Rec {
            id,
            op: op.to_string(),
            arg,
            handle: h.clone(),
            state: "running".into(),
            ms: 0,
            out: String::new(),
            err: String::new(),
            created: crate::util::now_ms(),
        },
    );
    s.order.push(id);
    if s.order.len() > 400 {
        let drop_n = s.order.len() - 400;
        let doomed: Vec<u64> = s.order.drain(0..drop_n).collect();
        for k in doomed {
            s.map.remove(&k);
        }
    }
    (id, h)
}

pub fn finish(id: u64, out: Option<&str>, err: Option<&str>) {
    let mut s = store().lock().unwrap();
    if let Some(r) = s.map.get_mut(&id) {
        r.ms = (crate::util::now_ms() - r.created) as u64;
        r.state = match err {
            Some(_) => "error",
            None => "done",
        }
        .to_string();
        if r.state == "error" && err.map(|e| e.contains("cancelled")).unwrap_or(false) {
            r.state = "cancelled".into();
        }
        r.out = out.unwrap_or("").to_string();
        r.err = err.unwrap_or("").to_string();
        r.handle.pct.store(if err.is_none() { 100 } else { r.handle.pct.load(Ordering::Relaxed) }, Ordering::Relaxed);
    }
}

pub fn cancel(id: u64) -> bool {
    let s = store().lock().unwrap();
    match s.map.get(&id) {
        Some(r) if r.state == "running" => {
            r.handle.cancel.store(true, Ordering::Relaxed);
            true
        }
        _ => false,
    }
}

pub fn snapshot() -> Value {
    let s = store().lock().unwrap();
    let mut ids: Vec<u64> = s.order.clone();
    ids.reverse();
    let jobs: Vec<Value> = ids
        .iter()
        .filter_map(|i| s.map.get(i))
        .map(|r| {
            json!({
                "id": r.id,
                "op": r.op,
                "arg": r.arg,
                "pct": r.handle.pct.load(Ordering::Relaxed),
                "stage": r.handle.stage.lock().map(|g| g.clone()).unwrap_or_default(),
                "state": r.state,
                "ms": r.ms,
                "out": r.out,
                "err": r.err,
                "created": r.created,
            })
        })
        .collect();
    let running = jobs.iter().filter(|j| j["state"] == "running").count();
    json!({ "jobs": jobs, "running": running })
}

pub fn running() -> usize {
    let s = store().lock().unwrap();
    s.map.values().filter(|r| r.state == "running").count()
}

pub fn current() -> Option<Arc<JobHandle>> {
    let s = store().lock().unwrap();
    s.map
        .values()
        .find(|r| r.state == "running")
        .map(|r| Arc::new(r.handle.clone()))
}
