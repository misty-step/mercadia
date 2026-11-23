// The city renderer: Canvas 2D, isometric 2:1, device-pixel aware.
// Frame order: ground → water shimmer → shadows → depth-sorted actors (each owned lot brings
// its House kerb, enclave wash and banner) → colour grade → light pass → weather → ownership
// relight (kerbs and banners restored to full House colour after the grade) → overlays →
// paper grain.
import { HOUSES, PROMO_TICKS, TRANSIT_RADIUS, auraRadius, buildCost, isShop } from '../shared/constants';
import { civicReach, eventHighlights } from '../shared/insight';
import { CITY, H, W, idx, tx, ty } from '../shared/map';
import type { BuildingView, CitizenView, CityView } from '../shared/protocol';
import { hash32, lotBonuses, loopPoint, queueCap, starsOf, stopTiles, trafficPips } from '../shared/sim';
import { CS, type BuildKind, type Fx, type TileKind } from '../shared/types';
import {
  C,
  HH,
  HW,
  Pen,
  bannerAnchor,
  buildingHeight,
  drawScene,
  houseTone,
  mat,
  shade,
  shadowFootprint,
  solidBoxes,
  spriteBox,
  type SceneKind,
} from './art';
import { BRASS, BRASS_DEEP, drawCrest } from './heraldry';

export interface UiState {
  me: number; // player index, -1 when spectating or in attract mode
  tool: BuildKind | null;
  hoverTile: number;
  selectedTile: number;
  selectedCitizen: number;
  /** The last pointer was a finger: build previews take a first tap, building a second. */
  touch?: boolean;
  /**
   * Founding Guide, step 1: vacant starter lots to mark with a gently pulsing warm brass ring
   * (drawn after the colour grade so they read at any hour). Empty or absent: no rings.
   */
  guideLots?: number[];
}

export type Pick = { kind: 'citizen'; id: number } | { kind: 'tile'; tile: number } | null;

interface Sprite {
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
  w: number;
  h: number;
}

interface Floater {
  kind: 'coin' | 'star' | 'turn' | 'text' | 'puff' | 'spark' | 'pill';
  x: number;
  y: number;
  z: number;
  t0: number;
  life: number;
  text?: string;
  color?: string;
}

interface CitVis {
  ox: number;
  oy: number;
  phase: number;
  seen: number;
}

interface Actor {
  d: number;
  // 0 building, 1 static scenery, 2 citizen, 3 tram, 4 lamp, 5 tree, 6 parapet, 7 boat, 8 ship,
  // 9 stop sign, 10 canal pennant line (Era II), 11 boulevard lamp (Era III), 12 harbor ferry (Era III)
  t: number;
  a: number; // payload index / id
  b?: BuildingView;
  c?: CitizenView;
}

/** One owned lot, as the ownership passes see it. Rebuilt only when the district's layout changes. */
interface OwnTile {
  b: BuildingView;
  x: number;
  y: number;
  house: number;
  civic: boolean;
  /** Same-owner neighbour to the north, east, south, west: no kerb on that edge. */
  open: [boolean, boolean, boolean, boolean];
  /** Concave enclave corners (NE, SE, SW, NW) that need a turning piece of kerb. */
  inner: [boolean, boolean, boolean, boolean];
  /** Part of an enclave of two or more joined lots. */
  joined: boolean;
  /** Everything outside this building's own silhouette (clips for ground-level relighting). */
  self: Path2D[];
  /** Everything outside each nearer building's silhouette (clips for relighting kerb and banner). */
  front: Path2D[];
}

/** A canal-side pennant line between two quay posts (tile space), with its sort depth. */
interface PennantLine {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  d: number;
}

const wxOf = (x: number, y: number): number => (x - y) * HW;
const wyOf = (x: number, y: number, z = 0): number => (x + y) * HH - z;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

const isRoad = (k: TileKind | undefined): boolean => k === 'avenue' || k === 'avbridge' || k === 'lane' || k === 'bridge';
const isWater = (k: TileKind | undefined): boolean => k === 'canal' || k === 'bridge' || k === 'avbridge';
const kindAt = (x: number, y: number): TileKind | undefined => (x >= 0 && y >= 0 && x < W && y < H ? CITY.tiles[idx(x, y)] : undefined);

// World bounds of the diorama (px at zoom 1).
const LAND_X0 = -0.45;
const LAND_X1 = 12.45;
const LAND_Y0 = -0.45;
const QUAY_Y = 12;
const HARBOR_Y1 = 14.1;
const SLAB = 15;
const WATER_Z = -5;
const G_LEFT = -490;
const G_TOP = -40;
const G_W = 940;
const G_H = 530;
export const WORLD = { cx: -20, cy: 190, w: 900, h: 560 };
/** The true left and right tips of the island slab in world px: harbor corner to station corner. */
const TIP_LEFT = (LAND_X0 - HARBOR_Y1) * 32;
const TIP_RIGHT = (LAND_X1 - LAND_Y0) * 32;
const INK = '#1E1A16';
const CREAM = '#FAF7F0';
/** Festive but House-neutral: canal pennants and garlands never borrow a House colour. */
const PENNANT_TONES = ['#F7EFDF', '#C86443', '#D4A34A', '#84A98C', '#7FBCC6'];
/** Enclave wash strength over the paving, and the extra depth along a shared boundary. */
const WASH = 0.3;
const WASH_SEAM = 0.2;
/**
 * How much of what the colour grade removed is given back to the ground-level ownership marks
 * at dusk. Kerbs are paint, not lamps: they come back strong enough to read at a glance and
 * stop short of glowing. (Banners are redrawn at full colour.)
 */
const KERB_RELIGHT = 0.62;
const WASH_RELIGHT = 0.4;
/** Perpendicular world px across an isometric edge per tile unit of inset. */
const EDGE_PX = (2 * HW * HH) / Math.hypot(HW, HH);

const GRADE: { p: number; c: [number, number, number]; n: number }[] = [
  { p: 0.0, c: [255, 224, 192], n: 0.3 }, // dawn
  { p: 0.07, c: [255, 234, 208], n: 0 }, // morning amber
  { p: 0.25, c: [255, 246, 232], n: 0 },
  { p: 0.38, c: [255, 255, 255], n: 0 }, // crisp noon
  { p: 0.5, c: [255, 249, 236], n: 0 },
  { p: 0.62, c: [255, 233, 198], n: 0 }, // golden hour
  { p: 0.74, c: [253, 210, 168], n: 0.15 },
  { p: 0.81, c: [214, 162, 164], n: 0.7 }, // dusk rose
  { p: 0.89, c: [146, 150, 202], n: 1 }, // twilight
  { p: 1.0, c: [124, 130, 190], n: 1 },
];

const COATS: Record<string, string[]> = {
  commuter: ['#4E5D73', '#5B6B7A', '#3E4A5C', '#6B7686'],
  local: ['#84A98C', '#C9A66B', '#B5835A', '#7A9E9F', '#D9B48A'],
  foodie: ['#C86443', '#D98E5F', '#A9502F', '#E0A070'],
  tourist: ['#F0E2C8', '#E9C46A', '#F7EFDF', '#9DBDE6', '#F0A39B'],
  nightowl: ['#5A4E6B', '#3F3A4F', '#7A4E5F', '#2F3B4F'],
};
const SKIN = ['#F1D3B8', '#E0B894', '#C69472', '#9A6B4C', '#7A5038'];
const HAIR = ['#2E2622', '#5A3B28', '#8A6A42', '#C9B08A', '#1E1A16', '#7A7570'];

const MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';
const SANS = '"DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

export class Renderer {
  ctx: CanvasRenderingContext2D;
  /** True once the renderer has fallen back to a CPU-backed canvas. */
  cpu = false;
  cam = { x: WORLD.cx, y: WORLD.cy, zoom: 1.4 };
  dpr = 1;
  width = 0;
  height = 0;
  /** Viewport insets the HUD occupies, so "fit" centres the city in the free area. */
  insets = { top: 56, right: 0, bottom: 84, left: 0 };

  private res = 0;
  private sprites = new Map<string, Sprite>();
  private ground: HTMLCanvasElement | null = null;
  private groundKey = '';
  private grain: CanvasPattern | null = null;
  private glowSprite: HTMLCanvasElement | null = null;
  private floaters: Floater[] = [];
  private vis = new Map<number, CitVis>();
  private built = new Map<number, number>(); // tile → time a building landed
  private pulse = new Map<number, number>(); // building id → time of last upgrade sparkle
  private actors: Actor[] = [];
  private scenery: Actor[] = [];
  private lamps: [number, number][] = [];
  private trees: [number, number, number][] = [];
  private pen: Pen;
  private shipT = 0;
  private lanternA = 0;
  private rainA = 0;
  private lastNow = 0;
  private night = 0;
  private frameNo = 0;
  // ── Ownership (kerbs, enclaves, banners) ──
  private own: OwnTile[] = [];
  private ownAt = new Map<number, OwnTile>();
  private ownRev = -1;
  private layoutKey = '';
  private layoutRev = 0;
  private flagship = new Map<number, number>(); // owner → building id of its flagship shop
  private stars: number[] = []; // Dynasty Milestones per player
  /** Multiply tint of the colour grade this frame, per channel 0..1. */
  private tint: [number, number, number] = [1, 1, 1];
  /** How far the grade has pulled colours from true (0 at noon, 1 at dusk): relight strength. */
  private relit = 0;
  // ── Era maturation ──
  private era = 1;
  private pennants: PennantLine[] = [];
  private grandLamps: [number, number, number][] = []; // x, y, garland-to index or -1
  private shimmer = { t0: -1e9, era: 0 };
  // ── Camera glide (Chronicle click-to-focus) and pause detection ──
  private glide: { x0: number; y0: number; x1: number; y1: number; t0: number; dur: number; lx: number; ly: number } | null = null;
  private seenTick = -1;
  private seenTickAt = 0;
  /** True when the simulation has stood still for a moment (Era Council, solo pause). */
  private frozen = false;
  /** Rolling stage timings in ms, for the smoke check and tuning. */
  perf: Record<string, number> = {};
  /** Stages to skip, for diagnosing slow frames (e.g. skip.add('grain')). */
  skip = new Set<string>();
  private mark(name: string, t0: number): number {
    const t1 = performance.now();
    this.perf[name] = (this.perf[name] ?? 0) * 0.9 + (t1 - t0) * 0.1;
    return t1;
  }

  constructor(public canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.pen = new Pen(ctx);
    this.layoutScenery();
    this.resize();
  }

