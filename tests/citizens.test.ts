import { beforeAll, describe, expect, it, vi } from 'vitest';
import { advance } from '../src/shared/ai';
import {
  ARCHETYPES,
  ARCHS,
  AURA_MAX,
  CANAL_APPEAL,
  CANAL_APPEAL_BISTRO,
  CORNER_PULL,
  DESIRES,
  FIRST_NAMES,
  LAST_NAMES,
  MODES,
  PARK_AURA,
  PLAZA_AURA,
  POP_MAX,
  PROMO_DESIRE,
  PROMO_PULL,
  PROMO_TICKS,
  SHOPS,
  STANCES,
  TRANSIT_PULL,
} from '../src/shared/constants';
import { CITY, H, W, idx, manhattan, tx, ty, walkDist } from '../src/shared/map';
import {
  acceptance,
  applyCommand,
  chooseShop,
  citizenName,
  citizenTile,
  closeCouncil,
  createGame,
  decide,
  desireWeights,
  eventActive,
  lotBonuses,
  priceOf,
  queueCap,
  queueSlot,
  serversOf,
  shopQuality,
  shopScore,
  spawnCitizen,
  stopTiles,
} from '../src/shared/sim';
import { CS, type Archetype, type GameState } from '../src/shared/types';
import { ais, build, dist2, freeze, fxOf, humans, jam, labGame, putCitizen, run, sendTo } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const STATES: number[] = Object.values(CS);
const coffee = DESIRES.indexOf('coffee');

describe('Citizen spawning', () => {
  it('pre-populates the street at tick zero, everyone standing on a street tile', () => {
    const s = createGame({ seed: 21, mode: 'standard', players: humans(1) });
    expect(s.tick).toBe(0);
    expect(s.citizens.length).toBeGreaterThanOrEqual(40);
    expect(s.citizens.length).toBeLessThanOrEqual(POP_MAX);
    expect(new Set(s.citizens.map((c) => c.id)).size).toBe(s.citizens.length);
    expect(s.nextCitizenId).toBeGreaterThan(Math.max(...s.citizens.map((c) => c.id)));
    for (const c of s.citizens) expect(CITY.walk[idx(Math.floor(c.x), Math.floor(c.y))]).toBe(true);
    // They are spread over the district, not stacked on one tile.
    expect(new Set(s.citizens.map(citizenTile)).size).toBeGreaterThan(15);
    expect(s.fx).toEqual([]);
    // With no shops in the district yet, every one of their intents is recorded as unmet.
    expect(s.met.every((v) => v === 0)).toBe(true);
    expect(s.unmet.reduce((a, b) => a + b, 0)).toBe(s.citizens.length);
    for (const c of s.citizens) {
      expect(c.target).toBe(-1);
      expect([CS.Stroll, CS.Leave]).toContain(c.state);
    }
  });

  it('spawns each archetype with a wallet, patience and appetite inside its tuned ranges', () => {
    const s = labGame({ seed: 4 });
    for (const arch of ARCHETYPES) {
      const def = ARCHS[arch];
      const budgets = new Set<number>();
      for (let i = 0; i < 80; i++) {
        const c = spawnCitizen(s, { arch });
        expect(c.arch).toBe(arch);
        expect(Number.isInteger(c.budget)).toBe(true);
        expect(c.budget).toBeGreaterThanOrEqual(def.budget[0]);
        expect(c.budget).toBeLessThanOrEqual(def.budget[1]);
        expect(c.patience).toBeGreaterThanOrEqual(def.patience[0]);
        expect(c.patience).toBeLessThanOrEqual(def.patience[1]);
        // With nothing on sale the first decision already costs one want and a little mood.
        expect(c.wants).toBeGreaterThanOrEqual(def.wants[0] - 1);
        expect(c.wants).toBeLessThanOrEqual(def.wants[1]);
        expect(c.mood).toBeGreaterThan(0.12); // nobody arrives already too sour to shop
        expect(c.mood).toBeLessThanOrEqual(1);
        expect(DESIRES).toContain(c.desire);
        expect(STATES).toContain(c.state);
        expect(c.waited).toBe(0);
        budgets.add(c.budget);
      }
      expect(budgets.size).toBeGreaterThan(5);
      s.citizens = [];
    }
  });

  it('sends tourists in by station or pier, residents out of townhouses, commuters between home and tram', () => {
    const s = labGame({ seed: 8 });
    const gates = [CITY.stationDoor, CITY.pierTile];
    const stops = stopTiles(s);
    const origins: Record<string, Set<number>> = {};
    for (const arch of ARCHETYPES) {
      origins[arch] = new Set<number>();
      for (let i = 0; i < 60; i++) {
        const c = spawnCitizen(s, { arch });
        origins[arch].add(c.from);
        expect(dist2(c.x, c.y, tx(c.from) + 0.5, ty(c.from) + 0.5)).toBeLessThan(0.5);
        if (arch === 'tourist') {
          expect(gates).toContain(c.from);
          expect(gates).toContain(c.exit);
        } else if (arch === 'commuter') {
          const fromHome = CITY.homeDoors.includes(c.from);
          expect(fromHome ? stops : CITY.homeDoors).toContain(c.exit);
          expect(fromHome || stops.includes(c.from)).toBe(true);
        } else {
          expect(CITY.homeDoors).toContain(c.from);
          expect(c.exit).toBe(c.from);
        }
      }
      s.citizens = [];
    }
    expect([...origins.tourist].sort()).toEqual(gates.slice().sort());
    expect(origins.commuter.size).toBeGreaterThan(2);
    // An explicit origin (a tram dropping commuters) is honoured.
    const dropped = spawnCitizen(s, { arch: 'commuter', at: CITY.fixedStops[0] });
    expect(dropped.from).toBe(CITY.fixedStops[0]);
    // The mix shifts through the day: commuters at dawn, night owls at twilight.
    const tally = (qt: number): Record<Archetype, number> => {
      const g = labGame({ seed: 13 });
      g.tick = qt;
      const out = { commuter: 0, local: 0, foodie: 0, tourist: 0, nightowl: 0 };
      for (let i = 0; i < 600; i++) out[spawnCitizen(g).arch]++;
      return out;
    };
    const day = MODES.standard.quarterTicks;
    const morning = tally(Math.round(day * 0.05));
    const twilight = tally(Math.round(day * 0.9));
    expect(morning.commuter).toBeGreaterThan(twilight.commuter * 2);
    expect(twilight.nightowl).toBeGreaterThan(morning.nightowl * 3);
    for (const arch of ARCHETYPES) expect(morning[arch] + twilight[arch]).toBeGreaterThan(0);
  });

  it('names citizens deterministically from the match seed and their id', () => {
    const names = new Set<string>();
    for (let id = 1; id <= 200; id++) {
      const name = citizenName(77, id);
      expect(citizenName(77, id)).toBe(name);
      const [first, last] = name.split(' ');
      expect(FIRST_NAMES).toContain(first);
      expect(LAST_NAMES).toContain(last);
      names.add(name);
    }
    expect(names.size).toBeGreaterThan(60);
    const other = Array.from({ length: 200 }, (_, i) => citizenName(78, i + 1));
    expect(other.filter((n, i) => n !== citizenName(77, i + 1)).length).toBeGreaterThan(100);
  });
});

