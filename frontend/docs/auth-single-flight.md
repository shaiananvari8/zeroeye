# Auth refresh single-flight validation

The auth service uses a shared in-tab promise and the Web Locks API to
serialize refresh requests across tabs. Once the lock is acquired it re-reads
the persisted session: if another tab has refreshed or logged out, that state
wins. The fallback for browsers without Web Locks uses a short storage lease;
because localStorage has no atomic compare-and-swap, the fallback is
**best-effort only**, not a strict cross-tab lock.

Cross-tab BroadcastChannel messages contain event names and a random tab ID,
never raw access/refresh tokens. The `storage` event is the fallback for
notifying tabs of changed or removed credentials. A logout or other change to
persisted credentials must win over a late network response.

## Focused tests

Run from `frontend/` with Node.js 22 or later:

```sh
node --experimental-strip-types --test tests/refreshCoordinator.test.mjs
```

This suite validates:

1. Same-tab concurrent calls share one in-flight promise.
2. Failure cleans up, allowing a subsequent signed-in session to retry.
3. Two tabs using a shared Web Locks manager serialize one request.
4. Late refresh success cannot resurrect a logged-out session.
5. Failed stale request cannot clear a newer session.
6. Sequential refresh calls work after cleanup.

## Typecheck and integration build

```sh
npx tsc --noEmit --strict --skipLibCheck --lib ES2022,DOM --target ES2022 src/services/refreshCoordinator.ts
npm ci
npm run build
```

The complete frontend build remains a required verification before marking
this PR ready for review.

## Diagnostic and privacy caution

The repository's `python3 build.py` runs a bundled, precompiled `encryptly`
executable and writes encrypted machine diagnostics that can include hostname,
username, environment and system details. Before executing or publishing any
diagnostic artifact, obtain maintainer guidance on a safe alternative and
review the executable in an isolated environment. Do not treat encrypted
machine-specific logs as safe for public release just because they are encrypted.
