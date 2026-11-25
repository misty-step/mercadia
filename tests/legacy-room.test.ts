// The legacy v2 Durable Object compatibility boundary, pure part: the strict storage classifier and the
// export-version guard. A deployed v2 (real-time) room stores 'room' and 'game' in SQLite `kv` just like v3,
// so the v3 object must classify what it finds. (The Durable Object itself is covered by worker-tests/.)
import { describe, expect, it } from 'vitest';
import { MATCH_EXPORT_VERSION, replayMatchExport } from '../src/shared/replay';
import { planAI } from '../src/shared/ai';
import { RoomCore, classifyStoredRoom, parseStoredTimestampMs } from '../src/shared/room';
import { RoomHarness } from './harness';
import lobbyRoom from './fixtures/v2/lobby.room.json?raw';
import runningGame from './fixtures/v2/running.game.json?raw';
import runningRoom from './fixtures/v2/running.room.json?raw';

const V2_LOBBY = { room: lobbyRoom, game: null as string | null };
const V2_RUNNING = { room: runningRoom, game: runningGame };

describe('classifyStoredRoom', () => {
  it('is empty only when neither key is stored', () => {
    expect(classifyStoredRoom(null, null)).toEqual({ kind: 'empty' });
    expect(classifyStoredRoom(null, '{}')).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom('', null)).toEqual({ kind: 'legacy' });
  });

  it('classifies the authentic deployed v2 lobby and running match as legacy', () => {
    expect(classifyStoredRoom(V2_LOBBY.room, null)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(V2_RUNNING.room, V2_RUNNING.game)).toEqual({ kind: 'legacy' });
    // the v2 fixtures really are real-time records
    expect(JSON.parse(V2_RUNNING.room)).toMatchObject({ speed: 1, acc: 0, status: 'playing' });
    expect(JSON.parse(V2_RUNNING.game).tick).toBe(200);
  });

  it('classifies corrupt and non-v3 records as legacy', () => {
    for (const bad of ['not json', 'null', '[]', '42', '{}', '{"code":"ABCD"}']) expect(classifyStoredRoom(bad, null)).toEqual({ kind: 'legacy' });
  });

  it('accepts v3 lobbies and started matches, and rejects v3 rooms carrying v2-only fields or a v2 game', () => {
    const lobby = new RoomCore('ABCD', 7);
    const c = classifyStoredRoom(JSON.stringify(lobby.room), null);
    expect(c.kind).toBe('v3');
    const started = new RoomCore('ABCD', 7);
    started.join(null, 'Ada', () => 'p1');
    started.handle('p1', { t: 'start' });
    const roomRaw = JSON.stringify(started.room);
    const gameRaw = JSON.stringify(started.game);
    const ok = classifyStoredRoom(roomRaw, gameRaw);
    expect(ok.kind).toBe('v3');
    if (ok.kind === 'v3') expect(ok.game?.turn).toBe(1);
    expect(classifyStoredRoom(JSON.stringify({ ...started.room, speed: 1 }), gameRaw)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(JSON.stringify({ ...started.room, acc: 0 }), gameRaw)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(roomRaw, V2_RUNNING.game)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(roomRaw, JSON.stringify({ ...started.game, tick: 3 }))).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(roomRaw, JSON.stringify({ ...started.game, phase: 'playing' }))).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(roomRaw, JSON.stringify({ ...started.game, version: 2 }))).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(JSON.stringify({ ...started.room, code: 'abcd' }), gameRaw)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(JSON.stringify({ ...started.room, hashes: 'x' }), gameRaw)).toEqual({ kind: 'legacy' });
  });

  it('Pass 5 case A: a started room missing room.status is legacy, never v3', () => {
    const started = new RoomCore('ABCD', 7);
    started.join(null, 'Ada', () => 'p1');
    started.handle('p1', { t: 'start' });
    const { status: _drop, ...rest } = started.room;
    expect(classifyStoredRoom(JSON.stringify(rest), JSON.stringify(started.game))).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(JSON.stringify({ ...started.room, status: 'paused' }), JSON.stringify(started.game))).toEqual({ kind: 'legacy' });
  });

  it('Pass 5 case B: a lobby with a null (or malformed) seat is legacy, never v3', () => {
    const lobby = new RoomCore('ABCD', 7);
    for (const bad of [null, 7, 'open', [], {}, { ...lobby.room.seats[1], kind: 'robot' }, { ...lobby.room.seats[1], name: 3 }, { ...lobby.room.seats[1], playerId: undefined }, { ...lobby.room.seats[1], connected: 'no' }, { ...lobby.room.seats[1], aiFill: 0 }]) {
      const seats = lobby.room.seats.map((s, i) => (i === 1 ? bad : s));
      expect(classifyStoredRoom(JSON.stringify({ ...lobby.room, seats }), null)).toEqual({ kind: 'legacy' });
    }
    expect(classifyStoredRoom(JSON.stringify({ ...lobby.room, seats: lobby.room.seats.slice(0, 3) }), null)).toEqual({ kind: 'legacy' });
  });

  it('Pass 6 case C: a lobby that still carries a genuine Turn 1 game row is legacy, never v3', () => {
    const started = new RoomCore('ABCD', 7);
    started.join(null, 'Ada', () => 'p1');
    started.handle('p1', { t: 'start' });
    const gameRaw = JSON.stringify(started.game);
    expect(classifyStoredRoom(JSON.stringify({ ...started.room, status: 'lobby' }), gameRaw)).toEqual({ kind: 'legacy' });
    // any other room/game pairing that disagrees is legacy too
    expect(classifyStoredRoom(JSON.stringify({ ...started.room, status: 'ended' }), gameRaw)).toEqual({ kind: 'legacy' });
    const ended = { ...(started.game as unknown as Record<string, unknown>), phase: 'ended' };
    expect(classifyStoredRoom(JSON.stringify(started.room), JSON.stringify(ended))).toEqual({ kind: 'legacy' });
    // cross-record coherence
    const room = started.room as unknown as Record<string, unknown>;
    for (const bad of [{ drafts: [] }, { ready: [] }, { epochs: [0, 0] }, { playerOf: [5, -1, -1, -1] }, { playerOf: [0.5, -1, -1, -1] }, { playerOf: [-2, -1, -1, -1] }, { lastResolved: 3 }, { lastResolved: -1 }, { hashes: ['x'] }]) {
      expect(classifyStoredRoom(JSON.stringify({ ...room, ...bad }), gameRaw)).toEqual({ kind: 'legacy' });
    }
    expect(classifyStoredRoom(JSON.stringify(started.room), gameRaw).kind).toBe('v3');
  });

  it('Pass 6 case D: a nested null or broken record inside the game is legacy, never v3', () => {
    const started = new RoomCore('ABCD', 7);
    started.join(null, 'Ada', () => 'p1');
    started.handle('p1', { t: 'start' });
    const roomRaw = JSON.stringify(started.room);
    const base = JSON.parse(JSON.stringify(started.game)) as Record<string, any>;
    const mutate = (fn: (g: Record<string, any>) => void): string => {
      const g = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      fn(g);
      return JSON.stringify(g);
    };
    const bad: [string, (g: Record<string, any>) => void][] = [
      ['players[0] = null', (g) => (g.players[0] = null)],
      ['players[1].cash NaN-ish', (g) => (g.players[1].cash = null)],
      ['players[0].sales = {}', (g) => (g.players[0].sales = {})],
      ['players[0].stats missing', (g) => delete g.players[0].stats],
      ['players[0].id wrong', (g) => (g.players[0].id = 3)],
      ['players[0].house 9', (g) => (g.players[0].house = 9)],
      ['players empty', (g) => (g.players = [])],
      ['units[0] = null', (g) => (g.units[0] = null)],
      ['units[0].owner out of range', (g) => (g.units[0].owner = 9)],
      ['units[0].tile out of range', (g) => (g.units[0].tile = 9999)],
      ['units[0].kind unknown', (g) => (g.units[0].kind = 'ox')],
      ['buildings[0] = null', (g) => g.buildings.push(null)],
      ['buildings owner out of range', (g) => g.buildings.push({ id: 1, owner: 7, kind: 'bistro', tile: 3, level: 1 })],
      ['pacts [null]', (g) => (g.pacts = [null])],
      ['chronicle [null]', (g) => (g.chronicle = [null])],
      ['standings [null]', (g) => (g.standings = [null])],
      ['trend missing', (g) => delete g.trend],
      ['honours null', (g) => (g.honours = null)],
      ['council malformed', (g) => (g.council = { era: 'x' })],
      ['turn 0', (g) => (g.turn = 0)],
      ['nextId 0', (g) => (g.nextId = 0)],
      ['winner -2', (g) => (g.winner = -2)],
      ['endless not boolean', (g) => (g.endless = 'no')],
    ];
    for (const [label, fn] of bad) expect(classifyStoredRoom(roomRaw, mutate(fn)), label).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(roomRaw, JSON.stringify(base)).kind).toBe('v3');
  });

  it('every other required RoomState field and nested element is validated strictly', () => {
    const started = new RoomCore('ABCD', 7);
    started.join(null, 'Ada', () => 'p1');
    started.handle('p1', { t: 'start' });
    const gameRaw = JSON.stringify(started.game);
    const room = started.room as unknown as Record<string, unknown>;
    const bad: Record<string, unknown> = {
      mode: 'rush',
      seed: 'x',
      host: 4,
      matchNo: 1.5,
      lastResolved: '1',
      playerOf: [0, 'a'],
      drafts: [null],
      ready: [1],
      epochs: ['0'],
      log: {},
      hashes: null,
      summaries: undefined,
    };
    for (const [k, v] of Object.entries(bad)) expect(classifyStoredRoom(JSON.stringify({ ...room, [k]: v }), gameRaw)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(JSON.stringify({ ...room, seed: null }), gameRaw)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(JSON.stringify({ ...room, host: -1 }), gameRaw)).toEqual({ kind: 'legacy' });
  });

  it('a started or ended room without its game, and a game that is not a full v3 Game, are legacy', () => {
    const started = new RoomCore('ABCD', 7);
    started.join(null, 'Ada', () => 'p1');
    started.handle('p1', { t: 'start' });
    const roomRaw = JSON.stringify(started.room);
    expect(classifyStoredRoom(roomRaw, null)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(JSON.stringify({ ...started.room, status: 'ended' }), null)).toEqual({ kind: 'legacy' });
    const g = started.game as unknown as Record<string, unknown>;
    expect(classifyStoredRoom(roomRaw, JSON.stringify({ ...g, players: 'x' }))).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(roomRaw, JSON.stringify({ ...g, units: null }))).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(roomRaw, 'not json')).toEqual({ kind: 'legacy' });
    // a stored game with no room at all is also legacy; only (null, null) is empty
    expect(classifyStoredRoom(null, JSON.stringify(g))).toEqual({ kind: 'legacy' });
  });

  it('a v3 room stored before exportVersion existed is still v3', () => {
    const c = new RoomCore('ABCD', 7);
    c.join(null, 'Ada', () => 'p1');
    c.handle('p1', { t: 'start' });
    const { exportVersion: _drop, ...rest } = c.room;
    expect(classifyStoredRoom(JSON.stringify(rest), JSON.stringify(c.game)).kind).toBe('v3');
  });
});

