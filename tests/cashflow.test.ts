import { describe, expect, it, vi } from 'vitest';
import { advance } from '../src/shared/ai';
import {
  AUTO_RESTOCK_AT,
  AUTO_RESTOCK_PREMIUM,
  BOOK_VALUE,
  CIVICS,
  CIVIC_KINDS,
  LOAN_MAX,
  LOAN_RATE,
  LOAN_STEP,
  PAYROLL_TICKS,
  PROMO_COOLDOWN,
  PROMO_COST,
  PROMO_TICKS,
  RENT_HIKE,
  SALVAGE,
  SHOPS,
  SHOP_KINDS,
  STANCES,
  START_CASH,
  SUPPLY_CRUNCH,
  UPGRADE_COST,
} from '../src/shared/constants';
import { CITY, idx, tx, ty } from '../src/shared/map';
import {
  applyCommand,
  buildingAt,
  buildingById,
  canBuild,
  chooseShop,
  closeCouncil,
  createGame,
  emptyLedger,
  eventActive,
  forceEvent,
  ledgerNet,
  netWorth,
  priceOf,
  queueCap,
  rentOf,
  restockCost,
  salvageValue,
  serversOf,
  serviceTicksOf,
  upgradeCost,
  wageOf,
} from '../src/shared/sim';
import { CS, type BuildKind, type Command, type Ledger } from '../src/shared/types';
import { ais, build, clone, freeze, fxOf, labGame, putCitizen, run, sendTo } from './helpers';

// Whole seeded matches are played in here: leave room for a busy machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const who = { arch: 'local' as const, budget: 80, tried: [] as number[] };

describe('Cashflow: construction', () => {
  it('deducts a shop’s cost and books it under construction', () => {
    SHOP_KINDS.forEach((kind, i) => {
      const s = labGame({ era: 3, cash: 1000 });
      const def = SHOPS[kind];
      const lot = CITY.lots[i * 7];
      const b = build(s, 0, tx(lot), ty(lot), kind);
      const p = s.players[0];
      expect(p.cash - 1000).toBe(-def.cost);
      expect(p.ledger.construction).toBe(def.cost);
      expect(p.totalLedger.construction).toBe(def.cost);
      expect(ledgerNet(p.ledger)).toBe(-def.cost);
      expect(p.ledger.civic).toBe(0);
      expect(p.prestige).toBe(0);
      expect(p.stats.built).toBe(1);
      expect(p.stats.civicBuilt).toBe(0);
      expect(b).toMatchObject({ kind, owner: 0, level: 1, stance: 1, stock: def.stockMax, auto: true, invested: def.cost, dry: false });
      expect(fxOf(s.fx, 'build')).toEqual([{ k: 'build', tile: b.tile, kind, p: 0 }]);
      // The rival's books are untouched.
      expect(s.players[1].cash).toBe(1000);
      expect(s.players[1].ledger).toEqual(emptyLedger());
    });
  });

  it('books a civic project under civic and credits its prestige', () => {
    CIVIC_KINDS.forEach((kind, i) => {
      const s = labGame({ era: 3, cash: 1000 });
      const def = CIVICS[kind];
      const b = build(s, 1, 2 + i, 10, kind);
      expect(b.tile).toBe(idx(2 + i, 10));
      const p = s.players[1];
      expect(p.cash - 1000).toBe(-def.cost);
      expect(p.ledger.civic).toBe(def.cost);
      expect(p.totalLedger.civic).toBe(def.cost);
      expect(p.ledger.construction).toBe(0);
      expect(p.prestige).toBe(def.prestige);
      expect(p.stats.civicBuilt).toBe(1);
      expect(b.stock).toBe(0);
      expect(priceOf(b)).toBe(0);
      expect(wageOf(b)).toBe(0);
      expect(rentOf(b)).toBe(def.rent);
      expect(s.gazette[s.gazette.length - 1].tone).toBe('civic');
      expect(s.gazette[s.gazette.length - 1].text).toContain(def.name);
    });
    // The costlier the project, the more prestige it carries.
    expect(CIVICS.plaza.prestige).toBeGreaterThan(CIVICS.tramstop.prestige);
    expect(CIVICS.tramstop.prestige).toBeGreaterThan(CIVICS.park.prestige);
  });

  it('refuses to build off a lot, on an occupied lot, without cash, or an unknown project', () => {
    const s = labGame({ era: 3, cash: 1000 });
    const lot = idx(3, 6);
    build(s, 1, 3, 6, 'roastery');
    const snapshot = JSON.stringify(s);
    const tries: [number, unknown, string][] = [
      [idx(1, 1), 'roastery', 'avenue'],
      [idx(5, 2), 'roastery', 'canal'],
      [idx(0, 0), 'roastery', 'townhouse'],
      [idx(8, 0), 'park', 'station'],
      [lot, 'bistro', 'occupied by a rival'],
      [-1, 'roastery', 'negative tile'],
      [144, 'roastery', 'tile past the grid'],
      [3.5, 'roastery', 'fractional tile'],
      [idx(4, 6), 'casino', 'unknown kind'],
      [idx(4, 6), 'constructor', 'prototype key'],
    ];
    for (const [tile, kind, why] of tries) {
      const res = applyCommand(s, 0, { c: 'build', tile, kind: kind as BuildKind });
      expect(res.ok, why).toBe(false);
      expect(res.err, why).toBeTruthy();
    }
    s.players[0].cash = SHOPS.cinema.cost - 1;
    const poor = JSON.stringify(s);
    expect(applyCommand(s, 0, { c: 'build', tile: idx(4, 6), kind: 'cinema' })).toEqual({ ok: false, err: 'Not enough cash' });
    expect(JSON.stringify(s)).toBe(poor);
    s.players[0].cash = 1000;
    expect(JSON.stringify(s)).toBe(snapshot);
    expect(s.buildings).toHaveLength(1);
    // A Tram Stop must touch the avenue.
    const inner = CITY.lots.find((t) => CITY.avenueAdj[t] < 0 && !buildingAt(s, t)) as number;
    expect(inner).toBeDefined();
    expect(applyCommand(s, 0, { c: 'build', tile: inner, kind: 'tramstop' }).ok).toBe(false);
    expect(canBuild(s, 0, inner, 'plaza').ok).toBe(true);
    expect(s.players[0].cash).toBe(1000);
    const outer = CITY.lots.find((t) => CITY.avenueAdj[t] >= 0) as number;
    expect(applyCommand(s, 0, { c: 'build', tile: outer, kind: 'tramstop' }).ok).toBe(true);
    expect(s.players[0].cash).toBe(1000 - CIVICS.tramstop.cost);
  });
});

