import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ERA_DOORS, OPENINGS, VESPER_CIVIC, advance, aiDecide, aiThink, lotAppeal, openingDelay, tradeOutlook } from '../src/shared/ai';
import { BUILD_KINDS, CHARTER_TASTE, LEVEL3_ERA, LOAN_MAX, LOAN_STEP, PROMO_COST, SHOPS, SHOP_KINDS, TRANSIT_RADIUS, isShop, isUnlocked } from '../src/shared/constants';
import { CITY, chebyshev, idx, manhattan, tx, ty } from '../src/shared/map';
import { applyCommand, buildingAt, buildingById, closeCouncil, createGame, eraNow, promoCostFor, queueCap } from '../src/shared/sim';
import type { AiPersona, BuildKind, Command, GameState } from '../src/shared/types';
import { ais, atEra, build, clone, freeze, fxOf, run } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const PERSONAS: AiPersona[] = ['vesper', 'aurelia', 'orson', 'vesper'];
const VESPER = 0;
const AURELIA = 1;
const ORSON = 2;
const VESPER_2 = 3;
const SEEDS = [1, 2, 3, 4, 5];
const flagship = (k: BuildKind): boolean => k === 'bistro' || k === 'boutique';

/** Is this a well-formed, sensible command for this player in this state? Returns a complaint or ''. */
function complaint(s: GameState, player: number, cmd: Command): string {
  const own = (id: number): boolean => buildingById(s, id)?.owner === player;
  switch (cmd.c) {
    case 'build':
      if (CITY.tiles[cmd.tile] !== 'lot') return 'build off a lot';
      if (buildingAt(s, cmd.tile)) return 'build on an occupied lot';
      if (!BUILD_KINDS.includes(cmd.kind)) return 'unknown kind';
      if (cmd.kind === 'tramstop' && CITY.avenueAdj[cmd.tile] < 0) return 'tram stop off the avenue';
      if (!isUnlocked(cmd.kind, s.quarter)) return `${cmd.kind} is locked until a later era`;
      return '';
    case 'price': {
      const b = buildingById(s, cmd.id);
      if (!b || !own(cmd.id) || !isShop(b.kind)) return 'price on a building that is not their shop';
      if (![0, 1, 2, 3].includes(cmd.stance)) return 'stance out of range';
      return b.stance === cmd.stance ? 'price command that changes nothing' : '';
    }
    case 'upgrade': {
      const b = buildingById(s, cmd.id);
      if (b && b.level === 2 && eraNow(s) < LEVEL3_ERA) return 'Level 3 before the Grand Boulevard';
      return b && own(cmd.id) && isShop(b.kind) && b.level < 3 ? '' : 'bad upgrade';
    }
    case 'promo': {
      const b = buildingById(s, cmd.id);
      return b && own(cmd.id) && isShop(b.kind) && s.tick >= b.promoReadyAt ? '' : 'bad promo';
    }
    case 'restock': {
      const b = buildingById(s, cmd.id);
      return b && own(cmd.id) && isShop(b.kind) && b.stock < SHOPS[b.kind].stockMax ? '' : 'bad restock';
    }
    case 'sell':
      return own(cmd.id) ? '' : 'selling what is not theirs';
    case 'borrow':
      return s.players[player].debt + LOAN_STEP <= LOAN_MAX ? '' : 'borrowing past the limit';
    case 'repay':
      return s.players[player].debt > 0 ? '' : 'repaying no debt';
    case 'charter':
      return 'an AI House seals its charter at the Council, never by command';
    default:
      return 'unknown command';
  }
}

interface MatchLog {
  seed: number;
  s: GameState;
  builds: { kind: BuildKind; tile: number; tick: number }[][];
  minCash: number[];
  firstLv3: number[];
  problems: string[];
  decided: number;
  rejected: string[];
  lateCredit: number[]; // cash in hand whenever debt grew during the final quarter
  expansionCredit: number; // loans taken with cash in hand, before the final quarter
  aureliaThoughts: number;
  aureliaBelowCraft: number;
  budgetShopTicks: number[];
  orsonParks: number;
  orsonParksBesideOwnShop: number;
  civicsAtHalf: number[]; // civic projects each House held when Quarter 2 closed
  prestigeAtHalf: number[];
  lv3Ticks: number; // ticks Aurelia's finished (Level 3) shops stood
  lv3PrestigeTicks: number; // … of which priced at Prestige
  shopsAtEraClose: number[][]; // per era (I..IV): shops each House ran when the era closed
  lockedBuildings: number; // buildings standing in an era that has not unlocked them
  earlyLv3: number; // Level 3 shops standing before Era III
  firstCommandTick: number[]; // first tick each House had a command accepted
  aureliaStanceTicks: number[]; // shop-ticks Aurelia spent at Budget, Fair, Craft, Prestige
}

