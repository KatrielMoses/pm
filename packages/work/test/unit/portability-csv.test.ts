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
});
