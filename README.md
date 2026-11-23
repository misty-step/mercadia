# MERCADIA

> *Rival merchant dynasties reshape a sunlit canal-and-tramway city era by era.*

MERCADIA is a deliberate, four-era isometric dynasty city tycoon for the browser. One to four
merchant Houses claim lots in a small canal district, open shops, set prices, adopt lasting
Dynasty Charters, and invest in parks, tram stops, and plazas. Citizens walk the streets with
real budgets and desires and choose between rival shops. The House with the highest Crown Index
when Era IV closes wins.

- **Four Eras:** Founding Charter → Transit & Trade → Grand Boulevard → Golden Dynasty. Each era
  unlocks new shops and civic projects; an **Era Council** between eras pauses the city while
  every House adopts one permanent Dynasty Charter.
- **Solo:** one click starts a Standard match against three AI Houses — Vesper, Aurelia, and
  Orson. Pause, 0.5×, 1×, 2×, 3×.
- **Multiplayer:** create a room, share the four-letter code or invite link, fill empty seats
  with AI, and play 2–4 humans on an authoritative server. The Council runs on a short
  server-side countdown; the host sets the pace (1×, 1.5×, 2×).
- **Heraldry:** every House flies its own crest (Compass, Harbor Anchor, Sunburst Crown, Laurel
  Arch) on banners, kerbs, the leaderboard, and the Mercadia Chronicle.
- **Stack:** TypeScript, Vite, Canvas 2D, Web Audio, one Cloudflare Worker, one SQLite-backed
  Durable Object class, static assets. No game engine, no image or audio files.

Read [PRODUCT.md](PRODUCT.md) for what the game is and [DESIGN.md](DESIGN.md) for how it looks,
sounds, and is built.

## Run it locally

Requires Node 20 or newer.

```bash
npm install
npm run build     # typechecks client, shared and worker, then builds the client to dist/client
npm run dev       # wrangler dev on http://127.0.0.1:8787 — assets, API and Durable Object sockets
```

Open `http://127.0.0.1:8787`. For a second player, open the invite link in another browser
profile or a private window.

`npm run dev:client` runs the Vite dev server with hot reload on port 5173 and proxies `/api`
and `/ws` to the Worker on 8787, so run `npm run dev` beside it.

## Test it

```bash
npm test          # Vitest: 296 tests — map, citizens, cashflow, events, AI, match, room, protocol,
                  #   eras, Era Council, charters & milestones, Chronicle, Founding Guide
npm run smoke     # Playwright: API, solo, a 390×844 phone, and browsers sharing one room (needs npm run dev)
npm run evidence  # Playwright: re-captures the nine reference screenshots and a walkthrough film
npm run balance   # headless seeded matches; `npm run balance -- 12 all` adds Blitz and the 2-human Blitz probe
```

`npm run smoke` covers the whole v2 surface: era locks and unlock notices, the Founding Guide,
the Era Council in solo and across two browsers (charter sync, countdown auto-select), Dynasty
Milestones and the ledger reconciliation, heraldry (DOM crests and canvas pixels), Chronicle
dispatches and click-to-focus, reconnect, closed-tab seat reclaim, host migration, the
spectator notice, and phone parity. `ONLY=solo,multi` (any of `api,solo,guide,dev,mobile,multi`)
runs sections selectively.

`npm run smoke` drives a local Chrome through `playwright-core`. Set `CHROME=/path/to/chrome`
if it is not at `/usr/bin/google-chrome`, and `BASE=https://…` to point it at a deployment.
It fails on any console error, page error, or failed request.

## Play

| Input | Action |
| --- | --- |
| Drag, `WASD`, arrows | Pan |
| Wheel, pinch, `+` / `-` | Zoom about the cursor |
| Click | Inspect a shop, lot, or citizen |
| `1`–`9` | Pick a build tool; click a green lot to build; `Shift`-click keeps the tool. A tool whose era has not come answers with its unlock notice |
| `Esc`, right-click | Cancel the tool or close the inspector |
| `Space` | Pause (solo) |
| `F` | Fit the district to the screen |
| `M` | Mute |

In build mode every vacant lot shows its bonuses as dots — ink for Corner, teal for Canal-front,
brass for Transit, sage for a park or plaza aura — and its live foot traffic as pips.

## Layout

```
src/shared/     deterministic simulation, shared by browser and Worker (no DOM, no Worker globals)
  constants.ts    every tuning number
  map.ts          the 12×12 district, pathfinding, lot bonuses
  sim.ts          createGame, tick, applyCommand, shop choice, events, ledger, scoring,
                  eras, the Era Council, Dynasty Charters, Milestones, Chronicle dispatches
  ai.ts           Vesper, Aurelia, Orson: era locks, measured openings, charter choices
  insight.ts      explanations: diagnosis, synergy, Founding Guide, milestone progress
  room.ts         RoomCore: lobby, seats, AI fill, reconnect, host migration, rematch, Council countdown
  protocol.ts     messages, snapshot encoder, client view store
src/client/     renderer.ts, art.ts, heraldry.ts, hud.ts, audio.ts, session.ts, icons.ts, main.ts
src/worker.ts   /api/health, /api/rooms, /ws/rooms/:code, then static assets
src/room-do.ts  MercadiaRoom Durable Object: sockets, 10 Hz loop, SQLite checkpoints
tests/          Vitest suite
scripts/        smoke.mjs (Playwright), evidence.mjs (reference screenshots), balance.ts (economy probe)
```

### HTTP and WebSocket surface

| Route | Answer |
| --- | --- |
| `GET /api/health` | `{ "ok": true, "game": "mercadia", "version": "2.0.0" }` |
| `POST /api/rooms` | `201 { code, wsPath, joinUrl }` — a fresh four-letter room |
| `GET /api/rooms/:code` | Lobby or match summary, or `404` |
| `GET /ws/rooms/:code` | WebSocket upgrade, forwarded to the room's Durable Object |
| anything else | Static assets, with single-page-application fallback |

The room steps the simulation only while a match is running (or an Era Council is counting
down) and a human is connected. In the lobby, and whenever everyone has left, there is no timer
and the object can hibernate. In a match a client picks its charter with
`{ "t": "cmd", "cmd": { "c": "charter", "key": "artisanry" } }`; snapshots carry the Council,
the Chronicle and each House's charters and milestones.

### Dev hook

`window.__mercadia` is a read-only window for smoke checks: `state()`, `era`, `unlocks`,
`locked`, `milestones`, `charters`, `chronicle()`, `council()`, `guide()`. Its mutating
methods work on `localhost` / `127.0.0.1` and elsewhere only with `?dev=1`: `warp(n)` runs a
solo match forward n ticks deterministically, closing any Era Council on the way with whatever
is chosen (the steward's pick otherwise); `warp(n, true)` stops as a Council opens.

## Deploy

```bash
npx wrangler login
npm run deploy    # npm run build && wrangler deploy
```

`wrangler.jsonc` declares the `ASSETS` binding on `dist/client`, the `GAME_ROOMS` Durable
Object binding, and a `new_sqlite_classes` migration for `MercadiaRoom`, so it deploys on the
Workers free plan. Nothing else needs configuring: no KV, no D1, no secrets.

## Tuning

All gameplay numbers are in `src/shared/constants.ts`; the AI temperaments are in
`src/shared/ai.ts`. After a change, run `npm test` and `npm run balance -- 12` and compare the
wins and average Crown Index per persona. Standard is the tuned mode (12 seeds: Vesper 5,
Aurelia 5, Orson 2 wins); Blitz currently favours Vesper.
