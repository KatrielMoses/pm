#!/usr/bin/env python3
"""Phase 7F AI-assisted planning and capture closure validator (ADR-0043)."""
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

SUBPHASE = "7F"
DECISIONS = ["D%d" % i for i in range(1, 11)]
ADR = "docs/engineering/adr/0043-planning-capture.md"
CLOSURE = "docs/engineering/phase7/closure-7f.json"
MIGRATION = "packages/db/migrations/0059_planning_capture"
SERVICE = "packages/work/src/ai/ai-gateway-service.ts"
PLANNER = "packages/work/src/planning/planner.ts"
INTERPRET = "packages/work/src/capture/interpret.ts"
CONTRACT = "packages/work/src/ai/actions/interpretation.ts"
TRANSCRIPTION = "packages/work/src/ai/transcription.ts"
ASSIST = "apps/web/src/capture/capture-assist.tsx"
PLAN_PAGE = "apps/web/src/pages/plan-pages.tsx"
THREATS = ["T-%d" % i for i in range(124, 136)]
TESTS = ["AT-%d" % i for i in range(481, 524)]
TEST_FILES = [
    "packages/work/test/integration/day-plans.test.ts",
    "packages/work/test/integration/capture-interpretation.test.ts",
    "packages/work/test/integration/capture-voice.test.ts",
    "apps/api/test/integration/planning-capture-api.test.ts",
    "e2e/planning-capture.spec.ts",
    "packages/work/test/integration/day-plans-review01.test.ts",
    "packages/work/test/integration/capture-voice-review01.test.ts",
]
MATRIX = ["CAP-005", "PLAN-010", "PLAN-011", "PLAN-012", "PLAN-013", "AI-021", "CAP-003", "CAP-009", "PLAN-017",
          "TEST-003", "TIME-016"]
BOUNDARIES = ["DQ-28", "OD-31", "OD-41", "OD-46", "PRJ-007", "DOC-019", "REL-FU-7A-01", "9B", "8A", "MANUAL"]


def block(service, start_marker, end_marker):
    start = service.find(start_marker)
    end = service.find(end_marker, start + 1) if start >= 0 else -1
    return service[start:end] if 0 <= start < end else ""


def check_boundaries_recorded(closure):
    errs = []
    got = {b["id"] for b in closure.get("boundaries", [])}
    for b in BOUNDARIES:
        if b not in got:
            errs.append("closure must record the %s boundary" % b)
    adr = read(P(ADR))
    for term in ("**DQ-28, OD-31, OD-41, OD-46", "**PRJ-007:**", "**DOC-019:**", "**REL-FU-7A-01:** still tracked",
                 "**9B:**", "**8A, 8C, 12A:**", "## Requirement and section matrix", "Real-device and live-provider"):
        if term not in adr:
            errs.append("ADR-0043 must state %s" % term)
    for r in MATRIX:
        if "\n| %s |" % r not in adr:
            errs.append("the requirement matrix must list %s" % r)
    return errs, "boundaries recorded and the requirement matrix present"


