// Wire protocol between a browser and the room authority (one WebSocket per browser).
//
// Client → authority: hello, lobby controls, draft, ready, cancelReady, ping.
// Authority → client: welcome, lobby, state, draftAck, readyAck, seats, resolved, error, pong.
// A seat's draft, its revision and its readiness epoch travel only to that seat (draftAck,
// readyAck, error and its own state). seats, resolved and spectator state carry public data.
import { parseDraft } from './orders';
import type { AiPersona, Game, MatchMode, Order, TurnSummary } from './types';

export interface LobbySeat {
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
  matchNo: number;
  seats: LobbySeat[];
}

/** Public per-seat status: Ready flags and presence, never drafts or epochs. */
export interface SeatStatus {
  kind: 'open' | 'human' | 'ai';
  name: string;
  house: number;
  ready: boolean;
  connected: boolean;
}

/** A seat's own private view of its current turn. */
export interface OwnSeat {
  draft: Order[];
  revision: number;
  ready: boolean;
  epoch: number;
}

export type ErrorCode =
  | 'malformed'
  | 'hello'
  | 'spectator'
  | 'offTurnDraft'
  | 'staleDraft'
  | 'readyLocked'
  | 'needCharter'
  | 'notPlaying'
  | 'host'
  | 'lobby';

export type ClientMsg =
  | { t: 'hello'; playerId?: string; name?: string; lastTurn?: number }
  | { t: 'lobby'; name?: string; house?: number }
  | { t: 'seat'; seat: number; ai: boolean }
  | { t: 'aifill'; on: boolean }
  | { t: 'mode'; mode: MatchMode }
  | { t: 'start' }
  | { t: 'rematch' }
  | { t: 'endless' }
  | { t: 'draft'; turn: number; revision: number; orders: Order[] }
  | { t: 'ready'; turn: number; revision: number; epoch: number }
  | { t: 'cancelReady'; turn: number; epoch: number }
  | { t: 'ping'; at: number };

export type ServerMsg =
  | { t: 'welcome'; playerId: string; seat: number; player: number; lobby: LobbyView }
  | { t: 'lobby'; lobby: LobbyView }
  | {
      t: 'state';
      turn: number;
      phase: 'planning' | 'ended';
      game: Game;
      hash: string;
      summary: TurnSummary | null;
      own: OwnSeat | null; // null for spectators
      seats: SeatStatus[];
      player: number; // the receiving seat's player index, or -1
    }
  | { t: 'draftAck'; turn: number; revision: number }
  | { t: 'readyAck'; turn: number; ready: boolean; epoch: number }
  | { t: 'seats'; turn: number; seats: SeatStatus[] }
  | { t: 'resolved'; turn: number; phase: 'planning' | 'ended'; game: Game; hash: string; summary: TurnSummary; seats: SeatStatus[] }
  | { t: 'error'; code: ErrorCode; message: string; turn?: number; revision?: number; epoch?: number }
  | { t: 'pong'; at: number };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 1e9;
const MODES: MatchMode[] = ['blitz', 'standard', 'endless'];

/** Strictly parse a client frame; null if it is not a well-formed message. */
export function parseClientMsg(raw: string | null): ClientMsg | null {
  if (!raw || raw.length > 64 * 1024) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  switch (m.t) {
    case 'hello':
      return {
        t: 'hello',
        playerId: typeof m.playerId === 'string' && m.playerId.length <= 64 ? m.playerId : undefined,
        name: typeof m.name === 'string' ? m.name.slice(0, 40) : undefined,
        lastTurn: isInt(m.lastTurn) ? m.lastTurn : undefined,
      };
    case 'lobby':
      return { t: 'lobby', name: typeof m.name === 'string' ? m.name.slice(0, 40) : undefined, house: isInt(m.house) ? m.house : undefined };
    case 'seat':
      return isInt(m.seat) && typeof m.ai === 'boolean' ? { t: 'seat', seat: m.seat, ai: m.ai } : null;
    case 'aifill':
      return typeof m.on === 'boolean' ? { t: 'aifill', on: m.on } : null;
    case 'mode':
      return typeof m.mode === 'string' && MODES.includes(m.mode as MatchMode) ? { t: 'mode', mode: m.mode as MatchMode } : null;
    case 'start':
    case 'rematch':
    case 'endless':
      return { t: m.t };
    case 'draft': {
      const orders = parseDraft(m.orders);
      return isInt(m.turn) && isInt(m.revision) && orders ? { t: 'draft', turn: m.turn, revision: m.revision, orders } : null;
    }
    case 'ready':
      return isInt(m.turn) && isInt(m.revision) && isInt(m.epoch) ? { t: 'ready', turn: m.turn, revision: m.revision, epoch: m.epoch } : null;
    case 'cancelReady':
      return isInt(m.turn) && isInt(m.epoch) ? { t: 'cancelReady', turn: m.turn, epoch: m.epoch } : null;
    case 'ping':
      return { t: 'ping', at: isInt(m.at) ? m.at : 0 };
    default:
      return null;
  }
}
