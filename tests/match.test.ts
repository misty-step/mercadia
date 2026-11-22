import { beforeAll, describe, expect, it } from 'vitest';
import { advance, aiDecide } from '../src/shared/ai';
import { BOOK_VALUE, CIVICS, CROWN, LOAN_MAX, MODES, PAYROLL_TICKS, SHOPS, START_CASH, UPGRADE_COST, isShop } from '../src/shared/constants';
import { CITY } from '../src/shared/map';
import {
  REV_DECAY,
  applyCommand,
  buildResult,
  continueEndless,
  createGame,
  crownIndex,
  daypart,
  dayPhase,
  emptyLedger,
  marketShares,
  netWorth,
  quarterTick,
  rentOf,
  standings,
  tick,
  wageOf,
} from '../src/shared/sim';
import type { Command, Fx, GameState, MatchMode } from '../src/shared/types';
import { ais, build, freeze, fxOf, humans, labGame, run } from './helpers';

describe('Quarter progression', () => {
  it('derives quarter tick, day phase and daypart from the clock', () => {
    const at = (tickNo: number, quarter = 1, quarterTicks = 1500) => ({ tick: tickNo, quarter, quarterTicks });
    expect(quarterTick(at(0))).toBe(0);
    expect(quarterTick(at(1499))).toBe(1499);
    expect(quarterTick(at(1500, 2))).toBe(0);
    expect(quarterTick(at(4000, 3))).toBe(1000);
    expect(dayPhase(at(0))).toBe(0);
    expect(dayPhase(at(750))).toBe(0.5);
    expect(dayPhase(at(3750, 3))).toBe(0.5);
    // Each daypart is a quarter of the day: morning, noon, golden hour, twilight.
    const parts: [number, number][] = [[0, 0], [374, 0], [375, 1], [749, 1], [750, 2], [1124, 2], [1125, 3], [1499, 3]];
    for (const [t, part] of parts) {
      expect(daypart(at(t)), `tick ${t}`).toBe(part);
      expect(daypart(at(t + 3000, 3)), `tick ${t} of Q3`).toBe(part);
      const blitz = Math.floor((t * 2) / 5); // the same instant of a 600-tick Blitz day
      expect(daypart(at(blitz, 1, 600)), `blitz tick ${blitz}`).toBe(part);
    }
    // The closing instant of the final quarter still reads as twilight, never as a fifth daypart.
    expect(dayPhase(at(1500))).toBeLessThan(1);
    expect(daypart(at(1500))).toBe(3);
  });

  it('walks every quarter through the four dayparts in order and starts the next at morning', () => {
    for (const mode of ['blitz', 'standard'] as MatchMode[]) {
      const s = createGame({ seed: 2, mode, players: humans(1) });
      expect(s.quarterTicks).toBe(MODES[mode].quarterTicks);
      expect(daypart(s)).toBe(0);
      const length = [0, 0, 0, 0];
      let prev = 0;
      for (let i = 0; i < s.quarterTicks - 1; i++) {
        tick(s);
        const part = daypart(s);
        expect(part === prev || part === prev + 1).toBe(true);
        expect(quarterTick(s)).toBe(s.tick);
        expect(dayPhase(s)).toBeCloseTo(s.tick / s.quarterTicks, 12);
        length[part]++;
        prev = part;
      }
      expect(prev).toBe(3);
      expect(length.map((n) => Math.round(n / (s.quarterTicks / 4)))).toEqual([1, 1, 1, 1]);
      tick(s);
      expect(s.quarter).toBe(2);
      expect(quarterTick(s)).toBe(0);
      expect(dayPhase(s)).toBe(0);
      expect(daypart(s)).toBe(0);
    }
  });

  it('closes a quarter exactly every quarterTicks, with a quarter fx and a Gazette line', () => {
    const s = createGame({ seed: 2, mode: 'endless', players: humans(2) });
    expect(s.quarter).toBe(1);
    for (let q = 1; q <= 3; q++) {
      run(s, s.quarterTicks - 1);
      expect(s.quarter).toBe(q);
      expect(s.tick).toBe(q * s.quarterTicks - 1);
      s.fx = [];
      tick(s);
      expect(s.tick).toBe(q * s.quarterTicks);
      expect(s.quarter).toBe(q + 1);
      expect(fxOf(s.fx, 'quarter')).toEqual([{ k: 'quarter', q: q + 1 }]);
      const line = s.gazette.find((g) => g.text.startsWith(`Quarter ${q} closes`));
      expect(line).toMatchObject({ tick: s.tick, tone: 'market' });
      expect(line?.text).toContain('Crown Index');
    }
  });

  it('rolls the ledgers: the closed quarter moves to lastLedger, a clean page opens, the total accumulates', () => {
    const s = freeze(labGame({ mode: 'blitz', cash: 5000 }));
    const p = s.players[0];
    const shop = build(s, 0, 3, 6, 'bistro');
    const payrolls = s.quarterTicks / PAYROLL_TICKS;
    run(s, s.quarterTicks - 1);
    expect(p.lastLedger).toEqual(emptyLedger());
    expect(p.ledger.construction).toBe(SHOPS.bistro.cost);
    run(s, 1);
    const q1 = {
      ...emptyLedger(),
      construction: SHOPS.bistro.cost,
      wages: payrolls * wageOf(shop),
      rent: payrolls * rentOf(shop),
    };
    expect(p.lastLedger).toEqual(q1);
    expect(p.ledger).toEqual(emptyLedger());
    expect(p.totalLedger).toEqual(q1);
    // Second quarter: an upgrade and a park.
    expect(applyCommand(s, 0, { c: 'upgrade', id: shop.id }).ok).toBe(true);
    const park = build(s, 0, 4, 6, 'park');
    const upgrade = Math.round(SHOPS.bistro.cost * UPGRADE_COST[0]);
    expect(p.ledger).toEqual({ ...emptyLedger(), construction: upgrade, civic: CIVICS.park.cost });
    expect(p.lastLedger).toEqual(q1);
    expect(p.totalLedger.construction).toBe(SHOPS.bistro.cost + upgrade);
    run(s, s.quarterTicks);
    expect(s.phase).toBe('ended');
    // The final quarter is closed into lastLedger too, so the victory screen can show it.
    expect(p.lastLedger.construction).toBe(upgrade);
    expect(p.lastLedger.civic).toBe(CIVICS.park.cost);
    expect(p.lastLedger.wages).toBe(payrolls * wageOf(shop));
    expect(p.lastLedger.rent).toBeCloseTo(payrolls * (rentOf(shop) + rentOf(park)), 9);
    expect(p.ledger).toEqual(emptyLedger());
    expect(p.totalLedger.wages).toBe(q1.wages + p.lastLedger.wages);
    expect(p.totalLedger.rent).toBeCloseTo(q1.rent + p.lastLedger.rent, 9);
    // The rival's pages stayed blank throughout.
    expect(s.players[1].totalLedger).toEqual(emptyLedger());
  });
});

