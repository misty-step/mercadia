// The Era Council: the pause between eras where every House adopts a Dynasty Charter.
// Simulation rules first, then the wire (snapshots → CityView), then the multiplayer room.
import { describe, expect, it, vi } from 'vitest';
import { advance } from '../src/shared/ai';
import {
  CHARTERS,
  CHARTER_ERA_FIT,
  CHARTER_KEYS,
  CHARTER_OFFERS,
  CHARTER_TASTE,
  COUNCIL_BEATS,
  COUNCIL_ERAS,
  CROWN,
  HOST_SPEEDS,
  HOUSES,
  MODES,
  START_CASH,
  isCharter,
} from '../src/shared/constants';
import { CITY, idx } from '../src/shared/map';
import { CityView, SnapEncoder, parseClientMsg, type ServerMsg, type Snap } from '../src/shared/protocol';
import { RoomCore, type Outbound } from '../src/shared/room';
import {
  COUNCIL_SEAL_BEATS,
  applyCommand,
  charterOffers,
  closeCouncil,
  councilBeat,
  councilReady,
  createGame,
  crownIndex,
  ledgerCashChange,
  recommendCharter,
  standings,
  tick,
} from '../src/shared/sim';
import type { AiPersona, CharterKey, Command, Council, GameState, MatchMode } from '../src/shared/types';
import { ais, build, clone, freeze, fxOf, humans, labGame, playOut, run, toEraClose } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const council = (s: GameState): Council => {
  if (!s.council) throw new Error(`no Council is open at tick ${s.tick}`);
  return s.council;
};
const wire = (snap: Snap): Snap => clone(snap);

// ───────────────────────────── Simulation ─────────────────────────────

describe('Era Council: when it sits', () => {
  it('convenes at the close of Eras I, II and III in every mode, and never after Era IV', () => {
    expect(COUNCIL_ERAS).toEqual([1, 2, 3]);
    for (const mode of ['standard', 'blitz', 'endless'] as MatchMode[]) {
      const s = createGame({ seed: 17, mode, players: ais(['vesper', 'orson']) });
      const opened: { era: number; tick: number }[] = [];
      let guard = 0;
      while (s.phase !== 'ended' && s.tick < 6 * s.quarterTicks && guard++ < 20000) {
        if (s.phase === 'council') {
          opened.push({ era: council(s).era, tick: s.tick });
          closeCouncil(s);
        } else advance(s);
        s.fx = [];
      }
      expect(opened, mode).toEqual([1, 2, 3].map((era) => ({ era, tick: era * MODES[mode].quarterTicks })));
      expect(s.council).toBeNull();
      if (mode === 'endless') expect(s.quarter).toBe(7);
      else expect(s.phase).toBe('ended');
    }
  });

  it('opens with the era’s standings and deltas, three charters per House, and the next era’s unlocks', () => {
    const s = freeze(labGame({ mode: 'blitz', players: 3, cash: 5000 }));
    build(s, 1, 3, 6, 'roastery');
    s.players[1].prestige = 6; // Cobalt will lead the first era's standings
    s.fx = [];
    toEraClose(s);
    expect(s.phase).toBe('council');
    expect(s.tick).toBe(s.quarterTicks);
    expect(s.quarter).toBe(1); // the next era has not begun
    expect(fxOf(s.fx, 'council')).toEqual([{ k: 'council', era: 1 }]);
    const c = council(s);
    expect(c).toMatchObject({ era: 1, next: 2, left: COUNCIL_BEATS, total: COUNCIL_BEATS, level3: false });
    expect(COUNCIL_BEATS).toBeGreaterThanOrEqual(150); // a ~15–20 s multiplayer countdown
    expect(COUNCIL_BEATS).toBeLessThanOrEqual(200);
    expect(c.unlocked.slice().sort()).toEqual(['arcade', 'nightmarket', 'tramstop']);
    // Standings: rank order, the Crown at the era's close, and what the era added to it.
    const opening = Math.round(START_CASH * CROWN.netWorth);
    expect(c.rows.map((r) => r.player)).toEqual(standings(s).map((r) => r.player));
    expect(c.rows[0].player).toBe(1);
    for (const row of c.rows) {
      expect(row.crown).toBe(crownIndex(s, s.players[row.player]));
      expect(row.delta).toBe(row.crown - opening);
    }
    expect(s.eraCrowns).toEqual([s.players.map((p) => crownIndex(s, p))]);
    // Offers: three distinct charters each; humans have not chosen yet.
    expect(c.offers).toHaveLength(3);
    for (const offer of c.offers) {
      expect(offer).toHaveLength(CHARTER_OFFERS);
      expect(new Set(offer).size).toBe(3);
      for (const k of offer) expect(isCharter(k)).toBe(true);
    }
    expect(c.picks).toEqual([null, null, null]);
    // The second Council measures the second era alone, and announces Era III with Level 3.
    const before = s.players.map((p) => crownIndex(s, p));
    closeCouncil(s);
    s.players[2].prestige += 10;
    toEraClose(s);
    const c2 = council(s);
    expect(c2).toMatchObject({ era: 2, next: 3, level3: true });
    expect(c2.unlocked.slice().sort()).toEqual(['boutique', 'cinema', 'plaza']);
    for (const row of c2.rows) expect(row.delta).toBe(row.crown - before[row.player]);
    expect(c2.rows.find((r) => r.player === 2)?.delta).toBe(Math.round(10 * CROWN.prestige));
    closeCouncil(s);
    toEraClose(s);
    // The third announces the Golden Dynasty: no new tools, the final reckoning.
    expect(council(s)).toMatchObject({ era: 3, next: 4, level3: false, unlocked: [] });
    closeCouncil(s);
    toEraClose(s);
    expect(s.phase).toBe('ended');
    expect(s.council).toBeNull();
  });

  it('pauses the simulation cleanly: no tick passes, and only choosing a charter is in order', () => {
    const s = labGame({ mode: 'blitz', cash: 5000 });
    const shop = build(s, 0, 3, 6, 'roastery');
    toEraClose(s);
    const frozen = JSON.stringify(s);
    tick(s);
    advance(s);
    run(s, 300);
    expect(JSON.stringify(s)).toBe(frozen);
    const cmds: Command[] = [
      { c: 'build', tile: idx(4, 6), kind: 'bistro' },
      { c: 'price', id: shop.id, stance: 2 },
      { c: 'upgrade', id: shop.id },
      { c: 'promo', id: shop.id },
      { c: 'restock', id: shop.id },
      { c: 'auto', id: shop.id, on: false },
      { c: 'sell', id: shop.id },
      { c: 'borrow' },
      { c: 'repay' },
    ];
    for (const cmd of cmds) expect(applyCommand(s, 0, cmd), cmd.c).toEqual({ ok: false, err: 'The Era Council is in session' });
    expect(JSON.stringify(s)).toBe(frozen);
    // Choosing is the one thing that works — and it does not start the clock.
    expect(applyCommand(s, 0, { c: 'charter', key: council(s).offers[0][0] })).toEqual({ ok: true });
    expect(s.phase).toBe('council');
    expect(s.tick).toBe(s.quarterTicks);
  });
});

