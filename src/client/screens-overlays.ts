// Overlays that belong to a running match: the Council turn card, the hotseat handoff screen and
// the Final Edition of The Mercadia Gazette. Each carries `data-modal` while open so the HUD's
// global Enter/Space shortcut stays quiet. All user text (player names) goes through textContent.
import { CHARTERS, ERAS, LEVEL3_ERA, MODES, UNITS, UNIT_KINDS, buildName, unlocksOf } from '../shared/constants';
import type { CharterKey, Game, Honour, MatchMode, Standing, TrendPoint } from '../shared/types';
import { eraTurns, finalTurn } from '../shared/game';
import type { SessionView } from './contracts';
import { grandCrest, icon } from './icons';
import { clear, crest, fmtMoney, h, house, trapFocus } from './screens-ui';

// ───────────────────────────── Council turn card ─────────────────────────────

export interface CouncilHandlers {
  choose(key: CharterKey): void;
}

/** The Council card applies when the viewing seat is planning a Council turn and has no Charter queued. */
export function councilPending(v: SessionView): boolean {
  const g = v.game;
  return !!g.council && g.phase === 'planning' && v.seat >= 0 && v.seat < g.players.length && !v.handoff && !v.ended && !v.draft.some((o) => o.t === 'charter');
}

export class CouncilCard {
  private root: HTMLElement | null = null;
  private key = '';
  private untrap: (() => void) | null = null;
  private returnTo: HTMLElement | null = null;
  private peekBtn: HTMLButtonElement | null = null;
  private card: HTMLElement | null = null;
  private peeking = false;

  constructor(private host: HTMLElement, private on: CouncilHandlers) {}

  get open(): boolean {
    return this.root !== null;
  }

  sync(v: SessionView): void {
    if (!councilPending(v)) {
      this.close();
      return;
    }
    const key = `${v.game.seed}:${v.game.turn}:${v.seat}`;
    if (this.root && this.key === key) return;
    this.close();
    this.build(v, key);
  }

  close(): void {
    if (!this.root) return;
    this.untrap?.();
    this.root.remove();
    this.root = null;
    this.key = '';
    this.peeking = false;
    if (this.returnTo && document.contains(this.returnTo)) this.returnTo.focus({ preventScroll: true });
    this.returnTo = null;
  }

