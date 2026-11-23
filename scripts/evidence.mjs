// MERCADIA visual evidence. Needs the Worker running (npm run dev) and a Chrome/Chromium binary.
//   node scripts/evidence.mjs      BASE=http://127.0.0.1:8787  CHROME=/usr/bin/google-chrome
//                                  OUT=~/chief-evidence/media  VIDEO=0 to skip the walkthrough
// Plays real matches through the real UI (dock, canvas, Inspector, Era Council cards) and saves
// nine PNGs: Era I onboarding, heraldry and ownership, the Era Council, the mid-game Chronicle,
// the Final Edition, a two-browser multiplayer room (host and guest at the same instant), and
// two phone-sized captures. The dev hooks are used only to move solo time (warp) and to frame
// the camera (look); multiplayer runs on the room's own clock. Any console error, page error or
// failed request fails the run.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const OUT = process.env.OUT ?? join(homedir(), 'chief-evidence', 'media');
const VIDEO = process.env.VIDEO !== '0';
mkdirSync(OUT, { recursive: true });

const errors = [];
const saved = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--mute-audio'] });
const watch = (page, label) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${label}] console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
};
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true };
const open = async (label, opts = DESKTOP, path = '/') => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(BASE + path);
  await page.waitForFunction(() => window.__mercadia && window.__mercadia.state().ready, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
};

// ───────────────────────────── Helpers ─────────────────────────────

const M = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => M(page, () => window.__mercadia.state());
const me = (page) => M(page, () => window.__mercadia.me);
const cash = async (page) => (await state(page)).players[await me(page)].cash;
const mine = async (page) => {
  const s = await state(page);
  const id = await me(page);
  return s.buildings.filter((b) => b.owner === id);
};

/** Wait until the transient layer is quiet: no toasts, the big era banner faded out. */
const settle = async (page, extra = 250) => {
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(
      () => {
        const banner = document.getElementById('banner');
        const shown = banner && banner.classList.contains('show') && Number(getComputedStyle(banner).opacity) > 0.03;
        return document.querySelectorAll('#toasts .toast').length === 0 && !shown;
      },
      null,
      { timeout: 15000, polling: 150 },
    )
    .catch(() => undefined);
  await sleep(extra);
};

/** Save a viewport screenshot and check its size from the PNG header. */
const shot = async (page, name, w, h) => {
  const path = join(OUT, name);
  await page.screenshot({ path });
  const buf = readFileSync(path);
  const pw = buf.readUInt32BE(16);
  const ph = buf.readUInt32BE(20);
  const good = pw === w && ph === h;
  saved.push({ name, w: pw, h: ph, bytes: buf.length, good });
  log(`  ${good ? 'ok  ' : 'FAIL'} ${name} — ${pw}×${ph}, ${(buf.length / 1024).toFixed(0)} KiB`);
  if (!good) errors.push(`${name} is ${pw}×${ph}, expected ${w}×${h}`);
};

const tileXY = (page, tile) => M(page, (t) => window.__mercadia.tileScreen(t), tile);

/** Arm a dock tool and click a vacant lot (desktop). Returns true once the building stands. */
const build = async (page, kind, tile) => {
  await page.keyboard.press('Escape');
  await page.click(`#dock [data-kind="${kind}"]`);
  const p = await tileXY(page, tile);
  await page.mouse.move(p.x, p.y);
  await sleep(160);
  await page.mouse.click(p.x, p.y);
  const done = await page
    .waitForFunction((t) => window.__mercadia.state().buildings.some((b) => b.tile === t), tile, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  await page.keyboard.press('Escape');
  return done;
};

/** Click a building on the canvas until the Inspector is on it. */
const inspect = async (page, tile) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  for (const dy of [0, -8, -16, 6]) {
    const p = await tileXY(page, tile);
    await page.mouse.click(p.x, p.y + dy);
    await sleep(220);
    if ((await M(page, () => window.__mercadia.selectedTile)) === tile) return true;
  }
  return false;
};

