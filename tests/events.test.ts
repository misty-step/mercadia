import { describe, expect, it, vi } from 'vitest';
import {
  CRITIC_PRESTIGE,
  CRITIC_PRIZE,
  CRUISE_TOURISTS,
  DESIRES,
  EVENTS,
  EVENT_KINDS,
  FORECAST_LEAD,
  MODES,
  RENT_HIKE,
  SHOPS,
  SUPPLY_CRUNCH,
} from '../src/shared/constants';
import { CITY, idx, tx, ty } from '../src/shared/map';
import {
  activeEvent,
  closeCouncil,
  createGame,
  decide,
  demandMult,
  desireWeights,
  eventActive,
  forceEvent,
  headlineEvent,
  rentOf,
  restockCost,
  tick,
} from '../src/shared/sim';
import type { Desire, EventKind, Fx, GameState, MatchMode } from '../src/shared/types';
import { build, clone, dist2, freeze, fxOf, humans, labGame, putCitizen, run } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const di = (d: Desire): number => DESIRES.indexOf(d);
const mults = (s: GameState): Record<Desire, number> =>
  Object.fromEntries(DESIRES.map((d) => [d, demandMult(s, d)])) as Record<Desire, number>;
const CALM: Record<Desire, number> = { coffee: 1, dining: 1, leisure: 1, fashion: 1, culture: 1, nightlife: 1 };

function expectScheduleInside(s: GameState): void {
  const mode = MODES[s.mode];
  const start = (s.quarter - 1) * s.quarterTicks;
  const end = start + s.quarterTicks;
  expect(s.events).toHaveLength(mode.slots.length);
  let prevEnd = start;
  s.events.forEach((e, i) => {
    expect(EVENT_KINDS).toContain(e.kind);
    expect(e.started).toBe(false);
    expect(e.announceAt).toBeLessThan(e.startAt);
    expect(e.startAt).toBeLessThan(e.endAt);
    expect(e.announceAt).toBeGreaterThanOrEqual(start);
    expect(e.endAt).toBeLessThanOrEqual(end);
    // Ascending and never overlapping: one event at a time.
    expect(e.announceAt).toBeGreaterThanOrEqual(prevEnd);
    prevEnd = e.endAt;
    expect(e.startAt).toBe(start + Math.round(mode.slots[i] * s.quarterTicks));
    expect(e.startAt - e.announceAt).toBe(Math.round(FORECAST_LEAD * s.quarterTicks));
    expect(e.endAt - e.startAt).toBe(Math.round(mode.span * s.quarterTicks));
  });
}

