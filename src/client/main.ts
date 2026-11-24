// MERCADIA app entry. Boots the board, shows the title over a live AI-only demonstration
// district, routes into Solo, Hotseat or a network room, and mounts the HUD while a match runs.
// main.ts never mutates game state: every order goes through session.queue, and the Council
// card, handoff screen and Final Edition are pure functions of the session view.
import type { Hit, Session, SessionView } from './contracts';
import { AI_PERSONAS } from '../shared/constants';
import { createGame } from '../shared/game';
import { canonicalOrders, resolveTurn } from '../shared/resolve';
import type { CharterKey, Game } from '../shared/types';
import { Sound } from './audio';
import { createBoard } from './board';
import { installDevHook } from './dev-hook';
import { createHud } from './hud';
import { CouncilCard, FinalEdition, Handoff } from './screens-overlays';
import { buildSoloConfig, Screens } from './screens';
import { cleanRoomCode, h, randomSeed, savedName } from './screens-ui';
import { createRoom, createSession } from './session';
import type { BoardApi, BoardState } from './contracts';

// ───────────────────────────── The demonstration district ─────────────────────────────

let demo: Game | null = null;

/** An AI-only Blitz district a few turns in, so the title opens on a plate with buildings on it. Fixed seed: this is scenery, not a match. */
function demoGame(): Game {
  if (demo) return demo;
  let g = createGame({
    seed: 1861,
    mode: 'blitz',
    players: [
      { name: 'Vesper', house: 0, kind: 'ai', persona: 'vesper' },
      { name: 'Aurelia', house: 1, kind: 'ai', persona: 'aurelia' },
      { name: 'Orson', house: 2, kind: 'ai', persona: 'orson' },
      { name: AI_PERSONAS.vesper.name, house: 3, kind: 'ai', persona: 'vesper' },
    ],
  });
  for (let i = 0; i < 7; i++) g = resolveTurn(g, canonicalOrders(g, [])).game;
  demo = g;
  return g;
}

// ───────────────────────────── App ─────────────────────────────

