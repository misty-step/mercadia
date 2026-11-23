# MERCADIA — Design

This document describes how MERCADIA looks, feels, sounds, and is structured. It is written in
the present tense as living truth for the product.

## 1. Visual direction — sunlit architectural diorama with unmistakable heraldry

Warm editorial print on travertine, inspired by architectural risograph posters, Monument
Valley's tonal solids, and Mini Metro's legible restraint. The canal district rests on a sculpted
stone slab bordered by harbor water.

### Palette

| Token | Hex | Use |
| --- | --- | --- |
| Travertine | `#EFE9DC` | Page canvas, paving, stone slab |
| Terracotta | `#C86443` | Tiled roofs, warm civic accents |
| Sage | `#84A98C` | Park turf, vacant lots, foliage |
| Canal | `#3E8E9E` | Grand Canal and harbor water |
| Avenue slate | `#464B57` | Streetcar Avenue and lanes |
| Brass | `#D4A34A` | Tram rails, era unlocks, crests, milestones, coin pops |
| Ink | `#1E1A16` | Primary text, crisp hairlines |
| Linen | `rgba(250, 247, 240, 0.94)` | HUD surfaces and cards |

### House palette and heraldry

| House | Primary | Deep Trim | Soft Wash | Crest Emblem |
| --- | --- | --- | --- | --- |
| Vermilion Guild | `#D6453A` | `#9F2B23` | `rgba(214, 69, 58, 0.16)` | Compass Shield |
| Cobalt Syndicate | `#2667B8` | `#184785` | `rgba(38, 103, 184, 0.16)` | Harbor Anchor Shield |
| Marigold House | `#D48C1C` | `#9C620D` | `rgba(212, 140, 28, 0.17)` | Sunburst Crown Shield |
| Emerald Atelier | `#248A63` | `#156145` | `rgba(36, 138, 99, 0.16)` | Laurel Arch Shield |

House colors never flood full HUD panel backgrounds; they act as bold territorial borders,
heraldic crests, fluttering banners, awnings, leaderboard badges, and Chronicle stripes. Every
House pairs its color with a distinct geometric crest so ownership stays unambiguous even under
color-vision deficiency or zoomed-out camera views.

### Territorial ownership on the canvas

Player ownership is readable in a single glance at every zoom level:

- **Bold lot kerb:** Every owned lot frames its perimeter in a crisp, double-stroked House-colored
  kerb (primary fill + deep trim outer edge) that cleanly separates owned blocks from vacant sage
  lots.
- **Contiguous enclave wash:** When a House owns two or more orthogonally adjacent lots, the
  shared boundary softens into a warm translucent House wash and continuous outer district trim,
  making emerging merchant quarters unmistakable.
- **Tall House banner & crest medallion:** Every owned shop and civic landmark flies a crisp tall
  standard with a gently waving House pennant and an inset white-and-brass heraldic emblem drawn
  above the roofline (and rendered after the twilight color grade so crests stay bright at dusk).
- **Milestone stars:** Each Dynasty Milestone earned by a House adds a brass star pip beside its
  crest on the leaderboard and gilded trim on its flagship banners.

### Form, lighting, and era progression

- Flat tonal isometric solids with distinct lit top, mid left, and shaded right faces.
- Every shop archetype has a unique silhouette that grows across three levels (Level 2 adds an
  upper story; Level 3 adds rooftop terraces/pergolas and brass cornices once unlocked in Era III).
- Each Era sweeps through one full sunlit day: Morning Amber → Crisp Sunlit Noon → Golden Hour →
  Twilight Lantern Glow, with additive warm lights at dusk (shop windows, streetlamps, café
  string lights, cinema marquees, tram headlamps, and nightmarket lanterns).
- As the city advances from Era I to Era IV, subtle environmental maturity appears on the slab:
  canal-side pennant lines in Era II, grand brass boulevard lamps and denser tourist ferries in
  Era III, and gilded civic garlands in Era IV.
- Weather and city events transform the scene directly: slanted rain and canal ripples for
  Cloudburst, a berthed liner at the Harbor Pier for Harbor Cruise, a third pennanted tram for
  Free-Ride Tram Day, and drifting golden lanterns for the Street Lantern Festival.

