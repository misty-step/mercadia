// MERCADIA v3 shared types — plain JSON-serialisable data, no DOM or Worker globals.

export type TileKind =
  | 'avenue' // Streetcar Avenue (tram loop)
  | 'avbridge' // avenue bridge over the canal (tram loop)
  | 'lane' // pedestrian lane
  | 'bridge' // arched stone footbridge over the canal
  | 'canal'
  | 'lot' // buildable
  | 'home' // residential townhouse
  | 'station' // Grand Station
  | 'garden'; // fixed greenery

export type Desire = 'coffee' | 'dining' | 'leisure' | 'fashion' | 'culture' | 'nightlife';
export type ShopKind = 'roastery' | 'bistro' | 'arcade' | 'boutique' | 'cinema' | 'nightmarket';
export type CivicKind = 'park' | 'tramstop' | 'plaza';
export type BuildKind = ShopKind | CivicKind;
export type Archetype = 'commuter' | 'local' | 'foodie' | 'tourist' | 'nightowl';
export type EventKind = 'cloudburst' | 'cruise' | 'freeride' | 'critic' | 'lantern' | 'renthike' | 'supplycrunch';
export type MatchMode = 'blitz' | 'standard' | 'endless';
export type AiPersona = 'vesper' | 'aurelia' | 'orson';
export type Daypart = 0 | 1 | 2 | 3; // Morning, Noon, Golden Hour, Twilight
export type Era = 1 | 2 | 3 | 4;
export type CharterKey = 'artisanry' | 'transit' | 'credit' | 'canal' | 'heralds' | 'provisioners';
export type MilestoneKey = 'merchant' | 'baron' | 'benefactor' | 'sovereign';
export type UnitKind = 'factor' | 'watch' | 'barge';
export type PactKind = 'truce' | 'trade' | 'rent';
export type StudyKey = 'roasting' | 'drill' | 'hydraulics' | 'signalling' | 'facades' | 'ledger';

/** The match phases. RESOLVE_TURN and TURN_SUMMARY happen inside `resolveTurn`; at rest a match is planning or ended. */
export type Phase = 'planning' | 'ended';

export interface PlayerStats {
  served: number;
  lost: number;
  built: number;
  promos: number;
  budgetSales: number; // Price Shark
  cornerRevenue: number; // Corner King
  civicBuilt: number;
}

export interface Player {
  id: number; // index in game.players (also the seat order)
  name: string;
  house: number; // 0..3 → HOUSES
  kind: 'human' | 'ai';
  persona: AiPersona | null;
  cash: number;
  debt: number;
  prestige: number;
  charters: CharterKey[];
  milestones: number[]; // per MILESTONES entry: the turn it was earned, or 0
  dividend: number; // owed, paid in the next Treasury & upkeep step
  study: StudyKey | null; // current Guild Study
  studyPoints: number;
  studies: StudyKey[]; // completed
  sales: number[]; // sales § of the last four resolved turns, newest last
  stats: PlayerStats;
}

export interface LostDemand {
  tooPricey: number;
  queueFull: number;
  outOfStock: number;
  blockaded: number;
}

export interface Building {
  id: number;
  tile: number;
  kind: BuildKind;
  owner: number;
  level: number; // 1..3
  stance: number; // 0 Budget, 1 Fair, 2 Craft, 3 Prestige
  stock: number;
  auto: boolean;
  promoUntil: number; // last turn a Promo Blitz is active (0 = none)
  promoReady: number; // first turn a new Promo Blitz may be ordered
  contractUntil: number; // last turn a Harbor supply contract covers
  invested: number;
  builtTurn: number;
  // last resolved turn (public: shown in the Inspector)
  lastSales: number; // §
  lastServed: number;
  lastLost: LostDemand;
  lastArch: number[]; // citizens served last turn per archetype (ARCHETYPES order)
  lastRiders: number; // Tram Stop
  lastBoosted: number; // Park/Plaza: nearby shops boosted
  lastBoostedSales: number; // Park/Plaza: sales made inside the aura
  carry: number; // fractional prestige carry for civic projects
  served: number; // lifetime
  revenue: number; // lifetime
}

export interface Unit {
  id: number;
  owner: number;
  kind: UnitKind;
  tile: number;
  cohesion: number;
  route: number; // Barge: the shop building id it supplies, or 0
  fought: boolean; // in combat during the last resolution (no Cohesion regain)
}

export interface Pact {
  id: number;
  kind: PactKind;
  a: number;
  b: number;
  from: number; // first turn in force
  to: number; // last turn in force
}

export interface Proposal {
  id: number;
  kind: PactKind;
  from: number;
  to: number;
  turn: number; // the turn it was proposed (visible to the target from the next turn)
}

export interface CityEvent {
  kind: EventKind;
  announced: number; // turn the forecast was printed
  start: number; // first turn in force
  end: number; // last turn in force
}

