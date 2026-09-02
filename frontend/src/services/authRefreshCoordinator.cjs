"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var authRefreshCoordinator_exports = {};
__export(authRefreshCoordinator_exports, {
  withSingleFlightRefresh: () => withSingleFlightRefresh
});
module.exports = __toCommonJS(authRefreshCoordinator_exports);
const LOCK_KEY = "tot_auth_refresh_lock";
const RESULT_KEY = "tot_auth_refresh_result";
const LOCK_TTL_MS = 1e4;
const CHANNEL_NAME = "tot_auth_refresh";
function now() {
  return Date.now();
}
function generateTabId() {
  try {
    return `${now()}-${Math.random().toString(36).slice(2, 10)}`;
  } catch {
    return `${now()}`;
  }
}
const tabId = generateTabId();
function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}
function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
  }
}
function isLockActive() {
  const lock = readJson(LOCK_KEY);
  if (!lock) return false;
  return now() - lock.ts < LOCK_TTL_MS;
}
function acquireLock() {
  if (isLockActive()) return false;
  writeJson(LOCK_KEY, { ts: now(), tabId });
  const lock = readJson(LOCK_KEY);
  return lock?.tabId === tabId;
}
function releaseLock() {
  const lock = readJson(LOCK_KEY);
  if (lock?.tabId === tabId) {
    removeKey(LOCK_KEY);
  }
}
function writeResult(result) {
  writeJson(RESULT_KEY, { ts: now(), result });
}
function readResult() {
  const entry = readJson(RESULT_KEY);
  if (!entry) return null;
  if (now() - entry.ts > LOCK_TTL_MS * 2) return null;
  return entry.result;
}
function createChannel() {
  try {
    if (typeof BroadcastChannel === "function") {
      return new BroadcastChannel(CHANNEL_NAME);
    }
  } catch {
  }
  return null;
}
function waitForRefreshResult(timeoutMs = LOCK_TTL_MS) {
  return new Promise((resolve) => {
    const deadline = now() + timeoutMs;
    let resolved = false;
    function finish(result) {
      if (resolved) return;
      resolved = true;
      resolve(result);
    }
    const channel = createChannel();
    if (channel) {
      channel.onmessage = (event) => {
        if (event?.data?.type === "refresh-complete") {
          finish(event.data.result);
        }
      };
    }
    const pollInterval = 100;
    const timer = setInterval(() => {
      const result = readResult();
      if (result) {
        finish(result);
      } else if (now() >= deadline) {
        finish({ ok: false, value: null, error: "timeout waiting for refresh result" });
      }
    }, pollInterval);
    function cleanup() {
      clearInterval(timer);
      if (channel) {
        channel.onmessage = null;
        channel.close();
      }
    }
    const cleanupTimer = setTimeout(cleanup, timeoutMs + 200);
    Promise.resolve().then(() => {
      const originalFinish = finish;
      function finishWithCleanup(result) {
        cleanup();
        clearTimeout(cleanupTimer);
        originalFinish(result);
      }
    }).catch(() => {
    });
  });
}
function broadcastResult(result) {
  writeResult(result);
  const channel = createChannel();
  if (channel) {
    try {
      channel.postMessage({ type: "refresh-complete", result });
    } catch {
    } finally {
      channel.close();
    }
  }
}
async function withSingleFlightRefresh(refreshFn) {
  const existingResult = readResult();
  if (existingResult?.ok) {
    return existingResult.value;
  }
  if (isLockActive()) {
    const waited = await waitForRefreshResult();
    if (waited.ok) return waited.value;
  }
  if (!acquireLock()) {
    const waited = await waitForRefreshResult();
    return waited.ok ? waited.value : null;
  }
  try {
    const value = await refreshFn();
    broadcastResult({ ok: true, value });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : "refresh failed";
    broadcastResult({ ok: false, value: null, error: message });
    return null;
  } finally {
    releaseLock();
  }
}
