/**
 * Single-flight token renewal. Web Locks serialize refreshes between tabs
 * where supported; a localStorage lease is a best-effort fallback where
 * Web Locks are unavailable. Cross-tab events never contain credentials.
 *
 * The auth service owns persistence, notifications and logout handling.
 */
export interface RefreshableTokens {
  accessToken: string;
  refreshToken: string;
}
export type RefreshEvent = 'success' | 'failure';
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface RefreshCoordinatorOptions<T extends RefreshableTokens> {
  read(): T | null;
  request(tokens: T): Promise<T>;
  save(tokens: T): void;
  clear(): void;
  publish(event: RefreshEvent): void;
  locks?(): LockManagerLike | undefined;
  storage?(): StorageLike | undefined;
  wait?(milliseconds: number): Promise<void>;
  now?(): number;
  ownerId?: string;
}

const LOCK_KEY = 'tot_auth_refresh_lease';
const LOCK_NAME = 'tot_auth_refresh';
// The API transport times out after 30 s; allow a 15 s margin.
const LEASE_MS = 45_000;
const WAIT_MS = 35;

function different<T extends RefreshableTokens>(a: T | null, b: T): boolean {
  return !a || a.accessToken !== b.accessToken || a.refreshToken !== b.refreshToken;
}

export function createRefreshCoordinator<T extends RefreshableTokens>(
  options: RefreshCoordinatorOptions<T>,
): () => Promise<T | null> {
  let inFlight: Promise<T | null> | null = null;
  const owner = options.ownerId ?? `refresh-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  // Called inside the lock; re-read persisted state to avoid duplicate refresh.
  async function work(initial: T): Promise<T | null> {
    const current = options.read();
    if (different(current, initial)) return current; // Other tab refreshed or logged out.

    try {
      const renewed = await options.request(current!);
      const latest = options.read();
      // Late success must not undo a logout or newer login/session.
      if (different(latest, current!)) return latest;
      options.save(renewed);
      options.publish('success');
      return renewed;
    } catch {
      const latest = options.read();
      // Do not clear credentials installed by another tab during the request.
      if (different(latest, current!)) return latest;
      options.clear();
      options.publish('failure');
      return null;
    }
  }

  function storage(): StorageLike | undefined {
    try { return options.storage?.(); } catch { return undefined; }
  }

  function readLease(store: StorageLike): { owner: string; until: number } | null {
    try {
      const raw = store.getItem(LOCK_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || !parsed) return null;
      const lease = parsed as { owner?: unknown; until?: unknown };
      return typeof lease.owner === 'string' && typeof lease.until === 'number'
        ? { owner: lease.owner, until: lease.until }
        : null;
    } catch { return null; }
  }

  async function withStorageLease(initial: T): Promise<T | null> {
    const store = storage();
    if (!store) return work(initial); // Storage disabled: only in-tab single-flight.

    for (;;) {
      const latest = options.read();
      if (different(latest, initial)) return latest;
      const active = readLease(store);
      if (!active || active.until <= now()) {
        try {
          store.setItem(LOCK_KEY, JSON.stringify({ owner, until: now() + LEASE_MS }));
          // Best effort only: localStorage does NOT provide atomic compare-and-swap.
          await wait(WAIT_MS);
          if (readLease(store)?.owner === owner) {
            try { return await work(initial); }
            finally {
              if (readLease(store)?.owner === owner) {
                try { store.removeItem(LOCK_KEY); } catch { /* storage denied */ }
              }
            }
          }
        } catch {
          return work(initial);
        }
      }
      await wait(WAIT_MS);
    }
  }

  async function run(initial: T): Promise<T | null> {
    const locks = options.locks?.();
    if (locks) return locks.request(LOCK_NAME, () => work(initial));
    return withStorageLease(initial);
  }

  return function refresh(): Promise<T | null> {
    if (inFlight) return inFlight;
    const initial = options.read();
    if (!initial?.refreshToken) return Promise.resolve(null);
    const pending = run(initial);
    const tracked = pending.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };
}