describe('Cashflow: sales', () => {
  it('books each sale as revenue, raises cash by the ticket price and draws down stock', () => {
    const s = labGame({ era: 3, seed: 6 });
    const b = build(s, 0, 10, 2, 'roastery');
    b.auto = false;
    const p = s.players[0];
    const price = priceOf(b);
    let ticks = 0;
    while (b.served < 3 && ticks++ < 900) {
      const cash = p.cash;
      const served = b.served;
      const rev = p.ledger.revenue;
      const costs = p.ledger.wages + p.ledger.rent;
      s.fx = [];
      run(s, 1);
      const sold = b.served - served;
      expect(p.ledger.revenue - rev).toBe(sold * price);
      expect(p.cash - cash).toBeCloseTo(sold * price - (p.ledger.wages + p.ledger.rent - costs), 9);
      expect(fxOf(s.fx, 'coin').map((f) => f.amt)).toEqual(Array.from({ length: sold }, () => price));
    }
    expect(b.served).toBeGreaterThanOrEqual(3);
    expect(b.revenue).toBe(b.served * price);
    expect(p.totalLedger.revenue).toBe(b.revenue);
    expect(p.stats.served).toBe(b.served);
    expect(b.stock).toBe(SHOPS.roastery.stockMax - b.served - b.serving.length / 2);
    expect(p.recentRev).toBeGreaterThan(0);
    expect(p.recentRev).toBeLessThanOrEqual(b.revenue);
    expect(p.ledger.supplies).toBe(0);
  });

  it('prices every shop by stance and tallies Budget sales and corner takings', () => {
    for (const kind of SHOP_KINDS) {
      const prices = STANCES.map((st, stance) => {
        const price = priceOf({ kind, stance });
        expect(price).toBe(Math.max(1, Math.round(SHOPS[kind].price * st.mult)));
        return price;
      });
      expect(prices[1]).toBe(SHOPS[kind].price);
      for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeGreaterThan(prices[i - 1]);
      // Even the Budget ticket clears the cost of the goods.
      expect(prices[0]).toBeGreaterThan(SHOPS[kind].unitCost);
    }
    const s = labGame({ era: 3, seed: 6 });
    const corner = build(s, 0, 10, 2, 'roastery');
    const plain = build(s, 1, 8, 2, 'roastery');
    expect(CITY.corner[corner.tile]).toBe(true);
    expect(CITY.corner[plain.tile]).toBe(false);
    expect(applyCommand(s, 0, { c: 'price', id: corner.id, stance: 0 }).ok).toBe(true);
    let ticks = 0;
    while ((corner.served < 3 || plain.served < 1) && ticks++ < 1200) run(s, 1);
    expect(corner.served).toBeGreaterThanOrEqual(3);
    expect(plain.served).toBeGreaterThanOrEqual(1);
    expect(corner.revenue).toBe(corner.served * priceOf(corner));
    expect(s.players[0].stats.budgetSales).toBe(corner.served);
    expect(s.players[0].stats.cornerRevenue).toBe(corner.revenue);
    expect(s.players[1].stats.budgetSales).toBe(0);
    expect(s.players[1].stats.cornerRevenue).toBe(0);
  });
});

