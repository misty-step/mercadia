// Headless seeded matches through the real resolution code: `npx tsx scripts/balance.ts [matches] [mode]`.
import { createGame, stateHash } from '../src/shared/game';
import { canonicalOrders, resolveTurn } from '../src/shared/resolve';
import { HOUSES } from '../src/shared/constants';
import type { MatchMode } from '../src/shared/types';

const matches = Number(process.argv[2] ?? 6);
const mode = (process.argv[3] ?? 'standard') as MatchMode;
const wins = [0, 0, 0, 0];
const personas = ['vesper', 'aurelia', 'orson'] as const;
for (let m = 0; m < matches; m++) {
  let g = createGame({
    seed: 1000 + m * 17,
    mode,
    players: [
      { name: 'Vesper', house: 0, kind: 'ai', persona: 'vesper' },
      { name: 'Aurelia', house: 1, kind: 'ai', persona: 'aurelia' },
      { name: 'Orson', house: 2, kind: 'ai', persona: 'orson' },
      { name: 'Vesper II', house: 3, kind: 'ai', persona: personas[m % 3] },
    ],
  });
  const t0 = Date.now();
  while (g.phase !== 'ended') g = resolveTurn(g, canonicalOrders(g, [])).game;
  wins[g.winner]++;
  const row = g.standings.map((s) => `${HOUSES[g.players[s.player].house].short}:${s.crown}(w${s.worthComponent}/s${s.shareComponent}/p${s.prestigeComponent})`).join('  ');
  const bld = g.players.map((_, i) => g.buildings.filter((b) => b.owner === i).length).join('/');
  console.log(`seed ${1000 + m * 17} ${stateHash(g).slice(0, 8)} ${Date.now() - t0}ms  bld ${bld}  ${row}`);
}
console.log('wins', wins.join(' '));
