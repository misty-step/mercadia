// Turn 1: all eight starting units (four Houses) can move, and every Factor has a vacant lot to build on,
// when every other seat holds position. Drives the real queueOrder + resolveTurn path.
import { describe, expect, it } from 'vitest';
import { HOUSES } from '../src/shared/constants';
import { buildSoloConfig, defaultHotseatSeats } from '../src/client/screens';
import { START_TILES, createGame } from '../src/shared/game';
import { RoomCore } from '../src/shared/room';
import { CITY, idx, tx, ty } from '../src/shared/map';
import { queueOrder, reachFrom } from '../src/shared/orders';
import { canonicalOrders, resolveTurn } from '../src/shared/resolve';
import type { Order } from '../src/shared/types';
import { config, newGame } from './helpers';

const kinds = ['human', 'human', 'human', 'human'] as const;
const at = (x: number, y: number) => idx(x, y);

describe('Turn 1 start tiles (SPEC.md / PRODUCT.md "Match start")', () => {
  it('are exactly the documented tiles', () => {
    expect(START_TILES).toEqual([
      [at(7, 1), at(8, 1)],
      [at(10, 1), at(11, 1)],
      [at(4, 1), at(3, 1)],
      [at(10, 3), at(11, 3)],
    ]);
  });

  it('are keyed by House exactly as PRODUCT.md lists them: Vermilion, Cobalt, Emerald (10,3)/(11,3), Marigold (4,1)/(3,1)', () => {
    const g = newGame(31, 'standard', [...kinds]);
    const startOf = (house: number) => g.units.filter((u) => g.players[u.owner].house === house).map((u) => u.tile);
    expect(HOUSES.map((h) => h.key)).toEqual(['vermilion', 'cobalt', 'marigold', 'emerald']);
    expect(startOf(0)).toEqual([at(7, 1), at(8, 1)]); // Vermilion
    expect(startOf(1)).toEqual([at(10, 1), at(11, 1)]); // Cobalt
    expect(startOf(3)).toEqual([at(10, 3), at(11, 3)]); // Emerald
    expect(startOf(2)).toEqual([at(4, 1), at(3, 1)]); // Marigold
  });

  it('a House keeps its own start in any seat; a repeated House falls back to seat-indexed tiles (no shared tiles)', () => {
    const cfg = config(5, 'standard', ['human', 'human', 'human', 'human']);
    const swapped = createGame({ ...cfg, players: [cfg.players[0], cfg.players[1], { ...cfg.players[2], house: 3 }, { ...cfg.players[3], house: 2 }] });
    expect(swapped.units.filter((u) => u.owner === 2).map((u) => u.tile)).toEqual([at(10, 3), at(11, 3)]); // Emerald in seat 3
    expect(swapped.units.filter((u) => u.owner === 3).map((u) => u.tile)).toEqual([at(4, 1), at(3, 1)]); // Marigold in seat 4
    const dup = createGame({ ...cfg, players: cfg.players.map((p) => ({ ...p, house: 0 })) });
    expect(new Set(dup.units.map((u) => u.tile)).size).toBe(8);
  });

  it('the default solo, hotseat and room seats take Vermilion, Cobalt, Marigold, Emerald in seat order', () => {
    const order = ['vermilion', 'cobalt', 'marigold', 'emerald'];
    const key = (h: number) => HOUSES[h].key;
    expect(buildSoloConfig('Ada', 3).players.map((p) => key(p.house))).toEqual(order);
    expect(defaultHotseatSeats().map((s) => key(s.house))).toEqual(order);
    const room = new RoomCore('ABCD', 9);
    expect(room.lobby().seats.map((s) => key(s.house))).toEqual(order);
    expect(room.lobby().seats.map((s) => HOUSES[s.house].name)).toEqual(['Vermilion Guild', 'Cobalt Syndicate', 'Marigold House', 'Emerald Atelier']);
  });

  it('are eight distinct walkable street tiles beside Grand Station (y <= 3)', () => {
    const tiles = START_TILES.flat();
    expect(new Set(tiles).size).toBe(8);
    for (const t of tiles) {
      expect(CITY.walk[t]).toBe(true);
      expect(ty(t)).toBeLessThanOrEqual(3);
    }
    expect(CITY.tiles[at(10, 3)]).toBe('lane');
    expect(CITY.tiles[at(11, 3)]).toBe('avenue');
    expect(CITY.tiles[at(11, 2)]).toBe('avenue');
    expect(CITY.tiles[at(11, 4)]).toBe('avenue');
    expect(CITY.tiles[at(9, 3)]).toBe('lane');
  });

  it('every one of the 8 starting units completes at least one legal move through queueOrder + resolveTurn while the other seats hold', () => {
    const g = newGame(31, 'standard', [...kinds]);
    expect(g.units).toHaveLength(8);
    for (const u of g.units) {
      const reach = reachFrom(u.kind, u.tile, 2);
      const dests = [...reach.keys()].filter((t) => t !== u.tile);
      expect(dests.length, `unit ${u.id} (${u.kind}, seat ${u.owner}) has a legal destination`).toBeGreaterThan(0);
      const drafts: Order[][] = [[], [], [], []];
      let queued = false;
      for (const to of dests) {
        const r = queueOrder(g, u.owner, [], { t: 'move', unit: u.id, to });
        if (r.ok) {
          drafts[u.owner] = r.draft;
          queued = true;
          break;
        }
      }
      expect(queued, `unit ${u.id} (seat ${u.owner} ${u.kind}) can queue a move`).toBe(true);
      const res = resolveTurn(g, canonicalOrders(g, drafts));
      const after = res.game.units.find((x) => x.id === u.id)!;
      expect(after.tile, `unit ${u.id} (seat ${u.owner} ${u.kind}) actually moved`).not.toBe(u.tile);
      expect(CITY.walk[after.tile]).toBe(true);
    }
  });

  it('every Factor starts orthogonally adjacent to at least one vacant buildable lot', () => {
    const g = newGame(31, 'standard', [...kinds]);
    for (const u of g.units.filter((x) => x.kind === 'factor')) {
      const near = CITY.lots.filter((l) => Math.abs(tx(l) - tx(u.tile)) + Math.abs(ty(l) - ty(u.tile)) === 1 && !g.buildings.some((b) => b.tile === l));
      expect(near.length, `seat ${u.owner} Factor has an adjacent vacant lot`).toBeGreaterThan(0);
      const r = queueOrder(g, u.owner, [], { t: 'build', tile: near[0], kind: 'roastery' });
      expect(r.ok, `seat ${u.owner} can queue a build without moving`).toBe(true);
    }
  });
});
