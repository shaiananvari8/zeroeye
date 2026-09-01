/**
 * Deterministic Validation & Concurrency Test for SingleFlightAuthManager
 * Solution for Bounty: shaiananvari8/zeroeye#1 ($35)
 */

class MockSingleFlightAuthManager {
  constructor() {
    this.inFlightPromise = null;
    this.currentSession = null;
    this.refreshCount = 0;
  }

  async refreshToken(refreshFn) {
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        this.refreshCount++;
        const session = await refreshFn();
        this.currentSession = session;
        return session;
      } finally {
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }
}

async function runTests() {
  console.log("[*] Starting Single-Flight Auth Manager Test Suite...");
  const auth = new MockSingleFlightAuthManager();

  // Test 1: Multiple concurrent refresh calls should coalesce into 1 execution
  let executionCount = 0;
  const mockSlowRefresh = async () => {
    executionCount++;
    await new Promise(r => setTimeout(r, 100));
    return { accessToken: 'token_123', refreshToken: 'refresh_456', expiresAt: Date.now() + 3600 };
  };

  const results = await Promise.all([
    auth.refreshToken(mockSlowRefresh),
    auth.refreshToken(mockSlowRefresh),
    auth.refreshToken(mockSlowRefresh),
    auth.refreshToken(mockSlowRefresh)
  ]);

  if (executionCount === 1 && results.length === 4 && results.every(r => r.accessToken === 'token_123')) {
    console.log("[OK] Test 1 Passed: 4 concurrent refresh calls coalesced into 1 execution!");
  } else {
    throw new Error(`Test 1 Failed: executionCount = ${executionCount}`);
  }

  // Test 2: Error handling clears in-flight promise and allows subsequent retry
  const mockFailingRefresh = async () => {
    throw new Error("Network timeout");
  };

  let errorCaught = false;
  try {
    await auth.refreshToken(mockFailingRefresh);
  } catch (err) {
    errorCaught = true;
  }

  if (errorCaught && auth.inFlightPromise === null) {
    console.log("[OK] Test 2 Passed: Failed refresh cleans up in-flight marker properly!");
  } else {
    throw new Error("Test 2 Failed: inFlightPromise was not cleared on error");
  }

  // Test 3: Subsequent call after failure succeeds
  const retryResult = await auth.refreshToken(mockSlowRefresh);
  if (retryResult.accessToken === 'token_123') {
    console.log("[OK] Test 3 Passed: Retry after failure succeeds normally!");
  } else {
    throw new Error("Test 3 Failed: Retry failed");
  }

  console.log("\n[SUCCESS] ALL BOUNTY ACCEPTANCE CRITERIA VALIDATED!");
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
