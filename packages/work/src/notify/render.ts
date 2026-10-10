import { recordJoins, recordProject, recordTitle } from '../collab/record-sql.ts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { compileVisibility, type Principal } from '@pm/tenancy';
import {
  isNotificationType,
  minimalLine,
  SECURITY_TYPES,
  sentence,
  typeLabel,
  type NotificationType,
} from './semantics.ts';

/** A stored notification row, as the renderers read it. */
export interface NotificationRow {
  id: string;
  public_id: string;
  type: string;
  record_id: string | null;
  actor_membership_id: string | null;
  facts: Record<string, string | number | boolean | null>;
  occurrences: number;
  state: string;
  group_key: string | null;
  created_at: Date;
  last_occurred_at: Date;
  version: number | string;
}

export const GONE = 'You no longer have access to this item';

interface RecordInfo {
  id: string;
  public_id: string;
  record_type: 'task' | 'project' | 'document';
  title: string;
  brand_id: string | null;
  project_id: string | null;
  project_public: string | null;
  project_name: string | null;
  project_readable: boolean;
  archived: boolean;
}

export interface BrandInfo {
  id: string;
  public_id: string;
  name: string;
  short_name: string | null;
  icon: string;
  color: string;
  is_sensitive: boolean;
  content_mode: 'standard' | 'minimal';
  archived: boolean;
}

const iso = (d: Date | string) => new Date(d).toISOString();

/** Brand identity for the brands among `ids` (names are shown only where the viewer may read the brand). */
export async function brandsOf(
  tx: WorkspaceTransaction,
  ids: readonly string[],
): Promise<Map<string, BrandInfo>> {
  if (!ids.length) return new Map();
  const rows = await sql<{
    id: string;
    public_id: string;
    name: string;
    short_name: string | null;
    icon: string;
    color: string;
    is_sensitive: boolean;
    notification_content_mode: 'standard' | 'minimal';
    lifecycle_state: string;
  }>`SELECT b.id, r.public_id, b.name, b.short_name, b.icon, b.color, b.is_sensitive,
            b.notification_content_mode, b.lifecycle_state
       FROM tenancy.brand b JOIN core.record r ON r.workspace_id = b.workspace_id AND r.id = b.id
      WHERE b.id = ANY(${[...ids]}::uuid[])`.execute(tx.db);
  return new Map(
    rows.rows.map((b) => [
      b.id,
      {
        id: b.id,
        public_id: b.public_id,
        name: b.name,
        short_name: b.short_name,
        icon: b.icon,
        color: b.color,
        is_sensitive: b.is_sensitive,
        content_mode: b.notification_content_mode,
        archived: b.lifecycle_state === 'archived',
      },
    ]),
  );
}

/** The records among `ids` that `principal` can read now, with what a notification shows of them. */
export async function readableRecordInfo(
  tx: WorkspaceTransaction,
  principal: Principal,
  ids: readonly string[],
  arrayMax: number,
): Promise<Map<string, RecordInfo>> {
  if (!ids.length) return new Map();
  const vis = await compileVisibility(tx, principal, {
    need: 'view',
    includeArchived: true,
    arrayMax,
  });
  const rows = await sql<{
    id: string;
    public_id: string;
    record_type: 'task' | 'project' | 'document';
    title: string;
    brand_id: string | null;
    project_id: string | null;
    lifecycle_state: string;
  }>`SELECT r.id, r.public_id, r.record_type, ${recordTitle} AS title, r.brand_id,
            ${recordProject} AS project_id, r.lifecycle_state
       FROM core.record r
       ${recordJoins}
      WHERE r.id = ANY(${[...ids]}::uuid[]) AND r.record_type IN ('task', 'project', 'document')
        AND ${vis.where('r', { project: recordProject })}`.execute(tx.db);
  const projectIds = [...new Set(rows.rows.flatMap((r) => (r.project_id ? [r.project_id] : [])))];
  const projects = new Map(
    projectIds.length
      ? (
          await sql<{ id: string; public_id: string; name: string }>`
            SELECT r.id, r.public_id, w.name FROM core.record r
              JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id
             WHERE r.id = ANY(${projectIds}::uuid[])
               AND ${vis.where('r', { project: sql`w.id` })}`.execute(tx.db)
        ).rows.map((p) => [p.id, p])
      : [],
  );
  return new Map(
    rows.rows.map((r) => {
      const p = r.project_id ? projects.get(r.project_id) : undefined;
      return [
        r.id,
        {
          id: r.id,
          public_id: r.public_id,
          record_type: r.record_type,
          title: r.title,
          brand_id: r.brand_id,
          project_id: r.project_id && r.record_type !== 'project' ? r.project_id : null,
          project_public: p && r.record_type !== 'project' ? p.public_id : null,
          project_name: p && r.record_type !== 'project' ? p.name : null,
          project_readable: !!p,
          archived: r.lifecycle_state === 'archived',
        },
      ];
    }),
  );
}

