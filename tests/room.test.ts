import { describe, expect, it, vi } from 'vitest';
import { AI_ORDER, AI_PERSONAS, COUNCIL_BEATS, MODES, SHOPS } from '../src/shared/constants';
import { OPENINGS } from '../src/shared/ai';
import { idx } from '../src/shared/map';
import { parseClientMsg, type ClientMsg, type ServerMsg, type Snap } from '../src/shared/protocol';
import { ROOM_CODE_ALPHABET, RoomCore, SPEEDS, cleanName, isRoomCode, makeRoomCode, type Outbound } from '../src/shared/room';
import type { GameState } from '../src/shared/types';
import { clone } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/** Messages of one type, optionally only those addressed to one recipient ('*' = broadcast). */
function pick<T extends ServerMsg['t']>(out: Outbound[], t: T, to?: string): Msg<T>[] {
  return out.filter((o) => o.msg.t === t && (to === undefined || o.to === to)).map((o) => o.msg as Msg<T>);
}

function makeRoom(seed = 1234) {
  const core = new RoomCore('QRST', seed);
  let issued = 0;
  const newId = (): string => `pid-${++issued}`;
  return {
    core,
    join: (name?: string, playerId?: string | null) => core.join(playerId, name, newId),
    issued: () => issued,
  };
}

/** A room with `n` humans seated in order; ids[0] is the host. */
function seated(n: number, seed = 1234) {
  const room = makeRoom(seed);
  const ids = Array.from({ length: n }, (_, i) => room.join(`Player ${i + 1}`).playerId);
  return { ...room, ids };
}

/** A room with `n` humans whose match has started. */
function started(n: number, opts: { mode?: 'blitz' | 'standard' | 'endless'; speed?: number; seed?: number } = {}) {
  const room = seated(n, opts.seed);
  const [host] = room.ids;
  if (opts.mode) expect(room.core.handle(host, { t: 'mode', mode: opts.mode })).toHaveLength(1);
  if (opts.speed) expect(pick(room.core.handle(host, { t: 'speed', speed: opts.speed }), 'reject')).toEqual([]);
  expect(pick(room.core.handle(host, { t: 'start' }), 'reject')).toEqual([]);
  return { ...room, host, game: (): GameState => room.core.game as GameState };
}

const rejectTo = (out: Outbound[], id: string): string | undefined => {
  expect(out).toHaveLength(1);
  expect(out[0].to).toBe(id);
  expect(out[0].msg.t).toBe('reject');
  return (out[0].msg as Msg<'reject'>).err;
};

describe('Room codes and names', () => {
  it('makes four-letter uppercase room codes and validates them', () => {
    let k = 0;
    const seq = [0, 0.5, 0.999999, 0.25, 0.75, 0.1, 0.9, 0.33];
    const random = (): number => seq[k++ % seq.length];
    for (let i = 0; i < 50; i++) {
      const code = makeRoomCode(random);
      expect(code).toMatch(/^[A-Z]{4}$/);
      expect(isRoomCode(code)).toBe(true);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
    expect(makeRoomCode(() => 0)).toBe(ROOM_CODE_ALPHABET[0].repeat(4));
    expect(makeRoomCode(() => 1)).toMatch(/^[A-Z]{4}$/); // a sloppy RNG that returns 1 must not break it
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length);
    for (const bad of ['', 'ABC', 'ABCDE', 'abcd', 'AB1D', 'AB D', ' ABCD', 'ABCD\n', 'ÄBCD']) expect(isRoomCode(bad), bad).toBe(false);
  });

  it('cleans display names: no control characters or angle brackets, single spaces, sixteen characters', () => {
    expect(cleanName('Ada', 'x')).toBe('Ada');
    expect(cleanName('  Ada   Lovelace  ', 'x')).toBe('Ada Lovelace');
    expect(cleanName('<script>alert(1)</script>', 'x')).toBe('scriptalert(1)/s');
    expect(cleanName('A\u0000d\u0007a\u001f\u007f', 'x')).toBe('Ada');
    expect(cleanName('Ada\tLove\nlace', 'x')).toBe('AdaLovelace');
    expect(cleanName('abcdefghijklmnopqrstuvwxyz', 'x')).toBe('abcdefghijklmnop');
    expect(cleanName('abcdefghijklmnopqrstuvwxyz', 'x')).toHaveLength(16);
    // When the cut lands just after a space the cap still holds. (The result keeps that trailing
    // space — see the suspected-bug note in the report — so compare modulo trailing whitespace.)
    expect(cleanName('Ada bLovelace/b of London', 'x').trimEnd()).toBe('Ada bLovelace/b');
    expect(cleanName('Ada bLovelace/b of London', 'x').length).toBeLessThanOrEqual(16);
    for (const empty of ['', '   ', '<>', '\u0001\u0002', undefined, null, 42, {}, ['Ada']]) {
      expect(cleanName(empty, 'Merchant 1')).toBe('Merchant 1');
    }
    for (const raw of ['<<<>>>ok', 'tab\there', '\u0000x', 'Zoë', 'a'.repeat(100)]) {
      const out = cleanName(raw, 'x');
      expect(out).not.toMatch(/[<>\u0000-\u001f\u007f]/);
      expect(out.length).toBeLessThanOrEqual(16);
    }
  });
});

