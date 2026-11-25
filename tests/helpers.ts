// Shared helpers for the core, resolution, AI, replay, room and DST tests. No mocks of the core.
import { LOAN_MAX, STUDIES, UNITS, UNIT_CAP, CHARTERS, BUILD_KINDS, PACT_KINDS, UNIT_KINDS } from '../src/shared/constants';
import { actionsFor, createGame, maxCohesion, moveOf, stateHash } from '../src/shared/game';
import { CITY, N } from '../src/shared/map';
import { pathFor, queueOrder, standable } from '../src/shared/orders';
import { canonicalOrders, resolveTurn, type Resolution } from '../src/shared/resolve';
import type { Rng } from '../src/shared/rng';
import { stream } from '../src/shared/rng';
import type { AiPersona, Game, MatchConfig, MatchMode, Order, StudyKey } from '../src/shared/types';

export type Kind = 'human' | 'ai';
const PERSONAS: AiPersona[] = ['vesper', 'aurelia', 'orson'];

/** A match config with one entry per seat kind. */
export function config(seed: number, mode: MatchMode, kinds: Kind[]): MatchConfig {
  let k = 0;
  return {
    seed,
    mode,
    players: kinds.map((kind, i) => ({
      name: kind === 'human' ? `Human ${i + 1}` : `Bot ${i + 1}`,
      house: i,
      kind,
      persona: kind === 'ai' ? PERSONAS[k++ % 3] : null,
    })),
  };
}

export function newGame(seed = 7, mode: MatchMode = 'standard', kinds: Kind[] = ['human', 'ai', 'ai', 'ai']): Game {
  return createGame(config(seed, mode, kinds));
}

/** Resolve one turn from drafts through the canonical pipeline. */
export function step(g: Game, drafts: (Order[] | undefined)[] = []): Resolution {
  return resolveTurn(g, canonicalOrders(g, drafts));
}

/** Resolve until `turn` is the current turn (AI only for every seat that is not given a draft). */
export function advanceTo(g: Game, turn: number, drafts?: (turn: number, g: Game) => (Order[] | undefined)[]): Game {
  let cur = g;
  while (cur.phase !== 'ended' && cur.turn < turn) cur = step(cur, drafts ? drafts(cur.turn, cur) : []).game;
  return cur;
}

export function playToEnd(g: Game, drafts?: (turn: number, g: Game) => (Order[] | undefined)[]): { game: Game; resolutions: Resolution[]; states: Game[] } {
  const resolutions: Resolution[] = [];
  const states: Game[] = [g];
  let cur = g;
  while (cur.phase !== 'ended') {
    const r = step(cur, drafts ? drafts(cur.turn, cur) : []);
    resolutions.push(r);
    states.push(r.game);
    cur = r.game;
    if (resolutions.length > 200) throw new Error('match did not end');
  }
  return { game: cur, resolutions, states };
}

// ───────────────────────────── Generated human orders ─────────────────────────────

