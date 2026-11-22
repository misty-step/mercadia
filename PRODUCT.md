# MERCADIA — Product

> *Rival merchants reshape a sunlit canal-and-tramway city block by block.*

MERCADIA is a real-time isometric city tycoon for one to four players. Each player leads a
merchant House, buys lots in a small canal district, opens shops, sets prices, and invests in
civic placemaking. Around eighty citizens walk the streets with real budgets and desires, and
they choose between rival shops every few seconds. The House with the highest Crown Index when
the final quarter closes wins the district.

## Who it is for

- A solo player who wants a ten-minute tycoon match against three AI rivals with different
  temperaments.
- Two to four friends who share an invite link and want to fight a price war in the same city
  at the same time.
- Anyone who likes watching a small city live: the title screen is already a running district.

## The promise

1. **The city is the interface.** The canvas fills the viewport. Panels dock to the edges and
   stay small. Every number in a panel has a visible cause on the street.
2. **Citizens decide, visibly.** A citizen picks a shop by distance, price, quality, ambiance,
   promotion, and queue length. When a queue is too long the citizen peels off and walks to a
   rival. The player sees the sale lost.
3. **Shaping the city is a strategy.** Tram Stops, Pocket Parks, and Festival Plazas move foot
   traffic. A player can manufacture a busy corner rather than only bid for one.
4. **One click to play.** *Play Solo Now* starts a Standard match against Vesper, Aurelia, and
   Orson with no setup. *Create Room* yields a four-letter code and an invite link.

## Core loop

1. **Read the street.** Build mode shows each vacant lot's bonuses (Corner, Canal-front,
   Transit) and a live foot-traffic rating from one to five pips. The build dock shows unmet
   demand per shop type, and every tool has a tooltip with its cost, peak hours and reach.
   Hovering a lot with a blueprint lists its synergies and competition (`+Plaza Aura`,
   `+Tram Footfall`, `1 rival Roastery nearby`). A civic blueprint draws its reach on the map:
   a ring and a wash on every lot it will lift. A Tram Stop blueprint traces the tramway and
   greys out the inland lots that cannot take one.
2. **Build.** Six shop archetypes serve six desires; three civic projects reshape traffic.
3. **Manage.** Click an owned shop to set its price stance, upgrade it, fire a Promo Blitz,
   restock, or sell. The Inspector opens with a one-line diagnosis of why the shop is missing
   sales: `Passed by: 7 too pricey · 4 queue full`, `Off-peak — Coffee peaks in Morning`,
   `Undercut — 1 cheaper rival Bistro nearby`. Any shop running a Promo Blitz, a rival's
   included, shows a badge with the seconds left.
4. **React.** The Mercadia Gazette forecasts a city event a few seconds ahead. Rain fills
   cinemas, a cruise ship fills boutiques, a supply crunch punishes late restocking. While an
   event is forecast or running, the shops it lifts and the landmark it arrives through (the
   Harbor Pier, the tram platforms) are marked on the map. When it ends the Gazette prints a
   receipt: `Harbor Cruise closed — 28 tourists served · Top earner: Cobalt`. Undercutting a
   nearby rival of the same trade, or launching a Promo Blitz, makes a rivalry headline.
5. **Close the quarter.** Each quarter is one day, morning to lantern-lit twilight. The ledger
   closes, the leaderboard settles, the next day begins.

## Systems

### The district

A 12×12 isometric grid. A looping Streetcar Avenue rings the district and runs along the
harbor. The Grand Canal steps through the middle and is crossed by two avenue bridges and two
arched stone footbridges. Four lanes divide the interior into rows. Forty-nine lots are
buildable, and every lot fronts a street on a side the camera can see, so queues are always
visible. Eight townhouses emit residents; Grand Station and the Harbor Pier emit tourists; two
brass-and-cream trams circle the avenue and drop commuters at Tram Stops.

### Citizens

| Archetype | Budget | Temperament |
| --- | --- | --- |
| Commuter | §14–36 | Price-sensitive, impatient, coffee first |
| Local | §30–70 | Balanced; strolls to parks |
| Foodie | §50–120 | Pays for quality; dining and coffee |
| Tourist | §80–200 | Barely price-sensitive; fashion, dining, plazas |
| Night Owl | §40–110 | Evening nightlife, culture, leisure |

Each citizen carries a desire (`coffee`, `dining`, `leisure`, `fashion`, `culture`,
`nightlife`), a wallet, a patience, and a mood. Clicking a citizen opens a speech card with all
of it, including the shop they are walking to.

### Shops

| Shop | Desire | Cost | Character |
| --- | --- | --- | --- |
| Roastery | coffee | §180 | Fast morning rush, high throughput, modest margin |
| Bistro | dining | §280 | Lunch and dinner surges; loves canal and plaza frontage |
| Arcade | leisure | §260 | Steady afternoon and evening; loves Tram Stops |
| Boutique | fashion | §380 | High-margin luxury; tourists and upscale locals |
| Cinema | culture | §460 | Huge evening and rainstorm surge |
| Nightmarket | nightlife | §320 | Explosive at dusk; Lantern Festival magnet |