describe('Cashflow: payroll, rent and credit', () => {
  it('runs payroll every PAYROLL_TICKS: wages plus rent, to the cent', () => {
    const s = freeze(labGame({ cash: 5000 }));
    const bistro = build(s, 0, 3, 6, 'bistro');
    const park = build(s, 0, 4, 6, 'park');
    const p = s.players[0];
    const cash = p.cash;
    const wages = wageOf(bistro);
    const rent = rentOf(bistro) + rentOf(park);
    expect(wages).toBe(SHOPS.bistro.wage);
    expect(rent).toBe(SHOPS.bistro.rent + CIVICS.park.rent);
    run(s, PAYROLL_TICKS - 1);
    expect(p.cash).toBe(cash);
    expect(p.ledger.wages + p.ledger.rent + p.ledger.interest).toBe(0);
    run(s, 1);
    expect(s.tick).toBe(PAYROLL_TICKS);
    expect(p.cash).toBe(cash - wages - rent);
    expect(p.ledger).toMatchObject({ wages, rent, interest: 0, revenue: 0 });
    run(s, PAYROLL_TICKS);
    expect(p.cash).toBe(cash - 2 * (wages + rent));
    expect(p.totalLedger).toMatchObject({ wages: 2 * wages, rent: 2 * rent });
    // The rival, who owns nothing, pays nothing.
    expect(s.players[1].cash).toBe(5000);
    // A bigger shop costs more to run.
    bistro.level = 3;
    expect(wageOf(bistro)).toBeGreaterThan(wages);
    expect(rentOf(bistro)).toBeGreaterThan(SHOPS.bistro.rent);
  });

  it('raises rent by RENT_HIKE during a Commercial Rent Hike, and only rent', () => {
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    const shop = build(s, 0, 3, 6, 'boutique');
    const stop = build(s, 0, 2, 6, 'tramstop');
    const p = s.players[0];
    for (const b of [shop, stop]) {
      expect(rentOf(b, true)).toBeCloseTo(rentOf(b) * RENT_HIKE, 2);
      expect(rentOf(b, true)).toBeGreaterThan(rentOf(b));
      expect(rentOf(b, false)).toBe(rentOf(b));
    }
    run(s, PAYROLL_TICKS);
    const normal = p.ledger.rent;
    expect(normal).toBe(rentOf(shop) + rentOf(stop));
    forceEvent(s, 'renthike', PAYROLL_TICKS + 20);
    const cash = p.cash;
    run(s, PAYROLL_TICKS);
    const hiked = p.ledger.rent - normal;
    expect(hiked).toBeCloseTo(rentOf(shop, true) + rentOf(stop, true), 9);
    expect(hiked / normal).toBeCloseTo(RENT_HIKE, 2);
    expect(p.ledger.wages).toBe(2 * wageOf(shop));
    expect(cash - p.cash).toBeCloseTo(hiked + wageOf(shop), 9);
    // The hike lapses with the event.
    run(s, PAYROLL_TICKS);
    expect(eventActive(s, 'renthike')).toBe(false);
    expect(p.ledger.rent - normal - hiked).toBeCloseTo(normal, 9);
  });

  it('lends LOAN_STEP at a time up to LOAN_MAX, charges LOAN_RATE per payroll, and takes repayments', () => {
    const s = freeze(labGame({ era: 3, cash: 100 }));
    const p = s.players[0];
    expect(applyCommand(s, 0, { c: 'repay' })).toEqual({ ok: false, err: 'No debt to repay' });
    const steps = LOAN_MAX / LOAN_STEP;
    for (let i = 1; i <= steps; i++) {
      expect(applyCommand(s, 0, { c: 'borrow' }).ok).toBe(true);
      expect(p.debt).toBe(i * LOAN_STEP);
      expect(p.cash).toBe(100 + i * LOAN_STEP);
    }
    expect(p.debt).toBe(LOAN_MAX);
    expect(applyCommand(s, 0, { c: 'borrow' }).ok).toBe(false);
    expect(p.debt).toBe(LOAN_MAX);
    expect(p.cash).toBe(100 + LOAN_MAX);
    // Borrowing is not income: it is booked as financing only, and net worth does not move.
    expect(p.ledger).toEqual({ ...emptyLedger(), borrowed: LOAN_MAX });
    expect(ledgerNet(p.ledger)).toBe(0);
    expect(netWorth(s, p)).toBe(100);
    // Interest at the payroll.
    run(s, PAYROLL_TICKS);
    const interest = Math.round(LOAN_MAX * LOAN_RATE * 100) / 100;
    expect(p.ledger.interest).toBe(interest);
    expect(p.cash).toBeCloseTo(100 + LOAN_MAX - interest, 9);
    expect(s.players[1].ledger.interest).toBe(0);
    // Repayment, a step at a time.
    const cash = p.cash;
    expect(applyCommand(s, 0, { c: 'repay' }).ok).toBe(true);
    expect(p.debt).toBe(LOAN_MAX - LOAN_STEP);
    expect(p.cash).toBeCloseTo(cash - LOAN_STEP, 9);
    run(s, PAYROLL_TICKS);
    expect(p.ledger.interest - interest).toBeCloseTo(Math.round((LOAN_MAX - LOAN_STEP) * LOAN_RATE * 100) / 100, 9);
    // Short of a full step, a player repays what they have; with nothing, the bank refuses.
    p.cash = 150.75;
    expect(applyCommand(s, 0, { c: 'repay' }).ok).toBe(true);
    expect(p.debt).toBe(LOAN_MAX - LOAN_STEP - 150);
    expect(p.cash).toBeCloseTo(0.75, 9);
    expect(applyCommand(s, 0, { c: 'repay' })).toEqual({ ok: false, err: 'Not enough cash' });
    p.cash = 5000;
    while (p.debt > 0) expect(applyCommand(s, 0, { c: 'repay' }).ok).toBe(true);
    expect(p.debt).toBe(0);
    expect(applyCommand(s, 0, { c: 'repay' }).ok).toBe(false);
  });
});

