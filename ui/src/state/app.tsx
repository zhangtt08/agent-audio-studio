import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { baseName, describeError, extOf, fileUrl, fmtTime, isTauri, rpc, type V } from '../api';
import {
  asCalls,
  asJobs,
  asLevels,
  asNum,
  asOps,
  asPairs,
  asSections,
  asSegs,
  asStr,
  type Call,
  type CapsRes,
  type DoctorRes,
  type Job,
  type LevelChan,
  type PeaksRes,
  type ProbeRes,
  type ScoreRes,
  type Seg,
  type Section,
} from '../types';
import { peaksFromRes, pickPeaksN, type Peaks } from '../lib/peaks';
import { makePoller, type Poller } from '../lib/poller';
import { parseSubtitles } from '../lib/subtitle';
import { player, type TrackSpec } from '../audio/player';

export type View = 'workbench' | 'tracks' | 'agent' | 'settings';

export const PALETTE = ['#EF4B3D', '#F5A623', '#A78BFA', '#60A5FA'];
export const KIND_LABEL: Record<string, string> = {
  speech: '语音',
  music: '音乐',
  hit: '打击',
  silence: '静音',
  part: '段落',
};
export const KIND_COLOR: Record<string, string> = {
  speech: '#EF4B3D',
  music: '#60A5FA',
  hit: '#F5A623',
  silence: '#8A8682',
  part: '#A78BFA',
};

export interface Track {
  id: string;
  name: string;
  path: string;
  url: string;
  color: string;
  dur: number;
  sr: number;
  ch: number;
  offset: number;
  gain: number;
  mute: boolean;
  solo: boolean;
  peaks: Peaks | null;
  peakN: number;
  peaksBusy: boolean;
}

export interface Prefs {
  fmt: string;
  sr: number;
  ch: number;
  target: number;
  normalize: boolean;
  outDir: string;
  ffmpeg: string;
  theme: 'light' | 'dark';
}

export interface Note {
  kind: 'ok' | 'err' | 'info';
  text: string;
}

export interface Analysis {
  score: ScoreRes | null;
  levels: LevelChan[];
  sections: Section[];
  busy: boolean;
}

const DEFAULT_PREFS: Prefs = {
  fmt: 'wav',
  sr: 48000,
  ch: 2,
  target: -16,
  normalize: true,
  outDir: '',
  ffmpeg: '',
  theme: 'light',
};

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'mpeg', 'mpg'];

let seq = 0;
const nextId = () => `t${++seq}`;

export interface Actions {
  fit: () => Promise<void>;
  separate: (mode: string) => Promise<void>;
  extractAudio: () => Promise<void>;
  cut: (a: number, b: number) => Promise<void>;
  stripSilence: () => Promise<void>;
  split: (by: string) => Promise<void>;
  mixAll: () => Promise<void>;
  loudnorm: () => Promise<void>;
  render: () => Promise<void>;
  reveal: (path: string) => Promise<void>;
  samples: () => Promise<void>;
}

export interface Ctx {
  view: View;
  setView: (v: View) => void;

  doctor: DoctorRes | null;
  caps: CapsRes | null;
  offline: boolean;
  reconnect: () => Promise<void>;

  tracks: Track[];
  selectedId: string;
  selected: Track | null;
  select: (id: string) => void;
  patchTrack: (id: string, p: Partial<Track>) => void;
  removeTrack: (id: string) => void;
  addPaths: (paths: string[]) => Promise<void>;
  pickFiles: () => Promise<void>;
  setSubsFromText: (text: string, label: string) => void;

  targetDur: number | null;
  setTargetDur: (v: number | null) => void;

  zoom: number;
  setZoom: (z: number) => void;
  pxPerSec: number;

  analysis: Analysis;
  transcript: Seg[];
  transcriptSrc: string;
  transcribe: () => Promise<void>;
  importSubs: () => void;

  jobs: Job[];
  job: Job | null;
  lastOut: string;
  cancelJob: (id: string) => Promise<void>;
  calls: Call[];
  callsTotal: number;
  refreshCalls: () => Promise<void>;

  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  projectName: string;
  setProjectName: (n: string) => void;