describe('Win condition', () => {
  it('starts every mode with the right length, opening cash and an empty district', () => {
    const lengths: Record<MatchMode, number> = { blitz: 2, standard: 4, endless: 0 };
    for (const mode of ['blitz', 'standard', 'endless'] as MatchMode[]) {
      const s = createGame({ seed: 77, mode, players: humans(3) });
      expect(s.totalQuarters).toBe(lengths[mode]);
      expect(s.totalQuarters).toBe(MODES[mode].quarters);
      expect(s.endless).toBe(mode === 'endless');
      expect(s).toMatchObject({ seed: 77, tick: 0, quarter: 1, phase: 'playing', result: null, buildings: [] });
      expect(s.players.map((p) => p.id)).toEqual([0, 1, 2]);
      for (const p of s.players) {
        expect(p).toMatchObject({ cash: START_CASH, debt: 0, prestige: 0, kind: 'human', persona: null });
        expect(crownIndex(s, p)).toBe(Math.round(START_CASH * CROWN.netWorth));
      }
    }
    expect(() => createGame({ seed: 1, mode: 'blitz', players: [] })).toThrow();
    expect(() => createGame({ seed: 1, mode: 'blitz', players: humans(5) })).toThrow();
    expect(createGame({ seed: 1, mode: 'blitz', players: ais(['orson']) }).players[0].persona).toBe('orson');
  });

  it('ends a Blitz after two quarters: phase ended, result set, an end fx, and the clock stops', () => {
    const s = createGame({ seed: 8, mode: 'blitz', players: ais(['vesper', 'orson']) });
    const seen: Fx[] = [];
    for (let i = 0; i < 2 * s.quarterTicks - 1; i++) {
      advance(s);
      seen.push(...s.fx.filter((f) => f.k === 'quarter' || f.k === 'end'));
      s.fx = [];
    }
    expect(s.phase).toBe('playing');
    expect(s.result).toBeNull();
    expect(s.quarter).toBe(2);
    expect(seen).toEqual([{ k: 'quarter', q: 2 }]);
    advance(s);
    expect(s.tick).toBe(2 * MODES.blitz.quarterTicks);
    expect(s.phase).toBe('ended');
    expect(s.quarter).toBe(2);
    expect(s.result).not.toBeNull();
    expect(s.fx.filter((f) => f.k === 'quarter' || f.k === 'end')).toEqual([{ k: 'end' }]);
    expect(daypart(s)).toBe(3);
    // Nothing moves after the final bell.
    const frozen = JSON.stringify(s);
    tick(s);
    advance(s);
    run(s, 50);
    expect(JSON.stringify(s)).toBe(frozen);
    expect(aiDecide(s, 0)).toEqual([]);
  });

  describe('a Standard match between four AI tycoons', () => {
    let s: GameState;
    const marks: { tick: number; fx: Fx }[] = [];
    beforeAll(() => {
      s = createGame({ seed: 31, mode: 'standard', players: ais(['vesper', 'aurelia', 'orson', 'aurelia']) });
      let guard = 0;
      while (s.phase === 'playing' && guard++ < 10000) {
        advance(s);
        for (const f of s.fx) if (f.k === 'quarter' || f.k === 'end') marks.push({ tick: s.tick, fx: f });
        s.fx = [];
      }
    });

    it('ends after four quarters and not a tick sooner', () => {
      expect(s.phase).toBe('ended');
      expect(s.tick).toBe(4 * MODES.standard.quarterTicks);
      expect(s.quarter).toBe(4);
      const day = MODES.standard.quarterTicks;
      expect(marks).toEqual([
        { tick: day, fx: { k: 'quarter', q: 2 } },
        { tick: 2 * day, fx: { k: 'quarter', q: 3 } },
        { tick: 3 * day, fx: { k: 'quarter', q: 4 } },
        { tick: 4 * day, fx: { k: 'end' } },
      ]);
    });

    it('names as winner the House at the top of the standings', () => {
      const result = s.result;
      expect(result).not.toBeNull();
      const table = standings(s);
      expect(result?.winner).toBe(table[0].player);
      expect(table.map((r) => r.crown)).toEqual(table.map((r) => r.crown).sort((a, b) => b - a));
      expect(table[0].crown).toBe(Math.max(...s.players.map((p) => crownIndex(s, p))));
      expect(result?.rows.map((r) => r.player)).toEqual([0, 1, 2, 3]);
      for (const row of result?.rows ?? []) {
        const p = s.players[row.player];
        expect(row.crown).toBe(crownIndex(s, p));
        expect(row.crown).toBe(table.find((t) => t.player === p.id)?.crown);
        expect(row.netWorth).toBe(netWorth(s, p));
        expect(row.share).toBe(marketShares(s)[p.id]);
        expect(row.revenue).toBe(Math.round(p.totalLedger.revenue));
        expect(row.served).toBe(p.stats.served);
        expect(row.shops).toBe(s.buildings.filter((b) => b.owner === p.id && isShop(b.kind)).length);
        expect(row.civic).toBe(s.buildings.filter((b) => b.owner === p.id && !isShop(b.kind)).length);
        expect(row.prestige).toBeCloseTo(p.prestige, 1);
      }
      expect(result?.rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1, 9);
      expect(buildResult(s)).toEqual(result);
    });

    it('hands out the three awards to Houses that earned them', () => {
      const awards = s.result?.awards ?? [];
      expect(awards.map((a) => a.key)).toEqual(['corner', 'shark', 'patron']);
      expect(awards.map((a) => a.title)).toEqual(['Corner King', 'Price Shark', 'Civic Patron']);
      const best = (f: (i: number) => number): number => Math.max(...s.players.map((p) => f(p.id)));
      expect(s.players[awards[0].player].stats.cornerRevenue).toBe(best((i) => s.players[i].stats.cornerRevenue));
      expect(s.players[awards[1].player].stats.budgetSales).toBe(best((i) => s.players[i].stats.budgetSales));
      expect(s.players[awards[2].player].prestige).toBe(best((i) => s.players[i].prestige));
      expect(s.players[awards[1].player].persona).toBe('vesper');
    });

    it('rejects every command once the match has ended', () => {
      const before = JSON.stringify(s);
      const mine = s.buildings.find((b) => b.owner === 0 && isShop(b.kind));
      expect(mine).toBeDefined();
      const id = mine?.id ?? -1;
      const free = CITY.lots.find((t) => !s.buildings.some((b) => b.tile === t)) ?? CITY.lots[0];
      const cmds: Command[] = [
        { c: 'build', tile: free, kind: 'park' },
        { c: 'price', id, stance: 2 },
        { c: 'upgrade', id },
        { c: 'promo', id },
        { c: 'restock', id },
        { c: 'auto', id, on: false },
        { c: 'sell', id },
        { c: 'borrow' },
        { c: 'repay' },
      ];
      for (const cmd of cmds) expect(applyCommand(s, 0, cmd), cmd.c).toEqual({ ok: false, err: 'The match is not running' });
      expect(JSON.stringify(s)).toBe(before);
    });
  });
});

