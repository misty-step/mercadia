// Session: the client's single source of truth for a match (solo, hotseat or network room).
//
// Solo and hotseat wrap LocalMatch (the same pure core the room authority runs). A room session
// is a WebSocket client around RoomClient (session-core.ts), which reconciles every authority
// message by turn, revision and readiness epoch. A room session never computes a turn locally.
import { actionsFor, createGame, stateHash } from '../shared/game';
import { LocalMatch } from '../shared/local';
import { parseDraft, pruneDraft, queueOrder, readyBlock, reorderDraft, undoOrder } from '../shared/orders';
import { INCOMPATIBLE_RULESET_MESSAGE, LEGACY_ROOM_MESSAGE } from '../shared/constants';
import type { ClientMsg, SeatStatus, ServerMsg } from '../shared/protocol';
import type { MatchExport } from '../shared/replay';
import type { Game, MatchMode, MatchConfig, Order } from '../shared/types';
import type { EndTurnState, Session, SessionOptions, SessionView, StatusLine } from './contracts';
import { RoomClient, type DraftCache, type Notice } from './session-core';
import { HEARTBEAT_MS, SeatToken, browserStores, type KV } from './seat-token';

const NOTICE_TTL_MS = 20000;
const PING_MS = 15000;
const DEAD_AFTER_MS = 40000;
const BACKOFF_FIRST_MS = 500;
const BACKOFF_MAX_MS = 8000;

let placeholder: Game | null = null;
/** The board shown before a room's match starts (the lobby has no world yet). */
function placeholderGame(): Game {
  placeholder ??= createGame({
    seed: 1,
    mode: 'standard',
    players: [
      { name: 'You', house: 0, kind: 'human', persona: null },
      { name: 'Rival', house: 1, kind: 'ai', persona: 'vesper' },
    ],
  });
  return placeholder;
}

const nullFn = (): void => {};

// ───────────────────────────── Shared plumbing ─────────────────────────────

abstract class Base implements Session {
  protected listeners = new Set<(v: SessionView) => void>();
  protected current!: SessionView;

  get view(): SessionView {
    return this.current;
  }

  subscribe(fn: (v: SessionView) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  protected abstract build(): SessionView;

  /** Rebuild the immutable view snapshot and tell subscribers. */
  protected emit(): void {
    this.current = this.build();
    for (const fn of [...this.listeners]) fn(this.current);
  }

  abstract queue(order: Order): { ok: true } | { ok: false; reason: string };
  abstract undo(index: number): void;
  abstract clear(): void;
  abstract reorder(from: number, to: number): void;
  abstract endTurn(): void;
  abstract beginTurn(): void;
  abstract continueEndless(): void;
  abstract rematch(): void;
  abstract leave(): void;
  abstract exportMatch(): MatchExport | null;
  abstract exportMatchAsync(): Promise<MatchExport | null>;
  get exportNotice(): string {
    return '';
  }
  abstract lobby: Session['lobby'];
}

const noLobby: Session['lobby'] = {
  setName: nullFn,
  setHouse: nullFn,
  setSeatAi: nullFn,
  setAiFill: nullFn,
  setMode: nullFn,
  start: nullFn,
};

// ───────────────────────────── Solo and hotseat ─────────────────────────────

class LocalSession extends Base {
  lobby = noLobby;
  private match: LocalMatch;
  private humans: number[];
  /** Index into `humans` of the seat planning now. */
  private cur = 0;
  private handoff: number | null = null;
  /** Hotseat: player index of the first seat of the next turn while the table reads the Turn Delta. */
  private tableDelta: number | null = null;
  private resolutions = 0;
  private notices: Notice[] = [];
  private noticeN = 0;
  private pruned = '';
  private revs: number[];

  constructor(private mode: 'solo' | 'hotseat', private config: MatchConfig) {
    super();
    this.match = new LocalMatch(config);
    this.humans = this.pickHumans();
    this.revs = this.match.game.players.map(() => 0);
    this.emit();
  }

  private pickHumans(): number[] {
    const all = this.match.game.players.flatMap((p, i) => (p.kind === 'human' ? [i] : []));
    if (all.length === 0) return [0];
    return this.mode === 'solo' ? [all[0]] : all;
  }

  private get seat(): number {
    return this.handoff ?? this.humans[this.cur];
  }

  private note(text: string): void {
    this.notices.push({ id: ++this.noticeN, text, tone: 'error' });
    while (this.notices.length > 6) this.notices.shift();
  }

