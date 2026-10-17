#!/usr/bin/env python3
"""Phase 7A AI gateway, privacy, and budgets closure validator (ADR-0038)."""
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

SUBPHASE = "7A"
DECISIONS = ["D%d" % i for i in range(1, 13)]
ADR = "docs/engineering/adr/0038-ai-gateway-privacy-budgets.md"
CLOSURE = "docs/engineering/phase7/closure-7a.json"
MIGRATION = "packages/db/migrations/0053_ai_gateway"
CORRECTION = "packages/db/migrations/0054_ai_gateway_corrections"
SERVICE = "packages/work/src/ai/ai-gateway-service.ts"
PROVIDER = "packages/work/src/ai/provider.ts"
REGISTRY = "packages/work/src/ai/registry.ts"
POLICY = "packages/work/src/ai/policy.ts"
BUDGET = "packages/work/src/ai/budget.ts"
SERVER = "packages/config/src/server.ts"
TABLES = [
    "ai.ai_provider_config", "ai.brand_ai_profile", "ai.ai_action", "ai.ai_context_ref",
    "ai.ai_dispatch", "ai.ai_output", "metering.spend_limit", "metering.usage_balance",
    "metering.usage_reservation", "metering.usage_event",
]
THREATS = ["T-%d" % i for i in range(91, 99)]
TESTS = ["AT-%d" % i for i in range(354, 390)]
TEST_FILES = [
    "packages/work/test/integration/ai-gateway.test.ts",
    "packages/work/test/integration/ai-budget.test.ts",
    "packages/work/test/integration/ai-corrections.test.ts",
    "apps/api/test/integration/ai-api.test.ts",
    "e2e/ai.spec.ts",
]
BOUNDARIES = ["OD-41", "OD-46", "DQ-28", "OD-36", "DATA-013", "10A"]


def check_boundaries_recorded(closure):
    """Open legal, commercial, and secret-store decisions stay open and recorded, never approved."""
    errs = []
    got = {b["id"] for b in closure.get("boundaries", [])}
    for b in BOUNDARIES:
        if b not in got:
            errs.append("closure must record the %s boundary" % b)
    decisions = read(P("docs/product/open-decisions.md"))
    for od in ("OD-36", "OD-37", "OD-39", "OD-41", "OD-46"):
        section = decisions.split("### %s" % od)[1][:2600] if "### %s" % od in decisions else ""
        if "Status (Phase 7A" not in section:
            errs.append("%s needs its Phase 7A status line" % od)
        if re.search(r"\*\*Decided", section):
            errs.append("%s must stay open (7A approves nothing)" % od)
    adr = read(P(ADR))
    for term in ("OD-41 (legal):** open", "OD-46 (commercial):** open", "DQ-28 (secret store):** open"):
        if term not in adr:
            errs.append("ADR-0038 must state %s" % term)
    return errs, "OD-36/37/39/41/46, DQ-28, DATA-013, and 10A recorded as open boundaries"


def check_production_safety():
    """Production AI is disabled by default and refused when deployed; nothing is assumed."""
    errs = []
    server = read(P(SERVER))
    for term in ("AI_PROVIDER: 'none'", "AI_APPROVED_MODELS: ''", "AI_BYOK_ENABLED: '0'",
                 "the protocol fixture is refused in deployed environments",
                 "production AI needs an approved secret store (DQ-28) and provider data-use approval (OD-41)",
                 "workspace-provided AI keys stay off until OD-46 is approved",
                 "secret references require a secret-store provider (not selected; DQ-28)"):
        if term not in server:
            errs.append("server configuration lacks %r" % term)
    registry = read(P(REGISTRY))
    if re.search(r"(key|modelId): '[^']*latest", registry, re.I):
        errs.append("the registry must not name an implicit latest model")
    if "zeroRetention: true" in registry:
        errs.append("zero retention must never be claimed from a flag")
    for term in ("AI_REGISTRY_VERSION", "maxInputTokensAtPrice", "errorResponsesChargeable", "trainingExclusion"):
        if term not in registry:
            errs.append("registry lacks %s" % term)
    provider = read(P(PROVIDER))
    if "fallbacks" in provider:
        errs.append("the provider must never request server-side model fallbacks (silent substitution)")
    if "res.text()" in provider or "await res.json()" in provider:
        errs.append("error responses must not be read into errors")
    policy = read(P(POLICY))
    if "config.approvedModels.includes(model.key)" not in policy:
        errs.append("real-model dispatch must require explicit approval")
    for pkg in ["package.json", "apps/api/package.json", "apps/web/package.json", "apps/worker/package.json",
                "packages/work/package.json", "packages/config/package.json"]:
        if os.path.isfile(P(pkg)) and re.search(
                r'"(openai|@anthropic-ai/[^"]*|ai|langchain|@langchain/[^"]*|pgvector)"\s*:', read(P(pkg))):
            errs.append("%s adds an AI SDK or vector dependency" % pkg)
    return errs, "disabled by default, deployed refusals, explicit approval, no SDK, no fallbacks"


