// Wire protocol: messages, the compact snapshot encoder, and the client-side view store.
// Solo play feeds the same encoder → view path that multiplayer uses over the socket.
import { ARCHETYPES, DESIRES, EVENT_KINDS } from './constants';
import { crownIndex, headlineEvent, marketShares, netWorth, quarterTick } from './sim';
import type {
  AiPersona,
  Archetype,
  Building,
  Command,
  Desire,
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

const MSG_TYPES = new Set(['hello', 'lobby', 'seat', 'mode', 'start', 'speed', 'cmd', 'rematch', 'endless', 'ping']);

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
  q: [number, number, number]; // quarter, ended, endless
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
}

const toView = (b: Building): BuildingView => {
  const { queue, serving, ...rest } = b;
  return { ...rest, rating: Math.round(b.rating * 100) / 100, q: queue.length, sv: serving.length / 2 };
};

/** Encodes GameState into snapshots, sending only buildings that changed since the last one. */
export class SnapEncoder {
  private sent = new Map<number, string>();
  private gzN = -1;
  private resSent = false;

  reset(): void {
    this.sent.clear();
    this.gzN = -1;
    this.resSent = false;
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
      q: [s.quarter, s.phase === 'ended' ? 1 : 0, s.endless ? 1 : 0],
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
    const slow = full || s.tick % 10 === 0;
    if (slow) {
      snap.lg = s.players.map((p) => ({ cur: p.ledger, last: p.lastLedger, total: p.totalLedger }));
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
      if (s.meta) {
        this.seed = s.meta.seed;
        this.mode = s.meta.mode;
        this.quarterTicks = s.meta.qt;
        this.totalQuarters = s.meta.tq;
        this.players = s.meta.players.map((p, i) => ({
          id: i, ...p, cash: 0, debt: 0, prestige: 0, share: 0, crown: 0, netWorth: 0,
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