  private seatStatuses(): SeatStatus[] {
    return this.match.game.players.map((p, i) => {
      const hi = this.humans.indexOf(i);
      const planning = this.handoff !== null ? this.humans.indexOf(this.handoff) : this.cur;
      // Hotseat: seats that have already planned this round read as done; AI seats always do.
      const ready = p.kind === 'ai' || (this.humans.length > 1 && hi >= 0 && hi < planning);
      return { kind: p.kind, name: p.name, house: p.house, ready, connected: true };
    });
  }

  protected build(): SessionView {
    const g = this.match.game;
    const seat = this.seat;
    const hidden = this.handoff !== null || this.tableDelta !== null;
    const ended = g.phase === 'ended';
    const draft = hidden ? [] : this.match.drafts[seat] ?? [];
    const plan = hidden || ended ? null : pruneDraft(g, seat, draft).plan;
    const player = g.players[seat];
    let status: StatusLine;
    let endTurn: EndTurnState;
    if (ended) {
      status = { text: 'Match over', tone: 'info' };
      endTurn = { label: 'Match over', enabled: false, kind: 'end' };
    } else if (this.tableDelta !== null) {
      // The table reads the Turn Delta first; no seat's plan is on screen.
      const next = g.players[this.tableDelta];
      status = { text: `Turn ${g.turn - 1} \u2192 ${g.turn} resolved \u00b7 Pass to ${next.name} next`, tone: 'info' };
      endTurn = { label: `Pass to ${next.name}`, enabled: true, kind: 'end' };
    } else if (hidden) {
      status = { text: `Pass to ${player.name}`, tone: 'info' };
      endTurn = { label: `Pass to ${player.name}`, enabled: false, kind: 'end' };
    } else {
      status = { text: 'Your turn', tone: 'info' };
      const block = readyBlock(g, seat, draft);
      endTurn = block ? { label: block, enabled: false, kind: 'end' } : { label: 'End Turn', enabled: true, kind: 'end' };
    }
    const rev = hidden ? 0 : this.revs[seat];
    return {
      mode: this.mode,
      game: g,
      hash: this.match.hash(),
      summary: this.match.summary,
      summaries: this.match.summaries.slice(),
      resolutions: this.resolutions,
      seat,
      draft: draft.slice(),
      revision: rev,
      ackedRevision: rev,
      plan,
      actions: plan ? { used: plan.actionsMax - plan.actions, max: plan.actionsMax } : { used: 0, max: hidden ? 0 : actionsFor(g, player) },
      projectedCash: plan ? plan.cash : player.cash,
      ready: false,
      status,
      endTurn,
      seats: this.seatStatuses(),
      notices: this.notices.slice(),
      pruned: this.pruned,
      handoff: this.handoff === null ? null : { player: this.handoff },
      tableDelta: this.tableDelta === null ? null : { next: this.tableDelta },
      roomCode: '',
      lobby: null,
      host: false,
      ended,
    };
  }

  private editable(): boolean {
    return this.handoff === null && this.tableDelta === null && this.match.game.phase !== 'ended';
  }

  private setDraft(orders: Order[]): void {
    const seat = this.seat;
    this.match.setDraft(seat, orders);
    this.revs[seat]++;
  }

  queue(order: Order): { ok: true } | { ok: false; reason: string } {
    if (!this.editable()) return { ok: false, reason: this.handoff !== null || this.tableDelta !== null ? 'Begin the turn first' : 'The match is over' };
    const r = queueOrder(this.match.game, this.seat, this.match.drafts[this.seat], order);
    if (!r.ok) return r;
    this.pruned = '';
    this.setDraft(r.draft);
    this.emit();
    return { ok: true };
  }

  undo(index: number): void {
    if (!this.editable()) return;
    const draft = this.match.drafts[this.seat];
    if (index < 0 || index >= draft.length) return;
    const r = undoOrder(this.match.game, this.seat, draft, index);
    const n = r.removed.length;
    this.pruned = n === 0 ? '' : `Removed ${n} dependent order${n === 1 ? '' : 's'}`;
    this.setDraft(r.kept);
    this.emit();
  }

  clear(): void {
    if (!this.editable() || this.match.drafts[this.seat].length === 0) return;
    this.pruned = '';
    this.setDraft([]);
    this.emit();
  }

  reorder(from: number, to: number): void {
    if (!this.editable()) return;
    const draft = this.match.drafts[this.seat];
    if (from === to || from < 0 || from >= draft.length) return;
    const r = reorderDraft(this.match.game, this.seat, draft, from, to);
    if (r.removed.length > 0) {
      this.note('Cannot reorder: later orders depend on this one');
      this.emit();
      return;
    }
    this.pruned = '';
    this.setDraft(r.kept);
    this.emit();
  }

