// Wire protocol: messages, the compact snapshot encoder, and the client-side view store.
// Solo play feeds the same encoder → view path that multiplayer uses over the socket.
import { ARCHETYPES, DESIRES, EVENT_KINDS, MILESTONES, eraOf } from './constants';
import { crownIndex, headlineEvent, marketShares, netWorth, quarterTick } from './sim';
import type {
  AiPersona,
  Archetype,
  Building,
  CharterKey,
  Command,
  Council,
  Desire,
  Dispatch,
  EventKind,
  Fx,
  GameState,
  GazetteLine,
  Ledger,
  MatchMode,
  MatchResult,
} from './types';

// ───────────────────────────── Lobby ─────────────────────────────

export interface SeatView {
  kind: 'open' | 'human' | 'ai';
  name: string;
  house: number;
  connected: boolean;
  persona: AiPersona | null;
}

export interface LobbyView {
  code: string;
  status: 'lobby' | 'playing' | 'ended';
  host: number;
  mode: MatchMode;
  speed: number;
  matchNo: number;
  seats: SeatView[];
}

// ───────────────────────────── Messages ─────────────────────────────

export type ClientMsg =
  | { t: 'hello'; name?: string; playerId?: string }
  | { t: 'lobby'; name?: string; house?: number }
  | { t: 'seat'; seat: number; ai: boolean }
  | { t: 'aifill'; on: boolean } // host: every empty seat becomes an AI rival (on) or stays open (off: pure PvP)
  | { t: 'mode'; mode: MatchMode }
  | { t: 'start' }
  | { t: 'speed'; speed: number }
  | { t: 'cmd'; cmd: Command }
  | { t: 'rematch' }
  | { t: 'endless' }
  | { t: 'ping'; at: number };

export type ServerMsg =
  | { t: 'welcome'; playerId: string; seat: number; player: number; lobby: LobbyView }
  | { t: 'lobby'; lobby: LobbyView }
  | { t: 'reject'; err: string }
  | { t: 'error'; err: string }
  | { t: 'pong'; at: number }
  | Snap;

const MSG_TYPES = new Set(['hello', 'lobby', 'seat', 'aifill', 'mode', 'start', 'speed', 'cmd', 'rematch', 'endless', 'ping']);

/** Parse and shallow-validate a client frame. Returns null for anything malformed. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (typeof o.t !== 'string' || !MSG_TYPES.has(o.t)) return null;
  switch (o.t) {
    case 'hello':
      if (o.name !== undefined && typeof o.name !== 'string') return null;
      if (o.playerId !== undefined && typeof o.playerId !== 'string') return null;
      break;
    case 'lobby':
      if (o.name !== undefined && typeof o.name !== 'string') return null;
      if (o.house !== undefined && typeof o.house !== 'number') return null;
      break;
    case 'seat':
      if (typeof o.seat !== 'number' || typeof o.ai !== 'boolean') return null;
      break;
    case 'aifill':
      if (typeof o.on !== 'boolean') return null;
      break;
    case 'mode':
      if (o.mode !== 'blitz' && o.mode !== 'standard' && o.mode !== 'endless') return null;
      break;
    case 'speed':
      if (typeof o.speed !== 'number') return null;
      break;
    case 'cmd':
      if (!o.cmd || typeof o.cmd !== 'object' || typeof (o.cmd as { c?: unknown }).c !== 'string') return null;
      break;
    case 'ping':
      if (typeof o.at !== 'number') return null;
      break;
    default:
      break;
  }
  return o as unknown as ClientMsg;
}

// ───────────────────────────── Snapshots ─────────────────────────────

/** A building as the client sees it: queue and service collapse to counts. */
export interface BuildingView extends Omit<Building, 'queue' | 'serving'> {
  q: number;
  sv: number;
}

export interface SnapMeta {
  seed: number;
  mode: MatchMode;
  qt: number;
  tq: number;
  players: { name: string; house: number; kind: 'human' | 'ai'; persona: AiPersona | null }[];
}

