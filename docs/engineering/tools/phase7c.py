#!/usr/bin/env python3
"""Phase 7C AI drafting and analysis closure validator (ADR-0041)."""
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

SUBPHASE = "7C"
DECISIONS = ["D%d" % i for i in range(1, 11)]
ADR = "docs/engineering/adr/0041-ai-drafting-analysis.md"
CLOSURE = "docs/engineering/phase7/closure-7c.json"
MIGRATION = "packages/db/migrations/0057_ai_drafting_analysis"
SERVICE = "packages/work/src/ai/ai-gateway-service.ts"
CATALOG = "packages/work/src/ai/actions/catalog.ts"
ANALYSIS = "packages/work/src/ai/actions/analysis.ts"
WEB = "apps/web/src/ai/assist-page.tsx"
THREATS = ["T-%d" % i for i in range(108, 114)]
TESTS = ["AT-%d" % i for i in range(431, 455)]
TEST_FILES = [
    "packages/work/test/integration/ai-assist.test.ts",
    "packages/work/test/integration/ai-proposals.test.ts",
    "apps/api/test/integration/ai-api.test.ts",
    "e2e/ai-assist.spec.ts",
]
ACTIONS = ["summarize", "extract", "analyze_work", "recommend_next", "draft_status_update",
           "draft_release_notes", "draft_project", "draft_tasks", "rewrite", "categorize"]
BOUNDARIES = ["DQ-28", "OD-31", "OD-41", "OD-46", "PRJ-007", "DOC-019", "REL-FU-7A-01", "7E"]


def check_boundaries_recorded(closure):
    errs = []
    got = {b["id"] for b in closure.get("boundaries", [])}
    for b in BOUNDARIES:
        if b not in got:
            errs.append("closure must record the %s boundary" % b)
    adr = read(P(ADR))
    for term in ("**DQ-28, OD-41, OD-46", "**OD-31:**", "**PRJ-007:**", "**REL-FU-7A-01:** still tracked",
                 "**7E, 7F, 8, 9, 10A:**", "## Action matrix"):
        if term not in adr:
            errs.append("ADR-0041 must state %s" % term)
    for a in ACTIONS:
        if "| `%s.v1` |" % a not in adr:
            errs.append("the action matrix must list %s.v1" % a)
    return errs, "boundaries recorded and the per-action matrix present"


