# Audit and security events (Phase 1F)

Packages: `@pm/audit` (writer, change builders, chain, security-event sink, buffer drain, activity
projection, jobs). Schema: `audit` (migration 0013, plus 0014's redaction procedure and 0015's
buffer verification log). Decisions: [ADR-0009](adr/0009-audit-lifecycle.md).

## Tables

| Table | Scope | Rows | Enforcement |
|---|---|---|---|
| `audit.audit_event` | workspace (FK, forced RLS) | Material events: actor/on-behalf-of/delegation chain, target (no FK), classified `changes`, operation/attempt/correlation/causation, source, workflow revision, `R-AUDIT`, chain fields | App roles: SELECT, INSERT only. Triggers reject UPDATE/DELETE/TRUNCATE for every role, the owner included, except the value-only redaction path below |
| `audit.audit_redaction` | workspace | Which event, which fields, why, who authorized it, under which operation, when | Insert-only by `audit_maintainer`; triggers reject UPDATE/DELETE/TRUNCATE |
| `audit.security_event` | account (workspace NULL, platform scope) **or** workspace | Category, action, outcome, actor, subject, minimized network context, correlation, `R-AUDIT` | App roles: SELECT, INSERT. Triggers reject UPDATE/DELETE/TRUNCATE. RLS: `tenant_isolation` and `platform_scope` are mutually exclusive |
| `audit.chain_checkpoint` | workspace | Verified chain heads | Worker INSERT only; append-only triggers |
| `audit.activity_item` | workspace | Rebuildable, display-safe projection (`R-DERIVED`) | App reads; worker inserts/deletes (projection and purge) |
| `audit.buffer_verification` | platform | Results of verifying the 1B buffer against the sink | Worker INSERT; append-only triggers |

The tables are partition-ready (0B §10.9). Their primary keys include the time column, and no
foreign key points into them, so redactions and checkpoints reference events by plain keys. They
are not partitioned yet.

## Writing audit events (domain modules)

```ts
const catalog = defineFieldCatalog({
  title: { class: 'plain' },
  description: { class: 'content' },
  owner_email: { class: 'personal' },
  webhook_secret: { class: 'secret' },
  density: { class: 'plain', presentation: true }, // never audited
});
const cmd = CommandContext.fromExecution(executionContext, { kind: 'ui' }, { brandId: record.brandId });
const changes = diffChanges(catalog, before, after); // [] → not material: write nothing
if (changes.length) await writer.write(tx, cmd, { action: 'task.updated', target, changes });
```

- `CommandContext` is built only from a validated server `ExecutionContext`. Actor type comes from
  the effective principal, `on_behalf_of` from the initiating membership for delegated actors, and
  the delegation chain is copied as is. The brand is the server-resolved scope of the target.
  Browser input never supplies actor authority, workspace, class, or redaction.
- Each class is captured differently. `plain`: old and new values. `personal`: values, marked for
  redaction on account deletion. `content`: hash and version reference, never the body. `secret`:
  only `{changed: true}`. `credential_ref`: reference IDs only. A field missing from the catalog
  throws. Secret-looking names (`token`, `password`, `api_key`, …) cannot be declared `plain`,
  `personal`, or `content`.
- Every entry carries `digest = sha256(canonical entry without digest)`.
- The database re-validates every row (`audit.valid_changes`). It requires an array of at most 200
  entries and 64 KiB, known classes, digests, no duplicate fields, and bounded values (strings up
  to 2000 characters, arrays of up to 100 scalars, no nested objects). Secrets may not carry
  values, content may not carry bodies, and secret-looking names may not hold values.
- **Same transaction, fail closed.** The writer runs inside the caller's transaction. Any failure
  throws `AuditWriteError`, which rolls back the mutation. The failure also counts
  `audit.write_failures{module}` (alert) and logs a content-free `audit.write_failed` with IDs only.
- **Outbox hook.** Lifecycle commands also emit the registered `core.record.*` outbox events in the
  same transaction. `ActivityProjector` (worker consumer) projects audit events into
  `activity_item` afterwards. Audit truth never depends on the projection.

## Reading audit values (viewer field policy)

