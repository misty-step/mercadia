import { describe, expect, it, vi } from 'vitest';
import { CIVICS, PRESTIGE_TRAM, TRANSIT_RADIUS } from '../src/shared/constants';
import { CITY, H, N, W, chebyshev, idx, inside, manhattan, pathTo, tx, ty, walkDist } from '../src/shared/map';
import { canBuild, createGame, loopPoint, lotBonuses, stopTiles, trafficPips } from '../src/shared/sim';
import { build, freeze, fxOf, humans, labGame, run } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const NEIGH: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];
const neighbours = (t: number): number[] =>
  NEIGH.map(([dx, dy]) => [tx(t) + dx, ty(t) + dy] as const)
    .filter(([x, y]) => inside(x, y))
    .map(([x, y]) => idx(x, y));
const isStreet = (t: number): boolean => ['avenue', 'avbridge', 'lane', 'bridge'].includes(CITY.tiles[t]);
const isWater = (t: number): boolean => ['canal', 'bridge', 'avbridge'].includes(CITY.tiles[t]);
const count = (kind: string): number => CITY.tiles.filter((k) => k === kind).length;

describe('Map generation', () => {
  it('is a 12×12 grid with consistent index helpers', () => {
    expect(W).toBe(12);
    expect(H).toBe(12);
    expect(N).toBe(144);
    expect(CITY.tiles).toHaveLength(144);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        expect(tx(i)).toBe(x);
        expect(ty(i)).toBe(y);
      }
    }
    expect(inside(0, 0)).toBe(true);
    expect(inside(11, 11)).toBe(true);
    expect(inside(12, 0)).toBe(false);
    expect(inside(0, -1)).toBe(false);
    // Only streets and bridges are walkable: never open water, lots or houses.
    for (let t = 0; t < N; t++) expect(CITY.walk[t]).toBe(isStreet(t));
    expect(CITY.walkable).toEqual(CITY.tiles.map((_, i) => i).filter(isStreet));
  });

  it('has 49 buildable lots, inside the 48–56 band of the brief', () => {
    expect(CITY.lots.length).toBeGreaterThanOrEqual(48);
    expect(CITY.lots.length).toBeLessThanOrEqual(56);
    expect(CITY.lots).toHaveLength(49);
    expect(new Set(CITY.lots).size).toBe(49);
    for (const t of CITY.lots) expect(CITY.tiles[t]).toBe('lot');
    expect(count('lot')).toBe(49);
  });

  it('has exactly two arched footbridges and two avenue bridges', () => {
    expect(count('bridge')).toBe(2);
    expect(count('avbridge')).toBe(2);
    expect(CITY.bridges).toHaveLength(2);
    for (const t of CITY.bridges) {
      expect(CITY.tiles[t]).toBe('bridge');
      expect(CITY.walk[t]).toBe(true);
    }
    expect(CITY.bridges.slice().sort((a, b) => a - b)).toEqual([idx(5, 3), idx(6, 7)]);
  });

  it('runs the canal as one connected channel from the top row to the bottom row', () => {
    expect(CITY.canal.length).toBeGreaterThan(0);
    for (const t of CITY.canal) expect(isWater(t)).toBe(true);
    expect(CITY.canal).toHaveLength(CITY.tiles.filter((_, i) => isWater(i)).length);
    const water = new Set(CITY.canal);
    const top = CITY.canal.filter((t) => ty(t) === 0);
    expect(top.length).toBeGreaterThan(0);
    const seen = new Set<number>(top);
    const queue = top.slice();
    for (let qi = 0; qi < queue.length; qi++) {
      for (const n of neighbours(queue[qi])) {
        if (water.has(n) && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect([...seen].some((t) => ty(t) === H - 1)).toBe(true);
    // No stray ponds: every water tile belongs to the channel, and it touches every row.
    expect(seen.size).toBe(water.size);
    for (let y = 0; y < H; y++) expect(CITY.canal.some((t) => ty(t) === y)).toBe(true);
  });

  it('places eight townhouses, Grand Station and the Harbor Pier on the street grid', () => {
    expect(CITY.homes).toHaveLength(8);
    for (const t of CITY.homes) expect(CITY.tiles[t]).toBe('home');
    expect(CITY.homeDoors).toHaveLength(CITY.homes.length);
    CITY.homeDoors.forEach((d, i) => {
      expect(CITY.walk[d]).toBe(true);
      expect(chebyshev(d, CITY.homes[i])).toBe(1);
    });
    expect(CITY.station.length).toBeGreaterThanOrEqual(1);
    for (const t of CITY.station) expect(CITY.tiles[t]).toBe('station');
    expect(CITY.walk[CITY.stationDoor]).toBe(true);
    expect(CITY.station.some((t) => manhattan(t, CITY.stationDoor) === 1)).toBe(true);
    expect(CITY.walk[CITY.pierTile]).toBe(true);
    expect(CITY.tiles[CITY.pierTile]).toBe('avenue');
    expect(ty(CITY.pierTile)).toBe(H - 1); // the harbor-front avenue
  });
});

describe('Tram loop', () => {
  it('is a closed 40-tile cycle of 4-adjacent avenue tiles, all walkable', () => {
    const L = CITY.loop.length;
    expect(L).toBe(40);
    expect(new Set(CITY.loop).size).toBe(L);
    for (let i = 0; i < L; i++) {
      const a = CITY.loop[i];
      const b = CITY.loop[(i + 1) % L];
      expect(manhattan(a, b)).toBe(1);
      expect(['avenue', 'avbridge']).toContain(CITY.tiles[a]);
      expect(CITY.walk[a]).toBe(true);
    }
    // It covers every avenue tile and both avenue bridges, and loopIndex is its inverse.
    const avenue = CITY.tiles.map((k, i) => (k === 'avenue' || k === 'avbridge' ? i : -1)).filter((i) => i >= 0);
    expect(avenue.slice().sort((a, b) => a - b)).toEqual(CITY.loop.slice().sort((a, b) => a - b));
    for (let t = 0; t < N; t++) {
      const li = CITY.loopIndex[t];
      if (avenue.includes(t)) expect(CITY.loop[li]).toBe(t);
      else expect(li).toBe(-1);
    }
  });

  it('maps loop positions to tile centres and interpolates between them', () => {
    const a = CITY.loop[0];
    const b = CITY.loop[1];
    const p0 = loopPoint(0);
    expect(p0.x).toBeCloseTo(tx(a) + 0.5, 10);
    expect(p0.y).toBeCloseTo(ty(a) + 0.5, 10);
    const mid = loopPoint(0.5);
    expect(mid.x).toBeCloseTo((tx(a) + tx(b)) / 2 + 0.5, 10);
    expect(mid.y).toBeCloseTo((ty(a) + ty(b)) / 2 + 0.5, 10);
    // The loop is closed: a full lap, and a negative position, land on the same point.
    const wrap = loopPoint(CITY.loop.length);
    expect(wrap.x).toBeCloseTo(p0.x, 10);
    expect(wrap.y).toBeCloseTo(p0.y, 10);
    const back = loopPoint(-1);
    const last = CITY.loop[CITY.loop.length - 1];
    expect(back.x).toBeCloseTo(tx(last) + 0.5, 10);
    expect(back.y).toBeCloseTo(ty(last) + 0.5, 10);
  });

  it('starts two trams on opposite sides, keeps them on the loop and rings the bell at both city stops', () => {
    expect(CITY.fixedStops).toHaveLength(2);
    for (const t of CITY.fixedStops) expect(CITY.loopIndex[t]).toBeGreaterThanOrEqual(0);
    const fresh = createGame({ seed: 5, mode: 'standard', players: humans(1) });
    expect(fresh.trams).toHaveLength(2);
    expect(fresh.trams.every((t) => !t.special)).toBe(true);
    expect(Math.abs(fresh.trams[0].pos - fresh.trams[1].pos)).toBeCloseTo(CITY.loop.length / 2, 10);
    expect(stopTiles(fresh)).toEqual(CITY.fixedStops);
    const s = labGame({ era: 3, seed: 5 });
    const rung = new Set<number>();
    for (let i = 0; i < 1200; i++) {
      run(s, 1);
      for (const t of s.trams) {
        expect(t.pos).toBeGreaterThanOrEqual(0);
        expect(t.pos).toBeLessThan(CITY.loop.length);
      }
      for (const f of fxOf(s.fx, 'bell')) rung.add(f.tile);
      s.fx = [];
    }
    expect([...rung].sort((a, b) => a - b)).toEqual(CITY.fixedStops.slice().sort((a, b) => a - b));
  });
});

describe('Lot doors and the walk graph', () => {
  it('gives every lot a door on its south or east side that opens onto a street', () => {
    for (const t of CITY.lots) {
      const dir = CITY.doorDir[t];
      expect([0, 1]).toContain(dir);
      const door = CITY.door[t];
      expect(CITY.walk[door]).toBe(true);
      expect(door).toBe(dir === 0 ? idx(tx(t), ty(t) + 1) : idx(tx(t) + 1, ty(t)));
    }
  });

  it('connects every walkable tile to every other', () => {
    for (const a of CITY.walkable) {
      expect(walkDist(a, a)).toBe(0);
      for (const b of CITY.walkable) {
        const d = walkDist(a, b);
        expect(d).toBeGreaterThanOrEqual(manhattan(a, b));
        expect(d).toBe(walkDist(b, a));
      }
    }
    expect(walkDist(CITY.lots[0], CITY.walkable[0])).toBe(-1);
    // Lane y=3 is joined by a footbridge at (5,3): two steps across.
    expect(walkDist(idx(4, 3), idx(6, 3))).toBe(2);
    expect(pathTo(idx(4, 3), idx(6, 3))).toEqual([idx(5, 3), idx(6, 3)]);
    // Lane y=5 is cut by the canal at (6,5): the quays are two tiles apart but a long walk.
    expect(CITY.tiles[idx(6, 5)]).toBe('canal');
    expect(manhattan(idx(5, 5), idx(7, 5))).toBe(2);
    expect(walkDist(idx(5, 5), idx(7, 5))).toBeGreaterThan(2);
    expect(pathTo(idx(5, 5), idx(7, 5)).every((t) => CITY.tiles[t] !== 'canal')).toBe(true);
  });

  it('returns paths of contiguous 4-adjacent street tiles whose length is the walking distance', () => {
    let checked = 0;
    for (const a of CITY.walkable) {
      for (const b of CITY.walkable) {
        const path = pathTo(a, b);
        expect(path).toHaveLength(walkDist(a, b));
        let cur = a;
        for (const step of path) {
          if (manhattan(cur, step) !== 1 || !CITY.walk[step]) throw new Error(`broken path ${a}→${b} at ${step}`);
          cur = step;
        }
        expect(cur).toBe(b);
        checked++;
      }
    }
    expect(checked).toBe(CITY.walkable.length ** 2);
    expect(pathTo(CITY.walkable[3], CITY.walkable[3])).toEqual([]);
    expect(pathTo(CITY.lots[0], CITY.walkable[0])).toEqual([]);
  });

});

describe('Buildable-lot bonuses', () => {
  it('flags corner lots: (2,2) and (10,10) are corners, mid-block lots are not', () => {
    expect(CITY.corner[idx(2, 2)]).toBe(true);
    expect(CITY.corner[idx(10, 10)]).toBe(true);
    expect(CITY.corner[idx(3, 2)]).toBe(false);
    expect(CITY.corner[idx(3, 6)]).toBe(false);
    // A corner has a street both beside it and above or below it.
    const s = labGame({ era: 3 });
    for (const t of CITY.lots) {
      const hor = neighbours(t).some((n) => isStreet(n) && ty(n) === ty(t));
      const ver = neighbours(t).some((n) => isStreet(n) && tx(n) === tx(t));
      expect(CITY.corner[t]).toBe(hor && ver);
      expect(lotBonuses(s, t).corner).toBe(hor && ver);
    }
    const corners = CITY.lots.filter((t) => CITY.corner[t]).length;
    expect(corners).toBeGreaterThan(4);
    expect(corners).toBeLessThan(CITY.lots.length / 2);
  });

  it('flags canal-front lots: (4,2) and (6,2) face the water, (2,2) and (8,2) do not', () => {
    expect(CITY.canalFront[idx(4, 2)]).toBe(true);
    expect(CITY.canalFront[idx(6, 2)]).toBe(true);
    expect(CITY.canalFront[idx(2, 2)]).toBe(false);
    expect(CITY.canalFront[idx(8, 2)]).toBe(false);
    const s = labGame({ era: 3 });
    for (const t of CITY.lots) {
      expect(CITY.canalFront[t]).toBe(neighbours(t).some(isWater));
      // An empty district reports the static bonuses and no civic aura.
      expect(lotBonuses(s, t)).toMatchObject({ canal: CITY.canalFront[t], parks: 0, plaza: false });
    }
    const fronts = CITY.lots.filter((t) => CITY.canalFront[t]).length;
    expect(fronts).toBeGreaterThan(4);
    expect(fronts).toBeLessThan(CITY.lots.length / 2);
  });

  it('grants the transit bonus within walking reach of the fixed city stops only', () => {
    const s = labGame({ era: 3 });
    expect(lotBonuses(s, idx(8, 2)).transit).toBe(true);
    expect(lotBonuses(s, idx(10, 0)).transit).toBe(true);
    expect(lotBonuses(s, idx(3, 6)).transit).toBe(false);
    for (const t of CITY.lots) {
      const near = CITY.fixedStops.some((st) => manhattan(st, t) <= TRANSIT_RADIUS);
      expect(lotBonuses(s, t).transit).toBe(near);
    }
    const served = CITY.lots.filter((t) => lotBonuses(s, t).transit).length;
    expect(served).toBeGreaterThan(0);
    expect(served).toBeLessThan(CITY.lots.length / 2);
  });

  it('extends the transit bonus and the stop list when a player builds a Tram Stop', () => {
    const s = labGame({ era: 3, cash: 5000 });
    const neighbour = idx(3, 2);
    expect(lotBonuses(s, neighbour).transit).toBe(false);
    expect(lotBonuses(s, idx(2, 2)).transit).toBe(false);
    const before = stopTiles(s);
    const stop = build(s, 0, 2, 2, 'tramstop');
    const after = stopTiles(s);
    expect(after).toHaveLength(before.length + 1);
    expect(after).toContain(CITY.avenueAdj[stop.tile]);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(lotBonuses(s, neighbour).transit).toBe(true);
    expect(lotBonuses(s, idx(2, 2)).transit).toBe(true);
    // Far across the district nothing changes.
    expect(lotBonuses(s, idx(9, 6)).transit).toBe(false);
    // A Tram Stop beside a city stop shares it: the stop is not listed twice.
    const shared = CITY.lots.find((t) => CITY.fixedStops.includes(CITY.avenueAdj[t]));
    expect(shared).toBeDefined();
    build(s, 0, tx(shared as number), ty(shared as number), 'tramstop');
    expect(stopTiles(s)).toEqual(after);
  });

  it('only allows a Tram Stop on a lot that touches the avenue', () => {
    const s = labGame({ era: 3, cash: 5000 });
    const inner = CITY.lots.filter((t) => CITY.avenueAdj[t] < 0);
    const outer = CITY.lots.filter((t) => CITY.avenueAdj[t] >= 0);
    expect(inner.length).toBeGreaterThan(0);
    expect(outer.length).toBeGreaterThan(0);
    for (const t of inner) expect(canBuild(s, 0, t, 'tramstop').ok).toBe(false);
    for (const t of outer) {
      expect(canBuild(s, 0, t, 'tramstop').ok).toBe(true);
      expect(manhattan(t, CITY.avenueAdj[t])).toBe(1);
      expect(CITY.loopIndex[CITY.avenueAdj[t]]).toBeGreaterThanOrEqual(0);
    }
    // The same inner lots take any other project.
    expect(canBuild(s, 0, inner[0], 'park').ok).toBe(true);
  });

  it('makes trams call at a player-built Tram Stop and pays its owner prestige', () => {
    const s = labGame({ era: 3, cash: 5000 });
    const stop = build(s, 1, 2, 2, 'tramstop');
    const tile = CITY.avenueAdj[stop.tile];
    expect(s.players[1].prestige).toBe(CIVICS.tramstop.prestige);
    let calls = 0;
    for (let i = 0; i < 900; i++) {
      run(s, 1);
      calls += fxOf(s.fx, 'bell').filter((f) => f.tile === tile).length;
      s.fx = [];
    }
    expect(calls).toBeGreaterThan(0);
    expect(s.players[1].prestige).toBeGreaterThanOrEqual(CIVICS.tramstop.prestige + calls * PRESTIGE_TRAM - 1e-9);
    expect(s.players[0].prestige).toBe(0);
  });

  it('counts adjacent Pocket Parks, capped at two, and ignores parks further away', () => {
    const s = labGame({ era: 3, cash: 5000 });
    const lot = idx(3, 6);
    build(s, 0, 9, 6, 'park'); // across the canal
    expect(lotBonuses(s, lot).parks).toBe(0);
    build(s, 0, 5, 6, 'park'); // two tiles east: not adjacent
    expect(lotBonuses(s, lot).parks).toBe(0);
    build(s, 0, 4, 6, 'park');
    expect(lotBonuses(s, lot).parks).toBe(1);
    build(s, 1, 2, 6, 'park'); // a rival's park counts as well
    expect(lotBonuses(s, lot).parks).toBe(2);
    build(s, 0, 3, 4, 'park'); // chebyshev 2
    expect(lotBonuses(s, lot).parks).toBe(2);
    // A park is not its own neighbour.
    expect(lotBonuses(s, idx(9, 6)).parks).toBe(0);
  });

  it('spreads the Festival Plaza aura over two tiles and no further', () => {
    const s = labGame({ era: 3, cash: 5000 });
    const plaza = build(s, 0, 4, 6, 'plaza');
    for (const t of CITY.lots) {
      if (t === plaza.tile) continue;
      expect(lotBonuses(s, t).plaza).toBe(chebyshev(t, plaza.tile) <= 2);
    }
    expect(lotBonuses(s, idx(2, 6)).plaza).toBe(true);
    expect(lotBonuses(s, idx(4, 4)).plaza).toBe(true);
    expect(lotBonuses(s, idx(8, 6)).plaza).toBe(false);
    expect(lotBonuses(s, plaza.tile).plaza).toBe(false);
  });

  it('rates live foot traffic past every lot between one and five pips', () => {
    const cold = freeze(labGame({ era: 3 }));
    cold.footfall = cold.footfall.map(() => 0);
    const s = run(labGame({ era: 3, seed: 9 }), 400);
    for (const t of CITY.lots) {
      for (const g of [cold, s]) {
        const pips = trafficPips(g, t);
        expect(Number.isInteger(pips)).toBe(true);
        expect(pips).toBeGreaterThanOrEqual(1);
        expect(pips).toBeLessThanOrEqual(5);
      }
    }
    // With equal (zero) footfall a corner lot never rates below a plain mid-block lot.
    expect(trafficPips(cold, idx(2, 6))).toBeGreaterThan(trafficPips(cold, idx(3, 6)));
    // Streets that are walked on get busier than a dead-quiet district.
    expect(s.footfall.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
