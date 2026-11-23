// The three AI tycoons. Each returns ordinary Commands, validated by the same applyCommand
// that validates humans — an AI has no powers a player lacks.
import { DAY_DEMAND, DESIRES, LEVEL3_ERA, LOAN_MAX, LOAN_RATE, LOAN_STEP, PAYROLL_TICKS, PROMO_TICKS, SHOPS, SHOP_KINDS, isShop, isUnlocked } from './constants';
import { CITY, chebyshev, manhattan } from './map';
import {
  REV_DECAY,
  applyCommand,
  buildCostFor,
  buildingAt,
  charterMod,
  dayPhase,
  daypart,
  eraNow,
  headlineEvent,
  lotBonuses,
  priceOf,
  promoCostFor,
  queueCap,
  rentOf,
  restockCost,
  serversOf,
  serviceTicksOf,
  stopTiles,
  tick,
  trafficPips,
  upgradeCost,
  wageOf,
} from './sim';
import type { AiPersona, Building, BuildKind, CivicKind, Command, GameState, Player, ShopKind } from './types';

interface Temperament {
  reserve: number; // cash kept back before a discretionary spend
  minReturn: number; // quarterly return below which a new shop is not worth opening
  think: number; // ticks between decisions
  kinds: Record<ShopKind, number>; // taste for each trade
  lot: { corner: number; canal: number; transit: number; aura: number; traffic: number; cluster: number };
}

export const TEMPERAMENTS: Record<AiPersona, Temperament> = {
  vesper: {
    reserve: 60,
    minReturn: 0.3,
    think: 14,
    kinds: { roastery: 1.15, bistro: 1.1, arcade: 1.2, boutique: 0.8, cinema: 1.0, nightmarket: 1.3 },
    lot: { corner: 1.3, canal: 0.1, transit: 0.4, aura: 0.1, traffic: 0.9, cluster: 0.1 },
  },
  aurelia: {
    reserve: 200,
    minReturn: 0.5,
    think: 22,
    kinds: { roastery: 0.6, bistro: 1.5, arcade: 0.3, boutique: 1.6, cinema: 0.9, nightmarket: 0.9 },
    lot: { corner: 0.2, canal: 1.4, transit: 0.1, aura: 1.0, traffic: 0.4, cluster: 0.4 },
  },
  orson: {
    reserve: 40,
    minReturn: 0.36,
    think: 13,
    kinds: { roastery: 0.95, bistro: 1.0, arcade: 1.4, boutique: 0.75, cinema: 1.1, nightmarket: 1.1 },
    lot: { corner: 0.3, canal: 0.1, transit: 1.3, aura: 0.5, traffic: 0.4, cluster: 0.6 },
  },
};

/**
 * Deliberate Dynasty pacing. No House opens on tick one: each AI takes a breath before its
 * first claim, the seats stagger after that, and all of them think at a measured pace through
 * the Founding era's first morning, so a human has time to read the street and claim a corner.
 */
export interface Opening {
  firstMove: number; // tick of the first AI seat's first decision
  stagger: number; // further ticks per AI seat
  slowUntil: number; // thinking is slowed until this tick…
  slowdown: number; // …by this factor
}
export const OPENINGS: Record<GameState['mode'], Opening> = {
  blitz: { firstMove: 70, stagger: 30, slowUntil: 330, slowdown: 1.6 },
  standard: { firstMove: 100, stagger: 50, slowUntil: 750, slowdown: 1.7 },
  endless: { firstMove: 100, stagger: 50, slowUntil: 750, slowdown: 1.7 },
};
/** Kept for callers that tuned Blitz by name. */
export const BLITZ_OPENING = OPENINGS.blitz;
/** A House saves toward next era's trades once the current era is this far gone. */
export const PLAN_AHEAD = 0.7;
/**
 * Measured expansion: the most shops an AI House runs in Era I, II, III and IV. The Founding
 * era is for two or three good doors, not a chain; the cash saved funds each era's new trades.
 */
