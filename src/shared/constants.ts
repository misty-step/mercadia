// MERCADIA tuning tables. Every gameplay number lives here.
import type {
  AiPersona,
  Archetype,
  BuildKind,
  CivicKind,
  Desire,
  EventKind,
  MatchMode,
  ShopKind,
} from './types';

export const VERSION = '1.0.0';
export const TICK_MS = 100;
export const TICKS_PER_SEC = 10;

export const HOUSES = [
  { key: 'vermilion', name: 'Vermilion Guild', short: 'Vermilion', color: '#D6453A', dark: '#A8322A', light: '#F0A39B' },
  { key: 'cobalt', name: 'Cobalt Syndicate', short: 'Cobalt', color: '#2667B8', dark: '#1B4C8A', light: '#9DBDE6' },
  { key: 'marigold', name: 'Marigold House', short: 'Marigold', color: '#D48C1C', dark: '#A56A10', light: '#F0CB8A' },
  { key: 'emerald', name: 'Emerald Atelier', short: 'Emerald', color: '#248A63', dark: '#17664A', light: '#93CDB5' },
] as const;

export const DESIRES: Desire[] = ['coffee', 'dining', 'leisure', 'fashion', 'culture', 'nightlife'];
export const SHOP_KINDS: ShopKind[] = ['roastery', 'bistro', 'arcade', 'boutique', 'cinema', 'nightmarket'];
export const CIVIC_KINDS: CivicKind[] = ['park', 'tramstop', 'plaza'];
export const BUILD_KINDS: BuildKind[] = [...SHOP_KINDS, ...CIVIC_KINDS];
export const ARCHETYPES: Archetype[] = ['commuter', 'local', 'foodie', 'tourist', 'nightowl'];
export const EVENT_KINDS: EventKind[] = [
  'cloudburst',
  'cruise',
  'freeride',
  'critic',
  'lantern',
  'renthike',
  'supplycrunch',
];

export interface ShopDef {
  kind: ShopKind;
  name: string;
  desire: Desire;
  cost: number;
  price: number; // base (Fair) ticket
  unitCost: number; // supply cost per sale
  serviceTicks: number;
  servers: number;
  queueCap: [number, number, number];
  wage: number; // per payroll
  rent: number; // per payroll
  stockMax: number;
  blurb: string;
}

export const SHOPS: Record<ShopKind, ShopDef> = {
  roastery: {
    kind: 'roastery', name: 'Roastery', desire: 'coffee', cost: 180, price: 9, unitCost: 3,
    serviceTicks: 14, servers: 1, queueCap: [5, 7, 9], wage: 3, rent: 1, stockMax: 40,
    blurb: 'Fast morning rush, high throughput, modest margin.',
  },
  bistro: {
    kind: 'bistro', name: 'Bistro', desire: 'dining', cost: 280, price: 22, unitCost: 8,
    serviceTicks: 44, servers: 2, queueCap: [6, 8, 11], wage: 8, rent: 3, stockMax: 24,
    blurb: 'Lunch and dinner surges. Loves canal and plaza frontage.',
  },
  arcade: {
    kind: 'arcade', name: 'Arcade', desire: 'leisure', cost: 260, price: 12, unitCost: 3,
    serviceTicks: 50, servers: 3, queueCap: [7, 10, 13], wage: 5, rent: 2, stockMax: 40,
    blurb: 'Steady afternoon and evening play. Loves Tram Stops.',
  },
  boutique: {
    kind: 'boutique', name: 'Boutique', desire: 'fashion', cost: 380, price: 46, unitCost: 18,
    serviceTicks: 40, servers: 1, queueCap: [4, 5, 7], wage: 9, rent: 6, stockMax: 12,
    blurb: 'High-margin luxury. Tourists and upscale locals.',
  },
  cinema: {
    kind: 'cinema', name: 'Cinema', desire: 'culture', cost: 460, price: 24, unitCost: 6,
    serviceTicks: 70, servers: 5, queueCap: [10, 14, 18], wage: 6, rent: 4, stockMax: 40,
    blurb: 'Huge evening crowds, and a rainstorm fills every seat.',
  },
  nightmarket: {
    kind: 'nightmarket', name: 'Nightmarket', desire: 'nightlife', cost: 320, price: 18, unitCost: 6,
    serviceTicks: 28, servers: 2, queueCap: [8, 11, 14], wage: 4, rent: 2, stockMax: 36,
    blurb: 'Explosive at dusk. The Lantern Festival magnet.',
  },
};

