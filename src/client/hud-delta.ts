// The Turn Delta drawer body: the exact Turn N → N+1 ledger, grouped in resolution order.
import type { CashRecon, ScoreDelta, SummaryLine, SummarySection, TurnSummary } from '../shared/types';
import { HOUSES } from '../shared/constants';
import type { SessionView } from './contracts';
import { crestSvg } from './heraldry';
import { esc, money } from './hud-dom';
import { ic } from './hud-icons';
import { tileName } from '../shared/game';

export const DELTA_SECTIONS: { key: SummarySection; title: string }[] = [
  { key: 'movement', title: 'Movement' },
  { key: 'combat', title: 'Combat' },
  { key: 'production', title: 'Production & buildings' },
  { key: 'treasury', title: 'Treasury' },
  { key: 'events', title: 'Events & score' },
];

/** Lines shown per section until "Show all". */
export const COMPACT_LINES = 8;

const houseOf = (v: SessionView, player: number): number => v.game.players[player]?.house ?? -1;

function lineHtml(v: SessionView, l: SummaryLine, i: number): string {
  const h = houseOf(v, l.player);
  const hc = h >= 0 ? ` h${h % HOUSES.length}` : '';
  const who = l.player >= 0 ? crestSvg(h, { quiet: true, cls: 'xs' }) : '';
  const num = l.n > 0 ? `<span class="n mono" aria-hidden="true">${l.n}</span>` : '<span class="n" aria-hidden="true"></span>';
  const inner = `${num}${who}<span class="tx">${esc(l.text)}</span><span class="val mono">${esc(l.value)}</span>`;
  const label = `${l.n > 0 ? `Marker ${l.n}. ` : ''}${l.text}${l.value ? `, ${l.value}` : ''}${l.tile >= 0 ? `. Pan to ${tileName(l.tile)}` : ''}`;
  if (l.tile >= 0) return `<li class="dl${hc}" data-k="l${i}"><button type="button" class="line" data-act="jump" data-arg="${l.tile}" aria-label="${esc(label)}">${inner}</button></li>`;
  return `<li class="dl${hc}" data-k="l${i}"><div class="line">${inner}</div></li>`;
}


function reconHtml(v: SessionView, r: CashRecon): string {
  const p = v.game.players[r.player];
  const h = p ? p.house : -1;
  return `<li class="recon${h >= 0 ? ` h${h % HOUSES.length}` : ''}" data-k="rc${r.player}">${h >= 0 ? crestSvg(h, { quiet: true, cls: 'xs' }) : ''}<p><span class="rn">${esc(p?.name ?? 'House')}</span> <span class="rt">Opening <b class="mono">${money(r.opening)}</b></span> <span class="rt">+ Income <b class="mono">${money(r.income)}</b></span> <span class="rt">\u2212 Costs <b class="mono">${money(r.costs)}</b></span> <span class="rt">\u2212 Upkeep <b class="mono">${money(r.upkeep)}</b></span> <span class="rt">${r.financing < 0 ? '\u2212' : '+'} Financing <b class="mono">${money(Math.abs(r.financing))}</b></span> <span class="rt">= Closing <b class="mono">${money(r.closing)}</b></span></p></li>`;
}

const signed = (n: number): string => (n === 0 ? '0' : `${n > 0 ? '+' : '\u2212'}${Math.abs(n)}`);

/** "▲2" climbed two places, "▼3" fell three, "held" unchanged. */
export function rankChip(s: ScoreDelta): { glyph: string; text: string; tone: 'up' | 'down' | 'hold' } {
  if (s.rankDelta > 0) return { glyph: '\u25B2', text: `\u25B2${s.rankDelta}`, tone: 'up' };
  if (s.rankDelta < 0) return { glyph: '\u25BC', text: `\u25BC${-s.rankDelta}`, tone: 'down' };
  return { glyph: '\u2013', text: 'held', tone: 'hold' };
}

