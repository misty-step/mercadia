// MercadiaRoom — the authoritative multiplayer room. One SQLite-backed Durable Object per code.
//
// Sockets use the Hibernation API. There is no tick, no interval and no alarm-driven simulation:
// the world changes only inside a resolution, which runs when the last human seat's Ready is
// recorded. Messages are handled one at a time; the state, the canonical action log and the
// summary are persisted in a single synchronous transaction before anything is sent.
import { DurableObject } from 'cloudflare:workers';
import { parseClientMsg, type ServerMsg } from './shared/protocol';
import { LEGACY_ROOM_MESSAGE } from './shared/constants';
import { IDLE_PURGE_MS, RoomCore, classifyStoredRoom, isRoomCode, roomAlarmAction, type Outbound } from './shared/room';
import type { Env } from './worker';

interface Attachment {
  playerId: string | null;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export class MercadiaRoom extends DurableObject<Env> {
  private core: RoomCore | null = null;
  /** True when this object holds a deployed v2 (real-time) room: its storage is read-only and never touched. */
  private legacy = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.restore();
  }

  // ── Storage ──

  private read(key: string): string | null {
    const rows = this.ctx.storage.sql.exec('SELECT v FROM kv WHERE k = ?', key).toArray();
    return rows.length ? (rows[0].v as string) : null;
  }