  note: Note | null;
  clearNote: () => void;
  notify: (kind: Note['kind'], text: string) => void;
  saveProject: () => Promise<void>;
  busy: string;

  actions: Actions;
  togglePlay: () => void;
  seek: (t: number) => void;
  step: (dir: -1 | 1) => void;
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const v = useContext(AppCtx);
  if (!v) throw new Error('AppProvider missing');
  return v;
}

function num(v: unknown, fb = 0): number {
  return typeof v === 'number' && isFinite(v) ? v : fb;
}

function prefsFrom(raw: unknown): Partial<Prefs> {
  let o: unknown = raw;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return {};
    }
  }
  if (!o || typeof o !== 'object') return {};
  const p = o as V;
  const out: Partial<Prefs> = {};
  if (typeof p.fmt === 'string') out.fmt = p.fmt;
  if (typeof p.sr === 'number') out.sr = p.sr;
  if (typeof p.ch === 'number') out.ch = p.ch;
  if (typeof p.target === 'number') out.target = p.target;
  if (typeof p.normalize === 'boolean') out.normalize = p.normalize;
  if (typeof p.outDir === 'string') out.outDir = p.outDir;
  if (typeof p.ffmpeg === 'string') out.ffmpeg = p.ffmpeg;
  if (p.theme === 'dark' || p.theme === 'light') out.theme = p.theme;
  return out;
}

/** The `data` blob is opaque to the engine, so the session rides inside it as `session`. */
function sessionFrom(raw: unknown): V | null {
  let o: unknown = raw;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object') return null;
  const s = (o as V).session;
  return s && typeof s === 'object' ? (s as V) : null;
}