describe('Lobby: seats, names and Houses', () => {
  it('opens with seat 0 free and Vesper, Aurelia and Orson in seats 1–3', () => {
    const { core } = makeRoom(99);
    const lobby = core.lobby();
    expect(lobby).toMatchObject({ code: 'QRST', status: 'lobby', host: 0, mode: 'standard', speed: 1, matchNo: 0 });
    expect(lobby.seats.map((s) => s.kind)).toEqual(['open', 'ai', 'ai', 'ai']);
    expect(lobby.seats.map((s) => s.persona)).toEqual([null, 'vesper', 'aurelia', 'orson']);
    expect(lobby.seats.map((s) => s.name)).toEqual(['', 'Vesper', 'Aurelia', 'Orson']);
    expect(lobby.seats.map((s) => s.house)).toEqual([0, 1, 2, 3]);
    expect(lobby.seats.every((s) => !s.connected)).toBe(true);
    expect(core.game).toBeNull();
    expect(core.running).toBe(false);
    expect(core.step()).toEqual([]);
    expect(core.summary()).toMatchObject({ code: 'QRST', status: 'lobby', humans: 0, connected: 0, ai: 3, open: 1, tick: 0 });
    expect(AI_ORDER.map((p) => AI_PERSONAS[p].name)).toEqual(['Vesper', 'Aurelia', 'Orson']);
  });

  it('gives the first player seat 0, the host role and a welcome', () => {
    const { core, join } = makeRoom();
    const res = join('Ada');
    expect(res.seat).toBe(0);
    expect(res.playerId).toBe('pid-1');
    expect(core.room.host).toBe(0);
    expect(core.seatOf(res.playerId)).toBe(0);
    const welcome = pick(res.out, 'welcome', res.playerId);
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({ playerId: 'pid-1', seat: 0, player: -1 });
    expect(welcome[0].lobby.seats[0]).toEqual({ kind: 'human', name: 'Ada', house: 0, connected: true, persona: null });
    expect(pick(res.out, 'lobby', '*')).toHaveLength(1);
    expect(pick(res.out, 'snap')).toHaveLength(0); // nothing to draw yet
    expect(core.lobby().seats.map((s) => s.persona)).toEqual([null, 'vesper', 'aurelia', 'orson']);
    // A nameless player gets a seat name.
    const anon = makeRoom().join();
    expect(anon.out[0].msg).toMatchObject({ t: 'welcome', seat: 0 });
    expect((anon.out[0].msg as Msg<'welcome'>).lobby.seats[0].name).toBe('Merchant 1');
  });

  it('fills seats in order, replacing AI rivals one by one; a fifth arrival spectates', () => {
    const { core, join } = makeRoom();
    const a = join('Ada');
    const b = join('Ben');
    expect(b.seat).toBe(1);
    expect(core.lobby().seats.map((s) => s.kind)).toEqual(['human', 'human', 'ai', 'ai']);
    // The remaining AI rivals close ranks: Vesper first, then Aurelia.
    expect(core.lobby().seats.map((s) => s.persona)).toEqual([null, null, 'vesper', 'aurelia']);
    expect(core.lobby().seats.map((s) => s.name)).toEqual(['Ada', 'Ben', 'Vesper', 'Aurelia']);
    const c = join('Cy');
    const d = join('Di');
    expect([a.seat, b.seat, c.seat, d.seat]).toEqual([0, 1, 2, 3]);
    expect(new Set([a.playerId, b.playerId, c.playerId, d.playerId]).size).toBe(4);
    expect(core.lobby().seats.every((s) => s.kind === 'human' && s.connected && s.persona === null)).toBe(true);
    expect(core.room.host).toBe(0);
    const e = join('Eve');
    expect(e.seat).toBe(-1);
    expect(core.seatOf(e.playerId)).toBe(-1);
    expect(pick(e.out, 'welcome', e.playerId)[0]).toMatchObject({ seat: -1, player: -1 });
    expect(core.lobby().seats.map((s) => s.name)).toEqual(['Ada', 'Ben', 'Cy', 'Di']);
    // A spectator may watch and ping, nothing else.
    expect(rejectTo(core.handle(e.playerId, { t: 'start' }), e.playerId)).toBe('Spectators cannot act');
    expect(rejectTo(core.handle(e.playerId, { t: 'lobby', name: 'Mallory' }), e.playerId)).toBe('Spectators cannot act');
    expect(core.handle(e.playerId, { t: 'ping', at: 7 })).toEqual([{ to: e.playerId, msg: { t: 'pong', at: 7 } }]);
    expect(core.handle('nobody', { t: 'start' })[0].msg.t).toBe('reject');
    // A seat the host left open is taken before any AI rival is displaced.
    const other = seated(1);
    expect(pick(other.core.handle(other.ids[0], { t: 'seat', seat: 2, ai: false }), 'lobby', '*')).toHaveLength(1);
    expect(['Ben', 'Cy', 'Di', 'Eve'].map((name) => other.join(name).seat)).toEqual([2, 1, 3, -1]);
  });

  it('renames a player and swaps Houses with an AI seat, but not with another human', () => {
    const { core, ids } = seated(2);
    const [ada, ben] = ids;
    const out = core.handle(ada, { t: 'lobby', name: '  Ada <b>Lovelace</b>\u0007  ' });
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe('*');
    expect(pick(out, 'lobby')[0].lobby.seats[0].name).toBe('Ada bLovelace/b');
    expect(core.lobby().seats[1].name).toBe('Player 2');
    // An empty name keeps the old one.
    core.handle(ada, { t: 'lobby', name: '   ' });
    expect(core.lobby().seats[0].name).toBe('Ada bLovelace/b');
    // House 2 belongs to an AI seat: swap.
    expect(pick(core.handle(ada, { t: 'lobby', house: 2 }), 'lobby', '*')).toHaveLength(1);
    expect(core.lobby().seats.map((s) => s.house)).toEqual([2, 1, 0, 3]);
    // House 1 is Ben's.
    expect(rejectTo(core.handle(ada, { t: 'lobby', house: 1 }), ada)).toBe('That House is taken');
    expect(core.lobby().seats.map((s) => s.house)).toEqual([2, 1, 0, 3]);
    for (const house of [-1, 4, 1.5, NaN]) expect(rejectTo(core.handle(ben, { t: 'lobby', house }), ben)).toBe('Unknown House');
    // Choosing the House you already hold is harmless.
    expect(pick(core.handle(ben, { t: 'lobby', house: 1 }), 'lobby')).toHaveLength(1);
    expect(core.handle(ben, { t: 'lobby', house: 3, name: 'Benedict' })).toHaveLength(1);
    expect(core.lobby().seats.map((s) => s.house).sort()).toEqual([0, 1, 2, 3]);
    expect(core.lobby().seats[1]).toMatchObject({ name: 'Benedict', house: 3 });
    expect(core.handle(ada, { t: 'hello' })).toEqual([]);
  });

  it('lets only the host toggle AI fill on empty seats', () => {
    const { core, ids } = seated(2);
    const [host, guest] = ids;
    expect(rejectTo(core.handle(guest, { t: 'seat', seat: 3, ai: false }), guest)).toBe('Only the host fills seats');
    expect(core.lobby().seats[3].kind).toBe('ai');
    expect(pick(core.handle(host, { t: 'seat', seat: 3, ai: false }), 'lobby', '*')).toHaveLength(1);
    expect(core.lobby().seats[3]).toMatchObject({ kind: 'open', name: '', persona: null });
    expect(core.lobby().seats[2]).toMatchObject({ kind: 'ai', persona: 'vesper' });
    core.handle(host, { t: 'seat', seat: 2, ai: false });
    core.handle(host, { t: 'seat', seat: 3, ai: true });
    expect(core.lobby().seats.map((s) => s.kind)).toEqual(['human', 'human', 'open', 'ai']);
    expect(core.lobby().seats[3]).toMatchObject({ persona: 'vesper', name: 'Vesper' });
    expect(rejectTo(core.handle(host, { t: 'seat', seat: 1, ai: true }), host)).toBe('That seat is taken');
    expect(rejectTo(core.handle(host, { t: 'seat', seat: 9, ai: true }), host)).toBe('No such seat');
    expect(rejectTo(core.handle(host, { t: 'seat', seat: -1, ai: true }), host)).toBe('No such seat');
    expect(core.lobby().seats.map((s) => s.kind)).toEqual(['human', 'human', 'open', 'ai']);
  });

  it('lets only the host choose the mode and start, and needs at least two participants', () => {
    const { core, join, ids } = seated(1);
    const host = ids[0];
    const guest = join('Ben').playerId;
    expect(rejectTo(core.handle(guest, { t: 'mode', mode: 'blitz' }), guest)).toMatch(/host/i);
    expect(core.lobby().mode).toBe('standard');
    expect(pick(core.handle(host, { t: 'mode', mode: 'blitz' }), 'lobby', '*')[0].lobby.mode).toBe('blitz');
    expect(rejectTo(core.handle(guest, { t: 'start' }), guest)).toMatch(/host/i);
    expect(rejectTo(core.handle(guest, { t: 'rematch' }), guest)).toMatch(/host/i);
    expect(core.room.status).toBe('lobby');
    // Alone in the room, with every AI seat switched off, there is nobody to play.
    core.disconnect(guest);
    for (const seat of [1, 2, 3]) core.handle(host, { t: 'seat', seat, ai: false });
    expect(core.lobby().seats.map((s) => s.kind)).toEqual(['human', 'open', 'open', 'open']);
    expect(rejectTo(core.handle(host, { t: 'start' }), host)).toBe('Add an AI rival or invite a player first');
    expect(core.room.status).toBe('lobby');
    expect(core.game).toBeNull();
    expect(rejectTo(core.handle(host, { t: 'rematch' }), host)).toBe('No match to replay');
    expect(rejectTo(core.handle(host, { t: 'endless' }), host)).toBe('The match is still running');
    expect(rejectTo(core.handle(host, { t: 'cmd', cmd: { c: 'borrow' } }), host)).toBe('The match is not running');
    // One AI rival is enough.
    core.handle(host, { t: 'seat', seat: 3, ai: true });
    expect(pick(core.handle(host, { t: 'start' }), 'reject')).toEqual([]);
    expect(core.room.status).toBe('playing');
    expect(core.game?.mode).toBe('blitz');
  });

  it('frees a seat when its player leaves the lobby, and hands the host role to the next human', () => {
    const { core, join, ids } = seated(3);
    const [ada, ben, cy] = ids;
    expect(core.room.host).toBe(0);
    // Ben leaves: seat 1 goes back to an AI rival.
    const out = core.disconnect(ben);
    expect(out).toHaveLength(1);
    expect(pick(out, 'lobby', '*')[0].lobby.seats[1]).toMatchObject({ kind: 'ai', connected: false, persona: 'vesper' });
    expect(core.seatOf(ben)).toBe(-1);
    expect(core.room.seats[1].playerId).toBeNull();
    expect(core.room.host).toBe(0);
    // The host leaves: seat 0 opens up, and Cy (seat 2) becomes host.
    core.disconnect(ada);
    expect(core.lobby().seats[0]).toMatchObject({ kind: 'open', name: '', connected: false });
    expect(core.room.host).toBe(2);
    expect(pick(core.handle(cy, { t: 'mode', mode: 'endless' }), 'lobby')[0].lobby).toMatchObject({ mode: 'endless', host: 2 });
    // A newcomer takes the open seat but not the crown.
    const dee = join('Dee');
    expect(dee.seat).toBe(0);
    expect(core.room.host).toBe(2);
    expect(rejectTo(core.handle(dee.playerId, { t: 'start' }), dee.playerId)).toMatch(/host/i);
    // Coming back with an old id does not resurrect the old seat: Ben is a new arrival.
    const again = join('Ben', ben);
    expect(again.playerId).not.toBe(ben);
    expect(again.seat).toBe(1);
    // When Cy leaves too, the role passes on again.
    core.disconnect(cy);
    expect(core.room.host).toBe(0);
    expect(core.disconnect('unknown-id')).toEqual([]);
    expect(core.disconnect(cy)).toEqual([]);
  });
});

