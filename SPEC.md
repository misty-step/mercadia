# SPEC — how MERCADIA v3 realises PRODUCT.md / DESIGN.md

The folio owns the rules; this file records the implementation decisions it leaves open.

## Core (`src/shared`)
- `resolveTurn(game, canonicalOrders) → {game, summary, committed}` is pure: structuredClone + seeded streams
  `stream(seed, turn, purpose)`; no Date/Math.random/timers. `canonicalOrders` prunes human drafts with the same
  checks used at planning and computes AI orders with `planAI` (a function of seed + frozen state only).
- State hash = canonical (sorted-key) JSON folded to 16 hex chars; short form `#abcd·ef01`.
- Phases at rest are `planning | ended`; RESOLVE_TURN and TURN_SUMMARY happen inside `resolveTurn`.
- Initiative rotates (`first = (N−1) mod seats`); each step orders Houses by Initiative, then unit/lot id, then queue sequence.
- Draft = ordered `Order[]`. `pruneDraft` replays it against the frozen state; undo removes the order and prunes dependents.
- Budgets: Actions 5/6/7 (+1 Heralds charter, +1 District Sovereign); treasury ≤ cash + queued borrowing.
- Construction reach: orthogonally adjacent to existing property, or within one tile of a Factor at its projected position.
  Queued (not yet built) property never extends reach, so build order cannot change legality.
- Movement: shortest legal path; a unit passes through its own units, never stops on one, paths around rivals when it can,
  otherwise halts before a held tile (`Blocked`). Barges pass under bridges but stop only on canal tiles.
- Contest: Chebyshev-adjacent after Movement, deal Strength, survivor strikes back (+1 defending a bridge or own frontage).
- Barge route: one-way water distance from the harbor mouth (x7,y10) ≤ 3 × move; blocked if a rival unit sits on the route.
- Footfall: sources (homes, Station, Pier, city and owned Tram Stops) emit citizens per Era/daypart/event; each is allocated to the
  best-scoring reachable shop; losses are attributed to the top-ranked shop with a reason (too pricey / queue full / out of stock / blockaded).
- Treasury: `Opening + Income − Costs − Upkeep + Financing = Closing`; forced sale, disband and `Forgiven` follow PRODUCT.md.
- Start tiles: two Houses begin beside Grand Station, two beside the Harbor Pier (a single corridor deadlocks four Houses).
- Council turns: `game.council.offers[player]`; End Turn is blocked (`readyBlock`) until a `charter` order is in the draft.

## Room authority (`src/shared/room.ts`)
One message at a time. Per player and turn: draft+revision, Ready flag, readiness epoch (+1 per accepted Ready/Cancel Ready).
Off-turn Ready/Cancel Ready → one `state` for the CURRENT turn (own draft/flag/epoch, that state's own latest summary) to that seat only.
Resolution runs when the last human seat's Ready is recorded, guarded by `lastResolved`; `resolved` carries state + summary together.
The Durable Object persists room + game in one `transactionSync` per handled message; pings never reach the core.

## Client
`Session` (solo/hotseat via `LocalMatch`, room via WebSocket + `RoomClient` reconciler), `Board` (still canvas, one rAF per dirty flag),
`HUD`, `screens`. `window.__mercadia` is a read-only inspector on localhost / `?dev=1`.

## Known limits
- Balance is workable, not tuned: the two Pier-start Houses are weaker for AI personas.
- Acceptance 10-repeat and 16 (dropped readyAck+resolution; pending work across resolution) are covered by session/DST unit tests but their browser flows are not green in `scripts/smoke.mjs`.
- Acceptance 14b–e and 12/13 in a browser are not scripted (replay and AI determinism are unit-tested; replay of an exported browser match is verified in node).
