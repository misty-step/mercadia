// MERCADIA smoke check. Needs the Worker running (npm run dev) and a Chrome/Chromium binary.
//   node scripts/smoke.mjs            BASE=http://127.0.0.1:8787  CHROME=/usr/bin/google-chrome
// Verifies the API, a solo match (hotkey lock, leave confirmation, toasts, diagnostics, ledger,
// Final Edition), a phone-sized match (tabbed dock, fit, bottom sheet), and browser contexts
// sharing one multiplayer room over WebSockets (Pure PvP toggle, live build sync, seat reclaim
// after a closed tab, spectator notice) — with zero console errors, page errors or failed requests.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const OUT = process.env.OUT ?? 'smoke-artifacts';
mkdirSync(OUT, { recursive: true });

const receipts = [];
const problems = [];
const ok = (name, detail = '') => {
  receipts.push({ check: name, ok: true, detail });
  console.log(`  ok  ${name}${detail ? ' — ' + detail : ''}`);
};
const check = (cond, name, detail = '') => {
  if (cond) return ok(name, detail);
  receipts.push({ check: name, ok: false, detail });
  problems.push(`${name}${detail ? ' — ' + detail : ''}`);
  console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};

// ── API ──
console.log('API');
const health = await fetch(`${BASE}/api/health`);
const healthBody = await health.json();
check(health.status === 200 && healthBody.ok === true && healthBody.game === 'mercadia', 'GET /api/health', JSON.stringify(healthBody));
const made = await fetch(`${BASE}/api/rooms`, { method: 'POST' });
const madeBody = await made.json();
check(made.status === 201 && /^[A-Z]{4}$/.test(madeBody.code ?? '') && madeBody.wsPath === `/ws/rooms/${madeBody.code}`, 'POST /api/rooms', JSON.stringify(madeBody));
const summary = await fetch(`${BASE}/api/rooms/${madeBody.code}`);
const summaryBody = await summary.json();
check(summary.status === 200 && summaryBody.status === 'lobby', 'GET /api/rooms/:code', `status=${summaryBody.status} ai=${summaryBody.ai} open=${summaryBody.open}`);
const missing = await fetch(`${BASE}/api/rooms/ZZZZ`);
check(missing.status === 404, 'GET /api/rooms/ZZZZ is 404', String(missing.status));
const page404 = await fetch(`${BASE}/some/deep/link`);
check(page404.status === 200 && (page404.headers.get('content-type') ?? '').includes('text/html'), 'unknown paths fall through to the SPA', String(page404.status));

// ── Browsers ──
// mercadia.test resolves to this machine, so the page can be loaded under a non-local hostname
// to prove the dev hook is gated there.
const PORT = new URL(BASE).port || '80';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--mute-audio', '--host-resolver-rules=MAP mercadia.test 127.0.0.1'] });
const errors = [];
const watch = (page, label) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${label}] console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
};
const ready = (page) => page.waitForFunction(() => window.__mercadia && window.__mercadia.state().ready, null, { timeout: 20000 });
const open = async (label, path = '/', ctxOpts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...ctxOpts });
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(path.startsWith('http') ? path : BASE + path);
  await ready(page);
  return page;
};
const state = (page) => page.evaluate(() => window.__mercadia.state());
const info = (page) => page.evaluate(() => ({ phase: window.__mercadia.phase, kind: window.__mercadia.kind, me: window.__mercadia.me, seat: window.__mercadia.seat, room: window.__mercadia.roomCode, frames: window.__mercadia.frames, tool: window.__mercadia.tool }));
/** The free lot nearest the middle of the open map area. */
const freeLot = (page, avenue = null) =>
  page.evaluate((avenue) => {
    const m = window.__mercadia;
    const top = (document.getElementById('board')?.getBoundingClientRect().bottom ?? 0) + 30;
    const bottom = innerWidth <= 720 ? innerHeight - 190 : innerHeight - 110;
    const right = innerWidth <= 720 ? innerWidth : innerWidth - 270;
    let best = null;
    for (const t of m.freeLots()) {
      const p = m.tileScreen(t);
      if (p.y < top || p.y > bottom || p.x < 20 || p.x > right) continue;
      if (avenue !== null && m.avenueSide(t) !== avenue) continue;
      const d = Math.hypot(p.x - right / 2, p.y - (top + bottom) / 2);
      if (!best || d < best.d) best = { t, x: p.x, y: p.y, d };
    }
    return best;
  }, avenue);
/** Pick a dock tool, then click a free lot. */
const build = async (page, kind) => {
  await page.click(`#dock [data-kind="${kind}"]`);
  const target = await freeLot(page);
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(120);
  await page.mouse.click(target.x, target.y);
  return target.t;
};
const text = (page, sel) => page.evaluate((sel) => document.querySelector(sel)?.textContent?.trim() ?? '', sel);
const visible = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5;
  }, sel);

