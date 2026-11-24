# MERCADIA — Product

> *Rival merchant dynasties reshape a canal-and-tramway city, one deliberate turn at a time.*

MERCADIA v3 is a strict, discrete turn-based dynasty civ for one to four Houses. Each player
leads a merchant House across four Eras: claiming lots in a canal district, opening shops,
moving Factors, Barges, and Watch Companies across the board, brokering pacts, pursuing Guild
Studies, adopting lasting Dynasty Charters, and investing in civic placemaking. The city never
moves on its own. Nothing in the world changes until every human seat has finished its turn;
then one pure, deterministic resolution advances the district from Turn N to Turn N+1 and prints
an exact ledger of what changed.

## Product contract

These rules are the product. Anything elsewhere in this folio that conflicts with them is wrong.

1. **The world is frozen while you think.** During planning the authoritative world does not
   advance: no walking citizens, no accruing sales, no wages, no event countdowns, no
   expiring choices. A player may inspect the board indefinitely.
2. **Only an explicit human decision advances the game.** The game advances only when a player
   presses **End Turn** (solo and hotseat) or when every human seat in a room has explicitly
   marked itself **Ready** for the current turn. No timer, countdown, idle timeout, heartbeat,
   reconnect, page load, or AI action can cause a resolution.
3. **One turn resolves exactly once.** A turn number resolves once and only once. Retries,
   duplicate messages, reconnects, and reloads never resolve a turn twice or skip a turn.
4. **Same seed, same orders, same world.** Resolution is a pure function of the previous state
   and the canonical orders for that turn. Replaying a match from its seed and canonical action
   log reproduces every turn bit-for-bit, on any device and on the server.
5. **Every change has a receipt.** Each resolution produces a concise, exact Turn N→N+1 delta
   ledger: every § gained or spent, every unit moved, blocked, damaged, or lost, every building
   completed, every event and score change.

### Clean-room replacement of the v2 simulation

The v2 real-time simulation (a ticking city with speed controls, timed Era Councils, a clock-based
economy, polling, 10 Hz snapshots, client-side snapshot interpolation, and a time-warp debug
hook) violates this contract and is replaced, not adapted. v3 is built clean-room around the turn
state machine below. No v2 tick loop, pace control, countdown, or interpolation path survives in
the shipped product. The v2 setting, Houses, heraldry, shops, civic projects, Eras, Charters,
Milestones, and Crown Index carry over as described here, re-expressed in turns.

## Who it is for

- A solo strategist who wants a thoughtful dynasty match against three AI Houses with distinct
  temperaments, and who wants to pause mid-thought for as long as they like.
- Two to four friends on one shared device (hotseat) or in a networked room via a shareable room
  URL, who want a tense, readable battle for canal districts, transit corridors, and Crown
  supremacy with no one rushed by a clock.
- Anyone who enjoys a tactile board: the title screen opens onto the canal district laid out as an
  architectural monograph plate, ready to inspect.

## The promise

1. **Think as long as you want.** Every decision is made on a frozen board with full information
   about your own House and all public information about rivals.
2. **Clarity in the first sixty seconds.** The objective (*Highest Crown Index after Era IV*), the
   Turn number, actions remaining, and the primary **End Turn** button are always visible. A
   compact, self-retiring Founding Guide points to high-value starter corners and your first
   Factor move, then disappears for good.
3. **Unmistakable House ownership.** Every House shows a distinct heraldic crest alongside its
   color on banners, lot kerbs, contiguous block borders, unit tokens, leaderboard rows, and ledger
   lines.
4. **Era unlocks that evolve the district.** Advancing through Eras and crossing Dynasty
   Milestones unlocks higher-tier shops, Level 3 architecture, civic landmarks, and new Guild
   Studies.
5. **A ledger you can trust.** The Turn Delta drawer reconciles to the exact §, and the same turn
   produces the same summary for every player in the room.
6. **One click to play.** *Play Solo Now* starts a Standard match. *Hotseat* starts a
   shared-device match. *Create Room* yields a four-letter code and a shareable room URL.

## The turn state machine

The simulation core is a pure, deterministic, seedable state machine with exactly three phases
that repeat until victory:

```
            ┌───────────────────────────────────────────────────────────────┐
            ▼                                                               │
   PLANNING (Turn N) ──End Turn / all humans Ready──▶ RESOLVE_TURN ──▶ TURN_SUMMARY (N→N+1)
   frozen world                                        1 Movement           exact delta ledger
   queue / undo orders                                 2 Combat             then PLANNING (N+1)
   inspect indefinitely                                3 Production & buildings
                                                       4 Treasury & upkeep
                                                       5 Events & victory
```

