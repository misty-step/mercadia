import { describe, expect, it } from 'vitest';
import { stateHash } from '../src/shared/game';
import { parseClientMsg, type ClientMsg, type ServerMsg } from '../src/shared/protocol';
import { RoomCore, cleanName, isRoomCode, makeRoomCode } from '../src/shared/room';
import type { Order } from '../src/shared/types';
import { RoomHarness, playerOf, startedRoom, turnOf } from './harness';

const borrow: Order[] = [{ t: 'borrow' }];
const snap = (h: RoomHarness) => JSON.stringify({ room: h.core.room, game: h.core.game });
const only = <T extends ServerMsg['t']>(msgs: ServerMsg[], t: T) => msgs.filter((m): m is Extract<ServerMsg, { t: T }> => m.t === t);
const hashNow = (h: RoomHarness) => stateHash(h.core.game!);

/** Mark `id` Ready at its acknowledged revision/epoch (the first press of a turn). */
function ready(h: RoomHarness, id: string, rev = 0, epoch = 0) {
  return h.send(id, { t: 'ready', turn: turnOf(h), revision: rev, epoch });
}

describe('lobby', () => {
  it('creates a lobby with the host seat open and three AI seats', () => {
    const c = new RoomCore('QRST', 1);
    expect(c.lobby()).toMatchObject({ code: 'QRST', status: 'lobby', mode: 'standard', host: 0 });
    expect(c.lobby().seats.map((s) => s.kind)).toEqual(['open', 'ai', 'ai', 'ai']);
    expect(c.lobby().seats.filter((s) => s.kind === 'ai').map((s) => s.persona)).toEqual(['vesper', 'aurelia', 'orson']);
    expect(c.game).toBeNull();
  });

  it('room codes are four capital letters', () => {
    let k = 0.1;
    const code = makeRoomCode(() => (k = (k * 7919) % 1));
    expect(isRoomCode(code)).toBe(true);
    for (const bad of ['', 'abcd', 'ABC', 'ABCDE', 'AB1D', 'AB D']) expect(isRoomCode(bad)).toBe(false);
  });

  it('cleans names', () => {
    expect(cleanName('  <b>Ada</b>\n  Lovelace  ', 'x')).toBe('bAda/b Lovelace');
    expect(cleanName('<>', 'Fallback')).toBe('Fallback');
    expect(cleanName(42, 'Fallback')).toBe('Fallback');
    expect(Array.from(cleanName('x'.repeat(40), 'f'))).toHaveLength(16);
    expect(cleanName('a\u0000b', 'f')).toBe('ab');
  });

  it('seats humans in order, host first; the fifth is a spectator', () => {
    const h = new RoomHarness(1);
    const a = h.join('A');
    const b = h.join('B');
    const c = h.join('C');
    const d = h.join('D');
    const e = h.join('E');
    expect([a.seat, b.seat, c.seat, d.seat, e.seat]).toEqual([0, 1, 2, 3, -1]);
    expect(h.core.room.host).toBe(0);
    expect(h.core.lobby().seats.map((s) => s.kind)).toEqual(['human', 'human', 'human', 'human']);
    const w = only(h.take(a.playerId), 'welcome')[0];
    expect(w).toMatchObject({ seat: 0, player: -1, playerId: a.playerId });
  });

  it('only the host sets mode, seats and starts, and a start needs two seated Houses', () => {
    const h = new RoomHarness(1);
    const a = h.join('A').playerId;
    const b = h.join('B').playerId;
    h.take(a);
    h.take(b);
    for (const m of [{ t: 'mode', mode: 'blitz' }, { t: 'start' }, { t: 'aifill', on: false }, { t: 'seat', seat: 3, ai: false }] as ClientMsg[]) {
      h.send(b, m);
      expect(only(h.take(b), 'error')[0]).toMatchObject({ code: 'host' });
    }
    expect(h.core.room.status).toBe('lobby');
    h.send(a, { t: 'seat', seat: 1, ai: false }); // a seat taken by a human cannot be changed
    expect(only(h.take(a), 'error')[0]).toMatchObject({ code: 'lobby' });
    // Pure PvP with a lone human cannot start
    const solo = new RoomHarness(2);
    const s = solo.join('Solo').playerId;
    solo.send(s, { t: 'aifill', on: false });
    solo.send(s, { t: 'start' });
    expect(only(solo.take(s), 'error').pop()).toMatchObject({ code: 'lobby', message: 'Add an AI rival or invite a player first' });
    expect(solo.core.room.status).toBe('lobby');
  });

  it('Houses are picked in the lobby and swapped, never doubled', () => {
    const h = new RoomHarness(1);
    const a = h.join('A').playerId;
    const b = h.join('B').playerId;
    h.send(a, { t: 'lobby', house: 1 });
    expect(h.core.room.seats[1].house).toBe(1);
    expect(only(h.take(a), 'error')).toHaveLength(1); // B is human on House 1: taken
    h.send(a, { t: 'lobby', house: 3 });
    expect(h.core.room.seats[0].house).toBe(3);
    expect(h.core.room.seats[3].house).toBe(0); // the AI swapped
    h.send(b, { t: 'lobby', house: 9 });
    expect(only(h.take(b), 'error').pop()).toMatchObject({ message: 'Unknown House' });
    const houses = h.core.room.seats.map((s) => s.house).sort();
    expect(houses).toEqual([0, 1, 2, 3]);
  });

  it('the next connected human becomes host when the creator leaves the lobby', () => {
    const h = new RoomHarness(1);
    const a = h.join('A').playerId;
    h.join('B');
    h.disconnect(a);
    expect(h.core.room.host).toBe(1);
    expect(h.core.room.seats[0]).toMatchObject({ kind: 'open', playerId: null }); // the vacated host seat reopens
  });
});

