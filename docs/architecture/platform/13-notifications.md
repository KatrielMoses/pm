# 13. Notification contract

Public schema `notification`. Registry: 18 notification types ([generated/registries.md](generated/registries.md#notification-types)).

## 13.1 Pipeline

| Stage | Contract |
|---|---|
| Source | Internal events flagged `notification` ([08](08-internal-events.md)). Examples: the `work.task.assigned` event, the `collab.comment.created` event, the `collab.review.requested` event, the `execution.operation.state_changed` event (failures and agent output), and the `metering.usage.threshold_reached` event. |
| Recipient resolution | Followers, assignees, mentioned people, reviewers, owners, and configured admins (for failures and spending), minus muted scopes and preferences. Then **filter to recipients who can read the record and the relevant fields at fan-out time** (0C §8.4). |
| Persistence | One `notify.notification` row per recipient. `dedupe_key = (type, record, actor, time bucket)` makes repeated events collapse. `group_key` groups low-value bursts (COL-019). |
| Delivery-time recheck | Every channel re-authorizes **at send time**. In-app also re-authorizes **at display**. If access was lost, the row renders with `available: false` and no `record`, `brand`, or `summary` (schema-enforced; 0E IA-53). Pending email, browser, and digest content for revoked items is suppressed (`state: suppressed`). |
| Channels | `in_app` (canonical), `email`, `browser`, `digest` (UXD-18) |
| Content mode | `standard` or `minimal` per brand (UXD-10). Minimal email and browser content names only the brand and notification type ("You have a new mention in Optestra · Open"). |
| Quiet hours | Per user, in the user's timezone (NTF-009). Non-urgent channel deliveries become `deferred_quiet_hours`. In-app is unaffected. |
| Digests | Daily and weekly per preference. Assembled **at send time** from still-authorized, unread items. |
| States | `unread`, `read`, `saved`, `dismissed` (COL-020). Bulk mark-read is supported. |
| Delivery attempts | `notify.notification_delivery`, one row per channel attempt: `delivered`, `failed`, `suppressed`, `deferred_quiet_hours`. Email provider failures retry as jobs. |
| Preferences | Per event type × scope (workspace, brand, project, record) × channel → `immediate`, `digest`, `muted` (NTF-008, NTF-010) |
| History | Searchable for the recipient only, re-authorized on display (NTF-012) |

## 13.2 Not an alternate data path

- Notification `summary` text is rendered per recipient from readable fields only (≤ C2). It is never stored for other recipients and never includes hidden relationships.
- Links in notifications are API or app routes that re-authorize on open.
- Email subjects never contain unauthorized names. Minimal mode removes record titles entirely.
- Content already sent externally cannot be recalled (0C I-12). This is recorded in delivery history.
