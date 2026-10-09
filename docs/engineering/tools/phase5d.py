#!/usr/bin/env python3
"""Phase 5D closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase5d.py      # exit 1 on any failure

Phase 5D (docs/engineering/phase5/closure-5d.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, decisions D1..D16 tied to
ADR-0030 rows D1..D16) plus drift checks: the dashboard and report bounds are registered (owner 5D),
configured, and documented; the events, signals, prefixes, and envelopes are registered, and no
action is added; migration 0043 keeps its tenant isolation, its unique delivery occurrence, its
scope-bound shares, its payload-free discovery, and its exact rollback to 0042; nothing is stored
that a viewer could be shown (no figure, no metric snapshot, no rendered content); every figure,
drill-through, export, and email is computed for the person receiving it; scheduled delivery claims
reports with a lease, is idempotent by occurrence, goes through the 4B email provider boundary, and
suspends when its accountable owner loses authority; exports are bounded, audited, and formula-safe;
personal dashboards are their owner's alone; lifecycle and departure carry the records; every
acceptance test AT-269..AT-286 names a test that exists; and the later-phase boundaries (metric
definitions, AI, external connectors) are not crossed. The ADR stays proposed until acceptance.
"""
import json
import re
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402
import phase2  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

BOUNDS = {
    "DASHBOARDS_PER_SCOPE_MAX": ("dashboardsPerScopeMax", 100),
    "DASHBOARD_PERSONAL_MAX": ("dashboardPersonalMax", 20),
    "DASHBOARD_WIDGETS_MAX": ("dashboardWidgetsMax", 24),
    "REPORTS_PER_SCOPE_MAX": ("reportsPerScopeMax", 200),
    "REPORT_RECIPIENTS_MAX": ("reportRecipientsMax", 50),
    "REPORT_SHARES_MAX": ("reportSharesMax", 100),
    "REPORT_EXPORT_ROWS_MAX": ("reportExportRowsMax", 5000),
    "REPORT_EMAIL_ROWS_MAX": ("reportEmailRowsMax", 25),
    "REPORT_EXPORT_RATE_PER_MINUTE": ("reportExportRatePerMinute", 20),
    "REPORT_RUN_RETENTION_DAYS": ("reportRunRetentionDays", 90),
    "REPORT_BATCH_MAX": ("reportBatchMax", 25),
    "REPORT_LEASE_SECONDS": ("reportLeaseSeconds", 300),
    "REPORT_MAX_ATTEMPTS": ("reportMaxAttempts", 5),
    "REPORT_FRESHNESS_MINUTES": ("reportFreshnessMinutes", 720),
}
SIGNALS = ["insights.reads", "insights.changes", "insights.jobs", "insights.widgets"]
EVENTS = [
    "insights.dashboard.created", "insights.dashboard.updated", "insights.report.created",
    "insights.report.updated", "insights.report.shared", "insights.report.share_revoked",
    "insights.report.schedule_changed", "insights.report.suspended", "insights.report.resumed",
]
ENVELOPES = ["widget_result", "widget_records", "insight_metrics", "report_runs", "report_recipients",
             "report_shares"]
PREFIXES = {"dash": "insights.dashboard", "rpt": "insights.report_definition", "rsh": "insights.report_share"}
TABLES = ["insights.dashboard", "insights.report_definition", "insights.report_recipient",
          "insights.report_share", "insights.report_run"]
ENTITIES = ["dashboard", "report_definition", "report_recipient", "report_share", "report_run"]
THREATS = ["T-%d" % i for i in range(63, 71)]
TESTS = ["AT-%d" % i for i in range(269, 287)]
ADR = "docs/engineering/adr/0030-dashboards-reports.md"
MIGRATION = "packages/db/migrations/0043_dashboards_reports"
INS = "packages/work/src/insights/"
SEM = INS + "semantics.ts"
VAL = INS + "validation.ts"
METRICS = INS + "metrics.ts"
CORE = INS + "report-core.ts"
SVC = INS + "report-service.ts"
JOBS = INS + "jobs.ts"
LIFECYCLE = INS + "lifecycle.ts"
OWNERSHIP = INS + "ownership.ts"
ROUTES = "apps/api/src/work/insight-routes.ts"
INSIGHT_FILES = [SEM, VAL, METRICS, CORE, SVC, JOBS, LIFECYCLE, OWNERSHIP, ROUTES]


