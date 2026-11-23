import { describe, expect, it, vi } from 'vitest';
import { advance } from '../src/shared/ai';
import { CIVICS, DESIRES, LOAN_STEP, MILESTONES, MODES, START_CASH, eraOf } from '../src/shared/constants';
import { CITIZEN_STRIDE, CityView, SnapEncoder, type Snap } from '../src/shared/protocol';
import { applyCommand, closeCouncil, continueEndless, createGame, dayPhase, forceEvent, headlineEvent, ledgerCashChange, marketShares, netWorth, crownIndex, quarterTick } from '../src/shared/sim';
import type { GameState } from '../src/shared/types';
import { ais, build, clone, freeze, labGame } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

/** Snapshots cross a socket as JSON; never hand the view live references into the simulation. */
const wire = (snap: Snap): Snap => clone(snap);

/** Everything a client can see must match the authoritative state (to wire precision). */
function expectViewMatches(view: CityView, s: GameState, speed = 1): void {
  expect(view.ready).toBe(true);
  expect(view.tick).toBe(s.tick);
  expect(view.quarter).toBe(s.quarter);
  expect(view.ended).toBe(s.phase === 'ended');
  expect(view.inCouncil).toBe(s.phase === 'council');
  expect(view.era).toBe(eraOf(s.quarter));
  expect(view.endless).toBe(s.endless);
  expect(view.speed).toBe(speed);
  expect(view.qTick).toBe(quarterTick(s));
  expect(view.dayPhase).toBeCloseTo(dayPhase(s), 12);
  // Players
  const shares = marketShares(s);
  expect(view.players).toHaveLength(s.players.length);
  s.players.forEach((p, i) => {
    const v = view.players[i];
    expect(v).toMatchObject({ id: i, name: p.name, house: p.house, kind: p.kind, persona: p.persona });
    expect(v.cash).toBe(Math.round(p.cash));
    expect(v.debt).toBe(p.debt);
    expect(Math.abs(v.prestige - p.prestige)).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(Math.abs(v.share - shares[i])).toBeLessThanOrEqual(0.0005 + 1e-9);
    expect(v.crown).toBe(crownIndex(s, p));
    expect(v.netWorth).toBe(netWorth(s, p));
    // The dynasty record: charters, milestone ticks and the counters behind the progress pill.
    expect(v.charters).toEqual(p.charters);
    expect(v.milestones).toEqual(p.milestones);
    expect(v.served).toBe(p.stats.served);
    expect(v.civicBuilt).toBe(p.stats.civicBuilt);
  });
  // Buildings
  expect(view.buildings).toHaveLength(s.buildings.length);
  for (const b of s.buildings) {
    const v = view.building(b.id);
    if (!v) throw new Error(`view is missing building ${b.id} at tick ${s.tick}`);
    const { queue, serving, rating, recent, lost, ...plain } = b;
    expect(v).toMatchObject(plain);
    // Lost-customer counters travel rounded to a tenth.
    for (const key of ['tooPricey', 'queueFull', 'outOfStock'] as const) {
      expect(Math.abs(v.lost[key] - lost[key])).toBeLessThanOrEqual(0.05 + 1e-9);
    }
    expect(v.q).toBe(queue.length);
    expect(v.sv).toBe(serving.length / 2);
    expect(Math.abs(v.rating - rating)).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(v.recent).toBeCloseTo(recent, 9);
    expect(v).not.toHaveProperty('queue');
    expect(v).not.toHaveProperty('serving');
    expect(view.buildingAt(b.tile)).toBe(v);
  }
  // Citizens
  expect(view.citizens.size).toBe(s.citizens.length);
  for (const c of s.citizens) {
    const v = view.citizens.get(c.id);
    if (!v) throw new Error(`view is missing citizen ${c.id} at tick ${s.tick}`);
    expect(Math.abs(v.x - c.x)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(v.y - c.y)).toBeLessThanOrEqual(0.01);
    expect(v).toMatchObject({ arch: c.arch, desire: c.desire, state: c.state, target: c.target, budget: Math.round(c.budget) });
    expect(Math.abs(v.mood - c.mood)).toBeLessThanOrEqual(0.005 + 1e-9);
  }
  // Trams
  expect(view.trams).toHaveLength(s.trams.length);
  s.trams.forEach((t, i) => {
    expect(Math.abs(view.trams[i].pos - t.pos)).toBeLessThanOrEqual(0.0005 + 1e-9);
    expect(view.trams[i].stopped).toBe(t.dwell > 0);
    expect(view.trams[i].special).toBe(t.special);
  });
  // Event, Gazette, result
  const e = headlineEvent(s);
  expect(view.event).toEqual(e ? { kind: e.kind, announceAt: e.announceAt, startAt: e.startAt, endAt: e.endAt, started: e.started } : null);
  expect(view.gazette).toEqual(s.gazette);
  expect(view.chronicle).toEqual(s.chronicle);
  expect(view.council).toEqual(s.council);
  expect(view.result).toEqual(s.result);
}

