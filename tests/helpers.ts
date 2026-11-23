// Shared fixtures for the MERCADIA test suite. Only public exports of src/shared are used.
import { advance } from '../src/shared/ai';
import { MILESTONES, START_CASH } from '../src/shared/constants';
import { CITY, idx, pathTo, tx, ty } from '../src/shared/map';
import { applyCommand, buildingAt, citizenTile, closeCouncil, createGame, serversOf, tick } from '../src/shared/sim';
import {
  CS,
  type AiPersona,
  type Building,
  type BuildKind,
  type Citizen,
  type Fx,
  type GameState,
  type MatchMode,
  type PlayerSetup,
} from '../src/shared/types';

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const humans = (n: number): PlayerSetup[] =>
  Array.from({ length: n }, (_, i) => ({ name: `Merchant ${i + 1}`, house: i, kind: 'human' as const }));

export const ais = (personas: AiPersona[]): PlayerSetup[] =>
  personas.map((persona, i) => ({ name: persona, house: i, kind: 'ai' as const, persona }));

export interface LabOptions {
  seed?: number;
  mode?: MatchMode;
  players?: number;
  cash?: number;
  /**
   * Start the lab at the first tick of this era (1..4), so its unlocks are in force: Era II for
   * Arcade, Nightmarket and Tram Stop; Era III for Boutique, Cinema, Festival Plaza and Level 3.
   */
  era?: number;
  /**
   * Leave the Dynasty Milestones live. By default a lab match has them already banked, so a
   * test of some other mechanic is not handed a dividend or prestige it did not ask for.
   */
  milestones?: boolean;
}

/** Put a match at the opening tick of an era: a legitimate state, as if the earlier eras had passed quietly. */
export function atEra(s: GameState, era: number): GameState {
  s.quarter = era;
  s.tick = (era - 1) * s.quarterTicks;
  return s;
}

/**
 * A match of human players only (no AI acts) with the era's random city events removed and,
 * unless asked otherwise, the Dynasty Milestones already banked.
 */
export function labGame(o: LabOptions = {}): GameState {
  const s = createGame({ seed: o.seed ?? 11, mode: o.mode ?? 'standard', players: humans(o.players ?? 2) });
  s.events = [];
  for (const p of s.players) {
    p.cash = o.cash ?? START_CASH;
    if (!o.milestones) p.milestones = MILESTONES.map(() => 0);
  }
  if (o.era && o.era > 1) atEra(s, o.era);
  return s;
}

/** Empty the streets and stop every source of new citizens (spawns and trams). */
export function freeze(s: GameState): GameState {
  s.citizens = [];
  s.spawnAcc = -1e9;
  s.trams = [];
  return s;
}

/** Build through the public command path and return the new building. */
export function build(s: GameState, player: number, x: number, y: number, kind: BuildKind): Building {
  const tile = idx(x, y);
  const res = applyCommand(s, player, { c: 'build', tile, kind });
  if (!res.ok) throw new Error(`build ${kind} at (${x},${y}) failed: ${res.err}`);
  return buildingAt(s, tile) as Building;
}

export function run(s: GameState, ticks: number): GameState {
  for (let i = 0; i < ticks; i++) tick(s);
  return s;
}

/**
 * Play `ticks` ticks with the AI Houses in the loop. An Era Council met on the way is closed at
 * once (every House takes its sealed or steward's charter) and costs no ticks. `each` runs after
 * every tick, before the feedback events are cleared when `clearFx` is set.
 */
export function play(s: GameState, ticks: number, each?: (s: GameState) => void, clearFx = false): GameState {
  for (let i = 0; i < ticks && s.phase !== 'ended'; i++) {
    if (s.phase === 'council') closeCouncil(s);
    advance(s);
    if (each) each(s);
    if (clearFx) s.fx = [];
  }
  return s;
}

/** Play a match to its final bell (or `maxTicks`), closing every Era Council on the way. */
export function playOut(s: GameState, each?: (s: GameState) => void, maxTicks = 40000): GameState {
  let n = 0;
  while (s.phase !== 'ended' && n++ < maxTicks) {
    if (s.phase === 'council') {
      closeCouncil(s);
      continue;
    }
    advance(s);
    if (each) each(s);
  }
  return s;
}

/** Tick (no AI) up to the close of the current era; returns with the Council open or the match ended. */
export function toEraClose(s: GameState): GameState {
  const q = s.quarter;
  let guard = s.quarterTicks + 5;
  while (s.phase === 'playing' && s.quarter === q && guard-- > 0) tick(s);
  return s;
}

export function fxOf<K extends Fx['k']>(fx: Fx[], k: K): Extract<Fx, { k: K }>[] {
  return fx.filter((f): f is Extract<Fx, { k: K }> => f.k === k);
}

/** Place a hand-made citizen at the centre of a walkable tile. */
export function putCitizen(s: GameState, tile: number, over: Partial<Citizen> = {}): Citizen {
  const c: Citizen = {
    id: s.nextCitizenId++,
    arch: 'local',
    x: tx(tile) + 0.5,
    y: ty(tile) + 0.5,
    state: CS.Stroll,
    desire: 'coffee',
    budget: 60,
    patience: 150,
    waited: 0,
    mood: 0.7,
    target: -1,
    path: [],
    tried: [],
    wants: 2,
    timer: 0,
    exit: CITY.stationDoor,
    from: tile,
    ...over,
  };
  s.citizens.push(c);
  return c;
}

/** Point a citizen at a shop, the way the simulation's own headTo does. */
export function sendTo(c: Citizen, b: Building): void {
  const here = citizenTile(c);
  c.state = CS.ToShop;
  c.target = b.id;
  c.from = here;
  c.waited = 0;
  c.path = pathTo(here, CITY.door[b.tile]);
}

/** Jam a shop: every server is busy for ever and the queue holds `n` phantom guests. */
export function jam(b: Building, n: number): void {
  b.serving = [];
  for (let i = 0; i < serversOf(b); i++) b.serving.push(900000 + i, 1e9);
  b.queue = Array.from({ length: n }, (_, i) => 800000 + i);
}

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);
