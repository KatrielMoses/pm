#!/usr/bin/env python3
"""Phase 7 aggregate closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase7.py      # exit 1 on any failure

Phase 7 integration review (docs/engineering/phase7/closure-7.json, ADR-0044): 7A (gateway), 7B
(retrieval), 7D (proposals), 7C (actions), 7E (briefings), and 7F (planning and capture) were built
as a stack and accepted one at a time. This validator proves the integrated product stays
reconciled:
  - every Phase 0-7F validator passes;
  - migrations 0053-0060, engineering ADRs 0038-0044, threats and tests have one owner each and stay
    contiguous; every Phase 7 test id titles exactly one real test;
  - the one gateway composes: factory, routes, worker handlers and schedules, ownership hook and
    personal-data eraser, one provider path, session-only person surfaces;
  - each requirement a Phase 7 subphase owns (derived from the catalog, never a hard-coded total)
    is closed exactly once by its owner; contributions are distinct; every later-phase boundary
    cites its actual destination; recorded open decisions stay open;
  - every prior corrective-review group still resolves to running code and registered tests;
  - the integration corrections cite code, tests, and old-code results, and the exit records exist.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

SUBPHASES = ["7A", "7B", "7D", "7C", "7E", "7F"]
VALIDATORS = ["docs/architecture/tools/phase0.py"] + [
    "docs/engineering/tools/%s.py" % n for n in
    ["phase1", "phase2", "phase3", "phase3b", "phase3c", "phase3d", "phase3e", "phase4a", "phase4b",
     "phase4c", "phase4d", "phase4e", "phase5a", "phase5b", "phase5c", "phase5d", "phase5",
     "phase6a", "phase6b", "phase6c", "phase6d", "phase6e", "phase6",
     "phase7a", "phase7b", "phase7d", "phase7c", "phase7e", "phase7f"]]
MIGRATIONS = {
    "0053": "0053_ai_gateway", "0054": "0054_ai_gateway_corrections",
    "0055": "0055_ai_retrieval_citations", "0056": "0056_ai_change_proposals",
    "0057": "0057_ai_drafting_analysis", "0058": "0058_ai_briefings",
    "0059": "0059_planning_capture", "0060": "0060_phase7_integration",
}
ADRS = {"0038": ("ai-gateway-privacy-budgets", "7A"), "0039": ("authorized-retrieval-citations", "7B"),
        "0040": ("change-proposal-protocol", "7D"), "0041": ("ai-drafting-analysis", "7C"),
        "0042": ("briefings-reviews", "7E"), "0043": ("planning-capture", "7F")}
ADR = "docs/engineering/adr/0044-phase-7-integration.md"
CLOSURE = "docs/engineering/phase7/closure-7.json"
SERVICE = "packages/work/src/ai/ai-gateway-service.ts"
FIRST_PHASE7_TEST, NEW_THREATS, NEW_TESTS = 354, (136, 138), (524, 538)
TEST_DIRS = ["packages", "apps", "e2e"]
# Person-only surfaces refuse delegated callers in the service (ADR-0044 I1).
SESSION_ONLY = ["previewBriefing", "generateBriefing", "regenerateBriefing", "getBriefing", "listBriefings",
                "listBriefingSchedules", "createBriefingSchedule", "updateBriefingSchedule",
                "proposeBriefingCorrection", "updateBriefingCorrection", "decideBriefingCorrection",
                "listBriefingCorrections", "listAiProposals", "getAiProposal", "updateAiProposal",
                "validateAiProposal", "approveAiProposal", "applyAiProposal", "rebaseAiProposal",
                "rejectAiProposal", "voiceSettings"]
OPEN_DECISIONS = ["OD-25", "OD-31", "OD-36", "OD-41", "OD-46"]
REQUIRED_BOUNDARIES = ["DQ-28", "OD-31", "OD-41", "OD-46", "OD-25", "OD-16", "OD-36", "PRJ-007", "10A",
                       "DOC-019", "BRF-010", "9D", "REL-FU-7A-01", "ACCOUNT-DELETION", "MANUAL"]
CODE = (".ts", ".tsx", ".sql", ".py", ".mjs")


def phase_of(subphase):
    return int(re.match(r"\d+", subphase).group())


def evidence_ok(e):
    path = P(e["file"])
    return os.path.isfile(path) and e["contains"] in read(path)


def test_titles():
    """Every `it('AT-…` / `test('AT-…` title in the repository's test files."""
    seen = {}
    for base in TEST_DIRS:
        for dirpath, dirs, files in os.walk(P(base)):
            dirs[:] = [d for d in dirs if d not in ("node_modules", "dist")]
            for f in files:
                if not re.search(r"\.(test|spec)\.tsx?$", f):
                    continue
                path = os.path.join(dirpath, f)
                for m in re.finditer(r"\b(?:it|test)\(\s*['\"`](AT-\d{3})\b", read(path)):
                    seen.setdefault(m.group(1), []).append(os.path.relpath(path, P(".")))
    return seen


