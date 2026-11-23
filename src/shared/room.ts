// RoomCore: the multiplayer room as a pure state machine. The Durable Object owns sockets,
// timers and storage; everything that can be decided without them is decided here.
import { advance } from './ai';
import { AI_ORDER, AI_PERSONAS, HOST_SPEEDS, HOUSES } from './constants';
import { SnapEncoder, type ClientMsg, type LobbyView, type ServerMsg } from './protocol';
import { applyCommand, continueEndless, councilBeat, createGame, upgradeState } from './sim';
import type { AiPersona, GameState, MatchMode, PlayerSetup } from './types';

export interface Seat {
  kind: 'open' | 'human' | 'ai';
  name: string;
  house: number;
  playerId: string | null;
  connected: boolean;
  persona: AiPersona | null;
  aiFill: boolean; // what an empty seat becomes
}

export interface RoomState {
  code: string;
  status: 'lobby' | 'playing' | 'ended';
  host: number;
  mode: MatchMode;
  speed: number;
  matchNo: number;
  seed: number;
  seats: Seat[];
  playerOf: number[]; // seat → player index in the running match, or -1
  acc: number; // fractional ticks owed at paces like 1.5×
}

/** A message for one player (by playerId) or for everyone ('*'). */
export interface Outbound {
  to: string;
  msg: ServerMsg;
}

export interface JoinResult {
  playerId: string;
  seat: number; // -1 for a spectator
  out: Outbound[];
}

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const SPEEDS = HOST_SPEEDS;

export function makeRoomCode(random: () => number): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length];
  return code;
}

export const isRoomCode = (code: string): boolean => /^[A-Z]{4}$/.test(code);

export function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  // Strip control characters, collapse whitespace, cap the length.
  const s = Array.from(raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 16).join('').trim();
  return s || fallback;
}

export class RoomCore {
  room: RoomState;
  game: GameState | null;
  private encoder = new SnapEncoder();
  private spectators = new Set<string>();

  constructor(code: string, seed: number, restore?: { room: RoomState; game: GameState | null }) {
    if (restore) {
      this.room = { ...restore.room, acc: restore.room.acc ?? 0 };
      this.game = restore.game ? upgradeState(restore.game) : null;
      return;
    }
    this.room = {
      code,
      status: 'lobby',
      host: 0,
      mode: 'standard',
      speed: 1,
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
      acc: 0,
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
      speed: r.speed,
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
      quarter: this.game ? this.game.quarter : 0,
      era: this.game ? Math.min(4, this.game.quarter) : 0,
      council: !!this.game && this.game.phase === 'council',
      tick: this.game ? this.game.tick : 0,
      seats: this.lobby().seats,
    };
  }

  serialize(): { room: RoomState; game: GameState | null } {
    return { room: this.room, game: this.game };
  }

  /**
   * True while the room needs its 100 ms beat: a live match (or an Era Council counting down)
   * with a human watching.
   */
  get running(): boolean {
    return (
      this.room.status === 'playing' &&
      !!this.game &&
      this.game.phase !== 'ended' &&
      (this.room.seats.some((s) => s.kind === 'human' && s.connected) || this.spectators.size > 0)
    );
  }

  seatOf(playerId: string): number {
    return this.room.seats.findIndex((s) => s.playerId === playerId);
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

  private fullSnap(to: string): Outbound[] {
    return this.game ? [{ to, msg: this.encoder.encode(this.game, true, this.room.speed) }] : [];
  }

  private migrateHost(): void {
    const r = this.room;
    const cur = r.seats[r.host];
    if (cur && cur.kind === 'human' && cur.connected) return;
    const next = r.seats.findIndex((s) => s.kind === 'human' && s.connected);
    if (next >= 0) r.host = next;
  }

  private startMatch(): void {
    const r = this.room;
    const setups: PlayerSetup[] = [];
    r.playerOf = [-1, -1, -1, -1];
    r.seats.forEach((s, i) => {
      if (s.kind === 'open') return;
      r.playerOf[i] = setups.length;
      setups.push({ name: s.name, house: s.house, kind: s.kind, persona: s.persona });
    });
    r.matchNo++;
    this.game = createGame({ seed: (r.seed + r.matchNo * 7919) >>> 0, mode: r.mode, players: setups });
    r.status = 'playing';
    r.acc = 0;
    this.encoder.reset();
  }

  // ── Connections ──

  /** A socket says hello. Reconnects by playerId; otherwise takes the best free seat. */
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
    const out: Outbound[] = [
      { to: id, msg: { t: 'welcome', playerId: id, seat, player: seat >= 0 ? r.playerOf[seat] : -1, lobby: this.lobby() } },
      this.lobbyAll(),
    ];
    if (r.status !== 'lobby') out.push(...this.fullSnap(id));
    return { playerId: id, seat, out };
  }

