// Planning: the order types, their legality, and the projection of a draft.
//
// A draft is validated as it is queued against the frozen state plus the seat's own earlier
// orders ("the plan"). Undo = remove an order, then prune: any later order that no longer holds
// (a build that needed a Factor move) is removed with it. The same checks run again at the
// authority before a turn resolves, so the Actions and treasury budgets are enforced everywhere.
import {
  CHARTERS,
  CIVICS,
  DEFEND_BONUS,
  ERA_UNLOCK,
  LEVEL3_ERA,
  LOAN_MAX,
  LOAN_STEP,
  PACTS,
  PACT_KINDS,
  ROUTE_MOUTH,
  SHOPS,
  STUDIES,
  STUDY_COST,
  UNITS,
  UNIT_CAP,
  UNIT_KINDS,
  BUILD_KINDS,
  isCivic,
  isShop,
  lockNotice,
  LEVEL3_NOTICE,
} from './constants';
import {
  actionsFor,
  buildCostFor,
  buildingAt,
  buildingById,
  contractCostFor,
  currentEra,
  hasStudy,
  isCouncilTurn,
  moveOf,
  pactBetween,
  promoCostFor,
  restockCostFor,
  tileName,
  unitById,
  upgradeCostFor,
} from './game';
import { CITY, N, chebyshev, manhattan } from './map';
import type { BuildKind, CharterKey, Game, Order, PactKind, Player, StudyKey, Unit, UnitKind } from './types';

// ───────────────────────────── Terrain and paths ─────────────────────────────

const DIRS: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

const isWaterway = (t: number): boolean => {
  const k = CITY.tiles[t];
  return k === 'canal' || k === 'bridge' || k === 'avbridge';
};

/** A unit may pass through this tile. Barges pass under the bridges but never stop on them. */
export const passable = (kind: UnitKind, t: number): boolean => (kind === 'barge' ? isWaterway(t) : CITY.walk[t]);
/** A unit may end its move on this tile. */
export const standable = (kind: UnitKind, t: number): boolean => (kind === 'barge' ? CITY.tiles[t] === 'canal' : CITY.walk[t]);

function neighbours(t: number): number[] {
  const out: number[] = [];
  const x = t % 12;
  const y = Math.floor(t / 12);
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= 12 || ny >= 12) continue;
    out.push(ny * 12 + nx);
  }
  return out;
}

/** Breadth-first distances from `from` through legal terrain (units ignored), capped at `max`. */
export function reachFrom(kind: UnitKind, from: number, max: number): Map<number, number> {
  const dist = new Map<number, number>([[from, 0]]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const t = q[i];
    const d = dist.get(t)!;
    if (d >= max) continue;
    for (const n of neighbours(t)) {
      if (dist.has(n) || !passable(kind, n)) continue;
      dist.set(n, d + 1);
      q.push(n);
    }
  }
  return dist;
}

/** The shortest legal path from `from` to `to` (excluding `from`), or null. Stable tie-breaking. */
export function pathFor(kind: UnitKind, from: number, to: number, avoid?: ReadonlySet<number>): number[] | null {
  if (from === to) return [];
  if (!passable(kind, to)) return null;
  const prev = new Map<number, number>([[from, -1]]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const t = q[i];
    if (t === to) break;
    for (const n of neighbours(t)) {
      if (prev.has(n) || !passable(kind, n) || (avoid && avoid.has(n))) continue;
      prev.set(n, t);
      q.push(n);
    }
  }
  if (!prev.has(to)) return null;
  const out: number[] = [];
  for (let t = to; t !== from; t = prev.get(t)!) out.push(t);
  return out.reverse();
}

/** Water steps from the harbor mouth to the nearest canal tile beside a shop, or -1. */
export function routeDistance(shopTile: number): number {
  const reach = reachFrom('barge', ROUTE_MOUTH, 40);
  let best = -1;
  for (const [t, d] of reach) {
    if (CITY.tiles[t] !== 'canal') continue;
    if (manhattan(t, shopTile) > 1) continue;
    if (best < 0 || d < best) best = d;
  }
  return best;
}

