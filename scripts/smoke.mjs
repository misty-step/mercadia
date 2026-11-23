// MERCADIA v2 smoke check. Needs the Worker running (npm run dev) and a Chrome/Chromium binary.
//   node scripts/smoke.mjs            BASE=http://127.0.0.1:8787  CHROME=/usr/bin/google-chrome
//   ONLY=api,solo,guide,dev,mobile,multi node scripts/smoke.mjs   run some sections only
// Drives the real wrangler dev path: the API; a solo Standard match (objective, Founding Guide,
// Era locks, Era Council + Dynasty Charters, Milestones, heraldry on the HUD and on the canvas,
// the Mercadia Chronicle, layout budgets, the Final Edition, Endless); a 390×844 phone; and two
// browser contexts sharing one multiplayer room over WebSockets (live sync, Era Council charter
// sync and countdown, reconnect, closed-tab seat reclaim, spectator notice, host migration) —
// with zero console errors, page errors or failed requests.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const OUT = process.env.OUT ?? 'smoke-artifacts';
const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const wants = (section) => ONLY.length === 0 || ONLY.includes(section);
mkdirSync(OUT, { recursive: true });
const started = Date.now();

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

const OBJECTIVE = 'Lead your House across 4 Eras — highest Crown Index wins';
const BRASS = '#D4A34A';
const CANAL = '#3E8E9E';
const HOUSE_COLOR = { vermilion: '#D6453A', cobalt: '#2667B8', marigold: '#D48C1C', emerald: '#248A63' };
const HOUSE_CREST = { vermilion: 'compass', cobalt: 'anchor', marigold: 'sunburst', emerald: 'laurel' };
const ERA2 = ['arcade', 'nightmarket', 'tramstop'];
const ERA3 = ['boutique', 'cinema', 'plaza'];

// ── API ──
if (wants('api')) {
  console.log('API');
  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.json();
  check(health.status === 200 && healthBody.ok === true && healthBody.game === 'mercadia' && /^2\./.test(healthBody.version ?? ''), 'GET /api/health', JSON.stringify(healthBody));
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
}

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
const hook = (page, name) => page.evaluate((name) => { const v = window.__mercadia[name]; return typeof v === 'function' ? v.call(window.__mercadia) : v; }, name);
const sleep = (page, ms) => page.waitForTimeout(ms);
/** Let lazily requested webfonts land before a reload or a close, so the navigation aborts nothing in flight. */
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForLoadState('networkidle').catch(() => undefined);
};
/** The free lot nearest the middle of the open map area. */
const freeLot = (page, avenue = null) =>
  page.evaluate((avenue) => {
    const m = window.__mercadia;
    const strip = innerWidth <= 720 ? (document.getElementById('chronicle')?.getBoundingClientRect().bottom ?? 0) : 0;
    const top = Math.max(strip, document.getElementById('board')?.getBoundingClientRect().bottom ?? 0) + 30;
    const bottom = innerWidth <= 720 ? innerHeight - 230 : innerHeight - 110;
    const right = innerWidth <= 720 ? innerWidth : innerWidth - 270;
    const left = innerWidth <= 720 ? 20 : 330;
    let best = null;
    for (const t of m.freeLots()) {
      const p = m.tileScreen(t);
      if (p.y < top || p.y > bottom || p.x < left || p.x > right) continue;
      if (avenue !== null && m.avenueSide(t) !== avenue) continue;
      const d = Math.hypot(p.x - right / 2, p.y - (top + bottom) / 2);
      if (!best || d < best.d) best = { t, x: p.x, y: p.y, d };
    }
    return best;
  }, avenue);
/** Pick a dock tool, then click a free lot (or the given tile). */
const build = async (page, kind, tile = null) => {
  await page.click(`#dock [data-kind="${kind}"]`);
  const target = tile === null ? await freeLot(page) : { t: tile, ...(await page.evaluate((t) => window.__mercadia.tileScreen(t), tile)) };
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(120);
  await page.mouse.click(target.x, target.y);
  return target.t;
};
const built = (page, tile, kind, owner = 0) => page.waitForFunction(([t, k, o]) => window.__mercadia.state().buildings.some((b) => b.tile === t && b.kind === k && b.owner === o), [tile, kind, owner], { timeout: 6000 });
const text = (page, sel) => page.evaluate((sel) => document.querySelector(sel)?.textContent?.trim() ?? '', sel);
const visible = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5;
  }, sel);
/** Run the solo simulation forward in small chunks, logging every Chronicle dispatch on the way. */
const warpBy = async (page, ticks, { hold = false, log = null } = {}) => {
  let left = ticks;
  let moved = 0;
  let last = null;
  while (left > 0) {
    const step = Math.min(100, left);
    last = await page.evaluate(([n, hold]) => {
      const m = window.__mercadia;
      const t0 = m.state().tick;
      m.warp(n, hold);
      const s = m.state();
      return { moved: s.tick - t0, phase: s.phase, tick: s.tick, ch: m.chronicle() };
    }, [step, hold]);
    if (log) for (const d of last.ch) log.set(d.n, d);
    moved += last.moved;
    left -= step;
    if (last.phase === 'ended' || (hold && last.phase === 'council')) break;
  }
  return { moved, phase: last?.phase, tick: last?.tick };
};
const collect = async (page, log) => {
  for (const d of await page.evaluate(() => window.__mercadia.chronicle())) log.set(d.n, d);
};
/** Persistent HUD panels: which are clipped by the viewport, which overlap, and how much city they cover. */
const PANELS = ['#clock', '#chronicle', '#guide', '#board', '#treasury', '#docktabs', '#dock', '#spectator'];
const layout = (page, sels = PANELS) =>
  page.evaluate((sels) => {
    const rects = [];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el || el.hidden) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 1 || r.height < 1) continue;
      rects.push({ sel, l: r.left, t: r.top, r: r.right, b: r.bottom });
    }
    const clipped = rects.filter((q) => q.l < -0.5 || q.t < -0.5 || q.r > innerWidth + 0.5 || q.b > innerHeight + 0.5).map((q) => q.sel);
    const overlaps = [];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
        const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
        if (w > 1 && h > 1) overlaps.push(`${a.sel}×${b.sel}`);
      }
    // Union area on a 2 px raster.
    const S = 2;
    const W = Math.ceil(innerWidth / S);
    const H = Math.ceil(innerHeight / S);
    const grid = new Uint8Array(W * H);
    for (const q of rects) {
      const x0 = Math.max(0, Math.floor(q.l / S));
      const x1 = Math.min(W, Math.ceil(q.r / S));
      const y0 = Math.max(0, Math.floor(q.t / S));
      const y1 = Math.min(H, Math.ceil(q.b / S));
      for (let y = y0; y < y1; y++) grid.fill(1, y * W + x0, y * W + x1);
    }
    let on = 0;
    for (let i = 0; i < grid.length; i++) on += grid[i];
    return { shown: rects.map((q) => q.sel), clipped, overlaps, coverage: (on / grid.length) * 100, size: `${innerWidth}×${innerHeight}` };
  }, sels);
/** Count canvas pixels close to any of the given colours in a box around each tile. */
const housePixels = (page, tiles, colors, tol = 26) =>
  page.evaluate(([tiles, colors, tol]) => {
    const cv = document.querySelector('#stage canvas');
    const g = cv.getContext('2d');
    const k = cv.width / cv.clientWidth;
    const rgb = colors.map((c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
    let n = 0;
    for (const t of tiles) {
      const p = window.__mercadia.tileScreen(t);
      const x0 = Math.max(0, Math.round((p.x - 46) * k));
      const y0 = Math.max(0, Math.round((p.y - 112) * k));
      const w = Math.min(cv.width - x0, Math.round(92 * k));
      const h = Math.min(cv.height - y0, Math.round(142 * k));
      if (w <= 0 || h <= 0) continue;
      const d = g.getImageData(x0, y0, w, h).data;
      for (let i = 0; i < d.length; i += 4) {
        for (const c of rgb) {
          if (Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]) <= tol) {
            n++;
            break;
          }
        }
      }
    }
    return n;
  }, [tiles, colors, tol]);
/** Ticks since the last rivalry headline (they are rationed to one per quiet window). */
const rivalQuiet = (page) =>
  page.evaluate(() => {
    const m = window.__mercadia;
    const r = m.chronicle().filter((d) => d.cat === 'promo' || d.cat === 'rival');
    return m.state().tick - (r.length ? r[r.length - 1].tick : -9999);
  });
const boardCrests = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#board .row')].map((r) => ({ p: Number(r.dataset.p), house: r.dataset.house, crest: r.querySelector('.hcrest')?.dataset.crest ?? '', shown: (r.querySelector('.hcrest')?.getBoundingClientRect().width ?? 0) >= 10, stars: r.querySelectorAll('.mstar.on').length })));
const crestsOk = (rows, CREST) => rows.length === 4 && new Set(rows.map((r) => r.crest)).size === 4 && rows.every((r) => r.shown && CREST[r.house] === r.crest);
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

