#!/usr/bin/env python3
"""Phase 7D change proposal protocol closure validator (ADR-0040)."""
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

SUBPHASE = "7D"
DECISIONS = ["D%d" % i for i in range(1, 11)]
ADR = "docs/engineering/adr/0040-change-proposal-protocol.md"
CLOSURE = "docs/engineering/phase7/closure-7d.json"
MIGRATION = "packages/db/migrations/0056_ai_change_proposals"
SERVICE = "packages/work/src/ai/ai-gateway-service.ts"
CONTRACT = "packages/work/src/ai/proposals/contract.ts"
LIFECYCLE = "packages/work/src/ai/lifecycle.ts"
WEB = "apps/web/src/ai/proposals-page.tsx"
THREATS = ["T-%d" % i for i in range(103, 108)]
TESTS = ["AT-%d" % i for i in range(407, 431)]
TEST_FILES = [
    "packages/work/test/integration/ai-proposals.test.ts",
    "apps/api/test/integration/ai-api.test.ts",
    "e2e/ai-proposals.spec.ts",
]
TABLES = ["change_proposal", "proposed_change", "proposal_event", "proposal_approval", "proposal_application"]
BOUNDARIES = ["DQ-28", "OD-31", "OD-41", "OD-46", "PRJ-007", "DOC-019", "REL-FU-7A-01", "7C"]


def check_boundaries_recorded(closure):
    """Open decisions and later phases stay open and recorded, never claimed."""
    errs = []
    got = {b["id"] for b in closure.get("boundaries", [])}
    for b in BOUNDARIES:
        if b not in got:
            errs.append("closure must record the %s boundary" % b)
    adr = read(P(ADR))
    for term in ("**DQ-28, OD-41, OD-46", "**PRJ-007:** project AI budgets are still not enforced",
                 "**REL-FU-7A-01:** still tracked", "**7C, 7E, 7F, Phase 8:**",
                 "only the labelled synthetic fixture may generate proposals"):
        if term not in adr:
            errs.append("ADR-0040 must state %s" % term)
    return errs, "DQ-28, OD-31, OD-41, OD-46, PRJ-007, DOC-019, REL-FU-7A-01, and 7C recorded as boundaries"


def check_protocol():
    """Generation never writes; Apply is explicit, atomic, and runs the canonical domain commands."""
    errs = []
    service = read(P(SERVICE))
    contract = read(P(CONTRACT))
    block = service[service.index("// 7D change proposals"):] if "// 7D change proposals" in service else ""
    if not block:
        return ["the gateway lacks the 7D proposal block"], ""
    for term, label in [
        ("const made = await this.insertTask(tx, caller, p, container, input.fields, {", "task creation through insertTask"),
        ("origin: { kind: 'ai_draft', ref: { proposal: proposal.public_id, change: c.change_key } },", "the ai_draft origin"),
        ("await this.applyTaskChanges(tx, caller, req, p, t, current, next);", "task updates through applyTaskChanges"),
        ("await this.createProjectIn(tx, caller, p, input, 'ai_proposal');", "project creation through createProjectIn"),
        ("await this.updateProjectIn(tx, caller, p, pr.publicId, merge, req);", "project updates through updateProjectIn"),
        ("await this.createMilestoneIn(tx, caller, p, project, input);", "milestones through createMilestoneIn"),
        ("await this.addRelationshipIn(tx, caller, p, from, input);", "relationships through addRelationshipIn"),
        ("await this.saveContentIn(tx, caller, p, d.publicId, input);", "document versions through saveContentIn"),
        ("SAVEPOINT proposal_apply", "the atomic savepoint"),
        ("ROLLBACK TO SAVEPOINT proposal_apply", "the all-or-nothing rollback"),
        ("ROLLBACK TO SAVEPOINT proposal_dry_run", "the always-rolled-back validation"),
        ("kind: 'proposal_apply',", "the proposal_apply operation"),
        ("if (!failed)\n          await writeOutboxEvent(tx, {", "the success event only on success"),
        ("if (err instanceof StepUpNeeded) throw err;", "step-up still controlling Apply"),
        ("await this.#contentEligibility(tx, p, action, refs)", "the 7B current-content decision"),
        ("'approval_stale',", "the bound effective scope"),
        ("'approval_expired',", "approval expiry"),
        ("approval.approver_membership_id !== p.membershipId", "the approver binding"),
        ("{ kind: 'ai_proposal', ref: a.proposal },", "the ai_proposal command source"),
        ("causationId: a.causationId", "the AI action as causation"),
    ]:
        if term not in block:
            errs.append("gateway lacks %s" % label)
    if "ai_proposal_generation_unavailable" not in service:
        errs.append("gateway must refuse non-synthetic proposal generation in 7D")
    # No direct domain writes: adapters call commands; only AI tables are written here.
    for m in re.finditer(r"(?:insertInto|updateTable|deleteFrom)\('([a-z_]+)\.", block):
        if m.group(1) not in ("ai",):
            errs.append("the proposal block writes %s.* directly (use the domain command)" % m.group(1))
    for term in ("export const PROPOSAL_VERSION = 'change_proposal.v1';", "export function orderChanges(",
                 "export function selectionIssues(", "export function proposalFingerprint(",
                 "'unsupported_operation'", "'unknown_target'", "'dependency_cycle'", "'conflicting_update'",
                 "'unknown_reference'", "'field_not_allowed'"):
        if term not in contract:
            errs.append("contract lacks %s" % term)
    routes = read(P("apps/api/src/ai/routes.ts"))
    for r in ("/ai/proposal-runs", "/ai/proposals", "/ai/proposals/:prp"):
        if r not in routes:
            errs.append("API lacks %s" % r)
    # No endpoint takes a client-supplied proposal as model output.
    if re.search(r"createProposal|importProposal|proposals'\s*,\s*wrap\(async \(request, reply\) =>\s*\{[^}]*changes", routes):
        errs.append("no route may accept client JSON as a proposal")
    auth = read(P("apps/api/src/auth/routes.ts"))
    if "path.includes('/ai/proposal')" not in auth:
        errs.append("bearer callers must be refused on proposal routes at the edge")
    web = read(P(WEB))
    if re.search(r"\bfetch\(|XMLHttpRequest|dangerouslySetInnerHTML|innerHTML", web):
        errs.append("%s must not fetch or render markup" % WEB)
    for term in ("Apply {selected.length} of {p.changes.length} changes", "Nothing was applied",
                 "Applied by you · proposed by AI", "Some selected changes depend on unselected ones",
                 "The proposal changed since you started editing", "inFlight.current"):
        if term not in web:
            errs.append("review page lacks %r" % term)
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    names = {t["name"] for t in registry["telemetry"]}
    for m in ("ai.proposals", "ai.proposal_applications"):
        if m not in names:
            errs.append("telemetry signal %s is not registered" % m)
    params = {x["name"]: x for x in registry["parameters"]}
    for name in ("AI_PROPOSAL_APPROVAL_HOURS", "AI_PROPOSAL_CHANGES_MAX"):
        if params.get(name, {}).get("owner") != "7D":
            errs.append("parameter %s must be registered with owner 7D" % name)
    prefixes = {x.get("prefix"): x for x in registry.get("id_prefixes", [])}
    if "prp" not in prefixes:
        errs.append("the prp ID prefix must be registered")
    return errs, "canonical adapters, savepoint atomicity, success-only event, 7B eligibility, no direct writes"


