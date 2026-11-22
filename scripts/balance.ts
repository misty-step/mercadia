// Headless balance probe: runs AI-only matches and prints the economy.
//   npx tsx scripts/balance.ts [seeds=4] [mode=standard] [verbose=0]
import { advance } from '../src/shared/ai';
import { HOUSES, SHOPS, SHOP_KINDS, isShop } from '../src/shared/constants';
import { createGame, crownIndex, ledgerNet, marketShares, netWorth, priceOf, rentOf, wageOf } from '../src/shared/sim';
import type { AiPersona, MatchMode, ShopKind } from '../src/shared/types';

const seeds = Number(process.argv[2] ?? 4);
const mode = (process.argv[3] ?? 'standard') as MatchMode;
const verbose = process.argv[4] === '1';
const ORDERS: AiPersona[][] = [
  ['vesper', 'aurelia', 'orson', 'vesper'],
  ['orson', 'vesper', 'aurelia', 'aurelia'],
  ['aurelia', 'orson', 'vesper', 'orson'],
  ['vesper', 'orson', 'aurelia', 'vesper'],
];
const crownBy: Record<string, number[]> = { vesper: [], aurelia: [], orson: [] };
const wins: Record<string, number> = { vesper: 0, aurelia: 0, orson: 0 };
for (let seed = 1; seed <= seeds; seed++) {
  const personas = ORDERS[(seed - 1) % ORDERS.length];
  const s = createGame({ seed: seed * 101, mode, players: personas.map((persona, i) => ({ name: `${persona}${i}`, house: i, kind: 'ai' as const, persona })) });
  const quarters = mode === 'blitz' ? 2 : 4;
  let pop = 0;
  for (let q = 1; q <= quarters; q++) {
    const sales: Record<string, { n: number; rev: number; gross: number }> = {};
    for (const k of SHOP_KINDS) sales[k] = { n: 0, rev: 0, gross: 0 };
    let turned = 0;
    let fixed = 0;
    for (let t = 0; t < s.quarterTicks; t++) {
      advance(s);
      pop += s.citizens.length;
      for (const f of s.fx) {
        if (f.k === 'turn' || f.k === 'walkout') turned++;
      }
      s.fx = [];
      if (s.tick % 100 === 0) for (const b of s.buildings) fixed += wageOf(b) + rentOf(b);
    }
    if (!verbose) continue;
    console.log(`\n── seed ${seed} after Q${q}: pop avg ${(pop / s.tick).toFixed(0)}, lots built ${s.buildings.length}/49, turned ${turned}, fixed/quarter ${fixed.toFixed(0)}`);
    const shares = marketShares(s);
    for (const p of s.players) {
      const mine = s.buildings.filter((b) => b.owner === p.id);
      const kinds = [...SHOP_KINDS, 'park', 'tramstop', 'plaza'].map((k) => `${k.slice(0, 3)}${mine.filter((b) => b.kind === k).length}`).join(' ');
      console.log(
        `${HOUSES[p.house].short.padEnd(9)} ${String(p.persona).padEnd(8)} cash ${String(Math.round(p.cash)).padStart(5)} debt ${String(p.debt).padStart(4)} nw ${String(netWorth(s, p)).padStart(5)} crown ${String(crownIndex(s, p)).padStart(4)} share ${(shares[p.id] * 100).toFixed(0).padStart(2)}% pres ${p.prestige.toFixed(1).padStart(5)} | Q rev ${String(Math.round(p.lastLedger.revenue)).padStart(5)} net ${String(Math.round(ledgerNet(p.lastLedger))).padStart(5)} oper ${String(Math.round(p.lastLedger.revenue - p.lastLedger.wages - p.lastLedger.supplies - p.lastLedger.rent - p.lastLedger.interest)).padStart(5)} | ${kinds} lv[${mine.filter((b) => b.level > 1).map((b) => b.level).join('')}] promos ${p.stats.promos}`,
      );
    }
    for (const k of SHOP_KINDS) {
      const list = s.buildings.filter((b) => b.kind === k);
      const def = SHOPS[k as ShopKind];
      const rate = list.map((b) => (b.revenue / Math.max(300, s.tick - b.builtTick)) * 1500);
      const avgRev = rate.length ? rate.reduce((a, b) => a + b, 0) / rate.length : 0;
      const avgFixed = list.length ? list.reduce((a, b) => a + (wageOf(b) + rentOf(b)) * 15, 0) / list.length : 0;
      const avgMargin = list.length ? list.reduce((a, b) => a + (1 - def.unitCost / priceOf(b)), 0) / list.length : 0;
      console.log(
        `   ${k.padEnd(11)} n=${String(list.length).padStart(2)} served ${String(list.reduce((a, b) => a + b.served, 0)).padStart(4)} | per shop per quarter: rev ${avgRev.toFixed(0).padStart(5)} gross ${(avgRev * avgMargin).toFixed(0).padStart(5)} fixed ${avgFixed.toFixed(0).padStart(4)} net ${(avgRev * avgMargin - avgFixed).toFixed(0).padStart(5)} | stances ${list.map((b) => b.stance).join('')} lv ${list.map((b) => b.level).join('')}`,
      );
    }
  }
  const row = s.players.map((p) => `${p.persona}:${crownIndex(s, p)}`).join('  ');
  const best = s.players.slice().sort((a, b) => crownIndex(s, b) - crownIndex(s, a))[0];
  wins[best.persona as string]++;
  for (const p of s.players) crownBy[p.persona as string].push(crownIndex(s, p));
  const shops = s.buildings.filter((b) => isShop(b.kind)).length;
  console.log(`seed ${seed}: ${row}  | buildings ${s.buildings.length} (shops ${shops}) pop ${(pop / s.tick).toFixed(0)} served ${s.players.reduce((a, p) => a + p.stats.served, 0)}`);
}
for (const k of Object.keys(crownBy)) {
  const v = crownBy[k];
  console.log(`${k.padEnd(8)} avg crown ${(v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)).toFixed(0).padStart(5)}  min ${Math.min(...v)} max ${Math.max(...v)}  wins ${wins[k]}`);
}
