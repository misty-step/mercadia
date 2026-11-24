// Menu surfaces: Title, Hotseat setup, Room lobby, connecting/error notices, confirmation dialog
// and toasts. The overlays that belong to a running match (Council card, handoff, Final Edition)
// live in screens-overlays.ts. Every overlay that must suppress the HUD's global Enter/Space
// shortcut carries `data-modal` while open.
import { AI_ORDER, AI_PERSONAS, CIVICS, HOUSES, MODES, OBJECTIVE, SHOPS, UNITS, MAX_PLAYERS, isCivic, isShop } from '../shared/constants';
import { tileName, unitById, buildingById } from '../shared/game';
import { CITY } from '../shared/map';
import type { Game, MatchConfig, MatchMode, TileKind } from '../shared/types';
import type { LobbyView } from '../shared/protocol';
import type { Hit, Session, SessionView } from './contracts';
import { clear, cleanPlayerName, cleanRoomCode, crest, focusables, h, house, randomSeed, saveName, trapFocus } from './screens-ui';

// ───────────────────────────── Pure configuration builders ─────────────────────────────

/** Play Solo Now: Standard, one human against Vesper, Aurelia and Orson. */
export function buildSoloConfig(name: string, seed: number): MatchConfig {
  return {
    seed: seed >>> 0,
    mode: 'standard',
    players: [
      { name: cleanPlayerName(name, 'Merchant'), house: 0, kind: 'human', persona: null },
      ...AI_ORDER.map((persona, i) => ({ name: AI_PERSONAS[persona].name, house: i + 1, kind: 'ai' as const, persona })),
    ],
  };
}

export type HotseatKind = 'human' | 'ai' | 'off';
export interface HotseatSeat {
  name: string;
  house: number;
  kind: HotseatKind;
}

export const defaultHotseatSeats = (): HotseatSeat[] => [
  { name: '', house: 0, kind: 'human' },
  { name: '', house: 1, kind: 'human' },
  { name: '', house: 2, kind: 'off' },
  { name: '', house: 3, kind: 'off' },
];

/** The match configuration for a hotseat table, or an error string. Pure. */
export function buildHotseatConfig(seats: HotseatSeat[], mode: MatchMode, seed: number): MatchConfig | string {
  const active = seats.filter((s) => s.kind !== 'off');
  const humans = active.filter((s) => s.kind === 'human').length;
  if (humans < 2) return 'Hotseat needs at least two human seats';
  if (new Set(active.map((s) => s.house)).size !== active.length) return 'Each seat needs its own House';
  let k = 0;
  let n = 0;
  return {
    seed: seed >>> 0,
    mode,
    players: active.map((s) => {
      if (s.kind === 'ai') {
        const persona = AI_ORDER[k++ % AI_ORDER.length];
        return { name: AI_PERSONAS[persona].name, house: s.house, kind: 'ai' as const, persona };
      }
      n++;
      return { name: cleanPlayerName(s.name, `Player ${n}`), house: s.house, kind: 'human' as const, persona: null };
    }),
  };
}

/** Swap Houses so no two seats share one: `seat` takes `houseIndex`, the previous owner takes its old House. */
export function assignHouse(seats: HotseatSeat[], seat: number, houseIndex: number): HotseatSeat[] {
  const next = seats.map((s) => ({ ...s }));
  const prev = next[seat].house;
  const other = next.findIndex((s, i) => i !== seat && s.house === houseIndex);
  if (other >= 0) next[other].house = prev;
  next[seat].house = houseIndex;
  return next;
}

const TILE_LABEL: Record<TileKind, string> = {
  avenue: 'Streetcar Avenue',
  avbridge: 'Avenue bridge',
  lane: 'Pedestrian lane',
  bridge: 'Stone footbridge',
  canal: 'Grand Canal',
  lot: 'Vacant lot',
  home: 'Townhouses',
  station: 'Grand Station',
  garden: 'Garden',
};

export interface PlateInfo {
  title: string;
  where: string;
  owner: number; // player index or -1
  lines: string[];
}

