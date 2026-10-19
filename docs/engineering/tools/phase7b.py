#!/usr/bin/env python3
"""Phase 7B authorized retrieval and citations closure validator (ADR-0039)."""
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

SUBPHASE = "7B"
DECISIONS = ["D%d" % i for i in range(1, 11)]
ADR = "docs/engineering/adr/0039-authorized-retrieval-citations.md"
CLOSURE = "docs/engineering/phase7/closure-7b.json"
MIGRATION = "packages/db/migrations/0055_ai_retrieval_citations"
SERVICE = "packages/work/src/ai/ai-gateway-service.ts"
MANIFEST = "packages/work/src/ai/retrieval/manifest.ts"
GROUNDING = "packages/work/src/ai/retrieval/grounding.ts"
FACTS = "packages/work/src/ai/retrieval/facts.ts"
WEB = "apps/web/src/ai/ask-page.tsx"
THREATS = ["T-%d" % i for i in range(99, 103)]
TESTS = ["AT-%d" % i for i in range(390, 407)]
PHASE0_TESTS = ["AT-019", "AT-020"]
TEST_FILES = [
    "packages/work/test/integration/ai-retrieval.test.ts",
    "apps/api/test/integration/ai-api.test.ts",
    "e2e/ai-ask.spec.ts",
]
BOUNDARIES = ["OD-31", "DOC-019", "DQ-28", "OD-41", "OD-46", "PRJ-007", "REL-FU-7A-01", "7C"]


def check_boundaries_recorded(closure):
    """Open decisions and later phases stay open and recorded, never claimed."""
    errs = []
    got = {b["id"] for b in closure.get("boundaries", [])}
    for b in BOUNDARIES:
        if b not in got:
            errs.append("closure must record the %s boundary" % b)
    decisions = read(P("docs/product/open-decisions.md"))
    for od in ("OD-31",):
        section = decisions.split("### %s" % od)[1][:3200] if "### %s" % od in decisions else ""
        if "Status (Phase 7B" not in section:
            errs.append("%s needs its Phase 7B status line" % od)
        if re.search(r"\*\*Decided", section):
            errs.append("%s must stay open (7B decides nothing)" % od)
    adr = read(P(ADR))
    for term in ("**OD-31 (semantic search):** open", "**DQ-28, OD-41, OD-46", "**REL-FU-7A-01:** still tracked",
                 "**PRJ-007:** project AI budgets are still not enforced"):
        if term not in adr:
            errs.append("ADR-0039 must state %s" % term)
    return errs, "OD-31, DOC-019, DQ-28, OD-41, OD-46, PRJ-007, REL-FU-7A-01, and 7C recorded as boundaries"


