// Session reconciliation tests: solo, hotseat, and the room client against the real RoomCore.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionView } from '../src/client/contracts';
import { RoomClient } from '../src/client/session-core';
import { createSession } from '../src/client/session';
import { createGame, stateHash } from '../src/shared/game';
import { queueOrder } from '../src/shared/orders';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol';
import { replayMatch } from '../src/shared/replay';
import { RoomCore, type Outbound } from '../src/shared/room';
import type { MatchConfig, Order } from '../src/shared/types';

// ───────────────────────────── Harness ─────────────────────────────

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: ClientMsg[] = [];
  rx: ServerMsg[] = [];
  pid = '';
  /** Called with each client frame (the authority wiring). */
  onSend: ((m: ClientMsg) => void) | null = null;
  onClientClose: (() => void) | null = null;
  constructor(readonly url: string) {}
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string): void {
    const m = JSON.parse(data) as ClientMsg;
    this.sent.push(m);
    this.onSend?.(m);
  }
  deliver(msg: ServerMsg): void {
    this.rx.push(msg);
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** Network failure. */
  drop(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onClientClose?.();
    this.onclose?.({ code });
  }
  close(): void {
    this.drop(1000);
  }
  sentOf<T extends ClientMsg['t']>(t: T): Extract<ClientMsg, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ClientMsg, { t: T }>[];
  }
}

/** The real RoomCore wired to fake sockets, with hooks to hold or drop traffic. */
class Authority {
  core = new RoomCore('ABCD', 7);
  conns = new Map<string, FakeSocket>();
  sockets: FakeSocket[] = [];
  seq = 0;
  holdTo: ((pid: string, m: ServerMsg) => boolean) | null = null;
  held: { pid: string; m: ServerMsg }[] = [];
  dropFromClient: ((m: ClientMsg) => boolean) | null = null;

  factory = (url: string): WebSocket => {
    const s = new FakeSocket(url);
    this.sockets.push(s);
    s.onSend = (m) => {
      if (this.dropFromClient?.(m)) return;
      if (m.t === 'hello') {
        const res = this.core.join(m.playerId ?? null, m.name, () => `p${++this.seq}`);
        s.pid = res.playerId;
        this.conns.set(res.playerId, s);
        this.dispatch(res.out);
      } else if (m.t === 'ping') {
        s.deliver({ t: 'pong', at: m.at });
      } else if (s.pid) {
        this.dispatch(this.core.handle(s.pid, m));
      }
    };
    s.onClientClose = () => {
      if (s.pid && this.conns.get(s.pid) === s) {
        this.conns.delete(s.pid);
        this.dispatch(this.core.disconnect(s.pid));
      }
    };
    return s as unknown as WebSocket;
  };

  dispatch(out: Outbound[]): void {
    for (const o of out) {
      const targets = o.to === '*' ? [...this.conns.entries()] : this.conns.has(o.to) ? [[o.to, this.conns.get(o.to)!] as const] : [];
      for (const [pid, s] of targets) {
        if (this.holdTo?.(pid, o.msg)) this.held.push({ pid, m: o.msg });
        else s.deliver(o.msg);
      }
    }
  }

  release(): void {
    const h = this.held;
    this.held = [];
    this.holdTo = null;
    for (const { pid, m } of h) this.conns.get(pid)?.deliver(m);
  }

  last(i = -1): FakeSocket {
    return this.sockets.at(i)!;
  }
}

function kv() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

const sessions: Session[] = [];

function client(auth: Authority, name: string, store = kv()): { s: Session; sock: FakeSocket; store: ReturnType<typeof kv> } {
  (globalThis as { localStorage?: unknown }).localStorage = store;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = kv();
  const s = createSession({ mode: 'room', roomCode: 'ABCD', name, socketFactory: auth.factory });
  sessions.push(s);
  const sock = auth.last();
  sock.open();
  return { s, sock, store };
}

beforeEach(() => {
  (globalThis as { fetch?: unknown }).fetch = vi.fn(async () => ({ status: 200 }));
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.leave();
  vi.useRealTimers();
});

const turnOf = (s: Session): number => s.view.game.turn;
const ORDERS: Order[] = [{ t: 'recruit', kind: 'watch' }, { t: 'borrow' }, { t: 'study', key: 'roasting' }];

/** Two human seats (A host, B) + two AI, match started, both at Turn 1. */
function startedRoom() {
  const auth = new Authority();
  const a = client(auth, 'Ann');
  const b = client(auth, 'Bea');
  a.s.lobby.start();
  return { auth, a, b };
}

const soloConfig = (mode: 'blitz' | 'standard' = 'blitz'): MatchConfig => ({
  seed: 5,
  mode,
  players: [
    { name: 'Ann', house: 0, kind: 'human', persona: null },
    { name: 'Vesper', house: 1, kind: 'ai', persona: 'vesper' },
  ],
});

// ───────────────────────────── Solo ─────────────────────────────

