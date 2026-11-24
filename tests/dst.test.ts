// Deterministic simulation tests: seeded matches with generated human order streams driven through the
// real RoomCore via a simulated transport that duplicates, drops, reorders and delays messages,
// disconnects and reconnects seats, replays old Ready / Cancel Ready and sends heartbeats.
// After every step the invariants of PRODUCT.md "Determinism and verification (DST)" are asserted.
import { describe, expect, it } from 'vitest';
import { LOAN_MAX, SUMMARY_KEEP } from '../src/shared/constants';
import { finalTurn, stateHash } from '../src/shared/game';
import { readyBlock } from '../src/shared/orders';
import { parseClientMsg, type ClientMsg, type ServerMsg } from '../src/shared/protocol';
import { replayMatch } from '../src/shared/replay';
import { canonicalOrders, resolveTurn } from '../src/shared/resolve';
import { RoomCore, type Outbound } from '../src/shared/room';
import { stream, type Rng } from '../src/shared/rng';
import type { Game, MatchMode, Order, TurnSummary } from '../src/shared/types';
import { checkTransition, checkUnits, genDraft } from './helpers';

// ───────────────────────────── Transport ─────────────────────────────

interface Packet<T> {
  at: number;
  seq: number;
  msg: T;
}

class Pipe<T> {
  q: Packet<T>[] = [];
  private seq = 0;
  push(msg: T, at: number): void {
    this.q.push({ at, seq: this.seq++, msg });
  }
  due(now: number): T[] {
    const ready = this.q.filter((p) => p.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.q = this.q.filter((p) => p.at > now);
    return ready.map((p) => p.msg);
  }
}

interface Faults {
  drop: number;
  dup: number;
  delayMax: number;
}
const CHAOS_UP: Faults = { drop: 0.08, dup: 0.1, delayMax: 4 };
const CHAOS_DOWN: Faults = { drop: 0.08, dup: 0.06, delayMax: 4 };
const CLEAN: Faults = { drop: 0, dup: 0.05, delayMax: 0 };

// ───────────────────────────── Client model ─────────────────────────────

/** What a client believes about its seat; it only ever shows what the authority has acknowledged. */
class SimClient {
  connected = true;
  turn = 1;
  game: Game | null = null;
  draft: Order[] = [];
  localRev = 0;
  ackedRev = 0;
  epoch = 0;
  ready = false;
  history: ClientMsg[] = [];
  up = new Pipe<string>();
  down = new Pipe<ServerMsg>();
  inbound = 0;
  constructor(
    public id: string,
    public seat: number,
    public player: number,
  ) {}

