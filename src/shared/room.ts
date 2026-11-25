// RoomCore: the room authority as a pure state machine. The Durable Object owns sockets and
// storage; every decision (drafts, Ready, epochs, exactly-once resolution) is made here, one
// message at a time. There is no tick, no timer and no clock: the world changes only inside
// a resolution, which runs when the last human seat's Ready is recorded.
import { AI_ORDER, AI_PERSONAS, HOUSES, INCOMPATIBLE_RULESET_MESSAGE, SUMMARY_KEEP } from './constants';
import { computeStandings, createGame, stateHash } from './game';
import { N } from './map';
import { readyBlock } from './orders';
import type { ClientMsg, LobbyView, OwnSeat, SeatStatus, ServerMsg } from './protocol';
import { canonicalOrders, continueEndless, resolveTurn } from './resolve';
import { shortHash } from './hash';
import { MATCH_EXPORT_VERSION, type MatchExport } from './replay';
import type { ActionLog, AiPersona, Game, MatchMode, Order, TurnSummary } from './types';

export interface Seat {
  kind: 'open' | 'human' | 'ai';
  name: string;
  house: number;
  playerId: string | null;
  connected: boolean;
  persona: AiPersona | null;
  aiFill: boolean;
}

/** Everything the authority persists. Drafts and readiness are keyed by player index for the current turn. */
export interface RoomState {
  code: string;
  status: 'lobby' | 'playing' | 'ended';
  host: number;
  mode: MatchMode;
  matchNo: number;
  seed: number;
  seats: Seat[];
  playerOf: number[]; // seat → player index in the running match, or -1
  /** The last turn that has been resolved (0 before the first resolution). */
  lastResolved: number;
  drafts: { orders: Order[]; revision: number }[];
  ready: boolean[];
  epochs: number[];
  /** The summary that produced the current turn's world. */
  summary: TurnSummary | null;
  summaries: TurnSummary[];
  log: ActionLog;
  hashes: string[]; // full state hash after each resolved turn
  /** Log lengths at which the host chose Continue in Endless (absent in rooms stored before this field). */
  endlessAt?: number[];
  /**
   * The MATCH_EXPORT_VERSION the running match was started under. Absent in rooms whose match started
   * before this field existed: those rooms resume and play normally, but their hashes were produced under
   * an older ruleset, so they are never exported (relabelled) as the current version.
   */
  exportVersion?: number;
  config: { seed: number; mode: MatchMode; players: { name: string; house: number; kind: 'human' | 'ai'; persona: AiPersona | null }[] } | null;
}

export interface Outbound {
  to: string; // playerId, or '*' for every connected socket
  msg: ServerMsg;
}

export interface JoinResult {
  playerId: string;
  seat: number;
  out: Outbound[];
}

/** How long an unstarted lobby or a finished room may sit untouched, with nobody connected, before it is erased. */
export const IDLE_PURGE_MS = 6 * 60 * 60 * 1000;

/**
 * What the room's cleanup alarm does. PRODUCT.md "Seat reclaim": seats are never timed out or handed
 * to AI mid-match and the room simply waits, so a started match that has not ended is never erased,
 * whether or not a socket happens to be connected when the alarm fires.
 * The decision is made on the room AND its game together: an idle lobby is purged only when it has no
 * world at all, and a finished room only when its world is positively an ended one. A lobby that still
 * carries a game row, or any other pairing, is an anomaly and is kept.
 */
export function roomAlarmAction(room: Pick<RoomState, 'status'>, game: Pick<Game, 'phase'> | null | undefined, sockets: number, idleMs: number): 'keep' | 'purge' {
  // Fail closed: only a positively recognised idle lobby or finished room is ever purged.
  if (sockets !== 0 || !(idleMs >= IDLE_PURGE_MS)) return 'keep';
  if (room.status === 'lobby' && game === null) return 'purge';
  if (room.status === 'ended' && game != null && game.phase === 'ended') return 'purge';
  return 'keep';
}

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function makeRoomCode(random: () => number): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length];
  return code;
}
export const isRoomCode = (code: string): boolean => /^[A-Z]{4}$/.test(code);

