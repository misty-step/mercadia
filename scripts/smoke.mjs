// Acceptance smoke: drives the REAL app (wrangler dev: Worker + Durable Object rooms + built client)
// in real Chrome via playwright-core. It maps to PRODUCT.md "Acceptance checks" 1–17 and the QA bar.
//
//   npm run build && npm run dev        (in another shell)
//   npm run smoke                       BASE=http://127.0.0.1:8787  CHROME=/usr/bin/google-chrome
//
//   ONLY=solo,hotseat,mobile,room,relay,idle   run sections selectively
//   FAST=1                                      shorten the 2-minute/5-minute idle checks to 20 s (NOT acceptance-grade)
//   MEDIA=/path                                 directory for videos and screenshots (default ~/chief-evidence/media)
//
// Every page must finish with zero console errors/warnings, zero page errors, zero
// securitypolicyviolation events and zero failed network/WebSocket requests.
import { chromium } from 'playwright-core';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const FAST = process.env.FAST === '1';
const MEDIA = process.env.MEDIA ?? join(homedir(), 'chief-evidence', 'media');
const RAW = join(MEDIA, '.raw');
const ONLY = (process.env.ONLY ?? 'solo,hotseat,mobile,room,relay,idle').split(',');
const IDLE_MS = FAST ? 20_000 : 125_000;
const HEARTBEAT_MS = FAST ? 30_000 : 300_000;
mkdirSync(MEDIA, { recursive: true });
rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

const results = [];
let failures = 0;
const ok = (cond, name, detail = '') => {
  results.push({ name, pass: !!cond, detail: String(detail) });
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  — ' + detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const pages = []; // for the final hygiene check

async function ctx(name, { mobile = false, video = true } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    recordVideo: video ? { dir: RAW, size: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } } : undefined,
  });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { context, name };
}

async function openPage(c, tag) {
  const page = await c.context.newPage();
  const rec = { tag: `${c.name}/${tag}`, issues: [], page };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') rec.issues.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => rec.issues.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => rec.issues.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) rec.issues.push(`http ${r.status()}: ${r.url()}`);
  });
  pages.push(rec);
  return page;
}

async function finishCtx(c, videoName, pagesToName = []) {
  const paths = [];
  for (const p of c.context.pages()) {
    const v = p.video();
    if (v) paths.push(v);
  }
  await c.context.close();
  let i = 0;
  for (const v of paths) {
    try {
      const src = await v.path();
      const name = pagesToName[i] ?? `${videoName}${paths.length > 1 ? '-' + (i + 1) : ''}`;
      copyFileSync(src, join(MEDIA, `${name}.webm`));
    } catch {
      // ignore
    }
    i++;
  }
}

const shot = (page, name) => page.screenshot({ path: join(MEDIA, `${name}.png`) });

// ── helpers over the real UI ──
const M = (page) =>
  page.evaluate(() => {
    const m = window.__mercadia;
    const g = m.view.game;
    return { turn: m.turn, hash: m.hash, cash: g.players[Math.max(0, m.seat)].cash, units: g.units.map((u) => `${u.id}:${u.tile}`).join(','), draft: m.draft.length, seat: m.seat, resolutions: m.view.resolutions, ready: m.view.ready, label: m.view.endTurn.label, status: m.view.status.text, notices: m.view.notices.map((n) => n.text), phase: m.phase };
  });
const tileClick = async (page, tile, opts = {}) => {
  const pos = await page.evaluate((t) => window.__mercadia.tileScreenPos(t), tile);
  if (!pos) throw new Error(`tile ${tile} off screen`);
  await page.mouse.click(pos.x, pos.y, opts);
};
const endBtn = (page) => page.getByRole('button', { name: /^(End Turn|Cancel Ready|Saving draft|Choose a Charter|Reconnecting|Resolving)/ }).last();
const startSolo = async (page, query = '') => {
  await page.goto(`${BASE}/?dev=1${query}`);
  await page.getByRole('button', { name: /Play Solo Now/i }).click();
  await page.waitForFunction(() => window.__mercadia?.phase === 'planning');
  await sleep(400);
};
const turnOf = async (page) => (await M(page)).turn;
const waitTurn = (page, n, timeout = 15000) => page.waitForFunction((t) => window.__mercadia?.turn === t, n, { timeout });