  /** The newer-turn / same-turn rules of PRODUCT.md "Client readiness across turns". */
  receive(m: ServerMsg): void {
    this.inbound++;
    switch (m.t) {
      case 'state': {
        if (m.turn > this.turn) {
          this.turn = m.turn;
          this.game = m.game;
          this.draft = m.own?.draft ?? [];
          this.localRev = this.ackedRev = m.own?.revision ?? 0;
          this.ready = m.own?.ready ?? false;
          this.epoch = m.own?.epoch ?? 0;
        } else if (m.turn === this.turn && m.own && m.own.epoch >= this.epoch) {
          this.ready = m.own.ready;
          this.epoch = m.own.epoch;
          if (m.own.revision >= this.ackedRev) {
            this.ackedRev = m.own.revision;
            if (m.own.revision >= this.localRev) {
              this.localRev = m.own.revision;
              this.draft = m.own.draft;
            }
          }
          this.game ??= m.game;
        }
        break;
      }
      case 'resolved':
        if (m.turn > this.turn) {
          this.turn = m.turn;
          this.game = m.game;
          this.draft = [];
          this.localRev = this.ackedRev = 0;
          this.ready = false;
          this.epoch = 0;
        }
        break;
      case 'draftAck':
        if (m.turn === this.turn) this.ackedRev = Math.max(this.ackedRev, m.revision);
        break;
      case 'readyAck':
        if (m.turn === this.turn && m.epoch >= this.epoch) {
          this.ready = m.ready;
          this.epoch = m.epoch;
        }
        break;
      case 'error':
        if (m.turn === this.turn && m.epoch !== undefined && m.epoch >= this.epoch) {
          this.epoch = m.epoch;
          if (m.code === 'readyLocked') this.ready = true;
          if (m.revision !== undefined) this.ackedRev = Math.max(this.ackedRev, m.revision);
        }
        break;
      default:
        break;
    }
  }
}

// ───────────────────────────── Authority monitor ─────────────────────────────

interface Snap {
  turn: number;
  game: Game;
  hash: string;
  lastResolved: number;
  logLen: number;
  hashesLen: number;
  summary: TurnSummary | null;
  ready: boolean[];
  epochs: number[];
  revs: number[];
  orders: string[];
  rawOrders: Order[][];
  status: string;
}

const snapOf = (core: RoomCore): Snap => {
  const r = core.room;
  return {
    turn: core.game!.turn,
    game: core.game!,
    hash: stateHash(core.game!),
    lastResolved: r.lastResolved,
    logLen: r.log.length,
    hashesLen: r.hashes.length,
    summary: r.summary,
    ready: [...r.ready],
    epochs: [...r.epochs],
    revs: r.drafts.map((d) => d.revision),
    orders: r.drafts.map((d) => JSON.stringify(d.orders)),
    rawOrders: r.drafts.map((d) => d.orders.map((o) => ({ ...o }))),
    status: r.status,
  };
};

interface Coverage {
  resolutions: number;
  offTurnReplies: number;
  staleReadyAcks: number;
  staleDraftErrors: number;
  readyLocked: number;
  needCharter: number;
  offTurnDrafts: number;
  acceptedReady: number;
  acceptedCancel: number;
  reconnects: number;
  pings: number;
  drops: number;
  dups: number;
  malformed: number;
  spectatorMsgs: number;
  futureReplays: number;
  oldReplays: number;
  droppedResolved: number;
  racesFinalReady: number;
  councils: number;
}
const newCoverage = (): Coverage => ({
  resolutions: 0,
  offTurnReplies: 0,
  staleReadyAcks: 0,
  staleDraftErrors: 0,
  readyLocked: 0,
  needCharter: 0,
  offTurnDrafts: 0,
  acceptedReady: 0,
  acceptedCancel: 0,
  reconnects: 0,
  pings: 0,
  drops: 0,
  dups: 0,
  malformed: 0,
  spectatorMsgs: 0,
  futureReplays: 0,
  oldReplays: 0,
  droppedResolved: 0,
  racesFinalReady: 0,
  councils: 0,
});

const PRIVATE_KEYS = /"(epoch|own|revision|draft)"/;

class Sim {
  core: RoomCore;
  clients: SimClient[] = [];
  spectator: SimClient | null = null;
  connected = new Set<string>();
  cov = newCoverage();
  now = 0;
  failures: string[] = [];
  resolvedTurns: number[] = [];
  private scanned = new WeakSet<object>();
  private rng: Rng;
  private idN = 0;
  // Per-turn bookkeeping for the oracle
  turnReadyAccepts = new Map<string, number>();

  constructor(
    public seed: number,
    public mode: MatchMode,
    public humans: number,
    public ais: number,
    withSpectator: boolean,
  ) {
    this.rng = stream(seed, 0, 'dst-sim');
    this.core = new RoomCore('DSTX', seed);
    // Lobby: humans join in order (host first); then the seat list is shaped to humans + AIs.
    for (let i = 0; i < humans; i++) {
      const j = this.core.join(null, `H${i + 1}`, () => `h${++this.idN}`);
      this.connected.add(j.playerId);
      this.clients.push(new SimClient(j.playerId, j.seat, -1));
    }
    const host = this.clients[0].id;
    this.core.handle(host, { t: 'mode', mode });
    for (let s = humans + ais; s < 4; s++) this.core.handle(host, { t: 'seat', seat: s, ai: false });
    for (let s = humans; s < humans + ais; s++) this.core.handle(host, { t: 'seat', seat: s, ai: true });
    this.core.handle(host, { t: 'start' });
    expect(this.core.room.status).toBe('playing');
    for (const c of this.clients) {
      c.player = this.core.room.playerOf[c.seat];
      const st = this.core.stateFor(c.id)[0] as Extract<ServerMsg, { t: 'state' }>;
      c.receive(st);
    }
    if (withSpectator) {
      // Joins after the start: no seat.
      const j = this.core.join(null, 'Watcher', () => `s${++this.idN}`);
      this.connected.add(j.playerId);
      this.spectator = new SimClient(j.playerId, -1, -1);
      this.spectator.receive(this.core.stateFor(j.playerId)[0]);
    }
  }

  fail(m: string): void {
    this.failures.push(`[seed ${this.seed} turn ${this.core.game?.turn} t=${this.now}] ${m}`);
  }
  chance = (p: number): boolean => this.rng.next() < p;
  int = (n: number): number => this.rng.int(n);

  // ── Transport ──

  sendUp(c: SimClient, msg: ClientMsg, f: Faults): void {
    c.history.push(msg);
    const frame = JSON.stringify(msg);
    if (this.chance(f.drop)) {
      this.cov.drops++;
      return;
    }
    c.up.push(frame, this.now + this.int(f.delayMax + 1));
    if (this.chance(f.dup)) {
      this.cov.dups++;
      c.up.push(frame, this.now + this.int(f.delayMax + 2));
    }
  }

