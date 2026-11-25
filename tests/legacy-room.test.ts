// The legacy v2 Durable Object compatibility boundary, pure part: the strict storage classifier and the
// export-version guard. A deployed v2 (real-time) room stores 'room' and 'game' in SQLite `kv` just like v3,
// so the v3 object must classify what it finds. (The Durable Object itself is covered by worker-tests/.)
import { describe, expect, it } from 'vitest';
import { MATCH_EXPORT_VERSION, replayMatchExport } from '../src/shared/replay';
import { RoomCore, classifyStoredRoom } from '../src/shared/room';
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
