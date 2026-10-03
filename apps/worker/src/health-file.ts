import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HEALTH_FILE = process.env.WORKER_HEALTH_FILE ?? join(tmpdir(), 'pm-worker-health');
export const HEALTH_MAX_AGE_MS = 60_000;