describe('export version recorded by the room authority', () => {
  const started = (): RoomCore => {
    const c = new RoomCore('ABCD', 11);
    c.join(null, 'Ada', () => 'p1');
    c.handle('p1', { t: 'start' });
    return c;
  };

  it('a match started now records exportVersion 5 and exports + replays bit-for-bit', () => {
    const c = started();
    expect(c.room.exportVersion).toBe(MATCH_EXPORT_VERSION);
    expect(MATCH_EXPORT_VERSION).toBe(5);
    c.handle('p1', { t: 'draft', turn: 1, revision: 1, orders: [{ t: 'borrow' }] });
    c.handle('p1', { t: 'ready', turn: 1, revision: 1, epoch: 0 });
    const exp = c.exportMatch()!;
    expect(exp.version).toBe(5);
    expect(exp.hashes).toHaveLength(1);
    expect(() => replayMatchExport(exp)).not.toThrow();
  });

  it('a rematch under the current ruleset restores exportVersion', () => {
    const c = started();
    delete c.room.exportVersion;
    c.room.status = 'ended';
    c.handle('p1', { t: 'rematch' });
    expect(c.room.exportVersion).toBe(5);
  });
});

describe('every real room a match produces is a valid v3 save (strict validators accept genuine data)', () => {
  const classify = (c: RoomCore): string => classifyStoredRoom(JSON.stringify(c.room), c.game ? JSON.stringify(c.game) : null).kind;

  const playTurn = (h: RoomHarness, ids: string[]): void => {
    const g = h.core.game!;
    ids.forEach((id) => {
      const seat = h.core.room.playerOf[h.core.seatOf(id)];
      const orders = planAI(g, seat);
      const core = h.core;
      const rev = core.room.drafts[seat].revision + 1;
      h.send(id, { t: 'draft', turn: g.turn, revision: rev, orders });
      h.send(id, { t: 'ready', turn: g.turn, revision: rev, epoch: core.room.epochs[seat] });
    });
  };

  for (const humans of [1, 2, 4]) {
    it(`a ${humans}-human blitz match, its Endless continuation and a rematch classify v3 after every turn`, () => {
      const h = new RoomHarness(21);
      const ids: string[] = [];
      for (let i = 0; i < humans; i++) ids.push(h.join(`Human ${i + 1}`).playerId);
      expect(classify(h.core)).toBe('v3');
      h.send(ids[0], { t: 'mode', mode: 'blitz' });
      h.send(ids[0], { t: 'start' });
      expect(classify(h.core)).toBe('v3');
      let guard = 0;
      while (h.core.room.status === 'playing' && guard++ < 40) {
        playTurn(h, ids);
        expect(classify(h.core), `turn ${h.core.game!.turn}`).toBe('v3');
      }
      expect(h.core.room.status).toBe('ended');
      expect(h.core.room.lastResolved).toBeGreaterThan(8);
      h.send(ids[0], { t: 'endless' });
      expect(classify(h.core)).toBe('v3');
      for (let i = 0; i < 3; i++) {
        playTurn(h, ids);
        expect(classify(h.core), `endless ${i}`).toBe('v3');
      }
      // pre-v5 and pre-endlessAt rooms stay valid
      const room = JSON.parse(JSON.stringify(h.core.room)) as Record<string, unknown>;
      delete room.exportVersion;
      delete room.endlessAt;
      expect(classifyStoredRoom(JSON.stringify(room), JSON.stringify(h.core.game)).kind).toBe('v3');
    });
  }
});