export const CITIZEN_STRIDE = 9;

export interface Snap {
  t: 'snap';
  full: boolean;
  k: number; // tick
  q: [number, number, number]; // era clock (quarter), phase (0 playing, 1 ended, 2 Era Council), endless
  sp: number; // pace
  p: number[][]; // per player: cash, debt, prestige×10, share×1000, crown, netWorth
  c: number[]; // citizens, CITIZEN_STRIDE numbers each
  tr: number[]; // trams: pos×1000, stopped, special
  ev: [number, number, number, number, number] | null; // kind, announceAt, startAt, endAt, started
  meta?: SnapMeta;
  b?: BuildingView[]; // changed (or all, when full)
  br?: number[]; // removed building ids
  gz?: GazetteLine[];
  lg?: { cur: Ledger; last: Ledger; total: Ledger }[];
  ff?: number[]; // footfall ×10
  dm?: number[]; // met ×10 per desire, then unmet ×10 per desire
  fx?: Fx[];
  res?: MatchResult | null;
  ch?: Dispatch[]; // the Chronicle, when a dispatch was published
  cn?: Council | null; // the Era Council: sent while it sits, and once as null when it rises
  dy?: DynastyRow[]; // per player: charters, milestones, progress counters
}

/** A House's dynasty record on the wire. */
export interface DynastyRow {
  c: CharterKey[]; // charters adopted
  m: number[]; // milestone ticks (-1 = not yet)
  sv: number; // citizens served
  cb: number; // civic projects built
}

const toView = (b: Building): BuildingView => {
  const { queue, serving, ...rest } = b;
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  return {
    ...rest,
    rating: Math.round(b.rating * 100) / 100,
    lost: { tooPricey: r1(b.lost.tooPricey), queueFull: r1(b.lost.queueFull), outOfStock: r1(b.lost.outOfStock) },
    q: queue.length,
    sv: serving.length / 2,
  };
};

/**
 * Everything that makes a Ledger drawer stale when it moves: each House's cash, debt and
 * Milestones, and its three ledgers (current Era, last Era, whole match).
 */
const moneyKeyOf = (s: GameState): string =>
  JSON.stringify(s.players.map((p) => [p.cash, p.debt, p.milestones, p.ledger, p.lastLedger, p.totalLedger]));

/** Encodes GameState into snapshots, sending only buildings that changed since the last one. */
export class SnapEncoder {
  private sent = new Map<number, string>();
  private gzN = -1;
  private chN = -1;
  private resSent = false;
  private cnOpen = false;
  private dyKey = '';
  /** The ten-tick bucket whose slow lane (ledgers, footfall, demand) went out last. */
  private slowBucket = -1;
  /** Every House's money as last broadcast: cash, debt, milestones and all three ledgers. */
  private moneyKey = '';

  reset(): void {
    this.sent.clear();
    this.gzN = -1;
    this.chN = -1;
    this.resSent = false;
    this.cnOpen = false;
    this.dyKey = '';
    this.slowBucket = -1;
    this.moneyKey = '';
  }