/** Tiles of the water route from the mouth to the shop (for blockade checks). */
export function routeTiles(shopTile: number): number[] {
  let best: number[] | null = null;
  for (const t of CITY.canal) {
    if (CITY.tiles[t] !== 'canal' || manhattan(t, shopTile) > 1) continue;
    const p = pathFor('barge', ROUTE_MOUTH, t);
    if (p && (!best || p.length < best.length)) best = p;
  }
  return best ? [ROUTE_MOUTH, ...best] : [];
}

// ───────────────────────────── Combat preview ─────────────────────────────

/** +1 Strength when defending an owned lot or a bridge. */
export function defends(g: Game, u: Unit): boolean {
  const k = CITY.tiles[u.tile];
  if (k === 'bridge' || k === 'avbridge') return true;
  return g.buildings.some((b) => b.owner === u.owner && manhattan(b.tile, u.tile) === 1);
}

/** The deterministic exchange: damage the attacker deals, and what a surviving defender strikes back. */
export function contestPreview(g: Game, a: Unit, d: Unit): { deal: number; back: number } {
  const deal = UNITS[a.kind].strength;
  const survives = d.cohesion - deal > 0;
  const back = survives ? UNITS[d.kind].strength + (defends(g, d) ? DEFEND_BONUS : 0) : 0;
  return { deal, back };
}

// ───────────────────────────── Plan (projection) ─────────────────────────────

export interface Plan {
  seat: number;
  cash: number;
  debt: number;
  actions: number;
  actionsMax: number;
  spent: number;
  tiles: Map<number, number>; // own unit id → projected tile
  moved: Set<number>;
  contested: Set<number>;
  claimed: Set<number>; // lots queued for construction
  touched: Set<string>;
  stance: Map<number, number>;
  auto: Map<number, boolean>;
  recruits: number;
  study: StudyKey | null;
  charter: CharterKey | null;
  proposed: Set<string>;
  sold: Set<number>;
}

export function newPlan(g: Game, seat: number): Plan {
  const p = g.players[seat];
  const max = actionsFor(g, p);
  return {
    seat,
    cash: p.cash,
    debt: p.debt,
    actions: max,
    actionsMax: max,
    spent: 0,
    tiles: new Map(g.units.filter((u) => u.owner === seat).map((u) => [u.id, u.tile])),
    moved: new Set(),
    contested: new Set(),
    claimed: new Set(),
    touched: new Set(),
    stance: new Map(),
    auto: new Map(),
    recruits: 0,
    study: null,
    charter: null,
    proposed: new Set(),
    sold: new Set(),
  };
}

const money = (n: number): string => `§${n.toLocaleString('en-US')}`;
const short = (need: number, have: number): string => `Not enough § — needs ${money(need)}, have ${money(have)} projected`;

/** Where a unit will stand once its queued moves apply (others: where they stand now). */
function occupiedBy(g: Game, plan: Plan, tile: number, except = 0): boolean {
  for (const u of g.units) {
    const t = u.owner === plan.seat && plan.tiles.has(u.id) ? plan.tiles.get(u.id)! : u.tile;
    if (u.id !== except && t === tile) return true;
  }
  return false;
}

function inReach(g: Game, plan: Plan, tile: number): boolean {
  for (const b of g.buildings) if (b.owner === plan.seat && !plan.sold.has(b.id) && manhattan(b.tile, tile) === 1) return true;
  for (const u of g.units) {
    if (u.owner !== plan.seat || u.kind !== 'factor') continue;
    const t = plan.tiles.get(u.id) ?? u.tile;
    if (chebyshev(t, tile) <= 1) return true;
  }
  return false;
}

