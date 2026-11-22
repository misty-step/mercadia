// The three AI tycoons. Each returns ordinary Commands, validated by the same applyCommand
// that validates humans — an AI has no powers a player lacks.
import { CIVICS, DAY_DEMAND, DESIRES, LOAN_MAX, LOAN_RATE, LOAN_STEP, PAYROLL_TICKS, PROMO_COST, PROMO_TICKS, SHOPS, SHOP_KINDS, buildCost, isShop } from './constants';
import { CITY, chebyshev, manhattan } from './map';
import {
  applyCommand,
  buildingAt,
  daypart,
  headlineEvent,
  lotBonuses,
  priceOf,
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
    kinds: { roastery: 0.6, bistro: 1.5, arcade: 0.3, boutique: 1.6, cinema: 0.8, nightmarket: 0.35 },
    lot: { corner: 0.2, canal: 1.4, transit: 0.1, aura: 1.0, traffic: 0.4, cluster: 0.4 },
  },
  orson: {
    reserve: 40,
    minReturn: 0.36,
    think: 13,
    kinds: { roastery: 1.15, bistro: 1.0, arcade: 1.4, boutique: 0.75, cinema: 1.1, nightmarket: 1.1 },
    lot: { corner: 0.3, canal: 0.1, transit: 1.3, aura: 0.5, traffic: 0.4, cluster: 0.6 },
  },
};

const freeLots = (s: GameState): number[] => CITY.lots.filter((t) => !buildingAt(s, t));
const mine = (s: GameState, p: Player): Building[] => s.buildings.filter((b) => b.owner === p.id);
const myShops = (s: GameState, p: Player): Building[] => mine(s, p).filter((b) => isShop(b.kind));

/** District-wide gross margin a trade can support per payroll, and the most one shop can take. */
const TRADE_POOL: Record<ShopKind, number> = { roastery: 110, bistro: 130, arcade: 80, boutique: 75, cinema: 110, nightmarket: 70 };
const TRADE_CAP: Record<ShopKind, number> = { roastery: 30, bistro: 46, arcade: 34, boutique: 42, cinema: 60, nightmarket: 34 };

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

function bestShopBuild(s: GameState, p: Player, budget: number): Command | null {
  const temp = TEMPERAMENTS[p.persona ?? 'vesper'];
  const lots = freeLots(s);
  if (!lots.length) return null;
  // Late in a fixed-length match a new shop has less time to pay for itself.
  const left = s.totalQuarters > 0 && !s.endless ? s.totalQuarters - s.quarter + 1 - (s.tick % s.quarterTicks) / s.quarterTicks : 3;
  const floor = temp.minReturn * (left < 1.2 ? 2.4 : left < 2.2 ? 1.3 : 1);
  let best: Command | null = null;
  let bestScore = 0;
  for (const kind of SHOP_KINDS) {
    if (SHOPS[kind].cost > budget) continue;
    const ret = tradeOutlook(s, p, kind);
    if (ret < floor) continue;
    for (const tile of lots) {
      const score = ret * temp.kinds[kind] * (1 + 0.6 * lotAppeal(s, p, tile, kind));
      if (score > bestScore) {
        bestScore = score;
        best = { c: 'build', tile, kind };
      }
    }
  }
  return best;
}

function bestCivicLot(s: GameState, p: Player, kind: CivicKind): number {
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
      if (want === 0 && b.queue.length >= queueCap(b) - 1) want = 1;
    } else if (p.persona === 'aurelia') {
      want = b.level >= 3 ? 3 : 2;
    } else {
      want = b.queue.length >= queueCap(b) - 1 && b.level >= 2 ? 2 : 1;
    }
    if (want !== b.stance) out.push({ c: 'price', id: b.id, stance: want });
  }
}

/** Gross margin a Promo Blitz could plausibly add: half the shop's idle capacity for 20 s. */
function promoUpside(b: Building): number {
  const def = SHOPS[b.kind as ShopKind];
  const margin = priceOf(b) - def.unitCost;
  return margin * serversOf(b) * (PROMO_TICKS / serviceTicksOf(b)) * 0.5;
}

