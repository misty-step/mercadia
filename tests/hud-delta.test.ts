import { describe, expect, it } from 'vitest';
import { deltaModel, rankChip } from '../src/client/hud-delta';
import type { SessionView } from '../src/client/contracts';
import { computeStandings } from '../src/shared/game';
import { config, stage, step } from './helpers';
import { createGame } from '../src/shared/game';

function view() {
  const g0 = stage(createGame(config(9, 'standard', ['human', 'human', 'human'])), (c) => {
    c.players[0].cash = 3000;
    c.players[1].cash = 1500;
    c.players[2].cash = 200;
    c.standings = computeStandings(c);
    c.players[0].cash = 100;
    c.players[2].cash = 4000;
  });
  const r = step(g0, []);
  const v = { game: r.game, summary: r.summary, summaries: [r.summary], seat: 0 } as unknown as SessionView;
  return { v, r };
}

describe('Turn Delta score block', () => {
  it('renders rank moves and the three component deltas for every House, in new rank order', () => {
    const { v, r } = view();
    const m = deltaModel(v, -1, new Set(), false)!;
    expect(m.heading).toBe('Turn 1 → 2');
    const text = m.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Crown Index · rank');
    expect(text).toContain('#1 → #3');
    expect(text).toContain('▼2');
    expect(text).toContain('#3 → #1');
    expect(text).toContain('▲2');
    expect(text).toContain('#2 held');
    for (const s of r.summary.scores) {
      const sign = (n: number) => (n === 0 ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`);
      expect(text).toContain(`Worth ${sign(s.worthDelta)}`);
      expect(text).toContain(`Share ${sign(s.shareDelta)}`);
      expect(text).toContain(`Prestige ${sign(s.prestigeDelta)}`);
      expect(text).toContain(sign(s.crownDelta));
    }
    const order = [...m.body.matchAll(/data-k="sc(\d)"/g)].map((x) => Number(x[1]));
    expect(order).toEqual(r.game.standings.map((s) => s.player));
  });

  it('rankChip reads climb, fall and hold', () => {
    const base = { player: 0, prevRank: 1, nextRank: 1, rankDelta: 0, prevCrown: 0, crown: 0, crownDelta: 0, worthDelta: 0, shareDelta: 0, prestigeDelta: 0 };
    expect(rankChip({ ...base, rankDelta: 3 }).text).toBe('▲3');
    expect(rankChip({ ...base, rankDelta: -1 }).text).toBe('▼1');
    expect(rankChip(base).text).toBe('held');
  });
});
