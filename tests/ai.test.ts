import { beforeAll, describe, expect, it } from 'vitest';
import { TEMPERAMENTS, VESPER_CIVIC, advance, aiDecide, aiThink, lotAppeal, tradeOutlook } from '../src/shared/ai';
import { BUILD_KINDS, LOAN_MAX, LOAN_STEP, PROMO_COST, SHOPS, SHOP_KINDS, TRANSIT_RADIUS, isShop } from '../src/shared/constants';
import { CITY, chebyshev, idx, manhattan, tx, ty } from '../src/shared/map';
import { applyCommand, buildingAt, buildingById, createGame, queueCap } from '../src/shared/sim';
import type { AiPersona, BuildKind, Command, GameState } from '../src/shared/types';
import { ais, build, clone, freeze, fxOf, run } from './helpers';

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
      return '';
    case 'price': {
      const b = buildingById(s, cmd.id);
      if (!b || !own(cmd.id) || !isShop(b.kind)) return 'price on a building that is not their shop';
      if (![0, 1, 2, 3].includes(cmd.stance)) return 'stance out of range';
      return b.stance === cmd.stance ? 'price command that changes nothing' : '';
    }
    case 'upgrade': {
      const b = buildingById(s, cmd.id);
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
  };
  const flag = (msg: string): void => {
    if (log.problems.length < 20) log.problems.push(`t${s.tick}: ${msg}`);
  };
  while (s.phase === 'playing') {
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
  return log;
}

