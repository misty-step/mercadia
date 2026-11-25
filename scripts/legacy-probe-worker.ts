// Test-only entry used by `node scripts/smoke.mjs` (legacy section) through scripts/wrangler.legacy.jsonc.
// It is the production Worker plus one probe route, so the smoke can POST the Durable Object's internal
// /init on a chosen room code (the production Worker only ever draws random codes). It is never deployed.
import worker from '../src/worker';
import type { Env } from '../src/worker';

export { MercadiaRoom } from '../src/room-do';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/__do\/([A-Z]{4})(\/[a-z]+)$/);
    if (m) {
      const stub = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(m[1]));
      return stub.fetch(`https://room${m[2]}${url.search}`, { method: request.method });
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