describe('Cashflow: stock', () => {
  it('charges a manual restock units × unit cost and books it under supplies', () => {
    for (const kind of SHOP_KINDS) {
      const s = freeze(labGame({ era: 3, cash: 5000 }));
      const def = SHOPS[kind];
      const b = build(s, 0, 3, 6, kind);
      const p = s.players[0];
      expect(restockCost(s, b, false)).toBe(0);
      expect(applyCommand(s, 0, { c: 'restock', id: b.id })).toEqual({ ok: false, err: 'Stockroom is full' });
      const units = Math.min(7, def.stockMax);
      b.stock = def.stockMax - units;
      const quote = restockCost(s, b, false);
      expect(quote).toBe(units * def.unitCost);
      const cash = p.cash;
      s.fx = [];
      expect(applyCommand(s, 0, { c: 'restock', id: b.id }).ok).toBe(true);
      expect(cash - p.cash).toBe(quote);
      expect(p.ledger.supplies).toBe(quote);
      expect(b.stock).toBe(def.stockMax);
      expect(fxOf(s.fx, 'restock')).toEqual([{ k: 'restock', b: b.id, p: 0 }]);
    }
    // A short till buys only what it can pay for, and an empty one nothing.
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    const def = SHOPS.boutique;
    const b = build(s, 0, 3, 6, 'boutique');
    const p = s.players[0];
    b.stock = 0;
    p.cash = def.unitCost * 3 + 1;
    expect(applyCommand(s, 0, { c: 'restock', id: b.id }).ok).toBe(true);
    expect(b.stock).toBe(3);
    expect(p.cash).toBe(1);
    expect(p.ledger.supplies).toBe(def.unitCost * 3);
    expect(applyCommand(s, 0, { c: 'restock', id: b.id })).toEqual({ ok: false, err: 'Not enough cash' });
    expect(b.stock).toBe(3);
    expect(p.cash).toBe(1);
    // A park has no stockroom.
    const park = build(s, 1, 4, 6, 'park');
    expect(applyCommand(s, 1, { c: 'restock', id: park.id }).ok).toBe(false);
    expect(applyCommand(s, 1, { c: 'auto', id: park.id, on: false }).ok).toBe(false);
    expect(restockCost(s, park, false)).toBe(0);
  });

  it('auto-restocks at the reorder point for AUTO_RESTOCK_PREMIUM more than a manual order', () => {
    for (const kind of SHOP_KINDS) {
      const s = freeze(labGame({ era: 3, cash: 5000 }));
      const def = SHOPS[kind];
      const b = build(s, 0, 3, 6, kind);
      const p = s.players[0];
      const reorder = Math.floor(def.stockMax * AUTO_RESTOCK_AT);
      // Just above the reorder point nothing happens.
      b.stock = reorder + 1;
      run(s, 1);
      expect(b.stock).toBe(reorder + 1);
      expect(p.cash).toBe(5000 - def.cost);
      // At the reorder point the stockroom fills at the premium rate.
      b.stock = reorder;
      const units = def.stockMax - reorder;
      const manual = restockCost(s, b, false);
      const auto = restockCost(s, b, true);
      expect(manual).toBe(units * def.unitCost);
      expect(auto).toBe(Math.ceil(units * def.unitCost * AUTO_RESTOCK_PREMIUM));
      expect(auto).toBeGreaterThan(manual);
      const cash = p.cash;
      run(s, 1);
      expect(b.stock).toBe(def.stockMax);
      expect(cash - p.cash).toBe(auto);
      expect(p.ledger.supplies).toBe(auto);
      // With Auto-Restock switched off the shelf stays as it is.
      expect(applyCommand(s, 0, { c: 'auto', id: b.id, on: false }).ok).toBe(true);
      expect(b.auto).toBe(false);
      b.stock = reorder;
      run(s, 1);
      expect(b.stock).toBe(reorder);
      expect(p.ledger.supplies).toBe(auto);
      expect(applyCommand(s, 0, { c: 'auto', id: b.id, on: true }).ok).toBe(true);
      run(s, 1);
      expect(b.stock).toBe(def.stockMax);
    }
  });

  it('makes every restock dearer by SUPPLY_CRUNCH during a Supply Crunch', () => {
    for (const kind of SHOP_KINDS) {
      const s = freeze(labGame({ era: 3, cash: 50000 }));
      const def = SHOPS[kind];
      const b = build(s, 0, 3, 6, kind);
      const p = s.players[0];
      b.auto = false;
      b.stock = 1;
      const units = def.stockMax - 1;
      const normal = restockCost(s, b, false);
      const normalAuto = restockCost(s, b, true);
      forceEvent(s, 'supplycrunch', 100);
      expect(eventActive(s, 'supplycrunch')).toBe(true);
      const crunch = restockCost(s, b, false);
      expect(crunch).toBe(Math.ceil(units * def.unitCost * SUPPLY_CRUNCH));
      expect(crunch / normal).toBeCloseTo(SUPPLY_CRUNCH, 1);
      expect(restockCost(s, b, true)).toBe(Math.ceil(units * def.unitCost * SUPPLY_CRUNCH * AUTO_RESTOCK_PREMIUM));
      expect(restockCost(s, b, true)).toBeGreaterThan(normalAuto);
      // What is actually charged tracks the quote. (To the §: see the suspected-bug note in the
      // report — sim.ts quotes and charges with differently ordered float maths.)
      const cash = p.cash;
      expect(applyCommand(s, 0, { c: 'restock', id: b.id }).ok).toBe(true);
      const charged = cash - p.cash;
      expect(charged).toBeGreaterThanOrEqual(crunch);
      expect(charged).toBeLessThanOrEqual(crunch + 1);
      expect(charged).toBeGreaterThan(normal);
      expect(p.ledger.supplies).toBe(charged);
      // After the crunch the old price list is back.
      run(s, 100);
      expect(eventActive(s, 'supplycrunch')).toBe(false);
      b.stock = 1;
      expect(restockCost(s, b, false)).toBe(normal);
    }
  });

  it('marks a shop that runs dry: stockout badge, lost custom, and recovery on restock', () => {
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    const a = build(s, 0, 3, 6, 'roastery');
    const door = CITY.door[a.tile];
    expect(chooseShop(s, who, 'coffee', door, false)).toBe(a);
    const waiting = putCitizen(s, door, { state: CS.Queue, target: a.id });
    a.queue.push(waiting.id);
    a.auto = false;
    a.stock = 0;
    const rating = a.rating;
    run(s, 1);
    expect(a.dry).toBe(true);
    expect(fxOf(s.fx, 'stockout')).toEqual([{ k: 'stockout', b: a.id }]);
    expect(a.rating).toBeLessThan(rating); // running dry costs reputation
    expect(chooseShop(s, who, 'coffee', door, false)).toBeNull();
    // The queue is released and nobody is served from an empty shelf.
    expect(a.queue).toEqual([]);
    expect(waiting.state).not.toBe(CS.Queue);
    expect(a.served).toBe(0);
    // A rival now takes the trade.
    const b = build(s, 1, 9, 6, 'roastery');
    expect(chooseShop(s, who, 'coffee', door, false)).toBe(b);
    // The badge is raised once, not every tick.
    run(s, 5);
    expect(a.dry).toBe(true);
    expect(fxOf(s.fx, 'stockout')).toHaveLength(1);
    // Restocking reopens the shop.
    expect(applyCommand(s, 0, { c: 'restock', id: a.id }).ok).toBe(true);
    expect(a.dry).toBe(false);
    expect(a.stock).toBe(SHOPS.roastery.stockMax);
    expect(chooseShop(s, who, 'coffee', door, false)).toBe(a);
  });
});