/** Upgrade the inspected shop through its Inspector button, if it is offered and affordable. */
const upgrade = async (page, tile) => {
  if (!(await inspect(page, tile))) return false;
  const btn = page.locator('#inspector [data-act="upgrade"]');
  if (!(await btn.count()) || (await btn.isDisabled())) return false;
  const before = (await state(page)).buildings.find((b) => b.tile === tile)?.level ?? 0;
  await btn.click();
  return page
    .waitForFunction(([t, lv]) => (window.__mercadia.state().buildings.find((b) => b.tile === t)?.level ?? 0) > lv, [tile, before], { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
};

/**
 * Three vacant lots joined edge to edge: the most central such block, with a pull toward the
 * ringed starter corners. The first lot is the starter corner when the block holds one.
 */
const pickBlock = (page) =>
  M(page, () => {
    const m = window.__mercadia;
    const free = new Set(m.freeLots());
    const ringed = new Set(m.guide().lots ?? []);
    const xy = (t) => [t % 12, Math.floor(t / 12)];
    const near = (t) => [t - 1, t + 1, t - 12, t + 12].filter((n) => free.has(n) && Math.abs(xy(n)[0] - xy(t)[0]) + Math.abs(xy(n)[1] - xy(t)[1]) === 1);
    let best = null;
    let bs = 1e9;
    for (const a of free) {
      for (const b of near(a)) {
        for (const c of [...near(b), ...near(a)]) {
          if (c === a || c === b) continue;
          const trio = [a, b, c];
          const cx = trio.reduce((s, t) => s + xy(t)[0], 0) / 3;
          const cy = trio.reduce((s, t) => s + xy(t)[1], 0) / 3;
          const score = Math.hypot(cx - 5.5, cy - 5.5) - (trio.some((t) => ringed.has(t)) ? 1.5 : 0);
          if (score < bs) {
            bs = score;
            best = trio.slice().sort((p, q) => (ringed.has(q) ? 1 : 0) - (ringed.has(p) ? 1 : 0));
          }
        }
      }
    }
    return best;
  });

/** Drop any armed tool and close the Inspector. */
const clearSel = async (page) => {
  for (let i = 0; i < 6; i++) {
    const busy = await M(page, () => window.__mercadia.tool !== null || window.__mercadia.selectedTile >= 0);
    if (!busy) return;
    await page.keyboard.press('Escape');
    await sleep(120);
  }
};

/** Solo: step on until no city event is forecast or running, for a calm frame of ordinary play. */
const calm = async (page) => {
  for (let i = 0; i < 40; i++) {
    if ((await state(page)).event === null) return;
    await M(page, () => window.__mercadia.warp(30));
  }
};

/** Solo: step past a Cloudburst (forecast or falling) so the capture is of the sunlit city. */
const clearSkies = async (page) => {
  for (let i = 0; i < 14; i++) {
    if ((await state(page)).event !== 'cloudburst') return;
    await M(page, () => window.__mercadia.warp(50));
  }
};

/** A vacant lot sharing an edge with one of mine (to grow the enclave), else any vacant lot. */
const growLot = (page, avenue = null) =>
  M(
    page,
    (avenue) => {
      const m = window.__mercadia;
      const s = m.state();
      const own = s.buildings.filter((b) => b.owner === m.me).map((b) => b.tile);
      const free = m.freeLots().filter((t) => avenue === null || m.avenueSide(t) === avenue);
      const d = (a, b) => Math.abs((a % 12) - (b % 12)) + Math.abs(Math.floor(a / 12) - Math.floor(b / 12));
      let best = -1;
      let bd = 99;
      for (const t of free) {
        const dist = Math.min(...own.map((o) => d(o, t)), 98);
        if (dist < bd) {
          bd = dist;
          best = t;
        }
      }
      return best;
    },
    avenue,
  );

/** Choose a charter card in the open Era Council. */
const pickCharter = async (page, nth = 0) => {
  await page.waitForSelector('#council:not([hidden]) .charter[data-key]', { timeout: 20000 });
  await page.locator('#council .charter[data-key]').nth(nth).click();
  await page.waitForSelector('#council .charter.sealed', { timeout: 4000 });
};

/** Solo: run to the next Era Council (the warp holds as it opens). */
const toCouncil = async (page) => {
  await M(page, () => window.__mercadia.warp(4000, true));
  await page.waitForFunction(() => window.__mercadia.state().phase === 'council', null, { timeout: 8000 });
  await page.waitForSelector('#council:not([hidden])', { timeout: 8000 });
};
const advance = async (page) => {
  await page.click('#council [data-act="advance"]');
  await page.waitForFunction(() => window.__mercadia.state().phase === 'playing', null, { timeout: 5000 });
};
/** Solo: warp to a tick within the current era (0..eraTicks). */
const toEraTick = (page, at) =>
  M(
    page,
    (at) => {
      const m = window.__mercadia;
      const s = m.state();
      const start = (s.quarter - 1) * 1500;
      const n = start + at - s.tick;
      if (n > 0) m.warp(n);
      return m.state().tick;
    },
    at,
  );
const openFeed = async (page) => {
  if (!(await M(page, () => document.getElementById('chronicle').classList.contains('open')))) await page.click('#chronicle [data-act="feed"]');
};

// ───────────────────────────── Solo, 1440×900 ─────────────────────────────

log('Solo 1440×900');
const solo = await open('solo');
await solo.click('#title [data-act="solo"]');
await solo.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.kind === 'solo');
await solo.mouse.move(720, 560);
await solo.waitForFunction(() => window.__mercadia.guide().step === 1 && window.__mercadia.guide().lots.length > 0);
await sleep(1500);
// 01 — the first seconds: objective banner, Founding Guide step 1, ringed starter corners, lock badges.
await shot(solo, '01-desktop-era1-onboarding.png', 1440, 900);

// Found a three-lot block: Roastery, Bistro, Pocket Park, edge to edge.
const block = await pickBlock(solo);
if (!block) throw new Error('no three adjacent vacant lots');
await build(solo, 'roastery', block[0]);
await inspect(solo, block[0]); // Founding Guide, step 2
await build(solo, 'bistro', block[1]);
await build(solo, 'park', block[2]); // step 3: the guide retires
log(`  block ${block.join(', ')} · guide ${JSON.stringify(await M(solo, () => window.__mercadia.guide()))}`);
// Late morning into noon of Era I: the AI Houses have opened their first doors.
await toEraTick(solo, 660);
await clearSkies(solo);
await clearSel(solo);
{
  // Frame the block a little left of centre so the Inspector on the right covers none of it.
  const xs = block.map((t) => t % 12);
  const ys = block.map((t) => Math.floor(t / 12));
  const cx = xs.reduce((a, b) => a + b, 0) / 3 + 0.5;
  const cy = ys.reduce((a, b) => a + b, 0) / 3 + 0.5;
  await M(solo, ([x, y]) => window.__mercadia.look(x + 0.9, y - 0.9, 2.5), [cx, cy]);
  await sleep(300);
  await inspect(solo, block[1]);
  await solo.mouse.move(40, 520);
  await settle(solo, 500);
}
// 02 — heraldry and ownership: kerbs, enclave wash, crest banners, Inspector with its diagnosis.
await shot(solo, '02-desktop-heraldry-ownership.png', 1440, 900);
await clearSel(solo);
await solo.click('#clock [data-act="fit"]');

// The close of Era I: the Era Council.
await toCouncil(solo);
await pickCharter(solo, 0);
await solo.mouse.move(1380, 520);
await solo.waitForFunction(() => getComputedStyle(document.querySelector('#council [data-act="advance"]')).backgroundColor === 'rgb(30, 26, 22)', null, { timeout: 8000 }).catch(() => undefined);
await settle(solo, 400);
// 03 — Era Council: Era II unlocks, standings with deltas, three Dynasty Charters, one sealed.
await shot(solo, '03-desktop-era-council-unlocks.png', 1440, 900);
await advance(solo);

// Era II: a Nightmarket beside the block, second storeys on the first two shops.
await settle(solo, 200);
if ((await cash(solo)) >= 320) await build(solo, 'nightmarket', await growLot(solo));
await upgrade(solo, block[1]);
await upgrade(solo, block[0]);
await toEraTick(solo, 600);
if ((await cash(solo)) >= 520) await build(solo, 'arcade', await growLot(solo));
await clearSel(solo);
await toCouncil(solo);
await pickCharter(solo, 0);
await advance(solo);

// Era III, Grand Boulevard: Level 3 architecture and a Boutique.
await settle(solo, 200);
if ((await cash(solo)) < 450) await solo.click('#treasury [data-act="borrow"]');
await upgrade(solo, block[1]);
await upgrade(solo, block[0]);
if ((await cash(solo)) >= 700) await build(solo, 'boutique', await growLot(solo));
await clearSel(solo);
await toEraTick(solo, 500);
for (const b of await mine(solo)) if (b.kind !== 'park' && b.level < 3 && (await cash(solo)) > 600) await upgrade(solo, b.tile);
await clearSkies(solo);
await clearSel(solo);
await solo.click('#clock [data-act="fit"]');
await openFeed(solo);
await solo.mouse.move(720, 620);
await settle(solo, 600);
await clearSel(solo);
log(`  Era ${await M(solo, () => window.__mercadia.era)} · mine ${(await mine(solo)).map((b) => `${b.kind}:L${b.level}`).join(' ')} · stars ${JSON.stringify((await M(solo, () => window.__mercadia.milestones)).map((m) => m.stars))}`);
// 04 — mid-game: Chronicle banner and feed, Milestone stars, charter badges, Level 3 on the boulevard.
await shot(solo, '04-desktop-chronicle-midgame.png', 1440, 900);

// Era III closes, Era IV plays out, the Final Edition goes to press.
await toCouncil(solo);
await pickCharter(solo, 0);
await advance(solo);
await M(solo, () => window.__mercadia.warp(1600));
await solo.waitForSelector('#victory:not([hidden]) .victory', { timeout: 10000 });
await solo.mouse.move(1400, 880);
await settle(solo, 900);
// 05 — the Final Edition: winning crest, Crown equation, era chart, honours.
await shot(solo, '05-desktop-final-edition.png', 1440, 900);
await solo.context().close();

// ───────────────────────────── Multiplayer: two browsers, one room ─────────────────────────────

log('Multiplayer 2 × 1440×900');
const host = await open('host');
await host.fill('#t-name', 'Ada');
await host.click('#title [data-act="create"]');
await host.waitForFunction(() => window.__mercadia.phase === 'lobby' && window.__mercadia.seat === 0 && !!window.__mercadia.lobby, null, { timeout: 15000 });
const code = await M(host, () => window.__mercadia.roomCode);
const guest = await open('guest');
await guest.fill('#t-name', 'Bruno');
await guest.fill('#t-code', code);
await guest.click('#title [data-act="join"]');
await guest.waitForFunction(() => window.__mercadia.phase === 'lobby' && window.__mercadia.seat === 1, null, { timeout: 15000 });
await host.waitForFunction(() => window.__mercadia.lobby.seats.filter((s) => s.kind === 'human' && s.connected).length === 2, null, { timeout: 15000 });
await host.click('#lobby [data-act="mode"][data-v="blitz"]');
await guest.waitForFunction(() => window.__mercadia.lobby.mode === 'blitz');
await host.click('#lobby [data-act="start"]');
for (const p of [host, guest]) await p.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.me >= 0 && window.__mercadia.state().players.length === 4, null, { timeout: 15000 });
log(`  room ${code} · ${(await state(host)).players.map((p) => `${p.name}/${p.house}`).join(' ')}`);
// Each human founds a two-shop block of their own, on the live room clock.
const hostBlock = await pickBlock(host);
await build(host, 'roastery', hostBlock[0]);
await guest.waitForFunction((t) => window.__mercadia.state().buildings.some((b) => b.tile === t), hostBlock[0], { timeout: 8000 });
const guestBlock = await pickBlock(guest);
await build(guest, 'bistro', guestBlock[0]);
await build(host, 'bistro', hostBlock[1]);
await build(guest, 'roastery', guestBlock[1]);
await inspect(host, hostBlock[0]);
await inspect(guest, guestBlock[0]);
await host.keyboard.press('Escape');
await guest.keyboard.press('Escape');
await build(host, 'park', hostBlock[2]);
await host.keyboard.press('Escape');
// The host quickens the room to reach the Era I Council, where both Houses adopt a charter.
await host.click('#clock [data-act="speed"][data-v="2"]');
for (const p of [host, guest]) await p.waitForFunction(() => window.__mercadia.state().phase === 'council', null, { timeout: 70000 });
await pickCharter(host, 0);
await pickCharter(guest, 1);
for (const p of [host, guest]) await p.waitForFunction(() => window.__mercadia.state().phase === 'playing' && window.__mercadia.era === 2, null, { timeout: 25000 });
await host.click('#clock [data-act="speed"][data-v="1"]');
// Era II: each opens one of the new trades beside their block.
if ((await cash(host)) >= 320) await build(host, 'nightmarket', await growLot(host));
if ((await cash(guest)) >= 260) await build(guest, 'arcade', await growLot(guest));
for (const p of [host, guest]) {
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await p.mouse.move(720, 640);
}
await Promise.all([openFeed(host), openFeed(guest)]);
await Promise.all([settle(host, 300), settle(guest, 300)]);
{
  const [sa, sb] = await Promise.all([state(host), state(guest)]);
  log(`  host tick ${sa.tick} era ${sa.era} buildings ${sa.buildings.length} · guest tick ${sb.tick} era ${sb.era} buildings ${sb.buildings.length}`);
  log(`  charters ${JSON.stringify(sa.players.map((p) => p.charters))}`);
}
// 06 + 07 — the same instant of the same room, from the host's seat and the guest's.
await Promise.all([shot(host, '06-desktop-mp-host.png', 1440, 900), shot(guest, '07-desktop-mp-guest.png', 1440, 900)]);
await host.context().close();
await guest.context().close();