describe('Dynamic events: the quarterly schedule', () => {
  it('schedules one event per slot of the mode, forecast before start before end, all inside the quarter', () => {
    for (const mode of ['blitz', 'standard', 'endless'] as MatchMode[]) {
      for (let seed = 1; seed <= 12; seed++) {
        expectScheduleInside(createGame({ seed, mode, players: humans(1) }));
      }
    }
  });

  it('re-schedules a fresh set of events inside each new quarter', () => {
    const s = createGame({ seed: 4, mode: 'blitz', players: humans(2) });
    const first = clone(s.events);
    run(s, s.quarterTicks);
    // The era has closed and the Council sits: the new schedule is drawn when it rises.
    expect(s.phase).toBe('council');
    expect(s.quarter).toBe(1);
    // Nothing is live or forecast while the Council sits.
    expect(s.events).toEqual([]);
    expect(activeEvent(s)).toBeNull();
    expect(headlineEvent(s)).toBeNull();
    expect(closeCouncil(s)).toBe(true);
    expect(s.quarter).toBe(2);
    expectScheduleInside(s);
    expect(s.events[0].announceAt).toBeGreaterThan(first[first.length - 1].endAt);
    const e = createGame({ seed: 4, mode: 'endless', players: humans(1) });
    for (let q = 2; q <= 6; q++) {
      run(e, e.quarterTicks);
      // Endless convenes a Council after Eras I, II and III, and none after that.
      expect(e.phase).toBe(q <= 4 ? 'council' : 'playing');
      if (e.phase === 'council') closeCouncil(e);
      expect(e.quarter).toBe(q);
      expectScheduleInside(e);
    }
  });

  it('keeps the Lantern Festival for the evening slot and never repeats an event back to back', () => {
    const seen = new Set<EventKind>();
    let lanterns = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const s = createGame({ seed, mode: 'standard', players: humans(1) });
      s.events.forEach((e, i) => {
        seen.add(e.kind);
        if (e.kind === 'lantern') {
          lanterns++;
          expect(i).toBe(s.events.length - 1);
        }
        if (i > 0) expect(e.kind).not.toBe(s.events[i - 1].kind);
      });
    }
    // Every event in the Gazette's repertoire turns up, and the lanterns on a fair share of evenings.
    expect([...seen].sort()).toEqual(EVENT_KINDS.slice().sort());
    expect(lanterns).toBeGreaterThan(20);
    expect(lanterns).toBeLessThan(60);
  });

  it('forecasts each event in the Gazette, then starts it, then ends it, on the scheduled ticks', () => {
    const s = createGame({ seed: 9, mode: 'standard', players: humans(2) });
    const plan = clone(s.events);
    const log: { tick: number; kind: EventKind; phase: string }[] = [];
    const headlines: (string | null)[] = [];
    const gazetteAt = new Map<number, string>();
    for (let i = 0; i < s.quarterTicks - 1; i++) {
      s.fx = [];
      tick(s);
      for (const f of fxOf(s.fx, 'event')) {
        log.push({ tick: s.tick, kind: f.kind, phase: f.phase });
        if (f.phase !== 'end') gazetteAt.set(s.tick, s.gazette[s.gazette.length - 1].text);
      }
      const h = headlineEvent(s);
      headlines[s.tick] = h ? `${h.kind}:${h.started ? 'on' : 'forecast'}` : null;
      const a = activeEvent(s);
      expect(a === null ? null : a.kind).toBe(h && h.started ? h.kind : null);
    }
    expect(log).toEqual(
      plan.flatMap((e) => [
        { tick: e.announceAt, kind: e.kind, phase: 'forecast' },
        { tick: e.startAt, kind: e.kind, phase: 'start' },
        { tick: e.endAt, kind: e.kind, phase: 'end' },
      ]),
    );
    for (const e of plan) {
      expect(gazetteAt.get(e.announceAt)).toBe(EVENTS[e.kind].forecast);
      expect(gazetteAt.get(e.startAt)).toBe(EVENTS[e.kind].headline);
      // headlineEvent: nothing, then the forecast, then the running event, then nothing again.
      expect(headlines[e.announceAt - 1]).toBeNull();
      expect(headlines[e.announceAt]).toBe(`${e.kind}:forecast`);
      expect(headlines[e.startAt - 1]).toBe(`${e.kind}:forecast`);
      expect(headlines[e.startAt]).toBe(`${e.kind}:on`);
      expect(headlines[e.endAt - 1]).toBe(`${e.kind}:on`);
      expect(headlines[e.endAt]).toBeNull();
    }
    expect(s.gazette.filter((g) => g.tone === 'event').length).toBeGreaterThanOrEqual(2);
    expect(s.gazette.length).toBeLessThanOrEqual(10);
  });

  it('forceEvent starts an event at once, replaces the schedule and ends any event already running', () => {
    const s = createGame({ seed: 9, mode: 'standard', players: humans(1) });
    expect(activeEvent(s)).toBeNull();
    const ev = forceEvent(s, 'freeride', 30);
    expect(ev).toMatchObject({ kind: 'freeride', startAt: s.tick, endAt: s.tick + 30, started: true });
    expect(s.events).toEqual([ev]);
    expect(activeEvent(s)).toBe(ev);
    expect(headlineEvent(s)).toBe(ev);
    expect(fxOf(s.fx, 'event')).toEqual([{ k: 'event', kind: 'freeride', phase: 'start' }]);
    expect(s.gazette[s.gazette.length - 1]).toEqual({ tick: s.tick, text: EVENTS.freeride.headline, tone: 'event' });
    expect(s.trams).toHaveLength(3);
    run(s, 10);
    const next = forceEvent(s, 'lantern', 20);
    expect(s.events).toEqual([next]);
    expect(fxOf(s.fx, 'event').map((f) => `${f.kind}:${f.phase}`)).toEqual(['freeride:start', 'freeride:end', 'lantern:start']);
    expect(s.trams).toHaveLength(2);
    expect(eventActive(s, 'lantern')).toBe(true);
    expect(eventActive(s, 'freeride')).toBe(false);
    run(s, 19);
    expect(eventActive(s, 'lantern')).toBe(true);
    run(s, 1);
    expect(activeEvent(s)).toBeNull();
    expect(headlineEvent(s)).toBeNull();
    expect(fxOf(s.fx, 'event').pop()).toEqual({ k: 'event', kind: 'lantern', phase: 'end' });
  });

  it('ends an event that is still running when the quarter closes', () => {
    const s = createGame({ seed: 5, mode: 'blitz', players: humans(1) });
    run(s, s.quarterTicks - 10);
    forceEvent(s, 'freeride', 5000);
    expect(s.trams).toHaveLength(3);
    s.fx = [];
    run(s, 10);
    // The event is wound up at the era's close, before the Council sits…
    expect(s.phase).toBe('council');
    const closing: Fx[] = s.fx.filter((f) => f.k === 'event' || f.k === 'quarter' || f.k === 'council');
    expect(closing).toEqual([
      { k: 'event', kind: 'freeride', phase: 'end' },
      { k: 'council', era: 1 },
    ]);
    expect(s.trams).toHaveLength(2);
    // …and the next era opens with a fresh schedule once it rises.
    closeCouncil(s);
    expect(s.quarter).toBe(2);
    expect(s.fx.filter((f) => f.k === 'quarter')).toEqual([{ k: 'quarter', q: 2 }]);
    expect(s.trams).toHaveLength(2);
    expect(activeEvent(s)).toBeNull();
    expectScheduleInside(s);
  });
});

