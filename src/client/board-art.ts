// Architectural Monograph art for the MERCADIA board: flat tonal solids (lit top, mid left,
// shaded right) outlined in 1px Ink, printed on travertine. Everything here is STILL: pure
// functions of (state → ink), no clocks, no random, no animation.
import { HOUSES } from '../shared/constants';
import type { BuildKind, ShopKind, UnitKind } from '../shared/types';
import { drawCrest } from './heraldry';

export const HW = 32; // half tile width (world px)
export const HH = 16; // half tile height

// ───────────────────────────── Palette ─────────────────────────────

export const INK = '#16130F';
export const ALABASTER = '#F7F4EE';
export const TRAVERTINE = '#E8E0CF';
export const TRAVERTINE_DEEP = '#D6CBB4';
export const GRAPHITE = '#4A443C';
export const HAIRLINE = 'rgba(22, 19, 15, 0.18)';
export const CANAL = '#3E7F8C';
export const SAGE = '#8FA58E';
export const TERRACOTTA = '#B65A3C';
export const BRASS = '#B8893A';
export const ALERT = '#8B241D';

const rgbCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let v = rgbCache.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, v);
  }
  return v;
}
const toHex = (r: number, g: number, b: number): string =>
  '#' + ((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1);

/** Linear mix of two hex colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}

export interface Mat {
  top: string;
  left: string; // the south-facing face
  right: string; // the east-facing face
}

/** Daypart print tones: a gentle tint of paper and stone, applied once per turn. Linework and crests are never toned. */
const TINTS: { c: string; a: number }[] = [
  { c: '#BFD3E0', a: 0.1 }, // Morning: cool pale
  { c: '#FFFFFF', a: 0.1 }, // Noon: bright, clear
  { c: '#E3A24A', a: 0.17 }, // Golden Hour: warm
  { c: '#4C5F86', a: 0.17 }, // Twilight: cool slate (ink stays full strength)
];

export interface Theme {
  daypart: number;
  /** Tone a hex colour for this daypart. */
  c(hex: string): string;
  /** A flat three-tone material from a base colour (toned). */
  m(base: string, topUp?: number, rightDown?: number): Mat;
  page: string;
  slabTop: string;
  slabLeft: string;
  slabRight: string;
  paving: string;
  lane: string;
  lot: string;
  water: string;
  waterDeep: string;
  stone: Mat;
  wall: Mat;
  brick: Mat;
  roof: Mat;
  brass: Mat;
  sage: Mat;
}

const themes: Theme[] = [];
export function themeFor(daypart: number): Theme {
  const dp = ((daypart % 4) + 4) % 4;
  let th = themes[dp];
  if (th) return th;
  const tint = TINTS[dp];
  const cc = new Map<string, string>();
  const c = (hex: string): string => {
    let v = cc.get(hex);
    if (!v) {
      v = mix(hex, tint.c, tint.a);
      cc.set(hex, v);
    }
    return v;
  };
  const mc = new Map<string, Mat>();
  const m = (base: string, topUp = 0.22, rightDown = 0.2): Mat => {
    const key = base + topUp + rightDown;
    let v = mc.get(key);
    if (!v) {
      const b = c(base);
      v = { top: mix(b, '#FFFFFF', topUp), left: b, right: mix(b, '#2A2218', rightDown) };
      mc.set(key, v);
    }
    return v;
  };
  th = {
    daypart: dp,
    c,
    m,
    page: c(ALABASTER),
    slabTop: c(TRAVERTINE),
    slabLeft: c(TRAVERTINE_DEEP),
    slabRight: mix(c(TRAVERTINE_DEEP), '#2A2218', 0.16),
    paving: mix(c(TRAVERTINE), '#FFFFFF', 0.35),
    lane: mix(c(TRAVERTINE), '#FFFFFF', 0.55),
    lot: mix(c(SAGE), c(ALABASTER), 0.32),
    water: c(CANAL),
    waterDeep: mix(c(CANAL), INK, 0.3),
    stone: m('#E3DBC8', 0.3, 0.2),
    wall: m('#EFE9DB', 0.25, 0.17),
    brick: m('#CD9D86', 0.22, 0.2),
    roof: m(TERRACOTTA, 0.16, 0.22),
    brass: m(BRASS, 0.3, 0.22),
    sage: m(SAGE, 0.22, 0.22),
  };
  themes[dp] = th;
  return th;
}

export interface HouseTone {
  color: string;
  dark: string;
  light: string;
  wash: string;
}
export const houseTone = (i: number): HouseTone =>
  i >= 0 && i < HOUSES.length ? HOUSES[i] : { color: '#8A8274', dark: '#5E574C', light: '#CFC6B8', wash: 'rgba(138,130,116,0.14)' };

/** Small deterministic hash for placement (never random). */
export function hash32(a: number, b = 0): number {
  let h = (Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0;
}

// ───────────────────────────── Pen ─────────────────────────────

/**
 * Draws in a lot's local frame (a, b ∈ 0..1 across the lot, z in world px). The design's "front"
 * (b = 1) faces the street the lot opens onto: the south face (door to the south) or, when
 * `swap` is set, the east face (door to the east). The camera sees south and east faces.
 */
export class Pen {
  ctx!: CanvasRenderingContext2D;
  th!: Theme;
  h!: HouseTone;
  lw = 1;
  private ox = 0;
  private oy = 0;
  private swap = false;

  at(ctx: CanvasRenderingContext2D, th: Theme, h: HouseTone, lw: number, tx: number, ty: number, swap: boolean): this {
    this.ctx = ctx;
    this.th = th;
    this.h = h;
    this.lw = lw;
    this.ox = tx;
    this.oy = ty;
    this.swap = swap;
    return this;
  }

  X(a: number, b: number): number {
    const u = this.swap ? b : a;
    const v = this.swap ? a : b;
    return (this.ox + u - (this.oy + v)) * HW;
  }
  Y(a: number, b: number, z: number): number {
    const u = this.swap ? b : a;
    const v = this.swap ? a : b;
    return (this.ox + u + (this.oy + v)) * HH - z;
  }

  private trace(pts: number[]): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(this.X(pts[0], pts[1]), this.Y(pts[0], pts[1], pts[2]));
    for (let i = 3; i < pts.length; i += 3) c.lineTo(this.X(pts[i], pts[i + 1]), this.Y(pts[i], pts[i + 1], pts[i + 2]));
    c.closePath();
  }

  /** Filled polygon from flat [a, b, z, …], optionally outlined in Ink. */
  poly(fill: string, pts: number[], outline = true, w = 1): void {
    const c = this.ctx;
    this.trace(pts);
    c.fillStyle = fill;
    c.fill();
    if (outline) {
      c.lineWidth = this.lw * w;
      c.strokeStyle = INK;
      c.lineJoin = 'round';
      c.stroke();
    }
  }

  line(stroke: string, w: number, pts: number[]): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(this.X(pts[0], pts[1]), this.Y(pts[0], pts[1], pts[2]));
    for (let i = 3; i < pts.length; i += 3) c.lineTo(this.X(pts[i], pts[i + 1]), this.Y(pts[i], pts[i + 1], pts[i + 2]));
    c.strokeStyle = stroke;
    c.lineWidth = this.lw * w;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.stroke();
  }

  private frontTone(m: Mat): string {
    return this.swap ? m.right : m.left;
  }
  private sideTone(m: Mat): string {
    return this.swap ? m.left : m.right;
  }

  top(a0: number, b0: number, a1: number, b1: number, z: number, fill: string, outline = true): void {
    this.poly(fill, [a0, b0, z, a1, b0, z, a1, b1, z, a0, b1, z], outline);
  }
  front(a0: number, a1: number, z0: number, z1: number, b: number, fill: string, outline = true): void {
    this.poly(fill, [a0, b, z0, a1, b, z0, a1, b, z1, a0, b, z1], outline);
  }
  side(b0: number, b1: number, z0: number, z1: number, a: number, fill: string, outline = true): void {
    this.poly(fill, [a, b0, z0, a, b1, z0, a, b1, z1, a, b0, z1], outline);
  }

  box(a0: number, b0: number, a1: number, b1: number, z0: number, z1: number, m: Mat): void {
    this.side(b0, b1, z0, z1, a1, this.sideTone(m));
    this.front(a0, a1, z0, z1, b1, this.frontTone(m));
    this.top(a0, b0, a1, b1, z1, m.top);
  }

  /** Window on the front plane: a graphite pane, no outline. */
  win(a0: number, a1: number, z0: number, z1: number, b: number): void {
    this.front(a0, a1, z0, z1, b, this.th.c(GRAPHITE), false);
    this.line(this.th.c(TRAVERTINE), 0.7, [(a0 + a1) / 2, b, z0, (a0 + a1) / 2, b, z1]);
  }
  winSide(b0: number, b1: number, z0: number, z1: number, a: number): void {
    this.side(b0, b1, z0, z1, a, this.th.c(GRAPHITE), false);
  }
  /** n evenly spaced windows across [a0, a1] on the front. */
  winRow(a0: number, a1: number, n: number, z0: number, z1: number, b: number): void {
    const step = (a1 - a0) / n;
    for (let i = 0; i < n; i++) this.win(a0 + step * (i + 0.2), a0 + step * (i + 0.8), z0, z1, b);
  }
  winRowSide(b0: number, b1: number, n: number, z0: number, z1: number, a: number): void {
    const step = (b1 - b0) / n;
    for (let i = 0; i < n; i++) this.winSide(b0 + step * (i + 0.2), b0 + step * (i + 0.8), z0, z1, a);
  }
  door(a0: number, a1: number, z0: number, z1: number, b: number): void {
    this.front(a0, a1, z0, z1, b, this.h.dark);
  }
  /** Arched opening on the front plane. */
  arch(a0: number, a1: number, z0: number, z1: number, b: number, fill: string, outline = true): void {
    const am = (a0 + a1) / 2;
    const r = (a1 - a0) / 2;
    const pts = [a0, b, z0, a1, b, z0, a1, b, z1];
    for (let i = 1; i < 8; i++) {
      const t = (Math.PI * i) / 8;
      pts.push(am + r * Math.cos(t), b, z1 + r * 26 * Math.sin(t));
    }
    pts.push(a0, b, z1);
    this.poly(fill, pts, outline);
  }

  /** Striped awning projecting from the front at height z. */
  awning(a0: number, a1: number, z: number, b: number, depth: number, drop: number, c1: string, c2: string, n: number): void {
    const step = (a1 - a0) / n;
    for (let i = 0; i < n; i++) {
      const x0 = a0 + step * i;
      const x1 = x0 + step;
      this.poly(i % 2 ? c2 : c1, [x0, b, z, x1, b, z, x1, b + depth, z - drop, x0, b + depth, z - drop], false);
    }
    this.poly('rgba(0,0,0,0)', [a0, b, z, a1, b, z, a1, b + depth, z - drop, a0, b + depth, z - drop], true);
  }

  /** Gabled roof, ridge along the a axis; the gable end shows on the side plane. */
  gable(a0: number, b0: number, a1: number, b1: number, z: number, h: number, m: Mat): void {
    const bm = (b0 + b1) / 2;
    this.poly(this.sideTone(m), [a1, b0, z, a1, b1, z, a1, bm, z + h]);
    this.poly(this.frontTone(m), [a0, b1, z, a1, b1, z, a1, bm, z + h, a0, bm, z + h]);
  }
  /** Hipped roof. */
  hip(a0: number, b0: number, a1: number, b1: number, z: number, h: number, inset: number, m: Mat): void {
    const i = inset;
    this.poly(this.sideTone(m), [a1, b0, z, a1, b1, z, a1 - i, b1 - i, z + h, a1 - i, b0 + i, z + h]);
    this.poly(this.frontTone(m), [a0, b1, z, a1, b1, z, a1 - i, b1 - i, z + h, a0 + i, b1 - i, z + h]);
  }
  cornice(a0: number, b0: number, a1: number, b1: number, z: number): void {
    this.box(a0 - 0.02, b0 - 0.02, a1 + 0.02, b1 + 0.02, z, z + 1.8, this.th.stone);
  }

  /** Upright cylinder, centre (a, b), radius r in tile units. */
  cyl(a: number, b: number, r: number, z0: number, z1: number, m: Mat): void {
    const c = this.ctx;
    const cx = this.X(a, b);
    const rx = r * HW * 1.414;
    const ry = r * HH * 1.414;
    const y0 = this.Y(a, b, z0);
    const y1 = this.Y(a, b, z1);
    c.beginPath();
    c.moveTo(cx - rx, y1);
    c.lineTo(cx - rx, y0);
    c.ellipse(cx, y0, rx, ry, 0, Math.PI, 0, true);
    c.lineTo(cx + rx, y1);
    c.closePath();
    c.fillStyle = m.left;
    c.fill();
    c.beginPath();
    c.moveTo(cx + rx * 0.15, y1 + ry * 0.99);
    c.lineTo(cx + rx * 0.15, y0 + ry * 0.99);
    c.ellipse(cx, y0, rx, ry, 0, Math.acos(0.15), 0, true);
    c.lineTo(cx + rx, y1);
    c.ellipse(cx, y1, rx, ry, 0, 0, Math.acos(0.15));
    c.closePath();
    c.fillStyle = m.right;
    c.fill();
    c.beginPath();
    c.moveTo(cx - rx, y1);
    c.lineTo(cx - rx, y0);
    c.ellipse(cx, y0, rx, ry, 0, Math.PI, 0, true);
    c.lineTo(cx + rx, y1);
    c.strokeStyle = INK;
    c.lineWidth = this.lw;
    c.stroke();
    c.beginPath();
    c.ellipse(cx, y1, rx, ry, 0, 0, Math.PI * 2);
    c.fillStyle = m.top;
    c.fill();
    c.stroke();
  }

  /** A foliage ball: lit left, shaded right, outlined. */
  ball(a: number, b: number, z: number, r: number, base: string): void {
    const c = this.ctx;
    const cx = this.X(a, b);
    const cy = this.Y(a, b, z);
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = base;
    c.fill();
    c.beginPath();
    c.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
    c.arc(cx - r * 0.3, cy, r * 1.05, Math.PI / 2, -Math.PI / 2, true);
    c.closePath();
    c.fillStyle = mix(base, '#2A2218', 0.22);
    c.fill();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.strokeStyle = INK;
    c.lineWidth = this.lw;
    c.stroke();
  }
  tree(a: number, b: number, z: number, hgt: number, r: number): void {
    this.line(INK, 1.4, [a, b, z, a, b, z + hgt * 0.5]);
    this.ball(a, b, z + hgt, r, this.th.sage.left);
  }
  post(a: number, b: number, z0: number, z1: number, w = 1.2): void {
    this.line(INK, w, [a, b, z0, a, b, z1]);
  }
  bulbs(a0: number, b0: number, a1: number, b1: number, z: number, n: number): void {
    const c = this.ctx;
    this.line(INK, 0.6, [a0, b0, z, a1, b1, z]);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = a0 + (a1 - a0) * t;
      const b = b0 + (b1 - b0) * t;
      c.beginPath();
      c.arc(this.X(a, b), this.Y(a, b, z - 0.6), 1.5, 0, Math.PI * 2);
      c.fillStyle = this.th.c(BRASS);
      c.fill();
    }
  }
  /** Brass swag between two points (gilded garland): a still catenary of dots. */
  swag(a0: number, b0: number, a1: number, b1: number, z: number, sag: number, n: number): void {
    const c = this.ctx;
    c.beginPath();
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const a = a0 + (a1 - a0) * t;
      const b = b0 + (b1 - b0) * t;
      const zz = z - Math.sin(Math.PI * t) * sag;
      if (i === 0) c.moveTo(this.X(a, b), this.Y(a, b, zz));
      else c.lineTo(this.X(a, b), this.Y(a, b, zz));
    }
    c.strokeStyle = this.th.c(BRASS);
    c.lineWidth = this.lw * 1.6;
    c.stroke();
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const a = a0 + (a1 - a0) * t;
      const b = b0 + (b1 - b0) * t;
      const zz = z - Math.sin(Math.PI * t) * sag;
      c.beginPath();
      c.arc(this.X(a, b), this.Y(a, b, zz), 1.6, 0, Math.PI * 2);
      c.fillStyle = this.th.c(ALABASTER);
      c.fill();
      c.lineWidth = this.lw * 0.8;
      c.strokeStyle = INK;
      c.stroke();
    }
  }
}

