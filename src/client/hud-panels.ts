// HUD surfaces as HTML-string builders: Turn plate, Status line, Leaderboard, Chronicle, Founding
// Guide, Command rail (Treasury, Order dock, End Turn) and the Orders queue. Every dynamic value is
// escaped; interactivity is data-act attributes handled by delegation in hud.ts.
import {
  ERAS,
  EVENTS,
  HOUSES,
  MILESTONES,
  DAYPART_NAMES,
  LOAN_STEP,
  loanRateLabel,
} from '../shared/constants';
import { charterMult, daypartOf, eraOfTurn, eraTurns, tileName, turnInEra } from '../shared/game';
import { describeOrder } from '../shared/orders';
import type { Dispatch, DispatchCat, Player } from '../shared/types';
import type { SessionView } from './contracts';
import { crestSvg, starPips } from './heraldry';
import { esc, money } from './hud-dom';
import { ic } from './hud-icons';
import { TABS, type TabKey, type Tool } from './hud-tools';

/** Solo and hotseat hold the canonical log locally; a room downloads it from the authority. Spectators may export too (it is public). */
export function exportable(v: SessionView): boolean {
  return v.summaries.length > 0 || !!v.summary;
}

export function exportBtnHtml(cls: string): string {
  return `<button type="button" class="more ${cls}" data-act="export" aria-label="Export match">${ic('export')}<span>Export match</span></button>`;
}

// ───────────────────────────── Turn plate ─────────────────────────────

export function plateHtml(v: SessionView, o: { deltaOpen: boolean; muted: boolean; hasDelta: boolean; canExport?: boolean }): string {
  const g = v.game;
  const era = ERAS[eraOfTurn(g, g.turn) - 1];
  const part = DAYPART_NAMES[daypartOf(g.turn)];
  const inEra = turnInEra(g, g.turn);
  const per = eraTurns(g);
  return `<header class="plate" aria-label="Match">
  <div class="plate-main">
    <p class="wordmark serif">Mercadia</p>
    <h1 class="turn serif" id="turn-no" aria-label="Turn ${g.turn}">Turn ${g.turn}</h1>
  </div>
  <div class="plate-btns" role="group" aria-label="Board and match controls">
    <button type="button" class="tb delta${o.deltaOpen ? ' on' : ''}" data-act="delta" aria-controls="h-drawer" aria-label="Turn Delta" aria-pressed="${o.deltaOpen}" aria-keyshortcuts="T"${o.hasDelta ? '' : ' aria-disabled="true" data-reason="No Turn Delta yet \u2014 the first turn has not resolved"'}>${ic('delta')}<span class="tt">Turn Delta</span><kbd class="kh mono" aria-hidden="true">T</kbd></button>
    ${o.canExport ? `<button type="button" class="tb ico tb-export" data-act="export" aria-label="Export match" title="Export match (JSON)">${ic('export')}<span class="tt">Export</span></button>` : ''}
    <button type="button" class="tb ico" data-act="fit" aria-label="Fit board to view" title="Fit board (F)" aria-keyshortcuts="F">${ic('fit')}<span class="tt">Fit</span></button>
    <button type="button" class="tb ico" data-act="sound" aria-label="Mute" aria-pressed="${o.muted}" title="${o.muted ? 'Sound is off \u2014 unmute' : 'Mute sound'} (M)" aria-keyshortcuts="M">${ic(o.muted ? 'mute' : 'sound')}<span class="tt">Sound</span></button>
    <button type="button" class="tb ico" data-act="leave" aria-label="Leave match" title="Leave match">${ic('leave')}<span class="tt">Leave</span></button>
  </div>
  <div class="plate-era">
    <p class="era" id="era-line"><span class="e-roman">Era ${era.roman}</span><span class="sep s1"> \u00b7 </span><span class="e-name">${esc(era.name)}</span><span class="sep s2"> \u00b7 </span><span class="e-part">${esc(part)}</span></p>
    <p class="in-era">Turn <span class="mono">${inEra}</span> of <span class="mono">${per}</span> in Era</p>
  </div>
</header>`;
}

// ───────────────────────────── Status line ─────────────────────────────

/** Names of the human seats still planning (rooms/hotseat), excluding the viewer. */
export function planningNames(v: SessionView): string[] {
  return v.seats.filter((s, i) => s.kind === 'human' && !s.ready && i !== v.seat).map((s) => s.name);
}