describe('starting a match', () => {
  it('sends every seat its welcome and its own private state; spectators get no private view', () => {
    const { h, ids } = startedRoom(2);
    expect(h.core.room.status).toBe('playing');
    expect(h.core.game!.players.map((p) => p.kind)).toEqual(['human', 'human', 'ai', 'ai']);
    for (const [i, id] of ids.entries()) {
      h.send(id, { t: 'hello' }); // a hello on a live socket is inert
      const st = h.core.stateFor(id)[0] as Extract<ServerMsg, { t: 'state' }>;
      expect(st).toMatchObject({ t: 'state', turn: 1, phase: 'planning', player: i, own: { draft: [], revision: 0, ready: false, epoch: 0 } });
      expect(st.hash).toBe(hashNow(h));
      expect(st.summary).toBeNull();
      expect(st.seats).toHaveLength(4);
      expect(st.seats.filter((s) => s.ready).map((s) => s.kind)).toEqual(['ai', 'ai']);
    }
    const sp = h.join('Spec');
    expect(sp.seat).toBe(-1);
    const st = only(h.take(sp.playerId), 'state')[0];
    expect(st.own).toBeNull();
    expect(st.player).toBe(-1);
  });

  it('a room that has started refuses lobby changes and a second start', () => {
    const { h, ids } = startedRoom(2);
    for (const m of [{ t: 'start' }, { t: 'mode', mode: 'standard' }, { t: 'lobby', name: 'x' }] as ClientMsg[]) {
      h.send(ids[0], m);
      expect(only(h.take(ids[0]), 'error')[0]).toMatchObject({ code: 'lobby' });
    }
    expect(turnOf(h)).toBe(1);
  });
});