// ───────────────────────────── Shops ─────────────────────────────

/** Heights (world px) of the roofline per level, used by banners, ghosts and hit tests. */
export function heightOf(kind: BuildKind, level: number): number {
  const lv = Math.max(1, Math.min(3, level));
  switch (kind) {
    case 'roastery':
      return [16, 28, 40][lv - 1];
    case 'bistro':
      return [16, 28, 32][lv - 1];
    case 'arcade':
      return [20, 28, 36][lv - 1];
    case 'boutique':
      return [20, 32, 44][lv - 1];
    case 'cinema':
      return [24, 34, 44][lv - 1];
    case 'nightmarket':
      return [12, 14, 20][lv - 1];
    case 'park':
      return 8;
    case 'tramstop':
      return 18;
    case 'plaza':
      return 14;
  }
}

function roastery(p: Pen, lv: number, h: HouseTone): number {
  const th = p.th;
  p.box(0.07, 0.1, 0.93, 0.92, 0, 2, th.stone);
  const a0 = 0.13;
  const a1 = 0.87;
  const b0 = 0.17;
  const b1 = 0.85;
  let z = 2;
  for (let s = 0; s < lv; s++) {
    p.box(a0, b0, a1, b1, z, z + 12, th.brick);
    if (s === 0) {
      p.win(0.19, 0.5, z + 2.5, z + 9.5, b1);
      p.door(0.6, 0.74, z, z + 9.5, b1);
      p.winSide(0.28, 0.5, z + 3, z + 9, a1);
      p.winSide(0.58, 0.76, z + 3, z + 9, a1);
    } else {
      p.winRow(0.18, 0.82, 3, z + 3, z + 9, b1);
      p.winRowSide(0.26, 0.76, 2, z + 3, z + 9, a1);
    }
    z += 12;
  }
  p.awning(0.15, 0.8, 13.5, b1, 0.1, 3.4, h.color, ALABASTER, 5);
  p.cornice(a0, b0, a1, b1, z);
  z += 1.8;
  if (lv === 3) {
    p.box(0.22, 0.28, 0.5, 0.58, z, z + 5, th.stone);
    p.winRow(0.24, 0.48, 2, z + 1.5, z + 4, 0.58);
  } else p.top(0.17, 0.21, 0.83, 0.81, z, mix(th.stone.top, TRAVERTINE_DEEP, 0.4), true);
  // The roaster stack: copper, banded.
  const cop = th.m('#C07A4E', 0.25, 0.22);
  const top = z + 7 + lv * 3;
  p.cyl(0.7, 0.34, 0.07, z - 1, top, cop);
  p.cyl(0.7, 0.34, 0.085, top - 4, top - 2.6, th.brass);
  return top;
}

