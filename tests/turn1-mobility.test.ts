// Turn 1: all eight starting units (four Houses) can move, and every Factor has a vacant lot to build on,
// when every other seat holds position. Drives the real queueOrder + resolveTurn path.
import { describe, expect, it } from 'vitest';
import { START_TILES } from '../src/shared/game';
import { CITY, idx, tx, ty } from '../src/shared/map';
import { queueOrder, reachFrom } from '../src/shared/orders';
import { canonicalOrders, resolveTurn } from '../src/shared/resolve';
import type { Order } from '../src/shared/types';
import { newGame } from './helpers';

const kinds = ['human', 'human', 'human', 'human'] as const;
const at = (x: number, y: number) => idx(x, y);

describe('Turn 1 start tiles (SPEC.md / PRODUCT.md "Match start")', () => {
  it('are exactly the documented tiles', () => {
    expect(START_TILES).toEqual([
      [at(7, 1), at(8, 1)],
      [at(10, 1), at(11, 1)],
      [at(10, 3), at(11, 3)],
      [at(4, 1), at(3, 1)],
    ]);
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