// ═════════════════════════════ SOLO ═════════════════════════════
async function solo() {
  const c = await ctx('solo');
  const page = await openPage(c, 'desktop');
  await startSolo(page);
  await shot(page, '01-solo-turn1-1440x900');

  // 2. End Turn advances exactly once (mouse, Enter, Space; double-click; held key)
  // (done after the planning checks so the earlier checks run on Turn 1)

  // 3. Undo: a Factor move and the construction that depends on it
  const m0 = await M(page);
  await tileClick(page, 19); // select the Factor (7,1): selecting one of your units arms Move
  await sleep(300);
  await tileClick(page, 17); // (5,1): two tiles west
  await sleep(200);
  await page.getByRole('button', { name: /Roastery, §180/ }).click();
  await tileClick(page, 4); // lot (4,0), only reachable after the move
  await sleep(300);
  let st = await page.evaluate(() => ({ d: window.__mercadia.draft, a: window.__mercadia.view.actions, c: window.__mercadia.view.projectedCash }));
  ok(st.d.length === 2 && st.d[0].t === 'move' && st.d[1].t === 'build', 'undo: move + dependent build queued', JSON.stringify(st.d));
  ok(st.a.used === 2 && st.c === m0.cash - 180, 'undo: Actions 2 used, projected cash −§180', JSON.stringify(st));
  await shot(page, '02-solo-queued-move-and-build');
  await page.getByRole('button', { name: /^Orders/ }).click();
  await sleep(300);
  await shot(page, '03-solo-orders-drawer');
  const names = await page.locator('[data-act="undo"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  // The per-row Undo of the FIRST order (the move)
  await page.locator('[data-act="undo"][data-arg="0"]').click();
  await sleep(300);
  st = await page.evaluate(() => ({ d: window.__mercadia.draft, a: window.__mercadia.view.actions, c: window.__mercadia.view.projectedCash, h: window.__mercadia.hash }));
  ok(st.d.length === 0, 'undo: removing the move removed the dependent build too', `${JSON.stringify(st.d)} buttons=${names.join('|')}`);
  ok(st.a.used === 0 && st.c === m0.cash && st.h === m0.hash, 'undo: Actions and projected cash restored, world hash unchanged');
  await page.keyboard.press('Escape');

  // 4. Budgets
  const unitsTab = page.getByRole('button', { name: /^Units/ }).first();
  await unitsTab.click();
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: /^Factor, §90/ }).first().click();
  await page.getByRole('button', { name: /^Study orders/ }).click();
  await page.getByRole('button', { name: /^Fine Roasting/ }).click();
  await sleep(200);
  st = await page.evaluate(() => ({ a: window.__mercadia.view.actions, n: window.__mercadia.draft.length }));
  ok(st.a.used === 5 && st.n === 5, 'budgets: five orders fill the five Actions', JSON.stringify(st));
  await page.getByRole('button', { name: /^Build orders/ }).click();
  await page.getByRole('button', { name: /Pocket Park/ }).first().click({ force: true });
  await sleep(300);
  const reason = await page.evaluate(() => document.body.innerText);
  ok(/No Actions left/.test(reason), 'budgets: a sixth order is refused with the reason "No Actions left"');
  await shot(page, '04-solo-actions-spent');
  await page.keyboard.press('Escape');
  // Treasury limit: clear and queue Bistros until cash runs out
  await page.getByRole('button', { name: /^Orders/ }).click();
  await page.getByRole('button', { name: /Clear all/ }).click();
  await page.getByRole('button', { name: /^Close/ }).first().click().catch(() => {});
  await page.getByRole('button', { name: /^Build orders/ }).click();
  for (const t of [6, 30, 31]) {
    await page.getByRole('button', { name: /Bistro, §280|Bistro/ }).first().click();
    await tileClick(page, t);
    await sleep(150);
  }
  await page.getByRole('button', { name: /Roastery/ }).first().click({ force: true });
  await sleep(300);
  const txt = await page.evaluate(() => document.body.innerText);
  ok(/Not enough §/.test(txt), 'budgets: exceeding the treasury shows "Not enough §" with the figures');
  await shot(page, '05-solo-treasury-refused');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Orders/ }).click();
  await page.getByRole('button', { name: /Clear all/ }).click();
  await page.getByRole('button', { name: /^Close/ }).first().click().catch(() => {});

  // 2. End Turn: click, Enter, Space, double-click, held key
  await page.getByRole('button', { name: /^Build orders/ }).click();
  await page.getByRole('button', { name: /Roastery/ }).first().click();
  await tileClick(page, 31);
  await sleep(200);
  let t = await turnOf(page);
  await endBtn(page).click();
  await waitTurn(page, t + 1);
  ok((await turnOf(page)) === t + 1, 'end turn: one click advances exactly one turn', `turn ${t} → ${await turnOf(page)}`);
  const delta = await page.evaluate(() => ({ from: window.__mercadia.summary?.from, to: window.__mercadia.summary?.to }));
  ok(delta.from === t && delta.to === t + 1, 'end turn: the Turn Delta covers exactly N→N+1', JSON.stringify(delta));
  await sleep(500);
  await shot(page, '06-solo-turn-delta');
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await sleep(700);
  t = await turnOf(page);
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.keyboard.press('Enter');
  await sleep(1000);
  ok((await turnOf(page)) === t + 1, 'end turn: Enter (nothing focused) advances exactly one turn', `${t} → ${await turnOf(page)}`);
  t = await turnOf(page);
  await sleep(700);
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.keyboard.press(' ');
  await sleep(1000);
  ok((await turnOf(page)) === t + 1, 'end turn: Space (nothing focused) advances exactly one turn', `${t} → ${await turnOf(page)}`);
  t = await turnOf(page);
  await sleep(700);
  await endBtn(page).dblclick();
  await sleep(1000);
  ok((await turnOf(page)) === t + 1, 'end turn: a double-click advances exactly one turn', `${t} → ${await turnOf(page)}`);
  t = await turnOf(page);
  await sleep(700);
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.keyboard.down('Enter');
  for (let i = 0; i < 6; i++) await page.keyboard.down('Enter'); // auto-repeat
  await page.keyboard.up('Enter');
  await sleep(1000);
  ok((await turnOf(page)) === t + 1, 'end turn: a held key advances exactly one turn', `${t} → ${await turnOf(page)}`);
  // focused End Turn via keyboard activates once
  t = await turnOf(page);
  await sleep(700);
  await endBtn(page).focus();
  await page.keyboard.press('Enter');
  await sleep(1000);
  ok((await turnOf(page)) === t + 1, 'end turn: a focused End Turn activates once by native keyboard semantics', `${t} → ${await turnOf(page)}`);
  // a focused control other than End Turn never ends the turn
  t = await turnOf(page);
  await sleep(700);
  await page.getByRole('button', { name: /^Fit board/ }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press(' ');
  await sleep(500);
  ok((await turnOf(page)) === t, 'end turn: Enter/Space on another focused control does not end the turn');

  // export + replay equivalence (acceptance 12) — replayed headlessly in node by the harness
  const exp = await page.evaluate(() => window.__mercadia.exportMatch());
  ok(exp && exp.log.length >= 6, 'replay: the match exports a seed and canonical action log', exp ? `${exp.log.length} turns` : 'null');
  if (exp) writeFileSync(join(RAW, 'solo-export.json'), JSON.stringify(exp));
  await finishCtx(c, 'solo-desktop-walkthrough');
}

