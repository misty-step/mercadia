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
  CHARTERS,
  CHARTER_ERA_FIT,
  CHARTER_KEYS,
  CHARTER_OFFERS,
  CHARTER_TASTE,
  CHRONICLE_KEEP,
  CIVICS,
  COUNCIL_BEATS,
  COUNCIL_ERAS,
  CORNER_PULL,
  CRITIC_PRESTIGE,
  CRITIC_PRIZE,
  CROWN,
  CRUISE_TOURISTS,
  DAY_DEMAND,
  DESIRES,
  ERA_POP,
  ERA_UNLOCK,
  EVENTS,
  FIRST_NAMES,
  FORECAST_LEAD,
  HALL_SERVERS,
  HOUSES,
  LAST_NAMES,
  LEAD_CHECK,
  LEAD_MARGIN,
  LEAD_QUIET,
  LEAD_WARMUP,
  LEVEL3_ERA,
  LEVEL3_NOTICE,
  LEVEL_APPEAL,
  LEVEL_SERVERS,
  LEVEL_SPEED,
  LOCKED_DESIRE,
  LOST_DECAY,
  LOAN_MAX,
  LOAN_RATE,
  LOAN_STEP,
  MILESTONES,
  MILESTONE_CIVICS,
  MILESTONE_PRESTIGE,
  MILESTONE_PROPERTIES,
  MILESTONE_SERVED,
  MILESTONE_SHARE,
  MILESTONE_SOVEREIGN_ERA,
  MILESTONE_WORTH,
  MODES,
  PARK_AURA,
  PARK_RADIUS,
  PAYROLL_TICKS,
  PLAZA_AURA,
  PLAZA_RADIUS,
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
  RIVALRY_QUIET,
  SALVAGE,
  SHOPS,
  STANCES,
  START_CASH,
  SUPPLY_CRUNCH,
  TRANSIT_PULL,
  TRANSIT_RADIUS,
  TREND_MAX,
  TREND_PER_QUARTER,
  UPGRADE_COST,
  buildCost,
  buildName,
  eraDef,
  eraLabel,
  eraOf,
  eraTitle,
  isCharter,
  isCivic,
  isShop,
  isUnlocked,
  lockNotice,
  unlocksOf,
  type CharterDef,
} from './constants';
import { CITY, N, chebyshev, manhattan, pathTo, tx, ty, walkDist } from './map';
import {
  CS,
  type Archetype,
  type Award,
  type Building,
  type BuildKind,
  type CharterKey,
  type Citizen,
  type CityEvent,
  type CmdResult,
  type Command,
  type Council,
  type Daypart,
  type Desire,
  type Dispatch,
  type EventKind,
  type GameOptions,
  type GameState,
  type GazetteLine,
  type Ledger,
  type LostCustomers,
  type LotBonuses,
  type MatchResult,
  type Player,
  type ResultRow,
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
  construction: 0, civic: 0, marketing: 0, salvage: 0, awards: 0, dividends: 0, borrowed: 0, repaid: 0,
});

/** Net cashflow from trading and building. Financing (loan draws and repayments) is not income. */
export const ledgerNet = (l: Ledger): number =>
  l.revenue + l.salvage + l.awards + (l.dividends ?? 0) - l.wages - l.supplies - l.rent - l.interest - l.construction - l.civic - l.marketing;
/** Net financing: credit drawn minus principal repaid. */
export const ledgerFinancing = (l: Ledger): number => (l.borrowed ?? 0) - (l.repaid ?? 0);
/** What actually happened to the wallet: net cashflow plus financing. */
export const ledgerCashChange = (l: Ledger): number => ledgerNet(l) + ledgerFinancing(l);

export const noLoss = (): LostCustomers => ({ tooPricey: 0, queueFull: 0, outOfStock: 0 });

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
    charters: [],
    milestones: MILESTONES.map(() => -1),
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
    trend: [],
    leaders: [],
    council: null,
    chronicle: [],
    chronicleN: 0,
    leader: -1,
    leadTick: 0,
    eraCrowns: [],
  };
  scheduleEvents(state);
  // The streets are already busy at tick zero.
  for (let i = 0; i < Math.round(66 * ERA_POP[0]); i++) spawnCitizen(state, { scatter: true });
  dispatch(state, {
    cat: 'era', tier: 1, head: eraTitle(1), pill: 'Roastery · Bistro · Park',
    text: 'The district wakes. Lots are for lease along every lane.', tone: 'market',
  });
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

/** The era (1..4) the match clock is in. Endless quarters past the fourth stay in Era IV. */
export const eraNow = (s: Pick<GameState, 'quarter'>): number => eraOf(s.quarter);

// ───────────────────────────── Dynasty Charters ─────────────────────────────

type Chartered = { charters?: CharterKey[] } | null | undefined;
type CharterNumber = { [K in keyof CharterDef]: CharterDef[K] extends number ? K : never }[keyof CharterDef];

/** The combined multiplier a House's charters put on one lever (1 when it holds none). */
export function charterMod(p: Chartered, field: CharterNumber): number {
  let m = 1;
  if (p && p.charters) for (const k of p.charters) m *= CHARTERS[k]?.[field] ?? 1;
  return m;
}
const hasCharter = (p: Chartered, key: CharterKey): boolean => !!p && !!p.charters && p.charters.includes(key);

/** What a build costs this House: civic projects are cheaper under Transit Patronage. */
export const buildCostFor = (p: Chartered, k: BuildKind): number =>
  isCivic(k) ? Math.round(buildCost(k) * charterMod(p, 'civicCost')) : buildCost(k);
export const promoCostFor = (p: Chartered): number => Math.round(PROMO_COST * charterMod(p, 'promoCost'));
export const promoCooldownFor = (p: Chartered): number => Math.round(PROMO_COOLDOWN * charterMod(p, 'promoCooldown'));

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
export const upgradeCost = (b: Pick<Building, 'kind' | 'level'>, owner?: Chartered): number =>
  isShop(b.kind) && b.level < 3 ? Math.round(SHOPS[b.kind].cost * UPGRADE_COST[b.level - 1] * charterMod(owner, 'upgrade')) : 0;
