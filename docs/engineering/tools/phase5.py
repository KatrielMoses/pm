#!/usr/bin/env python3
"""Phase 5 aggregate closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase5.py      # exit 1 on any failure

Phase 5 integration review (docs/engineering/phase5/closure-5.json): 5A (search) and 5B (goals and
portfolios) were built in parallel from the accepted Phase 4D head and both first claimed migration
0041, ADR-0028, 0B ADR-36, 0C AZ-36, 0D PL-38, and the threat and test identifiers after T-53 and
AT-237. This validator proves the reconciliation is complete and stays that way: every Phase 0-5B
validator and closure passes; migrations, ADRs, and decision records have exactly one owner each;
threats and tests are contiguous, unique, and traceable; the service chain composes (the goal
services extend the search service); both closure maps and their explicit deferrals are kept;
the cross-phase integration evidence exists; and the local embedded-PostgreSQL exit-code guard is
tested.
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
     "phase4c", "phase4d", "phase4e", "phase5a", "phase5b"]]
DEFERRALS = [
    "semantic or concept search", "attachment content search", "goals, people, and integration search sources",
    "weighted rollups (5C)", "dashboards and reports (5D)",
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
    if by.get("0041") != "0041_permission_aware_search.up.sql":
        errs.append("migration 0041 must be 5A's permission_aware_search")
    if by.get("0042") != "0042_goals_portfolios.up.sql":
        errs.append("migration 0042 must be 5B's goals_portfolios")
    for num, prior in (("0041", "0040"), ("0042", "0041")):
        down = read(P("packages/db/migrations/%s.down.sql" % by[num].replace(".up.sql", "")))
        if "Restores the exact %s catalog" % prior not in down:
            errs.append("%s down must restore the exact %s catalog" % (num, prior))
    adrs = os.listdir(P("docs/engineering/adr"))
    for num, name in (("0028", "permission-aware-search"), ("0029", "goals-portfolios")):
        if "%s-%s.md" % (num, name) not in adrs:
            errs.append("ADR-%s-%s missing" % (num, name))
    if len([a for a in adrs if a.startswith("0028-")]) != 1 or len([a for a in adrs if a.startswith("0029-")]) != 1:
        errs.append("ADR numbers 0028 and 0029 must each have exactly one file")
    for path, anchors in {
        "docs/architecture/data/12-decisions.md": ['<a id="adr-36"></a>', '<a id="adr-37"></a>'],
        "docs/architecture/access/15-decisions.md": ['<a id="az-36"></a>', '<a id="az-37"></a>'],
        "docs/architecture/platform/19-decisions.md": ['<a id="pl-38"></a>', '<a id="pl-39"></a>'],
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
    for want, got, label in ((["T-%d" % i for i in range(54, 63)], [i for i in tids if 54 <= int(i[2:]) <= 62], "threats T-54..T-62"),
                             (["AT-%d" % i for i in range(238, 269)], [i for i in aids if 238 <= int(i[3:]) <= 268], "tests AT-238..AT-268")):
        if got != want:
            errs.append("%s must be contiguous and in order" % label)
    known = set(tids)
    for x in t["tests"]:
        for th in x["threats"]:
            if th not in known:
                errs.append("%s names unknown threat %s" % (x["id"], th))
    first5a = [x["id"] for x in t["threats"] if x["id"] == "T-54"]
    if not first5a or "Search leakage" not in next(x for x in t["threats"] if x["id"] == "T-54")["description"]:
        errs.append("T-54 must be 5A's search threat")
    return errs, "migrations 0041/0042, ADR-0028/0029, ADR-36/37, AZ-36/37, PL-38/39, T-54..T-62, AT-238..AT-268"


def check_composition():
    errs = []
    core = read(P("packages/work/src/goals/goal-core.ts"))
    if "export class GoalCore extends SearchService" not in core:
        errs.append("GoalCore must extend SearchService (5A then 5B in the service chain)")
    if "export class SearchService extends FileService" not in read(P("packages/work/src/search/search-service.ts")):
        errs.append("SearchService must extend FileService")
    factory = read(P("packages/work/src/factory.ts"))
    # 5C's MetricService extends the PortfolioService and 5D's ReportService extends the MetricService: the
    # ReportService is the top of the chain from 5D on.
    if not re.search(r"\}\): (PortfolioService|MetricService|ReportService) \{", factory) or not re.search(
            r"return new (PortfolioService|MetricService|ReportService)\(", factory):
        errs.append("createWorkService must return the top of the chain (PortfolioService, MetricService from 5C, or ReportService from 5D)")
    for rate in ("'search.member'", "'goal.checkin'"):
        if rate not in factory:
            errs.append("the factory must register the %s rate policy" % rate)
    reg = read(P("apps/worker/src/registry.ts"))
    for n in ("searchIndexHandler(m.search)", "goalRecalcHandler(m.goals)", "...SEARCH_SCHEDULES", "...GOAL_SCHEDULES"):
        if n not in reg:
            errs.append("the worker must register %s" % n)
    routes = read(P("apps/api/src/work/routes.ts"))
    for n in ("registerSearch(app, work)", "registerGoals(app, work)"):
        if n not in routes:
            errs.append("the API must register %s" % n)
    disc = read(P("packages/db/src/discovery.ts"))
    for n in ("discoverSearchWork(", "discoverGoalWork("):
        if n not in disc:
            errs.append("discovery lacks %s" % n)
    # Goals are not search sources yet (explicit deferral): the registry names no goal source.
    srcs = read(P("packages/work/src/search/sources.ts"))
    if re.search(r"kind: '(goal|key_result|portfolio)'", srcs):
        errs.append("goals and portfolios are not search sources in Phase 5 (deferred)")
    verify = read(P("scripts/verify.sh"))
    for v in ("phase5a.py", "phase5b.py", "phase5.py"):
        if v not in verify:
            errs.append("verify.sh must run %s" % v)
    pkg = read(P("package.json"))
    for v in ("validate:phase5a", "validate:phase5b", "validate:phase5\""):
        if v not in pkg:
            errs.append("package.json lacks %s" % v)
    return errs, "service chain, worker, routes, discovery, rate policies, wiring"


def check_closure():
    errs = []
    c5 = load(P("docs/engineering/phase5/closure-5.json"))
    if c5.get("phase") != "5":
        errs.append("closure-5.json phase must be 5")
    for sub, path in (("5A", "docs/engineering/phase5/closure-5a.json"), ("5B", "docs/engineering/phase5/closure-5b.json")):
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
    return errs, "5A and 5B closures, deferrals, %d evidence items" % len(c5.get("evidence", []))


def main():
    sections = [
        ("phase 5: every Phase 0-5B validator and closure passes", check_validators()),
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