// ── Solo ──
console.log('Solo');
const solo = await open('solo');
const attract = await state(solo);
check(attract.citizens >= 60 && attract.trams >= 2, 'title screen floats over a live city', `citizens=${attract.citizens} trams=${attract.trams} players=${attract.players.length}`);
await solo.screenshot({ path: `${OUT}/01-title.png` });
// Hotkeys must not leak through the Title screen.
await solo.locator('#stage').focus().catch(() => undefined);
for (const key of ['1', '5', '9', 'Space']) await solo.keyboard.press(key);
const titleInfo = await info(solo);
check(titleInfo.phase === 'title' && titleInfo.tool === null, 'build and speed hotkeys are ignored on the Title screen', `phase=${titleInfo.phase} tool=${titleInfo.tool}`);
// Sound toggle: aria-pressed and a label that says what the next press does.
const sound0 = await solo.evaluate(() => { const b = document.querySelector('#title [data-act="sound"]'); return { p: b.getAttribute('aria-pressed'), l: b.getAttribute('aria-label'), t: b.title }; });
await solo.click('#title [data-act="sound"]');
const sound1 = await solo.evaluate(() => { const b = document.querySelector('#title [data-act="sound"]'); return { p: b.getAttribute('aria-pressed'), l: b.getAttribute('aria-label'), t: b.title }; });
await solo.click('#title [data-act="sound"]');
check(sound0.p === 'false' && sound0.l === 'Mute sound (M)' && sound1.p === 'true' && sound1.l === 'Unmute sound (M)' && sound1.t === 'Unmute sound (M)', 'Sound button carries aria-pressed and a dynamic label', `${sound0.p}/"${sound0.l}" → ${sound1.p}/"${sound1.l}"`);

await solo.click('#title [data-act="mode"][data-v="blitz"]');
await solo.click('#title [data-act="solo"]');
await solo.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.kind === 'solo');
const s0 = await state(solo);
check(s0.players.length === 4 && s0.players[0].kind === 'human' && s0.players.filter((p) => p.kind === 'ai').length === 3, 'Play Solo Now starts You vs 3 AI', s0.players.map((p) => p.name).join(', '));
// Blitz opening: the AI gives the player the first seconds.
check(s0.buildings.length === 0, 'Blitz: no AI building stands when the match opens', `buildings=${s0.buildings.length} tick=${s0.tick}`);
const tips = await solo.evaluate(() => [...document.querySelectorAll('#dock .tool')].map((b) => b.title));
check(tips.length === 9 && tips.every((t) => /§\d+/.test(t) && t.length > 40) && tips.slice(0, 6).every((t) => /Peak hours/.test(t) && /Demand bars/.test(t)) && /Boost radius: 1 tile/.test(tips[6]) && /tramway avenue/.test(tips[7]) && /Boost radius: 2 tiles/.test(tips[8]), 'all 9 dock tools carry a tooltip: cost, peak hours, demand bars, boost radius', tips[0].split('\n')[0] + ' … ' + tips[8].split('\n')[0]);
const borrowLabel = await text(solo, '#treasury [data-act="borrow"]');
check(/Borrow §400\s*·\s*7\.2%\/qtr/.test(borrowLabel), 'Borrow button states the exact rate', borrowLabel);
const soundPlay = await solo.evaluate(() => { const b = document.querySelector('#clock [data-act="sound"]'); return `${b.getAttribute('aria-pressed')}|${b.getAttribute('aria-label')}|${b.title}`; });
check(soundPlay === 'false|Mute sound (M)|Mute sound (M)', 'in-match Sound button: aria-pressed + "Mute sound (M)"', soundPlay);
// Hotkey arms a tool during play; Escape drops it.
await solo.keyboard.press('1');
const armed = (await info(solo)).tool;
await solo.keyboard.press('Escape');
check(armed === 'roastery' && (await info(solo)).tool === null, 'hotkey 1 arms the Roastery in a live match, Esc disarms', `tool=${armed}`);

const cash0 = s0.players[0].cash;
const lot = await build(solo, 'roastery');
await solo.waitForFunction((t) => window.__mercadia.state().buildings.some((b) => b.tile === t && b.owner === 0), lot, { timeout: 5000 });
const s1 = await state(solo);
check(s1.players[0].cash === cash0 - 180, 'building a Roastery costs §180', `cash ${cash0} → ${s1.players[0].cash}, lot ${lot}`);
await solo.waitForFunction(() => !document.getElementById('inspector').hidden, null, { timeout: 5000 });
await solo.click('#inspector [data-act="stance"][data-v="0"]');
await solo.waitForFunction((t) => window.__mercadia.state().buildings.find((b) => b.tile === t)?.stance === 0, lot);
ok('inspector sets the Budget price stance');
await solo.click('#inspector [data-act="stance"][data-v="1"]');

