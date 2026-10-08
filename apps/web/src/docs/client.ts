import { api, protectedRequest, type StepUpResolver } from '../api.ts';
import type { BrandMarkerData } from '../shell/client.ts';
import type { Page } from '../collab/client.ts';

/** Typed client for the 4C documents API (ADR-0025). Every identifier is a public ID. */

export type RefKind = 'member' | 'team' | 'task' | 'project' | 'brand' | 'document' | 'restricted';
export const REF_KINDS: readonly RefKind[] = [
  'member',
  'team',
  'task',
  'project',
  'brand',
  'document',
  'restricted',
];

export type Run =
  | { text: string; bold?: true; italic?: true; code?: true; link?: string }
  | { ref: { kind: RefKind; id: string } };

export type CalloutTone = 'info' | 'warning' | 'success';
export type EmbedKind = 'image' | 'video' | 'link';

export type Block = { id?: string } & (
  | { type: 'paragraph' | 'quote'; runs: Run[] }
  | { type: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { type: 'callout'; tone: CalloutTone; runs: Run[] }
  | { type: 'bulleted_list' | 'numbered_list'; items: Run[][] }
  | { type: 'checklist'; items: Array<{ runs: Run[]; checked: boolean }> }
  | { type: 'code'; language: string | null; text: string }
  | { type: 'table'; header: boolean; rows: string[][] }
  | { type: 'divider' }
  | { type: 'embed'; kind: EmbedKind; url: string; title: string | null; alt: string | null }
);
export type BlockType = Block['type'];
export type DocContent = { v: 2; blocks: Block[] };

export interface RefEntry {
  kind: RefKind;
  id: string;
  label: string;
  path: string | null;
}
export type References = Record<string, RefEntry>;

export type DocType =
  | 'page'
  | 'brand_brief'
  | 'project_brief'
  | 'sop'
  | 'specification'
  | 'meeting_notes'
  | 'decision'
  | 'release_notes';
export const DOC_TYPES: ReadonlyArray<{ id: DocType; label: string }> = [
  { id: 'page', label: 'Page' },
  { id: 'brand_brief', label: 'Brand brief' },
  { id: 'project_brief', label: 'Project brief' },
  { id: 'sop', label: 'Procedure (SOP)' },
  { id: 'specification', label: 'Specification' },
  { id: 'meeting_notes', label: 'Meeting notes' },
  { id: 'decision', label: 'Decision' },
  { id: 'release_notes', label: 'Release notes' },
];
export const DOC_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  DOC_TYPES.map((t) => [t.id, t.label]),
);

export type DocState = 'draft' | 'current' | 'stale';
export const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  current: 'Current',
  stale: 'Stale',
};

export type Attachment = {
  kind: 'workspace' | 'brand' | 'project' | 'task';
  id: string | null;
  title: string | null;
};

export interface DocSummary {
  id: string;
  type: 'document';
  title: string;
  doc_type: DocType;
  doc_type_label: string;
  state: DocState;
  effective_state: DocState;
  review_due_on: string | null;
  review_overdue: boolean;
  owner: { id: string; name: string; type: string } | null;
  brand: BrandMarkerData | null;
  scope: 'workspace' | 'brand';
  attachment: Attachment;
  parent_id: string | null;
  depth: number;
  has_children: boolean;
  content_version: number;
  archived: boolean;
  updated_at: string;
}

export interface DocCapabilities {
  edit: boolean;
  comment: boolean;
  suggest: boolean;
  follow: boolean;
  assign_owner: boolean;
  create_page: boolean;
  move: boolean;
  archive: boolean;
  trash: boolean;
  share: boolean;
  export: boolean;
  request_review: boolean;
  approve_source: boolean;
}

export interface LinkEntry {
  kind: RefKind;
  id: string;
  label: string;
  path: string | null;
}