def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "5D":
            errs.append("%s: 0D owner must be 5D" % name)
        if "%s: '%d'" % (name, default) not in server:
            errs.append("%s: server default is not %d" % (name, default))
        if "%s: c.%s" % (camel, name) not in server:
            errs.append("%s: not mapped to settings.%s" % (name, camel))
        if "`%s`" % name not in envdoc:
            errs.append("%s: not documented in environments.md" % name)
        if camel not in settings:
            errs.append("%s: missing from WorkSettings" % camel)
        if "default %d" % default not in params.get(name, {}).get("meaning", "default %d" % default):
            errs.append("%s: 0D meaning does not state default %d" % (name, default))
    owned = {n for n, p in params.items() if p.get("owner") == "5D"}
    for n in sorted(owned - set(BOUNDS)):
        errs.append("%s: a 5D parameter the validator does not know" % n)
    signals = {t["name"] for t in registry["telemetry"]}
    for s in SIGNALS:
        if s not in signals:
            errs.append("signal %s not registered" % s)
    events = {e["type"]: e for e in registry["events"]}
    for t in EVENTS:
        if t not in events:
            errs.append("event %s not registered" % t)
        elif events[t].get("max_class") != "C1":
            errs.append("event %s must stay class C1 (enums and counts only)" % t)
    extra = {t for t in events if t.startswith("insights.")} - set(EVENTS)
    if extra:
        errs.append("unknown insights events: %s" % ", ".join(sorted(extra)))
    prefixes = {p["prefix"]: p for p in registry["id_prefixes"]}
    for prefix, entity in PREFIXES.items():
        if prefix not in prefixes:
            errs.append("prefix %s not registered" % prefix)
        elif prefixes[prefix].get("entity") != entity:
            errs.append("prefix %s must name %s" % (prefix, entity))
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for e in ENVELOPES:
        if "'%s'" % e not in envelopes:
            errs.append("envelope %s not registered" % e)
    if len(policy["actions"]) != 122:
        errs.append("5D adds no actions: expected 122, found %d" % len(policy["actions"]))
    if "'report.export'" not in read(P("packages/work/src/factory.ts")):
        errs.append("the report.export rate policy must be registered")
    od = read(P("docs/product/open-decisions.md"))
    seg = od[od.find("### OD-07 "):od.find('<a id="od-08">')]
    if "**Status (Phase 5D" not in seg:
        errs.append("OD-07 must carry its Phase 5D status")
    return errs, "%d bounds, %d events, %d signals, %d envelopes, prefixes, no new actions" % (
        len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES))