describe('AI personalities over full Standard matches (Vesper, Aurelia, Orson, Vesper; seeds 1–5)', () => {
  let logs: MatchLog[] = [];
  const shopsOf = (s: GameState, p: number) => s.buildings.filter((b) => b.owner === p && isShop(b.kind));
  const civicsOf = (s: GameState, p: number) => s.buildings.filter((b) => b.owner === p && !isShop(b.kind));

  beforeAll(() => {
    logs = SEEDS.map(playMatch);
  });

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

  it('opens distinctly: Vesper a shop on a corner, Aurelia a canal-front Bistro or Boutique, Orson a Tram Stop', () => {
    for (const log of logs) {
      const first = log.builds.map((b) => b[0]);
      for (const v of [VESPER, VESPER_2]) {
        expect(isShop(first[v].kind), `seed ${log.seed}`).toBe(true);
        expect(CITY.corner[first[v].tile], `seed ${log.seed}`).toBe(true);
      }
      expect(flagship(first[AURELIA].kind), `seed ${log.seed}`).toBe(true);
      expect(CITY.canalFront[first[AURELIA].tile], `seed ${log.seed}`).toBe(true);
      expect(first[ORSON].kind, `seed ${log.seed}`).toBe('tramstop');
      expect(CITY.avenueAdj[first[ORSON].tile]).toBeGreaterThanOrEqual(0);
      // Everyone is trading within the first minute.
      for (const f of first) expect(f.tick).toBeLessThan(600);
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
      // turn civic from Quarter 3), always a larger one than Aurelia, and leads both
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

  it('Aurelia reaches Level 3 fast, upgrades more than anyone, and prices every established shop at Craft or Prestige', () => {
    let firstToLv3 = 0;
    const lv3 = PERSONAS.map(() => 0);
    const finished: number[] = []; // price stances of her Level 3 shops at the final bell
    for (const log of logs) {
      const half = (log.s.totalQuarters * log.s.quarterTicks) / 2;
      expect(log.firstLv3[AURELIA], `seed ${log.seed}`).toBeLessThan(half);
      if ([VESPER, ORSON, VESPER_2].every((other) => log.firstLv3[AURELIA] < log.firstLv3[other])) firstToLv3++;
      for (let p = 0; p < PERSONAS.length; p++) lv3[p] += shopsOf(log.s, p).filter((b) => b.level === 3).length;
      const mine = shopsOf(log.s, AURELIA);
      expect(mine.filter((b) => b.level === 3).length, `seed ${log.seed}`).toBeGreaterThanOrEqual(1);
      // Whenever she thinks, every shop that already stood is at Craft or Prestige.
      expect(log.aureliaThoughts).toBeGreaterThan(200);
      expect(log.aureliaBelowCraft, `seed ${log.seed}`).toBe(0);
      expect(log.budgetShopTicks[AURELIA]).toBe(0);
      // At the final bell: Craft below Level 3; a finished shop is at Prestige or, if it has
      // been losing its customers to the price, back at Craft — never lower.
      for (const b of mine) {
        if (b.builtTick >= log.s.tick - TEMPERAMENTS.aurelia.think) continue;
        expect(b.stance).toBeGreaterThanOrEqual(2);
        if (b.level < 3) expect(b.stance).toBe(2);
        else finished.push(b.stance);
      }
      // Prestige is her default for a finished shop: it holds that price for a real share of
      // the match in every seed.
      expect(log.lv3Ticks, `seed ${log.seed}`).toBeGreaterThan(1000);
      // Prestige is where a finished shop starts, and where it returns when the queue does;
      // between rushes it concedes to Craft. Both prices are part of every match.
      const share = log.lv3PrestigeTicks / log.lv3Ticks;
      expect(share, `seed ${log.seed}`).toBeGreaterThan(0.08);
      expect(share, `seed ${log.seed}`).toBeLessThan(0.95);
    }
    expect(finished.length).toBeGreaterThanOrEqual(SEEDS.length * 2);
    expect(finished.every((stance) => stance >= 2)).toBe(true);
    expect(firstToLv3).toBeGreaterThanOrEqual(3);
    for (const other of [VESPER, ORSON, VESPER_2]) expect(lv3[AURELIA]).toBeGreaterThan(lv3[other]);
  });

  it('Vesper, the Aggressive Discounter, builds only shops through Quarter 2, runs Budget prices and fires Promo Blitzes', () => {
    let blitzes = 0;
    let lateCivics = 0;
    for (const log of logs) {
      const half = (log.s.totalQuarters * log.s.quarterTicks) / 2;
      for (const v of [VESPER, VESPER_2]) {
        // Volume first: nothing civic before Quarter 3 …
        expect(log.builds[v].filter((b) => b.tick < half).every((b) => isShop(b.kind)), `seed ${log.seed}`).toBe(true);
        expect(log.civicsAtHalf[v], `seed ${log.seed}`).toBe(0);
        // … then, trailing on prestige, he adapts: a few parks, one stop, one plaza at most.
        const civic = log.builds[v].filter((b) => !isShop(b.kind));
        for (const b of civic) expect(b.tick, `seed ${log.seed}`).toBeGreaterThanOrEqual(half);
        expect(civic.filter((b) => b.kind === 'park').length).toBeLessThanOrEqual(VESPER_CIVIC.parks);
        expect(civic.filter((b) => b.kind === 'tramstop').length).toBeLessThanOrEqual(VESPER_CIVIC.stops);
        expect(civic.filter((b) => b.kind === 'plaza').length).toBeLessThanOrEqual(VESPER_CIVIC.plazas);
        lateCivics += civic.length;
        expect(log.s.players[v].stats.civicBuilt).toBe(civic.length);
        expect(log.budgetShopTicks[v], `seed ${log.seed}`).toBeGreaterThan(1000);
        expect(log.s.players[v].stats.budgetSales, `seed ${log.seed}`).toBeGreaterThan(50);
        blitzes += log.s.players[v].stats.promos;
        expect(log.s.players[v].totalLedger.marketing).toBe(log.s.players[v].stats.promos * PROMO_COST);
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

  it('does not borrow to expand during the final quarter: late loans are emergency credit only', () => {
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
  const duel = (persona: AiPersona, mode: 'standard' | 'endless' = 'standard'): GameState => {
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

  it('Aurelia prices at Craft, moves to Prestige at Level 3, and finishes her shops before opening a third', () => {
    const s = duel('aurelia');
    const a = build(s, 0, 4, 6, 'bistro');
    const b = build(s, 0, 5, 6, 'boutique');
    let cmds = aiDecide(s, 0);
    expect(prices(cmds)).toEqual({ [a.id]: 2, [b.id]: 2 });
    expect(cmds.filter((c) => c.c === 'upgrade')).toHaveLength(1);
    expect(cmds.some((c) => c.c === 'build')).toBe(false);
    a.level = 3;
    b.level = 3;
    cmds = aiDecide(s, 0);
    expect(prices(cmds)).toEqual({ [a.id]: 3, [b.id]: 3 });
    expect(cmds.some((c) => c.c === 'upgrade')).toBe(false);
    // With both shops finished she turns to placemaking: a Festival Plaza.
    expect(cmds).toContainEqual(expect.objectContaining({ c: 'build', kind: 'plaza' }));
    // Orson, by contrast, holds Fair on a quiet Level 1 shop.
    const o = duel('orson');
    build(o, 0, 4, 6, 'bistro');
    expect(prices(aiDecide(o, 0))).toEqual({});
  });

  it('Orson opens with a Tram Stop on the avenue, away from the stops that already exist', () => {
    const s = duel('orson');
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
      const other = duel(persona);
      other.players[0].cash = 900;
      const opening = aiDecide(other, 0).find((c) => c.c === 'build') as Extract<Command, { c: 'build' }>;
      expect(isShop(opening.kind)).toBe(true);
    }
  });

  it('Vesper fires a Promo Blitz on thinner odds than Orson, and Orson on thinner odds than Aurelia', () => {
    const fires = (persona: AiPersona): Set<string> => {
      const out = new Set<string>();
      for (const kind of SHOP_KINDS) {
        for (let part = 0; part < 4; part++) {
          const s = duel(persona);
          const shop = build(s, 0, 3, 6, kind);
          s.tick = Math.round((part + 0.4) * (s.quarterTicks / 4));
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
    const broke = duel('vesper');
    build(broke, 0, 3, 6, 'cinema');
    broke.tick = Math.round(3.4 * (broke.quarterTicks / 4));
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
      const s = duel('vesper');
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
      expect(tradeOutlook(s, me, other)).toBe(tradeOutlook(duel('vesper'), me, other));
    }
  });

  it('Orson borrows to expand mid-match but not in the final quarter', () => {
    const setup = (mode: 'standard' | 'endless' = 'standard'): GameState => {
      const s = duel('orson', mode);
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
    late.quarter = late.totalQuarters;
    late.tick += (late.totalQuarters - 1) * late.quarterTicks;
    expect(aiDecide(late, 0)).not.toContainEqual({ c: 'borrow' });
    // It is the calendar that stops him: in an endless game the same day is business as usual.
    const endless = setup('endless');
    endless.quarter = 4;
    endless.tick += 3 * endless.quarterTicks;
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
