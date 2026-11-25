// Acceptance smoke: drives the REAL app (wrangler dev: Worker + Durable Object rooms + built client)
// in real Chrome via playwright-core. It maps to PRODUCT.md "Acceptance checks" 1–17 and the QA bar.
//
//   npm run build && npm run dev        (in another shell)
//   npm run smoke                       BASE=http://127.0.0.1:8787  CHROME=/usr/bin/google-chrome
//
//   ONLY=solo,hotseat,mobile,room,relay,endless,start,reclaim,spectator,roomexport,tokens,legacy,idle   run sections selectively
//   FAST=1                                      shorten the 2-minute/5-minute idle checks to 20 s (NOT acceptance-grade)
//   MEDIA=/path                                 directory for videos and screenshots (default ~/chief-evidence/media)
//
// Every page must finish with zero console errors/warnings, zero page errors, zero
// securitypolicyviolation events and zero failed network/WebSocket requests.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { legacySection } from './legacy-section.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const FAST = process.env.FAST === '1';
const MEDIA = process.env.MEDIA ?? join(homedir(), 'chief-evidence', 'media');
const RAW = join(MEDIA, '.raw');
const ONLY = (process.env.ONLY ?? 'solo,hotseat,mobile,room,relay,endless,start,reclaim,spectator,roomexport,tokens,legacy,idle').split(',');
const IDLE_MS = FAST ? 20_000 : 125_000;
const HEARTBEAT_MS = FAST ? 30_000 : 300_000;
mkdirSync(MEDIA, { recursive: true });
rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

const results = [];
let failures = 0;
// Seat tokens must never reach stdout or smoke-results.json, on pass or on fail. Callers pass booleans and counts;
// this is the backstop: any UUID, `mercadia:pid:` payload or `"id":` seat-token object in a detail is masked.
const scrub = (text) =>
  String(text)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted-id>')
    .replace(/\{[^{}]*"id"\s*:[^{}]*\}/g, '<redacted-token>')
    .replace(/mercadia:pid:[A-Z]{4}["']?\s*[:=]\s*\S+/g, 'mercadia:pid:<redacted>');
const ok = (cond, name, detail = '') => {
  const d = scrub(detail);
  results.push({ name, pass: !!cond, detail: d });
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !d ? '' : '  — ' + d}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const pages = []; // for the final hygiene check
const droppedBlank = []; // recorded clips that never showed a rendered frame; removed from the media directory at the end

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

/**
 * Decode a recorded clip with ffmpeg `signalstats` and report whether it ever shows real rendered UI: a blank clip
 * (a page closed before its first paint is all-white, luma 252-255) has no frame whose luma range (YMAX-YMIN)
 * reaches BLANK_RANGE, while any frame holding text, ink or House colour spans well over 100.
 * Returns { frames, maxRange, minYmin, maxYmax, blank } or null when ffmpeg cannot decode it.
 */
const BLANK_RANGE = 24;
function videoStats(file) {
  let out;
  try {
    out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'signalstats,metadata=print:file=-', '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
  let frames = 0;
  let maxRange = 0;
  let minYmin = 255;
  let maxYmax = 0;
  let cur = {};
  const flush = () => {
    if (cur.YMIN === undefined || cur.YMAX === undefined) return;
    frames++;
    maxRange = Math.max(maxRange, cur.YMAX - cur.YMIN);
    minYmin = Math.min(minYmin, cur.YMIN);
    maxYmax = Math.max(maxYmax, cur.YMAX);
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('frame:')) {
      flush();
      cur = {};
      continue;
    }
    const m = /^lavfi\.signalstats\.(YMIN|YMAX)=(\d+(?:\.\d+)?)/.exec(line);
    if (m) cur[m[1]] = Number(m[2]);
  }
  flush();
  return { frames, maxRange, minYmin, maxYmax, blank: frames === 0 || maxRange < BLANK_RANGE };
}

async function finishCtx(c, videoName, pagesToName = []) {
  // Read the live pages' CSP violations BEFORE the context closes (a closed page cannot be asked).
  for (const rec of pages) {
    if (!c.context.pages().includes(rec.page)) continue;
    try {
      rec.csp = await rec.page.evaluate(() => window.__csp ?? []);
    } catch (e) {
      rec.csp = null;
      rec.issues.push(`csp-capture-failed: ${e.message}`);
    }
  }
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

/**
 * Click a real UI control that triggers a browser download, capture Playwright's real download event,
 * save the file and parse it. No window.__mercadia shortcut: this is exactly what a player gets.
 */
async function downloadVia(page, locator, file) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), locator.click()]);
  await dl.saveAs(file);
  return { exp: JSON.parse(readFileSync(file, 'utf8')), name: dl.suggestedFilename() };
}

/** Make sure the Turn Delta drawer is open, fully faded in, on screen and on top; returns its measured state. */
async function ensureDeltaOpen(page) {
  const pressed = await page.evaluate(() => document.querySelector('#hud [data-act="delta"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#h-drawer')?.classList.contains('open'));
  if (!pressed) await page.locator('#hud [data-act="delta"]').click();
  await page.waitForFunction(
    () => {
      const d = document.querySelector('#h-drawer');
      if (!d || !d.classList.contains('open')) return false;
      if (!/^Turn \d+ → \d+$/.test(document.querySelector('#h-dh')?.textContent.trim() ?? '')) return false;
      const r = d.getBoundingClientRect();
      const last = window.__drawerRect;
      window.__drawerRect = `${r.x},${r.y},${r.width},${r.height}`;
      const inside = r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 120));
      return getComputedStyle(d).opacity === '1' && inside && !!hit && d.contains(hit) && last === window.__drawerRect;
    },
    null,
    { timeout: 8000, polling: 120 },
  );
  await sleep(150);
  return page.evaluate(() => {
    const d = document.querySelector('#h-drawer');
    const r = d.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 120));
    return { opacity: getComputedStyle(d).opacity, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, vw: innerWidth, vh: innerHeight, onTop: d.contains(hit), heading: document.querySelector('#h-dh').textContent.trim() };
  });
}
const deltaOpenOk = (st) => st.opacity === '1' && st.rect.w > 100 && st.rect.h > 100 && st.rect.x >= -1 && st.rect.y >= -1 && st.rect.x + st.rect.w <= st.vw + 1 && st.rect.y + st.rect.h <= st.vh + 1 && st.onTop;

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
  await ensureDeltaOpen(page);
  const { exp } = await downloadVia(page, page.locator('#h-drawer [data-act="export"]'), join(RAW, 'solo-export.json'));
  ok(exp && exp.version === 5 && exp.log.length >= 6, 'replay: the real Export match button downloads a version 5 export with the seed and canonical action log', exp ? `v${exp.version} ${exp.log.length} turns` : 'null');
  const rs = nodeReplay(join(RAW, 'solo-export.json'));
  ok(rs.ok && rs.mismatches.length === 0 && rs.turnsReplayed === exp.log.length, 'replay: the solo UI download replays bit-for-bit in headless Node', JSON.stringify(rs));
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