### PLANNING — the frozen board

- The authoritative world for Turn N is immutable. Its state hash does not change for the whole
  phase, however long it lasts.
- Each human seat drafts a private order queue against that frozen state. Orders may be queued,
  reordered, edited, and undone freely (any order, not just the last). Undoing an order that a
  later order depends on (for example, a Factor move that a construction order needs) removes the
  dependent orders too, with a clear notice.
- Order types: **unit movement**, **construction** (shops, civic projects, upgrades, sale),
  **trade** (Barge routes and Harbor supply contracts), **diplomacy** (pact proposals and
  responses), **research** (Guild Study investment), and **commercial** (price stance, restock,
  auto-restock, Promo Blitz, borrow, repay), plus the Charter choice on Council turns.
- Orders are validated as they are queued against the frozen state plus the seat's own queue.
  Queuing is limited by two budgets that are always visible:
  - **Actions:** each order costs 1 Action. A House has 5 Actions per turn in Era I, 6 in Era II,
    and 7 in Eras III–IV; some Charters and Milestones add 1.
  - **Treasury:** the § cost of all queued orders may not exceed the House's cash at the start of
    the turn plus any borrowing queued earlier in the same draft. Projected cash updates with
    every edit.
- Each unit accepts at most one movement order per turn.
- A ghost preview on the board shows planned paths, planned buildings, and projected cash; it is
  drawn from the draft and never alters the world.
- AI orders for Turn N are computed once, at the start of PLANNING, as a pure function of the
  match seed, the Turn N state, and the AI seat. AI never sees human drafts, so its orders do not
  depend on when or in what order humans act.
- Planning ends only by **End Turn** (solo; hotseat after the last human seat) or by every human
  seat in a room being Ready for Turn N.

### RESOLVE_TURN — one pure resolution, in a fixed order

All committed orders for Turn N (human and AI) are sorted into canonical order and applied in five
steps, always in this sequence:

1. **Movement.** Units move tile by tile in canonical order. A unit never exceeds its movement
   allowance, never leaves legal terrain (Barges stay on canal and harbor water), and never enters
   a tile held by a rival unit; it halts on its last legal tile and the ledger records `Blocked`.
2. **Combat.** Each queued *Contest* order (a Watch Company challenging an adjacent rival unit)
   resolves as one deterministic exchange with no dice: the attacker deals its Strength plus
   modifiers as damage to the defender's Cohesion, and a surviving defender strikes back the same
   way. Units at 0 Cohesion are disbanded. A unit may move and Contest in the same turn;
   adjacency is checked after Movement. Contests between Houses under a Truce are illegal.
3. **Production & buildings.** Borrow and repay orders apply first; then construction, recruits,
   upgrades, and property sales complete; Barge deliveries land; Guild Study progress is added;
   accepted pacts take effect; remaining commercial orders apply; finally the turn's citizen
   footfall is allocated deterministically to shops and civic projects, producing sales. Each
   order's § cost is debited as it applies, in canonical order.
4. **Treasury & upkeep.** Sales and trade income are posted; wages, rent, unit upkeep, and loan
   interest are charged; Milestone dividends are paid; shortfalls are financed as described under
   *Money and treasury*.
5. **Events & victory.** City events are forecast, started, or ended; Milestones are checked;
   Crown Index is recomputed and sampled; the Era advances when its last turn has resolved; the
   Chronicle is written; victory is checked after the final turn of Era IV.

**Canonical order and stable tie-breaking.** Every step processes Houses by **Initiative**,
which rotates each turn (on Turn N the first House is seat `((N − 1) mod seats) + 1`), then by
unit or lot id, then by order sequence number. When two Houses target the same lot in one turn,
the earlier House in Initiative order wins and the other is refunded in full, with the reason in
its ledger. No step depends on message arrival order, wall-clock time, or object iteration order.

Orders that were legal at planning but are no longer legal at their step (a lot taken earlier in
the same resolution, a destination now blocked) fail cleanly with a full refund of § and Action
and a one-line reason.

### TURN_SUMMARY — the exact delta ledger

Resolution produces one immutable summary for Turn N→N+1, stored with the match, then the machine
moves straight to PLANNING for Turn N+1 (the summary phase has no timer and needs no input). The
summary is identical for every viewer of the room and lists, concisely:

