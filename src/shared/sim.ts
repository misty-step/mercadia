// MERCADIA deterministic simulation. Pure functions over a JSON-serialisable GameState.
import {
  ARCHETYPES,
  ARCHS,
  ARCH_MIX,
  AUTO_RESTOCK_AT,
  AUTO_RESTOCK_PREMIUM,
  AURA_MAX,
  BOOK_VALUE,
  CANAL_APPEAL,
  CANAL_APPEAL_BISTRO,
  CIVICS,
  CORNER_PULL,
  CRITIC_PRESTIGE,
  CRITIC_PRIZE,
  CROWN,
  CRUISE_TOURISTS,
  DAY_DEMAND,
  DESIRES,
  EVENTS,
  FIRST_NAMES,
  FORECAST_LEAD,
  HALL_SERVERS,
  HOUSES,
  LAST_NAMES,
  LEVEL_APPEAL,
  LEVEL_SERVERS,
  LEVEL_SPEED,
  LOAN_MAX,
  LOAN_RATE,
  LOAN_STEP,
  MODES,
  PARK_AURA,
  PAYROLL_TICKS,
  PLAZA_AURA,
  POP_MAX,
  POP_TARGET,
  PRESTIGE_AURA_SALE,
  PRESTIGE_LINGER,
  PRESTIGE_TRAM,
  PROMO_COOLDOWN,
  PROMO_COST,
  PROMO_DESIRE,
  PROMO_PULL,
  PROMO_TICKS,
  RENT_HIKE,
  SALVAGE,
  SHOPS,
  STANCES,
  START_CASH,
  SUPPLY_CRUNCH,
  TRANSIT_PULL,
  TRANSIT_RADIUS,
  UPGRADE_COST,
  buildCost,
  buildName,
  isCivic,
  isShop,
} from './constants';
import { CITY, N, chebyshev, manhattan, pathTo, tx, ty, walkDist } from './map';
import {
  CS,
  type Archetype,
  type Award,
  type Building,
  type BuildKind,
  type Citizen,
  type CityEvent,
  type CmdResult,
  type Command,
  type Daypart,
  type Desire,
  type EventKind,
  type GameOptions,
  type GameState,
  type GazetteLine,
  type Ledger,
  type LotBonuses,
  type MatchResult,
  type Player,
  type ShopKind,
  type Tram,
} from './types';

// ───────────────────────────── PRNG ─────────────────────────────

