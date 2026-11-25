# MERCADIA

> *Rival merchant dynasties reshape a canal-and-tramway city, one deliberate turn at a time.*

MERCADIA v3 is a strict, discrete turn-based dynasty civ for one to four Houses. Nothing in the world
changes until every human seat has finished its turn; then one pure, deterministic resolution advances
the district from Turn N to N+1 and prints an exact ledger of what changed. Read [PRODUCT.md](PRODUCT.md)
for the rules, [DESIGN.md](DESIGN.md) for look and architecture, and [SPEC.md](SPEC.md) for how the code
realises them (and the details the folio leaves open).

- **Modes:** Solo (1 human + AI Houses), Hotseat (2–4 humans, one device, handoff screen), Network room
  (`/?room=ABCD`, one Durable Object authority per room, Ready / Cancel Ready, exactly-once resolution).
- **Stack:** TypeScript, Vite, Canvas 2D, Web Audio, one Cloudflare Worker, one SQLite-backed Durable Object
  class (no tick, no alarm-driven simulation), static assets, self-hosted fonts, strict CSP.

## Run it

```bash
npm install
npm run build     # typecheck client/shared/worker, build the client to dist/client
npm run dev       # wrangler dev on http://127.0.0.1:8787 (assets, API, room sockets)
```

## Test it

```bash
npm test          # Vitest: core, orders, resolution, AI, replay, room authority, DST harness, session, HUD input
npm run smoke     # Playwright + real Chrome against `npm run dev`: solo, hotseat, phone, two-browser room,
                  #   WebSocket relay (drop/hold/replay/inject), 2-min frozen planning, 5-min heartbeat idle
npm run balance   # headless seeded AI matches through the real resolution code
```

`npm run smoke` writes screenshots/videos to `~/chief-evidence/media` (`MEDIA=…`), `FAST=1` shortens the
idle checks, `ONLY=solo,hotseat,mobile,room,relay,idle` selects sections. The `legacy` section starts its own
`wrangler dev` (scripts/wrangler.legacy.jsonc, port 8791, throwaway persisted state) and needs `npm run build` first.
After the sections the smoke drops any recorded clip that never rendered a frame, re-encodes the rest (VP9, 10 fps,
<= 960 px) and checks every kept video frame by frame with `ffmpeg` `signalstats`, so it needs `ffmpeg` on PATH.

## Rooms from older versions

A room's Durable Object stores `room` and `game` rows in SQLite `kv` in every version. v3 classifies what it finds
(`classifyStoredRoom`): a deployed v2 (real-time) room is *legacy* and is isolated read-only: `/api/rooms/:code`,
`/export` and the WebSocket answer HTTP 410, its storage is never written, deleted or simulated, and the client
offers **Create New Room**. A started room persisted before `exportVersion` existed keeps playing but answers
`409 incompatible_ruleset` on export rather than labelling old hashes as version 5.

Only a coherent, fully valid save resumes. Every nested record of the stored `Game` is checked, `stateHash` and
`computeStandings` must run on it, and the room and game must agree (a `lobby` has no game row, `playing` pairs with a
`planning` game, `ended` with an `ended` one, and drafts/ready/epochs/playerOf/lastResolved/hashes match the players
and turn). Anything else is legacy (410/409), and the cleanup alarm purges only an idle lobby with no game or a finished
room with an ended game, never an anomaly.

## Layout

```
src/shared/   pure core: types, constants, map, rng, hash, game, orders, resolve, ai, replay, local,
              protocol, room (authority state machine)
src/room-do.ts, src/worker.ts   Durable Object shell and Worker routes
src/client/   session (solo/hotseat/room), board (canvas), hud, screens, audio, dev-hook
```
