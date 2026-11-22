// The Mercadia district: a hand-laid 12×12 grid, its walk graph, tram loop and lot bonuses.
import type { TileKind } from './types';

export const W = 12;
export const H = 12;
export const N = W * H;

export const idx = (x: number, y: number): number => y * W + x;
export const tx = (i: number): number => i % W;
export const ty = (i: number): number => (i / W) | 0;
export const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;

/*
 * Legend
 *   A avenue (tram loop)     X avenue bridge over the canal
 *   l lane                   b arched stone footbridge
 *   ~ canal                  . buildable lot
 *   H townhouse              S Grand Station        g garden
 *
 * The camera looks from the south-east, so a lot's south and east sides are the visible
 * fronts. Every lot has a street on its south or east side: queues are never hidden.
 */
const LAYOUT = [
  'H.H..~.HSS.g', // y0  back row, faces the avenue
  '.AAAAXAAAAAA', // y1  Streetcar Avenue (north)
  'HA...~.....A', // y2
  '.AlllblllllA', // y3  lane + footbridge
  'HA...~~....A', // y4
  '.Allll~llllA', // y5  lane, broken by the canal (two quays)
  'HA....~....A', // y6
  '.AllllbllllA', // y7  lane + footbridge
  'HA....~~...A', // y8
  '.Alllll~lllA', // y9  lane, broken by the canal (two quays)
  'HA.....~...A', // y10
  '.AAAAAAXAAAA', // y11 Streetcar Avenue along the harbor
];

const KIND: Record<string, TileKind> = {
  A: 'avenue',
  X: 'avbridge',
  l: 'lane',
  b: 'bridge',
  '~': 'canal',
  '.': 'lot',
  H: 'home',
  S: 'station',
  g: 'garden',
};

export interface CityMap {
  tiles: TileKind[];
  walk: boolean[];
  lots: number[];
  homes: number[];
  homeDoors: number[]; // walkable tile each home spawns onto
  station: number[];
  stationDoor: number;
  pierTile: number; // harbor-front avenue tile where the pier meets the street
  loop: number[]; // tram loop, clockwise
  loopIndex: number[]; // tile → index in loop, or -1
  fixedStops: number[]; // avenue tiles with a city tram stop
  canal: number[];
  bridges: number[];
  walkable: number[];
  dist: Int16Array; // N×N walking distance, -1 if unreachable
  next: Int16Array; // N×N next hop from a toward b
  door: number[]; // per tile: street tile a building here opens onto, or -1
  doorDir: number[]; // per tile: 0 = door to the south (y+1), 1 = door to the east (x+1), -1 none
  corner: boolean[];
  canalFront: boolean[];
  avenueAdj: number[]; // per tile: an adjacent avenue tile, or -1
}

const DIRS: [number, number][] = [
  [0, 1], // S
  [1, 0], // E
  [0, -1], // N
  [-1, 0], // W
];