function bistro(p: Pen, lv: number, h: HouseTone): number {
  const th = p.th;
  p.box(0.07, 0.07, 0.93, 0.66, 0, 2, th.stone);
  // Terrace deck in front with parasols.
  p.box(0.07, 0.66, 0.93, 0.96, 0, 1.4, th.m('#D8C9AA', 0.2, 0.18));
  const a0 = 0.11;
  const a1 = 0.89;
  const b0 = 0.11;
  const b1 = 0.64;
  let z = 2;
  const storeys = lv === 1 ? 1 : 2;
  for (let s = 0; s < storeys; s++) {
    p.box(a0, b0, a1, b1, z, z + 12, th.wall);
    if (s === 0) {
      p.arch(0.17, 0.34, z, z + 7, b1, th.c(GRAPHITE), false);
      p.arch(0.66, 0.83, z, z + 7, b1, th.c(GRAPHITE), false);
      p.door(0.43, 0.57, z, z + 9, b1);
      p.winRowSide(0.2, 0.55, 2, z + 3, z + 8, a1);
    } else {
      p.winRow(0.17, 0.83, 3, z + 3, z + 9, b1);
      p.winRowSide(0.2, 0.55, 2, z + 3, z + 9, a1);
      p.box(0.36, b1, 0.64, b1 + 0.07, z, z + 1, th.stone);
      p.line(INK, 0.9, [0.36, b1 + 0.07, z + 4, 0.64, b1 + 0.07, z + 4]);
    }
    z += 12;
  }
  p.awning(0.38, 0.62, 10.5, b1, 0.11, 3, h.color, ALABASTER, 3);
  if (lv < 3) {
    p.hip(a0 - 0.02, b0 - 0.02, a1 + 0.02, b1 + 0.02, z, 7, 0.17, th.roof);
    p.box(0.66, 0.2, 0.74, 0.28, z + 2, z + 9, th.stone);
    z += 7;
  } else {
    p.cornice(a0, b0, a1, b1, z);
    z += 1.8;
    // Rooftop pergola with string lights.
    for (const [a, b] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.56], [0.8, 0.56]]) p.post(a, b, z, z + 9);
    p.line(INK, 1, [0.2, 0.56, z + 9, 0.8, 0.56, z + 9, 0.8, 0.2, z + 9]);
    p.bulbs(0.2, 0.56, 0.8, 0.56, z + 8, 6);
    z += 9;
  }
  // Parasols on the terrace.
  const spots = lv === 3 ? [0.22, 0.5, 0.78] : [0.28, 0.72];
  const c = p.ctx;
  for (const a of spots) {
    p.post(a, 0.82, 1.4, 11, 1);
    const cx = p.X(a, 0.82);
    const cy = p.Y(a, 0.82, 11);
    c.beginPath();
    c.ellipse(cx, cy, 8.5, 3.4, 0, Math.PI, 0);
    c.closePath();
    c.fillStyle = h.color;
    c.fill();
    c.lineWidth = p.lw;
    c.strokeStyle = INK;
    c.stroke();
  }
  return z;
}

/** Reverse a flat [a, b, z, …] list by triples. */
function rev3(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 3; i >= 0; i -= 3) out.push(pts[i], pts[i + 1], pts[i + 2]);
  return out;
}

function arcade(p: Pen, lv: number, h: HouseTone): number {
  const th = p.th;
  p.box(0.07, 0.1, 0.93, 0.9, 0, 2, th.stone);
  const a0 = 0.11;
  const a1 = 0.89;
  const b0 = 0.14;
  const b1 = 0.86;
  const wall = th.m('#E6DDC6', 0.25, 0.18);
  let z = 2;
  const base = lv === 1 ? 10 : 18;
  p.box(a0, b0, a1, b1, z, z + base, wall);
  // Arcade of arches on the front.
  const n = lv === 1 ? 3 : 4;
  const step = (a1 - a0 - 0.06) / n;
  for (let i = 0; i < n; i++) p.arch(a0 + 0.03 + step * (i + 0.15), a0 + 0.03 + step * (i + 0.85), z, z + base - 4, b1, th.c(GRAPHITE), false);
  p.winRowSide(0.22, 0.78, 3, z + 4, z + base - 3, a1);
  p.front(a0, a1, z + base - 1.2, z + base, b1, h.color);
  z += base;
  if (lv >= 2) {
    p.box(0.18, 0.2, 0.82, 0.8, z, z + 8, wall);
    p.winRow(0.24, 0.76, 4, z + 2.5, z + 6.5, 0.8);
    z += 8;
  }
  // Barrel vault: an arched front gable and a running roof.
  const c = p.ctx;
  const apex = lv === 1 ? 9 : 8;
  const ridge: number[] = [];
  const ridgeBack: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = Math.PI * (i / 10);
    const a = (a0 + a1) / 2 - Math.cos(t) * ((a1 - a0) / 2);
    ridge.push(a, b1, z + Math.sin(t) * apex);
    ridgeBack.push(a, b0, z + Math.sin(t) * apex);
  }
  p.poly(th.roof.top, [...ridge, ...rev3(ridgeBack)]);
  p.poly(th.roof.left, [a0, b1, z, ...ridge, a1, b1, z]);
  for (let i = 1; i < 6; i++) {
    const a = a0 + ((a1 - a0) * i) / 6;
    const zz = z + Math.sin(Math.acos(1 - (2 * i) / 6)) * apex;
    p.line(th.c(TRAVERTINE_DEEP), 0.6, [a, b1, zz, a, b0, zz]);
  }
  // Brass globe finial and, at Level 3, a lantern cupola.
  if (lv === 3) {
    p.box(0.42, 0.4, 0.58, 0.56, z + apex - 1, z + apex + 7, th.stone);
    p.hip(0.4, 0.38, 0.6, 0.58, z + apex + 7, 4, 0.05, th.brass);
    z += apex + 11;
  } else {
    c.beginPath();
    c.arc(p.X(0.5, 0.5), p.Y(0.5, 0.5, z + apex + 3), 2.6, 0, Math.PI * 2);
    c.fillStyle = th.c(BRASS);
    c.fill();
    c.lineWidth = p.lw;
    c.strokeStyle = INK;
    c.stroke();
    z += apex + 3;
  }
  return z;
}