def check_retrieval():
    """One retrieval authority through canonical read paths; nothing fetched, nothing trusted from clients."""
    errs = []
    service = read(P(SERVICE))
    manifest = read(P(MANIFEST))
    grounding = read(P(GROUNDING))
    search = read(P("packages/work/src/search/search-service.ts"))
    if "protected async searchIn(" not in search or "return this.#searchParsed(tx, p, input);" not in search:
        errs.append("5A search must expose its one authority in-transaction (searchIn)")
    for term, label in [
        ("const r = await this.searchIn(tx, p, {", "candidates through 5A search"),
        ("const t = await this.loadTask(tx, p, id);", "tasks through the task loader"),
        ("this.requireTaskAction(p, 'record.read', t);", "the task read decision"),
        ("const pr = await this.loadProject(tx, p, id);", "projects through the project loader"),
        ("const d = await this.loadDocument(tx, p, id);", "documents through the document loader"),
        ("this.requireDocAction(p, 'record.read', d);", "the document read decision"),
        ("const { row, host } = await this.loadComment(tx, p, id);", "comments through their host"),
        ("this.taskHistoryPage(tx, p, t, ACTIVITY_ENTRIES, null)", "task activity through history"),
        ("if (t.ownLevel === null) throw new TenancyError('not_found');", "history outside a share"),
        ("const status = await this.sourceStatus(tx, p, d);", "4C approval state"),
        ("async #publicationCheck(", "the re-check before publication"),
        # 7D: a change-proposal run shares the grounded run's manifest re-check (RETRIEVAL_PURPOSES).
        ("const answer = RETRIEVAL_PURPOSES.includes(action.purpose)\n      ? await this.#recordedAnswer(tx, opId, action)", "the dispatch re-check of the recorded manifest"),
        ("ai_project_budget_unenforced", "the PRJ-007 refusal"),
        ("projectGrants: new Map([...p.projectGrants].filter(([id]) => projectIds.has(id))),", "delegation narrowing of project grants"),
    ]:
        if term not in service:
            errs.append("gateway lacks %s" % label)
    for term, label in [
        ("readers.search(", "search proposes candidates"),
        ("if (c.selection === 'explicit' && !soft.has(key(c.kind, c.id)))", "opaque refusal for named sources"),
        ("export const MANIFEST_LIST_MAX = 20;", "the listing bound"),
        ("'scope_conflict'", "no fallback for conflicting scope"),
        ("needs_explicit_choice", "unsuitable sources need an explicit choice"),
        ("redactCredentials(f.text)", "credential redaction"),
    ]:
        if term not in manifest:
            errs.append("manifest engine lacks %s" % label)
    for term in ("export function validateAnswer(", "quote_mismatch", "unsupported_figure", "contradicts_record",
                 "untrusted_link", "malformed_response", "partial_response",
                 "GROUNDED_TEMPLATE_VERSION = 'grounded_answer.v1'"):
        if term not in grounding:
            errs.append("answer validation lacks %s" % term)
    # The retrieval engine and the page never fetch, follow links, or render generated markup.
    for path in (MANIFEST, GROUNDING, FACTS, WEB):
        text = read(P(path))
        if re.search(r"\bfetch\(|XMLHttpRequest|dangerouslySetInnerHTML|innerHTML", text):
            errs.append("%s must not fetch or render markup" % path)
    for pkg in ["package.json", "packages/work/package.json", "apps/api/package.json", "apps/web/package.json"]:
        if re.search(r'"(pgvector|@pinecone[^"]*|chromadb|faiss[^"]*|openai|@anthropic-ai/[^"]*|langchain|@langchain/[^"]*)"\s*:',
                     read(P(pkg))):
            errs.append("%s adds a vector or AI SDK dependency (OD-31)" % pkg)
    routes = read(P("apps/api/src/ai/routes.ts"))
    for r in ("/ai/context-previews", "/ai/answer-estimates", "/ai/answers"):
        if r not in routes:
            errs.append("API lacks %s" % r)
    web = read(P(WEB))
    for term in ("Semantic (meaning-based) search is not available", "aria-label=\"Context sources\"",
                 "Facts from the records", "Exact excerpts from the sources", "Unverified statements (generated)",
                 "AI is not available", "I\n                  confirm this answer may cost up to"):
        if term.replace("\n                  ", " ") not in web.replace("\n                  ", " ") and term not in web:
            errs.append("Ask page lacks %r" % term)
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    names = {t["name"] for t in registry["telemetry"]}
    for m in ("ai.context_previews", "ai.answer_validations"):
        if m not in names:
            errs.append("telemetry signal %s is not registered" % m)
    params = {x["name"]: x for x in registry["parameters"]}
    for name in ("AI_CONTEXT_SOURCES_MAX", "AI_CONTEXT_SOURCE_CHARS"):
        if params.get(name, {}).get("owner") != "7B":
            errs.append("parameter %s must be registered with owner 7B" % name)
    return errs, "5A searchIn, canonical loaders, re-checks, validation, no fetch/markup/vector store"