`viewChanges(changes, canRead)` applies the viewer's field-level read policy (0C AT-043, 0D §12.4).
A field the viewer cannot read keeps its name and position as `{redacted: true, reason: 'policy'}`;
all of its values, hashes, and version references are removed. Digests are dropped for everyone,
because a fingerprint of a short value could be brute-forced. The UI's `ChangeList` renders that
marker as "Redacted". The 1D policy layer supplies `canRead`.

## Append-only enforcement

| Path | Result |
|---|---|
| `app_rw`, `app_worker` UPDATE/DELETE/TRUNCATE | `42501`: no grant |
| A role wrongly granted UPDATE/DELETE/TRUNCATE (tested with a support-like probe role) | `42501` from the triggers |
| Owner (`migrator` → `SET ROLE pm_owner`) | `42501` from the triggers |
| Superuser TRUNCATE | Refused by the statement trigger |
| `audit_maintainer` without `app.redaction_operation_id`, or changing structure, or removing entries | `42501` |
| `audit_maintainer` + redaction operation, replacing values with `{redacted: true, reason}` and keeping `field`, `class`, `digest` | Allowed: the only mutation |

A superuser or owner can still disable triggers or drop the table. This is outside the threat
model of database enforcement, and is why the hash chain and checkpoints exist.

`audit_maintainer` is a NOLOGIN role created by the role bootstrap. Only `pm_owner` is a member,
with SET only, for ownership transfer. No login role used by the API or worker can become it. It
owns exactly one function, `audit.redact_purged_values`, which the worker may execute. The
function refuses unless all of the following hold:

1. A workspace context is set.
2. `app.redaction_operation_id` equals the operation passed in.
3. That operation is a running `purge` in this workspace.
4. The batch is in `purging` and owned by that operation.

It then redacts only the value-bearing entries (`plain`, `content`, `personal`, `credential_ref`)
of events whose target is a non-excluded batch member. It writes one `audit_redaction` row per
event it changes.

## Hash chain (tamper evidence)

The chain boundary is one chain per workspace (`chain_seq` 1, 2, …):

```
hash(n) = sha256( hash(n-1) ‖ utf8( RFC 8785 canonical JSON of payload(n) ) ),   hash(0) = 32 zero bytes
payload(n) = { v: 1, id, occurred_at (ISO, ms), workspace_id, brand_id, action,
               actor {type, id, on_behalf_of, delegation_chain}, target {record_id, type, public_id},
               changes [{field, class, digest}], operation_id, attempt_id, correlation_id,
               causation_id, source {kind, ref}, workflow_revision_id, retention_class, chain_seq }
```

The writer holds a per-workspace advisory lock until commit, reads the head, and computes the
link. A `BEFORE INSERT` trigger re-checks continuity, and `UNIQUE (workspace_id, chain_seq)`
forbids forks. As a consequence, audited writes in one workspace serialize from their audit insert
to commit. Writers must use read committed isolation, which is the default.

### Chain-lock contention (accepted tradeoff, measured)

One chain per workspace (ADR-0009 G2) means audited writes in a workspace serialize: each holds
the chain lock from its audit insert until its transaction commits. The cost is made visible:

| Signal | Meaning |
|---|---|
| `audit.chain.lock_wait` (histogram, `module`) | Time spent waiting to acquire the chain lock, measured separately from… |
| `audit.write.duration` (histogram, `module`, `outcome`) | …the whole audit write |
| `audit.chain.lock_wait_exceeded` (counter, `module`) | Writes whose wait exceeded `AUDIT_CHAIN_LOCK_WAIT_WARN_MS` (default 250 ms; configuration, not a product promise) |
| Log `audit.chain_lock_wait_high` (warn) | `workspace_id` and `duration_ms` only: it tells operators *which* workspace without putting IDs in metrics |

No metric carries a workspace, actor, or target label.

**Operational threshold** (alert, not a promise). Either condition sustained is excessive:

- p95 of `audit.chain.lock_wait` above the threshold for 15 minutes;
- `audit.chain.lock_wait_exceeded` above 1% of `audit.writes` over one hour.

**Writing rules for domain modules:**

- Write the audit event near the **end** of a short mutation transaction, after validation and
  domain writes.
- Never hold the transaction open across a network call, an external effect, a sleep, or
  unrelated long work after the audit write: the chain lock is held until commit.
- Long or bulk work runs as operations (one transaction per checkpointed step).

**Phase 11D re-evaluation trigger.** If measured contention exceeds the threshold above in
production or in 11D load tests, 11D must move to deterministic chain lanes or time partitions
while keeping verifiability. Examples:

