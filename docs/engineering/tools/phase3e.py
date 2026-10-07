#!/usr/bin/env python3
"""Phase 3E closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase3e.py      # exit 1 on any failure

Phase 3E (docs/engineering/phase3/closure-3e.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, foundations deferred with
accepted sources, decisions D1..D6 tied to ADR-0022 rows) plus drift checks: the capacity bounds are
registered (owner 3E), configured, and documented; the capacity events, signals, envelopes, prefixes,
and the capacity.view and capacity.reserve actions are registered; migration 0035 keeps its guards
and RLS and reverses to 0034; capacity reuses the 3A compiled query and the 3C Today view instead of
new evaluators; OD-19 is decided; and the ADR stays proposed until acceptance.
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
    "AVAILABILITY_WINDOWS_MAX": ("availabilityWindowsMax", 28),
    "TIME_OFF_ENTRIES_MAX": ("timeOffEntriesMax", 500),
    "BRAND_HOLIDAYS_MAX": ("brandHolidaysMax", 1000),
    "CAPACITY_RANGE_DAYS_MAX": ("capacityRangeDaysMax", 93),
    "CAPACITY_PEOPLE_MAX": ("capacityPeopleMax", 100),
}
EVENTS = [
    "planning.capacity_profile.updated",
    "planning.time_off.created",
    "planning.time_off.updated",
    "planning.time_off.deleted",
    "planning.holiday.created",
    "planning.holiday.deleted",
    "planning.capacity_reservation.set",
    "planning.capacity_reservation.removed",
]
SIGNALS = ["capacity.reads", "capacity.changes"]
ENVELOPES = ["capacity_profile", "capacity", "team_capacity", "rescheduling_inputs"]
PREFIXES = ["tof", "hol", "rsv"]
TABLES = ["capacity_profile", "availability_rule", "time_off", "holiday", "capacity_reservation"]
SERVICE = "packages/work/src/capacity/capacity-service.ts"
MIGRATION = "packages/db/migrations/0035_capacity"


def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "3E":
            errs.append("%s: 0D owner must be 3E" % name)
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
    prefixes = {p["prefix"] for p in registry["id_prefixes"]}
    for pre in PREFIXES:
        if pre not in prefixes:
            errs.append("prefix %s not registered" % pre)
    acts = {a["key"]: a for a in policy["actions"]}
    view, reserve = acts.get("capacity.view"), acts.get("capacity.reserve")
    if not view or sorted(view["scopes"]) != ["brand", "workspace"]:
        errs.append("capacity.view must exist at workspace and brand scope")
    if not reserve or reserve["scopes"] != ["brand"]:
        errs.append("capacity.reserve must exist at brand scope only")
    for a in (view, reserve):
        if a and (a["roles"].get("limited_member") != "deny" or a["roles"].get("guest") != "deny"):
            errs.append("%s must deny limited members and guests" % a["key"])
    if acts.get("personal.manage_own", {}).get("roles", {}).get("administrator") != "own":
        errs.append("personal.manage_own must stay own-only (no administrator bypass)")
    return errs, "%d bounds, %d events, %d signals, %d envelopes, %d prefixes, 2 actions" % (
        len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES), len(PREFIXES))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["availability_rule_guard", "time_off_shape", "holiday_unique", "capacity_reservation_unique",
                   "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY"]:
        if needle not in up:
            errs.append("0035 lacks %s" % needle)
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON planning.%s" % table not in up:
            errs.append("0035: planning.%s has no tenant_isolation policy" % table)
        if "'planning.%s':" % table not in schema:
            errs.append("schema.ts lacks planning.%s" % table)
    if "Restores the exact 0034 catalog" not in down:
        errs.append("0035 down must restore 0034")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    svc = read(P(SERVICE))
    for method in ["async personCapacity(", "async teamCapacity(", "async reschedulingInputs(",
                   "protected override async dayView(", "override async workload("]:
        if method not in svc:
            errs.append("capacity service lacks %s" % method)
    m = re.search(r"protected async estimatesOf\((.*?)\n  \}\n", svc, re.S)
    if not m or "this.compileQuery(" not in m.group(1):
        errs.append("estimatesOf must use the 3A compiled query (compileQuery)")
    if "proposals: null" not in svc:
        errs.append("rescheduling inputs must not propose (7F)")
    if "from '../recurrence.ts'" not in read(P("packages/work/src/capacity/semantics.ts")):
        errs.append("working hours must reuse the 2A localToUtc conversion")
    for forbidden in ["updateTable('work.task')", "UPDATE work.task", "withWorkspaceBypass", "SECURITY DEFINER"]:
        if forbidden in svc:
            errs.append("capacity service must not use %s" % forbidden)
    for path, needles in {
        "packages/work/test/integration/capacity.test.ts": [
            "removes time off from availability and keeps its details private",
            "applies brand holidays only where the person holds a reservation and observes them (OD-19)",
            "denies other people’s capacity without capacity.view, and after permission loss",
            "serializes concurrent profile edits on the version"],
        "apps/api/test/integration/capacity-api.test.ts": [
            "gives strangers the same not_found everywhere and never returns internal UUIDs"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 36)))
    ods = read(P("docs/product/open-decisions.md"))
    od = ods[ods.find('<a id="od-19">'):ods.find('<a id="od-20">')]
    if "**Status (Phase 3E" not in od:
        errs.append("OD-19 must be decided (Phase 3E)")
    return errs, "migration guards, reused evaluators, OD-19 decided"


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0022")
    if not path:
        return ["no ADR-0022"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0022 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0022 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0022 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0022 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase3/closure-3e.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 3E: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "3E", ["D%d" % i for i in range(1, 7)])),
        ("phase 3E: bounds, events, signals, envelopes, prefixes", check_contracts(registry, policy)),
        ("phase 3E: migration and authorization invariants", check_invariants()),
        ("phase 3E: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 3E: configuration keys documented", phase1.check_config_documented()),
        ("phase 3E: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 3E CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
