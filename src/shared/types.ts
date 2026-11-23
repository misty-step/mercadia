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
/** The four Eras of a dynasty: Founding Charter, Transit & Trade, Grand Boulevard, Golden Dynasty. */
export type Era = 1 | 2 | 3 | 4;
/** Permanent doctrines a House adopts at the Era Council. */
export type CharterKey = 'artisanry' | 'transit' | 'credit' | 'canal' | 'heralds' | 'provisioners';
/** The four cumulative Dynasty Milestones, in order. */
export type MilestoneKey = 'merchant' | 'baron' | 'benefactor' | 'sovereign';

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
  dividends: number; // Dynasty Milestone dividends
  borrowed: number; // financing: credit-line draws (not part of net cashflow)
  repaid: number; // financing: principal repaid (not part of net cashflow)
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
  charters: CharterKey[]; // Dynasty Charters adopted, in the order of the Councils
  milestones: number[]; // per MILESTONES entry: the tick it was earned, or -1
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
  lost: LostCustomers; // recent customers this shop failed to win, by reason (decayed)
  riders: number; // Tram Stop: commuters delivered to this stop
  auraSales: number; // Park / Plaza: sales made by shops inside the aura
}

/** Why a shop recently lost customers. Exponentially decayed, so a fix shows up within a minute. */
export interface LostCustomers {
  tooPricey: number;
  queueFull: number;
  outOfStock: number;
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
  n?: number; // headline count while the event runs (tourists served, riders delivered, …)
  take?: number[]; // per player: what the event was worth (or cost) while it ran
}

export interface GazetteLine {
  tick: number;
  text: string;
  tone: 'event' | 'market' | 'civic' | 'rival';
}

/** Chronicle categories. The stripe colour follows: brass, canal, or the acting House. */
export type DispatchCat = 'era' | 'milestone' | 'charter' | 'lead' | 'event' | 'rival' | 'promo' | 'build' | 'market';

/** One dispatch of the Mercadia Chronicle: a punchy headline and its exact mechanical impact. */
export interface Dispatch {
  n: number; // serial number, 1-based, never reused within a match
  tick: number;
  cat: DispatchCat;
  tier: 1 | 2; // 1 = headline banner + audio sting, 2 = feed only
  head: string;
  pill: string; // mechanical impact tag: "Cinema +45%", "+§80 · ★1", "New Leader"
  player: number; // acting House (player index) or -1
  tile: number; // lot to focus the camera on, or -1
  icon: string; // event kind, build kind, or '' (the crest or category badge is used)
}

/** One row of the Era Council's standings: where a House stood at the era's close. */
export interface CouncilRow {
  player: number;
  crown: number;
  delta: number; // Crown Index gained during the era just closed
}

/** The Era Council: open between Eras I–II, II–III and III–IV. The simulation is paused. */
export interface Council {
  era: number; // the era that just closed (1..3)
  next: number; // the era about to begin
  offers: CharterKey[][]; // per player: three distinct charters
  picks: (CharterKey | null)[]; // per player: the charter chosen so far
  left: number; // countdown in 100 ms beats (multiplayer); solo waits for Advance
  total: number; // countdown length, for the progress bar
  rows: CouncilRow[]; // standings at the era's close, in rank order
  unlocked: BuildKind[]; // build tools the next era unlocks
  level3: boolean; // the next era unlocks Level 3 architecture
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
  | { k: 'council'; era: number }
  | { k: 'charter'; p: number; key: CharterKey }
  | { k: 'milestone'; p: number; m: number }
  | { k: 'dispatch'; n: number; tier: 1 | 2; cat: DispatchCat }
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
  stars: number; // Dynasty Milestones earned
  charters: CharterKey[];
}

/** Market share over the match: one sample per daypart, share×1000 per player. */
export interface ShareTrend {
  perQuarter: number; // samples per quarter
  samples: number[][];
}

export interface MatchResult {
  winner: number;
  rows: ResultRow[];
  awards: Award[];
  trend: ShareTrend;
  leaders: number[]; // who led the Crown Index at each quarter's close
  highlight: string; // the front-page headline of the Final Edition
}

export interface GameState {
  seed: number;
  rng: number;
  tick: number;
  mode: MatchMode;
  quarterTicks: number;
  totalQuarters: number; // 0 = endless
  quarter: number; // 1-based
  phase: 'playing' | 'council' | 'ended';
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
  trend: number[][]; // market share×1000 per player, sampled every daypart
  leaders: number[]; // Crown Index leader at each quarter's close
  council: Council | null; // open Era Council, or null
  chronicle: Dispatch[]; // the Mercadia Chronicle: recent dispatches, oldest first
  chronicleN: number; // dispatches ever published
  leader: number; // House currently holding the Crown Index lead, or -1 before one is established
  leadTick: number; // tick of the last lead-change dispatch
  eraCrowns: number[][]; // Crown Index per player at each era's close
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
  | { c: 'repay' }
  | { c: 'charter'; key: CharterKey };

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