describe('Era Council: choosing a charter', () => {
  it('offers three distinct charters a House does not already hold, the same for the same seed', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const a = createGame({ seed, mode: 'blitz', players: humans(4) });
      const b = createGame({ seed, mode: 'blitz', players: humans(4) });
      for (const era of [1, 2, 3]) {
        for (const p of a.players) {
          const offer = charterOffers(a, p, era);
          expect(offer).toHaveLength(3);
          expect(new Set(offer).size).toBe(3);
          for (const k of offer) expect(CHARTER_KEYS).toContain(k);
          expect(charterOffers(b, b.players[p.id], era)).toEqual(offer);
          // Drawing an offer never touches the match's own random stream.
          expect(a.rng).toBe(b.rng);
          // Nothing already held is offered again.
          const holding = { id: p.id, charters: offer.slice(0, 2) };
          for (const k of charterOffers(a, holding, era + 1 > 3 ? 3 : era + 1)) expect(holding.charters).not.toContain(k);
        }
      }
    }
    // Offers differ between Houses, eras and seeds: it is a real draw, not a fixed menu.
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const s = createGame({ seed, mode: 'blitz', players: humans(4) });
      for (const p of s.players) seen.add(charterOffers(s, p, 1).slice().sort().join('+'));
    }
    expect(seen.size).toBeGreaterThan(10);
    const every = new Set<CharterKey>();
    for (let seed = 1; seed <= 30; seed++) for (const k of charterOffers({ seed }, { id: 0, charters: [] }, 1)) every.add(k);
    expect([...every].sort()).toEqual(CHARTER_KEYS.slice().sort());
  });

  it('validates the charter command: on offer to that House, a real charter, and only while the Council sits', () => {
    const s = labGame({ mode: 'blitz' });
    const anyKey = CHARTER_KEYS[0];
    expect(applyCommand(s, 0, { c: 'charter', key: anyKey })).toEqual({ ok: false, err: 'The Era Council is not in session' });
    toEraClose(s);
    const c = council(s);
    const mine = c.offers[0];
    const notMine = CHARTER_KEYS.find((k) => !mine.includes(k)) as CharterKey;
    expect(applyCommand(s, 0, { c: 'charter', key: notMine })).toEqual({ ok: false, err: 'That charter is not on offer to your House' });
    expect(applyCommand(s, 0, { c: 'charter', key: 'monopoly' as CharterKey })).toEqual({ ok: false, err: 'Unknown charter' });
    expect(applyCommand(s, 0, { c: 'charter', key: 'constructor' as CharterKey })).toEqual({ ok: false, err: 'Unknown charter' });
    expect(applyCommand(s, 0, { c: 'charter' } as unknown as Command)).toEqual({ ok: false, err: 'Unknown charter' });
    expect(applyCommand(s, 7, { c: 'charter', key: mine[0] })).toEqual({ ok: false, err: 'Bad command' });
    expect(c.picks).toEqual([null, null]);
    // A pick is recorded for that House only, and may be changed until the Council closes.
    expect(applyCommand(s, 0, { c: 'charter', key: mine[1] })).toEqual({ ok: true });
    expect(c.picks).toEqual([mine[1], null]);
    expect(applyCommand(s, 0, { c: 'charter', key: mine[2] })).toEqual({ ok: true });
    expect(c.picks).toEqual([mine[2], null]);
    expect(s.players[0].charters).toEqual([]); // adopted when the Council closes, not before
    expect(councilReady(s, [0])).toBe(true);
    expect(councilReady(s, [0, 1])).toBe(false);
    expect(councilReady(s, [])).toBe(true);
    closeCouncil(s);
    expect(s.players[0].charters).toEqual([mine[2]]);
    expect(applyCommand(s, 0, { c: 'charter', key: mine[0] })).toEqual({ ok: false, err: 'The Era Council is not in session' });
    // And never after the final bell.
    const ended = playOut(labGame({ mode: 'blitz' }));
    expect(applyCommand(ended, 0, { c: 'charter', key: anyKey })).toEqual({ ok: false, err: 'The match is not running' });
  });

  it('closes by adopting every pick, giving an undecided House its steward’s choice, and beginning the next era', () => {
    const s = freeze(labGame({ mode: 'blitz', players: 3 }));
    expect(closeCouncil(s)).toBe(false); // nothing to close mid-era
    toEraClose(s);
    const c = clone(council(s));
    expect(applyCommand(s, 1, { c: 'charter', key: c.offers[1][2] }).ok).toBe(true);
    const prestige = s.players.map((p) => p.prestige);
    const cash = s.players.map((p) => p.cash);
    s.fx = [];
    const n0 = s.chronicleN;
    expect(closeCouncil(s)).toBe(true);
    expect(s.phase).toBe('playing');
    expect(s.council).toBeNull();
    expect(s.quarter).toBe(2);
    expect(s.tick).toBe(s.quarterTicks);
    // Player 1 chose; players 0 and 2 did not and take the first charter offered.
    const adopted = [c.offers[0][0], c.offers[1][2], c.offers[2][0]];
    expect(s.players.map((p) => p.charters)).toEqual(adopted.map((k) => [k]));
    expect(fxOf(s.fx, 'charter')).toEqual(adopted.map((key, p) => ({ k: 'charter', p, key })));
    expect(fxOf(s.fx, 'quarter')).toEqual([{ k: 'quarter', q: 2 }]);
    // Adoption costs nothing; only Transit Patronage carries prestige with it.
    expect(s.players.map((p) => p.cash)).toEqual(cash);
    s.players.forEach((p, i) => expect(p.prestige - prestige[i]).toBe(CHARTERS[adopted[i]].adoptPrestige));
    // The Chronicle: one adoption per House, then the new era with its unlock tag.
    const news = s.chronicle.filter((d) => d.n > n0);
    expect(news.map((d) => d.cat)).toEqual(['charter', 'charter', 'charter', 'era']);
    news.slice(0, 3).forEach((d, i) => {
      expect(d).toMatchObject({ tier: 2, player: i, pill: CHARTERS[adopted[i]].pill });
      expect(d.head).toBe(`${HOUSES[s.players[i].house].short} adopts ${CHARTERS[adopted[i]].name}`);
    });
    expect(news[3]).toMatchObject({ tier: 1, head: 'Era II: Transit & Trade', pill: 'Era II Unlocked', player: -1 });
    expect(s.gazette[s.gazette.length - 1].text).toBe('Era II: Transit & Trade begins. Unlocked: Arcade, Nightmarket, Tram Stop.');
    // A second close is a no-op.
    expect(closeCouncil(s)).toBe(false);
    // Three Councils, three different charters per House.
    for (let i = 0; i < 2; i++) {
      toEraClose(s);
      for (const p of s.players) for (const k of council(s).offers[p.id]) expect(p.charters).not.toContain(k);
      closeCouncil(s);
      if (i === 0) expect(s.chronicle[s.chronicle.length - 1]).toMatchObject({ cat: 'era', head: 'Era III: Grand Boulevard', pill: 'Era III Unlocked' });
      const begins = s.gazette[s.gazette.length - 1].text;
      if (i === 0) expect(begins).toBe('Era III: Grand Boulevard begins. Unlocked: Boutique, Cinema, Festival Plaza, Level 3.');
      else expect(begins).toMatch(/^Era IV: Golden Dynasty begins\. /);
    }
    for (const p of s.players) {
      expect(p.charters).toHaveLength(3);
      expect(new Set(p.charters).size).toBe(3);
    }
    expect(s.chronicle[s.chronicle.length - 1]).toMatchObject({ cat: 'era', tier: 1, head: 'Era IV: Golden Dynasty', pill: 'Final Reckoning' });
  });

  it('has AI Houses seal an era-appropriate charter the moment the Council opens', () => {
    // The steward's rule, exhaustively: the pick is on offer and nothing on offer scores higher.
    const personas: AiPersona[] = ['vesper', 'aurelia', 'orson'];
    for (const persona of personas) {
      for (const next of [2, 3, 4]) {
        for (let a = 0; a < CHARTER_KEYS.length; a++) for (let b = a + 1; b < CHARTER_KEYS.length; b++) for (let c = b + 1; c < CHARTER_KEYS.length; c++) {
          const offers = [CHARTER_KEYS[a], CHARTER_KEYS[b], CHARTER_KEYS[c]];
          const score = (k: CharterKey): number => CHARTER_TASTE[persona][k] * (CHARTER_ERA_FIT[next][k] ?? 1);
          const pick = recommendCharter({ kind: 'ai', persona }, offers, next);
          expect(offers).toContain(pick);
          for (const k of offers) expect(score(pick), `${persona} era ${next}: ${pick} over ${k}`).toBeGreaterThanOrEqual(score(k));
        }
      }
    }
    // Temperament shows: each persona's favourite doctrine, when it is on the table.
    expect(recommendCharter({ kind: 'ai', persona: 'vesper' }, ['credit', 'heralds', 'canal'], 2)).toBe('heralds');
    expect(recommendCharter({ kind: 'ai', persona: 'aurelia' }, ['heralds', 'canal', 'artisanry'], 3)).toBe('artisanry');
    expect(recommendCharter({ kind: 'ai', persona: 'orson' }, ['artisanry', 'transit', 'credit'], 2)).toBe('transit');
    // The coming era matters: what Transit & Trade rewards differs from the Grand Boulevard.
    expect(CHARTER_ERA_FIT[2].transit).toBeGreaterThan(1);
    expect(CHARTER_ERA_FIT[3].artisanry).toBeGreaterThan(1);
    expect(CHARTER_ERA_FIT[3].canal).toBeGreaterThan(1);
    expect(recommendCharter({ kind: 'ai', persona: 'orson' }, ['provisioners', 'artisanry', 'canal'], 2)).toBe('provisioners');
    expect(recommendCharter({ kind: 'ai', persona: 'orson' }, ['provisioners', 'artisanry', 'canal'], 3)).toBe('provisioners');
    expect(recommendCharter({ kind: 'ai', persona: 'vesper' }, ['artisanry', 'transit', 'canal'], 2)).toBe('transit');
    expect(recommendCharter({ kind: 'ai', persona: 'vesper' }, ['artisanry', 'transit', 'canal'], 3)).toBe('artisanry');
    // A human's steward simply takes the first charter offered.
    expect(recommendCharter({ kind: 'human', persona: null }, ['canal', 'credit', 'heralds'], 2)).toBe('canal');
    // In a live match: AI picks are in place at once, humans' are open.
    const s = createGame({
      seed: 23,
      mode: 'blitz',
      players: [{ name: 'Ada', house: 0, kind: 'human' }, ...ais(['vesper', 'aurelia', 'orson']).map((p, i) => ({ ...p, house: i + 1 }))],
    });
    for (let councilNo = 1; councilNo <= 3; councilNo++) {
      while (s.phase === 'playing') advance(s);
      const c = council(s);
      expect(c.picks[0]).toBeNull();
      for (const p of s.players.slice(1)) {
        expect(c.picks[p.id]).toBe(recommendCharter(p, c.offers[p.id], c.next));
        expect(c.offers[p.id]).toContain(c.picks[p.id]);
      }
      closeCouncil(s);
      for (const p of s.players) expect(p.charters).toHaveLength(councilNo);
    }
  });
});

