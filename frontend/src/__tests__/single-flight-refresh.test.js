/**
 * Validation script for single-flight token refresh (Issue #1)
 * Run: node --test src/__tests__/single-flight-refresh.test.js
 */

let mockPostCalls = [];
let inflightRefresh = null;
const channelListeners = [];

class MockBroadcastChannel {
  postMessage(msg) {
    for (const fn of channelListeners) { try { fn({ data: msg }); } catch {} }
  }
  close() {}
}

function resetState() {
  mockPostCalls = [];
  inflightRefresh = null;
  channelListeners.length = 0;
}

async function simulatedRefreshTokens(tokens, options = {}) {
  if (!tokens?.refreshToken) return null;

  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async () => {
    try {
      // Yield once so the `inflightRefresh = promise` assignment below
      // completes before this body runs — mirrors real-world behavior
      // where the network post() always awaits.
      await Promise.resolve();
      // Record the attempt BEFORE failure simulation — a real POST is sent either way
      mockPostCalls.push({ url: '/auth/refresh', body: { refreshToken: tokens.refreshToken } });
      if (options.delay) await new Promise(r => setTimeout(r, options.delay));
      if (options.shouldFail) throw new Error('Network error');

      const result = options.newTokens ?? {
        accessToken: 'new_access_' + Date.now(),
        refreshToken: tokens.refreshToken,
        expiresIn: 900,
        tokenType: 'Bearer',
      };

      const ch = new MockBroadcastChannel();
      ch.postMessage({ type: 'refresh-success' });
      ch.close();

      return result;
    } catch (error) {
      const ch = new MockBroadcastChannel();
      ch.postMessage({ type: 'refresh-failed' });
      ch.close();
      throw error;
    } finally {
      inflightRefresh = null;
    }
  })();

  try {
    return await inflightRefresh;
  } catch {
    return null;
  }
}

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

describe('Single-Flight Token Refresh', () => {
  beforeEach(() => resetState());

  it('returns null when no tokens exist', async () => {
    const r = await simulatedRefreshTokens(null);
    assert.equal(r, null);
    assert.equal(inflightRefresh, null);
  });

  it('returns null when no refreshToken', async () => {
    const r = await simulatedRefreshTokens({
      accessToken: 'abc', refreshToken: '', expiresIn: 300, tokenType: 'Bearer',
    });
    assert.equal(r, null);
  });

  it('performs successful refresh and returns new tokens', async () => {
    const tokens = { accessToken: 'old', refreshToken: 'rf1', expiresIn: 300, tokenType: 'Bearer' };
    const newT = { accessToken: 'fresh_token', refreshToken: 'rf1', expiresIn: 900, tokenType: 'Bearer' };
    const r = await simulatedRefreshTokens(tokens, { newTokens: newT });
    assert.ok(r !== null);
    assert.equal(r.accessToken, 'fresh_token');
    assert.equal(mockPostCalls.length, 1);
    assert.equal(inflightRefresh, null);
  });

  it('shares in-flight promise for concurrent callers (single API call)', async () => {
    const tokens = { accessToken: 'old', refreshToken: 'shared', expiresIn: 300, tokenType: 'Bearer' };
    const newT = { accessToken: 'concurrent', refreshToken: 'shared', expiresIn: 900, tokenType: 'Bearer' };

    const p1 = simulatedRefreshTokens(tokens, { delay: 50, newTokens: newT });
    const p2 = simulatedRefreshTokens(tokens, { delay: 50, newTokens: newT });
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.accessToken, 'concurrent');
    assert.equal(r2.accessToken, 'concurrent');
    assert.equal(mockPostCalls.length, 1); // single-flight!
  });

  it('clears in-flight marker on failure so next call can retry', async () => {
    const tokens = { accessToken: 'old', refreshToken: 'fail1', expiresIn: 300, tokenType: 'Bearer' };

    const r1 = await simulatedRefreshTokens(tokens, { shouldFail: true });
    assert.equal(r1, null);
    assert.equal(inflightRefresh, null);

    const retryT = { accessToken: 'retry_ok', refreshToken: 'fail1', expiresIn: 900, tokenType: 'Bearer' };
    const r2 = await simulatedRefreshTokens(tokens, { newTokens: retryT });
    assert.ok(r2 !== null);
    assert.equal(r2.accessToken, 'retry_ok');
    assert.equal(mockPostCalls.length, 2);
  });

  it('allows sequential refreshes after previous completes', async () => {
    const tokens = { accessToken: 'old', refreshToken: 'seq1', expiresIn: 300, tokenType: 'Bearer' };
    const newT = { accessToken: 'seq_ok', refreshToken: 'seq1', expiresIn: 900, tokenType: 'Bearer' };

    const r1 = await simulatedRefreshTokens(tokens, { delay: 10, newTokens: newT });
    assert.ok(r1 !== null);

    const r2 = await simulatedRefreshTokens(tokens, { delay: 10, newTokens: newT });
    assert.ok(r2 !== null);

    assert.equal(mockPostCalls.length, 2);
  });

  it('broadcasts success via BroadcastChannel', async () => {
    let received = null;
    channelListeners.push((event) => { received = event.data; });

    const tokens = { accessToken: 'old', refreshToken: 'bc1', expiresIn: 300, tokenType: 'Bearer' };
    await simulatedRefreshTokens(tokens);

    assert.ok(received !== null);
    assert.equal(received.type, 'refresh-success');
  });

  it('broadcasts failure via BroadcastChannel', async () => {
    let received = null;
    channelListeners.push((event) => { received = event.data; });

    const tokens = { accessToken: 'old', refreshToken: 'bcf1', expiresIn: 300, tokenType: 'Bearer' };
    await simulatedRefreshTokens(tokens, { shouldFail: true });

    assert.ok(received !== null);
    assert.equal(received.type, 'refresh-failed');
  });
});
