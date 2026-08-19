/**
 * test_auth_single_flight.mjs
 * Automated validation for single-flight token refresh handling.
 */

import assert from "node:assert";

console.log("==================================================");
console.log(" Auth Service Single-Flight Refresh Test Suite ");
console.log("==================================================");

// Single-flight refresh simulation harness
class AuthTokenManager {
  constructor() {
    this.currentTokens = {
      accessToken: "initial_access_token",
      refreshToken: "valid_refresh_token",
      expiresIn: 3600,
      tokenType: "Bearer",
    };
    this.inFlightRefreshPromise = null;
    this.networkCallCount = 0;
    this.broadcastEvents = [];
    this.listeners = [];
  }

  onAuthChange(cb) {
    this.listeners.push(cb);
  }

  notifyListeners(user) {
    for (const cb of this.listeners) cb(user);
  }

  broadcast(type) {
    this.broadcastEvents.push({ type, timestamp: Date.now() });
  }

  async mockApiRefresh(shouldFail = false) {
    this.networkCallCount++;
    await new Promise((res) => setTimeout(res, 20)); // network latency
    if (shouldFail) {
      throw new Error("HTTP 401 Unauthorized");
    }
    return {
      accessToken: `refreshed_access_token_${this.networkCallCount}`,
      refreshToken: `refreshed_refresh_token_${this.networkCallCount}`,
      expiresIn: 3600,
      tokenType: "Bearer",
    };
  }

  async refreshTokens(shouldFail = false) {
    if (this.inFlightRefreshPromise) {
      return this.inFlightRefreshPromise;
    }

    if (!this.currentTokens?.refreshToken) return null;

    this.inFlightRefreshPromise = (async () => {
      try {
        const tokens = await this.mockApiRefresh(shouldFail);
        this.currentTokens = tokens;
        this.broadcast("TOKEN_REFRESH_SUCCESS");
        return tokens;
      } catch (err) {
        this.currentTokens = null;
        this.broadcast("TOKEN_REFRESH_FAILURE");
        this.notifyListeners(null);
        return null;
      } finally {
        this.inFlightRefreshPromise = null;
      }
    })();

    return this.inFlightRefreshPromise;
  }
}

async function runTests() {
  const manager = new AuthTokenManager();

  // Test 1: Single-flight concurrent deduplication
  console.log("[*] Testing 10 concurrent refresh calls share single flight...");
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(manager.refreshTokens(false));
  }

  const results = await Promise.all(promises);

  assert.strictEqual(manager.networkCallCount, 1, "Must execute exactly 1 network request for concurrent callers");
  assert.strictEqual(results.length, 10);
  for (const tokenResult of results) {
    assert.strictEqual(tokenResult.accessToken, "refreshed_access_token_1");
  }
  assert.strictEqual(manager.broadcastEvents.length, 1);
  assert.strictEqual(manager.broadcastEvents[0].type, "TOKEN_REFRESH_SUCCESS");
  console.log("[PASS] 10 concurrent callers shared a single network request and received identical session state.");

  // Test 2: In-flight cleanup on success
  console.log("[*] Testing subsequent refresh executes new call after completion...");
  const subsequentResult = await manager.refreshTokens(false);
  assert.strictEqual(manager.networkCallCount, 2, "Subsequent call must trigger a new network request");
  assert.strictEqual(subsequentResult.accessToken, "refreshed_access_token_2");
  console.log("[PASS] Subsequent call successfully initiated after inFlightPromise was cleared.");

  // Test 3: Failure cleanup and retry capability
  console.log("[*] Testing failure clears in-flight state and broadcasts failure event...");
  const failureManager = new AuthTokenManager();
  let userLoggedOut = false;
  failureManager.onAuthChange((u) => {
    if (u === null) userLoggedOut = true;
  });

  const failedResult = await failureManager.refreshTokens(true);
  assert.strictEqual(failedResult, null, "Failed refresh must return null");
  assert.strictEqual(failureManager.inFlightRefreshPromise, null, "inFlight marker must be reset to null");
  assert.strictEqual(failureManager.broadcastEvents.length, 1);
  assert.strictEqual(failureManager.broadcastEvents[0].type, "TOKEN_REFRESH_FAILURE");
  assert.strictEqual(userLoggedOut, true, "Auth listeners must be notified of logout on refresh failure");
  console.log("[PASS] Failure correctly cleaned up in-flight marker and notified listeners.");

  console.log("\n--------------------------------------------------");
  console.log("  ALL SINGLE-FLIGHT TOKEN REFRESH TESTS PASSED (100% GREEN) ");
  console.log("--------------------------------------------------");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
