// Local development: web/API (watch), worker (watch), and the Vite dev server with an API proxy.
// Requires a migrated database and .env (run `pnpm db:local` or `docker compose up db migrate`).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('.env')) {
  console.error('Missing .env. Run `pnpm db:local` (no Docker) or copy .env.example.');
  process.exit(1);
}
const node = ['--conditions=@pm/source', '--watch'];
const procs = [
  ['api', process.execPath, [...node, 'apps/api/src/main.ts']],
  ['worker', process.execPath, [...node, 'apps/worker/src/main.ts']],
  ['web', 'pnpm', ['--filter', '@pm/web', 'dev']],
].map(([name, cmd, args]) => {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APP_ENV: 'local' },
  });
  const prefix = (d) =>
    d
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => `[${name}] ${l}`)
      .join('\n') + '\n';
  child.stdout.on('data', (d) => process.stdout.write(prefix(d)));
  child.stderr.on('data', (d) => process.stderr.write(prefix(d)));
  return child;
});
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