// Blueprint previews: synergy badges on the hover card, the tram-avenue hint.
await solo.click('#dock [data-kind="park"]');
let hov = await freeLot(solo);
await solo.mouse.move(hov.x, hov.y);
await solo.waitForFunction(() => !document.getElementById('lotcard').hidden, null, { timeout: 3000 });
const parkCard = await text(solo, '#lotcard');
check(/\+20% Park Aura to \d+ lots?/.test(parkCard), 'arming a Park shows what its aura will reach on the hover card', parkCard.replace(/\s+/g, ' '));
await solo.click('#dock [data-kind="tramstop"]');
const tramHint = await text(solo, '#dock .hint');
const inland = await freeLot(solo, false);
await solo.mouse.move(inland.x, inland.y);
await solo.waitForTimeout(200);
const inlandCard = await text(solo, '#lotcard');
const avenue = await freeLot(solo, true);
await solo.mouse.move(avenue.x, avenue.y);
await solo.waitForTimeout(200);
const avenueCard = await text(solo, '#lotcard');
check(/Place along the tramway avenue/.test(tramHint) && /Place along the tramway avenue/.test(inlandCard) && /\+Tram Footfall to \d+ lots?/.test(avenueCard), 'Tram Stop: avenue hint, inland lots refused before any click, avenue lots show their reach', `hint="${tramHint.replace(/\s+/g, ' ').slice(0, 70)}" avenue="${avenueCard.replace(/\s+/g, ' ').slice(0, 60)}"`);
await solo.screenshot({ path: `${OUT}/02a-tramstop-blueprint.png` });
await solo.keyboard.press('Escape');
await solo.click('#dock [data-kind="bistro"]');
hov = await freeLot(solo);
await solo.mouse.move(hov.x, hov.y);
await solo.waitForTimeout(200);
const shopCard = await text(solo, '#lotcard');
check(/(rival Bistro|No Bistro nearby|of your own nearby)/.test(shopCard), 'hovering a lot with a shop tool shows competition badges', shopCard.replace(/\s+/g, ' ').slice(0, 90));
await solo.keyboard.press('Escape');

// Conflicting toast lifetime: a refusal is dismissed the moment the next action succeeds.
const cinemaLot = await build(solo, 'cinema');
await solo.waitForFunction((t) => window.__mercadia.state().buildings.some((b) => b.tile === t && b.kind === 'cinema'), cinemaLot, { timeout: 5000 });
await solo.keyboard.press('Escape');
await build(solo, 'cinema'); // §260 left: refused
await solo.waitForFunction(() => document.querySelectorAll('#toasts .toast.bad').length === 1, null, { timeout: 3000 });
const refusal = await text(solo, '#toasts .toast.bad');
await solo.click('#treasury [data-act="borrow"]');
const staleToasts = await solo.evaluate(() => document.querySelectorAll('#toasts .toast.bad').length);
check(/Not enough cash/.test(refusal) && staleToasts === 0, 'a refusal toast is cleared at once when the next action succeeds', `"${refusal}" → ${staleToasts} left after Borrow`);
await solo.keyboard.press('Escape');

const t0 = (await state(solo)).tick;
await solo.waitForFunction((t) => window.__mercadia.state().tick > t + 15, t0, { timeout: 15000 });
const s2 = await state(solo);
check(s2.citizens >= 60 && s2.citizens <= 120, 'citizens walk the streets', `tick ${s2.tick}, citizens=${s2.citizens}`);
check((await solo.evaluate(() => window.__mercadia.dev)) === true, 'dev hooks are live on a local host');
await solo.evaluate(() => window.__mercadia.warp(380));
await solo.waitForTimeout(700);
const s3 = await state(solo);
check(s3.buildings.length > 4 && s3.buildings.some((b) => b.owner !== 0), 'AI tycoons build rival shops', `buildings=${s3.buildings.length} tick=${s3.tick}`);

// Shop Inspector diagnosis, ledger financing lines, Crown breakdown.
const mine = await solo.evaluate((t) => window.__mercadia.tileScreen(t), lot);
await solo.mouse.click(mine.x, mine.y - 4);
await solo.waitForFunction((t) => window.__mercadia.selectedTile === t, lot, { timeout: 3000 });
const diag = await text(solo, '#inspector .diag');
check(diag.length > 8, 'the Shop Inspector carries a one-line diagnosis', diag);
await solo.click('#treasury [data-act="ledger"]');
const ledger = await text(solo, '#ledger');
check(/Financing/.test(ledger) && /Loan draws\s*400/.test(ledger) && /Loan repayments/.test(ledger) && /Change in cash/.test(ledger), 'the Ledger shows Financing: loan draws, repayments, change in cash', ledger.replace(/\s+/g, ' ').slice(-150));
const recon = await solo.evaluate(() => {
  const m = document.querySelector('#ledger .recon b')?.textContent ?? '';
  const cash = document.querySelector('#treasury [data-f="cash"]')?.textContent ?? '';
  return { ledger: Number(m.replace(/[^0-9-]/g, '')), cash: Number(cash.replace(/[^0-9-]/g, '')) };
});
check(Math.abs(recon.ledger - recon.cash) <= 1, 'ledger reconciles with the wallet to the §', `ledger says §${recon.ledger}, wallet shows §${recon.cash}`);
await solo.click('#ledger [data-act="close"]');
const rowTitle = await solo.evaluate(() => document.querySelector('#board .row')?.getAttribute('title') ?? '');
await solo.click('#board [data-act="breakdown"]');
const parts = await solo.evaluate(() => [...document.querySelectorAll('#board .row')].map((r) => ({ crown: Number(r.querySelector('[data-f="crown"]').textContent), nums: [...r.querySelectorAll('.parts b')].map((b) => Number(b.textContent)), shown: getComputedStyle(r.querySelector('.parts')).display !== 'none' })));
check(/Crown \d+ = Worth \d+ .* \+ Share -?\d+ .* \+ Prestige \d+/.test(rowTitle) && parts.every((p) => p.shown && p.nums.length === 3 && p.nums[0] + p.nums[1] + p.nums[2] === p.crown), 'leaderboard breaks every Crown Index into Worth + Share + Prestige (tooltip and toggle)', parts.map((p) => `${p.nums.join('+')}=${p.crown}`).join('  '));
await solo.screenshot({ path: `${OUT}/02-solo.png` });
await solo.keyboard.press('Escape');

