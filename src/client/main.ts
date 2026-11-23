// MERCADIA client entry. Owns the frame loop, input, and the hand-offs between the title
// screen's attract-mode district, solo matches, and multiplayer rooms.
import { BUILD_KINDS, CHARTERS, ERAS, HOUSES, MILESTONES, START_CASH, buildName, eraDef, isUnlocked } from '../shared/constants';
import { CITY } from '../shared/map';
import type { ClientMsg, LobbyView } from '../shared/protocol';
import { buildCostFor, ledgerCashChange, starsOf } from '../shared/sim';
import type { BuildKind, Fx, MatchMode } from '../shared/types';
import { Foley } from './audio';
import { freeCentre, playInsets } from './chronicle';
import { Hud, LobbyScreen, TitleScreen, storedName } from './hud';
import { MatchWatch, devHooksAllowed, disarm, normKey, resolveKey } from './input';
import { Renderer, type UiState } from './renderer';
import { LocalSession, NetSession, attractSetups, createRoom, roomExists, soloSetups, type Session } from './session';

const stage = document.getElementById('stage') as HTMLDivElement;
const renderer = new Renderer(document.getElementById('city') as HTMLCanvasElement);
const audio = new Foley();
const ui: UiState = { me: -1, tool: null, hoverTile: -1, selectedTile: -1, selectedCitizen: -1, guideLots: [] };

let session: Session = new LocalSession('attract', attractSetups(), 'endless', (Date.now() & 0xffff) + 17);
let net: NetSession | null = null;
let roomCode = '';
let phase: 'title' | 'lobby' | 'playing' = 'title';
const errors: string[] = [];

// ───────────────────────────── Screens ─────────────────────────────

const hud = new Hud({
  session: () => session,
  ui,
  audio,
  renderer,
  setTool,
  select,
  leave: () => toTitle(),
  isHost: () => (net ? net.isHost : session.kind === 'solo'),
  disarm: () => resetUi(),
  refit: () => refit(),
  focus: (tile) => renderer.panTo(tile),
});

const title = new TitleScreen({
  audio,
  playSolo,
  createRoom: async (name) => {
    const code = await createRoom();
    enterRoom(code, name);
  },
  joinRoom: async (code, name) => {
    if (!(await roomExists(code))) throw new Error(`No room called ${code}. Check the code.`);
    enterRoom(code, name);
  },
});

const lobby = new LobbyScreen({
  audio,
  seat: () => (net ? net.seat : -1),
  send: (msg: ClientMsg) => net?.send(msg),
  leave: () => toTitle(),
  inviteUrl: () => `${location.origin}/?room=${roomCode}`,
});

function setInsets(): void {
  const w = window.innerWidth;
  if (phase === 'playing') {
    renderer.insets = playInsets(w);
  } else {
    // Leave room for the title card: it sits left on wide screens, bottom on phones.
    renderer.insets = w <= 720 ? { top: 10, right: 0, bottom: Math.round(window.innerHeight * 0.52), left: 0 } : { top: 20, right: 0, bottom: 20, left: Math.min(460, Math.round(w * 0.3)) };
  }
}

function refit(): void {
  renderer.resize();
  setInsets();
  renderer.fit();
}

/** Drop any armed build tool, hover and selection (new match, final bell, rematch, endless). */
function resetUi(): void {
  disarm(ui);
  stage.classList.remove('building');
  stage.classList.remove('pointing');
}