export type StoredRoom = { kind: 'empty' } | { kind: 'v3'; room: RoomState; game: Game | null } | { kind: 'legacy' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function isValidSeat(s: unknown): boolean {
  return (
    isObject(s) &&
    (s.kind === 'open' || s.kind === 'human' || s.kind === 'ai') &&
    typeof s.name === 'string' &&
    typeof s.house === 'number' &&
    (s.playerId === null || typeof s.playerId === 'string') &&
    typeof s.connected === 'boolean' &&
    typeof s.aiFill === 'boolean'
  );
}

/** Every field the turn engine reads from a stored room, checked structurally. Nothing is repaired or defaulted. */
function isValidRoomState(room: Record<string, unknown>): boolean {
  return (
    typeof room.code === 'string' &&
    isRoomCode(room.code) &&
    (room.status === 'lobby' || room.status === 'playing' || room.status === 'ended') &&
    (room.mode === 'standard' || room.mode === 'blitz' || room.mode === 'endless') &&
    typeof room.seed === 'number' &&
    Number.isFinite(room.seed) &&
    isInt(room.host) &&
    room.host >= 0 &&
    room.host < 4 &&
    isInt(room.matchNo) &&
    isInt(room.lastResolved) &&
    !('speed' in room) &&
    !('acc' in room) &&
    Array.isArray(room.seats) &&
    room.seats.length === 4 &&
    room.seats.every(isValidSeat) &&
    Array.isArray(room.playerOf) &&
    room.playerOf.every((n) => typeof n === 'number') &&
    Array.isArray(room.drafts) &&
    room.drafts.every((d) => isObject(d) && Array.isArray(d.orders) && typeof d.revision === 'number') &&
    Array.isArray(room.ready) &&
    room.ready.every((b) => typeof b === 'boolean') &&
    Array.isArray(room.epochs) &&
    room.epochs.every((n) => typeof n === 'number') &&
    Array.isArray(room.log) &&
    Array.isArray(room.hashes) &&
    Array.isArray(room.summaries)
  );
}

const isObjectArray = (v: unknown): boolean => Array.isArray(v) && v.every(isObject);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isValidPlayer(p: unknown, i: number): boolean {
  return (
    isObject(p) &&
    p.id === i &&
    typeof p.name === 'string' &&
    isInt(p.house) &&
    p.house >= 0 &&
    p.house < 4 &&
    (p.kind === 'human' || p.kind === 'ai') &&
    isFiniteNum(p.cash) &&
    isFiniteNum(p.debt) &&
    isFiniteNum(p.prestige) &&
    Array.isArray(p.charters) &&
    Array.isArray(p.milestones) &&
    Array.isArray(p.studies) &&
    Array.isArray(p.sales) &&
    p.sales.every(isFiniteNum) &&
    isObject(p.stats)
  );
}

/** Every nested record and array the engine and the client read from a stored Game, checked structurally. */
function isValidGame(g: unknown): boolean {
  if (!isObject(g)) return false;
  if (
    g.version !== 3 ||
    !isInt(g.seed) ||
    !(g.mode === 'standard' || g.mode === 'blitz' || g.mode === 'endless') ||
    !isInt(g.turn) ||
    g.turn < 1 ||
    !(g.phase === 'planning' || g.phase === 'ended') ||
    typeof g.endless !== 'boolean' ||
    !isInt(g.nextId) ||
    g.nextId < 1 ||
    !isInt(g.dispatchN) ||
    g.dispatchN < 0 ||
    !isInt(g.winner) ||
    g.winner < -1 ||
    'tick' in g
  ) {
    return false;
  }
  if (!(g.council === null || (isObject(g.council) && isInt(g.council.era) && Array.isArray(g.council.offers)))) return false;
  if (!Array.isArray(g.players) || g.players.length < 1 || g.players.length > 4) return false;
  if (!g.players.every(isValidPlayer)) return false;
  const n = g.players.length;
  const owned = (o: Record<string, unknown>): boolean => isInt(o.id) && isInt(o.owner) && o.owner >= 0 && o.owner < n && isInt(o.tile) && o.tile >= 0 && o.tile < N;
  if (!Array.isArray(g.units) || !g.units.every((u) => isObject(u) && owned(u) && (u.kind === 'factor' || u.kind === 'watch' || u.kind === 'barge') && isInt(u.cohesion))) return false;
  if (!Array.isArray(g.buildings) || !g.buildings.every((b) => isObject(b) && owned(b) && typeof b.kind === 'string' && isInt(b.level))) return false;
  return isObjectArray(g.pacts) && isObjectArray(g.proposals) && isObjectArray(g.events) && isObjectArray(g.chronicle) && isObjectArray(g.standings) && isObjectArray(g.trend) && isObjectArray(g.honours);
}

/** The room and its world must describe the same match. Nothing is repaired: any mismatch is a corrupt save. */
function isCoherent(room: RoomState, game: Game | null): boolean {
  if (room.status === 'lobby') return game === null;
  if (game === null) return false;
  if (room.status === 'playing' && game.phase !== 'planning') return false;
  if (room.status === 'ended' && game.phase !== 'ended') return false;
  const n = game.players.length;
  return (
    room.drafts.length === n &&
    room.ready.length === n &&
    room.epochs.length === n &&
    room.playerOf.every((idx) => Number.isInteger(idx) && idx >= -1 && idx < n) &&
    room.lastResolved >= 0 &&
    room.lastResolved === game.turn - 1 &&
    room.hashes.length === room.lastResolved
  );
}

/**
 * Pure, strict classifier for what a Durable Object's SQLite `kv` holds under 'room' and 'game'.
 *  - empty:  neither key exists (a brand-new object).
 *  - v3:     'room' is a complete turn-engine RoomState (and 'game', if present, is a v3 Game).
 *  - legacy: anything else that is stored, including deployed v2 real-time rooms and corrupt records.
 * Legacy storage is never read as v3, never simulated, and never written or deleted.
 */
export function classifyStoredRoom(roomRaw: string | null, gameRaw: string | null): StoredRoom {
  if (roomRaw == null && gameRaw == null) return { kind: 'empty' };
  if (roomRaw == null) return { kind: 'legacy' };
  try {
    const room: unknown = JSON.parse(roomRaw);
    if (!isObject(room)) return { kind: 'legacy' };
    if (!isValidRoomState(room)) return { kind: 'legacy' };
    // A started or finished room cannot exist without its world.
    if ((room.status === 'playing' || room.status === 'ended') && gameRaw == null) return { kind: 'legacy' };
    let game: Game | null = null;
    if (gameRaw != null) {
      const g: unknown = JSON.parse(gameRaw);
      if (!isValidGame(g)) return { kind: 'legacy' };
      game = g as unknown as Game;
    }
    const typed = room as unknown as RoomState;
    if (!isCoherent(typed, game)) return { kind: 'legacy' };
    if (game) {
      // The engine's own read-only invariants: a Game that cannot be hashed or scored is not resumable.
      stateHash(game);
      computeStandings(game);
    }
    return { kind: 'v3', room: typed, game };
  } catch {
    return { kind: 'legacy' };
  }
}

export type ExportResult = { ok: true; export: MatchExport } | { ok: false; code: 'not_started' | 'incompatible_ruleset'; error: string };

export function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = Array.from(raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 16).join('').trim();
  return s || fallback;
}