// 1. Frozen planning: two minutes untouched (hover, inspect, pan, drawers), nothing changes
async function idleSolo() {
  const c = await ctx('idle', { video: false });
  const page = await openPage(c, 'frozen');
  await startSolo(page);
  const before = await M(page);
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < IDLE_MS) {
    const tile = [31, 30, 6, 19, 20, 44, 55, 66][i++ % 8];
    const pos = await page.evaluate((t) => window.__mercadia.tileScreenPos(t), tile);
    if (pos) {
      await page.mouse.move(pos.x, pos.y);
      if (i % 3 === 0) await page.mouse.click(pos.x, pos.y);
    }
    if (i % 4 === 0) await page.keyboard.press('t');
    if (i % 5 === 0) await page.keyboard.press('o');
    if (i % 6 === 0) await page.mouse.wheel(0, i % 2 ? 80 : -80);
    await sleep(2500);
  }
  const after = await M(page);
  ok(before.turn === after.turn && before.cash === after.cash && before.units === after.units && before.hash === after.hash, `frozen: after ${Math.round((Date.now() - t0) / 1000)} s of hovering, inspecting, panning and drawers the turn, cash, units and state hash are unchanged`, JSON.stringify({ before, after }));
  await finishCtx(c, 'idle');
}

// ═════════════════════════════ HOTSEAT ═════════════════════════════
async function hotseat() {
  const c = await ctx('hotseat');
  const page = await openPage(c, 'hotseat');
  await page.goto(`${BASE}/?dev=1`);
  await page.getByRole('button', { name: 'Hotseat', exact: true }).click();
  await page.getByLabel('Seat 1 name').fill('Ada');
  await page.getByLabel('Seat 2 name').fill('Bram');
  await page.getByText('Blitz', { exact: false }).first().click();
  await page.getByRole('button', { name: /Start hotseat match/ }).click();
  await page.waitForFunction(() => window.__mercadia?.phase === 'planning');
  await sleep(500);
  const t0 = await turnOf(page);
  // Ada plans: build a Roastery
  await page.getByRole('button', { name: /Roastery/ }).first().click();
  await tileClick(page, 31);
  await sleep(300);
  await shot(page, '07-hotseat-ada-planning');
  const adaDraft = await page.evaluate(() => window.__mercadia.draft.length);
  await endBtn(page).click();
  await sleep(600);
  const handoff = await page.evaluate(() => ({ text: document.body.innerText, seat: window.__mercadia.seat, draft: window.__mercadia.draft.length, turn: window.__mercadia.turn }));
  ok(adaDraft === 1 && /Pass to/i.test(handoff.text) && handoff.draft === 0 && handoff.turn === t0, 'hotseat: after the first seat ends, a handoff screen hides its draft and the turn has not resolved', JSON.stringify({ adaDraft, draft: handoff.draft, turn: handoff.turn }));
  await shot(page, '08-hotseat-handoff');
  await page.getByRole('button', { name: /^Begin .*turn/ }).click();
  await sleep(400);
  await page.getByRole('button', { name: /Roastery/ }).first().click();
  await tileClick(page, 6).catch(() => {});
  await endBtn(page).click();
  await waitTurn(page, t0 + 1);
  ok((await turnOf(page)) === t0 + 1, 'hotseat: the turn resolves only after the second seat ends', `${t0} → ${await turnOf(page)}`);
  const s = await page.evaluate(() => window.__mercadia.summary);
  ok(s && s.from === t0 && s.to === t0 + 1, 'hotseat: the table sees the Turn Delta N→N+1', s ? `${s.from}→${s.to}` : 'none');
  await sleep(500);
  await shot(page, '09-hotseat-turn-delta');
  await finishCtx(c, 'hotseat-walkthrough');
}

// ═════════════════════════════ MOBILE ═════════════════════════════
async function mobile() {
  const c = await ctx('mobile', { mobile: true });
  const page = await openPage(c, 'phone');
  await page.goto(`${BASE}/?dev=1`);
  await sleep(600);
  await shot(page, '10-mobile-title-390x844');
  await page.getByRole('button', { name: /Play Solo Now/i }).tap();
  await page.waitForFunction(() => window.__mercadia?.phase === 'planning');
  await sleep(600);
  await shot(page, '11-mobile-solo-planning');
  const geo = await page.evaluate(() => {
    const out = {};
    const q = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.innerText || b.getAttribute('aria-label') || ''));
    const end = q(/^End Turn/);
    const r = end?.getBoundingClientRect();
    out.end = r ? { w: r.width, h: r.height, bottom: r.bottom } : null;
    out.scrollX = document.documentElement.scrollWidth - window.innerWidth;
    out.small = [...document.querySelectorAll('button:not([hidden]), [role=button]')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); }).map((b) => (b.getAttribute('aria-label') || b.innerText).slice(0, 30));
    return out;
  });
  ok(geo.end && geo.end.h >= 56 && geo.end.w >= 140 && geo.end.bottom <= 844, 'mobile: End Turn is at least 140×56 and fully on screen at 390×844', JSON.stringify(geo.end));
  ok(geo.scrollX <= 1, 'mobile: no horizontal overflow', `scrollX ${geo.scrollX}`);
  ok(geo.small.length === 0, 'mobile: no visible tap target under 44px', geo.small.join(' | '));
  // two-tap build then End Turn by tap
  await page.getByRole('button', { name: /Roastery, §180/ }).tap();
  const pos = await page.evaluate(() => window.__mercadia.tileScreenPos(31));
  await page.touchscreen.tap(pos.x, pos.y);
  await sleep(300);
  const preview = await page.evaluate(() => window.__mercadia.draft.length);
  await page.touchscreen.tap(pos.x, pos.y);
  await sleep(300);
  const queued = await page.evaluate(() => window.__mercadia.draft.length);
  ok(preview === 0 && queued === 1, 'mobile: the first tap previews, the second tap queues', `${preview} → ${queued}`);
  await shot(page, '12-mobile-queued');
  const t = await turnOf(page);
  await endBtn(page).tap();
  await waitTurn(page, t + 1);
  await sleep(600);
  ok((await turnOf(page)) === t + 1, 'mobile: End Turn by tap advances exactly one turn');
  await shot(page, '13-mobile-turn-delta-sheet');
  const sheet = await page.evaluate(() => document.body.innerText);
  ok(/Turn \d+\s*→\s*\d+/.test(sheet), 'mobile: the Turn Delta opens as a bottom sheet after resolution');
  await finishCtx(c, 'mobile-walkthrough');
}

