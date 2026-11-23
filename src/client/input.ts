// Pure input policy: which key does what, given where the player is. No DOM in here, so the
// rules (overlays swallow build and speed hotkeys; a finished match disarms the build tool)
// are unit-tested directly.
import { BUILD_KINDS, isUnlocked } from '../shared/constants';
import type { BuildKind } from '../shared/types';

export interface KeyContext {
  phase: 'title' | 'lobby' | 'playing';
  /** The Final Edition (victory) modal is on screen. */
  victoryOpen: boolean;
  /** The match has reached its final bell. */
  ended: boolean;
  /** Player index this client controls, or -1 for a spectator. */
  me: number;
  kind: 'attract' | 'solo' | 'multi';
  tool: BuildKind | null;
  /** The Era Council modal is on screen (the city is paused). */
  councilOpen?: boolean;
  /** The era clock (the match's quarter counter): decides which build tools are unlocked. */
  quarter?: number;
}

export type KeyAction =
  | { a: 'none' }
  | { a: 'pan' }
  | { a: 'zoom'; factor: number }
  | { a: 'mute' }
  | { a: 'escape' }
  | { a: 'fit' }
  | { a: 'pause' }
  | { a: 'tool'; kind: BuildKind | null }
  /** A hotkey for a tool whose era has not come: the caller shows the unlock notice. */
  | { a: 'locked'; kind: BuildKind };

const PAN_KEYS = ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** Normalise KeyboardEvent.key: single characters fold to lower case. */
export const normKey = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);

/**
 * True while an overlay owns the screen: the Title card, the Lobby, the Era Council, or the
 * Final Edition. Gameplay hotkeys (build tools 1–9, Space to pause) must not leak through any
 * of them.
 */
export const overlayActive = (c: Pick<KeyContext, 'phase' | 'victoryOpen' | 'ended' | 'councilOpen'>): boolean =>
  c.phase !== 'playing' || c.victoryOpen || c.ended || !!c.councilOpen;

export function resolveKey(rawKey: string, c: KeyContext): KeyAction {
  const k = normKey(rawKey);
  if (PAN_KEYS.includes(k)) return { a: 'pan' };
  if (k === '+' || k === '=') return { a: 'zoom', factor: 1.18 };
  if (k === '-' || k === '_') return { a: 'zoom', factor: 1 / 1.18 };
  if (k === 'm') return { a: 'mute' };
  if (k === 'Escape') return { a: 'escape' };
  if (k === 'f') return { a: 'fit' };
  // Everything below acts on the match itself.
  if (overlayActive(c)) return { a: 'none' };
  if (k === ' ') return c.kind === 'solo' ? { a: 'pause' } : { a: 'none' };
  if (k >= '1' && k <= '9' && c.me >= 0) {
    const kind = BUILD_KINDS[Number(k) - 1];
    if (!kind) return { a: 'none' };
    // A future-era tool is never armed: the key answers with its unlock notice instead.
    if (c.quarter !== undefined && !isUnlocked(kind, c.quarter)) return { a: 'locked', kind };
    return { a: 'tool', kind: c.tool === kind ? null : kind };
  }
  return { a: 'none' };
}

export interface ArmedUi {
  tool: BuildKind | null;
  hoverTile: number;
  selectedTile: number;
  selectedCitizen: number;
}

/** Disarm everything: no build tool, no hover, no selection. */
export function disarm<T extends ArmedUi>(ui: T): T {
  ui.tool = null;
  ui.hoverTile = -1;
  ui.selectedTile = -1;
  ui.selectedCitizen = -1;
  return ui;
}

/**
 * Identity of the match on screen. When it changes — the final bell, a Rematch (new seed),
 * Continue in Endless (ended → running), an Era Council opening or closing — any armed build
 * tool must be dropped.
 */
export const matchStamp = (v: { seed: number; ended: boolean; endless: boolean; inCouncil?: boolean }): string =>
  `${v.seed}|${v.ended ? 1 : 0}|${v.endless ? 1 : 0}|${v.inCouncil ? 1 : 0}`;

/** Notices when the match on screen changes, so the caller can disarm exactly once per change. */
export class MatchWatch {
  private last = '';
  /** True when `view` is a different match (or match state) than the one seen last time. */
  changed(view: { ready: boolean; seed: number; ended: boolean; endless: boolean; inCouncil?: boolean }): boolean {
    const stamp = view.ready ? matchStamp(view) : '';
    if (stamp === this.last) return false;
    const first = this.last === '';
    this.last = stamp;
    return !first;
  }
}

/**
 * The console test hook `__mercadia.warp()` is a cheat on a public host. It stays on for
 * local development and smoke tests, and elsewhere only when the URL carries ?dev=1.
 */
export function devHooksAllowed(hostname: string, search: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')) return true;
  return new URLSearchParams(search).get('dev') === '1';
}

/** Two-click confirmation for destructive buttons: armed until `until`, then it lapses. */
export class Confirm {
  private until = 0;
  constructor(readonly windowMs = 4000) {}
  /** Register a click. Returns true when this click is the confirming second one. */
  click(now: number): boolean {
    if (now < this.until) {
      this.until = 0;
      return true;
    }
    this.until = now + this.windowMs;
    return false;
  }
  armed(now: number): boolean {
    return now < this.until;
  }
  reset(): void {
    this.until = 0;
  }
}
