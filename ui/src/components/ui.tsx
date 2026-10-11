import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function Card({
  title,
  right,
  children,
  className = '',
  fill = false,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  fill?: boolean;
}) {
  return (
    <section className={`card ${className}${fill ? ' card-fill' : ''}`}>
      {title && (
        <header className="card-h">
          <h3>{title}</h3>
          {right && <div className="card-x">{right}</div>}
        </header>
      )}
      <div className={`card-b${fill ? ' card-b-fill' : ''}`}>{children}</div>
    </section>
  );
}

export function Btn({
  children,
  onClick,
  icon,
  tone = 'ghost',
  size = 'md',
  disabled,
  active,
  title,
}: {
  children?: ReactNode;
  onClick?: () => void;
  icon?: IconName;
  tone?: 'primary' | 'ghost' | 'quiet' | 'danger';
  size?: 'sm' | 'md' | 'icon';
  disabled?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`btn btn-${tone} btn-${size}${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <Icon n={icon} s={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Ring({
  value,
  size = 104,
  stroke = 9,
  main,
  sub,
  color = 'var(--accent)',
}: {
  value: number;
  size?: number;
  stroke?: number;
  main: string;
  sub?: string;
  color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(100, Math.max(0, value));
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-bg" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(c * v) / 100} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-t">
        <b>{main}</b>
        {sub && <i>{sub}</i>}
      </div>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

export function Chip({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="chip" style={color ? { borderColor: color, color } : undefined}>
      {children}
    </span>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="dot" style={{ background: color }} />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