/** What the title's plate says about a tapped tile, building or unit. Pure. */
export function plateInfo(g: Game, hit: Hit): PlateInfo {
  const where = tileName(hit.tile);
  if (hit.unit) {
    const u = unitById(g, hit.unit);
    if (u) return { title: UNITS[u.kind].name, where, owner: u.owner, lines: [UNITS[u.kind].role] };
  }
  if (hit.building) {
    const b = buildingById(g, hit.building);
    if (b) {
      const name = isShop(b.kind) ? SHOPS[b.kind].name : isCivic(b.kind) ? CIVICS[b.kind].name : b.kind;
      const lines = [`Level ${b.level} · built Turn ${b.builtTurn}`];
      if (isShop(b.kind)) lines.push(`Last turn: ${b.lastServed} citizens served · §${b.lastSales.toLocaleString('en-US')}`);
      return { title: name, where, owner: b.owner, lines };
    }
  }
  return { title: TILE_LABEL[CITY.tiles[hit.tile]] ?? 'District', where, owner: -1, lines: [] };
}

// ───────────────────────────── Screens ─────────────────────────────

export interface TitleActions {
  solo(): void;
  hotseat(): void;
  createRoom(): Promise<void>;
  join(code: string): void;
}

export interface LobbyContext {
  /** The room seat this browser holds (from the `welcome` message), or -1. */
  mySeat: number;
  onLeave(): void;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
}

const PLATE_HINT = 'Tap or click any lot, building or unit to inspect it. Drag to pan; scroll or pinch to zoom.';

interface LobbyRefs {
  session: Session;
  ctx: LobbyContext;
  status: HTMLElement;
  code: HTMLElement;
  url: HTMLInputElement;
  copy: HTMLButtonElement;
  you: HTMLElement;
  name: HTMLInputElement;
  houses: HTMLButtonElement[];
  seats: { li: HTMLElement; slot: HTMLElement; who: HTMLElement; state: HTMLElement; btn: HTMLButtonElement; built: number }[];
  noAi: HTMLInputElement;
  modes: HTMLInputElement[];
  modeBlurb: HTMLElement;
  start: HTMLButtonElement;
  hint: HTMLElement;
}

export class Screens {
  private menu: HTMLElement;
  private panelHost: HTMLElement;
  private plate: HTMLElement;
  private modalHost: HTMLElement;
  private toastRoot: HTMLElement;
  private layoutCb: ((i: Insets) => void) | null = null;
  private ro: ResizeObserver | null = null;
  private lobby: LobbyRefs | null = null;
  private plateGame: Game | null = null;
  private dialogOpen = 0;

  constructor(readonly root: HTMLElement) {
    // Own stack, so the HUD keeps #toasts to itself.
    this.toastRoot = h('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    this.menu = h('div', { class: 'menu-layer', hidden: true, 'data-modal': '' });
    this.panelHost = h('div', { class: 'menu-panel-host' });
    this.plate = h('aside', { class: 'plate-note', 'aria-label': 'Plate caption' });
    this.menu.append(this.panelHost, this.plate);
    this.modalHost = h('div', { class: 'dialog-layer' });
    root.append(this.menu, this.modalHost, this.toastRoot);
    if (typeof ResizeObserver !== 'undefined') this.ro = new ResizeObserver(() => this.report());
    this.ro?.observe(this.panelHost);
    window.addEventListener('resize', () => this.report());
  }

  // ── Layout: the board keeps clear of the menu panel ──

  /** Called with the screen margins the menu panel occupies, so the board can fit beside it. */
  onLayout(cb: (i: Insets) => void): void {
    this.layoutCb = cb;
    this.report();
  }

  insets(): Insets {
    if (this.menu.hidden) return { top: 0, right: 0, bottom: 0, left: 0 };
    const panel = this.panelHost.firstElementChild as HTMLElement | null;
    if (!panel) return { top: 0, right: 0, bottom: 0, left: 0 };
    const r = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r.width > vw * 0.8) {
      // Portrait: the panel is a bottom sheet and the plate note sits above it.
      return { top: 56, right: 0, bottom: Math.max(0, vh - r.top + 6), left: 0 };
    }
    return { top: 0, right: 12, bottom: 0, left: Math.max(0, r.right + 16) };
  }

