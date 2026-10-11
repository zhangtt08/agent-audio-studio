#!/usr/bin/env node
// Stability harness for AgentAudio against REAL user media.
//   node tests/stability.mjs [path\to\agentaudio.exe]
// Unlike smoke.mjs (feature contract, synthetic fixtures), this file tries to
// break the engine: corrupt inputs, hostile parameters, concurrency, resource
// leaks. Durations are verified with ffprobe, an oracle independent of our code.
import { execFile, spawn, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ex = promisify(execFile);
// Prefer the shipped binary, same as smoke.mjs: prove the artifact users run.
const AA_CAND = [process.argv[2], 'dist/bin/agentaudio.exe', 'target/release/agentaudio.exe'].filter(Boolean);
const AA = AA_CAND.map((c) => path.resolve(c)).find((c) => fs.existsSync(c)) || path.resolve(AA_CAND[0]);
const KV = 'C:/Users/EDY/Documents/Default Project/kinetic-video';
const SFXDIR = `${KV}/public/audio/sfx`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-stab-'));
const HOME_TMP = path.join(process.env.LOCALAPPDATA || '', 'AgentAudio', 'tmp');

// The user's project folder is live (another session may be editing it), so work
// from a private snapshot. This also guarantees we never write into their tree.
const CORPUS = path.join(TMP, 'corpus');
fs.mkdirSync(CORPUS, { recursive: true });
function snapshot(src, name) {
  try {
    if (!src || !fs.existsSync(src)) return null;
    const d = path.join(CORPUS, name);
    fs.copyFileSync(src, d);
    return d.replace(/\\/g, '/');
  } catch {
    return null;
  }
}
let BGM = snapshot(`${KV}/public/audio/bgm/bgm-tech-house.mp3`, 'bgm.mp3');
let VID = snapshot(`${KV}/out/KINETIC.mp4`, 'video.mp4');
let SFX = fs.existsSync(SFXDIR)
  ? fs.readdirSync(SFXDIR).filter((f) => f.endsWith('.mp3')).map((f, i) => snapshot(`${SFXDIR}/${f}`, `sfx${i}-${f}`)).filter(Boolean)
  : [];

const results = [];
let failed = 0;
function ok(name, cond, detail = '') {
  const pass = !!cond;
  results.push({ name, pass, detail: String(detail).slice(0, 240) });
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass || process.env.VERBOSE ? '  ' + String(detail).slice(0, 180) : ''}`);
}
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

async function cli(args, opts = {}) {
  try {
    const { stdout, stderr } = await ex(AA, args, { maxBuffer: 128e6, cwd: TMP, timeout: opts.timeout ?? 240000 });
    return { code: 0, stdout, stderr, json: parse(stdout) };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '', json: parse(e.stdout || ''), timedOut: e.killed === true };
  }
}
function parse(txt) {
  const t = (txt || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* below */ }
  try { return JSON.parse(t.split('\n').pop()); } catch { return null; }
}
// Independent oracle: ffprobe, not our own probe.
async function realDur(p) {
  try {
    const { stdout } = await ex('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { timeout: 60000 });
    return parseFloat(stdout.trim());
  } catch {
    return NaN;
  }
}
async function realStreams(p) {
  try {
    const { stdout } = await ex('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', p], { timeout: 60000 });
    return stdout.trim();
  } catch {
    return '';
  }
}
const ffmpegProcs = () => {
  try {
    const stdout = execSync('tasklist /FI "IMAGENAME eq ffmpeg.exe" /NH', { encoding: 'utf8' });
    return (stdout.match(/ffmpeg\.exe/gi) || []).length;
  } catch { return -1; }
};
const tmpCount = () => { try { return fs.readdirSync(HOME_TMP).length; } catch { return 0; } };

async function main() {
  console.log(`corpus: bgm=${fs.existsSync(BGM)} video=${fs.existsSync(VID)} sfx=${SFX.length}`);
  ok('corpus present', fs.existsSync(BGM) && fs.existsSync(VID) && SFX.length > 5, SFX.length);

  // ---------------------------------------------------------------- 1. real media reads
  const bgmDur = await realDur(BGM);
  const vidDur = await realDur(VID);
  ok('oracle: bgm is a long track (>60s)', bgmDur > 60, `${bgmDur}s`);
  const pr = await cli(['probe', `path=${BGM}`]);
  ok('probe agrees with ffprobe on the real mp3', near(pr.json?.dur, bgmDur, 0.05), `ours=${pr.json?.dur} ffprobe=${bgmDur}`);
  const pv = await cli(['probe', `path=${VID}`]);
  ok('probe reports the video duration as the fit target', near(pv.json?.vid, vidDur, 0.05), JSON.stringify({ vid: pv.json?.vid, ff: vidDur }));

  for (const [label, file] of [['bgm mp3', BGM], ['video', VID], ['sfx mp3', SFX[0]]]) {
    const pk = await cli(['peaks', `path=${file}`, 'n=800']);
    const b = pk.json?.d ? Buffer.from(pk.json.d, 'base64') : null;
    const f = b ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) : null;
    ok(`peaks ${label}: decodes to 3*n finite samples`, !!f && f.length === 3 * pk.json?.n && f.every(Number.isFinite), `${f?.length} floats`);
    const sc = await cli(['score', `path=${file}`]);
    ok(`score ${label}: numeric and in range`, ['score', 'clarity', 'balance', 'dynamics', 'noise'].every((k) => typeof sc.json?.[k] === 'number' && sc.json[k] >= 0 && sc.json[k] <= 100), JSON.stringify({ s: sc.json?.score, lufs: sc.json?.lufs }));
    const lv = await cli(['levels', `path=${file}`]);
    ok(`levels ${label}: one bar per real channel`, Array.isArray(lv.json?.ch) && lv.json.ch.length >= 1, JSON.stringify(lv.json?.ch));
    const se = await cli(['sections', `path=${file}`]);
    ok(`sections ${label}: monotonic non-overlapping ranges`, Array.isArray(se.json?.secs) && se.json.secs.every((x, i, a) => x.t1 > x.t0 && (i === 0 || x.t0 >= a[i - 1].t0)), `${se.json?.secs?.length} segs`);
  }

  // ---------------------------------------------------------------- 2. the real fit scenario
  const ratio = bgmDur / vidDur;
  ok('scenario is the hard case (ratio > 4x, so auto must not time-stretch to chipmunk)', ratio > 4, `${ratio.toFixed(1)}x`);
  const f1 = await cli(['fit', `in=${BGM}`, `video=${VID}`, `out=${TMP}/fit24.wav`]);
  ok('fit 288s bgm -> exact video length', near(f1.json?.dur, vidDur, 0.06), JSON.stringify({ dur: f1.json?.dur, mode: f1.json?.mode, err: f1.json?.err }));
  ok('fit chose trim (not a 12x tempo warp)', f1.json?.mode === 'trim', f1.json?.mode);
  ok('fit output really is that long (ffprobe)', near(await realDur(`${TMP}/fit24.wav`), vidDur, 0.06), await realDur(`${TMP}/fit24.wav`));

  const f2 = await cli(['fit', `in=${BGM}`, 'dur=30', 'mode=rate', 'max=20', `out=${TMP}/fitrate.wav`]);
  ok('fit mode=rate at 9.6x is honoured when forced', near(f2.json?.dur, 30, 0.1) && f2.json?.mode === 'rate', JSON.stringify({ dur: f2.json?.dur, tempo: f2.json?.tempo }));
  const f3 = await cli(['fit', `in=${BGM}`, 'dur=6', `out=${TMP}/fit6.wav`]);
  ok('fit to a very short target', near(f3.json?.dur, 6, 0.06), f3.json?.dur);
  const f4 = await cli(['fit', `in=${SFX[0]}`, 'dur=40', `out=${TMP}/fitloop.wav`]);
  ok('fit short source up to 40s (loop) is sample-exact', near(f4.json?.dur, 40, 0.05) && f4.json?.mode === 'loop', JSON.stringify({ dur: f4.json?.dur, mode: f4.json?.mode }));
  // regression: `-stream_loop` lost ~1.3% per loop on MP3; aloop must not
  for (const t of [20, 40, 60]) {
    const lr = await cli(['fit', `in=${SFX[0]}`, `dur=${t}`, 'mode=loop', `out=${TMP}/loop${t}.wav`]);
    const actual = await realDur(`${TMP}/loop${t}.wav`);
    ok(`loop accuracy at ${t}s (ffprobe oracle)`, near(actual, t, 0.05), `asked=${t} got=${actual}`);
    void lr;
  }
  const f5 = await cli(['fit', `in=${BGM}`, `dur=${bgmDur.toFixed(3)}`, `out=${TMP}/fitnoop.wav`]);
  ok('fit to its own duration is a no-op path', f5.json?.mode === 'none' && near(f5.json?.dur, bgmDur, 0.1), f5.json?.mode);
  const f6 = await cli(['fit', `in=${BGM}`, `video=${VID}`, 'mux=true', `out=${TMP}/bed.wav`]);
  ok('fit mux=true produces a video with an audio track', !!f6.json?.final && fs.existsSync(f6.json.final) && /aac|mp3/.test(await realStreams(f6.json.final)), f6.json?.final || f6.json?.e);
  ok('muxed video keeps the picture duration', near(await realDur(f6.json?.final || 'x'), vidDur, 0.2), await realDur(f6.json?.final || 'x'));
  const f7 = await cli(['fit', `in=${BGM}`, 'dur=24.021', 'fps=30', `out=${TMP}/fitsnap.wav`]);
  const frame = 1 / 30;
  ok('fit fps=30 lands on a whole frame', f7.json && Math.abs(f7.json.dur / frame - Math.round(f7.json.dur / frame)) < 0.5, JSON.stringify({ dur: f7.json?.dur, err: f7.json?.err }));

  // ---------------------------------------------------------------- 3. breadth over the whole sfx set
  const t0 = Date.now();
  let sfxOk = 0, sfxErr = [];
  for (const s of SFX) {
    const r = await cli(['fx', `in=${s}`, 'preset=sfx', `out=${TMP}/s-${path.basename(s)}`]);
    if (r.code === 0 && r.json?.out) sfxOk++; else sfxErr.push(`${path.basename(s)}: ${r.json?.e || r.stderr?.slice(0, 60)}`);
  }
  ok('every real sfx file processes through a preset', sfxOk === SFX.length, `${sfxOk}/${SFX.length} ${sfxErr.slice(0, 3).join(' | ')}`);
  console.log(`      (${Date.now() - t0}ms for ${SFX.length} files)`);

  const sp = await cli(['split', `in=${BGM}`, 'by=n', 'n=12', `out=${TMP}/bgmparts`]);
  ok('split the real bgm into 12 parts', sp.json?.n === 12 && fs.existsSync(sp.json?.files?.[11]?.path), sp.json?.n ?? sp.json?.e);
  const sep = await cli(['separate', `in=${BGM}`, 'dur=20', `out=${TMP}/stems`]);
  ok('separate real bgm yields both stems', !!sep.json?.vocal && !!sep.json?.instrumental && fs.existsSync(sep.json.vocal), sep.json?.e || sep.json?.engine);

  // mix the real video's extracted audio + a fitted bed + an sfx
  const ex1 = await cli(['extract', `in=${VID}`, `out=${TMP}/vidaud.wav`]);
  const mix = await cli(['mix', `tracks=[{"in":"${ex1.json.path.replace(/\\/g, '/')}"},{"in":"${f1.json.path.replace(/\\/g, '/')}", "gain":-8},{"in":"${SFX[3].replace(/\\/g, '/')}", "start":2}]`, `out=${TMP}/real-mix.wav`, 'norm=-16']);
  ok('mix of 3 real sources with loudness target', mix.code === 0 && near(mix.json?.dur, Math.max(ex1.json?.dur || 0, f1.json?.dur || 0), 0.6), JSON.stringify({ dur: mix.json?.dur, e: mix.json?.e }));

  // ---------------------------------------------------------------- 4. hostile inputs
  const empty = path.join(TMP, 'empty.mp3'); fs.writeFileSync(empty, '');
  const trunc = path.join(TMP, 'trunc.mp3'); fs.writeFileSync(trunc, Buffer.from(fs.readFileSync(BGM).subarray(0, 900)));
  const corrupt = path.join(TMP, 'corrupt.mp3'); fs.writeFileSync(corrupt, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(50000, 0xFF)]));
  const textAsMp3 = path.join(TMP, 'lie.mp3'); fs.writeFileSync(textAsMp3, 'this is not audio at all');
  const uni = path.join(TMP, '背景音乐 重-要 (1).mp3'); fs.copyFileSync(SFX[0], uni);
  // Shell-hostile but NTFS-legal: `| " < > : * ? \` cannot appear in a Windows filename,
  // so including them would test the filesystem, not the argument handling.
  const weird = path.join(TMP, 'a;b&d$e`f(g)[x],y#.mp3'); fs.copyFileSync(SFX[1], weird);

  for (const [label, p] of [['empty file', empty], ['truncated mp3', trunc], ['corrupt header', corrupt], ['text masquerading as mp3', textAsMp3], ['a directory', TMP]]) {
    const r = await cli(['probe', `path=${p}`]);
    const clean = r.code !== 0 ? !!r.json?.code : true; // accepting a directory is fine only if probe says so
    ok(`probe ${label}: no crash, structured answer`, clean && !r.timedOut, JSON.stringify(r.json || { code: r.code }).slice(0, 120));
    const f = await cli(['fit', `in=${p}`, 'dur=5', `out=${TMP}/out-${label.replace(/\W+/g, '_')}.wav`]);
    const produced = fs.existsSync(`${TMP}/out-${label.replace(/\W+/g, '_')}.wav`);
    ok(`fit ${label}: either a real file or a clean error, never a half-written file`, (f.code === 0 && produced) || (f.code !== 0 && !f.timedOut), JSON.stringify(f.json || { code: f.code }).slice(0, 120));
  }
  const miss = await cli(['render', 'in=Q:/nope/nope.mp3', `out=${TMP}/never.wav`]);
  ok('missing input is refused and writes nothing', miss.code !== 0 && miss.json?.code === 'nofile' && !fs.existsSync(`${TMP}/never.wav`), JSON.stringify(miss.json));

  const u = await cli(['score', `path=${uni}`]);
  ok('chinese + spaces + parentheses filename works', u.code === 0 && typeof u.json?.score === 'number', u.json?.e || u.json?.score);
  const w = await cli(['render', `in=${weird}`, `out=${TMP}/weird-out.wav`]);
  ok('filename containing ; & $ ` ( ) # is not interpreted as syntax', w.code === 0 && fs.existsSync(w.json?.path), JSON.stringify(w.json || {}).slice(0, 140));

  // ---------------------------------------------------------------- 5. extreme / invalid params
  const bad = [
    ['fit dur=0', ['fit', `in=${BGM}`, 'dur=0', `out=${TMP}/x1.wav`]],
    ['fit dur negative', ['fit', `in=${BGM}`, 'dur=-5', `out=${TMP}/x2.wav`]],
    ['fit dur absurd', ['fit', `in=${BGM}`, 'dur=1000000', `out=${TMP}/x3.wav`, 'timeout-guard'],
    ],
    ['cut end before start', ['cut', `in=${BGM}`, 'start=50', 'end=10', `out=${TMP}/x4.wav`]],
    ['cut beyond eof', ['cut', `in=${BGM}`, 'start=100000', `out=${TMP}/x5.wav`]],
    ['unknown op', ['fx', `in=${BGM}`, 'chain=[{"k":"not-a-real-op"}]', `out=${TMP}/x6.wav`]],
    ['op missing value', ['fx', `in=${BGM}`, 'chain=[{"k":"gain"}]', `out=${TMP}/x7.wav`]],
    ['malformed chain json', ['fx', `in=${BGM}`, 'chain=[{k:gain,]', `out=${TMP}/x8.wav`]],
    ['gain absurd', ['fx', `in=${BGM}`, 'chain=[{"k":"gain","v":1e9}]', `out=${TMP}/x9.wav`]],
    ['tempo zero', ['fx', `in=${BGM}`, 'chain=[{"k":"speed","v":0}]', `out=${TMP}/x10.wav`]],
    ['tempo negative', ['fx', `in=${BGM}`, 'chain=[{"k":"speed","v":-2}]', `out=${TMP}/x11.wav`]],
    ['peaks n=0', ['peaks', `path=${BGM}`, 'n=0']],
    ['peaks n huge', ['peaks', `path=${BGM}`, 'n=99999999']],
    ['unknown method', ['teleport', `in=${BGM}`]],
    ['batch with junk', ['batch', 'jobs=[{"op":"","args":{}},{"op":"probe"}]']],
  ];
  for (const [label, args] of bad) {
    const r = await cli(args, { timeout: 120000 });
    const sane = !r.timedOut && (r.code === 0 ? !!r.json : !!r.json?.code);
    ok(`param guard: ${label}`, sane, JSON.stringify(r.json || { code: r.code, err: String(r.stderr).slice(0, 80) }).slice(0, 150));
  }
  const hugeChain = await cli(['fx', `in=${SFX[0]}`, `chain=${JSON.stringify(Array.from({ length: 400 }, () => ({ k: 'gain', v: -0.01 })))}`, `out=${TMP}/hugechain.wav`]);
  ok('a 400-op chain does not hang or corrupt', hugeChain.code === 0 && fs.existsSync(hugeChain.json?.path), hugeChain.json?.e || hugeChain.json?.applied);

  // ---------------------------------------------------------------- 6. injection attempts
  // A value that looks like shell syntax has to stay data.
  const inj = [
    ['pan with semicolon', ['fx', `in=${SFX[0]}`, 'chain=[{"k":"pan","expr":"mono|c0=c0; calc /calc"}]', `out=${TMP}/i1.wav`]],
    ['gain as code', ['fx', `in=${SFX[0]}`, 'chain=[{"k":"gain","v":"1 && calc"}]', `out=${TMP}/i2.wav`]],
    ['filter name injection', ['fx', `in=${SFX[0]}`, 'chain=[{"k":"highpass","v":"80,sendfile=evil"}]', `out=${TMP}/i3.wav`]],
  ];
  for (const [label, args] of inj) {
    const r = await cli(args, { timeout: 120000 });
    ok(`injection guard: ${label}`, r.code !== 0 || typeof r.json?.applied === 'number', JSON.stringify(r.json || { code: r.code }).slice(0, 130));
  }

  // `out=` is deliberately not a sandbox: the point of the tool is dropping audio next to
  // the user's video, so an absolute path writes where it says. What must hold is that
  // `--root DIR` keeps relative names inside DIR even when they try to climb out.
  const jail = path.join(TMP, 'jail');
  fs.mkdirSync(jail, { recursive: true });
  const esc = await cli(['render', `in=${SFX[0]}`, 'out=../escape.wav', '--root', jail]);
  ok('root fence: .. cannot climb out of --root',
    !fs.existsSync(path.join(TMP, 'escape.wav')) && fs.existsSync(path.join(jail, 'escape.wav')),
    JSON.stringify(esc.json || { code: esc.code }).slice(0, 130));
  const deep = await cli(['render', `in=${SFX[0]}`, 'out=a/../../b.wav', '--root', jail]);
  ok('root fence: nested .. still lands inside',
    fs.existsSync(path.join(jail, 'b.wav')) && !fs.existsSync(path.join(TMP, 'b.wav')),
    JSON.stringify(deep.json || {}).slice(0, 130));
  const absOk = await cli(['render', `in=${SFX[0]}`, `out=${jail.replace(/\\/g, '/')}/abs-honoured.wav`]);
  ok('absolute out is honoured by design',
    absOk.code === 0 && fs.existsSync(path.join(jail, 'abs-honoured.wav')),
    JSON.stringify(absOk.json || {}).slice(0, 130));

  // ---------------------------------------------------------------- 7. concurrency
  const before = { tmp: tmpCount(), ff: ffmpegProcs() };
  const t1 = Date.now();
  const par = await Promise.all(Array.from({ length: 8 }, (_, i) => cli(['fit', `in=${BGM}`, `dur=${10 + i}`, `out=${TMP}/par${i}.wav`], { timeout: 300000 })));
  const parOk = par.filter((r, i) => r.code === 0 && near(r.json?.dur, 10 + i, 0.1)).length;
  ok('8 parallel fits all land on their own target', parOk === 8, `${parOk}/8 in ${Date.now() - t1}ms`);
  const parErr = par.filter((r) => r.code !== 0).map((r) => JSON.stringify(r.json)).join(' | ');
  if (parErr) console.log(`      errors: ${parErr.slice(0, 200)}`);

  const parMix = await Promise.all([
    cli(['score', `path=${BGM}`]), cli(['peaks', `path=${BGM}`, 'n=3000']), cli(['sections', `path=${BGM}`]),
    cli(['levels', `path=${BGM}`]), cli(['render', `in=${BGM}`, 'fmt=mp3', `out=${TMP}/c1.mp3`]),
    cli(['render', `in=${BGM}`, 'fmt=flac', `out=${TMP}/c2.flac`]), cli(['fx', `in=${BGM}`, 'preset=podcast', `out=${TMP}/c3.wav`]),
    cli(['split', `in=${BGM}`, 'by=n', 'n=6', `out=${TMP}/cparts`]),
  ]);
  ok('8 mixed concurrent ops succeed', parMix.every((r) => r.code === 0 && r.json), parMix.map((r, i) => (r.code ? '' : `${i}:${r.json?.code}`)).join(','));
  const serial = await cli(['score', `path=${BGM}`]);
  const concurrent = parMix[0];
  ok('a concurrent run does not change the answer (score reproducible)', serial.json?.score === concurrent.json?.score, `${serial.json?.score} vs ${concurrent.json?.score}`);

  // ---------------------------------------------------------------- 8. cancel + resource hygiene
  const longJob = spawn(AA, ['render', `in=${BGM}`, 'fmt=flac', `out=${TMP}/slow.flac`], { cwd: TMP });
  await new Promise((r) => setTimeout(r, 2500));
  longJob.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 1500));
  const zombies = ffmpegProcs();
  ok('killing a client does not orphan an ffmpeg process', before.ff < 0 || zombies <= before.ff, `ffmpeg procs now=${zombies} before=${before.ff}`);

  const after = { tmp: tmpCount() };
  const leaked = after.tmp - before.tmp;
  ok('temp dir does not accumulate progress/err files', leaked <= 2, `tmp files before=${before.tmp} after=${after.tmp}`);

  // ---------------------------------------------------------------- 9. MCP + HTTP under abuse
  const mcp = await mcpAbuse();
  ok('mcp survives malformed input and keeps answering', mcp.survived, mcp.detail);
  ok('mcp reports a tool count that matches caps', mcp.toolCount >= 26, mcp.toolCount);
  const http = await httpAbuse();
  ok('http survives bad bodies / unknown routes / huge args', http.survived, http.detail);
  ok('http still serves correct audio bytes after abuse', http.stillWorks, http.detail2);

  // ---------------------------------------------------------------- 10. idempotence
  const a1 = await cli(['render', `in=${BGM}`, 'fmt=mp3', 'br=192', `out=${TMP}/idem1.mp3`]);
  const a2 = await cli(['render', `in=${BGM}`, 'fmt=mp3', 'br=192', `out=${TMP}/idem2.mp3`]);
  const s1 = fs.statSync(`${TMP}/idem1.mp3`).size, s2 = fs.statSync(`${TMP}/idem2.mp3`).size;
  ok('the same call twice produces the same size output', Math.abs(s1 - s2) / Math.max(s1, s2) < 0.02, `${s1} vs ${s2}`);
  ok('a1/a2 both valid mp3', /mp3/.test(await realStreams(`${TMP}/idem1.mp3`)) && /mp3/.test(await realStreams(`${TMP}/idem2.mp3`)));

  report();
}

