#!/usr/bin/env python3
"""Phase 7E briefings and reviews closure validator (ADR-0042)."""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402
import phase2  # noqa: E402
import phase7a  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

SUBPHASE = "7E"
DECISIONS = ["D%d" % i for i in range(1, 11)]
ADR = "docs/engineering/adr/0042-briefings-reviews.md"
CLOSURE = "docs/engineering/phase7/closure-7e.json"
MIGRATION = "packages/db/migrations/0058_ai_briefings"
SERVICE = "packages/work/src/ai/ai-gateway-service.ts"
FACTS = "packages/work/src/ai/briefing/facts.ts"
SCHEDULE = "packages/work/src/ai/briefing/schedule.ts"
WEB = "apps/web/src/ai/briefings-page.tsx"
THREATS = ["T-%d" % i for i in range(114, 120)]
TESTS = ["AT-%d" % i for i in range(455, 468)]
TEST_FILES = [
    "packages/work/test/integration/briefings.test.ts",
    "apps/api/test/integration/ai-api.test.ts",
    "e2e/briefings.spec.ts",
]
MATRIX = ["BRF-%03d" % i for i in range(1, 19)] + ["PRJ-025", "LA-007"]
SECTIONS = ["overview.window", "completed.count", "accepted.count", "attention.overdue_count", "decisions.count",
            "deadlines.count", "capacity.week", "time.planned_actual", "ai_cost.window", "agent_runs.foundation",
            "release.test_evidence", "release.no_certification", "generated.unavailable"]
BOUNDARIES = ["DQ-28", "OD-31", "OD-41", "OD-46", "OD-25", "OD-16", "PRJ-007", "DOC-019", "REL-FU-7A-01", "8C", "9D"]
TABLES = ["briefing_schedule", "briefing", "briefing_statement", "briefing_correction", "briefing_correction_event"]


def check_boundaries_recorded(closure):
    errs = []
    got = {b["id"] for b in closure.get("boundaries", [])}
    for b in BOUNDARIES:
        if b not in got:
            errs.append("closure must record the %s boundary" % b)
    adr = read(P(ADR))
    for term in ("**DQ-28, OD-31, OD-41, OD-46", "**OD-25:**", "**OD-16:**", "**PRJ-007:**",
                 "**REL-FU-7A-01:** still tracked", "**8C, 9D, 7F, 12A:**", "## Requirement and section matrix"):
        if term not in adr:
            errs.append("ADR-0042 must state %s" % term)
    for r in MATRIX:
        if "\n| %s |" % r not in adr:
            errs.append("the requirement matrix must list %s" % r)
    return errs, "boundaries recorded and the requirement and section matrix present"


