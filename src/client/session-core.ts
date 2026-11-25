// RoomClient: the transport-free, DOM-free reconciliation core of a room session.
//
// It holds ONE readiness value for the seat (turn, ready flag, epoch) plus the local draft, and
// reconciles every authority message by turn first (newer / older / same) as DESIGN.md
// "Client sessions" requires. It never computes a turn locally: worlds arrive only in
// `resolved` and `state` messages. The session wires `send` to a WebSocket and calls
// open()/close()/receive(); tests drive it directly with scripted messages.
import { SUMMARY_KEEP } from '../shared/constants';
import { pruneDraft, queueOrder, readyBlock, reorderDraft, undoOrder } from '../shared/orders';
import type { ClientMsg, LobbyView, SeatStatus, ServerMsg } from '../shared/protocol';
import type { Game, Order, TurnSummary } from '../shared/types';
import type { EndTurnState, StatusLine } from './contracts';

export interface DraftCache {
  turn: number;
  revision: number;
  orders: Order[];
  matchNo: number;
}

export interface Notice {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface RoomClientOptions {
  /** Deliver a message to the authority. Called only while the connection is synced. */
  send: (msg: ClientMsg) => void;
  /** The locally cached draft from a previous page life (keyed by turn and revision), if any. */
  cache?: DraftCache | null;
  /** Persist (or clear with null) the locally cached draft. */
  onCache?: (c: DraftCache | null) => void;
}

export type EditResult = { ok: true } | { ok: false; reason: string };

const STALE_TEXT = 'Draft not saved yet — Ready not recorded';
const maxNotices = 6;

export class RoomClient {
  // ── The authoritative world (applied exactly once per turn) ──
  game: Game | null = null;
  hash = '';
  summary: TurnSummary | null = null;
  summaries: TurnSummary[] = [];
  /** Bumps once each time a NEWER turn's world+summary is applied after a world was already held. */
  resolutions = 0;
  turn = 0;
  phase: 'planning' | 'ended' = 'planning';
  seats: SeatStatus[] = [];

  // ── Identity and lobby ──
  seat = -1; // room seat
  player = -1; // player index in the running match
  lobby: LobbyView | null = null;
  matchNo = -1;

  // ── The seat's private state for the held turn ──
  draft: Order[] = [];
  revision = 0;
  ackedRevision = 0;
  /** The acknowledged readiness value: Ready flag and epoch for `turn`. */
  ready = false;
  epoch = 0;

  // ── Transient ──
  notices: Notice[] = [];
  pruned = '';
  failure = '';
  /** Pressed Ready / Cancel Ready and still waiting for the authority's answer (never retried). */
  awaiting: 'ready' | 'cancel' | null = null;
  charterBlocked = false;
  synced = false;
  everSynced = false;
  private joining = false;
  private noticeN = 0;
  private cache: DraftCache | null;

  constructor(private opts: RoomClientOptions) {
    this.cache = opts.cache ?? null;
  }

  // ───────────────────────────── Connection ─────────────────────────────

  /** The socket opened: the next `state` is a join/reconnect state. */
  open(): void {
    this.joining = true;
    this.synced = false;
    this.awaiting = null; // an unacknowledged Ready / Cancel Ready is never retried
  }

  close(): void {
    this.synced = false;
    this.joining = false;
    this.awaiting = null;
  }

  fail(text: string): void {
    this.failure = text;
    this.synced = false;
  }

  /** The turn to present as `lastTurn` on hello (0 = none). */
  helloTurn(): number {
    return this.game ? this.turn : (this.cache?.turn ?? 0);
  }

  // ───────────────────────────── Incoming ─────────────────────────────

  receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.seat = msg.seat;
        this.player = msg.player;
        this.setLobby(msg.lobby);
        if (msg.lobby.status === 'lobby' && !this.game) {
          this.synced = true;
          this.everSynced = true;
          this.joining = false;
        }
        break;
      case 'lobby':
        this.setLobby(msg.lobby);
        break;
      case 'state':
        this.onState(msg);
        break;
      case 'resolved':
        this.onResolved(msg);
        break;
      case 'seats':
        if (this.game && msg.turn === this.turn) this.seats = msg.seats;
        break;
      case 'draftAck':
        if (!this.game || msg.turn !== this.turn) return; // older or newer turn: ignored entirely
        this.ackedRevision = Math.max(this.ackedRevision, Math.min(msg.revision, this.revision));
        break;
      case 'readyAck':
        if (!this.game || msg.turn !== this.turn) return;
        if (msg.epoch < this.epoch) return; // late, superseded reply
        this.ready = msg.ready;
        this.epoch = msg.epoch;
        this.awaiting = null;
        // A Cancel Ready that reopens editing: resend any local edits the authority has not stored.
        if (!this.ready && this.revision > this.ackedRevision) this.sendDraft();
        break;
      case 'error':
        this.onError(msg);
        break;
      case 'pong':
        break;
    }
  }

  private setLobby(l: LobbyView): void {
    if (this.matchNo >= 0 && l.matchNo > this.matchNo) this.resetMatch();
    this.matchNo = l.matchNo;
    if (this.cache && this.cache.matchNo !== l.matchNo) this.cache = null;
    this.lobby = l;
  }

  /** A new match began in this room (rematch): nothing from the old match carries over. */
  private resetMatch(): void {
    this.game = null;
    this.hash = '';
    this.summary = null;
    this.summaries = [];
    this.turn = 0;
    this.phase = 'planning';
    this.seats = [];
    this.draft = [];
    this.revision = 0;
    this.ackedRevision = 0;
    this.ready = false;
    this.epoch = 0;
    this.awaiting = null;
    this.charterBlocked = false;
    this.pruned = '';
    this.cache = null;
    this.opts.onCache?.(null);
  }

  private adoptWorld(m: { turn: number; phase: 'planning' | 'ended'; game: Game; hash: string; summary: TurnSummary | null; seats: SeatStatus[] }): void {
    this.game = m.game;
    this.hash = m.hash;
    this.turn = m.turn;
    this.phase = m.phase;
    this.seats = m.seats;
    if (m.summary) {
      const last = this.summaries[this.summaries.length - 1];
      if (last && last.to !== m.summary.from) this.summaries = []; // keep only a contiguous run
      this.summaries.push(m.summary);
      while (this.summaries.length > SUMMARY_KEEP) this.summaries.shift();
      this.summary = m.summary;
    } else {
      this.summary = null;
      this.summaries = [];
    }
    this.pruned = '';
  }

  private onResolved(m: Extract<ServerMsg, { t: 'resolved' }>): void {
    const hadWorld = this.game !== null;
    if (hadWorld && m.turn <= this.turn) return; // same or older turn: ignored entirely
    const cached = hadWorld ? null : this.cache;
    this.adoptWorld(m);
    this.resolutions++;
    // `resolved` carries no private data: the seat starts the new turn Planning at epoch 0, empty draft.
    this.draft = [];
    this.revision = 0;
    this.ackedRevision = 0;
    this.ready = false;
    this.epoch = 0;
    this.awaiting = null;
    this.charterBlocked = false;
    this.cache = null;
    this.persistCache();
    if (cached && cached.turn > 0 && cached.turn < m.turn) this.offlineNotice(cached.turn);
  }

  private offlineNotice(oldTurn: number): void {
    this.note(`Turn ${oldTurn} resolved while you were offline — unsent edits discarded`, 'info');
  }

  private onState(m: Extract<ServerMsg, { t: 'state' }>): void {
    this.synced = true;
    this.everSynced = true;
    const joining = this.joining;
    this.joining = false;
    const hadWorld = this.game !== null;
    if (hadWorld && m.turn < this.turn) return; // older turn: ignored entirely
    this.player = m.player;

    if (!hadWorld || m.turn > this.turn) {
      // Newer-turn state: swap in world and summary together, once.
      const cached = hadWorld ? null : this.cache;
      const heldTurn = hadWorld ? this.turn : (cached?.turn ?? 0);
      this.adoptWorld(m);
      if (hadWorld) this.resolutions++;
      this.awaiting = null;
      this.charterBlocked = false;
      this.adoptOwn(m, cached && cached.turn === m.turn ? cached : null);
      if (heldTurn > 0 && m.turn > heldTurn) {
        if (joining || !hadWorld) this.offlineNotice(heldTurn);
        else this.note(`Turn ${heldTurn} already resolved — showing Turn ${m.turn}`, 'info');
      }
      return;
    }

    // Same turn: never re-applies the world or reopens the Turn Delta.
    this.seats = m.seats;
    if (m.phase !== this.phase || m.game.endless !== this.game!.endless) {
      // The match went from ended back to planning (Endless): a genuinely new world for the same turn number.
      this.game = m.game;
      this.hash = m.hash;
      this.phase = m.phase;
      this.awaiting = null;
      this.adoptOwn(m, null);
      return;
    }
    const own = m.own;
    if (!own) return;
    if (own.epoch < this.epoch) return; // superseded reply
    if (own.epoch > this.epoch) this.awaiting = null;
    this.ready = own.ready;
    this.epoch = own.epoch;
    if (own.revision < this.revision && !own.ready) {
      // The authority lags behind our edits: resend and wait for the matching draftAck.
      this.ackedRevision = own.revision;
      this.sendDraft();
    } else {
      this.draft = own.draft;
      this.revision = own.revision;
      this.ackedRevision = own.revision;
      this.charterBlocked = false;
      this.persistCache();
    }
  }

  /** Take the seat's own private view from a full state (or the spectator's empty one). */
  private adoptOwn(m: Extract<ServerMsg, { t: 'state' }>, cached: DraftCache | null): void {
    const own = m.own;
    if (!own) {
      this.draft = [];
      this.revision = 0;
      this.ackedRevision = 0;
      this.ready = false;
      this.epoch = 0;
      this.persistCache();
      return;
    }
    this.ready = own.ready;
    this.epoch = own.epoch;
    if (cached && cached.revision > own.revision && !own.ready) {
      this.draft = cached.orders;
      this.revision = cached.revision;
      this.ackedRevision = own.revision;
      this.persistCache();
      this.sendDraft();
    } else {
      this.draft = own.draft;
      this.revision = own.revision;
      this.ackedRevision = own.revision;
      this.persistCache();
    }
    this.cache = null;
  }

  private onError(m: Extract<ServerMsg, { t: 'error' }>): void {
    if (m.turn !== undefined && (!this.game || m.turn !== this.turn)) return; // older or newer turn: ignored
    if (m.epoch !== undefined && m.epoch < this.epoch) return; // superseded
    switch (m.code) {
      case 'staleDraft':
        this.awaiting = null;
        if (m.epoch !== undefined) {
          this.ready = false;
          this.epoch = m.epoch;
        }
        this.note(STALE_TEXT, 'error');
        // Wait for the draftAck of the resent draft before Ready is available again.
        this.ackedRevision = Math.max(0, Math.min(m.revision ?? this.revision - 1, this.revision - 1));
        this.sendDraft();
        break;
      case 'needCharter':
        this.awaiting = null;
        if (m.epoch !== undefined) {
          this.ready = false;
          this.epoch = m.epoch;
        }
        this.charterBlocked = true;
        this.note(m.message, 'error');
        break;
      case 'readyLocked':
        this.awaiting = null;
        if (m.epoch !== undefined) {
          this.ready = true;
          this.epoch = m.epoch;
        }
        if (m.revision !== undefined) this.ackedRevision = Math.min(m.revision, this.revision);
        this.note(m.message, 'error');
        break;
      case 'offTurnDraft':
        break; // names a different turn than the one held: handled by the turn check above
      default:
        this.awaiting = null;
        this.note(m.message, 'error');
    }
  }

  // ───────────────────────────── Drafts ─────────────────────────────

  private editBlock(): string | null {
    if (!this.game) return 'The match has not started';
    if (this.player < 0) return 'Spectators cannot plan';
    if (this.phase === 'ended') return 'The match is over';
    if (this.ready) return 'Cancel Ready to edit your draft';
    if (this.awaiting) return 'Waiting for the authority to record Ready';
    return null;
  }

  private commit(orders: Order[]): void {
    this.draft = orders;
    this.revision++;
    this.charterBlocked = false;
    this.persistCache();
    this.sendDraft();
  }

  private sendDraft(): void {
    if (!this.game || !this.synced || this.player < 0) return;
    this.opts.send({ t: 'draft', turn: this.turn, revision: this.revision, orders: this.draft });
  }

  private persistCache(): void {
    const keep = this.game && this.player >= 0 && this.phase === 'planning' && this.draft.length > 0;
    this.opts.onCache?.(keep ? { turn: this.turn, revision: this.revision, orders: this.draft, matchNo: this.matchNo } : null);
  }

  queue(order: Order): EditResult {
    const why = this.editBlock();
    if (why) return { ok: false, reason: why };
    const r = queueOrder(this.game!, this.player, this.draft, order);
    if (!r.ok) return r;
    this.pruned = '';
    this.commit(r.draft);
    return { ok: true };
  }

  undo(index: number): void {
    if (this.editBlock() || index < 0 || index >= this.draft.length) return;
    const r = undoOrder(this.game!, this.player, this.draft, index);
    const n = r.removed.length;
    this.pruned = n === 0 ? '' : `Removed ${n} dependent order${n === 1 ? '' : 's'}`;
    this.commit(r.kept);
  }

  clear(): void {
    if (this.editBlock() || this.draft.length === 0) return;
    this.pruned = '';
    this.commit([]);
  }

  reorder(from: number, to: number): void {
    if (this.editBlock() || from === to || from < 0 || from >= this.draft.length) return;
    const r = reorderDraft(this.game!, this.player, this.draft, from, to);
    if (r.removed.length > 0) {
      this.note('Cannot reorder: later orders depend on this one', 'error');
      return;
    }
    this.pruned = '';
    this.commit(r.kept);
  }

  // ───────────────────────────── End Turn / Ready ─────────────────────────────

  /** Press End Turn: Ready, or Cancel Ready, naming the held turn and the held epoch. Never retried. */
  pressEndTurn(): void {
    if (!this.endTurn().enabled || !this.game) return;
    if (this.ready) {
      this.awaiting = 'cancel';
      this.opts.send({ t: 'cancelReady', turn: this.turn, epoch: this.epoch });
    } else {
      this.awaiting = 'ready';
      this.opts.send({ t: 'ready', turn: this.turn, revision: this.revision, epoch: this.epoch });
    }
  }

  // ───────────────────────────── Derived ─────────────────────────────

  /** Opponents (seats other than mine) not yet Ready. */
  waitingOn(): number {
    return this.seats.filter((s, i) => i !== this.player && !s.ready).length;
  }

  /** My Ready is acknowledged and nobody else is still planning: the authority is resolving. */
  resolving(): boolean {
    return !!this.game && this.player >= 0 && this.ready && this.phase === 'planning' && this.waitingOn() === 0;
  }

  status(): StatusLine {
    if (this.failure) return { text: this.failure, tone: 'error' };
    if (!this.synced) return { text: this.everSynced ? 'Reconnecting…' : 'Connecting…', tone: 'reconnect' };
    if (!this.game) {
      const l = this.lobby;
      if (l && l.status === 'lobby') return { text: l.host === this.seat ? 'Set up the table, then start' : 'Waiting for the host to start', tone: 'info' };
      return { text: 'Starting…', tone: 'info' };
    }
    if (this.phase === 'ended') return { text: 'Match over', tone: 'info' };
    if (this.player < 0) return { text: 'Room is full — watching as spectator', tone: 'info' };
    if (this.ready) {
      if (this.resolving()) return { text: `Resolving Turn ${this.turn}…`, tone: 'wait' };
      const n = this.waitingOn();
      return { text: n === 1 ? 'Waiting for opponent…' : `Waiting for ${n} opponents…`, tone: 'wait' };
    }
    return { text: 'Your turn', tone: 'info' };
  }

  endTurn(): EndTurnState {
    const off = (label: string, kind: 'end' | 'cancel' = 'end'): EndTurnState => ({ label, enabled: false, kind });
    if (this.failure) return off('Unavailable');
    if (!this.synced) return off(this.everSynced ? 'Reconnecting…' : 'Connecting…');
    if (!this.game) return off('Waiting to start');
    if (this.phase === 'ended') return off('Match over');
    if (this.player < 0) return off('Spectating');
    if (this.ready) return this.resolving() ? off(`Resolving Turn ${this.turn}…`, 'cancel') : { label: 'Cancel Ready', enabled: true, kind: 'cancel' };
    const block = readyBlock(this.game, this.player, this.draft);
    if (block || this.charterBlocked) return off(block ?? 'Choose a Charter');
    if (this.revision !== this.ackedRevision) return off('Saving draft…');
    return { label: 'End Turn', enabled: true, kind: 'end' };
  }

  plan(): ReturnType<typeof pruneDraft>['plan'] | null {
    if (!this.game || this.player < 0 || this.phase !== 'planning') return null;
    return pruneDraft(this.game, this.player, this.draft).plan;
  }

  // ───────────────────────────── Notices ─────────────────────────────

  note(text: string, tone: 'info' | 'error'): void {
    this.notices.push({ id: ++this.noticeN, text, tone });
    while (this.notices.length > maxNotices) this.notices.shift();
  }

  dropNotice(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
  }
}