  endTurn(): void {
    const g = this.match.game;
    if (g.phase === 'ended' || this.handoff !== null) return;
    if (this.tableDelta !== null) {
      // The table has read the Turn Delta: now cover the screen for the first seat's private planning.
      this.handoff = this.tableDelta;
      this.tableDelta = null;
      this.emit();
      return;
    }
    if (readyBlock(g, this.seat, this.match.drafts[this.seat])) return;
    this.pruned = '';
    if (this.cur < this.humans.length - 1) {
      // Hotseat: pass the device to the next human seat; this seat's draft stays hidden.
      this.cur++;
      this.handoff = this.humans[this.cur];
    } else {
      this.match.endTurn(); // resolves exactly once
      this.resolutions++;
      this.revs = this.match.game.players.map(() => 0);
      this.cur = 0;
      this.handoff = null;
      this.tableDelta = this.humans.length > 1 && this.match.game.phase !== 'ended' ? this.humans[0] : null;
    }
    this.emit();
  }

  beginTurn(): void {
    if (this.handoff === null) return;
    this.handoff = null;
    this.emit();
  }

  continueEndless(): void {
    if (!this.match.continueEndless()) return;
    this.cur = 0;
    this.tableDelta = null;
    this.handoff = this.humans.length > 1 ? this.humans[0] : null;
    this.emit();
  }

  rematch(): void {
    this.config = { ...this.config, seed: (this.config.seed + 7919) >>> 0 };
    this.match = new LocalMatch(this.config);
    this.humans = this.pickHumans();
    this.revs = this.match.game.players.map(() => 0);
    this.cur = 0;
    this.handoff = null;
    this.tableDelta = null;
    this.pruned = '';
    this.notices = [];
    this.emit();
  }

  leave(): void {
    this.listeners.clear();
  }

  exportMatch(): MatchExport | null {
    return this.match.log.length > 0 ? this.match.export() : null;
  }

