import { describe, expect, it } from 'vitest';
import { AI_UNIT_CAP, planAI } from '../src/shared/ai';
import { UNIT_CAP } from '../src/shared/constants';
import { actionsFor, stateHash } from '../src/shared/game';
import { pruneDraft } from '../src/shared/orders';
import { canonicalOrders, resolveTurn } from '../src/shared/resolve';
import type { Game, Order } from '../src/shared/types';
import { checkTransition, draftRng, genDraft, newGame, playToEnd, stage, step } from './helpers';

describe('AI determinism', () => {
  it('identical seed and state give identical AI orders, call after call', () => {
    for (const mode of ['blitz', 'standard'] as const) {
      let g = newGame(41, mode, ['human', 'ai', 'ai', 'ai']);
      while (g.phase !== 'ended') {
        for (let seat = 1; seat < 4; seat++) {
          const a = planAI(g, seat);
          const b = planAI(JSON.parse(JSON.stringify(g)) as Game, seat);
          expect(b).toEqual(a);
        }
        g = step(g, []).game;
      }
    }
  });

  it('AI orders never depend on human drafts or on when/in what order humans act', () => {
    const rngA = draftRng(7, 'a');
    const rngB = draftRng(8, 'b');
    let g = newGame(42, 'blitz', ['human', 'human', 'ai', 'ai']);
    for (let t = 0; t < 12; t++) {
      // Wildly different human drafts against the same frozen state: the AI seats do not notice.
      const ca = canonicalOrders(g, [genDraft(g, 0, rngA, 6), genDraft(g, 1, rngA, 6)]);
      const cb = canonicalOrders(g, [genDraft(g, 0, rngB, 3), []]);
      const none = canonicalOrders(g, []);
      expect(ca[2]).toEqual(cb[2]);
      expect(ca[3]).toEqual(cb[3]);
      expect(ca[2]).toEqual(none[2]);
      expect(ca[3]).toEqual(none[3]);
      g = resolveTurn(g, ca).game;
    }
  });

  it('solo matches with the same seed and human orders have identical AI orders and Turn Deltas', () => {
    const run = () => {
      const rng = draftRng(9, 'solo');
      const outcome: { ai: Order[][]; sum: string; hash: string }[] = [];
      let g = newGame(43, 'standard', ['human', 'ai', 'ai', 'ai']);
      for (let t = 0; t < 14; t++) {
        const co = canonicalOrders(g, [genDraft(g, 0, rng, 5)]);
        const r = resolveTurn(g, co);
        outcome.push({ ai: co.slice(1), sum: JSON.stringify(r.summary), hash: stateHash(r.game) });
        g = r.game;
      }
      return outcome;
    };
    expect(run()).toEqual(run());
  });

  it('planAI never mutates the state it is given', () => {
    const g = newGame(44, 'standard', ['ai', 'ai', 'ai', 'ai']);
    const before = JSON.stringify(g);
    for (let s = 0; s < 4; s++) planAI(g, s);
    expect(JSON.stringify(g)).toBe(before);
  });
});

describe('AI obeys the same rules as a human', () => {
  it('every AI order is legal against the frozen state: nothing is pruned, Actions and treasury hold, every turn of full matches', () => {
    let total = 0;
    for (const [seed, mode] of [[51, 'standard'], [52, 'blitz'], [53, 'standard'], [54, 'blitz']] as const) {
      let g = newGame(seed, mode, ['ai', 'ai', 'ai', 'ai']);
      while (g.phase !== 'ended') {
        for (let seat = 0; seat < 4; seat++) {
          const orders = planAI(g, seat);
          const r = pruneDraft(g, seat, orders);
          expect(r.removed, `seed ${seed} turn ${g.turn} seat ${seat}`).toEqual([]);
          expect(orders.filter((o) => o.t !== 'charter').length).toBeLessThanOrEqual(actionsFor(g, g.players[seat]));
          expect(r.plan.cash).toBeGreaterThanOrEqual(0);
          expect(g.units.filter((u) => u.owner === seat).length + orders.filter((o) => o.t === 'recruit').length).toBeLessThanOrEqual(UNIT_CAP);
          total += orders.length;
        }
        const res = step(g, []);
        expect(checkTransition(g, res)).toEqual([]);
        g = res.game;
      }
    }
    expect(total).toBeGreaterThan(200);
    expect(AI_UNIT_CAP).toBe(UNIT_CAP);
  });

  it('AI Houses pick a Charter on every Council turn, and respect Era locks', () => {
    for (const mode of ['blitz', 'standard'] as const) {
      let g = newGame(55, mode, ['ai', 'ai', 'ai', 'ai']);
      while (g.phase !== 'ended') {
        const co = canonicalOrders(g, []);
        if (g.council) {
          co.forEach((list, i) => {
            const c = list.filter((o) => o.t === 'charter');
            expect(c).toHaveLength(1);
            expect(g.council!.offers[i]).toContain((c[0] as Extract<Order, { t: 'charter' }>).key);
          });
        }
        for (const [i, list] of co.entries()) {
          for (const o of list) {
            if (o.t === 'build') expect([1, 1, 1, 2, 2, 2, 3, 3, 3][['roastery', 'bistro', 'park', 'arcade', 'nightmarket', 'tramstop', 'boutique', 'cinema', 'plaza'].indexOf(o.kind)]).toBeLessThanOrEqual(Math.ceil(g.turn / (mode === 'blitz' ? 4 : 8)));
          }
          void i;
        }
        g = resolveTurn(g, co).game;
      }
    }
  });

  it('the three temperaments behave differently', () => {
    const { game } = playToEnd(newGame(56, 'standard', ['ai', 'ai', 'ai']));
    const kinds = game.players.map((p, i) => ({ persona: p.persona, built: game.buildings.filter((b) => b.owner === i).map((b) => b.kind).sort().join() }));
    expect(new Set(kinds.map((k) => k.persona)).size).toBe(3);
    expect(new Set(kinds.map((k) => k.built)).size).toBeGreaterThan(1);
  });

  it('a stage-edited House that cannot afford anything gets no unaffordable orders', () => {
    const g = stage(newGame(57, 'standard', ['ai', 'ai']), (c) => void (c.players.forEach((p) => (p.cash = 5))));
    for (const seat of [0, 1]) {
      const r = pruneDraft(g, seat, planAI(g, seat));
      expect(r.removed).toEqual([]);
      expect(r.plan.cash).toBeGreaterThanOrEqual(0);
    }
  });
});
