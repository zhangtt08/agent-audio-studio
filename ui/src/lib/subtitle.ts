import type { Seg } from '../types';

function toSec(s: string): number {
  const m = /(\d+):(\d\d):(\d\d)[.,](\d\d\d)/.exec(s.trim()) || /(\d+):(\d\d)[.,](\d\d\d)/.exec(s.trim());
  if (!m) return NaN;
  if (m.length === 5) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
}

/** Parser for both .srt and .vtt. Pure text in, real segments out. */
export function parseSubtitles(text: string): Seg[] {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const clean = noBom.replace(/\r\n?/g, '\n');
  const isVtt = /^WEBVTT/m.test(clean);
  const body = isVtt
    ? clean.replace(/^WEBVTT[^\n]*\n/, '').replace(/^(NOTE|STYLE|REGION)[\s\S]*?\n\n/gm, '')
    : clean;
  const blocks = body.split(/\n\n+/);
  const segs: Seg[] = [];
  for (const raw of blocks) {
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (!lines.length) continue;
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const t0 = toSec(a ?? '');
    const t1 = toSec(b ?? '');
    if (!isFinite(t0) || !isFinite(t1)) continue;
    const txt = lines
      .slice(idx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!txt) continue;
    segs.push({ t0, t1, txt });
  }
  return segs.sort((x, y) => x.t0 - y.t0);
}