describe('drafts', () => {
  it('are private to the seat: acknowledged to it, never sent to rivals or spectators', () => {
    const { h, ids } = startedRoom(2);
    const spec = h.join('Spec').playerId;
    h.take(spec);
    h.take(ids[1]);
    h.send(ids[0], { t: 'draft', turn: 1, revision: 1, orders: borrow });
    expect(only(h.take(ids[0]), 'draftAck')).toEqual([{ t: 'draftAck', turn: 1, revision: 1 }]);
    expect(h.take(ids[1])).toEqual([]);
    expect(h.take(spec)).toEqual([]);
    // The draft is only ever shown back to its own seat.
    const own = (h.core.stateFor(ids[0])[0] as Extract<ServerMsg, { t: 'state' }>).own!;
    expect(own.draft).toEqual(borrow);
    expect(JSON.stringify(h.core.stateFor(ids[1]))).not.toContain('borrow');
    expect(JSON.stringify(h.core.stateFor(spec))).not.toContain('borrow');
  });

  it('keep only the newest revision: older and duplicate revisions are never applied', () => {
    const { h, ids } = startedRoom(2);
    const A = ids[0];
    const rev = (r: number, orders: Order[]) => h.send(A, { t: 'draft', turn: 1, revision: r, orders });
    const ack = () => only(h.take(A), 'draftAck').pop()!.revision;
    rev(1, borrow);
    expect(ack()).toBe(1);
    rev(1, [{ t: 'repay' }]); // duplicate revision with different content: not applied
    expect(ack()).toBe(1);
    expect(h.core.room.drafts[0].orders).toEqual(borrow);
    rev(3, [{ t: 'borrow' }, { t: 'borrow' }]); // skipping ahead is fine
    expect(ack()).toBe(3);
    rev(2, []); // an older revision arrives late
    expect(ack()).toBe(3);
    expect(h.core.room.drafts[0].orders).toHaveLength(2);
    rev(0, []);
    expect(ack()).toBe(3);
    expect(h.core.room.drafts[0].revision).toBe(3);
  });

  it('naming any turn other than the current one is rejected as offTurnDraft and never stored', () => {
    const { h, ids } = startedRoom(2);
    const A = ids[0];
    for (const turn of [0, 2, 3, 99, -1]) {
      h.send(A, { t: 'draft', turn, revision: 5, orders: borrow });
      expect(h.take(A)).toEqual([{ t: 'error', code: 'offTurnDraft', message: `Turn ${turn} is not the current turn`, turn: 1 }]);
    }
    expect(h.core.room.drafts[0]).toEqual({ orders: [], revision: 0 });
    // After a resolution, a draft for the resolved turn is off-turn too
    h.send(A, { t: 'draft', turn: 1, revision: 1, orders: borrow });
    ready(h, A, 1, 0);
    ready(h, ids[1]);
    expect(turnOf(h)).toBe(2);
    h.take(A);
    h.send(A, { t: 'draft', turn: 1, revision: 2, orders: borrow });
    expect(only(h.take(A), 'error')[0]).toMatchObject({ code: 'offTurnDraft', turn: 2 });
    expect(h.core.room.drafts[0]).toEqual({ orders: [], revision: 0 });
  });

  it('a Ready seat cannot edit without cancelling first (readyLocked)', () => {
    const { h, ids } = startedRoom(2);
    const A = ids[0];
    h.send(A, { t: 'draft', turn: 1, revision: 1, orders: borrow });
    ready(h, A, 1, 0);
    h.take(A);
    h.send(A, { t: 'draft', turn: 1, revision: 2, orders: [] });
    expect(h.take(A)).toEqual([{ t: 'error', code: 'readyLocked', message: 'Cancel Ready before editing your draft', turn: 1, revision: 1, epoch: 1 }]);
    expect(h.core.room.drafts[0].orders).toEqual(borrow);
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 1 });
    h.send(A, { t: 'draft', turn: 1, revision: 2, orders: [] });
    expect(only(h.take(A), 'draftAck').pop()).toEqual({ t: 'draftAck', turn: 1, revision: 2 });
  });

  it('are refused before a match runs, from spectators, and after it ends', () => {
    const h = new RoomHarness(1);
    const a = h.join('A').playerId;
    h.send(a, { t: 'draft', turn: 1, revision: 1, orders: [] });
    expect(only(h.take(a), 'error').pop()).toMatchObject({ code: 'notPlaying' });
    const { h: r, ids } = startedRoom(2);
    const sp = r.join('S').playerId;
    r.take(sp);
    r.send(sp, { t: 'draft', turn: 1, revision: 1, orders: [] });
    r.send(sp, { t: 'ready', turn: 1, revision: 0, epoch: 0 });
    r.send(sp, { t: 'cancelReady', turn: 1, epoch: 0 });
    expect(only(r.take(sp), 'error').map((e) => e.code)).toEqual(['spectator', 'spectator', 'spectator']);
    expect(r.core.room.ready.some(Boolean)).toBe(false);
    void ids;
  });
});

