import { fmtTime } from '../api';
import { useApp } from '../state/app';
import { AgentStatus } from './AgentStatus';
import { HeroCanvas } from './HeroCanvas';
import { Icon, type IconName } from './Icon';

export function Header() {
  const { actions, prefs, targetDur, pickFiles } = useApp();

  const tiles: { icon: IconName; label: string; sub: string; run: () => void; tone?: 'primary' | 'plain' }[] = [
    { icon: 'import', label: '导入媒体', sub: '拖入或选择', run: () => void pickFiles() },
    {
      icon: 'fit',
      label: '一键适配',
      sub: targetDur && targetDur > 0 ? `目标 ${fmtTime(targetDur)}` : '未设目标',
      run: () => void actions.fit(),
      tone: 'primary',
    },
    { icon: 'mic', label: '人声分离', sub: '人声 · 伴奏', run: () => void actions.separate('center') },
    {
      icon: 'export',
      label: '导出成品',
      sub: `${prefs.fmt.toUpperCase()} · ${Math.round(prefs.sr / 1000)}k`,
      run: () => void actions.render(),
    },
  ];

  return (
    <header className="head">
      <div className="head-l">
        <h1 className="brand">
          <span>Agent</span>
          <i>Audio</i>
        </h1>
        <p className="tag">为 AI 智能体准备的音频运行时</p>
        <div className="tiles">
          {tiles.map((t) => (
            <button
              key={t.label}
              type="button"
              className={`tile${t.tone === 'primary' ? ' is-key' : ''}`}
              onClick={t.run}
            >
              <span className="tile-i">
                <Icon n={t.icon} s={18} />
              </span>
              <span className="tile-t">{t.label}</span>
              <span className="tile-s">{t.sub}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="head-r">
        <div className="card astat-card">
          <AgentStatus />
        </div>
        <HeroCanvas />
      </div>
    </header>
  );
}