// ───────────────────────────── Solo ─────────────────────────────
if (wants('solo')) {
  console.log('Solo');
  const solo = await open('solo');
  const log = new Map(); // every Chronicle dispatch seen in this match, by serial number
  const attract = await state(solo);
  check(attract.citizens >= 45 && attract.trams >= 2, 'title screen floats over a live city', `citizens=${attract.citizens} trams=${attract.trams} players=${attract.players.length}`);
  await solo.screenshot({ path: `${OUT}/01-title.png` });
  const titleCopy = await solo.evaluate(() => ({ obj: document.querySelector('#title .objective')?.textContent ?? '', blurb: document.querySelector('#title .modeblurb')?.textContent ?? '' }));
  check(titleCopy.obj === OBJECTIVE && /4 deliberate eras/.test(titleCopy.blurb), 'the Title states the objective and that Standard is 4 deliberate eras', `"${titleCopy.obj}" · "${titleCopy.blurb}"`);
  // Hotkeys must not leak through the Title screen.
  await solo.locator('#stage').focus().catch(() => undefined);
  for (const key of ['1', '5', '9', 'Space']) await solo.keyboard.press(key);
  const titleInfo = await info(solo);
  check(titleInfo.phase === 'title' && titleInfo.tool === null, 'build and speed hotkeys are ignored on the Title screen', `phase=${titleInfo.phase} tool=${titleInfo.tool}`);
  // Sound toggle: aria-pressed and a label that says what the next press does.
  const soundOf = () => solo.evaluate(() => { const b = document.querySelector('#title [data-act="sound"]'); return { p: b.getAttribute('aria-pressed'), l: b.getAttribute('aria-label'), t: b.title }; });
  const sound0 = await soundOf();
  await solo.click('#title [data-act="sound"]');
  const sound1 = await soundOf();
  await solo.click('#title [data-act="sound"]');
  check(sound0.p === 'false' && sound0.l === 'Mute sound (M)' && sound1.p === 'true' && sound1.l === 'Unmute sound (M)' && sound1.t === 'Unmute sound (M)', 'Sound button carries aria-pressed and a dynamic label', `${sound0.p}/"${sound0.l}" → ${sound1.p}/"${sound1.l}"`);

  // ── Match start: objective, Era chip, speeds, a breathable opening ──
  await solo.click('#title [data-act="solo"]');
  await solo.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.kind === 'solo');
  // Watch for the first AI building from the very first tick (deliberate pacing: none before tick 100).
  await solo.evaluate(() => {
    window.__firstAi = null;
    const iv = setInterval(() => {
      const st = window.__mercadia.state();
      if (st.buildings.some((b) => b.owner !== 0)) {
        window.__firstAi = st.tick;
        clearInterval(iv);
      }
    }, 40);
  });
  const s0 = await state(solo);
  check(s0.players.length === 4 && s0.players[0].kind === 'human' && s0.players.filter((p) => p.kind === 'ai').length === 3 && s0.mode === 'standard', 'Play Solo Now starts a Standard match: You vs 3 AI Houses', s0.players.map((p) => p.name).join(', '));
  const opening = await solo.evaluate(() => ({ banner: document.querySelector('#banner')?.textContent ?? '', shown: document.querySelector('#banner')?.classList.contains('show'), guide: document.querySelector('#guide .g-obj')?.textContent ?? '', tick: window.__mercadia.state().tick }));
  check(opening.banner.includes(OBJECTIVE) && opening.shown && opening.guide === OBJECTIVE, 'the match opens on its one-line objective', `banner "${opening.banner.replace(/\s+/g, ' ')}" at tick ${opening.tick}`);
  const chip = await solo.evaluate(() => ({ era: document.querySelector('#clock [data-f="era"]').textContent.trim(), of: document.querySelector('#clock [data-f="eraof"]').textContent.trim(), bars: document.querySelectorAll('#clock [data-f="erabar"] u').length }));
  check(chip.era === 'Era I · Founding' && chip.of === 'of IV' && chip.bars === 4 && (await hook(solo, 'era')) === 1 && (await hook(solo, 'eraName')) === 'Founding Charter', 'the clock chip reads "Era I · Founding" of IV over a four-era progress bar', `"${chip.era}" ${chip.of}, ${chip.bars} segments`);
  check(s0.buildings.length === 0 && s0.tick < 60, 'no AI building stands when the match opens', `buildings=${s0.buildings.length} tick=${s0.tick}`);
  const speeds = await solo.evaluate(() => ({ pause: !!document.querySelector('#clock [data-act="pause"]'), v: [...document.querySelectorAll('#clock [data-act="speed"]')].map((b) => b.dataset.v).join(',') }));
  await solo.click('#clock [data-act="speed"][data-v="0.5"]');
  const half = { speed: await hook(solo, 'speed'), on: await solo.evaluate(() => document.querySelector('#clock [data-act="speed"][data-v="0.5"]').classList.contains('on')) };
  const tHalf = (await state(solo)).tick;
  await sleep(solo, 2000);
  const halfMoved = (await state(solo)).tick - tHalf;
  await solo.click('#clock [data-act="speed"][data-v="1"]');
  check(speeds.pause && speeds.v === '0.5,1,2,3' && half.speed === 0.5 && half.on && halfMoved >= 6 && halfMoved <= 14 && (await hook(solo, 'speed')) === 1, 'solo speed controls: Pause, 0.5×, 1×, 2×, 3× — and 0.5× really halves the clock', `buttons ${speeds.v}; ${halfMoved} ticks in 2 s at 0.5×`);
  const tips = await solo.evaluate(() => [...document.querySelectorAll('#dock .tool')].map((b) => ({ k: b.dataset.kind, t: b.title })));
  check(
    tips.length === 9 && tips.every((t) => /§\d+/.test(t.t) && t.t.length > 40) && tips.slice(0, 6).every((t) => /Peak hours/.test(t.t) && /Demand bars/.test(t.t)) && /Boost radius: 1 tile/.test(tips[6].t) && /tramway avenue/.test(tips[7].t) && /Boost radius: 2 tiles/.test(tips[8].t),
    'all 9 dock tools carry a tooltip: cost, peak hours, demand bars, boost radius',
    tips[0].t.split('\n')[0] + ' … ' + tips[8].t.split('\n')[0],
  );
  const borrowLabel = (await text(solo, '#treasury [data-act="borrow"]')).replace(/\s+/g, ' ');
  check(/Borrow §400\s*·\s*18%\/era/.test(borrowLabel), 'Borrow button states the exact per-era rate', borrowLabel);
  const soundPlay = await solo.evaluate(() => { const b = document.querySelector('#clock [data-act="sound"]'); return `${b.getAttribute('aria-pressed')}|${b.getAttribute('aria-label')}|${b.title}`; });
  check(soundPlay === 'false|Mute sound (M)|Mute sound (M)', 'in-match Sound button: aria-pressed + "Mute sound (M)"', soundPlay);

  // ── Era locks ──
  const locks = await solo.evaluate(() => [...document.querySelectorAll('#dock .tool')].map((b) => { const lock = b.querySelector('.lock'); const r = lock.getBoundingClientRect(); return { k: b.dataset.kind, locked: b.dataset.locked ?? '', badge: lock.hidden ? '' : lock.textContent.trim(), shown: !lock.hidden && r.width > 8 && r.height > 6, tip: b.title.split('\n')[0], aria: b.getAttribute('aria-label') }; }));
  const lockedNow = locks.filter((l) => l.locked);
  check(
    lockedNow.length === 6 && ERA2.every((k) => locks.find((l) => l.k === k).badge === 'Era II' && locks.find((l) => l.k === k).shown) && ERA3.every((k) => locks.find((l) => l.k === k).badge === 'Era III' && locks.find((l) => l.k === k).shown) && ['roastery', 'bistro', 'park'].every((k) => locks.find((l) => l.k === k).locked === ''),
    'Era I: exactly six future-era tools stay on the dock under visible Era II / Era III lock badges',
    lockedNow.map((l) => `${l.k}:${l.badge}`).join(' '),
  );
  check(lockedNow.every((l) => /unlocks in Era (II|III): /.test(l.tip) && /locked/.test(l.aria)), 'every locked tool says when it unlocks (tooltip and label)', lockedNow[0].tip + ' | ' + lockedNow[5].tip);
  const hookLocks = { unlocks: await hook(solo, 'unlocks'), locked: await hook(solo, 'locked') };
  check(hookLocks.unlocks.join() === 'roastery,bistro,park' && hookLocks.locked.join() === 'arcade,boutique,cinema,nightmarket,tramstop,plaza', '__mercadia.unlocks / locked agree with the dock', `unlocks ${hookLocks.unlocks.join(',')}`);
  await solo.click('#dock [data-kind="arcade"]');
  const lockClick = await solo.evaluate(() => ({ n: document.querySelectorAll('#toasts .toast.lockmsg').length, t: document.querySelector('#toasts .toast.lockmsg')?.textContent ?? '', tool: window.__mercadia.tool }));
  await solo.keyboard.press('5'); // Cinema
  const lockKey = await solo.evaluate(() => ({ n: document.querySelectorAll('#toasts .toast.lockmsg').length, t: document.querySelector('#toasts .toast.lockmsg')?.textContent ?? '', tool: window.__mercadia.tool }));
  check(lockClick.n === 1 && lockClick.t === 'Arcade unlocks in Era II: Transit & Trade' && lockClick.tool === null && lockKey.n === 1 && lockKey.t === 'Cinema unlocks in Era III: Grand Boulevard' && lockKey.tool === null, 'a locked tool (click or hotkey) answers with ONE concise unlock notice and arms nothing', `click → "${lockClick.t}" · key 5 → "${lockKey.t}"`);
  // Hotkey arms an unlocked tool during play; Escape drops it.
  await solo.keyboard.press('1');
  const armed = (await info(solo)).tool;
  await solo.keyboard.press('Escape');
  check(armed === 'roastery' && (await info(solo)).tool === null, 'hotkey 1 arms the Roastery in a live match, Esc disarms', `tool=${armed}`);

  // ── Founding Guide ──
  const g1 = await solo.evaluate(() => {
    const m = window.__mercadia;
    const el = document.getElementById('guide');
    const r = el.getBoundingClientRect();
    const clock = document.getElementById('clock').getBoundingClientRect();
    const free = m.freeLots();
    const g = m.guide();
    return {
      step: el.dataset.step, hidden: el.hidden, g, title: el.querySelector('[data-f="gtitle"]').textContent, hint: el.querySelector('[data-f="ghint"]').textContent,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], clockBottom: clock.bottom,
      coversCentre: r.left <= innerWidth / 2 && r.right >= innerWidth / 2 && r.top <= innerHeight / 2 && r.bottom >= innerHeight / 2,
      upperLeft: r.right < innerWidth / 2 && r.bottom < innerHeight / 2 && r.top >= clock.bottom - 1,
      lotsVacant: g.lots.every((t) => free.includes(t)),
      guided: [...document.querySelectorAll('#dock .tool.guided')].map((b) => b.dataset.kind).join(','),
      dismiss: !!el.querySelector('[data-act="dismiss"]'),
    };
  });
  check(!g1.hidden && g1.step === '1' && g1.g.step === 1 && g1.title === 'Claim a prime corner' && g1.dismiss && g1.upperLeft && !g1.coversCentre, 'Founding Guide step 1 docks below the clock in the upper left, clear of the city centre', `"${g1.title}" at [${g1.rect.join(', ')}], clock bottom ${Math.round(g1.clockBottom)}`);
  check(g1.g.lots.length >= 3 && g1.lotsVacant && g1.guided === 'roastery,bistro', 'step 1 rings prime vacant starter lots and points at the Era I shops', `lots ${g1.g.lots.join(',')} · guided ${g1.guided}`);
  await solo.screenshot({ path: `${OUT}/02-era1-onboarding.png` });
  // A ringed lot with a free neighbour sharing an edge, both in the open map area.
  const plan = await solo.evaluate(() => {
    const m = window.__mercadia;
    const free = m.freeLots();
    const open = (t) => { const p = m.tileScreen(t); return p.x > 340 && p.x < innerWidth - 290 && p.y > 150 && p.y < innerHeight - 120; };
    for (const lot of m.guide().lots) {
      if (!open(lot)) continue;
      const x = lot % 12;
      const y = Math.floor(lot / 12);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx > 11 || ny > 11) continue;
        const n = ny * 12 + nx;
        if (free.includes(n) && open(n)) return { lot, next: n };
      }
    }
    return null;
  });
  check(!!plan, 'a ringed starter lot with an adjacent free lot is in the open map area', JSON.stringify(plan));
  const vermilion = ['#D6453A', '#9F2B23'];
  const pxBefore = await housePixels(solo, [plan.lot, plan.next], vermilion);
  const cash0 = (await state(solo)).players[0].cash;
  await build(solo, 'roastery', plan.lot);
  await built(solo, plan.lot, 'roastery');
  const s1 = await state(solo);
  check(s1.players[0].cash === cash0 - 180, 'building a Roastery on a ringed lot costs §180', `cash ${cash0} → ${s1.players[0].cash}, lot ${plan.lot}`);
  await solo.waitForFunction(() => document.getElementById('guide').dataset.step === '2', null, { timeout: 4000 });
  const g2 = await solo.evaluate(() => ({ title: document.querySelector('#guide [data-f="gtitle"]').textContent, inspector: document.getElementById('inspector').hidden, lots: window.__mercadia.guide().lots.length }));
  check(g2.title === 'Inspect your opening street' && g2.inspector && g2.lots === 0, 'the first shop advances the guide to step 2 (the Inspector waits for the player’s own click)', `"${g2.title}"`);
  const mine = await solo.evaluate((t) => window.__mercadia.tileScreen(t), plan.lot);
  await solo.mouse.click(mine.x, mine.y - 4);
  await solo.waitForFunction((t) => window.__mercadia.selectedTile === t && !document.getElementById('inspector').hidden, plan.lot, { timeout: 3000 });
  await solo.waitForFunction(() => document.getElementById('guide').dataset.step === '3', null, { timeout: 4000 });
  const insp = await solo.evaluate(() => ({ diag: document.querySelector('#inspector .diag')?.textContent ?? '', crest: document.querySelector('#inspector .head .hcrest')?.dataset.crest ?? '', stance: document.querySelectorAll('#inspector [data-act="stance"]').length, title: document.querySelector('#guide [data-f="gtitle"]').textContent }));
  check(insp.diag.length > 8 && insp.crest === 'compass' && insp.stance === 4 && /Shape your block/.test(insp.title), 'clicking the shop opens the Inspector — live diagnosis, price stance, the owner’s crest — and the guide moves to step 3', `diagnosis "${insp.diag}" · crest ${insp.crest}`);
  await solo.click('#inspector [data-act="stance"][data-v="0"]');
  await solo.waitForFunction((t) => window.__mercadia.state().buildings.find((b) => b.tile === t)?.stance === 0, plan.lot);
  ok('inspector sets the Budget price stance');
  await solo.click('#inspector [data-act="stance"][data-v="1"]');

  // Blueprint previews: synergy badges on the hover card.
  await solo.click('#dock [data-kind="park"]');
  const nextAt = await solo.evaluate((t) => window.__mercadia.tileScreen(t), plan.next);
  await solo.mouse.move(nextAt.x, nextAt.y);
  await solo.waitForFunction(() => !document.getElementById('lotcard').hidden, null, { timeout: 3000 });
  const parkCard = await text(solo, '#lotcard');
  check(/\+20% Park Aura to \d+ lots?/.test(parkCard), 'arming a Park shows what its aura will reach on the hover card', parkCard.replace(/\s+/g, ' '));
  await solo.keyboard.press('Escape');
  await solo.click('#dock [data-kind="bistro"]');
  let hov = await freeLot(solo);
  await solo.mouse.move(hov.x, hov.y);
  await sleep(solo, 200);
  const shopCard = await text(solo, '#lotcard');
  check(/(rival Bistro|No Bistro nearby|of your own nearby)/.test(shopCard), 'hovering a lot with a shop tool shows competition badges', shopCard.replace(/\s+/g, ' ').slice(0, 90));
  await solo.keyboard.press('Escape');

  // Step 3: a Pocket Park beside the shop — the guide retires for good, and the pair is an enclave.
  await build(solo, 'park', plan.next);
  await built(solo, plan.next, 'park');
  await solo.waitForFunction(() => document.getElementById('guide').hidden, null, { timeout: 4000 });
  const retired = await solo.evaluate(() => ({ stored: localStorage.getItem('mercadia:guide'), g: window.__mercadia.guide() }));
  check(retired.stored === 'done' && retired.g.step === 0 && retired.g.dismissed && !retired.g.visible, 'placing a Pocket Park completes the guide: it retires and the retirement is persisted', `localStorage mercadia:guide=${retired.stored}`);
  await sleep(solo, 900);
  await solo.keyboard.press('Escape');
  await solo.mouse.move(700, 880);
  await sleep(solo, 300);
  const pxAfter = await housePixels(solo, [plan.lot, plan.next], vermilion);
  check(pxBefore < 40 && pxAfter >= pxBefore + 150, 'canvas ownership: House-vermilion kerb, enclave trim and banner pixels appear on the two adjacent owned lots', `vermilion pixels around lots ${plan.lot}+${plan.next}: ${pxBefore} → ${pxAfter}`);
  await solo.screenshot({ path: `${OUT}/03-heraldry-ownership.png` });
  // Block Baron: two adjacent lots are an enclave.
  await solo.waitForFunction(() => window.__mercadia.milestones[0].earned.includes('baron'), null, { timeout: 5000 });
  await collect(solo, log);
  const baron = [...log.values()].find((d) => d.cat === 'milestone' && d.player === 0 && /Block Baron/.test(d.head));
  check(!!baron && baron.pill === '+4 Prestige · ★1' && baron.tier === 1, 'Dynasty Milestone: an adjacent 2-lot enclave earns Block Baron with a loud dispatch', baron ? `"${baron.head}" [${baron.pill}]` : 'no dispatch');

  // ── Chronicle: banner, feed stripes, click-to-focus ──
  const banner = await solo.evaluate(() => { const d = document.querySelector('#chronicle .dispatch'); return { head: d.querySelector('.d-head').textContent, pill: d.querySelector('.d-pill').textContent, pillShown: !d.querySelector('.d-pill').hidden, mode: d.dataset.mode, cat: d.dataset.cat, badge: !!d.querySelector('.d-badge svg') }; });
  check(banner.head.length > 6 && banner.pillShown && banner.pill.length > 2 && banner.badge, 'the Active Dispatch Banner shows a crest or icon, a bold headline and an impact pill', `[${banner.cat}/${banner.mode}] "${banner.head}" [${banner.pill}]`);
  if (!(await solo.evaluate(() => document.getElementById('chronicle').classList.contains('open')))) await solo.click('#chronicle [data-act="feed"]');
  await solo.waitForFunction(() => !document.getElementById('cfeed').hidden && document.querySelectorAll('#cfeed .cline').length >= 3, null, { timeout: 4000 });
  await solo.click('#clock [data-act="pause"]'); // hold the feed still while it is read
  await sleep(solo, 200);
  await collect(solo, log);
  const readFeed = () => solo.evaluate(() => [...document.querySelectorAll('#cfeed .cline')].map((el) => ({ n: Number(el.dataset.n), cat: el.dataset.cat, stripe: el.style.getPropertyValue('--stripe').trim().toUpperCase(), border: getComputedStyle(el).borderLeftWidth, color: getComputedStyle(el).borderLeftColor, head: el.querySelector('.c-head').textContent, pill: el.querySelector('.c-pill')?.textContent ?? '', focus: el.classList.contains('focusable'), tile: Number(el.dataset.tile ?? -1) })));
  const feed = await readFeed();
  const stripeFor = (d) => (d.cat === 'event' ? CANAL : ['rival', 'promo', 'build'].includes(d.cat) && log.get(d.n)?.player >= 0 ? HOUSE_COLOR[s0.players[log.get(d.n).player].house] : BRASS);
  check(feed.length >= 3 && feed.length <= 4 && feed.every((d) => d.border === '3px' && d.stripe === stripeFor(d).toUpperCase()), 'the Recent Chronicle Feed lists 3–4 dispatches with 3 px category stripes (brass, canal, House colour)', feed.map((d) => `${d.cat}:${d.stripe}`).join(' '));
  const focusLine = feed.find((d) => d.focus && (d.tile === plan.next || d.tile === plan.lot)) ?? feed.find((d) => d.focus);
  check(!!focusLine, 'a dispatch tied to a lot carries a focus affordance', focusLine ? `"${focusLine.head}" → lot ${focusLine.tile}` : feed.map((d) => d.head).join(' | '));
  if (focusLine) {
    // Drag the city away, then let the dispatch bring the lot back to the middle of the free area.
    await solo.mouse.move(700, 500);
    await solo.mouse.down();
    await solo.mouse.move(980, 690, { steps: 6 });
    await solo.mouse.up();
    const away = await solo.evaluate((t) => window.__mercadia.tileScreen(t), focusLine.tile);
    await solo.click(`#cfeed .cline[data-n="${focusLine.n}"]`, { timeout: 5000 });
    await sleep(solo, 900);
    const back = await solo.evaluate((t) => { const p = window.__mercadia.tileScreen(t); return { x: p.x, y: p.y, sel: window.__mercadia.selectedTile }; }, focusLine.tile);
    const centre = { x: (1440 - 120) / 2, y: 64 + (900 - 64 - 84) / 2 };
    const moved = Math.hypot(away.x - back.x, away.y - back.y);
    check(moved > 120 && Math.abs(back.x - centre.x) < 40 && Math.abs(back.y - centre.y) < 40, 'click-to-focus glides the camera so the lot sits at the centre of the free city area', `lot ${focusLine.tile}: (${Math.round(away.x)},${Math.round(away.y)}) → (${Math.round(back.x)},${Math.round(back.y)}), centre (${centre.x},${centre.y})`);
    await solo.click('#clock [data-act="fit"]');
    await sleep(solo, 300);
  }
  await solo.click('#clock [data-act="pause"]'); // resume

  // ── Layout budget ──
  await solo.keyboard.press('Escape');
  const lay1440 = await layout(solo);
  check(lay1440.clipped.length === 0 && lay1440.overlaps.length === 0, '1440×900: no persistent panel is clipped or overlaps another', `${lay1440.shown.join(' ')} · clipped [${lay1440.clipped}] overlaps [${lay1440.overlaps}]`);
  check(lay1440.coverage <= 15, '1440×900: the persistent HUD leaves ≥ 85% of the viewport to the city (feed open)', `HUD union covers ${lay1440.coverage.toFixed(2)}%`);
  await solo.setViewportSize({ width: 1024, height: 768 });
  await sleep(solo, 500);
  const lay1024 = await layout(solo);
  check(lay1024.clipped.length === 0 && lay1024.overlaps.length === 0, '1024×768: no persistent panel is clipped or overlaps another', `${lay1024.shown.join(' ')} · clipped [${lay1024.clipped}] overlaps [${lay1024.overlaps}] · covers ${lay1024.coverage.toFixed(1)}%`);
  await solo.screenshot({ path: `${OUT}/04-1024x768.png` });
  await solo.setViewportSize({ width: 1440, height: 900 });
  await sleep(solo, 400);
  await solo.click('#clock [data-act="fit"]');

  // Conflicting toast lifetime: a refusal is dismissed the moment the next action succeeds.
  for (let i = 0; i < 4; i++) {
    const cash = (await state(solo)).players[0].cash;
    if (cash < 180) break;
    const kind = cash >= 280 ? 'bistro' : 'roastery';
    const t = await build(solo, kind);
    await built(solo, t, kind);
    await solo.keyboard.press('Escape');
  }
  await build(solo, 'bistro');
  await solo.waitForFunction(() => document.querySelectorAll('#toasts .toast.bad').length === 1, null, { timeout: 3000 });
  const refusal = await text(solo, '#toasts .toast.bad');
  await solo.click('#treasury [data-act="borrow"]');
  const staleToasts = await solo.evaluate(() => document.querySelectorAll('#toasts .toast.bad').length);
  check(/Not enough cash/.test(refusal) && staleToasts === 0, 'a refusal toast is cleared at once when the next action succeeds', `"${refusal}" → ${staleToasts} left after Borrow`);
  await solo.keyboard.press('Escape');
  const t0 = (await state(solo)).tick;
  await solo.waitForFunction((t) => window.__mercadia.state().tick > t + 15, t0, { timeout: 15000 });
  const s2 = await state(solo);
  check(s2.citizens >= 45 && s2.citizens <= 120, 'citizens walk the streets', `tick ${s2.tick}, citizens=${s2.citizens}`);
  check((await hook(solo, 'dev')) === true, 'dev hooks are live on a local host');

  // A Promo Blitz of my own makes a rivalry headline carrying my House.
  // (Rivalry headlines are rationed to one per quiet window, so hold the clock and wait one out.)
  await solo.click('#clock [data-act="pause"]');
  for (let i = 0; i < 6; i++) {
    const q = await rivalQuiet(solo);
    if (q > 160) break;
    await warpBy(solo, 165 - q, { log });
  }
  const shopAt = await solo.evaluate((t) => window.__mercadia.tileScreen(t), plan.lot);
  await solo.mouse.click(shopAt.x, shopAt.y - 4);
  await solo.waitForFunction((t) => window.__mercadia.selectedTile === t, plan.lot, { timeout: 3000 });
  await solo.click('#inspector [data-act="promo"]');
  await solo.waitForFunction(() => window.__mercadia.chronicle().some((d) => d.cat === 'promo' && d.player === 0), null, { timeout: 4000 });
  await solo.click('#clock [data-act="pause"]'); // resume
  await collect(solo, log);
  const promo = [...log.values()].find((d) => d.cat === 'promo' && d.player === 0);
  const promoBanner = await solo.evaluate(() => { const d = document.querySelector('#chronicle .dispatch'); return { cat: d.dataset.cat, crest: d.querySelector('.d-badge .hcrest')?.dataset.crest ?? '', head: d.querySelector('.d-head').textContent, pill: d.querySelector('.d-pill').textContent }; });
  check(promo && promo.tile === plan.lot && /Promo Blitz! Vermilion/.test(promo.head) && /Roastery pull ×2\.4 · 20s/.test(promo.pill) && promoBanner.cat === 'promo' && promoBanner.crest === 'compass', 'firing a Promo Blitz prints a loud dispatch under my House crest with its exact pull', `"${promoBanner.head}" [${promoBanner.pill}]`);

  // AI Houses respect the Era locks through the Founding era; twilight keeps ownership bright.
  await warpBy(solo, Math.max(0, 1200 - (await state(solo)).tick), { log });
  await sleep(solo, 700);
  const s3 = await state(solo);
  const aiKinds = [...new Set(s3.buildings.filter((b) => b.owner !== 0).map((b) => b.kind))];
  check(s3.buildings.some((b) => b.owner !== 0) && aiKinds.every((k) => ['roastery', 'bistro', 'park'].includes(k)) && s3.buildings.every((b) => b.level <= 2), 'AI Houses build rival shops in Era I and respect the Era locks (no future-era build, no Level 3)', `tick ${s3.tick}: ${s3.buildings.filter((b) => b.owner !== 0).length} AI buildings of ${aiKinds.join(', ')}`);
  const firstAi = await solo.evaluate(() => window.__firstAi);
  check(firstAi !== null && firstAi >= 100, 'deliberate AI pacing: no AI House built before its opening delay (tick 100) — no tick-1 click spam', `first AI building seen at tick ${firstAi}`);
  await solo.keyboard.press('Escape');
  await solo.mouse.move(700, 880);
  await sleep(solo, 300);
  const dusk = { part: await text(solo, '#clock [data-f="part"]'), px: await housePixels(solo, [plan.lot, plan.next], vermilion) };
  check(dusk.part === 'Twilight' && dusk.px >= 120, 'ownership stays bright at dusk: House-vermilion banner and kerb pixels survive the twilight grade', `${dusk.part}: ${dusk.px} vermilion pixels around lots ${plan.lot}+${plan.next}`);
  await solo.screenshot({ path: `${OUT}/05-twilight-ownership.png` });

  // Shop Inspector diagnosis, Crown breakdown.
  const rowTitle = await solo.evaluate(() => document.querySelector('#board .row')?.getAttribute('title') ?? '');
  await solo.click('#board [data-act="breakdown"]');
  const parts = await solo.evaluate(() => [...document.querySelectorAll('#board .row')].map((r) => ({ crown: Number(r.querySelector('[data-f="crown"]').textContent), nums: [...r.querySelectorAll('.parts b')].map((b) => Number(b.textContent)), shown: getComputedStyle(r.querySelector('.parts')).display !== 'none' })));
  const mlist = await solo.evaluate(() => [...document.querySelectorAll('#board .mlist .ml')].map((el) => `${el.classList.contains('done') ? '★' : '·'}${el.querySelector('b').textContent}`));
  check(/Crown \d+ = Worth \d+ .* \+ Share -?\d+ .* \+ Prestige \d+/.test(rowTitle) && parts.every((p) => p.shown && p.nums.length === 3 && p.nums[0] + p.nums[1] + p.nums[2] === p.crown), 'leaderboard breaks every Crown Index into Worth + Share + Prestige (tooltip and toggle)', parts.map((p) => `${p.nums.join('+')}=${p.crown}`).join('  '));
  check(mlist.length === 4 && mlist.includes('★Block Baron'), 'the expanded breakdown lists all four Dynasty Milestones', mlist.join(' '));
  await solo.click('#board [data-act="breakdown"]');

  // Destructive Leave needs two clicks.
  await solo.click('#clock [data-act="leave"]');
  await sleep(solo, 200);
  const afterOne = { phase: (await info(solo)).phase, label: await text(solo, '#clock [data-act="leave"]') };
  check(afterOne.phase === 'playing' && afterOne.label === 'Leave?', 'one click on Leave only arms it: the match goes on', `phase=${afterOne.phase} label="${afterOne.label}"`);
  await sleep(solo, 4200);
  const lapsed = { phase: (await info(solo)).phase, label: await text(solo, '#clock [data-act="leave"]') };
  check(lapsed.phase === 'playing' && lapsed.label === '', 'the Leave confirmation lapses after four seconds', `phase=${lapsed.phase} label="${lapsed.label}"`);

  // ── Era Council (solo) ──
  await solo.keyboard.press('1'); // an armed tool must not survive into the Council
  const hold = await warpBy(solo, 5000, { hold: true, log });
  await solo.waitForFunction(() => !document.getElementById('council').hidden, null, { timeout: 5000 });
  const c0 = await solo.evaluate(() => {
    const m = window.__mercadia;
    const card = document.querySelector('#council .council');
    const r = card.getBoundingClientRect();
    return {
      phase: m.state().phase, tick: m.state().tick, era: m.era, tool: m.tool, council: m.council(),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      centred: Math.abs((r.left + r.right) / 2 - innerWidth / 2) < 12 && Math.abs((r.top + r.bottom) / 2 - innerHeight / 2) < 60,
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && card.scrollWidth <= card.clientWidth + 1,
      title: card.querySelector('h2').textContent,
      unlocks: [...card.querySelectorAll('.unlock')].map((u) => u.dataset.kind),
      rows: [...card.querySelectorAll('.srow')].map((row) => ({ p: Number(row.dataset.p), crest: row.querySelector('.hcrest')?.dataset.crest ?? '', crown: row.querySelector('.cr').textContent, delta: row.querySelector('.dl').textContent, pick: row.querySelector('[data-f="pick"]').dataset.key ?? '' })),
      cards: [...card.querySelectorAll('.charter')].map((b) => ({ key: b.dataset.key, name: b.querySelector('.ch-name').textContent, pill: b.querySelector('.ch-pill').textContent, sealed: b.classList.contains('sealed') })),
      advance: card.querySelector('[data-act="advance"]')?.disabled,
      advanceText: card.querySelector('[data-act="advance"]')?.textContent ?? '',
      focus: document.activeElement === card,
      part: document.querySelector('#clock [data-f="part"]').textContent,
    };
  });
  check(hold.phase === 'council' && c0.phase === 'council' && c0.tick === 1500 && c0.era === 1 && c0.council.era === 1 && c0.council.next === 2, 'warp(n, hold) stops exactly at the Era I close with the Era Council in session', `tick ${c0.tick}, phase ${c0.phase}`);
  check(c0.centred && c0.inView && c0.title === 'Era II: Transit & Trade' && c0.focus && c0.tool === null && c0.part === 'Era Council', 'the Era Council modal is a centred, unclipped card that takes focus itself and drops the armed tool', `card [${c0.rect.join(', ')}] "${c0.title}"`);
  check(c0.unlocks.join() === 'arcade,nightmarket,tramstop', 'the Council celebrates the newly unlocked tier', c0.unlocks.join(', '));
  check(c0.rows.length === 4 && new Set(c0.rows.map((r) => r.crest)).size === 4 && c0.rows.every((r) => /^\d+$/.test(r.crown) && /^[+−]\d+$/.test(r.delta)) && c0.rows.filter((r) => r.p !== 0).every((r) => r.pick !== '') && c0.rows.find((r) => r.p === 0).pick === '', 'Era standings: four Houses with crests, Crown and era deltas; the AI Houses have sealed their charters', c0.rows.map((r) => `${r.crest} ${r.crown} ${r.delta} ${r.pick || 'deliberating'}`).join(' | '));
  check(c0.cards.length === 3 && new Set(c0.cards.map((c) => c.key)).size === 3 && c0.cards.every((c) => !c.sealed && c.pill.length > 8) && c0.cards.map((c) => c.key).join() === c0.council.offers[0].join() && c0.advance === true && c0.advanceText === 'Advance to Era II', 'exactly three distinct Dynasty Charters are offered, and Advance waits for a choice', c0.cards.map((c) => `${c.name} [${c.pill}]`).join(' · '));
  await solo.screenshot({ path: `${OUT}/06-era-council.png` });
  // The city is paused and the Council owns the keyboard.
  await sleep(solo, 1300);
  for (const key of ['1', '2', 'Space', 'Escape']) await solo.keyboard.press(key);
  await solo.evaluate(() => document.querySelector('#dock [data-kind="roastery"]').click());
  const paused = await solo.evaluate(() => ({ tick: window.__mercadia.state().tick, tool: window.__mercadia.tool, open: !document.getElementById('council').hidden, paused: window.__mercadia.paused }));
  check(paused.tick === 1500 && paused.tool === null && paused.open && paused.paused === false, 'the Council pauses the simulation cleanly: the tick holds, hotkeys do nothing, no tool can be armed, Esc does not close it', `tick ${paused.tick} after 1.3 s, tool=${paused.tool}`);
  // Choose deterministically from what is on offer, preferring a charter whose effect shows in the HUD.
  const pickKey = ['transit', 'credit', 'artisanry', 'heralds', 'provisioners', 'canal'].find((k) => c0.council.offers[0].includes(k));
  await solo.click(`#council .charter[data-key="${pickKey}"]`);
  await solo.waitForFunction((k) => window.__mercadia.council()?.picks[0] === k, pickKey, { timeout: 3000 });
  const sealed = await solo.evaluate(() => ({ sealed: [...document.querySelectorAll('#council .charter.sealed')].map((b) => b.dataset.key).join(), pressed: document.querySelector('#council .charter.sealed')?.getAttribute('aria-pressed'), mine: document.querySelector('#council .srow.me [data-f="pick"]').dataset.key, advance: document.querySelector('#council [data-act="advance"]').disabled, tick: window.__mercadia.state().tick }));
  check(sealed.sealed === pickKey && sealed.pressed === 'true' && sealed.mine === pickKey && sealed.advance === false && sealed.tick === 1500, 'choosing a charter seals the card and enables Advance (still paused)', `sealed ${sealed.sealed}`);
  await solo.click('#council [data-act="advance"]');
  await solo.waitForFunction(() => window.__mercadia.state().phase === 'playing' && document.getElementById('council').hidden, null, { timeout: 4000 });
  await collect(solo, log);
  const after = await solo.evaluate(() => ({ era: window.__mercadia.era, chip: document.querySelector('#clock [data-f="era"]').textContent.trim(), badges: [...document.querySelectorAll('#treasury .charters .cbadge')].map((b) => b.dataset.key).join(), charters: window.__mercadia.charters, unlocks: window.__mercadia.unlocks.join(), locks: [...document.querySelectorAll('#dock .tool[data-locked]')].map((b) => `${b.dataset.kind}:${b.querySelector('.lock').textContent.trim()}`).join(' '), tick: window.__mercadia.state().tick }));
  check(after.era === 2 && after.chip === 'Era II · Transit' && after.badges === pickKey && after.charters[0].charters.join() === pickKey && after.charters.every((c) => c.charters.length === 1), 'Advance begins Era II: every House holds one charter and mine is badged on the Treasury', `${after.chip} · ${after.charters.map((c) => `${c.house}:${c.names[0]}`).join(' ')}`);
  const eraDispatch = [...log.values()].find((d) => d.cat === 'era' && d.head === 'Era II: Transit & Trade');
  const charterDispatch = [...log.values()].find((d) => d.cat === 'charter' && d.player === 0);
  check(!!eraDispatch && eraDispatch.pill === 'Era II Unlocked' && eraDispatch.tier === 1 && !!charterDispatch && /^Vermilion adopts /.test(charterDispatch.head) && charterDispatch.pill.length > 8, 'the Chronicle prints the era transition (Era II Unlocked) and my charter adoption', `"${eraDispatch?.head}" [${eraDispatch?.pill}] · "${charterDispatch?.head}" [${charterDispatch?.pill}]`);
  check(after.unlocks === 'roastery,bistro,arcade,nightmarket,park,tramstop' && after.locks === 'boutique:Era III cinema:Era III plaza:Era III', 'Era II unlocks Arcade, Nightmarket and Tram Stop; the Era III tools stay locked', `unlocked ${after.unlocks} · ${after.locks}`);

  // The charter's mechanical effect is real.
  await solo.click('#clock [data-act="pause"]');
  const lotScreen = await solo.evaluate((t) => window.__mercadia.tileScreen(t), plan.lot);
  if ((await state(solo)).players[0].cash < 700) {
    await solo.click('#treasury [data-act="borrow"]');
    await solo.click('#treasury [data-act="borrow"]');
  }
  await solo.keyboard.press('Escape');
  await solo.mouse.click(lotScreen.x, lotScreen.y - 4);
  await solo.waitForFunction((t) => window.__mercadia.selectedTile === t && !document.getElementById('inspector').hidden, plan.lot, { timeout: 3000 });
  const fxText = await solo.evaluate(() => ({ park: document.querySelector('#dock [data-kind="park"] [data-f="cost"]').textContent, stop: document.querySelector('#dock [data-kind="tramstop"] [data-f="cost"]').textContent, rate: document.querySelector('#treasury [data-f="rate"]').textContent, up: document.querySelector('#inspector [data-f="upgrade"]').textContent, promo: document.querySelector('#inspector [data-f="promo"]').textContent, restock: document.querySelector('#inspector [data-f="restock"]').textContent, stock: document.querySelector('#inspector [data-f="stock"]').textContent, level: window.__mercadia.state().buildings.find((b) => b.id && b.tile === window.__mercadia.selectedTile).level }));
  const [stockNow, stockMax] = fxText.stock.split('/').map(Number);
  const effect = {
    transit: () => [fxText.park === '§120' && fxText.stop === '§180', `Park ${fxText.park}, Tram Stop ${fxText.stop} (−25%)`],
    credit: () => [/9%\/era/.test(fxText.rate), `Borrow rate${fxText.rate} (halved from 18%/era)`],
    artisanry: () => [fxText.level === 1 ? /§86/.test(fxText.up) : /§130/.test(fxText.up) || /Level 3/.test(fxText.up), `upgrade button "${fxText.up}" (−20%)`],
    heralds: () => [/§60/.test(fxText.promo) || /running|ready in/.test(fxText.promo), `promo button "${fxText.promo}" (−25% of §80)`],
    provisioners: () => [stockNow >= stockMax || fxText.restock.includes(`§${Math.ceil(Math.round((stockMax - stockNow) * 3 * 0.85 * 100) / 100)}`), `restock "${fxText.restock}" for ${stockMax - stockNow} units at §3 −15%`],
    canal: () => [true, 'Canal Showcase has no price tag in the HUD (its quality effect is asserted in Vitest)'],
  }[pickKey]();
  check(effect[0], `the adopted charter (${pickKey}) changes real numbers`, effect[1]);

  // Era II tools are buildable now: a Tram Stop along the avenue, with its blueprint hints.
  await solo.keyboard.press('Escape');
  await solo.click('#dock [data-kind="tramstop"]');
  const tramHint = await text(solo, '#dock .hint');
  const inland = await freeLot(solo, false);
  await solo.mouse.move(inland.x, inland.y);
  await sleep(solo, 200);
  const inlandCard = await text(solo, '#lotcard');
  const avenue = await freeLot(solo, true);
  await solo.mouse.move(avenue.x, avenue.y);
  await sleep(solo, 200);
  const avenueCard = await text(solo, '#lotcard');
  check(/Place along the tramway avenue/.test(tramHint) && /Place along the tramway avenue/.test(inlandCard) && /\+Tram Footfall to \d+ lots?/.test(avenueCard), 'Tram Stop: avenue hint, inland lots refused before any click, the footfall it will bring', `inland: "${inlandCard.replace(/\s+/g, ' ').slice(0, 70)}" · avenue: "${avenueCard.replace(/\s+/g, ' ').slice(0, 70)}"`);
  await solo.screenshot({ path: `${OUT}/07-tramstop-blueprint.png` });
  const cashStop = (await state(solo)).players[0].cash;
  await solo.mouse.click(avenue.x, avenue.y);
  await built(solo, avenue.t, 'tramstop');
  const paidStop = cashStop - (await state(solo)).players[0].cash;
  check(paidStop === (pickKey === 'transit' ? 180 : 240), 'an Era II tool builds once unlocked: a Tram Stop on the avenue at the charter-aware price', `paid §${paidStop}`);
  await solo.keyboard.press('Escape');

  // Level 3 waits for Era III.
  await solo.mouse.click(lotScreen.x, lotScreen.y - 4);
  await solo.waitForFunction((t) => window.__mercadia.selectedTile === t, plan.lot, { timeout: 3000 });
  if (fxText.level === 1) {
    await solo.click('#inspector [data-act="upgrade"]');
    await solo.waitForFunction((t) => window.__mercadia.state().buildings.find((b) => b.tile === t)?.level === 2, plan.lot, { timeout: 4000 });
  }
  await solo.waitForFunction(() => document.querySelector('#inspector [data-f="upgrade"]')?.dataset.state === 'locked', null, { timeout: 4000 });
  const up2 = await solo.evaluate(() => { const b = document.querySelector('#inspector [data-f="upgrade"]'); return { state: b.dataset.state, text: b.textContent.trim(), disabled: b.disabled }; });
  check(up2.state === 'locked' && up2.disabled && up2.text === 'Level 3 unlocks in Era III: Grand Boulevard', 'Level 3 is locked before Era III and says so on the upgrade button', `"${up2.text}"`);
  await solo.keyboard.press('Escape');

  // ── warp() runs cleanly through an Era Council ──
  const w0 = await state(solo);
  const through = await warpBy(solo, 3000 - w0.tick + 200, { log });
  const w1 = await solo.evaluate(() => ({ s: window.__mercadia.state(), council: window.__mercadia.council(), open: !document.getElementById('council').hidden, charters: window.__mercadia.charters }));
  check(through.moved === 3000 - w0.tick + 200 && w1.s.tick === 3200 && w1.s.phase === 'playing' && w1.s.era === 3 && w1.council === null && !w1.open && w1.charters.every((c) => c.charters.length === 2 && new Set(c.charters).size === 2), 'plain warp(n) is deterministic through the Era II Council: exact tick count, steward-adopted charters, no Council left open', `warped ${through.moved} ticks → tick ${w1.s.tick}, era ${w1.s.era}; mine: ${w1.charters[0].names.join(' + ')}`);
  const lock3 = await solo.evaluate(() => ({ locked: window.__mercadia.locked.length, badges: document.querySelectorAll('#dock .tool[data-locked]').length }));
  check(lock3.locked === 0 && lock3.badges === 0, 'Era III unlocks the whole dock', `locked tools: ${lock3.locked}`);
  // Level 3 opens with the Grand Boulevard.
  if ((await state(solo)).players[0].cash < 300) await solo.click('#treasury [data-act="borrow"]');
  await solo.mouse.click(lotScreen.x, lotScreen.y - 4);
  await solo.waitForFunction((t) => window.__mercadia.selectedTile === t, plan.lot, { timeout: 3000 });
  const up3 = await solo.evaluate(() => { const b = document.querySelector('#inspector [data-f="upgrade"]'); return { state: b.dataset.state, text: b.textContent.trim(), disabled: b.disabled }; });
  await solo.click('#inspector [data-act="upgrade"]');
  await solo.waitForFunction((t) => window.__mercadia.state().buildings.find((b) => b.tile === t)?.level === 3, plan.lot, { timeout: 4000 });
  check(up3.state === 'open' && /Upgrade to Lv 3/.test(up3.text) && !up3.disabled, 'Level 3 grand architecture is available in Era III and the upgrade goes through', `"${up3.text}" → Level 3`);
  await solo.keyboard.press('Escape');
  await solo.click('#clock [data-act="pause"]'); // resume

  // ── Milestones, ledger, heraldry in Era III–IV ──
  await warpBy(solo, 4700 - (await state(solo)).tick, { log });
  await solo.click('#clock [data-act="pause"]');
  await sleep(solo, 300);
  const dyn = await solo.evaluate(() => ({ ms: window.__mercadia.milestones, era: window.__mercadia.era, prog: document.querySelector('#board [data-f="mprog"]').textContent.replace(/\s+/g, ' ').trim(), progHidden: document.querySelector('#board [data-f="mprog"]').hidden }));
  const rows = await boardCrests(solo);
  check(crestsOk(rows, HOUSE_CREST), 'heraldry: every leaderboard row flies its own crest — Compass, Anchor, Sunburst Crown, Laurel Arch', rows.map((r) => `${r.house}:${r.crest}`).join(' '));
  check(dyn.era === 4 && dyn.ms[0].earned.includes('merchant') && dyn.ms[0].earned.includes('baron') && dyn.ms.every((m) => m.stars === m.earned.length) && rows.every((r) => r.stars === dyn.ms[r.p].stars), 'Dynasty Milestones: earned keys are exposed and each House’s brass stars match on the leaderboard', dyn.ms.map((m) => `${m.house} ★${m.stars} (${m.earned.join(',')})`).join(' · '));
  check(!dyn.progHidden && dyn.prog.length > 8, 'the Milestone progress pill tracks my next milestone', dyn.prog);
  await solo.click('#treasury [data-act="ledger"]');
  await sleep(solo, 200);
  const ledger = await solo.evaluate(() => {
    const num = (s) => Number((s ?? '').replace(/[^0-9]/g, '')) * (/−/.test(s ?? '') ? -1 : 1);
    const div = document.querySelector('#ledger tr[data-k="dividends"]');
    return {
      text: document.getElementById('ledger').textContent.replace(/\s+/g, ' '),
      heads: [...document.querySelectorAll('#ledger thead th')].map((th) => th.textContent.trim()).join('|'),
      dividendLabel: div?.querySelector('td')?.textContent ?? '',
      dividends: num(div?.querySelector('td:last-child')?.textContent),
      recon: num(document.querySelector('#ledger .recon b')?.textContent),
      cash: num(document.querySelector('#treasury [data-f="cash"]')?.textContent),
      state: window.__mercadia.state().players[0].cash,
    };
  });
  const dueDividends = (dyn.ms[0].earned.includes('merchant') ? 80 : 0) + (dyn.ms[0].earned.includes('benefactor') ? 120 : 0);
  check(/Financing/.test(ledger.text) && /Loan draws/.test(ledger.text) && /Loan repayments/.test(ledger.text) && /Change in cash/.test(ledger.text) && /This era/.test(ledger.heads) && /Last era/.test(ledger.heads), 'the Ledger reads era by era and shows Financing: loan draws, repayments, change in cash', ledger.heads);
  check(/Milestone dividends/.test(ledger.dividendLabel) && ledger.dividends === dueDividends && dueDividends >= 80, 'Milestone dividends are booked on their own Ledger line (Charter Merchant §80, Civic Benefactor §120)', `ledger says §${ledger.dividends}, earned ${dyn.ms[0].earned.join(',')}`);
  check(ledger.recon === ledger.cash && ledger.cash === ledger.state, 'opening cash + ledger equals cash in hand to the exact §', `ledger §${ledger.recon} = wallet §${ledger.cash}`);
  await solo.click('#ledger [data-act="close"]');
  await solo.click('#clock [data-act="pause"]');
  await collect(solo, log);
  if (!(await solo.evaluate(() => document.getElementById('chronicle').classList.contains('open')))) await solo.click('#chronicle [data-act="feed"]');
  await sleep(solo, 300);
  const lay4 = await layout(solo);
  check(lay4.coverage <= 15 && lay4.clipped.length === 0 && lay4.overlaps.length === 0, 'Era IV, feed open, three charter badges: the HUD still leaves ≥ 85% to the city, unclipped', `HUD union covers ${lay4.coverage.toFixed(2)}%`);
  await solo.screenshot({ path: `${OUT}/08-era4-chronicle.png` });

  // ── Final bell: the Final Edition, with the hotkey lock and rematch cleanup ──
  await solo.keyboard.press('2'); // arm a tool just before the bell
  const fin = await warpBy(solo, 2000, { log });
  await solo.waitForFunction(() => !document.getElementById('victory').hidden, null, { timeout: 8000 });
  const atBell = await info(solo);
  for (const key of ['1', '2', '7', 'Space']) await solo.keyboard.press(key);
  const underModal = await info(solo);
  check(fin.phase === 'ended' && fin.tick === 6000 && atBell.tool === null && underModal.tool === null, 'Era IV closes at tick 6000: the final bell disarms the build tool and the Final Edition swallows hotkeys', `tick ${fin.tick}; tool at bell=${atBell.tool}, after 1/2/7/Space=${underModal.tool}`);
  const cats = new Set([...log.values()].map((d) => d.cat));
  const events = [...log.values()].filter((d) => d.cat === 'event');
  const lead = [...log.values()].find((d) => d.cat === 'lead');
  const eraHeads = [...log.values()].filter((d) => d.cat === 'era').map((d) => d.head);
  check(['era', 'milestone', 'charter', 'lead', 'event', 'build'].every((c) => cats.has(c)) && (cats.has('promo') || cats.has('rival')), 'over one match the Chronicle fired every kind of dispatch: era, charter, milestone, lead change, city event, build, rivalry', `${log.size} dispatches · ${[...cats].join(', ')}`);
  check(!!lead && lead.pill === 'New Leader' && lead.player >= 0, 'a Crown Index lead change is a "New Leader" dispatch', lead ? `"${lead.head}"` : 'none');
  check(events.some((d) => /^Forecast: /.test(d.head)) && events.some((d) => /closed|passed|ended|lifted|eased|Golden Fork/.test(d.head)) && events.some((d) => /[+×−]\d|§\d/.test(d.pill)), 'city events are forecast, started and receipted with mechanical pills', events.slice(0, 4).map((d) => `"${d.head}" [${d.pill}]`).join(' · '));
  check(['Era I: Founding Charter', 'Era II: Transit & Trade', 'Era III: Grand Boulevard', 'Era IV: Golden Dynasty'].every((h) => eraHeads.includes(h)), 'all four Eras were announced: Founding Charter → Transit & Trade → Grand Boulevard → Golden Dynasty', eraHeads.join(' → '));
  const edition = await solo.evaluate(() => {
    const v = document.querySelector('#victory .victory');
    const eq = [...v.querySelectorAll('.equation b')].map((b) => Number(b.textContent));
    const st = window.__mercadia.state();
    const top = st.players.map((p, i) => ({ i, crown: p.crown, house: p.house })).sort((a, b) => b.crown - a.crown || a.i - b.i)[0];
    return {
      mast: v.querySelector('.m-name')?.textContent ?? '',
      crest: v.querySelector('.crest.grand')?.dataset.crest ?? '',
      winner: top.house,
      eq,
      lines: v.querySelectorAll('svg.spark polyline').length,
      dots: v.querySelectorAll('svg.spark circle').length,
      axis: [...v.querySelectorAll('svg.spark .ax')].map((t) => t.textContent).filter((t) => /^[IV]+$/.test(t)).join(' '),
      rows: v.querySelectorAll('table tbody tr').length,
      rowCrests: v.querySelectorAll('table tbody td .hcrest').length,
      rowStars: v.querySelectorAll('table tbody .mstars').length,
      charters: v.querySelectorAll('table tbody em.chs').length,
      highlight: v.querySelector('.highlight')?.textContent ?? '',
      awards: v.querySelectorAll('.award').length,
      rematch: !!v.querySelector('[data-act="rematch"]:not([disabled])'),
      endless: !!v.querySelector('[data-act="endless"]:not([disabled])'),
      fits: v.scrollWidth <= v.clientWidth + 1,
      allCharters: window.__mercadia.charters.every((c) => c.charters.length === 3),
    };
  });
  check(edition.mast === 'The Mercadia Gazette' && edition.crest === HOUSE_CREST[edition.winner] && edition.eq.length === 4 && edition.eq[0] + edition.eq[1] + edition.eq[2] === edition.eq[3] && edition.lines === 4 && edition.dots === 4 && edition.rows === 4 && edition.highlight.length > 10 && edition.awards === 3 && edition.rematch && edition.endless && edition.fits, 'Final Edition: masthead, the winning House’s crest, exact Crown equation, share chart, headline, honours, Rematch + Endless', `${edition.winner} (${edition.crest}) · ${edition.eq.slice(0, 3).join(' + ')} = ${edition.eq[3]} · "${edition.highlight}"`);
  check(edition.axis === 'I II III IV' && edition.rowCrests === 4 && edition.rowStars === 4 && edition.charters === 4 && edition.allCharters, 'Final Edition: the chart is labelled era by era (I–IV) and every House shows crest, stars and its three charters', `axis ${edition.axis}`);
  await solo.screenshot({ path: `${OUT}/09-final-edition.png` });
  await solo.click('#victory [data-act="rematch"]');
  await solo.waitForFunction(() => document.getElementById('victory').hidden && !window.__mercadia.state().ended && window.__mercadia.state().tick < 40, null, { timeout: 5000 });
  const reborn = await solo.evaluate(() => ({ tool: window.__mercadia.tool, buildings: window.__mercadia.state().buildings.length, era: window.__mercadia.era, guide: document.getElementById('guide').hidden, g: window.__mercadia.guide(), charters: window.__mercadia.charters.map((c) => c.charters.length).join(''), locked: window.__mercadia.locked.length }));
  check(reborn.tool === null && reborn.buildings === 0 && reborn.era === 1 && reborn.charters === '0000' && reborn.locked === 6, 'Rematch starts a clean Era I district with nothing armed, no charters and the locks back on', `tool=${reborn.tool}, era ${reborn.era}`);
  check(reborn.guide && reborn.g.dismissed && !reborn.g.visible, 'the retired Founding Guide does not come back in the next match', `guide hidden=${reborn.guide}`);
  await solo.keyboard.press('1');
  const full = await warpBy(solo, 9000);
  await solo.waitForFunction(() => !document.getElementById('victory').hidden, null, { timeout: 8000 });
  check(full.phase === 'ended' && full.tick === 6000, 'one plain warp plays a whole match — three Era Councils and four Eras — to the Final Edition', `ended at tick ${full.tick}`);
  await solo.click('#victory [data-act="endless"]');
  await solo.waitForFunction(() => document.getElementById('victory').hidden && !window.__mercadia.state().ended, null, { timeout: 5000 });
  const onward = await state(solo);
  const beyond = await warpBy(solo, 1700);
  const far = await solo.evaluate(() => ({ s: window.__mercadia.state(), chip: document.querySelector('#clock [data-f="era"]').textContent.trim(), of: document.querySelector('#clock [data-f="eraof"]').textContent.trim(), council: window.__mercadia.council(), open: !document.getElementById('council').hidden }));
  check((await info(solo)).tool === null && onward.quarter === 5 && onward.era === 4 && beyond.phase === 'playing' && far.s.quarter === 6 && far.s.era === 4 && far.council === null && !far.open && far.chip === 'Era IV · Golden', 'Continue in Endless plays on past Era IV with nothing armed and no further Council', `quarter ${onward.quarter} → ${far.s.quarter}, "${far.chip}" ${far.of}`);

  // Leave: two deliberate clicks.
  await solo.click('#clock [data-act="leave"]');
  await solo.waitForFunction(() => document.querySelector('#clock [data-act="leave"]')?.textContent?.trim() === 'Leave?');
  await solo.click('#clock [data-act="leave"]');
  await solo.waitForFunction(() => window.__mercadia.phase === 'title');
  ok('a second click on Leave returns to the title');
  await solo.context().close();
}