describe('readiness epochs', () => {
  it('start at 0, rise by exactly 1 per accepted Ready / Cancel Ready, and the Ready flag follows', () => {
    const { h, ids } = startedRoom(2);
    const [A] = ids;
    const acks = () => only(h.take(A), 'readyAck');
    ready(h, A);
    expect(acks()).toEqual([{ t: 'readyAck', turn: 1, ready: true, epoch: 1 }]);
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 1 });
    expect(acks()).toEqual([{ t: 'readyAck', turn: 1, ready: false, epoch: 2 }]);
    // A fresh, deliberate Ready on the unchanged draft (same revision) at the new epoch is recorded.
    ready(h, A, 0, 2);
    expect(acks()).toEqual([{ t: 'readyAck', turn: 1, ready: true, epoch: 3 }]);
    expect(h.core.room.epochs[0]).toBe(3);
    expect(h.core.room.ready[0]).toBe(true);
  });

  it('duplicate, delayed or replayed Ready / Cancel Ready change nothing and are answered with the current flag and epoch', () => {
    const { h, ids } = startedRoom(2);
    const [A] = ids;
    ready(h, A); // ready@1
    h.take(A);
    const before = snap(h);
    ready(h, A); // duplicate press: same epoch 0
    expect(h.take(A)).toEqual([{ t: 'readyAck', turn: 1, ready: true, epoch: 1 }]);
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 0 }); // stale cancel
    expect(h.take(A)).toEqual([{ t: 'readyAck', turn: 1, ready: true, epoch: 1 }]);
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 7 }); // future epoch
    expect(h.take(A)).toEqual([{ t: 'readyAck', turn: 1, ready: true, epoch: 1 }]);
    expect(snap(h)).toBe(before);
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 1 }); // -> planning@2
    h.take(A);
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 1 }); // duplicate cancel never un-readies a re-readied seat
    expect(h.take(A)).toEqual([{ t: 'readyAck', turn: 1, ready: false, epoch: 2 }]);
    ready(h, A, 0, 2); // ready@3
    h.take(A);
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 1 }); // the old cancel, delayed
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 1 });
    expect(only(h.take(A), 'readyAck')).toEqual([
      { t: 'readyAck', turn: 1, ready: true, epoch: 3 },
      { t: 'readyAck', turn: 1, ready: true, epoch: 3 },
    ]);
    ready(h, A, 0, 0); // the first Ready, replayed: a stale Ready never re-readies
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 3 });
    h.take(A);
    ready(h, A, 0, 0); // ... never re-readies a seat that has cancelled
    ready(h, A, 0, 2);
    expect(only(h.take(A), 'readyAck')).toEqual([
      { t: 'readyAck', turn: 1, ready: false, epoch: 4 },
      { t: 'readyAck', turn: 1, ready: false, epoch: 4 },
    ]);
    expect(h.core.room.ready[0]).toBe(false);
    expect(h.core.room.epochs[0]).toBe(4);
  });

  it('a Ready for an unacknowledged draft revision is rejected as staleDraft: nothing recorded, epoch unchanged', () => {
    const { h, ids } = startedRoom(2);
    const [A] = ids;
    h.send(A, { t: 'draft', turn: 1, revision: 1, orders: borrow });
    h.take(A);
    const before = snap(h);
    for (const rev of [0, 2, 5]) {
      ready(h, A, rev, 0);
      expect(h.take(A)).toEqual([{ t: 'error', code: 'staleDraft', message: 'Draft not saved yet — Ready not recorded', turn: 1, revision: 1, epoch: 0 }]);
    }
    expect(snap(h)).toBe(before);
    expect(h.core.room.ready[0]).toBe(false);
    ready(h, A, 1, 0); // acknowledged revision: recorded
    expect(only(h.take(A), 'readyAck')[0]).toMatchObject({ ready: true, epoch: 1 });
  });

  it('public status shows the Ready flag, never the epoch', () => {
    const { h, ids } = startedRoom(2);
    const spec = h.join('Spec').playerId;
    h.take(ids[1]);
    h.take(spec);
    ready(h, ids[0]);
    const seatsMsgs = [...h.take(ids[1]), ...h.take(spec)];
    expect(seatsMsgs.map((m) => m.t)).toEqual(['seats', 'seats']);
    for (const m of seatsMsgs) {
      expect(JSON.stringify(m)).not.toMatch(/epoch|revision|draft/);
      expect((m as Extract<ServerMsg, { t: 'seats' }>).seats.map((s) => s.ready)).toEqual([true, false, true, true]);
    }
  });

  it('a Charter is required on Council turns: Ready is refused with a prompt until one is drafted', () => {
    const { h, ids } = startedRoom(1, 'blitz');
    const [A] = ids;
    for (let t = 1; t < 5; t++) {
      ready(h, A);
      expect(turnOf(h)).toBe(t + 1);
    }
    expect(h.core.game!.council).not.toBeNull();
    h.take(A);
    ready(h, A);
    expect(h.take(A)).toEqual([{ t: 'error', code: 'needCharter', message: 'Choose a Charter', turn: 5, revision: 0, epoch: 0 }]);
    expect(h.core.room.epochs[0]).toBe(0);
    const key = h.core.game!.council!.offers[0][0];
    h.send(A, { t: 'draft', turn: 5, revision: 1, orders: [{ t: 'charter', key }] });
    ready(h, A, 1, 0);
    expect(turnOf(h)).toBe(6);
    expect(h.core.game!.players[0].charters).toEqual([key]);
  });
});