describe('Era Council: the multiplayer countdown', () => {
  it('counts down in real beats and auto-selects for a silent House when the clock runs out', () => {
    const s = freeze(labGame({ mode: 'blitz' }));
    expect(councilBeat(s, [0, 1])).toBe(false); // no Council: nothing to count
    toEraClose(s);
    const offers = clone(council(s).offers);
    for (let beat = 1; beat < COUNCIL_BEATS; beat++) {
      expect(councilBeat(s, [0, 1]), `beat ${beat}`).toBe(false);
      expect(council(s).left).toBe(COUNCIL_BEATS - beat);
      expect(s.phase).toBe('council');
    }
    expect(s.tick).toBe(s.quarterTicks); // the countdown is wall time, not match time
    expect(councilBeat(s, [0, 1])).toBe(true);
    expect(s.phase).toBe('playing');
    expect(s.quarter).toBe(2);
    expect(s.players.map((p) => p.charters)).toEqual([[offers[0][0]], [offers[1][0]]]);
  });

  it('advances straight after every waiting House has chosen: within COUNCIL_SEAL_BEATS, not the full countdown', () => {
    expect(COUNCIL_SEAL_BEATS).toBeLessThanOrEqual(10); // under a second for the seals to set
    const s = freeze(labGame({ mode: 'blitz', players: 3 }));
    toEraClose(s);
    const c = council(s);
    for (let i = 0; i < 20; i++) councilBeat(s, [0, 1]);
    expect(c.left).toBe(COUNCIL_BEATS - 20);
    // One of two has chosen: still waiting.
    expect(applyCommand(s, 0, { c: 'charter', key: c.offers[0][1] }).ok).toBe(true);
    expect(councilBeat(s, [0, 1])).toBe(false);
    expect(c.left).toBe(COUNCIL_BEATS - 21);
    // Both have: the clock drops to the seal and the Council closes on its last beat.
    expect(applyCommand(s, 1, { c: 'charter', key: c.offers[1][2] }).ok).toBe(true);
    let beats = 0;
    while (s.phase === 'council' && beats < 50) {
      beats++;
      const closed = councilBeat(s, [0, 1]);
      expect(closed).toBe(s.phase !== 'council');
    }
    expect(beats).toBe(COUNCIL_SEAL_BEATS);
    expect(s.players[0].charters).toEqual([c.offers[0][1]]);
    expect(s.players[1].charters).toEqual([c.offers[1][2]]);
    // Player 2 was not being waited for (not connected): the steward chose.
    expect(s.players[2].charters).toEqual([c.offers[2][0]]);
    // With nobody to wait for there is no shortcut: the full countdown runs.
    toEraClose(s);
    for (let i = 0; i < COUNCIL_BEATS - 1; i++) expect(councilBeat(s, [])).toBe(false);
    expect(councilBeat(s, [])).toBe(true);
    // A late pick still shortens a clock that is nearly out, and never lengthens it.
    toEraClose(s);
    const c3 = council(s);
    for (let i = 0; i < COUNCIL_BEATS - 3; i++) councilBeat(s, [0]);
    expect(c3.left).toBe(3);
    applyCommand(s, 0, { c: 'charter', key: c3.offers[0][0] });
    expect(councilBeat(s, [0])).toBe(false);
    expect(c3.left).toBe(2);
  });

  it('is deterministic: the same seed stepped through its Councils yields the same match, however long each Council sat', () => {
    const a = createGame({ seed: 909, mode: 'blitz', players: ais(['vesper', 'aurelia', 'orson', 'vesper']) });
    const b = createGame({ seed: 909, mode: 'blitz', players: ais(['vesper', 'aurelia', 'orson', 'vesper']) });
    const other = createGame({ seed: 910, mode: 'blitz', players: ais(['vesper', 'aurelia', 'orson', 'vesper']) });
    playOut(a);
    // b dawdles: idle frames while each Council sits, and a countdown part-run before closing.
    let guard = 0;
    while (b.phase !== 'ended' && guard++ < 20000) {
      if (b.phase === 'council') {
        for (let i = 0; i < 40; i++) advance(b);
        for (let i = 0; i < 25; i++) councilBeat(b, [9]); // waiting on a seat that never picks
        closeCouncil(b);
      } else advance(b);
    }
    playOut(other);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(a));
    expect(a.players.map((p) => p.charters.length)).toEqual([3, 3, 3, 3]);
  });
});