function setUrl(code: string | null): void {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

function toTitle(): void {
  net?.dispose();
  net = null;
  roomCode = '';
  session.dispose();
  session = new LocalSession('attract', attractSetups(), 'endless', (Date.now() & 0xffff) + 31);
  ui.me = -1;
  resetUi();
  phase = 'title';
  hud.hide();
  lobby.hide();
  lobby.reset();
  title.show();
  setUrl(null);
  audio.rain(false);
  refit();
}

function playSolo(rivals: number, mode: MatchMode, name: string): void {
  session.dispose();
  const s = new LocalSession('solo', soloSetups(name, rivals), mode, (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0);
  s.onReject = reject;
  s.onAccept = accepted;
  session = s;
  ui.me = 0;
  resetUi();
  phase = 'playing';
  title.hide();
  lobby.hide();
  hud.show();
  refit();
}

function enterRoom(code: string, name: string): void {
  net?.dispose();
  roomCode = code;
  setUrl(code);
  lobby.reset();
  title.hide();
  phase = 'lobby';
  lobby.show(code);
  const n = new NetSession(code, name || storedName() || '', {
    onLobby: (l) => onLobby(l),
    onWelcome: (_seat, player) => {
      ui.me = player;
    },
    onStatus: (status, detail) => {
      if (status === 'closed') {
        toTitle();
        title.error(detail ?? 'The room closed.');
      } else if (status === 'reconnecting') {
        lobby.setStatus('Reconnecting…');
        if (phase === 'playing') hud.toast('Connection lost. Reconnecting…');
      } else if (status === 'open') lobby.setStatus('');
    },
  });
  n.onReject = reject;
  n.onAccept = accepted;
  net = n;
}

function onLobby(l: LobbyView): void {
  if (!net) return;
  if (l.status === 'lobby') {
    if (phase === 'playing') {
      // Back from a match to the lobby: return to the attract district behind it.
      hud.hide();
      phase = 'lobby';
      lobby.show(l.code);
      resetUi();
      refit();
    }
    lobby.update(l);
    return;
  }
  // A match is running or has ended: the room's city takes the stage.
  if (phase !== 'playing') {
    session.dispose();
    session = net;
    ui.me = net.me;
    resetUi();
    phase = 'playing';
    lobby.hide();
    title.hide();
    hud.show();
    refit();
  }
  ui.me = net.me;
}

/** A refusal replaces any earlier refusal; it never stacks. */
function reject(err: string): void {
  hud.refuse(err);
  audio.deny();
}

/** Something we asked for went through: an old "Not enough cash…" is no longer true. */
function accepted(): void {
  hud.clearRefusals();
}

// ───────────────────────────── Actions ─────────────────────────────

function setTool(k: BuildKind | null): void {
  if (ui.me < 0) return;
  // No blueprint may be armed over a finished match, or while the Era Council sits.
  if (k && (phase !== 'playing' || session.view.ended || session.view.inCouncil)) k = null;
  // A tool whose era has not come is never armed: say when it unlocks instead.
  if (k && !isUnlocked(k, session.view.quarter)) {
    hud.lockedNotice(k);
    k = null;
  }
  ui.tool = k;
  stage.classList.toggle('building', !!k);
  if (k) {
    ui.selectedTile = -1;
    ui.selectedCitizen = -1;
  }
  hud.sync(0, true);
}

function select(tile: number): void {
  ui.selectedTile = tile;
  ui.selectedCitizen = -1;
  hud.sync(0, true);
}

function tryBuild(tile: number, keep: boolean): void {
  const view = session.view;
  const me = view.players[ui.me];
  if (!ui.tool || !me) return;
  if (CITY.tiles[tile] !== 'lot') return;
  if (view.buildingAt(tile)) {
    setTool(null);
    select(tile);
    return;
  }
  if (ui.tool === 'tramstop' && CITY.avenueAdj[tile] < 0) return reject('A Tram Stop must touch the avenue');
  if (me.cash < buildCostFor(me, ui.tool)) return reject(`Not enough cash for a ${buildName(ui.tool)}`);
  session.command({ c: 'build', tile, kind: ui.tool });
  if (!keep) setTool(null);
}

// ───────────────────────────── Feedback ─────────────────────────────

function onFx(f: Fx): void {
  const view = session.view;
  renderer.addFx(f, view, performance.now());
  if (phase !== 'playing') return;
  hud.onFx(f);
  const mine = (p: number): boolean => p === ui.me;
  switch (f.k) {
    case 'coin':
      if (mine(f.p)) audio.coin();
      break;
    case 'build':
      audio.build(mine(f.p));
      // Desktop opens the new shop's Inspector beside the city. On a phone the Inspector is a
      // bottom sheet over the dock, so it waits for a tap and building can continue. While the
      // Founding Guide is walking the player through their opening it waits everywhere: the
      // guide's second step is the player's own click on their first shop.
      if (mine(f.p) && window.innerWidth > 640 && !hud.guideActive) select(f.tile);
      break;
    case 'upgrade':
      if (mine(f.p)) audio.fanfare();
      break;
    case 'promo':
      if (mine(f.p)) audio.promo();
      break;
    case 'restock':
      if (mine(f.p)) audio.restock();
      break;
    case 'sell':
      if (mine(f.p)) audio.sell();
      break;
    case 'bell':
      audio.bell();
      break;
    case 'event':
      if (f.phase !== 'end') audio.rustle();
      if (f.kind === 'cloudburst') audio.rain(f.phase === 'start');
      break;
    case 'award':
      audio.award();
      break;
    case 'quarter':
      // A new era: the era bell under a warm chord.
      audio.era();
      audio.rain(false);
      break;
    case 'council':
      audio.council();
      audio.rain(false);
      break;
    case 'milestone':
      if (mine(f.p)) audio.milestone();
      else audio.sting();
      break;
    case 'charter':
      if (mine(f.p)) audio.seal();
      break;
    case 'dispatch':
      // Headlines that carry no sound of their own: lead changes and rivalry clashes.
      if (f.tier === 1 && (f.cat === 'lead' || f.cat === 'rival' || f.cat === 'promo')) audio.sting();
      break;
    default:
      break;
  }
}

// ───────────────────────────── Input ─────────────────────────────

const pointers = new Map<number, { x: number; y: number }>();
let dragFrom: { x: number; y: number } | null = null;
let dragged = false;
let pinch = 0;
const keys = new Set<string>();

stage.addEventListener('pointerdown', (e) => {
  audio.unlock();
  hud.closeFeedOnPhone();
  ui.touch = e.pointerType === 'touch' || e.pointerType === 'pen';
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    dragFrom = { x: e.clientX, y: e.clientY };
    dragged = false;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = Math.hypot(a.x - b.x, a.y - b.y);
    dragged = true;
  }
});

stage.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (p) {
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && d > 0) renderer.zoomAt(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = d;
      return;
    }
    if (dragFrom && !dragged && Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) > 6) {
      dragged = true;
      stage.classList.add('dragging');
    }
    if (dragged) {
      renderer.pan(dx, dy);
      return;
    }
  }
  // A finger has no hover: while a blueprint is armed, the preview tile is set by a tap instead.
  if (e.pointerType === 'mouse' || (p && !(ui.touch && ui.tool))) hover(e.clientX, e.clientY);
});

