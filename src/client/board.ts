// The MERCADIA board: a still, printed 12×12 isometric plate on Canvas 2D.
// It redraws only on state change, input (pan/zoom/hover) or resize, through ONE scheduled
// requestAnimationFrame per dirty flag. There is no animation loop, tweening or interpolation.
//
// Conventions for the HUD: all coordinates are CSS pixels relative to the canvas's top-left
// corner (the canvas is expected to fill the viewport). `panBy(dx, dy)` moves the CONTENT by
// (dx, dy) screen px, exactly like a drag (panBy(60, 0) shifts the map 60px to the right).
import { ARCHETYPES, EVENTS, TRANSIT_RADIUS, auraRadius, buildName, isShop } from '../shared/constants';
import { CITY, H as MAP_H, W as MAP_W, chebyshev, idx, tx, ty } from '../shared/map';
import { buildingAt, daypartOf, eraOfTurn, maxCohesion, moveOf, tileName, unitById } from '../shared/game';
import { contestPreview, describeOrder, pathFor, reachFrom, standable } from '../shared/orders';
import type { Building, EventKind, Game, SummaryLine, Unit } from '../shared/types';
import type { Armed, BoardApi, BoardState, Hit } from './contracts';
import {
  ALABASTER,
  BRASS,
  CANAL,
  GRAPHITE,
  HH,
  HW,
  INK,
  Pen,
  SAGE,
  TERRACOTTA,
  TOKEN_H,
  TRAVERTINE_DEEP,
  drawBanner,
  drawBuildingArt,
  drawCitizen,
  drawFerry,
  drawLamp,
  drawLiner,
  drawPennantLine,
  drawPier,
  drawTally,
  drawToken,
  garden,
  hash32,
  heightOf,
  houseTone,
  mix,
  station,
  themeFor,
  townhouse,
  type Theme,
} from './board-art';

const SANS = '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';

// ───────────────────────────── Plate geometry (tile units) ─────────────────────────────

const LX0 = -0.45;
const LX1 = 12.45;
const LY0 = -0.45;
const LY1 = 14.0;
const QUAY_Y = 12;
const HARBOR_Y1 = 13.7;
const HX0 = -0.15;
const HX1 = 12.15;
const SLAB = 15;
const WATER_Z = -5;
/** World-pixel bounds of everything printed (including banners over the back row). */
const BOUNDS = { x0: -480, x1: 430, y0: -84, y1: 452 };

const wxOf = (x: number, y: number): number => (x - y) * HW;
const wyOf = (x: number, y: number, z = 0): number => (x + y) * HH - z;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

const isWaterKind = (k: string | undefined): boolean => k === 'canal' || k === 'bridge' || k === 'avbridge';
const isRoadKind = (k: string | undefined): boolean => k === 'avenue' || k === 'avbridge' || k === 'lane' || k === 'bridge';
const kindAt = (x: number, y: number): string | undefined => (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H ? CITY.tiles[idx(x, y)] : undefined);
/** Snap targets for taps: lots and street tiles (canal tiles only on an exact hit). */
const snappable = (t: number): boolean => {
  const k = CITY.tiles[t];
  return k === 'lot' || k === 'avenue' || k === 'lane' || k === 'bridge' || k === 'avbridge';
};
const bridgeZ = (t: number): number => 4.6 * Math.sin(Math.PI * clamp(t, 0, 1));

/** Where each event's callout points on the plate (tile coordinates). */
const EVENT_ANCHOR: Record<EventKind, [number, number]> = {
  cloudburst: [8.5, 4.5],
  cruise: [5.2, 13.0],
  freeride: [9.5, 1.5],
  critic: [8.5, 1.6],
  lantern: [3.5, 5.5],
  renthike: [4.5, 8.5],
  supplycrunch: [3.5, 12.6],
};

interface Obj {
  d: number;
  f: () => void;
}

