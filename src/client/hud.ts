// The HUD: small linen panels docked to the edges of the city. Structure is built once and
// then patched in place, so a button never disappears under the cursor mid-click.
import {
  AI_PERSONAS,
  ARCHS,
  BUILD_KINDS,
  CIVICS,
  DAYPART_NAMES,
  DESIRES,
  EVENTS,
  HOUSES,
  LOAN_MAX,
  LOAN_RATE,
  LOAN_STEP,
  MODES,
  START_CASH,
  PROMO_COOLDOWN,
  PROMO_COST,
  PROMO_TICKS,
  SHOPS,
  STANCES,
  buildCost,
  buildName,
  isShop,
  loanRateLabel,
} from '../shared/constants';
import { civicImpact, eventTouches, initials, lotSynergy, shopDiagnosis, toolTooltip } from '../shared/insight';
import { CITY, tx, ty, walkDist } from '../shared/map';
import type { BuildingView, CitizenView, CityView, LobbyView } from '../shared/protocol';
import {
  TAKINGS_PER_MIN,
  citizenName,
  citizenTile,
  crownParts,
  ledgerCashChange,
  ledgerNet,
  lotBonuses,
  priceOf,
  queueCap,
  rentOf,
  restockCost,
  salvageValue,
  trafficPips,
  upgradeCost,
  wageOf,
} from '../shared/sim';
import { CS, type BuildKind, type Command, type Fx, type Ledger, type MatchMode, type MatchResult } from '../shared/types';
import type { Foley } from './audio';
import { crest, dial, icon } from './icons';
import { Confirm } from './input';
import type { Renderer, UiState } from './renderer';
import type { Session } from './session';

export interface HudHost {
  session(): Session;
  ui: UiState;
  audio: Foley;
  renderer: Renderer;
  setTool(k: BuildKind | null): void;
  select(tile: number): void;
  leave(): void;
  isHost(): boolean;
  /** Drop any armed build tool and selection (rematch, endless, final bell). */
  disarm(): void;
  /** Fit the district to the free area of the screen. */
  refit(): void;
}

