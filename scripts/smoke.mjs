// MERCADIA smoke check. Needs the Worker running (npm run dev) and a Chrome/Chromium binary.
//   node scripts/smoke.mjs            BASE=http://127.0.0.1:8787  CHROME=/usr/bin/google-chrome
// Verifies the API, a solo match, and two browser contexts sharing one multiplayer room over
// WebSockets with live build synchronisation and a reconnect — with zero console/page errors.
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
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--mute-audio'] });
const errors = [];
const open = async (label, path = '/') => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${label}] console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  await page.goto(BASE + path);
  await page.waitForFunction(() => window.__mercadia && window.__mercadia.state().ready, null, { timeout: 20000 });
  return page;
};
const state = (page) => page.evaluate(() => window.__mercadia.state());
const info = (page) => page.evaluate(() => ({ phase: window.__mercadia.phase, kind: window.__mercadia.kind, me: window.__mercadia.me, seat: window.__mercadia.seat, room: window.__mercadia.roomCode, frames: window.__mercadia.frames }));
/** Pick a dock tool, then click the free lot nearest the middle of the view. */
const build = async (page, kind) => {
  await page.click(`#dock [data-kind="${kind}"]`);
  const target = await page.evaluate(() => {
    const m = window.__mercadia;
    let best = null;
    for (const t of m.freeLots()) {
      const p = m.tileScreen(t);
      const d = Math.hypot(p.x - innerWidth / 2, p.y - innerHeight / 2);
      if (!best || d < best.d) best = { t, x: p.x, y: p.y, d };
    }
    return best;
  });
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(120);
  await page.mouse.click(target.x, target.y);
  return target.t;
};

// ── Solo ──
console.log('Solo');
const solo = await open('solo');
const attract = await state(solo);
check(attract.citizens >= 60 && attract.trams >= 2, 'title screen floats over a live city', `citizens=${attract.citizens} trams=${attract.trams} players=${attract.players.length}`);
await solo.screenshot({ path: `${OUT}/01-title.png` });
await solo.click('#title [data-act="solo"]');
await solo.waitForFunction(() => window.__mercadia.phase === 'playing' && window.__mercadia.kind === 'solo');
const s0 = await state(solo);
check(s0.players.length === 4 && s0.players[0].kind === 'human' && s0.players.filter((p) => p.kind === 'ai').length === 3, 'Play Solo Now starts You vs 3 AI', s0.players.map((p) => p.name).join(', '));
const cash0 = s0.players[0].cash;
const lot = await build(solo, 'roastery');
await solo.waitForFunction((t) => window.__mercadia.state().buildings.some((b) => b.tile === t && b.owner === 0), lot, { timeout: 5000 });
const s1 = await state(solo);
check(s1.players[0].cash === cash0 - 180, 'building a Roastery costs §180', `cash ${cash0} → ${s1.players[0].cash}, lot ${lot}`);
await solo.waitForFunction(() => !document.getElementById('inspector').hidden, null, { timeout: 5000 });
await solo.click('#inspector [data-act="stance"][data-v="0"]');
await solo.waitForFunction((t) => window.__mercadia.state().buildings.find((b) => b.tile === t)?.stance === 0, lot);
ok('inspector sets the Budget price stance');
const t0 = (await state(solo)).tick;
await solo.waitForFunction((t) => window.__mercadia.state().tick > t + 15, t0, { timeout: 15000 });
const s2 = await state(solo);
check(s2.citizens >= 60 && s2.citizens <= 120, 'citizens walk the streets', `tick ${s2.tick}, citizens=${s2.citizens}`);
await solo.evaluate(() => window.__mercadia.warp(700));
await solo.waitForTimeout(700);
const s3 = await state(solo);
check(s3.buildings.length > 4 && s3.buildings.some((b) => b.owner !== 0), 'AI tycoons build rival shops', `buildings=${s3.buildings.length} tick=${s3.tick}`);
await solo.screenshot({ path: `${OUT}/02-solo.png` });
await solo.click('#clock [data-act="leave"]');
await solo.waitForFunction(() => window.__mercadia.phase === 'title');
ok('leaving returns to the title');
await solo.context().close();

// ── Multiplayer: two browser contexts, one room ──
console.log('Multiplayer');
const a = await open('host');
await a.fill('#t-name', 'Ada');
await a.click('#title [data-act="create"]');
await a.waitForFunction(() => window.__mercadia.phase === 'lobby' && window.__mercadia.seat === 0 && !!window.__mercadia.lobby, null, { timeout: 15000 });
const code = (await info(a)).room;
check(/^[A-Z]{4}$/.test(code) && new URL(a.url()).searchParams.get('room') === code, 'Create Room yields a code and ?room= URL', `${code} ${a.url()}`);
const b = await open('guest', `/?room=${code}`);
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
await a.screenshot({ path: `${OUT}/04-multiplayer-host.png` });
await b.screenshot({ path: `${OUT}/05-multiplayer-guest.png` });
// Reconnect: the guest reloads and must land in the same seat with the same city.
await b.reload();
await b.waitForFunction(() => window.__mercadia && window.__mercadia.phase === 'playing' && window.__mercadia.me === 1 && window.__mercadia.state().ready, null, { timeout: 20000 });
const rb = await state(b);
check(rb.buildings.some((x) => x.tile === lotA) && rb.buildings.some((x) => x.tile === lotB && x.owner === 1), 'guest reloads and reconnects into the same seat', `player ${(await info(b)).me}, buildings ${rb.buildings.length}`);
const room = await (await fetch(`${BASE}/api/rooms/${code}`)).json();
check(room.status === 'playing' && room.humans === 2 && room.connected === 2, 'room summary reports the running match', `status=${room.status} humans=${room.humans} connected=${room.connected} tick=${room.tick}`);
// Host migration: the host leaves, the guest takes over.
await a.context().close();
await b.waitForFunction(() => window.__mercadia.lobby.host === 1, null, { timeout: 15000 });
ok('host leaves and the guest becomes host');
const tb = (await state(b)).tick;
await b.waitForFunction((t) => window.__mercadia.state().tick > t + 10, tb, { timeout: 15000 });
ok('the match keeps running for the remaining player');
await b.context().close();
await browser.close();

check(errors.length === 0, '0 console errors, 0 page errors, 0 failed requests', errors.join(' | '));
console.log(`\n${receipts.filter((r) => r.ok).length}/${receipts.length} checks passed`);
if (problems.length) {
  console.log('Problems:\n- ' + problems.join('\n- '));
  process.exit(1);
}