  private sendDown(c: SimClient, msg: ServerMsg, f: Faults): void {
    if (this.chance(f.drop)) {
      this.cov.drops++;
      if (msg.t === 'resolved') this.cov.droppedResolved++;
      return;
    }
    c.down.push(msg, this.now + this.int(f.delayMax + 1));
    if (this.chance(f.dup)) {
      this.cov.dups++;
      c.down.push(msg, this.now + this.int(f.delayMax + 2));
    }
  }

  private all(): SimClient[] {
    return this.spectator ? [...this.clients, this.spectator] : this.clients;
  }

  /** Route authority output to the sockets that are connected right now. */
  route(out: Outbound[], down: Faults): void {
    for (const o of out) {
      for (const c of this.all()) {
        if (!this.connected.has(c.id)) continue;
        if (o.to === '*' || o.to === c.id) this.sendDown(c, o.msg, down);
      }
    }
  }

  // ── The monitored authority calls ──

  /** One authority step with every invariant checked around it. */
  call(op: { kind: 'msg'; from: SimClient; msg: ClientMsg } | { kind: 'join'; who: SimClient } | { kind: 'disconnect'; who: SimClient }, down: Faults): Outbound[] {
    const pre = snapOf(this.core);
    let out: Outbound[];
    let requester = '';
    if (op.kind === 'msg') {
      requester = op.from.id;
      out = this.core.handle(op.from.id, op.msg);
    } else if (op.kind === 'join') {
      requester = op.who.id;
      const res = this.core.join(op.who.id, undefined, () => `x${++this.idN}`);
      if (res.playerId !== op.who.id) this.fail('reconnect changed the playerId');
      this.connected.add(op.who.id);
      out = res.out;
    } else {
      requester = op.who.id;
      this.connected.delete(op.who.id);
      out = this.core.disconnect(op.who.id);
    }
    const post = snapOf(this.core);
    this.checkStep(pre, post, op, out, requester);
    this.route(out, down);
    return out;
  }

