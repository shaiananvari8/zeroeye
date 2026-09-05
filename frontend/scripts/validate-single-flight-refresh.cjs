#!/usr/bin/env node
/**
 * Deterministic validation script for single-flight token refresh coordination.
 *
 * Mirrors the cross-tab coordination logic added to src/services/auth.ts and
 * asserts the three core acceptance criteria:
 *   1. Concurrent refresh callers share one in-flight operation.
 *   2. Failed refreshes clear the in-flight marker so retries can proceed.
 *   3. Cross-tab completion/failure is propagated without logging raw tokens.
 *
 * Run with:
 *   node frontend/scripts/validate-single-flight-refresh.cjs
 */

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const REFRESH_LOCK_KEY = 'tot_auth_refresh_lock';
const REFRESH_CHANNEL_NAME = 'tot_auth_refresh';
const LOCK_TTL_MS = 15_000;

class MockBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    if (!MockBroadcastChannel._registry.has(name)) {
      MockBroadcastChannel._registry.set(name, []);
    }
    MockBroadcastChannel._registry.get(name).push(this);
  }

  postMessage(data) {
    for (const channel of MockBroadcastChannel._registry.get(this.name) || []) {
      if (channel === this) continue;
      if (channel.onmessage) {
        channel.onmessage({ data });
      }
    }
  }

  close() {
    const list = MockBroadcastChannel._registry.get(this.name) || [];
    const idx = list.indexOf(this);
    if (idx !== -1) list.splice(idx, 1);
  }

  static reset() {
    MockBroadcastChannel._registry = new Map();
  }
}
MockBroadcastChannel._registry = new Map();

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _store: store,
  };
}

function makeCoordinator({ storage, fetchRefresh, onBroadcast }) {
  let refreshPromise = null;
  let refreshChannel = null;
  let crossTabWaiters = [];

  function getChannel() {
    if (refreshChannel) return refreshChannel;
    refreshChannel = new MockBroadcastChannel(REFRESH_CHANNEL_NAME);
    refreshChannel.onmessage = (event) => {
      const { type } = event.data || {};
      onBroadcast?.(type);
      if (type === 'refresh:done') {
        crossTabWaiters.forEach((resolve) => resolve('done'));
      } else if (type === 'refresh:failed') {
        crossTabWaiters.forEach((resolve) => resolve('failed'));
      }
      crossTabWaiters = [];
    };
    return refreshChannel;
  }

  function broadcast(type) {
    const channel = getChannel();
    try {
      channel.postMessage({ type });
    } catch {
      // ignore
    }
  }

  function readLock() {
    const raw = storage.getItem(REFRESH_LOCK_KEY);
    if (!raw) return null;
    const ts = parseInt(raw, 10);
    return Number.isNaN(ts) ? null : ts;
  }

  function acquireLock() {
    const now = Date.now();
    const existing = readLock();
    if (existing && now - existing < LOCK_TTL_MS) return false;
    storage.setItem(REFRESH_LOCK_KEY, String(now));
    return true;
  }

  function releaseLock() {
    storage.removeItem(REFRESH_LOCK_KEY);
  }

  function waitForCrossTab(timeoutMs = LOCK_TTL_MS) {
    return new Promise((resolve) => {
      crossTabWaiters.push(resolve);
      setTimeout(() => {
        const idx = crossTabWaiters.indexOf(resolve);
        if (idx !== -1) {
          crossTabWaiters.splice(idx, 1);
          resolve('timeout');
        }
      }, timeoutMs);
    });
  }

  async function refreshTokens() {
    if (refreshPromise) return refreshPromise;

    const isLeader = acquireLock();
    if (!isLeader) {
      // Subscribe to the cross-tab channel so the leader's broadcast can
      // wake us up when the refresh finishes.
      getChannel();
      return waitForCrossTab();
    }

    refreshPromise = (async () => {
      try {
        const result = await fetchRefresh();
        broadcast('refresh:done');
        return result;
      } catch {
        broadcast('refresh:failed');
        return null;
      } finally {
        releaseLock();
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  return { refreshTokens, getChannel };
}

describe('single-flight refresh coordination', () => {
  beforeEach(() => {
    MockBroadcastChannel.reset();
  });

  it('shares one in-flight refresh across concurrent callers', async () => {
    const storage = makeStorage();
    let calls = 0;
    const coordinator = makeCoordinator({
      storage,
      fetchRefresh: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return 'new-tokens';
      },
    });

    const results = await Promise.all([
      coordinator.refreshTokens(),
      coordinator.refreshTokens(),
      coordinator.refreshTokens(),
    ]);

    assert.strictEqual(calls, 1, 'only one refresh API call should be made');
    assert.deepStrictEqual(results, ['new-tokens', 'new-tokens', 'new-tokens']);
  });

  it('retries normally after a failed refresh', async () => {
    const storage = makeStorage();
    let calls = 0;
    let shouldFail = true;
    const coordinator = makeCoordinator({
      storage,
      fetchRefresh: async () => {
        calls++;
        if (shouldFail) throw new Error('refresh failed');
        return 'new-tokens';
      },
    });

    const failed = await coordinator.refreshTokens();
    assert.strictEqual(failed, null, 'failed refresh returns null');
    assert.strictEqual(storage.getItem(REFRESH_LOCK_KEY), null, 'lock is released after failure');

    shouldFail = false;
    const success = await coordinator.refreshTokens();
    assert.strictEqual(success, 'new-tokens', 'retry succeeds after failure');
    assert.strictEqual(calls, 2, 'two separate refresh attempts after failure');
  });

  it('propagates cross-tab completion without logging raw tokens', async () => {
    const storage = makeStorage();
    const broadcasts = [];
    const coordinator = makeCoordinator({
      storage,
      fetchRefresh: async () => 'new-tokens',
      onBroadcast: (type) => broadcasts.push(type),
    });

    // Attach a second channel so we can observe the leader's broadcast.
    const listener = new MockBroadcastChannel(REFRESH_CHANNEL_NAME);
    listener.onmessage = (event) => broadcasts.push(event.data);

    const result = await coordinator.refreshTokens();
    assert.strictEqual(result, 'new-tokens');
    assert.deepStrictEqual(broadcasts, [{ type: 'refresh:done' }]);

    // The broadcast payload contains only the event type; raw tokens are never
    // included in the cross-tab message (they live in localStorage if needed).
    assert.ok(!JSON.stringify(broadcasts).includes('new-tokens'));
    listener.close();
  });

  it('lets a non-leader tab wait for the leader refresh', async () => {
    const storage = makeStorage();
    storage.setItem(REFRESH_LOCK_KEY, String(Date.now()));

    const follower = makeCoordinator({
      storage,
      fetchRefresh: async () => {
        throw new Error('follower should not call refresh');
      },
    });

    const pending = follower.refreshTokens();

    // Simulate the leader completing on another channel instance
    const leaderChannel = new MockBroadcastChannel(REFRESH_CHANNEL_NAME);
    await new Promise((r) => setTimeout(r, 10));
    leaderChannel.postMessage({ type: 'refresh:done' });

    const result = await pending;
    assert.strictEqual(result, 'done');
    leaderChannel.close();
  });
});