### Typography

- **Fraunces** — wordmark, Era banners, Council headers, Chronicle headlines, Final Edition.
  Fallback `Georgia, serif`.
- **DM Sans** — interface labels, build dock, Inspector, onboarding steps. Fallback
  `system-ui, sans-serif`.
- **JetBrains Mono** — cash, Crown Index, percentages, countdowns, room codes (always
  `tabular-nums`). Fallback `ui-monospace, monospace`.

### Anti-slop rules

No dark purple neon, no Inter, no glowing generic CTAs, no emoji-as-interface, no heavy drop
shadows or glassmorphic clutter over the city. Surfaces use warm Linen with crisp ink hairlines
(`1px solid rgba(30, 26, 22, 0.16)`) and tight `6px` corners. All icons and House crests are
bespoke inline SVG.

## 2. Layout and interaction

The isometric canvas fills `100vw × 100dvh`. Persistent HUD pieces hug the edges so 85% or more
of the viewport remains uninterrupted city at 1440×900:

| Surface | Dock | Role |
| --- | --- | --- |
| **Era & Clock chip** | Top left | Wordmark, active Era name & progress bar (`Era I · Founding`), daypart dial, speed controls (`Pause`, `0.5×`, `1×`, `2×`, `3×` in solo; host pace in MP), Fit, Sound, Leave |
| **Mercadia Chronicle** | Top center-left | Punchy live Event Stream: prominent active Dispatch Banner (crest/icon + bold headline + mechanical impact tag) plus a compact collapsible 3-line recent feed with category stripes and click-to-focus jumps |
| **Leaderboard & Dynasty strip** | Top right | Four Houses in rank order with heraldic crests, Milestone stars, Crown Index, expandable `Worth + Share + Prestige` breakdown, market-share bar, and a compact Milestone progress pill |
| **Founding Guide** | Upper-left below clock (self-retiring) | Three-step first-60-seconds guide that advances automatically as you build, inspect, and shape a block, with one-click dismiss; vanishes permanently once done |
| **Treasury chip** | Bottom left | Cash, debt, `Borrow §400` with exact per-era rate, active Dynasty Charter badges, and Ledger drawer toggle |
| **Build dock** | Bottom center | Six shops and three civic projects with Era lock badges (`Era II`, `Era III`) on future-era tools, cost, unmet-demand pips, and concise hover tooltips |
| **Inspector** | Right edge (bottom sheet on mobile) | Opens on clicking a shop, lot, or citizen; leads with the one-line diagnosis and House crest; closes with `Esc` |
| **Era Council modal** | Centered compact card between Eras | Appears at the close of Eras I, II, and III: celebrates newly unlocked builds with icons, shows Era standings deltas, and presents three **Dynasty Charters** to adopt before advancing |
| **Spectator notice** | Bottom center | High-contrast ink on cream Linen (`≥ 10:1` contrast) replacing the dock for latecomers |

### Mobile parity (`390×844`)

- Single-row ranked score strip at top with House crests, short names, and Crown Index; tapping
  expands the full `Worth + Share + Prestige` and Milestone breakdown.
- Compact single-headline Chronicle bar beneath the strip showing the latest loud dispatch and
  impact tag; tapping expands the recent Chronicle feed without obscuring the play area permanently.
- Founding Guide collapses to a slim one-line prompt above the dock and retires automatically.
- Build dock switches cleanly between `Shops (6)` and `Civic (3)` tabs with Era lock badges
  clearly legible and zero horizontal clipping.
- Fit view frames the entire island tip-to-tip; first tap previews a blueprint and civic reach,
  second tap builds; Inspector opens as a bottom sheet (max 42% viewport height) and pans the
  selected block into the open city strip above it.
- Era Council modal stacks cleanly in a single scrollable column with large tap targets.

### Controls and focus

Drag or WASD/arrows to pan, wheel or `+`/`-` to zoom about the cursor, click to inspect, `1`–`9`
for build tools (ignoring locked future-era tools with a clear unlock toast), `Esc` to cancel,
`Space` to pause in solo, `M` to mute, `F` to fit. Build and speed hotkeys are cleanly disabled
while Title, Lobby, Era Council, or Final Edition overlays are open.