export interface CivicDef {
  kind: CivicKind;
  name: string;
  cost: number;
  rent: number;
  prestige: number;
  blurb: string;
}

export const CIVICS: Record<CivicKind, CivicDef> = {
  park: {
    kind: 'park', name: 'Pocket Park', cost: 160, rent: 1, prestige: 4,
    blurb: '+20% quality pull for neighbouring shops. Locals stroll here.',
  },
  tramstop: {
    kind: 'tramstop', name: 'Tram Stop', cost: 240, rent: 2, prestige: 6,
    blurb: 'Trams pause here and drop commuters on your block.',
  },
  plaza: {
    kind: 'plaza', name: 'Festival Plaza', cost: 340, rent: 3, prestige: 10,
    blurb: 'Tourist magnet. +30% appeal aura over two tiles.',
  },
};

const own = (o: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
export const isShop = (k: unknown): k is ShopKind => own(SHOPS, k);
export const isCivic = (k: unknown): k is CivicKind => own(CIVICS, k);
export const buildCost = (k: BuildKind): number => (isShop(k) ? SHOPS[k].cost : CIVICS[k].cost);
export const buildName = (k: BuildKind): string => (isShop(k) ? SHOPS[k].name : CIVICS[k].name);

export const STANCES = [
  { key: 'budget', name: 'Budget', mult: 0.75, cachet: 0.92, label: '-25%' },
  { key: 'fair', name: 'Fair', mult: 1.0, cachet: 1.0, label: '0%' },
  { key: 'craft', name: 'Craft', mult: 1.2, cachet: 1.04, label: '+20%' },
  { key: 'prestige', name: 'Prestige', mult: 1.45, cachet: 1.08, label: '+45%' },
] as const;

export const LEVEL_APPEAL = [1, 1.13, 1.26];
export const LEVEL_SPEED = [1, 0.88, 0.78];
/** Extra parallel servers at each level, for halls that seat several guests (arcade, cinema). */
export const LEVEL_SERVERS = [0, 0, 1];
export const HALL_SERVERS = 3; // a shop needs at least this many base servers to gain one
export const UPGRADE_COST = [0.6, 0.9]; // × build cost for Lv2, Lv3
export const SALVAGE = 0.6;
export const BOOK_VALUE = 0.8; // share of invested capital counted in net worth

export const PROMO_COST = 80;
export const PROMO_TICKS = 200;
export const PROMO_COOLDOWN = 400; // after the blitz ends
export const PROMO_PULL = 2.4;
export const PROMO_DESIRE = 1.35; // a running blitz also stirs up appetite for its trade

export const LOAN_STEP = 400;
export const LOAN_MAX = 1200;
export const LOAN_RATE = 0.012; // per payroll
export const PAYROLL_TICKS = 100;
/** Interest a standing loan costs over one quarter, as a fraction (0.18 = 18%). */
export const loanRatePerQuarter = (quarterTicks: number): number => LOAN_RATE * (quarterTicks / PAYROLL_TICKS);
/** "18%/qtr" — the exact rate shown on the Borrow button. */
export const loanRateLabel = (quarterTicks: number): string =>
  `${(Math.round(loanRatePerQuarter(quarterTicks) * 1000) / 10).toString()}%/qtr`;
export const AUTO_RESTOCK_PREMIUM = 1.15;
export const AUTO_RESTOCK_AT = 0.2;

export const START_CASH = 900;

export const MODES: Record<MatchMode, { name: string; quarters: number; quarterTicks: number; slots: number[]; span: number }> = {
  blitz: { name: 'Blitz', quarters: 2, quarterTicks: 600, slots: [0.12, 0.66], span: 0.22 },
  standard: { name: 'Standard', quarters: 4, quarterTicks: 1500, slots: [0.1, 0.42, 0.74], span: 0.18 },
  endless: { name: 'Endless Sandbox', quarters: 0, quarterTicks: 1500, slots: [0.1, 0.42, 0.74], span: 0.18 },
};
export const FORECAST_LEAD = 0.05; // of a quarter
export const TREND_PER_QUARTER = 4; // market-share samples kept per quarter (one per daypart)
export const TREND_MAX = 96;
/** Per-tick decay of a shop's lost-customer counters (half-life about 45 s). */
export const LOST_DECAY = 0.9985;
/** Ticks between rivalry headlines, so the Gazette is punchy rather than noisy. */
export const RIVALRY_QUIET = 150;

export const DAYPART_NAMES = ['Morning', 'Noon', 'Golden Hour', 'Twilight'] as const;

/** Demand weight per desire per daypart. */
export const DAY_DEMAND: Record<Desire, [number, number, number, number]> = {
  coffee: [1.0, 0.6, 0.45, 0.2],
  dining: [0.15, 1.0, 0.3, 0.9],
  leisure: [0.15, 0.4, 0.9, 0.8],
  fashion: [0.2, 0.6, 0.9, 0.4],
  culture: [0.06, 0.25, 0.5, 1.0],
  nightlife: [0.0, 0.05, 0.3, 1.1],
};

export interface ArchDef {
  name: string;
  budget: [number, number];
  sens: number; // price sensitivity exponent
  qlove: number; // quality exponent
  patience: [number, number]; // ticks
  wants: [number, number];
  speed: number; // tiles per tick
  desires: Record<Desire, number>;
}

export const ARCHS: Record<Archetype, ArchDef> = {
  commuter: {
    name: 'Commuter', budget: [14, 36], sens: 2.2, qlove: 0.5, patience: [70, 110], wants: [1, 2], speed: 0.125,
    desires: { coffee: 6, dining: 1.6, leisure: 1, fashion: 0.3, culture: 0.4, nightlife: 0.6 },
  },
  local: {
    name: 'Local', budget: [30, 70], sens: 1.7, qlove: 0.9, patience: [100, 160], wants: [1, 2], speed: 0.1,
    desires: { coffee: 2.6, dining: 2, leisure: 2, fashion: 1.0, culture: 1.5, nightlife: 1.2 },
  },
  foodie: {
    name: 'Foodie', budget: [50, 120], sens: 1.2, qlove: 1.3, patience: [130, 200], wants: [1, 3], speed: 0.095,
    desires: { coffee: 3, dining: 4, leisure: 0.5, fashion: 0.5, culture: 1, nightlife: 2 },
  },
  tourist: {
    name: 'Tourist', budget: [80, 200], sens: 0.7, qlove: 1.2, patience: [110, 180], wants: [2, 3], speed: 0.085,
    desires: { coffee: 1.6, dining: 2, leisure: 1.5, fashion: 2.6, culture: 2, nightlife: 1.5 },
  },
  nightowl: {
    name: 'Night Owl', budget: [40, 110], sens: 1.4, qlove: 0.9, patience: [90, 150], wants: [1, 3], speed: 0.105,
    desires: { coffee: 0.5, dining: 1.5, leisure: 2.5, fashion: 0.3, culture: 2.5, nightlife: 5 },
  },
};

/** Archetype spawn mix per daypart (commuter, local, foodie, tourist, nightowl). */
export const ARCH_MIX: [number, number, number, number, number][] = [
  [0.4, 0.28, 0.12, 0.16, 0.04],
  [0.18, 0.3, 0.26, 0.2, 0.06],
  [0.12, 0.34, 0.15, 0.28, 0.11],
  [0.08, 0.22, 0.18, 0.16, 0.36],
];

/** Target street population per daypart. */
export const POP_TARGET = [78, 92, 88, 98];
export const POP_MAX = 120;

export interface EventDef {
  kind: EventKind;
  title: string;
  forecast: string;
  headline: string;
  effect: string;
  demand: Partial<Record<Desire, number>>;
}

export const EVENTS: Record<EventKind, EventDef> = {
  cloudburst: {
    kind: 'cloudburst', title: 'Sudden Cloudburst',
    forecast: 'Barometer falling over the harbor — a cloudburst is minutes away.',
    headline: 'Sudden Cloudburst drenches the district. Crowds duck into cinemas and roasteries.',
    effect: 'Cinema & Roastery +45% · Nightmarket −35%',
    demand: { culture: 1.45, coffee: 1.45, nightlife: 0.65 },
  },
  cruise: {
    kind: 'cruise', title: 'Harbor Cruise Arrival',
    forecast: 'A white liner is sighted off the pier. Tourists are coming ashore.',
    headline: 'Harbor Cruise Arrival: wealthy tourists pour off the gangway.',
    effect: 'Tourist wave · Boutique & Bistro +40%',
    demand: { fashion: 1.4, dining: 1.4 },
  },
  freeride: {
    kind: 'freeride', title: 'Free-Ride Tram Day',
    forecast: 'The Tramway Board declares a Free-Ride Day. Expect packed cars.',
    headline: 'Free-Ride Tram Day: every stop receives double the commuters.',
    effect: 'Commuter drops ×2 at every Tram Stop',
    demand: {},
  },
  critic: {
    kind: 'critic', title: 'Food Critic Visit',
    forecast: 'A certain critic has been seen sharpening a pencil. Kitchens, look alive.',
    headline: 'Food Critic Visit: the best-rated Bistro or Roastery takes the Golden Fork.',
    effect: 'Top-rated Bistro/Roastery wins §250 + prestige',
    demand: { dining: 1.15, coffee: 1.1 },
  },
  lantern: {
    kind: 'lantern', title: 'Street Lantern Festival',
    forecast: 'Paper lanterns are being strung along the lanes for tonight.',
    headline: 'Street Lantern Festival: the lanes glow and the night trade roars.',
    effect: 'Nightmarket & Arcade +50%',
    demand: { nightlife: 1.5, leisure: 1.5 },
  },
  renthike: {
    kind: 'renthike', title: 'Commercial Rent Hike',
    forecast: 'Landlords are meeting behind closed shutters. Rents may rise.',
    headline: 'Commercial Rent Hike: upkeep is up by a quarter across the district.',
    effect: 'Rent +25% while it lasts',
    demand: {},
  },
  supplycrunch: {
    kind: 'supplycrunch', title: 'Supply Crunch',
    forecast: 'Barges are held at the lock. Stock up before wholesale prices jump.',
    headline: 'Supply Crunch: wholesale prices leap. Thin margins get thinner.',
    effect: 'Restock cost +60%',
    demand: {},
  },
};

export const RENT_HIKE = 1.25;
export const SUPPLY_CRUNCH = 1.6;
export const CRITIC_PRIZE = 250;
export const CRITIC_PRESTIGE = 10;
export const CRUISE_TOURISTS = 24;

export const PARK_AURA = 0.2;
export const PLAZA_AURA = 0.3;
export const PARK_RADIUS = 1; // Chebyshev tiles
export const PLAZA_RADIUS = 2;
/** Aura reach of a civic project in tiles (0 for a Tram Stop, whose reach is TRANSIT_RADIUS along streets). */
export const auraRadius = (k: BuildKind): number => (k === 'park' ? PARK_RADIUS : k === 'plaza' ? PLAZA_RADIUS : 0);
export const CORNER_PULL = 1.15;
export const CANAL_APPEAL = 1.1;
export const CANAL_APPEAL_BISTRO = 1.2;
export const AURA_MAX = 0.45;
export const TRANSIT_PULL = 1.1;
export const TRANSIT_RADIUS = 2;

/** Civic prestige earned through use rather than construction. */
export const PRESTIGE_LINGER = 0.08; // per citizen who lingers in a park or plaza
export const PRESTIGE_TRAM = 0.25; // per tram that calls at a player's stop
export const PRESTIGE_AURA_SALE = 0.03; // per sale made inside a park or plaza aura

export const CROWN = { netWorth: 0.1, share: 3, prestige: 4 };

export const AI_PERSONAS: Record<AiPersona, { name: string; title: string; blurb: string }> = {
  vesper: {
    name: 'Vesper', title: 'Aggressive Discounter',
    blurb: 'Takes busy corners, undercuts rivals, fires Promo Blitzes.',
  },
  aurelia: {
    name: 'Aurelia', title: 'Boutique Perfectionist',
    blurb: 'Canal and plaza frontage, Bistros and Boutiques, Level 3 fast.',
  },
  orson: {
    name: 'Orson', title: 'Transit Expansionist',
    blurb: 'Builds Tram Stops and Parks, then fills the corridor with shops.',
  },
};
export const AI_ORDER: AiPersona[] = ['vesper', 'aurelia', 'orson'];

export const FIRST_NAMES = [
  'Alba', 'Bruno', 'Carla', 'Dario', 'Elena', 'Fabio', 'Gaia', 'Hugo', 'Ines', 'Joan', 'Kira', 'Luca',
  'Mara', 'Nico', 'Olga', 'Pau', 'Quim', 'Rosa', 'Sergi', 'Tilda', 'Ugo', 'Vera', 'Wim', 'Xenia',
  'Yara', 'Zeno', 'Amal', 'Benno', 'Cleo', 'Dafne', 'Emil', 'Flora',
];
export const LAST_NAMES = [
  'Aldaia', 'Bellver', 'Casals', 'Dorado', 'Esteve', 'Ferrant', 'Garriga', 'Hortal', 'Isern', 'Julivert',
  'Llobet', 'Marés', 'Noguera', 'Oliva', 'Pruna', 'Quintana', 'Riera', 'Soler', 'Tarrés', 'Vidal',
];