def check_corrections(closure):
    """Corrective review 01: each finding maps to registered runtime tests that title exactly once."""
    errs = []
    review = {r["id"]: r for r in closure.get("corrective_reviews", [])}.get("7B-CR-01")
    if not review:
        return ["closure must record corrective review 7B-CR-01"], ""
    groups = {g["id"]: g for g in review.get("groups", [])}
    if sorted(groups) != ["R1", "R2", "R3"]:
        errs.append("7B-CR-01 must record findings R1, R2, and R3")
    cache = {}
    tests = {x["id"] for x in load(P("docs/architecture/access/policy/threats.json"))["tests"]}
    text = "\n".join(read(P(f)) for f in TEST_FILES)
    for gid, g in sorted(groups.items()):
        phase2.check_evidence("7B-CR-01 %s" % gid, g.get("evidence"), cache, errs)
        for at in g.get("tests", []):
            if at not in tests:
                errs.append("%s test %s is not registered in 0C" % (gid, at))
            if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
                errs.append("%s test %s must title exactly one test" % (gid, at))
    unit = read(P("packages/work/test/unit/ai-grounding-review01.test.ts"))
    for case in ("truncated or partial transport", "unrelated claim", "case folding is not verbatim",
                 "unrelated real date or amount", "complete output is checked"):
        if case not in unit:
            errs.append("the review 01 unit regressions lack %r" % case)
    grounding = read(P(GROUNDING))
    if "toLowerCase()" in grounding.split("const fold")[0]:
        errs.append("verbatim matching must not fold case")
    if "'sourced'" in grounding or "'validated'" in grounding:
        errs.append("the answer contract must not label generated claims sourced or answers validated")
    ux = read(P("docs/ux/06-interaction-states.md"))
    if "**Unverified** (generated)" not in ux:
        errs.append("the UX source must state the 7B trust labels")
    return errs, "R1-R3 mapped to AT-404..AT-406 and the review 01 unit regressions"


def check_migration():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    if "-- migrate:phase expand" not in up:
        errs.append("0055 must be an expand migration")
    if re.search(r"\b(DROP TABLE|DROP COLUMN|RENAME)\b", up):
        errs.append("0055 must be additive")
    for term in ("ADD CONSTRAINT ai_action_purpose CHECK (purpose IN ('test_run', 'grounded_answer'))",
                 "ADD COLUMN retrieval_scope jsonb", "ADD COLUMN manifest_digest text",
                 "ai_action_retrieval_shape", "ADD COLUMN handle text", "ADD COLUMN content_hash text",
                 "ai_context_ref_one_handle UNIQUE (operation_id, handle)", "ADD COLUMN grounding jsonb",
                 "OR NEW.grounding IS NOT NULL THEN"):
        if term not in up:
            errs.append("0055 lacks %s" % term)
    if "Restores the exact 0054 catalog" not in down or "OR NEW.completeness <> 'erased' OR NEW.content IS NOT NULL THEN" not in down:
        errs.append("0055 down must restore the exact 0054 catalog and the 0053 output guard")
    if "0055 cannot be rolled back" not in down:
        errs.append("0055 down must refuse while grounded answers exist")
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    by = {n.split("_", 1)[0]: n for n in names}
    if by.get("0055") != "0055_ai_retrieval_citations.up.sql":
        errs.append("0055_ai_retrieval_citations must keep its number")
    # Later migrations belong to later phases, each held by its own validator.
    later_owned = {
        "0056": ("0056_ai_change_proposals.up.sql", "phase7d.py"),
        "0057": ("0057_ai_drafting_analysis.up.sql", "phase7c.py"),
        "0058": ("0058_ai_briefings.up.sql", "phase7e.py"),
        "0059": ("0059_planning_capture.up.sql", "phase7f.py"),
        "0060": ("0060_phase7_integration.up.sql", "phase7.py"),
    }
    for k in sorted(k for k in by if k > "0055"):
        name, validator = later_owned.get(k, (None, None))
        if by[k] != name or not os.path.isfile(P("docs/engineering/tools/%s" % validator)):
            errs.append("migration %s after 7B must be held by a later-phase validator" % by[k])
    errs += phase1.check_boundaries([55])
    lifecycle = read(P("packages/work/src/ai/lifecycle.ts"))
    if "grounding: null" not in lifecycle:
        errs.append("erasure must clear validated answers")
    if "terminalReason: 'policy_rejected'" not in lifecycle:
        errs.append("departure must close the member's queued AI operations")
    return errs, "additive 0055, exact rollback with guard, boundary 55, erasure of answers"


