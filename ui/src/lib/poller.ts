/** setInterval that never overlaps itself and can be stopped cheaply. */
export interface Poller {
  start(): void;
  stop(): void;
  readonly active: boolean;
  refresh(): Promise<void>;
}

export function makePoller(fn: () => Promise<unknown>, ms: number): Poller {
  let timer: number | null = null;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch {
      /* caller surfaces errors; polling must not die on one failure */
    } finally {
      busy = false;
    }
  };
  return {
    start() {
      if (timer !== null) return;
      void run();
      timer = window.setInterval(() => void run(), ms);
    },
    stop() {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    },
    get active() {
      return timer !== null;
    },
    refresh: run,
  };
}
