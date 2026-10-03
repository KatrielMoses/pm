// Generates TypeScript constants from the accepted Phase 0 machine-readable contracts.
// Sources (never edited here): 0D registry.json and 0C policy.json.
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

const body = `// GENERATED FILE - do not edit by hand.
// Source: docs/architecture/platform/contracts/registry.json (schema_version ${registry.schema_version})
//         docs/architecture/access/policy/policy.json (schema_version ${policy.schema_version})
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
`;

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
