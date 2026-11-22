// A Session is whatever is feeding the city on screen: the attract-mode district behind the
// title, a solo match simulated in this browser, or a multiplayer room on the server.
// All three fill the same CityView through the same snapshot path.
import { advance } from '../shared/ai';
import { AI_ORDER, AI_PERSONAS } from '../shared/constants';
import { CityView, SnapEncoder, type ClientMsg, type LobbyView, type ServerMsg } from '../shared/protocol';
import { applyCommand, continueEndless, createGame } from '../shared/sim';
import type { Command, Fx, GameState, MatchMode, PlayerSetup } from '../shared/types';

export interface Session {
  readonly kind: 'attract' | 'solo' | 'multi';
  readonly view: CityView;
  /** Player index this client controls, or -1. */
  me: number;
  speed: number;
  paused: boolean;
  /** Advance local time and return feedback events that arrived since the last call. */
  update(now: number): Fx[];
  /** Interpolation factor between the last two snapshots. */
  alpha(now: number): number;
  command(cmd: Command): void;
  setSpeed(v: number): void;
  togglePause(): void;
  rematch(): void;
  endless(): void;
  dispose(): void;
  onReject: (err: string) => void;
}

const STEP_MS = 100;

/** Solo and attract mode: the simulation runs right here. */
export class LocalSession implements Session {
  readonly view = new CityView();
  me: number;
  speed = 1;
  paused = false;
  onReject: (err: string) => void = () => undefined;
  state: GameState;
  private enc = new SnapEncoder();
  private acc = 0;
  private lastNow = 0;
  private snapAt = 0;
  private interval = STEP_MS;
  private pending: Fx[] = [];
  private matchNo = 0;

  constructor(
    readonly kind: 'attract' | 'solo',
    private setups: PlayerSetup[],
    private mode: MatchMode,
    private seed: number,
  ) {
    this.me = kind === 'solo' ? 0 : -1;
    this.state = this.fresh();
  }

  private fresh(): GameState {
    const state = createGame({ seed: (this.seed + this.matchNo * 7919) >>> 0, mode: this.mode, players: this.setups });
    this.enc.reset();
    this.view.apply(this.enc.encode(state, true, this.speed));
    this.acc = 0;
    return state;
  }

  private push(now: number): void {
    const snap = this.enc.encode(this.state, false, this.speed);
    this.state.fx = [];
    const fx = this.view.apply(snap);
    for (const f of fx) this.pending.push(f);
    this.interval = Math.min(260, Math.max(30, now - this.snapAt));
    this.snapAt = now;
  }

