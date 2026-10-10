import {
  DEFAULT_PREFERENCES,
  HIDEABLE_DESTINATIONS,
  PREFERENCE_VALUES,
  START_DESTINATIONS,
  type ErrorIssue,
  type Preferences,
  type ShellDestination,
  type StartDestination,
} from '@pm/contracts';
import type { PlatformDatabase, PlatformTransaction } from '@pm/db';
import type { Metrics } from '@pm/observability';
import { IdentityError } from './types.ts';

/**
 * Typed personal preferences (0B `account_preference`, ADR-20; 1E). One row per account; a missing
 * row means the defaults. Every value is allow-listed (the database CHECKs repeat the same sets).
 * No preference changes authority or exposure, so changes are counted, never audited as material.
 */

export interface PreferencesView {
  preferences: Preferences;
  /** Row version for `If-Match` (0 when nothing has been stored yet). */
  version: number;
}

const FIELDS = [
  'theme',
  'density',
  'motion',
  'shortcuts',
  'record_open',
  'start_destination',
  'hidden_destinations',
] as const;

function issue(pointer: string, code: string, message: string): ErrorIssue {
  return { pointer, code, message } as ErrorIssue;
}

/** Validates a partial update; unknown fields and values are rejected with field-level issues. */
export function parsePreferencePatch(body: unknown): Partial<Preferences> {
  const issues: ErrorIssue[] = [];
  const out: Partial<Preferences> = {};
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new IdentityError('validation_failed', {
      issues: [issue('', 'invalid_type', 'Send the preferences to change as an object.')],
    });
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      issues.push(issue(`/${key}`, 'unsupported_field', 'This field is not supported.'));
      continue;
    }
    const value = b[key];
    switch (key) {
      case 'theme':
      case 'density':
      case 'motion':
      case 'shortcuts':
      case 'record_open': {
        const allowed = PREFERENCE_VALUES[key] as readonly string[];
        if (typeof value === 'string' && allowed.includes(value))
          (out as Record<string, unknown>)[key] = value;
        else
          issues.push(issue(`/${key}`, 'invalid_option', `Choose one of: ${allowed.join(', ')}.`));
        break;
      }
      case 'start_destination':
        if (value === null || (START_DESTINATIONS as readonly unknown[]).includes(value))
          out.start_destination = value as StartDestination | null;
        else issues.push(issue('/start_destination', 'invalid_option', 'Choose a start page.'));
        break;
      case 'hidden_destinations':
        if (
          Array.isArray(value) &&
          value.length <= HIDEABLE_DESTINATIONS.length &&
          new Set(value).size === value.length &&
          value.every((v) => (HIDEABLE_DESTINATIONS as readonly unknown[]).includes(v))
        )
          out.hidden_destinations = value as ShellDestination[];
        else
          issues.push(
            issue(
              '/hidden_destinations',
              'invalid_option',
              'Choose destinations to hide from the list (Home cannot be hidden).',
            ),
          );
        break;
    }
  }
  if (issues.length) throw new IdentityError('validation_failed', { issues });
  return out;
}

type Row = {
  theme: Preferences['theme'];
  density: Preferences['density'];
  motion: Preferences['motion'];
  shortcuts: Preferences['shortcuts'];
  record_open: Preferences['record_open'];
  start_destination: string | null;
  hidden_destinations: string[];
  version: string | number;
};

function view(row: Row | undefined): PreferencesView {
  if (!row) return { preferences: { ...DEFAULT_PREFERENCES, hidden_destinations: [] }, version: 0 };
  return {
    preferences: {
      theme: row.theme,
      density: row.density,
      motion: row.motion,
      shortcuts: row.shortcuts,
      record_open: row.record_open,
      // Values outside today's registries (renamed destinations) degrade to defaults.
      start_destination: (START_DESTINATIONS as readonly string[]).includes(
        row.start_destination ?? '',
      )
        ? (row.start_destination as StartDestination)
        : null,
      hidden_destinations: row.hidden_destinations.filter((d): d is ShellDestination =>
        (HIDEABLE_DESTINATIONS as readonly string[]).includes(d),
      ),
    },
    version: Number(row.version),
  };
}

async function read(tx: PlatformTransaction, accountId: string): Promise<Row | undefined> {
  return (await tx.db
    .selectFrom('identity.account_preference')
    .select([
      'theme',
      'density',
      'motion',
      'shortcuts',
      'record_open',
      'start_destination',
      'hidden_destinations',
      'version',
    ])
    .where('account_id', '=', accountId)
    .executeTakeFirst()) as Row | undefined;
}

export async function readPreferences(
  db: PlatformDatabase,
  accountId: string,
): Promise<PreferencesView> {
  return db.withPlatform({ module: 'identity', readOnly: true }, async (tx) =>
    view(await read(tx, accountId)),
  );
}

/**
 * Applies a validated partial update. `ifMatch` (the version from a previous read) makes the write
 * conditional; without it the latest write wins per field. Concurrent writers serialize on the row.
 */
export async function writePreferences(
  db: PlatformDatabase,
  metrics: Metrics,
  accountId: string,
  body: unknown,
  ifMatch: number | undefined,
): Promise<PreferencesView> {
  let patch: Partial<Preferences>;
  try {
    patch = parsePreferencePatch(body);
  } catch (err) {
    metrics.count('identity.preference_updates', 1, { outcome: 'invalid' });
    throw err;
  }
  try {
    const out = await db.withPlatform({ module: 'identity' }, async (tx) => {
      await tx.db
        .insertInto('identity.account_preference')
        .values({ account_id: accountId })
        .onConflict((oc) => oc.column('account_id').doNothing())
        .execute();
      const current = await tx.db
        .selectFrom('identity.account_preference')
        .select('version')
        .where('account_id', '=', accountId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (ifMatch !== undefined && Number(current.version) !== ifMatch)
        throw new IdentityError('conflict');
      if (Object.keys(patch).length) {
        await tx.db
          .updateTable('identity.account_preference')
          .set({
            ...patch,
            updated_at: new Date(),
            version: Number(current.version) + 1,
          })
          .where('account_id', '=', accountId)
          .execute();
      }
      return view(await read(tx, accountId));
    });
    metrics.count('identity.preference_updates', 1, { outcome: 'ok' });
    return out;
  } catch (err) {
    metrics.count('identity.preference_updates', 1, {
      outcome: err instanceof IdentityError && err.code === 'conflict' ? 'conflict' : 'error',
    });
    throw err;
  }
}

/** Personal-data eraser (account deletion hook): removes the account's preference row. */
export async function erasePreferences(
  tx: PlatformTransaction,
  accountId: string,
): Promise<number> {
  const r = await tx.db
    .deleteFrom('identity.account_preference')
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