def method_body(service, name):
    i = service.find("\n  async %s(" % name)
    if i < 0:
        return ""
    j = service.find("\n  async ", i + 1)
    return service[i:j if j > 0 else len(service)]


def check_validators():
    errs = []
    for v in VALIDATORS:
        r = subprocess.run([sys.executable, P(v)], capture_output=True, text=True)
        if r.returncode != 0:
            tail = [l.strip() for l in r.stdout.splitlines() if "FAIL" in l or "ERROR" in l][:3]
            errs.append("%s fails: %s" % (v, "; ".join(tail) or "exit %d" % r.returncode))
    return errs, "%d validators" % len(VALIDATORS)


def check_numbering(closure):
    errs = []
    names = sorted(os.listdir(P("packages/db/migrations")))
    by = {n.split("_", 1)[0]: n for n in names if n.endswith(".up.sql")}
    for num, name in MIGRATIONS.items():
        if by.get(num) != name + ".up.sql":
            errs.append("migration %s must be %s" % (num, name))
    if max(by) != "0060":
        errs.append("0060_phase7_integration must be the last migration")
    down = read(P("packages/db/migrations/0060_phase7_integration.down.sql"))
    up = read(P("packages/db/migrations/0060_phase7_integration.up.sql"))
    if "Restores the exact 0059 catalog" not in down or "FORCE ROW LEVEL SECURITY" not in down:
        errs.append("0060 down must restore the exact 0059 catalog under forced RLS")
    if re.search(r"\b(DROP TABLE|GRANT|REVOKE|DISABLE ROW LEVEL)\b", up):
        errs.append("0060 may only relax voice_capture_saved")
    errs += phase1.check_migrations()[0]
    errs += phase1.check_boundaries(list(range(52, 61)))
    adrs = os.listdir(P("docs/engineering/adr"))
    for num, (slug, sub) in list(ADRS.items()) + [("0044", ("phase-7-integration", None))]:
        if "%s-%s.md" % (num, slug) not in adrs:
            errs.append("ADR-%s-%s missing" % (num, slug))
        if len([a for a in adrs if a.startswith(num + "-")]) != 1:
            errs.append("ADR number %s must have exactly one file" % num)
    # Subphase engineering scope is accepted at its recorded head and run; the exit gate is not
    # self-accepted, and nothing claims production approval.
    for num, (slug, sub) in ADRS.items():
        text = read(P("docs/engineering/adr/%s-%s.md" % (num, slug)))
        acc = closure.get("accepted", {}).get(sub, {})
        status = re.search(r"^Status: .*$", text, re.M)
        line = status.group(0) if status else ""
        if not line.startswith("Status: **accepted** (engineering scope only"):
            errs.append("ADR-%s must record the architect's acceptance of the %s engineering scope" % (num, sub))
        if acc.get("head", "")[:7] not in line or acc.get("ci_run", "-") not in line:
            errs.append("ADR-%s status must cite the accepted head and CI run of %s" % (num, sub))
        if "Production use is not approved" not in line or "ADR-0044" not in line:
            errs.append("ADR-%s status must keep production unapproved and the exit gate pending" % num)
    adr = read(P(ADR))
    if not re.search(r"^Status: \*\*proposed\*\*", adr, re.M):
        errs.append("ADR-0044 stays proposed until the architect reviews the exit gate")
    t = load(P("docs/architecture/access/policy/threats.json"))
    tids = [x["id"] for x in t["threats"]]
    aids = [x["id"] for x in t["tests"]]
    for ids, prefix in ((tids, "T-"), (aids, "AT-")):
        nums = [int(i[len(prefix):]) for i in ids]
        if nums != list(range(1, len(nums) + 1)):
            errs.append("%s identifiers must be contiguous from 1" % prefix)
    for n in range(NEW_THREATS[0], NEW_THREATS[1] + 1):
        if "T-%d" % n not in tids:
            errs.append("T-%d is not registered" % n)
    known = set(tids)
    titles = test_titles()
    for x in t["tests"]:
        n = int(x["id"][3:])
        for th in x["threats"]:
            if th not in known:
                errs.append("%s names unknown threat %s" % (x["id"], th))
        if n >= FIRST_PHASE7_TEST and len(titles.get(x["id"], [])) != 1:
            errs.append("%s must title exactly one test (found %d)" % (x["id"], len(titles.get(x["id"], []))))
    for n in range(NEW_TESTS[0], NEW_TESTS[1] + 1):
        at = "AT-%d" % n
        if at not in aids:
            errs.append("%s is not registered" % at)
        elif "| %s |" % at not in adr:
            errs.append("ADR-0044 must list %s" % at)
    return errs, "migrations 0053-0060, ADR-0038..0044, T-1..T-%s, AT-1..%s, AT-%d+ titled once" % (
        tids[-1][2:], aids[-1][3:], FIRST_PHASE7_TEST)