  update(now: number): Fx[] {
    const dt = this.lastNow ? Math.min(250, now - this.lastNow) : 0;
    this.lastNow = now;
    if (!this.paused && this.state.phase === 'playing') {
      this.acc += (dt * this.speed) / STEP_MS;
      let steps = Math.min(8, Math.floor(this.acc));
      if (steps > 0) {
        this.acc -= steps;
        if (this.acc > 2) this.acc = 0; // tab was asleep: do not fast-forward
        while (steps-- > 0) advance(this.state);
        this.push(now);
      }
    }
    if (!this.pending.length) return this.pending;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  alpha(now: number): number {
    if (this.paused || this.state.phase !== 'playing') return 1;
    return Math.min(1, Math.max(0, (now - this.snapAt) / this.interval));
  }

  command(cmd: Command): void {
    if (this.me < 0) return;
    const res = applyCommand(this.state, this.me, cmd);
    if (!res.ok) {
      this.onReject(res.err ?? 'Rejected');
      return;
    }
    // Show the result at once, even while paused.
    this.push(performance.now());
  }

  setSpeed(v: number): void {
    this.speed = v;
    this.paused = false;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  /** Run the simulation forward at once (smoke checks and screenshots). */
  warp(ticks: number): void {
    for (let i = 0; i < ticks && this.state.phase === 'playing'; i++) {
      advance(this.state);
      if (i % 20 === 0) this.push(performance.now());
    }
    this.push(performance.now());
  }

  rematch(): void {
    this.matchNo++;
    this.paused = false;
    this.state = this.fresh();
  }

  endless(): void {
    if (continueEndless(this.state)) {
      this.enc.reset();
      this.view.apply(this.enc.encode(this.state, true, this.speed));
      this.push(performance.now());
    }
  }

  dispose(): void {
    this.paused = true;
  }
}

/** One human against 1–3 AI tycoons. */
export function soloSetups(name: string, rivals: number): PlayerSetup[] {
  const out: PlayerSetup[] = [{ name: name || 'You', house: 0, kind: 'human' }];
  for (let i = 0; i < Math.max(1, Math.min(3, rivals)); i++) {
    const persona = AI_ORDER[i];
    out.push({ name: AI_PERSONAS[persona].name, house: i + 1, kind: 'ai', persona });
  }
  return out;
}

/** The district behind the title screen: four AI Houses, playing forever. */
export function attractSetups(): PlayerSetup[] {
  return [0, 1, 2, 3].map((i) => {
    const persona = AI_ORDER[i % AI_ORDER.length];
    return { name: AI_PERSONAS[persona].name, house: i, kind: 'ai' as const, persona };
  });
}

export interface NetEvents {
  onLobby(lobby: LobbyView): void;
  onWelcome(seat: number, player: number): void;
  onStatus(status: 'connecting' | 'open' | 'reconnecting' | 'closed', detail?: string): void;
}

/** A multiplayer room: the server simulates, this client renders and sends commands. */
export class NetSession implements Session {
  readonly kind = 'multi' as const;
  readonly view = new CityView();
  me = -1;
  seat = -1;
  speed = 1;
  paused = false;
  lobby: LobbyView | null = null;
  onReject: (err: string) => void = () => undefined;
  private ws: WebSocket | null = null;
  private pending: Fx[] = [];
  private snapAt = 0;
  private interval = STEP_MS;
  private closed = false;
  private retries = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private playerId: string | null;

  constructor(
    readonly code: string,
    private name: string,
    private events: NetEvents,
  ) {
    this.playerId = this.loadId();
    this.connect();
  }

  private storeKey(): string {
    return `mercadia:pid:${this.code}`;
  }

  private loadId(): string | null {
    try {
      return sessionStorage.getItem(this.storeKey());
    } catch {
      return null;
    }
  }

  private saveId(id: string): void {
    this.playerId = id;
    try {
      sessionStorage.setItem(this.storeKey(), id);
    } catch {
      // without sessionStorage a reload simply takes a fresh seat
    }
  }

  get isHost(): boolean {
    return !!this.lobby && this.seat >= 0 && this.lobby.host === this.seat;
  }

  private connect(): void {
    if (this.closed) return;
    this.events.onStatus(this.retries ? 'reconnecting' : 'connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws/rooms/${this.code}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retries = 0;
      this.events.onStatus('open');
      const hello: ClientMsg = { t: 'hello', name: this.name };
      if (this.playerId) hello.playerId = this.playerId;
      ws.send(JSON.stringify(hello));
      if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', at: Date.now() }), 20000);
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      this.receive(msg);
    });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.closed) return;
      if (ev.code === 4004) {
        this.closed = true;
        this.events.onStatus('closed', 'That room no longer exists.');
        return;
      }
      if (ev.code === 4001) {
        this.closed = true;
        this.events.onStatus('closed', 'This seat was opened in another tab.');
        return;
      }
      this.scheduleRetry();
    });
    ws.addEventListener('error', () => {
      // 'close' follows and handles the retry
    });
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    if (this.retries >= 6) {
      this.closed = true;
      this.events.onStatus('closed', 'Lost the connection to the room.');
      return;
    }
    const wait = Math.min(4000, 500 * Math.pow(1.7, this.retries));
    this.retries++;
    this.events.onStatus('reconnecting');
    this.retryTimer = window.setTimeout(() => this.connect(), wait);
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.saveId(msg.playerId);
        this.seat = msg.seat;
        this.me = msg.player;
        this.lobby = msg.lobby;
        this.speed = msg.lobby.speed;
        this.events.onWelcome(msg.seat, msg.player);
        this.events.onLobby(msg.lobby);
        break;
      case 'lobby':
        this.lobby = msg.lobby;
        this.speed = msg.lobby.speed;
        this.events.onLobby(msg.lobby);
        break;
      case 'snap': {
        const now = performance.now();
        const fx = this.view.apply(msg);
        for (const f of fx) this.pending.push(f);
        this.interval = Math.min(300, Math.max(40, this.snapAt ? now - this.snapAt : STEP_MS));
        this.snapAt = now;
        break;
      }
      case 'reject':
      case 'error':
        this.onReject(msg.err);
        break;
      default:
        break;
    }
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  update(_now: number): Fx[] {
    if (!this.pending.length) return this.pending;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  alpha(now: number): number {
    return Math.min(1, Math.max(0, (now - this.snapAt) / this.interval));
  }

  command(cmd: Command): void {
    if (this.me < 0) {
      this.onReject('Spectators cannot act');
      return;
    }
    this.send({ t: 'cmd', cmd });
  }

  setSpeed(v: number): void {
    this.send({ t: 'speed', speed: v });
  }

  togglePause(): void {
    // A shared city has no pause.
  }

  rematch(): void {
    this.send({ t: 'rematch' });
  }

  endless(): void {
    this.send({ t: 'endless' });
  }

  dispose(): void {
    this.closed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    if (this.ws) {
      try {
        this.ws.close(1000, 'leaving');
      } catch {
        // already gone
      }
      this.ws = null;
    }
  }
}

export async function createRoom(): Promise<string> {
  const res = await fetch('/api/rooms', { method: 'POST' });
  if (!res.ok) throw new Error('The room service did not answer.');
  const body = (await res.json()) as { code?: string };
  if (!body.code) throw new Error('The room service sent no code.');
  return body.code;
}

export async function roomExists(code: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/rooms/${code}`);
    await res.text(); // drain the body so the request completes
    return res.ok;
  } catch {
    return false;
  }
}
