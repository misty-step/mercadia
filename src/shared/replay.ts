// Replay equivalence: a match is its config (seed, mode, seats) plus the canonical action log.
// Replaying the log through the real resolution code reproduces every turn's state hash and summary.
import { createGame, stateHash } from './game';
import { resolveTurn } from './resolve';
import type { ActionLog, Game, MatchConfig, TurnSummary } from './types';

export interface MatchExport {
  version: 3;
  config: MatchConfig;
  log: ActionLog;
  /** Full state hash after each resolved turn. */
  hashes: string[];
}

export interface ReplayResult {
  game: Game;
  hashes: string[];
  summaries: TurnSummary[];
}

export function replayMatch(config: MatchConfig, log: ActionLog): ReplayResult {
  let g = createGame(config);
  const hashes: string[] = [];
  const summaries: TurnSummary[] = [];
  for (const orders of log) {
    const r = resolveTurn(g, orders);
    g = r.game;
    hashes.push(stateHash(g));
    summaries.push(r.summary);
  }
  return { game: g, hashes, summaries };
}
