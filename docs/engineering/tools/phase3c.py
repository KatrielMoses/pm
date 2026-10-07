#!/usr/bin/env python3
"""Phase 3C closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase3d.py      # exit 1 on any failure

Phase 3C (docs/engineering/phase3/closure-3c.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, foundations deferred with
accepted sources, decisions D1..D5 tied to ADR-0021 rows) plus drift checks: the planning bounds are
registered (owner 3C), configured, and documented; the planning events, signals, envelopes, and the
bls prefix are registered; migration 0034 keeps its focus, commitment, record, and RLS guards and
reverses to 0033; Today reuses the 3A query engine and 3D time instead of new evaluators; planning
never writes a task; and the ADR stays proposed until acceptance.
"""
import json
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

BOUNDS = {
    "TODAY_ITEMS_MAX": ("todayItemsMax", 100),
    "TODAY_LIST_MAX": ("todayListMax", 50),
    "UPCOMING_DEADLINE_DAYS": ("upcomingDeadlineDays", 14),
    "WORK_BLOCKS_PER_DAY_MAX": ("workBlocksPerDayMax", 50),
    "WORK_BLOCKS_RANGE_DAYS_MAX": ("workBlocksRangeDaysMax", 42),
    "BLOCK_SERIES_MAX": ("blockSeriesMax", 50),
    "BLOCK_SERIES_HORIZON_DAYS": ("blockSeriesHorizonDays", 28),
    "DAY_CLOSE_DISCOVERY_MAX": ("dayCloseDiscoveryMax", 100),
    "DAY_CLOSE_BATCH_MAX": ("dayCloseBatchMax", 200),
}
EVENTS = [
    "planning.work_block.created",
    "planning.work_block.moved",
    "planning.work_block.deleted",
    "planning.block_series.defined",
    "planning.block_series.ended",
    "planning.today.committed",
    "planning.today.changed",
    "planning.day.closed",
]
SIGNALS = ["planning.today", "planning.blocks", "planning.block_series", "planning.day_close"]
ENVELOPES = ["today_view", "day_plan", "daily_records", "today_commitment", "daily_record"]
SERVICE = "packages/work/src/planning/today-service.ts"
MIGRATION = "packages/db/migrations/0034_today_planning"


def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "3C":
            errs.append("%s: 0D owner must be 3C" % name)
        if "%s: '%d'" % (name, default) not in server:
            errs.append("%s: server default is not %d" % (name, default))
        if "%s: c.%s" % (camel, name) not in server:
            errs.append("%s: not mapped to settings.%s" % (name, camel))
        if "`%s`" % name not in envdoc:
            errs.append("%s: not documented in environments.md" % name)
        if camel not in settings:
            errs.append("%s: missing from WorkSettings" % camel)
    events = {e["type"] for e in registry["events"]}
    for e in EVENTS:
        if e not in events:
            errs.append("event %s not registered" % e)
    signals = {t["name"] for t in registry["telemetry"]}
    for s in SIGNALS:
        if s not in signals:
            errs.append("signal %s not registered" % s)
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for e in ENVELOPES:
        if "'%s'" % e not in envelopes:
            errs.append("envelope %s not registered" % e)
    prefixes = {p["prefix"]: p for p in registry["id_prefixes"]}
    for pre in ("blk", "bls"):
        if pre not in prefixes:
            errs.append("prefix %s not registered" % pre)
    acts = {a["key"]: a for a in policy["actions"]}
    if acts.get("personal.manage_own", {}).get("roles", {}).get("administrator") != "own":
        errs.append("personal.manage_own must stay own-only (no administrator bypass)")
    return errs, "%d bounds, %d events, %d signals, %d envelopes, 2 prefixes" % (
        len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["work_block_guard", "focus_protected", "today_commitment_guard", "daily_record_guard",
                   "work_block_occurrence", "today_commitment_once", "daily_record_once",
                   "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY",
                   "exec_dispatch.discover_days_to_close", "exec_dispatch.discover_block_series_due"]:
        if needle not in up:
            errs.append("0034 lacks %s" % needle)
    for table in ["work_block", "block_series", "today_commitment", "daily_record"]:
        if "CREATE POLICY tenant_isolation ON planning.%s" % table not in up:
            errs.append("0034: planning.%s has no tenant_isolation policy" % table)
    if "Restores the exact 0033 catalog" not in down:
        errs.append("0034 down must restore 0033")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    svc = read(P(SERVICE))
    if "await this.runQuery(" not in svc:
        errs.append("Today's lists must run the 3A query engine")
    if "timetrack.time_entry" not in svc:
        errs.append("daily records must take actual time from 3D")
    if "this.requirePersonal(p, 'personal.manage_own')" not in svc:
        errs.append("planning commands must be personal.manage_own")
    for forbidden in ["updateTable('work.task')", "UPDATE work.task", "withWorkspaceBypass", "SECURITY DEFINER"]:
        if forbidden in svc:
            errs.append("planning service must not use %s" % forbidden)
    for path, needles in {
        "packages/work/test/integration/today.test.ts": [
            "commits tasks without changing any date",
            "generates recurring blocks at a stable local time across DST",
            "keeps plans personal, omits unreadable work, and survives revocation"],
        "packages/db/test/integration/migrations.test.ts": [
            "boundaries = [9, 12, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    return errs, "migration guards, reused evaluators, personal plans"


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0021")
    if not path:
        return ["no ADR-0021"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0021 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0021 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0021 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0021 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase3/closure-3c.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 3C: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "3C", ["D%d" % i for i in range(1, 6)])),
        ("phase 3C: bounds, events, signals, envelopes, prefixes", check_contracts(registry, policy)),
        ("phase 3C: migration and authorization invariants", check_invariants()),
        ("phase 3C: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 3C: configuration keys documented", phase1.check_config_documented()),
        ("phase 3C: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 3C CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