describe('Pass 8 case E: deep structural and index validation of persisted records', () => {
  const resolvedTurn1 = (): RoomCore => {
    const h = new RoomHarness(7);
    const a = h.join('Ada').playerId;
    h.send(a, { t: 'start' });
    h.send(a, { t: 'draft', turn: 1, revision: 1, orders: [{ t: 'borrow' }] });
    h.send(a, { t: 'ready', turn: 1, revision: 1, epoch: 0 });
    expect(h.core.game!.turn).toBe(2);
    return h.core;
  };

  it('Pass 7 repro: game.standings[0].player = game.players.length is legacy', () => {
    const c = resolvedTurn1();
    const game = JSON.parse(JSON.stringify(c.game)) as Record<string, any>;
    expect(classifyStoredRoom(JSON.stringify(c.room), JSON.stringify(game)).kind).toBe('v3');
    game.standings[0].player = game.players.length;
    expect(classifyStoredRoom(JSON.stringify(c.room), JSON.stringify(game))).toEqual({ kind: 'legacy' });
  });

  it('rejects every corrupt nested game record', () => {
    const c = resolvedTurn1();
    const roomRaw = JSON.stringify(c.room);
    const base = JSON.parse(JSON.stringify(c.game)) as Record<string, any>;
    // make sure the fixture carries the records the mutations touch
    base.pacts = [{ id: 90, kind: 'truce', a: 0, b: 1, from: 2, to: 7 }];
    base.proposals = [{ id: 91, kind: 'trade', from: 0, to: 1, turn: 2 }];
    base.events = [{ kind: 'cloudburst', announced: 1, start: 3, end: 4 }];
    base.council = { era: 2, offers: base.players.map(() => ['artisanry', 'transit', 'credit']) };
    base.honours = [{ key: 'corner', title: 'Corner King', player: 0, detail: 'x' }];
    if (!base.chronicle.length) base.chronicle = [{ n: 1, turn: 1, cat: 'build', head: 'h', pill: 'p', player: 0, tile: 3 }];
    if (!base.buildings.length) base.buildings.push({ ...JSON.parse(JSON.stringify(base.buildings[0] ?? {})) });
    const mutate = (fn: (g: Record<string, any>) => void): string => {
      const g = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      fn(g);
      return JSON.stringify(g);
    };
    expect(classifyStoredRoom(roomRaw, JSON.stringify(base)).kind).toBe('v3');
    const bad: [string, (g: Record<string, any>) => void][] = [
      ['winner = 4', (g) => (g.winner = 4)],
      ['leader = 4', (g) => (g.leader = 4)],
      ['leader float', (g) => (g.leader = 0.5)],
      ['standings duplicate player', (g) => (g.standings[1] = { ...g.standings[0] })],
      ['standings short', (g) => g.standings.pop()],
      ['standings crown NaN', (g) => (g.standings[0].crown = null)],
      ['standings share string', (g) => (g.standings[0].share = '3')],
      ['standings null', (g) => (g.standings[0] = null)],
      ['pacts[0].a = 4', (g) => (g.pacts[0].a = 4)],
      ['pacts[0].kind bogus', (g) => (g.pacts[0].kind = 'war')],
      ['pacts[0].to string', (g) => (g.pacts[0].to = 'x')],
      ['proposals[0].to = 4', (g) => (g.proposals[0].to = 4)],
      ['proposals[0].turn float', (g) => (g.proposals[0].turn = 1.5)],
      ['events[0].kind bogus', (g) => (g.events[0].kind = 'bogus')],
      ['events[0].end missing', (g) => delete g.events[0].end],
      ['chronicle[0].player = 4', (g) => (g.chronicle[0].player = 4)],
      ['chronicle[0].tile = 999', (g) => (g.chronicle[0].tile = 999)],
      ['chronicle[0].cat bogus', (g) => (g.chronicle[0].cat = 'bogus')],
      ['chronicle[0].head number', (g) => (g.chronicle[0].head = 3)],
      ['trend[0].crown wrong length', (g) => g.trend[0].crown.pop()],
      ['trend[0].share not finite', (g) => (g.trend[0].share[0] = null)],
      ['honours[0].player = 4', (g) => (g.honours[0].player = 4)],
      ['honours[0].key bogus', (g) => (g.honours[0].key = 'king')],
      ['council.offers wrong length', (g) => g.council.offers.pop()],
      ['council.offers unknown charter', (g) => (g.council.offers[0][0] = 'bogus')],
      ['council.offers row not array', (g) => (g.council.offers[0] = 'artisanry')],
      ['buildings[0].kind bogus', (g) => (g.buildings[0].kind = 'bogus')],
      ['buildings[0].level 4', (g) => (g.buildings[0].level = 4)],
      ['buildings[0].stance 7', (g) => (g.buildings[0].stance = 7)],
      ['buildings[0].lastLost missing', (g) => delete g.buildings[0].lastLost],
      ['buildings[0].lastArch not numbers', (g) => (g.buildings[0].lastArch = ['a'])],
      ['buildings[0].auto string', (g) => (g.buildings[0].auto = 'yes')],
      ['units[0].route -1', (g) => (g.units[0].route = -1)],
      ['units[0].fought missing', (g) => delete g.units[0].fought],
      ['players[0].persona bogus', (g) => (g.players[0].persona = 'nobody')],
      ['players[0].charters bogus', (g) => (g.players[0].charters = ['bogus'])],
      ['players[0].milestones float', (g) => (g.players[0].milestones = [1.5])],
      ['players[0].study bogus', (g) => (g.players[0].study = 'alchemy')],
      ['players[0].studies bogus', (g) => (g.players[0].studies = ['alchemy'])],
      ['players[0].dividend missing', (g) => delete g.players[0].dividend],
      ['players[0].stats.served missing', (g) => delete g.players[0].stats.served],
      ['players[0].stats.civicBuilt string', (g) => (g.players[0].stats.civicBuilt = 'x')],
    ];
    for (const [label, fn] of bad) expect(classifyStoredRoom(roomRaw, mutate(fn)), label).toEqual({ kind: 'legacy' });
  });

  it('rejects every corrupt room record (summary, config, seats, drafts, log, flags)', () => {
    const c = resolvedTurn1();
    const gameRaw = JSON.stringify(c.game);
    const base = JSON.parse(JSON.stringify(c.room)) as Record<string, any>;
    expect(base.summary).not.toBeNull();
    expect(classifyStoredRoom(JSON.stringify(base), gameRaw).kind).toBe('v3');
    const mutate = (fn: (r: Record<string, any>) => void): string => {
      const r = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      fn(r);
      return JSON.stringify(r);
    };
    const bad: [string, (r: Record<string, any>) => void][] = [
      ['summary.standings[0].player = 4', (r) => (r.summary.standings[0].player = 4)],
      ['summary.scores[0].player = 4', (r) => (r.summary.scores[0].player = 4)],
      ['summary.scores[0].crown null', (r) => (r.summary.scores[0].crown = null)],
      ['summary.cash[0].player = 4', (r) => (r.summary.cash[0].player = 4)],
      ['summary.cash[0].closing string', (r) => (r.summary.cash[0].closing = '1')],
      ['summary.lines[0] bad section', (r) => (r.summary.lines[0].section = 'bogus')],
      ['summary.lines[0].tile = 999', (r) => (r.summary.lines[0].tile = 999)],
      ['summary.committed wrong length', (r) => r.summary.committed.pop()],
      ['summary.committed negative', (r) => (r.summary.committed[0] = -1)],
      ['summary.hash number', (r) => (r.summary.hash = 5)],
      ['summary null after a resolution', (r) => (r.summary = null)],
      ['summaries[0].standings[0].player = 4', (r) => (r.summaries[0].standings[0].player = 4)],
      ['summaries[0] null', (r) => (r.summaries[0] = null)],
      ['config null', (r) => (r.config = null)],
      ['config.players wrong length', (r) => r.config.players.push({ name: 'x', house: 1, kind: 'ai', persona: 'vesper' })],
      ['config.players[0].house 9', (r) => (r.config.players[0].house = 9)],
      ['config.players[0].kind bogus', (r) => (r.config.players[0].kind = 'cyborg')],
      ['config.mode bogus', (r) => (r.config.mode = 'rush')],
      ['config.players[0].persona bogus', (r) => (r.config.players[0].persona = 'nobody')],
      ['seats[0].house = 9', (r) => (r.seats[0].house = 9)],
      ['seats[1].persona bogus', (r) => (r.seats[1].persona = 'nobody')],
      ['drafts[0].orders = [{t:bogus}]', (r) => (r.drafts[0].orders = [{ t: 'bogus' }])],
      ['drafts[0].revision negative', (r) => (r.drafts[0].revision = -1)],
      ['epochs[0] negative', (r) => (r.epochs[0] = -1)],
      ['hashes[0] number', (r) => (r.hashes[0] = 7)],
      ['playerOf length 3', (r) => r.playerOf.pop()],
      ['playerOf 4', (r) => (r.playerOf[0] = 4)],
      ['log shorter than lastResolved', (r) => r.log.pop()],
      ['log turn wrong length', (r) => r.log[0].push([])],
      ['log order bogus', (r) => (r.log[0][0] = [{ t: 'bogus' }])],
      ['endlessAt not array', (r) => (r.endlessAt = 3)],
      ['endlessAt negative', (r) => (r.endlessAt = [-1])],
      ['exportVersion 0', (r) => (r.exportVersion = 0)],
      ['exportVersion float', (r) => (r.exportVersion = 1.5)],
      ['matchNo negative', (r) => (r.matchNo = -1)],
      ['lastResolved negative', (r) => (r.lastResolved = -1)],
    ];
    for (const [label, fn] of bad) expect(classifyStoredRoom(mutate(fn), gameRaw), label).toEqual({ kind: 'legacy' });
  });

  it('a lobby that carries a config, summary or summaries is legacy', () => {
    const lobby = JSON.parse(JSON.stringify(new RoomCore('ABCD', 7).room)) as Record<string, any>;
    expect(classifyStoredRoom(JSON.stringify(lobby), null).kind).toBe('v3');
    const started = resolvedTurn1();
    expect(classifyStoredRoom(JSON.stringify({ ...lobby, config: started.room.config }), null)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(JSON.stringify({ ...lobby, summary: started.room.summary }), null)).toEqual({ kind: 'legacy' });
    expect(classifyStoredRoom(JSON.stringify({ ...lobby, summaries: [started.room.summary] }), null)).toEqual({ kind: 'legacy' });
  });
});

