# 10. Live-update (SSE) contract (resolves DQ-15 and AQ-04)

## 10.1 Endpoint and subscription

- **Endpoint:** `GET /v1/workspaces/{ws}/live?topics=<t1>,<t2>`, `Accept: text/event-stream`. Authenticated by session cookie (browser) or bearer token.
- **Topics:** a topic is one of:
  - `record:<public_id>`, for an open record;
  - `op_<…>`, for an operation;
  - `scope:brand:<br_id>` or `scope:project:<prj_id>`, for list views;
  - `me`, for personal items: notifications, Today, own operations.

  A topic referencing an unreadable record or scope is silently not subscribed. The response is the same stream, so no existence oracle is possible.
- **Limits:** at most `SSE_MAX_STREAMS_PER_PRINCIPAL` concurrent streams per principal. Topics are bounded per stream.

## 10.2 Notice format

Public schema `sse-notice`, maximum class **C1**:

```
id: 1728896400-17
event: record.changed
data: {"record":{"id":"tsk_…","version":43}}
```

| Event | Meaning | Client action |
|---|---|---|
| `record.changed` | A record in a subscribed topic changed (created, updated, moved, archived, trashed). The notice is sent **only** to subscribers who can read the record at emit time. | Re-fetch through ordinary authorized reads. Lists show the "N updates" chip (0E ST-07). |
| `stream.reset` | `reason`: `buffer_overflow`, `authorization_changed`, `server_restart`, `session_ended` | Discard assumptions, re-fetch visible data, and reconnect if the stream closed |
| `heartbeat` | Sent every `SSE_HEARTBEAT_INTERVAL` | None (keeps intermediaries open) |

**Never** sent: record content, titles, field values, counts, types of unreadable records, or reasons for removal. A record that becomes unreadable produces no further notices to that subscriber. A later re-fetch returns `not_found`.

## 10.3 Reconnect and buffering

- `id` is monotonic per stream. On reconnect, the client sends `Last-Event-ID`.
- The server keeps up to `SSE_BUFFER_LIMIT` recent notices per principal and topic set. If the requested ID is still in the buffer, missed notices are replayed. **After re-authorizing each one against current permissions**, unreadable ones are dropped.
- If the ID is outside the buffer, the server sends `stream.reset` (`buffer_overflow`).

## 10.4 Authorization changes and revocation

- **Permission epoch change** for the subscriber (workspace or principal epoch, 0C §13.5): the server re-evaluates the topic set.
  - If it can re-filter immediately, it continues and drops topics that are now unreadable.
  - Otherwise it sends `stream.reset` (`authorization_changed`) and closes. The client reconnects and re-subscribes under the new permissions.
- **Session revoked, token revoked, or membership removed:** `stream.reset` (`session_ended`) and close within the next server check cycle. Reconnect then fails with the `unauthenticated` error.

## 10.5 Tabs, devices, degradation

- **Tabs:** clients should share one stream per browser via a shared worker or BroadcastChannel, falling back to one stream per tab within the limit. Each device has its own stream.
- **Polling fallback:** `GET /v1/workspaces/{ws}/changes?topics=…&since=<cursor>` returns the same notice objects with a new cursor. Clients use it when SSE is blocked, and back off to `Retry-After`.
- **Degradation:** if live updates are unavailable, the UI marks data freshness (0E ST-47) and polls. Core work is unaffected.