// ═════════════════════════════ ROOM (two independent browsers) ═════════════════════════════
async function makeRoom(tagA = 'A', tagB = 'B', { relayA = false, relayB = false, mode = 'Blitz', videos = true } = {}) {
  const cA = await ctx('room-' + tagA, { video: videos });
  const cB = await ctx('room-' + tagB, { video: videos });
  const A = await openPage(cA, tagA);
  const B = await openPage(cB, tagB);
  const rel = {};
  if (relayA) rel.A = installRelay(A);
  if (relayB) rel.B = installRelay(B);
  await A.goto(`${BASE}/?dev=1`);
  await A.getByRole('button', { name: /Create Room/i }).click();
  await A.waitForURL(/room=/);
  const code = new URL(A.url()).searchParams.get('room');
  await B.goto(`${BASE}/?dev=1&room=${code}`);
  await B.getByRole('button', { name: /Leave room/ }).waitFor();
  await A.getByLabel(/No AI/).check({ force: true }).catch(async () => {
    await A.getByText('No AI (Pure PvP)').click();
  });
  await A.getByText(mode, { exact: false }).first().click();
  await sleep(300);
  await A.getByRole('button', { name: /Start match/ }).click();
  await Promise.all([A, B].map((p) => p.waitForFunction(() => window.__mercadia?.phase === 'planning', null, { timeout: 15000 })));
  await sleep(500);
  return { cA, cB, A, B, code, rel };
}

async function queueRoastery(page, tile) {
  await page.getByRole('button', { name: /Roastery, §180/ }).click();
  await tileClick(page, tile);
  await sleep(250);
}

async function room() {
  const { cA, cB, A, B, rel } = await makeRoom('A', 'B', { relayA: true });
  // An established WebSocket survives context.setOffline, so going offline = cut the socket, then block new connections.
  const goOffline = async () => {
    await cA.context.setOffline(true);
    rel.A.cut();
  };
  await shot(A, '14-room-A-planning');
  const a0 = await M(A);
  const b0 = await M(B);
  ok(a0.turn === 1 && b0.turn === 1 && a0.hash === b0.hash, 'room: both browsers start on Turn 1 with the same state hash', `${a0.hash} ${b0.hash}`);
  ok(a0.seat !== b0.seat && a0.seat >= 0 && b0.seat >= 0, 'room: the two browsers hold two different seats', `${a0.seat},${b0.seat}`);

  // 6. A readies: A waits, B shows A Ready, nothing changes; B readies: exactly one resolution
  await queueRoastery(A, A0TileFor(a0.seat));
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true);
  await sleep(500);
  const aW = await M(A);
  const bW = await B.evaluate(() => ({ seats: window.__mercadia.view.seats.map((s) => `${s.name}:${s.ready}`), hash: window.__mercadia.hash, turn: window.__mercadia.turn }));
  ok(/Waiting for opponent/.test(aW.status) && aW.label === 'Cancel Ready', 'room: after A readies, A shows "Waiting for opponent…" and Cancel Ready', `${aW.status} / ${aW.label}`);
  ok(bW.seats.some((s) => s.endsWith(':true')) && bW.turn === 1 && bW.hash === b0.hash, 'room: B sees A as Ready and the world has not changed', JSON.stringify(bW));
  await shot(B, '15-room-B-sees-A-ready');
  await sleep(FAST ? 3000 : 20000);
  ok((await M(B)).hash === b0.hash && (await M(A)).turn === 1, 'room: the world stays frozen while waiting');

  // 7. Cancel Ready: A cancels, edits, readies again; B readies; one resolution with A's FINAL draft
  await endBtn(A).click(); // Cancel Ready
  await A.waitForFunction(() => window.__mercadia.view.ready === false);
  await A.keyboard.press('Escape');
  await A.evaluate(() => document.activeElement?.blur?.());
  await A.keyboard.press('Backspace'); // undo the first Roastery: the final draft is the edited lot only
  await sleep(300);
  await queueRoastery(A, A0TileFor(a0.seat, 1));
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true);
  await queueRoastery(B, B0TileFor(b0.seat));
  await endBtn(B).click();
  await Promise.all([A, B].map((p) => p.waitForFunction(() => window.__mercadia.turn === 2, null, { timeout: 15000 })));
  await sleep(500);
  const a1 = await M(A);
  const b1 = await M(B);
  const sA = await A.evaluate(() => window.__mercadia.summary);
  const sB = await B.evaluate(() => window.__mercadia.summary);
  ok(a1.turn === 2 && b1.turn === 2 && a1.hash === b1.hash, 'room: both browsers show Turn 2 with the same state hash', `${a1.hash} ${b1.hash}`);
  ok(sA.hash === sB.hash && sA.from === 1 && sA.to === 2 && JSON.stringify(sA.lines) === JSON.stringify(sB.lines), 'room: both browsers show the same Turn Delta (N→N+1)');
  const aBuilds = sA.lines.filter((l) => /completes Roastery/.test(l.text) && l.player === a0.seat);
  ok(aBuilds.length === 1 && sA.lines.some((l) => l.tile === A0TileFor(a0.seat, 1) && /Roastery/.test(l.text)), "room: the resolution used A's final draft (the edited lot)", JSON.stringify(aBuilds.map((l) => l.tile)));
  await shot(A, '16-room-A-turn-delta');
  await shot(B, '17-room-B-turn-delta');

  // 8. Reconnect during readiness: A readies, reloads; reclaims the seat, still Ready, same turn
  await queueRoastery(A, 55).catch(() => {});
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true);
  const seatBefore = (await M(A)).seat;
  await A.reload();
  await A.waitForFunction(() => window.__mercadia?.phase === 'planning' && window.__mercadia.view.status.text !== 'Reconnecting…', null, { timeout: 15000 });
  await sleep(600);
  let a2 = await M(A);
  ok(a2.seat === seatBefore && a2.ready === true && a2.turn === 2, 'room: A reloads, reclaims the same seat, still Ready, same turn', JSON.stringify({ seat: a2.seat, ready: a2.ready, turn: a2.turn }));
  // offline/online
  await goOffline();
  await A.waitForFunction(() => window.__mercadia.view.status.text === 'Reconnecting…', null, { timeout: 30000 });
  await shot(A, '18-room-A-reconnecting');
  await cA.context.setOffline(false);
  await A.waitForFunction(() => window.__mercadia.view.status.text !== 'Reconnecting…', null, { timeout: 30000 });
  await sleep(500);
  a2 = await M(A);
  ok(a2.seat === seatBefore && a2.ready === true && a2.turn === 2, 'room: A goes offline and back online, reclaims the seat, still Ready', JSON.stringify({ seat: a2.seat, ready: a2.ready, turn: a2.turn }));

  // 9. Reconnect across resolution: A offline (already Ready); B readies; A reconnects and shows Turn 3 + the same delta
  await goOffline();
  await A.waitForFunction(() => window.__mercadia.view.status.text === 'Reconnecting…', null, { timeout: 30000 });
  await endBtn(B).click();
  await B.waitForFunction(() => window.__mercadia.turn === 3, null, { timeout: 15000 });
  await cA.context.setOffline(false);
  await A.waitForFunction(() => window.__mercadia.turn === 3, null, { timeout: 30000 });
  await sleep(600);
  const a3 = await M(A);
  const b3 = await M(B);
  const sA3 = await A.evaluate(() => window.__mercadia.summary);
  const sB3 = await B.evaluate(() => window.__mercadia.summary);
  ok(a3.hash === b3.hash && sA3.from === 2 && sA3.to === 3 && sA3.hash === sB3.hash, 'room: A reconnects after the turn resolved and shows Turn 3, the same hash and the same Turn 2→3 delta as B', `${a3.turn} ${a3.hash} ${b3.hash}`);
  ok(a3.notices.some((n) => /resolved while you were offline/.test(n)), 'room: A is told "Turn 2 resolved while you were offline — unsent edits discarded"', a3.notices.join(' | '));
  await finishCtx(cA, 'room-browser-A');
  await finishCtx(cB, 'room-browser-B');
}