export const ERA_DOORS: Record<AiPersona, number[]> = {
  vesper: [3, 6, 9, 49],
  aurelia: [3, 4, 7, 9], // a short list, banked for the Boutiques of the Grand Boulevard
  orson: [3, 5, 8, 12], // corridors first: more doors than this only thins his margins
};
export const doorCap = (s: Pick<GameState, 'quarter'>, persona: AiPersona | null): number => ERA_DOORS[persona ?? 'vesper'][eraNow(s) - 1];

/** Earliest tick at which the n-th AI seat may act. */
export function openingDelay(s: Pick<GameState, 'mode' | 'players'>, playerId: number): number {
  const o = OPENINGS[s.mode] ?? OPENINGS.standard;
  let nth = 0;
  for (const q of s.players) {
    if (q.id === playerId) break;
    if (q.kind === 'ai') nth++;
  }
  return o.firstMove + nth * o.stagger;
}

/** Ticks between this persona's decisions right now. */
export function thinkInterval(s: Pick<GameState, 'mode' | 'tick'>, persona: AiPersona): number {
  const base = TEMPERAMENTS[persona].think;
  const o = OPENINGS[s.mode] ?? OPENINGS.standard;
  return s.tick < o.slowUntil ? Math.round(base * o.slowdown) : base;
}

/** How far a tycoon trails the district's most prestigious House. */
export function prestigeGap(s: Pick<GameState, 'players'>, p: Pick<Player, 'id' | 'prestige'>): number {
  let lead = 0;
  for (const q of s.players) if (q.id !== p.id) lead = Math.max(lead, q.prestige);
  return lead - p.prestige;
}

/** Vesper turns civic when the prestige race is being lost: from Quarter 3, trailing by this much. */
export const VESPER_CIVIC = { fromQuarter: 4, gap: 10, minShops: 3, parks: 2, stops: 1, plazas: 1 };

const freeLots = (s: GameState): number[] => CITY.lots.filter((t) => !buildingAt(s, t));
const mine = (s: GameState, p: Player): Building[] => s.buildings.filter((b) => b.owner === p.id);
const myShops = (s: GameState, p: Player): Building[] => mine(s, p).filter((b) => isShop(b.kind));

/** District-wide gross margin a trade can support per payroll, and the most one shop can take. */
// Re-measured over twelve seeded matches: coffee is a thin, crowded trade; fashion, culture
// and the night market carry far more margin per door than the tycoons used to believe.
const TRADE_POOL: Record<ShopKind, number> = { roastery: 90, bistro: 150, arcade: 80, boutique: 120, cinema: 120, nightmarket: 80 };
const TRADE_CAP: Record<ShopKind, number> = { roastery: 28, bistro: 50, arcade: 34, boutique: 70, cinema: 70, nightmarket: 40 };
/** A tycoon holds off a cheap shop when a much better trade is this close to affordable. */
export const SAVE_UP = { reach: 220, better: 1.45 };

/**
 * Expected return on opening one more shop of this trade, as a fraction of its cost earned
 * back per quarter. Blends a prior with what existing shops of the trade actually take.
 */
export function tradeOutlook(s: GameState, p: Player, kind: ShopKind): number {
  const def = SHOPS[kind];
  const di = DESIRES.indexOf(def.desire);
  let n = 0;
  let own = 0;
  let observed = 0;
  let weight = 0;
  for (const b of s.buildings) {
    if (b.kind !== kind) continue;
    n++;
    if (b.owner === p.id) own++;
    const age = s.tick - b.builtTick;
    const w = Math.min(1, age / 700);
    observed += (b.revenue / Math.max(150, age)) * PAYROLL_TICKS * (1 - def.unitCost / priceOf(b)) * w;
    weight += w;
  }
  const prior = Math.min(TRADE_CAP[kind], TRADE_POOL[kind] / (n + 1));
  let expected = prior;
  if (weight > 0) {
    const trust = weight / n;
    const fromObserved = Math.min(TRADE_CAP[kind], (observed / weight) * (n / (n + 1)));
    expected = fromObserved * trust + prior * (1 - trust);
  }
  // Customers walking away unserved are latent demand.
  expected *= 1 + 0.6 * (s.unmet[di] / (s.met[di] + s.unmet[di] + 3));
  expected /= 1 + 0.35 * own; // a new door partly feeds on your own
  return ((expected - def.wage - def.rent) * (s.quarterTicks / PAYROLL_TICKS)) / def.cost;
}

