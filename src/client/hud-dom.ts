// Small DOM helpers for the HUD: HTML escaping, money formatting, and a minimal DOM morph.
//
// The HUD renders each surface to an HTML string (every dynamic value passes through `esc`) and
// morphs it into the live DOM, so a re-render keeps focus, scroll position and hover state on the
// elements that did not change. All handlers are delegated from the HUD root (data-act), so
// nothing here sets inline styles, inline handlers or `style` attributes (CSP: style-src 'self').

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for use in HTML content and quoted attribute values. */
export const esc = (s: string | number): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** `§1,240` — integer §, thousands separated. */
export const money = (n: number): string => `§${Math.round(n).toLocaleString('en-US')}`;
/** `+§212` / `−§40` with a true minus sign. */
export const signed = (n: number): string => (n < 0 ? `−${money(-n)}` : `+${money(n)}`);

const KEY = 'data-k';

function syncAttrs(t: Element, s: Element): void {
  for (const a of Array.from(t.attributes)) if (!s.hasAttribute(a.name)) t.removeAttribute(a.name);
  for (const a of Array.from(s.attributes)) if (t.getAttribute(a.name) !== a.value) t.setAttribute(a.name, a.value);
}

function keyOf(n: Node | undefined | null): string | null {
  return n && n.nodeType === 1 ? (n as Element).getAttribute(KEY) : null;
}

/** Make the children of `t` match the children of `s` (`s` is consumed). Elements carrying `data-k` are matched by key. */
export function morphChildren(t: ParentNode & Node, s: ParentNode & Node): void {
  const keyed = new Map<string, Element>();
  for (const c of Array.from(t.childNodes)) {
    const k = keyOf(c);
    if (k) keyed.set(k, c as Element);
  }
  let ti = 0;
  for (const sn of Array.from(s.childNodes)) {
    let tn: Node | undefined = t.childNodes[ti];
    const sk = keyOf(sn);
    if (sk) {
      const m = keyed.get(sk);
      if (m && m.nodeName === sn.nodeName) {
        keyed.delete(sk);
        if (m !== tn) t.insertBefore(m, tn ?? null);
        morphElement(m, sn as Element);
      } else t.insertBefore(sn, tn ?? null);
      ti++;
      continue;
    }
    if (tn && keyOf(tn) === null && tn.nodeType === sn.nodeType && tn.nodeName === sn.nodeName) {
      if (sn.nodeType === 1) morphElement(tn as Element, sn as Element);
      else if (tn.nodeValue !== sn.nodeValue) tn.nodeValue = sn.nodeValue;
    } else if (tn && keyOf(tn) === null) {
      t.replaceChild(sn, tn);
    } else t.insertBefore(sn, tn ?? null);
    ti++;
    tn = undefined;
  }
  while (t.childNodes.length > ti) t.removeChild(t.lastChild as Node);
}

function morphElement(t: Element, s: Element): void {
  syncAttrs(t, s);
  morphChildren(t, s);
}

const tpl = typeof document !== 'undefined' ? document.createElement('template') : (null as unknown as HTMLTemplateElement);

/** Parse trusted, escaped HTML and morph it into `container`. */
export function patch(container: Element, html: string): void {
  tpl.innerHTML = html;
  morphChildren(container, tpl.content);
}

/** Tiny conditional join for class lists. */
export const cls = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

/** The roman numeral of an Era number. */
export const ROMAN = ['I', 'II', 'III', 'IV'];