/** Why `order` cannot be queued after the orders already folded into `plan`, or null if it can. */
export function checkOrder(g: Game, plan: Plan, o: Order): string | null {
  if (g.phase === 'ended') return 'The match is over';
  const p = g.players[plan.seat];
  if (!p) return 'No such House';
  const era = currentEra(g);
  if (o.t !== 'charter' && plan.actions < 1) return `No Actions left — ${plan.actionsMax} of ${plan.actionsMax} spent`;
  const afford = (cost: number): string | null => (cost > plan.cash ? short(cost, plan.cash) : null);

  switch (o.t) {
    case 'move': {
      const u = unitById(g, o.unit);
      if (!u || u.owner !== plan.seat) return 'That unit is not yours';
      if (plan.moved.has(u.id)) return 'Each unit accepts one movement order per turn';
      const from = plan.tiles.get(u.id) ?? u.tile;
      if (!Number.isInteger(o.to) || o.to < 0 || o.to >= N) return 'Off the board';
      if (o.to === from) return 'Already there';
      if (!standable(u.kind, o.to)) return u.kind === 'barge' ? 'Barges stay on canal water' : 'Units stand on streets, lanes and bridges';
      const path = pathFor(u.kind, from, o.to);
      const allow = moveOf(p, u.kind);
      if (!path) return 'No legal path';
      if (path.length > allow) return `Too far — ${UNITS[u.kind].name} moves ${allow} tiles`;
      if (occupiedBy(g, plan, o.to, u.id)) return 'Another unit holds that tile';
      for (const [id, t] of plan.tiles) if (id !== u.id && plan.moved.has(id) && t === o.to) return 'Another of your units is headed there';
      return null;
    }
    case 'contest': {
      const u = unitById(g, o.unit);
      if (!u || u.owner !== plan.seat) return 'That unit is not yours';
      if (u.kind !== 'watch') return 'Only a Watch Company can issue a Contest';
      const t = unitById(g, o.target);
      if (!t || t.owner === plan.seat) return 'Choose a rival unit';
      if (pactBetween(g, plan.seat, t.owner, 'truce')) return 'A Truce forbids Contests between these Houses';
      if (plan.contested.has(u.id)) return 'Each Watch Company issues one Contest per turn';
      const at = plan.tiles.get(u.id) ?? u.tile;
      if (chebyshev(at, t.tile) > 1) return 'Not adjacent — move the Watch Company next to the target first';
      return null;
    }
    case 'build': {
      if (!BUILD_KINDS.includes(o.kind)) return 'Unknown building';
      if (!Number.isInteger(o.tile) || o.tile < 0 || o.tile >= N || CITY.tiles[o.tile] !== 'lot') return 'Not a buildable lot';
      if (ERA_UNLOCK[o.kind] > era) return lockNotice(o.kind);
      if (buildingAt(g, o.tile) || plan.claimed.has(o.tile)) return 'That lot is taken';
      if (!inReach(g, plan, o.tile)) return 'Out of reach — build beside your property or within one tile of a Factor';
      if (isShop(o.kind)) {
        const desire = SHOPS[o.kind].desire;
        for (const b of g.buildings) {
          if (b.owner !== plan.seat && isShop(b.kind) && SHOPS[b.kind].desire === desire && chebyshev(b.tile, o.tile) <= 2 && pactBetween(g, plan.seat, b.owner, 'rent'))
            return 'A Rent Accord forbids a same-trade shop within 2 tiles of this rival';
        }
      }
      return afford(buildCostFor(p, o.kind));
    }
    case 'upgrade': {
      const b = buildingById(g, o.building);
      if (!b || b.owner !== plan.seat || plan.sold.has(b.id)) return 'That is not your shop';
      if (!isShop(b.kind)) return 'Civic projects cannot be upgraded';
      if (plan.touched.has(`up:${b.id}`)) return 'Already upgrading this turn';
      if (b.level >= 3) return 'Already Level 3';
      if (b.level + 1 >= 3 && era < LEVEL3_ERA) return LEVEL3_NOTICE;
      return afford(upgradeCostFor(p, b));
    }
    case 'sell': {
      const b = buildingById(g, o.building);
      if (!b || b.owner !== plan.seat || plan.sold.has(b.id)) return 'That is not your property';
      if (plan.touched.has(`up:${b.id}`)) return 'Already upgrading this turn';
      return null;
    }
    case 'recruit': {
      if (!UNIT_KINDS.includes(o.kind)) return 'Unknown unit';
      const def = UNITS[o.kind];
      if (def.era > era) return `${def.name} unlocks in Era ${['I', 'II', 'III', 'IV'][def.era - 1]}`;
      const count = g.units.filter((u) => u.owner === plan.seat).length + plan.recruits;
      if (count >= UNIT_CAP) return `A House fields at most ${UNIT_CAP} units`;
      return afford(def.cost);
    }
    case 'route': {
      const u = unitById(g, o.unit);
      if (!u || u.owner !== plan.seat || u.kind !== 'barge') return 'Choose one of your Barges';
      const b = buildingById(g, o.building);
      if (!b || b.owner !== plan.seat || plan.sold.has(b.id) || !isShop(b.kind)) return 'Choose one of your shops';
      if (!CITY.canalFront[b.tile]) return 'Only canal-front shops can take a Barge route';
      const d = routeDistance(b.tile);
      if (d < 0 || d > 3 * moveOf(p, 'barge')) return 'Too far from the Harbor Pier for a Barge route';
      if (plan.touched.has(`route:${u.id}`)) return 'That Barge already has a route order';
      return null;
    }
    case 'contract': {
      const b = buildingById(g, o.building);
      if (!b || b.owner !== plan.seat || plan.sold.has(b.id) || !isShop(b.kind)) return 'Choose one of your shops';
      if (b.contractUntil >= g.turn || plan.touched.has(`contract:${b.id}`)) return 'A supply contract is already in force';
      return afford(contractCostFor(p, b));
    }
    case 'propose': {
      const other = g.players[o.to];
      if (!other || o.to === plan.seat) return 'Choose a rival House';
      if (!PACT_KINDS.includes(o.kind)) return 'Unknown pact';
      if (pactBetween(g, plan.seat, o.to, o.kind)) return `A ${PACTS[o.kind].name} is already in force`;
      const key = `${o.to}:${o.kind}`;
      if (plan.proposed.has(key)) return 'Already proposed this turn';
      if (g.proposals.some((q) => q.from === plan.seat && q.to === o.to && q.kind === o.kind && q.turn >= g.turn - 1)) return 'A proposal is already waiting';
      return null;
    }
    case 'respond': {
      const q = g.proposals.find((x) => x.id === o.proposal);
      if (!q || q.to !== plan.seat || q.turn >= g.turn) return 'No such proposal';
      if (plan.touched.has(`resp:${q.id}`)) return 'Already answered';
      if (typeof o.accept !== 'boolean') return 'Accept or decline';
      return null;
    }
    case 'study': {
      const def = STUDIES[o.key];
      if (!def) return 'Unknown study';
      if (def.era > era) return `${def.name} unlocks in Era ${['I', 'II', 'III', 'IV'][def.era - 1]}`;
      if (hasStudy(p, o.key)) return 'Already completed';
      const cur = plan.study ?? p.study;
      if (cur && cur !== o.key && (plan.study || p.studyPoints > 0)) return `Finish ${STUDIES[cur].name} first`;
      if (plan.study) return 'One study order per turn';
      return afford(STUDY_COST);
    }
    case 'stance': {
      const b = buildingById(g, o.building);
      if (!b || b.owner !== plan.seat || plan.sold.has(b.id) || !isShop(b.kind)) return 'Choose one of your shops';
      if (!Number.isInteger(o.stance) || o.stance < 0 || o.stance > 3) return 'Unknown price stance';
      if ((plan.stance.get(b.id) ?? b.stance) === o.stance) return 'That stance is already set';
      return null;
    }
    case 'restock': {
      const b = buildingById(g, o.building);
      if (!b || b.owner !== plan.seat || plan.sold.has(b.id) || !isShop(b.kind)) return 'Choose one of your shops';
      if (plan.touched.has(`restock:${b.id}`)) return 'Already restocking';
      if (b.stock >= SHOPS[b.kind].stockMax) return 'Fully stocked';
      return afford(restockCostFor(g, p, b));
    }
    case 'auto': {
      const b = buildingById(g, o.building);
      if (!b || b.owner !== plan.seat || plan.sold.has(b.id) || !isShop(b.kind)) return 'Choose one of your shops';
      if ((plan.auto.get(b.id) ?? b.auto) === !!o.on) return 'Already set';
      return null;
    }
    case 'promo': {
      const b = buildingById(g, o.building);
      if (!b || b.owner !== plan.seat || plan.sold.has(b.id) || !isShop(b.kind)) return 'Choose one of your shops';
      if (b.promoUntil >= g.turn || plan.touched.has(`promo:${b.id}`)) return 'A Promo Blitz is already running';
      if (b.promoReady > g.turn) return `Promo Blitz ready again on Turn ${b.promoReady}`;
      return afford(promoCostFor(p));
    }
    case 'borrow': {
      if (plan.debt + LOAN_STEP > LOAN_MAX) return `The Credit Line is full (${money(LOAN_MAX)})`;
      return null;
    }
    case 'repay': {
      if (plan.debt <= 0) return 'Nothing to repay';
      return afford(Math.min(LOAN_STEP, plan.debt));
    }
    case 'charter': {
      if (!isCouncilTurn(g, g.turn) || !g.council) return 'No Charter is offered this turn';
      if (plan.charter) return 'A Charter is already chosen';
      if (!g.council.offers[plan.seat]?.includes(o.key)) return 'That Charter is not on offer';
      return null;
    }
    default:
      return 'Unknown order';
  }
}

