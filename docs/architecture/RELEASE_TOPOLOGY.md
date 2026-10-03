# Initial release topology (Phase 0 exit-gate artifact)

Status: **accepted at the Phase 0 exit gate.**

The Phase 0 exit gate in `BUILD_ROADMAP.md` lists an "initial release topology", and no 0A–0E brief produced one. This document assembles the topology **only from already-accepted decisions**: the roadmap's reference architecture and delivery principles, 0B ADR-01/08/13/16, 0C §12, and 0D §7/§9/§10/§15/§17. It makes **no new technology, vendor, region, or capacity decision**. Every open item points to its existing decision.

## 1. Deployable units (one codebase, modular monolith)

| Unit | Role | Scales by | Contracts |
|---|---|---|---|
| **Web/API process** | Serves the UI, the `/v1` API, MCP-compatible tools, inbound webhooks (`/v1/hooks/*`), and SSE live streams | Horizontal replicas behind the load balancer | 0D [02](platform/02-http-api.md), [09](platform/09-webhooks.md), [10](platform/10-live-updates.md) |
| **Worker process** | Claims jobs through payload-free dispatcher functions and runs them one workspace transaction at a time | Replicas per queue, with per-workspace fairness caps | 0D [07](platform/07-jobs-and-execution-context.md); 0C [§12.4](access/12-rls-and-application-policy.md#124-workers-and-cross-tenant-jobs) |
| **Scheduler/dispatcher role** (inside the worker build) | Outbox dispatch, scheduled jobs (recurrence, digests, briefings, purge when enabled, retention sweeps) | Leader-safe via `SKIP LOCKED` claims; no singleton required | 0B ADR-08; 0D [08](platform/08-internal-events.md) |

The same artifact is deployed as both units, differing only in entrypoint configuration. No microservices (0B ADR-01).

## 2. Data and supporting services

| Component | Decision source | Notes |
|---|---|---|
| Managed PostgreSQL (primary + point-in-time recovery) | Roadmap reference architecture; 0B [§10](data/10-postgresql-guidance.md) | RLS on every tenant table; roles per 0C §12.3 |
| Read replica (optional, when measurements justify it) | 0B §10.1 (`app_ro`) | Reports and exports only. Subject to RLS. |
| S3-compatible object storage with quarantine and clean areas | 0B §10.8; 0D [15](platform/15-files.md) | Signed URLs with a short `SIGNED_URL_LIFETIME` |
| Secret store and KMS | 0B ADR-16 | Vendor open (DQ-28) |
| Malware scanning, email delivery, payments, AI providers, error tracking | Roadmap reference architecture (usage-based services behind adapters) | Vendors are open (roadmap approval decisions) |
| Purge ledger outside the database backup set | 0B [§8.11](data/08-deletion-retention.md#811-external-systems-and-backups) | Write-once log of IDs and scopes only |
| CDN for static assets and public help content | Roadmap reference architecture | Tenant responses are `private, no-store` (0D §2.10) |

Explicitly **absent** (roadmap "avoid at the outset"): Kafka, Redis, Elasticsearch, a separate vector database, microservices, and multi-region active-active operation.

## 3. Environments

| Environment | Purpose | Data | Identities |
|---|---|---|---|
| Local | Development | Synthetic seed | Developer-local |
| Preview (per change) | Review and automated tests | Synthetic seed, including the 0C multi-tenant authorization fixtures | Isolated credentials; no production secrets |
| Staging | Release-candidate verification, restore drills, load tests | Synthetic or anonymized only. **Never** copied production tenant data. | Separate secret store namespace |
| Production | Customers | Tenant data | Separate accounts and keys; `migrator` and `restore_operator` credentials are audited and break-glass (0C §12.3) |

Promotion follows roadmap principle 6 and 0B §10.1:

1. Build once.
2. Run migrations as expand/contract under the `migrator` identity.
3. Deploy web and worker replicas with rolling updates. Both must tolerate the previous and the next schema.
4. Check readiness (`/readyz`) before traffic.

## 4. Network and trust boundaries

- **Public ingress:** the load balancer, terminating TLS, to the web/API units only. `/healthz` and `/readyz` are reachable only from the load balancer and monitoring (0D §17.4).
- **Workers have no public ingress.** Outbound egress serves providers, webhook destinations (with SSRF controls, 0D §9.1), and AI providers.
- **The database is private**, reachable only from web, worker, migration, and restore identities.
- **Object storage** is reached by clients only through signed URLs. Application units use private credentials.
- Trust boundaries and controls follow 0C [§1.2](access/01-invariants-and-trust-boundaries.md#12-trust-boundaries).

## 5. Observability and operations

Structured logs, traces, and metrics follow 0D [17](platform/17-observability.md). Alert ownership is in 0D §17.6. Service-level targets, rate limits, region, RPO/RTO, and retention values are **unset** pending product-owner decisions (OD-42, OD-43, PQ-12, PQ-13).

## 6. Still open (not blockers for Phase 1A)

| Item | Owner / decision |
|---|---|
| Hosting provider and first region | Roadmap approval decisions; OD-43 |
| Secret store and KMS vendor | DQ-28 (1A) |
| Email, payment, scanning, AI, error-tracking vendors | Roadmap approval decisions |
| Parameter values (leases, lifetimes, limits) | PQ-05 (by owning phase) |
| Read replica, partitioning | Measured need (DQ-20, 11D) |