export const salvageValue = (b: Pick<Building, 'invested'>): number => Math.round(b.invested * SALVAGE);
export const wageOf = (b: Pick<Building, 'kind' | 'level'>, owner?: Chartered): number =>
  isShop(b.kind) ? Math.round(Math.round(SHOPS[b.kind].wage * (1 + 0.2 * (b.level - 1))) * charterMod(owner, 'wages') * 100) / 100 : 0;
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
  // Dynasty Charters: Guild Artisanry lifts every shop, Canal Showcase the waterfront and plazas.
  const owner = s.players[b.owner];
  q *= charterMod(owner, 'quality');
  if (bon.canal || bon.plaza) q *= charterMod(owner, 'frontage');
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
  if (arch === 'tourist') pull *= charterMod(s.players[b.owner], 'tourist');
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
  // A real first choice (not a probe, not a second try) records the shops that were in the
  // running but for their price or an empty stockroom: the Inspector's lost-customer diagnosis.
  const record = jitter && c.tried.length === 0;
  let missed: [Building, number, keyof LostCustomers][] | null = null;
  for (const b of s.buildings) {
    if (!isShop(b.kind) || SHOPS[b.kind].desire !== desire) continue;
    if (c.tried.includes(b.id)) continue;
    const dry = b.dry || b.stock <= 0;
    if (dry || priceOf(b) > c.budget) {
      if (record) (missed ??= []).push([b, shopScore(s, b, c.arch, fromTile), dry ? 'outOfStock' : 'tooPricey']);
      continue;
    }
    let sc = shopScore(s, b, c.arch, fromTile);
    if (jitter) {
      // Too dear for what it is — unless a Promo Blitz is on.
      if (b.stance > 1 && s.tick >= b.promoUntil && rand(s) > acceptance(s, b, c.arch)) {
        if (record) (missed ??= []).push([b, sc, 'tooPricey']);
        continue;
      }
      sc *= 0.85 + 0.3 * rand(s);
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = b;
    }
  }
  // Only a shop that would have won the customer counts them as lost.
  if (missed) for (const [b, sc, why] of missed) if (sc > 0 && sc >= bestScore * 0.9) b.lost[why]++;
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

/**
 * The Crown Index split into its three whole-number parts, which always sum to the crown:
 * Worth (net worth ÷ 10) + Share (market share % × 3) + Prestige (civic prestige × 4).
 */
export function crownParts(p: { crown: number; netWorth: number; prestige: number }): { worth: number; share: number; prestige: number; crown: number } {
  const worth = Math.round(p.netWorth * CROWN.netWorth);
  const prestige = Math.round(p.prestige * CROWN.prestige);
  return { worth, share: p.crown - worth - prestige, prestige, crown: p.crown };
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
    stars: starsOf(p),
    charters: (p.charters ?? []).slice(),
  }));
  const top = (f: (p: Player) => number): Player | null => {
    let best: Player | null = null;
    for (const p of s.players) if (f(p) > 0 && (!best || f(p) > f(best))) best = p;
    return best;
  };
  const awards: Award[] = [];
  const corner = top((p) => p.stats.cornerRevenue);
  if (corner)
    awards.push({ key: 'corner', title: 'Corner King', player: corner.id, detail: `§${Math.round(corner.stats.cornerRevenue).toLocaleString('en-US')} taken on corner lots` });
  const shark = top((p) => p.stats.budgetSales);
  if (shark)
    awards.push({ key: 'shark', title: 'Price Shark', player: shark.id, detail: `${shark.stats.budgetSales} sales at Budget prices` });
  const patron = top((p) => p.prestige);
  if (patron)
    awards.push({ key: 'patron', title: 'Civic Patron', player: patron.id, detail: `${Math.round(patron.prestige)} Civic Prestige` });
  const winner = standings(s)[0].player;
  return {
    winner,
    rows,
    awards,
    trend: { perQuarter: TREND_PER_QUARTER, samples: (s.trend ?? []).map((r) => r.slice()) },
    leaders: (s.leaders ?? []).slice(),
    highlight: matchHighlight(s, rows, winner),
  };
}