// Rendered-DOM state of the hotseat table delta (computed style + bounding boxes), read from the live page.
const tableDeltaState = (page) =>
  page.evaluate(() => {
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const visible = (e) => {
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return cs.visibility === 'visible' && cs.display !== 'none' && Number(cs.opacity) > 0 && r.width > 0 && r.height > 0;
    };
    const hud = document.querySelector('#hud');
    const drawer = document.querySelector('#h-drawer');
    const head = drawer.querySelector('#h-dh');
    const end = document.querySelector('#end-turn');
    const hr = head.getBoundingClientRect();
    const m = window.__mercadia;
    return {
      handoffLayer: !!document.querySelector('.handoff-layer'),
      hudVisibility: getComputedStyle(hud).visibility,
      hudInert: hud.inert,
      hudRect: rect(hud),
      drawerOpen: drawer.classList.contains('open') && !drawer.inert,
      drawerVisibility: getComputedStyle(drawer).visibility,
      drawerRect: rect(drawer),
      heading: head.textContent.trim(),
      headingVisible: visible(head),
      headingInViewport: hr.left >= 0 && hr.top >= 0 && hr.right <= innerWidth && hr.bottom <= innerHeight,
      text: drawer.innerText,
      draftLen: m.draft.length,
      cta: end ? { label: end.innerText.replace(/\s*Enter\s*$/, '').trim(), visible: visible(end), enabled: !end.disabled } : null,
      turn: m.turn,
      res: m.view.resolutions,
    };
  });

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
  await sleep(700);
  // PRODUCT.md Hotseat: the Turn Delta is shown to the TABLE before the first seat plans the next turn.
  // Real rendered DOM checks (computed style + bounding boxes), taken BEFORE anybody clicks into Turn 2.
  const vis = await tableDeltaState(page);
  ok(vis.handoffLayer === false, 'hotseat: no handoff screen covers the game when Turn 1→2 resolves', JSON.stringify(vis));
  ok(vis.hudVisibility === 'visible' && !vis.hudInert && vis.hudRect.w > 1000 && vis.hudRect.h > 600, 'hotseat: the HUD is genuinely visible (visibility: visible, full-viewport bounding box)', JSON.stringify({ v: vis.hudVisibility, inert: vis.hudInert, r: vis.hudRect }));
  ok(vis.drawerOpen && vis.drawerVisibility === 'visible' && vis.drawerRect.w > 200 && vis.drawerRect.h > 200, 'hotseat: the Turn Delta drawer is open and visible with a real bounding box', JSON.stringify({ o: vis.drawerOpen, v: vis.drawerVisibility, r: vis.drawerRect }));
  ok(vis.heading === `Turn ${t0} \u2192 ${t0 + 1}` && vis.headingVisible && vis.headingInViewport, 'hotseat: the readable "Turn 1 → 2" heading is on screen before Turn 2 is entered', JSON.stringify({ h: vis.heading, vis: vis.headingVisible, inVp: vis.headingInViewport }));
  ok(/Worth [+\u2212]?\d/.test(vis.text) && /#\d( \u2192 #\d|\s*held)?/.test(vis.text) && /Crown Index/.test(vis.text), 'hotseat: the visible delta shows numbers (Crown Index, rank, component deltas)', vis.text.slice(0, 160).replace(/\s+/g, ' '));
  ok(vis.draftLen === 0 && vis.cta?.label === 'Pass to Ada' && vis.cta.visible && vis.cta.enabled, 'hotseat: a visible "Pass to Ada" CTA exists and no private draft is exposed', JSON.stringify({ d: vis.draftLen, cta: vis.cta }));
  ok(vis.turn === t0 + 1 && vis.res === 1, 'hotseat: Turn 2 is resolved but unplanned — the world has not moved again', JSON.stringify({ turn: vis.turn, res: vis.res }));
  await shot(page, '09-hotseat-turn-delta');
  // The CTA hands over: now the Turn 2 first-seat handoff covers the screen and hides the HUD.
  await page.getByRole('button', { name: /^Pass to Ada/ }).click();
  await sleep(600);
  const covered = await page.evaluate(() => ({ layer: !!document.querySelector('.handoff-layer'), hud: getComputedStyle(document.querySelector('#hud')).visibility, text: document.querySelector('.handoff-layer')?.innerText ?? '', turn: window.__mercadia.turn, draft: window.__mercadia.draft.length }));
  ok(covered.layer && covered.hud === 'hidden' && /Pass to /.test(covered.text) && covered.turn === t0 + 1 && covered.draft === 0, 'hotseat: after the CTA the Turn 2 first-seat handoff covers the board (HUD hidden) and nothing resolved', JSON.stringify(covered));
  await shot(page, '09b-hotseat-turn2-handoff');
  await page.getByRole('button', { name: /^Begin .*turn/ }).click();
  await sleep(500);
  const planning = await page.evaluate(() => ({ seat: window.__mercadia.seat, draft: window.__mercadia.draft.length, layer: !!document.querySelector('.handoff-layer'), hud: getComputedStyle(document.querySelector('#hud')).visibility }));
  ok(planning.seat === 0 && planning.draft === 0 && !planning.layer && planning.hud === 'visible', "hotseat: Ada then plans Turn 2 on an empty draft behind a visible HUD", JSON.stringify(planning));
  await finishCtx(c, 'hotseat-walkthrough');
}


