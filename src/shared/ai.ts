// The AI Houses. `planAI(game, seat)` is a pure function of the frozen state and the seat: it
// never sees a human draft, so its orders cannot depend on when humans act. It obeys the same
// Actions, treasury, Era, Charter and unit rules as a human because every order is queued
// through the same legality checks.
import {
  BUILD_KINDS,
  CHARTERS,
  CHARTER_ERA_FIT,
  CHARTER_TASTE,
  CIVICS,
  ERA_UNLOCK,
  SHOPS,
  STUDIES,
  UNIT_CAP,
  UNITS,
  isShop,
} from './constants';
import { buildCostFor, buildingAt, buildingsOf, currentEra, hasStudy, moveOf, pactBetween, restockCostFor, unitsOf, upgradeCostFor } from './game';
import { CITY, chebyshev, manhattan, walkDist } from './map';
import { queueOrder, reachFrom, routeDistance } from './orders';
import type { AiPersona, BuildKind, Game, Order } from './types';

const PREFERRED: Record<AiPersona, BuildKind[]> = {
  vesper: ['roastery', 'arcade', 'nightmarket', 'bistro', 'cinema', 'boutique', 'park'],
  aurelia: ['bistro', 'roastery', 'boutique', 'plaza', 'cinema', 'park', 'arcade'],
  orson: ['roastery', 'park', 'tramstop', 'arcade', 'bistro', 'nightmarket', 'cinema', 'plaza'],
};
const DEFAULT_STANCE: Record<AiPersona, number> = { vesper: 1, aurelia: 2, orson: 1 };
const STUDY_PREF: Record<AiPersona, string[]> = {
  vesper: ['drill', 'roasting', 'ledger', 'facades', 'hydraulics', 'signalling'],
  aurelia: ['roasting', 'facades', 'ledger', 'signalling', 'hydraulics', 'drill'],
  orson: ['hydraulics', 'signalling', 'roasting', 'ledger', 'facades', 'drill'],
};