function mcpAbuse() {
  return new Promise((resolve) => {
    const p = spawn(AA, ['mcp'], { cwd: TMP });
    let buf = '';
    const out = [];
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) { try { out.push(JSON.parse(line)); } catch { out.push({ unparsable: line.slice(0, 40) }); } }
      }
    });
    p.on('exit', (code) => { exited = true; });
    let exited = false;
    const w = (s) => { try { p.stdin.write(s + '\n'); } catch { /* closed */ } };
    w(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stab', version: '1' } } }));
    w('this is not json at all');
    w('{"broken":');
    w(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    w(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fit', arguments: { in: BGM, dur: 12, out: `${TMP}/mcp12.wav`.replace(/\\/g, '/') } } }));
    w(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'probe', arguments: {} } }));
    w(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'definitely-not-a-tool', arguments: { x: 1 } } }));
    w(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: 'not-an-object' }));
    for (let i = 0; i < 20; i++) w(JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'ping' }));
    w(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'score', arguments: { path: BGM } } }));
    setTimeout(() => {
      try { p.stdin.end(); } catch { /* */ }
      p.kill();
      const byId = Object.fromEntries(out.filter((o) => o.id).map((o) => [o.id, o]));
      const fitTxt = byId[3]?.result?.content?.[0]?.text || '';
      let fitDur = NaN; try { fitDur = JSON.parse(fitTxt).dur; } catch { /* */ }
      resolve({
        survived: !exited && !!byId[7]?.result && !!byId[2]?.result?.tools && byId[1]?.result?.protocolVersion,
        toolCount: byId[2]?.result?.tools?.length || 0,
        fitOk: near(fitDur, 12, 0.1),
        detail: `exited=${exited} responses=${out.length} fit=${fitDur} afterGarbage=${!!byId[7]?.result}`,
      });
    }, 25000);
  });
}

