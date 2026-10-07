# ADR-0018: Reusable query and saved-view engine (Phase 3A)

Status: **proposed** (implemented; awaiting one clean current-head no-skip CI run on the stacked draft PR). Engineering detail: [database.md](../database.md#phase-3a-saved-views), [tenancy.md](../tenancy.md#phase-3a-views), [lifecycle.md](../lifecycle.md#phase-3a-saved-views), [observability.md](../observability.md#views-3a).
Extends ADR-0012 (1E view state and pins) and ADR-0017 (2E).

Accepted sources (the Phase 3A brief, recorded before code):
- 0A: VIEW-012 to VIEW-020, VIEW-022, WSB-019, and TSK-034 (owned). Contributions: NAV-004, NAV-005, NAV-011, PRJ-028, WFL-009, and REL-011.
- 0B: ADR-26. `views.saved_view`, `views.view_default`, the `views.view_pin` write path, and the keyed `views.view_state` families. 0B §4.7 is the query-definition contract.
- 0C: AZ-26 (`view.share`, `views.configure`, `personal.manage_own`; no new actions). T-44, AT-146 to AT-153.
- 0D: PL-28 (`:query` and `:export`, saved-view resources and verbs, seven events, ten bounds, three signals, four envelopes) and the `collection-page` `view` object.
- 0E: the Phase 3A implementation note in 02-information-architecture.

## Decisions

| # | Topic | Decision |
|---|---|---|
| Q1 | One query AST | `views/query.ts` parses one versioned AST (`v: 1`). It holds the entity (task or project), AND/OR groups nested up to `QUERY_DEPTH_MAX`, at most `QUERY_CONDITIONS_MAX` conditions, at most `QUERY_SORTS_MAX` sort keys, and an optional group with day, week, or month buckets for dates. The field catalog is whitelisted per entity: brand, project, status, status category, priority, owner, assignee, assigned by, agent, dates, labels, milestone, health, estimate, title or name, and custom fields as `field:fld_…`. Operators are fixed per value kind. `serializeQuery` gives the canonical stored form; parsing it again gives the same query (a property test checks this). |
| Q2 | Compiler and authorization | `views/compile.ts` compiles conditions, sort keys, and group keys over aliases the engine provides. The engine always adds the viewer's own visibility predicate (`compileVisibility`), the brand scope (narrowed to readable brands, never broadened), and `lifecycle_state = active`. The AST cannot express scope or permissions. Totals, groups, rows, cursors, and exports use that same predicate. |
| Q3 | Field semantics | A task's owner is its primary assignee. Assignee and assigned-by test the assignment rows ("assigned by me" excludes self-assignment). A task's project, health, and milestone come from its project only when the viewer can read that project; otherwise they are absent everywhere, including filters. Grouping by milestone uses the readable project's next open milestone. Agent assignments do not exist before 7A, so the agent filter is exact over today's data. Date filters on timestamps compare the UTC day. Relative dates use the caller's `today` (within a day of the server's). |
| Q4 | Ordering and pages | Order is the group key, then the sorts, then manual order (rank), then the record ID. Nulls sort last in both directions. Categorical fields sort by their natural order (priority, status category and rank, health). Cursors are keyset positions over the (is-null, value) pairs of every key plus the ID, MAC-bound to the workspace, the principal, and a fingerprint of the query and scope. Any mismatch or tampering is `cursor_invalid`. Group summaries come from one `GROUP BY` on the first page only, bounded by `QUERY_GROUPS_MAX`. |
| Q5 | Custom fields | A custom field is usable in a query only when it is active, applies to the entity, is defined in a scope the viewer can read, and is `all_readers` (and guest-visible for guests) through every formula input. One recursive statement decides this. Anything else is `unsupported_field`, exactly like an unknown field. Per-record `min_level` fields are therefore never filterable or sortable. |
| Q6 | Hidden values | Every reference value (brand, project, member, label, milestone, status, option) resolves only among what the viewer can read, with one statement per referenced kind chosen from the query's structure. A hidden value and an unknown value run the same statements, match nothing, and have no label in `view.refs`. People fields are unavailable to guests. |
| Q7 | Saved views | Personal views are visible only to their owner. Sharing names exactly one scope (workspace, brand, or project) under `view.share` at that scope. Re-sharing moves the view; unsharing returns it to its owner and removes its pins and scope defaults. Changes are versioned with `If-Match`; a stale version is `conflict` and a missing one is `precondition_required`. Delete trashes the record through tenancy's saved-view lifecycle issuer. Each person may own at most `SAVED_VIEWS_MAX` views. |
| Q8 | Exports | `:export` re-runs the requester's query at request time and returns CSV or JSON directly, up to `EXPORT_ROWS_MAX` rows, with no stored artifact. Larger views are refused, and the person narrows the view. CSV cells that start with `=`, `+`, `-`, `@`, or a control character are prefixed with a quote. Every export is audited (`views.exported`, query hash only) with an `export` security event. |
| Q9 | Defaults and pins | Defaults resolve in this order: the person's own, then the project's, then the brand's. A default the person cannot read is skipped. Brand and project defaults need `views.configure` there and a view shared with that brand or project, or the workspace. Pins need `views.configure` at the pin scope and a view shared with that exact scope; a database trigger repeats the rule. At most `VIEW_PINS_MAX` pins per scope, ordered under an advisory lock. Pins appear in the sidebar after re-authorization. |
| Q10 | State and deep links | The URL's `q` holds the current query and presentation (base64url JSON), so a link reproduces the view. Filter, sort, and group changes replace the history entry. View state is kept per person, device, and view under the keyed families `views.saved.<view id>` and `views.draft.task|project`, with the scroll anchor. A shared view the person changes shows a Modified marker with Save (if they may), Save as new view, and Reset, and is never silently overwritten. |

## Recorded deviations and clarifications

- **Layout.** Saved views are workspace-level records whose share points to a scope. Record scope is immutable, so a brand-scoped record could not change share scope.
- **3B renderings.** The results surface is the engine's list. Board, table, calendar, timeline, and the other renderings are 3B's (`layout` accepts `list` only).
- **Stored exports.** VIEW-022 is implemented as a bounded direct export. The stored `export` operation with `exf_` artifacts and re-authorized downloads (0D §16.2) needs file storage (4E) and the import/export platform (6D), which enrich it later.
- **Departed members.** Personal views of departed members stay hidden until the R-PERSONAL retention period is decided. Shared views stay manageable by anyone with `view.share` at their scope.
- **Guest views.** Guests may keep personal views over their exact grants. Public or link-shared views stay disabled (PRJ-028; decision record: guests use fixed record grants only).

## Consequences

Migration `0031_saved_views` reverses exactly to 0030. The 1E pin read path now shows pins. Saved views are navigation targets (favorites, palette, pins). The `/views` destination lists personal and shared views.