function outPath(dir: string, name: string, fmt: string): string | undefined {
  if (!dir) return undefined;
  const sep = /[\\/]/.test(dir.slice(-1)) ? '' : dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}${name}.${fmt}`;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>('workbench');
  const [doctor, setDoctor] = useState<DoctorRes | null>(null);
  const [caps, setCaps] = useState<CapsRes | null>(null);
  const [offline, setOffline] = useState(false);

  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [targetDur, setTargetDur] = useState<number | null>(null);
  const [zoom, setZoomState] = useState(1);

  const [analysis, setAnalysis] = useState<Analysis>({ score: null, levels: [], sections: [], busy: false });
  const [transcript, setTranscript] = useState<Seg[]>([]);
  const [transcriptSrc, setTranscriptSrc] = useState('');

  const [jobs, setJobs] = useState<Job[]>([]);
  const [lastOut, setLastOut] = useState('');
  const [calls, setCalls] = useState<Call[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [projectName, setProjectName] = useState('未命名');
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState('');
  const [booted, setBooted] = useState(false);
  const [bootSession, setBootSession] = useState<V | null>(null);

  const tracksRef = useRef<Track[]>([]);
  tracksRef.current = tracks;
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;
  const selectedPathRef = useRef('');
  const cache = useRef(new Map<string, { score: ScoreRes | null; levels: LevelChan[]; sections: Section[] }>());
  const inflight = useRef(0);
  const pollers = useRef<{ jobs: Poller | null; log: Poller | null }>({ jobs: null, log: null });

  const pxPerSec = 60 * zoom;
  const say = useCallback((kind: Note['kind'], text: string) => setNote({ kind, text }), []);

  // ------------------------------------------------------------- pollers
  const jobPoller = () => {
    if (!pollers.current.jobs) {
      pollers.current.jobs = makePoller(async () => {
        const r = await rpc<V>('jobs');
        const list = asJobs(r.jobs);
        setJobs(list);
        if (!list.some((j) => j.state === 'running') && inflight.current <= 0) pollers.current.jobs?.stop();
      }, 300);
    }
    return pollers.current.jobs;
  };

  const logPoller = () => {
    if (!pollers.current.log) {
      pollers.current.log = makePoller(async () => {
        const r = await rpc<V>('log', { n: 200 });
        setCalls(asCalls(r.calls));
        setLogTotal(asNum(r.n));
      }, 2000);
    }
    return pollers.current.log;
  };

  const startJobs = useCallback(() => jobPoller().start(), []);

  const refreshCalls = useCallback(async () => {
    try {
      const r = await rpc<V>('log', { n: 200 });
      setCalls(asCalls(r.calls));
      setLogTotal(asNum(r.n));
    } catch {
      setCalls([]);
    }
    // one cheap jobs read keeps the render ring honest without extra timers
    try {
      const j = await rpc<V>('jobs');
      const list = asJobs(j.jobs);
      setJobs(list);
      if (list.some((x) => x.state === 'running')) jobPoller().start();
    } catch {
      /* no job table yet */
    }
  }, []);

  useEffect(() => {
    if (view === 'agent') logPoller().start();
    else logPoller().stop();
  }, [view]);

  useEffect(() => {
    void refreshCalls();
    const t = window.setTimeout(() => void refreshCalls(), 1500);
    return () => {
      window.clearTimeout(t);
      pollers.current.jobs?.stop();
      pollers.current.log?.stop();
    };
  }, [refreshCalls]);

  // ------------------------------------------------------------- backend probe
  const probeBackend = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([rpc<DoctorRes>('doctor'), rpc<CapsRes>('caps')]);
      setDoctor({
        ok: !!d.ok,
        ffmpeg: asStr(d.ffmpeg),
        ver: asStr(d.ver),
        jobs: num(d.jobs),
        home: asStr(d.home),
        out: asStr(d.out),
        db: typeof d.db === 'string' ? d.db : undefined,
      });
      const http = (c.http ?? {}) as V;
      const mcp = (c.mcp ?? {}) as V;
      setCaps({
        v: asStr(c.v),
        tools: asPairs(c.tools),
        ops: asOps(c.ops),
        presets: asPairs(c.presets),
        http: { port: num(http.port, 8787), up: !!http.up },
        mcp: { cmd: asStr(mcp.cmd), args: Array.isArray(mcp.args) ? mcp.args.map(String) : [] },
        dir: asStr(c.dir),
      });
      setOffline(false);
      const p = await rpc<V>('project', { load: true }).catch(() => ({}) as V);
      const raw = p.data ?? p;
      const merged = prefsFrom(raw);
      if (Object.keys(merged).length) setPrefsState((old) => ({ ...old, ...merged }));
      if (typeof p.name === 'string' && p.name) setProjectName(p.name);
      setBootSession(sessionFrom(raw));
      setBooted(true);
    } catch (e) {
      setDoctor(null);
      setCaps(null);
      setOffline(true);
      const { msg, hint } = describeError(e);
      setNote({ kind: 'info', text: hint ? `${msg} · ${hint}` : msg });
    }
  }, []);

  useEffect(() => {
    void probeBackend();
  }, [probeBackend]);

  // ------------------------------------------------------------- prefs
  const setPrefs = useCallback((p: Partial<Prefs>) => setPrefsState((old) => ({ ...old, ...p })), []);

  const projectData = useCallback(
    () =>
      JSON.stringify({
        ...prefs,
        session: {
          target: targetDur,
          tracks: tracksRef.current.map((t) => ({
            path: t.path,
            name: t.name,
            offset: t.offset,
            gain: t.gain,
            mute: t.mute,
            solo: t.solo,
          })),
        },
      }),
    [prefs, targetDur],
  );

  const saveTimer = useRef<number | null>(null);
  // Gated on `booted`: autosaving the empty first render would erase the session we are about to load.
  useEffect(() => {
    if (!booted) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void rpc('project', { save: true, name: projectName, data: projectData() }).catch(() => undefined);
    }, 700);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [booted, prefs, projectName, tracks, targetDur, projectData]);

  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
  }, [prefs.theme]);

  // ------------------------------------------------------------- tracks
  const patchTrack = useCallback((id: string, p: Partial<Track>) => {
    setTracks((old) => old.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }, []);

  const loadPeaks = useCallback(
    async (t: Track, force?: number) => {
      const n = force ?? pickPeaksN(t.dur, pxPerSec);
      if (t.peaks && t.peakN === n) return;
      patchTrack(t.id, { peaksBusy: true });
      try {
        const r = await rpc<PeaksRes>('peaks', { path: t.path, n });
        patchTrack(t.id, { peaks: peaksFromRes(r, t.dur), peakN: n, peaksBusy: false });
      } catch {
        patchTrack(t.id, { peaks: null, peakN: n, peaksBusy: false });
      }
    },
    [patchTrack, pxPerSec],
  );

  const addTrack = useCallback(
    (path: string, name: string, dur: number, sr: number, ch: number, offset = 0) => {
      const t: Track = {
        id: nextId(),
        name: name || baseName(path),
        path,
        url: fileUrl(path),
        color: PALETTE[(seq - 1) % PALETTE.length],
        dur: dur > 0 ? dur : 0,
        sr,
        ch,
        offset,
        gain: 1,
        mute: false,
        solo: false,
        peaks: null,
        peakN: 0,
        peaksBusy: false,
      };
      setTracks((old) => [...old, t]);
      setSelectedId((cur) => cur || t.id);
      void loadPeaks(t);
      return t;
    },
    [loadPeaks],
  );

  const replaceTrack = useCallback(
    (id: string, path: string, dur: number, sr: number, ch: number) => {
      const url = fileUrl(path);
      const before = tracksRef.current.find((t) => t.id === id);
      setTracks((old) =>
        old.map((t) => (t.id === id ? { ...t, path, url, dur, sr, ch, peaks: null, peakN: 0, offset: 0 } : t)),
      );
      if (before) void loadPeaks({ ...before, path, url, dur, sr, ch, peaks: null, peakN: 0 });
    },
    [loadPeaks],
  );

  useEffect(() => {
    for (const t of tracksRef.current) {
      const want = pickPeaksN(t.dur, pxPerSec);
      if (t.peakN !== want) void loadPeaks(t, want);
    }
  }, [pxPerSec, loadPeaks]);

  useEffect(() => {
    const specs: TrackSpec[] = tracks.map((t) => ({
      id: t.id,
      url: t.url,
      offset: t.offset,
      dur: t.dur,
      gain: t.gain,
      mute: t.mute,
      solo: t.solo,
    }));
    player.sync(specs);
  }, [tracks]);

  const selected = useMemo(() => tracks.find((t) => t.id === selectedId) ?? null, [tracks, selectedId]);
  selectedPathRef.current = selected?.path ?? '';
  const selRef = useRef<Track | null>(null);
  selRef.current = selected;

  const seek = useCallback((t: number) => player.seek(t), []);
  const togglePlay = useCallback(() => player.toggle(), []);

  const step = useCallback((dir: -1 | 1) => {
    const starts = tracksRef.current.map((t) => t.offset).sort((a, b) => a - b);
    const now = player.getSnap();
    const next =
      dir > 0 ? starts.find((s) => s > now.t + 0.05) : [...starts].reverse().find((s) => s < now.t - 0.05);
    player.seek(Math.max(0, next ?? (dir > 0 ? now.duration : 0)));
  }, []);

  const setZoom = useCallback((z: number) => setZoomState(Math.min(8, Math.max(0.25, z))), []);

  const removeTrack = useCallback((id: string) => {
    setTracks((old) => {
      const next = old.filter((t) => t.id !== id);
      setSelectedId((cur) => (cur === id ? next[0]?.id ?? '' : cur));
      return next;
    });
  }, []);

  // ------------------------------------------------------------- analysis
  const loadAnalysis = useCallback(async (path: string) => {
    const hit = cache.current.get(path);
    if (hit) {
      if (selectedPathRef.current === path) setAnalysis({ ...hit, busy: false });
      return;
    }
    if (selectedPathRef.current === path) setAnalysis({ score: null, levels: [], sections: [], busy: true });
    const [sc, lv, se] = await Promise.allSettled([
      rpc<ScoreRes>('score', { path }),
      rpc<V>('levels', { path }),
      rpc<V>('sections', { path }),
    ]);
    const val = {
      score: sc.status === 'fulfilled' ? sc.value : null,
      levels: lv.status === 'fulfilled' ? asLevels((lv.value as V).ch) : [],
      sections: se.status === 'fulfilled' ? asSections((se.value as V).secs) : [],
    };
    cache.current.set(path, val);
    if (selectedPathRef.current === path) setAnalysis({ ...val, busy: false });
  }, []);

  useEffect(() => {
    const p = selected?.path;
    if (p) void loadAnalysis(p);
    else setAnalysis({ score: null, levels: [], sections: [], busy: false });
  }, [loadAnalysis, selected?.path]);

  // ------------------------------------------------------------- session restore
  const restoreSession = useCallback(
    async (s: V) => {
      const list = Array.isArray(s.tracks) ? (s.tracks as V[]) : [];
      let gone = 0;
      for (const t of list) {
        const path = asStr(t.path);
        if (!path) continue;
        let pr: ProbeRes;
        try {
          pr = await rpc<ProbeRes>('probe', { path });
        } catch {
          gone += 1;
          continue;
        }
        const nt = addTrack(path, asStr(t.name) || baseName(path), num(pr.dur), num(pr.sr), num(pr.ch), num(t.offset));
        const gain = typeof t.gain === 'number' ? t.gain : 1;
        if (gain !== 1 || t.mute === true || t.solo === true) {
          patchTrack(nt.id, { gain, mute: t.mute === true, solo: t.solo === true });
        }
      }
      const target = typeof s.target === 'number' && s.target > 0 ? s.target : 0;
      if (target > 0) setTargetDur(target);
      if (gone) say('info', `${gone} 个素材已不在原位置`);
    },
    [addTrack, patchTrack, say],
  );

  const didRestore = useRef(false);
  useEffect(() => {
    if (!booted || didRestore.current) return;
    didRestore.current = true;
    if (bootSession) void restoreSession(bootSession);
  }, [booted, bootSession, restoreSession]);

  const invalidate = useCallback((path: string) => cache.current.delete(path), []);

  // ------------------------------------------------------------- task shell
  const runSimple = useCallback(async (fn: () => Promise<V>): Promise<V | null> => {
    try {
      return await fn();
    } catch (e) {
      const { msg, hint } = describeError(e);
      say('err', hint ? `${msg} · ${hint}` : msg);
      return null;
    }
  }, [say]);

  const runTask = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      setBusy(label);
      inflight.current += 1;
      startJobs();
      try {
        return await fn();
      } catch (e) {
        const { msg, hint } = describeError(e);
        say('err', hint ? `${msg} · ${hint}` : msg);
        return null;
      } finally {
        inflight.current -= 1;
        setBusy('');
        void refreshCalls();
        window.setTimeout(() => {
          if (inflight.current <= 0 && !jobsRef.current.some((j) => j.state === 'running')) jobPoller().stop();
        }, 500);
      }
    },
    [refreshCalls, say, startJobs],
  );

  const cancelJob = useCallback(
    async (id: string) => {
      try {
        await rpc('cancel', { id });
        startJobs();
      } catch (e) {
        say('err', describeError(e).msg);
      }
    },
    [say, startJobs],
  );

  // ------------------------------------------------------------- intake
  const setSubsFromText = useCallback(
    (text: string, label: string) => {
      const segs = parseSubtitles(text);
      if (!segs.length) {
        say('err', '文稿未解析');
        return;
      }
      setTranscript(segs);
      setTranscriptSrc(label);
      say('ok', `文稿 ${segs.length} 行`);
    },
    [say],
  );

  const loadSubByPath = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(fileUrl(path));
        setSubsFromText(await res.text(), baseName(path));
      } catch {
        say('err', '文稿读取失败');
      }
    },
    [say, setSubsFromText],
  );

  const addOne = useCallback(
    async (path: string) => {
      const ext = extOf(path);
      if (ext === 'srt' || ext === 'vtt') {
        await loadSubByPath(path);
        return;
      }
      let pr: ProbeRes;
      try {
        pr = await rpc<ProbeRes>('probe', { path });
      } catch (e) {
        say('err', `${baseName(path)} · ${describeError(e).msg}`);
        return;
      }
      const vidDur = typeof pr.vid === 'number' && pr.vid > 0 ? pr.vid : 0;
      const noAudio = num(pr.ch) === 0;
      const isVideo = vidDur > 0 || VIDEO_EXT.includes(ext) || /mp4|mov|matroska|webm/i.test(asStr(pr.fmt));
      if (isVideo || noAudio) {
        const r = await runTask('提取', () => rpc<V>('extract', { in: path, silence: noAudio ? true : undefined }));
        if (!r) return;
        const out = asStr(r.out, path);
        const dur = num(r.dur, num(pr.dur));
        addTrack(out, baseName(path), dur, num(r.sr, num(pr.sr)), num(r.ch, num(pr.ch)));
        void loadAnalysis(out);
        const goal = vidDur > 0 ? vidDur : noAudio ? 0 : num(pr.dur);
        if (goal > 0) {
          setTargetDur(goal);
          say('ok', `已提取 · 适配目标 ${fmtTime(goal)}`);
        } else {
          say('ok', `已提取 ${baseName(path)}`);
        }
        return;
      }
      addTrack(path, baseName(path), num(pr.dur), num(pr.sr), num(pr.ch));
      say('ok', `已导入 ${baseName(path)}`);
    },
    [addTrack, loadAnalysis, loadSubByPath, runTask, say],
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
      for (const p of paths) if (p) await addOne(p);
    },
    [addOne],
  );

  const pickFiles = useCallback(async () => {
    if (isTauri) {
      try {
        const r = await rpc<V>('pick');
        const p = asStr(r.path);
        if (p) {
          await addPaths([p]);
          return;
        }
      } catch {
        /* dialog plugin next */
      }
      try {
        const mod = await import('@tauri-apps/plugin-dialog');
        const picked = await mod.open({
          multiple: true,
          filters: [
            { name: '媒体', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'mov', 'webm', 'srt', 'vtt'] },
          ],
        });
        if (typeof picked === 'string') await addPaths([picked]);
        else if (Array.isArray(picked)) await addPaths(picked.map(String));
      } catch {
        /* no dialog available */
      }
      return;
    }
    document.getElementById('aa-file-input')?.click();
  }, [addPaths]);

  const importSubs = useCallback(() => {
    document.getElementById('aa-sub-input')?.click();
  }, []);

  const transcribe = useCallback(async () => {
    const src = selRef.current ?? tracksRef.current[0];
    if (!src) {
      say('err', '未选择轨道');
      return;
    }
    const r = await runTask('转写', () => rpc<V>('transcribe', { path: src.path }));
    if (!r) {
      setTranscript([]);
      return;
    }
    const segs = asSegs(r.segs);
    if (r.ok === true && segs.length) {
      setTranscript(segs);
      setTranscriptSrc(asStr(r.engine, '转写'));
      say('ok', `转写 ${segs.length} 行`);
    } else {
      setTranscript([]);
      setTranscriptSrc(asStr(r.why));
    }
  }, [runTask, say]);

  // ------------------------------------------------------------- actions
  const fit = useCallback(async () => {
    const t = selected;
    if (!t) {
      say('err', '未选择轨道');
      return;
    }
    if (!targetDur || targetDur <= 0) {
      say('info', '需要适配目标时长');
      return;
    }
    const r = await runTask('适配', () => rpc<V>('fit', { in: t.path, dur: targetDur, mode: 'auto' }));
    if (!r) return;
    const out = asStr(r.out, t.path);
    invalidate(t.path);
    invalidate(out);
    replaceTrack(t.id, out, num(r.dur, t.dur), t.sr, t.ch);
    void loadAnalysis(out);
    say('ok', `适配 ${fmtTime(num(r.dur))} · 误差 ${num(r.err).toFixed(2)}s · ${asStr(r.mode)}`);
  }, [invalidate, loadAnalysis, replaceTrack, say, selected, targetDur]);

  const separate = useCallback(
    async (mode: string) => {
      const t = selected;
      if (!t) {
        say('err', '未选择轨道');
        return;
      }
      const r = await runTask('分离', () => rpc<V>('separate', { in: t.path, mode }));
      if (!r) return;
      const vocal = asStr(r.vocal);
      const inst = asStr(r.instrumental);
      if (!vocal && !inst) {
        say('err', asStr(r.note, '无分离输出'));
        return;
      }
      if (vocal) addTrack(vocal, `${t.name} 人声`, t.dur, t.sr, t.ch);
      if (inst) addTrack(inst, `${t.name} 伴奏`, t.dur, t.sr, t.ch);
      say('ok', `分离 ${asStr(r.engine)}`);
    },
    [addTrack, say, selected],
  );

  const extractAudio = useCallback(async () => {
    const t = selected;
    if (!t) {
      say('err', '未选择轨道');
      return;
    }
    const r = await runTask('提取', () => rpc<V>('extract', { in: t.path, silence: true }));
    if (!r) return;
    const out = asStr(r.out);
    if (!out) return;
    addTrack(out, `${t.name} 音轨`, num(r.dur, t.dur), num(r.sr, t.sr), num(r.ch, t.ch));
    say('ok', `已提取 ${baseName(out)}`);
  }, [addTrack, say, selected]);

  const cut = useCallback(
    async (a: number, b: number) => {
      const t = selected;
      if (!t) return;
      if (!(b > a)) {
        say('err', '区间无效');
        return;
      }
      const r = await runTask('裁剪', () => rpc<V>('cut', { in: t.path, start: a, end: b }));
      if (!r) return;
      const out = asStr(r.out, t.path);
      invalidate(t.path);
      invalidate(out);
      replaceTrack(t.id, out, num(r.dur, b - a), t.sr, t.ch);
      void loadAnalysis(out);
      say('ok', `裁剪 ${fmtTime(a)}–${fmtTime(b)}`);
    },
    [invalidate, loadAnalysis, replaceTrack, say, selected],
  );

  const stripSilence = useCallback(async () => {
    const t = selected;
    if (!t) return;
    const r = await runTask('静音', () => rpc<V>('silence', { in: t.path }));
    if (!r) return;
    const out = asStr(r.out, t.path);
    invalidate(t.path);
    invalidate(out);
    replaceTrack(t.id, out, num(r.dur, t.dur), t.sr, t.ch);
    void loadAnalysis(out);
    say('ok', `移除 ${fmtTime(num(r.removed))}`);
  }, [invalidate, loadAnalysis, replaceTrack, say, selected]);

  const split = useCallback(
    async (by: string) => {
      const t = selected;
      if (!t) return;
      const r = await runTask('分段', () => rpc<V>('split', { in: t.path, by }));
      if (!r) return;
      const files = Array.isArray(r.files) ? (r.files as V[]) : [];
      for (const f of files) {
        const p = asStr(f.path);
        if (p) addTrack(p, `${t.name} ${num(f.i, 1)}`, num(f.dur), t.sr, t.ch, num(f.t0));
      }
      say('ok', `分段 ${num(r.n, files.length)} 段`);
    },
    [addTrack, say, selected],
  );

  const mixAll = useCallback(async () => {
    const list = tracksRef.current.filter((t) => !t.mute);
    if (!list.length) {
      say('err', '无轨道');
      return;
    }
    const r = await runTask('混音', () =>
      rpc<V>('mix', {
        tracks: list.map((t) => ({ in: t.path, start: t.offset, gain: t.gain })),
        mode: 'sum',
        target: prefs.target,
        norm: prefs.normalize,
      }),
    );
    if (!r) return;
    const out = asStr(r.out);
    if (!out) return;
    addTrack(out, '混音', num(r.dur), prefs.sr, prefs.ch);
    say('ok', `混音 ${num(r.tracks, list.length)} 轨`);
  }, [addTrack, prefs.ch, prefs.normalize, prefs.sr, prefs.target, say]);

  const loudnorm = useCallback(async () => {
    const t = selected;
    if (!t) {
      say('err', '未选择轨道');
      return;
    }
    const chain = [{ k: 'loudnorm', v: prefs.target }];
    const r = await runTask('归一', () => rpc<V>('fx', { in: t.path, chain }));
    if (!r) return;
    const out = asStr(r.out, t.path);
    invalidate(t.path);
    invalidate(out);
    replaceTrack(t.id, out, num(r.dur, t.dur), t.sr, t.ch);
    void loadAnalysis(out);
    say('ok', `归一 ${prefs.target} LUFS · ${num(r.applied, chain.length)} 级`);
  }, [invalidate, loadAnalysis, prefs.target, replaceTrack, say, selected]);

  const render = useCallback(async () => {
    const t = selected;
    if (!t) {
      say('err', '未选择轨道');
      return;
    }
    const chain = prefs.normalize ? [{ k: 'loudnorm', v: prefs.target }] : undefined;
    const out = outPath(prefs.outDir, baseName(t.path), prefs.fmt);
    const r = await runTask('导出', () =>
      rpc<V>('render', {
        in: t.path,
        ...(out ? { out } : {}),
        fmt: prefs.fmt,
        sr: prefs.sr,
        ch: prefs.ch,
        ...(chain ? { chain } : {}),
      }),
    );
    if (!r) return;
    const made = asStr(r.out);
    setLastOut(made);
    say('ok', `导出 ${baseName(made) || '完成'} · ${asStr(r.fmt, prefs.fmt)}`);
  }, [prefs.ch, prefs.fmt, prefs.normalize, prefs.outDir, prefs.sr, prefs.target, say, selected]);

  const reveal = useCallback(async (path: string) => {
    if (!path) return;
    try {
      await rpc('reveal', { path });
    } catch {
      /* reveal is best effort */
    }
  }, []);

  const samples = useCallback(async () => {
    const r = await runTask('示例', () => rpc<V>('demo'));
    if (!r) return;
    const files = Array.isArray(r.files) ? (r.files as V[]) : [];
    for (const f of files) {
      const p = asStr(f.path);
      if (p) await addOne(p);
    }
    if (asStr(r.note)) say('info', asStr(r.note));
  }, [addOne, say]);

  const saveProject = useCallback(async () => {
    const r = await runSimple(() =>
      rpc<V>('project', { save: true, name: projectName, data: projectData() }),
    );
    if (r) say('ok', `已保存 ${asStr(r.name, projectName)}`);
  }, [projectData, projectName, runSimple, say]);

  // ------------------------------------------------------------- derived
  // Only a job this window started may own the export ring: engine history from an
  // earlier run would otherwise read as "100% 完成" with nothing to show for it.
  const bootTs = useRef(Date.now());
  const job = useMemo(() => {
    const running = jobs.filter((j) => j.state === 'running');
    const mine = jobs.find((j) => j.created >= bootTs.current - 2000);
    return running[running.length - 1] ?? mine ?? null;
  }, [jobs]);

  // exact lifetime count from the engine; the fetched window is only a sample,
  // so the headline number uses this.
  const callsTotal = logTotal;

  const clearNote = useCallback(() => setNote(null), []);

  const value: Ctx = {
    view,
    setView,
    doctor,
    caps,
    offline,
    reconnect: probeBackend,
    tracks,
    selectedId,
    selected,
    select: setSelectedId,
    patchTrack,
    removeTrack,
    addPaths,
    pickFiles,
    setSubsFromText,
    targetDur,
    setTargetDur,
    zoom,
    setZoom,
    pxPerSec,
    analysis,
    transcript,
    transcriptSrc,
    transcribe,
    importSubs,
    jobs,
    job,
    lastOut,
    cancelJob,
    calls,
    callsTotal,
    refreshCalls,
    prefs,
    setPrefs,
    projectName,
    setProjectName,
    note,
    clearNote,
    notify: say,
    saveProject,
    busy,
    actions: { fit, separate, extractAudio, cut, stripSilence, split, mixAll, loudnorm, render, reveal, samples },
    togglePlay,
    seek,
    step,
  };

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