/** Chronicle categories. */
export type DispatchCat = 'era' | 'milestone' | 'charter' | 'lead' | 'event' | 'rival' | 'promo' | 'build' | 'market' | 'pact' | 'contest';

export interface Dispatch {
  n: number;
  turn: number;
  cat: DispatchCat;
  head: string;
  pill: string; // exact mechanical impact: "Cinema +45%", "+§80 · ★1"
  player: number; // acting House (player index) or -1
  tile: number; // lot to focus on, or -1
}

export interface Council {
  era: number; // the era that begins this turn (2..4)
  offers: CharterKey[][]; // per player: three distinct charters
}

export interface Standing {
  player: number;
  crown: number;
  netWorth: number;
  share: number; // whole percent
  shareComponent: number;
  worthComponent: number;
  prestigeComponent: number;
  prestige: number;
}

export interface TrendPoint {
  turn: number; // the turn that produced the sample
  era: number;
  share: number[]; // per player: market share %
  crown: number[];
}

export interface Honour {
  key: 'corner' | 'shark' | 'patron';
  title: string;
  player: number;
  detail: string;
}

export interface Game {
  version: 3;
  seed: number;
  mode: MatchMode;
  turn: number; // the turn being planned (1-based)
  phase: Phase;
  endless: boolean;
  players: Player[];
  buildings: Building[];
  units: Unit[];
  pacts: Pact[];
  proposals: Proposal[]; // delivered (visible to the target) or awaiting delivery this turn
  events: CityEvent[];
  council: Council | null; // set on the first planning phase of Eras II–IV
  nextId: number;
  chronicle: Dispatch[];
  dispatchN: number;
  trend: TrendPoint[];
  standings: Standing[]; // as of the last resolution (rank order)
  winner: number; // player index, or -1 while the match runs
  honours: Honour[];
  leader: number; // player currently first (for lead-change dispatches)
}

// ───────────────────────────── Orders ─────────────────────────────

export type Order =
  | { t: 'move'; unit: number; to: number }
  | { t: 'contest'; unit: number; target: number }
  | { t: 'build'; tile: number; kind: BuildKind }
  | { t: 'upgrade'; building: number }
  | { t: 'sell'; building: number }
  | { t: 'recruit'; kind: UnitKind }
  | { t: 'route'; unit: number; building: number }
  | { t: 'contract'; building: number }
  | { t: 'propose'; to: number; kind: PactKind }
  | { t: 'respond'; proposal: number; accept: boolean }
  | { t: 'study'; key: StudyKey }
  | { t: 'stance'; building: number; stance: number }
  | { t: 'restock'; building: number }
  | { t: 'auto'; building: number; on: boolean }
  | { t: 'promo'; building: number }
  | { t: 'borrow' }
  | { t: 'repay' }
  | { t: 'charter'; key: CharterKey };

export type OrderType = Order['t'];

/** A player's draft for one turn: orders in queue sequence. */
export type Draft = Order[];

// ───────────────────────────── Summary ─────────────────────────────

export type SummarySection = 'movement' | 'combat' | 'production' | 'treasury' | 'events';

export interface SummaryLine {
  n: number; // marker number, 0 when the line has no board marker
  section: SummarySection;
  text: string;
  value: string; // right-aligned mono value ("+§212"), may be empty
  player: number; // House the line concerns (public), or -1
  tile: number; // tile for the change marker / pan, or -1
}

export interface CashRecon {
  player: number;
  opening: number;
  income: number;
  costs: number;
  upkeep: number;
  financing: number;
  closing: number;
}

/** One House's Crown Index movement across a resolution (PRODUCT.md TURN_SUMMARY "Score"). */
export interface ScoreDelta {
  player: number;
  prevRank: number; // 1-based rank before the resolution
  nextRank: number; // 1-based rank after
  /** prevRank − nextRank: positive = climbed places, negative = fell, 0 = unchanged. */
  rankDelta: number;
  prevCrown: number;
  crown: number;
  /** crown − prevCrown, always worthDelta + shareDelta + prestigeDelta. */
  crownDelta: number;
  worthDelta: number;
  shareDelta: number;
  prestigeDelta: number;
}

export interface TurnSummary {
  from: number;
  to: number;
  hash: string; // short state hash of the resulting Turn `to` state
  era: number; // era of Turn `to`
  headline: string; // major moment, or ''
  lines: SummaryLine[];
  cash: CashRecon[];
  standings: Standing[];
  /** Per House (index = player): rank change and Crown Index component deltas for this turn. */
  scores: ScoreDelta[];
  /** Orders that were committed this turn, per player, in canonical order (public once resolved). */
  committed: number[]; // count per player
}

export interface MatchConfig {
  seed: number;
  mode: MatchMode;
  players: { name: string; house: number; kind: 'human' | 'ai'; persona: AiPersona | null }[];
}

/** The canonical action log: per resolved turn, the orders of every player (index = player). */
export type ActionLog = Order[][][];