def check_briefings():
    """Fact-only, recipient-specific, source-linked, delivered through 4B, never spending."""
    errs = []
    facts = read(P(FACTS))
    for key in SECTIONS:
        if "key: '%s'," % key not in facts:
            errs.append("the fact engine lacks the %s statement" % key)
    if re.search(r"from '\.\./provider|\.complete\(|\.stream\(|\bfetch\(", facts):
        errs.append("the fact engine must not call a provider")
    schedule = read(P(SCHEDULE))
    for term in ("export function occurrenceInstant(", "// A fold yields two valid instants: the earlier one only.",
                 "// A gap: the smallest whole minute", "export const occurrenceKey =", "export function reportingWindow("):
        if term not in schedule:
            errs.append("schedule arithmetic lacks %s" % term)
    service = read(P(SERVICE))
    start = service.find("// 7E briefings and reviews (ADR-0042)")
    end = service.find("// 7D change proposals (ADR-0040)")
    block = service[start:end] if 0 <= start < end else ""
    if not block:
        errs.append("the gateway lacks the 7E briefing block")
    for term, label in [
        ("async #briefingReadable(", "the display-time evidence re-check"),
        ("availability: 'withheld'", "wholesale withholding"),
        ("async #applyCorrections(", "corrections applied beside their statement"),
        ("set({ state: 'stale',", "stale corrections"),
        ("FOR UPDATE SKIP LOCKED", "the claimed sweep"),
        (".where('trigger', '=', 'schedule')", "one briefing per occurrence"),
        ("pg_advisory_xact_lock", "one composition per comparable series"),
        ("type: 'briefing_ready',", "4B delivery intent"),
        ("terminalReason: 'superseded',", "superseded occurrences"),
        ("redactCredentials(", "redacted notes"),
        ("this.requirePersonal(p, 'personal.manage_own');", "personal authorization"),
        ("return fail('statement_invalid');", "malformed statements fail the briefing"),
    ]:
        if term not in block:
            errs.append("gateway lacks %s" % label)
    for m in re.finditer(r"(?:insertInto|updateTable|deleteFrom)\('([a-z_]+)\.", block):
        if m.group(1) not in ("ai",):
            errs.append("the briefing block writes %s.* directly" % m.group(1))
    if re.search(r"#createRun\(|this\.#ai\.provider|reserve\(", block):
        errs.append("the briefing block must not start, dispatch, or reserve an AI run")
    if "channels?: ReadonlyArray<'email' | 'browser'>;" not in read(P("packages/work/src/notify/fanout.ts")):
        errs.append("4B fan-out must honour a source's channels")
    render = read(P("packages/work/src/notify/render.ts"))
    if "if (type === 'briefing_ready') {" not in render or "minimal: true," not in render:
        errs.append("the briefing notice must be re-checked at send time and carry no content")
    if "eraseBriefingRows" not in read(P("packages/work/src/ai/lifecycle.ts")):
        errs.append("erasure must reach briefings and notes")
    if "aiBriefingSweepHandler(m.ai)" not in read(P("apps/worker/src/registry.ts")):
        errs.append("the worker must register the briefing sweep")
    routes = read(P("apps/api/src/ai/routes.ts"))
    for r in ("/ai/briefings", "/ai/briefing-previews", "/ai/briefing-schedules", "/ai/briefing-corrections"):
        if r not in routes:
            errs.append("API lacks %s" % r)
    if "path.includes('/ai/briefing')" not in read(P("apps/api/src/auth/routes.ts")):
        errs.append("bearer callers must be refused on briefing routes")
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    if "ai.briefings" not in {t["name"] for t in registry["telemetry"]}:
        errs.append("telemetry signal ai.briefings is not registered")
    prefixes = {p["prefix"] for p in registry["id_prefixes"]}
    for pre in ("bsc", "brf", "bco"):
        if pre not in prefixes:
            errs.append("ID prefix %s is not registered" % pre)
    web = read(P(WEB))
    if re.search(r"\bfetch\(|XMLHttpRequest|dangerouslySetInnerHTML|innerHTML", web):
        errs.append("%s must not fetch or render markup" % WEB)
    for term in ("Preview scope and window", "This briefing is withheld", "Your note or correction", "discardBriefingDrafts("):
        if term not in web:
            errs.append("briefing pages lack %r" % term)
    if "'.ai-briefing.'" not in read(P("apps/web/src/shell/drafts.ts")):
        errs.append("sign-out and session cleanup must remove briefing note drafts")
    return errs, "fact engine, DST arithmetic, withholding, corrections, sweep, 4B delivery, no AI spend"


def check_migration():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    if "-- migrate:phase expand" not in up:
        errs.append("0058 must be an expand migration")
    if re.search(r"\b(DROP TABLE|RENAME|ALTER TABLE [a-z_]+\.[a-z_]+ (ADD|DROP))\b", up):
        errs.append("0058 must be additive")
    for t in TABLES:
        if "CREATE TABLE ai.%s (" % t not in up:
            errs.append("0058 lacks ai.%s" % t)
        if "ALTER TABLE ai.%s FORCE ROW LEVEL SECURITY;" % t not in up:
            errs.append("ai.%s must force row-level security" % t)
    for term in ("CREATE UNIQUE INDEX briefing_one_per_occurrence", "exec_dispatch.discover_briefing_work",
                 "GRANT SELECT ON timetrack.timesheet_line TO app_worker;"):
        if term not in up:
            errs.append("0058 lacks %s" % term)
    if re.search(r"GRANT[^;]*DELETE[^;]*ai\.briefing", up):
        errs.append("no role may delete briefing rows")
    for term in ("Restores the exact 0057 catalog", "0058 cannot be rolled back",
                 "REVOKE SELECT ON timetrack.timesheet_line FROM app_worker;"):
        if term not in down:
            errs.append("0058 down lacks %s" % term)
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    if names[-1] != "0058_ai_briefings.up.sql":
        errs.append("0058_ai_briefings must be the last migration")
    errs += phase1.check_boundaries([58])
    return errs, "additive 0058, five forced-RLS tables, exact rollback with guard, boundary 58"