function playMatch(seed: number): MatchLog {
  const s = createGame({ seed, mode: 'standard', players: ais(PERSONAS) });
  const log: MatchLog = {
    seed,
    s,
    builds: PERSONAS.map(() => []),
    minCash: PERSONAS.map(() => Infinity),
    firstLv3: PERSONAS.map(() => Infinity),
    problems: [],
    decided: 0,
    rejected: [],
    lateCredit: [],
    expansionCredit: 0,
    aureliaThoughts: 0,
    aureliaBelowCraft: 0,
    budgetShopTicks: PERSONAS.map(() => 0),
    orsonParks: 0,
    orsonParksBesideOwnShop: 0,
    civicsAtHalf: [],
    prestigeAtHalf: [],
    lv3Ticks: 0,
    lv3PrestigeTicks: 0,
    shopsAtEraClose: [],
    lockedBuildings: 0,
    earlyLv3: 0,
    firstCommandTick: PERSONAS.map(() => Infinity),
    aureliaStanceTicks: [0, 0, 0, 0],
  };
  const flag = (msg: string): void => {
    if (log.problems.length < 20) log.problems.push(`t${s.tick}: ${msg}`);
  };
  while (s.phase !== 'ended') {
    if (s.phase === 'council') {
      // The era's books are closed; every AI House has already sealed its charter.
      log.shopsAtEraClose.push(PERSONAS.map((_, p) => s.buildings.filter((b) => b.owner === p && isShop(b.kind)).length));
      closeCouncil(s);
      continue;
    }
    const before = s.players.map((p) => ({ cash: p.cash, debt: p.debt }));
    const quarter = s.quarter;
    const thinking = s.players.filter((p) => s.tick >= p.aiNext).map((p) => p.id);
    for (const id of thinking) {
      const cmds = aiDecide(s, id);
      if (!cmds.length) continue;
      const trial = clone(s);
      for (const cmd of cmds) {
        log.decided++;
        const why = complaint(trial, id, cmd);
        if (why) flag(`${s.players[id].persona} ${JSON.stringify(cmd)}: ${why}`);
        const res = applyCommand(trial, id, cmd);
        if (!res.ok) log.rejected.push(`${cmd.c}: ${res.err}`);
      }
    }
    advance(s);
    for (const f of s.fx) {
      const who = f.k === 'build' || f.k === 'upgrade' || f.k === 'promo' || f.k === 'restock' || f.k === 'sell' ? f.p : -1;
      if (who >= 0) log.firstCommandTick[who] = Math.min(log.firstCommandTick[who], s.tick - 1);
    }
    for (const f of fxOf(s.fx, 'build')) {
      log.builds[f.p].push({ kind: f.kind, tile: f.tile, tick: s.tick - 1 });
      if (f.p === ORSON && f.kind === 'park') {
        log.orsonParks++;
        const beside = s.buildings.some((b) => b.owner === ORSON && isShop(b.kind) && chebyshev(b.tile, f.tile) <= 1);
        if (beside) log.orsonParksBesideOwnShop++;
      }
    }
    s.fx = [];
    // ── invariants that must hold whatever the tycoons decide ──
    const tiles = new Set<number>();
    const ids = new Set<number>();
    for (const b of s.buildings) {
      if (CITY.tiles[b.tile] !== 'lot') flag(`building ${b.id} is not on a lot`);
      if (tiles.has(b.tile)) flag(`two buildings on tile ${b.tile}`);
      if (ids.has(b.id)) flag(`duplicate building id ${b.id}`);
      tiles.add(b.tile);
      ids.add(b.id);
      if (!s.players[b.owner]) flag(`building ${b.id} has no owner`);
      if (![1, 2, 3].includes(b.level)) flag(`level ${b.level}`);
      if (![0, 1, 2, 3].includes(b.stance)) flag(`stance ${b.stance}`);
      if (!BUILD_KINDS.includes(b.kind)) flag(`kind ${b.kind}`);
      if (isShop(b.kind)) {
        if (b.stock < 0 || b.stock > SHOPS[b.kind].stockMax) flag(`stock ${b.stock}`);
        if (b.stance === 0) log.budgetShopTicks[b.owner]++;
      } else if (b.level !== 1 || b.stance !== 1) flag('a civic project was upgraded or repriced');
      if (b.kind === 'tramstop' && CITY.avenueAdj[b.tile] < 0) flag('tram stop off the avenue');
      if (b.level === 3) log.firstLv3[b.owner] = Math.min(log.firstLv3[b.owner], s.tick);
      // Era locks bind the AI Houses exactly as they bind players.
      if (s.phase === 'playing' && !isUnlocked(b.kind, s.quarter)) log.lockedBuildings++;
      if (s.phase === 'playing' && b.level === 3 && eraNow(s) < LEVEL3_ERA) log.earlyLv3++;
      if (b.owner === AURELIA && isShop(b.kind)) log.aureliaStanceTicks[b.stance]++;
      if (b.owner === AURELIA && b.level === 3 && isShop(b.kind)) {
        log.lv3Ticks++;
        if (b.stance === 3) log.lv3PrestigeTicks++;
      }
    }
    if (s.tick === (s.totalQuarters * s.quarterTicks) / 2) {
      log.civicsAtHalf = PERSONAS.map((_, p) => s.buildings.filter((b) => b.owner === p && !isShop(b.kind)).length);
      log.prestigeAtHalf = s.players.map((p) => p.prestige);
    }
    s.players.forEach((p, i) => {
      log.minCash[i] = Math.min(log.minCash[i], p.cash);
      if (p.debt < 0 || p.debt > LOAN_MAX || p.debt % LOAN_STEP !== 0) flag(`debt ${p.debt}`);
      if (p.debt > before[i].debt) {
        if (quarter >= s.totalQuarters) log.lateCredit.push(before[i].cash);
        else if (before[i].cash >= 0) log.expansionCredit++;
      }
    });
    if (thinking.includes(AURELIA)) {
      log.aureliaThoughts++;
      // Shops that already stood when she thought (not the one she may just have opened).
      for (const b of s.buildings) {
        if (b.owner === AURELIA && isShop(b.kind) && b.builtTick < s.tick - 1 && b.stance < 2) log.aureliaBelowCraft++;
      }
    }
  }
  log.shopsAtEraClose.push(PERSONAS.map((_, p) => s.buildings.filter((b) => b.owner === p && isShop(b.kind)).length));
  return log;
}