function scoreRowHtml(v: SessionView, s: ScoreDelta): string {
  const p = v.game.players[s.player];
  const h = p ? p.house : -1;
  const chip = rankChip(s);
  const move = s.rankDelta === 0 ? `#${s.nextRank}` : `#${s.prevRank} \u2192 #${s.nextRank}`;
  const aria = `${p?.name ?? 'House'}: rank ${s.rankDelta === 0 ? `${s.nextRank}, unchanged` : `${s.prevRank} to ${s.nextRank}`}. Crown Index ${s.crown}, ${signed(s.crownDelta)}: net worth ${signed(s.worthDelta)}, market share ${signed(s.shareDelta)}, prestige ${signed(s.prestigeDelta)}`;
  return `<li class="srow${h >= 0 ? ` h${h % HOUSES.length}` : ''}" data-k="sc${s.player}" aria-label="${esc(aria)}"><span class="sr-id">${h >= 0 ? crestSvg(h, { quiet: true, cls: 'xs' }) : ''}<span class="sr-name">${esc(p?.name ?? 'House')}</span></span><span class="sr-rank mono" data-tone="${chip.tone}"><span class="rk">${move}</span> <span class="rc">${chip.text}</span></span><span class="sr-crown mono"><b>${s.crown}</b> <span class="cd">${signed(s.crownDelta)}</span></span><span class="sr-comp mono"><span class="cp"><i>Worth</i> ${signed(s.worthDelta)}</span><span class="cp"><i>Share</i> ${signed(s.shareDelta)}</span><span class="cp"><i>Prestige</i> ${signed(s.prestigeDelta)}</span></span></li>`;
}

function scoreHtml(v: SessionView, s: TurnSummary): string {
  const scores = (s.scores ?? []).slice().sort((a, b) => a.nextRank - b.nextRank);
  if (!scores.length) return '';
  return `<section class="dsec dscore" data-k="s:score"><h3>Crown Index \u00b7 rank</h3><ol class="scores" aria-label="Crown Index and rank changes">${scores.map((x) => scoreRowHtml(v, x)).join('')}</ol></section>`;
}

export interface DeltaModel {
  /** `Turn 11 → 12` */
  heading: string;
  hash: string;
  index: number;
  count: number;
  body: string;
}

export function deltaModel(v: SessionView, index: number, showAll: ReadonlySet<string>, markers: boolean): DeltaModel | null {
  const list = v.summaries.length ? v.summaries : v.summary ? [v.summary] : [];
  if (!list.length) return null;
  const i = Math.max(0, Math.min(list.length - 1, index < 0 ? list.length - 1 : index));
  const s: TurnSummary = list[i];
  const latest = i === list.length - 1;
  const sections = DELTA_SECTIONS.map((sec) => {
    const lines = s.lines.map((l, k) => ({ l, k })).filter((x) => x.l.section === sec.key);
    const recon = sec.key === 'treasury' ? s.cash.slice().sort((a, b) => (a.player === v.seat ? -1 : b.player === v.seat ? 1 : a.player - b.player)) : [];
    if (!lines.length && !recon.length) return '';
    const all = showAll.has(sec.key);
    const shown = all ? lines : lines.slice(0, COMPACT_LINES);
    return `<section class="dsec" data-k="s:${sec.key}"><h3>${esc(sec.title)}</h3><ul class="dlines">${shown.map((x) => lineHtml(v, x.l, x.k)).join('')}</ul>${
      lines.length > COMPACT_LINES ? `<button type="button" class="more" data-act="deltashow" data-arg="${sec.key}" aria-expanded="${all}">${all ? 'Show fewer' : `Show all (${lines.length})`}</button>` : ''
    }${recon.length ? `<ul class="recons" aria-label="Cash reconciliation">${recon.map((r) => reconHtml(v, r)).join('')}</ul>` : ''}</section>`;
  }).join('');
  const empty = sections || s.scores?.length ? '' : '<p class="note">Nothing changed this turn.</p>';
  const head = s.headline ? `<p class="headline serif">${esc(s.headline)}</p>` : '';
  const hasMarkers = latest && s.lines.some((l) => l.n > 0 && l.tile >= 0);
  const marker = hasMarkers
    ? `<button type="button" class="more" data-act="markers" aria-pressed="${markers}">${ic('eye')}${markers ? 'Hide board markers' : 'Show board markers'}</button>`
    : '';
  const body = `${head}${scoreHtml(v, s)}${sections}${empty}${marker}`;
  return { heading: `Turn ${s.from} → ${s.to}`, hash: s.hash, index: i, count: list.length, body };
}