/** mulberry32; the generator state lives in GameState so a match can be checkpointed. */
export function rand(s: { rng: number }): number {
  let t = (s.rng = (s.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (s: { rng: number }, a: number, b: number): number => a + Math.floor(rand(s) * (b - a + 1));
const randRange = (s: { rng: number }, a: number, b: number): number => a + rand(s) * (b - a);
function pickWeighted(s: { rng: number }, weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return -1;
  let r = rand(s) * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export function hash32(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) + Math.imul(b + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

export function citizenName(seed: number, id: number): string {
  const h = hash32(seed, id);
  return `${FIRST_NAMES[h % FIRST_NAMES.length]} ${LAST_NAMES[(h >>> 8) % LAST_NAMES.length]}`;
}

/** Per-tick decay of the takings accumulators (half-life about 30 s). */
export const REV_DECAY = 0.9977;
/** Converts a building's `recent` accumulator into § per minute at the current pace. */
export const TAKINGS_PER_MIN = (1 - REV_DECAY) * 600;

// ───────────────────────────── Creation ─────────────────────────────

export const emptyLedger = (): Ledger => ({
  revenue: 0, wages: 0, supplies: 0, rent: 0, interest: 0,
  construction: 0, civic: 0, marketing: 0, salvage: 0, awards: 0,
});

export const ledgerNet = (l: Ledger): number =>
  l.revenue + l.salvage + l.awards - l.wages - l.supplies - l.rent - l.interest - l.construction - l.civic - l.marketing;

export function createGame(opts: GameOptions): GameState {
  const mode = MODES[opts.mode];
  if (opts.players.length < 1 || opts.players.length > 4) throw new Error('MERCADIA seats 1 to 4 players');
  const players: Player[] = opts.players.map((p, i) => ({
    id: i,
    name: p.name,
    house: p.house,
    kind: p.kind,
    persona: p.kind === 'ai' ? (p.persona ?? 'vesper') : null,
    cash: START_CASH,
    debt: 0,
    prestige: 0,
    recentRev: 0,
    ledger: emptyLedger(),
    lastLedger: emptyLedger(),
    totalLedger: emptyLedger(),
    stats: { served: 0, turnedAway: 0, built: 0, promos: 0, budgetSales: 0, cornerRevenue: 0, civicBuilt: 0, goldenForks: 0 },
    aiNext: 12 + i * 7,
  }));
  const L = CITY.loop.length;
  const state: GameState = {
    seed: opts.seed >>> 0,
    rng: (opts.seed >>> 0) ^ 0x51ab3d,
    tick: 0,
    mode: opts.mode,
    quarterTicks: mode.quarterTicks,
    totalQuarters: mode.quarters,
    quarter: 1,
    phase: 'playing',
    endless: opts.mode === 'endless',
    players,
    buildings: [],
    nextBuildingId: 1,
    citizens: [],
    nextCitizenId: 1,
    trams: [newTram(2), newTram(2 + L / 2)],
    events: [],
    eventBag: [],
    gazette: [],
    gazetteN: 0,
    footfall: new Array<number>(N).fill(0),
    met: DESIRES.map(() => 0),
    unmet: DESIRES.map(() => 0),
    spawnAcc: 0,
    cruiseLeft: 0,
    fx: [],
    result: null,
  };
  scheduleEvents(state);
  // The streets are already busy at tick zero.
  for (let i = 0; i < 66; i++) spawnCitizen(state, { scatter: true });
  pushGazette(state, 'The district wakes. Lots are for lease along every lane.', 'market');
  state.fx.length = 0;
  return state;
}

function newTram(pos: number, special = false): Tram {
  return { pos, v: 0.08, dwell: 0, drops: 0, dropTile: -1, special };
}

// ───────────────────────────── Clock ─────────────────────────────

export const quarterTick = (s: Pick<GameState, 'tick' | 'quarter' | 'quarterTicks'>): number =>
  s.tick - (s.quarter - 1) * s.quarterTicks;
/** 0..1 through the current day. */
export const dayPhase = (s: Pick<GameState, 'tick' | 'quarter' | 'quarterTicks'>): number =>
  clamp(quarterTick(s) / s.quarterTicks, 0, 0.9999);
export const daypart = (s: Pick<GameState, 'tick' | 'quarter' | 'quarterTicks'>): Daypart =>
  Math.min(3, Math.floor(dayPhase(s) * 4)) as Daypart;

// ───────────────────────────── Lookups ─────────────────────────────

export const buildingAt = (s: { buildings: Building[] }, tile: number): Building | undefined =>
  s.buildings.find((b) => b.tile === tile);
export const buildingById = (s: { buildings: Building[] }, id: number): Building | undefined =>
  s.buildings.find((b) => b.id === id);

export const priceOf = (b: Pick<Building, 'kind' | 'stance'>): number =>
  isShop(b.kind) ? Math.max(1, Math.round(SHOPS[b.kind].price * STANCES[b.stance].mult)) : 0;
export const queueCap = (b: Pick<Building, 'kind' | 'level'>): number =>
  isShop(b.kind) ? SHOPS[b.kind].queueCap[b.level - 1] : 0;
export const serversOf = (b: Pick<Building, 'kind' | 'level'>): number =>
  isShop(b.kind) ? SHOPS[b.kind].servers + (SHOPS[b.kind].servers >= HALL_SERVERS ? LEVEL_SERVERS[b.level - 1] : 0) : 0;
export const serviceTicksOf = (b: Pick<Building, 'kind' | 'level'>): number =>
  isShop(b.kind) ? Math.max(4, Math.round(SHOPS[b.kind].serviceTicks * LEVEL_SPEED[b.level - 1])) : 0;
export const upgradeCost = (b: Pick<Building, 'kind' | 'level'>): number =>
  isShop(b.kind) && b.level < 3 ? Math.round(SHOPS[b.kind].cost * UPGRADE_COST[b.level - 1]) : 0;
export const salvageValue = (b: Pick<Building, 'invested'>): number => Math.round(b.invested * SALVAGE);
export const wageOf = (b: Pick<Building, 'kind' | 'level'>): number =>
  isShop(b.kind) ? Math.round(SHOPS[b.kind].wage * (1 + 0.2 * (b.level - 1))) : 0;
export const rentOf = (b: Pick<Building, 'kind' | 'level'>, hike = false): number => {
  const base = isShop(b.kind) ? SHOPS[b.kind].rent * (1 + 0.15 * (b.level - 1)) : CIVICS[b.kind].rent;
  return Math.round(base * (hike ? RENT_HIKE : 1) * 100) / 100;
};

export function activeEvent(s: Pick<GameState, 'events' | 'tick'>): CityEvent | null {
  for (const e of s.events) if (e.started && s.tick < e.endAt) return e;
  return null;
}
export const eventActive = (s: Pick<GameState, 'events' | 'tick'>, kind: EventKind): boolean =>
  activeEvent(s)?.kind === kind;
/** The running event, or the next forecast one. */
export function headlineEvent(s: Pick<GameState, 'events' | 'tick'>): CityEvent | null {
  const a = activeEvent(s);
  if (a) return a;
  for (const e of s.events) if (!e.started && s.tick >= e.announceAt && s.tick < e.startAt) return e;
  return null;
}

/** Event multiplier on how many citizens want a given desire right now. */
export function demandMult(s: Pick<GameState, 'events' | 'tick'>, desire: Desire): number {
  const e = activeEvent(s);
  return e ? (EVENTS[e.kind].demand[desire] ?? 1) : 1;
}

/** Avenue tiles where trams call: city stops plus player-built Tram Stops. */
export function stopTiles(s: { buildings: Pick<Building, 'kind' | 'tile'>[] }): number[] {
  const out = CITY.fixedStops.slice();
  for (const b of s.buildings) {
    if (b.kind !== 'tramstop') continue;
    const t = CITY.avenueAdj[b.tile];
    if (t >= 0 && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Land-value bonuses of a lot given what is built around it. */
export function lotBonuses(s: { buildings: Pick<Building, 'kind' | 'tile'>[] }, tile: number): LotBonuses {
  let parks = 0;
  let plaza = false;
  let transit = false;
  for (const b of s.buildings) {
    if (b.tile === tile) continue;
    if (b.kind === 'park' && chebyshev(b.tile, tile) <= 1) parks++;
    else if (b.kind === 'plaza' && chebyshev(b.tile, tile) <= 2) plaza = true;
  }
  for (const st of stopTiles(s)) {
    if (manhattan(st, tile) <= TRANSIT_RADIUS) {
      transit = true;
      break;
    }
  }
  return { corner: CITY.corner[tile], canal: CITY.canalFront[tile], transit, parks: Math.min(2, parks), plaza };
}

/** Live foot traffic past a lot's door, 1..5 pips. */
export function trafficPips(s: { buildings: Pick<Building, 'kind' | 'tile'>[]; footfall: number[] }, tile: number): number {
  const door = CITY.door[tile];
  if (door < 0) return 1;
  let total = 0;
  for (const w of CITY.walkable) total += s.footfall[w];
  const avg = total / CITY.walkable.length;
  let local = s.footfall[door];
  let n = 1;
  const dx = tx(door);
  const dy = ty(door);
  for (const w of CITY.walkable) {
    if (w !== door && Math.abs(tx(w) - dx) + Math.abs(ty(w) - dy) === 1) {
      local += s.footfall[w] * 0.5;
      n += 0.5;
    }
  }
  const live = avg > 0.001 ? clamp(local / n / avg, 0, 2.4) : 1;
  const bon = lotBonuses(s, tile);
  const score = 0.7 + live * 1.35 + (bon.corner ? 0.6 : 0) + (bon.transit ? 0.6 : 0);
  return clamp(Math.round(score), 1, 5);
}

// ───────────────────────────── Shop choice ─────────────────────────────

/** Quality as a citizen perceives it, before the archetype's quality exponent. */
export function shopQuality(s: GameState, b: Building, withRating = true): number {
  const bon = lotBonuses(s, b.tile);
  let q = LEVEL_APPEAL[b.level - 1] * STANCES[b.stance].cachet;
  q *= 1 + Math.min(AURA_MAX, PARK_AURA * bon.parks + (bon.plaza ? PLAZA_AURA : 0));
  if (bon.canal) q *= b.kind === 'bistro' ? CANAL_APPEAL_BISTRO : CANAL_APPEAL;
  if (bon.plaza && (b.kind === 'bistro' || b.kind === 'boutique')) q *= 1.08;
  if (withRating) q *= 0.9 + 0.04 * b.rating;
  return q;
}

/**
 * The competitive shop-selection formula.
 * score = distancePull × priceValue × quality × queueFactor × promo
 */
export function shopScore(s: GameState, b: Building, arch: Archetype, fromTile: number): number {
  if (!isShop(b.kind)) return 0;
  const door = CITY.door[b.tile];
  const d = fromTile === door ? 0 : walkDist(fromTile, door);
  if (d < 0) return 0;
  const a = ARCHS[arch];
  const bon = lotBonuses(s, b.tile);
  let pull = 1 / (1 + d / 7);
  if (bon.corner) pull *= CORNER_PULL;
  if (bon.transit) pull *= TRANSIT_PULL * (b.kind === 'arcade' ? 1.18 : 1);
  const value = Math.pow(1 / STANCES[b.stance].mult, a.sens);
  const quality = Math.pow(shopQuality(s, b), a.qlove);
  const load = b.queue.length / queueCap(b);
  const queueF = load >= 1 ? 0.12 : 1 / (1 + 1.5 * load * load);
  const promo = s.tick < b.promoUntil ? PROMO_PULL : 1;
  return pull * value * quality * queueF * promo;
}

/**
 * Would this citizen pay a premium here? Only consulted above Fair: a Craft or Prestige
 * price must be earned with quality, or the citizen keeps their money.
 */
export function acceptance(s: GameState, b: Building, arch: Archetype): number {
  const a = ARCHS[arch];
  const worth = Math.pow(1 / STANCES[b.stance].mult, a.sens) * Math.pow(shopQuality(s, b), a.qlove);
  return clamp(Math.pow(worth, 1.5), 0.12, 1);
}

/** Best open, affordable shop for a desire, or null. */
export function chooseShop(
  s: GameState,
  c: Pick<Citizen, 'arch' | 'budget' | 'tried'>,
  desire: Desire,
  fromTile: number,
  jitter = true,
): Building | null {
  let best: Building | null = null;
  let bestScore = 0;
  for (const b of s.buildings) {
    if (!isShop(b.kind) || SHOPS[b.kind].desire !== desire) continue;
    if (b.dry || b.stock <= 0) continue;
    if (priceOf(b) > c.budget) continue;
    if (c.tried.includes(b.id)) continue;
    let sc = shopScore(s, b, c.arch, fromTile);
    if (jitter) {
      // Too dear for what it is — unless a Promo Blitz is on.
      if (b.stance > 1 && s.tick >= b.promoUntil && rand(s) > acceptance(s, b, c.arch)) continue;
      sc *= 0.85 + 0.3 * rand(s);
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = b;
    }
  }
  return best;
}

// ───────────────────────────── Scores ─────────────────────────────

export function netWorth(s: Pick<GameState, 'buildings'>, p: Pick<Player, 'id' | 'cash' | 'debt'>): number {
  let v = p.cash - p.debt;
  for (const b of s.buildings) if (b.owner === p.id) v += b.invested * BOOK_VALUE;
  return Math.round(v);
}

export function marketShares(s: Pick<GameState, 'players'>): number[] {
  let total = 0;
  for (const p of s.players) total += p.recentRev;
  return s.players.map((p) => (total > 0.5 ? p.recentRev / total : 0));
}

export function crownIndex(s: GameState, p: Player): number {
  const share = marketShares(s)[p.id];
  return Math.round(netWorth(s, p) * CROWN.netWorth + share * 100 * CROWN.share + p.prestige * CROWN.prestige);
}

export function standings(s: GameState): { player: number; crown: number }[] {
  return s.players
    .map((p) => ({ player: p.id, crown: crownIndex(s, p) }))
    .sort((a, b) => b.crown - a.crown || a.player - b.player);
}

export function buildResult(s: GameState): MatchResult {
  const shares = marketShares(s);
  const rows = s.players.map((p) => ({
    player: p.id,
    crown: crownIndex(s, p),
    netWorth: netWorth(s, p),
    share: shares[p.id],
    prestige: Math.round(p.prestige * 10) / 10,
    revenue: Math.round(p.totalLedger.revenue),
    served: p.stats.served,
    shops: s.buildings.filter((b) => b.owner === p.id && isShop(b.kind)).length,
    civic: s.buildings.filter((b) => b.owner === p.id && !isShop(b.kind)).length,
  }));
  const top = (f: (p: Player) => number): Player | null => {
    let best: Player | null = null;
    for (const p of s.players) if (f(p) > 0 && (!best || f(p) > f(best))) best = p;
    return best;
  };
  const awards: Award[] = [];
  const corner = top((p) => p.stats.cornerRevenue);
  if (corner)
    awards.push({ key: 'corner', title: 'Corner King', player: corner.id, detail: `§${Math.round(corner.stats.cornerRevenue)} taken on corner lots` });
  const shark = top((p) => p.stats.budgetSales);
  if (shark)
    awards.push({ key: 'shark', title: 'Price Shark', player: shark.id, detail: `${shark.stats.budgetSales} sales at Budget prices` });
  const patron = top((p) => p.prestige);
  if (patron)
    awards.push({ key: 'patron', title: 'Civic Patron', player: patron.id, detail: `${Math.round(patron.prestige)} Civic Prestige` });
  return { winner: standings(s)[0].player, rows, awards };
}

// ───────────────────────────── Ledger helpers ─────────────────────────────

function book(p: Player, key: keyof Ledger, amt: number): void {
  p.ledger[key] += amt;
  p.totalLedger[key] += amt;
}

export function pushGazette(s: GameState, text: string, tone: GazetteLine['tone']): void {
  s.gazetteN++;
  s.gazette.push({ tick: s.tick, text, tone });
  if (s.gazette.length > 10) s.gazette.splice(0, s.gazette.length - 10);
}

const houseName = (p: Player): string => HOUSES[p.house].short;

// ───────────────────────────── Commands ─────────────────────────────

const fail = (err: string): CmdResult => ({ ok: false, err });
const OK: CmdResult = { ok: true };

export function restockCost(s: Pick<GameState, 'events' | 'tick'>, b: Pick<Building, 'kind' | 'stock'>, auto: boolean): number {
  if (!isShop(b.kind)) return 0;
  const def = SHOPS[b.kind];
  const units = Math.max(0, def.stockMax - b.stock);
  return priceUp(units * unitSupplyCost(s, b.kind, auto));
}

/** What one unit of stock costs right now. */
function unitSupplyCost(s: Pick<GameState, 'events' | 'tick'>, kind: ShopKind, auto: boolean): number {
  return SHOPS[kind].unitCost * (eventActive(s, 'supplycrunch') ? SUPPLY_CRUNCH : 1) * (auto ? AUTO_RESTOCK_PREMIUM : 1);
}
/** Round up to whole §, immune to floating-point dust (24.000000000000004 → 24). */
const priceUp = (v: number): number => Math.ceil(Math.round(v * 100) / 100);

function restock(s: GameState, b: Building, auto: boolean): boolean {
  if (!isShop(b.kind)) return false;
  const def = SHOPS[b.kind];
  const p = s.players[b.owner];
  const unit = unitSupplyCost(s, b.kind, auto);
  let units = def.stockMax - b.stock;
  if (units <= 0) return false;
  if (p.cash < units * unit) units = Math.floor(Math.max(0, p.cash) / unit);
  if (units <= 0) return false;
  const cost = priceUp(units * unit);
  p.cash -= cost;
  book(p, 'supplies', cost);
  b.stock += units;
  b.dry = false;
  return true;
}

export function canBuild(s: GameState, playerId: number, tile: number, kind: BuildKind): CmdResult {
  const p = s.players[playerId];
  if (!p) return fail('Unknown player');
  if (!Number.isInteger(tile) || tile < 0 || tile >= N || CITY.tiles[tile] !== 'lot') return fail('Not a buildable lot');
  if (buildingAt(s, tile)) return fail('Lot is already built on');
  if (!(isShop(kind) || isCivic(kind))) return fail('Unknown building');
  if (kind === 'tramstop' && CITY.avenueAdj[tile] < 0) return fail('A Tram Stop must touch the avenue');
  if (p.cash < buildCost(kind)) return fail('Not enough cash');
  return OK;
}

export function applyCommand(s: GameState, playerId: number, cmd: Command): CmdResult {
  if (s.phase !== 'playing') return fail('The match is not running');
  const p = s.players[playerId];
  if (!p || !cmd || typeof cmd !== 'object') return fail('Bad command');
  switch (cmd.c) {
    case 'build': {
      const chk = canBuild(s, playerId, cmd.tile, cmd.kind);
      if (!chk.ok) return chk;
      const cost = buildCost(cmd.kind);
      const shop = isShop(cmd.kind);
      const b: Building = {
        id: s.nextBuildingId++,
        tile: cmd.tile,
        kind: cmd.kind,
        owner: playerId,
        level: 1,
        stance: 1,
        stock: shop ? SHOPS[cmd.kind as ShopKind].stockMax : 0,
        auto: true,
        promoUntil: 0,
        promoReadyAt: 0,
        queue: [],
        serving: [],
        served: 0,
        revenue: 0,
        recent: 0,
        turned: 0,
        rating: 3.5,
        invested: cost,
        builtTick: s.tick,
        dry: false,
      };
      s.buildings.push(b);
      p.cash -= cost;
      p.stats.built++;
      if (shop) book(p, 'construction', cost);
      else {
        book(p, 'civic', cost);
        p.prestige += CIVICS[cmd.kind as keyof typeof CIVICS].prestige;
        p.stats.civicBuilt++;
        pushGazette(s, `${houseName(p)} dedicates a ${buildName(cmd.kind)} to the district.`, 'civic');
      }
      s.fx.push({ k: 'build', tile: cmd.tile, kind: cmd.kind, p: playerId });
      return OK;
    }
    case 'borrow': {
      if (p.debt + LOAN_STEP > LOAN_MAX) return fail('Credit line is exhausted');
      p.debt += LOAN_STEP;
      p.cash += LOAN_STEP;
      return OK;
    }
    case 'repay': {
      const amt = Math.min(p.debt, LOAN_STEP, Math.max(0, Math.floor(p.cash)));
      if (p.debt <= 0) return fail('No debt to repay');
      if (amt <= 0) return fail('Not enough cash');
      p.debt -= amt;
      p.cash -= amt;
      return OK;
    }
    default:
      break;
  }
  const b = buildingById(s, (cmd as { id: number }).id);
  if (!b) return fail('No such building');
  if (b.owner !== playerId) return fail('Not your property');
  switch (cmd.c) {
    case 'price': {
      if (!isShop(b.kind)) return fail('Only shops set prices');
      if (!Number.isInteger(cmd.stance) || cmd.stance < 0 || cmd.stance > 3) return fail('Unknown price stance');
      if (cmd.stance === 0 && b.stance !== 0) {
        const rival = s.buildings.find((o) => o.kind === b.kind && o.owner !== b.owner && manhattan(o.tile, b.tile) <= 5);
        const last = s.gazette[s.gazette.length - 1];
        if (rival && (!last || last.tone !== 'market' || s.tick - last.tick > 150))
          pushGazette(s, `Price war: ${houseName(p)} slashes ${buildName(b.kind)} prices against ${houseName(s.players[rival.owner])}.`, 'market');
      }
      b.stance = cmd.stance;
      return OK;
    }
    case 'upgrade': {
      if (!isShop(b.kind)) return fail('Only shops upgrade');
      if (b.level >= 3) return fail('Already at Level 3');
      const cost = upgradeCost(b);
      if (p.cash < cost) return fail('Not enough cash');
      p.cash -= cost;
      book(p, 'construction', cost);
      b.invested += cost;
      b.level++;
      s.fx.push({ k: 'upgrade', b: b.id, p: playerId });
      return OK;
    }
    case 'promo': {
      if (!isShop(b.kind)) return fail('Only shops run promotions');
      if (s.tick < b.promoReadyAt) return fail('Promo Blitz is cooling down');
      if (p.cash < PROMO_COST) return fail('Not enough cash');
      p.cash -= PROMO_COST;
      book(p, 'marketing', PROMO_COST);
      b.promoUntil = s.tick + PROMO_TICKS;
      b.promoReadyAt = b.promoUntil + PROMO_COOLDOWN;
      p.stats.promos++;
      s.fx.push({ k: 'promo', b: b.id, p: playerId });
      return OK;
    }
    case 'restock': {
      if (!isShop(b.kind)) return fail('Only shops hold stock');
      if (b.stock >= SHOPS[b.kind].stockMax) return fail('Stockroom is full');
      if (!restock(s, b, false)) return fail('Not enough cash');
      s.fx.push({ k: 'restock', b: b.id, p: playerId });
      return OK;
    }
    case 'auto': {
      if (!isShop(b.kind)) return fail('Only shops hold stock');
      b.auto = !!cmd.on;
      return OK;
    }
    case 'sell': {
      const refund = salvageValue(b);
      p.cash += refund;
      book(p, 'salvage', refund);
      if (!isShop(b.kind)) p.prestige = Math.max(0, p.prestige - CIVICS[b.kind].prestige);
      s.buildings.splice(s.buildings.indexOf(b), 1);
      s.fx.push({ k: 'sell', tile: b.tile, p: playerId });
      return OK;
    }
    default:
      return fail('Unknown command');
  }
}

// ───────────────────────────── Events ─────────────────────────────

const DAY_BAG: EventKind[] = ['cloudburst', 'cruise', 'freeride', 'critic', 'renthike', 'supplycrunch'];

function drawEvent(s: GameState, avoid: EventKind | null): EventKind {
  if (s.eventBag.length === 0) {
    s.eventBag = DAY_BAG.slice();
    for (let i = s.eventBag.length - 1; i > 0; i--) {
      const j = randInt(s, 0, i);
      [s.eventBag[i], s.eventBag[j]] = [s.eventBag[j], s.eventBag[i]];
    }
  }
  let at = s.eventBag.length - 1;
  if (s.eventBag[at] === avoid && at > 0) at--;
  return s.eventBag.splice(at, 1)[0];
}

function scheduleEvents(s: GameState): void {
  const mode = MODES[s.mode];
  const start = (s.quarter - 1) * s.quarterTicks;
  const span = Math.round(mode.span * s.quarterTicks);
  const lead = Math.round(FORECAST_LEAD * s.quarterTicks);
  s.events = [];
  let prev: EventKind | null = null;
  mode.slots.forEach((f, i) => {
    const evening = i === mode.slots.length - 1;
    const kind: EventKind = evening && rand(s) < 0.5 ? 'lantern' : drawEvent(s, prev);
    prev = kind;
    const startAt = start + Math.round(f * s.quarterTicks);
    s.events.push({ kind, announceAt: startAt - lead, startAt, endAt: startAt + span, started: false });
  });
}

/** Start an event immediately (used by tests and debugging). Replaces the quarter's schedule. */
export function forceEvent(s: GameState, kind: EventKind, ticks = 250): CityEvent {
  for (const e of s.events) if (e.started && s.tick < e.endAt) endEvent(s, e);
  const ev: CityEvent = { kind, announceAt: s.tick, startAt: s.tick, endAt: s.tick + ticks, started: false };
  s.events = [ev];
  startEvent(s, ev);
  return ev;
}

function startEvent(s: GameState, e: CityEvent): void {
  e.started = true;
  pushGazette(s, EVENTS[e.kind].headline, 'event');
  s.fx.push({ k: 'event', kind: e.kind, phase: 'start' });
  if (e.kind === 'cruise') s.cruiseLeft = CRUISE_TOURISTS;
  if (e.kind === 'freeride') {
    const lead = s.trams[0];
    s.trams.push(newTram((lead.pos + CITY.loop.length / 4) % CITY.loop.length, true));
  }
}

function endEvent(s: GameState, e: CityEvent): void {
  s.fx.push({ k: 'event', kind: e.kind, phase: 'end' });
  if (e.kind === 'freeride') s.trams = s.trams.filter((t) => !t.special);
  if (e.kind === 'cruise') s.cruiseLeft = 0;
  if (e.kind === 'critic') awardGoldenFork(s);
}

function awardGoldenFork(s: GameState): void {
  let best: Building | null = null;
  for (const b of s.buildings) {
    if (b.kind !== 'bistro' && b.kind !== 'roastery') continue;
    if (!best || b.rating > best.rating || (b.rating === best.rating && b.served > best.served)) best = b;
  }
  if (!best) {
    pushGazette(s, 'The critic leaves hungry: not one kitchen was open.', 'event');
    return;
  }
  const p = s.players[best.owner];
  p.cash += CRITIC_PRIZE;
  book(p, 'awards', CRITIC_PRIZE);
  p.prestige += CRITIC_PRESTIGE;
  p.stats.goldenForks++;
  best.rating = Math.min(5, best.rating + 0.3);
  s.fx.push({ k: 'award', b: best.id, p: p.id });
  pushGazette(s, `Golden Fork: the critic crowns ${houseName(p)}'s ${buildName(best.kind)}. §${CRITIC_PRIZE} and lasting prestige.`, 'event');
}

function stepEvents(s: GameState): void {
  for (const e of s.events) {
    if (!e.started && s.tick === e.announceAt && e.announceAt < e.startAt) {
      pushGazette(s, EVENTS[e.kind].forecast, 'event');
      s.fx.push({ k: 'event', kind: e.kind, phase: 'forecast' });
    }
    if (!e.started && s.tick >= e.startAt && s.tick < e.endAt) startEvent(s, e);
    if (e.started && s.tick === e.endAt) endEvent(s, e);
  }
}

// ───────────────────────────── Trams ─────────────────────────────

/** Continuous tile-space position of a point along the tram loop. */
export function loopPoint(pos: number): { x: number; y: number; dx: number; dy: number } {
  const L = CITY.loop.length;
  const p = ((pos % L) + L) % L;
  const i = Math.floor(p);
  const f = p - i;
  const a = CITY.loop[i];
  const b = CITY.loop[(i + 1) % L];
  const ax = tx(a) + 0.5;
  const ay = ty(a) + 0.5;
  const bx = tx(b) + 0.5;
  const by = ty(b) + 0.5;
  return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f, dx: bx - ax, dy: by - ay };
}

function stepTrams(s: GameState): void {
  const L = CITY.loop.length;
  const stops = stopTiles(s);
  const part = daypart(s);
  for (const t of s.trams) {
    if (t.dwell > 0) {
      t.dwell--;
      if (t.drops > 0 && t.dwell % 4 === 0) {
        t.drops--;
        if (s.citizens.length < POP_MAX) spawnCitizen(s, { arch: rand(s) < 0.75 ? 'commuter' : 'local', at: t.dropTile });
      }
      continue;
    }
    const i0 = Math.floor(t.pos + 1e-9);
    let ahead = L;
    for (let k = 1; k <= L; k++) {
      if (stops.includes(CITY.loop[(i0 + k) % L])) {
        ahead = i0 + k - t.pos;
        break;
      }
    }
    const want = Math.min(0.115, 0.022 + ahead * 0.085);
    t.v += clamp(want - t.v, -0.02, 0.01);
    const np = t.pos + t.v;
    const i1 = Math.floor(np + 1e-9);
    if (i1 > i0 && stops.includes(CITY.loop[i1 % L])) {
      const tile = CITY.loop[i1 % L];
      t.pos = i1 % L;
      t.v = 0;
      t.dwell = 28;
      let n = randInt(s, 3, 5);
      if (part === 0) n = Math.round(n * 1.5);
      if (part === 3) n = Math.max(2, n - 1);
      if (eventActive(s, 'freeride')) n *= 2;
      t.drops = n;
      t.dropTile = tile;
      s.fx.push({ k: 'bell', tile });
      for (const b of s.buildings) {
        if (b.kind === 'tramstop' && CITY.avenueAdj[b.tile] === tile) s.players[b.owner].prestige += PRESTIGE_TRAM;
      }
      continue;
    }
    t.pos = np % L;
  }
}

// ───────────────────────────── Citizens ─────────────────────────────

const centerX = (tile: number): number => tx(tile) + 0.5;
const centerY = (tile: number): number => ty(tile) + 0.5;

/** The walkable tile a citizen currently stands on (or the door of the lot they are on). */
export function citizenTile(c: Pick<Citizen, 'x' | 'y'>): number {
  const x = clamp(Math.floor(c.x), 0, 11);
  const y = clamp(Math.floor(c.y), 0, 11);
  const t = y * 12 + x;
  if (CITY.walk[t]) return t;
  if (CITY.door[t] >= 0) return CITY.door[t];
  let best = CITY.walkable[0];
  let bd = 1e9;
  for (const w of CITY.walkable) {
    const d = Math.abs(centerX(w) - c.x) + Math.abs(centerY(w) - c.y);
    if (d < bd) {
      bd = d;
      best = w;
    }
  }
  return best;
}

/** Where the n-th person in a shop's queue stands (tile-space). */
export function queueSlot(tile: number, n: number): { x: number; y: number } {
  const door = CITY.door[tile];
  const south = CITY.doorDir[tile] === 0;
  const row = Math.floor(n / 6);
  const col = n % 6;
  const along = -0.38 + col * 0.152;
  const off = 0.36 - row * 0.17;
  // dir points from the door tile toward the lot.
  return south
    ? { x: centerX(door) + along, y: centerY(door) - off }
    : { x: centerX(door) - off, y: centerY(door) + along };
}

interface SpawnOpts {
  arch?: Archetype;
  at?: number;
  scatter?: boolean;
}

export function spawnCitizen(s: GameState, opts: SpawnOpts = {}): Citizen {
  const part = daypart(s);
  const arch = opts.arch ?? ARCHETYPES[pickWeighted(s, ARCH_MIX[part])];
  const def = ARCHS[arch];
  const stops = stopTiles(s);
  const homeDoor = CITY.homeDoors[randInt(s, 0, CITY.homeDoors.length - 1)];
  let origin: number;
  let exit: number;
  if (arch === 'tourist') {
    origin = rand(s) < 0.55 ? CITY.stationDoor : CITY.pierTile;
    exit = rand(s) < 0.5 ? CITY.stationDoor : CITY.pierTile;
  } else if (arch === 'commuter') {
    const stop = stops[randInt(s, 0, stops.length - 1)];
    origin = rand(s) < 0.5 ? homeDoor : stop;
    exit = origin === stop ? homeDoor : stop;
  } else {
    origin = homeDoor;
    exit = homeDoor;
  }
  if (opts.at !== undefined) origin = opts.at;
  if (opts.scatter) origin = CITY.walkable[randInt(s, 0, CITY.walkable.length - 1)];
  const c: Citizen = {
    id: s.nextCitizenId++,
    arch,
    x: centerX(origin) + randRange(s, -0.22, 0.22),
    y: centerY(origin) + randRange(s, -0.22, 0.22),
    state: CS.Stroll,
    desire: 'coffee',
    budget: randInt(s, def.budget[0], def.budget[1]),
    patience: randInt(s, def.patience[0], def.patience[1]),
    waited: 0,
    mood: randRange(s, 0.55, 0.85),
    target: -1,
    path: [],
    tried: [],
    wants: randInt(s, def.wants[0], def.wants[1]),
    timer: 0,
    exit,
    from: origin,
  };
  s.citizens.push(c);
  // Tourists gather at a plaza first; residents sometimes take the air in a park.
  const magnet = arch === 'tourist' ? 'plaza' : arch === 'local' || arch === 'foodie' ? 'park' : null;
  if (magnet && rand(s) < (magnet === 'plaza' ? 0.6 : 0.25) && strollToCivic(s, c, magnet)) return c;
  decide(s, c);
  return c;
}

function strollToCivic(s: GameState, c: Citizen, kind: 'park' | 'plaza'): boolean {
  const here = citizenTile(c);
  let best: Building | null = null;
  let bd = 1e9;
  for (const b of s.buildings) {
    if (b.kind !== kind) continue;
    const d = walkDist(here, CITY.door[b.tile]) * (0.7 + 0.6 * rand(s));
    if (d >= 0 && d < bd) {
      bd = d;
      best = b;
    }
  }
  if (!best) return false;
  c.state = CS.Stroll;
  c.target = best.id;
  c.path = pathTo(here, CITY.door[best.tile]);
  return true;
}

function goLeave(c: Citizen): void {
  c.state = CS.Leave;
  c.target = -1;
  c.path = pathTo(citizenTile(c), c.exit);
}

function headTo(c: Citizen, b: Building, desire: Desire): void {
  const here = citizenTile(c);
  c.desire = desire;
  c.state = CS.ToShop;
  c.target = b.id;
  c.from = here;
  c.waited = 0;
  c.path = pathTo(here, CITY.door[b.tile]);
}

/** Raw desire weights for an archetype right now (no supply correction). */
export function desireWeights(s: GameState, arch: Archetype): number[] {
  const part = daypart(s);
  const stirred = new Set<Desire>();
  for (const b of s.buildings) if (s.tick < b.promoUntil && isShop(b.kind)) stirred.add(SHOPS[b.kind].desire);
  return DESIRES.map(
    (d) => ARCHS[arch].desires[d] * DAY_DEMAND[d][part] * demandMult(s, d) * (stirred.has(d) ? PROMO_DESIRE : 1),
  );
}

/** A citizen makes up their mind: which desire, which shop, or home. */
export function decide(s: GameState, c: Citizen): void {
  c.target = -1;
  c.tried = [];
  if (c.wants <= 0 || c.mood < 0.12 || c.budget < 6) return goLeave(c);
  const here = citizenTile(c);
  const weights = desireWeights(s, c.arch);
  const first = pickWeighted(s, weights);
  if (first < 0) return goLeave(c);
  let desire = DESIRES[first];
  let shop = chooseShop(s, c, desire, here);
  if (!shop) {
    s.unmet[first] += 1;
    // Most people settle for something else that is actually on offer.
    if (rand(s) < 0.7) {
      const alt = weights.map((w, i) => (i !== first && chooseShop(s, c, DESIRES[i], here, false) ? w + 0.05 : 0));
      const second = pickWeighted(s, alt);
      if (second >= 0) {
        desire = DESIRES[second];
        shop = chooseShop(s, c, desire, here);
      }
    }
  } else s.met[first] += 1;
  if (shop) return headTo(c, shop, desire);
  // Nothing to buy: take a short stroll, then try again or go home.
  c.desire = desire;
  c.wants--;
  c.mood = Math.max(0, c.mood - 0.04);
  if (rand(s) < 0.3 && strollToCivic(s, c, rand(s) < 0.5 ? 'park' : 'plaza')) return;
  if (rand(s) < 0.8) {
    const options = CITY.walkable.filter((w) => {
      const d = walkDist(here, w);
      return d >= 3 && d <= 8;
    });
    if (options.length) {
      c.state = CS.Stroll;
      c.target = -1;
      c.path = pathTo(here, options[randInt(s, 0, options.length - 1)]);
      return;
    }
  }
  goLeave(c);
}

/** Try a rival for the same desire after being turned away. */
function rechoose(s: GameState, c: Citizen): void {
  const here = citizenTile(c);
  const shop = chooseShop(s, c, c.desire, here);
  if (shop) return headTo(c, shop, c.desire);
  c.wants--;
  decide(s, c);
}

function moveToward(c: Citizen, gx: number, gy: number, speed: number): boolean {
  const dx = gx - c.x;
  const dy = gy - c.y;
  const d = Math.hypot(dx, dy);
  if (d <= speed) {
    c.x = gx;
    c.y = gy;
    return true;
  }
  c.x += (dx / d) * speed;
  c.y += (dy / d) * speed;
  return false;
}

function rejectAt(s: GameState, c: Citizen, b: Building, mood: number, kind: 'turn' | 'walkout'): void {
  b.turned++;
  s.players[b.owner].stats.turnedAway++;
  b.rating = Math.max(0, b.rating - 0.03);
  c.mood = Math.max(0, c.mood - mood);
  c.tried.push(b.id);
  s.fx.push({ k: kind, x: c.x, y: c.y, b: b.id });
  rechoose(s, c);
}

function arrive(s: GameState, c: Citizen): void {
  const b = buildingById(s, c.target);
  if (!b || !isShop(b.kind)) return decide(s, c);
  if (b.dry || b.stock <= 0 || priceOf(b) > c.budget) {
    c.tried.push(b.id);
    return rechoose(s, c);
  }
  const cap = queueCap(b);
  if (b.queue.length >= cap) return rejectAt(s, c, b, 0.1, 'turn');
  const wait = ((b.queue.length + b.serving.length / 2) / serversOf(b)) * serviceTicksOf(b);
  if (wait > c.patience) return rejectAt(s, c, b, 0.05, 'turn');
  b.queue.push(c.id);
  c.state = CS.Queue;
  c.waited = 0;
}

function stepCitizens(s: GameState): void {
  const rain = eventActive(s, 'cloudburst') ? 1.15 : 1;
  for (let i = s.citizens.length - 1; i >= 0; i--) {
    const c = s.citizens[i];
    const speed = ARCHS[c.arch].speed * (0.9 + (hash32(s.seed, c.id) % 21) / 100) * rain;
    switch (c.state) {
      case CS.ToShop:
      case CS.Stroll:
      case CS.Leave: {
        const here = citizenTile(c);
        s.footfall[here] += 0.1;
        if (c.path.length > 0) {
          if (moveToward(c, centerX(c.path[0]), centerY(c.path[0]), speed)) c.path.shift();
          if (c.path.length > 0) break;
        }
        if (c.state === CS.ToShop) arrive(s, c);
        else if (c.state === CS.Leave) s.citizens.splice(i, 1);
        else {
          const b = c.target >= 0 ? buildingById(s, c.target) : undefined;
          if (b && !isShop(b.kind)) {
            c.state = CS.Linger;
            c.timer = randInt(s, 30, 70);
          } else decide(s, c);
        }
        break;
      }
      case CS.Queue: {
        const b = buildingById(s, c.target);
        if (!b) {
          decide(s, c);
          break;
        }
        const n = b.queue.indexOf(c.id);
        if (n < 0) {
          decide(s, c);
          break;
        }
        const slot = queueSlot(b.tile, n);
        moveToward(c, slot.x, slot.y, speed);
        c.waited++;
        if (c.waited > c.patience) {
          b.queue.splice(n, 1);
          rejectAt(s, c, b, 0.22, 'walkout');
        }
        break;
      }
      case CS.Linger: {
        const b = buildingById(s, c.target);
        if (!b) {
          decide(s, c);
          break;
        }
        const h = hash32(c.id, b.id);
        moveToward(c, tx(b.tile) + 0.3 + ((h % 40) / 100), ty(b.tile) + 0.3 + (((h >>> 8) % 40) / 100), speed * 0.7);
        c.mood = Math.min(1, c.mood + 0.003);
        if (--c.timer <= 0) {
          s.players[b.owner].prestige += PRESTIGE_LINGER;
          decide(s, c);
        }
        break;
      }
      default: {
        // CS.Serve is driven by the shop; if the shop was sold mid-service, walk on.
        const b = buildingById(s, c.target);
        let seated = false;
        if (b) for (let k = 0; k < b.serving.length; k += 2) if (b.serving[k] === c.id) seated = true;
        if (!seated) decide(s, c);
        break;
      }
    }
  }
}

function completeSale(s: GameState, b: Building, c: Citizen): void {
  const p = s.players[b.owner];
  const a = ARCHS[c.arch];
  const price = Math.min(priceOf(b), Math.max(1, Math.floor(c.budget)));
  p.cash += price;
  book(p, 'revenue', price);
  p.recentRev += price;
  p.stats.served++;
  b.revenue += price;
  b.recent += price;
  b.served++;
  if (b.stance === 0) p.stats.budgetSales++;
  if (CITY.corner[b.tile]) p.stats.cornerRevenue += price;
  const value = Math.pow(1 / STANCES[b.stance].mult, a.sens);
  const q = shopQuality(s, b, false);
  const sat = clamp(0.6 + 0.22 * (value - 1) + 0.25 * (q - 1) - 0.3 * (c.waited / Math.max(1, c.patience)), 0, 1);
  b.rating = clamp(b.rating * 0.92 + sat * 5 * 0.08, 0, 5);
  c.mood = clamp(c.mood + (sat - 0.5) * 0.4, 0, 1);
  c.budget -= price;
  c.wants--;
  const fxX = tx(b.tile) + 0.5;
  const fxY = ty(b.tile) + 0.5;
  s.fx.push({ k: 'coin', x: fxX, y: fxY, amt: price, p: p.id });
  if (sat > 0.7) s.fx.push({ k: 'star', x: c.x, y: c.y });
  // Civic aura pays its patrons in prestige.
  for (const o of s.buildings) {
    if (o.kind === 'park' ? chebyshev(o.tile, b.tile) <= 1 : o.kind === 'plaza' ? chebyshev(o.tile, b.tile) <= 2 : false)
      s.players[o.owner].prestige += PRESTIGE_AURA_SALE;
  }
  // Some residents take the air after shopping.
  if (c.wants > 0 && (c.arch === 'local' || c.arch === 'tourist') && rand(s) < 0.15) {
    if (strollToCivic(s, c, c.arch === 'tourist' ? 'plaza' : 'park')) return;
  }
  decide(s, c);
}

function stepShops(s: GameState): void {
  const byId = new Map<number, Citizen>();
  for (const c of s.citizens) byId.set(c.id, c);
  for (const b of s.buildings) {
    if (!isShop(b.kind)) continue;
    // Finish service.
    for (let i = b.serving.length - 2; i >= 0; i -= 2) {
      if (s.tick < b.serving[i + 1]) continue;
      const c = byId.get(b.serving[i]);
      b.serving.splice(i, 2);
      if (c) completeSale(s, b, c);
    }
    // Stock.
    if (b.auto && b.stock <= SHOPS[b.kind].stockMax * AUTO_RESTOCK_AT) restock(s, b, true);
    const dry = b.stock <= 0;
    if (dry && !b.dry) {
      s.fx.push({ k: 'stockout', b: b.id });
      b.rating = Math.max(0, b.rating - 0.15);
    }
    b.dry = dry;
    if (dry && b.queue.length) {
      const waiting = b.queue.splice(0, b.queue.length);
      for (const id of waiting) {
        const c = byId.get(id);
        if (!c) continue;
        c.mood = Math.max(0, c.mood - 0.08);
        c.tried.push(b.id);
        rechoose(s, c);
      }
    }
    // Seat the next guests.
    const servers = serversOf(b);
    while (b.serving.length / 2 < servers && b.queue.length > 0 && b.stock > 0) {
      const id = b.queue.shift() as number;
      const c = byId.get(id);
      if (!c) continue;
      b.stock--;
      c.state = CS.Serve;
      const slot = queueSlot(b.tile, 2);
      c.x = slot.x;
      c.y = slot.y;
      b.serving.push(id, s.tick + serviceTicksOf(b));
    }
  }
}

function stepSpawns(s: GameState): void {
  const part = daypart(s);
  let plazas = 0;
  let parks = 0;
  for (const b of s.buildings) {
    if (b.kind === 'plaza') plazas++;
    else if (b.kind === 'park') parks++;
  }
  const target = Math.min(POP_MAX - 6, POP_TARGET[part] + 4 * Math.min(3, plazas) + 2 * Math.min(4, parks));
  const deficit = target - s.citizens.length;
  if (deficit > 0) s.spawnAcc += Math.min(0.5, 0.05 + deficit * 0.02);
  while (s.spawnAcc >= 1) {
    s.spawnAcc -= 1;
    // A plaza tilts the mix toward tourists.
    if (plazas > 0 && rand(s) < 0.08 * Math.min(3, plazas)) spawnCitizen(s, { arch: 'tourist' });
    else spawnCitizen(s);
  }
  if (s.cruiseLeft > 0 && s.tick % 5 === 0 && s.citizens.length < POP_MAX) {
    s.cruiseLeft--;
    spawnCitizen(s, { arch: 'tourist', at: CITY.pierTile });
  }
}

function payroll(s: GameState): void {
  const hike = eventActive(s, 'renthike');
  for (const p of s.players) {
    let wages = 0;
    let rent = 0;
    for (const b of s.buildings) {
      if (b.owner !== p.id) continue;
      wages += wageOf(b);
      rent += rentOf(b, hike);
    }
    const interest = Math.round(p.debt * LOAN_RATE * 100) / 100;
    rent = Math.round(rent * 100) / 100;
    p.cash -= wages + rent + interest;
    book(p, 'wages', wages);
    book(p, 'rent', rent);
    book(p, 'interest', interest);
  }
}

function endQuarter(s: GameState): void {
  const lead = standings(s)[0];
  const leader = s.players[lead.player];
  pushGazette(s, `Quarter ${s.quarter} closes. ${HOUSES[leader.house].name} leads the Crown Index at ${lead.crown}.`, 'market');
  for (const p of s.players) {
    p.lastLedger = p.ledger;
    p.ledger = emptyLedger();
  }
  for (const e of s.events) if (e.started && s.tick < e.endAt) endEvent(s, e);
  if (s.totalQuarters > 0 && !s.endless && s.quarter >= s.totalQuarters) {
    s.phase = 'ended';
    s.result = buildResult(s);
    s.fx.push({ k: 'end' });
    return;
  }
  s.quarter++;
  s.fx.push({ k: 'quarter', q: s.quarter });
  scheduleEvents(s);
}

/** Keep playing after the final quarter. */
export function continueEndless(s: GameState): boolean {
  if (s.phase !== 'ended') return false;
  s.phase = 'playing';
  s.endless = true;
  s.result = null;
  s.quarter++;
  s.fx.push({ k: 'quarter', q: s.quarter });
  scheduleEvents(s);
  return true;
}

/** Advance the simulation by one 100 ms tick. AI decisions are layered on in ai.ts. */
export function tick(s: GameState): void {
  if (s.phase !== 'playing') return;
  if (s.fx.length > 600) s.fx.splice(0, s.fx.length - 600);
  s.tick++;
  stepEvents(s);
  stepTrams(s);
  stepSpawns(s);
  stepCitizens(s);
  stepShops(s);
  if (s.tick % PAYROLL_TICKS === 0) payroll(s);
  for (const p of s.players) p.recentRev *= REV_DECAY;
  for (const b of s.buildings) b.recent *= REV_DECAY;
  if (s.tick % 5 === 0) {
    for (let i = 0; i < N; i++) s.footfall[i] *= 0.99;
    for (let i = 0; i < DESIRES.length; i++) {
      s.met[i] *= 0.992;
      s.unmet[i] *= 0.992;
    }
  }
  if (s.tick % s.quarterTicks === 0) endQuarter(s);
}
