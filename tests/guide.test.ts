// First-sixty-seconds onboarding (the Founding Guide and its starter corners), the Milestone
// progress pill, the input policy for locked tools and the Era Council, and House heraldry.
import { describe, expect, it, vi } from 'vitest';
import { CREST_BOX, CREST_SHAPES, SHIELD, SHIELD_SHADE, crestSvg, starPips } from '../src/client/heraldry';
import { MatchWatch, matchStamp, overlayActive, resolveKey, type KeyContext } from '../src/client/input';
import { LocalSession, soloSetups } from '../src/client/session';
import { BUILD_KINDS, ERA_UNLOCK, HOUSES, MILESTONES, MODES, isUnlocked } from '../src/shared/constants';
import { GUIDE_STEPS, STARTER_LOTS, guideState, milestoneProgress, starterLots, type GuideFacts } from '../src/shared/insight';
import { CITY, chebyshev, idx } from '../src/shared/map';
import { CityView, SnapEncoder } from '../src/shared/protocol';
import { createGame, lotBonuses, trafficPips } from '../src/shared/sim';
import type { BuildKind, GameState } from '../src/shared/types';
import { ais, build, clone, freeze, humans, labGame, play } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

// ───────────────────────────── Founding Guide ─────────────────────────────

describe('Founding Guide: three steps that retire themselves', () => {
  const facts = (over: Partial<GuideFacts> = {}): GuideFacts => ({ owned: [], inspected: false, stars: 0, dismissed: false, ...over });
  const shop = (tile = idx(3, 6), kind: BuildKind = 'roastery') => ({ kind, tile });

  it('has exactly three short steps: claim a corner, inspect the street, shape the block', () => {
    expect(GUIDE_STEPS.map((g) => g.title)).toEqual([
      'Claim a prime corner',
      'Inspect your opening street',
      'Shape your block or earn your first Milestone',
    ]);
    // Step 1 points at the Era I shops, step 3 at the Era I civic project: nothing locked.
    expect(GUIDE_STEPS[0].hint).toMatch(/Roastery/);
    expect(GUIDE_STEPS[0].hint).toMatch(/Bistro/);
    expect(GUIDE_STEPS[1].hint).toMatch(/diagnosis/);
    expect(GUIDE_STEPS[1].hint).toMatch(/price stance/);
    expect(GUIDE_STEPS[2].hint).toMatch(/Pocket Park/);
    // No wall of tutorial prose: a title and one line each.
    for (const g of GUIDE_STEPS) {
      expect(g.title.length).toBeLessThanOrEqual(48);
      expect(g.hint.length).toBeLessThanOrEqual(64);
    }
  });

  it('advances on what the player has actually done: build → inspect → shape, then retires for good', () => {
    // A fresh match: step 1.
    expect(guideState(facts())).toEqual({ step: 1, title: GUIDE_STEPS[0].title, hint: GUIDE_STEPS[0].hint, done: [false, false, false] });
    // A civic project alone is not an opening shop.
    expect(guideState(facts({ owned: [{ kind: 'park', tile: idx(4, 6) }] })).step).toBe(1);
    // First shop open: step 2, whatever else is true.
    const opened = facts({ owned: [shop()] });
    expect(guideState(opened)).toMatchObject({ step: 2, title: 'Inspect your opening street', done: [true, false, false] });
    // The steps cannot be skipped: a second property before inspecting still asks for the inspection.
    expect(guideState(facts({ owned: [shop(), shop(idx(4, 6), 'bistro')] }))).toMatchObject({ step: 2, done: [true, false, false] });
    expect(guideState(facts({ owned: [shop()], stars: 2 }))).toMatchObject({ step: 2, done: [true, false, false] });
    // Inspected: step 3.
    const inspected = facts({ owned: [shop()], inspected: true });
    expect(guideState(inspected)).toMatchObject({ step: 3, title: GUIDE_STEPS[2].title, hint: GUIDE_STEPS[2].hint, done: [true, true, false] });
    // Any of three things completes it: a Pocket Park, a second property, or a first Milestone.
    for (const done of [
      facts({ owned: [shop(), { kind: 'park', tile: idx(4, 6) }], inspected: true }),
      facts({ owned: [shop(), shop(idx(9, 6), 'bistro')], inspected: true }),
      facts({ owned: [shop()], inspected: true, stars: 1 }),
    ]) {
      expect(guideState(done)).toEqual({ step: 0, title: '', hint: '', done: [true, true, true] });
    }
    // Inspecting before building anything counts for nothing yet.
    expect(guideState(facts({ inspected: true }))).toMatchObject({ step: 1, done: [false, false, false] });
  });

  it('is dismissible with one click at any step, and stays gone', () => {
    for (const f of [facts(), facts({ owned: [shop()] }), facts({ owned: [shop()], inspected: true })]) {
      const live = guideState(f);
      expect(live.step).toBeGreaterThan(0);
      const gone = guideState({ ...f, dismissed: true });
      expect(gone).toMatchObject({ step: 0, title: '', hint: '' });
      expect(gone.done).toEqual(live.done); // progress is remembered, the card is not shown
    }
    // Retired by completion, it does not come back if the player later sells down to one shop.
    expect(guideState(facts({ owned: [shop()], inspected: true, stars: 1, dismissed: false })).step).toBe(0);
  });

  it('follows a real opening through the simulation: first shop, inspection, a Pocket Park', () => {
    const s = freeze(labGame({ milestones: true }));
    const mine = (): { kind: BuildKind; tile: number }[] => s.buildings.filter((b) => b.owner === 0);
    const stars = (): number => s.players[0].milestones.filter((t) => t >= 0).length;
    let inspected = false;
    const step = (): number => guideState({ owned: mine(), inspected, stars: stars(), dismissed: false }).step;
    expect(step()).toBe(1);
    const lot = starterLots(s)[0];
    build(s, 0, lot % 12, Math.floor(lot / 12), 'roastery');
    expect(step()).toBe(2);
    inspected = true; // the player clicked their shop
    expect(step()).toBe(3);
    const beside = CITY.lots.find((t) => t !== lot && chebyshev(t, lot) <= 1) as number;
    build(s, 0, beside % 12, Math.floor(beside / 12), 'park');
    expect(step()).toBe(0);
  });
});

