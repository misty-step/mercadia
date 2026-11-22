# MERCADIA — Design

This document describes how MERCADIA looks, sounds, and is put together. It is written in the
present tense and is kept true to the code.

## 1. Visual direction — a sunlit architectural diorama

Warm print on travertine. The reference points are risograph posters, Monument Valley's
tonal solids, and Mini Metro's restraint. The district sits on a stone slab like a model on a
table, with harbor water along its near edge.

### Palette

| Token | Hex | Use |
| --- | --- | --- |
| Travertine | `#EFE9DC` | Page, paving, stone |
| Terracotta | `#C86443` | Tiled roofs |
| Sage | `#84A98C` | Park turf, vacant lots, trees |
| Canal | `#3E8E9E` | Canal and harbor water |
| Avenue slate | `#464B57` | Avenues and lanes |
| Brass | `#D4A34A` | Tram rails, tram trim, coin pops |
| Ink | `#1E1A16` | Text, hairlines |
| Linen | `rgba(250, 247, 240, 0.93)` | HUD surfaces |

House colors: Vermilion Guild `#D6453A`, Cobalt Syndicate `#2667B8`, Marigold House
`#D48C1C`, Emerald Atelier `#248A63`. A House color appears on awnings, pennants, the lot
kerb, and leaderboard chips — never as a panel background.

### Form

- Faces are flat tonal solids with no outlines: lit top, mid left face, shaded right face.
- Every shop archetype has its own silhouette, and each level changes the architecture: an
  extra floor at Level 2, a rooftop pergola or terrace and a gilded cornice at Level 3.
- Ground shadows are a single multiply layer. They swing and stretch with the sun.
- A faint paper grain lies over the whole canvas.

### Time-of-day lighting

Each quarter is one day. A colour grade multiplies over the diorama and moves through four
keys: Morning Amber → Crisp Sunlit Noon → Golden Hour → Twilight Lantern Glow. The grade is
full strength over the model and feathers out to nothing, so the page around it stays
travertine. At twilight a second pass paints light after the grade: lit windows, street lamps,
café string lights, the cinema marquee, tram headlamps, and nightmarket lanterns.

### Weather and events on canvas

Cloudburst: slanted rain streaks, ripples on the canal, a cooler grade. Lantern Festival:
golden paper lanterns drift up over the district. Harbor Cruise: a white liner berths at the
pier. Free-Ride Tram Day: a third tram joins the loop with a pennant.

### Typography

- **Fraunces** — wordmark, quarter banners, headlines. Fallback `Georgia, serif`.
- **DM Sans** — interface labels. Fallback `system-ui, sans-serif`.
- **JetBrains Mono** — cash, prices, shares, room codes, always tabular. Fallback
  `ui-monospace, monospace`.

Fonts load from Google Fonts with `display=swap`; the fallbacks carry the layout offline.

### Anti-slop rules

No dark purple neon. No Inter. No glowing calls to action. No emoji as interface. No bento
grid over the canvas. No modal larger than the decision it carries. Surfaces are linen with a
`1px solid rgba(30, 26, 22, 0.14)` hairline and a `6px` radius. Icons are bespoke inline SVG.

## 2. Layout

The canvas is `100vw × 100dvh`. HUD pieces dock to the edges:

| Piece | Dock | Content |
| --- | --- | --- |
| Clock chip | top left | Wordmark, quarter, daypart dial, speed controls, fit, sound, leave |
| Gazette ticker | top, beside the clock | Current or forecast city event with a countdown bar |
| Leaderboard | top right | Four Houses in rank order, Crown Index, Worth + Share + Prestige toggle, market-share bar in the same order |
| Treasury chip | bottom left | Cash, debt, `Borrow §400 · 18%/qtr`, Ledger drawer toggle |
| Build dock | bottom centre | Six shops, three civic projects, cost, unmet-demand pips, a tooltip per tool |
| Inspector | right edge | Opens for a clicked shop, lot, or citizen; closes with Esc. Leads with the shop's diagnosis line |
| Spectator notice | bottom centre | Ink `#1E1A16` on `rgba(250, 247, 240, 0.96)` with a hairline; shown instead of the dock |

At 1440×900 the persistent HUD covers about 14% of the viewport, leaving 86% to the city. At
1024×768 the dock tightens and moves right of the treasury.