def check_migration():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    if "-- migrate:phase expand" not in up:
        errs.append("0056 must be an expand migration")
    if re.search(r"\b(DROP TABLE|DROP COLUMN|RENAME)\b", up):
        errs.append("0056 must be additive")
    if "'change_proposal'" not in up:
        errs.append("0056 must admit the change_proposal purpose")
    for t in TABLES:
        if "CREATE TABLE ai.%s (" % t not in up:
            errs.append("0056 lacks ai.%s" % t)
        if "ALTER TABLE ai.%s FORCE ROW LEVEL SECURITY" % t not in up:
            errs.append("ai.%s must force row-level security" % t)
    if re.search(r"GRANT[^;]*DELETE[^;]*ON ai\.(%s)" % "|".join(TABLES), up):
        errs.append("no role may delete proposal rows")
    if "Restores the exact 0055 catalog" not in down or "0056 cannot be rolled back" not in down:
        errs.append("0056 down must restore the exact 0055 catalog and refuse while proposals exist")
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    by = {n.split("_", 1)[0]: n for n in names}
    if by.get("0056") != "0056_ai_change_proposals.up.sql":
        errs.append("0056_ai_change_proposals must keep its number")
    # Later migrations belong to later phases, each held by its own validator.
    later_owned = {
        "0057": ("0057_ai_drafting_analysis.up.sql", "phase7c.py"),
        "0058": ("0058_ai_briefings.up.sql", "phase7e.py"),
    }
    for k in sorted(k for k in by if k > "0056"):
        name, validator = later_owned.get(k, (None, None))
        if by[k] != name or not os.path.isfile(P("docs/engineering/tools/%s" % validator)):
            errs.append("migration %s after 7D must be held by a later-phase validator" % by[k])
    errs += phase1.check_boundaries([56])
    lifecycle = read(P(LIFECYCLE))
    for term in (".set({ payload: null, updated_at: now })", ".set({ state: 'revoked' })", "kind: 'erased' as const"):
        if term not in lifecycle:
            errs.append("erasure lacks %s" % term)
    if re.search(r"deleteFrom\('(work|core)\.", lifecycle):
        errs.append("erasing a proposal must never delete applied records")
    return errs, "additive 0056, five forced-RLS tables, exact rollback with guard, boundary 56, erasure"