  private checkStep(pre: Snap, post: Snap, op: { kind: string; from?: SimClient; msg?: ClientMsg; who?: SimClient }, out: Outbound[], requester: string): void {
    const core = this.core;
    const f = (m: string) => this.fail(`${op.kind}${op.msg ? ':' + op.msg.t : ''} ${m}`);
    const msg = op.msg;
    const seat = core.seatOf(requester);
    const player = seat >= 0 ? core.room.playerOf[seat] : -1;
    const humans = core.game!.players.filter((p) => p.kind === 'human').map((p) => p.id);
    const resolvedMsgs = out.filter((o) => o.msg.t === 'resolved');

    // ── Privacy: scan outbound ──
    for (const o of out) {
      const m = o.msg;
      const privateType = m.t === 'state' || m.t === 'draftAck' || m.t === 'readyAck' || m.t === 'error';
      if (privateType && o.to !== requester) f(`private ${m.t} sent to ${o.to}, requester ${requester}`);
      if (m.t === 'state') {
        const toSeat = core.seatOf(o.to);
        const toPlayer = toSeat >= 0 ? core.room.playerOf[toSeat] : -1;
        if (m.player !== toPlayer) f('state names the wrong player');
        if (toPlayer < 0 && m.own !== null) f('spectator state carries a private view');
        if (toPlayer >= 0) {
          const d = core.room.drafts[toPlayer];
          const own = m.own;
          if (!own || own.revision !== d.revision || own.ready !== core.room.ready[toPlayer] || own.epoch !== core.room.epochs[toPlayer] || JSON.stringify(own.draft) !== JSON.stringify(d.orders)) f('state own view differs from the authority record');
        }
        if (m.game !== core.game || m.turn !== core.game!.turn || m.hash !== post.hash) f('state is not for the current authoritative world');
        if (m.summary !== core.room.summary) f('state summary is not the one attached to the current state');
      }
      if (m.t === 'resolved' || m.t === 'seats' || m.t === 'lobby' || m.t === 'welcome' || m.t === 'pong') {
        // Public messages: no private keys, no one's pending draft; scanned once per message object.
        if (!this.scanned.has(m)) {
          this.scanned.add(m);
          const text = JSON.stringify(m);
          if (m.t !== 'welcome' && PRIVATE_KEYS.test(text)) f(`public ${m.t} contains a private key`);
          if (m.t === 'welcome' && o.to !== requester) f('welcome sent to a stranger');
          for (const [i, raw] of pre.rawOrders.entries()) {
            if (raw.length && (m.t !== 'resolved') && text.includes(JSON.stringify(raw))) f(`draft of player ${i} leaked in ${m.t}`);
          }
        }
        if (m.t === 'resolved') {
          for (const s of m.seats) if (Object.keys(s).sort().join() !== 'connected,house,kind,name,ready') f('seat status has extra keys');
        }
      }
      if (m.t === 'seats') {
        for (const s of m.seats) if (Object.keys(s).sort().join() !== 'connected,house,kind,name,ready') f('seat status has extra keys');
      }
    }

    // ── Heartbeats and joins never touch the world ──
    const turnChanged = post.turn !== pre.turn;
    if (!turnChanged) {
      if (post.hash !== pre.hash || post.game !== pre.game) f('world changed without a resolution');
      if (post.lastResolved !== pre.lastResolved || post.logLen !== pre.logLen || post.hashesLen !== pre.hashesLen) f('log changed without a resolution');
      if (post.summary !== pre.summary) f('summary changed without a resolution');
      if (resolvedMsgs.length) f('resolved message without a turn change');
    }
    if (msg?.t === 'ping') {
      if (JSON.stringify(out) !== JSON.stringify([{ to: requester, msg: { t: 'pong', at: msg.at } }])) f('ping answered with more than a pong');
      if (JSON.stringify([pre.ready, pre.epochs, pre.revs, pre.orders]) !== JSON.stringify([post.ready, post.epochs, post.revs, post.orders])) f('ping changed seat state');
      this.cov.pings++;
    }
    if (op.kind !== 'msg' || (msg!.t !== 'ready' && msg!.t !== 'cancelReady')) {
      if (turnChanged) f('a turn resolved on something other than a Ready');
    }

    // ── Readiness / drafts oracle (an independent statement of the PRODUCT.md rules) ──
    const planning = core.room.status === 'playing' || pre.status === 'playing';
    if (!turnChanged) {
      for (let p = 0; p < pre.ready.length; p++) {
        const flipped = pre.ready[p] !== post.ready[p];
        const dEpoch = post.epochs[p] - pre.epochs[p];
        if (dEpoch !== 0 && dEpoch !== 1) f(`epoch of ${p} moved by ${dEpoch}`);
        if (flipped !== (dEpoch === 1)) f(`Ready flag of ${p} and its epoch did not move together`);
        if (flipped && p !== player) f(`seat ${p} changed by another seat's message`);
        if (post.revs[p] < pre.revs[p]) f('draft revision went backwards');
        if (post.revs[p] === pre.revs[p] && post.orders[p] !== pre.orders[p]) f('draft changed without a revision');
        if (post.revs[p] !== pre.revs[p] && p !== player) f(`draft of ${p} changed by another seat`);
      }
    }

    if ((msg?.t === 'ready' || msg?.t === 'cancelReady') && player < 0) {
      this.cov.spectatorMsgs++;
      if (out.length !== 1 || out[0].msg.t !== 'error' || (out[0].msg as { code: string }).code !== 'spectator') f('spectator readiness not refused');
      if (turnChanged || post.hash !== pre.hash) f('spectator changed the world');
    } else if (msg?.t === 'ready' || msg?.t === 'cancelReady') {
      const offTurn = msg.turn !== pre.turn || pre.status !== 'playing';
      if (offTurn) {
        // Off-turn contract: nothing changes; exactly one ordinary state for the current turn, to that seat only.
        this.cov.offTurnReplies++;
        if (msg.turn < pre.turn) this.cov.oldReplays++;
        if (msg.turn > pre.turn) this.cov.futureReplays++;
        if (turnChanged || post.hash !== pre.hash) f('off-turn Ready changed the world');
        if (JSON.stringify([pre.ready, pre.epochs, pre.revs, pre.orders]) !== JSON.stringify([post.ready, post.epochs, post.revs, post.orders])) f('off-turn Ready changed seat state');
        if (out.length !== 1 || out[0].to !== requester || out[0].msg.t !== 'state') f(`off-turn reply was ${JSON.stringify(out.map((o) => [o.to, o.msg.t]))}`);
        else {
          const st = out[0].msg;
          if (st.turn !== post.turn || st.summary !== post.summary) f('off-turn reply attaches the wrong summary');
          if (st.summary && st.summary.to !== st.turn) f('off-turn summary does not cover the current turn');
          if (st.own?.ready !== post.ready[player] || st.own?.epoch !== post.epochs[player]) f('off-turn reply carries the wrong readiness');
        }
      } else {
        const stored = pre.epochs[player];
        const playing = pre.ready[player];
        const accepted =
          msg.t === 'ready'
            ? msg.epoch === stored && !playing && msg.revision === pre.revs[player] && !readyBlock(pre.game, player, JSON.parse(pre.orders[player]))
            : msg.epoch === stored && playing;
        const flipped = turnChanged ? true : post.epochs[player] !== pre.epochs[player];
        if (accepted !== flipped) f(`${msg.t} ${JSON.stringify(msg)} accepted=${accepted} but flipped=${flipped} (stored epoch ${stored}, ready ${playing}, rev ${pre.revs[player]})`);
        if (accepted) {
          if (msg.t === 'ready') {
            this.cov.acceptedReady++;
            if (msg.revision !== pre.revs[player]) f('Ready recorded for an unacknowledged revision');
          } else this.cov.acceptedCancel++;
          if (!turnChanged && post.ready[player] !== (msg.t === 'ready')) f('flag is wrong after accepted transition');
        } else if (out.length) {
          const reply = out.filter((o) => o.to === requester && o.msg.t !== 'seats' && o.msg.t !== 'resolved');
          if (msg.t === 'ready' && msg.epoch === stored && !playing && msg.revision !== pre.revs[player]) {
            this.cov.staleDraftErrors++;
            if (reply.length !== 1 || reply[0].msg.t !== 'error' || reply[0].msg.code !== 'staleDraft') f('wrong rejection of a Ready for an unacknowledged draft');
          } else if (msg.t === 'ready' && msg.epoch === stored && !playing && readyBlock(pre.game, player, JSON.parse(pre.orders[player]))) {
            this.cov.needCharter++;
            if (reply.length !== 1 || reply[0].msg.t !== 'error' || reply[0].msg.code !== 'needCharter') f('wrong rejection of a Ready without a Charter');
          } else {
            this.cov.staleReadyAcks++;
            if (reply.length !== 1 || reply[0].msg.t !== 'readyAck' || reply[0].msg.ready !== post.ready[player] || reply[0].msg.epoch !== post.epochs[player]) f('stale Ready/Cancel not answered with the current flag and epoch');
          }
        }
        // The final-readiness race: this Ready completed the set while someone else's Cancel could be in flight.
        const others = humans.filter((h) => h !== player);
        if (accepted && msg.t === 'ready' && others.every((h) => pre.ready[h]) && others.length) this.cov.racesFinalReady++;
        // Resolution only ever from the Ready that completes the humans
        const complete = accepted && msg.t === 'ready' && humans.every((h) => (h === player ? true : pre.ready[h]));
        if (complete !== turnChanged) f(`resolution=${turnChanged} but the human set complete=${complete}`);
      }
    }

    if (msg?.t === 'draft') {
      const offTurn = msg.turn !== pre.turn || pre.status !== 'playing';
      const locked = !offTurn && player >= 0 && pre.ready[player];
      if (player < 0) {
        this.cov.spectatorMsgs++;
        if (out.length !== 1 || out[0].msg.t !== 'error' || (out[0].msg as { code: string }).code !== 'spectator') f('spectator draft not refused');
      } else if (offTurn) {
        this.cov.offTurnDrafts++;
        if (post.revs[player] !== pre.revs[player] || post.orders[player] !== pre.orders[player]) f('off-turn draft stored');
        const want = pre.status === 'playing' ? 'offTurnDraft' : 'notPlaying';
        if (out.length !== 1 || out[0].msg.t !== 'error' || (out[0].msg as { code: string }).code !== want) f('off-turn draft not rejected as such');
      } else if (locked) {
        this.cov.readyLocked++;
        if (post.revs[player] !== pre.revs[player]) f('draft edited while Ready');
        if (out.length !== 1 || out[0].msg.t !== 'error' || (out[0].msg as { code: string }).code !== 'readyLocked') f('locked draft not rejected');
      } else {
        const accept = msg.revision > pre.revs[player];
        if (accept) {
          if (post.revs[player] !== msg.revision || post.orders[player] !== JSON.stringify(msg.orders)) f('newer revision was not applied');
        } else if (post.revs[player] !== pre.revs[player] || post.orders[player] !== pre.orders[player]) f('older/duplicate revision changed the draft');
        const ack = out.find((o) => o.msg.t === 'draftAck');
        if (!ack || ack.msg.t !== 'draftAck' || ack.msg.revision !== post.revs[player] || ack.msg.turn !== post.turn) f('draft not acknowledged with the stored revision');
      }
    }
    // ── Resolution: exactly once, +1, applies exactly the acknowledged drafts ──
    if (turnChanged) {
      this.cov.resolutions++;
      this.resolvedTurns.push(pre.turn);
      if (post.turn !== pre.turn + 1) f(`turn ${pre.turn} -> ${post.turn}`);
      if (post.lastResolved !== pre.turn || post.logLen !== pre.logLen + 1 || post.hashesLen !== pre.hashesLen + 1) f('last resolved / log / hashes not advanced exactly once');
      if (resolvedMsgs.length !== 1 || resolvedMsgs[0].to !== '*') f('resolution must send exactly one broadcast');
      const rm = resolvedMsgs[0]?.msg;
      if (rm && rm.t === 'resolved') {
        if (rm.turn !== post.turn || rm.game !== core.game || rm.hash !== post.hash || rm.summary !== core.room.summary) f('resolved does not carry N+1 state, hash and summary together');
        if (rm.summary.from !== pre.turn || rm.summary.to !== post.turn) f('summary does not cover N->N+1');
      }
      if (out.some((o) => o.msg.t === 'state')) f('resolution also sent a separate state');
      // Independent recomputation from the drafts that were acknowledged when the last Ready was recorded.
      const drafts = pre.rawOrders;
      const committed = canonicalOrders(pre.game, drafts);
      const res = resolveTurn(pre.game, committed);
      if (JSON.stringify(core.room.log[core.room.log.length - 1]) !== JSON.stringify(res.committed)) f('log does not hold the acknowledged drafts');
      if (stateHash(res.game) !== post.hash) f('resolution is not a pure function of state and acknowledged drafts');
      for (const e of checkTransition(pre.game, { game: core.game!, summary: core.room.summary!, committed: core.room.log[core.room.log.length - 1] })) f(e);
      if (core.room.hashes[core.room.hashes.length - 1] !== post.hash) f('stored hash differs');
      if (core.game!.council) this.cov.councils++;
      // Per-turn state is fresh
      if (post.ready.some(Boolean) || post.epochs.some((e) => e !== 0) || post.revs.some((r) => r !== 0) || post.orders.some((o) => o !== '[]')) f('new turn did not start with Planning / epoch 0 / empty revision-0 drafts');
    }
    void planning;

    // ── Always: treasury, units, Actions on the authoritative world ──
    if (post.game !== pre.game || op.kind === 'join') {
      const g = post.game;
      for (const p of g.players) {
        if (!Number.isInteger(p.cash) || p.cash < 0) f(`cash of ${p.id} is ${p.cash}`);
        if (!Number.isInteger(p.debt) || p.debt < 0 || p.debt > LOAN_MAX) f(`debt of ${p.id} is ${p.debt}`);
      }
      checkUnits(g, f);
    }
  }