/** Fold a legal order into the plan. */
export function applyToPlan(g: Game, plan: Plan, o: Order): void {
  const p = g.players[plan.seat];
  if (o.t !== 'charter') plan.actions--;
  const pay = (n: number) => {
    plan.cash -= n;
    plan.spent += n;
  };
  switch (o.t) {
    case 'move':
      plan.tiles.set(o.unit, o.to);
      plan.moved.add(o.unit);
      break;
    case 'contest':
      plan.contested.add(o.unit);
      break;
    case 'build':
      plan.claimed.add(o.tile);
      pay(buildCostFor(p, o.kind));
      break;
    case 'upgrade': {
      const b = buildingById(g, o.building)!;
      plan.touched.add(`up:${b.id}`);
      pay(upgradeCostFor(p, b));
      break;
    }
    case 'sell':
      plan.sold.add(o.building);
      break;
    case 'recruit':
      plan.recruits++;
      pay(UNITS[o.kind].cost);
      break;
    case 'route':
      plan.touched.add(`route:${o.unit}`);
      break;
    case 'contract': {
      const b = buildingById(g, o.building)!;
      plan.touched.add(`contract:${b.id}`);
      pay(contractCostFor(p, b));
      break;
    }
    case 'propose':
      plan.proposed.add(`${o.to}:${o.kind}`);
      break;
    case 'respond':
      plan.touched.add(`resp:${o.proposal}`);
      break;
    case 'study':
      plan.study = o.key;
      pay(STUDY_COST);
      break;
    case 'stance':
      plan.stance.set(o.building, o.stance);
      break;
    case 'restock': {
      const b = buildingById(g, o.building)!;
      plan.touched.add(`restock:${b.id}`);
      pay(restockCostFor(g, p, b));
      break;
    }
    case 'auto':
      plan.auto.set(o.building, !!o.on);
      break;
    case 'promo': {
      plan.touched.add(`promo:${o.building}`);
      pay(promoCostFor(p));
      break;
    }
    case 'borrow':
      plan.cash += LOAN_STEP;
      plan.debt += LOAN_STEP;
      break;
    case 'repay': {
      const n = Math.min(LOAN_STEP, plan.debt);
      plan.cash -= n;
      plan.debt -= n;
      break;
    }
    case 'charter':
      plan.charter = o.key;
      break;
  }
}