def check_planning():
    """A deterministic planner; plans only through 7D proposals with locked inputs and a snapshot."""
    errs = []
    planner = read(P(PLANNER))
    for term in ("export function rankTasks(", "export function planDay(", "export function checkEdits(",
                 "'missing_estimate'", "'over_capacity'", "locked_does_not_fit", "tradeoff"):
        if term not in planner:
            errs.append("the planner lacks %s" % term)
    if re.search(r"from '\.\./ai/|\bfetch\(|\.complete\(|\.stream\(", planner):
        errs.append("the planner must be deterministic (no provider, no I/O)")
    service = read(P(SERVICE))
    plan = block(service, "// 7F daily plans (ADR-0043)", "// 7F capture interpretation")
    if not plan:
        errs.append("the gateway lacks the 7F daily-plan block")
    for term, label in [
        ("kind: 'plan_proposal',", "the plan_proposal operation"),
        ("origin: 'planner',", "planner-origin proposals"),
        ("await storeEvidence(tx, { proposalId: id }, ev.rows);", "the stored plan evidence"),
        ("if (ev.missing || ev.rows.length > BASIS_MAX)", "a whole basis or a refusal"),
        ("await lock(`capacity.profile:${p.membershipId}`);", "the capacity lock first"),
        ("await this.lockDay(tx, p.membershipId, day);", "the day lock"),
        ("await this.lockBlocks(tx, p.membershipId);", "the block-planning lock"),
        ("FOR SHARE", "candidate tasks locked for share"),
        ("'plan_changed',", "stale refusal"),
        ("if (caller.delegation) throw new TenancyError('forbidden');", "delegated callers refused"),
    ]:
        if term not in plan:
            errs.append("the plan block lacks %s" % label)
    proposals = service[service.find("// 7D change proposals"):] if "// 7D change proposals" in service else ""
    for term, label in [
        ("if (PLAN_OPS_SET.has(c.op) !== (proposal.origin === 'planner'))", "planning operations only in plans"),
        ("await this.commitIn(tx, caller, p, f.day!, ref(payload.task), 'plan');", "commitments through commitIn"),
        ("const blk = await this.createBlockIn(tx, caller, p, {", "blocks through createBlockIn"),
        ("await this.moveBlockIn(", "moves through moveBlockIn"),
        ("await this.deleteBlockIn(", "removals through deleteBlockIn"),
        ("this.#requirePlanCurrent(await this.#planCurrent(tx, p, proposal, changes, true));", "approval and Apply re-check the day"),
        ("snapshot: cur.inputs.snapshot,", "an explicit rebase of the snapshot"),
        ("a.planner ? { kind: 'ui', ref: a.proposal } : { kind: 'ai_proposal', ref: a.proposal },", "planner changes are the person's own"),
    ]:
        if term not in proposals:
            errs.append("the proposal protocol lacks %s" % label)
    today = read(P("packages/work/src/planning/today-service.ts"))
    for term in ("protected async createBlockIn(", "protected async moveBlockIn(", "protected async deleteBlockIn(",
                 "protected async commitIn(", "protected async uncommitIn(", "protected async lockBlocks("):
        if term not in today:
            errs.append("3C lacks the canonical command %s" % term)
    capacity = read(P("packages/work/src/capacity/capacity-service.ts"))
    if capacity.count("capacity.profile:${p.membershipId}") < 4 or capacity.count("capacity.holidays:${br.id}") < 2:
        errs.append("capacity writers must take the plan input locks")
    if "protected async planInputsIn(" not in capacity:
        errs.append("capacity lacks planInputsIn")
    if "erasePlanProposals" not in read(P("packages/work/src/ai/lifecycle.ts")):
        errs.append("erasure must reach planner proposals")
    if "discoverPlanRetentionWork" not in read(P("packages/work/src/ai/jobs.ts")):
        errs.append("retention must discover planner proposals")
    return errs, "deterministic planner, locked inputs, snapshot, canonical commands, evidence, erasure"


