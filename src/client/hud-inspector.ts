// The Inspector drawer: lot, shop, civic, unit and (through "who came / who was lost") citizen
// detail. It leads with a one-line diagnosis, then public facts, then the orders available for
// the selection. Pure HTML-string builders: every dynamic value is escaped.
import {
  ARCHETYPES,
  ARCHS,
  AUTO_RESTOCK_AT,
  CIVICS,
  CORNER_PULL,
  CANAL_APPEAL,
  CANAL_APPEAL_BISTRO,
  DAY_DEMAND,
  DAYPART_NAMES,
  DESIRES,
  ERA_UNLOCK,
  PARK_AURA,
  PLAZA_AURA,
  PLAZA_RADIUS,
  PARK_RADIUS,
  SHOPS,
  STANCES,
  TRANSIT_PULL,
  TRANSIT_RADIUS,
  UNITS,
  BUILD_KINDS,
  auraRadius,
  buildName,
  isCivic,
  isShop,
  lockNotice,
} from '../shared/constants';
import {
  buildCostFor,
  buildingAt,
  buildingById,
  contractCostFor,
  currentEra,
  daypartOf,
  maxCohesion,
  moveOf,
  promoCostFor,
  restockCostFor,
  tileName,
  unitById,
  upgradeCostFor,
} from '../shared/game';
import { CITY, chebyshev } from '../shared/map';
import { checkOrder, contestPreview } from '../shared/orders';
import type { Building, Game, LostDemand, Order, Unit } from '../shared/types';
import type { SessionView } from './contracts';
import { crestSvg } from './heraldry';
import { esc, money } from './hud-dom';
import { ic } from './hud-icons';

