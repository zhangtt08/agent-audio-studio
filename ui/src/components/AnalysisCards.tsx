import { fmtTime } from '../api';
import { toPct } from '../lib/units';
import { useApp, KIND_COLOR, KIND_LABEL } from '../state/app';
import { Chip, Dot, Empty, Ring } from './ui';

export function SectionsCard() {
  const { analysis, seek } = useApp();
  const secs = analysis.sections;
  return (
    <div className="scroll list">
      {secs.length === 0 ? (
        <Empty text={analysis.busy ? '分析中' : '暂无段落'} />
      ) : (
        secs.map((s, i) => (
          <button type="button" className="li" key={`${s.t0}-${i}`} onClick={() => seek(s.t0)}>
            <Dot color={KIND_COLOR[s.kind] ?? '#8A8682'} />
            <span className="li-k">{KIND_LABEL[s.kind] ?? s.kind}</span>
            <span className="li-r">
              {fmtTime(s.t0)} – {fmtTime(s.t1)}
            </span>
            <span className="li-e">
              <i style={{ width: `${toPct(s.energy)}%`, background: KIND_COLOR[s.kind] ?? '#8A8682' }} />
            </span>
          </button>
        ))
      )}
    </div>
  );
}

export function ScoreCard() {
  const { analysis } = useApp();
  const sc = analysis.score;
  if (!sc) return <Empty text={analysis.busy ? '分析中' : '暂无评分'} />;
  const rows: [string, number][] = [
    ['清晰度', toPct(sc.clarity)],
    ['平衡', toPct(sc.balance)],
    ['动态', toPct(sc.dynamics)],
    ['底噪', toPct(sc.noise)],
  ];
  return (
    <div className="score">
      <div className="score-top">
        <Ring value={toPct(sc.score)} size={104} main={`${Math.round(toPct(sc.score))}`} sub="总分" />
        <div className="sraw">
          <Chip>{isFinite(sc.lufs) ? `${sc.lufs.toFixed(1)} LUFS` : '—'}</Chip>
          <Chip>{isFinite(sc.peak) ? `${sc.peak.toFixed(1)} dBFS` : '—'}</Chip>
          <Chip>{isFinite(sc.dur) ? `${fmtTime(sc.dur)} · ${Math.round((sc.sr || 0) / 1000)}k` : '—'}</Chip>
        </div>
      </div>
      <div className="score-ms">
        {rows.map(([l, v]) => (
          <div className="smet" key={l}>
            <span>{l}</span>
            <div className="mbar-t">
              <div className="mbar-f" style={{ width: `${v}%` }} />
            </div>
            <b>{Math.round(v)}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
