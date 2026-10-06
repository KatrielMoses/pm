import { api, protectedRequest, type StepUpResolver } from '../api.ts';

/** Typed client for the 2E capture API. Every identifier is a public ID. */

export interface Detected {
  field:
    | 'due_date'
    | 'deadline'
    | 'priority'
    | 'estimate_minutes'
    | 'recurrence'
    | 'label'
    | 'project'
    | 'brand'
    | 'owner';
  text: string;
  start: number;
  end: number;
  rule: string;
  status: 'resolved' | 'unresolved' | 'ambiguous';
  value: unknown;
  label?: string;
  options?: Array<{ value: unknown; label: string }>;
}

export interface Candidate {
  text: string;
  title: string;
  detected: Detected[];
  needs_confirmation: boolean;
  truncated: boolean;
}

export interface CaptureResult {
  id: string;
  type: 'inbox_item';
  batch: string | null;
  items: Array<{
    id?: string;
    note?: string;
    text: string;
    outcome: 'saved' | 'failed';
    code?: string;
  }>;
  links: number;
  attachments: Array<{ name: string; outcome: 'refused'; code: string }>;
}

export interface InboxItem {
  id: string;
  type: 'inbox_item';
  intent: 'task' | 'note';
  raw_text: string;
  title: string;
  detected: Detected[];
  source: { kind: string; ref?: string };
  brand: string | null;
  triage_state: 'untriaged' | 'converted' | 'merged' | 'discarded';
  converted?: { kind: string; id: string } | null;
  merged_into?: string | null;
  merged_from?: Array<{ id: string; raw_text: string; captured_at: string }>;
  links?: Array<{ id: string; url: string; title: string | null }>;
  captured_at: string;
  version: number;
}

export type TriageTarget = 'task' | 'note' | 'project' | 'discard';

export interface TriageItem {
  item: string;
  outcome: 'ready' | 'applied' | 'invalid' | 'forbidden' | 'not_found';
  code?: string;
  to?: TriageTarget;
  record?: string;
  pending?: string[];
  fields?: Record<string, unknown>;
  omitted?: string[];
}

export interface Note {
  id: string;
  type: 'note';
  title: string;
  body: string;
  brand: string | null;
  source_inbox_item: string | null;
  conversions: Array<{ kind: string; id: string; at: string }>;
  updated_at: string;
  version: number;
  created?: string | null;
}

export interface IntakeForm {
  id: string;
  type: 'intake_form';
  name: string;
  description: string;
  brand: string;
  state: 'active' | 'archived';
  target_kind?: 'task' | 'project';
  queue_owner?: string | null;
  version: number;
}

const w = (ws: string) => `/v1/workspaces/${ws}`;

/** The person's local date, so relative words ("tomorrow") mean their tomorrow. */
export const localToday = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const capture = {
  async preview(ws: string, body: Record<string, unknown>, signal?: AbortSignal) {
    return (
      await api<{ data: { parser_version: number; ai: false; candidates: Candidate[] } }>(
        'POST',
        `${w(ws)}/capture/preview`,
        { body: { today: localToday(), ...body }, ...(signal ? { signal } : {}) },
      )
    ).body.data;
  },
  async save(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: CaptureResult }>(
        'POST',
        `${w(ws)}/capture`,
        { today: localToday(), ...body },
        stepUp,
      )
    ).body.data;
  },
  async inbox(ws: string, query: { state?: 'all'; cursor?: string } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
    return (
      await api<{ data: InboxItem[]; page: { has_more: boolean; next_cursor?: string } }>(
        'GET',
        `${w(ws)}/inbox${q.toString() ? `?${q}` : ''}`,
      )
    ).body;
  },
  async item(ws: string, inb: string) {
    return (await api<{ data: InboxItem }>('GET', `${w(ws)}/inbox/${inb}`)).body.data;
  },
  async restore(ws: string, inb: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: InboxItem }>(
        'POST',
        `${w(ws)}/inbox/${inb}:return_to_inbox`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async previewTriage(ws: string, body: Record<string, unknown>) {
    return (
      await api<{ data: { to: TriageTarget; items: TriageItem[] } }>(
        'POST',
        `${w(ws)}/inbox-triage/preview`,
        {
          body,
        },
      )
    ).body.data;
  },
  async triage(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: { id: string; to: TriageTarget; items: TriageItem[] } }>(
        'POST',
        `${w(ws)}/inbox-triage`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async previewMerge(ws: string, body: { items: string[]; keep: string }) {
    return (
      await api<{
        data: {
          keep: string;
          items: Array<{
            id: string;
            raw_text: string;
            source: { kind: string };
            captured_at: string;
            role: 'kept' | 'merged';
          }>;
          preserved: string;
        };
      }>('POST', `${w(ws)}/inbox-merge/preview`, { body })
    ).body.data;
  },
  async merge(ws: string, body: { items: string[]; keep: string }, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: InboxItem }>('POST', `${w(ws)}/inbox-merge`, body, stepUp)
    ).body.data;
  },
  async notes(ws: string) {
    return (await api<{ data: Note[] }>('GET', `${w(ws)}/notes`)).body.data;
  },
  async note(ws: string, note: string) {
    return (await api<{ data: Note }>('GET', `${w(ws)}/notes/${note}`)).body.data;
  },
  async updateNote(
    ws: string,
    note: string,
    body: Record<string, unknown>,
    version: number,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Note }>('PATCH', `${w(ws)}/notes/${note}`, body, stepUp, {
        ifMatch: version,
      })
    ).body.data;
  },
  async convertNote(
    ws: string,
    note: string,
    body: Record<string, unknown>,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Note }>(
        'POST',
        `${w(ws)}/notes/${note}:convert`,
        { today: localToday(), ...body },
        stepUp,
      )
    ).body.data;
  },
  async forms(ws: string) {
    return (await api<{ data: IntakeForm[] }>('GET', `${w(ws)}/intake-forms`)).body.data;
  },
  async form(ws: string, form: string) {
    return (await api<{ data: IntakeForm }>('GET', `${w(ws)}/intake-forms/${form}`)).body.data;
  },
  async createForm(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: IntakeForm }>('POST', `${w(ws)}/intake-forms`, body, stepUp)
    ).body.data;
  },
  async updateForm(
    ws: string,
    form: string,
    body: Record<string, unknown>,
    version: number,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: IntakeForm }>(
        'PATCH',
        `${w(ws)}/intake-forms/${form}`,
        body,
        stepUp,
        {
          ifMatch: version,
        },
      )
    ).body.data;
  },
  async submit(ws: string, form: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: { received: true } }>(
        'POST',
        `${w(ws)}/intake-forms/${form}:submit`,
        body,
        stepUp,
      )
    ).body.data;
  },
};