  private build(v: SessionView, key: string): void {
    const g = v.game;
    const council = g.council!;
    const era = ERAS[council.era - 1];
    const offers = council.offers[v.seat] ?? [];
    this.returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;

    const unlocks: Node[] = [];
    for (const k of unlocksOf(era.n)) {
      unlocks.push(h('li', { class: 'unlock' }, h('span', { class: 'unlock-ic', html: icon(k) }), h('span', { text: buildName(k) })));
    }
    for (const k of UNIT_KINDS) {
      if (UNITS[k].era === era.n && era.n > 1) unlocks.push(h('li', { class: 'unlock' }, h('span', { class: 'unlock-ic', html: icon('canal') }), h('span', { text: UNITS[k].name })));
    }
    if (era.n === LEVEL3_ERA) unlocks.push(h('li', { class: 'unlock' }, h('span', { class: 'unlock-ic', html: icon('level3') }), h('span', { text: 'Level 3 architecture' })));
    if (unlocks.length === 0) unlocks.push(h('li', { class: 'unlock', text: 'No new tools this Era' }));

    const standings = h('ol', { class: 'council-standings' },
      ...g.standings.map((s, rank) => {
        const p = g.players[s.player];
        return h('li', { class: `cs-row${s.player === v.seat ? ' is-me' : ''}`, 'data-house': String(p.house) },
          h('span', { class: 'cs-rank mono', text: String(rank + 1) }),
          crest(p.house, 'crest-sm'),
          h('span', { class: 'cs-name', text: s.player === v.seat && p.name !== 'You' ? `${p.name} (you)` : p.name }),
          h('span', { class: 'cs-crown mono', text: String(s.crown) }),
        );
      }),
    );

    const titleId = 'council-h';
    const charters = h('div', { class: 'charters', role: 'group', 'aria-label': 'Charter choices' },
      ...offers.map((k) => {
        const c = CHARTERS[k];
        const b = h('button', { class: 'charter', type: 'button', 'data-charter': k },
          h('span', { class: 'charter-name', text: c.name }),
          h('span', { class: 'charter-doctrine', text: c.doctrine }),
          h('span', { class: 'charter-blurb', text: c.blurb }),
          h('span', { class: 'charter-pill mono', text: c.pill }),
          h('span', { class: 'charter-act', text: 'Adopt this Charter' }),
        );
        b.addEventListener('click', () => this.on.choose(k));
        return b;
      }),
    );

    const peek = h('button', { class: 'btn btn-small', type: 'button' }, 'Look at the board');
    peek.addEventListener('click', () => this.setPeek(true));
    this.peekBtn = h('button', { class: 'btn btn-small peek-return', type: 'button', hidden: true }, 'Return to the Council');
    this.peekBtn.addEventListener('click', () => this.setPeek(false));

    const card = h('section', { class: 'council-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('p', { class: 'eyebrow mono', text: `Council turn · Turn ${g.turn}` }),
      h('h2', { class: 'council-title serif', id: titleId }, h('span', { class: 'era-numeral', text: `Era ${era.roman}` }), ` · ${era.name}`),
      h('p', { class: 'council-blurb', text: era.blurb }),
      h('div', { class: 'council-cols' },
        h('section', {}, h('h3', { class: 'field-label', text: 'New this Era' }), h('ul', { class: 'unlock-list' }, ...unlocks)),
        h('section', {}, h('h3', { class: 'field-label', text: 'Era standings · Crown Index' }), standings),
      ),
      h('h3', { class: 'field-label council-pick', text: 'Choose a Dynasty Charter' }),
      h('p', { class: 'council-note', text: 'Permanent for this House. It costs no Action and applies from this turn. The Council waits for you; there is no countdown.' }),
      charters,
      h('div', { class: 'council-foot' }, peek),
    );
    this.card = card;
    const root = h('div', { class: 'council-layer', 'data-modal': '' }, card, this.peekBtn);
    this.host.append(root);
    this.root = root;
    this.key = key;
    this.untrap = trapFocus(root);
    (card.querySelector('.charter') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private setPeek(on: boolean): void {
    if (!this.root || !this.card || !this.peekBtn) return;
    this.peeking = on;
    this.root.classList.toggle('is-peek', on);
    this.card.hidden = on;
    this.peekBtn.hidden = !on;
    (on ? this.peekBtn : (this.card.querySelector('.charter') as HTMLElement | null))?.focus({ preventScroll: true });
  }

  get isPeeking(): boolean {
    return this.peeking;
  }
}

// ───────────────────────────── Hotseat handoff ─────────────────────────────

export class Handoff {
  private root: HTMLElement | null = null;
  private key = '';
  private untrap: (() => void) | null = null;

  constructor(private host: HTMLElement, private begin: () => void) {}

  get open(): boolean {
    return this.root !== null;
  }

  sync(v: SessionView): void {
    if (!v.handoff || v.ended) {
      this.close();
      return;
    }
    const g = v.game;
    const key = `${g.seed}:${g.turn}:${v.handoff.player}:${v.resolutions}`;
    if (this.root && this.key === key) return;
    this.close();
    const p = g.players[v.handoff.player];
    const hs = house(p.house);
    const seatNo = v.seats.length > 0 ? v.handoff.player + 1 : 0;
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => this.begin() }, `Begin ${hs.short}'s turn`);
    const root = h('div', { class: 'handoff-layer', 'data-modal': '', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'handoff-h' },
      h('div', { class: 'handoff-inner' },
        h('p', { class: 'eyebrow mono', text: `Turn ${g.turn}${seatNo ? ` · Seat ${seatNo}` : ''}` }),
        crest(p.house, 'crest-xl', false),
        h('h2', { class: 'handoff-title serif', id: 'handoff-h', text: `Pass to ${hs.name}` }),
        h('p', { class: 'handoff-who', text: `${p.name}, take the device. The previous plan stays hidden until you begin.` }),
        btn,
      ),
    );
    this.host.append(root);
    this.root = root;
    this.key = key;
    this.untrap = trapFocus(root);
    btn.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.root) return;
    this.untrap?.();
    this.root.remove();
    this.root = null;
    this.key = '';
  }
}

