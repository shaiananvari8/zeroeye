import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = stripTypeScriptTypes(
  readFileSync(new URL("../src/services/auth.ts", import.meta.url), "utf8"),
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function tokens(id) {
  return {
    accessToken: `e30.${Buffer.from(JSON.stringify({ exp: 4102444800, id })).toString("base64")}.sig`,
    refreshToken: `refresh-${id}`,
    expiresIn: 3600,
    tokenType: "Bearer",
  };
}
function browser({
  locks = true,
  channel = true,
  storage = true,
  storageEvents = true,
  writeStorage = true,
} = {}) {
  const data = new Map(),
    tabs = [],
    messages = [],
    pendingLocks = new Map();
  const lockManager = {
    request(name, callback) {
      const previous = pendingLocks.get(name) || Promise.resolve();
      const next = previous.catch(() => {}).then(callback);
      pendingLocks.set(
        name,
        next.catch(() => {}),
      );
      return next;
    },
  };
  async function tab(post) {
    const listeners = new Map(),
      channels = [],
      timers = new Map();
    let timerId = 0;
    const context = vm.createContext({
      console,
      Date,
      Math,
      JSON,
      Promise,
      atob: (x) => Buffer.from(x, "base64").toString(),
      navigator: locks ? { locks: lockManager } : {},
      clearTimeout: (id) => timers.delete(id),
      localStorage: {
        getItem(key) {
          if (!storage) throw Error("disabled");
          return data.get(key) ?? null;
        },
        setItem(key, value) {
          if (!writeStorage) throw Error("quota exceeded");
          if (!storage) throw Error("disabled");
          const oldValue = data.get(key) ?? null;
          data.set(key, value);
          for (const other of tabs)
            if (storageEvents && other.listeners !== listeners)
              queueMicrotask(() =>
                other.emit("storage", { key, newValue: value, oldValue }),
              );
        },
        removeItem(key) {
          if (!storage) throw Error("disabled");
          const oldValue = data.get(key) ?? null;
          data.delete(key);
          for (const other of tabs)
            if (storageEvents && other.listeners !== listeners)
              queueMicrotask(() =>
                other.emit("storage", { key, newValue: null, oldValue }),
              );
        },
      },
      window: {
        setTimeout(callback, ms) {
          timers.set(++timerId, { callback, ms });
          return timerId;
        },
        addEventListener(name, fn) {
          listeners.set(name, fn);
        },
      },
    });
    if (channel)
      context.BroadcastChannel = class {
        constructor(name) {
          this.name = name;
          channels.push(this);
        }
        postMessage(message) {
          messages.push(message);
          for (const other of tabs)
            if (other.listeners !== listeners)
              for (const ch of other.channels)
                if (ch.name === this.name)
                  queueMicrotask(() => ch.onmessage?.({ data: message }));
        }
      };
    const module = new vm.SourceTextModule(source, { context });
    const api = new vm.SyntheticModule(
      ["get", "post", "del"],
      function () {
        this.setExport("post", post);
        this.setExport("get", async () => ({ data: { id: "user" } }));
        this.setExport("del", async () => ({ data: null }));
      },
      { context },
    );
    await module.link(() => api);
    await module.evaluate();
    const t = {
      auth: module.namespace,
      listeners,
      channels,
      timers,
      emit: (name, event) => listeners.get(name)?.(event),
    };
    tabs.push(t);
    return t;
  }
  return { tab, data, messages };
}
async function signIn(t, value = tokens("initial")) {
  await t.auth.login({ email: "fixture@example.invalid", password: "dummy" });
}

test("same-tab concurrent callers share one request and final tokens", async () => {
  const env = browser(),
    refresh = deferred();
  let calls = 0;
  const initial = tokens("initial"),
    fresh = tokens("fresh");
  const t = await env.tab(async (path) =>
    path === "/auth/login"
      ? { data: { tokens: initial, user: { id: "u" } } }
      : (calls++, refresh.promise),
  );
  await signIn(t);
  const results = [
    t.auth.refreshTokens(),
    t.auth.refreshTokens(),
    t.auth.refreshTokens(),
  ];
  assert.equal(results[0], results[1]);
  await tick();
  assert.equal(calls, 1);
  refresh.resolve({ data: { tokens: fresh } });
  const values = await Promise.all(results);
  assert.ok(values.every((x) => x.accessToken === fresh.accessToken));
  assert.equal(t.auth.getAccessToken(), fresh.accessToken);
});
test("failed callers all resolve null, clear state and can retry after a new login", async () => {
  const env = browser(),
    refresh = deferred();
  let calls = 0;
  const initial = tokens("initial"),
    fresh = tokens("fresh");
  const t = await env.tab(async (path) =>
    path === "/auth/login"
      ? { data: { tokens: initial, user: { id: "u" } } }
      : ++calls === 1
        ? refresh.promise
        : { data: { tokens: fresh } },
  );
  await signIn(t);
  const a = t.auth.refreshTokens(),
    b = t.auth.refreshTokens();
  await tick();
  assert.equal(calls, 1);
  refresh.reject(Error("fixture failure"));
  assert.deepEqual(await Promise.all([a, b]), [null, null]);
  assert.equal(t.auth.getAccessToken(), null);
  assert.equal(env.data.get("tot_auth_tokens"), undefined);
  assert.equal(t.timers.size, 0);
  await signIn(t);
  assert.equal((await t.auth.refreshTokens()).accessToken, fresh.accessToken);
  assert.equal(calls, 2);
});
test("two tabs share a locked refresh and adopt the stored final state", async () => {
  const env = browser(),
    refresh = deferred();
  let calls = 0;
  const initial = tokens("initial"),
    fresh = tokens("fresh");
  const post = async (path) =>
    path === "/auth/login"
      ? { data: { tokens: initial, user: { id: "u" } } }
      : (calls++, refresh.promise);
  const a = await env.tab(post),
    b = await env.tab(post);
  await signIn(a);
  await tick();
  const pa = a.auth.refreshTokens(),
    pb = b.auth.refreshTokens();
  await tick();
  assert.equal(calls, 1);
  refresh.resolve({ data: { tokens: fresh } });
  const values = await Promise.all([pa, pb]);
  assert.ok(values.every((x) => x?.accessToken === fresh.accessToken));
  assert.equal(calls, 1);
  assert.equal(b.auth.getAccessToken(), fresh.accessToken);
  assert.ok(env.messages.length > 0);
  assert.ok(!JSON.stringify(env.messages).includes(fresh.refreshToken));
  assert.ok(!JSON.stringify(env.messages).includes(fresh.accessToken));
});
test("cross-tab failed refresh does not retry the invalidated credential", async () => {
  const env = browser(),
    refresh = deferred();
  let calls = 0;
  const initial = tokens("initial");
  const post = async (path) =>
    path === "/auth/login"
      ? { data: { tokens: initial, user: { id: "u" } } }
      : (calls++, refresh.promise);
  const a = await env.tab(post),
    b = await env.tab(post);
  await signIn(a);
  await tick();
  const pa = a.auth.refreshTokens(),
    pb = b.auth.refreshTokens();
  await tick();
  refresh.reject(Error("expired"));
  assert.deepEqual(await Promise.all([pa, pb]), [null, null]);
  await tick();
  assert.equal(calls, 1);
  assert.equal(b.auth.getAccessToken(), null);
  assert.equal(b.timers.size, 0);
  assert.ok(env.messages.some((x) => x.type === "refresh:failure"));
});
test("storage events synchronize success and failure without BroadcastChannel", async () => {
  const env = browser({ channel: false }),
    initial = tokens("initial"),
    fresh = tokens("fresh");
  let fail = false;
  const post = async (path) =>
    path === "/auth/login"
      ? { data: { tokens: initial, user: { id: "u" } } }
      : fail
        ? Promise.reject(Error("expired"))
        : { data: { tokens: fresh } };
  const a = await env.tab(post),
    b = await env.tab(post);
  await signIn(a);
  await tick();
  await a.auth.refreshTokens();
  await tick();
  assert.equal(b.auth.getAccessToken(), fresh.accessToken);
  fail = true;
  await a.auth.refreshTokens();
  await tick();
  assert.equal(b.auth.getAccessToken(), null);
});
test("storage-denied fallback preserves in-tab single flight", async () => {
  const env = browser({ locks: false, storage: false, channel: false }),
    refresh = deferred();
  let calls = 0;
  const fresh = tokens("fresh");
  const t = await env.tab(async (path) =>
    path === "/auth/login"
      ? { data: { tokens: tokens("initial"), user: { id: "u" } } }
      : (calls++, refresh.promise),
  );
  await signIn(t);
  const a = t.auth.refreshTokens(),
    b = t.auth.refreshTokens();
  await tick();
  assert.equal(calls, 1);
  refresh.resolve({ data: { tokens: fresh } });
  assert.ok(
    (await Promise.all([a, b])).every(
      (x) => x.accessToken === fresh.accessToken,
    ),
  );
});
test("an expired access token loaded from storage can still be renewed", async () => {
  const env = browser();
  const expired = tokens("expired");
  expired.accessToken = `e30.${Buffer.from('{"exp":1}').toString("base64")}.sig`;
  env.data.set("tot_auth_tokens", JSON.stringify(expired));
  const fresh = tokens("fresh");
  let calls = 0;
  const t = await env.tab(async () => {
    calls++;
    return { data: { tokens: fresh } };
  });
  assert.equal((await t.auth.refreshTokens())?.accessToken, fresh.accessToken);
  assert.equal(calls, 1);
});
test("logout during a pending refresh cannot restore the old session", async () => {
  const env = browser(),
    refresh = deferred();
  const t = await env.tab(async (path) =>
    path === "/auth/login"
      ? { data: { tokens: tokens("initial"), user: { id: "u" } } }
      : refresh.promise,
  );
  await signIn(t);
  const p = t.auth.refreshTokens();
  await tick();
  await t.auth.logout();
  refresh.resolve({ data: { tokens: tokens("fresh") } });
  assert.equal(await p, null);
  assert.equal(t.auth.getAccessToken(), null);
  assert.equal(env.data.get("tot_auth_tokens"), undefined);
});
test("old refresh failure does not clear a newer login", async () => {
  const env = browser(),
    refresh = deferred();
  let value = tokens("initial");
  const t = await env.tab(async (path) =>
    path === "/auth/login"
      ? { data: { tokens: value, user: { id: "u" } } }
      : refresh.promise,
  );
  await signIn(t);
  const p = t.auth.refreshTokens();
  await tick();
  value = tokens("new-login");
  await signIn(t);
  refresh.reject(Error("old failure"));
  await p;
  assert.equal(t.auth.getAccessToken(), value.accessToken);
  assert.equal(
    JSON.parse(env.data.get("tot_auth_tokens")).accessToken,
    value.accessToken,
  );
});
test("malformed cross-tab notifications cannot supply tokens or clear a valid session", async () => {
  const env = browser(),
    value = tokens("initial");
  const t = await env.tab(async () => ({
    data: { tokens: value, user: { id: "u" } },
  }));
  await signIn(t);
  for (const ch of t.channels)
    ch.onmessage?.({
      data: { type: "refresh:failure", tokens: { accessToken: "untrusted" } },
    });
  assert.equal(t.auth.getAccessToken(), value.accessToken);
});

test("Web Locks deduplicate even before storage notifications are delivered", async () => {
  const env = browser({ channel: false, storageEvents: false }),
    refresh = deferred();
  let calls = 0;
  const initial = tokens("initial"),
    fresh = tokens("fresh");
  const post = async (path) =>
    path === "/auth/login"
      ? { data: { tokens: initial, user: { id: "u" } } }
      : (calls++, refresh.promise);
  const a = await env.tab(post),
    b = await env.tab(post);
  await signIn(a);
  const pa = a.auth.refreshTokens(),
    pb = b.auth.refreshTokens();
  await tick();
  assert.equal(calls, 1);
  refresh.resolve({ data: { tokens: fresh } });
  assert.ok(
    (await Promise.all([pa, pb])).every(
      (x) => x?.accessToken === fresh.accessToken,
    ),
  );
  assert.equal(calls, 1);
});
test("old successful refresh cannot overwrite a newer login", async () => {
  const env = browser(),
    refresh = deferred();
  let value = tokens("initial");
  const t = await env.tab(async (path) =>
    path === "/auth/login"
      ? { data: { tokens: value, user: { id: "u" } } }
      : refresh.promise,
  );
  await signIn(t);
  const p = t.auth.refreshTokens();
  await tick();
  value = tokens("new-login");
  await signIn(t);
  refresh.resolve({ data: { tokens: tokens("old-result") } });
  await p;
  assert.equal(t.auth.getAccessToken(), value.accessToken);
  assert.equal(
    JSON.parse(env.data.get("tot_auth_tokens")).accessToken,
    value.accessToken,
  );
});
test("notification transport failures do not invalidate a successful refresh", async () => {
  const env = browser(),
    fresh = tokens("fresh");
  const t = await env.tab(async (path) =>
    path === "/auth/login"
      ? { data: { tokens: tokens("initial"), user: { id: "u" } } }
      : { data: { tokens: fresh } },
  );
  await signIn(t);
  for (const ch of t.channels)
    ch.postMessage = () => {
      throw Error("channel closed");
    };
  assert.equal((await t.auth.refreshTokens()).accessToken, fresh.accessToken);
  assert.equal(t.auth.getAccessToken(), fresh.accessToken);
  assert.equal(t.timers.size, 1);
});
test("registering while refresh is pending also supersedes the old result", async () => {
  const env = browser(),
    refresh = deferred(),
    fresh = tokens("registered");
  const t = await env.tab(async (path) =>
    path === "/auth/login"
      ? { data: { tokens: tokens("initial"), user: { id: "u" } } }
      : path === "/auth/register"
        ? { data: { tokens: fresh, user: { id: "new-user" } } }
        : refresh.promise,
  );
  await signIn(t);
  const p = t.auth.refreshTokens();
  await tick();
  await t.auth.register({});
  refresh.resolve({ data: { tokens: tokens("obsolete") } });
  await p;
  assert.equal(t.auth.getAccessToken(), fresh.accessToken);
});

test("a stale in-memory tab adopts a rotation before sending its old credential", async () => {
  const env = browser({ channel: false, storageEvents: false });
  const initial = tokens("initial"),
    fresh = tokens("fresh");
  let calls = 0;
  const post = async (path) =>
    path === "/auth/login"
      ? { data: { tokens: initial, user: { id: "u" } } }
      : (calls++, { data: { tokens: fresh } });
  const a = await env.tab(post),
    b = await env.tab(post);
  await signIn(a);
  assert.equal(b.auth.isAuthenticated(), true);
  await a.auth.refreshTokens();
  assert.equal((await b.auth.refreshTokens()).accessToken, fresh.accessToken);
  assert.equal(calls, 1);
});
for (const succeed of [false, true])
  test(`delayed storage events cannot let an old refresh ${succeed ? "success" : "failure"} overwrite another tab login`, async () => {
    const env = browser({ channel: false, storageEvents: false }),
      refresh = deferred();
    let value = tokens("initial");
    const post = async (path) =>
      path === "/auth/login"
        ? { data: { tokens: value, user: { id: "u" } } }
        : refresh.promise;
    const a = await env.tab(post),
      b = await env.tab(post);
    await signIn(a);
    const pending = a.auth.refreshTokens();
    await tick();
    value = tokens("new-login");
    await signIn(b);
    if (succeed) refresh.resolve({ data: { tokens: tokens("obsolete") } });
    else refresh.reject(Error("obsolete"));
    await pending;
    assert.equal(a.auth.getAccessToken(), value.accessToken);
    assert.equal(
      JSON.parse(env.data.get("tot_auth_tokens")).accessToken,
      value.accessToken,
    );
  });

test("a delayed remote logout cannot be undone by a stale tab starting refresh", async () => {
  const env = browser({channel:false,storageEvents:false});
  const initial=tokens("initial"), fresh=tokens("fresh"); let calls=0;
  const post=async path=>path==="/auth/login"?{data:{tokens:initial,user:{id:"u"}}}:(calls++,{data:{tokens:fresh}});
  const a=await env.tab(post), b=await env.tab(post);
  await signIn(a); assert.equal(b.auth.isAuthenticated(),true);
  await a.auth.logout();
  assert.equal(await b.auth.refreshTokens(),null);
  assert.equal(calls,0);
  assert.equal(b.auth.getAccessToken(),null);
  assert.equal(env.data.has("tot_auth_tokens"),false);
});
test("readable storage with rejected writes still permits memory-only refresh", async () => {
  const env=browser({writeStorage:false}), fresh=tokens("fresh"); let calls=0;
  const t=await env.tab(async path=>path==="/auth/login"?{data:{tokens:tokens("initial"),user:{id:"u"}}}:(calls++,{data:{tokens:fresh}}));
  await signIn(t); assert.equal((await t.auth.refreshTokens()).accessToken,fresh.accessToken);
  assert.equal(t.auth.getAccessToken(),fresh.accessToken); assert.equal(calls,1);
});

test("a rejected storage write cannot replace the new memory login with older stored tokens", async () => {
  const env = browser({writeStorage:false});
  const initial = tokens("new-login"), fresh = tokens("refreshed-login");
  env.data.set("tot_auth_tokens",JSON.stringify(tokens("old-account")));
  let calls = 0;
  const t = await env.tab(async path => path === "/auth/login"
    ? {data:{tokens:initial,user:{id:"new-user"}}}
    : (calls++,{data:{tokens:fresh}}));
  await signIn(t);
  assert.equal((await t.auth.refreshTokens()).accessToken,fresh.accessToken);
  assert.equal(t.auth.getAccessToken(),fresh.accessToken);
  assert.equal(calls,1);
});
