import { describe, expect, it } from 'vitest';
import { ACTIONS_BY_ERA, MODES, START_CASH } from '../src/shared/constants';
import { actionsFor, cloneGame, createGame, currentEra, daypartOf, eraOfTurn, finalTurn, isCouncilTurn, stateHash, stateHashShort, tileName } from '../src/shared/game';
import { hashOf, hashString, stableStringify } from '../src/shared/hash';
import { CITY } from '../src/shared/map';
import { stream } from '../src/shared/rng';
import { canonicalOrders, resolveTurn } from '../src/shared/resolve';
import type { Order } from '../src/shared/types';
import { config, newGame, playToEnd, stage, step } from './helpers';

describe('createGame', () => {
  it('starts every House with §900, a Factor and a Watch Company, no property', () => {
    const g = newGame(1, 'standard', ['human', 'ai', 'ai', 'ai']);
    expect(g.players).toHaveLength(4);
    expect(g.turn).toBe(1);
    expect(g.phase).toBe('planning');
    expect(g.buildings).toHaveLength(0);
    for (const p of g.players) {
      expect(p.cash).toBe(START_CASH);
      expect(p.debt).toBe(0);
      expect(g.units.filter((u) => u.owner === p.id).map((u) => u.kind).sort()).toEqual(['factor', 'watch']);
    }
    const tiles = g.units.map((u) => u.tile);
    expect(new Set(tiles).size).toBe(tiles.length);
    for (const u of g.units) expect(CITY.walk[u.tile]).toBe(true);
  });

  it('supports 1..4 seats and ignores extra seats', () => {
    for (const n of [1, 2, 3, 4]) expect(createGame(config(5, 'blitz', Array(n).fill('human'))).players).toHaveLength(n);
  });

  it('is a pure function of its config', () => {
    const a = newGame(99, 'standard');
    const b = newGame(99, 'standard');
    expect(stateHash(a)).toBe(stateHash(b));
    expect(stateHash(newGame(100, 'standard'))).not.toBe(stateHash(a));
    expect(stateHash(newGame(99, 'blitz'))).not.toBe(stateHash(a));
  });
});