describe('solo', () => {
  it('end turn resolves exactly once and updates summary, hash and draft', () => {
    const s = createSession({ mode: 'solo', config: soloConfig() });
    expect(s.view.game.turn).toBe(1);
    expect(s.view.summary).toBeNull();
    expect(s.view.status.text).toBe('Your turn');
    expect(s.view.endTurn).toEqual({ label: 'End Turn', enabled: true, kind: 'end' });
    const h0 = s.view.hash;
    expect(s.queue(ORDERS[0])).toEqual({ ok: true });
    expect(s.view.draft).toHaveLength(1);
    expect(s.view.revision).toBe(1);
    expect(s.view.ackedRevision).toBe(1);
    expect(s.view.plan).not.toBeNull();
    expect(s.view.projectedCash).toBeLessThan(s.view.game.players[0].cash);
    expect(s.view.actions.used).toBe(1);
    const seen: SessionView[] = [];
    s.subscribe((v) => seen.push(v));
    s.endTurn();
    expect(seen).toHaveLength(1);
    expect(s.view.game.turn).toBe(2);
    expect(s.view.resolutions).toBe(1);
    expect(s.view.summary?.to).toBe(2);
    expect(s.view.summary?.from).toBe(1);
    expect(s.view.summaries).toHaveLength(1);
    expect(s.view.hash).not.toBe(h0);
    expect(s.view.hash).toBe(stateHash(s.view.game));
    expect(s.view.draft).toEqual([]);
    expect(s.view.revision).toBe(0);
    const exp = s.exportMatch()!;
    expect(exp.log).toHaveLength(1);
    expect(replayMatch(exp.config, exp.log).hashes[0]).toBe(exp.hashes[0]);
    expect(exp.hashes[0]).toBe(s.view.hash);
  });

  it('each endTurn call resolves the state it finds, once (never twice for the same turn)', () => {
    const s = createSession({ mode: 'solo', config: soloConfig() });
    s.endTurn();
    s.endTurn();
    expect(s.view.game.turn).toBe(3);
    expect(s.view.resolutions).toBe(2);
    expect(s.exportMatch()!.log).toHaveLength(2);
  });

  it('shows Choose a Charter on Council turns until a charter order is queued; Match over at the end', () => {
    const s = createSession({ mode: 'solo', config: soloConfig('blitz') });
    for (let i = 0; i < 4; i++) s.endTurn();
    expect(s.view.game.turn).toBe(5);
    expect(s.view.endTurn).toEqual({ label: 'Choose a Charter', enabled: false, kind: 'end' });
    const before = s.view.game.turn;
    s.endTurn(); // blocked
    expect(s.view.game.turn).toBe(before);
    const offer = s.view.game.council!.offers[0][0];
    expect(s.queue({ t: 'charter', key: offer })).toEqual({ ok: true });
    expect(s.view.endTurn.label).toBe('End Turn');
    expect(s.view.endTurn.enabled).toBe(true);
    for (let guard = 0; guard < 40 && !s.view.ended; guard++) {
      if (s.view.endTurn.label === 'Choose a Charter') s.queue({ t: 'charter', key: s.view.game.council!.offers[0][0] });
      s.endTurn();
    }
    expect(s.view.ended).toBe(true);
    expect(s.view.endTurn).toEqual({ label: 'Match over', enabled: false, kind: 'end' });
    expect(s.view.status.text).toBe('Match over');
  });

  it('undo removes dependent orders and reports it in view.pruned', () => {
    const s = createSession({ mode: 'solo', config: soloConfig() });
    // Find a Factor move that makes a lot reachable which is not reachable otherwise.
    const g = s.view.game;
    let pair: [number, number] | null = null;
    for (let to = 0; to < 144 && !pair; to++) {
      const m = queueOrder(g, 0, [], { t: 'move', unit: 1, to });
      if (!m.ok) continue;
      for (let tile = 0; tile < 144; tile++) {
        const o: Order = { t: 'build', tile, kind: 'park' };
        if (!queueOrder(g, 0, [], o).ok && queueOrder(g, 0, m.draft, o).ok) {
          pair = [to, tile];
          break;
        }
      }
    }
    expect(pair).not.toBeNull();
    expect(s.queue({ t: 'move', unit: 1, to: pair![0] }).ok).toBe(true);
    expect(s.queue({ t: 'build', tile: pair![1], kind: 'park' }).ok).toBe(true);
    s.undo(0);
    expect(s.view.draft).toEqual([]);
    expect(s.view.pruned).toBe('Removed 1 dependent order');
    s.queue(ORDERS[0]);
    expect(s.view.pruned).toBe('');
  });

  it('queue reports a reason for an illegal order and reorder/clear work', () => {
    const s = createSession({ mode: 'solo', config: soloConfig() });
    const r = s.queue({ t: 'build', tile: 0, kind: 'park' });
    expect(r.ok).toBe(false);
    s.queue(ORDERS[0]);
    s.queue(ORDERS[1]);
    s.reorder(0, 1);
    expect(s.view.draft.map((o) => o.t)).toEqual(['borrow', 'recruit']);
    s.clear();
    expect(s.view.draft).toEqual([]);
  });
});