const SPECTATOR_TEXT = 'Match in progress: you are watching as a spectator.';
/** Viewports at or below this width get the tabbed dock and the bottom-sheet inspector. */
const narrow = (): boolean => window.innerWidth <= 640;
const phone = (): boolean => window.innerWidth <= 720;
const soundLabel = (muted: boolean): string => (muted ? 'Unmute sound (M)' : 'Mute sound (M)');
const setAttr = (el: Element | null | undefined, name: string, value: string): void => {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
export const money = (n: number): string => {
  const v = Math.round(n);
  return (v < 0 ? '−§' : '§') + Math.abs(v).toLocaleString('en-US');
};
const setText = (el: Element | null | undefined, s: string): void => {
  if (el && el.textContent !== s) el.textContent = s;
};
const setHtml = (el: Element | null | undefined, s: string): void => {
  if (el && (el as HTMLElement).dataset.h !== s) {
    el.innerHTML = s;
    (el as HTMLElement).dataset.h = s;
  }
};
const toggle = (el: Element | null | undefined, cls: string, on: boolean): void => {
  if (el && el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
};
const pipsHtml = (n: number, of = 5): string =>
  `<span class="pips">${Array.from({ length: of }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;

const SAY: Record<string, string> = {
  coffee: 'I could use a coffee.',
  dining: 'Somewhere good for a bite?',
  leisure: 'Fancy a few games.',
  fashion: 'Something new to wear, perhaps.',
  culture: 'What is showing tonight?',
  nightlife: 'The night is young.',
};

const LEDGER_ROWS: [keyof Ledger, string, 1 | -1][] = [
  ['revenue', 'Revenue', 1],
  ['awards', 'Awards', 1],
  ['salvage', 'Property sales', 1],
  ['wages', 'Wages', -1],
  ['supplies', 'Supplies', -1],
  ['rent', 'Rent & upkeep', -1],
  ['interest', 'Loan interest', -1],
  ['marketing', 'Promotions', -1],
  ['construction', 'Construction', -1],
  ['civic', 'Civic projects', -1],
];

export class Hud {
  private root = $('hud');
  private clock = $('clock');
  private ticker = $('ticker');
  private board = $('board');
  private inspector = $('inspector');
  private treasury = $('treasury');
  private ledger = $('ledger');
  private dock = $('dock');
  private lotcard = $('lotcard');
  private speech = $('speech');
  private banner = $('banner');
  private toasts = $('toasts');
  private victory = $('victory');
  private docktabs = $('docktabs');
  private spectator = $('spectator');

  private leaveConfirm = new Confirm(4000);
  private boardOpen = false;
  private dockTab: 'shops' | 'civic' = 'shops';
  private sheetCollapsed = false;
  private revealedFor = -1;
  private lastSync = 0;
  private builtFor = '';
  private inspKey = '';
  private refs: Record<string, HTMLElement> = {};
  private ledgerOpen = false;
  private sellArmed = 0;
  private tickerKey = '';
  private hintKind: BuildKind | null = null;
  private victoryFor = -1;
  private lastQuarter = 0;

  constructor(private host: HudHost) {
    this.wire();
  }

  // ───────────────────────────── Lifecycle ─────────────────────────────

  show(): void {
    this.root.hidden = false;
    this.builtFor = '';
    this.inspKey = '';
    this.victoryFor = -1;
    this.lastQuarter = 0;
    this.tickerKey = '';
    this.inspector.hidden = true;
    this.ledger.hidden = true;
    this.ledgerOpen = false;
    this.victory.hidden = true;
    this.leaveConfirm.reset();
    this.boardOpen = false;
    this.dockTab = 'shops';
    this.sheetCollapsed = false;
    this.revealedFor = -1;
    this.clearRefusals();
    this.sync(0, true);
  }

  hide(): void {
    this.root.hidden = true;
    this.victory.hidden = true;
    this.lotcard.hidden = true;
    this.speech.hidden = true;
    this.leaveConfirm.reset();
    this.clearRefusals();
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** True while the Final Edition modal owns the screen. */
  get victoryOpen(): boolean {
    return !this.victory.hidden;
  }

  toast(text: string, tone: boolean | 'good' | 'bad' | 'info' = false): void {
    const kind = tone === true ? 'good' : tone === false ? 'info' : tone;
    const el = document.createElement('div');
    el.className = kind === 'info' ? 'toast' : `toast ${kind}`;
    el.textContent = text;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    window.setTimeout(() => el.remove(), 2700);
  }

  /** A refusal ("Not enough cash…"). Only one is ever on screen: a new one replaces the old. */
  refuse(text: string): void {
    this.clearRefusals();
    this.toast(text, 'bad');
  }

  /** The player's next action went through, so any standing refusal is stale: remove it now. */
  clearRefusals(): void {
    this.toasts.querySelectorAll('.toast.bad').forEach((el) => el.remove());
  }

  showBanner(title: string, sub: string): void {
    this.banner.innerHTML = `<b>${esc(title)}</b><span>${esc(sub)}</span>`;
    this.banner.classList.remove('show');
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
  }

  // ───────────────────────────── Wiring ─────────────────────────────

  private wire(): void {
    const s = (): Session => this.host.session();
    const cmd = (c: Command): void => s().command(c);

    this.dock.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]');
      if (!btn) return;
      const kind = btn.dataset.kind as BuildKind;
      this.host.audio.click();
      this.host.setTool(this.host.ui.tool === kind ? null : kind);
    });
    this.dock.addEventListener('pointerover', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]');
      this.hintKind = btn ? (btn.dataset.kind as BuildKind) : null;
      this.renderHint();
    });
    this.dock.addEventListener('pointerleave', () => {
      this.hintKind = null;
      this.renderHint();
    });

    this.clock.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act as string;
      this.host.audio.click();
      if (act === 'pause') s().togglePause();
      else if (act === 'speed') s().setSpeed(Number(btn.dataset.v));
      else if (act === 'sound') this.host.audio.toggle();
      else if (act === 'leave') {
        // Leaving a live match throws the city away: it takes a second, deliberate click.
        const live = this.host.ui.me >= 0 && !s().view.ended;
        if (!live || this.leaveConfirm.click(performance.now())) {
          this.leaveConfirm.reset();
          this.host.leave();
          return;
        }
      } else if (act === 'fit') this.host.refit();
      if (act !== 'leave') this.leaveConfirm.reset();
      this.sync(0, true);
    });

    this.board.addEventListener('click', (e) => {
      // The header toggle everywhere; on a phone the whole strip is the toggle.
      if (!(e.target as HTMLElement).closest('[data-act="breakdown"]') && !phone()) return;
      this.host.audio.click();
      this.boardOpen = !this.boardOpen;
      this.sync(0, true);
    });

    this.docktabs.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (!btn) return;
      this.host.audio.click();
      this.dockTab = btn.dataset.tab === 'civic' ? 'civic' : 'shops';
      // A blueprint from the other tab would be armed but invisible: drop it.
      const tool = this.host.ui.tool;
      if (tool && isShop(tool) !== (this.dockTab === 'shops')) this.host.setTool(null);
      this.sync(0, true);
    });

    this.treasury.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act as string;
      this.host.audio.click();
      if (act === 'borrow') cmd({ c: 'borrow' });
      else if (act === 'repay') cmd({ c: 'repay' });
      else if (act === 'ledger') {
        this.ledgerOpen = !this.ledgerOpen;
        this.ledger.hidden = !this.ledgerOpen;
      }
      this.sync(0, true);
    });
    this.ledger.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act="close"]')) {
        this.ledgerOpen = false;
        this.ledger.hidden = true;
        this.sync(0, true);
      }
    });

    this.inspector.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act as string;
      const id = Number(this.inspector.dataset.b ?? -1);
      this.host.audio.click();
      switch (act) {
        case 'close':
          this.host.select(-1);
          break;
        case 'collapse':
          this.sheetCollapsed = !this.sheetCollapsed;
          break;
        case 'stance':
          cmd({ c: 'price', id, stance: Number(btn.dataset.v) });
          break;
        case 'upgrade':
          cmd({ c: 'upgrade', id });
          break;
        case 'promo':
          cmd({ c: 'promo', id });
          break;
        case 'restock':
          cmd({ c: 'restock', id });
          break;
        case 'auto': {
          const b = s().view.building(id);
          if (b) cmd({ c: 'auto', id, on: !b.auto });
          break;
        }
        case 'sell':
          if (performance.now() < this.sellArmed) {
            this.sellArmed = 0;
            cmd({ c: 'sell', id });
            this.host.select(-1);
          } else this.sellArmed = performance.now() + 3000;
          break;
        default:
          break;
      }
      this.sync(0, true);
    });

    this.victory.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act as string;
      this.host.audio.click();
      if (act === 'rematch' || act === 'endless') {
        // Nothing armed for the finished match may carry into the next one.
        this.host.disarm();
        if (act === 'rematch') s().rematch();
        else s().endless();
        this.victory.hidden = true;
        this.sync(0, true);
      } else if (act === 'leave') this.host.leave();
    });
  }

  // ───────────────────────────── Feedback ─────────────────────────────

  onFx(f: Fx): void {
    const view = this.host.session().view;
    if (f.k === 'event') {
      if (f.phase !== 'end') {
        this.ticker.classList.remove('flash');
        void this.ticker.offsetWidth;
        this.ticker.classList.add('flash');
      }
    } else if (f.k === 'quarter') {
      this.showBanner(`Quarter ${f.q}`, 'A new morning in Mercadia');
    } else if (f.k === 'award') {
      const p = view.players[f.p];
      if (p) this.toast(`Golden Fork to ${HOUSES[p.house].name}`, f.p === this.host.ui.me);
    }
  }

  // ───────────────────────────── Sync ─────────────────────────────

  /** Patch every panel from the current view. Throttled to about 8 Hz. */
  sync(now: number, force = false): void {
    if (this.root.hidden) return;
    if (!force && now - this.lastSync < 120) return;
    this.lastSync = now;
    const session = this.host.session();
    const view = session.view;
    if (!view.ready) return;
    const key = `${session.kind}|${view.seed}|${view.players.length}|${this.host.ui.me}|${this.host.isHost() ? 1 : 0}`;
    if (key !== this.builtFor) {
      this.builtFor = key;
      this.build(session);
    }
    this.syncClock(session);
    this.syncTicker(view);
    this.syncBoard(view);
    this.syncTreasury(view);
    this.syncDock(view);
    this.syncInspector(view);
    if (this.ledgerOpen) this.syncLedger(view);
    this.syncVictory(session);
    if (view.quarter !== this.lastQuarter) {
      if (this.lastQuarter === 0 && view.tick < 30) this.showBanner('Quarter 1', MODES[view.mode].name + ' match');
      this.lastQuarter = view.quarter;
    }
  }

  private build(session: Session): void {
    const view = session.view;
    const me = this.host.ui.me;
    const playing = me >= 0;
    // Clock.
    let pace = '';
    if (session.kind === 'solo') {
      pace = `<div class="pace"><button data-act="pause" title="Pause (Space)" aria-label="Pause">${icon('pause')}</button>${[1, 2, 3]
        .map((v) => `<button data-act="speed" data-v="${v}" title="${v}× speed">${v}×</button>`)
        .join('')}</div>`;
    } else if (session.kind === 'multi') {
      const host = this.host.isHost();
      const tip = host ? 'Room pace' : 'Host controls match speed';
      pace = `<div class="pace" title="${tip}">${[1, 1.5, 2]
        .map((v) => `<button data-act="speed" data-v="${v}" title="${host ? `${v}× speed for everyone` : tip}" aria-label="${v}× speed${host ? '' : ' — host controls match speed'}" ${host ? '' : 'disabled'}>${v}×</button>`)
        .join('')}</div>`;
    }
    this.clock.innerHTML = `<span class="wordmark">MERCADIA</span>
      <div class="when"><b data-f="q"></b><span data-f="part"></span><i data-f="dial"></i></div>
      ${pace}
      <div class="tools">
        <button class="iconbtn" data-act="fit" title="Fit the district to the screen" aria-label="Fit view">${icon('fit')}</button>
        <button class="iconbtn" data-act="sound" data-f="sound" title="${soundLabel(this.host.audio.muted)}" aria-label="${soundLabel(this.host.audio.muted)}" aria-pressed="${this.host.audio.muted}"></button>
        <button class="iconbtn leave" data-act="leave" data-f="leave" title="Leave the match" aria-label="Leave the match">${icon('leave')}</button>
      </div>`;
    // Leaderboard.
    this.board.innerHTML = `<div class="bhead"><h3>Crown Index</h3>
      <button class="bktoggle" data-act="breakdown" aria-expanded="false" title="Crown Index = Worth (net worth ÷ 10) + Share (market share % × 3) + Prestige (civic prestige × 4). Click to show each House's parts.">Worth + Share + Prestige</button></div>
      <div class="rows">${view.players
      .map(
        (p, i) => `<div class="row${i === me ? ' me' : ''}" data-p="${i}">
          <i class="chip" style="background:${HOUSES[p.house].color}"></i>
          <span class="nm">${esc(i === me ? 'You' : p.name)}<small>${esc(HOUSES[p.house].short)}</small></span>
          <span class="ini">${esc(initials(p.name, i === me))}</span>
          <span class="crown" data-f="crown"></span>
          <span class="sub"><span data-f="cash"></span><span data-f="share"></span></span>
          <span class="parts" data-f="parts"></span>
        </div>`,
      )
      .join('')}</div>
      <div class="tug"><div class="lbl"><span>Market share</span><span data-f="lead"></span></div>
      <div class="bar">${view.players.map((p, i) => `<i data-s="${i}" style="background:${HOUSES[p.house].color};width:${100 / view.players.length}%"></i>`).join('')}</div></div>`;
    // Treasury.
    this.treasury.hidden = !playing;
    this.treasury.innerHTML = `<div class="cash"><b data-f="cash"></b><span data-f="trend"></span></div>
      <div class="line"><span>Net worth</span><b data-f="nw"></b></div>
      <div class="line"><span>Debt</span><b data-f="debt"></b></div>
      <div class="acts">
        <button class="btn" data-act="borrow" title="Emergency Credit Line: borrow ${money(LOAN_STEP)} (limit ${money(LOAN_MAX)}). Interest is ${(LOAN_RATE * 100).toFixed(1)}% of your debt at every payroll (10 s) — ${loanRateLabel(view.quarterTicks)}." aria-label="Borrow ${money(LOAN_STEP)} at ${loanRateLabel(view.quarterTicks)}">Borrow ${money(LOAN_STEP)}<small> · ${loanRateLabel(view.quarterTicks)}</small></button>
        <button class="btn" data-act="repay" title="Repay up to ${money(LOAN_STEP)} of principal">Repay</button>
        <button class="btn" data-act="ledger" title="Ledger" aria-label="Ledger">${icon('ledger')}</button>
      </div>`;
    this.ledger.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><h3>Ledger</h3><button class="iconbtn" data-act="close" aria-label="Close ledger">${icon('close')}</button></div><div data-f="body"></div>`;
    // Dock.
    this.dock.hidden = !playing;
    this.docktabs.hidden = !playing;
    this.docktabs.innerHTML = `<div class="seg" role="tablist" aria-label="Build palette">
        <button role="tab" data-tab="shops" aria-controls="dock">Shops (6)</button>
        <button role="tab" data-tab="civic" aria-controls="dock">Civic (3)</button>
      </div><span class="armhint" data-f="armhint"></span>`;
    // Spectators get a persistent, high-contrast notice where the dock would be.
    this.spectator.hidden = playing || session.kind !== 'multi';
    this.spectator.textContent = SPECTATOR_TEXT;
    this.dock.innerHTML =
      BUILD_KINDS.map((k, i) => {
        const shop = isShop(k);
        return `${i === 6 ? '<span class="sep"></span>' : ''}<button class="tool" data-kind="${k}" data-group="${shop ? 'shops' : 'civic'}" title="${esc(toolTooltip(k))}" aria-label="${buildName(k)}, ${money(buildCost(k))}">
          <span class="key">${i + 1}</span>${shop ? '<span class="want"><i></i><i></i><i></i></span>' : ''}
          ${icon(k)}<span class="nm">${buildName(k).replace('Pocket ', '').replace('Festival ', '')}</span><span class="cost">${money(buildCost(k))}</span>
        </button>`;
      }).join('') + '<div class="hint" hidden></div>';
    this.inspKey = '';
  }

  private syncClock(session: Session): void {
    const view = session.view;
    const q = (n: string): HTMLElement | null => this.clock.querySelector<HTMLElement>(`[data-f="${n}"]`);
    const total = view.totalQuarters > 0 && !view.endless ? `/${view.totalQuarters}` : '';
    setText(q('q'), `Q${view.quarter}${total}`);
    const part = Math.min(3, Math.floor(view.dayPhase * 4));
    setText(q('part'), view.ended ? 'Final bell' : DAYPART_NAMES[part]);
    setHtml(q('dial'), dial(view.dayPhase));
    const muted = this.host.audio.muted;
    const sound = q('sound');
    setHtml(sound, icon(muted ? 'mute' : 'sound'));
    setAttr(sound, 'aria-pressed', String(muted));
    setAttr(sound, 'aria-label', soundLabel(muted));
    setAttr(sound, 'title', soundLabel(muted));
    // Leave: the first click arms it for four seconds, the second click leaves.
    if (view.ended) this.leaveConfirm.reset();
    const leave = q('leave');
    const armed = this.leaveConfirm.armed(performance.now());
    toggle(leave, 'armed', armed);
    setHtml(leave, armed ? 'Leave?' : icon('leave'));
    setAttr(leave, 'aria-label', armed ? 'Leave? Click again to abandon this match' : 'Leave the match');
    setAttr(leave, 'title', armed ? 'Click again to leave — your city will be abandoned' : 'Leave the match');
    const speed = session.kind === 'multi' ? view.speed : session.speed;
    this.clock.querySelectorAll<HTMLElement>('[data-act="speed"]').forEach((b) => toggle(b, 'on', !session.paused && Number(b.dataset.v) === speed));
    toggle(this.clock.querySelector('[data-act="pause"]'), 'on', session.paused);
  }

  private syncTicker(view: CityView): void {
    const ev = view.event;
    let key: string;
    let html: string;
    let pct = 0;
    if (ev) {
      const def = EVENTS[ev.kind];
      if (ev.started) {
        pct = 100 * (1 - (view.tick - ev.startAt) / Math.max(1, ev.endAt - ev.startAt));
        key = `L${ev.kind}${ev.startAt}`;
        html = `<div class="tk-top"><span class="tk-label live">Live</span><span class="tk-title">${def.title}</span><span class="tk-effect">${def.effect}</span></div><div class="tk-fx" title="What this event changes">${def.effect}</div><div class="tk-line">${def.headline}</div>`;
      } else {
        pct = 100 * ((view.tick - ev.announceAt) / Math.max(1, ev.startAt - ev.announceAt));
        key = `F${ev.kind}${ev.startAt}`;
        html = `<div class="tk-top"><span class="tk-label">Forecast</span><span class="tk-title">${def.title}</span><span class="tk-effect">${def.effect}</span></div><div class="tk-fx" title="What this event will change">${def.effect}</div><div class="tk-line">${def.forecast}</div>`;
      }
    } else {
      const last = view.gazette[view.gazette.length - 1];
      key = `G${last ? last.tick + last.text : ''}`;
      html = `<div class="tk-top quiet"><span class="tk-label">Mercadia Gazette</span></div><div class="tk-line news${last && last.tone === 'rival' ? ' rival' : ''}">${esc(last ? last.text : 'All quiet along the canal.')}</div>`;
    }
    if (key !== this.tickerKey) {
      this.tickerKey = key;
      this.ticker.innerHTML = html + '<i class="tk-bar"></i>';
      toggle(this.ticker, 'forecast', !!ev && !ev.started);
    }
    const bar = this.ticker.querySelector<HTMLElement>('.tk-bar');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
  }

  private syncBoard(view: CityView): void {
    const order = view.players.map((p) => p.id).sort((a, b) => view.players[b].crown - view.players[a].crown || a - b);
    const total = view.players.reduce((a, p) => a + p.share, 0);
    let lead = -1;
    view.players.forEach((p, i) => {
      const row = this.board.querySelector<HTMLElement>(`.row[data-p="${i}"]`);
      if (!row) return;
      const rank = String(order.indexOf(i));
      if (row.style.order !== rank) row.style.order = rank;
      setText(row.querySelector('[data-f="crown"]'), String(p.crown));
      setText(row.querySelector('[data-f="cash"]'), money(p.cash));
      setText(row.querySelector('[data-f="share"]'), total > 0 ? `${Math.round(p.share * 100)}% share` : '—');
      // Worth + Share + Prestige = Crown, exactly.
      const parts = crownParts(p);
      setHtml(row.querySelector('[data-f="parts"]'), `<b>${parts.worth}</b> worth + <b>${parts.share}</b> share + <b>${parts.prestige}</b> prestige`);
      setAttr(
        row,
        'title',
        `${i === this.host.ui.me ? 'You' : p.name} — Crown ${parts.crown} = Worth ${parts.worth} (net worth ${money(p.netWorth)} ÷ 10) + Share ${parts.share} (${Math.round(p.share * 100)}% × 3) + Prestige ${parts.prestige} (${p.prestige.toFixed(1)} × 4)`,
      );
      // The share bar reads in the same order as the ranked strip above it.
      const seg = this.board.querySelector<HTMLElement>(`.bar i[data-s="${i}"]`);
      if (seg) {
        seg.style.width = `${total > 0 ? (p.share / total) * 100 : 100 / view.players.length}%`;
        if (seg.style.order !== rank) seg.style.order = rank;
        setAttr(seg, 'title', `${i === this.host.ui.me ? 'You' : p.name}: ${Math.round(p.share * 100)}% of recent sales`);
      }
      if (lead < 0 || p.share > view.players[lead].share) lead = i;
    });
    toggle(this.board, 'open', this.boardOpen);
    setAttr(this.board.querySelector('[data-act="breakdown"]'), 'aria-expanded', String(this.boardOpen));
    setText(this.board.querySelector('[data-f="lead"]'), total > 0 && lead >= 0 ? `${HOUSES[view.players[lead].house].short} leads` : 'No sales yet');
  }

  private syncTreasury(view: CityView): void {
    const me = view.players[this.host.ui.me];
    if (!me) return;
    const q = (n: string): HTMLElement | null => this.treasury.querySelector<HTMLElement>(`[data-f="${n}"]`);
    const cashEl = q('cash');
    setText(cashEl, money(me.cash));
    toggle(cashEl, 'neg', me.cash < 0);
    const lg = view.ledgers[me.id];
    const net = lg ? ledgerNet(lg.cur) : 0;
    const trend = q('trend');
    setText(trend, `${net >= 0 ? '+' : '−'}§${Math.abs(Math.round(net)).toLocaleString('en-US')} this quarter`);
    toggle(trend, 'up', net > 0);
    toggle(trend, 'down', net < 0);
    setText(q('nw'), money(me.netWorth));
    setText(q('debt'), me.debt > 0 ? `${money(me.debt)} of ${money(LOAN_MAX)}` : 'None');
    const borrow = this.treasury.querySelector<HTMLButtonElement>('[data-act="borrow"]');
    const repay = this.treasury.querySelector<HTMLButtonElement>('[data-act="repay"]');
    if (borrow) borrow.disabled = view.ended || me.debt + LOAN_STEP > LOAN_MAX;
    if (repay) repay.disabled = view.ended || me.debt <= 0 || me.cash < 1;
    toggle(this.treasury.querySelector('[data-act="ledger"]'), 'primary', this.ledgerOpen);
  }

  private syncDock(view: CityView): void {
    const me = view.players[this.host.ui.me];
    if (!me) return;
    const totalUnmet = view.unmet.reduce((a, b) => a + b, 0) + 1;
    this.dock.querySelectorAll<HTMLElement>('.tool').forEach((btn) => {
      const k = btn.dataset.kind as BuildKind;
      toggle(btn, 'on', this.host.ui.tool === k);
      toggle(btn, 'poor', me.cash < buildCost(k));
      if (isShop(k)) {
        const di = DESIRES.indexOf(SHOPS[k].desire);
        // Unmet demand: how many citizens wanted this and found no shop.
        const level = this.demandLevel(view, di, totalUnmet);
        btn.querySelectorAll('.want i').forEach((el, i) => toggle(el, 'on', i < level));
      }
    });
    // Narrow screens: one tap between the six shops and the three civic projects.
    const tool = this.host.ui.tool;
    if (tool) this.dockTab = isShop(tool) ? 'shops' : 'civic';
    if (this.dock.dataset.tab !== this.dockTab) this.dock.dataset.tab = this.dockTab;
    this.docktabs.querySelectorAll<HTMLElement>('[data-tab]').forEach((el) => {
      const on = el.dataset.tab === this.dockTab;
      toggle(el, 'on', on);
      setAttr(el, 'aria-selected', String(on));
    });
    setText(
      this.docktabs.querySelector('[data-f="armhint"]'),
      !tool ? (this.dockTab === 'civic' ? 'Parks, stops and plazas lift every shop around them' : 'Bars show unmet demand') : tool === 'tramstop' ? 'Tram Stop: place along the tramway avenue' : `${buildName(tool)}: tap a green lot`,
    );
    toggle(this.docktabs, 'armed', !!tool);
    this.renderHint();
  }

  private demandLevel(view: CityView, di: number, _totalUnmet: number): number {
    const u = view.unmet[di];
    const m = view.met[di];
    const want = u + m;
    if (want < 1.5) return 0;
    const ratio = u / want;
    return u > 6 && ratio > 0.45 ? 3 : u > 2.5 && ratio > 0.2 ? 2 : u > 0.8 ? 1 : 0;
  }

  private renderHint(): void {
    const hint = this.dock.querySelector<HTMLElement>('.hint');
    if (!hint) return;
    const view = this.host.session().view;
    const k = this.hintKind ?? this.host.ui.tool;
    if (!k) {
      hint.hidden = true;
      return;
    }
    hint.hidden = false;
    const blurb = isShop(k) ? SHOPS[k].blurb : CIVICS[k].blurb;
    let extra = '';
    if (this.host.ui.tool === k) extra = k === 'tramstop' ? '<em>Place along the tramway avenue · Esc cancels</em>' : '<em>Click a green lot · Esc cancels</em>';
    else if (isShop(k)) {
      const di = DESIRES.indexOf(SHOPS[k].desire);
      const lvl = this.demandLevel(view, di, 1);
      extra = `<em>${['demand met', 'some unmet demand', 'unmet demand', 'crowds going unserved'][lvl]}</em>`;
    }
    setHtml(hint, `<b>${buildName(k)}</b>${blurb}${extra}`);
  }

  // ───────────────────────────── Inspector ─────────────────────────────

  private bonusTags(view: CityView, tile: number): string {
    const bon = lotBonuses(view, tile);
    const tags: string[] = [];
    if (bon.corner) tags.push('<span class="tag" title="Seen from two streets: +15% pull"><i style="background:#1E1A16"></i>Corner</span>');
    if (bon.canal) tags.push('<span class="tag" title="Water frontage: +10% appeal, +20% for a Bistro"><i style="background:#3E8E9E"></i>Canal-front</span>');
    if (bon.transit) tags.push('<span class="tag" title="Within two tiles of a Tram Stop: +10% pull"><i style="background:#D4A34A"></i>Transit</span>');
    if (bon.parks) tags.push(`<span class="tag" title="Pocket Park next door: +${bon.parks * 20}% quality"><i style="background:#5F8A6C"></i>Park +${bon.parks * 20}%</span>`);
    if (bon.plaza) tags.push('<span class="tag" title="Inside a Festival Plaza aura: +30% appeal"><i style="background:#C86443"></i>Plaza +30%</span>');
    return tags.length ? `<div class="tags">${tags.join('')}</div>` : '';
  }

  private syncInspector(view: CityView): void {
    const tile = this.host.ui.selectedTile;
    if (tile < 0) {
      if (!this.inspector.hidden) this.inspector.hidden = true;
      this.inspKey = '';
      this.revealedFor = -1;
      toggle(this.root, 'sheet', false);
      return;
    }
    const b = view.buildingAt(tile);
    const me = this.host.ui.me;
    const mine = !!b && b.owner === me;
    const kindOfTile = CITY.tiles[tile];
    const bon = lotBonuses(view, tile);
    const key = `${tile}|${b ? `${b.id}|${b.kind}|${b.owner}|${b.level}` : kindOfTile}|${mine}|${bon.corner}${bon.canal}${bon.transit}${bon.parks}${bon.plaza}`;
    if (key !== this.inspKey) {
      this.inspKey = key;
      this.sellArmed = 0;
      this.inspector.hidden = false;
      this.inspector.dataset.b = String(b ? b.id : -1);
      this.inspector.innerHTML = this.inspectorHtml(view, tile, b, mine);
      this.refs = {};
      this.inspector.querySelectorAll<HTMLElement>('[data-f]').forEach((el) => (this.refs[el.dataset.f as string] = el));
    }
    toggle(this.inspector, 'collapsed', this.sheetCollapsed);
    setAttr(this.refs.collapse, 'aria-expanded', String(!this.sheetCollapsed));
    toggle(this.root, 'sheet', true);
    this.reveal(tile);
    if (!b) {
      if (kindOfTile === 'lot') setHtml(this.refs.pips, pipsHtml(trafficPips(view, tile)));
      return;
    }
    const r = this.refs;
    if (!isShop(b.kind)) {
      setText(r.prestige, view.players[b.owner] ? view.players[b.owner].prestige.toFixed(1) : '0');
      // Live impact: riders delivered by a Tram Stop, shops boosted by a Park or Plaza.
      civicImpact(view, b).forEach((row, i) => setText(r[`impact${i}`], row.value));
      this.syncSell(b, mine);
      return;
    }
    const def = SHOPS[b.kind];
    const cap = queueCap(b);
    // Why is this shop missing sales? One line, most urgent cause first.
    const diag = shopDiagnosis(b, { daypart: Math.min(3, Math.floor(view.dayPhase * 4)), buildings: view.buildings });
    if (r.diag) {
      setText(r.diag, diag ? diag.text : '');
      if (diag && r.diag.dataset.tone !== diag.tone) r.diag.dataset.tone = diag.tone;
    }
    // A forecast or running Gazette event that touches this trade.
    if (r.evt) {
      const ev = view.event;
      const touch = ev ? eventTouches(ev.kind, b.kind) : null;
      r.evt.hidden = !touch;
      if (ev && touch) {
        setText(r.evt, `${ev.started ? 'Live' : 'Forecast'} · ${EVENTS[ev.kind].title}: ${EVENTS[ev.kind].effect}`);
        if (r.evt.dataset.tone !== touch) r.evt.dataset.tone = touch;
      }
    }
    // Promo Blitz badge with a live countdown — on rival shops too, so a blitz is never a mystery.
    if (r.promoBadge) {
      const left = b.promoUntil - view.tick;
      r.promoBadge.hidden = left <= 0;
      if (left > 0) {
        setText(r.promoTime, `${Math.ceil(left / 10)}s`);
        (r.promoBar as HTMLElement).style.width = `${Math.max(0, Math.min(100, (left / PROMO_TICKS) * 100))}%`;
      }
    }
    setText(r.price, money(priceOf(b)));
    setText(r.queue, `${b.q}/${cap}`);
    toggle(r.queue, 'warn', b.q >= cap - 1 && b.q < cap);
    toggle(r.queue, 'bad', b.q >= cap);
    setText(r.stock, `${b.stock}/${def.stockMax}`);
    toggle(r.stock, 'bad', b.stock <= 0);
    toggle(r.stock, 'warn', b.stock > 0 && b.stock <= def.stockMax * 0.25);
    setText(r.rating, b.rating.toFixed(1));
    setText(r.takings, `${money(b.recent * TAKINGS_PER_MIN)}`);
    setText(r.served, String(b.served));
    setText(r.turned, String(b.turned));
    toggle(r.turned, 'warn', b.turned > 0 && b.turned > b.served * 0.15);
    setText(r.costs, `${money((wageOf(b) + rentOf(b, view.event?.started === true && view.event.kind === 'renthike')) * 6)}`);
    if (!mine) {
      setText(r.stance, `${STANCES[b.stance].name} ${STANCES[b.stance].label}`);
      return;
    }
    const cash = view.players[me]?.cash ?? 0;
    this.inspector.querySelectorAll<HTMLElement>('[data-act="stance"]').forEach((el) => toggle(el, 'on', Number(el.dataset.v) === b.stance));
    // Upgrade.
    const up = r.upgrade as HTMLButtonElement | undefined;
    if (up) {
      if (b.level >= 3) {
        up.disabled = true;
        setHtml(up, 'Level 3 — fully appointed');
      } else {
        const c = upgradeCost(b);
        up.disabled = cash < c || view.ended;
        setHtml(up, `Upgrade to Lv ${b.level + 1}<span class="cost">${money(c)}</span>`);
      }
    }
    // Promo Blitz.
    const promo = r.promo as HTMLButtonElement | undefined;
    const pm = r.promoMeter;
    if (promo && pm) {
      const meter = pm.firstElementChild as HTMLElement;
      if (view.tick < b.promoUntil) {
        promo.disabled = true;
        setHtml(promo, `Blitz running · ${Math.ceil((b.promoUntil - view.tick) / 10)}s`);
        pm.hidden = false;
        toggle(pm, 'promo', true);
        meter.style.width = `${((b.promoUntil - view.tick) / PROMO_TICKS) * 100}%`;
      } else if (view.tick < b.promoReadyAt) {
        promo.disabled = true;
        setHtml(promo, `Promo ready in ${Math.ceil((b.promoReadyAt - view.tick) / 10)}s`);
        pm.hidden = false;
        toggle(pm, 'promo', false);
        meter.style.width = `${(1 - (b.promoReadyAt - view.tick) / PROMO_COOLDOWN) * 100}%`;
      } else {
        promo.disabled = cash < PROMO_COST || view.ended;
        setHtml(promo, `Promo Blitz · 20s<span class="cost">${money(PROMO_COST)}</span>`);
        pm.hidden = true;
      }
    }
    // Stock.
    const sm = r.stockMeter;
    if (sm) {
      (sm.firstElementChild as HTMLElement).style.width = `${(b.stock / def.stockMax) * 100}%`;
      toggle(sm, 'low', b.stock <= def.stockMax * 0.25);
    }
    const rs = r.restock as HTMLButtonElement | undefined;
    if (rs) {
      const c = restockCost(view, b, false);
      rs.disabled = b.stock >= def.stockMax || cash < def.unitCost || view.ended;
      setHtml(rs, b.stock >= def.stockMax ? 'Stockroom full' : `Restock<span class="cost">${money(Math.min(c, Math.max(0, cash)))}</span>`);
    }
    toggle(r.auto, 'on', b.auto);
    this.syncSell(b, mine);
  }

  /**
   * On a phone the Inspector is a bottom sheet. Once per selection, pan the camera so the
   * selected block sits in the strip of city left visible between the score strip and the sheet.
   */
  private reveal(tile: number): void {
    if (this.revealedFor === tile) return;
    this.revealedFor = tile;
    if (!narrow()) return;
    const r = this.host.renderer;
    const top = this.board.getBoundingClientRect().bottom + 8;
    const bottom = this.inspector.getBoundingClientRect().top - 8;
    if (bottom - top < 60) return;
    const p = r.tileToScreen(tx(tile) + 0.5, ty(tile) + 0.5, 12);
    const wantY = top + (bottom - top) * 0.58;
    const dx = p.x < 40 || p.x > r.width - 40 ? r.width / 2 - p.x : 0;
    const dy = p.y < top + 44 || p.y > bottom - 14 ? wantY - p.y : 0;
    if (dx || dy) r.pan(dx, dy);
  }

  private syncSell(b: BuildingView, mine: boolean): void {
    const sell = this.refs.sell as HTMLButtonElement | undefined;
    if (!sell || !mine) return;
    const armed = performance.now() < this.sellArmed;
    setHtml(sell, armed ? `Confirm sale<span class="cost">${money(salvageValue(b))}</span>` : `Sell property<span class="cost">${money(salvageValue(b))}</span>`);
    toggle(sell, 'primary', armed);
  }

  private inspectorHtml(view: CityView, tile: number, b: BuildingView | undefined, mine: boolean): string {
    const close = `<button class="iconbtn sheetbtn" data-act="collapse" data-f="collapse" aria-label="Collapse or expand details" title="Collapse or expand details" aria-expanded="true">${icon('chevron')}</button><button class="iconbtn" data-act="close" aria-label="Close" title="Close (Esc)">${icon('close')}</button>`;
    const kind = CITY.tiles[tile];
    if (!b) {
      if (kind === 'lot') {
        const tags = this.bonusTags(view, tile);
        return `<div class="head">${icon('corner')}<div class="t"><b>Vacant lot</b><span>For lease</span></div>${close}</div>
          ${tags || '<p>A plain mid-block lot.</p>'}
          <div class="rowline" style="color:var(--ink-2);font-size:12px">Foot traffic <span data-f="pips"></span></div>
          ${this.host.ui.me >= 0 ? '<p>Pick a shop or civic project from the dock, then click this lot.</p>' : ''}`;
      }
      const info: Record<string, [string, string]> = {
        home: ['Townhouses', 'Residents set out from here: commuters at dawn, diners at noon, revellers at dusk.'],
        station: ['Grand Station', 'Tourists arrive here with full wallets. A city Tram Stop stands outside.'],
        garden: ['Public garden', 'A corner of green kept by the city.'],
        avenue: ['Streetcar Avenue', 'The tram loop. Lots within two tiles of a Tram Stop earn the Transit bonus.'],
        avbridge: ['Avenue bridge', 'The tramway crosses the Grand Canal here.'],
        lane: ['Lane', 'Pedestrians only. Every lot opens onto a lane or the avenue.'],
        bridge: ['Stone footbridge', 'One of two arched footbridges over the Grand Canal.'],
        canal: ['Grand Canal', 'Canal-front lots gain appeal, and a Bistro gains the most.'],
      };
      const [name, text] = tile === CITY.pierTile ? ['Harbor Pier', 'Cruise passengers come ashore here.'] : (info[kind] ?? ['Mercadia', '']);
      return `<div class="head"><div class="t"><b>${name}</b></div>${close}</div><p>${text}</p>`;
    }
    const owner = view.players[b.owner];
    const house = owner ? HOUSES[owner.house] : HOUSES[0];
    const ownerName = mine ? 'Your property' : owner ? `${esc(owner.name)} · ${house.name}` : '';
    const head = `<div class="head">${icon(b.kind)}<div class="t"><b>${buildName(b.kind)}${isShop(b.kind) ? ` <span class="mono" style="display:inline;font-size:11px;color:var(--ink-3)">Lv ${b.level}</span>` : ''}</b>
      <span><i style="background:${house.color}"></i>${ownerName}</span></div>${close}</div>`;
    const tags = this.bonusTags(view, tile);
    if (!isShop(b.kind)) {
      const def = CIVICS[b.kind];
      const impact = civicImpact(view, b)
        .map((row, i) => `<div class="impact"><label>${row.label}</label><b data-f="impact${i}">${row.value}</b></div>`)
        .join('');
      return `${head}${tags}<div class="impacts">${impact}</div>
        <div class="more"><p>${def.blurb}</p>
        <div class="stats"><div><label>Upkeep</label><b>${money(def.rent * 6)}/m</b></div><div><label>Prestige</label><b data-f="prestige"></b></div><div><label>Built</label><b>${money(b.invested)}</b></div></div>
        ${mine ? `<button class="btn wide danger" data-act="sell" data-f="sell"></button>` : ''}</div>`;
    }
    const def = SHOPS[b.kind];
    const stats = `<div class="stats">
      <div><label>Price</label><b data-f="price"></b></div>
      <div><label>Queue</label><b data-f="queue"></b></div>
      <div><label>Stock</label><b data-f="stock"></b></div>
      <div><label>Rating</label><b data-f="rating"></b></div>
      <div><label>Takings/min</label><b data-f="takings"></b></div>
      <div><label>Costs/min</label><b data-f="costs"></b></div>
      <div><label>Served</label><b data-f="served"></b></div>
      <div><label>Turned away</label><b data-f="turned"></b></div>
      <div><label>${mine ? 'Serves' : 'Stance'}</label><b ${mine ? '' : 'data-f="stance"'} style="font-size:11px">${mine ? def.desire : ''}</b></div>
    </div>`;
    const promoBadge = `<div class="promobadge" data-f="promoBadge" hidden><span>Promo Blitz</span><b data-f="promoTime"></b><i><u data-f="promoBar"></u></i></div>`;
    const diag = `<div class="diag" data-f="diag" role="status"></div><div class="evt" data-f="evt" hidden></div>`;
    if (!mine) return `${head}${promoBadge}${diag}${tags}${stats}<div class="more"><p>${def.blurb}</p></div>`;
    return `${head}${promoBadge}${diag}${tags}${stats}<div class="more">
      <div class="grp"><h4>Price stance</h4><div class="seg">${STANCES.map((s, i) => `<button data-act="stance" data-v="${i}" title="${s.name} ${s.label}">${s.name}<small>${s.label}</small></button>`).join('')}</div></div>
      <div class="grp"><button class="btn wide" data-act="upgrade" data-f="upgrade"></button></div>
      <div class="grp"><button class="btn wide" data-act="promo" data-f="promo"></button><div class="meter" data-f="promoMeter" style="margin-top:4px" hidden><i></i></div></div>
      <div class="grp"><h4>Stockroom</h4><div class="meter" data-f="stockMeter"><i></i></div>
        <div class="rowline"><button class="btn" data-act="restock" data-f="restock"></button><button class="switch" data-act="auto" data-f="auto" title="Auto-Restock buys at a 15% premium when stock runs low"><i></i>Auto</button></div></div>
      <div class="grp"><button class="btn wide danger" data-act="sell" data-f="sell"></button></div></div>`;
  }

  // ───────────────────────────── Ledger ─────────────────────────────

  private syncLedger(view: CityView): void {
    const lg = view.ledgers[this.host.ui.me];
    if (!lg) return;
    const cell = (v: number, sign: 1 | -1): string => {
      const n = Math.round(v);
      if (n === 0) return '<td class="zero">—</td>';
      return `<td class="${sign < 0 ? 'neg' : ''}">${sign < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US')}</td>`;
    };
    const signed = (v: number): string => {
      const n = Math.round(v);
      return `<td class="${n < 0 ? 'neg' : n > 0 ? 'pos' : 'zero'}">${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US')}</td>`;
    };
    const net = (l: Ledger): string => signed(ledgerNet(l));
    const change = (l: Ledger): string => signed(ledgerCashChange(l));
    const me = view.players[this.host.ui.me];
    const rows = LEDGER_ROWS.map(
      ([k, label, sign], i) => `<tr class="${i === 3 || i === 8 ? 'sep' : ''}"><td>${label}</td>${cell(lg.cur[k], sign)}${cell(lg.last[k], sign)}${cell(lg.total[k], sign)}</tr>`,
    ).join('');
    setHtml(
      this.ledger.querySelector('[data-f="body"]'),
      `<table><thead><tr><th></th><th>This Q</th><th>Last Q</th><th>Match</th></tr></thead><tbody>${rows}
       <tr class="net"><td>Net cashflow</td>${net(lg.cur)}${net(lg.last)}${net(lg.total)}</tr>
       <tr class="fin"><td colspan="4">Financing</td></tr>
       <tr><td>Loan draws</td>${cell(lg.cur.borrowed, 1)}${cell(lg.last.borrowed, 1)}${cell(lg.total.borrowed, 1)}</tr>
       <tr><td>Loan repayments</td>${cell(lg.cur.repaid, -1)}${cell(lg.last.repaid, -1)}${cell(lg.total.repaid, -1)}</tr>
       <tr class="net"><td>Change in cash</td>${change(lg.cur)}${change(lg.last)}${change(lg.total)}</tr></tbody></table>
       <p class="recon">Opening ${money(START_CASH)} + match change = <b>${money(START_CASH + ledgerCashChange(lg.total))}</b> in hand${me && me.debt > 0 ? ` · ${money(me.debt)} owed at ${loanRateLabel(view.quarterTicks)}` : ''}</p>`,
    );
  }

  // ───────────────────────────── Victory ─────────────────────────────

  private syncVictory(session: Session): void {
    const view = session.view;
    if (!view.ended || !view.result) {
      if (!this.victory.hidden && !view.ended) this.victory.hidden = true;
      if (!view.ended) this.victoryFor = -1;
      return;
    }
    const stamp = view.seed * 100 + view.quarter;
    if (this.victoryFor === stamp) return;
    this.victoryFor = stamp;
    this.victory.innerHTML = this.editionHtml(session, view.result);
    this.victory.hidden = false;
    // Focus the page itself, never a button: a stray Space or Enter must not start a rematch.
    this.victory.querySelector<HTMLElement>('.victory')?.focus({ preventScroll: true });
    this.host.audio.award();
  }

  /** The Mercadia Gazette — Final Edition: the victory summary laid out as a front page. */
  private editionHtml(session: Session, res: MatchResult): string {
    const view = session.view;
    const me = this.host.ui.me;
    const who = (id: number): string => esc(id === me ? 'You' : (view.players[id]?.name ?? ''));
    const win = view.players[res.winner];
    const house = HOUSES[win.house];
    const ranked = res.rows.slice().sort((a, b) => b.crown - a.crown || a.player - b.player);
    const top = crownParts(ranked[0]);
    const rows = ranked
      .map((r, i) => {
        const p = view.players[r.player];
        const parts = crownParts(r);
        return `<tr class="${r.player === res.winner ? 'win' : ''}${r.player === me ? ' me' : ''}">
          <td><span class="rk">${i + 1}</span><i style="background:${HOUSES[p.house].color}"></i>${who(r.player)}<small>${p.kind === 'ai' && p.persona ? AI_PERSONAS[p.persona].title : HOUSES[p.house].short}</small>
            <em>${money(r.revenue)} revenue · ${r.served} served · ${r.shops} shop${r.shops === 1 ? '' : 's'} + ${r.civic} civic</em></td>
          <td title="Net worth ${money(r.netWorth)} ÷ 10">${parts.worth}<small>${money(r.netWorth)}</small></td>
          <td title="Market share ${Math.round(r.share * 100)}% × 3">${parts.share}<small>${Math.round(r.share * 100)}%</small></td>
          <td title="Civic Prestige ${r.prestige} × 4">${parts.prestige}<small>${Math.round(r.prestige)} pts</small></td>
          <td class="total">${parts.crown}</td></tr>`;
      })
      .join('');
    const awardIcon: Record<string, string> = { corner: 'corner', shark: 'shark', patron: 'patron' };
    const awards = (['corner', 'shark', 'patron'] as const)
      .map((k) => {
        const a = res.awards.find((x) => x.key === k);
        const title = k === 'corner' ? 'Corner King' : k === 'shark' ? 'Price Shark' : 'Civic Patron';
        if (!a) return `<div class="award"><div class="a-title">${icon(awardIcon[k])}${title}</div><div class="a-detail">Unclaimed this match</div></div>`;
        const p = view.players[a.player];
        return `<div class="award"><div class="a-title">${icon(awardIcon[k])}${title}</div><div class="a-who"><i style="background:${HOUSES[p.house].color}"></i>${who(a.player)}</div><div class="a-detail">${esc(a.detail)}</div></div>`;
      })
      .join('');
    const canDecide = session.kind === 'solo' || this.host.isHost();
    const headline = res.winner === me ? 'The district is yours.' : `${house.name} takes the district.`;
    const quarters = view.endless ? `Quarter ${view.quarter}` : `${view.totalQuarters} quarters`;
    return `<div class="victory edition" role="dialog" aria-modal="true" aria-label="Mercadia Gazette, Final Edition: match summary" tabindex="-1">
      <header class="masthead">
        <span class="m-side">Final Edition</span>
        <span class="m-name">The Mercadia Gazette</span>
        <span class="m-side r">${MODES[view.mode].name} · ${quarters}</span>
      </header>
      <div class="front">
        ${crest(house.color, house.dark, house.light, house.short.charAt(0))}
        <div class="story">
          <div class="kicker">Closing bell · ${esc(house.name)}</div>
          <h2>${headline}</h2>
          ${res.highlight ? `<p class="highlight">${esc(res.highlight)}</p>` : ''}
          <div class="equation" aria-label="Winning Crown Index breakdown">
            <span><b>${top.worth}</b><small>Worth</small></span><i>+</i>
            <span><b>${top.share}</b><small>Share</small></span><i>+</i>
            <span><b>${top.prestige}</b><small>Prestige</small></span><i>=</i>
            <span class="sum"><b>${top.crown}</b><small>Crown</small></span>
          </div>
        </div>
      </div>
      <div class="cols">
        <section class="standings">
          <h3>Crown Index · Worth + Share + Prestige</h3>
          <table><thead><tr><th>House</th><th title="Net worth ÷ 10">Worth</th><th title="Market share % × 3">Share</th><th title="Civic Prestige × 4">Prestige</th><th>Crown</th></tr></thead><tbody>${rows}</tbody></table>
        </section>
        <section class="trend">
          <h3>Market share, quarter by quarter</h3>
          ${this.sparkline(view, res, me)}
        </section>
      </div>
      <h3 class="sect">Honours</h3>
      <div class="awards">${awards}</div>
      <div class="acts">
        <button class="btn primary big" data-act="rematch" ${canDecide ? '' : 'disabled'} title="A fresh district, same Houses">Rematch</button>
        <button class="btn big strong" data-act="endless" ${canDecide ? '' : 'disabled'} title="Keep this city running with no final bell">Continue in Endless</button>
        <button class="btn big quiet" data-act="leave">Leave</button>
        ${canDecide ? '' : '<div class="note">The host decides what happens next.</div>'}
      </div></div>`;
  }

  /**
   * Inline SVG: each House's market share through the match, one sample per daypart, with a
   * hairline at every quarter's close. Lines carry the House colour; labels stay in ink.
   */
  private sparkline(view: CityView, res: MatchResult, me: number): string {
    const samples = res.trend?.samples ?? [];
    const per = Math.max(1, res.trend?.perQuarter ?? 4);
    const n = samples.length;
    if (n < 2) return '<p class="nodata">Too short a match to chart.</p>';
    const W = 270;
    const H = 150;
    const L = 26;
    const R = 60;
    const T = 10;
    const B = 22;
    const pw = W - L - R;
    const ph = H - T - B;
    let max = 0;
    for (const row of samples) for (const v of row) max = Math.max(max, v);
    const top = Math.max(400, Math.ceil(max / 100) * 100); // share ×1000, rounded up to 10%
    const X = (i: number): number => L + (pw * i) / (n - 1);
    const Y = (v: number): number => T + ph * (1 - v / top);
    const f = (v: number): string => v.toFixed(1);
    // Quarter gridlines and labels.
    const q0 = Math.max(0, view.quarter - Math.ceil(n / per));
    const quarters = Math.ceil(n / per);
    const every = Math.max(1, Math.ceil(quarters / 8));
    let grid = '';
    for (let q = 1; q <= quarters; q++) {
      const end = Math.min(n - 1, q * per - 1);
      const start = (q - 1) * per - 1; // the previous quarter's closing sample
      const x0 = start < 0 ? L : X(start);
      const x1 = X(end);
      if (q < quarters) grid += `<line x1="${f(x1)}" y1="${T}" x2="${f(x1)}" y2="${T + ph}" class="g"/>`;
      if ((q - 1) % every === 0) grid += `<text x="${f((x0 + x1) / 2)}" y="${H - 6}" text-anchor="middle" class="ax">Q${q0 + q}</text>`;
      const shares = view.players.map((p, i) => `${i === me ? 'You' : p.name} ${Math.round((samples[end][i] ?? 0) / 10)}%`).join(' · ');
      grid += `<rect x="${f(x0)}" y="${T}" width="${f(Math.max(1, x1 - x0))}" height="${ph}" class="hit"><title>End of Q${q0 + q}: ${esc(shares)}</title></rect>`;
    }
    const half = Math.round(top / 2);
    const yaxis = [0, half, top]
      .map((v) => `<line x1="${L}" y1="${f(Y(v))}" x2="${L + pw}" y2="${f(Y(v))}" class="${v === 0 ? 'base' : 'g'}"/><text x="${L - 5}" y="${f(Y(v) + 3)}" text-anchor="end" class="ax">${Math.round(v / 10)}%</text>`)
      .join('');
    // Lines, drawn so the winner sits on top.
    const order = view.players.map((p) => p.id).sort((a, b) => (a === res.winner ? 1 : 0) - (b === res.winner ? 1 : 0));
    const lines = order
      .map((id) => {
        const p = view.players[id];
        const pts = samples.map((row, i) => `${f(X(i))},${f(Y(row[id] ?? 0))}`).join(' ');
        return `<polyline points="${pts}" fill="none" stroke="${HOUSES[p.house].color}" stroke-width="${id === res.winner ? 2.4 : 2}" stroke-linejoin="round" stroke-linecap="round"><title>${id === me ? 'You' : esc(p.name)} — market share</title></polyline>`;
      })
      .join('');
    // End dots with a surface ring, and direct labels nudged apart so they never collide.
    const last = samples[n - 1];
    const ends = view.players.map((p) => ({ id: p.id, y: Y(last[p.id] ?? 0), v: last[p.id] ?? 0 })).sort((a, b) => a.y - b.y);
    const labelY = ends.map((e) => e.y);
    for (let i = 1; i < labelY.length; i++) labelY[i] = Math.max(labelY[i], labelY[i - 1] + 12);
    const overflow = labelY.length ? labelY[labelY.length - 1] - (T + ph + 4) : 0;
    if (overflow > 0) for (let i = 0; i < labelY.length; i++) labelY[i] -= overflow;
    for (let i = labelY.length - 2; i >= 0; i--) labelY[i] = Math.min(labelY[i], labelY[i + 1] - 12);
    const dots = ends
      .map((e, i) => {
        const p = view.players[e.id];
        const name = initials(p.name, e.id === me);
        return `<circle cx="${f(X(n - 1))}" cy="${f(e.y)}" r="4" fill="${HOUSES[p.house].color}" stroke="#FAF7F0" stroke-width="2"><title>${e.id === me ? 'You' : esc(p.name)}: ${Math.round(e.v / 10)}% at the final bell</title></circle>
          <text x="${f(X(n - 1) + 9)}" y="${f(labelY[i] + 3.5)}" class="lb${e.id === res.winner ? ' w' : ''}">${esc(name)} ${Math.round(e.v / 10)}%</text>`;
      })
      .join('');
    const legend = view.players
      .map((p, i) => `<span><i style="background:${HOUSES[p.house].color}"></i>${i === me ? 'You' : esc(p.name)}</span>`)
      .join('');
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Market share by quarter for each House">${yaxis}${grid}${lines}${dots}</svg>
      <div class="legend">${legend}</div>`;
  }

  // ───────────────────────────── Per-frame cards ─────────────────────────────

  /** Position the hover lot card and the citizen speech card. Runs every frame. */
  frame(alpha: number): void {
    if (this.root.hidden) return;
    const view = this.host.session().view;
    const ui = this.host.ui;
    const r = this.host.renderer;
    // Lot card in build mode.
    const me = view.players[ui.me];
    const hov = ui.hoverTile;
    if (ui.tool && me && hov >= 0 && CITY.tiles[hov] === 'lot' && !view.buildingAt(hov)) {
      const bon = lotBonuses(view, hov);
      const names = [bon.corner ? 'Corner' : '', bon.canal ? 'Canal-front' : '', bon.transit ? 'Transit' : ''].filter(Boolean);
      const cost = buildCost(ui.tool);
      const illegal = ui.tool === 'tramstop' && CITY.avenueAdj[hov] < 0;
      const perks: string[] = [];
      if (bon.corner) perks.push('+15% pull');
      if (bon.canal) perks.push(ui.tool === 'bistro' ? '+20% appeal' : '+10% appeal');
      if (bon.transit) perks.push(ui.tool === 'arcade' ? '+30% pull' : '+10% pull');
      if (bon.parks) perks.push(`park +${bon.parks * 20}%`);
      if (bon.plaza) perks.push('plaza +30%');
      const badges = lotSynergy(view, hov, ui.tool, ui.me)
        .filter((bd) => !illegal || bd.tone === 'minus')
        .map((bd) => `<span class="syn ${bd.tone}">${esc(bd.text)}</span>`)
        .join('');
      const verdict = illegal
        ? '<span class="why">Inland lot — a Tram Stop must touch the avenue</span>'
        : me.cash < cost
          ? `<span class="why">Needs ${money(cost - me.cash)} more</span>`
          : `<span class="ok">${money(cost)} · ${ui.touch ? 'tap again' : 'click'} to build</span>`;
      setHtml(
        this.lotcard,
        `<b>${names.length ? names.join(' · ') : 'Mid-block'} lot</b>
         <div class="traffic">Foot traffic ${pipsHtml(trafficPips(view, hov))}</div>
         ${perks.length && !illegal ? `<div style="color:var(--ink-2)">${perks.join(' · ')}</div>` : ''}
         ${badges ? `<div class="syns">${badges}</div>` : ''}<div>${verdict}</div>`,
      );
      const p = r.tileToScreen(tx(hov) + 0.5, ty(hov) + 0.5, 34);
      this.lotcard.style.left = `${Math.round(clampN(p.x, 90, r.width - 90))}px`;
      this.lotcard.style.top = `${Math.round(Math.max(phone() ? 250 : 130, p.y))}px`;
      this.lotcard.hidden = false;
    } else if (!this.lotcard.hidden) this.lotcard.hidden = true;
    // Speech card.
    const c = ui.selectedCitizen >= 0 ? view.citizens.get(ui.selectedCitizen) : undefined;
    if (c) {
      setHtml(this.speech, this.speechHtml(view, c));
      const p = r.citizenScreen(c, alpha);
      this.speech.hidden = false;
      // Never let the card ride up into the clock, ticker or score strip: when there is no
      // room above the citizen, it docks below them instead.
      const safeTop = (phone() ? this.board.getBoundingClientRect().bottom : this.clock.getBoundingClientRect().bottom) + 6;
      const h = this.speech.offsetHeight || 120;
      const below = p.y - h < safeTop;
      toggle(this.speech, 'below', below);
      this.speech.style.left = `${Math.round(clampN(p.x, 122, r.width - 122))}px`;
      this.speech.style.top = `${Math.round(below ? Math.max(safeTop, p.y + 20 * r.cam.zoom + 8) : p.y)}px`;
    } else if (!this.speech.hidden) {
      this.speech.hidden = true;
      if (ui.selectedCitizen >= 0) ui.selectedCitizen = -1; // they went home
    }
  }

  private speechHtml(view: CityView, c: CitizenView): string {
    const arch = ARCHS[c.arch];
    const target = c.target >= 0 ? view.building(c.target) : undefined;
    const owner = target ? view.players[target.owner] : undefined;
    const place = target ? `${owner ? HOUSES[owner.house].short + ' ' : ''}${buildName(target.kind)}` : '';
    let doing = 'Out for a stroll';
    let say = SAY[c.desire];
    if (c.state === CS.ToShop && target) {
      const d = walkDist(citizenTile(c), CITY.door[target.tile]);
      doing = `→ ${place}${d > 0 ? ` · ${d} tiles` : ''}`;
    } else if (c.state === CS.Queue && target) {
      doing = `Queueing at ${place}`;
      say = target.q >= queueCap(target) - 1 ? 'This queue had better move.' : say;
    } else if (c.state === CS.Linger) {
      doing = `Resting in the ${target && target.kind === 'plaza' ? 'plaza' : 'park'}`;
      say = 'A fine spot to sit a while.';
    } else if (c.state === CS.Leave) {
      doing = 'Heading home';
      say = c.mood > 0.6 ? 'A good day out.' : 'That will do for today.';
    } else if (c.state === CS.Stroll && target) {
      doing = `Strolling to the ${target.kind === 'plaza' ? 'plaza' : 'park'}`;
      say = 'Just taking the air.';
    } else if (c.state === CS.Stroll) {
      say = 'Nothing here for me yet.';
    }
    const mood = c.mood > 0.75 ? 'delighted' : c.mood > 0.55 ? 'content' : c.mood > 0.35 ? 'restless' : 'cross';
    return `<div class="card"><b>${esc(citizenName(view.seed, c.id))}</b><span class="arch">${arch.name}</span>
      <div class="say">“${say}”</div>
      <dl><dt>Wants</dt><dd>${c.desire}</dd><dt>Budget</dt><dd>${money(c.budget)}</dd>
      <dt>Mood</dt><dd><span class="mood"><i style="width:${Math.round(c.mood * 100)}%;background:${c.mood > 0.55 ? 'var(--green)' : c.mood > 0.35 ? 'var(--amber)' : 'var(--red)'}"></i></span> ${mood}</dd>
      <dt>Now</dt><dd style="font-family:var(--sans)">${esc(doing)}</dd></dl></div>`;
  }
}

const clampN = (v: number, a: number, b: number): number => (b < a ? (a + b) / 2 : v < a ? a : v > b ? b : v);

// ───────────────────────────── Title and lobby ─────────────────────────────

export interface TitleHost {
  audio: Foley;
  playSolo(rivals: number, mode: MatchMode, name: string): void;
  createRoom(name: string): Promise<void>;
  joinRoom(code: string, name: string): Promise<void>;
}

const NAME_KEY = 'mercadia:name';
export const storedName = (): string => {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};
export const storeName = (n: string): void => {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    // ignore
  }
};

export class TitleScreen {
  private el = $('title');
  private rivals = 3;
  private mode: MatchMode = 'standard';
  private busy = false;

  constructor(private host: TitleHost) {
    this.render();
    this.el.addEventListener('click', (e) => void this.onClick(e));
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).id === 't-code') void this.join();
    });
    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 't-code') t.value = t.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    });
  }

  show(): void {
    this.el.hidden = false;
    this.busy = false;
    this.render();
  }
  hide(): void {
    this.el.hidden = true;
  }
  error(text: string): void {
    this.busy = false;
    const e = this.el.querySelector('.err');
    if (e) e.textContent = text;
    this.el.querySelectorAll<HTMLButtonElement>('button[data-act="create"],button[data-act="join"]').forEach((b) => (b.disabled = false));
  }

  private name(): string {
    const v = (this.el.querySelector<HTMLInputElement>('#t-name')?.value ?? '').trim();
    if (v) storeName(v);
    return v;
  }

  private render(): void {
    const keepName = this.el.querySelector<HTMLInputElement>('#t-name')?.value ?? storedName();
    const keepCode = this.el.querySelector<HTMLInputElement>('#t-code')?.value ?? '';
    const seg = (act: string, items: [string, string, string?][], cur: string): string =>
      `<div class="seg">${items.map(([v, label, small]) => `<button data-act="${act}" data-v="${v}" class="${v === cur ? 'on' : ''}">${label}${small ? `<small>${small}</small>` : ''}</button>`).join('')}</div>`;
    const personas = ['vesper', 'aurelia', 'orson'] as const;
    this.el.innerHTML = `
      <h1>MERCADIA</h1>
      <div class="rule"></div>
      <p class="tag" style="margin:0">Rival merchants reshape a sunlit canal-and-tramway city block by block.</p>
      <div class="solo">
        <button class="btn primary big wide" data-act="solo">Play Solo Now</button>
        <div class="opts">
          <label>Rivals</label>${seg('rivals', [['1', '1 AI'], ['2', '2 AI'], ['3', '3 AI']], String(this.rivals))}
          <label>Length</label>${seg('mode', [['blitz', 'Blitz', '2 quarters'], ['standard', 'Standard', '4 quarters'], ['endless', 'Endless', 'sandbox']], this.mode)}
        </div>
        <div class="rivals">${personas
          .map((p, i) => `<div class="rival${i < this.rivals ? '' : ' off'}"><i style="background:${HOUSES[i + 1].color}"></i><b>${AI_PERSONAS[p].name}</b><span>${AI_PERSONAS[p].title}</span></div>`)
          .join('')}</div>
      </div>
      <hr />
      <h3>Multiplayer room · 2 to 4 players</h3>
      <div class="mp">
        <div class="line"><input id="t-name" maxlength="16" placeholder="Your name" autocomplete="nickname" value="${esc(keepName)}" aria-label="Your name" /><button class="btn" data-act="create">Create Room</button></div>
        <div class="line"><input id="t-code" class="code" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(keepCode)}" aria-label="Room code" /><button class="btn" data-act="join" style="flex:1">Join Room</button></div>
        <div class="err" role="alert"></div>
      </div>
      <div class="foot"><span>Drag to pan · scroll to zoom · click anyone</span>
        <button class="iconbtn" data-act="sound" title="${soundLabel(this.host.audio.muted)}" aria-label="${soundLabel(this.host.audio.muted)}" aria-pressed="${this.host.audio.muted}">${icon(this.host.audio.muted ? 'mute' : 'sound')}</button></div>`;
  }

  /** Reflect a mute toggled elsewhere (the M key) without re-rendering the form. */
  syncSound(): void {
    const btn = this.el.querySelector<HTMLElement>('[data-act="sound"]');
    if (!btn) return;
    const muted = this.host.audio.muted;
    btn.innerHTML = icon(muted ? 'mute' : 'sound');
    btn.setAttribute('aria-pressed', String(muted));
    btn.setAttribute('aria-label', soundLabel(muted));
    btn.setAttribute('title', soundLabel(muted));
  }

  private async onClick(e: Event): Promise<void> {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn || this.busy) return;
    const act = btn.dataset.act as string;
    this.host.audio.unlock();
    this.host.audio.click();
    if (act === 'rivals') {
      this.rivals = Number(btn.dataset.v);
      this.render();
    } else if (act === 'mode') {
      this.mode = btn.dataset.v as MatchMode;
      this.render();
    } else if (act === 'sound') {
      this.host.audio.toggle();
      this.syncSound();
    } else if (act === 'solo') {
      this.host.playSolo(this.rivals, this.mode, this.name());
    } else if (act === 'create') {
      this.busy = true;
      (btn as HTMLButtonElement).disabled = true;
      try {
        await this.host.createRoom(this.name());
      } catch (err) {
        this.error(err instanceof Error ? err.message : 'Could not create a room.');
      }
      this.busy = false;
    } else if (act === 'join') {
      await this.join();
    }
  }

  private async join(): Promise<void> {
    const code = (this.el.querySelector<HTMLInputElement>('#t-code')?.value ?? '').toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      this.error('Enter the four-letter room code.');
      return;
    }
    this.busy = true;
    try {
      await this.host.joinRoom(code, this.name());
    } catch (err) {
      this.error(err instanceof Error ? err.message : 'Could not join that room.');
    }
    this.busy = false;
  }
}

export interface LobbyHost {
  audio: Foley;
  seat(): number;
  send(msg: import('../shared/protocol').ClientMsg): void;
  leave(): void;
  inviteUrl(): string;
}

export class LobbyScreen {
  private el = $('lobby');
  private lobby: LobbyView | null = null;
  private status = '';
  private copied = 0;

  constructor(private host: LobbyHost) {
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'l-name') {
        const v = t.value.trim();
        if (v) {
          storeName(v);
          this.host.send({ t: 'lobby', name: v });
        }
      }
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).id === 'l-name') (e.target as HTMLInputElement).blur();
    });
  }

  show(code: string): void {
    this.el.hidden = false;
    if (!this.lobby) this.el.innerHTML = `<h3>Room</h3><div class="code-row"><span class="roomcode">${esc(code)}</span></div><p class="sub">Connecting…</p><div class="go"><button class="btn" data-act="leave">Leave</button></div>`;
  }
  hide(): void {
    this.el.hidden = true;
  }
  reset(): void {
    this.lobby = null;
    this.status = '';
  }
  get visible(): boolean {
    return !this.el.hidden;
  }

  setStatus(text: string): void {
    this.status = text;
    const s = this.el.querySelector('.status');
    if (s) s.textContent = text;
  }

  update(lobby: LobbyView): void {
    this.lobby = lobby;
    if (this.el.hidden) return;
    this.render();
  }

  render(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const mySeat = this.host.seat();
    const host = mySeat === lobby.host;
    // Keep the name field alive if the player is typing in it.
    const active = document.activeElement as HTMLInputElement | null;
    const typing = active && active.id === 'l-name' ? { v: active.value, a: active.selectionStart, b: active.selectionEnd } : null;
    const taken = new Set(lobby.seats.filter((s, i) => s.kind === 'human' && i !== mySeat).map((s) => s.house));
    const seats = lobby.seats
      .map((s, i) => {
        const h = HOUSES[s.house];
        const me = i === mySeat;
        let who: string;
        let right = '';
        if (me) {
          who = `<input id="l-name" maxlength="16" value="${esc(s.name)}" aria-label="Your name" /><small>${h.name}</small>`;
          right = `<div class="houses" role="group" aria-label="House colour">${HOUSES.map(
            (hh, k) => `<button data-act="house" data-v="${k}" class="${k === s.house ? 'on' : ''}" style="background:${hh.color}" title="${hh.name}" aria-label="${hh.name}" ${taken.has(k) ? 'disabled' : ''}></button>`,
          ).join('')}</div>`;
        } else if (s.kind === 'human') {
          who = `<b>${esc(s.name)}</b><small>${h.name}${s.connected ? '' : ' · reconnecting'}</small>`;
          right = i === lobby.host ? '<span class="badge">Host</span>' : '<span class="badge soft">Ready</span>';
        } else if (s.kind === 'ai') {
          who = `<b>${esc(s.name)}</b><small>AI · ${s.persona ? AI_PERSONAS[s.persona].title : ''}</small>`;
          right = host ? `<button class="switch on" data-act="fill" data-seat="${i}" data-v="0" title="AI fills this seat"><i></i>AI</button>` : '<span class="badge soft">AI</span>';
        } else {
          who = `<b style="color:var(--ink-3)">Open seat</b><small>Waiting for a player</small>`;
          right = host ? `<button class="switch" data-act="fill" data-seat="${i}" data-v="1" title="Let an AI take this seat"><i></i>AI</button>` : '';
        }
        if (me && i === lobby.host) right += '<span class="badge">Host</span>';
        return `<div class="seat${me ? ' me' : ''}${s.kind === 'open' ? ' open' : ''}"><i class="sw" style="background:${s.kind === 'open' ? 'transparent;box-shadow:inset 0 0 0 1px var(--hair)' : h.color}"></i><div class="who">${who}</div><div class="right">${right}</div></div>`;
      })
      .join('');
    const participants = lobby.seats.filter((s) => s.kind !== 'open').length;
    const humans = lobby.seats.filter((s) => s.kind === 'human').length;
    const aiSeats = lobby.seats.filter((s) => s.kind === 'ai').length;
    const openSeats = lobby.seats.filter((s) => s.kind === 'open').length;
    const pvp = aiSeats === 0;
    // One click between a table padded with AI rivals and a pure human duel.
    const pvpBtn = host
      ? `<button class="btn pvp${pvp ? ' on' : ''}" data-act="pvp" data-v="${pvp ? '1' : '0'}" aria-pressed="${pvp}" ${pvp && openSeats === 0 ? 'disabled' : ''}
           title="${pvp ? 'Put Vesper, Aurelia and Orson back in the empty seats' : 'Clear every AI seat: only invited humans play (1v1 up to 4 players)'}">${pvp ? (openSeats ? 'Pure PvP on · Add AI rivals' : 'Pure PvP · table full') : 'No AI (Pure PvP)'}</button>`
      : pvp
        ? '<span class="badge">Pure PvP</span>'
        : '';
    const modes: [MatchMode, string, string][] = [['blitz', 'Blitz', '2 quarters'], ['standard', 'Standard', '4 quarters'], ['endless', 'Endless', 'sandbox']];
    const copied = performance.now() < this.copied;
    this.el.innerHTML = `
      <h3>Multiplayer room</h3>
      <div class="code-row"><span class="roomcode" id="l-code">${esc(lobby.code)}</span>
        <button class="btn" data-act="copy">${icon(copied ? 'check' : 'copy')}${copied ? 'Link copied' : 'Copy Invite Link'}</button></div>
      <p class="sub">${humans} of 4 players here. Share the link or the code; friends can join until the match starts.</p>
      <div class="seats">${seats}</div>
      ${pvpBtn ? `<div class="pvprow">${pvpBtn}<span>${pvp ? `${humans} human${humans === 1 ? '' : 's'}, no AI` : `${aiSeats} AI rival${aiSeats === 1 ? '' : 's'} will fill in`}</span></div>` : ''}
      <div class="opts"><label>Length</label><div class="seg">${modes
        .map(([v, label, small]) => `<button data-act="mode" data-v="${v}" class="${v === lobby.mode ? 'on' : ''}" ${host ? '' : 'disabled'}>${label}<small>${small}</small></button>`)
        .join('')}</div></div>
      <div class="go">
        ${host ? `<button class="btn primary big" data-act="start" ${participants < 2 ? 'disabled' : ''}>Start Match</button>` : '<button class="btn primary big" disabled>Waiting for the host</button>'}
        <button class="btn big" data-act="leave">Leave</button>
      </div>
      <div class="err status" role="status" style="margin-top:6px;color:var(--ink-2);font-weight:500">${esc(this.status || (host && participants < 2 ? (pvp ? 'Pure PvP needs a second player: share the link.' : 'Add an AI rival or invite a player to start.') : ''))}</div>`;
    if (typing) {
      const input = this.el.querySelector<HTMLInputElement>('#l-name');
      if (input) {
        input.value = typing.v;
        input.focus();
        try {
          input.setSelectionRange(typing.a, typing.b);
        } catch {
          // not all input types support selection
        }
      }
    }
  }

  private onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act as string;
    this.host.audio.unlock();
    this.host.audio.click();
    switch (act) {
      case 'copy': {
        const url = this.host.inviteUrl();
        const done = (): void => {
          this.copied = performance.now() + 1800;
          this.render();
          window.setTimeout(() => this.render(), 1900);
        };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, () => this.fallbackCopy(url, done));
        else this.fallbackCopy(url, done);
        break;
      }
      case 'house':
        this.host.send({ t: 'lobby', house: Number(btn.dataset.v) });
        break;
      case 'fill':
        this.host.send({ t: 'seat', seat: Number(btn.dataset.seat), ai: btn.dataset.v === '1' });
        break;
      case 'mode':
        this.host.send({ t: 'mode', mode: btn.dataset.v as MatchMode });
        break;
      case 'pvp':
        // data-v is the current state: "1" means Pure PvP is on, so the click brings AI back.
        this.host.send({ t: 'aifill', on: btn.dataset.v === '1' });
        break;
      case 'start':
        this.host.send({ t: 'start' });
        break;
      case 'leave':
        this.host.leave();
        break;
      default:
        break;
    }
  }

  private fallbackCopy(text: string, done: () => void): void {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      // the code is on screen either way
    }
    ta.remove();
    done();
  }
}
