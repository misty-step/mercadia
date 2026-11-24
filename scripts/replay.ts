// Headless replay of an exported match: node ./node_modules/tsx/dist/cli.mjs scripts/replay.ts <export.json>
// Replays the canonical action log (including recorded Endless continuations) through the real resolver
// and compares every turn's full state hash with the export. Prints one JSON line; exits 1 on mismatch.
import { readFileSync } from 'node:fs';
import { replayMatchExport, type MatchExport } from '../src/shared/replay';

const file = process.argv[2];
if (!file) {
  console.error('usage: replay.ts <export.json>');
  process.exit(2);
}
const exp = JSON.parse(readFileSync(file, 'utf8')) as MatchExport;
let out: Record<string, unknown>;
try {
  const rep = replayMatchExport(exp);
  const mismatches = exp.hashes.flatMap((h, i) => (rep.hashes[i] === h ? [] : [i + 1]));
  out = {
    ok: mismatches.length === 0 && rep.hashes.length === exp.hashes.length,
    turnsLogged: exp.log.length,
    turnsReplayed: rep.hashes.length,
    endlessAt: exp.endlessAt ?? [],
    mismatches,
    finalTurn: rep.game.turn,
    phase: rep.game.phase,
    endless: rep.game.endless,
  };
} catch (e) {
  out = { ok: false, error: (e as Error).message, version: exp.version, turnsLogged: exp.log?.length ?? 0, endlessAt: exp.endlessAt ?? [] };
}
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