describe('Snapshot encoding', () => {
  it('packs a full snapshot with match meta, every building, the Gazette and the slow data', () => {
    const s = labGame({ seed: 5, cash: 5000 });
    const shop = build(s, 0, 3, 6, 'roastery');
    build(s, 1, 4, 6, 'park');
    const enc = new SnapEncoder();
    const snap = enc.encode(s, true, 1.5);
    expect(snap).toMatchObject({ t: 'snap', full: true, k: 0, q: [1, 0, 0], sp: 1.5, ev: null, res: null });
    expect(snap.meta).toEqual({
      seed: s.seed,
      mode: 'standard',
      qt: MODES.standard.quarterTicks,
      tq: MODES.standard.quarters,
      players: s.players.map((p) => ({ name: p.name, house: p.house, kind: 'human', persona: null })),
    });
    expect(snap.b?.map((b) => b.id)).toEqual(s.buildings.map((b) => b.id));
    expect(snap.b?.[0]).toMatchObject({ id: shop.id, kind: 'roastery', owner: 0, level: 1, stance: 1, q: 0, sv: 0 });
    expect(snap.gz).toEqual(s.gazette);
    expect(snap.p).toHaveLength(2);
    expect(snap.p[0]).toEqual([Math.round(s.players[0].cash), 0, 0, 0, crownIndex(s, s.players[0]), netWorth(s, s.players[0])]);
    expect(snap.c).toHaveLength(s.citizens.length * CITIZEN_STRIDE);
    expect(snap.c.every((n) => Number.isInteger(n))).toBe(true);
    expect(snap.tr).toHaveLength(s.trams.length * 3);
    expect(snap.lg).toHaveLength(2);
    expect(snap.ff).toHaveLength(144);
    expect(snap.dm).toHaveLength(DESIRES.length * 2);
    expect(snap.fx).toBeUndefined();
    // A full snapshot does not disturb the delta memory: the first delta still carries every building.
    const delta = enc.encode(s, false);
    expect(delta.full).toBe(false);
    expect(delta.meta).toBeUndefined();
    expect(delta.sp).toBe(1);
    expect(delta.b?.map((b) => b.id)).toEqual(s.buildings.map((b) => b.id));
    // It survives the wire.
    expect(clone(snap)).toEqual(snap);
  });

  it('sends only the buildings that changed, and lists the ones that were sold', () => {
    const s = freeze(labGame({ seed: 5, cash: 5000 }));
    const a = build(s, 0, 3, 6, 'roastery');
    const b = build(s, 0, 4, 6, 'bistro');
    const c = build(s, 1, 9, 6, 'park');
    const enc = new SnapEncoder();
    const view = new CityView();
    view.apply(wire(enc.encode(s, true)));
    const rev = view.buildingsRev;
    const first = enc.encode(s, false);
    expect(first.b).toHaveLength(3);
    view.apply(wire(first));
    // Nothing happened: no building data at all.
    const idle = enc.encode(s, false);
    view.apply(wire(idle));
    expect(view.buildingsRev).toBe(rev + 1); // only the first delta touched the buildings
    expect(idle.b).toBeUndefined();
    expect(idle.br).toBeUndefined();
    expect(idle).not.toHaveProperty('b');
    // One price change: exactly that building.
    expect(applyCommand(s, 0, { c: 'price', id: b.id, stance: 3 }).ok).toBe(true);
    const priced = enc.encode(s, false);
    expect(priced.b).toHaveLength(1);
    expect(priced.b?.[0]).toMatchObject({ id: b.id, stance: 3 });
    expect(priced.br).toBeUndefined();
    view.apply(wire(priced));
    expect(view.building(b.id)?.stance).toBe(3);
    expect(view.buildings).toHaveLength(3);
    expect(enc.encode(s, false).b).toBeUndefined();
    // A sale: the id is listed as removed, once.
    expect(applyCommand(s, 0, { c: 'sell', id: a.id }).ok).toBe(true);
    const sold = enc.encode(s, false);
    expect(sold.br).toEqual([a.id]);
    expect(sold.b).toBeUndefined();
    view.apply(wire(sold));
    expect(view.building(a.id)).toBeUndefined();
    expect(view.buildingAt(a.tile)).toBeUndefined();
    expect(view.buildings.map((v) => v.id).sort()).toEqual([b.id, c.id].sort());
    expect(enc.encode(s, false).br).toBeUndefined();
    // A full snapshot in between changes none of this.
    expect(enc.encode(s, true).b).toHaveLength(2);
    expect(applyCommand(s, 1, { c: 'sell', id: c.id }).ok).toBe(true);
    const d = build(s, 1, 9, 6, 'bistro');
    const mixed = enc.encode(s, false);
    expect(mixed.br).toEqual([c.id]);
    expect(mixed.b?.map((v) => v.id)).toEqual([d.id]);
    // reset() forgets everything: the next delta is complete again.
    enc.reset();
    expect(enc.encode(s, false).b?.map((v) => v.id).sort()).toEqual([b.id, d.id].sort());
  });

  it('sends the Gazette and the result only when they change, and feedback events once', () => {
    const s = labGame({ seed: 5, mode: 'blitz', cash: 5000 });
    const enc = new SnapEncoder();
    expect(enc.encode(s, false).gz).toEqual(s.gazette);
    expect(enc.encode(s, false).gz).toBeUndefined();
    build(s, 0, 4, 6, 'park'); // a civic dedication makes the Gazette and the Chronicle
    const news = enc.encode(s, false);
    expect(news.gz).toEqual(s.gazette);
    expect(news.gz?.[news.gz.length - 1].tone).toBe('civic');
    expect(news.ch).toEqual(s.chronicle);
    expect(news.ch?.[news.ch.length - 1]).toMatchObject({ cat: 'build', pill: '+4 Prestige', player: 0, tile: s.buildings[0].tile });
    expect(news.fx).toEqual([
      { k: 'dispatch', n: s.chronicleN, tier: 2, cat: 'build' },
      { k: 'build', tile: s.buildings[0].tile, kind: 'park', p: 0 },
    ]);
    expect(news.res).toBeUndefined();
    s.fx = [];
    const quiet = enc.encode(s, false);
    expect(quiet.gz).toBeUndefined();
    expect(quiet.ch).toBeUndefined();
    expect(quiet.fx).toBeUndefined();
    // The slow data rides along once per ten-tick bucket (nobody's money moves in this quiet lab).
    for (let i = 0; i < 20; i++) {
      advance(s);
      const snap = enc.encode(s, false);
      s.fx = [];
      expect(snap.lg !== undefined).toBe(s.tick % 10 === 0);
      expect(snap.ff !== undefined).toBe(s.tick % 10 === 0);
      expect(snap.dm !== undefined).toBe(s.tick % 10 === 0);
    }
    // The result is sent once when the match ends, and cleared once if play continues.
    while (s.phase !== 'ended') {
      if (s.phase === 'council') closeCouncil(s);
      else advance(s);
    }
    const final = enc.encode(s, false);
    expect(final.res).toEqual(s.result);
    expect(final.q).toEqual([4, 1, 0]);
    expect(enc.encode(s, false).res).toBeUndefined();
    expect(enc.encode(s, true).res).toEqual(s.result);
    expect(continueEndless(s)).toBe(true);
    const on = enc.encode(s, false);
    expect(on.res).toBeNull();
    expect(on.q).toEqual([5, 0, 1]);
    expect(enc.encode(s, false).res).toBeUndefined();
  });
});