def check_composition():
    errs = []
    factory = read(P("packages/work/src/factory.ts"))
    service = read(P(SERVICE))
    for needle, label in (("return new AiGatewayService(", "the factory returns the gateway"),
                          (".register(aiHistoryOwnerHook)", "the AI departure hook is registered")):
        if needle not in factory:
            errs.append("%s (%s)" % (label, needle))
    if "export class AiGatewayService extends McpAccessService" not in service:
        errs.append("the gateway must extend the Phase 6 head")
    # One gateway: no later class, no second provider or transcriber construction, one call each.
    for dirpath, dirs, files in os.walk(P("packages/work/src")):
        for f in files:
            path = os.path.join(dirpath, f)
            text = read(path)
            rel = os.path.relpath(path, P("."))
            if re.search(r"extends AiGatewayService\b", text):
                errs.append("%s adds a parallel gateway class" % rel)
            if rel != "packages/work/src/factory.ts" and re.search(
                    r"new (MessagesProvider|HttpTranscriptionProvider)\(", text):
                errs.append("%s constructs a provider outside the factory" % rel)
    if service.count("provider.complete(") != 1 or service.count(".transcribe(") != 1:
        errs.append("the gateway must reach the provider and the transcriber through one call each")
    for name in SESSION_ONLY:
        body = method_body(service, name)
        head = body[:body.find("return") if "return" in body else 400]
        if "this.#sessionOnly(caller);" not in head:
            errs.append("%s must refuse delegated callers first (ADR-0044 I1)" % name)
    if "const PLAN_OPS_SET: ReadonlySet<string> = new Set(PLAN_OPS);" not in service:
        errs.append("the gateway must derive planning operations from the proposal contract")
    lifecycle = read(P("packages/work/src/ai/lifecycle.ts"))
    if lifecycle.count("await endVoiceCaptures(tx,") < 2 or "await endVoiceCaptures(tx, filter.membershipId)" not in service:
        errs.append("departure, account erasure, and the service eraser must all end recordings")
    if "await purgeCaptureAiCopies(tx, ids);" not in read(P("packages/work/src/lifecycle.ts")):
        errs.append("the Inbox purge must erase the capture's AI copies")
    routes = read(P("apps/api/src/work/routes.ts"))
    if "registerAi(app, work)" not in routes:
        errs.append("the API must register the AI routes")
    reg = read(P("apps/worker/src/registry.ts"))
    for n in ("aiDispatchHandler(m.ai)", "aiRetentionHandler(m.ai)", "aiBriefingSweepHandler(m.ai)",
              "aiTranscriptionHandler(m.ai)", "voiceCleanupHandler(m.ai)", "...AI_SCHEDULES"):
        if n not in reg:
            errs.append("the worker must register %s" % n)
    main = read(P("apps/worker/src/main.ts"))
    if "transcriptionTimeoutMs:" not in main or "timeoutMs: d.transcriptionTimeoutMs ?? d.timeoutMs," not in read(
            P("packages/work/src/ai/jobs.ts")):
        errs.append("transcription attempts must be bounded by the transcription transport")
    web = read(P("apps/web/src/ai/proposals-page.tsx"))
    for op in ("'task.assign':", "'label.add':", "'criterion.add':"):
        if op not in web:
            errs.append("the proposal review must name %s" % op)
    verify = read(P("scripts/verify.sh"))
    pkg = json.loads(read(P("package.json")))
    if "python3 docs/engineering/tools/phase7.py" not in verify:
        errs.append("verify.sh (and so preflight) must run phase7.py")
    if pkg.get("scripts", {}).get("validate:phase7") != "python3 docs/engineering/tools/phase7.py":
        errs.append("package.json lacks validate:phase7")
    readme = read(P("docs/engineering/README.md"))
    if "0044-phase-7-integration.md" not in readme or "phase7.py" not in readme:
        errs.append("the engineering index must list ADR-0044 and the Phase 7 validator")
    if "## Phase 7 integration" not in read(P("docs/engineering/database.md")):
        errs.append("docs/engineering/database.md must record migration 0060")
    return errs, "factory, one gateway and provider path, session-only surfaces, hooks, routes, worker, web, wiring"


