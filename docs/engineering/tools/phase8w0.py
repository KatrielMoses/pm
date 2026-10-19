#!/usr/bin/env python3
"""P8-W0 safe recovery of external effects: closure validator (standard library, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase8w0.py      # exit 1 on any failure

ADR-0045 closes REL-FU-7A-01. This validator holds it closed with executable evidence: the real
worker path claims before I/O, records unknown after any possible dispatch, takes failed only on
typed proof, fences outcomes, recovers abandoned claims, and never reports success while an effect
is uncertain; every consumer uses the claim API and a registered destination; migration 0061 has its
guarded exact rollback and boundary; the regression and boundary tests exist, are registered, and
title exactly one test each; the contracts (0B, 0C, 0D) and wiring agree.
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

ADR = "docs/engineering/adr/0045-effect-recovery-safety.md"
CLOSURE = "docs/engineering/phase8/closure-p8w0.json"
EFFECTS = "packages/platform/src/effects.ts"
WORKER = "packages/platform/src/worker.ts"
UP = "packages/db/migrations/0061_effect_recovery_safety.up.sql"
DOWN = "packages/db/migrations/0061_effect_recovery_safety.down.sql"
THREATS = ["T-139", "T-140", "T-141"]
TESTS = ["AT-%d" % i for i in range(539, 551)]
DECISIONS = ["E%d" % i for i in range(1, 11)]
TEST_DIRS = ["packages", "apps", "e2e"]


def titles():
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


def block(text, start, end):
    i = text.find(start)
    j = text.find(end, i + 1) if i >= 0 else -1
    return text[i:j] if 0 <= i < j else ""


def check_ledger():
    """The platform ledger API: claim before I/O, typed proof, fenced outcomes, honest cancel."""
    errs = []
    e = read(P(EFFECTS))
    for term, label in [
        ("export async function claimEffect(", "a claim API"),
        ("state: 'dispatching',", "the in-flight state on claim"),
        ("attempt_count: row.attempt_count + 1,", "one counted attempt per claim"),
        ("export class EffectNotSentError extends Error", "typed not-sent proof"),
        ("if (row.state !== 'dispatching' || row.claim_token !== claim.token) {", "fenced outcome writes"),
        ("late_outcome: outcome.state,", "late evidence for a stale claimant"),
        ("uncertainty_reason: 'abandoned_claim',", "abandoned claims recorded unknown"),
        ("export function defineEffectDestination(", "registered destinations"),
        ("throw new EffectKeyConflictError();", "key reuse refused"),
        (".where('state', 'in', ['pending', 'failed'])", "cancellation of undispatched or proven-not-sent effects only"),
        ("liability:", "cancellation liability"),
        ("if (expectedVersion !== undefined && Number(row.version) !== expectedVersion)", "version-bound reconciliation"),
        ("export async function resumeAfterReconciliation(", "resume after reconciliation"),
    ]:
        if term not in e:
            errs.append("effects.ts lacks %s" % label)
    if re.search(r"export async function markEffect(Attempt|Outcome)\(", e):
        errs.append("the unfenced markEffectAttempt/markEffectOutcome API must be gone")
    decide = block(e, "export function decideEffect(", "\n}\n")
    if "case 'dispatching':\n      return 'in_flight';" not in decide:
        errs.append("a held claim must never decide to attempt")
    w = read(P(WORKER))
    eff = block(w, "      effect: async (effectKey, destination, perform) => {", "\n      },\n")
    if not eff:
        errs.append("the worker effect path is missing")
    claim_at = eff.find("claimEffect(")
    perform_at = eff.find("await perform(")
    if claim_at < 0 or perform_at < 0 or claim_at > perform_at:
        errs.append("the worker must commit a claim before performing the effect")
    if "err instanceof EffectNotSentError" not in eff or "'unproven_failure'" not in eff:
        errs.append("only typed proof may mean not sent; any other error is unknown")
    if "if (recorded === 'stale')" not in eff:
        errs.append("a stale claimant's outcome must stop after committing evidence")
    if "throw new JobError('transient', 'effect_in_flight');" not in eff:
        errs.append("a live claim held elsewhere must not be dispatched again")
    if "await abandonAttemptClaims(tenantTx(tx), [attemptId]);" not in w:
        errs.append("an ending attempt's open claims must become unknown")
    reaper = block(w, "  async reapExpiredLeases()", "  async dispatchOutbox()")
    if "abandonAttemptClaims(" not in reaper or "uncertainEffects(" not in reaper:
        errs.append("the reaper must recover lost claims and never fail an uncertain operation")
    if "waitingReason: 'reconciliation_required'" not in w:
        errs.append("an uncertain operation must wait for reconciliation")
    jobs = read(P("packages/platform/src/jobs.ts"))
    if "destination: import('./effects.ts').EffectDestination," not in jobs:
        errs.append("ctx.effect must take a registered destination, never a bare class")
    return errs, "claim before I/O, typed proof, fencing, recovery, liability, no false success"


def check_consumers():
    errs = []
    sweep = read(P("packages/work/src/files/jobs.ts"))
    if "claimEffect(tx, e.id, {" not in sweep or "markEffect" in sweep:
        errs.append("the files sweep must claim before deleting")
    if "reason: 'unproven_failure'" not in sweep:
        errs.append("a storage error in the sweep is unknown, not failed")
    purge = read(P("packages/lifecycle/src/purge.ts"))
    for term in ("export const OBJECT_DELETE_DESTINATION = defineEffectDestination(",
                 "export const PURGE_LEDGER_DESTINATION = defineEffectDestination(",
                 "destination: OBJECT_DELETE_DESTINATION,", "PURGE_LEDGER_DESTINATION,"):
        if term not in purge:
            errs.append("purge lacks %s" % term)
    for dirpath, dirs, files in os.walk(P("packages")):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "dist", "test")]
        for f in files:
            if not f.endswith(".ts"):
                continue
            path = os.path.join(dirpath, f)
            text = read(path)
            rel = os.path.relpath(path, P("."))
            if re.search(r"\.effect\(\s*[^,]+,\s*'(unsafe|naturally_idempotent|idempotent_by_provider|deduplicated_by_receiver)'", text):
                errs.append("%s passes a bare destination class to ctx.effect" % rel)
            if rel != EFFECTS and re.search(r"updateTable\('exec\.external_effect'\)", text):
                errs.append("%s writes the effect ledger outside the platform API" % rel)
    ai = read(P("packages/work/src/ai/ai-gateway-service.ts"))
    if "exec.external_effect" in ai:
        errs.append("the AI gateway keeps its own ledgers and must not use the generic one")
    return errs, "files sweep, purge, no bare classes, no ledger writes outside the platform, AI ledgers intact"


def check_migration():
    errs = []
    up, down = read(P(UP)), read(P(DOWN))
    for term in ("-- migrate:phase expand", "ADD VALUE IF NOT EXISTS 'dispatching'", "external_effect_transition_guard",
                 "'failed means proven not sent'", "'unsafe effect with unknown outcome needs reconciliation'",
                 "'an unknown effect is abandoned only by decision'", "uncertainty_reason = 'legacy_attempted'",
                 "WHERE (state = 'pending' AND attempt_count > 0) OR state = 'failed';",
                 "ALTER TABLE exec.external_effect FORCE ROW LEVEL SECURITY;", "SET LOCAL ROLE pm_scheduler;"):
        if term not in up:
            errs.append("0061 up lacks %s" % term)
    if re.search(r"SET\s+attempt_count\s*=\s*0|provider_idempotency_key\s*=", up):
        errs.append("0061 must never reset attempts or keys")
    for term in ("Restores the exact 0060 catalog", "0061 cannot be rolled back", "CREATE TYPE exec.effect_state_0060",
                 "ALTER TYPE exec.effect_state_0060 RENAME TO effect_state;", "FORCE ROW LEVEL SECURITY;"):
        if term not in down:
            errs.append("0061 down lacks %s" % term)
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    if names[-1] != "0061_effect_recovery_safety.up.sql":
        errs.append("0061_effect_recovery_safety must be the last migration")
    errs += phase1.check_migrations()[0]
    errs += phase1.check_boundaries([60, 61])
    mt = read(P("packages/db/test/integration/migrations.test.ts"))
    for term in ("applied-migration boundary: 0061 classifies attempted effects as unknown",
                 "1 effect\\(s\\) are dispatching and 0 carry late evidence"):
        if term not in mt:
            errs.append("the migration tests lack %r" % term)
    return errs, "expand 0061, guard, legacy classification, guarded exact rollback, boundary 61"


def check_identifiers(closure):
    errs = []
    t = load(P("docs/architecture/access/policy/threats.json"))
    tids = {x["id"] for x in t["threats"]}
    tests = {x["id"]: x for x in t["tests"]}
    seen = titles()
    for th in THREATS:
        if th not in tids:
            errs.append("%s is not registered" % th)
    adr = read(P(ADR))
    for at in TESTS:
        if at not in tests:
            errs.append("%s is not registered in 0C" % at)
        elif not set(tests[at]["threats"]) & set(THREATS):
            errs.append("%s must cover a P8-W0 threat" % at)
        if len(seen.get(at, [])) != 1:
            errs.append("%s must title exactly one test (found %d)" % (at, len(seen.get(at, []))))
        if at not in adr:
            errs.append("ADR-0045 must cite %s" % at)
    policy = load(P("docs/architecture/access/policy/policy.json"))
    act = next((a for a in policy["actions"] if a["key"] == "operation.reconcile_effect"), None)
    if not act or not act.get("step_up") or act["roles"].get("member") != "deny" or act["roles"].get("guest") != "deny":
        errs.append("0C must define operation.reconcile_effect (owners and administrators, step-up)")
    if "'dispatching'," not in read(P("packages/contracts/src/execution.ts")):
        errs.append("EFFECT_STATES must include dispatching")
    model = {e["name"]: e for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    if "dispatching" not in json.dumps(model.get("external_effect", {})):
        errs.append("0B external_effect must record the dispatching state")
    d05 = read(P("docs/architecture/platform/05-idempotency-and-effects.md"))
    for term in ("| `dispatching` |", "**Typed proof**", "fenced", "no automatic duplicate after ambiguity"):
        if term not in d05:
            errs.append("0D §5.4 lacks %r" % term)
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for ty in ("'external_effects'", "'external_effect_reconciliation'"):
        if ty not in envelopes:
            errs.append("non-resource type %s is not registered" % ty)
    auth = read(P("apps/api/src/auth/routes.ts"))
    if "/operations\\//" not in auth:
        errs.append("operations routes must be session-only at the gate")
    svc = read(P("packages/tenancy/src/service.ts"))
    rec = block(svc, "  async reconcileExternalEffect(", "\n  }\n")
    for term in ("if (caller.delegation) throw new TenancyError('forbidden');",
                 "this.requireWorkspace(p, 'operation.reconcile_effect');",
                 "await this.stepUp(tx, caller, p, req, 'operation.reconcile_effect', {",
                 "action: 'operation.effect_reconciled',", "'version_mismatch'"):
        if term not in rec:
            errs.append("reconcileExternalEffect lacks %s" % term)
    if not re.search(r"^Status: \*\*proposed\*\*", adr, re.M):
        errs.append("ADR-0045 stays proposed until the architect reviews it")
    for d in DECISIONS:
        if "\n| %s |" % d not in adr:
            errs.append("ADR-0045 lacks decision %s" % d)
    return errs, "T-139..T-141, AT-539..AT-550, 0C action, 0B/0D/contracts, session-only, ADR-0045"


def check_closure(closure):
    errs = []
    cache = {}
    if closure.get("phase") != "8-W0" or closure.get("adr") != "0045" or closure.get("status") != "candidate":
        errs.append("closure-p8w0.json must be the 8-W0 candidate under ADR-0045")
    got = [d["id"] for d in closure.get("decisions", [])]
    if got != DECISIONS:
        errs.append("the closure must record decisions E1-E10 in order")
    for d in closure.get("decisions", []):
        phase2.check_evidence("decision %s" % d["id"], d.get("evidence"), cache, errs)
        if not any(x["file"].endswith((".ts", ".sql")) for x in d.get("evidence", [])):
            errs.append("decision %s needs code or test evidence" % d["id"])
    reg = closure.get("regression", {})
    if reg.get("test") != "AT-550" or "applied 2" not in reg.get("old_result", "") or "applied 1" not in reg.get("new_result", ""):
        errs.append("the closure must record the old-code regression result")
    a7 = load(P("docs/engineering/phase7/closure-7a.json"))
    fu = {f["id"]: f for f in a7.get("follow_ups", [])}.get("REL-FU-7A-01", {})
    if fu.get("status") != "closed" or "ADR-0045" not in fu.get("closed_by", ""):
        errs.append("REL-FU-7A-01 must be closed by ADR-0045 in closure-7a.json")
    phase2.check_evidence("REL-FU-7A-01", fu.get("evidence"), cache, errs)
    if "**Closed** by the P8-W0 platform prerequisite" not in read(P("docs/engineering/adr/0038-ai-gateway-privacy-budgets.md")):
        errs.append("ADR-0038 must record the closure of REL-FU-7A-01")
    follow = {f["id"]: f for f in closure.get("follow_ups", [])}
    for fid in ("REL-FU-P7-01", "TEST-FU-P7-02"):
        f = follow.get(fid)
        if not f or not f.get("owner"):
            errs.append("follow-up %s needs a durable owner" % fid)
            continue
        phase2.check_evidence(fid, f.get("evidence"), cache, errs)
    if "resolved" in follow.get("TEST-FU-P7-02", {}).get("statement", "").replace("Not claimed resolved", ""):
        errs.append("TEST-FU-P7-02 must not be claimed resolved")
    acc = closure.get("phase7_acceptance", {})
    if acc.get("head", "")[:7] != "3df1b54" or acc.get("ci_run") != "39223070408":
        errs.append("the Phase 7 acceptance must be recorded at 3df1b54, run 39223070408")
    return errs, "E1-E10 evidence, regression result, REL-FU-7A-01 closed, follow-ups owned, Phase 7 acceptance"


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase8w0.py" not in verify:
        errs.append("verify.sh (and so preflight) must run phase8w0.py")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase8w0") != "python3 docs/engineering/tools/phase8w0.py":
        errs.append("package.json lacks validate:phase8w0")
    readme = read(P("docs/engineering/README.md"))
    if "0045-effect-recovery-safety.md" not in readme or "phase8w0.py" not in readme:
        errs.append("the engineering index must list ADR-0045 and the P8-W0 validator")
    if "## Effect recovery safety (P8-W0)" not in read(P("docs/engineering/database.md")):
        errs.append("docs/engineering/database.md must record migration 0061")
    return errs, "verify.sh, preflight, package.json, the engineering index, the database notes"


def main():
    closure = load(P(CLOSURE))
    sections = [
        ("p8-w0: the ledger and the worker path", check_ledger()),
        ("p8-w0: every consumer", check_consumers()),
        ("p8-w0: migration 0061", check_migration()),
        ("p8-w0: identifiers, contracts, and authority", check_identifiers(closure)),
        ("p8-w0: closure, regression, and follow-ups", check_closure(closure)),
        ("p8-w0: wiring", check_wiring()),
    ]
    failed = 0
    for name, (errs, detail) in sections:
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("P8-W0 EFFECT RECOVERY: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
