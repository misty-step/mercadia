// Game helpers shared by planning, resolution, AI and every host: creation, calendar,
// modifiers, costs, scoring and the state hash. Pure: no DOM, Worker, Date or Math.random.
import {
  ACTIONS_BY_ERA,
  BOOK_VALUE,
  CHARTERS,
  CIVICS,
  CROWN,
  ERA_COUNT,
  MODES,
  SHARE_WINDOW,
  SHOPS,
  START_CASH,
  STUDIES,
  SUPPLY_CRUNCH,
  AUTO_RESTOCK_PREMIUM,
  UNITS,
  UPGRADE_COST,
  PROMO_COST,
  CONTRACT_DISCOUNT,
  RESTOCK_BATCH,
  isCivic,
  isShop,
  type CharterDef,
} from './constants';
import { CITY, N } from './map';
import { hashOf, shortHash } from './hash';
import type {
  Building,
  BuildKind,
  EventKind,
  Game,
  MatchConfig,
  Player,
  Standing,
  StudyKey,
  Unit,
  UnitKind,
} from './types';

export const emptyLost = () => ({ tooPricey: 0, queueFull: 0, outOfStock: 0, blockaded: 0 });

// ── Calendar ──

export const eraTurns = (g: Pick<Game, 'mode'>): number => MODES[g.mode].eraTurns;
/** The last turn of Era IV (the match ends after it, unless Endless). */
export const finalTurn = (g: Pick<Game, 'mode'>): number => eraTurns(g) * ERA_COUNT;
export const eraOfTurn = (g: Pick<Game, 'mode'>, turn: number): number =>
  Math.min(ERA_COUNT, Math.floor((Math.max(1, turn) - 1) / eraTurns(g)) + 1);
export const turnInEra = (g: Pick<Game, 'mode'>, turn: number): number => ((Math.max(1, turn) - 1) % eraTurns(g)) + 1;
export const daypartOf = (turn: number): 0 | 1 | 2 | 3 => ((Math.max(1, turn) - 1) % 4) as 0 | 1 | 2 | 3;
/** The first planning phase of Eras II–IV is a Council turn. */
export const isCouncilTurn = (g: Pick<Game, 'mode'>, turn: number): boolean =>
  turn > 1 && turn <= finalTurn(g) && (turn - 1) % eraTurns(g) === 0;
export const currentEra = (g: Game): number => eraOfTurn(g, g.turn);

// ── Coordinates ──

const COLS = 'ABCDEFGHIJKL';
/** "E4" — column letter and row number, as printed on the board. */
export const tileName = (tile: number): string => `${COLS[tile % 12]}${Math.floor(tile / 12) + 1}`;

// ── Lookup ──

export const buildingAt = (g: Game, tile: number): Building | undefined => g.buildings.find((b) => b.tile === tile);
export const buildingById = (g: Game, id: number): Building | undefined => g.buildings.find((b) => b.id === id);
export const unitById = (g: Game, id: number): Unit | undefined => g.units.find((u) => u.id === id);
export const unitAt = (g: Game, tile: number): Unit | undefined => g.units.find((u) => u.tile === tile);
export const unitsOf = (g: Game, p: number): Unit[] => g.units.filter((u) => u.owner === p);
export const buildingsOf = (g: Game, p: number): Building[] => g.buildings.filter((b) => b.owner === p);

export const isActiveEvent = (g: Game, kind: EventKind, turn: number = g.turn): boolean =>
  g.events.some((e) => e.kind === kind && e.start <= turn && turn <= e.end);

export function pactBetween(g: Game, a: number, b: number, kind: 'truce' | 'trade' | 'rent', turn: number = g.turn): boolean {
  return g.pacts.some((p) => p.kind === kind && p.from <= turn && turn <= p.to && ((p.a === a && p.b === b) || (p.a === b && p.b === a)));
}

// ── Modifiers ──

export function charterMult(p: Player, field: keyof CharterDef): number {
  let m = 1;
  for (const k of p.charters) m *= CHARTERS[k][field] as number;
  return m;
}
export const hasStudy = (p: Player, key: StudyKey): boolean => p.studies.includes(key);