export class RoomCore {
  room: RoomState;
  game: Game | null;
  private spectators = new Set<string>();

  constructor(code: string, seed: number, restore?: { room: RoomState; game: Game | null }) {
    if (restore) {
      this.room = restore.room;
      this.game = restore.game;
      return;
    }
    this.room = {
      code,
      status: 'lobby',
      host: 0,
      mode: 'standard',
      matchNo: 0,
      seed: seed >>> 0,
      seats: [0, 1, 2, 3].map((i) => ({
        kind: i === 0 ? 'open' : 'ai',
        name: '',
        house: i,
        playerId: null,
        connected: false,
        persona: null,
        aiFill: i !== 0,
      })),
      playerOf: [-1, -1, -1, -1],
      lastResolved: 0,
      drafts: [],
      ready: [],
      epochs: [],
      summary: null,
      summaries: [],
      log: [],
      hashes: [],
      config: null,
    };
    this.game = null;
    this.nameAis();
  }

  // ── Views ──

  lobby(): LobbyView {
    const r = this.room;
    return {
      code: r.code,
      status: r.status,
      host: r.host,
      mode: r.mode,
      matchNo: r.matchNo,
      seats: r.seats.map((s) => ({ kind: s.kind, name: s.name, house: s.house, connected: s.connected, persona: s.persona })),
    };
  }

  summary(): Record<string, unknown> {
    const r = this.room;
    return {
      code: r.code,
      status: r.status,
      mode: r.mode,
      humans: r.seats.filter((s) => s.kind === 'human').length,
      connected: r.seats.filter((s) => s.kind === 'human' && s.connected).length,
      ai: r.seats.filter((s) => s.kind === 'ai').length,
      open: r.seats.filter((s) => s.kind === 'open').length,
      turn: this.game ? this.game.turn : 0,
      seats: this.lobby().seats,
    };
  }