describe('Citizens on a living street (4 AI tycoons, 3000 ticks)', () => {
  const WARMUP = 150;
  const stat = {
    popMin: Infinity,
    popMax: 0,
    popPeak: 0,
    farthest: 0,
    offGrid: 0,
    tooFast: 0,
    brokenPaths: 0,
    badFields: 0,
    queueOverflow: 0,
    overServed: 0,
    served: 0,
    seen: new Set<Archetype>(),
    lingered: 0,
  };

  beforeAll(() => {
    const s = createGame({ seed: 3, mode: 'standard', players: ais(['vesper', 'aurelia', 'orson', 'vesper']) });
    const last = new Map<number, { x: number; y: number; state: number }>();
    for (let i = 0; i < 3000; i++) {
      if (s.phase === 'council') closeCouncil(s); // the Era I Council costs the street no ticks
      advance(s);
      const stride = eventActive(s, 'cloudburst') ? 1.5 : 1.25; // personal pace varies a little; walkers hurry in the rain
      stat.popPeak = Math.max(stat.popPeak, s.citizens.length);
      if (s.tick >= WARMUP) {
        stat.popMin = Math.min(stat.popMin, s.citizens.length);
        stat.popMax = Math.max(stat.popMax, s.citizens.length);
      }
      for (const c of s.citizens) {
        stat.seen.add(c.arch);
        if (c.state === CS.Linger) stat.lingered++;
        if (!(c.x >= 0 && c.x < W && c.y >= 0 && c.y < H)) stat.offGrid++;
        const t = citizenTile(c);
        if (!CITY.walk[t]) stat.offGrid++;
        stat.farthest = Math.max(stat.farthest, dist2(c.x, c.y, tx(t) + 0.5, ty(t) + 0.5));
        const ok =
          ARCHETYPES.includes(c.arch) &&
          DESIRES.includes(c.desire) &&
          STATES.includes(c.state) &&
          c.mood >= 0 &&
          c.mood <= 1 &&
          c.budget >= 0 &&
          c.budget <= ARCHS[c.arch].budget[1] &&
          c.wants <= ARCHS[c.arch].wants[1];
        if (!ok) stat.badFields++;
        // A path is a chain of adjacent street tiles.
        let cur = -1;
        for (const step of c.path) {
          if (!CITY.walk[step] || (cur >= 0 && manhattan(cur, step) !== 1)) stat.brokenPaths++;
          cur = step;
        }
        const prev = last.get(c.id);
        const seated = c.state === CS.Serve && prev !== undefined && prev.state !== CS.Serve;
        if (prev && !seated && dist2(c.x, c.y, prev.x, prev.y) > ARCHS[c.arch].speed * stride) stat.tooFast++;
      }
      last.clear();
      for (const c of s.citizens) last.set(c.id, { x: c.x, y: c.y, state: c.state });
      for (const b of s.buildings) {
        if (b.queue.length > queueCap(b)) stat.queueOverflow++;
        if (b.serving.length / 2 > serversOf(b)) stat.overServed++;
      }
      s.fx = [];
    }
    stat.served = s.players.reduce((a, p) => a + p.stats.served, 0);
  }, 60000);

  it('keeps the population between 45 and 120 once the Founding morning has filled the streets', () => {
    // Era I runs quieter than later eras (ERA_POP), so the floor sits below the old 60.
    expect(stat.popMin).toBeGreaterThanOrEqual(45);
    expect(stat.popMax).toBeLessThanOrEqual(120);
    expect(stat.popPeak).toBeLessThanOrEqual(POP_MAX);
    expect(stat.popMax).toBeGreaterThan(stat.popMin);
  });

  it('keeps every citizen on the grid, on or right beside a walkable tile', () => {
    expect(stat.offGrid).toBe(0);
    // Farthest anyone strays from their street tile: lingering inside an adjacent park lot.
    expect(stat.farthest).toBeLessThan(1.5);
    expect(stat.lingered).toBeGreaterThan(0);
    // Archetype, desire, mood, wallet and state stay valid for everyone, all day.
    expect(stat.badFields).toBe(0);
    expect([...stat.seen].sort()).toEqual(ARCHETYPES.slice().sort());
    expect(stat.served).toBeGreaterThan(500);
  });

  it('walks citizens along contiguous street paths at no more than their archetype speed', () => {
    expect(stat.brokenPaths).toBe(0);
    expect(stat.tooFast).toBe(0);
  });

  it('never lets a queue outgrow its capacity or a shop serve more guests than it has servers', () => {
    expect(stat.queueOverflow).toBe(0);
    expect(stat.overServed).toBe(0);
  });
});