describe('Crown Index', () => {
  it('is net worth × weight + market share % × weight + prestige × weight, rounded', () => {
    const s = freeze(labGame({ players: 3, cash: 5000 }));
    const [a, b, c] = s.players;
    build(s, 0, 3, 6, 'cinema');
    build(s, 0, 4, 6, 'park');
    a.cash = 1234;
    a.debt = 400;
    a.prestige = 7.5;
    a.recentRev = 300;
    b.cash = 2000;
    b.recentRev = 100;
    c.cash = 10;
    const worth = Math.round(1234 - 400 + (SHOPS.cinema.cost + CIVICS.park.cost) * BOOK_VALUE);
    expect(netWorth(s, a)).toBe(worth);
    expect(marketShares(s)).toEqual([0.75, 0.25, 0]);
    const crown = (worthOf: number, sharePct: number, prestige: number): number =>
      Math.round(worthOf * CROWN.netWorth + sharePct * CROWN.share + prestige * CROWN.prestige);
    expect(crownIndex(s, a)).toBe(crown(worth, 75, 7.5));
    expect(crownIndex(s, b)).toBe(crown(2000, 25, 0));
    expect(crownIndex(s, c)).toBe(crown(10, 0, 0));
    // Each term pulls its own weight.
    a.prestige += 10;
    expect(crownIndex(s, a)).toBe(crown(worth, 75, 17.5));
    a.prestige -= 10;
    a.cash += 1000;
    expect(crownIndex(s, a)).toBe(crown(worth + 1000, 75, 7.5));
    a.cash -= 1000;
    a.debt += 1000;
    expect(crownIndex(s, a)).toBe(crown(worth - 1000, 75, 7.5));
    a.debt -= 1000;
    b.recentRev = 0;
    expect(crownIndex(s, a)).toBe(crown(worth, 100, 7.5));
    expect(crown(worth, 100, 7.5)).toBeGreaterThan(crown(worth, 75, 7.5));
    expect(standings(s)[0]).toEqual({ player: 0, crown: crownIndex(s, a) });
    expect(standings(s).map((r) => r.crown)).toEqual([crown(worth, 100, 7.5), crown(2000, 0, 0), crown(10, 0, 0)]);
  });

  it('splits market share by recent revenue: shares sum to one, or are all zero before the first sale', () => {
    const fresh = createGame({ seed: 3, mode: 'standard', players: humans(4) });
    expect(marketShares(fresh)).toEqual([0, 0, 0, 0]);
    fresh.players[2].recentRev = 0.3; // not yet a market
    expect(marketShares(fresh)).toEqual([0, 0, 0, 0]);
    fresh.players.forEach((p, i) => (p.recentRev = (i + 1) * 10));
    const shares = marketShares(fresh);
    expect(shares.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12);
    shares.forEach((v, i) => expect(v).toBeCloseTo((i + 1) / 10, 12));
    // Recent revenue fades tick by tick, so share follows current trade, not history.
    const s = freeze(labGame());
    s.players[0].recentRev = 100;
    tick(s);
    expect(s.players[0].recentRev).toBeCloseTo(100 * REV_DECAY, 12);
    run(s, 299);
    expect(s.players[0].recentRev).toBeCloseTo(100 * Math.pow(REV_DECAY, 300), 9);
    expect(REV_DECAY).toBeGreaterThan(0.99);
    expect(REV_DECAY).toBeLessThan(1);
    expect(marketShares(s)).toEqual([1, 0]);
  });

  it('orders the standings by Crown Index and breaks ties by seat', () => {
    const s = labGame({ players: 4, cash: 1000 });
    expect(standings(s).map((r) => r.player)).toEqual([0, 1, 2, 3]);
    expect(buildResult(s).winner).toBe(0);
    s.players[2].prestige = 5;
    s.players[3].cash = 1500;
    s.players[1].debt = 400;
    const table = standings(s);
    expect(table.map((r) => r.player)).toEqual([3, 2, 0, 1]);
    for (const row of table) expect(row.crown).toBe(crownIndex(s, s.players[row.player]));
    expect(buildResult(s).winner).toBe(3);
  });
});

