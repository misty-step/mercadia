// MERCADIA Worker: a small API, WebSocket routing to room Durable Objects, static assets.
import { VERSION } from './shared/constants';
import { isRoomCode, makeRoomCode } from './shared/room';

export { MercadiaRoom } from './room-do';

export interface Env {
  ASSETS: Fetcher;
  GAME_ROOMS: DurableObjectNamespace;
}

/** No inline scripts, inline styles or event handlers, and no third-party origins. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function secureRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}

const roomStub = (env: Env, code: string): DurableObjectStub => env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(code));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') return json({ ok: true, game: 'mercadia', version: VERSION });

    if (path === '/api/rooms') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST to create a room' }, 405);
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = makeRoomCode(secureRandom);
        const res = await roomStub(env, code).fetch(`https://room/init?code=${code}`, { method: 'POST' });
        if (res.status === 409) continue; // code in use, draw again
        if (!res.ok) return json({ ok: false, error: 'Could not open a room' }, 500);
        return json({ code, wsPath: `/ws/rooms/${code}`, joinUrl: `${url.origin}/?room=${code}` }, 201);
      }
      return json({ ok: false, error: 'Could not find a free room code' }, 503);
    }

    const api = path.match(/^\/api\/rooms\/([A-Za-z]{4})$/);
    if (api) {
      if (request.method !== 'GET') return json({ ok: false, error: 'Use GET' }, 405);
      const code = api[1].toUpperCase();
      return roomStub(env, code).fetch('https://room/summary');
    }

    const ws = path.match(/^\/ws\/rooms\/([A-Za-z]{4})$/);
    if (ws) {
      const code = ws[1].toUpperCase();
      if (!isRoomCode(code)) return json({ ok: false, error: 'Bad room code' }, 400);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return json({ ok: false, error: 'Expected a WebSocket upgrade' }, 426);
      return roomStub(env, code).fetch(request);
    }

    if (path.startsWith('/api/') || path.startsWith('/ws/')) return json({ ok: false, error: 'Not found' }, 404);

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set('content-security-policy', CSP);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