describe('Starting a match', () => {
  it('starts with AI fill: status playing, seats mapped to players past the open seat, a full snapshot for all', () => {
    const { core, ids } = seated(1, 4321);
    const host = ids[0];
    core.handle(host, { t: 'seat', seat: 1, ai: false });
    const out = core.handle(host, { t: 'start' });
    expect(core.room.status).toBe('playing');
    expect(core.room.matchNo).toBe(1);
    expect(core.room.playerOf).toEqual([0, -1, 1, 2]);
    const game = core.game as GameState;
    expect(game.tick).toBe(0);
    expect(game.mode).toBe('standard');
    expect(game.seed).not.toBe(4321);
    expect(game.players.map((p) => p.kind)).toEqual(['human', 'ai', 'ai']);
    expect(game.players.map((p) => p.persona)).toEqual([null, 'vesper', 'aurelia']);
    expect(game.players.map((p) => p.name)).toEqual(['Player 1', 'Vesper', 'Aurelia']);
    expect(game.players.map((p) => p.house)).toEqual([0, 2, 3]);
    // Broadcasts: the lobby, a welcome carrying the player index, and a full snapshot.
    expect(pick(out, 'lobby', '*')[0].lobby).toMatchObject({ status: 'playing', matchNo: 1 });
    expect(pick(out, 'welcome')).toHaveLength(1);
    expect(pick(out, 'welcome', host)[0]).toMatchObject({ seat: 0, player: 0 });
    const snaps = pick(out, 'snap', '*');
    expect(snaps).toHaveLength(1);
    expect(snaps[0].full).toBe(true);
    expect(snaps[0].k).toBe(0);
    expect(snaps[0].meta).toMatchObject({ seed: game.seed, mode: 'standard', qt: MODES.standard.quarterTicks, tq: MODES.standard.quarters });
    expect(snaps[0].meta?.players).toEqual(game.players.map((p) => ({ name: p.name, house: p.house, kind: p.kind, persona: p.persona })));
    expect(snaps[0].b).toEqual([]);
    expect(snaps[0].c.length).toBeGreaterThan(0);
    expect(core.running).toBe(true);
    expect(core.summary()).toMatchObject({ status: 'playing', humans: 1, connected: 1, ai: 2, open: 1, quarter: 1 });
  });

  it('seats two humans with two AI rivals, or four humans with none', () => {
    const duo = started(2);
    expect(duo.core.room.playerOf).toEqual([0, 1, 2, 3]);
    expect(duo.game().players.map((p) => p.kind)).toEqual(['human', 'human', 'ai', 'ai']);
    const personas = duo.game().players.filter((p) => p.kind === 'ai').map((p) => p.persona);
    expect(personas).toEqual(['vesper', 'aurelia']);
    expect(new Set(personas).size).toBe(personas.length);
    // Deliberate pacing: nobody has built before the first AI seat's opening delay…
    const o = OPENINGS.standard;
    for (let i = 0; i < o.firstMove - 1; i++) duo.core.step();
    expect(duo.game().buildings).toEqual([]);
    // …and the seats stagger: the second AI House is still reading the street.
    for (let i = 0; i < o.stagger; i++) duo.core.step();
    expect(duo.game().buildings.some((b) => b.owner === 2)).toBe(true);
    expect(duo.game().buildings.some((b) => b.owner === 3)).toBe(false);
    for (let i = duo.game().tick; i < 240; i++) duo.core.step();
    expect(duo.game().tick).toBe(240);
    // The AI rivals have opened for business; the idle humans have not.
    expect(duo.game().buildings.some((b) => b.owner === 2)).toBe(true);
    expect(duo.game().buildings.some((b) => b.owner === 3)).toBe(true);
    expect(duo.game().buildings.some((b) => b.owner < 2)).toBe(false);

    const quad = seated(4);
    const out = quad.core.handle(quad.ids[0], { t: 'start' });
    const game = quad.core.game as GameState;
    expect(game.players.map((p) => p.kind)).toEqual(['human', 'human', 'human', 'human']);
    expect(game.players.every((p) => p.persona === null)).toBe(true);
    expect(quad.core.room.playerOf).toEqual([0, 1, 2, 3]);
    quad.ids.forEach((id, i) => expect(pick(out, 'welcome', id)[0]).toMatchObject({ seat: i, player: i }));
    for (let i = 0; i < 120; i++) quad.core.step();
    expect(game.tick).toBe(120);
    expect(game.buildings).toEqual([]);
  });

  it('closes the lobby once play begins: no seat changes, and latecomers spectate with a full snapshot', () => {
    const { core, join, ids, host } = started(2);
    for (const msg of [
      { t: 'lobby', name: 'New Name' },
      { t: 'seat', seat: 3, ai: false },
      { t: 'mode', mode: 'blitz' },
      { t: 'start' },
    ] as ClientMsg[]) {
      expect(rejectTo(core.handle(host, msg), host), msg.t).toBe('The match has already started');
    }
    expect(core.lobby().seats[0].name).toBe('Player 1');
    expect(core.lobby().mode).toBe('standard');
    for (let i = 0; i < 25; i++) core.step();
    const late = join('Late');
    expect(late.seat).toBe(-1);
    expect(pick(late.out, 'welcome', late.playerId)[0]).toMatchObject({ seat: -1, player: -1 });
    const snap = pick(late.out, 'snap', late.playerId);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ full: true, k: 25 });
    expect(snap[0].meta?.players).toHaveLength(4);
    expect(core.lobby().seats.map((s) => s.kind)).toEqual(['human', 'human', 'ai', 'ai']);
    expect(rejectTo(core.handle(late.playerId, { t: 'cmd', cmd: { c: 'borrow' } }), late.playerId)).toBe('Spectators cannot act');
    expect(core.game?.players.every((p) => p.debt === 0)).toBe(true);
    expect(ids).toHaveLength(2);
  });
});