describe('resolution', () => {
  it('happens exactly once, at the moment the last human seat is Ready, and sends one message with state and summary together', () => {
    const { h, ids } = startedRoom(2);
    const spec = h.join('Spec').playerId;
    for (const id of [...ids, spec]) h.take(id);
    const h0 = hashNow(h);
    ready(h, ids[0]);
    expect(turnOf(h)).toBe(1);
    expect(hashNow(h)).toBe(h0); // frozen while waiting
    expect(h.core.room.lastResolved).toBe(0);
    const out = ready(h, ids[1]);
    expect(turnOf(h)).toBe(2);
    expect(h.core.room.lastResolved).toBe(1);
    expect(h.core.room.log).toHaveLength(1);
    expect(h.core.room.hashes).toEqual([hashNow(h)]);
    const resolved = out.filter((o) => o.msg.t === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].to).toBe('*');
    const m = resolved[0].msg as Extract<ServerMsg, { t: 'resolved' }>;
    expect(m.turn).toBe(2);
    expect(m.game.turn).toBe(2);
    expect(m.hash).toBe(hashNow(h));
    expect(m.summary).toMatchObject({ from: 1, to: 2 });
    expect(m.summary).toBe(h.core.room.summary);
    for (const id of [...ids, spec]) {
      const got = h.take(id);
      expect(only(got, 'resolved')).toHaveLength(1);
      expect(only(got, 'state')).toHaveLength(0); // no separate state/summary pair to desynchronise
      expect(JSON.stringify(only(got, 'resolved')[0])).not.toMatch(/"epoch"|"draft"|"revision"|"own"/);
    }
    // Everything per-turn starts fresh.
    expect(h.core.room.ready).toEqual([false, false, false, false]);
    expect(h.core.room.epochs).toEqual([0, 0, 0, 0]);
    expect(h.core.room.drafts.every((d) => d.revision === 0 && d.orders.length === 0)).toBe(true);
  });

  it('applies exactly the revisions each seat had acknowledged when it was recorded Ready', () => {
    const { h, ids } = startedRoom(2);
    h.send(ids[0], { t: 'draft', turn: 1, revision: 1, orders: [{ t: 'borrow' }] });
    h.send(ids[0], { t: 'draft', turn: 1, revision: 2, orders: [{ t: 'borrow' }, { t: 'borrow' }] });
    h.send(ids[1], { t: 'draft', turn: 1, revision: 4, orders: [{ t: 'borrow' }] });
    h.send(ids[0], { t: 'draft', turn: 1, revision: 1, orders: [] }); // late and older: ignored
    ready(h, ids[0], 2, 0);
    ready(h, ids[1], 4, 0);
    expect(turnOf(h)).toBe(2);
    expect(h.core.room.log[0][0]).toEqual([{ t: 'borrow' }, { t: 'borrow' }]);
    expect(h.core.room.log[0][1]).toEqual([{ t: 'borrow' }]);
    expect(h.core.game!.players[0].debt).toBe(800);
  });

  it('exactly-once under duplicate, racing and cancelling readies', () => {
    const { h, ids } = startedRoom(2);
    const [A, B] = ids;
    ready(h, A);
    ready(h, A);
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 1 }); // A withdraws ...
    expect(h.core.room.ready[0]).toBe(false);
    ready(h, B); // ... so B's Ready completes nothing
    expect(turnOf(h)).toBe(1);
    ready(h, A, 0, 2); // A readies again: now complete
    expect(turnOf(h)).toBe(2);
    // The race is over: a Cancel Ready for Turn 1 processed after is off-turn
    h.take(A);
    h.take(B);
    const hash = hashNow(h);
    h.send(A, { t: 'cancelReady', turn: 1, epoch: 3 });
    ready(h, B, 0, 1);
    ready(h, B, 0, 1);
    expect(turnOf(h)).toBe(2);
    expect(hashNow(h)).toBe(hash);
    expect(h.core.room.log).toHaveLength(1);
    expect(h.core.room.lastResolved).toBe(1);
  });

  it('two last seats readying together: the second recorded Ready resolves, once', () => {
    const { h, ids } = startedRoom(3);
    ready(h, ids[0]);
    ready(h, ids[2]);
    const out = [...ready(h, ids[1]), ...ready(h, ids[1]), ...ready(h, ids[2], 0, 0)];
    expect(out.filter((o) => o.msg.t === 'resolved')).toHaveLength(1);
    expect(turnOf(h)).toBe(2);
  });

  it('AI Houses are always Ready and the world waits for humans: no timer, ping or reconnect resolves a turn', () => {
    const { h, ids } = startedRoom(2);
    for (let i = 0; i < 50; i++) {
      h.send(ids[0], { t: 'ping', at: i });
      h.disconnect(ids[1]);
      h.join('x', ids[1]);
    }
    expect(turnOf(h)).toBe(1);
    expect(h.core.room.lastResolved).toBe(0);
  });

  it('one human against AIs resolves on that human\'s single Ready, a whole match, one turn per Ready', () => {
    const { h, ids } = startedRoom(1, 'blitz');
    for (let t = 1; t <= 16; t++) {
      expect(turnOf(h)).toBe(t);
      const g = h.core.game!;
      const orders: Order[] = g.council ? [{ t: 'charter', key: g.council.offers[0][0] }] : [];
      if (orders.length) h.send(ids[0], { t: 'draft', turn: t, revision: 1, orders });
      ready(h, ids[0], orders.length ? 1 : 0, 0);
    }
    expect(h.core.room.status).toBe('ended');
    expect(h.core.game!.phase).toBe('ended');
    expect(h.core.room.log).toHaveLength(16);
    expect(h.core.room.lastResolved).toBe(16);
    expect(h.core.game!.winner).toBeGreaterThanOrEqual(0);
  });
});

