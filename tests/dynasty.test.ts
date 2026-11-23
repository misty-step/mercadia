// Dynasty Charters (permanent doctrines with real mechanical effects) and the four cumulative
// Dynasty Milestones, down to the § — including the ledger that reconciles their dividends.
import { describe, expect, it, vi } from 'vitest';
import { advance } from '../src/shared/ai';
import {
  AUTO_RESTOCK_PREMIUM,
  CHARTERS,
  CHARTER_KEYS,
  CIVICS,
  LOAN_RATE,
  LOAN_STEP,
  MILESTONES,
  MILESTONE_CIVICS,
  MILESTONE_PRESTIGE,
  MILESTONE_PROPERTIES,
  MILESTONE_SERVED,
  MILESTONE_SHARE,
  MILESTONE_SOVEREIGN_ERA,
  MILESTONE_WORTH,
  PAYROLL_TICKS,
  PROMO_COOLDOWN,
  PROMO_COST,
  PROMO_TICKS,
  SHOPS,
  START_CASH,
  SUPPLY_CRUNCH,
  UPGRADE_COST,
  buildCost,
} from '../src/shared/constants';
import { CITY, idx, manhattan } from '../src/shared/map';
import {
  applyCommand,
  buildCostFor,
  charterMod,
  charterOffers,
  closeCouncil,
  createGame,
  emptyLedger,
  forceEvent,
  hasEnclave,
  ledgerCashChange,
  ledgerFinancing,
  ledgerNet,
  marketShares,
  milestoneMet,
  netWorth,
  promoCooldownFor,
  promoCostFor,
  restockCost,
  salvageValue,
  shopQuality,
  shopScore,
  starsOf,
  tick,
  unitSupplyCost,
  upgradeCost,
  wageOf,
} from '../src/shared/sim';
import type { CharterKey, GameState, Ledger, MatchMode } from '../src/shared/types';
import { ais, build, clone, freeze, fxOf, labGame, run, toEraClose } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const MIDDLE = idx(6, 7);
const canalLot = CITY.lots.find((t) => CITY.canalFront[t]) as number;
const plainLot = CITY.lots.find((t) => !CITY.canalFront[t] && !CITY.corner[t]) as number;
const xy = (t: number): [number, number] => [t % 12, Math.floor(t / 12)];
/** Give a House a charter directly: the state the Era Council leaves behind. */
const grant = (s: GameState, player: number, ...keys: CharterKey[]): void => {
  s.players[player].charters.push(...keys);
};

// ───────────────────────────── Charters ─────────────────────────────

describe('Dynasty Charters: the table', () => {
  it('lists six doctrines, each with a name, an exact impact tag and at least one real lever', () => {
    expect(CHARTER_KEYS.slice().sort()).toEqual(['artisanry', 'canal', 'credit', 'heralds', 'provisioners', 'transit']);
    expect(CHARTERS.artisanry.name).toBe('Guild Artisanry');
    expect(CHARTERS.transit.name).toBe('Transit Patronage');
    expect(CHARTERS.credit.name).toBe('Merchant Credit');
    expect(CHARTERS.canal.name).toBe('Canal Showcase');
    const levers = ['quality', 'upgrade', 'civicCost', 'civicPrestige', 'interest', 'wages', 'frontage', 'tourist', 'promoCost', 'promoCooldown', 'supplies'] as const;
    for (const key of CHARTER_KEYS) {
      const def = CHARTERS[key];
      expect(def.key).toBe(key);
      expect(def.pill.length).toBeGreaterThan(8);
      expect(def.blurb.length).toBeGreaterThan(20);
      expect(def.doctrine.length).toBeGreaterThan(3);
      const moved = levers.filter((l) => def[l] !== 1).length + (def.adoptPrestige > 0 ? 1 : 0) + (def.autoPremium ? 0 : 1);
      expect(moved, key).toBeGreaterThanOrEqual(2);
      // Every lever helps: nothing in a charter is a penalty.
      for (const l of ['quality', 'civicPrestige', 'frontage', 'tourist'] as const) expect(def[l], `${key}.${l}`).toBeGreaterThanOrEqual(1);
      for (const l of ['upgrade', 'civicCost', 'interest', 'wages', 'promoCost', 'promoCooldown', 'supplies'] as const) expect(def[l], `${key}.${l}`).toBeLessThanOrEqual(1);
    }
    // The six are distinct doctrines: no two move the same set of levers.
    const signature = (k: CharterKey): string => levers.filter((l) => CHARTERS[k][l] !== 1).join('+');
    expect(new Set(CHARTER_KEYS.map(signature)).size).toBe(CHARTER_KEYS.length);
  });

  it('combines a House’s charters by multiplication, and leaves a House without any at exactly 1', () => {
    expect(charterMod(null, 'quality')).toBe(1);
    expect(charterMod(undefined, 'wages')).toBe(1);
    expect(charterMod({}, 'wages')).toBe(1);
    expect(charterMod({ charters: [] }, 'interest')).toBe(1);
    expect(charterMod({ charters: ['artisanry'] }, 'quality')).toBe(1.08);
    expect(charterMod({ charters: ['artisanry'] }, 'wages')).toBe(1);
    expect(charterMod({ charters: ['credit', 'artisanry', 'heralds'] }, 'wages')).toBe(0.85);
    expect(charterMod({ charters: ['artisanry', 'canal'] }, 'quality') * charterMod({ charters: ['artisanry', 'canal'] }, 'frontage')).toBeCloseTo(1.08 * 1.1, 12);
    // A charter key from some future build is ignored rather than poisoning the arithmetic.
    expect(charterMod({ charters: ['guildhall' as CharterKey, 'credit'] }, 'interest')).toBe(0.5);
  });
});