  /** `full` snapshots carry everything and do not disturb the delta memory. */
  encode(s: GameState, full: boolean, speed = 1): Snap {
    const shares = marketShares(s);
    const c: number[] = [];
    for (const z of s.citizens) {
      c.push(
        z.id,
        Math.round(z.x * 100),
        Math.round(z.y * 100),
        z.state,
        ARCHETYPES.indexOf(z.arch),
        DESIRES.indexOf(z.desire),
        Math.round(z.mood * 100),
        z.target,
        Math.round(z.budget),
      );
    }
    const tr: number[] = [];
    for (const t of s.trams) tr.push(Math.round(t.pos * 1000), t.dwell > 0 ? 1 : 0, t.special ? 1 : 0);
    const e = headlineEvent(s);
    const snap: Snap = {
      t: 'snap',
      full,
      k: s.tick,
      q: [s.quarter, s.phase === 'ended' ? 1 : s.phase === 'council' ? 2 : 0, s.endless ? 1 : 0],
      sp: speed,
      p: s.players.map((p) => [
        Math.round(p.cash),
        Math.round(p.debt),
        Math.round(p.prestige * 10),
        Math.round(shares[p.id] * 1000),
        crownIndex(s, p),
        netWorth(s, p),
      ]),
      c,
      tr,
      ev: e ? [EVENT_KINDS.indexOf(e.kind), e.announceAt, e.startAt, e.endAt, e.started ? 1 : 0] : null,
    };
    const dynasty: DynastyRow[] = s.players.map((p) => ({ c: p.charters, m: p.milestones, sv: p.stats.served, cb: p.stats.civicBuilt }));
    // The slow lane (ledgers, footfall, demand) goes out whenever the ten-tick bucket moves on,
    // not on `tick % 10 === 0`: at 2× a room broadcasts every other tick, and a pace change on
    // an odd tick would otherwise never land on a multiple of ten again.
    const bucket = Math.floor(s.tick / 10);
    const slow = full || bucket !== this.slowBucket;
    // The ledgers also ride the very beat any House's money moves (a sale, a Milestone
    // dividend, a loan draw or repayment), so the Ledger drawer always reconciles with the
    // Treasury to the exact §.
    let money = false;
    if (!full) {
      this.slowBucket = bucket;
      const moneyKey = moneyKeyOf(s);
      money = moneyKey !== this.moneyKey;
      this.moneyKey = moneyKey;
    }
    if (slow || money) snap.lg = s.players.map((p) => ({ cur: p.ledger, last: p.lastLedger, total: p.totalLedger }));
    if (slow) {
      snap.ff = s.footfall.map((v) => Math.round(v * 10));
      snap.dm = [...s.met, ...s.unmet].map((v) => Math.round(v * 10));
    }
    if (full) {
      snap.meta = {
        seed: s.seed,
        mode: s.mode,
        qt: s.quarterTicks,
        tq: s.totalQuarters,
        players: s.players.map((p) => ({ name: p.name, house: p.house, kind: p.kind, persona: p.persona })),
      };
      snap.b = s.buildings.map(toView);
      snap.gz = s.gazette;
      snap.ch = s.chronicle;
      snap.cn = s.council;
      snap.dy = dynasty;
      snap.res = s.result;
      return snap;
    }
    // Delta: buildings that changed, buildings that vanished.
    const changed: BuildingView[] = [];
    const alive = new Set<number>();
    for (const b of s.buildings) {
      alive.add(b.id);
      const v = toView(b);
      const key = JSON.stringify(v);
      if (this.sent.get(b.id) !== key) {
        this.sent.set(b.id, key);
        changed.push(v);
      }
    }
    const removed: number[] = [];
    for (const id of this.sent.keys()) if (!alive.has(id)) removed.push(id);
    for (const id of removed) this.sent.delete(id);
    if (changed.length) snap.b = changed;
    if (removed.length) snap.br = removed;
    if (s.gazetteN !== this.gzN) {
      this.gzN = s.gazetteN;
      snap.gz = s.gazette;
    }
    if (s.chronicleN !== this.chN) {
      this.chN = s.chronicleN;
      snap.ch = s.chronicle;
    }
    // The Council rides every snapshot while it sits (picks and the countdown change), and
    // is cleared with a single null when it rises.
    if (s.council) {
      this.cnOpen = true;
      snap.cn = s.council;
    } else if (this.cnOpen) {
      this.cnOpen = false;
      snap.cn = null;
    }
    const dyKey = JSON.stringify(dynasty);
    if (dyKey !== this.dyKey) {
      this.dyKey = dyKey;
      snap.dy = dynasty;
    }
    if (s.fx.length) snap.fx = s.fx.slice();
    const hasRes = s.result !== null;
    if (hasRes !== this.resSent) {
      this.resSent = hasRes;
      snap.res = s.result;
    }
    return snap;
  }
}

// ───────────────────────────── Client view ─────────────────────────────

