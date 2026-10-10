import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Local acceptance runs use embedded PostgreSQL, whose `async-exit-hook` answers `beforeExit` with
 * `process.exit(0)` and so used to turn a run with failed tests into exit code 0 (a local verify
 * passed with failures). The guard must keep the failing code; a clean run must stay clean.
 */
const MODULE = pathToFileURL(`${process.cwd()}/packages/test-infra/src/postgres.ts`).href;
const run = (code: number) =>
  spawnSync(
    process.execPath,
    [
      '--conditions=@pm/source',
      '--input-type=module',
      '-e',
      `import { keepFailureExitCode } from '${MODULE}';
       keepFailureExitCode();
       process.on('beforeExit', () => process.exit(0)); // the hook's behaviour
       process.exitCode = ${code};`,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

describe('embedded PostgreSQL failure propagation', () => {
  it('keeps a failing exit code that an exit hook would discard', () => {
    const r = run(1);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(1);
  });
  it('leaves a clean run clean', () => {
    expect(run(0).status).toBe(0);
  });
});