describe('off-turn Ready and Cancel Ready', () => {
  /** Turn N resolved to N+1 (and further): replay messages naming old / future turns. */
  function offTurnReplies(extraTurns: number) {
    const { h, ids } = startedRoom(2);
    const [A, B] = ids;
    h.send(A, { t: 'draft', turn: 1, revision: 1, orders: borrow });
    ready(h, A, 1, 0);
    ready(h, B);
    for (let i = 0; i < extraTurns; i++) {
      ready(h, A);
      ready(h, B);
    }
    h.take(A);
    h.take(B);
    return { h, A, B };
  }

  it.each([0, 1, 2])('naming Turn 1 while Turn %i + 2 is current: one state for the CURRENT turn with its own attached summary, to that seat only', (extra) => {
    const { h, A, B } = offTurnReplies(extra);
    const cur = turnOf(h);
    expect(cur).toBe(2 + extra);
    const before = snap(h);
    const hash = hashNow(h);
    const replays: ClientMsg[] = [
      { t: 'ready', turn: 1, revision: 1, epoch: 0 },
      { t: 'ready', turn: 1, revision: 0, epoch: 5 },
      { t: 'cancelReady', turn: 1, epoch: 1 },
      { t: 'cancelReady', turn: 1, epoch: 0 },
      { t: 'ready', turn: cur + 1, revision: 0, epoch: 0 },
      { t: 'cancelReady', turn: cur + 7, epoch: 0 },
      { t: 'ready', turn: 0, revision: 0, epoch: 0 },
      { t: 'cancelReady', turn: -3, epoch: 0 },
      { t: 'ready', turn: 999999, revision: 0, epoch: 0 },
    ];
    for (const m of replays) {
      const out = h.send(A, m);
      expect(out).toHaveLength(1);
      expect(out[0].to).toBe(A);
      const st = out[0].msg as Extract<ServerMsg, { t: 'state' }>;
      expect(st.t).toBe('state');
      expect(st.turn).toBe(cur);
      expect(st.game.turn).toBe(cur);
      expect(st.hash).toBe(hash);
      expect(st.phase).toBe('planning');
      // The summary is the one attached to the current state, whatever turn the message named.
      expect(st.summary).toBe(h.core.room.summary);
      expect(st.summary).toMatchObject({ from: cur - 1, to: cur });
      expect(st.own).toEqual({ draft: [], revision: 0, ready: false, epoch: 0 });
      expect(st.player).toBe(0);
      expect(st.seats.map((s) => s.ready)).toEqual([false, false, true, true]);
    }
    expect(snap(h)).toBe(before); // no flag, epoch, draft, turn or hash changed; nothing resolved
    expect(h.take(B)).toEqual([]); // nothing sent to anyone else
    expect(h.take(A)).toHaveLength(replays.length);
  });

  it('carries the seat\'s current-turn draft, Ready flag and epoch', () => {
    const { h, A } = offTurnReplies(1);
    h.send(A, { t: 'draft', turn: 3, revision: 1, orders: borrow });
    ready(h, A, 1, 0);
    h.send(A, { t: 'cancelReady', turn: 3, epoch: 1 });
    ready(h, A, 1, 2); // ready @ epoch 3
    h.take(A);
    const out = h.send(A, { t: 'ready', turn: 2, revision: 1, epoch: 0 });
    const st = out[0].msg as Extract<ServerMsg, { t: 'state' }>;
    expect(st.own).toEqual({ draft: borrow, revision: 1, ready: true, epoch: 3 });
    expect(st.seats[0].ready).toBe(true);
    expect(h.core.room.epochs[0]).toBe(3);
  });

  it('a state for the first turn (no summary yet) attaches null, never a summary chosen by the named turn', () => {
    const { h, ids } = startedRoom(2);
    const out = h.send(ids[0], { t: 'ready', turn: 5, revision: 0, epoch: 0 });
    expect((out[0].msg as Extract<ServerMsg, { t: 'state' }>).summary).toBeNull();
    expect((out[0].msg as Extract<ServerMsg, { t: 'state' }>).turn).toBe(1);
  });

  it('after the match ended, Ready and Cancel Ready get the current (ended) state and change nothing', () => {
    const { h, ids } = startedRoom(1, 'blitz');
    for (let t = 1; t <= 16; t++) {
      const g = h.core.game!;
      if (g.council) h.send(ids[0], { t: 'draft', turn: t, revision: 1, orders: [{ t: 'charter', key: g.council.offers[0][0] }] });
      ready(h, ids[0], g.council ? 1 : 0, 0);
    }
    h.take(ids[0]);
    const before = snap(h);
    const out = [...h.send(ids[0], { t: 'ready', turn: 17, revision: 0, epoch: 0 }), ...h.send(ids[0], { t: 'cancelReady', turn: 16, epoch: 0 }), ...h.send(ids[0], { t: 'ready', turn: 16, revision: 0, epoch: 0 })];
    expect(out.every((o) => o.msg.t === 'state' && o.msg.phase === 'ended' && o.to === ids[0])).toBe(true);
    expect(snap(h)).toBe(before);
    h.send(ids[0], { t: 'draft', turn: 17, revision: 1, orders: [] });
    expect(only(h.take(ids[0]), 'error').pop()).toMatchObject({ code: 'notPlaying' });
  });
});