/** Actions a House has this turn. */
export function actionsFor(g: Game, p: Player): number {
  let a = ACTIONS_BY_ERA[currentEra(g) - 1];
  for (const k of p.charters) a += CHARTERS[k].actions;
  if (p.milestones[3] > 0) a += 1;
  return a;
}

/** Barge movement allowance. */
export const moveOf = (p: Player, kind: UnitKind): number => (kind === 'barge' && hasStudy(p, 'hydraulics') ? 5 : UNITS[kind].move);
export const maxCohesion = (p: Player, kind: UnitKind): number => UNITS[kind].cohesion + (kind === 'watch' && hasStudy(p, 'drill') ? 1 : 0);

// ── Costs (all integer §) ──

const baseCost = (kind: BuildKind): number => (isShop(kind) ? SHOPS[kind].cost : CIVICS[kind].cost);

export function buildCostFor(p: Player, kind: BuildKind): number {
  let c = baseCost(kind);
  if (isCivic(kind)) {
    c *= charterMult(p, 'civicCost');
    if (kind === 'tramstop' && hasStudy(p, 'signalling')) c *= 0.8;
  }
  return Math.round(c);
}

export function upgradeCostFor(p: Player, b: Building): number {
  const idx = Math.min(1, Math.max(0, b.level - 1));
  let c = baseCost(b.kind) * UPGRADE_COST[idx] * charterMult(p, 'upgrade');
  if (b.level >= 2 && hasStudy(p, 'facades')) c *= 0.8;
  return Math.round(c);
}

export const supplyMult = (g: Game, p: Player, b: Building): number => {
  const locked = b.contractUntil >= g.turn;
  const crunch = !locked && isActiveEvent(g, 'supplycrunch') ? SUPPLY_CRUNCH : 1;
  return charterMult(p, 'supplies') * crunch;
};

/** Cost of a manual restock to full. */
export function restockCostFor(g: Game, p: Player, b: Building): number {
  if (!isShop(b.kind)) return 0;
  const def = SHOPS[b.kind];
  return Math.round(Math.max(0, def.stockMax - b.stock) * def.unitCost * supplyMult(g, p, b));
}
export function autoRestockCostFor(g: Game, p: Player, b: Building, missing: number): number {
  if (!isShop(b.kind)) return 0;
  const premium = p.charters.some((k) => !CHARTERS[k].autoPremium) ? 1 : AUTO_RESTOCK_PREMIUM;
  return Math.round(missing * SHOPS[b.kind].unitCost * supplyMult(g, p, b) * premium);
}
export function contractCostFor(p: Player, b: Building): number {
  if (!isShop(b.kind)) return 0;
  return Math.round(RESTOCK_BATCH * SHOPS[b.kind].unitCost * charterMult(p, 'supplies') * CONTRACT_DISCOUNT);
}
export const promoCostFor = (p: Player): number => Math.round(PROMO_COST * charterMult(p, 'promoCost'));

export const studyOf = (key: StudyKey) => STUDIES[key];

// ── Scoring ──

export function netWorth(g: Game, p: Player): number {
  let invested = 0;
  for (const b of g.buildings) if (b.owner === p.id) invested += b.invested;
  return p.cash - p.debt + Math.floor(BOOK_VALUE * invested);
}

export function computeStandings(g: Game): Standing[] {
  const totals = g.players.map((p) => p.sales.slice(-SHARE_WINDOW).reduce((a, b) => a + b, 0));
  const all = totals.reduce((a, b) => a + b, 0);
  const rows: Standing[] = g.players.map((p, i) => {
    const nw = netWorth(g, p);
    const worthComponent = Math.floor(Math.max(0, nw) * CROWN.netWorth);
    const shareComponent = all > 0 ? Math.floor((totals[i] * 100 * CROWN.share) / all) : 0;
    const prestigeComponent = Math.floor(p.prestige) * CROWN.prestige;
    return {
      player: i,
      crown: worthComponent + shareComponent + prestigeComponent,
      netWorth: nw,
      share: all > 0 ? Math.floor((totals[i] * 100) / all) : 0,
      shareComponent,
      worthComponent,
      prestigeComponent,
      prestige: Math.floor(p.prestige),
    };
  });
  return rows.sort((a, b) => b.crown - a.crown || b.netWorth - a.netWorth || b.prestige - a.prestige || a.player - b.player);
}