  private write(key: string, value: string): void {
    this.ctx.storage.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, value);
  }

  private restore(): void {
    const stored = classifyStoredRoom(this.read('room'), this.read('game'));
    if (stored.kind === 'legacy') {
      // A v2 room (or anything that is not a v3 record): isolated and left byte-for-byte as it is.
      // No write, no delete, no simulation and no v2 tick is ever transplanted into the turn engine.
      this.core = null;
      this.legacy = true;
      return;
    }
    if (stored.kind === 'empty') return;
    try {
      const core = new RoomCore(stored.room.code, stored.room.seed, { room: stored.room, game: stored.game });
      // Connection flags come from the sockets that actually survived.
      const live = new Set<string>();
      for (const ws of this.ctx.getWebSockets()) {
        const id = (ws.deserializeAttachment() as Attachment | null)?.playerId;
        if (id) live.add(id);
      }
      for (const seat of core.room.seats) seat.connected = !!seat.playerId && live.has(seat.playerId);
      this.core = core;
    } catch {
      // Stored but unusable: fail closed into the same read-only isolation as a legacy room. Never a 500.
      this.core = null;
      this.legacy = true;
    }
  }

  /** One transaction: room (drafts, Ready flags, epochs, log, summary, last resolved turn) and the world. */
  private persist(): void {
    const core = this.core;
    if (!core) return;
    this.ctx.storage.transactionSync(() => {
      this.write('room', JSON.stringify(core.room));
      if (core.game) this.write('game', JSON.stringify(core.game));
      this.write('touched', String(Date.now()));
    });
  }

  // ── Sockets ──

  private dispatch(out: Outbound[]): void {
    if (!out.length) return;
    const sockets = this.ctx.getWebSockets();
    for (const o of out) {
      const frame = JSON.stringify(o.msg);
      for (const ws of sockets) {
        const id = (ws.deserializeAttachment() as Attachment | null)?.playerId;
        if (!id || (o.to !== '*' && o.to !== id)) continue;
        try {
          ws.send(frame);
        } catch {
          // The close handler will tidy up.
        }
      }
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      const code = url.searchParams.get('code') ?? '';
      if (!isRoomCode(code)) return json({ ok: false, error: 'Bad room code' }, 400);
      if (this.core || this.legacy) return json({ ok: false, error: 'Room exists' }, 409);
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      this.core = new RoomCore(code, seed);
      this.persist();
      await this.ctx.storage.setAlarm(Date.now() + IDLE_PURGE_MS);
      return json({ ok: true, code }, 201);
    }

    if (url.pathname === '/summary') {
      if (this.legacy) return json({ ok: false, legacy: true, code: 'legacy_room', error: LEGACY_ROOM_MESSAGE }, 410);
      if (!this.core) return json({ ok: false, error: 'No such room' }, 404);
      return json({ ok: true, ...this.core.summary() });
    }

    if (url.pathname === '/export') {
      if (this.legacy) return json({ ok: false, legacy: true, code: 'legacy_room', error: 'Legacy v2 rooms cannot be exported in v3.' }, 410);
      if (!this.core) return json({ ok: false, error: 'No such room' }, 404);
      const res = this.core.tryExport();
      if (!res.ok) return json(res.code === 'not_started' ? { ok: false, error: res.error } : { ok: false, code: res.code, error: res.error }, 409);
      const exp = res.export;
      return new Response(JSON.stringify(exp, null, 2), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="mercadia-${this.core.room.code}-${exp.config.seed}.json"`,
        },
      });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (this.legacy) return json({ ok: false, legacy: true, code: 'legacy_room', error: LEGACY_ROOM_MESSAGE }, 410);
      if (!this.core) return json({ ok: false, error: 'No such room' }, 404);
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ playerId: null } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const core = this.core;
    if (!core) {
      ws.close(4004, 'No such room');
      return;
    }
    const msg = parseClientMsg(typeof data === 'string' ? data : null);
    if (!msg) {
      this.sendTo(ws, { t: 'error', code: 'malformed', message: 'Malformed message' });
      return;
    }
    // Heartbeats are transport only: they never reach the core.
    if (msg.t === 'ping') {
      this.sendTo(ws, { t: 'pong', at: msg.at });
      return;
    }
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { playerId: null };

    if (msg.t === 'hello') {
      if (att.playerId) return; // already introduced
      const res = core.join(msg.playerId ?? null, msg.name, () => crypto.randomUUID());
      // A reconnect replaces any older socket still held for the same player.
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        if ((other.deserializeAttachment() as Attachment | null)?.playerId === res.playerId) {
          other.serializeAttachment({ playerId: null } satisfies Attachment);
          try {
            other.close(4001, 'Replaced by a newer connection');
          } catch {
            // ignore
          }
        }
      }
      ws.serializeAttachment({ playerId: res.playerId } satisfies Attachment);
      this.persist();
      this.dispatch(res.out);
      return;
    }

    if (!att.playerId) {
      this.sendTo(ws, { t: 'error', code: 'hello', message: 'Say hello first' });
      return;
    }
    const out = core.handle(att.playerId, msg);
    this.persist();
    this.dispatch(out);
  }

  private drop(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    ws.serializeAttachment({ playerId: null } satisfies Attachment);
    if (!this.core || !att?.playerId) return;
    // Another live socket for the same player means this was a stale connection.
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && (other.deserializeAttachment() as Attachment | null)?.playerId === att.playerId) return;
    }
    const out = this.core.disconnect(att.playerId);
    this.persist();
    this.dispatch(out);
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.drop(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.drop(ws);
  }

  /**
   * Housekeeping only (never simulation): unstarted lobbies and finished rooms nobody has touched
   * for hours are erased. A match in progress is never erased — its seats wait for their players.
   */
  override async alarm(): Promise<void> {
    // Fail closed: anything that is not a positively validated v3 room is left byte-for-byte as it is.
    // No delete, no write and no reschedule, whether it is a deployed v2 room, a corrupt save, or empty.
    if (this.legacy) return;
    if (!this.core) {
      if (this.read('room') != null || this.read('game') != null) this.legacy = true;
      return;
    }
    // Cross-record anomaly: a lobby never carries a world. If one is held in memory or sits in SQLite, this is a
    // corrupt save, not an idle lobby: isolate it read-only and erase nothing.
    if (this.core.room.status === 'lobby' && (this.core.game !== null || this.read('game') != null)) {
      this.legacy = true;
      this.core = null;
      return;
    }
    const touched = Number(this.read('touched') ?? 0);
    const idle = touched > 0 ? Date.now() - touched : 0;
    const sockets = this.ctx.getWebSockets().length;
    // Purge needs a recorded `touched` (idle time that is not positively known never counts as idle) and a
    // room + game pair that is positively an idle lobby or a finished match.
    if (!(touched > 0) || roomAlarmAction(this.core.room, this.core.game, sockets, idle) === 'keep') {
      const wait = this.core.room.status === 'playing' || sockets > 0 ? IDLE_PURGE_MS : Math.max(60_000, IDLE_PURGE_MS - idle);
      await this.ctx.storage.setAlarm(Date.now() + wait);
      return;
    }
    this.core = null;
    await this.ctx.storage.deleteAll();
  }
}