export interface CitizenView {
  id: number;
  arch: Archetype;
  desire: Desire;
  x: number;
  y: number;
  px: number; // previous snapshot position, for interpolation
  py: number;
  state: number;
  mood: number;
  target: number;
  budget: number;
  born: number; // tick first seen
}

export interface PlayerView {
  id: number;
  name: string;
  house: number;
  kind: 'human' | 'ai';
  persona: AiPersona | null;
  cash: number;
  debt: number;
  prestige: number;
  share: number;
  crown: number;
  netWorth: number;
  charters: CharterKey[];
  milestones: number[];
  served: number;
  civicBuilt: number;
}

export interface TramView {
  pos: number;
  ppos: number;
  stopped: boolean;
  special: boolean;
}

export interface EventView {
  kind: EventKind;
  announceAt: number;
  startAt: number;
  endAt: number;
  started: boolean;
}

const zeroLedger = (): Ledger => ({
  revenue: 0, wages: 0, supplies: 0, rent: 0, interest: 0, construction: 0, civic: 0, marketing: 0, salvage: 0, awards: 0,
  dividends: 0, borrowed: 0, repaid: 0,
});

/** What the renderer and HUD read. Rebuilt incrementally from snapshots. */
export class CityView {
  ready = false;
  seed = 0;
  mode: MatchMode = 'standard';
  quarterTicks = 1500;
  totalQuarters = 4;
  tick = 0;
  quarter = 1;
  ended = false;
  /** True while the Era Council sits and the city is paused. */
  inCouncil = false;
  endless = false;
  speed = 1;
  players: PlayerView[] = [];
  ledgers: { cur: Ledger; last: Ledger; total: Ledger }[] = [];
  buildings: BuildingView[] = [];
  private byId = new Map<number, BuildingView>();
  private byTile = new Map<number, BuildingView>();
  citizens = new Map<number, CitizenView>();
  trams: TramView[] = [];
  event: EventView | null = null;
  gazette: GazetteLine[] = [];
  /** The Mercadia Chronicle: recent dispatches, oldest first. */
  chronicle: Dispatch[] = [];
  council: Council | null = null;
  footfall: number[] = new Array<number>(144).fill(0);
  met: number[] = DESIRES.map(() => 0);
  unmet: number[] = DESIRES.map(() => 0);
  result: MatchResult | null = null;
  /** Bumps whenever the set of buildings or their fields change. */
  buildingsRev = 0;

  get qTick(): number {
    return quarterTick(this);
  }
  /** The headline event as a list, so shared helpers that take `events` accept a view. */
  get events(): EventView[] {
    return this.event ? [this.event] : [];
  }
  get dayPhase(): number {
    return Math.min(0.9999, Math.max(0, this.qTick / this.quarterTicks));
  }
  /** The era (1..4) on the clock. */
  get era(): number {
    return eraOf(this.quarter);
  }

  building(id: number): BuildingView | undefined {
    return this.byId.get(id);
  }
  buildingAt(tile: number): BuildingView | undefined {
    return this.byTile.get(tile);
  }