def check_closure(closure):
    errs = []
    catalog = {r["id"]: r for r in load(P("docs/product/requirements/catalog.json"))["requirements"]}
    subphases = phase1.roadmap_subphases()
    if closure.get("phase") != "7" or closure.get("status") != "candidate" or closure.get("adr") != "0044":
        errs.append("closure-7.json must be the Phase 7 candidate under ADR-0044")
    if closure.get("order") != SUBPHASES:
        errs.append("closure-7.json must list the subphases in dependency order")
    owned_total = implemented = foundations = contributions = 0
    closed, pairs, future = {}, set(), []
    for sub in SUBPHASES:
        path = closure.get("members", {}).get(sub)
        if path != "docs/engineering/phase7/closure-%s.json" % sub.lower():
            errs.append("closure-7.json must name the %s closure" % sub)
            continue
        c = load(P(path))
        entries = {r["id"]: r for r in c["requirements"]}
        owned = {r for r, x in catalog.items() if x["owner_subphase"] == sub}
        contrib = {r for r, x in catalog.items() if x["owner_subphase"] != sub and sub in x.get("contributing_subphases", [])}
        if set(entries) != owned | contrib:
            errs.append("%s closure must hold exactly its owned and contributed requirements" % sub)
        for rid, e in entries.items():
            if not e.get("evidence") or not all(evidence_ok(x) for x in e["evidence"]):
                errs.append("%s: %s evidence is missing or does not match" % (sub, rid))
            if not any(x["file"].endswith(CODE) for x in e.get("evidence", [])):
                errs.append("%s: %s needs code or test evidence, not prose alone" % (sub, rid))
            if rid in owned:
                owned_total += 1
                closed.setdefault(rid, []).append(sub)
                if e.get("disposition") == "implemented":
                    implemented += 1
                elif e.get("disposition") == "foundation":
                    foundations += 1
                    for d in e.get("deferred_to") or []:
                        if d not in subphases or phase_of(d) <= 7:
                            errs.append("%s: foundation %s defers to %r, not a later subphase" % (sub, rid, d))
                        future.append((rid, sub, d, "foundation"))
                    if not e.get("deferred_to"):
                        errs.append("%s: foundation %s needs its destination" % (sub, rid))
                else:
                    errs.append("%s: owned %s must be implemented or a recorded foundation" % (sub, rid))
            elif rid in contrib:
                contributions += 1
                if e.get("disposition") != "contributed" or e.get("contribution") != sub:
                    errs.append("%s: contribution %s must be 'contributed' by %s" % (sub, rid, sub))
                if (rid, sub) in pairs:
                    errs.append("%s contributes to %s twice" % (sub, rid))
                pairs.add((rid, sub))
                owner = catalog[rid]["owner_subphase"]
                if phase_of(owner) > 7:
                    future.append((rid, sub, owner, "contribution"))
    for rid, subs in closed.items():
        if len(subs) != 1:
            errs.append("%s is closed by %s; an owner closes it exactly once" % (rid, ", ".join(subs)))
    derived = {"owned": owned_total, "implemented": implemented, "foundations": foundations,
               "contributions": contributions}
    for k, v in derived.items():
        if closure.get("totals", {}).get(k) != v:
            errs.append("closure-7.json totals.%s is %r; the catalog derives %d" % (k, closure.get("totals", {}).get(k), v))
    recorded = sorted((f["requirement"], f["contributor"], f["destination"], f["kind"])
                      for f in closure.get("future_boundaries", []))
    if recorded != sorted(future):
        errs.append("future_boundaries must be exactly the later-phase contributions and foundations "
                    "(missing %s, extra %s)" % (sorted(set(future) - set(recorded)), sorted(set(recorded) - set(future))))
    for f in closure.get("future_boundaries", []):
        if f["destination"] not in subphases:
            errs.append("%s cites %s, which is not a roadmap subphase" % (f["requirement"], f["destination"]))
    bounds = {b["id"]: b for b in closure.get("boundaries", [])}
    for b in REQUIRED_BOUNDARIES:
        if b not in bounds:
            errs.append("closure-7.json must record the %s boundary" % b)
    decisions = read(P("docs/product/open-decisions.md"))
    for od in OPEN_DECISIONS:
        sec = decisions.split("### %s" % od)[1][:3000] if "### %s" % od in decisions else ""
        if not sec or re.search(r"\*\*Decided", sec.split("\n### ")[0]):
            errs.append("%s must stay open; Phase 7 decides nothing" % od)
    od16 = decisions.split("### OD-16")[1][:600] if "### OD-16" in decisions else ""
    if "**Decided" not in od16:
        errs.append("OD-16 must stay the recorded verified-update rule")
    unknown = read(P("docs/architecture/data/13-open-questions.md"))
    if '<a id="dq-28"></a>DQ-28' not in unknown:
        errs.append("DQ-28 must stay an open question")
    for e in closure.get("evidence", []):
        if not evidence_ok(e):
            errs.append("evidence missing: %s %r" % (e["file"], e["contains"]))
    return errs, "%d owned closed once (%d implemented, %d foundations), %d contributions, %d later-phase boundaries" % (
        owned_total, implemented, foundations, contributions, len(future))