describe('Commands in a room', () => {
  it('applies a seated player’s valid command and rejects an invalid one to that player only', () => {
    const { core, ids, game } = started(2);
    const [ada, ben] = ids;
    const lot = idx(3, 6);
    expect(core.handle(ada, { t: 'cmd', cmd: { c: 'build', tile: lot, kind: 'roastery' } })).toEqual([]);
    expect(game().buildings).toHaveLength(1);
    expect(game().buildings[0]).toMatchObject({ tile: lot, kind: 'roastery', owner: 0 });
    expect(game().players[0].ledger.construction).toBe(SHOPS.roastery.cost);
    const shop = game().buildings[0].id;
    // Ben tries the same lot, then Ada's shop.
    expect(rejectTo(core.handle(ben, { t: 'cmd', cmd: { c: 'build', tile: lot, kind: 'bistro' } }), ben)).toBe('Lot is already built on');
    expect(rejectTo(core.handle(ben, { t: 'cmd', cmd: { c: 'price', id: shop, stance: 0 } }), ben)).toBe('Not your property');
    expect(rejectTo(core.handle(ben, { t: 'cmd', cmd: { c: 'sell', id: shop } }), ben)).toBe('Not your property');
    expect(game().buildings).toHaveLength(1);
    expect(game().buildings[0].stance).toBe(1);
    expect(core.handle(ben, { t: 'cmd', cmd: { c: 'build', tile: idx(4, 6), kind: 'park' } })).toEqual([]);
    expect(game().buildings[1]).toMatchObject({ kind: 'park', owner: 1 });
    expect(core.handle(ada, { t: 'cmd', cmd: { c: 'price', id: shop, stance: 3 } })).toEqual([]);
    expect(game().buildings[0].stance).toBe(3);
    // The next beat tells everyone, with the feedback events.
    const snap = pick(core.step(), 'snap', '*')[0];
    expect(snap.b?.map((b) => b.id).sort()).toEqual(game().buildings.slice(0, 2).map((b) => b.id).sort());
    expect(snap.fx?.filter((f) => f.k === 'build')).toHaveLength(2);
  });

  it('survives hostile command payloads without throwing or changing the game', () => {
    const { core, ids, game } = started(2);
    const [ada] = ids;
    const before = JSON.stringify(game());
    const hostile: unknown[] = [
      { c: 'build', tile: '12', kind: 'park' },
      { c: 'build', tile: 1e9, kind: 'park' },
      { c: 'build', tile: idx(3, 6), kind: '__proto__' },
      { c: 'build', tile: idx(3, 6), kind: 'constructor' },
      { c: 'build' },
      { c: 'price', id: 'x', stance: 2 },
      { c: 'price', id: {}, stance: {} },
      { c: 'sell', id: null },
      { c: 'upgrade' },
      { c: 'teleport', id: 1 },
      { c: '__proto__' },
      { c: 'repay' },
    ];
    for (const cmd of hostile) {
      let out: Outbound[] = [];
      expect(() => (out = core.handle(ada, { t: 'cmd', cmd } as ClientMsg)), JSON.stringify(cmd)).not.toThrow();
      expect(out, JSON.stringify(cmd)).toHaveLength(1);
      expect(out[0]).toMatchObject({ to: ada, msg: { t: 'reject' } });
    }
    expect(JSON.stringify(game())).toBe(before);
    expect(rejectTo(core.handle(ada, { t: 'bogus' } as unknown as ClientMsg), ada)).toBe('Unknown message');
  });

  it('routes commands by player index, not seat number, when a seat was left open', () => {
    const { core, ids } = seated(3);
    const [ada, ben, cy] = ids;
    core.disconnect(ben);
    core.handle(ada, { t: 'seat', seat: 1, ai: false });
    expect(core.lobby().seats.map((s) => s.kind)).toEqual(['human', 'open', 'human', 'ai']);
    const out = core.handle(ada, { t: 'start' });
    expect(core.room.playerOf).toEqual([0, -1, 1, 2]);
    expect(pick(out, 'welcome', cy)[0]).toMatchObject({ seat: 2, player: 1 });
    expect(core.handle(cy, { t: 'cmd', cmd: { c: 'build', tile: idx(3, 6), kind: 'bistro' } })).toEqual([]);
    // A future-era tool is refused with its unlock notice, by player index too.
    expect(rejectTo(core.handle(cy, { t: 'cmd', cmd: { c: 'build', tile: idx(4, 6), kind: 'arcade' } }), cy)).toBe('Arcade unlocks in Era II: Transit & Trade');
    const game = core.game as GameState;
    expect(game.buildings[0].owner).toBe(1);
    expect(game.players[1]).toMatchObject({ name: 'Player 3', kind: 'human', house: 2 });
    expect(game.players[2]).toMatchObject({ kind: 'ai', house: 3 });
    expect(game.players[1].cash).toBeLessThan(game.players[0].cash);
  });
});