At 390×844:

- The score strip is one row in rank order: House chip, initials (`You`, `Ves`, `Aur`,
  `Ors`), Crown. The share bar beneath it uses the same order. Tapping the strip expands the
  Worth + Share + Prestige breakdown.
- The Gazette ticker is a fixed 48 px: event title plus its modifier line
  (`Cinema & Roastery +45% · Nightmarket −35%`), or two lines of news.
- At 640 px and below the dock shows one palette at a time behind a `Shops (6)` /
  `Civic (3)` tab switch, with a one-line hint beside it. Nothing scrolls off screen.
- Fit view (and the opening view) fits the island from the harbor corner to the station
  corner, centred on the slab, with a few pixels to spare.
- The Inspector is a bottom sheet (at most 42% of the height) over the dock. It scrolls,
  collapses to its summary, and pans the camera once so the selected block sits in the strip
  of city above it. Building does not open it; a tap on the building does.
- A blueprint has no hover on touch: the first tap on a lot shows the lot card and the reach
  ring, the second tap on the same lot builds.
- A citizen's speech card flips below the citizen when there is no room above, so it never
  covers the clock, ticker or score strip (all viewports).

Input: drag to pan, WASD or arrows to pan, wheel or `+`/`-` to zoom about the cursor, click to
inspect, `1`–`9` to pick a build tool, `Esc` to cancel, `Space` to pause in solo, `M` to mute,
`F` to fit. The key policy is a pure function (`src/client/input.ts`): `1`–`9` and `Space` do
nothing while the Title, the Lobby or the Victory modal is on screen, and the final bell, a
Rematch and Continue in Endless each drop whatever tool was armed. The Sound button carries
`aria-pressed` and a label that names the next press (`Mute sound (M)` / `Unmute sound (M)`).
Leave arms on the first click (`Leave?`, four seconds) and leaves on the second.

### The Final Edition

The victory summary is a newspaper front page: a double-ruled masthead (*The Mercadia
Gazette*, Final Edition), the winning House's crest (shield in the House colour, brass crown,
laurel), a Fraunces headline with an italic deck, the winner's `Worth + Share + Prestige =
Crown` equation, the standings table with each part and its source value, an inline SVG
market-share chart, three honours, and two prominent buttons: Rematch and Continue in
Endless. The chart follows the data-viz rules used here: 2 px lines in the House colours
(validated for colour-vision separation), end dots with a surface ring, direct end labels in
ink, hairline gridlines at each quarter's close, a legend, and a `<title>` on every line, dot
and quarter band. The dialog takes focus itself, never a button.

## 3. Rendering

Canvas 2D, isometric 2:1, tile 64×32 world units, device-pixel-ratio aware.

Frame order:

1. Slab, harbor, and ground tiles back to front (paving, avenue with crosswalks and brass
   rails, lanes, animated canal shimmer).
2. One merged shadow path.
3. Depth-sorted actors: buildings, bridges, trees, lamps, trams, citizens, boats.
4. Colour grade (multiply), then the light pass (additive), then weather.
5. Overlays: build footprint, bonus tags, traffic pips, selection ring, civic reach (a
   cream-backed dashed ring, a wash on each lot inside, a marker on each shop it lifts — filled
   for yours, outlined for a rival's), the Tram Stop blueprint (marching brass dashes along the
   tramway, green avenue-side lots, greyed and struck-through inland lots), event focus (a
   brass outline and up-chevron on boosted shops, a slate down-chevron on dampened ones, slow
   rings on the Harbor Pier or the tram platforms), Promo Blitz pills, floating feedback
   (`+§24` coin pops, delight stars, queue and stockout badges), paper grain.

Promo Blitz pills are ink on solid cream with an ink hairline and a House-colour dot. They are
drawn after the colour grade, so they stay cream at twilight and over canal water, and they
never render smaller than 8.5 px on screen.

The simulation is authoritative at 10 Hz. The renderer keeps the previous and current
positions of every citizen and tram and interpolates at display rate, so motion is smooth at
60 FPS in solo and multiplayer alike.

Buildings and the ground are cached as sprites at the current zoom and redrawn only when the
zoom bucket or the set of buildings changes. Some machines expose a "GPU" that is a slow
software emulation; the client times its first frames and, if they crawl, swaps to a CPU-backed
canvas and remembers the choice. `?canvas=cpu` or `?canvas=gpu` pins it.

## 4. Sound

`src/client/audio.ts` synthesises every sound with Web Audio: a wooden build thud, a brass
coin chime, a two-strike tram bell, a paper rustle for the Gazette, an upgrade fanfare, rain
hiss. There are no audio files. The context starts on the first user gesture. The Sound toggle
is always visible and persists in `localStorage`.

## 5. Architecture

```
src/shared/     pure TypeScript, no DOM or Worker globals, seeded PRNG
  types.ts        state and command types
  constants.ts    tuning tables
  map.ts          the district, pathfinding, lot bonuses
  sim.ts          createGame, tick, applyCommand, scoring, events, ledger
  ai.ts           Vesper, Aurelia, Orson; advance() = AI + tick
  insight.ts      explanations: shop diagnosis, lot synergy, civic reach, event focus
  room.ts         RoomCore: lobby, seats, reconnect, host migration, rematch
  protocol.ts     wire messages, snapshot encoder, client view store