// ───────────────────────────── Founding Guide: dismiss; Blitz ─────────────────────────────
if (wants('guide')) {
  console.log('Guide dismiss · Blitz');
  const g = await open('guide');
  await g.click('#title [data-act="mode"][data-v="blitz"]');
  const blurb = await text(g, '#title .modeblurb');
  await g.click('#title [data-act="solo"]');
  await g.waitForFunction(() => window.__mercadia.phase === 'playing' && !document.getElementById('guide').hidden);
  const blitz = await g.evaluate(() => ({ mode: window.__mercadia.state().mode, of: document.querySelector('#clock [data-f="eraof"]').textContent.trim(), rate: document.querySelector('#treasury [data-act="borrow"]').textContent.replace(/\s+/g, ' ').trim(), buildings: window.__mercadia.state().buildings.length }));
  check(/4 brisk eras/.test(blurb) && blitz.mode === 'blitz' && blitz.of === 'of IV' && /7\.9%\/era/.test(blitz.rate) && blitz.buildings === 0, 'Blitz is four brisk eras too, with its own exact per-era loan rate', `"${blurb}" · ${blitz.rate}`);
  await g.click('#guide [data-act="dismiss"]');
  const gone = await g.evaluate(() => ({ hidden: document.getElementById('guide').hidden, stored: localStorage.getItem('mercadia:guide'), g: window.__mercadia.guide(), guided: document.querySelectorAll('#dock .tool.guided').length }));
  check(gone.hidden && gone.stored === 'done' && gone.g.dismissed && gone.g.lots.length === 0 && gone.guided === 0, 'the Founding Guide is dismissed with one click: bar, rings and dock pointers all go, and it is persisted', `mercadia:guide=${gone.stored}`);
  // Blitz: all four eras and three Councils in one warp.
  const eras = [];
  for (let i = 0; i < 3; i++) {
    const r = await warpBy(g, 2000, { hold: true });
    eras.push(`${r.phase}@${r.tick}`);
    const key = await g.evaluate(() => window.__mercadia.council().offers[0][0]);
    await g.click(`#council .charter[data-key="${key}"]`);
    await g.click('#council [data-act="advance"]');
    await g.waitForFunction(() => window.__mercadia.state().phase === 'playing', null, { timeout: 4000 });
  }
  const end = await warpBy(g, 2000);
  await g.waitForFunction(() => !document.getElementById('victory').hidden, null, { timeout: 8000 });
  check(eras.join() === 'council@660,council@1320,council@1980' && end.phase === 'ended' && end.tick === 2640 && (await hook(g, 'charters'))[0].charters.length === 3, 'a Blitz match runs Era I → IV with a Council after Eras I, II and III (66 s eras)', `${eras.join(' → ')} → ended@${end.tick}`);
  await g.click('#victory [data-act="leave"]');
  await g.waitForFunction(() => window.__mercadia.phase === 'title');
  await g.click('#title [data-act="solo"]');
  await g.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.state().tick < 60);
  await sleep(g, 400);
  check(await g.evaluate(() => document.getElementById('guide').hidden && window.__mercadia.guide().lots.length === 0), 'a dismissed guide stays dismissed in the next match');
  await g.context().close();
}