// ───────────────────────────── The wire ─────────────────────────────

describe('Era Council on the wire: snapshots and the client view', () => {
  it('flags the Council in every snapshot while it sits, then clears it with a single null', () => {
    const s = freeze(labGame({ mode: 'blitz' }));
    const enc = new SnapEncoder();
    const view = new CityView();
    view.apply(wire(enc.encode(s, true)));
    expect(view).toMatchObject({ inCouncil: false, council: null, era: 1, quarter: 1 });
    // A quiet delta carries none of the dynasty lanes.
    const first = enc.encode(s, false);
    expect(first.q).toEqual([1, 0, 0]);
    expect(first).not.toHaveProperty('cn');
    view.apply(wire(first));
    const quiet = enc.encode(s, false);
    for (const lane of ['cn', 'ch', 'dy'] as const) expect(quiet, lane).not.toHaveProperty(lane);
    // The era closes: the phase flag flips and the Council rides along.
    toEraClose(s);
    const open = enc.encode(s, false);
    expect(open.q).toEqual([1, 2, 0]);
    expect(open.cn).toEqual(s.council);
    expect(open.fx).toContainEqual({ k: 'council', era: 1 });
    s.fx = [];
    view.apply(wire(open));
    expect(view.inCouncil).toBe(true);
    expect(view.ended).toBe(false);
    expect(view.council).toEqual(s.council);
    expect(view.council).not.toBe(s.council);
    expect(view.era).toBe(1);
    // Picks and the countdown travel with every snapshot while it sits.
    const key = council(s).offers[1][1];
    applyCommand(s, 1, { c: 'charter', key });
    councilBeat(s, [0, 1]);
    const picked = enc.encode(s, false);
    expect(picked.cn?.picks).toEqual([null, key]);
    expect(picked.cn?.left).toBe(COUNCIL_BEATS - 1);
    view.apply(wire(picked));
    expect(view.council?.picks).toEqual([null, key]);
    expect(view.council?.left).toBe(COUNCIL_BEATS - 1);
    expect(enc.encode(s, false).cn).toEqual(s.council); // again, unchanged or not
    // It closes: one null, the new era on the clock, the adoptions in the dynasty lane.
    closeCouncil(s);
    const closed = enc.encode(s, false);
    expect(closed.q).toEqual([2, 0, 0]);
    expect(closed.cn).toBeNull();
    expect(closed.dy?.map((d) => d.c)).toEqual(s.players.map((p) => p.charters));
    expect(closed.ch).toEqual(s.chronicle);
    expect(closed.fx).toEqual(expect.arrayContaining([{ k: 'charter', p: 1, key }, { k: 'quarter', q: 2 }]));
    s.fx = [];
    view.apply(wire(closed));
    expect(view).toMatchObject({ inCouncil: false, council: null, era: 2, quarter: 2 });
    expect(view.players.map((p) => p.charters)).toEqual(s.players.map((p) => p.charters));
    expect(view.chronicle).toEqual(s.chronicle);
    const after = enc.encode(s, false);
    for (const lane of ['cn', 'ch', 'dy'] as const) expect(after, lane).not.toHaveProperty(lane);
  });

  it('restores an open Council, the Chronicle and every House’s dynasty record from one full snapshot', () => {
    const s = createGame({ seed: 77, mode: 'blitz', players: [{ name: 'Ada', house: 2, kind: 'human' }, ...ais(['aurelia', 'orson']).map((p, i) => ({ ...p, house: i }))] });
    const untilCouncil = (g: GameState): void => {
      while (g.phase === 'playing') advance(g);
    };
    untilCouncil(s);
    closeCouncil(s);
    untilCouncil(s);
    expect(council(s).era).toBe(2);
    applyCommand(s, 0, { c: 'charter', key: council(s).offers[0][2] });
    const late = new CityView();
    late.apply(wire(new SnapEncoder().encode(s, true, 1.5)));
    expect(late.inCouncil).toBe(true);
    expect(late.council).toEqual(s.council);
    expect(late.quarter).toBe(2);
    expect(late.era).toBe(2);
    expect(late.speed).toBe(1.5);
    expect(late.chronicle).toEqual(s.chronicle);
    expect(late.chronicle.length).toBeGreaterThan(3);
    late.players.forEach((v, i) => {
      const p = s.players[i];
      expect(v.charters).toEqual(p.charters);
      expect(v.charters).toHaveLength(1);
      expect(v.milestones).toEqual(p.milestones);
      expect(v.served).toBe(p.stats.served);
      expect(v.civicBuilt).toBe(p.stats.civicBuilt);
    });
    // A full snapshot of a match with no Council says so explicitly.
    closeCouncil(s);
    const snap = new SnapEncoder().encode(s, true);
    expect(snap.cn).toBeNull();
    expect(snap.dy).toHaveLength(3);
    late.apply(wire(snap));
    expect(late).toMatchObject({ inCouncil: false, council: null, era: 3 });
  });

  it('sends the Chronicle only when a dispatch is published and the dynasty lane only when it changes', () => {
    const s = freeze(labGame({ cash: 5000, milestones: true }));
    const enc = new SnapEncoder();
    const first = enc.encode(s, false);
    expect(first.ch).toEqual(s.chronicle);
    expect(first.dy).toEqual(s.players.map(() => ({ c: [], m: [-1, -1, -1, -1], sv: 0, cb: 0 })));
    expect(enc.encode(s, false)).not.toHaveProperty('ch');
    expect(enc.encode(s, false)).not.toHaveProperty('dy');
    // A civic dedication: a dispatch, and the civic counter in the dynasty lane.
    build(s, 0, 4, 6, 'park');
    const news = enc.encode(s, false);
    expect(news.ch?.[news.ch.length - 1]).toMatchObject({ cat: 'build', head: 'Vermilion dedicates a Pocket Park' });
    expect(news.dy?.[0]).toEqual({ c: [], m: [-1, -1, -1, -1], sv: 0, cb: 1 });
    s.fx = [];
    expect(enc.encode(s, false)).not.toHaveProperty('ch');
    // A Milestone: both lanes again, with the tick it was earned.
    s.players[0].stats.served = 25;
    run(s, 5);
    const star = enc.encode(s, false);
    expect(star.dy?.[0].m).toEqual([s.tick, -1, -1, -1]);
    expect(star.dy?.[0].sv).toBe(25);
    expect(star.ch?.[star.ch.length - 1]).toMatchObject({ cat: 'milestone', pill: '+§80 · ★1' });
    const view = new CityView();
    view.apply(wire(enc.encode(s, true)));
    expect(view.players[0]).toMatchObject({ milestones: [s.tick, -1, -1, -1], served: 25, civicBuilt: 1 });
    // reset() (a rematch) forgets what was sent.
    enc.reset();
    const again = enc.encode(s, false);
    expect(again.ch).toEqual(s.chronicle);
    expect(again.dy).toHaveLength(2);
  });
});

