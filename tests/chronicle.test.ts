// The Mercadia Chronicle: every turning point is a dispatch with a headline, an exact
// mechanical impact tag, the acting House and (where there is one) a lot to look at.
import { describe, expect, it, vi } from 'vitest';
import { advance } from '../src/shared/ai';
import {
  CHRONICLE_KEEP,
  CIVICS,
  EVENTS,
  EVENT_KINDS,
  HOUSES,
  LEAD_CHECK,
  LEAD_MARGIN,
  LEAD_WARMUP,
  LEAD_QUIET,
  PROMO_PULL,
  PROMO_TICKS,
  RIVALRY_QUIET,
  SHOPS,
  STANCES,
} from '../src/shared/constants';
import { CITY, N } from '../src/shared/map';
import { applyCommand, closeCouncil, createGame, crownIndex, dispatch, eventReceipt, forceEvent, standings, tick } from '../src/shared/sim';
import type { Dispatch, DispatchCat, GameState } from '../src/shared/types';
import { ais, build, freeze, fxOf, humans, labGame, run, toEraClose } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const last = (s: GameState): Dispatch => s.chronicle[s.chronicle.length - 1];
const ofCat = (s: GameState, cat: DispatchCat): Dispatch[] => s.chronicle.filter((d) => d.cat === cat);
const CATS: DispatchCat[] = ['era', 'milestone', 'charter', 'lead', 'event', 'rival', 'promo', 'build', 'market'];

describe('Chronicle: the dispatch', () => {
  it('opens every match with the Founding Charter and its three Era I tools', () => {
    for (const mode of ['standard', 'blitz', 'endless'] as const) {
      const s = createGame({ seed: 3, mode, players: humans(2) });
      expect(s.chronicleN).toBe(1);
      expect(s.chronicle).toEqual([
        { n: 1, tick: 0, cat: 'era', tier: 1, head: 'Era I: Founding Charter', pill: 'Roastery · Bistro · Park', player: -1, tile: -1, icon: '' },
      ]);
      expect(s.gazette).toEqual([{ tick: 0, text: 'The district wakes. Lots are for lease along every lane.', tone: 'market' }]);
      expect(s.fx).toEqual([]); // nothing to replay on the first frame
      expect(s).toMatchObject({ leader: -1, leadTick: 0, council: null, eraCrowns: [] });
    }
  });

  it('numbers dispatches serially, keeps the latest CHRONICLE_KEEP, and mirrors each one in the Gazette and the fx stream', () => {
    const s = freeze(labGame());
    s.fx = [];
    const d = dispatch(s, { cat: 'rival', tier: 1, head: 'A headline', pill: 'Bistro +20%', player: 1, tile: 40, icon: 'bistro' });
    expect(d).toEqual({ n: 2, tick: 0, cat: 'rival', tier: 1, head: 'A headline', pill: 'Bistro +20%', player: 1, tile: 40, icon: 'bistro' });
    expect(last(s)).toBe(d);
    expect(s.fx).toEqual([{ k: 'dispatch', n: 2, tier: 1, cat: 'rival' }]);
    // The Gazette's prose line defaults to "headline — impact", in the category's tone.
    expect(s.gazette[s.gazette.length - 1]).toEqual({ tick: 0, text: 'A headline — Bistro +20%', tone: 'rival' });
    // Defaults: no House, no lot, no icon; and custom prose and tone are respected.
    const plain = dispatch(s, { cat: 'market', tier: 2, head: 'Quiet news', pill: '', text: 'Written out in full.', tone: 'civic' });
    expect(plain).toMatchObject({ n: 3, player: -1, tile: -1, icon: '', pill: '' });
    expect(s.gazette[s.gazette.length - 1]).toEqual({ tick: 0, text: 'Written out in full.', tone: 'civic' });
    expect(dispatch(s, { cat: 'market', tier: 2, head: 'No tag', pill: '' }).n).toBe(4);
    expect(s.gazette[s.gazette.length - 1].text).toBe('No tag');
    // Category → Gazette tone.
    const tones: Record<DispatchCat, string> = { era: 'market', milestone: 'market', charter: 'market', lead: 'market', market: 'market', event: 'event', rival: 'rival', promo: 'rival', build: 'civic' };
    for (const cat of CATS) {
      dispatch(s, { cat, tier: 2, head: cat, pill: 'x' });
      expect(s.gazette[s.gazette.length - 1].tone, cat).toBe(tones[cat]);
    }
    // The feed is capped; serial numbers are not reused and stay in step with the count.
    for (let i = 0; i < 40; i++) dispatch(s, { cat: 'market', tier: 2, head: `Filler ${i}`, pill: '' });
    expect(s.chronicle).toHaveLength(CHRONICLE_KEEP);
    expect(CHRONICLE_KEEP).toBeGreaterThanOrEqual(8); // room for the HUD's three or four and then some
    expect(last(s).n).toBe(s.chronicleN);
    expect(s.chronicle.map((x) => x.n)).toEqual(Array.from({ length: CHRONICLE_KEEP }, (_, i) => s.chronicleN - CHRONICLE_KEEP + 1 + i));
    expect(s.gazette).toHaveLength(10);
    expect(s.gazetteN).toBe(s.chronicleN); // one Gazette line per dispatch
  });
});