  // ── The simulation ──

  /** Turn-scoped client behaviour for one tick. */
  clientAct(c: SimClient, f: Faults, chaos: boolean): void {
    if (!this.connected.has(c.id) || !c.game) return;
    const rng = this.rng;
    const mk = (m: ClientMsg) => {
      if ('turn' in m && m.turn !== c.turn) this.fail(`client ${c.seat} created a message for turn ${m.turn} while holding turn ${c.turn}`);
      this.sendUp(c, m, f);
    };
    // Edit the draft (never while acknowledged Ready: the UI forbids it)
    if (chaos && !c.ready && rng.next() < 0.12) {
      const base = genDraft(c.game, c.player, rng, rng.range(0, 8));
      const junk: Order[] = rng.next() < 0.2 ? Array.from({ length: rng.range(1, 12) }, () => ({ t: 'borrow' }) as Order) : [];
      c.draft = [...base, ...junk];
      c.localRev++;
      mk({ t: 'draft', turn: c.turn, revision: c.localRev, orders: c.draft });
    }
    // A Council turn needs a Charter in the draft before End Turn is available (the UI insists)
    if (!c.ready && c.game.council && !c.draft.some((o) => o.t === 'charter') && rng.next() < (chaos ? 0.3 : 1)) {
      c.draft = [{ t: 'charter', key: c.game.council.offers[c.player][rng.int(3)] }, ...c.draft];
      c.localRev++;
      mk({ t: 'draft', turn: c.turn, revision: c.localRev, orders: c.draft });
    }
    // Retry an unacknowledged draft
    if (c.localRev > c.ackedRev && !c.ready && rng.next() < (chaos ? 0.25 : 1)) mk({ t: 'draft', turn: c.turn, revision: c.localRev, orders: c.draft });
    // End Turn: marks Ready at the acknowledged revision and epoch; safe to press again
    if (!c.ready && c.localRev === c.ackedRev && rng.next() < (chaos ? 0.2 : 1)) mk({ t: 'ready', turn: c.turn, revision: c.ackedRev, epoch: c.epoch });
    // Cancel Ready (and later Ready again, possibly without editing)
    if (c.ready && rng.next() < (chaos ? 0.12 : 0)) mk({ t: 'cancelReady', turn: c.turn, epoch: c.epoch });
    // A client that is Ready may press End Turn again after a lost acknowledgment
    if (c.ready && rng.next() < (chaos ? 0.05 : 0)) mk({ t: 'ready', turn: c.turn, revision: c.ackedRev, epoch: c.epoch - 1 });
    // Heartbeat
    if (rng.next() < (chaos ? 0.1 : 0.05)) this.sendUp(c, { t: 'ping', at: this.now }, f);
  }

