#!/usr/bin/env python3
"""Phase 5C closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase5c.py      # exit 1 on any failure

Phase 5C (docs/engineering/phase5/closure-5c.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, decisions D1..D20 tied to
ADR-0030 rows M1..M20) plus drift checks: the metric bounds are registered (owner 5C), configured, and
documented; the signals and the metric envelopes are registered, and no action, prefix, or event is
added; migration 0043 keeps its tenant isolation, its append-only ledger shape, no permission copy,
and its exact rollback to 0042; every figure runs the compiled visibility predicate against the
governing record inside the statement that counts; the released definitions are pinned by digest and
every definition states what it does not claim; windows are converted in the database; the
reconciliation is leased, bounded, and savepoint-free but atomic, never backdates, and stores a short
code; the worker discovery is payload-free; drill-through and the CSV share the one authority; no
dashboard, report, adapter, AI, or snapshot structures are introduced; and the ADR stays proposed
until acceptance.
"""
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
    "METRICS_WINDOW_DAYS_MAX": ("metricsWindowDaysMax", 366),
    "METRICS_DEFAULT_WINDOW_DAYS": ("metricsDefaultWindowDays", 30),
    "METRICS_DRILL_PAGE_MAX": ("metricsDrillPageMax", 100),
    "METRICS_DRILL_RESULTS_MAX": ("metricsDrillResultsMax", 1000),
    "METRICS_SCOPE_TASKS_MAX": ("metricsScopeTasksMax", 20000),
    "METRICS_SAMPLE_MIN": ("metricsSampleMin", 5),
    "METRICS_RATE_PER_MINUTE": ("metricsRatePerMinute", 60),
    "METRICS_RECONCILE_BATCH_MAX": ("metricsReconcileBatchMax", 500),
    "METRICS_RECONCILE_DISCOVERY_MAX": ("metricsReconcileDiscoveryMax", 50),
    "METRICS_RECONCILE_INTERVAL_MINUTES": ("metricsReconcileIntervalMinutes", 360),
    "METRICS_RECONCILE_LEASE_SECONDS": ("metricsReconcileLeaseSeconds", 300),
    "METRICS_RECONCILE_MAX_ATTEMPTS": ("metricsReconcileMaxAttempts", 5),
    "METRICS_RECONCILE_BACKOFF_SECONDS": ("metricsReconcileBackoffSeconds", 60),
}
SIGNALS = ["metrics.requests", "metrics.query.duration", "metrics.reconcile.jobs"]
ENVELOPES = ["metric_catalog", "metric_result", "metric_records", "metric_reconcile"]
TABLES = ["metrics.task_status_span", "metrics.reconcile_state"]
SERVICE = "packages/work/src/metrics/metric-service.ts"
DEFS = "packages/work/src/metrics/definitions.ts"
SEMANTICS = "packages/work/src/metrics/semantics.ts"
JOB = "packages/work/src/metrics/jobs.ts"
ROUTES = "apps/api/src/work/metric-routes.ts"
PAGE = "apps/web/src/pages/metric-pages.tsx"
MIGRATION = "packages/db/migrations/0043_metrics_model"
ADR_ID = "0030"
METRICS = ["project.completion", "project.health", "work.attention", "work.planned_vs_completed",
           "work.created_vs_completed", "work.cycle_time", "work.time_in_status", "work.age", "work.workload",
           "time.planned_vs_actual", "cost.time_budget", "cost.spend", "deliverable.acceptance", "quality.tests",
           "data.freshness"]


# Actions added after this subphase, each held by the validator of the phase that added it
# (P8-W0: operation.reconcile_effect, phase8w0.py).
LATER_ACTIONS = {"operation.reconcile_effect"}