def check_identifiers():
    errs = []
    if not os.path.isfile(P(ADR)):
        errs.append("ADR-0039 missing")
    for path, anchor in (("docs/architecture/data/12-decisions.md", "adr-46"),
                         ("docs/architecture/access/15-decisions.md", "az-46"),
                         ("docs/architecture/platform/19-decisions.md", "pl-48")):
        if read(P(path)).count('<a id="%s"></a>' % anchor) != 1:
            errs.append("%s must hold %s exactly once" % (path, anchor))
    t = load(P("docs/architecture/access/policy/threats.json"))
    tids = {x["id"] for x in t["threats"]}
    tests = {x["id"]: x for x in t["tests"]}
    for th in THREATS:
        if th not in tids:
            errs.append("%s is not registered" % th)
    text = "\n".join(read(P(f)) for f in TEST_FILES)
    for at in TESTS + PHASE0_TESTS:
        if at not in tests:
            errs.append("%s is not registered in 0C" % at)
        elif at in TESTS and not set(tests[at]["threats"]) & set(THREATS):
            errs.append("%s must cover a 7B threat" % at)
        if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
            errs.append("%s must title exactly one test" % at)
    model = {e["name"]: e for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    if "handle text null" not in json.dumps(model.get("ai_context_ref", {})):
        errs.append("0B model must record manifest entries on ai_context_ref")
    if "grounding jsonb" not in json.dumps(model.get("ai_output", {})):
        errs.append("0B model must record validated answers on ai_output")
    return errs, "ADR-0039, ADR-46, AZ-46, PL-48, T-99..T-102, AT-019, AT-020, AT-390..AT-406"


def check_tooling():
    """The local browser gate invokes real Playwright projects only (no fake aggregate)."""
    errs = []
    verify = read(P("scripts/verify.sh"))
    config = read(P("playwright.config.ts"))
    projects = re.findall(r"name:\s*'([a-z0-9-]+)'", config[config.index("projects:"):])
    m = re.search(r'^E2E_PROJECTS="([^"]+)"', verify, re.M)
    if not m or m.group(1).split() != projects:
        errs.append("verify.sh E2E_PROJECTS must equal the playwright.config.ts projects %s" % projects)
    if '--project="${SHARD#e2e-}"' in verify or "--project=all" in verify:
        errs.append("verify.sh must not construct an aggregate or shard-derived project for a full run")
    if not os.path.isfile(P("scripts/test/verify-shards.test.mjs")):
        errs.append("the browser-gate selection needs its regression test")
    if "ai-ask" not in config:
        errs.append("the tablet project must run the 7B journey")
    return errs, "verify.sh projects equal the Playwright config; regression test present"


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase7b.py" not in verify:
        errs.append("verify.sh must run the Phase 7B validator in the core gate")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase7b") != "python3 docs/engineering/tools/phase7b.py":
        errs.append("package.json lacks validate:phase7b")
    if pkg.get("scripts", {}).get("preflight") != "bash scripts/preflight.sh":
        errs.append("package.json lacks the fast preflight")
    if "scripts/verify.sh" not in read(P("scripts/preflight.sh")):
        errs.append("preflight must read the validator list from verify.sh")
    readme = read(P("docs/engineering/README.md"))
    if "0039-authorized-retrieval-citations.md" not in readme or "phase7b.py" not in readme:
        errs.append("the engineering index must list ADR-0039 and the Phase 7B validator")
    return errs, "verify.sh, preflight, package.json, and the engineering index"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P(CLOSURE))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 7B: requirement closure", phase2.check_closure(catalog, closure, subphases, SUBPHASE, DECISIONS)),
        ("phase 7B: open decisions and boundaries", check_boundaries_recorded(closure)),
        ("phase 7B: 7A production safety still holds", phase7a.check_production_safety()),
        ("phase 7B: retrieval authority, validation, and surfaces", check_retrieval()),
        ("phase 7B: corrective review 01 evidence", check_corrections(closure)),
        ("phase 7B: migration 0055", check_migration()),
        ("phase 7B: identifiers and tests", check_identifiers()),
        ("phase 7B: local verification tooling", check_tooling()),
        ("phase 7B: validator wiring", check_wiring()),
        ("phase 7B: migration sequence", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-72s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for error in errs:
            print("    ERROR: " + error)
        failed += bool(errs)
    print("PHASE 7B CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