describe('Awards', () => {
  it('gives Corner King, Price Shark and Civic Patron to the leaders of each tally', () => {
    const s = labGame({ players: 4 });
    const corner = [10, 512.4, 20, 0];
    const budget = [0, 3, 40, 1];
    const prestige = [5, 0, 2, 30.4];
    s.players.forEach((p, i) => {
      p.stats.cornerRevenue = corner[i];
      p.stats.budgetSales = budget[i];
      p.prestige = prestige[i];
    });
    const { awards } = buildResult(s);
    expect(awards).toHaveLength(3);
    expect(awards[0]).toMatchObject({ key: 'corner', title: 'Corner King', player: 1 });
    expect(awards[0].detail).toContain('512');
    expect(awards[1]).toMatchObject({ key: 'shark', title: 'Price Shark', player: 2 });
    expect(awards[1].detail).toContain('40');
    expect(awards[2]).toMatchObject({ key: 'patron', title: 'Civic Patron', player: 3 });
    expect(awards[2].detail).toContain('30');
    // One House can sweep the board.
    s.players[3].stats.cornerRevenue = 9999;
    s.players[3].stats.budgetSales = 9999;
    expect(buildResult(s).awards.map((a) => a.player)).toEqual([3, 3, 3]);
  });

  it('withholds an award nobody earned and settles ties for the earlier seat', () => {
    const s = labGame({ players: 3 });
    expect(buildResult(s).awards).toEqual([]);
    s.players[1].stats.budgetSales = 7;
    s.players[2].stats.budgetSales = 7;
    const result = buildResult(s);
    expect(result.awards.map((a) => [a.key, a.player])).toEqual([['shark', 1]]);
    // The result table reports what each House holds.
    for (const p of s.players) p.cash = 5000;
    build(s, 2, 3, 6, 'roastery');
    build(s, 2, 4, 6, 'plaza');
    s.players[2].totalLedger.revenue = 1234.6;
    s.players[2].stats.served = 99;
    const row = buildResult(s).rows[2];
    expect(row).toMatchObject({ player: 2, shops: 1, civic: 1, served: 99, revenue: 1235, prestige: CIVICS.plaza.prestige });
    expect(buildResult(s).awards.map((a) => [a.key, a.player])).toEqual([['shark', 1], ['patron', 2]]);
  });
});