// seat → a lot within the seat's start reach (seat 0 at (7,1)/(8,1), seat 1 at (10,1)/(9,1))
const A0TileFor = (seat, alt = 0) => (seat === 0 ? [31, 30][alt] : [34, 33][alt]); // (7,2)/(6,2) and (10,2)/(9,2)
const B0TileFor = (seat) => (seat === 0 ? 32 : 35);

// ═════════════════════════════ RELAY ═════════════════════════════
// A WebSocket relay between the page and the room authority that can drop, hold, delay, reorder,
// replay and inject single messages, and cut the socket.
function installRelay(page) {
  const r = { log: [], rules: [], held: [], conns: [] };
  r.parse = (m) => {
    try {
      return JSON.parse(m);
    } catch {
      return null;
    }
  };
  page.routeWebSocket(/\/ws\/rooms\//, (ws) => {
    const srv = ws.connectToServer();
    const conn = { ws, srv };
    r.conns.push(conn);
    const handle = (dir, send) => (raw) => {
      const msg = r.parse(typeof raw === 'string' ? raw : raw.toString());
      if (msg && msg.t !== 'ping' && msg.t !== 'pong') r.log.push({ dir, msg });
      const rule = r.rules.find((x) => x.dir === dir && x.left > 0 && x.pred(msg));
      if (rule) {
        rule.left--;
        if (rule.kind === 'drop') return;
        if (rule.kind === 'hold') {
          r.held.push({ send, raw });
          return;
        }
      }
      send(raw);
    };
    ws.onMessage(handle('c2s', (m) => srv.send(m)));
    srv.onMessage(handle('s2c', (m) => ws.send(m)));
    ws.onClose(() => srv.close().catch?.(() => {}));
  });
  r.drop = (dir, pred, n = 1) => r.rules.push({ dir, pred, left: n, kind: 'drop' });
  r.hold = (dir, pred, n = 1) => r.rules.push({ dir, pred, left: n, kind: 'hold' });
  r.release = () => {
    const h = r.held.splice(0);
    for (const x of h) x.send(x.raw);
    return h.length;
  };
  r.live = () => r.conns[r.conns.length - 1];
  r.toServer = (msg) => r.live().srv.send(JSON.stringify(msg));
  r.toClient = (msg) => r.live().ws.send(JSON.stringify(msg));
  r.cut = () => r.live().ws.close();
  r.since = (i) => r.log.slice(i);
  return r;
}