def check_gateway():
    errs = []
    service = read(P(SERVICE))
    factory = read(P("packages/work/src/factory.ts"))
    if "export class AiGatewayService extends McpAccessService" not in service:
        errs.append("AiGatewayService must extend the 6E McpAccessService head")
    if "return new AiGatewayService(" not in factory:
        errs.append("createWorkService must return AiGatewayService")
    # Provider output is data: the gateway never writes business records.
    for bad in ("insertInto('work.", "updateTable('work.", "deleteFrom('work.", "updateTable('collab.",
                "updateTable('knowledge."):
        if bad in service:
            errs.append("the gateway must not mutate business records (%s)" % bad)
    for term, label in [
        ("async #reauthorize(", "re-authorization before dispatch"),
        ("async #delegationLive(", "live delegation re-check"),
        ("context_unavailable", "identical refusal for hidden and unknown sources"),
        ("redactCredentials(", "outbound redaction"),
        ("await reserve(tx", "reservation before dispatch"),
        ("state: 'unknown', error_kind: 'worker_lost'", "crash-safe dispatch marker"),
        ("new AwaitReconciliationError()", "unknown outcomes park for reconciliation"),
        ("async #renderRun(", "history re-authorization"),
        ("protected override async moduleHistoryRows(", "DATA-013 export through the 6D boundary"),
        ("entitlements.aiAllowed(", "deny-by-default entitlement port"),
    ]:
        if term not in service:
            errs.append("gateway lacks %s" % label)
    budget = read(P(BUDGET))
    for term in ("forUpdate()", "carriedReserved", "state: 'settled'", "noteThresholds"):
        if term not in budget:
            errs.append("budget ledger lacks %s" % term)
    portability = read(P("packages/work/src/portability/portability-service.ts"))
    if "protected async moduleHistoryRows(" not in portability:
        errs.append("the 6D export boundary must offer the module history hook")
    worker = read(P("apps/worker/src/registry.ts"))
    for term in ("aiDispatchHandler(m.ai)", "aiRetentionHandler(m.ai)", "...AI_SCHEDULES"):
        if term not in worker:
            errs.append("worker registry lacks %s" % term)
    readiness = read(P("apps/api/src/readiness.ts"))
    if "ai_provider: deps.aiProvider ?? 'not_configured'" not in readiness:
        errs.append("readiness must report unconfigured AI truthfully")
    if '"ai_provider":"not_configured"' not in read(P("scripts/image-smoke.sh")):
        errs.append("the image smoke must assert truthful AI readiness")
    auth = read(P("apps/api/src/auth/routes.ts"))
    if "'ai:execute'" not in auth or "/ai/settings" not in auth:
        errs.append("bearer callers need ai:execute and must not reach AI settings")
    web = read(P("apps/web/src/ai/ai-pages.tsx"))
    for term in ("Synthetic output", "cancellation_note", "manual_fallback", "I confirm this run may cost up to"):
        if term not in web:
            errs.append("AI pages lack %s" % term)
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    names = {t["name"] for t in registry["telemetry"]}
    for m in ("ai.runs", "ai.dispatches", "ai.policy_refusals", "ai.reservations", "ai.cancellations",
              "ai.tokens", "ai.cost_micros", "ai.history.erased", "ai.request.duration"):
        if m not in names:
            errs.append("telemetry signal %s is not registered" % m)
    return errs, "one gateway, re-authorized dispatch, reservations, crash safety, exports, workers, readiness, UI"


