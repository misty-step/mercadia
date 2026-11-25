// A synchronous in-memory harness around the real RoomCore (the Durable Object is a thin shell over it).
import { RoomCore, type JoinResult, type Outbound } from '../src/shared/room';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol';

export class RoomHarness {
  core: RoomCore;
  connected = new Set<string>();
  inbox = new Map<string, ServerMsg[]>();
  /** Every message actually delivered to a socket, in order. */
  delivered: { to: string; msg: ServerMsg }[] = [];
  private n = 0;

  constructor(seed = 1, code = 'ABCD', core?: RoomCore) {
    this.core = core ?? new RoomCore(code, seed);
  }

  newId = (): string => `p${++this.n}`;

  route(out: Outbound[]): Outbound[] {
    for (const o of out) {
      const targets = o.to === '*' ? [...this.connected] : this.connected.has(o.to) ? [o.to] : [];
      for (const id of targets) {
        const box = this.inbox.get(id) ?? [];
        box.push(o.msg);
        this.inbox.set(id, box);
        this.delivered.push({ to: id, msg: o.msg });
      }
    }
    return out;
  }

  /** A new socket says hello (optionally reclaiming a seat with its playerId). */
  join(name?: string, playerId?: string): JoinResult {
    const res = this.core.join(playerId ?? null, name, this.newId);
    this.connected.add(res.playerId);
    this.route(res.out);
    return res;
  }

  disconnect(id: string): Outbound[] {
    this.connected.delete(id);
    return this.route(this.core.disconnect(id));
  }

  send(id: string, msg: ClientMsg): Outbound[] {
    return this.route(this.core.handle(id, msg));
  }

  take(id: string): ServerMsg[] {
    const box = this.inbox.get(id) ?? [];
    this.inbox.set(id, []);
    return box;
  }

  /** Only the messages of one type from `take`. */
  takeOf<T extends ServerMsg['t']>(id: string, t: T): Extract<ServerMsg, { t: T }>[] {
    return this.take(id).filter((m): m is Extract<ServerMsg, { t: T }> => m.t === t);
  }
}

/** A room with `humans` human seats (host first), AI-filled otherwise, started in `mode`. */
export function startedRoom(humans: number, mode: 'standard' | 'blitz' = 'blitz', opts: { ai?: boolean; seed?: number } = {}): { h: RoomHarness; ids: string[] } {
  const h = new RoomHarness(opts.seed ?? 5);
  const ids: string[] = [];
  for (let i = 0; i < humans; i++) ids.push(h.join(`Human ${i + 1}`).playerId);
  const host = ids[0];
  h.send(host, { t: 'mode', mode });
  if (opts.ai === false) h.send(host, { t: 'aifill', on: false });
  h.send(host, { t: 'start' });
  for (const id of ids) h.take(id);
  return { h, ids };
}

export const turnOf = (h: RoomHarness): number => h.core.game!.turn;
export const playerOf = (h: RoomHarness, id: string): number => h.core.room.playerOf[h.core.seatOf(id)];