- Cash: opening §, each income and cost line, financing, closing § — summing exactly.
- Units: moves, blocks, contests (damage dealt and taken), disbandments, recruits.
- Buildings: completions, upgrades, sales; failed orders with refunds and reasons.
- Commerce and trade: sales by shop, Barge deliveries, Promo Blitz effects.
- Diplomacy and research: pacts proposed, accepted, or expired; study progress and completions.
- Score: Crown Index and component deltas, rank changes, Milestones reached.
- City: events forecast, started, or ended; Era transitions.
- The resulting Turn N+1 state hash (short form), so players can confirm they see the same world.

## Core loop

1. **Orient and claim (first sixty seconds).** A single-line objective confirms the win condition.
   The Founding Guide highlights prime starter lots and suggests a first Factor move and a first
   shop. Hovering or tapping a vacant lot shows its bonuses (Corner, Canal-front, Transit), its
   footfall forecast for the next turn's daypart, and its civic reach.
2. **Plan the turn.** Queue movement, construction, trade, diplomacy, research, and commercial
   orders within your Actions and treasury. Undo anything. Inspect anything for as long as you
   like.
3. **End the turn.** Press **End Turn** (or mark Ready in a room). Resolution runs once.
4. **Read the delta.** The Turn Delta drawer opens with the exact N→N+1 ledger, and the board
   shows the resolved state with change markers on every affected tile.
5. **Advance through Eras.** After the last turn of Eras I, II, and III, the next planning phase
   is a **Council turn**: the Era Council celebrates new unlocks, summarizes the Crown race, and
   each House chooses one permanent **Dynasty Charter** as part of its orders for that turn.
6. **Reckon the Dynasty.** After the final turn of Era IV, **The Mercadia Gazette — Final
   Edition** crowns the winning House with its crest, headline, exact Crown equation breakdown,
   era-by-era market-share chart, and match honours.

## Systems

### Turns, dayparts, and Eras

Each turn is one daypart, cycling Morning → Noon → Golden Hour → Twilight as a function of the
turn number. Daypart sets citizen demand (Coffee peaks in Morning, Nightlife at Twilight) and the
board's lighting, and changes only when a turn resolves.

| Mode | Turns per Era | Total turns |
| --- | --- | --- |
| Standard | 8 (two full day cycles) | 32 |
| Blitz | 4 (one day cycle) | 16 |
| Endless | 8, continuing past Era IV | unlimited |

| Era | Name | Unlocks & Escalation |
| --- | --- | --- |
| **Era I** | Founding Charter | `Roastery`, `Bistro`, `Pocket Park`, Factor, Watch Company, Level 1–2 upgrades. Establish cash flow and claim foundational corners. |
| **Era II** | Transit & Trade | `Arcade`, `Nightmarket`, `Tram Stop`, Barge and trade routes. Commuter and evening demand swells; transit corridors and canal lanes become contested. |
| **Era III** | Grand Boulevard | `Boutique`, `Cinema`, `Festival Plaza`, Level 3 architecture. Tourists and foodies arrive in force; prestige races intensify. |
| **Era IV** | Golden Dynasty | Full district prosperity, peak civic stakes, high-impact Gazette events, and the final Crown Index reckoning. |

Locked build tools remain visible with an Era lock badge (`Era II`, `Era III`) and a plain
explanation, so players plan treasury and real estate ahead. The board visibly matures between
Eras with extra harbor and tram detail and festive architectural trim.

### Dynasty Charters (Council turns)

On the first planning phase of Eras II, III, and IV, each House chooses one permanent Dynasty
Charter from three doctrines offered for that Era, for example *Guild Artisanry* (stronger shop
quality and upgrade efficiency), *Transit Patronage* (cheaper civic builds, bonus Civic Prestige),
*Merchant Credit* (lower loan interest, leaner payroll), or *Canal Showcase* (stronger canal and
plaza appeal, tourist draw). The Charter choice costs no Action and is required: End Turn and
Ready stay unavailable, with a clear prompt, until the seat has chosen. There is no countdown and
no automatic choice for a human seat. AI Houses choose deterministically from seed and state.
Charters apply from the Movement step of that same turn's resolution.

### Dynasty Milestones

Four cumulative thresholds, checked in the Events & victory step:

- **Charter Merchant** — Serve 25 citizens in total (`+§80` dividend, first Crest star).
- **Block Baron** — Hold 3 active properties or an adjacent 2-lot House enclave (`+4 Prestige`,
  territorial banner flourish).
