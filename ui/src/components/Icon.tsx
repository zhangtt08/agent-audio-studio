import type { CSSProperties } from 'react';

const P = {
  workbench: 'M4 4h7v6H4zM13 4h7v10h-7zM13 17h7v3h-7zM4 13h7v7H4z',
  tracks: 'M4 8h16M4 14h16M9 5.5v5M16 11.5v5',
  agent: 'M8.5 9h7A3 3 0 0 1 18.5 12v4a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3zM12 4.5V9M9.5 14h.01M14.5 14h.01',
  settings:
    'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1',
  sun: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z',
  import: 'M12 3.5v9.5m0 0L8.5 9.5M12 13l3.5-3.5M4 17v2a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2',
  fit: 'M5 19 14 10M16.5 3.5l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9z',
  mic: 'M12 3.5a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0V6A2.5 2.5 0 0 1 12 3.5zM6.5 10.5a5.5 5.5 0 0 0 11 0M12 16v4.5M9 20.5h6',
  export: 'M12 20V8m0 0L8 12M12 8l4 4M4 21.5h16',
  play: 'M8 5.5 18.5 12 8 18.5z',
  pause: 'M9.5 5.5v13M14.5 5.5v13',
  prev: 'M18.5 6.5v11L11 12zM6.5 5.5v13',
  next: 'M5.5 6.5v11L13 12zM17.5 5.5v13',
  plus: 'M12 5.5v13M5.5 12h13',
  minus: 'M5.5 12h13',
  copy: 'M9 9h9.5A1.5 1.5 0 0 1 20 10.5V20a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 20v-9.5A1.5 1.5 0 0 1 9 9zM5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  check: 'M5 13l4.5 4.5L19 7',
  stop: 'M7.5 7.5h9v9h-9z',
  cut: 'M7 8.5 18.5 16M7 15.5 18.5 8M4.5 7.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0zM4.5 16.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0z',
  wave: 'M3 12h1.5l2-6.5 3 13 3-9.5 2 3H21',
  split: 'M4 6.5h4.5M4 12h4.5M4 17.5h4.5M13 12h7M13 12l3.5-3.5M13 12l3.5 3.5',
  mix: 'M7 3.5v17M7 9h5M17 3.5v17M17 15h-5',
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h3.8l1.7 2h7.8a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4.5V9h-4.5',
  link: 'M10 14a4.5 4.5 0 0 1 0-6.4l1.6-1.6a4.5 4.5 0 0 1 6.4 6.4L17 12.4M14 10a4.5 4.5 0 0 1 0 6.4L12.4 18a4.5 4.5 0 0 1-6.4-6.4L7 11.6',
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7v5.5l3.5 2',
  trash: 'M4 7h16M9.5 7V4h5v3M6.5 7l1 13.5h9L17.5 7',
  text: 'M4.5 5.5h15v13h-15zM7.5 9.5h7M7.5 13h9',
  fx: 'M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7zM18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z',
  noise: 'M4 12h1.5l2-5 3 10.5 2.5-8 2 5.5 1.5-3H20',
  target: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  save: 'M5 4.5h11L19.5 8v11.5H5zM8.5 4.5V9h7V4.5M8.5 19.5v-5h7v5',
  power: 'M12 3.5v8M6.8 6.8a7.5 7.5 0 1 0 10.4 0',
} as const;

export type IconName = keyof typeof P;

export function Icon({ n, s = 18, style }: { n: IconName; s?: number; style?: CSSProperties }) {
  const filled = n === 'play' || n === 'stop';
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={style}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={P[n]} />
    </svg>
  );
}

export function Logo({ s = 34 }: { s?: number }) {
  return (
    <span className="logo-mark" style={{ width: s, height: s }}>
      <svg viewBox="0 0 24 24" width={s * 0.62} height={s * 0.62} fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round">
        <path d="M4 12h1.6l2-6 3 12 2.4-8 1.6 4H20" />
      </svg>
    </span>
  );
}
