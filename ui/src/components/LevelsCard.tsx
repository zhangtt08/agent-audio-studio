import { dbToPct, toDb } from '../lib/units';
import { useApp } from '../state/app';
import { Empty } from './ui';

const label = (v: number) => `${toDb(v).toFixed(1)} dB`;

export function LevelsCard() {
  const { analysis } = useApp();
  const chs = analysis.levels;
  if (!chs.length) return <Empty text={analysis.busy ? '分析中' : '暂无电平'} />;
  return (
    <div className="levels">
      {chs.map((c) => {
        const pk = dbToPct(toDb(c.peak));
        const rm = dbToPct(toDb(c.rms));
        return (
          <div className="lv" key={c.name} title={`${c.name} · 峰值 ${label(c.peak)} · 均值 ${label(c.rms)}`}>
            <div className="lv-t">
              <i style={{ height: `${rm}%` }} />
              <em style={{ bottom: `${pk}%` }} />
            </div>
            <b>{c.name}</b>
            <span>{toDb(c.peak).toFixed(0)}</span>
          </div>
        );
      })}
    </div>
  );
}