def check_corrective(closure):
    """Every prior corrective group still resolves to running code and registered, titled tests."""
    errs = []
    aids = {x["id"] for x in load(P("docs/architecture/access/policy/threats.json"))["tests"]}
    titles = test_titles()
    reviews = groups = 0
    for sub in SUBPHASES:
        c = load(P(closure["members"][sub]))
        for r in c.get("corrective_reviews", []):
            reviews += 1
            for g in r.get("groups", []):
                groups += 1
                label = "%s %s" % (r["id"], g["id"])
                ev = g.get("evidence") or []
                if not ev or not all(evidence_ok(x) for x in ev):
                    errs.append("%s evidence is missing or does not match" % label)
                if not any(x["file"].endswith(CODE) for x in ev):
                    errs.append("%s needs code or test evidence" % label)
                for at in g.get("tests", []):
                    if at not in aids:
                        errs.append("%s test %s is not registered" % (label, at))
                    if len(titles.get(at, [])) != 1:
                        errs.append("%s test %s must title exactly one test" % (label, at))
    t = closure.get("totals", {})
    if t.get("corrective_reviews") != reviews or t.get("corrective_groups") != groups:
        errs.append("closure-7.json records %s reviews and %s groups; the closures hold %d and %d" % (
            t.get("corrective_reviews"), t.get("corrective_groups"), reviews, groups))
    for c in closure.get("corrections", []):
        if not c.get("evidence") or not all(evidence_ok(x) for x in c["evidence"]):
            errs.append("integration correction %s evidence is missing or does not match" % c["id"])
        if not any(x["file"].endswith(CODE) for x in c.get("evidence", [])):
            errs.append("integration correction %s needs code or test evidence" % c["id"])
        if not c.get("old_code"):
            errs.append("integration correction %s must record its old-code result" % c["id"])
        for at in c.get("tests", []):
            if len(titles.get(at, [])) != 1:
                errs.append("integration correction %s test %s must title exactly one test" % (c["id"], at))
    if sorted(c["id"] for c in closure.get("corrections", [])) != ["I%d" % i for i in range(1, 9)]:
        errs.append("closure-7.json must record corrections I1-I8 as in ADR-0044")
    return errs, "%d corrective reviews, %d groups, %d integration corrections" % (
        reviews, groups, len(closure.get("corrections", [])))


