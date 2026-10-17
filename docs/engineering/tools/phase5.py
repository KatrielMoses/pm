#!/usr/bin/env python3
"""Phase 5 aggregate closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase5.py      # exit 1 on any failure

Phase 5 final integration (docs/engineering/phase5/closure-5.json): 5A (search) and 5B (goals and
portfolios) were built in parallel from the accepted Phase 4D head and both first claimed migration
0041, ADR-0028, 0B ADR-36, 0C AZ-36, 0D PL-38, and the threat and test identifiers after T-53 and
AT-237; 5C (metrics) and 5D (dashboards and reports) were built in parallel from the accepted Phase 5
integration head and both first claimed migration 0043, ADR-0030, ADR-38, AZ-38, PL-40, and the
identifiers after T-62 and AT-268. 5C was accepted first and keeps its numbers; 5D was renumbered
(0044, ADR-0031, ADR-39, AZ-39, PL-41, T-65..T-72, AT-280..AT-297). This validator proves the
reconciliation is complete and stays that way: every Phase 0-5D validator and closure passes;
migrations, ADRs, and decision records have exactly one owner each; threats and tests are
contiguous, unique, and traceable; the service chain composes (goals extend search, metrics extend
goals, dashboards extend metrics) and the 5C metrics reach 5D through the metric port; all four
closure maps and their explicit deferrals are kept; the cross-phase integration evidence exists
(including the historical search backfill and the applied-migration boundary); and the local
embedded-PostgreSQL exit-code guard is tested.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

VALIDATORS = ["docs/architecture/tools/phase0.py"] + [
    "docs/engineering/tools/%s.py" % n for n in
    ["phase1", "phase2", "phase3", "phase3b", "phase3c", "phase3d", "phase3e", "phase4a", "phase4b",
     "phase4c", "phase4d", "phase4e", "phase5a", "phase5b", "phase5c", "phase5d"]]
DEFERRALS = [
    "semantic or concept search", "attachment content search", "goals, people, and integration search sources",
    "external adapters", "AI analytics", "metric snapshots", "later-phase metrics (tests, spend, AI usage, automation)",
]


def check_validators():
    errs = []
    for v in VALIDATORS:
        r = subprocess.run([sys.executable, P(v)], capture_output=True, text=True)
        if r.returncode != 0:
            tail = [l for l in r.stdout.splitlines() if "FAIL" in l or "ERROR" in l][:3]
            errs.append("%s fails: %s" % (v, "; ".join(tail) or "exit %d" % r.returncode))
    return errs, "%d validators" % len(VALIDATORS)


def check_numbering():
    errs = []
    mig = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    by = {n.split("_", 1)[0]: n for n in mig}
    owners = {"0041": "0041_permission_aware_search.up.sql", "0042": "0042_goals_portfolios.up.sql",
              "0043": "0043_metrics_model.up.sql", "0044": "0044_dashboards_reports.up.sql"}
    for num, name in owners.items():
        if by.get(num) != name:
            errs.append("migration %s must be %s" % (num, name))
    for num, prior in (("0041", "0040"), ("0042", "0041"), ("0043", "0042"), ("0044", "0043")):
        down = read(P("packages/db/migrations/%s.down.sql" % owners[num].replace(".up.sql", "")))
        if "Restores the exact %s catalog" % prior not in down:
            errs.append("%s down must restore the exact %s catalog" % (num, prior))
    adrs = os.listdir(P("docs/engineering/adr"))
    for num, name in (("0028", "permission-aware-search"), ("0029", "goals-portfolios"), ("0030", "metrics-model"),
                      ("0031", "dashboards-reports")):
        if "%s-%s.md" % (num, name) not in adrs:
            errs.append("ADR-%s-%s missing" % (num, name))
        if len([a for a in adrs if a.startswith(num + "-")]) != 1:
            errs.append("ADR number %s must have exactly one file" % num)
    for path, anchors in {
        "docs/architecture/data/12-decisions.md": ['<a id="adr-%d"></a>' % n for n in range(36, 40)],
        "docs/architecture/access/15-decisions.md": ['<a id="az-%d"></a>' % n for n in range(36, 40)],
        "docs/architecture/platform/19-decisions.md": ['<a id="pl-%d"></a>' % n for n in range(38, 42)],
    }.items():
        text = read(P(path))
        for a in anchors:
            if text.count(a) != 1:
                errs.append("%s must hold %s exactly once" % (path, a))
    t = load(P("docs/architecture/access/policy/threats.json"))
    tids = [x["id"] for x in t["threats"]]
    aids = [x["id"] for x in t["tests"]]
    if len(set(tids)) != len(tids) or len(set(aids)) != len(aids):
        errs.append("threat and test identifiers must be unique")
    for want, got, label in ((["T-%d" % i for i in range(54, 73)], [i for i in tids if 54 <= int(i[2:]) <= 72], "threats T-54..T-72"),
                             (["AT-%d" % i for i in range(238, 298)], [i for i in aids if 238 <= int(i[3:]) <= 297], "tests AT-238..AT-297")):
        if got != want:
            errs.append("%s must be contiguous and in order" % label)
    known = set(tids)
    for x in t["tests"]:
        for th in x["threats"]:
            if th not in known:
                errs.append("%s names unknown threat %s" % (x["id"], th))
    desc = {x["id"]: x["description"] for x in t["threats"]}
    for tid, word in (("T-54", "Search leakage"), ("T-55", "goal or portfolio"), ("T-63", "metric"), ("T-65", "")):
        if tid not in desc or word not in desc[tid]:
            errs.append("%s must be the %s threat" % (tid, word or "first 5D"))
    return errs, "migrations 0041-0044, ADR-0028..0031, ADR-36..39, AZ-36..39, PL-38..41, T-54..T-72, AT-238..AT-297"


def check_composition():
    errs = []
    core = read(P("packages/work/src/goals/goal-core.ts"))
    if "export class GoalCore extends SearchService" not in core:
        errs.append("GoalCore must extend SearchService (5A then 5B in the service chain)")
    if "export class SearchService extends FileService" not in read(P("packages/work/src/search/search-service.ts")):
        errs.append("SearchService must extend FileService")
    factory = read(P("packages/work/src/factory.ts"))
    # 5C's MetricService extends the PortfolioService and 5D's InsightsCore extends the MetricService: the
    # ReportService was the top of the chain through Phase 5. Phase 6B extends it.
    extends = "export class PublicApiService extends IntegrationService" in read(
        P("packages/work/src/integrations/public-api-service.ts")
    )
    top = any(
        f"return new {service}(" in factory
        for service in ("PublicApiService", "CalendarService", "McpAccessService", "AiGatewayService")
    )
    if not extends or top is False:
        errs.append(
            "createWorkService must return the top of the chain (CalendarService or PublicApiService extends IntegrationService)"
        )
    chain = (("packages/work/src/goals/portfolio-service.ts", "export class PortfolioService extends GoalService"),
             ("packages/work/src/metrics/metric-service.ts", "export class MetricService extends PortfolioService"),
             ("packages/work/src/insights/report-core.ts", "export class InsightsCore extends MetricService"),
             ("packages/work/src/insights/report-service.ts", "export class ReportService extends InsightsCore"))
    for path, needle in chain:
        if needle not in read(P(path)):
            errs.append("%s must contain %s" % (path, needle))
    # The 5C metrics reach dashboards through the 5D metric port, answered by the metric service.
    port = read(P("packages/work/src/insights/metrics-5c.ts"))
    if "ctx.host.metricFigure(" not in port or "ctx.host.metricRecords(" not in port:
        errs.append("5C metrics must reach dashboards through the metric port")
    if "...METRICS_5C" not in read(P("packages/work/src/insights/metrics.ts")):
        errs.append("the 5C metrics must be registered in the 5D provider catalog")
    if "metricFigure: (tx, p, metric, query) => this.figureIn(" not in read(P("packages/work/src/insights/report-core.ts")):
        errs.append("the metric host must answer through MetricService.figureIn")
    for rate in ("'search.member'", "'goal.checkin'", "'metrics.member'", "'report.export'"):
        if rate not in factory:
            errs.append("the factory must register the %s rate policy" % rate)
    reg = read(P("apps/worker/src/registry.ts"))
    for n in ("searchIndexHandler(m.search)", "goalRecalcHandler(m.goals)", "metricsReconcileHandler(m.metrics)",
              "reportDeliveryHandler(m.reports)", "...SEARCH_SCHEDULES", "...GOAL_SCHEDULES", "...METRICS_SCHEDULES",
              "...REPORT_SCHEDULES"):
        if n not in reg:
            errs.append("the worker must register %s" % n)
    routes = read(P("apps/api/src/work/routes.ts"))
    for n in ("registerSearch(app, work)", "registerGoals(app, work)", "registerMetrics(app, work)",
              "registerInsights(app, work)"):
        if n not in routes:
            errs.append("the API must register %s" % n)
    disc = read(P("packages/db/src/discovery.ts"))
    for n in ("discoverSearchWork(", "discoverGoalWork(", "discoverMetricsWork(", "discoverReportWork("):
        if n not in disc:
            errs.append("discovery lacks %s" % n)
    # Goals are not search sources yet (explicit deferral): the registry names no goal source.
    srcs = read(P("packages/work/src/search/sources.ts"))
    if re.search(r"kind: '(goal|key_result|portfolio)'", srcs):
        errs.append("goals and portfolios are not search sources in Phase 5 (deferred)")
    verify = read(P("scripts/verify.sh"))
    for v in ("phase5a.py", "phase5b.py", "phase5c.py", "phase5d.py", "phase5.py"):
        if v not in verify:
            errs.append("verify.sh must run %s" % v)
    pkg = read(P("package.json"))
    for v in ("validate:phase5a", "validate:phase5b", "validate:phase5c", "validate:phase5d", "validate:phase5\""):
        if v not in pkg:
            errs.append("package.json lacks %s" % v)
    return errs, "service chain, worker, routes, discovery, rate policies, wiring"


def check_closure():
    errs = []
    c5 = load(P("docs/engineering/phase5/closure-5.json"))
    if c5.get("phase") != "5":
        errs.append("closure-5.json phase must be 5")
    for sub, path in (("5A", "docs/engineering/phase5/closure-5a.json"), ("5B", "docs/engineering/phase5/closure-5b.json"),
                      ("5C", "docs/engineering/phase5/closure-5c.json"), ("5D", "docs/engineering/phase5/closure-5d.json")):
        c = load(P(path))
        if c.get("phase") != sub:
            errs.append("%s closure missing or wrong phase" % sub)
        if c5.get("members", {}).get(sub) != path:
            errs.append("closure-5.json must name the %s closure" % sub)
    text = json.dumps(c5)
    for d in DEFERRALS:
        if d not in text:
            errs.append("closure-5.json must record the deferral: %s" % d)
    for e in c5.get("evidence", []):
        path = P(e["file"])
        if not os.path.isfile(path) or e["contains"] not in read(path):
            errs.append("evidence missing: %s %r" % (e["file"], e["contains"]))
    if not c5.get("evidence"):
        errs.append("closure-5.json lists no evidence")
    return errs, "5A-5D closures, deferrals, %d evidence items" % len(c5.get("evidence", []))


def main():
    sections = [
        ("phase 5: every Phase 0-5D validator and closure passes", check_validators()),
        ("phase 5: one owner for every migration, ADR, and identifier", check_numbering()),
        ("phase 5: service chain and wiring compose", check_composition()),
        ("phase 5: aggregate closure, deferrals, and evidence", check_closure()),
    ]
    failed = 0
    for name, (errs, detail) in sections:
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 5 AGGREGATE CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
