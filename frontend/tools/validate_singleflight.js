#!/usr/bin/env node
/**
 * Validation script for single-flight token refresh behavior.
 *
 * This script verifies that:
 * 1. Concurrent refresh calls share the same in-flight promise
 * 2. Failed refresh attempts clear the in-flight marker
 * 3. The in-flight promise resolves to the same result for all callers
 */

let inFlightRefresh = null;
let refreshCount = 0;
let shouldFail = false;

function fakeRefresh() {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    refreshCount++;
    await new Promise((r) => setTimeout(r, 50));
    if (shouldFail) {
      throw new Error("transient failure");
    }
    return { accessToken: "new-token-" + refreshCount, refreshToken: "new-refresh-" + refreshCount };
  })().finally(() => {
    inFlightRefresh = null;
  });

  return inFlightRefresh;
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      console.log(`  PASS: ${msg}`);
      passed++;
    } else {
      console.log(`  FAIL: ${msg}`);
      failed++;
    }
  }

  // Test 1: Concurrent calls share the same promise
  console.log("\nTest 1: Concurrent calls share the same in-flight promise");
  shouldFail = true;
  const p1 = fakeRefresh();
  const p2 = fakeRefresh();
  assert(p1 === p2, "p1 and p2 are the same promise reference");

  try {
    await p1;
  } catch {}
  try {
    await p2;
  } catch {}
  assert(refreshCount === 1, "Only one refresh was attempted");

  // Test 2: After failure, in-flight marker is cleared
  console.log("\nTest 2: In-flight marker cleared after failure");
  assert(inFlightRefresh === null, "inFlightRefresh is null after failure");

  // Test 3: Next call triggers a new refresh
  console.log("\nTest 3: Next call triggers new refresh after failure");
  shouldFail = false;
  const p3 = fakeRefresh();
  assert(p3 !== null, "New promise created after failure");
  const result = await p3;
  assert(result.accessToken === "new-token-2", "Second refresh succeeded with new token");

  // Test 4: Successful result is shared
  console.log("\nTest 4: Concurrent calls during success share result");
  inFlightRefresh = null;
  refreshCount = 0;
  shouldFail = false;
  const p4 = fakeRefresh();
  const p5 = fakeRefresh();
  const [r4, r5] = await Promise.all([p4, p5]);
  assert(r4 === r5, "Both callers got the same result object");
  assert(refreshCount === 1, "Only one refresh was attempted for concurrent success");

  // Test 5: After success, in-flight marker is cleared
  console.log("\nTest 5: In-flight marker cleared after success");
  assert(inFlightRefresh === null, "inFlightRefresh is null after success");

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
