// Four Eras of the Dynasty: the match clock, the unlock table, and the locks that enforce it.
import { describe, expect, it, vi } from 'vitest';
import {
  BUILD_KINDS,
  DESIRES,
  ERAS,
  ERA_COUNT,
  ERA_POP,
  ERA_UNLOCK,
  HOST_SPEEDS,
  LEVEL3_ERA,
  LEVEL3_NOTICE,
  LOCKED_DESIRE,
  MODES,
  OBJECTIVE,
  POP_TARGET,
  SHOPS,
  SOLO_SPEEDS,
  START_CASH,
  UPGRADE_COST,
  buildCost,
  eraDef,
  eraLabel,
  eraOf,
  eraTitle,
  isUnlocked,
  lockNotice,
  unlocksOf,
} from '../src/shared/constants';
import { CITY, idx } from '../src/shared/map';
import { SPEEDS } from '../src/shared/room';
import { applyCommand, buildingAt, canBuild, closeCouncil, createGame, desireWeights, eraNow, tick } from '../src/shared/sim';
import type { BuildKind, GameState, MatchMode, ShopKind } from '../src/shared/types';
import { ais, atEra, build, clone, freeze, fxOf, humans, labGame, playOut, run } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

describe('Eras: the calendar of a dynasty', () => {
  it('plays four eras in every mode: 150 s each in Standard, 66 s in Blitz, and on past Era IV in Endless', () => {
    expect(MODES.standard).toMatchObject({ name: 'Standard', quarters: 4, quarterTicks: 1500 });
    expect(MODES.blitz).toMatchObject({ name: 'Blitz', quarters: 4, quarterTicks: 660 });
    expect(MODES.endless).toMatchObject({ name: 'Endless', quarters: 0, quarterTicks: 1500 });
    // ~150–180 s per Standard era and ~60–75 s per Blitz era at 1× (ten ticks a second).
    expect(MODES.standard.quarterTicks / 10).toBeGreaterThanOrEqual(150);
    expect(MODES.standard.quarterTicks / 10).toBeLessThanOrEqual(180);
    expect(MODES.blitz.quarterTicks / 10).toBeGreaterThanOrEqual(60);
    expect(MODES.blitz.quarterTicks / 10).toBeLessThanOrEqual(75);
    // A daypart is a whole number of ticks in every mode, so the era chart samples evenly.
    for (const mode of ['blitz', 'standard', 'endless'] as MatchMode[]) expect(Number.isInteger(MODES[mode].quarterTicks / 4)).toBe(true);
    expect(SOLO_SPEEDS).toEqual([0.5, 1, 2, 3]);
    expect(HOST_SPEEDS).toEqual([1, 1.5, 2]);
    expect(SPEEDS).toEqual(HOST_SPEEDS);
    expect(OBJECTIVE).toBe('Lead your House across 4 Eras — highest Crown Index wins');
  });

  it('names the four eras and maps the match clock onto them', () => {
    expect(ERA_COUNT).toBe(4);
    expect(ERAS.map((e) => [e.n, e.roman, e.name])).toEqual([
      [1, 'I', 'Founding Charter'],
      [2, 'II', 'Transit & Trade'],
      [3, 'III', 'Grand Boulevard'],
      [4, 'IV', 'Golden Dynasty'],
    ]);
    for (const e of ERAS) {
      expect(e.short.length).toBeGreaterThan(0);
      expect(e.blurb.length).toBeGreaterThan(10);
    }
    expect([0, 1, 2, 3, 4, 5, 9].map(eraOf)).toEqual([1, 1, 2, 3, 4, 4, 4]);
    expect(eraOf(2.7)).toBe(2);
    expect([1, 2, 3, 4, 7].map(eraLabel)).toEqual(['Era I', 'Era II', 'Era III', 'Era IV', 'Era IV']);
    expect(eraTitle(1)).toBe('Era I: Founding Charter');
    expect(eraTitle(2)).toBe('Era II: Transit & Trade');
    expect(eraTitle(3)).toBe('Era III: Grand Boulevard');
    expect(eraTitle(4)).toBe('Era IV: Golden Dynasty');
    expect(eraDef(12).roman).toBe('IV');
    const s = labGame();
    expect(eraNow(s)).toBe(1);
    for (const era of [2, 3, 4]) expect(eraNow(atEra(labGame(), era))).toBe(era);
    expect(eraNow({ quarter: 9 })).toBe(4);
  });

  it('unlocks exactly: Era I Roastery, Bistro, Pocket Park · Era II Arcade, Nightmarket, Tram Stop · Era III Boutique, Cinema, Festival Plaza', () => {
    expect(ERA_UNLOCK).toEqual({
      roastery: 1, bistro: 1, park: 1,
      arcade: 2, nightmarket: 2, tramstop: 2,
      boutique: 3, cinema: 3, plaza: 3,
    });
    expect(Object.keys(ERA_UNLOCK).sort()).toEqual(BUILD_KINDS.slice().sort());
    expect(unlocksOf(1).sort()).toEqual(['bistro', 'park', 'roastery']);
    expect(unlocksOf(2).sort()).toEqual(['arcade', 'nightmarket', 'tramstop']);
    expect(unlocksOf(3).sort()).toEqual(['boutique', 'cinema', 'plaza']);
    expect(unlocksOf(4)).toEqual([]);
    expect(LEVEL3_ERA).toBe(3);
    for (const k of BUILD_KINDS) {
      for (let q = 1; q <= 6; q++) expect(isUnlocked(k, q), `${k} in quarter ${q}`).toBe(eraOf(q) >= ERA_UNLOCK[k]);
    }
    // Everything is open from Era III on, and stays open in Endless.
    for (const k of BUILD_KINDS) expect(isUnlocked(k, 3) && isUnlocked(k, 4) && isUnlocked(k, 11)).toBe(true);
    expect(lockNotice('arcade')).toBe('Arcade unlocks in Era II: Transit & Trade');
    expect(lockNotice('tramstop')).toBe('Tram Stop unlocks in Era II: Transit & Trade');
    expect(lockNotice('plaza')).toBe('Festival Plaza unlocks in Era III: Grand Boulevard');
    expect(lockNotice('cinema')).toBe('Cinema unlocks in Era III: Grand Boulevard');
    expect(LEVEL3_NOTICE).toBe('Level 3 unlocks in Era III: Grand Boulevard');
  });
});