function boutique(p: Pen, lv: number, h: HouseTone): number {
  const th = p.th;
  p.box(0.12, 0.1, 0.88, 0.92, 0, 2, th.stone);
  const a0 = 0.2;
  const a1 = 0.8;
  const b0 = 0.16;
  const b1 = 0.84;
  const wall = th.m('#F1EBDD', 0.22, 0.18);
  let z = 2;
  p.box(a0, b0, a1, b1, z, z + 13, wall);
  // Shopfront: tall glazed pane and door.
  p.win(0.25, 0.5, z + 2, z + 10, b1);
  p.door(0.56, 0.72, z, z + 10.5, b1);
  p.front(a0, a1, z + 11.2, z + 13, b1, h.color);
  p.winRowSide(0.25, 0.75, 2, z + 3, z + 10, a1);
  p.awning(0.23, 0.77, z + 11, b1, 0.1, 3, h.dark, ALABASTER, 4);
  z += 13;
  for (let s = 1; s < lv; s++) {
    p.box(a0, b0, a1, b1, z, z + 11, wall);
    p.winRow(0.25, 0.75, 2, z + 3, z + 9, b1);
    p.winRowSide(0.28, 0.72, 2, z + 3, z + 9, a1);
    if (s === 1) {
      p.box(0.3, b1, 0.7, b1 + 0.06, z, z + 1, th.stone);
      p.line(INK, 0.9, [0.3, b1 + 0.06, z + 3.6, 0.7, b1 + 0.06, z + 3.6]);
    }
    z += 11;
  }
  p.cornice(a0, b0, a1, b1, z);
  z += 1.8;
  if (lv === 3) {
    p.hip(a0, b0, a1, b1, z, 7, 0.12, th.roof);
    p.box(0.4, 0.62, 0.5, 0.74, z + 1, z + 6, th.wall);
    z += 7;
  }
  // Blade sign.
  const blade = h.color;
  p.front(0.8, 0.86, z - 8, z - 1, b1 - 0.02, blade);
  return z + 1;
}

function cinema(p: Pen, lv: number, h: HouseTone): number {
  const th = p.th;
  p.box(0.06, 0.08, 0.94, 0.94, 0, 2, th.stone);
  const a0 = 0.1;
  const a1 = 0.9;
  const b0 = 0.12;
  const b1 = 0.86;
  const wall = th.m('#E8E1D0', 0.22, 0.18);
  const hgt = [20, 30, 38][lv - 1];
  p.box(a0, b0, a1, b1, 2, 2 + hgt, wall);
  // Poster panels and a marquee canopy over the entrance.
  for (let i = 0; i < 3; i++) p.front(0.16 + i * 0.22, 0.28 + i * 0.22, 8, 2 + hgt - 5, b1, th.c(TRAVERTINE_DEEP));
  p.box(0.22, b1, 0.78, b1 + 0.1, 8, 10.5, th.m(INK, 0.45, 0.2));
  p.front(0.26, 0.74, 8.6, 9.9, b1 + 0.1, th.c(BRASS), false);
  p.door(0.4, 0.6, 2, 8, b1);
  p.winRowSide(0.2, 0.8, 3, 7, hgt - 3, a1);
  // Vertical blade sign in House colour.
  p.box(0.82, b1 - 0.04, 0.9, b1 + 0.04, 2, 2 + hgt + 8, th.m(h.color, 0.2, 0.2));
  p.front(0.84, 0.88, 2 + hgt - 6, 2 + hgt + 4, b1 + 0.04, ALABASTER, false);
  let z = 2 + hgt;
  p.cornice(a0, b0, a1, b1, z);
  z += 1.8;
  if (lv >= 2) {
    // Fly-tower behind the screen.
    p.box(0.18, 0.18, 0.62, 0.52, z, z + 9, wall);
    z += 9;
    p.cornice(0.18, 0.18, 0.62, 0.52, z);
    z += 1.8;
  }
  if (lv === 3) {
    p.cyl(0.4, 0.35, 0.1, z, z + 6, th.stone);
    p.cyl(0.4, 0.35, 0.115, z + 6, z + 8, th.brass);
    z += 8;
  }
  return z;
}

function nightmarket(p: Pen, lv: number, h: HouseTone): number {
  const th = p.th;
  const c = p.ctx;
  p.box(0.06, 0.06, 0.94, 0.94, 0, 1.2, th.m('#DCCFB4', 0.18, 0.16));
  const stalls: [number, number][] = [
    [0.2, 0.28],
    [0.6, 0.24],
    [0.34, 0.62],
    [0.74, 0.58],
    [0.2, 0.84],
    [0.62, 0.86],
  ].slice(0, lv === 1 ? 3 : lv === 2 ? 5 : 6) as [number, number][];
  // Back-to-front.
  stalls.sort((x, y) => x[1] + x[0] - (y[1] + y[0]));
  for (const [a, b] of stalls) {
    const w = 0.15;
    const d = 0.1;
    p.box(a - w, b - d, a + w, b + d, 1.2, 5, th.m('#B79A72', 0.2, 0.2));
    // Striped canopy: a lit tilted plane.
    const z = 11;
    for (let i = 0; i < 4; i++) {
      const x0 = a - w - 0.03 + ((w * 2 + 0.06) / 4) * i;
      const x1 = x0 + (w * 2 + 0.06) / 4;
      p.poly(i % 2 ? ALABASTER : h.color, [x0, b - d - 0.02, z, x1, b - d - 0.02, z, x1, b + d + 0.05, z - 3.2, x0, b + d + 0.05, z - 3.2], false);
    }
    p.poly('rgba(0,0,0,0)', [a - w - 0.03, b - d - 0.02, z, a + w + 0.03, b - d - 0.02, z, a + w + 0.03, b + d + 0.05, z - 3.2, a - w - 0.03, b + d + 0.05, z - 3.2]);
    p.post(a - w, b + d, 1.2, z - 3, 0.9);
    p.post(a + w, b + d, 1.2, z - 3, 0.9);
  }
  // String lights across the plot.
  p.bulbs(0.08, 0.5, 0.92, 0.5, 14, 8);
  if (lv === 3) {
    // Central pavilion roof on four posts.
    for (const [a, b] of [[0.4, 0.4], [0.62, 0.4], [0.4, 0.62], [0.62, 0.62]]) p.post(a, b, 1.2, 15, 1.1);
    p.hip(0.34, 0.34, 0.68, 0.68, 15, 5, 0.1, th.roof);
    c.beginPath();
    c.arc(p.X(0.51, 0.51), p.Y(0.51, 0.51, 22), 1.8, 0, Math.PI * 2);
    c.fillStyle = th.c(BRASS);
    c.fill();
    return 22;
  }
  return lv === 2 ? 14 : 12;
}

// ───────────────────────────── Civic ─────────────────────────────

