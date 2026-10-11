import { useEffect, useState } from 'react';
import { isTauri } from '../api';

interface WinCtl {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
}

async function win(): Promise<WinCtl | null> {
  try {
    const m = await import('@tauri-apps/api/webviewWindow');
    return m.getCurrentWebviewWindow() as unknown as WinCtl;
  } catch {
    return null;
  }
}

/**
 * The window has no OS frame, so these controls are the only ones and live
 * inside the glass surface. The bar itself is the drag region.
 */
export function TitleBar() {
  const [max, setMax] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let dead = false;
    void (async () => {
      const w = await win();
      if (!w || dead) return;
      setMax(await w.isMaximized().catch(() => false));
    })();
    return () => {
      dead = true;
    };
  }, []);

  if (!isTauri) return null;

  const run = async (fn: (w: WinCtl) => Promise<void>) => {
    const w = await win();
    if (w) await fn(w).catch(() => undefined);
  };

  return (
    <div className="tbar" data-tauri-drag-region>
      <span className="tbar-grip" data-tauri-drag-region />
      <div className="tbar-btns">
        <button type="button" aria-label="最小化" onClick={() => void run((w) => w.minimize())}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 6.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={max ? '还原' : '最大化'}
          onClick={() =>
            void run(async (w) => {
              await w.toggleMaximize();
              setMax((m) => !m);
            })
          }
        >
          <svg width="11" height="11" viewBox="0 0 12 12">
            {max ? (
              <>
                <rect x="1.6" y="3.4" width="6" height="6" rx="1.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
                <path d="M3.6 3V2.4A1.4 1.4 0 0 1 5 1h4.4A1.4 1.4 0 0 1 10.8 2.4V6.8A1.4 1.4 0 0 1 9.4 8.2H8.9" stroke="currentColor" strokeWidth="1.2" fill="none" />
              </>
            ) : (
              <rect x="2" y="2" width="8" height="8" rx="2.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
            )}
          </svg>
        </button>
        <button
          type="button"
          className="tclose"
          aria-label="关闭"
          onClick={() =>
            void run((w) => w.close())
          }
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