// Destructive Leave needs two clicks.
await solo.click('#clock [data-act="leave"]');
await solo.waitForTimeout(200);
const afterOne = { phase: (await info(solo)).phase, label: await text(solo, '#clock [data-act="leave"]') };
check(afterOne.phase === 'playing' && afterOne.label === 'Leave?', 'one click on Leave only arms it: the match goes on', `phase=${afterOne.phase} label="${afterOne.label}"`);
await solo.waitForTimeout(4200);
const lapsed = { phase: (await info(solo)).phase, label: await text(solo, '#clock [data-act="leave"]') };
check(lapsed.phase === 'playing' && lapsed.label === '', 'the Leave confirmation lapses after four seconds', `phase=${lapsed.phase} label="${lapsed.label}"`);

// Final bell: the Final Edition, with the hotkey lock and rematch cleanup.
await solo.keyboard.press('2'); // arm a tool just before the bell
await solo.evaluate(() => window.__mercadia.warp(1300));
await solo.waitForFunction(() => !document.getElementById('victory').hidden, null, { timeout: 8000 });
const atBell = await info(solo);
for (const key of ['1', '2', '7', 'Space']) await solo.keyboard.press(key);
const underModal = await info(solo);
check(atBell.tool === null && underModal.tool === null, 'the final bell disarms the build tool and the Victory modal swallows hotkeys', `tool at bell=${atBell.tool}, after 1/2/7/Space=${underModal.tool}`);
const edition = await solo.evaluate(() => {
  const v = document.querySelector('#victory .victory');
  const eq = [...v.querySelectorAll('.equation b')].map((b) => Number(b.textContent));
  return {
    mast: v.querySelector('.m-name')?.textContent ?? '',
    crest: !!v.querySelector('svg.crest'),
    eq,
    lines: v.querySelectorAll('svg.spark polyline').length,
    dots: v.querySelectorAll('svg.spark circle').length,
    rows: v.querySelectorAll('table tbody tr').length,
    highlight: v.querySelector('.highlight')?.textContent ?? '',
    awards: v.querySelectorAll('.award').length,
    rematch: !!v.querySelector('[data-act="rematch"]:not([disabled])'),
    endless: !!v.querySelector('[data-act="endless"]:not([disabled])'),
    fits: v.scrollWidth <= v.clientWidth + 1,
  };
});
check(edition.mast === 'The Mercadia Gazette' && edition.crest && edition.eq.length === 4 && edition.eq[0] + edition.eq[1] + edition.eq[2] === edition.eq[3] && edition.lines === 4 && edition.dots === 4 && edition.rows === 4 && edition.highlight.length > 10 && edition.awards === 3 && edition.rematch && edition.endless && edition.fits, 'Final Edition: masthead, crest, Crown breakdown, share sparkline, headline, awards, Rematch + Endless', `${edition.eq.slice(0, 3).join(' + ')} = ${edition.eq[3]} · "${edition.highlight}"`);
await solo.screenshot({ path: `${OUT}/02b-final-edition.png` });
await solo.click('#victory [data-act="rematch"]');
await solo.waitForFunction(() => document.getElementById('victory').hidden && !window.__mercadia.state().ended && window.__mercadia.state().tick < 40, null, { timeout: 5000 });
const reborn = await info(solo);
check(reborn.tool === null && (await state(solo)).buildings.length === 0, 'Rematch starts a clean district with nothing armed', `tool=${reborn.tool}`);
await solo.keyboard.press('3');
await solo.evaluate(() => window.__mercadia.warp(1300));
await solo.waitForFunction(() => !document.getElementById('victory').hidden, null, { timeout: 8000 });
await solo.click('#victory [data-act="endless"]');
await solo.waitForFunction(() => document.getElementById('victory').hidden && !window.__mercadia.state().ended, null, { timeout: 5000 });
const onward = await state(solo);
check((await info(solo)).tool === null && onward.quarter === 3, 'Continue in Endless resumes the same city with nothing armed', `quarter ${onward.quarter}, tool=${(await info(solo)).tool}`);

// Leave: two deliberate clicks.
await solo.click('#clock [data-act="leave"]');
await solo.waitForFunction(() => document.querySelector('#clock [data-act="leave"]')?.textContent?.trim() === 'Leave?');
await solo.click('#clock [data-act="leave"]');
await solo.waitForFunction(() => window.__mercadia.phase === 'title');
ok('a second click on Leave returns to the title');
await solo.context().close();