def check_actions():
    """One catalog through the one gateway; honest analysis; drafts only as 7D proposals."""
    errs = []
    catalog = read(P(CATALOG))
    for a in ACTIONS:
        if "key: '%s'," % a not in catalog:
            errs.append("catalog lacks %s" % a)
    analysis = read(P(ANALYSIS))
    for term in ("export function validateAnalysis(", "export function ruleFindings(", "'contradicts_record'",
                 "'quote_mismatch'", "'untrusted_link'", "status: 'needs_input',",
                 "// Completeness first: an incomplete transport is never an analysis"):
        if term not in analysis:
            errs.append("analysis contract lacks %s" % term)
    service = read(P(SERVICE)) + read(P("packages/work/src/ai/retrieval/manifest.ts"))
    for term, label in [
        ("'input_changed',", "the input-digest binding"),
        ("#requireActionContext(def: AiActionDef", "required-context refusals"),
        ("readers.choices", "offered choices as manifest entries"),
        ("const e = await this.ownCalendarEvent(tx, p, id);", "the owner-only meeting adapter"),
        ("const g = await this.loadGoal(tx, p, id);", "the goal adapter"),
        ("await this.setAssigneesIn(", "assignment through the canonical command"),
        ("await this.toggleLabel(tx, caller, p, t, payload.label!, 'add');", "labels through the canonical command"),
        ("await this.addCriterionIn(tx, caller, p, ref(payload.task)!, input);", "criteria through the canonical command"),
        ("async #guardBefore(", "the locked first-mutation version check"),
        ("if (input.def.kind === 'proposal') this.#requireApplier(caller, p);", "drafting needs a person"),
    ]:
        if term not in service:
            errs.append("gateway lacks %s" % label)
    block = service[service.index("// 7D change proposals"):] if "// 7D change proposals" in service else ""
    for m in re.finditer(r"(?:insertInto|updateTable|deleteFrom)\('([a-z_]+)\.", block):
        if m.group(1) != "ai":
            errs.append("the proposal block writes %s.* directly (use the domain command)" % m.group(1))
    web = read(P(WEB))
    if re.search(r"\bfetch\(|XMLHttpRequest|dangerouslySetInnerHTML|innerHTML", web):
        errs.append("%s must not fetch or render markup" % WEB)
    for term in ("Rule findings from the records", "Generated suggestions", "Add answers", "readAssistDraft(account, ws)"):
        if term not in web:
            errs.append("assist page lacks %r" % term)
    for page in ("apps/web/src/pages/project-pages.tsx", "apps/web/src/pages/task-pages.tsx"):
        if "/ai/assist?" not in read(P(page)):
            errs.append("%s must offer AI assist with its scope" % page)
    routes = read(P("apps/api/src/ai/routes.ts"))
    for r in ("/ai/actions", "/ai/assist-estimates", "/ai/assist-runs"):
        if r not in routes:
            errs.append("API lacks %s" % r)
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    if "ai.analyses" not in {t["name"] for t in registry["telemetry"]}:
        errs.append("telemetry signal ai.analyses is not registered")
    for pkg in ["package.json", "packages/work/package.json", "apps/api/package.json", "apps/web/package.json"]:
        if re.search(r'"(pgvector|openai|@anthropic-ai/[^"]*|langchain|@langchain/[^"]*)"\s*:', read(P(pkg))):
            errs.append("%s adds a vector or AI SDK dependency" % pkg)
    return errs, "ten actions, digest binding, honest analysis, canonical adapters, owner-only meetings"


def check_migration():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    if "-- migrate:phase expand" not in up:
        errs.append("0057 must be an expand migration")
    if re.search(r"\b(DROP TABLE|RENAME)\b", up):
        errs.append("0057 must be additive")
    for term in ("'analysis'", "ADD COLUMN action_key text", "ADD COLUMN input_digest text",
                 "'label', 'member'", "'task.assign', 'label.add', 'criterion.add'", "ADD COLUMN assumptions text[]"):
        if term not in up:
            errs.append("0057 lacks %s" % term)
    if "Restores the exact 0056 catalog" not in down or "0057 cannot be rolled back" not in down:
        errs.append("0057 down must restore the exact 0056 catalog and refuse while 7C data exists")
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    # Later migrations belong to later phases, each held by its own validator.
    later_owned = {"0058_ai_briefings.up.sql": "phase7e.py"}
    after = names[names.index("0057_ai_drafting_analysis.up.sql") + 1:] if "0057_ai_drafting_analysis.up.sql" in names else ["?"]
    for n in after:
        if n not in later_owned or not os.path.isfile(P("docs/engineering/tools/%s" % later_owned[n])):
            errs.append("migration %s after 7C must be held by a later-phase validator" % n)
    errs += phase1.check_boundaries([57])
    if "assumptions: null," not in read(P("packages/work/src/ai/lifecycle.ts")):
        errs.append("erasure must clear proposal assumptions")
    return errs, "additive 0057, exact rollback with guard, boundary 57, erasure"


