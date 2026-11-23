// Readable answers to "why?": pure helpers the HUD and renderer use to explain the simulation.
// Nothing here changes a match; everything works on a GameState or on the client's CityView.
import {
  CIVICS,
  DAYPART_NAMES,
  DAY_DEMAND,
  EVENTS,
  MILESTONES,
  MILESTONE_CIVICS,
  MILESTONE_PRESTIGE,
  MILESTONE_PROPERTIES,
  MILESTONE_SERVED,
  MILESTONE_SHARE,
  MILESTONE_SOVEREIGN_ERA,
  MILESTONE_WORTH,
  PARK_AURA,
  PARK_RADIUS,
  PLAZA_AURA,
  PLAZA_RADIUS,
  SHOPS,
  STANCES,
  TRANSIT_RADIUS,
  auraRadius,
  buildCost,
  buildName,
  eraOf,
  isShop,
} from './constants';
import { CITY, chebyshev, manhattan } from './map';
import { hasEnclave, lotBonuses, priceOf, trafficPips } from './sim';
import type { BuildKind, Building, CivicKind, Desire, EventKind, LostCustomers, ShopKind } from './types';

type BuildingLike = Pick<Building, 'id' | 'tile' | 'kind' | 'owner'>;
interface WorldLike {
  buildings: BuildingLike[];
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const money = (n: number): string => `§${Math.round(n)}`;

// ───────────────────────────── Dayparts ─────────────────────────────

/** The daypart in which a desire runs hottest. */
export function peakDaypart(desire: Desire): number {
  const d = DAY_DEMAND[desire];
  let best = 0;
  for (let i = 1; i < d.length; i++) if (d[i] > d[best]) best = i;
  return best;
}

/** "Morning", or "Noon & Twilight" when two dayparts are within a tenth of each other. */
export function peakHours(desire: Desire): string {
  const d = DAY_DEMAND[desire];
  const top = d[peakDaypart(desire)];
  const names: string[] = [];
  d.forEach((v, i) => {
    if (v >= top - 0.1) names.push(DAYPART_NAMES[i]);
  });
  return names.join(' & ');
}

// ───────────────────────────── Shop diagnosis ─────────────────────────────

export interface Diagnosis {
  text: string;
  tone: 'bad' | 'warn' | 'info' | 'ok';
}

const LOST_LABEL: Record<keyof LostCustomers, string> = {
  tooPricey: 'too pricey',
  queueFull: 'queue full',
  outOfStock: 'sold out',
};

/**
 * One line that tells an owner why a shop is missing sales, most urgent cause first:
 * lost customers by reason, an empty stockroom, the wrong time of day, or a rival next door.
 */
export function shopDiagnosis(
  b: Pick<Building, 'kind' | 'lost' | 'dry' | 'stock' | 'served' | 'stance' | 'tile' | 'owner'> & { id?: number },
  ctx: { daypart: number; buildings?: Pick<Building, 'kind' | 'owner' | 'tile' | 'stance'>[] },
): Diagnosis | null {
  if (!isShop(b.kind)) return null;
  const def = SHOPS[b.kind];
  const reasons = (Object.keys(LOST_LABEL) as (keyof LostCustomers)[])
    .map((k) => ({ k, n: Math.round(b.lost?.[k] ?? 0) }))
    .filter((r) => r.n >= 1)
    .sort((x, y) => y.n - x.n);
  if (reasons.length) {
    return { text: `Passed by: ${reasons.map((r) => `${r.n} ${LOST_LABEL[r.k]}`).join(' · ')}`, tone: reasons[0].n >= 4 ? 'bad' : 'warn' };
  }
  if (b.dry || b.stock <= 0) return { text: 'Sold out — restock to reopen the doors', tone: 'bad' };
  const demand = DAY_DEMAND[def.desire][ctx.daypart] ?? 1;
  const peak = peakDaypart(def.desire);
  if (demand < 0.5 && ctx.daypart !== peak) {
    return { text: `Off-peak — ${cap(def.desire)} peaks in ${DAYPART_NAMES[peak]}`, tone: 'info' };
  }
  // A cheaper rival of the same trade within five tiles takes the price-sensitive crowd.
  let cheaper = 0;
  for (const o of ctx.buildings ?? []) {
    if (o.kind === b.kind && o.owner !== b.owner && manhattan(o.tile, b.tile) <= 5 && o.stance < b.stance) cheaper++;
  }
  if (cheaper) {
    return { text: `Undercut — ${cheaper} cheaper rival ${def.name}${cheaper === 1 ? '' : 's'} nearby`, tone: 'warn' };
  }
  return { text: b.served > 0 ? 'Trading well — no customers lost lately' : `Open for business — ${cap(def.desire)} peaks in ${DAYPART_NAMES[peak]}`, tone: 'ok' };
}

// ───────────────────────────── Lots and blueprints ─────────────────────────────

export interface SynergyBadge {
  text: string;
  tone: 'plus' | 'minus' | 'note';
}

/**
 * What a blueprint gains or faces on a lot: aura and transit synergies, frontage, and the
 * competition already trading nearby. Drives the hover card while a build tool is armed.
 */
export function lotSynergy(world: WorldLike, tile: number, kind: BuildKind, me: number): SynergyBadge[] {
  const out: SynergyBadge[] = [];
  const bon = lotBonuses(world, tile);
  if (isShop(kind)) {
    if (bon.plaza) out.push({ text: '+Plaza Aura', tone: 'plus' });
    if (bon.parks) out.push({ text: bon.parks > 1 ? `+Park Aura ×${bon.parks}` : '+Park Aura', tone: 'plus' });
    if (bon.transit) out.push({ text: '+Tram Footfall', tone: 'plus' });
    if (bon.corner) out.push({ text: '+Corner', tone: 'plus' });
    if (bon.canal) out.push({ text: kind === 'bistro' ? '+Canal Terrace' : '+Canal Front', tone: 'plus' });
    let rivals = 0;
    let own = 0;
    for (const b of world.buildings) {
      if (b.kind !== kind || manhattan(b.tile, tile) > 5) continue;
      if (b.owner === me) own++;
      else rivals++;
    }
    const name = buildName(kind);
    if (rivals) out.push({ text: `${rivals} rival ${name}${rivals === 1 ? '' : 's'} nearby`, tone: 'minus' });
    if (own) out.push({ text: `${own} of your own nearby`, tone: 'note' });
    if (!rivals && !own) out.push({ text: `No ${name} nearby`, tone: 'note' });
  } else if (kind === 'tramstop') {
    if (CITY.avenueAdj[tile] < 0) return [{ text: 'Place along the tramway avenue', tone: 'minus' }];
    const reach = civicReach(world, tile, kind);
    const mine = reach.shops.filter((b) => b.owner === me).length;
    out.push({ text: `+Tram Footfall to ${reach.lots.length} lot${reach.lots.length === 1 ? '' : 's'}`, tone: 'plus' });
    if (reach.shops.length) out.push({ text: `${mine} of your shops · ${reach.shops.length - mine} rival`, tone: mine >= reach.shops.length - mine ? 'plus' : 'minus' });
  } else {
    const reach = civicReach(world, tile, kind);
    const mine = reach.shops.filter((b) => b.owner === me).length;
    const pct = Math.round((kind === 'park' ? PARK_AURA : PLAZA_AURA) * 100);
    out.push({ text: `+${pct}% ${kind === 'park' ? 'Park' : 'Plaza'} Aura to ${reach.lots.length} lot${reach.lots.length === 1 ? '' : 's'}`, tone: 'plus' });
    if (reach.shops.length) out.push({ text: `Boosts ${mine} of yours · ${reach.shops.length - mine} rival`, tone: mine >= reach.shops.length - mine ? 'plus' : 'minus' });
    else out.push({ text: 'No shops in range yet', tone: 'note' });
  }
  return out;
}

/** Lots (and the shops on them) a civic project on `tile` reaches. */
export function civicReach<B extends BuildingLike>(world: { buildings: B[] }, tile: number, kind: CivicKind): { lots: number[]; shops: B[] } {
  const lots: number[] = [];
  const av = CITY.avenueAdj[tile];
  for (const l of CITY.lots) {
    if (l === tile) continue;
    if (kind === 'tramstop') {
      if (av >= 0 && manhattan(av, l) <= TRANSIT_RADIUS) lots.push(l);
    } else if (chebyshev(l, tile) <= (kind === 'park' ? PARK_RADIUS : PLAZA_RADIUS)) lots.push(l);
  }
  const set = new Set(lots);
  return { lots, shops: world.buildings.filter((b) => isShop(b.kind) && set.has(b.tile)) };
}

/** Live impact numbers for a built civic project, as label/value pairs for its Inspector. */
export function civicImpact(
  world: { buildings: (BuildingLike & Pick<Building, 'riders' | 'auraSales'>)[] },
  b: BuildingLike & Pick<Building, 'riders' | 'auraSales'>,
): { label: string; value: string }[] {
  if (isShop(b.kind)) return [];
  const reach = civicReach(world, b.tile, b.kind as CivicKind);
  if (b.kind === 'tramstop') {
    return [
      { label: 'Riders delivered', value: String(b.riders ?? 0) },
      { label: 'Shops in reach', value: String(reach.shops.length) },
    ];
  }
  return [
    { label: 'Nearby shops boosted', value: String(reach.shops.length) },
    { label: 'Boosted sales', value: String(b.auraSales ?? 0) },
  ];
}

// ───────────────────────────── Tooltips ─────────────────────────────

/** The build dock tooltip: cost, when it earns, what the demand bars mean, how far a civic reaches. */
export function toolTooltip(kind: BuildKind): string {
  if (isShop(kind)) {
    const d = SHOPS[kind as ShopKind];
    return [
      `${d.name} — ${money(d.cost)}`,
      `Serves ${d.desire} at ${money(d.price)} a ticket (Fair price).`,
      `Peak hours: ${peakHours(d.desire)}.`,
      'Demand bars (top right): more bars = more citizens wanting this and finding no shop.',
      d.blurb,
    ].join('\n');
  }
  const c = CIVICS[kind as CivicKind];
  const r = auraRadius(kind);
  const reach =
    kind === 'tramstop'
      ? `Must touch the tramway avenue. Lots within ${TRANSIT_RADIUS} tiles of the stop gain +10% pull (Arcades +30%).`
      : `Boost radius: ${r} tile${r === 1 ? '' : 's'} around it (${(2 * r + 1) ** 2 - 1} lots at most) — +${Math.round((kind === 'park' ? PARK_AURA : PLAZA_AURA) * 100)}% appeal for every shop inside, yours or a rival's.`;
  return [`${c.name} — ${money(buildCost(kind))}`, reach, `Earns ${c.prestige} Civic Prestige at once, more as citizens use it. Upkeep ${money(c.rent * 6)}/min.`, c.blurb].join('\n');
}

// ───────────────────────────── Events ─────────────────────────────

const BOOSTED: Partial<Record<EventKind, ShopKind[]>> = {
  cloudburst: ['cinema', 'roastery'],
  cruise: ['boutique', 'bistro'],
  critic: ['bistro', 'roastery'],
  lantern: ['nightmarket', 'arcade'],
};
const DAMPENED: Partial<Record<EventKind, ShopKind[]>> = { cloudburst: ['nightmarket'] };

/**
 * What a forecast or running Gazette event points at on the map: the shops it lifts, the
 * shops it hurts, and the landmark it arrives through (the Harbor Pier, the tram platforms).
 */
export function eventHighlights(
  world: { buildings: Pick<Building, 'tile' | 'kind'>[] },
  kind: EventKind,
  stops: number[] = [],
): { boost: number[]; dampen: number[]; landmarks: number[] } {
  const boost: number[] = [];
  const dampen: number[] = [];
  const up = BOOSTED[kind] ?? [];
  const down = DAMPENED[kind] ?? [];
  for (const b of world.buildings) {
    if (up.includes(b.kind as ShopKind)) boost.push(b.tile);
    else if (down.includes(b.kind as ShopKind)) dampen.push(b.tile);
    else if (kind === 'freeride' && b.kind === 'tramstop') boost.push(b.tile);
  }
  const landmarks = kind === 'cruise' ? [CITY.pierTile] : kind === 'freeride' ? stops.slice() : [];
  return { boost, dampen, landmarks };
}

/** Whether an event's effect line is worth restating next to a shop of this kind. */
export function eventTouches(kind: EventKind, shop: BuildKind): 'boost' | 'dampen' | null {
  if ((BOOSTED[kind] ?? []).includes(shop as ShopKind)) return 'boost';
  if ((DAMPENED[kind] ?? []).includes(shop as ShopKind)) return 'dampen';
  return null;
}

export const eventEffect = (kind: EventKind): string => EVENTS[kind].effect;

/** Price a rival would have to beat: used by the Inspector to name a stance in words. */
export const stanceLabel = (b: Pick<Building, 'kind' | 'stance'>): string =>
  `${STANCES[b.stance].name} · ${money(priceOf(b))}`;

// ───────────────────────────── Founding Guide ─────────────────────────────

/** How many starter corners the Founding Guide marks on the map. */
export const STARTER_LOTS = 4;

/**
 * The prime starter corners: the vacant lots with the most foot traffic past the door, corners
 * first, spread out so the brass rings do not all land on one block.
 */
export function starterLots(world: { buildings: Pick<Building, 'kind' | 'tile'>[]; footfall: number[] }, n = STARTER_LOTS): number[] {
  const taken = new Set(world.buildings.map((b) => b.tile));
  const ranked = CITY.lots
    .filter((t) => !taken.has(t))
    .map((t) => {
      const bon = lotBonuses(world, t);
      return { t, score: trafficPips(world, t) + (bon.corner ? 1.5 : 0) + (bon.canal ? 0.4 : 0) + (bon.transit ? 0.3 : 0) };
    })
    .sort((a, b) => b.score - a.score || a.t - b.t);
  const out: number[] = [];
  for (const r of ranked) {
    if (out.length >= n) break;
    if (out.some((o) => chebyshev(o, r.t) <= 1)) continue; // keep the marks apart
    out.push(r.t);
  }
  for (const r of ranked) {
    if (out.length >= n) break;
    if (!out.includes(r.t)) out.push(r.t);
  }
  return out;
}

export interface GuideFacts {
  /** Buildings the player owns. */
  owned: Pick<Building, 'kind' | 'tile'>[];
  /** The player has opened the Inspector on one of their own shops at least once. */
  inspected: boolean;
  /** Dynasty Milestones earned so far. */
  stars: number;
  /** The player dismissed the guide. */
  dismissed: boolean;
}

export interface GuideView {
  /** 1..3 while the guide is showing, 0 once it has retired. */
  step: 0 | 1 | 2 | 3;
  title: string;
  hint: string;
  /** Steps done, for the three progress pips. */
  done: [boolean, boolean, boolean];
}

export const GUIDE_STEPS: { title: string; hint: string }[] = [
  { title: 'Claim a prime corner', hint: 'Pick Roastery or Bistro, then click a ringed lot.' },
  { title: 'Inspect your opening street', hint: 'Click your shop for its live diagnosis and price stance.' },
  { title: 'Shape your block or earn your first Milestone', hint: 'Place a Pocket Park or claim a second property.' },
];

/**
 * The three-step Founding Guide. It advances on what the player has actually done and retires
 * for good once the third step is complete, or the moment it is dismissed.
 */
export function guideState(f: GuideFacts): GuideView {
  const shops = f.owned.filter((b) => isShop(b.kind)).length;
  const one = shops >= 1;
  const two = one && f.inspected;
  const three = two && (f.owned.length >= 2 || f.owned.some((b) => b.kind === 'park') || f.stars >= 1);
  const done: [boolean, boolean, boolean] = [one, two, three];
  if (f.dismissed || three) return { step: 0, title: '', hint: '', done };
  const step = !one ? 1 : !two ? 2 : 3;
  return { step, title: GUIDE_STEPS[step - 1].title, hint: GUIDE_STEPS[step - 1].hint, done };
}

// ───────────────────────────── Dynasty ─────────────────────────────

export interface MilestoneProgress {
  name: string;
  goal: string;
  pill: string;
  done: boolean;
  /** 0..1 toward the nearer of the milestone's two thresholds. */
  progress: number;
  /** "18/25 served" */
  detail: string;
}

/** Where a House stands on each Dynasty Milestone, for the leaderboard's progress pill. */
export function milestoneProgress(
  world: { buildings: Pick<Building, 'tile' | 'owner'>[]; quarter: number },
  p: { id: number; milestones: number[]; served: number; civicBuilt: number; prestige: number; netWorth: number; share: number },
): MilestoneProgress[] {
  const owned = world.buildings.filter((b) => b.owner === p.id);
  const enclave = hasEnclave(world, p.id);
  const era = eraOf(world.quarter);
  const frac = (v: number, of: number): number => Math.max(0, Math.min(1, v / of));
  const rows: [number, string][] = [
    [frac(p.served, MILESTONE_SERVED), `${Math.min(p.served, MILESTONE_SERVED)}/${MILESTONE_SERVED} served`],
    [enclave ? 1 : frac(owned.length, MILESTONE_PROPERTIES), `${Math.min(owned.length, MILESTONE_PROPERTIES)}/${MILESTONE_PROPERTIES} properties`],
    [Math.max(frac(p.civicBuilt, MILESTONE_CIVICS), frac(p.prestige, MILESTONE_PRESTIGE)), `${Math.min(p.civicBuilt, MILESTONE_CIVICS)}/${MILESTONE_CIVICS} civic · ${Math.floor(p.prestige)}/${MILESTONE_PRESTIGE} prestige`],
    [
      era < MILESTONE_SOVEREIGN_ERA ? Math.min(0.9, Math.max(frac(p.netWorth, MILESTONE_WORTH), frac(p.share, MILESTONE_SHARE))) : Math.max(frac(p.netWorth, MILESTONE_WORTH), frac(p.share, MILESTONE_SHARE)),
      era < MILESTONE_SOVEREIGN_ERA ? 'Opens in Era III' : `§${Math.round(p.netWorth).toLocaleString('en-US')}/§1,200 · ${Math.round(p.share * 100)}%/40%`,
    ],
  ];
  return MILESTONES.map((m, i) => {
    const done = (p.milestones[i] ?? -1) >= 0;
    return { name: m.name, goal: m.goal, pill: m.pill, done, progress: done ? 1 : rows[i][0], detail: done ? 'Earned' : rows[i][1] };
  });
}

// ───────────────────────────── Names ─────────────────────────────

/** Three-letter initials for the compact score strip: "You", "Ves", "Aur", "Ors". */
export function initials(name: string, isMe: boolean): string {
  if (isMe) return 'You';
  const letters = Array.from(name.replace(/[^\p{L}\p{N}]/gu, ''));
  if (!letters.length) return '···';
  const s = letters.slice(0, 3).join('');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
