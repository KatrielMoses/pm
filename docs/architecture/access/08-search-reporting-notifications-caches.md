# 8. Search, reporting, notifications, live updates, and cache safety

**Rule:** authorization is evaluated **at query or delivery time** against current grants. Projections (search documents, metric snapshots, activity items, notification rows, caches) store **scope keys** (`workspace_id`, `scope_key`, `project_id`, `record_id`, field keys). They never store allow/deny decisions as the source of truth. Revocation therefore never waits for reindexing.

## 8.1 Search

| Aspect | Rule |
|---|---|
| Full-text | `search.search_document` rows are filtered by the same predicate as lists ([04 §4.5](04-effective-permissions.md#45-compiling-to-sql)), applied to the document's `scope_key`, `project_id`, `record_id`, and `lifecycle_state`, **before** ranking limits and before `ts_headline` |
| Parts | Comment and attachment-text parts inherit their host's predicate. Only `index_for_search` fields are indexed ([07](07-field-secret-derived-data.md)). |
| Snippets and highlights | Generated only for authorized rows, from indexed (readable) parts |
| Facets and totals | The same predicate, grouped. Counts are of authorized rows only. |
| Quick search and recent searches | Recent searches are personal. Results are re-authorized on every display. |
| Future semantic search | Embeddings in `search.search_embedding` (0B) carry the same scope keys. The vector query is a pre-filtered candidate search (`WHERE <predicate> ORDER BY embedding <-> :q LIMIT k`). There is no post-filtering of the top-k, which would leak through missing results and starve pages. |
| Revocation | Effective immediately, because nothing ACL-related lives in the index |

## 8.2 Dashboards, reports, counts, metrics, capacity, portfolios

- Live queries use the visibility predicate before aggregation.
- Pre-aggregated `insights.metric_snapshot` rows are keyed by `scope_key` (and project). A viewer's value is the sum over authorized keys, with restricted projects subtracted using per-project snapshot rows. A snapshot spanning hidden scopes is never shown.
- Capacity and availability: only commitments the viewer can read (approved: no anonymous free/busy). A person always sees all of their **own** availability and commitments. Colleagues see only commitments they can read.
- Portfolio rollups, goal progress from linked work, and project completion are computed over readable records, with a "covers visible scope" label where the view is partial.
- **Scheduled reports** (`report.schedule`) are rendered **per recipient at send time**, as that recipient. A recipient who can see nothing gets an empty report or no email (AT-016).

## 8.3 Activity, recent, favorites

- Activity items are filtered by the target predicate **and**, for relationship events, by the related endpoint's predicate (AT-011).
- Recent items and favorites are personal lists of IDs. They are re-authorized on every display, and unreadable entries are dropped silently.

## 8.4 Notifications

| Stage | Rule |
|---|---|
| Fan-out | Recipients = followers, assignees, and mentioned people **who can read the record (and the relevant fields) at fan-out time** |
| Persisted row | Stores `record_id` and event type, plus a rendered summary for that recipient |
| In-app display | Re-authorized at display (IA-53). If access is lost, the row shows "You no longer have access to this item" with no title, snippet, project, or actor. |
| Email, browser, digest | Re-authorized at send time. Digests are assembled at send time from still-authorized items. Minimal-content mode applies for sensitive brands (UXD-10). Once sent, content cannot be recalled (I-12). |
| Searchable history | Searches the recipient's own notifications, with the same display-time re-authorization |

## 8.5 Saved and shared views, report delivery

A saved view is a query AST. **It never grants access.** Running a shared view compiles the viewer's own predicate and field allow-list. A view that references fields the viewer cannot read fails closed for that viewer ([07 §7.2](07-field-secret-derived-data.md#72-propagation-rules-i-18)).

## 8.6 SSE change notices and live updates (UXD-27)

- Notices carry `{public_id, version}` only.
- A notice is sent to a subscriber only if the subscriber can read the record **at emit time**, evaluated with the subscriber's cached visibility context (valid for the current epochs).
- When a subscriber's permission epoch changes, the server re-evaluates the subscriber's subscriptions. If that is not possible quickly, it closes the stream, and the client reconnects and re-subscribes (AT-035).
- Clients refetch through authorized reads. The notice itself is never trusted as content.

## 8.7 Caching rules

| Cache | Allowed? | Key / invalidation |
|---|---|---|
| Per-request visibility context | Yes | Request lifetime |
| Per-principal visibility context (brand/project arrays, restricted sets, subject keys, field allow-lists) | Yes | `(workspace_id, principal_id, workspace_epoch, principal_epoch)`. The epochs are read on every request with one indexed lookup, so a bump invalidates immediately ([13 §13.5](13-permission-changes-and-revocation.md#135-permission-epochs-and-cache-invalidation)). |
| Workspace-wide restricted sets | Yes | `(workspace_id, workspace_epoch)` |
| Derived-condition caches (dependency counts) | Yes, **only keyed by endpoint visibility scope** (0B §3.5); summed per viewer | Data events |
| Rendered pages or API responses shared across principals | **Forbidden** for tenant data | — |
| Allow/deny decisions stored in projections, search rows, metric rows, notification rows | **Forbidden** | — |
| Aggregates across principals | Only per scope key | Data events |
| CDN caching | Public content only. Tenant responses are `Cache-Control: private, no-store`. | — |
| Signed file URLs | Short-lived, issued per authorized request, never cached across principals | Expiry |

Caching an authorization decision is forbidden whenever the decision depends on anything outside the cache key: time-based expiry of a share, field policy, lifecycle state, or execution scope. Those are evaluated in the query.
