// Replay equivalence: a match is its config (seed, mode, seats) plus the canonical action log.
// Replaying the log through the real resolution code reproduces every turn's state hash and summary.
import { createGame, stateHash } from './game';
import { continueEndless, resolveTurn } from './resolve';
import type { ActionLog, Game, MatchConfig, TurnSummary } from './types';

export interface MatchExport {
  version: 3;
  config: MatchConfig;
  log: ActionLog;
  /** Full state hash after each resolved turn. */
  hashes: string[];
  /**
   * Endless continuations: each entry is the number of resolved turns (the log length) at the moment
   * Continue in Endless was pressed. Optional: exports without it replay exactly as before.
   */
  endlessAt?: number[];
}

export interface ReplayResult {
  game: Game;
  hashes: string[];
  summaries: TurnSummary[];
}

/** Apply the recorded Endless continuation(s) due before the batch at `index` (and, for index = log length, after the last). */
function continueDue(g: Game, endlessAt: readonly number[], index: number): Game {
  let cur = g;
  for (const at of endlessAt) {
    if (at === index) {
      const next = continueEndless(cur);
      if (!next) throw new Error(`Endless continuation recorded at turn ${index} but the match was not over`);
      cur = next;
    }
  }
  return cur;
}

export function replayMatch(config: MatchConfig, log: ActionLog, endlessAt: readonly number[] = []): ReplayResult {
  let g = createGame(config);
  const hashes: string[] = [];
  const summaries: TurnSummary[] = [];
  for (let i = 0; i < log.length; i++) {
    g = continueDue(g, endlessAt, i);
    const orders = log[i];
    const r = resolveTurn(g, orders);
    g = r.game;
    hashes.push(stateHash(g));
    summaries.push(r.summary);
  }
  g = continueDue(g, endlessAt, log.length);
  return { game: g, hashes, summaries };
}