- **Civic Benefactor** — Construct 2 civic projects or reach 18 Civic Prestige (`+§120` dividend,
  `+4 Prestige`).
- **District Sovereign** — Reach §1,200 Net Worth or 40% Market Share during Era III–IV
  (`+6 Prestige`, gilded Crest star, `+1 Action` per turn thereafter).

Dividends are paid in the next turn's Treasury & upkeep step and appear in that turn's ledger.
Every Milestone appears in the Turn Delta, the Chronicle, and the House crest's star row.

### Match start

Each House begins with §900, one Factor and one Watch Company beside Grand Station, and no
property. Seats take Initiative order from seat 1 on Turn 1. A House may construct on a vacant lot
that is orthogonally adjacent to its own property, or within one tile of one of its Factors after
that turn's Movement step.

### The district

A 12×12 isometric canal district ringed by Streetcar Avenue along the harbor and bisected by the
Grand Canal with two avenue bridges and two arched stone footbridges. Forty-nine buildable lots
front the streets. Townhouses supply residents; Grand Station and the Harbor Pier supply tourists;
trams circle the avenue and drop commuters at Tram Stops during resolution.

### Houses and heraldry

| House | Color | Heraldic Crest |
| --- | --- | --- |
| **Vermilion Guild** | Vermilion `#D6453A` | Compass Shield |
| **Cobalt Syndicate** | Cobalt `#2667B8` | Harbor Anchor Shield |
| **Marigold House** | Marigold `#D48C1C` | Sunburst Crown Shield |
| **Emerald Atelier** | Emerald `#248A63` | Laurel Arch Shield |

Every owned property carries a House-colored lot kerb and a banner with its crest; adjacent owned
lots share a cohesive territory tint. Every unit token carries its House crest.

### Units

Units are recruited by a construction order at Grand Station (land units) or the Harbor Pier
(Barges), appear on the board after the recruiting turn resolves, and cost upkeep every turn.

| Unit | Era | Recruit | Upkeep / turn | Move | Strength | Cohesion | Role |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Factor** | I | §90 | §6 | 2 street tiles | 1 | 1 | Extends a House's building reach (see *Match start*) |
| **Watch Company** | I | §140 | §12 | 2 street tiles | 3 | 3 | Guards lots and bridges, blocks rival entry, issues Contests, blockades rival shop frontage (−50% footfall to that shop for the turn) |
| **Barge** | II | §160 | §8 | 4 water tiles | 1 | 1 | Runs trade routes between the Harbor Pier and canal-front property |

Modifiers: `+1` Strength when defending an owned lot or a bridge; Charters and Studies may add
more. A unit that ends a turn on owned property and was not in combat regains 1 Cohesion. Each
House may field at most 6 units. One unit occupies a tile; units never overlap.

### Citizens and footfall

Citizens remain the source of all sales, but they no longer wander in real time. During the
Production step, each district source (Townhouses, Grand Station, Harbor Pier, Tram Stops) emits
a deterministic number of citizens per archetype for the turn's daypart, Era, and active events.
Each citizen is allocated to the best-scoring reachable shop for its desire (appeal, price stance
versus budget, quality, distance, civic auras, blockades), with stable tie-breaking. Citizens a
shop cannot serve (queue full, out of stock, too pricey) are recorded as lost demand with a
reason.

| Archetype | Budget | Temperament |
| --- | --- | --- |
| Commuter | §14–36 | Price-sensitive, impatient, coffee first |
| Local | §30–70 | Balanced; strolls to parks |
| Foodie | §50–120 | Pays for quality; dining and coffee |
| Tourist | §80–200 | Barely price-sensitive; fashion, dining, plazas |
| Night Owl | §40–110 | Twilight nightlife, culture, leisure |

The board shows last turn's footfall as small citizen figures standing at the shops they used;
tapping a shop lists who came, who was lost, and why (for example `Lost: 7 too pricey · 4 queue
full`, `Off-peak — Coffee peaks in Morning`, `Undercut — 1 cheaper rival Bistro nearby`).

### Shops

| Shop | Desire | Era | Cost | Character |
| --- | --- | --- | --- | --- |
| Roastery | coffee | Era I | §180 | Strong Morning turns, steady cash foundation |
| Bistro | dining | Era I | §280 | Noon and Twilight surges; thrives on canal and plaza frontage |
| Arcade | leisure | Era II | §260 | Golden Hour and Twilight play; pairs with Tram Stops |
| Nightmarket | nightlife | Era II | §320 | Explosive at Twilight; Lantern Festival magnet |
| Boutique | fashion | Era III | §380 | High-margin luxury for tourists and upscale locals |
| Cinema | culture | Era III | §460 | Huge Twilight and rainstorm draw |