// ───────────────────────────── Hotseat ─────────────────────────────

describe('hotseat', () => {
  const cfg: MatchConfig = {
    seed: 9,
    mode: 'blitz',
    players: [
      { name: 'Ann', house: 0, kind: 'human', persona: null },
      { name: 'Bea', house: 1, kind: 'human', persona: null },
      { name: 'Vesper', house: 2, kind: 'ai', persona: 'vesper' },
    ],
  };

  it('hands off in seat order, hides drafts, and the last seat resolves', () => {
    const s = createSession({ mode: 'hotseat', config: cfg });
    expect(s.view.handoff).toBeNull();
    expect(s.view.seat).toBe(0);
    s.queue(ORDERS[0]);
    expect(s.view.draft).toHaveLength(1);
    s.endTurn();
    expect(s.view.game.turn).toBe(1);
    expect(s.view.handoff).toEqual({ player: 1 });
    expect(s.view.draft).toEqual([]); // seat 0's draft is not exposed
    expect(s.view.plan).toBeNull();
    expect(s.view.endTurn.enabled).toBe(false);
    expect(s.queue(ORDERS[1]).ok).toBe(false);
    s.endTurn(); // ignored while the handoff is pending
    expect(s.view.game.turn).toBe(1);
    s.beginTurn();
    expect(s.view.handoff).toBeNull();
    expect(s.view.seat).toBe(1);
    expect(s.view.draft).toEqual([]); // not seat 0's orders
    s.queue(ORDERS[1]);
    expect(s.view.draft.map((o) => o.t)).toEqual(['borrow']);
    s.endTurn();
    expect(s.view.game.turn).toBe(2);
    expect(s.view.resolutions).toBe(1);
    expect(s.view.summary?.to).toBe(2);
    // The table reads the Turn 1→2 delta first: no handoff screen yet, nobody's plan on screen.
    expect(s.view.handoff).toBeNull();
    expect(s.view.tableDelta).toEqual({ next: 0 });
    expect(s.view.summary?.from).toBe(1);
    expect(s.view.draft).toEqual([]);
    expect(s.view.plan).toBeNull();
    expect(s.view.endTurn).toMatchObject({ label: 'Pass to Ann', enabled: true });
    expect(s.queue(ORDERS[0]).ok).toBe(false); // nobody can plan before the handoff
    s.beginTurn(); // not a way around the handoff either
    expect(s.view.tableDelta).toEqual({ next: 0 });
    s.endTurn(); // "Pass to Ann": now the first seat's handoff covers the screen
    expect(s.view.tableDelta).toBeNull();
    expect(s.view.handoff).toEqual({ player: 0 });
    expect(s.view.game.turn).toBe(2); // passing on never resolves anything
    expect(s.view.resolutions).toBe(1);
    expect(s.view.draft).toEqual([]);
    s.beginTurn();
    expect(s.view.seat).toBe(0);
    expect(s.view.draft).toEqual([]);
    const log = s.exportMatch()!.log;
    expect(log[0][0].map((o) => o.t)).toEqual(['recruit']);
    expect(log[0][1].map((o) => o.t)).toEqual(['borrow']);
  });
});

// ───────────────────────────── Room: integration with RoomCore ─────────────────────────────