// ───────────────────────────── The room ─────────────────────────────

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;
const pick = <T extends ServerMsg['t']>(out: Outbound[], t: T, to?: string): Msg<T>[] =>
  out.filter((o) => o.msg.t === t && (to === undefined || o.to === to)).map((o) => o.msg as Msg<T>);

/** Two humans (Ada hosts) and two AI Houses in a started Blitz room, stepped to the Era I Council. */
function roomAtCouncil(speed = 1) {
  const core = new RoomCore('ERAS', 4321);
  let issued = 0;
  const newId = (): string => `pid-${++issued}`;
  const ada = core.join(null, 'Ada', newId).playerId;
  const ben = core.join(null, 'Ben', newId).playerId;
  core.handle(ada, { t: 'mode', mode: 'blitz' });
  if (speed !== 1) core.handle(ada, { t: 'speed', speed });
  expect(pick(core.handle(ada, { t: 'start' }), 'reject')).toEqual([]);
  const game = (): GameState => core.game as GameState;
  let beats = 0;
  let last: Outbound[] = [];
  while (game().phase === 'playing' && beats < 5000) {
    last = core.step();
    beats++;
  }
  return { core, ada, ben, game, beats, last, newId };
}
const charterCmd = (key: CharterKey) => ({ t: 'cmd', cmd: { c: 'charter', key } }) as const;