Every shop has three architectural levels (Level 3 from Era III), four price stances (Budget
−25%, Fair, Craft +20%, Prestige +45%), stock, wages, and rent. Construction completes in the
Production step of the turn it was ordered and serves citizens from that same step.

### Civic projects

| Project | Era | Cost | Effect |
| --- | --- | --- | --- |
| Pocket Park | Era I | §160 | +20% quality pull for neighbouring shops; locals stroll here; prestige |
| Tram Stop | Era II | §240 | Trams drop commuters on the block; transit bonus nearby; prestige |
| Festival Plaza | Era III | §340 | +30% appeal aura over two tiles; tourists gather here; highest prestige |

Each civic project's Inspector reports its contribution per turn: **Riders delivered** for a Tram
Stop, **Nearby shops boosted** and **Boosted sales** for a Park or Plaza.

### Trade

- **Barge routes:** a trade order assigns a Barge to a route from the Harbor Pier to an owned
  canal-front shop. Each turn the Barge completes the route, it delivers supplies at a 30% discount
  to that shop and earns a small route fee. A blocked or disbanded Barge delivers nothing that
  turn, and the ledger says so.
- **Harbor supply contracts:** a trade order prepays a fixed amount of stock for a shop for the
  next 4 turns at a locked price, protecting it from Supply Crunch.

### Diplomacy

Diplomacy orders propose or answer pacts between two Houses. A proposal made in Turn N is
delivered in Turn N's Production step and appears to the target during PLANNING of Turn N+1,
where accepting or declining is an order. An accepted pact takes effect in the Production step of
the turn it is accepted.

| Pact | Effect | Duration |
| --- | --- | --- |
| **Truce** | No Contests or blockades between the two Houses | 6 turns |
| **Trade Pact** | +10% footfall for each House's shops adjacent to the other's; both Houses' Barge route fees +25% | 8 turns |
| **Rent Accord** | Neither House may found a shop of the same desire within 2 tiles of the other's | 8 turns |

Breaking a pact (issuing a Contest under Truce) is impossible; pacts end only by expiry. AI Houses
propose and answer pacts deterministically from seed and state, by temperament.

### Guild Studies (research)

Each House pursues one Guild Study at a time. A research order invests §60 and adds 1 study
point; completing a study (3–5 points) grants a permanent House perk, recorded in the Turn Delta.

| Study | Points | Era | Perk |
| --- | --- | --- | --- |
| Fine Roasting | 3 | I | Roastery and Bistro quality +10% |
| Watch Drill | 3 | I | Watch Companies +1 Cohesion |
| Canal Hydraulics | 4 | II | Barges move 5 tiles; route fee +50% |
| Tram Signalling | 4 | II | Tram Stops cost 20% less and deliver +2 riders |
| Gilded Façades | 5 | III | Level 3 upgrades cost 20% less; +2 Prestige per Level 3 shop |
| Ledger Reform | 5 | III | Wages and rent −10% |

### Money and treasury

All money is integer §. Revenue arrives per sale in the Production step and is posted in the
Treasury & upkeep step; supplies come from Manual Restock, Auto-Restock (+15% convenience
premium), Barge deliveries, or Harbor contracts. Every turn the Treasury & upkeep step charges
wages, rent, unit upkeep, and loan interest exactly once. The Emergency Credit Line lends §400 per
borrow order, up to §1,200 outstanding, with its exact per-turn interest rate stated on the
order. If the turn's charges exceed cash, the shortfall is drawn from the remaining Credit Line and
recorded as financing; if the Credit Line is exhausted, the House's properties are sold at 60% of
invested capital in order of lowest yield (stable tie-breaking), then its units are disbanded in
order of highest upkeep, until the charges are covered; anything still uncovered is written off
as a `Forgiven` ledger line, so cash never goes negative. Selling returns 60% of invested
capital. The Turn Delta reconciles opening cash, operations, dividends, trade, financing, and
closing cash to the exact §.

### City events and the Mercadia Chronicle

