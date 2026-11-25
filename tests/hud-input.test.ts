// HUD keyboard rules: the global Enter/Space shortcut, single-key shortcuts, and the End Turn gesture guard.
import { describe, expect, it } from 'vitest';
import { EndGuard, classifyFocus, keyCommand, stepCursor, type KeyCtx } from '../src/client/hud-input';

const key = (k: string, o: Partial<KeyCtx> = {}): KeyCtx => ({ key: k, repeat: false, isComposing: false, ctrl: false, meta: false, alt: false, shift: false, ...o });

describe('global Enter/Space shortcut', () => {
  it('ends the turn only when focus is on the page body', () => {
    expect(keyCommand(key('Enter'), 'body', false)).toEqual({ t: 'end' });
    expect(keyCommand(key(' '), 'body', false)).toEqual({ t: 'end' });
    for (const k of ['control', 'text', 'panel'] as const) {
      expect(keyCommand(key('Enter'), k, false)).toBeNull();
      expect(keyCommand(key(' '), k, false)).toBeNull();
    }
  });

  it('acts on the tile cursor, never ends the turn, while the board has focus', () => {
    expect(keyCommand(key('Enter'), 'board', false)).toEqual({ t: 'act', shift: false });
    expect(keyCommand(key(' ', { shift: true }), 'board', false)).toEqual({ t: 'act', shift: true });
  });

  it('is suppressed by a modal, a modifier, IME composition and auto-repeat', () => {
    expect(keyCommand(key('Enter'), 'body', true)).toBeNull();
    expect(keyCommand(key(' '), 'body', true)).toBeNull();
    for (const m of ['ctrl', 'meta', 'alt'] as const) expect(keyCommand(key('Enter', { [m]: true }), 'body', false)).toBeNull();
    expect(keyCommand(key('Enter', { isComposing: true }), 'body', false)).toBeNull();
    expect(keyCommand(key('Process'), 'body', false)).toBeNull();
    expect(keyCommand(key('Enter', { repeat: true }), 'body', false)).toBeNull();
    expect(keyCommand(key('Enter', { repeat: true }), 'board', false)).toBeNull();
  });
});

describe('single-key shortcuts', () => {
  it('never fire while a text field has focus', () => {
    for (const k of ['w', 'a', 's', 'd', 'f', 'm', 'o', 't', '1', '+', '-', 'Backspace', 'Escape', 'ArrowLeft']) {
      expect(keyCommand(key(k), 'text', false)).toBeNull();
    }
    expect(keyCommand(key('z', { ctrl: true }), 'text', false)).toBeNull();
  });

  it('maps the documented keys', () => {
    expect(keyCommand(key('1'), 'body', false)).toEqual({ t: 'tool', n: 1 });
    expect(keyCommand(key('9'), 'control', false)).toEqual({ t: 'tool', n: 9 });
    expect(keyCommand(key('0'), 'body', false)).toBeNull();
    expect(keyCommand(key('o'), 'body', false)).toEqual({ t: 'orders' });
    expect(keyCommand(key('T'), 'body', false)).toEqual({ t: 'delta' });
    expect(keyCommand(key('f'), 'body', false)).toEqual({ t: 'fit' });
    expect(keyCommand(key('m'), 'body', false)).toEqual({ t: 'mute' });
    expect(keyCommand(key('Escape'), 'body', false)).toEqual({ t: 'esc' });
    expect(keyCommand(key('Backspace'), 'body', false)).toEqual({ t: 'undo' });
    expect(keyCommand(key('z', { ctrl: true }), 'body', false)).toEqual({ t: 'undo' });
    expect(keyCommand(key('z', { meta: true }), 'control', false)).toEqual({ t: 'undo' });
    expect(keyCommand(key('+'), 'body', false)).toEqual({ t: 'zoom', f: 1.2 });
    expect(keyCommand(key('-'), 'body', false)?.t).toBe('zoom');
  });

  it('pans with WASD and arrows when the board is not focused, moves the cursor when it is', () => {
    expect(keyCommand(key('a'), 'body', false)).toEqual({ t: 'pan', dx: -1, dy: 0 });
    expect(keyCommand(key('ArrowDown'), 'control', false)).toEqual({ t: 'pan', dx: 0, dy: 1 });
    expect(keyCommand(key('ArrowRight'), 'board', false)).toEqual({ t: 'cursor', dx: 1, dy: 0 });
    expect(keyCommand(key('a'), 'board', false)).toBeNull();
    // A focused drawer scrolls with the arrow keys instead of panning the board.
    expect(keyCommand(key('ArrowDown'), 'panel', false)).toBeNull();
  });

  it('is ignored entirely while a modal is open', () => {
    for (const k of ['1', 'o', 't', 'Escape', 'Backspace', 'ArrowLeft', 'f']) expect(keyCommand(key(k), 'body', true)).toBeNull();
  });
});