// ───────────────────────────── Final Edition ─────────────────────────────

export interface FinalHandlers {
  rematch(): void;
  endless(): void;
  exportMatch(): void;
  leave(): void;
}

export interface CrownRow {
  player: number;
  name: string;
  house: number;
  worth: number;
  share: number;
  prestige: number;
  crown: number;
  netWorth: number;
  sharePct: number;
  prestigeRaw: number;
}

/** Exact Crown equation rows in rank order: Worth + Share + Prestige = Crown. Pure. */
export function crownRows(g: Game): CrownRow[] {
  return g.standings.map((s: Standing) => ({
    player: s.player,
    name: g.players[s.player].name,
    house: g.players[s.player].house,
    worth: s.worthComponent,
    share: s.shareComponent,
    prestige: s.prestigeComponent,
    crown: s.crown,
    netWorth: s.netWorth,
    sharePct: s.share,
    prestigeRaw: s.prestige,
  }));
}

/** Per player market share at the end of each Era, from the sampled trend. Null where no sample exists. Pure. */
export function eraShares(g: Game): (number | null)[][] {
  return g.players.map((_, i) =>
    ERAS.map((e) => {
      let last: TrendPoint | null = null;
      for (const t of g.trend) if (t.era === e.n) last = t;
      return last ? (last.share[i] ?? null) : null;
    }),
  );
}

export function finalHeadline(g: Game): { head: string; deck: string } {
  const win = g.players[g.winner] ?? g.players[g.standings[0]?.player ?? 0];
  const hs = house(win.house);
  const rows = crownRows(g);
  const top = rows[0];
  const second = rows[1];
  const subject = win.name === 'You' ? 'You' : win.name;
  const deck = !second
    ? `${subject} finish${subject === 'You' ? '' : 'es'} on a Crown Index of ${top.crown}.`
    : top.crown === second.crown
      ? `${subject} and ${g.players[second.player].name} finish level on ${top.crown}; the tiebreak of Net Worth, then Civic Prestige, decides it.`
      : `${subject} ${subject === 'You' ? 'win' : 'wins'} with a Crown Index of ${top.crown}, ${top.crown - second.crown} ahead of ${house(second.house).short}.`;
  return { head: `${hs.name} takes the Crown of Mercadia`, deck };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Nudge label y positions apart so direct labels never overlap. Pure. */
export function spreadLabels(ys: number[], min: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 0; k < order.length; k++) {
    order[k].y = Math.max(order[k].y, k === 0 ? lo : order[k - 1].y + min);
  }
  for (let k = order.length - 1; k >= 0; k--) {
    order[k].y = Math.min(order[k].y, k === order.length - 1 ? hi : order[k + 1].y - min);
  }
  const out = ys.slice();
  for (const o of order) out[o.i] = o.y;
  return out;
}

