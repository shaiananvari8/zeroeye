import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshCoordinator } from '../src/services/refreshCoordinator.ts';

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function sharedLocks() {
  const queues = new Map();
  return {
    async request(name, callback) {
      const before = queues.get(name) ?? Promise.resolve();
      const done = deferred();
      queues.set(name, done.promise);
      await before;
      try { return await callback(); }
      finally { done.resolve(); }
    },
  };
}
function harness(shared, refreshFn, locks = sharedLocks()) {
  const events = [];
  const refresh = createRefreshCoordinator({
    read: () => shared.tokens,
    request: refreshFn,
    save: (tokens) => { shared.tokens = tokens; },
    clear: () => { shared.tokens = null; },
    publish: (event) => events.push(event),
    locks: () => locks,
  });
  return { events, refresh };
}
const old = () => ({ accessToken: 'before', refreshToken: 'old-key' });
const next = () => ({ accessToken: 'after', refreshToken: 'new-key' });

test('same-tab concurrent callers share identical promise and single network call', async () => {
  const shared = { tokens: old() }, gate = deferred();
  let calls = 0;
  const { refresh, events } = harness(shared, async () => { calls++; return gate.promise; });
  const a = refresh(), b = refresh(), c = refresh();
  assert.strictEqual(a, b); assert.strictEqual(b, c);
  gate.resolve(next());
  assert.deepEqual(await Promise.all([a,b,c]), [next(), next(), next()]);
  assert.equal(calls, 1); assert.deepEqual(events, ['success']);
});

test('failure clears marker; subsequent refresh can retry', async () => {
  const shared = { tokens: old() }; let calls = 0;
  const { refresh, events } = harness(shared, async () => {
    calls++; if (calls === 1) throw new Error('401'); return next();
  });
  assert.equal(await refresh(), null);
  assert.equal(shared.tokens, null);
  shared.tokens = old(); // New sign-in provides a valid refresh credential.
  assert.deepEqual(await refresh(), next());
  assert.equal(calls, 2); assert.deepEqual(events, ['failure','success']);
});

test('two tabs with Web Locks issue one request and share persisted result', async () => {
  const shared = { tokens: old() }, locks = sharedLocks(), gate = deferred();
  let calls = 0;
  const refreshFn = async () => { calls++; return gate.promise; };
  const tabA = harness(shared, refreshFn, locks);
  const tabB = harness(shared, refreshFn, locks);
  const a = tabA.refresh(), b = tabB.refresh();
  await Promise.resolve(); gate.resolve(next());
  assert.deepEqual(await Promise.all([a,b]), [next(), next()]);
  assert.equal(calls, 1);
});

test('late refresh response never resurrects logged-out session', async () => {
  const shared = { tokens: old() }, gate = deferred();
  const { refresh, events } = harness(shared, () => gate.promise);
  const result = refresh(); await Promise.resolve();
  shared.tokens = null; // Logout during request.
  gate.resolve(next());
  assert.equal(await result, null);
  assert.equal(shared.tokens, null);
  assert.deepEqual(events, []);
});

test('failed request never clears newer cross-tab session', async () => {
  const shared = { tokens: old() }, gate = deferred();
  const { refresh, events } = harness(shared, () => gate.promise);
  const result = refresh(); await Promise.resolve();
  shared.tokens = next();
  gate.reject(new Error('outdated response'));
  assert.deepEqual(await result, next());
  assert.deepEqual(shared.tokens, next());
  assert.deepEqual(events, []);
});

test('sequential refreshes permitted after in-flight cleanup', async () => {
  const shared = { tokens: old() }; let calls = 0;
  const { refresh } = harness(shared, async () =>
    ({ accessToken: `token-${++calls}`, refreshToken: `refresh-${calls}` }));
  await refresh(); await refresh();
  assert.equal(calls, 2);
});
