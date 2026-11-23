// House heraldry. One set of geometry draws every crest twice: as inline SVG for the HUD
// (leaderboard, Chronicle, Council, Inspector, Final Edition) and as crisp vectors on the
// Canvas 2D diorama (banner medallions). Each House pairs its colour with a distinct geometric
// emblem, so ownership reads without relying on hue alone.
import { HOUSES, type CrestKind } from '../shared/constants';

/** All crest geometry lives in a 24×24 box. */
export const CREST_BOX = 24;
/** The shield every House carries, and its shaded right half (the diorama's two-tone solids). */
export const SHIELD = 'M4 2.5h16v9.6c0 5-3.4 8.1-8 9.9-4.6-1.8-8-4.9-8-9.9z';
export const SHIELD_SHADE = 'M12 2.5h8v9.6c0 5-3.4 8.1-8 9.9z';

export interface CrestShape {
  d: string;
  /** Filled emblem shape, or a stroked line of the given width. */
  stroke?: number;
}

/** The emblem inside each shield, drawn in linen white. */
export const CREST_SHAPES: Record<CrestKind, CrestShape[]> = {
  // Vermilion Guild — Compass Shield: a four-point compass rose with a pivot.
  compass: [
    { d: 'M12 4.6l1.7 5.7 5.7 1.7-5.7 1.7L12 19.4l-1.7-5.7L4.6 12l5.7-1.7z' },
    { d: 'M8.1 8.1l2.6 1.5-1.1 1.1zM15.9 8.1l-1.5 2.6-1.1-1.1zM15.9 15.9l-2.6-1.5 1.1-1.1zM8.1 15.9l1.5-2.6 1.1 1.1z' },
  ],
  // Cobalt Syndicate — Harbor Anchor Shield: ring, stock, shank and flukes.
  anchor: [
    { d: 'M12 4.4a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8zm0 1.2a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4z' },
    { d: 'M12 8.2v9.6', stroke: 1.7 },
    { d: 'M8.7 10.6h6.6', stroke: 1.7 },
    { d: 'M6.4 13.2c.5 3.1 2.7 4.8 5.6 4.8s5.1-1.7 5.6-4.8', stroke: 1.7 },
    { d: 'M5.3 14.6l1.1-2.6 2 2zM18.7 14.6l-1.1-2.6-2 2z' },
  ],
  // Marigold House — Sunburst Crown Shield: a three-point crown under a burst of rays.
  sunburst: [
    { d: 'M6.6 17.4l-.9-6.2 3.3 2.5L12 9.2l3 4.5 3.3-2.5-.9 6.2z' },
    { d: 'M12 4.2v2.6M8.2 5.3l1.2 2.2M15.8 5.3l-1.2 2.2M5.6 7.9l2 1.4M18.4 7.9l-2 1.4', stroke: 1.5 },
  ],
  // Emerald Atelier — Laurel Arch Shield: an atelier arch between two laurel sprays.
  laurel: [
    { d: 'M9.3 18.2v-6.4a2.7 2.7 0 0 1 5.4 0v6.4', stroke: 1.7 },
    { d: 'M12 5.2l1.2 1.5-1.2 1.5-1.2-1.5z' },
    { d: 'M6.9 16.6c-1.4-.5-2-1.6-1.9-2.9 1.3.2 2.1 1.1 1.9 2.9zM6.5 12.9c-1.2-.8-1.5-2-1.1-3.2 1.2.5 1.7 1.6 1.1 3.2zM7 9.4c-.9-1-.9-2.2-.3-3.3 1 .8 1.3 1.9.3 3.3z' },
    { d: 'M17.1 16.6c1.4-.5 2-1.6 1.9-2.9-1.3.2-2.1 1.1-1.9 2.9zM17.5 12.9c1.2-.8 1.5-2 1.1-3.2-1.2.5-1.7 1.6-1.1 3.2zM17 9.4c.9-1 .9-2.2.3-3.3-1 .8-1.3 1.9-.3 3.3z' },
  ],
};

export const LINEN = '#FAF7F0';
export const BRASS = '#D4A34A';
export const BRASS_DEEP = '#9A7325';

const houseOf = (house: number): (typeof HOUSES)[number] => HOUSES[((house % HOUSES.length) + HOUSES.length) % HOUSES.length];

export interface CrestSvgOptions {
  /** Extra class on the <svg>. */
  cls?: string;
  /** Decorative (aria-hidden) rather than a labelled image. */
  quiet?: boolean;
  /** Brass rim: the gilded crest of a District Sovereign and of the Final Edition's winner. */
  gilded?: boolean;
}