src/client/     Vite app: renderer, HUD, input, audio, solo and network sessions
src/worker.ts   Worker: /api/health, /api/rooms, /ws/rooms/:code, static assets
src/room-do.ts  MercadiaRoom Durable Object (SQLite-backed)
```

**One simulation, two hosts.** Solo runs `advance()` in the browser. Multiplayer runs the same
function inside the Durable Object. Both feed the client through the same snapshot encoder and
view store, so the solo path exercises the multiplayer path on every tick.

**The room.** `MercadiaRoom` extends `DurableObject` from `cloudflare:workers` and uses the
WebSocket Hibernation API. Lobby state and match checkpoints live in the object's SQLite
storage. A 100 ms interval steps the simulation only while a match is running and at least one
human is connected; otherwise no timer exists and the object can hibernate. Players reconnect
with a `playerId` token (`src/client/seat-token.ts`). It is kept in `localStorage`, with
`sessionStorage` as the tab's own copy and the fallback, so a closed tab or an evicted mobile
page reclaims its seat from the invite link. The tab holding a seat writes a heartbeat beside
the token every two seconds; a second tab in the same browser adopts the token only once that
heartbeat has been quiet for six, so it cannot steal a seat that is still being played. If the
host disconnects, the next connected human becomes host. A checkpoint written by an older
build is brought up to the current shape on restore (`upgradeState`).

**Dev hook.** `window.__mercadia` is a read-only window for smoke checks. Its one mutating
method, `warp(n)`, works on `localhost` / `127.0.0.1` and elsewhere only with `?dev=1`.

**Snapshots.** Each 100 ms the room broadcasts one compact snapshot: tick, quarter clock,
per-player numbers, a flat citizen array, tram positions, changed buildings only, new Gazette
lines, and feedback events. A joining or reconnecting socket receives one full snapshot first.

## 6. Tuning reference

- Tick: 100 ms. Quarter: 600 ticks (Blitz) or 1500 ticks (Standard, Endless).
- Dayparts: morning, noon, golden hour, twilight — a quarter of the quarter each.
- Shop choice: `score = distancePull × priceValue × quality × queueFactor × promo`, where
  price value is `(basePrice ÷ price) ^ archetype price-sensitivity` and quality folds in
  level, price-stance cachet, park and plaza aura, site affinity, and the shop's rating.
- A full queue turns citizens away. A queue whose estimated wait exceeds a citizen's patience
  makes them peel off to a rival.
- Payroll every 100 ticks: wages + rent (+25% during a Rent Hike) + 1.2% interest on debt
  (18% a quarter in Standard, 7.2% in Blitz).
- Crown Index: `netWorth ÷ 10 + marketShare% × 3 + prestige × 4`.
- Lost customers: each shop counts recent losses by reason (`tooPricey`, `queueFull`,
  `outOfStock`), decaying with a half-life of about 45 s. A price or stock loss is counted
  only for a shop that would otherwise have won the customer.
- Market share is sampled once per daypart for the Final Edition's chart.
- Blitz opening: first AI move at tick 90, +30 per further AI seat, thinking at half pace
  until tick 450.

All numbers live in `src/shared/constants.ts`.