describe('Era locks are enforced by the simulation', () => {
  // A plain inland lot for shops and parks, and one on the avenue for the Tram Stop.
  const lotFor = (k: BuildKind): number => (k === 'tramstop' ? (CITY.lots.find((t) => CITY.avenueAdj[t] >= 0) as number) : idx(3, 6));

  it('refuses a future-era build with its unlock notice, whatever the purse, and changes nothing', () => {
    for (let era = 1; era <= 4; era++) {
      for (const kind of BUILD_KINDS) {
        const s = freeze(labGame({ era, cash: 5000 }));
        const tile = lotFor(kind);
        const before = JSON.stringify(s);
        const check = canBuild(s, 0, tile, kind);
        const res = applyCommand(s, 0, { c: 'build', tile, kind });
        if (era >= ERA_UNLOCK[kind]) {
          expect(check, `${kind} in era ${era}`).toEqual({ ok: true });
          expect(res.ok, `${kind} in era ${era}`).toBe(true);
          expect(buildingAt(s, tile)).toMatchObject({ kind, owner: 0, level: 1 });
          expect(s.players[0].cash).toBe(5000 - buildCost(kind));
        } else {
          expect(check, `${kind} in era ${era}`).toEqual({ ok: false, err: lockNotice(kind) });
          expect(res, `${kind} in era ${era}`).toEqual({ ok: false, err: lockNotice(kind) });
          expect(JSON.stringify(s)).toBe(before);
          // The lock is the reason given even to a House that could not afford it anyway.
          s.players[0].cash = 0;
          expect(canBuild(s, 0, tile, kind).err).toBe(lockNotice(kind));
        }
      }
    }
  });

  it('opens a locked tool the moment its era begins: locked on the last tick of Era I, buildable once the Council rises', () => {
    const s = freeze(labGame({ cash: 5000, mode: 'blitz' }));
    run(s, s.quarterTicks - 1);
    expect(s.phase).toBe('playing');
    expect(applyCommand(s, 0, { c: 'build', tile: idx(3, 6), kind: 'arcade' })).toEqual({ ok: false, err: lockNotice('arcade') });
    tick(s);
    expect(s.phase).toBe('council');
    // The Council names what the next era unlocks…
    expect(s.council?.unlocked.slice().sort()).toEqual(['arcade', 'nightmarket', 'tramstop']);
    // …but the city is paused: nothing is built while it sits.
    expect(applyCommand(s, 0, { c: 'build', tile: idx(3, 6), kind: 'arcade' })).toEqual({ ok: false, err: 'The Era Council is in session' });
    closeCouncil(s);
    expect(s.quarter).toBe(2);
    expect(applyCommand(s, 0, { c: 'build', tile: idx(3, 6), kind: 'arcade' })).toEqual({ ok: true });
    // Era III trades are still a Council away.
    expect(applyCommand(s, 0, { c: 'build', tile: idx(4, 6), kind: 'boutique' })).toEqual({ ok: false, err: lockNotice('boutique') });
  });

  it('holds shops at Level 2 until the Grand Boulevard: Level 3 is refused with a notice in Eras I and II', () => {
    for (const era of [1, 2]) {
      const s = freeze(labGame({ era, cash: 5000 }));
      const shop = build(s, 0, 3, 6, 'bistro');
      expect(applyCommand(s, 0, { c: 'upgrade', id: shop.id })).toEqual({ ok: true }); // Level 2 is an Era I upgrade
      expect(shop.level).toBe(2);
      const before = JSON.stringify(s);
      expect(applyCommand(s, 0, { c: 'upgrade', id: shop.id })).toEqual({ ok: false, err: LEVEL3_NOTICE });
      expect(JSON.stringify(s)).toBe(before);
      // The same shop, the same purse, in Era III: grand architecture.
      atEra(s, 3);
      const cash = s.players[0].cash;
      s.fx = [];
      expect(applyCommand(s, 0, { c: 'upgrade', id: shop.id })).toEqual({ ok: true });
      expect(shop.level).toBe(3);
      expect(s.players[0].cash).toBe(cash - Math.round(SHOPS.bistro.cost * UPGRADE_COST[1]));
      expect(fxOf(s.fx, 'upgrade')).toEqual([{ k: 'upgrade', b: shop.id, p: 0 }]);
      expect(applyCommand(s, 0, { c: 'upgrade', id: shop.id })).toEqual({ ok: false, err: 'Already at Level 3' });
    }
  });

  it('never lets a locked building or an early Level 3 stand in a full seeded match, in any mode', () => {
    for (const mode of ['standard', 'blitz'] as MatchMode[]) {
      const s = createGame({ seed: 404, mode, players: ais(['orson', 'aurelia', 'vesper', 'orson']) });
      let bad = 0;
      const firstSeen: Partial<Record<BuildKind, number>> = {};
      playOut(s, (g) => {
        for (const b of g.buildings) {
          if (!isUnlocked(b.kind, g.quarter)) bad++;
          if (b.level === 3 && eraNow(g) < LEVEL3_ERA) bad++;
          firstSeen[b.kind] ??= g.quarter;
        }
        g.fx = [];
      });
      expect(bad, mode).toBe(0);
      for (const [kind, quarter] of Object.entries(firstSeen)) expect(quarter, `${mode}: ${kind}`).toBeGreaterThanOrEqual(ERA_UNLOCK[kind as BuildKind]);
      expect(s.phase).toBe('ended');
      expect(s.quarter).toBe(4);
    }
  });
});