  /**
   * The canonical public MatchExport: config, the authority-committed resolved log, hashes and Endless
   * markers. Built field by field so no playerId, seat token, current-turn draft, Ready flag or epoch can leak.
   * Null until the match has started.
   */
  exportMatch(): MatchExport | null {
    const res = this.tryExport();
    return res.ok ? res.export : null;
  }

  /**
   * Like exportMatch, but says why there is nothing to export. A match whose hashes were produced under an
   * older ruleset (no recorded exportVersion, or one that is not the current version) is never stamped with
   * the current version: that would label historical hashes a replay cannot reproduce.
   */
  tryExport(): ExportResult {
    const r = this.room;
    if (!r.config || r.status === 'lobby') return { ok: false, code: 'not_started', error: 'The match has not started yet' };
    if (r.exportVersion !== MATCH_EXPORT_VERSION) return { ok: false, code: 'incompatible_ruleset', error: INCOMPATIBLE_RULESET_MESSAGE };
    const exp: MatchExport = {
      version: MATCH_EXPORT_VERSION,
      config: {
        seed: r.config.seed,
        mode: r.config.mode,
        players: r.config.players.map((p) => ({ name: p.name, house: p.house, kind: p.kind, persona: p.persona })),
      },
      log: r.log.map((turn) => turn.map((list) => list.map((o) => ({ ...o })))),
      hashes: r.hashes.slice(),
    };
    if (r.endlessAt && r.endlessAt.length > 0) exp.endlessAt = r.endlessAt.slice();
    return { ok: true, export: exp };
  }

  serialize(): { room: RoomState; game: Game | null } {
    return { room: this.room, game: this.game };
  }

  seatOf(playerId: string): number {
    return this.room.seats.findIndex((s) => s.playerId === playerId);
  }

  /** Public Ready and presence status for every seat in the running match. */
  seatStatuses(): SeatStatus[] {
    const r = this.room;
    return r.seats
      .map((s, i) => ({ s, p: r.playerOf[i] }))
      .filter((x) => x.p >= 0)
      .map(({ s, p }) => ({
        kind: s.kind,
        name: s.name,
        house: s.house,
        ready: s.kind === 'ai' ? true : !!this.room.ready[p],
        connected: s.kind === 'ai' ? true : s.connected,
      }));
  }

  /** The player indices of human seats, whose Ready the turn waits for. */
  private humanPlayers(): number[] {
    const out: number[] = [];
    this.room.seats.forEach((s, i) => {
      if (s.kind === 'human' && this.room.playerOf[i] >= 0) out.push(this.room.playerOf[i]);
    });
    return out;
  }

  /** The full state message for one receiver. Always the CURRENT turn, with its own attached latest summary. */
  stateFor(playerId: string): ServerMsg[] {
    const g = this.game;
    if (!g) return [];
    const seat = this.seatOf(playerId);
    const player = seat >= 0 ? this.room.playerOf[seat] : -1;
    const own: OwnSeat | null =
      player >= 0
        ? { draft: this.room.drafts[player].orders, revision: this.room.drafts[player].revision, ready: !!this.room.ready[player], epoch: this.room.epochs[player] }
        : null;
    return [
      {
        t: 'state',
        turn: g.turn,
        phase: g.phase,
        game: g,
        hash: stateHash(g),
        summary: this.room.summary,
        own,
        seats: this.seatStatuses(),
        player,
      },
    ];
  }

  // ── Internals ──

  private nameAis(): void {
    let k = 0;
    for (const s of this.room.seats) {
      if (s.kind === 'ai') {
        s.persona = AI_ORDER[k++ % AI_ORDER.length];
        s.name = AI_PERSONAS[s.persona].name;
      } else if (s.kind === 'open') {
        s.persona = null;
        s.name = '';
      }
    }
  }

  private lobbyAll(): Outbound {
    return { to: '*', msg: { t: 'lobby', lobby: this.lobby() } };
  }

  private seatsAll(): Outbound {
    return { to: '*', msg: { t: 'seats', turn: this.game?.turn ?? 0, seats: this.seatStatuses() } };
  }