function hover(x: number, y: number): void {
  const view = session.view;
  if (ui.tool) {
    ui.hoverTile = renderer.tileAt(x, y);
    return;
  }
  const hit = renderer.pick(x, y, view, session.alpha(performance.now()));
  ui.hoverTile = hit && hit.kind === 'tile' ? hit.tile : -1;
  const hot = !!hit && (hit.kind === 'citizen' || !!view.buildingAt(hit.tile) || CITY.tiles[hit.tile] === 'lot');
  stage.classList.toggle('pointing', hot && !dragged);
}

function release(e: PointerEvent): void {
  const had = pointers.delete(e.pointerId);
  stage.classList.remove('dragging');
  if (!had) return;
  if (pointers.size > 0) return;
  const wasDrag = dragged;
  dragFrom = null;
  dragged = false;
  pinch = 0;
  if (wasDrag || e.type === 'pointercancel') return;
  click(e.clientX, e.clientY, e.shiftKey, e.pointerType !== 'mouse');
}
stage.addEventListener('pointerup', release);
stage.addEventListener('pointercancel', release);
stage.addEventListener('pointerleave', (e) => {
  if (!pointers.size && e.pointerType === 'mouse') ui.hoverTile = -1;
});

function click(x: number, y: number, shift: boolean, touch = false): void {
  const view = session.view;
  if (ui.tool && ui.me >= 0) {
    const tile = renderer.tileAt(x, y);
    if (tile < 0) return;
    // Touch: the first tap on a vacant lot shows the blueprint (reach ring, synergy card);
    // a second tap on the same lot builds. A mouse already had the preview on hover.
    if (touch && tile !== ui.hoverTile && CITY.tiles[tile] === 'lot' && !view.buildingAt(tile)) {
      ui.hoverTile = tile;
      audio.click();
      return;
    }
    tryBuild(tile, shift);
    if (touch) ui.hoverTile = -1;
    return;
  }
  const hit = renderer.pick(x, y, view, session.alpha(performance.now()));
  if (!hit) {
    ui.selectedTile = -1;
    ui.selectedCitizen = -1;
  } else if (hit.kind === 'citizen') {
    ui.selectedCitizen = ui.selectedCitizen === hit.id ? -1 : hit.id;
    ui.selectedTile = -1;
    audio.click();
  } else {
    const interesting = !!view.buildingAt(hit.tile) || CITY.tiles[hit.tile] !== 'avenue';
    ui.selectedCitizen = -1;
    ui.selectedTile = interesting && ui.selectedTile !== hit.tile ? hit.tile : -1;
    if (ui.selectedTile >= 0) audio.click();
  }
  hud.sync(0, true);
}

stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    renderer.zoomAt(Math.exp(-delta * 0.0016), e.clientX, e.clientY);
  },
  { passive: false },
);
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (ui.tool) setTool(null);
});

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // The policy lives in input.ts: build and speed hotkeys never leak through the Title,
  // the Lobby or the Victory modal.
  const act = resolveKey(e.key, {
    phase,
    victoryOpen: hud.victoryOpen,
    ended: session.view.ended,
    me: ui.me,
    kind: session.kind,
    tool: ui.tool,
    councilOpen: hud.councilOpen || session.view.inCouncil,
    quarter: session.view.quarter,
  });
  switch (act.a) {
    case 'pan':
      keys.add(normKey(e.key));
      e.preventDefault();
      break;
    case 'zoom':
      renderer.zoomAt(act.factor, renderer.width / 2, renderer.height / 2);
      break;
    case 'mute':
      audio.unlock();
      audio.toggle();
      hud.sync(0, true);
      title.syncSound();
      break;
    case 'escape':
      if (ui.tool) setTool(null);
      else {
        ui.selectedTile = -1;
        ui.selectedCitizen = -1;
        hud.sync(0, true);
      }
      break;
    case 'pause':
      e.preventDefault();
      session.togglePause();
      hud.sync(0, true);
      break;
    case 'fit':
      refit();
      break;
    case 'tool':
      setTool(act.kind);
      break;
    case 'locked':
      hud.lockedNotice(act.kind);
      break;
    default:
      // A swallowed Space must not scroll or re-press a focused button behind an overlay.
      if (e.key === ' ' && (e.target === document.body || e.target === stage)) e.preventDefault();
      break;
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(normKey(e.key));
});
window.addEventListener('blur', () => keys.clear());
window.addEventListener('resize', () => {
  renderer.resize();
  setInsets();
  if (phase !== 'playing') renderer.fit();
  else renderer.pan(0, 0);
});
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

// ───────────────────────────── Frame loop ─────────────────────────────

const params = new URLSearchParams(location.search);
/** ?canvas=cpu|gpu pins the canvas backing; the default probes and decides. */
const CANVAS_KEY = 'mercadia:canvas';
let remembered: string | null = null;
try {
  remembered = localStorage.getItem(CANVAS_KEY);
} catch {
  remembered = null;
}
const devHooks = devHooksAllowed(location.hostname, location.search);
const asked = params.get('canvas');
const canvasMode = asked === 'cpu' || asked === 'gpu' ? asked : remembered === 'cpu' ? 'cpu' : 'auto';
let lastFrame = 0;
const watch = new MatchWatch();
let frames = 0;
let slowFrames = 0;
let probed = 0;
function frame(now: number): void {
  const raw = lastFrame ? now - lastFrame : 16;
  const dt = Math.min(64, raw);
  lastFrame = now;
  frames++;
  // Watch the first second or so of frames. If the browser is presenting slowly while our
  // own drawing is cheap, its "accelerated" canvas is the bottleneck: fall back to CPU.
  if (canvasMode === 'auto' && !renderer.cpu && frames > 4 && probed < 10 && document.visibilityState === 'visible') {
    probed++;
    if (raw > 45) slowFrames++;
    if (probed === 10 && slowFrames >= 8) {
      renderer.useCpuCanvas();
      try {
        localStorage.setItem(CANVAS_KEY, 'cpu'); // remember for the next visit
      } catch {
        // private mode: probe again next time
      }
    }
  }
  // Keyboard pan.
  if (keys.size) {
    const v = dt * 0.62;
    let dx = 0;
    let dy = 0;
    if (keys.has('a') || keys.has('ArrowLeft')) dx += v;
    if (keys.has('d') || keys.has('ArrowRight')) dx -= v;
    if (keys.has('w') || keys.has('ArrowUp')) dy += v;
    if (keys.has('s') || keys.has('ArrowDown')) dy -= v;
    if (dx || dy) renderer.pan(dx, dy);
  }
  const fx = session.update(now);
  for (const f of fx) onFx(f);
  const view = session.view;
  // The final bell, a Rematch and Continue in Endless each change the match on screen:
  // whatever was armed for the old one is dropped, on every client in the room.
  if (watch.changed(view) && phase === 'playing') {
    resetUi();
    hud.sync(0, true);
  }
  if (view.ready) {
    const alpha = session.alpha(now);
    renderer.frame(view, alpha, ui, now);
    hud.sync(now);
    hud.frame(alpha);
  }
  requestAnimationFrame(frame);
}