## 3. Event stream & feedback craft

The **Mercadia Chronicle** makes every turning point loud, legible, and rewarding:

- **Tier 1 — Major Dispatches (Headline Banner + Audio Sting):** Era transitions, Dynasty
  Milestone unlocks, Crown Index lead changes, City Events (forecast, start, receipt), and
  rivalry clashes (Promo Blitzes or direct same-trade undercuts). Each displays a crisp crest or
  category badge, bold Fraunces/DM Sans headline, and a high-contrast mechanical impact pill
  (e.g., `Cinema +45%`, `+§80 · ★1`, `New Leader`).
- **Tier 2 — Chronicle Stream (Recent Feed):** Keeps the latest 3–4 dispatches scannable in a
  tight Linen stack with 3 px colored left rules (Brass = Era/Milestone, Canal = City Event,
  House color = Rivalry/Build). Dispatches tied to a lot include a subtle focus affordance that
  smoothly pans the camera to the action.
- **Canvas feedback:** Floating brass coin pops (`+§24`), delight stars, queue/stockout badges,
  Era unlock shimmer rings, and bright Promo Blitz pills drawn after the color grade so they
  remain sharp even at twilight.

## 4. Sound

Procedural Web Audio synthesis (zero audio file assets): wooden build thud, brass coin chime,
two-strike tram bell, newspaper rustle for Gazette dispatches, warm chord fanfare for Era
transitions and Milestone unlocks, subtle charter seal click, and soft rain hiss. Audio activates
on first user gesture with a persistent mute toggle (`aria-pressed`).

## 5. Architecture boundaries

- **Pure shared simulation core:** Zero DOM or Worker globals; seeded deterministic PRNG; owns
  district map, pathfinding, citizens, trams, four-era progression, Dynasty Charters, Milestones,
  AI Houses, scoring, Chronicle generation, lobby/room state machine, and compact snapshot wire
  protocol.
- **Single simulation, dual host:** Solo runs the shared simulation loop in the browser;
  multiplayer runs the exact same simulation inside a Cloudflare Worker + SQLite-backed Durable
  Object using WebSocket Hibernation and 10 Hz authoritative snapshots (full snapshot on join or
  reconnect, compact delta snapshots during play).
- **Resilient sessions:** Seat tokens persist across reloads and closed tabs with heartbeat-based
  tab protection so a returning player reclaims their exact seat rather than becoming a spectator.
  Host migration promotes the next connected human automatically. Checkpoints upgrade cleanly
  across schema versions.
- **Renderer and HUD:** Canvas 2D 2:1 isometric renderer with 60 FPS interpolation between 10 Hz
  ticks, zoom-bucketed sprite caching, automatic GPU/CPU canvas fallback, and declarative HUD
  binding over the shared view store.
- **Verification hook:** Read-only client inspection window exposing live state, era, unlocks,
  milestones, chronicle lines, and tile projection, with deterministic time-warp gated strictly to
  localhost or `?dev=1`.

## 6. Pacing and tuning principles

- **Deliberate Dynasty Civ cadence:** Standard matches run four Eras (~150–180 seconds per Era at
  1×, ~10 minutes total including brief Era Councils); Blitz runs four brisk Eras (~60–75 seconds
  per Era, ~4–5 minutes total) so every mode experiences the full Era I → IV arc, Charter choices,
  and unlock curve.
- **Breathable opening:** In Era I, AI Houses stagger their opening claims thoughtfully and
  expand at a measured pace so human players have time to read the street, complete the Founding
  Guide, and claim prime corners without feeling ambushed in the first ten seconds.
- **Compounding progression:** Early shops fund Era II transit corridors and Era III prestige
  flagships; Dynasty Charters and Milestones reward coherent specialization (craft quality,
  transit patronage, financial discipline, or canal prestige) while keeping multiple paths to
  the Crown competitive.
- **Fair scoring:** `Crown Index = Net Worth ÷ 10 + Market Share % × 3 + Civic Prestige × 4`,
  sampled every daypart across all four Eras for the Final Edition's chart.
