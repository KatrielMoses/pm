import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';

/** The accepted 0D JSON Schemas, loaded directly from docs (never copied). */
export const SCHEMAS_DIR = fileURLToPath(
  new URL('../../../docs/architecture/platform/contracts/schemas', import.meta.url),
);

let ajv: Ajv2020 | undefined;

function load(): Ajv2020 {
  if (ajv) return ajv;
  const instance = new Ajv2020({ strict: false, allErrors: true });
  for (const file of readdirSync(SCHEMAS_DIR)) {
    if (file.endsWith('.json'))
      instance.addSchema(JSON.parse(readFileSync(`${SCHEMAS_DIR}/${file}`, 'utf8')) as object);
  }
  ajv = instance;
  return instance;
}

/** Validates a value against `urn:pm:schema:<name>`; returns readable errors (empty when valid). */
export function contractErrors(name: string, value: unknown): string[] {
  const validate = load().getSchema(`urn:pm:schema:${name}`);
  if (!validate) throw new Error(`unknown contract schema ${name}`);
  return validate(value)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}