describe('Dynamic events: Sudden Cloudburst', () => {
  it('lifts demand for culture and coffee by 45% and cuts nightlife by 35% while it rains', () => {
    const s = labGame();
    expect(mults(s)).toEqual(CALM);
    forceEvent(s, 'cloudburst', 40);
    expect(demandMult(s, 'culture')).toBe(1.45);
    expect(demandMult(s, 'coffee')).toBe(1.45);
    expect(demandMult(s, 'nightlife')).toBe(0.65);
    expect(mults(s)).toEqual({ ...CALM, ...EVENTS.cloudburst.demand });
    run(s, 40);
    expect(mults(s)).toEqual(CALM);
  });

  it('shows up in every archetype’s desire weights', () => {
    const dry = labGame();
    dry.tick = Math.round(dry.quarterTicks * 0.8); // twilight: every desire is in play
    const wet = clone(dry);
    forceEvent(wet, 'cloudburst');
    for (const arch of ['commuter', 'local', 'foodie', 'tourist', 'nightowl'] as const) {
      const a = desireWeights(dry, arch);
      const b = desireWeights(wet, arch);
      DESIRES.forEach((d, i) => {
        expect(a[i]).toBeGreaterThan(0);
        expect(b[i] / a[i]).toBeCloseTo(EVENTS.cloudburst.demand[d] ?? 1, 9);
      });
      expect(b[di('culture')] / a[di('culture')]).toBeCloseTo(1.45, 9);
      expect(b[di('nightlife')] / a[di('nightlife')]).toBeCloseTo(0.65, 9);
    }
  });

  it('A/B at one instant: the same crowd asked with and without rain picks Cinema and Roastery more, Nightmarket less', () => {
    const base = freeze(labGame({ era: 3, seed: 4, cash: 100000 })); // the Cinema unlocks in Era III
    const cinema = build(base, 0, 3, 6, 'cinema');
    const roastery = build(base, 0, 9, 6, 'roastery');
    const market = build(base, 0, 8, 4, 'nightmarket');
    base.tick += Math.round(base.quarterTicks * 0.8); // twilight: all three trades are wanted
    const poll = (rain: boolean): { indoor: number; night: number; firstIndoor: number; firstNight: number } => {
      const s = clone(base);
      if (rain) forceEvent(s, 'cloudburst');
      const out = { indoor: 0, night: 0, firstIndoor: 0, firstNight: 0 };
      for (let i = 0; i < 3000; i++) {
        const c = putCitizen(s, idx(6, 7), { arch: i % 2 ? 'local' : 'nightowl', budget: 60 });
        decide(s, c);
        if (c.target === cinema.id || c.target === roastery.id) out.indoor++;
        else if (c.target === market.id) out.night++;
        s.citizens = [];
      }
      // `met` counts first choices that found a shop: the purest measure of intent.
      out.firstIndoor = s.met[di('culture')] + s.met[di('coffee')];
      out.firstNight = s.met[di('nightlife')];
      return out;
    };
    const dry = poll(false);
    const wet = poll(true);
    expect(dry.indoor).toBeGreaterThan(300);
    expect(dry.night).toBeGreaterThan(300);
    expect(wet.indoor).toBeGreaterThan(dry.indoor * 1.1);
    expect(wet.night).toBeLessThan(dry.night * 0.8);
    expect(wet.firstIndoor).toBeGreaterThan(dry.firstIndoor * 1.15);
    expect(wet.firstNight).toBeLessThan(dry.firstNight * 0.8);
  });

  it('A/B over an evening: twelve districts played with and without rain — more intents for Cinema and Roastery, fewer for the Nightmarket', () => {
    const DAY = MODES.standard.quarterTicks;
    const START = Math.round(DAY * 0.75) + 10; // twilight of a Standard day
    const LEN = Math.round(DAY * 0.22);
    const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const total = { wet: { indoor: 0, night: 0 }, dry: { indoor: 0, night: 0 } };
    let seedsWetter = 0;
    let seedsQuieter = 0;
    for (const seed of SEEDS) {
      const base = labGame({ era: 3, seed, cash: 100000 });
      build(base, 0, 3, 6, 'cinema');
      build(base, 0, 9, 6, 'roastery');
      build(base, 0, 8, 4, 'nightmarket');
      run(base, START);
      base.met = base.met.map(() => 0);
      const play = (rain: boolean): { indoor: number; night: number } => {
        const s = clone(base);
        if (rain) forceEvent(s, 'cloudburst', LEN + 10);
        for (let i = 0; i < LEN; i++) {
          tick(s);
          if (eventActive(s, 'cloudburst') !== rain) throw new Error(`weather changed at tick ${s.tick}`);
        }
        return { indoor: s.met[di('culture')] + s.met[di('coffee')], night: s.met[di('nightlife')] };
      };
      const wet = play(true);
      const dry = play(false);
      if (wet.indoor > dry.indoor) seedsWetter++;
      if (wet.night < dry.night) seedsQuieter++;
      for (const k of ['indoor', 'night'] as const) {
        total.wet[k] += wet[k];
        total.dry[k] += dry[k];
      }
    }
    expect(total.dry.indoor).toBeGreaterThan(100);
    expect(total.dry.night).toBeGreaterThan(100);
    // Measured lift is about +65% / −30% in aggregate; the margins leave room for crowd noise.
    expect(total.wet.indoor).toBeGreaterThan(total.dry.indoor * 1.2);
    expect(total.wet.night).toBeLessThan(total.dry.night * 0.92);
    expect(seedsWetter).toBeGreaterThanOrEqual(SEEDS.length - 2);
    expect(seedsQuieter).toBeGreaterThan(SEEDS.length / 2);
  });
});