describe('reconnect, spectators and heartbeats', () => {
  it('a reconnecting seat gets one full state: its draft, Ready flag and epoch, every seat\'s status, the latest summary', () => {
    const { h, ids } = startedRoom(2);
    const [A, B] = ids;
    h.send(A, { t: 'draft', turn: 1, revision: 1, orders: borrow });
    ready(h, A, 1, 0);
    h.disconnect(A);
    expect(h.core.room.seats[0].connected).toBe(false);
    const hash = hashNow(h);
    h.take(A);
    h.take(B);
    const back = h.join(undefined, A);
    expect(back.seat).toBe(0);
    expect(back.playerId).toBe(A);
    const got = h.take(A);
    expect(got.map((m) => m.t)).toEqual(['welcome', 'lobby', 'state', 'seats']);
    const st = only(got, 'state')[0];
    expect(st.own).toEqual({ draft: borrow, revision: 1, ready: true, epoch: 1 });
    expect(st.seats[0]).toMatchObject({ ready: true, connected: true });
    expect(hashNow(h)).toBe(hash);
    expect(turnOf(h)).toBe(1);
    // B sees only public presence
    expect(h.take(B).every((m) => m.t === 'lobby' || m.t === 'seats')).toBe(true);
  });

  it('a seat that returns after its turn resolved gets the new turn: empty revision-0 draft, Planning at epoch 0, the N→N+1 summary', () => {
    const { h, ids } = startedRoom(2);
    const [A, B] = ids;
    h.send(A, { t: 'draft', turn: 1, revision: 1, orders: borrow });
    ready(h, A, 1, 0);
    h.disconnect(A);
    ready(h, B);
    expect(turnOf(h)).toBe(2);
    expect(h.core.game!.players[0].debt).toBe(400); // A's revision 1 was applied
    h.join(undefined, A);
    const st = only(h.take(A), 'state')[0];
    expect(st.turn).toBe(2);
    expect(st.summary).toMatchObject({ from: 1, to: 2 });
    expect(st.own).toEqual({ draft: [], revision: 0, ready: false, epoch: 0 });
    expect(st.hash).toBe(hashNow(h));
    // Its cached Turn 1 work, if it were ever resent, is refused and answered with the current state.
    h.send(A, { t: 'draft', turn: 1, revision: 2, orders: borrow });
    expect(only(h.take(A), 'error')[0]).toMatchObject({ code: 'offTurnDraft', turn: 2 });
    const out = h.send(A, { t: 'ready', turn: 1, revision: 1, epoch: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].msg).toMatchObject({ t: 'state', turn: 2 });
    expect(h.core.room.ready[0]).toBe(false);
    expect(h.core.room.epochs[0]).toBe(0);
  });

  it('seats are reserved: never auto-readied, timed out or handed to an AI when their player leaves', () => {
    const { h, ids } = startedRoom(2);
    h.disconnect(ids[1]);
    ready(h, ids[0]);
    expect(turnOf(h)).toBe(1);
    expect(h.core.room.seats[1]).toMatchObject({ kind: 'human', playerId: ids[1], connected: false });
    expect(h.core.game!.players[1].kind).toBe('human');
    const back = h.join(undefined, ids[1]);
    expect(back.seat).toBe(1);
    ready(h, ids[1]);
    expect(turnOf(h)).toBe(2);
  });

  it('an unknown playerId joins a running match as a spectator: no seat, no drafts, no epochs', () => {
    const { h, ids } = startedRoom(2);
    h.send(ids[0], { t: 'draft', turn: 1, revision: 1, orders: borrow });
    const sp = h.join('Late', 'someone-else');
    expect(sp.seat).toBe(-1);
    const all = h.delivered.filter((d) => d.to === sp.playerId).map((d) => d.msg);
    expect(all.map((m) => m.t)).toEqual(['welcome', 'lobby', 'state', 'seats']);
    expect(JSON.stringify(all)).not.toMatch(/"epoch"|"revision"|"draft"|borrow/);
    expect(only(all, 'state')[0].own).toBeNull();
    ready(h, ids[0], 1, 0);
    ready(h, ids[1]);
    const later = h.take(sp.playerId);
    expect(only(later, 'resolved')).toHaveLength(1);
    expect(later.every((m) => ['seats', 'resolved', 'lobby', 'state', 'welcome'].includes(m.t))).toBe(true);
    expect(JSON.stringify(later)).not.toMatch(/"epoch"|"draft"|"revision"/);
  });

  it('heartbeats are transport only: they never touch state, readiness or the hash', () => {
    const { h, ids } = startedRoom(2);
    ready(h, ids[0]);
    h.take(ids[0]);
    const before = snap(h);
    for (let i = 0; i < 100; i++) {
      const out = h.send(ids[i % 2], { t: 'ping', at: i });
      expect(out).toEqual([{ to: ids[i % 2], msg: { t: 'pong', at: i } }]);
    }
    h.send('nobody', { t: 'ping', at: 5 });
    expect(snap(h)).toBe(before);
  });

  it('messages from unknown sockets are refused', () => {
    const { h } = startedRoom(2);
    const out = h.send('ghost', { t: 'ready', turn: 1, revision: 0, epoch: 0 });
    expect(out).toEqual([{ to: 'ghost', msg: { t: 'error', code: 'spectator', message: 'Spectators cannot act' } }]);
  });
});

