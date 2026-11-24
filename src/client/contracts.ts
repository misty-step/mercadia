// Contracts between the three client layers: Session (state + transport), Board (canvas) and
// HUD (DOM). Types only — implemented by session.ts, board.ts and hud.ts/main.ts.
import type { Plan } from '../shared/orders';
import type { LobbyView, SeatStatus } from '../shared/protocol';
import type { MatchExport } from '../shared/replay';
import type { BuildKind, Game, MatchMode, Order, SummaryLine, TurnSummary } from '../shared/types';

export type SessionMode = 'solo' | 'hotseat' | 'room';

/** The Status line: one line of connection and turn state. Errors use role "alert". */
export interface StatusLine {
  text: string; // 'Your turn' | 'Waiting for opponent…' | 'Resolving Turn 12…' | 'Reconnecting…' | error text
  tone: 'info' | 'wait' | 'reconnect' | 'error'; // Ink | Brass rule | Terracotta rule | Alert rule
}

/** What the End Turn button shows. It always reflects the last ACKNOWLEDGED readiness. */
export interface EndTurnState {
  label: string; // 'End Turn' | 'Cancel Ready' | 'Choose a Charter' | 'Saving draft…' | 'Reconnecting…' | 'Resolving Turn 12…' | 'Spectating' | 'Match over'
  enabled: boolean;
  kind: 'end' | 'cancel';
}

export interface SessionView {
  mode: SessionMode;
  /** The authoritative world for the current turn (frozen while planning). */
  game: Game;
  /** Full state hash of `game` (the HUD shows the short form via shortHash). */
  hash: string;
  /** The Turn Delta that produced `game` (always matches `game`'s turn − 1 → turn), or null on Turn 1. */
  summary: TurnSummary | null;
  /** Recent Turn Deltas, oldest first (at most 4), for previous/next browsing. */
  summaries: TurnSummary[];
  /** Increments exactly once each time a NEWER turn's world+summary is applied: the HUD opens the Turn Delta drawer on change. */
  resolutions: number;
  /** The viewing seat's player index, or -1 for a spectator. Hotseat: the seat currently planning. */
  seat: number;
  draft: Order[];
  /** Local draft revision / the revision the authority acknowledged (rooms; equal in solo and hotseat). */
  revision: number;
  ackedRevision: number;
  /** Projection of the draft: projected cash, Actions used, planned unit tiles… (null for spectators / ended). */
  plan: Plan | null;
  actions: { used: number; max: number };
  projectedCash: number;
  /** Acknowledged readiness for the current turn (rooms): the HUD never shows an unacknowledged press as Ready. */
  ready: boolean;
  status: StatusLine;
  endTurn: EndTurnState;
  /** Public Ready and presence for every seat (rooms) or planning order (hotseat). */
  seats: SeatStatus[];
  /** Transient notices (e.g. `Turn 12 resolved while you were offline — unsent edits discarded`), newest last. */
  notices: { id: number; text: string; tone: 'info' | 'error' }[];
  /** Order-removal notice produced by the last undo/prune (dependent orders removed), or ''. */
  pruned: string;
  /** Hotseat: the next seat that must press "Begin … turn" before the draft/board is shown. */
  handoff: { player: number } | null;
  /** Rooms: the room code, e.g. 'ABCD', else ''. */
  roomCode: string;
  /** Lobby view when the room has not started (mode 'room'). */
  lobby: LobbyView | null;
  /** True when this seat is the room host. */
  host: boolean;
  /** True once the match is over (Final Edition). */
  ended: boolean;
}

export interface Session {
  readonly view: SessionView;
  subscribe(fn: (v: SessionView) => void): () => void;

  /** Queue an order at the end of the draft. Returns the reason on failure (shown inline). */
  queue(order: Order): { ok: true } | { ok: false; reason: string };
  /** Undo the order at `index`; dependent orders are removed too (see view.pruned). */
  undo(index: number): void;
  clear(): void;
  reorder(from: number, to: number): void;

  /** End Turn (solo, hotseat), or Ready / Cancel Ready (rooms). Idempotent per acknowledged state. */
  endTurn(): void;
  /** Hotseat: the next seat begins its turn (dismisses the handoff screen). */
  beginTurn(): void;

  continueEndless(): void;
  rematch(): void;
  leave(): void;
  /** Seed + canonical action log for replay (null before any turn resolves). */
  exportMatch(): MatchExport | null;

  // Rooms: lobby controls (host only where noted).
  lobby: {
    setName(name: string): void;
    setHouse(house: number): void;
    setSeatAi(seat: number, ai: boolean): void;
    setAiFill(on: boolean): void;
    setMode(mode: MatchMode): void;
    start(): void;
  };
}

export interface SessionOptions {
  mode: SessionMode;
  /** Solo/hotseat: the match configuration; rooms: the room code to join. */
  config?: import('../shared/types').MatchConfig;
  roomCode?: string;
  name?: string;
  /** Test hook: wrap the WebSocket constructor (the relay used by the acceptance harness). */
  socketFactory?: (url: string) => WebSocket;
}

// ───────────────────────────── Board ─────────────────────────────

export interface Hit {
  tile: number; // board tile index, snapped to the nearest lot/street when the tap is close
  unit: number; // unit id at that tile, or 0
  building: number; // building id at that tile, or 0
}

export type Armed =
  | { kind: 'build'; build: BuildKind }
  | { kind: 'move'; unit: number }
  | { kind: 'contest'; unit: number }
  | { kind: 'tile' } // pick a tile for a pending command (Barge route, restock target …)
  | null;

export interface BoardState {
  game: Game;
  /** Viewing seat's player index (or -1): its own overlays use its House colour. */
  player: number;
  /** The viewer's draft, drawn as ghost overlays (paths, planned buildings, contests). Never alters the world. */
  draft: Order[];
  plan: Plan | null;
  /** Latest Turn Delta: lines with tile ≥ 0 become numbered change markers. */
  summary: TurnSummary | null;
  showMarkers: boolean;
  selectedTile: number; // -1 none
  selectedUnit: number; // 0 none
  armed: Armed;
  /** Tiles the armed tool may legally target (dotted hairline boundary / green wash). */
  legalTiles: ReadonlySet<number>;
  hoverTile: number;
  /** Keyboard tile cursor, shown only while the board has focus. */
  cursorTile: number;
  /** Lot bonus dots (Corner, Canal-front, Transit, civic aura) while a build tool is armed. */
  showBonuses: boolean;
}

export interface BoardApi {
  setState(s: BoardState): void;
  onPick(cb: (hit: Hit, e: { shift: boolean; touch: boolean; right: boolean }) => void): void;
  onHover(cb: (tile: number) => void): void;
  /** Keyboard cursor moves are driven by the HUD; the board only draws `cursorTile`. */
  fit(): void;
  centerOn(tile: number): void;
  zoomBy(factor: number): void;
  panBy(dx: number, dy: number): void;
  /** HUD occupies these screen margins (px): fit/centerOn keep the district clear of them. */
  setInsets(i: { top: number; right: number; bottom: number; left: number }): void;
  resize(): void;
  /** Screen position of a tile's centre (for popovers), or null off-screen. */
  tileScreenPos(tile: number): { x: number; y: number } | null;
  destroy(): void;
}

export type { SummaryLine };