function park(p: Pen, _lv: number, h: HouseTone): number {
  const th = p.th;
  p.box(0.08, 0.08, 0.92, 0.92, 0, 1.4, th.m('#A9BCA4', 0.18, 0.2));
  // Hairline paths.
  p.line(th.c(TRAVERTINE), 2.2, [0.12, 0.5, 1.5, 0.88, 0.5, 1.5]);
  p.line(th.c(TRAVERTINE), 2.2, [0.5, 0.12, 1.5, 0.5, 0.88, 1.5]);
  p.cyl(0.5, 0.5, 0.1, 1.4, 3.2, th.stone);
  p.top(0.45, 0.45, 0.55, 0.55, 3.2, th.c(CANAL), true);
  const trees: [number, number, number][] = [
    [0.24, 0.26, 10],
    [0.76, 0.24, 11],
    [0.26, 0.74, 9],
    [0.76, 0.72, 10],
  ];
  trees.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  for (const [a, b, hh] of trees) p.tree(a, b, 1.4, hh, 6.2);
  // A bench, and a House-coloured lamp finial so the gift reads as owned.
  p.box(0.6, 0.62, 0.78, 0.68, 1.4, 3.4, th.m('#8A6E4E', 0.2, 0.2));
  p.post(0.88, 0.88, 1.4, 11, 1.1);
  p.ctx.beginPath();
  p.ctx.arc(p.X(0.88, 0.88), p.Y(0.88, 0.88, 12), 2.2, 0, Math.PI * 2);
  p.ctx.fillStyle = h.color;
  p.ctx.fill();
  p.ctx.lineWidth = p.lw;
  p.ctx.strokeStyle = INK;
  p.ctx.stroke();
  return 14;
}

function tramstop(p: Pen, _lv: number, h: HouseTone): number {
  const th = p.th;
  p.box(0.08, 0.1, 0.92, 0.9, 0, 2.4, th.stone);
  // Platform edge in brass and a canopy on four posts.
  p.front(0.08, 0.92, 0.2, 1.2, 0.9, th.c(BRASS), false);
  for (const [a, b] of [[0.18, 0.28], [0.82, 0.28], [0.18, 0.74], [0.82, 0.74]]) p.post(a, b, 2.4, 13, 1.1);
  p.box(0.12, 0.22, 0.88, 0.8, 13, 15, th.m('#D5C7A8', 0.2, 0.2));
  p.front(0.12, 0.88, 13, 15, 0.8, h.color);
  p.box(0.3, 0.4, 0.7, 0.5, 2.4, 5.4, th.m('#8A6E4E', 0.2, 0.2));
  // Timetable pylon.
  p.box(0.84, 0.82, 0.9, 0.88, 2.4, 14, th.stone);
  p.front(0.845, 0.895, 8, 12.5, 0.88, ALABASTER);
  return 18;
}

function plaza(p: Pen, _lv: number, h: HouseTone): number {
  const th = p.th;
  p.box(0.07, 0.07, 0.93, 0.93, 0, 1.6, th.m('#E9E1CE', 0.22, 0.18));
  // Paving pattern: hairline diamonds.
  for (let i = 1; i < 6; i++) {
    const t = 0.07 + (0.86 * i) / 6;
    p.line(th.c(TRAVERTINE_DEEP), 0.6, [0.07, t, 1.7, 0.93, t, 1.7]);
    p.line(th.c(TRAVERTINE_DEEP), 0.6, [t, 0.07, 1.7, t, 0.93, 1.7]);
  }
  // Fountain basin and jet.
  p.cyl(0.5, 0.5, 0.2, 1.6, 4.4, th.stone);
  p.cyl(0.5, 0.5, 0.16, 4.2, 4.6, { top: th.c(CANAL), left: th.c(CANAL), right: th.c(CANAL) });
  p.cyl(0.5, 0.5, 0.04, 4.4, 10, th.stone);
  p.line(th.c(ALABASTER), 1.2, [0.5, 0.5, 10, 0.5, 0.56, 6.6]);
  // Colonnade posts at the four corners, brass-capped.
  for (const [a, b] of [[0.14, 0.14], [0.86, 0.14], [0.14, 0.86], [0.86, 0.86]]) {
    p.cyl(a, b, 0.045, 1.6, 12, th.wall);
    p.cyl(a, b, 0.055, 12, 13.4, th.brass);
  }
  // Banner rail in House colour between front posts.
  p.line(h.color, 2, [0.14, 0.86, 11, 0.86, 0.86, 11]);
  return 14;
}

// ───────────────────────────── Fixed scenery ─────────────────────────────

const STUCCO = ['#EDE6D6', '#E7DDC6', '#E2D6BE', '#EFE9DC', '#E5DACB'];

export function townhouse(p: Pen, variant: number): number {
  const th = p.th;
  const wall = th.m(STUCCO[variant % STUCCO.length], 0.22, 0.18);
  p.box(0.12, 0.14, 0.88, 0.86, 0, 2, th.stone);
  const hgt = 16 + (variant % 3) * 4;
  p.box(0.16, 0.18, 0.84, 0.84, 2, 2 + hgt, wall);
  p.winRow(0.22, 0.78, 3, 7, 12, 0.84);
  if (hgt > 16) p.winRow(0.22, 0.78, 3, 16, 20, 0.84);
  p.door(0.42, 0.58, 2, 9, 0.84);
  p.winRowSide(0.28, 0.76, 2, 7, 12, 0.84);
  let z = 2 + hgt;
  if (variant % 2) {
    p.cornice(0.16, 0.18, 0.84, 0.84, z);
    z += 1.8;
  } else {
    p.gable(0.14, 0.16, 0.86, 0.86, z, 7, th.roof);
    z += 7;
  }
  return z;
}

export function station(p: Pen): number {
  const th = p.th;
  // Spans two tiles: a ∈ 0..2 (the origin tile is the western one).
  p.box(0.05, 0.08, 1.95, 0.94, 0, 2, th.stone);
  const wall = th.m('#E9E1CE', 0.25, 0.18);
  p.box(0.1, 0.14, 1.9, 0.86, 2, 16, wall);
  // Side wings' windows.
  p.winRow(0.16, 0.6, 3, 7, 14, 0.86);
  p.winRow(1.4, 1.84, 3, 7, 14, 0.86);
  p.winRowSide(0.2, 0.8, 3, 7, 14, 1.9);
  // Central hall with a great arched portal.
  p.box(0.62, 0.14, 1.38, 0.86, 16, 26, wall);
  p.arch(0.76, 1.24, 2, 12, 0.86, th.c(GRAPHITE), true);
  p.line(th.c(BRASS), 1.4, [0.76, 0.86, 12, 1.24, 0.86, 12]);
  p.front(0.62, 1.38, 22.6, 26, 0.86, th.c(BRASS), true);
  // Clock tower over the hall.
  p.box(0.86, 0.34, 1.14, 0.66, 26, 44, wall);
  const c = p.ctx;
  const cx = p.X(1.0, 0.66);
  const cy = p.Y(1.0, 0.66, 36);
  c.beginPath();
  c.arc(cx, cy, 5.4, 0, Math.PI * 2);
  c.fillStyle = ALABASTER;
  c.fill();
  c.lineWidth = p.lw;
  c.strokeStyle = INK;
  c.stroke();
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx, cy - 3.8);
  c.moveTo(cx, cy);
  c.lineTo(cx + 2.6, cy + 1);
  c.lineWidth = p.lw * 1.1;
  c.stroke();
  p.hip(0.82, 0.3, 1.18, 0.7, 44, 12, 0.12, th.brass);
  // Wing parapets.
  p.cornice(0.1, 0.14, 0.62, 0.86, 16);
  p.cornice(1.38, 0.14, 1.9, 0.86, 16);
  return 56;
}

export function garden(p: Pen): number {
  const th = p.th;
  p.box(0.08, 0.08, 0.92, 0.92, 0, 1.4, th.m('#A9BCA4', 0.18, 0.2));
  p.line(th.c(TRAVERTINE), 2, [0.1, 0.5, 1.5, 0.9, 0.5, 1.5]);
  p.line(th.c(TRAVERTINE), 2, [0.5, 0.1, 1.5, 0.5, 0.9, 1.5]);
  p.cyl(0.5, 0.5, 0.11, 1.4, 3.4, th.stone);
  p.top(0.45, 0.45, 0.55, 0.55, 3.4, th.c(CANAL), true);
  // Clipped hedges along the back, trees at the corners.
  p.box(0.12, 0.12, 0.88, 0.2, 1.4, 5, th.sage);
  p.box(0.12, 0.2, 0.2, 0.88, 1.4, 5, th.sage);
  p.tree(0.76, 0.34, 1.4, 11, 6);
  p.tree(0.3, 0.76, 1.4, 10, 5.6);
  p.tree(0.78, 0.78, 1.4, 9, 5);
  return 16;
}

