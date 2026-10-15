import { describe, expect, it } from 'vitest';
import { parseCsv, previewCsv, serializeCsv } from '../../src/portability/csv.ts';

describe('CSV portability boundaries', () => {
  it('round trips quoted commas, quotes, and embedded newlines', () => {
    const csv = serializeCsv(['title'], [{ title: 'A, "quoted"\nline' }]);
    expect(parseCsv(csv)).toEqual([['title'], ['A, "quoted"\nline']]);
  });

  it('neutralizes spreadsheet formulas and keeps row order stable', () => {
    const csv = serializeCsv(['title'], [{ title: '=HYPERLINK("x")' }, { title: 'normal' }]);
    expect(parseCsv(csv)[1]?.[0]).toBe('\'=HYPERLINK("x")');
    expect(parseCsv(csv)[2]?.[0]).toBe('normal');
    expect(parseCsv(serializeCsv(['value'], [{ value: -42 }]))[1]?.[0]).toBe('-42');
    expect(parseCsv(serializeCsv(['value'], [{ value: '-cmd' }]))[1]?.[0]).toBe("'-cmd");
  });

  it('applies explicit mappings deterministically and returns row scoped validation errors', () => {
    const source = 'schema_version,Name\r\n1,Alpha\r\n';
    const a = previewCsv(source, 'task', { Name: 'title' });
    const b = previewCsv(source, 'task', { Name: 'title' });
    expect(a.digest).toBe(b.digest);
    expect(a.rows).toEqual([
      { row: 2, values: { schema_version: '1', title: 'Alpha' }, errors: [] },
    ]);
    expect(() => previewCsv(source, 'task', { Name: 'tenant_id' })).toThrow('csv_invalid_mapping');
  });

  it('rejects malformed row widths and enforces byte bounds', () => {
    expect(() => parseCsv('a,b\n1\n')).toThrow('csv_ragged_rows');
    expect(() => parseCsv('abcd', { bytes: 3, rows: 2, columns: 2, cell: 4 })).toThrow(
      'csv_too_large',
    );
  });

  it('validates every portable metadata schema without trusting authority columns', () => {
    expect(
      previewCsv('schema_version,name,record_kind,statuses\n1,Flow,task,"[]"\n', 'workflow').rows[0]
        ?.errors,
    ).toContain('invalid_statuses');
    expect(previewCsv('schema_version,name,field_type\n1,Label,text\n', 'field').valid).toBe(1);
    expect(
      previewCsv('schema_version,title,period\n1,Goal,"{}"\n', 'goal').rows[0]?.errors,
    ).toContain('invalid_period');
    expect(previewCsv('schema_version,title,document_type\n1,Page,page\n', 'document').valid).toBe(
      1,
    );
    expect(previewCsv('schema_version,name\n1,Image\n', 'file').rows[0]?.errors).toContain(
      'file_payload_required',
    );
    expect(
      previewCsv('schema_version,name,link_url\n1,Reference,https://example.test/file\n', 'file')
        .valid,
    ).toBe(1);
    expect(
      previewCsv(
        'schema_version,name,link_url\n1,Reference,https://user:pass@example.test/file\n',
        'file',
      ).rows[0]?.errors,
    ).toContain('invalid_file_link');
    expect(() => previewCsv('schema_version,tenant_id\n1,secret\n', 'task')).toThrow(
      'csv_invalid_mapping',
    );
  });

  it('rejects invalid schemas and deterministic duplicate destination mappings', () => {
    expect(
      () => previewCsv('schema_version,title\n2,Task\n', 'task').rows[0]?.errors,
    ).not.toThrow();
    expect(previewCsv('schema_version,title\n2,Task\n', 'task').rows[0]?.errors).toContain(
      'unsupported_schema_version',
    );
    expect(() =>
      previewCsv('Name,Title\nAlpha,Beta\n', 'task', { Name: 'title', Title: 'title' }),
    ).toThrow('csv_invalid_mapping');
  });
});
