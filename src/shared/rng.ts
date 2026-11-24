// Seeded randomness for the pure core. Every stream is derived from the match seed, the turn
// number and a purpose label, so results never depend on the order callers draw in.

/** FNV-1a over a string, 32 bits. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, n). */
  int(n: number): number;
  /** An integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number;
  /** Index into a weight list, proportional to the weights. */
  weighted(weights: number[]): number;
}

/** mulberry32 stream for (seed, turn, purpose). */
export function stream(seed: number, turn: number, purpose: string): Rng {
  let a = (hash32(`${seed >>> 0}:${turn}:${purpose}`) ^ (seed >>> 0)) >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    weighted: (w) => {
      let total = 0;
      for (const x of w) total += x;
      if (total <= 0) return 0;
      let r = next() * total;
      for (let i = 0; i < w.length; i++) {
        r -= w[i];
        if (r < 0) return i;
      }
      return w.length - 1;
    },
  };
}