describe('Dynasty Charters: each one changes the numbers', () => {
  it('Guild Artisanry: +8% quality on every shop of that House, and upgrades 20% cheaper', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const mine = build(s, 0, ...xy(plainLot), 'bistro');
    const theirs = build(s, 1, ...xy(canalLot), 'bistro');
    const q0 = [shopQuality(s, mine), shopQuality(s, theirs)];
    const score0 = shopScore(s, mine, 'foodie', MIDDLE);
    expect(upgradeCost(mine, s.players[0])).toBe(Math.round(SHOPS.bistro.cost * UPGRADE_COST[0]));
    grant(s, 0, 'artisanry');
    expect(shopQuality(s, mine) / q0[0]).toBeCloseTo(1.08, 12);
    expect(shopQuality(s, theirs)).toBe(q0[1]); // a rival gains nothing from it
    expect(shopScore(s, mine, 'foodie', MIDDLE)).toBeGreaterThan(score0);
    // Upgrades: the quoted cost and the cash actually taken.
    const cost = Math.round(SHOPS.bistro.cost * UPGRADE_COST[0] * 0.8);
    expect(upgradeCost(mine, s.players[0])).toBe(cost);
    expect(upgradeCost(mine)).toBe(Math.round(SHOPS.bistro.cost * UPGRADE_COST[0])); // list price, no owner given
    expect(applyCommand(s, 0, { c: 'upgrade', id: mine.id }).ok).toBe(true);
    expect(s.players[0].cash).toBe(5000 - SHOPS.bistro.cost - cost);
    expect(s.players[0].ledger.construction).toBe(SHOPS.bistro.cost + cost);
    expect(mine.invested).toBe(SHOPS.bistro.cost + cost);
    expect(applyCommand(s, 1, { c: 'upgrade', id: theirs.id }).ok).toBe(true);
    expect(s.players[1].ledger.construction).toBe(SHOPS.bistro.cost + Math.round(SHOPS.bistro.cost * UPGRADE_COST[0]));
  });

  it('Transit Patronage: civic projects 25% cheaper, +3 Prestige on adoption, and +50% prestige from civic use', () => {
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    grant(s, 0, 'transit');
    expect(buildCostFor(s.players[0], 'park')).toBe(120);
    expect(buildCostFor(s.players[0], 'tramstop')).toBe(180);
    expect(buildCostFor(s.players[0], 'plaza')).toBe(255);
    expect(buildCostFor(s.players[1], 'park')).toBe(CIVICS.park.cost);
    for (const kind of ['roastery', 'bistro', 'arcade', 'boutique', 'cinema', 'nightmarket'] as const) expect(buildCostFor(s.players[0], kind)).toBe(buildCost(kind));
    const park = build(s, 0, 4, 6, 'park');
    expect(s.players[0].cash).toBe(5000 - 120);
    expect(s.players[0].ledger.civic).toBe(120);
    expect(park.invested).toBe(120);
    expect(salvageValue(park)).toBe(72);
    expect(s.players[0].prestige).toBe(CIVICS.park.prestige); // the dedication itself is worth the same
    // A purse that covers the discounted price is enough.
    const avenue = CITY.lots.filter((t) => CITY.avenueAdj[t] >= 0 && t !== park.tile);
    s.players[0].cash = 180;
    expect(applyCommand(s, 0, { c: 'build', tile: avenue[0], kind: 'tramstop' }).ok).toBe(true);
    expect(s.players[0].cash).toBe(0);
    s.players[1].cash = 180;
    expect(applyCommand(s, 1, { c: 'build', tile: avenue[1], kind: 'tramstop' })).toEqual({ ok: false, err: 'Not enough cash' });

    // Civic use: two identical districts, one House chartered in the second. Nothing else differs,
    // so every linger, tram call and aura sale pays exactly half as much again.
    const base = labGame({ era: 2, seed: 19, cash: 5000 });
    build(base, 0, 3, 6, 'roastery');
    build(base, 0, 4, 6, 'park');
    build(base, 0, ...xy(CITY.lots.find((t) => CITY.avenueAdj[t] >= 0 && t !== idx(3, 6) && t !== idx(4, 6)) as number), 'tramstop');
    const built = base.players[0].prestige;
    const plain = clone(base);
    const patron = clone(base);
    grant(patron, 0, 'transit');
    run(plain, 900);
    run(patron, 900);
    const earned = plain.players[0].prestige - built;
    expect(earned).toBeGreaterThan(1);
    expect(patron.players[0].prestige - built).toBeCloseTo(earned * 1.5, 6);
    expect(patron.players[0].cash).toBe(plain.players[0].cash);
    expect(patron.players[1].prestige).toBe(plain.players[1].prestige);

    // Adoption through the Council: +3 Prestige, once.
    let seed = 1;
    while (!charterOffers({ seed }, { id: 0, charters: [] }, 1).includes('transit')) seed++;
    const c = freeze(labGame({ seed, mode: 'blitz' }));
    toEraClose(c);
    expect(applyCommand(c, 0, { c: 'charter', key: 'transit' }).ok).toBe(true);
    closeCouncil(c);
    expect(c.players[0].charters).toEqual(['transit']);
    expect(c.players[0].prestige).toBe(3);
    expect(CHARTERS.transit.adoptPrestige).toBe(3);
  });

  it('Merchant Credit: loan interest halved and wages 15% leaner, payroll after payroll', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const shop = build(s, 0, 3, 6, 'bistro');
    build(s, 1, 4, 6, 'bistro');
    for (const p of [0, 1]) expect(applyCommand(s, p, { c: 'borrow' }).ok).toBe(true);
    grant(s, 0, 'credit');
    expect(wageOf(shop)).toBe(SHOPS.bistro.wage);
    expect(wageOf(shop, s.players[0])).toBeCloseTo(SHOPS.bistro.wage * 0.85, 12);
    expect(wageOf({ kind: 'bistro', level: 3 }, s.players[0])).toBeCloseTo(Math.round(SHOPS.bistro.wage * 1.4) * 0.85, 12);
    const cash = s.players.map((p) => p.cash);
    run(s, PAYROLL_TICKS);
    const [mine, theirs] = s.players;
    expect(theirs.ledger.wages).toBe(SHOPS.bistro.wage);
    expect(theirs.ledger.interest).toBeCloseTo(LOAN_STEP * LOAN_RATE, 12);
    expect(mine.ledger.wages).toBeCloseTo(SHOPS.bistro.wage * 0.85, 12);
    expect(mine.ledger.interest).toBeCloseTo(LOAN_STEP * LOAN_RATE * 0.5, 12);
    expect(mine.ledger.rent).toBe(theirs.ledger.rent); // rent is not part of the doctrine
    // The saving is real money, every payroll.
    const saving = SHOPS.bistro.wage * 0.15 + LOAN_STEP * LOAN_RATE * 0.5;
    expect(mine.cash - cash[0] - (theirs.cash - cash[1])).toBeCloseTo(saving, 9);
    run(s, 4 * PAYROLL_TICKS);
    expect(mine.cash - cash[0] - (theirs.cash - cash[1])).toBeCloseTo(5 * saving, 9);
    // And the books still reconcile to the cent.
    for (const p of s.players) expect(p.cash).toBeCloseTo(5000 + ledgerCashChange(p.totalLedger), 9);
  });

  it('Canal Showcase: +10% quality on canal-front lots and inside a plaza aura, +15% pull on tourists everywhere', () => {
    expect(CITY.canalFront[canalLot] && !CITY.canalFront[plainLot]).toBe(true);
    const s = freeze(labGame({ era: 3, cash: 9000 }));
    const onCanal = build(s, 0, ...xy(canalLot), 'bistro');
    const inland = build(s, 0, ...xy(plainLot), 'bistro');
    const q0 = [shopQuality(s, onCanal), shopQuality(s, inland)];
    const tourist0 = shopScore(s, inland, 'tourist', MIDDLE);
    const local0 = shopScore(s, inland, 'local', MIDDLE);
    const canalTourist0 = shopScore(s, onCanal, 'tourist', MIDDLE);
    grant(s, 0, 'canal');
    expect(shopQuality(s, onCanal) / q0[0]).toBeCloseTo(1.1, 12);
    expect(shopQuality(s, inland)).toBe(q0[1]); // no water, no plaza: no lift
    // Tourists are drawn to every door of the House; locals are not swayed inland.
    expect(shopScore(s, inland, 'tourist', MIDDLE) / tourist0).toBeCloseTo(1.15, 12);
    expect(shopScore(s, inland, 'local', MIDDLE)).toBe(local0);
    // On the water both levers stack for a tourist: the pull, and the showcase quality.
    expect(shopScore(s, onCanal, 'tourist', MIDDLE) / canalTourist0).toBeGreaterThan(1.15 * 1.1);
    // A Festival Plaza within two tiles brings the inland shop into the showcase too.
    const beside = CITY.lots.find((t) => t !== plainLot && t !== canalLot && Math.max(Math.abs((t % 12) - (plainLot % 12)), Math.abs(Math.floor(t / 12) - Math.floor(plainLot / 12))) <= 2) as number;
    build(s, 1, ...xy(beside), 'plaza');
    const withPlaza = shopQuality(s, inland);
    s.players[0].charters = [];
    expect(withPlaza / shopQuality(s, inland)).toBeCloseTo(1.1, 12);
  });

  it('Market Heralds: a Promo Blitz for §60 instead of §80, and ready again a quarter sooner', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const mine = build(s, 0, 3, 6, 'roastery');
    const theirs = build(s, 1, 9, 6, 'roastery');
    grant(s, 0, 'heralds');
    expect(promoCostFor(s.players[0])).toBe(60);
    expect(promoCostFor(s.players[1])).toBe(PROMO_COST);
    expect(promoCooldownFor(s.players[0])).toBe(300);
    expect(promoCooldownFor(s.players[1])).toBe(PROMO_COOLDOWN);
    const cash = s.players.map((p) => p.cash);
    expect(applyCommand(s, 0, { c: 'promo', id: mine.id }).ok).toBe(true);
    expect(applyCommand(s, 1, { c: 'promo', id: theirs.id }).ok).toBe(true);
    expect(cash[0] - s.players[0].cash).toBe(60);
    expect(cash[1] - s.players[1].cash).toBe(PROMO_COST);
    expect(s.players[0].ledger.marketing).toBe(60);
    // The blitz itself runs as long; the wait after it is shorter.
    expect(mine.promoUntil).toBe(theirs.promoUntil);
    expect(mine.promoUntil).toBe(s.tick + PROMO_TICKS);
    expect(mine.promoReadyAt).toBe(mine.promoUntil + 300);
    expect(theirs.promoReadyAt).toBe(theirs.promoUntil + PROMO_COOLDOWN);
    run(s, PROMO_TICKS + 300);
    expect(applyCommand(s, 0, { c: 'promo', id: mine.id }).ok).toBe(true);
    expect(applyCommand(s, 1, { c: 'promo', id: theirs.id })).toEqual({ ok: false, err: 'Promo Blitz is cooling down' });
    // A purse of exactly the discounted price is enough.
    const poor = freeze(labGame({ cash: SHOPS.roastery.cost + 60 }));
    const shop = build(poor, 0, 3, 6, 'roastery');
    expect(applyCommand(poor, 0, { c: 'promo', id: shop.id })).toEqual({ ok: false, err: 'Not enough cash' });
    grant(poor, 0, 'heralds');
    expect(applyCommand(poor, 0, { c: 'promo', id: shop.id }).ok).toBe(true);
    expect(poor.players[0].cash).toBe(0);
  });

  it('Harbor Provisioners: supplies 15% cheaper and Auto-Restock without its convenience premium', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const mine = build(s, 0, 3, 6, 'roastery');
    const theirs = build(s, 1, 9, 6, 'roastery');
    grant(s, 0, 'provisioners');
    const unit = SHOPS.roastery.unitCost;
    expect(unitSupplyCost(s, 'roastery', false, s.players[0])).toBeCloseTo(unit * 0.85, 12);
    expect(unitSupplyCost(s, 'roastery', true, s.players[0])).toBeCloseTo(unit * 0.85, 12); // no premium at all
    expect(unitSupplyCost(s, 'roastery', false, s.players[1])).toBe(unit);
    expect(unitSupplyCost(s, 'roastery', true, s.players[1])).toBeCloseTo(unit * AUTO_RESTOCK_PREMIUM, 12);
    expect(unitSupplyCost(s, 'roastery', true)).toBeCloseTo(unit * AUTO_RESTOCK_PREMIUM, 12);
    // Manual restock of ten units: §26 against §30.
    mine.stock -= 10;
    theirs.stock -= 10;
    expect(restockCost(s, mine, false, s.players[0])).toBe(Math.ceil(10 * unit * 0.85));
    expect(restockCost(s, theirs, false, s.players[1])).toBe(10 * unit);
    const cash = s.players.map((p) => p.cash);
    for (const [p, b] of [[0, mine], [1, theirs]] as const) expect(applyCommand(s, p, { c: 'restock', id: b.id }).ok).toBe(true);
    expect(cash[0] - s.players[0].cash).toBe(26);
    expect(cash[1] - s.players[1].cash).toBe(30);
    expect(s.players[0].ledger.supplies).toBe(26);
    expect(mine.stock).toBe(SHOPS.roastery.stockMax);
    // Auto-Restock at the reorder point: 32 units for §82 against §111.
    mine.stock = 8;
    theirs.stock = 8;
    tick(s);
    expect(mine.stock).toBe(SHOPS.roastery.stockMax);
    expect(s.players[0].ledger.supplies - 26).toBe(Math.ceil(32 * unit * 0.85));
    expect(s.players[1].ledger.supplies - 30).toBe(Math.ceil(32 * unit * AUTO_RESTOCK_PREMIUM));
    // A Supply Crunch still bites, but from the lower base.
    forceEvent(s, 'supplycrunch', 100);
    expect(unitSupplyCost(s, 'roastery', false, s.players[0])).toBeCloseTo(unit * SUPPLY_CRUNCH * 0.85, 12);
    expect(unitSupplyCost(s, 'roastery', true, s.players[0])).toBeCloseTo(unit * SUPPLY_CRUNCH * 0.85, 12);
  });

  it('keeps a charter for the rest of the match: it is permanent, never offered twice, and survives a checkpoint', () => {
    const s = freeze(labGame({ mode: 'blitz' }));
    const held: CharterKey[][] = [[], []];
    for (let era = 1; era <= 3; era++) {
      toEraClose(s);
      const c = s.council as NonNullable<GameState['council']>;
      c.offers.forEach((offer, p) => {
        for (const k of offer) expect(held[p]).not.toContain(k);
      });
      const key = c.offers[0][1];
      applyCommand(s, 0, { c: 'charter', key });
      held[0].push(key);
      held[1].push(c.offers[1][0]);
      closeCouncil(s);
      expect(s.players.map((p) => p.charters)).toEqual(held);
      const restored = clone(s);
      expect(restored.players.map((p) => p.charters)).toEqual(held);
    }
    toEraClose(s);
    expect(s.phase).toBe('ended');
    expect(s.result?.rows.map((r) => r.charters)).toEqual(held);
  });
});