  /**
   * Some machines expose a "GPU" that is really a slow software emulation, and an accelerated
   * canvas crawls there. Swap to a CPU-backed canvas, which those machines draw quickly.
   */
  useCpuCanvas(): boolean {
    if (this.cpu) return false;
    const fresh = document.createElement('canvas');
    const ctx = fresh.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx) return false;
    fresh.id = this.canvas.id;
    fresh.className = this.canvas.className;
    const label = this.canvas.getAttribute('aria-label');
    if (label) fresh.setAttribute('aria-label', label);
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    this.ctx = ctx;
    this.pen = new Pen(ctx);
    this.cpu = true;
    this.width = 0;
    this.sprites.clear();
    this.ground = null;
    this.groundKey = '';
    this.grain = null;
    this.glowSprite = null;
    this.resize();
    return true;
  }

  // ───────────────────────────── Camera ─────────────────────────────

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight));
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  fitZoom(): number {
    const fw = this.width - this.insets.left - this.insets.right;
    const fh = this.height - this.insets.top - this.insets.bottom;
    return clamp(Math.min(fw / WORLD.w, fh / WORLD.h), 0.34, 2.6);
  }

  fit(): void {
    // Fit means the whole island, tip to tip. In portrait the width is the limit, so the view
    // is centred on the slab itself and neither the harbor corner nor the station corner crops.
    this.glide = null;
    this.cam.zoom = this.fitZoom();
    const portrait = this.height > this.width;
    const cx = portrait ? (TIP_LEFT + TIP_RIGHT) / 2 : WORLD.cx;
    this.cam.x = cx + (this.insets.right - this.insets.left) / 2 / this.cam.zoom;
    this.cam.y = WORLD.cy + (this.insets.bottom - this.insets.top) / 2 / this.cam.zoom;
  }

  /** Screen x of the island's left and right tips (for fit checks). */
  islandSpan(): { left: number; right: number; width: number } {
    return { left: this.worldToScreen(TIP_LEFT, 0).x, right: this.worldToScreen(TIP_RIGHT, 0).x, width: this.width };
  }

  pan(dxScreen: number, dyScreen: number): void {
    // Any pan of the player's own (drag, keys, the Inspector's reveal) ends a camera glide.
    if (dxScreen || dyScreen) this.glide = null;
    this.cam.x = clamp(this.cam.x - dxScreen / this.cam.zoom, WORLD.cx - 470, WORLD.cx + 470);
    this.cam.y = clamp(this.cam.y - dyScreen / this.cam.zoom, WORLD.cy - 300, WORLD.cy + 300);
  }

  /**
   * Glide the camera so a tile sits at the centre of the free city area (the Chronicle's
   * click-to-focus): an eased pan of about 450 ms. A drag, a zoom or Fit cancels it.
   */
  panTo(tile: number): void {
    if (tile < 0 || tile >= W * H) return;
    const p = this.tileToScreen((tile % W) + 0.5, Math.floor(tile / W) + 0.5);
    const cx = this.insets.left + (this.width - this.insets.left - this.insets.right) / 2;
    const cy = this.insets.top + (this.height - this.insets.top - this.insets.bottom) / 2;
    const x1 = clamp(this.cam.x - (cx - p.x) / this.cam.zoom, WORLD.cx - 470, WORLD.cx + 470);
    const y1 = clamp(this.cam.y - (cy - p.y) / this.cam.zoom, WORLD.cy - 300, WORLD.cy + 300);
    if (Math.hypot(x1 - this.cam.x, y1 - this.cam.y) * this.cam.zoom < 1.5) return;
    this.glide = { x0: this.cam.x, y0: this.cam.y, x1, y1, t0: performance.now(), dur: 450, lx: this.cam.x, ly: this.cam.y };
  }

  /** True while a click-to-focus glide is under way. */
  get gliding(): boolean {
    return this.glide !== null;
  }

  private stepGlide(): void {
    const gl = this.glide;
    if (!gl) return;
    // Something else moved the camera (a screenshot hook, a resize): the glide yields.
    if (Math.abs(this.cam.x - gl.lx) > 0.01 || Math.abs(this.cam.y - gl.ly) > 0.01) {
      this.glide = null;
      return;
    }
    const k = clamp((performance.now() - gl.t0) / gl.dur, 0, 1);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease in-out cubic
    this.cam.x = lerp(gl.x0, gl.x1, e);
    this.cam.y = lerp(gl.y0, gl.y1, e);
    gl.lx = this.cam.x;
    gl.ly = this.cam.y;
    if (k >= 1) this.glide = null;
  }

  zoomAt(factor: number, sx: number, sy: number): void {
    this.glide = null;
    const before = this.screenToWorld(sx, sy);
    this.cam.zoom = clamp(this.cam.zoom * factor, Math.min(0.5, this.fitZoom() * 0.8), 3.4);
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.pan(0, 0);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.width / 2) / this.cam.zoom + this.cam.x, y: (sy - this.height / 2) / this.cam.zoom + this.cam.y };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.cam.x) * this.cam.zoom + this.width / 2, y: (wy - this.cam.y) * this.cam.zoom + this.height / 2 };
  }

  /** Screen position of a point in tile space. */
  tileToScreen(x: number, y: number, z = 0): { x: number; y: number } {
    return this.worldToScreen(wxOf(x, y), wyOf(x, y, z));
  }

  private setWorld(): void {
    const s = this.cam.zoom * this.dpr;
    this.ctx.setTransform(s, 0, 0, s, (this.width / 2 - this.cam.x * this.cam.zoom) * this.dpr, (this.height / 2 - this.cam.y * this.cam.zoom) * this.dpr);
  }

  private setScreen(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // ───────────────────────────── Static scenery ─────────────────────────────

  private layoutScenery(): void {
    CITY.homes.forEach((t) => this.scenery.push({ d: tx(t) + ty(t) + 1, t: 1, a: t }));
    CITY.tiles.forEach((k, t) => {
      if (k === 'garden') this.scenery.push({ d: tx(t) + ty(t) + 1, t: 1, a: t });
    });
    // Grand Station: one sprite across two tiles, keyed to its front-west corner.
    this.scenery.push({ d: tx(CITY.station[0]) + ty(CITY.station[0]) + 1, t: 1, a: CITY.station[0] });
    // Lamps along the lanes and at the avenue corners.
    for (const t of CITY.walkable) {
      const x = tx(t);
      const y = ty(t);
      const k = CITY.tiles[t];
      if (k === 'lane' && x % 2 === 0) this.lamps.push([x + 0.5, y + 0.07]);
      if (k === 'avenue' && (x === 1 || x === 11) && (y === 1 || y === 11)) this.lamps.push([x + (x === 1 ? 0.1 : 0.9), y + (y === 1 ? 0.1 : 0.9)]);
      if (k === 'avenue' && y === 1 && x % 3 === 0) this.lamps.push([x + 0.5, y + 0.08]);
      if (k === 'avenue' && x === 1 && y % 3 === 0) this.lamps.push([x + 0.08, y + 0.5]);
    }
    // A tree line along the harbor front and the eastern edge.
    for (let x = 1; x <= 11; x++) if (x % 2 === 0 && x !== 4) this.trees.push([x + 0.5, 11.9, 0.85]);
    for (let y = 2; y <= 10; y += 2) this.trees.push([11.9, y + 0.5, 0.85]);
    this.lamps.forEach((l, i) => this.scenery.push({ d: l[0] + l[1], t: 4, a: i }));
    this.trees.forEach((l, i) => this.scenery.push({ d: l[0] + l[1], t: 5, a: i }));
    // Near parapets of the four bridges.
    for (const t of CITY.bridges) this.scenery.push({ d: tx(t) + ty(t) + 1.32, t: 6, a: t });
    // City tram stop signs.
    CITY.fixedStops.forEach((t, i) => this.scenery.push({ d: tx(t) + ty(t) + (i === 0 ? 0.2 : 1.6), t: 9, a: t }));
    // Moored boats.
    this.scenery.push({ d: 9.2 + 13.2, t: 7, a: 0 }, { d: 10.6 + 12.9, t: 7, a: 1 }, { d: 1.4 + 13.1, t: 7, a: 2 });
    this.scenery.push({ d: 30, t: 8, a: 0 });
    // ── Era maturation (laid out once, shown from the era that brings them) ──
    // Era II: pennant lines strung along every quay of the Grand Canal.
    for (const t of CITY.canal) {
      if (CITY.tiles[t] !== 'canal') continue;
      const x = tx(t);
      const y = ty(t);
      if (!isWater(kindAt(x - 1, y))) this.pennants.push({ ax: x + 0.03, ay: y, bx: x + 0.03, by: y + 1, d: x + y + 0.52 });
      if (!isWater(kindAt(x + 1, y))) this.pennants.push({ ax: x + 0.97, ay: y, bx: x + 0.97, by: y + 1, d: x + y + 1.46 });
      if (!isWater(kindAt(x, y - 1)) && y > 0) this.pennants.push({ ax: x, ay: y + 0.03, bx: x + 1, by: y + 0.03, d: x + y + 0.52 });
      if (!isWater(kindAt(x, y + 1))) this.pennants.push({ ax: x, ay: y + 0.97, bx: x + 1, by: y + 0.97, d: x + y + 1.46 });
    }
    // Era III: grand brass lamps along the boulevard (Era IV strings gilded garlands between them).
    const row = (pts: [number, number][]): void => {
      pts.forEach((q, i) => this.grandLamps.push([q[0], q[1], i + 1 < pts.length ? this.grandLamps.length + 1 : -1]));
    };
    row([[1.5, 11.93], [5.5, 11.93], [9.5, 11.93], [11.5, 11.93]]);
    row([[11.93, 3.5], [11.93, 5.5], [11.93, 7.5], [11.93, 9.5]]);
    row([[2.5, 1.07], [4.5, 1.07], [7.5, 1.07], [10.5, 1.07]]);
    row([[1.07, 4.5], [1.07, 7.5], [1.07, 10.5]]);
  }

  // ───────────────────────────── Sprites ─────────────────────────────

  private pickRes(): number {
    const want = this.cam.zoom * this.dpr;
    for (const r of [1, 1.5, 2, 3]) if (r >= want - 0.01) return r;
    return 3.5;
  }

  private sprite(kind: SceneKind, level: number, house: number, variant: number, flip: boolean, light: boolean): Sprite {
    const key = `${kind}|${level}|${house}|${variant}|${flip ? 1 : 0}|${light ? 1 : 0}`;
    let sp = this.sprites.get(key);
    if (sp) return sp;
    const box = spriteBox(kind);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(box.w * this.res);
    canvas.height = Math.ceil(box.h * this.res);
    const g = canvas.getContext('2d', { willReadFrequently: this.cpu }) as CanvasRenderingContext2D;
    g.setTransform(this.res, 0, 0, this.res, -box.left * this.res, -box.top * this.res);
    const pen = new Pen(g);
    pen.begin(flip, light, variant * 7 + level * 13 + house * 31 + 5);
    drawScene(pen, kind, level, house, variant);
    sp = { canvas, left: box.left, top: box.top, w: box.w, h: box.h };
    this.sprites.set(key, sp);
    return sp;
  }

  private blit(sp: Sprite, x: number, y: number, dz = 0): void {
    this.ctx.drawImage(sp.canvas, wxOf(x, y) + sp.left, wyOf(x, y) + sp.top - dz, sp.w, sp.h);
  }

  // ───────────────────────────── Ground ─────────────────────────────

  private poly(g: CanvasRenderingContext2D, fill: string, pts: number[]): void {
    g.beginPath();
    g.moveTo(wxOf(pts[0], pts[1]), wyOf(pts[0], pts[1], pts[2]));
    for (let i = 3; i < pts.length; i += 3) g.lineTo(wxOf(pts[i], pts[i + 1]), wyOf(pts[i], pts[i + 1], pts[i + 2]));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  }

  private rect(g: CanvasRenderingContext2D, fill: string, x0: number, y0: number, x1: number, y1: number, z = 0): void {
    this.poly(g, fill, [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]);
  }

  private stroke(g: CanvasRenderingContext2D, color: string, width: number, pts: number[]): void {
    g.beginPath();
    g.moveTo(wxOf(pts[0], pts[1]), wyOf(pts[0], pts[1], pts[2]));
    for (let i = 3; i < pts.length; i += 3) g.lineTo(wxOf(pts[i], pts[i + 1]), wyOf(pts[i], pts[i + 1], pts[i + 2]));
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
  }

  private bridgeZ(t: number): number {
    return 4.6 * Math.sin(Math.PI * clamp(t, 0, 1));
  }

  private renderGround(view: CityView): void {
    const canvas = this.ground ?? document.createElement('canvas');
    const res = Math.min(this.res, 3);
    canvas.width = Math.ceil(G_W * res);
    canvas.height = Math.ceil(G_H * res);
    const g = canvas.getContext('2d', { willReadFrequently: this.cpu }) as CanvasRenderingContext2D;
    g.setTransform(res, 0, 0, res, -G_LEFT * res, -G_TOP * res);
    g.lineCap = 'butt';
    g.lineJoin = 'round';

    // ── Slab: side faces, land, harbor ──
    const stoneSide = mat('#D2C6AE');
    // South face under the harbor: a cut through water.
    this.poly(g, '#2C6C7B', [LAND_X0, HARBOR_Y1, WATER_Z, LAND_X1, HARBOR_Y1, WATER_Z, LAND_X1, HARBOR_Y1, -SLAB, LAND_X0, HARBOR_Y1, -SLAB]);
    this.poly(g, 'rgba(255,255,255,0.10)', [LAND_X0, HARBOR_Y1, WATER_Z, LAND_X1, HARBOR_Y1, WATER_Z, LAND_X1, HARBOR_Y1, WATER_Z - 2.2, LAND_X0, HARBOR_Y1, WATER_Z - 2.2]);
    // East face: stone for the land, water for the harbor.
    this.poly(g, stoneSide.right, [LAND_X1, LAND_Y0, 0, LAND_X1, QUAY_Y, 0, LAND_X1, QUAY_Y, -SLAB, LAND_X1, LAND_Y0, -SLAB]);
    this.poly(g, shade('#D2C6AE', -0.3), [LAND_X1, LAND_Y0, -SLAB + 3, LAND_X1, QUAY_Y, -SLAB + 3, LAND_X1, QUAY_Y, -SLAB, LAND_X1, LAND_Y0, -SLAB]);
    this.poly(g, '#245D6B', [LAND_X1, QUAY_Y, WATER_Z, LAND_X1, HARBOR_Y1, WATER_Z, LAND_X1, HARBOR_Y1, -SLAB, LAND_X1, QUAY_Y, -SLAB]);
    // Land.
    this.rect(g, C.paving, LAND_X0, LAND_Y0, LAND_X1, QUAY_Y);
    // Harbor water and the quay wall.
    this.rect(g, C.canal, LAND_X0, QUAY_Y, LAND_X1, HARBOR_Y1, WATER_Z);
    this.poly(g, C.canalDeep, [LAND_X0, QUAY_Y, WATER_Z, LAND_X1, QUAY_Y, WATER_Z, LAND_X1, QUAY_Y + 0.5, WATER_Z, LAND_X0, QUAY_Y + 0.5, WATER_Z]);
    this.poly(g, stoneSide.left, [LAND_X0, QUAY_Y, 0, LAND_X1, QUAY_Y, 0, LAND_X1, QUAY_Y, WATER_Z, LAND_X0, QUAY_Y, WATER_Z]);
    // Where the canal meets the harbor under the avenue bridge.
    this.archFace(g, 7, 8, QUAY_Y, true);

    // ── Tiles, back to front ──
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) this.groundTile(g, view, x, y);
    }
    // Quay coping and bollards.
    this.stroke(g, '#F4EDDE', 1.2, [LAND_X0, QUAY_Y, 0.1, 7, QUAY_Y, 0.1]);
    this.stroke(g, '#F4EDDE', 1.2, [8, QUAY_Y, 0.1, LAND_X1, QUAY_Y, 0.1]);
    for (let x = 0.5; x < 12.4; x += 1) {
      if (x > 6.9 && x < 8.1) continue;
      g.fillStyle = '#4A4A52';
      g.fillRect(wxOf(x, QUAY_Y - 0.04) - 0.8, wyOf(x, QUAY_Y - 0.04, 2.4), 1.6, 2.4);
    }
    // ── Harbor Pier ──
    const deck = mat('#A9825A');
    for (let y = 12.3; y < 13.6; y += 0.4) {
      for (const x of [3.22, 3.78]) {
        g.fillStyle = C.woodDark;
        g.fillRect(wxOf(x, y) - 0.8, wyOf(x, y, 0), 1.6, 6);
      }
    }
    this.poly(g, deck.left, [3.2, 13.6, 0, 3.8, 13.6, 0, 3.8, 13.6, -1.6, 3.2, 13.6, -1.6]);
    this.poly(g, deck.right, [3.8, 12, 0, 3.8, 13.6, 0, 3.8, 13.6, -1.6, 3.8, 12, -1.6]);
    this.rect(g, deck.top, 3.2, 11.98, 3.8, 13.6, 0);
    for (let y = 12.15; y < 13.6; y += 0.15) this.stroke(g, 'rgba(90,60,40,0.3)', 0.35, [3.2, y, 0.05, 3.8, y, 0.05]);
    // Gangway head and a harbor-master hut.
    const hut = mat('#F0E4CC');
    this.poly(g, hut.right, [3.75, 13.1, 0, 3.75, 13.5, 0, 3.75, 13.5, 7, 3.75, 13.1, 7]);
    this.poly(g, hut.left, [3.3, 13.5, 0, 3.75, 13.5, 0, 3.75, 13.5, 7, 3.3, 13.5, 7]);
    this.poly(g, mat(C.terracotta).top, [3.25, 13.05, 7, 3.8, 13.05, 7, 3.8, 13.55, 7, 3.25, 13.55, 7]);
    this.poly(g, C.glass, [3.42, 13.5, 2.5, 3.62, 13.5, 2.5, 3.62, 13.5, 5.5, 3.42, 13.5, 5.5]);

    this.ground = canvas;
  }

  /** A stone face with an arched opening where water passes under a deck. */
  private archFace(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, deep: boolean): void {
    const m = mat('#D2C6AE');
    this.poly(g, m.left, [x0, y, 0, x1, y, 0, x1, y, WATER_Z, x0, y, WATER_Z]);
    const pts: number[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      pts.push(x0 + 0.12 + 0.76 * t, y, WATER_Z + 3.9 * Math.sin(Math.PI * t));
    }
    this.poly(g, deep ? '#1F4F5C' : '#285F6C', pts);
  }

  private groundTile(g: CanvasRenderingContext2D, view: CityView, x: number, y: number): void {
    const k = CITY.tiles[idx(x, y)];
    const t = idx(x, y);
    switch (k) {
      case 'canal':
      case 'bridge':
      case 'avbridge': {
        if (k === 'avbridge') {
          this.roadTile(g, x, y, 'avenue');
          // Parapet on the far (north) side; the near one is an actor.
          this.poly(g, mat(C.stone).left, [x, y + 0.03, 0, x + 1, y + 0.03, 0, x + 1, y + 0.03, 3, x, y + 0.03, 3]);
          this.poly(g, mat(C.stone).top, [x, y, 3, x + 1, y, 3, x + 1, y + 0.05, 3, x, y + 0.05, 3]);
          break;
        }
        this.rect(g, C.canal, x, y, x + 1, y + 1, WATER_Z);
        const north = kindAt(x, y - 1);
        const west = kindAt(x - 1, y);
        if (!isWater(north)) {
          this.poly(g, shade('#D2C6AE', -0.12), [x, y, 0, x + 1, y, 0, x + 1, y, WATER_Z, x, y, WATER_Z]);
          this.poly(g, 'rgba(30,70,80,0.35)', [x, y, WATER_Z + 1.4, x + 1, y, WATER_Z + 1.4, x + 1, y, WATER_Z, x, y, WATER_Z]);
        } else if (north === 'avbridge') this.archFace(g, x, x + 1, y, false);
        if (!isWater(west)) {
          this.poly(g, shade('#D2C6AE', 0.02), [x, y, 0, x, y + 1, 0, x, y + 1, WATER_Z, x, y, WATER_Z]);
          this.poly(g, 'rgba(30,70,80,0.3)', [x, y, WATER_Z + 1.4, x, y + 1, WATER_Z + 1.4, x, y + 1, WATER_Z, x, y, WATER_Z]);
        }
        // Shade along the near quay walls, which lean over the water.
        if (!isWater(kindAt(x, y + 1))) this.rect(g, 'rgba(25,60,72,0.28)', x, y + 0.84, x + 1, y + 1, WATER_Z);
        if (!isWater(kindAt(x + 1, y))) this.rect(g, 'rgba(25,60,72,0.22)', x + 0.84, y, x + 1, y + 1, WATER_Z);
        if (k === 'bridge') this.footbridge(g, x, y);
        break;
      }
      case 'avenue':
      case 'lane':
        this.roadTile(g, x, y, k);
        break;
      case 'lot': {
        const b = view.buildingAt(t);
        if (b) {
          // An owned lot is a clean paved pad; its House kerb and enclave wash are drawn with
          // the building (ownership passes), so they sort correctly and stay bright at dusk.
          this.rect(g, '#F1E9D8', x + 0.005, y + 0.005, x + 0.995, y + 0.995);
          this.rect(g, C.paving, x + 0.03, y + 0.03, x + 0.97, y + 0.97);
        } else {
          // A vacant plot: sage turf inside a cream kerb.
          this.rect(g, '#F1E9D8', x + 0.03, y + 0.03, x + 0.97, y + 0.97);
          this.rect(g, C.sage, x + 0.07, y + 0.07, x + 0.93, y + 0.93);
          const hsh = hash32(t, 77);
          const a = 0.16 + ((hsh % 30) / 100);
          this.poly(g, C.sageLight, [x + a, y + 0.2, 0, x + a + 0.42, y + 0.16, 0, x + a + 0.48, y + 0.5, 0, x + a + 0.1, y + 0.6, 0]);
          for (let i = 0; i < 5; i++) {
            const hh = hash32(t, i + 3);
            const px = x + 0.14 + ((hh % 72) / 100);
            const py = y + 0.14 + (((hh >>> 8) % 72) / 100);
            g.fillStyle = i % 2 ? C.sageDark : '#9BBB9B';
            g.fillRect(wxOf(px, py) - 0.6, wyOf(px, py) - 1.6, 1.2, 1.6);
          }
          // Lease stake.
          g.fillStyle = C.woodDark;
          g.fillRect(wxOf(x + 0.84, y + 0.84) - 0.35, wyOf(x + 0.84, y + 0.84, 5), 0.7, 5);
          g.fillStyle = C.cream;
          g.fillRect(wxOf(x + 0.84, y + 0.84) - 1.8, wyOf(x + 0.84, y + 0.84, 6.4), 3.6, 2.4);
        }
        break;
      }
      default:
        break; // homes, station and gardens bring their own pads
    }
  }

  private roadTile(g: CanvasRenderingContext2D, x: number, y: number, k: 'avenue' | 'lane'): void {
    const t = idx(x, y);
    const av = k === 'avenue';
    this.rect(g, av ? C.slate : '#5E626C', x, y, x + 1, y + 1);
    if (!av) {
      // Cobble flecks.
      for (let i = 0; i < 7; i++) {
        const hh = hash32(t, i + 11);
        const px = x + 0.22 + ((hh % 56) / 100);
        const py = y + 0.22 + (((hh >>> 8) % 56) / 100);
        this.rect(g, i % 2 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.09)', px, py, px + 0.07, py + 0.05);
      }
    }
    // Pavements wherever the neighbour is not a road.
    const sw = av ? 0.15 : 0.19;
    const kerb = '#C9BEA8';
    const n = isRoad(kindAt(x, y - 1));
    const s = isRoad(kindAt(x, y + 1));
    const w = isRoad(kindAt(x - 1, y));
    const e = isRoad(kindAt(x + 1, y));
    if (!n) {
      this.rect(g, kerb, x, y, x + 1, y + sw + 0.02);
      this.rect(g, C.paving, x, y, x + 1, y + sw);
    }
    if (!s) {
      this.rect(g, kerb, x, y + 1 - sw - 0.02, x + 1, y + 1);
      this.rect(g, C.paving, x, y + 1 - sw, x + 1, y + 1);
    }
    if (!w) {
      this.rect(g, kerb, x, y, x + sw + 0.02, y + 1);
      this.rect(g, C.paving, x, y, x + sw, y + 1);
    }
    if (!e) {
      this.rect(g, kerb, x + 1 - sw - 0.02, y, x + 1, y + 1);
      this.rect(g, C.paving, x + 1 - sw, y, x + 1, y + 1);
    }
    // Inner pavement corners at junctions.
    if (n && w && !isRoad(kindAt(x - 1, y - 1))) this.rect(g, C.paving, x, y, x + sw, y + sw);
    if (n && e && !isRoad(kindAt(x + 1, y - 1))) this.rect(g, C.paving, x + 1 - sw, y, x + 1, y + sw);
    if (s && w && !isRoad(kindAt(x - 1, y + 1))) this.rect(g, C.paving, x, y + 1 - sw, x + sw, y + 1);
    if (s && e && !isRoad(kindAt(x + 1, y + 1))) this.rect(g, C.paving, x + 1 - sw, y + 1 - sw, x + 1, y + 1);

    if (!av) {
      // Zebra where a lane meets the avenue.
      const west = kindAt(x - 1, y) === 'avenue';
      const east = kindAt(x + 1, y) === 'avenue';
      if (west || east) {
        const a = west ? x + 0.05 : x + 0.71;
        for (let i = 0; i < 4; i++) this.rect(g, 'rgba(247,239,223,0.88)', a, y + 0.24 + i * 0.145, a + 0.24, y + 0.24 + i * 0.145 + 0.075);
      }
      return;
    }
    // Brass rails on sleepers.
    const li = CITY.loopIndex[t];
    if (li >= 0) {
      const L = CITY.loop.length;
      const prev = CITY.loop[(li + L - 1) % L];
      const next = CITY.loop[(li + 1) % L];
      const ax = (tx(prev) + x) / 2 + 0.5;
      const ay = (ty(prev) + y) / 2 + 0.5;
      const bx = (tx(next) + x) / 2 + 0.5;
      const by = (ty(next) + y) / 2 + 0.5;
      const path = (): void => {
        g.beginPath();
        g.moveTo(wxOf(ax, ay), wyOf(ax, ay));
        g.quadraticCurveTo(wxOf(x + 0.5, y + 0.5), wyOf(x + 0.5, y + 0.5), wxOf(bx, by), wyOf(bx, by));
      };
      path();
      g.setLineDash([1.1, 2.6]);
      g.strokeStyle = '#353942';
      g.lineWidth = 8.2;
      g.stroke();
      g.setLineDash([]);
      path();
      g.strokeStyle = C.brass;
      g.lineWidth = 6.2;
      g.stroke();
      path();
      g.strokeStyle = C.slate;
      g.lineWidth = 4.4;
      g.stroke();
      path();
      g.setLineDash([1.1, 2.6]);
      g.strokeStyle = '#3B3F49';
      g.lineWidth = 4.4;
      g.stroke();
      g.setLineDash([]);
    }
    // Zebra at Grand Station and the Harbor Pier.
    if (t === CITY.stationDoor || t === CITY.pierTile) {
      for (let i = 0; i < 5; i++) this.rect(g, 'rgba(247,239,223,0.88)', x + 0.2 + i * 0.13, y + 0.2, x + 0.2 + i * 0.13 + 0.07, y + 0.8);
    }
    // Brass platform edge at city stops.
    if (CITY.fixedStops.includes(t)) {
      const top = y === 1;
      this.rect(g, C.brass, x + 0.06, top ? y + 0.11 : y + 0.855, x + 0.94, top ? y + 0.145 : y + 0.89);
    }
  }

  /** Arched stone footbridge carrying a lane (along x) over the canal. */
  private footbridge(g: CanvasRenderingContext2D, x: number, y: number): void {
    const stone = mat('#DDD2BC');
    const y0 = y + 0.2;
    const y1 = y + 0.8;
    const n = 10;
    // Far parapet.
    const far: number[] = [];
    for (let i = 0; i <= n; i++) far.push(x + i / n, y0, this.bridgeZ(i / n) + 3.2);
    for (let i = n; i >= 0; i--) far.push(x + i / n, y0, this.bridgeZ(i / n));
    this.poly(g, stone.left, far);
    // Deck.
    for (let i = 0; i < n; i++) {
      const a = i / n;
      const b = (i + 1) / n;
      const tone = 0.1 - (i / n) * 0.2;
      this.poly(g, shade('#E6DCC8', tone), [x + a, y0, this.bridgeZ(a), x + b, y0, this.bridgeZ(b), x + b, y1, this.bridgeZ(b), x + a, y1, this.bridgeZ(a)]);
    }
    // Near face with its arch.
    const face: number[] = [];
    for (let i = 0; i <= n; i++) face.push(x + i / n, y1, this.bridgeZ(i / n));
    for (let i = n; i >= 0; i--) {
      const t = i / n;
      face.push(x + 0.1 + 0.8 * t, y1, WATER_Z + 6.2 * Math.sin(Math.PI * t));
    }
    this.poly(g, stone.left, face);
    this.poly(g, shade(stone.left, -0.12), [x, y1, 0, x + 0.1, y1, WATER_Z, x, y1, WATER_Z]);
    this.poly(g, shade(stone.left, -0.12), [x + 1, y1, 0, x + 0.9, y1, WATER_Z, x + 1, y1, WATER_Z]);
  }

  // ───────────────────────────── Lighting ─────────────────────────────

  private grade(p: number, sunrise: boolean): { c: [number, number, number]; n: number } {
    let a = GRADE[0];
    let b = GRADE[GRADE.length - 1];
    for (let i = 0; i < GRADE.length - 1; i++) {
      if (p >= GRADE[i].p && p <= GRADE[i + 1].p) {
        a = GRADE[i];
        b = GRADE[i + 1];
        break;
      }
    }
    const t = b.p > a.p ? (p - a.p) / (b.p - a.p) : 0;
    const c: [number, number, number] = [lerp(a.c[0], b.c[0], t), lerp(a.c[1], b.c[1], t), lerp(a.c[2], b.c[2], t)];
    let n = lerp(a.n, b.n, t);
    // Sunrise: the last of the night drains out in the first moments of the day.
    if (sunrise && p < 0.035) {
      const k = p / 0.035;
      const last = GRADE[GRADE.length - 1];
      for (let i = 0; i < 3; i++) c[i] = lerp(last.c[i], c[i], k);
      n = lerp(1, n, k);
    }
    return { c, n };
  }

  /** Shadow offset in tile units per px of height. */
  private sun(p: number): { dx: number; dy: number; a: number } {
    const t = clamp(p / 0.86, 0, 1);
    let dx: number;
    let dy: number;
    if (t < 0.5) {
      const k = t / 0.5;
      dx = lerp(-0.3, 0.45, k);
      dy = lerp(1, 0.5, k);
    } else {
      const k = (t - 0.5) / 0.5;
      dx = lerp(0.45, 1, k);
      dy = lerp(0.5, -0.3, k);
    }
    const len = lerp(0.03, 0.011, Math.sin(Math.PI * t));
    const fade = p > 0.76 ? clamp(1 - (p - 0.76) / 0.1, 0, 1) : p < 0.03 ? p / 0.03 : 1;
    return { dx: dx * len, dy: dy * len, a: 0.24 * fade };
  }

  // ───────────────────────────── Feedback ─────────────────────────────

  /** Turn a simulation feedback event into something visible. */
  addFx(f: Fx, view: CityView, now: number): void {
    const at = (b: number): { x: number; y: number; z: number } | null => {
      const bv = view.building(b);
      return bv ? { x: tx(bv.tile) + 0.5, y: ty(bv.tile) + 0.5, z: buildingHeight(bv.kind, bv.level) + 4 } : null;
    };
    switch (f.k) {
      case 'coin': {
        const t = idx(Math.floor(f.x), Math.floor(f.y));
        const bv = view.buildingAt(t);
        const z = bv ? buildingHeight(bv.kind, bv.level) + 2 : 16;
        this.floaters.push({ kind: 'coin', x: f.x + (Math.random() - 0.5) * 0.3, y: f.y + (Math.random() - 0.5) * 0.3, z, t0: now, life: 1250, text: `+§${f.amt}`, color: HOUSES[view.players[f.p]?.house ?? 0].color });
        break;
      }
      case 'star':
        this.floaters.push({ kind: 'star', x: f.x, y: f.y, z: 13, t0: now, life: 1000 });
        break;
      case 'turn':
      case 'walkout':
        this.floaters.push({ kind: 'turn', x: f.x, y: f.y, z: 14, t0: now, life: 1300, text: f.k === 'turn' ? 'queue' : 'gave up' });
        break;
      case 'build':
        this.built.set(f.tile, now);
        for (let i = 0; i < 7; i++) this.floaters.push({ kind: 'puff', x: tx(f.tile) + 0.15 + Math.random() * 0.7, y: ty(f.tile) + 0.15 + Math.random() * 0.7, z: 1, t0: now + 140 + Math.random() * 80, life: 600 });
        break;
      case 'sell':
        for (let i = 0; i < 8; i++) this.floaters.push({ kind: 'puff', x: tx(f.tile) + 0.15 + Math.random() * 0.7, y: ty(f.tile) + 0.15 + Math.random() * 0.7, z: 2 + Math.random() * 10, t0: now + Math.random() * 100, life: 700 });
        break;
      case 'upgrade': {
        const p = at(f.b);
        if (!p) break;
        this.pulse.set(f.b, now);
        for (let i = 0; i < 10; i++) this.floaters.push({ kind: 'spark', x: p.x + (Math.random() - 0.5) * 0.9, y: p.y + (Math.random() - 0.5) * 0.9, z: 6 + Math.random() * p.z, t0: now + Math.random() * 350, life: 800 });
        this.floaters.push({ kind: 'text', x: p.x, y: p.y, z: p.z + 4, t0: now, life: 1500, text: 'LEVEL UP', color: C.brassDark });
        break;
      }
      case 'promo': {
        const p = at(f.b);
        if (p) this.floaters.push({ kind: 'pill', x: p.x, y: p.y, z: p.z + 12, t0: now, life: 1900, text: 'PROMO BLITZ', color: HOUSES[view.players[f.p]?.house ?? 0].color });
        break;
      }
      case 'restock': {
        const p = at(f.b);
        if (p) this.floaters.push({ kind: 'text', x: p.x, y: p.y, z: p.z + 2, t0: now, life: 1200, text: 'RESTOCKED', color: '#4B5A63' });
        break;
      }
      case 'award': {
        const p = at(f.b);
        if (!p) break;
        this.floaters.push({ kind: 'text', x: p.x, y: p.y, z: p.z + 8, t0: now, life: 3200, text: 'GOLDEN FORK', color: C.brassDark });
        for (let i = 0; i < 16; i++) this.floaters.push({ kind: 'spark', x: p.x + (Math.random() - 0.5) * 1.1, y: p.y + (Math.random() - 0.5) * 1.1, z: 6 + Math.random() * (p.z + 8), t0: now + Math.random() * 900, life: 900 });
        break;
      }
      case 'quarter':
        // A new era unlocks new tools: a brass shimmer crosses the district.
        if (f.q >= 2 && f.q <= 4) this.shimmer = { t0: now, era: f.q };
        break;
      default:
        break;
    }
    if (this.floaters.length > 160) this.floaters.splice(0, this.floaters.length - 160);
  }

  // ───────────────────────────── Frame ─────────────────────────────

  frame(view: CityView, alpha: number, ui: UiState, now: number): void {
    const g = this.ctx;
    const dt = Math.min(100, this.lastNow ? now - this.lastNow : 16);
    this.lastNow = now;
    this.frameNo++;
    this.resize();
    this.stepGlide();
    // The city stands still during an Era Council or a solo pause: walkers hold their stride.
    if (view.tick !== this.seenTick) {
      this.seenTick = view.tick;
      this.seenTickAt = now;
    }
    this.frozen = view.inCouncil || now - this.seenTickAt > 320;
    this.era = view.era;
    const res = this.pickRes();
    if (res !== this.res) {
      this.res = res;
      this.sprites.clear();
      this.groundKey = '';
    }
    this.syncOwnership(view);
    // The ground is redrawn only when a lot changes hands, not on every sale.
    const gkey = `${this.res}|${this.layoutRev}|${view.seed}`;
    if (gkey !== this.groundKey) {
      this.groundKey = gkey;
      this.renderGround(view);
    }

    const ev = view.event && view.event.started ? view.event.kind : null;
    const raining = ev === 'cloudburst';
    this.rainA = clamp(this.rainA + (raining ? dt : -dt) / 900, 0, 1);
    this.lanternA = clamp(this.lanternA + (ev === 'lantern' ? dt : -dt) / 1500, 0, 1);
    this.shipT = clamp(this.shipT + (ev === 'cruise' ? dt : -dt) / 5200, 0, 1);

    // The first morning of a match opens in daylight; later days begin with a sunrise.
    const gr = this.grade(view.dayPhase, view.quarter > 1);
    const night = clamp(gr.n + this.rainA * 0.22 + this.lanternA * 0.1, 0, 1);
    this.night = night;
    const t = now / 1000;
    const tR = Math.round(gr.c[0] * (1 - this.rainA * 0.14));
    const tG = Math.round(gr.c[1] * (1 - this.rainA * 0.08));
    const tB = Math.round(gr.c[2] * (1 - this.rainA * 0.02));
    const graded = !this.skip.has('grade') && !(tR === 255 && tG === 255 && tB === 255);
    this.tint = graded ? [tR / 255, tG / 255, tB / 255] : [1, 1, 1];
    // Relight strength: nothing at crisp noon, full once the grade has taken a quarter of any channel.
    this.relit = clamp((1 - Math.min(this.tint[0], this.tint[1], this.tint[2])) / 0.22, 0, 1);

    let tm = performance.now();
    // ── Page ──
    this.setScreen();
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = C.travertine;
    g.fillRect(0, 0, this.width, this.height);
    const base = this.tileToScreen(6.2, 13.6, -SLAB - 4);
    const rg = g.createRadialGradient(base.x, base.y, 10, base.x, base.y, 560 * this.cam.zoom);
    if (this.skip.has('page')) g.globalAlpha = 0;
    rg.addColorStop(0, 'rgba(120,96,70,0.20)');
    rg.addColorStop(0.5, 'rgba(120,96,70,0.07)');
    rg.addColorStop(1, 'rgba(120,96,70,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, this.width, this.height);
    g.globalAlpha = 1;

    // ── Ground ──
    this.setWorld();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    tm = this.mark('page', tm);
    if (this.ground && !this.skip.has('ground')) g.drawImage(this.ground, G_LEFT, G_TOP, G_W, G_H);
    tm = this.mark('ground', tm);
    if (!this.skip.has('water')) this.water(t);
    tm = this.mark('water', tm);

    // ── Shadows ──
    if (!this.skip.has('shadows')) this.shadows(view);
    tm = this.mark('shadows', tm);

    // ── Actors ──
    const actors = this.actors;
    actors.length = 0;
    for (const s of this.scenery) actors.push(s);
    for (const b of view.buildings) actors.push({ d: tx(b.tile) + ty(b.tile) + 1, t: 0, a: b.id, b });
    const seenTick = this.frameNo;
    for (const c of view.citizens.values()) {
      if (c.state === CS.Serve) continue;
      const x = lerp(c.px, c.x, alpha);
      const y = lerp(c.py, c.y, alpha);
      let v = this.vis.get(c.id);
      if (!v) {
        v = { ox: 0, oy: 0, phase: (c.id * 1.7) % 6.28, seen: seenTick };
        this.vis.set(c.id, v);
      }
      v.seen = seenTick;
      actors.push({ d: x + y + v.ox + v.oy, t: 2, a: c.id, c });
    }
    if (this.frameNo % 120 === 0) for (const [id, v] of this.vis) if (v.seen < seenTick - 2) this.vis.delete(id);
    view.trams.forEach((tr, i) => {
      const p = loopPoint(lerpLoop(tr.ppos, tr.pos, alpha));
      actors.push({ d: p.x + p.y + 0.05, t: 3, a: i });
    });
    // The district matures era by era: canal pennants, boulevard lamps and garlands, ferries.
    const eraOn = !this.skip.has('era');
    if (eraOn && this.era >= 2) this.pennants.forEach((l, i) => actors.push({ d: l.d, t: 10, a: i }));
    if (eraOn && this.era >= 3) {
      this.grandLamps.forEach((l, i) => actors.push({ d: l[0] + l[1], t: 11, a: i }));
      const ferries = this.era >= 4 ? 3 : 2;
      for (let i = 0; i < ferries; i++) {
        const f = this.ferryAt(i, now);
        actors.push({ d: f.x + f.y, t: 12, a: i });
      }
    }
    actors.sort((p, q) => p.d - q.d);
    if (!this.skip.has('actors')) for (const a of actors) this.drawActor(a, view, alpha, ui, now, dt, false);
    tm = this.mark('actors', tm);

    // ── Colour grade ──
    // One multiply wash, full strength over the diorama and feathered out to nothing at the
    // edges of the page: the model is lit, the table it stands on stays travertine.
    this.setScreen();
    const tint = `${tR},${tG},${tB}`;
    if (graded) {
      const mid = this.worldToScreen(WORLD.cx, WORLD.cy + 20);
      const r0 = 470 * this.cam.zoom;
      g.save();
      g.translate(mid.x, mid.y);
      g.scale(1, 0.66);
      const wash = g.createRadialGradient(0, 0, r0, 0, 0, r0 * 1.45);
      wash.addColorStop(0, `rgb(${tint})`);
      wash.addColorStop(1, 'rgb(255,255,255)');
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = wash;
      const reach = Math.max(this.width, this.height) * 3 + r0 * 2;
      g.fillRect(-reach, -reach, reach * 2, reach * 2);
      g.restore();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    tm = this.mark('grade', tm);

    // ── Light pass ──
    if (night > 0.02 && !this.skip.has('lights')) {
      this.setWorld();
      g.globalCompositeOperation = 'lighter';
      for (const a of actors) this.drawActor(a, view, alpha, ui, now, 0, true);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
    if (this.lanternA > 0.01) this.lanterns(t);
    if (this.rainA > 0.01) this.rain(t);
    tm = this.mark('lights', tm);

    // ── Ownership relight ──
    // Kerbs, enclave washes and banners were drawn with their buildings (so they sort and
    // occlude correctly); here, after the colour grade, they are brought back to full House
    // colour, which keeps ownership bright and unmistakable at dusk.
    this.setWorld();
    if (!this.skip.has('relight')) this.relight(view, now);
    tm = this.mark('relight', tm);

    // ── Overlays ──
    this.overlays(view, ui, now);
    this.drawFloaters(now);
    tm = this.mark('overlays', tm);

    // ── Paper grain ──
    this.setScreen();
    if (!this.grain) this.grain = this.makeGrain();
    if (this.grain && !this.skip.has('grain')) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.5;
      g.fillStyle = this.grain;
      g.fillRect(0, 0, this.width, this.height);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
    this.mark('grain', tm);
  }

  private makeGrain(): CanvasPattern | null {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const img = g.createImageData(128, 128);
    let seed = 1337;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = 236 + ((seed >>> 24) % 20);
      img.data[i] = v;
      img.data[i + 1] = v - 1;
      img.data[i + 2] = v - 4;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return this.ctx.createPattern(c, 'repeat');
  }

  // ───────────────────────────── Water ─────────────────────────────

  private water(t: number): void {
    const g = this.ctx;
    g.lineCap = 'round';
    const ripple = (x: number, y: number, seed: number, len: number): void => {
      const ph = (t * (0.35 + (seed % 7) * 0.05) + seed * 0.37) % 1;
      const a = Math.sin(Math.PI * ph);
      const px = wxOf(x, y) + (ph - 0.5) * 7;
      const py = wyOf(x, y, WATER_Z);
      g.globalAlpha = a * 0.55;
      g.beginPath();
      g.moveTo(px - len / 2, py);
      g.lineTo(px + len / 2, py);
      g.stroke();
    };
    g.strokeStyle = C.canalLight;
    g.lineWidth = 0.8;
    for (const tile of CITY.canal) {
      if (CITY.tiles[tile] === 'avbridge') continue;
      const x = tx(tile);
      const y = ty(tile);
      for (let i = 0; i < 4; i++) {
        const h = hash32(tile, i);
        ripple(x + 0.25 + ((h % 50) / 100), y + 0.2 + (((h >>> 8) % 60) / 100), h % 97, 4 + (h % 4));
      }
    }
    for (let i = 0; i < 46; i++) {
      const h = hash32(999, i);
      ripple(-0.2 + ((h % 1250) / 100), 12.25 + (((h >>> 12) % 170) / 100), h % 89, 5 + (h % 6));
    }
    // Sun glints.
    g.strokeStyle = '#F4FBFA';
    g.lineWidth = 0.6;
    for (let i = 0; i < 12; i++) {
      const h = hash32(4242, i);
      const ph = (t * 0.6 + i * 0.31) % 1;
      if (ph > 0.3) continue;
      const x = -0.2 + ((h % 1250) / 100);
      const y = 12.3 + (((h >>> 12) % 160) / 100);
      g.globalAlpha = Math.sin((Math.PI * ph) / 0.3) * 0.8 * (1 - this.night * 0.7);
      g.beginPath();
      g.moveTo(wxOf(x, y) - 1.5, wyOf(x, y, WATER_Z));
      g.lineTo(wxOf(x, y) + 1.5, wyOf(x, y, WATER_Z));
      g.stroke();
    }
    if (this.rainA > 0.05) {
      // Rain rings on the canal and harbor.
      g.strokeStyle = '#DCEFF2';
      g.lineWidth = 0.4;
      for (let i = 0; i < 26; i++) {
        const h = hash32(777, i);
        const ph = (t * 1.6 + i * 0.137) % 1;
        const tile = i < 12 ? CITY.canal[h % CITY.canal.length] : -1;
        if (tile >= 0 && CITY.tiles[tile] !== 'canal') continue;
        const x = tile >= 0 ? tx(tile) + 0.2 + (((h >>> 6) % 60) / 100) : -0.2 + ((h % 1250) / 100);
        const y = tile >= 0 ? ty(tile) + 0.2 + (((h >>> 12) % 60) / 100) : 12.3 + (((h >>> 12) % 160) / 100);
        g.globalAlpha = (1 - ph) * 0.7 * this.rainA;
        g.beginPath();
        g.ellipse(wxOf(x, y), wyOf(x, y, WATER_Z), 1 + ph * 4, 0.5 + ph * 2, 0, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  }

  // ───────────────────────────── Shadows ─────────────────────────────

  private shadows(view: CityView): void {
    const s = this.sun(view.dayPhase);
    const a = s.a * (1 - this.rainA * 0.6);
    if (a < 0.01) return;
    const g = this.ctx;
    g.beginPath();
    const cast = (x: number, y: number, fp: [number, number, number, number], h: number): void => {
      const ox = s.dx * h;
      const oy = s.dy * h;
      const pts: [number, number][] = [
        [x + fp[0], y + fp[1]], [x + fp[2], y + fp[1]], [x + fp[2], y + fp[3]], [x + fp[0], y + fp[3]],
        [x + fp[0] + ox, y + fp[1] + oy], [x + fp[2] + ox, y + fp[1] + oy], [x + fp[2] + ox, y + fp[3] + oy], [x + fp[0] + ox, y + fp[3] + oy],
      ];
      const hull = convexHull(pts);
      g.moveTo(wxOf(hull[0][0], hull[0][1]), wyOf(hull[0][0], hull[0][1]));
      for (let i = 1; i < hull.length; i++) g.lineTo(wxOf(hull[i][0], hull[i][1]), wyOf(hull[i][0], hull[i][1]));
      g.closePath();
    };
    for (const b of view.buildings) cast(tx(b.tile), ty(b.tile), shadowFootprint(b.kind), buildingHeight(b.kind, b.level) * 0.82);
    for (const t of CITY.homes) cast(tx(t), ty(t), shadowFootprint('home'), 34);
    cast(tx(CITY.station[0]), ty(CITY.station[0]), shadowFootprint('station'), 34);
    for (const tr of this.trees) {
      const fp: [number, number, number, number] = [-0.1, -0.1, 0.1, 0.1];
      cast(tr[0], tr[1], fp, 12);
    }
    CITY.tiles.forEach((k, t) => {
      if (k === 'garden') cast(tx(t), ty(t), shadowFootprint('garden'), 13);
    });
    g.fillStyle = `rgba(56,40,70,${a})`;
    g.fill('nonzero');
  }

  // ───────────────────────────── Ownership ─────────────────────────────

  /** Everything outside one extruded box (a building's silhouette), as an even-odd clip path. */
  private outside(x: number, y: number, box: [number, number, number, number, number], flip: boolean): Path2D {
    const [a0, b0, a1, b1, h] = box;
    // A flipped sprite mirrors u and v.
    const u0 = flip ? b0 : a0;
    const v0 = flip ? a0 : b0;
    const u1 = flip ? b1 : a1;
    const v1 = flip ? a1 : b1;
    const p = new Path2D();
    p.rect(-4000, -4000, 8000, 8000);
    p.moveTo(wxOf(x + u0, y + v1), wyOf(x + u0, y + v1, 0));
    p.lineTo(wxOf(x + u1, y + v1), wyOf(x + u1, y + v1, 0));
    p.lineTo(wxOf(x + u1, y + v0), wyOf(x + u1, y + v0, 0));
    p.lineTo(wxOf(x + u1, y + v0), wyOf(x + u1, y + v0, h));
    p.lineTo(wxOf(x + u0, y + v0), wyOf(x + u0, y + v0, h));
    p.lineTo(wxOf(x + u0, y + v1), wyOf(x + u0, y + v1, h));
    p.closePath();
    return p;
  }

  /**
   * Keep the ownership cache in step with the district. Flagships follow revenue; the kerb and
   * enclave geometry (and the ground canvas) are rebuilt only when a lot changes hands or level.
   */
  private syncOwnership(view: CityView): void {
    this.stars = view.players.map((p) => starsOf(p));
    if (view.buildingsRev === this.ownRev) return;
    this.ownRev = view.buildingsRev;
    // Each House's flagship: its best-earning shop (its first civic project if it has no shop).
    const best = new Map<number, BuildingView>();
    for (const b of view.buildings) {
      const cur = best.get(b.owner);
      const shop = isShop(b.kind);
      if (!cur) best.set(b.owner, b);
      else if (shop && (!isShop(cur.kind) || b.revenue > cur.revenue || (b.revenue === cur.revenue && (b.level > cur.level || (b.level === cur.level && b.id < cur.id))))) best.set(b.owner, b);
    }
    this.flagship.clear();
    for (const [owner, b] of best) this.flagship.set(owner, b.id);
    let key = String(view.seed);
    for (const b of view.buildings) key += `|${b.tile}:${b.owner}:${b.kind}:${b.level}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.layoutRev++;
    this.own = [];
    this.ownAt.clear();
    for (const b of view.buildings) {
      const x = tx(b.tile);
      const y = ty(b.tile);
      const same = (dx: number, dy: number): boolean => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false;
        const o = view.buildingAt(idx(nx, ny));
        return !!o && o.owner === b.owner;
      };
      const n = same(0, -1);
      const e = same(1, 0);
      const s = same(0, 1);
      const w = same(-1, 0);
      const flip = CITY.doorDir[b.tile] === 1;
      const o: OwnTile = {
        b,
        x,
        y,
        house: view.players[b.owner]?.house ?? -1,
        civic: !isShop(b.kind),
        open: [n, e, s, w],
        inner: [n && e && !same(1, -1), e && s && !same(1, 1), s && w && !same(-1, 1), w && n && !same(-1, -1)],
        joined: n || e || s || w,
        self: solidBoxes(b.kind, b.level).map((box) => this.outside(x, y, box, flip)),
        front: [],
      };
      this.own.push(o);
      this.ownAt.set(b.tile, o);
    }
    // What stands nearer the camera and may hide a lot's kerb or banner.
    const FRONT: [number, number][] = [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]];
    for (const o of this.own) {
      for (const [dx, dy] of FRONT) {
        const nx = o.x + dx;
        const ny = o.y + dy;
        if (nx >= W || ny >= H) continue;
        const t = idx(nx, ny);
        const nb = view.buildingAt(t);
        const flip = CITY.doorDir[t] === 1;
        if (nb) for (const box of solidBoxes(nb.kind, nb.level)) o.front.push(this.outside(nx, ny, box, flip));
        else if (CITY.tiles[t] === 'home') for (const box of solidBoxes('home', 1)) o.front.push(this.outside(nx, ny, box, flip));
      }
    }
    this.own.sort((p, q) => p.x + p.y - (q.x + q.y));
  }

  /** How much of a colour the grade took away: adding this back restores the true colour. */
  private lost(hex: string, alpha = 1): string {
    const n = parseInt(hex.slice(1), 16);
    const t = this.tint;
    return `rgb(${Math.round(((n >> 16) & 255) * (1 - t[0]) * alpha)},${Math.round(((n >> 8) & 255) * (1 - t[1]) * alpha)},${Math.round((n & 255) * (1 - t[2]) * alpha)})`;
  }

  /** Add one tile-space rectangle (ground level) to the current path. */
  private quad(x0: number, y0: number, x1: number, y1: number): void {
    const g = this.ctx;
    g.moveTo(wxOf(x0, y0), wyOf(x0, y0));
    g.lineTo(wxOf(x1, y0), wyOf(x1, y0));
    g.lineTo(wxOf(x1, y1), wyOf(x1, y1));
    g.lineTo(wxOf(x0, y1), wyOf(x0, y1));
    g.closePath();
  }

  /**
   * The ground of an owned lot: a bold double-stroked House kerb (deep trim outside, House
   * primary inside) on every edge that is not shared with the same House, and, where two or
   * more lots join, a translucent House wash with no kerb on the shared boundary, so an
   * enclave reads as one block inside one continuous trim.
   * `relight` adds back exactly what the colour grade removed instead of painting.
   */
  private ownGround(o: OwnTile, relight: boolean): void {
    const g = this.ctx;
    const tone = houseTone(o.house);
    const { x, y } = o;
    // Kerb width: about 3 world px, and never thinner than ~2.5 px on screen however far out
    // the camera is. Past the lot's own rim it grows outward over the pavement, never over a
    // neighbouring lot.
    const total = clamp(Math.max(3, 3.6 / this.cam.zoom), 3, 5.8) / EDGE_PX;
    const inner = Math.min(total, 0.1);
    const ext = clamp(total - inner, 0, 0.1);
    const dk = (inner + ext) * 0.36;
    const outer = (dx: number, dy: number): number => (kindAt(x + dx, y + dy) === 'lot' ? -0.004 : ext);
    const [oN, oE, oS, oW] = o.open;
    // Outer limit of the kerb on each side (how far past the lot line it starts).
    const eN = oN ? 0 : outer(0, -1);
    const eE = oE ? 0 : outer(1, 0);
    const eS = oS ? 0 : outer(0, 1);
    const eW = oW ? 0 : outer(-1, 0);
    const x0 = x - eW;
    const x1 = x + 1 + eE;
    const y0 = y - eN;
    const y1 = y + 1 + eS;

    if (o.joined) {
      // Enclave wash: the whole lot, a little deeper along each shared boundary.
      g.beginPath();
      this.quad(x - (oW ? 0.006 : 0), y - (oN ? 0.006 : 0), x + 1 + (oE ? 0.006 : 0), y + 1 + (oS ? 0.006 : 0));
      g.fillStyle = relight ? this.lost(tone.color, WASH * WASH_RELIGHT) : tone.color;
      if (!relight) g.globalAlpha = WASH;
      g.fill();
      g.beginPath();
      const band = 0.17;
      if (oN) this.quad(x, y, x + 1, y + band);
      if (oS) this.quad(x, y + 1 - band, x + 1, y + 1);
      if (oW) this.quad(x, y, x + band, y + 1);
      if (oE) this.quad(x + 1 - band, y, x + 1, y + 1);
      g.fillStyle = relight ? this.lost(tone.color, WASH_SEAM * WASH_RELIGHT) : tone.color;
      if (!relight) g.globalAlpha = WASH_SEAM;
      g.fill();
      g.globalAlpha = 1;
    }

    // House primary: the inner band of the kerb.
    g.beginPath();
    if (!oN) this.quad(x0, y0, x1, y + inner);
    if (!oS) this.quad(x0, y + 1 - inner, x1, y1);
    if (!oW) this.quad(x0, y0, x + inner, y1);
    if (!oE) this.quad(x + 1 - inner, y0, x1, y1);
    if (o.inner[0]) this.quad(x + 1 - inner, y, x + 1, y + inner);
    if (o.inner[1]) this.quad(x + 1 - inner, y + 1 - inner, x + 1, y + 1);
    if (o.inner[2]) this.quad(x, y + 1 - inner, x + inner, y + 1);
    if (o.inner[3]) this.quad(x, y, x + inner, y + inner);
    g.fillStyle = relight ? this.lost(tone.color, KERB_RELIGHT) : tone.color;
    g.fill();
    // Deep trim: the outer edge.
    g.beginPath();
    if (!oN) this.quad(x0, y0, x1, y0 + dk);
    if (!oS) this.quad(x0, y1 - dk, x1, y1);
    if (!oW) this.quad(x0, y0, x0 + dk, y1);
    if (!oE) this.quad(x1 - dk, y0, x1, y1);
    if (o.inner[0]) this.quad(x + 1 - dk, y, x + 1, y + dk);
    if (o.inner[1]) this.quad(x + 1 - dk, y + 1 - dk, x + 1, y + 1);
    if (o.inner[2]) this.quad(x, y + 1 - dk, x + dk, y + 1);
    if (o.inner[3]) this.quad(x, y, x + dk, y + dk);
    g.fillStyle = relight ? this.lost(tone.dark, KERB_RELIGHT) : tone.dark;
    g.fill();
  }

  /** Banner scale: world units, but never so small that the crest medallion is lost on screen. */
  private bannerScale(): number {
    return clamp(10 / (10 * this.cam.zoom), 1, 1.8);
  }

  /** 0 plain, 1 brass finial (a House with Milestone stars), 2 fully gilded (its flagship). */
  private bannerTrim(b: BuildingView): 0 | 1 | 2 {
    const stars = this.stars[b.owner] ?? 0;
    if (stars <= 0) return 0;
    return this.flagship.get(b.owner) === b.id ? 2 : 1;
  }

  /** Height the building is still dropping from (a new building lands and settles). */
  private dropZ(tile: number, now: number): number {
    const landed = this.built.get(tile);
    if (landed === undefined) return 0;
    const k = (now - landed) / 420;
    if (k >= 1) return 0;
    return k >= 0 ? Math.pow(1 - k, 2) * 22 * Math.abs(Math.cos(k * Math.PI * 1.5)) : 22;
  }

  /** World position of the foot of a building's banner pole. */
  private bannerFoot(b: BuildingView, now: number): { x: number; y: number } {
    const flip = CITY.doorDir[b.tile] === 1;
    const [u, v, z] = bannerAnchor(b.kind, b.level);
    return {
      x: wxOf(tx(b.tile), ty(b.tile)) + (flip ? v - u : u - v) * HW,
      y: wyOf(tx(b.tile), ty(b.tile)) + (u + v) * HH - z - this.dropZ(b.tile, now),
    };
  }

  /**
   * The tall House standard: a pole above the roofline, a crossbar, a gently swaying
   * swallow-tailed banner in the House colour and, inset on it, the white-and-brass crest
   * medallion. Flagships of Houses with Milestone stars fly it gilded.
   */
  private banner(ax: number, ay: number, house: number, id: number, now: number, trim: 0 | 1 | 2): void {
    const g = this.ctx;
    const k = this.bannerScale();
    const tone = houseTone(house);
    const sway = Math.sin(now / 760 + id * 1.7);
    const ripple = Math.sin(now / 340 + id * 0.9);
    const dx = sway * 1.35 * k;
    const pole = 30 * k;
    const top = ay - pole;
    const yb = ay - 27.4 * k; // top of the cloth
    const len = 18.4 * k;
    const hw = 5.6 * k;
    const metal = trim === 2 ? BRASS : '#3B3A40';
    // Pole.
    g.fillStyle = trim ? BRASS_DEEP : '#3B3A40';
    g.fillRect(ax - 0.5 * k, top, k, pole);
    if (trim) {
      g.fillStyle = BRASS;
      g.fillRect(ax - 0.5 * k, top, 0.45 * k, pole);
    }
    // Cloth: hangs from the crossbar, the tails swaying.
    const cloth = (): void => {
      g.beginPath();
      g.moveTo(ax - hw, yb);
      g.lineTo(ax + hw, yb);
      g.quadraticCurveTo(ax + hw + dx * 0.25, yb + len * 0.55, ax + hw + dx, yb + len);
      g.lineTo(ax + dx * 0.8 + ripple * 0.35 * k, yb + len - 4 * k);
      g.lineTo(ax - hw + dx, yb + len);
      g.quadraticCurveTo(ax - hw + dx * 0.25, yb + len * 0.55, ax - hw, yb);
      g.closePath();
    };
    cloth();
    g.fillStyle = tone.color;
    g.fill();
    // The shaded fold on the right, in the deep trim.
    g.save();
    cloth();
    g.clip();
    g.fillStyle = tone.dark;
    g.fillRect(ax + hw * 0.42 + dx * 0.5, yb - 1, hw, len + 2);
    // Deep trim (or a brass fringe) along the tails.
    g.beginPath();
    g.moveTo(ax + hw + dx, yb + len);
    g.lineTo(ax + dx * 0.8 + ripple * 0.35 * k, yb + len - 4 * k);
    g.lineTo(ax - hw + dx, yb + len);
    g.strokeStyle = trim === 2 ? BRASS : tone.dark;
    g.lineWidth = (trim === 2 ? 2.2 : 1.8) * k;
    g.lineJoin = 'miter';
    g.stroke();
    g.restore();
    // Crossbar and finial.
    g.fillStyle = metal;
    g.fillRect(ax - hw - 0.9 * k, yb - 0.9 * k, 2 * hw + 1.8 * k, 1.1 * k);
    g.beginPath();
    g.arc(ax, top - 0.6 * k, (trim ? 1.45 : 1.05) * k, 0, Math.PI * 2);
    g.fillStyle = trim ? BRASS : '#3B3A40';
    g.fill();
    if (trim === 2) {
      // The gilded flagship: a spear point above the ball and brass caps on the bar.
      g.beginPath();
      g.moveTo(ax, top - 4.6 * k);
      g.lineTo(ax + 1.05 * k, top - 1.6 * k);
      g.lineTo(ax - 1.05 * k, top - 1.6 * k);
      g.closePath();
      g.fillStyle = BRASS;
      g.fill();
      g.fillStyle = BRASS_DEEP;
      g.fillRect(ax - hw - 1.5 * k, yb - 1.25 * k, 1.1 * k, 1.8 * k);
      g.fillRect(ax + hw + 0.4 * k, yb - 1.25 * k, 1.1 * k, 1.8 * k);
    }
    // The crest medallion, white and brass, inset on the cloth.
    if (house >= 0) drawCrest(g, house, ax + dx * 0.22, yb + 6.9 * k, 7 * k, { medallion: true, gilded: trim === 2 });
  }

  /**
   * After the colour grade: bring every owned lot's kerb, wash and banner back to full House
   * colour. The kerb is re-lit additively with exactly what the grade removed; the banner is
   * redrawn at relight strength. Each is clipped against the silhouettes of whatever stands
   * nearer the camera, so depth still reads true.
   */
  private relight(view: CityView, now: number): void {
    const s = this.relit;
    if (s < 0.04 || !this.own.length) return;
    const g = this.ctx;
    for (const o of this.own) {
      const b = view.buildingAt(o.b.tile);
      if (!b) continue;
      // Ground: additive, hidden where this lot's own building or a nearer one covers it.
      g.save();
      for (const c of o.self) g.clip(c, 'evenodd');
      for (const c of o.front) g.clip(c, 'evenodd');
      g.globalCompositeOperation = 'lighter';
      this.ownGround(o, true);
      g.restore();
      // Banner: redrawn over the grade.
      g.save();
      for (const c of o.front) g.clip(c, 'evenodd');
      g.globalAlpha = s;
      const foot = this.bannerFoot(b, now);
      this.banner(foot.x, foot.y, o.house, b.id, now, this.bannerTrim(b));
      g.restore();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  // ───────────────────────────── Era maturation ─────────────────────────────

  /** Era II: a line of small pennants strung between two posts on the canal quay. */
  private drawPennantLine(l: PennantLine, i: number, now: number): void {
    const g = this.ctx;
    const ax = wxOf(l.ax, l.ay);
    const ay = wyOf(l.ax, l.ay);
    const bx = wxOf(l.bx, l.by);
    const by = wyOf(l.bx, l.by);
    const h = 8.4;
    g.fillStyle = '#5A4A3A';
    g.fillRect(ax - 0.35, ay - h, 0.7, h);
    g.fillRect(bx - 0.35, by - h, 0.7, h);
    const sag = 2.1;
    g.beginPath();
    g.moveTo(ax, ay - h + 0.4);
    g.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 - h + 0.4 + sag * 2, bx, by - h + 0.4);
    g.strokeStyle = 'rgba(60,48,40,0.6)';
    g.lineWidth = 0.35;
    g.stroke();
    const n = 5;
    const run = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / run;
    const uy = (by - ay) / run;
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      const px = lerp(ax, bx, t);
      const py = lerp(ay, by, t) - h + 0.4 + sag * 4 * t * (1 - t);
      const flutter = Math.sin(now / 420 + i * 1.3 + j * 0.9) * 0.45;
      const hw = 1.25;
      // Each pennant hangs along the line's own direction.
      g.beginPath();
      g.moveTo(px - ux * hw, py - uy * hw);
      g.lineTo(px + ux * hw, py + uy * hw);
      g.lineTo(px + flutter, py + 3.1);
      g.closePath();
      g.fillStyle = PENNANT_TONES[(hash32(i, 3) + j) % PENNANT_TONES.length];
      g.fill();
    }
  }

  /** Era III: a grand twin-globe brass lamp on the boulevard. Era IV hangs a gilded garland to the next. */
  private drawGrandLamp(i: number, now: number, light: boolean): void {
    const g = this.ctx;
    const l = this.grandLamps[i];
    const x = wxOf(l[0], l[1]);
    const y = wyOf(l[0], l[1]);
    const h = 19;
    if (light) {
      g.globalAlpha = this.night;
      this.glow(x - 3.1, y - h + 1.2, 13, 0.8);
      this.glow(x + 3.1, y - h + 1.2, 13, 0.8);
      this.glow(x, y + 1, 30, 0.3, 0.5);
      if (this.era >= 4 && l[2] >= 0) this.garland(i, now, true);
      return;
    }
    if (this.era >= 4 && l[2] >= 0) this.garland(i, now, false);
    // Stepped plinth, brass post, collars.
    g.fillStyle = '#6A5A44';
    g.fillRect(x - 1.7, y - 1.2, 3.4, 1.2);
    g.fillStyle = BRASS_DEEP;
    g.fillRect(x - 0.75, y - h, 1.5, h - 1.2);
    g.fillStyle = BRASS;
    g.fillRect(x - 0.75, y - h, 0.6, h - 1.2);
    g.fillRect(x - 1.25, y - 5.2, 2.5, 0.8);
    g.fillRect(x - 1.25, y - h + 3.4, 2.5, 0.8);
    // Twin arms and globes.
    g.strokeStyle = BRASS_DEEP;
    g.lineWidth = 0.75;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x - 3.1, y - h + 2.7);
    g.quadraticCurveTo(x - 3.1, y - h + 5.2, x, y - h + 4.4);
    g.quadraticCurveTo(x + 3.1, y - h + 5.2, x + 3.1, y - h + 2.7);
    g.stroke();
    for (const s of [-1, 1]) {
      g.beginPath();
      g.arc(x + s * 3.1, y - h + 1.2, 1.55, 0, Math.PI * 2);
      g.fillStyle = '#F7EDD2';
      g.fill();
      g.fillStyle = BRASS;
      g.fillRect(x + s * 3.1 - 1.1, y - h - 0.75, 2.2, 0.65);
    }
    // Finial.
    g.beginPath();
    g.moveTo(x, y - h - 3);
    g.lineTo(x + 0.9, y - h);
    g.lineTo(x - 0.9, y - h);
    g.closePath();
    g.fillStyle = BRASS;
    g.fill();
  }

  /** Era IV: a gilded swag from one boulevard lamp to the next, with rosettes along it. */
  private garland(i: number, now: number, light: boolean): void {
    const g = this.ctx;
    const a = this.grandLamps[i];
    const b = this.grandLamps[a[2]];
    if (!b) return;
    const ax = wxOf(a[0], a[1]);
    const ay = wyOf(a[0], a[1]) - 15.6;
    const bx = wxOf(b[0], b[1]);
    const by = wyOf(b[0], b[1]) - 15.6;
    const sag = 6.2 + Math.sin(now / 1900 + i) * 0.25;
    const at = (t: number): [number, number] => [lerp(ax, bx, t), lerp(ay, by, t) + sag * 4 * t * (1 - t)];
    if (light) {
      // The rosettes catch the lamplight.
      g.fillStyle = 'rgba(255,217,138,0.85)';
      g.beginPath();
      for (let j = 1; j < 8; j++) {
        const q = at(j / 8);
        g.moveTo(q[0] + 1.5, q[1] + 0.5);
        g.arc(q[0], q[1] + 0.5, 1.5, 0, Math.PI * 2);
      }
      g.fill();
      return;
    }
    g.beginPath();
    g.moveTo(ax, ay);
    for (let j = 1; j <= 16; j++) {
      const q = at(j / 16);
      g.lineTo(q[0], q[1]);
    }
    g.strokeStyle = '#5F8A6C';
    g.lineWidth = 2.3;
    g.lineCap = 'round';
    g.stroke();
    g.strokeStyle = BRASS;
    g.lineWidth = 0.8;
    g.stroke();
    for (let j = 1; j < 8; j++) {
      const q = at(j / 8);
      g.beginPath();
      g.arc(q[0], q[1] + 0.5, j % 2 ? 1.3 : 1.75, 0, Math.PI * 2);
      g.fillStyle = j % 2 ? '#F7EFDF' : BRASS;
      g.fill();
    }
    // A gilded ribbon falls from each end.
    g.fillStyle = BRASS;
    for (const [rx, ry] of [[ax, ay], [bx, by]]) {
      g.beginPath();
      g.moveTo(rx - 1.1, ry);
      g.lineTo(rx + 1.1, ry);
      g.lineTo(rx + 0.7, ry + 5.2);
      g.lineTo(rx, ry + 4);
      g.lineTo(rx - 0.7, ry + 5.2);
      g.closePath();
      g.fill();
    }
  }

  /** Where the i-th harbor ferry is: shuttling east and west along the outer harbor. */
  private ferryAt(i: number, now: number): { x: number; y: number; dir: number } {
    const period = 52000 + i * 9000;
    const ph = (((now / period + i * 0.37) % 1) + 1) % 1;
    const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;
    // Ease into each turn so the ferry slows at the ends of its run.
    const e = tri * tri * (3 - 2 * tri);
    return { x: lerp(0.5, 11.9, e), y: [13.84, 13.66, 13.96][i % 3], dir: ph < 0.5 ? 1 : -1 };
  }

  /** Era III: a small canopied tourist ferry crossing the harbor. */
  private drawFerry(i: number, now: number, light: boolean): void {
    const g = this.ctx;
    const f = this.ferryAt(i, now);
    const bob = Math.sin(now / 800 + i * 2.4) * 0.5;
    const half = 0.42;
    const wid = 0.11;
    const P = (a: number, b: number, z: number): [number, number] => [wxOf(f.x + a * f.dir, f.y + b), wyOf(f.x + a * f.dir, f.y + b, WATER_Z + z) - bob];
    const face = (fill: string, pts: [number, number][]): void => {
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let j = 1; j < pts.length; j++) g.lineTo(pts[j][0], pts[j][1]);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };
    if (light) {
      g.globalAlpha = this.night;
      const q = P(0, 0, 6.4);
      this.glow(q[0], q[1], 9, 0.7);
      return;
    }
    // Wake and water shadow.
    face('rgba(25,60,72,0.22)', [P(-half - 0.05, wid + 0.06, 0), P(half + 0.2, wid + 0.06, 0), P(half + 0.25, -wid, 0), P(-half - 0.05, -wid, 0)]);
    g.strokeStyle = 'rgba(220,240,244,0.55)';
    g.lineWidth = 0.5;
    for (const k of [0.16, 0.34]) {
      const a = P(-half - k, -wid - 0.03, 0.2);
      const b = P(-half - k - 0.12, wid + 0.05, 0.2);
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
    }
    // Hull with a pointed bow, cream above a teal waterline.
    face('#2F7483', [P(-half, wid, 0), P(half, wid, 0), P(half + 0.2, 0, 0), P(half + 0.2, 0, 1.2), P(half, wid, 1.2), P(-half, wid, 1.2)]);
    face('#F5EEDD', [P(-half, wid, 1.2), P(half, wid, 1.2), P(half + 0.2, 0, 1.2), P(half + 0.22, 0, 3.2), P(half, wid, 3.2), P(-half, wid, 3.2)]);
    face('#E9DFCB', [P(-half, -wid, 3.2), P(half, -wid, 3.2), P(half + 0.22, 0, 3.2), P(half, wid, 3.2), P(-half, wid, 3.2)]);
    // Canopy on four posts.
    g.fillStyle = '#62412B';
    for (const [a, b] of [[-0.3, wid * 0.8], [0.26, wid * 0.8], [-0.3, -wid * 0.8], [0.26, -wid * 0.8]] as const) {
      const q = P(a, b, 7.4);
      g.fillRect(q[0] - 0.3, q[1], 0.6, 4.2);
    }
    face('#B5553A', [P(-0.36, wid, 7.2), P(0.32, wid, 7.2), P(0.32, wid, 8.3), P(-0.36, wid, 8.3)]);
    face('#C86443', [P(-0.36, -wid, 8.3), P(0.32, -wid, 8.3), P(0.32, wid, 8.3), P(-0.36, wid, 8.3)]);
    // A few passengers and a stern pennant.
    for (let j = 0; j < 3; j++) {
      const q = P(-0.2 + j * 0.2, 0, 4.4);
      g.beginPath();
      g.arc(q[0], q[1], 0.9, 0, Math.PI * 2);
      g.fillStyle = ['#F0E2C8', '#9DBDE6', '#E9C46A'][(i + j) % 3];
      g.fill();
    }
    const st = P(-half + 0.03, 0, 3.2);
    g.fillStyle = '#62412B';
    g.fillRect(st[0] - 0.25, st[1] - 6, 0.5, 6);
    g.beginPath();
    g.moveTo(st[0], st[1] - 6);
    g.lineTo(st[0] - f.dir * 3.4, st[1] - 5.1 + Math.sin(now / 300 + i) * 0.4);
    g.lineTo(st[0], st[1] - 4.1);
    g.closePath();
    g.fillStyle = C.brass;
    g.fill();
  }

  /** Founding Guide: a warm brass ring pulsing gently on each prime starter lot. */
  private guideRings(view: CityView, lots: number[], now: number): void {
    const g = this.ctx;
    const lw = Math.max(1.5, 2 / this.cam.zoom);
    lots.forEach((tile, i) => {
      if (tile < 0 || CITY.tiles[tile] !== 'lot' || view.buildingAt(tile)) return;
      const cx = wxOf(tx(tile) + 0.5, ty(tile) + 0.5);
      const cy = wyOf(tx(tile) + 0.5, ty(tile) + 0.5);
      const cycle = now / 2200 + i * 0.23;
      const ph = ((cycle % 1) + 1) % 1;
      const breathe = 0.5 + 0.5 * Math.sin(cycle * Math.PI * 2);
      const ring = (r: number): void => {
        g.beginPath();
        g.ellipse(cx, cy, r * 45.25, r * 22.6, 0, 0, Math.PI * 2);
      };
      // A soft brass wash, the steady ring (deep brass under bright brass), and one slow ripple.
      ring(0.4);
      g.fillStyle = `rgba(212,163,74,${0.13 + 0.07 * breathe})`;
      g.fill();
      g.strokeStyle = BRASS_DEEP;
      g.lineWidth = lw * 1.9;
      g.globalAlpha = 0.85;
      g.stroke();
      g.strokeStyle = '#F0C96C';
      g.lineWidth = lw;
      g.globalAlpha = 1;
      g.stroke();
      ring(0.4 + ph * 0.3);
      g.strokeStyle = BRASS;
      g.lineWidth = lw * 0.8;
      g.globalAlpha = (1 - ph) * 0.7;
      g.stroke();
      g.globalAlpha = 1;
    });
  }

  /** A new era's unlocks: a brass shimmer sweeps the district from the station to the harbor. */
  private unlockShimmer(view: CityView, now: number): void {
    const el = now - this.shimmer.t0;
    const dur = 2700;
    if (el < 0 || el > dur) return;
    const g = this.ctx;
    const span = 6.5;
    const front = (el / dur) * (22 + span) - 0.5;
    const lw = Math.max(1.2, 1.5 / this.cam.zoom);
    for (const lot of CITY.lots) {
      const x = tx(lot);
      const y = ty(lot);
      const ph = front - (x + y);
      if (ph <= 0 || ph >= span) continue;
      const a = Math.sin((Math.PI * ph) / span);
      const vacant = !view.buildingAt(lot);
      this.diamond(x, y, 0.05);
      if (vacant) {
        g.fillStyle = `rgba(240,201,108,${0.22 * a})`;
        g.fill();
      }
      g.strokeStyle = `rgba(212,163,74,${(vacant ? 0.95 : 0.6) * a})`;
      g.lineWidth = lw;
      g.stroke();
      if (vacant) {
        // A rising brass ring and a glint.
        const cx = wxOf(x + 0.5, y + 0.5);
        const cy = wyOf(x + 0.5, y + 0.5);
        g.beginPath();
        g.ellipse(cx, cy - ph * 1.6, 9 + ph * 1.5, 4.5 + ph * 0.75, 0, 0, Math.PI * 2);
        g.strokeStyle = `rgba(240,201,108,${0.7 * a})`;
        g.lineWidth = lw * 0.7;
        g.stroke();
        star(g, cx, cy - 7 - ph * 1.4, 2.4 * a, `rgba(250,236,190,${a})`);
      }
    }
  }

  // ───────────────────────────── Actors ─────────────────────────────

  private drawActor(a: Actor, view: CityView, alpha: number, ui: UiState, now: number, dt: number, light: boolean): void {
    switch (a.t) {
      case 0:
        if (a.b) this.drawBuilding(a.b, view, now, light);
        break;
      case 1: {
        const k = CITY.tiles[a.a];
        const kind: SceneKind = k === 'home' ? 'home' : k === 'garden' ? 'garden' : 'station';
        if (light && kind === 'garden') break;
        const flip = kind === 'home' && CITY.doorDir[a.a] === 1;
        const sp = this.sprite(kind, 1, 0, hash32(a.a, 5) % 8, flip, light);
        if (light) this.ctx.globalAlpha = this.night;
        this.blit(sp, tx(a.a), ty(a.a));
        break;
      }
      case 2:
        if (a.c && !light) this.drawCitizen(a.c, alpha, ui, dt);
        break;
      case 3:
        this.drawTram(view, a.a, alpha, now, light);
        break;
      case 4:
        this.drawLamp(this.lamps[a.a], light);
        break;
      case 5: {
        if (light) break;
        const tr = this.trees[a.a];
        const g = this.ctx;
        const x = wxOf(tr[0], tr[1]);
        const y = wyOf(tr[0], tr[1]);
        const s = tr[2];
        g.fillStyle = C.woodDark;
        g.fillRect(x - 0.6 * s, y - 5 * s, 1.2 * s, 5 * s);
        g.beginPath();
        g.arc(x, y - 8 * s, 5 * s, 0, Math.PI * 2);
        g.fillStyle = C.sageDark;
        g.fill();
        g.beginPath();
        g.arc(x - 1 * s, y - 10.5 * s, 4.1 * s, 0, Math.PI * 2);
        g.fillStyle = C.sage;
        g.fill();
        g.beginPath();
        g.arc(x - 1.8 * s, y - 12 * s, 2.3 * s, 0, Math.PI * 2);
        g.fillStyle = C.sageLight;
        g.fill();
        break;
      }
      case 6:
        if (!light) this.drawParapet(a.a);
        break;
      case 7:
        this.drawBoat(a.a, now, light);
        break;
      case 8:
        this.drawShip(now, light);
        break;
      case 9:
        this.drawStopSign(a.a, light);
        break;
      case 10:
        if (!light) this.drawPennantLine(this.pennants[a.a], a.a, now);
        break;
      case 11:
        this.drawGrandLamp(a.a, now, light);
        break;
      case 12:
        this.drawFerry(a.a, now, light);
        break;
      default:
        break;
    }
  }

  private drawBuilding(b: BuildingView, view: CityView, now: number, light: boolean): void {
    const g = this.ctx;
    const x = tx(b.tile);
    const y = ty(b.tile);
    const house = view.players[b.owner]?.house ?? -1;
    const flip = CITY.doorDir[b.tile] === 1;
    const sp = this.sprite(b.kind, b.level, house, 0, flip, light);
    // A new building drops onto its lot and settles.
    let dz = 0;
    const landed = this.built.get(b.tile);
    if (landed !== undefined) {
      const k = (now - landed) / 420;
      if (k >= 1) this.built.delete(b.tile);
      else if (k >= 0) dz = Math.pow(1 - k, 2) * 22 * Math.abs(Math.cos(k * Math.PI * 1.5));
      else dz = 22;
    }
    if (light) {
      const flick = b.kind === 'nightmarket' ? 0.9 + 0.1 * Math.sin(now / 240 + b.id) : 1;
      g.globalAlpha = this.night * flick;
      this.blit(sp, x, y, dz);
      return;
    }
    // The lot's House kerb and enclave wash lie on the ground under the building.
    const own = this.ownAt.get(b.tile);
    if (own) this.ownGround(own, false);
    this.blit(sp, x, y, dz);
    const pen = this.pen;
    pen.begin(flip, false, b.id);
    const ox = wxOf(x, y);
    const oy = wyOf(x, y) - dz;
    g.save();
    g.translate(ox, oy);
    const tone = houseTone(house);
    const promo = view.tick < b.promoUntil;
    if (isShop(b.kind)) {
      if (b.kind === 'roastery') {
        // Roaster steam.
        const top = b.level === 1 ? 31 : b.level === 2 ? 46 : 45;
        for (let i = 0; i < 3; i++) {
          const ph = (now / 2400 + i / 3 + b.id * 0.13) % 1;
          g.globalAlpha = (1 - ph) * 0.42;
          g.beginPath();
          g.arc(pen.X(0.27, 0.3) + Math.sin(ph * 5 + i) * 1.6 + ph * 3, pen.Y(0.27, 0.3, top) - ph * 13, 1.4 + ph * 2.6, 0, Math.PI * 2);
          g.fillStyle = '#FBF7EE';
          g.fill();
        }
        g.globalAlpha = 1;
      }
      if (promo) {
        // Promo Blitz: pulsing bunting across the shopfront and a ring on the pavement.
        const k = 0.5 + 0.5 * Math.sin(now / 130);
        const hgt = buildingHeight(b.kind, b.level);
        const z = Math.min(hgt - 2, 20) + k * 1.2;
        for (let i = 0; i < 8; i++) {
          const u = 0.1 + i * 0.105;
          const zz = z - 2.4 * (1 - Math.abs((i + 0.5) / 8 - 0.5) * 2);
          g.beginPath();
          g.moveTo(pen.X(u, 1.0), pen.Y(u, 1.0, zz));
          g.lineTo(pen.X(u + 0.085, 1.0), pen.Y(u + 0.085, 1.0, zz));
          g.lineTo(pen.X(u + 0.042, 1.0), pen.Y(u + 0.042, 1.0, zz - 3.6 - k));
          g.closePath();
          g.fillStyle = i % 2 ? C.cream : tone.color;
          g.fill();
        }
        g.globalAlpha = 0.55 * (1 - k);
        g.beginPath();
        g.ellipse(pen.X(0.5, 0.5), pen.Y(0.5, 0.5, 0), 30 + k * 16, 15 + k * 8, 0, 0, Math.PI * 2);
        g.strokeStyle = tone.color;
        g.lineWidth = 1.6;
        g.stroke();
        g.globalAlpha = 1;
      }
    }
    g.restore();
    // The tall House standard with its crest medallion, on every shop and civic project.
    const foot = this.bannerFoot(b, now);
    this.banner(foot.x, foot.y, house, b.id, now, this.bannerTrim(b));
    // Upgrade shimmer.
    const pulsed = this.pulse.get(b.id);
    if (pulsed !== undefined) {
      const k = (now - pulsed) / 700;
      if (k >= 1) this.pulse.delete(b.id);
      else {
        g.globalAlpha = (1 - k) * 0.55;
        g.globalCompositeOperation = 'lighter';
        this.blit(sp, x, y, dz);
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
      }
    }
    // Badges: stockout, full queue.
    if (isShop(b.kind)) {
      const cap = queueCap(b);
      const label = b.dry ? 'SOLD OUT' : b.q >= cap ? 'FULL' : '';
      if (label) this.badge(ox, oy - buildingHeight(b.kind, b.level) - 9, label, b.dry ? '#8C2F27' : '#8A5A0B', b.dry ? '#FBE3DF' : '#FBEBCB');
    }
  }

  /** A warm halo from a pre-rendered sprite; respects the current globalAlpha. */
  private glow(x: number, y: number, r: number, alpha: number, squash = 1): void {
    if (!this.glowSprite) {
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      const cg = c.getContext('2d', { willReadFrequently: this.cpu }) as CanvasRenderingContext2D;
      const gr = cg.createRadialGradient(48, 48, 0, 48, 48, 48);
      gr.addColorStop(0, 'rgba(255,222,150,1)');
      gr.addColorStop(0.22, 'rgba(255,198,120,0.42)');
      gr.addColorStop(0.6, 'rgba(255,184,104,0.1)');
      gr.addColorStop(1, 'rgba(255,180,100,0)');
      cg.fillStyle = gr;
      cg.fillRect(0, 0, 96, 96);
      this.glowSprite = c;
    }
    const g = this.ctx;
    const prev = g.globalAlpha;
    g.globalAlpha = prev * alpha;
    g.drawImage(this.glowSprite, x - r, y - r * squash, r * 2, r * 2 * squash);
    g.globalAlpha = prev;
  }

  private badge(x: number, y: number, text: string, ink: string, bg: string): void {
    const g = this.ctx;
    g.font = `600 4.6px ${SANS}`;
    const w = g.measureText(text).width + 6;
    g.fillStyle = bg;
    roundRect(g, x - w / 2, y - 3.6, w, 7.2, 2);
    g.fill();
    g.strokeStyle = ink;
    g.lineWidth = 0.35;
    g.stroke();
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y + 0.3);
  }

  private drawCitizen(c: CitizenView, alpha: number, ui: UiState, dt: number): void {
    const g = this.ctx;
    const v = this.vis.get(c.id) as CitVis;
    let x = lerp(c.px, c.x, alpha);
    let y = lerp(c.py, c.y, alpha);
    const mx = c.x - c.px;
    const my = c.y - c.py;
    const speed = Math.hypot(mx, my);
    const moving = speed > 0.004 && !this.frozen;
    // Keep to the right-hand pavement while walking; stand true in a queue.
    let txo = 0;
    let tyo = 0;
    const walking = c.state === CS.ToShop || c.state === CS.Stroll || c.state === CS.Leave;
    const tileX = clamp(Math.floor(x), 0, 11);
    const tileY = clamp(Math.floor(y), 0, 11);
    const kind = CITY.tiles[idx(tileX, tileY)];
    if (walking && moving) {
      const h = (hash32(c.id, 9) % 100) / 100;
      const lat = kind === 'avenue' || kind === 'avbridge' ? 0.35 + h * 0.07 : kind === 'bridge' ? 0.08 + h * 0.14 : 0.13 + h * 0.25;
      txo = (-my / speed) * lat;
      tyo = (mx / speed) * lat;
    } else if (walking) {
      txo = v.ox;
      tyo = v.oy;
    }
    const ease = dt > 0 ? 1 - Math.pow(0.0012, dt / 1000) : 0;
    v.ox += (txo - v.ox) * ease;
    v.oy += (tyo - v.oy) * ease;
    x += v.ox;
    y += v.oy;
    let z = 0;
    if (kind === 'bridge' && y - tileY > 0.18 && y - tileY < 0.82) z = this.bridgeZ(x - tileX);
    if (moving) v.phase += dt * 0.014 * (0.8 + speed * 8);
    const bob = moving ? Math.abs(Math.sin(v.phase)) * 1.0 : 0;
    const cx = wxOf(x, y);
    const cy = wyOf(x, y, z);
    const hsh = hash32(c.id, 21);
    const coats = COATS[c.arch] ?? COATS.local;
    const coat = coats[hsh % coats.length];
    const skin = SKIN[(hsh >>> 4) % SKIN.length];
    const hair = HAIR[(hsh >>> 8) % HAIR.length];
    const fade = clamp((this.lastTick(c) + 1) / 4, 0.2, 1);
    g.globalAlpha = fade;
    // Shadow.
    g.fillStyle = 'rgba(46,34,58,0.22)';
    g.beginPath();
    g.ellipse(cx + 0.6, cy + 0.2, 2.7, 1.25, 0, 0, Math.PI * 2);
    g.fill();
    if (ui.selectedCitizen === c.id) {
      g.strokeStyle = C.brass;
      g.lineWidth = 0.9;
      g.beginPath();
      g.ellipse(cx, cy, 5.2, 2.6, 0, 0, Math.PI * 2);
      g.stroke();
    }
    // Legs.
    const step = moving ? Math.sin(v.phase) : 0;
    g.fillStyle = shade(coat, -0.45);
    g.fillRect(cx - 1.5, cy - 3.2 - Math.max(0, step) * 0.9, 1.2, 3.2);
    g.fillRect(cx + 0.3, cy - 3.2 - Math.max(0, -step) * 0.9, 1.2, 3.2);
    // Coat.
    g.fillStyle = coat;
    roundRect(g, cx - 2.3, cy - 9.4 - bob, 4.6, 6.8, 1.7);
    g.fill();
    g.fillStyle = shade(coat, -0.16);
    roundRect(g, cx + 0.5, cy - 9.2 - bob, 1.8, 6.4, 1.2);
    g.fill();
    // Head.
    g.beginPath();
    g.arc(cx, cy - 11.2 - bob, 2.05, 0, Math.PI * 2);
    g.fillStyle = skin;
    g.fill();
    g.beginPath();
    g.arc(cx, cy - 11.6 - bob, 2.1, Math.PI * 1.05, Math.PI * 1.95);
    g.fillStyle = hair;
    g.fill();
    // One telling accessory per archetype.
    if (c.arch === 'tourist') {
      g.fillStyle = '#F4E6C4';
      g.beginPath();
      g.ellipse(cx, cy - 12.5 - bob, 3.3, 1.15, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#C86443';
      g.fillRect(cx - 1.6, cy - 13.3 - bob, 3.2, 0.7);
    } else if (c.arch === 'commuter') {
      g.fillStyle = '#3A2E28';
      g.fillRect(cx + 2.1, cy - 4.8 - bob * 0.5, 2, 1.7);
    } else if (c.arch === 'foodie') {
      g.fillStyle = '#F4E3C1';
      g.fillRect(cx - 3.6, cy - 5.6 - bob * 0.5, 1.7, 2.4);
    } else if (c.arch === 'nightowl') {
      g.fillStyle = '#E9B23A';
      g.fillRect(cx - 2.3, cy - 9.3 - bob, 4.6, 1.1);
    }
    g.globalAlpha = 1;
    if (ui.selectedCitizen === c.id) {
      g.fillStyle = C.brassDark;
      g.beginPath();
      g.moveTo(cx, cy - 15.5 - bob);
      g.lineTo(cx - 2, cy - 18.6 - bob);
      g.lineTo(cx + 2, cy - 18.6 - bob);
      g.closePath();
      g.fill();
    }
  }

  private viewTick = 0;
  private lastTick(c: CitizenView): number {
    return this.viewTick - c.born;
  }

  private drawLamp(l: [number, number], light: boolean): void {
    const g = this.ctx;
    const x = wxOf(l[0], l[1]);
    const y = wyOf(l[0], l[1]);
    if (light) {
      g.globalAlpha = this.night;
      this.glow(x, y - 12, 19, 0.85);
      // Pool of light on the paving.
      this.glow(x, y + 1, 27, 0.3, 0.5);
      return;
    }
    g.fillStyle = '#3B3A40';
    g.fillRect(x - 0.4, y - 12.5, 0.8, 12.5);
    g.fillRect(x - 1.1, y - 0.8, 2.2, 0.8);
    g.fillStyle = '#F5E9CC';
    g.beginPath();
    g.arc(x, y - 13.4, 1.35, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3B3A40';
    g.fillRect(x - 1.5, y - 15.2, 3, 0.7);
  }

  private drawParapet(tile: number): void {
    const g = this.ctx;
    const x = tx(tile);
    const y = ty(tile) + 0.8;
    const pts: number[] = [];
    const n = 10;
    for (let i = 0; i <= n; i++) pts.push(x + i / n, y, this.bridgeZ(i / n) + 3.2);
    for (let i = n; i >= 0; i--) pts.push(x + i / n, y, this.bridgeZ(i / n));
    this.poly(g, '#D8CCB4', pts);
    const cap: number[] = [];
    for (let i = 0; i <= n; i++) cap.push(x + i / n, y, this.bridgeZ(i / n) + 3.2);
    g.beginPath();
    g.moveTo(wxOf(cap[0], cap[1]), wyOf(cap[0], cap[1], cap[2]));
    for (let i = 3; i < cap.length; i += 3) g.lineTo(wxOf(cap[i], cap[i + 1]), wyOf(cap[i], cap[i + 1], cap[i + 2]));
    g.strokeStyle = '#F3ECDD';
    g.lineWidth = 0.9;
    g.stroke();
  }

  private drawStopSign(tile: number, light: boolean): void {
    const g = this.ctx;
    const top = ty(tile) === 1;
    const px = tx(tile) + 0.86;
    const py = ty(tile) + (top ? 0.07 : 0.93);
    const x = wxOf(px, py);
    const y = wyOf(px, py);
    if (light) {
      g.globalAlpha = this.night * 0.8;
      this.glow(x, y - 14, 13, 0.75);
      return;
    }
    // A small glass shelter and a brass roundel.
    const sx = wxOf(tx(tile) + 0.3, py);
    const sy = wyOf(tx(tile) + 0.3, py);
    const ex = wxOf(tx(tile) + 0.7, py);
    const ey = wyOf(tx(tile) + 0.7, py);
    g.fillStyle = '#3B3A40';
    g.fillRect(sx - 0.4, sy - 10, 0.8, 10);
    g.fillRect(ex - 0.4, ey - 10, 0.8, 10);
    g.fillStyle = 'rgba(150,200,208,0.5)';
    g.beginPath();
    g.moveTo(sx, sy - 9);
    g.lineTo(ex, ey - 9);
    g.lineTo(ex, ey - 2);
    g.lineTo(sx, sy - 2);
    g.closePath();
    g.fill();
    g.fillStyle = C.cream;
    g.beginPath();
    g.moveTo(sx - 2, sy - 10.6);
    g.lineTo(ex + 2, ey - 10.6);
    g.lineTo(ex + 4, ey - 9);
    g.lineTo(sx, sy - 9);
    g.closePath();
    g.fill();
    g.fillStyle = C.brass;
    g.fillRect(sx - 2, sy - 11.4, ex - sx + 4, 0.8);
    g.fillStyle = '#3B3A40';
    g.fillRect(x - 0.4, y - 15, 0.8, 15);
    g.beginPath();
    g.arc(x, y - 16.5, 2.6, 0, Math.PI * 2);
    g.fillStyle = C.brass;
    g.fill();
    g.beginPath();
    g.arc(x, y - 16.5, 1.5, 0, Math.PI * 2);
    g.fillStyle = C.cream;
    g.fill();
    g.fillStyle = C.slate;
    g.fillRect(x - 3.2, y - 17.1, 6.4, 1.2);
  }

  private drawTram(view: CityView, i: number, alpha: number, now: number, light: boolean): void {
    const tr = view.trams[i];
    if (!tr) return;
    const g = this.ctx;
    const pos = lerpLoop(tr.ppos, tr.pos, alpha);
    const p = loopPoint(pos);
    // Heading eases through corners.
    const L = CITY.loop.length;
    const f = pos - Math.floor(pos);
    const here = Math.atan2(p.dy, p.dx);
    let ang = here;
    if (f > 0.55) {
      const nx = loopPoint(Math.floor(pos) + 1.01);
      ang = lerpAngle(here, Math.atan2(nx.dy, nx.dx), ((f - 0.55) / 0.45) * 0.5);
    } else if (f < 0.45) {
      const pv = loopPoint((Math.floor(pos) - 0.99 + L) % L);
      ang = lerpAngle(Math.atan2(pv.dy, pv.dx), here, 0.5 + (f / 0.45) * 0.5);
    }
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const half = 0.44;
    const wid = 0.165;
    const corner = (a: number, b: number): [number, number] => [p.x + ca * a - sa * b, p.y + sa * a + ca * b];
    const c = [corner(-half, -wid), corner(half, -wid), corner(half, wid), corner(-half, wid)];
    const P = (q: [number, number], z: number): [number, number] => [wxOf(q[0], q[1]), wyOf(q[0], q[1], z)];
    const quad = (fill: string, a: [number, number], b: [number, number], z0: number, z1: number): void => {
      const p0 = P(a, z0);
      const p1 = P(b, z0);
      const p2 = P(b, z1);
      const p3 = P(a, z1);
      g.beginPath();
      g.moveTo(p0[0], p0[1]);
      g.lineTo(p1[0], p1[1]);
      g.lineTo(p2[0], p2[1]);
      g.lineTo(p3[0], p3[1]);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };
    const lerp2 = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (light) {
      g.globalAlpha = this.night;
      for (let e = 0; e < 4; e++) {
        const a = c[e];
        const b = c[(e + 1) % 4];
        const nx = b[1] - a[1];
        const ny = -(b[0] - a[0]);
        if (nx + ny <= 0.0001) continue;
        const long = e % 2 === 0;
        const n = long ? 5 : 1;
        for (let k = 0; k < n; k++) quad('rgba(255,217,138,0.95)', lerp2(a, b, (k + 0.14) / n), lerp2(a, b, (k + 0.86) / n), 6.6, 10.4);
      }
      const head = corner(half + 0.05, 0);
      const hp = P(head, 5);
      this.glow(hp[0], hp[1], 17, 0.95);
      return;
    }
    // Shadow.
    g.beginPath();
    c.forEach((q, k) => {
      const s = P([q[0] + 0.05, q[1] + 0.08], 0);
      if (k === 0) g.moveTo(s[0], s[1]);
      else g.lineTo(s[0], s[1]);
    });
    g.closePath();
    g.fillStyle = 'rgba(46,34,58,0.25)';
    g.fill();
    const cream = mat('#F3E7CC');
    const brass = mat(C.brass, 0.22, 0.2);
    // Visible faces: those whose outward normal points toward the camera (+x, +y).
    for (let e = 0; e < 4; e++) {
      const a = c[e];
      const b = c[(e + 1) % 4];
      const nx = b[1] - a[1];
      const ny = -(b[0] - a[0]);
      if (nx + ny <= 0.0001) continue;
      const leftish = ny > nx;
      const body = leftish ? cream.left : cream.right;
      quad('#3A3A42', a, b, 0.6, 2.4); // bogies / skirt
      quad(leftish ? brass.left : brass.right, a, b, 2.4, 5.2);
      quad(body, a, b, 5.2, 12);
      quad(leftish ? brass.top : brass.left, a, b, 5.2, 6);
      const long = e % 2 === 0;
      const n = long ? 5 : 1;
      for (let k = 0; k < n; k++) quad(leftish ? '#4E666F' : '#3D535C', lerp2(a, b, (k + 0.14) / n), lerp2(a, b, (k + 0.86) / n), 6.6, 10.4);
      if (long) quad(leftish ? '#C9BEA6' : '#B4A98F', lerp2(a, b, 0.44), lerp2(a, b, 0.56), 2.4, 10.6); // doors
    }
    // Roof.
    g.beginPath();
    c.forEach((q, k) => {
      const s = P(q, 12);
      if (k === 0) g.moveTo(s[0], s[1]);
      else g.lineTo(s[0], s[1]);
    });
    g.closePath();
    g.fillStyle = brass.top;
    g.fill();
    const r = [corner(-half + 0.07, -wid + 0.05), corner(half - 0.07, -wid + 0.05), corner(half - 0.07, wid - 0.05), corner(-half + 0.07, wid - 0.05)];
    g.beginPath();
    r.forEach((q, k) => {
      const s = P(q, 13.2);
      if (k === 0) g.moveTo(s[0], s[1]);
      else g.lineTo(s[0], s[1]);
    });
    g.closePath();
    g.fillStyle = cream.top;
    g.fill();
    // Trolley pole.
    const base = P([p.x, p.y], 13.2);
    const tip = P(corner(-0.2, 0), 20);
    g.strokeStyle = '#3A3A42';
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(base[0], base[1]);
    g.lineTo(tip[0], tip[1]);
    g.stroke();
    if (tr.special) {
      // Free-Ride bunting along the roof.
      const cols = ['#D6453A', '#F7EFDF', '#D48C1C', '#248A63', '#2667B8'];
      for (let k = 0; k < 6; k++) {
        const q = P(corner(-half + 0.12 + k * 0.15, wid), 13 + Math.sin(now / 200 + k) * 0.4);
        g.beginPath();
        g.moveTo(q[0] - 1.6, q[1]);
        g.lineTo(q[0] + 1.6, q[1]);
        g.lineTo(q[0], q[1] + 3.4);
        g.closePath();
        g.fillStyle = cols[k % cols.length];
        g.fill();
      }
    }
  }

  private drawBoat(i: number, now: number, light: boolean): void {
    if (light) return;
    const g = this.ctx;
    const spots: [number, number, string][] = [[9.2, 13.2, '#D6453A'], [10.6, 12.9, '#2667B8'], [1.4, 13.1, '#D48C1C']];
    const [bx, by, col] = spots[i];
    const bobz = Math.sin(now / 900 + i * 2.1) * 0.7;
    const x = wxOf(bx, by);
    const y = wyOf(bx, by, WATER_Z) - bobz;
    g.fillStyle = 'rgba(25,60,72,0.25)';
    g.beginPath();
    g.ellipse(x + 1, y + 2.2, 10, 3.2, -0.46, 0, Math.PI * 2);
    g.fill();
    // Hull.
    g.beginPath();
    g.moveTo(x - 9, y - 3.5);
    g.lineTo(x + 8, y + 5);
    g.lineTo(x + 10.5, y + 2);
    g.lineTo(x + 6, y - 1.5);
    g.lineTo(x - 7.5, y - 6);
    g.closePath();
    g.fillStyle = '#F5EEDD';
    g.fill();
    g.beginPath();
    g.moveTo(x - 9, y - 3.5);
    g.lineTo(x + 8, y + 5);
    g.lineTo(x + 8.4, y + 3.6);
    g.lineTo(x - 8.6, y - 4.8);
    g.closePath();
    g.fillStyle = col;
    g.fill();
    // Mast and furled sail.
    g.fillStyle = C.woodDark;
    g.fillRect(x - 0.4, y - 19, 0.8, 18);
    g.beginPath();
    g.moveTo(x + 0.6, y - 18);
    g.lineTo(x + 0.6, y - 5);
    g.lineTo(x + 7, y - 3);
    g.closePath();
    g.fillStyle = '#FBF6EA';
    g.fill();
  }

  /** The Harbor Cruise liner: slides in while the event runs. */
  private drawShip(now: number, light: boolean): void {
    if (this.shipT <= 0.001) return;
    const g = this.ctx;
    const k = 1 - Math.pow(1 - this.shipT, 3);
    const x0 = lerp(-9.5, 4.3, k);
    const y0 = 12.72;
    const bob = Math.sin(now / 1100) * 0.4;
    const len = 4.3;
    const wid = 0.9;
    const P = (x: number, y: number, z: number): [number, number] => [wxOf(x0 + x, y0 + y), wyOf(x0 + x, y0 + y, WATER_Z + z) - bob];
    const face = (fill: string, pts: [number, number][]): void => {
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };
    if (light) {
      g.globalAlpha = this.night;
      for (let d = 0; d < 2; d++) {
        for (let i = 0; i < 12; i++) {
          const u = 0.5 + i * 0.27;
          face('rgba(255,217,138,0.95)', [P(u, wid, 9.6 + d * 5), P(u + 0.15, wid, 9.6 + d * 5), P(u + 0.15, wid, 12 + d * 5), P(u, wid, 12 + d * 5)]);
        }
      }
      return;
    }
    // Wake and water shadow.
    face('rgba(25,60,72,0.28)', [P(-0.2, wid + 0.25, 0), P(len + 0.5, wid + 0.25, 0), P(len + 0.6, 0.2, 0), P(-0.2, 0.2, 0)]);
    // Hull: navy below, white above, raked bow toward +x.
    const navy = '#2B4460';
    face(shade(navy, -0.1), [P(len, 0, 0), P(len + 0.75, wid / 2, 0), P(len + 0.95, wid / 2, 8), P(len, 0, 8)]);
    face(navy, [P(0, wid, 0), P(len, wid, 0), P(len + 0.75, wid / 2, 0), P(len + 0.95, wid / 2, 8), P(len, wid, 8), P(0, wid, 8)]);
    face('#C86443', [P(0, wid, 0), P(len, wid, 0), P(len + 0.75, wid / 2, 0), P(len + 0.78, wid / 2, 1.3), P(len, wid, 1.3), P(0, wid, 1.3)]);
    face('#F7F1E6', [P(0, wid, 6), P(len, wid, 6), P(len + 0.9, wid / 2, 6), P(len + 0.95, wid / 2, 8), P(len, wid, 8), P(0, wid, 8)]);
    face('#EFE7D6', [P(0, 0, 8), P(len, 0, 8), P(len + 0.95, wid / 2, 8), P(len, wid, 8), P(0, wid, 8)]);
    // Two superstructure decks.
    for (let d = 0; d < 2; d++) {
      const a = 0.35 + d * 0.25;
      const b = len - 0.55 - d * 0.45;
      const z = 8 + d * 5;
      const i0 = 0.1 + d * 0.06;
      const i1 = wid - 0.1 - d * 0.06;
      face('#DCD3C0', [P(b, i0, z), P(b, i1, z), P(b, i1, z + 5), P(b, i0, z + 5)]);
      face('#FBF6EA', [P(a, i1, z), P(b, i1, z), P(b, i1, z + 5), P(a, i1, z + 5)]);
      face('#F1E9D8', [P(a, i0, z + 5), P(b, i0, z + 5), P(b, i1, z + 5), P(a, i1, z + 5)]);
      for (let i = 0; i < 12 - d * 3; i++) {
        const u = a + 0.14 + i * 0.27;
        if (u + 0.15 > b) break;
        face('#4E666F', [P(u, i1, z + 1.6), P(u + 0.15, i1, z + 1.6), P(u + 0.15, i1, z + 4), P(u, i1, z + 4)]);
      }
    }
    // Funnels.
    for (const u of [1.5, 2.4]) {
      face('#A9502F', [P(u + 0.3, 0.3, 18), P(u + 0.3, 0.6, 18), P(u + 0.3, 0.6, 25), P(u + 0.3, 0.3, 25)]);
      face('#C86443', [P(u, 0.6, 18), P(u + 0.3, 0.6, 18), P(u + 0.3, 0.6, 25), P(u, 0.6, 25)]);
      face('#2B2B33', [P(u, 0.6, 23.4), P(u + 0.3, 0.6, 23.4), P(u + 0.3, 0.6, 25), P(u, 0.6, 25)]);
    }
    // Pennant string.
    const cols = ['#D6453A', '#F7EFDF', '#D48C1C', '#248A63', '#2667B8'];
    for (let i = 0; i < 9; i++) {
      const u = 0.4 + i * 0.4;
      const z = 27 - Math.abs(i - 4) * 1.6;
      const q = P(u, 0.45, z);
      g.beginPath();
      g.moveTo(q[0] - 1.4, q[1]);
      g.lineTo(q[0] + 1.4, q[1]);
      g.lineTo(q[0], q[1] + 3);
      g.closePath();
      g.fillStyle = cols[i % cols.length];
      g.fill();
    }
  }

  // ───────────────────────────── Weather ─────────────────────────────

  private rain(t: number): void {
    const g = this.ctx;
    this.setScreen();
    g.strokeStyle = 'rgba(214,230,240,0.55)';
    g.lineWidth = 1;
    g.lineCap = 'round';
    g.globalAlpha = this.rainA;
    g.beginPath();
    const n = Math.round((this.width * this.height) / 7000);
    for (let i = 0; i < n; i++) {
      const h = hash32(31337, i);
      const speed = 900 + (h % 500);
      const x = ((h % 10007) / 10007) * (this.width + 200) - 100;
      const y = ((((h >>> 8) % 9973) / 9973) * (this.height + 80) + t * speed) % (this.height + 80) - 40;
      const len = 9 + (h % 9);
      g.moveTo(x - (y / this.height) * 60, y);
      g.lineTo(x - (y / this.height) * 60 - len * 0.28, y + len);
    }
    g.stroke();
    g.globalAlpha = 1;
  }

  private lanterns(t: number): void {
    const g = this.ctx;
    this.setWorld();
    for (let i = 0; i < 30; i++) {
      const h = hash32(8086, i);
      const bx = 1 + ((h % 1000) / 100);
      const by = 1 + (((h >>> 10) % 1000) / 100);
      const ph = (t * (0.035 + (h % 5) * 0.004) + (h % 97) / 97) % 1;
      const z = 24 + ph * 120;
      const x = wxOf(bx, by) + Math.sin(t * 0.6 + i) * 5;
      const y = wyOf(bx, by, z);
      const a = Math.sin(Math.PI * ph) * this.lanternA;
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = a * 0.9;
      this.glow(x, y, 14, 1);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = a;
      g.fillStyle = i % 3 === 0 ? '#F2B45A' : '#F6C777';
      roundRect(g, x - 1.9, y - 2.6, 3.8, 5, 1.2);
      g.fill();
      g.fillStyle = '#A9502F';
      g.fillRect(x - 1.2, y + 2.2, 2.4, 0.7);
    }
    g.globalAlpha = 1;
  }

  // ───────────────────────────── Overlays ─────────────────────────────

  private diamond(x: number, y: number, inset: number): void {
    const g = this.ctx;
    g.beginPath();
    g.moveTo(wxOf(x + inset, y + inset), wyOf(x + inset, y + inset));
    g.lineTo(wxOf(x + 1 - inset, y + inset), wyOf(x + 1 - inset, y + inset));
    g.lineTo(wxOf(x + 1 - inset, y + 1 - inset), wyOf(x + 1 - inset, y + 1 - inset));
    g.lineTo(wxOf(x + inset, y + 1 - inset), wyOf(x + inset, y + 1 - inset));
    g.closePath();
  }

  private overlays(view: CityView, ui: UiState, now: number): void {
    const g = this.ctx;
    this.viewTick = view.tick;
    const me = view.players[ui.me];
    this.unlockShimmer(view, now);
    if (ui.guideLots && ui.guideLots.length) this.guideRings(view, ui.guideLots, now);
    if (ui.tool && me) {
      const cost = buildCost(ui.tool);
      const afford = me.cash >= cost;
      const world = { buildings: view.buildings, footfall: view.footfall };
      for (const lot of CITY.lots) {
        if (view.buildingAt(lot)) continue;
        const x = tx(lot);
        const y = ty(lot);
        const legal = ui.tool !== 'tramstop' || CITY.avenueAdj[lot] >= 0;
        const ok = legal && afford;
        const hover = lot === ui.hoverTile;
        const col = ok ? '#1F8A55' : '#C67A12';
        if (!legal) {
          // An inland lot can never take a Tram Stop: greyed out and struck through, so the
          // avenue-side lots read as the only choices before any click.
          this.diamond(x, y, 0.06);
          g.fillStyle = `rgba(30,26,22,${hover ? 0.2 : 0.1})`;
          g.fill();
          g.strokeStyle = 'rgba(30,26,22,0.42)';
          g.lineWidth = 0.7;
          g.setLineDash([1.6, 1.8]);
          g.stroke();
          g.setLineDash([]);
          const mx = wxOf(x + 0.5, y + 0.5);
          const my = wyOf(x + 0.5, y + 0.5);
          g.beginPath();
          g.moveTo(mx - 3, my - 1.5);
          g.lineTo(mx + 3, my + 1.5);
          g.moveTo(mx + 3, my - 1.5);
          g.lineTo(mx - 3, my + 1.5);
          g.strokeStyle = 'rgba(30,26,22,0.5)';
          g.lineWidth = 0.9;
          g.stroke();
          continue;
        }
        const strong = ui.tool === 'tramstop'; // the avenue-side lots must pop
        this.diamond(x, y, 0.04);
        g.fillStyle = ok ? `rgba(46,160,100,${hover ? 0.46 : strong ? 0.3 : 0.14})` : `rgba(212,140,28,${hover ? 0.4 : strong ? 0.22 : 0.12})`;
        g.fill();
        g.strokeStyle = col;
        g.lineWidth = hover ? 1.6 : strong ? 1.2 : 0.8;
        g.setLineDash(ok ? [] : [2.2, 1.8]);
        g.stroke();
        g.setLineDash([]);
        // Bonus dots and projected-traffic pips on every candidate lot.
        const bon = lotBonuses(world, lot);
        const pips = trafficPips(world, lot);
        const cx = wxOf(x + 0.5, y + 0.5);
        const cy = wyOf(x + 0.5, y + 0.5);
        const tags: string[] = [];
        if (bon.corner) tags.push(C.ink);
        if (bon.canal) tags.push(C.canal);
        if (bon.transit) tags.push(C.brass);
        if (bon.parks || bon.plaza) tags.push(C.sageDark);
        tags.forEach((tc, i) => {
          g.beginPath();
          g.arc(cx - (tags.length - 1) * 2.2 + i * 4.4, cy - 4.2, 1.5, 0, Math.PI * 2);
          g.fillStyle = tc;
          g.fill();
          g.strokeStyle = '#FBF7EE';
          g.lineWidth = 0.5;
          g.stroke();
        });
        for (let i = 0; i < 5; i++) {
          g.fillStyle = i < pips ? col : 'rgba(30,26,22,0.18)';
          roundRect(g, cx - 7.4 + i * 3.1, cy + 0.6, 2.3, 2.3, 0.6);
          g.fill();
        }
      }
      // Ghost and aura preview on the hovered lot.
      const hov = ui.hoverTile;
      if (hov >= 0 && CITY.tiles[hov] === 'lot' && !view.buildingAt(hov) && (ui.tool !== 'tramstop' || CITY.avenueAdj[hov] >= 0)) {
        const x = tx(hov);
        const y = ty(hov);
        const sp = this.sprite(ui.tool, 1, me.house, 0, CITY.doorDir[hov] === 1, false);
        g.globalAlpha = afford ? 0.72 : 0.4;
        this.blit(sp, x, y, 1 + Math.sin(now / 220) * 0.8);
        g.globalAlpha = 1;
        // Blueprint reach: every lot this civic project will lift, and every shop already there.
        if (ui.tool === 'park' || ui.tool === 'plaza' || ui.tool === 'tramstop') {
          this.reachPreview(view, hov, ui.tool, ui.me, now);
        }
      }
    } else if (ui.hoverTile >= 0 && !ui.tool) {
      const b = view.buildingAt(ui.hoverTile);
      if (b || CITY.tiles[ui.hoverTile] === 'lot') {
        this.diamond(tx(ui.hoverTile), ty(ui.hoverTile), 0.03);
        g.strokeStyle = 'rgba(30,26,22,0.4)';
        g.lineWidth = 0.8;
        g.stroke();
      }
    }
    if (ui.selectedTile >= 0) {
      const x = tx(ui.selectedTile);
      const y = ty(ui.selectedTile);
      const b = view.buildingAt(ui.selectedTile);
      const col = b ? houseTone(view.players[b.owner]?.house ?? -1).color : C.ink;
      const k = 0.5 + 0.5 * Math.sin(now / 300);
      this.diamond(x, y, -0.02 - k * 0.02);
      g.strokeStyle = '#FBF7EE';
      g.lineWidth = 2.6;
      g.stroke();
      g.strokeStyle = col;
      g.lineWidth = 1.3;
      g.stroke();
      // Reach of a selected civic project: its ring and the shops it lifts.
      if (b && (b.kind === 'park' || b.kind === 'plaza' || b.kind === 'tramstop')) this.reachPreview(view, b.tile, b.kind, ui.me, now, true);
    }
    // Tram Stop blueprint: trace the tramway and ring the platforms where trams already call.
    if (ui.tool === 'tramstop') {
      g.beginPath();
      CITY.loop.forEach((t, i) => {
        const px = wxOf(tx(t) + 0.5, ty(t) + 0.5);
        const py = wyOf(tx(t) + 0.5, ty(t) + 0.5, 0.4);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.closePath();
      g.strokeStyle = `rgba(212,163,74,${0.5 + 0.25 * Math.sin(now / 320)})`;
      g.lineWidth = 2.2;
      g.lineJoin = 'round';
      g.setLineDash([5, 3]);
      g.lineDashOffset = -(now / 90) % 8;
      g.stroke();
      g.setLineDash([]);
      g.lineDashOffset = 0;
      for (const st of stopTiles(view)) {
        this.diamond(tx(st), ty(st), 0.12);
        g.strokeStyle = 'rgba(212,163,74,0.95)';
        g.lineWidth = 1.2;
        g.stroke();
      }
    }
    this.eventFocus(view, now);
    // Promo Blitz pills: ink on cream, drawn after the colour grade so they stay crisp at
    // twilight and over canal water. Every House's blitz shows, with its seconds left.
    for (const b of view.buildings) {
      if (!isShop(b.kind) || view.tick >= b.promoUntil) continue;
      const secs = Math.ceil((b.promoUntil - view.tick) / 10);
      const stacked = b.dry || b.q >= queueCap(b);
      this.pill(
        wxOf(tx(b.tile), ty(b.tile)),
        wyOf(tx(b.tile), ty(b.tile)) - buildingHeight(b.kind, b.level) - (stacked ? 19 : 10),
        `PROMO BLITZ ${secs}s`,
        houseTone(view.players[b.owner]?.house ?? -1).color,
        Math.min(1, (b.promoUntil - view.tick) / PROMO_TICKS + 0.25),
      );
    }
    // Queue-length ticks above the player's own busy shops.
    if (me) {
      for (const b of view.buildings) {
        if (b.owner !== ui.me || !isShop(b.kind) || b.q === 0 || b.dry) continue;
        const cap = queueCap(b);
        if (b.q >= cap) continue;
        const x = wxOf(tx(b.tile), ty(b.tile));
        const y = wyOf(tx(b.tile), ty(b.tile)) - buildingHeight(b.kind, b.level) - 7;
        const w = cap * 2.2;
        for (let i = 0; i < cap; i++) {
          g.fillStyle = i < b.q ? (b.q >= cap - 1 ? '#C67A12' : C.ink) : 'rgba(30,26,22,0.22)';
          g.fillRect(x - w / 2 + i * 2.2, y, 1.5, 2.6);
        }
      }
    }
  }

  /** A high-contrast label: ink text on solid cream with an ink hairline and a House dot. */
  private pill(x: number, y: number, text: string, dot: string | null, alpha = 1): void {
    const g = this.ctx;
    // Sized in world units but never allowed to shrink below a readable 8.5 px on screen.
    const k = Math.max(1, 8.5 / (6 * this.cam.zoom));
    g.font = `700 ${6 * k}px ${SANS}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const tw = g.measureText(text).width;
    const pad = (dot ? 6.6 : 4.2) * k;
    const w = tw + pad + 4.2 * k;
    const h = 10 * k;
    const prev = g.globalAlpha;
    g.globalAlpha = prev * clamp(alpha, 0, 1);
    g.fillStyle = CREAM;
    roundRect(g, x - w / 2, y - h / 2, w, h, h / 2);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 0.65 * k;
    g.stroke();
    if (dot) {
      g.beginPath();
      g.arc(x - w / 2 + 5 * k, y, 1.9 * k, 0, Math.PI * 2);
      g.fillStyle = dot;
      g.fill();
    }
    g.fillStyle = INK;
    g.fillText(text, x + (dot ? 2.2 * k : 0), y + 0.4 * k);
    g.globalAlpha = prev;
  }

  /**
   * The reach of a civic project standing (or about to stand) on `tile`: a clean ring around
   * the footprint, a wash on every lot inside it, and a marker on each shop it will lift.
   */
  private reachPreview(view: CityView, tile: number, kind: 'park' | 'plaza' | 'tramstop', me: number, now: number, quiet = false): void {
    const g = this.ctx;
    const x = tx(tile);
    const y = ty(tile);
    const reach = civicReach(view, tile, kind);
    const tram = kind === 'tramstop';
    const hue = tram ? '212,163,74' : '95,138,108';
    const line = tram ? C.brass : C.sageDark;
    for (const l of reach.lots) {
      this.diamond(tx(l), ty(l), 0.08);
      g.fillStyle = `rgba(${hue},${quiet ? 0.16 : 0.3})`;
      g.fill();
      g.strokeStyle = `rgba(${hue},${quiet ? 0.5 : 0.85})`;
      g.lineWidth = 0.7;
      g.stroke();
    }
    // The ring itself: cream under the colour so it reads on paving, turf and water alike.
    g.beginPath();
    if (tram) {
      const av = CITY.avenueAdj[tile];
      // A Tram Stop reaches along streets: a diamond of TRANSIT_RADIUS around its platform.
      const ax = tx(av) + 0.5;
      const ay = ty(av) + 0.5;
      const r = TRANSIT_RADIUS + 0.5;
      g.moveTo(wxOf(ax - r, ay), wyOf(ax - r, ay));
      g.lineTo(wxOf(ax, ay - r), wyOf(ax, ay - r));
      g.lineTo(wxOf(ax + r, ay), wyOf(ax + r, ay));
      g.lineTo(wxOf(ax, ay + r), wyOf(ax, ay + r));
    } else {
      const r = auraRadius(kind);
      g.moveTo(wxOf(x - r, y - r), wyOf(x - r, y - r));
      g.lineTo(wxOf(x + 1 + r, y - r), wyOf(x + 1 + r, y - r));
      g.lineTo(wxOf(x + 1 + r, y + 1 + r), wyOf(x + 1 + r, y + 1 + r));
      g.lineTo(wxOf(x - r, y + 1 + r), wyOf(x - r, y + 1 + r));
    }
    g.closePath();
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(250,247,240,0.9)';
    g.lineWidth = quiet ? 2 : 2.8;
    g.stroke();
    g.strokeStyle = line;
    g.lineWidth = quiet ? 0.9 : 1.4;
    g.setLineDash([4, 2.6]);
    g.lineDashOffset = quiet ? 0 : -(now / 110) % 6.6;
    g.stroke();
    g.setLineDash([]);
    g.lineDashOffset = 0;
    if (tram) {
      const av = CITY.avenueAdj[tile];
      this.diamond(tx(av), ty(av), 0.1);
      g.strokeStyle = C.brass;
      g.lineWidth = 1.4;
      g.stroke();
    }
    // Shops inside: yours get a full marker, a rival's an outlined one — an aura lifts both.
    for (const b of reach.shops) {
      const mx = wxOf(tx(b.tile), ty(b.tile));
      const my = wyOf(tx(b.tile), ty(b.tile)) - buildingHeight(b.kind, b.level) - 5;
      const mine = b.owner === me;
      g.beginPath();
      g.moveTo(mx, my - 3.2);
      g.lineTo(mx + 2.8, my + 1.4);
      g.lineTo(mx - 2.8, my + 1.4);
      g.closePath();
      g.fillStyle = mine ? line : CREAM;
      g.fill();
      g.strokeStyle = mine ? CREAM : line;
      g.lineWidth = 0.7;
      g.stroke();
    }
  }

  /**
   * A forecast or running Gazette event points at what it touches: a brass outline and an
   * up-chevron on the shops it lifts, a slate down-chevron on the ones it hurts, and a slow
   * ring on the landmark it arrives through (the Harbor Pier, the tram platforms).
   */
  private eventFocus(view: CityView, now: number): void {
    const ev = view.event;
    if (!ev) return;
    const g = this.ctx;
    const hi = eventHighlights(view, ev.kind, stopTiles(view));
    const live = ev.started;
    const k = 0.5 + 0.5 * Math.sin(now / (live ? 260 : 420));
    const mark = (tile: number, up: boolean): void => {
      const x = tx(tile);
      const y = ty(tile);
      const b = view.buildingAt(tile);
      this.diamond(x, y, 0.02);
      g.strokeStyle = up ? `rgba(212,163,74,${(live ? 0.55 : 0.4) + 0.35 * k})` : `rgba(70,75,87,${0.4 + 0.25 * k})`;
      g.lineWidth = live ? 1.5 : 1;
      g.setLineDash(live ? [] : [2.4, 2]);
      g.stroke();
      g.setLineDash([]);
      const mx = wxOf(x, y) + 9;
      const my = wyOf(x, y) - (b ? buildingHeight(b.kind, b.level) : 0) - 4 - (up ? k * 1.4 : -k * 1.4);
      const d = up ? -1 : 1;
      g.beginPath();
      g.moveTo(mx - 2.6, my - d * 1.4);
      g.lineTo(mx, my + d * 1.6);
      g.lineTo(mx + 2.6, my - d * 1.4);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = CREAM;
      g.lineWidth = 2.4;
      g.stroke();
      g.strokeStyle = up ? '#8A6410' : '#464B57';
      g.lineWidth = 1.2;
      g.stroke();
    };
    for (const t of hi.boost) mark(t, true);
    for (const t of hi.dampen) mark(t, false);
    for (const t of hi.landmarks) {
      const cx = wxOf(tx(t) + 0.5, ty(t) + 0.5);
      const cy = wyOf(tx(t) + 0.5, ty(t) + 0.5);
      for (let i = 0; i < 2; i++) {
        const ph = (now / 1600 + i * 0.5) % 1;
        g.beginPath();
        g.ellipse(cx, cy, 10 + ph * 22, 5 + ph * 11, 0, 0, Math.PI * 2);
        g.strokeStyle = `rgba(212,163,74,${(1 - ph) * (live ? 0.85 : 0.55)})`;
        g.lineWidth = 1.3;
        g.stroke();
      }
    }
    if (ev.kind === 'cruise') {
      const p = CITY.pierTile;
      this.pill(wxOf(tx(p) + 0.5, ty(p) + 1.6), wyOf(tx(p) + 0.5, ty(p) + 1.6) - 16, live ? 'HARBOR PIER · TOURISTS ASHORE' : 'HARBOR PIER · LINER DUE', null, 0.95);
    }
  }

  private drawFloaters(now: number): void {
    const g = this.ctx;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      const k = (now - f.t0) / f.life;
      if (k >= 1) {
        this.floaters.splice(i, 1);
        continue;
      }
      if (k < 0) continue;
      const rise = 1 - Math.pow(1 - k, 2);
      const x = wxOf(f.x, f.y);
      const y = wyOf(f.x, f.y, f.z);
      const fade = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      g.globalAlpha = fade;
      switch (f.kind) {
        case 'coin': {
          const yy = y - rise * 15;
          g.font = `700 6px ${MONO}`;
          const text = f.text ?? '';
          const w = g.measureText(text).width;
          // Brass coin with the House colour at its heart.
          g.beginPath();
          g.arc(x - w / 2 - 3.6, yy, 2.7, 0, Math.PI * 2);
          g.fillStyle = C.brass;
          g.fill();
          g.beginPath();
          g.arc(x - w / 2 - 3.6, yy, 1.5, 0, Math.PI * 2);
          g.fillStyle = f.color ?? C.brassDark;
          g.fill();
          g.lineWidth = 1.6;
          g.strokeStyle = 'rgba(251,247,238,0.92)';
          g.strokeText(text, x + 0.4, yy + 0.3);
          g.fillStyle = '#6B4A12';
          g.fillText(text, x + 0.4, yy + 0.3);
          break;
        }
        case 'star': {
          const yy = y - rise * 9;
          star(g, x, yy, 3.1 * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, k * 2))), C.brass);
          break;
        }
        case 'spark': {
          const yy = y - rise * 8;
          star(g, x, yy, 2.2 * Math.sin(Math.PI * k), '#F4D58A');
          break;
        }
        case 'puff': {
          g.globalAlpha = (1 - k) * 0.5;
          g.beginPath();
          g.arc(x, y - rise * 7, 1.6 + k * 4, 0, Math.PI * 2);
          g.fillStyle = '#E9DEC8';
          g.fill();
          break;
        }
        case 'pill': {
          // Launch call-out: ink on cream, so it reads over roofs, paving and teal water.
          this.pill(x, y - rise * 9, f.text ?? '', f.color ?? null, fade);
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          break;
        }
        case 'turn': {
          const yy = y - rise * 8;
          // A little amber arrow turning back on itself.
          g.strokeStyle = '#C67A12';
          g.lineWidth = 1.1;
          g.lineCap = 'round';
          g.beginPath();
          g.arc(x, yy, 2.6, Math.PI * 0.9, Math.PI * 2.2);
          g.stroke();
          g.beginPath();
          g.moveTo(x - 3.6, yy + 0.4);
          g.lineTo(x - 2.3, yy - 1.5);
          g.lineTo(x - 0.9, yy + 0.8);
          g.closePath();
          g.fillStyle = '#C67A12';
          g.fill();
          break;
        }
        default: {
          const yy = y - rise * 10;
          g.font = `700 5px ${SANS}`;
          g.lineWidth = 1.8;
          g.strokeStyle = 'rgba(251,247,238,0.95)';
          g.strokeText(f.text ?? '', x, yy);
          g.fillStyle = f.color ?? C.ink;
          g.fillText(f.text ?? '', x, yy);
        }
      }
    }
    g.globalAlpha = 1;
  }

  // ───────────────────────────── Picking ─────────────────────────────

  pick(sx: number, sy: number, view: CityView, alpha: number): Pick {
    const w = this.screenToWorld(sx, sy);
    // Citizens first: they are small, so be generous.
    let best = -1;
    let bd = 9 / Math.min(1.4, this.cam.zoom) + 3;
    for (const c of view.citizens.values()) {
      if (c.state === CS.Serve) continue;
      const v = this.vis.get(c.id);
      const x = lerp(c.px, c.x, alpha) + (v ? v.ox : 0);
      const y = lerp(c.py, c.y, alpha) + (v ? v.oy : 0);
      const d = Math.hypot(wxOf(x, y) - w.x, wyOf(x, y, 6) - w.y);
      if (d < bd) {
        bd = d;
        best = c.id;
      }
    }
    // A citizen right under the pointer wins outright.
    if (best >= 0 && bd <= 6 / this.cam.zoom) return { kind: 'citizen', id: best };
    // Buildings: test the tall silhouettes front to back. A tap inside one selects the
    // building even with a passer-by close to it, so shops stay easy to hit zoomed out on a phone.
    const hits = view.buildings
      .slice()
      .sort((a, b) => tx(b.tile) + ty(b.tile) - (tx(a.tile) + ty(a.tile)));
    for (const b of hits) {
      const h = buildingHeight(b.kind, b.level);
      for (let k = 0; k <= 4; k++) {
        if (this.worldToTile(w.x, w.y + (h * k) / 4) === b.tile) return { kind: 'tile', tile: b.tile };
      }
    }
    if (best >= 0) return { kind: 'citizen', id: best };
    const t = this.worldToTile(w.x, w.y);
    return t >= 0 ? { kind: 'tile', tile: t } : null;
  }

  private worldToTile(wx: number, wy: number): number {
    const fx = (wx / HW + wy / HH) / 2;
    const fy = (wy / HH - wx / HW) / 2;
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    return x >= 0 && y >= 0 && x < W && y < H ? idx(x, y) : -1;
  }

  /** The ground tile under a screen point (ignores building height). */
  tileAt(sx: number, sy: number): number {
    const w = this.screenToWorld(sx, sy);
    return this.worldToTile(w.x, w.y);
  }

  /** Interpolated screen position of a citizen's head, for the speech card. */
  citizenScreen(c: CitizenView, alpha: number): { x: number; y: number } {
    const v = this.vis.get(c.id);
    const x = lerp(c.px, c.x, alpha) + (v ? v.ox : 0);
    const y = lerp(c.py, c.y, alpha) + (v ? v.oy : 0);
    return this.tileToScreen(x, y, 15);
  }
}

// ───────────────────────────── Helpers ─────────────────────────────

function lerpLoop(a: number, b: number, t: number): number {
  const L = CITY.loop.length;
  let d = b - a;
  if (d < -L / 2) d += L;
  if (d > L / 2) d -= L;
  return (((a + d * t) % L) + L) % L;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  if (r <= 0.05) return;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * i) / 4 - Math.PI / 2;
    const rr = i % 2 ? r * 0.38 : r;
    if (i === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

function convexHull(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