def check_identifiers():
    errs = []
    if not os.path.isfile(P(ADR)):
        errs.append("ADR-0042 missing")
    for path, anchor in (("docs/architecture/data/12-decisions.md", "adr-49"),
                         ("docs/architecture/access/15-decisions.md", "az-49"),
                         ("docs/architecture/platform/19-decisions.md", "pl-51")):
        if read(P(path)).count('<a id="%s"></a>' % anchor) != 1:
            errs.append("%s must hold %s exactly once" % (path, anchor))
    t = load(P("docs/architecture/access/policy/threats.json"))
    tids = {x["id"] for x in t["threats"]}
    tests = {x["id"]: x for x in t["tests"]}
    for th in THREATS:
        if th not in tids:
            errs.append("%s is not registered" % th)
    text = "\n".join(read(P(f)) for f in TEST_FILES)
    for at in TESTS:
        if at not in tests:
            errs.append("%s is not registered in 0C" % at)
        elif not set(tests[at]["threats"]) & set(THREATS):
            errs.append("%s must cover a 7E threat" % at)
        if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
            errs.append("%s must title exactly one test" % at)
    model = {e["name"]: e for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    for name in ("briefing_schedule", "briefing", "briefing_statement", "briefing_correction", "briefing_correction_event"):
        if name not in model:
            errs.append("0B lacks %s" % name)
        elif "Phase 7E" not in model[name].get("notes", ""):
            errs.append("0B %s must record its Phase 7E reconciliation" % name)
    unit = read(P("packages/work/test/unit/briefing-schedule.test.ts"))
    for case in ("spring-forward gap runs at the first valid instant", "ambiguous fall-back time runs only at its earlier instant",
                 "windows follow the local calendar"):
        if case not in unit:
            errs.append("the 7E unit tests lack %r" % case)
    return errs, "ADR-0042, ADR-49, AZ-49, PL-51, T-114..T-119, AT-455..AT-467"


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase7e.py" not in verify:
        errs.append("verify.sh must run the Phase 7E validator in the core gate")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase7e") != "python3 docs/engineering/tools/phase7e.py":
        errs.append("package.json lacks validate:phase7e")
    readme = read(P("docs/engineering/README.md"))
    if "0042-briefings-reviews.md" not in readme or "phase7e.py" not in readme:
        errs.append("the engineering index must list ADR-0042 and the Phase 7E validator")
    if "briefings" not in read(P("playwright.config.ts")):
        errs.append("the tablet project must run the 7E journey")
    return errs, "verify.sh (and so preflight), package.json, the engineering index, and the tablet project"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P(CLOSURE))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 7E: requirement closure", phase2.check_closure(catalog, closure, subphases, SUBPHASE, DECISIONS)),
        ("phase 7E: open decisions, boundaries, and the requirement matrix", check_boundaries_recorded(closure)),
        ("phase 7E: 7A production safety still holds", phase7a.check_production_safety()),
        ("phase 7E: briefings, schedules, corrections, and delivery", check_briefings()),
        ("phase 7E: migration 0058", check_migration()),
        ("phase 7E: identifiers and tests", check_identifiers()),
        ("phase 7E: validator wiring", check_wiring()),
        ("phase 7E: migration sequence", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-72s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for error in errs:
            print("    ERROR: " + error)
        failed += bool(errs)
    print("PHASE 7E CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