describe('persistence and rematch', () => {
  it('a restored core (JSON round-trip, as the Durable Object does) carries on identically', () => {
    const { h, ids } = startedRoom(2);
    h.send(ids[0], { t: 'draft', turn: 1, revision: 1, orders: borrow });
    ready(h, ids[0], 1, 0);
    const copy = JSON.parse(snap(h)) as ReturnType<RoomCore['serialize']>;
    const h2 = new RoomHarness(0, 'ABCD', new RoomCore('ABCD', 0, copy));
    ready(h2, ids[1]);
    ready(h, ids[1]);
    expect(h2.core.game!.turn).toBe(2);
    expect(stateHash(h2.core.game!)).toBe(hashNow(h));
    expect(h2.core.room.log).toEqual(h.core.room.log);
    // A duplicate Ready after the restore is still idempotent
    const out = h2.send(ids[0], { t: 'ready', turn: 1, revision: 1, epoch: 1 });
    expect(out).toHaveLength(1);
  });

  it('the host can rematch or continue in Endless after the final turn; others cannot', () => {
    const { h, ids } = startedRoom(1, 'blitz');
    h.send(ids[0], { t: 'rematch' });
    expect(only(h.take(ids[0]), 'error').pop()).toMatchObject({ code: 'lobby' });
    for (let t = 1; t <= 16; t++) {
      const g = h.core.game!;
      if (g.council) h.send(ids[0], { t: 'draft', turn: t, revision: 1, orders: [{ t: 'charter', key: g.council.offers[0][0] }] });
      ready(h, ids[0], g.council ? 1 : 0, 0);
    }
    expect(h.core.room.status).toBe('ended');
    const snapshot = JSON.stringify(h.core.room.log);
    h.send(ids[0], { t: 'endless' });
    expect(h.core.room.status).toBe('playing');
    expect(turnOf(h)).toBe(17);
    expect(h.core.game!.endless).toBe(true);
    expect(h.core.room.log).toHaveLength(16);
    ready(h, ids[0]);
    expect(turnOf(h)).toBe(18);
    expect(h.core.room.log).toHaveLength(17);
    expect(JSON.stringify(h.core.room.log.slice(0, 16))).toBe(snapshot);
  });

  it('a rematch starts a fresh match with a new seed', () => {
    const { h, ids } = startedRoom(1, 'blitz');
    const first = h.core.room.config!.seed;
    for (let t = 1; t <= 16; t++) {
      const g = h.core.game!;
      if (g.council) h.send(ids[0], { t: 'draft', turn: t, revision: 1, orders: [{ t: 'charter', key: g.council.offers[0][0] }] });
      ready(h, ids[0], g.council ? 1 : 0, 0);
    }
    h.send(ids[0], { t: 'rematch' });
    expect(h.core.room.matchNo).toBe(2);
    expect(h.core.room.config!.seed).not.toBe(first);
    expect(turnOf(h)).toBe(1);
    expect(h.core.room.log).toEqual([]);
    expect(h.core.room.lastResolved).toBe(0);
    expect(playerOf(h, ids[0])).toBe(0);
  });
});

describe('wire parsing', () => {
  it('accepts well-formed frames and rejects malformed ones', () => {
    const ok = (m: unknown) => parseClientMsg(JSON.stringify(m));
    expect(ok({ t: 'ready', turn: 3, revision: 2, epoch: 1 })).toEqual({ t: 'ready', turn: 3, revision: 2, epoch: 1 });
    expect(ok({ t: 'cancelReady', turn: 3, epoch: 1 })).toEqual({ t: 'cancelReady', turn: 3, epoch: 1 });
    expect(ok({ t: 'draft', turn: 1, revision: 1, orders: [{ t: 'borrow' }] })).toEqual({ t: 'draft', turn: 1, revision: 1, orders: [{ t: 'borrow' }] });
    expect(ok({ t: 'ping', at: 5 })).toEqual({ t: 'ping', at: 5 });
    expect(ok({ t: 'start' })).toEqual({ t: 'start' });
    expect(ok({ t: 'hello', playerId: 'abc', lastTurn: 4 })).toMatchObject({ t: 'hello', playerId: 'abc', lastTurn: 4 });
    const bad: unknown[] = [
      { t: 'ready', turn: 1, revision: 1 },
      { t: 'ready', turn: 1.5, revision: 1, epoch: 0 },
      { t: 'ready', turn: '1', revision: 1, epoch: 0 },
      { t: 'ready', turn: 1e12, revision: 1, epoch: 0 },
      { t: 'cancelReady', turn: 1 },
      { t: 'draft', turn: 1, revision: 1, orders: [{ t: 'nope' }] },
      { t: 'draft', turn: 1, revision: 1 },
      { t: 'mode', mode: 'tycoon' },
      { t: 'seat', seat: 1 },
      { t: 'zzz' },
      [],
      null,
      7,
    ];
    for (const b of bad) expect(ok(b), JSON.stringify(b)).toBeNull();
    expect(parseClientMsg(null)).toBeNull();
    expect(parseClientMsg('')).toBeNull();
    expect(parseClientMsg('{nope')).toBeNull();
    expect(parseClientMsg('x'.repeat(70000))).toBeNull();
  });
});