export interface Doc {
  id: string;
  type: 'document';
  title: string;
  doc_type: DocType;
  doc_type_label: string;
  state: DocState;
  effective_state: DocState;
  review_due_on: string | null;
  review_overdue: boolean;
  owner: { id: string; name: string; type: string } | null;
  created_by: { id: string; name: string } | null;
  updated_by: { id: string; name: string } | null;
  brand: BrandMarkerData | null;
  scope: 'workspace' | 'brand';
  attachment: Attachment;
  parent: { id: string; title: string } | null;
  ancestors: Array<{ id: string; title: string }>;
  depth: number;
  children_count: number;
  lifecycle_state: 'active' | 'archived' | 'trashed';
  archived: boolean;
  version: number;
  content_version: number;
  content_hash: string;
  size_bytes: number;
  content: DocContent;
  references: References;
  links: LinkEntry[];
  links_restricted: number;
  ai_source: { approved: boolean; version: number | null; at: string | null; by: string | null };
  created_at: string;
  updated_at: string;
  capabilities: DocCapabilities;
}

export type VersionKind = 'save' | 'restore' | 'suggestion' | 'template';
export interface DocVersion {
  id: string;
  type: 'document_version';
  number: number;
  title: string;
  kind: VersionKind;
  restored_from: number | null;
  template: string | null;
  summary: { added: number; changed: number; removed: number };
  size_bytes: number;
  hash: string;
  current: boolean;
  ai_source: boolean;
  by: { id: string; name: string } | null;
  at: string;
}
export interface DocVersionBody extends DocVersion {
  content: DocContent;
  references: References;
}

export type SuggestionState = 'open' | 'accepted' | 'rejected' | 'withdrawn' | 'stale';
export interface Suggestion {
  id: string;
  type: 'document_suggestion';
  document: string;
  block: string;
  base_version: number;
  state: SuggestionState;
  effective_state: SuggestionState;
  proposed: Block;
  current: Block | null;
  references: References;
  note: string | null;
  author: { id: string; name: string } | null;
  decided_by: { id: string; name: string } | null;
  decided_at: string | null;
  applied_version: number | null;
  created_at: string;
  version: number;
  capabilities: { accept: boolean; reject: boolean; withdraw: boolean };
}

export interface Backlink {
  id: string;
  type: 'document';
  title: string;
  doc_type: DocType;
  state: DocState;
  via: 'mention' | 'link';
}

export interface DocExport {
  type: 'document_export';
  format: 'markdown' | 'html';
  filename: string;
  content_type: string;
  content: string;
  bytes: number;
  pages: number;
  notes: {
    embeds_as_links: number;
    restricted_items: number;
    pages_omitted: number;
    unsupported: string[];
  };
}

export interface DocListFilters {
  scope?: string;
  project?: string;
  task?: string;
  parent?: string;
  attached?: 'any' | 'none';
  type?: string;
  state?: string;
  owner?: string;
  q?: string;
  archived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface Candidate {
  kind: 'member' | 'team' | 'record';
  id: string;
  name: string;
  /** Records only, when the server says what kind (task, project, document, brand). */
  record_type?: string;
}

const w = (ws: string) => `/v1/workspaces/${ws}`;
const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== false);
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

