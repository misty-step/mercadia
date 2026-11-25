// HUD keyboard rules as pure functions (DESIGN.md "Controls and focus"), so they can be unit tested
// without a DOM:
//   • classifyFocus  — what currently has focus (page body, board, text field, control, panel)
//   • keyCommand     — which HUD command a key press means, given the focus class and modals
//   • EndGuard       — "one deliberate press advances exactly one turn" (double click, held key)
//   • stepCursor     — the board's keyboard tile cursor

export type FocusKind = 'body' | 'board' | 'text' | 'control' | 'panel';

export interface KeyCtx {
  key: string;
  repeat: boolean;
  isComposing: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export type Cmd =
  | { t: 'end' }
  | { t: 'act'; shift: boolean }
  | { t: 'cursor'; dx: number; dy: number }
  | { t: 'pan'; dx: number; dy: number }
  | { t: 'zoom'; f: number }
  | { t: 'tool'; n: number }
  | { t: 'esc' }
  | { t: 'undo' }
  | { t: 'orders' }
  | { t: 'delta' }
  | { t: 'fit' }
  | { t: 'mute' };

const TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** Classify the focused element. `board` is the canvas; panels are scrollable containers made focusable by the HUD. */
export function classifyFocus(el: Element | null, board: Element | null): FocusKind {
  if (!el) return 'body';
  const tag = el.tagName;
  if (tag === 'BODY' || tag === 'HTML') return 'body';
  if (board && el === board) return 'board';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 'text';
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type) ? 'control' : 'text';
  const ce = el.getAttribute('contenteditable');
  if (ce !== null && ce !== 'false') return 'text';
  if (el.hasAttribute('data-panel')) return 'panel';
  return 'control';
}

const isSpace = (k: string): boolean => k === ' ' || k === 'Spacebar';

/**
 * Map a key press to a HUD command, or null to leave it alone. `modalOpen` is true while any
 * `[data-modal]:not([hidden])` exists (Council card, handoff, confirmation, Final Edition).
 *
 * The global Enter/Space shortcut (`end`) fires only when focus is on the page body, never during
 * a modal, with a modifier held, during IME composition, or on auto-repeat. Every other focus
 * kind keeps the native behaviour of Enter/Space.
 */
export function keyCommand(k: KeyCtx, focus: FocusKind, modalOpen: boolean): Cmd | null {
  if (modalOpen) return null;
  if (k.isComposing || k.key === 'Process' || k.key === 'Dead') return null;
  const mod = k.ctrl || k.meta || k.alt;
  if (mod) {
    if ((k.ctrl || k.meta) && !k.alt && !k.shift && k.key.toLowerCase() === 'z' && focus !== 'text') return { t: 'undo' };
    return null;
  }
  if (focus === 'text') return null;

  if (k.key === 'Enter' || isSpace(k.key)) {
    if (k.repeat) return null;
    if (focus === 'body') return { t: 'end' };
    if (focus === 'board') return { t: 'act', shift: k.shift };
    return null;
  }
  if (k.key === 'Escape') return { t: 'esc' };
  if (k.key === 'Backspace') return { t: 'undo' };

  const arrow = k.key === 'ArrowLeft' ? [-1, 0] : k.key === 'ArrowRight' ? [1, 0] : k.key === 'ArrowUp' ? [0, -1] : k.key === 'ArrowDown' ? [0, 1] : null;
  if (arrow) {
    if (focus === 'board') return { t: 'cursor', dx: arrow[0], dy: arrow[1] };
    if (focus === 'panel') return null; // let a focused drawer scroll natively
    return { t: 'pan', dx: arrow[0], dy: arrow[1] };
  }
  switch (k.key.toLowerCase()) {
    case 'a':
      return focus === 'board' ? null : { t: 'pan', dx: -1, dy: 0 };
    case 'd':
      return focus === 'board' ? null : { t: 'pan', dx: 1, dy: 0 };
    case 'w':
      return focus === 'board' ? null : { t: 'pan', dx: 0, dy: -1 };
    case 's':
      return focus === 'board' ? null : { t: 'pan', dx: 0, dy: 1 };
    case '+':
    case '=':
      return { t: 'zoom', f: 1.2 };
    case '-':
    case '_':
      return { t: 'zoom', f: 1 / 1.2 };
    case 'o':
      return { t: 'orders' };
    case 't':
      return { t: 'delta' };
    case 'f':
      return { t: 'fit' };
    case 'm':
      return { t: 'mute' };
    default:
      break;
  }
  if (/^[1-9]$/.test(k.key)) return { t: 'tool', n: Number(k.key) };
  return null;
}

/**
 * Guards End Turn against one gesture advancing more than one turn.
 *  • a second activation within `windowMs` of the first is ignored (double click, double tap);
 *  • a keyboard-generated click whose key went down before the latest resolution is ignored, so a
 *    key held across a resolution needs a fresh keydown (Space activates on keyup);
 *  • auto-repeat is ignored by the callers through `KeyCtx.repeat`.
 */
export class EndGuard {
  private last = -Infinity;
  private keyRes: number | null = null;
  constructor(private windowMs = 400) {}

  /** A fresh (non-repeat) Enter/Space keydown at the current resolution count. */
  keyDown(resolutions: number): void {
    this.keyRes = resolutions;
  }

  /**
   * An activation (click, tap, or the global shortcut). `keyboard` is true for a click without a
   * pointer (`event.detail === 0`). Returns whether it may advance the turn.
   */
  accept(now: number, resolutions: number, keyboard: boolean): boolean {
    if (now - this.last < this.windowMs) return false;
    if (keyboard && this.keyRes !== null && this.keyRes !== resolutions) {
      this.keyRes = null;
      return false;
    }
    this.keyRes = null;
    this.last = now;
    return true;
  }
}

/** Move the keyboard tile cursor one tile on the 12×12 grid; it starts at `from` (or the centre). */
export function stepCursor(from: number, dx: number, dy: number, size = 12): number {
  const start = from >= 0 && from < size * size ? from : Math.floor(size / 2) * size + Math.floor(size / 2) - 1;
  if (from < 0) return start;
  const x = Math.min(size - 1, Math.max(0, (start % size) + dx));
  const y = Math.min(size - 1, Math.max(0, Math.floor(start / size) + dy));
  return y * size + x;
}
