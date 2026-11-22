// Shared fixtures for the MERCADIA test suite. Only public exports of src/shared are used.
import { START_CASH } from '../src/shared/constants';
import { CITY, idx, pathTo, tx, ty } from '../src/shared/map';
import { applyCommand, buildingAt, citizenTile, createGame, serversOf, tick } from '../src/shared/sim';
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
}

/** A match of human players only (no AI acts) with the quarter's random city events removed. */
export function labGame(o: LabOptions = {}): GameState {
  const s = createGame({ seed: o.seed ?? 11, mode: o.mode ?? 'standard', players: humans(o.players ?? 2) });
  s.events = [];
  for (const p of s.players) p.cash = o.cash ?? START_CASH;
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