// ═════════════════════════════ ENDLESS + REPLAY + SCORE DELTA ═════════════════════════════
const REPLAY_CLI = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
function nodeReplay(file) {
  try {
    const out = execFileSync(process.execPath, [REPLAY_CLI, join(process.cwd(), 'scripts', 'replay.ts'), file], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (e) {
    const out = String(e.stdout ?? '').trim().split('\n').pop();
    try {
      return JSON.parse(out);
    } catch {
      return { ok: false, error: String(e.stderr ?? e.message).slice(0, 300) };
    }
  }
}

/** One planning turn through the real UI: adopt a Charter on a Council turn, then End Turn. Returns once the world moved. */
async function playTurnUi(page) {
  const before = await M(page);
  if ((await page.locator('.charter').count()) > 0) {
    await page.locator('.charter').first().click();
    await sleep(250);
  }
  await sleep(650); // outside the End Turn gesture guard
  await endBtn(page).click();
  await page.waitForFunction((t) => window.__mercadia.turn !== t || window.__mercadia.phase === 'ended', before.turn, { timeout: 15000 });
  await sleep(120);
}

/** The Turn Delta score block as rendered: text, rows, overflow and visibility. */
const scoreBlockState = (page) =>
  page.evaluate(() => {
    const drawer = document.querySelector('#h-drawer');
    const block = drawer.querySelector('.dscore');
    const rows = [...(block?.querySelectorAll('.srow') ?? [])];
    const body = drawer.querySelector('#h-dbody') ?? drawer;
    const r = (block ?? drawer).getBoundingClientRect();
    const vis = block ? getComputedStyle(block).visibility === 'visible' && r.width > 0 && r.height > 0 : false;
    const clipped = rows.some((e) => e.scrollWidth > e.clientWidth + 1);
    const sc = window.__mercadia.summary?.scores ?? [];
    return {
      heading: drawer.querySelector('#h-dh')?.textContent.trim(),
      has: !!block,
      visible: vis,
      rowCount: rows.length,
      text: block ? block.innerText.replace(/\s+/g, ' ') : '',
      clipped,
      pageOverflowX: document.documentElement.scrollWidth - innerWidth,
      drawerOverflowX: drawer.scrollWidth - drawer.clientWidth,
      bodyOverflowX: body.scrollWidth - body.clientWidth,
      drawerRect: (() => { const q = drawer.getBoundingClientRect(); return { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) }; })(),
      moved: sc.filter((x) => x.rankDelta !== 0).map((x) => ({ p: x.player, from: x.prevRank, to: x.nextRank, d: x.rankDelta })),
      scores: sc,
    };
  });

async function checkScoreDom(page, label, widthName) {
  const st = await scoreBlockState(page);
  const sign = (n) => (n === 0 ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`);
  ok(st.has && st.visible && st.rowCount === st.scores.length && st.rowCount >= 2, `${label}: the Turn Delta shows a visible "Crown Index · rank" block with one row per House (${widthName})`, JSON.stringify({ has: st.has, vis: st.visible, rows: st.rowCount }));
  const moved = st.moved[0];
  ok(!!moved && st.text.includes(`#${moved.from} → #${moved.to}`) && st.text.includes(moved.d > 0 ? `▲${moved.d}` : `▼${-moved.d}`), `${label}: the rendered text shows the rank change (#${moved?.from} → #${moved?.to}) with its ▲/▼ chip (${widthName})`, st.text.slice(0, 200));
  const allDeltas = st.scores.every((x) => st.text.includes(`Worth ${sign(x.worthDelta)}`) && st.text.includes(`Share ${sign(x.shareDelta)}`) && st.text.includes(`Prestige ${sign(x.prestigeDelta)}`) && x.worthDelta + x.shareDelta + x.prestigeDelta === x.crownDelta);
  ok(allDeltas, `${label}: every House row prints Worth, Share and Prestige deltas that sum to its Crown Index change (${widthName})`, st.text.slice(0, 260));
  ok(!st.clipped && st.pageOverflowX <= 1 && st.drawerOverflowX <= 1, `${label}: no clipping or horizontal overflow at ${widthName}`, JSON.stringify({ clipped: st.clipped, page: st.pageOverflowX, drawer: st.drawerOverflowX }));
  return st;
}

async function endlessReplay() {
  const c = await ctx('endless', { video: false });
  const page = await openPage(c, 'solo-to-endless');
  await startSolo(page);
  let rankShot = false;
  let rankSeen = null;
  // Finish a real 32-turn Standard match through the UI (Charters adopted on Council turns).
  for (let i = 0; i < 40 && (await M(page)).phase !== 'ended'; i++) {
    await playTurnUi(page);
    if (!rankShot && (await M(page)).phase !== 'ended') {
      const moved = await page.evaluate(() => (window.__mercadia.summary?.scores ?? []).some((x) => x.rankDelta !== 0));
      if (moved) {
        await sleep(400);
        rankShot = true;
        rankSeen = await checkScoreDom(page, 'score delta (desktop)', '1440×900');
        const open = await ensureDeltaOpen(page);
        ok(deltaOpenOk(open), 'score delta (desktop): the Turn Delta drawer is open, opaque, on screen and on top before the 1440×900 capture', JSON.stringify(open));
        await shot(page, '20-turn-delta-rank-and-components-1440x900');
        await page.locator('#h-drawer').screenshot({ path: join(MEDIA, '21-turn-delta-drawer-crop.png') });
      }
    }
  }
  const fin = await M(page);
  ok(fin.phase === 'ended' && fin.turn === 33, 'endless: a real 32-turn Standard match finished in the browser (Final Edition)', JSON.stringify({ phase: fin.phase, turn: fin.turn }));
  if (!rankShot) ok(false, 'score delta (desktop): a turn with rank movement occurred in the match', 'no rank change in 32 turns');
  await sleep(600);
  await shot(page, '22-final-edition');
  // Plain finished export: the real Export match button on Final Edition downloads it; it replays bit-for-bit.
  const fdl = await downloadVia(page, page.locator('.gazette').getByRole('button', { name: 'Export match' }), join(RAW, 'finished-export.json'));
  const done = fdl.exp;
  const r1 = nodeReplay(join(RAW, 'finished-export.json'));
  ok(done.version === 5 && done.log.length === 32 && !done.endlessAt && /^mercadia-\d+\.json$/.test(fdl.name) && r1.ok && r1.turnsReplayed === 32 && r1.mismatches.length === 0, 'replay: the Final Edition Export match download (version 5, 32 turns) replays bit-for-bit in headless Node (every turn hash)', JSON.stringify({ v: done.version, name: fdl.name, ...r1 }));
  // Continue in Endless, play two more turns, export through the real UI, replay.
  await page.getByRole('button', { name: 'Continue in Endless' }).click();
  await page.waitForFunction(() => window.__mercadia.phase === 'planning', null, { timeout: 10000 });
  await sleep(500);
  ok((await M(page)).turn === 33, 'endless: Continue in Endless re-opens planning on Turn 33');
  const plateExport = await page.evaluate(() => {
    const b = document.querySelector('#hud .plate [data-act="export"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), label: b.getAttribute('aria-label'), vis: getComputedStyle(b).visibility, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
  });
  ok(plateExport && plateExport.label === 'Export match' && plateExport.vis === 'visible' && plateExport.w > 20 && plateExport.inView, 'endless: after Continue in Endless the planning screen carries a visible Export match button in the match controls (1440×900)', JSON.stringify(plateExport));
  await shot(page, '23-endless-turn33-planning');
  await playTurnUi(page);
  await sleep(500);
  await playTurnUi(page);
  await sleep(800);
  const post = await M(page);
  ok(post.turn === 35 && post.phase === 'planning', 'endless: two Endless turns resolved (Turn 35)', JSON.stringify({ turn: post.turn, phase: post.phase }));
  const dOpen = await ensureDeltaOpen(page);
  ok(deltaOpenOk(dOpen), 'endless: the Endless Turn Delta drawer is open and on screen', JSON.stringify(dOpen));
  const exBtn = await page.evaluate(() => { const b = document.querySelector('#h-drawer [data-act="export"]'); const r = b?.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), right: Math.round(r.right), vw: innerWidth, text: b.textContent.trim(), scrollX: document.documentElement.scrollWidth - innerWidth, drawerScrollX: document.querySelector('#h-drawer').scrollWidth - document.querySelector('#h-drawer').clientWidth } : null; });
  ok(exBtn && exBtn.text === 'Export match' && exBtn.right <= exBtn.vw && exBtn.scrollX <= 1 && exBtn.drawerScrollX <= 1, 'endless: the Turn Delta drawer carries an "Export match" button with no clipping or horizontal overflow (1440×900)', JSON.stringify(exBtn));
  await shot(page, '24-endless-turn35-delta');
  const edl = await downloadVia(page, page.locator('#h-drawer [data-act="export"]'), join(RAW, 'endless-export.json'));
  const exp = edl.exp;
  ok(exp.version === 5 && exp.log.length === 34 && Array.isArray(exp.endlessAt) && exp.endlessAt.length === 1 && exp.endlessAt[0] === 32, 'endless: the Export match download after Continue in Endless is version 5 and records the continuation (endlessAt=[32]) and 34 order batches', JSON.stringify({ v: exp.version, n: exp.log.length, at: exp.endlessAt }));
  const r2 = nodeReplay(join(RAW, 'endless-export.json'));
  ok(r2.ok && r2.turnsReplayed === 34 && r2.mismatches.length === 0 && r2.finalTurn === 35 && r2.phase === 'planning' && r2.endless === true, 'replay: the post-Endless UI export (Turn 35) replays bit-for-bit in headless Node, including the Endless turns', JSON.stringify(r2));
  // The planning-screen button downloads the same canonical export.
  await page.keyboard.press('Escape');
  await sleep(300);
  const pdl = await downloadVia(page, page.locator('#hud .plate [data-act="export"]'), join(RAW, 'endless-export-plate.json'));
  ok(JSON.stringify(pdl.exp) === JSON.stringify(exp), 'endless: the planning-screen Export match button downloads the same canonical export');
  // A legacy version 3 export fails fast with an explicit version error, not 32 silent hash mismatches.
  writeFileSync(join(RAW, 'legacy-v3-export.json'), JSON.stringify({ ...done, version: 3 }));
  const r3 = nodeReplay(join(RAW, 'legacy-v3-export.json'));
  // A legacy version 4 export (Pass 3: seat-keyed start tiles) fails the same way.
  writeFileSync(join(RAW, 'legacy-v4-export.json'), JSON.stringify({ ...done, version: 4 }));
  const r4 = nodeReplay(join(RAW, 'legacy-v4-export.json'));
  ok(r4.ok === false && /Incompatible match export version 4: this build replays version 5 exports only/.test(r4.error ?? '') && !('mismatches' in r4), 'replay: a legacy version 4 export is rejected with an explicit incompatible-version error (no hash mismatch list)', JSON.stringify(r4));
  ok(r3.ok === false && /Incompatible match export version 3/.test(r3.error ?? '') && !('mismatches' in r3), 'replay: a legacy version 3 export is rejected with an explicit incompatible-version error (no hash mismatch list)', JSON.stringify(r3));
  ok(exp.hashes.length === 34, 'replay: the browser recorded a state hash for every turn including the Endless ones', String(exp.hashes.length));
  copyFileSync(join(RAW, 'endless-export.json'), join(MEDIA, '..', 'endless-export.json'));
  await finishCtx(c, 'endless-and-replay');

  // Same Turn Delta rank/component check on a 390×844 phone and a 1024×768 laptop, on a turn with rank movement.
  for (const [name, vp, mobile] of [['mobile', { width: 390, height: 844 }, true], ['laptop', { width: 1024, height: 768 }, false]]) {
    const c2 = await ctx('endless-' + name, { mobile, video: false });
    const p2 = await openPage(c2, name);
    if (!mobile) await p2.setViewportSize(vp);
    await startSolo(p2);
    let found = false;
    for (let i = 0; i < 16 && !found; i++) {
      await playTurnUi(p2);
      found = await p2.evaluate(() => (window.__mercadia.summary?.scores ?? []).some((x) => x.rankDelta !== 0));
    }
    if (!found) ok(false, `score delta (${name}): a turn with rank movement occurred`, 'none in 16 turns');
    else {
      await sleep(600);
      await checkScoreDom(p2, `score delta (${name})`, `${vp.width}×${vp.height}`);
      const open2 = await ensureDeltaOpen(p2);
      ok(deltaOpenOk(open2), `score delta (${name}): the Turn Delta drawer is open, opaque, on screen and on top before the capture`, JSON.stringify(open2));
      await shot(p2, name === 'mobile' ? '25-turn-delta-rank-390x844' : '26-turn-delta-rank-1024x768');
      if (name === 'laptop') {
        // planning view next to the delta at 1024×768: no overlap of the delta drawer with the command rail
        const geo = await p2.evaluate(() => {
          const q = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
          return { drawer: q('#h-drawer'), rail: q('#rail'), vw: innerWidth, vh: innerHeight };
        });
        const overlap = geo.drawer && geo.rail && !(geo.drawer.r <= geo.rail.l || geo.drawer.l >= geo.rail.r || geo.drawer.b <= geo.rail.t || geo.drawer.t >= geo.rail.b);
        ok(!overlap && geo.drawer.r <= geo.vw + 1 && geo.drawer.b <= geo.vh + 1, 'laptop 1024×768: the Turn Delta drawer does not overlap the command rail and stays on screen', JSON.stringify(geo));
        await p2.keyboard.press('Escape');
        await sleep(400);
        await shot(p2, '27-planning-1024x768');
      }
    }
    // Continue in Endless at this viewport: the Export match controls are reachable and fit (no clipping/overflow).
    for (let i = 0; i < 40 && (await M(p2)).phase !== 'ended'; i++) await playTurnUi(p2);
    await sleep(500);
    await p2.getByRole('button', { name: 'Continue in Endless' }).click();
    await p2.waitForFunction(() => window.__mercadia.phase === 'planning', null, { timeout: 10000 });
    await sleep(400);
    await playTurnUi(p2);
    await sleep(500);
    const open3 = await ensureDeltaOpen(p2);
    const fit = await p2.evaluate(() => {
      const box = (b) => { if (!b) return null; const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), vis: getComputedStyle(b).visibility, label: b.getAttribute('aria-label') }; };
      const d = document.querySelector('#h-drawer');
      return { plate: box(document.querySelector('#hud .plate [data-act="export"]')), drawer: box(d.querySelector('[data-act="export"]')), vw: innerWidth, vh: innerHeight, scrollX: document.documentElement.scrollWidth - innerWidth, drawerScrollX: d.scrollWidth - d.clientWidth, plateOverlap: (() => { const q = ['.plate-main', '.plate-era', '.plate-btns'].map((x) => document.querySelector('#hud ' + x).getBoundingClientRect()); const hit = (a, b) => !(a.right <= b.left + 0.5 || a.left >= b.right - 0.5 || a.bottom <= b.top + 0.5 || a.top >= b.bottom - 0.5); return hit(q[0], q[1]) || hit(q[0], q[2]) || hit(q[1], q[2]); })(), plateScrollX: (() => { const p = document.querySelector('#hud .plate'); return p.scrollWidth - p.clientWidth; })() };
    });
    const inV = (q) => q && q.l >= 0 && q.r <= fit.vw && q.t >= 0 && q.b <= fit.vh && q.vis === 'visible';
    const minSide = mobile ? 44 : 28;
    const plateOk = mobile ? fit.plate && fit.plate.w === 0 : inV(fit.plate) && fit.plate.w >= minSide && fit.plate.h >= minSide; // on a phone the plate button is folded away so the Turn number is never crowded; the sheet carries it
    ok(deltaOpenOk(open3) && plateOk && inV(fit.drawer) && fit.drawer.h >= minSide && fit.scrollX <= 1 && fit.drawerScrollX <= 1 && fit.plateScrollX <= 1 && !fit.plateOverlap, `endless export (${name}): the Export match control(s) are reachable (planning bar on desktop/laptop, Turn Delta sheet everywhere), on screen, tappable and cause no clipping or horizontal overflow at ${vp.width}×${vp.height}`, JSON.stringify(fit));
    await shot(p2, name === 'mobile' ? '30-endless-export-390x844' : '31-endless-export-1024x768');
    const dl2 = await downloadVia(p2, p2.locator('#h-drawer [data-act="export"]'), join(RAW, `endless-export-${name}.json`));
    const rr = nodeReplay(join(RAW, `endless-export-${name}.json`));
    ok(dl2.exp.version === 5 && dl2.exp.endlessAt?.length === 1 && rr.ok && rr.mismatches.length === 0, `endless export (${name}): the ${vp.width}×${vp.height} UI download is version 5 with endlessAt and replays bit-for-bit`, JSON.stringify({ v: dl2.exp.version, at: dl2.exp.endlessAt, ...rr }));
    await finishCtx(c2, `endless-${name}`);
  }
}