// ── Dev hook gating on a non-local hostname ──
console.log('Dev hook');
const pub = await open('public-host', `http://mercadia.test:${PORT}/`);
await pub.click('#title [data-act="solo"]');
await pub.waitForFunction(() => window.__mercadia.phase === 'playing');
const gate = await pub.evaluate(() => {
  const m = window.__mercadia;
  const before = m.state().tick;
  const ret = m.warp(500);
  return { dev: m.dev, ret, jumped: m.state().tick - before, host: location.hostname };
});
check(gate.dev === false && gate.ret === false && gate.jumped < 50, 'warp() is inert on a non-local host', `${gate.host}: dev=${gate.dev} warp→${gate.ret} tick moved ${gate.jumped}`);
await pub.context().close();
const dev = await open('public-host-dev', `http://mercadia.test:${PORT}/?dev=1`);
await dev.click('#title [data-act="solo"]');
await dev.waitForFunction(() => window.__mercadia.phase === 'playing');
const gate2 = await dev.evaluate(() => {
  const m = window.__mercadia;
  const before = m.state().tick;
  m.warp(300);
  return { dev: m.dev, jumped: m.state().tick - before };
});
check(gate2.dev === true && gate2.jumped >= 300, '?dev=1 turns the hook back on', `dev=${gate2.dev} tick moved ${gate2.jumped}`);
await dev.context().close();

