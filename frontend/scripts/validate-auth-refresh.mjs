import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(root, '..', 'src', 'services', 'auth.ts'), 'utf8');

const checks = [
  ['single-flight fast path', /if \(refreshInFlight\) return refreshInFlight;/],
  ['marker assigned after operation creation', /refreshInFlight = operation;[\s\S]*?return operation;/],
  ['marker cleared in finally', /operation\.finally\(\(\) => \{[\s\S]*?refreshInFlight = null;/],
  ['BroadcastChannel lifecycle propagation', /new BroadcastChannel\(REFRESH_CHANNEL_NAME\)/],
  ['storage-event lifecycle propagation', /addEventListener\('storage', handleRefreshStorageEvent\)/],
  ['refresh success event', /publishRefreshEvent\('success', response\.data\.tokens\)/],
  ['refresh failure event', /publishRefreshEvent\('failure'\)/],
  ['no raw-token storage event payload', /JSON\.stringify\(\{ sourceId: refreshSourceId, type, timestamp: event\.timestamp \}\)/],
];

const failures = checks.filter(([, pattern]) => !pattern.test(source));
if (failures.length) {
  console.error(`auth refresh validation failed: ${failures.map(([name]) => name).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`auth refresh validation passed (${checks.length} invariants)`);
}
