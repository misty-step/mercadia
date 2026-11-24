// The in-match HUD (DOM): Turn plate, Status line, Leaderboard, Chronicle, Founding Guide, Command
// rail (Treasury, Order dock, End Turn), and the right drawers (Inspector, Orders, Turn Delta).
// It reads the SessionView, drives the Board's BoardState, and sends orders through the Session.
//
// Conventions: every surface is rendered to an escaped HTML string and morphed into the DOM
// (hud-dom.ts); interactivity is delegated from the HUD root through `data-act` attributes, so
// there are no inline handlers or inline styles (CSP `style-src 'self'`).
import { CITY } from '../shared/map';
import { buildingAt, currentEra, tileName, unitById } from '../shared/game';
import { SHOPS, CIVICS, isShop } from '../shared/constants';
import { checkOrder, describeOrder } from '../shared/orders';
import type { Order } from '../shared/types';
import type { Armed, BoardApi, BoardState, Hit, Session, SessionView } from './contracts';
import { crestSvg } from './heraldry';
import { esc, patch } from './hud-dom';
import { deltaModel } from './hud-delta';
import { ic } from './hud-icons';
import { EndGuard, classifyFocus, keyCommand, stepCursor } from './hud-input';
import { inspectorModel } from './hud-inspector';
import {
  chronicleHtml,
  guideHtml,
  leaderboardHtml,
  ordersHtml,
  plateHtml,
  railHtml,
  spectatorHtml,
  statusHtml,
  type GuideModel,
} from './hud-panels';
import { TABS, armedHint, legalTilesFor, orderForPick, pickReason, toolsFor, type Pending, type TabKey, type Tool } from './hud-tools';

export interface HudSound {
  tap(): void;
  undo(): void;
  seal(): void;
  bell(): void;
  era(): void;
  charter(): void;
  rustle(): void;
  muted: boolean;
  toggleMute(): void;
}

export interface HudOptions {
  root: HTMLElement;
  session: Session;
  board: BoardApi;
  sound: HudSound;
  canvas: HTMLCanvasElement;
  /** Called when the player presses Leave (the caller shows its confirmation); defaults to `session.leave()`. */
  onLeave?: () => void;
}

export interface Hud {
  destroy(): void;
  openTurnDelta(): void;
  inspectTile(tile: number): void;
}

type DrawerKind = 'inspector' | 'orders' | 'delta';

