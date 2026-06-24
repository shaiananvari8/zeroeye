/**
 * Deterministic validation script for single-flight token refresh coordination.
 *
 * Run: node frontend/scripts/validate_singleflight.mjs
 *
 * Verifies:
 *   - Concurrent refresh callers share one in-flight operation (single POST).
 *   - Successful refresh clears the in-flight marker (next call is fresh).
 *   - Failed refresh clears the in-flight marker so a retry can proceed.
 *   - Cross-tab broadcast is emitted with success flag, never raw tokens.
 *   - No token value appears in broadcast payloads.
 */
import assert from 'node:assert';

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function check(cond, msg) {
  testsRun++;
  if (cond) { testsPassed++; console.log('PASS:', msg); }
  else { testsFailed++; console.log('FAIL:', msg); }
}

// ---- Single-flight refresher core (mirrors auth.ts logic) ----
function createSingleFlightRefresher(adapter) {
  let inFlight = null;

  return async function refresh() {
    if (inFlight) return inFlight;
    const exec = async () => {
      try {
        const data = await adapter.doRefresh();
        adapter.onSuccess(data);
        adapter.broadcast(true);
        return data;
      } catch (err) {
        adapter.onFailure();
        adapter.broadcast(false);
        return null;
      }
    };
    inFlight = exec();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}

// ---- Mocks ----
function makeMockAdapter({ fail = false, latency = 10 } = {}) {
  let postCount = 0;
  const broadcasts = [];
  let onSuccessCalls = 0;
  let onFailureCalls = 0;

  return {
    postCount: () => postCount,
    broadcasts: () => broadcasts,
    onSuccessCalls: () => onSuccessCalls,
    onFailureCalls: () => onFailureCalls,
    adapter: {
      doRefresh: async () => {
        postCount++;
        await new Promise(r => setTimeout(r, latency));
        if (fail) throw new Error('refresh failed');
        return { accessToken: 'new-access', refreshToken: 'new-refresh' };
      },
      onSuccess: (data) => { onSuccessCalls++; },
      onFailure: () => { onFailureCalls++; },
      broadcast: (ok) => { broadcasts.push(ok); },
    },
  };
}

async function main() {
  // Test 1: concurrent callers share one in-flight refresh
  {
    const mock = makeMockAdapter();
    const refresh = createSingleFlightRefresher(mock.adapter);
    const results = await Promise.all([
      refresh(), refresh(), refresh(), refresh(), refresh(),
    ]);
    check(mock.postCount() === 1, '5 concurrent calls -> 1 POST (single-flight)');
    check(results.every(r => r !== null), 'all 5 callers got a result');
    check(results.every(r => r.accessToken === 'new-access'), 'all got same token');
    check(mock.onSuccessCalls() === 1, 'onSuccess called once');
    check(mock.broadcasts().length === 1, 'one broadcast emitted');
    check(mock.broadcasts()[0] === true, 'broadcast success=true');
  }

  // Test 2: after success, in-flight cleared (next call is fresh)
  {
    const mock = makeMockAdapter();
    const refresh = createSingleFlightRefresher(mock.adapter);
    await refresh();
    await refresh();
    check(mock.postCount() === 2, 'two sequential calls -> 2 POSTs (in-flight cleared)');
  }

  // Test 3: failed refresh clears in-flight, retry succeeds
  {
    let attempt = 0;
    const broadcasts = [];
    const adapter = {
      doRefresh: async () => {
        attempt++;
        if (attempt === 1) throw new Error('fail');
        return { accessToken: 'ok', refreshToken: 'ok-r' };
      },
      onSuccess: () => {},
      onFailure: () => {},
      broadcast: (ok) => broadcasts.push(ok),
    };
    const refresh = createSingleFlightRefresher(adapter);
    const r1 = await refresh();
    check(r1 === null, 'failed refresh returns null');
    check(broadcasts[0] === false, 'failure broadcast success=false');
    const r2 = await refresh();
    check(r2 !== null, 'retry after failure succeeds');
    check(broadcasts[1] === true, 'success broadcast success=true');
  }

  // Test 4: concurrent callers during failure all get null, but only 1 POST
  {
    const mock = makeMockAdapter({ fail: true });
    const refresh = createSingleFlightRefresher(mock.adapter);
    const results = await Promise.all([refresh(), refresh(), refresh()]);
    check(mock.postCount() === 1, 'concurrent failure -> 1 POST');
    check(results.every(r => r === null), 'all got null on failure');
    check(mock.onFailureCalls() === 1, 'onFailure called once');
    check(mock.broadcasts().length === 1, 'one failure broadcast');
  }

  // Test 5: broadcast payload never contains raw token values
  {
    const mock = makeMockAdapter();
    const refresh = createSingleFlightRefresher(mock.adapter);
    await refresh();
    const broadcastPayload = JSON.stringify(mock.broadcasts());
    check(!broadcastPayload.includes('new-access'), 'broadcast has no accessToken');
    check(!broadcastPayload.includes('new-refresh'), 'broadcast has no refreshToken');
  }

  // Test 6: in-flight is null after completion (not stuck)
  {
    const mock = makeMockAdapter();
    const refresh = createSingleFlightRefresher(mock.adapter);
    await refresh();
    // call again immediately - should start a new refresh
    const before = mock.postCount();
    await refresh();
    check(mock.postCount() === before + 1, 'in-flight not stuck after completion');
  }

  console.log('\n=== Single-Flight Validation ===');
  console.log('Total:', testsRun, ' Passed:', testsPassed, ' Failed:', testsFailed);
  process.exit(testsFailed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
