// Procedural foley for MERCADIA, synthesised with Web Audio (no audio files).
//
// Sounds answer player actions and resolutions only: nothing here runs on a timer or loops. The
// AudioContext is created lazily on the first user gesture (unlock), and the mute preference
// persists in localStorage under `mercadia:muted`.
import type { HudSound } from './hud';

const KEY = 'mercadia:muted';

export class Sound implements HudSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last: Record<string, number> = {};
  private _muted: boolean;
  private listeners = new Set<(muted: boolean) => void>();

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(KEY);
    } catch {
      stored = null;
    }
    this._muted = stored === '1';
  }

  get muted(): boolean {
    return this._muted;
  }

  /** Subscribe to mute changes (for `aria-pressed` toggles that live outside the HUD). */
  onMute(fn: (muted: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Create or resume the audio context. Must be called from a user gesture; safe to repeat. */
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
      master.gain.value = this._muted ? 0 : 0.5;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      master.connect(comp).connect(ctx.destination);
      // One second of deterministic white noise shared by every paper and seal sound.
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
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean): void {
    this._muted = m;
    try {
      localStorage.setItem(KEY, m ? '1' : '0');
    } catch {
      // private mode: the toggle still works for this visit
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
    for (const fn of [...this.listeners]) fn(m);
  }

  toggleMute(): void {
    this.unlock();
    this.setMuted(!this._muted);
  }

  // ───────────────────────────── Building blocks ─────────────────────────────

  private ready(name: string, gapMs: number): AudioContext | null {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || !this.master || this._muted || ctx.state !== 'running') return null;
    const now = performance.now();
    if (now - (this.last[name] ?? -1e9) < gapMs) return null;
    this.last[name] = now;
    return ctx;
  }

  private tone(ctx: AudioContext, type: OscillatorType, f0: number, f1: number, t: number, dur: number, gain: number, attack = 0.004): void {
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

  private hiss(ctx: AudioContext, t: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 0.8, from = 0): void {
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
    src.start(t, from);
    src.stop(t + dur + 0.02);
  }

  /** A soft pad note with a slow attack: the block of the warm chords. */
  private pad(ctx: AudioContext, f: number, t: number, dur: number, gain: number): void {
    const o = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(2200, t + 0.12);
    lp.frequency.exponentialRampToValueAtTime(900, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(this.master as GainNode);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // ───────────────────────────── The sounds of the table ─────────────────────────────

  /** Soft paper tap: an order is queued. */
  tap(): void {
    const ctx = this.ready('tap', 40);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.hiss(ctx, t, 0.045, 0.16, 'bandpass', 2600, 0.9, 0.1);
    this.tone(ctx, 'triangle', 420, 300, t, 0.05, 0.07, 0.001);
  }

  /** Reverse tap: an order is undone (the same paper, lifted instead of laid). */
  undo(): void {
    const ctx = this.ready('undo', 40);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, 'triangle', 300, 440, t, 0.05, 0.06, 0.001);
    this.hiss(ctx, t + 0.02, 0.05, 0.13, 'bandpass', 2000, 0.9, 0.3);
  }

  /** Wax-seal stamp: End Turn or Ready. */
  seal(): void {
    const ctx = this.ready('seal', 200);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, 'sine', 150, 66, t, 0.1, 0.34, 0.002);
    this.hiss(ctx, t, 0.04, 0.1, 'lowpass', 900);
    this.tone(ctx, 'triangle', 880, 820, t + 0.05, 0.12, 0.045, 0.002);
  }

  /** Two-strike tram bell: a turn resolved. */
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

  /** Warm chord: an Era transition or a Dynasty Milestone. */
  era(): void {
    const ctx = this.ready('era', 1500);
    if (!ctx) return;
    const t = ctx.currentTime + 0.5; // lands after the tram bell
    this.tone(ctx, 'sine', 196, 196, t, 1.8, 0.12, 0.004);
    [261.63, 329.63, 392, 523.25, 659.25].forEach((f, i) => this.pad(ctx, f, t + 0.06 + i * 0.07, 1.3 - i * 0.08, 0.075));
    this.tone(ctx, 'sine', 1046.5, 1046.5, t + 0.5, 0.9, 0.035, 0.002);
  }

  /** Charter seal click: a short, dry press with a brass ring. */
  charter(): void {
    const ctx = this.ready('charter', 250);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, 'sine', 180, 80, t, 0.08, 0.3, 0.002);
    this.hiss(ctx, t, 0.03, 0.12, 'lowpass', 1200);
    this.tone(ctx, 'sine', 1318.5, 1318.5, t + 0.04, 0.35, 0.05, 0.002);
    this.tone(ctx, 'sine', 1975.5, 1975.5, t + 0.07, 0.3, 0.03, 0.002);
  }

  /** Newspaper rustle: the Final Edition lands on the table. */
  rustle(): void {
    const ctx = this.ready('rustle', 600);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.hiss(ctx, t, 0.1, 0.16, 'bandpass', 3400, 0.7, 0.05);
    this.hiss(ctx, t + 0.09, 0.07, 0.11, 'bandpass', 5200, 0.9, 0.3);
    this.hiss(ctx, t + 0.17, 0.14, 0.14, 'bandpass', 2600, 0.6, 0.6);
    this.tone(ctx, 'triangle', 220, 196, t + 0.02, 0.09, 0.03);
  }

  // ───────────────────────────── Conveniences ─────────────────────────────

  /** A resolution happened: the tram bell, plus the warm chord on an Era transition or Milestone. */
  resolved(majorMoment: boolean): void {
    this.bell();
    if (majorMoment) this.era();
  }

  eraChime(): void {
    this.era();
  }
}