// ───────────────────────────── Boot ─────────────────────────────

/** A small, read-only window for automated smoke checks. */
(window as unknown as { __mercadia: unknown }).__mercadia = {
  get phase() {
    return phase;
  },
  get kind() {
    return session.kind;
  },
  get me() {
    return ui.me;
  },
  get frames() {
    return frames;
  },
  get errors() {
    return errors.slice();
  },
  get roomCode() {
    return roomCode;
  },
  get seat() {
    return net ? net.seat : -1;
  },
  get lobby() {
    return net ? net.lobby : null;
  },
  get zoom() {
    return renderer.cam.zoom;
  },
  get perf() {
    return renderer.perf;
  },
  get cpuCanvas() {
    return renderer.cpu;
  },
  /** Point the camera at a tile at a given zoom (screenshots). */
  look(x: number, y: number, zoom: number) {
    renderer.cam.zoom = zoom;
    renderer.cam.x = (x - y) * 32;
    renderer.cam.y = (x + y) * 16;
  },
  /** True where the dev hooks below are live: local hosts, or any host with ?dev=1. */
  get dev() {
    return devHooks;
  },
  get tool() {
    return ui.tool;
  },
  get selectedTile() {
    return ui.selectedTile;
  },
  /**
   * Solo and attract only: run the local simulation forward by n ticks at once.
   * A cheat on a public host, so it is inert there unless the URL carries ?dev=1.
   */
  warp(n: number, hold = false) {
    if (!devHooks) return false;
    if (session instanceof LocalSession) session.warp(n, hold);
    hud.sync(0, true);
    return true;
  },
  /** Dev hook: pan the camera to a lot, as the Chronicle's click-to-focus does. */
  focus(tile: number) {
    if (!devHooks) return false;
    renderer.panTo(tile);
    return true;
  },
  /** The era on the clock, 1..4. */
  get era() {
    return session.view.era;
  },
  get eraName() {
    return eraDef(session.view.quarter).name;
  },
  /** Build tools the current era allows, and those still behind an Era lock. */
  get unlocks() {
    return BUILD_KINDS.filter((k) => isUnlocked(k, session.view.quarter));
  },
  get locked() {
    return BUILD_KINDS.filter((k) => !isUnlocked(k, session.view.quarter));
  },
  /** Dynasty Milestones per House. */
  get milestones() {
    return session.view.players.map((p) => ({
      house: HOUSES[p.house].key,
      stars: starsOf(p),
      earned: MILESTONES.filter((_, i) => (p.milestones[i] ?? -1) >= 0).map((m) => m.key),
    }));
  },
  /** Dynasty Charters per House. */
  get charters() {
    return session.view.players.map((p) => ({ house: HOUSES[p.house].key, charters: p.charters.slice(), names: p.charters.map((k) => CHARTERS[k].name) }));
  },
  /** The Mercadia Chronicle's recent dispatches, oldest first. */
  chronicle() {
    return session.view.chronicle.map((d) => ({ n: d.n, tick: d.tick, cat: d.cat, tier: d.tier, head: d.head, pill: d.pill, player: d.player, tile: d.tile, icon: d.icon }));
  },
  /** The open Era Council, or null. */
  council() {
    const c = session.view.council;
    if (!session.view.inCouncil || !c) return null;
    return { era: c.era, next: c.next, offers: c.offers.map((o) => o.slice()), picks: c.picks.slice(), left: c.left, total: c.total, unlocked: c.unlocked.slice(), level3: c.level3, rows: c.rows.map((r) => ({ ...r })) };
  },
  /** The Founding Guide: its step (0 once retired), the steps done, and whether it is retired for good. */
  guide() {
    return { ...hud.guideInfo(), lots: (ui.guideLots ?? []).slice() };
  },
  get speed() {
    return session.kind === 'multi' ? session.view.speed : session.speed;
  },
  get paused() {
    return session.paused;
  },
  /** The four eras, for reference. */
  get eras() {
    return ERAS.map((e) => ({ n: e.n, roman: e.roman, name: e.name }));
  },
  get skip() {
    return renderer.skip;
  },
  state() {
    const v = session.view;
    return {
      ready: v.ready,
      tick: v.tick,
      quarter: v.quarter,
      era: v.era,
      phase: v.ended ? 'ended' : v.inCouncil ? 'council' : 'playing',
      mode: v.mode,
      ended: v.ended,
      citizens: v.citizens.size,
      trams: v.trams.length,
      event: v.event ? v.event.kind : null,
      players: v.players.map((p) => ({ name: p.name, house: HOUSES[p.house].key, kind: p.kind, cash: p.cash, crown: p.crown, stars: starsOf(p), charters: p.charters.slice() })),
      buildings: v.buildings.map((b) => ({ id: b.id, tile: b.tile, kind: b.kind, owner: b.owner, level: b.level, stance: b.stance })),
    };
  },
  freeLots() {
    const v = session.view;
    return CITY.lots.filter((t) => !v.buildingAt(t));
  },
  /** True for a lot that touches the tramway avenue (where a Tram Stop may stand). */
  avenueSide(tile: number) {
    return CITY.avenueAdj[tile] >= 0;
  },
  /** Screen positions of the citizens on the street. */
  citizensOnScreen() {
    return [...session.view.citizens.values()].map((c) => ({ id: c.id, ...renderer.citizenScreen(c, 1) }));
  },
  /** The Gazette's recent lines. */
  gazette() {
    return session.view.gazette.map((g) => ({ tone: g.tone, text: g.text }));
  },
  /** Screen x of the island's two tips against the viewport width (fit checks). */
  islandSpan() {
    return renderer.islandSpan();
  },
  /** Screen position of the centre of a tile. */
  tileScreen(tile: number) {
    return renderer.tileToScreen((tile % 12) + 0.5, Math.floor(tile / 12) + 0.5);
  },
  /**
   * My Treasury against my Ledger, as this client holds them right now: cash in hand, and the
   * Ledger drawer's closing line (opening cash plus the match's ledger). They must agree to the §.
   */
  ledger() {
    const v = session.view;
    const p = v.players[ui.me];
    const lg = v.ledgers[ui.me];
    if (!p || !lg) return null;
    return {
      tick: v.tick,
      cash: p.cash,
      debt: p.debt,
      closing: Math.round(START_CASH + ledgerCashChange(lg.total)),
      dividends: lg.total.dividends,
      borrowed: lg.total.borrowed,
      repaid: lg.total.repaid,
    };
  },
  /** The camera, the HUD insets and the centre of the free city area (click-to-focus checks). */
  get camera() {
    const { width, height, insets, cam } = renderer;
    return { x: cam.x, y: cam.y, zoom: cam.zoom, width, height, insets: { ...insets }, centre: freeCentre(renderer), gliding: renderer.gliding };
  },
};

if (canvasMode === 'cpu') renderer.useCpuCanvas();
const wanted = (params.get('room') ?? '').toUpperCase();
refit();
if (/^[A-Z]{4}$/.test(wanted)) {
  // Invite link: go straight to the room.
  title.hide();
  roomExists(wanted).then((ok) => {
    if (ok) enterRoom(wanted, storedName());
    else {
      toTitle();
      title.error(`Room ${wanted} was not found. It may have closed.`);
    }
  });
} else {
  title.show();
}
if (document.fonts && document.fonts.ready) void document.fonts.ready.then(() => hud.sync(0, true));
requestAnimationFrame(frame);