def check_exit_records():
    errs = []
    for f in ("exit-report.md", "manual-smoke.md", "topology.md"):
        if not os.path.isfile(P("docs/engineering/phase7/%s" % f)):
            return ["docs/engineering/phase7/%s is missing" % f], ""
    report = read(P("docs/engineering/phase7/exit-report.md"))
    for term in ("## Capability matrix", "## Production-disabled", "## Manual checks", "## Next owners",
                 "## Accepted operational limits", "REL-FU-7A-01", "not production-ready",
                 "not live-provider-tested", "## Topology and merge guidance"):
        if term not in report:
            errs.append("exit-report.md lacks %r" % term)
    if re.search(r"\bproduction[- ]ready\b(?! )", report.replace("not production-ready", "")):
        errs.append("exit-report.md must not claim production readiness")
    if "## Manual checks" not in read(P("docs/engineering/phase7/manual-smoke.md")):
        errs.append("manual-smoke.md lacks its manual checks")
    if "## Verified stack" not in read(P("docs/engineering/phase7/topology.md")):
        errs.append("topology.md lacks the verified stack")
    adr = read(P(ADR))
    for term in ("## Lock ordering", "There is no global lock-order proof", "REL-FU-7A-01",
                 "prerequisite before Phase 8", "## Findings outside Phase 7 authority"):
        if term not in adr:
            errs.append("ADR-0044 must state %r" % term)
    if os.path.isfile(P("BUILD_ROADMAP.md")) and "0044" in read(P("BUILD_ROADMAP.md")):
        errs.append("the original build roadmap stays unchanged")
    return errs, "exit report, manual smoke, topology, ADR-0044 boundaries"


def main():
    closure = load(P(CLOSURE))
    sections = [
        ("phase 7: every Phase 0-7F validator passes", check_validators()),
        ("phase 7: one owner for every migration, ADR, and identifier", check_numbering(closure)),
        ("phase 7: one gateway composes", check_composition()),
        ("phase 7: aggregate closure and boundaries", check_closure(closure)),
        ("phase 7: corrective reviews and integration corrections", check_corrective(closure)),
        ("phase 7: exit records", check_exit_records()),
    ]
    failed = 0
    for name, (errs, detail) in sections:
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 7 AGGREGATE CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
