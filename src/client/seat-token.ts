// The reconnect token for a multiplayer seat.
//
// The server holds a seat for its `playerId` through a disconnect. Keeping that id only in
// sessionStorage loses it when the tab is closed or a phone evicts the page, and the player
// comes back as a spectator. So the id is written to localStorage as well (sessionStorage is
// the fallback when localStorage is unavailable).
//
// A second tab in the same browser shares localStorage. To stop it stealing the seat of a
// tab that is still playing, the playing tab keeps a heartbeat next to the token: a fresh
// tab only adopts a token whose heartbeat has gone quiet.

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const HEARTBEAT_MS = 2000;
export const STALE_MS = 6000; // three missed beats: the tab that held the seat is gone
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // rooms are purged after hours of silence

interface Stored {
  id: string;
  at: number; // when the token was last saved
  beat: number; // last heartbeat from the tab holding the seat
  tab: string; // which tab that was
}

const safe = <T>(f: () => T, fallback: T): T => {
  try {
    return f();
  } catch {
    return fallback;
  }
};

export class SeatToken {
  readonly key: string;
  constructor(
    code: string,
    private local: KV | null,
    private session: KV | null,
    /** A random id for this tab, so a tab recognises its own heartbeat. */
    readonly tab: string,
  ) {
    this.key = `mercadia:pid:${code}`;
  }

  private readLocal(): Stored | null {
    const raw = safe(() => this.local?.getItem(this.key) ?? null, null);
    if (!raw) return null;
    const v = safe(() => JSON.parse(raw) as Partial<Stored>, null);
    if (!v || typeof v.id !== 'string' || !v.id) return null;
    return { id: v.id, at: Number(v.at) || 0, beat: Number(v.beat) || 0, tab: typeof v.tab === 'string' ? v.tab : '' };
  }

  /**
   * The playerId to present on hello, or null to join as a new player.
   * This tab's own id (sessionStorage) wins; otherwise the browser-wide one, unless another
   * live tab is sitting in that seat right now.
   */
  load(now: number): string | null {
    const mine = safe(() => this.session?.getItem(this.key) ?? null, null);
    if (mine) return mine;
    const stored = this.readLocal();
    if (!stored) return null;
    if (now - stored.at > TOKEN_TTL_MS) {
      safe(() => this.local?.removeItem(this.key), undefined);
      return null;
    }
    const heldElsewhere = stored.tab !== this.tab && now - stored.beat < STALE_MS;
    return heldElsewhere ? null : stored.id;
  }

  /** Remember the id the server gave us, in both stores. */
  save(id: string, now: number): void {
    safe(() => this.session?.setItem(this.key, id), undefined);
    safe(() => this.local?.setItem(this.key, JSON.stringify({ id, at: now, beat: now, tab: this.tab } satisfies Stored)), undefined);
  }

  /** Called every HEARTBEAT_MS by the tab that holds the seat. */
  beat(id: string, now: number): void {
    const stored = this.readLocal();
    // Another tab has since taken a different seat in this room: leave its record alone.
    if (stored && stored.id !== id && stored.tab !== this.tab && now - stored.beat < STALE_MS) return;
    safe(() => this.local?.setItem(this.key, JSON.stringify({ id, at: stored?.id === id ? stored.at : now, beat: now, tab: this.tab } satisfies Stored)), undefined);
  }

  /** The tab is going away: let the next tab reclaim the seat at once. */
  release(id: string): void {
    const stored = this.readLocal();
    if (!stored || stored.id !== id || stored.tab !== this.tab) return;
    safe(() => this.local?.setItem(this.key, JSON.stringify({ ...stored, beat: 0 } satisfies Stored)), undefined);
  }

  /** Forget the seat entirely (the player chose to leave the room). */
  forget(): void {
    safe(() => this.session?.removeItem(this.key), undefined);
    safe(() => this.local?.removeItem(this.key), undefined);
  }
}

/** Browser storages, or null where the browser refuses them (private mode, blocked cookies). */
export function browserStores(): { local: KV | null; session: KV | null } {
  return {
    local: safe(() => (typeof localStorage !== 'undefined' ? localStorage : null), null),
    session: safe(() => (typeof sessionStorage !== 'undefined' ? sessionStorage : null), null),
  };
}
