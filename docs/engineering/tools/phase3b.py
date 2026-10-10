#!/usr/bin/env python3
"""Phase 3B closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase3b.py      # exit 1 on any failure

Phase 3B (docs/engineering/phase3/closure-3b.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence; foundations deferred with an
accepted source; decisions D1..D6 tied to ADR-0020 rows) plus drift checks: the layout lists agree
across the migration, the engine, and the web client; every layout read starts from the compiled
3A query; board moves use workflow transitions and never write a status or a deadline directly; the
layout bounds, signal, and envelopes are registered and configured; OD-12 is decided; and the ADR
stays proposed until acceptance.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402
import phase2  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

TASK = ["list", "board", "table", "calendar", "timeline", "gantt", "workload", "activity", "timesheet"]
PROJECT = ["list", "board", "table", "calendar", "timeline", "gantt", "milestones", "portfolio", "activity"]
BOUNDS = {
    "LAYOUT_ITEMS_MAX": ("layoutItemsMax", 200),
    "WORKLOAD_DAYS_MAX": ("workloadDaysMax", 366),
    "ACTIVITY_RECORDS_MAX": ("activityRecordsMax", 500),
}
ENVELOPES = ["view_workload", "view_dependencies", "view_time", "view_milestones", "view_progress", "view_activity"]
READS = ["workload", "dependencies", "milestones", "progress", "myTime", "activity"]


def quoted(text):
    return re.findall(r"'([a-z]+)'", text)


def check_layouts():
    errs = []
    up = read(P("packages/db/migrations/0033_core_view_layouts.up.sql"))
    down = read(P("packages/db/migrations/0033_core_view_layouts.down.sql"))
    if "Restores the exact 0032 catalog" not in down:
        errs.append("0033 down must restore 0032")
    m = re.search(r"entity = 'task' AND layout IN \(([^)]*)\)", up, re.S)
    n = re.search(r"entity = 'project' AND layout IN \(([^)]*)\)", up, re.S)
    if not m or quoted(m.group(1)) != TASK:
        errs.append("0033 task layouts differ from %s" % TASK)
    if not n or quoted(n.group(1)) != PROJECT:
        errs.append("0033 project layouts differ from %s" % PROJECT)
    for path, label in [("packages/work/src/views/query.ts", "engine"), ("apps/web/src/views/client.ts", "web client")]:
        text = read(P(path))
        t = re.search(r"task: \[([^\]]*)\]", text[text.index("LAYOUTS"):])
        p = re.search(r"project: \[([^\]]*)\]", text[text.index("LAYOUTS"):])
        if not t or quoted(t.group(1)) != TASK or not p or quoted(p.group(1)) != PROJECT:
            errs.append("%s layout lists differ from the migration" % label)
    return errs, "%d task, %d project layouts" % (len(TASK), len(PROJECT))


def check_reads():
    errs = []
    svc = read(P("packages/work/src/views/layout-service.ts"))
    for name in READS:
        i = svc.find("  async %s(" % name)
        if i < 0:
            errs.append("layout read %s missing" % name)
            continue
        body = svc[i:svc.find("\n  async ", i + 10) if svc.find("\n  async ", i + 10) > 0 else len(svc)]
        if "compileQuery(" not in body and "authorizedIds(" not in body:
            errs.append("layout read %s does not start from the compiled 3A query" % name)
    if "shares: false" not in svc:
        errs.append("activity must exclude share-only access (AZ-22)")
    web = read(P("apps/web/src/views/layouts.tsx"))
    if "transitions.preview(" not in web or "transitions.apply(" not in web:
        errs.append("board status moves must preview and apply workflow transitions")
    for forbidden in ["status_id", "deadline_date: {", "deadline: {"]:
        if forbidden in web:
            errs.append("layouts must not write %r directly" % forbidden)
    return errs, "%d reads from the compiled query; transitions only" % len(READS)


def check_contracts(registry):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    for name, (camel, default) in BOUNDS.items():
        if params.get(name, {}).get("owner") != "3B":
            errs.append("%s: not a 3B-owned 0D parameter" % name)
        if "%s: '%d'" % (name, default) not in server or "%s: c.%s" % (camel, name) not in server:
            errs.append("%s: not configured with default %d" % (name, default))
        if "`%s`" % name not in envdoc:
            errs.append("%s: not documented" % name)
    if "views.layout_reads" not in {t["name"] for t in registry["telemetry"]}:
        errs.append("signal views.layout_reads not registered")
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for e in ENVELOPES:
        if "'%s'" % e not in envelopes:
            errs.append("envelope %s not registered" % e)
    od = read(P("docs/product/open-decisions.md"))
    if "Decided (Phase 3B" not in od[od.find('id="od-12"'):od.find('id="od-13"')]:
        errs.append("OD-12 must be recorded as decided")
    return errs, "%d bounds, %d envelopes, OD-12 decided" % (len(BOUNDS), len(ENVELOPES))


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0020")
    if not path:
        return ["no ADR-0020"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0020 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0020 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0020 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0020 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    closure = load(P("docs/engineering/phase3/closure-3b.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 3B: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "3B", ["D%d" % i for i in range(1, 7)])),
        ("phase 3B: layouts agree (migration, engine, web)", check_layouts()),
        ("phase 3B: layout reads and board moves", check_reads()),
        ("phase 3B: bounds, signal, envelopes, OD-12", check_contracts(registry)),
        ("phase 3B: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 3B: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs), ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 3B CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