  async exportMatchAsync(): Promise<MatchExport | null> {
    return this.exportMatch();
  }
}

// ───────────────────────────── Network room ─────────────────────────────

const draftKey = (code: string): string => `mercadia:draft:${code}`;

function loadCache(kv: KV | null, code: string): DraftCache | null {
  try {
    const raw = kv?.getItem(draftKey(code));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<DraftCache>;
    const orders = parseDraft(v.orders);
    if (!orders || !Number.isInteger(v.turn) || !Number.isInteger(v.revision) || !Number.isInteger(v.matchNo)) return null;
    return { turn: v.turn as number, revision: v.revision as number, orders, matchNo: v.matchNo as number };
  } catch {
    return null;
  }
}

function newTabId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `tab-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

class RoomSession extends Base {
  private core: RoomClient;
  private code: string;
  private name: string | undefined;
  private ws: WebSocket | null = null;
  private opened = false;
  private welcomed = false;
  private stopped = false;
  private attempts = 0;
  private playerId: string | null = null;
  /** True only while this session holds an actual player seat; a spectator never owns the seat token. */
  private seated = false;
  private lastRx = 0;
  private pingSeq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private seenNotice = 0;
  private token: SeatToken;
  private store: KV | null;
  private exportNoticeText = '';

  constructor(private opts: SessionOptions) {
    super();
    this.code = (opts.roomCode ?? '').toUpperCase();
    this.name = opts.name;
    const stores = browserStores();
    this.store = stores.local ?? stores.session;
    this.token = new SeatToken(this.code, stores.local, stores.session, newTabId());
    this.core = new RoomClient({
      send: (m) => this.send(m),
      cache: loadCache(this.store, this.code),
      onCache: (c) => this.writeCache(c),
    });
    if (!/^[A-Z]{4}$/.test(this.code)) this.core.fail('Room not found');
    this.emit();
    if (!this.core.failure) this.connect();
  }

  private writeCache(c: DraftCache | null): void {
    try {
      if (c) this.store?.setItem(draftKey(this.code), JSON.stringify(c));
      else this.store?.removeItem(draftKey(this.code));
    } catch {
      // storage unavailable: the draft simply is not cached
    }
  }

  private url(): string {
    const loc = (globalThis as { location?: { protocol: string; host: string } }).location;
    const proto = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc?.host ?? 'localhost'}/ws/rooms/${this.code}`;
  }

  // ── Transport ──

  private connect(): void {
    if (this.stopped) return;
    const url = this.url();
    let ws: WebSocket;
    try {
      ws = this.opts.socketFactory ? this.opts.socketFactory(url) : new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.opened = false;
    this.welcomed = false;
    const onOpen = (): void => {
      if (this.ws !== ws || this.opened) return;
      this.opened = true;
      this.lastRx = Date.now();
      this.core.open();
      this.playerId = this.playerId ?? this.token.load(Date.now());
      const hello: ClientMsg = { t: 'hello', playerId: this.playerId ?? undefined, name: this.name, lastTurn: this.core.helloTurn() || undefined };
      this.send(hello);
      this.pingTimer = setInterval(() => this.tick(), PING_MS);
      this.emit();
    };
    ws.onopen = onOpen;
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.lastRx = Date.now();
      if (typeof ev.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      this.onMessage(msg);
    };
    ws.onerror = nullFn; // the close event follows and drives reconnect
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.onClosed(ev?.code ?? 1006);
    };
    if (ws.readyState === 1) onOpen();
  }

  private send(msg: ClientMsg): void {
    if (!this.ws || !this.opened) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // the close handler will reconnect
    }
  }

  /** Heartbeat: transport only. A silent socket is dropped so the reconnect path takes over. */
  private tick(): void {
    if (!this.ws || !this.opened) return;
    if (Date.now() - this.lastRx > DEAD_AFTER_MS) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      return;
    }
    this.send({ t: 'ping', at: ++this.pingSeq });
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.pingTimer = null;
    this.beatTimer = null;
  }

  private onClosed(code: number): void {
    const wasOpen = this.opened;
    const welcomed = this.welcomed;
    this.stopTimers();
    this.opened = false;
    this.welcomed = false;
    this.ws = null;
    this.core.close();
    if (this.stopped) return;
    if (code === 4004) {
      this.token.forget(); // the authority says the room is gone: drop only this room's token
      this.core.fail('Room not found');
    } else if (code === 4001) {
      this.core.fail('This seat is open in another tab');
    } else if (!wasOpen || !welcomed) {
      void this.checkRoom();
      this.emit();
      return;
    }
    this.emit();
    if (!this.core.failure) this.scheduleReconnect();
  }

  /** A socket that never opened: HTTP 404 on the upgrade means there is no such room, 410 a room from an older version. */
  private async checkRoom(): Promise<void> {
    let status = 0;
    try {
      const f = (globalThis as { fetch?: typeof fetch }).fetch;
      if (f) status = (await f(`/api/rooms/${this.code}`)).status;
    } catch {
      // offline: keep retrying
    }
    if (this.stopped) return;
    if (status === 404 || status === 410) {
      // A confirmed 404 / 410: the room is gone (or cannot be played), so its (now useless) seat token goes
      // too. Only this room's token: other rooms' tokens stay. No reconnect is scheduled.
      this.token.forget();
      this.core.fail(status === 410 ? LEGACY_ROOM_MESSAGE : 'Room not found');
      this.emit();
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** this.attempts);
    this.attempts++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private onMessage(msg: ServerMsg): void {
    if (msg.t === 'welcome') {
      this.welcomed = true;
      this.attempts = 0;
      this.playerId = msg.playerId;
      this.seated = msg.seat >= 0;
      if (this.seated) {
        this.token.save(msg.playerId, Date.now());
        if (!this.beatTimer) this.beatTimer = setInterval(() => this.token.beat(msg.playerId, Date.now()), HEARTBEAT_MS);
      } else {
        // A spectator (a second tab, or a full room) never saves, beats or releases a seat token.
        if (this.beatTimer) clearInterval(this.beatTimer);
        this.beatTimer = null;
      }
    }
    this.core.receive(msg);
    this.emit();
  }

  // ── View ──

  protected override emit(): void {
    this.expireNotices();
    super.emit();
  }

  private expireNotices(): void {
    for (const n of this.core.notices) {
      if (n.id <= this.seenNotice) continue;
      this.seenNotice = n.id;
      const t = setTimeout(() => {
        this.noticeTimers.delete(n.id);
        this.core.dropNotice(n.id);
        this.emit();
      }, NOTICE_TTL_MS);
      (t as { unref?: () => void }).unref?.();
      this.noticeTimers.set(n.id, t);
    }
  }

  protected build(): SessionView {
    const c = this.core;
    const g = c.game ?? placeholderGame();
    const plan = c.plan();
    const seats: SeatStatus[] = c.game
      ? c.seats.map((s, i) => (i === c.player ? { ...s, ready: c.ready } : s))
      : (c.lobby?.seats ?? []).map((s) => ({ kind: s.kind, name: s.name, house: s.house, ready: false, connected: s.connected }));
    return {
      mode: 'room',
      game: g,
      hash: c.game ? c.hash : stateHash(g),
      summary: c.summary,
      summaries: c.summaries.slice(),
      resolutions: c.resolutions,
      seat: c.player,
      draft: c.draft.slice(),
      revision: c.revision,
      ackedRevision: c.ackedRevision,
      plan,
      actions: plan ? { used: plan.actionsMax - plan.actions, max: plan.actionsMax } : { used: 0, max: 0 },
      projectedCash: plan ? plan.cash : c.game && c.player >= 0 ? c.game.players[c.player].cash : 0,
      ready: c.ready,
      status: c.status(),
      endTurn: c.endTurn(),
      seats,
      notices: c.notices.slice(),
      pruned: c.pruned,
      handoff: null,
      tableDelta: null,
      roomCode: this.code,
      lobby: c.lobby,
      host: !!c.lobby && c.seat >= 0 && c.lobby.host === c.seat,
      ended: c.game ? c.phase === 'ended' : false,
    };
  }

  // ── Session API ──

  queue(order: Order): { ok: true } | { ok: false; reason: string } {
    const r = this.core.queue(order);
    this.emit();
    return r;
  }
  undo(index: number): void {
    this.core.undo(index);
    this.emit();
  }
  clear(): void {
    this.core.clear();
    this.emit();
  }
  reorder(from: number, to: number): void {
    this.core.reorder(from, to);
    this.emit();
  }
  endTurn(): void {
    this.core.pressEndTurn();
    this.emit();
  }
  beginTurn(): void {}
  continueEndless(): void {
    this.send({ t: 'endless' });
  }
  rematch(): void {
    this.send({ t: 'rematch' });
  }

  leave(): void {
    this.stopped = true;
    this.stopTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const t of this.noticeTimers.values()) clearTimeout(t);
    this.noticeTimers.clear();
    // The seat stays reserved for its token: only the heartbeat is released.
    if (this.seated && this.playerId) this.token.release(this.playerId);
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    try {
      ws?.close();
    } catch {
      // already closed
    }
    this.listeners.clear();
  }

  exportMatch(): MatchExport | null {
    return null; // a room keeps the canonical log on the authority: see exportMatchAsync
  }

  /**
   * The authority's canonical public export (GET /api/rooms/:code/export), or null if there is none.
   * A match that started under an older ruleset answers 409 `incompatible_ruleset`: that surfaces as a
   * notice (exportNotice) instead of a download.
   */
  async exportMatchAsync(): Promise<MatchExport | null> {
    this.exportNoticeText = '';
    try {
      const f = (globalThis as { fetch?: typeof fetch }).fetch;
      if (!f) return null;
      const res = await f(`/api/rooms/${this.code}/export`, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 409) {
          const body = (await res.json().catch(() => null)) as { code?: string } | null;
          if (body?.code === 'incompatible_ruleset') this.exportNoticeText = INCOMPATIBLE_RULESET_MESSAGE;
        }
        return null;
      }
      return (await res.json()) as MatchExport;
    } catch {
      return null;
    }
  }

  override get exportNotice(): string {
    return this.exportNoticeText;
  }

  lobby: Session['lobby'] = {
    setName: (name) => {
      this.name = name;
      this.send({ t: 'lobby', name });
    },
    setHouse: (house) => this.send({ t: 'lobby', house }),
    setSeatAi: (seat, ai) => this.send({ t: 'seat', seat, ai }),
    setAiFill: (on) => this.send({ t: 'aifill', on }),
    setMode: (mode: MatchMode) => this.send({ t: 'mode', mode }),
    start: () => this.send({ t: 'start' }),
  };
}

// ───────────────────────────── Public API ─────────────────────────────

export function createSession(opts: SessionOptions): Session {
  if (opts.mode === 'room') return new RoomSession(opts);
  const config: MatchConfig =
    opts.config ??
    ({
      seed: 1,
      mode: 'standard',
      players: [
        { name: 'You', house: 0, kind: 'human', persona: null },
        { name: 'Vesper', house: 1, kind: 'ai', persona: 'vesper' },
      ],
    } satisfies MatchConfig);
  return new LocalSession(opts.mode, config);
}

/** Create a room on the authority (POST /api/rooms) for the HUD's Create Room button. */
export async function createRoom(): Promise<{ code: string; joinUrl: string }> {
  const res = await fetch('/api/rooms', { method: 'POST' });
  if (!res.ok) throw new Error('Could not open a room');
  const body = (await res.json()) as { code: string; joinUrl: string };
  return { code: body.code, joinUrl: body.joinUrl };
}