def check_migration():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("0043: %s has no tenant_isolation policy" % table)
        if "ALTER TABLE %s ENABLE ROW LEVEL SECURITY" % table not in up or \
                "ALTER TABLE %s FORCE ROW LEVEL SECURITY" % table not in up:
            errs.append("0043: %s must enable and force RLS" % table)
        if "'%s':" % table not in schema:
            errs.append("schema.ts lacks %s" % table)
        if not re.search(r"DROP TABLE %s;" % re.escape(table), down):
            errs.append("0043 down must drop %s" % table)
    for needle in ["report_run_occurrence", "report_share_report_fkey", "report_schedule_shape",
                   "report_suspended_known", "report_suspended_shape", "dashboard_placement_shape",
                   "dashboard_layout_bounded", "report_config_bounded", "report_share_active",
                   "report_share_revoked_shape", "discover_report_work", "SECURITY DEFINER",
                   "report_run_state_known", "report_run_hash_format"]:
        if needle not in up:
            errs.append("0043 lacks %s" % needle)
    for needle in ["DROP FUNCTION exec_dispatch.discover_report_work", "DROP SCHEMA insights",
                   "Restores the exact 0042 catalog"]:
        if needle not in down:
            errs.append("0043 down lacks %s" % needle)
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    # A delivery run is written by the worker only; the application role reads it.
    for m in re.finditer(r"GRANT ([A-Z, ()a-z_]+) ON ([^;]*?) TO (app_rw|app_worker)", up):
        privs, tables, role = m.group(1), m.group(2), m.group(3)
        if re.search(r"\binsights\.report_run\b", tables) and role == "app_rw" and \
                any(x in privs for x in ("INSERT", "UPDATE", "DELETE")):
            errs.append("report runs are written by the worker: app_rw must only read them")
    # Nothing a viewer could be shown is stored: a run keeps counts, a code, and a hash, never content.
    m = re.search(r"CREATE TABLE insights\.report_run \((.*?)\n\);", up, re.S)
    cols = re.findall(r"^  ([a-z_]+) ", m.group(1), re.M) if m else []
    allowed = {"id", "workspace_id", "report_id", "recipient_membership_id", "occurrence_at", "state",
               "detail", "row_count", "incomplete", "content_hash", "failure_class", "attempts",
               "created_at", "finished_at"}
    for c in cols:
        if c not in allowed and not c.startswith("constraint"):
            errs.append("insights.report_run column %s could hold what a viewer was shown" % c)
    for forbidden in ["metric_snapshot", "metric_definition", "rendered", "body", "snapshot"]:
        if re.search(r"\b%s\b" % forbidden, re.sub(r"--.*", "", up)):
            errs.append("0043 must not store %s (nothing derived is stored; 5C owns metric structures)" % forbidden)
    for schema_name in ["search", "reporting", "metrics", "agents", "integrations", "goals"]:
        if re.search(r"CREATE (SCHEMA|TABLE) %s\b" % schema_name, up):
            errs.append("0043 creates %s structures" % schema_name)
    if len(re.findall(r"^CREATE SCHEMA ", up, re.M)) != 1:
        errs.append("0043 must create only the insights schema")
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 44)))
    return errs, "tenant isolation, scope-bound shares, unique occurrence, no stored content, rollback to 0042"


