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
    if (row.length > limits.columns) throw new Error('csv_too_many_columns');
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
  if (headers.length > CSV_LIMITS.columns || rows.length > CSV_LIMITS.rows)
    throw new Error('csv_export_limit');
  const chunks: string[] = [];
  let bytes = 0;
  const append = (line: string) => {
    const chunk = `${line}\r\n`;
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > CSV_LIMITS.bytes) throw new Error('csv_export_too_large');
    chunks.push(chunk);
  };
  append(headers.map(quoteCell).join(','));
  for (const row of rows) append(headers.map((h) => quoteCell(row[h])).join(','));
  return chunks.join('');
}

export const PORTABILITY_SCHEMA_VERSION = '1';
export const PORTABLE_ENTITIES = [
  'task',
  'project',
  'workflow',
  'field',
  'goal',
  'document',
  'file',
] as const;
export type PortableEntity = (typeof PORTABLE_ENTITIES)[number];
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
  workflow: [
    'schema_version',
    'source_row_key',
    'public_id',
    'name',
    'record_kind',
    'description',
    'scope',
    'statuses',
    'created_at',
    'updated_at',
  ],
  field: [
    'schema_version',
    'source_row_key',
    'public_id',
    'name',
    'field_type',
    'description',
    'config',
    'scope',
    'applies_to',
    'required',
    'presentation',
    'applicability',
    'view_visibility',
    'created_at',
    'updated_at',
  ],
  goal: [
    'schema_version',
    'source_row_key',
    'public_id',
    'title',
    'status',
    'basis',
    'period',
    'unit',
    'baseline',
    'target',
    'current',
    'project_id',
    'source_actor',
    'created_at',
    'updated_at',
  ],
  document: [
    'schema_version',
    'source_row_key',
    'public_id',
    'title',
    'document_type',
    'project_id',
    'parent_id',
    'source_actor',
    'created_at',
    'updated_at',
  ],
  file: [
    'schema_version',
    'source_row_key',
    'public_id',
    'name',
    'media_type',
    'size_bytes',
    'checksum_sha256',
    'link_url',
    'host_kind',
    'host_public_id',
    'scan_state',
    'created_at',
    'updated_at',
  ],
});

export interface ImportPreview {
  entity: PortableEntity;
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
  if (!PORTABLE_ENTITIES.includes(entity as PortableEntity)) throw new Error('unsupported_entity');
  const matrix = parseCsv(input);
  const headers = matrix[0]!.map((h, index) => (index === 0 ? h.replace(/^\uFEFF/, '') : h).trim());
  if (new Set(headers).size !== headers.length || headers.some((h) => !h || h.startsWith('_pm_')))
    throw new Error('csv_invalid_headers');
  const allowed = new Set(PORTABLE_FIELDS[entity as PortableEntity]);
  const mapped = headers.map((h) => mapping?.[h] ?? h);
  if (mapped.some((h) => !allowed.has(h)) || new Set(mapped).size !== mapped.length)
    throw new Error('csv_invalid_mapping');
  const seenSourceKeys = new Set<string>();
  const rows = matrix.slice(1).map((cells, index) => {
    const values = Object.fromEntries(mapped.map((field, i) => [field, cells[i]!]));
    const errors: string[] = [];
    if (Buffer.byteLength(JSON.stringify(values), 'utf8') > 128 * 1024)
      errors.push('row_too_large');
    if (values.source_row_key) {
      if (seenSourceKeys.has(values.source_row_key)) errors.push('duplicate_source_row_key');
      seenSourceKeys.add(values.source_row_key);
    }
    if (values.schema_version !== PORTABILITY_SCHEMA_VERSION)
      errors.push('unsupported_schema_version');
    if (entity === 'workflow') {
      if (!['task', 'project'].includes(values.record_kind ?? ''))
        errors.push('invalid_record_kind');
      try {
        const statuses = JSON.parse(values.statuses ?? '[]') as unknown;
        if (!Array.isArray(statuses) || statuses.length < 2) errors.push('invalid_statuses');
      } catch {
        errors.push('invalid_statuses');
      }
    }
    if (entity === 'field' && values.config) {
      try {
        if (!JSON.parse(values.config)) errors.push('invalid_config');
      } catch {
        errors.push('invalid_config');
      }
    }
    if (entity === 'field' && values.applies_to) {
      try {
        const applies = JSON.parse(values.applies_to) as unknown;
        if (
          !Array.isArray(applies) ||
          !applies.length ||
          applies.some((x) => x !== 'task' && x !== 'project')
        )
          errors.push('invalid_applies_to');
      } catch {
        errors.push('invalid_applies_to');
      }
    }
    if (entity === 'goal') {
      try {
        const period = JSON.parse(values.period ?? '') as Record<string, unknown>;
        if (
          !period ||
          typeof period !== 'object' ||
          !['quarter', 'half', 'year', 'custom'].includes(String(period.kind))
        )
          errors.push('invalid_period');
      } catch {
        errors.push('invalid_period');
      }
    }
    if (
      entity === 'document' &&
      values.document_type &&
      ![
        'page',
        'brand_brief',
        'project_brief',
        'sop',
        'specification',
        'meeting_notes',
        'decision',
        'release_notes',
      ].includes(values.document_type)
    )
      errors.push('invalid_document_type');
    if (entity === 'file') {
      if (!values.link_url) errors.push('file_payload_required');
      else {
        try {
          const url = new URL(values.link_url);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            values.link_url.length > 2_048 ||
            // eslint-disable-next-line no-control-regex -- Reject control characters in imported URLs.
            /[\s\u0000-\u001f]/.test(values.link_url)
          )
            errors.push('invalid_file_link');
        } catch {
          errors.push('invalid_file_link');
        }
      }
    }
    const required =
      entity === 'task' || entity === 'goal' || entity === 'document' ? values.title : values.name;
    if (!required) errors.push('required_title');
    if ((required ?? '').length > 500) errors.push('title_too_long');
    const prefix = (
      { task: 'tsk', project: 'prj', goal: 'goal', document: 'doc', file: 'file' } as const
    )[entity as 'task' | 'project' | 'goal' | 'document' | 'file'];
    if (
      prefix &&
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
    entity: entity as PortableEntity,
    headers: mapped,
    rows,
    valid: rows.filter((r) => !r.errors.length).length,
    invalid: rows.filter((r) => r.errors.length).length,
    digest,
  };
}