// ── Creation ──

/** Start tiles by player index: [Factor, Watch Company]. Two Houses begin beside Grand Station, two beside the Harbor Pier. */
const START_TILES: [number, number][] = [
  [7 + 12, 8 + 12], // beside Grand Station: (7,1) (8,1)
  [10 + 12, 9 + 12], // beside Grand Station: (10,1) (9,1)
  [3 + 132, 4 + 132], // beside the Harbor Pier: (3,11) (4,11)
  [6 + 132, 5 + 132], // beside the Harbor Pier: (6,11) (5,11)
];

export function createGame(cfg: MatchConfig): Game {
  const players: Player[] = cfg.players.slice(0, 4).map((s, i) => ({
    id: i,
    name: s.name,
    house: s.house,
    kind: s.kind,
    persona: s.persona,
    cash: START_CASH,
    debt: 0,
    prestige: 0,
    charters: [],
    milestones: [0, 0, 0, 0],
    dividend: 0,
    study: null,
    studyPoints: 0,
    studies: [],
    sales: [],
    stats: { served: 0, lost: 0, built: 0, promos: 0, budgetSales: 0, cornerRevenue: 0, civicBuilt: 0 },
  }));
  const units: Unit[] = [];
  let nextId = 1;
  players.forEach((p, i) => {
    const [f, w] = START_TILES[i];
    units.push({ id: nextId++, owner: p.id, kind: 'factor', tile: f, cohesion: 1, route: 0, fought: false });
    units.push({ id: nextId++, owner: p.id, kind: 'watch', tile: w, cohesion: 3, route: 0, fought: false });
  });
  const g: Game = {
    version: 3,
    seed: cfg.seed >>> 0,
    mode: cfg.mode,
    turn: 1,
    phase: 'planning',
    endless: cfg.mode === 'endless',
    players,
    buildings: [],
    units,
    pacts: [],
    proposals: [],
    events: [],
    council: null,
    nextId,
    chronicle: [],
    dispatchN: 0,
    trend: [],
    standings: [],
    winner: -1,
    honours: [],
    leader: -1,
  };
  g.standings = computeStandings(g);
  g.leader = g.standings[0]?.player ?? -1;
  return g;
}

// ── Hash ──

export const stateHash = (g: Game): string => hashOf(g);
export const stateHashShort = (g: Game): string => shortHash(stateHash(g));

export const cloneGame = (g: Game): Game => JSON.parse(JSON.stringify(g)) as Game;

/** Deterministic "tiles near the station" spawn order for land units. */
export const LAND_SPAWN: number[] = (() => {
  const out: number[] = [];
  const seen = new Set<number>([CITY.stationDoor]);
  const q = [CITY.stationDoor];
  for (let i = 0; i < q.length; i++) {
    const t = q[i];
    out.push(t);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = (t % 12) + dx;
      const y = Math.floor(t / 12) + dy;
      if (x < 0 || y < 0 || x >= 12 || y >= 12) continue;
      const n = y * 12 + x;
      if (!CITY.walk[n] || seen.has(n)) continue;
      seen.add(n);
      q.push(n);
    }
  }
  return out.slice(0, 24);
})();

export const WATER_SPAWN: number[] = (() => {
  const out: number[] = [];
  const mouth = 7 + 10 * 12;
  const seen = new Set<number>([mouth]);
  const q = [mouth];
  for (let i = 0; i < q.length; i++) {
    const t = q[i];
    if (CITY.tiles[t] === 'canal') out.push(t);
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
      const x = (t % 12) + dx;
      const y = Math.floor(t / 12) + dy;
      if (x < 0 || y < 0 || x >= 12 || y >= 12) continue;
      const n = y * 12 + x;
      if (seen.has(n) || n >= N) continue;
      const k = CITY.tiles[n];
      if (k !== 'canal' && k !== 'bridge' && k !== 'avbridge') continue;
      seen.add(n);
      q.push(n);
    }
  }
  return out;
})();