def check_capture():
    """Interpretation is spans checked by the server; voice is ephemeral audio through the gateway."""
    errs = []
    contract = read(P(CONTRACT))
    for term in ("export function validateInterpretation(", "const at = locate(input.capture, span, taken);",
                 "reason: 'unsupported_output'", "reason: input.completeness === 'truncated' ? 'truncated_response' : 'partial_response',"):
        if term not in contract:
            errs.append("the interpretation contract lacks %s" % term)
    derive = read(P(INTERPRET))
    if "export function deriveSpan(" not in derive or "status: 'unknown'" not in derive:
        errs.append("values must be derived by deterministic rules and unknown kept unknown")
    catalog = read(P("packages/work/src/ai/actions/catalog.ts"))
    if "key: 'interpret_capture'," not in catalog or "kind: 'interpretation'," not in catalog:
        errs.append("interpret_capture must be a registered action")
    service = read(P(SERVICE))
    interp = block(service, "// 7F capture interpretation", "// 7F voice capture")
    for term, label in [
        ("if (captureTextOf(a.prompt_text) !== redactCredentials(text.trim()).text)", "the text binding"),
        ("const resolved = names.length ? await this.resolve(tx, p, names, brandHint) : [];", "authorized name lookup"),
        ("const d = deriveSpan(f.field, f.span, today, this.ws.captureParseTokensMax);", "server-derived values"),
        ("if (a.action_key !== INTERPRET_ACTION) throw new TenancyError('not_found');", "the action check"),
    ]:
        if term not in interp:
            errs.append("interpretation lacks %s" % label)
    voice = block(service, "// 7F voice capture", "// 7E briefings and reviews (ADR-0042)")
    for term, label in [
        ("this.#requireTranscription();", "refusal before storing when unconfigured"),
        ("const audio = checkAudio(bytes, v.format as VoiceFormat, c.maxSeconds);", "container validation"),
        ("sha256Hex(bytes) !== v.content_sha256", "the checksum binding"),
        ("purpose: 'transcription',", "transcription as an AI action"),
        ("const reserved = await reserve(tx, {", "a reservation before sending"),
        ("throw new AwaitReconciliationError();", "no resend after a possible charge"),
        ("await this.#discardAudio(tx, v);", "audio discarded"),
        ("const text = redactCredentials(", "redacted transcripts"),
        ("if (open.n >= c.queueMax)", "the queue bound"),
        ("if (caller.delegation || p.kind !== 'member') throw new TenancyError('forbidden');", "people only"),
    ]:
        if term not in voice:
            errs.append("voice lacks %s" % label)
    tr = read(P(TRANSCRIPTION))
    for term in ("export interface TranscriptionProvider", "export class HttpTranscriptionProvider",
                 "synthetic: true,", "export function checkAudio("):
        if term not in tr:
            errs.append("the transcription module lacks %s" % term)
    config = read(P("packages/config/src/server.ts"))
    if "TRANSCRIPTION_PROVIDER: the transcription fixture is refused in deployed environments" not in config:
        errs.append("deployed environments must refuse the transcription fixture")
    worker = read(P("apps/worker/src/registry.ts"))
    for h in ("aiTranscriptionHandler(m.ai)", "voiceCleanupHandler(m.ai)"):
        if h not in worker:
            errs.append("the worker must register %s" % h)
    auth = read(P("apps/api/src/auth/routes.ts"))
    for r in ("path.includes('/planning/day-plan')", "path.includes('/capture/voice')", "path.includes('/capture/interpretations')"):
        if r not in auth:
            errs.append("bearer callers must be refused (%s)" % r)
    assist = read(P(ASSIST))
    if re.search(r"dangerouslySetInnerHTML|innerHTML|SpeechRecognition", assist):
        errs.append("%s must not render markup or use browser speech recognition" % ASSIST)
    for term in ("Confirm and interpret", "Record a note", "Microphone access was denied", "Cancel recording",
                 "Transcript (edit before using)", "Use as capture text"):
        if term not in assist:
            errs.append("capture assistance lacks %r" % term)
    page = read(P(PLAN_PAGE))
    for term in ("Create plan proposal", "Missing estimates", "Postponement suggestions", "You're offline"):
        if term not in page:
            errs.append("the plan page lacks %r" % term)
    drafts = read(P("apps/web/src/shell/drafts.ts"))
    if "'.ai-capture.'" not in drafts or "'.ai-plan.'" not in drafts:
        errs.append("sign-out and session cleanup must remove capture and plan drafts")
    return errs, "checked spans, server values, ephemeral audio, gateway transcription, session-only routes"