// ───────────────────────────── Milestones ─────────────────────────────

describe('Dynasty Milestones: the table', () => {
  it('names four cumulative thresholds with their exact rewards', () => {
    expect(MILESTONES.map((m) => [m.key, m.name, m.cash, m.prestige, m.pill])).toEqual([
      ['merchant', 'Charter Merchant', 80, 0, '+§80'],
      ['baron', 'Block Baron', 0, 4, '+4 Prestige'],
      ['benefactor', 'Civic Benefactor', 120, 4, '+§120 · +4 Prestige'],
      ['sovereign', 'District Sovereign', 0, 6, '+6 Prestige'],
    ]);
    expect([MILESTONE_SERVED, MILESTONE_PROPERTIES, MILESTONE_CIVICS, MILESTONE_PRESTIGE, MILESTONE_WORTH, MILESTONE_SHARE, MILESTONE_SOVEREIGN_ERA]).toEqual([25, 3, 2, 18, 1200, 0.4, 3]);
    const fresh = createGame({ seed: 1, mode: 'standard', players: ais(['vesper', 'orson']) });
    for (const p of fresh.players) {
      expect(p.milestones).toEqual([-1, -1, -1, -1]);
      expect(starsOf(p)).toBe(0);
      expect(p.charters).toEqual([]);
      expect(milestoneMet(fresh, p)).toEqual([false, false, false, false]);
    }
    expect(starsOf({})).toBe(0);
    expect(starsOf({ milestones: [5, -1, 0, -1] })).toBe(2);
  });
});

