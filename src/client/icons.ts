// Bespoke inline SVG icons. 24×24, 1.6 stroke, drawn for this game — no emoji, no icon font.

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