async function relayChecks() {
  const { cA, cB, A, B, rel } = await makeRoom('RA', 'RB', { relayA: true, relayB: true });
  const ra = rel.A;
  const rb = rel.B;
  const seatA = (await M(A)).seat;
  const seatB = (await M(B)).seat;
  const tileA = A0TileFor(seatA);
  const tileB = B0TileFor(seatB);

  // 17 (first part) + 10: Turn 1 — A readies at epoch 0, ack held, duplicate answered, cancel, stale ack released
  await queueRoastery(A, tileA);
  await sleep(300);
  ra.hold('s2c', (m) => m?.t === 'readyAck' && m.ready === true && m.epoch === 1, 1);
  await endBtn(A).click();
  await sleep(600);
  let a = await M(A);
  ok(a.label === 'End Turn' && a.ready === false, 'late acks: with A\'s Ready acknowledgment held, A still shows End Turn (never an unacknowledged Ready)', a.label);
  await endBtn(A).click(); // duplicate press resends the same epoch
  await A.waitForFunction(() => window.__mercadia.view.ready === true, null, { timeout: 8000 });
  a = await M(A);
  ok(a.label === 'Cancel Ready', 'late acks: pressing End Turn again is safe — the duplicate is answered with Ready at epoch 1 and A shows Cancel Ready');
  await sleep(700); // outside the End Turn gesture guard
  await endBtn(A).click(); // cancel
  await A.waitForFunction(() => window.__mercadia.view.ready === false);
  const released = ra.release(); // the held "Ready epoch 1" ack arrives after "Planning epoch 2"
  await sleep(600);
  a = await M(A);
  ok(released >= 1 && a.ready === false && a.label === 'End Turn', 'late acks: the held Ready (epoch 1) ack released after Planning (epoch 2) leaves A Planning with End Turn showing');
  const bSeesA = await B.evaluate((s) => window.__mercadia.view.seats[s].ready, seatA);
  ok(bSeesA === false, 'late acks: B keeps showing A as Planning');
  const i0 = ra.log.length;
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true);
  const sent = ra.since(i0).find((x) => x.dir === 'c2s' && x.msg.t === 'ready');
  ok(sent && sent.msg.epoch === 2, "late acks: A's next End Turn sends epoch 2 and is recorded on that first press", JSON.stringify(sent?.msg));

  // B readies → Turn 1 resolves exactly once. Then Turn 2: first Ready carries epoch 0.
  await queueRoastery(B, tileB);
  const preResolved = (await M(A)).resolutions;
  await endBtn(B).click();
  await Promise.all([A, B].map((p) => p.waitForFunction(() => window.__mercadia.turn === 2, null, { timeout: 15000 })));
  await sleep(500);
  ok((await M(A)).resolutions === preResolved + 1, 'resolution: the turn applied exactly once on A');
  const resolvedMsgs = ra.log.filter((x) => x.dir === 's2c' && x.msg.t === 'resolved');
  ok(resolvedMsgs.length === 1 && resolvedMsgs[0].msg.game && resolvedMsgs[0].msg.summary && resolvedMsgs[0].msg.turn === 2 && resolvedMsgs[0].msg.hash, '15: one resolution message carries the Turn 2 state (turn + hash) together with the 1→2 summary');
  ok(resolvedMsgs[0].msg.game.turn === 2 && resolvedMsgs[0].msg.summary.from === 1 && resolvedMsgs[0].msg.summary.to === 2, '15: summary matches its state (1→2 with Turn 2 world)');

  // Turn 2 first Ready: epoch 0, one press
  await queueRoastery(A, A0TileFor(seatA, 1));
  await sleep(300);
  const i1 = ra.log.length;
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true, null, { timeout: 8000 });
  const first = ra.since(i1).filter((x) => x.dir === 'c2s' && x.msg.t === 'ready');
  ok(first.length === 1 && first[0].msg.turn === 2 && first[0].msg.epoch === 0 && first[0].msg.revision === 1, 'late acks: Turn 2 first Ready is ready{turn:2, revision:1, epoch:0}, recorded on the first press', JSON.stringify(first.map((x) => x.msg)));
  // a Turn 1 readyAck injected into A's socket changes nothing
  const before = await M(A);
  ra.toClient({ t: 'readyAck', turn: 1, ready: false, epoch: 5 });
  await sleep(400);
  const after = await M(A);
  ok(after.ready === before.ready && after.turn === before.turn && after.label === before.label, 'late acks: a Turn 1 readyAck injected in Turn 2 changes nothing');
  ok(!ra.since(i1).some((x) => x.dir === 'c2s' && x.msg.turn === 1), 'late acks: the relay log shows no Turn 1 message sent by A after the resolution');

  // 10. Retry safety: B readies → Turn 2 resolves; then the relay replays A's Turn 2 ready + cancelReady
  await queueRoastery(B, B0TileFor(seatB) === 32 ? 6 : 36).catch(() => {});
  await endBtn(B).click();
  await Promise.all([A, B].map((p) => p.waitForFunction(() => window.__mercadia.turn === 3, null, { timeout: 15000 })));
  await sleep(500);
  const snapA = await A.evaluate(() => ({ hash: window.__mercadia.hash, turn: window.__mercadia.turn, res: window.__mercadia.view.resolutions, ready: window.__mercadia.view.ready }));
  const bLogLen = rb.log.length;
  const replayReady = first[0].msg;
  const iR = ra.log.length;
  ra.toServer(replayReady);
  ra.toServer({ t: 'cancelReady', turn: 2, epoch: 1 });
  await sleep(800);
  const replies = ra.since(iR).filter((x) => x.dir === 's2c');
  const stateReplies = replies.filter((x) => x.msg.t === 'state');
  const snapA2 = await A.evaluate(() => ({ hash: window.__mercadia.hash, turn: window.__mercadia.turn, res: window.__mercadia.view.resolutions, ready: window.__mercadia.view.ready, sum: window.__mercadia.summary }));
  ok(stateReplies.length === 2 && stateReplies.every((x) => x.msg.turn === 3 && x.msg.hash === snapA.hash && x.msg.summary.from === 2 && x.msg.summary.to === 3 && x.msg.own && x.msg.own.epoch === 0 && x.msg.own.ready === false), '10: replayed Turn 2 ready/cancelReady are each answered with a Turn 3 state carrying the 2→3 summary and A\'s Turn 3 flag+epoch', JSON.stringify(replies.map((x) => [x.msg.t, x.msg.turn])));
  ok(replies.every((x) => x.msg.t === 'state') && snapA2.turn === 3 && snapA2.hash === snapA.hash && snapA2.res === snapA.res && snapA2.ready === false, '10: Turn #, the state hash, A\'s Ready and the Turn Delta are unchanged — no resolution, nothing reopened');
  ok(!rb.since(bLogLen).some((x) => x.dir === 's2c' && (x.msg.t === 'state' || x.msg.t === 'resolved' || x.msg.t === 'seats')), '10: B receives nothing for the replay');
  // After Turn 3 resolves, the same replay is answered with Turn 4 and the 3→4 summary
  await queueRoastery(A, 55).catch(() => {});
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true, null, { timeout: 8000 });
  await endBtn(B).click();
  await Promise.all([A, B].map((p) => p.waitForFunction(() => window.__mercadia.turn === 4, null, { timeout: 15000 })));
  const iR2 = ra.log.length;
  ra.toServer(replayReady);
  await sleep(700);
  const rep2 = ra.since(iR2).filter((x) => x.dir === 's2c' && x.msg.t === 'state');
  ok(rep2.length === 1 && rep2[0].msg.turn === 4 && rep2[0].msg.summary.from === 3 && rep2[0].msg.summary.to === 4, '10: after Turn 3 also resolves the same replay gets the Turn 4 state with its 3→4 summary, never the 2→3 one', JSON.stringify(rep2.map((x) => [x.msg.turn, x.msg.summary?.from])));

  // 14(a): edit the draft, drop the latest draft → "Saving draft…"; an injected ready for the unacked revision is rejected
  ra.drop('c2s', (m) => m?.t === 'draft', 1);
  const dBefore = await A.evaluate(() => window.__mercadia.view.revision);
  await A.getByRole('button', { name: /^Borrow/ }).click(); // an always-legal order whose draft message is dropped
  await sleep(500);
  const aSave = await M(A);
  const hashBefore = aSave.hash;
  ok(/Saving draft/.test(aSave.label), '14a: with the latest draft dropped, End Turn reads "Saving draft…"', aSave.label);
  const ackedBefore = await A.evaluate(() => window.__mercadia.view.ackedRevision);
  const iS = ra.log.length;
  ra.toServer({ t: 'ready', turn: 4, revision: ackedBefore + 1, epoch: 0 });
  await sleep(600);
  const errs = ra.since(iS).filter((x) => x.dir === 's2c' && x.msg.t === 'error');
  ok(errs.some((e) => e.msg.code === 'staleDraft'), '14a: the injected ready for the unacknowledged revision is rejected with staleDraft', JSON.stringify(errs.map((e) => e.msg)));
  const aAfter = await M(A);
  const bAfter = await B.evaluate((s) => ({ ready: window.__mercadia.view.seats[s].ready, hash: window.__mercadia.hash }), seatA);
  ok(aAfter.ready === false && bAfter.ready === false && aAfter.hash === hashBefore, '14a: A stays Planning in both browsers and the state hash does not change');
  void dBefore;

  // 15 (repeat) + 10 (repeat): A's resolution message is dropped; A reconnects and gets the same N+1 state
  await sleep(1200); // the draft resend lands
  const tNow = (await M(A)).turn;
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true, null, { timeout: 8000 });
  ra.drop('s2c', (m) => m?.t === 'resolved', 1);
  await endBtn(B).click();
  await B.waitForFunction((t) => window.__mercadia.turn === t + 1, tNow, { timeout: 15000 });
  await sleep(1000);
  const aStale = await M(A);
  ok(aStale.turn === tNow, '15: with A\'s resolution message dropped A still shows the old turn');
  ra.cut();
  await A.waitForFunction((t) => window.__mercadia.turn === t + 1, tNow, { timeout: 20000 });
  await sleep(500);
  const aFresh = await M(A);
  const bFresh = await M(B);
  ok(aFresh.hash === bFresh.hash && aFresh.turn === tNow + 1, '15: on reconnect A receives the same Turn N+1 state and hash in its join state, never showing the old world again', `${aFresh.turn} ${aFresh.hash} ${bFresh.hash}`);
  const wsJoins = ra.log.filter((x) => x.dir === 's2c' && x.msg.t === 'state').pop();
  ok(wsJoins && wsJoins.msg.summary && wsJoins.msg.summary.to === tNow + 1, '15: the join state carries the N→N+1 summary');

  // 10 (repeat): A drops its readyAck, B readies, A's resolution is dropped; A presses End Turn again → "already resolved" notice
  await queueRoastery(A, 55).catch(() => {});
  await sleep(300);
  const tN = (await M(A)).turn;
  ra.drop('s2c', (m) => m?.t === 'readyAck', 1);
  await endBtn(A).click();
  await sleep(700);
  ra.drop('s2c', (m) => m?.t === 'resolved', 1);
  await endBtn(B).click();
  await B.waitForFunction((t) => window.__mercadia.turn === t + 1, tN, { timeout: 15000 });
  await sleep(800);
  const aOld = await M(A);
  ok(aOld.turn === tN, '10 repeat: A still shows Turn N after its readyAck and the resolution message were dropped');
  await endBtn(A).click(); // resends ready for turn N
  await A.waitForFunction((t) => window.__mercadia.turn === t + 1, tN, { timeout: 15000 });
  await sleep(500);
  const aNow = await M(A);
  const bNow = await M(B);
  ok(aNow.hash === bNow.hash && aNow.notices.some((n) => new RegExp(`Turn ${tN} already resolved — showing Turn ${tN + 1}`).test(n)), `10 repeat: A shows Turn ${tN + 1} with B's hash and the notice "Turn ${tN} already resolved — showing Turn ${tN + 1}"`, aNow.notices.join(' | '));
  ok(aNow.ready === false && (await B.evaluate((s) => window.__mercadia.view.seats[s].ready, seatA)) === false, '10 repeat: A adopts Planning at epoch 0 for the new turn (B shows A as Planning) and no second resolution occurred');
  await shot(A, '19-relay-A-already-resolved');

  // 16: reconnect across resolution with pending work
  await queueRoastery(A, 36).catch(() => {});
  await sleep(600);
  const t16 = (await M(A)).turn;
  const rev16 = await A.evaluate(() => window.__mercadia.view.ackedRevision);
  ra.drop('s2c', (m) => m?.t === 'readyAck', 1);
  await endBtn(A).click();
  await sleep(500);
  ra.cut();
  await A.waitForFunction(() => window.__mercadia.view.status.text === 'Reconnecting…', null, { timeout: 15000 }).catch(() => {});
  // queue one more order while "Reconnecting…" (unsent local revision r+1)
  await A.getByRole('button', { name: /Roastery/ }).first().click().catch(() => {});
  await tileClick(A, 44).catch(() => {});
  await endBtn(B).click();
  await B.waitForFunction((t) => window.__mercadia.turn === t + 1, t16, { timeout: 15000 });
  await A.waitForFunction((t) => window.__mercadia.turn === t + 1, t16, { timeout: 30000 });
  await sleep(600);
  const a16 = await M(A);
  const b16 = await M(B);
  ok(a16.hash === b16.hash && a16.draft === 0 && a16.notices.some((n) => new RegExp(`Turn ${t16} resolved while you were offline — unsent edits discarded`).test(n)), `16: A shows Turn ${t16 + 1} with B's hash, the "resolved while you were offline" notice and the authority's empty draft`, JSON.stringify({ draft: a16.draft, notices: a16.notices }));
  const logAfter = ra.log.slice(ra.log.findLastIndex((x) => x.dir === 's2c' && x.msg.t === 'state'));
  ok(!logAfter.some((x) => x.dir === 'c2s' && x.msg.turn === t16 && ['draft', 'ready', 'cancelReady'].includes(x.msg.t)), '16: A sent no earlier-turn draft/ready/cancelReady after reconnecting');
  const i16 = ra.log.length;
  const hash16 = a16.hash;
  ra.toServer({ t: 'draft', turn: t16, revision: rev16 + 1, orders: [] });
  ra.toServer({ t: 'ready', turn: t16, revision: rev16, epoch: 1 });
  await sleep(800);
  const r16 = ra.since(i16).filter((x) => x.dir === 's2c');
  ok(r16.some((x) => x.msg.t === 'error' && x.msg.code === 'offTurnDraft') && r16.some((x) => x.msg.t === 'state' && x.msg.turn === t16 + 1), '16: an injected earlier-turn draft is rejected as off-turn and the replayed ready is answered with the current state');
  const a16b = await M(A);
  ok(a16b.hash === hash16 && a16b.ready === false && a16b.draft === 0, "16: A's draft, Ready state and the state hash are unchanged");

  // 14(e)/(privacy): nothing B receives contains A's draft or epoch
  const leaked = rb.log.filter((x) => x.dir === 's2c').some((x) => JSON.stringify(x.msg).includes('"epoch"') || JSON.stringify(x.msg).includes('"draft"') && x.msg.t !== 'state');
  const bStateOwn = rb.log.filter((x) => x.dir === 's2c' && x.msg.t === 'state').every((x) => x.msg.own === null || x.msg.player === seatB);
  ok(!leaked && bStateOwn, '14: nothing B receives over its socket contains A\'s draft or readiness epoch (only B\'s own state/acks)');
  await finishCtx(cA, 'relay-browser-A');
  await finishCtx(cB, 'relay-browser-B');
}