def check_migration():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    if "-- migrate:phase expand" not in up:
        errs.append("0059 must be an expand migration")
    for term in ("CREATE TABLE capture.voice_capture (", "ALTER TABLE capture.voice_capture FORCE ROW LEVEL SECURITY;",
                 "CREATE FUNCTION exec_dispatch.discover_voice_cleanup_work(",
                 "CREATE FUNCTION exec_dispatch.discover_plan_retention_work(", "change_proposal_origin_guard",
                 "'block.create', 'block.update', 'block.delete'", "'transcription'",
                 "CONSTRAINT voice_capture_ephemeral CHECK (discarded_at IS NULL OR storage_key IS NULL)",
                 "GRANT USAGE ON SCHEMA capture TO pm_scheduler;"):
        if term not in up:
            errs.append("0059 lacks %s" % term)
    if re.search(r"GRANT[^;]*DELETE[^;]*capture\.voice_capture", up):
        errs.append("no role may delete voice captures")
    for term in ("Restores the exact 0058 catalog", "0059 cannot be rolled back", "DROP TABLE capture.voice_capture;",
                 "REVOKE USAGE ON SCHEMA capture FROM pm_scheduler;"):
        if term not in down:
            errs.append("0059 down lacks %s" % term)
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    # The Phase 7 integration review adds 0060, held by the aggregate validator (phase7.py).
    later = [n for n in names if n > "0059_planning_capture.up.sql"]
    if later and (later != ["0060_phase7_integration.up.sql"] or not os.path.isfile(P("docs/engineering/tools/phase7.py"))):
        errs.append("0059_planning_capture must be the last migration before the Phase 7 integration (0060)")
    errs += phase1.check_boundaries([59])
    return errs, "expand 0059, forced RLS, two discovery functions, origin guard, exact rollback with guard, boundary 59"


