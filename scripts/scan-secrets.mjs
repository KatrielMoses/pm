// Secret scan. Uses gitleaks (maintained scanner; required in CI). Locally, set GITLEAKS_BIN or put
// gitleaks on PATH. Without it the script fails unless PM_ALLOW_MISSING_SCANNERS=1, in which case a
// minimal built-in pattern scan runs and the result is clearly labelled as a fallback.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Local secret stores are gitignored and excluded from the content scan; they must never be tracked.
const LOCAL_SECRET_FILES = ['.env', 'compose.env', '.local'];
const tracked = spawnSync('git', ['ls-files', '--', ...LOCAL_SECRET_FILES], { encoding: 'utf8' });
if (tracked.status === 0 && tracked.stdout.trim()) {
  console.error(`Local secret files are tracked by git:\n${tracked.stdout}`);
  process.exit(1);
}

const bin = process.env.GITLEAKS_BIN ?? 'gitleaks';
const probe = spawnSync(bin, ['version'], { encoding: 'utf8' });
if (probe.status === 0) {
  const args = [
    'dir',
    '.',
    '--config',
    '.gitleaks.toml',
    '--redact',
    '--no-banner',
    '--exit-code',
    '1',
  ];
  if (process.env.SCAN_REPORT)
    args.push('--report-format', 'sarif', '--report-path', process.env.SCAN_REPORT);
  const r = spawnSync(bin, args, { stdio: 'inherit' });
  console.log(
    `gitleaks ${probe.stdout.trim()}: ${r.status === 0 ? 'no leaks found' : 'LEAKS FOUND'}`,
  );
  process.exit(r.status ?? 1);
}
if (process.env.PM_ALLOW_MISSING_SCANNERS !== '1') {
  console.error(
    'gitleaks is not installed. Install it or set PM_ALLOW_MISSING_SCANNERS=1 for the limited fallback.',
  );
  process.exit(1);
}
console.warn('FALLBACK: gitleaks unavailable; running the limited built-in pattern scan.');
const patterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /postgres(ql)?:\/\/[^:\s/]+:(?!\$|<|CHANGE|pw_|hunter2)[^@\s]{12,}@/,
];
const skip = /^(node_modules|dist|\.git|\.local|reports|test-results|playwright-report|docs)$/;
const hits = [];
// Like gitleaks: a line carrying `gitleaks:allow` is a reviewed synthetic fixture.
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (skip.test(name) || (dir === '.' && LOCAL_SECRET_FILES.includes(name))) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (statSync(p).size < 1_000_000) {
      const lines = readFileSync(p, 'utf8').split('\n');
      for (const re of patterns)
        if (lines.some((l) => re.test(l) && !l.includes('gitleaks:allow')))
          hits.push(`${p}: ${re.source.slice(0, 30)}`);
    }
  }
};
walk('.');
if (hits.length) {
  console.error(`Possible secrets:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log('fallback scan: no matches');