describe('Dynamic events: Food Critic Visit', () => {
  it('crowns the best-rated kitchen when the visit ends: prize, prestige, Golden Fork', () => {
    const s = freeze(labGame({ era: 3, players: 3, cash: 2000 }));
    const bistro = build(s, 0, 3, 6, 'bistro');
    const roastery = build(s, 1, 9, 6, 'roastery');
    const cinema = build(s, 2, 8, 4, 'cinema');
    bistro.rating = 3.1;
    roastery.rating = 4.2;
    cinema.rating = 5; // not a kitchen
    const cash = s.players.map((p) => p.cash);
    forceEvent(s, 'critic', 6);
    expect(demandMult(s, 'dining')).toBe(EVENTS.critic.demand.dining);
    run(s, 5);
    expect(fxOf(s.fx, 'award')).toHaveLength(0);
    expect(s.players[1].stats.goldenForks).toBe(0);
    run(s, 1);
    const winner = s.players[1];
    expect(winner.cash - cash[1]).toBe(CRITIC_PRIZE);
    expect(winner.ledger.awards).toBe(CRITIC_PRIZE);
    expect(winner.totalLedger.awards).toBe(CRITIC_PRIZE);
    expect(winner.prestige).toBe(CRITIC_PRESTIGE);
    expect(winner.stats.goldenForks).toBe(1);
    expect(fxOf(s.fx, 'award')).toEqual([{ k: 'award', b: roastery.id, p: 1 }]);
    expect(roastery.rating).toBeGreaterThan(4.2); // the Fork polishes a reputation
    expect(bistro.rating).toBe(3.1);
    expect(s.gazette[s.gazette.length - 1].text).toContain('Golden Fork');
    for (const loser of [0, 2]) {
      expect(s.players[loser].cash).toBe(cash[loser]);
      expect(s.players[loser].ledger.awards).toBe(0);
      expect(s.players[loser].prestige).toBe(0);
      expect(s.players[loser].stats.goldenForks).toBe(0);
    }
    // One visit, one fork.
    run(s, 20);
    expect(fxOf(s.fx, 'award')).toHaveLength(1);
    expect(winner.stats.goldenForks).toBe(1);
  });

  it('breaks a tie on rating by covers served, and leaves hungry when no kitchen is open', () => {
    const s = freeze(labGame({ era: 3, cash: 2000 }));
    const a = build(s, 0, 3, 6, 'bistro');
    const b = build(s, 1, 9, 6, 'bistro');
    a.rating = b.rating = 4;
    a.served = 12;
    b.served = 40;
    forceEvent(s, 'critic', 2);
    run(s, 2);
    expect(fxOf(s.fx, 'award')).toEqual([{ k: 'award', b: b.id, p: 1 }]);
    expect(s.players[0].stats.goldenForks).toBe(0);

    const empty = freeze(labGame({ era: 3, cash: 2000 }));
    build(empty, 0, 3, 6, 'cinema');
    build(empty, 1, 9, 6, 'park');
    const before = empty.players.map((p) => [p.cash, p.prestige]);
    forceEvent(empty, 'critic', 2);
    expect(() => run(empty, 3)).not.toThrow();
    expect(fxOf(empty.fx, 'award')).toHaveLength(0);
    expect(fxOf(empty.fx, 'event').map((f) => f.phase)).toEqual(['start', 'end']);
    expect(empty.players.map((p) => [p.cash, p.prestige])).toEqual(before);
    expect(empty.players.every((p) => p.stats.goldenForks === 0 && p.ledger.awards === 0)).toBe(true);
    expect(empty.gazette[empty.gazette.length - 1].text).toMatch(/critic leaves hungry/i);
  });
});