describe('The slow lane and the ledgers', () => {
  /** Encode a delta after `step` ticks, the way a room does at that pace. */
  const beatOf = (s: GameState, enc: SnapEncoder, step: number): Snap => {
    for (let i = 0; i < step; i++) advance(s);
    const snap = enc.encode(s, false, step);
    s.fx = [];
    return snap;
  };

  it('refreshes footfall, demand and ledgers once per ten-tick bucket at every pace and tick parity', () => {
    // Ticks per broadcast: 1× and 2× and 3× step whole ticks; 1.5× alternates 1 and 2.
    const paces: [string, number[]][] = [['1×', [1]], ['1.5×', [1, 2]], ['2×', [2]], ['3×', [3]]];
    for (const [name, steps] of paces) {
      for (const startTick of [80, 81, 83, 85, 87, 89]) {
        const s = freeze(labGame({ seed: 5, cash: 5000 }));
        const enc = new SnapEncoder();
        while (s.tick < startTick) beatOf(s, enc, 1);
        let lastBucket = Math.floor(s.tick / 10);
        let refreshed = 0;
        let buckets = 0;
        for (let i = 0; i < 120; i++) {
          const snap = beatOf(s, enc, steps[i % steps.length]);
          const bucket = Math.floor(s.tick / 10);
          const moved = bucket !== lastBucket;
          lastBucket = bucket;
          if (moved) buckets++;
          if (snap.ff) refreshed++;
          // Exactly the first broadcast of each bucket carries the slow lane, all three parts.
          expect(snap.ff !== undefined, `${name} from ${startTick} at tick ${s.tick}`).toBe(moved);
          expect(snap.dm !== undefined, `${name} from ${startTick} at tick ${s.tick}`).toBe(moved);
          if (moved) expect(snap.lg, `${name} from ${startTick} at tick ${s.tick}`).toBeDefined();
        }
        expect(buckets).toBeGreaterThanOrEqual(12);
        expect(refreshed).toBe(buckets);
      }
    }
    // The case that used to go dark: 2× from tick 83 never lands on a multiple of ten.
    const s = freeze(labGame({ seed: 5, cash: 5000 }));
    const enc = new SnapEncoder();
    while (s.tick < 83) beatOf(s, enc, 1);
    let slow = 0;
    for (let i = 0; i < 200; i++) {
      const snap = beatOf(s, enc, 2);
      expect(s.tick % 10).not.toBe(0);
      if (snap.ff && snap.dm && snap.lg) slow++;
    }
    expect(slow).toBe(40); // 400 ticks, 40 buckets, 40 refreshes
  });

  it('sends the ledgers on the very beat money moves: dividends, loans and repayments at odd-parity 2×', () => {
    // Milestones are live here: two adjacent Pocket Parks earn Block Baron and Civic Benefactor (+§120).
    const s = freeze(labGame({ seed: 5, milestones: true }));
    const enc = new SnapEncoder();
    const view = new CityView();
    view.apply(wire(enc.encode(s, true, 1)));
    while (s.tick < 83) view.apply(wire(beatOf(s, enc, 1)));
    const reconciled = (): void => {
      s.players.forEach((p, i) => {
        const lg = view.ledgers[i];
        expect(lg).toEqual({ cur: p.ledger, last: p.lastLedger, total: p.totalLedger });
        // The Ledger drawer's closing line against the Treasury chip, to the exact §.
        expect(Math.round(START_CASH + ledgerCashChange(lg.total)), `tick ${s.tick} player ${i}`).toBe(view.players[i].cash);
        expect(view.players[i].cash).toBe(Math.round(p.cash));
        expect(view.players[i].debt).toBe(p.debt);
      });
    };
    const beat = (): Snap => {
      const snap = beatOf(s, enc, 2);
      view.apply(wire(snap));
      expect(s.tick % 2).toBe(1); // odd parity for the rest of the match: never a multiple of ten
      reconciled();
      return snap;
    };
    for (let i = 0; i < 4; i++) beat();
    // A quiet beat inside a bucket carries no ledgers at all.
    expect(s.tick).toBe(91);
    expect(beat().lg).toBeUndefined();
    // Two adjacent parks: construction is booked, and on the next tick the Milestones pay out.
    build(s, 0, 3, 6, 'park');
    build(s, 0, 4, 6, 'park');
    const parks = beat();
    expect(s.tick).toBe(95);
    expect(parks.lg).toBeDefined();
    expect(parks.dy).toBeDefined();
    expect(view.players[0].milestones[1]).toBeGreaterThanOrEqual(0); // Block Baron
    expect(view.players[0].milestones[2]).toBeGreaterThanOrEqual(0); // Civic Benefactor
    expect(view.ledgers[0].total.dividends).toBe(MILESTONES[2].cash);
    expect(view.ledgers[0].cur.civic).toBe(2 * CIVICS.park.cost);
    expect(view.players[0].cash).toBe(START_CASH - 2 * CIVICS.park.cost + MILESTONES[2].cash);
    expect(beat().lg).toBeUndefined();
    // A §400 loan draw shows in Financing on the same beat the Treasury gains it.
    expect(applyCommand(s, 0, { c: 'borrow' }).ok).toBe(true);
    const loan = beat();
    expect(s.tick).toBe(99);
    expect(loan.lg).toBeDefined();
    expect(view.ledgers[0].total.borrowed).toBe(LOAN_STEP);
    expect(view.players[0].debt).toBe(LOAN_STEP);
    expect(view.players[0].cash).toBe(START_CASH - 2 * CIVICS.park.cost + MILESTONES[2].cash + LOAN_STEP);
    // Payroll (interest on the loan, tick 100) lands mid-beat and is reconciled too.
    const payroll = beat();
    expect(s.tick).toBe(101);
    expect(payroll.lg).toBeDefined();
    expect(view.ledgers[0].total.interest).toBeGreaterThan(0);
    // And a repayment.
    expect(applyCommand(s, 0, { c: 'repay' }).ok).toBe(true);
    const repaid = beat();
    expect(repaid.lg).toBeDefined();
    expect(view.ledgers[0].total.repaid).toBe(LOAN_STEP);
    expect(view.players[0].debt).toBe(0);
    for (let i = 0; i < 300; i++) beat();
    // A full snapshot for a late joiner does not disturb the delta memory.
    const late = new CityView();
    late.apply(wire(enc.encode(s, true, 2)));
    expect(late.ledgers).toEqual(view.ledgers);
    expect(enc.encode(s, false, 2).lg).toBeUndefined();
  });

  it('reconciles every House on every beat of a busy AI match at 2× from an odd tick', () => {
    const s = createGame({ seed: 17, mode: 'standard', players: ais(['vesper', 'aurelia', 'orson', 'vesper']) });
    const enc = new SnapEncoder();
    const view = new CityView();
    view.apply(wire(enc.encode(s, true, 1)));
    while (s.tick < 87) view.apply(wire(beatOf(s, enc, 1)));
    let withLedgers = 0;
    for (let i = 0; i < 700 && s.phase === 'playing'; i++) {
      const snap = beatOf(s, enc, 2);
      view.apply(wire(snap));
      if (snap.lg) withLedgers++;
      expect(s.tick % 10).not.toBe(0);
      s.players.forEach((p, k) => {
        expect(view.ledgers[k]).toEqual({ cur: p.ledger, last: p.lastLedger, total: p.totalLedger });
        expect(Math.round(START_CASH + ledgerCashChange(view.ledgers[k].total)), `tick ${s.tick} player ${k}`).toBe(view.players[k].cash);
      });
    }
    expect(withLedgers).toBeGreaterThan(70);
    expect(s.players.some((p) => p.totalLedger.revenue > 0)).toBe(true);
  });
});

