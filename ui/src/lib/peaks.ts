// peaks RPC: base64 of a little-endian Float32Array with n*3 floats ordered [min..][max..][rms..].
import type { PeaksRes } from '../types';

export interface Peaks {
  n: number;
  dur: number;
  sr: number;
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}

export function decodePeaks(b64: string, n: number): Peaks | null {
  if (typeof b64 !== 'string' || b64.length === 0 || n <= 0) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const floats = new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
  if (floats.length < n * 3) return null;
  return {
    n,
    dur: 0,
    sr: 0,
    min: floats.subarray(0, n),
    max: floats.subarray(n, n * 2),
    rms: floats.subarray(n * 2, n * 3),
  };
}

export function peaksFromRes(r: PeaksRes, fallbackDur: number): Peaks | null {
  const n = Math.max(1, Math.floor(r.n || 0));
  const p = decodePeaks(r.d, n);
  if (!p) return null;
  p.dur = r.dur > 0 ? r.dur : fallbackDur;
  p.sr = r.sr || 0;
  return p;
}

/** Coarse steps keep the request count low while zooming. */
const N_STEPS = [500, 1000, 2000, 4000];

export function pickPeaksN(dur: number, pxPerSec: number): number {
  const want = Math.round(Math.max(200, dur * pxPerSec * 1.5));
  for (const s of N_STEPS) if (want <= s) return s;
  return 4000;
}
