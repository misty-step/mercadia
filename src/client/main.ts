// MERCADIA client entry. Owns the frame loop, input, and the hand-offs between the title
// screen's attract-mode district, solo matches, and multiplayer rooms.
import { BUILD_KINDS, HOUSES, buildCost, buildName } from '../shared/constants';
import { CITY } from '../shared/map';
import type { ClientMsg, LobbyView } from '../shared/protocol';
import type { BuildKind, Fx, MatchMode } from '../shared/types';
import { Foley } from './audio';
import { Hud, LobbyScreen, TitleScreen, storedName } from './hud';
import { Renderer, type UiState } from './renderer';
import { LocalSession, NetSession, attractSetups, createRoom, roomExists, soloSetups, type Session } from './session';

const stage = document.getElementById('stage') as HTMLDivElement;
const renderer = new Renderer(document.getElementById('city') as HTMLCanvasElement);
const audio = new Foley();
const ui: UiState = { me: -1, tool: null, hoverTile: -1, selectedTile: -1, selectedCitizen: -1 };

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
    renderer.insets = w <= 720 ? { top: 140, right: 0, bottom: 130, left: 0 } : { top: 64, right: w > 1180 ? 120 : 60, bottom: 84, left: 0 };
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

function resetUi(): void {
  ui.tool = null;
  ui.hoverTile = -1;
  ui.selectedTile = -1;
  ui.selectedCitizen = -1;
  stage.classList.remove('building');
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
    if (net.me < 0) hud.toast('Match in progress: you are watching as a spectator.');
  }
  ui.me = net.me;
}

function reject(err: string): void {
  hud.toast(err);
  audio.deny();
}

// ───────────────────────────── Actions ─────────────────────────────

function setTool(k: BuildKind | null): void {
  if (ui.me < 0) return;
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
  if (me.cash < buildCost(ui.tool)) return reject(`Not enough cash for a ${buildName(ui.tool)}`);
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
      if (mine(f.p)) select(f.tile);
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
      audio.quarter();
      audio.rain(false);
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
  if (e.pointerType === 'mouse' || p) hover(e.clientX, e.clientY);
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
  click(e.clientX, e.clientY, e.shiftKey);
}
stage.addEventListener('pointerup', release);
stage.addEventListener('pointercancel', release);
stage.addEventListener('pointerleave', () => {
  if (!pointers.size) ui.hoverTile = -1;
});

function click(x: number, y: number, shift: boolean): void {
  const view = session.view;
  if (ui.tool && ui.me >= 0) {
    const tile = renderer.tileAt(x, y);
    if (tile >= 0) tryBuild(tile, shift);
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
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
    keys.add(k);
    e.preventDefault();
    return;
  }
  if (k === '+' || k === '=') renderer.zoomAt(1.18, renderer.width / 2, renderer.height / 2);
  else if (k === '-' || k === '_') renderer.zoomAt(1 / 1.18, renderer.width / 2, renderer.height / 2);
  else if (k === 'm') {
    audio.unlock();
    audio.toggle();
    hud.sync(0, true);
  } else if (k === 'Escape') {
    if (ui.tool) setTool(null);
    else {
      ui.selectedTile = -1;
      ui.selectedCitizen = -1;
      hud.sync(0, true);
    }
  } else if (k === ' ' && phase === 'playing' && session.kind === 'solo') {
    e.preventDefault();
    session.togglePause();
    hud.sync(0, true);
  } else if (k === 'f') refit();
  else if (phase === 'playing' && ui.me >= 0 && k >= '1' && k <= '9') {
    const kind = BUILD_KINDS[Number(k) - 1];
    setTool(ui.tool === kind ? null : kind);
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
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
const asked = params.get('canvas');
const canvasMode = asked === 'cpu' || asked === 'gpu' ? asked : remembered === 'cpu' ? 'cpu' : 'auto';
let lastFrame = 0;
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
  /** Solo and attract only: run the local simulation forward by n ticks at once. */
  warp(n: number) {
    if (session instanceof LocalSession) session.warp(n);
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
      ended: v.ended,
      citizens: v.citizens.size,
      trams: v.trams.length,
      event: v.event ? v.event.kind : null,
      players: v.players.map((p) => ({ name: p.name, house: HOUSES[p.house].key, kind: p.kind, cash: p.cash, crown: p.crown })),
      buildings: v.buildings.map((b) => ({ id: b.id, tile: b.tile, kind: b.kind, owner: b.owner, level: b.level, stance: b.stance })),
    };
  },
  freeLots() {
    const v = session.view;
    return CITY.lots.filter((t) => !v.buildingAt(t));
  },
  /** Screen position of the centre of a tile. */
  tileScreen(tile: number) {
    return renderer.tileToScreen((tile % 12) + 0.5, Math.floor(tile / 12) + 0.5);
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
