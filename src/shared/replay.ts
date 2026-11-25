// Replay equivalence: a match is its config (seed, mode, seats) plus the canonical action log.
// Replaying the log through the real resolution code reproduces every turn's state hash and summary.
import { createGame, stateHash } from './game';
import { continueEndless, resolveTurn } from './resolve';
import type { ActionLog, Game, MatchConfig, TurnSummary } from './types';

/**
 * Export/ruleset version. Any change to the initial world or the rules changes every state hash, so the
 * version is bumped and older exports are rejected up front instead of replayed:
 *  - 4: Turn 1 start tiles moved beside Grand Station (version 3 exports no longer reproduce).
 *  - 5: start tiles are keyed by House (Vermilion, Cobalt, Marigold (4,1)/(3,1), Emerald (10,3)/(11,3)) instead
 *       of by seat, which changes the initial world and Turn 1 hash of the default seating (version 4 exports
 *       no longer reproduce).
 */
export const MATCH_EXPORT_VERSION = 5;

export interface MatchExport {
  version: typeof MATCH_EXPORT_VERSION;
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

/** Throws a clear error unless `exp` is an export this build's rules can replay bit-for-bit. */
export function assertExportVersion(exp: { version?: unknown }): void {
  if (exp.version !== MATCH_EXPORT_VERSION) {
    const got = exp.version === undefined ? 'missing' : String(exp.version);
    throw new Error(
      `Incompatible match export version ${got}: this build replays version ${MATCH_EXPORT_VERSION} exports only (ruleset changed; older exports cannot be replayed)`,
    );
  }
}

/** Replay a full export after checking its version. */
export function replayMatchExport(exp: MatchExport): ReplayResult {
  assertExportVersion(exp);
  return replayMatch(exp.config, exp.log, exp.endlessAt ?? []);
}