/** A vacant lot: sage turf in a hairline kerb with a lease stake. */
export function vacantStake(p: Pen): void {
  p.line(p.th.c(GRAPHITE), 0.9, [0.8, 0.8, 0, 0.8, 0.8, 7]);
  p.poly(ALABASTER, [0.8, 0.8, 7, 0.8, 0.8, 4.4, 0.7, 0.8, 4.4, 0.7, 0.8, 7], true, 0.8);
}

// ───────────────────────────── Dispatcher ─────────────────────────────

/** Draw the building art for a kind/level on a lot. Returns the roofline z (for the banner anchor). */
export function drawBuildingArt(p: Pen, kind: BuildKind, level: number, h: HouseTone): number {
  const lv = Math.max(1, Math.min(3, level));
  switch (kind) {
    case 'roastery':
      return roastery(p, lv, h);
    case 'bistro':
      return bistro(p, lv, h);
    case 'arcade':
      return arcade(p, lv, h);
    case 'boutique':
      return boutique(p, lv, h);
    case 'cinema':
      return cinema(p, lv, h);
    case 'nightmarket':
      return nightmarket(p, lv, h);
    case 'park':
      return park(p, lv, h);
    case 'tramstop':
      return tramstop(p, lv, h);
    case 'plaza':
      return plaza(p, lv, h);
  }
}

// ───────────────────────────── Banner ─────────────────────────────

/**
 * A still banner: ink pole, House-colour swallow-tail cloth with deep-trim edge and an inset
 * crest medallion. (x, y) is the pole foot in world px.
 */
export function drawBanner(ctx: CanvasRenderingContext2D, house: number, x: number, y: number, s: number, lw: number, level: number): void {
  const h = houseTone(house);
  const pole = 30 * s;
  const w = 17 * s;
  const fh = 21 * s;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - pole);
  ctx.strokeStyle = INK;
  ctx.lineWidth = lw * 1.2;
  ctx.lineCap = 'round';
  ctx.stroke();
  // Cloth hangs from the top of the pole toward the south-west (left of the pole reads as the lit side).
  const top = y - pole + 1 * s;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x + w, top);
  ctx.lineTo(x + w, top + fh);
  ctx.lineTo(x + w / 2, top + fh - 4 * s);
  ctx.lineTo(x, top + fh);
  ctx.closePath();
  ctx.fillStyle = h.color;
  ctx.fill();
  ctx.lineWidth = lw * 1.6;
  ctx.strokeStyle = h.dark;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineWidth = lw;
  ctx.strokeStyle = INK;
  ctx.stroke();
  drawCrest(ctx, house, x + w / 2, top + 8.6 * s, 9.4 * s, { medallion: true });
  // Level pips under the crest.
  for (let i = 0; i < level; i++) {
    ctx.beginPath();
    ctx.arc(x + w / 2 + (i - (level - 1) / 2) * 3.8 * s, top + fh - 8.2 * s + (level > 0 ? 0 : 0), 1.1 * s, 0, Math.PI * 2);
    ctx.fillStyle = ALABASTER;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y - pole, 1.8 * s, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();
}

// ───────────────────────────── Units ─────────────────────────────

export interface TokenOpts {
  kind: UnitKind;
  house: number;
  /** Foot of the token in world px. */
  x: number;
  y: number;
  s: number; // token scale
  lw: number;
  cohesion: number;
  maxCohesion: number;
  ghost?: boolean;
  /** Barge hull orientation: true = along the tile's y axis (the canal runs north-south). */
  alongY?: boolean;
  th: Theme;
}

/** Total token height (world px at s = 1) for hit testing. */
export const TOKEN_H = 34;

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, thick: number, th: Theme, lw: number, ghost: boolean): void {
  ctx.setLineDash(ghost ? [3 * lw, 2.5 * lw] : []);
  ctx.beginPath();
  ctx.ellipse(x, y + thick, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = ghost ? 'rgba(247,244,238,0.7)' : th.c(TRAVERTINE_DEEP);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(x - rx, y, rx * 2, thick);
  ctx.fillStyle = ghost ? 'rgba(247,244,238,0.7)' : th.c(TRAVERTINE_DEEP);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = ghost ? 'rgba(247,244,238,0.7)' : th.c('#F1EBDD');
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawToken(ctx: CanvasRenderingContext2D, o: TokenOpts): void {
  const { x, y, s, lw, th } = o;
  const h = houseTone(o.house);
  ctx.save();
  if (o.ghost) ctx.globalAlpha = 0.62;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  disc(ctx, x, y, 14 * s, 7 * s, 2.4 * s, th, lw, !!o.ghost);
  const by = y - 1; // body foot
  if (o.kind === 'factor') {
    const w = 5.6 * s;
    const hgt = 25 * s;
    // Column body: left lit, right shaded.
    ctx.beginPath();
    ctx.moveTo(x - w, by);
    ctx.lineTo(x - w, by - hgt);
    ctx.lineTo(x + w, by - hgt);
    ctx.lineTo(x + w, by);
    ctx.ellipse(x, by, w, w * 0.5, 0, 0, Math.PI);
    ctx.closePath();
    ctx.fillStyle = h.color;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + w * 0.2, by + w * 0.49);
    ctx.lineTo(x + w * 0.2, by - hgt);
    ctx.lineTo(x + w, by - hgt);
    ctx.lineTo(x + w, by);
    ctx.ellipse(x, by, w, w * 0.5, 0, 0, Math.acos(0.2));
    ctx.closePath();
    ctx.fillStyle = h.dark;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - w, by - hgt);
    ctx.lineTo(x - w, by);
    ctx.ellipse(x, by, w, w * 0.5, 0, Math.PI, 0, true);
    ctx.lineTo(x + w, by - hgt);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.stroke();
    // Capital.
    ctx.beginPath();
    ctx.ellipse(x, by - hgt, w, w * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = h.light;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, by - hgt - 3.2 * s, 3.1 * s, 0, Math.PI * 2);
    ctx.fillStyle = th.c('#F1EBDD');
    ctx.fill();
    ctx.stroke();
    drawCrest(ctx, o.house, x, by - hgt * 0.5, 10.5 * s, { medallion: false });
  } else if (o.kind === 'watch') {
    // A block seen from the south-east, its south face shield-shaped.
    const hw = 9.5 * s;
    const hd = 4.8 * s;
    const hgt = 21 * s;
    const lx = x - hw;
    const rx = x + hw;
    ctx.beginPath();
    ctx.moveTo(lx, by - hd * 0.0);
    ctx.lineTo(x, by + hd);
    ctx.lineTo(x, by + hd - hgt);
    ctx.lineTo(lx, by - hgt);
    ctx.closePath();
    ctx.fillStyle = h.color;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, by + hd);
    ctx.lineTo(rx, by);
    ctx.lineTo(rx, by - hgt);
    ctx.lineTo(x, by + hd - hgt);
    ctx.closePath();
    ctx.fillStyle = h.dark;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(lx, by - hgt);
    ctx.lineTo(x, by + hd - hgt);
    ctx.lineTo(rx, by - hgt);
    ctx.lineTo(x, by - hgt - hd);
    ctx.closePath();
    ctx.fillStyle = h.light;
    ctx.fill();
    ctx.stroke();
    // Shield face centred on the lit south-west face.
    drawCrest(ctx, o.house, x - hw / 2, by + hd * 0.5 - hgt * 0.5, 15 * s, { medallion: false });
    // Cohesion pips above the block.
    const n = Math.max(1, o.maxCohesion);
    for (let i = 0; i < n; i++) {
      const px = x + (i - (n - 1) / 2) * 6.2 * s;
      const py = by - hgt - hd - 5.5 * s;
      ctx.beginPath();
      ctx.arc(px, py, 2.4 * s, 0, Math.PI * 2);
      ctx.fillStyle = i < o.cohesion ? INK : ALABASTER;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }
  } else {
    // Barge: a low hull riding on the water, a cabin, and a mast with a pennant crest.
    const L = 15 * s;
    const hl = o.alongY ? { dx: -1, dy: 0.5 } : { dx: 1, dy: 0.5 };
    const ux = hl.dx * L * 0.78;
    const uy = hl.dy * L * 0.78;
    const wx = (o.alongY ? 4.4 : -4.4) * s;
    const wy = 2.2 * s;
    const hull = (z: number): [number, number][] => [
      [x - ux - wx, by - uy - wy - z],
      [x + ux - wx, by + uy - wy - z],
      [x + ux * 1.18, by + uy * 1.18 - z],
      [x + ux + wx, by + uy + wy - z],
      [x - ux + wx, by - uy + wy - z],
      [x - ux * 1.18, by - uy * 1.18 - z],
    ];
    const lo = hull(0);
    const hi = hull(5.2 * s);
    ctx.beginPath();
    ctx.moveTo(lo[2][0], lo[2][1]);
    ctx.lineTo(lo[3][0], lo[3][1]);
    ctx.lineTo(lo[4][0], lo[4][1]);
    ctx.lineTo(lo[5][0], lo[5][1]);
    ctx.lineTo(hi[5][0], hi[5][1]);
    ctx.lineTo(hi[4][0], hi[4][1]);
    ctx.lineTo(hi[3][0], hi[3][1]);
    ctx.lineTo(hi[2][0], hi[2][1]);
    ctx.closePath();
    ctx.fillStyle = h.color;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.beginPath();
    hi.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
    ctx.closePath();
    ctx.fillStyle = h.light;
    ctx.fill();
    ctx.stroke();
    // Deck, cabin and mast.
    const cz = 5.2 * s;
    const cabW = 6.2 * s;
    ctx.beginPath();
    ctx.rect(x - cabW / 2, by - cz - 8 * s, cabW, 8 * s);
    ctx.fillStyle = th.c('#F1EBDD');
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - cabW / 2 - 1.2 * s, by - cz - 8 * s);
    ctx.lineTo(x + cabW / 2 + 1.2 * s, by - cz - 8 * s);
    ctx.lineTo(x, by - cz - 11.5 * s);
    ctx.closePath();
    ctx.fillStyle = h.dark;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 5.6 * s, by - cz + 1);
    ctx.lineTo(x + 5.6 * s, by - 29 * s);
    ctx.stroke();
    drawCrest(ctx, o.house, x + 5.6 * s + 5.6 * s, by - 24.5 * s, 9 * s, { medallion: false });
  }
  ctx.restore();
}

