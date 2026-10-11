// One HTMLAudioElement per track, slaved to a single playhead clock.
// Gain/mute/solo go through element properties only: no WebAudio graph, because the media
// URLs are cross-origin for the WebView (127.0.0.1:8787 vs the dev server) and a
// MediaElementAudioSourceNode would render silence there.

export interface TrackSpec {
  id: string;
  url: string;
  offset: number;
  dur: number;
  gain: number;
  mute: boolean;
  solo: boolean;
}

export interface Snap {
  t: number;
  playing: boolean;
  duration: number;
}

const clamp01 = (v: number) => (isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

class Player {
  private els = new Map<string, HTMLAudioElement>();
  private specs = new Map<string, TrackSpec>();
  private subs = new Set<() => void>();
  private raf = 0;
  private anchorWall = 0;
  private anchorT = 0;
  private snap: Snap = { t: 0, playing: false, duration: 0 };

  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  };

  getSnap = (): Snap => this.snap;

  private emit(patch: Partial<Snap>): void {
    this.snap = { ...this.snap, ...patch };
    this.subs.forEach((cb) => cb());
  }

  private recalc(): void {
    let d = 0;
    this.specs.forEach((s) => {
      const el = this.els.get(s.id);
      const dur = s.dur > 0 ? s.dur : (el && isFinite(el.duration) ? el.duration : 0);
      d = Math.max(d, Math.max(0, s.offset) + dur);
    });
    if (Math.abs(d - this.snap.duration) > 1e-6) this.emit({ duration: d });
  }

  sync(specs: TrackSpec[]): void {
    const ids = new Set(specs.map((s) => s.id));
    for (const [id, el] of this.els) {
      if (ids.has(id)) continue;
      el.pause();
      el.removeAttribute('src');
      this.els.delete(id);
      this.specs.delete(id);
    }
    for (const s of specs) {
      let el = this.els.get(s.id);
      if (!el) {
        el = new Audio();
        el.preload = 'auto';
        this.els.set(s.id, el);
        el.addEventListener('loadedmetadata', () => this.recalc());
      }
      if (el.src !== s.url) el.src = s.url;
      el.volume = clamp01(s.gain);
      this.specs.set(s.id, s);
      if (this.snap.playing) this.arm(s.id);
    }
    this.recalc();
    if (this.snap.t > this.snap.duration) this.emit({ t: this.snap.duration });
  }

  patch(id: string, p: Partial<TrackSpec>): void {
    const cur = this.specs.get(id);
    if (!cur) return;
    this.specs.set(id, { ...cur, ...p });
    const el = this.els.get(id);
    if (el) {
      if (p.gain !== undefined) el.volume = clamp01(p.gain);
      if (p.url !== undefined && el.src !== p.url) el.src = p.url;
    }
    if (this.snap.playing) this.arm(id);
    this.recalc();
  }

  private anySolo(): boolean {
    for (const s of this.specs.values()) if (s.solo) return true;
    return false;
  }

  /** Mutes tracks that should not be heard at the current playhead without breaking their sync. */
  private applyAudibility(): void {
    const solo = this.anySolo();
    const t = this.snap.t;
    this.specs.forEach((s, id) => {
      const el = this.els.get(id);
      if (!el) return;
      const inRange = t >= s.offset - 0.02 && t < s.offset + (s.dur || el.duration || 0) - 0.001;
      const wanted = !s.mute && (!solo || s.solo) && s.gain > 0.001;
      el.muted = !(inRange && wanted);
    });
  }

  private arm(id: string): void {
    const s = this.specs.get(id);
    const el = this.els.get(id);
    if (!s || !el) return;
    const want = this.snap.playing;
    const pos = this.snap.t - s.offset;
    const dur = s.dur > 0 ? s.dur : (isFinite(el.duration) ? el.duration : 0);
    const live = want && pos >= -0.02 && (dur <= 0 || pos <= dur);
    if (!live) {
      if (!el.paused) el.pause();
      return;
    }
    if (Math.abs(el.currentTime - Math.max(0, pos)) > 0.14) {
      try {
        el.currentTime = Math.max(0, pos);
      } catch {
        /* metadata may not be ready yet; the tick loop retries */
      }
    }
    if (el.paused) void el.play().catch(() => undefined);
  }

  play(): void {
    if (!this.specs.size) return;
    let t = this.snap.t;
    if (this.snap.duration > 0 && t >= this.snap.duration - 0.01) t = 0;
    this.anchorT = t;
    this.anchorWall = performance.now();
    this.emit({ t, playing: true });
    this.specs.forEach((_, id) => this.arm(id));
    this.applyAudibility();
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.snap.playing) return;
    this.specs.forEach((_, id) => {
      const el = this.els.get(id);
      if (el) el.pause();
    });
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.emit({ playing: false });
  }

  toggle(): void {
    if (this.snap.playing) this.pause();
    else this.play();
  }

  seek(t: number): void {
    const v = Math.max(0, isFinite(t) ? t : 0);
    this.anchorT = v;
    this.anchorWall = performance.now();
    this.emit({ t: v });
    this.specs.forEach((_, id) => this.arm(id));
    this.applyAudibility();
  }

  stopAtEnd(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.specs.forEach((_, id) => {
      const el = this.els.get(id);
      if (el) el.pause();
    });
    this.emit({ playing: false });
  }

  private tick = (): void => {
    if (!this.snap.playing) {
      this.raf = 0;
      return;
    }
    const t = this.anchorT + (performance.now() - this.anchorWall) / 1000;
    if (this.snap.duration > 0 && t >= this.snap.duration) {
      this.emit({ t: this.snap.duration });
      this.stopAtEnd();
      return;
    }
    this.emit({ t });
    this.applyAudibility();
    this.specs.forEach((_, id) => this.arm(id));
    this.raf = requestAnimationFrame(this.tick);
  };
}

export const player = new Player();
