// RESOLVE_TURN: one pure resolution, in a fixed order.
//   1 Movement → 2 Combat → 3 Production & buildings → 4 Treasury & upkeep → 5 Events & victory
// Every step walks the Houses in Initiative order (rotating each turn), then unit or lot id, then
// order sequence. Nothing depends on message arrival, wall-clock time or object iteration order.
import {
  ARCHETYPES,
  ARCHS,
  ARCH_MIX,
  AUTO_RESTOCK_AT,
  AUTO_RESTOCK_PREMIUM,
  BARGE_DISCOUNT,
  BLOCKADE_MULT,
  CANAL_APPEAL,
  CANAL_APPEAL_BISTRO,
  CHARTERS,
  CHRONICLE_KEEP,
  CIVICS,
  CONTRACT_TURNS,
  CORNER_PULL,
  CRITIC_PRESTIGE,
  CRITIC_PRIZE,
  CRUISE_TOURISTS,
  DAY_DEMAND,
  DAYPART_NAMES,
  DEFEND_BONUS,
  ERAS,
  ERA_POP,
  ERA_UNLOCK,
  EVENTS,
  EVENT_KINDS,
  FORECAST_TURNS,
  HOUSES,
  LEAD_MARGIN,
  LEVEL_APPEAL,
  LEVEL_CAP,
  LOAN_MAX,
  LOAN_RATE,
  LOAN_STEP,
  LOCKED_DESIRE,
  MILESTONES,
  MILESTONE_CIVICS,
  MILESTONE_PRESTIGE,
  MILESTONE_PROPERTIES,
  MILESTONE_SERVED,
  MILESTONE_SHARE,
  MILESTONE_SOVEREIGN_ERA,
  MILESTONE_WORTH,
  PACTS,
  PARK_AURA,
  PLAZA_AURA,
  AURA_MAX,
  PAYROLLS_PER_TURN,
  PROMO_COOLDOWN,
  PROMO_DESIRE,
  PROMO_PULL,
  PROMO_TURNS,
  RENT_HIKE,
  RESTOCK_BATCH,
  ROUTE_FEE,
  SALVAGE,
  SHOPS,
  SHOP_START_STOCK,
  STANCES,
  STUDIES,
  STUDY_COST,
  TRANSIT_PULL,
  TRANSIT_RADIUS,
  UNITS,
  UNIT_CAP,
  auraRadius,
  isCivic,
  isShop,
  CHARTER_KEYS,
} from './constants';
import {
  LAND_SPAWN,
  WATER_SPAWN,
  buildCostFor,
  buildingAt,
  buildingById,
  charterMult,
  cloneGame,
  computeStandings,
  contractCostFor,
  currentEra,
  daypartOf,
  emptyLost,
  eraOfTurn,
  finalTurn,
  hasStudy,
  isActiveEvent,
  isCouncilTurn,
  maxCohesion,
  moveOf,
  netWorth,
  pactBetween,
  promoCostFor,
  restockCostFor,
  stateHash,
  supplyMult,
  tileName,
  unitAt,
  unitById,
  upgradeCostFor,
} from './game';
import { shortHash } from './hash';
import { CITY, chebyshev, manhattan, walkDist } from './map';
import { defends, pathFor, pruneDraft, routeDistance, routeTiles } from './orders';
import { planAI } from './ai';
import { stream } from './rng';
import type {
  Archetype,
  Building,
  CashRecon,
  CharterKey,
  DispatchCat,
  Game,
  Honour,
  Order,
  Player,
  SummaryLine,
  SummarySection,
  TurnSummary,
  Unit,
} from './types';

export interface Resolution {
  game: Game;
  summary: TurnSummary;
  /** The canonical orders that were applied, per player. */
  committed: Order[][];
}

const money = (n: number): string => `§${Math.abs(n).toLocaleString('en-US')}`;
const signed = (n: number): string => `${n < 0 ? '−' : '+'}${money(n)}`;

/**
 * Canonical orders for a turn: humans' drafts validated against the frozen state (anything that
 * does not hold is dropped), AI orders as a pure function of seed and state.
 */
export function canonicalOrders(g: Game, drafts: (Order[] | null | undefined)[]): Order[][] {
  return g.players.map((p, i) => {
    if (p.kind === 'ai') return pruneDraft(g, i, planAI(g, i)).kept;
    const kept = pruneDraft(g, i, drafts[i] ?? []).kept;
    // A human who somehow reaches a Council turn without a Charter takes the first offered; the
    // authority and the clients never allow that (End Turn stays unavailable).
    if (isCouncilTurn(g, g.turn) && g.council && !kept.some((o) => o.t === 'charter')) {
      kept.unshift({ t: 'charter', key: g.council.offers[i][0] });
    }
    return kept;
  });
}