describe('Dynamic events: Rent Hike and Supply Crunch', () => {
  it('toggles the rent hike on and off with the event and leaves demand alone', () => {
    const s = freeze(labGame({ era: 3, cash: 2000 }));
    const b = build(s, 0, 3, 6, 'boutique');
    expect(eventActive(s, 'renthike')).toBe(false);
    forceEvent(s, 'renthike', 25);
    expect(eventActive(s, 'renthike')).toBe(true);
    expect(eventActive(s, 'supplycrunch')).toBe(false);
    expect(mults(s)).toEqual(CALM);
    expect(rentOf(b, eventActive(s, 'renthike')) / rentOf(b)).toBeCloseTo(RENT_HIKE, 2);
    run(s, 24);
    expect(eventActive(s, 'renthike')).toBe(true);
    run(s, 1);
    expect(eventActive(s, 'renthike')).toBe(false);
    expect(rentOf(b, eventActive(s, 'renthike'))).toBe(rentOf(b));
  });

  it('raises the quoted restock cost for the length of a Supply Crunch', () => {
    const s = freeze(labGame({ era: 3, cash: 2000 }));
    const b = build(s, 0, 3, 6, 'bistro');
    b.auto = false;
    b.stock = 4;
    const units = SHOPS.bistro.stockMax - 4;
    const calm = restockCost(s, b, false);
    expect(calm).toBe(units * SHOPS.bistro.unitCost);
    forceEvent(s, 'supplycrunch', 25);
    expect(restockCost(s, b, false)).toBe(Math.ceil(units * SHOPS.bistro.unitCost * SUPPLY_CRUNCH));
    expect(restockCost(s, b, false)).toBeGreaterThan(calm);
    expect(restockCost(s, b, true)).toBeGreaterThan(restockCost(s, b, false));
    expect(mults(s)).toEqual(CALM);
    run(s, 25);
    expect(eventActive(s, 'supplycrunch')).toBe(false);
    expect(restockCost(s, b, false)).toBe(calm);
  });
});