export const documents = {
  async list(ws: string, f: DocListFilters = {}, signal?: AbortSignal) {
    return (
      await api<Page<DocSummary>>(
        'GET',
        `${w(ws)}/documents${qs({ ...f, archived: f.archived ? 'true' : undefined })}`,
        signal ? { signal } : {},
      )
    ).body;
  },
  async get(ws: string, doc: string) {
    return (await api<{ data: Doc }>('GET', `${w(ws)}/documents/${doc}`)).body.data;
  },
  async create(
    ws: string,
    body: {
      type?: DocType;
      title?: string;
      brand?: string;
      project?: string;
      task?: string;
      parent?: string;
      starter?: boolean;
    },
    stepUp: StepUpResolver,
    idempotencyKey?: string,
  ) {
    return (
      await protectedRequest<{ data: Doc }>('POST', `${w(ws)}/documents`, body, stepUp, {
        idempotencyKey,
      })
    ).body.data;
  },
  async patch(
    ws: string,
    doc: string,
    version: number,
    body: { state?: DocState; owner?: string; review_due_on?: string | null },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Doc }>('PATCH', `${w(ws)}/documents/${doc}`, body, stepUp, {
        ifMatch: version,
      })
    ).body.data;
  },
  async saveContent(
    ws: string,
    doc: string,
    body: { base_version: number; title?: string; content: DocContent },
    stepUp: StepUpResolver,
    idempotencyKey?: string,
  ) {
    return (
      await protectedRequest<{ data: Doc }>(
        'PUT',
        `${w(ws)}/documents/${doc}/content`,
        body,
        stepUp,
        { idempotencyKey },
      )
    ).body.data;
  },
  async restoreVersion(
    ws: string,
    doc: string,
    body: { version: number; base_version: number },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Doc }>(
        'POST',
        `${w(ws)}/documents/${doc}/restore-version`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async move(
    ws: string,
    doc: string,
    body: { parent: string | null; after?: string | null },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Doc }>(
        'PUT',
        `${w(ws)}/documents/${doc}/location`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async setLinks(
    ws: string,
    doc: string,
    version: number,
    records: string[],
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Doc }>(
        'PUT',
        `${w(ws)}/documents/${doc}/links`,
        { records },
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async lifecycle(
    ws: string,
    doc: string,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore',
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: { id: string; lifecycle_state: string } }>(
        'POST',
        `${w(ws)}/documents/${doc}:${verb}`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async export(
    ws: string,
    doc: string,
    body: { format: 'markdown' | 'html'; include_children?: boolean },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: DocExport }>(
        'POST',
        `${w(ws)}/documents/${doc}:export`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async approveSource(
    ws: string,
    doc: string,
    verb: 'approve_source' | 'revoke_source',
    body: { version: number; note?: string },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Doc }>(
        'POST',
        `${w(ws)}/documents/${doc}:${verb}`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async versions(ws: string, doc: string, cursor?: string) {
    return (
      await api<Page<DocVersion>>(
        'GET',
        `${w(ws)}/documents/${doc}/versions${qs({ limit: 20, cursor })}`,
      )
    ).body;
  },
  async version(ws: string, doc: string, n: number) {
    return (await api<{ data: DocVersionBody }>('GET', `${w(ws)}/documents/${doc}/versions/${n}`))
      .body.data;
  },
  async suggestions(ws: string, doc: string, state: 'open' | 'all') {
    return (
      await api<Page<Suggestion>>(
        'GET',
        `${w(ws)}/documents/${doc}/suggestions${qs({ state, limit: 50 })}`,
      )
    ).body;
  },
  async suggest(
    ws: string,
    doc: string,
    body: { block: string; base_version: number; proposed: Block; note?: string },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Suggestion }>(
        'POST',
        `${w(ws)}/documents/${doc}/suggestions`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async decide(
    ws: string,
    dsg: string,
    outcome: 'accept' | 'reject',
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Suggestion }>(
        'POST',
        `${w(ws)}/suggestions/${dsg}:decide`,
        { outcome },
        stepUp,
      )
    ).body.data;
  },
  async withdraw(ws: string, dsg: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Suggestion }>(
        'POST',
        `${w(ws)}/suggestions/${dsg}:withdraw`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async backlinks(ws: string, rec: string) {
    return (
      await api<Page<Backlink>>('GET', `${w(ws)}/records/${rec}/documents${qs({ limit: 50 })}`)
    ).body;
  },
  async candidates(ws: string, doc: string, q: string, signal?: AbortSignal) {
    return (
      await api<{ data: Candidate[] }>(
        'GET',
        `${w(ws)}/records/${doc}/mention-candidates${qs({ q, limit: 8 })}`,
        signal ? { signal } : {},
      )
    ).body.data;
  },
};