describe('Chronicle: what makes the news', () => {
  it('Era transitions: a Tier 1 headline with the unlock tag at every Council’s close', () => {
    const s = freeze(labGame({ mode: 'blitz' }));
    const seen: Dispatch[] = [];
    for (let era = 2; era <= 4; era++) {
      toEraClose(s);
      s.fx = [];
      closeCouncil(s);
      const d = last(s);
      seen.push(d);
      expect(d).toMatchObject({ cat: 'era', tier: 1, player: -1, tile: -1, tick: s.tick });
      expect(s.fx[s.fx.length - 1]).toEqual({ k: 'dispatch', n: d.n, tier: 1, cat: 'era' });
    }
    expect(seen.map((d) => [d.head, d.pill])).toEqual([
      ['Era II: Transit & Trade', 'Era II Unlocked'],
      ['Era III: Grand Boulevard', 'Era III Unlocked'],
      ['Era IV: Golden Dynasty', 'Final Reckoning'],
    ]);
    // The closing bell of each era is a Gazette line too.
    toEraClose(s);
    expect(s.phase).toBe('ended');
    expect(s.gazette.some((g) => g.text.startsWith('Era IV closes.'))).toBe(true);
  });

  it('Charter adoptions: one dispatch per House, naming the doctrine and its exact effect', () => {
    const s = createGame({ seed: 12, mode: 'blitz', players: ais(['vesper', 'aurelia', 'orson']) });
    while (s.phase === 'playing') tick(s);
    const n0 = s.chronicleN;
    closeCouncil(s);
    const adoptions = s.chronicle.filter((d) => d.n > n0 && d.cat === 'charter');
    expect(adoptions).toHaveLength(3);
    adoptions.forEach((d, i) => {
      const p = s.players[i];
      expect(d.player).toBe(i);
      expect(d.tier).toBe(2);
      expect(d.head.startsWith(`${HOUSES[p.house].short} adopts `)).toBe(true);
      expect(d.pill).toMatch(/[+−×]|Free/); // a mechanical effect, not a slogan
      expect(p.charters).toHaveLength(1);
    });
  });

  it('Crown lead changes: "New Leader", only for a real margin, and rationed', () => {
    // Not before the district has found its feet: an early lead is not printed during the warm-up.
    const early = freeze(labGame({ players: 3 }));
    early.players[0].prestige = 5;
    run(early, 5 * LEAD_CHECK);
    expect(early.tick).toBeLessThan(LEAD_WARMUP);
    expect(ofCat(early, 'lead')).toEqual([]);
    expect(early.leader).toBe(-1);
    run(early, LEAD_WARMUP);
    expect(early.leader).toBe(0);
    const s = freeze(labGame({ players: 3, era: 2 }));
    // Level pegging, or a lead inside the margin, is not news.
    run(s, 3 * LEAD_CHECK);
    expect(ofCat(s, 'lead')).toEqual([]);
    s.players[0].prestige = (LEAD_MARGIN - 1) / 4;
    run(s, 3 * LEAD_CHECK);
    expect(crownIndex(s, s.players[0]) - crownIndex(s, s.players[1])).toBe(LEAD_MARGIN - 1);
    expect(ofCat(s, 'lead')).toEqual([]);
    expect(s.leader).toBe(-1);
    // The first House clear of the field takes the first lead.
    s.players[0].prestige = 5;
    s.fx = [];
    run(s, LEAD_CHECK);
    expect(s.leader).toBe(0);
    expect(last(s)).toMatchObject({ cat: 'lead', tier: 1, head: 'Vermilion takes the first Crown lead', pill: 'New Leader', player: 0, tile: -1 });
    expect(fxOf(s.fx, 'dispatch')).toEqual([{ k: 'dispatch', n: last(s).n, tier: 1, cat: 'lead' }]);
    expect(s.gazette[s.gazette.length - 1].text).toBe(`Vermilion Guild takes the first Crown lead at ${crownIndex(s, s.players[0])}.`);
    const first = s.leadTick;
    // Holding the lead is not news.
    run(s, 4 * LEAD_CHECK);
    expect(ofCat(s, 'lead')).toHaveLength(1);
    // An overtake inside the quiet window waits; once the window passes it is printed.
    s.players[1].prestige = 12;
    expect(standings(s)[0].player).toBe(1);
    while (s.tick - first < LEAD_QUIET - 1) tick(s);
    expect(s.leader).toBe(0);
    expect(ofCat(s, 'lead')).toHaveLength(1);
    run(s, LEAD_CHECK);
    expect(s.leader).toBe(1);
    expect(last(s)).toMatchObject({ cat: 'lead', head: 'Cobalt overtakes Vermilion for the Crown', pill: 'New Leader', player: 1 });
    expect(s.leadTick - first).toBeGreaterThanOrEqual(LEAD_QUIET);
    // A lone House has nobody to overtake.
    const solo = freeze(createGame({ seed: 4, mode: 'standard', players: humans(1) }));
    solo.events = [];
    solo.players[0].prestige = 50;
    run(solo, LEAD_WARMUP + 50);
    expect(ofCat(solo, 'lead')).toEqual([]);
  });

  it('Builds: a House’s founding shop, every civic dedication, and every Level 3 unveiling — with the lot to focus on', () => {
    const s = freeze(labGame({ era: 3, cash: 9000 }));
    const shop = build(s, 0, 3, 6, 'bistro');
    expect(last(s)).toMatchObject({
      cat: 'build', tier: 2, head: 'Vermilion founds its first shop', pill: `Bistro · §${SHOPS.bistro.cost}`, player: 0, tile: shop.tile, icon: 'bistro',
    });
    const n = s.chronicleN;
    build(s, 0, 4, 6, 'roastery'); // the rest of the chain is not news
    expect(s.chronicleN).toBe(n);
    const park = build(s, 0, 9, 6, 'park');
    expect(last(s)).toMatchObject({ cat: 'build', tier: 2, head: 'Vermilion dedicates a Pocket Park', pill: `+${CIVICS.park.prestige} Prestige`, player: 0, tile: park.tile, icon: 'park' });
    expect(s.gazette[s.gazette.length - 1]).toMatchObject({ text: 'Vermilion dedicates a Pocket Park to the district.', tone: 'civic' });
    // A rival's first shop is its own founding.
    const theirs = build(s, 1, 4, 2, 'cinema');
    expect(last(s)).toMatchObject({ head: 'Cobalt founds its first shop', pill: `Cinema · §${SHOPS.cinema.cost}`, player: 1, tile: theirs.tile });
    const plaza = build(s, 1, 3, 2, 'plaza');
    expect(last(s)).toMatchObject({ head: 'Cobalt dedicates a Festival Plaza', pill: '+10 Prestige', player: 1, tile: plaza.tile });
    // Level 2 is routine; Level 3 is grand architecture.
    applyCommand(s, 0, { c: 'upgrade', id: shop.id });
    expect(last(s).head).toBe('Cobalt dedicates a Festival Plaza');
    applyCommand(s, 0, { c: 'upgrade', id: shop.id });
    expect(last(s)).toMatchObject({ cat: 'build', tier: 2, head: 'Vermilion unveils a grand Bistro', pill: 'Level 3 · +26% appeal', player: 0, tile: shop.tile, icon: 'bistro' });
  });

  it('prints the founding-shop dispatch even when a civic project was built first', () => {
    const s = freeze(labGame({ cash: 9000 }));
    build(s, 0, 9, 6, 'park');
    const shop = build(s, 0, 3, 6, 'bistro');
    expect(last(s)).toMatchObject({ cat: 'build', head: 'Vermilion founds its first shop', tile: shop.tile });
  });

  it('Promo Blitzes and price-war undercuts: Tier 1 rivalry dispatches naming both Houses, rationed to one per quiet window', () => {
    const s = freeze(labGame({ cash: 9000 }));
    const mine = build(s, 0, 3, 6, 'roastery');
    const other = build(s, 0, 9, 6, 'bistro');
    // No rival of the trade in reach: the blitz papers the lanes.
    expect(applyCommand(s, 0, { c: 'promo', id: mine.id }).ok).toBe(true);
    expect(last(s)).toMatchObject({
      cat: 'promo', tier: 1, head: 'Promo Blitz! Vermilion papers the lanes', player: 0, tile: mine.tile, icon: 'roastery',
      pill: `Roastery pull ×${PROMO_PULL} · ${PROMO_TICKS / 10}s`,
    });
    expect(s.gazette[s.gazette.length - 1]).toMatchObject({ tone: 'rival', text: "Promo Blitz! Vermilion's Roastery papers the lanes with flyers." });
    // A second blitz inside the quiet window happens, but is not another headline.
    const n = s.chronicleN;
    expect(applyCommand(s, 0, { c: 'promo', id: other.id }).ok).toBe(true);
    expect(other.promoUntil).toBeGreaterThan(s.tick);
    expect(s.chronicleN).toBe(n);
    // After it: a rival's blitz beside Vermilion's Roastery names whose queue it poaches.
    const theirs = build(s, 1, 4, 6, 'roastery');
    run(s, RIVALRY_QUIET);
    expect(applyCommand(s, 1, { c: 'promo', id: theirs.id }).ok).toBe(true);
    expect(last(s)).toMatchObject({ cat: 'promo', tier: 1, head: "Promo Blitz! Cobalt poaches Vermilion's queue", player: 1, tile: theirs.tile });
    // Undercut: Vermilion drops to Budget under Cobalt's Craft, next door, same trade.
    run(s, RIVALRY_QUIET);
    expect(applyCommand(s, 1, { c: 'price', id: theirs.id, stance: 2 }).ok).toBe(true);
    expect(ofCat(s, 'rival')).toEqual([]); // raising a price is not a price war
    expect(applyCommand(s, 0, { c: 'price', id: mine.id, stance: 0 }).ok).toBe(true);
    expect(last(s)).toMatchObject({
      cat: 'rival', tier: 1, head: 'Price war: Vermilion undercuts Cobalt', player: 0, tile: mine.tile, icon: 'roastery',
      pill: `Roastery ${STANCES[0].label} vs ${STANCES[2].label}`,
    });
    expect(last(s).pill).toBe('Roastery -25% vs +20%');
    expect(s.gazette[s.gazette.length - 1].text).toBe("Price war: Vermilion undercuts Cobalt's Roastery — Budget against Craft.");
    // Dropping a price with no dearer rival of the trade nearby is just a price.
    run(s, RIVALRY_QUIET);
    const quiet = s.chronicleN;
    expect(applyCommand(s, 0, { c: 'price', id: other.id, stance: 0 }).ok).toBe(true);
    expect(s.chronicleN).toBe(quiet);
  });

  it('City events: forecast, start and closing receipt, each with the event’s impact tag', () => {
    for (const kind of EVENT_KINDS) expect(EVENTS[kind].pill.length, kind).toBeGreaterThan(4);
    expect(EVENTS.cloudburst.pill).toBe('Cinema +45%');
    // The scheduled life of an event: three dispatches in order.
    const s = createGame({ seed: 6, mode: 'standard', players: humans(2) }); // an empty district: nothing else is news
    const e = s.events[0];
    const def = EVENTS[e.kind];
    while (s.tick < e.announceAt) tick(s);
    expect(last(s)).toMatchObject({ cat: 'event', tier: 1, head: `Forecast: ${def.title}`, pill: def.pill, icon: e.kind, tick: e.announceAt });
    expect(s.gazette[s.gazette.length - 1]).toEqual({ tick: e.announceAt, text: def.forecast, tone: 'event' });
    while (s.tick < e.startAt) tick(s);
    expect(last(s)).toMatchObject({ cat: 'event', tier: 1, head: def.title, pill: def.pill, icon: e.kind, tick: e.startAt });
    expect(s.gazette[s.gazette.length - 1].text).toBe(def.headline);
    const n = s.chronicleN;
    while (s.tick < e.endAt) tick(s);
    expect(s.chronicleN).toBeGreaterThan(n);
    const closing = s.chronicle.filter((d) => d.n > n && d.cat === 'event');
    expect(closing.length).toBeGreaterThanOrEqual(1);
    expect(closing[0]).toMatchObject({ icon: e.kind, tick: e.endAt });
    // Exact tags, event by event.
    const rain = freeze(labGame({ era: 3, cash: 9000 }));
    forceEvent(rain, 'cloudburst', 40);
    expect(last(rain)).toMatchObject({ cat: 'event', tier: 1, head: 'Sudden Cloudburst', pill: 'Cinema +45%', icon: 'cloudburst', player: -1, tile: -1 });
    const ev = rain.events[0];
    run(rain, 40);
    expect(last(rain)).toMatchObject({ cat: 'event', tier: 1, head: 'Cloudburst passed', pill: 'No sales', icon: 'cloudburst' });
    expect(rain.gazette[rain.gazette.length - 1].text).toBe(eventReceipt(rain, ev));
    // A receipt names its top earner and credits that House on the dispatch.
    const cruise = freeze(labGame({ era: 3, cash: 9000 }));
    const live = forceEvent(cruise, 'cruise', 30);
    expect(last(cruise)).toMatchObject({ head: 'Harbor Cruise Arrival', pill: 'Boutique +40%', tile: CITY.pierTile });
    cruise.cruiseLeft = 0;
    live.n = 28;
    live.take = [10, 400];
    run(cruise, 30);
    expect(last(cruise)).toMatchObject({ cat: 'event', head: 'Harbor Cruise closed', pill: '28 served · Cobalt', player: 1, tile: CITY.pierTile });
    expect(cruise.gazette[cruise.gazette.length - 1].text).toBe('Harbor Cruise closed — 28 tourists served · Top earner: Cobalt');
    const hike = freeze(labGame({ era: 3, cash: 9000 }));
    const rent = forceEvent(hike, 'renthike', 30);
    expect(last(hike)).toMatchObject({ head: 'Commercial Rent Hike', pill: 'Rent +25%' });
    rent.take = [12.4, 3];
    run(hike, 30);
    expect(last(hike)).toMatchObject({ head: 'Rent Hike lifted', pill: '−§15 rent', player: 0 });
    // The critic's verdict is its own receipt.
    const critic = freeze(labGame({ cash: 9000 }));
    const kitchen = build(critic, 1, 3, 6, 'bistro');
    forceEvent(critic, 'critic', 20);
    run(critic, 20);
    expect(last(critic)).toMatchObject({ cat: 'event', tier: 1, head: "Golden Fork to Cobalt's Bistro", pill: '+§250 · +10 Prestige', player: 1, tile: kitchen.tile, icon: 'critic' });
    const hungry = freeze(labGame());
    forceEvent(hungry, 'critic', 20);
    run(hungry, 20);
    expect(last(hungry)).toMatchObject({ cat: 'event', tier: 2, head: 'The critic leaves hungry', pill: 'No Golden Fork' });
  });
});