// ───────────────────────────── Citizens ─────────────────────────────

const CITIZEN_WASH = ['#9AA3AB', '#C9B79A', '#C58E73', '#7FAEB6', '#5E5967'];

/** An ink-and-wash standing figure. Archetype order: commuter, local, foodie, tourist, night owl. */
export function drawCitizen(ctx: CanvasRenderingContext2D, th: Theme, arch: number, x: number, y: number, s: number, lw: number): void {
  const wash = th.c(CITIZEN_WASH[arch % 5]);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = lw * 0.9;
  ctx.strokeStyle = INK;
  const hgt = (arch === 0 ? 13.5 : arch === 4 ? 13 : 12) * s;
  const bw = (arch === 2 ? 3.4 : arch === 4 ? 3 : 2.5) * s;
  // Shadow wash.
  ctx.beginPath();
  ctx.ellipse(x, y, bw * 1.5, bw * 0.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(22,19,15,0.14)';
  ctx.fill();
  // Body.
  ctx.beginPath();
  if (arch === 4) {
    // Cloak to the ground.
    ctx.moveTo(x - bw * 1.2, y);
    ctx.lineTo(x - bw * 0.6, y - hgt * 0.7);
    ctx.lineTo(x + bw * 0.6, y - hgt * 0.7);
    ctx.lineTo(x + bw * 1.2, y);
  } else {
    ctx.moveTo(x - bw * 0.7, y);
    ctx.lineTo(x - bw, y - hgt * 0.68);
    ctx.lineTo(x + bw, y - hgt * 0.68);
    ctx.lineTo(x + bw * 0.7, y);
  }
  ctx.closePath();
  ctx.fillStyle = wash;
  ctx.fill();
  ctx.stroke();
  // Head.
  const hr = 1.9 * s;
  const hy = y - hgt + hr;
  ctx.beginPath();
  ctx.arc(x, hy, hr, 0, Math.PI * 2);
  ctx.fillStyle = th.c('#F1E4D2');
  ctx.fill();
  ctx.stroke();
  if (arch === 0) {
    // Briefcase.
    ctx.beginPath();
    ctx.rect(x + bw * 0.9, y - hgt * 0.32, 2.6 * s, 2 * s);
    ctx.fillStyle = INK;
    ctx.fill();
  } else if (arch === 2) {
    // Toque.
    ctx.beginPath();
    ctx.rect(x - hr * 0.8, hy - hr * 2, hr * 1.6, hr * 1.1);
    ctx.fillStyle = ALABASTER;
    ctx.fill();
    ctx.stroke();
  } else if (arch === 3) {
    // Sun-hat brim and a satchel.
    ctx.beginPath();
    ctx.ellipse(x, hy - hr * 0.6, hr * 2, hr * 0.7, 0, 0, Math.PI * 2);
    ctx.fillStyle = th.c('#E8D9B0');
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(x - bw - 2.2 * s, y - hgt * 0.5, 2.2 * s, 2.6 * s);
    ctx.fillStyle = th.c(TERRACOTTA);
    ctx.fill();
    ctx.stroke();
  } else if (arch === 4) {
    // Tall hat.
    ctx.beginPath();
    ctx.rect(x - hr * 0.9, hy - hr * 2.4, hr * 1.8, hr * 1.5);
    ctx.fillStyle = INK;
    ctx.fill();
  }
}

/** Short hairline tally (groups of five, struck through) for lost demand, anchored at its start. */
export function drawTally(ctx: CanvasRenderingContext2D, n: number, x: number, y: number, s: number, lw: number): void {
  const cap = Math.min(15, n);
  ctx.strokeStyle = INK;
  ctx.lineWidth = lw * 0.9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  let cx = x;
  let k = 0;
  while (k < cap) {
    const g = Math.min(5, cap - k);
    const bars = Math.min(4, g);
    for (let i = 0; i < bars; i++) {
      ctx.moveTo(cx + i * 2.1 * s, y);
      ctx.lineTo(cx + i * 2.1 * s - 0.8 * s, y - 7 * s);
    }
    if (g === 5) {
      ctx.moveTo(cx - 1.8 * s, y - 1.2 * s);
      ctx.lineTo(cx + 7.6 * s, y - 5.8 * s);
    }
    cx += 10.6 * s;
    k += g;
  }
  ctx.stroke();
}

// ───────────────────────────── Era, events, pier ─────────────────────────────

export function drawLamp(p: Pen, a: number, b: number, brass: boolean): void {
  const th = p.th;
  p.post(a, b, 0, 15, 1.3);
  p.ctx.beginPath();
  p.ctx.arc(p.X(a, b), p.Y(a, b, 16.5), 2.7, 0, Math.PI * 2);
  p.ctx.fillStyle = brass ? th.c(BRASS) : th.c(ALABASTER);
  p.ctx.fill();
  p.ctx.lineWidth = p.lw;
  p.ctx.strokeStyle = INK;
  p.ctx.stroke();
  p.ctx.beginPath();
  p.ctx.moveTo(p.X(a, b) - 2.4, p.Y(a, b, 19.4));
  p.ctx.lineTo(p.X(a, b) + 2.4, p.Y(a, b, 19.4));
  p.ctx.lineTo(p.X(a, b), p.Y(a, b, 21.6));
  p.ctx.closePath();
  p.ctx.fillStyle = th.c(BRASS);
  p.ctx.fill();
  p.ctx.stroke();
}

/** A still line of pennants strung between two points at height z. */
export function drawPennantLine(p: Pen, a0: number, b0: number, a1: number, b1: number, z: number, n: number, seed: number): void {
  const th = p.th;
  const tones = [TERRACOTTA, BRASS, SAGE, ALABASTER, CANAL];
  const ctx = p.ctx;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    pts.push([p.X(a0 + (a1 - a0) * t, b0 + (b1 - b0) * t), p.Y(a0 + (a1 - a0) * t, b0 + (b1 - b0) * t, z - Math.sin(Math.PI * t) * 3.2)]);
  }
  ctx.beginPath();
  pts.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
  ctx.strokeStyle = INK;
  ctx.lineWidth = p.lw * 0.9;
  ctx.stroke();
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const k = Math.min(13, Math.round(t * 14));
    const [x, y] = pts[k];
    ctx.beginPath();
    ctx.moveTo(x - 2.6, y);
    ctx.lineTo(x + 2.6, y);
    ctx.lineTo(x, y + 6.2);
    ctx.closePath();
    ctx.fillStyle = th.c(tones[(i + seed) % tones.length]);
    ctx.fill();
    ctx.lineWidth = p.lw * 0.8;
    ctx.stroke();
  }
}

