import { describe, expect, it } from 'vitest';
import { SUMMARY_KEEP } from '../src/shared/constants';
import { createGame, stateHash } from '../src/shared/game';
import { LocalMatch } from '../src/shared/local';
import { replayMatch, type MatchExport } from '../src/shared/replay';
import { canonicalOrders, resolveTurn } from '../src/shared/resolve';
import type { MatchConfig, Order } from '../src/shared/types';
import { config, draftRng, genDraft } from './helpers';

function playLocal(cfg: MatchConfig, humanSeed?: number): LocalMatch {
  const m = new LocalMatch(cfg);
  const rngs = cfg.players.map((_, i) => draftRng(humanSeed ?? 0, `p${i}`));
  const all: string[] = [];
  while (m.game.phase !== 'ended') {
    cfg.players.forEach((p, i) => {
      if (p.kind === 'human') m.setDraft(i, humanSeed === undefined ? [] : genDraft(m.game, i, rngs[i], 7));
    });
    const s = m.endTurn();
    all.push(s.hash);
  }
  return m;
}

describe('replay equivalence', () => {
  it.each([
    ['full AI-vs-AI standard match', config(61, 'standard', ['ai', 'ai', 'ai', 'ai']), undefined],
    ['full AI-vs-AI blitz match', config(62, 'blitz', ['ai', 'ai', 'ai']), undefined],
    ['solo with generated human orders', config(63, 'standard', ['human', 'ai', 'ai', 'ai']), 63],
    ['hotseat with generated human orders', config(64, 'blitz', ['human', 'human', 'ai']), 64],
  ] as const)('%s: replay from config and log reproduces every hash, summary and the winner', (_name, cfg, humanSeed) => {
    const m = playLocal(cfg, humanSeed);
    const exp: MatchExport = JSON.parse(JSON.stringify(m.export())); // survives the wire
    const rep = replayMatch(exp.config, exp.log);
    expect(rep.hashes).toEqual(exp.hashes);
    expect(rep.hashes).toHaveLength(m.game.mode === 'blitz' ? 16 : 32);
    expect(stateHash(rep.game)).toBe(m.hash());
    expect(rep.game.winner).toBe(m.game.winner);
    expect(rep.game.standings).toEqual(m.game.standings);
    expect(rep.summaries.slice(-SUMMARY_KEEP)).toEqual(m.summaries);
    expect(rep.game.phase).toBe('ended');
  });

  it('the log is the canonical committed orders: replay does not need the AI at all', () => {
    const m = playLocal(config(65, 'blitz', ['ai', 'ai']));
    // An AI-free replay (the resolver is fed the log; planAI is never consulted for committed orders).
    let g = createGame(m.config);
    m.log.forEach((orders, i) => {
      g = resolveTurn(g, orders).game;
      expect(stateHash(g)).toBe(m.hashes[i]);
    });
  });

  it('a different log diverges', () => {
    const m = playLocal(config(66, 'blitz', ['human', 'ai']), 66);
    const tampered = JSON.parse(JSON.stringify(m.log)) as Order[][][];
    tampered[0][0] = [{ t: 'borrow' }];
    const rep = replayMatch(m.config, tampered);
    expect(rep.hashes[0]).not.toBe(m.hashes[0]);
  });

  it('state hash and summary are the same through two independent runs of one log', () => {
    const m = playLocal(config(67, 'standard', ['human', 'ai', 'ai']), 67);
    const a = replayMatch(m.config, m.log);
    const b = replayMatch(JSON.parse(JSON.stringify(m.config)), JSON.parse(JSON.stringify(m.log)));
    expect(a.hashes).toEqual(b.hashes);
    expect(a.summaries).toEqual(b.summaries);
  });
});

describe('LocalMatch (solo and hotseat host)', () => {
  it('End Turn resolves exactly one turn, and drafts are cleared for the next', () => {
    const m = new LocalMatch(config(68, 'standard', ['human', 'ai']));
    const h0 = m.hash();
    m.setDraft(0, [{ t: 'borrow' }]);
    expect(m.hash()).toBe(h0); // planning does not change the world
    const s = m.endTurn();
    expect(s.from).toBe(1);
    expect(m.game.turn).toBe(2);
    expect(m.drafts[0]).toEqual([]);
    expect(m.log).toHaveLength(1);
    expect(m.summary).toBe(s);
    expect(m.game.players[0].debt).toBeGreaterThanOrEqual(400);
  });

  it('keeps only the recent summaries and can continue in Endless once finished', () => {
    const m = playLocal(config(69, 'blitz', ['ai', 'ai']));
    expect(m.summaries).toHaveLength(SUMMARY_KEEP);
    expect(m.continueEndless()).toBe(true);
    expect(m.game.phase).toBe('planning');
    m.endTurn();
    expect(m.game.turn).toBe(18);
    expect(new LocalMatch(config(1, 'blitz', ['ai', 'ai'])).continueEndless()).toBe(false);
  });

  it('local and server hosts produce identical state for identical inputs', () => {
    const cfg = config(70, 'blitz', ['human', 'ai', 'ai']);
    const m = new LocalMatch(cfg);
    let g = createGame(cfg);
    const rng1 = draftRng(70, 'x');
    const rng2 = draftRng(70, 'x');
    for (let t = 0; t < 16; t++) {
      m.setDraft(0, genDraft(m.game, 0, rng1, 6));
      m.endTurn();
      g = resolveTurn(g, canonicalOrders(g, [genDraft(g, 0, rng2, 6)])).game;
      expect(m.hash()).toBe(stateHash(g));
    }
  });
});
