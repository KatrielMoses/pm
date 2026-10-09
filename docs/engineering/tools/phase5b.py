#!/usr/bin/env python3
"""Phase 5B closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase5b.py      # exit 1 on any failure

Phase 5B (docs/engineering/phase5/closure-5b.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, decisions D1..D19 tied to
ADR-0029 rows G1..G19) plus drift checks: the goal and portfolio bounds are registered (owner 5B),
configured, and documented; the events, signals, prefix, and envelopes are registered, and no
action is added; migration 0042 keeps its tenant isolation, its append-only check-ins, its
integrity triggers, and its exact rollback to 0040; nothing derived from linked work is stored;
goals and portfolios are never shareable; the health, dependency, and orphan rules stay pure;
recalculation claims goals with a lease; exports are bounded and audited; lifecycle and departure
carry goals; every acceptance test AT-246..AT-268 names a test that exists; and the later-phase
boundaries (search, dashboards, metrics, integrations, AI planning) are not crossed. The ADR stays
proposed until acceptance.
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
    "GOALS_PER_SCOPE_MAX": ("goalsPerScopeMax", 500),
    "GOAL_KEY_RESULTS_MAX": ("goalKeyResultsMax", 20),
    "GOAL_LINKS_MAX": ("goalLinksMax", 200),
    "GOAL_UPDATE_STALE_DAYS": ("goalUpdateStaleDays", 14),
    "GOAL_CHECKIN_RATE_PER_MINUTE": ("goalCheckinRatePerMinute", 30),
    "PORTFOLIOS_MAX": ("portfoliosMax", 100),
    "PORTFOLIO_PROJECTS_MAX": ("portfolioProjectsMax", 200),
    "PORTFOLIO_READ_PROJECTS_MAX": ("portfolioReadProjectsMax", 500),
    "GOALS_EXPORT_ROWS_MAX": ("goalsExportRowsMax", 5000),
    "GOALS_RECALC_BATCH_MAX": ("goalsRecalcBatchMax", 200),
    "GOALS_RECALC_LEASE_SECONDS": ("goalsRecalcLeaseSeconds", 300),
    "GOALS_RECALC_INTERVAL_MINUTES": ("goalsRecalcIntervalMinutes", 360),
    "GOALS_RECALC_MAX_ATTEMPTS": ("goalsRecalcMaxAttempts", 5),
}
SIGNALS = ["goals.reads", "goals.changes", "goals.jobs"]
EVENTS = [
    "goals.goal.created", "goals.goal.updated", "goals.goal.status_changed", "goals.goal.checkin_recorded",
    "goals.goal.link_changed", "goals.goal.update_stale", "goals.key_result.created",
    "goals.key_result.updated", "goals.portfolio.created", "goals.portfolio.updated",
    "goals.portfolio.members_changed",
]
ENVELOPES = ["portfolio_overview", "portfolio_dependencies", "portfolio_orphans", "goal_work"]
PREFIXES = {"goal": "goals.goal", "kr": "goals.key_result", "pf": "goals.portfolio", "gci": "goals.goal_checkin"}
TABLES = ["goals.goal", "goals.key_result", "goals.goal_checkin", "goals.goal_link", "goals.goal_state",
          "goals.portfolio", "goals.portfolio_project"]
ENTITIES = ["goal", "key_result", "goal_link", "goal_checkin", "goal_state", "portfolio", "portfolio_project"]
THREATS = ["T-%d" % i for i in range(54, 62)]
TESTS = ["AT-%d" % i for i in range(238, 261)]
ADR = "docs/engineering/adr/0029-goals-portfolios.md"
MIGRATION = "packages/db/migrations/0042_goals_portfolios"
GOALS = "packages/work/src/goals/"
SEM = GOALS + "semantics.ts"
CORE = GOALS + "goal-core.ts"
GSVC = GOALS + "goal-service.ts"
PSVC = GOALS + "portfolio-service.ts"
JOBS = GOALS + "jobs.ts"
RECALC = GOALS + "recalc.ts"
LIFECYCLE = GOALS + "lifecycle.ts"
OWNERSHIP = GOALS + "ownership.ts"
ROUTES = "apps/api/src/work/goal-routes.ts"


def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "5B":
            errs.append("%s: 0D owner must be 5B" % name)
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
    owned = {n for n, p in params.items() if p.get("owner") == "5B"}
    for n in sorted(owned - set(BOUNDS)):
        errs.append("%s: a 5B parameter the validator does not know" % n)
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
    extra = {t for t in events if t.startswith("goals.") or t.startswith("portfolio.")} - set(EVENTS)
    if extra:
        errs.append("unknown goal events: %s" % ", ".join(sorted(extra)))
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
        errs.append("5B adds no actions: expected 122, found %d" % len(policy["actions"]))
    if "'goal.checkin'" not in read(P("packages/work/src/factory.ts")):
        errs.append("the goal.checkin rate policy must be registered")
    od = read(P("docs/product/open-decisions.md"))
    for n, nxt in (("05", "06"), ("06", "07"), ("07", "08"), ("13", "14")):
        seg = od[od.find("### OD-%s " % n):od.find('<a id="od-%s">' % nxt)]
        if "**Status (Phase 5B" not in seg:
            errs.append("OD-%s must carry its Phase 5B status" % n)
    return errs, "%d bounds, %d events, %d signals, %d envelopes, prefixes, no new actions" % (
        len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES))


def check_migration():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("0042: %s has no tenant_isolation policy" % table)
        if "ALTER TABLE %s ENABLE ROW LEVEL SECURITY" % table not in up or \
                "ALTER TABLE %s FORCE ROW LEVEL SECURITY" % table not in up:
            errs.append("0042: %s must enable and force RLS" % table)
        if "'%s':" % table not in schema:
            errs.append("schema.ts lacks %s" % table)
        if not re.search(r"DROP TABLE %s;" % re.escape(table), down):
            errs.append("0042 down must drop %s" % table)
    for needle in ["goal_checkin_immutable", "goal_checkin_computed_unique", "goal_link_integrity",
                   "portfolio_member_integrity", "goal_metric_manual_only", "goal_period_ordered",
                   "goal_status_known", "goal_basis_known", "goal_state_basis_known",
                   "discover_goal_work", "SECURITY DEFINER"]:
        if needle not in up:
            errs.append("0042 lacks %s" % needle)
    for needle in ["DROP FUNCTION exec_dispatch.discover_goal_work", "DROP SCHEMA goals",
                   "Restores the exact 0040 catalog"]:
        if needle not in down:
            errs.append("0042 down lacks %s" % needle)
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    for m in re.finditer(r"GRANT ([A-Z, ()a-z_]+) ON ([^;]*?) TO (app_rw|app_worker)", up):
        privs, tables, role = m.group(1), m.group(2), m.group(3)
        if re.search(r"\bgoals\.goal_checkin\b", tables) and "UPDATE" in privs:
            errs.append("check-ins are append-only: %s must not hold UPDATE" % role)
        if re.search(r"\bgoals\.goal_checkin\b", tables) and role == "app_rw" and "DELETE" in privs:
            errs.append("check-ins are append-only: app_rw must not hold DELETE")
    # Nothing derived from linked work is stored beside the goal.
    m = re.search(r"CREATE TABLE goals\.goal_state \((.*?)\n\);", up, re.S)
    cols = re.findall(r"^  ([a-z_]+) ", m.group(1), re.M) if m else []
    allowed = {"workspace_id", "goal_id", "rollup_percent", "rollup_basis", "inputs_hash", "update_state",
               "period_state", "dirty", "next_check_at", "claimed_until", "attempts", "last_error", "computed_at"}
    for c in cols:
        if c not in allowed and not c.startswith("constraint"):
            errs.append("goals.goal_state column %s is not viewer-neutral state" % c)
    if "viewer_dependent" not in up:
        errs.append("a goal that depends on linked work must store no number (viewer_dependent)")
    for schema_name in ["search", "reporting", "metrics", "agents", "integrations"]:
        if re.search(r"CREATE (SCHEMA|TABLE) %s\b" % schema_name, up):
            errs.append("0042 creates %s structures (a later phase owns them)" % schema_name)
    if len(re.findall(r"^CREATE SCHEMA ", up, re.M)) != 1:
        errs.append("0042 must create only the goals schema")
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 42)))
    return errs, "tenant isolation, append-only check-ins, integrity triggers, viewer-neutral state, rollback to 0040"


def check_invariants():
    errs = []
    core = read(P(CORE))
    gsvc = read(P(GSVC))
    psvc = read(P(PSVC))
    sem = read(P(SEM))
    jobs = read(P(JOBS))
    recalc = read(P(RECALC))
    for cls, needle in (("GoalCore", "export class GoalCore extends FileService"),
                        ("GoalService", "export class GoalService extends GoalCore"),
                        ("PortfolioService", "export class PortfolioService extends GoalService")):
        if needle not in core + gsvc + psvc:
            errs.append("%s must be one link of the service chain (%s)" % (cls, needle))
    for method in ["async createGoal(", "async updateGoal(", "async getGoal(", "async listGoals(",
                   "async createKeyResult(", "async updateKeyResult(", "async addGoalLink(", "async removeGoalLink(",
                   "async recordCheckin(", "async listCheckins(", "async recalculateGoal(", "async goalLifecycle(",
                   "async exportGoals(", "async goalsOfProject(", "async goalWork("]:
        if method not in gsvc:
            errs.append("the goal service lacks %s" % method)
    for method in ["async createPortfolio(", "async updatePortfolio(", "async setPortfolioProjects(",
                   "async portfolioOverview(", "async portfolioDetail(", "async portfolioDependencies(",
                   "async portfolioOrphans(", "async exportPortfolio(", "async portfolioLifecycle("]:
        if method not in psvc:
            errs.append("the portfolio service lacks %s" % method)
    for forbidden in ["withWorkspaceBypass", "SECURITY DEFINER"]:
        for name, text in (("goal service", gsvc), ("portfolio service", psvc), ("goal core", core)):
            if forbidden in text:
                errs.append("the %s must not use %s" % (name, forbidden))
    # Reads are decided through the placement's level; nothing is cached or stored beside the goal.
    if "this.inWorkspace(" not in gsvc and "this.inWorkspace(" not in psvc:
        errs.append("goal and portfolio calls must run in a workspace transaction")
    # Goals and portfolios are never shareable.
    sharing = read(P("packages/tenancy/src/sharing.ts"))
    m = re.search(r"SHAREABLE_RECORD_TYPES[^=]*=\s*new Map\(\[(.*?)\]\);", sharing, re.S)
    for rt in ("goal", "key_result", "portfolio"):
        if m and re.search(r"\['%s'" % rt, m.group(1)):
            errs.append("%s must not be a shareable record type" % rt)
    # Pure rules: no I/O.
    for forbidden in ["@pm/db", "sql`", "fetch(", "node:fs", "new Date()", "Date.now("]:
        if forbidden in sem:
            errs.append("semantics.ts must stay pure and deterministic (%s)" % forbidden)
    for needle in ["export function evaluateHealth(", "export function dependencyState(",
                   "export function workPercent(", "export function rollup(", "export function updateState(",
                   "export function statusChangeAllowed(", "export function goalPeriodOf(",
                   "export const BEHIND_AT_RISK = 20", "export const BEHIND_OFF_TRACK = 40",
                   "export const OVERDUE_AT_RISK_SHARE = 0.25", "export const OVERDUE_OFF_TRACK_SHARE = 0.5",
                   "export const BLOCKED_AT_RISK_SHARE = 0.25", "export const TARGET_OFF_TRACK_DAYS = 14"]:
        if needle not in sem:
            errs.append("semantics.ts lacks %s" % needle)
    for code in ["deadline_passed", "target_passed", "behind_schedule", "overdue_tasks", "blocked_tasks",
                 "time_budget_exceeded", "time_budget_nearly_used"]:
        if "'%s'" % code not in sem:
            errs.append("health reason %s missing" % code)
    # Recalculation: leased claims, idempotent computed check-ins, backoff.
    if "FOR UPDATE SKIP LOCKED" not in jobs:
        errs.append("recalculation must claim goals with FOR UPDATE SKIP LOCKED")
    for needle in ["goalsRecalcLeaseSeconds", "goalsRecalcBatchMax", "recalcBackoffMs", "goalsRecalcMaxAttempts"]:
        if needle not in jobs + recalc + gsvc + core:
            errs.append("recalculation lacks %s" % needle)
    if "inputs_hash" not in recalc:
        errs.append("computed check-ins must be keyed by their inputs hash")
    if "discoverGoalWork" not in jobs:
        errs.append("the sweep must discover workspaces through discover_goal_work")
    registry = read(P("apps/worker/src/registry.ts"))
    if "goalRecalcHandler" not in registry or "GOAL_SCHEDULES" not in registry:
        errs.append("the worker must register the goals.recalculate job and its schedule")
    # Exports: bounded, audited, formula-safe.
    for needle in ["goalsExportRowsMax", "goals.exported"]:
        if needle not in gsvc:
            errs.append("goal export lacks %s" % needle)
    for needle in ["goalsExportRowsMax", "portfolio.exported"]:
        if needle not in psvc:
            errs.append("portfolio export lacks %s" % needle)
    # Routes.
    routes = read(P(ROUTES))
    for path in ["/goals`", "/goals/export`", "/goals/:goal`", "/goals/:goal/check-ins`",
                 "/goals/:goal/key-results`", "/goals/:goal/key-results/:kr`", "/goals/:goal/links`", "/goals/:goal/work`",
                 "/projects/:prj/goals`", "/portfolios`", "/portfolios/:pf`", "/portfolios/:pf/projects`",
                 "/portfolios/:pf/overview`", "/portfolio/overview`", "/portfolio/dependencies`",
                 "/portfolio/orphans`", "/portfolio/export`"]:
        if path not in routes:
            errs.append("route %s missing" % path)
    if "private, no-store" not in routes:
        errs.append("computed reads must be sent private, no-store")
    # Lifecycle and departure.
    lifecycle = read(P(LIFECYCLE))
    for needle in ["export const goalAdapter", "export const keyResultAdapter", "export const portfolioAdapter",
                   "export async function purgeGoalTargets(", "export async function attachedGoals("]:
        if needle not in lifecycle:
            errs.append("lifecycle lacks %s" % needle)
    for t in ["goals.goal_link", "goals.portfolio_project", "goals.goal_checkin", "goals.goal_state",
              "goals.key_result", "goals.goal"]:
        if "deleteFrom('%s')" % t not in lifecycle:
            errs.append("purge must delete %s" % t)
    work_lifecycle = read(P("packages/work/src/lifecycle.ts"))
    for needle in ["goalAdapter", "keyResultAdapter", "portfolioAdapter", "purgeGoalTargets(", "attachedGoals("]:
        if needle not in work_lifecycle:
            errs.append("the work lifecycle registry must carry %s" % needle)
    if "key: 'goal_owner'" not in read(P(OWNERSHIP)) or ".register(goalOwnerHook)" not in read(
            P("packages/work/src/factory.ts")):
        errs.append("the goal_owner ownership hook must be registered")
    # The 0B, 0C, and 0D records.
    model = load(P("docs/architecture/data/model/model.json"))
    names = {e["name"] for e in model["entities"]}
    for e in ENTITIES:
        if e not in names:
            errs.append("model.json lacks %s" % e)
    for rel, anchors in {"docs/architecture/data/12-decisions.md": ["adr-37"],
                         "docs/architecture/access/15-decisions.md": ["az-37"],
                         "docs/architecture/platform/19-decisions.md": ["pl-39"]}.items():
        text = read(P(rel))
        for a in anchors:
            if '<a id="%s"></a>' % a not in text:
                errs.append("%s lacks %s" % (rel, a))
    for rel in ["docs/architecture/data/12-decisions.md", "docs/architecture/data/09-concurrency-consistency.md",
                "docs/architecture/data/13-open-questions.md", "docs/architecture/access/15-decisions.md",
                "docs/architecture/platform/19-decisions.md", "docs/architecture/platform/04-concurrency.md",
                "docs/architecture/data/model/model.json"]:
        if "ADR-0029" in read(P(rel)):
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
            errs.append("threat %s has no acceptance test in AT-246..AT-268" % t)
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
    return errs, "services, pure rules, leased recalculation, exports, lifecycle, departure, 0B/0C/0D records, %d acceptance tests" % len(TESTS)


def check_boundaries_kept():
    """5B builds no dashboards or reports, metric definitions, external integrations, AI planning, or search index."""
    errs = []
    for path in [SEM, CORE, GSVC, PSVC, JOBS, RECALC, ROUTES]:
        text = read(P(path)).lower()
        for forbidden in ["openai", "anthropic", "deepseek", "openrouter", "@pm/ai", "chatgpt", "embedding",
                          "tsvector", "to_tsquery", "metric_definition", "dashboard_widget", "slack", "webhook"]:
            if forbidden in text:
                errs.append("%s names %s: no AI, search, metric, or integration structures in 5B" % (path, forbidden))
    for pkg in ["package.json", "apps/api/package.json", "apps/web/package.json", "apps/worker/package.json",
                "packages/work/package.json"]:
        if os.path.isfile(P(pkg)) and re.search(
                r'"(openai|@anthropic-ai/[^"]*|ai|langchain|@slack/[^"]*|chart\.js|recharts|d3)"\s*:', read(P(pkg))):
            errs.append("%s adds an AI, integration, or charting dependency" % pkg)
    # Goal data is not indexed by search in 5B (5A owns it) and not exported by the 5D reports.
    if os.path.isdir(P("packages/work/src/reports")):
        errs.append("5B must not add a reports module (5D)")
    return errs, "no dashboards, reports, metrics, integrations, AI, or search structures"


def check_closure_extras(closure):
    errs = []
    ids = {r["id"] for r in closure["requirements"]}
    if "GOAL-011" in ids:
        errs.append("GOAL-011 belongs to 5D: 5B records it as a limitation only")
    if "RPT-016" not in ids:
        errs.append("RPT-016 (5D, contributed to by 5B) must be recorded as a contribution")
    lim = " ".join(x["item"] for x in closure.get("limitations", []))
    for needle in ["GOAL-011", "spend", "Comments", "Stale-update", "search", "fiscal"]:
        if needle.lower() not in lim.lower():
            errs.append("limitations must record %s" % needle)
    for r in closure["requirements"]:
        for ev in r["evidence"]:
            if re.search(r"(<[A-Za-z]+>|TODO|PLACEHOLDER|\.\.\.)", ev["file"]):
                errs.append("%s: placeholder evidence path %s" % (r["id"], ev["file"]))
    return errs, "%d limitations recorded" % len(closure.get("limitations", []))


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0028")
    if not path:
        return ["no ADR-0029"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0029 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0029 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0029 has no row %s" % (d["id"], d.get("adr_row")))
    if "**Numbering.**" not in text or "0041_permission_aware_search" not in text:
        errs.append("ADR-0029 must record the shared migration number 0042 and its identifiers")
    for needle in ["reverses each boundary step", "reverses completely with down migrations and re-applies cleanly"]:
        if needle not in text or needle not in read(P("packages/db/test/integration/migrations.test.ts")):
            errs.append("ADR-0029 must cite the migration test %r and it must exist" % needle)
    return errs, "ADR-0029 %s" % (m.group(1) if m else "?")


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase5b.py" not in verify:
        errs.append("scripts/verify.sh must run phase5b.py")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase5b") != "python3 docs/engineering/tools/phase5b.py":
        errs.append("package.json must define validate:phase5b")
    readme = read(P("docs/engineering/README.md"))
    if "closure-5b.json" not in readme:
        errs.append("docs/engineering/README.md must index the 5B closure")
    return errs, "verify.sh, package.json, and the engineering index"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase5/closure-5b.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 5B: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "5B", ["D%d" % i for i in range(1, 20)])),
        ("phase 5B: closure limitations and contributions", check_closure_extras(closure)),
        ("phase 5B: bounds, events, signals, envelopes, no new actions", check_contracts(registry, policy)),
        ("phase 5B: migration 0042 and its rollback", check_migration()),
        ("phase 5B: authorization, viewer-computed, and recalculation invariants", check_invariants()),
        ("phase 5B: later-phase and provider boundaries kept", check_boundaries_kept()),
        ("phase 5B: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 5B: configuration keys documented", phase1.check_config_documented()),
        ("phase 5B: ADR status and decision rows", check_adr(closure)),
        ("phase 5B: validator wiring", check_wiring()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-72s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 5B CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