def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "5C":
            errs.append("%s: 0D owner must be 5C" % name)
        if "%s: '%d'" % (name, default) not in server:
            errs.append("%s: server default is not %d" % (name, default))
        if "%s: c.%s" % (camel, name) not in server:
            errs.append("%s: not mapped to settings.%s" % (name, camel))
        if "`%s`" % name not in envdoc:
            errs.append("%s: not documented in environments.md" % name)
        if camel not in settings:
            errs.append("%s: missing from WorkSettings" % camel)
    signals = {t["name"] for t in registry["telemetry"]}
    for s in SIGNALS:
        if s not in signals:
            errs.append("signal %s not registered" % s)
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for e in ENVELOPES:
        if "'%s'" % e not in envelopes:
            errs.append("envelope %s not registered" % e)
    if len([a for a in policy["actions"] if a["key"] not in LATER_ACTIONS]) != 122:
        errs.append("5C adds no actions: expected 122, found %d" % len([a for a in policy["actions"] if a["key"] not in LATER_ACTIONS]))
    if "'metrics.member'" not in read(P("packages/work/src/factory.ts")):
        errs.append("the metrics.member rate policy must be registered")
    events = {e["type"] for e in registry["events"]}
    if any(e.startswith("metrics.") for e in events):
        errs.append("metrics emit no events: figures are computed at request time and the ledger is written by triggers")
    prefixes = {p["prefix"] for p in registry["id_prefixes"]}
    if any(p in prefixes for p in ("met", "mtr", "metric", "span")):
        errs.append("metrics add no identifier prefix")
    od = read(P("docs/product/open-decisions.md"))
    seg = od[od.find("### OD-13"):od.find('<a id="od-14">')]
    if "**Status (Phase 5C" not in seg:
        errs.append("OD-13 must carry its Phase 5C status")
    return errs, "%d bounds, %d signals, %d envelopes, no new actions, prefixes, or events" % (
        len(BOUNDS), len(SIGNALS), len(ENVELOPES))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["task_status_span_basis", "task_status_span_open", "task_status_span_order",
                   "reconcile_state_failure_shape", "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY",
                   "AFTER INSERT ON work.task", "AFTER UPDATE OF status_id, status_category ON work.task",
                   "AFTER DELETE ON work.task", "metrics.record_purged()", "exec_dispatch.discover_metrics_work",
                   "SET CONSTRAINTS ALL IMMEDIATE", "FORCE ROW LEVEL SECURITY;"]:
        if needle not in up:
            errs.append("0043 lacks %s" % needle)
    # The force lifted for the backfill is set again in the same migration.
    if up.count("ALTER TABLE work.task NO FORCE ROW LEVEL SECURITY") != 1 or up.count(
            "ALTER TABLE work.task FORCE ROW LEVEL SECURITY") != 1:
        errs.append("0043 must lift and restore the task table's forced row-level security exactly once")
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("0043: %s has no tenant_isolation policy" % table)
        if "'%s':" % table not in schema:
            errs.append("schema.ts lacks %s" % table)
    if "Restores the exact 0042 catalog" not in down:
        errs.append("0043 down must restore 0042")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    # The ledger holds no permission copy.
    m = re.search(r"CREATE TABLE metrics\.task_status_span \((.*?)\n\);", up, re.S)
    if not m:
        errs.append("task_status_span not found")
    else:
        for needle in ["brand_id", "project_id", "lifecycle_state", "grantee", "title"]:
            if needle in m.group(1):
                errs.append("task_status_span must hold no %s (a copied permission key cannot honour revocation)" % needle)
    # The API never writes the ledger; it may only move the reconciliation schedule.
    for g in re.finditer(r"GRANT ([A-Z, ()a-z_]+) ON ([^;]*?) TO app_rw", up):
        if re.search(r"INSERT|DELETE", g.group(1)) or (
                re.search(r"UPDATE", g.group(1)) and "UPDATE (next_run_at)" not in g.group(0)):
            errs.append("the API role may only read the ledger and update next_run_at of the state row")
    for fn in re.finditer(r"CREATE FUNCTION ([a-z_.]+)\(([^)]*)\) RETURNS (TABLE \(([^)]*)\)|[a-z]+)", up):
        name, ret = fn.group(1), fn.group(4) or fn.group(3)
        if name.startswith("exec_dispatch.") and ret.strip() != "workspace_id uuid":
            errs.append("%s must return workspace identifiers only" % name)
    svc = read(P(SERVICE))
    defs = read(P(DEFS))
    sem = read(P(SEMANTICS))
    job = read(P(JOB))
    for method in ["async getMetric(", "async getMetricRecords(",
                   "async listMetrics(", "async exportMetric(",
                   "async requestReconcile("]:
        if method not in svc:
            errs.append("the metric service lacks %s" % method)
    # One authority, applied inside every counting statement.
    for needle in ["compileVisibility(", "c.vis.where('r', { project: sql`t.project_id` })", "readableBrandsByIds(",
                   "this.inWorkspace(", "this.metricsLimit(", "createHmac(", "timingSafeEqual(", "cursor_invalid",
                   "AT TIME ZONE", "#guardSize("]:
        if needle not in svc:
            errs.append("the metric service must use %s" % needle)
    for forbidden in ["withWorkspaceBypass", "SECURITY DEFINER", "dangerouslySetInnerHTML", "writeOutboxEvent(",
                      "set_config(", "INSERT INTO metrics.", "UPDATE metrics.task_status_span"]:
        if forbidden in svc:
            errs.append("the metric service must not use %s (figures are read-only; the ledger has its own writers)" % forbidden)
    if re.search(r"OFFSET \$\{", svc):
        errs.append("drill-through pages by a signed cursor, never by a database offset")
    # Definitions: versioned, immutable, honest.
    for m_id in METRICS:
        if "id: '%s'" % m_id not in defs:
            errs.append("definitions lack %s" % m_id)
    for needle in ["doesNotClaim", "definitionDigest(", "currentVersion(", "source_unavailable", "authorization: READ_RULE"]:
        if needle not in defs:
            errs.append("definitions must use %s" % needle)
    if not os.path.isfile(P("packages/work/test/unit/metric-definition-digests.json")):
        errs.append("the released definition digests must be pinned")
    for forbidden in ["@pm/db", "sql`", "fetch(", "node:fs"]:
        if forbidden in sem:
            errs.append("semantics.ts must stay pure (%s)" % forbidden)
    # Reconciliation: leased, bounded, resumable, atomic, never backdated, short codes.
    for needle in ["lease_until", "metricsReconcileBatchMax", "metricsReconcileBackoffSeconds", "reconcileBackoffMs(",
                   "discoverMetricsWork(", "scan_after", "FOR UPDATE", "'repaired'", "lifecycle_state <> 'purged'"]:
        if needle not in job and needle not in up:
            errs.append("the reconciliation must use %s" % needle)
    if "failure_code" not in job or "err.message" in job.replace("err instanceof Error ? err.message", ""):
        errs.append("a failed pass records a short code, never the error message")
    if "greatest(" not in job:
        errs.append("a repair must start no earlier than the history it follows (never backdated)")
    discovery = read(P("packages/db/src/discovery.ts"))
    if "exec_dispatch.discover_metrics_work" not in discovery:
        errs.append("discoverMetricsWork must call the payload-free definer function")
    registry = read(P("apps/worker/src/registry.ts"))
    for needle in ["metricsReconcileHandler(m.metrics)", "...METRICS_SCHEDULES"]:
        if needle not in registry:
            errs.append("the worker must register %s" % needle)
    routes = read(P(ROUTES))
    if "const base = '/v1/workspaces/:ws/metrics'" not in routes:
        errs.append("the metric routes must live under workspaces/{ws}/metrics")
    for path in ["`${base}/:metric`", "`${base}/:metric/records`", "`${base}/:metric/export`", "`${base}:reconcile`"]:
        if path not in routes:
            errs.append("route %s missing" % path)
    if "private, no-store" not in routes or "nosniff" not in routes:
        errs.append("metric responses must be private, uncached, and nosniff")
    page = read(P(PAGE))
    for forbidden in ["dangerouslySetInnerHTML", "innerHTML"]:
        if forbidden in page:
            errs.append("the metrics page must render text, not markup (%s)" % forbidden)
    for needle in ["metricsApi.records(", "How this is counted", "STATE_LABEL", "aria-pressed", "Not available until phase"]:
        if needle not in page:
            errs.append("the metrics page lacks %s" % needle)
    registry_ts = read(P("apps/web/src/shell/registry.ts"))
    if "id: 'metrics'" not in registry_ts or "extraCommand: 'go.metrics'" not in registry_ts:
        errs.append("the metrics route and its Go to command must be registered")
    factory = read(P("packages/work/src/factory.ts"))
    if "export class MetricService extends PortfolioService" not in svc:
        errs.append("MetricService must extend PortfolioService (the 5B chain)")
    # 5D's ReportService extends the MetricService and is the top of the chain from 5D on.
    if not re.search(r"\}\): (MetricService|ReportService|PublicApiService|CalendarService|McpAccessService|AiGatewayService|AutomationService|AgentService) \{", factory) or not re.search(
            r"return new (MetricService|ReportService|PublicApiService|CalendarService|McpAccessService|AiGatewayService|AutomationService|AgentService)\(", factory):
        errs.append("createWorkService must build and return the MetricService (or the 5D ReportService on it)")
    core = P("packages/work/src/insights/report-core.ts")
    if os.path.isfile(core):
        if "export class InsightsCore extends MetricService" not in read(core):
            errs.append("5D's InsightsCore must extend the MetricService (the 5C authority is the one the dashboards read)")
        port = read(P("packages/work/src/insights/metrics-5c.ts"))
        if "ctx.host.metricFigure(" not in port or "ctx.host.metricRecords(" not in port:
            errs.append("5C metrics must reach dashboards through the metric port, answered by the metric service")
    for path, needles in {
        "packages/work/test/integration/metrics.test.ts": [
            "lets hidden work contribute nothing to any figure, label, ranking, or digest",
            "answers a hidden project and an unknown one in exactly the same way"],
        "packages/work/test/integration/metrics-figures.test.ts": [
            "buckets created and completed by local day, across midnight and the spring clock change",
            "measures cycle time from the first recorded active status to each completion, and says what it left out",
            "reports sources that do not exist yet as unavailable, never as zero"],
        "packages/work/test/integration/metrics-ledger.test.ts": [
            "repairs a task whose history disagrees with its status, once, without backdating, and repeats change nothing",
            "does not let two workers hold one workspace, and recovers one that was lost",
            "backs off a failing pass, reports it as failing, and recovers when asked after the fault is gone",
            "converges when status changes, reconciliation, and reads overlap"],
        "packages/work/test/integration/metrics-access.test.ts": [
            "follows revocation, trash and restore, and departure on the very next request",
            "exports the same figure as formula-safe CSV, with its definition, window, state, and digest"],
        "apps/api/test/integration/metrics-api.test.ts": [
            "gives a hidden project, an unknown one, and a stranger the same kind of refusal"],
        "e2e/metrics.spec.ts": [
            "shows a person only the work they may read, and the same page says nothing of the rest",
            "reflows at 320 px and 200% zoom, with forced colours and reduced motion, and stays accessible"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 44)))
    return errs, "migration guards, governing-record authority, definitions, leased bounded reconciliation, signed cursors"