describe('Dynasty Milestones: thresholds and rewards', () => {
  const live = (o: Parameters<typeof labGame>[0] = {}): GameState => freeze(labGame({ milestones: true, ...o }));
  /** The most recent Milestone dispatch (a lead change may be printed in the same breath). */
  const latest = (s: GameState) => s.chronicle.filter((d) => d.cat === 'milestone').slice(-1)[0];
  const stars = (s: GameState): number => s.fx.filter((f) => f.k === 'milestone').length;

  it('Charter Merchant: the 25th citizen served pays a §80 dividend and the first Crest star — once', () => {
    const s = live();
    const p = s.players[0];
    p.stats.served = MILESTONE_SERVED - 1;
    run(s, 20);
    expect(p.milestones).toEqual([-1, -1, -1, -1]);
    expect(p.cash).toBe(START_CASH);
    p.stats.served = MILESTONE_SERVED;
    s.fx = [];
    run(s, 5);
    expect(p.milestones).toEqual([s.tick, -1, -1, -1]);
    expect(p.cash).toBe(START_CASH + 80);
    expect(p.prestige).toBe(0);
    expect(p.ledger.dividends).toBe(80);
    expect(p.totalLedger.dividends).toBe(80);
    expect(p.totalLedger.awards).toBe(0); // dividends have a line of their own
    expect(ledgerNet(p.totalLedger)).toBe(80);
    expect(starsOf(p)).toBe(1);
    expect(fxOf(s.fx, 'milestone')).toEqual([{ k: 'milestone', p: 0, m: 0 }]);
    expect(latest(s)).toMatchObject({ cat: 'milestone', tier: 1, head: 'Vermilion earns Charter Merchant', pill: '+§80 · ★1', player: 0 });
    expect(s.gazette[s.gazette.length - 1].text).toContain('Charter Merchant');
    // It is never paid twice, however many more are served.
    s.fx = [];
    p.stats.served = 400;
    run(s, 200);
    expect(p.cash).toBe(START_CASH + 80);
    expect(p.totalLedger.dividends).toBe(80);
    expect(stars(s)).toBe(0);
    expect(s.chronicle.filter((d) => d.cat === 'milestone')).toHaveLength(1);
    // The rival, who served nobody, has nothing.
    expect(s.players[1]).toMatchObject({ cash: START_CASH, milestones: [-1, -1, -1, -1] });
  });

  it('Block Baron: three properties, or two lots sharing an edge, earn +4 Prestige — a diagonal or a rival’s lot does not count', () => {
    // Two shops apart: nothing. A third property anywhere: Baron.
    const spread = live();
    build(spread, 0, 3, 6, 'roastery');
    build(spread, 0, 9, 6, 'roastery');
    expect(manhattan(idx(3, 6), idx(9, 6))).toBeGreaterThan(1);
    run(spread, 20);
    expect(hasEnclave(spread, 0)).toBe(false);
    expect(spread.players[0].milestones[1]).toBe(-1);
    build(spread, 0, 3, 2, 'roastery');
    spread.fx = [];
    run(spread, 5);
    expect(spread.players[0].milestones[1]).toBe(spread.tick);
    expect(spread.players[0].prestige).toBe(4);
    expect(spread.players[0].totalLedger.dividends).toBe(0); // prestige, not cash
    expect(spread.players[0].cash).toBe(START_CASH - 3 * SHOPS.roastery.cost);
    expect(fxOf(spread.fx, 'milestone')).toEqual([{ k: 'milestone', p: 0, m: 1 }]);
    expect(latest(spread)).toMatchObject({ cat: 'milestone', head: 'Vermilion earns Block Baron', pill: '+4 Prestige · ★1', player: 0 });
    // Two adjacent lots: an enclave, and Baron at once.
    const block = live();
    build(block, 0, 3, 6, 'roastery');
    build(block, 0, 4, 6, 'roastery');
    expect(manhattan(idx(3, 6), idx(4, 6))).toBe(1);
    expect(hasEnclave(block, 0)).toBe(true);
    expect(hasEnclave(block, 1)).toBe(false);
    run(block, 5);
    expect(block.players[0].milestones[1]).toBe(block.tick);
    expect(block.players[0].prestige).toBe(4);
    // Diagonal neighbours touch only at a corner.
    let diag: [number, number] | null = null;
    for (const a of CITY.lots) for (const b of CITY.lots) if (!diag && Math.abs((a % 12) - (b % 12)) === 1 && Math.abs(Math.floor(a / 12) - Math.floor(b / 12)) === 1) diag = [a, b];
    const corner = live();
    const [da, db] = diag as [number, number];
    build(corner, 0, ...xy(da), 'roastery');
    build(corner, 0, ...xy(db), 'roastery');
    run(corner, 20);
    expect(hasEnclave(corner, 0)).toBe(false);
    expect(corner.players[0].milestones[1]).toBe(-1);
    // A rival next door makes a border, not an enclave.
    const border = live();
    build(border, 0, 3, 6, 'roastery');
    build(border, 1, 4, 6, 'roastery');
    run(border, 20);
    expect(border.players.map((p) => p.milestones[1])).toEqual([-1, -1]);
    expect(border.players.map((p) => p.prestige)).toEqual([0, 0]);
  });

  it('Civic Benefactor: two civic projects, or 18 Civic Prestige, pay §120 and +4 Prestige', () => {
    const builder = live();
    const p = builder.players[0];
    build(builder, 0, 3, 6, 'park');
    run(builder, 20);
    expect(p.milestones[2]).toBe(-1);
    build(builder, 0, 9, 6, 'park');
    run(builder, 5);
    expect(p.milestones[2]).toBe(builder.tick);
    expect(p.cash).toBe(START_CASH - 2 * CIVICS.park.cost + 120);
    expect(p.prestige).toBe(2 * CIVICS.park.prestige + 4);
    expect(p.totalLedger).toMatchObject({ dividends: 120, civic: 2 * CIVICS.park.cost });
    expect(latest(builder)).toMatchObject({ cat: 'milestone', head: 'Vermilion earns Civic Benefactor', pill: '+§120 · +4 Prestige · ★1', player: 0 });
    expect(p.milestones[1]).toBe(-1); // two properties apart are not a block
    // The prestige route: 18 on the nose.
    const patron = live();
    const q = patron.players[1];
    q.prestige = MILESTONE_PRESTIGE - 0.1;
    run(patron, 20);
    expect(q.milestones[2]).toBe(-1);
    q.prestige = MILESTONE_PRESTIGE;
    run(patron, 5);
    expect(q.milestones[2]).toBe(patron.tick);
    expect(q.prestige).toBe(MILESTONE_PRESTIGE + 4);
    expect(q.cash).toBe(START_CASH + 120);
    expect(latest(patron)).toMatchObject({ head: 'Cobalt earns Civic Benefactor', player: 1 });
  });

  it('District Sovereign: §1,200 Net Worth or 40% Market Share earns +6 Prestige — but only in Era III and IV', () => {
    for (const era of [1, 2]) {
      const early = live({ era, cash: 5000 });
      early.players[0].recentRev = 100; // 100% of the market, and rich: still too soon
      run(early, 30);
      expect(netWorth(early, early.players[0])).toBeGreaterThan(MILESTONE_WORTH);
      expect(marketShares(early)[0]).toBe(1);
      expect(early.players[0].milestones[3], `era ${era}`).toBe(-1);
      expect(milestoneMet(early, early.players[0])[3]).toBe(false);
    }
    // Net worth, to the §.
    const rich = live({ era: 3, players: 3 });
    rich.players[0].cash = MILESTONE_WORTH;
    rich.players[1].cash = MILESTONE_WORTH - 1;
    rich.fx = [];
    run(rich, 5);
    expect(rich.players.map((p) => p.milestones[3] >= 0)).toEqual([true, false, false]);
    expect(rich.players[0].prestige).toBe(6);
    expect(rich.players[0].cash).toBe(MILESTONE_WORTH); // prestige, not cash
    expect(fxOf(rich.fx, 'milestone')).toEqual([{ k: 'milestone', p: 0, m: 3 }]);
    expect(latest(rich)).toMatchObject({ cat: 'milestone', head: 'Vermilion earns District Sovereign', pill: '+6 Prestige · ★1', player: 0 });
    // Market share: 61% qualifies, 39% does not.
    const busy = live({ era: 4, players: 3 });
    busy.players[0].recentRev = 61;
    busy.players[1].recentRev = 39;
    run(busy, 5);
    expect(marketShares(busy)[0]).toBeCloseTo(0.61, 9);
    expect(busy.players.map((p) => p.milestones[3] >= 0)).toEqual([true, false, false]);
    expect(busy.players[0].prestige).toBe(6);
    // The moment Era III opens, a House that already qualifies is recognised.
    const waiting = live({ era: 2, cash: 2000, mode: 'blitz' });
    toEraClose(waiting);
    expect(waiting.players[0].milestones[3]).toBe(-1);
    closeCouncil(waiting);
    run(waiting, 5);
    expect(waiting.players.map((p) => p.milestones[3])).toEqual([waiting.tick, waiting.tick]);
  });

  it('counts stars cumulatively in any order, tags each dispatch with the running total, and reports them in the result', () => {
    const s = live({ era: 3, mode: 'blitz', cash: 5000 });
    const p = s.players[0];
    run(s, 5); // rich in Era III: Sovereign comes first here
    expect(p.milestones.map((t) => t >= 0)).toEqual([false, false, false, true]);
    expect(latest(s).pill).toBe('+6 Prestige · ★1');
    build(s, 0, 3, 6, 'park');
    build(s, 0, 4, 6, 'park');
    run(s, 5); // two adjacent civic lots: Baron and Benefactor on the same tick
    expect(p.milestones.map((t) => t >= 0)).toEqual([false, true, true, true]);
    expect(s.chronicle.filter((d) => d.cat === 'milestone').slice(-2).map((d) => d.pill)).toEqual(['+4 Prestige · ★2', '+§120 · +4 Prestige · ★3']);
    p.stats.served = 25;
    run(s, 5);
    expect(latest(s).pill).toBe('+§80 · ★4');
    expect(starsOf(p)).toBe(4);
    expect(p.milestones.every((t) => t >= 0)).toBe(true);
    expect(p.prestige).toBe(2 * CIVICS.park.prestige + 6 + 4 + 4);
    expect(p.totalLedger.dividends).toBe(200);
    expect(p.cash).toBe(5000 - 2 * CIVICS.park.cost + 200 - s.players[0].totalLedger.rent);
    expect(starsOf(s.players[1])).toBe(1); // the rival is merely rich
    // Nothing further is ever awarded.
    const n = s.chronicle.filter((d) => d.cat === 'milestone').length;
    while (s.phase !== 'ended') {
      if (s.phase === 'council') closeCouncil(s);
      else tick(s);
    }
    expect(s.players.map((q) => q.totalLedger.dividends)).toEqual([200, 0]);
    expect(s.result?.rows.map((r) => r.stars)).toEqual([4, 1]);
    expect(n).toBe(5);
  });
});

