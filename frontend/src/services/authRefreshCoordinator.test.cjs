/**
 * Deterministic validation for single-flight token refresh coordination.
 * Mocks localStorage and BroadcastChannel, then verifies that concurrent
 * refresh callers share one in-flight operation and resolve from the same result.
 *
 * Run with: node frontend/src/services/authRefreshCoordinator.test.js
 */

const assert = require('assert');

// Mock localStorage
const storage = new Map();
const mockLocalStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
global.localStorage = mockLocalStorage;

// Mock BroadcastChannel
const channels = new Map();
class MockBroadcastChannel {
  constructor(name) {
    this.name = name;
    if (!channels.has(name)) channels.set(name, []);
    channels.get(name).push(this);
  }

  postMessage(data) {
    const listeners = channels.get(this.name) || [];
    listeners.forEach((ch) => {
      if (ch !== this && typeof ch.onmessage === 'function') {
        ch.onmessage({ data });
      }
    });
  }

  close() {
    const list = channels.get(this.name) || [];
    const idx = list.indexOf(this);
    if (idx >= 0) list.splice(idx, 1);
  }
}
global.BroadcastChannel = MockBroadcastChannel;

const { withSingleFlightRefresh } = require('./authRefreshCoordinator.cjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  let refreshCount = 0;

  function makeRefresh(value, delayMs = 50, shouldFail = false) {
    return async () => {
      refreshCount += 1;
      await sleep(delayMs);
      if (shouldFail) throw new Error('network error');
      return value;
    };
  }

  // Test 1: concurrent callers share a single refresh
  storage.clear();
  refreshCount = 0;
  const refreshFn = makeRefresh('token-abc', 50);
  const results = await Promise.all([
    withSingleFlightRefresh(refreshFn),
    withSingleFlightRefresh(refreshFn),
    withSingleFlightRefresh(refreshFn),
  ]);
  assert.strictEqual(refreshCount, 1, 'Expected exactly one refresh for concurrent callers');
  assert.deepStrictEqual(results, ['token-abc', 'token-abc', 'token-abc']);
  console.log('✓ Test 1 passed: concurrent callers share one refresh');

  // Test 2: a second caller after success reuses the cached result without refreshing
  refreshCount = 0;
  const result2 = await withSingleFlightRefresh(refreshFn);
  assert.strictEqual(refreshCount, 0, 'Expected no refresh when cached result exists');
  assert.strictEqual(result2, 'token-abc');
  console.log('✓ Test 2 passed: cached result reused');

  // Test 3: failure clears the lock so a later refresh can retry
  storage.clear();
  refreshCount = 0;
  const failingRefresh = makeRefresh('token-xyz', 30, true);
  const failResult = await withSingleFlightRefresh(failingRefresh);
  assert.strictEqual(failResult, null, 'Expected null on refresh failure');

  // Wait for lock to expire before retry
  await sleep(20);
  const retryRefresh = makeRefresh('token-retry', 30);
  const retryResult = await withSingleFlightRefresh(retryRefresh);
  assert.strictEqual(refreshCount, 2, 'Expected retry after failure');
  assert.strictEqual(retryResult, 'token-retry');
  console.log('✓ Test 3 passed: failure allows retry');

  // Test 4: sequential callers with stale result issue a new refresh
  storage.clear();
  refreshCount = 0;
  const seq1 = await withSingleFlightRefresh(makeRefresh('token-seq1', 30));
  // Manually age the result beyond its TTL
  const resultEntry = JSON.parse(storage.get('tot_auth_refresh_result'));
  resultEntry.ts -= 30000;
  storage.set('tot_auth_refresh_result', JSON.stringify(resultEntry));
  const seq2 = await withSingleFlightRefresh(makeRefresh('token-seq2', 30));
  assert.strictEqual(refreshCount, 2, 'Expected new refresh after stale result');
  assert.strictEqual(seq1, 'token-seq1');
  assert.strictEqual(seq2, 'token-seq2');
  console.log('✓ Test 4 passed: stale result triggers new refresh');

  console.log('\nAll single-flight refresh validation tests passed.');
}

runTests().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
