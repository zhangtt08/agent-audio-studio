import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtTime } from '../api';
import { useSnap } from '../audio/usePlayer';
import { ticks, zoomLabel } from '../lib/time';
import { useApp } from '../state/app';
import { Btn, Card } from './ui';
import { CHIP_W, TrackRow } from './TrackRow';
import { DropZone } from './DropZone';

const SPLITS = [
  ['silence', '静音'],
  ['parts', '段落'],
  ['n', '等分'],
];

const SEP_MODES = [
  ['center', '中置'],
  ['karaoke', '消人声'],
  ['ai', 'AI'],
];

export function Editor({ full = false }: { full?: boolean }) {
  const {
    tracks,
    selected,
    pxPerSec,
    zoom,
    setZoom,
    seek,
    togglePlay,
    step,
    targetDur,
    setTargetDur,
    patchTrack,
    removeTrack,
    actions,
    busy,
  } = useApp();
  const { t, playing, duration } = useSnap();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const [splitBy, setSplitBy] = useState('silence');
  const [sepMode, setSepMode] = useState('center');

  const laneW = Math.max(360, (duration || 0) * pxPerSec);
  const marks = useMemo(() => ticks(duration, pxPerSec), [duration, pxPerSec]);

  useEffect(() => {
    if (!playing) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = CHIP_W + t * pxPerSec;
    if (x > el.scrollLeft + el.clientWidth - 48 || x < el.scrollLeft + CHIP_W + 8) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.55);
    }
  }, [playing, t, pxPerSec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && /input|select|textarea/i.test(el.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  return (
    <Card
      title="多轨编辑"
      fill={full}
      className={full ? 'editor editor-full' : 'editor'}
      right={
        selected ? (
          <span className="meta">
            {selected.sr ? `${selected.sr / 1000}k` : ''} {selected.ch === 1 ? '单声道' : selected.ch > 2 ? `${selected.ch}ch` : selected.ch === 2 ? '立体声' : ''}
          </span>
        ) : undefined
      }
    >
      <div className="transport">
        <div className="tp-btns">
          <Btn size="icon" icon="prev" onClick={() => step(-1)} title="上一段" />
          <Btn size="icon" tone="primary" icon={playing ? 'pause' : 'play'} onClick={togglePlay} title="播放" />
          <Btn size="icon" icon="next" onClick={() => step(1)} title="下一段" />
        </div>
        <div className="tp-time">
          <b>{fmtTime(t)}</b>
          <i>/</i>
          <span>{fmtTime(duration)}</span>
        </div>
        <div className="tp-zoom">
          <button type="button" onClick={() => setZoom(zoom / 1.5)}>
            −
          </button>
          <span>{zoomLabel(zoom)}</span>
          <button type="button" onClick={() => setZoom(zoom * 1.5)}>
            +
          </button>
        </div>
        <label className="tp-target">
          <span>目标</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={targetDur && targetDur > 0 ? Number(targetDur.toFixed(2)) : ''}
            placeholder="—"
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              setTargetDur(v > 0 ? v : null);
            }}
          />
          <i>s</i>
          {targetDur ? (
            <button type="button" className="tp-clear" onClick={() => setTargetDur(null)}>
              ×
            </button>
          ) : null}
        </label>
      </div>

      {tracks.length === 0 ? (
        <DropZone />
      ) : (
        <>
          <div className="tl" ref={scrollRef}>
            <div className="tl-in" style={{ width: CHIP_W + laneW }}>
              <div className="tl-row tl-ruler">
                <div className="tl-chip" />
                <div
                  className="tl-lane ruler-lane"
                  style={{ width: laneW }}
                  onPointerDown={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    seek(Math.max(0, (e.clientX - r.left) / pxPerSec));
                  }}
                >
                  {marks.map((m) => (
                    <span className="tick" key={m.t} style={{ left: m.x }}>
                      <em />
                      {m.label}
                    </span>
                  ))}
                </div>
              </div>
              {tracks.map((tr) => (
                <TrackRow key={tr.id} track={tr} laneW={laneW} />
              ))}
              <div className="ph" style={{ left: CHIP_W + t * pxPerSec }} />
            </div>
          </div>

          <div className="ops">
            <button type="button" className="mk" onClick={() => setA(t)}>
              A {fmtTime(a)}
            </button>
            <button type="button" className="mk" onClick={() => setB(t)}>
              B {fmtTime(b)}
            </button>
            <Btn size="sm" onClick={() => void actions.cut(a, b)} disabled={!selected}>
              裁剪
            </Btn>
            <Btn size="sm" onClick={() => void actions.stripSilence()} disabled={!selected}>
              去静音
            </Btn>
            <select className="sel" value={splitBy} onChange={(e) => setSplitBy(e.currentTarget.value)}>
              {SPLITS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <Btn size="sm" onClick={() => void actions.split(splitBy)} disabled={!selected}>
              分段
            </Btn>
            <Btn size="sm" onClick={() => void actions.mixAll()} disabled={tracks.length < 2}>
              混音
            </Btn>
            <Btn size="sm" onClick={() => void actions.loudnorm()} disabled={!selected}>
              归一
            </Btn>
            <select className="sel" value={sepMode} onChange={(e) => setSepMode(e.currentTarget.value)}>
              {SEP_MODES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <Btn size="sm" onClick={() => void actions.separate(sepMode)} disabled={!selected}>
              分离
            </Btn>
            <span className="ops-x" />
            {selected ? (
              <label className="ofs">
                <span>起点</span>
                <input
                  type="number"
                  min={0}
                  step={0.05}
                  value={Number(selected.offset.toFixed(2))}
                  onChange={(e) => {
                    const v = Number(e.currentTarget.value);
                    patchTrack(selected.id, { offset: Math.max(0, isFinite(v) ? v : 0) });
                  }}
                />
                <i>s</i>
              </label>
            ) : null}
            <Btn size="sm" icon="trash" onClick={() => selected && removeTrack(selected.id)} disabled={!selected}>
              移除轨道
            </Btn>
            {busy && <span className="ops-busy">{busy}</span>}
          </div>
        </>
      )}
    </Card>
  );
}