export function statusHtml(v: SessionView): string {
  const tone = v.status.tone;
  const error = tone === 'error';
  let text = v.status.text;
  if (tone === 'wait' && v.mode === 'room') {
    const names = planningNames(v);
    if (names.length) text += ` ${names.join(', ')} still planning.`;
  }
  return `<div class="status tone-${tone}" data-k="status-${error ? 'alert' : 'status'}" role="${error ? 'alert' : 'status'}" ${error ? '' : 'aria-live="polite"'}><span class="rule" aria-hidden="true"></span><span class="st-text">${esc(text)}</span></div>`;
}

// ───────────────────────────── Leaderboard ─────────────────────────────

export function leaderboardHtml(v: SessionView, o: { open: boolean; detail: boolean }): string {
  const g = v.game;
  const multi = v.mode !== 'solo';
  const rows = g.standings.map((s, rank) => {
    const p: Player = g.players[s.player];
    const h = p.house % HOUSES.length;
    const stars = p.milestones.filter((t) => t > 0).length;
    const seat = v.seats[s.player];
    const you = s.player === v.seat;
    let status = '';
    if (multi && seat && seat.kind === 'human') {
      status = `<span class="ls">${seat.ready ? 'Ready' : 'Planning'} · ${seat.connected ? 'Connected' : 'Offline'}</span>`;
    } else if (multi && seat && seat.kind === 'ai') status = '<span class="ls">AI House</span>';
    return `<li class="lrow h${h}${you ? ' you' : ''}" data-k="lb${s.player}">
      <span class="rk mono" aria-label="Rank ${rank + 1}">${rank + 1}</span>
      ${crestSvg(p.house, { quiet: true, cls: 'md' })}
      <span class="lbody"><span class="ln"><span class="nm" title="${esc(HOUSES[h].name)}">${esc(p.name)}</span>${you ? '<span class="you-t"> you</span>' : ''}${starPips(stars, MILESTONES.length)}</span>${status}</span>
      <span class="ci mono" aria-label="Crown Index ${s.crown}">${s.crown}</span>
      <span class="bk${o.detail ? ' open' : ''}">Worth <span class="mono">${s.worthComponent}</span> + Share <span class="mono">${s.shareComponent}</span> + Prestige <span class="mono">${s.prestigeComponent}</span></span>
    </li>`;
  });
  const compact = g.standings
    .map((s) => {
      const p = g.players[s.player];
      return `<span class="cc h${p.house % HOUSES.length}" data-k="cc${s.player}">${crestSvg(p.house, { quiet: true, cls: 'sm' })}<span class="mono">${s.crown}</span></span>`;
    })
    .join('');
  return `<section class="lb${o.open ? ' open' : ''}" aria-label="Leaderboard, Crown Index">
  <button type="button" class="lb-compact" data-act="lb" aria-expanded="${o.open}" aria-label="Leaderboard: ${g.standings.map((s) => `${g.players[s.player].name} ${s.crown}`).join(', ')}. Tap to ${o.open ? 'collapse' : 'expand'}">${compact}${ic(o.open ? 'up' : 'down')}</button>
  <div class="lb-full">
    <div class="lb-head"><h2 class="lab">Crown Index</h2><button type="button" class="link" data-act="lbdetail" aria-expanded="${o.detail}">${o.detail ? 'Hide breakdown' : 'Breakdown'}</button></div>
    <ol class="lrows">${rows.join('')}</ol>
  </div>
</section>`;
}

// ───────────────────────────── Chronicle ─────────────────────────────

function dispatchIcon(d: Dispatch): string {
  if (d.cat === 'event') {
    const ev = Object.values(EVENTS).find((e) => d.head.includes(e.title) || d.head.toLowerCase().includes(e.title.toLowerCase()));
    return ic(ev?.kind ?? 'era');
  }
  const m: Partial<Record<DispatchCat, string>> = { era: 'era', milestone: 'star', charter: 'charter', lead: 'crown', pact: 'charter', promo: 'promo', build: 'lot', market: 'crown', contest: 'contest', rival: 'watch' };
  return ic(m[d.cat] ?? 'era');
}

function ruleOf(v: SessionView, d: Dispatch): string {
  if (d.cat === 'era' || d.cat === 'milestone' || d.cat === 'lead' || d.cat === 'charter') return 'brass';
  if (d.cat === 'event') return 'canal';
  const p = d.player >= 0 ? v.game.players[d.player] : null;
  return p ? `h${p.house % HOUSES.length}` : 'ink';
}

