#!/usr/bin/env python3
"""Phase 3 closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase3.py      # exit 1 on any failure

Phase 3A (docs/engineering/phase3/closure-3a.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, decisions D1..D5 tied to
ADR-0018 rows) plus drift checks: the view bounds are registered, configured, and documented; the
view events, signals, and envelopes are registered; the saved-view migration reverses to 0030 and
keeps its share-shape and pin guards; the query catalog covers every VIEW-012 dimension; no query
path accepts unreadable scope; and the ADR stays proposed until acceptance.
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
    "QUERY_CONDITIONS_MAX": ("queryConditionsMax", 40),
    "QUERY_DEPTH_MAX": ("queryDepthMax", 3),
    "QUERY_SORTS_MAX": ("querySortsMax", 5),
    "QUERY_VALUES_MAX": ("queryValuesMax", 100),
    "QUERY_GROUPS_MAX": ("queryGroupsMax", 200),
    "VIEW_COLUMNS_MAX": ("viewColumnsMax", 20),
    "SAVED_VIEWS_MAX": ("savedViewsMax", 200),
    "VIEW_PINS_MAX": ("viewPinsMax", 20),
    "EXPORT_ROWS_MAX": ("exportRowsMax", 5000),
    "TOTAL_COUNT_CAP": ("totalCountCap", 10000),
}
EVENTS = [
    "views.saved_view.created",
    "views.saved_view.updated",
    "views.saved_view.shared",
    "views.saved_view.unshared",
    "views.saved_view.deleted",
    "views.default.changed",
    "views.pin.changed",
]
SIGNALS = ["views.queries", "views.query_duration", "views.exports"]
ENVELOPES = ["view_catalog", "view_default", "view_default_resolution", "view_field_options"]
# VIEW-012 dimensions and their catalog fields (task entity; health/milestone also on projects).
DIMENSIONS = ["brand", "project", "status", "priority", "owner", "assignee", "agent", "due_date",
              "label", "milestone", "health"]


def check_contracts(registry):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "3A":
            errs.append("%s: 0D owner must be 3A" % name)
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
    page = load(P("docs/architecture/platform/contracts/schemas/collection-page.schema.json"))
    if "view" not in page["properties"]:
        errs.append("collection-page has no view object")
    return errs, "%d bounds, %d events, %d signals, %d envelopes" % (len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES))


def check_invariants():
    errs = []
    up = read(P("packages/db/migrations/0031_saved_views.up.sql"))
    down = read(P("packages/db/migrations/0031_saved_views.down.sql"))
    for needle in ["saved_view_share_shape", "view_pin_shared_guard", "ENABLE ROW LEVEL SECURITY",
                   "FORCE ROW LEVEL SECURITY", "saved_view_scope_is_workspace"]:
        if needle not in up:
            errs.append("0031 lacks %s" % needle)
    if "Restores the exact 0030 catalog" not in down:
        errs.append("0031 down must restore 0030")
    query = read(P("packages/work/src/views/query.ts"))
    for d in DIMENSIONS:
        if not re.search(r"^\s+%s: f\(" % re.escape(d), query, re.M):
            errs.append("query catalog lacks VIEW-012 dimension %s" % d)
    svc = read(P("packages/work/src/views/view-service.ts"))
    # Every query runs the viewer's own predicate; scope only narrows.
    if svc.count("compileVisibility(tx, p,") < 4:
        errs.append("view service must compile the viewer's predicate for every read path")
    if "narrowed to readable brands, never broadened" not in svc:
        errs.append("brand scope must only narrow (WSB-019)")
    for forbidden in ["withWorkspaceBypass", "SECURITY DEFINER", "app_worker"]:
        if forbidden in svc:
            errs.append("view service must not use %s" % forbidden)
    if "ALTER TABLE views.saved_view DISABLE" in up:
        errs.append("RLS must stay enabled")
    tests = read(P("packages/work/test/integration/views.test.ts"))
    for needle in ["hidden and unknown filter values run the same statements", "cursors are bound to",
                   "every catalog field compiles with every operator"]:
        if needle not in tests:
            errs.append("views.test.ts lacks %r" % needle)
    return errs, "migration guards, catalog dimensions, predicate-only reads"


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0018")
    if not path:
        return ["no ADR-0018"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0018 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0018 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0018 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0018 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    closure = load(P("docs/engineering/phase3/closure-3a.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 3A: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "3A", ["D%d" % i for i in range(1, 6)])),
        ("phase 3A: bounds, events, signals, envelopes", check_contracts(registry)),
        ("phase 3A: migration, catalog, and authorization invariants", check_invariants()),
        ("phase 3A: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 3A: configuration keys documented", phase1.check_config_documented()),
        ("phase 3A: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs), ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 3A CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