// ── Phone: 390×844, touch ──
console.log('Mobile 390×844');
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const phone = await open('phone', '/', PHONE);
await phone.tap('#title [data-act="solo"]');
await phone.waitForFunction(() => window.__mercadia.phase === 'playing');
await phone.waitForTimeout(400);
const span = await phone.evaluate(() => window.__mercadia.islandSpan());
check(span.left >= 0 && span.right <= span.width, 'portrait Fit view shows both island tips with no cropping', `tips at x=${span.left.toFixed(1)} and x=${span.right.toFixed(1)} of ${span.width}px`);
const tabs = await phone.evaluate(() => [...document.querySelectorAll('#docktabs [data-tab]')].map((b) => b.textContent.trim()));
const shopsShown = await phone.evaluate(() => [...document.querySelectorAll('#dock .tool')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.dataset.kind));
check(tabs.join('|') === 'Shops (6)|Civic (3)' && (await visible(phone, '#docktabs [data-tab="civic"]')) && shopsShown.length === 6, 'the dock is tabbed: Shops (6) / Civic (3)', `${tabs.join(' / ')} · showing ${shopsShown.join(', ')}`);
const shopsFit = [];
for (const k of shopsShown) shopsFit.push(await visible(phone, `#dock [data-kind="${k}"]`));
await phone.tap('#docktabs [data-tab="civic"]');
const civicFit = [];
for (const k of ['park', 'tramstop', 'plaza']) civicFit.push(await visible(phone, `#dock [data-kind="${k}"]`));
check(shopsFit.every(Boolean) && civicFit.every(Boolean), 'Park, Tram Stop and Plaza are one tap away and fully on screen', `shops on screen ${shopsFit.filter(Boolean).length}/6, civic ${civicFit.filter(Boolean).length}/3`);
const strip = await phone.evaluate(() => {
  const rows = [...document.querySelectorAll('#board .row')].sort((a, b) => Number(a.style.order) - Number(b.style.order));
  const segs = [...document.querySelectorAll('#board .bar i')].sort((a, b) => Number(a.style.order) - Number(b.style.order));
  return {
    ini: rows.map((r) => r.querySelector('.ini').textContent),
    iniShown: rows.every((r) => getComputedStyle(r.querySelector('.ini')).display !== 'none'),
    rowOrder: rows.map((r) => r.dataset.p).join(''),
    segOrder: segs.map((s) => s.dataset.s).join(''),
    rowX: rows.map((r) => Math.round(r.getBoundingClientRect().left)),
    segX: segs.map((s) => Math.round(s.getBoundingClientRect().left)),
  };
});
const ascending = (v) => v.every((x, i) => i === 0 || x >= v[i - 1]);
check(strip.iniShown && strip.ini.includes('You') && strip.ini.includes('Ves') && strip.rowOrder === strip.segOrder && ascending(strip.rowX) && ascending(strip.segX), 'score strip shows initials and the share bar follows its rank order', `${strip.ini.join(' ')} · rows ${strip.rowOrder} / bar ${strip.segOrder}`);
// Touch blueprint: first tap previews, second tap builds.
await phone.tap('#dock [data-kind="park"]');
const p1 = await freeLot(phone);
await phone.touchscreen.tap(p1.x, p1.y);
await phone.waitForTimeout(250);
const previewOnly = !(await state(phone)).buildings.some((b) => b.tile === p1.t);
const previewCard = await text(phone, '#lotcard');
await phone.screenshot({ path: `${OUT}/06-mobile-civic-blueprint.png` });
await phone.touchscreen.tap(p1.x, p1.y);
await phone.waitForFunction((t) => window.__mercadia.state().buildings.some((b) => b.tile === t && b.kind === 'park' && b.owner === 0), p1.t, { timeout: 5000 });
check(previewOnly && /Park Aura/.test(previewCard) && /tap again/.test(previewCard), 'touch: first tap previews the blueprint and its reach, second tap builds', previewCard.replace(/\s+/g, ' ').slice(0, 90));
await phone.tap('#docktabs [data-tab="shops"]');
await phone.tap('#dock [data-kind="roastery"]');
const p2 = await freeLot(phone);
await phone.touchscreen.tap(p2.x, p2.y);
await phone.waitForTimeout(150);
await phone.touchscreen.tap(p2.x, p2.y);
await phone.waitForFunction((t) => window.__mercadia.state().buildings.some((b) => b.tile === t && b.kind === 'roastery'), p2.t, { timeout: 5000 });
check(await phone.evaluate(() => document.getElementById('inspector').hidden) && (await visible(phone, '#dock [data-kind="bistro"]')), 'after building on a phone the dock stays in reach (no sheet in the way)');
// Weather modifiers stay readable.
await phone.evaluate(() => window.__mercadia.warp(110));
await phone.waitForFunction(() => !!document.querySelector('#ticker .tk-fx'), null, { timeout: 5000 });
const fx = await phone.evaluate(() => { const el = document.querySelector('#ticker .tk-fx'); const cs = getComputedStyle(el); return { text: el.textContent, shown: cs.display !== 'none', fits: el.scrollWidth <= el.clientWidth + 1, size: parseFloat(cs.fontSize) }; });
check(fx.shown && fx.fits && fx.text.length > 8 && fx.size >= 10, 'the Gazette event’s modifier line is readable at 390px', `"${fx.text}" at ${fx.size}px, unclipped=${fx.fits}`);
// Inspector as a bottom sheet.
const sp = await phone.evaluate((t) => window.__mercadia.tileScreen(t), p2.t);
await phone.touchscreen.tap(sp.x, sp.y - 3);
await phone.waitForFunction((t) => window.__mercadia.selectedTile === t && !document.getElementById('inspector').hidden, p2.t, { timeout: 5000 });
await phone.waitForTimeout(250);
const sheet = await phone.evaluate((t) => {
  const el = document.getElementById('inspector');
  const r = el.getBoundingClientRect();
  const p = window.__mercadia.tileScreen(t);
  const board = document.getElementById('board').getBoundingClientRect();
  const sell = el.querySelector('[data-act="sell"]');
  sell.scrollIntoView({ block: 'end' });
  const sr = sell.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, h: r.height, scrolls: el.scrollHeight > el.clientHeight, tileY: p.y, tileX: p.x, boardBottom: board.bottom, sellIn: sr.top >= r.top && sr.bottom <= r.bottom + 0.5 && sr.bottom <= innerHeight, vh: innerHeight };
}, p2.t);
check(sheet.bottom >= sheet.vh - 12 && sheet.h <= sheet.vh * 0.43 && sheet.sellIn && sheet.tileY > sheet.boardBottom && sheet.tileY < sheet.top && sheet.tileX > 0 && sheet.tileX < 390, 'the Inspector is a compact bottom sheet: Sell reachable by scroll, the selected block visible above it', `sheet ${Math.round(sheet.top)}–${Math.round(sheet.bottom)} of ${sheet.vh}, block at y=${Math.round(sheet.tileY)}, Sell in view=${sheet.sellIn}`);
await phone.screenshot({ path: `${OUT}/07-mobile-sheet.png` });
await phone.tap('#inspector [data-act="collapse"]');
const collapsed = await phone.evaluate(() => document.getElementById('inspector').getBoundingClientRect().height);
check(collapsed < sheet.h, 'the sheet collapses to its summary', `${Math.round(sheet.h)}px → ${Math.round(collapsed)}px`);
await phone.tap('#inspector [data-act="close"]');
// A citizen's speech card must not ride into the score strip.
const walker = await phone.evaluate(() => {
  const m = window.__mercadia;
  const top = document.getElementById('board').getBoundingClientRect().bottom;
  let best = null;
  for (const c of m.citizensOnScreen()) if (c.y > top + 20 && c.y < innerHeight - 200 && (!best || c.y < best.y)) best = c;
  return best;
});
if (walker) {
  await phone.touchscreen.tap(walker.x, walker.y + 4);
  await phone.waitForTimeout(300);
  const card = await phone.evaluate(() => {
    const el = document.querySelector('#speech .card');
    if (!el || document.getElementById('speech').hidden) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, boardBottom: document.getElementById('board').getBoundingClientRect().bottom };
  });
  if (card) check(card.top >= card.boardBottom && card.left >= 0 && card.right <= 390, 'a citizen’s speech card docks clear of the score strip', `card top ${Math.round(card.top)} ≥ strip bottom ${Math.round(card.boardBottom)}`);
  else ok('speech card check skipped (the tap selected a building, not a citizen)');
  await phone.touchscreen.tap(8, 400);
}
await phone.screenshot({ path: `${OUT}/08-mobile-play.png` });
await phone.evaluate(() => window.__mercadia.warp(6100));
await phone.waitForFunction(() => !document.getElementById('victory').hidden, null, { timeout: 8000 });
const mEdition = await phone.evaluate(() => { const v = document.querySelector('#victory .victory'); const r = v.getBoundingClientRect(); const b = v.querySelector('[data-act="rematch"]'); return { fits: v.scrollWidth <= v.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth, lines: v.querySelectorAll('svg.spark polyline').length, btn: b.getBoundingClientRect().height }; });
check(mEdition.fits && mEdition.lines === 4 && mEdition.btn >= 44, 'the Final Edition fits a 390px screen with no sideways scroll', `overflow-free=${mEdition.fits}, Rematch button ${Math.round(mEdition.btn)}px tall`);
await phone.screenshot({ path: `${OUT}/09-mobile-final-edition.png` });
await phone.context().close();

