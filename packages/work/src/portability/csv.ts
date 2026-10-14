import { createHash } from 'node:crypto';

/** Bounded CSV primitives for Phase 6D. Parsing never allocates beyond the input and row limits. */
export const CSV_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  rows: 10_000,
  columns: 100,
  cell: 32_000,
});

export type CsvRow = string[];

export function parseCsv(input: string, limits = CSV_LIMITS): CsvRow[] {
  if (Buffer.byteLength(input, 'utf8') > limits.bytes) throw new Error('csv_too_large');
  const rows: CsvRow[] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v.length > 0)) rows.push(row);
      row = [];
      if (rows.length > limits.rows + 1) throw new Error('csv_too_many_rows');
    } else cell += ch;
    if (cell.length > limits.cell) throw new Error('csv_cell_too_large');
    if (row.length >= limits.columns) throw new Error('csv_too_many_columns');
  }
  if (quoted) throw new Error('csv_unclosed_quote');
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((v) => v.length > 0)) rows.push(row);
  }
  if (rows.length > limits.rows + 1) throw new Error('csv_too_many_rows');
  if (!rows.length) throw new Error('csv_empty');
  const width = rows[0]!.length;
  if (width > limits.columns || rows.some((r) => r.length !== width))
    throw new Error('csv_ragged_rows');
  return rows;
}

function quoteCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : (JSON.stringify(value) ?? String(value));
  // Spreadsheet formula injection; prefix dangerous leading characters even after whitespace.
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsv(
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  return (
    [
      headers.map(quoteCell).join(','),
      ...rows.map((r) => headers.map((h) => quoteCell(r[h])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}

export const PORTABILITY_SCHEMA_VERSION = '1';
export const PORTABLE_FIELDS = Object.freeze({
  task: [
    'schema_version',
    'source_row_key',
    'public_id',
    'title',
    'status',
    'priority',
    'start_date',
    'due_date',
    'estimate_minutes',
    'remaining_estimate_minutes',
    'brand_id',
    'project_id',
    'parent_id',
    'source_actor',
    'created_at',
    'updated_at',
  ],
  project: [
    'schema_version',
    'source_row_key',
    'public_id',
    'name',
    'status',
    'priority',
    'health',
    'target_date',
    'brand_id',
    'parent_id',
    'source_actor',
    'created_at',
    'updated_at',
  ],
});

export interface ImportPreview {
  entity: 'task' | 'project';
  headers: string[];
  rows: Array<{ row: number; values: Record<string, string>; errors: string[] }>;
  valid: number;
  invalid: number;
  digest: string;
}

export function previewCsv(
  input: string,
  entity: string,
  mapping?: Record<string, string>,
): ImportPreview {
  if (entity !== 'task' && entity !== 'project') throw new Error('unsupported_entity');
  const matrix = parseCsv(input);
  const headers = matrix[0]!.map((h, index) => (index === 0 ? h.replace(/^\uFEFF/, '') : h).trim());
  if (new Set(headers).size !== headers.length || headers.some((h) => !h || h.startsWith('_pm_')))
    throw new Error('csv_invalid_headers');
  const allowed = new Set(PORTABLE_FIELDS[entity]);
  const mapped = headers.map((h) => mapping?.[h] ?? h);
  if (mapped.some((h) => !allowed.has(h)) || new Set(mapped).size !== mapped.length)
    throw new Error('csv_invalid_mapping');
  const rows = matrix.slice(1).map((cells, index) => {
    const values = Object.fromEntries(mapped.map((field, i) => [field, cells[i]!]));
    const errors: string[] = [];
    if (values.schema_version !== PORTABILITY_SCHEMA_VERSION)
      errors.push('unsupported_schema_version');
    if (!values.title && !values.name) errors.push('required_title');
    if ((values.title ?? values.name ?? '').length > 500) errors.push('title_too_long');
    const prefix = entity === 'task' ? 'tsk' : 'prj';
    if (
      values.public_id &&
      !new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(values.public_id)
    )
      errors.push('invalid_public_id');
    return { row: index + 2, values, errors };
  });
  const mappingKey = JSON.stringify(
    Object.fromEntries(Object.entries(mapping ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  );
  const digest = createHash('sha256').update(`${entity}\0${mappingKey}\0${input}`).digest('hex');
  return {
    entity,
    headers: mapped,
    rows,
    valid: rows.filter((r) => !r.errors.length).length,
    invalid: rows.filter((r) => r.errors.length).length,
    digest,
  };
}