export interface DraftResult {
  kept: Order[];
  removed: { order: Order; reason: string }[];
  plan: Plan;
}

/** Validate a whole draft in sequence; anything that no longer holds is removed. */
export function pruneDraft(g: Game, seat: number, orders: Order[]): DraftResult {
  const plan = newPlan(g, seat);
  const kept: Order[] = [];
  const removed: { order: Order; reason: string }[] = [];
  for (const o of orders) {
    const why = checkOrder(g, plan, o);
    if (why) removed.push({ order: o, reason: why });
    else {
      applyToPlan(g, plan, o);
      kept.push(o);
    }
  }
  return { kept, removed, plan };
}

/** Try to append an order. */
export function queueOrder(g: Game, seat: number, draft: Order[], o: Order): { ok: true; draft: Order[]; plan: Plan } | { ok: false; reason: string } {
  const r = pruneDraft(g, seat, draft);
  const why = checkOrder(g, r.plan, o);
  if (why) return { ok: false, reason: why };
  const next = [...r.kept, o];
  return { ok: true, draft: next, plan: pruneDraft(g, seat, next).plan };
}

/** Remove the order at `index`; orders that depended on it go too. */
export function undoOrder(g: Game, seat: number, draft: Order[], index: number): DraftResult {
  const rest = draft.filter((_, i) => i !== index);
  const r = pruneDraft(g, seat, rest);
  return r;
}