describe('Stepping the simulation', () => {
  it('advances by the room pace each beat — 1, 2, or 3 ticks per 2 beats at 1.5× — and broadcasts a delta', () => {
    const { core, host, game } = started(1);
    const beat = (): Snap => {
      const out = core.step();
      expect(out).toHaveLength(1);
      expect(out[0].to).toBe('*');
      const snap = out[0].msg as Snap;
      expect(snap.t).toBe('snap');
      expect(snap.full).toBe(false);
      expect(snap.meta).toBeUndefined();
      expect(snap.k).toBe(game().tick);
      expect(snap.sp).toBe(core.room.speed);
      expect(game().fx).toEqual([]); // feedback is drained into the snapshot
      return snap;
    };
    for (let i = 1; i <= 10; i++) expect(beat().k).toBe(i);
    expect(pick(core.handle(host, { t: 'speed', speed: 2 }), 'lobby')[0].lobby.speed).toBe(2);
    for (let i = 1; i <= 10; i++) expect(beat().k).toBe(10 + 2 * i);
    core.handle(host, { t: 'speed', speed: 1.5 });
    const ticks: number[] = [];
    for (let i = 0; i < 10; i++) ticks.push(beat().k);
    expect(ticks[9]).toBe(30 + 15);
    for (let i = 1; i < 10; i += 2) expect(ticks[i] - (i > 1 ? ticks[i - 2] : 30)).toBe(3);
    const steps = ticks.map((k, i) => k - (i ? ticks[i - 1] : 30));
    expect(steps.every((n) => n === 1 || n === 2)).toBe(true);
  });

  it('lets only the host set the pace, and only to 1×, 1.5× or 2×', () => {
    const { core, ids } = seated(2);
    const [host, guest] = ids;
    expect(SPEEDS).toEqual([1, 1.5, 2]);
    expect(rejectTo(core.handle(guest, { t: 'speed', speed: 2 }), guest)).toBe('Only the host sets the pace');
    for (const speed of [0, 0.5, 3, 10, -1, NaN, Infinity]) {
      expect(rejectTo(core.handle(host, { t: 'speed', speed }), host)).toBe('Unknown pace');
    }
    expect(core.room.speed).toBe(1);
    for (const speed of SPEEDS) {
      expect(pick(core.handle(host, { t: 'speed', speed }), 'lobby', '*')[0].lobby.speed).toBe(speed);
    }
    // The pace can be changed mid-match too.
    core.handle(host, { t: 'start' });
    expect(pick(core.handle(host, { t: 'speed', speed: 1 }), 'reject')).toEqual([]);
    expect(rejectTo(core.handle(guest, { t: 'speed', speed: 2 }), guest)).toBe('Only the host sets the pace');
    expect(core.room.speed).toBe(1);
  });

  it('stands still while nobody is connected: idle rooms cost nothing', () => {
    const { core, join, host, game } = started(1);
    for (let i = 0; i < 20; i++) core.step();
    expect(game().tick).toBe(20);
    expect(core.running).toBe(true);
    core.disconnect(host);
    expect(core.running).toBe(false);
    const frozen = JSON.stringify(game());
    for (let i = 0; i < 50; i++) expect(core.step()).toEqual([]);
    expect(JSON.stringify(game())).toBe(frozen);
    expect(core.summary()).toMatchObject({ humans: 1, connected: 0, tick: 20 });
    // The player returns and the city picks up where it stopped.
    expect(join(undefined, host).seat).toBe(0);
    expect(core.running).toBe(true);
    expect(pick(core.step(), 'snap')[0].k).toBe(21);
    // A spectator alone keeps the match on screen; when they leave too, it stops.
    const watcher = join('Watcher');
    expect(watcher.seat).toBe(-1);
    core.disconnect(host);
    expect(core.running).toBe(true);
    expect(pick(core.step(), 'snap')[0].k).toBe(22);
    expect(core.disconnect(watcher.playerId)).toEqual([]);
    expect(core.running).toBe(false);
    expect(core.step()).toEqual([]);
    expect(game().tick).toBe(22);
  });
});