describe('Chronicle over a whole match', () => {
  it('stays well-formed, serial and loud: every category a full AI match can produce turns up', () => {
    const s = createGame({ seed: 202, mode: 'standard', players: ais(['vesper', 'aurelia', 'orson', 'vesper']) });
    const all: Dispatch[] = [];
    let announced = 0;
    let guard = 0;
    while (s.phase !== 'ended' && guard++ < 20000) {
      if (s.phase === 'council') closeCouncil(s);
      else advance(s); // what the solo session and the room run: AI, then a tick
      for (const f of fxOf(s.fx, 'dispatch')) {
        announced++;
        const d = s.chronicle.find((x) => x.n === f.n) as Dispatch;
        expect(d, `dispatch ${f.n} is in the feed when it is announced`).toBeDefined();
        expect(f).toEqual({ k: 'dispatch', n: d.n, tier: d.tier, cat: d.cat });
        all.push({ ...d });
      }
      s.fx = [];
      expect(s.chronicle.length).toBeLessThanOrEqual(CHRONICLE_KEEP);
    }
    expect(s.phase).toBe('ended');
    // Serial numbers: 2, 3, 4, … with nothing skipped and nothing repeated (1 was the opening).
    expect(all.map((d) => d.n)).toEqual(Array.from({ length: all.length }, (_, i) => i + 2));
    expect(announced).toBe(s.chronicleN - 1);
    for (const d of all) {
      expect(CATS).toContain(d.cat);
      expect([1, 2]).toContain(d.tier);
      expect(d.head.length).toBeGreaterThan(5);
      expect(d.head.length).toBeLessThan(64); // a headline, not a paragraph
      expect(d.pill.length).toBeLessThan(40);
      expect(d.player === -1 || (d.player >= 0 && d.player < s.players.length)).toBe(true);
      expect(d.tile === -1 || (Number.isInteger(d.tile) && d.tile >= 0 && d.tile < N)).toBe(true);
      expect(d.tick).toBeGreaterThanOrEqual(0);
      expect(d.tick).toBeLessThanOrEqual(s.tick);
    }
    const count = (cat: DispatchCat): number => all.filter((d) => d.cat === cat).length;
    expect(count('era')).toBe(3); // Eras II, III and IV (Era I opened the match)
    expect(count('charter')).toBe(12); // four Houses, three Councils
    expect(count('milestone')).toBe(s.players.reduce((a, p) => a + p.milestones.filter((t) => t >= 0).length, 0));
    expect(count('milestone')).toBeGreaterThanOrEqual(8);
    expect(count('lead')).toBeGreaterThanOrEqual(1);
    expect(count('event')).toBeGreaterThanOrEqual(12); // three events an era, forecast and start at least
    expect(count('build')).toBeGreaterThanOrEqual(6); // four founding shops and the civic dedications
    expect(count('promo') + count('rival')).toBeGreaterThanOrEqual(3); // the Discounters see to that
    // The loud ones — eras, milestones, lead changes, events, rivalry — are Tier 1.
    for (const d of all) {
      if (d.cat === 'era' || d.cat === 'milestone' || d.cat === 'lead' || d.cat === 'promo' || d.cat === 'rival') expect(d.tier, d.head).toBe(1);
      if (d.cat === 'charter' || d.cat === 'build') expect(d.tier, d.head).toBe(2);
      // Every rivalry, promo and build dispatch can be clicked to focus a lot, and names its House.
      if (d.cat === 'promo' || d.cat === 'rival' || d.cat === 'build') {
        expect(d.tile, d.head).toBeGreaterThanOrEqual(0);
        expect(CITY.tiles[d.tile]).toBe('lot');
        expect(d.player, d.head).toBeGreaterThanOrEqual(0);
      }
      if (d.cat === 'milestone' || d.cat === 'charter' || d.cat === 'lead') expect(d.player, d.head).toBeGreaterThanOrEqual(0);
    }
    // Rivalry headlines never crowd each other.
    const rivalry = all.filter((d) => d.cat === 'promo' || d.cat === 'rival');
    for (let i = 1; i < rivalry.length; i++) expect(rivalry[i].tick - rivalry[i - 1].tick).toBeGreaterThanOrEqual(RIVALRY_QUIET);
    const leads = all.filter((d) => d.cat === 'lead');
    for (let i = 1; i < leads.length; i++) expect(leads[i].tick - leads[i - 1].tick).toBeGreaterThanOrEqual(LEAD_QUIET);
    // Every dispatch is a Gazette line too; the only others are the four closing bells.
    expect(s.gazetteN - s.chronicleN).toBe(4);
    expect(s.leaders).toHaveLength(4);
  });
});
