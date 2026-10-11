import { baseName } from '../api';
import { clampPct } from '../lib/units';
import { useApp } from '../state/app';
import { Btn, Ring } from './ui';

function chLabel(ch: number): string {
  if (ch === 1) return '单声道';
  if (ch === 2) return '立体声';
  if (ch === 6) return '5.1';
  return `${ch} 声道`;
}

export function RenderCard() {
  const { job, jobs, busy, prefs, actions, cancelJob, lastOut } = useApp();
  const running = job?.state === 'running';
  const failed = job?.state === 'error' || job?.state === 'cancelled';
  // A filled ring has to have a file behind it: the engine runs analysis as jobs too,
  // and "100% 完成" with nothing to reveal reads as a lie.
  const done = !running && !failed && !!lastOut;
  const pct = running ? clampPct(job?.pct ?? 0) : done ? 100 : 0;
  const stage = running
    ? job?.stage || busy
    : failed
      ? job?.state === 'error'
        ? '失败'
        : '已停止'
      : done
        ? '完成'
        : '';
  const main = running ? `${Math.round(pct)}%` : done ? '100%' : '待处理';
  const cancelId = running ? job?.id : jobs.find((j) => j.state === 'running')?.id;

  return (
    <>
      <div className="rend">
        <Ring value={pct} size={96} stroke={8} main={main} sub={running ? job?.op : undefined} />
        <div className="rend-x">
          <span className="pill">
            {prefs.fmt.toUpperCase()} · {Math.round(prefs.sr / 1000)} kHz · {chLabel(prefs.ch)}
          </span>
          {stage ? <p className="stage">{stage}</p> : null}
          {lastOut && !running ? <p className="outname">{baseName(lastOut)}</p> : null}
        </div>
      </div>
      <div className="rend-act">
        {running || cancelId ? (
          <Btn tone="danger" size="sm" icon="stop" onClick={() => cancelId && void cancelJob(cancelId)}>
            停止
          </Btn>
        ) : (
          <Btn tone="primary" size="sm" icon="export" onClick={() => void actions.render()}>
            导出
          </Btn>
        )}
        {!running && lastOut ? (
          <Btn size="sm" icon="folder" onClick={() => void actions.reveal(lastOut)}>
            显示
          </Btn>
        ) : null}
      </div>
    </>
  );
}