Every shop has three levels with distinct architecture, four price stances (Budget −25%, Fair,
Craft +20%, Prestige +45%), a stockroom, wages, and rent.

### Civic projects

| Project | Cost | Effect |
| --- | --- | --- |
| Pocket Park | §160 | +20% quality pull for neighbouring shops; locals stroll here; prestige |
| Tram Stop | §240 | Trams pause and drop commuters on the block; transit bonus nearby; prestige |
| Festival Plaza | §340 | +30% appeal aura over two tiles; tourists gather here; most prestige |

A civic project's Inspector shows what it has done: **Riders delivered** for a Tram Stop,
**Nearby shops boosted** and **Boosted sales** for a Park or Plaza.

### Money

Revenue arrives per sale. Supplies are paid when stock is bought: Auto-Restock costs a 15%
convenience premium, Manual Restock does not, and a Supply Crunch raises both. Payroll runs
every ten seconds and takes wages, rent, and loan interest. The Emergency Credit Line lends
§400 at a time, and the Borrow button states the exact rate (`Borrow §400 · 18%/qtr` in
Standard, `7.2%/qtr` in Blitz). A property sells for 60% of what was invested in it. The
Ledger drawer shows all of this per quarter and for the match, followed by a **Financing**
section (loan draws, loan repayments) and **Change in cash**, so opening cash plus the ledger
equals the cash in hand to the §.

### City events — the Mercadia Gazette

Sudden Cloudburst, Harbor Cruise Arrival, Free-Ride Tram Day, Food Critic Visit, Street Lantern
Festival, Commercial Rent Hike, Supply Crunch. Each is forecast in the ticker, changes the
canvas atmosphere, and changes the numbers.

### Winning

**Crown Index = Net Worth ÷ 10 + Market Share % × 3 + Civic Prestige × 4.**
The leaderboard and the market-share bar show it live, in the same rank order. Hovering a
House, or toggling *Worth + Share + Prestige* in the leaderboard header, breaks its Crown into
the three whole-number parts, which always sum to the Crown.

The match ends on **The Mercadia Gazette — Final Edition**: the winning House's crest, a
headline for how the match was won (photo finish, late surge, landslide, wire to wire), the
full Crown breakdown for every House, a market-share chart quarter by quarter, and the
*Corner King*, *Price Shark* and *Civic Patron* honours. Then: Rematch, or Continue in
Endless. Build and speed hotkeys do nothing while it is open, and nothing armed for the
finished match carries into the next one.

## Modes

- **Solo.** One human and one to three AI tycoons. Blitz (2 quarters, about a minute each),
  Standard (4 quarters, about 2.5 minutes each), or Endless Sandbox. Pause, 1×, 2×, 3×.
- **Multiplayer room.** Two to four seats, any mix of humans and AI. *No AI (Pure PvP)* in
  the lobby clears every AI seat in one click for a human-only duel. The server is
  authoritative at 10 Hz. A dropped player reconnects into the same seat, and so does a
  player who closed the tab (or whose phone evicted it) and reopened the invite link. A
  latecomer watches as a spectator and is told so in a fixed, high-contrast notice. If the
  host leaves, the next connected player becomes host. The host sets pace: 1×, 1.5×, 2×.
- **Leaving.** Leave during a live match takes two clicks: the first turns the button into
  `Leave?` for four seconds, the second leaves.

### AI tycoons

- **Vesper, the Aggressive Discounter.** Takes high-traffic corners, undercuts the nearest
  rival of the same trade, opens beside premium-priced rivals, fires Promo Blitzes. From
  Quarter 3, if he trails on prestige, he turns civic: parks, one stop, one plaza.
- **Aurelia, the Boutique Perfectionist.** Claims canal and plaza frontage, builds Bistros and
  Boutiques, upgrades to Level 3 quickly, prices at Craft and Prestige. A finished shop that
  keeps losing customers to its price steps back to Craft until the queue returns.
- **Orson, the Transit Expansionist.** Builds Tram Stops and Pocket Parks to create traffic
  corridors, then fills them with shops as fast as cash allows.

All three know what each trade is really worth and save up for a better shop rather than
pile into coffee. Over twelve seeded Standard matches no persona wins more than five, and
their average Crown Index is within 5% of each other (`npm run balance`). In **Blitz** the
tycoons wait nine seconds before their first move, stagger after that, and think at half
pace through the first 45 seconds, so human players can contest first place from Quarter 1.

## What MERCADIA is not

- Not a spreadsheet. No panel may cover the city for longer than the decision it serves.
- Not an idle game. Nothing accrues without citizens walking to a door.
- Not a dark neon dashboard. The district is travertine, terracotta, sage, and canal teal in
  daylight.

## Quality bar

- The city is alive within one second of load, before any click.
- 85% or more of the viewport is uninterrupted city during play at 1440×900.
- The layout stays unclipped at 1024×768 and 390×844. At 390×844 the build dock is tabbed
  (*Shops (6)* / *Civic (3)*), Fit view shows the island tip to tip, a first tap previews a
  blueprint and a second builds it, and the Inspector is a bottom sheet that keeps the
  selected block in view.
- Solo and multiplayer run the same deterministic simulation code.
- The console stays clean: zero errors in a solo match and in a two-browser room.
