import { IntegrationsPanel } from '../integrations/panel.tsx';
import { useEffect, useState, type ChangeEvent } from 'react';
import { api, newIdempotencyKey } from '../api.ts';
import { Banner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';

const ENTITIES = ['task', 'project', 'workflow', 'field', 'goal', 'document', 'file'] as const;

export function PortabilityPanel({ ws }: { ws: string }) {
  const [entity, setEntity] = useState<(typeof ENTITIES)[number]>('task');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'all_or_nothing' | 'partial'>('all_or_nothing');
  const [mappingText, setMappingText] = useState('{}');
  const [mappingName, setMappingName] = useState('');
  const [mappingId, setMappingId] = useState('');
  const [mappings, setMappings] = useState<
    Array<{ id: string; name: string; entity_kind: string; mapping_version: number }>
  >([]);
  const [mappingVersion, setMappingVersion] = useState<number | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const supportsAtomic = entity === 'task' || entity === 'project';
  const base = `/v1/workspaces/${ws}/portability`;
  useEffect(() => {
    let gone = false;
    api<{
      data: {
        mappings: Array<{
          id: string;
          name: string;
          entity_kind: string;
          mapping_version: number;
        }>;
      };
    }>('GET', `${base}/imports/mappings`)
      .then((result) => {
        if (!gone) setMappings(result.body.data.mappings);
      })
      .catch(() => {
        if (!gone) setMappings([]);
      });
    return () => {
      gone = true;
    };
  }, [base]);
  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    setPreview(null);
    setMappingId('');
    setMappingVersion(null);
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setMessage('Choose a CSV file smaller than 5 MB.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setMessage('Choose a CSV file.');
      return;
    }
    setMessage('');
    const reader = file.stream().getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let decoded = '';
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 5 * 1024 * 1024) throw new Error('file_limit');
        decoded += decoder.decode(part.value, { stream: true });
      }
      decoded += decoder.decode();
      setCsv(decoded);
    } catch {
      await reader.cancel();
      setMessage('The file must be valid UTF-8 CSV smaller than 5 MB.');
    }
  };
  const download = async () => {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`${base}/exports/${entity}.csv`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `workspace-${entity}s.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      setMessage('Export downloaded.');
    } catch {
      setMessage('The export could not be created.');
    } finally {
      setBusy(false);
    }
  };
  const inspect = async () => {
    setBusy(true);
    setMessage('');
    try {
      const body = mappingId
        ? { csv, entity, mapping_id: mappingId, mapping_version: mappingVersion }
        : { csv, entity, mapping: JSON.parse(mappingText) as Record<string, string> };
      const result = await api<{ data: Record<string, unknown> }>(
        'POST',
        `${base}/imports/preview`,
        { body },
      );
      setPreview(result.body.data);
    } catch {
      setMessage('The file could not be previewed. Check its columns and schema version.');
    } finally {
      setBusy(false);
    }
  };
  const saveMapping = async () => {
    setBusy(true);
    setMessage('');
    try {
      const mapping = JSON.parse(mappingText) as Record<string, string>;
      const current = mappings.find((item) => item.id === mappingId);
      const result = await api<{
        data: { id: string; mapping_version: number };
      }>('POST', `${base}/imports/mappings`, {
        body: {
          name: mappingName,
          entity,
          mapping,
          ...(current ? { expected_version: current.mapping_version } : {}),
        },
        headers: { 'idempotency-key': newIdempotencyKey() },
      });
      setMappingId(result.body.data.id);
      setMappingVersion(result.body.data.mapping_version);
      setMappings((current) => [
        ...current.filter((item) => item.id !== result.body.data.id),
        {
          id: result.body.data.id,
          name: mappingName,
          entity_kind: entity,
          mapping_version: result.body.data.mapping_version,
        },
      ]);
      setMessage('Mapping saved for your account.');
    } catch {
      setMessage('The mapping could not be saved. Check its destination fields.');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    setMessage('');
    try {
      const body = mappingId
        ? {
            csv,
            entity,
            mode,
            mapping_id: mappingId,
            mapping_version: mappingVersion,
            preview_id: summary?.preview_id,
          }
        : {
            csv,
            entity,
            mode,
            mapping: JSON.parse(mappingText) as Record<string, string>,
            preview_id: summary?.preview_id,
          };
      const result = await api<{ data: { import_job_id?: string } }>('POST', `${base}/imports`, {
        body,
        headers: { 'idempotency-key': newIdempotencyKey() },
      });
      setImportJobId(result.body.data.import_job_id ?? null);
      setMessage('Import finished. Review the row results below.');
    } catch {
      setMessage('The import could not be completed. No row details were disclosed.');
    } finally {
      setBusy(false);
    }
  };
  const rollback = async () => {
    if (!importJobId) return;
    setBusy(true);
    setMessage('');
    try {
      await api('POST', `${base}/imports/${encodeURIComponent(importJobId)}/rollback`, {
        headers: { 'idempotency-key': newIdempotencyKey() },
      });
      setImportJobId(null);
      setMessage('The import was rolled back where records remained unchanged.');
    } catch {
      setMessage(
        'Rollback was not possible. Records may have changed or the recovery period may have ended.',
      );
    } finally {
      setBusy(false);
    }
  };
  const summary = preview as {
    valid?: number;
    invalid?: number;
    rows?: Array<{ row?: number; errors?: string[] }>;
    preview_id?: string;
  } | null;
  return (
    <section aria-labelledby="portability-heading">
      <h2 id="portability-heading">Import and export</h2>
      <p>
        Move readable workspace records with a versioned CSV. Exports contain only records you can
        access.
      </p>
      {message ? (
        <Banner tone="info" title="Data portability">
          <p role="status">{message}</p>
        </Banner>
      ) : null}
      <div className="portability-controls">
        <label htmlFor="portability-entity">Record type</label>
        <select
          id="portability-entity"
          value={entity}
          onChange={(event) => {
            const next = event.target.value as typeof entity;
            setEntity(next);
            if (next !== 'task' && next !== 'project') setMode('partial');
            setPreview(null);
          }}
        >
          {ENTITIES.map((item) => (
            <option key={item} value={item}>
              {item[0]!.toUpperCase() + item.slice(1)}
            </option>
          ))}
        </select>
        <button type="button" onClick={download} disabled={busy}>
          Export CSV
        </button>
      </div>
      <div className="portability-controls">
        <label htmlFor="portability-file">CSV file (maximum 5 MB)</label>
        <input id="portability-file" type="file" accept=".csv,text/csv" onChange={chooseFile} />
        <label htmlFor="portability-mapping">Saved mapping</label>
        <select
          id="portability-mapping"
          value={mappingId}
          onChange={(event) => {
            const selected = mappings.find((item) => item.id === event.target.value);
            setMappingId(event.target.value);
            setMappingVersion(selected?.mapping_version ?? null);
            setPreview(null);
          }}
        >
          <option value="">Use the column names or mapping below</option>
          {mappings
            .filter((item) => item.entity_kind === entity)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} (v{item.mapping_version})
              </option>
            ))}
        </select>
        <label htmlFor="portability-mapping-json">
          Column mapping (JSON, source column to destination field)
        </label>
        <textarea
          id="portability-mapping-json"
          rows={3}
          value={mappingText}
          onChange={(event) => {
            setMappingText(event.target.value);
            setMappingId('');
          }}
          aria-describedby="portability-mapping-help"
        />
        <p id="portability-mapping-help">
          Example: {'{ "Task name": "title" }'}. Destination fields are validated by the server.
        </p>
        <label htmlFor="portability-mapping-name">Save mapping name</label>
        <input
          id="portability-mapping-name"
          value={mappingName}
          onChange={(event) => setMappingName(event.target.value)}
          maxLength={80}
        />
        <button type="button" onClick={saveMapping} disabled={busy || !mappingName.trim()}>
          Save mapping
        </button>
        <label htmlFor="portability-mode">Import behavior</label>
        <select
          id="portability-mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as typeof mode)}
        >
          <option value="all_or_nothing" disabled={!supportsAtomic}>
            All rows or none
          </option>
          <option value="partial">Apply valid rows</option>
        </select>
        <button type="button" onClick={inspect} disabled={busy || !csv}>
          Preview
        </button>
        {summary && (mode === 'partial' ? (summary.valid ?? 0) > 0 : summary.invalid === 0) ? (
          <button type="button" onClick={apply} disabled={busy}>
            Apply import
          </button>
        ) : null}
        {importJobId ? (
          <button type="button" onClick={rollback} disabled={busy}>
            Roll back this import
          </button>
        ) : null}
      </div>
      {summary ? (
        <div aria-live="polite">
          <h3>Preview results</h3>
          <p>
            {summary.valid ?? 0} valid rows; {summary.invalid ?? 0} rows need attention.
          </p>
          {summary.rows?.some((row) => row.errors?.length) ? (
            <ul aria-label="Row errors">
              {summary.rows
                .filter((row) => row.errors?.length)
                .map((row) => (
                  <li key={row.row}>
                    Row {row.row}: {row.errors!.join(', ')}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Workspace and brand connections (6A). Credentials are never shown after they are saved. */
export function IntegrationsPage({ ws }: { ws: string }) {
  return (
    <Page
      title="Integrations"
      lead="Connections, who owns them, what they may do, and when they last synchronized."
    >
      <IntegrationsPanel ws={ws} />
      <PortabilityPanel ws={ws} />
    </Page>
  );
}