// ═════════════════════════════ ALL FOUR HOUSES START BESIDE GRAND STATION ═════════════════════════════
async function startBeside() {
  const c = await ctx('start', { video: false });
  const page = await openPage(c, 'turn1');
  await startSolo(page);
  const st = await page.evaluate(() => {
    const g = window.__mercadia.view.game;
    const stationDoor = 8 + 12;
    const stationTiles = [8, 9];
    return {
      turn: g.turn,
      players: g.players.length,
      cash: g.players.map((p) => p.cash),
      buildings: g.buildings.length,
      units: g.units.map((u) => ({ owner: u.owner, kind: u.kind, tile: u.tile, x: u.tile % 12, y: Math.floor(u.tile / 12) })),
      stationDoor,
      stationTiles,
    };
  });
  const tiles = st.units.map((u) => u.tile);
  const cheb = (u) => Math.min(...st.stationTiles.map((s) => Math.max(Math.abs(s - u.x), Math.abs(0 - u.y))));
  const perHouse = [0, 1, 2, 3].map((o) => st.units.filter((u) => u.owner === o).map((u) => u.kind).sort().join('+'));
  ok(st.turn === 1 && st.players === 4 && st.cash.every((x) => x === 900) && st.buildings === 0, 'start: four Houses, §900 each, no property, on Turn 1', JSON.stringify({ cash: st.cash, b: st.buildings }));
  ok(perHouse.every((x) => x === 'factor+watch') && new Set(tiles).size === 8, 'start: each House has one Factor and one Watch Company, on 8 distinct tiles', JSON.stringify(perHouse));
  ok(st.units.every((u) => u.y <= 3 && cheb(u) <= 5), 'start: all four Houses begin beside Grand Station (north frontage, y <= 3, none on the Harbor Pier side)', JSON.stringify(st.units.map((u) => `${u.owner}:${u.kind[0]}(${u.x},${u.y})`)));
  await sleep(500);
  await shot(page, '28-turn1-all-four-houses-beside-station');
  await finishCtx(c, 'start');
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

// seat → a lot within the seat's start reach (seat 0 Factor at (7,1), seat 1 Factor at (10,1))
const A0TileFor = (seat, alt = 0) => (seat === 0 ? [31, 30][alt] : [34, 33][alt]); // (7,2)/(6,2) and (10,2)/(9,2)
const B0TileFor = (seat) => (seat === 0 ? 32 : 35);


// ═════════════════════════════ SEAT RECLAIM AFTER > 13 HOURS ═════════════════════════════
const HOUR = 3600 * 1000;
async function reclaimAfterHours() {
  const { cA, cB, A, B, code } = await makeRoom('R1', 'R2', { videos: false });
  const a0 = await M(A);
  await queueRoastery(A, A0TileFor(a0.seat));
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true);
  await sleep(500);
  const before = await M(A);
  ok(before.ready === true && before.draft === 1 && before.seat >= 0, 'reclaim: before closing, A holds a seat with a one-order draft and Ready set', JSON.stringify({ seat: before.seat, draft: before.draft, ready: before.ready }));
  const key = `mercadia:pid:${code}`;
  // Age the saved token by 25 hours in localStorage, then close the tab (the context's localStorage survives, sessionStorage does not).
  const aged = await A.evaluate(([k, off]) => {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const v = JSON.parse(raw);
    v.at -= off;
    v.beat -= off;
    localStorage.setItem(k, JSON.stringify(v));
    return { id: !!v.id };
  }, [key, 25 * HOUR]);
  pages.find((r) => r.page === A).csp = await A.evaluate(() => window.__csp ?? []); // read before the tab goes away
  await A.close();
  ok(!!aged, 'reclaim: the closed tab left a seat token in localStorage, aged here by 25 hours', JSON.stringify(aged && { ageH: 25 }));
  // Reopen the room URL in a brand-new tab whose clock is also 26 hours ahead (Date.now shifted).
  const R = await openPage(cA, 'reopen');
  await R.addInitScript((off) => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + off;
  }, 26 * HOUR);
  await R.goto(`${BASE}/?dev=1&room=${code}`);
  await R.waitForFunction(() => window.__mercadia?.phase === 'planning' && window.__mercadia.view.status.text !== 'Reconnecting…', null, { timeout: 20000 });
  await sleep(700);
  const clock = await R.evaluate(() => Date.now() - performance.timeOrigin - performance.now());
  const after = await M(R);
  ok(clock > 25 * HOUR, 'reclaim: the reopened tab really runs 26 hours ahead (Date.now shifted)', String(Math.round(clock / HOUR)));
  ok(after.seat === before.seat && after.seat !== -1, 'reclaim: after > 13 h the reopened tab reclaims the exact same seat (never spectator -1)', JSON.stringify({ before: before.seat, after: after.seat }));
  ok(after.ready === true && after.draft === before.draft && after.turn === before.turn && after.hash === before.hash, 'reclaim: the reopened tab shows the same draft, Ready state, turn and state hash', JSON.stringify({ before, after: { draft: after.draft, ready: after.ready, turn: after.turn, hash: after.hash } }));
  await shot(R, '29-seat-reclaimed-after-26h');
  // The server-side active room is still there too: B readying resolves the turn for the reclaimed seat.
  await queueRoastery(B, B0TileFor((await M(B)).seat));
  await endBtn(B).click();
  await Promise.all([R, B].map((p) => p.waitForFunction(() => window.__mercadia.turn === 2, null, { timeout: 15000 })));
  ok((await M(R)).hash === (await M(B)).hash, 'reclaim: the room still resolves normally once the other seat readies (both show Turn 2, same hash)');
  await finishCtx(cA, 'reclaim-A');
  await finishCtx(cB, 'reclaim-B');
}


