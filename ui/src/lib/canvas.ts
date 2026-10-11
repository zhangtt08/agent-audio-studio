import type { Peaks } from './peaks';

/** Backing store sized for the device pixel ratio; CSS size stays in logical px. */
export function sizeCanvas(cv: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return ctx;
}

export function rgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return `rgba(239,75,61,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface WaveOpts {
  peaks: Peaks | null;
  dur: number;
  pxPerSec: number;
  color: string;
  /** Playhead position inside this clip, in seconds. */
  played: number;
}

/** min/max envelope + rms fill, dimmed past the playhead. */
export function drawWave(ctx: CanvasRenderingContext2D, w: number, h: number, o: WaveOpts): void {
  const mid = h / 2;
  ctx.fillStyle = rgba(o.color, 0.07);
  ctx.fillRect(0, mid - 0.5, w, 1);
  const { peaks, dur, pxPerSec } = o;
  if (!peaks || dur <= 0 || !peaks.n) return;
  const cutX = Math.max(0, Math.min(w, o.played * pxPerSec));
  paintSpan(ctx, 0, Math.floor(cutX), h, mid, o, 1);
  paintSpan(ctx, Math.floor(cutX), w, h, mid, o, 0.32);
}

function paintSpan(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  h: number,
  mid: number,
  o: WaveOpts,
  strength: number,
): void {
  if (x1 <= x0) return;
  const { peaks, dur, pxPerSec } = o;
  if (!peaks) return;
  const n = peaks.n;
  const envFill = rgba(o.color, 0.8 * strength);
  const rmsFill = rgba(o.color, 0.45 * strength);
  const scale = (h / 2) * 0.94;
  for (let x = x0; x < x1; x++) {
    const a = Math.max(0, Math.floor((x / pxPerSec / dur) * n));
    const b = Math.min(n, Math.ceil(((x + 1) / pxPerSec / dur) * n));
    if (b <= a) continue;
    let mn = 0;
    let mx = 0;
    let rg = 0;
    for (let i = a; i < b; i++) {
      const v1 = peaks.min[i] ?? 0;
      const v2 = peaks.max[i] ?? 0;
      if (v1 < mn) mn = v1;
      if (v2 > mx) mx = v2;
      const r = Math.abs(peaks.rms[i] ?? 0);
      if (r > rg) rg = r;
    }
    const yTop = mid - Math.min(1, mx) * scale;
    const yBot = mid - Math.max(-1, mn) * scale;
    ctx.fillStyle = envFill;
    ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    const rh = Math.max(1, Math.min(1, rg) * scale);
    ctx.fillStyle = rmsFill;
    ctx.fillRect(x, mid - rh / 2, 1, rh);
  }
}

/** Bar field for the hero panel. Motion only while `live`; static frames read real peaks. */
export function drawBars(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  env: Float32Array | null,
  phase: number,
  live: boolean,
  accent: string,
): void {
  const bars = Math.max(16, Math.min(56, Math.floor(w / 9)));
  const gap = 3;
  const bw = Math.max(2, (w - gap * (bars - 1)) / bars);
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, rgba(accent, 0.92));
  grad.addColorStop(1, 'rgba(255,255,255,0.95)');
  ctx.fillStyle = grad;
  for (let i = 0; i < bars; i++) {
    const src = env && env.length ? Math.abs(env[(i * env.length) / bars] ?? 0) : 0;
    const base = env && env.length ? Math.min(1, src) : 0;
    const wob = live ? 0.55 + 0.45 * Math.sin(phase * 2.4 + i * 0.44) : 1;
    const amp = Math.max(0.05, base * (live ? 0.5 + 0.7 * wob : 0.9) + (live ? 0.04 * wob : 0));
    const bh = Math.max(2, Math.min(1, amp) * (h - 10));
    ctx.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh);
  }
}