/** How much a persona likes a lot for a given trade. */
export function lotAppeal(s: GameState, p: Player, tile: number, kind: BuildKind): number {
  const t = TEMPERAMENTS[p.persona ?? 'vesper'].lot;
  const bon = lotBonuses(s, tile);
  let v = (trafficPips(s, tile) / 5) * t.traffic;
  if (bon.corner) v += t.corner;
  if (bon.canal) v += t.canal * (kind === 'bistro' ? 1.3 : 1);
  if (bon.transit) v += t.transit * (kind === 'arcade' ? 1.3 : 1);
  v += t.aura * (bon.parks * 0.5 + (bon.plaza ? 1 : 0));
  let near = 0;
  for (const b of s.buildings) if (b.owner === p.id && chebyshev(b.tile, tile) <= 2) near++;
  v += t.cluster * Math.min(3, near) * 0.5;
  return v;
}

function bestShopBuild(s: GameState, p: Player, budget: number, saveUp = false): Command | null {
  const temp = TEMPERAMENTS[p.persona ?? 'vesper'];
  const lots = freeLots(s);
  if (!lots.length) return null;
  if (myShops(s, p).length >= doorCap(s, p.persona)) return null; // this era's measure is full
  // Late in a fixed-length match a new shop has less time to pay for itself.
  const left = s.totalQuarters > 0 && !s.endless ? s.totalQuarters - s.quarter + 1 - (s.tick % s.quarterTicks) / s.quarterTicks : 3;
  const floor = temp.minReturn * (left < 1.2 ? 2.4 : left < 2.2 ? 1.3 : 1);
  let best: Command | null = null;
  let bestScore = 0;
  let nearScore = 0; // the best trade just out of reach
  const discounter = p.persona === 'vesper';
  for (const kind of SHOP_KINDS) {
    // Era locks bind the tycoons as they bind players. Late in an era they plan ahead: a trade
    // that unlocks at the next Council counts as "nearly affordable" and is worth saving for.
    const locked = !isUnlocked(kind, s.quarter);
    if (locked && !(saveUp && isUnlocked(kind, s.quarter + 1) && dayPhase(s) >= PLAN_AHEAD)) continue;
    const near = locked || SHOPS[kind].cost > budget;
    if (near && (!saveUp || SHOPS[kind].cost > budget + SAVE_UP.reach)) continue;
    // The Discounter hunts premium pricing: a rival charging Craft or Prestige for a trade is
    // an invitation to open the same trade next door for less.
    const marks = discounter ? s.buildings.filter((b) => b.kind === kind && b.owner !== p.id && b.stance >= 2) : [];
    const ret = tradeOutlook(s, p, kind) * (marks.length ? UNDERCUT.outlook : 1);
    if (ret < floor) continue;
    for (const tile of lots) {
      let score = ret * temp.kinds[kind] * (1 + 0.6 * lotAppeal(s, p, tile, kind));
      if (marks.some((b) => manhattan(b.tile, tile) <= UNDERCUT.reach)) score *= UNDERCUT.beside;
      if (near) {
        if (score > nearScore) nearScore = score;
        continue;
      }
      if (score > bestScore) {
        bestScore = score;
        best = { c: 'build', tile, kind };
      }
    }
  }
  // Something much better is nearly affordable: keep the cash and wait for it.
  if (saveUp && nearScore > bestScore * SAVE_UP.better) return null;
  return best;
}