describe('Competitive shop scoring', () => {
  // Two plain mid-block lots on either side of the canal, joined by the lane and its footbridge.
  const A = [3, 6] as const;
  const B = [9, 6] as const;
  const MIDDLE = idx(6, 7); // the footbridge: three steps from either door
  const pair = (): { s: GameState; a: ReturnType<typeof build>; b: ReturnType<typeof build> } => {
    const s = freeze(labGame({ era: 3, cash: 20000 }));
    const a = build(s, 0, A[0], A[1], 'roastery');
    const b = build(s, 1, B[0], B[1], 'roastery');
    return { s, a, b };
  };

  it('scores two identical shops equally from the midpoint, and the nearer one higher elsewhere', () => {
    const { s, a, b } = pair();
    for (const lot of [a.tile, b.tile]) {
      expect(lotBonuses(s, lot)).toEqual({ corner: false, canal: false, transit: false, parks: 0, plaza: false });
    }
    expect(walkDist(MIDDLE, CITY.door[a.tile])).toBe(walkDist(MIDDLE, CITY.door[b.tile]));
    expect(shopScore(s, a, 'local', MIDDLE)).toBeCloseTo(shopScore(s, b, 'local', MIDDLE), 12);
    const nearA = idx(4, 7);
    expect(walkDist(nearA, CITY.door[a.tile])).toBeLessThan(walkDist(nearA, CITY.door[b.tile]));
    for (const arch of ARCHETYPES) {
      expect(shopScore(s, a, arch, nearA)).toBeGreaterThan(shopScore(s, b, arch, nearA));
      expect(shopScore(s, b, arch, CITY.door[b.tile])).toBeGreaterThan(shopScore(s, b, arch, MIDDLE));
    }
    // Score falls monotonically as the walk gets longer.
    const walk = [3, 4, 5, 6, 7, 8].map((x) => shopScore(s, a, 'local', idx(x, 7)));
    for (let i = 1; i < walk.length; i++) expect(walk[i]).toBeLessThan(walk[i - 1]);
  });

  it('lets a price-sensitive commuter rank Budget over Fair over Craft over Prestige', () => {
    const { s, a } = pair();
    const fair = shopScore(s, a, 'commuter', MIDDLE);
    const byStance = STANCES.map((_, stance) => {
      a.stance = stance;
      return shopScore(s, a, 'commuter', MIDDLE);
    });
    expect(byStance[1]).toBe(fair);
    expect(byStance[0]).toBeGreaterThan(byStance[1]);
    expect(byStance[1]).toBeGreaterThan(byStance[2]);
    expect(byStance[2]).toBeGreaterThan(byStance[3]);
    // score ∝ (1 / price multiplier)^sensitivity × cachet^quality-love
    const def = ARCHS.commuter;
    STANCES.forEach((st, i) => {
      expect(byStance[i] / fair).toBeCloseTo(Math.pow(1 / st.mult, def.sens) * Math.pow(st.cachet, def.qlove), 9);
    });
    // The price war: at equal distance the discounter takes the commuter from a Fair rival.
    const { s: war, a: cheap, b: rival } = pair();
    cheap.stance = 0;
    expect(shopScore(war, cheap, 'commuter', MIDDLE)).toBeGreaterThan(shopScore(war, rival, 'commuter', MIDDLE) * 1.3);
    expect(chooseShop(war, { arch: 'commuter', budget: 30, tried: [] }, 'coffee', MIDDLE, false)).toBe(cheap);
    cheap.stance = 3;
    expect(chooseShop(war, { arch: 'commuter', budget: 30, tried: [] }, 'coffee', MIDDLE, false)).toBe(rival);
  });

  it('matters far less to a tourist what the price stance is', () => {
    const { s, a } = pair();
    const gap = (arch: Archetype): number => {
      a.stance = 0;
      const budget = shopScore(s, a, arch, MIDDLE);
      a.stance = 3;
      return budget / shopScore(s, a, arch, MIDDLE);
    };
    const commuter = gap('commuter');
    const tourist = gap('tourist');
    expect(commuter).toBeGreaterThan(2);
    expect(tourist).toBeLessThan(commuter / 2);
    expect(ARCHS.tourist.sens).toBeLessThan(ARCHS.commuter.sens);
  });

  it('scores a higher upgrade level higher, most of all for quality lovers', () => {
    const { s, a, b } = pair();
    expect(applyCommand(s, 0, { c: 'upgrade', id: a.id }).ok).toBe(true);
    const l2 = shopScore(s, a, 'foodie', MIDDLE);
    expect(l2).toBeGreaterThan(shopScore(s, b, 'foodie', MIDDLE));
    expect(applyCommand(s, 0, { c: 'upgrade', id: a.id }).ok).toBe(true);
    expect(a.level).toBe(3);
    const l3 = shopScore(s, a, 'foodie', MIDDLE);
    expect(l3).toBeGreaterThan(l2);
    const lift = (arch: Archetype): number => shopScore(s, a, arch, MIDDLE) / shopScore(s, b, arch, MIDDLE);
    expect(lift('foodie')).toBeGreaterThan(lift('commuter'));
    expect(lift('commuter')).toBeGreaterThan(1);
  });

  it('raises a shop’s score when a Pocket Park is built next to it (park aura)', () => {
    const { s, a, b } = pair();
    const before = shopScore(s, a, 'local', MIDDLE);
    const rival = shopScore(s, b, 'local', MIDDLE);
    build(s, 0, 4, 6, 'park');
    const after = shopScore(s, a, 'local', MIDDLE);
    expect(after).toBeGreaterThan(before);
    expect(after / before).toBeCloseTo(Math.pow(1 + PARK_AURA, ARCHS.local.qlove), 9);
    expect(shopQuality(s, a) / shopQuality(s, b)).toBeCloseTo(1 + PARK_AURA, 9);
    // The rival across the canal gains nothing.
    expect(shopScore(s, b, 'local', MIDDLE)).toBe(rival);
  });

  it('raises a shop’s score when a Festival Plaza stands within two tiles, capped by the aura limit', () => {
    const { s, a, b } = pair();
    const before = shopScore(s, a, 'tourist', MIDDLE);
    build(s, 0, 5, 6, 'plaza'); // two tiles east of A, far from B
    const after = shopScore(s, a, 'tourist', MIDDLE);
    expect(after / before).toBeCloseTo(Math.pow(1 + PLAZA_AURA, ARCHS.tourist.qlove), 9);
    expect(shopScore(s, b, 'tourist', MIDDLE)).toBeCloseTo(before, 12);
    // Stack two parks on top: the combined aura stops at AURA_MAX.
    build(s, 0, 4, 6, 'park');
    build(s, 0, 2, 6, 'park');
    expect(lotBonuses(s, a.tile)).toMatchObject({ parks: 2, plaza: true });
    expect(shopQuality(s, a) / shopQuality(s, b)).toBeCloseTo(1 + Math.min(AURA_MAX, PARK_AURA * 2 + PLAZA_AURA), 9);
    expect(shopQuality(s, a) / shopQuality(s, b)).toBeLessThanOrEqual(1 + AURA_MAX + 1e-9);
  });

  it('multiplies the score by PROMO_PULL while a Promo Blitz runs, and not after', () => {
    const { s, a, b } = pair();
    const before = shopScore(s, a, 'local', MIDDLE);
    expect(applyCommand(s, 0, { c: 'promo', id: a.id }).ok).toBe(true);
    expect(shopScore(s, a, 'local', MIDDLE) / before).toBeCloseTo(PROMO_PULL, 9);
    expect(chooseShop(s, { arch: 'local', budget: 50, tried: [] }, 'coffee', idx(8, 7), false)).toBe(a);
    run(s, PROMO_TICKS - 1);
    expect(shopScore(s, a, 'local', MIDDLE) / before).toBeCloseTo(PROMO_PULL, 9);
    run(s, 1);
    expect(shopScore(s, a, 'local', MIDDLE)).toBeCloseTo(before, 12);
    expect(chooseShop(s, { arch: 'local', budget: 50, tried: [] }, 'coffee', idx(8, 7), false)).toBe(b);
  });

  it('penalises a growing queue and heavily penalises a full one', () => {
    const { s, a } = pair();
    const cap = queueCap(a);
    const empty = shopScore(s, a, 'local', MIDDLE);
    let prev = empty;
    for (let n = 1; n < cap; n++) {
      a.queue.push(700000 + n);
      const sc = shopScore(s, a, 'local', MIDDLE);
      expect(sc).toBeLessThan(prev);
      prev = sc;
    }
    a.queue.push(700000);
    expect(a.queue).toHaveLength(cap);
    const full = shopScore(s, a, 'local', MIDDLE);
    expect(full).toBeLessThan(prev * 0.5);
    expect(full).toBeLessThan(empty * 0.2);
    expect(full).toBeGreaterThan(0);
  });

  it('favours corner, canal-front and transit lots, and a better-rated kitchen', () => {
    const s = freeze(labGame({ cash: 50000 }));
    const plain = build(s, 0, 3, 6, 'roastery');
    const corner = build(s, 0, 2, 6, 'roastery');
    const canal = build(s, 0, 5, 6, 'roastery');
    const transit = build(s, 0, 8, 2, 'roastery');
    const bistro = build(s, 0, 8, 6, 'bistro');
    const quay = build(s, 0, 7, 6, 'bistro');
    const at = (b: typeof plain): number => shopScore(s, b, 'local', CITY.door[b.tile]);
    expect(lotBonuses(s, corner.tile)).toMatchObject({ corner: true, canal: false, transit: false });
    expect(at(corner) / at(plain)).toBeCloseTo(CORNER_PULL, 9);
    expect(lotBonuses(s, canal.tile)).toMatchObject({ corner: false, canal: true, transit: false });
    expect(shopQuality(s, canal) / shopQuality(s, plain)).toBeCloseTo(CANAL_APPEAL, 9);
    expect(shopQuality(s, quay) / shopQuality(s, bistro)).toBeCloseTo(CANAL_APPEAL_BISTRO, 9);
    expect(lotBonuses(s, transit.tile)).toMatchObject({ corner: false, canal: false, transit: true });
    expect(at(transit) / at(plain)).toBeCloseTo(TRANSIT_PULL, 9);
    const base = at(plain);
    plain.rating = 5;
    expect(at(plain)).toBeGreaterThan(base);
    plain.rating = 1;
    expect(at(plain)).toBeLessThan(base);
    // Civic projects are not shops.
    const park = build(s, 0, 9, 4, 'park');
    expect(shopScore(s, park, 'local', CITY.door[park.tile])).toBe(0);
  });

  it('accepts Fair prices outright and makes a premium earn its keep with quality', () => {
    const { s, a } = pair();
    expect(acceptance(s, a, 'local')).toBe(1);
    a.stance = 0;
    expect(acceptance(s, a, 'local')).toBe(1);
    a.stance = 3;
    const l1 = acceptance(s, a, 'local');
    expect(l1).toBeLessThan(1);
    expect(l1).toBeGreaterThan(0);
    a.stance = 2;
    expect(acceptance(s, a, 'local')).toBeGreaterThan(l1);
    a.stance = 3;
    a.level = 3;
    const l3 = acceptance(s, a, 'local');
    expect(l3).toBeGreaterThan(l1);
    expect(l3).toBeLessThanOrEqual(1);
    // Tourists shrug at Prestige prices far more readily than commuters.
    expect(acceptance(s, a, 'tourist')).toBeGreaterThan(acceptance(s, a, 'commuter'));
  });
});