// ───────────────────────────── Dev hook gating on a non-local hostname ─────────────────────────────
if (wants('dev')) {
  console.log('Dev hook');
  const pub = await open('public-host', `http://mercadia.test:${PORT}/`);
  await pub.click('#title [data-act="solo"]');
  await pub.waitForFunction(() => window.__mercadia.phase === 'playing');
  const gate = await pub.evaluate(() => {
    const m = window.__mercadia;
    const before = m.state().tick;
    const ret = m.warp(500);
    const focus = m.focus(40);
    return { dev: m.dev, ret, focus, jumped: m.state().tick - before, host: location.hostname, era: m.era, chronicle: m.chronicle().length };
  });
  check(gate.dev === false && gate.ret === false && gate.focus === false && gate.jumped < 50, 'warp() and focus() are inert on a non-local host', `${gate.host}: dev=${gate.dev} warp→${gate.ret} tick moved ${gate.jumped}`);
  check(gate.era === 1 && gate.chronicle >= 1, 'the read-only window (era, chronicle, …) still answers there', `era ${gate.era}, ${gate.chronicle} dispatch(es)`);
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
}

// ───────────────────────────── Phone: 390×844, touch ─────────────────────────────
if (wants('mobile')) {
  console.log('Mobile 390×844');
  const phone = await open('phone', '/', PHONE);
  await phone.tap('#title [data-act="solo"]');
  await phone.waitForFunction(() => window.__mercadia.phase === 'playing');
  await sleep(phone, 400);
  const span = await phone.evaluate(() => window.__mercadia.islandSpan());
  check(span.left >= 0 && span.right <= span.width, 'portrait Fit view shows both island tips with no cropping', `tips at x=${span.left.toFixed(1)} and x=${span.right.toFixed(1)} of ${span.width}px`);
  const tabs = await phone.evaluate(() => [...document.querySelectorAll('#docktabs [data-tab]')].map((b) => b.textContent.trim()));
  const shopsShown = await phone.evaluate(() => [...document.querySelectorAll('#dock .tool')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.dataset.kind));
  check(tabs.join('|') === 'Shops (6)|Civic (3)' && (await visible(phone, '#docktabs [data-tab="civic"]')) && shopsShown.length === 6, 'the dock is tabbed: Shops (6) / Civic (3)', `${tabs.join(' / ')} · showing ${shopsShown.join(', ')}`);
  const lockBadges = (kinds) => phone.evaluate((kinds) => kinds.map((k) => { const el = document.querySelector(`#dock [data-kind="${k}"] .lock`); const r = el.getBoundingClientRect(); const cs = getComputedStyle(el.querySelector('b')); return { k, text: el.textContent.trim(), ok: !el.hidden && r.width >= 20 && r.height >= 8 && r.left >= 0 && r.right <= innerWidth && parseFloat(cs.fontSize) >= 8 }; }), kinds);
  const shopsFit = [];
  for (const k of shopsShown) shopsFit.push(await visible(phone, `#dock [data-kind="${k}"]`));
  const shopLocks = await lockBadges(['arcade', 'boutique', 'cinema', 'nightmarket']);
  const mobileGuide = await phone.evaluate(() => {
    const el = document.getElementById('guide');
    const r = el.getBoundingClientRect();
    const tabs = document.getElementById('docktabs').getBoundingClientRect();
    const dock = document.getElementById('dock').getBoundingClientRect();
    return { hidden: el.hidden, step: el.dataset.step, h: r.height, top: r.top, bottom: r.bottom, above: r.bottom <= Math.min(tabs.top, dock.top) + 1, coversCentre: r.top <= innerHeight / 2 && r.bottom >= innerHeight / 2, inView: r.left >= 0 && r.right <= innerWidth, title: el.querySelector('[data-f="gtitle"]').textContent, lots: window.__mercadia.guide().lots.length };
  });
  check(!mobileGuide.hidden && mobileGuide.step === '1' && mobileGuide.h <= 56 && mobileGuide.above && !mobileGuide.coversCentre && mobileGuide.inView && mobileGuide.lots >= 3, 'the Founding Guide is a slim one-line bar above the dock, clear of the city centre', `"${mobileGuide.title}" ${Math.round(mobileGuide.h)}px tall at y=${Math.round(mobileGuide.top)}–${Math.round(mobileGuide.bottom)}`);
  await phone.screenshot({ path: `${OUT}/10-mobile-era1.png` });
  await phone.tap('#docktabs [data-tab="civic"]');
  const civicFit = [];
  for (const k of ['park', 'tramstop', 'plaza']) civicFit.push(await visible(phone, `#dock [data-kind="${k}"]`));
  const civicLocks = await lockBadges(['tramstop', 'plaza']);
  check(shopsFit.every(Boolean) && civicFit.every(Boolean), 'Park, Tram Stop and Plaza are one tap away and fully on screen', `shops on screen ${shopsFit.filter(Boolean).length}/6, civic ${civicFit.filter(Boolean).length}/3`);
  check([...shopLocks, ...civicLocks].every((l) => l.ok) && shopLocks.map((l) => l.text).join() === 'Era II,Era III,Era III,Era II' && civicLocks.map((l) => l.text).join() === 'Era II,Era III', 'Era lock badges stay legible on both dock tabs with no horizontal clipping', [...shopLocks, ...civicLocks].map((l) => `${l.k}:${l.text}`).join(' '));
  await phone.tap('#dock [data-kind="plaza"]');
  const mLock = await phone.evaluate(() => ({ t: document.querySelector('#toasts .toast.lockmsg')?.textContent ?? '', tool: window.__mercadia.tool }));
  check(mLock.t === 'Festival Plaza unlocks in Era III: Grand Boulevard' && mLock.tool === null, 'tapping a locked tool on a phone shows the unlock notice', `"${mLock.t}"`);
  const strip = await phone.evaluate(() => {
    const rows = [...document.querySelectorAll('#board .row')].sort((a, b) => Number(a.style.order) - Number(b.style.order));
    const segs = [...document.querySelectorAll('#board .bar i')].sort((a, b) => Number(a.style.order) - Number(b.style.order));
    return {
      ini: rows.map((r) => r.querySelector('.ini').textContent),
      iniShown: rows.every((r) => getComputedStyle(r.querySelector('.ini')).display !== 'none'),
      crests: rows.map((r) => { const c = r.querySelector('.hcrest'); const q = c.getBoundingClientRect(); return q.width >= 10 && q.left >= 0 && q.right <= innerWidth ? c.dataset.crest : ''; }),
      crowns: rows.every((r) => /^\d+$/.test(r.querySelector('[data-f="crown"]').textContent)),
      oneRow: new Set(rows.map((r) => Math.round(r.getBoundingClientRect().top))).size === 1,
      rowOrder: rows.map((r) => r.dataset.p).join(''),
      segOrder: segs.map((s) => s.dataset.s).join(''),
      rowX: rows.map((r) => Math.round(r.getBoundingClientRect().left)),
      segX: segs.map((s) => Math.round(s.getBoundingClientRect().left)),
    };
  });
  const ascending = (v) => v.every((x, i) => i === 0 || x >= v[i - 1]);
  check(strip.iniShown && strip.ini.includes('You') && strip.ini.includes('Ves') && strip.rowOrder === strip.segOrder && ascending(strip.rowX) && ascending(strip.segX) && strip.oneRow && strip.crowns && new Set(strip.crests.filter(Boolean)).size === 4, 'single-row score strip: four House crests, short names, Crown; the share bar follows its rank order', `${strip.ini.join(' ')} · ${strip.crests.join(' ')} · rows ${strip.rowOrder} / bar ${strip.segOrder}`);
  // Touch blueprint: first tap previews, second tap builds.
  await phone.tap('#dock [data-kind="park"]');
  const p1 = await freeLot(phone);
  await phone.touchscreen.tap(p1.x, p1.y);
  await sleep(phone, 250);
  const previewOnly = !(await state(phone)).buildings.some((b) => b.tile === p1.t);
  const previewCard = await text(phone, '#lotcard');
  await phone.screenshot({ path: `${OUT}/11-mobile-civic-blueprint.png` });
  await phone.touchscreen.tap(p1.x, p1.y);
  await built(phone, p1.t, 'park');
  check(previewOnly && /Park Aura/.test(previewCard) && /tap again/.test(previewCard), 'touch: first tap previews the blueprint and its reach, second tap builds', previewCard.replace(/\s+/g, ' ').slice(0, 90));
  await phone.tap('#docktabs [data-tab="shops"]');
  await phone.tap('#dock [data-kind="roastery"]');
  const p2 = await freeLot(phone);
  await phone.touchscreen.tap(p2.x, p2.y);
  await sleep(phone, 150);
  await phone.touchscreen.tap(p2.x, p2.y);
  await built(phone, p2.t, 'roastery');
  check(await phone.evaluate(() => document.getElementById('inspector').hidden) && (await visible(phone, '#dock [data-kind="bistro"]')), 'after building on a phone the dock stays in reach (no sheet in the way)');
  // Compact Chronicle bar: headline + pill, unclipped; tap expands the recent feed, tap closes it.
  await phone.evaluate(() => window.__mercadia.warp(220));
  await sleep(phone, 400);
  const bar = await phone.evaluate(() => {
    const d = document.querySelector('#chronicle .dispatch');
    const r = d.getBoundingClientRect();
    const head = d.querySelector('.d-head');
    const pill = d.querySelector('.d-pill');
    const board = document.getElementById('board').getBoundingClientRect();
    return { head: head.textContent, pill: pill.textContent, pillShown: !pill.hidden && getComputedStyle(pill).display !== 'none', pillFits: pill.scrollWidth <= pill.clientWidth + 1, size: parseFloat(getComputedStyle(pill).fontSize), h: r.height, under: r.top >= board.bottom - 1, inView: r.left >= 0 && r.right <= innerWidth };
  });
  check(bar.head.length > 6 && bar.pillShown && bar.pillFits && bar.size >= 10 && bar.under && bar.inView && bar.h <= 64, 'the compact Chronicle bar sits under the score strip: one headline and a readable impact pill', `"${bar.head}" [${bar.pill}] at ${bar.size}px, bar ${Math.round(bar.h)}px tall`);
  await phone.tap('#chronicle [data-act="feed"]');
  await phone.waitForFunction(() => document.getElementById('chronicle').classList.contains('open') && !document.getElementById('cfeed').hidden, null, { timeout: 3000 });
  const mFeed = await phone.evaluate(() => { const f = document.getElementById('cfeed'); const r = f.getBoundingClientRect(); return { lines: f.querySelectorAll('.cline').length, inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, fits: [...f.querySelectorAll('.cline')].every((l) => l.getBoundingClientRect().right <= innerWidth + 0.5), stripes: [...f.querySelectorAll('.cline')].every((l) => getComputedStyle(l).borderLeftWidth === '3px') }; });
  await phone.screenshot({ path: `${OUT}/12-mobile-chronicle.png` });
  await phone.tap('#chronicle [data-act="feed"]');
  await phone.waitForFunction(() => !document.getElementById('chronicle').classList.contains('open'), null, { timeout: 3000 });
  check(mFeed.lines >= 2 && mFeed.lines <= 4 && mFeed.inView && mFeed.fits && mFeed.stripes, 'tapping the bar expands the recent Chronicle feed (striped, unclipped) and a second tap puts it away', `${mFeed.lines} lines`);
  const layPhone = await layout(phone);
  check(layPhone.clipped.length === 0 && layPhone.overlaps.length === 0, '390×844: no persistent panel is clipped or overlaps another', `${layPhone.shown.join(' ')} · clipped [${layPhone.clipped}] overlaps [${layPhone.overlaps}]`);
  // Inspector as a bottom sheet.
  const sp = await phone.evaluate((t) => window.__mercadia.tileScreen(t), p2.t);
  await phone.touchscreen.tap(sp.x, sp.y - 3);
  await phone.waitForFunction((t) => window.__mercadia.selectedTile === t && !document.getElementById('inspector').hidden, p2.t, { timeout: 5000 });
  await sleep(phone, 250);
  const sheet = await phone.evaluate((t) => {
    const el = document.getElementById('inspector');
    const r = el.getBoundingClientRect();
    const p = window.__mercadia.tileScreen(t);
    const board = document.getElementById('board').getBoundingClientRect();
    const sell = el.querySelector('[data-act="sell"]');
    sell.scrollIntoView({ block: 'end' });
    const sr = sell.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, h: r.height, scrolls: el.scrollHeight > el.clientHeight, tileY: p.y, tileX: p.x, boardBottom: board.bottom, sellIn: sr.top >= r.top && sr.bottom <= r.bottom + 0.5 && sr.bottom <= innerHeight, vh: innerHeight, crest: el.querySelector('.head .hcrest')?.dataset.crest ?? '', diag: el.querySelector('.diag')?.textContent ?? '' };
  }, p2.t);
  check(sheet.bottom >= sheet.vh - 12 && sheet.h <= sheet.vh * 0.42 + 1 && sheet.sellIn && sheet.tileY > sheet.boardBottom && sheet.tileY < sheet.top && sheet.tileX > 0 && sheet.tileX < 390 && sheet.crest === 'compass' && sheet.diag.length > 8, 'the Inspector is a bottom sheet (≤ 42% tall): crest and diagnosis up top, Sell reachable by scroll, the selected block visible above it', `sheet ${Math.round(sheet.top)}–${Math.round(sheet.bottom)} of ${sheet.vh} (${((sheet.h / sheet.vh) * 100).toFixed(1)}%), block at y=${Math.round(sheet.tileY)}`);
  await phone.screenshot({ path: `${OUT}/13-mobile-sheet.png` });
  await phone.tap('#inspector [data-act="collapse"]');
  const collapsed = await phone.evaluate(() => document.getElementById('inspector').getBoundingClientRect().height);
  check(collapsed < sheet.h, 'the sheet collapses to its summary', `${Math.round(sheet.h)}px → ${Math.round(collapsed)}px`);
  await phone.tap('#inspector [data-act="close"]');
  // A citizen's speech card must not ride into the score strip or the Chronicle bar.
  let card = null;
  for (let attempt = 0; attempt < 6 && !card; attempt++) {
    const walker = await phone.evaluate((skip) => {
      const m = window.__mercadia;
      const top = document.querySelector('#chronicle .dispatch').getBoundingClientRect().bottom;
      const list = m.citizensOnScreen().filter((c) => c.y > top + 20 && c.y < innerHeight - 260 && c.x > 20 && c.x < innerWidth - 20).sort((p, q) => p.y - q.y);
      return list[skip] ?? null;
    }, attempt);
    if (!walker) break;
    await phone.touchscreen.tap(walker.x, walker.y + 4);
    await sleep(phone, 300);
    card = await phone.evaluate(() => {
      const el = document.querySelector('#speech .card');
      if (!el || document.getElementById('speech').hidden) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, boardBottom: document.getElementById('board').getBoundingClientRect().bottom, barBottom: document.querySelector('#chronicle .dispatch').getBoundingClientRect().bottom, below: document.getElementById('speech').classList.contains('below') };
    });
    if (!card) await phone.touchscreen.tap(8, 400);
  }
  check(!!card && card.top >= card.boardBottom && card.top >= card.barBottom && card.left >= 0 && card.right <= 390, 'a citizen’s speech card docks clear of the score strip and the Chronicle bar', card ? `card top ${Math.round(card.top)} ≥ Chronicle bar bottom ${Math.round(card.barBottom)}${card.below ? ' (flipped below the citizen)' : ''}` : 'no citizen could be tapped');
  await phone.touchscreen.tap(8, 400);
  if (!(await phone.evaluate(() => document.getElementById('inspector').hidden))) await phone.tap('#inspector [data-act="close"]');
  // Era Council on a phone: one scrollable column, charter and Advance by tap.
  await phone.evaluate(() => window.__mercadia.warp(5000, true));
  await phone.waitForFunction(() => !document.getElementById('council').hidden, null, { timeout: 5000 });
  await sleep(phone, 300);
  const mCouncil = await phone.evaluate(() => {
    const card = document.querySelector('#council .council');
    const r = card.getBoundingClientRect();
    const cards = [...card.querySelectorAll('.charter')].map((b) => b.getBoundingClientRect());
    return { inView: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5, sideways: card.scrollWidth <= card.clientWidth + 1, column: new Set(cards.map((c) => Math.round(c.left))).size === 1 && cards.every((c, i) => i === 0 || c.top >= cards[i - 1].bottom - 1), tap: Math.min(...cards.map((c) => c.height)), n: cards.length, phase: window.__mercadia.state().phase, guide: document.getElementById('guide').hidden };
  });
  check(mCouncil.phase === 'council' && mCouncil.inView && mCouncil.sideways && mCouncil.n === 3 && mCouncil.column && mCouncil.tap >= 44 && mCouncil.guide, 'the Era Council stacks into one column of large tap targets inside the phone screen (and the guide has retired)', `3 cards, shortest ${Math.round(mCouncil.tap)}px`);
  await phone.screenshot({ path: `${OUT}/14-mobile-council.png` });
  const mKey = await phone.evaluate(() => window.__mercadia.council().offers[0][1]);
  await phone.tap(`#council .charter[data-key="${mKey}"]`);
  await phone.waitForFunction((k) => window.__mercadia.council()?.picks[0] === k, mKey, { timeout: 3000 });
  await phone.tap('#council [data-act="advance"]');
  await phone.waitForFunction(() => window.__mercadia.state().phase === 'playing' && window.__mercadia.era === 2 && document.getElementById('council').hidden, null, { timeout: 4000 });
  const mEra2 = await phone.evaluate(() => ({ badge: document.querySelector('#treasury .charters .cbadge')?.dataset.key ?? '', chip: document.querySelector('#clock [data-f="era"]').textContent.trim(), arcade: document.querySelector('#dock [data-kind="arcade"]').dataset.locked ?? '' }));
  const layPhone2 = await layout(phone);
  check(mEra2.badge === mKey && /^Era II/.test(mEra2.chip) && mEra2.arcade === '' && layPhone2.clipped.length === 0 && layPhone2.overlaps.length === 0, 'by tap: charter sealed, Advance to Era II, the badge on the Treasury, the Arcade unlocked — still nothing clipped', `${mKey} · "${mEra2.chip}"`);
  await phone.screenshot({ path: `${OUT}/15-mobile-play.png` });
  await phone.evaluate(() => window.__mercadia.warp(6100));
  await phone.waitForFunction(() => !document.getElementById('victory').hidden, null, { timeout: 8000 });
  const mEdition = await phone.evaluate(() => { const v = document.querySelector('#victory .victory'); const r = v.getBoundingClientRect(); const b = v.querySelector('[data-act="rematch"]'); return { fits: v.scrollWidth <= v.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth, lines: v.querySelectorAll('svg.spark polyline').length, btn: b.getBoundingClientRect().height, crest: !!v.querySelector('.crest.grand') }; });
  check(mEdition.fits && mEdition.lines === 4 && mEdition.btn >= 44 && mEdition.crest, 'the Final Edition fits a 390px screen with no sideways scroll', `overflow-free=${mEdition.fits}, Rematch button ${Math.round(mEdition.btn)}px tall`);
  await phone.screenshot({ path: `${OUT}/16-mobile-final-edition.png` });
  await phone.context().close();
}

