import { useEffect, useRef, useState } from 'react';
import { useSnap } from '../audio/usePlayer';
import { drawBars, sizeCanvas } from '../lib/canvas';
import { useApp } from '../state/app';

const ACCENT = '#EF4B3D';

/** Brand motif for the empty state: a fixed silhouette, not a measurement. */
function idleEnv(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = n > 1 ? i / (n - 1) : 0;
    out[i] = 0.25 + 0.6 * Math.abs(Math.sin(x * Math.PI * 3.1)) * Math.abs(Math.cos(x * Math.PI * 1.6));
  }
  return out;
}

export function HeroCanvas() {
  const { selected, busy, job } = useApp();
  const { t, playing } = useSnap();
  const box = useRef<HTMLDivElement | null>(null);
  const cv = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  const running = playing || !!busy || job?.state === 'running';
  const env = selected?.peaks ? selected.peaks.rms : null;

  useEffect(() => {
    const c = cv.current;
    if (!c || size.w < 8 || size.h < 8) return;
    const ctx = sizeCanvas(c, size.w, size.h);
    if (!ctx) return;
    const bars = Math.max(16, Math.min(56, Math.floor(size.w / 9)));
    drawBars(ctx, size.w, size.h, env ?? idleEnv(bars), t, running, ACCENT);
  }, [env, size, t, running]);

  return (
    <div className="hero">
      <div className="hero-in" ref={box}>
        <canvas ref={cv} className={env ? 'hero-live' : 'hero-idle'} />
        {!env && <span className="hero-tag">等待媒体</span>}
      </div>
    </div>
  );
}