// ───────────────────────────── Phone, 390×844 ─────────────────────────────

log('Mobile 390×844');
const phone = await open('phone', PHONE);
await phone.tap('#title [data-act="solo"]');
await phone.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.kind === 'solo');
await phone.waitForFunction(() => window.__mercadia.guide().step === 1 && window.__mercadia.guide().lots.length > 0);
// Tap-preview, then tap again to build: a Roastery on a ringed starter corner.
const tapBuild = async (kind, tile) => {
  const civic = kind === 'park' || kind === 'tramstop' || kind === 'plaza';
  await phone.tap(`#docktabs [data-tab="${civic ? 'civic' : 'shops'}"]`);
  await phone.tap(`#dock [data-kind="${kind}"]`);
  const p = await tileXY(phone, tile);
  await phone.touchscreen.tap(p.x, p.y);
  await sleep(250);
  await phone.touchscreen.tap(p.x, p.y);
  await phone.waitForFunction((t) => window.__mercadia.state().buildings.some((b) => b.tile === t), tile, { timeout: 4000 }).catch(() => undefined);
};
const phoneBlock = await pickBlock(phone);
await tapBuild('roastery', phoneBlock[0]);
await M(phone, () => window.__mercadia.warp(420));
await calm(phone);
await phone.tap('#docktabs [data-tab="shops"]');
await settle(phone, 500);
// 08 — Era I on a phone: crest score strip, compact Chronicle, guide bar, tabbed dock with lock badges.
await shot(phone, '08-mobile-era1-play.png', 390, 844);