/** Display names of the people among `ids`, for viewers who may see people (members). */
export async function namesOf(
  tx: WorkspaceTransaction,
  viewer: Principal,
  ids: readonly string[],
): Promise<Map<string, { public_id: string; name: string }>> {
  if (viewer.kind !== 'member' || !ids.length) return new Map();
  const rows = await sql<{ id: string; public_id: string; name: string }>`
    SELECT m.id, m.public_id, coalesce(m.display_name_override, a.display_name) AS name
      FROM tenancy.membership m JOIN identity.account a ON a.id = m.account_id
     WHERE m.id = ANY(${[...ids]}::uuid[])`.execute(tx.db);
  return new Map(rows.rows.map((r) => [r.id, r]));
}

export interface NotificationView {
  id: string;
  type: 'notification';
  notification_type: NotificationType;
  label: string;
  state: string;
  available: boolean;
  summary: string;
  record: {
    id: string;
    type: 'task' | 'project' | 'document';
    title: string;
    archived: boolean;
  } | null;
  brand: {
    id: string;
    name: string;
    short_name: string | null;
    icon: string;
    color: string;
  } | null;
  project: { id: string; name: string } | null;
  actor: { id: string; name: string; type: 'person' } | null;
  occurrences: number;
  group: string | null;
  created_at: string;
  last_occurred_at: string;
  version: number;
}

/**
 * Notifications as `viewer` may see them now (IA-53). A row about a record the viewer can no
 * longer read keeps its time and state and loses everything else: no title, project, brand,
 * actor, facts, or counts. Security notices need no record to read and always show their sentence.
 */
export async function viewNotifications(
  tx: WorkspaceTransaction,
  viewer: Principal,
  rows: readonly NotificationRow[],
  arrayMax: number,
): Promise<NotificationView[]> {
  const recordIds = [...new Set(rows.flatMap((r) => (r.record_id ? [r.record_id] : [])))];
  const records = await readableRecordInfo(tx, viewer, recordIds, arrayMax);
  const vis = await compileVisibility(tx, viewer, {
    need: 'view',
    includeArchived: true,
    arrayMax,
  });
  const readableBrands = new Set(vis.ctx.brandIds);
  const brandIds = [
    ...new Set([...records.values()].flatMap((r) => (r.brand_id ? [r.brand_id] : []))),
  ];
  const brands = await brandsOf(
    tx,
    brandIds.filter((b) => readableBrands.has(b)),
  );
  const actors = await namesOf(
    tx,
    viewer,
    rows.flatMap((r) => (r.actor_membership_id ? [r.actor_membership_id] : [])),
  );
  return rows.map((r) => {
    const type = r.type as NotificationType;
    const rec = r.record_id ? records.get(r.record_id) : undefined;
    const security = isNotificationType(type) && SECURITY_TYPES.has(type);
    const available = !r.record_id || !!rec || security;
    const base = {
      id: r.public_id,
      type: 'notification' as const,
      notification_type: type,
      label: typeLabel(type),
      state: r.state,
      occurrences: Number(r.occurrences),
      group: r.group_key,
      created_at: iso(r.created_at),
      last_occurred_at: iso(r.last_occurred_at),
      version: Number(r.version),
    };
    // Security notices about access you lost say so; nothing names the record, brand, or actor.
    if (!available || (r.record_id && !rec))
      return {
        ...base,
        available: security,
        summary: security ? sentence(type, r.facts, null, Number(r.occurrences)) : GONE,
        record: null,
        brand: null,
        project: null,
        actor: null,
      };
    const actor = r.actor_membership_id ? actors.get(r.actor_membership_id) : undefined;
    const brand = rec?.brand_id ? brands.get(rec.brand_id) : undefined;
    return {
      ...base,
      available: true,
      summary: sentence(type, r.facts, actor?.name ?? null, Number(r.occurrences)),
      record: rec
        ? { id: rec.public_id, type: rec.record_type, title: rec.title, archived: rec.archived }
        : null,
      brand: brand
        ? {
            id: brand.public_id,
            name: brand.name,
            short_name: brand.short_name,
            icon: brand.icon,
            color: brand.color,
          }
        : null,
      project:
        rec?.project_public && rec.project_name
          ? { id: rec.project_public, name: rec.project_name }
          : null,
      actor: actor ? { id: actor.public_id, name: actor.name, type: 'person' as const } : null,
    };
  });
}

