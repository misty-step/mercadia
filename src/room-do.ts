// MercadiaRoom — the authoritative multiplayer room. One SQLite-backed Durable Object per code.
//
// Sockets use the Hibernation API. While players sit in the lobby there is no timer, so the
// object can sleep and costs nothing. A 100 ms interval exists only while a match is running
// and at least one human is connected; it is cleared the moment that stops being true.
import { DurableObject } from 'cloudflare:workers';
import { TICK_MS } from './shared/constants';
import { parseClientMsg, type ServerMsg } from './shared/protocol';
import { RoomCore, isRoomCode, type Outbound, type RoomState } from './shared/room';
import type { GameState } from './shared/types';
import type { Env } from './worker';

interface Attachment {
  playerId: string | null;
}

const CHECKPOINT_EVERY = 50; // beats (5 s)
const IDLE_PURGE_MS = 6 * 60 * 60 * 1000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export class MercadiaRoom extends DurableObject<Env> {
  private core: RoomCore | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private beats = 0;

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
      const game = gameRaw ? (JSON.parse(gameRaw) as GameState) : null;
      this.core = new RoomCore(room.code, room.seed, { room, game });
      // Connection flags come from the sockets that actually survived.
      const live = new Set<string>();
      for (const ws of this.ctx.getWebSockets()) {
        const id = (ws.deserializeAttachment() as Attachment | null)?.playerId;
        if (id) live.add(id);
      }
      for (const seat of this.core.room.seats) seat.connected = !!seat.playerId && live.has(seat.playerId);
      this.syncTimer();
    } catch {
      this.core = null;
    }
  }

  private saveRoom(): void {
    if (this.core) this.write('room', JSON.stringify(this.core.room));
  }

  private saveGame(): void {
    if (this.core?.game) this.write('game', JSON.stringify(this.core.game));
  }

  // ── Simulation loop ──

  private syncTimer(): void {
    const want = !!this.core?.running;
    if (want && this.timer === null) {
      this.timer = setInterval(() => this.beat(), TICK_MS);
    } else if (!want && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.saveRoom();
      this.saveGame(); // checkpoint on the way to idle
    }
  }

  private beat(): void {
    const core = this.core;
    if (!core) return;
    try {
      const before = core.room.status;
      this.dispatch(core.step());
      if (++this.beats % CHECKPOINT_EVERY === 0) this.saveGame();
      if (core.room.status !== before) {
        this.saveRoom();
        this.saveGame();
      }
    } catch (err) {
      console.error('room beat failed', err);
    }
    this.syncTimer();
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
      this.saveRoom();
      await this.ctx.storage.setAlarm(Date.now() + IDLE_PURGE_MS);
      return json({ ok: true, code }, 201);
    }

    if (url.pathname === '/summary') {
      if (!this.core) return json({ ok: false, error: 'No such room' }, 404);
      return json({ ok: true, ...this.core.summary() });
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
      this.sendTo(ws, { t: 'error', err: 'Malformed message' });
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
      this.dispatch(res.out);
      this.saveRoom();
      this.syncTimer();
      return;
    }

    if (!att.playerId) {
      this.sendTo(ws, { t: 'error', err: 'Say hello first' });
      return;
    }
    const before = core.room.status + core.room.matchNo;
    this.dispatch(core.handle(att.playerId, msg));
    if (msg.t !== 'cmd' && msg.t !== 'ping') this.saveRoom();
    if (core.room.status + core.room.matchNo !== before) this.saveGame();
    this.syncTimer();
  }

  private drop(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    ws.serializeAttachment({ playerId: null } satisfies Attachment);
    if (!this.core || !att?.playerId) return;
    // Another live socket for the same player means this was a stale connection.
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && (other.deserializeAttachment() as Attachment | null)?.playerId === att.playerId) return;
    }
    this.dispatch(this.core.disconnect(att.playerId));
    this.saveRoom();
    this.syncTimer();
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

  /** Rooms nobody has touched for hours are erased. */
  override async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_PURGE_MS);
      return;
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.core = null;
    await this.ctx.storage.deleteAll();
  }
}
