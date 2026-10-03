# Deletion, recovery, retention, and historical truth

Status: proposed (Phase 0A), awaiting architect review.

This document fixes **behavior**. It deliberately contains **no durations**. Every period below is a named parameter whose value requires a product-owner decision (and, where marked, legal review). Until those decisions are made, the product must not publish or display a number. Engineering builds each period as configurable, and nothing may be hard-coded.

| Parameter | Used for | Decision |
|---|---|---|
| `TRASH_RECOVERY_PERIOD` | Time a trashed record stays restorable before purge (LA-018 "published recovery period") | [OD-34](open-decisions.md#od-34) |
| `CANCELLATION_READ_ONLY_PERIOD` | Read-only access and export after cancellation (BILL-016) | [OD-35](open-decisions.md#od-35) |
| `PAYMENT_GRACE_PERIOD` | Full access after a failed payment before restrictions start (BILL-019) | [OD-35](open-decisions.md#od-35) |
| `WORKSPACE_DELETION_GRACE_PERIOD` | Time between a workspace deletion request and purge | [OD-34](open-decisions.md#od-34) |
| `IMPORT_ROLLBACK_PERIOD` | Time a completed import can be rolled back (DATA-009) | [OD-40](open-decisions.md#od-40) |
| `EXPORT_LINK_LIFETIME` | How long a generated export file can be downloaded | [OD-36](open-decisions.md#od-36) |
| Retention periods per data class (AI history, agent runs, audit, notifications, integration events, files, backups) | Purge schedules (FILE-013, AUD-008, SEC-020) | [OD-36](open-decisions.md#od-36) |
| Backup expiry | How long purged data may remain in backups | [OD-36](open-decisions.md#od-36), [OD-42](open-decisions.md#od-42) |

## 1. Removal levels

| Level | What the user experiences | Reversible? | Content retained? | Who |
|---|---|---|---|---|
| **Archive** | Hidden from active views, search defaults, Today, AI defaults, and automations. Read-only. Findable with an "include archived" filter. | Yes, any time | Yes, in full | People with archive permission |
| **Trash (soft delete)** | Removed from every normal surface. Listed in the scope's Trash with who deleted it, when, and the purge date. | Yes, until `TRASH_RECOVERY_PERIOD` ends | Yes, in full | People with delete permission |
| **Purge** | Gone. Links show "Deleted item". | **No** | No: only a tombstone (ID, type, workspace, brand, deleted-by, deleted-at, purged-at) | Retention job at period end; admins via "Delete permanently" with typed confirmation |
| **Legal/retention hold** (if adopted, [OD-37](open-decisions.md#od-37)) | No visible change for ordinary users | — | Prevents purge until released, even after the recovery period | Owners/admins on eligible plans |

Rules:

1. "Delete" in the UI always means **trash** unless the dialog says **permanently**. A permanent deletion states that it is irreversible and requires confirmation proportionate to its scope (see the 0E destructive-action conventions).
2. Archive and trash cascade through **containment only** ([hierarchy §3.1](hierarchy-and-scope.md#31-lifecycle-effects-on-children)). Deletion batches restore together.
3. **Undo** (TSK-038) is a short-lived reversal of the last reversible action in the same session. It is not a recovery mechanism: trashing and restoring are separate auditable events, and undo of a trash action is a restore.
4. Trashed and archived records keep their **IDs**. Restore never creates a new ID.
5. Purge removes content from primary storage, search indexes, AI retrieval indexes and caches, file storage, and derived summaries. Content may remain in **backups** until they expire. This must be disclosed in the retention documentation (SEC-020, SEC-028).

## 2. Restore semantics

- Restore returns the record (and its deletion batch) to its previous **container and lifecycle state**.
- If the container is gone (purged) or still trashed, the user must restore the container first. A task can instead be restored as a projectless task in the same brand ([hierarchy §3.1](hierarchy-and-scope.md#31-lifecycle-effects-on-children)). A subtask cannot be restored without its parent.
- Associations are re-attached where the counterpart still exists. Shares that were active at deletion are restored unless they were revoked or expired in the meantime.
- Restoring **does not replay** notifications, automations, webhooks, or integration pushes from the original history. A distinct *record restored* event is emitted that automations may subscribe to.
- Restoring into a brand that is now archived is blocked until the brand is restored.
- Restores are audited with the actor.

## 3. Brand, workspace, and account deletion

| Action | Behavior |
|---|---|
| **Archive brand** | Brand and all its records are archived by cascade. Its integrations pause, its automations disable, and new agent runs are blocked. Running runs must be cancelled or allowed to finish, as the user chooses. It is excluded from all-brands aggregation by default. Billing for the brand is unaffected unless the plan says otherwise. |
| **Delete brand** | The brand enters the workspace Trash as one batch. Purge follows `TRASH_RECOVERY_PERIOD`. Shares *from* the brand stop immediately, and records shared *into* it from other brands are unaffected (they belong to their own brands). |
| **Delete workspace** (SEC-021) | Owner-only, with re-authentication and typed confirmation. The workspace becomes inaccessible to members and enters `WORKSPACE_DELETION_GRACE_PERIOD`, during which the owner can cancel. Before confirmation the owner is offered a full export. After the grace period all tenant content is purged. **Billing records, invoices, and tax records are retained** as required by law, independently of the workspace ([§5](#5-records-that-must-remain-immutable-or-retained-as-evidence)). |
| **Delete account** (a person's identity) | The person's memberships end. Records they created stay in their workspaces with the actor shown as a **former member**. Personal-scope data (Inbox, Today, private views, preferences, notification history) is deleted. The person's name/email in audit events is retained or pseudonymized per [OD-39](open-decisions.md#od-39). If the person is the **sole owner** of a workspace, deletion is blocked until ownership is transferred or the workspace is deleted (ADM-013, PERM-014). |
| **Member removed / leaves** | Access ends immediately (PERM-013). Their owned records are reassigned to a chosen person. They are never left ownerless or deleted (PERM-014). Their personal-scope data in that workspace is deleted after `TRASH_RECOVERY_PERIOD`. Administrators cannot export it unless a distinct, audited privacy capability is approved and enabled later ([OD-39](open-decisions.md#od-39)). |
| **Remove sample workspace / sample data** (ONB-005, ONB-016) | Removes only records created by the sample installer, identified by provenance. Records the user created inside sample projects are listed and either kept (moved) or removed, by explicit choice. |

## 4. Cancellation, payment failure, and exports

| State | Access | Data |
|---|---|---|
| Active subscription | Full | — |
| Payment failed, within `PAYMENT_GRACE_PERIOD` | Full; prominent recovery prompts | Untouched |
| Payment failed, grace expired | Restricted per [OD-35](open-decisions.md#od-35). Recommended: read-only plus export; paid usage (AI, agents, automations) suspended | **Never deleted because of payment failure alone** (BILL-019) |
| Cancelled (end of paid period) | **Read-only + export** for `CANCELLATION_READ_ONLY_PERIOD` (BILL-016). AI, agents, automations, integrations, and scheduled deliveries stop. | Untouched |
| After the read-only period | Recommended: workspace becomes inaccessible and enters the workspace deletion path, with notice sent beforehand | Purged after the deletion grace period |

**Exports** (DATA-011..015, VIEW-022, RPT-022, AUD-009):

- An export contains only what the **requesting principal may read** at generation time, including permission-filtered comments, activity, AI history, agent runs, time records, and automation history (DATA-013). A full workspace export is available to owners/admins.
- Exports include stable record IDs and relationships (DATA-012), use documented formats (DATA-011), and include attachments as references or archives (DATA-014).
- Secrets and credentials are always redacted (SEC-014). Content belonging to purged records is never included.
- Every export is audited (who, scope, when, row counts). Export files expire after `EXPORT_LINK_LIFETIME`.
- An export is a **copy**: deleting the source later does not reach exported files the customer downloaded. The product must say so.

## 5. Records that must remain immutable or retained as evidence

These records are **append-only**. Ordinary users, admins, automations, integrations, and agents cannot edit them (AUD-007, AUD-010). Corrections are made by adding a **new record that references and supersedes** the old one, and both remain visible.

| Record | Immutable content | Retention behavior |
|---|---|---|
| **Audit events** (AUD-001..004, SEC-024) | Actor, actor type, on-behalf-of, action, target, previous/new values for material changes, timestamp, source system | Retained per audit retention ([OD-36](open-decisions.md#od-36)). They survive purge of the target as tombstone references. When a target is purged, any previous/new **content values** in its events are removed or redacted, and the structural facts (who did what, when) remain ([OD-38](open-decisions.md#od-38)). |
| **Approval and review decisions** (TSK-029/030, FILE-009) | Reviewer, decision, version reviewed, timestamp, comment | Kept as long as the reviewed record exists. Purging the record leaves a tombstone of the decision (who decided what, when, on which version hash). |
| **Go/no-go and release decisions** (TEST-024/025, AUD-007) | Approver, decision, evidence snapshot references, timestamp | Evidence referenced by a release decision is **evidence-locked**: it cannot be purged while the decision exists, except by workspace deletion or a documented legal request. |
| **Accepted deliverable versions** (FILE-009) | The accepted version's content and checksum | The accepted version cannot be overwritten. New versions are added alongside it. Trashing the task warns that it contains accepted deliverables. Purge follows the container, and the acceptance tombstone remains. |
| **Defect failure evidence** (TEST-012) | The original screenshots, logs, traces, and result as captured | Locked against edits. Retained while the defect exists. |
| **Billing records** (BILL-011) | Invoices, receipts, payments, tax details | Retained per legal obligation **even after workspace deletion**, separately from tenant content. The period requires legal review ([OD-36](open-decisions.md#od-36)). |
| **AI history** (AI-026) and **agent run history** (AGT-012, AGT-026) | Prompts, context references, outputs, proposed and applied changes, model, cost, tool calls | Immutable for its lifetime and purged per retention policy (AUD-008). Context **references** point to records and do not copy their content. When a referenced record is purged, the reference becomes a tombstone. |
| **Time entries in approved, locked periods** (TIME-013) | Entries and approval | Editable only after an audited unlock ([OD-26](open-decisions.md#od-26)) |
| **Daily planning records** (PLAN-019) | Snapshot of planned versus completed | Not rewritten by later edits to the underlying tasks |
| **Imported data provenance** (CAP-016, DATA-*) | Original captured text, source, import batch | Kept with the record |

### Comments and other user-authored content

Users can edit and delete their own comments "subject to audit rules" (COL-009). The contract is:

- The visible comment shows "edited" or "deleted" markers. The audit event records that the comment was edited or deleted, by whom, and when.
- Whether earlier comment **text** is retained in audit history after edit or delete is a privacy decision ([OD-38](open-decisions.md#od-38)). Recommended default: keep earlier versions visible to workspace admins until the comment is purged, then retain only the structural event.

## 6. Integration and import removal

- **Disconnecting an integration** (INT-008/009, CAL-015): the user chooses either **remove synchronized data** (imported external records are trashed as one batch and purged on schedule) or **retain** it (records become *detached*: no longer synced, marked "source disconnected", with provenance kept). The choice is audited. Records created inside the product and only *linked* to external items are never removed by disconnecting.
- **Import rollback** (DATA-009): within `IMPORT_ROLLBACK_PERIOD`, an import batch can be rolled back. Records created by the import are trashed as one batch. Records the import **updated** are reverted to their pre-import values only if they have not been changed since. Otherwise they are listed for manual review and are never silently overwritten.

## 7. Historical truth rules

1. **History is not rewritten by configuration.** Renaming or removing a status, field, brand, or user does not alter past events. Events store the values as they were, and display may add the current name next to them.
2. **Metrics are reproducible.** Cycle time, completion, and planned-versus-actual are computed from events and snapshots. Late edits are shown as corrections, not silently backdated (RPT-023/024).
3. **Provenance is permanent.** Source and creation method (TSK-040, CAP-016), and the actor type of every change (AUD-002), are kept for the lifetime of the record.
4. **Claims are not facts.** History records claims (agent says done, external tool says resolved) as claims with their actor, separate from verified or accepted facts ([lifecycle §3](lifecycle-and-states.md#3-completion-review-and-acceptance-are-different-facts)).
