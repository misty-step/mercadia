// The Order dock's model: tabs, tools, and the lots/tiles an armed tool may target. Pure functions
// of the session view (plan + frozen world) plus the little UI context the dock keeps (armed tool,
// pending command, selected unit). Legality always comes from the shared `checkOrder`.
import { BUILD_KINDS, CIVICS, ERA_UNLOCK, LOAN_STEP, loanRateLabel, PACTS, PACT_KINDS, SHOPS, STUDIES, STUDY_COST, STUDY_KEYS, UNITS, UNIT_KINDS, isShop, lockNotice } from '../shared/constants';
import { buildCostFor, buildingAt, charterMult, currentEra, moveOf, pactBetween, tileName, unitById } from '../shared/game';
import { CITY } from '../shared/map';
import { checkOrder, reachFrom } from '../shared/orders';
import type { Order, PactKind } from '../shared/types';
import type { Armed, SessionView } from './contracts';
import { money, ROMAN } from './hud-dom';

export type TabKey = 'build' | 'units' | 'trade' | 'pacts' | 'study';
export const TABS: { key: TabKey; label: string }[] = [
  { key: 'build', label: 'Build' },
  { key: 'units', label: 'Units' },
  { key: 'trade', label: 'Trade' },
  { key: 'pacts', label: 'Pacts' },
  { key: 'study', label: 'Study' },
];

/** A tool that needs a tile pick after arming (Barge route, Harbor supply contract). */
export type Pending = { cmd: 'route'; unit: number } | { cmd: 'contract' } | null;

export interface ToolCtx {
  view: SessionView;
  armed: Armed;
  pending: Pending;
  selUnit: number;
}

export interface Tool {
  id: string;
  group: string;
  groupHouse: number;
  label: string;
  sub: string;
  icon: string;
  state: 'ok' | 'disabled' | 'locked';
  reason: string;
  lock: string;
  pressed: boolean;
  /** `tool` arms or performs the tool, `order` queues `arg` (JSON), `selunit` selects unit `arg`. */
  act: 'tool' | 'order' | 'selunit';
  arg: string;
  prog: { n: number; of: number } | null;
  creditOnly: boolean;
  hotkey: number;
  actionCost: boolean;
}

export const shortfall = (need: number, have: number): string => `Not enough § — needs ${money(need)}, have ${money(have)} projected`;
const noActions = (max: number): string => `No Actions left — ${max} of ${max} spent`;
const eraLabel = (n: number): string => `Era ${ROMAN[n - 1]}`;

const base = (id: string, label: string, icon: string): Tool => ({
  id, group: '', groupHouse: -1, label, sub: '', icon, state: 'ok', reason: '', lock: '', pressed: false,
  act: 'tool', arg: id, prog: null, creditOnly: false, hotkey: 0, actionCost: true,
});

const jsonArg = (o: Order): string => JSON.stringify(o);

// ───────────────────────────── Legal targets ─────────────────────────────

