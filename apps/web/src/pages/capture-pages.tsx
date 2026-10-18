import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { CaptureAssist } from '../capture/capture-assist.tsx';
import {
  capture,
  type Candidate,
  type CaptureResult,
  type Detected,
  type IntakeForm,
  type TriageItem,
  type TriageTarget,
} from '../capture/client.ts';
import { projects } from '../projects/client.ts';
import { Link, useRouter } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { useLatest } from '../tasks/interaction.tsx';
import { tenancy } from '../tenancy/client.ts';
import { ResourceView, useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField, SubmitButton, TextAreaField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * Phase 2E capture (0E Phase 2E note, ADR-0017): the Capture dialog opened from every signed-in
 * screen (button or `c`), the personal Inbox with triage and merge previews, notes with
 * conversion, and brand intake forms. Detected values come from simple rules (never AI) and are
 * shown before saving; ambiguous ones are chosen when the item is filed.
 */

const FIELD_TEXT: Record<Detected['field'], string> = {
  due_date: 'Due',
  deadline: 'Deadline',
  priority: 'Priority',
  estimate_minutes: 'Duration',
  recurrence: 'Repeats',
  label: 'Label',
  project: 'Project',
  brand: 'Brand',
  owner: 'Owner',
};
const SOURCE_TEXT: Record<string, string> = {
  typed: 'Typed',
  paste: 'Pasted',
  form: 'Intake form',
  voice: 'Voice',
  email: 'Email',
  api: 'API',
  webhook: 'Webhook',
};

const shown = (d: Detected) =>
  d.status === 'ambiguous'
    ? `choose: ${d.options!.map((o) => o.label).join(' or ')}`
    : d.status === 'unresolved'
      ? `“${d.text}” not found`
      : d.field === 'estimate_minutes'
        ? `${d.value} min`
        : d.field === 'recurrence'
          ? (() => {
              const r = d.value as { frequency: string; interval: number };
              return r.interval > 1 ? `every ${r.interval} (${r.frequency})` : r.frequency;
            })()
          : (d.label ?? String(d.value));

/** Detected values for one line, as a definition list (explainable: text, rule, value). */
export function DetectedList({ detected }: { detected: Detected[] }) {
  if (!detected.length) return <p className="hint">Nothing detected; it will be saved as typed.</p>;
  return (
    <dl className="facts detected">
      {detected.map((d) => (
        <div key={`${d.field}@${d.start}`} className={`detected-${d.status}`}>
          <dt>{FIELD_TEXT[d.field]}</dt>
          <dd>
            {shown(d)} <span className="hint">(from “{d.text}”)</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

const describeError = (err: unknown) =>
  err instanceof ApiError
    ? err.code === 'offline' || err.code === 'network'
      ? "You're offline. Nothing was lost — your text is still here; save again when you're back."
      : err.code === 'rate_limited'
        ? 'Too many captures in a short time. Wait a moment and save again.'
        : (err.issues[0]?.message ?? 'Saving failed. Your text is still here.')
    : 'Saving failed. Your text is still here.';

// -----------------------------------------------------------------------------------------------
// The Capture dialog
// -----------------------------------------------------------------------------------------------

/** The signed-in account for personal drafts; null while unknown (no draft is read or written). */
function useCaptureAccount(): string | null {
  try {
    return useAuth().me?.id ?? null;
  } catch {
    // Rendered outside the auth provider (component tests): one device-local key.
    return 'device';
  }
}

export function CaptureDialog({ ws, onClose }: { ws: string; onClose: () => void }) {
  const stepUp = useStepUp();
  const latest = useLatest();
  const [intent, setIntent] = useState<'task' | 'note'>('task');
  const [text, setText] = useState('');
  const [several, setSeveral] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [edited, setEdited] = useState<string[] | null>(null);
  const [link, setLink] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CaptureResult | null>(null);
  // 7F: an AI interpretation and a voice recording the person chose to save with (one item only).
  const [interpretation, setInterpretation] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const account = useCaptureAccount();
  const lines = several ? (edited ?? []) : [text];
  // Detected values update as the person types (superseded previews are aborted).
  useEffect(() => {
    const body = several
      ? edited && edited.length
        ? { items: edited.filter((x) => x.trim()).map((x) => ({ text: x })) }
        : null
      : text.trim()
        ? { text }
        : null;
    if (!body || ('items' in body && !body.items?.length)) return;
    const t = setTimeout(() => {
      void latest((signal) => capture.preview(ws, body, signal))
        .then((r) => r && setCandidates(r.candidates))
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, text, several, edited]);
  const onPaste = (pasted: string) => {
    const parts = pasted.split(/\r?\n/).filter((l) => l.trim());
    if (parts.length > 1) {
      setSeveral(true);
      void capture
        .preview(ws, { mode: 'paste', text: pasted })
        .then((r) => {
          setEdited(r.candidates.map((c) => c.text));
          setCandidates(r.candidates);
        })
        .catch((err) => setError(describeError(err)));
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const items = several ? (edited ?? []).map((x) => x.trim()).filter(Boolean) : [];
    if (several ? !items.length : !text.trim()) return setError('Type something to capture.');
    setBusy(true);
    setError('');
    try {
      const r = await capture.save(
        ws,
        {
          intent,
          ...(several ? { items: items.map((x) => ({ text: x })) } : { text }),
          ...(!several && interpretation ? { interpretation } : {}),
          ...(!several && voice ? { voice } : {}),
          ...(links.length ? { links: links.map((url) => ({ url })) } : {}),
          ...(files.length
            ? { files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) }
            : {}),
        },
        stepUp,
      );
      setResult(r);
      // Keep only what did not save, so nothing is silently dropped.
      const failed = r.items.filter((i) => i.outcome === 'failed').map((i) => i.text);
      if (several) setEdited(failed);
      else if (!failed.length) {
        setText('');
        setInterpretation(null);
        setVoice(null);
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const saved = result?.items.filter((i) => i.outcome === 'saved').length ?? 0;
  return (
    <Dialog title="Capture" onClose={onClose}>
      <form onSubmit={(e) => void save(e)} noValidate aria-label="Capture">
        <fieldset>
          <legend>Save as</legend>
          <label className="choice">
            <input
              type="radio"
              name="intent"
              checked={intent === 'task'}
              onChange={() => setIntent('task')}
            />{' '}
            Task for my Inbox
          </label>
          <label className="choice">
            <input
              type="radio"
              name="intent"
              checked={intent === 'note'}
              onChange={() => setIntent('note')}
            />{' '}
            Note
          </label>
        </fieldset>
        {several ? (
          <fieldset>
            <legend>Items ({lines.filter((x) => x.trim()).length})</legend>
            {(edited ?? []).map((line, i) => (
              <div key={i} className="candidate">
                <Field
                  id={`cand-${i}`}
                  label={`Item ${i + 1}`}
                  value={line}
                  onChange={(e) =>
                    setEdited((edited ?? []).map((x, k) => (k === i ? e.target.value : x)))
                  }
                />
                {candidates?.[i] ? <DetectedList detected={candidates[i]!.detected} /> : null}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setEdited((edited ?? []).filter((_, k) => k !== i))}
                >
                  Remove item {i + 1}
                </button>
                {/;/.test(line) ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      setEdited([
                        ...(edited ?? []).slice(0, i),
                        ...line
                          .split(';')
                          .map((x) => x.trim())
                          .filter(Boolean),
                        ...(edited ?? []).slice(i + 1),
                      ])
                    }
                  >
                    Split item {i + 1} at semicolons
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setSeveral(false);
                setText((edited ?? []).join('\n'));
              }}
            >
              Back to one item
            </button>
          </fieldset>
        ) : (
          <>
            <TextAreaField
              id="capture-text"
              initial
              label="What do you want to capture?"
              hint="Try: Renew domain tomorrow !high 30m #ops. Paste several lines to capture several items."
              value={text}
              onChange={(t) => {
                setText(t);
                // An interpretation belongs to the exact text it read.
                setInterpretation(null);
              }}
              maxLength={10000}
              onPasteText={(pasted) => {
                // Multi-line paste turns into candidates (CAP-004).
                if (pasted.split(/\r?\n/).filter((l) => l.trim()).length < 2) return false;
                onPaste(pasted);
                return true;
              }}
            />
            <CaptureAssist
              ws={ws}
              account={account}
              text={text}
              brand={null}
              interpretation={interpretation}
              onText={setText}
              onInterpretation={setInterpretation}
              onVoice={setVoice}
            />
            {voice ? (
              <p className="hint">
                Saved as a voice capture (the transcript, as you edited it).{' '}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setVoice(null)}
                >
                  Save as typed instead
                </button>
              </p>
            ) : null}
            {candidates?.[0] && text.trim() ? (
              <section aria-label="Detected values">
                <p className="hint">Detected by simple rules — check before saving.</p>
                <p>
                  Title: <strong>{candidates[0].title}</strong>
                </p>
                <DetectedList detected={candidates[0].detected} />
                {candidates[0].needs_confirmation ? (
                  <p className="hint">
                    You'll choose the uncertain values when you file this item.
                  </p>
                ) : null}
              </section>
            ) : null}
          </>
        )}
        <fieldset>
          <legend>Attachments</legend>
          <Field
            id="capture-link"
            label="Link (https://…)"
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              if (link.trim()) setLinks([...links, link.trim()]);
              setLink('');
            }}
          >
            Add link
          </button>
          {links.length ? (
            <ul aria-label="Links to attach">
              {links.map((l, i) => (
                <li key={i}>
                  {l}{' '}
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setLinks(links.filter((_, k) => k !== i))}
                  >
                    Remove link {i + 1}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label htmlFor="capture-files">Files</label>
          <input
            id="capture-files"
            type="file"
            multiple
            onChange={(e) => setFiles([...(e.target.files ?? [])])}
          />
        </fieldset>
        {error ? (
          <p role="alert" className="field-error">
            {error}
          </p>
        ) : null}
        {result ? (
          <section aria-label="Capture result">
            <p role="status">
              {saved} saved to your {intent === 'note' ? 'notes' : 'Inbox'}.
            </p>
            {result.items.some((i) => i.outcome === 'failed') ? (
              <Banner tone="warning" title="Some items were not saved">
                <ul>
                  {result.items
                    .filter((i) => i.outcome === 'failed')
                    .map((i, k) => (
                      <li key={k}>
                        “{i.text}”: {i.code ?? 'failed'} — it is still in the list above.
                      </li>
                    ))}
                </ul>
              </Banner>
            ) : null}
            {result.attachments.length ? (
              <Banner tone="info" title="Files were not attached">
                File storage isn't available yet; your capture was saved without them:{' '}
                {result.attachments.map((a) => a.name).join(', ')}.
              </Banner>
            ) : null}
            <Link to={routeHref('inbox', { ws })}>Open Inbox</Link>
          </section>
        ) : null}
        <div className="actions">
          <SubmitButton busy={busy}>{several ? 'Save all items' : 'Save'}</SubmitButton>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------------------------
// The Inbox
// -----------------------------------------------------------------------------------------------

const OUTCOME_TEXT: Record<TriageItem['outcome'], string> = {
  ready: 'Ready',
  applied: 'Done',
  invalid: 'Needs attention',
  forbidden: "You can't create work there",
  not_found: 'Not available',
};
const CODE_TEXT: Record<string, string> = {
  brand_required: 'Choose a brand',
  needs_confirmation: 'Choose the uncertain values',
  already_triaged: 'Already filed',
};

export function InboxPage({ ws }: { ws: string }) {
  const stepUp = useStepUp();
  const { navigate } = useRouter();
  const [all, setAll] = useState(false);
  const data = useResource(
    () => capture.inbox(ws, all ? { state: 'all' } : {}),
    `inbox:${ws}:${all}`,
  );
  const brands = useResource(() => tenancy.listBrands(ws, 'active'), `brands:${ws}:inbox`);
  const [selected, setSelected] = useState<string[]>([]);
  const [to, setTo] = useState<TriageTarget>('task');
  const [brand, setBrand] = useState('');
  const [project, setProject] = useState('');
  const [choices, setChoices] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<TriageItem[] | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [mergePreview, setMergePreview] = useState<Awaited<
    ReturnType<typeof capture.previewMerge>
  > | null>(null);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const projectList = useResource(
    () =>
      brand
        ? projects.list(ws, { brands: [brand] } as never)
        : Promise.resolve({ data: [] } as never),
    `inbox-projects:${ws}:${brand}`,
  );
  const items = data.state.status === 'ready' ? data.state.data.data : [];
  const one = selected.length === 1 ? items.find((i) => i.id === selected[0]) : undefined;
  const ambiguous = one?.detected.filter((d) => d.status === 'ambiguous') ?? [];
  const body = () => ({
    items: selected,
    to,
    ...(brand && (to === 'task' || to === 'project') ? { brand } : {}),
    ...(project && to === 'task' ? { project } : {}),
    choices,
  });
  const run = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setError(
          err instanceof ApiError
            ? (err.issues[0]?.message ?? 'That did not work.')
            : 'That did not work.',
        );
    }
  };
  return (
    <Page title="Inbox" wide>
      <p className="hint">
        Only you see your Inbox. <Link to={routeHref('notes', { ws })}>Notes</Link> ·{' '}
        <Link to={routeHref('intake_forms', { ws })}>Intake forms</Link>
      </p>
      <label className="choice">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show
        filed, merged, and discarded items too
      </label>
      <ResourceView resource={data.state} onRetry={data.retry} what="inbox">
        {(d) =>
          !d.data.length ? (
            <p className="empty-state">
              Your Inbox is empty. Capture anything with the Capture button or the c key.
            </p>
          ) : (
            <ul className="plain-list inbox" aria-label="Inbox items">
              {d.data.map((i) => (
                <li key={i.id} className="inbox-item">
                  <label className="choice">
                    <input
                      type="checkbox"
                      checked={selected.includes(i.id)}
                      disabled={i.triage_state !== 'untriaged'}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, i.id]
                            : selected.filter((x) => x !== i.id),
                        )
                      }
                    />{' '}
                    <strong>{i.title}</strong>
                  </label>
                  <p className="raw-text">{i.raw_text}</p>
                  <p className="hint">
                    {SOURCE_TEXT[i.source.kind] ?? i.source.kind} ·{' '}
                    {new Date(i.captured_at).toLocaleString()}
                    {i.triage_state !== 'untriaged' ? ` · ${i.triage_state}` : ''}
                  </p>
                  <DetectedList detected={i.detected} />
                  {i.triage_state === 'merged' || i.triage_state === 'discarded' ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() =>
                        void run(async () => {
                          await capture.restore(ws, i.id, stepUp);
                          setSaid('Item restored to the Inbox.');
                          data.reload();
                        })
                      }
                    >
                      Restore “{i.title}”
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
      {selected.length ? (
        <section className="card" aria-labelledby="triage-h">
          <h2 id="triage-h">
            File {selected.length === 1 ? 'this item' : `${selected.length} items`}
          </h2>
          <SelectField
            id="triage-to"
            label="Turn into"
            value={to}
            onChange={(v) => {
              setTo(v as TriageTarget);
              setPreview(null);
            }}
            options={[
              { value: 'task', label: 'A task' },
              { value: 'project', label: 'A project' },
              { value: 'note', label: 'A note' },
              { value: 'discard', label: 'Discard (kept, can be restored)' },
            ]}
          />
          {to === 'task' || to === 'project' ? (
            <SelectField
              id="triage-brand"
              label="Brand"
              value={brand}
              onChange={(v) => {
                setBrand(v);
                setProject('');
                setPreview(null);
              }}
              options={[
                { value: '', label: 'Use the brand detected in the text' },
                ...(brands.state.status === 'ready'
                  ? brands.state.data.data
                      .filter((b) => b.capabilities.create_records)
                      .map((b) => ({ value: b.id, label: b.name }))
                  : []),
              ]}
            />
          ) : null}
          {to === 'task' && brand && projectList.state.status === 'ready' ? (
            <SelectField
              id="triage-project"
              label="Project (optional)"
              value={project}
              onChange={(v) => {
                setProject(v);
                setPreview(null);
              }}
              options={[
                { value: '', label: 'No project' },
                ...(
                  (projectList.state.data as { data: Array<{ id: string; name: string }> }).data ??
                  []
                ).map((p) => ({
                  value: p.id,
                  label: p.name,
                })),
              ]}
            />
          ) : null}
          {ambiguous.map((d) => (
            <fieldset key={`${d.field}@${d.start}`}>
              <legend>
                {FIELD_TEXT[d.field]} from “{d.text}”
              </legend>
              {[...d.options!, { value: null, label: 'Leave it out' }].map((o) => (
                <label key={String(o.value)} className="choice">
                  <input
                    type="radio"
                    name={`choice-${d.field}-${d.start}`}
                    checked={
                      JSON.stringify(choices[`${d.field}@${d.start}`]) ===
                        JSON.stringify(o.value) && `${d.field}@${d.start}` in choices
                    }
                    onChange={() => {
                      setChoices({ ...choices, [`${d.field}@${d.start}`]: o.value });
                      setPreview(null);
                    }}
                  />{' '}
                  {o.label}
                </label>
              ))}
            </fieldset>
          ))}
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() =>
                void run(async () => setPreview((await capture.previewTriage(ws, body())).items))
              }
            >
              Preview
            </button>
            {selected.length >= 2 ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setMerging(selected[0]!);
                  setMergePreview(null);
                }}
              >
                Merge…
              </button>
            ) : null}
          </div>
          {preview ? (
            <>
              <table>
                <caption>What will happen</caption>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((p) => (
                    <tr key={p.item}>
                      <td>{items.find((i) => i.id === p.item)?.title ?? 'Item'}</td>
                      <td>
                        {OUTCOME_TEXT[p.outcome]}
                        {p.code ? `: ${CODE_TEXT[p.code] ?? p.code}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                type="button"
                className="button button-primary"
                disabled={!preview.some((p) => p.outcome === 'ready')}
                onClick={() =>
                  void run(async () => {
                    const r = await capture.triage(ws, body(), stepUp);
                    const done = r.items.filter((x) => x.outcome === 'applied');
                    setSaid(`${done.length} of ${r.items.length} filed.`);
                    setSelected([]);
                    setPreview(null);
                    setChoices({});
                    data.reload();
                    if (done.length === 1 && done[0]!.record && r.to === 'task')
                      navigate(routeHref('task', { ws, tsk: done[0]!.record }));
                  })
                }
              >
                Apply
              </button>
            </>
          ) : null}
        </section>
      ) : null}
      {merging ? (
        <Dialog title="Merge items" onClose={() => setMerging(null)}>
          <fieldset>
            <legend>Keep which item?</legend>
            {selected.map((id) => (
              <label key={id} className="choice">
                <input
                  type="radio"
                  name="keep"
                  checked={merging === id}
                  onChange={() => {
                    setMerging(id);
                    setMergePreview(null);
                  }}
                />{' '}
                {items.find((i) => i.id === id)?.title}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="button"
            onClick={() =>
              void run(async () =>
                setMergePreview(await capture.previewMerge(ws, { items: selected, keep: merging })),
              )
            }
          >
            Preview merge
          </button>
          {mergePreview ? (
            <>
              <ul aria-label="Merge preview">
                {mergePreview.items.map((i) => (
                  <li key={i.id}>
                    {i.role === 'kept' ? 'Kept: ' : 'Merged into it: '}“{i.raw_text}”
                  </li>
                ))}
              </ul>
              <p className="hint">{mergePreview.preserved}</p>
              <button
                type="button"
                className="button button-primary"
                onClick={() =>
                  void run(async () => {
                    await capture.merge(ws, { items: selected, keep: merging }, stepUp);
                    setSaid('Items merged.');
                    setMerging(null);
                    setSelected([]);
                    data.reload();
                  })
                }
              >
                Merge
              </button>
            </>
          ) : null}
        </Dialog>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <Announce>{said}</Announce>
    </Page>
  );
}

// -----------------------------------------------------------------------------------------------
// Notes
// -----------------------------------------------------------------------------------------------

export function NotesPage({ ws }: { ws: string }) {
  const data = useResource(() => capture.notes(ws), `notes:${ws}`);
  return (
    <Page title="Notes">
      <p className="hint">Only you see your notes until you turn them into tasks or projects.</p>
      <ResourceView resource={data.state} onRetry={data.retry} what="notes">
        {(list) =>
          list.length ? (
            <ul className="plain-list" aria-label="Notes">
              {list.map((n) => (
                <li key={n.id}>
                  <Link to={routeHref('note', { ws, note: n.id })}>{n.title}</Link>{' '}
                  <span className="hint">{new Date(n.updated_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">
              No notes yet. Capture one with the Capture button and choose Note.
            </p>
          )
        }
      </ResourceView>
    </Page>
  );
}

export function NotePage({ ws, note }: { ws: string; note: string }) {
  const stepUp = useStepUp();
  const data = useResource(() => capture.note(ws, note), `note:${ws}:${note}`, {
    keepOnRefreshError: true,
  });
  const brands = useResource(() => tenancy.listBrands(ws, 'active'), `brands:${ws}:note`);
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [to, setTo] = useState<'task' | 'project'>('task');
  const [brand, setBrand] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const n = data.state.status === 'ready' ? data.state.data : null;
  const d = draft ?? (n ? { title: n.title, body: n.body } : { title: '', body: '' });
  return (
    <Page title={n ? n.title : 'Note'}>
      <ResourceView resource={data.state} onRetry={data.retry} what="note">
        {(note) => (
          <>
            <form
              aria-label="Edit note"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setError('');
                void capture
                  .updateNote(ws, note.id, d, note.version, stepUp)
                  .then(() => {
                    setSaid('Note saved.');
                    setDraft(null);
                    data.reload();
                  })
                  .catch((err) => setError(describeError(err)));
              }}
            >
              <Field
                id="note-title"
                label="Title"
                value={d.title}
                maxLength={300}
                onChange={(e) => setDraft({ ...d, title: e.target.value })}
              />
              <TextAreaField
                id="note-body"
                label="Note"
                value={d.body}
                onChange={(v) => setDraft({ ...d, body: v })}
              />
              <SubmitButton busy={false}>Save note</SubmitButton>
            </form>
            <section className="card" aria-labelledby="convert-h">
              <h2 id="convert-h">Turn into a task or project</h2>
              <p className="hint">
                The title becomes the name; dates and priority in the first line are used. The note
                stays.
              </p>
              <SelectField
                id="convert-to"
                label="Turn into"
                value={to}
                onChange={(v) => setTo(v as 'task' | 'project')}
                options={[
                  { value: 'task', label: 'A task' },
                  { value: 'project', label: 'A project' },
                ]}
              />
              <SelectField
                id="convert-brand"
                label="Brand"
                value={brand}
                onChange={setBrand}
                options={[
                  { value: '', label: 'Choose a brand' },
                  ...(brands.state.status === 'ready'
                    ? brands.state.data.data
                        .filter((b) => b.capabilities.create_records)
                        .map((b) => ({ value: b.id, label: b.name }))
                    : []),
                ]}
              />
              <label className="choice">
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(e) => setConfirm(e.target.checked)}
                />{' '}
                I want to create this {to}; keep the note
              </label>
              <button
                type="button"
                className="button button-primary"
                disabled={!confirm || !brand}
                onClick={() => {
                  setError('');
                  void capture
                    .convertNote(ws, note.id, { to, brand, confirm: true }, stepUp)
                    .then((r) => {
                      setSaid(`Created a ${to} from this note.`);
                      setConfirm(false);
                      data.reload();
                      void r;
                    })
                    .catch((err) => setError(describeError(err)));
                }}
              >
                Create {to}
              </button>
              {note.conversions.length ? (
                <ul aria-label="Created from this note">
                  {note.conversions.map((c) => (
                    <li key={c.id}>
                      <Link
                        to={
                          c.kind === 'task'
                            ? routeHref('task', { ws, tsk: c.id })
                            : routeHref('project', { ws, prj: c.id })
                        }
                      >
                        {c.kind} {new Date(c.at).toLocaleString()}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </>
        )}
      </ResourceView>
      {error ? <p role="alert">{error}</p> : null}
      <Announce>{said}</Announce>
    </Page>
  );
}

// -----------------------------------------------------------------------------------------------
// Intake forms (members-only while OD-28 is open)
// -----------------------------------------------------------------------------------------------

export function IntakeFormsPage({ ws }: { ws: string }) {
  const stepUp = useStepUp();
  const data = useResource(() => capture.forms(ws), `forms:${ws}`);
  const brands = useResource(() => tenancy.listBrands(ws, 'active'), `brands:${ws}:forms`);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [target, setTarget] = useState<'task' | 'project'>('task');
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  return (
    <Page title="Intake forms">
      <p className="hint">
        Members of a brand can submit its forms. Requests go to the form owner's Inbox.
      </p>
      <ResourceView resource={data.state} onRetry={data.retry} what="forms">
        {(list: IntakeForm[]) =>
          list.length ? (
            <ul className="plain-list" aria-label="Forms">
              {list.map((f) => (
                <li key={f.id}>
                  <Link to={routeHref('intake_form', { ws, form: f.id })}>{f.name}</Link>
                  {f.state === 'archived' ? ' (archived)' : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No forms you can use yet.</p>
          )
        }
      </ResourceView>
      <form
        aria-label="Create a form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          if (!brand || !name.trim()) return setError('Choose a brand and a name.');
          void capture
            .createForm(ws, { brand, name: name.trim(), target_kind: target }, stepUp)
            .then(() => {
              setSaid('Form created.');
              setName('');
              data.reload();
            })
            .catch((err) => setError(describeError(err)));
        }}
      >
        <h2>Create a form</h2>
        <SelectField
          id="form-brand"
          label="Brand"
          value={brand}
          onChange={setBrand}
          options={[
            { value: '', label: 'Choose a brand' },
            ...(brands.state.status === 'ready'
              ? brands.state.data.data.map((b) => ({ value: b.id, label: b.name }))
              : []),
          ]}
        />
        <Field
          id="form-name"
          label="Form name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField
          id="form-target"
          label="Requests usually become"
          value={target}
          onChange={(v) => setTarget(v as 'task' | 'project')}
          options={[
            { value: 'task', label: 'Tasks' },
            { value: 'project', label: 'Projects' },
          ]}
        />
        <SubmitButton busy={false}>Create form</SubmitButton>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      <Announce>{said}</Announce>
    </Page>
  );
}

export function IntakeFormPage({ ws, form }: { ws: string; form: string }) {
  const stepUp = useStepUp();
  const data = useResource(() => capture.form(ws, form), `form:${ws}:${form}`);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  return (
    <Page title={data.state.status === 'ready' ? data.state.data.name : 'Form'}>
      <ResourceView resource={data.state} onRetry={data.retry} what="form">
        {(f) => (
          <>
            {f.description ? <p>{f.description}</p> : null}
            {f.state === 'active' ? (
              <form
                aria-label="Submit a request"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  setError('');
                  if (!title.trim()) return setError('Say what you need.');
                  void capture
                    .submit(ws, f.id, { title: title.trim(), details: details.trim() }, stepUp)
                    .then(() => {
                      setSaid('Request received.');
                      setTitle('');
                      setDetails('');
                    })
                    .catch((err) => setError(describeError(err)));
                }}
              >
                <Field
                  id="req-title"
                  label="What do you need?"
                  value={title}
                  maxLength={300}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <TextAreaField
                  id="req-details"
                  label="Details (optional)"
                  value={details}
                  onChange={setDetails}
                />
                <SubmitButton busy={false}>Send request</SubmitButton>
              </form>
            ) : (
              <p>This form is archived.</p>
            )}
            {f.queue_owner !== undefined ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  void capture
                    .updateForm(
                      ws,
                      f.id,
                      { state: f.state === 'active' ? 'archived' : 'active' },
                      f.version,
                      stepUp,
                    )
                    .then(() => data.reload())
                    .catch((err) => setError(describeError(err)))
                }
              >
                {f.state === 'active' ? 'Archive form' : 'Reactivate form'}
              </button>
            ) : null}
          </>
        )}
      </ResourceView>
      {error ? <p role="alert">{error}</p> : null}
      <Announce>{said}</Announce>
    </Page>
  );
}