export function createBoard(canvas: HTMLCanvasElement): BoardApi {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  const c2 = ctx;

  let st: BoardState | null = null;
  let W = 1;
  let H = 1;
  let dpr = 1;
  let zoom = 1;
  let camX = (BOUNDS.x0 + BOUNDS.x1) / 2;
  let camY = (BOUNDS.y0 + BOUNDS.y1) / 2;
  let insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let userMoved = false;
  let raf = 0;
  let destroyed = false;
  let pickCb: ((hit: Hit, e: { shift: boolean; touch: boolean; right: boolean }) => void) | null = null;
  let hoverCb: ((tile: number) => void) | null = null;
  let lastHover = -2;
  const pen = new Pen();

  // ───────────────────────────── Camera ─────────────────────────────

  const freeW = (): number => Math.max(80, W - insets.left - insets.right);
  const freeH = (): number => Math.max(80, H - insets.top - insets.bottom);
  // Portrait screens fit the district's core (the harbor's far corner may crop) so tiles stay usable.
  const fitWidth = (): number => (H > W * 1.15 ? 800 : BOUNDS.x1 - BOUNDS.x0);
  const fitCx = (): number => (H > W * 1.15 ? -10 : (BOUNDS.x0 + BOUNDS.x1) / 2);
  const fitZoom = (): number => clamp(Math.min(freeW() / fitWidth(), freeH() / (BOUNDS.y1 - BOUNDS.y0)) * 0.98, 0.18, 3);
  const minZoom = (): number => Math.max(0.18, fitZoom() * 0.62);
  const MAX_ZOOM = 3.6;

  const sx = (wx: number): number => (wx - camX) * zoom + W / 2;
  const sy = (wy: number): number => (wy - camY) * zoom + H / 2;
  const tileScr = (x: number, y: number, z = 0): { x: number; y: number } => ({ x: sx(wxOf(x, y)), y: sy(wyOf(x, y, z)) });

  function clampCam(): void {
    const mx = ((insets.left + insets.right) / 2 + 60) / zoom;
    const my = ((insets.top + insets.bottom) / 2 + 60) / zoom;
    camX = clamp(camX, BOUNDS.x0 - mx, BOUNDS.x1 + mx);
    camY = clamp(camY, BOUNDS.y0 - my, BOUNDS.y1 + my);
  }

  function fit(): void {
    zoom = fitZoom();
    const cx = fitCx();
    const cy = (BOUNDS.y0 + BOUNDS.y1) / 2;
    const scx = insets.left + freeW() / 2;
    const scy = insets.top + freeH() / 2;
    camX = cx - (scx - W / 2) / zoom;
    camY = cy - (scy - H / 2) / zoom;
    userMoved = false;
    schedule();
  }

  function zoomAt(factor: number, px: number, py: number): void {
    const bx = (px - W / 2) / zoom + camX;
    const by = (py - H / 2) / zoom + camY;
    zoom = clamp(zoom * factor, minZoom(), MAX_ZOOM);
    camX = bx - (px - W / 2) / zoom;
    camY = by - (py - H / 2) / zoom;
    userMoved = true;
    clampCam();
    schedule();
  }

  function panBy(dx: number, dy: number): void {
    if (!dx && !dy) return;
    camX -= dx / zoom;
    camY -= dy / zoom;
    userMoved = true;
    clampCam();
    schedule();
  }

  /** Screen position (CSS px) of a tile's centre, or null when it lies outside the canvas. */
  function tileScreenPos(tile: number): { x: number; y: number } | null {
    if (tile < 0 || tile >= MAP_W * MAP_H) return null;
    const p = tileScr(tx(tile) + 0.5, ty(tile) + 0.5);
    return p.x < 0 || p.y < 0 || p.x > W || p.y > H ? null : p;
  }

  function centerOn(tile: number): void {
    if (tile < 0 || tile >= MAP_W * MAP_H) return;
    const wx = wxOf(tx(tile) + 0.5, ty(tile) + 0.5);
    const wy = wyOf(tx(tile) + 0.5, ty(tile) + 0.5, 12);
    const px = sx(wx);
    const py = sy(wy);
    const m = 56;
    const l = insets.left + m;
    const r = W - insets.right - m;
    const t = insets.top + m;
    const b = H - insets.bottom - m;
    if (px >= l && px <= r && py >= t && py <= b) return;
    const scx = insets.left + freeW() / 2;
    const scy = insets.top + freeH() / 2;
    camX = wx - (scx - W / 2) / zoom;
    camY = wy - (scy - H / 2) / zoom;
    userMoved = true;
    clampCam();
    schedule();
  }

  function resize(): void {
    const cw = Math.max(1, Math.floor(canvas.clientWidth || window.innerWidth || 1));
    const ch = Math.max(1, Math.floor(canvas.clientHeight || window.innerHeight || 1));
    const nd = Math.min(window.devicePixelRatio || 1, 3);
    if (cw === W && ch === H && nd === dpr && canvas.width > 0) return;
    W = cw;
    H = ch;
    dpr = nd;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (!userMoved) fit();
    else {
      clampCam();
      schedule();
    }
  }

  // ───────────────────────────── Scheduling ─────────────────────────────

  function schedule(): void {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!destroyed) draw();
    });
  }

  // ───────────────────────────── Scale helpers ─────────────────────────────

  /** Tokens stay ≥ 28px tall on screen at every zoom the district fits at. */
  const tokenScale = (): number => clamp(0.95 / zoom, 1, 2.1);
  const citizenScale = (): number => clamp(0.8 / zoom, 1, 1.7);
  const bannerScale = (): number => clamp(0.85 / zoom, 0.9, 1.5);

  // ───────────────────────────── Units layout (shared by draw and pick) ─────────────────────────────

  interface UnitSpot {
    u: Unit;
    wx: number;
    wy: number;
    s: number;
    alongY: boolean;
  }

  function unitSpots(g: Game): UnitSpot[] {
    const s = tokenScale();
    const byTile = new Map<number, number>();
    const out: UnitSpot[] = [];
    for (const u of g.units) {
      const x = tx(u.tile) + 0.5;
      const y = ty(u.tile) + 0.5;
      const k = CITY.tiles[u.tile];
      const z = u.kind === 'barge' ? WATER_Z + 1.5 : k === 'bridge' ? bridgeZ(0.5) : 0;
      const n = byTile.get(u.tile) ?? 0;
      byTile.set(u.tile, n + 1);
      const off = n === 0 ? 0 : (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 15 * s;
      const alongY = isWaterKind(kindAt(tx(u.tile), ty(u.tile) - 1)) || isWaterKind(kindAt(tx(u.tile), ty(u.tile) + 1));
      out.push({ u, wx: wxOf(x, y) + off, wy: wyOf(x, y, z), s, alongY });
    }
    out.sort((a, b) => a.wy - b.wy);
    return out;
  }

  // ───────────────────────────── Drawing primitives (world space) ─────────────────────────────

  function poly3(fill: string | null, pts: number[], stroke: number | null = 1, lw = 1, color = INK): void {
    const c = c2;
    c.beginPath();
    for (let i = 0; i < pts.length; i += 3) {
      const X = wxOf(pts[i], pts[i + 1]);
      const Y = wyOf(pts[i], pts[i + 1], pts[i + 2]);
      if (i) c.lineTo(X, Y);
      else c.moveTo(X, Y);
    }
    c.closePath();
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.lineWidth = lw * stroke;
      c.strokeStyle = color;
      c.lineJoin = 'round';
      c.stroke();
    }
  }
  const rect3 = (fill: string | null, x0: number, y0: number, x1: number, y1: number, z: number, stroke: number | null, lw: number, color = INK): void =>
    poly3(fill, [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], stroke, lw, color);

  function line3(color: string, w: number, pts: number[]): void {
    const c = c2;
    c.beginPath();
    for (let i = 0; i < pts.length; i += 3) {
      const X = wxOf(pts[i], pts[i + 1]);
      const Y = wyOf(pts[i], pts[i + 1], pts[i + 2]);
      if (i) c.lineTo(X, Y);
      else c.moveTo(X, Y);
    }
    c.strokeStyle = color;
    c.lineWidth = w;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.stroke();
  }

  /** Engraved water hatching over a rect (tile units) at height z. Deterministic and seamless across rects. */
  function hatchWater(th: Theme, lw: number, x0: number, y0: number, x1: number, y1: number, z: number): void {
    const c = c2;
    const dark = new Path2D();
    const light = new Path2D();
    const STEP = 0.14;
    for (let k = Math.ceil((y0 + 0.03) / STEP); k * STEP < y1 - 0.03; k++) {
      const v = k * STEP;
      for (let cell = Math.floor(x0 / 0.5); cell * 0.5 < x1; cell++) {
        const h = hash32(cell, k);
        if (h % 5 === 0) continue;
        const a = cell * 0.5 + 0.02 + ((h >>> 3) % 14) / 100;
        const b = a + 0.2 + ((h >>> 9) % 20) / 100;
        const u0 = Math.max(a, x0 + 0.03);
        const u1 = Math.min(b, x1 - 0.03);
        if (u1 - u0 < 0.05) continue;
        const path = k % 3 === 0 ? light : dark;
        path.moveTo(wxOf(u0, v), wyOf(u0, v, z));
        path.lineTo(wxOf(u1, v), wyOf(u1, v, z));
      }
    }
    c.lineCap = 'butt';
    c.lineWidth = lw * 0.8;
    c.strokeStyle = mix(th.waterDeep, INK, 0.25);
    c.globalAlpha = 0.75;
    c.stroke(dark);
    c.strokeStyle = ALABASTER;
    c.globalAlpha = 0.4;
    c.stroke(light);
    c.globalAlpha = 1;
  }

  /** A stone face with an arched opening where water passes under a deck (plane y, facing south). */
  function archFace(th: Theme, lw: number, x0: number, x1: number, y: number, z0: number): void {
    poly3(th.slabLeft, [x0, y, z0, x1, y, z0, x1, y, WATER_Z, x0, y, WATER_Z], 1, lw);
    const pts: number[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      pts.push(x0 + 0.1 + 0.8 * (x1 - x0) * t, y, WATER_Z + 4.4 * Math.sin(Math.PI * t));
    }
    poly3(th.waterDeep, pts, 1, lw);
  }

  // ───────────────────────────── Ground ─────────────────────────────

  function drawPlate(g: Game, th: Theme, lw: number): void {
    // Plate mat: a faint travertine mount with a hairline border, beneath the slab.
    const m = 0.9;
    poly3(mix(th.page, th.slabTop, 0.42), [LX0 - m, LY0 - m, -SLAB, LX1 + m, LY0 - m, -SLAB, LX1 + m, LY1 + m, -SLAB, LX0 - m, LY1 + m, -SLAB], 1, lw, 'rgba(22,19,15,0.28)');

    // Slab edges.
    poly3(th.slabLeft, [LX0, LY1, 0, LX1, LY1, 0, LX1, LY1, -SLAB, LX0, LY1, -SLAB], 1, lw);
    poly3(th.slabRight, [LX1, LY0, 0, LX1, LY1, 0, LX1, LY1, -SLAB, LX1, LY0, -SLAB], 1, lw);
    line3('rgba(22,19,15,0.22)', lw, [LX0, LY1, -4, LX1, LY1, -4, LX1, LY0, -4]);
    line3('rgba(22,19,15,0.22)', lw, [LX0, LY1, -10, LX1, LY1, -10, LX1, LY0, -10]);

    // The slab's travertine top (the whole plate; the harbor basin is cut into it below).
    rect3(th.slabTop, LX0, LY0, LX1, LY1, 0, 1, lw);
    // A fine ruled keyline just inside the slab edge, like a plate border.
    rect3(null, LX0 + 0.12, LY0 + 0.12, LX1 - 0.12, QUAY_Y - 0.06, 0, 0.8, lw, 'rgba(22,19,15,0.2)');

    // Harbor basin: quay wall, water, inner wall of the west lip.
    poly3(th.slabLeft, [HX0, QUAY_Y, 0, HX1, QUAY_Y, 0, HX1, QUAY_Y, WATER_Z, HX0, QUAY_Y, WATER_Z], 1, lw);
    poly3(th.slabRight, [HX0, QUAY_Y, 0, HX0, HARBOR_Y1, 0, HX0, HARBOR_Y1, WATER_Z, HX0, QUAY_Y, WATER_Z], 1, lw);
    rect3(th.water, HX0, QUAY_Y, HX1, HARBOR_Y1, WATER_Z, 1, lw);
    hatchWater(th, lw, HX0, QUAY_Y + 0.02, HX1, HARBOR_Y1, WATER_Z);
    // The canal mouth under the avenue bridge.
    archFace(th, lw, 7, 8, QUAY_Y, 0);
    // Bollards along the quay.
    for (let x = 0.5; x < 12; x += 1) {
      if (x > 6.9 && x < 8.1) continue;
      rect3(INK, x - 0.04, QUAY_Y - 0.1, x + 0.04, QUAY_Y - 0.02, 2.4, null, lw);
    }

    // Tiles, back to front.
    const occ = new Map<number, Building>();
    for (const b of g.buildings) occ.set(b.tile, b);
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) groundTile(th, lw, x, y, occ.get(idx(x, y)));
  }

  function roadFill(th: Theme, kind: string): string {
    return kind === 'lane' ? th.lane : th.paving;
  }

  function groundTile(th: Theme, lw: number, x: number, y: number, b: Building | undefined): void {
    const t = idx(x, y);
    const k = CITY.tiles[t];
    const c = c2;
    switch (k) {
      case 'canal':
      case 'bridge':
      case 'avbridge': {
        if (k === 'avbridge') {
          roadTile(th, lw, x, y, 'avenue');
          // Parapets on both edges of the deck.
          for (const py of [y + 0.04, y + 0.96]) {
            poly3(th.stone.left, [x, py, 0, x + 1, py, 0, x + 1, py, 3.2, x, py, 3.2], 1, lw);
            poly3(th.stone.top, [x, py - 0.04, 3.2, x + 1, py - 0.04, 3.2, x + 1, py + 0.04, 3.2, x, py + 0.04, 3.2], 1, lw);
          }
          break;
        }
        rect3(th.water, x, y, x + 1, y + 1, WATER_Z, null, lw);
        hatchWater(th, lw, x, y, x + 1, y + 1, WATER_Z);
        const north = kindAt(x, y - 1);
        const west = kindAt(x - 1, y);
        if (!isWaterKind(north)) {
          poly3(th.slabLeft, [x, y, 0, x + 1, y, 0, x + 1, y, WATER_Z, x, y, WATER_Z], 1, lw);
          poly3('rgba(22,19,15,0.28)', [x, y, WATER_Z + 1.6, x + 1, y, WATER_Z + 1.6, x + 1, y, WATER_Z, x, y, WATER_Z], null, lw);
        } else if (north === 'avbridge') archFace(th, lw, x, x + 1, y, 0);
        if (!isWaterKind(west)) {
          poly3(th.slabRight, [x, y, 0, x, y + 1, 0, x, y + 1, WATER_Z, x, y, WATER_Z], 1, lw);
          poly3('rgba(22,19,15,0.28)', [x, y, WATER_Z + 1.6, x, y + 1, WATER_Z + 1.6, x, y + 1, WATER_Z, x, y, WATER_Z], null, lw);
        }
        if (k === 'bridge') footbridge(th, lw, x, y);
        break;
      }
      case 'avenue':
      case 'lane':
        roadTile(th, lw, x, y, k);
        break;
      case 'lot': {
        if (b) {
          rect3(th.paving, x + 0.01, y + 0.01, x + 0.99, y + 0.99, 0, 0.7, lw, 'rgba(22,19,15,0.3)');
        } else {
          // Vacant: sage turf in a hairline kerb, tufts, and a lease stake.
          rect3(th.paving, x + 0.01, y + 0.01, x + 0.99, y + 0.99, 0, 0.7, lw, 'rgba(22,19,15,0.3)');
          rect3(th.lot, x + 0.07, y + 0.07, x + 0.93, y + 0.93, 0, 0.7, lw, 'rgba(22,19,15,0.4)');
          c.beginPath();
          for (let i = 0; i < 6; i++) {
            const h = hash32(t, i + 3);
            const px = x + 0.16 + ((h % 68) / 100);
            const py = y + 0.16 + (((h >>> 8) % 68) / 100);
            c.moveTo(wxOf(px, py), wyOf(px, py));
            c.lineTo(wxOf(px, py) - 0.9, wyOf(px, py) - 2.4);
            c.moveTo(wxOf(px, py), wyOf(px, py));
            c.lineTo(wxOf(px, py) + 0.9, wyOf(px, py) - 2.4);
          }
          c.strokeStyle = mix(th.c(SAGE), INK, 0.45);
          c.lineWidth = lw * 0.8;
          c.stroke();
          line3(INK, lw * 1.1, [x + 0.82, y + 0.82, 0, x + 0.82, y + 0.82, 6.5]);
          rect3(ALABASTER, x + 0.78, y + 0.82, x + 0.86, y + 0.82, 6.5, null, lw);
          poly3(ALABASTER, [x + 0.82, y + 0.82, 6.5, x + 0.92, y + 0.82, 6.5, x + 0.92, y + 0.82, 3.6, x + 0.82, y + 0.82, 3.6], 0.9, lw);
        }
        break;
      }
      default:
        // Homes, station and gardens bring their own pads.
        rect3(th.paving, x + 0.01, y + 0.01, x + 0.99, y + 0.99, 0, 0.7, lw, 'rgba(22,19,15,0.3)');
        break;
    }
  }

  function roadTile(th: Theme, lw: number, x: number, y: number, kind: 'avenue' | 'lane'): void {
    const t = idx(x, y);
    const c = c2;
    const av = kind === 'avenue';
    rect3(roadFill(th, kind), x, y, x + 1, y + 1, 0, null, lw);
    // Pavement kerbs where the neighbour is not a road.
    const edges: [number, number, number, number, number, number, number, number][] = [
      // dx, dy of neighbour, edge a→b, strip offset
      [0, -1, x, y, x + 1, y, 0, 1],
      [0, 1, x, y + 1, x + 1, y + 1, 0, -1],
      [-1, 0, x, y, x, y + 1, 1, 0],
      [1, 0, x + 1, y, x + 1, y + 1, -1, 0],
    ];
    const sw = av ? 0.1 : 0.12;
    for (const [dx, dy, ax, ay, bx, by, ox, oy] of edges) {
      const nk = kindAt(x + dx, y + dy);
      if (isRoadKind(nk) || isWaterKind(nk)) continue;
      poly3(th.slabTop, [ax, ay, 0, bx, by, 0, bx + ox * sw, by + oy * sw, 0, ax + ox * sw, ay + oy * sw, 0], null, lw);
      line3('rgba(22,19,15,0.5)', lw, [ax, ay, 0, bx, by, 0]);
    }
    // The quiet hairline grid.
    rect3(null, x, y, x + 1, y + 1, 0, 0.8, lw, 'rgba(22,19,15,0.16)');
    if (!av) return;
    // Tram rails: sleepers, then a double rule.
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
        c.beginPath();
        c.moveTo(wxOf(ax, ay), wyOf(ax, ay));
        c.quadraticCurveTo(wxOf(x + 0.5, y + 0.5), wyOf(x + 0.5, y + 0.5), wxOf(bx, by), wyOf(bx, by));
      };
      c.lineCap = 'butt';
      path();
      c.setLineDash([1, 3.4]);
      c.strokeStyle = 'rgba(22,19,15,0.4)';
      c.lineWidth = 7.4;
      c.stroke();
      c.setLineDash([]);
      path();
      c.strokeStyle = th.c(GRAPHITE);
      c.lineWidth = 5;
      c.stroke();
      path();
      c.strokeStyle = th.paving;
      c.lineWidth = 3.3;
      c.stroke();
      path();
      c.setLineDash([1, 3.4]);
      c.strokeStyle = 'rgba(22,19,15,0.4)';
      c.lineWidth = 3.3;
      c.stroke();
      c.setLineDash([]);
    }
    // Brass platform edge at the city stops; zebra at the Station and the Pier.
    if (CITY.fixedStops.includes(t)) {
      const top = y === 1;
      rect3(th.c(BRASS), x + 0.06, top ? y + 0.12 : y + 0.84, x + 0.94, top ? y + 0.17 : y + 0.89, 0, 0.8, lw);
    }
    if (t === CITY.stationDoor || t === CITY.pierTile) {
      for (let i = 0; i < 5; i++) rect3(ALABASTER, x + 0.2 + i * 0.13, y + 0.2, x + 0.2 + i * 0.13 + 0.07, y + 0.8, 0, 0.6, lw);
    }
  }

  /** Arched stone footbridge carrying a lane (along x) over the canal. */
  function footbridge(th: Theme, lw: number, x: number, y: number): void {
    const y0 = y + 0.2;
    const y1 = y + 0.8;
    const n = 10;
    const far: number[] = [];
    for (let i = 0; i <= n; i++) far.push(x + i / n, y0, bridgeZ(i / n) + 3.2);
    for (let i = n; i >= 0; i--) far.push(x + i / n, y0, bridgeZ(i / n));
    poly3(th.stone.left, far, 1, lw);
    for (let i = 0; i < n; i++) {
      const a = i / n;
      const b = (i + 1) / n;
      poly3(mix(th.lane, '#FFFFFF', 0.25 - a * 0.2), [x + a, y0, bridgeZ(a), x + b, y0, bridgeZ(b), x + b, y1, bridgeZ(b), x + a, y1, bridgeZ(a)], 0.8, lw);
    }
    const face: number[] = [];
    for (let i = 0; i <= n; i++) face.push(x + i / n, y1, bridgeZ(i / n));
    for (let i = n; i >= 0; i--) {
      const t = i / n;
      face.push(x + 0.1 + 0.8 * t, y1, WATER_Z + 6.4 * Math.sin(Math.PI * t));
    }
    poly3(th.stone.left, face, 1, lw);
    // Parapet cap along the near edge.
    const cap: number[] = [];
    for (let i = 0; i <= n; i++) cap.push(x + i / n, y1, bridgeZ(i / n) + 2.6);
    for (let i = n; i >= 0; i--) cap.push(x + i / n, y1 - 0.05, bridgeZ(i / n) + 2.6);
    poly3(th.stone.top, cap, 1, lw);
  }

  // ───────────────────────────── Ownership ─────────────────────────────

  /** Soft House wash, then the double-stroked kerb (shared outer trim across adjacent lots). */
  function drawOwnership(g: Game, th: Theme, lw: number): void {
    const own = new Map<number, number>();
    for (const b of g.buildings) if (b.owner >= 0 && g.players[b.owner]) own.set(b.tile, b.owner);
    if (!own.size) return;
    const c = c2;
    // Wash: one path per House so adjoining lots take a single seamless fill.
    const byHouse = new Map<number, Path2D>();
    for (const [t, owner] of own) {
      const house = g.players[owner].house;
      let p = byHouse.get(house);
      if (!p) byHouse.set(house, (p = new Path2D()));
      const x = tx(t);
      const y = ty(t);
      p.moveTo(wxOf(x, y), wyOf(x, y));
      p.lineTo(wxOf(x + 1, y), wyOf(x + 1, y));
      p.lineTo(wxOf(x + 1, y + 1), wyOf(x + 1, y + 1));
      p.lineTo(wxOf(x, y + 1), wyOf(x, y + 1));
      p.closePath();
    }
    for (const [house, p] of byHouse) {
      c.fillStyle = houseTone(house).wash;
      c.fill(p);
    }
    const TD = 0.05;
    const TP = 0.055;
    for (const [t, owner] of own) {
      const x = tx(t);
      const y = ty(t);
      const h = houseTone(g.players[owner].house);
      // Sides: neighbour offset and the strip geometry (outer edge a→b, inward normal).
      const sides: [number, number, number, number, number, number, number, number][] = [
        [0, -1, x, y, x + 1, y, 0, 1],
        [1, 0, x + 1, y, x + 1, y + 1, -1, 0],
        [0, 1, x + 1, y + 1, x, y + 1, 0, -1],
        [-1, 0, x, y + 1, x, y, 1, 0],
      ];
      const strip = (fill: string, ax: number, ay: number, bx: number, by: number, nx: number, ny: number, o0: number, o1: number): void => {
        poly3(fill, [ax + nx * o0, ay + ny * o0, 0, bx + nx * o0, by + ny * o0, 0, bx + nx * o1, by + ny * o1, 0, ax + nx * o1, ay + ny * o1, 0], null, lw);
      };
      // Outer deep-trim strips first (only on the boundary of a contiguous House holding), then the primary kerb.
      for (const [dx, dy, ax, ay, bx, by, nx, ny] of sides) {
        const nb = own.get(idx(clamp(x + dx, 0, 11), clamp(y + dy, 0, 11)));
        const shared = x + dx >= 0 && x + dx < MAP_W && y + dy >= 0 && y + dy < MAP_H && nb !== undefined && g.players[nb].house === g.players[owner].house;
        if (!shared) strip(h.dark, ax, ay, bx, by, nx, ny, 0, TD);
      }
      for (const [dx, dy, ax, ay, bx, by, nx, ny] of sides) {
        const nb = own.get(idx(clamp(x + dx, 0, 11), clamp(y + dy, 0, 11)));
        const shared = x + dx >= 0 && x + dx < MAP_W && y + dy >= 0 && y + dy < MAP_H && nb !== undefined && g.players[nb].house === g.players[owner].house;
        strip(h.color, ax, ay, bx, by, nx, ny, shared ? 0.0 : TD, shared ? TP * 0.8 : TD + TP);
      }
      // Hairline ink at the outer edge of the trim and the inner edge of the primary.
      rect3(null, x + TD + TP, y + TD + TP, x + 1 - TD - TP, y + 1 - TD - TP, 0, 0.7, lw, 'rgba(22,19,15,0.5)');
      for (const [dx, dy, ax, ay, bx, by] of sides) {
        const nb = own.get(idx(clamp(x + dx, 0, 11), clamp(y + dy, 0, 11)));
        const shared = x + dx >= 0 && x + dx < MAP_W && y + dy >= 0 && y + dy < MAP_H && nb !== undefined && g.players[nb].house === g.players[owner].house;
        if (!shared) line3(INK, lw, [ax, ay, 0, bx, by, 0]);
      }
    }
    void th;
  }

  // ───────────────────────────── Overlays under the objects ─────────────────────────────

  /** Wash plus a dotted hairline boundary for a set of tiles. */
  function drawRegion(tiles: Iterable<number>, wash: string, lw: number, dotted = true): void {
    const set = new Set<number>(tiles);
    if (!set.size) return;
    const c = c2;
    const fill = new Path2D();
    const edge = new Path2D();
    for (const t of set) {
      const x = tx(t);
      const y = ty(t);
      fill.moveTo(wxOf(x, y), wyOf(x, y));
      fill.lineTo(wxOf(x + 1, y), wyOf(x + 1, y));
      fill.lineTo(wxOf(x + 1, y + 1), wyOf(x + 1, y + 1));
      fill.lineTo(wxOf(x, y + 1), wyOf(x, y + 1));
      fill.closePath();
      const seg = (ax: number, ay: number, bx: number, by: number): void => {
        edge.moveTo(wxOf(ax, ay), wyOf(ax, ay));
        edge.lineTo(wxOf(bx, by), wyOf(bx, by));
      };
      if (!(y > 0 && set.has(idx(x, y - 1)))) seg(x, y, x + 1, y);
      if (!(x < MAP_W - 1 && set.has(idx(x + 1, y)))) seg(x + 1, y, x + 1, y + 1);
      if (!(y < MAP_H - 1 && set.has(idx(x, y + 1)))) seg(x + 1, y + 1, x, y + 1);
      if (!(x > 0 && set.has(idx(x - 1, y)))) seg(x, y + 1, x, y);
    }
    c.fillStyle = wash;
    c.fill(fill);
    c.strokeStyle = INK;
    c.lineWidth = lw * 1.2;
    c.lineCap = 'butt';
    if (dotted) c.setLineDash([1.6 * lw, 3.2 * lw]);
    c.stroke(edge);
    c.setLineDash([]);
  }

  /** Hatching over blocked / held tiles. */
  function drawHatch(tiles: Iterable<number>, lw: number): void {
    const c = c2;
    const p = new Path2D();
    for (const t of tiles) {
      const x = tx(t);
      const y = ty(t);
      for (let i = 1; i < 6; i++) {
        const v = i / 6;
        p.moveTo(wxOf(x + 0.04, y + v), wyOf(x + 0.04, y + v));
        p.lineTo(wxOf(x + 0.96, y + v), wyOf(x + 0.96, y + v));
      }
    }
    c.strokeStyle = 'rgba(22,19,15,0.55)';
    c.lineWidth = lw * 0.8;
    c.stroke(p);
  }

  // ───────────────────────────── Objects ─────────────────────────────

  function bannerAnchor(b: Building, p: Pen, roof: number): [number, number] {
    // The pole stands on the rear-east corner of the roofline: clear of the door and the queue.
    void b;
    return [p.X(0.86, 0.2), p.Y(0.86, 0.2, roof)];
  }

  function buildObjects(g: Game, th: Theme, lw: number, era: number, ev: EventKind[]): Obj[] {
    const objs: Obj[] = [];
    const add = (d: number, f: () => void): void => {
      objs.push({ d, f });
    };
    const c = c2;
    const none = houseTone(-1);

    // Scenery: homes, station, gardens.
    CITY.homes.forEach((t) => {
      const x = tx(t);
      const y = ty(t);
      add(x + y + 1, () => {
        pen.at(c, th, none, lw, x, y, CITY.doorDir[t] === 1);
        townhouse(pen, hash32(t, 5));
      });
    });
    const s0 = CITY.station[0];
    add(tx(s0) + ty(s0) + 2, () => {
      pen.at(c, th, none, lw, tx(s0), ty(s0), false);
      station(pen);
      if (era >= 4) {
        pen.swag(0.2, 0.9, 1.8, 0.9, 12, 3.5, 7);
      }
    });
    CITY.tiles.forEach((k, t) => {
      if (k !== 'garden') return;
      const x = tx(t);
      const y = ty(t);
      add(x + y + 1, () => {
        pen.at(c, th, none, lw, x, y, false);
        garden(pen);
      });
    });

    // Buildings with their banners.
    const bs = bannerScale();
    for (const b of g.buildings) {
      const owner = g.players[b.owner];
      const house = owner ? owner.house : -1;
      const h = houseTone(house);
      const x = tx(b.tile);
      const y = ty(b.tile);
      add(x + y + 1, () => {
        pen.at(c, th, h, lw, x, y, CITY.doorDir[b.tile] === 1);
        const roof = drawBuildingArt(pen, b.kind, b.level, h);
        if (era >= 4 && !isShop(b.kind)) pen.swag(0.14, 0.9, 0.86, 0.9, 10, 4, 6);
        const [bx, by] = bannerAnchor(b, pen, Math.min(roof, heightOf(b.kind, b.level) - 2));
        drawBanner(c, house, bx, by, bs, lw, isShop(b.kind) ? b.level : 0);
      });
    }

    // Era II: canal pennant lines.
    if (era >= 2) {
      const spans: [number, number, number][] = [
        [2.5, 5, 6],
        [4.5, 5, 7],
        [6.5, 6, 7],
        [8.5, 6, 8],
        [10.5, 7, 8],
      ];
      spans.forEach(([y, x0, x1], i) => {
        add(x1 + y + 0.6, () => {
          pen.at(c, th, none, lw, 0, 0, false);
          pen.post(x0, y, 0, 18, 1.1);
          pen.post(x1, y, 0, 18, 1.1);
          drawPennantLine(pen, x0, y, x1, y, 17, 6, i);
        });
      });
    }
    // Era III: brass boulevard lamps and ferries.
    if (era >= 3) {
      for (const t of CITY.loop) {
        if (CITY.tiles[t] !== 'avenue') continue;
        const x = tx(t);
        const y = ty(t);
        if ((x + y) % 2) continue;
        const spots: [number, number, number, number][] = [
          [0, 1, 0.5, 0.88],
          [1, 0, 0.88, 0.5],
          [0, -1, 0.5, 0.12],
          [-1, 0, 0.12, 0.5],
        ];
        const sp = spots.find(([dx, dy]) => {
          const k = kindAt(x + dx, y + dy);
          return k !== undefined && !isRoadKind(k) && !isWaterKind(k);
        });
        if (!sp) continue;
        add(x + y + 1 + sp[2] * 0.1 + sp[3] * 0.1, () => {
          pen.at(c, th, none, lw, x, y, false);
          drawLamp(pen, sp[2], sp[3], true);
        });
      }
      const ferries: [number, number, boolean][] = [
        [9.0, 12.85, false],
        [6.5, 5.5, true],
      ];
      for (const [fx, fy, along] of ferries) {
        const occupied = g.units.some((u) => u.kind === 'barge' && tx(u.tile) === Math.floor(fx) && ty(u.tile) === Math.floor(fy));
        if (occupied) continue;
        add(fx + fy + 0.5, () => drawFerry(c, th, wxOf(fx, fy), wyOf(fx, fy, WATER_Z + 1.4), 1, lw, along));
      }
    }
    // Events that print on the plate.
    if (ev.includes('cruise')) {
      add(3.9 + 12.5 + 1, () => {
        pen.at(c, th, none, lw, 3.9, 12.3, false);
        drawLiner(pen);
      });
    }
    if (ev.includes('lantern')) {
      for (let t = 0; t < MAP_W * MAP_H; t++) {
        if (CITY.tiles[t] !== 'lane') continue;
        const x = tx(t);
        const y = ty(t);
        add(x + y + 1.2, () => {
          const zz = 17;
          const sag = 2.2;
          c.beginPath();
          c.moveTo(wxOf(x, y + 0.5), wyOf(x, y + 0.5, zz));
          c.quadraticCurveTo(wxOf(x + 0.5, y + 0.5), wyOf(x + 0.5, y + 0.5, zz - sag * 2), wxOf(x + 1, y + 0.5), wyOf(x + 1, y + 0.5, zz));
          c.strokeStyle = INK;
          c.lineWidth = lw * 0.8;
          c.stroke();
          const lx = wxOf(x + 0.5, y + 0.5);
          const ly = wyOf(x + 0.5, y + 0.5, zz - sag - 2);
          c.beginPath();
          c.ellipse(lx, ly, 2.6, 3.6, 0, 0, Math.PI * 2);
          c.fillStyle = th.c(BRASS);
          c.fill();
          c.lineWidth = lw;
          c.stroke();
          c.beginPath();
          c.moveTo(lx, ly - 3.6);
          c.lineTo(lx, ly - 5.2);
          c.moveTo(lx - 1.6, ly + 3.4);
          c.lineTo(lx + 1.6, ly + 3.4);
          c.stroke();
        });
      }
    }
    if (ev.includes('freeride')) {
      for (const t of CITY.fixedStops) {
        const x = tx(t);
        const y = ty(t);
        add(x + y + 1.4, () => {
          pen.at(c, th, none, lw, x, y, false);
          pen.post(0.12, 0.5, 0, 16, 1.1);
          pen.post(0.88, 0.5, 0, 16, 1.1);
          drawPennantLine(pen, 0.12, 0.5, 0.88, 0.5, 15, 5, 1);
        });
      }
    }
    if (ev.includes('supplycrunch')) {
      add(3.5 + 12.6 + 1, () => {
        pen.at(c, th, none, lw, 3.28, 12.2, false);
        const crate = th.m('#B79A72', 0.2, 0.22);
        pen.box(0.0, 0.0, 0.2, 0.2, -0.6, 4.4, crate);
        pen.box(0.22, 0.0, 0.42, 0.2, -0.6, 4.4, crate);
        pen.box(0.1, 0.02, 0.3, 0.2, 4.4, 8.4, crate);
      });
    }
    return objs;
  }

  // ───────────────────────────── Citizens ─────────────────────────────

  /** Allocate up to `cap` figures across archetypes, nonzero archetypes first-class. */
  function allocate(counts: number[], cap: number): number[] {
    const total = counts.reduce((a, b) => a + b, 0);
    const out = counts.map(() => 0);
    if (total <= 0) return out;
    if (total <= cap) return counts.map((n) => Math.max(0, Math.round(n)));
    let left = cap;
    counts.forEach((n, i) => {
      if (n > 0) {
        out[i] = 1;
        left--;
      }
    });
    const rem = counts.map((n, i) => ({ i, r: (n / total) * cap - out[i] }));
    rem.sort((a, b) => b.r - a.r);
    for (let k = 0; left > 0 && k < 40; k++, left--) out[rem[k % rem.length].i]++;
    return out;
  }

  function drawCitizens(g: Game, th: Theme, lw: number): void {
    const cs = citizenScale();
    const c = c2;
    for (const b of g.buildings) {
      if (!isShop(b.kind)) continue;
      const door = CITY.door[b.tile];
      if (door < 0) continue;
      const east = CITY.doorDir[b.tile] === 1;
      const dx = tx(door);
      const dy = ty(door);
      const alloc = allocate(b.lastArch, 8);
      const list: number[] = [];
      alloc.forEach((n, a) => {
        for (let i = 0; i < n; i++) list.push(a);
      });
      // Slots: two rows of four standing along the shopfront (row 0 nearest the facade).
      const slots = list.length;
      const place = (i: number): [number, number] => {
        const row = i < 4 ? 0 : 1;
        const col = row === 0 ? i : i - 4;
        const along = 0.14 + col * 0.2 + (row ? 0.1 : 0);
        const depth = row === 0 ? 0.26 : 0.54;
        return east ? [dx + depth, dy + along] : [dx + along, dy + depth];
      };
      // Back to front: nearest the facade first.
      const order = list.map((_, i) => i).sort((p, q) => {
        const [px, py] = place(p);
        const [qx, qy] = place(q);
        return px + py - (qx + qy);
      });
      for (const i of order.slice(0, slots)) {
        const [px, py] = place(i);
        drawCitizen(c, th, list[i], wxOf(px, py), wyOf(px, py), cs, lw);
      }
      const lost = b.lastLost.tooPricey + b.lastLost.queueFull + b.lastLost.outOfStock + b.lastLost.blockaded;
      if (lost > 0) {
        const [px, py] = east ? [dx + 0.88, dy + 0.18] : [dx + 0.18, dy + 0.9];
        drawTally(c, Math.min(lost, 10), wxOf(px, py), wyOf(px, py), 0.8 * cs, lw);
      }
    }
  }

  // ───────────────────────────── Units ─────────────────────────────

  function drawUnits(g: Game, th: Theme, lw: number, state: BoardState): void {
    const c = c2;
    for (const sp of unitSpots(g)) {
      const owner = g.players[sp.u.owner];
      if (!owner) continue;
      if (state.selectedUnit === sp.u.id) {
        // Selection ring: Alabaster offset, then Ink.
        const s = sp.s;
        c.beginPath();
        c.ellipse(sp.wx, sp.wy + 1, 19 * s, 9.6 * s, 0, 0, Math.PI * 2);
        c.strokeStyle = ALABASTER;
        c.lineWidth = 4.4 * lw;
        c.stroke();
        c.strokeStyle = INK;
        c.lineWidth = 2 * lw;
        c.stroke();
      }
      drawToken(c, {
        kind: sp.u.kind,
        house: owner.house,
        x: sp.wx,
        y: sp.wy,
        s: sp.s,
        lw,
        cohesion: sp.u.cohesion,
        maxCohesion: maxCohesion(owner, sp.u.kind),
        alongY: sp.alongY,
        th,
      });
    }
  }

  // ───────────────────────────── Screen-space annotation ─────────────────────────────

  function setScreen(): void {
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function setWorld(): void {
    const s = zoom * dpr;
    c2.setTransform(s, 0, 0, s, (W / 2 - camX * zoom) * dpr, (H / 2 - camY * zoom) * dpr);
  }

  interface TagOpts {
    mono?: boolean;
    rule?: string;
    dashed?: boolean;
    size?: number;
    weight?: number;
  }

  /** An annotation tag: Alabaster backing, 1px Ink border, optional 3px rule. Returns its rect. */
  function tag(text: string, x: number, y: number, o: TagOpts = {}): { x: number; y: number; w: number; h: number } {
    const c = c2;
    const size = o.size ?? 11;
    c.font = `${o.weight ?? 500} ${size}px ${o.mono ? MONO : SANS}`;
    const tw = c.measureText(text).width;
    const w = Math.ceil(tw) + 12 + (o.rule ? 3 : 0);
    const h = size + 9;
    const bx = Math.round(x - w / 2);
    const by = Math.round(y - h / 2);
    c.fillStyle = ALABASTER;
    c.fillRect(bx, by, w, h);
    c.lineWidth = 1;
    c.strokeStyle = INK;
    c.setLineDash(o.dashed ? [3, 2] : []);
    c.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
    c.setLineDash([]);
    if (o.rule) {
      c.fillStyle = o.rule;
      c.fillRect(bx + 1, by + 1, 3, h - 2);
    }
    c.fillStyle = INK;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillText(text, bx + 6 + (o.rule ? 3 : 0), by + h / 2 + 0.5);
    return { x: bx, y: by, w, h };
  }

  function disc(n: number | string, x: number, y: number, r: number, fill: string, ink: string, ring?: string): void {
    const c = c2;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
    if (ring) {
      c.lineWidth = 2;
      c.strokeStyle = ring;
      c.stroke();
    }
    c.lineWidth = 1;
    c.strokeStyle = INK;
    c.stroke();
    c.fillStyle = ink;
    c.font = `600 ${r > 8 ? 11 : 10}px ${MONO}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(n), x, y + 0.5);
  }

  function diamondPath(cx: number, cy: number, grow: number): void {
    const a = HW * zoom;
    const b = HH * zoom;
    const r = (a * b) / Math.hypot(a, b);
    const k = (r + grow) / r;
    const c = c2;
    c.beginPath();
    c.moveTo(cx, cy - b * k);
    c.lineTo(cx + a * k, cy);
    c.lineTo(cx, cy + b * k);
    c.lineTo(cx - a * k, cy);
    c.closePath();
  }

  function pathPoints(tiles: number[], from: number): { x: number; y: number }[] {
    const pts = [from, ...tiles].map((t) => {
      const z = CITY.tiles[t] === 'bridge' ? bridgeZ(0.5) : CITY.tiles[t] === 'canal' ? WATER_Z + 1 : 0;
      return tileScr(tx(t) + 0.5, ty(t) + 0.5, z + 1);
    });
    return pts;
  }

  function strokePts(pts: { x: number; y: number }[]): void {
    const c = c2;
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  }

  function drawPlanning(g: Game, state: BoardState): void {
    const seat = state.player;
    const owner = g.players[seat];
    if (!owner) return;
    const h = houseTone(owner.house);
    const c = c2;
    const pos = new Map<number, number>();
    const unitTile = (id: number): number => pos.get(id) ?? unitById(g, id)?.tile ?? -1;
    const pending: { x: number; y: number; n: number }[] = [];
    state.draft.forEach((o, i) => {
      const n = i + 1;
      if (o.t === 'move') {
        const u = unitById(g, o.unit);
        if (!u) return;
        const from = unitTile(u.id);
        const path = pathFor(u.kind, from, o.to) ?? [o.to];
        const pts = pathPoints(path, from);
        strokePts(pts);
        c.strokeStyle = ALABASTER;
        c.lineWidth = 4;
        c.lineJoin = 'round';
        c.setLineDash([]);
        c.stroke();
        strokePts(pts);
        c.strokeStyle = INK;
        c.lineWidth = 1.6;
        c.setLineDash([6, 4]);
        c.stroke();
        c.setLineDash([]);
        pos.set(u.id, o.to);
        const e = pts[pts.length - 1];
        pending.push({ x: e.x, y: e.y - 14 * zoom * tokenScale(), n });
      } else if (o.t === 'contest') {
        const a = unitById(g, o.unit);
        const d = unitById(g, o.target);
        if (!a || !d) return;
        const p0 = tileScr(tx(unitTile(a.id)) + 0.5, ty(unitTile(a.id)) + 0.5, 12);
        const p1 = tileScr(tx(d.tile) + 0.5, ty(d.tile) + 0.5, 12);
        const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
        const ux = (p1.x - p0.x) / dist;
        const uy = (p1.y - p0.y) / dist;
        const m = 16;
        const a0 = { x: p0.x + ux * m, y: p0.y + uy * m };
        const a1 = { x: p1.x - ux * m, y: p1.y - uy * m };
        c.beginPath();
        c.moveTo(a0.x, a0.y);
        c.lineTo(a1.x, a1.y);
        c.strokeStyle = ALABASTER;
        c.lineWidth = 5;
        c.stroke();
        c.strokeStyle = INK;
        c.lineWidth = 2;
        c.stroke();
        const head = (p: { x: number; y: number }, dir: number): void => {
          const bx = p.x - ux * 8 * dir;
          const by = p.y - uy * 8 * dir;
          c.beginPath();
          c.moveTo(p.x, p.y);
          c.lineTo(bx - uy * 4.4, by + ux * 4.4);
          c.lineTo(bx + uy * 4.4, by - ux * 4.4);
          c.closePath();
          c.fillStyle = INK;
          c.fill();
        };
        head(a1, 1);
        head(a0, -1);
        const pv = contestPreview(g, a, d);
        tag(`${pv.deal} / ${pv.back}`, (a0.x + a1.x) / 2, (a0.y + a1.y) / 2 - 15, { mono: true, rule: h.color, size: 10.5 });
        pending.push({ x: (a0.x + a1.x) / 2 + 28, y: (a0.y + a1.y) / 2 - 15, n });
      } else if (o.t === 'build') {
        drawGhostBuilding(o.tile, o.kind, describeOrder(g, seat, o).cost, h.color, n);
      } else {
        const lbl = describeOrder(g, seat, o);
        if (lbl.tile >= 0 && o.t !== 'recruit') {
          const p = tileScr(tx(lbl.tile) + 0.5, ty(lbl.tile) + 0.5, 6);
          pending.push({ x: p.x - 14, y: p.y - 6, n });
        }
      }
    });
    for (const p of pending) disc(p.n, p.x, p.y, 9, INK, ALABASTER, h.color);
    // Ghost tokens where an own unit is planned to stand.
    for (const [id, tile] of pos) {
      const u = unitById(g, id);
      if (!u || tile === u.tile) continue;
      setWorld();
      const z = u.kind === 'barge' ? WATER_Z + 1.5 : 0;
      drawToken(c, {
        kind: u.kind,
        house: owner.house,
        x: wxOf(tx(tile) + 0.5, ty(tile) + 0.5),
        y: wyOf(tx(tile) + 0.5, ty(tile) + 0.5, z),
        s: tokenScale(),
        lw: 1 / zoom,
        cohesion: u.cohesion,
        maxCohesion: maxCohesion(owner, u.kind),
        ghost: true,
        alongY: true,
        th: themeFor(daypartOf(g.turn)),
      });
      setScreen();
    }
  }

  function drawGhostBuilding(tile: number, kind: Parameters<typeof heightOf>[0], cost: number, accent: string, n: number): void {
    const c = c2;
    const x = tx(tile);
    const y = ty(tile);
    const hh = heightOf(kind, 1) + 4;
    const P = (u: number, v: number, z: number): { x: number; y: number } => tileScr(x + u, y + v, z);
    const a = P(0.12, 0.12, 0);
    const b = P(0.88, 0.12, 0);
    const d = P(0.88, 0.88, 0);
    const e = P(0.12, 0.88, 0);
    const a2 = P(0.12, 0.12, hh);
    const b2 = P(0.88, 0.12, hh);
    const d2 = P(0.88, 0.88, hh);
    const e2 = P(0.12, 0.88, hh);
    const draw = (): void => {
      c.beginPath();
      c.moveTo(e.x, e.y);
      c.lineTo(d.x, d.y);
      c.lineTo(b.x, b.y);
      c.lineTo(b2.x, b2.y);
      c.lineTo(a2.x, a2.y);
      c.lineTo(e2.x, e2.y);
      c.closePath();
      c.moveTo(e2.x, e2.y);
      c.lineTo(d2.x, d2.y);
      c.lineTo(b2.x, b2.y);
      c.moveTo(d2.x, d2.y);
      c.lineTo(d.x, d.y);
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.moveTo(a.x, a.y);
      c.lineTo(e.x, e.y);
    };
    c.fillStyle = 'rgba(247,244,238,0.42)';
    draw();
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = 1.4;
    c.setLineDash([5, 3.4]);
    c.lineJoin = 'round';
    draw();
    c.stroke();
    c.setLineDash([]);
    const top = P(0.5, 0.5, hh + 6);
    const lbl = tag(`${buildName(kind)} §${cost}`, top.x, top.y - 12, { mono: false, rule: accent, size: 11 });
    if (n > 0) disc(n, lbl.x - 2, lbl.y + lbl.h / 2, 9, INK, ALABASTER, accent);
  }

  function drawBonuses(g: Game, th: Theme, state: BoardState): void {
    const c = c2;
    const occ = new Set(g.buildings.map((b) => b.tile));
    const stops = [...CITY.fixedStops, ...g.buildings.filter((b) => b.kind === 'tramstop').map((b) => b.tile)];
    const auras = g.buildings.filter((b) => auraRadius(b.kind) > 0);
    const hasLegal = state.legalTiles.size > 0;
    for (const t of CITY.lots) {
      if (occ.has(t)) continue;
      if (hasLegal && !state.legalTiles.has(t)) continue;
      const dots: string[] = [];
      if (CITY.corner[t]) dots.push('corner');
      if (CITY.canalFront[t]) dots.push('canal');
      if (stops.some((s) => chebyshev(s, t) <= TRANSIT_RADIUS)) dots.push('transit');
      if (auras.some((a) => chebyshev(a.tile, t) <= auraRadius(a.kind))) dots.push('aura');
      // Foot-traffic pips: avenue frontage, Station and Pier proximity.
      let pips = 1;
      if (CITY.avenueAdj[t] >= 0) pips++;
      if (chebyshev(CITY.stationDoor, t) <= 3 || chebyshev(CITY.pierTile, t) <= 3) pips++;
      const p = tileScr(tx(t) + 0.5, ty(t) + 0.5, 0);
      const r = clamp(3.2 * zoom, 2.6, 4.2);
      const gap = r * 2.5;
      dots.forEach((k, i) => {
        const dx = p.x + (i - (dots.length - 1) / 2) * gap;
        const dy = p.y + 5 * zoom;
        c.beginPath();
        c.arc(dx, dy, r, 0, Math.PI * 2);
        c.fillStyle = k === 'corner' ? INK : k === 'canal' ? th.c(CANAL) : k === 'transit' ? th.c(BRASS) : th.c(SAGE);
        c.fill();
        c.lineWidth = 1;
        c.strokeStyle = k === 'corner' ? ALABASTER : INK;
        c.stroke();
      });
      for (let i = 0; i < pips; i++) {
        const bx = p.x - ((pips - 1) / 2 - i) * (r * 1.6) - r * 0.4;
        const hgt = (3 + i * 2.2) * clamp(zoom, 0.8, 1.6);
        c.fillStyle = GRAPHITE;
        c.fillRect(bx, p.y - 7 * zoom - hgt, r * 0.9, hgt);
      }
    }
  }

  function drawMarkers(lines: SummaryLine[]): void {
    const c = c2;
    const per = new Map<number, number>();
    for (const l of lines) {
      if (l.tile < 0 || l.n <= 0) continue;
      const k = per.get(l.tile) ?? 0;
      per.set(l.tile, k + 1);
      const base = tileScr(tx(l.tile) + 0.5, ty(l.tile) + 0.5, 0);
      const x = base.x - 22 * zoom + k * 17;
      const y = base.y - 8 * zoom;
      c.beginPath();
      c.moveTo(x, y + 9);
      c.lineTo(base.x - 6 * zoom + k * 4, base.y);
      c.strokeStyle = INK;
      c.lineWidth = 1;
      c.stroke();
      disc(l.n, x, y, 8.5, ALABASTER, INK);
    }
  }

  function drawSelection(state: BoardState): void {
    const c = c2;
    const centre = (t: number): { x: number; y: number } => tileScr(tx(t) + 0.5, ty(t) + 0.5, 0);
    if (state.hoverTile >= 0 && state.hoverTile < MAP_W * MAP_H) {
      const p = centre(state.hoverTile);
      diamondPath(p.x, p.y, 0);
      c.strokeStyle = 'rgba(22,19,15,0.7)';
      c.lineWidth = 1;
      c.stroke();
    }
    if (state.selectedTile >= 0 && state.selectedTile < MAP_W * MAP_H) {
      const p = centre(state.selectedTile);
      diamondPath(p.x, p.y, 0);
      c.strokeStyle = ALABASTER;
      c.lineWidth = 5;
      c.lineJoin = 'round';
      c.stroke();
      c.strokeStyle = INK;
      c.lineWidth = 2;
      c.stroke();
    }
    if (state.cursorTile >= 0 && state.cursorTile < MAP_W * MAP_H) {
      // Keyboard cursor: 2px Ink outline with a 2px Alabaster offset.
      const p = centre(state.cursorTile);
      diamondPath(p.x, p.y, 1);
      c.strokeStyle = ALABASTER;
      c.lineWidth = 2;
      c.stroke();
      diamondPath(p.x, p.y, 3);
      c.strokeStyle = INK;
      c.lineWidth = 2;
      c.stroke();
    }
  }

  function drawRain(): void {
    const c = c2;
    // Hatching clipped to the plate: short slanted strokes on a jittered grid.
    c.save();
    c.beginPath();
    const corners: [number, number][] = [
      [LX0, LY0],
      [LX1, LY0],
      [LX1, LY1],
      [LX0, LY1],
    ];
    corners.forEach(([x, y], i) => (i ? c.lineTo(sx(wxOf(x, y)), sy(wyOf(x, y))) : c.moveTo(sx(wxOf(x, y)), sy(wyOf(x, y)))));
    c.closePath();
    c.clip();
    const step = 24;
    const p = new Path2D();
    for (let gy = -step; gy < H + step; gy += step) {
      for (let gx = -step; gx < W + step; gx += step) {
        const h = hash32(Math.round(gx / step) + 100, Math.round(gy / step) + 100);
        const x = gx + (h % step);
        const y = gy + ((h >>> 8) % step);
        const len = 11 + ((h >>> 16) % 6);
        p.moveTo(x, y);
        p.lineTo(x - len * 0.32, y + len);
      }
    }
    c.strokeStyle = 'rgba(22,19,15,0.42)';
    c.lineWidth = 1;
    c.lineCap = 'round';
    c.stroke(p);
    c.restore();
  }

  function drawMarginalia(th: Theme): void {
    const c = c2;
    void th;
    c.font = `500 ${clamp(9 * zoom + 3, 9, 12)}px ${MONO}`;
    c.fillStyle = GRAPHITE;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let i = 0; i < MAP_W; i++) {
      const p = tileScr(i + 0.5, -0.78);
      c.fillText(tileName(i)[0], p.x, p.y);
      const q = tileScr(-0.78, i + 0.5);
      c.fillText(String(i + 1), q.x, q.y);
    }
  }

  function drawCallouts(g: Game): void {
    const c = c2;
    const evs = g.events.filter((e) => e.end >= g.turn).sort((a, b) => a.start - b.start);
    let k = 0;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const e of evs) {
      const def = EVENTS[e.kind];
      if (!def) continue;
      const active = e.start <= g.turn;
      const left = active ? e.end - g.turn + 1 : e.start - g.turn;
      const text = active ? `${def.title} · ${left} ${left === 1 ? 'turn' : 'turns'} left` : `${def.title} · in ${left} ${left === 1 ? 'turn' : 'turns'}`;
      const [ax, ay] = EVENT_ANCHOR[e.kind] ?? [6, 6];
      const a = tileScr(ax, ay, 4);
      c.font = `500 11px ${SANS}`;
      const w = Math.ceil(c.measureText(text).width) + 12;
      let bx = clamp(a.x - w / 2, insets.left + 8, W - insets.right - w - 8);
      let by = clamp(a.y - 52 * Math.max(0.8, zoom * 0.7) - k * 24, insets.top + 8, H - insets.bottom - 30);
      for (const r of placed) {
        if (bx < r.x + r.w + 4 && bx + w > r.x - 4 && by < r.y + r.h + 4 && by + 20 > r.y - 4) by = r.y + r.h + 6;
      }
      by = clamp(by, insets.top + 8, H - insets.bottom - 30);
      bx = Math.round(bx);
      // Leader line.
      c.beginPath();
      c.moveTo(Math.round(bx + w / 2), by + 20);
      c.lineTo(a.x, a.y);
      c.strokeStyle = INK;
      c.lineWidth = 1;
      c.setLineDash(active ? [] : [3, 3]);
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.arc(a.x, a.y, 2.4, 0, Math.PI * 2);
      c.fillStyle = INK;
      c.fill();
      const r = tag(text, bx + w / 2, by + 10, { dashed: !active, rule: active ? undefined : undefined, size: 11 });
      placed.push(r);
      k++;
    }
  }

  // ───────────────────────────── Frame ─────────────────────────────

  function draw(): void {
    const c = c2;
    c.setTransform(1, 0, 0, 1, 0, 0);
    const g = st?.game;
    const th = themeFor(g ? daypartOf(g.turn) : 1);
    c.fillStyle = th.page;
    c.fillRect(0, 0, canvas.width, canvas.height);
    if (!st || !g) return;
    const state = st;
    const lw = 1 / zoom;
    const era = eraOfTurn(g, g.turn);
    const active: EventKind[] = g.events.filter((e) => e.start <= g.turn && g.turn <= e.end).map((e) => e.kind);

    setWorld();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    drawPlate(g, th, lw);
    drawOwnership(g, th, lw);

    // Planning regions sit on the ground, beneath the buildings.
    const armed: Armed = state.armed;
    const sel = state.selectedUnit ? unitById(g, state.selectedUnit) : undefined;
    const owner = g.players[state.player];
    const legalDrawn = armed !== null && state.legalTiles.size > 0;
    if (sel && owner && sel.owner === state.player && !(legalDrawn && armed?.kind === 'move' && armed.unit === sel.id)) {
      const reach = reachFrom(sel.kind, sel.tile, moveOf(g.players[sel.owner], sel.kind));
      const ok: number[] = [];
      const blocked: number[] = [];
      for (const [t] of reach) {
        if (t === sel.tile) continue;
        const held = g.units.some((u) => u.tile === t && u.id !== sel.id);
        if (held || !standable(sel.kind, t)) blocked.push(t);
        else ok.push(t);
      }
      drawRegion(ok, 'rgba(247,244,238,0.5)', lw);
      drawHatch(blocked, lw);
    }
    if (legalDrawn) {
      drawRegion(state.legalTiles, 'rgba(143,165,142,0.45)', lw);
      if (armed?.kind === 'move') {
        const u = unitById(g, armed.unit);
        if (u) {
          const held = [...state.legalTiles].filter((t) => g.units.some((o) => o.tile === t && o.id !== u.id));
          drawHatch(held, lw);
        }
      }
    }

    // Pier (on the harbor water), then the lips of the slab that frame the basin.
    drawPier(c, th, lw);
    const objs = buildObjects(g, th, lw, era, active);
    objs.sort((a, b) => a.d - b.d);
    // The liner / pier-side objects precede land objects of the same depth; lips close the basin last.
    let lipsDone = false;
    const lips = (): void => {
      if (lipsDone) return;
      lipsDone = true;
      rect3(th.slabTop, LX0, HARBOR_Y1, LX1, LY1, 0, 1, lw);
      rect3(th.slabTop, LX0, QUAY_Y, HX0, HARBOR_Y1, 0, 1, lw);
      rect3(th.slabTop, HX1, QUAY_Y, LX1, HARBOR_Y1, 0, 1, lw);
    };
    for (const o of objs) {
      if (!lipsDone && o.d > 14) lips();
      o.f();
    }
    lips();

    drawCitizens(g, th, lw);
    drawUnits(g, th, lw, state);

    // Annotation in screen space.
    setScreen();
    drawMarginalia(th);
    if (active.includes('cloudburst')) drawRain();
    if (state.showBonuses) drawBonuses(g, th, state);
    drawPlanning(g, state);
    // Armed build: preview the building on the selected (or hovered) legal tile.
    if (armed && armed.kind === 'build' && owner) {
      const t = state.legalTiles.has(state.selectedTile) ? state.selectedTile : state.legalTiles.has(state.hoverTile) ? state.hoverTile : -1;
      if (t >= 0 && !state.draft.some((o) => o.t === 'build' && o.tile === t)) {
        drawGhostBuilding(t, armed.build, describeOrder(g, state.player, { t: 'build', tile: t, kind: armed.build }).cost, houseTone(owner.house).color, 0);
      }
    }
    if (armed && armed.kind === 'move' && owner) {
      const u = unitById(g, armed.unit);
      const t = state.legalTiles.has(state.selectedTile) ? state.selectedTile : state.legalTiles.has(state.hoverTile) ? state.hoverTile : -1;
      if (u && t >= 0) {
        const path = pathFor(u.kind, u.tile, t);
        if (path) {
          strokePts(pathPoints(path, u.tile));
          c.strokeStyle = INK;
          c.lineWidth = 1.4;
          c.setLineDash([2, 4]);
          c.stroke();
          c.setLineDash([]);
        }
      }
    }
    if (state.showMarkers && state.summary) drawMarkers(state.summary.lines);
    drawCallouts(g);
    drawSelection(state);
  }

  // ───────────────────────────── Picking ─────────────────────────────

  function toTileCoords(px: number, py: number): { fx: number; fy: number } {
    const wx = (px - W / 2) / zoom + camX;
    const wy = (py - H / 2) / zoom + camY;
    return { fx: (wy / HH + wx / HW) / 2, fy: (wy / HH - wx / HW) / 2 };
  }

  function inPoly(pts: [number, number][], x: number, y: number): boolean {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** Resolve a screen point to a Hit: unit tokens, then building silhouettes, then the ground tile, then the nearest snap target within `radius` px. */
  function pickAt(px: number, py: number, radius: number): Hit | null {
    if (!st) return null;
    const g = st.game;
    const mk = (tile: number, unit = 0): Hit => ({ tile, unit: unit || (g.units.find((u) => u.tile === tile)?.id ?? 0), building: buildingAt(g, tile)?.id ?? 0 });
    // Unit tokens (topmost last drawn).
    const spots = unitSpots(g);
    for (let i = spots.length - 1; i >= 0; i--) {
      const sp = spots[i];
      const cx = sx(sp.wx);
      const cy = sy(sp.wy);
      const hw = 15 * sp.s * zoom;
      if (px >= cx - hw && px <= cx + hw && py >= cy - (TOKEN_H + 2) * sp.s * zoom && py <= cy + 8 * sp.s * zoom) return mk(sp.u.tile, sp.u.id);
    }
    // Building silhouettes, nearest the viewer first.
    const blds = [...g.buildings].sort((a, b) => tx(b.tile) + ty(b.tile) - (tx(a.tile) + ty(a.tile)));
    for (const b of blds) {
      const x = tx(b.tile);
      const y = ty(b.tile);
      const hgt = heightOf(b.kind, b.level) + 4;
      const P = (u: number, v: number, z: number): [number, number] => [sx(wxOf(x + u, y + v)), sy(wyOf(x + u, y + v, z))];
      const hull: [number, number][] = [P(0, 1, 0), P(1, 1, 0), P(1, 0, 0), P(1, 0, hgt), P(0, 0, hgt), P(0, 1, hgt)];
      if (inPoly(hull, px, py)) return mk(b.tile);
    }
    const { fx, fy } = toTileCoords(px, py);
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) {
      const t = idx(x, y);
      const k = CITY.tiles[t];
      if (snappable(t) || k === 'canal') return mk(t);
    }
    if (radius <= 0) return null;
    let best = -1;
    let bd = radius * radius;
    for (let t = 0; t < MAP_W * MAP_H; t++) {
      if (!snappable(t)) continue;
      const p = tileScr(tx(t) + 0.5, ty(t) + 0.5);
      const d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best >= 0 ? mk(best) : null;
  }

  // ───────────────────────────── Input ─────────────────────────────

  interface Ptr {
    x: number;
    y: number;
    sx: number;
    sy: number;
    type: string;
  }
  const ptrs = new Map<number, Ptr>();
  let dragging = false;
  let multi = false;
  let pinchDist = 0;
  let pinchX = 0;
  let pinchY = 0;

  const rel = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const isTouch = (e: PointerEvent): boolean => e.pointerType === 'touch' || e.pointerType === 'pen';

  function emitHover(tile: number): void {
    if (tile === lastHover) return;
    lastHover = tile;
    hoverCb?.(tile);
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button === 2) return;
    const p = rel(e);
    ptrs.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, type: e.pointerType });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    if (ptrs.size === 2) {
      multi = true;
      const [a, b] = [...ptrs.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      pinchX = (a.x + b.x) / 2;
      pinchY = (a.y + b.y) / 2;
    }
    if (ptrs.size === 1) {
      dragging = false;
      multi = false;
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const p = rel(e);
    const cur = ptrs.get(e.pointerId);
    if (!cur) {
      if (!isTouch(e)) {
        const hit = pickAt(p.x, p.y, 0);
        emitHover(hit ? hit.tile : -1);
        canvas.style.cursor = hit ? 'pointer' : 'grab';
      }
      return;
    }
    if (ptrs.size >= 2) {
      cur.x = p.x;
      cur.y = p.y;
      const [a, b] = [...ptrs.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      panBy(mx - pinchX, my - pinchY);
      zoomAt(dist / pinchDist, mx, my);
      pinchDist = dist;
      pinchX = mx;
      pinchY = my;
      dragging = true;
      return;
    }
    const thr = isTouch(e) ? 9 : 5;
    if (!dragging && Math.hypot(p.x - cur.sx, p.y - cur.sy) > thr) {
      dragging = true;
      canvas.style.cursor = 'grabbing';
      emitHover(-1);
    }
    if (dragging) panBy(p.x - cur.x, p.y - cur.y);
    cur.x = p.x;
    cur.y = p.y;
  }

  function onPointerUp(e: PointerEvent): void {
    const cur = ptrs.get(e.pointerId);
    if (!cur) return;
    ptrs.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const wasTap = !dragging && !multi && e.type === 'pointerup';
    if (ptrs.size === 0) {
      dragging = false;
      multi = false;
      canvas.style.cursor = 'grab';
    }
    if (wasTap && pickCb) {
      const touch = isTouch(e);
      const hit = pickAt(cur.x, cur.y, touch ? 56 : 34);
      if (hit) pickCb(hit, { shift: e.shiftKey, touch, right: false });
    }
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (!pickCb) return;
    const p = rel(e);
    const hit = pickAt(p.x, p.y, 34);
    if (hit) pickCb(hit, { shift: e.shiftKey, touch: false, right: true });
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = rel(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const k = e.ctrlKey ? 0.01 : 0.0016;
    zoomAt(Math.exp(-e.deltaY * unit * k), p.x, p.y);
  }

  function onLeave(e: PointerEvent): void {
    if (!isTouch(e) && !ptrs.size) emitHover(-1);
  }

  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const onWinResize = (): void => resize();
  window.addEventListener('resize', onWinResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);
  const onFonts = (): void => schedule();
  if (typeof document !== 'undefined' && document.fonts) document.fonts.addEventListener('loadingdone', onFonts);

  resize();
  fit();

  return {
    setState(s: BoardState): void {
      st = s;
      schedule();
    },
    onPick(cb): void {
      pickCb = cb;
    },
    onHover(cb): void {
      hoverCb = cb;
    },
    fit,
    centerOn,
    zoomBy(factor: number): void {
      zoomAt(factor, insets.left + freeW() / 2, insets.top + freeH() / 2);
    },
    panBy,
    setInsets(i): void {
      const same = i.top === insets.top && i.right === insets.right && i.bottom === insets.bottom && i.left === insets.left;
      insets = { ...i };
      if (same) return;
      if (!userMoved) fit();
      else {
        clampCam();
        schedule();
      }
    },
    resize,
    tileScreenPos,
    destroy(): void {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onWinResize);
      ro?.disconnect();
      if (typeof document !== 'undefined' && document.fonts) document.fonts.removeEventListener('loadingdone', onFonts);
      ptrs.clear();
    },
  };
}

void ARCHETYPES;
void TERRACOTTA;
void TRAVERTINE_DEEP;