describe('Cashflow: upgrades, promotion and sale of property', () => {
  it('charges upgradeCost for each level, adds it to the capital invested and stops at Level 3', () => {
    for (const kind of SHOP_KINDS) {
      const s = freeze(labGame({ era: 3, cash: 5000 }));
      const def = SHOPS[kind];
      const b = build(s, 0, 3, 6, kind);
      const p = s.players[0];
      const l1 = { cap: queueCap(b), servers: serversOf(b), ticks: serviceTicksOf(b) };
      let invested = def.cost;
      for (const level of [1, 2]) {
        const cost = upgradeCost(b);
        expect(cost).toBe(Math.round(def.cost * UPGRADE_COST[level - 1]));
        const cash = p.cash;
        s.fx = [];
        expect(applyCommand(s, 0, { c: 'upgrade', id: b.id }).ok).toBe(true);
        expect(cash - p.cash).toBe(cost);
        invested += cost;
        expect(b.level).toBe(level + 1);
        expect(b.invested).toBe(invested);
        expect(p.ledger.construction).toBe(invested);
        expect(fxOf(s.fx, 'upgrade')).toEqual([{ k: 'upgrade', b: b.id, p: 0 }]);
      }
      expect(upgradeCost(b)).toBe(0);
      const cash = p.cash;
      expect(applyCommand(s, 0, { c: 'upgrade', id: b.id })).toEqual({ ok: false, err: 'Already at Level 3' });
      expect(b.level).toBe(3);
      expect(p.cash).toBe(cash);
      // Level 3 holds a longer queue and serves faster.
      expect(queueCap(b)).toBeGreaterThan(l1.cap);
      expect(serviceTicksOf(b)).toBeLessThan(l1.ticks);
      expect(serversOf(b)).toBeGreaterThanOrEqual(l1.servers);
    }
    const s = labGame({ era: 3, cash: SHOPS.cinema.cost });
    const cinema = build(s, 0, 3, 6, 'cinema');
    expect(applyCommand(s, 0, { c: 'upgrade', id: cinema.id })).toEqual({ ok: false, err: 'Not enough cash' });
    expect(cinema.level).toBe(1);
    const park = build(s, 1, 4, 6, 'park');
    expect(applyCommand(s, 1, { c: 'upgrade', id: park.id }).ok).toBe(false);
  });

  it('sells a property for 60% of what was invested, books the salvage and frees the lot', () => {
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    const b = build(s, 0, 3, 6, 'bistro');
    expect(applyCommand(s, 0, { c: 'upgrade', id: b.id }).ok).toBe(true);
    const p = s.players[0];
    const invested = SHOPS.bistro.cost + Math.round(SHOPS.bistro.cost * UPGRADE_COST[0]);
    expect(b.invested).toBe(invested);
    const refund = salvageValue(b);
    expect(SALVAGE).toBe(0.6);
    expect(refund).toBe(Math.round(invested * SALVAGE));
    const cash = p.cash;
    const worth = netWorth(s, p);
    s.fx = [];
    expect(applyCommand(s, 0, { c: 'sell', id: b.id }).ok).toBe(true);
    expect(p.cash - cash).toBe(refund);
    expect(p.ledger.salvage).toBe(refund);
    expect(p.totalLedger.salvage).toBe(refund);
    expect(buildingById(s, b.id)).toBeUndefined();
    expect(buildingAt(s, b.tile)).toBeUndefined();
    expect(fxOf(s.fx, 'sell')).toEqual([{ k: 'sell', tile: b.tile, p: 0 }]);
    // Selling converts book value (80%) to cash (60%): net worth drops by the difference.
    expect(netWorth(s, p)).toBe(Math.round(worth - invested * BOOK_VALUE + refund));
    expect(applyCommand(s, 0, { c: 'sell', id: b.id })).toEqual({ ok: false, err: 'No such building' });
    // The lot is free again, and the new building gets a fresh id.
    const again = build(s, 1, 3, 6, 'arcade');
    expect(again.id).not.toBe(b.id);
    // Selling a civic project hands back its prestige.
    const plaza = build(s, 1, 4, 6, 'plaza');
    expect(s.players[1].prestige).toBe(CIVICS.plaza.prestige);
    expect(applyCommand(s, 1, { c: 'sell', id: plaza.id }).ok).toBe(true);
    expect(s.players[1].prestige).toBe(0);
    expect(s.players[1].ledger.salvage).toBe(Math.round(CIVICS.plaza.cost * SALVAGE));
  });

  it('lets citizens who were queuing, being served or on their way carry on when a shop is sold', () => {
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    const a = build(s, 0, 3, 6, 'roastery');
    const rival = build(s, 1, 9, 6, 'roastery');
    const door = CITY.door[a.tile];
    const queued = [0, 1, 2].map(() => putCitizen(s, door, { state: CS.Queue, target: a.id }));
    a.queue = queued.map((c) => c.id);
    const seated = putCitizen(s, door, { state: CS.Serve, target: a.id });
    a.serving = [seated.id, s.tick + 10];
    a.stock--;
    const walker = putCitizen(s, idx(6, 7));
    sendTo(walker, a);
    expect(applyCommand(s, 0, { c: 'sell', id: a.id }).ok).toBe(true);
    for (let i = 0; i < 50; i++) {
      run(s, 1);
      // Nobody waits at, or is served by, a shop that is gone.
      for (const c of s.citizens) {
        if (c.state === CS.Queue || c.state === CS.Serve) expect(c.target).toBe(rival.id);
      }
    }
    // The citizen who was on the way finds the lot empty at the door and moves on too.
    for (const c of s.citizens) expect(c.target).not.toBe(a.id);
    // The sold shop never rang up the guest who was mid-service.
    expect(s.players[0].ledger.revenue).toBe(0);
    expect(s.players[0].stats.served).toBe(0);
    expect(s.buildings.map((b) => b.id)).toEqual([rival.id]);
    for (const id of [...rival.queue, ...rival.serving.filter((_, i) => i % 2 === 0)]) {
      expect(s.citizens.some((c) => c.id === id)).toBe(true);
    }
  });

  it('charges PROMO_COST for a Promo Blitz, books marketing, and enforces the cooldown', () => {
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    const b = build(s, 0, 3, 6, 'arcade');
    const p = s.players[0];
    const cash = p.cash;
    run(s, 7);
    s.fx = [];
    expect(applyCommand(s, 0, { c: 'promo', id: b.id }).ok).toBe(true);
    expect(cash - p.cash).toBe(PROMO_COST);
    expect(p.ledger.marketing).toBe(PROMO_COST);
    expect(b.promoUntil).toBe(s.tick + PROMO_TICKS);
    expect(b.promoReadyAt).toBe(s.tick + PROMO_TICKS + PROMO_COOLDOWN);
    expect(p.stats.promos).toBe(1);
    expect(fxOf(s.fx, 'promo')).toEqual([{ k: 'promo', b: b.id, p: 0 }]);
    // No second blitz while it runs, nor during the cooldown.
    expect(applyCommand(s, 0, { c: 'promo', id: b.id })).toEqual({ ok: false, err: 'Promo Blitz is cooling down' });
    run(s, PROMO_TICKS + 1);
    expect(s.tick).toBeGreaterThan(b.promoUntil);
    expect(applyCommand(s, 0, { c: 'promo', id: b.id }).ok).toBe(false);
    run(s, PROMO_COOLDOWN - 2);
    expect(s.tick).toBe(b.promoReadyAt - 1);
    expect(applyCommand(s, 0, { c: 'promo', id: b.id }).ok).toBe(false);
    expect(p.ledger.marketing + p.lastLedger.marketing).toBe(PROMO_COST);
    run(s, 1);
    expect(applyCommand(s, 0, { c: 'promo', id: b.id }).ok).toBe(true);
    expect(p.totalLedger.marketing).toBe(2 * PROMO_COST);
    expect(p.stats.promos).toBe(2);
    // Not without the money, and not for a park.
    const other = build(s, 0, 4, 6, 'roastery');
    p.cash = PROMO_COST - 1;
    expect(applyCommand(s, 0, { c: 'promo', id: other.id })).toEqual({ ok: false, err: 'Not enough cash' });
    expect(other.promoUntil).toBe(0);
    const park = build(s, 1, 5, 6, 'park');
    expect(applyCommand(s, 1, { c: 'promo', id: park.id }).ok).toBe(false);
  });
});