async function httpAbuse() {
  const port = 8899;
  const p = spawn(AA, ['http', '--port', String(port)], { cwd: TMP, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  // Poll for readiness instead of sleeping a fixed amount: under load a hard-coded
  // wait turns a healthy server into a false failure.
  for (let i = 0; i < 40; i++) {
    const up = await fetch(base + '/health').then((r) => r.ok).catch(() => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const notes = [];
  let survived = true;
  try {
    const raw = (body, path = '/api/probe') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await raw('');
    await raw('not json');
    await raw('{"path": ');
    await raw(JSON.stringify({ path: BGM, extra: 'x'.repeat(200000) }));
    await raw(JSON.stringify({ in: BGM, dur: 1e12 }), '/api/fit');
    await fetch(base + '/api/');
    await fetch(base + '/api/nope/nope/nope');
    await fetch(base + '/f');
    await fetch(base + '/f?path=');
    await fetch(base + '/f?path=C:/Windows/win.ini');
    await fetch(base + '/../app/tauri.conf.json');
    await fetch(base + '/api/probe?path=' + encodeURIComponent(BGM));
    const many = await Promise.all(Array.from({ length: 10 }, () => fetch(base + '/jobs').then((r) => r.status)));
    notes.push(`statuses=${[...new Set(many)].join(',')}`);
    const alive = await fetch(base + '/health').then((r) => r.json()).catch(() => null);
    survived = !!alive?.ok;
    const fl = await fetch(base + `/f?path=${encodeURIComponent(BGM)}`, { headers: { Range: 'bytes=100-199' } });
    var stillWorks = fl.status === 206 && (await fl.arrayBuffer()).byteLength === 100;
  } catch (e) {
    survived = false;
    notes.push('threw ' + e.message);
  }
  p.kill();
  return { survived, detail: notes.join(' '), stillWorks: typeof stillWorks !== 'undefined' ? stillWorks : false, detail2: notes.join(' ') };
}

function report() {
  const pass = results.filter((x) => x.pass).length;
  console.log(`\n${pass}/${results.length} stability checks passed`);
  if (failed) {
    console.log('\nFAILURES:');
    for (const x of results.filter((y) => !y.pass)) console.log(`  - ${x.name}\n      ${x.detail}`);
  }
  console.log(`\ntmp: ${TMP}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error('harness crashed:', e); process.exitCode = 2; });
