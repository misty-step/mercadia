import { describe, expect, it } from 'vitest';
import { SeatToken, STALE_MS, type KV } from '../src/client/seat-token';

const mem = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};

const H = 60 * 60 * 1000;

describe('SeatToken has no age limit', () => {
  it.each([13 * H, 24 * H, 7 * 24 * H, 90 * 24 * H])('a closed tab reopened %i ms later reclaims the same seat', (elapsed) => {
    const local = mem();
    const t0 = 1_000_000;
    const a = new SeatToken('ABCD', local, mem(), 'tab-a');
    a.save('player-1', t0);
    a.beat('player-1', t0 + 2000);
    a.release('player-1'); // the tab closed
    const b = new SeatToken('ABCD', local, mem(), 'tab-b'); // a new tab: its own sessionStorage is empty
    expect(b.load(t0 + elapsed)).toBe('player-1');
  });

  it('a tab that crashed without releasing (heartbeat gone stale) is reclaimable after 24h and 7d', () => {
    const local = mem();
    const a = new SeatToken('ABCD', local, mem(), 'tab-a');
    a.save('player-1', 0);
    a.beat('player-1', 10_000);
    for (const elapsed of [24 * H, 7 * 24 * H]) {
      expect(new SeatToken('ABCD', local, mem(), 'tab-b').load(10_000 + elapsed)).toBe('player-1');
    }
  });

  it('still protects the seat of a live tab: a second tab does not steal it while the heartbeat is fresh', () => {
    const local = mem();
    const a = new SeatToken('ABCD', local, mem(), 'tab-a');
    a.save('player-1', 0);
    a.beat('player-1', 100 * H);
    const b = new SeatToken('ABCD', local, mem(), 'tab-b');
    expect(b.load(100 * H + STALE_MS - 1)).toBeNull();
    expect(b.load(100 * H + STALE_MS + 1)).toBe('player-1');
  });

  it('is only dropped by forget()', () => {
    const local = mem();
    const a = new SeatToken('ABCD', local, mem(), 'tab-a');
    a.save('player-1', 0);
    a.release('player-1');
    a.forget();
    expect(new SeatToken('ABCD', local, mem(), 'tab-b').load(24 * H)).toBeNull();
  });
});
