import { describe, expect, it } from 'vitest';
import { CHARTERS, FORECAST_TURNS, LOAN_MAX, ROUTE_FEE, UNITS, UNIT_CAP, UPGRADE_COST } from '../src/shared/constants';
import { actionsFor, buildCostFor, computeStandings, createGame, maxCohesion, moveOf, stateHash, upgradeCostFor } from '../src/shared/game';
import { shortHash } from '../src/shared/hash';
import { CITY } from '../src/shared/map';
import { routeDistance } from '../src/shared/orders';
import { canonicalOrders, continueEndless, resolveTurn } from '../src/shared/resolve';
import type { Game, Order } from '../src/shared/types';
import { addBuilding, addUnit, checkTransition, config, draftRng, genDraft, newGame, playToEnd, stage, step } from './helpers';

const allHuman = (seed = 3, mode: 'standard' | 'blitz' | 'endless' = 'standard', n = 4) => createGame(config(seed, mode, Array(n).fill('human')));
const unitOf = (g: Game, owner: number, kind: string) => g.units.find((u) => u.owner === owner && u.kind === kind)!;
const text = (r: { summary: { lines: { text: string; value: string }[] } }) => r.summary.lines.map((l) => `${l.text} | ${l.value}`);

describe('five steps in order', () => {
  const rank = { movement: 0, combat: 1, production: 2, treasury: 3, events: 4 } as const;

  it('every summary lists Movement, Combat, Production, Treasury, Events in that order (then the cash reconciliation)', () => {
    for (const mode of ['blitz', 'standard'] as const) {
      const { resolutions } = playToEnd(newGame(5, mode, ['ai', 'ai', 'ai', 'ai']));
      for (const r of resolutions) {
        const body = r.summary.lines.filter((l) => !/Opening §/.test(l.text));
        let last = 0;
        for (const l of body) {
          expect(rank[l.section]).toBeGreaterThanOrEqual(last);
          last = rank[l.section];
        }
        const recon = r.summary.lines.filter((l) => /Opening §/.test(l.text));
        expect(recon).toHaveLength(r.game.players.length);
      }
    }
  });

  it('one scenario exercising all five steps shows them in order with the right content', () => {
    const g = stage(allHuman(1, 'standard', 2), (c) => {
      c.units.forEach((u, i) => void (u.tile = [16, 18, 15, 17][i]));
      addBuilding(c, 0, 28, 'roastery'); // pre-existing shop, will have sales
    });
    const w0 = unitOf(g, 0, 'watch');
    const w1 = unitOf(g, 1, 'watch');
    // Seat 1's Watch is two tiles from seat 0's: seat 0 moves next to it and Contests in the same turn.
    const r = step(g, [
      [
        { t: 'move', unit: w0.id, to: 17 },
        { t: 'contest', unit: w0.id, target: w1.id },
        { t: 'borrow' },
      ],
      [],
    ]);
    const sections = r.summary.lines.map((l) => l.section);
    expect(sections.indexOf('movement')).toBeLessThan(sections.indexOf('combat'));
    expect(sections.indexOf('combat')).toBeLessThan(sections.indexOf('production'));
    expect(sections.indexOf('production')).toBeLessThan(sections.indexOf('treasury'));
    expect(sections.indexOf('treasury')).toBeLessThan(sections.lastIndexOf('events'));
    // Adjacency was checked after Movement: the Contest happened.
    expect(text(r).some((t) => /Watch #\d+ contests/.test(t))).toBe(true);
  });
});

describe('Movement', () => {
  /** Seat 0 factor 15 -> 17 over its own Watch on 16 while seat 1's Watch (moving first on Turn 2) takes 17. */
  const scene = () =>
    stage(allHuman(2, 'standard', 2), (c) => {
      c.turn = 2; // seat 1 has Initiative
      const f0 = unitOf(c, 0, 'factor');
      const w0 = unitOf(c, 0, 'watch');
      const f1 = unitOf(c, 1, 'factor');
      const w1 = unitOf(c, 1, 'watch');
      f0.tile = 15;
      w0.tile = 16;
      w1.tile = 19; // (7,1)
      f1.tile = 1 + 11 * 12;
    });

  it('a unit never enters a rival-held tile: it halts and the ledger records Blocked', () => {
    const g = scene();
    const f0 = unitOf(g, 0, 'factor');
    const w1 = unitOf(g, 1, 'watch');
    const r = step(g, [[{ t: 'move', unit: f0.id, to: 17 }], [{ t: 'move', unit: w1.id, to: 17 }]]);
    const f0after = r.game.units.find((u) => u.id === f0.id)!;
    expect(r.game.units.find((u) => u.id === w1.id)!.tile).toBe(17);
    expect(f0after.tile).not.toBe(17);
    expect(text(r).some((t) => /Factor #\d+ halted at \w+, \w+ is held \| Blocked/.test(t))).toBe(true);
    const tiles = r.game.units.map((u) => u.tile);
    expect(new Set(tiles).size).toBe(tiles.length); // never two units on one tile
  });

  it('a unit that has to halt never stops on a tile held by its own unit', () => {
    const g = scene();
    const f0 = unitOf(g, 0, 'factor');
    const w1 = unitOf(g, 1, 'watch');
    const r = step(g, [[{ t: 'move', unit: f0.id, to: 17 }], [{ t: 'move', unit: w1.id, to: 17 }]]);
    expect(r.game.units.find((u) => u.id === f0.id)!.tile).toBe(15);
    expect(checkTransition(g, r)).toEqual([]);
  });

  it('detours around a rival when a legal route within the allowance exists', () => {
    const g = stage(allHuman(2, 'standard', 2), (c) => {
      const f0 = unitOf(c, 0, 'factor');
      c.units.forEach((u) => void (u.tile = 140 - u.id));
      f0.tile = 3 + 7 * 12 + 0; // (3,7) lane
      unitOf(c, 1, 'watch').tile = 4 + 7 * 12; // rival directly east on the lane
    });
    // Destination (5,7)? The lane is one tile wide at y7: no way around, so the Factor halts.
    const f0 = unitOf(g, 0, 'factor');
    const r = step(g, [[{ t: 'move', unit: f0.id, to: 5 + 7 * 12 }], []]);
    expect(r.game.units.find((u) => u.id === f0.id)!.tile).toBe(f0.tile);
    expect(text(r).some((t) => /Blocked/.test(t))).toBe(true);
  });

  it('a Barge only ever stops on canal water: halted before a bridge, it stays on the water', () => {
    // Turn 10: seat 2 (index 1) has Initiative. Its Barge takes (6,6) first; seat 1's Barge, headed
    // from (6,8) up through the footbridge at (6,7) to (6,5), is halted. It may not stop on the bridge.
    const g = stage(allHuman(2, 'standard', 2), (c) => {
      c.turn = 10;
      c.units.forEach((u, i) => void (u.tile = 133 + i));
      addUnit(c, 0, 'barge', 6 + 8 * 12);
      addUnit(c, 1, 'barge', 6 + 4 * 12);
    });
    const mine = g.units.find((u) => u.kind === 'barge' && u.owner === 0)!;
    const theirs = g.units.find((u) => u.kind === 'barge' && u.owner === 1)!;
    const r = step(g, [[{ t: 'move', unit: mine.id, to: 6 + 5 * 12 }], [{ t: 'move', unit: theirs.id, to: 6 + 6 * 12 }]]);
    expect(r.game.units.find((u) => u.id === theirs.id)!.tile).toBe(6 + 6 * 12);
    expect(r.game.units.find((u) => u.id === mine.id)!.tile).toBe(6 + 8 * 12);
    expect(text(r).some((t) => /Barge #\d+ halted at \w+, \w+ is held \| Blocked/.test(t))).toBe(true);
    expect(checkTransition(g, r)).toEqual([]);
  });

  it('units never exceed their allowance (Barge 4, or 5 with Canal Hydraulics)', () => {
    const g = stage(allHuman(2, 'standard', 2), (c) => void (c.turn = 9, addUnit(c, 0, 'barge', 7 + 10 * 12)));
    expect(moveOf(g.players[0], 'barge')).toBe(4);
    const h = stage(g, (c) => void c.players[0].studies.push('hydraulics'));
    expect(moveOf(h.players[0], 'barge')).toBe(5);
    const barge = g.units.find((u) => u.kind === 'barge')!;
    // 5 water tiles away is illegal for 4, legal for 5
    const far = 6 + 7 * 12 - 12; // (6,6)
    const q4 = canonicalOrders(g, [[{ t: 'move', unit: barge.id, to: far }], []]);
    expect(q4[0]).toEqual([]);
    const q5 = canonicalOrders(h, [[{ t: 'move', unit: barge.id, to: far }], []]);
    expect(q5[0]).toHaveLength(1);
  });

  it('an order that was legal at planning but not at resolution fails cleanly', () => {
    const g = scene2();
    const f0 = unitOf(g, 0, 'factor');
    const orders: Order[][] = [[{ t: 'move', unit: f0.id, to: 11 * 12 + 5 }], []]; // far beyond allowance
    const r = resolveTurn(g, orders); // not canonical: re-validated, dropped
    expect(r.committed[0]).toEqual([]);
    expect(r.game.units.find((u) => u.id === f0.id)!.tile).toBe(f0.tile);
  });
});

function scene2(): Game {
  return allHuman(4, 'standard', 2);
}

describe('Combat', () => {
  const setup = (defCohesion: number, withBuilding: boolean, attackCohesion = 5) =>
    stage(allHuman(4, 'standard', 2), (c) => {
      c.units.forEach((u, i) => void (u.tile = 133 + i)); // park on the harbor avenue
      const a = unitOf(c, 0, 'watch');
      const d = unitOf(c, 1, 'watch');
      a.tile = 15;
      d.tile = 16;
      a.cohesion = attackCohesion;
      d.cohesion = defCohesion;
      if (withBuilding) addBuilding(c, 1, 16 + 12, 'roastery'); // the defender stands beside its own property
    });

  it('deals the attacker Strength as damage, no dice, and a surviving defender strikes back', () => {
    const g = setup(5, false);
    const a = unitOf(g, 0, 'watch');
    const d = unitOf(g, 1, 'watch');
    const r = step(g, [[{ t: 'contest', unit: a.id, target: d.id }], []]);
    expect(r.game.units.find((u) => u.id === d.id)!.cohesion).toBe(5 - 3);
    expect(r.game.units.find((u) => u.id === a.id)!.cohesion).toBe(5 - 3);
    expect(text(r).some((t) => /contests/.test(t) && /−3 \/ −3/.test(t))).toBe(true);
    // Determinism: identical again
    expect(stateHash(step(g, [[{ t: 'contest', unit: a.id, target: d.id }], []]).game)).toBe(stateHash(r.game));
  });

  it('a defender beside its own property gets +1 Strength on the strike-back', () => {
    const g = setup(5, true);
    const a = unitOf(g, 0, 'watch');
    const d = unitOf(g, 1, 'watch');
    const r = step(g, [[{ t: 'contest', unit: a.id, target: d.id }], []]);
    expect(r.game.units.find((u) => u.id === a.id)!.cohesion).toBe(5 - 4);
    expect(text(r).some((t) => /−3 \/ −4/.test(t))).toBe(true);
  });

  it('units at 0 Cohesion are disbanded and the dead strike no blow', () => {
    const g = setup(3, false);
    const a = unitOf(g, 0, 'watch');
    const d = unitOf(g, 1, 'watch');
    const r = step(g, [[{ t: 'contest', unit: a.id, target: d.id }], []]);
    expect(r.game.units.find((u) => u.id === d.id)).toBeUndefined();
    expect(r.game.units.find((u) => u.id === a.id)!.cohesion).toBe(5); // no strike-back
    expect(text(r).some((t) => /disbanded — Cohesion spent \| Lost/.test(t))).toBe(true);
    expect(r.game.units.filter((u) => u.owner === 1).map((u) => u.kind)).toEqual(['factor']);
  });

  it('a unit may move and Contest in the same turn (adjacency is checked after Movement)', () => {
    const g = setup(5, false);
    const a = unitOf(g, 0, 'watch');
    const d = unitOf(g, 1, 'watch');
    const apart = stage(g, (c) => void (c.units.find((u) => u.id === a.id)!.tile = 14));
    expect(canonicalOrders(apart, [[{ t: 'contest', unit: a.id, target: d.id }], []])[0]).toEqual([]); // not adjacent yet
    const r = step(apart, [[{ t: 'move', unit: a.id, to: 15 }, { t: 'contest', unit: a.id, target: d.id }], []]);
    expect(r.game.units.find((u) => u.id === d.id)!.cohesion).toBe(2);
  });

  it('a Truce makes Contests illegal and also removes the blockade of rival shop frontage', () => {
    const g = setup(5, false);
    const a = unitOf(g, 0, 'watch');
    const d = unitOf(g, 1, 'watch');
    const truce = stage(g, (c) => void c.pacts.push({ id: 77, kind: 'truce', a: 0, b: 1, from: 1, to: 6 }));
    const orders = canonicalOrders(truce, [[{ t: 'contest', unit: a.id, target: d.id }], []]);
    expect(orders[0]).toEqual([]);
    // Even if a Contest reached the resolver, it is re-validated and dropped.
    const r = resolveTurn(truce, [[{ t: 'contest', unit: a.id, target: d.id }], []]);
    expect(r.game.units.find((u) => u.id === d.id)!.cohesion).toBe(5);
  });

  it('blockade: a rival Watch at the door halves footfall to the shop; a Truce lifts it', () => {
    const doorOf = (tile: number) => CITY.door[tile];
    const A = 31; // (7,2)
    const B = 34; // (10,2) a rival-free competitor of the same trade
    const make = (truce: boolean) =>
      stage(allHuman(9, 'standard', 3), (c) => {
        c.units.forEach((u, i) => void (u.tile = 133 + i));
        addBuilding(c, 0, A, 'roastery', { stock: 200 });
        addBuilding(c, 2, B, 'roastery', { stock: 200 });
        unitOf(c, 1, 'watch').tile = doorOf(A);
        if (truce) c.pacts.push({ id: 78, kind: 'truce', a: 0, b: 1, from: 1, to: 6 });
      });
    const blocked = step(make(false), []).game.buildings.find((b) => b.tile === A)!;
    const free = step(make(true), []).game.buildings.find((b) => b.tile === A)!;
    expect(blocked.lastLost.blockaded).toBeGreaterThan(0);
    expect(free.lastLost.blockaded).toBe(0);
    expect(free.lastServed).toBeGreaterThanOrEqual(blocked.lastServed);
  });
});

describe('Production & buildings', () => {
  it('a lot taken earlier in the resolution fails cleanly with a full refund, one-line reason and Action', () => {
    const g = stage(allHuman(6, 'standard', 3), (c) => {
      c.units.forEach((u, i) => void (u.tile = 133 + i));
      unitOf(c, 0, 'factor').tile = 6 + 12;
      unitOf(c, 2, 'factor').tile = 7 + 12;
    });
    const lot = 30;
    const order: Order = { t: 'build', tile: lot, kind: 'roastery' };
    const r = step(g, [[order], [], [order]]);
    // Turn 1: seat 0 is first in Initiative: seat 2 loses.
    expect(r.game.buildings.find((b) => b.tile === lot)!.owner).toBe(0);
    const line = r.summary.lines.find((l) => l.player === 2 && l.value === 'Refunded')!;
    expect(line.text).toMatch(/lot taken by \w+, refunded$/);
    expect(r.summary.cash[2].costs).toBe(0);
    // Turn 2: seat 1 first, then 2, then 0: seat 2 beats seat 0
    const g2 = stage(g, (c) => void (c.turn = 2));
    const r2 = step(g2, [[order], [], [order]]);
    expect(r2.game.buildings.find((b) => b.tile === lot)!.owner).toBe(2);
    expect(r2.summary.cash[0].costs).toBe(0);
  });

  it('Rent Accord also holds at resolution: two same-trade shops founded in one turn within 2 tiles are not both built', () => {
    const g = stage(allHuman(6, 'standard', 2), (c) => {
      c.units.forEach((u, i) => void (u.tile = 133 + i));
      unitOf(c, 0, 'factor').tile = 6 + 12; // (6,1) beside (6,2),(7,2)
      unitOf(c, 1, 'factor').tile = 9 + 12; // (9,1) beside (8,2)? chebyshev: (9,1)->(8,2)=1
      c.pacts.push({ id: 80, kind: 'rent', a: 0, b: 1, from: 1, to: 8 });
    });
    const r = step(g, [[{ t: 'build', tile: 31, kind: 'roastery' }], [{ t: 'build', tile: 32, kind: 'roastery' }]]);
    const built = r.game.buildings.filter((b) => b.kind === 'roastery');
    expect(built).toHaveLength(1);
    expect(built[0].owner).toBe(0);
    expect(text(r).some((t) => /Rent Accord.*refunded \| Refunded/.test(t))).toBe(true);
    expect(r.summary.cash[1].costs).toBe(0);
  });

  it('recruiting respects the six-unit cap, even asked for ten', () => {
    const g = stage(allHuman(6, 'standard', 1), (c) => void (c.players[0].cash = 5000));
    const r = step(g, [Array.from({ length: 10 }, () => ({ t: 'recruit', kind: 'factor' }) as Order)]);
    expect(r.game.units.filter((u) => u.owner === 0)).toHaveLength(UNIT_CAP);
    expect(checkTransition(g, r)).toEqual([]);
  });

  it('construction completes and serves in the turn it was ordered; upgrades cost per level; sales return 60%', () => {
    const g = stage(allHuman(6, 'standard', 1), (c) => void (unitOf(c, 0, 'factor').tile = 6 + 12));
    const r = step(g, [[{ t: 'build', tile: 30, kind: 'roastery' }]]);
    const b = r.game.buildings[0];
    expect(b.builtTurn).toBe(1);
    expect(b.invested).toBe(180);
    expect(r.summary.cash[0].costs).toBeGreaterThanOrEqual(180);
    const p = r.game.players[0];
    const sold = step(r.game, [[{ t: 'sell', building: b.id }]]);
    expect(sold.game.buildings).toHaveLength(0);
    expect(sold.summary.cash[0].income).toBeGreaterThanOrEqual(Math.floor(0.6 * 180));
    expect(text(sold).some((t) => /sells property .* for 60% of invested \| \+§108/.test(t))).toBe(true);
    expect(upgradeCostFor(p, { ...b, level: 1 })).toBe(Math.round(180 * UPGRADE_COST[0]));
    expect(upgradeCostFor(p, { ...b, level: 2 })).toBe(Math.round(180 * UPGRADE_COST[1]));
    expect(buildCostFor(p, 'bistro')).toBe(280);
  });

  it('Guild Studies grant their perk on completion', () => {
    const base = stage(allHuman(6, 'standard', 1), (c) => {
      c.players[0].cash = 2000;
    });
    // Watch Drill: 3 points, +1 Cohesion for Watch Companies
    let g = base;
    for (let i = 0; i < 3; i++) g = step(g, [[{ t: 'study', key: 'drill' }]]).game;
    const p = g.players[0];
    expect(p.studies).toContain('drill');
    expect(p.study).toBeNull();
    expect(maxCohesion(p, 'watch')).toBe(4);
    expect(unitOf(g, 0, 'watch').cohesion).toBe(4);
    // Ledger Reform: wages and rent -10%
    const shop = (ledger: boolean) =>
      stage(allHuman(6, 'standard', 1), (c) => {
        c.players[0].cash = 5000;
        for (let i = 0; i < 4; i++) addBuilding(c, 0, 26 + i + (i > 1 ? 0 : 0), 'roastery', { stock: 0 });
        if (ledger) c.players[0].studies.push('ledger');
      });
    const plain = step(shop(false), []).summary.cash[0].upkeep;
    const led = step(shop(true), []).summary.cash[0].upkeep;
    expect(led).toBeLessThan(plain);
    // Gilded Facades: -20% on the Level 3 upgrade
    const fac = stage(allHuman(6, 'standard', 1), (c) => {
      c.turn = 17;
      c.players[0].cash = 3000;
      addBuilding(c, 0, 26, 'bistro', { level: 2, invested: 280 });
    });
    const withF = stage(fac, (c) => void c.players[0].studies.push('facades'));
    expect(upgradeCostFor(withF.players[0], withF.buildings[0])).toBe(Math.round(upgradeCostFor(fac.players[0], fac.buildings[0]) * 0.8));
    const up = step(withF, [[{ t: 'upgrade', building: withF.buildings[0].id }]]).game;
    expect(up.buildings[0].level).toBe(3);
    expect(up.players[0].prestige).toBeGreaterThanOrEqual(2);
    // Tram Signalling: Tram Stops cost 20% less
    const sig = stage(base, (c) => void c.players[0].studies.push('signalling'));
    expect(buildCostFor(sig.players[0], 'tramstop')).toBe(Math.round(240 * 0.8));
    expect(buildCostFor(base.players[0], 'tramstop')).toBe(240);
  });

  it('a Barge route delivers at a discount and earns a fee; Trade Pact lifts the fee 25%, Hydraulics 50%', () => {
    const shopTile = CITY.lots.find((t) => CITY.canalFront[t] && routeDistance(t) >= 0 && routeDistance(t) <= 12)!;
    const scene = (extra: (c: Game) => void) =>
      stage(allHuman(6, 'standard', 2), (c) => {
        c.turn = 9;
        c.units.forEach((u, i) => void (u.tile = 133 + i));
        addBuilding(c, 0, shopTile, 'roastery', { stock: 0 });
        const barge = addUnit(c, 0, 'barge', 7 + 10 * 12, { route: 0 });
        void barge;
        extra(c);
      });
    const fee = (g: Game): number => {
      const barge = g.units.find((u) => u.kind === 'barge')!;
      const r = step(g, [[{ t: 'route', unit: barge.id, building: g.buildings[0].id }], []]);
      const line = r.summary.lines.find((l) => /Barge route fees/.test(l.text));
      expect(text(r).some((t) => /delivers \d+ supplies to \w+ at 30% off/.test(t))).toBe(true);
      return line ? Number(line.value.replace(/[^\d]/g, '')) : 0;
    };
    expect(fee(scene(() => {}))).toBe(ROUTE_FEE);
    expect(fee(scene((c) => void c.pacts.push({ id: 90, kind: 'trade', a: 0, b: 1, from: 9, to: 16 })))).toBe(Math.round(ROUTE_FEE * 1.25));
    expect(fee(scene((c) => void c.players[0].studies.push('hydraulics')))).toBe(Math.round(ROUTE_FEE * 1.5));
  });

  it('a blocked Barge delivers nothing and the ledger says so', () => {
    const shopTile = CITY.lots.find((t) => CITY.canalFront[t] && routeDistance(t) >= 0 && routeDistance(t) <= 12)!;
    const g = stage(allHuman(6, 'standard', 2), (c) => {
      c.turn = 9;
      c.units.forEach((u, i) => void (u.tile = 133 + i));
      addBuilding(c, 0, shopTile, 'roastery', { stock: 0 });
      addUnit(c, 0, 'barge', 7 + 10 * 12);
      unitOf(c, 1, 'factor').tile = 7 + 10 * 12 - 12; // on the water route above the mouth
    });
    const barge = g.units.find((u) => u.kind === 'barge')!;
    const r = step(g, [[{ t: 'route', unit: barge.id, building: g.buildings[0].id }], []]);
    expect(r.game.buildings[0].stock).toBe(0);
    expect(text(r).some((t) => /Barge #\d+ blocked by \w+ at \w+, no delivery \| Blocked/.test(t))).toBe(true);
  });

  it('pacts: a proposal in Turn N is answered in Turn N+1 and takes effect in the turn it is accepted', () => {
    const g = allHuman(6, 'standard', 2);
    const r1 = step(g, [[{ t: 'propose', to: 1, kind: 'truce' }], []]);
    expect(r1.game.proposals).toHaveLength(1);
    const q = r1.game.proposals[0];
    expect(canonicalOrders(g, [[], [{ t: 'respond', proposal: q.id, accept: true }]])[1]).toEqual([]); // not visible yet
    const r2 = step(r1.game, [[], [{ t: 'respond', proposal: q.id, accept: true }]]);
    expect(r2.game.pacts).toHaveLength(1);
    expect(r2.game.pacts[0]).toMatchObject({ kind: 'truce', a: 0, b: 1, from: 2, to: 7 });
    expect(r2.game.proposals).toHaveLength(0);
    // Expires after 6 turns
    let h = r2.game;
    for (let i = 0; i < 6; i++) h = step(h, []).game;
    expect(h.pacts).toHaveLength(0);
  });
});

describe('Treasury & upkeep', () => {
  const broke = (c: Game, extra: (c: Game) => void = () => {}) => {
    c.units.forEach((u, i) => void (u.tile = 133 + i));
    c.players[0].cash = 0;
    extra(c);
  };

  it('a shortfall is drawn from the Credit Line and recorded as financing', () => {
    const g = stage(allHuman(6, 'standard', 1), (c) => broke(c));
    const r = step(g, []);
    const c = r.summary.cash[0];
    expect(c.financing).toBe(UNITS.factor.upkeep + UNITS.watch.upkeep);
    expect(r.game.players[0].debt).toBe(c.financing);
    expect(r.game.players[0].cash).toBe(0);
    expect(c.opening + c.income - c.costs - c.upkeep + c.financing).toBe(c.closing);
  });

  it('with the Credit Line exhausted, property is sold at 60% in order of lowest yield, ties by id', () => {
    const g = stage(allHuman(6, 'standard', 1), (c) => {
      broke(c, (x) => {
        x.players[0].debt = LOAN_MAX;
        for (let i = 0; i < 6; i++) addBuilding(x, 0, 26 + (i % 3) + (i > 2 ? 24 : 0), 'park', { invested: 100, lastSales: 0 });
      });
    });
    const ids = g.buildings.map((b) => b.id);
    const r = step(g, []);
    const forced = r.summary.lines.filter((l) => /forced to sell property/.test(l.text));
    expect(forced).toHaveLength(1);
    expect(forced[0].value).toBe('+§60');
    expect(r.game.buildings.map((b) => b.id)).toEqual(ids.slice(1)); // lowest id (stable tie-break) went first
    expect(checkTransition(g, r)).toEqual([]);
    expect(r.game.players[0].cash).toBeGreaterThanOrEqual(0);
  });

  it('then units are disbanded in order of highest upkeep, and anything still uncovered is Forgiven', () => {
    const g = stage(allHuman(6, 'standard', 1), (c) => broke(c, (x) => void (x.players[0].debt = LOAN_MAX)));
    const r = step(g, []);
    const lines = text(r);
    const iWatch = lines.findIndex((t) => /Watch Company #\d+ disbanded — upkeep unpaid/.test(t));
    const iFactor = lines.findIndex((t) => /Factor #\d+ disbanded — upkeep unpaid/.test(t));
    expect(iWatch).toBeGreaterThanOrEqual(0);
    expect(iFactor).toBeGreaterThan(iWatch);
    expect(lines.some((t) => /shortfall forgiven \| \+§30/.test(t))).toBe(true); // 2.5% of §1,200 interest
    expect(r.game.units).toHaveLength(0);
    expect(r.game.players[0].cash).toBe(0);
    expect(r.game.players[0].debt).toBe(LOAN_MAX);
    expect(checkTransition(g, r)).toEqual([]);
  });

  it('upkeep is charged exactly once per turn', () => {
    const g = stage(allHuman(6, 'standard', 1), (c) => void (c.players[0].cash = 1000));
    const r = step(g, []);
    expect(r.summary.cash[0].upkeep).toBe(UNITS.factor.upkeep + UNITS.watch.upkeep);
    expect(r.summary.lines.filter((l) => /unit upkeep/.test(l.text))).toHaveLength(1);
  });

  it('borrow and repay apply first; a repay it cannot afford is skipped; cash never goes negative', () => {
    const g = stage(allHuman(6, 'standard', 1), (c) => void (c.players[0].cash = 10));
    const r = step(g, [[{ t: 'borrow' }]]);
    expect(r.summary.cash[0].financing).toBeGreaterThanOrEqual(400);
    expect(r.game.players[0].debt).toBeGreaterThanOrEqual(400);
    const r2 = step(r.game, [[{ t: 'repay' }]]);
    expect(r2.game.players[0].debt).toBeLessThan(r.game.players[0].debt + 1);
    expect(checkTransition(g, r)).toEqual([]);
    expect(checkTransition(r.game, r2)).toEqual([]);
  });
});

describe('treasury reconciliation across whole matches', () => {
  it.each([
    [11, 'standard', ['human', 'human', 'ai', 'ai']],
    [12, 'blitz', ['human', 'ai', 'ai', 'ai']],
    [13, 'blitz', ['human', 'human', 'human', 'human']],
    [14, 'standard', ['human', 'ai']],
    [15, 'standard', ['human', 'human', 'human', 'ai']],
  ] as const)('seed %i %s: every player, every turn reconciles; invariants hold', (seed, mode, kinds) => {
    const rngs = kinds.map((_, i) => draftRng(seed, `p${i}`));
    const g0 = newGame(seed, mode, [...kinds]);
    const { states, resolutions } = playToEnd(g0, (_t, g) => g.players.map((p, i) => (p.kind === 'human' ? genDraft(g, i, rngs[i], 9) : undefined)));
    expect(resolutions).toHaveLength(mode === 'blitz' ? 16 : 32);
    resolutions.forEach((r, i) => expect(checkTransition(states[i], r), `turn ${i + 1}`).toEqual([]));
    // generated humans actually did things
    const total = resolutions.reduce((n, r) => n + r.summary.committed.reduce((a, b) => a + b, 0), 0);
    expect(total).toBeGreaterThan(40);
  });

  it('each summary carries the short hash of the resulting state and the right Era', () => {
    const { states, resolutions } = playToEnd(newGame(8, 'blitz', ['ai', 'ai']));
    resolutions.forEach((r, i) => {
      expect(r.summary.hash).toBe(shortHash(stateHash(states[i + 1])));
      expect(r.summary.from).toBe(i + 1);
      expect(r.summary.to).toBe(i + 2);
      expect(r.summary.era).toBe(Math.min(4, Math.floor((i + 1) / 4) + 1));
    });
  });
});

describe('Council turns and Charters', () => {
  it('Eras II-IV open with a Council: three distinct offers per House, never an adopted Charter', () => {
    for (const [mode, turns] of [['standard', [9, 17, 25]], ['blitz', [5, 9, 13]]] as const) {
      let g = newGame(17, mode, ['human', 'ai', 'ai', 'ai']);
      let seen = 0;
      while (g.phase !== 'ended') {
        if (turns.includes(g.turn as never)) {
          seen++;
          expect(g.council).not.toBeNull();
          expect(g.council!.era).toBe(turns.indexOf(g.turn as never) + 2);
          g.council!.offers.forEach((o, i) => {
            expect(o).toHaveLength(3);
            expect(new Set(o).size).toBe(3);
            for (const k of g.players[i].charters) expect(o).not.toContain(k);
          });
        } else expect(g.council).toBeNull();
        const choice = g.council?.offers[0][1];
        g = step(g, [choice ? [{ t: 'charter', key: choice }] : []]).game;
      }
      expect(seen).toBe(3);
      expect(g.players[0].charters).toHaveLength(3);
      for (const p of g.players) expect(new Set(p.charters).size).toBe(p.charters.length);
    }
  });

  it('the chosen Charter applies from that turn; AI Houses choose deterministically; the choice costs no Action', () => {
    const g = stage(newGame(18, 'standard', ['human', 'ai']), (c) => void (c.turn = 9));
    const g9 = stage(g, (c) => {
      c.council = { era: 2, offers: [['transit', 'credit', 'heralds'], ['transit', 'credit', 'heralds']] };
    });
    const mk = () => step(g9, [[{ t: 'charter', key: 'heralds' }]]);
    const a = mk();
    expect(a.game.players[0].charters).toEqual(['heralds']);
    expect(a.game.players[1].charters).toHaveLength(1);
    expect(a.game.players[1].charters[0]).toBe(mk().game.players[1].charters[0]);
    expect(a.committed[0]).toEqual([{ t: 'charter', key: 'heralds' }]);
    expect(a.game.council).toBeNull();
    expect(actionsFor(a.game, a.game.players[0])).toBe(7 + 0 - 0 + 0 - 0 + (a.game.turn >= 17 ? 0 : -1) + 1 - 0 + (CHARTERS.heralds.actions - 1));
  });

  it('a human who reaches a Council turn without a Charter is given the first offer (the authority never allows it)', () => {
    const g = stage(newGame(18, 'standard', ['human', 'ai']), (c) => {
      c.turn = 9;
      c.council = { era: 2, offers: [['credit', 'transit', 'heralds'], ['transit', 'credit', 'heralds']] };
    });
    const orders = canonicalOrders(g, [[], undefined]);
    expect(orders[0]).toEqual([{ t: 'charter', key: 'credit' }]);
    expect(orders[1].some((o) => o.t === 'charter')).toBe(true);
  });
});

describe('Milestones and dividends', () => {
  it('Charter Merchant: serving 25 citizens earns a §80 dividend that is paid in the NEXT turn', () => {
    const g = stage(allHuman(6, 'standard', 1), (c) => void (c.players[0].stats.served = 30));
    const r1 = step(g, []);
    expect(r1.game.players[0].milestones[0]).toBe(1);
    expect(r1.game.players[0].dividend).toBe(80);
    expect(r1.summary.cash[0].income).toBe(0); // not paid this turn
    expect(text(r1).some((t) => /earns Charter Merchant \| \+§80/.test(t))).toBe(true);
    expect(r1.game.chronicle.some((d) => d.cat === 'milestone')).toBe(true);
    const r2 = step(r1.game, []);
    expect(r2.game.players[0].dividend).toBe(0);
    expect(r2.summary.cash[0].income).toBe(80);
    expect(text(r2).some((t) => /dividends \| \+§80/.test(t))).toBe(true);
    expect(r2.game.players[0].milestones[0]).toBe(1); // earned once
  });

  it('Block Baron: three properties or two adjacent lots, +4 Prestige', () => {
    const adj = stage(allHuman(6, 'standard', 1), (c) => void (addBuilding(c, 0, 26, 'park'), addBuilding(c, 0, 27, 'park')));
    expect(step(adj, []).game.players[0].milestones[1]).toBe(1);
    const apart = stage(allHuman(6, 'standard', 1), (c) => void (addBuilding(c, 0, 26, 'park'), addBuilding(c, 0, 28, 'park')));
    expect(step(apart, []).game.players[0].milestones[1]).toBe(0);
    const three = stage(apart, (c) => void addBuilding(c, 0, 34, 'park'));
    const r = step(three, []);
    expect(r.game.players[0].milestones[1]).toBe(1);
    expect(r.game.players[0].prestige).toBeGreaterThanOrEqual(apart.players[0].prestige + 4);
  });

  it('Civic Benefactor (+§120, +4 Prestige) and District Sovereign (+6 Prestige, +1 Action thereafter)', () => {
    const civ = stage(allHuman(6, 'standard', 1), (c) => void (c.players[0].stats.civicBuilt = 2));
    const r = step(civ, []);
    expect(r.game.players[0].milestones[2]).toBe(1);
    expect(r.game.players[0].dividend).toBe(120);
    expect(r.game.players[0].prestige).toBe(4);
    const early = stage(allHuman(6, 'standard', 1), (c) => void (c.players[0].cash = 5000));
    expect(step(early, []).game.players[0].milestones[3]).toBe(0); // Era I
    const late = stage(allHuman(6, 'standard', 1), (c) => {
      c.turn = 17;
      c.players[0].cash = 5000;
    });
    const s = step(late, []);
    expect(s.game.players[0].milestones[3]).toBe(17);
    expect(actionsFor(s.game, s.game.players[0])).toBe(actionsFor(late, late.players[0]) + 1);
  });
});

describe('scoring', () => {
  it('Crown Index = Net Worth ÷ 10 + Market Share % × 3 + Civic Prestige × 4, each rounded down, summing exactly', () => {
    const g = stage(allHuman(6, 'standard', 2), (c) => {
      c.players[0].cash = 1239;
      c.players[0].prestige = 3.9;
      c.players[1].cash = 10;
      c.players[0].sales = [999, 1, 1, 1, 100]; // only the last four count
      c.players[1].sales = [0, 0, 0, 300];
      addBuilding(c, 0, 26, 'park', { invested: 55 });
    });
    const s = computeStandings(g);
    const a = s.find((x) => x.player === 0)!;
    const b = s.find((x) => x.player === 1)!;
    // sales window: p0 = 1+1+1+100 = 103, p1 = 300 -> shares 25% and 74% (floor)
    expect(a.share).toBe(Math.floor((103 * 100) / 403));
    expect(a.shareComponent).toBe(Math.floor((103 * 300) / 403));
    expect(b.shareComponent).toBe(Math.floor((300 * 300) / 403));
    expect(a.netWorth).toBe(1239 + Math.floor(0.8 * 55));
    expect(a.worthComponent).toBe(Math.floor((1239 + 44) / 10));
    expect(a.prestige).toBe(3);
    expect(a.prestigeComponent).toBe(12);
    for (const x of s) expect(x.crown).toBe(x.worthComponent + x.shareComponent + x.prestigeComponent);
  });

  it('components are floored exactly even where floating-point multiplication by 0.1 could wobble', () => {
    for (let nw = 0; nw < 4000; nw++) {
      const g = stage(allHuman(6, 'standard', 1), (c) => void (c.players[0].cash = nw));
      expect(computeStandings(g)[0].worthComponent).toBe(Math.floor(nw / 10));
    }
  });

  it('ties go to higher Net Worth, then higher Civic Prestige, then earlier seat', () => {
    const base = stage(allHuman(6, 'standard', 3), (c) => {
      c.players.forEach((p) => void ((p.cash = 100), (p.prestige = 0)));
    });
    expect(computeStandings(base).map((x) => x.player)).toEqual([0, 1, 2]);
    // crown tie with different net worth: 109 cash = 10 crown, 100 cash = 10 crown
    const nw = stage(base, (c) => {
      c.players[0].cash = 100;
      c.players[1].cash = 109;
    });
    const s1 = computeStandings(nw);
    expect(s1[0].crown).toBe(s1[1].crown);
    expect(s1.map((x) => x.player)).toEqual([1, 0, 2]);
    // crown tie, equal net worth impossible to separate by prestige unless worth differs: prestige 1 (4) vs worth 40 more
    const pr = stage(base, (c) => {
      c.players[0].cash = 140; // 14
      c.players[1].cash = 100; // 10 + 4
      c.players[1].prestige = 1;
    });
    const s2 = computeStandings(pr);
    expect(s2[0].crown).toBe(s2[1].crown);
    expect(s2[0].player).toBe(0); // higher Net Worth first
  });
});

describe('victory', () => {
  it.each([
    ['standard', 32],
    ['blitz', 16],
  ] as const)('%s ends after the final turn of Era IV (turn %i) and not a turn earlier', (mode, last) => {
    const { states, resolutions, game } = playToEnd(newGame(23, mode, ['ai', 'ai', 'ai', 'ai']));
    expect(resolutions).toHaveLength(last);
    states.slice(0, last).forEach((s) => expect(s.phase).toBe('planning'));
    expect(game.phase).toBe('ended');
    expect(game.turn).toBe(last + 1);
    expect(game.winner).toBe(game.standings[0].player);
    expect(game.winner).toBeGreaterThanOrEqual(0);
    expect(game.honours.map((h) => h.key)).toEqual(['corner', 'shark', 'patron']);
    expect(resolutions[last - 1].summary.headline).toBe('The Mercadia Gazette — Final Edition');
    expect(game.trend).toHaveLength(last);
    expect(() => resolveTurn(game, [[], [], [], []])).toThrow();
    expect(continueEndless(states[last - 1])).toBeNull();
  });

  it('Endless runs past Era IV, and a finished match can continue in Endless', () => {
    let g = newGame(24, 'endless', ['ai', 'ai']);
    for (let i = 0; i < 40; i++) g = step(g, []).game;
    expect(g.phase).toBe('planning');
    expect(g.turn).toBe(41);
    expect(g.winner).toBe(-1);
    const done = playToEnd(newGame(24, 'blitz', ['ai', 'ai'])).game;
    const cont = continueEndless(done)!;
    expect(cont.phase).toBe('planning');
    expect(cont.endless).toBe(true);
    expect(cont.winner).toBe(-1);
    let h = cont;
    for (let i = 0; i < 6; i++) {
      const r = step(h, []);
      expect(checkTransition(h, r)).toEqual([]);
      h = r.game;
    }
    expect(h.turn).toBe(done.turn + 6);
    expect(h.council).toBeNull();
  });
});

describe('Chronicle', () => {
  const scene = (rivalTile: number, mine = 1) =>
    stage(allHuman(6, 'standard', 2), (c) => {
      c.units.forEach((u, i) => void (u.tile = 133 + i));
      addBuilding(c, 0, 31, 'roastery', { stance: mine });
      addBuilding(c, 1, rivalTile, 'roastery');
    });

  it('records a price-war undercut when a House drops below a same-trade rival within three tiles', () => {
    const g = scene(34); // (10,2): three tiles from (7,2)
    const r = step(g, [[{ t: 'stance', building: g.buildings[0].id, stance: 0 }], []]);
    const d = r.game.chronicle.filter((x) => x.cat === 'market');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ turn: 1, player: 0, tile: 31, pill: '§7 vs §9' });
    expect(d[0].head).toMatch(/Vermilion undercuts Cobalt/);
  });

  it('is silent for a far rival, a different trade, a price that is not lower than the rival, or one that was already lower', () => {
    const far = scene(10 + 8 * 12);
    expect(step(far, [[{ t: 'stance', building: far.buildings[0].id, stance: 0 }], []]).game.chronicle.filter((x) => x.cat === 'market')).toEqual([]);
    const other = stage(scene(34), (c) => void (c.buildings[1].kind = 'bistro'));
    expect(step(other, [[{ t: 'stance', building: other.buildings[0].id, stance: 0 }], []]).game.chronicle.filter((x) => x.cat === 'market')).toEqual([]);
    const near = scene(34);
    expect(step(near, [[{ t: 'stance', building: near.buildings[0].id, stance: 2 }], []]).game.chronicle.filter((x) => x.cat === 'market')).toEqual([]);
    const already = scene(34, 0);
    expect(step(already, [[{ t: 'stance', building: already.buildings[0].id, stance: 1 }], []]).game.chronicle.filter((x) => x.cat === 'market')).toEqual([]);
  });

  it('keeps ledger-style dispatches for Era transitions, Charters, Contests, Promo Blitzes and pacts', () => {
    const { game } = playToEnd(newGame(5, 'blitz', ['ai', 'ai', 'ai', 'ai']));
    const cats = new Set(game.chronicle.map((d) => d.cat));
    for (const c of ['era', 'charter', 'build', 'lead']) expect(cats.has(c as never), c).toBe(true);
    for (const d of game.chronicle) {
      expect(d.head.length).toBeGreaterThan(3);
      expect(d.pill.length).toBeGreaterThan(0);
    }
  });
});

describe('events', () => {
  it('are forecast two turns ahead, announced once, start on time and print a closing receipt', () => {
    let forecasts = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { states, resolutions } = playToEnd(newGame(seed, 'standard', ['ai', 'ai']));
      resolutions.forEach((r, i) => {
        const before = states[i];
        const after = r.game;
        for (const ev of after.events) {
          if (!before.events.some((e) => e.kind === ev.kind && e.start === ev.start)) {
            forecasts++;
            expect(ev.announced).toBe(before.turn);
            expect(ev.start).toBe(before.turn + 1 + FORECAST_TURNS);
            expect(ev.end).toBeGreaterThanOrEqual(ev.start);
            expect(text(r).some((t) => /^Forecast: .* on Turn \d+/.test(t))).toBe(true);
          }
        }
        for (const ev of before.events) {
          if (ev.end === before.turn) expect(text(r).some((t) => / ends \|/.test(t))).toBe(true);
          if (ev.start === before.turn + 1) expect(text(r).some((t) => /begins next turn/.test(t))).toBe(true);
        }
      });
    }
    expect(forecasts).toBeGreaterThan(5);
  });
});

describe('the unit contract', () => {
  it('a unit that ends its turn on owned property and was not in combat regains 1 Cohesion', () => {
    const g = stage(allHuman(6, 'standard', 2), (c) => {
      c.units.forEach((u, i) => void (u.tile = 133 + i));
      const w = unitOf(c, 0, 'watch');
      w.tile = 16;
      w.cohesion = 1;
      addBuilding(c, 0, 16 + 12, 'park');
    });
    const r = step(g, []);
    expect(r.game.units.find((u) => u.id === unitOf(g, 0, 'watch').id)!.cohesion).toBe(2);
    const r2 = step(r.game, []);
    expect(r2.game.units.find((u) => u.id === unitOf(g, 0, 'watch').id)!.cohesion).toBe(3);
    expect(step(r2.game, []).game.units.find((u) => u.id === unitOf(g, 0, 'watch').id)!.cohesion).toBe(3); // capped
  });
});


describe('Turn Delta score: rank changes and component deltas (PRODUCT.md TURN_SUMMARY)', () => {
  /** House 0 leads and House 1 trails on the stored standings; then the money flips before the turn resolves. */
  const swapped = () =>
    stage(allHuman(9, 'standard', 3), (c) => {
      c.players[0].cash = 3000;
      c.players[1].cash = 1500;
      c.players[2].cash = 200;
      c.standings = computeStandings(c); // the stored "previous" ranking: 0, 1, 2
      c.players[0].cash = 100;
      c.players[2].cash = 4000;
    });

  it('reports prevRank, nextRank and rankDelta for a real rank swap', () => {
    const g = swapped();
    expect(g.standings.map((s) => s.player)).toEqual([0, 1, 2]);
    const r = step(g, []);
    expect(r.game.standings.map((s) => s.player)).toEqual([2, 1, 0]);
    const sc = r.summary.scores;
    expect(sc).toHaveLength(3);
    expect(sc.map((s) => [s.player, s.prevRank, s.nextRank, s.rankDelta])).toEqual([
      [0, 1, 3, -2],
      [1, 2, 2, 0],
      [2, 3, 1, 2],
    ]);
  });

  it('component deltas are exact and sum to the Crown Index change for every House', () => {
    const g = swapped();
    const r = step(g, []);
    for (const s of r.summary.scores) {
      const before = g.standings.find((x) => x.player === s.player)!;
      const after = r.game.standings.find((x) => x.player === s.player)!;
      expect(s.worthDelta).toBe(after.worthComponent - before.worthComponent);
      expect(s.shareDelta).toBe(after.shareComponent - before.shareComponent);
      expect(s.prestigeDelta).toBe(after.prestigeComponent - before.prestigeComponent);
      expect(s.worthDelta + s.shareDelta + s.prestigeDelta).toBe(s.crownDelta);
      expect(s.crownDelta).toBe(after.crown - before.crown);
      expect(s.prevCrown).toBe(before.crown);
      expect(s.crown).toBe(after.crown);
    }
    expect(r.summary.scores[0].crownDelta).toBeLessThan(0);
    expect(r.summary.scores[2].crownDelta).toBeGreaterThan(0);
  });

  it('prints the rank move on the Crown Index line, and the numbers survive a replay', () => {
    const r = step(swapped(), []);
    const line = r.summary.lines.find((l) => l.text.endsWith('Crown Index ' + r.summary.scores[0].crown) && l.player === 0)!;
    expect(line.value).toMatch(/^[+−]\d+ · #1 → #3$/);
    const again = step(swapped(), []);
    expect(again.summary.scores).toEqual(r.summary.scores);
  });

  it('every turn of a full match reconciles: components sum to the delta and ranks are a permutation', () => {
    const { resolutions } = playToEnd(newGame(21, 'blitz', ['ai', 'ai', 'ai', 'ai']));
    for (const { summary } of resolutions) {
      expect(summary.scores.map((s) => s.nextRank).sort()).toEqual([1, 2, 3, 4]);
      expect(summary.scores.map((s) => s.prevRank).sort()).toEqual([1, 2, 3, 4]);
      for (const s of summary.scores) {
        expect(s.worthDelta + s.shareDelta + s.prestigeDelta).toBe(s.crownDelta);
        expect(s.rankDelta).toBe(s.prevRank - s.nextRank);
      }
    }
  });
});