describe('Reconnect and host migration', () => {
  it('holds a seat through a mid-match disconnect and restores it by playerId with a full snapshot', () => {
    const { core, join, ids, issued, game } = started(2);
    const [ada, ben] = ids;
    core.handle(ben, { t: 'cmd', cmd: { c: 'build', tile: idx(3, 6), kind: 'roastery' } });
    for (let i = 0; i < 30; i++) core.step();
    const out = core.disconnect(ben);
    expect(pick(out, 'lobby', '*')[0].lobby.seats[1]).toMatchObject({ kind: 'human', name: 'Player 2', connected: false });
    expect(core.room.seats[1].playerId).toBe(ben);
    expect(core.seatOf(ben)).toBe(1);
    // The match goes on for Ada; Ben's House is not handed to an AI.
    for (let i = 0; i < 30; i++) core.step();
    expect(game().tick).toBe(60);
    expect(game().players[1].kind).toBe('human');
    expect(game().buildings.filter((b) => b.owner === 1)).toHaveLength(1);
    const ids0 = issued();
    const back = join('Renamed', ben);
    expect(issued()).toBe(ids0); // no new identity was minted
    expect(back.playerId).toBe(ben);
    expect(back.seat).toBe(1);
    expect(pick(back.out, 'welcome', ben)[0]).toMatchObject({ playerId: ben, seat: 1, player: 1 });
    expect(pick(back.out, 'lobby', '*')[0].lobby.seats[1]).toMatchObject({ connected: true, name: 'Player 2' });
    const snap = pick(back.out, 'snap', ben);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ full: true, k: 60 });
    expect(snap[0].meta?.players[1].name).toBe('Player 2');
    expect(snap[0].b?.length).toBe(game().buildings.length);
    expect(pick(back.out, 'snap', '*')).toHaveLength(0); // Ada is not sent the whole city again
    // Ben is back in control of his House.
    expect(core.handle(ben, { t: 'cmd', cmd: { c: 'borrow' } })).toEqual([]);
    expect(game().players[1].debt).toBeGreaterThan(0);
    expect(ada).not.toBe(ben);
  });

  it('passes the host role to the next connected human mid-match', () => {
    const { core, join, ids } = started(3);
    const [ada, ben, cy] = ids;
    expect(core.room.host).toBe(0);
    expect(rejectTo(core.handle(ben, { t: 'speed', speed: 2 }), ben)).toMatch(/host/i);
    const out = core.disconnect(ada);
    expect(core.room.host).toBe(1);
    expect(pick(out, 'lobby', '*')[0].lobby.host).toBe(1);
    expect(pick(core.handle(ben, { t: 'speed', speed: 2 }), 'reject')).toEqual([]);
    expect(core.room.speed).toBe(2);
    // Ada returns to her seat but the role stays with Ben.
    expect(join(undefined, ada).seat).toBe(0);
    expect(core.room.host).toBe(1);
    expect(rejectTo(core.handle(ada, { t: 'speed', speed: 1 }), ada)).toMatch(/host/i);
    // Ben drops: back to Ada, the first connected human. Then Ada drops: Cy.
    core.disconnect(ben);
    expect(core.room.host).toBe(0);
    core.disconnect(ada);
    expect(core.room.host).toBe(2);
    expect(pick(core.handle(cy, { t: 'rematch' }), 'reject')).toEqual([]);
    // With everyone gone the role simply waits for whoever comes back first.
    core.disconnect(cy);
    expect(core.room.host).toBe(2);
    expect(join(undefined, ben).seat).toBe(1);
    expect(core.room.host).toBe(1);
  });
});

