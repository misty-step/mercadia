// Headless balance probe: runs seeded matches and prints the economy.
//   npx tsx scripts/balance.ts [seeds=12] [mode=standard] [verbose=0]
//   npx tsx scripts/balance.ts 12 pvp        2 casual humans + 2 AI in Blitz (opening-curve probe)
//   npx tsx scripts/balance.ts 12 all        Standard, Blitz and the Blitz 2H+2AI probe in one report
import { advance } from '../src/shared/ai';
import { CIVICS, DESIRES, HOUSES, SHOPS, SHOP_KINDS, isShop } from '../src/shared/constants';
import { CITY, chebyshev } from '../src/shared/map';
import { applyCommand, buildingAt, createGame, crownIndex, ledgerNet, marketShares, netWorth, priceOf, rentOf, trafficPips, upgradeCost, wageOf } from '../src/shared/sim';
import type { AiPersona, GameState, MatchMode, PlayerSetup, ShopKind } from '../src/shared/types';

const seeds = Number(process.argv[2] ?? 12);
const what = process.argv[3] ?? 'standard';
const verbose = process.argv[4] === '1';
const ORDERS: AiPersona[][] = [
  ['vesper', 'aurelia', 'orson', 'vesper'],
  ['orson', 'vesper', 'aurelia', 'aurelia'],
  ['aurelia', 'orson', 'vesper', 'orson'],
  ['vesper', 'orson', 'aurelia', 'vesper'],
];
const PERSONAS: AiPersona[] = ['vesper', 'aurelia', 'orson'];
const avg = (v: number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

// ───────────────────────────── AI-only matches ─────────────────────────────

function aiOnly(mode: MatchMode): void {
  console.log(`\n== ${mode.toUpperCase()} · 4 AI tycoons · ${seeds} seeds ==`);
  const crownBy: Record<string, number[]> = { vesper: [], aurelia: [], orson: [] };
  const wins: Record<string, number> = { vesper: 0, aurelia: 0, orson: 0 };
  const seats: Record<string, number> = { vesper: 0, aurelia: 0, orson: 0 };
  for (let seed = 1; seed <= seeds; seed++) {
    const personas = ORDERS[(seed - 1) % ORDERS.length];
    const s = createGame({ seed: seed * 101, mode, players: personas.map((persona, i) => ({ name: `${persona}${i}`, house: i, kind: 'ai' as const, persona })) });
    const quarters = s.totalQuarters;
    let pop = 0;
    for (let q = 1; q <= quarters; q++) {
      let turned = 0;
      let fixed = 0;
      for (let t = 0; t < s.quarterTicks; t++) {
        advance(s);
        pop += s.citizens.length;
        for (const f of s.fx) if (f.k === 'turn' || f.k === 'walkout') turned++;
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
        const rate = list.map((b) => (b.revenue / Math.max(300, s.tick - b.builtTick)) * s.quarterTicks);
        const avgRev = rate.length ? avg(rate) : 0;
        const avgFixed = list.length ? avg(list.map((b) => (wageOf(b) + rentOf(b)) * (s.quarterTicks / 100))) : 0;
        const avgMargin = list.length ? avg(list.map((b) => 1 - def.unitCost / priceOf(b))) : 0;
        console.log(
          `   ${k.padEnd(11)} n=${String(list.length).padStart(2)} served ${String(list.reduce((a, b) => a + b.served, 0)).padStart(4)} | per shop per quarter: rev ${avgRev.toFixed(0).padStart(5)} gross ${(avgRev * avgMargin).toFixed(0).padStart(5)} fixed ${avgFixed.toFixed(0).padStart(4)} net ${(avgRev * avgMargin - avgFixed).toFixed(0).padStart(5)} | stances ${list.map((b) => b.stance).join('')} lv ${list.map((b) => b.level).join('')}`,
        );
      }
    }
    const row = s.players.map((p) => `${p.persona}:${crownIndex(s, p)}`).join('  ');
    const best = s.players.slice().sort((a, b) => crownIndex(s, b) - crownIndex(s, a))[0];
    wins[best.persona as string]++;
    for (const p of s.players) {
      crownBy[p.persona as string].push(crownIndex(s, p));
      seats[p.persona as string]++;
    }
    const shops = s.buildings.filter((b) => isShop(b.kind)).length;
    console.log(`seed ${String(seed).padStart(2)}: ${row}  | winner ${best.persona} | buildings ${s.buildings.length} (shops ${shops}) pop ${(pop / s.tick).toFixed(0)} served ${s.players.reduce((a, p) => a + p.stats.served, 0)}`);
  }
  for (const k of PERSONAS) {
    const v = crownBy[k];
    console.log(`${k.padEnd(8)} avg crown ${avg(v).toFixed(0).padStart(5)}  min ${Math.min(...v)} max ${Math.max(...v)}  wins ${wins[k]}/${seeds}  (seats ${seats[k]}, ${((wins[k] / Math.max(1, seats[k])) * 100).toFixed(0)}% per seat; an even table is 25%)`);
  }
  const top = Math.max(...PERSONAS.map((k) => wins[k]));
  const means = PERSONAS.map((k) => avg(crownBy[k]));
  console.log(`most wins by one persona: ${top}/${seeds} · average-crown spread: ${(((Math.max(...means) - Math.min(...means)) / Math.max(...means)) * 100).toFixed(0)}%`);
}

// ───────────────────────────── Blitz: 2 humans + 2 AI ─────────────────────────────

/**
 * A stand-in for a casual human: looks around for four seconds, then takes one deliberate
 * action about every seven. Reads what the HUD shows — unmet-demand bars and foot-traffic
 * pips — leaves prices at Fair, adds a Pocket Park beside its shops, upgrades a shop that is
 * turning people away. No promos, no price play, no event timing: a floor, not a ceiling.
 */
function casualHuman(s: GameState, id: number, offset: number): void {
  if (s.tick < 40 + offset || (s.tick - 40 - offset) % 70 !== 0) return;
  const p = s.players[id];
  const mine = s.buildings.filter((b) => b.owner === id);
  const shops = mine.filter((b) => isShop(b.kind));
  const free = CITY.lots.filter((t) => !buildingAt(s, t));
  // A park once two shops stand, beside the most of them.
  if (shops.length >= 2 && !mine.some((b) => b.kind === 'park') && p.cash >= CIVICS.park.cost + 60) {
    let best = -1;
    let bs = 0;
    for (const t of free) {
      const n = shops.filter((b) => chebyshev(b.tile, t) <= 1).length;
      if (n > bs) {
        bs = n;
        best = t;
      }
    }
    if (best >= 0 && applyCommand(s, id, { c: 'build', tile: best, kind: 'park' }).ok) return;
  }
  // Upgrade the shop that turns the most people away.
  const busy = shops.filter((b) => b.level < 3 && b.turned >= 4 && upgradeCost(b) <= p.cash - 60).sort((a, b) => b.turned - a.turned)[0];
  if (busy && applyCommand(s, id, { c: 'upgrade', id: busy.id }).ok) return;
  // Otherwise open the trade the dock says is most wanted, on the busiest free lot.
  const want = SHOP_KINDS.filter((k) => SHOPS[k].cost <= p.cash - 40)
    .map((k) => ({ k, score: s.unmet[DESIRES.indexOf(SHOPS[k].desire)] + 2 - 3 * shops.filter((b) => b.kind === k).length }))
    .sort((a, b) => b.score - a.score)[0];
  if (!want || !free.length) return;
  const lot = free.slice().sort((a, b) => trafficPips(s, b) + (CITY.corner[b] ? 0.5 : 0) - (trafficPips(s, a) + (CITY.corner[a] ? 0.5 : 0)))[0];
  applyCommand(s, id, { c: 'build', tile: lot, kind: want.k });
}

/**
 * A stand-in for a player who has read the Crown breakdown (Worth + Share + Prestige): acts
 * about every five seconds, opens two shops, anchors them with a Pocket Park, draws the
 * credit line once to keep building, adds a Tram Stop, upgrades what is busy, prices a full
 * queue at Craft and fires a Promo Blitz in peak hours. Still no event timing or undercutting.
 */
function keenHuman(s: GameState, id: number, offset: number): void {
  if (s.tick < 30 + offset || (s.tick - 30 - offset) % 50 !== 0) return;
  const p = s.players[id];
  const mine = s.buildings.filter((b) => b.owner === id);
  const shops = mine.filter((b) => isShop(b.kind));
  const free = CITY.lots.filter((t) => !buildingAt(s, t));
  const lastQuarter = s.quarter >= s.totalQuarters;
  // Price a queue that is always full at Craft; fire a blitz on an idle shop at its peak.
  for (const b of shops) {
    const cap = SHOPS[b.kind as ShopKind].queueCap[b.level - 1];
    if (b.stance === 1 && b.queue.length >= cap - 1) applyCommand(s, id, { c: 'price', id: b.id, stance: 2 });
    else if (b.stance === 2 && b.queue.length === 0 && b.lost.tooPricey >= 3) applyCommand(s, id, { c: 'price', id: b.id, stance: 1 });
  }
  if (shops.length >= 2 && p.debt === 0 && p.cash < 200 && !lastQuarter) {
    applyCommand(s, id, { c: 'borrow' });
    return;
  }
  const near = (t: number, r: number): number => shops.filter((b) => chebyshev(b.tile, t) <= r).length;
  const pick = (score: (t: number) => number, ok: (t: number) => boolean = () => true): number => {
    let best = -1;
    let bs = -1e9;
    for (const t of free) {
      if (!ok(t)) continue;
      const v = score(t);
      if (v > bs) {
        bs = v;
        best = t;
      }
    }
    return best;
  };
  if (shops.length >= 2 && !mine.some((b) => b.kind === 'park') && p.cash >= CIVICS.park.cost) {
    const t = pick((x) => near(x, 1));
    if (t >= 0 && applyCommand(s, id, { c: 'build', tile: t, kind: 'park' }).ok) return;
  }
  if (shops.length >= 3 && !mine.some((b) => b.kind === 'tramstop') && p.cash >= CIVICS.tramstop.cost) {
    const t = pick((x) => near(x, 2), (x) => CITY.avenueAdj[x] >= 0);
    if (t >= 0 && applyCommand(s, id, { c: 'build', tile: t, kind: 'tramstop' }).ok) return;
  }
  if (shops.length >= 3 && !mine.some((b) => b.kind === 'plaza') && p.cash >= CIVICS.plaza.cost + 40) {
    const t = pick((x) => near(x, 2));
    if (t >= 0 && applyCommand(s, id, { c: 'build', tile: t, kind: 'plaza' }).ok) return;
  }
  const busy = shops.filter((b) => b.level < 3 && b.turned >= 3 && upgradeCost(b) <= p.cash - 40).sort((a, b) => b.turned - a.turned)[0];
  if (busy && applyCommand(s, id, { c: 'upgrade', id: busy.id }).ok) return;
  const want = SHOP_KINDS.filter((k) => SHOPS[k].cost <= p.cash - 20)
    .map((k) => ({ k, score: s.unmet[DESIRES.indexOf(SHOPS[k].desire)] + SHOPS[k].price / 8 - 4 * shops.filter((b) => b.kind === k).length }))
    .sort((a, b) => b.score - a.score)[0];
  if (want && free.length && !lastQuarter) {
    const t = pick((x) => trafficPips(s, x) + (CITY.corner[x] ? 0.6 : 0) + (CITY.canalFront[x] ? 0.4 : 0) + near(x, 2) * 0.3);
    if (t >= 0 && applyCommand(s, id, { c: 'build', tile: t, kind: want.k }).ok) return;
  }
  const idle = shops.find((b) => s.tick >= b.promoReadyAt && b.queue.length <= 1 && b.stock > 6);
  if (idle && p.cash >= 160) applyCommand(s, id, { c: 'promo', id: idle.id });
}

function blitzPvp(human: (s: GameState, id: number, offset: number) => void, label: string): void {
  console.log(`\n== BLITZ · 2 ${label} humans + 2 AI · ${seeds} seeds (opening-curve probe) ==`);
  let leadQ1 = 0;
  let contendQ1 = 0;
  let humanWins = 0;
  let podium = 0;
  const ratioQ1: number[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const ai = [PERSONAS[seed % 3], PERSONAS[(seed + 1) % 3]];
    const players: PlayerSetup[] = [
      { name: 'Human A', house: 0, kind: 'human' },
      { name: 'Human B', house: 1, kind: 'human' },
      { name: ai[0], house: 2, kind: 'ai', persona: ai[0] },
      { name: ai[1], house: 3, kind: 'ai', persona: ai[1] },
    ];
    const s = createGame({ seed: seed * 101, mode: 'blitz', players });
    let q1: number[] = [];
    while (s.phase === 'playing') {
      human(s, 0, 0);
      human(s, 1, 25);
      advance(s);
      s.fx = [];
      if (s.tick === s.quarterTicks) q1 = s.players.map((p) => crownIndex(s, p));
    }
    const fin = s.players.map((p) => crownIndex(s, p));
    const bestHumanQ1 = Math.max(q1[0], q1[1]);
    const bestAiQ1 = Math.max(q1[2], q1[3]);
    const lead = bestHumanQ1 >= bestAiQ1;
    const contend = bestHumanQ1 >= bestAiQ1 * 0.85;
    if (lead) leadQ1++;
    if (contend) contendQ1++;
    ratioQ1.push(bestHumanQ1 / Math.max(1, bestAiQ1));
    const order = fin.map((c, i) => ({ c, i })).sort((a, b) => b.c - a.c);
    if (order[0].i < 2) humanWins++;
    if (order[0].i < 2 || order[1].i < 2) podium++;
    console.log(
      `seed ${String(seed).padStart(2)}: Q1 bell  humans ${q1[0]}/${q1[1]}  ${ai[0]} ${q1[2]}  ${ai[1]} ${q1[3]}  ${lead ? 'HUMAN LEADS' : contend ? 'in contention' : 'trailing'}  | final  humans ${fin[0]}/${fin[1]}  ${ai[0]} ${fin[2]}  ${ai[1]} ${fin[3]}`,
    );
  }
  console.log(`Q1 bell: a human leads in ${leadQ1}/${seeds} seeds · best human within 15% of the leader (or ahead) in ${contendQ1}/${seeds}`);
  console.log(`Q1 bell: best human ÷ best AI Crown, mean ${avg(ratioQ1).toFixed(2)} (min ${Math.min(...ratioQ1).toFixed(2)}, max ${Math.max(...ratioQ1).toFixed(2)})`);
  console.log(`final bell: a human wins ${humanWins}/${seeds} · a human finishes top two in ${podium}/${seeds}`);
}

if (what === 'all') {
  aiOnly('standard');
  aiOnly('blitz');
  blitzPvp(casualHuman, 'casual');
  blitzPvp(keenHuman, 'Crown-aware');
} else if (what === 'pvp') {
  blitzPvp(casualHuman, 'casual');
  blitzPvp(keenHuman, 'Crown-aware');
}
else aiOnly(what as MatchMode);