/** A random legal draft, built only with queueOrder so every order is legal against the frozen state. */
export function genDraft(g: Game, seat: number, rng: Rng, want = rng.range(0, 8)): Order[] {
  let draft: Order[] = [];
  const p = g.players[seat];
  const tryQueue = (o: Order): boolean => {
    const r = queueOrder(g, seat, draft, o);
    if (!r.ok) return false;
    draft = r.draft;
    return true;
  };
  if (g.council) {
    const offers = g.council.offers[seat];
    tryQueue({ t: 'charter', key: offers[rng.int(offers.length)] });
  }
  const mineB = () => g.buildings.filter((b) => b.owner === seat);
  const mineU = () => g.units.filter((u) => u.owner === seat);
  const pick = <T,>(xs: T[]): T | undefined => (xs.length ? xs[rng.int(xs.length)] : undefined);
  for (let tries = 0; tries < want * 6 && draft.filter((o) => o.t !== 'charter').length < want; tries++) {
    const kind = rng.int(17);
    switch (kind) {
      case 0:
      case 1: {
        const u = pick(mineU());
        if (!u) break;
        const to = rng.int(N);
        tryQueue({ t: 'move', unit: u.id, to });
        // Prefer a nearby legal tile too, so moves are not almost always rejected.
        const near = [...Array(N).keys()].filter((t) => standable(u.kind, t) && (pathFor(u.kind, u.tile, t)?.length ?? 99) <= moveOf(p, u.kind));
        const t2 = pick(near);
        if (t2 !== undefined) tryQueue({ t: 'move', unit: u.id, to: t2 });
        break;
      }
      case 2:
      case 3:
      case 4:
        tryQueue({ t: 'build', tile: CITY.lots[rng.int(CITY.lots.length)], kind: BUILD_KINDS[rng.int(BUILD_KINDS.length)] });
        break;
      case 5: {
        const b = pick(mineB());
        if (b) tryQueue({ t: 'upgrade', building: b.id });
        break;
      }
      case 6:
        if (rng.next() < 0.15) {
          const b = pick(mineB());
          if (b) tryQueue({ t: 'sell', building: b.id });
        }
        break;
      case 7:
        tryQueue({ t: 'recruit', kind: UNIT_KINDS[rng.int(UNIT_KINDS.length)] });
        break;
      case 8: {
        const u = pick(mineU().filter((x) => x.kind === 'barge'));
        const b = pick(mineB());
        if (u && b) tryQueue({ t: 'route', unit: u.id, building: b.id });
        break;
      }
      case 9: {
        const b = pick(mineB());
        if (b) tryQueue({ t: 'contract', building: b.id });
        break;
      }
      case 10: {
        const others = g.players.filter((q) => q.id !== seat);
        const to = pick(others);
        if (to) tryQueue({ t: 'propose', to: to.id, kind: PACT_KINDS[rng.int(PACT_KINDS.length)] });
        break;
      }
      case 11: {
        const q = pick(g.proposals.filter((x) => x.to === seat));
        if (q) tryQueue({ t: 'respond', proposal: q.id, accept: rng.next() < 0.7 });
        break;
      }
      case 12:
        tryQueue({ t: 'study', key: Object.keys(STUDIES)[rng.int(6)] as StudyKey });
        break;
      case 13: {
        const b = pick(mineB());
        if (b) tryQueue({ t: 'stance', building: b.id, stance: rng.int(4) });
        break;
      }
      case 14: {
        const b = pick(mineB());
        if (b) tryQueue(rng.next() < 0.5 ? { t: 'restock', building: b.id } : rng.next() < 0.5 ? { t: 'auto', building: b.id, on: rng.next() < 0.7 } : { t: 'promo', building: b.id });
        break;
      }
      case 15:
        tryQueue(rng.next() < 0.6 ? { t: 'borrow' } : { t: 'repay' });
        break;
      default: {
        const u = pick(mineU().filter((x) => x.kind === 'watch'));
        const tgt = pick(g.units.filter((x) => x.owner !== seat));
        if (u && tgt) {
          // A Watch Company next to its target first, when it can get there.
          const spots = [...Array(N).keys()].filter((t) => standable('watch', t) && (pathFor('watch', u.tile, t)?.length ?? 99) <= 2 && Math.max(Math.abs((t % 12) - (tgt.tile % 12)), Math.abs(Math.floor(t / 12) - Math.floor(tgt.tile / 12))) <= 1);
          const s = pick(spots);
          if (s !== undefined && s !== tgt.tile) tryQueue({ t: 'move', unit: u.id, to: s });
          tryQueue({ t: 'contest', unit: u.id, target: tgt.id });
        }
      }
    }
  }
  return draft;
}

export const draftRng = (seed: number, label: string): Rng => stream(seed, 0, `drafts:${label}`);

// ───────────────────────────── Invariants ─────────────────────────────