describe('AI personalities over full Standard matches (Vesper, Aurelia, Orson, Vesper; seeds 1–5)', () => {
  let logs: MatchLog[] = [];
  const shopsOf = (s: GameState, p: number) => s.buildings.filter((b) => b.owner === p && isShop(b.kind));
  const civicsOf = (s: GameState, p: number) => s.buildings.filter((b) => b.owner === p && !isShop(b.kind));

  beforeAll(() => {
    logs = SEEDS.map(playMatch);
  }, 60000);

  it('plays every match to the end and keeps the district legal on every tick', () => {
    for (const log of logs) {
      expect(log.s.phase).toBe('ended');
      expect(log.s.tick).toBe(log.s.totalQuarters * log.s.quarterTicks);
      expect(log.problems, `seed ${log.seed}`).toEqual([]);
      expect(log.s.buildings.length).toBeGreaterThan(20);
      expect(log.s.buildings.length).toBeLessThanOrEqual(CITY.lots.length);
      for (let p = 0; p < PERSONAS.length; p++) {
        expect(shopsOf(log.s, p).length, `seed ${log.seed} player ${p}`).toBeGreaterThanOrEqual(1);
        expect(log.s.players[p].stats.served, `seed ${log.seed} player ${p}`).toBeGreaterThan(25);
      }
    }
  });

  it('only ever decides well-formed commands, and nearly all of them are accepted', () => {
    for (const log of logs) {
      expect(log.decided).toBeGreaterThan(100);
      // The few refusals are a plan outrunning the till, never an illegal move.
      const reasons = [...new Set(log.rejected.map((r) => r.split(': ')[1]))];
      expect(reasons, `seed ${log.seed}`).toEqual(log.rejected.length ? ['Not enough cash'] : []);
      expect(log.rejected.length / log.decided).toBeLessThan(0.2);
    }
  });

  it('opens distinctly and deliberately: Vesper a corner shop, Aurelia a canal-front Bistro, Orson a shop and a park, then his Tram Stop the moment Era II unlocks it', () => {
    for (const log of logs) {
      const first = log.builds.map((b) => b[0]);
      for (const v of [VESPER, VESPER_2]) {
        expect(isShop(first[v].kind), `seed ${log.seed}`).toBe(true);
        expect(CITY.corner[first[v].tile], `seed ${log.seed}`).toBe(true);
      }
      // The Boutique is an Era III trade: her Founding flagship is a Bistro on the water.
      expect(first[AURELIA].kind, `seed ${log.seed}`).toBe('bistro');
      expect(CITY.canalFront[first[AURELIA].tile], `seed ${log.seed}`).toBe(true);
      // The Tram Stop is an Era II project: Orson founds a shop, lays a park in Era I …
      expect(isShop(first[ORSON].kind), `seed ${log.seed}`).toBe(true);
      const eraOne = log.builds[ORSON].filter((b) => b.tick < log.s.quarterTicks);
      expect(eraOne.some((b) => b.kind === 'park'), `seed ${log.seed}`).toBe(true);
      expect(eraOne.every((b) => b.kind === 'roastery' || b.kind === 'bistro' || b.kind === 'park'), `seed ${log.seed}`).toBe(true);
      // … and dedicates his first stop within seconds of the Era I Council rising.
      const eraTwo = log.builds[ORSON].filter((b) => b.tick >= log.s.quarterTicks);
      expect(eraTwo[0].kind, `seed ${log.seed}`).toBe('tramstop');
      expect(eraTwo[0].tick, `seed ${log.seed}`).toBeLessThan(log.s.quarterTicks + 60);
      expect(CITY.avenueAdj[eraTwo[0].tile]).toBeGreaterThanOrEqual(0);
      // Nobody opens on tick one: each House waits out its opening delay, and the seats stagger.
      first.forEach((f, p) => {
        expect(f.tick, `seed ${log.seed} player ${p}`).toBeGreaterThanOrEqual(openingDelay(log.s, p));
        expect(log.firstCommandTick[p], `seed ${log.seed} player ${p}`).toBeGreaterThanOrEqual(openingDelay(log.s, p));
      });
      expect(first.map((f) => f.tick)).toEqual(first.map((f) => f.tick).slice().sort((x, y) => x - y));
      expect(first[0].tick).toBeGreaterThanOrEqual(OPENINGS.standard.firstMove);
      // Everyone is trading within the first minute all the same.
      for (const f of first) expect(f.tick).toBeLessThan(600);
    }
  });

  it('respects the era locks and expands at a measured pace', () => {
    for (const log of logs) {
      // No locked trade or project ever stands before its era, and no Level 3 before Era III.
      expect(log.lockedBuildings, `seed ${log.seed}`).toBe(0);
      expect(log.earlyLv3, `seed ${log.seed}`).toBe(0);
      for (let p = 0; p < PERSONAS.length; p++) {
        expect(log.firstLv3[p], `seed ${log.seed} player ${p}`).toBeGreaterThanOrEqual(2 * log.s.quarterTicks);
        for (const b of log.builds[p]) {
          const era = Math.min(4, Math.floor(b.tick / log.s.quarterTicks) + 1);
          expect(isUnlocked(b.kind, era), `seed ${log.seed}: ${b.kind} at tick ${b.tick}`).toBe(true);
        }
      }
      // Each era's door cap holds when that era closes: two or three shops in the Founding era.
      expect(log.shopsAtEraClose).toHaveLength(4);
      log.shopsAtEraClose.forEach((row, e) => {
        row.forEach((n, p) => expect(n, `seed ${log.seed} era ${e + 1} player ${p}`).toBeLessThanOrEqual(ERA_DOORS[PERSONAS[p]][e]));
      });
      for (const n of log.shopsAtEraClose[0]) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(3);
      }
      // The later eras' trades are taken up once they unlock.
      const kinds = new Set(log.s.buildings.map((b) => b.kind));
      expect(kinds.has('arcade') || kinds.has('nightmarket')).toBe(true);
      expect(kinds.has('boutique') || kinds.has('cinema')).toBe(true);
      // Every House sealed one charter per Council, each to its persona's taste.
      log.s.players.forEach((p) => {
        expect(p.charters, `seed ${log.seed} ${p.persona}`).toHaveLength(3);
        expect(new Set(p.charters).size).toBe(3);
      });
    }
    // Across the five matches each persona's favourite doctrine is its most adopted first pick.
    const firstPicks: Record<AiPersona, string[]> = { vesper: [], aurelia: [], orson: [] };
    for (const log of logs) for (const p of log.s.players) firstPicks[p.persona as AiPersona].push(p.charters[0]);
    for (const persona of ['vesper', 'aurelia', 'orson'] as AiPersona[]) {
      const taste = CHARTER_TASTE[persona];
      const mean = firstPicks[persona].reduce((x, k) => x + taste[k as keyof typeof taste], 0) / firstPicks[persona].length;
      expect(mean, persona).toBeGreaterThan(2); // well above an indifferent pick (the six tastes average about 1.8)
    }
  });

  it('Orson, the Transit Expansionist, builds Tram Stops and Pocket Parks in every match', () => {
    for (const log of logs) {
      const kinds = log.builds[ORSON].map((b) => b.kind);
      expect(kinds.filter((k) => k === 'tramstop').length, `seed ${log.seed}`).toBeGreaterThanOrEqual(1);
      expect(kinds.filter((k) => k === 'park').length, `seed ${log.seed}`).toBeGreaterThanOrEqual(1);
      expect(kinds.filter(isShop).length, `seed ${log.seed}`).toBeGreaterThanOrEqual(3);
      expect(log.s.players[ORSON].stats.civicBuilt).toBeGreaterThanOrEqual(2);
      // He lays every park beside a shop of his own …
      expect(log.orsonParks).toBeGreaterThanOrEqual(1);
      expect(log.orsonParksBesideOwnShop, `seed ${log.seed}`).toBe(log.orsonParks);
      // … holds the largest civic estate in town through the first half (the discounters only
      // turn civic in the Golden Dynasty), always a larger one than Aurelia, and leads both
      // discounters on prestige at half-time.
      for (const other of [VESPER, AURELIA, VESPER_2]) {
        expect(log.civicsAtHalf[ORSON], `seed ${log.seed}`).toBeGreaterThan(log.civicsAtHalf[other]);
      }
      expect(civicsOf(log.s, ORSON).length, `seed ${log.seed}`).toBeGreaterThanOrEqual(civicsOf(log.s, AURELIA).length);
      for (const v of [VESPER, VESPER_2]) expect(log.prestigeAtHalf[ORSON]).toBeGreaterThan(log.prestigeAtHalf[v] + 10);
      // He never discounts.
      expect(log.budgetShopTicks[ORSON]).toBe(0);
      expect(log.s.players[ORSON].stats.budgetSales).toBe(0);
    }
  });

  it('Aurelia, the Boutique Perfectionist, leads with Bistros and Boutiques and earns most of her money there', () => {
    const flagships = PERSONAS.map(() => 0);
    const shops = PERSONAS.map(() => 0);
    const flagshipRevenueShare = (s: GameState, p: number): number => {
      const mine = shopsOf(s, p);
      const revenue = mine.reduce((a, b) => a + b.revenue, 0);
      return revenue > 0 ? mine.filter((b) => flagship(b.kind)).reduce((a, b) => a + b.revenue, 0) / revenue : 0;
    };
    for (const log of logs) {
      const opened = log.builds[AURELIA].map((b) => b.kind).filter(isShop);
      expect(opened.slice(0, 2).every(flagship), `seed ${log.seed}: ${opened.join(',')}`).toBe(true);
      // In every match most of her takings come from the two trades, and no rival leans on them as much.
      expect(flagshipRevenueShare(log.s, AURELIA), `seed ${log.seed}`).toBeGreaterThan(0.5);
      for (const other of [VESPER, ORSON, VESPER_2]) {
        expect(flagshipRevenueShare(log.s, AURELIA), `seed ${log.seed}`).toBeGreaterThan(flagshipRevenueShare(log.s, other));
      }
      for (let p = 0; p < PERSONAS.length; p++) {
        flagships[p] += shopsOf(log.s, p).filter((b) => flagship(b.kind)).length;
        shops[p] += shopsOf(log.s, p).length;
      }
    }
    // By count, across the five matches, the two trades are a far larger part of her portfolio than
    // of any rival's. (A strict majority by count holds on aggregate with today's tuning, about 60%,
    // but not in every match and not under small retunes — see the report — so it is not asserted.)
    const share = flagships.map((n, p) => n / shops[p]);
    for (const other of [VESPER, ORSON, VESPER_2]) expect(share[AURELIA]).toBeGreaterThan(share[other] * 1.25);
    expect(flagships[AURELIA]).toBeGreaterThanOrEqual(2 * logs.length);
  });

  it('Aurelia finishes more of her shops than anyone once Era III allows it, never discounts, and adapts her price when the queue stalls', () => {
    const lv3 = PERSONAS.map(() => 0);
    const shops = PERSONAS.map(() => 0);
    const stance = [0, 0, 0, 0];
    let lv3Ticks = 0;
    let lv3PrestigeTicks = 0;
    let matchesWithLv3 = 0;
    for (const log of logs) {
      for (let p = 0; p < PERSONAS.length; p++) {
        lv3[p] += shopsOf(log.s, p).filter((b) => b.level === 3).length;
        shops[p] += shopsOf(log.s, p).length;
      }
      const mine = shopsOf(log.s, AURELIA);
      if (mine.some((b) => b.level === 3)) matchesWithLv3++;
      // Grand architecture is an Era III unlock for her as for everyone.
      expect(log.firstLv3[AURELIA], `seed ${log.seed}`).toBeGreaterThanOrEqual(2 * log.s.quarterTicks);
      expect(log.aureliaThoughts).toBeGreaterThan(200);
      // She never runs a Budget price, in any match, on any shop.
      expect(log.budgetShopTicks[AURELIA], `seed ${log.seed}`).toBe(0);
      expect(log.aureliaStanceTicks[0], `seed ${log.seed}`).toBe(0);
      expect(log.s.players[AURELIA].stats.budgetSales).toBe(0);
      for (const b of mine) expect(b.stance, `seed ${log.seed}`).toBeGreaterThanOrEqual(1);
      // Craft is where every shop of hers starts; she holds it for a real part of each match
      // and steps back to Fair only while a queue has stalled.
      expect(log.aureliaStanceTicks[2] + log.aureliaStanceTicks[3], `seed ${log.seed}`).toBeGreaterThan(500);
      log.aureliaStanceTicks.forEach((n, i) => (stance[i] += n));
      lv3Ticks += log.lv3Ticks;
      lv3PrestigeTicks += log.lv3PrestigeTicks;
    }
    // Most of her matches end with finished shops, and by share of portfolio she finishes far
    // more than either discounter; the Transit Expansionist finishes fewest of all.
    expect(matchesWithLv3).toBeGreaterThanOrEqual(3);
    const share = lv3.map((n, p) => n / shops[p]);
    for (const other of [VESPER, ORSON, VESPER_2]) expect(share[AURELIA], `vs ${other}`).toBeGreaterThan(share[other] * 1.25);
    expect(lv3[AURELIA]).toBeGreaterThan(lv3[ORSON]);
    expect(lv3[AURELIA]).toBeGreaterThanOrEqual(SEEDS.length * 2);
    // Prestige is where a finished shop starts and where it returns when the queue does;
    // between rushes it concedes. Both are part of her game.
    expect(lv3Ticks).toBeGreaterThan(5000);
    expect(lv3PrestigeTicks / lv3Ticks).toBeGreaterThan(0.05);
    expect(lv3PrestigeTicks / lv3Ticks).toBeLessThan(0.95);
    expect(stance[3]).toBeGreaterThan(0);
    expect(stance[1]).toBeGreaterThan(0);
  });

  it('Vesper, the Aggressive Discounter, builds only shops through Era II, runs Budget prices and fires Promo Blitzes', () => {
    let blitzes = 0;
    let lateCivics = 0;
    for (const log of logs) {
      const half = (log.s.totalQuarters * log.s.quarterTicks) / 2;
      for (const v of [VESPER, VESPER_2]) {
        // Volume first: nothing civic through the first two eras (nor before VESPER_CIVIC.fromQuarter) …
        expect(log.builds[v].filter((b) => b.tick < half).every((b) => isShop(b.kind)), `seed ${log.seed}`).toBe(true);
        expect(log.civicsAtHalf[v], `seed ${log.seed}`).toBe(0);
        // … then, trailing on prestige, he adapts: a few parks, one stop, one plaza at most.
        const civic = log.builds[v].filter((b) => !isShop(b.kind));
        for (const b of civic) expect(b.tick, `seed ${log.seed}`).toBeGreaterThanOrEqual((VESPER_CIVIC.fromQuarter - 1) * log.s.quarterTicks);
        expect(civic.filter((b) => b.kind === 'park').length).toBeLessThanOrEqual(VESPER_CIVIC.parks);
        expect(civic.filter((b) => b.kind === 'tramstop').length).toBeLessThanOrEqual(VESPER_CIVIC.stops);
        expect(civic.filter((b) => b.kind === 'plaza').length).toBeLessThanOrEqual(VESPER_CIVIC.plazas);
        lateCivics += civic.length;
        expect(log.s.players[v].stats.civicBuilt).toBe(civic.length);
        expect(log.budgetShopTicks[v], `seed ${log.seed}`).toBeGreaterThan(1000);
        expect(log.s.players[v].stats.budgetSales, `seed ${log.seed}`).toBeGreaterThan(50);
        blitzes += log.s.players[v].stats.promos;
        // Every blitz was paid for: full price, or the Market Heralds rate once that charter is his.
        const p = log.s.players[v];
        const heralds = promoCostFor({ charters: ['heralds'] });
        expect(heralds).toBeLessThan(PROMO_COST);
        expect(p.totalLedger.marketing).toBeLessThanOrEqual(p.stats.promos * PROMO_COST);
        expect(p.totalLedger.marketing).toBeGreaterThanOrEqual(p.stats.promos * heralds);
        if (!p.charters.includes('heralds')) expect(p.totalLedger.marketing).toBe(p.stats.promos * PROMO_COST);
        expect((p.stats.promos * PROMO_COST - p.totalLedger.marketing) % (PROMO_COST - heralds)).toBe(0);
      }
      // The Price Shark award goes to a Vesper every time.
      const shark = log.s.result?.awards.find((a) => a.key === 'shark');
      expect([VESPER, VESPER_2]).toContain(shark?.player);
    }
    // The late civic turn is real: across five matches the two Vespers dedicate several projects.
    expect(lateCivics).toBeGreaterThanOrEqual(SEEDS.length);
    // Promo Blitzes are part of his game (his trigger is tested in a constructed situation below;
    // match by match the count varies a lot — see the report).
    expect(blitzes).toBeGreaterThanOrEqual(10);
  });

  it('keeps every tycoon solvent-ish: brief overdrafts only, and nobody finishes deep in the red', () => {
    for (const log of logs) {
      log.s.players.forEach((p, i) => {
        expect(p.cash, `seed ${log.seed} ${p.persona}`).toBeGreaterThan(-600);
        expect(log.minCash[i], `seed ${log.seed} ${p.persona}`).toBeGreaterThan(-600);
        expect(p.debt).toBeLessThanOrEqual(LOAN_MAX);
        expect(p.totalLedger.revenue, `seed ${log.seed} ${p.persona}`).toBeGreaterThan(500);
      });
    }
  });

  it('does not borrow to expand during the final era: late loans are emergency credit only', () => {
    let expansion = 0;
    for (const log of logs) {
      for (const cash of log.lateCredit) expect(cash, `seed ${log.seed}`).toBeLessThan(0);
      expansion += log.expansionCredit;
    }
    // Earlier in the match, credit is used for expansion (that is Orson's game).
    expect(expansion).toBeGreaterThan(0);
  });
});