  private migrateHost(): void {
    const r = this.room;
    const cur = r.seats[r.host];
    if (cur && cur.kind === 'human' && cur.connected) return;
    const next = r.seats.findIndex((s) => s.kind === 'human' && s.connected);
    if (next >= 0) r.host = next;
  }

  private resetTurnState(): void {
    const n = this.game?.players.length ?? 0;
    this.room.drafts = Array.from({ length: n }, () => ({ orders: [], revision: 0 }));
    this.room.ready = Array.from({ length: n }, () => false);
    this.room.epochs = Array.from({ length: n }, () => 0);
  }

  private startMatch(): void {
    const r = this.room;
    const players: NonNullable<RoomState['config']>['players'] = [];
    r.playerOf = [-1, -1, -1, -1];
    r.seats.forEach((s, i) => {
      if (s.kind === 'open') return;
      r.playerOf[i] = players.length;
      players.push({ name: s.name, house: s.house, kind: s.kind === 'human' ? 'human' : 'ai', persona: s.persona });
    });
    r.matchNo++;
    const config = { seed: (r.seed + r.matchNo * 7919) >>> 0, mode: r.mode, players };
    r.config = config;
    this.game = createGame(config);
    r.status = 'playing';
    r.lastResolved = 0;
    r.summary = null;
    r.summaries = [];
    r.log = [];
    r.hashes = [];
    r.endlessAt = [];
    r.exportVersion = MATCH_EXPORT_VERSION;
    this.resetTurnState();
  }

  // ── Connections ──

  join(playerId: string | null | undefined, name: string | undefined, newId: () => string): JoinResult {
    const r = this.room;
    let seat = playerId ? this.seatOf(playerId) : -1;
    let id = playerId ?? '';
    if (seat >= 0) {
      r.seats[seat].connected = true;
      if (name !== undefined && r.status === 'lobby') r.seats[seat].name = cleanName(name, r.seats[seat].name);
    } else {
      id = newId();
      if (r.status === 'lobby') {
        seat = r.seats.findIndex((s) => s.kind === 'open');
        if (seat < 0) seat = r.seats.findIndex((s) => s.kind === 'ai');
        if (seat >= 0) {
          const s = r.seats[seat];
          s.kind = 'human';
          s.playerId = id;
          s.connected = true;
          s.persona = null;
          s.name = cleanName(name, `Merchant ${seat + 1}`);
          this.nameAis();
        }
      }
      if (seat < 0) this.spectators.add(id);
    }
    this.migrateHost();
    const player = seat >= 0 ? r.playerOf[seat] : -1;
    const out: Outbound[] = [{ to: id, msg: { t: 'welcome', playerId: id, seat, player, lobby: this.lobby() } }, this.lobbyAll()];
    if (r.status !== 'lobby') {
      out.push(...this.stateFor(id).map((msg) => ({ to: id, msg })));
      out.push(this.seatsAll());
    }
    return { playerId: id, seat, out };
  }

  disconnect(playerId: string): Outbound[] {
    const r = this.room;
    if (this.spectators.delete(playerId)) return [];
    const seat = this.seatOf(playerId);
    if (seat < 0) return [];
    const s = r.seats[seat];
    s.connected = false;
    if (r.status === 'lobby') {
      s.kind = s.aiFill ? 'ai' : 'open';
      s.playerId = null;
      this.nameAis();
    }
    this.migrateHost();
    return r.status === 'lobby' ? [this.lobbyAll()] : [this.lobbyAll(), this.seatsAll()];
  }

  // ── Messages ──