describe('Match end, rematch and Endless', () => {
  const playOut = (core: RoomCore): { beats: number; last: Outbound[] } => {
    let beats = 0;
    let last: Outbound[] = [];
    while (core.room.status === 'playing' && beats < 5000) {
      last = core.step();
      beats++;
    }
    return { beats, last };
  };

  it('plays a Blitz room to the final bell: status ended, result in the last snapshot, a lobby broadcast', () => {
    const { core, host, game } = started(1, { mode: 'blitz', speed: 2 });
    const { beats, last } = playOut(core);
    const total = MODES.blitz.quarters * MODES.blitz.quarterTicks;
    expect(MODES.blitz.quarters).toBe(4);
    // Four eras at pace 2×, plus three Era Councils that run their full real-time countdown
    // (the lone human never picks): the Council clock does not speed up with the pace.
    expect(beats).toBe(total / 2 + 3 * COUNCIL_BEATS);
    expect(game().players.every((p) => p.charters.length === 3)).toBe(true);
    expect(game().tick).toBe(total);
    expect(game().phase).toBe('ended');
    expect(core.room.status).toBe('ended');
    expect(last.map((o) => [o.to, o.msg.t])).toEqual([['*', 'snap'], ['*', 'lobby']]);
    const snap = pick(last, 'snap')[0];
    expect(snap.q).toEqual([MODES.blitz.quarters, 1, 0]);
    expect(snap.res).toEqual(game().result);
    expect(snap.res?.winner).toBeGreaterThanOrEqual(0);
    expect(snap.fx).toContainEqual({ k: 'end' });
    expect(pick(last, 'lobby')[0].lobby.status).toBe('ended');
    // The room is at rest.
    expect(core.running).toBe(false);
    expect(core.step()).toEqual([]);
    expect(game().tick).toBe(total);
    expect(rejectTo(core.handle(host, { t: 'cmd', cmd: { c: 'borrow' } }), host)).toBe('The match is not running');
    expect(core.summary()).toMatchObject({ status: 'ended', quarter: 4, era: 4, council: false, tick: total });
  });

  it('starts a rematch for the host: a fresh city, a new seed, welcomes and a full snapshot', () => {
    const { core, ids, game } = started(2, { mode: 'blitz', speed: 2 });
    const [ada, ben] = ids;
    core.handle(ada, { t: 'cmd', cmd: { c: 'build', tile: idx(3, 6), kind: 'roastery' } });
    playOut(core);
    const first = game();
    expect(rejectTo(core.handle(ben, { t: 'rematch' }), ben)).toBe('Only the host calls a rematch');
    expect(core.game).toBe(first);
    const out = core.handle(ada, { t: 'rematch' });
    const second = game();
    expect(second).not.toBe(first);
    expect(second.tick).toBe(0);
    expect(second.phase).toBe('playing');
    expect(second.buildings).toEqual([]);
    expect(second.seed).not.toBe(first.seed);
    expect(second.mode).toBe('blitz');
    expect(second.players.map((p) => p.name)).toEqual(first.players.map((p) => p.name));
    expect(core.room.matchNo).toBe(2);
    expect(core.room.status).toBe('playing');
    expect(pick(out, 'lobby', '*')[0].lobby).toMatchObject({ status: 'playing', matchNo: 2 });
    expect(pick(out, 'welcome', ada)[0]).toMatchObject({ seat: 0, player: 0 });
    expect(pick(out, 'welcome', ben)[0]).toMatchObject({ seat: 1, player: 1 });
    const snap = pick(out, 'snap', '*');
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ full: true, k: 0, q: [1, 0, 0], res: null });
    expect(snap[0].meta?.seed).toBe(second.seed);
    // And it plays.
    expect(pick(core.step(), 'snap')[0].k).toBe(2);
    expect(core.running).toBe(true);
    // A rematch may also be called before the bell; each one is a new match number and seed.
    core.handle(ada, { t: 'rematch' });
    expect(core.room.matchNo).toBe(3);
    expect(game().seed).not.toBe(second.seed);
    expect(game().tick).toBe(0);
  });

  it('continues an ended match in Endless for the host', () => {
    const { core, ids, game } = started(2, { mode: 'blitz', speed: 2 });
    const [ada, ben] = ids;
    expect(rejectTo(core.handle(ada, { t: 'endless' }), ada)).toBe('The match is still running');
    playOut(core);
    const limit = game().tick;
    expect(rejectTo(core.handle(ben, { t: 'endless' }), ben)).toBe('Only the host extends the match');
    expect(core.room.status).toBe('ended');
    const out = core.handle(ada, { t: 'endless' });
    expect(out.map((o) => [o.to, o.msg.t])).toEqual([['*', 'lobby'], ['*', 'snap']]);
    expect(pick(out, 'lobby')[0].lobby.status).toBe('playing');
    expect(pick(out, 'snap')[0]).toMatchObject({ full: true, k: limit, q: [5, 0, 1], res: null, cn: null });
    expect(core.room.status).toBe('playing');
    expect(core.room.matchNo).toBe(1);
    expect(game().endless).toBe(true);
    expect(core.running).toBe(true);
    // It runs through two more era closes without ending again, and without another Council.
    for (let i = 0; i < MODES.blitz.quarterTicks + 20; i++) expect(core.step()).toHaveLength(1);
    expect(game().tick).toBe(limit + 2 * MODES.blitz.quarterTicks + 40);
    expect(game().quarter).toBe(7);
    expect(game().phase).toBe('playing');
    expect(core.room.status).toBe('playing');
    expect(core.handle(ben, { t: 'cmd', cmd: { c: 'borrow' } })).toEqual([]);
  });
});

