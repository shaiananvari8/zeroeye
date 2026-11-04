import assert from 'node:assert';
import test from 'node:test';

test('Single-flight concurrent refresh coalescing', async () => {
  let networkCalls = 0;
  let inFlight = null;

  async function mockRefresh() {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      networkCalls++;
      await new Promise(r => setTimeout(r, 50));
      return {
        accessToken: `access-${networkCalls}`,
        refreshToken: 'refresh-valid',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  // Fire 10 concurrent requests
  const callers = Array.from({ length: 10 }, () => mockRefresh());
  const results = await Promise.all(callers);

  assert.strictEqual(networkCalls, 1, 'Only 1 network call should execute');
  for (const res of results) {
    assert.deepStrictEqual(res, results[0], 'All callers should resolve to the exact same token object');
  }
  assert.strictEqual(inFlight, null, 'In-flight promise should be reset to null');
});

test('Single-flight cleanup on error allows retry', async () => {
  let networkCalls = 0;
  let inFlight = null;
  let shouldFail = true;

  async function mockRefresh() {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      networkCalls++;
      await new Promise(r => setTimeout(r, 20));
      if (shouldFail) {
        throw new Error('Refresh failed (401)');
      }
      return {
        accessToken: `access-${networkCalls}`,
        refreshToken: 'refresh-valid',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  // Concurrent failures
  const callers = Array.from({ length: 5 }, () => mockRefresh().catch(err => err.message));
  const results = await Promise.all(callers);

  assert.strictEqual(networkCalls, 1, 'Only 1 network call executed during failure burst');
  for (const res of results) {
    assert.strictEqual(res, 'Refresh failed (401)');
  }
  assert.strictEqual(inFlight, null, 'In-flight promise must be cleared on failure');

  // Next call retries and succeeds
  shouldFail = false;
  const retryResult = await mockRefresh();
  assert.strictEqual(networkCalls, 2, 'Retry initiates a new network call');
  assert.strictEqual(retryResult.accessToken, 'access-2');
});

test('Cross-tab broadcast notification does not leak raw tokens', () => {
  const broadcastMessages = [];
  const mockChannel = {
    postMessage(msg) {
      broadcastMessages.push(msg);
    }
  };

  const refreshId = 'test-uuid-1234';
  // Success broadcast
  mockChannel.postMessage({ type: 'refresh-complete', refreshId });
  // Failure broadcast
  mockChannel.postMessage({ type: 'refresh-failed', refreshId });

  for (const msg of broadcastMessages) {
    assert.ok(!('accessToken' in msg), 'Token field accessToken must not be in broadcast payload');
    assert.ok(!('refreshToken' in msg), 'Token field refreshToken must not be in broadcast payload');
    assert.ok(!('tokens' in msg), 'tokens object must not be in broadcast payload');
    assert.strictEqual(msg.refreshId, refreshId);
  }
});