describe('classifyFocus', () => {
  const el = (tag: string, attrs: Record<string, string> = {}): Element => {
    const a = { ...attrs };
    return { tagName: tag, type: a.type ?? '', getAttribute: (n: string) => a[n] ?? null, hasAttribute: (n: string) => n in a } as unknown as Element;
  };
  const board = el('CANVAS');
  it('recognises body, board, text fields, controls and panels', () => {
    expect(classifyFocus(null, board)).toBe('body');
    expect(classifyFocus(el('BODY'), board)).toBe('body');
    expect(classifyFocus(board, board)).toBe('board');
    expect(classifyFocus(el('INPUT', { type: 'text' }), board)).toBe('text');
    expect(classifyFocus(el('TEXTAREA'), board)).toBe('text');
    expect(classifyFocus(el('SELECT'), board)).toBe('text');
    expect(classifyFocus(el('DIV', { contenteditable: 'true' }), board)).toBe('text');
    expect(classifyFocus(el('INPUT', { type: 'checkbox' }), board)).toBe('control');
    expect(classifyFocus(el('BUTTON'), board)).toBe('control');
    expect(classifyFocus(el('A'), board)).toBe('control');
    expect(classifyFocus(el('ASIDE', { 'data-panel': '' }), board)).toBe('panel');
  });
});

describe('EndGuard', () => {
  it('ignores a second activation within 400 ms (double click, double tap)', () => {
    const g = new EndGuard();
    expect(g.accept(1000, 0, false)).toBe(true);
    expect(g.accept(1150, 1, false)).toBe(false);
    expect(g.accept(1399, 1, false)).toBe(false);
    expect(g.accept(1500, 1, false)).toBe(true);
  });

  it('a key held across a resolution needs a fresh keydown (Space activates on keyup)', () => {
    const g = new EndGuard();
    g.keyDown(3); // key pressed while resolution count was 3
    expect(g.accept(5000, 4, true)).toBe(false); // the turn resolved while it was held
    expect(g.accept(6000, 4, true)).toBe(true); // a later click without a stale key is fine
    g.keyDown(4);
    expect(g.accept(7000, 4, true)).toBe(true); // fresh keydown after the resolution
  });

  it('a keyboard activation with a fresh keydown works once', () => {
    const g = new EndGuard();
    g.keyDown(0);
    expect(g.accept(100, 0, true)).toBe(true);
    expect(g.accept(200, 1, true)).toBe(false);
  });
});

describe('stepCursor', () => {
  it('moves within the 12x12 grid and clamps at the edges', () => {
    expect(stepCursor(0, -1, 0)).toBe(0);
    expect(stepCursor(0, 0, -1)).toBe(0);
    expect(stepCursor(0, 1, 0)).toBe(1);
    expect(stepCursor(0, 0, 1)).toBe(12);
    expect(stepCursor(143, 1, 1)).toBe(143);
    expect(stepCursor(-1, 1, 0)).toBeGreaterThanOrEqual(0);
  });
});