Sudden Cloudburst, Harbor Cruise Arrival, Free-Ride Tram Day, Food Critic Visit, Street Lantern
Festival, Commercial Rent Hike, and Supply Crunch are drawn from the seeded generator in the Events
& victory step. Each is forecast two turns ahead with board callouts on affected landmarks and
shops, lasts a stated number of turns, and prints a closing receipt in the Turn Delta. The
**Mercadia Chronicle** records Era transitions, Milestones, Charter adoptions, pacts, Contests,
Crown lead changes, Promo Blitzes, and price-war undercuts as concise ledger-style dispatches,
each with an exact mechanical impact and a jump to the affected tile.

### Winning

**Crown Index = Net Worth ÷ 10 + Market Share % × 3 + Civic Prestige × 4**, each component rounded
down to a whole number. Market Share is a House's share of all district sales over the last four
resolved turns. Crown Index is recomputed once per turn in the Events & victory step and sampled
for the Final Edition chart. The leaderboard shows Houses in rank order with an expandable
breakdown whose three components sum exactly to the Crown Index.

After the final turn of Era IV resolves, the highest Crown Index wins; ties go to higher Net
Worth, then higher Civic Prestige, then earlier seat. **The Mercadia Gazette — Final Edition**
presents the winning crest, headline, standings breakdown, era-by-era market-share chart, three
match honours (*Corner King*, *Price Shark*, *Civic Patron*), and Rematch or Continue in Endless.

## Modes

- **Solo.** One human against one to three AI Houses. Standard, Blitz, or Endless. End Turn
  resolves immediately in the browser using the same pure core the server uses.
- **Hotseat (shared device).** Two to four humans, plus optional AI seats, on one device. Each
  human plans in seat order behind a **handoff screen** (`Pass to Cobalt Syndicate`) that hides the
  previous seat's draft. End Turn by the last human seat resolves the turn; the Turn Delta is shown
  to the table before the first seat plans the next turn. Hotseat runs fully offline.
- **Network room.** Two to four seats in any mix of humans and AI, plus *No AI (Pure PvP)*. The
  creator gets a four-letter code and a room URL (`/?room=ABCD`) to share. All play syncs over one
  WebSocket per browser to the room's single authority (a Durable Object), which owns the only
  authoritative world. Drafts are private to each seat until resolution; Ready status is public.
- **Spectators.** Latecomers to a full room watch read-only: the frozen board, public information,
  and every Turn Delta.
- **Leaving.** Leave asks for explicit confirmation; a seat that leaves a room stays reserved for
  its seat token.

### AI Houses

- **Vesper (Aggressive Discounter):** Claims busy corners, undercuts rival shops, contests
  frontage with Watch Companies, fires Promo Blitzes, pivots to civic prestige late if trailing.
- **Aurelia (Boutique Perfectionist):** Targets canal and plaza frontage, builds Bistros and
  Boutiques as they unlock, upgrades to Level 3 promptly, prefers Trade Pacts, adapts price stance
  to last turn's lost demand.
- **Orson (Transit Expansionist):** Builds Pocket Parks and Tram Stops to manufacture corridors,
  runs Barges early, anchors corridors with high-throughput shops.

AI Houses obey the same Actions, treasury, Era, Charter, and unit rules as humans. Their orders are
a pure function of seed, turn state, and seat; identical seed and state always yield identical AI
orders. AI orders are computed instantly at the start of PLANNING and are never on a timer.

## Multiplayer sync and session rules

- **Authority.** The room authority holds the canonical state, the canonical action log, and the
  set of Ready seats for the current turn, persisted transactionally. It resolves Turn N exactly
  once, at the moment the last human seat's Ready for Turn N is recorded, persists the new state,
  log, and summary, then sends every connected client one message carrying both the
  authoritative Turn N+1 state (with its turn number and state hash) and the N→N+1 summary.
  Clients show the state and summary together and never compute Turn N+1 themselves.
- **Drafts.** Each queue edit is sent to the authority with the seat's turn number and a draft
  revision. The authority acknowledges the latest revision it stored; an older or duplicate
  revision is never applied. A seat's draft is private: it is sent only to that seat, never to
  rivals or spectators. A reloaded or reconnected seat gets its draft back.