describe('room integration', () => {
  it('two clients ready and the turn resolves once with identical hashes', () => {
    const { auth, a, b } = startedRoom();
    expect(a.s.view.mode).toBe('room');
    expect(a.s.view.host).toBe(true);
    expect(b.s.view.host).toBe(false);
    expect(turnOf(a.s)).toBe(1);
    expect(a.s.view.seat).toBe(0);
    expect(b.s.view.seat).toBe(1);
    expect(a.s.view.status.text).toBe('Your turn');
    expect(a.s.view.endTurn.label).toBe('End Turn');
    expect(a.s.view.resolutions).toBe(0); // first world is not a "resolution"
    expect(a.store.map.get('mercadia:pid:ABCD')).toContain(a.sock.pid);

    a.s.queue(ORDERS[0]);
    expect(a.s.view.ackedRevision).toBe(1);
    a.s.endTurn();
    expect(a.sock.sentOf('ready')).toEqual([{ t: 'ready', turn: 1, revision: 1, epoch: 0 }]);
    expect(a.s.view.ready).toBe(true);
    expect(a.s.view.endTurn).toEqual({ label: 'Cancel Ready', enabled: true, kind: 'cancel' });
    expect(a.s.view.status.text).toBe('Waiting for opponent…');
    expect(b.s.view.seats[0].ready).toBe(true); // Ready is public
    expect(b.s.view.status.text).toBe('Your turn');

    b.s.endTurn();
    expect(auth.core.room.log).toHaveLength(1); // resolved exactly once
    for (const c of [a, b]) {
      expect(turnOf(c.s)).toBe(2);
      expect(c.s.view.resolutions).toBe(1);
      expect(c.s.view.summary?.to).toBe(2);
      expect(c.s.view.ready).toBe(false);
      expect(c.s.view.draft).toEqual([]);
      expect(c.s.view.revision).toBe(0);
      expect(c.s.view.endTurn.label).toBe('End Turn');
    }
    expect(a.s.view.hash).toBe(b.s.view.hash);
    expect(a.s.view.hash).toBe(stateHash(auth.core.game!));
    expect(a.s.view.hash).toBe(auth.core.room.hashes[0]);

    // First Ready of Turn 2 carries epoch 0 and is recorded on the first press.
    a.s.endTurn();
    expect(a.sock.sentOf('ready').at(-1)).toEqual({ t: 'ready', turn: 2, revision: 0, epoch: 0 });
    expect(a.s.view.ready).toBe(true);
  });

  it('Waiting for N opponents names the count; Resolving shows when all are Ready', () => {
    const auth = new Authority();
    const a = client(auth, 'Ann');
    const b = client(auth, 'Bea');
    const c = client(auth, 'Cy');
    a.s.lobby.start();
    expect(auth.core.room.seats.filter((s) => s.kind === 'human')).toHaveLength(3);
    a.s.endTurn();
    expect(a.s.view.status.text).toBe('Waiting for 2 opponents…');
    b.s.endTurn();
    expect(a.s.view.status.text).toBe('Waiting for opponent…');
    c.s.endTurn();
    expect(turnOf(a.s)).toBe(2);
  });

  it('Saving draft… until the matching draftAck; End Turn button follows acknowledged readiness only', () => {
    const { auth, a } = startedRoom();
    auth.holdTo = (pid, m) => pid === a.sock.pid && m.t === 'draftAck';
    a.s.queue(ORDERS[0]);
    expect(a.s.view.revision).toBe(1);
    expect(a.s.view.ackedRevision).toBe(0);
    expect(a.s.view.endTurn).toEqual({ label: 'Saving draft…', enabled: false, kind: 'end' });
    a.s.endTurn();
    expect(a.sock.sentOf('ready')).toHaveLength(0);
    auth.release();
    expect(a.s.view.endTurn.label).toBe('End Turn');

    auth.holdTo = (pid, m) => pid === a.sock.pid && m.t === 'readyAck';
    a.s.endTurn();
    expect(a.s.view.ready).toBe(false); // an unacknowledged press is never shown as Ready
    expect(a.s.view.endTurn.label).toBe('End Turn');
    auth.release();
    expect(a.s.view.ready).toBe(true);
    expect(a.s.view.endTurn.label).toBe('Cancel Ready');
    a.s.endTurn();
    expect(a.sock.sentOf('cancelReady')).toEqual([{ t: 'cancelReady', turn: 1, epoch: 1 }]);
    expect(a.s.view.ready).toBe(false);
    expect(a.s.view.endTurn.label).toBe('End Turn');
    // Editing while Ready is refused locally.
    a.s.endTurn();
    expect(a.s.queue(ORDERS[1]).ok).toBe(false);
  });

  it('a late readyAck (Ready, epoch 1) after Planning epoch 2 leaves Planning epoch 2', () => {
    const { a } = startedRoom();
    a.s.endTurn(); // Ready -> epoch 1
    const lateReady = a.sock.rx.filter((m) => m.t === 'readyAck').at(-1)!;
    expect(lateReady).toMatchObject({ ready: true, epoch: 1 });
    a.s.endTurn(); // Cancel -> epoch 2
    expect(a.s.view.ready).toBe(false);
    a.sock.deliver(lateReady);
    expect(a.s.view.ready).toBe(false);
    expect(a.s.view.endTurn.label).toBe('End Turn');
    a.s.endTurn();
    expect(a.sock.sentOf('ready').at(-1)).toMatchObject({ epoch: 2 });
  });

  it('ignores older-turn messages and draftAck/readyAck/error naming a newer turn', () => {
    const { a, b } = startedRoom();
    a.s.queue(ORDERS[0]);
    const turn1State = a.sock.rx.find((m) => m.t === 'state')!;
    const turn1Ack = a.sock.rx.filter((m) => m.t === 'draftAck').at(-1)!;
    a.s.endTurn();
    b.s.endTurn();
    expect(turnOf(a.s)).toBe(2);
    a.s.queue(ORDERS[1]);
    const snap = { ...a.s.view };
    const before = JSON.stringify({ h: snap.hash, d: snap.draft, r: snap.revision, k: snap.ackedRevision, rd: snap.ready, n: snap.notices });
    const oldResolved: ServerMsg = { t: 'resolved', turn: 1, phase: 'planning', game: createGame(soloConfig()), hash: 'x', summary: a.s.view.summary!, seats: [] };
    const msgs: ServerMsg[] = [
      turn1State,
      turn1Ack,
      oldResolved,
      { t: 'readyAck', turn: 1, ready: true, epoch: 5 },
      { t: 'error', code: 'staleDraft', message: 'x', turn: 1, revision: 0, epoch: 9 },
      { t: 'draftAck', turn: 3, revision: 9 },
      { t: 'readyAck', turn: 3, ready: true, epoch: 7 },
      { t: 'error', code: 'readyLocked', message: 'x', turn: 3, revision: 0, epoch: 9 },
    ];
    for (const m of msgs) a.sock.deliver(m);
    const after = JSON.stringify({ h: a.s.view.hash, d: a.s.view.draft, r: a.s.view.revision, k: a.s.view.ackedRevision, rd: a.s.view.ready, n: a.s.view.notices });
    expect(after).toBe(before);
    expect(turnOf(a.s)).toBe(2);
    expect(a.s.view.resolutions).toBe(1);
  });

  it('a same-turn resolved is ignored and never resets held readiness', () => {
    const { a, b } = startedRoom();
    a.s.endTurn();
    b.s.endTurn();
    const resolved = a.sock.rx.filter((m) => m.t === 'resolved').at(-1)!;
    a.s.endTurn(); // Ready for Turn 2, epoch 1
    expect(a.s.view.ready).toBe(true);
    a.sock.deliver(resolved);
    expect(a.s.view.ready).toBe(true);
    expect(a.s.view.resolutions).toBe(1);
  });

  it('a newer-turn resolved resets to Planning epoch 0 with an empty draft and discards pending work', () => {
    // Real RoomCore plays the shadow table that produces the Turn 2 resolution for the same seed.
    const shadow = new RoomCore('ABCD', 7);
    const ids = ['x', 'y'].map((n) => shadow.join(null, n, () => n).playerId);
    shadow.handle(ids[0], { t: 'start' });
    shadow.handle(ids[0], { t: 'ready', turn: 1, revision: 0, epoch: 0 });
    const out = shadow.handle(ids[1], { t: 'ready', turn: 1, revision: 0, epoch: 0 });
    const resolved = out.find((o) => o.msg.t === 'resolved')!.msg;

    const auth = new Authority();
    const a = client(auth, 'Ann');
    client(auth, 'Bea');
    a.s.lobby.start();
    // Pending (unacknowledged) draft and pending Ready for Turn 1.
    auth.holdTo = (pid, m) => pid === a.sock.pid && (m.t === 'draftAck' || m.t === 'readyAck');
    a.s.queue(ORDERS[0]);
    expect(a.s.view.ackedRevision).toBe(0);
    a.sock.deliver(resolved);
    expect(turnOf(a.s)).toBe(2);
    expect(a.s.view.resolutions).toBe(1);
    expect(a.s.view.draft).toEqual([]);
    expect(a.s.view.revision).toBe(0);
    expect(a.s.view.ackedRevision).toBe(0);
    expect(a.s.view.ready).toBe(false);
    expect(a.s.view.summary?.to).toBe(2);
    expect(a.s.view.endTurn.label).toBe('End Turn');
    // The awaited Turn 1 acknowledgments arrive late and are ignored.
    auth.release();
    expect(a.s.view.ackedRevision).toBe(0);
    expect(a.s.view.draft).toEqual([]);
    // Nothing from Turn 1 was ever sent for Turn 2; a fresh edit is revision 1 of Turn 2.
    const sentDrafts = a.sock.sentOf('draft');
    expect(sentDrafts.every((d) => d.turn === 1)).toBe(true);
    auth.dropFromClient = () => true;
    a.s.queue(ORDERS[1]);
    expect(a.sock.sentOf('draft').at(-1)).toMatchObject({ turn: 2, revision: 1 });
    expect(a.sock.sentOf('ready')).toHaveLength(0);
  });

  it('a join state for a newer turn shows the offline notice and discards the old draft', () => {
    vi.useFakeTimers();
    const { auth, a, b } = startedRoom();
    a.s.queue(ORDERS[0]);
    a.s.endTurn();
    const firstId = a.sock.pid;
    a.sock.drop(); // network drop
    expect(a.s.view.status).toEqual({ text: 'Reconnecting…', tone: 'reconnect' });
    expect(a.s.view.endTurn).toEqual({ label: 'Reconnecting…', enabled: false, kind: 'end' });
    expect(a.s.view.draft).toHaveLength(1); // draft kept locally
    b.s.endTurn(); // A's Ready was recorded: the turn resolves while A is away
    expect(auth.core.room.log).toHaveLength(1);
    expect(turnOf(a.s)).toBe(1);
    vi.advanceTimersByTime(499);
    expect(auth.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(auth.sockets).toHaveLength(3);
    auth.last().open();
    expect(auth.last().sentOf('hello')[0]).toMatchObject({ playerId: firstId, name: 'Ann', lastTurn: 1 });
    expect(turnOf(a.s)).toBe(2);
    expect(a.s.view.notices.map((n) => n.text)).toContain('Turn 1 resolved while you were offline — unsent edits discarded');
    expect(a.s.view.resolutions).toBe(1);
    expect(a.s.view.draft).toEqual([]);
    expect(a.s.view.ready).toBe(false);
    expect(a.s.view.status.text).toBe('Your turn');
    expect(auth.last().sentOf('draft')).toHaveLength(0);
    expect(auth.last().sentOf('ready')).toHaveLength(0);
    expect(a.s.view.hash).toBe(b.s.view.hash);
  });

  it('a reload restores a cached newer-revision draft for the same turn and resends it', () => {
    const { auth, a, b } = startedRoom();
    void b;
    const st = a.store;
    a.s.leave(); // closes the tab: the seat token is released
    st.setItem('mercadia:draft:ABCD', JSON.stringify({ turn: 1, revision: 2, orders: [ORDERS[0]], matchNo: 1 }));
    const a2 = client(auth, 'Ann', st);
    expect(a2.sock.sentOf('hello')[0].playerId).toBe(a.sock.pid);
    expect(turnOf(a2.s)).toBe(1);
    expect(a2.s.view.draft).toEqual([ORDERS[0]]);
    expect(a2.sock.sentOf('draft').at(-1)).toMatchObject({ turn: 1, revision: 2 });
    expect(a2.s.view.ackedRevision).toBe(2);
    expect(a2.s.view.notices).toEqual([]);
  });

  it('a reload with a cached draft from an earlier turn shows the offline notice', () => {
    const { auth, a, b } = startedRoom();
    const st = a.store;
    a.s.endTurn();
    a.s.leave();
    b.s.endTurn(); // resolves while A's tab is closed
    expect(turnOf(b.s)).toBe(2);
    st.setItem('mercadia:draft:ABCD', JSON.stringify({ turn: 1, revision: 2, orders: [ORDERS[0]], matchNo: 1 }));
    const a2 = client(auth, 'Ann', st);
    expect(turnOf(a2.s)).toBe(2);
    expect(a2.s.view.notices.map((n) => n.text)).toEqual(['Turn 1 resolved while you were offline — unsent edits discarded']);
    expect(a2.s.view.draft).toEqual([]);
    expect(a2.sock.sentOf('draft')).toHaveLength(0);
    expect(a2.s.view.resolutions).toBe(0); // first world held by this page
    expect(st.map.has('mercadia:draft:ABCD')).toBe(false);
  });

  it('an off-turn state reply on a live connection shows the already-resolved notice, applies once', () => {
    const shadow = new RoomCore('ABCD', 7);
    const ids = ['x', 'y'].map((n) => shadow.join(null, n, () => n).playerId);
    shadow.handle(ids[0], { t: 'start' });
    shadow.handle(ids[0], { t: 'ready', turn: 1, revision: 0, epoch: 0 });
    shadow.handle(ids[1], { t: 'ready', turn: 1, revision: 0, epoch: 0 });
    const state2 = shadow.stateFor(ids[0])[0];

    const { a } = startedRoom();
    expect(turnOf(a.s)).toBe(1);
    a.sock.deliver(state2);
    expect(turnOf(a.s)).toBe(2);
    expect(a.s.view.resolutions).toBe(1);
    expect(a.s.view.notices.map((n) => n.text)).toEqual(['Turn 1 already resolved — showing Turn 2']);
    expect(a.s.view.summary?.from).toBe(1);
    expect(a.s.view.summary?.to).toBe(2);
    // The same state again (same turn) never re-applies the world or reopens the Turn Delta.
    a.sock.deliver(state2);
    a.sock.deliver(state2);
    expect(a.s.view.resolutions).toBe(1);
    expect(a.s.view.notices).toHaveLength(1);
    expect(a.s.view.summaries).toHaveLength(1);
  });

  it('a newer state adopts the message epoch and Ready flag (readied on another device)', () => {
    const shadow = new RoomCore('ABCD', 7);
    const ids = ['x', 'y'].map((n) => shadow.join(null, n, () => n).playerId);
    shadow.handle(ids[0], { t: 'start' });
    shadow.handle(ids[0], { t: 'ready', turn: 1, revision: 0, epoch: 0 });
    shadow.handle(ids[1], { t: 'ready', turn: 1, revision: 0, epoch: 0 });
    shadow.handle(ids[0], { t: 'ready', turn: 2, revision: 0, epoch: 0 }); // seat 0 Ready on turn 2
    const state2 = shadow.stateFor(ids[0])[0] as Extract<ServerMsg, { t: 'state' }>;
    expect(state2.own).toMatchObject({ ready: true, epoch: 1 });
    const { a } = startedRoom();
    a.sock.deliver(state2);
    expect(a.s.view.ready).toBe(true);
    expect(a.s.view.endTurn.label).toBe('Cancel Ready');
    a.s.endTurn();
    expect(a.sock.sentOf('cancelReady').at(-1)).toEqual({ t: 'cancelReady', turn: 2, epoch: 1 });
  });

  it('a same-turn state with a lagging revision resends the draft and waits for draftAck', () => {
    const { auth, a } = startedRoom();
    auth.holdTo = (pid, m) => pid === a.sock.pid && m.t === 'draftAck';
    a.s.queue(ORDERS[0]);
    a.s.queue(ORDERS[1]);
    expect(a.s.view.revision).toBe(2);
    const state = structuredClone(auth.core.stateFor(a.sock.pid)[0]) as Extract<ServerMsg, { t: 'state' }>;
    state.own = { draft: [], revision: 1, ready: false, epoch: 0 };
    const sent = a.sock.sentOf('draft').length;
    const res = a.s.view.resolutions;
    a.sock.deliver(state);
    expect(a.s.view.resolutions).toBe(res);
    expect(a.sock.sentOf('draft')).toHaveLength(sent + 1);
    expect(a.sock.sentOf('draft').at(-1)).toMatchObject({ turn: 1, revision: 2 });
    expect(a.s.view.draft).toHaveLength(2); // local draft kept
    expect(a.s.view.endTurn.label).toBe('Saving draft…');
    auth.release();
    expect(a.s.view.endTurn.label).toBe('End Turn');
    // With the seat Ready on the authority, its draft is adopted instead.
    state.own = { draft: [ORDERS[2]], revision: 5, ready: true, epoch: 3 };
    a.sock.deliver(state);
    expect(a.s.view.draft).toEqual([ORDERS[2]]);
    expect(a.s.view.revision).toBe(5);
    expect(a.s.view.ready).toBe(true);
    // A same-turn state with a lower epoch is a superseded reply.
    state.own = { draft: [], revision: 0, ready: false, epoch: 1 };
    a.sock.deliver(state);
    expect(a.s.view.ready).toBe(true);
    expect(a.s.view.draft).toEqual([ORDERS[2]]);
  });

  it('staleDraft: notice, resend latest draft, Ready only re-enabled after draftAck, Ready never retried', () => {
    const { auth, a } = startedRoom();
    let dropped = false;
    auth.dropFromClient = (m) => (m.t === 'draft' && !dropped ? (dropped = true) : false);
    a.s.queue(ORDERS[0]); // draft lost on the wire
    expect(a.s.view.endTurn.label).toBe('Saving draft…');
    a.sock.deliver({ t: 'draftAck', turn: 1, revision: 1 }); // a mistaken ack makes End Turn look available
    expect(a.s.view.endTurn.label).toBe('End Turn');
    auth.holdTo = (pid, m) => pid === a.sock.pid && m.t === 'draftAck';
    a.s.endTurn();
    expect(a.sock.sentOf('ready')).toHaveLength(1);
    expect(a.s.view.ready).toBe(false);
    expect(a.s.view.notices.map((n) => n.text)).toContain('Draft not saved yet — Ready not recorded');
    expect(a.sock.sentOf('draft')).toHaveLength(2); // original + resend of the latest draft
    expect(a.sock.sentOf('draft').at(-1)).toMatchObject({ turn: 1, revision: 1 });
    expect(a.s.view.endTurn).toEqual({ label: 'Saving draft…', enabled: false, kind: 'end' });
    a.s.endTurn(); // disabled: no automatic or accidental retry
    expect(a.sock.sentOf('ready')).toHaveLength(1);
    auth.release();
    expect(a.s.view.endTurn.label).toBe('End Turn');
    a.s.endTurn(); // deliberate second press is recorded
    expect(a.sock.sentOf('ready')).toHaveLength(2);
    expect(a.sock.sentOf('ready')[1]).toMatchObject({ revision: 1, epoch: 0 });
    expect(a.s.view.ready).toBe(true);
  });

  it('needCharter makes the button Choose a Charter until the draft changes', () => {
    const { a } = startedRoom();
    a.sock.deliver({ t: 'error', code: 'needCharter', message: 'Choose a Charter', turn: 1, revision: 0, epoch: 0 });
    expect(a.s.view.endTurn).toEqual({ label: 'Choose a Charter', enabled: false, kind: 'end' });
    a.s.queue(ORDERS[0]);
    expect(a.s.view.endTurn.label).toBe('End Turn');
  });

  it('lobby controls send lobby messages; host follows lobby.host', () => {
    const auth = new Authority();
    const a = client(auth, 'Ann');
    const b = client(auth, 'Bea');
    expect(a.s.view.lobby?.status).toBe('lobby');
    expect(a.s.view.status.text).toBe('Set up the table, then start');
    expect(b.s.view.status.text).toBe('Waiting for the host to start');
    expect(a.s.view.endTurn.label).toBe('Waiting to start');
    b.s.lobby.setMode('blitz');
    expect(a.s.view.lobby?.mode).toBe('standard'); // not host: rejected
    a.s.lobby.setMode('blitz');
    expect(b.s.view.lobby?.mode).toBe('blitz');
    a.s.lobby.setName('Annie');
    expect(b.s.view.lobby?.seats[0].name).toBe('Annie');
    a.s.lobby.start();
    expect(turnOf(b.s)).toBe(1);
    expect(b.s.view.game.mode).toBe('blitz');
  });

  it('rematch resets the held match so Turn 1 of the new match is applied', () => {
    const { auth, a, b } = startedRoom();
    a.s.endTurn();
    b.s.endTurn();
    expect(turnOf(a.s)).toBe(2);
    // Force the match to end on the authority side by driving it to the final turn.
    auth.core.room.status = 'ended';
    auth.core.game!.phase = 'ended';
    a.s.rematch();
    expect(turnOf(a.s)).toBe(1);
    expect(turnOf(b.s)).toBe(1);
    expect(a.s.view.hash).toBe(stateHash(auth.core.game!));
    expect(a.s.view.summary).toBeNull();
  });
});

// ───────────────────────────── Room: transport ─────────────────────────────

describe('room transport', () => {
  it('heartbeats every 15s (transport only)', () => {
    vi.useFakeTimers();
    const { a } = startedRoom();
    vi.advanceTimersByTime(15000);
    expect(a.sock.sentOf('ping')).toHaveLength(1);
    const res = a.s.view.resolutions;
    vi.advanceTimersByTime(15000);
    expect(a.sock.sentOf('ping')).toHaveLength(2);
    expect(a.s.view.resolutions).toBe(res); // pings never alter state
  });

  it('backoff doubles 500, 1000, 2000 … capped at 8000 and resets after a welcome', async () => {
    vi.useFakeTimers();
    const { auth, a } = startedRoom();
    a.sock.drop();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const n = auth.sockets.length;
      let w = 0;
      while (auth.sockets.length === n && w < 20000) {
        await vi.advanceTimersByTimeAsync(100);
        w += 100;
      }
      waits.push(w);
      const s = auth.last();
      s.readyState = 3;
      s.onclose?.({ code: 1006 });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    // A successful reconnect resets the backoff.
    await vi.advanceTimersByTimeAsync(8000);
    auth.last().open();
    expect(a.s.view.status.text).toBe('Your turn');
    auth.last().drop();
    const n = auth.sockets.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(auth.sockets.length).toBe(n + 1);
  });

  it('shows Room not found when the socket never opens and the room API says 404', async () => {
    (globalThis as { fetch?: unknown }).fetch = vi.fn(async () => ({ status: 404 }));
    const auth = new Authority();
    (globalThis as { localStorage?: unknown }).localStorage = kv();
    const s = createSession({ mode: 'room', roomCode: 'ZZZZ', socketFactory: auth.factory });
    sessions.push(s);
    expect(s.view.status.text).toBe('Connecting…');
    auth.last().drop(1006); // upgrade refused: never opened
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.view.status).toEqual({ text: 'Room not found', tone: 'error' });
    expect(s.view.endTurn.enabled).toBe(false);
    expect(auth.sockets).toHaveLength(1); // no reconnect storm
    const bad = createSession({ mode: 'room', roomCode: 'x', socketFactory: auth.factory });
    sessions.push(bad);
    expect(bad.view.status.text).toBe('Room not found');
  });
});

