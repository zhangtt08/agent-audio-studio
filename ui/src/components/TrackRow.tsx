import { useRef } from 'react';
import { fmtTime } from '../api';
import { useSnap } from '../audio/usePlayer';
import { useApp, type Track } from '../state/app';
import { TrackWave } from './TrackWave';

export const CHIP_W = 216;

export function TrackRow({ track, laneW }: { track: Track; laneW: number }) {
  const { pxPerSec, selectedId, select, patchTrack } = useApp();
  const { t } = useSnap();
  const drag = useRef<{ x: number; off: number } | null>(null);
  const moved = useRef(false);
  const isSel = selectedId === track.id;
  const clipW = Math.max(8, track.dur * pxPerSec);

  return (
    <div className={`tl-row${isSel ? ' is-sel' : ''}`} onPointerDown={() => select(track.id)}>
      <div className="tl-chip">
        <div className="chip-top">
          <span className="sw" style={{ background: track.color }} />
          <span className="nm" title={track.path}>
            {track.name}
          </span>
          <span className="du">{fmtTime(track.dur)}</span>
        </div>
        <div className="chip-ctl" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`ms${track.mute ? ' is-on' : ''}`}
            onClick={() => patchTrack(track.id, { mute: !track.mute })}
          >
            M
          </button>
          <button
            type="button"
            className={`ms${track.solo ? ' is-on' : ''}`}
            onClick={() => patchTrack(track.id, { solo: !track.solo })}
          >
            S
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={track.gain}
            aria-label="增益"
            onChange={(e) => patchTrack(track.id, { gain: Number(e.currentTarget.value) })}
          />
        </div>
      </div>
      <div className="tl-lane" style={{ width: laneW }}>
        <div
          className={`clip${isSel ? ' is-sel' : ''}`}
          style={{
            left: track.offset * pxPerSec,
            width: clipW,
            borderColor: isSel ? track.color : 'transparent',
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            select(track.id);
            drag.current = { x: e.clientX, off: track.offset };
            moved.current = false;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            if (Math.abs(dx) > 2) moved.current = true;
            if (moved.current) patchTrack(track.id, { offset: Math.max(0, d.off + dx / pxPerSec) });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          {track.peaks ? (
            <TrackWave
              peaks={track.peaks}
              dur={track.dur || track.peaks.dur}
              color={track.color}
              pxPerSec={pxPerSec}
              played={t - track.offset}
              w={clipW}
            />
          ) : (
            <span className="clip-x">{track.peaksBusy ? '读取中' : '暂无波形'}</span>
          )}
        </div>
      </div>
    </div>
  );
}
