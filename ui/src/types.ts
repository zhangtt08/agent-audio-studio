// Typed views of the RPC payloads. Keys are terse on the wire; we widen them here.
import type { V } from './api';

export interface ProbeRes {
  p: string;
  dur: number;
  sr: number;
  ch: number;
  codec: string;
  fmt: string;
  size: number;
  vid: unknown;
}

export interface PeaksRes {
  dur: number;
  sr: number;
  n: number;
  enc: string;
  d: string;
}

export interface ScoreRes {
  score: number;
  clarity: number;
  balance: number;
  dynamics: number;
  noise: number;
  lufs: number;
  peak: number;
  rms: number;
  dur: number;
  sr: number;
  ch: number;
}

export interface LevelChan {
  name: string;
  peak: number;
  rms: number;
}

export interface LevelsRes {
  ch: LevelChan[];
}

export type SectionKind = 'speech' | 'music' | 'hit' | 'silence' | 'part';

export interface Section {
  t0: number;
  t1: number;
  kind: SectionKind;
  energy: number;
}

export interface SectionsRes {
  dur: number;
  secs: Section[];
}

export interface Seg {
  t0: number;
  t1: number;
  txt: string;
}

export interface TranscribeRes {
  ok: boolean;
  engine?: string;
  segs?: Seg[];
  why?: string;
}

export interface OutRes {
  out: string;
  dur: number;
  sr?: number;
  ch?: number;
  codec?: string;
  vid?: unknown;
}

export interface FitRes {
  out: string;
  dur: number;
  target: number;
  mode: string;
  tempo: number;
  err: number;
  note?: string;
}

export interface SilenceRes {
  out: string;
  dur: number;
  removed: number;
}

export interface SeparateRes {
  vocal: string;
  instrumental: string;
  engine: string;
  note?: string;
}

export interface SplitFile {
  i: number;
  t0: number;
  t1: number;
  dur: number;
  path: string;
}

export interface SplitRes {
  dir: string;
  n: number;
  files: SplitFile[];
}

export interface MixRes {
  out: string;
  dur: number;
  tracks: number;
}

export interface FxRes {
  out: string;
  dur: number;
  applied: number;
}

export interface RenderRes {
  out: string;
  dur: number;
  sr: number;
  ch: number;
  fmt: string;
  size: number;
}

export type JobState = 'running' | 'done' | 'error' | 'cancelled';

export interface Job {
  id: string;
  op: string;
  pct: number;
  stage: string;
  state: JobState;
  ms: number;
  out: string;
  created: number;
}

export interface JobsRes {
  jobs: Job[];
}

export interface Call {
  /** human-readable stamp from the engine (UTC, display only) */
  t: string;
  /** epoch milliseconds, used for all time math */
  ts: number;
  op: string;
  ms: number;
  ok: boolean;
  inp: string;
  out: string;
  e?: string;
}

export interface LogRes {
  calls: Call[];
}

export interface CapsRes {
  v: string;
  tools: { n: string; d: string }[];
  ops: { k: string; d: string }[];
  presets: { n: string; d: string }[];
  http: { port: number; up: boolean };
  mcp: { cmd: string; args: string[] };
  dir: string;
}

export interface DoctorRes {
  ok: boolean;
  ffmpeg: string;
  ver: string;
  jobs: number;
  home: string;
  out: string;
  db?: string;
}

export interface ProjectRes {
  name: string;
  path?: string;
  ok?: boolean;
  projects?: string[];
  data?: unknown;
}

export interface DemoFile {
  path: string;
  dur: number;
}

export interface DemoRes {
  files: DemoFile[];
  note?: string;
}

export const asNum = (v: unknown, fb = 0): number => (typeof v === 'number' && isFinite(v) ? v : fb);
export const asStr = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : fb);
export const asBool = (v: unknown, fb = false): boolean => (typeof v === 'boolean' ? v : fb);

export function asSegs(v: unknown): Seg[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = (x ?? {}) as V;
      return { t0: asNum(o.t0), t1: asNum(o.t1), txt: asStr(o.txt) };
    })
    .filter((s) => s.txt.length > 0);
}

export function asSections(v: unknown): Section[] {
  if (!Array.isArray(v)) return [];
  const kinds: SectionKind[] = ['speech', 'music', 'hit', 'silence', 'part'];
  return v.map((x) => {
    const o = (x ?? {}) as V;
    const kind = asStr(o.kind) as SectionKind;
    return {
      t0: asNum(o.t0),
      t1: asNum(o.t1),
      kind: kinds.includes(kind) ? kind : 'part',
      energy: asNum(o.energy),
    };
  });
}

export function asLevels(v: unknown): LevelChan[] {
  if (!Array.isArray(v)) return [];
  return v.map((x, i) => {
    const o = (x ?? {}) as V;
    return { name: asStr(o.name) || `CH${i + 1}`, peak: asNum(o.peak), rms: asNum(o.rms) };
  });
}

export function asJobs(v: unknown): Job[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = (x ?? {}) as V;
    const state = asStr(o.state) as JobState;
    return {
      id: asStr(o.id, String(asNum(o.id))),
      op: asStr(o.op),
      pct: asNum(o.pct),
      stage: asStr(o.stage),
      state: ['running', 'done', 'error', 'cancelled'].includes(state) ? state : 'done',
      ms: asNum(o.ms),
      out: asStr(o.out),
      created: asNum(o.created),
    };
  });
}

export function asCalls(v: unknown): Call[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = (x ?? {}) as V;
    return {
      t: asStr(o.t),
      ts: asNum(o.ts),
      op: asStr(o.op),
      ms: asNum(o.ms),
      ok: asBool(o.ok, true),
      inp: asStr(o.in),
      out: asStr(o.out),
      e: typeof o.e === 'string' ? o.e : undefined,
    };
  });
}

export function asPairs(v: unknown): { n: string; d: string }[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = (x ?? {}) as V;
    return { n: asStr(o.n) || asStr(o.k), d: asStr(o.d) };
  });
}

export function asOps(v: unknown): { k: string; d: string }[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = (x ?? {}) as V;
    return { k: asStr(o.k) || asStr(o.n), d: asStr(o.d) };
  });
}
