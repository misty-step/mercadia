// Bespoke inline SVG icons. 24×24, 1.6 stroke, drawn for this game — no emoji, no icon font.
import { HOUSES } from '../shared/constants';
import { CREST_SHAPES, SHIELD, SHIELD_SHADE } from './heraldry';

const svg = (body: string, cls = 'ic'): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS: Record<string, string> = {
  // ── Shops ──
  roastery: svg('<path d="M5 10h11v4a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5c1 1 -1 2 0 3.2M11.5 3.5c1 1-1 2 0 3.2"/><path d="M4 21h13"/>'),
  bistro: svg('<circle cx="12.5" cy="13" r="6.5"/><circle cx="12.5" cy="13" r="3"/><path d="M3.5 4v5.5a1.8 1.8 0 0 0 3.6 0V4M5.3 4v16.5"/><path d="M20.5 4v16.5M20.5 4c-1.6 1.2-2.2 3.4-2 6h2"/>'),
  arcade: svg('<path d="M4 15.5h16l-1.5 5h-13z"/><path d="M12 15.5V8"/><circle cx="12" cy="5.8" r="2.3"/><path d="M16.2 12.5h2.3"/><circle cx="7" cy="12.6" r=".6" fill="currentColor"/>'),
  boutique: svg('<path d="M12 7.5V6.2a2 2 0 1 0-2-2"/><path d="M12 7.5 3.5 13a1.2 1.2 0 0 0 .7 2.2h15.6a1.2 1.2 0 0 0 .7-2.2z"/><path d="M8 15.2 6.5 21h11L16 15.2"/>'),
  cinema: svg('<path d="M4 10h16v10H4z"/><path d="M4 10 3.2 6.6l15.6-3.4.8 3.4z"/><path d="m7 5.9 1.6 3.6M11.3 5l1.6 3.6M15.6 4 17.2 7.6"/><path d="m10.5 13 4 2.2-4 2.2z"/>'),
  nightmarket: svg('<path d="M12 2.5v2.2"/><path d="M8.5 4.7h7"/><path d="M8.2 7.2h7.6c1.8 2.6 1.8 7.4 0 10H8.2c-1.8-2.6-1.8-7.4 0-10z"/><path d="M12 7.2v10M9 17.2h6v2H9z"/><path d="M12 19.2v2.3"/>'),
  // ── Civic ──
  park: svg('<circle cx="12" cy="8.5" r="5.5"/><path d="M12 9.5V21"/><path d="m12 14 3-2.6M12 16.5l-3-2.6"/><path d="M6 21h12"/>'),
  tramstop: svg('<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M6 12.5h12M9.5 6V3.5h5V6M12 3.5V2"/><path d="m8.5 18-1.7 3M15.5 18l1.7 3"/><circle cx="9.2" cy="15.3" r=".7" fill="currentColor"/><circle cx="14.8" cy="15.3" r=".7" fill="currentColor"/>'),
  plaza: svg('<path d="M5 19.5h14"/><path d="M7 19.5v-2.2h10v2.2"/><path d="M12 17.3V9.5"/><path d="M12 9.5c-2.4-3-5.2-2-5.6 1.6M12 9.5c2.4-3 5.2-2 5.6 1.6"/><path d="M12 9.5c-1-3.2-.4-5 0-6 .4 1 1 2.8 0 6z"/>'),
  // ── Interface ──
  sound: svg('<path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4z"/><path d="M15 9.3a4 4 0 0 1 0 5.4M17.6 6.8a7.5 7.5 0 0 1 0 10.4"/>'),
  mute: svg('<path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4z"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/>'),
  pause: svg('<path d="M8.5 5.5v13M15.5 5.5v13"/>'),
  leave: svg('<path d="M13.5 4H6v16h7.5"/><path d="M10.5 12H20M16.5 8.5 20 12l-3.5 3.5"/>'),
  ledger: svg('<path d="M6 3.5h10.5a1.5 1.5 0 0 1 1.5 1.5v15.5H7.5A1.5 1.5 0 0 1 6 19z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>'),
  close: svg('<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="1.8"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  crown: svg('<path d="m4 8 4 4 4-6.5 4 6.5 4-4-1.6 10.5H5.6z"/>'),
  star: svg('<path d="m12 4 2.4 5.2 5.6.6-4.2 3.8 1.2 5.6-5-2.9-5 2.9 1.2-5.6L4 9.8l5.6-.6z"/>'),
  corner: svg('<path d="M5 19.5V5h14.5"/><path d="M9.5 19.5V9.5h10"/>'),
  shark: svg('<path d="M3 16.5c4-1 6.5-4.5 8-11 2.2 3.2 3 6.5 2.8 9.6 2.4.2 4.8-.6 7.2-2.6-.6 4-4 6.5-9 6.5H3z"/>'),
  patron: svg('<path d="M4 20h16M5.5 20V10.5M9.8 20V10.5M14.2 20V10.5M18.5 20V10.5"/><path d="M3.5 10.5 12 4l8.5 6.5z"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  chevron: svg('<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>'),
  // ── City events (the Chronicle's badges) ──
  cloudburst: svg('<path d="M7 15.5a4 4 0 0 1 .6-7.9 5.2 5.2 0 0 1 10 1.3 3.4 3.4 0 0 1-.6 6.6z"/><path d="m9 18.3-1 2.4M13 18.3l-1 2.4M17 18.3l-1 2.4"/>'),
  cruise: svg('<path d="M3.5 15.5h17l-2 4.5h-13z"/><path d="M6.5 15.5v-4h11v4"/><path d="M9.5 11.5V8h5v3.5"/><path d="M12 8V4.8"/>'),
  freeride: svg('<path d="M4 8h16v2.6a1.9 1.9 0 0 0 0 3.8V17H4v-2.6a1.9 1.9 0 0 0 0-3.8z"/><path d="M10 8.6v8" stroke-dasharray="1.6 1.9"/><path d="M13.2 12.5h3.6"/>'),
  critic: svg('<path d="M7.5 3.5v5a2.5 2.5 0 0 0 5 0v-5M10 3.5V21"/><path d="M17 3.5c-1.8 1.6-2.3 4.4-2 8h2zM17 11.5V21"/>'),
  lantern: svg('<path d="M12 2.5V5"/><path d="M8.5 5h7"/><path d="M8 7.5h8c1.6 2.4 1.6 6.6 0 9H8c-1.6-2.4-1.6-6.6 0-9z"/><path d="M10 16.5h4v2h-4zM12 18.5v3"/>'),
  renthike: svg('<path d="M3.5 20.5V10l5.5-4 5.5 4v10.5"/><path d="M7.5 20.5v-5h3v5"/><path d="M19 14V5M16.5 7.5 19 5l2.5 2.5"/>'),
  supplycrunch: svg('<path d="M4 8.5 12 5l8 3.5V17l-8 3.5L4 17z"/><path d="m4 8.5 8 3.5 8-3.5M12 12v8.5"/>'),
  // ── Chronicle categories ──
  era: svg('<path d="M4 20.5h16"/><path d="M6.5 20.5v-7a5.5 5.5 0 0 1 11 0v7"/><path d="M12 4.6V3M6.2 6.6 5.1 5.5M17.8 6.6l1.1-1.1"/><circle cx="12" cy="13.6" r="1.7"/>'),
  charter: svg('<path d="M7 4.5h10.5A1.5 1.5 0 0 1 19 6v7.5"/><path d="M7 4.5A1.5 1.5 0 0 0 5.5 6v12.5H12"/><path d="M8.5 9h7M8.5 12.5h4.5"/><circle cx="17" cy="17.5" r="3"/>'),
  seal: svg('<circle cx="12" cy="9.5" r="5.5"/><path d="m9.6 9.6 1.7 1.7 3.2-3.3"/><path d="M8.6 14 7 20.5l5-2.4 5 2.4-1.6-6.5"/>'),
  focus: svg('<circle cx="12" cy="12" r="5"/><path d="M12 3.5v3.5M12 17v3.5M3.5 12H7M17 12h3.5"/>'),
  lock: svg('<rect x="6" y="11" width="12" height="9" rx="1.8"/><path d="M8.5 11V8.3a3.5 3.5 0 0 1 7 0V11"/>'),
  level3: svg('<path d="M4 20.5h16"/><path d="M6 20.5V9h12v11.5"/><path d="M4.5 9h15M8 9V5.5h8V9"/><path d="M9.5 13h5M9.5 16.5h5"/>'),
  // ── Dynasty Charters ──
  artisanry: svg('<path d="M4.5 19.5 12.5 11.5"/><path d="m11.5 6.5 6 6 2-2L17 8l1-1-2.5-2.5-1 1-1-1z"/>'),
  transit: svg('<rect x="6" y="5.5" width="12" height="11.5" rx="2.5"/><path d="M6 11.5h12M12 5.5V3"/><path d="m8.5 17-1.7 3.5M15.5 17l1.7 3.5"/><circle cx="9.2" cy="14.3" r=".7" fill="currentColor"/><circle cx="14.8" cy="14.3" r=".7" fill="currentColor"/>'),
  credit: svg('<ellipse cx="12" cy="7" rx="6.5" ry="2.8"/><path d="M5.5 7v5c0 1.5 2.9 2.8 6.5 2.8s6.5-1.3 6.5-2.8V7"/><path d="M5.5 12v5c0 1.5 2.9 2.8 6.5 2.8s6.5-1.3 6.5-2.8v-5"/>'),
  canal: svg('<path d="M3 13.5c2.5-6.2 15.5-6.2 18 0"/><path d="M6.3 13.5v-2.9M10 13.5V9.4M14 13.5V9.4M17.7 13.5v-2.9"/><path d="M3 18.3c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0"/>'),
  heralds: svg('<path d="M4 10.5v3.2l8.5 3.3V7z"/><path d="M12.5 8.5c3 0 5.2-1.4 6.7-3.5v14c-1.5-2.1-3.7-3.5-6.7-3.5"/><path d="M6.6 14.7 8 20h2.4l-1-4.4"/>'),
  provisioners: svg('<path d="M3 14.5h18l-2.5 5h-13z"/><path d="M7 14.5v-5h4.5v5M12.5 14.5V7H17v7.5"/>'),
};

export const icon = (name: string): string => ICONS[name] ?? '';

/** The winner's trophy: brass cup on a travertine plinth, ribbon in the House colour. */
export function trophy(color: string): string {
  return `<svg class="trophy" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M20 10h24v14a12 12 0 0 1-24 0z" fill="#D4A34A"/>
    <path d="M32 10h12v14a12 12 0 0 1-12 12z" fill="#B98A34"/>
    <path d="M20 13h-7c0 8 3 12 9 13M44 13h7c0 8-3 12-9 13" fill="none" stroke="#B98A34" stroke-width="3"/>
    <path d="M24 13h5v9a7 7 0 0 1-5-7z" fill="#F0CE86"/>
    <path d="M29 36h6v8h-6z" fill="#B98A34"/>
    <path d="M22 44h20v5H22z" fill="#D4A34A"/>
    <path d="M17 49h30v8H17z" fill="#E4DBC8"/>
    <path d="M32 49h15v8H32z" fill="#CFC4AE"/>
    <path d="M26 51h12v4H26z" fill="${color}"/>
  </svg>`;
}

/** Small sun dial for the clock chip: the sun rides an arc through the day. */
export function dial(phase: number): string {
  const a = Math.PI * (1 - phase);
  const x = 15 + Math.cos(a) * 11;
  const y = 17 - Math.sin(a) * 11;
  const night = phase > 0.8;
  return `<svg class="dial" viewBox="0 0 30 20" aria-hidden="true">
    <path d="M4 17a11 11 0 0 1 22 0" fill="none" stroke="rgba(30,26,22,0.2)" stroke-width="1.4" stroke-dasharray="1.5 2.4"/>
    <path d="M2 17.6h26" stroke="rgba(30,26,22,0.4)" stroke-width="1.2" stroke-linecap="round"/>
    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="${night ? '#5A66A8' : phase > 0.55 ? '#D48C1C' : '#D4A34A'}"/>
    ${night ? `<circle cx="${(x + 1.5).toFixed(1)}" cy="${(y - 1.2).toFixed(1)}" r="2.6" fill="#FAF7F0"/>` : ''}
  </svg>`;
}

/**
 * The winning House's crest for the Final Edition: its own heraldic shield and emblem, gilded,
 * under a brass crown and between two laurel sprays.
 */
export function grandCrest(house: number): string {
  const h = HOUSES[((house % HOUSES.length) + HOUSES.length) % HOUSES.length];
  const leaf = (x: number, y: number, r: number, flip: boolean): string =>
    `<ellipse cx="${x}" cy="${y}" rx="5.2" ry="2.3" transform="rotate(${flip ? -r : r} ${x} ${y})" fill="#84A98C"/>`;
  const laurel = [0, 1, 2, 3, 4]
    .map((i) => {
      const y = 72 - i * 9.5;
      const dx = 9 + i * 1.2 - i * i * 0.5;
      return leaf(48 - 30 - dx + 6, y, 52 - i * 9, false) + leaf(48 + 30 + dx - 6, y, 52 - i * 9, true);
    })
    .join('');
  const emblem = CREST_SHAPES[h.crest]
    .map((s) =>
      s.stroke
        ? `<path d="${s.d}" fill="none" stroke="#FAF7F0" stroke-width="${s.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="${s.d}" fill="#FAF7F0" fill-rule="evenodd"/>`,
    )
    .join('');
  return `<svg class="crest grand" viewBox="0 0 96 96" role="img" data-crest="${h.crest}" aria-label="${h.name} crest: ${h.crestName}"><title>${h.name} — ${h.crestName}</title>
    ${laurel}
    <path d="M30 13l7 8 11-12 11 12 7-8-3 13H33z" fill="#D4A34A"/>
    <path d="M48 9l11 12 7-8-3 13H48z" fill="#B98A34"/>
    <path d="M33 26h30v3.2H33z" fill="#7A5A16"/>
    <g transform="translate(20.4 28) scale(2.3)">
      <path d="${SHIELD}" fill="${h.color}"/><path d="${SHIELD_SHADE}" fill="${h.dark}"/>${emblem}
      <path d="${SHIELD}" fill="none" stroke="#D4A34A" stroke-width="1.1" stroke-linejoin="round"/>
    </g>
  </svg>`;
}