  /** The relay replays old messages, sometimes edited to name another turn or an unacknowledged revision. */
  relayReplay(c: SimClient, f: Faults): void {
    const rng = this.rng;
    if (!c.history.length || rng.next() > 0.3) return;
    const old = c.history[rng.int(c.history.length)];
    if (old.t === 'ping' || old.t === 'hello') return;
    const m: ClientMsg = { ...old } as ClientMsg;
    const k = rng.int(6);
    // (the relay replays, delays and duplicates; it never forges a message for the turn in progress)
    if (k === 0 && (m.t === 'ready' || m.t === 'cancelReady')) m.turn = c.turn + rng.range(1, 3); // a turn that has not started
    if (k === 1 && (m.t === 'ready' || m.t === 'cancelReady')) m.turn = Math.max(0, c.turn - rng.range(1, 2)); // an already-resolved turn
    if (k === 2 && m.t === 'ready' && m.turn === c.turn) m.revision += 1; // an unacknowledged revision
    if (k === 3 && m.t === 'ready' && m.turn === c.turn) m.epoch = Math.max(0, m.epoch - 1);
    if (k === 4 && (m.t === 'ready' || m.t === 'cancelReady') && m.turn === c.turn) m.epoch += 1;
    this.sendUp(c, m, f);
  }

