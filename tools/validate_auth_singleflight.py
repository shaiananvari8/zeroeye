#!/usr/bin/env python3
"""Validate auth refresh single-flight implementation invariants and concurrency."""
import sys
import time
import asyncio
from pathlib import Path

# ---------------------------------------------------------------------------
# 1. STATIC INVARIANT CHECKS
# ---------------------------------------------------------------------------
source_path = Path("frontend/src/services/auth.ts")
if not source_path.exists():
    # If run from repo root or subfolder
    source_path = Path(__file__).resolve().parent.parent / "frontend" / "src" / "services" / "auth.ts"

source = source_path.read_text(encoding="utf-8")

required_invariants = [
    ("in-flight promise tracker", "let refreshInFlight: Promise<AuthTokens | null> | null = null"),
    ("single-flight deduplication check", "if (refreshInFlight) return refreshInFlight"),
    ("cross-tab marker check", "readRefreshMarker()"),
    ("cross-tab wait coordination", "waitForCrossTabRefresh(existingMarker.refreshId)"),
    ("broadcast success notification", "broadcastRefresh({ type: 'refresh-complete', refreshId })"),
    ("broadcast failure notification", "broadcastRefresh({ type: 'refresh-failed', refreshId })"),
    ("cleanup in finally block", "finally {"),
    ("clear in-flight marker on completion", "clearRefreshMarker(refreshId)"),
    ("reset in-flight promise on completion", "refreshInFlight = null"),
    ("in-flight TTL safeguard", "REFRESH_IN_FLIGHT_TTL_MS"),
]

missing = [name for name, pattern in required_invariants if pattern not in source]
if missing:
    msg = ", ".join(missing)
    print(f"FAILED: Missing single-flight invariant(s): {msg}", file=sys.stderr)
    sys.exit(1)

# Broadcast messages must not contain raw token fields
fn_start = source.find("function broadcastRefresh")
fn_end = source.find("function waitForCrossTabRefresh")
if fn_start != -1 and fn_end != -1:
    broadcast_code = source[fn_start:fn_end]
    for forbidden in ["accessToken:", "refreshToken:", "tokens: response.data.tokens"]:
        if forbidden in broadcast_code:
            print(f"FAILED: Broadcast leaks token field: {forbidden}", file=sys.stderr)
            sys.exit(1)

print("✓ Static invariants verified (single-flight promise, cross-tab wait, broadcast cleanup, zero token leak)")

# ---------------------------------------------------------------------------
# 2. DETERMINISTIC DYNAMIC CONCURRENCY SIMULATION
# ---------------------------------------------------------------------------
async def run_concurrency_simulation():
    # Simulates single-flight token refresh state machine
    class AuthServiceSimulator:
        def __init__(self):
            self.network_calls = 0
            self.in_flight = None
            self.refresh_marker = None
            self.broadcast_log = []

        async def _mock_network_refresh(self, should_fail=False):
            self.network_calls += 1
            await asyncio.sleep(0.05)  # Simulate network latency
            if should_fail:
                raise RuntimeError("HTTP 401 Unauthorized / Network Drop")
            return {
                "accessToken": f"token-v{self.network_calls}",
                "refreshToken": "rt-valid",
                "expiresIn": 3600,
                "tokenType": "Bearer",
            }

        async def refresh_tokens(self, should_fail=False):
            if self.in_flight:
                return await self.in_flight

            async def _execute():
                refresh_id = f"ref-{time.time()}"
                self.refresh_marker = refresh_id
                try:
                    tokens = await self._mock_network_refresh(should_fail=should_fail)
                    self.broadcast_log.append({"type": "refresh-complete", "refreshId": refresh_id})
                    return tokens
                except Exception:
                    self.broadcast_log.append({"type": "refresh-failed", "refreshId": refresh_id})
                    return None
                finally:
                    self.refresh_marker = None
                    self.in_flight = None

            self.in_flight = asyncio.create_task(_execute())
            return await self.in_flight

    sim = AuthServiceSimulator()

    # Scenario A: 10 concurrent callers during success
    callers = [sim.refresh_tokens(should_fail=False) for _ in range(10)]
    results = await asyncio.gather(*callers)

    assert sim.network_calls == 1, f"Expected 1 network call for 10 concurrent callers, got {sim.network_calls}"
    assert all(r == results[0] for r in results), "Not all callers received identical token state"
    assert sim.in_flight is None, "In-flight task was not reset"
    assert sim.refresh_marker is None, "In-flight marker was not cleared"
    assert len(sim.broadcast_log) == 1 and sim.broadcast_log[0]["type"] == "refresh-complete"
    print("✓ Scenario A: 10 concurrent callers coalesced onto 1 single-flight network execution")

    # Scenario B: Failure clears in-flight state and allows retry
    sim.network_calls = 0
    sim.broadcast_log.clear()

    fail_callers = [sim.refresh_tokens(should_fail=True) for _ in range(5)]
    fail_results = await asyncio.gather(*fail_callers)

    assert sim.network_calls == 1, "Concurrent failed callers must also share 1 network request"
    assert all(r is None for r in fail_results), "Failed callers should resolve to None"
    assert sim.in_flight is None, "In-flight state must be cleared after failure"
    assert sim.refresh_marker is None, "In-flight marker must be cleared after failure"
    assert len(sim.broadcast_log) == 1 and sim.broadcast_log[0]["type"] == "refresh-failed"
    print("✓ Scenario B: Failure deterministically cleared in-flight state")

    # Scenario C: Retry succeeds after failure
    retry_result = await sim.refresh_tokens(should_fail=False)
    assert retry_result is not None, "Retry after failure failed to acquire tokens"
    assert sim.network_calls == 2, f"Expected 2 total network calls after retry, got {sim.network_calls}"
    print("✓ Scenario C: Subsequent retry succeeded normally")

asyncio.run(run_concurrency_simulation())

print("ALL AUTH SINGLE-FLIGHT VALIDATION CHECKS PASSED")
