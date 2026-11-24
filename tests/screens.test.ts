// Pure-logic tests for the full-screen surfaces: configuration builders, the Crown equation,
// the Final Edition's chart helpers and the dev hook's gate. No DOM.
import { describe, expect, it } from 'vitest';
import { devHookEnabled } from '../src/client/dev-hook';
import { assignHouse, buildHotseatConfig, buildSoloConfig, defaultHotseatSeats, plateInfo } from '../src/client/screens';
import { councilPending, crownRows, eraShares, finalHeadline, spreadLabels } from '../src/client/screens-overlays';
import { cleanPlayerName, cleanRoomCode } from '../src/client/screens-ui';
import { createGame } from '../src/shared/game';
import { canonicalOrders, resolveTurn } from '../src/shared/resolve';
import type { SessionView } from '../src/client/contracts';
import type { Game } from '../src/shared/types';

function played(turns: number): Game {
  let g = createGame({
    seed: 99,
    mode: 'blitz',
    players: [
      { name: 'A', house: 0, kind: 'ai', persona: 'vesper' },
      { name: 'B', house: 1, kind: 'ai', persona: 'aurelia' },
      { name: 'C', house: 2, kind: 'ai', persona: 'orson' },
    ],
  });
  for (let i = 0; i < turns && g.phase !== 'ended'; i++) g = resolveTurn(g, canonicalOrders(g, [])).game;
  return g;
}

describe('configuration builders', () => {
  it('Play Solo Now is Standard with one human and Vesper, Aurelia, Orson', () => {
    const c = buildSoloConfig('  Dario  ', 7);
    expect(c.mode).toBe('standard');
    expect(c.players.map((p) => p.kind)).toEqual(['human', 'ai', 'ai', 'ai']);
    expect(c.players.map((p) => p.name)).toEqual(['Dario', 'Vesper', 'Aurelia', 'Orson']);
    expect(new Set(c.players.map((p) => p.house)).size).toBe(4);
    expect(buildSoloConfig('', 1).players[0].name).toBe('Merchant');
  });

  it('hotseat needs two humans and distinct Houses; AI seats take personas in order', () => {
    const seats = defaultHotseatSeats();
    const ok = buildHotseatConfig(seats, 'blitz', 5);
    expect(typeof ok).toBe('object');
    seats[2].kind = 'ai';
    seats[3].kind = 'ai';
    const c = buildHotseatConfig(seats, 'standard', 5);
    if (typeof c === 'string') throw new Error(c);
    expect(c.players.map((p) => p.persona)).toEqual([null, null, 'vesper', 'aurelia']);
    expect(c.players[0].name).toBe('Player 1');
    seats[1].kind = 'ai';
    expect(buildHotseatConfig(seats, 'standard', 5)).toMatch(/two human/);
  });

  it('assignHouse swaps so no two seats share a House', () => {
    const next = assignHouse(defaultHotseatSeats(), 1, 0);
    expect(next.map((s) => s.house)).toEqual([1, 0, 2, 3]);
  });

  it('cleans typed names and room codes', () => {
    expect(cleanPlayerName('  <b>Ana</b>   Maria  ', 'x')).toBe('bAna/b Maria'.slice(0, 16));
    expect(cleanPlayerName('   ', 'Player 3')).toBe('Player 3');
    expect(cleanRoomCode('ab-c9d e')).toBe('ABCD');
  });
});

describe('Final Edition helpers', () => {
  const g = played(16);

  it('the Crown equation rows add up exactly', () => {
    expect(g.phase).toBe('ended');
    const rows = crownRows(g);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.worth + r.share + r.prestige).toBe(r.crown);
    expect(rows.map((r) => r.crown)).toEqual([...rows.map((r) => r.crown)].sort((a, b) => b - a));
    expect(rows[0].player).toBe(g.winner);
  });

  it('Era shares come from the sampled trend', () => {
    const t = eraShares(g);
    expect(t).toHaveLength(3);
    expect(t[0]).toHaveLength(4);
    for (const row of t) for (const s of row) expect(s === null || (s >= 0 && s <= 100)).toBe(true);
  });

  it('headline names the winning House and the margin', () => {
    const { head, deck } = finalHeadline(g);
    expect(head).toMatch(/takes the Crown of Mercadia$/);
    expect(deck).toMatch(/Crown Index of \d+/);
  });

  it('spreadLabels keeps labels apart and in range', () => {
    const out = spreadLabels([100, 101, 102, 300], 14, 10, 320);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(14);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...out)).toBeLessThanOrEqual(320);
  });
});

describe('Council and plate', () => {
  it('the Council card applies to a seat with no Charter queued and clears once one is queued', () => {
    const g = played(4); // Blitz: Turn 5 is the first Council turn
    expect(g.council).not.toBeNull();
    const base = { game: g, seat: 0, handoff: null, ended: false, draft: [] } as unknown as SessionView;
    expect(councilPending(base)).toBe(true);
    expect(councilPending({ ...base, draft: [{ t: 'charter', key: g.council!.offers[0][0] }] })).toBe(false);
    expect(councilPending({ ...base, seat: -1 })).toBe(false);
    expect(councilPending({ ...base, handoff: { player: 1 } })).toBe(false);
  });

  it('plateInfo describes buildings, units and plain tiles', () => {
    const g = played(7);
    const b = g.buildings[0];
    expect(b).toBeDefined();
    expect(plateInfo(g, { tile: b.tile, unit: 0, building: b.id }).owner).toBe(b.owner);
    const u = g.units[0];
    expect(plateInfo(g, { tile: u.tile, unit: u.id, building: 0 }).owner).toBe(u.owner);
    expect(plateInfo(g, { tile: 0, unit: 0, building: 0 }).title.length).toBeGreaterThan(0);
  });
});

describe('dev hook gate', () => {
  it('opens on localhost or ?dev=1 only', () => {
    expect(devHookEnabled({ hostname: 'localhost', search: '' })).toBe(true);
    expect(devHookEnabled({ hostname: '127.0.0.1', search: '' })).toBe(true);
    expect(devHookEnabled({ hostname: 'mercadia.example', search: '' })).toBe(false);
    expect(devHookEnabled({ hostname: 'mercadia.example', search: '?dev=1' })).toBe(true);
    expect(devHookEnabled({ hostname: 'mercadia.example', search: '?dev=2' })).toBe(false);
  });
});