def check_invariants():
    errs = []
    core = read(P(CORE))
    svc = read(P(SVC))
    sem = read(P(SEM))
    metrics = read(P(METRICS))
    jobs = read(P(JOBS))
    for cls, needle in (("InsightsCore", "export class InsightsCore extends PortfolioService"),
                        ("ReportService", "export class ReportService extends InsightsCore")):
        if needle not in core + svc:
            errs.append("%s must be one link of the service chain (%s)" % (cls, needle))
    for method in ["async createDashboard(", "async updateDashboard(", "async getDashboard(", "async listDashboards(",
                   "async dashboardWidget(", "async dashboardDrill(", "async exportDashboard(", "async createReport(",
                   "async updateReport(", "async getReport(", "async listReports(", "async reportWidget(",
                   "async reportDrill(", "async exportReport(", "async setReportSchedule(",
                   "async setReportRecipients(", "async shareReport(", "async revokeReportShare(",
                   "async resumeReport(", "async leaveReport(", "async listReportRuns(", "async runReportSweep(",
                   "async adhocWidget(", "async adhocDrill(", "async insightMetrics(", "async listTrashedInsights("]:
        if method not in svc:
            errs.append("the report service lacks %s" % method)
    for forbidden in ["withWorkspaceBypass", "SECURITY DEFINER"]:
        for name, text in (("report service", svc), ("report core", core), ("metrics", metrics)):
            if forbidden in text:
                errs.append("the %s must not use %s" % (name, forbidden))
    if "this.inWorkspace(" not in svc:
        errs.append("calls must run in a workspace transaction")
    # Dashboards and reports are never shareable as records (a report has its own explicit share).
    sharing = read(P("packages/tenancy/src/sharing.ts"))
    m = re.search(r"SHAREABLE_RECORD_TYPES[^=]*=\s*new Map\(\[(.*?)\]\);", sharing, re.S)
    for rt in ("dashboard", "report_definition"):
        if m and re.search(r"\['%s'" % rt, m.group(1)):
            errs.append("%s must not be a shareable record type" % rt)
    # Pure rules: no I/O and no clock.
    for forbidden in ["@pm/db", "sql`", "fetch(", "node:fs", "new Date()", "Date.now("]:
        if forbidden in sem:
            errs.append("semantics.ts must stay pure and deterministic (%s)" % forbidden)
    for needle in ["export function nextRun(", "export function dueOccurrence(", "export function resolveRange(",
                   "export function renderPdf(", "export function composeReportEmail(", "export function freshness(",
                   "function atLocal("]:
        if needle not in sem:
            errs.append("semantics.ts lacks %s" % needle)
    # The metric port: owners' services, the viewer's own predicate, deferred metrics listed.
    for needle in ["export interface MetricProvider", "export const PROVIDERS", "export const DEFERRED_METRICS",
                   "export async function evaluate(", "key: 'work.cycle_time'", "key: 'ai.usage'",
                   "key: 'automation.rates'", "key: 'quality.release'"]:
        if needle not in metrics:
            errs.append("metrics.ts lacks %s" % needle)
    for key in ["tasks.open", "tasks.due_soon", "tasks.overdue", "tasks.unassigned", "tasks.completed",
                "tasks.created", "projects.active", "projects.deadlines", "milestones.upcoming",
                "planning.planned_vs_completed", "time.planned_vs_actual", "time.by_brand", "time.by_project",
                "capacity.workload", "deliverables.status", "goals.progress"]:
        if "'%s'" % key not in metrics and "key: '%s'" % key not in metrics:
            errs.append("metric %s missing from the catalog" % key)
    for needle in ["workVisibility(", "ctx.host.query(", "ctx.host.goals(", "ctx.host.timeReport(",
                   "ctx.host.teamCapacity(", "ctx.host.dailyRecords("]:
        if needle not in metrics:
            errs.append("metrics must go through the owners' services (%s)" % needle)
    for forbidden in ["INSERT INTO", "UPDATE insights", "DELETE FROM"]:
        if forbidden in metrics:
            errs.append("metrics only read (%s)" % forbidden)
    # Per-recipient rendering at send time, idempotency, lease, provider boundary, and suspension.
    for needle in ["FOR UPDATE SKIP LOCKED", "reportLeaseSeconds", "reportBatchMax", "reportMaxAttempts",
                   "ON CONFLICT (workspace_id, report_id, recipient_membership_id, occurrence_at) DO NOTHING",
                   "principalOf(", "activePerson(", "deps.email.send(", "provider_unconfigured",
                   "contentHash(", "isSensitive", "nothing_visible", "no_access", "owner_departed",
                   "owner_authority", "this.scheduleAllows(", "dueOccurrence(", "reportRunRetentionDays"]:
        if needle not in svc:
            errs.append("scheduled delivery lacks %s" % needle)
    if "discoverReportWork" not in jobs:
        errs.append("the sweep must discover workspaces through discover_report_work")
    registry = read(P("apps/worker/src/registry.ts"))
    if "reportDeliveryHandler" not in registry or "REPORT_SCHEDULES" not in registry:
        errs.append("the worker must register the insights.deliver job and its schedule")
    # Exports: bounded, rate limited, audited, formula-safe.
    for needle in ["reportExportRowsMax", "insights.exported", "'report.export'", "csv(", "category: 'export'"]:
        if needle not in svc:
            errs.append("export lacks %s" % needle)
    # Authority decisions.
    for needle in ["'record.update'", "'record.share'", "'record.share_revoke'", "'record.export'",
                   "requirePersonalDashboard(", "issuePersonalRecordLifecycleDecision"]:
        if needle not in svc + core:
            errs.append("authorization lacks %s" % needle)
    if "'report.schedule'" not in core:
        errs.append("report.schedule must be decided at the report's scope (report-core)")
    # Routes.
    routes = read(P(ROUTES))
    for path in ["/insights/metrics`", "/insights/trash`", "/insights/widget`", "/insights/widget/records`",
                 "/dashboards`", "/dashboards/:dash`", "/dashboards/:dash/widgets/:wdg`",
                 "/dashboards/:dash/widgets/:wdg/records`", "/dashboards/:dash/export`", "/reports`",
                 "/reports/:rpt`", "/reports/:rpt/widgets/:wdg`", "/reports/:rpt/widgets/:wdg/records`",
                 "/reports/:rpt/export`", "/reports/:rpt/schedule`", "/reports/:rpt/recipients`",
                 "/reports/:rpt/runs`", "/reports/:rpt/shares`", "/reports/:rpt/shares/:rsh`"]:
        if path not in routes:
            errs.append("route %s missing" % path)
    if "private, no-store" not in routes:
        errs.append("computed reads must be sent private, no-store")
    # Lifecycle and departure.
    lifecycle = read(P(LIFECYCLE))
    for needle in ["export const dashboardAdapter", "export const reportAdapter",
                   "export async function attachedInsights("]:
        if needle not in lifecycle:
            errs.append("lifecycle lacks %s" % needle)
    for t in ["insights.report_run", "insights.report_share", "insights.report_recipient",
              "insights.report_definition", "insights.dashboard"]:
        if "deleteFrom('%s')" % t not in lifecycle:
            errs.append("purge must delete %s" % t)
    work_lifecycle = read(P("packages/work/src/lifecycle.ts"))
    for needle in ["dashboardAdapter", "reportAdapter", "attachedInsights("]:
        if needle not in work_lifecycle:
            errs.append("the work lifecycle registry must carry %s" % needle)
    if "key: 'insights_owner'" not in read(P(OWNERSHIP)) or ".register(insightsOwnerHook)" not in read(
            P("packages/work/src/factory.ts")):
        errs.append("the insights_owner ownership hook must be registered")
    # The 0B, 0C, and 0D records.
    model = load(P("docs/architecture/data/model/model.json"))
    names = {e["name"] for e in model["entities"]}
    for e in ENTITIES:
        if e not in names:
            errs.append("model.json lacks %s" % e)
    for rel, anchors in {"docs/architecture/data/12-decisions.md": ["adr-38"],
                         "docs/architecture/access/15-decisions.md": ["az-38"],
                         "docs/architecture/platform/19-decisions.md": ["pl-40"]}.items():
        text = read(P(rel))
        for a in anchors:
            if '<a id="%s"></a>' % a not in text:
                errs.append("%s lacks %s" % (rel, a))
    for rel in ["docs/architecture/data/12-decisions.md", "docs/architecture/data/09-concurrency-consistency.md",
                "docs/architecture/data/13-open-questions.md", "docs/architecture/access/15-decisions.md",
                "docs/architecture/platform/19-decisions.md", "docs/architecture/platform/04-concurrency.md",
                "docs/architecture/data/model/model.json"]:
        if "ADR-0030" in read(P(rel)):
            errs.append("%s must not reference the engineering ADR (0B, 0C, and 0D records stay free of it)" % rel)
    threats = load(P("docs/architecture/access/policy/threats.json"))
    have_t = {t["id"] for t in threats["threats"]}
    have_a = {t["id"]: t for t in threats["tests"]}
    for t in THREATS:
        if t not in have_t:
            errs.append("threat %s missing" % t)
    for a in TESTS:
        if a not in have_a:
            errs.append("acceptance test %s missing" % a)
    covered = {th for a in TESTS if a in have_a for th in have_a[a]["threats"]}
    for t in THREATS:
        if t not in covered:
            errs.append("threat %s has no acceptance test in AT-269..AT-286" % t)
    # Every acceptance test names a test that exists (the ADR table).
    adr = read(P(ADR))
    rows = re.findall(r"^\| (AT-\d+) \| ([^|]+?) \| ([^|]+?) \|$", adr, re.M)
    named = {}
    for at, path, title in rows:
        named.setdefault(at, []).append((path.strip(), title.strip()))
        full = P(path.strip())
        if not os.path.isfile(full):
            errs.append("%s: test file %s missing" % (at, path.strip()))
        elif title.strip() not in read(full):
            errs.append("%s: %s has no test %r" % (at, path.strip(), title.strip()))
    for a in TESTS:
        if a not in named:
            errs.append("%s: the ADR names no test for it" % a)
    return errs, "services, pure rules, metric port, per-recipient delivery, exports, lifecycle, departure, 0B/0C/0D records, %d acceptance tests" % len(TESTS)


