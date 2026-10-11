import { useEffect, useRef } from 'react';
import { drawWave, sizeCanvas } from '../lib/canvas';
import type { Peaks } from '../lib/peaks';

export function TrackWave({
  peaks,
  dur,
  color,
  pxPerSec,
  played,
  h = 52,
  w,
}: {
  peaks: Peaks | null;
  dur: number;
  color: string;
  pxPerSec: number;
  played: number;
  h?: number;
  w: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || w <= 0) return;
    const ctx = sizeCanvas(cv, w, h);
    if (!ctx) return;
    drawWave(ctx, w, h, { peaks, dur, pxPerSec, color, played });
  }, [peaks, dur, color, pxPerSec, played, h, w]);

  return <canvas ref={ref} className="wave" style={{ display: 'block' }} />;
}