describe('Founding Guide: prime starter corners', () => {
  it('marks four vacant, spread-out, high-traffic lots — corners first — and never a built one', () => {
    expect(STARTER_LOTS).toBe(4);
    for (const seed of [1, 7, 42]) {
      const s = createGame({ seed, mode: 'standard', players: humans(1) });
      play(s, 60);
      const lots = starterLots(s);
      expect(lots).toHaveLength(4);
      expect(new Set(lots).size).toBe(4);
      for (const t of lots) {
        expect(CITY.tiles[t]).toBe('lot');
        expect(s.buildings.some((b) => b.tile === t)).toBe(false);
      }
      // Spread out: no two rings on neighbouring lots.
      for (const a of lots) for (const b of lots) if (a !== b) expect(chebyshev(a, b)).toBeGreaterThan(1);
      // Prime: corners, and busier than the district's typical lot.
      expect(lots.filter((t) => lotBonuses(s, t).corner).length).toBeGreaterThanOrEqual(3);
      const all = CITY.lots.map((t) => trafficPips(s, t)).sort((x, y) => x - y);
      const median = all[Math.floor(all.length / 2)];
      for (const t of lots) expect(trafficPips(s, t)).toBeGreaterThanOrEqual(median);
      // The best-scoring lot in the district leads the list.
      const score = (t: number): number => {
        const bon = lotBonuses(s, t);
        return trafficPips(s, t) + (bon.corner ? 1.5 : 0) + (bon.canal ? 0.4 : 0) + (bon.transit ? 0.3 : 0);
      };
      expect(score(lots[0])).toBe(Math.max(...CITY.lots.map(score)));
      // Deterministic for the same street.
      expect(starterLots(clone(s))).toEqual(lots);
      expect(starterLots(s, 2)).toEqual(lots.slice(0, 2));
    }
  });

  it('moves on as lots are claimed, works on the client’s view, and copes with a nearly full district', () => {
    const s = createGame({ seed: 5, mode: 'standard', players: humans(2) });
    s.players[1].cash = 1e6;
    const first = starterLots(s);
    // A rival takes the best corner: it is no longer offered.
    build(s, 1, first[0] % 12, Math.floor(first[0] / 12), 'roastery');
    const next = starterLots(s);
    expect(next).not.toContain(first[0]);
    expect(next).toHaveLength(4);
    // The HUD computes the same lots from its snapshot view.
    const view = new CityView();
    view.apply(clone(new SnapEncoder().encode(s, true)));
    expect(starterLots(view)).toEqual(next);
    // Fill the district but for three lots: the guide offers those three and no more.
    const free = CITY.lots.filter((t) => !s.buildings.some((b) => b.tile === t));
    for (const t of free.slice(3)) build(s, 1, t % 12, Math.floor(t / 12), 'park');
    const left = starterLots(s);
    expect(left.slice().sort((a, b) => a - b)).toEqual(free.slice(0, 3).sort((a, b) => a - b));
    for (const t of free.slice(0, 3)) build(s, 1, t % 12, Math.floor(t / 12), 'park');
    expect(starterLots(s)).toEqual([]);
  });
});