/** The most informative reason no lot accepts `kind` (cash and Rent Accords before reach). */
function lotReason(v: SessionView, kind: Parameters<typeof buildCostFor>[1]): string {
  const g = v.game;
  const plan = v.plan;
  if (!plan) return 'Planning is closed';
  const counts = new Map<string, number>();
  for (const t of CITY.lots) {
    if (buildingAt(g, t) || plan.claimed.has(t)) continue;
    const r = checkOrder(g, plan, { t: 'build', tile: t, kind });
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best = '';
  let bestN = -1;
  for (const [r, n] of counts) {
    const pri = r.startsWith('Not enough') ? 1e6 : r.startsWith('A Rent Accord') ? 5e5 : n;
    if (pri > bestN) {
      best = r;
      bestN = pri;
    }
  }
  return best || 'Every lot is taken';
}

/** Tiles the armed tool may legally target (the board draws them as its dotted legal region). */
export function legalTilesFor(v: SessionView, armed: Armed, pending: Pending): Set<number> {
  const out = new Set<number>();
  const g = v.game;
  const plan = v.plan;
  if (!plan || !armed) return out;
  if (armed.kind === 'build') {
    for (const t of CITY.lots) if (!checkOrder(g, plan, { t: 'build', tile: t, kind: armed.build })) out.add(t);
  } else if (armed.kind === 'move') {
    const u = unitById(g, armed.unit);
    if (!u) return out;
    const from = plan.tiles.get(u.id) ?? u.tile;
    for (const [t] of reachFrom(u.kind, from, moveOf(g.players[plan.seat], u.kind))) {
      if (!checkOrder(g, plan, { t: 'move', unit: u.id, to: t })) out.add(t);
    }
  } else if (armed.kind === 'contest') {
    for (const t of g.units) if (!checkOrder(g, plan, { t: 'contest', unit: armed.unit, target: t.id })) out.add(t.tile);
  } else if (armed.kind === 'tile' && pending) {
    for (const b of g.buildings) {
      if (b.owner !== plan.seat) continue;
      const o: Order = pending.cmd === 'route' ? { t: 'route', unit: pending.unit, building: b.id } : { t: 'contract', building: b.id };
      if (!checkOrder(g, plan, o)) out.add(b.tile);
    }
  }
  return out;
}

/** The order a pick on `tile` queues for the armed tool, or null when the tile holds nothing to act on. */
export function orderForPick(v: SessionView, armed: Armed, pending: Pending, tile: number): Order | null {
  const g = v.game;
  if (!armed) return null;
  if (armed.kind === 'build') return { t: 'build', tile, kind: armed.build };
  if (armed.kind === 'move') return { t: 'move', unit: armed.unit, to: tile };
  if (armed.kind === 'contest') {
    const target = g.units.find((u) => u.tile === tile && u.owner !== v.seat);
    return target ? { t: 'contest', unit: armed.unit, target: target.id } : null;
  }
  const b = buildingAt(g, tile);
  if (!b || !pending) return null;
  return pending.cmd === 'route' ? { t: 'route', unit: pending.unit, building: b.id } : { t: 'contract', building: b.id };
}

/** Why a pick on `tile` does not queue anything (shown inline). */
export function pickReason(v: SessionView, armed: Armed, pending: Pending, tile: number): string {
  const o = orderForPick(v, armed, pending, tile);
  if (!v.plan) return 'Planning is closed';
  if (o) return checkOrder(v.game, v.plan, o) ?? '';
  if (armed?.kind === 'contest') return 'Choose a rival unit';
  if (armed?.kind === 'tile') return pending?.cmd === 'route' ? 'Choose one of your canal-front shops' : 'Choose one of your shops';
  return 'Not a legal target';
}

/** One-line instruction shown while a tool is armed. */
export function armedHint(v: SessionView, armed: Armed, pending: Pending, touch: boolean): string {
  const g = v.game;
  const tap = touch ? 'Tap' : 'Click';
  if (!armed) return '';
  if (armed.kind === 'build') {
    const name = isShop(armed.build) ? SHOPS[armed.build].name : CIVICS[armed.build].name;
    return `${name} armed — ${touch ? 'tap a lot to preview, tap again to queue' : 'click a marked lot to queue it (Shift keeps the tool)'}. Esc cancels.`;
  }
  const u = 'unit' in armed ? unitById(g, armed.unit) : null;
  if (armed.kind === 'move') return `Move ${u ? UNITS[u.kind].name : 'unit'} — ${tap.toLowerCase()} a shaded tile. Esc cancels.`;
  if (armed.kind === 'contest') return `Contest — ${tap.toLowerCase()} an adjacent rival unit. Esc cancels.`;
  return pending?.cmd === 'route' ? `Barge route — ${tap.toLowerCase()} one of your canal-front shops. Esc cancels.` : `Supply contract — ${tap.toLowerCase()} one of your shops. Esc cancels.`;
}

// ───────────────────────────── Tool lists ─────────────────────────────

function applyGate(t: Tool, v: SessionView, cost: number): Tool {
  const plan = v.plan;
  if (!plan) {
    t.state = 'disabled';
    t.reason = v.ended ? 'The match is over' : 'Planning is closed';
  } else if (t.actionCost && plan.actions < 1) {
    t.state = 'disabled';
    t.reason = noActions(plan.actionsMax);
  } else if (cost > plan.cash) {
    t.state = 'disabled';
    t.reason = shortfall(cost, plan.cash);
  }
  return t;
}

function buildTools(v: SessionView, ctx: ToolCtx): Tool[] {
  const g = v.game;
  const era = currentEra(g);
  const p = g.players[v.seat];
  return [...BUILD_KINDS].sort((a, b) => ERA_UNLOCK[a] - ERA_UNLOCK[b]).map((kind) => {
    const shop = isShop(kind);
    const name = shop ? SHOPS[kind].name : CIVICS[kind].name;
    const t = base(`build:${kind}`, name, kind);
    const cost = p ? buildCostFor(p, kind) : 0;
    t.sub = money(cost);
    t.pressed = ctx.armed?.kind === 'build' && ctx.armed.build === kind;
    if (ERA_UNLOCK[kind] > era) {
      t.state = 'locked';
      t.lock = eraLabel(ERA_UNLOCK[kind]);
      t.reason = lockNotice(kind);
      return t;
    }
    applyGate(t, v, cost);
    if (t.state === 'ok' && v.plan) {
      const any = CITY.lots.some((lot) => !checkOrder(g, v.plan!, { t: 'build', tile: lot, kind }));
      if (!any) {
        t.state = 'disabled';
        t.reason = lotReason(v, kind);
      }
    }
    return t;
  });
}

function unitTools(v: SessionView, ctx: ToolCtx): Tool[] {
  const g = v.game;
  const era = currentEra(g);
  const plan = v.plan;
  const out: Tool[] = [];
  for (const kind of UNIT_KINDS) {
    const def = UNITS[kind];
    const t = base(`recruit:${kind}`, def.name, kind);
    t.act = 'order';
    t.arg = jsonArg({ t: 'recruit', kind });
    t.sub = money(def.cost);
    if (def.era > era) {
      t.state = 'locked';
      t.lock = eraLabel(def.era);
      t.reason = `${def.name} unlocks in ${eraLabel(def.era)}`;
    } else if (!plan) {
      t.state = 'disabled';
      t.reason = 'Planning is closed';
    } else {
      const why = checkOrder(g, plan, { t: 'recruit', kind });
      if (why) {
        t.state = 'disabled';
        t.reason = why;
      }
    }
    out.push(t);
  }
  const sel = ctx.selUnit ? unitById(g, ctx.selUnit) : undefined;
  const mine = !!sel && sel.owner === v.seat;
  const move = base('move', 'Move', 'move');
  move.sub = mine ? `${UNITS[sel!.kind].name}` : 'Select a unit';
  move.pressed = ctx.armed?.kind === 'move';
  if (!plan) {
    move.state = 'disabled';
    move.reason = 'Planning is closed';
  } else if (!mine) {
    move.state = 'disabled';
    move.reason = 'Select one of your units first (click it on the board or in Your units)';
  } else if (plan.actions < 1) {
    move.state = 'disabled';
    move.reason = noActions(plan.actionsMax);
  } else if (plan.moved.has(sel!.id)) {
    move.state = 'disabled';
    move.reason = 'Each unit accepts one movement order per turn';
  }
  out.push(move);
  const contest = base('contest', 'Contest', 'contest');
  contest.sub = mine && sel!.kind === 'watch' ? 'Watch Company' : 'Select a Watch';
  contest.pressed = ctx.armed?.kind === 'contest';
  if (!plan) {
    contest.state = 'disabled';
    contest.reason = 'Planning is closed';
  } else if (!mine || sel!.kind !== 'watch') {
    contest.state = 'disabled';
    contest.reason = 'Select one of your Watch Companies first';
  } else if (plan.actions < 1) {
    contest.state = 'disabled';
    contest.reason = noActions(plan.actionsMax);
  } else if (plan.contested.has(sel!.id)) {
    contest.state = 'disabled';
    contest.reason = 'Each Watch Company issues one Contest per turn';
  }
  out.push(contest);
  for (const u of g.units) {
    if (u.owner !== v.seat) continue;
    const t = base(`unit:${u.id}`, UNITS[u.kind].name, u.kind);
    t.group = 'Your units';
    t.act = 'selunit';
    t.arg = String(u.id);
    t.actionCost = false;
    const at = plan?.tiles.get(u.id) ?? u.tile;
    t.sub = `${tileName(at)}${plan?.moved.has(u.id) ? ' · moving' : ''}`;
    t.pressed = ctx.selUnit === u.id;
    out.push(t);
  }
  return out;
}

function tradeTools(v: SessionView, ctx: ToolCtx): Tool[] {
  const g = v.game;
  const plan = v.plan;
  const out: Tool[] = [];
  // Barge route: the selected Barge, else the first Barge without a route order this turn.
  const barges = g.units.filter((u) => u.owner === v.seat && u.kind === 'barge');
  const route = base('route', 'Barge route', 'route');
  route.pressed = ctx.armed?.kind === 'tile' && ctx.pending?.cmd === 'route';
  if (!plan) {
    route.state = 'disabled';
    route.reason = 'Planning is closed';
  } else if (barges.length === 0) {
    route.state = 'disabled';
    route.reason = 'Recruit a Barge first (Barges unlock in Era II)';
    route.sub = 'No Barge';
  } else {
    const pick = barges.find((b) => b.id === ctx.selUnit) ?? barges.find((b) => !plan.touched.has(`route:${b.id}`)) ?? barges[0];
    const shops = g.buildings.filter((b) => b.owner === v.seat && isShop(b.kind));
    const okShop = shops.some((b) => !checkOrder(g, plan, { t: 'route', unit: pick.id, building: b.id }));
    route.sub = `Barge #${pick.id}`;
    route.arg = `route:${pick.id}`;
    if (plan.actions < 1) {
      route.state = 'disabled';
      route.reason = noActions(plan.actionsMax);
    } else if (!okShop) {
      route.state = 'disabled';
      const first = shops[0];
      route.reason = (first && checkOrder(g, plan, { t: 'route', unit: pick.id, building: first.id })) || 'Only canal-front shops can take a Barge route';
    }
  }
  out.push(route);
  const contract = base('contract', 'Harbor contract', 'contract');
  contract.pressed = ctx.armed?.kind === 'tile' && ctx.pending?.cmd === 'contract';
  if (!plan) {
    contract.state = 'disabled';
    contract.reason = 'Planning is closed';
  } else {
    const shops = g.buildings.filter((b) => b.owner === v.seat && isShop(b.kind));
    const ok = shops.some((b) => !checkOrder(g, plan, { t: 'contract', building: b.id }));
    contract.sub = 'Supplies, 4 turns';
    if (plan.actions < 1) {
      contract.state = 'disabled';
      contract.reason = noActions(plan.actionsMax);
    } else if (!ok) {
      contract.state = 'disabled';
      contract.reason = shops.length === 0 ? 'Build a shop first' : checkOrder(g, plan, { t: 'contract', building: shops[0].id }) || 'No shop can take a contract';
    }
  }
  out.push(contract);
  for (const kind of ['borrow', 'repay'] as const) {
    const t = base(kind, kind === 'borrow' ? `Borrow ${money(LOAN_STEP)}` : `Repay ${money(LOAN_STEP)}`, kind);
    t.act = 'order';
    t.arg = jsonArg({ t: kind });
    t.creditOnly = true;
    t.sub = kind === 'borrow' ? loanRateLabel(charterMult(g.players[v.seat], 'interest')) : `Debt ${money(v.plan?.debt ?? 0)}`;
    if (!plan) {
      t.state = 'disabled';
      t.reason = 'Planning is closed';
    } else {
      const why = checkOrder(g, plan, { t: kind });
      if (why) {
        t.state = 'disabled';
        t.reason = why;
      }
    }
    out.push(t);
  }
  return out;
}

function pactTools(v: SessionView): Tool[] {
  const g = v.game;
  const plan = v.plan;
  const out: Tool[] = [];
  if (v.seat < 0) return out;
  for (const q of g.proposals) {
    if (q.to !== v.seat || q.turn >= g.turn) continue;
    if (plan?.touched.has(`resp:${q.id}`)) continue;
    const from = g.players[q.from];
    for (const accept of [true, false]) {
      const t = base(`resp:${q.id}:${accept ? 'yes' : 'no'}`, `${accept ? 'Accept' : 'Decline'} ${PACTS[q.kind].name}`, accept ? 'check' : 'close');
      t.group = `${from?.name ?? 'A rival'} proposes`;
      t.groupHouse = from?.house ?? -1;
      t.act = 'order';
      t.arg = jsonArg({ t: 'respond', proposal: q.id, accept });
      t.sub = `${PACTS[q.kind].turns} turns`;
      if (!plan) {
        t.state = 'disabled';
        t.reason = 'Planning is closed';
      } else {
        const why = checkOrder(g, plan, { t: 'respond', proposal: q.id, accept });
        if (why) {
          t.state = 'disabled';
          t.reason = why;
        }
      }
      out.push(t);
    }
  }
  for (const rival of g.players) {
    if (rival.id === v.seat) continue;
    for (const kind of PACT_KINDS as PactKind[]) {
      const def = PACTS[kind];
      const t = base(`propose:${rival.id}:${kind}`, def.name, kind === 'truce' ? 'truce' : kind === 'trade' ? 'trade' : 'rent');
      t.group = rival.name;
      t.groupHouse = rival.house;
      t.act = 'order';
      t.arg = jsonArg({ t: 'propose', to: rival.id, kind });
      t.sub = `${def.turns} turns`;
      if (!plan) {
        t.state = 'disabled';
        t.reason = 'Planning is closed';
      } else {
        const why = checkOrder(g, plan, { t: 'propose', to: rival.id, kind });
        if (why) {
          t.state = 'disabled';
          t.reason = why;
          const inForce = g.pacts.find((x) => x.kind === kind && pactBetween(g, v.seat, rival.id, kind));
          if (inForce) t.sub = `to Turn ${inForce.to}`;
          else if (why.startsWith('Already proposed') || why.startsWith('A proposal')) t.sub = 'Proposed';
        }
      }
      out.push(t);
    }
  }
  return out;
}

function studyTools(v: SessionView): Tool[] {
  const g = v.game;
  const plan = v.plan;
  const p = g.players[v.seat];
  const era = currentEra(g);
  return STUDY_KEYS.map((key) => {
    const def = STUDIES[key];
    const t = base(`study:${key}`, def.name, 'study');
    t.act = 'order';
    t.arg = jsonArg({ t: 'study', key });
    const done = !!p && p.studies.includes(key);
    const inProgress = !!p && p.study === key;
    const pts = inProgress ? p.studyPoints + (plan?.study === key ? 1 : 0) : plan?.study === key ? 1 : 0;
    t.prog = { n: done ? def.points : Math.min(def.points, pts), of: def.points };
    t.sub = done ? 'Complete' : `${t.prog.n} of ${def.points} · ${money(STUDY_COST)}`;
    if (def.era > era) {
      t.state = 'locked';
      t.lock = eraLabel(def.era);
      t.reason = `${def.name} unlocks in ${eraLabel(def.era)}`;
    } else if (!plan) {
      t.state = 'disabled';
      t.reason = 'Planning is closed';
    } else {
      const why = checkOrder(g, plan, { t: 'study', key });
      if (why) {
        t.state = 'disabled';
        t.reason = why;
      }
    }
    t.pressed = inProgress && !done;
    return t;
  });
}

/** The tools of one dock tab, with one-nine hotkeys assigned in order. */
export function toolsFor(tab: TabKey, ctx: ToolCtx): Tool[] {
  const v = ctx.view;
  let list: Tool[];
  if (tab === 'build') list = buildTools(v, ctx);
  else if (tab === 'units') list = unitTools(v, ctx);
  else if (tab === 'trade') list = tradeTools(v, ctx);
  else if (tab === 'pacts') list = pactTools(v);
  else list = studyTools(v);
  let n = 0;
  for (const t of list) {
    if (t.creditOnly || t.act === 'selunit') continue;
    n++;
    if (n <= 9) t.hotkey = n;
  }
  return list;
}