/** The market-share chart as inline SVG: one 2px line per House, hairline grid, mono labels, direct labels. */
export function renderTrendChart(g: Game, width: number): SVGSVGElement {
  const W = Math.max(280, Math.floor(width));
  const H = W < 420 ? 230 : 270;
  const m = { l: 36, r: W < 420 ? 102 : 112, t: 26, b: 26 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'trend-svg', role: 'img', 'aria-label': 'Market share by turn for each House, with Era boundaries' });
  const trend = g.trend;
  const maxShare = Math.max(40, ...trend.flatMap((t) => t.share));
  const yMax = Math.ceil(maxShare / 10) * 10;
  const t0 = trend.length ? trend[0].turn : 1;
  const t1 = trend.length ? trend[trend.length - 1].turn : finalTurn(g);
  const span = Math.max(1, t1 - t0);
  const x = (turn: number): number => m.l + ((turn - t0) / span) * pw;
  const y = (v: number): number => m.t + ph - (v / yMax) * ph;

  // Hairline gridlines and y labels.
  const step = yMax > 60 ? 20 : 10;
  for (let v = 0; v <= yMax; v += step) {
    svg.append(svgEl('line', { x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v), class: 'grid' }));
    svg.append(svgEl('text', { x: m.l - 6, y: y(v) + 3.5, class: 'tick', 'text-anchor': 'end' }, `${v}%`));
  }
  // Era boundaries and numerals.
  const per = eraTurns(g);
  for (let e = 1; e <= ERAS.length; e++) {
    const start = (e - 1) * per + 1;
    const end = e * per;
    const xs = Math.min(Math.max(x(start), m.l), m.l + pw);
    const xe = Math.min(Math.max(x(end), m.l), m.l + pw);
    if (e > 1) svg.append(svgEl('line', { x1: xs, x2: xs, y1: m.t - 8, y2: m.t + ph, class: 'era-rule' }));
    svg.append(svgEl('text', { x: (xs + xe) / 2, y: m.t - 12, class: 'era-label', 'text-anchor': 'middle' }, ERAS[e - 1].roman));
  }
  svg.append(svgEl('text', { x: m.l + pw / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, 'Turn'));
  svg.append(svgEl('text', { x: m.l, y: H - 6, class: 'tick', 'text-anchor': 'start' }, String(t0)));
  svg.append(svgEl('text', { x: m.l + pw, y: H - 6, class: 'tick', 'text-anchor': 'end' }, String(t1)));

  // One line per House, in House colour; ring markers at each Era's last sample.
  const ends: { y: number; i: number }[] = [];
  g.players.forEach((p, i) => {
    const hs = house(p.house);
    const pts = trend.map((t) => `${x(t.turn).toFixed(1)},${y(t.share[i] ?? 0).toFixed(1)}`);
    if (pts.length > 1) svg.append(svgEl('polyline', { points: pts.join(' '), fill: 'none', stroke: hs.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'trend-line', 'data-house': String(p.house) }));
    for (const e of ERAS) {
      let last: TrendPoint | null = null;
      for (const t of trend) if (t.era === e.n) last = t;
      if (last) svg.append(svgEl('circle', { cx: x(last.turn), cy: y(last.share[i] ?? 0), r: 3.5, fill: hs.color, stroke: '#F7F4EE', 'stroke-width': 2 }));
    }
    const lastT = trend[trend.length - 1];
    ends.push({ y: y(lastT?.share[i] ?? 0), i });
  });
  const ly = spreadLabels(ends.map((e) => e.y), 14, m.t + 4, m.t + ph);
  ends.forEach((e, k) => {
    const p = g.players[e.i];
    const hs = house(p.house);
    const v = trend[trend.length - 1]?.share[e.i] ?? 0;
    const lx = m.l + pw + 8;
    svg.append(svgEl('rect', { x: lx, y: ly[k] - 4, width: 8, height: 8, fill: hs.color, class: 'swatch' }));
    svg.append(svgEl('text', { x: lx + 13, y: ly[k] + 3.5, class: 'direct' }, `${hs.short} ${v}%`));
  });
  return svg;
}

export class FinalEdition {
  private root: HTMLElement | null = null;
  private key = '';
  private untrap: (() => void) | null = null;
  private ro: ResizeObserver | null = null;
  private actions: { rematch: HTMLButtonElement; endless: HTMLButtonElement; note: HTMLElement } | null = null;
  private returnTo: HTMLElement | null = null;

  constructor(private host: HTMLElement, private on: FinalHandlers) {}

