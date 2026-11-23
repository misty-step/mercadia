// Pure Chronicle policy: which dispatch has a lot to show, what the recent feed lists, what a
// tap on the Chronicle does, and where click-to-focus lands the camera. No DOM in here, so the
// rules (a phone can always focus the active dispatch's lot) are unit-tested directly.
import { H, W } from '../shared/map';
import type { Dispatch } from '../shared/types';

/** At or below this viewport width the Chronicle is the compact bar under the score strip. */
export const PHONE_WIDTH = 720;
export const isPhoneWidth = (width: number): boolean => width <= PHONE_WIDTH;

/** The lot a dispatch points at, or -1 when it has none worth panning to. */
export function dispatchLot(d: { tile?: number } | null | undefined): number {
  const lot = d?.tile;
  return lot !== undefined && Number.isInteger(lot) && lot >= 0 && lot < W * H ? lot : -1;
}

export interface FeedRow {
  d: Dispatch;
  /** The dispatch currently in the banner (listed on phones so it can be focused from the feed). */
  active: boolean;
  /** Lot to focus, or -1. */
  lot: number;
}

/** Rows the recent feed shows at each width, the active dispatch included. */
export const FEED_ROWS = { desktop: 3, phone: 4 } as const;

/**
 * The recent feed, newest first. On a desktop the banner's own dispatch is left out (it is
 * right there, and clickable). On a phone a tap on the banner opens the feed, so the active
 * dispatch leads the feed with its click-to-focus action.
 * `bannerN` is the serial of the dispatch in the banner, or -1 when the banner shows a city
 * event or nothing.
 */
export function feedRows(list: readonly Dispatch[], bannerN: number, phone: boolean): FeedRow[] {
  const row = (d: Dispatch, active: boolean): FeedRow => ({ d, active, lot: dispatchLot(d) });
  const others = list.filter((d) => d.n !== bannerN);
  const active = bannerN >= 0 ? list.find((d) => d.n === bannerN) : undefined;
  if (!phone) return others.slice(-FEED_ROWS.desktop).reverse().map((d) => row(d, false));
  if (!active) return others.slice(-FEED_ROWS.phone).reverse().map((d) => row(d, false));
  return [row(active, true), ...others.slice(-(FEED_ROWS.phone - 1)).reverse().map((d) => row(d, false))];
}

/** What was tapped on the Chronicle. */
export interface ChronicleTap {
  /**
   * `focus-lot`: the banner's dedicated focus button. `focus`: a feed row, or the banner's
   * headline. `feed`: the chevron.
   */
  act: 'focus-lot' | 'focus' | 'feed';
  /** The lot the tapped control carries, or -1. */
  tile: number;
  /** The tap landed on the banner (not on a feed row). */
  banner: boolean;
  phone: boolean;
  feedOpen: boolean;
}

export interface TapResult {
  /** Lot to pan the camera to, or -1. */
  focus: number;
  feedOpen: boolean;
  /** The player opened or closed the feed themselves (remembered on a desktop). */
  chose: boolean;
}

/**
 * - The banner's focus button always pans to its lot and never opens the feed; on a phone it
 *   also folds an open feed away so the lot is in view.
 * - A feed row with a lot pans to it; on a phone the feed then folds away.
 * - The banner's headline pans on a desktop; on a phone (and whenever it has no lot) it opens
 *   or closes the feed, as the chevron does.
 */
export function resolveTap(t: ChronicleTap): TapResult {
  const lot = dispatchLot({ tile: t.tile });
  if (t.act === 'focus-lot') {
    if (lot < 0) return { focus: -1, feedOpen: t.feedOpen, chose: false };
    return { focus: lot, feedOpen: t.phone ? false : t.feedOpen, chose: false };
  }
  if (t.act === 'focus' && lot >= 0 && !(t.banner && t.phone)) {
    return { focus: lot, feedOpen: t.phone ? false : t.feedOpen, chose: false };
  }
  if (t.act === 'feed' || (t.act === 'focus' && t.banner)) return { focus: -1, feedOpen: !t.feedOpen, chose: true };
  return { focus: -1, feedOpen: t.feedOpen, chose: false };
}

// ───────────────────────────── Click-to-focus camera ─────────────────────────────

/** Half tile in world px at zoom 1 (the 2:1 isometric diamond is 64 × 32). */
const HALF_W = 32;
const HALF_H = 16;

/** How far the camera may travel (world px at zoom 1). */
export const CAMERA_LIMIT = { x0: -490, x1: 450, y0: -110, y1: 490 } as const;

export const clampCamera = (x: number, y: number): { x: number; y: number } => ({
  x: Math.min(CAMERA_LIMIT.x1, Math.max(CAMERA_LIMIT.x0, x)),
  y: Math.min(CAMERA_LIMIT.y1, Math.max(CAMERA_LIMIT.y0, y)),
});

/** World position of a lot's centre. */
export const lotWorld = (tile: number): { x: number; y: number } => {
  const x = (tile % W) + 0.5;
  const y = Math.floor(tile / W) + 0.5;
  return { x: (x - y) * HALF_W, y: (x + y) * HALF_H };
};

/**
 * The viewport edges the HUD occupies during play, so Fit and click-to-focus aim at the city
 * that is actually visible. Phones: clock, score strip and Chronicle bar above; guide bar,
 * treasury, tabs and dock below. Mid-size screens wrap the Chronicle under the clock, so the
 * city sits a little lower.
 */
export function playInsets(width: number): { top: number; right: number; bottom: number; left: number } {
  if (isPhoneWidth(width)) return { top: 142, right: 0, bottom: width <= 640 ? 176 : 146, left: 0 };
  return { top: width < 1280 ? 104 : 64, right: width > 1180 ? 120 : 60, bottom: 84, left: 0 };
}

export interface CameraFrame {
  width: number;
  height: number;
  /** Viewport edges the HUD occupies. */
  insets: { top: number; right: number; bottom: number; left: number };
  cam: { x: number; y: number; zoom: number };
}

/** Centre of the city area the HUD leaves free, in screen px. */
export const freeCentre = (f: Pick<CameraFrame, 'width' | 'height' | 'insets'>): { x: number; y: number } => ({
  x: f.insets.left + (f.width - f.insets.left - f.insets.right) / 2,
  y: f.insets.top + (f.height - f.insets.top - f.insets.bottom) / 2,
});

/** Where a lot's centre is drawn on screen for a camera. */
export const lotOnScreen = (tile: number, f: Pick<CameraFrame, 'width' | 'height' | 'cam'>): { x: number; y: number } => {
  const w = lotWorld(tile);
  return { x: (w.x - f.cam.x) * f.cam.zoom + f.width / 2, y: (w.y - f.cam.y) * f.cam.zoom + f.height / 2 };
};

/**
 * The camera position that puts a lot at the centre of the free city area (within the camera's
 * travel), or null for a tile that is not on the map.
 */
export function focusCamera(tile: number, f: CameraFrame): { x: number; y: number } | null {
  if (dispatchLot({ tile }) < 0) return null;
  const p = lotOnScreen(tile, f);
  const c = freeCentre(f);
  return clampCamera(f.cam.x - (c.x - p.x) / f.cam.zoom, f.cam.y - (c.y - p.y) / f.cam.zoom);
}
