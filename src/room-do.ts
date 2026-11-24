// MercadiaRoom — the authoritative multiplayer room. One SQLite-backed Durable Object per code.
//
// Sockets use the Hibernation API. There is no tick, no interval and no alarm-driven simulation:
// the world changes only inside a resolution, which runs when the last human seat's Ready is
// recorded. Messages are handled one at a time; the state, the canonical action log and the
// summary are persisted in a single synchronous transaction before anything is sent.
import { DurableObject } from 'cloudflare:workers';
import { parseClientMsg, type ServerMsg } from './shared/protocol';
import { IDLE_PURGE_MS, RoomCore, isRoomCode, roomAlarmAction, type Outbound, type RoomState } from './shared/room';
import type { Game } from './shared/types';
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
    const roomRaw = this.read('room');
    if (!roomRaw) return;
    try {
      const room = JSON.parse(roomRaw) as RoomState;
      const gameRaw = this.read('game');
      const game = gameRaw ? (JSON.parse(gameRaw) as Game) : null;
      this.core = new RoomCore(room.code, room.seed, { room, game });
      // Connection flags come from the sockets that actually survived.
      const live = new Set<string>();
      for (const ws of this.ctx.getWebSockets()) {
        const id = (ws.deserializeAttachment() as Attachment | null)?.playerId;
        if (id) live.add(id);
      }
      for (const seat of this.core.room.seats) seat.connected = !!seat.playerId && live.has(seat.playerId);
    } catch {
      this.core = null;
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
      if (this.core) return json({ ok: false, error: 'Room exists' }, 409);
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      this.core = new RoomCore(code, seed);
      this.persist();
      await this.ctx.storage.setAlarm(Date.now() + IDLE_PURGE_MS);
      return json({ ok: true, code }, 201);
    }

    if (url.pathname === '/summary') {
      if (!this.core) return json({ ok: false, error: 'No such room' }, 404);
      return json({ ok: true, ...this.core.summary() });
    }

    if (url.pathname === '/export') {
      if (!this.core) return json({ ok: false, error: 'No such room' }, 404);
      const exp = this.core.exportMatch();
      if (!exp) return json({ ok: false, error: 'The match has not started yet' }, 409);
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
    const touched = Number(this.read('touched') ?? 0);
    const idle = touched > 0 ? Date.now() - touched : IDLE_PURGE_MS;
    const action = this.core ? roomAlarmAction(this.core.room, this.ctx.getWebSockets().length, idle) : 'purge';
    if (action === 'keep') {
      const wait = this.core?.room.status === 'playing' || this.ctx.getWebSockets().length > 0 ? IDLE_PURGE_MS : Math.max(60_000, IDLE_PURGE_MS - idle);
      await this.ctx.storage.setAlarm(Date.now() + wait);
      return;
    }
    this.core = null;
    await this.ctx.storage.deleteAll();
  }
}