def check_boundaries_kept():
    """5D builds no metric definitions (5C), external connectors, AI reporting, or charting dependency."""
    errs = []
    for path in INSIGHT_FILES:
        text = read(P(path)).lower()
        for forbidden in ["openai", "anthropic", "deepseek", "openrouter", "@pm/ai", "chatgpt", "embedding",
                          "tsvector", "metric_snapshot", "create table", "slack", "webhook", "smtp", "nodemailer"]:
            if forbidden in text:
                errs.append("%s names %s: no AI, connector, or metric-definition structures in 5D" % (path, forbidden))
    for pkg in ["package.json", "apps/api/package.json", "apps/web/package.json", "apps/worker/package.json",
                "packages/work/package.json"]:
        if os.path.isfile(P(pkg)) and re.search(
                r'"(openai|@anthropic-ai/[^"]*|ai|langchain|@slack/[^"]*|chart\.js|recharts|d3|pdfkit|puppeteer|'
                r'playwright-core|jspdf|nodemailer)"\s*:', read(P(pkg))):
            errs.append("%s adds an AI, integration, charting, or PDF dependency" % pkg)
    if os.path.isdir(P("packages/work/src/reports")) or os.path.isdir(P("packages/work/src/metrics")):
        errs.append("5D must not add a reports or metrics module outside insights/")
    return errs, "no metric definitions, connectors, AI, charting, or PDF dependency"