// -------------------------------------------------------------------------------------------
// External content (email and browser): re-authorized when sent, minimal by brand (UXD-10)
// -------------------------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ExternalLine {
  /** Single-line text for subjects, browser titles, and digest items. */
  line: string;
  /** Where Open leads (an app route; re-authorizes on open). */
  path: string;
  minimal: boolean;
}

/**
 * One notification as an external channel may carry it, or null when the recipient can no longer
 * read what it is about (the delivery is then suppressed). Standard content names the actor and
 * the record title; minimal content (a brand set to minimal, or any sensitive brand) names only
 * the brand and the kind.
 */
export async function externalLine(
  tx: WorkspaceTransaction,
  viewer: Principal,
  row: NotificationRow,
  workspacePublicId: string,
  arrayMax: number,
): Promise<ExternalLine | null> {
  const type = row.type as NotificationType;
  const security = SECURITY_TYPES.has(type);
  const home = `/workspaces/${workspacePublicId}/notifications`;
  if (!row.record_id)
    return { line: sentence(type, row.facts, null, row.occurrences), path: home, minimal: false };
  const recs = await readableRecordInfo(tx, viewer, [row.record_id], arrayMax);
  const rec = recs.get(row.record_id);
  if (!rec) {
    // A security notice about access that is gone still goes, but says nothing about the record.
    return security
      ? { line: sentence(type, row.facts, null, row.occurrences), path: home, minimal: true }
      : null;
  }
  const brand = rec.brand_id ? (await brandsOf(tx, [rec.brand_id])).get(rec.brand_id) : undefined;
  const path = `/workspaces/${workspacePublicId}/${rec.record_type === 'task' ? 'tasks' : rec.record_type === 'document' ? 'documents' : 'projects'}/${rec.public_id}`;
  if (brand && (brand.is_sensitive || brand.content_mode === 'minimal'))
    return { line: minimalLine(type, brand.name), path, minimal: true };
  const actors = await namesOf(
    tx,
    viewer,
    row.actor_membership_id ? [row.actor_membership_id] : [],
  );
  const actor = row.actor_membership_id ? actors.get(row.actor_membership_id) : undefined;
  const brandPart = brand ? `${brand.short_name ?? brand.name} · ` : '';
  return {
    line: `${brandPart}${sentence(type, row.facts, actor?.name ?? null, row.occurrences)}: ${rec.title}`,
    path,
    minimal: false,
  };
}

export interface EmailBody {
  subject: string;
  text: string;
  html: string;
}

/** Wraps lines and links as one email (plain text first, a matching HTML part second). */
export function composeEmail(
  subject: string,
  lines: ReadonlyArray<{ line: string; url: string }>,
  footer: string,
): EmailBody {
  const text = lines.map((l) => `${l.line}\nOpen: ${l.url}`).join('\n\n') + `\n\n${footer}\n`;
  const items = lines
    .map((l) => `<li>${esc(l.line)} <a href="${esc(l.url)}">Open</a></li>`)
    .join('');
  const html = `<!doctype html><html><body><ul>${items}</ul><p>${esc(footer)}</p></body></html>`;
  return { subject: subject.replace(/[\r\n]+/g, ' ').slice(0, 200), text, html };
}