def check_identifiers():
    errs = []
    if not os.path.isfile(P(ADR)):
        errs.append("ADR-0040 missing")
    for path, anchor in (("docs/architecture/data/12-decisions.md", "adr-47"),
                         ("docs/architecture/access/15-decisions.md", "az-47"),
                         ("docs/architecture/platform/19-decisions.md", "pl-49")):
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
            errs.append("%s must cover a 7D threat" % at)
        if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
            errs.append("%s must title exactly one test" % at)
    model = {e["name"]: e for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    for name in TABLES:
        if name not in model:
            errs.append("0B model lacks %s" % name)
    if model.get("change_proposal", {}).get("public_id_prefix") != "prp":
        errs.append("0B change_proposal must record the prp prefix")
    if "rolled_back" not in json.dumps(model.get("proposed_change", {})):
        errs.append("0B proposed_change must record the rolled_back and blocked outcomes")
    unit = read(P("packages/work/test/unit/ai-proposals.test.ts"))
    for case in ("temporary references resolve only", "fingerprint binds", "refuses cycles"):
        if case not in unit:
            errs.append("the contract unit tests lack %r" % case)
    return errs, "ADR-0040, ADR-47, AZ-47, PL-49, T-103..T-107, AT-407..AT-430"


def check_corrections(closure):
    """Corrective review 01: each finding maps to registered runtime tests that title exactly once."""
    errs = []
    review = {r["id"]: r for r in closure.get("corrective_reviews", [])}.get("7D-CR-01")
    if not review:
        return ["closure must record corrective review 7D-CR-01"], ""
    groups = {g["id"]: g for g in review.get("groups", [])}
    if sorted(groups) != ["R1", "R2"]:
        errs.append("7D-CR-01 must record findings R1 and R2")
    cache = {}
    tests = {x["id"] for x in load(P("docs/architecture/access/policy/threats.json"))["tests"]}
    text = "\n".join(read(P(f)) for f in TEST_FILES)
    for gid, g in sorted(groups.items()):
        phase2.check_evidence("7D-CR-01 %s" % gid, g.get("evidence"), cache, errs)
        for at in g.get("tests", []):
            if at not in tests:
                errs.append("%s test %s is not registered in 0C" % (gid, at))
            if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
                errs.append("%s test %s must title exactly one test" % (gid, at))
    page = read(P(WEB))
    if "sessionStorage" in page or "pm.ai.proposal.draft" in page:
        errs.append("the review page must not keep proposal drafts outside the personal-draft store")
    unit = read(P("apps/web/test/ai-proposals-review01.test.tsx"))
    for case in ("observed session invalidation or account change", "discards the stored draft",
                 "deliberate new approval with a fresh key", "sends exactly the reviewed versions"):
        if case not in unit:
            errs.append("the review 01 page regressions lack %r" % case)
    service = read(P(SERVICE))
    block = service[service.index("async rebaseAiProposal("):service.index("async rejectAiProposal(")] if "async rebaseAiProposal(" in service else ""
    for term in (".forUpdate()", "'target_changed'", "await this.#supersede(", "'rebased'", "this.#proposalUnavailable()"):
        if term not in block:
            errs.append("rebase lacks %s" % term)
    return errs, "R1 and R2 mapped to AT-426..AT-430 and the review 01 page regressions"


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase7d.py" not in verify:
        errs.append("verify.sh must run the Phase 7D validator in the core gate")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase7d") != "python3 docs/engineering/tools/phase7d.py":
        errs.append("package.json lacks validate:phase7d")
    readme = read(P("docs/engineering/README.md"))
    if "0040-change-proposal-protocol.md" not in readme or "phase7d.py" not in readme:
        errs.append("the engineering index must list ADR-0040 and the Phase 7D validator")
    if "ai-proposals" not in read(P("playwright.config.ts")):
        errs.append("the tablet project must run the 7D journey")
    return errs, "verify.sh (and so preflight), package.json, the engineering index, and the tablet project"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P(CLOSURE))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 7D: requirement closure", phase2.check_closure(catalog, closure, subphases, SUBPHASE, DECISIONS)),
        ("phase 7D: open decisions and boundaries", check_boundaries_recorded(closure)),
        ("phase 7D: 7A production safety still holds", phase7a.check_production_safety()),
        ("phase 7D: proposal protocol, adapters, atomic Apply, surfaces", check_protocol()),
        ("phase 7D: migration 0056", check_migration()),
        ("phase 7D: identifiers and tests", check_identifiers()),
        ("phase 7D: corrective review 01 evidence", check_corrections(closure)),
        ("phase 7D: validator wiring", check_wiring()),
        ("phase 7D: migration sequence", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-72s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for error in errs:
            print("    ERROR: " + error)
        failed += bool(errs)
    print("PHASE 7D CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