// 11. Heartbeats: both seats connected and idle; turn, world and Ready states unchanged
async function idleRoom() {
  const { cA, cB, A, B } = await makeRoom('HA', 'HB', { videos: false });
  const a0 = await M(A);
  const t0 = Date.now();
  while (Date.now() - t0 < HEARTBEAT_MS) await sleep(5000);
  const a1 = await M(A);
  const b1 = await M(B);
  ok(a0.turn === a1.turn && a0.hash === a1.hash && a1.hash === b1.hash && a1.ready === false && b1.ready === false, `heartbeats: after ${Math.round((Date.now() - t0) / 1000)} s of idle heartbeats the turn, world and Ready states are unchanged`, JSON.stringify({ a0, a1 }));
  await finishCtx(cA, 'idle-A');
  await finishCtx(cB, 'idle-B');
}

const sections = { solo, hotseat, mobile, room, relay: relayChecks };
const jobs = [];
for (const name of ['solo', 'hotseat', 'mobile', 'room', 'relay']) {
  if (ONLY.includes(name)) jobs.push(sections[name]().catch((e) => ok(false, `${name}: section crashed`, e.stack?.split('\n').slice(0, 3).join(' / '))));
}
if (ONLY.includes('idle')) {
  jobs.push(idleSolo().catch((e) => ok(false, 'idle solo crashed', e.message)));
  jobs.push(idleRoom().catch((e) => ok(false, 'idle room crashed', e.message)));
}
await Promise.all(jobs);