describe('Choosing a shop', () => {
  const setup = (): { s: GameState; a: ReturnType<typeof build>; b: ReturnType<typeof build> } => {
    const s = freeze(labGame({ era: 3, cash: 20000 }));
    return { s, a: build(s, 0, 3, 6, 'roastery'), b: build(s, 1, 9, 6, 'roastery') };
  };
  const MIDDLE = idx(6, 7);
  const who = { arch: 'local' as Archetype, budget: 60, tried: [] as number[] };

  it('diverts citizens from a full queue to the rival (queue diversion)', () => {
    const { s, a, b } = setup();
    const nearA = idx(4, 7);
    expect(chooseShop(s, who, 'coffee', nearA, false)).toBe(a);
    a.queue = Array.from({ length: queueCap(a) - 1 }, (_, i) => 700000 + i);
    expect(shopScore(s, a, 'local', nearA)).toBeLessThan(shopScore(s, a, 'local', MIDDLE) * 2);
    a.queue.push(799999);
    expect(shopScore(s, a, 'local', nearA)).toBeLessThan(shopScore(s, b, 'local', nearA));
    expect(chooseShop(s, who, 'coffee', nearA, false)).toBe(b);
    // Even standing at the crowded shop's own door, the rival across the canal wins.
    expect(chooseShop(s, who, 'coffee', CITY.door[a.tile], false)).toBe(b);
    a.queue = [];
    expect(chooseShop(s, who, 'coffee', CITY.door[a.tile], false)).toBe(a);
  });

  it('skips shops the citizen cannot afford, stocked-out shops and shops already tried', () => {
    const { s, a, b } = setup();
    const nearA = idx(4, 7);
    a.stance = 3;
    expect(priceOf(a)).toBeGreaterThan(priceOf(b));
    expect(chooseShop(s, { ...who, budget: priceOf(a) - 1 }, 'coffee', CITY.door[a.tile], false)).toBe(b);
    expect(chooseShop(s, { ...who, budget: priceOf(b) - 1 }, 'coffee', nearA, false)).toBeNull();
    expect(chooseShop(s, { ...who, budget: priceOf(b) }, 'coffee', nearA, false)).toBe(b);
    a.stance = 1;
    // … and stocked-out shops, and shops that already turned them away.
    const door = CITY.door[a.tile];
    expect(chooseShop(s, who, 'coffee', door, false)).toBe(a);
    a.stock = 0;
    expect(chooseShop(s, who, 'coffee', door, false)).toBe(b);
    a.stock = SHOPS.roastery.stockMax;
    a.dry = true;
    expect(chooseShop(s, who, 'coffee', door, false)).toBe(b);
    a.dry = false;
    expect(chooseShop(s, { ...who, tried: [a.id] }, 'coffee', door, false)).toBe(b);
    expect(chooseShop(s, { ...who, tried: [a.id, b.id] }, 'coffee', door, false)).toBeNull();
  });

  it('only offers shops that serve the desire, and never a civic project', () => {
    const { s, a } = setup();
    const bistro = build(s, 0, 4, 6, 'bistro');
    build(s, 0, 2, 6, 'park');
    const door = CITY.door[a.tile];
    expect(chooseShop(s, who, 'dining', door, false)).toBe(bistro);
    expect(chooseShop(s, who, 'coffee', door, false)?.kind).toBe('roastery');
    for (const d of DESIRES) {
      const pick = chooseShop(s, who, d, door, false);
      if (pick) expect(SHOPS[pick.kind as keyof typeof SHOPS].desire).toBe(d);
      else expect(['coffee', 'dining']).not.toContain(d);
    }
    // Without jitter the choice is deterministic and leaves the match RNG alone; with it, two
    // equal shops at equal distance split the crowd.
    const { s: twin } = setup();
    const rng = twin.rng;
    for (let i = 0; i < 20; i++) chooseShop(twin, who, 'coffee', MIDDLE, false);
    expect(twin.rng).toBe(rng);
    const picks = new Set<number>();
    for (let i = 0; i < 60; i++) picks.add((chooseShop(twin, who, 'coffee', MIDDLE) as { id: number }).id);
    expect(twin.rng).not.toBe(rng);
    expect(picks.size).toBe(2);
  });

});