function build(): CityMap {
  const tiles: TileKind[] = [];
  for (let y = 0; y < H; y++) {
    const row = LAYOUT[y];
    if (row.length !== W) throw new Error(`map row ${y} has length ${row.length}`);
    for (let x = 0; x < W; x++) {
      const k = KIND[row[x]];
      if (!k) throw new Error(`unknown map glyph ${row[x]}`);
      tiles.push(k);
    }
  }
  const isWalk = (k: TileKind) => k === 'avenue' || k === 'avbridge' || k === 'lane' || k === 'bridge';
  const isWater = (k: TileKind) => k === 'canal' || k === 'bridge' || k === 'avbridge';
  const walk = tiles.map(isWalk);
  const pick = (f: (k: TileKind) => boolean) => tiles.map((k, i) => (f(k) ? i : -1)).filter((i) => i >= 0);
  const lots = pick((k) => k === 'lot');
  const homes = pick((k) => k === 'home');
  const station = pick((k) => k === 'station');
  const canal = pick(isWater);
  const bridges = pick((k) => k === 'bridge');
  const walkable = pick(isWalk);

  // Tram loop: the avenue ring x,y ∈ [1, 11], clockwise from the north-west corner.
  const loop: number[] = [];
  for (let x = 1; x <= 11; x++) loop.push(idx(x, 1));
  for (let y = 2; y <= 11; y++) loop.push(idx(11, y));
  for (let x = 10; x >= 1; x--) loop.push(idx(x, 11));
  for (let y = 10; y >= 2; y--) loop.push(idx(1, y));
  const loopIndex = new Array<number>(N).fill(-1);
  loop.forEach((t, i) => (loopIndex[t] = i));

  // All-pairs walking distance and next hop (BFS per walkable tile).
  const dist = new Int16Array(N * N).fill(-1);
  const next = new Int16Array(N * N).fill(-1);
  for (const src of walkable) {
    // BFS outward from src; next[b→src] is the neighbour we arrived from.
    const queue = [src];
    dist[src * N + src] = 0;
    next[src * N + src] = src;
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      const cx = tx(cur);
      const cy = ty(cur);
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inside(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (!walk[ni] || dist[src * N + ni] >= 0) continue;
        dist[src * N + ni] = dist[src * N + cur] + 1;
        next[ni * N + src] = cur; // from ni, step to cur to approach src
        queue.push(ni);
      }
    }
  }

  const door = new Array<number>(N).fill(-1);
  const doorDir = new Array<number>(N).fill(-1);
  const corner = new Array<boolean>(N).fill(false);
  const canalFront = new Array<boolean>(N).fill(false);
  const avenueAdj = new Array<number>(N).fill(-1);
  for (let i = 0; i < N; i++) {
    const x = tx(i);
    const y = ty(i);
    let hor = false;
    let ver = false;
    DIRS.forEach(([dx, dy], d) => {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny)) return;
      const ni = idx(nx, ny);
      if (walk[ni]) {
        if (door[i] < 0 && d < 2) {
          door[i] = ni;
          doorDir[i] = d;
        }
        if (dx !== 0) hor = true;
        else ver = true;
        if (avenueAdj[i] < 0 && (tiles[ni] === 'avenue' || tiles[ni] === 'avbridge')) avenueAdj[i] = ni;
      }
      if (isWater(tiles[ni])) canalFront[i] = true;
    });
    corner[i] = hor && ver;
  }

  const nearestWalk = (t: number): number => {
    let best = -1;
    let bd = 1e9;
    for (const w of walkable) {
      const d = Math.hypot(tx(w) - tx(t), ty(w) - ty(t));
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best;
  };

  return {
    tiles,
    walk,
    lots,
    homes,
    homeDoors: homes.map(nearestWalk),
    station,
    stationDoor: idx(8, 1),
    pierTile: idx(3, 11),
    loop,
    loopIndex,
    fixedStops: [idx(9, 1), idx(4, 11)],
    canal,
    bridges,
    walkable,
    dist,
    next,
    door,
    doorDir,
    corner,
    canalFront,
    avenueAdj,
  };
}

export const CITY: CityMap = build();

/** Walking distance in tiles between two walkable tiles (-1 if unreachable). */
export const walkDist = (a: number, b: number): number => CITY.dist[a * N + b];

/** Tiles to walk from a to b, excluding a, including b. */
export function pathTo(a: number, b: number): number[] {
  const out: number[] = [];
  if (a === b || CITY.dist[a * N + b] < 0) return out;
  let cur = a;
  let guard = 0;
  while (cur !== b && guard++ < N) {
    cur = CITY.next[cur * N + b];
    if (cur < 0) return [];
    out.push(cur);
  }
  return out;
}

export const manhattan = (a: number, b: number): number => Math.abs(tx(a) - tx(b)) + Math.abs(ty(a) - ty(b));
export const chebyshev = (a: number, b: number): number =>
  Math.max(Math.abs(tx(a) - tx(b)), Math.abs(ty(a) - ty(b)));
