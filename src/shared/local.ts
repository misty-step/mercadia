// LocalMatch: the browser-side host for Solo and Hotseat. It runs the same pure core the room
// authority runs, so identical inputs give identical state hashes on every host.
import { SUMMARY_KEEP } from './constants';
import { createGame, stateHash } from './game';
import type { MatchExport } from './replay';
import { canonicalOrders, continueEndless, resolveTurn } from './resolve';
import type { ActionLog, Game, MatchConfig, Order, TurnSummary } from './types';

export class LocalMatch {
  game: Game;
  readonly config: MatchConfig;
  log: ActionLog = [];
  /** Log lengths at which Continue in Endless was pressed (canonical continuation record). */
  endlessAt: number[] = [];
  hashes: string[] = [];
  summaries: TurnSummary[] = [];
  /** Per player: this turn's draft. */
  drafts: Order[][];

  constructor(config: MatchConfig) {
    this.config = config;
    this.game = createGame(config);
    this.drafts = this.game.players.map(() => []);
  }

  get summary(): TurnSummary | null {
    return this.summaries[this.summaries.length - 1] ?? null;
  }

  setDraft(player: number, orders: Order[]): void {
    this.drafts[player] = orders;
  }

  /** End the turn: resolve exactly once, then open the next planning phase. */
  endTurn(): TurnSummary {
    const orders = canonicalOrders(this.game, this.drafts);
    const r = resolveTurn(this.game, orders);
    this.log.push(r.committed);
    this.game = r.game;
    this.hashes.push(stateHash(r.game));
    this.summaries.push(r.summary);
    if (this.summaries.length > SUMMARY_KEEP) this.summaries.shift();
    this.drafts = this.game.players.map(() => []);
    return r.summary;
  }

  hash(): string {
    return stateHash(this.game);
  }

  continueEndless(): boolean {
    const next = continueEndless(this.game);
    if (!next) return false;
    this.game = next;
    this.endlessAt.push(this.log.length);
    return true;
  }

  export(): MatchExport {
    const out: MatchExport = { version: 3, config: this.config, log: this.log, hashes: this.hashes };
    if (this.endlessAt.length > 0) out.endlessAt = [...this.endlessAt];
    return out;
  }
}