// ───────────────────────────── Milestone progress ─────────────────────────────

describe('Dynasty Milestone progress pill', () => {
  const house = (over: Partial<Parameters<typeof milestoneProgress>[1]> = {}) => ({
    id: 0, milestones: [-1, -1, -1, -1], served: 0, civicBuilt: 0, prestige: 0, netWorth: 900, share: 0, ...over,
  });
  const world = (quarter: number, tiles: number[] = [], owner = 0) => ({ quarter, buildings: tiles.map((tile) => ({ tile, owner })) });

  it('reports each milestone’s name, goal, reward and how far the House has come', () => {
    const rows = milestoneProgress(world(1), house());
    expect(rows.map((r) => r.name)).toEqual(MILESTONES.map((m) => m.name));
    expect(rows.map((r) => r.pill)).toEqual(MILESTONES.map((m) => m.pill));
    expect(rows.map((r) => r.goal)).toEqual(MILESTONES.map((m) => m.goal));
    expect(rows.every((r) => !r.done)).toBe(true);
    expect(rows.map((r) => r.detail)).toEqual(['0/25 served', '0/3 properties', '0/2 civic · 0/18 prestige', 'Opens in Era III']);
    expect(rows[0].progress).toBe(0);
    // Charter Merchant: citizens served.
    const serving = milestoneProgress(world(1), house({ served: 10 }));
    expect(serving[0]).toMatchObject({ progress: 0.4, detail: '10/25 served', done: false });
    expect(milestoneProgress(world(1), house({ served: 90 }))[0]).toMatchObject({ progress: 1, detail: '25/25 served' });
    // Block Baron: properties, or an enclave of two.
    expect(milestoneProgress(world(1, [idx(3, 6), idx(9, 6)]), house())[1]).toMatchObject({ detail: '2/3 properties', done: false });
    expect(milestoneProgress(world(1, [idx(3, 6), idx(9, 6)]), house())[1].progress).toBeCloseTo(2 / 3, 9);
    expect(milestoneProgress(world(1, [idx(3, 6), idx(4, 6)]), house())[1].progress).toBe(1);
    expect(milestoneProgress(world(1, [idx(3, 6), idx(4, 6)], 1), house())[1].progress).toBe(0); // a rival's block
    // Civic Benefactor: the nearer of two routes.
    expect(milestoneProgress(world(1), house({ civicBuilt: 1, prestige: 4 }))[2]).toMatchObject({ progress: 0.5, detail: '1/2 civic · 4/18 prestige' });
    expect(milestoneProgress(world(1), house({ civicBuilt: 0, prestige: 13.5 }))[2].progress).toBe(0.75);
    // District Sovereign: shown as waiting before Era III, never as complete.
    const early = milestoneProgress(world(2), house({ netWorth: 5000, share: 0.9 }))[3];
    expect(early).toMatchObject({ detail: 'Opens in Era III', done: false });
    expect(early.progress).toBeLessThan(1);
    const late = milestoneProgress(world(3), house({ netWorth: 1000, share: 0.2 }))[3];
    expect(late.detail).toBe('§1,000/§1,200 · 20%/40%');
    expect(late.progress).toBeCloseTo(1000 / 1200, 9);
    expect(milestoneProgress(world(4), house({ netWorth: 300, share: 0.3 }))[3].progress).toBeCloseTo(0.75, 9);
    // Earned: full, and says so.
    const earned = milestoneProgress(world(1), house({ milestones: [120, -1, 300, -1], served: 3 }));
    expect(earned.map((r) => r.done)).toEqual([true, false, true, false]);
    expect(earned[0]).toMatchObject({ progress: 1, detail: 'Earned' });
    expect(earned[2]).toMatchObject({ progress: 1, detail: 'Earned' });
    for (const r of [...rows, ...serving, ...earned, late, early]) {
      expect(r.progress).toBeGreaterThanOrEqual(0);
      expect(r.progress).toBeLessThanOrEqual(1);
    }
  });

  it('agrees with the simulation on a live match, read through the client view', () => {
    const s = createGame({ seed: 88, mode: 'blitz', players: ais(['vesper', 'aurelia', 'orson']) });
    const enc = new SnapEncoder();
    const view = new CityView();
    view.apply(clone(enc.encode(s, true)));
    let checked = 0;
    play(s, 4 * MODES.blitz.quarterTicks, (g: GameState) => {
      view.apply(clone(enc.encode(g, false)));
      g.fx = [];
      if (g.tick % 60 !== 0) return;
      for (const p of view.players) {
        const rows = milestoneProgress(view, p);
        rows.forEach((r, i) => {
          expect(r.done, `tick ${g.tick} ${p.name} ${r.name}`).toBe(g.players[p.id].milestones[i] >= 0);
          if (r.done) expect(r.progress).toBe(1);
        });
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(100);
    expect(view.players.some((p) => p.milestones.filter((t) => t >= 0).length >= 3)).toBe(true);
  });
});

// ───────────────────────────── Input policy ─────────────────────────────

describe('Input policy: locked tools and the Era Council', () => {
  const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({ phase: 'playing', victoryOpen: false, ended: false, me: 0, kind: 'solo', tool: null, ...over });

  it('answers a locked tool’s hotkey with {a:"locked"} instead of arming it or failing silently', () => {
    BUILD_KINDS.forEach((kind, i) => {
      const key = String(i + 1);
      for (const quarter of [1, 2, 3, 4, 6]) {
        const act = resolveKey(key, ctx({ quarter }));
        if (isUnlocked(kind, quarter)) expect(act, `${kind} in quarter ${quarter}`).toEqual({ a: 'tool', kind });
        else expect(act, `${kind} in quarter ${quarter}`).toEqual({ a: 'locked', kind });
      }
    });
    // Era I: 1 Roastery and 2 Bistro arm; 7 Pocket Park arms; 3 Arcade and 9 Plaza are locked.
    expect(resolveKey('1', ctx({ quarter: 1 }))).toEqual({ a: 'tool', kind: 'roastery' });
    expect(resolveKey('7', ctx({ quarter: 1 }))).toEqual({ a: 'tool', kind: 'park' });
    expect(resolveKey('3', ctx({ quarter: 1 }))).toEqual({ a: 'locked', kind: 'arcade' });
    expect(resolveKey('9', ctx({ quarter: 2 }))).toEqual({ a: 'locked', kind: 'plaza' });
    expect(resolveKey('9', ctx({ quarter: 3 }))).toEqual({ a: 'tool', kind: 'plaza' });
    // Pressing an armed tool's key again still disarms it.
    expect(resolveKey('2', ctx({ quarter: 1, tool: 'bistro' }))).toEqual({ a: 'tool', kind: null });
    // A locked key never disarms what is armed, and a spectator gets nothing at all.
    expect(resolveKey('4', ctx({ quarter: 1, tool: 'bistro' }))).toEqual({ a: 'locked', kind: 'boutique' });
    expect(resolveKey('4', ctx({ quarter: 1, me: -1 }))).toEqual({ a: 'none' });
    // A caller that does not say what era it is gets the plain v1 behaviour.
    expect(resolveKey('4', ctx())).toEqual({ a: 'tool', kind: 'boutique' });
    expect(Object.keys(ERA_UNLOCK)).toHaveLength(9);
  });

  it('swallows build and pause hotkeys while the Era Council is open, but not camera, sound or Escape', () => {
    expect(overlayActive(ctx({ councilOpen: true }))).toBe(true);
    expect(overlayActive(ctx({ councilOpen: false }))).toBe(false);
    expect(overlayActive(ctx())).toBe(false);
    const open = ctx({ councilOpen: true, quarter: 1 });
    for (const key of ['1', '2', '7', '3', '9', ' ']) expect(resolveKey(key, open), JSON.stringify(key)).toEqual({ a: 'none' });
    for (const kind of ['solo', 'multi'] as const) expect(resolveKey(' ', ctx({ councilOpen: true, kind }))).toEqual({ a: 'none' });
    expect(resolveKey('w', open)).toEqual({ a: 'pan' });
    expect(resolveKey('ArrowLeft', open)).toEqual({ a: 'pan' });
    expect(resolveKey('+', open).a).toBe('zoom');
    expect(resolveKey('m', open)).toEqual({ a: 'mute' });
    expect(resolveKey('f', open)).toEqual({ a: 'fit' });
    expect(resolveKey('Escape', open)).toEqual({ a: 'escape' });
    // Closed again: the keys are back.
    expect(resolveKey(' ', ctx({ councilOpen: false }))).toEqual({ a: 'pause' });
    expect(resolveKey('1', ctx({ councilOpen: false, quarter: 2 }))).toEqual({ a: 'tool', kind: 'roastery' });
  });

  it('treats the Council opening and closing as a change of match state, so an armed tool is dropped', () => {
    const base = { ready: true, seed: 9, ended: false, endless: false };
    expect(matchStamp({ ...base, inCouncil: true })).not.toBe(matchStamp({ ...base, inCouncil: false }));
    expect(matchStamp(base)).toBe(matchStamp({ ...base, inCouncil: false }));
    const watch = new MatchWatch();
    expect(watch.changed({ ...base, inCouncil: false })).toBe(false); // first sight
    expect(watch.changed({ ...base, inCouncil: false })).toBe(false);
    expect(watch.changed({ ...base, inCouncil: true })).toBe(true); // the Council opens
    expect(watch.changed({ ...base, inCouncil: true })).toBe(false);
    expect(watch.changed({ ...base, inCouncil: false })).toBe(true); // and rises
    expect(watch.changed({ ...base, inCouncil: false })).toBe(false);
  });
});

// ───────────────────────────── Solo session ─────────────────────────────

describe('Solo session: the Era Council waits for the player, and warp walks through it', () => {
  it('holds at the Council until a charter is chosen and Advance is pressed', () => {
    const session = new LocalSession('solo', soloSetups('Ada', 3), 'blitz', 2024);
    const log: string[] = [];
    session.onAccept = () => log.push('ok');
    session.onReject = (err) => log.push(err);
    // warp(n, hold) stops as the Council opens and reports the ticks actually advanced.
    expect(session.warp(5000, true)).toBe(MODES.blitz.quarterTicks);
    expect(session.view).toMatchObject({ inCouncil: true, quarter: 1, tick: MODES.blitz.quarterTicks, ended: false });
    const council = session.view.council;
    expect(council).toMatchObject({ era: 1, next: 2 });
    expect(council?.offers[0]).toHaveLength(3);
    expect(council?.picks[0]).toBeNull();
    expect(council?.picks.slice(1).every((k) => k !== null)).toBe(true); // the three AI Houses have sealed
    // No amount of frame time moves a solo Council: it waits.
    for (let now = 0; now < 60000; now += 100) session.update(now);
    expect(session.view.tick).toBe(MODES.blitz.quarterTicks);
    expect(session.warp(0, true)).toBe(0);
    // Advance without a charter is refused with a reason.
    session.advanceCouncil();
    expect(log).toEqual(['Choose a Dynasty Charter first']);
    expect(session.view.inCouncil).toBe(true);
    // Building is refused; choosing is accepted and shows at once.
    session.command({ c: 'build', tile: CITY.lots[0], kind: 'bistro' });
    expect(log[1]).toBe('The Era Council is in session');
    const key = (council as NonNullable<typeof council>).offers[0][2];
    session.command({ c: 'charter', key });
    expect(log[2]).toBe('ok');
    expect(session.view.council?.picks[0]).toBe(key);
    expect(session.view.inCouncil).toBe(true); // still waiting for Advance
    session.advanceCouncil();
    expect(session.view).toMatchObject({ inCouncil: false, council: null, quarter: 2, era: 2 });
    expect(session.view.players[0].charters).toEqual([key]);
    expect(session.view.players.slice(1).every((p) => p.charters.length === 1)).toBe(true);
    expect(session.view.chronicle[session.view.chronicle.length - 1]).toMatchObject({ cat: 'era', pill: 'Era II Unlocked' });
    session.advanceCouncil(); // nothing to advance: harmless
    expect(session.view.quarter).toBe(2);
  });

  it('warps deterministically through every era and Council to the final bell', () => {
    const run = (): LocalSession => {
      const session = new LocalSession('solo', soloSetups('Ada', 3), 'blitz', 31337);
      const eras: number[] = [];
      let advanced = 0;
      for (let i = 0; i < 40 && !session.view.ended; i++) {
        advanced += session.warp(100);
        if (!eras.includes(session.view.era)) eras.push(session.view.era);
        expect(session.view.inCouncil).toBe(false); // a plain warp never parks on a Council
      }
      expect(eras).toEqual([1, 2, 3, 4]);
      expect(advanced).toBe(4 * MODES.blitz.quarterTicks);
      return session;
    };
    const a = run();
    const b = run();
    expect(a.view.ended).toBe(true);
    expect(a.view.result?.rows.every((r) => r.charters.length === 3)).toBe(true);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    // The undecided human took the steward's pick at each Council.
    expect(a.state.players[0].charters).toHaveLength(3);
    // After the bell a warp does nothing.
    expect(a.warp(500)).toBe(0);
  });
});

// ───────────────────────────── Heraldry ─────────────────────────────

describe('House heraldry: colour and crest', () => {
  it('gives each House its palette and a distinct geometric crest, per the design', () => {
    expect(HOUSES.map((h) => [h.name, h.color, h.dark, h.crestName])).toEqual([
      ['Vermilion Guild', '#D6453A', '#9F2B23', 'Compass Shield'],
      ['Cobalt Syndicate', '#2667B8', '#184785', 'Harbor Anchor Shield'],
      ['Marigold House', '#D48C1C', '#9C620D', 'Sunburst Crown Shield'],
      ['Emerald Atelier', '#248A63', '#156145', 'Laurel Arch Shield'],
    ]);
    expect(HOUSES.map((h) => h.wash)).toEqual([
      'rgba(214, 69, 58, 0.16)', 'rgba(38, 103, 184, 0.16)', 'rgba(212, 140, 28, 0.17)', 'rgba(36, 138, 99, 0.16)',
    ]);
    expect(HOUSES.map((h) => h.crest)).toEqual(['compass', 'anchor', 'sunburst', 'laurel']);
    expect(Object.keys(CREST_SHAPES).sort()).toEqual(['anchor', 'compass', 'laurel', 'sunburst']);
    // Four different emblems: no two crests share their geometry.
    const geometry = HOUSES.map((h) => CREST_SHAPES[h.crest].map((s) => s.d).join('|'));
    expect(new Set(geometry).size).toBe(4);
    for (const h of HOUSES) {
      expect(CREST_SHAPES[h.crest].length).toBeGreaterThanOrEqual(2);
      for (const shape of CREST_SHAPES[h.crest]) {
        expect(shape.d).toMatch(/^M/);
        // Every coordinate stays inside the 24×24 crest box.
        for (const n of shape.d.match(/-?\d+(\.\d+)?/g) ?? []) expect(Math.abs(Number(n))).toBeLessThanOrEqual(CREST_BOX);
      }
    }
    expect(SHIELD.startsWith('M4 2.5')).toBe(true);
    expect(SHIELD_SHADE.startsWith('M12 2.5')).toBe(true);
  });

  it('renders each crest as labelled inline SVG in the House colour — no emoji, no image files', () => {
    const svgs = HOUSES.map((_, i) => crestSvg(i));
    expect(new Set(svgs).size).toBe(4);
    HOUSES.forEach((h, i) => {
      const svg = svgs[i];
      expect(svg.startsWith('<svg class="hcrest"')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain(`data-crest="${h.crest}"`);
      expect(svg).toContain(`fill="${h.color}"`);
      expect(svg).toContain(`fill="${h.dark}"`);
      expect(svg).toContain(`role="img" aria-label="${h.name} crest: ${h.crestName}"`);
      expect(svg).toContain(`<title>${h.name} — ${h.crestName}</title>`);
      for (const shape of CREST_SHAPES[h.crest]) expect(svg).toContain(`d="${shape.d}"`);
      expect(svg).not.toMatch(/<image|href=|[\u{1F300}-\u{1FAFF}]/u);
    });
    // Decorative and gilded variants.
    const quiet = crestSvg(1, { quiet: true, cls: 'sm' });
    expect(quiet).toContain('class="hcrest sm"');
    expect(quiet).toContain('aria-hidden="true"');
    expect(quiet).not.toContain('<title>');
    expect(crestSvg(2, { gilded: true })).toContain('class="hcrest gilded"');
    expect(crestSvg(2, { gilded: true })).toContain('stroke="#D4A34A"');
    expect(crestSvg(2)).not.toContain('stroke="#D4A34A"');
    // A house index wraps rather than throwing.
    expect(crestSvg(5)).toBe(crestSvg(1));
    expect(crestSvg(-1)).toBe(crestSvg(3));
  });

  it('draws one brass star pip per Dynasty Milestone earned', () => {
    for (let n = 0; n <= 4; n++) {
      const pips = starPips(n);
      expect((pips.match(/class="mstar[ "]/g) ?? []).length).toBe(4);
      expect((pips.match(/class="mstar on/g) ?? []).length).toBe(n);
      expect(pips).toContain(`aria-label="${n} of 4 Dynasty Milestones"`);
    }
    // The fourth (District Sovereign) is the grand one.
    expect((starPips(4).match(/grand/g) ?? []).length).toBe(1);
    expect(starPips(4)).toContain('class="mstar on grand"');
    expect(starPips(3)).toContain('class="mstar grand"');
    expect((starPips(1, 2).match(/class="mstar[ "]/g) ?? []).length).toBe(2);
  });
});
