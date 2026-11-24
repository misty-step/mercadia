# MERCADIA — Design

This document describes how MERCADIA looks, feels, sounds, and is built. It is written in the
present tense as living truth for the product. [PRODUCT.md](PRODUCT.md) owns the rules, and
nothing here overrides its turn contract: the world is frozen during planning and changes only
when a turn resolves.

## 1. Visual direction — the Architectural Monograph board

MERCADIA reads as a plate from a fine architectural monograph laid flat on a table: a carved
travertine slab printed with the canal district in precise ink linework, flat tonal stone and
House color, and quiet hairline annotation. It is tactile and still. Pieces sit on the board the
way tokens sit on a printed map; they move only when a turn resolves.

- **Stillness is the default.** The board has no ambient animation: no walking crowds, drifting
  boats, waving banners, or day-night sweep. A static board makes the frozen world obvious.
- **Printed, not glowing.** Light comes from paper and stone. No bloom, neon, glassmorphism,
  heavy drop shadows, or gradients over the board.
- **Annotation over chrome.** Labels, leader lines, and dimension-style callouts in ink do the
  work that panels and badges do elsewhere.

### Palette

| Token | Hex | Use |
| --- | --- | --- |
| Alabaster | `#F7F4EE` | Page canvas, HUD surfaces, drawers, cards |
| Travertine | `#E8E0CF` | Board slab, paving, plate mat |
| Travertine deep | `#D6CBB4` | Slab edge, shaded faces, inactive fills |
| Ink | `#16130F` | Primary text, linework, primary button fill |
| Graphite | `#4A443C` | Secondary text (≥ 7:1 on Alabaster) |
| Hairline | `rgba(22, 19, 15, 0.18)` | 1px rules, panel borders, grid lines |
| Canal | `#3E7F8C` | Grand Canal and harbor water, hatched |
| Sage | `#8FA58E` | Parks, vacant lots, foliage |
| Terracotta | `#B65A3C` | Roofs, civic accents, `Reconnecting…` rule |
| Brass | `#B8893A` | Era marks, Milestone stars, `Waiting…` rule; never small text |
| Alert | `#9F2B23` | Error rule and error text (≥ 7:1 on Alabaster) |

High contrast is mandatory: body text is Ink on Alabaster (≥ 15:1); secondary text is Graphite or
darker; no text sits on a House color or on the board without an Alabaster backing. Focus rings
are a 2px Ink outline with a 2px Alabaster offset, visible on every surface.

### House palette and heraldry

| House | Primary | Deep Trim | Soft Wash | Crest Emblem |
| --- | --- | --- | --- | --- |
| Vermilion Guild | `#D6453A` | `#9F2B23` | `rgba(214, 69, 58, 0.16)` | Compass Shield |
| Cobalt Syndicate | `#2667B8` | `#184785` | `rgba(38, 103, 184, 0.16)` | Harbor Anchor Shield |
| Marigold House | `#D48C1C` | `#9C620D` | `rgba(212, 140, 28, 0.17)` | Sunburst Crown Shield |
| Emerald Atelier | `#248A63` | `#156145` | `rgba(36, 138, 99, 0.16)` | Laurel Arch Shield |

House colors never fill HUD panels. They appear as lot kerbs, territory washes, banners, unit
tokens, crest badges, a 3px rule on ledger and leaderboard rows, and the handoff screen's crest.
Every House pairs its color with a distinct geometric crest, so ownership stays unambiguous under
color-vision deficiency and at any zoom.

### The board

- **Isometric plate:** a 12×12 isometric district on a travertine slab, flat tonal solids with lit
  top, mid left, and shaded right faces, outlined in 1px ink. Water is Canal with fine engraved
  hatching; streets carry a quiet hairline grid so tiles and movement ranges read clearly.
- **Ownership:** every owned lot has a double-stroked kerb (primary fill, deep-trim outer edge).
  Two or more orthogonally adjacent owned lots share one continuous outer trim and soft House
  wash. Each owned shop and civic landmark carries a still banner with an inset crest medallion.
- **Units:** House units are upright tokens with a travertine base disc, House-colored body, and
  crest: Factor (slim column), Watch Company (shield-faced block with Cohesion pips), Barge (low
  hull on water). Tokens are at least 28px tall at default zoom.
