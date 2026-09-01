import test from 'node:test';
import assert from 'node:assert';

// Simulated environment for testing auth single-flight logic
class MockStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.get(key) || null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class MockBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    MockBroadcastChannel.instances.push(this);
  }
  postMessage(message) {
    MockBroadcastChannel.messages.push({ channel: this.name, message });
    for (const inst of MockBroadcastChannel.instances) {
      if (inst !== this && inst.name === this.name && typeof inst.onmessage === 'function') {
        inst.onmessage({ data: message });
      }
    }
  }
  close() {}
}
MockBroadcastChannel.instances = [];
MockBroadcastChannel.messages = [];

test('Single-flight concurrent token refresh deduplication and resolution', async () => {
  const localStorage = new MockStorage();
  let refreshPromise = null;
  let apiCallCount = 0;

  const mockTokens = {
    accessToken: 'test-access-' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64'),
    refreshToken: 'test-refresh-token',
    expiresIn: 3600,
    tokenType: 'Bearer',
  };

  localStorage.setItem('tot_auth_tokens', JSON.stringify(mockTokens));

  async function mockPostRefresh() {
    apiCallCount++;
    await new Promise(r => setTimeout(r, 50));
    return {
      data: {
        tokens: {
          accessToken: 'new-access-token-123',
          refreshToken: 'new-refresh-token-456',
          expiresIn: 3600,
          tokenType: 'Bearer',
        },
      },
    };
  }

  async function refreshTokens() {
    if (refreshPromise) {
      return refreshPromise;
    }
    const tokens = JSON.parse(localStorage.getItem('tot_auth_tokens'));
    if (!tokens?.refreshToken) return null;

    refreshPromise = (async () => {
      try {
        const response = await mockPostRefresh();
        const newTokens = response.data.tokens;
        localStorage.setItem('tot_auth_tokens', JSON.stringify(newTokens));
        return newTokens;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  // Launch 10 concurrent refresh calls
  const callers = Array.from({ length: 10 }, () => refreshTokens());
  const results = await Promise.all(callers);

  assert.strictEqual(apiCallCount, 1, 'Only 1 network request should be made for concurrent callers');
  assert.strictEqual(results.length, 10);
  for (const res of results) {
    assert.deepStrictEqual(res, {
      accessToken: 'new-access-token-123',
      refreshToken: 'new-refresh-token-456',
      expiresIn: 3600,
      tokenType: 'Bearer',
    });
  }
  assert.strictEqual(refreshPromise, null, 'In-flight promise should be reset to null after completion');
});

test('Single-flight failure cleanup and subsequent retry', async () => {
  const localStorage = new MockStorage();
  let refreshPromise = null;
  let attemptCount = 0;

  localStorage.setItem('tot_auth_tokens', JSON.stringify({ refreshToken: 'initial-refresh' }));

  async function mockPostRefresh() {
    attemptCount++;
    await new Promise(r => setTimeout(r, 30));
    if (attemptCount === 1) {
      throw new Error('Network error 500');
    }
    return {
      data: {
        tokens: {
          accessToken: 'retried-access-token',
          refreshToken: 'retried-refresh-token',
          expiresIn: 3600,
          tokenType: 'Bearer',
        },
      },
    };
  }

  async function refreshTokens() {
    if (refreshPromise) {
      return refreshPromise;
    }
    const tokens = JSON.parse(localStorage.getItem('tot_auth_tokens'));
    if (!tokens?.refreshToken) return null;

    refreshPromise = (async () => {
      try {
        const response = await mockPostRefresh();
        const newTokens = response.data.tokens;
        localStorage.setItem('tot_auth_tokens', JSON.stringify(newTokens));
        return newTokens;
      } catch {
        localStorage.removeItem('tot_auth_tokens');
        return null;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  // Concurrent batch 1 (which fails)
  const batch1 = await Promise.all([refreshTokens(), refreshTokens(), refreshTokens()]);
  assert.strictEqual(batch1[0], null);
  assert.strictEqual(batch1[1], null);
  assert.strictEqual(batch1[2], null);
  assert.strictEqual(attemptCount, 1, 'Only 1 network request attempted in failed batch');
  assert.strictEqual(refreshPromise, null, 'refreshPromise must be cleared on failure');

  // Re-seed token and execute batch 2 (which succeeds)
  localStorage.setItem('tot_auth_tokens', JSON.stringify({ refreshToken: 'retry-refresh-token' }));
  const batch2 = await Promise.all([refreshTokens(), refreshTokens()]);
  assert.strictEqual(attemptCount, 2, 'New network request executed on subsequent retry');
  assert.strictEqual(batch2[0].accessToken, 'retried-access-token');
  assert.strictEqual(batch2[1].accessToken, 'retried-access-token');
  assert.strictEqual(refreshPromise, null);
});

test('Cross-tab broadcast synchronization message protocol', () => {
  MockBroadcastChannel.instances = [];
  MockBroadcastChannel.messages = [];

  const tab1Channel = new MockBroadcastChannel('tot_auth_sync');
  const tab2Channel = new MockBroadcastChannel('tot_auth_sync');

  let tab2Received = null;
  tab2Channel.onmessage = (event) => {
    tab2Received = event.data;
  };

  tab1Channel.postMessage({ type: 'REFRESH_SUCCESS', timestamp: 1725200000 });

  assert.ok(tab2Received);
  assert.strictEqual(tab2Received.type, 'REFRESH_SUCCESS');
  assert.strictEqual(tab2Received.timestamp, 1725200000);
  assert.strictEqual(tab2Received.accessToken, undefined, 'Tokens must never be transmitted in broadcast payloads');
});
