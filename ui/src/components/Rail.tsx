import { Icon, Logo, type IconName } from './Icon';
import { useApp, type View } from '../state/app';

const NAV: { v: View; icon: IconName; label: string }[] = [
  { v: 'workbench', icon: 'workbench', label: '工作台' },
  { v: 'tracks', icon: 'tracks', label: '轨道' },
  { v: 'agent', icon: 'agent', label: '智能体' },
  { v: 'settings', icon: 'settings', label: '设置' },
];

export function Rail() {
  const { view, setView, prefs, setPrefs } = useApp();
  return (
    <nav className="rail">
      <Logo />
      <div className="rail-nav">
        {NAV.map((n) => (
          <button
            key={n.v}
            type="button"
            className={`rail-i${view === n.v ? ' is-on' : ''}`}
            onClick={() => setView(n.v)}
          >
            <Icon n={n.icon} s={19} />
            <span>{n.label}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="rail-th"
        title={prefs.theme === 'dark' ? '浅色' : '深色'}
        onClick={() => setPrefs({ theme: prefs.theme === 'dark' ? 'light' : 'dark' })}
      >
        <Icon n={prefs.theme === 'dark' ? 'sun' : 'moon'} s={15} />
      </button>
    </nav>
  );
}