  private report(): void {
    this.layoutCb?.(this.insets());
  }

  private setPanel(panel: HTMLElement | null): void {
    clear(this.panelHost);
    this.lobby = null;
    if (!panel) {
      this.menu.hidden = true;
      this.report();
      return;
    }
    this.panelHost.append(panel);
    this.menu.hidden = false;
    if (typeof ResizeObserver !== 'undefined') this.ro?.observe(panel);
    this.report();
  }

  hideMenu(): void {
    this.setPanel(null);
  }

  get menuOpen(): boolean {
    return !this.menu.hidden;
  }

  // ── The plate caption and the tap-to-inspect card ──

  /** Show the plate caption, or what was tapped on the plate (game = the demo district). */
  inspect(game: Game, hit: Hit | null): void {
    this.plateGame = game;
    clear(this.plate);
    if (!hit || hit.tile < 0) {
      this.plate.classList.remove('has-hit');
      this.plate.append(
        h('p', { class: 'plate-kicker mono', text: 'Plate I' }),
        h('p', { class: 'plate-title serif', text: 'The Canal District of Mercadia' }),
        h('p', { class: 'plate-hint', text: PLATE_HINT }),
      );
      return;
    }
    const info = plateInfo(game, hit);
    this.plate.classList.add('has-hit');
    const head = h('div', { class: 'plate-head' });
    if (info.owner >= 0) head.append(crest(game.players[info.owner].house, 'crest-sm'));
    head.append(h('p', { class: 'plate-title serif', text: info.title }), h('p', { class: 'plate-where mono', text: info.where }));
    this.plate.append(head);
    if (info.owner >= 0) {
      const p = game.players[info.owner];
      this.plate.append(h('p', { class: 'plate-line', text: `${house(p.house).name} · ${p.name}` }));
    }
    for (const l of info.lines) this.plate.append(h('p', { class: 'plate-line', text: l }));
    this.plate.append(h('p', { class: 'plate-hint', text: 'An AI-only demonstration district. Nothing here is your match.' }));
  }

  // ── Title ──