const el = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id}`);
  return e as T;
};

type Hud = ReturnType<typeof createHud>;

function boot(): void {
  const canvas = el<HTMLCanvasElement>('board');
  const hudRoot = el('hud');
  const screensRoot = el('screens');

  const sound = new Sound();
  // Audio starts on the first user gesture and never on a timer.
  const unlock = (): void => sound.unlock();
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });

  let board: BoardApi;
  try {
    board = createBoard(canvas);
  } catch {
    screensRoot.append(h('p', { class: 'boot-error', role: 'alert', text: 'MERCADIA needs a browser with Canvas 2D support.' }));
    return;
  }

  const screens = new Screens(screensRoot);
  const overlayHost = h('div', { class: 'overlay-host' });
  screensRoot.append(overlayHost);

  let session: Session | null = null;
  let unsub: (() => void) | null = null;
  let hud: Hud | null = null;
  let mySeat = -1;
  let menuKey = '';
  let demoSel: { tile: number; unit: number } = { tile: -1, unit: 0 };
  let demoHover = -1;

  installDevHook(() => session, (t) => board.tileScreenPos(t));

  // ── The demo plate behind the menus ──

  const pushDemoState = (): void => {
    const g = demoGame();
    const s: BoardState = {
      game: g,
      player: -1,
      draft: [],
      plan: null,
      summary: null,
      showMarkers: false,
      selectedTile: demoSel.tile,
      selectedUnit: demoSel.unit,
      armed: null,
      legalTiles: new Set<number>(),
      hoverTile: demoHover,
      cursorTile: -1,
      showBonuses: false,
    };
    board.setState(s);
  };

  const takeBoard = (): void => {
    demoSel = { tile: -1, unit: 0 };
    demoHover = -1;
    board.onPick((hit: Hit) => {
      demoSel = hit.tile >= 0 ? { tile: hit.tile, unit: hit.unit } : { tile: -1, unit: 0 };
      screens.inspect(demoGame(), hit.tile >= 0 ? hit : null);
      pushDemoState();
    });
    board.onHover((t: number) => {
      if (t === demoHover) return;
      demoHover = t;
      pushDemoState();
    });
    pushDemoState();
  };

  screens.onLayout((i) => {
    if (!hud) board.setInsets(i);
  });

  // ── Session lifecycle ──

  const setInert = (on: boolean): void => {
    hudRoot.inert = on;
    canvas.inert = on;
  };

  const council = new CouncilCard(overlayHost, {
    choose: (key: CharterKey) => {
      if (!session) return;
      // The HUD plays the charter seal when the order lands in the draft.
      const r = session.queue({ t: 'charter', key });
      if (!r.ok) screens.toast(r.reason, 'error');
    },
  });
  const handoff = new Handoff(overlayHost, () => {
    sound.tap();
    session?.beginTurn();
  });
  const final = new FinalEdition(overlayHost, {
    rematch: () => session?.rematch(),
    endless: () => session?.continueEndless(),
    exportMatch: () => exportMatch(),
    leave: () => leaveToTitle(),
  });

  function exportMatch(): void {
    const exp = session?.exportMatch();
    if (!exp) {
      screens.toast('There is no match log to export yet.', 'error');
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `mercadia-${exp.config.seed}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function destroyHud(): void {
    if (!hud) return;
    try {
      hud.destroy();
    } catch {
      // a HUD that fails to tear down must not strand the player on a dead screen
    }
    hud = null;
    hudRoot.replaceChildren();
    hudRoot.hidden = true;
  }

  function teardown(): void {
    unsub?.();
    unsub = null;
    destroyHud();
    council.close();
    handoff.close();
    final.close();
    setInert(false);
    session?.leave();
    session = null;
    mySeat = -1;
    menuKey = '';
  }

  function setRoomUrl(code: string | null): void {
    const u = new URL(location.href);
    if (code) u.searchParams.set('room', code);
    else u.searchParams.delete('room');
    history.pushState(null, '', `${u.pathname}${u.search}`);
  }

  function begin(next: Session): void {
    teardown();
    session = next;
    unsub = next.subscribe(onView);
    onView(next.view);
  }

  function showMenu(key: string, show: () => void): void {
    if (menuKey === key) return;
    menuKey = key;
    takeBoard();
    show();
  }

  function onView(v: SessionView): void {
    const s = session;
    if (!s) return;

    if (v.mode === 'room') {
      const terminal = v.status.tone === 'error' && (v.status.text === 'Room not found' || v.status.text === 'This seat is open in another tab');
      if (terminal) {
        destroyHud();
        council.close();
        handoff.close();
        final.close();
        setInert(false);
        showMenu(`err:${v.status.text}`, () =>
          screens.showNotice(
            {
              title: v.status.text === 'Room not found' ? 'No such room' : 'Seat in use',
              body: v.status.text === 'Room not found' ? `There is no room with the code ${v.roomCode || 'you entered'}. Check the code, or create a new room.` : 'This seat is open in another tab of this browser. Close that tab, or return to the title and start fresh.',
              tone: 'error',
              action: { label: 'Back to title', run: () => leaveToTitle() },
            },
            demoGame(),
          ),
        );
        return;
      }
      if (v.lobby && v.lobby.status === 'lobby') {
        destroyHud();
        council.close();
        handoff.close();
        final.close();
        setInert(false);
        const key = `lobby:${v.lobby.code}:${v.lobby.matchNo}`;
        if (menuKey !== key) {
          menuKey = key;
          takeBoard();
          screens.showLobby(s, { mySeat, onLeave: () => void requestLeave() }, demoGame());
        } else screens.updateLobby(v);
        return;
      }
      if (!hud && (!v.lobby || v.status.text === 'Connecting…' || v.status.text === 'Starting…')) {
        showMenu(`conn:${v.status.text}`, () =>
          screens.showNotice(
            { title: `Room ${v.roomCode}`, body: v.status.text === 'Starting…' ? 'The match is starting…' : 'Connecting to the room…', tone: 'wait', action: { label: 'Back to title', run: () => leaveToTitle() } },
            demoGame(),
          ),
        );
        return;
      }
    }

    // A match is running (or finished): the HUD owns the board.
    if (!hud) {
      screens.hideMenu();
      menuKey = '';
      hudRoot.hidden = false;
      hud = createHud({ root: hudRoot, session: s, board, sound, canvas, onLeave: () => void requestLeave() });
    }
    handoff.sync(v);
    if (handoff.open) council.close();
    else council.sync(v);
    final.sync(v);
    setInert(handoff.open || final.open || (council.open && !council.isPeeking));
  }

  async function requestLeave(): Promise<void> {
    const s = session;
    if (!s) return;
    const room = s.view.mode === 'room';
    const ok = await screens.confirm(
      room
        ? { title: 'Leave this room?', body: 'Your seat stays reserved for you. Open the same room link in this browser to return to it.', confirmLabel: 'Leave room', cancelLabel: 'Stay' }
        : { title: 'Leave this match?', body: 'This match is not saved. Leaving ends it and returns you to the title.', confirmLabel: 'Leave match', cancelLabel: 'Keep playing' },
    );
    if (ok && session === s) leaveToTitle();
  }

  function leaveToTitle(): void {
    const wasRoom = new URL(location.href).searchParams.has('room');
    teardown();
    if (wasRoom) setRoomUrl(null);
    toTitle();
  }

  // ── Entry points ──

  function toTitle(): void {
    showMenu('title', () =>
      screens.showTitle(
        {
          solo: () => begin(createSession({ mode: 'solo', config: buildSoloConfig(savedName(), randomSeed()) })),
          hotseat: () => toHotseat(),
          createRoom: async () => {
            const { code } = await createRoom();
            joinRoom(code, true);
          },
          join: (code) => joinRoom(cleanRoomCode(code), true),
        },
        demoGame(),
      ),
    );
  }

  function toHotseat(): void {
    teardown();
    showMenu('hotseat', () =>
      screens.showHotseat(
        {
          start: (config) => begin(createSession({ mode: 'hotseat', config })),
          back: () => toTitle(),
        },
        demoGame(),
      ),
    );
  }

  function joinRoom(code: string, push: boolean): void {
    if (push) setRoomUrl(code);
    const name = savedName();
    mySeat = -1;
    const next: Session = createSession({
      mode: 'room',
      roomCode: code,
      name: name || undefined,
      // Read the seat out of the authority's `welcome` (the view only says whether we are the host).
      socketFactory: (url: string) => {
        const ws = new WebSocket(url);
        ws.addEventListener('message', (ev: MessageEvent) => {
          if (typeof ev.data !== 'string' || !ev.data.includes('"welcome"')) return;
          try {
            const m = JSON.parse(ev.data) as { t?: string; seat?: number };
            if (m.t === 'welcome' && typeof m.seat === 'number') {
              mySeat = m.seat; // this listener runs before the session's own handler, so the next view sees it
            }
          } catch {
            // not for us
          }
        });
        return ws;
      },
    });
    begin(next);
  }

  // ── Routing ──

  const route = (): void => {
    const code = cleanRoomCode(new URL(location.href).searchParams.get('room') ?? '');
    const raw = new URL(location.href).searchParams.get('room');
    if (raw !== null) {
      // A malformed code still routes to the room screen, which reports "Room not found".
      joinRoom(code.length === 4 ? code : raw.toUpperCase().slice(0, 8) || 'XXXX', false);
    } else {
      teardown();
      toTitle();
    }
  };
  window.addEventListener('popstate', route);
  route();
}

boot();