// Grow the block, then open the bottom-sheet Inspector on the first shop.
await tapBuild('bistro', phoneBlock[1]);
await M(phone, () => window.__mercadia.warp(240));
await calm(phone);
{
  const p = await tileXY(phone, phoneBlock[0]);
  await phone.touchscreen.tap(p.x, p.y - 4);
  await phone.waitForFunction(() => !document.getElementById('inspector').hidden, null, { timeout: 4000 }).catch(() => undefined);
}
await settle(phone, 700);
// 09 — the bottom-sheet Inspector: diagnosis first, crest, price stance, the block kept in view.
await shot(phone, '09-mobile-chronicle-inspector.png', 390, 844);
// 09b — the Era Council on a phone: one scrollable column, large tap targets.
await M(phone, () => window.__mercadia.warp(2000, true));
await phone.waitForSelector('#council:not([hidden]) .charter[data-key]', { timeout: 8000 });
await phone.locator('#council .charter[data-key]').first().tap();
await settle(phone, 500);
await shot(phone, '09b-mobile-era-council.png', 390, 844);
await phone.context().close();

// ───────────────────────────── Walkthrough video (optional) ─────────────────────────────

if (VIDEO) {
  log('Walkthrough video');
  // Chrome's own screencast frames, stitched by the system ffmpeg (VP9 WebM). Skipped quietly
  // where ffmpeg is not installed.
  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  if (!hasFfmpeg) log('  skip walkthrough video — ffmpeg not found');
  else {
    const dir = mkdtempSync(join(tmpdir(), 'mercadia-video-'));
    const ctx = await browser.newContext(DESKTOP);
    const v = await ctx.newPage();
    watch(v, 'video');
    await v.goto(BASE);
    await v.waitForFunction(() => window.__mercadia && window.__mercadia.state().ready, null, { timeout: 20000 });
    await v.evaluate(() => document.fonts.ready);
    const cdp = await ctx.newCDPSession(v);
    const frames = [];
    cdp.on('Page.screencastFrame', (f) => {
      const file = join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(f.data, 'base64'));
      frames.push({ file, t: f.metadata.timestamp });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1440, maxHeight: 900, everyNthFrame: 2 });
    const glide = async (tile) => {
      const p = await tileXY(v, tile);
      await v.mouse.move(p.x, p.y, { steps: 20 });
    };
    const place = async (kind, tile) => {
      await v.click(`#dock [data-kind="${kind}"]`);
      await glide(tile);
      await sleep(900);
      await v.mouse.down();
      await v.mouse.up();
    };
    // The living title screen, then one click into a Standard match.
    await sleep(1800);
    await v.click('#title [data-act="solo"]');
    await v.waitForFunction(() => window.__mercadia.phase === 'playing');
    await v.mouse.move(720, 600, { steps: 12 });
    await sleep(4200);
    // Founding Guide: claim a ringed corner, inspect the shop, shape the block.
    const vb = await pickBlock(v);
    await place('roastery', vb[0]);
    await sleep(1800);
    await inspect(v, vb[0]);
    await sleep(3200);
    await clearSel(v);
    await place('bistro', vb[1]);
    await sleep(1500);
    await clearSel(v);
    await place('park', vb[2]);
    await sleep(2600);
    await clearSel(v);
    await v.click('#clock [data-act="speed"][data-v="3"]');
    await sleep(7000);
    await v.click('#clock [data-act="speed"][data-v="1"]');
    // The close of Era I: the Era Council, a charter, and on into Transit & Trade.
    await toCouncil(v);
    await sleep(3500);
    await v.locator('#council .charter[data-key]').nth(1).hover();
    await sleep(1200);
    await pickCharter(v, 1);
    await sleep(2200);
    await advance(v);
    await sleep(4500);
    const g = await growLot(v);
    if (g >= 0 && (await cash(v)) >= 320) await place('nightmarket', g);
    await sleep(1200);
    await clearSel(v);
    await v.click('#clock [data-act="speed"][data-v="2"]');
    await sleep(8000);
    await cdp.send('Page.stopScreencast');
    await sleep(300);
    await ctx.close();
    // Each frame is held until the next one arrives, so the film runs at the pace it was played.
    let list = '';
    for (let i = 0; i < frames.length; i++) {
      const next = i + 1 < frames.length ? frames[i + 1].t : frames[i].t + 0.2;
      list += `file '${frames[i].file}'\nduration ${Math.max(0.01, next - frames[i].t).toFixed(3)}\n`;
    }
    if (frames.length) list += `file '${frames[frames.length - 1].file}'\n`;
    const listFile = join(dir, 'frames.txt');
    writeFileSync(listFile, list);
    const dst = join(OUT, '10-solo-walkthrough.webm');
    const enc = spawnSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=20,scale=1440:900:flags=lanczos,format=yuv420p', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '37', '-deadline', 'good', '-cpu-used', '3', '-row-mt', '1', '-an', dst],
      { encoding: 'utf8' },
    );
    if (enc.status !== 0) errors.push(`walkthrough video: ffmpeg failed — ${(enc.stderr ?? '').trim().split('\n')[0]}`);
    else {
      const bytes = statSync(dst).size;
      const secs = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
      saved.push({ name: '10-solo-walkthrough.webm', w: 1440, h: 900, bytes, good: bytes > 100000 });
      log(`  ok   10-solo-walkthrough.webm — 1440×900 VP9, ${secs.toFixed(0)} s, ${frames.length} frames, ${(bytes / 1048576).toFixed(1)} MiB`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

await browser.close();
const total = saved.reduce((a, s) => a + s.bytes, 0);
log(`\n${saved.length} files in ${OUT} · ${(total / 1048576).toFixed(1)} MiB`);
if (errors.length) {
  log(`\n${errors.length} problem(s):`);
  for (const e of errors.slice(0, 30)) log('  ' + e);
  process.exit(1);
}
log('0 console errors · 0 page errors · 0 failed requests');