describe('SnapEncoder → CityView round trip', () => {
  it('ignores a delta that arrives before any full snapshot', () => {
    const s = labGame({ seed: 5, cash: 5000 });
    build(s, 0, 3, 6, 'roastery');
    const enc = new SnapEncoder();
    const view = new CityView();
    const delta = enc.encode(s, false);
    expect(delta.fx?.map((f) => f.k)).toEqual(['dispatch', 'build']); // a founding shop is news
    expect(view.apply(wire(delta))).toEqual([]);
    expect(view.ready).toBe(false);
    expect(view.buildings).toEqual([]);
    expect(view.citizens.size).toBe(0);
    expect(view.players).toEqual([]);
    expect(view.buildingsRev).toBe(0);
    view.apply(wire(enc.encode(s, true)));
    expect(view.ready).toBe(true);
    expectViewMatches(view, s);
    expect(view).toMatchObject({ seed: s.seed, mode: 'standard', quarterTicks: s.quarterTicks, totalQuarters: s.totalQuarters });
  });

  it('rebuilds the whole city on the client from one full snapshot and a stream of deltas', () => {
    const s = createGame({ seed: 17, mode: 'standard', players: ais(['vesper', 'aurelia', 'orson', 'vesper']) });
    const enc = new SnapEncoder();
    const view = new CityView();
    expect(view.apply(wire(enc.encode(s, true, 2)))).toEqual([]);
    expectViewMatches(view, s, 2);
    let fxSeen = 0;
    let builds = 0;
    let revs = view.buildingsRev;
    let eventsSeen = 0;
    let specials = 0;
    forceEvent(s, 'freeride', 120); // a third tram comes and goes mid-stream
    for (let i = 0; i < 900; i++) {
      advance(s);
      const sent = s.fx.length;
      const fx = view.apply(wire(enc.encode(s, false, 2)));
      expect(fx).toHaveLength(sent);
      fxSeen += fx.length;
      builds += fx.filter((f) => f.k === 'build').length;
      s.fx = [];
      if (view.event) eventsSeen++;
      if (view.trams.some((t) => t.special)) specials++;
      // Cheap checks every tick, the deep comparison every 15th.
      expect(view.tick).toBe(s.tick);
      expect(view.buildings.length).toBe(s.buildings.length);
      expect(view.citizens.size).toBe(s.citizens.length);
      if (s.tick % 15 === 0) expectViewMatches(view, s, 2);
      if (s.tick % 10 === 0) {
        s.players.forEach((p, k) => {
          expect(view.ledgers[k]).toEqual({ cur: p.ledger, last: p.lastLedger, total: p.totalLedger });
        });
        for (let t = 0; t < 144; t += 7) expect(Math.abs(view.footfall[t] - s.footfall[t])).toBeLessThanOrEqual(0.05 + 1e-9);
        DESIRES.forEach((_, d) => {
          expect(Math.abs(view.met[d] - s.met[d])).toBeLessThanOrEqual(0.05 + 1e-9);
          expect(Math.abs(view.unmet[d] - s.unmet[d])).toBeLessThanOrEqual(0.05 + 1e-9);
        });
      }
    }
    expectViewMatches(view, s, 2);
    expect(s.buildings.length).toBeGreaterThan(5);
    expect(builds).toBeGreaterThanOrEqual(s.buildings.length);
    expect(fxSeen).toBeGreaterThan(100);
    expect(view.buildingsRev).toBeGreaterThan(revs);
    revs = view.buildingsRev;
    expect(eventsSeen).toBeGreaterThan(100);
    expect(specials).toBe(119);
    expect(s.players.some((p) => p.cash !== 900)).toBe(true);
  });

  it('keeps each citizen’s previous position for interpolation and drops the departed', () => {
    const s = createGame({ seed: 17, mode: 'standard', players: ais(['vesper', 'orson']) });
    s.events = []; // keep the tram roster fixed for the ppos check
    const enc = new SnapEncoder();
    const view = new CityView();
    view.apply(wire(enc.encode(s, true)));
    for (const z of view.citizens.values()) {
      expect([z.px, z.py]).toEqual([z.x, z.y]);
      expect(z.born).toBe(0);
    }
    let moved = 0;
    let departed = 0;
    let arrived = 0;
    for (let i = 0; i < 200; i++) {
      const before = new Map([...view.citizens].map(([id, z]) => [id, { x: z.x, y: z.y }]));
      const tramsBefore = view.trams.map((t) => t.pos);
      advance(s);
      view.apply(wire(enc.encode(s, false)));
      s.fx = [];
      const alive = new Set(s.citizens.map((c) => c.id));
      for (const id of before.keys()) if (!alive.has(id)) departed++;
      expect([...view.citizens.keys()].sort((a, b) => a - b)).toEqual([...alive].sort((a, b) => a - b));
      for (const [id, z] of view.citizens) {
        const was = before.get(id);
        if (was) {
          expect([z.px, z.py]).toEqual([was.x, was.y]);
          if (z.x !== z.px || z.y !== z.py) moved++;
          expect(Math.hypot(z.x - z.px, z.y - z.py)).toBeLessThan(1.2);
        } else {
          arrived++;
          expect([z.px, z.py]).toEqual([z.x, z.y]);
          expect(z.born).toBe(s.tick);
        }
      }
      view.trams.forEach((t, k) => expect(t.ppos).toBe(tramsBefore[k]));
    }
    expect(moved).toBeGreaterThan(1000);
    expect(departed).toBeGreaterThan(0);
    expect(arrived).toBeGreaterThan(0);
  });

  it('brings a late joiner, given a fresh full snapshot plus later deltas, to the same city as an early joiner', () => {
    const s = createGame({ seed: 23, mode: 'standard', players: ais(['vesper', 'aurelia', 'orson', 'orson']) });
    const enc = new SnapEncoder();
    const early = new CityView();
    const late = new CityView();
    early.apply(wire(enc.encode(s, true)));
    const beat = (): void => {
      advance(s);
      const delta = wire(enc.encode(s, false));
      s.fx = [];
      early.apply(delta);
      late.apply(clone(delta)); // before the full snapshot these are ignored
    };
    for (let i = 0; i < 400; i++) beat();
    expect(late.ready).toBe(false);
    expect(s.buildings.length).toBeGreaterThan(3);
    late.apply(wire(enc.encode(s, true))); // what the room sends a socket that has just joined
    expect(late.buildings).toHaveLength(s.buildings.length);
    for (let i = 0; i < 500; i++) beat();
    const key = (v: CityView): string =>
      JSON.stringify({
        tick: v.tick,
        quarter: v.quarter,
        buildings: v.buildings.slice().sort((a, b) => a.id - b.id),
        players: v.players,
        citizens: [...v.citizens.values()].sort((a, b) => a.id - b.id).map((z) => [z.id, z.x, z.y, z.state, z.target]),
        trams: v.trams.map((t) => [t.pos, t.stopped, t.special]),
        event: v.event,
        gazette: v.gazette,
        ledgers: v.ledgers,
      });
    expect(key(late)).toBe(key(early));
    expectViewMatches(late, s);
    expectViewMatches(early, s);
    expect(early.buildings.length).toBeGreaterThan(8);
  });

  it('delivers the result at the final bell, and clears it when the match continues in Endless', () => {
    const s = createGame({ seed: 29, mode: 'blitz', players: ais(['vesper', 'aurelia', 'orson']) });
    const enc = new SnapEncoder();
    const view = new CityView();
    view.apply(wire(enc.encode(s, true)));
    let ended = 0;
    let councils = 0;
    let eras = 0;
    while (s.phase !== 'ended') {
      // An Era Council met on the way is closed at once; the view sees it open and then rise.
      if (s.phase === 'council') closeCouncil(s);
      else advance(s);
      const fx = view.apply(wire(enc.encode(s, false)));
      ended += fx.filter((f) => f.k === 'end').length;
      councils += fx.filter((f) => f.k === 'council').length;
      eras += fx.filter((f) => f.k === 'quarter').length;
      s.fx = [];
      if ((s.phase as GameState['phase']) !== 'ended') expect(view.result).toBeNull();
      expect(view.inCouncil).toBe(s.phase === 'council');
      expect(view.council).toEqual(s.council);
    }
    expect(ended).toBe(1);
    expect(councils).toBe(3);
    expect(eras).toBe(3);
    expect(view.quarter).toBe(4);
    expect(view.players.map((p) => p.charters)).toEqual(s.players.map((p) => p.charters));
    expect(view.players.every((p) => p.charters.length === 3)).toBe(true);
    expect(view.ended).toBe(true);
    expect(view.result).toEqual(s.result);
    expect(view.result?.rows).toHaveLength(3);
    expect(view.result?.winner).toBe(s.result?.winner);
    expectViewMatches(view, s);
    // More idle deltas do not wipe it.
    view.apply(wire(enc.encode(s, false)));
    expect(view.result).toEqual(s.result);
    // A reconnecting client gets it from the full snapshot.
    const rejoined = new CityView();
    rejoined.apply(wire(enc.encode(s, true)));
    expect(rejoined.result).toEqual(s.result);
    expect(rejoined.ended).toBe(true);
    // Continue in Endless: the room sends a full snapshot and the banner comes down.
    expect(continueEndless(s)).toBe(true);
    view.apply(wire(enc.encode(s, true)));
    expect(view.result).toBeNull();
    expect(view.ended).toBe(false);
    expect(view.endless).toBe(true);
    for (let i = 0; i < 30; i++) {
      advance(s);
      view.apply(wire(enc.encode(s, false)));
      s.fx = [];
    }
    expectViewMatches(view, s);
  });

  it('starts from a clean slate when a full snapshot of a new match arrives (rematch)', () => {
    const first = createGame({ seed: 31, mode: 'standard', players: ais(['vesper', 'aurelia', 'orson']) });
    const enc = new SnapEncoder();
    const view = new CityView();
    view.apply(wire(enc.encode(first, true)));
    for (let i = 0; i < 300; i++) {
      advance(first);
      view.apply(wire(enc.encode(first, false)));
      first.fx = [];
    }
    expect(view.buildings.length).toBeGreaterThan(0);
    const oldCitizens = new Set(view.citizens.keys());
    const second = createGame({ seed: 32, mode: 'blitz', players: ais(['orson', 'vesper']) });
    enc.reset();
    view.apply(wire(enc.encode(second, true)));
    expect(view.buildings).toEqual([]);
    expect(view.buildingAt(first.buildings[0].tile)).toBeUndefined();
    expect(view.building(first.buildings[0].id)).toBeUndefined();
    expect(view.players.map((p) => p.persona)).toEqual(['orson', 'vesper']);
    expect(view).toMatchObject({ seed: 32, mode: 'blitz', quarterTicks: MODES.blitz.quarterTicks, totalQuarters: 4, tick: 0 });
    for (const z of view.citizens.values()) {
      expect(z.born).toBe(0);
      expect([z.px, z.py]).toEqual([z.x, z.y]);
    }
    expect(view.citizens.size).toBe(second.citizens.length);
    expect(oldCitizens.size).toBeGreaterThan(0);
    expectViewMatches(view, second);
    for (let i = 0; i < 100; i++) {
      advance(second);
      view.apply(wire(enc.encode(second, false)));
      second.fx = [];
    }
    expectViewMatches(view, second);
  });
});