function dispatchRow(v: SessionView, d: Dispatch, latest: boolean): string {
  const p = d.player >= 0 ? v.game.players[d.player] : null;
  const glyph = p && d.cat !== 'event' ? crestSvg(p.house, { quiet: true, cls: 'xs' }) : dispatchIcon(d);
  const jump =
    d.tile >= 0
      ? `<button type="button" class="jump" data-act="jump" data-arg="${d.tile}" aria-label="Jump to ${tileName(d.tile)}: ${esc(d.head)}" title="Jump to ${tileName(d.tile)}">${ic('jump')}</button>`
      : '<span class="jump-gap"></span>';
  return `<li class="cl r-${ruleOf(v, d)}${latest ? ' latest' : ''}" data-k="d${d.n}"><span class="cg">${glyph}</span><span class="ct"><span class="ch">${esc(d.head)}</span><span class="turnno mono">T${d.turn}</span></span>${d.pill ? `<span class="imp mono">${esc(d.pill)}</span>` : '<span></span>'}${jump}</li>`;
}

export function chronicleHtml(v: SessionView, open: boolean): string {
  const list = v.game.chronicle.slice(-8).reverse();
  const rows = open ? list : list.slice(0, 1);
  const body = rows.length ? rows.map((d, i) => dispatchRow(v, d, i === 0)).join('') : '<li class="cl r-ink empty"><span class="cg"></span><span class="ct"><span class="ch">No dispatches yet.</span></span><span></span><span></span></li>';
  return `<section class="chron${open ? ' open' : ''}${list.length === 0 ? ' empty-chron' : ''}" aria-label="Mercadia Chronicle">
  <div class="chron-head"><h2 class="lab">Chronicle</h2><button type="button" class="link" data-act="chron" aria-expanded="${open}"${list.length > 1 ? '' : ' hidden'}>${open ? 'Latest only' : `Last ${list.length}`}${ic(open ? 'up' : 'down')}</button></div>
  <ol class="clist">${body}</ol>
</section>`;
}

// ───────────────────────────── Founding Guide ─────────────────────────────

export interface GuideModel {
  steps: { label: string; hint: string; done: boolean }[];
  current: number;
  /** A suggested corner lot for step 2, or -1. */
  lot: number;
  lotName: string;
}

export function guideHtml(g: GuideModel): string {
  const items = g.steps
    .map(
      (s, i) =>
        `<li class="gs ${s.done ? 'done' : i === g.current ? 'now' : 'todo'}" data-k="g${i}"${i === g.current ? ' aria-current="step"' : ''}><span class="gn mono" aria-hidden="true">${s.done ? '' : i + 1}${s.done ? ic('check') : ''}</span><span class="gt"><b>${esc(s.label)}</b>${i === g.current ? `<small>${esc(s.hint)}${i === 1 && g.lot >= 0 ? ` Try <button type="button" class="link" data-act="guide-lot" data-arg="${g.lot}">${esc(g.lotName)}</button>.` : ''}</small>` : ''}</span></li>`,
    )
    .join('');
  return `<section class="guide" aria-label="Founding Guide">
  <div class="guide-head"><h2 class="lab">Founding Guide</h2><button type="button" class="link" data-act="guide-x" aria-label="Dismiss the Founding Guide">Dismiss</button></div>
  <ol class="gsteps">${items}</ol>
</section>`;
}

// ───────────────────────────── Command rail ─────────────────────────────

function toolHtml(t: Tool): string {
  const off = t.state !== 'ok';
  const aria = `${t.label}${t.sub ? `, ${t.sub}` : ''}${t.lock ? `, locked until ${t.lock}` : ''}${off && t.reason ? `. ${t.reason}` : ''}`;
  const bar = t.prog
    ? `<svg class="pbar" viewBox="0 0 36 4" aria-hidden="true"><rect class="bg" x="0" y="0" width="36" height="4"/><rect class="fg" x="0" y="0" width="${(36 * t.prog.n) / Math.max(1, t.prog.of)}" height="4"/></svg>`
    : '';
  return `<button type="button" class="tool${t.pressed ? ' on' : ''}${t.state === 'locked' ? ' locked' : ''}${t.creditOnly ? ' credit-only' : ''}" data-k="${esc(t.id)}" data-act="${t.act}" data-arg="${esc(t.arg)}" aria-label="${esc(aria)}"${
    t.act === 'selunit' || t.act === 'tool' ? ` aria-pressed="${t.pressed}"` : ''
  }${off ? ` aria-disabled="true" data-reason="${esc(t.reason)}"` : ''}${t.hotkey ? ` aria-keyshortcuts="${t.hotkey}"` : ''} title="${esc(off && t.reason ? t.reason : t.label)}">${t.hotkey && !t.lock ? `<span class="hk mono" aria-hidden="true">${t.hotkey}</span>` : ''}${ic(t.icon)}<span class="tl">${esc(t.label)}</span><span class="ts mono">${esc(t.sub)}</span>${bar}${t.lock ? `<span class="lockb">${ic('lock')}${esc(t.lock)}</span>` : ''}</button>`;
}

