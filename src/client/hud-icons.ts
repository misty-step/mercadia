// Bespoke inline SVG icons for the HUD. 24×24 viewBox, currentColor strokes, no emoji or icon font.
// Shop, civic, event and Charter glyphs come from the shared set in icons.ts; the glyphs below are
// the interface and order-tool marks drawn for the Command rail.
import { ICONS } from './icons';

const svg = (body: string): string => `<svg class="hi" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

const sh = (name: string): string => (ICONS[name] ?? '').replace('class="ic"', 'class="hi"');

const OWN: Record<string, string> = {
  undo: svg('<path d="M9 8H4V3"/><path d="M4.6 8A8 8 0 1 1 6.2 17.2"/>'),
  up: svg('<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>'),
  down: svg('<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>'),
  prev: svg('<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>'),
  next: svg('<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>'),
  factor: svg('<circle cx="12" cy="6.2" r="2.6"/><path d="M9.6 21V11.2h4.8V21M7.5 21h9"/>'),
  watch: svg('<path d="M5 4h14v9c0 4-3 6.5-7 8-4-1.5-7-4-7-8z"/><path d="M12 8v7M8.8 11.5h6.4"/>'),
  barge: svg('<path d="M3 14.5h18l-2.4 5H5.4z"/><path d="M12 14.5V5.5l5 5.5"/><path d="M12 8.5 8.5 14"/>'),
  truce: svg('<path d="M4.5 19.5 19.5 4.5"/><path d="M9.4 15c-2.5-.3-4-1.6-4.2-4 2.4-.2 4 1 4.2 4zM13.4 11c-2.5-.3-4-1.6-4.2-4 2.4-.2 4 1 4.2 4zM17.6 7.2c-2.5-.3-4-1.6-4.2-4 2.4-.2 4 1 4.2 4z"/>'),
  trade: svg('<path d="M4 9h14M14.5 5.2 18.3 9l-3.8 3.8"/><path d="M20 15H6M9.5 11.2 5.7 15l3.8 3.8"/>'),
  rent: svg('<path d="M6 3.5h8.5L18 7v13.5H6z"/><path d="M14 3.5V7.5h4M9 12h6M9 15.5h6"/>'),
  study: sh('ledger'),
  borrow: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>'),
  repay: svg('<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 20h14"/>'),
  route: sh('canal'),
  contract: sh('charter'),
  move: svg('<path d="M4 12h14M13.5 7.5 18 12l-4.5 4.5"/><circle cx="4.6" cy="12" r="1.2" fill="currentColor"/>'),
  contest: svg('<path d="M4.5 12h15M8 8.5 4.5 12 8 15.5M16 8.5l3.5 3.5-3.5 3.5"/>'),
  sell: svg('<path d="M4.5 8h15M6.5 8l1 12h9l1-12M9.5 8V5h5v3"/>'),
  upgrade: sh('level3'),
  restock: sh('provisioners'),
  auto: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4"/><path d="M19.5 4v4.2h-4.2"/>'),
  promo: sh('heralds'),
  clear: svg('<path d="M5 6.5h14M9 6.5V4.5h6v2M7 6.5l.8 13h8.4l.8-13M10.2 10v6.5M13.8 10v6.5"/>'),
  delta: sh('ledger'),
  orders: svg('<path d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="2.6" stroke-linecap="round"/>'),
  jump: svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 3.5v3.3M12 17.2v3.3M3.5 12h3.3M17.2 12h3.3"/>'),
  eye: svg('<path d="M2.8 12S6.2 6.2 12 6.2 21.2 12 21.2 12 17.8 17.8 12 17.8 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  citizen: svg('<circle cx="12" cy="7" r="3"/><path d="M6 20.5v-3.2a6 6 0 0 1 12 0v3.2z"/>'),
  lot: svg('<path d="m12 4.5 8 4-8 4-8-4z"/><path d="m4 12.5 8 4 8-4M4 16.5l8 4 8-4"/>'),
  street: svg('<path d="M3.5 18.5 9 5.5h6l5.5 13z"/><path d="M12 7.5v2M12 12v2M12 16.5v2"/>'),
  home: svg('<path d="M4 20.5V11l8-6.5 8 6.5v9.5z"/><path d="M10 20.5v-6h4v6"/>'),
  station: svg('<path d="M3.5 20.5h17M5.5 20.5V10.5l6.5-5 6.5 5v10"/><circle cx="12" cy="12" r="2.2"/>'),
  garden: svg('<circle cx="12" cy="9" r="5.2"/><path d="M12 14v6.5M9 20.5h6"/>'),
  water: svg('<path d="M3 9c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0M3 14.5c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0"/>'),
};

/** An icon by name from the HUD set, then the shared set; empty when unknown. */
export function ic(name: string): string {
  const own = OWN[name];
  if (own) return own;
  return sh(name);
}