def check_migration():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    if "-- migrate:phase expand" not in up:
        errs.append("0053 must be an expand migration")
    for t in TABLES:
        if "CREATE TABLE %s" % t not in up:
            errs.append("0053 lacks %s" % t)
        if "ALTER TABLE %s FORCE ROW LEVEL SECURITY" % t not in up or "CREATE POLICY tenant_isolation ON %s" % t not in up:
            errs.append("%s needs forced tenant row-level security" % t)
        if "DROP TABLE %s" % t not in down:
            errs.append("0053 down must drop %s" % t)
    for term in ("ai_provider_config_training_excluded CHECK (require_training_exclusion)",
                 "usage_event_not_billed CHECK (NOT billable)",
                 "usage_reservation_dispatch_meter UNIQUE (dispatch_id, meter)",
                 "numeric(20, 6)", "CREATE TRIGGER ai_output_immutable"):
        if term not in up:
            errs.append("0053 lacks %s" % term)
    if re.search(r"GRANT[^;]*(UPDATE|DELETE)[^;]*ON metering\.usage_event", up):
        errs.append("usage events must stay insert-only")
    if "Restores the exact 0052 catalog" not in down:
        errs.append("0053 down must restore the exact 0052 catalog")
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    by = {n.split("_", 1)[0]: n for n in names}
    if by.get("0053") != "0053_ai_gateway.up.sql" or by.get("0054") != "0054_ai_gateway_corrections.up.sql":
        errs.append("0053_ai_gateway and its correction 0054 must keep their numbers")
    # Later migrations belong to later phases, each held by its own validator.
    later_owned = {"0055": ("0055_ai_retrieval_citations.up.sql", "phase7b.py")}
    for k in sorted(k for k in by if k > "0054"):
        name, validator = later_owned.get(k, (None, None))
        if by[k] != name or not os.path.isfile(P("docs/engineering/tools/%s" % validator)):
            errs.append("migration %s after 7A must be held by a later-phase validator" % by[k])
    errs += phase1.check_boundaries([53, 54])
    return errs, "0053 tables, forced RLS, exact rollback, training CHECK, insert-only usage"


def check_correction_migration():
    """0054 (corrective review 01): additive, workspace-scoped scrub, forced RLS restored, exact rollback."""
    errs = []
    up = read(P(CORRECTION + ".up.sql"))
    down = read(P(CORRECTION + ".down.sql"))
    if "-- migrate:phase expand" not in up:
        errs.append("0054 must be an expand migration")
    if re.search(r"\b(DROP TABLE|DROP COLUMN|ALTER COLUMN|RENAME)\b", up):
        errs.append("0054 must be additive")
    for term in ("ADD COLUMN price_snapshot jsonb", "ADD COLUMN capability_snapshot jsonb",
                 "ADD COLUMN bound_breach boolean NOT NULL DEFAULT false",
                 "ADD COLUMN clipped_locally boolean NOT NULL DEFAULT false", "ADD COLUMN failure_detail text",
                 "ADD COLUMN dispatch_suspended_reason text",
                 "CREATE FUNCTION ai.scrub_dispatch_checkpoints(p_operation_ids uuid[])",
                 "LANGUAGE plpgsql SECURITY DEFINER", "SET search_path = pg_catalog, pg_temp",
                 "j.workspace_id = exec.current_workspace_id()",
                 "REVOKE ALL ON FUNCTION ai.scrub_dispatch_checkpoints(uuid[]) FROM PUBLIC"):
        if term not in up:
            errs.append("0054 lacks %s" % term)
    lift = up.find("ALTER TABLE exec.job NO FORCE ROW LEVEL SECURITY;")
    restore = up.find("ALTER TABLE exec.job FORCE ROW LEVEL SECURITY;")
    if lift < 0 or restore < lift:
        errs.append("0054 must lift forced RLS on exec.job only around its one cleanup statement and restore it")
    if "Restores the exact 0053 catalog" not in down or "DROP FUNCTION ai.scrub_dispatch_checkpoints" not in down:
        errs.append("0054 down must restore the exact 0053 catalog")
    return errs, "additive 0054, scoped definer scrub, RLS restored, exact rollback"