/** A still passenger ferry (Era III): a white hull with a brass-trimmed awning. */
export function drawFerry(ctx: CanvasRenderingContext2D, th: Theme, x: number, y: number, s: number, lw: number, alongY: boolean): void {
  const dx = alongY ? -1 : 1;
  const L = 17 * s;
  const w = 4.6 * s;
  const sx = alongY ? 1 : -1;
  const A = [x - dx * L, y - 0.5 * L];
  const B = [x + dx * L, y + 0.5 * L];
  const off = [sx * w, 0.5 * w];
  ctx.lineJoin = 'round';
  const poly = (pts: number[][], fill: string): void => {
    ctx.beginPath();
    pts.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.stroke();
  };
  const lift = (pt: number[], z: number): number[] => [pt[0], pt[1] - z];
  const P1 = [A[0] - off[0], A[1] - off[1]];
  const P2 = [B[0] - off[0], B[1] - off[1]];
  const P3 = [B[0] + off[0], B[1] + off[1]];
  const P4 = [A[0] + off[0], A[1] + off[1]];
  poly([P1, P2, P3, P4].map((q) => lift(q, 0)), th.c('#EFE9DB'));
  poly([lift(P4, 0), lift(P3, 0), lift(P3, 5 * s), lift(P4, 5 * s)], th.c(ALABASTER));
  poly([lift(P1, 6 * s), lift(P2, 6 * s), lift(P3, 6 * s), lift(P4, 6 * s)], th.c('#F6F1E4'));
  // Awning in brass over the saloon.
  poly([lift([x - dx * L * 0.6 - off[0], y - 0.3 * L - off[1]], 12 * s), lift([x + dx * L * 0.6 - off[0], y + 0.3 * L - off[1]], 12 * s), lift([x + dx * L * 0.6 + off[0], y + 0.3 * L + off[1]], 12 * s), lift([x - dx * L * 0.6 + off[0], y - 0.3 * L + off[1]], 12 * s)], th.c(BRASS));
  ctx.beginPath();
  ctx.moveTo(x - dx * L * 0.5, y - 0.25 * L - 6 * s);
  ctx.lineTo(x - dx * L * 0.5, y - 0.25 * L - 12 * s);
  ctx.moveTo(x + dx * L * 0.5, y + 0.25 * L - 6 * s);
  ctx.lineTo(x + dx * L * 0.5, y + 0.25 * L - 12 * s);
  ctx.stroke();
}

/** A berthed cruise liner (Harbor Cruise): drawn in the lot frame of its berth. */
export function drawLiner(p: Pen): void {
  const th = p.th;
  // Hull: a long white box with a dark waterline band, brass sheer stripe.
  p.box(0.0, 0.2, 2.5, 0.78, -2, 7, th.m('#F1ECDF', 0.2, 0.18));
  p.front(0.0, 2.5, -2, 1.5, 0.78, th.c(GRAPHITE), false);
  p.front(0.0, 2.5, 5.2, 6.2, 0.78, th.c(BRASS), false);
  p.winRow(0.1, 2.4, 14, 2.2, 4.2, 0.78);
  // Two decks, bridge, and funnel.
  p.box(0.25, 0.3, 2.2, 0.7, 7, 12, th.m('#EFE9DB', 0.2, 0.17));
  p.winRow(0.3, 2.15, 10, 8.4, 10.6, 0.7);
  p.box(0.55, 0.36, 1.7, 0.64, 12, 16, th.m('#EFE9DB', 0.2, 0.17));
  p.box(0.85, 0.4, 1.2, 0.6, 16, 19, th.m('#EFE9DB', 0.2, 0.17));
  p.cyl(1.55, 0.5, 0.1, 16, 24, th.m(TERRACOTTA, 0.2, 0.22));
  p.cyl(1.55, 0.5, 0.11, 21, 22.6, th.m('#16130F', 0.2, 0.1));
  p.cyl(0.65, 0.5, 0.1, 16, 24, th.m(TERRACOTTA, 0.2, 0.22));
  p.cyl(0.65, 0.5, 0.11, 21, 22.6, th.m('#16130F', 0.2, 0.1));
  // Gangway to the pier.
  p.poly(th.c('#CBB89A'), [0.0, 0.5, 6, 0.0, 0.62, 6, -0.35, 0.62, 1, -0.35, 0.5, 1]);
}

/** Harbor Pier: a plank deck on piles, with a harbor-master's hut. Drawn in world tile coordinates. */
export function drawPier(ctx: CanvasRenderingContext2D, th: Theme, lw: number): void {
  const wood = th.m('#B79A72', 0.2, 0.2);
  const X = (x: number, y: number): number => (x - y) * HW;
  const Y = (x: number, y: number, z: number): number => (x + y) * HH - z;
  const poly = (fill: string, pts: number[], outline = true): void => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 3) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(pts[i], pts[i + 1]), Y(pts[i], pts[i + 1], pts[i + 2]));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (outline) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = INK;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  };
  const x0 = 3.2;
  const x1 = 3.8;
  const y0 = 12;
  const y1 = 13.35;
  const zt = -0.6;
  // Piles.
  for (let y = y0 + 0.2; y < y1; y += 0.4) {
    for (const x of [x0 + 0.04, x1 - 0.04]) {
      ctx.beginPath();
      ctx.moveTo(X(x, y), Y(x, y, zt));
      ctx.lineTo(X(x, y), Y(x, y, -7));
      ctx.strokeStyle = INK;
      ctx.lineWidth = lw * 1.6;
      ctx.stroke();
    }
  }
  poly(wood.left, [x0, y1, zt, x1, y1, zt, x1, y1, zt - 1.6, x0, y1, zt - 1.6]);
  poly(wood.right, [x1, y0, zt, x1, y1, zt, x1, y1, zt - 1.6, x1, y0, zt - 1.6]);
  poly(wood.top, [x0, y0, zt, x1, y0, zt, x1, y1, zt, x0, y1, zt]);
  ctx.strokeStyle = th.c(GRAPHITE);
  ctx.lineWidth = lw * 0.6;
  ctx.beginPath();
  for (let y = y0 + 0.15; y < y1; y += 0.15) {
    ctx.moveTo(X(x0, y), Y(x0, y, zt));
    ctx.lineTo(X(x1, y), Y(x1, y, zt));
  }
  ctx.stroke();
  // Harbor-master's hut at the pier head.
  const hut = th.wall;
  const hx0 = 3.3;
  const hx1 = 3.72;
  const hy0 = 12.9;
  const hy1 = 13.28;
  poly(hut.right, [hx1, hy0, zt, hx1, hy1, zt, hx1, hy1, 8, hx1, hy0, 8]);
  poly(hut.left, [hx0, hy1, zt, hx1, hy1, zt, hx1, hy1, 8, hx0, hy1, 8]);
  poly(th.roof.top, [hx0 - 0.04, hy0 - 0.04, 8, hx1 + 0.04, hy0 - 0.04, 8, hx1 + 0.04, hy1 + 0.04, 8, hx0 - 0.04, hy1 + 0.04, 8]);
  poly(th.c(GRAPHITE), [hx0 + 0.1, hy1, 2.4, hx0 + 0.24, hy1, 2.4, hx0 + 0.24, hy1, 5.6, hx0 + 0.1, hy1, 5.6], false);
}

/** Door tile hint: which face the shop's facade is on. */
export const isShopKind = (k: BuildKind): k is ShopKind => k !== 'park' && k !== 'tramstop' && k !== 'plaza';