describe('Era Council in a multiplayer room', () => {
  it('reaches the Council on the server’s clock and keeps the room beating while it sits', () => {
    const { core, game, beats, last } = roomAtCouncil();
    expect(beats).toBe(MODES.blitz.quarterTicks);
    expect(game().phase).toBe('council');
    expect(core.room.status).toBe('playing');
    expect(core.running).toBe(true); // the countdown needs the 100 ms beat
    expect(core.summary()).toMatchObject({ status: 'playing', quarter: 1, era: 1, council: true });
    // The snapshot that opened it went to everyone.
    const opening = pick(last, 'snap', '*')[0];
    expect(opening.q).toEqual([1, 2, 0]);
    expect(opening.cn).toMatchObject({ era: 1, next: 2, left: COUNCIL_BEATS });
    expect(opening.fx).toContainEqual({ k: 'council', era: 1 });
    // AI Houses (players 2 and 3) have sealed; the two humans have not.
    expect(opening.cn?.picks.slice(0, 2)).toEqual([null, null]);
    expect(opening.cn?.picks.slice(2).every((k) => k !== null)).toBe(true);
    // Every beat broadcasts the countdown; the match clock stands still.
    const tickNo = game().tick;
    for (let i = 1; i <= 5; i++) {
      const out = core.step();
      expect(out.map((o) => [o.to, o.msg.t])).toEqual([['*', 'snap']]);
      const snap = pick(out, 'snap')[0];
      expect(snap.k).toBe(tickNo);
      expect(snap.cn?.left).toBe(COUNCIL_BEATS - i);
      expect(snap.q[1]).toBe(2);
    }
  });

  it('syncs each human’s charter to everyone and advances right after all connected humans have chosen', () => {
    const { core, ada, ben, game } = roomAtCouncil();
    const offers = clone(council(game()).offers);
    // Both clients see the same Council through their own views.
    const views = [new CityView(), new CityView()];
    for (const v of views) v.apply(wire(pick(core.join(v === views[0] ? ada : ben, undefined, () => 'x').out, 'snap')[0]));
    for (const v of views) expect(v.council?.offers).toEqual(offers);
    const feed = (out: Outbound[]): void => {
      for (const snap of pick(out, 'snap', '*')) for (const v of views) v.apply(wire(snap));
    };
    // Ada chooses: accepted silently, and the next beat shows it to both.
    expect(core.handle(ada, charterCmd(offers[0][1]))).toEqual([]);
    feed(core.step());
    for (const v of views) expect(v.council?.picks.slice(0, 2)).toEqual([offers[0][1], null]);
    expect(game().phase).toBe('council'); // still waiting for Ben
    // A charter that is not on a House's own offer is refused to that player alone.
    const foreign = (Object.keys(CHARTERS) as CharterKey[]).find((k) => !offers[1].includes(k)) as CharterKey;
    expect(core.handle(ben, charterCmd(foreign))).toEqual([{ to: ben, msg: { t: 'reject', err: 'That charter is not on offer to your House' } }]);
    // Anything else is refused while the Council sits.
    expect(core.handle(ben, { t: 'cmd', cmd: { c: 'borrow' } })).toEqual([{ to: ben, msg: { t: 'reject', err: 'The Era Council is in session' } }]);
    // Ben chooses: the room closes the Council within the seal, far short of the countdown.
    expect(core.handle(ben, charterCmd(offers[1][2]))).toEqual([]);
    let beats = 0;
    let closing: Outbound[] = [];
    while (game().phase === 'council' && beats < COUNCIL_BEATS) {
      closing = core.step();
      feed(closing);
      beats++;
    }
    expect(beats).toBe(COUNCIL_SEAL_BEATS);
    expect(game()).toMatchObject({ phase: 'playing', quarter: 2, council: null });
    expect(game().players[0].charters).toEqual([offers[0][1]]);
    expect(game().players[1].charters).toEqual([offers[1][2]]);
    for (const p of game().players.slice(2)) expect(p.charters).toHaveLength(1);
    // The closing snapshot clears the Council for everyone and carries the adoptions.
    const snap = pick(closing, 'snap', '*')[0];
    expect(snap.cn).toBeNull();
    expect(snap.q).toEqual([2, 0, 0]);
    expect(snap.fx).toEqual(expect.arrayContaining([{ k: 'charter', p: 0, key: offers[0][1] }, { k: 'charter', p: 1, key: offers[1][2] }, { k: 'quarter', q: 2 }]));
    for (const v of views) {
      expect(v).toMatchObject({ inCouncil: false, council: null, era: 2 });
      expect(v.players.map((p) => p.charters)).toEqual(game().players.map((p) => p.charters));
      expect(v.chronicle[v.chronicle.length - 1]).toMatchObject({ cat: 'era', pill: 'Era II Unlocked' });
    }
    // And the match is running again on the next beat: the Era II tools are live.
    const next = pick(core.step(), 'snap')[0];
    expect(next.k).toBe(MODES.blitz.quarterTicks + 1);
    expect(next).not.toHaveProperty('cn');
    const free = CITY.lots.find((t) => !game().buildings.some((b) => b.tile === t)) as number;
    expect(core.handle(ada, { t: 'cmd', cmd: { c: 'build', tile: free, kind: 'arcade' } })).toEqual([]);
    expect(game().buildings.some((b) => b.tile === free && b.kind === 'arcade' && b.owner === 0)).toBe(true);
  });

  it('auto-selects on the countdown for a House that stays silent', () => {
    const { core, ada, game } = roomAtCouncil();
    const offers = clone(council(game()).offers);
    core.handle(ada, charterCmd(offers[0][2]));
    for (let i = 0; i < COUNCIL_BEATS - 1; i++) core.step();
    expect(game().phase).toBe('council');
    expect(council(game()).left).toBe(1);
    core.step();
    expect(game().phase).toBe('playing');
    expect(game().players[0].charters).toEqual([offers[0][2]]);
    expect(game().players[1].charters).toEqual([offers[1][0]]); // Ben's steward chose for him
  });

  it('runs the countdown in real time at any host pace, and offers only 1×, 1.5× and 2×', () => {
    const { core, ada, game, beats } = roomAtCouncil(2);
    expect(beats).toBe(MODES.blitz.quarterTicks / 2);
    for (let i = 0; i < COUNCIL_BEATS - 1; i++) core.step();
    expect(game().phase).toBe('council'); // 2× does not halve the Council
    core.step();
    expect(game().phase).toBe('playing');
    for (const speed of HOST_SPEEDS) expect(pick(core.handle(ada, { t: 'speed', speed }), 'reject')).toEqual([]);
    for (const speed of [0.5, 3, 0, -1]) expect(pick(core.handle(ada, { t: 'speed', speed }), 'reject')[0]?.err).toBe('Unknown pace');
  });

  it('does not wait for a disconnected human, and hands a reconnecting one the open Council', () => {
    const { core, ada, ben, game } = roomAtCouncil();
    const offers = clone(council(game()).offers);
    expect(core.councilVoters()).toEqual([0, 1]);
    core.disconnect(ben);
    expect(core.councilVoters()).toEqual([0]);
    // Ben comes back mid-Council: welcome, lobby, and a full snapshot with the Council in it.
    const back = core.join(ben, undefined, () => 'unused');
    expect(back.seat).toBe(1);
    const full = pick(back.out, 'snap', ben)[0];
    expect(full).toMatchObject({ full: true, q: [1, 2, 0] });
    expect(full.cn?.offers).toEqual(offers);
    const view = new CityView();
    view.apply(wire(full));
    expect(view.inCouncil).toBe(true);
    expect(view.council?.offers[1]).toEqual(offers[1]);
    expect(core.councilVoters()).toEqual([0, 1]);
    // He drops again; Ada alone is now everyone the room waits for.
    core.disconnect(ben);
    core.handle(ada, charterCmd(offers[0][0]));
    let beats = 0;
    while (game().phase === 'council' && beats < COUNCIL_BEATS) {
      core.step();
      beats++;
    }
    expect(beats).toBe(COUNCIL_SEAL_BEATS);
    expect(game().players[1].charters).toEqual([offers[1][0]]);
  });

  it('refuses a spectator’s pick, and holds the clock while no human is in the room', () => {
    const { core, ada, ben, game, newId } = roomAtCouncil();
    const watcher = core.join(null, 'Cy', newId);
    expect(watcher.seat).toBe(-1); // every seat is taken: a spectator
    expect(pick(watcher.out, 'snap', watcher.playerId)[0].cn).toEqual(council(game()));
    expect(core.handle(watcher.playerId, charterCmd(council(game()).offers[0][0]))).toEqual([
      { to: watcher.playerId, msg: { t: 'reject', err: 'Spectators cannot act' } },
    ]);
    expect(council(game()).picks.slice(0, 2)).toEqual([null, null]);
    core.disconnect(watcher.playerId);
    // Everyone leaves: the room goes quiet and the countdown waits for them.
    core.step();
    const left = council(game()).left;
    core.disconnect(ada);
    core.disconnect(ben);
    expect(core.running).toBe(false);
    for (let i = 0; i < 30; i++) expect(core.step()).toEqual([]);
    expect(council(game()).left).toBe(left);
    core.join(ada, undefined, () => 'unused');
    expect(core.running).toBe(true);
    core.step();
    expect(council(game()).left).toBe(left - 1);
  });

  it('survives a checkpoint taken mid-Council: restored, it counts down and closes identically', () => {
    const { core, ada, game } = roomAtCouncil();
    core.handle(ada, charterCmd(council(game()).offers[0][1]));
    for (let i = 0; i < 12; i++) core.step();
    const saved = clone(core.serialize());
    expect(saved.game?.phase).toBe('council');
    const twin = new RoomCore(saved.room.code, saved.room.seed, clone(saved));
    expect(twin.game?.council).toEqual(game().council);
    expect(twin.running).toBe(true);
    for (let i = 0; i < COUNCIL_BEATS + 40; i++) {
      core.step();
      twin.step();
    }
    expect(game().phase).toBe('playing');
    expect(game().quarter).toBe(2);
    expect(JSON.stringify(twin.game)).toBe(JSON.stringify(core.game));
  });

  it('restores a checkpoint written before the dynasty build and plays it through its Councils to the end', () => {
    const core = new RoomCore('OLDE', 99);
    const ada = core.join(null, 'Ada', () => 'ada').playerId;
    core.handle(ada, { t: 'mode', mode: 'blitz' });
    core.handle(ada, { t: 'start' });
    // Strip everything v2 added, as a v1 room would have saved it.
    type Loose = Record<string, unknown>;
    const saved = clone(core.serialize()) as unknown as { room: Loose; game: Loose & { players: (Loose & { ledger: Loose; lastLedger: Loose; totalLedger: Loose })[] } };
    for (const k of ['council', 'chronicle', 'chronicleN', 'leader', 'leadTick', 'eraCrowns']) delete saved.game[k];
    for (const p of saved.game.players) {
      delete p.charters;
      delete p.milestones;
      for (const l of [p.ledger, p.lastLedger, p.totalLedger]) delete l.dividends;
    }
    delete saved.room.acc;
    const restored = new RoomCore('OLDE', 99, saved as unknown as ReturnType<RoomCore['serialize']>);
    const game = restored.game as GameState;
    expect(game.players.every((p) => Array.isArray(p.charters) && p.milestones.length === 4)).toBe(true);
    expect(game).toMatchObject({ council: null, leader: -1, phase: 'playing' });
    expect(restored.join(ada, undefined, () => 'unused').seat).toBe(0);
    expect(restored.running).toBe(true);
    let beats = 0;
    let councils = 0;
    let inCouncil = false;
    while (restored.room.status === 'playing' && beats < 6000) {
      expect(() => restored.step()).not.toThrow();
      if (game.phase === 'council' && !inCouncil) councils++;
      inCouncil = game.phase === 'council';
      beats++;
    }
    expect(restored.room.status).toBe('ended');
    expect(councils).toBe(3);
    expect(beats).toBe(4 * MODES.blitz.quarterTicks + 3 * COUNCIL_BEATS);
    expect(game.result?.rows.every((r) => r.charters.length === 3 && r.stars >= 0)).toBe(true);
    for (const p of game.players) expect(p.cash).toBeCloseTo(START_CASH + ledgerCashChange(p.totalLedger), 6);
  });

  it('parses the charter command off the wire like any other command', () => {
    expect(parseClientMsg(JSON.stringify(charterCmd('credit')))).toEqual({ t: 'cmd', cmd: { c: 'charter', key: 'credit' } });
    expect(parseClientMsg('{"t":"cmd","cmd":{"key":"credit"}}')).toBeNull();
  });
});