describe('AI decisions in constructed situations', () => {
  /** One AI House against an idle human, at the opening tick of `era` (so its unlocks are in force). */
  const duel = (persona: AiPersona, mode: 'standard' | 'endless' = 'standard', era = 1): GameState => {
    const s = createGame({
      seed: 5,
      mode,
      players: [
        { name: persona, house: 0, kind: 'ai', persona },
        { name: 'Rival', house: 1, kind: 'human' },
      ],
    });
    s.events = [];
    for (const p of s.players) p.cash = 5000;
    if (era > 1) atEra(s, era);
    return s;
  };
  const prices = (cmds: Command[]): Record<number, number> =>
    Object.fromEntries(cmds.filter((c) => c.c === 'price').map((c) => [(c as { id: number }).id, (c as { stance: number }).stance]));

  it('is pure: deciding never touches the state, and deciding twice gives the same answer', () => {
    const s = createGame({ seed: 7, mode: 'standard', players: ais(PERSONAS) });
    let commands = 0;
    for (let i = 0; i < 1600; i++) {
      advance(s);
      if (i % 40 !== 0) continue;
      for (const p of s.players) {
        const before = JSON.stringify(s);
        const first = aiDecide(s, p.id);
        expect(JSON.stringify(s)).toBe(before);
        expect(aiDecide(s, p.id)).toEqual(first);
        commands += first.length;
      }
    }
    expect(commands).toBeGreaterThan(5);
  });

  it('decides nothing for a human seat, an unknown seat or a finished match', () => {
    const s = duel('vesper');
    expect(aiDecide(s, 0).length).toBeGreaterThan(0);
    expect(aiDecide(s, 1)).toEqual([]);
    expect(aiDecide(s, 9)).toEqual([]);
    s.phase = 'ended';
    expect(aiDecide(s, 0)).toEqual([]);
    expect(aiThink(s, 0)).toEqual([]);
  });

  it('is deterministic: the same seed replays tick for tick, a different seed diverges', () => {
    const play = (seed: number): string => {
      const s = createGame({ seed, mode: 'standard', players: ais(PERSONAS) });
      for (let i = 0; i < 1500; i++) advance(s);
      return JSON.stringify(s);
    };
    const a = play(42);
    expect(play(42)).toBe(a);
    const b = play(43);
    expect(b).not.toBe(a);
    expect((JSON.parse(a) as GameState).tick).toBe(1500);
    expect((JSON.parse(a) as GameState).buildings.length).toBeGreaterThan(4);
  });

  it('Vesper undercuts: beside a rival shop of the same trade at Fair, he goes to Budget', () => {
    const s = duel('vesper');
    const mine = build(s, 0, 3, 6, 'roastery');
    const theirs = build(s, 1, 4, 6, 'roastery');
    expect(mine.stance).toBe(1);
    expect(theirs.stance).toBe(1);
    expect(prices(aiDecide(s, 0))[mine.id]).toBe(0);
    // One notch under whatever the rival charges.
    theirs.stance = 3;
    expect(prices(aiDecide(s, 0))[mine.id]).toBe(2);
    theirs.stance = 2;
    expect(prices(aiDecide(s, 0))[mine.id]).toBeUndefined(); // Fair already
    theirs.stance = 0;
    expect(prices(aiDecide(s, 0))[mine.id]).toBe(0);
    // He does not starve a shop that is already turning people away.
    theirs.stance = 1;
    mine.queue = Array.from({ length: queueCap(mine) - 1 }, (_, i) => 700000 + i);
    expect(prices(aiDecide(s, 0))[mine.id]).toBeUndefined();
    mine.queue = [];
    // Acting on it changes the price through the ordinary command path, and the Gazette notices
    // (market headlines are rationed, so let the opening line age first).
    freeze(s);
    run(s, 160);
    const done = aiThink(s, 0);
    expect(done).toContainEqual({ c: 'price', id: mine.id, stance: 0 });
    expect(mine.stance).toBe(0);
    expect(s.gazette[s.gazette.length - 1].text).toMatch(/price war/i);
    expect(theirs.stance).toBe(1);
  });

  it('Vesper leaves prices at Fair when the rival sells something else or is far away', () => {
    const s = duel('vesper');
    const mine = build(s, 0, 3, 6, 'roastery');
    const bistro = build(s, 1, 4, 6, 'bistro');
    const far = build(s, 1, 10, 2, 'roastery');
    expect(manhattan(mine.tile, far.tile)).toBeGreaterThan(6);
    expect(prices(aiDecide(s, 0))).toEqual({});
    expect(bistro.stance).toBe(1);
    // His own second roastery next door is not a rival either.
    build(s, 0, 2, 6, 'roastery');
    expect(prices(aiDecide(s, 0))).toEqual({});
  });

  it('Aurelia prices at Craft, opens her Boutiques first in Era III, then finishes her shops and moves them to Prestige', () => {
    const s = duel('aurelia', 'standard', 3);
    const a = build(s, 0, 4, 6, 'bistro');
    const b = build(s, 0, 5, 6, 'boutique');
    let cmds = aiDecide(s, 0);
    expect(prices(cmds)).toEqual({ [a.id]: 2, [b.id]: 2 });
    // The Grand Boulevard is what she saved for: until two Boutiques stand, a new flagship
    // door (a Bistro or a Boutique, whichever the street rewards) comes before any refit.
    const door = cmds.filter((c) => c.c === 'build') as Extract<Command, { c: 'build' }>[];
    expect(door).toHaveLength(1);
    expect(flagship(door[0].kind)).toBe(true);
    expect(cmds.some((c) => c.c === 'upgrade')).toBe(false);
    const c2 = build(s, 0, 3, 6, 'boutique');
    // Both flagships open: now she finishes what she has, one refit per thought, no third door.
    cmds = aiDecide(s, 0);
    expect(prices(cmds)).toEqual({ [a.id]: 2, [b.id]: 2, [c2.id]: 2 });
    expect(cmds.filter((c) => c.c === 'upgrade')).toHaveLength(1);
    expect(cmds.some((c) => c.c === 'build')).toBe(false);
    a.level = 3;
    b.level = 3;
    c2.level = 3;
    cmds = aiDecide(s, 0);
    expect(prices(cmds)).toEqual({ [a.id]: 3, [b.id]: 3, [c2.id]: 3 });
    expect(cmds.some((c) => c.c === 'upgrade')).toBe(false);
    // With her shops finished she turns to placemaking: a Festival Plaza.
    expect(cmds).toContainEqual(expect.objectContaining({ c: 'build', kind: 'plaza' }));
    // Orson, by contrast, holds Fair on a quiet Level 1 shop.
    const o = duel('orson');
    build(o, 0, 4, 6, 'bistro');
    expect(prices(aiDecide(o, 0))).toEqual({});
  });

  it('Aurelia stops at Level 2 before Era III, and banks her takings for the Boutique late in Era II', () => {
    // Era I: two Level 2 shops are as finished as the era allows: no Level 3 refit is asked for.
    const early = duel('aurelia');
    const a = build(early, 0, 4, 6, 'bistro');
    const b = build(early, 0, 5, 6, 'bistro');
    expect(aiDecide(early, 0).filter((c) => c.c === 'upgrade')).toHaveLength(1);
    a.level = 2;
    b.level = 2;
    expect(aiDecide(early, 0).some((c) => c.c === 'upgrade')).toBe(false);
    // Late in Transit & Trade, with a modest purse, she spends nothing: the Boutique is next.
    const banking = duel('aurelia', 'standard', 2);
    build(banking, 0, 4, 6, 'bistro');
    build(banking, 0, 5, 6, 'bistro');
    banking.players[0].cash = 700;
    banking.tick += Math.round(banking.quarterTicks * 0.8);
    const held = aiDecide(banking, 0);
    expect(held.some((c) => c.c === 'build' || c.c === 'upgrade')).toBe(false);
    // The same purse early in the era is put to work.
    const working = duel('aurelia', 'standard', 2);
    build(working, 0, 4, 6, 'bistro');
    build(working, 0, 5, 6, 'bistro');
    working.players[0].cash = 700;
    working.tick += Math.round(working.quarterTicks * 0.1);
    expect(aiDecide(working, 0).some((c) => c.c === 'build' || c.c === 'upgrade')).toBe(true);
  });

  it('Orson opens Era I with a shop, and Era II with a Tram Stop on the avenue, away from the stops that already exist', () => {
    // The Tram Stop is locked in the Founding era: he founds a shop like everyone else.
    const founding = duel('orson');
    founding.players[0].cash = 900;
    const opening = aiDecide(founding, 0).find((c) => c.c === 'build') as Extract<Command, { c: 'build' }>;
    expect(isShop(opening.kind)).toBe(true);
    expect(isUnlocked(opening.kind, 1)).toBe(true);
    // Transit & Trade: the stop comes first.
    const s = duel('orson', 'standard', 2);
    s.players[0].cash = 900;
    const cmds = aiDecide(s, 0);
    const first = cmds.find((c) => c.c === 'build') as Extract<Command, { c: 'build' }>;
    expect(first.kind).toBe('tramstop');
    const avenue = CITY.avenueAdj[first.tile];
    expect(avenue).toBeGreaterThanOrEqual(0);
    for (const stop of CITY.fixedStops) expect(manhattan(stop, avenue)).toBeGreaterThanOrEqual(4);
    expect(aiThink(s, 0)).toContainEqual(first);
    expect(buildingAt(s, first.tile)?.kind).toBe('tramstop');
    // Vesper and Aurelia, in the same seat, open a shop instead.
    for (const persona of ['vesper', 'aurelia'] as AiPersona[]) {
      const other = duel(persona, 'standard', 2);
      other.players[0].cash = 900;
      const shop = aiDecide(other, 0).find((c) => c.c === 'build') as Extract<Command, { c: 'build' }>;
      expect(isShop(shop.kind)).toBe(true);
    }
  });

  it('never proposes a locked trade, and saves toward the next era\u2019s trades once the current one is nearly spent', () => {
    for (const persona of ['vesper', 'aurelia', 'orson'] as AiPersona[]) {
      for (const era of [1, 2, 3, 4]) {
        for (const phase of [0.05, 0.5, 0.95]) {
          const s = duel(persona, 'standard', era);
          build(s, 0, 3, 6, 'roastery');
          build(s, 0, 4, 6, 'bistro');
          s.tick += Math.round(s.quarterTicks * phase);
          for (const cmd of aiDecide(s, 0)) {
            if (cmd.c === 'build') expect(isUnlocked(cmd.kind, s.quarter), `${persona} era ${era}: ${cmd.kind}`).toBe(true);
            expect(applyCommand(clone(s), 0, cmd).ok, `${persona} era ${era}: ${JSON.stringify(cmd)}`).toBe(true);
          }
        }
      }
    }
  });

  it('Vesper fires a Promo Blitz on thinner odds than Orson, and Orson on thinner odds than Aurelia', () => {
    const fires = (persona: AiPersona): Set<string> => {
      const out = new Set<string>();
      for (const kind of SHOP_KINDS) {
        for (let part = 0; part < 4; part++) {
          const s = duel(persona, 'standard', 3); // every trade is unlocked by Era III
          const shop = build(s, 0, 3, 6, kind);
          s.tick += Math.round((part + 0.4) * (s.quarterTicks / 4));
          const promo = aiDecide(s, 0).filter((c) => c.c === 'promo');
          expect(promo.length).toBeLessThanOrEqual(1); // one blitz per thought
          if (promo.length) {
            expect(promo[0]).toEqual({ c: 'promo', id: shop.id });
            out.add(`${kind}@${part}`);
          }
        }
      }
      return out;
    };
    const vesper = fires('vesper');
    const orson = fires('orson');
    const aurelia = fires('aurelia');
    for (const k of aurelia) expect(orson.has(k), k).toBe(true);
    for (const k of orson) expect(vesper.has(k), k).toBe(true);
    expect(vesper.size).toBeGreaterThan(aurelia.size);
    expect(vesper.size).toBeGreaterThan(0);
    // Nobody advertises a trade in its dead hours, or with an empty till.
    expect(vesper.has('nightmarket@0')).toBe(false);
    const broke = duel('vesper', 'standard', 3);
    build(broke, 0, 3, 6, 'cinema');
    broke.tick += Math.round(3.4 * (broke.quarterTicks / 4));
    broke.players[0].cash = 40;
    expect(aiDecide(broke, 0).some((c) => c.c === 'promo')).toBe(false);
  });

  it('gives each persona its own taste in lots: corners, canal frontage, transit', () => {
    const s = duel('vesper');
    s.footfall = s.footfall.map(() => 0);
    const plain = idx(3, 6);
    const corner = idx(2, 6);
    const canal = idx(5, 6);
    const transit = idx(8, 2);
    const gain = (persona: AiPersona, lot: number, kind: BuildKind = 'roastery'): number => {
      const p = { ...s.players[0], persona };
      return lotAppeal(s, p, lot, kind) - lotAppeal(s, p, plain, kind);
    };
    expect(gain('vesper', corner)).toBeGreaterThan(gain('aurelia', corner));
    expect(gain('vesper', corner)).toBeGreaterThan(gain('orson', corner));
    expect(gain('aurelia', canal)).toBeGreaterThan(gain('vesper', canal));
    expect(gain('aurelia', canal)).toBeGreaterThan(gain('orson', canal));
    expect(gain('orson', transit)).toBeGreaterThan(gain('vesper', transit));
    expect(gain('orson', transit)).toBeGreaterThan(gain('aurelia', transit));
    for (const persona of ['vesper', 'aurelia', 'orson'] as AiPersona[]) {
      expect(gain(persona, corner)).toBeGreaterThan(0);
      expect(gain(persona, canal)).toBeGreaterThan(0);
      expect(gain(persona, transit)).toBeGreaterThan(0);
    }
    // A Bistro loves the canal more than a Roastery does; an Arcade loves the tram.
    expect(gain('aurelia', canal, 'bistro')).toBeGreaterThan(gain('aurelia', canal, 'roastery'));
    expect(gain('orson', transit, 'arcade')).toBeGreaterThan(gain('orson', transit, 'roastery'));
    // Aurelia's ideal lot fronts the canal; Vesper's is a corner.
    const best = (persona: AiPersona): number => {
      const p = { ...s.players[0], persona };
      return CITY.lots.slice().sort((x, y) => lotAppeal(s, p, y, 'bistro') - lotAppeal(s, p, x, 'bistro'))[0];
    };
    expect(CITY.canalFront[best('aurelia')]).toBe(true);
    expect(CITY.corner[best('vesper')]).toBe(true);
    expect(CITY.fixedStops.some((stop) => manhattan(best('orson'), stop) <= TRANSIT_RADIUS)).toBe(true);
  });

  it('expects less from a trade the more shops already ply it', () => {
    for (const kind of SHOP_KINDS) {
      const s = duel('vesper', 'standard', 3);
      for (const p of s.players) p.cash = 1e6;
      const me = s.players[0];
      const outlook = [tradeOutlook(s, me, kind)];
      // Rivals crowd in …
      for (let i = 0; i < 6; i++) {
        build(s, 1, tx(CITY.lots[i]), ty(CITY.lots[i]), kind);
        outlook.push(tradeOutlook(s, me, kind));
      }
      for (let i = 1; i < outlook.length; i++) expect(outlook[i], `${kind} with ${i} rivals`).toBeLessThanOrEqual(outlook[i - 1]);
      expect(outlook[6]).toBeLessThan(outlook[0]);
      // … and every door of his own eats into the next one, strictly.
      let prev = outlook[6];
      for (let i = 6; i < 9; i++) {
        build(s, 0, tx(CITY.lots[i]), ty(CITY.lots[i]), kind);
        const next = tradeOutlook(s, me, kind);
        expect(next).toBeLessThan(prev);
        prev = next;
      }
      // Other trades are unaffected by this one filling up.
      const other = SHOP_KINDS.find((k) => k !== kind) as (typeof SHOP_KINDS)[number];
      expect(tradeOutlook(s, me, other)).toBe(tradeOutlook(duel('vesper', 'standard', 3), me, other));
    }
  });

  it('Orson borrows to expand mid-match but not in the final era', () => {
    const setup = (mode: 'standard' | 'endless' = 'standard'): GameState => {
      const s = duel('orson', mode, 2); // Era II: the Tram Stop and the Arcade are unlocked
      build(s, 0, 2, 2, 'tramstop');
      build(s, 0, 3, 2, 'roastery');
      build(s, 0, 4, 2, 'arcade');
      build(s, 0, 3, 4, 'park');
      s.players[0].cash = 150; // solvent, but too little in hand to build anything
      return s;
    };
    const early = setup();
    expect(aiDecide(early, 0)).toContainEqual({ c: 'borrow' });
    expect(aiDecide(early, 0).some((c) => c.c === 'build')).toBe(false);
    // Once he owes money he does not stack loans for expansion.
    early.players[0].debt = LOAN_STEP;
    expect(aiDecide(early, 0)).not.toContainEqual({ c: 'borrow' });
    // The same books in the final quarter: no loan.
    const late = setup();
    atEra(late, late.totalQuarters);
    expect(aiDecide(late, 0)).not.toContainEqual({ c: 'borrow' });
    // It is the calendar that stops him: in an endless game the same day is business as usual.
    const endless = setup('endless');
    atEra(endless, 4);
    expect(aiDecide(endless, 0)).toContainEqual({ c: 'borrow' });
  });

  it('uses emergency credit when overdrawn, even late, and sells its weakest shop when credit is gone', () => {
    for (const persona of ['vesper', 'aurelia', 'orson'] as AiPersona[]) {
      const s = duel(persona);
      const weak = build(s, 0, 3, 2, 'roastery');
      const strong = build(s, 0, 4, 2, 'bistro');
      weak.revenue = 10;
      strong.revenue = 900;
      s.quarter = s.totalQuarters;
      s.tick += (s.totalQuarters - 1) * s.quarterTicks;
      const p = s.players[0];
      p.cash = -20;
      expect(aiDecide(s, 0), persona).toEqual([{ c: 'borrow' }]);
      p.debt = LOAN_MAX;
      expect(aiDecide(s, 0), persona).toEqual([]);
      p.cash = -400;
      expect(aiDecide(s, 0), persona).toEqual([{ c: 'sell', id: weak.id }]);
      // With money to spare it pays the bank back.
      p.cash = 3000;
      expect(aiDecide(s, 0), persona).toContainEqual({ c: 'repay' });
    }
  });
});