- **Citizens:** last turn's footfall stands as small ink-and-wash figures at the shops they used,
  grouped by archetype silhouette; lost demand shows as a short hairline tally beside the door.
- **Era maturity:** each Era adds still detail to the plate (canal pennant lines in Era II, brass
  boulevard lamps and ferries in Era III, gilded civic garlands in Era IV).
- **Daypart:** each turn's daypart (Morning, Noon, Golden Hour, Twilight) is a gentle print-tone
  shift applied once when the turn resolves, never a continuous sweep. Contrast of linework and
  crests is preserved at Twilight.
- **Events:** active city events print on the board (rain hatching for Cloudburst, a berthed liner
  at the Pier for Harbor Cruise, lantern marks for the Lantern Festival), with a callout naming
  the turns remaining.

### Planning overlays (drawn from the draft, never from the world)

- **Movement range:** selecting a unit shades reachable tiles with a dotted hairline boundary;
  blocked tiles are hatched.
- **Planned path:** a dashed ink line with a numbered endpoint (the order's queue number).
- **Planned building:** a ghost outline of the building on its lot, labelled with cost.
- **Contest:** a short double-headed ink arrow between the two units, labelled with expected
  damage from the deterministic formula.
- **Change markers:** after resolution, every tile that changed carries a small numbered ink
  marker keyed to its line in the Turn Delta. Markers clear when the player queues the next
  order or dismisses them.

### Typography

- **Instrument Serif** — wordmark, Turn number, Era titles, drawer headings, Council and Final
  Edition headlines, handoff screen House name. Regular and italic only. Fallback
  `"Iowan Old Style", Georgia, serif`.
- **IBM Plex Sans** — all interface labels, buttons, Inspector, ledger descriptions, guide text.
  400, 500, 600. Fallback `"Helvetica Neue", Arial, sans-serif`.
- **IBM Plex Mono** — every number: §, Actions, Turn #, Crown Index, percentages, state hash, room
  codes. 400 and 500, `font-variant-numeric: tabular-nums`. Fallback
  `ui-monospace, Menlo, monospace`.
- All three families are self-hosted `woff2` files served from the app's own origin with
  `font-display: swap`. No third-party font CDN. **Inter is never used**, including in fallback
  stacks.

### Anti-slop rules

- No Inter, no dark purple or neon, no emoji as interface, no glowing CTAs, no heavy shadows, no
  glassmorphism over the board.
- **No dense dark panels.** Surfaces are Alabaster with a 1px Hairline border and `4px` corners.
  The only large Ink-filled element is the End Turn button.
- **No pill clutter.** Status, impact, and tags are plain text with a mono value and, at most, one
  small glyph or a 3px colored rule. Capsule badges are not used for Chronicle lines, ledger
  rows, lot bonuses, or House status. At most one badge (Era lock) per tool.
- All icons and House crests are bespoke inline SVG.

## 2. Layout and interaction

The board fills `100vw × 100dvh`. The HUD hugs the edges; at least 75% of the viewport at 1440×900
stays open board with drawers closed.

| Surface | Dock | Role |
| --- | --- | --- |
| **Turn plate** | Top left | Wordmark; `Turn 12` in Instrument Serif; `Era II · Transit & Trade · Noon` and `Turn 4 of 8 in Era`; Turn Delta button; Fit, Sound, Leave |
| **Status line** | Top center | One line of connection and turn state: `Your turn`, `Waiting for opponent…`, `Resolving Turn 12…`, `Reconnecting…`, or an error; `role="status"` (errors `role="alert"`) |
| **Leaderboard** | Top right | Houses in rank order with crest, Milestone stars, Crown Index, expandable `Worth + Share + Prestige`; in rooms and hotseat, each human row shows `Ready` or `Planning` and presence (`Connected`, `Offline`) in text |
| **Chronicle** | Below Turn plate | The latest dispatch on one line with its mono impact and a jump-to-tile link; expands to the last eight lines |
| **Founding Guide** | Below Chronicle, self-retiring | Three steps (move your Factor, found a shop, end your turn); one-click dismiss; never returns once done |
| **Command rail** | Bottom, full width | Left: Treasury (cash, projected cash after queued orders, debt, Borrow). Center: Order dock with text tabs `Build · Units · Trade · Pacts · Study`. Right: `Actions 3 of 6`, `Orders (3)` queue toggle, and the **End Turn** button |
| **Orders queue** | Right drawer | Numbered list of queued orders with cost, Action, and an Undo control per row; `Undo last` and `Clear all` |
| **Inspector** | Right drawer (bottom sheet on mobile) | Lot, shop, unit, or citizen detail; leads with a one-line diagnosis and House crest; issues orders for the selection |
| **Turn Delta drawer** | Right drawer (bottom sheet on mobile) | The exact Turn N→N+1 ledger; opens automatically after every resolution |
| **Council turn card** | Centered card on the first turn of Eras II–IV | New unlocks, Era standings, three Charter choices; stays until a Charter is chosen; no countdown |
| **Handoff screen** | Full screen (hotseat) | Alabaster field, large crest, `Pass to Cobalt Syndicate`, and one `Begin Cobalt's turn` button; hides the previous draft |
| **Spectator line** | Replaces Command rail | `Watching as spectator — Turn 12` in Ink on Alabaster |

Only one right drawer is open at a time; opening another replaces it. Drawers never cover the
Command rail or the Turn plate.

### Turn controls

- **End Turn** is the single primary button: Ink fill, Alabaster IBM Plex Sans 600 label, at least
  56px tall and 168px wide on desktop, with a mono `Enter` hint. It is always visible during
  play.
- In a room, End Turn marks the seat Ready for the current turn. The button then becomes an
  outlined `Cancel Ready` and the Status line reads `Waiting for opponent…` (or
  `Waiting for 2 opponents…`), naming who is still planning. When the last seat is Ready, both
  read `Resolving Turn 12…` until the authority's result arrives.
- When End Turn is unavailable, it stays visible, disabled, and labelled with the reason:
  `Choose a Charter`, `Reconnecting…`, `Resolving Turn 12…`, or `Spectating`.
- **Actions remaining** sits beside End Turn as `Actions 3 of 6` in mono; it turns to Graphite
  `Actions 0 of 6` when spent and the dock disables Action-costing tools with the reason.
- After each resolution End Turn ignores the remainder of the activating gesture (a held key,
  key auto-repeat, or a double-click or double-tap), so one deliberate press advances one turn.

### Turn Delta drawer

- Heading in Instrument Serif: `Turn 11 → 12`, with the short state hash in mono (`#4f1a·c9e2`).
- Sections separated by hairline rules, in resolution order: **Movement**, **Combat**,
  **Production & buildings**, **Treasury**, **Events & score**. Empty sections are omitted.
- Each line is one sentence fragment plus a right-aligned mono value (`Roastery C4 sales · 18
  citizens  +§212`). Numbered lines match the board's change markers; selecting a line pans to
  the tile.
- The Treasury section ends with a ruled reconciliation: `Opening §640 + Income §512 − Costs §390 −
  Upkeep §118 + Financing §0 = Closing §644`.
- Rival activity appears under each section with that House's crest and 3px rule, public
  information only.
- Compact by default (top eight lines per section, `Show all` to expand). Opens automatically
  after resolution; closes with its Close button, `Esc`, or `T`; reopens from the Turn plate. The
  latest four Turn Deltas are browsable with previous and next controls.

### Controls and focus

- **Pointer and touch:** drag to pan, wheel or pinch to zoom, click or tap to select; with a tool
  armed, the first tap previews and the second tap queues.
- **Keyboard:** `WASD` or arrow keys pan when the board is not focused; `+`/`-` zoom; `1`–`9`
  arm order tools (locked tools show an unlock toast); `Esc` cancels the armed tool, closes the
  open drawer, or returns focus to the page; `Ctrl+Z` or `Backspace` undoes the last queued order;
  `O` toggles the Orders queue; `T` toggles the Turn Delta; `F` fits the board; `M` mutes.
- Single-key shortcuts (including `Backspace`) never fire while a text field has focus.
- **Board focus:** `Tab` reaches the board like any control. While the board has focus, arrow keys
  move a visible tile cursor and `Enter` or `Space` select or act on that tile.
- **Enter and Space end the turn only when no control has focus.** When focus is on the page body
  (no focused button, link, input, select, textarea, contenteditable, or the board), `Enter` or
  `Space` activates End Turn. When any control is focused, `Enter` and `Space` do exactly what
  they normally do for that control (activate the focused button, type a space, toggle the
  checkbox) and never end the turn. They also never end the turn while the Council card, handoff
  screen, a confirmation, or the Final Edition is open, with a modifier key held, during IME
  composition, or on key auto-repeat.
- Every action available by pointer is available by keyboard, and vice versa; a full turn can be
  planned and ended keyboard-only.

### Mobile parity (`390×844`)

- **Top strip:** Turn number, Era and daypart, and a compact ranked crest row with Crown Index;
  tapping the row expands the full leaderboard and Ready states.
- **Status line** sits directly beneath the top strip, always one line, never covered.
- **Bottom Command rail** in the thumb zone: Treasury and `Actions 3 of 6` on the left, a
  full-height **End Turn** on the right at least 56px tall and 140px wide; the Order dock sits
  above it as five text tabs with tools in a single scrollable row. No horizontal clipping.
- Every tap target is at least 48×48px with at least 8px spacing; tile selection snaps to the
  nearest lot so small tiles stay easy to hit.
- Inspector, Orders queue, and Turn Delta open as bottom sheets (Inspector up to 50% height, Turn
  Delta up to 70%) with a 48px Close button and a drag handle, and pan the selected tile into the
  visible board above.
- The Council card and handoff screen stack in one scrollable column with full-width buttons.
- Layout respects `env(safe-area-inset-*)`; nothing important sits under the home indicator.
- Mobile has full parity: every order, undo, End Turn, Ready, Cancel Ready, and the Turn Delta are
  reachable by touch.

### Motion

Motion is restrained and never represents time passing in the world. Drawer and sheet transitions
are at most 180ms (opacity and translate). After resolution the board switches from Turn N to
Turn N+1 in one step and change markers appear; there is no tweening of units or citizens and no
interpolation between states. With `prefers-reduced-motion: reduce`, all transitions are instant.
The canvas redraws only on state change, input, or resize; there is no continuous animation loop.

## 3. Chronicle and feedback craft

- **Chronicle lines** are ledger-style: crest or category glyph, a plain IBM Plex Sans phrase, and
  a mono impact (`Cinema demand +45%`, `+§80 · ★1`, `New leader`). A 3px left rule encodes
  category (Brass = Era or Milestone, Canal = city event, House color = rivalry, build, or pact).
  Lines tied to a tile have a jump-to-tile control.
- **Major moments** (Era transition, Milestone, lead change, Final Edition) get an Instrument
  Serif headline at the top of the Turn Delta and a sound cue, not a banner over the board.
- **Planning feedback** is immediate and local: queuing an order adds its numbered overlay and
  updates Actions and projected cash; an illegal order shows its reason inline (`Not enough § —
  needs §280, have §190 projected`).
- **Connection and error states** use the Status line with a 2px left rule: Brass for waiting,
  Terracotta for reconnecting, Alert for errors, always with plain text. Errors never disappear on
  their own while still true.

## 4. Sound

Procedural Web Audio synthesis, no audio files: a soft paper tap when an order is queued, a
reverse tap on undo, a wax-seal stamp on End Turn or Ready, a two-strike tram bell when a turn
resolves, a warm chord for Era transitions and Milestones, a charter seal click, and a newspaper
rustle for the Final Edition. Sounds play only in response to player actions or resolutions,
never on a timer. Audio starts on the first user gesture; mute is a persistent toggle with
`aria-pressed`.

## 5. Architecture boundaries

- **Pure deterministic core (`src/shared`).** No DOM, Worker, network, `Date`, `Math.random`, or
  timer use. The core exposes match creation from a seed and config; draft validation; AI order
  generation as a pure function of state and seat; `resolveTurn(state, orders) → { state,
  summary }` running the five steps in order; canonical order sorting; and a stable state hash.
  Randomness comes from a seeded PRNG whose stream is derived from the match seed, turn number,
  and purpose (events, AI per seat), so results never depend on call order elsewhere.
- **One core, three hosts.** Solo and hotseat run the core in the browser. Network rooms run the
  same core inside one Cloudflare Worker and a SQLite-backed Durable Object per room using
  WebSocket Hibernation. The Durable Object has no tick, alarm-driven simulation, or interval
  loop; it changes world state only inside a resolution.
- **Room authority.** The Durable Object persists, in one transaction per resolution: the state,
  the canonical action log, the turn summary, and the last resolved turn. Ready sets and drafts
  are stored per turn. Resolution is guarded by the stored last resolved turn, so concurrent or
  repeated Ready messages resolve a turn exactly once.
- **Wire protocol.** Client → authority: `hello` (room code, seat token, last seen turn),
  `draft` (turn, revision, orders), `ready` (turn), `cancelReady` (turn), `ping`. Authority →
  client: `state` (full state, phase, seat draft and Ready flag, seats' Ready and presence, latest
  summary; sent on every join and reconnect), `seats` (Ready and presence changes), `resolved`
  (turn N → N+1, summary, state hash), `error` (code, message), `pong`. `ping` and `pong` never
  reach the core. There is no polling and no snapshot interpolation.
- **Client sessions.** Seat tokens persist in `localStorage` per room; reconnect uses exponential
  backoff and shows `Reconnecting…` until a fresh `state` arrives, then reconciles the local draft
  by revision. The room URL is `/?room=ABCD`; the socket is `/ws/rooms/ABCD`.
- **Renderer and HUD.** Canvas 2D 2:1 isometric renderer with zoom-bucketed sprite caching and
  on-demand redraw; the declarative HUD binds to a view store derived from the current state and
  the local draft.
- **Verification hook.** A read-only `window.__mercadia` inspector (localhost or `?dev=1` only)
  exposes phase, turn, state hash, the latest summary, the local draft, and seed plus action log
  export for replay. It cannot mutate state, skip turns, or warp time.
- **Content Security Policy.** Served with `default-src 'self'; script-src 'self'; style-src
  'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'`. No inline scripts, inline event handlers, or
  third-party origins.

## 6. Turn tuning principles

- **Decision weight over speed.** A Standard match is 32 turns, Blitz is 16. Each turn should offer
  two or three meaningful choices; Actions are tight enough that every order matters.
- **Breathable opening.** In Era I, AI Houses expand at a measured rate (at most one new property
  each per turn) so new players can claim prime corners without being ambushed on Turn 1.
- **Compounding progression.** Early shops fund Era II corridors and Barges, then Era III prestige
  flagships; Charters, Milestones, and Guild Studies reward coherent specialization while keeping
  several paths to the Crown competitive across seeded matches.
- **Readable conflict.** Contests are deterministic and previewed with expected damage, so combat
  is a planning decision, never a dexterity test.
- **Fair scoring.** `Crown Index = Net Worth ÷ 10 + Market Share % × 3 + Civic Prestige × 4`,
  recomputed once per resolved turn and sampled every turn for the Final Edition chart.

## 7. QA

Every visual and interaction change is checked in real browsers at **1440×900** (desktop),
**1024×768**, and **390×844** (portrait, touch emulation):

- Title, solo planning with queued orders and overlays, End Turn by click, `Enter`, `Space`, and
  tap, the Turn Delta drawer or sheet open and closed, a Council turn, the hotseat handoff screen,
  a room in `Waiting for opponent…`, `Reconnecting…` after a dropped connection, an error state,
  and the Final Edition.
- Turn #, `Actions n of m`, treasury, and End Turn are visible and unclipped at every size; no
  text overlaps; drawers never cover the Command rail.
- With a button, input, or the board focused, `Enter` and `Space` perform that control's normal
  action and do not end the turn; with nothing focused they end it exactly once.
- A full turn can be completed keyboard-only on desktop and touch-only at 390×844; mobile tap
  targets are at least 48×48px; focus rings are visible on every control.
- Text contrast meets the ratios in the palette; ownership is distinguishable in grayscale.
- **Console and CSP cleanliness:** across solo, hotseat, and two-browser room sessions including a
  reload and an offline/online reconnect: zero console errors or warnings, zero uncaught page
  errors, zero `securitypolicyviolation` events, and zero failed network or WebSocket requests.
- The served pages load no fonts or scripts from third-party origins, and no element uses Inter.