def check_identifiers():
    errs = []
    if not os.path.isfile(P(ADR)):
        errs.append("ADR-0043 missing")
    for path, anchor in (("docs/architecture/data/12-decisions.md", "adr-50"),
                         ("docs/architecture/access/15-decisions.md", "az-50"),
                         ("docs/architecture/platform/19-decisions.md", "pl-52"),
                         ("docs/ux/09-decisions-and-risks.md", "uxd-31")):
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
            errs.append("%s must cover a 7F threat" % at)
        if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
            errs.append("%s must title exactly one test" % at)
    model = {e["name"]: e for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    for name in ("voice_capture", "change_proposal", "briefing_evidence"):
        if name not in model:
            errs.append("0B lacks %s" % name)
        elif "Phase 7F" not in model[name].get("notes", ""):
            errs.append("0B %s must record its Phase 7F reconciliation" % name)
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    if "vcp" not in {p["prefix"] for p in registry["id_prefixes"]}:
        errs.append("ID prefix vcp is not registered")
    telemetry = {x["name"] for x in registry["telemetry"]}
    for name in ("planning.plans", "capture.voice", "capture.interpretations"):
        if name not in telemetry:
            errs.append("telemetry signal %s is not registered" % name)
    params = {x["name"] for x in registry["parameters"]}
    for name in ("TRANSCRIPTION_PROVIDER", "VOICE_MAX_SECONDS", "VOICE_MAX_BYTES", "VOICE_FORMATS", "VOICE_QUEUE_MAX"):
        if name not in params:
            errs.append("parameter %s is not registered" % name)
    unit = read(P("packages/work/test/unit/planner.test.ts")) + read(P("packages/work/test/unit/capture-interpretation.test.ts"))
    for case in ("works in real instants across daylight saving", "accepts only exact spans of the capture text",
                 "classifies failures by whether they can have been charged"):
        if case not in unit:
            errs.append("the 7F unit tests lack %r" % case)
    return errs, "ADR-0043, ADR-50, AZ-50, PL-52, UXD-31, T-124..T-135, AT-481..AT-523"


def check_corrections(closure):
    """Corrective review 01: R1 and R2 mapped to runtime tests, real code paths, and old-code results."""
    errs = []
    review = {r["id"]: r for r in closure.get("corrective_reviews", [])}.get("7F-CR-01")
    if not review:
        return ["closure must record corrective review 7F-CR-01"], ""
    groups = {g["id"]: g for g in review.get("groups", [])}
    if sorted(groups) != ["R1", "R2", "V1"]:
        errs.append("7F-CR-01 must record R1, R2, and the V1 verification repair")
    cache = {}
    tests = {x["id"] for x in load(P("docs/architecture/access/policy/threats.json"))["tests"]}
    text = "\n".join(read(P(f)) for f in TEST_FILES)
    for gid, g in sorted(groups.items()):
        phase2.check_evidence("7F-CR-01 %s" % gid, g.get("evidence"), cache, errs)
        if "fail" not in g.get("old_code", ""):
            errs.append("7F-CR-01 %s must record its old-code regression result" % gid)
        for at in g.get("tests", []):
            if at not in tests:
                errs.append("%s test %s is not registered in 0C" % (gid, at))
            if len(re.findall(r"(?:it|test)\(\s*['\"]%s " % at, text)) != 1:
                errs.append("%s test %s must title exactly one test" % (gid, at))
    up = read(P(MIGRATION + ".up.sql"))
    for table in ("integrations.calendar_event", "integrations.calendar_source", "integrations.connection",
                  "planning.capacity_reservation", "planning.capacity_profile", "planning.availability_rule",
                  "planning.time_off", "planning.work_block", "planning.today_commitment"):
        if not re.search(r"CREATE TRIGGER plan_constraint_guard[^;]*ON %s\b" % re.escape(table), up):
            errs.append("0059 must guard %s with the plan-constraint trigger" % table)
    service = read(P(SERVICE))
    i = service.find("async #lockPlanInputs(")
    body = service[i:i + 2500] if i >= 0 else ""
    first = body.find("await lockPlanConstraints(tx, p.membershipId);")
    if first < 0 or first > body.find("capacity.profile:"):
        errs.append("plan Apply must take the constraint lock before every other plan input lock")
    if "pg_advisory_xact_lock_shared" not in body:
        errs.append("plan Apply must hold the dependency lock shared")
    tr = read(P(TRANSCRIPTION))
    if "await res.text()" in tr or ".slice(0, req.maxChars)" in tr:
        errs.append("the transcription transport must not buffer unboundedly or clip transcripts")
    for term in ("reader.cancel()", "new TextDecoder('utf-8', { fatal: true })", "Number.isSafeInteger(body.duration_ms)"):
        if term not in tr:
            errs.append("the transcription transport lacks %s" % term)
    if "if (failure instanceof TranscriptTooLongError) {" not in service:
        errs.append("an over-long transcript must settle its measured liability and store nothing")
    if "date_trunc('day', now())" in read(P("packages/work/test/integration/briefings-review02.test.ts")):
        errs.append("AT-476 must not depend on the database session's local midnight")
    return errs, "R1, R2, and V1 mapped to AT-515..AT-523 and the transport contract, with old-code results"


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase7f.py" not in verify:
        errs.append("verify.sh must run the Phase 7F validator in the core gate")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase7f") != "python3 docs/engineering/tools/phase7f.py":
        errs.append("package.json lacks validate:phase7f")
    readme = read(P("docs/engineering/README.md"))
    if "0043-planning-capture.md" not in readme or "phase7f.py" not in readme:
        errs.append("the engineering index must list ADR-0043 and the Phase 7F validator")
    if "planning-capture" not in read(P("playwright.config.ts")):
        errs.append("the tablet project must run the 7F journeys")
    db_doc = read(P("docs/engineering/database.md"))
    for heading in ("## Workspace purge order", "## Phase 7E: briefings and reviews", "## Phase 7F: planning and capture"):
        if heading not in db_doc:
            errs.append("docs/engineering/database.md lacks %r (it must stay complete)" % heading)
    return errs, "verify.sh (and so preflight), package.json, the engineering index, the tablet project, the database notes"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P(CLOSURE))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 7F: requirement closure", phase2.check_closure(catalog, closure, subphases, SUBPHASE, DECISIONS)),
        ("phase 7F: open decisions, boundaries, and the requirement matrix", check_boundaries_recorded(closure)),
        ("phase 7F: 7A production safety still holds", phase7a.check_production_safety()),
        ("phase 7F: daily plans through change proposals", check_planning()),
        ("phase 7F: interpretation and voice capture", check_capture()),
        ("phase 7F: migration 0059", check_migration()),
        ("phase 7F: identifiers and tests", check_identifiers()),
        ("phase 7F: corrective review 01 evidence", check_corrections(closure)),
        ("phase 7F: validator wiring", check_wiring()),
        ("phase 7F: migration sequence", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-72s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for error in errs:
            print("    ERROR: " + error)
        failed += bool(errs)
    print("PHASE 7F CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