def check_corrections(closure):
    """Corrective review 01: each finding group maps to executable tests that exist and title once."""
    errs = []
    reviews = {r["id"]: r for r in closure.get("corrective_reviews", [])}
    review = reviews.get("7A-CR-01")
    if not review:
        return ["closure must record corrective review 7A-CR-01"], ""
    groups = {g["id"]: g for g in review.get("groups", [])}
    if sorted(groups) != ["1", "2", "3"]:
        errs.append("7A-CR-01 must record finding groups 1, 2, and 3")
    cache = {}
    threats = load(P("docs/architecture/access/policy/threats.json"))
    registered = {x["id"]: x for x in threats["tests"]}
    text = "\n".join(read(P(f)) for f in TEST_FILES)
    for gid, g in sorted(groups.items()):
        phase2.check_evidence("7A-CR-01 group %s" % gid, g.get("evidence"), cache, errs)
        if not g.get("tests"):
            errs.append("7A-CR-01 group %s names no acceptance test" % gid)
        for at in g.get("tests", []):
            if at not in registered:
                errs.append("group %s test %s is not registered in 0C" % (gid, at))
            if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
                errs.append("group %s test %s must title exactly one test" % (gid, at))
    for at in ("AT-%d" % i for i in range(382, 390)):
        if at in registered and not set(registered[at]["threats"]) & {"T-96", "T-97", "T-98"}:
            errs.append("%s must cover a corrective threat (T-96..T-98)" % at)
    unit = read(P("packages/work/test/unit/ai-provider-stream.test.ts"))
    for case in ("reproduced defect 1", "reproduced defect 2", "oversized or unterminated", "CRLF",
                 "fractional, unsafe, and negative", "unsupported stop reason", "missing final usage",
                 "cancellation and timeout"):
        if case not in unit:
            errs.append("the provider stream contract lacks the %r case" % case)
    follow = {f["id"]: f for f in closure.get("follow_ups", [])}
    if "REL-FU-7A-01" not in follow:
        errs.append("the effect-ledger reliability follow-up REL-FU-7A-01 must be tracked")
    else:
        phase2.check_evidence("REL-FU-7A-01", follow["REL-FU-7A-01"].get("evidence"), cache, errs)
    prj = next((r for r in closure["requirements"] if r["id"] == "PRJ-007"), None)
    if not prj or "enforced through" in prj.get("note", "") or "not enforced" not in prj.get("note", ""):
        errs.append("PRJ-007 must state honestly that 7A does not enforce project AI budgets")
    adr = read(P(ADR))
    if "## Corrective review 01" not in adr or "The future contract a project-scoped AI caller must meet" not in adr:
        errs.append("ADR-0038 must record corrective review 01 and the future project-scope contract")
    return errs, "groups 1-3 mapped to AT-363, AT-382..AT-389, migration and stream contract tests; REL-FU-7A-01; PRJ-007"


def check_identifiers():
    errs = []
    if not os.path.isfile(P(ADR)):
        errs.append("ADR-0038 missing")
    for path, anchor in (("docs/architecture/data/12-decisions.md", "adr-44"),
                         ("docs/architecture/data/12-decisions.md", "adr-45"),
                         ("docs/architecture/access/15-decisions.md", "az-44"),
                         ("docs/architecture/access/15-decisions.md", "az-45"),
                         ("docs/architecture/platform/19-decisions.md", "pl-46"),
                         ("docs/architecture/platform/19-decisions.md", "pl-47")):
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
            errs.append("%s must cover a 7A threat" % at)
        if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
            errs.append("%s must title exactly one test" % at)
    model = {e["name"] for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    if "ai_dispatch" not in model:
        errs.append("0B model lacks ai_dispatch")
    return errs, "ADR-0038, ADR-44/45, AZ-44/45, PL-46/47, T-91..T-98, AT-354..AT-389"


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase7a.py" not in verify:
        errs.append("verify.sh must run the Phase 7A validator in the core gate")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase7a") != "python3 docs/engineering/tools/phase7a.py":
        errs.append("package.json lacks validate:phase7a")
    readme = read(P("docs/engineering/README.md"))
    if "0038-ai-gateway-privacy-budgets.md" not in readme or "phase7a.py" not in readme:
        errs.append("the engineering index must list ADR-0038 and the Phase 7A validator")
    return errs, "verify.sh, package.json, and the engineering index"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P(CLOSURE))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 7A: requirement closure", phase2.check_closure(catalog, closure, subphases, SUBPHASE, DECISIONS)),
        ("phase 7A: open decisions and boundaries", check_boundaries_recorded(closure)),
        ("phase 7A: production safety", check_production_safety()),
        ("phase 7A: gateway, budgets, and surfaces", check_gateway()),
        ("phase 7A: migration 0053", check_migration()),
        ("phase 7A: correction migration 0054", check_correction_migration()),
        ("phase 7A: corrective review 01 evidence", check_corrections(closure)),
        ("phase 7A: identifiers and tests", check_identifiers()),
        ("phase 7A: validator wiring", check_wiring()),
        ("phase 7A: migration sequence", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-72s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for error in errs:
            print("    ERROR: " + error)
        failed += bool(errs)
    print("PHASE 7A CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
