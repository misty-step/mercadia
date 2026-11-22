# MERCADIA

> *Rival merchants reshape a sunlit canal-and-tramway city block by block.*

MERCADIA is a real-time isometric city tycoon for the browser. One to four merchant Houses
buy lots in a small canal district, open shops, set prices, and invest in parks, tram stops,
and plazas. Around eighty citizens walk the streets with real budgets and desires and choose
between rival shops. The House with the highest Crown Index when the final quarter closes wins.

- **Solo:** one click starts a match against three AI tycoons — Vesper, Aurelia, and Orson.
- **Multiplayer:** create a room, share the four-letter code or invite link, fill empty seats
  with AI, and play 2–4 humans on an authoritative server.
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
npm test          # Vitest: 162 tests across map, citizens, cashflow, events, AI, match, room, protocol
npm run smoke     # Playwright: API, solo, a 390×844 phone, and browsers sharing one room (needs npm run dev)
npm run balance   # headless seeded matches; `npm run balance -- 12 all` adds Blitz and the 2-human Blitz probe
```

`npm run smoke` drives a local Chrome through `playwright-core`. Set `CHROME=/path/to/chrome`
if it is not at `/usr/bin/google-chrome`, and `BASE=https://…` to point it at a deployment.
It fails on any console error, page error, or failed request.

## Play

| Input | Action |
| --- | --- |
| Drag, `WASD`, arrows | Pan |
| Wheel, pinch, `+` / `-` | Zoom about the cursor |
| Click | Inspect a shop, lot, or citizen |
| `1`–`9` | Pick a build tool; click a green lot to build; `Shift`-click keeps the tool |
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
  sim.ts          createGame, tick, applyCommand, shop choice, events, ledger, scoring
  ai.ts           Vesper, Aurelia, Orson
  room.ts         RoomCore: lobby, seats, AI fill, reconnect, host migration, rematch
  protocol.ts     messages, snapshot encoder, client view store
src/client/     renderer.ts, art.ts, hud.ts, audio.ts, session.ts, icons.ts, main.ts
src/worker.ts   /api/health, /api/rooms, /ws/rooms/:code, then static assets
src/room-do.ts  MercadiaRoom Durable Object: sockets, 10 Hz loop, SQLite checkpoints
tests/          Vitest suite
scripts/        smoke.mjs (Playwright), balance.ts (economy probe)
```

### HTTP and WebSocket surface

| Route | Answer |
| --- | --- |
| `GET /api/health` | `{ "ok": true, "game": "mercadia", "version": "1.0.0" }` |
| `POST /api/rooms` | `201 { code, wsPath, joinUrl }` — a fresh four-letter room |
| `GET /api/rooms/:code` | Lobby or match summary, or `404` |
| `GET /ws/rooms/:code` | WebSocket upgrade, forwarded to the room's Durable Object |
| anything else | Static assets, with single-page-application fallback |

The room steps the simulation only while a match is running and a human is connected. In the
lobby, and whenever everyone has left, there is no timer and the object can hibernate.

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
average Crown Index per persona.