// ───────────────────────────── Spectators (core only) ─────────────────────────────

describe('RoomClient', () => {
  it('spectators have no draft and show Spectating', () => {
    const shadow = new RoomCore('ABCD', 7);
    const ids = ['x', 'y'].map((n) => shadow.join(null, n, () => n).playerId);
    shadow.handle(ids[0], { t: 'start' });
    const spec = shadow.join(null, 'late', () => 'late');
    expect(spec.seat).toBe(-1);
    const sent: ClientMsg[] = [];
    const c = new RoomClient({ send: (m) => sent.push(m) });
    c.open();
    for (const o of spec.out) if (o.to === 'late') c.receive(o.msg);
    expect(c.status().text).toBe('Room is full — watching as spectator');
    expect(c.endTurn()).toEqual({ label: 'Spectating', enabled: false, kind: 'end' });
    expect(c.queue({ t: 'borrow' }).ok).toBe(false);
    c.pressEndTurn();
    expect(sent).toHaveLength(0);
    expect(c.plan()).toBeNull();
  });

  it('first state shows no notice and does not count as a resolution', () => {
    const shadow = new RoomCore('ABCD', 7);
    const j = shadow.join(null, 'x', () => 'x');
    shadow.join(null, 'y', () => 'y');
    shadow.handle('x', { t: 'start' });
    const c = new RoomClient({ send: () => {} });
    c.open();
    c.receive(j.out[0].msg);
    for (const m of shadow.stateFor('x')) c.receive(m);
    expect(c.notices).toEqual([]);
    expect(c.resolutions).toBe(0);
    expect(c.turn).toBe(1);
  });
});
