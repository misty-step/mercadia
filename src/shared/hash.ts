// A stable state hash: canonical JSON (sorted keys) folded through two independent 32-bit mixes.

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const parts: string[] = [];
  for (const k of keys) if (o[k] !== undefined) parts.push(`${JSON.stringify(k)}:${stableStringify(o[k])}`);
  return `{${parts.join(',')}}`;
}

/** 16 hex characters. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export const hashOf = (v: unknown): string => hashString(stableStringify(v));

/** `#4f1a·c9e2` — the short form players compare. */
export const shortHash = (full: string): string => `#${full.slice(0, 4)}·${full.slice(4, 8)}`;
