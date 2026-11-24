import { describe, expect, it } from 'vitest';
import { LEVEL3_NOTICE, LOAN_MAX, LOAN_STEP, UNIT_CAP } from '../src/shared/constants';
import { actionsFor, stateHash } from '../src/shared/game';
import { checkOrder, describeOrder, newPlan, parseDraft, parseOrder, pruneDraft, queueOrder, readyBlock, reorderDraft, undoOrder } from '../src/shared/orders';
import type { Game, Order } from '../src/shared/types';
import { addBuilding, addUnit, newGame, stage } from './helpers';

const LANE = 8 + 3 * 12; // (8,3): beside lots (7..9,2) and (7..9,4)
const around = [7 + 24, 8 + 24, 9 + 24, 7 + 48, 8 + 48, 9 + 48];

/** A rich House 0 with `n` shops (different lots) and a Factor parked on a lane. */
function rich(turn = 1, n = 8): Game {
  return stage(newGame(5, 'standard', ['human', 'ai', 'ai', 'ai']), (g) => {
    g.turn = turn;
    g.players[0].cash = 50000;
    const spots = [2 + 24, 3 + 24, 4 + 24, 2 + 48, 3 + 48, 4 + 48, 10 + 24, 10 + 48, 9 + 72, 8 + 72];
    for (let i = 0; i < n; i++) addBuilding(g, 0, spots[i], 'roastery');
    g.units.find((u) => u.owner === 0 && u.kind === 'factor')!.tile = LANE;
  });
}

function queueAll(g: Game, seat: number, orders: Order[]): { draft: Order[]; reasons: string[] } {
  let draft: Order[] = [];
  const reasons: string[] = [];
  for (const o of orders) {
    const r = queueOrder(g, seat, draft, o);
    if (r.ok) draft = r.draft;
    else reasons.push(r.reason);
  }
  return { draft, reasons };
}

describe('Action budget', () => {
  const stances = (g: Game): Order[] => g.buildings.filter((b) => b.owner === 0).map((b) => ({ t: 'stance', building: b.id, stance: 2 }));

  it.each([
    [1, 5],
    [9, 6],
    [17, 7],
    [25, 7],
  ])('Turn %i allows exactly %i orders', (turn, actions) => {
    const g = rich(turn);
    expect(actionsFor(g, g.players[0])).toBe(actions);
    const { draft, reasons } = queueAll(g, 0, stances(g));
    expect(draft).toHaveLength(actions);
    expect(reasons).toHaveLength(8 - actions);
    expect(reasons[0]).toBe(`No Actions left — ${actions} of ${actions} spent`);
    const plan = pruneDraft(g, 0, draft).plan;
    expect(plan.actions).toBe(0);
    expect(plan.actionsMax).toBe(actions);
  });

  it('Charters and the District Sovereign Milestone add 1 Action each', () => {
    const g = stage(rich(1), (c) => {
      c.players[0].charters = ['heralds'];
      c.players[0].milestones[3] = 4;
    });
    expect(actionsFor(g, g.players[0])).toBe(7);
    expect(queueAll(g, 0, g.buildings.filter((b) => b.owner === 0).map((b) => ({ t: 'stance', building: b.id, stance: 2 }))).draft).toHaveLength(7);
  });

  it('the Charter choice costs no Action', () => {
    const g = stage(rich(9), (c) => {
      c.council = { era: 2, offers: [['artisanry', 'transit', 'credit'], [], [], []] };
    });
    const { draft } = queueAll(g, 0, [{ t: 'charter', key: 'transit' }, ...g.buildings.filter((b) => b.owner === 0).map((b): Order => ({ t: 'stance', building: b.id, stance: 2 }))]);
    expect(draft.filter((o) => o.t !== 'charter')).toHaveLength(6);
    expect(draft[0]).toEqual({ t: 'charter', key: 'transit' });
    expect(pruneDraft(g, 0, draft).plan.actions).toBe(0);
  });

  it('Actions cannot be exceeded by a hand-built draft: pruneDraft drops the overflow', () => {
    const g = rich(1);
    const r = pruneDraft(g, 0, stances(g));
    expect(r.kept).toHaveLength(5);
    expect(r.removed).toHaveLength(3);
    expect(r.removed.every((x) => /No Actions left/.test(x.reason))).toBe(true);
  });
});