describe('Dynamic events: Harbor Cruise Arrival', () => {
  it('lands a wave of tourists at the pier, one every few ticks, and whets fashion and dining', () => {
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    build(s, 0, 9, 6, 'boutique');
    build(s, 0, 8, 6, 'bistro');
    forceEvent(s, 'cruise', 5 * CRUISE_TOURISTS + 50);
    expect(s.cruiseLeft).toBe(CRUISE_TOURISTS);
    expect(mults(s)).toEqual({ ...CALM, ...EVENTS.cruise.demand });
    expect(demandMult(s, 'fashion')).toBeGreaterThan(1);
    expect(demandMult(s, 'dining')).toBeGreaterThan(1);
    const firstId = s.nextCitizenId;
    const known = new Set<number>();
    let seenAtPier = 0;
    for (let i = 1; i <= 5 * CRUISE_TOURISTS; i++) {
      tick(s);
      expect(s.cruiseLeft).toBe(CRUISE_TOURISTS - Math.floor(i / 5));
      expect(s.nextCitizenId - firstId).toBe(Math.floor(i / 5));
      for (const c of s.citizens) {
        if (known.has(c.id)) continue;
        known.add(c.id);
        expect(c.arch).toBe('tourist');
        expect(dist2(c.x, c.y, tx(CITY.pierTile) + 0.5, ty(CITY.pierTile) + 0.5)).toBeLessThan(0.6);
        seenAtPier++;
      }
    }
    expect(s.cruiseLeft).toBe(0);
    expect(seenAtPier).toBeGreaterThan(CRUISE_TOURISTS / 2);
    // The gangway is up: no more arrivals.
    run(s, 40);
    expect(s.nextCitizenId - firstId).toBe(CRUISE_TOURISTS);
    // If the liner leaves early, the wave stops with it.
    const brief = freeze(labGame());
    const before = brief.nextCitizenId;
    forceEvent(brief, 'cruise', 12);
    run(brief, 11);
    expect(brief.cruiseLeft).toBe(CRUISE_TOURISTS - 2);
    run(brief, 30);
    expect(eventActive(brief, 'cruise')).toBe(false);
    expect(brief.cruiseLeft).toBe(0);
    expect(brief.nextCitizenId - before).toBe(2);
  });

});

