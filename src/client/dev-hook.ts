// window.__mercadia: a READ-ONLY inspector for tests and replay (DESIGN.md §5 "Verification hook").
//
// Available only on localhost / 127.0.0.1 or with `?dev=1`. Every member is a getter or a pure
// reader that returns copies: nothing here queues an order, ends a turn, skips ahead or warps
// time, and nothing hands out a reference to live state.
import type { Session, SessionView } from './contracts';
import type { MatchExport } from '../shared/replay';
import type { Order, TurnSummary } from '../shared/types';

export interface MercadiaInspector {
  readonly version: 3;
  readonly phase: 'none' | 'lobby' | 'planning' | 'ended';
  readonly turn: number;
  /** The full state hash of the current world. */
  readonly hash: string;
  /** The latest Turn Delta (the one that produced the current turn), or null. */
  readonly summary: TurnSummary | null;
  /** The viewing seat's local draft. */
  readonly draft: Order[];
  readonly seat: number;
  readonly mode: string;
  /** Seed + canonical action log for replay, or null before the first resolution (and in rooms). */
  exportMatch(): MatchExport | null;
  /** A frozen deep copy of the whole session view. */
  readonly view: Readonly<SessionView> | null;
}

declare global {
  interface Window {
    __mercadia?: MercadiaInspector;
  }
}

export function devHookEnabled(loc: Pick<Location, 'hostname' | 'search'> = window.location): boolean {
  if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1' || loc.hostname === '[::1]') return true;
  return new URLSearchParams(loc.search).get('dev') === '1';
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const copy = <T>(v: T): T => (v === null || v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Install the inspector. `current` returns the live session (or null on the title screen). */
export function installDevHook(current: () => Session | null): void {
  if (!devHookEnabled()) return;
  const view = (): SessionView | null => current()?.view ?? null;
  const api: MercadiaInspector = {
    version: 3,
    get phase() {
      const v = view();
      if (!v) return 'none';
      if (v.lobby && v.lobby.status === 'lobby') return 'lobby';
      return v.ended ? 'ended' : 'planning';
    },
    get turn() {
      return view()?.game.turn ?? 0;
    },
    get hash() {
      return view()?.hash ?? '';
    },
    get summary() {
      return copy(view()?.summary ?? null);
    },
    get draft() {
      return copy(view()?.draft ?? []);
    },
    get seat() {
      return view()?.seat ?? -1;
    },
    get mode() {
      return view()?.game.mode ?? '';
    },
    exportMatch() {
      return copy(current()?.exportMatch() ?? null);
    },
    get view() {
      const v = view();
      return v ? deepFreeze(copy(v)) : null;
    },
  };
  Object.defineProperty(window, '__mercadia', { value: Object.freeze(api), configurable: false, enumerable: false, writable: false });
}
