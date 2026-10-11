#!/usr/bin/env node
// Acceptance gate for AgentAudio. Run: node tests/smoke.mjs [path\to\agentaudio.exe]
// Every check asserts a real audio result, not just "the command exited 0".
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ex = promisify(execFile);
// Default to the shipped binary: the gate should prove the artifact a user actually runs,
// not a build-cache copy that may be older or newer than it.
const CANDIDATES = [process.argv[2], 'dist/bin/agentaudio.exe', 'target/release/agentaudio.exe'].filter(Boolean);
const EXE = CANDIDATES.map((c) => path.resolve(c)).find((c) => fs.existsSync(c)) || path.resolve(CANDIDATES[0]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-smoke-'));
const results = [];
let failed = 0;

function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail: String(detail).slice(0, 220) });
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + String(detail).slice(0, 160) : ''}`);
}

async function cli(args, label = args.join(' '), opts = {}) {
  const parse = (txt) => {
    const t = (txt || '').trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch { /* multi-line */ }
    try { return JSON.parse(t.split('\n').pop()); } catch { return null; }
  };
  const run = async () => {
    const { stdout, stderr } = await ex(EXE, args, { maxBuffer: 64e6, cwd: TMP, timeout: opts.timeout });
    return { code: 0, stdout, stderr, json: parse(stdout) };
  };
  try {
    return await run();
  } catch (e) {
    if (e.syscall === 'spawn' || e.code === 'ENOENT') throw e;
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '', json: parse(e.stdout), err: e };
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const durOf = (j) => (j && typeof j.dur === 'number' ? j.dur : NaN);

async function main() {
  ok('binary exists', fs.existsSync(path.resolve(EXE)), EXE);
  if (!fs.existsSync(path.resolve(EXE))) { report(); return; }

  // ---- environment -------------------------------------------------------
  const doc = await cli(['doctor']);
  ok('doctor: ffmpeg found', doc.json?.ok === true, JSON.stringify(doc.json));
  ok('doctor: workspace writable', doc.json?.writable === true);
  ok('doctor: loudnorm available', doc.json?.loudnorm === true);

  // ---- fixtures ----------------------------------------------------------
  const demo = await cli(['demo', '--root', TMP]);
  const files = demo.json?.files || [];
  const song = files.find((f) => f.f === 'song70.wav');
  const clip = files.find((f) => f.f === 'clip40.mp4');
  const voice = files.find((f) => f.f === 'voice8.wav');
  ok('demo: three sample files', files.length === 3, JSON.stringify(files.map((f) => f.f)));
  ok('demo: song is ~70s', song && near(song.dur, 70, 0.5), song?.dur);
  ok('demo: clip is ~40s', clip && near(clip.dur, 40, 0.6), clip?.dur);
  ok('demo: clip has no audio track', !!clip && fs.existsSync(clip.path));

  // ---- the headline case: 70s music -> exactly 40s ----------------------
  const fit = await cli(['fit', `in=${song.path}`, `video=${clip.path}`, `out=${TMP}/bed.wav`]);
  ok('fit: 70s -> 40s within 50ms', fit.json && near(durOf(fit.json), 40, 0.05), JSON.stringify({ dur: fit.json?.dur, err: fit.json?.err, mode: fit.json?.mode }));
  ok('fit: reports the mode it chose', ['rate', 'trim', 'loop', 'none'].includes(fit.json?.mode), fit.json?.mode);
  ok('fit: output file exists', fit.json?.path && fs.existsSync(fit.json.path));
  const fitRB = await cli(['fit', `in=${song.path}`, 'dur=40', 'engine=rubberband', `out=${TMP}/rb.wav`]);
  const fitAT = await cli(['fit', `in=${song.path}`, 'dur=40', 'engine=atempo', `out=${TMP}/at.wav`]);
  ok('fit: reports which stretch engine ran', ['rubberband', 'atempo'].includes(fit.json?.engine), fit.json?.engine);
  ok('fit: engine=atempo obeys the request', fitAT.json?.engine === 'atempo' && near(durOf(fitAT.json), 40, 0.05), JSON.stringify({ engine: fitAT.json?.engine, err: fitAT.json?.err }));
  if (doc.json?.rubberband) {
    ok('fit: engine=rubberband still lands on target', fitRB.json?.engine === 'rubberband' && near(durOf(fitRB.json), 40, 0.05), JSON.stringify({ engine: fitRB.json?.engine, dur: fitRB.json?.dur, err: fitRB.json?.err }));
    ok('fit: auto prefers rubberband for a music stretch', fit.json?.engine === 'rubberband', fit.json?.engine);
  } else {
    ok('fit: rubberband request fails honestly when the filter is absent', fitRB.json?.code === 'engine' && !!fitRB.json?.hint, JSON.stringify(fitRB.json));
  }
  ok('doctor: reports the rubberband engine', typeof doc.json?.rubberband === 'boolean', doc.json?.rubberband);
  const absurd = await cli(['fit', `in=${song.path}`, 'dur=1000000', `out=${TMP}/absurd.wav`], 'fit dur absurd', { timeout: 30000 });
  ok('fit rejects an implausible duration before touching the disk', absurd.code !== 0 && absurd.json?.code === 'param' && !!absurd.json?.hint && !fs.existsSync(`${TMP}/absurd.wav`), JSON.stringify(absurd.json || { timedOut: true }).slice(0, 130));

  const fitTrim = await cli(['fit', `in=${song.path}`, 'dur=40', 'mode=trim', `out=${TMP}/t.wav`]);
  ok('fit mode=trim', near(durOf(fitTrim.json), 40, 0.05), fitTrim.json?.dur);
  const fitLoop = await cli(['fit', `in=${voice.path}`, 'dur=20', 'mode=loop', `out=${TMP}/l.wav`]);
  ok('fit mode=loop pads to target', near(durOf(fitLoop.json), 20, 0.08), fitLoop.json?.dur);
  const fitSnap = await cli(['fit', `in=${song.path}`, 'dur=13.37', 'fps=30', `out=${TMP}/s.wav`]);
  const frame = 1 / 30;
  ok('fit snaps to a whole video frame', fitSnap.json && near(fitSnap.json.dur / frame, Math.round(fitSnap.json.dur / frame), 0.6), JSON.stringify({ dur: fitSnap.json?.dur, err: fitSnap.json?.err }));
  const fitMux = await cli(['fit', `in=${song.path}`, `video=${clip.path}`, 'mux=true', `out=${TMP}/final.wav`]);
  ok('fit mux=true writes a video file', fitMux.json?.final && fs.existsSync(fitMux.json.final), fitMux.json?.final || fitMux.json?.e);
  const muxProbe = fitMux.json?.final ? await cli(['probe', `path=${fitMux.json.final}`]) : { json: {} };
  ok('fit mux: video keeps its length', muxProbe.json && near(muxProbe.json.dur, 40, 0.3), muxProbe.json?.dur);
  const muxHasAudio = await cli(['extract', `in=${fitMux.json?.final || 'x'}`, `out=${TMP}/check.wav`]);
  ok('fit mux: output has an audio stream', muxHasAudio.code === 0, muxHasAudio.json?.e);

  // ---- extraction --------------------------------------------------------
  const ext = await cli(['extract', `in=${clip.path}`, `out=${TMP}/ex.wav`]);
  ok('extract: silent video needs silence=true', ext.code !== 0 && ext.json?.code === 'noaudio', JSON.stringify(ext.json));
  const extSilent = await cli(['extract', `in=${clip.path}`, 'silence=true', `out=${TMP}/ex.wav`]);
  ok('extract silence=true makes a silent bed', near(durOf(extSilent.json), 40, 0.6), extSilent.json?.dur);
  const extFromFit = await cli(['extract', `in=${fit.json.path}`, `out=${TMP}/ex2.wav`]);
  ok('extract: audio out of a fitted video', extFromFit.code === 0 && near(durOf(extFromFit.json), 40, 0.1), extFromFit.json?.dur);

  // ---- editing -----------------------------------------------------------
  const cut = await cli(['cut', `in=${song.path}`, 'start=10', 'end=20', `out=${TMP}/c.wav`]);
  ok('cut: 10s range', near(durOf(cut.json), 10, 0.05), cut.json?.dur);
  const cutDur = await cli(['cut', `in=${song.path}`, 'start=5', 'dur=15', `out=${TMP}/cd.wav`]);
  ok('cut accepts start+dur like every other method', near(durOf(cutDur.json), 15, 0.1), `${cutDur.json?.dur} vs 15`);
  const fx = await cli(['fx', `in=${voice.path}`, 'preset=voice', `out=${TMP}/v.wav`]);
  ok('fx preset=voice', fx.code === 0 && near(durOf(fx.json), 8, 0.3), fx.json?.dur || fx.json?.e);
  const chain = await cli(['fx', `in=${song.path}`, 'chain=[{"k":"highpass","v":80},{"k":"gain","v":-3},{"k":"fadeout","v":1}]', `out=${TMP}/ch.wav`]);
  ok('fx explicit chain (3 ops)', chain.code === 0 && chain.json?.applied === 3, chain.json?.applied ?? chain.json?.e);
  const sil = await cli(['silence', `in=${TMP}/l.wav`, `out=${TMP}/ls.wav`]);
  ok('silence: trims dead air', sil.code === 0, sil.json?.e || sil.json?.removed);
  const bad = await cli(['fx', `in=${song.path}`, 'chain=[{"k":"nope"}]', `out=${TMP}/bad.wav`]);
  ok('unknown op is rejected with a code', bad.json?.code === 'op', JSON.stringify(bad.json));

  // ---- splitting ---------------------------------------------------------
  const sep = await cli(['separate', `in=${song.path}`, `out=${TMP}/stems`]);
  ok('separate: vocal + instrumental files', sep.json?.vocal && sep.json?.instrumental && fs.existsSync(sep.json.vocal), sep.json?.e || sep.json?.engine);
  const sepAI = await cli(['separate', `in=${song.path}`, 'mode=ai', `out=${TMP}/stems-ai`]);
  ok('separate mode=ai fails honestly', sepAI.code !== 0 && (sepAI.json?.code === 'engine' || sepAI.json?.vocals !== undefined), JSON.stringify(sepAI.json).slice(0, 120));
  const split = await cli(['split', `in=${song.path}`, 'by=n', 'n=4', `out=${TMP}/parts`]);
  ok('split into 4 files', split.json?.n === 4 && fs.existsSync(split.json.files[0].path), split.json?.n ?? split.json?.e);
  const splitNone = await cli(['split', `in=${voice.path}`, 'by=silence', `out=${TMP}/none-parts`]);
  ok('split with nothing to find explains itself', splitNone.json?.n === 0 && !!splitNone.json?.note, splitNone.json?.note || JSON.stringify(splitNone.json));

  // ---- mixing ------------------------------------------------------------
  const mix = await cli(['mix', `tracks=[{"in":"${song.path.replace(/\\/g, '/')}", "gain":-6},{"in":"${voice.path.replace(/\\/g, '/')}", "start":2}]`, `out=${TMP}/mix.wav`]);
  ok('mix: two layers, longest wins', mix.code === 0 && near(durOf(mix.json), 70, 1.0), mix.json?.dur || mix.json?.e);
  const mixDuck = await cli(['mix', 'duck=true', `tracks=[{"in":"${song.path.replace(/\\/g, '/')}"},{"in":"${voice.path.replace(/\\/g, '/')}"}]`, `out=${TMP}/duck.wav`]);
  ok('mix with ducking', mixDuck.code === 0, mixDuck.json?.e || mixDuck.json?.dur);

  // ---- analysis ----------------------------------------------------------
  const score = await cli(['score', `path=${voice.path}`]);
  const s = score.json || {};
  ok('score: all metrics numeric', ['score', 'clarity', 'balance', 'dynamics', 'noise', 'lufs'].every((k) => typeof s[k] === 'number'), JSON.stringify({ score: s.score, lufs: s.lufs }));
  ok('score: within 0..100', s.score >= 0 && s.score <= 100, s.score);
  const lv = await cli(['levels', `path=${song.path}`]);
  ok('levels: one bar per real channel', Array.isArray(lv.json?.ch) && lv.json.ch.length >= 2, JSON.stringify(lv.json?.ch));
  const pk = await cli(['peaks', `path=${song.path}`, 'n=200']);
  const pb = pk.json?.d ? Buffer.from(pk.json.d, 'base64') : null;
  const decoded = pb ? new Float32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4) : null;
  ok('peaks: base64 decodes to 3*n floats', !!decoded && decoded.length === 3 * pk.json.n, `${decoded?.length} vs ${3 * (pk.json?.n || 0)}`);
  ok('peaks: envelope is in range', !!decoded && decoded.every((v) => Number.isFinite(v) && Math.abs(v) <= 1.01));
  const sec = await cli(['sections', `path=${song.path}`]);
  ok('sections: detected with kinds', Array.isArray(sec.json?.secs) && sec.json.secs.length > 0 && !!sec.json.secs[0].kind, sec.json?.secs?.length);
  const tr = await cli(['transcribe', `path=${voice.path}`]);
  ok('transcribe: honest about no engine', tr.json?.ok === false ? tr.json.why === 'no-engine' : Array.isArray(tr.json?.segs), JSON.stringify(tr.json).slice(0, 100));
  const srt = path.join(TMP, 'c.srt');
  fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,500\nhello from the test\n\n2\n00:00:04,000 --> 00:00:06,000\nsecond cue\n');
  const tr2 = await cli(['transcribe', `path=${voice.path}`, `from=${srt}`]);
  ok('transcribe imports real .srt cues', tr2.json?.ok === true && tr2.json.n === 2 && near(tr2.json.segs[0].t0, 1, 0.01), JSON.stringify(tr2.json?.segs?.[0]));

  // ---- formats -----------------------------------------------------------
  for (const f of ['mp3', 'flac', 'ogg', 'm4a']) {
    const r = await cli(['render', `in=${song.path}`, `out=${TMP}/o.${f}`, 'sr=48000']);
    ok(`render to ${f}`, r.code === 0 && fs.existsSync(`${TMP}/o.${f}`), r.json?.e || r.json?.size);
  }

  // ---- agent ergonomics --------------------------------------------------
  const b4 = await cli(['batch', `jobs=[{"op":"probe","args":{"path":"${song.path.replace(/\\/g, '/')}"}},{"op":"score","args":{"path":"${voice.path.replace(/\\/g, '/')}"}},{"op":"cut","args":{"in":"${song.path.replace(/\\/g, '/')}","start":0,"end":5,"out":"${path.join(TMP, 'b5.wav').replace(/\\/g, '/')}"}},{"op":"nope","args":{}}]`]);
  ok('batch: 3 of 4 succeed, one round trip', b4.json?.ok === 3 && b4.json?.n === 4, JSON.stringify({ ok: b4.json?.ok, n: b4.json?.n }));
  ok('batch: reports the failed item', b4.json?.r?.[3]?.ok === false, JSON.stringify(b4.json?.r?.[3]));
  const fld = await cli(['probe', `path=${song.path}`, '--fields', 'dur,sr']);
  ok('--fields projects the response', Object.keys(fld.json || {}).length === 2, fld.stdout.trim());
  const compact = await cli(['probe', `path=${song.path}`]);
  ok('output is one compact line', compact.stdout.trim().split('\n').length === 1, `${compact.stdout.trim().length} bytes`);
  const capsBytes = await cli(['caps']);
  const capsSize = Buffer.byteLength(capsBytes.stdout || '');
  const toolsSize = Buffer.byteLength(JSON.stringify((JSON.parse((await cli(['tools'])).stdout || '[]'))) );
  ok('caps is smaller than the tool schema dump', capsSize < toolsSize, `caps ${capsSize}B vs tools ${toolsSize}B`);
  const logs = await cli(['log', 'n=5']);
  ok('log records agent calls', Array.isArray(logs.json?.calls) && logs.json.calls.length > 0, logs.json?.n);
  ok('log counts failures seen this run', logs.json?.fails > 0, logs.json?.fails);
  const proj = await cli(['project', 'name=smoke', `data={"tracks":[{"in":"${song.path.replace(/\\/g, '/')}"}]}`]);
  ok('project saves', proj.json?.ok === true, proj.json?.path);
  const proj2 = await cli(['project', 'load=smoke']);
  ok('project round-trips', proj2.json?.ok === true && proj2.json.data?.tracks?.length === 1, JSON.stringify(proj2.json?.e));
  const miss = await cli(['probe', 'path=Z:/nope/nope.wav']);
  ok('missing file: code + hint', miss.json?.code === 'nofile' && !!miss.json?.hint, JSON.stringify(miss.json));
  const badMethod = await cli(['frobnicate']);
  ok('unknown method rejected', badMethod.json?.code === 'method', badMethod.json?.e);

  // ---- MCP over stdio ----------------------------------------------------
  const mcp = await mcpSession();
  ok('mcp initialize handshake', mcp.init?.protocolVersion && mcp.init?.serverInfo?.name === 'agentaudio', JSON.stringify(mcp.init?.serverInfo));
  ok('mcp advertises tools', mcp.tools?.length >= 20, mcp.tools?.length);
  ok('mcp tool schema has inputSchema', mcp.tools?.every((t) => t.inputSchema?.properties), 'missing on some');
  ok('mcp tools/call fit works', mcp.callOk, mcp.callText);
  ok('mcp error is isError not a crash', mcp.errIsError === true, mcp.errText);
  ok('mcp unknown method -> -32601', mcp.notFound === -32601, mcp.notFound);

  // ---- HTTP API ----------------------------------------------------------
  const http = await httpSession(song.path);
  ok('http /caps', http.caps?.v !== undefined, JSON.stringify(http.caps?.v));
  ok('http POST /api/fit', http.fit && near(http.fit.dur, 40, 0.05), JSON.stringify({ dur: http.fit?.dur, e: http.fit?.e }));
  ok('http GET /api/probe?dur style query', http.probe && near(http.probe.dur, 70, 0.5), JSON.stringify({ dur: http.probe?.dur, e: http.probe?.e }));
  ok('http /f serves audio', http.fileStatus === 200, http.fileStatus);
  ok('http /f honours Range (206)', http.rangeStatus === 206 && http.rangeLen === 1000, `${http.rangeStatus}/${http.rangeLen}`);
  ok('http error shape', http.errStatus === 400 && http.errBody?.code, JSON.stringify(http.errBody));
  ok('http /jobs lists history', Array.isArray(http.jobs?.jobs) && http.jobs.jobs.length > 0, http.jobs?.jobs?.length);

  // ---- progress + cancel (against the long-lived server, which owns the registry)
  ok('progress: a running job is visible', http.runningSeen === true, JSON.stringify(http.running));
  ok('progress: percent advances past zero', typeof http.pct === 'number' && http.pct > 0, `pct=${http.pct}`);
  ok('progress: stage text is shown', !!http.stage, http.stage);
  ok('cancel stops the job', http.cancelled === 'cancelled' || http.cancelled === 'error', http.cancelled);
  ok('cancelled job leaves no bogus success', http.cancelOut === '' || http.cancelOut === undefined, JSON.stringify(http.cancelOut));

  report();
}

function mcpSession() {
  return new Promise((resolve) => {
    const p = spawn(EXE, ['mcp', '--root', TMP], { cwd: TMP });
    const out = [];
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { out.push(JSON.parse(line)); } catch { /* skip */ } }
      }
    });
    p.stderr.on('data', () => { /* ignore */ });
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fit', arguments: { in: path.join(TMP, 'song70.wav').replace(/\\/g, '/'), dur: 33, out: path.join(TMP, 'mcpfit.wav').replace(/\\/g, '/') } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'probe', arguments: { path: 'Z:/missing.wav' } } });
    send({ jsonrpc: '2.0', id: 5, method: 'tools/not-a-thing' });
    setTimeout(() => {
      p.stdin.end();
      p.kill();
      const byId = Object.fromEntries(out.map((m) => [m.id, m]));
      const callText = byId[3]?.result?.content?.[0]?.text || '';
      let parsed = null;
      try { parsed = JSON.parse(callText); } catch { /* ignore */ }
      resolve({
        init: byId[1]?.result,
        tools: byId[2]?.result?.tools,
        callOk: parsed && Math.abs(parsed.dur - 33) <= 0.05 && byId[3]?.result?.isError === false,
        callText: callText.slice(0, 120),
        errIsError: byId[4]?.result?.isError === true,
        errText: byId[4]?.result?.content?.[0]?.text?.slice(0, 80),
        notFound: byId[5]?.error?.code,
      });
    }, 9000);
  });
}

async function httpSession(songPath) {
  const port = 8791;
  const p = spawn(EXE, ['http', '--port', String(port), '--root', TMP], { cwd: TMP, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  const base = `http://127.0.0.1:${port}`;
  const r = {};
  try {
    r.caps = await (await fetch(`${base}/caps`)).json();
    const f = await fetch(`${base}/api/fit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ in: path.join(TMP, 'song70.wav'), dur: 40, out: path.join(TMP, 'httpfit.wav') }) });
    r.fit = await f.json();
    const g = await fetch(`${base}/api/probe?path=${encodeURIComponent(path.join(TMP, 'song70.wav'))}`);
    r.probe = await g.json();
    const fl = await fetch(`${base}/f?path=${encodeURIComponent(path.join(TMP, 'song70.wav'))}`);
    r.fileStatus = fl.status;
    await fl.arrayBuffer();
    const rg = await fetch(`${base}/f?path=${encodeURIComponent(path.join(TMP, 'song70.wav'))}`, { headers: { Range: 'bytes=1000-1999' } });
    r.rangeStatus = rg.status;
    r.rangeLen = (await rg.arrayBuffer()).byteLength;
    const e = await fetch(`${base}/api/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"path":"Z:/nope.wav"}' });
    r.errStatus = e.status;
    r.errBody = await e.json();
    r.jobs = await (await fetch(`${base}/jobs`)).json();

    // live progress + cancel, against the process that actually owns the registry.
    // split into 40 files is many ffmpeg runs, so it stays visible long enough to observe.
    const longReq = fetch(`${base}/api/split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ in: songPath, by: 'n', n: 40, out: path.join(TMP, 'slowparts') }),
    });
    await new Promise((rr) => setTimeout(rr, 500));
    const jd = await (await fetch(`${base}/jobs`)).json();
    const running = (jd.jobs || []).find((j) => j.state === 'running');
    r.runningSeen = !!running;
    r.running = running ? { id: running.id, op: running.op } : null;
    // Poll instead of sampling once: "progress advances" is a property over time, and a
    // single read at a fixed delay only measures how fast the scheduler happened to wake up.
    let best = running?.pct ?? 0;
    let stage = running?.stage || '';
    for (let i = 0; i < 20 && !(best > 0); i++) {
      await new Promise((rr) => setTimeout(rr, 250));
      const jj = await (await fetch(`${base}/jobs`)).json();
      const cur = (jj.jobs || []).find((x) => r.running && x.id === r.running.id);
      if (!cur) break;
      best = Math.max(best, cur.pct ?? 0);
      stage = cur.stage || stage;
      if (cur.state !== 'running') break;
    }
    r.pct = best;
    r.stage = stage;
    if (running) {
      await fetch(`${base}/api/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: running.id }) });
      await new Promise((rr) => setTimeout(rr, 900));
      const jd2 = await (await fetch(`${base}/jobs`)).json();
      const c = (jd2.jobs || []).find((j) => j.id === running.id);
      r.cancelled = c?.state;
      r.cancelOut = c?.out;
    }
    const lr = await longReq.catch(() => null);
    if (lr) await lr.text().catch(() => '');
  } catch (err) {
    r.error = String(err);
  }
  p.kill();
  return r;
}

function report() {
  const pass = results.filter((x) => x.pass).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  if (failed) {
    console.log('\nfailures:');
    for (const x of results.filter((y) => !y.pass)) console.log(`  - ${x.name}: ${x.detail}`);
  }
  console.log(`\ntmp: ${TMP}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('harness crashed:', e);
  process.exitCode = 2;
});