  /** Apply a snapshot. Returns the feedback events it carried. */
  apply(s: Snap): Fx[] {
    if (s.full) {
      this.byId.clear();
      this.citizens.clear();
      this.trams = [];
      this.result = null;
      this.chronicle = [];
      this.council = null;
      if (s.meta) {
        this.seed = s.meta.seed;
        this.mode = s.meta.mode;
        this.quarterTicks = s.meta.qt;
        this.totalQuarters = s.meta.tq;
        this.players = s.meta.players.map((p, i) => ({
          id: i, ...p, cash: 0, debt: 0, prestige: 0, share: 0, crown: 0, netWorth: 0,
          charters: [], milestones: MILESTONES.map(() => -1), served: 0, civicBuilt: 0,
        }));
        this.ledgers = this.players.map(() => ({ cur: zeroLedger(), last: zeroLedger(), total: zeroLedger() }));
      }
    } else if (!this.ready) {
      return []; // a delta before the first full snapshot is meaningless
    }
    this.ready = true;
    this.tick = s.k;
    this.quarter = s.q[0];
    this.ended = s.q[1] === 1;
    this.inCouncil = s.q[1] === 2;
    this.endless = s.q[2] === 1;
    this.speed = s.sp;
    s.p.forEach((row, i) => {
      const p = this.players[i];
      if (!p) return;
      p.cash = row[0];
      p.debt = row[1];
      p.prestige = row[2] / 10;
      p.share = row[3] / 1000;
      p.crown = row[4];
      p.netWorth = row[5];
    });
    // Citizens: keep the previous position for interpolation, drop the departed.
    const seen = new Set<number>();
    for (let i = 0; i < s.c.length; i += CITIZEN_STRIDE) {
      const id = s.c[i];
      const x = s.c[i + 1] / 100;
      const y = s.c[i + 2] / 100;
      seen.add(id);
      let z = this.citizens.get(id);
      if (!z) {
        z = {
          id, x, y, px: x, py: y, state: 0, mood: 0, target: -1, budget: 0, born: s.k,
          arch: ARCHETYPES[s.c[i + 4]], desire: DESIRES[s.c[i + 5]],
        };
        this.citizens.set(id, z);
      } else {
        z.px = z.x;
        z.py = z.y;
        z.x = x;
        z.y = y;
      }
      z.state = s.c[i + 3];
      z.desire = DESIRES[s.c[i + 5]];
      z.mood = s.c[i + 6] / 100;
      z.target = s.c[i + 7];
      z.budget = s.c[i + 8];
    }
    for (const id of this.citizens.keys()) if (!seen.has(id)) this.citizens.delete(id);
    // Trams.
    const n = s.tr.length / 3;
    const trams: TramView[] = [];
    for (let i = 0; i < n; i++) {
      const pos = s.tr[i * 3] / 1000;
      const old = this.trams[i];
      const sameKind = old && old.special === (s.tr[i * 3 + 2] === 1);
      trams.push({ pos, ppos: sameKind ? old.pos : pos, stopped: s.tr[i * 3 + 1] === 1, special: s.tr[i * 3 + 2] === 1 });
    }
    this.trams = trams;
    this.event = s.ev
      ? { kind: EVENT_KINDS[s.ev[0]], announceAt: s.ev[1], startAt: s.ev[2], endAt: s.ev[3], started: s.ev[4] === 1 }
      : null;
    if (s.b || s.br) {
      for (const b of s.b ?? []) this.byId.set(b.id, b);
      for (const id of s.br ?? []) this.byId.delete(id);
      this.buildings = [...this.byId.values()];
      this.byTile.clear();
      for (const b of this.buildings) this.byTile.set(b.tile, b);
      this.buildingsRev++;
    } else if (s.full) {
      this.buildings = [];
      this.byTile.clear();
      this.buildingsRev++;
    }
    if (s.gz) this.gazette = s.gz.slice();
    if (s.ch) this.chronicle = s.ch.slice();
    if (s.cn !== undefined) this.council = s.cn ? { ...s.cn, picks: s.cn.picks.slice(), offers: s.cn.offers.map((o) => o.slice()) } : null;
    if (!this.inCouncil) this.council = null;
    if (s.dy)
      s.dy.forEach((row, i) => {
        const p = this.players[i];
        if (!p) return;
        p.charters = row.c.slice();
        p.milestones = row.m.slice();
        p.served = row.sv;
        p.civicBuilt = row.cb;
      });
    if (s.lg) this.ledgers = s.lg;
    if (s.ff) this.footfall = s.ff.map((v) => v / 10);
    if (s.dm) {
      this.met = s.dm.slice(0, DESIRES.length).map((v) => v / 10);
      this.unmet = s.dm.slice(DESIRES.length).map((v) => v / 10);
    }
    if (s.res !== undefined) this.result = s.res;
    return s.fx ?? [];
  }
}
