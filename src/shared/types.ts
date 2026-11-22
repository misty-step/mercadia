// MERCADIA shared types — plain JSON-serialisable data, no DOM or Worker globals.

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
export type EventKind =
  | 'cloudburst'
  | 'cruise'
  | 'freeride'
  | 'critic'
  | 'lantern'
  | 'renthike'
  | 'supplycrunch';
export type MatchMode = 'blitz' | 'standard' | 'endless';
export type AiPersona = 'vesper' | 'aurelia' | 'orson';
export type Daypart = 0 | 1 | 2 | 3; // morning, noon, golden hour, twilight

/** Citizen states. */
export const CS = {
  ToShop: 0,
  Queue: 1,
  Serve: 2,
  Stroll: 3,
  Linger: 4,
  Leave: 5,
} as const;
export type CState = (typeof CS)[keyof typeof CS];

export interface Ledger {
  revenue: number;
  wages: number;
  supplies: number;
  rent: number;
  interest: number;
  construction: number;
  civic: number;
  marketing: number;
  salvage: number;
  awards: number;
}

export interface PlayerStats {
  served: number;
  turnedAway: number;
  built: number;
  promos: number;
  budgetSales: number; // sales made at the Budget stance (Price Shark)
  cornerRevenue: number; // revenue from corner lots (Corner King)
  civicBuilt: number;
  goldenForks: number;
}

export interface Player {
  id: number; // index in state.players
  name: string;
  house: number; // 0..3 → HOUSES
  kind: 'human' | 'ai';
  persona: AiPersona | null;
  cash: number;
  debt: number;
  prestige: number;
  recentRev: number; // exponentially decayed revenue → market share
  ledger: Ledger; // current quarter
  lastLedger: Ledger; // previous quarter
  totalLedger: Ledger; // whole match
  stats: PlayerStats;
  aiNext: number; // next tick the AI thinks
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
  promoUntil: number;
  promoReadyAt: number;
  queue: number[]; // citizen ids waiting, in order
  serving: number[]; // flat pairs: citizen id, done tick
  served: number;
  revenue: number;
  recent: number; // exponentially decayed takings (see TAKINGS_PER_MIN)
  turned: number;
  rating: number; // 0..5
  invested: number;
  builtTick: number;
  dry: boolean; // currently stocked out
}

export interface Citizen {
  id: number;
  arch: Archetype;
  x: number;
  y: number;
  state: CState;
  desire: Desire;
  budget: number;
  patience: number; // ticks willing to queue
  waited: number;
  mood: number; // 0..1
  target: number; // building id or -1
  path: number[]; // remaining tile indices
  tried: number[]; // building ids already rejected
  wants: number; // purchases still wanted
  timer: number;
  exit: number; // tile to leave by
  from: number; // tile of the last decision (distance origin)
}

export interface Tram {
  pos: number; // float index along the loop
  v: number;
  dwell: number; // ticks left at a stop
  drops: number; // commuters still to disembark at this stop
  dropTile: number;
  special: boolean; // Free-Ride extra tram
}

export interface CityEvent {
  kind: EventKind;
  announceAt: number;
  startAt: number;
  endAt: number;
  started: boolean;
}

export interface GazetteLine {
  tick: number;
  text: string;
  tone: 'event' | 'market' | 'civic';
}

export type Fx =
  | { k: 'coin'; x: number; y: number; amt: number; p: number }
  | { k: 'star'; x: number; y: number }
  | { k: 'turn'; x: number; y: number; b: number }
  | { k: 'walkout'; x: number; y: number; b: number }
  | { k: 'stockout'; b: number }
  | { k: 'build'; tile: number; kind: BuildKind; p: number }
  | { k: 'upgrade'; b: number; p: number }
  | { k: 'sell'; tile: number; p: number }
  | { k: 'promo'; b: number; p: number }
  | { k: 'restock'; b: number; p: number }
  | { k: 'bell'; tile: number }
  | { k: 'event'; kind: EventKind; phase: 'forecast' | 'start' | 'end' }
  | { k: 'award'; b: number; p: number }
  | { k: 'quarter'; q: number }
  | { k: 'end' };

export interface Award {
  key: 'corner' | 'shark' | 'patron';
  title: string;
  player: number;
  detail: string;
}

export interface ResultRow {
  player: number;
  crown: number;
  netWorth: number;
  share: number; // 0..1
  prestige: number;
  revenue: number;
  served: number;
  shops: number;
  civic: number;
}

export interface MatchResult {
  winner: number;
  rows: ResultRow[];
  awards: Award[];
}

export interface GameState {
  seed: number;
  rng: number;
  tick: number;
  mode: MatchMode;
  quarterTicks: number;
  totalQuarters: number; // 0 = endless
  quarter: number; // 1-based
  phase: 'playing' | 'ended';
  endless: boolean;
  players: Player[];
  buildings: Building[];
  nextBuildingId: number;
  citizens: Citizen[];
  nextCitizenId: number;
  trams: Tram[];
  events: CityEvent[]; // scheduled for the current quarter, ascending
  eventBag: EventKind[];
  gazette: GazetteLine[];
  gazetteN: number; // headlines ever published
  footfall: number[]; // per tile, decayed
  met: number[]; // per desire, decayed count of satisfied intents
  unmet: number[]; // per desire, decayed count of intents with no shop
  spawnAcc: number;
  cruiseLeft: number;
  fx: Fx[];
  result: MatchResult | null;
}

export interface PlayerSetup {
  name: string;
  house: number;
  kind: 'human' | 'ai';
  persona?: AiPersona | null;
}

export interface GameOptions {
  seed: number;
  mode: MatchMode;
  players: PlayerSetup[];
}

export type Command =
  | { c: 'build'; tile: number; kind: BuildKind }
  | { c: 'price'; id: number; stance: number }
  | { c: 'upgrade'; id: number }
  | { c: 'promo'; id: number }
  | { c: 'restock'; id: number }
  | { c: 'auto'; id: number; on: boolean }
  | { c: 'sell'; id: number }
  | { c: 'borrow' }
  | { c: 'repay' };

export interface CmdResult {
  ok: boolean;
  err?: string;
}

export interface LotBonuses {
  corner: boolean;
  canal: boolean;
  transit: boolean;
  parks: number; // adjacent pocket parks (0..2 counted)
  plaza: boolean;
}