  handle(playerId: string, msg: ClientMsg): Outbound[] {
    const r = this.room;
    const seat = this.seatOf(playerId);
    const err = (code: import('./protocol').ErrorCode, message: string, extra: { turn?: number; revision?: number; epoch?: number } = {}): Outbound[] => [
      { to: playerId, msg: { t: 'error', code, message, ...extra } },
    ];
    if (msg.t === 'ping') return [{ to: playerId, msg: { t: 'pong', at: msg.at } }];
    if (seat < 0) return err('spectator', 'Spectators cannot act');
    const isHost = seat === r.host;
    const me = r.seats[seat];
    switch (msg.t) {
      case 'hello':
        return [];
      case 'lobby': {
        if (r.status !== 'lobby') return err('lobby', 'The match has already started');
        if (msg.name !== undefined) me.name = cleanName(msg.name, me.name);
        if (msg.house !== undefined) {
          if (!Number.isInteger(msg.house) || msg.house < 0 || msg.house >= HOUSES.length) return err('lobby', 'Unknown House');
          const other = r.seats.find((s) => s !== me && s.house === msg.house);
          if (other && other.kind === 'human') return err('lobby', 'That House is taken');
          if (other) other.house = me.house;
          me.house = msg.house;
        }
        return [this.lobbyAll()];
      }
      case 'seat': {
        if (!isHost) return err('host', 'Only the host fills seats');
        if (r.status !== 'lobby') return err('lobby', 'The match has already started');
        const s = r.seats[msg.seat];
        if (!s) return err('lobby', 'No such seat');
        if (s.kind === 'human') return err('lobby', 'That seat is taken');
        s.aiFill = msg.ai;
        s.kind = msg.ai ? 'ai' : 'open';
        this.nameAis();
        return [this.lobbyAll()];
      }
      case 'aifill': {
        if (!isHost) return err('host', 'Only the host fills seats');
        if (r.status !== 'lobby') return err('lobby', 'The match has already started');
        for (const s of r.seats) {
          s.aiFill = msg.on;
          if (s.kind !== 'human') s.kind = msg.on ? 'ai' : 'open';
        }
        this.nameAis();
        return [this.lobbyAll()];
      }
      case 'mode': {
        if (!isHost) return err('host', 'Only the host sets the match length');
        if (r.status !== 'lobby') return err('lobby', 'The match has already started');
        r.mode = msg.mode;
        return [this.lobbyAll()];
      }
      case 'start': {
        if (!isHost) return err('host', 'Only the host starts the match');
        if (r.status !== 'lobby') return err('lobby', 'The match has already started');
        if (r.seats.filter((s) => s.kind !== 'open').length < 2) return err('lobby', 'Add an AI rival or invite a player first');
        this.startMatch();
        return this.afterStart();
      }
      case 'rematch': {
        if (!isHost) return err('host', 'Only the host calls a rematch');
        if (r.status !== 'ended') return err('lobby', 'No finished match to replay');
        this.startMatch();
        return this.afterStart();
      }
      case 'endless': {
        if (!isHost) return err('host', 'Only the host extends the match');
        if (!this.game || r.status !== 'ended') return err('notPlaying', 'The match is still running');
        const next = continueEndless(this.game);
        if (!next) return err('notPlaying', 'The match is still running');
        this.game = next;
        (r.endlessAt ??= []).push(r.log.length);
        r.status = 'playing';
        r.mode = 'endless';
        this.resetTurnState();
        return [this.lobbyAll(), ...this.broadcastState()];
      }
      case 'draft':
        return this.onDraft(playerId, seat, msg);
      case 'ready':
        return this.onReady(playerId, seat, msg);
      case 'cancelReady':
        return this.onCancel(playerId, seat, msg);
      default:
        return err('malformed', 'Unknown message');
    }
  }

  private broadcastState(): Outbound[] {
    const out: Outbound[] = [];
    for (const s of this.room.seats) if (s.playerId) out.push(...this.stateFor(s.playerId).map((msg) => ({ to: s.playerId!, msg })));
    for (const id of this.spectators) out.push(...this.stateFor(id).map((msg) => ({ to: id, msg })));
    return out;
  }

  private afterStart(): Outbound[] {
    const r = this.room;
    const out: Outbound[] = [this.lobbyAll()];
    r.seats.forEach((s, i) => {
      if (s.kind === 'human' && s.playerId) out.push({ to: s.playerId, msg: { t: 'welcome', playerId: s.playerId, seat: i, player: r.playerOf[i], lobby: this.lobby() } });
    });
    out.push(...this.broadcastState());
    return out;
  }

  /** The one reply to anything naming a turn other than the current planning turn. */
  private offTurn(playerId: string): Outbound[] {
    return this.stateFor(playerId).map((msg) => ({ to: playerId, msg }));
  }

  private planning(): boolean {
    return this.room.status === 'playing' && !!this.game && this.game.phase === 'planning';
  }