// Hygiene: zero console errors/warnings, page errors, CSP violations and failed requests anywhere.
for (const rec of pages) {
  let csp = [];
  try {
    csp = await rec.page.evaluate(() => window.__csp ?? []);
  } catch {
    // page closed with its context
  }
  const issues = rec.issues.filter((i) => !/net::ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|WebSocket connection to .* failed|Failed to load resource: net::ERR_INTERNET/.test(i) || !/offline|reconnect/i.test('')).filter((i) => true);
  ok(csp.length === 0, `hygiene ${rec.tag}: zero CSP violations`, csp.join(' | '));
  rec.hygiene = issues;
}
// Offline/online and relay-cut sections legitimately fail sockets on purpose; report them separately but strictly for the plain sections.
const strict = pages.filter((p) => /^(solo|hotseat|mobile|idle)\//.test(p.tag));
for (const rec of strict) ok(rec.issues.length === 0, `hygiene ${rec.tag}: zero console errors/warnings, page errors and failed requests`, rec.issues.slice(0, 4).join(' | '));
const roomPages = pages.filter((p) => /^room-/.test(p.tag));
for (const rec of roomPages) {
  const bad = rec.issues.filter((i) => !/WebSocket|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|net::ERR_/i.test(i));
  ok(bad.length === 0, `hygiene ${rec.tag}: zero console errors/warnings and page errors (deliberate offline/relay socket drops excluded)`, bad.slice(0, 4).join(' | '));
}

await browser.close();
try {
  for (const f of readdirSync(RAW)) if (f.endsWith('.json')) copyFileSync(join(RAW, f), join(MEDIA, '..', f));
} catch {
  // ignore
}
writeFileSync(join(MEDIA, '..', 'smoke-results.json'), JSON.stringify({ at: 'run', fast: FAST, base: BASE, results }, null, 2));
console.log(`\n${results.filter((r) => r.pass).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
