import { describe, expect, it } from 'vitest';
import { newTraceId, newUuidV7, type ExecutionContext } from '@pm/contracts';
import {
  AuditChangeError,
  canonicalEventPayload,
  chainHash,
  change,
  changeDigest,
  CommandContext,
  CommandContextError,
  contentHash,
  defineFieldCatalog,
  diffChanges,
  displayValues,
  GENESIS_HASH,
  validateChanges,
  viewChanges,
  type ChainedEvent,
} from '@pm/audit';

const catalog = defineFieldCatalog({
  title: { class: 'plain' },
  status: { class: 'plain' },
  body: { class: 'content' },
  owner_email: { class: 'personal' },
  api_key: { class: 'secret' },
  connection_ref: { class: 'credential_ref' },
  density: { class: 'plain', presentation: true },
});

describe('classified changes (0B §7.3, 0D §12.1)', () => {
  it('captures values per class and never a secret value', () => {
    const changes = diffChanges(
      catalog,
      {
        title: 'Old',
        body: null,
        owner_email: 'a@example.test',
        api_key: 'old-secret-value',
        connection_ref: 'ref_1',
      },
      {
        title: 'New',
        body: { hash: contentHash('body text'), versionRef: 'dv_1' },
        owner_email: 'b@example.test',
        api_key: 'new-secret-value',
        connection_ref: 'ref_2',
      },
    );
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));
    expect(byField.title).toMatchObject({ class: 'plain', old: 'Old', new: 'New' });
    expect(byField.body).toMatchObject({ class: 'content', version_ref: 'dv_1' });
    expect(byField.body).not.toHaveProperty('new');
    expect(byField.owner_email).toMatchObject({ class: 'personal', old: 'a@example.test' });
    expect(byField.api_key).toEqual({
      field: 'api_key',
      class: 'secret',
      changed: true,
      digest: byField.api_key!.digest,
    });
    expect(JSON.stringify(changes).includes('secret-value')).toBe(false);
    expect(byField.connection_ref).toMatchObject({
      class: 'credential_ref',
      old: 'ref_1',
      new: 'ref_2',
    });
  });

  it('presentation-only changes are not material; unclassified fields are refused', () => {
    expect(diffChanges(catalog, { density: 'compact' }, { density: 'comfortable' })).toEqual([]);
    expect(diffChanges(catalog, { title: 'Same' }, { title: 'Same' })).toEqual([]);
    expect(() => diffChanges(catalog, {}, { surprise: 1 })).toThrow(AuditChangeError);
  });

  it('refuses secret-looking fields without a secret class, oversized and malformed values', () => {
    expect(() => defineFieldCatalog({ password_hint: { class: 'plain' } })).toThrow(
      AuditChangeError,
    );
    expect(() => change.plain('access_token', 'x', 'y')).toThrow(AuditChangeError);
    expect(() => change.plain('title', 'x', 'y'.repeat(2001))).toThrow(AuditChangeError);
    expect(() => change.plain('title', 'x', { nested: true })).toThrow(AuditChangeError);
    expect(() => change.plain('Bad-Field', 'x', 'y')).toThrow(AuditChangeError);
    expect(() => change.content('body', { hash: 'md5:abc' })).toThrow(AuditChangeError);
    expect(() => change.credentialRef('connection_ref', 'has space', null)).toThrow(
      AuditChangeError,
    );
    expect(() =>
      validateChanges(Array.from({ length: 201 }, (_, i) => change.plain(`f${i}`, 0, 1))),
    ).toThrow(AuditChangeError);
    const dup = change.plain('title', 'a', 'b');
    expect(() => validateChanges([dup, dup])).toThrow(AuditChangeError);
    expect(() => validateChanges([{ ...dup, new: 'tampered' }])).toThrow(/digest/);
    const secret = change.secret('api_key');
    expect(() => validateChanges([{ ...secret, old: 'leak' } as never])).toThrow(AuditChangeError);
  });

  it('digests are deterministic fingerprints of the entry values', () => {
    const a = change.plain('title', 'Old', 'New');
    const b = change.plain('title', 'Old', 'New');
    expect(a.digest).toBe(b.digest);
    expect(change.plain('title', 'Old', 'Other').digest).not.toBe(a.digest);
    const { digest, ...rest } = a;
    expect(changeDigest(rest)).toBe(digest);
  });
});

function event(overrides: Partial<ChainedEvent> = {}): ChainedEvent {
  return {
    id: '01920000-0000-7000-8000-0000000000a1',
    occurred_at: new Date('2026-10-03T12:00:00.123Z'),
    workspace_id: '01920000-0000-7000-8000-0000000000b1',
    brand_id: null,
    action: 'record.trashed',
    actor_type: 'human',
    actor_id: '01920000-0000-7000-8000-0000000000c1',
    on_behalf_of_membership_id: null,
    delegation_chain: [{ type: 'member', id: '01920000-0000-7000-8000-0000000000c1' }],
    target_record_id: '01920000-0000-7000-8000-0000000000d1',
    target_type: 'task',
    target_public_id: null,
    changes: [change.plain('lifecycle_state', 'active', 'trashed')],
    operation_id: null,
    attempt_id: null,
    correlation_id: '01920000-0000-7000-8000-0000000000e1',
    causation_id: null,
    source_kind: 'ui',
    source_ref: null,
    workflow_revision_id: null,
    retention_class: 'R-AUDIT',
    chain_seq: '1',
    ...overrides,
  };
}