  /** A socket went away. In the lobby the seat is released; in a match it is held for reconnect. */
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
    return [this.lobbyAll()];
  }

  // ── Messages ──

  handle(playerId: string, msg: ClientMsg): Outbound[] {
    const r = this.room;
    const seat = this.seatOf(playerId);
    const reject = (err: string): Outbound[] => [{ to: playerId, msg: { t: 'reject', err } }];
    if (msg.t === 'ping') return [{ to: playerId, msg: { t: 'pong', at: msg.at } }];
    if (seat < 0) return reject('Spectators cannot act');
    const isHost = seat === r.host;
    const me = r.seats[seat];
    switch (msg.t) {
      case 'hello':
        return [];
      case 'lobby': {
        if (r.status !== 'lobby') return reject('The match has already started');
        if (msg.name !== undefined) me.name = cleanName(msg.name, me.name);
        if (msg.house !== undefined) {
          if (!Number.isInteger(msg.house) || msg.house < 0 || msg.house >= HOUSES.length) return reject('Unknown House');
          const other = r.seats.find((s) => s !== me && s.house === msg.house);
          if (other && other.kind === 'human') return reject('That House is taken');
          if (other) other.house = me.house;
          me.house = msg.house;
        }
        return [this.lobbyAll()];
      }
      case 'seat': {
        if (!isHost) return reject('Only the host fills seats');
        if (r.status !== 'lobby') return reject('The match has already started');
        const s = r.seats[msg.seat];
        if (!s) return reject('No such seat');
        if (s.kind === 'human') return reject('That seat is taken');
        s.aiFill = msg.ai;
        s.kind = msg.ai ? 'ai' : 'open';
        this.nameAis();
        return [this.lobbyAll()];
      }
      case 'aifill': {
        // One click between "AI rivals fill the table" and a pure human duel.
        if (!isHost) return reject('Only the host fills seats');
        if (r.status !== 'lobby') return reject('The match has already started');
        for (const s of r.seats) {
          s.aiFill = msg.on;
          if (s.kind !== 'human') s.kind = msg.on ? 'ai' : 'open';
        }
        this.nameAis();
        return [this.lobbyAll()];
      }
      case 'mode': {
        if (!isHost) return reject('Only the host sets the match length');
        if (r.status !== 'lobby') return reject('The match has already started');
        r.mode = msg.mode;
        return [this.lobbyAll()];
      }
      case 'speed': {
        if (!isHost) return reject('Only the host sets the pace');
        if (!SPEEDS.includes(msg.speed)) return reject('Unknown pace');
        r.speed = msg.speed;
        return [this.lobbyAll()];
      }
      case 'start': {
        if (!isHost) return reject('Only the host starts the match');
        if (r.status !== 'lobby') return reject('The match has already started');
        if (r.seats.filter((s) => s.kind !== 'open').length < 2) return reject('Add an AI rival or invite a player first');
        this.startMatch();
        return this.afterStart();
      }
      case 'rematch': {
        if (!isHost) return reject('Only the host calls a rematch');
        if (r.status === 'lobby' || !this.game) return reject('No match to replay');
        this.startMatch();
        return this.afterStart();
      }
      case 'endless': {
        if (!isHost) return reject('Only the host extends the match');
        if (!this.game || !continueEndless(this.game)) return reject('The match is still running');
        r.status = 'playing';
        return [this.lobbyAll(), ...this.fullSnap('*')];
      }
      case 'cmd': {
        if (r.status !== 'playing' || !this.game) return reject('The match is not running');
        const player = r.playerOf[seat];
        if (player < 0) return reject('You are not seated in this match');
        const res = applyCommand(this.game, player, msg.cmd);
        return res.ok ? [] : reject(res.err ?? 'Rejected');
      }
      default:
        return reject('Unknown message');
    }
  }

  /** Player indices of the connected humans: the Houses an Era Council waits for. */
  councilVoters(): number[] {
    const r = this.room;
    const out: number[] = [];
    r.seats.forEach((s, i) => {
      if (s.kind === 'human' && s.connected && r.playerOf[i] >= 0) out.push(r.playerOf[i]);
    });
    return out;
  }

  private afterStart(): Outbound[] {
    const r = this.room;
    const out: Outbound[] = [this.lobbyAll()];
    // Everyone learns their player index for the new match.
    r.seats.forEach((s, i) => {
      if (s.kind === 'human' && s.playerId)
        out.push({ to: s.playerId, msg: { t: 'welcome', playerId: s.playerId, seat: i, player: r.playerOf[i], lobby: this.lobby() } });
    });
    out.push(...this.fullSnap('*'));
    return out;
  }

  /** One 100 ms beat of server time. Steps the simulation by the room pace and returns the broadcast. */
  step(): Outbound[] {
    const g = this.game;
    if (!g || !this.running) return [];
    if (g.phase === 'council') {
      // The Era Council runs on real time, whatever the pace: it closes when the countdown
      // ends (undecided Houses take their steward's pick) or once every connected human chose.
      councilBeat(g, this.councilVoters());
    } else {
      this.room.acc += this.room.speed;
      let n = Math.floor(this.room.acc);
      this.room.acc -= n;
      while (n-- > 0 && g.phase === 'playing') advance(g);
    }
    const out: Outbound[] = [{ to: '*', msg: this.encoder.encode(g, false, this.room.speed) }];
    g.fx = [];
    if (g.phase === 'ended' && this.room.status === 'playing') {
      this.room.status = 'ended';
      out.push(this.lobbyAll());
    }
    return out;
  }
}