/** Resolve Turn N → N+1. `orders` are canonical (see canonicalOrders); they are re-validated. */
export function resolveTurn(game: Game, orders: Order[][]): Resolution {
  if (game.phase === 'ended') throw new Error('The match is over');
  const g = cloneGame(game);
  const T = g.turn;
  const n = g.players.length;
  const committed = g.players.map((_, i) => pruneDraft(game, i, orders[i] ?? []).kept);

  // Initiative: the first House is seat ((N − 1) mod seats) + 1.
  const first = (T - 1) % n;
  const init = Array.from({ length: n }, (_, k) => (first + k) % n);
  const rank = new Map<number, number>(init.map((p, k) => [p, k]));

  const lines: SummaryLine[] = [];
  let marker = 0;
  const say = (section: SummarySection, text: string, value = '', player = -1, tile = -1): void => {
    lines.push({ n: tile >= 0 ? ++marker : 0, section, text, value, player, tile });
  };
  const hn = (p: number): string => HOUSES[g.players[p].house].short;
  const headlines: string[] = [];

  const income = g.players.map(() => 0);
  const costs = g.players.map(() => 0);
  const upkeep = g.players.map(() => 0);
  const financing = g.players.map(() => 0);
  const opening = g.players.map((p) => p.cash);
  const feeIncome = g.players.map(() => 0);
  const salesTurn = g.players.map(() => 0);

  const dispatch = (cat: DispatchCat, head: string, pill: string, player = -1, tile = -1): void => {
    g.chronicle.push({ n: ++g.dispatchN, turn: T, cat, head, pill, player, tile });
    if (g.chronicle.length > CHRONICLE_KEEP) g.chronicle.splice(0, g.chronicle.length - CHRONICLE_KEEP);
  };
  const spend = (p: Player, amount: number): void => {
    p.cash -= amount;
    costs[p.id] += amount;
  };

  type Entry<O extends Order = Order> = { p: number; o: O; seq: number };
  const entries: Entry[] = [];
  committed.forEach((list, p) => list.forEach((o, seq) => entries.push({ p, o, seq })));
  const of = <K extends Order['t']>(...types: K[]): Entry<Extract<Order, { t: K }>>[] =>
    entries.filter((e) => (types as string[]).includes(e.o.t)) as Entry<Extract<Order, { t: K }>>[];
  const sortBy = <O extends Order>(list: Entry<O>[], key: (e: Entry<O>) => number): Entry<O>[] =>
    list.slice().sort((a, b) => rank.get(a.p)! - rank.get(b.p)! || key(a) - key(b) || a.seq - b.seq);

  for (const u of g.units) u.fought = false;

  // ── Charters apply from the Movement step ──
  for (const e of sortBy(of('charter'), () => 0)) {
    const p = g.players[e.p];
    if (p.charters.includes(e.o.key)) continue;
    p.charters.push(e.o.key);
    const c = CHARTERS[e.o.key];
    p.prestige += c.adoptPrestige;
    say('movement', `${hn(e.p)} adopts ${c.name}`, c.pill, e.p);
    dispatch('charter', `${hn(e.p)} adopts ${c.name}`, c.pill, e.p);
  }

  // ───────────── 1. Movement ─────────────
  for (const e of sortBy(of('move'), (x) => (x.o as { unit: number }).unit)) {
    const u = unitById(g, e.o.unit);
    if (!u || u.owner !== e.p) continue;
    const p = g.players[e.p];
    const path = pathFor(u.kind, u.tile, e.o.to);
    const name = `${hn(e.p)} ${UNITS[u.kind].name} #${u.id}`;
    if (!path || path.length > moveOf(p, u.kind)) {
      say('movement', `${name}: ${tileName(u.tile)} → ${tileName(e.o.to)} no longer legal`, 'Failed', e.p, u.tile);
      continue;
    }
    const from = u.tile;
    // Prefer a route around rival units; otherwise walk the straight route and halt where it is held.
    const rivals = new Set(g.units.filter((x) => x.owner !== u.owner).map((x) => x.tile));
    const around = pathFor(u.kind, u.tile, e.o.to, rivals);
    const walkPath = around && around.length <= moveOf(p, u.kind) ? around : path;
    let blockedAt = -1;
    for (let k = 0; k < walkPath.length; k++) {
      const t = walkPath[k];
      const held = unitAt(g, t);
      if (held && (held.owner !== u.owner || k === walkPath.length - 1)) {
        blockedAt = t;
        break;
      }
      u.tile = t;
    }
    if (blockedAt < 0 && unitAt(g, u.tile)?.id !== u.id) blockedAt = u.tile;
    if (blockedAt >= 0) say('movement', `${name} halted at ${tileName(u.tile)}, ${tileName(blockedAt)} is held`, 'Blocked', e.p, u.tile);
    else say('movement', `${name}: ${tileName(from)} → ${tileName(u.tile)}`, `${path.length} tile${path.length === 1 ? '' : 's'}`, e.p, u.tile);
  }

  // ───────────── 2. Combat ─────────────
  const disband = (u: Unit, why: string): void => {
    g.units = g.units.filter((x) => x.id !== u.id);
    say('combat', `${hn(u.owner)} ${UNITS[u.kind].name} #${u.id} disbanded${why ? ` — ${why}` : ''}`, 'Lost', u.owner, u.tile);
  };
  for (const e of sortBy(of('contest'), (x) => (x.o as { unit: number }).unit)) {
    const a = unitById(g, e.o.unit);
    const d = unitById(g, e.o.target);
    if (!a || a.owner !== e.p || a.kind !== 'watch') continue;
    if (!d || d.owner === e.p) {
      say('combat', `${hn(e.p)} Watch #${e.o.unit}: target gone, Contest refunded`, 'Failed', e.p);
      continue;
    }
    if (chebyshev(a.tile, d.tile) > 1 || pactBetween(g, e.p, d.owner, 'truce', T)) {
      say('combat', `${hn(e.p)} Watch #${a.id}: ${UNITS[d.kind].name} #${d.id} out of reach, Contest refunded`, 'Failed', e.p, a.tile);
      continue;
    }
    const deal = UNITS[a.kind].strength;
    d.cohesion -= deal;
    a.fought = true;
    d.fought = true;
    let back = 0;
    if (d.cohesion > 0) {
      back = UNITS[d.kind].strength + (defends(g, d) ? DEFEND_BONUS : 0);
      a.cohesion -= back;
    }
    say('combat', `${hn(e.p)} Watch #${a.id} contests ${hn(d.owner)} ${UNITS[d.kind].name} #${d.id}`, `−${deal} / −${back}`, e.p, d.tile);
    dispatch('contest', `${hn(e.p)} contests ${hn(d.owner)} at ${tileName(d.tile)}`, `${deal} dealt · ${back} taken`, e.p, d.tile);
    if (d.cohesion <= 0) disband(d, 'Cohesion spent');
    if (a.cohesion <= 0) disband(a, 'Cohesion spent');
  }

  // ───────────── 3. Production & buildings ─────────────
  // 3a borrow and repay
  for (const e of sortBy(of('borrow', 'repay'), () => 0)) {
    const p = g.players[e.p];
    if (e.o.t === 'borrow') {
      if (p.debt + LOAN_STEP > LOAN_MAX) continue;
      p.cash += LOAN_STEP;
      p.debt += LOAN_STEP;
      financing[e.p] += LOAN_STEP;
      say('production', `${hn(e.p)} borrows from the Credit Line`, signed(LOAN_STEP), e.p);
    } else {
      const amt = Math.min(LOAN_STEP, p.debt);
      if (amt <= 0 || amt > p.cash) continue;
      p.cash -= amt;
      p.debt -= amt;
      financing[e.p] -= amt;
      say('production', `${hn(e.p)} repays the Credit Line`, signed(-amt), e.p);
    }
  }

  // 3b construction, recruits, upgrades, sales
  const buildKey = (x: Entry<Extract<Order, { t: 'build' | 'upgrade' | 'sell' | 'recruit' }>>): number => {
    const o = x.o;
    if (o.t === 'build') return o.tile;
    if (o.t === 'recruit') return 1000 + ['factor', 'watch', 'barge'].indexOf(o.kind);
    return 200 + o.building;
  };
  const reachOk = (owner: number, tile: number): boolean => {
    for (const b of g.buildings) if (b.owner === owner && manhattan(b.tile, tile) === 1) return true;
    for (const u of g.units) if (u.owner === owner && u.kind === 'factor' && chebyshev(u.tile, tile) <= 1) return true;
    return false;
  };
  for (const e of sortBy(of('build', 'upgrade', 'sell', 'recruit'), buildKey)) {
    const p = g.players[e.p];
    const o = e.o;
    if (o.t === 'build') {
      const taken = buildingAt(g, o.tile);
      if (taken) {
        say('production', `${hn(e.p)} ${isShop(o.kind) ? SHOPS[o.kind].name : CIVICS[o.kind].name} at ${tileName(o.tile)}: lot taken by ${hn(taken.owner)}, refunded`, 'Refunded', e.p, o.tile);
        continue;
      }
      const cost = buildCostFor(p, o.kind);
      if (!reachOk(e.p, o.tile) || cost > p.cash || ERA_UNLOCK[o.kind] > currentEra(g)) {
        say('production', `${hn(e.p)} build at ${tileName(o.tile)} no longer legal, refunded`, 'Refunded', e.p, o.tile);
        continue;
      }
      spend(p, cost);
      const b: Building = {
        id: g.nextId++,
        tile: o.tile,
        kind: o.kind,
        owner: e.p,
        level: 1,
        stance: 1,
        stock: isShop(o.kind) ? Math.ceil(SHOP_START_STOCK * SHOPS[o.kind].stockMax) : 0,
        auto: false,
        promoUntil: 0,
        promoReady: 0,
        contractUntil: 0,
        invested: cost,
        builtTurn: T,
        lastSales: 0,
        lastServed: 0,
        lastLost: emptyLost(),
        lastArch: [0, 0, 0, 0, 0],
        lastRiders: 0,
        lastBoosted: 0,
        lastBoostedSales: 0,
        carry: 0,
        served: 0,
        revenue: 0,
      };
      g.buildings.push(b);
      p.stats.built++;
      const name = isShop(o.kind) ? SHOPS[o.kind].name : CIVICS[o.kind].name;
      if (isCivic(o.kind)) {
        p.stats.civicBuilt++;
        p.prestige += Math.round(CIVICS[o.kind].prestige * charterMult(p, 'civicPrestige'));
      }
      say('production', `${hn(e.p)} completes ${name} at ${tileName(o.tile)}`, signed(-cost), e.p, o.tile);
      dispatch('build', `${hn(e.p)} opens a ${name} at ${tileName(o.tile)}`, signed(-cost), e.p, o.tile);
    } else if (o.t === 'recruit') {
      const def = UNITS[o.kind];
      const count = g.units.filter((u) => u.owner === e.p).length;
      const spawn = (o.kind === 'barge' ? WATER_SPAWN : LAND_SPAWN).find((t) => !unitAt(g, t));
      if (count >= UNIT_CAP || def.cost > p.cash || spawn === undefined || def.era > currentEra(g)) {
        say('production', `${hn(e.p)} ${def.name} recruit failed, refunded`, 'Refunded', e.p);
        continue;
      }
      spend(p, def.cost);
      g.units.push({ id: g.nextId++, owner: e.p, kind: o.kind, tile: spawn, cohesion: maxCohesion(p, o.kind), route: 0, fought: false });
      say('production', `${hn(e.p)} recruits a ${def.name} at ${tileName(spawn)}`, signed(-def.cost), e.p, spawn);
    } else if (o.t === 'upgrade') {
      const b = buildingById(g, o.building);
      if (!b || b.owner !== e.p || b.level >= 3) continue;
      const cost = upgradeCostFor(p, b);
      if (cost > p.cash || (b.level + 1 >= 3 && currentEra(g) < 3)) {
        say('production', `${hn(e.p)} upgrade at ${tileName(b.tile)} no longer legal, refunded`, 'Refunded', e.p, b.tile);
        continue;
      }
      spend(p, cost);
      b.level++;
      b.invested += cost;
      if (b.level === 3 && hasStudy(p, 'facades')) p.prestige += 2;
      say('production', `${hn(e.p)} upgrades ${SHOPS[b.kind as keyof typeof SHOPS]?.name ?? 'shop'} at ${tileName(b.tile)} to Level ${b.level}`, signed(-cost), e.p, b.tile);
    } else {
      const b = buildingById(g, o.building);
      if (!b || b.owner !== e.p) continue;
      const proceeds = Math.floor(SALVAGE * b.invested);
      p.cash += proceeds;
      income[e.p] += proceeds;
      g.buildings = g.buildings.filter((x) => x.id !== b.id);
      for (const u of g.units) if (u.route === b.id) u.route = 0;
      say('production', `${hn(e.p)} sells property at ${tileName(b.tile)} for 60% of invested`, signed(proceeds), e.p, b.tile);
    }
  }

  // 3c Barge routes and deliveries
  for (const e of sortBy(of('route'), (x) => (x.o as { unit: number }).unit)) {
    const u = unitById(g, e.o.unit);
    const b = buildingById(g, e.o.building);
    if (u && b && u.owner === e.p && u.kind === 'barge' && b.owner === e.p && isShop(b.kind) && CITY.canalFront[b.tile]) u.route = b.id;
  }
  for (const pid of init) {
    const p = g.players[pid];
    for (const u of g.units.filter((x) => x.owner === pid && x.kind === 'barge' && x.route > 0).sort((a, b) => a.id - b.id)) {
      const shop = buildingById(g, u.route);
      if (!shop || shop.owner !== pid) {
        u.route = 0;
        continue;
      }
      const d = routeDistance(shop.tile);
      if (d < 0 || d > 3 * moveOf(p, 'barge')) {
        u.route = 0;
        continue;
      }
      const path = routeTiles(shop.tile);
      const blocker = g.units.find((x) => x.owner !== pid && path.includes(x.tile) && !pactBetween(g, pid, x.owner, 'truce', T));
      if (blocker) {
        say('production', `${hn(pid)} Barge #${u.id} blocked by ${hn(blocker.owner)} at ${tileName(blocker.tile)}, no delivery`, 'Blocked', pid, blocker.tile);
        continue;
      }
      const def = SHOPS[shop.kind as keyof typeof SHOPS];
      const room = Math.max(0, def.stockMax - shop.stock);
      const units = Math.min(RESTOCK_BATCH, room);
      const unitPrice = def.unitCost * BARGE_DISCOUNT * charterMult(p, 'supplies');
      const affordable = Math.min(units, unitPrice > 0 ? Math.floor(p.cash / unitPrice) : units);
      const cost = Math.round(affordable * unitPrice);
      spend(p, cost);
      shop.stock += affordable;
      let fee = ROUTE_FEE * (hasStudy(p, 'hydraulics') ? 1.5 : 1);
      if (g.players.some((q) => q.id !== pid && pactBetween(g, pid, q.id, 'trade', T))) fee *= 1.25;
      fee = Math.round(fee);
      feeIncome[pid] += fee;
      say('production', `${hn(pid)} Barge #${u.id} delivers ${affordable} supplies to ${tileName(shop.tile)} at 30% off`, signed(-cost), pid, shop.tile);
    }
  }

  // 3d Guild Studies
  for (const e of sortBy(of('study'), () => 0)) {
    const p = g.players[e.p];
    const def = STUDIES[e.o.key];
    if (!def || p.studies.includes(def.key) || def.era > currentEra(g) || STUDY_COST > p.cash || (p.study && p.study !== def.key)) continue;
    spend(p, STUDY_COST);
    p.study = def.key;
    p.studyPoints++;
    if (p.studyPoints >= def.points) {
      p.studies.push(def.key);
      p.study = null;
      p.studyPoints = 0;
      if (def.key === 'drill') for (const u of g.units) if (u.owner === e.p && u.kind === 'watch') u.cohesion += 1;
      say('production', `${hn(e.p)} completes ${def.name}: ${def.perk}`, signed(-STUDY_COST), e.p);
      dispatch('market', `${hn(e.p)} completes ${def.name}`, def.perk, e.p);
    } else {
      say('production', `${hn(e.p)} studies ${def.name} (${p.studyPoints} of ${def.points})`, signed(-STUDY_COST), e.p);
    }
  }

  // 3e Pacts: proposals are delivered; accepted pacts take effect
  for (const e of sortBy(of('propose'), (x) => (x.o as { to: number }).to)) {
    g.proposals.push({ id: g.nextId++, kind: e.o.kind, from: e.p, to: e.o.to, turn: T });
    say('production', `${hn(e.p)} proposes a ${PACTS[e.o.kind].name} to ${hn(e.o.to)}`, 'Proposed', e.p);
  }
  for (const e of sortBy(of('respond'), (x) => (x.o as { proposal: number }).proposal)) {
    const q = g.proposals.find((x) => x.id === e.o.proposal);
    if (!q || q.to !== e.p) continue;
    g.proposals = g.proposals.filter((x) => x.id !== q.id);
    if (e.o.accept) {
      const def = PACTS[q.kind];
      g.pacts.push({ id: g.nextId++, kind: q.kind, a: q.from, b: q.to, from: T, to: T + def.turns - 1 });
      say('production', `${hn(q.to)} accepts ${hn(q.from)}'s ${def.name}`, `${def.turns} turns`, e.p);
      dispatch('pact', `${hn(q.from)} and ${hn(q.to)} sign a ${def.name}`, def.effect, q.to);
    } else {
      say('production', `${hn(q.to)} declines ${hn(q.from)}'s ${PACTS[q.kind].name}`, 'Declined', e.p);
    }
  }

  // 3f Commercial orders
  const commercial = of('stance', 'restock', 'auto', 'promo', 'contract') as Entry<Extract<Order, { t: 'stance' | 'restock' | 'auto' | 'promo' | 'contract' }>>[];
  for (const e of sortBy(commercial, (x) => (x.o as { building: number }).building)) {
    const p = g.players[e.p];
    const b = buildingById(g, e.o.building);
    if (!b || b.owner !== e.p || !isShop(b.kind)) continue;
    const o = e.o;
    if (o.t === 'stance') {
      if (o.stance >= 0 && o.stance <= 3) {
        b.stance = o.stance;
        say('production', `${hn(e.p)} prices ${tileName(b.tile)} at ${STANCES[o.stance].name}`, STANCES[o.stance].label, e.p, b.tile);
      }
    } else if (o.t === 'auto') {
      b.auto = o.on;
      say('production', `${hn(e.p)} turns Auto-Restock ${o.on ? 'on' : 'off'} at ${tileName(b.tile)}`, o.on ? 'On' : 'Off', e.p, b.tile);
    } else if (o.t === 'restock') {
      const cost = restockCostFor(g, p, b);
      if (cost > p.cash || b.stock >= SHOPS[b.kind].stockMax) {
        say('production', `${hn(e.p)} restock at ${tileName(b.tile)} failed, refunded`, 'Refunded', e.p, b.tile);
        continue;
      }
      spend(p, cost);
      b.stock = SHOPS[b.kind].stockMax;
      say('production', `${hn(e.p)} restocks ${tileName(b.tile)}`, signed(-cost), e.p, b.tile);
    } else if (o.t === 'contract') {
      const cost = contractCostFor(p, b);
      if (cost > p.cash || b.contractUntil >= T) {
        say('production', `${hn(e.p)} supply contract at ${tileName(b.tile)} failed, refunded`, 'Refunded', e.p, b.tile);
        continue;
      }
      spend(p, cost);
      b.stock = Math.min(SHOPS[b.kind].stockMax, b.stock + RESTOCK_BATCH);
      b.contractUntil = T + CONTRACT_TURNS - 1;
      say('production', `${hn(e.p)} signs a ${CONTRACT_TURNS}-turn Harbor supply contract at ${tileName(b.tile)}`, signed(-cost), e.p, b.tile);
    } else {
      const cost = promoCostFor(p);
      if (cost > p.cash || b.promoUntil >= T || b.promoReady > T) {
        say('production', `${hn(e.p)} Promo Blitz at ${tileName(b.tile)} failed, refunded`, 'Refunded', e.p, b.tile);
        continue;
      }
      spend(p, cost);
      b.promoUntil = T + PROMO_TURNS - 1;
      b.promoReady = b.promoUntil + 1 + Math.ceil(PROMO_COOLDOWN * charterMult(p, 'promoCooldown'));
      p.stats.promos++;
      say('production', `${hn(e.p)} fires a Promo Blitz at ${tileName(b.tile)}`, signed(-cost), e.p, b.tile);
      dispatch('promo', `${hn(e.p)} fires a Promo Blitz at ${tileName(b.tile)}`, `Pull ×${PROMO_PULL} · ${PROMO_TURNS} turns`, e.p, b.tile);
    }
  }

  // 3g Footfall → sales
  footfall();

  // ───────────── 4. Treasury & upkeep ─────────────
  for (const pid of init) {
    const p = g.players[pid];
    const sales = salesTurn[pid];
    if (sales) say('treasury', `${hn(pid)} sales`, signed(sales), pid);
    p.cash += sales;
    income[pid] += sales;
    if (feeIncome[pid]) {
      p.cash += feeIncome[pid];
      income[pid] += feeIncome[pid];
      say('treasury', `${hn(pid)} Barge route fees`, signed(feeIncome[pid]), pid);
    }
    if (p.dividend) {
      p.cash += p.dividend;
      income[pid] += p.dividend;
      say('treasury', `${hn(pid)} dividends`, signed(p.dividend), pid);
      p.dividend = 0;
    }
    // Charges, recomputed as property is sold off to cover them.
    const charges = (): { wages: number; rent: number; units: number; interest: number } => {
      const mine = g.buildings.filter((b) => b.owner === pid);
      let wages = 0;
      let rent = 0;
      for (const b of mine) {
        if (isShop(b.kind)) {
          wages += SHOPS[b.kind].wage * PAYROLLS_PER_TURN;
          rent += SHOPS[b.kind].rent * PAYROLLS_PER_TURN;
        } else rent += CIVICS[b.kind].rent * PAYROLLS_PER_TURN;
      }
      wages *= charterMult(p, 'wages') * (hasStudy(p, 'ledger') ? 0.9 : 1);
      rent *= (isActiveEvent(g, 'renthike', T) ? RENT_HIKE : 1) * (hasStudy(p, 'ledger') ? 0.9 : 1);
      const units = g.units.filter((u) => u.owner === pid).reduce((a, u) => a + UNITS[u.kind].upkeep, 0);
      return { wages: Math.round(wages), rent: Math.round(rent), units, interest: Math.ceil(p.debt * LOAN_RATE * charterMult(p, 'interest')) };
    };
    let c = charges();
    let due = c.wages + c.rent + c.units + c.interest;
    if (p.cash < due) {
      const need = due - p.cash;
      const draw = Math.min(need, LOAN_MAX - p.debt);
      if (draw > 0) {
        p.debt += draw;
        p.cash += draw;
        financing[pid] += draw;
        say('treasury', `${hn(pid)} draws on the Credit Line to cover upkeep`, signed(draw), pid);
      }
      // Credit exhausted: sell property at 60% in order of lowest yield, then disband units.
      while (p.cash < due) {
        const mine = g.buildings.filter((b) => b.owner === pid).sort((a, b) => a.lastSales / Math.max(1, a.invested) - b.lastSales / Math.max(1, b.invested) || a.id - b.id);
        if (mine.length) {
          const b = mine[0];
          const proceeds = Math.floor(SALVAGE * b.invested);
          p.cash += proceeds;
          income[pid] += proceeds;
          g.buildings = g.buildings.filter((x) => x.id !== b.id);
          for (const u of g.units) if (u.route === b.id) u.route = 0;
          say('treasury', `${hn(pid)} forced to sell property at ${tileName(b.tile)}`, signed(proceeds), pid, b.tile);
        } else {
          const units = g.units.filter((u) => u.owner === pid).sort((a, b) => UNITS[b.kind].upkeep - UNITS[a.kind].upkeep || a.id - b.id);
          if (!units.length) break;
          disband(units[0], 'upkeep unpaid');
        }
        c = charges();
        due = c.wages + c.rent + c.units + c.interest;
      }
      if (p.cash < due) {
        const forgiven = due - p.cash;
        p.cash += forgiven;
        financing[pid] += forgiven;
        say('treasury', `${hn(pid)} shortfall forgiven`, signed(forgiven), pid);
      }
    }
    p.cash -= due;
    upkeep[pid] += due;
    if (c.wages) say('treasury', `${hn(pid)} wages`, signed(-c.wages), pid);
    if (c.rent) say('treasury', `${hn(pid)} rent`, signed(-c.rent), pid);
    if (c.units) say('treasury', `${hn(pid)} unit upkeep`, signed(-c.units), pid);
    if (c.interest) say('treasury', `${hn(pid)} loan interest`, signed(-c.interest), pid);
    // Auto-Restock: only what the cash on hand covers.
    for (const b of g.buildings.filter((x) => x.owner === pid && isShop(x.kind) && x.auto).sort((a, b2) => a.id - b2.id)) {
      const def = SHOPS[b.kind as keyof typeof SHOPS];
      if (b.stock >= def.stockMax * AUTO_RESTOCK_AT) continue;
      const premium = p.charters.some((k) => !CHARTERS[k].autoPremium) || b.contractUntil >= T ? 1 : AUTO_RESTOCK_PREMIUM;
      const per = def.unitCost * supplyMult(g, p, b) * premium;
      const units = Math.min(def.stockMax - b.stock, Math.floor(p.cash / Math.max(0.01, per)));
      if (units <= 0) continue;
      const cost = Math.round(units * per);
      p.cash -= cost;
      costs[pid] += cost;
      b.stock += units;
      say('treasury', `${hn(pid)} auto-restocks ${tileName(b.tile)}`, signed(-cost), pid, b.tile);
    }
  }

  // ───────────── 5. Events & victory ─────────────
  // Sales window
  g.players.forEach((p, i) => {
    p.sales.push(salesTurn[i]);
    if (p.sales.length > 4) p.sales.shift();
  });
  // Cohesion regain
  for (const u of g.units) {
    const max = maxCohesion(g.players[u.owner], u.kind);
    if (!u.fought && u.cohesion < max && g.buildings.some((b) => b.owner === u.owner && manhattan(b.tile, u.tile) === 1)) u.cohesion++;
  }
  // Pacts and proposals expire
  for (const pt of g.pacts.filter((x) => x.to <= T)) say('events', `${hn(pt.a)} and ${hn(pt.b)}: ${PACTS[pt.kind].name} expires`, 'Expired', pt.a);
  g.pacts = g.pacts.filter((x) => x.to > T);
  for (const q of g.proposals.filter((x) => x.turn < T)) say('events', `${hn(q.from)}'s ${PACTS[q.kind].name} to ${hn(q.to)} expires unanswered`, 'Expired', q.from);
  g.proposals = g.proposals.filter((x) => x.turn >= T);

  // Events: critic prize, closing receipts, starts, forecast
  for (const ev of g.events) {
    const def = EVENTS[ev.kind];
    if (ev.kind === 'critic' && ev.start <= T && T <= ev.end) {
      const rated = g.buildings.filter((b) => (b.kind === 'bistro' || b.kind === 'roastery') && b.lastSales > 0).sort((a, b) => b.lastSales * b.level - a.lastSales * a.level || a.id - b.id)[0];
      if (rated) {
        g.players[rated.owner].dividend += CRITIC_PRIZE;
        g.players[rated.owner].prestige += CRITIC_PRESTIGE;
        say('events', `Food Critic awards the Golden Fork to ${hn(rated.owner)} at ${tileName(rated.tile)}`, `+§${CRITIC_PRIZE}`, rated.owner, rated.tile);
        dispatch('event', `Golden Fork: ${hn(rated.owner)}`, `+§${CRITIC_PRIZE} next turn`, rated.owner, rated.tile);
      }
    }
    if (ev.end === T) say('events', `${def.title} ends`, def.pill);
    if (ev.start === T + 1) {
      say('events', `${def.title} begins next turn`, def.pill);
      dispatch('event', def.headline, def.pill);
    }
  }
  g.events = g.events.filter((e) => e.end > T);
  if (T >= 2 && !g.events.length) {
    const r = stream(g.seed, T, 'events');
    if (r.next() < 0.45) {
      const kind = EVENT_KINDS[r.int(EVENT_KINDS.length)];
      const len = kind === 'renthike' ? 3 : kind === 'cruise' || kind === 'supplycrunch' ? 2 : 1;
      const start = T + 1 + FORECAST_TURNS;
      g.events.push({ kind, announced: T, start, end: start + len - 1 });
      say('events', `Forecast: ${EVENTS[kind].title} on Turn ${start}`, EVENTS[kind].pill);
      dispatch('event', EVENTS[kind].forecast, `Turn ${start}`);
    }
  }

  // Milestones, standings
  const standings0 = computeStandings(g);
  const shareOf = (p: number): number => standings0.find((s) => s.player === p)?.share ?? 0;
  const era = eraOfTurn(g, T);
  g.players.forEach((p, i) => {
    const props = g.buildings.filter((b) => b.owner === i);
    const checks = [
      p.stats.served >= MILESTONE_SERVED,
      props.length >= MILESTONE_PROPERTIES || props.some((b) => props.some((c) => c.id !== b.id && manhattan(b.tile, c.tile) === 1)),
      p.stats.civicBuilt >= MILESTONE_CIVICS || p.prestige >= MILESTONE_PRESTIGE,
      era >= MILESTONE_SOVEREIGN_ERA && (netWorth(g, p) >= MILESTONE_WORTH || shareOf(i) >= MILESTONE_SHARE * 100),
    ];
    checks.forEach((ok, m) => {
      if (!ok || p.milestones[m] > 0) return;
      p.milestones[m] = T;
      const def = MILESTONES[m];
      p.dividend += def.cash;
      p.prestige += def.prestige;
      say('events', `${hn(i)} earns ${def.name}`, def.pill, i);
      dispatch('milestone', `${hn(i)} earns ${def.name}`, `${def.pill} · ★${p.milestones.filter((x) => x > 0).length}`, i);
      headlines.push(`${hn(i)} earns ${def.name}`);
    });
  });

  const standings = computeStandings(g);
  const prev = game.standings;
  g.standings = standings;
  g.trend.push({
    turn: T,
    era,
    share: g.players.map((_, i) => standings.find((s) => s.player === i)!.share),
    crown: g.players.map((_, i) => standings.find((s) => s.player === i)!.crown),
  });
  for (const s of standings) {
    const before = prev.find((x) => x.player === s.player);
    const d = s.crown - (before?.crown ?? 0);
    say('events', `${hn(s.player)} Crown Index ${s.crown}`, `${d >= 0 ? '+' : '−'}${Math.abs(d)} · ${s.worthComponent} + ${s.shareComponent} + ${s.prestigeComponent}`, s.player);
  }
  const top = standings[0];
  if (top && top.player !== g.leader && (g.leader < 0 || top.crown - (standings.find((s) => s.player === g.leader)?.crown ?? 0) >= LEAD_MARGIN) && T > 1) {
    dispatch('lead', `${hn(top.player)} takes the lead`, `Crown ${top.crown}`, top.player);
    headlines.push(`${hn(top.player)} takes the lead`);
    g.leader = top.player;
  } else if (g.leader < 0 && top) g.leader = top.player;

  // Advance the calendar
  g.turn = T + 1;
  const newEra = eraOfTurn(g, g.turn);
  g.council = null;
  if (g.turn <= finalTurn(g) && newEra > era) {
    const e = ERAS[newEra - 1];
    say('events', `Era ${e.roman} begins — ${e.name}`, e.blurb);
    dispatch('era', `Era ${e.roman}: ${e.name}`, e.blurb);
    headlines.unshift(`Era ${e.roman}: ${e.name}`);
  }
  if (!g.endless && T >= finalTurn(g)) {
    g.phase = 'ended';
    g.winner = standings[0].player;
    g.honours = honours(g);
    dispatch('lead', `${hn(g.winner)} wins the Crown`, `Crown ${standings[0].crown}`, g.winner);
    headlines.unshift('The Mercadia Gazette — Final Edition');
    say('events', `${hn(g.winner)} wins the Dynasty`, `Crown ${standings[0].crown}`, g.winner);
  } else if (isCouncilTurn(g, g.turn)) {
    const offers: CharterKey[][] = g.players.map((p, i) => {
      const r = stream(g.seed, g.turn, `council:${i}`);
      const pool = CHARTER_KEYS.filter((k) => !p.charters.includes(k));
      const out: CharterKey[] = [];
      while (out.length < 3 && pool.length) out.push(pool.splice(r.int(pool.length), 1)[0]);
      return out;
    });
    g.council = { era: newEra, offers };
  }

  const cash: CashRecon[] = g.players.map((p, i) => ({
    player: i,
    opening: opening[i],
    income: income[i],
    costs: costs[i],
    upkeep: upkeep[i],
    financing: financing[i],
    closing: p.cash,
  }));
  for (const c of cash) say('treasury', `${hn(c.player)}: Opening ${money(c.opening)} + Income ${money(c.income)} − Costs ${money(c.costs)} − Upkeep ${money(c.upkeep)} + Financing ${money(c.financing)} = Closing ${money(c.closing)}`, money(c.closing), c.player);

  const summary: TurnSummary = {
    from: T,
    to: g.turn,
    hash: shortHash(stateHash(g)),
    era: eraOfTurn(g, g.turn),
    headline: headlines[0] ?? '',
    lines,
    cash,
    standings,
    committed: committed.map((l) => l.length),
  };
  return { game: g, summary, committed };

  // ── Footfall: citizens are emitted per source for the turn's daypart, then allocated ──
  function footfall(): void {
    const dp = daypartOf(T);
    const eraIdx = currentEra(g) - 1;
    const rng = stream(g.seed, T, 'footfall');
    for (const b of g.buildings) {
      b.lastSales = 0;
      b.lastServed = 0;
      b.lastLost = emptyLost();
      b.lastArch = [0, 0, 0, 0, 0];
      b.lastRiders = 0;
      b.lastBoosted = 0;
      b.lastBoostedSales = 0;
    }
    const shops = g.buildings.filter((b) => isShop(b.kind)).sort((a, b) => a.id - b.id);
    if (!shops.length && !g.buildings.length) return;

    const eventDemand = (d: keyof typeof DAY_DEMAND): number => {
      let m = 1;
      for (const ev of g.events) if (ev.start <= T && T <= ev.end) m *= (EVENTS[ev.kind].demand as Record<string, number | undefined>)[d] ?? 1;
      return m;
    };

    // Per-shop attributes
    const priceOf = (b: Building): number => Math.max(1, Math.round(SHOPS[b.kind as keyof typeof SHOPS].price * STANCES[b.stance].mult));
    const capOf = (b: Building): number => {
      const d = SHOPS[b.kind as keyof typeof SHOPS];
      return Math.max(6, Math.round(((d.servers * 520) / d.serviceTicks) * LEVEL_CAP[b.level - 1]));
    };
    const civics = g.buildings.filter((b) => isCivic(b.kind));
    const stops = [...CITY.fixedStops, ...civics.filter((c) => c.kind === 'tramstop').map((c) => c.tile)];
    const shopInfo = new Map<number, { appeal: number; block: boolean; door: number; aura: Building[] }>();
    for (const b of shops) {
      const owner = g.players[b.owner];
      const kind = b.kind as keyof typeof SHOPS;
      let appeal = LEVEL_APPEAL[b.level - 1] * STANCES[b.stance].cachet * charterMult(owner, 'quality');
      if ((kind === 'roastery' || kind === 'bistro') && hasStudy(owner, 'roasting')) appeal *= 1.1;
      if (CITY.corner[b.tile]) appeal *= CORNER_PULL;
      const aura: Building[] = [];
      let auraSum = 0;
      for (const c of civics) {
        const r = auraRadius(c.kind);
        if (r > 0 && chebyshev(c.tile, b.tile) <= r) {
          auraSum += c.kind === 'plaza' ? PLAZA_AURA : PARK_AURA;
          aura.push(c);
        }
      }
      let frontage = 1;
      if (CITY.canalFront[b.tile]) frontage = kind === 'bistro' ? CANAL_APPEAL_BISTRO : CANAL_APPEAL;
      if (aura.some((c) => c.kind === 'plaza')) frontage = Math.max(frontage, 1) * 1;
      if (CITY.canalFront[b.tile] || aura.some((c) => c.kind === 'plaza')) frontage *= charterMult(owner, 'frontage');
      appeal *= (1 + Math.min(AURA_MAX, auraSum)) * frontage;
      if (stops.some((s) => chebyshev(s, b.tile) <= TRANSIT_RADIUS)) appeal *= TRANSIT_PULL;
      if (b.promoUntil >= T) appeal *= PROMO_PULL;
      if (g.buildings.some((o) => o.owner !== b.owner && isShop(o.kind) && manhattan(o.tile, b.tile) <= 2 && pactBetween(g, b.owner, o.owner, 'trade', T))) appeal *= 1.1;
      const door = CITY.door[b.tile];
      const block = g.units.some((u) => u.kind === 'watch' && u.owner !== b.owner && chebyshev(u.tile, door >= 0 ? door : b.tile) <= 1 && !pactBetween(g, u.owner, b.owner, 'truce', T));
      shopInfo.set(b.id, { appeal, block, door, aura });
    }

    // Sources
    interface Source { door: number; n: number; mix: number[]; owner: number; stop: Building | null }
    const era = ERA_POP[eraIdx];
    const baseMix = ARCH_MIX[dp];
    const mixOf = (mult: number[]): number[] => baseMix.map((w, i) => w * mult[i]);
    const sources: Source[] = [];
    CITY.homes.forEach((_, i) => sources.push({ door: CITY.homeDoors[i], n: Math.round(7 * era), mix: mixOf([1, 1.2, 1, 0.25, 1]), owner: -1, stop: null }));
    sources.push({ door: CITY.stationDoor, n: Math.round(16 * era), mix: mixOf([1.3, 0.7, 1, 2.5, 1]), owner: -1, stop: null });
    const cruise = isActiveEvent(g, 'cruise', T);
    sources.push({ door: CITY.pierTile, n: Math.round(10 * era) + (cruise ? CRUISE_TOURISTS : 0), mix: mixOf([0.6, 0.8, 1.5, cruise ? 6 : 3, 1]), owner: -1, stop: null });
    const free = isActiveEvent(g, 'freeride', T) ? 2 : 1;
    for (const t of CITY.fixedStops) sources.push({ door: t, n: Math.round(5 * era) * free, mix: mixOf([3, 1, 0.6, 0.6, 1]), owner: -1, stop: null });
    for (const c of civics.filter((x) => x.kind === 'tramstop').sort((a, b) => a.id - b.id)) {
      const door = CITY.door[c.tile] >= 0 ? CITY.door[c.tile] : c.tile;
      const riders = (6 + (hasStudy(g.players[c.owner], 'signalling') ? 2 : 0)) * free;
      c.lastRiders = riders;
      sources.push({ door, n: riders, mix: mixOf([3, 1, 0.6, 0.6, 1]), owner: c.owner, stop: c });
    }

    const shopDesires = new Set(shops.map((b) => SHOPS[b.kind as keyof typeof SHOPS].desire));
    const desireKeys = Object.keys(DAY_DEMAND) as (keyof typeof DAY_DEMAND)[];
    const served = new Map<number, number>();
    const aliveShops = shops;

    for (const s of sources) {
      for (let k = 0; k < s.n; k++) {
        const arch: Archetype = ARCHETYPES[rng.weighted(s.mix)];
        const ad = ARCHS[arch];
        const weights = desireKeys.map((d) => {
          const unlocked = Object.keys(SHOPS).some((sk) => SHOPS[sk as keyof typeof SHOPS].desire === d && ERA_UNLOCK[sk as keyof typeof SHOPS] <= currentEra(g));
          let w = ad.desires[d] * DAY_DEMAND[d][dp] * eventDemand(d) * (unlocked ? 1 : LOCKED_DESIRE);
          if (shops.some((b) => SHOPS[b.kind as keyof typeof SHOPS].desire === d && b.promoUntil >= T)) w *= PROMO_DESIRE;
          return w;
        });
        const desire = desireKeys[rng.weighted(weights)];
        const budget = Math.round(ad.budget[0] + rng.next() * (ad.budget[1] - ad.budget[0]));
        if (!shopDesires.has(desire)) continue;
        // Rank candidates
        const cands = aliveShops
          .filter((b) => SHOPS[b.kind as keyof typeof SHOPS].desire === desire)
          .map((b) => {
            const info = shopInfo.get(b.id)!;
            const dist = info.door >= 0 && s.door >= 0 ? walkDist(s.door, info.door) : -1;
            if (dist < 0 || dist > 18) return null;
            const price = priceOf(b);
            const base = Math.pow(info.appeal, ad.qlove) * Math.pow(Math.min(3, budget / price), ad.sens * 0.8) * (1 / (1 + dist / 6));
            return { b, price, free: base, score: info.block ? base * BLOCKADE_MULT : base, blocked: info.block };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .sort((a, b) => b.score - a.score || a.b.id - b.b.id);
        if (!cands.length) continue;
        const naturalTop = cands.slice().sort((a, b) => b.free - a.free || a.b.id - b.b.id)[0];
        let sold: (typeof cands)[number] | null = null;
        for (const c of cands) {
          if (c.price > budget) continue;
          if (c.b.stock <= 0) continue;
          if ((served.get(c.b.id) ?? 0) >= capOf(c.b)) continue;
          sold = c;
          break;
        }
        const top = cands[0];
        if (!sold) {
          const pl = g.players[top.b.owner];
          pl.stats.lost++;
          if (top.price > budget) top.b.lastLost.tooPricey++;
          else if (top.b.stock <= 0) top.b.lastLost.outOfStock++;
          else top.b.lastLost.queueFull++;
          if (naturalTop.blocked) naturalTop.b.lastLost.blockaded++;
          continue;
        }
        if (naturalTop.blocked && naturalTop.b.id !== sold.b.id) naturalTop.b.lastLost.blockaded++;
        const b = sold.b;
        const pl = g.players[b.owner];
        b.stock--;
        served.set(b.id, (served.get(b.id) ?? 0) + 1);
        b.lastSales += sold.price;
        b.lastServed++;
        b.lastArch[ARCHETYPES.indexOf(arch)]++;
        b.served++;
        b.revenue += sold.price;
        salesTurn[b.owner] += sold.price;
        pl.stats.served++;
        if (b.stance === 0) pl.stats.budgetSales += sold.price;
        if (CITY.corner[b.tile]) pl.stats.cornerRevenue += sold.price;
      }
    }

    // Civic contribution
    for (const c of civics.sort((a, b) => a.id - b.id)) {
      const owner = g.players[c.owner];
      if (c.kind === 'tramstop') {
        c.carry += c.lastRiders * 1.5 * charterMult(owner, 'civicPrestige');
      } else {
        const inAura = shops.filter((b) => shopInfo.get(b.id)!.aura.some((x) => x.id === c.id));
        c.lastBoosted = inAura.length;
        c.lastBoostedSales = inAura.reduce((a, b) => a + b.lastSales, 0);
        c.carry += (c.lastBoostedSales / 10) * charterMult(owner, 'civicPrestige');
      }
      const gain = Math.floor(c.carry / 25);
      if (gain > 0) {
        owner.prestige += gain;
        c.carry -= gain * 25;
      }
    }
  }
}

/** Match honours for the Final Edition. */
export function honours(g: Game): Honour[] {
  const best = (f: (p: Player) => number): number => {
    let bi = 0;
    g.players.forEach((p, i) => {
      if (f(p) > f(g.players[bi])) bi = i;
    });
    return bi;
  };
  const corner = best((p) => p.stats.cornerRevenue);
  const shark = best((p) => p.stats.budgetSales);
  const patron = best((p) => p.stats.civicBuilt * 100 + p.prestige);
  return [
    { key: 'corner', title: 'Corner King', player: corner, detail: `${money(g.players[corner].stats.cornerRevenue)} from corner lots` },
    { key: 'shark', title: 'Price Shark', player: shark, detail: `${money(g.players[shark].stats.budgetSales)} at the Budget stance` },
    { key: 'patron', title: 'Civic Patron', player: patron, detail: `${g.players[patron].stats.civicBuilt} civic projects · ${g.players[patron].prestige} Prestige` },
  ];
}

/** Continue a finished match in Endless mode. */
export function continueEndless(g: Game): Game | null {
  if (g.phase !== 'ended') return null;
  const next = cloneGame(g);
  next.phase = 'planning';
  next.endless = true;
  next.winner = -1;
  return next;
}

export { DAYPART_NAMES };