/** The Final Edition's front-page headline: the story of how the match was won. */
export function matchHighlight(s: GameState, rows: Pick<ResultRow, 'player' | 'crown'>[], winner: number): string {
  const short = (id: number): string => HOUSES[s.players[id].house].short;
  const order = rows.slice().sort((a, b) => b.crown - a.crown || a.player - b.player);
  if (order.length < 2) return `${short(winner)} has the district to itself.`;
  const margin = order[0].crown - order[1].crown;
  const second = order[1].player;
  const points = `${margin} Crown point${margin === 1 ? '' : 's'}`;
  if (margin <= Math.max(3, Math.round(order[0].crown * 0.04))) return `Photo finish: ${short(winner)} edges ${short(second)} by ${points}.`;
  const earlier = (s.leaders ?? []).slice(0, -1);
  const before = earlier.length ? earlier[earlier.length - 1] : winner;
  if (before !== winner && s.players[before]) return `Late surge: ${short(winner)} overtakes ${short(before)} in the final era.`;
  if (order[1].crown > 0 && order[0].crown >= order[1].crown * 1.5) return `Landslide: ${short(winner)} finishes ${points} clear of ${short(second)}.`;
  if (earlier.length >= 2 && earlier.every((l) => l === winner)) return `Wire to wire: ${short(winner)} led at every closing bell.`;
  let star: Building | null = null;
  for (const b of s.buildings) if (b.owner === winner && isShop(b.kind) && (!star || b.revenue > star.revenue)) star = b;
  if (star && star.revenue > 0) return `${short(winner)}'s ${buildName(star.kind)} was the talk of the district: §${Math.round(star.revenue).toLocaleString('en-US')} taken.`;
  return `${short(winner)} finishes ${points} clear of ${short(second)}.`;
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

const CAT_TONE: Record<Dispatch['cat'], GazetteLine['tone']> = {
  era: 'market', milestone: 'market', charter: 'market', lead: 'market', market: 'market',
  event: 'event', rival: 'rival', promo: 'rival', build: 'civic',
};

export interface DispatchInput {
  cat: Dispatch['cat'];
  tier: 1 | 2;
  head: string;
  pill: string;
  player?: number;
  tile?: number;
  icon?: string;
  /** The Gazette's prose line for the same news (defaults to the headline and its pill). */
  text?: string;
  tone?: GazetteLine['tone'];
}

/**
 * Publish a dispatch in the Mercadia Chronicle: a headline, its exact mechanical impact, the
 * acting House and (when there is one) the lot to look at. The Gazette keeps the prose line.
 */
export function dispatch(s: GameState, d: DispatchInput): Dispatch {
  const out: Dispatch = {
    n: ++s.chronicleN,
    tick: s.tick,
    cat: d.cat,
    tier: d.tier,
    head: d.head,
    pill: d.pill,
    player: d.player ?? -1,
    tile: d.tile ?? -1,
    icon: d.icon ?? '',
  };
  s.chronicle.push(out);
  if (s.chronicle.length > CHRONICLE_KEEP) s.chronicle.splice(0, s.chronicle.length - CHRONICLE_KEEP);
  pushGazette(s, d.text ?? (d.pill ? `${d.head} — ${d.pill}` : d.head), d.tone ?? CAT_TONE[d.cat]);
  s.fx.push({ k: 'dispatch', n: out.n, tier: out.tier, cat: out.cat });
  return out;
}

const houseName = (p: Player): string => HOUSES[p.house].short;
/** Dynasty Milestones a House has earned: the stars beside its crest. */
export const starsOf = (p: { milestones?: number[] }): number => (p.milestones ?? []).filter((t) => t >= 0).length;

/** Rivalry headlines are rationed: at most one every RIVALRY_QUIET ticks. */
function pushRivalry(s: GameState, d: DispatchInput): boolean {
  for (let i = s.gazette.length - 1; i >= 0; i--) {
    if (s.gazette[i].tone !== 'rival') continue;
    if (s.tick - s.gazette[i].tick < RIVALRY_QUIET) return false;
    break;
  }
  dispatch(s, { ...d, tone: 'rival' });
  return true;
}

/** The nearest rival shop of the same trade within reach, or undefined. */
function nearbyRival(s: GameState, b: Building, reach = 5): Building | undefined {
  let best: Building | undefined;
  let bd = reach + 1;
  for (const o of s.buildings) {
    if (o.kind !== b.kind || o.owner === b.owner) continue;
    const d = manhattan(o.tile, b.tile);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

// ───────────────────────────── Commands ─────────────────────────────

const fail = (err: string): CmdResult => ({ ok: false, err });
const OK: CmdResult = { ok: true };

export function restockCost(s: Pick<GameState, 'events' | 'tick'>, b: Pick<Building, 'kind' | 'stock'>, auto: boolean, owner?: Chartered): number {
  if (!isShop(b.kind)) return 0;
  const def = SHOPS[b.kind];
  const units = Math.max(0, def.stockMax - b.stock);
  return priceUp(units * unitSupplyCost(s, b.kind, auto, owner));
}

/** What one unit of stock costs right now (Harbor Provisioners buy cheaper and restock free of premium). */
export function unitSupplyCost(s: Pick<GameState, 'events' | 'tick'>, kind: ShopKind, auto: boolean, owner?: Chartered): number {
  const premium = auto && !hasCharter(owner, 'provisioners') ? AUTO_RESTOCK_PREMIUM : 1;
  return SHOPS[kind].unitCost * (eventActive(s, 'supplycrunch') ? SUPPLY_CRUNCH : 1) * premium * charterMod(owner, 'supplies');
}
/** Round up to whole §, immune to floating-point dust (24.000000000000004 → 24). */
const priceUp = (v: number): number => Math.ceil(Math.round(v * 100) / 100);

function restock(s: GameState, b: Building, auto: boolean): boolean {
  if (!isShop(b.kind)) return false;
  const def = SHOPS[b.kind];
  const p = s.players[b.owner];
  const unit = unitSupplyCost(s, b.kind, auto, p);
  let units = def.stockMax - b.stock;
  if (units <= 0) return false;
  if (p.cash < units * unit) units = Math.floor(Math.max(0, p.cash) / unit);
  if (units <= 0) return false;
  const cost = priceUp(units * unit);
  p.cash -= cost;
  book(p, 'supplies', cost);
  const crunch = activeEvent(s);
  if (crunch && crunch.kind === 'supplycrunch') tally(crunch, p.id, cost - cost / SUPPLY_CRUNCH, 0);
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
  if (!isUnlocked(kind, s.quarter)) return fail(lockNotice(kind));
  if (kind === 'tramstop' && CITY.avenueAdj[tile] < 0) return fail('A Tram Stop must touch the avenue');
  if (p.cash < buildCostFor(p, kind)) return fail('Not enough cash');
  return OK;
}

export function applyCommand(s: GameState, playerId: number, cmd: Command): CmdResult {
  if (s.phase === 'ended') return fail('The match is not running');
  const p = s.players[playerId];
  if (!p || !cmd || typeof cmd !== 'object') return fail('Bad command');
  // The Era Council: the city is paused and the only business is choosing a charter.
  if (cmd.c === 'charter') return pickCharter(s, playerId, cmd.key);
  if (s.phase !== 'playing') return fail('The Era Council is in session');
  switch (cmd.c) {
    case 'build': {
      const chk = canBuild(s, playerId, cmd.tile, cmd.kind);
      if (!chk.ok) return chk;
      const cost = buildCostFor(p, cmd.kind);
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
        lost: noLoss(),
        riders: 0,
        auraSales: 0,
      };
      s.buildings.push(b);
      p.cash -= cost;
      p.stats.built++;
      if (shop) {
        book(p, 'construction', cost);
        // A House's founding shop is news; the rest of its chain is not.
        if (p.stats.built - p.stats.civicBuilt === 1)
          dispatch(s, {
            cat: 'build', tier: 2, head: `${houseName(p)} founds its first shop`, pill: `${buildName(cmd.kind)} · §${cost}`,
            player: playerId, tile: cmd.tile, icon: cmd.kind,
            text: `${houseName(p)} opens its first door: a ${buildName(cmd.kind)}.`, tone: 'market',
          });
      } else {
        const prestige = CIVICS[cmd.kind as keyof typeof CIVICS].prestige;
        book(p, 'civic', cost);
        p.prestige += prestige;
        p.stats.civicBuilt++;
        dispatch(s, {
          cat: 'build', tier: 2, head: `${houseName(p)} dedicates a ${buildName(cmd.kind)}`, pill: `+${prestige} Prestige`,
          player: playerId, tile: cmd.tile, icon: cmd.kind,
          text: `${houseName(p)} dedicates a ${buildName(cmd.kind)} to the district.`, tone: 'civic',
        });
      }
      s.fx.push({ k: 'build', tile: cmd.tile, kind: cmd.kind, p: playerId });
      return OK;
    }
    case 'borrow': {
      if (p.debt + LOAN_STEP > LOAN_MAX) return fail('Credit line is exhausted');
      p.debt += LOAN_STEP;
      p.cash += LOAN_STEP;
      book(p, 'borrowed', LOAN_STEP);
      return OK;
    }
    case 'repay': {
      const amt = Math.min(p.debt, LOAN_STEP, Math.max(0, Math.floor(p.cash)));
      if (p.debt <= 0) return fail('No debt to repay');
      if (amt <= 0) return fail('Not enough cash');
      p.debt -= amt;
      p.cash -= amt;
      book(p, 'repaid', amt);
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
      if (cmd.stance < b.stance) {
        // Undercutting the rival next door is front-page news.
        const rival = nearbyRival(s, b);
        if (rival && rival.stance > cmd.stance)
          pushRivalry(s, {
            cat: 'rival', tier: 1, head: `Price war: ${houseName(p)} undercuts ${houseName(s.players[rival.owner])}`,
            pill: `${buildName(b.kind)} ${STANCES[cmd.stance].label} vs ${STANCES[rival.stance].label}`,
            player: playerId, tile: b.tile, icon: b.kind,
            text: `Price war: ${houseName(p)} undercuts ${houseName(s.players[rival.owner])}'s ${buildName(b.kind)} — ${STANCES[cmd.stance].name} against ${STANCES[rival.stance].name}.`,
          });
      }
      b.stance = cmd.stance;
      return OK;
    }
    case 'upgrade': {
      if (!isShop(b.kind)) return fail('Only shops upgrade');
      if (b.level >= 3) return fail('Already at Level 3');
      if (b.level === 2 && eraNow(s) < LEVEL3_ERA) return fail(LEVEL3_NOTICE);
      const cost = upgradeCost(b, p);
      if (p.cash < cost) return fail('Not enough cash');
      p.cash -= cost;
      book(p, 'construction', cost);
      b.invested += cost;
      b.level++;
      s.fx.push({ k: 'upgrade', b: b.id, p: playerId });
      if (b.level === 3)
        dispatch(s, {
          cat: 'build', tier: 2, head: `${houseName(p)} unveils a grand ${buildName(b.kind)}`, pill: 'Level 3 · +26% appeal',
          player: playerId, tile: b.tile, icon: b.kind,
          text: `${houseName(p)} unveils a Level 3 ${buildName(b.kind)}: terraces, pergolas and a brass cornice.`, tone: 'market',
        });
      return OK;
    }
    case 'promo': {
      if (!isShop(b.kind)) return fail('Only shops run promotions');
      if (s.tick < b.promoReadyAt) return fail('Promo Blitz is cooling down');
      const promoCost = promoCostFor(p);
      if (p.cash < promoCost) return fail('Not enough cash');
      p.cash -= promoCost;
      book(p, 'marketing', promoCost);
      b.promoUntil = s.tick + PROMO_TICKS;
      b.promoReadyAt = b.promoUntil + promoCooldownFor(p);
      p.stats.promos++;
      s.fx.push({ k: 'promo', b: b.id, p: playerId });
      const rival = nearbyRival(s, b, 6);
      pushRivalry(s, {
        cat: 'promo', tier: 1,
        head: rival ? `Promo Blitz! ${houseName(p)} poaches ${houseName(s.players[rival.owner])}'s queue` : `Promo Blitz! ${houseName(p)} papers the lanes`,
        pill: `${buildName(b.kind)} pull ×${PROMO_PULL} · ${Math.round(PROMO_TICKS / 10)}s`,
        player: playerId, tile: b.tile, icon: b.kind,
        text: rival
          ? `Promo Blitz! ${houseName(p)}'s ${buildName(b.kind)} is poaching ${houseName(s.players[rival.owner])}'s queue.`
          : `Promo Blitz! ${houseName(p)}'s ${buildName(b.kind)} papers the lanes with flyers.`,
      });
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

/** Count something toward the running event's closing receipt. */
function tally(e: CityEvent, player: number, amount: number, count = 1): void {
  e.n = (e.n ?? 0) + count;
  const take = (e.take ??= []);
  take[player] = (take[player] ?? 0) + amount;
}

/** Which sales an event's receipt counts: the trade it boosted, or the crowd it brought. */
function eventCounts(e: CityEvent, b: Building, c: Pick<Citizen, 'arch'>): boolean {
  switch (e.kind) {
    case 'cruise':
      return c.arch === 'tourist';
    case 'cloudburst':
      return b.kind === 'cinema' || b.kind === 'roastery';
    case 'lantern':
      return b.kind === 'nightmarket' || b.kind === 'arcade';
    case 'critic':
      return b.kind === 'bistro' || b.kind === 'roastery';
    default:
      return false;
  }
}

/** The one-line Gazette receipt published when an event closes. */
export function eventReceipt(s: Pick<GameState, 'players'>, e: CityEvent): string | null {
  const n = Math.round(e.n ?? 0);
  const take = e.take ?? [];
  let top = -1;
  let total = 0;
  s.players.forEach((p) => {
    const v = take[p.id] ?? 0;
    total += v;
    if (v > 0 && (top < 0 || v > (take[top] ?? 0))) top = p.id;
  });
  const who = top >= 0 ? houseName(s.players[top] as Player) : '';
  const earner = who ? ` · Top earner: ${who}` : '';
  switch (e.kind) {
    case 'cruise':
      return n > 0 ? `Harbor Cruise closed — ${n} tourist${n === 1 ? '' : 's'} served${earner}` : 'Harbor Cruise closed — the tourists found no shop to their taste.';
    case 'cloudburst':
      return n > 0 ? `Cloudburst passed — ${n} sheltered in cinemas and roasteries${earner}` : 'Cloudburst passed — nobody had a dry seat to sell.';
    case 'lantern':
      return n > 0 ? `Lantern Festival closed — ${n} night-trade sales${earner}` : 'Lantern Festival closed — the lanes glowed, the tills stayed quiet.';
    case 'freeride':
      return `Free-Ride Day ended — ${n} rider${n === 1 ? '' : 's'} delivered to the stops.`;
    case 'renthike':
      return total >= 1 ? `Rent Hike lifted — §${Math.round(total)} extra rent paid · Hardest hit: ${who}` : 'Rent Hike lifted — no tenant felt it.';
    case 'supplycrunch':
      return total >= 1 ? `Supply Crunch eased — §${Math.round(total)} extra paid for stock · Hardest hit: ${who}` : 'Supply Crunch eased — every stockroom rode it out.';
    default:
      return null; // the critic's verdict is its own receipt
  }
}

function startEvent(s: GameState, e: CityEvent): void {
  e.started = true;
  e.n = 0;
  e.take = s.players.map(() => 0);
  dispatch(s, { cat: 'event', tier: 1, head: EVENTS[e.kind].title, pill: EVENTS[e.kind].pill, icon: e.kind, tile: eventTile(e.kind), text: EVENTS[e.kind].headline });
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
  const receipt = eventReceipt(s, e);
  if (receipt) {
    const cut = receipt.indexOf(' — ');
    const top = topEarner(s, e);
    dispatch(s, {
      cat: 'event', tier: 1, head: cut > 0 ? receipt.slice(0, cut) : `${EVENTS[e.kind].title} closed`,
      pill: receiptPill(s, e), icon: e.kind, player: top, tile: eventTile(e.kind), text: receipt,
    });
  }
}

/** The lot or landmark a city event arrives through, for the Chronicle's click-to-focus. */
function eventTile(kind: EventKind): number {
  return kind === 'cruise' ? CITY.pierTile : kind === 'freeride' ? (CITY.fixedStops[0] ?? -1) : -1;
}

function topEarner(s: Pick<GameState, 'players'>, e: CityEvent): number {
  const take = e.take ?? [];
  let top = -1;
  s.players.forEach((p) => {
    const v = take[p.id] ?? 0;
    if (v > 0 && (top < 0 || v > (take[top] ?? 0))) top = p.id;
  });
  return top;
}

/** The closing receipt as an impact tag: "28 served · Cobalt". */
function receiptPill(s: Pick<GameState, 'players'>, e: CityEvent): string {
  const n = Math.round(e.n ?? 0);
  const top = topEarner(s, e);
  const who = top >= 0 ? ` · ${houseName(s.players[top] as Player)}` : '';
  let total = 0;
  for (const v of e.take ?? []) total += v ?? 0;
  switch (e.kind) {
    case 'cruise':
    case 'cloudburst':
      return n > 0 ? `${n} served${who}` : 'No sales';
    case 'lantern':
      return n > 0 ? `${n} sales${who}` : 'No sales';
    case 'freeride':
      return `${n} rider${n === 1 ? '' : 's'}`;
    case 'renthike':
      return total >= 1 ? `−§${Math.round(total)} rent` : 'No tenants hit';
    case 'supplycrunch':
      return total >= 1 ? `−§${Math.round(total)} stock` : 'No stock bought';
    default:
      return 'Closed';
  }
}

function awardGoldenFork(s: GameState): void {
  let best: Building | null = null;
  for (const b of s.buildings) {
    if (b.kind !== 'bistro' && b.kind !== 'roastery') continue;
    if (!best || b.rating > best.rating || (b.rating === best.rating && b.served > best.served)) best = b;
  }
  if (!best) {
    dispatch(s, { cat: 'event', tier: 2, head: 'The critic leaves hungry', pill: 'No Golden Fork', icon: 'critic', text: 'The critic leaves hungry: not one kitchen was open.' });
    return;
  }
  const p = s.players[best.owner];
  p.cash += CRITIC_PRIZE;
  book(p, 'awards', CRITIC_PRIZE);
  p.prestige += CRITIC_PRESTIGE;
  p.stats.goldenForks++;
  best.rating = Math.min(5, best.rating + 0.3);
  s.fx.push({ k: 'award', b: best.id, p: p.id });
  dispatch(s, {
    cat: 'event', tier: 1, head: `Golden Fork to ${houseName(p)}'s ${buildName(best.kind)}`, pill: `+§${CRITIC_PRIZE} · +${CRITIC_PRESTIGE} Prestige`,
    player: p.id, tile: best.tile, icon: 'critic',
    text: `Golden Fork: the critic crowns ${houseName(p)}'s ${buildName(best.kind)}. §${CRITIC_PRIZE} and lasting prestige.`,
  });
}

function stepEvents(s: GameState): void {
  for (const e of s.events) {
    if (!e.started && s.tick === e.announceAt && e.announceAt < e.startAt) {
      dispatch(s, { cat: 'event', tier: 1, head: `Forecast: ${EVENTS[e.kind].title}`, pill: EVENTS[e.kind].pill, icon: e.kind, tile: eventTile(e.kind), text: EVENTS[e.kind].forecast });
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
        if (s.citizens.length < POP_MAX) {
          spawnCitizen(s, { arch: rand(s) < 0.75 ? 'commuter' : 'local', at: t.dropTile });
          // Riders delivered: credited to every Tram Stop that serves this platform.
          for (const b of s.buildings) if (b.kind === 'tramstop' && CITY.avenueAdj[b.tile] === t.dropTile) b.riders++;
          const ev = activeEvent(s);
          if (ev && ev.kind === 'freeride') ev.n = (ev.n ?? 0) + 1;
        }
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
        if (b.kind === 'tramstop' && CITY.avenueAdj[b.tile] === tile) s.players[b.owner].prestige += PRESTIGE_TRAM * charterMod(s.players[b.owner], 'civicPrestige');
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

/** The era in which each desire's shop unlocks, in DESIRES order. */
const DESIRE_ERA: number[] = DESIRES.map((d) => {
  for (const k of Object.keys(SHOPS) as ShopKind[]) if (SHOPS[k].desire === d) return ERA_UNLOCK[k];
  return 1;
});

/** Raw desire weights for an archetype right now (no supply correction). */
export function desireWeights(s: GameState, arch: Archetype): number[] {
  const part = daypart(s);
  const stirred = new Set<Desire>();
  for (const b of s.buildings) if (s.tick < b.promoUntil && isShop(b.kind)) stirred.add(SHOPS[b.kind].desire);
  const era = eraNow(s);
  return DESIRES.map(
    (d, i) =>
      ARCHS[arch].desires[d] * DAY_DEMAND[d][part] * demandMult(s, d) * (stirred.has(d) ? PROMO_DESIRE : 1) *
      // A trade whose shop is still locked barely tempts the street until its era opens.
      (era >= DESIRE_ERA[i] ? 1 : LOCKED_DESIRE),
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
  b.lost.queueFull++;
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
    // The shelves emptied, or the price rose, while they were walking over.
    if (b.dry || b.stock <= 0) b.lost.outOfStock++;
    else b.lost.tooPricey++;
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
          s.players[b.owner].prestige += PRESTIGE_LINGER * charterMod(s.players[b.owner], 'civicPrestige');
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
  const ev = activeEvent(s);
  if (ev && eventCounts(ev, b, c)) tally(ev, p.id, price);
  // Civic aura pays its patrons in prestige.
  for (const o of s.buildings) {
    if (o.kind === 'park' ? chebyshev(o.tile, b.tile) <= PARK_RADIUS : o.kind === 'plaza' ? chebyshev(o.tile, b.tile) <= PLAZA_RADIUS : false) {
      s.players[o.owner].prestige += PRESTIGE_AURA_SALE * charterMod(s.players[o.owner], 'civicPrestige');
      o.auraSales++;
    }
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
        b.lost.outOfStock++;
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
  // The district grows livelier with every era.
  const target = Math.min(POP_MAX - 6, Math.round(POP_TARGET[part] * ERA_POP[eraNow(s) - 1]) + 4 * Math.min(3, plazas) + 2 * Math.min(4, parks));
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
      wages += wageOf(b, p);
      rent += rentOf(b, hike);
    }
    const interest = Math.round(p.debt * LOAN_RATE * charterMod(p, 'interest') * 100) / 100;
    rent = Math.round(rent * 100) / 100;
    wages = Math.round(wages * 100) / 100;
    if (hike) {
      const ev = activeEvent(s);
      if (ev) tally(ev, p.id, rent - rent / RENT_HIKE, 0);
    }
    p.cash -= wages + rent + interest;
    book(p, 'wages', wages);
    book(p, 'rent', rent);
    book(p, 'interest', interest);
  }
}

function endQuarter(s: GameState): void {
  const order = standings(s);
  const lead = order[0];
  const leader = s.players[lead.player];
  const closing = s.quarter;
  pushGazette(s, `${eraLabel(closing)} closes. ${HOUSES[leader.house].name} leads the Crown Index at ${lead.crown}.`, 'market');
  (s.leaders ??= []).push(lead.player);
  const crowns = s.players.map((p) => crownIndex(s, p));
  const before = s.eraCrowns.length ? s.eraCrowns[s.eraCrowns.length - 1] : crowns.map(() => Math.round(START_CASH * CROWN.netWorth));
  s.eraCrowns.push(crowns);
  if (s.eraCrowns.length > 24) s.eraCrowns.splice(0, s.eraCrowns.length - 24);
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
  // The close of Eras I, II and III convenes the Era Council; the city waits for it.
  if (COUNCIL_ERAS.includes(closing)) {
    // The closed era's events are over (any still running was wound up above): nothing is
    // live or forecast while the Council sits. The next era schedules its own.
    s.events = [];
    openCouncil(s, order.map((o) => ({ player: o.player, crown: o.crown, delta: o.crown - (before[o.player] ?? 0) })));
    return;
  }
  beginEra(s);
}

/** Start the next era: new clock, new events, new unlocks. */
function beginEra(s: GameState): void {
  const from = eraNow(s);
  s.quarter++;
  s.fx.push({ k: 'quarter', q: s.quarter });
  scheduleEvents(s);
  const era = eraNow(s);
  if (era === from) return; // Endless, past the Golden Dynasty: the city simply plays on
  const names = unlocksOf(era).map((k) => buildName(k));
  if (era === LEVEL3_ERA) names.push('Level 3');
  dispatch(s, {
    cat: 'era', tier: 1, head: eraTitle(s.quarter), pill: names.length ? `${eraLabel(s.quarter)} Unlocked` : 'Final Reckoning',
    text: `${eraTitle(s.quarter)} begins. ${names.length ? `Unlocked: ${names.join(', ')}.` : eraDef(s.quarter).blurb}`,
    tone: 'market',
  });
}

// ───────────────────────────── Era Council ─────────────────────────────

/** Three distinct charters for a House, none of which it already holds. Deterministic per seed. */
export function charterOffers(s: Pick<GameState, 'seed'>, p: Pick<Player, 'id' | 'charters'>, era: number): CharterKey[] {
  const pool = CHARTER_KEYS.filter((k) => !(p.charters ?? []).includes(k));
  // Fisher–Yates driven by a hash of (seed, era, player): the match RNG stream is not touched.
  const r = { rng: hash32(s.seed ^ 0x43a7, era * 8 + p.id) | 0 };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand(r) * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, CHARTER_OFFERS);
}

/** The charter an AI House (or an undecided player's steward) would adopt from an offer. */
export function recommendCharter(p: Pick<Player, 'kind' | 'persona'>, offers: CharterKey[], nextEra: number): CharterKey {
  if (p.kind !== 'ai' || !p.persona) return offers[0];
  const taste = CHARTER_TASTE[p.persona];
  const fit = CHARTER_ERA_FIT[nextEra] ?? {};
  let best = offers[0];
  let bestScore = -1;
  for (const k of offers) {
    const score = (taste[k] ?? 1) * (fit[k] ?? 1);
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

function openCouncil(s: GameState, rows: Council['rows']): void {
  const era = s.quarter;
  const next = eraOf(era + 1);
  const offers = s.players.map((p) => charterOffers(s, p, era));
  s.council = {
    era,
    next,
    offers,
    // AI Houses seal their choice at once; humans deliberate.
    picks: s.players.map((p, i) => (p.kind === 'ai' ? recommendCharter(p, offers[i], next) : null)),
    left: COUNCIL_BEATS,
    total: COUNCIL_BEATS,
    rows,
    unlocked: unlocksOf(next),
    level3: next === LEVEL3_ERA,
  };
  s.phase = 'council';
  s.fx.push({ k: 'council', era });
}

function pickCharter(s: GameState, playerId: number, key: unknown): CmdResult {
  const c = s.council;
  if (s.phase !== 'council' || !c) return fail('The Era Council is not in session');
  if (!isCharter(key)) return fail('Unknown charter');
  if (!c.offers[playerId] || !c.offers[playerId].includes(key)) return fail('That charter is not on offer to your House');
  c.picks[playerId] = key;
  return OK;
}

/** True once every listed player (the humans the room is waiting on) has chosen. */
export function councilReady(s: Pick<GameState, 'council'>, waitingOn: number[]): boolean {
  const c = s.council;
  return !!c && waitingOn.every((id) => c.picks[id] != null);
}

function adoptCharter(s: GameState, p: Player, key: CharterKey): void {
  if ((p.charters ??= []).includes(key)) return;
  const def = CHARTERS[key];
  p.charters.push(key);
  p.prestige += def.adoptPrestige;
  s.fx.push({ k: 'charter', p: p.id, key });
  dispatch(s, {
    cat: 'charter', tier: 2, head: `${houseName(p)} adopts ${def.name}`, pill: def.pill, player: p.id,
    text: `${houseName(p)} adopts the ${def.name} charter: ${def.pill}.`, tone: 'market',
  });
}

/**
 * Close the Era Council: every House adopts its chosen charter (an undecided House takes its
 * steward's recommendation) and the next era begins. Returns false when no Council is open.
 */
export function closeCouncil(s: GameState): boolean {
  const c = s.council;
  if (s.phase !== 'council' || !c) return false;
  s.players.forEach((p, i) => adoptCharter(s, p, c.picks[i] ?? recommendCharter(p, c.offers[i], c.next)));
  s.council = null;
  s.phase = 'playing';
  beginEra(s);
  return true;
}

/** Beats the Council lingers once every waiting House has chosen, so the seals are seen to set. */
export const COUNCIL_SEAL_BEATS = 8;

/**
 * One 100 ms beat of the multiplayer Council countdown. Closes the Council when the clock runs
 * out, or straight after every connected human has chosen. Returns true when it closed.
 */
export function councilBeat(s: GameState, waitingOn: number[]): boolean {
  const c = s.council;
  if (s.phase !== 'council' || !c) return false;
  if (waitingOn.length > 0 && councilReady(s, waitingOn)) c.left = Math.min(c.left, COUNCIL_SEAL_BEATS);
  c.left--;
  if (c.left > 0) return false;
  return closeCouncil(s);
}

// ───────────────────────────── Dynasty Milestones ─────────────────────────────

/** True when a House holds two lots that share an edge: the seed of an enclave. */
export function hasEnclave(s: { buildings: Pick<Building, 'tile' | 'owner'>[] }, playerId: number): boolean {
  const mine = s.buildings.filter((b) => b.owner === playerId);
  for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) if (manhattan(mine[i].tile, mine[j].tile) === 1) return true;
  return false;
}

/** Whether each milestone's threshold is met right now, in MILESTONES order. */
export function milestoneMet(s: GameState, p: Player): boolean[] {
  let owned = 0;
  for (const b of s.buildings) if (b.owner === p.id) owned++;
  return [
    p.stats.served >= MILESTONE_SERVED,
    owned >= MILESTONE_PROPERTIES || (owned >= 2 && hasEnclave(s, p.id)),
    p.stats.civicBuilt >= MILESTONE_CIVICS || p.prestige >= MILESTONE_PRESTIGE,
    eraNow(s) >= MILESTONE_SOVEREIGN_ERA && (netWorth(s, p) >= MILESTONE_WORTH || marketShares(s)[p.id] >= MILESTONE_SHARE),
  ];
}

function stepMilestones(s: GameState): void {
  for (const p of s.players) {
    if (p.milestones.every((t) => t >= 0)) continue;
    const met = milestoneMet(s, p);
    for (let i = 0; i < MILESTONES.length; i++) {
      if (p.milestones[i] >= 0 || !met[i]) continue;
      const def = MILESTONES[i];
      p.milestones[i] = s.tick;
      if (def.cash > 0) {
        p.cash += def.cash;
        book(p, 'dividends', def.cash);
      }
      p.prestige += def.prestige;
      s.fx.push({ k: 'milestone', p: p.id, m: i });
      dispatch(s, {
        cat: 'milestone', tier: 1, head: `${houseName(p)} earns ${def.name}`, pill: `${def.pill} · ★${starsOf(p)}`, player: p.id,
        text: `Dynasty Milestone: ${houseName(p)} earns ${def.name} (${def.goal.toLowerCase()}). ${def.pill}.`, tone: 'market',
      });
    }
  }
}

/** A change at the top of the Crown Index is front-page news, rationed so it never chatters. */
function stepLead(s: GameState): void {
  // Not before the district has found its feet: one early sale is not a lead.
  if (s.players.length < 2 || s.tick < Math.min(LEAD_WARMUP, Math.round(s.quarterTicks * 0.25))) return;
  const order = standings(s);
  const top = order[0];
  if (top.player === s.leader || top.crown - order[1].crown < LEAD_MARGIN) return;
  if (s.leader >= 0 && s.tick - s.leadTick < LEAD_QUIET) return;
  const p = s.players[top.player];
  const old = s.leader >= 0 ? s.players[s.leader] : null;
  s.leader = top.player;
  s.leadTick = s.tick;
  dispatch(s, {
    cat: 'lead', tier: 1, head: old ? `${houseName(p)} overtakes ${houseName(old)} for the Crown` : `${houseName(p)} takes the first Crown lead`,
    pill: 'New Leader', player: p.id,
    text: old ? `New leader: ${HOUSES[p.house].name} overtakes ${houseName(old)} at Crown ${top.crown}.` : `${HOUSES[p.house].name} takes the first Crown lead at ${top.crown}.`,
    tone: 'market',
  });
}

/** Keep playing after the final era. */
export function continueEndless(s: GameState): boolean {
  if (s.phase !== 'ended') return false;
  s.phase = 'playing';
  s.endless = true;
  s.result = null;
  beginEra(s);
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
  if (s.tick % 5 === 0) stepMilestones(s);
  if (s.tick % LEAD_CHECK === 0) stepLead(s);
  for (const p of s.players) p.recentRev *= REV_DECAY;
  for (const b of s.buildings) {
    b.recent *= REV_DECAY;
    const l = b.lost;
    if (l.tooPricey || l.queueFull || l.outOfStock) {
      l.tooPricey = l.tooPricey < 0.05 ? 0 : l.tooPricey * LOST_DECAY;
      l.queueFull = l.queueFull < 0.05 ? 0 : l.queueFull * LOST_DECAY;
      l.outOfStock = l.outOfStock < 0.05 ? 0 : l.outOfStock * LOST_DECAY;
    }
  }
  // One market-share sample per daypart feeds the Final Edition's sparkline.
  if (s.tick % Math.max(1, Math.round(s.quarterTicks / TREND_PER_QUARTER)) === 0) {
    const trend = (s.trend ??= []);
    trend.push(marketShares(s).map((v) => Math.round(v * 1000)));
    if (trend.length > TREND_MAX) trend.splice(0, trend.length - TREND_MAX);
  }
  if (s.tick % 5 === 0) {
    for (let i = 0; i < N; i++) s.footfall[i] *= 0.99;
    for (let i = 0; i < DESIRES.length; i++) {
      s.met[i] *= 0.992;
      s.unmet[i] *= 0.992;
    }
  }
  if (s.tick % s.quarterTicks === 0) endQuarter(s);
}

/**
 * Bring a checkpoint written by an older build up to the current shape, in place.
 * Rooms survive deploys, so a restored match may predate fields added since.
 */
export function upgradeState(s: GameState): GameState {
  s.trend ??= [];
  s.leaders ??= [];
  // v2 (Dynasty): eras, the Era Council, charters, milestones and the Chronicle.
  s.council ??= null;
  s.chronicleN ??= 0;
  s.leader ??= -1;
  s.leadTick ??= 0;
  s.eraCrowns ??= [];
  if (!Array.isArray(s.chronicle)) {
    // Carry the old Gazette forward as feed-only dispatches so the Chronicle is not blank.
    s.chronicle = (s.gazette ?? []).slice(-4).map((g, i) => ({
      n: i + 1, tick: g.tick, cat: g.tone === 'event' ? 'event' : g.tone === 'rival' ? 'rival' : g.tone === 'civic' ? 'build' : 'market',
      tier: 2 as const, head: g.text, pill: '', player: -1, tile: -1, icon: '',
    }));
    s.chronicleN = s.chronicle.length;
  }
  if (s.phase !== 'playing' && s.phase !== 'council' && s.phase !== 'ended') s.phase = 'playing';
  if (s.phase === 'council' && !s.council) s.phase = 'playing';
  for (const p of s.players) {
    for (const l of [p.ledger, p.lastLedger, p.totalLedger]) {
      l.borrowed ??= 0;
      l.repaid ??= 0;
      l.dividends ??= 0;
    }
    p.charters ??= [];
    if (!Array.isArray(p.milestones)) p.milestones = MILESTONES.map(() => -1);
    while (p.milestones.length < MILESTONES.length) p.milestones.push(-1);
  }
  for (const b of s.buildings) {
    b.lost ??= noLoss();
    b.riders ??= 0;
    b.auraSales ??= 0;
  }
  if (s.result) {
    s.result.trend ??= { perQuarter: TREND_PER_QUARTER, samples: [] };
    s.result.leaders ??= [];
    s.result.highlight ??= '';
    for (const r of s.result.rows) {
      r.stars ??= 0;
      r.charters ??= [];
    }
  }
  return s;
}