  get open(): boolean {
    return this.root !== null;
  }

  sync(v: SessionView): void {
    if (!v.ended) {
      this.close();
      return;
    }
    const g = v.game;
    const key = `${g.seed}:${g.turn}:${g.winner}:${v.roomCode}:${g.mode}`;
    if (!this.root || this.key !== key) {
      this.close();
      this.build(v, key);
    }
    this.updateActions(v);
  }

  private updateActions(v: SessionView): void {
    if (!this.actions) return;
    const canAct = v.mode !== 'room' || v.host;
    this.actions.rematch.hidden = !canAct;
    this.actions.endless.hidden = !canAct;
    this.actions.note.hidden = canAct;
  }

  close(): void {
    if (!this.root) return;
    this.untrap?.();
    this.ro?.disconnect();
    this.ro = null;
    this.root.remove();
    this.root = null;
    this.key = '';
    this.actions = null;
    if (this.returnTo && document.contains(this.returnTo)) this.returnTo.focus({ preventScroll: true });
    this.returnTo = null;
  }

  private honour(g: Game, o: Honour): HTMLElement {
    const p = g.players[o.player];
    return h('li', { class: 'honour', 'data-house': String(p.house) },
      h('span', { class: 'honour-ic', html: icon(o.key) }),
      h('span', { class: 'honour-text' },
        h('span', { class: 'honour-title serif', text: o.title }),
        h('span', { class: 'honour-who' }, crest(p.house, 'crest-sm'), h('span', { text: p.name, title: `${p.name} · ${house(p.house).name}` })),
        h('span', { class: 'honour-detail mono', text: o.detail }),
      ),
    );
  }

