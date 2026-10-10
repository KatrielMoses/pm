#!/usr/bin/env python3
"""Phase 3D closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase3d.py      # exit 1 on any failure

Phase 3D (docs/engineering/phase3/closure-3d.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, decisions D1..D5 tied to
ADR-0019 rows) plus drift checks: the time bounds are registered (owner 3D), configured, and
documented; the time events, signals, and envelopes are registered; migration 0032 keeps its
overlap, lock, consistency, append-only, and RLS guards and reverses to 0031; every time read path
runs the viewer's own predicate; OD-26 stays admin-only with step-up; and the ADR stays proposed
until acceptance. Runs after the Phase 3A validator (phase3.py).
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
    "TIME_ENTRY_MAX_HOURS": ("timeEntryMaxHours", 24),
    "TIME_TIMER_MAX_HOURS": ("timeTimerMaxHours", 12),
    "TIME_REPORT_RANGE_DAYS_MAX": ("timeReportRangeDaysMax", 366),
    "TIME_REPORT_ROWS_MAX": ("timeReportRowsMax", 500),
    "TIME_EXPORT_ROWS_MAX": ("timeExportRowsMax", 10000),
    "TIME_TIMESHEET_ENTRIES_MAX": ("timeTimesheetEntriesMax", 2000),
    "TIME_RUNAWAY_DISCOVERY_MAX": ("timeRunawayDiscoveryMax", 100),
    "TIME_RUNAWAY_BATCH_MAX": ("timeRunawayBatchMax", 200),
}
EVENTS = [
    "time.time_entry.recorded",
    "time.time_entry.updated",
    "time.time_entry.deleted",
    "time.timer.auto_stopped",
    "time.timesheet.submitted",
    "time.timesheet.withdrawn",
    "time.timesheet.approved",
    "time.timesheet.rejected",
    "time.timesheet.unlocked",
]
SIGNALS = ["time.entries", "time.timers", "time.timesheets", "time.exports", "time.timer_guard"]
ENVELOPES = ["timer_status", "timesheet_period", "time_report", "time_summary"]
ACTIONS = {"time.log_own": "comment", "timesheet.approve": "manage"}
SERVICE = "packages/work/src/time/time-service.ts"
MIGRATION = "packages/db/migrations/0032_time_tracking"


def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "3D":
            errs.append("%s: 0D owner must be 3D" % name)
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
    for pre in ("te", "tsh"):
        if pre not in prefixes:
            errs.append("prefix %s not registered" % pre)
    acts = {a["key"]: a for a in policy["actions"]}
    for key, level in ACTIONS.items():
        if acts.get(key, {}).get("required_level") != level:
            errs.append("%s must require %s" % (key, level))
    unlock = acts.get("timesheet.unlock", {})
    if not unlock.get("step_up") or unlock.get("roles", {}).get("member") != "deny":
        errs.append("timesheet.unlock must be admin-only with step-up (OD-26)")
    return errs, "%d bounds, %d events, %d signals, %d envelopes, 4 actions" % (
        len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["time_entry_one_live_timer", "time_segment_guard", "time_entry_guard",
                   "time_entry_consistency", "timetrack.append_only", "timetrack.lock_person",
                   "timetrack.day_closed", "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY",
                   "time_entry_task_fkey", "exec_dispatch.discover_runaway_timers"]:
        if needle not in up:
            errs.append("0032 lacks %s" % needle)
    for table in ["time_entry", "time_segment", "timesheet", "timesheet_line", "timesheet_approval",
                  "period_lock"]:
        if "CREATE POLICY tenant_isolation ON timetrack.%s" % table not in up:
            errs.append("0032: timetrack.%s has no tenant_isolation policy" % table)
    if "Restores the exact 0031 catalog" not in down:
        errs.append("0032 down must restore 0031")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    svc = read(P(SERVICE))
    # Every read path runs the viewer's own predicate (lists, views, periods, sheets, reports,
    # summaries, exports).
    if svc.count("await this.entryPredicate(tx, p)") < 8:
        errs.append("time service must compile the viewer's predicate for every read path")
    if "this.requireTaskAction(p, 'time.log_own', t)" not in svc or \
            "this.requireProjectAction(p, 'time.log_own', prj)" not in svc:
        errs.append("time.log_own must be decided on the task or project")
    if "await this.stepUp(tx, caller, p, req, 'timesheet.unlock'" not in svc:
        errs.append("unlock must require step-up (OD-26)")
    if "await this.selfApprovalAllowed(tx, p)" not in svc:
        errs.append("timesheet decisions must apply OD-20 self-approval")
    if "incomplete_visibility" not in svc:
        errs.append("approvers must read every entry in the line")
    for forbidden in ["withWorkspaceBypass", "SECURITY DEFINER", "app_worker"]:
        if forbidden in svc:
            errs.append("time service must not use %s" % forbidden)
    for path, needles in {
        "packages/work/test/integration/time.test.ts": [
            "never lets one person’s time overlap (service check and database guard)",
            "keeps one live timer per person when starts race",
            "computes durations across daylight-saving changes"],
        "packages/work/test/integration/timesheets.test.ts": [
            "closes the whole period for the person while submitted",
            "unlocks an approved line only for admins"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 33)))
    return errs, "migration guards, predicate-only reads, OD-20/OD-26"


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0019")
    if not path:
        return ["no ADR-0019"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0019 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0019 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0019 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0019 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase3/closure-3d.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 3D: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "3D", ["D%d" % i for i in range(1, 6)])),
        ("phase 3D: bounds, events, signals, envelopes, actions", check_contracts(registry, policy)),
        ("phase 3D: migration and authorization invariants", check_invariants()),
        ("phase 3D: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 3D: configuration keys documented", phase1.check_config_documented()),
        ("phase 3D: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 3D CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