function bestCivicLot(s: GameState, p: Player, kind: CivicKind): number {
  if (!isUnlocked(kind, s.quarter)) return -1;
  const shops = myShops(s, p);
  let best = -1;
  let bestScore = 0;
  const stops = stopTiles(s);
  for (const tile of freeLots(s)) {
    let score = 0;
    if (kind === 'tramstop') {
      const av = CITY.avenueAdj[tile];
      if (av < 0 || stops.includes(av)) continue;
      let nearStop = 99;
      for (const st of stops) nearStop = Math.min(nearStop, manhattan(st, av));
      if (nearStop < 4) continue;
      for (const l of CITY.lots) {
        if (l === tile || manhattan(l, av) > 2) continue;
        const b = buildingAt(s, l);
        if (!b) score += 1;
        else if (b.owner === p.id) score += 1.5;
        else score -= 0.4;
      }
      score += 0.4;
    } else {
      const r = kind === 'park' ? 1 : 2;
      for (const b of shops) if (chebyshev(b.tile, tile) <= r) score += 1;
      if (kind === 'plaza' && CITY.canalFront[tile]) score += 0.5;
      // A civic lot should not waste a prime corner.
      if (CITY.corner[tile]) score -= 0.4;
      for (const b of s.buildings) if (b.kind === kind && chebyshev(b.tile, tile) <= r) score -= 1.5;
    }
    if (score > bestScore) {
      bestScore = score;
      best = tile;
    }
  }
  return best;
}

function nearestRivalStance(s: GameState, b: Building): number {
  let stance = -1;
  let bd = 7;
  for (const o of s.buildings) {
    if (o.owner === b.owner || o.kind !== b.kind) continue;
    const d = manhattan(o.tile, b.tile);
    if (d < bd) {
      bd = d;
      stance = o.stance;
    }
  }
  return stance;
}

function pricing(s: GameState, p: Player, out: Command[]): void {
  for (const b of myShops(s, p)) {
    let want = 1;
    if (p.persona === 'vesper') {
      const rival = nearestRivalStance(s, b);
      want = rival >= 0 ? Math.max(0, rival - 1) : 1;
      // No point starving a shop that is already turning people away.
      if (want === 0 && b.queue.length >= Math.ceil(queueCap(b) / 2)) want = 1;
    } else if (p.persona === 'aurelia') {
      want = b.level >= 3 ? 3 : 2;
      // Prestige has to be earned: a finished shop that keeps losing customers to its price,
      // with nobody at the door, steps back to Craft until the queue returns.
      if (want === 3 && b.queue.length <= 1 && (b.lost.tooPricey >= AURELIA_RETREAT || starving(s, b, 2))) want = 2;
      // …and when even Craft leaves the room empty and the till short, she adapts to Fair
      // until the queue is back. A stalled queue is a worse look than an honest price.
      if (want === 2 && b.queue.length === 0 && starving(s, b, 1.5)) want = 1;
      else if (b.stance === 1 && want === 2 && b.queue.length < 2 && s.tick - b.builtTick >= 300) want = 1;
    } else {
      want = b.queue.length >= queueCap(b) - 1 && b.level >= 2 ? 2 : 1;
    }
    if (want !== b.stance) out.push({ c: 'price', id: b.id, stance: want });
  }
}

/** Recent customers lost to price at which Aurelia concedes Prestige for Craft. */
export const AURELIA_RETREAT = 4;
/** Vesper's appetite for opening beside a premium-priced rival of the same trade. */
export const UNDERCUT = { outlook: 1.35, beside: 1.5, reach: 3 };
/** How many shops Aurelia will run: base + perQuarter × the current quarter. */
export const AURELIA_DOORS = { base: 4, perQuarter: 1.5 };
/**
 * …and never more than this in Era I, II, III and IV: she holds a short list through Transit
 * & Trade and banks the takings for the Boutiques and the Plaza the Grand Boulevard unlocks.
 */