describe('treasury budget', () => {
  it('queued § never exceeds cash plus earlier borrowing; the reason names the shortfall', () => {
    const g = stage(newGame(5, 'standard', ['human', 'ai', 'ai', 'ai']), (c) => {
      c.units.find((u) => u.owner === 0 && u.kind === 'factor')!.tile = LANE;
      c.players[0].cash = 540;
    });
    const builds: Order[] = around.slice(0, 5).map((tile) => ({ t: 'build', tile, kind: 'roastery' }));
    const r = queueAll(g, 0, builds);
    expect(r.draft).toHaveLength(3);
    expect(r.reasons[0]).toBe('Not enough § — needs §180, have §0 projected');
    const plan = pruneDraft(g, 0, r.draft).plan;
    expect(plan.cash).toBe(0);
    expect(plan.spent).toBe(540);
  });

  it('borrowing earlier in the same draft adds to the projected cash (and a later order may spend it)', () => {
    const g = stage(newGame(5, 'standard', ['human', 'ai', 'ai', 'ai']), (c) => {
      c.units.find((u) => u.owner === 0 && u.kind === 'factor')!.tile = LANE;
      c.players[0].cash = 100;
    });
    expect(queueOrder(g, 0, [], { t: 'build', tile: around[0], kind: 'roastery' }).ok).toBe(false);
    const a = queueOrder(g, 0, [], { t: 'borrow' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.plan.cash).toBe(100 + LOAN_STEP);
    const b = queueOrder(g, 0, a.draft, { t: 'build', tile: around[0], kind: 'roastery' });
    expect(b.ok).toBe(true);
    // Reordering the build before the borrow makes it unaffordable and it is pruned.
    if (!b.ok) return;
    const re = reorderDraft(g, 0, b.draft, 1, 0);
    expect(re.kept).toEqual([{ t: 'borrow' }]);
    expect(re.removed).toHaveLength(1);
  });

  it('the Credit Line stops at §1,200 and repay needs debt and cash', () => {
    const g = stage(newGame(5), (c) => void (c.players[0].cash = 100));
    const r = queueAll(g, 0, [{ t: 'borrow' }, { t: 'borrow' }, { t: 'borrow' }, { t: 'borrow' }]);
    expect(r.draft).toHaveLength(LOAN_MAX / LOAN_STEP);
    expect(r.reasons).toEqual([`The Credit Line is full (§${LOAN_MAX.toLocaleString('en-US')})`]);
    expect(queueOrder(g, 0, [], { t: 'repay' })).toEqual({ ok: false, reason: 'Nothing to repay' });
  });
});

describe('undo and dependent orders', () => {
  const base = () =>
    stage(newGame(2, 'standard', ['human', 'ai', 'ai', 'ai']), (c) => {
      c.units.find((u) => u.owner === 0 && u.kind === 'factor')!.tile = 7 + 12; // (7,1)
    });

  it('undoing a Factor move removes the dependent construction with a reason, and restores Actions and cash', () => {
    const g = base();
    const f = g.units.find((u) => u.owner === 0 && u.kind === 'factor')!;
    const lot = 4 + 24; // (4,2): out of reach from (7,1), in reach from (5,1)
    expect(queueOrder(g, 0, [], { t: 'build', tile: lot, kind: 'roastery' })).toMatchObject({ ok: false });
    const hash = stateHash(g);
    const q1 = queueOrder(g, 0, [], { t: 'move', unit: f.id, to: 5 + 12 });
    expect(q1.ok).toBe(true);
    if (!q1.ok) return;
    const q2 = queueOrder(g, 0, q1.draft, { t: 'build', tile: lot, kind: 'roastery' });
    expect(q2.ok).toBe(true);
    if (!q2.ok) return;
    expect(q2.plan.actions).toBe(3);
    expect(q2.plan.cash).toBe(900 - 180);
    const u = undoOrder(g, 0, q2.draft, 0);
    expect(u.kept).toEqual([]);
    expect(u.removed).toHaveLength(1);
    expect(u.removed[0].order).toEqual({ t: 'build', tile: lot, kind: 'roastery' });
    expect(u.removed[0].reason).toMatch(/^Out of reach/);
    expect(u.plan.actions).toBe(5);
    expect(u.plan.cash).toBe(900);
    expect(stateHash(g)).toBe(hash);
  });

  it('undoing the later order leaves the move alone; any order (not just the last) can be undone', () => {
    const g = base();
    const f = g.units.find((u) => u.owner === 0 && u.kind === 'factor')!;
    const draft: Order[] = [
      { t: 'move', unit: f.id, to: 5 + 12 },
      { t: 'build', tile: 4 + 24, kind: 'roastery' },
      { t: 'borrow' },
    ];
    expect(pruneDraft(g, 0, draft).kept).toEqual(draft);
    expect(undoOrder(g, 0, draft, 1).kept).toEqual([draft[0], draft[2]]);
    const mid = undoOrder(g, 0, draft, 0);
    expect(mid.kept).toEqual([{ t: 'borrow' }]);
    expect(mid.removed.map((x) => x.order.t)).toEqual(['build']);
  });

  it('reordering is free, and invalid results are pruned with reasons', () => {
    const g = base();
    const f = g.units.find((u) => u.owner === 0 && u.kind === 'factor')!;
    const draft: Order[] = [
      { t: 'move', unit: f.id, to: 5 + 12 },
      { t: 'build', tile: 4 + 24, kind: 'roastery' },
    ];
    const r = reorderDraft(g, 0, draft, 0, 1);
    expect(r.kept).toEqual([draft[0]]);
    expect(r.removed.map((x) => x.order.t)).toEqual(['build']);
    expect(r.removed[0].reason).toMatch(/^Out of reach/);
    expect(reorderDraft(g, 0, draft, 9, 0).kept).toEqual(draft);
  });

  it('a sold property no longer supports orders that depend on it', () => {
    const g = rich(1, 2);
    const b = g.buildings[0];
    const r = pruneDraft(g, 0, [{ t: 'sell', building: b.id }, { t: 'stance', building: b.id, stance: 2 }]);
    expect(r.kept).toHaveLength(1);
    expect(r.removed[0].reason).toBe('Choose one of your shops');
  });
});

describe('movement rules', () => {
  const g0 = newGame(2, 'standard', ['human', 'ai', 'ai', 'ai']);
  const f = g0.units.find((u) => u.owner === 0 && u.kind === 'factor')!;
  const w = g0.units.find((u) => u.owner === 0 && u.kind === 'watch')!;

  it('one movement order per unit per turn', () => {
    const a = queueOrder(g0, 0, [], { t: 'move', unit: f.id, to: f.tile - 1 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(queueOrder(g0, 0, a.draft, { t: 'move', unit: f.id, to: f.tile - 2 })).toEqual({ ok: false, reason: 'Each unit accepts one movement order per turn' });
    expect(queueOrder(g0, 0, a.draft, { t: 'move', unit: w.id, to: f.tile }).ok).toBe(true); // the Factor's old tile is free once it moves
  });

  it('rejects illegal moves with a reason', () => {
    const why = (o: Order) => {
      const r = queueOrder(g0, 0, [], o);
      return r.ok ? null : r.reason;
    };
    expect(why({ t: 'move', unit: f.id, to: f.tile })).toBe('Already there');
    expect(why({ t: 'move', unit: f.id, to: -1 })).toBe('Off the board');
    expect(why({ t: 'move', unit: f.id, to: 144 })).toBe('Off the board');
    expect(why({ t: 'move', unit: f.id, to: 3 })).toBe('Units stand on streets, lanes and bridges'); // a lot / home
    expect(why({ t: 'move', unit: f.id, to: 11 * 12 + 1 })).toBe('Too far — Factor moves 2 tiles');
    expect(why({ t: 'move', unit: f.id, to: w.tile })).toBe('Another unit holds that tile');
    expect(why({ t: 'move', unit: 9999, to: 1 })).toBe('That unit is not yours');
    const rival = g0.units.find((u) => u.owner === 1)!;
    expect(why({ t: 'move', unit: rival.id, to: rival.tile + 1 })).toBe('That unit is not yours');
  });

  it('two of your units cannot be headed for the same tile', () => {
    const a = queueOrder(g0, 0, [], { t: 'move', unit: f.id, to: f.tile - 1 });
    if (!a.ok) throw new Error('setup');
    expect(queueOrder(g0, 0, a.draft, { t: 'move', unit: w.id, to: f.tile - 1 })).toMatchObject({ ok: false });
  });

  it('Barges stay on canal water', () => {
    const g = stage(g0, (c) => {
      c.turn = 9;
      addUnit(c, 0, 'barge', 7 + 10 * 12); // harbor mouth canal tile
    });
    const barge = g.units.find((u) => u.kind === 'barge')!;
    expect(queueOrder(g, 0, [], { t: 'move', unit: barge.id, to: 7 + 9 * 12 }).ok).toBe(true);
    expect(queueOrder(g, 0, [], { t: 'move', unit: barge.id, to: 6 + 5 * 12 })).toEqual({ ok: false, reason: 'Too far — Barge moves 4 tiles' });
    const land = queueOrder(g, 0, [], { t: 'move', unit: barge.id, to: 1 + 12 });
    expect(land).toEqual({ ok: false, reason: 'Barges stay on canal water' });
  });
});

describe('Era locks', () => {
  const g1 = rich(1, 2);
  const why = (g: Game, o: Order) => {
    const r = queueOrder(g, 0, [], o);
    return r.ok ? null : r.reason;
  };
  const lot = around[0];

  it('locked tools show a plain explanation', () => {
    expect(why(g1, { t: 'build', tile: lot, kind: 'arcade' })).toBe('Arcade unlocks in Era II: Transit & Trade');
    expect(why(g1, { t: 'build', tile: lot, kind: 'nightmarket' })).toBe('Nightmarket unlocks in Era II: Transit & Trade');
    expect(why(g1, { t: 'build', tile: lot, kind: 'tramstop' })).toBe('Tram Stop unlocks in Era II: Transit & Trade');
    expect(why(g1, { t: 'build', tile: lot, kind: 'boutique' })).toBe('Boutique unlocks in Era III: Grand Boulevard');
    expect(why(g1, { t: 'build', tile: lot, kind: 'cinema' })).toBe('Cinema unlocks in Era III: Grand Boulevard');
    expect(why(g1, { t: 'build', tile: lot, kind: 'plaza' })).toBe('Festival Plaza unlocks in Era III: Grand Boulevard');
    expect(why(g1, { t: 'recruit', kind: 'barge' })).toBe('Barge unlocks in Era II');
    expect(why(g1, { t: 'study', key: 'hydraulics' })).toMatch(/unlocks in Era II$/);
    expect(why(g1, { t: 'study', key: 'ledger' })).toMatch(/unlocks in Era III$/);
  });

  it('Era I tools are open, and unlocks open on the Era boundary', () => {
    for (const kind of ['roastery', 'bistro', 'park'] as const) expect(why(g1, { t: 'build', tile: lot, kind })).toBeNull();
    const g2 = rich(9, 2);
    expect(why(g2, { t: 'build', tile: lot, kind: 'arcade' })).toBeNull();
    expect(why(g2, { t: 'build', tile: lot, kind: 'tramstop' })).toBeNull();
    expect(why(g2, { t: 'recruit', kind: 'barge' })).toBeNull();
    expect(why(g2, { t: 'build', tile: lot, kind: 'cinema' })).toMatch(/unlocks in Era III/);
    const g3 = rich(17, 2);
    expect(why(g3, { t: 'build', tile: lot, kind: 'cinema' })).toBeNull();
    expect(why(g3, { t: 'build', tile: lot, kind: 'plaza' })).toBeNull();
  });

  it('Level 3 architecture needs Era III', () => {
    const b = (g: Game) => g.buildings.find((x) => x.owner === 0)!;
    const lvl2 = (turn: number) => stage(rich(turn, 2), (c) => void (c.buildings[0].level = 2));
    const g = lvl2(9);
    expect(why(g, { t: 'upgrade', building: b(g).id })).toBe(LEVEL3_NOTICE);
    const h = lvl2(17);
    expect(why(h, { t: 'upgrade', building: b(h).id })).toBeNull();
    const l3 = stage(rich(17, 2), (c) => void (c.buildings[0].level = 3));
    expect(why(l3, { t: 'upgrade', building: b(l3).id })).toBe('Already Level 3');
  });

  it('Charter orders exist only on Council turns, from the offered three, once', () => {
    expect(why(g1, { t: 'charter', key: 'canal' })).toBe('No Charter is offered this turn');
    const g = stage(rich(9, 2), (c) => void (c.council = { era: 2, offers: [['artisanry', 'transit', 'credit'], [], [], []] }));
    expect(why(g, { t: 'charter', key: 'canal' })).toBe('That Charter is not on offer');
    const a = queueOrder(g, 0, [], { t: 'charter', key: 'credit' });
    if (!a.ok) throw new Error('setup');
    expect(queueOrder(g, 0, a.draft, { t: 'charter', key: 'transit' })).toEqual({ ok: false, reason: 'A Charter is already chosen' });
  });

  it('End Turn / Ready stay unavailable on a Council turn until a Charter is chosen', () => {
    const g = stage(rich(9, 2), (c) => void (c.council = { era: 2, offers: [['artisanry', 'transit', 'credit'], [], [], []] }));
    expect(readyBlock(g, 0, [])).toBe('Choose a Charter');
    expect(readyBlock(g, 0, [{ t: 'borrow' }])).toBe('Choose a Charter');
    expect(readyBlock(g, 0, [{ t: 'charter', key: 'credit' }])).toBeNull();
    expect(readyBlock(rich(1, 2), 0, [])).toBeNull();
    expect(readyBlock(stage(g, (c) => void (c.phase = 'ended')), 0, [])).toBe('Match over');
  });
});

describe('other order legality reasons', () => {
  const g = rich(1, 3);
  const mine = g.buildings.filter((b) => b.owner === 0);
  const why = (o: Order, game = g) => {
    const r = queueOrder(game, 0, [], o);
    return r.ok ? null : r.reason;
  };

  it('explains build failures', () => {
    expect(why({ t: 'build', tile: 0, kind: 'roastery' })).toBe('Not a buildable lot');
    expect(why({ t: 'build', tile: 200, kind: 'roastery' })).toBe('Not a buildable lot');
    expect(why({ t: 'build', tile: mine[0].tile, kind: 'roastery' })).toBe('That lot is taken');
    expect(why({ t: 'build', tile: 10 + 72, kind: 'roastery' })).toMatch(/^Out of reach/);
    expect(why({ t: 'build', tile: around[0], kind: 'castle' as never })).toBe('Unknown building');
  });

  it('adjacent property is enough reach (no Factor needed)', () => {
    const solo = rich(1, 1);
    const g2 = stage(solo, (c) => void (c.units.find((u) => u.owner === 0 && u.kind === 'factor')!.tile = 1));
    expect(why({ t: 'build', tile: solo.buildings[0].tile + 1, kind: 'park' }, g2)).toBeNull();
    expect(why({ t: 'build', tile: 34, kind: 'park' }, g2)).toMatch(/^Out of reach/);
  });

  it('the per-House cap is six units', () => {
    const c = stage(g, (x) => {
      for (let i = 0; i < 4; i++) addUnit(x, 0, 'factor', 13 + i * 12 + 11);
    });
    expect(c.units.filter((u) => u.owner === 0)).toHaveLength(UNIT_CAP);
    expect(why({ t: 'recruit', kind: 'watch' }, c)).toBe(`A House fields at most ${UNIT_CAP} units`);
    expect(why({ t: 'recruit', kind: 'watch' })).toBeNull();
    // five recruits in one draft hit the cap after four
    const r = queueAll(g, 0, Array.from({ length: 5 }, () => ({ t: 'recruit', kind: 'factor' }) as Order));
    expect(r.draft).toHaveLength(4);
  });

  it('diplomacy, studies, stances and promotions', () => {
    expect(why({ t: 'propose', to: 0, kind: 'truce' })).toBe('Choose a rival House');
    expect(why({ t: 'propose', to: 7, kind: 'truce' })).toBe('Choose a rival House');
    expect(why({ t: 'propose', to: 1, kind: 'truce' })).toBeNull();
    expect(why({ t: 'respond', proposal: 42, accept: true })).toBe('No such proposal');
    expect(why({ t: 'stance', building: mine[0].id, stance: 1 })).toBe('That stance is already set');
    expect(why({ t: 'stance', building: mine[0].id, stance: 9 })).toBe('Unknown price stance');
    expect(why({ t: 'stance', building: 12345, stance: 2 })).toBe('Choose one of your shops');
    expect(why({ t: 'study', key: 'roasting' })).toBeNull();
    const c = stage(g, (x) => {
      x.players[0].study = 'roasting';
      x.players[0].studyPoints = 1;
    });
    expect(why({ t: 'study', key: 'drill' }, c)).toBe('Finish Fine Roasting first');
    expect(why({ t: 'promo', building: mine[0].id })).toBeNull();
    const p = stage(g, (x) => void (x.buildings[0].promoUntil = 3));
    expect(why({ t: 'promo', building: p.buildings[0].id }, p)).toBe('A Promo Blitz is already running');
    const q = stage(g, (x) => void (x.buildings[0].promoReady = 6));
    expect(why({ t: 'promo', building: q.buildings[0].id }, q)).toBe('Promo Blitz ready again on Turn 6');
  });

  it('contests need a rival Watch Company next to the target and are forbidden under a Truce', () => {
    const w = g.units.find((u) => u.owner === 0 && u.kind === 'watch')!;
    const fac = g.units.find((u) => u.owner === 0 && u.kind === 'factor')!;
    const rival = g.units.find((u) => u.owner === 1)!;
    expect(why({ t: 'contest', unit: fac.id, target: rival.id })).toBe('Only a Watch Company can issue a Contest');
    expect(why({ t: 'contest', unit: w.id, target: w.id })).toBe('Choose a rival unit');
    expect(why({ t: 'contest', unit: w.id, target: rival.id })).toBe('Not adjacent — move the Watch Company next to the target first');
    const near = stage(g, (x) => void (x.units.find((u) => u.id === rival.id)!.tile = w.tile + 1));
    expect(why({ t: 'contest', unit: w.id, target: rival.id }, near)).toBeNull();
    const truce = stage(near, (x) => void x.pacts.push({ id: 900, kind: 'truce', a: 0, b: 1, from: 1, to: 6 }));
    expect(why({ t: 'contest', unit: w.id, target: rival.id }, truce)).toBe('A Truce forbids Contests between these Houses');
    const one = queueOrder(near, 0, [], { t: 'contest', unit: w.id, target: rival.id });
    if (!one.ok) throw new Error('setup');
    expect(queueOrder(near, 0, one.draft, { t: 'contest', unit: w.id, target: rival.id })).toEqual({ ok: false, reason: 'Each Watch Company issues one Contest per turn' });
  });

  it('Rent Accord forbids a same-trade shop within 2 tiles of the partner at planning', () => {
    const base = newGame(5, 'standard', ['human', 'ai', 'ai', 'ai']);
    const c = stage(base, (x) => {
      x.units.find((u) => u.owner === 0 && u.kind === 'factor')!.tile = LANE;
      addBuilding(x, 1, around[0] + 1, 'roastery'); // (8,2) rival Roastery
      x.pacts.push({ id: 901, kind: 'rent', a: 0, b: 1, from: 1, to: 8 });
    });
    expect(why({ t: 'build', tile: around[0], kind: 'roastery' }, c)).toBe('A Rent Accord forbids a same-trade shop within 2 tiles of this rival');
    expect(why({ t: 'build', tile: around[0], kind: 'bistro' }, c)).toBeNull();
    const without = stage(c, (x) => void (x.pacts = []));
    expect(why({ t: 'build', tile: around[0], kind: 'roastery' }, without)).toBeNull();
  });

  it('nothing can be queued after the match has ended', () => {
    expect(why({ t: 'borrow' }, stage(g, (x) => void (x.phase = 'ended')))).toBe('The match is over');
  });

  it('queueing never mutates the world or the given draft', () => {
    const h = stateHash(g);
    const d: Order[] = [{ t: 'borrow' }];
    const r = queueOrder(g, 0, d, { t: 'borrow' });
    expect(r.ok).toBe(true);
    expect(d).toEqual([{ t: 'borrow' }]);
    expect(stateHash(g)).toBe(h);
    expect(checkOrder(g, newPlan(g, 0), { t: 'borrow' })).toBeNull();
  });
});

describe('describeOrder', () => {
  it('labels every order type', () => {
    const g = rich(1, 2);
    const b = g.buildings[0];
    const u = g.units.find((x) => x.owner === 0)!;
    const all: Order[] = [
      { t: 'move', unit: u.id, to: 1 },
      { t: 'contest', unit: u.id, target: 3 },
      { t: 'build', tile: around[0], kind: 'bistro' },
      { t: 'upgrade', building: b.id },
      { t: 'sell', building: b.id },
      { t: 'recruit', kind: 'watch' },
      { t: 'route', unit: u.id, building: b.id },
      { t: 'contract', building: b.id },
      { t: 'propose', to: 1, kind: 'trade' },
      { t: 'respond', proposal: 1, accept: false },
      { t: 'study', key: 'roasting' },
      { t: 'stance', building: b.id, stance: 3 },
      { t: 'restock', building: b.id },
      { t: 'auto', building: b.id, on: true },
      { t: 'promo', building: b.id },
      { t: 'borrow' },
      { t: 'repay' },
      { t: 'charter', key: 'canal' },
    ];
    for (const o of all) {
      const l = describeOrder(g, 0, o);
      expect(l.text.length).toBeGreaterThan(3);
      expect(Number.isInteger(l.cost)).toBe(true);
      expect(l.action).toBe(o.t !== 'charter');
    }
    expect(describeOrder(g, 0, { t: 'build', tile: around[0], kind: 'bistro' }).cost).toBe(280);
  });
});

describe('parseOrder / parseDraft reject malformed input', () => {
  const bad: unknown[] = [
    null,
    undefined,
    42,
    'move',
    [],
    {},
    { t: 'nope' },
    { t: 'move' },
    { t: 'move', unit: '1', to: 2 },
    { t: 'move', unit: 1.5, to: 2 },
    { t: 'move', unit: NaN, to: 2 },
    { t: 'move', unit: Infinity, to: 2 },
    { t: 'build', tile: 5, kind: 'castle' },
    { t: 'build', tile: 5, kind: 'toString' },
    { t: 'build', tile: 5, kind: 'constructor' },
    { t: 'build', tile: 5, kind: '__proto__' },
    { t: 'build', tile: 5 },
    { t: 'upgrade', building: 'x' },
    { t: 'recruit', kind: 'dragon' },
    { t: 'recruit', kind: 'hasOwnProperty' },
    { t: 'propose', to: 1, kind: 'alliance' },
    { t: 'respond', proposal: 1, accept: 'yes' },
    { t: 'study', key: 'alchemy' },
    { t: 'study', key: 'constructor' },
    { t: 'study', key: 'toString' },
    { t: 'study', key: '__proto__' },
    { t: 'charter', key: 'constructor' },
    { t: 'charter', key: 'hasOwnProperty' },
    { t: 'charter', key: 'monarchy' },
    { t: 'stance', building: 1, stance: 1.2 },
    { t: 'auto', building: 1, on: 1 },
    { t: 'route', unit: 1 },
  ];
  it.each(bad.map((b, i) => [i, b] as const))('rejects #%i', (_i, v) => {
    expect(parseOrder(v)).toBeNull();
  });

  it('accepts every well-formed order and strips unknown fields', () => {
    const good: Order[] = [
      { t: 'move', unit: 1, to: 2 },
      { t: 'contest', unit: 1, target: 2 },
      { t: 'build', tile: 5, kind: 'park' },
      { t: 'upgrade', building: 3 },
      { t: 'sell', building: 3 },
      { t: 'recruit', kind: 'barge' },
      { t: 'route', unit: 1, building: 2 },
      { t: 'contract', building: 2 },
      { t: 'propose', to: 1, kind: 'rent' },
      { t: 'respond', proposal: 1, accept: true },
      { t: 'study', key: 'ledger' },
      { t: 'stance', building: 1, stance: 3 },
      { t: 'restock', building: 1 },
      { t: 'auto', building: 1, on: false },
      { t: 'promo', building: 1 },
      { t: 'borrow' },
      { t: 'repay' },
      { t: 'charter', key: 'provisioners' },
    ];
    for (const o of good) expect(parseOrder(JSON.parse(JSON.stringify(o)))).toEqual(o);
    expect(parseOrder({ t: 'move', unit: 1, to: 2, evil: true })).toEqual({ t: 'move', unit: 1, to: 2 });
  });

  it('parseDraft needs an array of at most 40 valid orders', () => {
    expect(parseDraft([])).toEqual([]);
    expect(parseDraft('x')).toBeNull();
    expect(parseDraft({})).toBeNull();
    expect(parseDraft([{ t: 'borrow' }, { t: 'bad' }])).toBeNull();
    expect(parseDraft(Array.from({ length: 40 }, () => ({ t: 'borrow' })))).toHaveLength(40);
    expect(parseDraft(Array.from({ length: 41 }, () => ({ t: 'borrow' })))).toBeNull();
  });

  it('a hostile order that slips past parsing is dropped by validation, never crashing', () => {
    const g = rich(1, 2);
    const hostile = [
      { t: 'move', unit: 1, to: 1e9 },
      { t: 'build', tile: -5, kind: 'park' },
      { t: 'stance', building: 1, stance: -1 },
      { t: 'propose', to: -1, kind: 'truce' },
      { t: 'study', key: 'constructor' },
      { t: 'charter', key: 'constructor' },
      { t: 'recruit', kind: 'constructor' },
      { t: 'build', tile: around[0], kind: 'constructor' },
    ] as unknown as Order[];
    const r = pruneDraft(g, 0, hostile);
    expect(r.kept).toEqual([]);
    expect(r.removed).toHaveLength(hostile.length);
  });
});
