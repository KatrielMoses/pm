// Single artifact, explicit commands (RELEASE_TOPOLOGY §1):
//   web | worker | migrate <args> | bootstrap | healthcheck
import { readFileSync } from 'node:fs';

// Paths inside the image (/app): each long-running command has its own deployed closure.
const COMMANDS = {
  web: './api/dist/main.js',
  worker: './worker/dist/main.js',
  migrate: './api/node_modules/@pm/db/dist/cli/migrate.js',
  bootstrap: './api/node_modules/@pm/db/dist/cli/bootstrap.js',
};
const [command, ...args] = process.argv.slice(2);

if (command === 'healthcheck') {
  // HEALTHCHECK runs beside PID 1; pick the check that matches the running command.
  let pid1 = '';
  try {
    pid1 = readFileSync('/proc/1/cmdline', 'utf8');
  } catch {
    // not Linux: default to the web check
  }
  await import(
    pid1.includes('\0worker') ? './worker/dist/healthcheck.js' : './api/dist/healthcheck.js'
  );
} else if (command in COMMANDS) {
  process.argv = [process.argv[0], COMMANDS[command], ...args];
  await import(COMMANDS[command]);
} else {
  process.stderr.write(
    `usage: entrypoint.mjs ${Object.keys(COMMANDS).join('|')}|healthcheck [args]\n`,
  );
  process.exit(2);
}