export function planAI(g: Game, seat: number): Order[] {
  const p = g.players[seat];
  const persona: AiPersona = p.persona ?? 'vesper';
  const era = currentEra(g);
  let draft: Order[] = [];
  const add = (o: Order): boolean => {
    const r = queueOrder(g, seat, draft, o);
    if (!r.ok) return false;
    draft = r.draft;
    return true;
  };
  const planCash = (): number => {
    let cash = p.cash;
    for (const o of draft) cash -= costOf(o);
    return cash;
  };
  const costOf = (o: Order): number => {
    switch (o.t) {
      case 'build':
        return buildCostFor(p, o.kind);
      case 'upgrade': {
        const b = g.buildings.find((x) => x.id === o.building);
        return b ? upgradeCostFor(p, b) : 0;
      }
      case 'recruit':
        return UNITS[o.kind].cost;
      case 'restock': {
        const b = g.buildings.find((x) => x.id === o.building);
        return b ? restockCostFor(g, p, b) : 0;
      }
      case 'study':
        return 60;
      case 'promo':
        return 80;
      case 'contract':
        return 60;
      case 'borrow':
        return -400;
      case 'repay':
        return Math.min(400, p.debt);
      default:
        return 0;
    }
  };

  // ── Council: a Charter by taste and what the coming era rewards ──
  if (g.council) {
    const offers = g.council.offers[seat] ?? [];
    const fit = CHARTER_ERA_FIT[g.council.era] ?? {};
    const best = offers.slice().sort((a, b) => CHARTER_TASTE[persona][b] * (fit[b] ?? 1) - CHARTER_TASTE[persona][a] * (fit[a] ?? 1) || (a < b ? -1 : 1))[0];
    if (best) add({ t: 'charter', key: best });
  }

  const mine = buildingsOf(g, seat);
  const shops = mine.filter((b) => isShop(b.kind));
  const reserve = 60 + shops.length * 14;

  // ── Housekeeping: repay when flush ──
  if (p.debt > 0 && planCash() > 700 + reserve) add({ t: 'repay' });

  // ── Price stances from last turn's lost demand ──
  for (const b of shops) {
    let want = DEFAULT_STANCE[persona];
    const def0 = SHOPS[b.kind as keyof typeof SHOPS];
    // Vesper undercuts any same-trade rival within three tiles.
    if (persona === 'vesper' && g.buildings.some((o) => o.owner !== seat && isShop(o.kind) && SHOPS[o.kind as keyof typeof SHOPS].desire === def0.desire && chebyshev(o.tile, b.tile) <= 3)) want = 0;
    if (persona === 'aurelia' && b.level < 2) want = 1;
    if (b.lastLost.tooPricey >= 3) want = Math.max(0, want - 1);
    else if (b.lastLost.queueFull >= 3 || (b.lastLost.outOfStock === 0 && b.lastSales > 0 && b.lastServed >= 6)) want = Math.min(3, want + 1);
    if (era <= 1 && want > 2) want = 2;
    if (b.stance !== want) add({ t: 'stance', building: b.id, stance: want });
  }

  // ── Supplies ──
  for (const b of shops) {
    const def = SHOPS[b.kind as keyof typeof SHOPS];
    if (!b.auto && planCash() > 280) add({ t: 'auto', building: b.id, on: true });
    if (b.stock < def.stockMax * 0.35) {
      const c = restockCostFor(g, p, b);
      if (c > 0 && planCash() - c > 40) add({ t: 'restock', building: b.id });
    }
  }

  // ── Expansion: at most one new property per turn in Era I, two afterwards ──
  const maxNew = era === 1 ? 1 : 2;
  let built = 0;
  for (let attempt = 0; attempt < 3 && built < maxNew; attempt++) {
    if (!expand()) break;
    built++;
  }

  // ── Upgrades ──
  for (const b of shops.slice().sort((a, c) => c.lastSales - a.lastSales || a.id - c.id)) {
    if (b.level >= 3) continue;
    const c = upgradeCostFor(p, b);
    const rich = planCash() - c > 140 + reserve;
    const want = persona === 'aurelia' ? true : b.lastSales >= 40;
    if (rich && want && add({ t: 'upgrade', building: b.id })) break;
  }

  // ── Guild Study ──
  if (planCash() > 300) {
    const pref = STUDY_PREF[persona];
    const order = p.study ? [p.study, ...pref] : pref;
    for (const k of order) {
      const key = k as keyof typeof STUDIES;
      if (STUDIES[key] && !hasStudy(p, key) && add({ t: 'study', key })) break;
    }
  }

  // ── Units, trade, promotion, contests ──
  const units = unitsOf(g, seat);
  if (persona === 'vesper' && era >= 2 && units.filter((u) => u.kind === 'watch').length < 2 && planCash() > 420) add({ t: 'recruit', kind: 'watch' });
  if (persona === 'orson' && era >= 2 && !units.some((u) => u.kind === 'barge') && shops.some((b) => CITY.canalFront[b.tile]) && planCash() > 360) add({ t: 'recruit', kind: 'barge' });
  for (const u of units.filter((x) => x.kind === 'barge' && x.route === 0)) {
    const shop = shops.filter((b) => CITY.canalFront[b.tile] && routeDistance(b.tile) >= 0 && routeDistance(b.tile) <= 3 * moveOf(p, 'barge')).sort((a, b) => a.id - b.id)[0];
    if (shop) add({ t: 'route', unit: u.id, building: shop.id });
  }
  if (persona === 'vesper') {
    const best = shops.filter((b) => b.promoReady <= g.turn && b.promoUntil < g.turn && b.stock >= 6).sort((a, b) => b.lastSales - a.lastSales || a.id - b.id)[0];
    if (best && planCash() > 260 && g.turn % 3 === seat % 3) add({ t: 'promo', building: best.id });
    for (const u of units.filter((x) => x.kind === 'watch')) {
      const target = g.units.filter((t) => t.owner !== seat && chebyshev(t.tile, u.tile) <= 1 && !pactBetween(g, seat, t.owner, 'truce')).sort((a, b) => a.cohesion - b.cohesion || a.id - b.id)[0];
      if (target && era >= 2) add({ t: 'contest', unit: u.id, target: target.id });
    }
  }
  if (persona === 'aurelia' && era >= 2) {
    for (const b of shops.filter((x) => x.contractUntil < g.turn && x.stock < 8).slice(0, 1)) if (planCash() > 200) add({ t: 'contract', building: b.id });
  }

  // ── Diplomacy by temperament ──
  for (const q of g.proposals.filter((x) => x.to === seat && x.turn < g.turn).sort((a, b) => a.id - b.id)) {
    const accept = persona === 'vesper' ? q.kind === 'trade' : persona === 'aurelia' ? q.kind !== 'truce' || g.turn > 8 : true;
    add({ t: 'respond', proposal: q.id, accept });
  }
  if (era >= 2 && g.turn % 4 === (seat + 1) % 4 && persona !== 'vesper') {
    const kind = persona === 'aurelia' ? 'trade' : 'truce';
    const rival = g.players.filter((x) => x.id !== seat && !pactBetween(g, seat, x.id, kind)).sort((a, b) => a.id - b.id)[0];
    if (rival) add({ t: 'propose', to: rival.id, kind });
  }

  return draft;

  // ── Pick a lot, a shop and (if needed) a Factor step ──
  function expand(): boolean {
    const cash = planCash();
    const claimed = new Set(draft.filter((o) => o.t === 'build').map((o) => (o as { tile: number }).tile));
    const lots = CITY.lots.filter((t) => !buildingAt(g, t) && !claimed.has(t));
    if (!lots.length) return false;
    const kind = pickKind(cash);
    if (!kind) return false;
    const cost = buildCostFor(p, kind);
    const scored = lots
      .map((t) => ({ t, s: scoreLot(t, kind) }))
      .sort((a, b) => b.s - a.s || a.t - b.t);
    // Direct build on the best lot in reach.
    for (const c of scored.slice(0, 14)) if (add({ t: 'build', tile: c.t, kind })) return true;
    // Otherwise walk a Factor toward the best lots and build in the same turn.
    const factors = unitsOf(g, seat).filter((u) => u.kind === 'factor');
    for (const c of scored.slice(0, 6)) {
      for (const f of factors) {
        const reach = reachFrom('factor', f.tile, UNITS.factor.move);
        const steps = [...reach.keys()].filter((t) => chebyshev(t, c.t) <= 1 && t !== f.tile).sort((a, b) => (reach.get(a)! - reach.get(b)!) || a - b);
        for (const dest of steps) {
          const before = draft;
          if (add({ t: 'move', unit: f.id, to: dest }) && add({ t: 'build', tile: c.t, kind })) return true;
          draft = before;
        }
      }
    }
    // Trek: walk a Factor along the streets toward the best lot's door for next turn.
    const f = factors.find((x) => !draft.some((o) => o.t === 'move' && (o as { unit: number }).unit === x.id));
    if (f && scored[0]) {
      const target = streetNear(scored[0].t);
      if (target >= 0) {
        const reach = reachFrom('factor', f.tile, UNITS.factor.move);
        const here = walkDist(f.tile, target);
        const dest = [...reach.keys()]
          .filter((t) => t !== f.tile && walkDist(t, target) >= 0 && walkDist(t, target) < (here < 0 ? 999 : here))
          .sort((a, b) => walkDist(a, target) - walkDist(b, target) || a - b)[0];
        if (dest !== undefined) add({ t: 'move', unit: f.id, to: dest });
      }
    }
    void cost;
    return false;
  }

  function streetNear(t: number): number {
    if (CITY.door[t] >= 0) return CITY.door[t];
    return -1;
  }

  function pickKind(cash: number): BuildKind | null {
    const owned = (k: BuildKind): number => mine.filter((b) => b.kind === k).length + draft.filter((o) => o.t === 'build' && o.kind === k).length;
    if (mine.length + draft.filter((o) => o.t === 'build').length >= 14) return null;
    const ranked = PREFERRED[persona].filter((k) => BUILD_KINDS.includes(k) && ERA_UNLOCK[k] <= era);
    // Civic projects only once a few shops stand.
    const shopCount = shops.length + draft.filter((o) => o.t === 'build' && isShop((o as { kind: BuildKind }).kind)).length;
    for (const k of ranked) {
      const cost = buildCostFor(p, k);
      if (cost + reserve > cash || owned(k) >= 3) continue;
      if (!isShop(k) && (shopCount < 2 || owned(k) >= (k === 'plaza' ? 1 : 2))) continue;
      if (isShop(k) && owned(k) >= 2 && ranked.some((o) => isShop(o) && owned(o) < owned(k))) continue;
      return k;
    }
    return null;
  }

  function scoreLot(t: number, kind: BuildKind): number {
    let s = 0;
    const x = t % 12;
    const y = Math.floor(t / 12);
    s += traffic(t) * 0.22;
    if (CITY.corner[t]) s += persona === 'vesper' ? 3 : 1;
    if (CITY.canalFront[t]) s += persona === 'aurelia' ? 3 : kind === 'bistro' ? 2 : 0.5;
    const stops = [...CITY.fixedStops, ...g.buildings.filter((b) => b.kind === 'tramstop').map((b) => b.tile)];
    if (stops.some((q) => chebyshev(q, t) <= 2)) s += persona === 'orson' ? 2.5 : 0.8;
    if (mine.some((b) => manhattan(b.tile, t) === 1)) s += persona === 'orson' ? 2 : 0.8;
    if (!isShop(kind)) {
      // Civic projects sit beside the shops they lift.
      s += shops.filter((b) => chebyshev(b.tile, t) <= (kind === 'plaza' ? 2 : 1)).length * 1.5;
      if (kind === 'tramstop' && CITY.avenueAdj[t] >= 0) s += 1.5;
    }
    // Same-trade rivals nearby split the street.
    if (isShop(kind)) {
      const desire = SHOPS[kind].desire;
      s -= g.buildings.filter((b) => isShop(b.kind) && SHOPS[b.kind as keyof typeof SHOPS].desire === desire && chebyshev(b.tile, t) <= 2).length * 1.2;
    }
    // Stay near home: the closer a lot is to a Factor or an owned property, the cheaper it is to take.
    const anchors = [...mine.map((b) => b.tile), ...unitsOf(g, seat).filter((u) => u.kind === 'factor').map((u) => u.tile)];
    if (anchors.length) s -= 0.2 * Math.min(...anchors.map((a) => manhattan(a, t)));
    s += ((x * 7 + y * 13 + seat * 5) % 10) * 0.01; // stable tie-break
    return s;
  }
}

/** How much foot traffic reaches a lot's door: the sources' emissions, discounted by walking distance. */
const SOURCES: { door: number; n: number }[] = [
  ...CITY.homeDoors.map((d) => ({ door: d, n: 7 })),
  { door: CITY.stationDoor, n: 16 },
  { door: CITY.pierTile, n: 10 },
  ...CITY.fixedStops.map((d) => ({ door: d, n: 5 })),
];
const trafficCache = new Map<number, number>();
function traffic(t: number): number {
  let v = trafficCache.get(t);
  if (v === undefined) {
    v = 0;
    const door = CITY.door[t];
    if (door >= 0) for (const s of SOURCES) {
      const d = walkDist(s.door, door);
      if (d >= 0) v += s.n / (1 + d / 4);
    }
    trafficCache.set(t, v);
  }
  return v;
}

/** Expose the unit cap for tests. */
export const AI_UNIT_CAP = UNIT_CAP;
export { CHARTERS, CIVICS };