function promos(s: GameState, p: Player, out: Command[], spare: number): void {
  const part = daypart(s);
  // Vesper blitzes on thinner odds than the others.
  const need = PROMO_COST * (p.persona === 'vesper' ? 0.45 : p.persona === 'orson' ? 1.0 : 1.5);
  for (const b of myShops(s, p)) {
    if (s.tick < b.promoReadyAt || spare < PROMO_COST) continue;
    if (b.queue.length > queueCap(b) / 2 || b.stock < 6) continue; // already busy, or nothing to sell
    const demand = DAY_DEMAND[SHOPS[b.kind as ShopKind].desire][part];
    if (demand < 0.5 || promoUpside(b) * demand < need) continue;
    out.push({ c: 'promo', id: b.id });
    return; // one blitz per thought
  }
}

function pickUpgrade(s: GameState, p: Player, budget: number): Command | null {
  let best: Building | null = null;
  for (const b of myShops(s, p)) {
    if (b.level >= 3 || upgradeCost(b) > budget) continue;
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
        cash -= restockCost(s, b, false);
      }
    }
  }

  pricing(s, p, out);

  // ── One capital decision per thought ──
  // Keep three payrolls in hand on top of the persona's own cushion.
  let payroll = p.debt * LOAN_RATE;
  for (const b of own) payroll += wageOf(b) + rentOf(b);
  let spare = cash - temp.reserve - (shops.length ? payroll * 3 : 0);
  let capital: Command | null = null;

  if (persona === 'orson') {
    const stopsWanted = Math.min(3, 1 + Math.floor(shops.length / 4));
    const parksWanted = Math.min(4, Math.floor(shops.length / 2));
    if (count('tramstop') < stopsWanted && spare >= CIVICS.tramstop.cost) {
      const tile = bestCivicLot(s, p, 'tramstop');
      if (tile >= 0) capital = { c: 'build', tile, kind: 'tramstop' };
    }
    if (!capital && count('park') < parksWanted && spare >= CIVICS.park.cost) {
      const tile = bestCivicLot(s, p, 'park');
      if (tile >= 0) capital = { c: 'build', tile, kind: 'park' };
    }
    if (!capital) capital = bestShopBuild(s, p, spare);
    // Expansion on credit, but never into the final stretch.
    if (!capital && !finalStretch && p.debt === 0 && shops.length >= 2 && spare < 180 && bestShopBuild(s, p, 400)) {
      out.push({ c: 'borrow' });
    }
    if (!capital && (spare > 700 || freeLots(s).length === 0)) capital = pickUpgrade(s, p, spare);
  } else if (persona === 'aurelia') {
    const unfinished = shops.some((b) => b.level < 3);
    if (shops.length >= 2 && unfinished) {
      capital = pickUpgrade(s, p, spare);
      // She will not open a third door while the first two are unfinished, unless flush.
      if (!capital && spare > 700) capital = bestShopBuild(s, p, spare - 300);
    } else {
      if (shops.length >= 2 && count('plaza') < 1 && spare >= CIVICS.plaza.cost) {
        const tile = bestCivicLot(s, p, 'plaza');
        if (tile >= 0) capital = { c: 'build', tile, kind: 'plaza' };
      }
      if (!capital && shops.length >= 4 && count('park') < 2 && spare >= CIVICS.park.cost + 200) {
        const tile = bestCivicLot(s, p, 'park');
        if (tile >= 0) capital = { c: 'build', tile, kind: 'park' };
      }
      if (!capital) capital = bestShopBuild(s, p, spare);
    }
  } else {
    // Vesper: volume first, then muscle.
    capital = bestShopBuild(s, p, spare);
    if (!capital) {
      // Muscle up only the shops that are turning customers away.
      const busy = shops.filter((b) => b.level < 3 && b.turned > 5 + b.served * 0.1 && upgradeCost(b) <= spare - 100);
      if (busy.length) capital = { c: 'upgrade', id: busy.sort((a, b) => b.turned - a.turned)[0].id };
    }
  }

  if (capital) {
    out.push(capital);
    spare -= capital.c === 'build' ? buildCost(capital.kind) : capital.c === 'upgrade' ? 200 : 0;
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

/** One simulation step with AI tycoons in the loop. Solo and multiplayer both call this. */
export function advance(s: GameState): void {
  if (s.phase !== 'playing') return;
  for (const p of s.players) {
    if (p.kind !== 'ai' || s.tick < p.aiNext) continue;
    aiThink(s, p.id);
    p.aiNext = s.tick + TEMPERAMENTS[p.persona ?? 'vesper'].think;
  }
  tick(s);
}