describe('Cashflow: command validation', () => {
  it('rejects every command aimed at a rival’s building and leaves the state untouched', () => {
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    const theirs = build(s, 1, 3, 6, 'bistro');
    theirs.stock = 5;
    const before = JSON.stringify(s);
    const cmds: Command[] = [
      { c: 'price', id: theirs.id, stance: 0 },
      { c: 'upgrade', id: theirs.id },
      { c: 'promo', id: theirs.id },
      { c: 'restock', id: theirs.id },
      { c: 'auto', id: theirs.id, on: false },
      { c: 'sell', id: theirs.id },
    ];
    for (const cmd of cmds) {
      expect(applyCommand(s, 0, cmd), cmd.c).toEqual({ ok: false, err: 'Not your property' });
      expect(applyCommand(s, 0, { ...cmd, id: 999 } as Command), cmd.c).toEqual({ ok: false, err: 'No such building' });
    }
    expect(applyCommand(s, 7, { c: 'borrow' }).ok).toBe(false);
    expect(applyCommand(s, -1, { c: 'sell', id: theirs.id }).ok).toBe(false);
    expect(applyCommand(s, 0, { c: 'demolish', id: theirs.id } as unknown as Command).ok).toBe(false);
    expect(applyCommand(s, 1, { c: 'demolish', id: theirs.id } as unknown as Command).ok).toBe(false);
    expect(applyCommand(s, 0, null as unknown as Command).ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
    // The owner, of course, may.
    for (const cmd of cmds) expect(applyCommand(s, 1, cmd).ok, cmd.c).toBe(true);
    expect(s.buildings).toHaveLength(0);
  });

  it('accepts the four price stances and nothing else', () => {
    const s = freeze(labGame({ era: 3, cash: 5000 }));
    const b = build(s, 0, 3, 6, 'boutique');
    for (const stance of [0, 1, 2, 3, 2, 0]) {
      expect(applyCommand(s, 0, { c: 'price', id: b.id, stance }).ok).toBe(true);
      expect(b.stance).toBe(stance);
      expect(priceOf(b)).toBe(Math.round(SHOPS.boutique.price * STANCES[stance].mult));
    }
    for (const stance of [-1, 4, 1.5, NaN, Infinity, '2', null, undefined]) {
      const res = applyCommand(s, 0, { c: 'price', id: b.id, stance: stance as number });
      expect(res, String(stance)).toEqual({ ok: false, err: 'Unknown price stance' });
      expect(b.stance).toBe(0);
    }
    const park = build(s, 0, 4, 6, 'park');
    expect(applyCommand(s, 0, { c: 'price', id: park.id, stance: 2 }).ok).toBe(false);
    expect(park.stance).toBe(1);
  });
});

describe('Cashflow: ledger and net worth', () => {
  it('nets a ledger as income minus every cost line', () => {
    expect(ledgerNet(emptyLedger())).toBe(0);
    const l: Ledger = {
      revenue: 1000, salvage: 200, awards: 50, dividends: 80, // Milestone dividends are income
      wages: 1, supplies: 2, rent: 4, interest: 8, construction: 16, civic: 32, marketing: 64,
      borrowed: 400, repaid: 150, // financing is not cashflow from trading
    };
    expect(ledgerNet(l)).toBe(1330 - 127);
    for (const key of Object.keys(l) as (keyof Ledger)[]) {
      const sign = key === 'borrowed' || key === 'repaid' ? 0 : key === 'revenue' || key === 'salvage' || key === 'awards' || key === 'dividends' ? 1 : -1;
      expect(ledgerNet({ ...emptyLedger(), [key]: 10 })).toBe(10 * sign);
    }
  });

  it('values a House at cash minus debt plus 80% of capital invested in its own buildings', () => {
    const s = freeze(labGame({ era: 3, cash: 3000 }));
    const [p, q] = s.players;
    expect(netWorth(s, p)).toBe(3000);
    const shop = build(s, 0, 3, 6, 'cinema');
    build(s, 0, 4, 6, 'park');
    build(s, 1, 9, 6, 'boutique');
    const invested = SHOPS.cinema.cost + CIVICS.park.cost;
    expect(netWorth(s, p)).toBe(Math.round(3000 - invested + invested * BOOK_VALUE));
    expect(netWorth(s, q)).toBe(Math.round(3000 - SHOPS.boutique.cost * (1 - BOOK_VALUE)));
    expect(applyCommand(s, 0, { c: 'upgrade', id: shop.id }).ok).toBe(true);
    const total = invested + Math.round(SHOPS.cinema.cost * UPGRADE_COST[0]);
    expect(netWorth(s, p)).toBe(Math.round(3000 - total * (1 - BOOK_VALUE)));
    expect(applyCommand(s, 0, { c: 'borrow' }).ok).toBe(true);
    expect(netWorth(s, p)).toBe(Math.round(3000 - total * (1 - BOOK_VALUE)));
    p.cash = 123.4;
    p.debt = 800;
    expect(netWorth(s, p)).toBe(Math.round(123.4 - 800 + total * BOOK_VALUE));
  });

  it('keeps every House’s cash equal to opening cash plus ledger net plus debt through a whole AI match', () => {
    const s = createGame({ seed: 12, mode: 'blitz', players: ais(['vesper', 'aurelia', 'orson', 'orson']) });
    let worst = 0;
    const closed = s.players.map(() => emptyLedger());
    // An era's books close at its final tick, before the Era Council sits: `leaders` gains an
    // entry at every close, whether a Council, the next era or the final bell follows.
    let closes = s.leaders.length;
    let councils = 0;
    while (s.phase !== 'ended') {
      if (s.phase === 'council') {
        councils++;
        const cash = s.players.map((p) => p.cash);
        closeCouncil(s); // adopting a charter moves no money
        expect(s.players.map((p) => p.cash)).toEqual(cash);
        continue;
      }
      const open = s.players.map((p) => clone(p.ledger));
      advance(s);
      s.fx = [];
      const rolled = s.leaders.length !== closes;
      s.players.forEach((p, i) => {
        worst = Math.max(worst, Math.abs(p.cash - (START_CASH + ledgerNet(p.totalLedger) + p.debt)));
        if (rolled) {
          for (const key of Object.keys(closed[i]) as (keyof Ledger)[]) closed[i][key] += p.lastLedger[key];
          // The closed quarter is what the open ledger had grown to, and a clean page is opened.
          expect(p.lastLedger.revenue).toBeGreaterThanOrEqual(open[i].revenue);
          expect(p.lastLedger.construction).toBe(open[i].construction);
          expect(p.ledger).toEqual(emptyLedger());
        }
        for (const key of Object.keys(closed[i]) as (keyof Ledger)[]) {
          worst = Math.max(worst, Math.abs(p.totalLedger[key] - closed[i][key] - p.ledger[key]));
        }
      });
      closes = s.leaders.length;
    }
    expect(councils).toBe(3);
    expect(closes).toBe(4);
    expect(worst).toBeLessThan(1e-6);
    expect(s.players.some((p) => p.totalLedger.revenue > 0)).toBe(true);
    expect(s.players.every((p) => p.totalLedger.construction + p.totalLedger.civic > 0)).toBe(true);
  });
});