  private onDraft(playerId: string, seat: number, msg: Extract<ClientMsg, { t: 'draft' }>): Outbound[] {
    const r = this.room;
    const g = this.game;
    const player = r.playerOf[seat];
    const err = (code: import('./protocol').ErrorCode, message: string, extra: { turn?: number; revision?: number; epoch?: number } = {}): Outbound[] => [
      { to: playerId, msg: { t: 'error', code, message, ...extra } },
    ];
    if (!g || !this.planning() || player < 0) return err('notPlaying', 'The match is not running');
    if (msg.turn !== g.turn) return err('offTurnDraft', `Turn ${msg.turn} is not the current turn`, { turn: g.turn });
    if (r.ready[player]) return err('readyLocked', 'Cancel Ready before editing your draft', { turn: g.turn, revision: r.drafts[player].revision, epoch: r.epochs[player] });
    const d = r.drafts[player];
    if (msg.revision <= d.revision) return [{ to: playerId, msg: { t: 'draftAck', turn: g.turn, revision: d.revision } }];
    d.orders = msg.orders;
    d.revision = msg.revision;
    return [{ to: playerId, msg: { t: 'draftAck', turn: g.turn, revision: d.revision } }];
  }

  private onReady(playerId: string, seat: number, msg: Extract<ClientMsg, { t: 'ready' }>): Outbound[] {
    const r = this.room;
    const g = this.game;
    const player = r.playerOf[seat];
    if (!g || player < 0) return [{ to: playerId, msg: { t: 'error', code: 'notPlaying', message: 'The match is not running' } }];
    if (!this.planning() || msg.turn !== g.turn) return this.offTurn(playerId);
    const ack = (): Outbound[] => [{ to: playerId, msg: { t: 'readyAck', turn: g.turn, ready: r.ready[player], epoch: r.epochs[player] } }];
    // A duplicate, delayed or replayed Ready never changes anything.
    if (msg.epoch !== r.epochs[player] || r.ready[player]) return ack();
    const d = r.drafts[player];
    if (msg.revision !== d.revision) {
      return [{ to: playerId, msg: { t: 'error', code: 'staleDraft', message: 'Draft not saved yet — Ready not recorded', turn: g.turn, revision: d.revision, epoch: r.epochs[player] } }];
    }
    const block = readyBlock(g, player, d.orders);
    if (block) return [{ to: playerId, msg: { t: 'error', code: 'needCharter', message: block, turn: g.turn, revision: d.revision, epoch: r.epochs[player] } }];
    r.ready[player] = true;
    r.epochs[player] += 1;
    const out: Outbound[] = ack();
    if (this.humanPlayers().every((p) => r.ready[p])) return [...out, ...this.resolveNow()];
    out.push(this.seatsAll());
    return out;
  }

  private onCancel(playerId: string, seat: number, msg: Extract<ClientMsg, { t: 'cancelReady' }>): Outbound[] {
    const r = this.room;
    const g = this.game;
    const player = r.playerOf[seat];
    if (!g || player < 0) return [{ to: playerId, msg: { t: 'error', code: 'notPlaying', message: 'The match is not running' } }];
    if (!this.planning() || msg.turn !== g.turn) return this.offTurn(playerId);
    const ack = (): Outbound[] => [{ to: playerId, msg: { t: 'readyAck', turn: g.turn, ready: r.ready[player], epoch: r.epochs[player] } }];
    if (msg.epoch !== r.epochs[player] || !r.ready[player]) return ack();
    r.ready[player] = false;
    r.epochs[player] += 1;
    return [...ack(), this.seatsAll()];
  }

  /** Resolve the current turn exactly once, then start the next planning phase with everything cleared. */
  private resolveNow(): Outbound[] {
    const r = this.room;
    const g = this.game!;
    if (g.turn <= r.lastResolved) return []; // guarded by the stored last resolved turn
    const drafts = g.players.map((_, i) => r.drafts[i]?.orders ?? []);
    const orders = canonicalOrders(g, drafts);
    const res = resolveTurn(g, orders);
    r.log.push(res.committed);
    r.hashes.push(stateHash(res.game));
    r.lastResolved = g.turn;
    this.game = res.game;
    r.summary = res.summary;
    r.summaries.push(res.summary);
    if (r.summaries.length > SUMMARY_KEEP) r.summaries.shift();
    if (res.game.phase === 'ended') r.status = 'ended';
    this.resetTurnState();
    const seats = this.seatStatuses();
    const out: Outbound[] = [
      { to: '*', msg: { t: 'resolved', turn: res.game.turn, phase: res.game.phase, game: res.game, hash: stateHash(res.game), summary: res.summary, seats } },
    ];
    if (r.status === 'ended') out.push(this.lobbyAll());
    return out;
  }
}

export { shortHash };