- **Turn-keyed, revision-bound, idempotent Ready.** Ready messages carry the turn number and the
  draft revision the seat last saw acknowledged (`ready { turn: N, revision: r }`). A Ready for
  the current turn whose revision exactly matches the authority's acknowledged revision is
  recorded once; repeats are no-ops. A Ready whose revision does not match (a draft edit was
  dropped, delayed, or arrived out of order) is explicitly rejected: nothing is recorded, the seat
  stays Planning, and the player sees `Draft not saved yet — Ready not recorded` until the draft
  is acknowledged and they mark Ready again. A Ready for any other turn is ignored and answered
  with the current state. A seat may withdraw Ready (*Cancel Ready*) until the last human seat is
  Ready; after that the turn is resolving and withdrawal is ignored. A Ready seat cannot edit its
  draft without first cancelling Ready, so a turn always resolves with exactly the draft each seat
  had acknowledged when it was Ready.
- **No double advance.** The authority stores the last resolved turn; any Ready, retry, or
  duplicate referring to an already-resolved turn returns the stored summary for that turn and
  never resolves again.
- **Seat reclaim.** Each seat has a seat token persisted in the browser. Reload, a closed tab, or a
  network drop returns the player to the exact same seat with their draft and Ready state. Seats
  are never auto-readied, timed out, or handed to AI mid-match; the room simply waits.
- **Heartbeats are transport only.** Ping/pong heartbeats keep connections alive and drive the
  presence indicator. They never read or write world state, never change the state hash, and never
  affect readiness or resolution.
- **Join and reconnect.** On every join or reconnect the authority sends one full state message:
  current turn, phase, world, the seat's own draft and Ready flag, every seat's Ready and presence
  status, and the most recent Turn Delta. There is no polling and no interpolation between states.
- **User-visible states.** The HUD always shows which state the client is in: `Your turn`,
  `Waiting for opponent…` (with who is not yet Ready), `Resolving Turn N…`, `Reconnecting…`
  (draft kept locally, Ready unavailable until synced), and clear errors such as `Room not found`,
  `Room is full — watching as spectator`, `Order rejected: not enough §`,
  `Draft not saved yet — Ready not recorded`, or `Turn 12 already resolved — showing its summary`.
- **Host.** The room creator configures seats and starts the match; if the creator leaves the
  lobby, the next connected human becomes host. The host has no control over pace or resolution.

## Determinism and verification (DST)

The core ships with a deterministic simulation test harness that runs seeded matches with
generated human order streams through the real resolution code and a simulated transport that
duplicates, drops, reorders, and delays messages, disconnects and reconnects seats, and sends
heartbeats. After every step it checks:

- **Frozen world:** during PLANNING the world state hash is unchanged by inspection, draft edits,
  Ready and Cancel Ready, heartbeats, joins, reconnects, and elapsed wall-clock time.
- **Phase legality:** only PLANNING → RESOLVE_TURN → TURN_SUMMARY → PLANNING transitions occur,
  RESOLVE_TURN starts only on End Turn or all-human-Ready, and the five resolution steps run in
  order.
- **Exactly-once turns:** the turn number increases by exactly 1 per resolution, each turn
  resolves once, and no retry or reconnect sequence produces a double advance or a skipped turn.
- **Treasury:** all § values are integers; each House's ledger reconciles exactly (opening + income
  − costs − upkeep + financing = closing); queued costs never exceed the planning budget; cash
  never goes negative; debt never exceeds the Credit Line; upkeep is charged exactly once per turn.
- **Units:** unique ids; every unit is on exactly one legal tile; no two units share a tile; no
  unit exceeds its movement allowance; Cohesion stays within bounds; unit count changes only by
  recorded recruitment or disbandment; per-House unit cap is respected.
- **Actions:** no House commits more orders than its Actions for the turn.
- **Draft binding and privacy:** every recorded Ready matches that seat's acknowledged draft
  revision, each resolution applies exactly those revisions, and no seat or spectator ever
  receives another seat's draft.
- **AI determinism:** identical seed and state produce identical AI orders, regardless of human
  draft timing.
- **Replay equivalence:** replaying from the seed and canonical action log reproduces every
  turn's state hash and summary exactly, in the browser core and the server core.

## Acceptance checks

Each check runs against the real app (Worker dev server and real browsers), not only unit tests.

1. **Frozen planning.** In solo, leave a turn untouched for at least two minutes while hovering,
   inspecting, panning, and opening drawers: Turn #, cash, units, and state hash do not change.
2. **End Turn advances exactly once.** In solo, press End Turn once (mouse, Enter, Space, and tap
   in turn): each press shows the Turn Delta for exactly N→N+1 and Turn # reads N+1. A double-click,
   double-tap, or held key advances exactly one turn.
3. **Undo.** Queue a Factor move and a dependent construction, undo the move: both are removed,
   Actions and projected cash are restored, and the world hash is unchanged.