export function toolsHtml(tools: Tool[], tab: TabKey): string {
  let out = '';
  let group = '\u0000';
  for (const t of tools) {
    if (t.group !== group) {
      group = t.group;
      if (group) out += `<span class="grp${t.groupHouse >= 0 ? ` h${t.groupHouse % HOUSES.length}` : ''}" data-k="grp:${esc(group)}">${t.groupHouse >= 0 ? crestSvg(t.groupHouse, { quiet: true, cls: 'xs' }) : ''}<span>${esc(group)}</span></span>`;
      else if (out) out += '<span class="grp-sep" data-k="gsep" aria-hidden="true"></span>';
    }
    out += toolHtml(t);
  }
  return `<div class="tools" role="group" aria-label="${esc(TABS.find((x) => x.key === tab)?.label ?? '')} tools">${out || '<p class="note">Nothing to do here this turn.</p>'}</div>`;
}

export function railHtml(
  v: SessionView,
  o: { tab: TabKey; tools: Tool[]; msg: { text: string; tone: 'hint' | 'error' }; ordersOpen: boolean },
): string {
  const g = v.game;
  const p = g.players[v.seat];
  const plan = v.plan;
  const debt = plan?.debt ?? p?.debt ?? 0;
  const left = v.actions.max - v.actions.used;
  const spent = left <= 0;
  const rate = p ? loanRateLabel(charterMult(p, 'interest')) : loanRateLabel();
  const changed = v.projectedCash !== (p?.cash ?? 0);
  const et = v.endTurn;
  const credit = (kind: 'borrow' | 'repay'): string => {
    const why = !plan ? 'Planning is closed' : kind === 'borrow' ? (plan.debt + LOAN_STEP > 1200 ? 'The Credit Line is full' : plan.actions < 1 ? `No Actions left — ${plan.actionsMax} of ${plan.actionsMax} spent` : '') : plan.debt <= 0 ? 'Nothing to repay' : plan.actions < 1 ? `No Actions left — ${plan.actionsMax} of ${plan.actionsMax} spent` : plan.cash < Math.min(LOAN_STEP, plan.debt) ? `Not enough § — needs ${money(Math.min(LOAN_STEP, plan.debt))}, have ${money(plan.cash)} projected` : '';
    const amt = kind === 'repay' ? Math.min(LOAN_STEP, debt) || LOAN_STEP : LOAN_STEP;
    return `<button type="button" class="cbtn" data-act="order" data-arg='{"t":"${kind}"}' aria-label="${kind === 'borrow' ? 'Borrow' : 'Repay'} ${money(amt)}${kind === 'borrow' ? ` at ${rate}` : ''}"${why ? ` aria-disabled="true" data-reason="${esc(why)}"` : ''}><span>${kind === 'borrow' ? 'Borrow' : 'Repay'} <span class="mono">${money(amt)}</span></span></button>`;
  };
  const treasury = `<section class="treasury" aria-label="Treasury">
    <dl class="tg">
      <div class="tc cash"><dt>Cash</dt><dd class="mono big" id="cash">${money(p?.cash ?? 0)}</dd></div>
      <div class="tc after${changed ? ' diff' : ''}"><dt><span class="dlong">After orders</span><span class="dshort" aria-hidden="true">After</span></dt><dd class="mono" id="proj">${money(v.projectedCash)}</dd></div>
      <div class="tc debt"><dt>Debt</dt><dd class="mono">${money(debt)}</dd><dd class="rate"><span class="mono">${esc(rate)}</span></dd></div>
    </dl>
    <div class="credit" role="group" aria-label="Credit line">${credit('borrow')}${credit('repay')}</div>
  </section>`;
  const tabs = TABS.map(
    (t, i) => `<button type="button" class="tab${o.tab === t.key ? ' on' : ''}" data-k="tab:${t.key}" data-act="tab" data-arg="${t.key}" aria-pressed="${o.tab === t.key}" aria-label="${t.label} orders"><span>${t.label}</span>${i < 4 ? '<span class="dot" aria-hidden="true">·</span>' : ''}</button>`,
  ).join('');
  const dock = `<section class="dock" aria-label="Order dock">
    <div class="dock-top"><div class="tabs" role="group" aria-label="Order categories">${tabs}</div><p class="msg ${o.msg.tone}" id="dock-msg" role="status" aria-live="polite">${esc(o.msg.text)}</p></div>
    ${toolsHtml(o.tools, o.tab)}
  </section>`;
  const nOrders = v.draft.length;
  const endLabel = et.label;
  const turnbox = `<section class="turnbox" aria-label="Turn controls">
    <p class="actions mono${spent ? ' spent' : ''}" id="actions" aria-label="Actions ${left} of ${v.actions.max} remaining">Actions <b>${left}</b> of <b>${v.actions.max}</b></p>
    <button type="button" class="orders-toggle${o.ordersOpen ? ' on' : ''}" data-act="orders" aria-controls="h-drawer" aria-expanded="${o.ordersOpen}" aria-keyshortcuts="O">${ic('orders')}<span>Orders (<span class="mono">${nOrders}</span>)</span></button>
    <button type="button" class="endturn ${et.kind === 'cancel' ? 'cancel' : 'primary'}" id="end-turn" data-act="end" aria-keyshortcuts="Enter"${et.enabled ? '' : ' disabled'}><span class="el">${esc(endLabel)}</span>${et.enabled ? '<kbd class="eh mono" aria-hidden="true">Enter</kbd>' : ''}</button>
  </section>`;
  return `<footer class="rail" id="rail" aria-label="Command rail">${treasury}${dock}${turnbox}</footer>`;
}