describe('Eras change the street', () => {
  it('barely tempts citizens with a trade nobody can serve yet: locked desires weigh LOCKED_DESIRE until their era', () => {
    expect(LOCKED_DESIRE).toBeGreaterThan(0);
    expect(LOCKED_DESIRE).toBeLessThan(1);
    // Twilight: every desire has some pull, so every ratio is defined.
    const weightsIn = (era: number): number[] => {
      const s = labGame({ era });
      s.tick += Math.round(s.quarterTicks * 0.9);
      return desireWeights(s, 'local');
    };
    const open = weightsIn(4);
    expect(open.every((w) => w > 0)).toBe(true);
    for (const era of [1, 2, 3, 4]) {
      const w = weightsIn(era);
      DESIRES.forEach((d, i) => {
        const shop = (Object.keys(SHOPS) as ShopKind[]).find((k) => SHOPS[k].desire === d) as ShopKind;
        expect(w[i] / open[i], `${d} in era ${era}`).toBeCloseTo(era >= ERA_UNLOCK[shop] ? 1 : LOCKED_DESIRE, 9);
      });
    }
    // Era I is a coffee-and-dining street; Era II adds leisure and the night trade; Era III the rest.
    const locked = (era: number): string[] => DESIRES.filter((_, i) => weightsIn(era)[i] < open[i]);
    expect(locked(1).sort()).toEqual(['culture', 'fashion', 'leisure', 'nightlife']);
    expect(locked(2).sort()).toEqual(['culture', 'fashion']);
    expect(locked(3)).toEqual([]);
  });

  it('fills the streets a little more with every era (ERA_POP)', () => {
    expect(ERA_POP).toHaveLength(4);
    for (let i = 1; i < ERA_POP.length; i++) expect(ERA_POP[i]).toBeGreaterThan(ERA_POP[i - 1]);
    expect(ERA_POP[2]).toBe(1);
    // A fresh district opens with the Founding era's quieter crowd.
    for (const mode of ['standard', 'blitz', 'endless'] as MatchMode[]) {
      expect(createGame({ seed: 5, mode, players: humans(1) }).citizens).toHaveLength(Math.round(66 * ERA_POP[0]));
    }
    // The same empty district, the same morning, one era apart each time: the crowd grows.
    const morningCrowd = (era: number): number => {
      const s = labGame({ era, seed: 9 });
      let total = 0;
      for (let i = 0; i < 360; i++) {
        tick(s);
        if (i >= 160) total += s.citizens.length;
      }
      return total / 200;
    };
    const crowd = [1, 2, 3, 4].map(morningCrowd);
    for (let i = 1; i < crowd.length; i++) expect(crowd[i], `era ${i + 1} vs era ${i}`).toBeGreaterThan(crowd[i - 1]);
    expect(crowd[3] / crowd[0]).toBeGreaterThan(1.1);
    // Nobody is conjured: the crowd stays within reach of the morning target for its era.
    crowd.forEach((c, i) => expect(c, `era ${i + 1}`).toBeLessThan(POP_TARGET[0] * ERA_POP[i] + 25));
  });

  it('keeps Endless in the Golden Dynasty for good: everything unlocked, no further Council, the clock still turning', () => {
    const s = createGame({ seed: 61, mode: 'endless', players: humans(2) });
    s.events = [];
    const councils: number[] = [];
    for (let q = 1; q <= 7; q++) {
      run(s, s.quarterTicks);
      if (s.phase === 'council') {
        councils.push(q);
        closeCouncil(s);
      }
      expect(s.phase).toBe('playing');
      expect(s.quarter).toBe(q + 1);
      expect(eraNow(s)).toBe(Math.min(4, q + 1));
    }
    expect(councils).toEqual([1, 2, 3]);
    expect(s.quarter).toBe(8);
    expect(s.result).toBeNull();
    for (const k of BUILD_KINDS) expect(isUnlocked(k, s.quarter)).toBe(true);
    // Each House holds exactly three charters, however long the sandbox runs.
    for (const p of s.players) expect(p.charters).toHaveLength(3);
    // No era dispatch is printed for a fifth, sixth, seventh "era".
    expect(s.chronicle.filter((d) => d.cat === 'era').map((d) => d.head)).not.toContain('Era V');
    expect(s.chronicle.filter((d) => d.cat === 'era' && d.tick > 3 * s.quarterTicks)).toEqual([]);
    const copy: GameState = clone(s);
    expect(applyCommand(copy, 0, { c: 'build', tile: idx(3, 6), kind: 'plaza' }).ok).toBe(START_CASH >= buildCost('plaza'));
  });
});