export interface Diagnosis {
  /** The one-line lead. */
  lead: string;
  tone: 'good' | 'warn' | 'info';
  /** Further findings, most relevant first. */
  more: string[];
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "Lost: 7 too pricey · 4 queue full" (only non-zero reasons), or ''. */
export function lostLine(l: LostDemand): string {
  const parts: string[] = [];
  if (l.tooPricey) parts.push(`${l.tooPricey} too pricey`);
  if (l.queueFull) parts.push(`${l.queueFull} queue full`);
  if (l.outOfStock) parts.push(`${l.outOfStock} out of stock`);
  if (l.blockaded) parts.push(`${l.blockaded} blockaded`);
  return parts.length ? `Lost: ${parts.join(' · ')}` : '';
}
const lostTotal = (l: LostDemand): number => l.tooPricey + l.queueFull + l.outOfStock + l.blockaded;

/** Why a shop did what it did last turn, from its public last-turn record. */
export function diagnose(g: Game, b: Building): Diagnosis {
  const def = SHOPS[b.kind as keyof typeof SHOPS];
  const more: string[] = [];
  if (!def) return { lead: 'Civic project', tone: 'info', more };
  const lost = b.lastLost;
  const total = lostTotal(lost);
  const cheaper = g.buildings.filter((o) => o.owner !== b.owner && o.kind === b.kind && chebyshev(o.tile, b.tile) <= 3 && o.stance < b.stance).length;
  const undercut = cheaper > 0 ? `Undercut — ${plural(cheaper, 'cheaper rival')} ${def.name} nearby` : '';
  const dem = DAY_DEMAND[def.desire];
  const peak = dem.indexOf(Math.max(...dem));
  const prevPart = daypartOf(Math.max(1, g.turn - 1));
  const offPeak = g.turn > 1 && dem[prevPart] < dem[peak] * 0.5 ? `Off-peak — ${cap(def.desire)} peaks in ${DAYPART_NAMES[peak]}` : '';
  const lowStock = b.stock > 0 && b.stock <= Math.ceil(def.stockMax * AUTO_RESTOCK_AT) ? `Low stock — ${b.stock} of ${def.stockMax} left` : '';
  const blockade = lost.blockaded > 0 ? `Blockaded — a rival Watch Company halved your frontage` : '';

  let lead = '';
  let tone: Diagnosis['tone'] = 'info';
  if (b.stock === 0 && lost.outOfStock > 0) {
    lead = `Out of stock — ${plural(lost.outOfStock, 'citizen')} left empty-handed`;
    tone = 'warn';
  } else if (lost.tooPricey > 0 && undercut) {
    lead = undercut;
    tone = 'warn';
  } else if (blockade) {
    lead = blockade;
    tone = 'warn';
  } else if (total > 0) {
    lead = lostLine(lost);
    tone = 'warn';
  } else if (offPeak && b.lastServed < 4) {
    lead = offPeak;
  } else if (b.lastServed > 0) {
    lead = `Healthy — served ${b.lastServed}, sales ${money(b.lastSales)} last turn`;
    tone = 'good';
  } else if (b.builtTurn >= g.turn - 1 && b.builtTurn > 0) {
    lead = 'Newly opened — no footfall recorded yet';
  } else {
    lead = 'No footfall last turn';
    tone = 'warn';
  }
  for (const m of [lostLine(lost), undercut, blockade, offPeak, lowStock]) if (m && m !== lead) more.push(m);
  return { lead, tone, more };
}

/** Who came last turn: "Commuter 4 · Local 3". */
export function cameLine(b: Building): string {
  const parts: string[] = [];
  ARCHETYPES.forEach((a, i) => {
    const n = b.lastArch[i] ?? 0;
    if (n > 0) parts.push(`${ARCHS[a].name} ${n}`);
  });
  return parts.join(' · ');
}

const kv = (k: string, v: string, mono = true): string => `<div class="kv"><dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ''}>${v}</dd></div>`;

/** An order button row: the button, plus the reason when the order is not available. */
function orderRow(v: SessionView, label: string, order: Order, o: { sub?: string; icon?: string; pressed?: boolean; key?: string } = {}): string {
  const why = v.plan ? checkOrder(v.game, v.plan, order) : v.ended ? 'The match is over' : 'Planning is closed';
  const key = o.key ?? `ob:${label}`;
  return `<div class="arow" data-k="${esc(key)}"><button type="button" class="act${o.pressed ? ' on' : ''}" data-act="order" data-arg="${esc(JSON.stringify(order))}"${o.pressed !== undefined ? ` aria-pressed="${o.pressed}"` : ''}${
    why ? ` aria-disabled="true" data-reason="${esc(why)}"` : ''
  }>${o.icon ? ic(o.icon) : ''}<span class="t">${esc(label)}</span>${o.sub ? `<span class="s mono">${esc(o.sub)}</span>` : ''}</button>${why ? `<span class="why">${esc(why)}</span>` : ''}</div>`;
}

function toolRow(label: string, arg: string, why: string, icon: string, sub = '', pressed = false): string {
  return `<div class="arow" data-k="tr:${esc(arg)}"><button type="button" class="act${pressed ? ' on' : ''}" data-act="tool" data-arg="${esc(arg)}" aria-pressed="${pressed}"${why ? ` aria-disabled="true" data-reason="${esc(why)}"` : ''}>${ic(icon)}<span class="t">${esc(label)}</span>${sub ? `<span class="s mono">${esc(sub)}</span>` : ''}</button>${why ? `<span class="why">${esc(why)}</span>` : ''}</div>`;
}

function ownerLine(v: SessionView, owner: number): string {
  const p = v.game.players[owner];
  if (!p) return '';
  return `${crestSvg(p.house, { quiet: true, cls: 'sm' })}<span>${esc(p.name)}${owner === v.seat ? ' (you)' : ''}</span>`;
}

// ───────────────────────────── Lots ─────────────────────────────

export interface LotBonus {
  key: 'corner' | 'canal' | 'transit' | 'aura';
  label: string;
  detail: string;
}

/** The lot bonuses the board marks with dots, plus civic auras covering the lot. */
export function lotBonuses(g: Game, tile: number): LotBonus[] {
  const out: LotBonus[] = [];
  if (CITY.corner[tile]) out.push({ key: 'corner', label: 'Corner', detail: `+${Math.round((CORNER_PULL - 1) * 100)}% pull — streets on two sides` });
  if (CITY.canalFront[tile]) out.push({ key: 'canal', label: 'Canal-front', detail: `+${Math.round((CANAL_APPEAL - 1) * 100)}% appeal, Bistro +${Math.round((CANAL_APPEAL_BISTRO - 1) * 100)}%` });
  const stops = [...CITY.fixedStops, ...g.buildings.filter((b) => b.kind === 'tramstop').map((b) => b.tile)];
  if (stops.some((s) => chebyshev(s, tile) <= TRANSIT_RADIUS)) out.push({ key: 'transit', label: 'Transit', detail: `Tram Stop within ${TRANSIT_RADIUS} tiles, +${Math.round((TRANSIT_PULL - 1) * 100)}% commuters` });
  const auras = g.buildings.filter((b) => auraRadius(b.kind) > 0 && chebyshev(b.tile, tile) <= auraRadius(b.kind));
  if (auras.length) out.push({ key: 'aura', label: 'Civic reach', detail: `${auras.map((a) => buildName(a.kind)).join(', ')} nearby` });
  return out;
}

function footfallHints(g: Game, tile: number): string[] {
  const hints: string[] = [];
  if (CITY.avenueAdj[tile] >= 0) hints.push('Avenue frontage');
  if (chebyshev(CITY.stationDoor, tile) <= 3) hints.push('Near Grand Station');
  if (chebyshev(CITY.pierTile, tile) <= 3) hints.push('Near the Harbor Pier');
  const part = daypartOf(g.turn);
  const lead = DESIRES.map((d) => ({ d, w: DAY_DEMAND[d][part] }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 2)
    .map((x) => cap(x.d));
  hints.push(`Turn ${g.turn} is ${DAYPART_NAMES[part]} — ${lead.join(' and ')} lead demand`);
  return hints;
}

function lotBody(v: SessionView, tile: number): { title: string; sub: string; body: string; crest: number } {
  const g = v.game;
  const bonuses = lotBonuses(g, tile);
  const dots = bonuses
    .map((b) => `<li class="bonus"><span class="bd bd-${b.key}" aria-hidden="true"></span><span class="bn">${esc(b.label)}</span><span class="bt">${esc(b.detail)}</span></li>`)
    .join('');
  const queued = v.plan?.claimed.has(tile) ? g.players[v.seat] && v.draft.find((o) => o.t === 'build' && o.tile === tile) : null;
  let build = '';
  if (queued && queued.t === 'build') build = `<p class="note">Queued: ${esc(buildName(queued.kind))} — see Orders.</p>`;
  else if (v.seat >= 0) {
    const era = currentEra(g);
    const p = g.players[v.seat];
    build = `<h3 class="sec">Build here</h3><div class="grid-b">${BUILD_KINDS.map((kind) => {
      const locked = ERA_UNLOCK[kind] > era;
      const order: Order = { t: 'build', tile, kind };
      const why = locked ? lockNotice(kind) : v.plan ? checkOrder(g, v.plan, order) : 'Planning is closed';
      return `<button type="button" class="act cell" data-k="bh:${kind}" data-act="order" data-arg="${esc(JSON.stringify(order))}"${why ? ` aria-disabled="true" data-reason="${esc(why)}"` : ''}>${ic(kind)}<span class="t">${esc(buildName(kind))}</span><span class="s mono">${locked ? `Era ${['I', 'II', 'III', 'IV'][ERA_UNLOCK[kind] - 1]}` : money(buildCostFor(p, kind))}</span></button>`;
    }).join('')}</div>`;
    const first = BUILD_KINDS.map((k) => (ERA_UNLOCK[k] <= era && v.plan ? checkOrder(g, v.plan, { t: 'build', tile, kind: k }) : null));
    if (first.every((x) => x)) build += `<p class="why-all">${esc(first.find((x) => x) ?? '')}</p>`;
  }
  const body = `<p class="diag info"><span class="rule"></span>Vacant lot — ${bonuses.length ? bonuses.map((b) => b.label).join(' · ') : 'no bonuses'}</p>
    <ul class="bonuses">${dots || '<li class="bonus"><span class="bt">No lot bonuses here.</span></li>'}</ul>
    <h3 class="sec">Footfall</h3><ul class="hints">${footfallHints(g, tile).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>${build}`;
  return { title: 'Vacant lot', sub: tileName(tile), body, crest: -1 };
}

// ───────────────────────────── Buildings ─────────────────────────────

function shopBody(v: SessionView, b: Building): { title: string; sub: string; body: string; crest: number } {
  const g = v.game;
  const def = SHOPS[b.kind as keyof typeof SHOPS];
  const own = b.owner === v.seat;
  const p = g.players[b.owner];
  const d = diagnose(g, b);
  const plan = v.plan;
  const stance = own ? plan?.stance.get(b.id) ?? b.stance : b.stance;
  const auto = own ? plan?.auto.get(b.id) ?? b.auto : b.auto;
  const came = cameLine(b);
  const lost = lostLine(b.lastLost);
  const rows = [
    kv('Last turn', `Served ${b.lastServed} · sales ${money(b.lastSales)}`),
    kv('Level', `${b.level} of 3`),
    kv('Stock', `${b.stock} / ${def.stockMax}`),
    kv('Price', `${STANCES[b.stance].name} ${STANCES[b.stance].label}`),
  ];
  if (b.promoUntil >= g.turn) rows.push(kv('Promo Blitz', `through Turn ${b.promoUntil}`));
  if (b.contractUntil >= g.turn) rows.push(kv('Supply contract', `through Turn ${b.contractUntil}`));
  if (b.auto) rows.push(kv('Auto-restock', 'on'));
  const facts = `<dl class="facts">${rows.join('')}</dl>`;
  const who = `<div class="who">${came ? `<p><span class="lab">Came</span> ${esc(came)}</p>` : '<p><span class="lab">Came</span> nobody last turn</p>'}${lost ? `<p class="lost"><span class="lab">Lost</span> ${esc(lost.replace(/^Lost: /, ''))}</p>` : ''}</div>`;
  const more = d.more.filter((m) => m !== lost);
  const alsoList = more.length ? `<ul class="hints">${more.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '';
  let actions = '';
  if (own && p) {
    const stanceBtns = STANCES.map((s, i) => {
      const order: Order = { t: 'stance', building: b.id, stance: i };
      const why = plan ? (stance === i ? '' : checkOrder(g, plan, order) ?? '') : 'Planning is closed';
      return `<button type="button" class="seg${stance === i ? ' on' : ''}" data-k="st:${i}" data-act="order" data-arg="${esc(JSON.stringify(order))}" aria-pressed="${stance === i}"${why ? ` aria-disabled="true" data-reason="${esc(why)}"` : ''}><span class="t">${s.name}</span><span class="s mono">${s.label}</span></button>`;
    }).join('');
    const stanceWhy = plan && plan.actions < 1 ? `<p class="why-all">No Actions left — ${plan.actionsMax} of ${plan.actionsMax} spent</p>` : '';
    actions = `<h3 class="sec">Orders</h3>
      <div class="seggroup" role="group" aria-label="Price stance">${stanceBtns}</div>${stanceWhy}
      ${orderRow(v, 'Restock', { t: 'restock', building: b.id }, { icon: 'restock', sub: money(restockCostFor(g, p, b)) })}
      ${orderRow(v, auto ? 'Auto-restock on' : 'Auto-restock off', { t: 'auto', building: b.id, on: !auto }, { icon: 'auto', pressed: auto, sub: auto ? 'turn off' : 'turn on' })}
      ${orderRow(v, 'Promo Blitz', { t: 'promo', building: b.id }, { icon: 'promo', sub: money(promoCostFor(p)) })}
      ${orderRow(v, `Upgrade to Level ${Math.min(3, b.level + 1)}`, { t: 'upgrade', building: b.id }, { icon: 'upgrade', sub: b.level >= 3 ? 'max' : money(upgradeCostFor(p, b)) })}
      ${orderRow(v, 'Harbor supply contract', { t: 'contract', building: b.id }, { icon: 'contract', sub: money(contractCostFor(p, b)) })}
      ${CITY.canalFront[b.tile] ? barge(v, b) : ''}
      ${orderRow(v, 'Sell', { t: 'sell', building: b.id }, { icon: 'sell', sub: `60% of ${money(b.invested)}` })}`;
  }
  const level = `Level ${b.level}`;
  return {
    title: `${def.name}`,
    sub: `${tileName(b.tile)} · ${level}`,
    crest: b.owner,
    body: `<p class="diag ${d.tone}"><span class="rule"></span>${esc(d.lead)}</p>${who}${alsoList}${facts}<p class="note owner">${ownerLine(v, b.owner)}</p>${actions}`,
  };
}

function barge(v: SessionView, b: Building): string {
  const g = v.game;
  const barges = g.units.filter((u) => u.owner === v.seat && u.kind === 'barge');
  if (barges.length === 0) return toolRow('Barge route', `route:0`, 'Recruit a Barge first (Barges unlock in Era II)', 'route');
  const pick = barges.find((u) => !v.plan?.touched.has(`route:${u.id}`)) ?? barges[0];
  const order: Order = { t: 'route', unit: pick.id, building: b.id };
  return orderRow(v, `Barge #${pick.id} supplies here`, order, { icon: 'route', key: 'barge-here' });
}

function civicBody(v: SessionView, b: Building): { title: string; sub: string; body: string; crest: number } {
  const g = v.game;
  const def = CIVICS[b.kind as keyof typeof CIVICS];
  const own = b.owner === v.seat;
  const rows: string[] = [kv('Prestige', `+${def.prestige}`), kv('Upkeep', `${money(def.rent)} per payroll`)];
  let lead = '';
  if (b.kind === 'tramstop') {
    rows.push(kv('Riders delivered', String(b.lastRiders)));
    lead = b.lastRiders > 0 ? `Delivering ${plural(b.lastRiders, 'rider')} to the block` : 'No riders delivered last turn';
  } else {
    rows.push(kv('Nearby shops boosted', String(b.lastBoosted)), kv('Boosted sales', money(b.lastBoostedSales)));
    const aura = b.kind === 'park' ? PARK_AURA : PLAZA_AURA;
    lead = b.lastBoosted > 0 ? `Boosting ${plural(b.lastBoosted, 'shop')} by ${Math.round(aura * 100)}% appeal` : 'No shops in reach yet';
    rows.push(kv('Reach', `${b.kind === 'park' ? PARK_RADIUS : PLAZA_RADIUS} tiles`));
  }
  const p = g.players[b.owner];
  const actions = own && p ? `<h3 class="sec">Orders</h3>${orderRow(v, 'Sell', { t: 'sell', building: b.id }, { icon: 'sell', sub: `60% of ${money(b.invested)}` })}` : '';
  return {
    title: def.name,
    sub: tileName(b.tile),
    crest: b.owner,
    body: `<p class="diag ${b.lastBoosted > 0 || b.lastRiders > 0 ? 'good' : 'info'}"><span class="rule"></span>${esc(lead)}</p><p class="note">${esc(def.blurb)}</p><dl class="facts">${rows.join('')}</dl><p class="note owner">${ownerLine(v, b.owner)}</p>${actions}`,
  };
}

// ───────────────────────────── Units ─────────────────────────────

function unitBody(v: SessionView, u: Unit): { title: string; sub: string; body: string; crest: number } {
  const g = v.game;
  const def = UNITS[u.kind];
  const owner = g.players[u.owner];
  const own = u.owner === v.seat;
  const max = owner ? maxCohesion(owner, u.kind) : def.cohesion;
  const at = own ? v.plan?.tiles.get(u.id) ?? u.tile : u.tile;
  const rows = [
    kv('Cohesion', `${u.cohesion} of ${max}`),
    kv('Strength', String(def.strength)),
    kv('Moves', `${owner ? moveOf(owner, u.kind) : def.move} tiles`),
    kv('Stands on', tileName(u.tile)),
  ];
  if (u.kind === 'barge') {
    const b = u.route ? buildingById(g, u.route) : undefined;
    rows.push(kv('Route', b ? `supplies ${tileName(b.tile)}` : 'none'));
  }
  let lead = def.role;
  const planned = v.draft.filter((o) => (o.t === 'move' && o.unit === u.id) || (o.t === 'contest' && o.unit === u.id));
  let actions = '';
  if (own && owner) {
    if (planned.length) lead = planned.map((o) => (o.t === 'move' ? `Ordered to ${tileName(o.to)}` : 'Contest ordered')).join(' · ');
    const plan = v.plan;
    const moveWhy = !plan ? 'Planning is closed' : plan.actions < 1 ? `No Actions left — ${plan.actionsMax} of ${plan.actionsMax} spent` : plan.moved.has(u.id) ? 'Each unit accepts one movement order per turn' : '';
    actions = `<h3 class="sec">Orders</h3>${toolRow('Move', 'move', moveWhy, 'move', `${moveOf(owner, u.kind)} tiles`)}`;
    if (u.kind === 'watch') {
      const why = !plan ? 'Planning is closed' : plan.actions < 1 ? `No Actions left — ${plan.actionsMax} of ${plan.actionsMax} spent` : plan.contested.has(u.id) ? 'Each Watch Company issues one Contest per turn' : '';
      actions += toolRow('Contest', 'contest', why, 'contest', 'adjacent rival');
    }
    if (u.kind === 'barge') actions += toolRow('Barge route', `route:${u.id}`, '', 'route', 'canal-front shop');
  } else if (v.seat >= 0) {
    const mine = g.units.find((x) => x.owner === v.seat && x.kind === 'watch' && v.plan && !checkOrder(g, v.plan, { t: 'contest', unit: x.id, target: u.id }));
    const anyWatch = g.units.find((x) => x.owner === v.seat && x.kind === 'watch');
    if (anyWatch) {
      const order: Order = { t: 'contest', unit: anyWatch.id, target: u.id };
      const prev = contestPreview(g, anyWatch, u);
      actions = `<h3 class="sec">Orders</h3>${orderRow(v, `Contest with Watch #${(mine ?? anyWatch).id}`, { ...order, unit: (mine ?? anyWatch).id }, { icon: 'contest', sub: `deal ${prev.deal}, take ${prev.back}`, key: 'contest-with' })}`;
    }
  }
  return {
    title: def.name,
    sub: `${tileName(at)}${own ? '' : ''}`,
    crest: u.owner,
    body: `<p class="diag info"><span class="rule"></span>${esc(lead)}</p><dl class="facts">${rows.join('')}</dl><p class="note owner">${ownerLine(v, u.owner)}</p>${actions}`,
  };
}

// ───────────────────────────── Other tiles ─────────────────────────────

const TILE_NOTE: Record<string, { name: string; note: string; icon: string }> = {
  avenue: { name: 'Streetcar Avenue', note: 'The tram loop. Units may stand and pass here; no building.', icon: 'street' },
  avbridge: { name: 'Avenue bridge', note: 'Carries the tram loop over the canal. Barges pass beneath.', icon: 'street' },
  lane: { name: 'Pedestrian lane', note: 'Citizens walk here; units may stand on it.', icon: 'street' },
  bridge: { name: 'Stone footbridge', note: 'An arched bridge: a defender here gains +1 Strength.', icon: 'street' },
  canal: { name: 'Grand Canal', note: 'Water: only Barges stand here.', icon: 'water' },
  home: { name: 'Townhouse', note: 'Citizens set out from here each turn.', icon: 'home' },
  station: { name: 'Grand Station', note: 'Commuters and tourists arrive here.', icon: 'station' },
  garden: { name: 'Garden', note: 'Fixed greenery.', icon: 'garden' },
};

function plainBody(tile: number): { title: string; sub: string; body: string; crest: number } {
  const n = TILE_NOTE[CITY.tiles[tile]] ?? { name: 'Tile', note: '', icon: 'lot' };
  return { title: n.name, sub: tileName(tile), crest: -1, body: `<p class="diag info"><span class="rule"></span>${esc(n.note)}</p>` };
}

// ───────────────────────────── Entry ─────────────────────────────

export interface InspectorModel {
  title: string;
  sub: string;
  crest: number;
  body: string;
}

/** The Inspector for a selected tile (and the unit on it, if any). */
export function inspectorModel(v: SessionView, tile: number, unitId: number): InspectorModel {
  const g = v.game;
  const u = unitId ? unitById(g, unitId) : g.units.find((x) => x.tile === tile);
  if (u) return unitBody(v, u);
  const b = buildingAt(g, tile);
  if (b) return isShop(b.kind) ? shopBody(v, b) : isCivic(b.kind) ? civicBody(v, b) : plainBody(tile);
  if (CITY.tiles[tile] === 'lot') return lotBody(v, tile);
  return plainBody(tile);
}