// ═════════════════════════════ PASS 4: SPECTATOR TAB, ROOM EXPORT, 404 + LEAVE TOKENS ═════════════════════════════
const tokenOf = (page, code) =>
  page.evaluate((k) => ({ local: JSON.parse(localStorage.getItem(k) ?? 'null'), session: sessionStorage.getItem(k), now: Date.now() }), `mercadia:pid:${code}`);

/** One two-seat planning turn through the real UI (Charter on Council turns), both seats readied. */
async function playRoomTurn(pagesIn) {
  const before = (await M(pagesIn[0])).turn;
  for (const p of pagesIn) {
    if ((await p.locator('.charter').count()) > 0) {
      await p.locator('.charter').first().click();
      await sleep(250);
    }
  }
  await sleep(650);
  for (const p of pagesIn) {
    await endBtn(p).click();
    await p.waitForFunction(() => window.__mercadia.view.ready === true || window.__mercadia.phase !== 'planning' || window.__mercadia.view.resolutions > 0, null, { timeout: 15000 }).catch(() => {});
    await sleep(150);
  }
  await Promise.all(pagesIn.map((p) => p.waitForFunction((t) => window.__mercadia.turn !== t || window.__mercadia.phase === 'ended', before, { timeout: 20000 })));
  await sleep(150);
}

async function exportFitState(page) {
  return page.evaluate(() => {
    const box = (b) => { if (!b) return null; const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), vis: getComputedStyle(b).visibility, label: b.getAttribute('aria-label') }; };
    const d = document.querySelector('#h-drawer');
    const plate = document.querySelector('#hud .plate');
    return { plate: box(document.querySelector('#hud .plate [data-act="export"]')), drawer: box(d.querySelector('[data-act="export"]')), vw: innerWidth, vh: innerHeight, scrollX: document.documentElement.scrollWidth - innerWidth, drawerScrollX: d.scrollWidth - d.clientWidth, plateScrollX: plate.scrollWidth - plate.clientWidth };
  });
}
const fitOk = (fit, mobile) => {
  const inV = (q) => q && q.l >= 0 && q.r <= fit.vw && q.t >= 0 && q.b <= fit.vh && q.vis === 'visible';
  const minSide = mobile ? 44 : 28;
  const plateOk = mobile ? fit.plate && fit.plate.w === 0 : inV(fit.plate) && fit.plate.w >= minSide && fit.plate.h >= minSide;
  return plateOk && inV(fit.drawer) && fit.drawer.h >= minSide && fit.scrollX <= 1 && fit.drawerScrollX <= 1 && fit.plateScrollX <= 1;
};

/** Item 1: a second tab of the SAME browser profile joins as a spectator and must never take over the persisted seat token. */
async function spectatorTab() {
  const { cA, cB, A, B, code } = await makeRoom('S1', 'S2', { videos: true });
  const a0 = await M(A);
  await queueRoastery(A, A0TileFor(a0.seat));
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true);
  await sleep(500);
  const before = await M(A);
  const tokA = await tokenOf(A, code);
  ok(before.seat >= 0 && before.ready === true && before.draft === 1 && !!tokA.local?.id, 'spectator tab: the seated tab holds seat ' + before.seat + ' with a one-order draft, Ready set and a persisted seat token', JSON.stringify({ seat: before.seat, draft: before.draft, ready: before.ready }));
  // Second tab, same browser context (shared localStorage), opens the room URL while the seated tab is live.
  const T = await openPage(cA, 'spectator-tab');
  await T.goto(`${BASE}/?dev=1&room=${code}`);
  await T.waitForFunction(() => window.__mercadia?.phase === 'planning' && window.__mercadia.view.status.text !== 'Reconnecting…', null, { timeout: 20000 });
  await sleep(600);
  const spec = await M(T);
  ok(spec.seat === -1, 'spectator tab: the second same-profile tab joins as a spectator (seat −1)', JSON.stringify({ seat: spec.seat, status: spec.status }));
  await shot(T, '32-spectator-tab-open');
  // Stay open across several heartbeats (2 s each, stale after 6 s).
  await sleep(9000);
  const tokT = await tokenOf(T, code);
  const tokA2 = await tokenOf(A, code);
  ok(tokT.local?.id === tokA.local.id && tokT.session === null, 'spectator tab: after > 4 heartbeats the persisted seat token is still the seated tab\'s (spectator wrote nothing to localStorage or its own sessionStorage)', JSON.stringify({ same: tokT.local?.id === tokA.local.id, spectatorHasSessionToken: tokT.session !== null }));
  ok(tokA2.local.tab === tokA.local.tab && tokA2.now - tokA2.local.beat < 4500, 'spectator tab: the seated tab alone keeps the heartbeat fresh', JSON.stringify({ sinceBeatMs: tokA2.now - tokA2.local.beat }));
  await shot(A, '33-spectator-seated-tab-still-ready');
  // Close the seated tab, then the spectator tab.
  pages.find((r) => r.page === A).csp = await A.evaluate(() => window.__csp ?? []);
  pages.find((r) => r.page === T).csp = await T.evaluate(() => window.__csp ?? []);
  await A.close();
  await sleep(1500);
  await T.close();
  // Reopen the room URL with a clock 26 hours ahead (a returning browser, hours later).
  const R = await openPage(cA, 'reopen-26h');
  await R.addInitScript((off) => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + off;
  }, 26 * HOUR);
  await R.goto(`${BASE}/?dev=1&room=${code}`);
  await R.waitForFunction(() => window.__mercadia?.phase === 'planning' && window.__mercadia.view.status.text !== 'Reconnecting…', null, { timeout: 20000 });
  await sleep(700);
  const clock = await R.evaluate(() => Date.now() - performance.timeOrigin - performance.now());
  const after = await M(R);
  ok(clock > 25 * HOUR, 'spectator tab: the reopened tab really runs 26 hours ahead (Date.now shifted)', String(Math.round(clock / HOUR)));
  ok(after.seat === before.seat && after.seat !== -1, 'spectator tab: +26 h later the returning browser reclaims the exact seat ' + before.seat + ' (not spectator −1)', JSON.stringify({ before: before.seat, after: after.seat }));
  ok(after.ready === true && after.draft === before.draft && after.turn === before.turn && after.hash === before.hash, 'spectator tab: the reclaimed seat shows Ready: true, the same draft, turn and state hash', JSON.stringify({ draft: after.draft, ready: after.ready, turn: after.turn, hash: after.hash === before.hash }));
  await shot(R, '34-spectator-reclaimed-after-26h');
  await queueRoastery(B, B0TileFor((await M(B)).seat));
  await endBtn(B).click();
  await Promise.all([R, B].map((p) => p.waitForFunction(() => window.__mercadia.turn === 2, null, { timeout: 15000 })));
  ok((await M(R)).hash === (await M(B)).hash, 'spectator tab: the other seat readying resolves Turn 1 for the reclaimed seat (same hash on both)');
  await finishCtx(cA, 'spectator-tab-A');
  await finishCtx(cB, 'spectator-tab-B');
}