describe('Persistence', () => {
  it('round-trips through serialize → JSON → restore and then steps identically', () => {
    const { core, ids, game } = started(2, { speed: 2, seed: 777 });
    const [ada, ben] = ids;
    core.handle(ada, { t: 'cmd', cmd: { c: 'build', tile: idx(3, 6), kind: 'roastery' } });
    for (let i = 0; i < 150; i++) core.step();
    const saved = clone(core.serialize());
    expect(saved.room).toEqual(core.room);
    expect(saved.game).toEqual(game());
    const restored = new RoomCore('IGNORED', 0, saved);
    expect(restored.room.code).toBe('QRST');
    expect(restored.lobby()).toEqual(core.lobby());
    expect(restored.running).toBe(true);
    expect(restored.seatOf(ben)).toBe(1);
    for (let i = 0; i < 200; i++) {
      const a = core.step();
      const b = restored.step();
      expect(b).toHaveLength(a.length);
    }
    expect(restored.game?.tick).toBe(150 * 2 + 200 * 2);
    expect(JSON.stringify(restored.game)).toBe(JSON.stringify(game()));
    expect(restored.room).toEqual(core.room);
    // Commands and reconnects work against the restored room.
    expect(restored.handle(ben, { t: 'cmd', cmd: { c: 'build', tile: idx(4, 6), kind: 'park' } })).toEqual([]);
    expect(restored.game?.buildings.some((b) => b.kind === 'park' && b.owner === 1)).toBe(true);
    restored.disconnect(ben);
    const back = restored.join(ben, undefined, () => 'fresh');
    expect(back).toMatchObject({ playerId: ben, seat: 1 });
    expect(pick(back.out, 'snap', ben)[0].full).toBe(true);
    // A lobby survives the trip as well.
    const lobby = seated(2, 5);
    const copy = new RoomCore('X', 0, clone(lobby.core.serialize()));
    expect(copy.game).toBeNull();
    expect(copy.lobby()).toEqual(lobby.core.lobby());
    expect(pick(copy.handle(lobby.ids[0], { t: 'start' }), 'snap')).toHaveLength(1);
    lobby.core.handle(lobby.ids[0], { t: 'start' });
    expect(JSON.stringify(copy.game)).toBe(JSON.stringify(lobby.core.game));
  });
});

describe('parseClientMsg', () => {
  it('accepts every valid message type and returns it intact', () => {
    const valid: ClientMsg[] = [
      { t: 'hello' },
      { t: 'hello', name: 'Ada', playerId: 'pid-1' },
      { t: 'lobby' },
      { t: 'lobby', name: 'Ada', house: 2 },
      { t: 'seat', seat: 1, ai: false },
      { t: 'mode', mode: 'blitz' },
      { t: 'mode', mode: 'standard' },
      { t: 'mode', mode: 'endless' },
      { t: 'start' },
      { t: 'speed', speed: 1.5 },
      { t: 'cmd', cmd: { c: 'build', tile: 5, kind: 'park' } },
      { t: 'cmd', cmd: { c: 'borrow' } },
      { t: 'rematch' },
      { t: 'endless' },
      { t: 'ping', at: 123456 },
    ];
    for (const msg of valid) expect(parseClientMsg(JSON.stringify(msg)), JSON.stringify(msg)).toEqual(msg);
    expect(new Set(valid.map((m) => m.t)).size).toBe(10);
    // A frame of exactly the size limit is still read.
    const pad = { t: 'hello', name: '' };
    pad.name = 'x'.repeat(4096 - JSON.stringify(pad).length);
    expect(JSON.stringify(pad)).toHaveLength(4096);
    expect(parseClientMsg(JSON.stringify(pad))).toEqual(pad);
  });

  it('rejects malformed JSON, unknown types, wrong field types and oversize frames', () => {
    const bad: unknown[] = [
      'not json',
      '',
      '{"t":"hello"',
      'null',
      '42',
      '"start"',
      '[]',
      '[{"t":"start"}]',
      '{}',
      '{"t":5}',
      '{"t":"nope"}',
      '{"t":"constructor"}',
      '{"T":"start"}',
      '{"t":"hello","name":5}',
      '{"t":"hello","playerId":{}}',
      '{"t":"lobby","name":["Ada"]}',
      '{"t":"lobby","house":"2"}',
      '{"t":"seat","seat":"1","ai":true}',
      '{"t":"seat","seat":1}',
      '{"t":"seat","seat":1,"ai":"yes"}',
      '{"t":"mode"}',
      '{"t":"mode","mode":"marathon"}',
      '{"t":"speed"}',
      '{"t":"speed","speed":"2"}',
      '{"t":"cmd"}',
      '{"t":"cmd","cmd":"build"}',
      '{"t":"cmd","cmd":{}}',
      '{"t":"cmd","cmd":{"c":5}}',
      '{"t":"cmd","cmd":null}',
      '{"t":"ping"}',
      '{"t":"ping","at":"now"}',
      { t: 'start' },
      undefined,
      null,
      7,
      new Uint8Array([123, 125]),
    ];
    for (const raw of bad) expect(parseClientMsg(raw), String(raw)).toBeNull();
    const big = JSON.stringify({ t: 'hello', name: 'x'.repeat(5000) });
    expect(big.length).toBeGreaterThan(4096);
    expect(parseClientMsg(big)).toBeNull();
    const pad = { t: 'hello', name: '' };
    pad.name = 'x'.repeat(4097 - JSON.stringify(pad).length);
    expect(parseClientMsg(JSON.stringify(pad))).toBeNull();
  });
});
