// Procedural foley for MERCADIA. Every sound is synthesised with Web Audio; there are no
// audio files. The context is created on the first user gesture.

const KEY = 'mercadia:muted';

type Ctx = AudioContext;

export class Foley {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last: Record<string, number> = {};
  private rainGain: GainNode | null = null;
  private rainSrc: AudioBufferSourceNode | null = null;
  muted: boolean;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(KEY);
    } catch {
      stored = null;
    }
    this.muted = stored === '1';
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return;
    }
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.5;
      // A gentle compressor keeps a busy street from clipping.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      master.connect(comp).connect(ctx.destination);
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let seed = 22222;
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[i] = (seed / 4294967296) * 2 - 1;
      }
      this.ctx = ctx;
      this.master = master;
      this.noise = buf;
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    try {
      localStorage.setItem(KEY, m ? '1' : '0');
    } catch {
      // private mode: the toggle still works for this visit
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  toggle(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private ready(name: string, gapMs: number): Ctx | null {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || ctx.state !== 'running') return null;
    const now = performance.now();
    if (now - (this.last[name] ?? -1e9) < gapMs) return null;
    this.last[name] = now;
    return ctx;
  }

  private tone(ctx: Ctx, type: OscillatorType, f0: number, f1: number, t: number, dur: number, gain: number, attack = 0.004): void {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master as GainNode);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private hiss(ctx: Ctx, t: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 0.8): void {
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master as GainNode);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  /** Wooden build thud: a low knock, a short dull body, a little sawdust. */
  build(mine = true): void {
    const ctx = this.ready('build', 90);
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = mine ? 1 : 0.4;
    this.tone(ctx, 'sine', 150, 58, t, 0.2, 0.55 * v);
    this.tone(ctx, 'triangle', 310, 180, t, 0.07, 0.22 * v);
    this.hiss(ctx, t, 0.09, 0.2 * v, 'lowpass', 900);
    this.tone(ctx, 'sine', 120, 70, t + 0.11, 0.12, 0.2 * v);
  }

  /** Brass coin chime: two bright partials and a faint ring. */
  coin(): void {
    const ctx = this.ready('coin', 110);
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = 1568 * (1 + (Math.random() - 0.5) * 0.03);
    this.tone(ctx, 'sine', f, f, t, 0.32, 0.16, 0.002);
    this.tone(ctx, 'sine', f * 1.498, f * 1.498, t + 0.045, 0.36, 0.12, 0.002);
    this.tone(ctx, 'triangle', f * 2.76, f * 2.76, t, 0.12, 0.035, 0.001);
  }

  /** Tram bell: two strikes of an inharmonic bell. */
  bell(): void {
    const ctx = this.ready('bell', 900);
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const d of [0, 0.19]) {
      this.tone(ctx, 'sine', 932, 932, t + d, 0.75, 0.1, 0.002);
      this.tone(ctx, 'sine', 932 * 2.76, 932 * 2.76, t + d, 0.4, 0.05, 0.001);
      this.tone(ctx, 'sine', 932 * 5.4, 932 * 5.4, t + d, 0.16, 0.022, 0.001);
      this.hiss(ctx, t + d, 0.02, 0.05, 'highpass', 5000);
    }
  }

  /** Paper rustle for a Gazette headline: three quick brushes of filtered noise. */
  rustle(): void {
    const ctx = this.ready('rustle', 400);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.hiss(ctx, t, 0.1, 0.16, 'bandpass', 3400, 0.7);
    this.hiss(ctx, t + 0.09, 0.07, 0.11, 'bandpass', 5200, 0.9);
    this.hiss(ctx, t + 0.17, 0.14, 0.14, 'bandpass', 2600, 0.6);
    this.tone(ctx, 'triangle', 220, 196, t + 0.02, 0.09, 0.03);
  }

  /** Upgrade fanfare: a small brass arpeggio. */
  fanfare(): void {
    const ctx = this.ready('fanfare', 500);
    if (!ctx) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const at = t + i * 0.085;
      const dur = i === 3 ? 0.5 : 0.16;
      const o = ctx.createOscillator();
      const lp = ctx.createBiquadFilter();
      const g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = f;
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, at);
      lp.frequency.exponentialRampToValueAtTime(2600, at + 0.05);
      lp.frequency.exponentialRampToValueAtTime(1100, at + dur);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.13, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(lp).connect(g).connect(this.master as GainNode);
      o.start(at);
      o.stop(at + dur + 0.02);
    });
  }

  /** Award: the fanfare with a shimmer on top. */
  award(): void {
    this.fanfare();
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.36;
    [2093, 2637, 3136].forEach((f, i) => this.tone(ctx, 'sine', f, f, t + i * 0.05, 0.6, 0.05, 0.002));
  }

  /** Promo Blitz: a quick upward flourish. */
  promo(): void {
    const ctx = this.ready('promo', 300);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, 'triangle', 440, 880, t, 0.14, 0.12);
    this.tone(ctx, 'triangle', 660, 1320, t + 0.1, 0.18, 0.1);
    this.hiss(ctx, t, 0.2, 0.05, 'highpass', 4200);
  }

  /** Sale of a property: two falling notes. */
  sell(): void {
    const ctx = this.ready('sell', 300);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, 'triangle', 523, 494, t, 0.16, 0.12);
    this.tone(ctx, 'triangle', 392, 330, t + 0.13, 0.26, 0.12);
    this.hiss(ctx, t, 0.18, 0.1, 'lowpass', 700);
  }

  /** Restock: two crates set down. */
  restock(): void {
    const ctx = this.ready('restock', 200);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, 'sine', 190, 90, t, 0.1, 0.3);
    this.tone(ctx, 'sine', 170, 80, t + 0.12, 0.12, 0.26);
    this.hiss(ctx, t + 0.12, 0.05, 0.08, 'lowpass', 1200);
  }

  /** A rejected action: a soft double knock. */
  deny(): void {
    const ctx = this.ready('deny', 250);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, 'triangle', 196, 170, t, 0.08, 0.16);
    this.tone(ctx, 'triangle', 165, 140, t + 0.1, 0.12, 0.16);
  }

  /** Interface tick. */
  click(): void {
    const ctx = this.ready('click', 40);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, 'triangle', 1250, 980, t, 0.035, 0.07, 0.001);
  }

  /** Quarter bell: one low, long chime. */
  quarter(): void {
    const ctx = this.ready('quarter', 1500);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, 'sine', 392, 392, t, 1.6, 0.14, 0.004);
    this.tone(ctx, 'sine', 392 * 2.01, 392 * 2.01, t, 1.1, 0.07, 0.004);
    this.tone(ctx, 'sine', 392 * 2.98, 392 * 2.98, t, 0.7, 0.04, 0.004);
  }

  /** Rain bed that follows the cloudburst in and out. */
  rain(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    if (on && !this.rainSrc) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      bp.Q.value = 0.35;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(bp).connect(g).connect(this.master);
      src.start();
      g.gain.setTargetAtTime(0.085, ctx.currentTime, 0.8);
      this.rainSrc = src;
      this.rainGain = g;
    } else if (!on && this.rainSrc && this.rainGain) {
      const src = this.rainSrc;
      this.rainGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.6);
      src.stop(ctx.currentTime + 3);
      this.rainSrc = null;
      this.rainGain = null;
    }
  }
}