/** Throws (via expect-like errors) when the transition prev -> res breaks a core invariant. */
export function checkTransition(prev: Game, res: Resolution): string[] {
  const bad: string[] = [];
  const g = res.game;
  const fail = (m: string) => bad.push(`T${prev.turn}: ${m}`);
  if (g.turn !== prev.turn + 1) fail(`turn ${prev.turn} -> ${g.turn}`);
  if (res.summary.from !== prev.turn || res.summary.to !== g.turn) fail('summary range');
  if (res.summary.hash.length === 0) fail('summary hash');
  // Treasury
  for (const c of res.summary.cash) {
    const p = prev.players[c.player];
    if (c.opening !== p.cash) fail(`opening cash of ${c.player} ${c.opening} != ${p.cash}`);
    if (c.opening + c.income - c.costs - c.upkeep + c.financing !== c.closing) fail(`recon ${c.player}: ${JSON.stringify(c)}`);
    if (c.closing !== g.players[c.player].cash) fail(`closing of ${c.player}`);
    for (const k of ['opening', 'income', 'costs', 'upkeep', 'financing', 'closing'] as const) if (!Number.isInteger(c[k])) fail(`non-integer ${k} for ${c.player}: ${c[k]}`);
  }
  for (const p of g.players) {
    if (!Number.isInteger(p.cash) || p.cash < 0) fail(`cash of ${p.id}: ${p.cash}`);
    if (!Number.isInteger(p.debt) || p.debt < 0 || p.debt > LOAN_MAX) fail(`debt of ${p.id}: ${p.debt}`);
    if (!Number.isInteger(p.dividend) || p.dividend < 0) fail(`dividend of ${p.id}`);
    for (const s of p.sales) if (!Number.isInteger(s)) fail('non-integer sales');
  }
  // Actions
  res.committed.forEach((list, i) => {
    const used = list.filter((o) => o.t !== 'charter').length;
    if (used > actionsFor(prev, prev.players[i])) fail(`player ${i} committed ${used} orders`);
  });
  // Units
  checkUnits(g, fail);
  const ids = new Set<number>();
  for (const u of prev.units) ids.add(u.id);
  for (const u of g.units) {
    const before = prev.units.find((x) => x.id === u.id);
    if (before) {
      const allow = moveOf(g.players[u.owner], u.kind);
      const d = pathFor(u.kind, before.tile, u.tile)?.length;
      if (d === undefined || d > allow) fail(`unit ${u.id} moved ${d} > ${allow}`);
    }
  }
  // Unit count changes only by recorded recruitment / disbandment
  for (const p of g.players) {
    const was = prev.units.filter((u) => u.owner === p.id).length;
    const now = g.units.filter((u) => u.owner === p.id).length;
    const lines = res.summary.lines.filter((l) => l.player === p.id);
    const recruits = lines.filter((l) => /recruits a/.test(l.text)).length;
    const gone = lines.filter((l) => /disbanded/.test(l.text) && l.value === 'Lost').length;
    if (now !== was + recruits - gone) fail(`unit count of ${p.id}: ${was} -> ${now} (+${recruits} -${gone})`);
  }
  // No NaN / Infinity can hide in the state (JSON would hash them as null)
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail(`non-finite number at ${path}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(g, 'game');
  // Buildings: unique lot tiles
  const lot = new Set<number>();
  for (const b of g.buildings) {
    if (CITY.tiles[b.tile] !== 'lot') fail(`building ${b.id} off lot`);
    if (lot.has(b.tile)) fail(`two buildings on ${b.tile}`);
    lot.add(b.tile);
  }
  return bad;
}

export function checkUnits(g: Game, fail: (m: string) => void): void {
  const ids = new Set<number>();
  const tiles = new Set<number>();
  for (const u of g.units) {
    if (ids.has(u.id)) fail(`duplicate unit id ${u.id}`);
    ids.add(u.id);
    if (tiles.has(u.tile)) fail(`two units on tile ${u.tile}`);
    tiles.add(u.tile);
    if (!standable(u.kind, u.tile)) fail(`unit ${u.id} (${u.kind}) on illegal tile ${u.tile}`);
    if (!(u.cohesion >= 1 && u.cohesion <= maxCohesion(g.players[u.owner], u.kind))) fail(`unit ${u.id} cohesion ${u.cohesion}`);
  }
  for (const p of g.players) if (g.units.filter((u) => u.owner === p.id).length > UNIT_CAP) fail(`player ${p.id} over unit cap`);
}

export function hashOfGame(g: Game): string {
  return stateHash(g);
}

export { UNITS, CHARTERS };

// ───────────────────────────── Staging ─────────────────────────────

import { emptyLost, cloneGame } from '../src/shared/game';
import { SHOPS } from '../src/shared/constants';
import type { BuildKind, Building, Unit, UnitKind } from '../src/shared/types';
import { isShop } from '../src/shared/constants';

/** A deep copy of `g` that the test may edit freely (the core never mutates its inputs). */
export const stage = (g: Game, edit: (c: Game) => void): Game => {
  const c = cloneGame(g);
  edit(c);
  return c;
};

export function addBuilding(g: Game, owner: number, tile: number, kind: BuildKind = 'roastery', extra: Partial<Building> = {}): Building {
  const b: Building = {
    id: g.nextId++,
    tile,
    kind,
    owner,
    level: 1,
    stance: 1,
    stock: isShop(kind) ? SHOPS[kind].stockMax : 0,
    auto: false,
    promoUntil: 0,
    promoReady: 0,
    contractUntil: 0,
    invested: 100,
    builtTurn: 0,
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
    ...extra,
  };
  g.buildings.push(b);
  return b;
}

export function addUnit(g: Game, owner: number, kind: UnitKind, tile: number, extra: Partial<Unit> = {}): Unit {
  const u: Unit = { id: g.nextId++, owner, kind, tile, cohesion: UNITS[kind].cohesion, route: 0, fought: false, ...extra };
  g.units.push(u);
  return u;
}

/** Jump a staged game to `turn` (calendar only: the council, if any, must be staged by the test). */
export const atTurn = (g: Game, turn: number): Game => stage(g, (c) => void (c.turn = turn));

export const lotTiles = (): number[] => CITY.lots;
export const summaryText = (r: Resolution): string[] => r.summary.lines.map((l) => `${l.text} ${l.value}`);
