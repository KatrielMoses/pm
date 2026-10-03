// Dependency vulnerability scan: pnpm audit (npm advisory database) + OSV-Scanner (OSV.dev) over the
// committed lockfile. Both are maintained, free, and need no paid service.
import { spawnSync } from 'node:child_process';

let failed = false;
const audit = spawnSync('pnpm', ['audit', '--audit-level=high'], { stdio: 'inherit' });
if (audit.status !== 0) failed = true;

const osv = process.env.OSV_SCANNER_BIN ?? 'osv-scanner';
if (spawnSync(osv, ['--version'], { encoding: 'utf8' }).status === 0) {
  const args = ['scan', 'source', '--lockfile', 'pnpm-lock.yaml'];
  if (process.env.SCAN_REPORT) args.push('--format', 'sarif', '--output', process.env.SCAN_REPORT);
  const r = spawnSync(osv, args, { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
} else if (process.env.PM_ALLOW_MISSING_SCANNERS === '1') {
  console.warn('FALLBACK: osv-scanner unavailable; only pnpm audit ran.');
} else {
  console.error('osv-scanner is not installed. Install it or set PM_ALLOW_MISSING_SCANNERS=1.');
  failed = true;
}
process.exit(failed ? 1 : 0);
