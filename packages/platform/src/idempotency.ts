import { createHash } from 'node:crypto';
import { newUuidV7, type PrincipalRef } from '@pm/contracts';
import type { ScopedTransaction } from '@pm/db';
import { canonicalJson } from './canonical-json.ts';

/** 0D §5.2 key syntax. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,128}$/;

export interface FingerprintInput {
  method: string;
  /** Route template, never the concrete URL. */
  route: string;
  pathParams: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  ifMatch?: string;
}

/** sha256 over the RFC 8785 canonical form of {method, route, params, query, body} (+ If-Match). */
export function requestFingerprint(input: FingerprintInput): Buffer {
  const canonical = canonicalJson({
    method: input.method.toUpperCase(),
    route: input.route,
    path_params: input.pathParams,
    query: input.query,
    body: input.body === undefined ? null : input.body,
    ...(input.ifMatch !== undefined ? { if_match: input.ifMatch } : {}),
  });
  return createHash('sha256').update(canonical, 'utf8').digest();
}

export function fingerprintHex(fp: Buffer): string {
  return `sha256:${fp.toString('hex')}`;
}

/** Stored references (record_ref shape); never response bodies (PC-02). */
export interface StoredResponseRef {
  status: number;
  resource_refs?: Array<{ id: string; type: string; version?: number }>;
  error_code?: string;
}

export type ReserveResult =
  | { outcome: 'reserved' }
  | { outcome: 'in_progress'; operationId: string | undefined }
  | { outcome: 'replay'; response: StoredResponseRef; operationId: string | undefined }
  | { outcome: 'key_reuse' };

export class IdempotencyKeyError extends Error {
  constructor() {
    super('invalid idempotency key');
    this.name = 'IdempotencyKeyError';
  }
}

export interface ReserveInput {
  principal: PrincipalRef;
  key: string;
  fingerprint: Buffer;
  retentionMs: number;
  operationId?: string;
}

/**
 * Reserves (workspace, principal, key). Concurrent duplicates block on the unique index until the
 * first transaction ends, then observe its outcome: in progress, replayable, or a different request.
 */
export async function reserveIdempotencyKey(
  tx: ScopedTransaction,
  input: ReserveInput,
): Promise<ReserveResult> {
  if (!IDEMPOTENCY_KEY_PATTERN.test(input.key)) throw new IdempotencyKeyError();
  const insert = () =>
    tx.db
      .insertInto('exec.idempotency_key')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        principal_type: input.principal.type,
        principal_id: input.principal.id,
        key: input.key,
        request_fingerprint: input.fingerprint,
        operation_id: input.operationId ?? null,
        expires_at: new Date(Date.now() + input.retentionMs),
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'principal_id', 'key']).doNothing())
      .returning('id')
      .executeTakeFirst();

  if (await insert()) return { outcome: 'reserved' };

  const existing = await tx.db
    .selectFrom('exec.idempotency_key')
    .select([
      'id',
      'request_fingerprint',
      'state',
      'operation_id',
      'response_status',
      'response_ref',
      'expires_at',
    ])
    .where('principal_id', '=', input.principal.id)
    .where('key', '=', input.key)
    .forUpdate()
    .executeTakeFirstOrThrow();

  if (existing.expires_at.getTime() <= Date.now()) {
    // After IDEMPOTENCY_RETENTION the same key is a new request.
    await tx.db.deleteFrom('exec.idempotency_key').where('id', '=', existing.id).execute();
    if (await insert()) return { outcome: 'reserved' };
    throw new Error('idempotency reservation raced after expiry');
  }
  if (!existing.request_fingerprint.equals(input.fingerprint)) return { outcome: 'key_reuse' };
  if (existing.state === 'in_progress')
    return { outcome: 'in_progress', operationId: existing.operation_id ?? undefined };
  return {
    outcome: 'replay',
    response: {
      status: existing.response_status ?? 500,
      ...((existing.response_ref ?? {}) as Omit<StoredResponseRef, 'status'>),
    },
    operationId: existing.operation_id ?? undefined,
  };
}

async function finish(
  tx: ScopedTransaction,
  principal: PrincipalRef,
  key: string,
  values: {
    state: 'completed' | 'failed_deterministic';
    status: number;
    ref: Omit<StoredResponseRef, 'status'>;
    operationId?: string;
  },
): Promise<void> {
  const res = await tx.db
    .updateTable('exec.idempotency_key')
    .set({
      state: values.state,
      response_status: values.status,
      response_ref: JSON.stringify(values.ref),
      ...(values.operationId !== undefined ? { operation_id: values.operationId } : {}),
      updated_at: new Date(),
    })
    .where('principal_id', '=', principal.id)
    .where('key', '=', key)
    .where('state', '=', 'in_progress')
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) !== 1) throw new Error('idempotency key is not in progress');
}

export function completeIdempotencyKey(
  tx: ScopedTransaction,
  principal: PrincipalRef,
  key: string,
  response: StoredResponseRef,
  operationId?: string,
): Promise<void> {
  const { status, ...ref } = response;
  return finish(tx, principal, key, {
    state: 'completed',
    status,
    ref,
    ...(operationId !== undefined ? { operationId } : {}),
  });
}

/** Deterministic 4xx failures (validation, authorization, not-found) are stored and replayed. */
export function failIdempotencyKeyDeterministic(
  tx: ScopedTransaction,
  principal: PrincipalRef,
  key: string,
  status: number,
  errorCode: string,
): Promise<void> {
  if (status < 400 || status > 499) throw new Error('only deterministic 4xx outcomes are stored');
  return finish(tx, principal, key, {
    state: 'failed_deterministic',
    status,
    ref: { error_code: errorCode },
  });
}

/** Transient failures are not stored: the reservation is released so a retry executes. */
export async function releaseIdempotencyKey(
  tx: ScopedTransaction,
  principal: PrincipalRef,
  key: string,
): Promise<void> {
  await tx.db
    .deleteFrom('exec.idempotency_key')
    .where('principal_id', '=', principal.id)
    .where('key', '=', key)
    .where('state', '=', 'in_progress')
    .execute();
}

/**
 * Replay hook (PC-02): stored references are re-rendered through the caller's *current*
 * authorization by `render`; references the caller can no longer read are omitted.
 */
export async function renderReplay<T>(
  response: StoredResponseRef,
  render: (ref: { id: string; type: string; version?: number }) => Promise<T | undefined>,
): Promise<{ status: number; resources: T[]; errorCode: string | undefined }> {
  const resources: T[] = [];
  for (const ref of response.resource_refs ?? []) {
    const rendered = await render(ref);
    if (rendered !== undefined) resources.push(rendered);
  }
  return { status: response.status, resources, errorCode: response.error_code };
}