  private build(v: SessionView, key: string): void {
    const g = v.game;
    this.returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const win = g.players[g.winner] ?? g.players[g.standings[0]?.player ?? 0];
    const { head, deck } = finalHeadline(g);
    const rows = crownRows(g);

    const table = h('ol', { class: 'crown-table' },
      h('li', { class: 'crown-head', 'aria-hidden': 'true' },
        h('span', { text: 'House' }),
        h('span', { class: 'eq-cols' }, h('span', { text: 'Worth' }), h('span', {}), h('span', { text: 'Share' }), h('span', {}), h('span', { text: 'Prestige' }), h('span', {}), h('span', { text: 'Crown' })),
      ),
      ...rows.map((r, rank) => {
        const eq = (val: number, sub: string, cls = ''): HTMLElement => h('span', { class: `eq-term ${cls}`.trim() }, h('span', { class: 'eq-val mono', text: String(val) }), h('span', { class: 'eq-sub mono', text: sub }));
        return h('li', { class: `crown-row${r.player === g.winner ? ' is-winner' : ''}`, 'data-house': String(r.house), 'aria-label': `${house(r.house).name}: Worth ${r.worth} plus Share ${r.share} plus Prestige ${r.prestige} equals Crown ${r.crown}` },
          h('span', { class: 'crown-who' },
            h('span', { class: 'crown-rank mono', text: String(rank + 1) }),
            crest(r.house, 'crest-sm'),
            h('span', { class: 'crown-name' }, h('span', { class: 'crown-house', text: house(r.house).name }), h('span', { class: 'crown-player', text: r.name })),
          ),
          h('span', { class: 'eq-cols', 'aria-hidden': 'true' },
            eq(r.worth, `${fmtMoney(r.netWorth)} ÷ 10`),
            h('span', { class: 'eq-op mono', text: '+' }),
            eq(r.share, `${r.sharePct}% × 3`),
            h('span', { class: 'eq-op mono', text: '+' }),
            eq(r.prestige, `${r.prestigeRaw} × 4`),
            h('span', { class: 'eq-op mono', text: '=' }),
            eq(r.crown, 'Crown', 'eq-total'),
          ),
        );
      }),
    );

    const chartBox = h('div', { class: 'trend-box' });
    const shares = eraShares(g);
    const eraTable = h('table', { class: 'era-table' },
      h('caption', { class: 'sr-only', text: 'Market share at the end of each Era' }),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Share at Era end' }), ...ERAS.map((e) => h('th', { scope: 'col', class: 'mono', text: e.roman })))),
      h('tbody', {}, ...g.players.map((p, i) =>
        h('tr', { 'data-house': String(p.house) },
          h('th', { scope: 'row' }, h('span', { class: 'era-who' }, crest(p.house, 'crest-xs'), h('span', { text: house(p.house).short }))),
          ...shares[i].map((s) => h('td', { class: 'mono', text: s === null ? '·' : `${s}%` })),
        ))),
    );

    const rematch = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.on.rematch() }, 'Rematch');
    const endless = h('button', { class: 'btn', type: 'button', onclick: () => this.on.endless() }, 'Continue in Endless');
    const note = h('p', { class: 'final-note', text: 'Waiting for the host to choose Rematch or Continue in Endless.' });
    const exportBtn = v.mode === 'room' ? null : h('button', { class: 'btn', type: 'button', onclick: () => this.on.exportMatch() }, 'Export match');
    const leave = h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => this.on.leave() }, v.mode === 'room' ? 'Leave room' : 'Back to title');

    const sheet = h('article', { class: 'gazette', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gazette-h' },
      h('header', { class: 'masthead' },
        h('p', { class: 'masthead-kicker mono', text: `${MODES[g.mode as MatchMode].name} · ${finalTurn(g)} turns · Seed ${g.seed}` }),
        h('h1', { class: 'masthead-title serif', id: 'gazette-h', text: 'The Mercadia Gazette — Final Edition' }),
      ),
      h('div', { class: 'gazette-cols' },
        h('div', { class: 'gazette-main' },
          h('section', { class: 'lead', 'data-house': String(win.house) },
            h('span', { class: 'lead-crest', html: grandCrest(win.house) }),
            h('div', { class: 'lead-text' },
              h('h2', { class: 'lead-head serif', text: head }),
              h('p', { class: 'lead-deck', text: deck }),
            ),
          ),
          h('section', { class: 'gz-section', 'aria-labelledby': 'gz-crown' },
            h('h3', { class: 'field-label', id: 'gz-crown', text: 'Crown Index · Worth + Share + Prestige = Crown' }),
            table,
          ),
          h('section', { class: 'gz-section', 'aria-labelledby': 'gz-honours' },
            h('h3', { class: 'field-label', id: 'gz-honours', text: 'Match honours' }),
            h('ul', { class: 'honours' }, ...g.honours.map((o) => this.honour(g, o))),
          ),
        ),
        h('div', { class: 'gazette-side' },
          h('section', { class: 'gz-section', 'aria-labelledby': 'gz-chart' },
            h('h3', { class: 'field-label', id: 'gz-chart', text: 'Market share by turn · Eras I to IV' }),
            chartBox,
            eraTable,
          ),
        ),
      ),
      h('footer', { class: 'gazette-actions' }, rematch, endless, note, exportBtn, leave),
    );
    const root = h('div', { class: 'final-layer', 'data-modal': '' }, sheet);
    this.host.append(root);
    this.root = root;
    this.key = key;
    this.actions = { rematch, endless, note };
    this.untrap = trapFocus(root);

    const draw = (): void => {
      clear(chartBox);
      chartBox.append(renderTrendChart(g, chartBox.clientWidth || 520));
    };
    draw();
    if (typeof ResizeObserver !== 'undefined') {
      let lastW = chartBox.clientWidth;
      this.ro = new ResizeObserver(() => {
        if (Math.abs(chartBox.clientWidth - lastW) > 4) {
          lastW = chartBox.clientWidth;
          draw();
        }
      });
      this.ro.observe(chartBox);
    }
    root.scrollTop = 0;
    this.updateActions(v);
    (this.actions.rematch.hidden ? leave : rematch).focus({ preventScroll: true });
  }
}