/** Item 2: the authority-scoped Export match for a networked room (Final Edition and after Continue in Endless). */
async function roomExport() {
  const { cA, cB, A, B, code } = await makeRoom('X1', 'X2', { mode: 'Standard', videos: true });
  // API contract on the live Worker/Durable Object.
  const fresh = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();
  const r409 = await fetch(`${BASE}/api/rooms/${fresh.code}/export`);
  ok(r409.status === 409 && /json/.test(r409.headers.get('content-type') ?? ''), 'room export API: a room whose match has not started answers HTTP 409', String(r409.status));
  const r404 = await fetch(`${BASE}/api/rooms/ZZQX/export`);
  ok(r404.status === 404, 'room export API: a missing room answers HTTP 404', String(r404.status));
  const r405 = await fetch(`${BASE}/api/rooms/${code}/export`, { method: 'POST' });
  ok(r405.status === 405, 'room export API: only GET is allowed (POST answers 405)', String(r405.status));
  // Play the real Standard match to Final Edition through two browsers.
  for (let i = 0; i < 40 && (await M(A)).phase !== 'ended'; i++) await playRoomTurn([A, B]);
  const fin = await M(A);
  ok(fin.phase === 'ended' && fin.turn === 33 && (await M(B)).phase === 'ended', 'room export: a real 32-turn networked Standard match reached Final Edition in two browsers', JSON.stringify({ turn: fin.turn, phase: fin.phase }));
  await sleep(600);
  await shot(A, '35-room-final-edition-export');
  const api = await fetch(`${BASE}/api/rooms/${code}/export`);
  const apiBody = await api.json();
  ok(api.status === 200 && /^application\/json/.test(api.headers.get('content-type') ?? '') && api.headers.get('cache-control') === 'no-store' && /^attachment; filename="mercadia-[A-Z]{4}-\d+\.json"$/.test(api.headers.get('content-disposition') ?? ''), 'room export API: a started match answers 200 application/json, cache-control no-store and a clean attachment filename', `${api.status} ${api.headers.get('content-type')} ${api.headers.get('cache-control')} ${api.headers.get('content-disposition')}`);
  // Credentials that must never appear in a download.
  const ids = [];
  for (const p of [A, B]) {
    const t = await tokenOf(p, code);
    ids.push(t.local?.id, t.session);
  }
  const secrets = ids.filter(Boolean);
  ok(secrets.length >= 2, 'room export: the two seats\' playerIds were read from storage for the leak scan', String(secrets.length));
  const leakFree = (text) => secrets.every((id) => !text.includes(id)) && !/playerId|"epoch|epochs|"ready|"draft|revision|token/i.test(text);
  // Final Edition: the real Export match button, on both a host and a non-host seat.
  const fa = await downloadVia(A, A.locator('.gazette').getByRole('button', { name: 'Export match' }), join(RAW, 'room-final-export-A.json'));
  const fb = await downloadVia(B, B.locator('.gazette').getByRole('button', { name: 'Export match' }), join(RAW, 'room-final-export-B.json'));
  const rf = nodeReplay(join(RAW, 'room-final-export-A.json'));
  ok(fa.exp.version === 5 && fa.exp.log.length === 32 && !fa.exp.endlessAt && JSON.stringify(fa.exp) === JSON.stringify(fb.exp) && JSON.stringify(fa.exp) === JSON.stringify(apiBody) && /^mercadia-\d+\.json$/.test(fa.name), 'room export: the Final Edition Export match button downloads the authority\'s version 5 export (32 turns), identical for both seats and to GET /api/rooms/:code/export', JSON.stringify({ v: fa.exp.version, n: fa.exp.log.length, name: fa.name }));
  ok(rf.ok && rf.turnsReplayed === 32 && rf.mismatches.length === 0 && rf.finalTurn === 33 && rf.phase === 'ended', 'room export: the Final Edition room export replays bit-for-bit with scripts/replay.ts (exit 0)', JSON.stringify(rf));
  ok(leakFree(readFileSync(join(RAW, 'room-final-export-A.json'), 'utf8')) && Object.keys(fa.exp).sort().join() === 'config,hashes,log,version', 'room export: the Final Edition download holds zero playerIds, drafts, readiness epochs or credentials (only version, config, log, hashes)');
  ok(fa.exp.hashes[31] === fin.hash, 'room export: the last exported hash equals the hash both browsers show on Final Edition', fin.hash);
  // Continue in Endless (host), play two Endless turns.
  await A.getByRole('button', { name: 'Continue in Endless' }).click();
  await Promise.all([A, B].map((p) => p.waitForFunction(() => window.__mercadia.phase === 'planning' && window.__mercadia.turn === 33, null, { timeout: 15000 })));
  await sleep(600);
  await playRoomTurn([A, B]);
  await playRoomTurn([A, B]);
  await sleep(600);
  const post = await M(A);
  ok(post.turn === 35 && post.phase === 'planning' && (await M(B)).turn === 35, 'room export: Continue in Endless re-opened planning and two Endless turns resolved in both browsers (Turn 35)', JSON.stringify({ turn: post.turn }));
  // A private, unapplied Turn 35 draft on A and B marked Ready: neither may leak into the export.
  await queueRoastery(A, A0TileFor((await M(A)).seat));
  await endBtn(B).click();
  await B.waitForFunction(() => window.__mercadia.view.ready === true);
  await A.keyboard.press('Escape').catch(() => {});
  const open = await ensureDeltaOpen(A);
  ok(deltaOpenOk(open), 'room export: the Endless Turn Delta drawer is open, opaque, on screen and on top (1440×900)', JSON.stringify(open));
  const fit1 = await exportFitState(A);
  ok(fitOk(fit1, false), 'room export (1440×900): Export match is reachable on the planning bar and in the Turn Delta drawer, on screen and tappable, with zero horizontal overflow', JSON.stringify(fit1));
  await shot(A, '36-room-endless-turn-delta-export-1440x900');
  const ed = await downloadVia(A, A.locator('#h-drawer [data-act="export"]'), join(RAW, 'room-endless-export.json'));
  const re = nodeReplay(join(RAW, 'room-endless-export.json'));
  const eraw = readFileSync(join(RAW, 'room-endless-export.json'), 'utf8');
  ok(ed.exp.version === 5 && ed.exp.log.length === 34 && JSON.stringify(ed.exp.endlessAt) === '[32]' && ed.exp.hashes.length === 34, 'room export: the post-Endless Export match (Turn Delta drawer) is version 5 with endlessAt=[32] and 34 resolved batches', JSON.stringify({ v: ed.exp.version, n: ed.exp.log.length, at: ed.exp.endlessAt }));
  ok(re.ok && re.turnsReplayed === 34 && re.mismatches.length === 0 && re.finalTurn === 35 && re.phase === 'planning' && re.endless === true, 'room export: the post-Endless room export replays bit-for-bit with scripts/replay.ts (exit 0), Endless turns included', JSON.stringify(re));
  ok(leakFree(eraw) && !eraw.includes('"build"'), 'room export: the post-Endless download holds zero playerIds, readiness epochs or credentials and leaves out A\'s unapplied Turn 35 draft (a queued Roastery) and B\'s Ready flag', `bytes=${eraw.length} hasBuild=${eraw.includes('"build"')}`);
  const pd = await downloadVia(A, A.locator('#hud .plate [data-act="export"]'), join(RAW, 'room-endless-export-plate.json'));
  ok(JSON.stringify(pd.exp) === JSON.stringify(ed.exp), 'room export: the planning-bar Export match button downloads the same authority export');
  const bd = await downloadVia(B, (await ensureDeltaOpen(B), B.locator('#h-drawer [data-act="export"]')), join(RAW, 'room-endless-export-B.json'));
  ok(JSON.stringify(bd.exp) === JSON.stringify(ed.exp), 'room export: the other seat (B) downloads the identical export');
  for (const v of [3, 4]) {
    writeFileSync(join(RAW, `legacy-v${v}-room-export.json`), JSON.stringify({ ...ed.exp, version: v }));
    const rl = nodeReplay(join(RAW, `legacy-v${v}-room-export.json`));
    ok(rl.ok === false && new RegExp(`Incompatible match export version ${v}: this build replays version 5 exports only`).test(rl.error ?? '') && !('mismatches' in rl), `room export: a legacy version ${v} room export is rejected with an explicit incompatible-ruleset version error`, JSON.stringify(rl));
  }
  copyFileSync(join(RAW, 'room-endless-export.json'), join(MEDIA, '..', 'room-endless-export.json'));
  // 1024×768 laptop
  await A.setViewportSize({ width: 1024, height: 768 });
  await sleep(600);
  await ensureDeltaOpen(A);
  const fit2 = await exportFitState(A);
  ok(fitOk(fit2, false), 'room export (1024×768): Export match is reachable (planning bar + Turn Delta drawer), on screen, tappable, zero horizontal overflow', JSON.stringify(fit2));
  await shot(A, '37-room-endless-export-1024x768');
  const l = await downloadVia(A, A.locator('#h-drawer [data-act="export"]'), join(RAW, 'room-endless-export-1024.json'));
  ok(JSON.stringify(l.exp) === JSON.stringify(ed.exp) && nodeReplay(join(RAW, 'room-endless-export-1024.json')).ok, 'room export (1024×768): the UI download is the same authority export and replays bit-for-bit');
  await A.setViewportSize({ width: 1440, height: 900 });
  // 390×844 phone (a spectator tab in a phone context: the export is public, so a spectator may download it too)
  const cM = await ctx('room-X3', { mobile: true, video: false });
  const M3 = await openPage(cM, 'phone');
  await M3.goto(`${BASE}/?dev=1&room=${code}`);
  await M3.waitForFunction(() => window.__mercadia?.phase === 'planning' && window.__mercadia.view.status.text !== 'Reconnecting…', null, { timeout: 20000 });
  await sleep(800);
  ok((await M(M3)).seat === -1, 'room export (390×844): the phone joins as a spectator of the Endless room');
  const open3 = await ensureDeltaOpen(M3);
  ok(deltaOpenOk(open3), 'room export (390×844): the Turn Delta sheet is open and on screen', JSON.stringify(open3));
  const fit3 = await exportFitState(M3);
  ok(fitOk(fit3, true), 'room export (390×844): Export match is reachable in the Turn Delta sheet, ≥ 44 px tall, on screen, zero horizontal overflow', JSON.stringify(fit3));
  await shot(M3, '38-room-endless-export-390x844');
  const md = await downloadVia(M3, M3.locator('#h-drawer [data-act="export"]'), join(RAW, 'room-endless-export-390.json'));
  const mr = nodeReplay(join(RAW, 'room-endless-export-390.json'));
  ok(JSON.stringify(md.exp) === JSON.stringify(ed.exp) && mr.ok && mr.turnsReplayed === 34, 'room export (390×844): the phone download is the same version 5 authority export and replays bit-for-bit', JSON.stringify(mr));
  await finishCtx(cM, 'room-endless-export-phone');
  await finishCtx(cA, 'room-endless-export-A');
  await finishCtx(cB, 'room-endless-export-B');
}