4. **Budgets.** Orders beyond Actions or treasury cannot be queued and show the reason.
5. **Hotseat.** Two humans on one device: the handoff screen hides the first seat's draft; the turn
   resolves only after the second seat's End Turn; both see the same Turn Delta.
6. **Two independent browsers.** Two separate browser profiles open the same room URL as two
   humans. Browser A marks Ready: A shows `Waiting for opponent…`, B shows A as Ready, and neither
   world changes for at least two minutes. Browser B marks Ready: the authority resolves exactly
   once, and both browsers show the same Turn # (N+1), the same Turn Delta, and the same state hash.
7. **Cancel Ready.** A marks Ready, cancels, edits the draft, marks Ready again; B marks Ready; one
   resolution occurs using A's final draft.
8. **Reconnect during readiness.** A marks Ready, then reloads (and separately: goes offline and
   back online). A reclaims the same seat, still Ready, with the same Turn #. B marks Ready; both
   show the same N+1 Turn # and Turn Delta.
9. **Reconnect across resolution.** A goes offline; B marks Ready after A was already Ready; A
   reconnects and immediately shows Turn N+1 and the same N→N+1 Turn Delta as B.
10. **Retry safety.** Re-sending A's `ready { turn: N, revision: r }` after resolution (duplicate,
    delayed, or after reconnect) does not change Turn # or the state hash, and shows
    `Turn N already resolved — showing its summary` at most.
11. **Heartbeats.** With both seats connected and idle for five minutes of heartbeats, the turn,
    world, and Ready states are unchanged.
12. **Replay.** Exporting a finished match's seed and action log and replaying it headlessly
    reproduces every turn's state hash and the final standings.
13. **AI determinism.** Two solo matches with the same seed and the same human orders produce
    identical AI orders and identical Turn Deltas.
14. **Dropped or reordered draft and Ready.** In a two-browser room, A's room socket passes through
    a test relay that can drop, delay, reorder, or replay single messages. (a) A edits the draft and
    the latest `draft` is dropped: End Turn reads `Saving draft…`, and a
    `ready { turn: N, revision: r }` for that unacknowledged revision, injected by the relay, is
    rejected with `Draft not saved yet — Ready not recorded`. A stays `Planning` in both browsers
    and the state hash does not change. (b) The relay delivers A's `ready` ahead of the `draft`
    revision it names: the Ready is rejected the same way, the late draft is then acknowledged, and
    A must mark Ready again before it is recorded. (c) An older `draft` revision delivered after a
    newer one leaves the acknowledged revision unchanged. (d) A's `ready` is dropped: B keeps
    showing A as `Planning`, A is not shown as Ready, no resolution occurs, and pressing End Turn
    again records Ready exactly once. After B marks Ready, exactly one resolution occurs, and the
    Turn Delta shows exactly the orders in A's last acknowledged draft. Nothing B receives over its
    socket at any point contains A's draft.
15. **Next state broadcast and reconnect.** A and B mark Ready for Turn N. Each browser receives
    one resolution message that contains both the Turn N+1 state, with its turn number and state
    hash, and the N→N+1 summary. Both show Turn N+1 with the same hash and the same Turn Delta,
    and neither shows the summary before the new state. In a repeat run, A's resolution message
    is dropped (or A goes offline after marking Ready and B then marks Ready). On reconnect, A
    receives the same Turn N+1 state, hash, and N→N+1 summary in its join state. No second
    resolution occurs, and A never displays Turn N's world again.

## What MERCADIA is not

- Not real-time and not an RTS. No ticking map, speed controls, pause button, timed councils,
  countdowns, clock-based income, time warp, or turn timers.
- Not a spreadsheet or tutorial wall. Guidance is brief, contextual, and self-retiring; the ledger
  is concise and expandable.
- Not a dark neon dashboard. The board is travertine and alabaster stone, ink linework, and House
  color.

## Quality bar

- The board renders within one second of load and is fully inspectable before any click.
- Turn #, Actions remaining, treasury, and End Turn are visible at all times during play at
  1440×900, 1024×768, and 390×844, with no clipping.
- Solo, hotseat, and network rooms run the same pure deterministic core; the server and browser
  produce identical state hashes for identical inputs.
- Zero console errors or warnings, zero page errors, zero CSP violations, and zero failed
  network or WebSocket requests in solo, hotseat, and two-browser room play, including across
  reconnects.