describe('Pass 8 case F: parseStoredTimestampMs accepts only canonical decimal epoch milliseconds', () => {
  const now = Date.UTC(2026, 10, 25, 12);
  it('accepts canonical decimal epoch ms', () => {
    expect(parseStoredTimestampMs(String(now), now)).toBe(now);
    expect(parseStoredTimestampMs(String(now - 7 * 3600 * 1000), now)).toBe(now - 7 * 3600 * 1000);
    expect(parseStoredTimestampMs(String(now + 3600 * 1000), now)).toBe(now + 3600 * 1000);
    expect(parseStoredTimestampMs(String(Date.UTC(2020, 0, 1)), now)).toBe(Date.UTC(2020, 0, 1));
    expect(parseStoredTimestampMs(String(Date.now()))).not.toBeNull();
  });
  it('rejects hex, octal, binary, exponent, float, sign, padding, tiny, far-future and non-numeric text', () => {
    const aged = now - 7 * 3600 * 1000;
    const bad: (string | null)[] = [
      '0x' + aged.toString(16),
      '0X' + aged.toString(16),
      '0o' + aged.toString(8),
      '0b' + aged.toString(2),
      '1e12',
      '1.7e12',
      '1700000000000.5',
      ' 1700000000000',
      '1700000000000 ',
      '1700000000000\n',
      '+1700000000000',
      '-1700000000000',
      '01700000000000',
      '1',
      '0',
      '1000000000',
      '999999999999',
      String(Date.UTC(2019, 11, 31)),
      String(now + 10 * 86_400_000),
      String(now + 24 * 3600 * 1000 + 1),
      '99999999999999',
      '9007199254740993',
      '',
      'abc',
      'NaN',
      'Infinity',
      null,
    ];
    for (const raw of bad) expect(parseStoredTimestampMs(raw, now), String(raw)).toBeNull();
  });
});