  disconnect(c: SimClient, down: Faults): void {
    this.call({ kind: 'disconnect', who: c }, down);
  }

  reconnect(c: SimClient, down: Faults): void {
    this.cov.reconnects++;
    c.connected = true;
    this.call({ kind: 'join', who: c }, down);
    // After a reconnect the client compares drafts only for the same turn (done in receive()); it
    // never resends an earlier-turn draft, Ready or Cancel Ready. Anything of the old turn is simply gone.
  }

  /** One turn, with chaos first and then a calm period until it resolves. */
  playTurn(): void {
    const start = this.core.game!.turn;
    const chaosTicks = 8 + this.int(16);
    for (let k = 0; k < chaosTicks + 400 && this.core.game!.turn === start && this.core.room.status === 'playing'; k++) {
      const chaos = k < chaosTicks;
      this.now++;
      if (k === chaosTicks) {
        // The network calms down. Players whose view went stale (a lost acknowledgment or resolution)
        // reload: a reconnect delivers the authority's state for the current turn.
        for (const c of this.clients) {
          if (this.connected.has(c.id)) this.disconnect(c, CLEAN);
          this.reconnect(c, CLEAN);
        }
      }
      this.tick(chaos);
    }
    if (this.core.game!.turn === start && this.core.room.status === 'playing') {
      this.fail(`turn ${start} never resolved: ${JSON.stringify(this.clients.map((c) => ({ id: c.id, conn: this.connected.has(c.id), turn: c.turn, ready: c.ready, epoch: c.epoch, loc: c.localRev, ack: c.ackedRev, council: !!c.game?.council, hasCh: c.draft.some((o) => o.t === 'charter') })))} auth ${JSON.stringify({ ready: this.core.room.ready, ep: this.core.room.epochs, revs: this.core.room.drafts.map((d) => d.revision) })}`);
    }
  }

