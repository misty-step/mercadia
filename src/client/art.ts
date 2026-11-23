// Isometric architecture for MERCADIA. Everything is drawn as flat tonal solids, no outlines.
// A Pen draws in tile-local coordinates (u, v ∈ 0..1 across the lot, z in world px) and can
// mirror a design so its front faces whichever street the lot opens onto.
import { HOUSES } from '../shared/constants';
import type { BuildKind } from '../shared/types';

export const HW = 32; // half tile width
export const HH = 16; // half tile height

// ───────────────────────────── Colour ─────────────────────────────

const shadeCache = new Map<string, string>();
/** Lighten (f > 0) or darken (f < 0) a hex colour. */
export function shade(hex: string, f: number): string {
  const key = hex + f;
  const hit = shadeCache.get(key);
  if (hit) return hit;
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (f >= 0) {
    r += (255 - r) * f;
    g += (255 - g) * f;
    b += (255 - b) * f;
  } else {
    // Darken toward a warm umber rather than black: shadows stay sunny.
    r = r * (1 + f) + 58 * -f * 0.35;
    g = g * (1 + f) + 40 * -f * 0.35;
    b = b * (1 + f) + 52 * -f * 0.35;
  }
  const out = '#' + ((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1);
  shadeCache.set(key, out);
  return out;
}

export interface Mat {
  top: string;
  left: string;
  right: string;
}
const matCache = new Map<string, Mat>();
export function mat(base: string, topUp = 0.12, rightDown = 0.17): Mat {
  const key = base + topUp + rightDown;
  let m = matCache.get(key);
  if (!m) {
    m = { top: shade(base, topUp), left: base, right: shade(base, -rightDown) };
    matCache.set(key, m);
  }
  return m;
}

export const C = {
  travertine: '#EFE9DC',
  paving: '#E4DBC8',
  pavingDark: '#D3C8B1',
  stone: '#D6CCB8',
  stoneDark: '#B9AD96',
  terracotta: '#C86443',
  sage: '#84A98C',
  sageDark: '#5F8A6C',
  sageLight: '#A3C3A4',
  canal: '#3E8E9E',
  canalDeep: '#2F7483',
  canalLight: '#7FBCC6',
  slate: '#464B57',
  slateLight: '#5A606D',
  lane: '#6A6660',
  brass: '#D4A34A',
  brassDark: '#A77A2C',
  ink: '#1E1A16',
  cream: '#F7EFDF',
  wood: '#8E6040',
  woodDark: '#62412B',
  glass: '#4A626B',
  glassDark: '#394E57',
  lit: '#FFD98A',
};

const ROOF = mat(C.terracotta, 0.14, 0.2);
const STONE = mat(C.stone);
const WOOD = mat(C.wood);
const BRASS = mat(C.brass, 0.25, 0.22);

export interface HouseTone {
  color: string;
  dark: string;
  light: string;
}
export const houseTone = (i: number): HouseTone =>
  i >= 0 && i < HOUSES.length ? HOUSES[i] : { color: '#9A8F80', dark: '#766C5F', light: '#CFC6B8' };

// ───────────────────────────── Pen ─────────────────────────────

export class Pen {
  flip = false;
  light = false; // true while drawing the night light pass
  seed = 1;
  private wi = 0;
  /** Plot scale about the lot's centre: civic projects are drawn inside the House kerb. */
  private k = 1;

  constructor(public ctx: CanvasRenderingContext2D) {}

  begin(flip: boolean, light: boolean, seed: number): void {
    this.flip = flip;
    this.light = light;
    this.seed = seed;
    this.wi = 0;
    this.k = 1;
  }

  /** Shrink everything that follows toward the centre of the lot (1 = the whole tile). */
  plot(k: number): void {
    this.k = k;
  }

  X(u: number, v: number): number {
    return (this.flip ? v - u : u - v) * HW * this.k;
  }
  Y(u: number, v: number, z: number): number {
    return (1 + (u + v - 1) * this.k) * HH - z;
  }

  private trace(pts: number[]): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(this.X(pts[0], pts[1]), this.Y(pts[0], pts[1], pts[2]));
    for (let i = 3; i < pts.length; i += 3) c.lineTo(this.X(pts[i], pts[i + 1]), this.Y(pts[i], pts[i + 1], pts[i + 2]));
    c.closePath();
  }

  /** Filled polygon from flat [u, v, z, …]. Body pass only. */
  poly(fill: string, pts: number[]): void {
    if (this.light) return;
    this.trace(pts);
    this.ctx.fillStyle = fill;
    this.ctx.fill();
  }

  /** Polygon drawn only in the light pass. */
  lightPoly(fill: string, pts: number[], alpha = 1): void {
    if (!this.light) return;
    this.trace(pts);
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = fill;
    this.ctx.fill();
    this.ctx.globalAlpha = 1;
  }

  line(stroke: string, width: number, pts: number[]): void {
    if (this.light) return;
    const c = this.ctx;
    c.beginPath();
    c.moveTo(this.X(pts[0], pts[1]), this.Y(pts[0], pts[1], pts[2]));
    for (let i = 3; i < pts.length; i += 3) c.lineTo(this.X(pts[i], pts[i + 1]), this.Y(pts[i], pts[i + 1], pts[i + 2]));
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.stroke();
  }

  frontC(m: Mat): string {
    return this.flip ? m.right : m.left;
  }
  sideC(m: Mat): string {
    return this.flip ? m.left : m.right;
  }

  top(u0: number, v0: number, u1: number, v1: number, z: number, fill: string): void {
    this.poly(fill, [u0, v0, z, u1, v0, z, u1, v1, z, u0, v1, z]);
  }
  /** Rectangle on the front plane (constant v). */
  front(u0: number, u1: number, z0: number, z1: number, v: number, fill: string): void {
    this.poly(fill, [u0, v, z0, u1, v, z0, u1, v, z1, u0, v, z1]);
  }
  /** Rectangle on the side plane (constant u). */
  side(v0: number, v1: number, z0: number, z1: number, u: number, fill: string): void {
    this.poly(fill, [u, v0, z0, u, v1, z0, u, v1, z1, u, v0, z1]);
  }

  box(u0: number, v0: number, u1: number, v1: number, z0: number, z1: number, m: Mat): void {
    if (this.light) return;
    this.side(v0, v1, z0, z1, u1, this.sideC(m));
    this.front(u0, u1, z0, z1, v1, this.frontC(m));
    this.top(u0, v0, u1, v1, z1, m.top);
  }

  private isLit(): boolean {
    this.wi++;
    let h = (this.seed * 2654435761 + this.wi * 40503) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
    return h % 100 < 72;
  }

  /** Window on the front plane. Dark glass by day; warm in the light pass. */
  win(u0: number, u1: number, z0: number, z1: number, v: number, always = false): void {
    const pts = [u0, v, z0, u1, v, z0, u1, v, z1, u0, v, z1];
    if (this.light) {
      if (this.isLit() || always) this.lightPoly(C.lit, pts, 0.95);
      return;
    }
    this.poly(this.flip ? C.glassDark : C.glass, pts);
    // A sliver of sky reflection.
    this.poly('rgba(255,255,255,0.16)', [u0, v, z1, u0 + (u1 - u0) * 0.45, v, z1, u0, v, z0 + (z1 - z0) * 0.35]);
  }
  winSide(v0: number, v1: number, z0: number, z1: number, u: number, always = false): void {
    const pts = [u, v0, z0, u, v1, z0, u, v1, z1, u, v0, z1];
    if (this.light) {
      if (this.isLit() || always) this.lightPoly(C.lit, pts, 0.95);
      return;
    }
    this.poly(this.flip ? C.glass : C.glassDark, pts);
    this.poly('rgba(255,255,255,0.12)', [u, v0, z1, u, v0 + (v1 - v0) * 0.45, z1, u, v0, z0 + (z1 - z0) * 0.35]);
  }

  /** Arched opening on the front plane. */
  private archPts(u0: number, u1: number, z0: number, z1: number, v: number): number[] {
    const um = (u0 + u1) / 2;
    const r = (u1 - u0) / 2;
    const pts = [u0, v, z0, u1, v, z0, u1, v, z1];
    for (let i = 1; i < 8; i++) {
      const a = (Math.PI * i) / 8;
      pts.push(um + r * Math.cos(a), v, z1 + r * 30 * Math.sin(a));
    }
    pts.push(u0, v, z1);
    return pts;
  }
  arch(u0: number, u1: number, z0: number, z1: number, v: number, fill?: string): void {
    const pts = this.archPts(u0, u1, z0, z1, v);
    if (fill) {
      this.poly(fill, pts);
      return;
    }
    if (this.light) {
      if (this.isLit()) this.lightPoly(C.lit, pts, 0.95);
      return;
    }
    this.poly(this.flip ? C.glassDark : C.glass, pts);
  }

  /** Disc on the front plane (porthole, clock, sign). */
  round(uc: number, zc: number, r: number, v: number, fill: string, lightToo = false): void {
    const pts: number[] = [];
    for (let i = 0; i < 14; i++) {
      const a = (Math.PI * 2 * i) / 14;
      pts.push(uc + r * Math.cos(a), v, zc + r * 34 * Math.sin(a));
    }
    if (this.light) {
      if (lightToo) this.lightPoly(C.lit, pts, 0.9);
      return;
    }
    this.poly(fill, pts);
  }

  door(u0: number, u1: number, z0: number, z1: number, v: number, fill: string): void {
    this.front(u0, u1, z0, z1, v, fill);
    this.front(u0 + (u1 - u0) * 0.2, u1 - (u1 - u0) * 0.2, z0 + (z1 - z0) * 0.5, z1 - 1.2, v, 'rgba(255,240,210,0.28)');
    if (this.light) this.lightPoly(C.lit, [u0 + 0.01, v, z0 + 4, u1 - 0.01, v, z0 + 4, u1 - 0.01, v, z1 - 1, u0 + 0.01, v, z1 - 1], 0.85);
  }

  /** Striped awning hanging off the front plane. */
  awning(u0: number, u1: number, z: number, v: number, depth: number, drop: number, c1: string, c2: string, n: number): void {
    if (this.light) return;
    const w = (u1 - u0) / n;
    for (let i = 0; i < n; i++) {
      const a = u0 + w * i;
      const b = a + w;
      this.poly(i % 2 ? c2 : c1, [a, v, z, b, v, z, b, v + depth, z - drop, a, v + depth, z - drop]);
    }
    // Valance.
    this.poly(shade(c1, -0.18), [u0, v + depth, z - drop, u1, v + depth, z - drop, u1, v + depth, z - drop - 1.6, u0, v + depth, z - drop - 1.6]);
    this.poly(this.sideC(mat(c1)), [u1, v, z, u1, v + depth, z - drop, u1, v + depth, z - drop - 1.6, u1, v, z - 1.6]);
  }

  /** Gable roof. axis 'u': ridge runs along u, slope faces the front. axis 'v': slope faces the side. */
  gable(u0: number, v0: number, u1: number, v1: number, z: number, h: number, axis: 'u' | 'v', m: Mat, wall: Mat): void {
    if (this.light) return;
    const e = 0.035; // eave overhang
    if (axis === 'u') {
      const vm = (v0 + v1) / 2;
      this.poly(this.sideC(wall), [u1, v0, z, u1, v1, z, u1, vm, z + h]);
      this.poly(this.frontC(m), [u0 - e, v1 + e, z - 1, u1 + e, v1 + e, z - 1, u1 + e, vm, z + h, u0 - e, vm, z + h]);
      for (let k = 1; k <= 2; k++) {
        const t = k / 3;
        this.line(shade(this.frontC(m), -0.12), 0.5, [u0 - e, v1 + e - (v1 + e - vm) * t, z - 1 + (h + 1) * t, u1 + e, v1 + e - (v1 + e - vm) * t, z - 1 + (h + 1) * t]);
      }
      this.line(shade(m.top, 0.1), 0.9, [u0 - e, vm, z + h, u1 + e, vm, z + h]);
    } else {
      const um = (u0 + u1) / 2;
      this.poly(this.frontC(wall), [u0, v1, z, u1, v1, z, um, v1, z + h]);
      this.poly(this.sideC(m), [u1 + e, v0 - e, z - 1, u1 + e, v1 + e, z - 1, um, v1 + e, z + h, um, v0 - e, z + h]);
      for (let k = 1; k <= 2; k++) {
        const t = k / 3;
        this.line(shade(this.sideC(m), -0.12), 0.5, [u1 + e - (u1 + e - um) * t, v0 - e, z - 1 + (h + 1) * t, u1 + e - (u1 + e - um) * t, v1 + e, z - 1 + (h + 1) * t]);
      }
      // The far slope shows as a thin lit edge.
      this.poly(m.top, [um, v0 - e, z + h, um, v1 + e, z + h, u0 - e, v1 + e, z - 1, u0 - e, v1 + e - 0.02, z - 1]);
    }
  }

  /** Hip roof with a short ridge along u. */
  hip(u0: number, v0: number, u1: number, v1: number, z: number, h: number, inset: number, m: Mat): void {
    if (this.light) return;
    const e = 0.035;
    const vm = (v0 + v1) / 2;
    const a = u0 + inset;
    const b = u1 - inset;
    this.poly(this.sideC(m), [u1 + e, v0 - e, z - 1, u1 + e, v1 + e, z - 1, b, vm, z + h]);
    this.poly(this.frontC(m), [u0 - e, v1 + e, z - 1, u1 + e, v1 + e, z - 1, b, vm, z + h, a, vm, z + h]);
    for (let k = 1; k <= 2; k++) {
      const t = k / 3;
      this.line(shade(this.frontC(m), -0.12), 0.5, [
        u0 - e + (a - u0 + e) * t, v1 + e - (v1 + e - vm) * t, z - 1 + (h + 1) * t,
        u1 + e - (u1 + e - b) * t, v1 + e - (v1 + e - vm) * t, z - 1 + (h + 1) * t,
      ]);
    }
    this.poly(m.top, [u0 - e, v0 - e, z - 1, u0 - e, v1 + e, z - 1, a, vm, z + h]);
    this.line(shade(m.top, 0.1), 0.9, [a, vm, z + h, b, vm, z + h]);
  }

  /** Mansard: a truncated pyramid with a flat deck. */
  mansard(u0: number, v0: number, u1: number, v1: number, z: number, h: number, inset: number, m: Mat): void {
    if (this.light) return;
    const i = inset;
    this.poly(this.sideC(m), [u1, v0, z, u1, v1, z, u1 - i, v1 - i, z + h, u1 - i, v0 + i, z + h]);
    this.poly(this.frontC(m), [u0, v1, z, u1, v1, z, u1 - i, v1 - i, z + h, u0 + i, v1 - i, z + h]);
    this.top(u0 + i, v0 + i, u1 - i, v1 - i, z + h, m.top);
  }

  cyl(u: number, v: number, r: number, z0: number, z1: number, m: Mat): void {
    if (this.light) return;
    const c = this.ctx;
    const cx = this.X(u, v);
    const y0 = this.Y(u, v, z0);
    const y1 = this.Y(u, v, z1);
    const rx = r * 45.25 * this.k;
    const ry = r * 22.6 * this.k;
    c.beginPath();
    c.moveTo(cx - rx, y1);
    c.lineTo(cx - rx, y0);
    c.ellipse(cx, y0, rx, ry, 0, Math.PI, 0, true);
    c.lineTo(cx + rx, y1);
    c.closePath();
    c.fillStyle = m.left;
    c.fill();
    c.beginPath();
    c.moveTo(cx + rx * 0.15, y1);
    c.lineTo(cx + rx * 0.15, y0 + ry * 0.98);
    c.ellipse(cx, y0, rx, ry, 0, Math.PI / 2 - 0.15, 0, true);
    c.lineTo(cx + rx, y1);
    c.closePath();
    c.fillStyle = m.right;
    c.fill();
    c.beginPath();
    c.ellipse(cx, y1, rx, ry, 0, 0, Math.PI * 2);
    c.fillStyle = m.top;
    c.fill();
  }

  /** Flat ellipse on a horizontal plane. */
  disc(u: number, v: number, r: number, z: number, fill: string): void {
    if (this.light) return;
    const c = this.ctx;
    c.beginPath();
    c.ellipse(this.X(u, v), this.Y(u, v, z), r * 45.25 * this.k, r * 22.6 * this.k, 0, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
  }

  dome(u: number, v: number, r: number, z: number, h: number, m: Mat): void {
    if (this.light) return;
    const c = this.ctx;
    const cx = this.X(u, v);
    const cy = this.Y(u, v, z);
    const rx = r * 45.25 * this.k;
    const ry = r * 22.6 * this.k;
    c.beginPath();
    c.ellipse(cx, cy, rx, h, 0, Math.PI, Math.PI * 2);
    c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI);
    c.closePath();
    c.fillStyle = m.left;
    c.fill();
    c.beginPath();
    c.ellipse(cx, cy, rx, h, 0, Math.PI * 1.55, Math.PI * 2);
    c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 0.45);
    c.lineTo(cx + rx * 0.2, cy - h * 0.98);
    c.closePath();
    c.fillStyle = m.right;
    c.fill();
  }

  /** Circle facing the camera (tree crowns, topiary, lantern bulbs). */
  ball(u: number, v: number, z: number, r: number, fill: string): void {
    if (this.light) return;
    const c = this.ctx;
    c.beginPath();
    c.arc(this.X(u, v), this.Y(u, v, z), r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
  }

  post(u: number, v: number, z0: number, z1: number, w: number, fill: string): void {
    if (this.light) return;
    const c = this.ctx;
    c.fillStyle = fill;
    c.fillRect(this.X(u, v) - w / 2, this.Y(u, v, z1), w, z1 - z0);
  }

  /** Soft warm halo. Light pass only. */
  glow(u: number, v: number, z: number, r: number, alpha = 0.6): void {
    if (!this.light) return;
    const c = this.ctx;
    const x = this.X(u, v);
    const y = this.Y(u, v, z);
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,214,140,${alpha})`);
    g.addColorStop(0.45, `rgba(255,190,110,${alpha * 0.35})`);
    g.addColorStop(1, 'rgba(255,180,100,0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /** A sagging string of bulbs between two points. */
  bulbs(a: [number, number, number], b: [number, number, number], n: number, colors: string[] = [C.cream]): void {
    const c = this.ctx;
    const sag = 2.2;
    const at = (t: number): [number, number] => {
      const u = a[0] + (b[0] - a[0]) * t;
      const v = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t - sag * 4 * t * (1 - t);
      return [this.X(u, v), this.Y(u, v, z)];
    };
    if (!this.light) {
      c.beginPath();
      for (let i = 0; i <= 10; i++) {
        const [x, y] = at(i / 10);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.strokeStyle = 'rgba(40,32,28,0.55)';
      c.lineWidth = 0.4;
      c.stroke();
    }
    for (let i = 0; i < n; i++) {
      const [x, y] = at((i + 0.5) / n);
      if (this.light) {
        const g = c.createRadialGradient(x, y + 0.6, 0, x, y + 0.6, 4.2);
        g.addColorStop(0, 'rgba(255,224,150,0.95)');
        g.addColorStop(0.3, 'rgba(255,196,110,0.4)');
        g.addColorStop(1, 'rgba(255,180,100,0)');
        c.fillStyle = g;
        c.fillRect(x - 4.2, y - 3.6, 8.4, 8.4);
      } else {
        c.beginPath();
        c.arc(x, y + 0.6, 0.85, 0, Math.PI * 2);
        c.fillStyle = colors[i % colors.length];
        c.fill();
      }
    }
  }

  /** A paper lantern: coloured by day, glowing by night. */
  lantern(u: number, v: number, z: number, color: string, r = 1.5): void {
    const c = this.ctx;
    const x = this.X(u, v);
    const y = this.Y(u, v, z);
    if (this.light) {
      const g = c.createRadialGradient(x, y, 0, x, y, r * 4.5);
      g.addColorStop(0, 'rgba(255,220,150,0.95)');
      g.addColorStop(0.3, 'rgba(255,180,100,0.45)');
      g.addColorStop(1, 'rgba(255,170,90,0)');
      c.fillStyle = g;
      c.fillRect(x - r * 4.5, y - r * 4.5, r * 9, r * 9);
      return;
    }
    c.beginPath();
    c.ellipse(x, y, r, r * 1.25, 0, 0, Math.PI * 2);
    c.fillStyle = color;
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.35)';
    c.fillRect(x - r * 0.5, y - r * 0.9, r * 0.35, r * 1.5);
    c.fillStyle = C.woodDark;
    c.fillRect(x - r * 0.4, y - r * 1.55, r * 0.8, 0.5);
  }

  tree(u: number, v: number, s: number, tone = 0): void {
    if (this.light) return;
    const dark = tone === 1 ? '#4F7D62' : C.sageDark;
    const mid = tone === 1 ? '#6E9B7B' : C.sage;
    const lite = tone === 1 ? '#8FB896' : C.sageLight;
    this.post(u, v, 0, 5 * s, 1.3 * s, C.woodDark);
    this.ball(u, v, 8 * s, 5.2 * s, dark);
    this.ball(u - 0.04 * s, v + 0.02 * s, 10.5 * s, 4.4 * s, mid);
    const c = this.ctx;
    c.beginPath();
    c.arc(this.X(u, v) - 1.6 * s, this.Y(u, v, 12 * s), 2.5 * s, 0, Math.PI * 2);
    c.fillStyle = lite;
    c.fill();
  }

  /** Café parasol with alternating panels. */
  parasol(u: number, v: number, z: number, r: number, c1: string, c2: string): void {
    if (this.light) return;
    const c = this.ctx;
    const cx = this.X(u, v);
    const cy = this.Y(u, v, z);
    this.post(u, v, 0, z + 2, 0.7, C.woodDark);
    const rx = r * 45.25;
    const ry = r * 22.6;
    const apex = cy - 4.2;
    for (let i = 0; i < 8; i++) {
      // Far panels first.
      const k = (i + 5) % 8;
      const a0 = (Math.PI * 2 * k) / 8;
      const a1 = (Math.PI * 2 * (k + 1)) / 8;
      c.beginPath();
      c.moveTo(cx, apex);
      c.lineTo(cx + rx * Math.cos(a0), cy + ry * Math.sin(a0));
      c.lineTo(cx + rx * Math.cos(a1), cy + ry * Math.sin(a1));
      c.closePath();
      c.fillStyle = k % 2 ? c2 : c1;
      c.fill();
    }
  }

  /** Pergola: four posts and slats, the Level 3 signature. */
  pergola(u0: number, v0: number, u1: number, v1: number, z0: number, z1: number): void {
    if (this.light) {
      this.glow((u0 + u1) / 2, (v0 + v1) / 2, z0 + 3, 16, 0.4);
      return;
    }
    const wood = WOOD;
    this.post(u0, v0, z0, z1, 0.9, wood.right);
    this.post(u1, v0, z0, z1, 0.9, wood.right);
    for (let i = 0; i <= 5; i++) {
      const u = u0 + ((u1 - u0) * i) / 5;
      this.poly(i % 2 ? wood.left : wood.top, [u - 0.012, v0 - 0.03, z1, u + 0.012, v0 - 0.03, z1, u + 0.012, v1 + 0.03, z1, u - 0.012, v1 + 0.03, z1]);
    }
    this.poly(wood.left, [u0 - 0.03, v1, z1, u1 + 0.03, v1, z1, u1 + 0.03, v1, z1 - 1.2, u0 - 0.03, v1, z1 - 1.2]);
    this.post(u0, v1, z0, z1, 1, wood.left);
    this.post(u1, v1, z0, z1, 1, wood.left);
  }

  /** Gilded cornice band around a roofline. */
  cornice(u0: number, v0: number, u1: number, v1: number, z: number): void {
    this.box(u0 - 0.02, v0 - 0.02, u1 + 0.02, v1 + 0.02, z, z + 1.6, BRASS);
  }
}

// ───────────────────────────── Shops ─────────────────────────────

function roastery(p: Pen, lv: number, h: HouseTone): void {
  const brick = mat('#C98C63');
  const wall = mat('#EBDCC2');
  const copper = mat('#C67A45', 0.2, 0.22);
  p.box(0.1, 0.12, 0.9, 0.86, 0, 2, STONE);
  p.box(0.14, 0.16, 0.86, 0.82, 2, 17, brick);
  // Shopfront.
  p.win(0.2, 0.54, 5, 13, 0.82, true);
  p.door(0.62, 0.76, 2, 13.5, 0.82, h.dark);
  p.winSide(0.24, 0.44, 6, 13, 0.86);
  p.winSide(0.54, 0.74, 6, 13, 0.86);
  p.front(0.14, 0.86, 14.2, 17, 0.82, wall.left);
  p.round(0.7, 15.6, 0.03, 0.825, '#6B4226');
  p.awning(0.17, 0.58, 14.2, 0.82, 0.15, 4.2, h.color, C.cream, 5);
  let roofZ = 17;
  if (lv >= 2) {
    p.box(0.14, 0.16, 0.86, 0.82, 17, 31, wall);
    p.win(0.22, 0.38, 20, 28, 0.82);
    p.win(0.46, 0.62, 20, 28, 0.82);
    p.win(0.68, 0.8, 20, 28, 0.82);
    p.winSide(0.26, 0.42, 20, 28, 0.86);
    p.winSide(0.56, 0.72, 20, 28, 0.86);
    p.front(0.14, 0.86, 17, 18.2, 0.82, h.color);
    roofZ = 31;
  }
  if (lv === 1) {
    p.box(0.13, 0.15, 0.87, 0.83, roofZ, roofZ + 1.8, wall);
    p.top(0.17, 0.19, 0.83, 0.79, roofZ + 1.2, '#BBAA90');
    p.box(0.52, 0.34, 0.74, 0.56, roofZ + 1.2, roofZ + 4.5, mat('#9A8F80'));
  } else if (lv === 2) {
    p.hip(0.12, 0.14, 0.88, 0.84, roofZ, 9, 0.22, ROOF);
  } else {
    p.cornice(0.14, 0.16, 0.86, 0.82, roofZ);
    p.top(0.17, 0.19, 0.83, 0.79, roofZ + 1.6, '#CDBFA6');
    p.pergola(0.4, 0.36, 0.8, 0.74, roofZ + 1.6, roofZ + 12);
    p.bulbs([0.4, 0.74, roofZ + 11], [0.8, 0.74, roofZ + 11], 5);
    p.ball(0.2, 0.74, roofZ + 4, 2.4, C.sageDark);
    p.box(0.17, 0.71, 0.23, 0.77, roofZ + 1.6, roofZ + 3, mat(C.terracotta));
  }
  // The roaster stack: copper, banded, with a cap.
  const top = roofZ + (lv === 2 ? 13 : 12);
  p.cyl(0.27, 0.3, 0.062, roofZ - 2, top, copper);
  p.cyl(0.27, 0.3, 0.07, top - 5, top - 4, BRASS);
  p.cyl(0.27, 0.3, 0.075, top, top + 1.4, mat('#7C5A45'));
  p.glow(0.37, 0.9, 8, 13, 0.5);
}

function bistro(p: Pen, lv: number, h: HouseTone): void {
  const wall = mat('#E9BB93');
  const trim = mat('#F6ECDB');
  p.box(0.08, 0.08, 0.92, 0.66, 0, 2, STONE);
  // Terrace deck in front.
  p.box(0.08, 0.66, 0.92, 0.96, 0, 1.4, mat('#D9C7A6'));
  p.box(0.12, 0.12, 0.88, 0.64, 2, 17, wall);
  p.arch(0.18, 0.34, 5, 10, 0.64);
  p.arch(0.66, 0.82, 5, 10, 0.64);
  p.door(0.43, 0.57, 2, 13.5, 0.64, h.dark);
  p.winSide(0.2, 0.34, 6, 13, 0.88);
  p.winSide(0.42, 0.56, 6, 13, 0.88);
  p.front(0.12, 0.88, 15.4, 17, 0.64, trim.left);
  p.awning(0.38, 0.62, 15.2, 0.64, 0.12, 3.4, h.color, C.cream, 3);
  let roofZ = 17;
  if (lv >= 2) {
    p.box(0.12, 0.12, 0.88, 0.64, 17, 31, wall);
    // Shuttered windows.
    for (const u of [0.2, 0.44, 0.68]) {
      p.win(u, u + 0.12, 20, 28, 0.64);
      p.front(u - 0.035, u, 20, 28, 0.64, C.sageDark);
      p.front(u + 0.12, u + 0.155, 20, 28, 0.64, C.sageDark);
    }
    p.winSide(0.2, 0.34, 20, 28, 0.88);
    p.winSide(0.42, 0.56, 20, 28, 0.88);
    // Balcony.
    p.box(0.36, 0.64, 0.64, 0.71, 17, 18, trim);
    p.line(C.woodDark, 0.45, [0.36, 0.71, 21, 0.64, 0.71, 21]);
    for (let i = 0; i <= 4; i++) p.line(C.woodDark, 0.35, [0.36 + i * 0.07, 0.71, 18, 0.36 + i * 0.07, 0.71, 21]);
    roofZ = 31;
  }
  if (lv < 3) {
    p.hip(0.1, 0.1, 0.9, 0.66, roofZ, 10, 0.2, ROOF);
    p.box(0.66, 0.2, 0.74, 0.28, roofZ + 4, roofZ + 12, mat('#D9A47E'));
  } else {
    p.cornice(0.12, 0.12, 0.88, 0.64, roofZ);
    p.top(0.15, 0.15, 0.85, 0.61, roofZ + 1.6, '#D8C9AC');
    p.pergola(0.22, 0.2, 0.78, 0.56, roofZ + 1.6, roofZ + 12.5);
    p.bulbs([0.22, 0.56, roofZ + 11.5], [0.78, 0.56, roofZ + 11.5], 6);
    p.bulbs([0.78, 0.2, roofZ + 11.5], [0.78, 0.56, roofZ + 11.5], 4);
    p.ball(0.16, 0.58, roofZ + 4, 2.2, C.sageDark);
  }
  // Tables and parasols on the terrace.
  const spots = lv === 3 ? [0.22, 0.5, 0.78] : [0.26, 0.74];
  for (const u of spots) {
    p.cyl(u, 0.83, 0.035, 1.4, 4, mat(C.cream));
    p.parasol(u, 0.83, 9.5, 0.085, h.color, C.cream);
  }
  p.glow(0.5, 0.82, 6, 17, 0.5);
  // Terrace string lights from the facade to two posts.
  p.post(0.1, 0.95, 1.4, 13, 0.6, C.woodDark);
  p.post(0.9, 0.95, 1.4, 13, 0.6, C.woodDark);
  p.bulbs([0.1, 0.95, 13], [0.9, 0.95, 13], 7);
}

function arcade(p: Pen, lv: number, h: HouseTone): void {
  const wall = mat('#EEE4CE');
  const patina = mat('#6FA39A', 0.16, 0.2);
  const u0 = 0.1;
  const u1 = 0.9;
  const v0 = 0.14;
  const v1 = 0.84;
  p.box(0.08, 0.12, 0.92, 0.88, 0, 2, STONE);
  p.box(u0, v0, u1, v1, 2, 19, wall);
  // Striped voussoir arch around a deep entrance.
  p.arch(0.33, 0.67, 2, 9.5, v1, h.color);
  p.arch(0.36, 0.64, 2, 9, v1, C.cream);
  p.arch(0.39, 0.61, 2, 8.5, v1, '#2C2932');
  if (p.light) p.lightPoly('#FFC978', [0.4, v1, 2, 0.6, v1, 2, 0.6, v1, 11, 0.4, v1, 11], 0.75);
  // Portholes with coloured panes.
  p.round(0.21, 11, 0.07, v1, h.dark);
  p.round(0.21, 11, 0.052, v1, '#3E8E9E', true);
  p.round(0.79, 11, 0.07, v1, h.dark);
  p.round(0.79, 11, 0.052, v1, '#D48C1C', true);
  // Pixel windows on the side.
  for (let i = 0; i < 4; i++) p.winSide(0.2 + i * 0.16, 0.3 + i * 0.16, 7, 13, u1);
  p.front(u0, u1, 16.5, 19, v1, h.color);
  for (let i = 0; i < 7; i++) p.front(0.14 + i * 0.11, 0.19 + i * 0.11, 17.2, 18.3, v1, C.cream);
  let z = 19;
  if (lv >= 2) {
    p.box(0.18, 0.2, 0.82, 0.78, 19, 31, wall);
    for (let i = 0; i < 5; i++) p.win(0.23 + i * 0.115, 0.3 + i * 0.115, 22, 28, 0.78);
    for (let i = 0; i < 3; i++) p.winSide(0.27 + i * 0.16, 0.37 + i * 0.16, 22, 28, 0.82);
    z = 31;
  }
  const a0 = lv >= 2 ? 0.18 : u0;
  const a1 = lv >= 2 ? 0.82 : u1;
  const b0 = lv >= 2 ? 0.2 : v0;
  const b1 = lv >= 2 ? 0.78 : v1;
  if (lv === 3) {
    p.cornice(a0, b0, a1, b1, z);
    z += 1.6;
  }
  // Barrel vault, patina copper.
  if (!p.light) {
    const n = 7;
    const rise = 9;
    const prof = (t: number): [number, number] => [a0 + (a1 - a0) * t, z + Math.sin(Math.PI * t) * rise];
    const lun: number[] = [];
    for (let i = 0; i <= n; i++) {
      const [u, zz] = prof(i / n);
      lun.push(u, b1, zz);
    }
    for (let i = 0; i < n; i++) {
      const [ua, za] = prof(i / n);
      const [ub, zb] = prof((i + 1) / n);
      const t = (i + 0.5) / n;
      const tone = p.flip ? 1 - t : t;
      p.poly(shade('#6FA39A', 0.22 - tone * 0.42), [ua, b0, za, ub, b0, zb, ub, b1, zb, ua, b1, za]);
    }
    p.poly(p.frontC(wall), lun);
    p.round((a0 + a1) / 2, z + 3.6, 0.05, b1 + 0.001, BRASS.left);
    p.round((a0 + a1) / 2, z + 3.6, 0.03, b1 + 0.002, BRASS.top);
    void patina;
  }
  if (lv === 3) {
    // Corner turrets.
    for (const [u, v] of [[0.15, 0.8], [0.85, 0.8]] as const) {
      p.cyl(u, v, 0.045, 19, 30, wall);
      p.dome(u, v, 0.05, 30, 5, mat('#6FA39A'));
      p.post(u, v, 34, 39, 0.5, C.woodDark);
    }
  }
  p.glow(0.5, 0.92, 7, 16, 0.6);
}

function boutique(p: Pen, lv: number, h: HouseTone): void {
  const wall = mat('#F4ECDD');
  const slate = mat('#5C6572', 0.16, 0.2);
  const dark = '#30303A';
  const u0 = 0.2;
  const u1 = 0.8;
  const v0 = 0.16;
  const v1 = 0.82;
  p.box(0.16, 0.12, 0.84, 0.86, 0, 2, STONE);
  p.box(u0, v0, u1, v1, 2, 20, wall);
  // Display window with a mannequin.
  p.win(0.25, 0.56, 4.5, 15, v1, true);
  p.poly(h.color, [0.37, v1 + 0.002, 5.5, 0.45, v1 + 0.002, 5.5, 0.425, v1 + 0.002, 11, 0.395, v1 + 0.002, 11]);
  p.round(0.41, 12.4, 0.016, v1 + 0.002, '#E7CDB4');
  p.door(0.62, 0.75, 2, 15, v1, dark);
  p.front(u0, u1, 16.2, 19, v1, dark);
  p.front(0.3, 0.7, 17.2, 18, v1, C.brass);
  p.winSide(0.24, 0.42, 5, 15, u1);
  p.winSide(0.52, 0.72, 5, 15, u1);
  p.awning(0.23, 0.58, 16, v1, 0.1, 2.6, h.color, h.color, 1);
  // Topiary at the door.
  for (const u of [0.59, 0.78]) {
    p.box(u - 0.025, v1 + 0.04, u + 0.025, v1 + 0.09, 0, 2.5, mat(C.terracotta));
    p.ball(u, v1 + 0.065, 5.6, 2.5, C.sageDark);
    p.ball(u, v1 + 0.065, 8.6, 1.7, C.sage);
  }
  let z = 20;
  if (lv >= 2) {
    p.box(u0, v0, u1, v1, 20, 34, wall);
    for (const u of [0.27, 0.56]) {
      p.win(u, u + 0.16, 22.5, 31.5, v1);
      p.box(u - 0.02, v1, u + 0.18, v1 + 0.04, 21.5, 22.3, mat(dark));
      p.line(dark, 0.4, [u - 0.02, v1 + 0.04, 25, u + 0.18, v1 + 0.04, 25]);
    }
    p.winSide(0.26, 0.42, 22.5, 31.5, u1);
    p.winSide(0.54, 0.7, 22.5, 31.5, u1);
    z = 34;
  }
  if (lv === 3) {
    p.cornice(u0, v0, u1, v1, z);
    z += 1.6;
  }
  p.mansard(u0 - 0.02, v0 - 0.02, u1 + 0.02, v1 + 0.02, z, 8, 0.1, slate);
  // Dormer.
  p.box(0.42, v1 - 0.1, 0.58, v1 - 0.02, z + 1, z + 6.5, wall);
  p.win(0.45, 0.55, z + 2, z + 5.6, v1 - 0.02);
  p.line(C.brass, 0.7, [u0 + 0.08, v1 - 0.08, z + 8, u1 - 0.08, v1 - 0.08, z + 8, u1 - 0.08, v0 + 0.08, z + 8]);
  if (lv === 3) {
    // Glass lantern cupola with a brass dome.
    p.cyl(0.5, 0.44, 0.09, z + 8, z + 14, mat('#8FB7BE', 0.2, 0.2));
    if (p.light) p.glow(0.5, 0.44, z + 11, 12, 0.7);
    p.cyl(0.5, 0.44, 0.1, z + 14, z + 15, BRASS);
    p.dome(0.5, 0.44, 0.09, z + 15, 5, BRASS);
    p.post(0.5, 0.44, z + 20, z + 24, 0.5, C.brassDark);
  }
  p.glow(0.4, 0.9, 8, 14, 0.55);
}

function cinema(p: Pen, lv: number, h: HouseTone): void {
  const wall = mat('#EFE3CD');
  const deco = mat('#D9A47E');
  const u0 = 0.08;
  const u1 = 0.92;
  const v0 = 0.12;
  const v1 = 0.82;
  const top = lv === 1 ? 24 : 31;
  p.box(0.06, 0.1, 0.94, 0.86, 0, 2, STONE);
  p.box(u0, v0, u1, v1, 2, top, wall);
  // Deco pilasters.
  for (const u of [0.1, 0.26, 0.7, 0.86]) p.front(u, u + 0.04, 2, top, v1, p.frontC(deco));
  // Poster frames.
  p.front(0.15, 0.25, 5, 14, v1, '#3C5A66');
  p.front(0.165, 0.235, 6, 13, v1, h.light);
  p.front(0.75, 0.85, 5, 14, v1, '#3C5A66');
  p.front(0.765, 0.835, 6, 13, v1, '#E9C46A');
  // Entrance.
  p.front(0.34, 0.66, 2, 13, v1, '#2A2630');
  for (const u of [0.37, 0.47, 0.57]) p.front(u, u + 0.06, 2.5, 11.5, v1, C.brassDark);
  if (p.light) p.lightPoly('#FFD08A', [0.34, v1, 2, 0.66, v1, 2, 0.66, v1, 13, 0.34, v1, 13], 0.8);
  // Tall slit windows on the side.
  for (let i = 0; i < 4; i++) p.winSide(0.2 + i * 0.16, 0.26 + i * 0.16, 6, top - 5, u1);
  if (lv >= 2) for (let i = 0; i < 5; i++) p.win(0.32 + i * 0.075, 0.36 + i * 0.075, 20, 27, v1);
  // Ziggurat parapet.
  p.box(0.2, v0, 0.8, v1, top, top + 4, wall);
  p.box(0.32, v0, 0.68, v1, top + 4, top + 7, wall);
  p.front(0.32, 0.68, top + 5.2, top + 6, v1, h.color);
  if (lv === 3) {
    p.cornice(0.2, v0, 0.8, v1, top + 4);
    p.cyl(0.5, 0.36, 0.13, top + 7, top + 12, wall);
    p.dome(0.5, 0.36, 0.13, top + 12, 8, mat('#6FA39A'));
    p.post(0.5, 0.36, top + 20, top + 25, 0.5, C.brassDark);
  }
  // Marquee canopy with a bulb-lined edge.
  p.box(0.27, v1, 0.73, v1 + 0.14, 13.5, 16.5, mat(h.color));
  p.front(0.29, 0.71, 14.2, 15.8, v1 + 0.14, C.cream);
  for (let i = 0; i < 6; i++) p.front(0.31 + i * 0.066, 0.34 + i * 0.066, 14.6, 15.4, v1 + 0.14, '#3C3540');
  if (p.light) {
    p.lightPoly('#FFE2A6', [0.29, v1 + 0.14, 14.2, 0.71, v1 + 0.14, 14.2, 0.71, v1 + 0.14, 15.8, 0.29, v1 + 0.14, 15.8], 0.95);
    p.glow(0.5, v1 + 0.18, 11, 24, 0.75);
  }
  // Vertical fin sign.
  const finTop = top + (lv === 1 ? 16 : lv === 2 ? 22 : 26);
  p.box(0.46, v1 - 0.03, 0.54, v1 + 0.05, 16.5, finTop, mat(h.color));
  for (let zz = 20; zz < finTop - 2; zz += 4.2) {
    p.round(0.5, zz, 0.018, v1 + 0.052, C.cream, true);
  }
  p.box(0.44, v1 - 0.05, 0.56, v1 + 0.07, finTop, finTop + 1.5, BRASS);
  if (p.light) p.glow(0.5, v1 + 0.05, (16 + finTop) / 2, 16, 0.5);
}

function stall(p: Pen, u0: number, v0: number, u1: number, v1: number, c1: string, goods: string): void {
  p.box(u0, v0, u1, v1, 1.2, 6, mat('#B98F63'));
  p.top(u0 + 0.02, v0 + 0.02, u1 - 0.02, v1 - 0.02, 6.2, goods);
  p.post(u0 + 0.01, v0 + 0.01, 6, 13, 0.6, C.woodDark);
  p.post(u1 - 0.01, v0 + 0.01, 6, 13, 0.6, C.woodDark);
  const um = (u0 + u1) / 2;
  const e = 0.03;
  // Striped canvas roof, ridge along v.
  if (!p.light) {
    const n = 4;
    const w = (v1 - v0 + 2 * e) / n;
    for (let i = 0; i < n; i++) {
      const a = v0 - e + w * i;
      p.poly(i % 2 ? shade(C.cream, -0.04) : shade(c1, 0.06), [um, a, 17, um, a + w, 17, u0 - e, a + w, 12.5, u0 - e, a, 12.5]);
      p.poly(i % 2 ? shade(C.cream, -0.14) : shade(c1, -0.14), [um, a, 17, um, a + w, 17, u1 + e, a + w, 12.5, u1 + e, a, 12.5]);
    }
    p.poly(p.frontC(mat(c1)), [u0 - e, v1 + e, 12.5, u1 + e, v1 + e, 12.5, um, v1 + e, 17]);
  }
  p.post(u0 + 0.01, v1 - 0.01, 6, 13, 0.7, C.woodDark);
  p.post(u1 - 0.01, v1 - 0.01, 6, 13, 0.7, C.woodDark);
  p.glow(um, (v0 + v1) / 2, 9, 12, 0.7);
}

function nightmarket(p: Pen, lv: number, h: HouseTone): void {
  const paper = ['#E6533C', '#E9B23A', '#F4E3C1', h.color];
  p.box(0.06, 0.06, 0.94, 0.94, 0, 1.2, mat('#CDB58E'));
  // Deck boards.
  for (let i = 1; i < 6; i++) p.line('rgba(110,80,50,0.25)', 0.35, [0.06 + i * 0.147, 0.06, 1.25, 0.06 + i * 0.147, 0.94, 1.25]);
  // Lantern poles at the corners.
  const poleZ = lv === 3 ? 30 : 23;
  const poles: [number, number][] = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]];
  p.post(0.1, 0.1, 1, poleZ, 0.8, C.woodDark);
  p.post(0.9, 0.1, 1, poleZ, 0.8, C.woodDark);
  // Back string.
  hang(p, poles[0], poles[1], poleZ, 4, paper);
  stall(p, 0.14, 0.16, 0.44, 0.44, h.color, '#C7773E');
  if (lv >= 2) stall(p, 0.56, 0.14, 0.86, 0.42, '#E9B23A', '#84A98C');
  if (lv === 3) {
    // Two-level pavilion with a pergola deck.
    p.box(0.36, 0.38, 0.66, 0.66, 1.2, 15, mat('#B98F63'));
    p.front(0.4, 0.62, 3, 11, 0.66, '#3A2C28');
    if (p.light) p.lightPoly('#FFC978', [0.4, 0.66, 3, 0.62, 0.66, 3, 0.62, 0.66, 11, 0.4, 0.66, 11], 0.85);
    p.cornice(0.34, 0.36, 0.68, 0.68, 15);
    p.pergola(0.38, 0.4, 0.64, 0.64, 16.6, 26);
    p.box(0.49, 0.5, 0.53, 0.54, 26, 30, BRASS);
    p.bulbs([0.38, 0.64, 25], [0.64, 0.64, 25], 4, paper);
  }
  stall(p, lv === 3 ? 0.62 : 0.5, 0.56, lv === 3 ? 0.9 : 0.82, 0.84, lv >= 2 ? h.color : '#E9B23A', '#E9C46A');
  if (lv >= 2) stall(p, 0.1, 0.6, 0.36, 0.86, '#E6533C', '#C86443');
  // Crates.
  p.box(0.46, 0.2, 0.53, 0.27, 1.2, 4, mat('#A77E55'));
  p.box(0.2, 0.5, 0.27, 0.57, 1.2, 3.6, mat('#B98F63'));
  if (lv >= 2) {
    // Entrance gate with a banner.
    p.post(0.34, 0.95, 1, 19, 1, C.woodDark);
    p.post(0.66, 0.95, 1, 19, 1, C.woodDark);
    p.poly(C.woodDark, [0.3, 0.95, 19, 0.7, 0.95, 19, 0.7, 0.95, 20.6, 0.3, 0.95, 20.6]);
    p.poly(h.color, [0.4, 0.95, 14.5, 0.6, 0.95, 14.5, 0.6, 0.95, 19, 0.4, 0.95, 19]);
    p.poly(C.cream, [0.44, 0.951, 16, 0.56, 0.951, 16, 0.56, 0.951, 17.4, 0.44, 0.951, 17.4]);
  }
  // Side and front strings, drawn last so they hang in front of the stalls.
  hang(p, poles[1], poles[3], poleZ, 4, paper);
  hang(p, poles[0], poles[2], poleZ, 4, paper);
  p.post(0.1, 0.9, 1, poleZ, 0.9, C.woodDark);
  p.post(0.9, 0.9, 1, poleZ, 0.9, C.woodDark);
  hang(p, poles[2], poles[3], poleZ, 5, paper);
  if (lv === 3) hang(p, poles[0], poles[3], poleZ, 6, paper);
}

function hang(p: Pen, a: [number, number], b: [number, number], z: number, n: number, colors: string[]): void {
  if (!p.light) {
    p.line('rgba(40,32,28,0.6)', 0.4, [a[0], a[1], z, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z - 3.2, b[0], b[1], z]);
  }
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const u = a[0] + (b[0] - a[0]) * t;
    const v = a[1] + (b[1] - a[1]) * t;
    const zz = z - 3.2 * (1 - Math.abs(t - 0.5) * 2) - 2.4;
    p.lantern(u, v, zz, colors[i % colors.length], 1.5);
  }
}

// ───────────────────────────── Civic ─────────────────────────────

function park(p: Pen, _lv: number, h: HouseTone): void {
  p.box(0.04, 0.04, 0.96, 0.96, 0, 1.2, mat('#CFC4AE'));
  p.top(0.07, 0.07, 0.93, 0.93, 1.25, C.sage);
  // Lighter mown patch and a gravel path that curves across.
  p.poly(C.sageLight, [0.1, 0.12, 1.3, 0.5, 0.1, 1.3, 0.62, 0.34, 1.3, 0.3, 0.5, 1.3, 0.1, 0.4, 1.3]);
  if (!p.light) {
    const c = p.ctx;
    c.beginPath();
    c.moveTo(p.X(0.5, 0.96), p.Y(0.5, 0.96, 1.3));
    c.bezierCurveTo(p.X(0.5, 0.7), p.Y(0.5, 0.7, 1.3), p.X(0.7, 0.55), p.Y(0.7, 0.55, 1.3), p.X(0.96, 0.5), p.Y(0.96, 0.5, 1.3));
    c.strokeStyle = '#E6DCC6';
    c.lineWidth = 3.4;
    c.lineCap = 'butt';
    c.stroke();
  }
  // Flower beds.
  p.disc(0.28, 0.72, 0.07, 1.4, C.sageDark);
  for (const [u, v, col] of [[0.25, 0.7, '#D6453A'], [0.31, 0.73, '#E9B23A'], [0.28, 0.76, '#F4E3C1'], [0.24, 0.75, '#E9B23A']] as const)
    p.ball(u, v, 2.6, 1, col);
  // Little pond.
  p.disc(0.72, 0.3, 0.085, 1.35, '#D6CCB8');
  p.disc(0.72, 0.3, 0.068, 1.4, C.canal);
  p.disc(0.7, 0.29, 0.025, 1.45, C.canalLight);
  p.tree(0.22, 0.26, 1.15, 0);
  p.tree(0.46, 0.2, 0.9, 1);
  // Bench facing the path.
  p.box(0.6, 0.66, 0.74, 0.7, 1.3, 3, WOOD);
  p.box(0.6, 0.64, 0.74, 0.655, 1.3, 5, WOOD);
  p.tree(0.84, 0.8, 1.0, 1);
  // Patron's plaque post in the House colour.
  p.post(0.12, 0.9, 1.2, 8, 0.6, C.woodDark);
  p.poly(h.color, [0.12, 0.9, 8, 0.2, 0.9, 6.6, 0.12, 0.9, 5.2]);
  // A lamp.
  p.post(0.56, 0.84, 1.2, 12, 0.6, '#3B3A40');
  p.ball(0.56, 0.84, 12.6, 1.3, C.cream);
  p.glow(0.56, 0.84, 12.6, 16, 0.7);
}

function tramstop(p: Pen, _lv: number, h: HouseTone): void {
  p.box(0.04, 0.04, 0.96, 0.96, 0, 1.6, mat(C.paving));
  // Paving bands and a brass tactile strip along the street edge.
  for (let i = 1; i < 5; i++) p.line('rgba(150,135,110,0.35)', 0.35, [0.04, 0.04 + i * 0.184, 1.65, 0.96, 0.04 + i * 0.184, 1.65]);
  p.top(0.06, 0.86, 0.94, 0.92, 1.66, C.brass);
  // Shelter: glass back wall, bench, brass-edged cream roof.
  p.post(0.16, 0.36, 1.6, 15, 0.9, '#3B3A40');
  p.post(0.84, 0.36, 1.6, 15, 0.9, '#3B3A40');
  p.poly('rgba(140,190,200,0.45)', [0.16, 0.36, 3, 0.84, 0.36, 3, 0.84, 0.36, 14, 0.16, 0.36, 14]);
  p.box(0.24, 0.4, 0.76, 0.48, 1.6, 4.2, WOOD);
  p.post(0.16, 0.66, 1.6, 15, 1, '#3B3A40');
  p.post(0.84, 0.66, 1.6, 15, 1, '#3B3A40');
  p.box(0.1, 0.3, 0.9, 0.72, 15, 16.6, mat(C.cream));
  p.box(0.09, 0.29, 0.91, 0.73, 16.6, 17.4, BRASS);
  if (p.light) {
    p.lightPoly('#FFE2A6', [0.16, 0.66, 12.5, 0.84, 0.66, 12.5, 0.84, 0.66, 15, 0.16, 0.66, 15], 0.8);
    p.glow(0.5, 0.6, 9, 20, 0.6);
  }
  // Roundel sign in the House colour.
  p.post(0.9, 0.84, 1.6, 20, 0.8, '#3B3A40');
  p.round(0.9, 22, 0.05, 0.84, h.color);
  p.round(0.9, 22, 0.028, 0.841, C.cream);
  p.front(0.845, 0.955, 21.3, 22.7, 0.842, h.dark);
  // Ticket kiosk and a planter.
  p.box(0.1, 0.74, 0.22, 0.86, 1.6, 9, mat(h.color));
  p.win(0.12, 0.2, 5, 8, 0.86, true);
  p.box(0.4, 0.76, 0.58, 0.84, 1.6, 3.4, mat(C.terracotta));
  p.ball(0.45, 0.8, 5, 2.2, C.sageDark);
  p.ball(0.53, 0.8, 5.2, 2, C.sage);
}

function plaza(p: Pen, _lv: number, h: HouseTone): void {
  p.box(0.02, 0.02, 0.98, 0.98, 0, 1.4, mat(C.paving));
  // Radial paving: alternating travertine and terracotta rings.
  p.disc(0.5, 0.5, 0.43, 1.45, '#D9B79C');
  p.disc(0.5, 0.5, 0.36, 1.46, C.travertine);
  p.disc(0.5, 0.5, 0.27, 1.47, '#D9B79C');
  p.disc(0.5, 0.5, 0.2, 1.48, C.travertine);
  if (!p.light) {
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * i) / 4;
      p.line('rgba(170,120,90,0.4)', 0.4, [0.5 + 0.2 * Math.cos(a), 0.5 + 0.2 * Math.sin(a), 1.5, 0.5 + 0.43 * Math.cos(a), 0.5 + 0.43 * Math.sin(a), 1.5]);
    }
  }
  // Bunting poles at the back.
  const flags = [h.color, C.cream, '#E9B23A', h.color, C.cream, '#D6453A'];
  const bunting = (a: [number, number], b: [number, number]): void => {
    if (p.light) return;
    p.line('rgba(40,32,28,0.55)', 0.4, [a[0], a[1], 22, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 19, b[0], b[1], 22]);
    for (let i = 0; i < 7; i++) {
      const t = (i + 0.5) / 7;
      const u = a[0] + (b[0] - a[0]) * t;
      const v = a[1] + (b[1] - a[1]) * t;
      const z = 22 - 3 * (1 - Math.abs(t - 0.5) * 2);
      const du = (b[0] - a[0]) * 0.045;
      const dv = (b[1] - a[1]) * 0.045;
      p.poly(flags[i % flags.length], [u - du, v - dv, z, u + du, v + dv, z, u, v, z - 3.4]);
    }
  };
  p.post(0.08, 0.08, 1.4, 22, 0.8, '#3B3A40');
  p.post(0.92, 0.08, 1.4, 22, 0.8, '#3B3A40');
  bunting([0.08, 0.08], [0.92, 0.08]);
  bunting([0.08, 0.08], [0.08, 0.92]);
  // Fountain: stone basin, water, a tiered stem.
  p.cyl(0.5, 0.5, 0.15, 1.4, 4.4, STONE);
  p.disc(0.5, 0.5, 0.125, 4.45, C.canal);
  p.disc(0.47, 0.49, 0.05, 4.5, C.canalLight);
  p.cyl(0.5, 0.5, 0.03, 4.4, 9, STONE);
  p.cyl(0.5, 0.5, 0.07, 9, 10, STONE);
  p.disc(0.5, 0.5, 0.055, 10.05, C.canalLight);
  p.cyl(0.5, 0.5, 0.014, 10, 13, mat(C.brass));
  if (!p.light) {
    const c = p.ctx;
    c.strokeStyle = 'rgba(220,240,244,0.9)';
    c.lineWidth = 0.7;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(p.X(0.5, 0.5), p.Y(0.5, 0.5, 13));
      c.quadraticCurveTo(p.X(0.5, 0.5) + s * 3, p.Y(0.5, 0.5, 15), p.X(0.5, 0.5) + s * 5, p.Y(0.5, 0.5, 10.2));
      c.stroke();
    }
  }
  p.glow(0.5, 0.5, 7, 22, 0.55);
  p.post(0.08, 0.92, 1.4, 22, 0.9, '#3B3A40');
  p.post(0.92, 0.92, 1.4, 22, 0.9, '#3B3A40');
  bunting([0.92, 0.08], [0.92, 0.92]);
  bunting([0.08, 0.92], [0.92, 0.92]);
  // Benches and planters.
  p.box(0.2, 0.84, 0.36, 0.88, 1.4, 3.2, WOOD);
  p.box(0.82, 0.2, 0.86, 0.36, 1.4, 3.2, WOOD);
  p.box(0.74, 0.76, 0.84, 0.86, 1.4, 3.6, mat(C.terracotta));
  p.ball(0.79, 0.81, 5.6, 2.6, C.sageDark);
  p.ball(0.78, 0.8, 7, 1.8, C.sage);
}

// ───────────────────────────── City fabric ─────────────────────────────

const STUCCO = ['#F0E2C8', '#E9C9A0', '#E6B18F', '#F5EDE0', '#DDD3B8', '#E8BFA0'];
const SHUTTER = ['#5F8A6C', '#3E8E9E', '#B5553A', '#56708A'];

function townhouse(p: Pen, variant: number): void {
  const wall = mat(STUCCO[variant % STUCCO.length]);
  const shut = SHUTTER[(variant >> 1) % SHUTTER.length];
  const floors = 2 + (variant % 3 === 0 ? 1 : 0);
  const narrow = variant % 2 === 0;
  const u0 = narrow ? 0.16 : 0.12;
  const u1 = narrow ? 0.84 : 0.88;
  const v0 = 0.14;
  const v1 = 0.78;
  p.box(0.08, 0.1, 0.92, 0.94, 0, 1.4, mat(C.paving));
  // Front garden strip with a hedge.
  p.top(0.1, 0.8, 0.9, 0.92, 1.45, C.sage);
  p.box(0.1, 0.88, 0.4, 0.93, 1.4, 4, mat(C.sageDark));
  p.box(0.62, 0.88, 0.9, 0.93, 1.4, 4, mat(C.sageDark));
  const top = 2 + floors * 14;
  p.box(u0, v0, u1, v1, 1.4, top, wall);
  p.front(u0, u1, 1.4, 4, v1, p.frontC(mat(C.stoneDark)));
  p.door(0.44, 0.56, 1.4, 11.5, v1, shade(shut, -0.2));
  for (let f = 0; f < floors; f++) {
    const z0 = 5 + f * 14;
    const cols = f === 0 ? [0.22, 0.66] : [0.22, 0.44, 0.66];
    for (const u of cols) {
      p.win(u, u + 0.12, z0 + (f === 0 ? 1 : 2), z0 + 9, v1);
      if (f > 0) {
        p.front(u - 0.03, u, z0 + 2, z0 + 9, v1, shut);
        p.front(u + 0.12, u + 0.15, z0 + 2, z0 + 9, v1, shut);
      }
    }
    p.winSide(0.24, 0.38, z0 + 2, z0 + 9, u1);
    p.winSide(0.52, 0.66, z0 + 2, z0 + 9, u1);
  }
  if (variant % 4 === 1) p.gable(u0, v0, u1, v1, top, 10, 'v', ROOF, wall);
  else if (variant % 4 === 3) p.gable(u0, v0, u1, v1, top, 9, 'u', ROOF, wall);
  else p.hip(u0 - 0.01, v0 - 0.01, u1 + 0.01, v1 + 0.01, top, 9, 0.2, ROOF);
  p.box(0.64, 0.26, 0.72, 0.34, top + 2, top + 11, mat('#D9A47E'));
  p.box(0.63, 0.25, 0.73, 0.35, top + 11, top + 12.2, mat(C.terracotta));
}

/** Grand Station spans two tiles along u. */
function station(p: Pen): void {
  const wall = mat('#F0E4CC');
  const trim = mat('#D9A47E');
  p.box(0.04, 0.08, 1.96, 0.94, 0, 2, STONE);
  // Steps.
  p.box(0.7, 0.84, 1.3, 0.98, 0, 1.2, STONE);
  p.box(0.08, 0.14, 1.92, 0.84, 2, 26, wall);
  // Arcade of tall arched windows.
  for (const u of [0.14, 0.36, 0.58, 1.26, 1.48, 1.7]) {
    p.arch(u, u + 0.16, 6, 17, 0.84);
    p.front(u - 0.02, u + 0.18, 4.6, 5.6, 0.84, p.frontC(trim));
  }
  for (const v of [0.24, 0.5]) p.winSide(v, v + 0.16, 6, 20, 1.92);
  p.front(0.08, 1.92, 23.5, 26, 0.84, p.frontC(trim));
  p.hip(0.06, 0.12, 1.94, 0.86, 26, 11, 0.3, ROOF);
  // Central clock pavilion.
  p.box(0.76, 0.2, 1.24, 0.88, 2, 40, wall);
  p.arch(0.86, 1.14, 2, 13, 0.88, '#2C2932');
  if (p.light) p.lightPoly('#FFD08A', [0.87, 0.88, 2, 1.13, 0.88, 2, 1.13, 0.88, 16, 0.87, 0.88, 16], 0.8);
  p.front(0.76, 1.24, 37.5, 40, 0.88, p.frontC(trim));
  p.round(1.0, 29, 0.11, 0.881, C.brassDark);
  p.round(1.0, 29, 0.09, 0.882, C.cream, true);
  p.line(C.ink, 0.6, [1.0, 0.883, 29, 1.0, 0.883, 32]);
  p.line(C.ink, 0.6, [1.0, 0.883, 29, 1.05, 0.883, 28]);
  p.winSide(0.36, 0.56, 22, 34, 1.24);
  p.gable(0.74, 0.18, 1.26, 0.9, 40, 12, 'v', ROOF, wall);
  p.post(1.0, 0.54, 52, 60, 0.6, C.brassDark);
  // Glass entrance canopy.
  p.poly('rgba(160,205,212,0.5)', [0.78, 0.88, 15, 1.22, 0.88, 15, 1.26, 1.02, 13, 0.74, 1.02, 13]);
  p.line(C.brassDark, 0.6, [0.74, 1.02, 13, 1.26, 1.02, 13]);
  p.glow(1.0, 0.98, 8, 26, 0.6);
}

function gardenPlot(p: Pen, variant: number): void {
  p.top(0.04, 0.04, 0.96, 0.96, 0.1, C.sage);
  p.poly(C.sageLight, [0.1, 0.5, 0.15, 0.5, 0.12, 0.15, 0.7, 0.4, 0.15, 0.35, 0.8, 0.15]);
  p.tree(0.28, 0.28, 1.25, variant % 2);
  p.tree(0.7, 0.36, 1.0, (variant + 1) % 2);
  p.tree(0.42, 0.72, 1.1, variant % 2);
  p.box(0.74, 0.74, 0.9, 0.8, 0.1, 2.4, WOOD);
}

// ───────────────────────────── Dispatch ─────────────────────────────

export type SceneKind = BuildKind | 'home' | 'station' | 'garden';

/** Sprite bounds in world px relative to the lot's north corner. */
export function spriteBox(kind: SceneKind): { left: number; top: number; w: number; h: number } {
  if (kind === 'station') return { left: -46, top: -70, w: 124, h: 132 };
  return { left: -46, top: -78, w: 92, h: 124 };
}

/** Rough height in world px, for shadows and labels. */
export function buildingHeight(kind: SceneKind, level: number): number {
  switch (kind) {
    case 'roastery': return [26, 40, 46][level - 1];
    case 'bistro': return [27, 41, 44][level - 1];
    case 'arcade': return [28, 40, 44][level - 1];
    case 'boutique': return [28, 42, 46][level - 1];
    case 'cinema': return [34, 42, 46][level - 1];
    case 'nightmarket': return [16, 17, 26][level - 1];
    case 'park': return 9;
    case 'tramstop': return 16;
    case 'plaza': return 6;
    case 'home': return 40;
    case 'station': return 40;
    default: return 12;
  }
}

/** Footprint that casts the ground shadow, in tile-local u/v. */
export function shadowFootprint(kind: SceneKind): [number, number, number, number] {
  switch (kind) {
    case 'station': return [0.08, 0.14, 1.92, 0.84];
    case 'boutique': return [0.2, 0.16, 0.8, 0.82];
    case 'bistro': return [0.12, 0.12, 0.88, 0.64];
    case 'park': return [0.2, 0.2, 0.5, 0.4];
    case 'plaza': return [0.4, 0.4, 0.6, 0.6];
    case 'tramstop': return [0.1, 0.3, 0.9, 0.72];
    case 'garden': return [0.2, 0.2, 0.75, 0.75];
    default: return [0.12, 0.14, 0.88, 0.84];
  }
}

/**
 * Civic projects (park, tram stop, plaza) are drawn at this scale about the centre of their
 * lot, which leaves a rim of ground for the House kerb that frames every owned lot.
 */
export const CIVIC_PLOT = 0.86;
const plotted = (u: number): number => 0.5 + (u - 0.5) * CIVIC_PLOT;

/**
 * Where the tall House banner stands, in tile-local u, v, z (already inside the civic plot):
 * the roof of a shop, the fountain of a plaza, the shelter of a tram stop, the back of a park.
 */
export function bannerAnchor(kind: BuildKind, level: number): [number, number, number] {
  switch (kind) {
    case 'park': return [plotted(0.86), plotted(0.14), 1.2];
    case 'tramstop': return [plotted(0.5), plotted(0.5), 17.4];
    case 'plaza': return [plotted(0.5), plotted(0.5), 13];
    // Hipped roofs carry the standard on the ridge, not out on a corner.
    case 'bistro': return level === 3 ? [0.82, 0.17, 32.6] : [0.42, 0.38, level === 1 ? 26.6 : 40.6];
    case 'roastery': return level === 2 ? [0.56, 0.5, 39.6] : flagAnchor(kind, level);
    default: return flagAnchor(kind, level);
  }
}

/**
 * The solid silhouettes of a building, as boxes [u0, v0, u1, v1, height] in tile-local units:
 * what hides the ground and the banners behind it.
 */
export function solidBoxes(kind: SceneKind, level: number): [number, number, number, number, number][] {
  const a = plotted(0.04);
  const b = plotted(0.96);
  switch (kind) {
    case 'park': return [[a, a, b, b, 1.2]];
    case 'plaza': return [[plotted(0.02), plotted(0.02), plotted(0.98), plotted(0.98), 1.4]];
    case 'tramstop': return [[a, a, b, b, 1.6], [plotted(0.1), plotted(0.3), plotted(0.9), plotted(0.72), 17]];
    case 'garden': return [];
    default: {
      const fp = shadowFootprint(kind);
      return [[fp[0], fp[1], fp[2], fp[3], buildingHeight(kind, level) * 0.92]];
    }
  }
}

/** Where the House pennant flies, in tile-local u, v, z. */
export function flagAnchor(kind: BuildKind, level: number): [number, number, number] {
  switch (kind) {
    case 'roastery': return [0.8, 0.22, level === 1 ? 19 : level === 2 ? 38 : 33];
    case 'bistro': return [0.84, 0.16, level === 1 ? 24 : level === 2 ? 38 : 33];
    case 'arcade': return [0.5, 0.5, level === 1 ? 28 : level === 2 ? 40 : 42];
    case 'boutique': return [0.72, 0.24, level === 1 ? 28 : level === 2 ? 42 : 44];
    case 'cinema': return [0.84, 0.18, level === 1 ? 24 : 31];
    case 'nightmarket': return [0.9, 0.1, level === 3 ? 30 : 23];
    default: return [0.5, 0.5, 0];
  }
}

export function drawScene(p: Pen, kind: SceneKind, level: number, house: number, variant: number): void {
  const h = houseTone(house);
  switch (kind) {
    case 'roastery': return roastery(p, level, h);
    case 'bistro': return bistro(p, level, h);
    case 'arcade': return arcade(p, level, h);
    case 'boutique': return boutique(p, level, h);
    case 'cinema': return cinema(p, level, h);
    case 'nightmarket': return nightmarket(p, level, h);
    case 'park':
    case 'tramstop':
    case 'plaza':
      // Civic projects sit inside the lot's House kerb.
      p.plot(CIVIC_PLOT);
      if (kind === 'park') park(p, level, h);
      else if (kind === 'tramstop') tramstop(p, level, h);
      else plaza(p, level, h);
      p.plot(1);
      return;
    case 'home': return townhouse(p, variant);
    case 'station': return station(p);
    case 'garden': return gardenPlot(p, variant);
    default: return;
  }
}