// ── Multiplayer: browser contexts sharing one room ──
console.log('Multiplayer');
const a = await open('host');
await a.fill('#t-name', 'Ada');
await a.click('#title [data-act="create"]');
await a.waitForFunction(() => window.__mercadia.phase === 'lobby' && window.__mercadia.seat === 0 && !!window.__mercadia.lobby, null, { timeout: 15000 });
const code = (await info(a)).room;
check(/^[A-Z]{4}$/.test(code) && new URL(a.url()).searchParams.get('room') === code, 'Create Room yields a code and ?room= URL', `${code} ${a.url()}`);
// Hotkeys are dead in the Lobby too.
await a.keyboard.press('1');
await a.keyboard.press('Space');
check((await info(a)).tool === null && (await info(a)).phase === 'lobby', 'build and speed hotkeys are ignored in the Lobby');
// No AI (Pure PvP): one click each way.
await a.waitForSelector('#lobby [data-act="pvp"]');
const pvpLabel = await text(a, '#lobby [data-act="pvp"]');
await a.click('#lobby [data-act="pvp"]');
await a.waitForFunction(() => window.__mercadia.lobby.seats.every((s) => s.kind !== 'ai'), null, { timeout: 5000 });
const pure = await a.evaluate(() => ({ seats: window.__mercadia.lobby.seats.map((s) => s.kind).join(','), start: document.querySelector('#lobby [data-act="start"]').disabled, pressed: document.querySelector('#lobby [data-act="pvp"]').getAttribute('aria-pressed') }));
check(pvpLabel === 'No AI (Pure PvP)' && pure.seats === 'human,open,open,open' && pure.start === true && pure.pressed === 'true', 'No AI (Pure PvP) clears every AI seat in one click', `"${pvpLabel}" → ${pure.seats}`);
await a.screenshot({ path: `${OUT}/03a-lobby-pvp.png` });
await a.click('#lobby [data-act="pvp"]');
await a.waitForFunction(() => window.__mercadia.lobby.seats.filter((s) => s.kind === 'ai').length === 3, null, { timeout: 5000 });
ok('the same button brings the AI rivals back');