// ───────────────────────────── Multiplayer: browser contexts sharing one room ─────────────────────────────
if (wants('multi')) {
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
  await a.click('#lobby [data-act="mode"][data-v="blitz"]');
  await b.waitForFunction(() => window.__mercadia.lobby.mode === 'blitz');
  const lobbyCopy = await b.evaluate(() => ({ blurb: document.querySelector('#lobby .modeblurb')?.textContent ?? '', crests: document.querySelectorAll('#lobby .seat > .hcrest').length }));
  check(/4 brisk eras/.test(lobbyCopy.blurb) && lobbyCopy.crests === 4, 'host picks Blitz and the guest sees it: four brisk eras, a crest on every seat', lobbyCopy.blurb);
  await a.screenshot({ path: `${OUT}/20-lobby.png` });
  await a.click('#lobby [data-act="start"]');
  for (const p of [a, b]) await p.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.kind === 'multi' && window.__mercadia.state().ready, null, { timeout: 15000 });
  const ia = await info(a);
  const ib = await info(b);
  check(ia.me === 0 && ib.me === 1, 'both sockets are seated in the match', `host player ${ia.me}, guest player ${ib.me}`);
  const pace = await b.evaluate(() => [...document.querySelectorAll('#clock [data-act="speed"]')].map((x) => `${x.dataset.v}|${x.disabled}|${x.title}`));
  const hostPace = await a.evaluate(() => [...document.querySelectorAll('#clock [data-act="speed"]')].map((x) => `${x.dataset.v}|${x.disabled}`).join(' '));
  check(pace.length === 3 && pace.every((x) => /^(1|1\.5|2)\|true\|Host controls match speed$/.test(x)) && hostPace === '1|false 1.5|false 2|false' && !(await a.evaluate(() => !!document.querySelector('#clock [data-act="pause"]'))), 'host pace is 1× / 1.5× / 2× (no pause); the guest’s buttons are disabled and say why', `guest: ${pace[0]} · host: ${hostPace}`);
  const ta = (await state(a)).tick;
  await a.waitForFunction((t) => window.__mercadia.state().tick > t + 20, ta, { timeout: 15000 });
  const [sa, sb] = [await state(a), await state(b)];
  check(Math.abs(sa.tick - sb.tick) <= 6 && sa.citizens >= 45 && sa.era === 1 && sb.era === 1, 'server ticks at 10 Hz for both clients, both in Era I', `ticks ${sa.tick}/${sb.tick}, citizens ${sa.citizens}/${sb.citizens}`);
  const [ca0, cb0] = [await boardCrests(a), await boardCrests(b)];
  check(crestsOk(ca0, HOUSE_CREST) && crestsOk(cb0, HOUSE_CREST) && (await a.evaluate(() => !document.getElementById('guide').hidden)) && (await b.evaluate(() => !document.getElementById('guide').hidden)), 'both boards fly the four House crests, and each human gets the Founding Guide', ca0.map((r) => `${r.house}:${r.crest}`).join(' '));
  const lotA = await build(a, 'bistro');
  await built(b, lotA, 'bistro', 0);
  ok('host builds a Bistro and the guest sees it', `lot ${lotA}`);
  const lotB = await build(b, 'roastery');
  await built(a, lotB, 'roastery', 1);
  ok('guest builds a Roastery and the host sees it', `lot ${lotB}`);
  const [ca, cb] = [await state(a), await state(b)];
  check(ca.players[0].cash === cb.players[0].cash || Math.abs(ca.players[0].cash - cb.players[0].cash) < 60, 'cash agrees across clients', `host sees ${ca.players[0].cash}, guest sees ${cb.players[0].cash}`);
  await a.click('#dock [data-kind="arcade"]');
  const mpLock = await a.evaluate(() => ({ t: document.querySelector('#toasts .toast.lockmsg')?.textContent ?? '', tool: window.__mercadia.tool }));
  check(mpLock.t === 'Arcade unlocks in Era II: Transit & Trade' && mpLock.tool === null, 'Era locks hold in a room: the Arcade answers with its unlock notice', `"${mpLock.t}"`);
  // A rival's Promo Blitz shows in their shop's Inspector, with a live countdown, and in both Chronicles.
  // (Rivalry headlines are rationed to one per quiet window: open the Inspector first, wait one out, then fire.)
  const quietNow = () => { const m = window.__mercadia; const r = m.chronicle().filter((d) => d.cat === 'promo' || d.cat === 'rival'); return m.state().tick - (r.length ? r[r.length - 1].tick : -9999) > 158; };
  await a.keyboard.press('Escape');
  const pa = await a.evaluate((t) => window.__mercadia.tileScreen(t), lotA);
  await a.mouse.click(pa.x, pa.y - 4);
  await a.waitForFunction((t) => window.__mercadia.selectedTile === t && !document.getElementById('inspector').hidden, lotA, { timeout: 5000 });
  await a.waitForFunction(quietNow, null, { timeout: 25000 });
  await a.click('#inspector [data-act="promo"]');
  await b.keyboard.press('Escape');
  const pb = await b.evaluate((t) => window.__mercadia.tileScreen(t), lotA);
  await b.mouse.click(pb.x, pb.y - 4);
  await b.waitForFunction(() => { const el = document.querySelector('#inspector .promobadge'); return !!el && !el.hidden; }, null, { timeout: 6000 });
  const badge1 = await text(b, '#inspector .promobadge');
  const rivalHead = await b.evaluate(() => ({ crest: document.querySelector('#inspector .head .hcrest')?.dataset.crest ?? '' }));
  await sleep(b, 2200);
  const badge2 = await text(b, '#inspector .promobadge');
  const secs = (s) => Number((s.match(/(\d+)s/) ?? [])[1]);
  check(/Promo Blitz/.test(badge1) && secs(badge2) < secs(badge1) && rivalHead.crest === 'compass', 'a rival’s Promo Blitz shows as a badge with a live countdown in their shop’s Inspector, under the rival’s crest', `"${badge1}" → "${badge2}"`);
  await b.keyboard.press('Escape');
  let promoBy = 0;
  let promoLot = lotA;
  if (!(await a.evaluate(() => window.__mercadia.chronicle().some((d) => d.cat === 'promo' && d.player === 0)))) {
    // An AI headline slipped into the same instant and took the window: the guest fires one instead.
    promoBy = 1;
    promoLot = lotB;
    const pg = await b.evaluate((t) => window.__mercadia.tileScreen(t), lotB);
    await b.mouse.click(pg.x, pg.y - 4);
    await b.waitForFunction((t) => window.__mercadia.selectedTile === t && !document.getElementById('inspector').hidden, lotB, { timeout: 5000 });
    await b.waitForFunction(quietNow, null, { timeout: 25000 });
    await b.click('#inspector [data-act="promo"]');
  }
  for (const p of [a, b]) await p.waitForFunction((who) => window.__mercadia.chronicle().some((d) => d.cat === 'promo' && d.player === who), promoBy, { timeout: 5000 });
  const [na, nb] = [await hook(a, 'chronicle'), await hook(b, 'chronicle')];
  const promoA = na.find((d) => d.cat === 'promo' && d.player === promoBy);
  const promoB = nb.find((d) => d.n === promoA.n);
  check(!!promoB && promoB.head === promoA.head && promoB.pill === promoA.pill && promoA.tile === promoLot && /^Promo Blitz! (Vermilion|Cobalt)/.test(promoA.head), 'the Chronicle dispatch for a human’s Promo Blitz reaches both clients, identical', `#${promoA.n} "${promoA.head}" [${promoA.pill}]`);
  await b.keyboard.press('Escape');
  await a.keyboard.press('Escape');
  await a.screenshot({ path: `${OUT}/21-multiplayer-host.png` });
  await b.screenshot({ path: `${OUT}/22-multiplayer-guest.png` });

  // ── Era Council 1: both choose, the room advances at once ──
  await a.click('#clock [data-act="speed"][data-v="2"]');
  for (const p of [a, b]) await p.waitForFunction(() => window.__mercadia.speed === 2, null, { timeout: 5000 });
  ok('the host sets 2× and both clients run at the room pace');
  const inCouncil = (p, timeout = 70000) => p.waitForFunction(() => window.__mercadia.state().phase === 'council' && !document.getElementById('council').hidden, null, { timeout });
  await Promise.all([inCouncil(a), inCouncil(b)]);
  const councilView = (p) =>
    p.evaluate(() => {
      const m = window.__mercadia;
      const c = m.council();
      const card = document.querySelector('#council .council');
      return { tick: m.state().tick, era: c.era, left: c.left, total: c.total, picks: c.picks, offers: c.offers, countdown: card.querySelector('[data-f="countdown"]')?.textContent ?? '', advance: !!card.querySelector('[data-act="advance"]'), cards: [...card.querySelectorAll('.charter')].map((x) => x.dataset.key), rows: card.querySelectorAll('.srow .hcrest').length, unlocks: [...card.querySelectorAll('.unlock')].map((u) => u.dataset.kind).join(), tool: m.tool };
    });
  const [va, vb] = [await councilView(a), await councilView(b)];
  check(va.tick === 660 && vb.tick === 660 && va.era === 1 && va.total === 180 && /^\d+s$/.test(va.countdown) && /^\d+s$/.test(vb.countdown) && !va.advance && !vb.advance && va.rows === 4 && vb.rows === 4 && va.unlocks === 'arcade,nightmarket,tramstop', 'the Era I close opens the Era Council on both clients with a server countdown (no Advance button)', `tick ${va.tick}; countdown host ${va.countdown} / guest ${vb.countdown}`);
  check(va.cards.length === 3 && vb.cards.length === 3 && va.cards.join() === va.offers[0].join() && vb.cards.join() === vb.offers[1].join() && JSON.stringify(va.offers) === JSON.stringify(vb.offers) && va.picks[2] !== null && va.picks[3] !== null && va.picks[0] === null && va.picks[1] === null, 'each human is offered their own three charters; the AI Houses have already sealed theirs', `host ${va.cards.join('/')} · guest ${vb.cards.join('/')} · AI ${va.picks[2]}, ${va.picks[3]}`);
  await a.screenshot({ path: `${OUT}/23-multiplayer-council-host.png` });
  const t1 = (await state(a)).tick;
  await sleep(a, 1200);
  check((await state(a)).tick === t1 && (await councilView(a)).left < va.left, 'the room pauses the city during the Council while the countdown runs', `tick ${t1} held, ${va.left} → ${(await councilView(a)).left} beats left`);
  await a.click(`#council .charter[data-key="${va.cards[0]}"]`);
  await b.waitForFunction((k) => document.querySelector('#council .srow[data-p="0"] [data-f="pick"]')?.dataset.key === k, va.cards[0], { timeout: 5000 });
  const seen = await b.evaluate(() => ({ sealed: document.querySelector('#council .srow[data-p="0"] [data-f="pick"]').classList.contains('sealed'), text: document.querySelector('#council .srow[data-p="0"] [data-f="pick"]').textContent, note: document.querySelector('#council [data-f="cnote"]').textContent, open: !document.getElementById('council').hidden }));
  const hostNote = await text(a, '#council [data-f="cnote"]');
  check(seen.sealed && seen.open && /Waiting for 1 more House/.test(hostNote), 'the host’s sealed charter appears on the guest’s Council, and the room keeps waiting for the guest', `guest sees "${seen.text}" · host: "${hostNote}"`);
  await b.screenshot({ path: `${OUT}/24-multiplayer-council-guest.png` });
  const leftBefore = (await councilView(b)).left;
  // Time it inside the page: from the moment the room echoes the last pick back to the moment the next era begins.
  await b.evaluate(() => {
    const t = (window.__councilTimes = { start: performance.now(), pick: 0, play: 0 });
    const iv = setInterval(() => {
      const m = window.__mercadia;
      const c = m.council();
      const now = performance.now() - t.start;
      if (c && c.picks[1] && !t.pick) t.pick = now;
      if (m.state().phase === 'playing' && !t.play) {
        t.play = now;
        clearInterval(iv);
      }
    }, 10);
  });
  await b.click(`#council .charter[data-key="${vb.cards[1]}"]`);
  await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__mercadia.state().phase === 'playing' && document.getElementById('council').hidden, null, { timeout: 12000 })));
  await b.waitForFunction(() => window.__councilTimes.play > 0, null, { timeout: 5000 });
  const times = await b.evaluate(() => window.__councilTimes);
  const tookMs = Math.round(times.play - times.pick);
  check(times.pick > 0 && tookMs >= 0 && tookMs < 3000 && leftBefore > 40, 'once every connected human has chosen the room advances promptly, well before the countdown', `${tookMs} ms from the last pick registering to Era II, with ${(leftBefore / 10).toFixed(1)} s still on the clock`);
  const era2 = (p) => p.evaluate(() => ({ era: window.__mercadia.era, charters: window.__mercadia.charters.map((c) => c.charters), unlocks: window.__mercadia.unlocks.join(), arcade: document.querySelector('#dock [data-kind="arcade"]').dataset.locked ?? '', badge: document.querySelector('#treasury .charters .cbadge')?.dataset.key ?? '', chip: document.querySelector('#clock [data-f="era"]').textContent.trim() }));
  await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__mercadia.charters.every((c) => c.charters.length === 1), null, { timeout: 5000 })));
  const [ea, eb] = [await era2(a), await era2(b)];
  check(ea.era === 2 && eb.era === 2 && JSON.stringify(ea.charters) === JSON.stringify(eb.charters) && ea.charters[0][0] === va.cards[0] && ea.charters[1][0] === vb.cards[1] && ea.badge === va.cards[0] && eb.badge === vb.cards[1], 'both clients hold identical charters for all four Houses, each human exactly the one they clicked', `${ea.charters.map((c) => c.join()).join(' | ')}`);
  check(ea.unlocks === eb.unlocks && /arcade,nightmarket/.test(ea.unlocks) && ea.arcade === '' && eb.arcade === '' && ea.chip === 'Era II · Transit', 'Era II is unlocked on both clients', `${ea.chip}: ${ea.unlocks}`);
  const lotC = await build(a, 'arcade');
  await built(b, lotC, 'arcade', 0);
  ok('the host builds an Era II Arcade and the guest sees it', `lot ${lotC}`);
  await a.keyboard.press('Escape');

  // Reconnect: the guest reloads and must land in the same seat with the same city and dynasty.
  await settle(b);
  await b.reload();
  await b.waitForFunction(() => window.__mercadia && window.__mercadia.phase === 'playing' && window.__mercadia.me === 1 && window.__mercadia.state().ready, null, { timeout: 20000 });
  await sleep(b, 500);
  const rb = await state(b);
  const dynOf = (p) => p.evaluate(() => ({ charters: window.__mercadia.charters.map((c) => c.charters), stars: window.__mercadia.milestones.map((m) => m.earned), last: window.__mercadia.chronicle().slice(-1)[0]?.n ?? 0, era: window.__mercadia.era, guide: document.getElementById('guide').hidden }));
  const [da, db] = [await dynOf(a), await dynOf(b)];
  check(rb.buildings.some((x) => x.tile === lotA) && rb.buildings.some((x) => x.tile === lotB && x.owner === 1) && rb.buildings.some((x) => x.tile === lotC), 'guest reloads and reconnects into the same seat', `player ${(await info(b)).me}, buildings ${rb.buildings.length}`);
  check(JSON.stringify(da.charters) === JSON.stringify(db.charters) && JSON.stringify(da.stars) === JSON.stringify(db.stars) && Math.abs(da.last - db.last) <= 1 && db.era === 2 && db.guide, 'the reconnected client has the full dynasty: era, charters, milestones and the Chronicle', `charters ${db.charters.map((c) => c.join()).join('|')} · stars ${db.stars.map((s) => s.length).join('')} · last dispatch #${db.last}/#${da.last}`);
  // Harder: the tab is closed outright (sessionStorage gone) and the invite link is reopened.
  await settle(b);
  await b.close();
  await a.waitForFunction(() => window.__mercadia.lobby.seats[1].connected === false, null, { timeout: 10000 });
  b = await openGuest('guest-reopened');
  await b.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.state().ready, null, { timeout: 20000 });
  await sleep(b, 400);
  const reopened = await info(b);
  check(reopened.me === 1 && reopened.seat === 1, 'closing the tab and reopening ?room= reclaims the exact seat (not a spectator)', `seat ${reopened.seat}, player ${reopened.me}`);
  const room = await (await fetch(`${BASE}/api/rooms/${code}`)).json();
  check(room.status === 'playing' && room.humans === 2 && room.connected === 2 && room.era === 2, 'room summary reports the running match and its era', `status=${room.status} humans=${room.humans} connected=${room.connected} tick=${room.tick} era=${room.era}`);

  // ── Era Council 2: a mid-Council reconnect, then one House stays silent ──
  await Promise.all([inCouncil(a), inCouncil(b)]);
  const tOpen = Date.now();
  await settle(b);
  await b.reload();
  await b.waitForFunction(() => window.__mercadia && window.__mercadia.phase === 'playing' && window.__mercadia.me === 1 && window.__mercadia.state().ready && window.__mercadia.state().phase === 'council' && !document.getElementById('council').hidden, null, { timeout: 15000 });
  const v2b = await councilView(b);
  const v2a = await councilView(a);
  check(v2b.era === 2 && v2b.tick === 1320 && v2b.cards.length === 3 && v2b.cards.join() === v2a.offers[1].join() && v2b.unlocks === 'boutique,cinema,plaza,level3' && v2b.left > 20, 'reconnecting in the middle of an Era Council restores it: my offers, the unlocks, the countdown', `guest back with ${v2b.cards.join('/')}, ${(v2b.left / 10).toFixed(1)} s left`);
  await a.click(`#council .charter[data-key="${v2a.cards[0]}"]`);
  await b.waitForFunction((k) => document.querySelector('#council .srow[data-p="0"] [data-f="pick"]')?.dataset.key === k, v2a.cards[0], { timeout: 5000 });
  const steward = await text(b, '#council [data-f="cnote"]');
  await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__mercadia.state().phase === 'playing' && window.__mercadia.charters.every((c) => c.charters.length === 2), null, { timeout: 30000 })));
  const lasted = (Date.now() - tOpen) / 1000;
  const [d2a, d2b] = [await dynOf(a), await dynOf(b)];
  check(lasted >= 14 && lasted <= 24 && /steward chooses for you/.test(steward), 'a silent House is not waited for beyond the ~18 s countdown', `Council sat ${lasted.toFixed(1)} s · guest was told: "${steward}"`);
  check(JSON.stringify(d2a.charters) === JSON.stringify(d2b.charters) && d2a.charters[0][1] === v2a.cards[0] && v2a.offers[1].includes(d2a.charters[1][1]) && d2a.era === 3 && d2b.era === 3, 'the steward auto-selects for the silent House from its own offer, and both clients agree', `host ${d2a.charters[0].join('+')} · guest (steward) ${d2a.charters[1].join('+')}`);

  // A latecomer on a phone watches as a spectator, and can read that they are.
  const spec = await open('spectator', `/?room=${code}`, PHONE);
  await spec.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.state().ready, null, { timeout: 20000 });
  await sleep(spec, 300);
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
    return { hidden: el.hidden, text: el.textContent, color: cs.color, bg: cs.backgroundColor, border: cs.borderTopWidth, contrast: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, me: window.__mercadia.me, dock: document.getElementById('dock').hidden, guide: document.getElementById('guide').hidden, crests: document.querySelectorAll('#board .row .hcrest').length, era: window.__mercadia.era };
  });
  check(!pill.hidden && pill.me === -1 && /watching as a spectator/.test(pill.text) && pill.color === 'rgb(30, 26, 22)' && pill.bg === 'rgba(250, 247, 240, 0.96)' && pill.contrast >= 10 && pill.inView && parseFloat(pill.border) >= 1 && pill.dock && pill.guide, 'spectator notice: dark ink on solid cream linen with a hairline, ≥ 10:1 — no dock, no guide', `${pill.color} on ${pill.bg}, contrast ${pill.contrast.toFixed(1)}:1`);
  const laySpec = await layout(spec);
  check(pill.crests === 4 && pill.era === 3 && laySpec.clipped.length === 0 && laySpec.overlaps.length === 0, 'the spectator’s phone shows the crested score strip and the era, nothing clipped', `${laySpec.shown.join(' ')}`);
  await spec.screenshot({ path: `${OUT}/25-mobile-spectator.png` });

  // ── Era Council 3: the spectator reads it, the humans seal it ──
  await Promise.all([inCouncil(a), inCouncil(b), inCouncil(spec)]);
  const specCouncil = await spec.evaluate(() => { const card = document.querySelector('#council .council'); const r = card.getBoundingClientRect(); return { cards: card.querySelectorAll('.charter').length, rows: card.querySelectorAll('.srow').length, countdown: card.querySelector('[data-f="countdown"]')?.textContent ?? '', note: card.querySelector('[data-f="cnote"]').textContent, inView: r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, notice: !document.getElementById('spectator').hidden }; });
  check(specCouncil.cards === 0 && specCouncil.rows === 4 && /^\d+s$/.test(specCouncil.countdown) && specCouncil.inView && /Houses are choosing/.test(specCouncil.note), 'a spectator sees the Era Council read-only: standings and countdown, no charter cards', `"${specCouncil.note}" ${specCouncil.countdown}`);
  await spec.screenshot({ path: `${OUT}/26-mobile-spectator-council.png` });
  const v3a = await councilView(a);
  const v3b = await councilView(b);
  await a.click(`#council .charter[data-key="${v3a.cards[2]}"]`);
  await b.click(`#council .charter[data-key="${v3b.cards[0]}"]`);
  await Promise.all([a, b, spec].map((p) => p.waitForFunction(() => window.__mercadia.state().phase === 'playing' && window.__mercadia.era === 4 && window.__mercadia.charters.every((c) => c.charters.length === 3), null, { timeout: 10000 })));
  const [d3a, d3b, d3s] = [await dynOf(a), await dynOf(b), await dynOf(spec)];
  check(JSON.stringify(d3a.charters) === JSON.stringify(d3b.charters) && JSON.stringify(d3a.charters) === JSON.stringify(d3s.charters) && d3a.charters[0][2] === v3a.cards[2] && d3a.charters[1][2] === v3b.cards[0] && d3a.charters.every((c) => new Set(c).size === 3), 'Era IV: three Councils on, host, guest and spectator agree on every House’s three distinct charters', d3a.charters.map((c) => c.join('+')).join(' | '));
  const starsA = await boardCrests(a);
  const starsB = await boardCrests(b);
  check(starsA.every((r) => r.stars === d3a.stars[r.p].length) && JSON.stringify(starsA.map((r) => [r.p, r.stars]).sort()) === JSON.stringify(starsB.map((r) => [r.p, r.stars]).sort()) && d3a.stars.some((s) => s.length >= 2), 'Milestone stars are synced: the same brass stars beside each crest on both boards', d3a.stars.map((s, i) => `p${i} ★${s.length}`).join(' '));
  await a.screenshot({ path: `${OUT}/27-multiplayer-era4-host.png` });
  await spec.context().close();

  // Host migration: the host leaves, the guest takes over.
  await a.context().close();
  await b.waitForFunction(() => window.__mercadia.lobby.host === 1, null, { timeout: 15000 });
  await b.waitForFunction(() => [...document.querySelectorAll('#clock [data-act="speed"]')].every((x) => !x.disabled), null, { timeout: 5000 });
  ok('host leaves and the guest becomes host: the pace buttons unlock');
  const tb = (await state(b)).tick;
  await b.waitForFunction((t) => window.__mercadia.state().tick > t + 10, tb, { timeout: 15000 });
  await b.click('#clock [data-act="speed"][data-v="1.5"]');
  await b.waitForFunction(() => window.__mercadia.speed === 1.5, null, { timeout: 5000 });
  ok('the match keeps running for the remaining player, who now sets the pace (1.5×)');
  await guestCtx.close();
}

await browser.close();

check(errors.length === 0, '0 console errors, 0 page errors, 0 failed requests', errors.join(' | '));
console.log(`\n${receipts.filter((r) => r.ok).length}/${receipts.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s`);
if (problems.length) {
  console.log('Problems:\n- ' + problems.join('\n- '));
  process.exit(1);
}