- N lanes per workspace keyed by a stable hash, each with its own sequence and periodic
  cross-lane anchors;
- one chain per (workspace, month) partition, anchored to the previous partition's head.

Continuity checks must not be weakened, and audit must not move outside the material-change
transaction.

The contention test holds the lock for 400 ms in one transaction while five writers wait. It
proves:

- every waiter is held back;
- all of them complete promptly after the commit;
- the chain stays continuous (1–6) and verifies;
- the wait histogram, total-duration histogram, and exceeded counter are emitted with only the
  `module` label;
- the warnings carry no content.

`verifyAuditChain` (job `audit.chain_verify`, fanned out hourly per workspace by
`audit.chain_verify_fanout`) recomputes every link and digest. On a clean result it appends a
checkpoint.

| Detects | Does not detect |
|---|---|
| Altered structural fields or unredacted values (`hash_mismatch`, `value_digest_mismatch`) | A privileged actor rewriting the whole chain and its checkpoints (same database) |
| Rows deleted or inserted mid-chain (`gap`, `broken_link`), reordering, forks | Events that were never written |
| Redacted entries with no `audit_redaction` record (`unrecorded_redaction`) | Truncation of events newer than the last checkpoint |
| Tail truncation below the latest checkpoint (`truncated_below_checkpoint`, `checkpoint_mismatch`) | Anything once retention deletion (OD-36, not built) removes a prefix: verification then needs an anchor rule |

This is tamper evidence, not cryptographic non-repudiation. Anchoring checkpoints outside the
database (for example in the purge-ledger store) is a later option.

Explicit redaction keeps each entry's digest, so the chain stays valid after a recorded redaction.

## Security events

- `AuditSecurityEventSink` writes in the caller's transaction:
  - in a platform transaction for account events (workspace NULL);
  - in a workspace transaction for tenant events.
  Network context must already be a /24 or /48 prefix and a user-agent family; anything else is
  refused. Metrics are `security_events.written{category, scope}` and
  `security_events.write_failures{scope}`.
- Identity uses this sink by default (`createIdentityService`). Identity code depends only on its
  `SecurityEventPort`, so it does not know which sink is active.

### Account security activity (the only user-facing 1F route)

`GET /v1/auth/security-activity?limit=1..100&cursor=…`, signed-in account only. It returns the
account's own account-level events: the account is the actor or the subject, or the subject is one
of its own sessions. Tenant events never appear. Items contain:

- the time;
- a generic action key and outcome;
- whether the event concerns this session;
- the own session's device label;
- the network masked as `203.0.113.*`;
- the client family.

They never contain internal UUIDs, full IPs, user-agent strings, tokens, or emails. The cursor is
AES-256-GCM encrypted and bound to the account, so another account's cursor is
`422 invalid_cursor`. The response is a closed non-resource envelope (`security_activity`):
security events have no public IDs (0D marks them internal).

## Phase 1B buffer handoff (ADR-0008, executed)

1. **Cutover.** Identity writes to `audit.security_event` from this release. During a rolling
   deploy, old processes may still append to `identity.security_event_buffer`.
2. **Drain.** `security_events.buffer_drain` (platform job, every 15 min) copies rows missing from
   the sink. It keys on original `id` and `occurred_at`, works in (occurred_at, id)-ordered batches
   of 500 with one transaction per batch, and uses `ON CONFLICT DO NOTHING`. Interrupted runs
   resume from what is missing, and reruns add nothing.
3. **Verify.** Once nothing remains, the job compares buffer and sink under one repeatable-read
   snapshot:
   - total count;
   - per-day (UTC) counts;
   - SHA-256 over the canonical copied fields ordered by id.

   It appends the result to `audit.buffer_verification`. A mismatch is recorded and blocks
   retirement.
4. **Retire (later contract migration, not shipped).** Precondition: `bufferRetirementReady()`,
   meaning the latest verification is `verified` and its buffer count still equals the buffer's
   current count. Then a `-- migrate:phase contract` migration revokes the remaining INSERT grants
   and drops `identity.security_event_buffer`. It must run only after a release in which no
   process writes to the buffer.

Tests cover rerun, interruption, concurrent legacy writes during the drain, a checksum mismatch,
the zero-event case, and readiness invalidation by a late legacy row.
