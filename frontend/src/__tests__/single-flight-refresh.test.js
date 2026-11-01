/**
 * Unit Test Suite for Single-Flight Token Refresh & Cross-Tab Sync
 * Validates:
 * 1. Concurrent calls share one in-flight refresh operation (deduplication).
 * 2. Failed refresh clears in-flight marker allowing subsequent retry.
 * 3. BroadcastChannel message propagation without raw tokens.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('Single-Flight Token Refresh Coordination', () => {
  let apiCallCount = 0;
  let shouldFail = false;
  let broadcastMessages = [];

  // Mock BroadcastChannel
  globalThis.BroadcastChannel = class MockBroadcastChannel {
    constructor(channelName) {
      this.channelName = channelName;
      this.onmessage = null;
    }
    postMessage(data) {
      broadcastMessages.push(data);
    }
    close() {}
  };

  // Mock localStorage
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) || null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };

  // Simulated single-flight coordinator matching auth.ts architecture
  let refreshInFlight = null;

  async function mockApiRefresh(refreshToken) {
    apiCallCount++;
    await new Promise((r) => setTimeout(r, 20));
    if (shouldFail) {
      throw new Error('Network error during refresh');
    }
    return {
      accessToken: 'new_access_token_' + apiCallCount,
      refreshToken: 'new_refresh_token_' + apiCallCount,
      expiresIn: 3600,
      tokenType: 'Bearer',
    };
  }

  async function executeRefreshTokens(refreshToken) {
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      try {
        const tokens = await mockApiRefresh(refreshToken);
        const channel = new BroadcastChannel('tot_auth_sync');
        channel.postMessage({ type: 'REFRESH_SUCCESS', timestamp: Date.now() });
        return tokens;
      } catch (err) {
        const channel = new BroadcastChannel('tot_auth_sync');
        channel.postMessage({ type: 'REFRESH_FAILURE', timestamp: Date.now() });
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();

    return refreshInFlight;
  }

  beforeEach(() => {
    apiCallCount = 0;
    shouldFail = false;
    broadcastMessages = [];
    refreshInFlight = null;
    storage.clear();
  });

  test('collapses concurrent refresh callers into a single API invocation', async () => {
    const promises = [
      executeRefreshTokens('mock_refresh_token'),
      executeRefreshTokens('mock_refresh_token'),
      executeRefreshTokens('mock_refresh_token'),
      executeRefreshTokens('mock_refresh_token'),
    ];

    const results = await Promise.all(promises);

    // Exactly 1 API call made despite 4 simultaneous callers
    assert.equal(apiCallCount, 1, 'Expected exactly 1 API call for concurrent requests');

    // All callers resolved with the exact same token reference
    assert.ok(results[0]?.accessToken);
    assert.equal(results[0].accessToken, results[1].accessToken);
    assert.equal(results[0].accessToken, results[2].accessToken);
    assert.equal(results[0].accessToken, results[3].accessToken);

    // BroadcastChannel emitted notification without secret tokens
    assert.equal(broadcastMessages.length, 1);
    assert.equal(broadcastMessages[0].type, 'REFRESH_SUCCESS');
    assert.equal(broadcastMessages[0].accessToken, undefined);
    assert.equal(broadcastMessages[0].refreshToken, undefined);
  });

  test('clears in-flight marker on failure allowing clean retry', async () => {
    shouldFail = true;

    // First attempt fails
    const failedResult = await executeRefreshTokens('mock_refresh_token');
    assert.equal(failedResult, null);
    assert.equal(apiCallCount, 1);
    assert.equal(broadcastMessages[0].type, 'REFRESH_FAILURE');

    // Second attempt should not be blocked and can succeed
    shouldFail = false;
    const retryResult = await executeRefreshTokens('mock_refresh_token');
    assert.ok(retryResult?.accessToken);
    assert.equal(apiCallCount, 2);
    assert.equal(broadcastMessages[1].type, 'REFRESH_SUCCESS');
  });
});
