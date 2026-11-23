// The HUD: small linen panels docked to the edges of the city. Structure is built once and
// then patched in place, so a button never disappears under the cursor mid-click.
import {
  AI_PERSONAS,
  ARCHS,
  BUILD_KINDS,
  CHARTERS,
  CIVICS,
  DAYPART_NAMES,
  DESIRES,
  ERAS,
  ERA_COUNT,
  ERA_UNLOCK,
  EVENTS,
  HOST_SPEEDS,
  HOUSES,
  LEVEL3_ERA,
  LEVEL3_NOTICE,
  LOAN_MAX,
  LOAN_RATE,
  LOAN_STEP,
  MILESTONES,
  MODES,
  OBJECTIVE,
  PAYROLL_TICKS,
  SOLO_SPEEDS,
  START_CASH,
  PROMO_TICKS,
  SHOPS,
  STANCES,
  buildCost,
  buildName,
  eraDef,
  eraLabel,
  eraOf,
  eraTitle,
  isShop,
  isUnlocked,
  lockNotice,
  unlocksOf,
} from '../shared/constants';
import { civicImpact, eventTouches, guideState, initials, lotSynergy, milestoneProgress, shopDiagnosis, starterLots, toolTooltip, type GuideView } from '../shared/insight';
import { CITY, tx, ty, walkDist } from '../shared/map';
import type { BuildingView, CitizenView, CityView, LobbyView } from '../shared/protocol';
import {
  TAKINGS_PER_MIN,
  buildCostFor,
  charterMod,
  citizenName,
  citizenTile,
  crownParts,
  ledgerCashChange,
  ledgerNet,
  lotBonuses,
  priceOf,
  promoCooldownFor,
  promoCostFor,
  queueCap,
  rentOf,
  restockCost,
  salvageValue,
  starsOf,
  trafficPips,
  upgradeCost,
  wageOf,
} from '../shared/sim';
import { CS, type BuildKind, type CharterKey, type Command, type Dispatch, type Fx, type Ledger, type MatchMode, type MatchResult } from '../shared/types';
import type { Foley } from './audio';
import { crestSvg, starPips } from './heraldry';
import { dial, grandCrest, icon } from './icons';
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
  /** Pan the camera to a lot (the Chronicle's click-to-focus). */
  focus(tile: number): void;
}

const SPECTATOR_TEXT = 'Match in progress: you are watching as a spectator.';
/** Viewports at or below this width get the tabbed dock and the bottom-sheet inspector. */
const narrow = (): boolean => window.innerWidth <= 640;
/** The Founding Guide's hints at phone width: short enough to sit beside the title on one line. */
const PHONE_HINTS = ['Pick a shop, tap a ringed lot.', 'Tap your shop.', ''];
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

/** Short names for the Treasury's charter badges. */
const CHARTER_SHORT: Record<CharterKey, string> = {
  artisanry: 'Artisanry',
  transit: 'Transit',
  credit: 'Credit',
  canal: 'Canal',
  heralds: 'Heralds',
  provisioners: 'Harbor',
};

/** The Chronicle's kicker for each category of dispatch. */
const CAT_LABEL: Record<Dispatch['cat'], string> = {
  era: 'New era',
  milestone: 'Dynasty Milestone',
  charter: 'Charter adopted',
  lead: 'Crown race',
  event: 'City event',
  rival: 'Price war',
  promo: 'Promo Blitz',
  build: 'On the map',
  market: 'Market',
};
const CAT_ICON: Record<Dispatch['cat'], string> = {
  era: 'era', milestone: 'star', charter: 'charter', lead: 'crown', event: 'ledger', rival: 'shark', promo: 'heralds', build: 'corner', market: 'ledger',
};
const BRASS = '#D4A34A';
const CANAL = '#3E8E9E';
/** How long a headline dispatch holds the banner before it yields to the live city event. */
const DISPATCH_HOLD_MS = 7000;

const GUIDE_KEY = 'mercadia:guide';
const FEED_KEY = 'mercadia:feed';
const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode
  }
};
const store = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the choice lasts for this visit
  }
};
/** "18%/era": the exact rate a standing loan costs this House over one era. */
const loanRateFor = (quarterTicks: number, owner: { charters?: CharterKey[] } | undefined): string =>
  `${(Math.round(LOAN_RATE * charterMod(owner, 'interest') * (quarterTicks / PAYROLL_TICKS) * 1000) / 10).toString()}%/era`;
/** "Era II · Transit" for the clock chip; Endless days past the fourth stay in the Golden Dynasty. */
const eraChip = (quarter: number): string => `${eraLabel(quarter)} · ${eraDef(quarter).short}`;