describe('Desires and decisions', () => {
  it('weights desires by archetype and time of day: nobody wants the nightmarket at dawn', () => {
    const s = labGame();
    const night = DESIRES.indexOf('nightlife');
    for (const arch of ARCHETYPES) {
      const w = desireWeights(s, arch);
      expect(w).toHaveLength(DESIRES.length);
      expect(w[night]).toBe(0);
      expect(w.every((v) => v >= 0)).toBe(true);
    }
    const commuter = desireWeights(s, 'commuter');
    expect(commuter.indexOf(Math.max(...commuter))).toBe(coffee);
    s.tick = Math.round(s.quarterTicks * 0.9);
    const owl = desireWeights(s, 'nightowl');
    expect(owl.indexOf(Math.max(...owl))).toBe(night);
    // A running Promo Blitz stirs up appetite for its own trade only.
    s.players[0].cash = 5000;
    const a = build(s, 0, 3, 6, 'roastery');
    const before = desireWeights(s, 'local');
    expect(applyCommand(s, 0, { c: 'promo', id: a.id }).ok).toBe(true);
    const during = desireWeights(s, 'local');
    DESIRES.forEach((d, i) => {
      if (d === 'coffee') expect(during[i] / before[i]).toBeCloseTo(PROMO_DESIRE, 9);
      else expect(during[i]).toBe(before[i]);
    });
  });

  it('heads for the one shop in town, or strolls on, and counts met demand', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const a = build(s, 0, 3, 6, 'roastery');
    let heading = 0;
    for (let i = 0; i < 200; i++) {
      const c = putCitizen(s, idx(6, 7));
      decide(s, c);
      if (c.state === CS.ToShop) {
        heading++;
        expect(c.target).toBe(a.id);
        expect(c.desire).toBe('coffee');
        expect(c.path[c.path.length - 1]).toBe(CITY.door[a.tile]);
        expect(c.path).toHaveLength(walkDist(idx(6, 7), CITY.door[a.tile]));
      } else {
        expect(c.target).toBe(-1);
        expect([CS.Stroll, CS.Leave]).toContain(c.state);
      }
    }
    expect(heading).toBeGreaterThan(100);
    expect(s.met[coffee]).toBeGreaterThan(0);
    expect(s.met.reduce((x, y) => x + y, 0)).toBe(s.met[coffee]);
  });

  it('sends a citizen with no wants, no mood or no money home, and removes them at their exit', () => {
    const s = freeze(labGame({ cash: 5000 }));
    build(s, 0, 3, 6, 'roastery');
    const done = putCitizen(s, idx(4, 7), { wants: 0, exit: idx(1, 7) });
    const sour = putCitizen(s, idx(4, 7), { mood: 0.05, exit: idx(1, 7) });
    const broke = putCitizen(s, idx(4, 7), { budget: 3, exit: idx(1, 7) });
    for (const c of [done, sour, broke]) {
      decide(s, c);
      expect(c.state).toBe(CS.Leave);
      expect(c.target).toBe(-1);
      expect(c.path[c.path.length - 1]).toBe(idx(1, 7));
    }
    run(s, 80);
    expect(s.citizens).toHaveLength(0);
    // In a shopless district nobody loiters for ever: the first visitors all go home.
    const empty = createGame({ seed: 2, mode: 'endless', players: humans(1) });
    const first = new Set(empty.citizens.map((c) => c.id));
    run(empty, 1500);
    expect(empty.citizens.filter((c) => first.has(c.id))).toHaveLength(0);
    expect(empty.citizens.length).toBeGreaterThan(0);
  });
});