describe('Dynamic events: Free-Ride Tram Day', () => {
  it('puts a third, special tram on the loop and takes it off again at the end', () => {
    const s = labGame({ seed: 3 });
    run(s, 37);
    forceEvent(s, 'freeride', 60);
    expect(s.trams).toHaveLength(3);
    expect(s.trams.map((t) => t.special)).toEqual([false, false, true]);
    expect(mults(s)).toEqual(CALM);
    const regular = s.trams.slice(0, 2);
    for (let i = 0; i < 59; i++) {
      tick(s);
      expect(s.trams).toHaveLength(3);
      for (const t of s.trams) {
        expect(t.pos).toBeGreaterThanOrEqual(0);
        expect(t.pos).toBeLessThan(CITY.loop.length);
      }
    }
    tick(s);
    expect(s.trams).toHaveLength(2);
    expect(s.trams.some((t) => t.special)).toBe(false);
    // The two regular cars are the same cars as before.
    expect(s.trams[0]).toBe(regular[0]);
    expect(s.trams[1]).toBe(regular[1]);
  });

  it('doubles the commuters every tram drops at a stop', () => {
    const normal: number[] = [];
    const free: number[] = [];
    for (const seed of [3, 4, 5]) {
      const base = labGame({ seed });
      run(base, 400); // noon: an ordinary tram drops 3 to 5
      for (const out of [normal, free]) {
        const s = clone(base);
        if (out === free) forceEvent(s, 'freeride', 400);
        const dwell = new Map<object, number>();
        for (let i = 0; i < 340; i++) {
          tick(s);
          for (const t of s.trams) {
            // A tram that has just pulled in: record how many commuters it is about to drop.
            if (t.dwell > 0 && (dwell.get(t) ?? 0) === 0) out.push(t.drops);
            dwell.set(t, t.dwell);
          }
        }
      }
    }
    expect(normal.length).toBeGreaterThanOrEqual(9);
    expect(free.length).toBeGreaterThan(normal.length); // a third car is calling too
    for (const n of normal) expect(n).toBeGreaterThanOrEqual(1);
    // Every free-ride load is a doubled load.
    for (const n of free) expect(n % 2).toBe(0);
    expect(Math.min(...free)).toBeGreaterThan(Math.min(...normal));
    expect(Math.max(...free)).toBeGreaterThan(Math.max(...normal));
    const avg = (v: number[]): number => v.reduce((x, y) => x + y, 0) / v.length;
    expect(avg(free) / avg(normal)).toBeGreaterThan(1.6);
  });
});

describe('Dynamic events: Street Lantern Festival', () => {
  it('lifts nightlife and leisure and nothing else', () => {
    const s = labGame();
    s.tick = Math.round(s.quarterTicks * 0.8);
    const before = desireWeights(s, 'nightowl');
    forceEvent(s, 'lantern', 30);
    expect(mults(s)).toEqual({ ...CALM, ...EVENTS.lantern.demand });
    const lift = EVENTS.lantern.demand;
    expect(demandMult(s, 'nightlife')).toBe(lift.nightlife);
    expect(demandMult(s, 'leisure')).toBe(lift.leisure);
    expect(lift.nightlife).toBeGreaterThan(1);
    expect(lift.leisure).toBeGreaterThan(1);
    const during = desireWeights(s, 'nightowl');
    expect(during[di('nightlife')] / before[di('nightlife')]).toBeCloseTo(lift.nightlife as number, 9);
    expect(during[di('leisure')] / before[di('leisure')]).toBeCloseTo(lift.leisure as number, 9);
    expect(during[di('coffee')]).toBe(before[di('coffee')]);
    run(s, 30);
    expect(mults(s)).toEqual(CALM);
  });
});
