# 20. Contradictions and open questions

## 20.1 Contradictions in accepted Phase 0 contracts

<a id="pc-01"></a>
### PC-01: 0C data-model additions (AC-03) are not yet in the 0B model — resolved
- **Status:** resolved: 0C AC-03 additions and 0D execution-context columns applied to `model.json` in Phase 0 integration. The text below is kept as history.
- **Finding:** `docs/architecture/data/model/model.json` still lacks:
  - the execution-context columns on `execution.operation`/`execution.job` (effective principal, initiating membership, delegation chain, epochs at enqueue);
  - per-record share rows (`access.record_grant` still has `include_children`/`selected_child_ids`);
  - `access.field_policy`, `access.permission_epoch`, `access.service_principal`, `access.support_access_grant`;
  - project and document `access_mode`;
  - workspace policy keys.

  The 0C approval was recorded, but the model was not amended. The 0D execution-context contract (AQ-03) depends on these columns.
- **Proposed amendment:** apply AC-03 to `model.json` (and the 0B prose) as a Phase 0 integration task. No 0D change is needed.

<a id="pc-02"></a>
### PC-02: Idempotent replay in 0B §9.6 — resolved
- **Status:** resolved: approved; 0B §9.6 now states re-rendered references. The text below is kept as history.
- **Finding:** [0B §9.6](../data/09-concurrency-consistency.md#96-idempotency-logical-operations-and-attempts) says a completed key "returns the stored response". Replaying a stored body after access was revoked would bypass I-12.
- **Proposed amendment:** "A completed key returns the stored status and resource references, re-rendered through the caller's current authorization." The `response_ref` column already stores references.

<a id="pc-03"></a>
### PC-03: Signed URLs "issued before revocation" in 0C AT-014 — resolved
- **Status:** resolved: approved with bounded residual risk; 0C AT-014 and 0C §6.5 amended; proxied downloads remain a later option (PQ-16). The text below is kept as history.
- **Finding:** 0C test AT-014 expects denial for a signed URL "older than lifetime **or issued before revocation**". Object-storage presigned URLs cannot be revoked individually. A URL issued just before revocation stays valid until it expires.
- **Proposed amendment:**
  - AT-014 asserts denial **after expiry**, and that **new** download requests after revocation return the `not_found` error.
  - Within-lifetime use is a documented residual risk, bounded by a short `SIGNED_URL_LIFETIME` ([15 §15.2](15-files.md#152-download-flow)).
  - Optionally, sensitive brands use proxied streaming downloads, re-authorized per request, instead of presigned URLs (PQ-16).

## 20.2 Phase 0 integration reconciliation

| ID | Question | Action |
|---|---|---|
| <a id="pq-01"></a>PQ-01 | Apply AC-03 to the 0B model (PC-01) | **Resolved** in Phase 0 integration |
| <a id="pq-02"></a>PQ-02 | Accept the PC-02 and PC-03 amendments | **Resolved**: both approved |
| <a id="pq-03"></a>PQ-03 | Confirm the 20 public webhook event names and their field allow-lists as the launch public surface | **Resolved**: approved as the launch surface; allow-lists and delivery-time authorization stay enforced |
| <a id="pq-04"></a>PQ-04 | Confirm that SSE scope topics (`scope:brand`, `scope:project`) meet 0E list-update needs (UXD-27) without per-view server evaluation | **Resolved**: approved |

## 20.3 Deferred to the owning implementation phase

| ID | Question | Owner | Default |
|---|---|---|---|
| <a id="pq-05"></a>PQ-05 | Concrete values for all named parameters (leases, backoff, caps, buffers, lifetimes, page limits, bulk limits, tolerances) | 1A, 1B, 1E, 2D, 3A, 4E, 6B, 7A, 11C | Measured; never published as promises |
| <a id="pq-06"></a>PQ-06 | Rich-text JSON document format (affects `base_hash` canonicalization) | 4C (DQ-25) | Versioned JSON tree |
| <a id="pq-07"></a>PQ-07 | Provider-specific inbound adapters and signature schemes (GitHub, Google, payment, test runners) | 6A, 6B, 9A, 10A | Adapt into `webhook-inbound-generic` semantics |
| <a id="pq-09"></a>PQ-09 | Error message copy and localization | 0E / 10D | Safe messages in the registry |
| <a id="pq-10"></a>PQ-10 | Multipart upload thresholds and part sizes | 4E | Storage-provider defaults |
| <a id="pq-11"></a>PQ-11 | Generating OpenAPI documentation from these schemas (INT-019) | 6B | Generate from `contracts/` |

## 20.4 Product-owner approval (legal, commercial, customer promises)

| ID | Question | Related |
|---|---|---|
| <a id="pq-08"></a>PQ-08 | `DEPRECATION_NOTICE_PERIOD` and any public API compatibility commitment | 01 §1.4 |
| <a id="pq-12"></a>PQ-12 | Whether to publish rate limits, and their values | 02 §2.8 |
| <a id="pq-13"></a>PQ-13 | SLO targets and status-page commitments | OD-42, 17 §17.5 |
| <a id="pq-14"></a>PQ-14 | Whether webhook retry duration and the disablement policy are customer-facing promises | 09 |
| <a id="pq-15"></a>PQ-15 | `EXPORT_LINK_LIFETIME` and `IMPORT_ROLLBACK_PERIOD` values | OD-36, OD-40 |
| <a id="pq-16"></a>PQ-16 | Accept the signed-URL residual risk, or require proxied downloads for sensitive brands | PC-03 |