// ───────────────────────────── Ledger reconciliation ─────────────────────────────

describe('Ledger: opening cash + ledger = cash in hand, Milestone dividends included', () => {
  const LINES = Object.keys(emptyLedger()) as (keyof Ledger)[];

  it('holds on every tick of full AI matches in every mode, with dividends matching the stars earned', () => {
    for (const mode of ['standard', 'blitz', 'endless'] as MatchMode[]) {
      const s = createGame({ seed: 58, mode, players: ais(['vesper', 'aurelia', 'orson', 'aurelia']) });
      let worst = 0;
      let checked = 0;
      const closed = s.players.map(() => emptyLedger());
      let closes = 0;
      while (s.phase !== 'ended' && s.tick < 5 * s.quarterTicks) {
        if (s.phase === 'council') {
          closeCouncil(s);
          continue;
        }
        const era = s.leaders.length;
        s.fx = [];
        advance(s); // the same step the room and the solo session run
        const rolled = s.leaders.length !== era;
        if (rolled) closes++;
        s.players.forEach((p, i) => {
          worst = Math.max(worst, Math.abs(p.cash - (START_CASH + ledgerCashChange(p.totalLedger))));
          worst = Math.max(worst, Math.abs(p.debt - ledgerFinancing(p.totalLedger)));
          if (rolled) for (const k of LINES) closed[i][k] += p.lastLedger[k];
          // Every line of the match ledger is the closed eras plus the open page.
          for (const k of LINES) worst = Math.max(worst, Math.abs(p.totalLedger[k] - closed[i][k] - p.ledger[k]));
          checked++;
        });
      }
      expect(checked, mode).toBeGreaterThan(4 * 2000);
      expect(worst, mode).toBeLessThan(1e-6);
      expect(closes).toBe(mode === 'endless' ? 5 : 4);
      for (const p of s.players) {
        const due = MILESTONES.reduce((a, m, i) => a + (p.milestones[i] >= 0 ? m.cash : 0), 0);
        expect(p.totalLedger.dividends, `${mode} ${p.persona}`).toBe(due);
        // To the exact §, as the Ledger drawer prints it.
        expect(Math.round(START_CASH + ledgerCashChange(p.totalLedger))).toBe(Math.round(p.cash));
      }
      expect(s.players.some((p) => p.totalLedger.dividends > 0), mode).toBe(true);
      expect(s.players.some((p) => starsOf(p) === 4), mode).toBe(true);
    }
  });

  it('holds for a human who builds, borrows, repays, blitzes, adopts charters and earns Milestones', () => {
    const s = labGame({ seed: 31, mode: 'blitz', milestones: true });
    const p = s.players[0];
    const script: Record<number, () => void> = {
      1: () => {
        build(s, 0, 3, 6, 'roastery');
        build(s, 0, 4, 6, 'bistro'); // an enclave: Block Baron
      },
      40: () => expect(applyCommand(s, 0, { c: 'borrow' }).ok).toBe(true),
      60: () => void build(s, 0, 3, 4, 'park'),
      200: () => void build(s, 0, 2, 6, 'park'), // the second civic project: Civic Benefactor
      300: () => expect(applyCommand(s, 0, { c: 'promo', id: s.buildings[0].id }).ok).toBe(true),
      700: () => void applyCommand(s, 0, { c: 'build', tile: idx(9, 6), kind: 'arcade' }), // Era II
      1000: () => void applyCommand(s, 0, { c: 'repay' }),
      1400: () => void applyCommand(s, 0, { c: 'upgrade', id: s.buildings[0].id }),
      1700: () => void applyCommand(s, 0, { c: 'promo', id: s.buildings[1].id }),
    };
    let worst = 0;
    let councils = 0;
    while (s.phase !== 'ended') {
      if (s.phase === 'council') {
        councils++;
        const offer = (s.council as NonNullable<GameState['council']>).offers[0];
        expect(applyCommand(s, 0, { c: 'charter', key: offer[councils % 3] }).ok).toBe(true);
        closeCouncil(s);
        continue;
      }
      script[s.tick]?.();
      tick(s);
      s.fx = [];
      for (const q of s.players) {
        worst = Math.max(worst, Math.abs(q.cash - (START_CASH + ledgerCashChange(q.totalLedger))));
        worst = Math.max(worst, Math.abs(q.debt - ledgerFinancing(q.totalLedger)));
      }
    }
    expect(councils).toBe(3);
    expect(worst).toBeLessThan(1e-6);
    expect(Math.round(START_CASH + ledgerCashChange(p.totalLedger))).toBe(Math.round(p.cash));
    // He really did all of it.
    expect(p.charters).toHaveLength(3);
    expect(p.stats.served).toBeGreaterThanOrEqual(MILESTONE_SERVED);
    expect(p.milestones.slice(0, 3).every((t) => t >= 0)).toBe(true);
    expect(p.totalLedger.dividends).toBe(80 + 120);
    expect(p.totalLedger.borrowed).toBe(LOAN_STEP);
    expect(p.totalLedger.marketing).toBeGreaterThan(0);
    expect(p.totalLedger.civic).toBeGreaterThan(0);
    expect(p.totalLedger.revenue).toBeGreaterThan(0);
    // The idle rival's wallet reconciles trivially: untouched.
    expect(s.players[1].cash).toBe(START_CASH);
    expect(s.players[1].totalLedger).toEqual(emptyLedger());
  });
});