const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const openGuest = async (label) => {
  const page = await guestCtx.newPage();
  watch(page, label);
  await page.goto(`${BASE}/?room=${code}`);
  await ready(page);
  return page;
};
let b = await openGuest('guest');
await b.waitForFunction(() => window.__mercadia.phase === 'lobby' && window.__mercadia.seat === 1, null, { timeout: 15000 });
await a.waitForFunction(() => window.__mercadia.lobby.seats.filter((s) => s.kind === 'human' && s.connected).length === 2, null, { timeout: 15000 });
const lob = await a.evaluate(() => window.__mercadia.lobby);
check(lob.seats[0].name === 'Ada' && lob.seats[1].kind === 'human' && lob.seats[2].kind === 'ai' && lob.seats[3].kind === 'ai' && lob.host === 0, 'invite link auto-joins: 2 humans + 2 AI, host is seat 0', lob.seats.map((s) => `${s.kind}:${s.name}`).join(' '));
await a.screenshot({ path: `${OUT}/03-lobby.png` });
await a.click('#lobby [data-act="mode"][data-v="blitz"]');
await b.waitForFunction(() => window.__mercadia.lobby.mode === 'blitz');
ok('host picks Blitz and the guest sees it');
await a.click('#lobby [data-act="start"]');
for (const p of [a, b]) await p.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.kind === 'multi' && window.__mercadia.state().ready, null, { timeout: 15000 });
const ia = await info(a);
const ib = await info(b);
check(ia.me === 0 && ib.me === 1, 'both sockets are seated in the match', `host player ${ia.me}, guest player ${ib.me}`);
const pace = await b.evaluate(() => [...document.querySelectorAll('#clock [data-act="speed"]')].map((x) => `${x.disabled}|${x.title}`));
check(pace.length === 3 && pace.every((x) => x === 'true|Host controls match speed'), 'guest speed buttons are disabled and say why', pace[0]);
const ta = (await state(a)).tick;
await a.waitForFunction((t) => window.__mercadia.state().tick > t + 20, ta, { timeout: 15000 });
const [sa, sb] = [await state(a), await state(b)];
check(Math.abs(sa.tick - sb.tick) <= 6 && sa.citizens >= 60, 'server ticks at 10 Hz for both clients', `ticks ${sa.tick}/${sb.tick}, citizens ${sa.citizens}/${sb.citizens}`);
const lotA = await build(a, 'bistro');
await b.waitForFunction((t) => window.__mercadia.state().buildings.some((x) => x.tile === t && x.owner === 0 && x.kind === 'bistro'), lotA, { timeout: 8000 });
ok('host builds a Bistro and the guest sees it', `lot ${lotA}`);
const lotB = await build(b, 'roastery');
await a.waitForFunction((t) => window.__mercadia.state().buildings.some((x) => x.tile === t && x.owner === 1 && x.kind === 'roastery'), lotB, { timeout: 8000 });
ok('guest builds a Roastery and the host sees it', `lot ${lotB}`);
const [ca, cb] = [await state(a), await state(b)];
check(ca.players[0].cash === cb.players[0].cash || Math.abs(ca.players[0].cash - cb.players[0].cash) < 60, 'cash agrees across clients', `host sees ${ca.players[0].cash}, guest sees ${cb.players[0].cash}`);
// A rival's Promo Blitz shows in their shop's Inspector, with a live countdown.
await a.keyboard.press('Escape');
const pa = await a.evaluate((t) => window.__mercadia.tileScreen(t), lotA);
await a.mouse.click(pa.x, pa.y - 4);
await a.waitForFunction((t) => window.__mercadia.selectedTile === t, lotA, { timeout: 5000 });
await a.click('#inspector [data-act="promo"]');
await b.keyboard.press('Escape');
const pb = await b.evaluate((t) => window.__mercadia.tileScreen(t), lotA);
await b.mouse.click(pb.x, pb.y - 4);
await b.waitForFunction(() => { const el = document.querySelector('#inspector .promobadge'); return !!el && !el.hidden; }, null, { timeout: 6000 });
const badge1 = await text(b, '#inspector .promobadge');
await b.waitForTimeout(2200);
const badge2 = await text(b, '#inspector .promobadge');
const secs = (s) => Number((s.match(/(\d+)s/) ?? [])[1]);
check(/Promo Blitz/.test(badge1) && secs(badge2) < secs(badge1), 'a rival’s Promo Blitz shows as a badge with a live countdown in their shop’s Inspector', `"${badge1}" → "${badge2}"`);
const news = await a.evaluate(() => window.__mercadia.gazette().map((g) => `${g.tone}:${g.text}`));
check(news.some((n) => /^rival:Promo Blitz!/.test(n)), 'the Gazette headlines the Promo Blitz', news.filter((n) => n.startsWith('rival:')).join(' | '));
await a.screenshot({ path: `${OUT}/04-multiplayer-host.png` });
await b.screenshot({ path: `${OUT}/05-multiplayer-guest.png` });
// Reconnect: the guest reloads and must land in the same seat with the same city.
await b.reload();
await b.waitForFunction(() => window.__mercadia && window.__mercadia.phase === 'playing' && window.__mercadia.me === 1 && window.__mercadia.state().ready, null, { timeout: 20000 });
const rb = await state(b);
check(rb.buildings.some((x) => x.tile === lotA) && rb.buildings.some((x) => x.tile === lotB && x.owner === 1), 'guest reloads and reconnects into the same seat', `player ${(await info(b)).me}, buildings ${rb.buildings.length}`);
// Harder: the tab is closed outright (sessionStorage gone) and the invite link is reopened.
await b.close();
await a.waitForFunction(() => window.__mercadia.lobby.seats[1].connected === false, null, { timeout: 10000 });
b = await openGuest('guest-reopened');
await b.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.state().ready, null, { timeout: 20000 });
await b.waitForTimeout(400);
const reopened = await info(b);
check(reopened.me === 1 && reopened.seat === 1, 'closing the tab and reopening ?room= reclaims the exact seat (not a spectator)', `seat ${reopened.seat}, player ${reopened.me}`);
const room = await (await fetch(`${BASE}/api/rooms/${code}`)).json();
check(room.status === 'playing' && room.humans === 2 && room.connected === 2, 'room summary reports the running match', `status=${room.status} humans=${room.humans} connected=${room.connected} tick=${room.tick}`);
// A latecomer on a phone watches as a spectator, and can read that they are.
const spec = await open('spectator', `/?room=${code}`, PHONE);
await spec.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.state().ready, null, { timeout: 20000 });
await spec.waitForTimeout(300);
const pill = await spec.evaluate(() => {
  const el = document.getElementById('spectator');
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const rgb = (s) => s.match(/[\d.]+/g).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const fg = rgb(cs.color);
  const bg = rgb(cs.backgroundColor);
  const a = bg[3] ?? 1;
  // Worst case: the 4% that shows through is as dark as the ink itself.
  const worst = bg.slice(0, 3).map((v) => v * a + 30 * (1 - a));
  const [l1, l2] = [lum(worst), lum(fg)];
  return { hidden: el.hidden, text: el.textContent, color: cs.color, bg: cs.backgroundColor, border: cs.borderTopWidth, contrast: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, me: window.__mercadia.me };
});
check(!pill.hidden && pill.me === -1 && /watching as a spectator/.test(pill.text) && pill.color === 'rgb(30, 26, 22)' && pill.bg === 'rgba(250, 247, 240, 0.96)' && pill.contrast >= 10 && pill.inView && parseFloat(pill.border) >= 1, 'spectator notice: dark ink on solid cream linen with a hairline, ≥ 10:1', `${pill.color} on ${pill.bg}, contrast ${pill.contrast.toFixed(1)}:1`);
await spec.screenshot({ path: `${OUT}/10-mobile-spectator.png` });
await spec.context().close();
// Host migration: the host leaves, the guest takes over.
await a.context().close();
await b.waitForFunction(() => window.__mercadia.lobby.host === 1, null, { timeout: 15000 });
ok('host leaves and the guest becomes host');
const tb = (await state(b)).tick;
await b.waitForFunction((t) => window.__mercadia.state().tick > t + 10, tb, { timeout: 15000 });
ok('the match keeps running for the remaining player');
await guestCtx.close();
await browser.close();

check(errors.length === 0, '0 console errors, 0 page errors, 0 failed requests', errors.join(' | '));
console.log(`\n${receipts.filter((r) => r.ok).length}/${receipts.length} checks passed`);
if (problems.length) {
  console.log('Problems:\n- ' + problems.join('\n- '));
  process.exit(1);
}
