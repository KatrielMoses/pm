// Container HEALTHCHECK for the worker command: exits 0 while the runtime refreshes its health file.
import { readFileSync } from 'node:fs';
import { HEALTH_FILE, HEALTH_MAX_AGE_MS } from './health-file.ts';

try {
  const at = Number(readFileSync(HEALTH_FILE, 'utf8'));
  process.exit(Number.isFinite(at) && Date.now() - at < HEALTH_MAX_AGE_MS ? 0 : 1);
} catch {
  process.exit(1);
}