const LEDGER_ROWS: [keyof Ledger, string, 1 | -1][] = [
  ['revenue', 'Revenue', 1],
  ['awards', 'Awards', 1],
  ['dividends', 'Milestone dividends', 1],
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
  private chronicle = $('chronicle');
  private guide = $('guide');
  private council = $('council');
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
  private hintKind: BuildKind | null = null;
  private victoryFor = -1;
  private lastQuarter = 0;
  // The Mercadia Chronicle.
  private feedOpen = false;
  private feedChosen = false; // the player has toggled the feed (this visit or an earlier one)
  private feedKey = '';
  private bannerKey = '';
  private seenN = 0; // newest dispatch already noticed
  private holdN = 0; // headline dispatch holding the banner…
  private holdUntil = 0; // …until this time
  // Founding Guide.
  private guideDone = stored(GUIDE_KEY) === 'done';
  private inspected = false;
  private guideNow: GuideView | null = null;
  private guideKey = '';
  private guideLotsAt = 0;
  // Era Council and era locks.
  private councilKey = '';
  private lockState: Partial<Record<BuildKind, boolean>> = {};

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
    this.feedKey = '';
    this.bannerKey = '';
    this.seenN = 0;
    this.holdN = 0;
    this.holdUntil = 0;
    this.feedChosen = !phone() && stored(FEED_KEY) !== null;
    this.feedOpen = this.feedChosen && stored(FEED_KEY) === '1';
    this.inspected = false;
    this.guideNow = null;
    this.guideKey = '';
    this.guideLotsAt = 0;
    this.guide.hidden = true;
    this.host.ui.guideLots = [];
    this.councilKey = '';
    this.council.hidden = true;
    this.lockState = {};
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
    this.council.hidden = true;
    this.councilKey = '';
    this.host.ui.guideLots = [];
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

  /** True while the Era Council modal owns the screen (the city is paused). */
  get councilOpen(): boolean {
    return !this.council.hidden;
  }

  /** True while the Founding Guide is still walking the player through their opening. */
  get guideActive(): boolean {
    return !!this.guideNow && this.guideNow.step > 0;
  }

  /** The Founding Guide as the smoke checks read it. */
  guideInfo(): { step: number; done: boolean[]; dismissed: boolean; visible: boolean } {
    const g = this.guideNow;
    return { step: g ? g.step : 0, done: g ? g.done.slice() : [false, false, false], dismissed: this.guideDone, visible: !this.guide.hidden };
  }

  /** On a phone the expanded feed is an overlay: touching the city puts it away. */
  closeFeedOnPhone(): void {
    if (!phone() || !this.feedOpen) return;
    this.feedOpen = false;
    this.feedChosen = true;
    this.sync(0, true);
  }

  /** A locked tool was clicked, or its hotkey pressed: say when it unlocks. Never silent. */
  lockedNotice(kind: BuildKind): void {
    this.toasts.querySelectorAll('.toast.lockmsg').forEach((el) => el.remove());
    this.clearRefusals();
    this.toast(lockNotice(kind), 'info', 'lockmsg');
    this.host.audio.deny();
  }

  toast(text: string, tone: boolean | 'good' | 'bad' | 'info' = false, cls = ''): void {
    const kind = tone === true ? 'good' : tone === false ? 'info' : tone;
    const el = document.createElement('div');
    el.className = (kind === 'info' ? 'toast' : `toast ${kind}`) + (cls ? ` ${cls}` : '');
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

  showBanner(title: string, sub: string, long = false): void {
    this.banner.innerHTML = `<b>${esc(title)}</b><span>${esc(sub)}</span>`;
    this.banner.classList.remove('show');
    this.banner.classList.toggle('long', long);
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
      // A future-era tool is never armed: the click answers with its unlock notice.
      if (!isUnlocked(kind, s().view.quarter)) {
        this.lockedNotice(kind);
        return;
      }
      this.host.audio.click();
      this.host.setTool(this.host.ui.tool === kind ? null : kind);
    });

    // The Chronicle: the chevron (and, on a phone, the whole bar) opens the recent feed; a
    // dispatch tied to a lot pans the camera there.
    this.chronicle.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act as string;
      const tile = Number(btn.dataset.tile ?? -1);
      this.host.audio.click();
      const banner = !!btn.closest('.dispatch');
      if (act === 'focus' && tile >= 0 && !(banner && phone())) {
        this.host.focus(tile);
        if (phone()) this.feedOpen = false;
      } else if (act === 'feed' || (act === 'focus' && banner)) {
        this.feedOpen = !this.feedOpen;
        this.feedChosen = true;
        if (!phone()) store(FEED_KEY, this.feedOpen ? '1' : '0');
      }
      this.sync(0, true);
    });

    this.guide.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('[data-act="dismiss"]')) return;
      this.host.audio.click();
      this.retireGuide();
      this.sync(0, true);
    });

    this.council.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      const act = btn.dataset.act as string;
      if (act === 'charter') {
        this.host.audio.seal();
        cmd({ c: 'charter', key: btn.dataset.key as CharterKey });
      } else if (act === 'advance') {
        this.host.audio.click();
        s().advanceCouncil();
      }
      this.sync(0, true);
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
    const me = this.host.ui.me;
    if (f.k === 'quarter') {
      const era = eraOf(f.q);
      if (f.q > ERA_COUNT) this.showBanner(`${eraLabel(f.q)} · Day ${f.q}`, 'The Golden Dynasty plays on');
      else {
        const names = unlocksOf(era).map((k) => buildName(k));
        if (era === LEVEL3_ERA) names.push('Level 3');
        this.showBanner(`${eraLabel(f.q)} · ${eraDef(f.q).name}`, names.length ? `Unlocked: ${names.join(' · ')}` : 'The final Crown reckoning');
      }
    } else if (f.k === 'award') {
      const p = view.players[f.p];
      if (p) this.toast(`Golden Fork to ${HOUSES[p.house].name}`, f.p === me);
    } else if (f.k === 'milestone') {
      const p = view.players[f.p];
      const def = MILESTONES[f.m];
      if (p && def && f.p === me) this.toast(`Dynasty Milestone: ${def.name} · ${def.pill}`, 'good', 'msmsg');
    } else if (f.k === 'charter') {
      const def = CHARTERS[f.key];
      if (def && f.p === me) this.toast(`Charter sealed: ${def.name} · ${def.pill}`, 'good', 'chmsg');
    } else if (f.k === 'dispatch' && f.tier === 1) {
      // A headline dispatch: the banner takes it at once and flashes.
      this.chronicle.classList.remove('flash');
      void this.chronicle.offsetWidth;
      this.chronicle.classList.add('flash');
      this.sync(0, true);
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
    this.syncChronicle(view);
    this.syncBoard(view);
    this.syncTreasury(view);
    this.syncGuide(session);
    this.syncDock(view);
    this.syncInspector(view);
    if (this.ledgerOpen) this.syncLedger(view);
    this.syncCouncil(session);
    this.syncVictory(session);
    if (view.quarter !== this.lastQuarter) {
      // The match opens on its one-line objective.
      if (this.lastQuarter === 0 && view.tick < 30) this.showBanner(`${eraLabel(1)} · ${eraDef(1).name}`, this.host.ui.me >= 0 ? OBJECTIVE : `${MODES[view.mode].name} match`, true);
      this.lastQuarter = view.quarter;
    }
    // Phones stack the Chronicle bar under the score strip, whatever height the strip has.
    if (phone()) {
      const h = `${this.board.offsetHeight}px`;
      if (this.root.style.getPropertyValue('--strip-h') !== h) this.root.style.setProperty('--strip-h', h);
    }
  }

  private build(session: Session): void {
    const view = session.view;
    const me = this.host.ui.me;
    const playing = me >= 0;
    // Clock.
    let pace = '';
    if (session.kind === 'solo') {
      pace = `<div class="pace" role="group" aria-label="Speed"><button data-act="pause" title="Pause (Space)" aria-label="Pause">${icon('pause')}</button>${SOLO_SPEEDS.map(
        (v) => `<button data-act="speed" data-v="${v}" title="${v}× speed" aria-label="${v}× speed">${v}×</button>`,
      ).join('')}</div>`;
    } else if (session.kind === 'multi') {
      const host = this.host.isHost();
      const tip = host ? 'Room pace' : 'Host controls match speed';
      pace = `<div class="pace" role="group" aria-label="Room pace" title="${tip}">${HOST_SPEEDS
        .map((v) => `<button data-act="speed" data-v="${v}" title="${host ? `${v}× speed for everyone` : tip}" aria-label="${v}× speed${host ? '' : ' — host controls match speed'}" ${host ? '' : 'disabled'}>${v}×</button>`)
        .join('')}</div>`;
    }
    this.clock.innerHTML = `<span class="wordmark">MERCADIA</span>
      <div class="when">
        <div class="era" data-f="erabox"><b data-f="era"><span data-f="eranum"></span><span class="e-name" data-f="eraname"></span></b><small data-f="eraof"></small>
          <i class="erabar" data-f="erabar" role="progressbar" aria-label="Era progress" aria-valuemin="0" aria-valuemax="100">${ERAS.map((e) => `<u data-e="${e.n}"><s></s></u>`).join('')}</i></div>
        <span data-f="part"></span><i data-f="dial"></i></div>
      ${pace}
      <div class="tools">
        <button class="iconbtn" data-act="fit" title="Fit the district to the screen" aria-label="Fit view">${icon('fit')}</button>
        <button class="iconbtn" data-act="sound" data-f="sound" title="${soundLabel(this.host.audio.muted)}" aria-label="${soundLabel(this.host.audio.muted)}" aria-pressed="${this.host.audio.muted}"></button>
        <button class="iconbtn leave" data-act="leave" data-f="leave" title="Leave the match" aria-label="Leave the match">${icon('leave')}</button>
      </div>`;
    // The Mercadia Chronicle: the active dispatch banner over a collapsible recent feed.
    this.chronicle.innerHTML = `<div class="dispatch" data-f="dispatch">
        <button class="d-main" data-act="focus" data-f="dmain">
          <span class="d-badge" data-f="dbadge"></span>
          <span class="d-body"><span class="d-kicker" data-f="dkicker"></span><span class="d-pill" data-f="dpill"></span><b class="d-head" data-f="dhead"></b></span>
        </button>
        <button class="iconbtn d-toggle" data-act="feed" data-f="dtoggle" aria-expanded="false" aria-controls="cfeed" title="Recent Chronicle" aria-label="Show or hide the recent Chronicle">${icon('chevron')}</button>
        <i class="d-bar" data-f="dbar"></i>
      </div>
      <div class="cfeed" id="cfeed" data-f="cfeed" hidden></div>`;
    this.bannerKey = '';
    this.feedKey = '';
    // Founding Guide.
    this.guide.innerHTML = `<div class="g-obj">${esc(OBJECTIVE)}</div>
      <div class="g-pips" data-f="gpips" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="g-step"><span class="g-n" data-f="gn"></span>
        <div class="g-t"><b data-f="gtitle"></b><span data-f="ghint"></span></div>
        <button class="iconbtn g-x" data-act="dismiss" title="Dismiss the guide" aria-label="Dismiss the Founding Guide">${icon('close')}</button></div>`;
    this.guideKey = '';
    // Leaderboard.
    this.board.innerHTML = `<div class="bhead"><h3>Crown Index</h3>
      <button class="bktoggle" data-act="breakdown" aria-expanded="false" title="Crown Index = Worth (net worth ÷ 10) + Share (market share % × 3) + Prestige (civic prestige × 4). Click to show each House's parts.">Worth + Share + Prestige</button></div>
      <div class="rows">${view.players
      .map(
        (p, i) => `<div class="row${i === me ? ' me' : ''}" data-p="${i}" data-house="${HOUSES[p.house].key}" style="--house:${HOUSES[p.house].color}">
          ${crestSvg(p.house)}
          <span class="nm">${esc(i === me ? 'You' : p.name)}<small>${esc(HOUSES[p.house].short)}</small></span>
          <span class="ini">${esc(initials(p.name, i === me))}</span>
          <span class="stars" data-f="stars"></span>
          <span class="crown" data-f="crown"></span>
          <span class="sub"><span data-f="cash"></span><span data-f="share"></span></span>
          <span class="parts" data-f="parts"></span>
        </div>`,
      )
      .join('')}</div>
      <div class="tug"><div class="lbl"><span>Market share</span><span data-f="lead"></span></div>
      <div class="bar">${view.players.map((p, i) => `<i data-s="${i}" style="background:${HOUSES[p.house].color};width:${100 / view.players.length}%"></i>`).join('')}</div></div>
      <div class="mprog" data-f="mprog" hidden></div>
      <div class="mlist" data-f="mlist"></div>`;
    // Treasury.
    this.treasury.hidden = !playing;
    this.treasury.innerHTML = `<div class="cash"><b data-f="cash"></b><span data-f="trend"></span></div>
      <div class="line"><span>Net worth <b data-f="nw"></b></span><span>Debt <b data-f="debt"></b></span></div>
      <div class="charters" data-f="charters" aria-label="Dynasty Charters"></div>
      <div class="acts">
        <button class="btn" data-act="borrow">Borrow ${money(LOAN_STEP)}<small data-f="rate"></small></button>
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
        return `${i === 6 ? '<span class="sep"></span>' : ''}<button class="tool" data-kind="${k}" data-group="${shop ? 'shops' : 'civic'}" data-era="${ERA_UNLOCK[k]}">
          <span class="key">${i + 1}</span>${shop ? '<span class="want"><i></i><i></i><i></i></span>' : ''}
          <span class="lock" hidden>${icon('lock')}<b>Era ${ERAS[ERA_UNLOCK[k] - 1].roman}</b></span>
          ${icon(k)}<span class="nm">${buildName(k).replace('Pocket ', '').replace('Festival ', '')}</span><span class="cost" data-f="cost">${money(buildCost(k))}</span>
        </button>`;
      }).join('') + '<div class="hint" hidden></div>';
    this.lockState = {};
    this.inspKey = '';
  }

  private syncClock(session: Session): void {
    const view = session.view;
    const q = (n: string): HTMLElement | null => this.clock.querySelector<HTMLElement>(`[data-f="${n}"]`);
    // "Era I · Founding" over a four-segment bar: the eras behind are full, the current one fills.
    const era = view.era;
    const finite = view.totalQuarters > 0 && !view.endless;
    // "Era I" + " · Founding": a phone keeps the numeral and drops the name.
    setText(q('eranum'), eraLabel(view.quarter));
    setText(q('eraname'), ` · ${eraDef(view.quarter).short}`);
    setAttr(q('era'), 'aria-label', eraChip(view.quarter));
    setText(q('eraof'), view.quarter > ERA_COUNT ? `Day ${view.quarter}` : finite ? `of ${ERAS[Math.min(ERA_COUNT, view.totalQuarters) - 1].roman}` : 'Endless');
    const through = view.ended ? 1 : view.inCouncil ? 1 : view.dayPhase;
    const bar = q('erabar');
    if (bar) {
      bar.querySelectorAll<HTMLElement>('u').forEach((u) => {
        const n = Number(u.dataset.e);
        const fill = n < era ? 100 : n === era ? Math.round(through * 100) : 0;
        const inner = u.firstElementChild as HTMLElement;
        if (inner.style.width !== `${fill}%`) inner.style.width = `${fill}%`;
        toggle(u, 'now', n === era);
      });
      setAttr(bar, 'aria-valuenow', String(Math.round(through * 100)));
      setAttr(bar, 'aria-valuetext', `${eraTitle(view.quarter)}, ${Math.round(through * 100)}% through`);
    }
    setAttr(q('erabox'), 'title', `${eraTitle(view.quarter)} — ${eraDef(view.quarter).blurb}`);
    const part = Math.min(3, Math.floor(view.dayPhase * 4));
    setText(q('part'), view.ended ? 'Final bell' : view.inCouncil ? 'Era Council' : DAYPART_NAMES[part]);
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

// ───────────────────────────── The Mercadia Chronicle ─────────────────────────────

  /** Stripe of a dispatch: brass for eras and milestones, canal for city events, else the acting House. */
  private stripe(view: CityView, d: Dispatch): string {
    if (d.cat === 'event') return CANAL;
    if (d.cat === 'rival' || d.cat === 'promo' || d.cat === 'build') {
      const p = view.players[d.player];
      if (p) return HOUSES[p.house].color;
    }
    return BRASS;
  }

  /** The acting House's crest, or the icon of the city event or category. */
  private badge(view: CityView, d: Dispatch): string {
    const p = view.players[d.player];
    if (d.cat === 'event') return icon(d.icon) || icon('ledger');
    if (p) return crestSvg(p.house, { quiet: true });
    return icon(CAT_ICON[d.cat]);
  }

  private syncChronicle(view: CityView): void {
    const now = performance.now();
    const list = view.chronicle;
    const latest = list.length ? list[list.length - 1] : undefined;
    if (!latest || latest.n < this.seenN) {
      // A new match: nothing has been read yet.
      this.seenN = 0;
      this.holdN = 0;
      this.holdUntil = 0;
    }
    if (latest && latest.n > this.seenN) {
      // The newest headline (tier 1) takes the banner and holds it for a few seconds.
      for (let i = list.length - 1; i >= 0 && list[i].n > this.seenN; i--) {
        if (list[i].tier === 1) {
          this.holdN = list[i].n;
          this.holdUntil = now + DISPATCH_HOLD_MS;
          break;
        }
      }
      this.seenN = latest.n;
    }
    const r = (n: string): HTMLElement | null => this.chronicle.querySelector<HTMLElement>(`[data-f="${n}"]`);
    const held = now < this.holdUntil ? list.find((d) => d.n === this.holdN) : undefined;
    const ev = view.event;
    let shown: Dispatch | undefined;
    let key: string;
    let badge: string;
    let kicker: string;
    let head: string;
    let pill = '';
    let tip = '';
    let stripe = BRASS;
    let cat = 'market';
    let tile = -1;
    let mode: 'dispatch' | 'live' | 'forecast' | 'quiet';
    if (!held && ev) {
      // No fresh headline: the banner belongs to the live or forecast city event.
      const def = EVENTS[ev.kind];
      mode = ev.started ? 'live' : 'forecast';
      key = `E|${ev.kind}|${ev.startAt}|${mode}`;
      badge = icon(ev.kind);
      kicker = ev.started ? 'Live · City event' : 'Forecast · City event';
      head = def.title;
      pill = def.pill;
      tip = `${def.effect}\n${ev.started ? def.headline : def.forecast}`;
      stripe = CANAL;
      cat = 'event';
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].cat === 'event' && list[i].icon === ev.kind) {
          tile = list[i].tile;
          break;
        }
      }
    } else {
      shown = held ?? latest;
      if (shown) {
        mode = 'dispatch';
        key = `D|${shown.n}|${shown.tick}`;
        badge = this.badge(view, shown);
        kicker = CAT_LABEL[shown.cat];
        head = shown.head;
        pill = shown.pill;
        tip = shown.pill ? `${shown.head} — ${shown.pill}` : shown.head;
        stripe = this.stripe(view, shown);
        cat = shown.cat;
        tile = shown.tile;
      } else {
        mode = 'quiet';
        key = 'Q';
        badge = icon('ledger');
        kicker = 'The Mercadia Chronicle';
        head = 'All quiet along the canal.';
      }
    }
    const box = r('dispatch');
    const main = r('dmain');
    if (key !== this.bannerKey && box && main) {
      this.bannerKey = key;
      setHtml(r('dbadge'), badge);
      setText(r('dkicker'), kicker);
      setText(r('dhead'), head);
      const pillEl = r('dpill');
      setText(pillEl, pill);
      if (pillEl) pillEl.hidden = !pill;
      box.dataset.cat = cat;
      box.dataset.mode = mode;
      box.dataset.n = shown ? String(shown.n) : '';
      box.style.setProperty('--stripe', stripe);
      if (tile >= 0) main.dataset.tile = String(tile);
      else delete main.dataset.tile;
      toggle(main, 'focusable', tile >= 0);
      setAttr(main, 'title', tile >= 0 && !phone() ? `${tip}\nClick to show it on the map` : tip);
      setAttr(main, 'aria-label', `${kicker}: ${head}${pill ? ` — ${pill}` : ''}`);
    }
    // The city event's countdown rides along the bottom edge whenever one is forecast or live.
    let pct = 0;
    if (ev) pct = ev.started ? 100 * (1 - (view.tick - ev.startAt) / Math.max(1, ev.endAt - ev.startAt)) : 100 * ((view.tick - ev.announceAt) / Math.max(1, ev.startAt - ev.announceAt));
    const bar = r('dbar');
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
      toggle(bar, 'forecast', !!ev && !ev.started);
    }
    // Recent feed: the latest dispatches, newest first, minus the one already in the banner.
    const exclude = mode === 'dispatch' && shown ? shown.n : -1;
    const recent = list.filter((d) => d.n !== exclude).slice(phone() ? -4 : -3).reverse();
    const feed = r('cfeed');
    const feedKey = `${exclude}|${recent.map((d) => d.n).join(',')}|${view.seed}|${view.players.map((p) => p.house).join('')}`;
    if (feed && feedKey !== this.feedKey) {
      this.feedKey = feedKey;
      feed.innerHTML = recent
        .map((d) => {
          const focusable = d.tile >= 0;
          const tag = focusable ? 'button' : 'div';
          const attrs = focusable ? ` data-act="focus" data-tile="${d.tile}" title="Show on the map" aria-label="${esc(d.head)}${d.pill ? ` — ${esc(d.pill)}` : ''}. Show on the map"` : '';
          return `<${tag} class="cline${focusable ? ' focusable' : ''}" data-n="${d.n}" data-cat="${d.cat}"${attrs} style="--stripe:${this.stripe(view, d)}"><span class="c-badge">${this.badge(view, d)}</span><span class="c-head">${esc(d.head)}</span>${d.pill ? `<span class="c-pill">${esc(d.pill)}</span>` : ''}${focusable ? `<span class="c-focus">${icon('focus')}</span>` : ''}</${tag}>`;
        })
        .join('');
    }
    // Until the player chooses, the feed opens itself only where there is room: on a wide
    // desktop once the Founding Guide has retired.
    if (!this.feedChosen) this.feedOpen = !phone() && window.innerWidth >= 1280 && !this.guideActive;
    const open = this.feedOpen && recent.length > 0;
    if (feed && feed.hidden === open) feed.hidden = !open;
    toggle(this.chronicle, 'open', open);
    const tg = r('dtoggle');
    setAttr(tg, 'aria-expanded', String(open));
    if (tg) (tg as HTMLButtonElement).disabled = recent.length === 0;
  }

  // ───────────────────────────── Founding Guide ─────────────────────────────

  /** The guide is finished or dismissed: it never comes back, in this match or the next. */
  private retireGuide(): void {
    this.guideDone = true;
    store(GUIDE_KEY, 'done');
    this.guideNow = null;
    if (!this.guide.hidden) this.guide.hidden = true;
    this.host.ui.guideLots = [];
  }

  private syncGuide(session: Session): void {
    const view = session.view;
    const ui = this.host.ui;
    const me = view.players[ui.me];
    if (!me || session.kind === 'attract' || this.guideDone || view.ended) {
      if (!this.guide.hidden) this.guide.hidden = true;
      this.guideNow = null;
      if (ui.guideLots && ui.guideLots.length) ui.guideLots = [];
      return;
    }
    const owned = view.buildings.filter((b) => b.owner === ui.me);
    const g = guideState({ owned, inspected: this.inspected, stars: starsOf(me), dismissed: false });
    // Done — or the Founding era is over and the first Era Council has convened: the opening
    // it was guiding is behind the player either way.
    if (g.step === 0 || view.quarter > 1 || view.inCouncil) {
      this.retireGuide();
      return;
    }
    this.guideNow = g;
    if (this.guide.hidden) this.guide.hidden = false;
    const slim = phone();
    const key = `${g.step}|${g.done.join('')}|${slim ? 1 : 0}`;
    if (key !== this.guideKey) {
      this.guideKey = key;
      const q = (n: string): HTMLElement | null => this.guide.querySelector<HTMLElement>(`[data-f="${n}"]`);
      this.guide.dataset.step = String(g.step);
      setText(q('gn'), String(g.step));
      setText(q('gtitle'), g.title);
      // On a phone the guide is one slim line: the title carries it, with a few words of how.
      setText(q('ghint'), slim ? PHONE_HINTS[g.step - 1] : g.hint);
      q('gpips')?.querySelectorAll('i').forEach((el, i) => {
        toggle(el, 'done', g.done[i]);
        toggle(el, 'now', i === g.step - 1);
      });
      setAttr(this.guide, 'aria-label', `Founding Guide, step ${g.step} of 3: ${g.title}`);
    }
    // Step 1 rings the prime starter corners on the map; the rings follow the foot traffic.
    if (g.step === 1) {
      const now = performance.now();
      if (!ui.guideLots || !ui.guideLots.length || now - this.guideLotsAt > 4000) {
        ui.guideLots = starterLots(view);
        this.guideLotsAt = now;
      } else if (ui.guideLots.some((t) => view.buildingAt(t))) ui.guideLots = ui.guideLots.filter((t) => !view.buildingAt(t));
    } else if (ui.guideLots && ui.guideLots.length) ui.guideLots = [];
  }

  // ───────────────────────────── Era Council ─────────────────────────────

  private syncCouncil(session: Session): void {
    const view = session.view;
    const c = view.council;
    if (!view.inCouncil || !c || view.ended) {
      if (!this.council.hidden) this.council.hidden = true;
      this.councilKey = '';
      return;
    }
    const me = this.host.ui.me;
    const solo = session.kind !== 'multi';
    const key = `${view.seed}|${c.era}|${me}|${session.kind}`;
    if (key !== this.councilKey) {
      this.councilKey = key;
      this.council.innerHTML = this.councilHtml(view, me, solo);
      this.council.hidden = false;
      // Focus the dialog itself, never a charter: a stray Enter must not seal a choice.
      this.council.querySelector<HTMLElement>('.council')?.focus({ preventScroll: true });
    }
    const mine = me >= 0 ? (c.picks[me] ?? null) : null;
    this.council.querySelectorAll<HTMLElement>('.charter').forEach((el) => {
      const on = el.dataset.key === mine;
      toggle(el, 'sealed', on);
      setAttr(el, 'aria-pressed', String(on));
    });
    this.council.querySelectorAll<HTMLElement>('.srow').forEach((row) => {
      const id = Number(row.dataset.p);
      const pick = c.picks[id] ?? null;
      const el = row.querySelector<HTMLElement>('[data-f="pick"]');
      setHtml(el, pick ? `${icon('seal')}<b>${CHARTERS[pick].name}</b>` : '<em>deliberating…</em>');
      toggle(el, 'sealed', !!pick);
      if (el) el.dataset.key = pick ?? '';
    });
    const adv = this.council.querySelector<HTMLButtonElement>('[data-act="advance"]');
    if (adv) adv.disabled = me >= 0 && mine === null;
    const note = this.council.querySelector<HTMLElement>('[data-f="cnote"]');
    if (solo) setText(note, mine ? `${CHARTERS[mine].name} sealed. You may still change your mind before advancing.` : 'Choose one charter to advance. It is permanent.');
    else {
      const secs = Math.max(0, Math.ceil(c.left / 10));
      setText(this.council.querySelector('[data-f="countdown"]'), `${secs}s`);
      const fill = this.council.querySelector<HTMLElement>('[data-f="cdbar"]');
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, (c.left / Math.max(1, c.total)) * 100)).toFixed(1)}%`;
      const waiting = view.players.filter((p, i) => p.kind === 'human' && (c.picks[i] ?? null) === null).length;
      setText(
        note,
        me < 0
          ? 'The Houses are choosing their charters.'
          : mine
            ? waiting > 0
              ? `${CHARTERS[mine].name} sealed. Waiting for ${waiting} more House${waiting === 1 ? '' : 's'}…`
              : 'Every House has chosen. The next era begins.'
            : 'Choose before the countdown ends, or your steward chooses for you.',
      );
    }
  }

  private councilHtml(view: CityView, me: number, solo: boolean): string {
    const c = view.council;
    if (!c) return '';
    const nextQ = c.era + 1;
    const who = (id: number): string => esc(id === me ? 'You' : (view.players[id]?.name ?? ''));
    const meP = view.players[me];
    const unlocks = c.unlocked
      .map((k) => `<span class="unlock" data-kind="${k}">${icon(k)}<b>${buildName(k)}</b><small>${money(buildCostFor(meP, k))}</small></span>`)
      .concat(c.level3 ? [`<span class="unlock" data-kind="level3">${icon('level3')}<b>Level 3</b><small>grand architecture</small></span>`] : [])
      .join('');
    const rows = c.rows
      .map((r, i) => {
        const p = view.players[r.player];
        if (!p) return '';
        return `<div class="srow${r.player === me ? ' me' : ''}" data-p="${r.player}">
          <span class="rk">${i + 1}</span>${crestSvg(p.house)}
          <span class="nm">${who(r.player)}<small>${esc(HOUSES[p.house].short)}</small></span>
          <span class="cr" title="Crown Index at the close of ${eraLabel(c.era)}">${r.crown}</span>
          <span class="dl${r.delta > 0 ? ' up' : r.delta < 0 ? ' down' : ''}" title="Crown gained during ${eraLabel(c.era)}">${r.delta >= 0 ? '+' : '−'}${Math.abs(r.delta)}</span>
          <span class="pick" data-f="pick"></span></div>`;
      })
      .join('');
    const offers = me >= 0 ? (c.offers[me] ?? []) : [];
    const cards = offers
      .map((k) => {
        const d = CHARTERS[k];
        return `<button class="charter" data-act="charter" data-key="${k}" aria-pressed="false" aria-label="${d.name} — ${d.doctrine}. ${d.pill}">
          <span class="ch-top"><span class="ch-ic">${icon(k)}</span><span class="ch-doc">${d.doctrine}</span><span class="ch-seal">${icon('seal')}Sealed</span></span>
          <b class="ch-name">${d.name}</b>
          <span class="ch-blurb">${d.blurb}</span>
          <span class="ch-pill">${d.pill}</span></button>`;
      })
      .join('');
    const held = meP && meP.charters.length ? `<span class="held">Already held: ${meP.charters.map((k) => CHARTERS[k].name).join(' · ')}</span>` : '';
    const foot = solo
      ? `<button class="btn primary big" data-act="advance" disabled>Advance to ${eraLabel(nextQ)}</button><span class="c-note" data-f="cnote"></span>`
      : `<div class="countdown" title="The room advances when the countdown ends, or as soon as every connected player has chosen"><b class="mono" data-f="countdown"></b><i class="cd"><u data-f="cdbar"></u></i></div><span class="c-note" data-f="cnote"></span>`;
    return `<div class="council" role="dialog" aria-modal="true" aria-label="Era Council: ${eraTitle(nextQ)}" tabindex="-1" data-era="${c.era}" data-next="${c.next}">
      <header class="c-head">
        <span class="kicker">Era Council · ${eraLabel(c.era)} closes</span>
        <h2>${eraTitle(nextQ)}</h2>
        <p>${eraDef(nextQ).blurb}</p>
      </header>
      <section class="c-unlocks"><h3>Unlocked for ${eraLabel(nextQ)}</h3>
        <div class="ulist">${unlocks || '<span class="unlock none">Full district maturity · peak civic stakes · the final Crown reckoning</span>'}</div></section>
      <section class="c-stand"><h3>${eraLabel(c.era)} standings · Crown Index</h3><div class="srows">${rows}</div></section>
      ${
        me >= 0
          ? `<section class="c-charters"><h3>Adopt one Dynasty Charter <small>permanent</small>${held}</h3><div class="cgrid">${cards}</div></section>`
          : ''
      }
      <footer class="c-foot">${foot}</footer></div>`;
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
      setHtml(row.querySelector('[data-f="stars"]'), starPips(starsOf(p)));
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
    // Dynasty strip: the local player's next Milestone, and all four when the breakdown is open.
    const meP = view.players[this.host.ui.me];
    const mp = this.board.querySelector<HTMLElement>('[data-f="mprog"]');
    const ml = this.board.querySelector<HTMLElement>('[data-f="mlist"]');
    if (!mp || !ml) return;
    if (!meP) {
      mp.hidden = true;
      setHtml(ml, '');
      return;
    }
    const rows = milestoneProgress(view, meP);
    const next = rows.find((m) => !m.done);
    mp.hidden = false;
    setHtml(
      mp,
      next
        ? `${icon('star')}<b>${next.name}</b><span class="mp-r">${next.pill}</span><span class="mp-l2"><i class="mp-bar"><u style="width:${Math.round(next.progress * 100)}%"></u></i><span class="mp-d">${next.detail}</span></span>`
        : `${icon('star')}<b>All four Milestones earned</b><span class="mp-r">★4</span>`,
    );
    setAttr(mp, 'title', next ? `Next Dynasty Milestone: ${next.name} — ${next.goal}. Reward: ${next.pill}` : 'Charter Merchant, Block Baron, Civic Benefactor and District Sovereign: all earned');
    toggle(mp, 'all', !next);
    // A long name beside a long reward (Civic Benefactor · +§120 · +4 Prestige) sets a touch tighter
    // so neither is cut short.
    toggle(mp, 'tight', !!next && next.name.length + next.pill.length > 30);
    setHtml(
      ml,
      rows.map((m) => `<div class="ml${m.done ? ' done' : ''}" title="${esc(m.goal)} — ${esc(m.pill)}">${icon(m.done ? 'check' : 'star')}<b>${m.name}</b><span>${m.done ? m.pill : m.detail}</span></div>`).join(''),
    );
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
    setText(trend, `${net >= 0 ? '+' : '−'}§${Math.abs(Math.round(net)).toLocaleString('en-US')} this era`);
    toggle(trend, 'up', net > 0);
    toggle(trend, 'down', net < 0);
    setText(q('nw'), money(me.netWorth));
    setText(q('debt'), me.debt > 0 ? `${money(me.debt)}/${money(LOAN_MAX)}` : 'None');
    const borrow = this.treasury.querySelector<HTMLButtonElement>('[data-act="borrow"]');
    const repay = this.treasury.querySelector<HTMLButtonElement>('[data-act="repay"]');
    // The exact per-era rate rides on the Borrow button (halved under Merchant Credit).
    const rate = loanRateFor(view.quarterTicks, me);
    setText(q('rate'), ` · ${rate}`);
    setAttr(borrow, 'aria-label', `Borrow ${money(LOAN_STEP)} at ${rate}`);
    setAttr(
      borrow,
      'title',
      `Emergency Credit Line: borrow ${money(LOAN_STEP)} (limit ${money(LOAN_MAX)}). Interest is ${(LOAN_RATE * charterMod(me, 'interest') * 100).toFixed(1)}% of your debt at every payroll (10 s) — ${rate}.`,
    );
    // Dynasty Charters adopted at the Era Councils.
    const badges = q('charters');
    setHtml(badges, me.charters.map((k) => `<span class="cbadge" data-key="${k}" title="${CHARTERS[k].name} — ${CHARTERS[k].pill}">${icon(k)}<b>${CHARTER_SHORT[k]}</b></span>`).join(''));
    if (badges && badges.hidden !== (me.charters.length === 0)) badges.hidden = me.charters.length === 0;
    setAttr(this.treasury, 'title', me.charters.length ? '' : `Dynasty Charters are adopted at the Era Council${view.era < ERA_COUNT ? `, after ${eraLabel(view.quarter)}` : ''}.`);
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
      const locked = !isUnlocked(k, view.quarter);
      const cost = buildCostFor(me, k);
      toggle(btn, 'on', this.host.ui.tool === k);
      toggle(btn, 'poor', !locked && me.cash < cost);
      // Future-era tools stay on the dock under an Era lock badge, and shimmer as they unlock.
      toggle(btn, 'locked', locked);
      if (locked) setAttr(btn, 'data-locked', String(ERA_UNLOCK[k]));
      else if (btn.hasAttribute('data-locked')) btn.removeAttribute('data-locked');
      const lock = btn.querySelector<HTMLElement>('.lock');
      if (lock && lock.hidden === locked) lock.hidden = !locked;
      setAttr(btn, 'title', locked ? `${lockNotice(k)}\n${toolTooltip(k)}` : toolTooltip(k));
      setAttr(btn, 'aria-label', locked ? `${buildName(k)}, locked: ${lockNotice(k)}` : `${buildName(k)}, ${money(cost)}`);
      setText(btn.querySelector('[data-f="cost"]'), money(cost));
      if (this.lockState[k] === true && !locked) {
        btn.classList.add('unlocked');
        window.setTimeout(() => btn.classList.remove('unlocked'), 3200);
      }
      this.lockState[k] = locked;
      // Founding Guide, step 1: the two Era I shops are pointed out.
      toggle(btn, 'guided', !!this.guideNow && this.guideNow.step === 1 && (k === 'roastery' || k === 'bistro') && this.host.ui.tool === null);
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
    if (!isUnlocked(k, view.quarter)) extra = `<em>${icon('lock')}Unlocks in Era ${ERAS[ERA_UNLOCK[k] - 1].roman}: ${ERAS[ERA_UNLOCK[k] - 1].name}</em>`;
    else if (this.host.ui.tool === k) extra = k === 'tramstop' ? '<em>Place along the tramway avenue · Esc cancels</em>' : '<em>Click a green lot · Esc cancels</em>';
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
    // Founding Guide, step 2: the player has opened one of their own shops.
    if (mine && b && isShop(b.kind)) this.inspected = true;
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
    const owner = view.players[b.owner];
    setText(r.costs, `${money((wageOf(b, owner) + rentOf(b, view.event?.started === true && view.event.kind === 'renthike')) * 6)}`);
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
        setAttr(up, 'data-state', 'max');
      } else if (b.level === 2 && view.era < LEVEL3_ERA) {
        // Grand architecture waits for the Grand Boulevard.
        up.disabled = true;
        setHtml(up, `${icon('lock')}${LEVEL3_NOTICE}`);
        setAttr(up, 'data-state', 'locked');
      } else {
        const c = upgradeCost(b, owner);
        up.disabled = cash < c || view.ended;
        setHtml(up, `Upgrade to Lv ${b.level + 1}<span class="cost">${money(c)}</span>`);
        setAttr(up, 'data-state', 'open');
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
        meter.style.width = `${(1 - (b.promoReadyAt - view.tick) / promoCooldownFor(owner)) * 100}%`;
      } else {
        promo.disabled = cash < promoCostFor(owner) || view.ended;
        setHtml(promo, `Promo Blitz · 20s<span class="cost">${money(promoCostFor(owner))}</span>`);
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
      const c = restockCost(view, b, false, owner);
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
    const ownerName = mine ? `Your property · ${house.name}` : owner ? `${esc(owner.name)} · ${house.name}` : '';
    const head = `<div class="head owned" style="--house:${house.color}">${owner ? crestSvg(owner.house) : ''}<div class="t"><b>${icon(b.kind)}${buildName(b.kind)}${isShop(b.kind) ? ` <span class="mono" style="display:inline;font-size:11px;color:var(--ink-3)">Lv ${b.level}</span>` : ''}</b>
      <span>${ownerName}</span></div>${close}</div>`;
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
      ([k, label, sign], i) => `<tr class="${i === 4 || i === 9 ? 'sep' : ''}" data-k="${k}"><td>${label}</td>${cell(lg.cur[k], sign)}${cell(lg.last[k], sign)}${cell(lg.total[k], sign)}</tr>`,
    ).join('');
    setHtml(
      this.ledger.querySelector('[data-f="body"]'),
      `<table><thead><tr><th></th><th>This era</th><th>Last era</th><th>Match</th></tr></thead><tbody>${rows}
       <tr class="net"><td>Net cashflow</td>${net(lg.cur)}${net(lg.last)}${net(lg.total)}</tr>
       <tr class="fin"><td colspan="4">Financing</td></tr>
       <tr><td>Loan draws</td>${cell(lg.cur.borrowed, 1)}${cell(lg.last.borrowed, 1)}${cell(lg.total.borrowed, 1)}</tr>
       <tr><td>Loan repayments</td>${cell(lg.cur.repaid, -1)}${cell(lg.last.repaid, -1)}${cell(lg.total.repaid, -1)}</tr>
       <tr class="net"><td>Change in cash</td>${change(lg.cur)}${change(lg.last)}${change(lg.total)}</tr></tbody></table>
       <p class="recon">Opening ${money(START_CASH)} + match change = <b>${money(START_CASH + ledgerCashChange(lg.total))}</b> in hand${me && me.debt > 0 ? ` · ${money(me.debt)} owed at ${loanRateFor(view.quarterTicks, me)}` : ''}</p>`,
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
          <td><span class="rk">${i + 1}</span>${crestSvg(p.house, { gilded: (r.stars ?? 0) >= MILESTONES.length })}${who(r.player)}<small>${p.kind === 'ai' && p.persona ? AI_PERSONAS[p.persona].title : HOUSES[p.house].short}</small>${starPips(r.stars ?? 0)}
            <em>${money(r.revenue)} revenue · ${r.served} served · ${r.shops} shop${r.shops === 1 ? '' : 's'} + ${r.civic} civic</em>
            ${(r.charters ?? []).length ? `<em class="chs">${(r.charters ?? []).map((k) => CHARTERS[k].name).join(' · ')}</em>` : ''}</td>
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
        return `<div class="award"><div class="a-title">${icon(awardIcon[k])}${title}</div><div class="a-who">${crestSvg(p.house, { quiet: true })}${who(a.player)}</div><div class="a-detail">${esc(a.detail)}</div></div>`;
      })
      .join('');
    const canDecide = session.kind === 'solo' || this.host.isHost();
    const headline = res.winner === me ? 'The district is yours.' : `${house.name} takes the district.`;
    const quarters = view.endless ? `${eraLabel(view.quarter)}${view.quarter > ERA_COUNT ? ` · Day ${view.quarter}` : ''}` : `${view.totalQuarters} eras`;
    return `<div class="victory edition" role="dialog" aria-modal="true" aria-label="Mercadia Gazette, Final Edition: match summary" tabindex="-1">
      <header class="masthead">
        <span class="m-side">Final Edition</span>
        <span class="m-name">The Mercadia Gazette</span>
        <span class="m-side r">${MODES[view.mode].name} · ${quarters}</span>
      </header>
      <div class="front">
        ${grandCrest(win.house)}
        <div class="story">
          <div class="kicker">Closing bell · ${esc(house.name)} · ${house.crestName}</div>
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
          <h3>Market share, era by era</h3>
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
    // Roman numerals for the four eras; Endless days past the fourth are numbered.
    const eraName = (q: number): string => (q <= ERA_COUNT ? ERAS[q - 1].roman : `D${q}`);
    // Era gridlines and labels.
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
      if ((q - 1) % every === 0) grid += `<text x="${f((x0 + x1) / 2)}" y="${H - 6}" text-anchor="middle" class="ax">${eraName(q0 + q)}</text>`;
      const shares = view.players.map((p, i) => `${i === me ? 'You' : p.name} ${Math.round((samples[end][i] ?? 0) / 10)}%`).join(' · ');
      grid += `<rect x="${f(x0)}" y="${T}" width="${f(Math.max(1, x1 - x0))}" height="${ph}" class="hit"><title>Close of ${q0 + q <= ERA_COUNT ? eraLabel(q0 + q) : `Day ${q0 + q}`}: ${esc(shares)}</title></rect>`;
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
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Market share by era for each House">${yaxis}${grid}${lines}${dots}</svg>
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
      const cost = buildCostFor(me, ui.tool);
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
      // Never let the card ride up into the clock, the Chronicle banner or the score strip:
      // when there is no room above the citizen, it docks below them instead. (On a phone the
      // Chronicle bar sits under the strip; on a mid-size screen it wraps under the clock.)
      const bannerBottom = this.chronicle.querySelector('.dispatch')?.getBoundingClientRect().bottom ?? 0;
      const safeTop = Math.max(phone() ? this.board.getBoundingClientRect().bottom : this.clock.getBoundingClientRect().bottom, bannerBottom) + 6;
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

/** The three match lengths as the Title and the Lobby offer them. */
const MODE_SEG: [MatchMode, string, string][] = [
  ['blitz', 'Blitz', '4 brisk eras'],
  ['standard', 'Standard', '4 eras'],
  ['endless', 'Endless', 'past Era IV'],
];

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
      <p class="tag" style="margin:0">Rival merchant dynasties reshape a sunlit canal-and-tramway city era by era.</p>
      <div class="solo">
        <button class="btn primary big wide" data-act="solo">Play Solo Now</button>
        <p class="objective">${esc(OBJECTIVE)}</p>
        <div class="opts">
          <label>Rivals</label>${seg('rivals', [['1', '1 AI'], ['2', '2 AI'], ['3', '3 AI']], String(this.rivals))}
          <label>Length</label>${seg('mode', MODE_SEG, this.mode)}
        </div>
        <p class="modeblurb" data-f="modeblurb">${MODES[this.mode].blurb}</p>
        <div class="rivals">${personas
          .map((p, i) => `<div class="rival${i < this.rivals ? '' : ' off'}">${crestSvg(i + 1, { quiet: true })}<b>${AI_PERSONAS[p].name}</b><span>${AI_PERSONAS[p].title}</span></div>`)
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
          right = `<div class="houses" role="group" aria-label="House">${HOUSES.map(
            (hh, k) => `<button data-act="house" data-v="${k}" class="${k === s.house ? 'on' : ''}" title="${hh.name} — ${hh.crestName}" aria-label="${hh.name}, ${hh.crestName}" aria-pressed="${k === s.house}" ${taken.has(k) ? 'disabled' : ''}>${crestSvg(k, { quiet: true })}</button>`,
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
        return `<div class="seat${me ? ' me' : ''}${s.kind === 'open' ? ' open' : ''}">${s.kind === 'open' ? '<i class="sw" style="background:transparent;box-shadow:inset 0 0 0 1px var(--hair)"></i>' : crestSvg(s.house)}<div class="who">${who}</div><div class="right">${right}</div></div>`;
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
    const modes = MODE_SEG;
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
      <p class="modeblurb">${MODES[lobby.mode].blurb} · Era Councils between eras</p>
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