export function spectatorHtml(v: SessionView): string {
  return `<footer class="rail spectator" id="rail" aria-label="Spectator"><p class="spec-line" role="status">Watching as spectator — Turn <span class="mono">${v.game.turn}</span></p></footer>`;
}

// ───────────────────────────── Orders queue ─────────────────────────────

export function ordersHtml(v: SessionView): string {
  const g = v.game;
  const rows = v.draft.map((o, i) => {
    const d = describeOrder(g, v.seat, o);
    const jump = d.tile >= 0 ? `<button type="button" class="ib" data-act="jump" data-arg="${d.tile}" aria-label="Show order ${i + 1} on the board">${ic('jump')}</button>` : '<span class="ib-gap"></span>';
    return `<li class="orow" data-k="o${i}-${esc(JSON.stringify(o))}">
      <span class="on mono" aria-hidden="true">${i + 1}</span>
      <span class="ot"><span class="otx">${esc(d.text)}</span><span class="om mono">${d.cost ? money(d.cost) : '§ 0'}${d.action ? ' · 1 Action' : ' · free'}</span></span>
      <span class="obtns">${jump}<button type="button" class="ib" data-act="reorder" data-arg="${i}:${i - 1}" aria-label="Move order ${i + 1} up"${i === 0 ? ' disabled' : ''}>${ic('up')}</button><button type="button" class="ib" data-act="reorder" data-arg="${i}:${i + 1}" aria-label="Move order ${i + 1} down"${i === v.draft.length - 1 ? ' disabled' : ''}>${ic('down')}</button><button type="button" class="ib undo" data-act="undo" data-arg="${i}" aria-label="Undo order ${i + 1}: ${esc(d.text)}">${ic('undo')}<span class="ul">Undo</span></button></span>
    </li>`;
  });
  const cost = v.draft.reduce((n, o) => n + describeOrder(g, v.seat, o).cost, 0);
  const used = v.actions.used;
  const foot = `<div class="ofoot"><p class="osum mono">${money(cost)} committed · Actions ${used} of ${v.actions.max} used</p><div class="obtn-row"><button type="button" class="act" data-act="undo-last"${rows.length ? '' : ' aria-disabled="true" data-reason="No orders to undo"'}>${ic('undo')}<span>Undo last</span></button><button type="button" class="act" data-act="clear"${rows.length ? '' : ' aria-disabled="true" data-reason="No orders to clear"'}>${ic('clear')}<span>Clear all</span></button></div></div>`;
  return `${rows.length ? `<ol class="olist">${rows.join('')}</ol>` : '<p class="note empty-note">No orders queued. Arm a tool in the dock and pick a tile, or select a shop or unit.</p>'}${foot}`;
}