def check_identifiers():
    errs = []
    if not os.path.isfile(P(ADR)):
        errs.append("ADR-0041 missing")
    for path, anchor in (("docs/architecture/data/12-decisions.md", "adr-48"),
                         ("docs/architecture/access/15-decisions.md", "az-48"),
                         ("docs/architecture/platform/19-decisions.md", "pl-50")):
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
            errs.append("%s must cover a 7C threat" % at)
        if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
            errs.append("%s must title exactly one test" % at)
    model = {e["name"]: e for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    if "action_key" not in json.dumps(model.get("ai_action", {})):
        errs.append("0B ai_action must record the action key")
    if "goal|meeting" not in json.dumps(model.get("ai_context_ref", {})):
        errs.append("0B ai_context_ref must record goal and meeting sources")
    unit = read(P("packages/work/test/unit/ai-actions.test.ts"))
    for case in ("registers ten versioned actions", "checks completeness first", "rule findings count only included sources",
                 "drafting actions propose only their operations"):
        if case not in unit:
            errs.append("the 7C unit tests lack %r" % case)
    return errs, "ADR-0041, ADR-48, AZ-48, PL-50, T-108..T-113, AT-431..AT-454"


def check_corrections(closure):
    """Corrective review 01: each finding maps to registered runtime tests that title exactly once."""
    errs = []
    review = {r["id"]: r for r in closure.get("corrective_reviews", [])}.get("7C-CR-01")
    if not review:
        return ["closure must record corrective review 7C-CR-01"], ""
    groups = {g["id"]: g for g in review.get("groups", [])}
    if sorted(groups) != ["R1", "R2"]:
        errs.append("7C-CR-01 must record findings R1 and R2")
    cache = {}
    tests = {x["id"] for x in load(P("docs/architecture/access/policy/threats.json"))["tests"]}
    text = "\n".join(read(P(f)) for f in TEST_FILES)
    for gid, g in sorted(groups.items()):
        phase2.check_evidence("7C-CR-01 %s" % gid, g.get("evidence"), cache, errs)
        for at in g.get("tests", []):
            if at not in tests:
                errs.append("%s test %s is not registered in 0C" % (gid, at))
            if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
                errs.append("%s test %s must title exactly one test" % (gid, at))
    service = read(P(SERVICE))
    # No parallel choices path: names reach the provider only as manifest entries.
    for gone in ("Choices (JSON, data only)", "choice_refs", "#actionChoices", "#firstTouch", "touchedBy("):
        if gone in service:
            errs.append("the gateway still contains %r" % gone)
    if "FOR UPDATE OF x" not in service:
        errs.append("the version guard must lock the domain row")
    races = read(P("packages/work/test/integration/ai-proposals.test.ts"))
    if "FOR UPDATE OF t" not in races or "pg_locks WHERE NOT granted" not in races:
        errs.append("the race regressions must hold a real row lock and observe the blocked Apply")
    return errs, "R1 and R2 mapped to AT-449..AT-454 with lock-observed race tests"


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase7c.py" not in verify:
        errs.append("verify.sh must run the Phase 7C validator in the core gate")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase7c") != "python3 docs/engineering/tools/phase7c.py":
        errs.append("package.json lacks validate:phase7c")
    readme = read(P("docs/engineering/README.md"))
    if "0041-ai-drafting-analysis.md" not in readme or "phase7c.py" not in readme:
        errs.append("the engineering index must list ADR-0041 and the Phase 7C validator")
    if "ai-assist" not in read(P("playwright.config.ts")):
        errs.append("the tablet project must run the 7C journeys")
    return errs, "verify.sh (and so preflight), package.json, the engineering index, and the tablet project"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P(CLOSURE))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 7C: requirement closure", phase2.check_closure(catalog, closure, subphases, SUBPHASE, DECISIONS)),
        ("phase 7C: open decisions, boundaries, and the action matrix", check_boundaries_recorded(closure)),
        ("phase 7C: 7A production safety still holds", phase7a.check_production_safety()),
        ("phase 7C: actions, analysis, adapters, and surfaces", check_actions()),
        ("phase 7C: migration 0057", check_migration()),
        ("phase 7C: identifiers and tests", check_identifiers()),
        ("phase 7C: corrective review 01 evidence", check_corrections(closure)),
        ("phase 7C: validator wiring", check_wiring()),
        ("phase 7C: migration sequence", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-72s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for error in errs:
            print("    ERROR: " + error)
        failed += bool(errs)
    print("PHASE 7C CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