def check_closure_extras(closure):
    errs = []
    ids = {r["id"] for r in closure["requirements"]}
    for need in ["GOAL-011", "WSB-016", "NAV-002", "NAV-003", "REL-012", "PRJ-019", "TIME-005", "RPT-023",
                 "RPT-024", "RPT-025"] + ["RPT-%03d" % i for i in range(1, 23)]:
        if need not in ids:
            errs.append("%s must be recorded" % need)
    lim = " ".join(x["item"] + " " + x["note"] for x in closure.get("limitations", []))
    for needle in ["5C", "AI usage", "Release", "PDF", "Email", "fiscal", "connectors", "Guests"]:
        if needle.lower() not in lim.lower():
            errs.append("limitations must record %s" % needle)
    for r in closure["requirements"]:
        for ev in r["evidence"]:
            if re.search(r"(<[A-Za-z]+>|TODO|PLACEHOLDER|\.\.\.)", ev["file"]):
                errs.append("%s: placeholder evidence path %s" % (r["id"], ev["file"]))
    return errs, "%d limitations recorded" % len(closure.get("limitations", []))


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0030")
    if not path:
        return ["no ADR-0030"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0030 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0030 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0030 has no row %s" % (d["id"], d.get("adr_row")))
    if "**Numbering.**" not in text or "0043" not in text or "**Dependency on 5C.**" not in text:
        errs.append("ADR-0030 must record the shared migration number 0043, its identifiers, and the 5C dependency")
    for needle in ["reverses each boundary step", "reverses completely with down migrations and re-applies cleanly"]:
        if needle not in text or needle not in read(P("packages/db/test/integration/migrations.test.ts")):
            errs.append("ADR-0030 must cite the migration test %r and it must exist" % needle)
    return errs, "ADR-0030 %s" % (m.group(1) if m else "?")


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase5d.py" not in verify:
        errs.append("scripts/verify.sh must run phase5d.py")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase5d") != "python3 docs/engineering/tools/phase5d.py":
        errs.append("package.json must define validate:phase5d")
    readme = read(P("docs/engineering/README.md"))
    if "closure-5d.json" not in readme:
        errs.append("docs/engineering/README.md must index the 5D closure")
    return errs, "verify.sh, package.json, and the engineering index"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase5/closure-5d.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 5D: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "5D", ["D%d" % i for i in range(1, 17)])),
        ("phase 5D: closure limitations and contributions", check_closure_extras(closure)),
        ("phase 5D: bounds, events, signals, envelopes, no new actions", check_contracts(registry, policy)),
        ("phase 5D: migration 0043 and its rollback", check_migration()),
        ("phase 5D: authorization, viewer-computed, and delivery invariants", check_invariants()),
        ("phase 5D: later-phase and provider boundaries kept", check_boundaries_kept()),
        ("phase 5D: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 5D: configuration keys documented", phase1.check_config_documented()),
        ("phase 5D: ADR status and decision rows", check_adr(closure)),
        ("phase 5D: validator wiring", check_wiring()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-72s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 5D CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
