// Level / metric unit helpers. The wire does not always state which unit a number is in,
// so each helper infers it and degrades to a muted "no data" line.
export const NOISE_FLOOR = -60;

/** Linear magnitude or dBFS in, dBFS out. A zero reading is silence, not full scale. */
export function toDb(v: number): number {
  if (!isFinite(v)) return NOISE_FLOOR;
  if (v === 0) return NOISE_FLOOR;
  if (v < 0) return Math.max(v, NOISE_FLOOR);
  return Math.max(20 * Math.log10(v), NOISE_FLOOR);
}

export function dbToPct(db: number): number {
  const d = Math.min(0, Math.max(NOISE_FLOOR, db));
  return ((d - NOISE_FLOOR) / -NOISE_FLOOR) * 100;
}

/** 0..1, 0..100 or a dB value -> a 0..100 meter. */
export function toPct(v: number): number {
  if (!isFinite(v)) return 0;
  if (v < 0) return clampPct(((v + 90) / 90) * 100);
  if (v <= 1) return clampPct(v * 100);
  return clampPct(v);
}

export const clampPct = (v: number): number => Math.min(100, Math.max(0, v));

export function fmtClock(ms: number): string {
  const d = new Date(ms < 1e11 ? ms * 1000 : ms);
  if (isNaN(d.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
