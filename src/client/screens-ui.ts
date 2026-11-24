// Small DOM helpers shared by the screens. CSP-safe by construction: there is no way to write an
// inline `style` attribute through `h()`, user text only ever reaches the page as textContent,
// and the only innerHTML is bespoke SVG built from our own constants (crests, icons, chart).
import { crestSvg } from './heraldry';
import { HOUSES } from '../shared/constants';

export type Kid = Node | string | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

/** Create an element. `class`, `text`, `html` (trusted SVG only), `on<event>` handlers and plain attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style') throw new Error('Inline style attributes are not allowed by the CSP; use classes or CSSOM');
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return el;
}

export const house = (i: number): (typeof HOUSES)[number] => HOUSES[((i % HOUSES.length) + HOUSES.length) % HOUSES.length];

/** A decorative or labelled House crest as an element. */
export function crest(houseIndex: number, cls = '', quiet = true): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `crest-slot ${cls}`.trim();
  s.innerHTML = crestSvg(houseIndex, { quiet });
  return s;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const focusables = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => !e.hasAttribute('hidden') && e.getClientRects().length > 0);

/** Keep Tab inside `root` while it is open. Returns the disposer. */
export function trapFocus(root: HTMLElement): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const f = focusables(root);
    if (f.length === 0) {
      e.preventDefault();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}

/** A 32-bit seed from the platform CSPRNG. Seeds are match inputs the player can see, not game logic. */
export function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] >>> 0;
}

export const fmtMoney = (n: number): string => `${n < 0 ? '−' : ''}§${Math.abs(n).toLocaleString('en-US')}`;

/** Normalise a typed room code: four letters, upper case. */
export function cleanRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export const NAME_KEY = 'mercadia:name';

export function savedName(): string {
  try {
    return (localStorage.getItem(NAME_KEY) ?? '').slice(0, 16);
  } catch {
    return '';
  }
}

export function saveName(n: string): void {
  try {
    localStorage.setItem(NAME_KEY, n.slice(0, 16));
  } catch {
    // storage unavailable
  }
}

/** Trim and bound a typed player name; fall back when empty. Pure. */
export function cleanPlayerName(raw: string, fallback: string): string {
  const s = Array.from(raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 16).join('').trim();
  return s || fallback;
}