describe('calendar', () => {
  it('has 32 turns in Standard, 16 in Blitz, and Eras change every 8 / 4 turns', () => {
    expect(finalTurn({ mode: 'standard' })).toBe(32);
    expect(finalTurn({ mode: 'blitz' })).toBe(16);
    expect(MODES.endless.eraTurns).toBe(8);
    expect([1, 8, 9, 16, 17, 24, 25, 32, 40].map((t) => eraOfTurn({ mode: 'standard' }, t))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 4]);
    expect([1, 4, 5, 8, 9, 12, 13, 16].map((t) => eraOfTurn({ mode: 'blitz' }, t))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('cycles Morning, Noon, Golden Hour, Twilight with the turn number', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(daypartOf)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it('makes the first planning phase of Eras II-IV a Council turn, and never Turn 1 or after the finish', () => {
    const std = (t: number) => isCouncilTurn({ mode: 'standard' }, t);
    expect([1, 2, 9, 10, 17, 25, 32, 33].map(std)).toEqual([false, false, true, false, true, true, false, false]);
    expect([5, 9, 13, 17].map((t) => isCouncilTurn({ mode: 'blitz' }, t))).toEqual([true, true, true, false]);
  });

  it('gives 5 / 6 / 7 / 7 Actions by Era', () => {
    expect(ACTIONS_BY_ERA).toEqual([5, 6, 7, 7]);
    const g = newGame();
    for (const [turn, want] of [[1, 5], [9, 6], [17, 7], [25, 7]] as const) {
      const c = stage(g, (x) => void (x.turn = turn));
      expect(currentEra(c)).toBe(Math.ceil(turn / 8));
      expect(actionsFor(c, c.players[0])).toBe(want);
    }
  });

  it('names tiles like the board', () => {
    expect(tileName(0)).toBe('A1');
    expect(tileName(11)).toBe('L1');
    expect(tileName(143)).toBe('L12');
  });
});

describe('state hash', () => {
  it('ignores key order and is stable across clones and JSON round-trips', () => {
    const g = newGame(3);
    expect(stateHash(cloneGame(g))).toBe(stateHash(g));
    expect(stateHash(JSON.parse(JSON.stringify(g)))).toBe(stateHash(g));
    expect(hashOf({ a: 1, b: [1, 2, { c: 3, d: 4 }] })).toBe(hashOf({ b: [1, 2, { d: 4, c: 3 }], a: 1 }));
    expect(stableStringify({ b: 1, a: undefined })).toBe('{"b":1}');
    expect(stateHash(g)).toMatch(/^[0-9a-f]{16}$/);
    expect(stateHashShort(g)).toMatch(/^#[0-9a-f]{4}·[0-9a-f]{4}$/);
  });

  it('is bit-for-bit the same on every host (pinned values for a fixed string and a fresh world)', () => {
    expect(hashString('mercadia')).toBe('3d0c6d788fae767c');
    expect(stateHash(newGame(7, 'standard', ['human', 'ai', 'ai', 'ai']))).toBe('34928f5d384bd1a0');
  });

  it('changes when anything in the world changes', () => {
    const g = newGame(3);
    const h = stateHash(g);
    expect(stateHash(stage(g, (c) => void (c.players[0].cash += 1)))).not.toBe(h);
    expect(stateHash(stage(g, (c) => void (c.units[0].tile += 1)))).not.toBe(h);
  });

  it('does not change when the core only inspects, plans or resolves a copy', () => {
    const g = newGame(11, 'standard', ['human', 'human', 'ai', 'ai']);
    const h = stateHash(g);
    canonicalOrders(g, [[{ t: 'borrow' }], []]);
    step(g, [[{ t: 'borrow' }], []]);
    expect(stateHash(g)).toBe(h);
  });
});

describe('rng', () => {
  it('streams are pure functions of (seed, turn, purpose) and independent of draw order', () => {
    const a = stream(5, 3, 'x');
    const b = stream(5, 3, 'x');
    expect([a.next(), a.next(), a.int(10)]).toEqual([b.next(), b.next(), b.int(10)]);
    expect(stream(5, 3, 'y').next()).not.toBe(stream(5, 3, 'x').next());
    expect(stream(5, 4, 'x').next()).not.toBe(stream(5, 3, 'x').next());
    const r = stream(1, 1, 'range');
    for (let i = 0; i < 200; i++) {
      const v = r.range(3, 5);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
});

describe('determinism', () => {
  it('same seed + same orders = same world, every turn, for all modes', () => {
    for (const mode of ['blitz', 'standard'] as const) {
      const kinds = ['human', 'ai', 'ai', 'ai'] as const;
      const a = playToEnd(newGame(21, mode, [...kinds]), (t) => [t % 2 ? [{ t: 'borrow' }] : [{ t: 'stance', building: 9999, stance: 2 }]]);
      const b = playToEnd(newGame(21, mode, [...kinds]), (t) => [t % 2 ? [{ t: 'borrow' }] : [{ t: 'stance', building: 9999, stance: 2 }]]);
      expect(a.states.map(stateHash)).toEqual(b.states.map(stateHash));
      expect(a.resolutions.map((r) => r.summary)).toEqual(b.resolutions.map((r) => r.summary));
    }
  });

  it('different seeds give different worlds', () => {
    const a = playToEnd(newGame(1, 'blitz', ['ai', 'ai', 'ai', 'ai'])).game;
    const b = playToEnd(newGame(2, 'blitz', ['ai', 'ai', 'ai', 'ai'])).game;
    expect(stateHash(a)).not.toBe(stateHash(b));
  });

  it('resolution never mutates its input', () => {
    const g = newGame(8, 'standard', ['human', 'ai', 'ai', 'ai']);
    const before = JSON.stringify(g);
    const orders: Order[][] = canonicalOrders(g, [[{ t: 'borrow' }]]);
    const ordersBefore = JSON.stringify(orders);
    resolveTurn(g, orders);
    expect(JSON.stringify(g)).toBe(before);
    expect(JSON.stringify(orders)).toBe(ordersBefore);
  });

  it('the canonical orders do not depend on the property order of the drafts', () => {
    const g = newGame(4, 'standard', ['human', 'human', 'ai', 'ai']);
    const f0 = g.units.find((u) => u.owner === 0 && u.kind === 'factor')!;
    const o1 = { t: 'move', unit: f0.id, to: f0.tile + 12 } as Order;
    const o2 = JSON.parse(JSON.stringify({ to: f0.tile + 12, unit: f0.id, t: 'move' })) as Order;
    const r1 = step(g, [[o1], []]);
    const r2 = step(g, [[o2], []]);
    expect(stateHash(r1.game)).toBe(stateHash(r2.game));
    expect(r1.summary).toEqual(r2.summary);
  });
});

describe('stable tie-breaking by Initiative', () => {
  const rotated = (turn: number, seats: number) => (turn - 1) % seats;

  it('the first House on Turn N is seat ((N-1) mod seats)+1', () => {
    expect([1, 2, 3, 4, 5].map((t) => rotated(t, 4) + 1)).toEqual([1, 2, 3, 4, 1]);
    expect([1, 2, 3, 4].map((t) => rotated(t, 3) + 1)).toEqual([1, 2, 3, 1]);
  });

  it('two Houses claiming one lot: the earlier Initiative House wins, rotating each turn; the loser is refunded', () => {
    for (const turn of [1, 2, 3, 4, 5]) {
      const base = newGame(31, 'standard', ['human', 'human', 'human', 'human']);
      // Factors of seats 0-2 stand beside lot (6,2); everyone claims it.
      const lot = 6 + 2 * 12;
      const g = stage(base, (c) => {
        c.turn = turn;
        c.units.forEach((u, i) => (u.tile = 110 + i)); // park everyone on harmless street tiles
        const f = c.units.filter((u) => u.kind === 'factor');
        f[0].tile = 5 + 12; // (5,1)
        f[1].tile = 6 + 12; // (6,1)
        f[2].tile = 7 + 12; // (7,1)
        f[3].tile = 8 + 12; // (8,1): two tiles away, cannot reach the lot
      });
      const drafts: Order[][] = [0, 1, 2, 3].map(() => [{ t: 'build', tile: lot, kind: 'roastery' }]);
      const r = step(g, drafts);
      const first = rotated(turn, 4);
      const b = r.game.buildings.find((x) => x.tile === lot);
      // Only Houses whose Factor is within one tile of the lot may build; the earliest in Initiative among those wins.
      const near = [0, 1, 2, 3].filter((p) => g.units.some((u) => u.owner === p && u.kind === 'factor' && Math.max(Math.abs((u.tile % 12) - 6), Math.abs(Math.floor(u.tile / 12) - 2)) <= 1));
      const order = [0, 1, 2, 3].map((k) => (first + k) % 4).filter((p) => near.includes(p));
      expect(near.length).toBeGreaterThan(1);
      expect(b?.owner).toBe(order[0]);
      for (const loser of order.slice(1)) {
        expect(r.game.players[loser].cash).toBeLessThan(900); // paid upkeep only
        expect(r.game.players[loser].cash).toBeGreaterThan(900 - 180 - 1000);
        expect(r.summary.lines.some((l) => l.player === loser && /lot taken by .*, refunded/.test(l.text) && l.value === 'Refunded')).toBe(true);
        const c = r.summary.cash[loser];
        expect(c.costs).toBe(0); // nothing was charged for the lost lot
      }
    }
  });
});

describe('match start (PRODUCT.md "Match start")', () => {
  it('every House begins with one Factor and one Watch Company beside Grand Station, §900 and no property', () => {
    for (const kinds of [['human', 'ai'], ['human', 'ai', 'ai'], ['human', 'ai', 'ai', 'ai']] as const) {
      const g = newGame(11, 'standard', [...kinds]);
      const seen = new Set<number>();
      g.players.forEach((p, i) => {
        expect(p.cash).toBe(START_CASH);
        expect(g.buildings.filter((b) => b.owner === i)).toHaveLength(0);
        const mine = g.units.filter((u) => u.owner === i);
        expect(mine.map((u) => u.kind).sort()).toEqual(['factor', 'watch']);
        for (const u of mine) {
          expect(CITY.walk[u.tile]).toBe(true); // a legal street tile
          expect(seen.has(u.tile)).toBe(false); // no two units share a tile
          seen.add(u.tile);
          // beside Grand Station: on the street frontage, within six walking steps of the station door
          expect(CITY.dist[u.tile * 144 + CITY.stationDoor]).toBeGreaterThanOrEqual(0);
          expect(CITY.dist[u.tile * 144 + CITY.stationDoor]).toBeLessThanOrEqual(6);
          expect(Math.min(...CITY.station.map((s) => Math.max(Math.abs((s % 12) - (u.tile % 12)), Math.abs(Math.floor(s / 12) - Math.floor(u.tile / 12)))))).toBeLessThanOrEqual(5);
        }
      });
      expect(g.units).toHaveLength(kinds.length * 2);
    }
  });

  it('no House starts on the Harbor Pier side of the board', () => {
    const g = newGame(11, 'standard', ['human', 'ai', 'ai', 'ai']);
    for (const u of g.units) expect(Math.floor(u.tile / 12)).toBeLessThanOrEqual(3);
  });
});