/** A House crest as inline SVG. Sized by CSS (`.hcrest`), 24×24 geometry. */
export function crestSvg(house: number, o: CrestSvgOptions = {}): string {
  const h = houseOf(house);
  const emblem = CREST_SHAPES[h.crest]
    .map((s) =>
      s.stroke
        ? `<path d="${s.d}" fill="none" stroke="${LINEN}" stroke-width="${s.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="${s.d}" fill="${LINEN}" fill-rule="evenodd"/>`,
    )
    .join('');
  const label = o.quiet ? 'aria-hidden="true" focusable="false"' : `role="img" aria-label="${h.name} crest: ${h.crestName}"`;
  return `<svg class="hcrest${o.cls ? ` ${o.cls}` : ''}${o.gilded ? ' gilded' : ''}" viewBox="0 0 24 24" data-crest="${h.crest}" ${label}>${o.quiet ? '' : `<title>${h.name} — ${h.crestName}</title>`}<path d="${SHIELD}" fill="${h.color}"/><path d="${SHIELD_SHADE}" fill="${h.dark}"/>${emblem}<path d="${SHIELD}" fill="none" stroke="${o.gilded ? BRASS : h.dark}" stroke-width="${o.gilded ? 1.5 : 1}" stroke-linejoin="round"/></svg>`;
}

/** Brass star pips for Dynasty Milestones earned; the fourth (District Sovereign) is gilded larger. */
export function starPips(n: number, of = 4): string {
  let out = '';
  for (let i = 0; i < of; i++) {
    out += `<svg class="mstar${i < n ? ' on' : ''}${i === of - 1 ? ' grand' : ''}" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .9l1.5 3.3 3.6.4-2.7 2.4.8 3.5L6 8.7l-3.2 1.8.8-3.5L.9 4.6l3.6-.4z"/></svg>`;
  }
  return `<span class="mstars" role="img" aria-label="${n} of ${of} Dynasty Milestones">${out}</span>`;
}

// ───────────────────────────── Canvas ─────────────────────────────

const paths = new Map<string, Path2D>();
const path = (d: string): Path2D => {
  let p = paths.get(d);
  if (!p) {
    p = new Path2D(d);
    paths.set(d, p);
  }
  return p;
};

export interface CrestDrawOptions {
  /** Draw the shield on a white disc with a brass ring (the banner medallion). */
  medallion?: boolean;
  /** Brass rim and a second ring: flagship banners of a House with Milestone stars. */
  gilded?: boolean;
  alpha?: number;
}

/**
 * Draw a House crest centred on (cx, cy), `size` pixels tall, in the current transform.
 * Pure vector: it stays sharp at every zoom and device-pixel ratio.
 */
export function drawCrest(ctx: CanvasRenderingContext2D, house: number, cx: number, cy: number, size: number, o: CrestDrawOptions = {}): void {
  const h = houseOf(house);
  ctx.save();
  if (o.alpha !== undefined) ctx.globalAlpha *= o.alpha;
  if (o.medallion) {
    const r = size * 0.72;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = LINEN;
    ctx.fill();
    ctx.lineWidth = Math.max(1, size * 0.11);
    ctx.strokeStyle = o.gilded ? BRASS : BRASS_DEEP;
    ctx.stroke();
    if (o.gilded) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + size * 0.13, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(0.75, size * 0.05);
      ctx.strokeStyle = BRASS_DEEP;
      ctx.stroke();
    }
  }
  const k = size / CREST_BOX;
  ctx.translate(cx - (CREST_BOX / 2) * k, cy - (CREST_BOX / 2) * k);
  ctx.scale(k, k);
  ctx.fillStyle = h.color;
  ctx.fill(path(SHIELD));
  ctx.fillStyle = h.dark;
  ctx.fill(path(SHIELD_SHADE));
  ctx.fillStyle = LINEN;
  ctx.strokeStyle = LINEN;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of CREST_SHAPES[h.crest]) {
    if (s.stroke) {
      ctx.lineWidth = s.stroke;
      ctx.stroke(path(s.d));
    } else ctx.fill(path(s.d), 'evenodd');
  }
  ctx.lineWidth = o.gilded ? 1.5 : 1;
  ctx.strokeStyle = o.gilded ? BRASS : h.dark;
  ctx.stroke(path(SHIELD));
  ctx.restore();
}