/** Item 3: a confirmed 404 forgets only that room's token; explicit Leave keeps the token so the seat can be reclaimed. */
async function tokens404AndLeave() {
  const { cA, cB, A, B, code } = await makeRoom('L1', 'L2', { videos: true });
  const a0 = await M(A);
  await queueRoastery(A, A0TileFor(a0.seat));
  await endBtn(A).click();
  await A.waitForFunction(() => window.__mercadia.view.ready === true);
  await sleep(400);
  const key = `mercadia:pid:${code}`;
  const t0 = await tokenOf(A, code);
  ok(!!t0.local?.id && t0.session === t0.local.id, 'leave: the seated tab holds the seat token in localStorage and sessionStorage', JSON.stringify({ has: !!t0.local?.id }));
  // A confirmed 404 on a room that no longer exists (never created / purged): clears only that room's token.
  const dead = 'ZZQW';
  const P = await openPage(cA, 'dead-room');
  await P.goto(`${BASE}/?dev=1`);
  await P.evaluate(([d, k]) => {
    const rec = JSON.stringify({ id: 'stale-id', at: 1, beat: 0, tab: 'old' });
    localStorage.setItem(`mercadia:pid:${d}`, rec);
    sessionStorage.setItem(`mercadia:pid:${d}`, 'stale-id');
    localStorage.setItem(`mercadia:draft:${d}`, '{}');
  }, [dead, key]);
  const seeded = await P.evaluate(([d]) => !!localStorage.getItem(`mercadia:pid:${d}`) && !!sessionStorage.getItem(`mercadia:pid:${d}`), [dead]);
  const res404 = await fetch(`${BASE}/api/rooms/${dead}`);
  await P.goto(`${BASE}/?dev=1&room=${dead}`);
  await P.waitForFunction(() => /No such room/.test(document.body.innerText) && window.__mercadia?.view.status.text === 'Room not found', null, { timeout: 20000 });
  await sleep(500);
  const after404 = await P.evaluate(([d, k]) => ({ deadLocal: localStorage.getItem(`mercadia:pid:${d}`), deadSession: sessionStorage.getItem(`mercadia:pid:${d}`), otherLocal: localStorage.getItem(k) }), [dead, key]);
  // Only booleans leave this block: the raw token JSON of the dead room and of the live room is never reported.
  const deadRoomCleared = after404.deadLocal === null && after404.deadSession === null;
  let otherRoomPreserved = false;
  try {
    otherRoomPreserved = !!after404.otherLocal && JSON.parse(after404.otherLocal).id === t0.local.id;
  } catch {
    otherRoomPreserved = false;
  }
  await shot(P, '39-room-not-found-clears-only-that-token');
  ok(seeded && res404.status === 404 && deadRoomCleared, 'room 404: a confirmed HTTP 404 removed the missing room\'s token from localStorage and sessionStorage', `seeded=${seeded} http=${res404.status} deadRoomCleared=${deadRoomCleared}`);
  ok(otherRoomPreserved, 'room 404: another room\'s token (the live room) is left untouched in localStorage', `otherRoomPreserved=${otherRoomPreserved}`);
  pages.find((r) => r.page === P).csp = await P.evaluate(() => window.__csp ?? []);
  await P.close();
  // Explicit Leave: confirm the dialog; the token stays (heartbeat released only).
  await A.locator('#hud [data-act="leave"]').click();
  await A.getByRole('button', { name: 'Leave room' }).click();
  await A.getByRole('button', { name: /Play Solo Now/i }).waitFor({ timeout: 10000 });
  await sleep(500);
  const afterLeave = await tokenOf(A, code);
  ok(!!afterLeave.local && afterLeave.local.id === t0.local.id && afterLeave.local.beat === 0, 'leave: explicit Leave keeps the seat token and only releases its heartbeat', JSON.stringify({ kept: !!afterLeave.local, beat: afterLeave.local?.beat }));
  await shot(A, '40-after-explicit-leave-token-kept');
  // Return to that room in a brand-new tab: the reserved seat is reclaimed with its Ready flag and draft.
  const R = await openPage(cA, 'reclaim-after-leave');
  await R.goto(`${BASE}/?dev=1&room=${code}`);
  await R.waitForFunction(() => window.__mercadia?.phase === 'planning' && window.__mercadia.view.status.text !== 'Reconnecting…', null, { timeout: 20000 });
  await sleep(700);
  const back = await M(R);
  ok(back.seat === a0.seat && back.ready === true && back.draft === 1, 'leave: returning to the room link reclaims the reserved seat ' + a0.seat + ' (Ready, one-order draft), never a spectator', JSON.stringify({ seat: back.seat, ready: back.ready, draft: back.draft }));
  await shot(R, '41-seat-reclaimed-after-leave');
  // This tab only lives for about a second: its recording is a clip of white, so it is closed (and its CSP read) first.
  // The real walkthrough is leave-and-reclaim-A-1 / -B; this tab's proof is still 41.
  pages.find((r) => r.page === R).csp = await R.evaluate(() => window.__csp ?? []);
  await R.close();
  await finishCtx(cA, 'leave-and-reclaim-A', ['leave-and-reclaim-A-1']);
  await finishCtx(cB, 'leave-and-reclaim-B');
}

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
  const { cA, cB, A, B, rel } = await makeRoom('RA', 'RB', { relayA: true, relayB: true, mode: 'Standard', videos: false });
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
  // A goes offline for real (no quick reconnect can race the resolution): cut the socket AND block new connections.
  await cA.context.setOffline(true);
  ra.cut();
  await A.waitForFunction(() => window.__mercadia.view.status.text === 'Reconnecting…', null, { timeout: 15000 });
  // queue one more order while "Reconnecting…" (unsent local revision r+1)
  await A.getByRole('button', { name: /Roastery/ }).first().click().catch(() => {});
  await tileClick(A, 44).catch(() => {});
  await endBtn(B).click();
  await B.waitForFunction((t) => window.__mercadia.turn === t + 1, t16, { timeout: 15000 });
  await cA.context.setOffline(false);
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
  // B's own acks are fine; nothing carrying A's draft/epoch may reach B. (1) every ack B received answers a message B itself sent;
  // (2) outside its own `own` block no message to B has a draft/orders/revision/epoch field.
  const bSent = rb.log.filter((x) => x.dir === 'c2s' && ['ready', 'cancelReady', 'draft'].includes(x.msg.t)).map((x) => `${x.msg.t === 'draft' ? 'draftAck' : 'readyAck'}:${x.msg.turn}`);
  const bAcks = rb.log.filter((x) => x.dir === 's2c' && (x.msg.t === 'readyAck' || x.msg.t === 'draftAck'));
  const orphanAcks = bAcks.filter((x) => !bSent.includes(`${x.msg.t}:${x.msg.turn}`));
  const PRIVATE = /"(draft|orders|revision|epoch|ackedRevision)":/;
  const privateHits = rb.log
    .filter((x) => x.dir === 's2c' && x.msg.t !== 'readyAck' && x.msg.t !== 'draftAck')
    .filter((x) => {
      const { own, ...rest } = x.msg;
      return PRIVATE.test(JSON.stringify(rest));
    })
    .map((x) => x.msg.t);
  const bStateOwn = rb.log.filter((x) => x.dir === 's2c' && x.msg.t === 'state').every((x) => x.msg.own === null || x.msg.player === seatB);
  const leaked = orphanAcks.length > 0 || privateHits.length > 0;
  if (leaked) console.log('B privacy offenders:', JSON.stringify({ orphan: orphanAcks.map((x) => [x.msg.t, x.msg.turn]), privateHits }));
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

