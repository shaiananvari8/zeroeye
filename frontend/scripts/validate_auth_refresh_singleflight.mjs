#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const authPath = join(scriptDir, "..", "src", "services", "auth.ts");
const source = readFileSync(authPath, "utf8");
const refreshEventBody = source.match(/interface\s+RefreshEvent\s*{(?<body>[\s\S]*?)\n}/)?.groups?.body ?? "";

const checks = [
  {
    name: "same-tab refresh callers share an in-flight promise",
    test: /let\s+refreshInFlight:\s*Promise<AuthTokens\s*\|\s*null>\s*\|\s*null/.test(source)
      && /if\s*\(\s*refreshInFlight\s*\)\s*{\s*return\s+refreshInFlight;/.test(source),
  },
  {
    name: "cross-tab refreshes use a bounded storage lock",
    test: source.includes("REFRESH_LOCK_KEY")
      && source.includes("REFRESH_LOCK_TTL_MS")
      && /function\s+acquireRefreshLock\(/.test(source)
      && /function\s+releaseRefreshLock\(/.test(source),
  },
  {
    name: "refresh completion is announced through BroadcastChannel/storage",
    test: source.includes("BroadcastChannel")
      && source.includes("REFRESH_EVENT_KEY")
      && /function\s+publishRefreshEvent\(/.test(source)
      && /window\.addEventListener\('storage'/.test(source),
  },
  {
    name: "refresh failures clear state and let later refreshes retry",
    test: /catch\s*{\s*clearStoredTokens\(\);[\s\S]*publishRefreshEvent\('refresh-failure'\);[\s\S]*return\s+null;[\s\S]*finally\s*{[\s\S]*refreshInFlight\s*=\s*null;/.test(source),
  },
  {
    name: "cross-tab refresh events do not include raw token fields",
    test: refreshEventBody.includes("type: RefreshEventType;")
      && refreshEventBody.includes("eventId: string;")
      && refreshEventBody.includes("owner: string;")
      && refreshEventBody.includes("timestamp: number;")
      && !/(accessToken|refreshToken|tokens):/.test(refreshEventBody),
  },
];

const failed = checks.filter((check) => !check.test);

for (const check of checks) {
  console.log(`${check.test ? "PASS" : "FAIL"} ${check.name}`);
}

if (failed.length > 0) {
  process.exitCode = 1;
}
