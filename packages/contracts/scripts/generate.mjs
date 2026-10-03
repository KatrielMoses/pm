// Generates TypeScript constants from the accepted Phase 0 machine-readable contracts.
// Sources (never edited here): 0D registry.json, 0D step-up-challenge schema, and 0C policy.json.
// Usage: node generate.mjs          -> writes src/generated/registry.ts
//        node generate.mjs --check  -> exits 1 when the committed file is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const registry = JSON.parse(
  readFileSync(resolve(root, 'docs/architecture/platform/contracts/registry.json'), 'utf8'),
);
const policy = JSON.parse(
  readFileSync(resolve(root, 'docs/architecture/access/policy/policy.json'), 'utf8'),
);
const model = JSON.parse(
  readFileSync(resolve(root, 'docs/architecture/data/model/model.json'), 'utf8'),
);
const stepUpSchema = JSON.parse(
  readFileSync(
    resolve(root, 'docs/architecture/platform/contracts/schemas/step-up-challenge.schema.json'),
    'utf8',
  ),
);
const out = resolve(here, '../src/generated/registry.ts');

const lit = (v) => JSON.stringify(v, null, 2);
const constArray = (name, values, type) =>
  `export const ${name} = ${lit(values)} as const;\nexport type ${type} = (typeof ${name})[number];\n`;

const errorCodes = registry.error_codes.map((e) => ({
  code: e.code,
  httpStatus: e.http_status,
  category: e.category,
  retryable: e.retryable,
  safeMessage: e.safe_message,
  usage: e.usage,
}));
const telemetry = registry.telemetry.map((t) => ({ name: t.name, type: t.type, labels: t.labels }));
const events = registry.events.map((e) => ({
  type: e.type,
  schemaVersion: e.schema_version,
  aggregateEntity: e.aggregate_entity,
  fields: e.fields,
  maxClass: e.max_class,
}));
const prefixes = registry.id_prefixes.map((p) => ({
  prefix: p.prefix,
  resource: p.resource,
  entity: p.entity,
  ownerModule: p.owner_module,
  platformOnly: p.platform_only,
}));
const operationKinds = registry.operation_kinds.map((k) => ({
  kind: k.kind,
  supports: k.supports,
  riskClass: k.risk_class,
}));
const principals = policy.principals.map((p) => ({
  id: p.id,
  platformOnly: Boolean(p.platform_only),
}));
const actions = policy.actions.map((a) => ({
  key: a.key,
  kind: a.kind,
  scopes: a.scopes,
  stepUp: Boolean(a.step_up),
  riskClass: a.risk_class,
  requiredLevel: a.required_level,
  // Role matrix cells: implicit | deny | grant:<level> (0C §5); the 1C/1D compiler reads these.
  roles: a.roles,
}));

const accountCommands = (policy.account_commands ?? []).map((c) => ({
  action: c.action,
  principals: c.principals,
  gates: c.gates,
}));

/** `name kind (a|b|c)` key column of a 0B entity → its closed vocabulary. */
function vocabulary(entity, column) {
  const e = model.entities.find((x) => x.name === entity);
  const col = e?.key_columns.find((c) => c.startsWith(`${column} `));
  const m = col && /\(([a-z_|]+)\)\s*$/.exec(col);
  if (!m) throw new Error(`0B ${entity}.${column} has no closed vocabulary`);
  return m[1].split('|');
}

const body = `// GENERATED FILE - do not edit by hand.
// Source: docs/architecture/platform/contracts/registry.json (schema_version ${registry.schema_version})
//         docs/architecture/access/policy/policy.json (schema_version ${policy.schema_version})
//         docs/architecture/data/model/model.json (schema_version ${model.schema_version})
//         docs/architecture/platform/contracts/schemas/step-up-challenge.schema.json
// Regenerate: pnpm contracts:generate

${constArray('ACTOR_TYPES', registry.actor_types, 'ActorType')}
${constArray('EXEC_STATES', registry.exec_states, 'ExecState')}
${constArray('TERMINAL_REASONS', registry.terminal_reasons, 'TerminalReason')}
${constArray('WAITING_REASONS', registry.waiting_reasons, 'WaitingReason')}
${constArray('JOB_STATES', Object.keys(registry.job_states), 'JobState')}
/** 0D §7.2: job state -> operation exec_state (default mapping). */
export const JOB_STATE_TO_EXEC_STATE = ${lit(registry.job_states)} as const satisfies Record<JobState, ExecState>;

${constArray('FORBIDDEN_METRIC_LABELS', registry.forbidden_metric_labels, 'ForbiddenMetricLabel')}
export const TELEMETRY_SIGNALS = ${lit(telemetry)} as const;
export type TelemetrySignalName = (typeof TELEMETRY_SIGNALS)[number]['name'];

export const ERROR_CODES = ${lit(errorCodes)} as const;
export type ErrorCode = (typeof ERROR_CODES)[number]['code'];

export const OPERATION_KINDS = ${lit(operationKinds)} as const;
export type OperationKind = (typeof OPERATION_KINDS)[number]['kind'];

export const ID_PREFIXES = ${lit(prefixes)} as const;
export type IdPrefix = (typeof ID_PREFIXES)[number]['prefix'];

export const INTERNAL_EVENTS = ${lit(events)} as const;
export type InternalEventType = (typeof INTERNAL_EVENTS)[number]['type'];

${constArray(
  'PARAMETER_NAMES',
  registry.parameters.map((p) => p.name),
  'ParameterName',
)}
export const PRINCIPALS = ${lit(principals)} as const;
export type PrincipalType = (typeof PRINCIPALS)[number]['id'];

/** 0C actions: workspace-scoped kinds plus personal (own-account) actions. */
export const ACTIONS = ${lit(actions)} as const;
export type ActionKey = (typeof ACTIONS)[number]['key'];

/** 0C account commands (AZ-18): account-level actions performed before any tenant context. */
export const ACCOUNT_COMMANDS = ${lit(accountCommands)} as const;
export type AccountCommand = (typeof ACCOUNT_COMMANDS)[number]['action'];

/** 0B brand operational status (ADR-19): business metadata, never lifecycle. */
${constArray('BRAND_OPERATIONAL_STATUSES', vocabulary('brand', 'operational_status'), 'BrandOperationalStatus')}
/** 0B brand notification content mode. */
${constArray('BRAND_NOTIFICATION_CONTENT_MODES', vocabulary('brand', 'notification_content_mode'), 'BrandNotificationContentMode')}
/** 0D §11.2 step-up challenge states (\`locked\` is stored and terminal). */
${constArray('STEP_UP_CHALLENGE_STATES', stepUpSchema.properties.state.enum, 'StepUpChallengeState')}`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    // missing file is stale
  }
  if (current !== body) {
    console.error(
      'packages/contracts/src/generated/registry.ts is stale. Run: pnpm contracts:generate',
    );
    process.exit(1);
  }
  console.log('contracts: generated registry is up to date');
} else {
  writeFileSync(out, body);
  console.log('contracts: wrote ' + out);
}
