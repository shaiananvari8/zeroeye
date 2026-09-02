/**
 * Cross-tab single-flight token refresh coordinator.
 *
 * Ensures that when multiple browser tabs attempt to refresh the access token
 * at the same time, only one HTTP refresh request is issued. All other tabs
 * wait for the in-flight refresh to complete and resolve from the same result.
 *
 * Coordination uses BroadcastChannel when available, with a localStorage-based
 * lock and result key as fallback for older browsers or private-mode tabs.
 */

const LOCK_KEY = 'tot_auth_refresh_lock';
const RESULT_KEY = 'tot_auth_refresh_result';
const LOCK_TTL_MS = 10000; // Max time a refresh should take
const CHANNEL_NAME = 'tot_auth_refresh';

export interface RefreshResult<T> {
  ok: boolean;
  value: T | null;
  error?: string;
}

interface LockEntry {
  ts: number;
  tabId: string;
}

interface ResultEntry<T> {
  ts: number;
  result: RefreshResult<T>;
}

function now(): number {
  return Date.now();
}

function generateTabId(): string {
  try {
    return `${now()}-${Math.random().toString(36).slice(2, 10)}`;
  } catch {
    return `${now()}`;
  }
}

const tabId: string = generateTabId();

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable (private mode, etc.)
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function isLockActive(): boolean {
  const lock = readJson<LockEntry>(LOCK_KEY);
  if (!lock) return false;
  return now() - lock.ts < LOCK_TTL_MS;
}

function acquireLock(): boolean {
  if (isLockActive()) return false;
  writeJson<LockEntry>(LOCK_KEY, { ts: now(), tabId });
  // Double-check we actually won (race with another tab)
  const lock = readJson<LockEntry>(LOCK_KEY);
  return lock?.tabId === tabId;
}

function releaseLock(): void {
  const lock = readJson<LockEntry>(LOCK_KEY);
  if (lock?.tabId === tabId) {
    removeKey(LOCK_KEY);
  }
}

function writeResult<T>(result: RefreshResult<T>): void {
  writeJson<ResultEntry<T>>(RESULT_KEY, { ts: now(), result });
}

function readResult<T>(): RefreshResult<T> | null {
  const entry = readJson<ResultEntry<T>>(RESULT_KEY);
  if (!entry) return null;
  // Results older than the lock TTL are stale
  if (now() - entry.ts > LOCK_TTL_MS * 2) return null;
  return entry.result;
}

function createChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel === 'function') {
      return new BroadcastChannel(CHANNEL_NAME);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Wait for a refresh result produced by another tab.
 * Uses BroadcastChannel + localStorage polling fallback.
 */
function waitForRefreshResult<T>(timeoutMs = LOCK_TTL_MS): Promise<RefreshResult<T>> {
  return new Promise((resolve) => {
    const deadline = now() + timeoutMs;
    let resolved = false;

    function finish(result: RefreshResult<T>) {
      if (resolved) return;
      resolved = true;
      resolve(result);
    }

    // BroadcastChannel fast path
    const channel = createChannel();
    if (channel) {
      channel.onmessage = (event) => {
        if (event?.data?.type === 'refresh-complete') {
          finish(event.data.result as RefreshResult<T>);
        }
      };
    }

    // Fallback: poll localStorage result key
    const pollInterval = 100;
    const timer = setInterval(() => {
      const result = readResult<T>();
      if (result) {
        finish(result);
      } else if (now() >= deadline) {
        finish({ ok: false, value: null, error: 'timeout waiting for refresh result' });
      }
    }, pollInterval);

    // Cleanup
    function cleanup() {
      clearInterval(timer);
      if (channel) {
        channel.onmessage = null;
        channel.close();
      }
    }

    // Resolve will be called once; ensure cleanup happens shortly after
    const cleanupTimer = setTimeout(cleanup, timeoutMs + 200);
    Promise.resolve().then(() => {
      // Hook into finish to clear timers
      const originalFinish = finish;
      // eslint-disable-next-line no-inner-declarations
      function finishWithCleanup(result: RefreshResult<T>) {
        cleanup();
        clearTimeout(cleanupTimer);
        originalFinish(result);
      }
      // Re-assign via object wrapper not needed; we just call cleanup inside a wrapper below
      // Keep implementation simple: already calls finish which already triggers cleanup via cleanupTimer
    }).catch(() => {});
  });
}

/**
 * Broadcast a refresh result to other tabs.
 */
function broadcastResult<T>(result: RefreshResult<T>): void {
  writeResult<T>(result);
  const channel = createChannel();
  if (channel) {
    try {
      channel.postMessage({ type: 'refresh-complete', result });
    } catch {
      // ignore
    } finally {
      channel.close();
    }
  }
}

/**
 * Execute a token refresh function with single-flight coordination across tabs.
 *
 * - If no other tab is refreshing, acquires the lock, runs refreshFn, stores/broadcasts
 *   the result, then releases the lock.
 * - If another tab is already refreshing, waits for its result and returns the same
 *   tokens (or null/error) without issuing a duplicate HTTP request.
 * - On failure, clears the lock so the next caller can retry.
 */
export async function withSingleFlightRefresh<T>(refreshFn: () => Promise<T>): Promise<T | null> {
  // Fast path: if a result is already available, use it
  const existingResult = readResult<T>();
  if (existingResult?.ok) {
    return existingResult.value;
  }

  if (isLockActive()) {
    const waited = await waitForRefreshResult<T>();
    if (waited.ok) return waited.value;
    // If the in-flight refresh failed, fall through and try ourselves
  }

  if (!acquireLock()) {
    // Lost the race; wait for the winner
    const waited = await waitForRefreshResult<T>();
    return waited.ok ? waited.value : null;
  }

  try {
    const value = await refreshFn();
    broadcastResult<T>({ ok: true, value });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'refresh failed';
    broadcastResult<T>({ ok: false, value: null, error: message });
    return null;
  } finally {
    releaseLock();
  }
}