def check_boundaries_kept():
    """5C builds no dashboard, report, snapshot, adapter, AI analytics, or forecasting."""
    errs = []
    for path in [SERVICE, DEFS, SEMANTICS, JOB, ROUTES, PAGE]:
        text = read(P(path)).lower()
        for forbidden in ["openai", "anthropic", "forecast", "prophet", "chart.js", "recharts", "d3-", "puppeteer"]:
            if forbidden in text:
                errs.append("%s names %s: no AI analytics, forecasting, charts, or PDF in 5C" % (path, forbidden))
    up = read(P(MIGRATION + ".up.sql"))
    if re.search(r"CREATE EXTENSION", up, re.I):
        errs.append("0043 creates an extension (none is needed)")
    for schema in ["insights", "integrations", "ai", "agents", "reports"]:
        if re.search(r"CREATE (SCHEMA|TABLE) %s\b" % schema, up):
            errs.append("0043 creates %s structures (a later phase owns them)" % schema)
    if re.search(r"CREATE TABLE metrics\.(metric_|dashboard|report|snapshot)", up):
        errs.append("0043 must not create metric definition, snapshot, dashboard, or report tables (ADR-38)")
    for pkg in ["package.json", "apps/api/package.json", "apps/web/package.json", "packages/work/package.json"]:
        if os.path.isfile(P(pkg)) and re.search(
                r'"(openai|@anthropic-ai/[^"]*|chart\.js|recharts|d3|puppeteer|playwright-chromium|prophet)"\s*:',
                read(P(pkg))):
            errs.append("%s adds an AI, charting, or PDF dependency" % pkg)
    return errs, "no dashboard, report, snapshot, AI, forecasting, chart, or PDF structures"


def check_adr(closure):
    errs = []
    path = phase1.adr_path(ADR_ID)
    if not path:
        return ["no ADR-%s" % ADR_ID], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-%s status must be accepted and implemented or proposed" % ADR_ID)
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-%s is proposed but the closure is not a candidate" % ADR_ID)
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-%s has no row %s" % (d["id"], ADR_ID, d.get("adr_row")))
    if "**Numbering.**" not in text:
        errs.append("ADR-%s must record its identifiers and the parallel 5D numbering" % ADR_ID)
    if "Engineering finding" not in text:
        errs.append("ADR-%s must record the migration 0041 backfill finding" % ADR_ID)
    return errs, "ADR-%s %s" % (ADR_ID, m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase5/closure-5c.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 5C: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "5C", ["D%d" % i for i in range(1, 21)])),
        ("phase 5C: bounds, signals, envelopes, no new actions or events", check_contracts(registry, policy)),
        ("phase 5C: migration, authority, and reconciliation invariants", check_invariants()),
        ("phase 5C: later-phase and engine boundaries kept", check_boundaries_kept()),
        ("phase 5C: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 5C: configuration keys documented", phase1.check_config_documented()),
        ("phase 5C: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 5C CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