/** Move an order within the queue (reordering is free); invalid results are rejected by the caller. */
export function reorderDraft(g: Game, seat: number, draft: Order[], from: number, to: number): DraftResult {
  const next = draft.slice();
  const [x] = next.splice(from, 1);
  if (x === undefined) return pruneDraft(g, seat, draft);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, x);
  return pruneDraft(g, seat, next);
}

/** Reason End Turn / Ready is unavailable for content reasons (Charter), or null. */
export function readyBlock(g: Game, seat: number, orders: Order[]): string | null {
  if (g.phase === 'ended') return 'Match over';
  if (g.council && isCouncilTurn(g, g.turn) && !orders.some((o) => o.t === 'charter')) return 'Choose a Charter';
  void seat;
  return null;
}

// ───────────────────────────── Order text ─────────────────────────────

export interface OrderLabel {
  text: string;
  cost: number; // up-front §
  action: boolean;
  tile: number; // board tile the order concerns, or -1
}

const UNIT_NAME = (k: UnitKind): string => UNITS[k].name;

export function describeOrder(g: Game, seat: number, o: Order): OrderLabel {
  const p: Player = g.players[seat];
  const lbl = (text: string, cost = 0, tile = -1, action = true): OrderLabel => ({ text, cost, action, tile });
  switch (o.t) {
    case 'move': {
      const u = unitById(g, o.unit);
      return lbl(`Move ${u ? UNIT_NAME(u.kind) : 'unit'} #${o.unit} to ${tileName(o.to)}`, 0, o.to);
    }
    case 'contest': {
      const t = unitById(g, o.target);
      const u = unitById(g, o.unit);
      const prev = u && t ? contestPreview(g, u, t) : { deal: 0, back: 0 };
      return lbl(`Contest ${t ? UNIT_NAME(t.kind) : 'unit'} #${o.target} · deal ${prev.deal}, take ${prev.back}`, 0, t?.tile ?? -1);
    }
    case 'build': {
      const name = isShop(o.kind) ? SHOPS[o.kind].name : CIVICS[o.kind].name;
      return lbl(`Build ${name} at ${tileName(o.tile)}`, buildCostFor(p, o.kind), o.tile);
    }
    case 'upgrade': {
      const b = buildingById(g, o.building);
      return lbl(`Upgrade ${b ? SHOPS[b.kind as keyof typeof SHOPS]?.name ?? '' : ''} ${b ? tileName(b.tile) : ''} to Level ${b ? b.level + 1 : '?'}`, b ? upgradeCostFor(p, b) : 0, b?.tile ?? -1);
    }
    case 'sell': {
      const b = buildingById(g, o.building);
      return lbl(`Sell ${b ? tileName(b.tile) : 'property'} for 60% of invested`, 0, b?.tile ?? -1);
    }
    case 'recruit':
      return lbl(`Recruit ${UNIT_NAME(o.kind)}`, UNITS[o.kind].cost);
    case 'route': {
      const b = buildingById(g, o.building);
      return lbl(`Barge #${o.unit} supplies ${b ? tileName(b.tile) : 'shop'}`, 0, b?.tile ?? -1);
    }
    case 'contract': {
      const b = buildingById(g, o.building);
      return lbl(`Harbor supply contract at ${b ? tileName(b.tile) : 'shop'}`, b ? contractCostFor(p, b) : 0, b?.tile ?? -1);
    }
    case 'propose':
      return lbl(`Propose ${PACTS[o.kind as PactKind].name} to ${g.players[o.to]?.name ?? 'rival'}`);
    case 'respond': {
      const q = g.proposals.find((x) => x.id === o.proposal);
      return lbl(`${o.accept ? 'Accept' : 'Decline'} ${q ? PACTS[q.kind].name : 'pact'} from ${q ? g.players[q.from]?.name : 'rival'}`);
    }
    case 'study':
      return lbl(`Study ${STUDIES[o.key]?.name ?? o.key}`, STUDY_COST);
    case 'stance': {
      const b = buildingById(g, o.building);
      return lbl(`Price ${b ? tileName(b.tile) : 'shop'}: ${['Budget', 'Fair', 'Craft', 'Prestige'][o.stance] ?? '?'}`, 0, b?.tile ?? -1);
    }
    case 'restock': {
      const b = buildingById(g, o.building);
      return lbl(`Restock ${b ? tileName(b.tile) : 'shop'}`, b ? restockCostFor(g, p, b) : 0, b?.tile ?? -1);
    }
    case 'auto': {
      const b = buildingById(g, o.building);
      return lbl(`Auto-restock ${o.on ? 'on' : 'off'} at ${b ? tileName(b.tile) : 'shop'}`, 0, b?.tile ?? -1);
    }
    case 'promo': {
      const b = buildingById(g, o.building);
      return lbl(`Promo Blitz at ${b ? tileName(b.tile) : 'shop'}`, promoCostFor(p), b?.tile ?? -1);
    }
    case 'borrow':
      return lbl(`Borrow ${money(LOAN_STEP)}`);
    case 'repay':
      return lbl(`Repay ${money(Math.min(LOAN_STEP, p.debt))}`, Math.min(LOAN_STEP, p.debt));
    case 'charter':
      return lbl(`Adopt ${CHARTERS[o.key]?.name ?? o.key}`, 0, -1, false);
  }
}