const sections = { solo, hotseat, mobile, room, relay: relayChecks, endless: endlessReplay, start: startBeside, reclaim: reclaimAfterHours, spectator: spectatorTab, roomexport: roomExport, tokens: tokens404AndLeave };
const jobs = [];
for (const name of ['solo', 'hotseat', 'mobile', 'room', 'relay', 'endless', 'start', 'reclaim', 'spectator', 'roomexport', 'tokens']) {
  if (ONLY.includes(name)) jobs.push(sections[name]().catch((e) => ok(false, `${name}: section crashed`, e.stack?.split('\n').slice(0, 3).join(' / '))));
}
if (ONLY.includes('idle')) {
  jobs.push(idleSolo().catch((e) => ok(false, 'idle solo crashed', e.message)));
  jobs.push(idleRoom().catch((e) => ok(false, 'idle room crashed', e.message)));
}
await Promise.all(jobs);

// The legacy v2 boundary runs on its own wrangler dev + persisted Durable Objects (scripts/legacy-section.mjs),
// after the other sections, so it never competes with them for the browser or the machine.
if (ONLY.includes('legacy')) {
  await legacySection({ ok, ctx, openPage, finishCtx, shot, M, endBtn, nodeReplay, RAW, pages }).catch((e) => ok(false, 'legacy: section crashed', (e.stack ?? String(e)).split('\n').slice(0, 4).join(' / ')));
}

// Hygiene: zero console errors/warnings, page errors, CSP violations and failed requests anywhere.
// Every page's CSP violations were read from the LIVE page in finishCtx, before its context closed.
for (const rec of pages) {
  ok(Array.isArray(rec.csp) && rec.csp.length === 0, `hygiene ${rec.tag}: zero CSP violations (read from the live page)`, rec.csp === undefined ? 'never captured' : (rec.csp ?? []).join(' | '));
}
// Offline/online and relay-cut sections legitimately fail sockets on purpose; report them separately but strictly for the plain sections.
const strict = pages.filter((p) => /^(solo|hotseat|mobile|idle|endless|start)[-/]/.test(p.tag));
for (const rec of strict) ok(rec.issues.length === 0, `hygiene ${rec.tag}: zero console errors/warnings, page errors and failed requests`, rec.issues.slice(0, 4).join(' | '));
const roomPages = pages.filter((p) => /^room-/.test(p.tag));
for (const rec of roomPages) {
  // The dead-room page loads a room that does not exist on purpose: its HTTP 404s and refused upgrade are the test.
  const expected404 = /\/dead-room$/.test(rec.tag) ? /404|Not Found|Failed to load resource/i : null;
  const bad = rec.issues.filter((i) => !/WebSocket|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|net::ERR_/i.test(i) && !(expected404 && expected404.test(i)));
  ok(bad.length === 0, `hygiene ${rec.tag}: zero console errors/warnings and page errors (deliberate offline/relay socket drops excluded)`, bad.slice(0, 4).join(' | '));
}

// The legacy pages hit a refused upgrade (HTTP 410) on purpose: those load failures are the test, nothing else is excused.
for (const rec of pages.filter((p) => /^legacy-chrome\//.test(p.tag))) {
  const bad = rec.issues.filter((i) => /^pageerror:/.test(i) || !/\b410\b|http 409: \S+\/export|Failed to load resource|WebSocket connection to .* failed|WebSocket|ERR_/i.test(i));
  ok(bad.length === 0, `hygiene ${rec.tag}: zero page errors and unexpected console errors (only the deliberate HTTP 410 refusal excused)`, bad.slice(0, 4).join(' | '));
}

// Media. Runs once, after every section, so the ffmpeg work never competes with the sections driving Chrome.
//  1. the raw JSON exports are copied next to (not into) the media directory and the raw recording directory is removed;
//  2. a page that closes before its first paint records a clip of nothing but white: such a clip is dropped;
//  3. every remaining clip is re-encoded in place (VP9, 10 fps, at most 960 px wide) so the directory stays within the
//     collection limits (25 MiB, 64 flat files, no hidden directories), then decoded again frame by frame: every kept
//     video must show real rendered UI.
const MEDIA_LIMIT_BYTES = 25 * 1024 * 1024;
const MEDIA_LIMIT_FILES = 64;
function shrinkVideo(file) {
  const tmp = `${file}.tmp.webm`;
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', "fps=10,scale='min(960,iw)':-2", '-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-an', tmp]);
    renameSync(tmp, file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}
{
  try {
    for (const f of readdirSync(RAW)) if (f.endsWith('.json')) copyFileSync(join(RAW, f), join(MEDIA, '..', f));
  } catch {
    // ignore
  }
  rmSync(RAW, { recursive: true, force: true });
  const stats = [];
  let unshrunk = 0;
  for (const f of readdirSync(MEDIA).filter((x) => x.endsWith('.webm'))) {
    const file = join(MEDIA, f);
    const before = videoStats(file);
    if (before && before.blank) {
      rmSync(file, { force: true });
      droppedBlank.push({ name: f, frames: before.frames, maxRange: before.maxRange, minYmin: before.minYmin, maxYmax: before.maxYmax });
      continue;
    }
    if (!shrinkVideo(file)) unshrunk++;
    stats.push({ f, st: videoStats(file) });
  }
  const kept = stats.map((x) => x.f);
  const undecodable = stats.filter((x) => !x.st).map((x) => x.f);
  const blank = stats.filter((x) => x.st && x.st.blank).map((x) => x.f);
  ok(undecodable.length === 0 && blank.length === 0 && unshrunk === 0, `media: all ${kept.length} kept .webm clips decode and show real rendered UI frames (luma range >= ${BLANK_RANGE} in at least one frame); none is blank`, `kept=${kept.length} undecodable=${undecodable.join(',')} blank=${blank.join(',')} notReencoded=${unshrunk}`);
  const entries = readdirSync(MEDIA, { withFileTypes: true });
  const bytes = entries.filter((e) => e.isFile()).reduce((n, e) => n + statSync(join(MEDIA, e.name)).size, 0);
  const nonFlat = entries.filter((e) => !e.isFile()).map((e) => e.name);
  ok(entries.length <= MEDIA_LIMIT_FILES && nonFlat.length === 0 && bytes <= MEDIA_LIMIT_BYTES, 'media: the directory is flat, holds at most 64 files, no .raw, and is at most 25 MiB', `files=${entries.length} subdirs=${nonFlat.join(',')} MiB=${(bytes / 1048576).toFixed(2)}`);
  for (const x of stats) if (x.st) console.log(`      video ${x.f}: ${(statSync(join(MEDIA, x.f)).size / 1048576).toFixed(2)} MiB frames=${x.st.frames} lumaMin=${x.st.minYmin} lumaMax=${x.st.maxYmax} maxFrameRange=${x.st.maxRange}`);
  for (const d of droppedBlank) console.log(`      dropped blank clip ${d.name}: frames=${d.frames} lumaMin=${d.minYmin} lumaMax=${d.maxYmax} maxFrameRange=${d.maxRange}`);
}

await browser.close();
writeFileSync(join(MEDIA, '..', 'smoke-results.json'), JSON.stringify({ at: 'run', fast: FAST, base: BASE, results }, null, 2));
console.log(`\n${results.filter((r) => r.pass).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