export const AURELIA_ERA_DOORS = ERA_DOORS.aurelia;
/** Boutiques she opens ahead of any further upgrades once Era III unlocks them. */
export const AURELIA_FLAGSHIPS = 2;
/** From this far into the era before the Boutique unlocks, she banks rather than spends. */
export const AURELIA_BANK_FROM = 0.45;
/** Cash below which a tycoon with emptying shelves borrows rather than run dry. */
export const LIQUIDITY_FLOOR = 90;

/** What a shop has been taking per payroll lately. */
const takingsPerPayroll = (b: Building): number => b.recent * (1 - REV_DECAY) * PAYROLL_TICKS;
/** A shop open long enough to judge whose takings do not cover `times` its wages and rent. */
const starving = (s: GameState, b: Building, times: number): boolean =>
  s.tick - b.builtTick >= 300 && takingsPerPayroll(b) < times * (wageOf(b) + rentOf(b));

/** Gross margin a Promo Blitz could plausibly add: half the shop's idle capacity for 20 s. */
function promoUpside(b: Building): number {
  const def = SHOPS[b.kind as ShopKind];
  const margin = priceOf(b) - def.unitCost;
  return margin * serversOf(b) * (PROMO_TICKS / serviceTicksOf(b)) * 0.5;
}

function promos(s: GameState, p: Player, out: Command[], spare: number): void {
  const part = daypart(s);
  // Vesper blitzes on thinner odds than the others.
  const cost = promoCostFor(p);
  const need = cost * (p.persona === 'vesper' ? 0.7 : p.persona === 'orson' ? 1.0 : 1.5);
  for (const b of myShops(s, p)) {
    if (s.tick < b.promoReadyAt || spare < cost) continue;
    if (b.queue.length > queueCap(b) / 2 || b.stock < 6) continue; // already busy, or nothing to sell
    const demand = DAY_DEMAND[SHOPS[b.kind as ShopKind].desire][part];
    if (demand < 0.5 || promoUpside(b) * demand < need) continue;
    out.push({ c: 'promo', id: b.id });
    return; // one blitz per thought
  }
}

function pickUpgrade(s: GameState, p: Player, budget: number): Command | null {
  let best: Building | null = null;
  const cap = eraNow(s) >= LEVEL3_ERA ? 3 : 2; // Level 3 waits for the Grand Boulevard
  for (const b of myShops(s, p)) {
    if (b.level >= cap || upgradeCost(b, p) > budget) continue;
    if (!best || b.revenue / (b.level + 1) > best.revenue / (best.level + 1)) best = b;
  }
  return best ? { c: 'upgrade', id: best.id } : null;
}