// ───────────────────────────── Untrusted input ─────────────────────────────

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Strictly parse an order from untrusted JSON; returns null for anything malformed. */
export function parseOrder(v: unknown): Order | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case 'move':
      return isInt(o.unit) && isInt(o.to) ? { t: 'move', unit: o.unit, to: o.to } : null;
    case 'contest':
      return isInt(o.unit) && isInt(o.target) ? { t: 'contest', unit: o.unit, target: o.target } : null;
    case 'build':
      return isInt(o.tile) && typeof o.kind === 'string' && (BUILD_KINDS as string[]).includes(o.kind) ? { t: 'build', tile: o.tile, kind: o.kind as BuildKind } : null;
    case 'upgrade':
    case 'sell':
    case 'contract':
    case 'restock':
    case 'promo':
      return isInt(o.building) ? ({ t: o.t, building: o.building } as Order) : null;
    case 'recruit':
      return typeof o.kind === 'string' && (UNIT_KINDS as string[]).includes(o.kind) ? { t: 'recruit', kind: o.kind as UnitKind } : null;
    case 'route':
      return isInt(o.unit) && isInt(o.building) ? { t: 'route', unit: o.unit, building: o.building } : null;
    case 'propose':
      return isInt(o.to) && typeof o.kind === 'string' && (PACT_KINDS as string[]).includes(o.kind) ? { t: 'propose', to: o.to, kind: o.kind as PactKind } : null;
    case 'respond':
      return isInt(o.proposal) && typeof o.accept === 'boolean' ? { t: 'respond', proposal: o.proposal, accept: o.accept } : null;
    case 'study':
      return typeof o.key === 'string' && o.key in STUDIES ? { t: 'study', key: o.key as StudyKey } : null;
    case 'stance':
      return isInt(o.building) && isInt(o.stance) ? { t: 'stance', building: o.building, stance: o.stance } : null;
    case 'auto':
      return isInt(o.building) && typeof o.on === 'boolean' ? { t: 'auto', building: o.building, on: o.on } : null;
    case 'borrow':
      return { t: 'borrow' };
    case 'repay':
      return { t: 'repay' };
    case 'charter':
      return typeof o.key === 'string' && o.key in CHARTERS ? { t: 'charter', key: o.key as CharterKey } : null;
    default:
      return null;
  }
}

export function parseDraft(v: unknown): Order[] | null {
  if (!Array.isArray(v) || v.length > 40) return null;
  const out: Order[] = [];
  for (const x of v) {
    const o = parseOrder(x);
    if (!o) return null;
    out.push(o);
  }
  return out;
}

export { isCivic };