  tick(chaos: boolean): void {
    const up = chaos ? CHAOS_UP : CLEAN;
    const down = chaos ? CHAOS_DOWN : CLEAN;
    const rng = this.rng;
    if (!chaos) for (const c of this.clients) if (!this.connected.has(c.id)) this.reconnect(c, down);
    // 1. Clients act
    for (const c of this.clients) {
      this.clientAct(c, up, chaos);
      if (chaos) this.relayReplay(c, up);
      if (chaos && this.connected.has(c.id) && rng.next() < 0.03) this.disconnect(c, down);
      else if (chaos && !this.connected.has(c.id) && rng.next() < 0.25) this.reconnect(c, down);
      // garbage frames never reach the core (the shell rejects them)
      if (chaos && rng.next() < 0.02) c.up.push(rng.next() < 0.5 ? '{"t":"ready","turn":"x"}' : 'not json', this.now);
    }
    if (this.spectator && this.connected.has(this.spectator.id)) {
      const s = this.spectator;
      if (rng.next() < 0.3) this.sendUp(s, [{ t: 'draft', turn: 1, revision: 1, orders: [] }, { t: 'ready', turn: 1, revision: 0, epoch: 0 }, { t: 'cancelReady', turn: 1, epoch: 0 }, { t: 'ping', at: 1 }][rng.int(4)] as ClientMsg, up);
    }
    // 2. The authority handles everything due, one message at a time, in a seeded interleaving
    const due: { c: SimClient; frame: string }[] = [];
    for (const c of this.all()) for (const frame of c.up.due(this.now)) due.push({ c, frame });
    for (let i = due.length - 1; i > 0; i--) {
      // interleave seats randomly but keep each seat's own order for same-time frames
      if (rng.next() < 0.5) {
        const j = rng.int(i + 1);
        if (due[i].c !== due[j].c) [due[i], due[j]] = [due[j], due[i]];
      }
    }
    for (const { c, frame } of due) {
      const msg = parseClientMsg(frame);
      if (!msg) {
        this.cov.malformed++;
        continue;
      }
      this.call({ kind: 'msg', from: c, msg }, down);
    }
    // 3. Clients receive what is due
    for (const c of this.all()) {
      for (const m of c.down.due(this.now)) {
        if (!this.connected.has(c.id)) continue;
        if (c === this.spectator) {
          if ((m.t === 'state' && m.own !== null) || PRIVATE_KEYS.test(m.t === 'resolved' || m.t === 'state' ? '' : JSON.stringify(m))) this.fail('spectator received private data');
          if (m.t === 'draftAck' || m.t === 'readyAck') this.fail('spectator received an acknowledgment');
        }
        c.receive(m);
      }
    }
  }
}

// ───────────────────────────── Scenarios ─────────────────────────────

function runMatch(seed: number, mode: MatchMode, humans: number, ais: number, spectator: boolean): Sim {
  const sim = new Sim(seed, mode, humans, ais, spectator);
  const last = finalTurn({ mode });
  let guard = 0;
  while (sim.core.room.status === 'playing' && guard++ < last + 2) {
    sim.playTurn();
    if (sim.failures.length) break;
  }
  return sim;
}

function finish(sim: Sim, mode: MatchMode): void {
  expect(sim.failures.slice(0, 10)).toEqual([]);
  const core = sim.core;
  const last = finalTurn({ mode });
  // exactly once, no skips
  expect(sim.resolvedTurns).toEqual(Array.from({ length: last }, (_, i) => i + 1));
  expect(core.room.status).toBe('ended');
  expect(core.game!.phase).toBe('ended');
  expect(core.room.lastResolved).toBe(last);
  expect(core.room.log).toHaveLength(last);
  // Replay equivalence: the recorded log reproduces every hash, summary and the winner
  const cfg = core.room.config!;
  const rep = replayMatch(cfg, JSON.parse(JSON.stringify(core.room.log)));
  expect(rep.hashes).toEqual(core.room.hashes);
  expect(stateHash(rep.game)).toBe(stateHash(core.game!));
  expect(rep.game.winner).toBe(core.game!.winner);
  expect(rep.game.standings).toEqual(core.game!.standings);
  expect(rep.summaries.slice(-SUMMARY_KEEP)).toEqual(core.room.summaries);
  expect(rep.summaries[rep.summaries.length - 1]).toEqual(core.room.summary);
  // Every client that kept up agrees with the authority at the end
  for (const c of sim.clients) expect(c.turn).toBeLessThanOrEqual(core.game!.turn);
}

describe('DST: seeded matches through the room authority with a hostile transport', () => {
  const scenarios: [number, MatchMode, number, number, boolean][] = [
    [101, 'blitz', 2, 2, true],
    [102, 'blitz', 2, 0, false],
    [103, 'blitz', 3, 1, true],
    [104, 'blitz', 4, 0, false],
    [105, 'blitz', 1, 1, false],
    [106, 'blitz', 1, 3, true],
    [107, 'standard', 2, 2, true],
    [108, 'standard', 3, 0, false],
    [109, 'blitz', 2, 1, true],
    [110, 'blitz', 4, 0, true],
    [111, 'blitz', 3, 0, false],
    [112, 'standard', 4, 0, true],
  ];
  const total = newCoverage();

  it.each(scenarios)('seed %i %s, %i humans + %i AI (spectator: %s)', (seed, mode, humans, ais, spec) => {
    const sim = runMatch(seed, mode, humans, ais, spec);
    finish(sim, mode);
    for (const k of Object.keys(total) as (keyof Coverage)[]) total[k] += sim.cov[k];
  });

  it('the harness really exercised the hard cases', () => {
    const c = total;
    expect(c.resolutions).toBeGreaterThan(150);
    expect(c.offTurnReplies).toBeGreaterThan(40);
    expect(c.oldReplays).toBeGreaterThan(10);
    expect(c.futureReplays).toBeGreaterThan(5);
    expect(c.staleReadyAcks).toBeGreaterThan(40);
    expect(c.staleDraftErrors).toBeGreaterThan(3);
    expect(c.readyLocked).toBeGreaterThan(3);
    expect(c.offTurnDrafts).toBeGreaterThan(3);
    expect(c.acceptedReady).toBeGreaterThan(200);
    expect(c.acceptedCancel).toBeGreaterThan(20);
    expect(c.reconnects).toBeGreaterThan(30);
    expect(c.pings).toBeGreaterThan(100);
    expect(c.drops).toBeGreaterThan(100);
    expect(c.dups).toBeGreaterThan(100);
    expect(c.malformed).toBeGreaterThan(3);
    expect(c.spectatorMsgs).toBeGreaterThan(5);
    expect(c.droppedResolved).toBeGreaterThan(3);
    expect(c.racesFinalReady).toBeGreaterThan(20);
    expect(c.councils).toBeGreaterThan(5);
  });
});