describe('hash chain (0B §7.6)', () => {
  it('serializes deterministically regardless of property order', () => {
    const e = event();
    const reordered = Object.fromEntries(Object.entries(e).reverse()) as unknown as ChainedEvent;
    expect(canonicalEventPayload(reordered)).toBe(canonicalEventPayload(e));
    expect(chainHash(GENESIS_HASH, reordered).equals(chainHash(GENESIS_HASH, e))).toBe(true);
  });

  it('covers structural fields and value digests, and links to the previous hash', () => {
    const base = chainHash(GENESIS_HASH, event());
    for (const o of [
      { action: 'record.restored' },
      { actor_id: '01920000-0000-7000-8000-0000000000c2' },
      { chain_seq: '2' },
      { occurred_at: new Date('2026-10-03T12:00:00.124Z') },
      { changes: [change.plain('lifecycle_state', 'active', 'archived')] },
    ] as Array<Partial<ChainedEvent>>)
      expect(chainHash(GENESIS_HASH, event(o)).equals(base)).toBe(false);
    expect(chainHash(Buffer.alloc(32, 1), event()).equals(base)).toBe(false);
  });

  it('a redaction marker that keeps the digest keeps the hash (explicit redaction is chain-safe)', () => {
    const c = change.plain('title', 'Secret project name', 'x');
    const redacted = {
      field: c.field,
      class: c.class,
      digest: c.digest,
      redacted: true as const,
      reason: 'purge' as const,
    };
    expect(
      chainHash(GENESIS_HASH, event({ changes: [redacted] })).equals(
        chainHash(GENESIS_HASH, event({ changes: [c] })),
      ),
    ).toBe(true);
    expect(canonicalEventPayload(event({ changes: [c] })).includes('Secret project name')).toBe(
      false,
    );
  });
});

function exec(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const id = newUuidV7();
  return {
    workspaceId: newUuidV7(),
    correlationId: newTraceId(),
    authenticatedPrincipal: { type: 'member', id },
    effectivePrincipal: { type: 'member', id },
    delegationChain: [{ type: 'member', id }],
    epochs: { workspace: 0, principal: 0 },
    dataClassLimit: 'C2',
    ...overrides,
  };
}

describe('command context (trusted server context only)', () => {
  it('derives actor, delegation, and correlation from the execution context', () => {
    const agent = newUuidV7();
    const member = newUuidV7();
    const cmd = CommandContext.fromExecution(
      exec({
        effectivePrincipal: { type: 'agent_run', id: agent },
        initiatingMembershipId: member,
        delegationChain: [
          { type: 'member', id: member },
          { type: 'agent_run', id: agent },
        ],
      }),
      { kind: 'agent', ref: 'tool:call_1' },
    );
    expect(cmd.actor).toEqual({ type: 'agent', id: agent, onBehalfOfMembershipId: member });
    expect(cmd.delegationChain).toHaveLength(2);
    expect(cmd.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(cmd)).toBe(true);
  });

  it('refuses platform contexts, malformed brands, and unsafe source refs', () => {
    expect(() => CommandContext.fromExecution(exec({ workspaceId: null }), { kind: 'ui' })).toThrow(
      CommandContextError,
    );
    expect(() =>
      CommandContext.fromExecution(exec(), { kind: 'ui' }, { brandId: 'not-a-uuid' }),
    ).toThrow(CommandContextError);
    expect(() => CommandContext.fromExecution(exec(), { kind: 'api', ref: 'drop table;' })).toThrow(
      CommandContextError,
    );
  });
});

describe('activity projection safety (0B §7.2)', () => {
  it('projects only short plain values; never personal, content, secret, or redacted entries', () => {
    const v = displayValues([
      change.plain('title', 'a', 'Visible title'),
      change.personal('owner_email', null, 'person@example.test'),
      change.content('body', { hash: contentHash('x') }),
      change.secret('api_key'),
      change.plain('notes', '', 'y'.repeat(600)),
      { ...change.plain('status', 'a', 'b'), redacted: true },
    ]);
    expect(v).toEqual({ title: 'Visible title' });
  });
});

describe('viewer field policy (0C AT-043)', () => {
  it('redacts unreadable fields completely and never exposes digests', () => {
    const stored = [
      change.plain('title', 'Old', 'New'),
      change.plain('salary_band', 'B2', 'B3'),
      change.content('body', { hash: contentHash('x'), versionRef: 'dv_1' }),
    ];
    const view = viewChanges(stored, (f) => f === 'title');
    expect(view).toEqual([
      { field: 'title', class: 'plain', old: 'Old', new: 'New' },
      { field: 'salary_band', class: 'plain', redacted: true, reason: 'policy' },
      { field: 'body', class: 'content', redacted: true, reason: 'policy' },
    ]);
    const text = JSON.stringify(view);
    for (const leak of ['B2', 'B3', 'dv_1', 'sha256:'])
      expect(text.includes(leak), leak).toBe(false);
    expect(view).toHaveLength(stored.length); // the count is unchanged, values are not inferable
  });
});