/** What this AI wants to do right now. Pure: it does not touch the state. */
export function aiDecide(s: GameState, playerId: number): Command[] {
  const p = s.players[playerId];
  const out: Command[] = [];
  if (!p || p.kind !== 'ai' || s.phase !== 'playing') return out;
  const persona = p.persona ?? 'vesper';
  const temp = TEMPERAMENTS[persona];
  const shops = myShops(s, p);
  const own = mine(s, p);
  const count = (k: BuildKind) => own.filter((b) => b.kind === k).length;
  const finalStretch = s.totalQuarters > 0 && !s.endless && s.quarter >= s.totalQuarters;

  // ── Solvency ──
  if (p.cash < 0) {
    if (p.debt + LOAN_STEP <= LOAN_MAX) out.push({ c: 'borrow' });
    else if (p.cash < -150 && shops.length > 1) {
      const worst = shops.slice().sort((a, b) => a.revenue - b.revenue)[0];
      out.push({ c: 'sell', id: worst.id });
    }
    return out;
  }
  // A till too thin to restock is the start of a death spiral: shelves empty, sales stop, and
  // the cash never comes back. Draw on the credit line before it gets there (not in the final
  // stretch, where a loan can no longer pay for itself).
  if (!finalStretch && p.cash < LIQUIDITY_FLOOR && p.debt + LOAN_STEP <= LOAN_MAX && shops.some((b) => b.dry || b.stock <= SHOPS[b.kind as ShopKind].stockMax * 0.2)) {
    out.push({ c: 'borrow' });
    return out;
  }
  let cash = p.cash;
  if (p.debt > 0 && cash > 650) {
    out.push({ c: 'repay' });
    cash -= Math.min(p.debt, LOAN_STEP);
  }

  // ── Stock up before a forecast Supply Crunch ──
  const next = headlineEvent(s);
  if (next && next.kind === 'supplycrunch' && !next.started) {
    for (const b of shops) {
      if (b.stock < SHOPS[b.kind as ShopKind].stockMax * 0.7 && cash > 150) {
        out.push({ c: 'restock', id: b.id });
        cash -= restockCost(s, b, false, p);
      }
    }
  }

  pricing(s, p, out);

  // ── One capital decision per thought ──
  // Keep three payrolls in hand on top of the persona's own cushion.
  let payroll = p.debt * LOAN_RATE * charterMod(p, 'interest');
  for (const b of own) payroll += wageOf(b, p) + rentOf(b);
  const levelCap = eraNow(s) >= LEVEL3_ERA ? 3 : 2;
  const civicCost = (k: CivicKind): number => buildCostFor(p, k);
  let spare = cash - temp.reserve - (shops.length ? payroll * 3 : 0);
  let capital: Command | null = null;

  if (persona === 'orson') {
    // Two short quarters leave no time for a corridor to pay back: in Blitz he keeps to one
    // stop and a couple of parks, and puts the rest into doors.
    const blitz = s.mode === 'blitz';
    const stopsWanted = blitz ? 1 : Math.min(3, 1 + Math.floor(shops.length / 4));
    const parksWanted = Math.min(blitz ? 2 : 4, Math.floor(shops.length / (blitz ? 3 : 2)));
    if (count('tramstop') < stopsWanted && spare >= civicCost('tramstop')) {
      const tile = bestCivicLot(s, p, 'tramstop');
      if (tile >= 0) capital = { c: 'build', tile, kind: 'tramstop' };
    }
    if (!capital && count('park') < parksWanted && spare >= civicCost('park')) {
      const tile = bestCivicLot(s, p, 'park');
      if (tile >= 0) capital = { c: 'build', tile, kind: 'park' };
    }
    if (!capital) capital = bestShopBuild(s, p, spare, shops.length >= 2);
    // Expansion on credit, but never into the final stretch.
    if (!capital && !finalStretch && p.debt === 0 && shops.length >= 2 && spare < 180 && bestShopBuild(s, p, 400)) {
      out.push({ c: 'borrow' });
    }
    if (!capital && (spare > 700 || freeLots(s).length === 0)) capital = pickUpgrade(s, p, spare);
  } else if (persona === 'aurelia') {
    const unfinished = shops.some((b) => b.level < levelCap);
    // A perfectionist keeps a short list of doors: a few more each quarter, never a chain.
    const doors = Math.min(AURELIA_DOORS.base + AURELIA_DOORS.perQuarter * s.quarter, AURELIA_ERA_DOORS[eraNow(s) - 1]);
    const full = shops.length >= doors;
    // The Grand Boulevard is what she has been saving for: her first Boutiques come before any
    // more polish, and late in Transit & Trade she banks the takings rather than spend them.
    const flagship = isUnlocked('boutique', s.quarter) && count('boutique') < AURELIA_FLAGSHIPS && !full;
    const banking = !isUnlocked('boutique', s.quarter) && isUnlocked('boutique', s.quarter + 1) && dayPhase(s) >= AURELIA_BANK_FROM && spare < 900;
    if (banking) {
      capital = null;
    } else if (flagship) {
      capital = bestShopBuild(s, p, spare, true);
      // Not there yet: hold the cash for the Boutique rather than fritter it on refits.
      if (!capital && spare < SHOPS.boutique.cost && shops.length >= 2) capital = null;
      else if (!capital) capital = pickUpgrade(s, p, spare);
    } else if (shops.length >= 2 && unfinished) {
      capital = pickUpgrade(s, p, spare);
      // She will not open a third door while the first two are unfinished, unless flush.
      if (!capital && !full && spare > 700) capital = bestShopBuild(s, p, spare - 300);
    } else if (full) {
      // The list is full: she polishes the block around it instead.
      if (count('plaza') < 1 && spare >= civicCost('plaza')) {
        const tile = bestCivicLot(s, p, 'plaza');
        if (tile >= 0) capital = { c: 'build', tile, kind: 'plaza' };
      }
      if (!capital && count('park') < 2 && spare >= civicCost('park') + 200) {
        const tile = bestCivicLot(s, p, 'park');
        if (tile >= 0) capital = { c: 'build', tile, kind: 'park' };
      }
    } else {
      if (shops.length >= 2 && count('plaza') < 1 && spare >= civicCost('plaza')) {
        const tile = bestCivicLot(s, p, 'plaza');
        if (tile >= 0) capital = { c: 'build', tile, kind: 'plaza' };
      }
      if (!capital && shops.length >= 4 && count('park') < 2 && spare >= civicCost('park') + 200) {
        const tile = bestCivicLot(s, p, 'park');
        if (tile >= 0) capital = { c: 'build', tile, kind: 'park' };
      }
      if (!capital) capital = bestShopBuild(s, p, spare, shops.length >= 1);
    }
  } else {
    // Vesper: volume first, then muscle. But a Crown is not won on turnover alone: from
    // Quarter 3, if he trails on prestige, he puts spare cash into parks, a stop and a plaza.
    const v = VESPER_CIVIC;
    let saving = false;
    if (s.quarter >= v.fromQuarter && shops.length >= v.minShops && prestigeGap(s, p) >= v.gap) {
      const wants: CivicKind[] = [];
      if (count('park') < Math.min(v.parks, Math.floor(shops.length / 2))) wants.push('park');
      if (count('plaza') < v.plazas) wants.push('plaza');
      if (count('tramstop') < v.stops) wants.push('tramstop');
      for (const kind of wants) {
        if (spare < civicCost(kind)) continue;
        const tile = bestCivicLot(s, p, kind);
        if (tile >= 0) {
          capital = { c: 'build', tile, kind };
          break;
        }
      }
      // Nothing affordable yet: hold the next shop back and save toward the cheapest project.
      saving = !capital && wants.length > 0 && spare < civicCost('park');
    }
    if (!capital && !saving) capital = bestShopBuild(s, p, spare, shops.length >= 2);
    if (!capital && !saving) {
      // Muscle up only the shops that are turning customers away.
      const busy = shops.filter((b) => b.level < levelCap && b.turned > 5 + b.served * 0.1 && upgradeCost(b, p) <= spare - 100);
      if (busy.length) capital = { c: 'upgrade', id: busy.sort((a, b) => b.turned - a.turned)[0].id };
    }
  }

  if (capital) {
    out.push(capital);
    spare -= capital.c === 'build' ? buildCostFor(p, capital.kind) : capital.c === 'upgrade' ? 200 : 0;
  }
  promos(s, p, out, spare);
  return out;
}

/** Decide and act. Returns the commands that were accepted. */
export function aiThink(s: GameState, playerId: number): Command[] {
  const done: Command[] = [];
  for (const cmd of aiDecide(s, playerId)) if (applyCommand(s, playerId, cmd).ok) done.push(cmd);
  return done;
}

/**
 * One simulation step with AI tycoons in the loop. Solo and multiplayer both call this.
 * While the Era Council sits (phase 'council') the city is paused and nothing advances.
 */
export function advance(s: GameState): void {
  if (s.phase !== 'playing') return;
  for (const p of s.players) {
    if (p.kind !== 'ai' || s.tick < p.aiNext || s.tick < openingDelay(s, p.id)) continue;
    aiThink(s, p.id);
    p.aiNext = s.tick + thinkInterval(s, p.persona ?? 'vesper');
  }
  tick(s);
}