const GUIDE_KEY = 'mercadia:guide:v3';
const PAN_STEP = 72;
const SKELETON = `<div class="hud-shell">
  <div class="hud-top">
    <div class="slot-left"><div id="h-plate"></div><div id="h-chron"></div><div id="h-guide"></div></div>
    <div id="h-status" class="slot-status"></div>
    <div class="slot-right">
      <div id="h-lb"></div>
      <aside id="h-drawer" class="drawer" data-panel tabindex="-1" aria-labelledby="h-dh" inert>
        <div class="grab" data-grab aria-hidden="true"><span></span></div>
        <header class="d-head"><div class="d-title" id="h-dtitle"></div><button type="button" class="d-close" data-act="close" aria-label="Close drawer">${ic('close')}<span>Close</span></button></header>
        <div class="d-nav" id="h-dnav"></div>
        <div class="d-body" id="h-dbody"></div>
      </aside>
    </div>
  </div>
  <div id="h-rail" class="slot-rail"></div>
  <div id="h-say" class="sr-only" role="status" aria-live="polite"></div>
</div>`;

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function createHud(opts: HudOptions): Hud {
  const { root, session, board, sound, canvas } = opts;
  root.innerHTML = SKELETON;
  root.classList.add('hud');
  const $ = (id: string): HTMLElement => root.querySelector<HTMLElement>(`#${id}`) as HTMLElement;
  const elPlate = $('h-plate');
  const elStatus = $('h-status');
  const elChron = $('h-chron');
  const elGuide = $('h-guide');
  const elLb = $('h-lb');
  const elDrawer = $('h-drawer');
  const elDTitle = $('h-dtitle');
  const elDNav = $('h-dnav');
  const elDBody = $('h-dbody');
  const elRail = $('h-rail');
  const elSay = $('h-say');
  const elToasts = document.getElementById('toasts');
  const closeBtn = elDrawer.querySelector<HTMLButtonElement>('.d-close') as HTMLButtonElement;

  // ───────────────────────────── UI state ─────────────────────────────

  const ui = {
    tab: 'build' as TabKey,
    armed: null as Armed,
    pending: null as Pending,
    implicit: false,
    selTile: -1,
    selUnit: 0,
    preview: -1,
    hover: -1,
    cursor: -1,
    boardFocus: false,
    drawer: null as DrawerKind | null,
    deltaIndex: -1,
    showAll: new Set<string>(),
    markers: false,
    lbOpen: false,
    lbDetail: false,
    chronOpen: false,
    err: '',
    touch: false,
    opener: null as HTMLElement | null,
  };

  let v: SessionView = session.view;
  let lastRes = v.resolutions;
  let lastSeat = v.seat;
  let lastEra = currentEra(v.game);
  let lastDraft: Order[] = v.draft;
  let lastEnded = v.ended;
  let lastHandoff = !!v.handoff;
  let lastPruned = '';
  let lastTurn = v.game.turn;
  let guideStored = storage()?.getItem(GUIDE_KEY) === '1';
  let destroyed = false;
  const guard = new EndGuard(400);

  const markGuideDone = (): void => {
    guideStored = true;
    try {
      storage()?.setItem(GUIDE_KEY, '1');
    } catch {
      /* storage may be unavailable; the guide then retires for this session only */
    }
  };

  // ───────────────────────────── Toasts ─────────────────────────────

  const toastEls = new Map<number, HTMLElement>();
  function makeToast(text: string, tone: 'info' | 'error', sticky: boolean, ttl = 5200): HTMLElement | null {
    if (!elToasts) return null;
    const el = document.createElement('div');
    el.className = `toast tone-${tone}`;
    el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    const rule = document.createElement('span');
    rule.className = 'rule';
    rule.setAttribute('aria-hidden', 'true');
    const tx = document.createElement('span');
    tx.className = 'tt';
    tx.textContent = text;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'tx';
    x.setAttribute('aria-label', 'Dismiss message');
    x.textContent = '×';
    x.addEventListener('click', () => el.remove());
    el.append(rule, tx, x);
    elToasts.append(el);
    while (elToasts.children.length > 4) elToasts.firstElementChild?.remove();
    if (!sticky) window.setTimeout(() => el.remove(), ttl);
    return el;
  }
  const toast = (text: string, tone: 'info' | 'error' = 'info'): void => {
    // De-duplicate an identical toast already on screen.
    if (elToasts && Array.from(elToasts.querySelectorAll('.tt')).some((n) => n.textContent === text)) return;
    makeToast(text, tone, false);
  };

  function syncNotices(): void {
    const ids = new Set(v.notices.map((n) => n.id));
    for (const [id, el] of toastEls) {
      if (!ids.has(id)) {
        el.remove();
        toastEls.delete(id);
      }
    }
    for (const n of v.notices) {
      if (toastEls.has(n.id)) continue;
      const el = makeToast(n.text, n.tone, n.tone === 'error');
      if (el) toastEls.set(n.id, el);
      if (n.tone !== 'error') window.setTimeout(() => toastEls.delete(n.id), 5400);
    }
    if (v.pruned && (v.pruned !== lastPruned || v.draft.length !== lastDraft.length)) toast(v.pruned);
    lastPruned = v.pruned;
  }

  // ───────────────────────────── Helpers ─────────────────────────────

  const hasModal = (): boolean => !!document.querySelector('[data-modal]:not([hidden])');
  const mobile = (): boolean => window.matchMedia('(max-width: 720px)').matches;
  const ownUnit = (id: number) => {
    const u = id ? unitById(v.game, id) : undefined;
    return u && u.owner === v.seat ? u : undefined;
  };
  const toolCtx = () => ({ view: v, armed: ui.armed, pending: ui.pending, selUnit: ui.selUnit });
  const allTools = (): Tool[] => TABS.flatMap((t) => toolsFor(t.key, toolCtx()));
  const say = (text: string): void => {
    if (elSay.textContent !== text) elSay.textContent = text;
  };

  function disarm(): void {
    ui.armed = null;
    ui.pending = null;
    ui.implicit = false;
    ui.preview = -1;
  }

  function resetSelection(): void {
    disarm();
    ui.selTile = -1;
    ui.selUnit = 0;
    ui.err = '';
  }

  function firstLegal(): number {
    const legal = legalTilesFor(v, ui.armed, ui.pending);
    for (const t of legal) return t;
    return -1;
  }

  // ───────────────────────────── Founding Guide ─────────────────────────────

  function guideModel(): GuideModel | null {
    if (guideStored) return null;
    if (v.game.turn > 1 || v.ended) {
      markGuideDone();
      return null;
    }
    if (v.seat < 0 || !v.plan || v.handoff) return null;
    const moved = v.draft.some((o) => o.t === 'move');
    const built = v.draft.some((o) => o.t === 'build') || v.game.buildings.some((b) => b.owner === v.seat);
    const steps = [
      { label: 'Move your Factor', hint: 'Select it, then pick a shaded tile.', done: moved },
      { label: 'Found a shop', hint: 'Choose Roastery in Build, then a marked lot.', done: built },
      { label: 'End your turn', hint: 'Press End Turn when your plan is set.', done: false },
    ];
    let best = -1;
    let bestScore = -1e9;
    const plan = v.plan;
    const factor = v.game.units.find((u) => u.owner === v.seat && u.kind === 'factor');
    const at = factor ? plan.tiles.get(factor.id) ?? factor.tile : -1;
    for (const t of CITY.lots) {
      if (checkOrder(v.game, plan, { t: 'build', tile: t, kind: 'roastery' })) continue;
      const d = at >= 0 ? Math.max(Math.abs((t % 12) - (at % 12)), Math.abs(Math.floor(t / 12) - Math.floor(at / 12))) : 3;
      const score = (CITY.corner[t] ? 2 : 0) + (CITY.avenueAdj[t] >= 0 ? 1 : 0) + (CITY.canalFront[t] ? 0.5 : 0) - d * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    const current = steps.findIndex((s) => !s.done);
    return { steps, current: current < 0 ? 2 : current, lot: best, lotName: best >= 0 ? `${tileName(best)}${CITY.corner[best] ? ', a corner lot' : ''}` : '' };
  }

  // ───────────────────────────── Board state ─────────────────────────────

  function boardState(): BoardState {
    const legal = legalTilesFor(v, ui.armed, ui.pending);
    let selectedTile = ui.selTile;
    if (ui.armed) {
      selectedTile = ui.preview >= 0 ? ui.preview : ui.boardFocus && legal.has(ui.cursor) ? ui.cursor : -1;
    }
    const g = guide;
    return {
      game: v.game,
      player: v.seat,
      draft: v.draft,
      plan: v.plan,
      summary: v.summary,
      showMarkers: ui.markers && !!v.summary,
      selectedTile,
      selectedUnit: ui.selUnit,
      armed: ui.armed,
      legalTiles: legal,
      hoverTile: ui.touch ? -1 : ui.hover,
      cursorTile: ui.boardFocus ? ui.cursor : -1,
      showBonuses: ui.armed?.kind === 'build' || (!!g && g.current === 1 && !ui.armed),
    };
  }
  let guide: GuideModel | null = null;
  const pushBoard = (): void => board.setState(boardState());

  // ───────────────────────────── Drawer ─────────────────────────────

  function drawerContent(): void {
    const kind = ui.drawer;
    if (!kind) return;
    elDrawer.dataset.kind = kind;
    if (kind === 'inspector') {
      const m = inspectorModel(v, ui.selTile, ui.selUnit);
      patch(
        elDTitle,
        `<div class="dt-row">${m.crest >= 0 ? crestSvg(v.game.players[m.crest]?.house ?? 0, { quiet: true, cls: 'lg' }) : ''}<div><h2 class="serif" id="h-dh" tabindex="-1">${esc(m.title)}</h2><p class="sub mono">${esc(m.sub)}</p></div></div>`,
      );
      patch(elDNav, '');
      patch(elDBody, m.body);
      closeBtn.setAttribute('aria-label', 'Close Inspector');
    } else if (kind === 'orders') {
      patch(elDTitle, `<div class="dt-row"><div><h2 class="serif" id="h-dh" tabindex="-1">Orders</h2><p class="sub mono">${v.draft.length} queued · Actions ${v.actions.used} of ${v.actions.max}</p></div></div>`);
      patch(elDNav, '');
      patch(elDBody, ordersHtml(v));
      closeBtn.setAttribute('aria-label', 'Close Orders');
    } else {
      const m = deltaModel(v, ui.deltaIndex, ui.showAll, ui.markers);
      if (!m) {
        patch(elDTitle, `<div class="dt-row"><div><h2 class="serif" id="h-dh" tabindex="-1">Turn Delta</h2></div></div>`);
        patch(elDNav, '');
        patch(elDBody, '<p class="note">No turn has resolved yet. The Turn Delta appears after Turn 1 resolves.</p>');
      } else {
        patch(elDTitle, `<div class="dt-row"><div><h2 class="serif" id="h-dh" tabindex="-1">${esc(m.heading)}</h2><p class="sub mono" aria-label="State hash ${esc(m.hash)}">${esc(m.hash)}</p></div></div>`);
        patch(
          elDNav,
          `<button type="button" class="nav" data-act="dprev" aria-label="Previous Turn Delta"${m.index <= 0 ? ' disabled' : ''}>${ic('prev')}<span>Earlier</span></button><span class="count mono" aria-hidden="true">${m.index + 1} / ${m.count}</span><button type="button" class="nav" data-act="dnext" aria-label="Next Turn Delta"${m.index >= m.count - 1 ? ' disabled' : ''}><span>Later</span>${ic('next')}</button>`,
        );
        patch(elDBody, m.body);
      }
      closeBtn.setAttribute('aria-label', 'Close Turn Delta');
    }
  }

  function openDrawer(kind: DrawerKind, focus: boolean): void {
    if (ui.drawer !== kind || !elDrawer.classList.contains('open')) {
      if (focus && document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !elDrawer.contains(document.activeElement)) ui.opener = document.activeElement;
      else if (!focus) ui.opener = ui.opener && ui.opener.isConnected ? ui.opener : null;
    }
    ui.drawer = kind;
    render();
    if (focus) {
      const h = elDrawer.querySelector<HTMLElement>('#h-dh');
      (h ?? elDrawer).focus({ preventScroll: true });
    }
  }

  function closeDrawer(returnFocus = true): void {
    if (!ui.drawer) return;
    const inside = elDrawer.contains(document.activeElement);
    if (ui.drawer === 'inspector') {
      ui.selTile = -1;
      ui.selUnit = 0;
      if (ui.implicit) disarm();
    }
    ui.drawer = null;
    render();
    if (inside) {
      const o = ui.opener;
      if (returnFocus && o && o.isConnected && !o.closest('[inert]')) o.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur();
    }
    ui.opener = null;
  }

  const toggleDrawer = (kind: DrawerKind, focus = true): void => {
    if (ui.drawer === kind) closeDrawer();
    else openDrawer(kind, focus);
  };

  // ───────────────────────────── Orders and tools ─────────────────────────────

  function setErr(text: string): void {
    ui.err = text;
  }

  function queue(o: Order): boolean {
    const r = session.queue(o);
    if (!r.ok) {
      setErr(r.reason);
      render();
      return false;
    }
    sound.tap();
    ui.err = '';
    return true;
  }

  function armTool(arg: string, focusCursor: boolean): void {
    const all = allTools();
    const found = all.find((t) => t.arg === arg && t.act === 'tool');
    if (found && found.state !== 'ok') {
      setErr(found.reason);
      if (found.state === 'locked') toast(found.reason);
      render();
      return;
    }
    // Pressing the armed tool again puts it away.
    const same =
      (arg.startsWith('build:') && ui.armed?.kind === 'build' && `build:${ui.armed.build}` === arg) ||
      (arg === 'move' && ui.armed?.kind === 'move') ||
      (arg === 'contest' && ui.armed?.kind === 'contest') ||
      ((arg === 'contract' || arg.startsWith('route')) && ui.armed?.kind === 'tile' && ui.pending?.cmd === (arg === 'contract' ? 'contract' : 'route'));
    disarm();
    ui.err = '';
    if (same) {
      render();
      return;
    }
    if (arg.startsWith('build:')) ui.armed = { kind: 'build', build: arg.slice(6) as never };
    else if (arg === 'move' || arg === 'contest') {
      const u = ownUnit(ui.selUnit);
      if (!u) {
        setErr('Select one of your units first');
        render();
        return;
      }
      ui.armed = { kind: arg, unit: u.id };
    } else if (arg.startsWith('route')) {
      const id = Number(arg.split(':')[1] ?? 0);
      const barge = ownUnit(ui.selUnit)?.kind === 'barge' ? ui.selUnit : id || v.game.units.find((x) => x.owner === v.seat && x.kind === 'barge')?.id || 0;
      if (!barge) {
        setErr('Recruit a Barge first (Barges unlock in Era II)');
        render();
        return;
      }
      ui.armed = { kind: 'tile' };
      ui.pending = { cmd: 'route', unit: id || barge };
    } else if (arg === 'contract') {
      ui.armed = { kind: 'tile' };
      ui.pending = { cmd: 'contract' };
    }
    if (ui.armed && ui.armed.kind !== 'build') ui.tab = ui.armed.kind === 'tile' ? 'trade' : 'units';
    else if (ui.armed) ui.tab = 'build';
    const legal = legalTilesFor(v, ui.armed, ui.pending);
    if (legal.size === 0) {
      setErr(armReasonFor());
      disarm();
    } else if (focusCursor || ui.boardFocus) {
      if (!legal.has(ui.cursor)) {
        ui.cursor = [...legal][0];
        board.centerOn(ui.cursor);
        say(describeTile(ui.cursor));
      }
    }
    render();
  }

  function armReasonFor(): string {
    const a = ui.armed;
    if (!a) return '';
    const all = allTools();
    if (a.kind === 'build') return all.find((t) => t.id === `build:${a.build}`)?.reason || 'No lot accepts that building';
    if (a.kind === 'move') return 'No tile in reach';
    if (a.kind === 'contest') return 'Not adjacent — move the Watch Company next to the target first';
    return ui.pending?.cmd === 'route' ? 'Only canal-front shops can take a Barge route' : 'No shop can take a contract';
  }

  function activateTool(t: Tool): void {
    if (t.state !== 'ok') {
      setErr(t.reason);
      if (t.state === 'locked') toast(t.reason);
      render();
      return;
    }
    if (t.act === 'order') {
      queue(JSON.parse(t.arg) as Order);
    } else if (t.act === 'selunit') selectUnit(Number(t.arg), true);
    else armTool(t.arg, true);
  }

  function selectUnit(id: number, fromDock = false): void {
    const u = unitById(v.game, id);
    if (!u) return;
    disarm();
    ui.selUnit = u.id;
    ui.selTile = u.tile;
    ui.err = '';
    // Selecting one of your units that can still move arms Move; picking elsewhere just inspects.
    if (u.owner === v.seat && v.plan && v.plan.actions > 0 && !v.plan.moved.has(u.id)) {
      ui.armed = { kind: 'move', unit: u.id };
      ui.implicit = true;
      if (legalTilesFor(v, ui.armed, null).size === 0) disarm();
    }
    if (!fromDock) openDrawer('inspector', false);
    else {
      ui.tab = 'units';
      if (mobile()) openDrawer('inspector', false);
      else openDrawer('inspector', false);
    }
    board.centerOn(u.tile);
    render();
  }

  // The last pointer release over the board (client px), to snap a tap to the nearest legal tile.
  let lastPtr: { x: number; y: number; at: number } | null = null;
  function snapLegal(legal: ReadonlySet<number>, touch: boolean): number {
    if (!lastPtr || performance.now() - lastPtr.at > 600) return -1;
    const rect = canvas.getBoundingClientRect();
    const maxD = touch ? 46 : 30;
    let best = -1;
    let bd = maxD * maxD;
    for (const t of legal) {
      const p = board.tileScreenPos(t);
      if (!p) continue;
      const d = (p.x + rect.left - lastPtr.x) ** 2 + (p.y + rect.top - lastPtr.y) ** 2;
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  function pickTile(hit: Hit, shift: boolean, touch: boolean): void {
    ui.touch = touch;
    const armed = ui.armed;
    let tile = hit.tile;
    if (armed && v.plan) {
      const legal0 = legalTilesFor(v, armed, ui.pending);
      if (!legal0.has(tile)) {
        const snapped = snapLegal(legal0, touch);
        if (snapped >= 0) {
          tile = snapped;
          hit = { tile, unit: v.game.units.find((u) => u.tile === tile)?.id ?? 0, building: buildingAt(v.game, tile)?.id ?? 0 };
        }
      }
    }
    ui.cursor = tile;
    if (armed && v.plan) {
      const legal = legalTilesFor(v, armed, ui.pending);
      if (legal.has(tile)) {
        if (touch && ui.preview !== tile) {
          ui.preview = tile;
          const o = orderForPick(v, armed, ui.pending, tile);
          ui.err = '';
          if (o) {
            const d = describeOrder(v.game, v.seat, o);
            say(`${d.text}. Tap again to queue.`);
          }
          render();
          return;
        }
        const o = orderForPick(v, armed, ui.pending, tile);
        if (!o) return;
        const keep = shift && !touch;
        const ok = queue(o);
        if (!ok) return;
        ui.preview = -1;
        if (keep && armed.kind === 'build') {
          if (legalTilesFor(v, ui.armed, ui.pending).size === 0) {
            setErr(armReasonFor());
            disarm();
          }
        } else disarm();
        render();
        return;
      }
      // Not a legal target.
      const thing = hit.building || hit.unit;
      const lenient = armed.kind === 'build' ? !!thing : armed.kind === 'move' ? ui.implicit || !!thing : false;
      if (!lenient) {
        setErr(pickReason(v, armed, ui.pending, tile));
        ui.preview = -1;
        render();
        return;
      }
      disarm();
    }
    if (hit.unit) selectUnit(hit.unit);
    else {
      ui.selUnit = 0;
      ui.selTile = tile;
      ui.err = '';
      openDrawer('inspector', false);
      render();
    }
  }

  function undoLast(): void {
    if (v.draft.length === 0) {
      setErr('Nothing to undo');
      render();
      return;
    }
    session.undo(v.draft.length - 1);
    sound.undo();
    ui.err = '';
  }

  function endTurn(e: MouseEvent | null): void {
    const et = v.endTurn;
    if (!et.enabled) return;
    const keyboardClick = !!e && e.detail === 0;
    if (!guard.accept(performance.now(), v.resolutions, keyboardClick)) return;
    if (et.kind === 'cancel') sound.undo();
    else sound.seal();
    session.endTurn();
  }

  // ───────────────────────────── Click delegation ─────────────────────────────

  function onClick(e: MouseEvent): void {
    const el = (e.target as Element | null)?.closest<HTMLElement>('[data-act]');
    if (!el || !root.contains(el)) return;
    const act = el.dataset.act as string;
    const arg = el.dataset.arg ?? '';
    if (act === 'end') {
      endTurn(e);
      return;
    }
    if (el.getAttribute('aria-disabled') === 'true') {
      const why = el.dataset.reason ?? '';
      if (why) {
        setErr(why);
        if (el.classList.contains('locked')) toast(why);
        render();
      }
      return;
    }
    ui.touch = (e as PointerEvent).pointerType === 'touch' ? true : ui.touch;
    switch (act) {
      case 'tab':
        ui.tab = arg as TabKey;
        ui.err = '';
        render();
        break;
      case 'tool': {
        const t = allTools().find((x) => x.arg === arg && x.act === 'tool' && el.dataset.k === x.id) ?? allTools().find((x) => x.arg === arg && x.act === 'tool');
        if (t) activateTool(t);
        else armTool(arg, false);
        break;
      }
      case 'selunit':
        selectUnit(Number(arg), true);
        break;
      case 'order': {
        let o: Order;
        try {
          o = JSON.parse(arg) as Order;
        } catch {
          return;
        }
        queue(o);
        break;
      }
      case 'jump':
        board.centerOn(Number(arg));
        break;
      case 'delta':
        toggleDrawer('delta');
        break;
      case 'orders':
        toggleDrawer('orders');
        break;
      case 'close':
        closeDrawer();
        break;
      case 'fit':
        board.fit();
        break;
      case 'sound':
        sound.toggleMute();
        render();
        break;
      case 'leave':
        if (opts.onLeave) opts.onLeave();
        else session.leave();
        break;
      case 'lb':
        ui.lbOpen = !ui.lbOpen;
        render();
        break;
      case 'lbdetail':
        ui.lbDetail = !ui.lbDetail;
        render();
        break;
      case 'chron':
        ui.chronOpen = !ui.chronOpen;
        render();
        break;
      case 'guide-x':
        markGuideDone();
        render();
        break;
      case 'guide-lot': {
        const t = Number(arg);
        ui.selUnit = 0;
        ui.selTile = t;
        board.centerOn(t);
        openDrawer('inspector', false);
        break;
      }
      case 'undo':
        session.undo(Number(arg));
        sound.undo();
        break;
      case 'undo-last':
        undoLast();
        break;
      case 'clear':
        session.clear();
        sound.undo();
        break;
      case 'reorder': {
        const [a, b] = arg.split(':').map(Number);
        session.reorder(a, b);
        break;
      }
      case 'deltashow':
        if (ui.showAll.has(arg)) ui.showAll.delete(arg);
        else ui.showAll.add(arg);
        render();
        break;
      case 'markers':
        ui.markers = !ui.markers;
        render();
        break;
      case 'dprev':
        ui.deltaIndex = Math.max(0, (ui.deltaIndex < 0 ? v.summaries.length - 1 : ui.deltaIndex) - 1);
        render();
        break;
      case 'dnext':
        ui.deltaIndex = Math.min(v.summaries.length - 1, (ui.deltaIndex < 0 ? v.summaries.length - 1 : ui.deltaIndex) + 1);
        if (ui.deltaIndex >= v.summaries.length - 1) ui.deltaIndex = -1;
        render();
        break;
      default:
        break;
    }
  }

  // ───────────────────────────── Keyboard ─────────────────────────────

  function actOnCursor(shift: boolean): void {
    const t = ui.cursor;
    if (t < 0) return;
    lastPtr = null;
    const hit: Hit = { tile: t, unit: v.game.units.find((u) => u.tile === t)?.id ?? 0, building: buildingAt(v.game, t)?.id ?? 0 };
    pickTile(hit, shift, false);
  }

  function describeTile(t: number): string {
    const g = v.game;
    const b = buildingAt(g, t);
    const u = g.units.find((x) => x.tile === t);
    const parts = [tileName(t)];
    if (b) parts.push(`${isShop(b.kind) ? SHOPS[b.kind].name : CIVICS[b.kind as keyof typeof CIVICS].name}, ${g.players[b.owner]?.name ?? ''}${b.owner === v.seat ? ' (you)' : ''}`);
    else if (CITY.tiles[t] === 'lot') parts.push('vacant lot');
    else parts.push(CITY.tiles[t]);
    if (u) parts.push(`${u.kind} of ${g.players[u.owner]?.name ?? ''}`);
    if (ui.armed && legalTilesFor(v, ui.armed, ui.pending).has(t)) parts.push('legal target, press Enter to queue');
    return parts.join(', ');
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (destroyed || inLobby()) return;
    const active = document.activeElement;
    const focus = classifyFocus(active, canvas);
    const isAct = e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
    // A held Enter/Space on any HUD button must not auto-repeat into repeated clicks.
    if (isAct && e.repeat && active instanceof HTMLButtonElement && root.contains(active)) {
      e.preventDefault();
      return;
    }
    if (isAct && !e.repeat && active instanceof HTMLButtonElement && active.id === 'end-turn') guard.keyDown(v.resolutions);
    const cmd = keyCommand(
      { key: e.key, repeat: e.repeat, isComposing: e.isComposing, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey },
      focus,
      hasModal(),
    );
    if (!cmd) return;
    switch (cmd.t) {
      case 'end':
        e.preventDefault();
        guard.keyDown(v.resolutions);
        endTurn(null);
        break;
      case 'act':
        e.preventDefault();
        actOnCursor(cmd.shift);
        break;
      case 'cursor': {
        e.preventDefault();
        const next = stepCursor(ui.cursor >= 0 ? ui.cursor : ui.selTile, cmd.dx, cmd.dy);
        ui.cursor = next;
        ui.preview = -1;
        board.centerOn(next);
        say(describeTile(next));
        render();
        break;
      }
      case 'pan':
        e.preventDefault();
        board.panBy(-cmd.dx * PAN_STEP, -cmd.dy * PAN_STEP);
        break;
      case 'zoom':
        e.preventDefault();
        board.zoomBy(cmd.f);
        break;
      case 'tool': {
        e.preventDefault();
        const tool = toolsFor(ui.tab, toolCtx()).find((t) => t.hotkey === cmd.n);
        if (tool) activateTool(tool);
        break;
      }
      case 'esc':
        if (ui.armed) {
          disarm();
          ui.err = '';
          render();
        } else if (ui.drawer) closeDrawer();
        else if (ui.err) {
          ui.err = '';
          render();
        } else if (active instanceof HTMLElement && active !== document.body) active.blur();
        break;
      case 'undo':
        e.preventDefault();
        undoLast();
        break;
      case 'orders':
        toggleDrawer('orders');
        break;
      case 'delta':
        toggleDrawer('delta');
        break;
      case 'fit':
        board.fit();
        break;
      case 'mute':
        sound.toggleMute();
        render();
        break;
    }
  }

  // ───────────────────────────── Render ─────────────────────────────

  let lastInsets = '';
  function updateInsets(): void {
    const rail = elRail.getBoundingClientRect();
    const st = elStatus.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const open = elDrawer.classList.contains('open');
    const dr = elDrawer.getBoundingClientRect();
    const m = mobile();
    let topEdge = st.bottom;
    if (m) for (const el of [elChron, elGuide]) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && getComputedStyle(el).display !== 'none') topEdge = Math.max(topEdge, r.bottom);
    }
    const top = Math.round(topEdge + 4);
    let bottom = Math.round(vh - rail.top + 6);
    let right = 0;
    if (open) {
      if (m) bottom = Math.round(vh - dr.top + 6);
      else right = Math.round(vw - dr.left + 8);
    }
    const doc = document.documentElement.style;
    doc.setProperty('--toast-top', `${Math.round(st.bottom + 8)}px`);
    doc.setProperty('--rail-h', `${Math.round(rail.height)}px`);
    const key = `${top}|${bottom}|${right}`;
    if (key === lastInsets) return;
    lastInsets = key;
    board.setInsets({ top, right, bottom, left: 0 });
  }

  /** Restore keyboard focus when a re-render replaced the focused element. */
  function refocus(prev: { act: string; arg: string; k: string; region: string } | null): void {
    if (!prev) return;
    const a = document.activeElement;
    if (a && a !== document.body && root.contains(a)) return;
    if (a && a !== document.body && !root.contains(a)) return;
    const q = (sel: string): HTMLElement | null => root.querySelector<HTMLElement>(sel);
    const target =
      (prev.k && q(`[data-k="${CSS.escape(prev.k)}"]`)) ||
      (prev.act && prev.arg && q(`[data-act="${prev.act}"][data-arg="${CSS.escape(prev.arg)}"]`)) ||
      (prev.act && q(`[data-act="${prev.act}"]`)) ||
      (prev.region === 'drawer' ? (elDrawer.classList.contains('open') ? elDrawer : null) : null) ||
      q(`#${prev.region} button`);
    target?.focus({ preventScroll: true });
  }

  /** In a room the lobby view stays attached after the match starts; only the pre-match lobby hides the HUD. */
  function inLobby(): boolean {
    return !!v.lobby && v.lobby.status === 'lobby';
  }

  function render(): void {
    if (destroyed) return;
    v = session.view;
    if (inLobby()) return;

    const handoff = !!v.handoff;
    root.classList.toggle('is-handoff', handoff);
    root.classList.toggle('is-table', !!v.tableDelta);
    root.inert = handoff;
    if (handoff && !lastHandoff) {
      resetSelection();
      ui.drawer = ui.drawer === 'delta' ? 'delta' : null;
    }
    if (v.seat !== lastSeat) {
      resetSelection();
      if (ui.drawer === 'inspector') ui.drawer = null;
      lastSeat = v.seat;
    }
    lastHandoff = handoff;

    // Resolution: open the Turn Delta once per newer-turn world, with change markers.
    if (v.resolutions !== lastRes) {
      lastRes = v.resolutions;
      disarm();
      ui.selTile = -1;
      ui.selUnit = 0;
      ui.err = '';
      ui.deltaIndex = -1;
      ui.showAll.clear();
      ui.markers = true;
      ui.drawer = 'delta';
      sound.bell();
      const era = currentEra(v.game);
      if (era > lastEra || !!v.summary?.headline) sound.era();
      lastEra = era;
    }
    if (v.game.turn !== lastTurn) lastTurn = v.game.turn;
    if (v.ended && !lastEnded) sound.rustle();
    lastEnded = v.ended;

    // New orders: markers retire, a Charter plays its seal.
    if (v.draft.length > lastDraft.length) {
      ui.markers = false;
      if (v.draft.some((o) => o.t === 'charter') && !lastDraft.some((o) => o.t === 'charter')) sound.charter();
    }
    lastDraft = v.draft;

    // The armed tool must stay legal for the current plan.
    if (ui.armed) {
      if (!v.plan || ui.armed.kind === 'move' && (v.plan.moved.has(ui.armed.unit) || v.plan.actions < 1)) disarm();
      else if (legalTilesFor(v, ui.armed, ui.pending).size === 0 && ui.armed.kind !== 'contest') {
        if (!ui.err) ui.err = armReasonFor();
        disarm();
      }
    }
    if (ui.selUnit && !unitById(v.game, ui.selUnit)) ui.selUnit = 0;
    if (ui.selTile >= 0 && !ui.selUnit && ui.drawer === 'inspector' && buildingAt(v.game, ui.selTile) === undefined && CITY.tiles[ui.selTile] === undefined) ui.selTile = -1;

    const a = document.activeElement;
    const prev =
      a && root.contains(a) && a instanceof HTMLElement
        ? { act: a.dataset.act ?? '', arg: a.dataset.arg ?? '', k: a.dataset.k ?? '', region: a.closest('#h-drawer') ? 'drawer' : (a.closest('[id^="h-"]')?.id ?? 'h-rail') }
        : null;

    guide = guideModel();
    const spectator = v.seat < 0;

    patch(elPlate, plateHtml(v, { deltaOpen: ui.drawer === 'delta', muted: sound.muted, hasDelta: v.summaries.length > 0 || !!v.summary }));
    patch(elStatus, statusHtml(v));
    patch(elLb, leaderboardHtml(v, { open: ui.lbOpen, detail: ui.lbDetail }));
    patch(elChron, chronicleHtml(v, ui.chronOpen));
    patch(elGuide, guide ? guideHtml(guide) : '');
    if (spectator) patch(elRail, spectatorHtml(v));
    else {
      const tools = toolsFor(ui.tab, toolCtx());
      let hint = ui.armed ? armedHint(v, ui.armed, ui.pending, ui.touch) : '';
      if (ui.armed && ui.preview >= 0) {
        const o = orderForPick(v, ui.armed, ui.pending, ui.preview);
        if (o) {
          const d = describeOrder(v.game, v.seat, o);
          hint = `${d.text}${d.cost ? ` for \u00a7${d.cost.toLocaleString('en-US')}` : ''} \u2014 tap the same tile again to queue it.`;
        }
      }
      patch(
        elRail,
        railHtml(v, {
          tab: ui.tab,
          tools,
          msg: ui.err ? { text: ui.err, tone: 'error' } : { text: hint, tone: 'hint' },
          ordersOpen: ui.drawer === 'orders',
        }),
      );
    }
    drawerContent();
    const open = ui.drawer !== null && !handoff;
    elDrawer.classList.toggle('open', open);
    root.classList.toggle('has-drawer', open);
    if (elDrawer.hasAttribute('inert') === open) {
      if (open) elDrawer.removeAttribute('inert');
      else elDrawer.setAttribute('inert', '');
    }
    elDrawer.setAttribute('aria-hidden', String(!open));
    refocus(prev);
    syncNotices();
    pushBoard();
    updateInsets();
  }

  // ───────────────────────────── Wiring ─────────────────────────────

  const unsub = session.subscribe(() => render());
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);
  board.onPick((hit, e) => {
    if (destroyed || v.handoff || inLobby()) return;
    if (e.right) {
      if (ui.armed) disarm();
      else if (ui.drawer === 'inspector') {
        closeDrawer(false);
        return;
      }
      render();
      return;
    }
    pickTile(hit, e.shift, e.touch);
  });
  board.onHover((t) => {
    if (ui.hover === t) return;
    ui.hover = t;
    pushBoard();
  });
  const onFocus = (): void => {
    ui.boardFocus = true;
    ui.touch = false;
    if (ui.cursor < 0) {
      const own = v.game.units.find((u) => u.owner === v.seat);
      ui.cursor = ui.selTile >= 0 ? ui.selTile : ui.armed ? firstLegal() : own ? own.tile : 5 * 12 + 5;
      if (ui.cursor < 0) ui.cursor = 5 * 12 + 5;
    }
    say(describeTile(ui.cursor));
    pushBoard();
  };
  const onBlur = (): void => {
    ui.boardFocus = false;
    pushBoard();
  };
  // Focus the pointer gave the board is not keyboard focus: let go after the tap or drag, so Enter and
  // Space then end the turn as on a bare page. Focus the player reached with Tab (or focus()) stays.
  let pointerFocus = false;
  const onPointerDown = (): void => {
    pointerFocus = document.activeElement !== canvas;
  };
  const onPointerUpCapture = (e: PointerEvent): void => {
    lastPtr = { x: e.clientX, y: e.clientY, at: performance.now() };
  };
  const onPointerUp = (): void => {
    if (!pointerFocus) return;
    pointerFocus = false;
    window.setTimeout(() => {
      if (document.activeElement === canvas) canvas.blur();
    }, 0);
  };
  canvas.addEventListener('pointerdown', onPointerDown, true);
  canvas.addEventListener('pointerup', onPointerUpCapture, true);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('focus', onFocus);
  canvas.addEventListener('blur', onBlur);
  const onResize = (): void => updateInsets();
  window.addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateInsets()) : null;
  ro?.observe(elRail);
  ro?.observe(elStatus);
  ro?.observe(elDrawer);

  // Bottom-sheet drag handle: drag down past 64px to close.
  let drag: { y: number; id: number } | null = null;
  const grab = elDrawer.querySelector<HTMLElement>('[data-grab]') as HTMLElement;
  grab.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, id: e.pointerId };
    grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = Math.max(0, e.clientY - drag.y);
    elDrawer.style.transform = `translateY(${dy}px)`;
  });
  const endDrag = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    drag = null;
    elDrawer.style.removeProperty('transform');
    if (dy > 64) closeDrawer();
  };
  grab.addEventListener('pointerup', endDrag);
  grab.addEventListener('pointercancel', endDrag);

  render();

  return {
    destroy(): void {
      destroyed = true;
      unsub();
      root.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('focus', onFocus);
      canvas.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointerdown', onPointerDown, true);
      canvas.removeEventListener('pointerup', onPointerUpCapture, true);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      board.onPick(() => {});
      board.onHover(() => {});
      if (elToasts) elToasts.replaceChildren();
      root.replaceChildren();
      root.classList.remove('hud', 'is-handoff', 'is-table', 'has-drawer');
    },
    openTurnDelta(): void {
      openDrawer('delta', false);
    },
    inspectTile(tile: number): void {
      if (tile < 0 || tile >= 144) return;
      ui.selUnit = 0;
      ui.selTile = tile;
      board.centerOn(tile);
      openDrawer('inspector', false);
    },
  };
}