describe('Queues, turn-aways and service', () => {
  it('keeps every queue slot on the door tile, each guest in a distinct spot', () => {
    for (const lot of CITY.lots) {
      const door = CITY.door[lot];
      const seen = new Set<string>();
      for (let n = 0; n < 18; n++) {
        const p = queueSlot(lot, n);
        expect(Math.floor(p.x)).toBe(tx(door));
        expect(Math.floor(p.y)).toBe(ty(door));
        expect(citizenTile(p)).toBe(door);
        seen.add(`${p.x.toFixed(3)},${p.y.toFixed(3)}`);
      }
      expect(seen.size).toBe(18);
      // The head of the queue stands on the side of the tile nearest the shop door.
      const head = queueSlot(lot, 0);
      const tail = queueSlot(lot, 12);
      const toLot = (p: { x: number; y: number }): number => dist2(p.x, p.y, tx(lot) + 0.5, ty(lot) + 0.5);
      expect(toLot(head)).toBeLessThan(toLot(tail) + 0.25);
    }
  });

  it('walks a citizen to the door, seats them, takes their money and hands over the goods', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const a = build(s, 0, 3, 6, 'roastery');
    const cash = s.players[0].cash;
    const c = putCitizen(s, idx(6, 7), { budget: 60, wants: 2 });
    sendTo(c, a);
    const states = new Set<number>();
    let ticks = 0;
    while (a.served === 0 && ticks++ < 200) {
      run(s, 1);
      states.add(c.state);
    }
    expect(a.served).toBe(1);
    expect(states.has(CS.Serve)).toBe(true);
    expect(ticks).toBeGreaterThan(walkDist(idx(6, 7), CITY.door[a.tile]) / (ARCHS.local.speed * 1.25));
    const price = priceOf(a);
    expect(c.budget).toBe(60 - price);
    expect(c.wants).toBe(1);
    expect(s.players[0].cash).toBe(cash + price);
    expect(a.revenue).toBe(price);
    expect(a.stock).toBe(SHOPS.roastery.stockMax - 1);
    expect(a.queue).toEqual([]);
    expect(a.serving).toEqual([]);
    expect(fxOf(s.fx, 'coin')).toEqual([{ k: 'coin', x: tx(a.tile) + 0.5, y: ty(a.tile) + 0.5, amt: price, p: 0 }]);
    expect(s.players[0].stats.served).toBe(1);
  });

  it('turns a citizen away from a queue at capacity and sends them to the rival shop', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const a = build(s, 0, 3, 6, 'roastery');
    const b = build(s, 1, 9, 6, 'roastery');
    jam(a, queueCap(a));
    const c = putCitizen(s, idx(5, 7), { budget: 60, patience: 100000 });
    sendTo(c, a);
    expect(c.path[c.path.length - 1]).toBe(CITY.door[a.tile]);
    const rating = a.rating;
    const mood = c.mood;
    let ticks = 0;
    while (c.target === a.id && ticks++ < 100) run(s, 1);
    // Turned away at the door …
    const turns = fxOf(s.fx, 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0].b).toBe(a.id);
    expect(citizenTile(turns[0])).toBe(CITY.door[a.tile]);
    expect(a.turned).toBe(1);
    expect(s.players[0].stats.turnedAway).toBe(1);
    expect(a.rating).toBeLessThan(rating);
    expect(c.mood).toBeLessThan(mood);
    expect(a.queue).toHaveLength(queueCap(a));
    expect(a.queue).not.toContain(c.id);
    // … and now walking to the rival.
    expect(c.target).toBe(b.id);
    expect(c.state).toBe(CS.ToShop);
    expect(c.tried).toContain(a.id);
    expect(c.path[c.path.length - 1]).toBe(CITY.door[b.tile]);
    ticks = 0;
    while (b.served === 0 && ticks++ < 300) run(s, 1);
    expect(b.served).toBe(1);
    expect(a.served).toBe(0);
    expect(s.players[1].ledger.revenue).toBe(priceOf(b));
    expect(s.players[0].ledger.revenue).toBe(0);
    expect(b.turned).toBe(0);
  });

  it('makes an impatient citizen peel off when the wait looks too long, while a patient one queues', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const a = build(s, 0, 3, 6, 'roastery');
    build(s, 1, 9, 6, 'roastery');
    const ahead = queueCap(a) - 2;
    jam(a, ahead);
    const door = CITY.door[a.tile];
    const patient = putCitizen(s, door, { patience: 100000 });
    const hasty = putCitizen(s, door, { patience: 10 });
    sendTo(patient, a);
    sendTo(hasty, a);
    run(s, 1);
    expect(a.queue).toContain(patient.id);
    expect(patient.state).toBe(CS.Queue);
    expect(a.queue).not.toContain(hasty.id);
    expect(a.queue.length).toBeLessThan(queueCap(a) + 1);
    expect(hasty.state).not.toBe(CS.Queue);
    expect(hasty.target).not.toBe(a.id);
    expect(fxOf(s.fx, 'turn').map((f) => f.b)).toEqual([a.id]);
    expect(a.turned).toBe(1);
  });

  it('has a queuing citizen walk out once their patience runs dry', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const a = build(s, 0, 3, 6, 'roastery');
    jam(a, 0);
    const c = putCitizen(s, CITY.door[a.tile], { patience: 25, mood: 0.7 });
    sendTo(c, a);
    run(s, 1);
    expect(c.state).toBe(CS.Queue);
    expect(a.queue).toEqual([c.id]);
    let ticks = 1;
    while (fxOf(s.fx, 'walkout').length === 0 && ticks++ < 100) {
      expect(citizenTile(c)).toBe(CITY.door[a.tile]);
      run(s, 1);
    }
    expect(ticks).toBeGreaterThan(25);
    expect(ticks).toBeLessThan(30);
    expect(fxOf(s.fx, 'walkout')[0].b).toBe(a.id);
    expect(a.turned).toBe(1);
    expect(a.queue).not.toContain(c.id);
    expect(c.state).not.toBe(CS.Queue);
    expect(c.mood).toBeLessThan(0.7); // a wasted wait sours the mood
    expect(a.served).toBe(0);
  });

  it('tries a rival at once when the shop a citizen reaches has just sold out', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const a = build(s, 0, 3, 6, 'roastery');
    const b = build(s, 1, 9, 6, 'roastery');
    a.auto = false;
    a.stock = 0;
    const c = putCitizen(s, CITY.door[a.tile]);
    sendTo(c, a);
    run(s, 1);
    expect(c.target).toBe(b.id);
    expect(c.tried).toEqual([a.id]);
    // A stock-out is not the customer being turned away from a crowd.
    expect(a.turned).toBe(0);
    expect(fxOf(s.fx, 'turn')).toHaveLength(0);
  });
});
