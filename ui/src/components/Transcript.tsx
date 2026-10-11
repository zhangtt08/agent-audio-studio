import { useEffect, useMemo, useRef } from 'react';
import { fmtTime } from '../api';
import { useSnap } from '../audio/usePlayer';
import { useApp } from '../state/app';
import { Btn } from './ui';

export function Transcript() {
  const { transcript, transcriptSrc, importSubs, transcribe, seek, analysis } = useApp();
  const { t } = useSnap();
  const box = useRef<HTMLDivElement | null>(null);

  const active = useMemo(() => {
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (t >= transcript[i].t0 - 0.02) return t <= transcript[i].t1 + 0.25 ? i : -1;
    }
    return -1;
  }, [transcript, t]);

  useEffect(() => {
    if (active < 0 || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (!el) return;
    const p = el.parentElement;
    if (!p) return;
    const top = el.offsetTop - p.clientHeight / 2 + el.clientHeight / 2;
    p.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [active]);

  if (!transcript.length) {
    return (
      <div className="tr-empty">
        <p className="empty">{analysis.busy && !transcriptSrc ? '分析中' : '暂无文稿 · 可导入 .srt/.vtt'}</p>
        <div className="tr-act">
          <Btn size="sm" icon="text" onClick={importSubs}>
            导入
          </Btn>
          <Btn size="sm" icon="refresh" onClick={() => void transcribe()}>
            转写
          </Btn>
        </div>
        {transcriptSrc ? <p className="tr-why">{transcriptSrc}</p> : null}
      </div>
    );
  }

  return (
    <>
      <div className="tr-head">
        <span className="meta">{transcriptSrc}</span>
        <div className="tr-act">
          <Btn size="sm" icon="text" onClick={importSubs}>
            导入
          </Btn>
          <Btn size="sm" icon="refresh" onClick={() => void transcribe()}>
            转写
          </Btn>
        </div>
      </div>
      <div className="tr-list scroll" ref={box}>
        {transcript.map((s, i) => (
          <button
            type="button"
            className={`li tr-li${i === active ? ' is-on' : ''}`}
            data-i={i}
            key={`${s.t0}-${i}`}
            onClick={() => seek(s.t0)}
          >
            <span className="li-r">{fmtTime(s.t0)}</span>
            <span className="tr-tx">{s.txt}</span>
          </button>
        ))}
      </div>
    </>
  );
}