  showTitle(a: TitleActions, game: Game): void {
    const solo = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => a.solo() }, 'Play Solo Now');
    const hot = h('button', { class: 'btn', type: 'button', onclick: () => a.hotseat() }, 'Hotseat');
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const create = h('button', { class: 'btn', type: 'button' }, 'Create Room');
    create.addEventListener('click', () => {
      create.disabled = true;
      err.hidden = true;
      a.createRoom().then(
        () => undefined,
        () => {
          create.disabled = false;
          err.textContent = 'Could not open a room. Check your connection and try again.';
          err.hidden = false;
        },
      );
    });
    const code = h('input', {
      class: 'input mono code-input',
      id: 'join-code',
      type: 'text',
      maxlength: 4,
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      placeholder: 'ABCD',
      'aria-label': 'Room code, four letters',
    });
    const join = h('button', { class: 'btn', type: 'submit', disabled: true }, 'Join');
    code.addEventListener('input', () => {
      code.value = cleanRoomCode(code.value);
      join.disabled = code.value.length !== 4;
    });
    const form = h('form', { class: 'join-row', onsubmit: (e: Event) => { e.preventDefault(); if (code.value.length === 4) a.join(code.value); } },
      h('label', { class: 'field-label', for: 'join-code', text: 'Join a room' }),
      h('div', { class: 'join-fields' }, code, join),
    );
    const how = h('ol', { class: 'how' },
      h('li', {}, h('span', { class: 'mono how-n', text: '1' }), h('span', { text: 'Plan on a frozen board. Queue orders to build, move, trade and study, and take as long as you like.' })),
      h('li', {}, h('span', { class: 'mono how-n', text: '2' }), h('span', { text: 'End Turn. The city resolves once and prints an exact ledger of what changed.' })),
      h('li', {}, h('span', { class: 'mono how-n', text: '3' }), h('span', { text: 'Across four Eras, rise on net worth, market share and civic prestige.' })),
    );
    const panel = h('section', { class: 'menu-panel title-panel', 'aria-labelledby': 'title-h' },
      h('p', { class: 'eyebrow', text: 'A turn-based dynasty civ for one to four Houses' }),
      h('h1', { class: 'wordmark serif', id: 'title-h', text: 'Mercadia' }),
      h('p', { class: 'objective', text: OBJECTIVE }),
      h('div', { class: 'title-actions' }, solo, h('div', { class: 'btn-row' }, hot, create), err),
      form,
      h('div', { class: 'how-block' }, h('h2', { class: 'field-label', text: 'How it plays' }), how),
    );
    this.setPanel(panel);
    this.inspect(game, null);
  }

  // ── Hotseat setup ──

  showHotseat(a: { start(config: MatchConfig): void; back(): void }, game: Game): void {
    let seats = defaultHotseatSeats();
    let mode: MatchMode = 'standard';
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const rows = seats.map((_, i) => {
      const slot = h('span', { class: 'crest-wrap' });
      const name = h('input', { class: 'input', type: 'text', maxlength: 16, autocomplete: 'off', placeholder: `Player ${i + 1}`, 'aria-label': `Seat ${i + 1} name` });
      const aiLabel = h('span', { class: 'seat-ai', hidden: true });
      const sel = h('select', { class: 'input', 'aria-label': `Seat ${i + 1} House` }, ...HOUSES.map((x, j) => h('option', { value: String(j), text: x.name })));
      const kind = h('select', { class: 'input', 'aria-label': `Seat ${i + 1} player` },
        h('option', { value: 'human', text: 'Human' }),
        h('option', { value: 'ai', text: 'AI' }),
        h('option', { value: 'off', text: 'Empty' }),
      );
      const fixed = h('span', { class: 'seat-fixed', text: 'Human' });
      const li = h('li', { class: 'hseat' },
        h('span', { class: 'seat-n mono', text: String(i + 1) }),
        slot,
        h('div', { class: 'hseat-fields' }, name, aiLabel),
        h('div', { class: 'hseat-sel' }, sel, i < 2 ? fixed : kind),
      );
      name.addEventListener('input', () => { seats[i].name = name.value; });
      sel.addEventListener('change', () => { seats = assignHouse(seats, i, Number(sel.value)); sync(); });
      kind.addEventListener('change', () => { seats[i].kind = kind.value as HotseatKind; sync(); });
      return { li, slot, name, aiLabel, sel, kind };
    });
    let shownHouse: number[] = [];
    const sync = (): void => {
      let ai = 0;
      seats.forEach((s, i) => {
        const r = rows[i];
        const off = s.kind === 'off';
        r.li.classList.toggle('is-off', off);
        r.sel.value = String(s.house);
        r.sel.disabled = off;
        if (i >= 2) r.kind.value = s.kind;
        r.name.hidden = s.kind !== 'human';
        r.aiLabel.hidden = s.kind !== 'ai';
        if (s.kind === 'ai') {
          const p = AI_PERSONAS[AI_ORDER[ai++ % AI_ORDER.length]];
          r.aiLabel.textContent = `${p.name} · ${p.title}`;
        } else if (off) {
          r.aiLabel.hidden = false;
          r.aiLabel.textContent = 'Seat not in play';
        }
        if (shownHouse[i] !== s.house) {
          clear(r.slot);
          r.slot.append(crest(s.house, 'crest-md'));
          shownHouse[i] = s.house;
        }
      });
      err.hidden = true;
    };
    sync();
    const modes = (Object.keys(MODES) as MatchMode[]).map((m) => {
      const input = h('input', { type: 'radio', name: 'hs-mode', value: m, ...(m === mode ? { checked: true } : {}) });
      input.addEventListener('change', () => { if (input.checked) mode = m; });
      return h('label', { class: 'mode-opt' }, input, h('span', { class: 'mode-name', text: MODES[m].name }), h('span', { class: 'mode-blurb', text: MODES[m].blurb }));
    });
    const start = h('button', { class: 'btn btn-primary', type: 'button' }, 'Start hotseat match');
    start.addEventListener('click', () => {
      const cfg = buildHotseatConfig(seats, mode, randomSeed());
      if (typeof cfg === 'string') {
        err.textContent = cfg;
        err.hidden = false;
        return;
      }
      a.start(cfg);
    });
    const panel = h('section', { class: 'menu-panel setup-panel', 'aria-labelledby': 'hs-h' },
      h('p', { class: 'eyebrow', text: 'Shared device' }),
      h('h1', { class: 'panel-title serif', id: 'hs-h', text: 'Hotseat' }),
      h('p', { class: 'panel-lede', text: 'Two to four humans take turns on this device, each behind a handoff screen that hides the previous plan. Add AI Houses to fill the table.' }),
      h('ol', { class: 'hseat-list' }, ...rows.map((r) => r.li)),
      h('fieldset', { class: 'mode-set' }, h('legend', { class: 'field-label', text: 'Match length' }), ...modes),
      err,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: () => a.back() }, 'Back'), start),
    );
    this.setPanel(panel);
    this.inspect(game, null);
    rows[0].name.focus({ preventScroll: true });
  }

  // ── Connecting / terminal room errors ──

  showNotice(o: { title: string; body: string; status?: string; tone?: 'error' | 'wait'; action?: { label: string; run(): void } }, game: Game): void {
    const panel = h('section', { class: 'menu-panel notice-panel', 'aria-labelledby': 'nt-h' },
      h('p', { class: 'eyebrow', text: 'Mercadia' }),
      h('h1', { class: 'panel-title serif', id: 'nt-h', text: o.title }),
      h('p', { class: `notice-body${o.tone === 'error' ? ' is-error' : ''}`, role: o.tone === 'error' ? 'alert' : 'status', text: o.body }),
      o.action ? h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => o.action?.run() }, o.action.label)) : null,
    );
    this.setPanel(panel);
    this.inspect(game, null);
    (panel.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  // ── Room lobby ──

  showLobby(session: Session, ctx: LobbyContext, game: Game): void {
    const view = session.view;
    const status = h('p', { class: 'status-line', role: 'status' });
    const code = h('span', { class: 'room-code mono' });
    const url = h('input', { class: 'input mono url-input', type: 'text', readonly: true, 'aria-label': 'Room link' });
    const copy = h('button', { class: 'btn btn-small', type: 'button' }, 'Copy link');
    copy.addEventListener('click', () => {
      const text = url.value;
      const done = (): void => {
        copy.textContent = 'Link copied';
        window.setTimeout(() => { copy.textContent = 'Copy link'; }, 1800);
      };
      const fallback = (): void => {
        url.focus();
        url.select();
        try {
          if (document.execCommand('copy')) done();
        } catch {
          // the selected link can still be copied by hand
        }
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    });
    const name = h('input', { class: 'input', id: 'lobby-name', type: 'text', maxlength: 16, autocomplete: 'off', 'aria-label': 'Your name' });
    const commitName = (): void => {
      const n = cleanPlayerName(name.value, '');
      if (!n) return;
      saveName(n);
      session.lobby.setName(n);
    };
    name.addEventListener('change', commitName);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); }); // blur fires `change` once
    const houses = HOUSES.map((x, i) => {
      const b = h('button', { class: 'house-pick', type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': x.name }, crest(i, 'crest-md'), h('span', { class: 'house-pick-name', text: x.short }));
      b.addEventListener('click', () => session.lobby.setHouse(i));
      return b;
    });
    const you = h('div', { class: 'lobby-you' },
      h('label', { class: 'field-label', for: 'lobby-name', text: 'Your name' }), name,
      h('div', { class: 'field-label', id: 'lobby-house-l', text: 'Your House' }),
      h('div', { class: 'house-row', role: 'radiogroup', 'aria-labelledby': 'lobby-house-l' }, ...houses),
    );
    const seats = Array.from({ length: MAX_PLAYERS }, (_, i) => {
      const slot = h('span', { class: 'crest-wrap' });
      const who = h('span', { class: 'seat-who' });
      const state = h('span', { class: 'seat-state' });
      const btn = h('button', { class: 'btn btn-small', type: 'button', hidden: true });
      btn.addEventListener('click', () => session.lobby.setSeatAi(i, btn.dataset.ai === '1'));
      const li = h('li', { class: 'lseat' }, slot, h('span', { class: 'seat-text' }, who, state), btn);
      return { li, slot, who, state, btn, built: -1 };
    });
    const noAi = h('input', { type: 'checkbox', id: 'lobby-noai' });
    noAi.addEventListener('change', () => session.lobby.setAiFill(!noAi.checked));
    const modeRadios = (Object.keys(MODES) as MatchMode[]).map((m) => {
      const input = h('input', { type: 'radio', name: 'lobby-mode', value: m });
      input.addEventListener('change', () => { if (input.checked) session.lobby.setMode(m); });
      return input;
    });
    const modeBlurb = h('p', { class: 'mode-note' });
    const start = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => session.lobby.start() }, 'Start match');
    const hint = h('p', { class: 'lobby-hint', role: 'status' });
    const panel = h('section', { class: 'menu-panel lobby-panel', 'aria-labelledby': 'lobby-h' },
      h('p', { class: 'eyebrow', text: 'Room' }),
      h('h1', { class: 'panel-title serif', id: 'lobby-h' }, h('span', { class: 'sr-only', text: 'Room code ' }), code),
      status,
      h('div', { class: 'share-row' }, url, copy),
      you,
      h('h2', { class: 'field-label', text: 'Seats' }),
      h('ul', { class: 'lseat-list' }, ...seats.map((s) => s.li)),
      h('div', { class: 'lobby-host' },
        h('label', { class: 'check', for: 'lobby-noai' }, noAi, h('span', { text: 'No AI (Pure PvP)' })),
        h('fieldset', { class: 'mode-set' }, h('legend', { class: 'field-label', text: 'Match length' }),
          ...modeRadios.map((r) => h('label', { class: 'mode-opt' }, r, h('span', { class: 'mode-name', text: MODES[r.value as MatchMode].name }), h('span', { class: 'mode-blurb', text: MODES[r.value as MatchMode].blurb }))),
        ),
        modeBlurb,
      ),
      h('div', { class: 'lobby-foot' },
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: () => ctx.onLeave() }, 'Leave room'), start),
        hint,
      ),
    );
    this.setPanel(panel);
    this.inspect(game, null);
    this.lobby = { session, ctx, status, code, url, copy, you, name, houses, seats, noAi, modes: modeRadios, modeBlurb, start, hint };
    this.updateLobby(view);
  }

  /** Patch the lobby in place (inputs the player is typing in keep focus). */
  updateLobby(view: SessionView): void {
    const L = this.lobby;
    const lobby: LobbyView | null = view.lobby;
    if (!L || !lobby) return;
    const mine = L.ctx.mySeat;
    const isHost = view.host;
    L.status.textContent = view.status.text;
    L.status.dataset.tone = view.status.tone;
    L.status.setAttribute('role', view.status.tone === 'error' ? 'alert' : 'status');
    L.code.textContent = lobby.code || view.roomCode;
    const shareUrl = `${location.origin}/?room=${lobby.code || view.roomCode}`;
    if (L.url.value !== shareUrl) L.url.value = shareUrl;

    const me = mine >= 0 ? lobby.seats[mine] : undefined;
    L.you.hidden = !me;
    if (me) {
      if (document.activeElement !== L.name && L.name.value !== me.name) L.name.value = me.name;
      L.houses.forEach((b, i) => {
        const taken = lobby.seats.some((s, j) => j !== mine && s.kind === 'human' && s.house === i);
        b.setAttribute('aria-checked', String(me.house === i));
        b.classList.toggle('is-on', me.house === i);
        b.disabled = taken;
        b.title = taken ? 'Taken by another player' : '';
      });
    }

    lobby.seats.forEach((s, i) => {
      const r = L.seats[i];
      if (!r) return;
      if (r.built !== s.house) {
        clear(r.slot);
        r.slot.append(crest(s.house, 'crest-md'));
        r.built = s.house;
      }
      const hs = house(s.house);
      const isMe = i === mine;
      r.li.classList.toggle('is-open', s.kind === 'open');
      r.li.dataset.house = String(s.house);
      const parts: string[] = [];
      if (s.kind === 'open') parts.push('Open seat');
      else parts.push(s.name || hs.name);
      r.who.textContent = parts.join('');
      let state = '';
      if (s.kind === 'open') state = `${hs.name} · waiting for a player`;
      else if (s.kind === 'ai') state = `AI · ${s.persona ? AI_PERSONAS[s.persona].title : 'House'}`;
      else state = s.connected ? 'Connected' : 'Offline';
      if (isMe) state = `You · ${state}`;
      if (lobby.host === i && s.kind === 'human') state += ' · Host';
      r.state.textContent = state;
      const canToggle = isHost && s.kind !== 'human';
      r.btn.hidden = !canToggle;
      if (canToggle) {
        const toAi = s.kind === 'open';
        r.btn.dataset.ai = toAi ? '1' : '0';
        r.btn.textContent = toAi ? 'Add AI' : 'Remove AI';
        r.btn.setAttribute('aria-label', `${toAi ? 'Add an AI House to' : 'Remove the AI House from'} seat ${i + 1}`);
      }
    });

    L.noAi.checked = lobby.seats.every((s) => s.kind !== 'ai');
    L.noAi.disabled = !isHost;
    L.modes.forEach((r) => {
      r.checked = r.value === lobby.mode;
      r.disabled = !isHost;
    });
    L.modeBlurb.textContent = isHost ? '' : `The host chose ${MODES[lobby.mode].name}.`;
    L.modeBlurb.hidden = isHost;

    const filled = lobby.seats.filter((s) => s.kind !== 'open').length;
    L.start.hidden = !isHost;
    L.start.disabled = filled < 2;
    L.hint.textContent = isHost ? (filled < 2 ? 'Add an AI rival or invite a player to begin.' : 'Share the link, then start when everyone has joined.') : 'Waiting for the host to start the match.';
    if (mine < 0) L.hint.textContent = 'This room is full. You are watching; the match will appear when it starts.';
  }

  // ── Confirmation dialog ──

  confirm(o: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const prev = document.activeElement as HTMLElement | null;
      const titleId = `dlg-t-${++this.dialogOpen}`;
      const bodyId = `dlg-b-${this.dialogOpen}`;
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        untrap();
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
        resolve(v);
      };
      const cancel = h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, o.cancelLabel);
      const ok = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => finish(true) }, o.confirmLabel);
      const card = h('div', { class: 'dialog-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': bodyId },
        h('h2', { class: 'dialog-title serif', id: titleId, text: o.title }),
        h('p', { class: 'dialog-body', id: bodyId, text: o.body }),
        h('div', { class: 'btn-row' }, cancel, ok),
      );
      const overlay = h('div', { class: 'dialog-scrim', 'data-modal': '' }, card);
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      };
      document.addEventListener('keydown', onKey, true);
      this.modalHost.append(overlay);
      const untrap = trapFocus(overlay);
      cancel.focus({ preventScroll: true });
    });
  }

  // ── Toasts ──

  toast(text: string, tone: 'info' | 'error' = 'info'): void {
    const t = h('p', { class: `toast${tone === 'error' ? ' is-error' : ''}`, text });
    this.toastRoot.append(t);
    while (this.toastRoot.children.length > 3) this.toastRoot.firstElementChild?.remove();
    window.setTimeout(() => t.remove(), 4200);
  }

  /** The element holding the first focusable control of the open menu (for tests and focus return). */
  focusFirst(): void {
    focusables(this.menu)[0]?.focus({ preventScroll: true });
  }

  get currentPlateGame(): Game | null {
    return this.plateGame;
  }
}
