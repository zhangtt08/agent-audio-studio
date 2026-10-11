import { fmtTime } from '../api';

const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

/** Tick spacing in seconds that keeps labels at least `minPx` apart. */
export function tickStep(pxPerSec: number, minPx = 72): number {
  for (const s of STEPS) if (s * pxPerSec >= minPx) return s;
  return STEPS[STEPS.length - 1];
}

export function ticks(dur: number, pxPerSec: number): { t: number; x: number; label: string }[] {
  const step = tickStep(pxPerSec);
  const out: { t: number; x: number; label: string }[] = [];
  const last = Math.max(dur, step);
  for (let t = 0; t <= last + 1e-6; t += step) {
    out.push({ t, x: t * pxPerSec, label: fmtTime(t) });
    if (t > 4000) break;
  }
  return out;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;

export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)}%`;
}