describe('Endless', () => {
  it('continues an ended match in Endless: playing again, next quarter, and no second ending', () => {
    const s = createGame({ seed: 8, mode: 'blitz', players: ais(['vesper', 'aurelia', 'orson']) });
    expect(continueEndless(s)).toBe(false); // still running
    while (s.phase === 'playing') advance(s);
    const limit = s.tick;
    const buildings = s.buildings.length;
    const cash = s.players.map((p) => p.cash);
    s.fx = [];
    expect(continueEndless(s)).toBe(true);
    expect(s.phase).toBe('playing');
    expect(s.endless).toBe(true);
    expect(s.result).toBeNull();
    expect(s.quarter).toBe(3);
    expect(s.tick).toBe(limit);
    expect(quarterTick(s)).toBe(0);
    expect(daypart(s)).toBe(0);
    expect(s.fx).toEqual([{ k: 'quarter', q: 3 }]);
    expect(s.buildings).toHaveLength(buildings);
    expect(s.players.map((p) => p.cash)).toEqual(cash);
    // A new day's events are on the calendar.
    expect(s.events).toHaveLength(MODES.blitz.slots.length);
    for (const e of s.events) {
      expect(e.announceAt).toBeGreaterThanOrEqual(limit);
      expect(e.endAt).toBeLessThanOrEqual(limit + s.quarterTicks);
      expect(e.started).toBe(false);
    }
    expect(continueEndless(s)).toBe(false);
    // Commands work again and the simulation runs on, past two more quarter closes.
    const debt = s.players[1].debt;
    expect(applyCommand(s, 1, { c: 'borrow' }).ok).toBe(debt < LOAN_MAX);
    const served = s.players.reduce((a, p) => a + p.stats.served, 0);
    for (let i = 0; i < 2 * s.quarterTicks + 10; i++) advance(s);
    expect(s.tick).toBe(limit + 2 * s.quarterTicks + 10);
    expect(s.phase).toBe('playing');
    expect(s.result).toBeNull();
    expect(s.quarter).toBe(5);
    expect(s.players.reduce((a, p) => a + p.stats.served, 0)).toBeGreaterThan(served);
  });

  it('never ends an Endless Sandbox', () => {
    const s = createGame({ seed: 14, mode: 'endless', players: ais(['orson', 'vesper']) });
    expect(s.totalQuarters).toBe(0);
    const ends: Fx[] = [];
    for (let i = 0; i < 2 * s.quarterTicks + 200; i++) {
      advance(s);
      ends.push(...fxOf(s.fx, 'end'));
      s.fx = [];
    }
    expect(s.phase).toBe('playing');
    expect(s.result).toBeNull();
    expect(ends).toEqual([]);
    expect(s.quarter).toBe(3);
    expect(s.tick).toBe(2 * s.quarterTicks + 200);
    expect(continueEndless(s)).toBe(false);
    // The tycoons keep investing: there is no final stretch to hold back for.
    expect(s.buildings.length).toBeGreaterThan(6);
  });
});
