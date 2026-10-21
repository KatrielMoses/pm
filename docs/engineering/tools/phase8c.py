#!/usr/bin/env python3
"""Phase 8C durable, bounded agent runs: closure validator (ADR-0048).

Usage (from the repository root, after `pnpm install`):
    python3 docs/engineering/tools/phase8c.py      # exit 1 on any failure

Runtime-backed: besides the closure, contracts, migration, and wiring checks, it runs the real
run state table, callback parsers, credential minter, and dispatch transport (phase8c-probe.ts
under Node, with an injected fetch) and checks their behavior: `accepted` is never produced, a
finished run is ready for review, commentary cannot complete, artifacts are typed, bounded, and
hash-checked, credentials are `par_` and hashed, and only a refusal before any request counts as
not sent. The configured limits are compared across the runtime defaults, the configuration
ranges, the 0D registry, and the environment contract.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402
import phase2  # noqa: E402
import phase8w0  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

SUBPHASE = "8C"
DECISIONS = ["D%d" % i for i in range(1, 18)]
ADR = "docs/engineering/adr/0048-durable-agent-runs.md"
CLOSURE = "docs/engineering/phase8/closure-8c.json"
RUNS = "packages/work/src/agents/runs.ts"
SERVICE = "packages/work/src/agents/service.ts"
MODULE = "packages/work/src/agents"
UP = "packages/db/migrations/0065_agent_runs.up.sql"
DOWN = "packages/db/migrations/0065_agent_runs.down.sql"
PROBE = "docs/engineering/tools/phase8c-probe.ts"
WEB = "apps/web/src/agents/runs.tsx"
THREATS = ["T-%d" % i for i in range(164, 174)]
TESTS = ["AT-%d" % i for i in range(643, 668)]
TABLES = ["agent_run", "agent_run_event", "agent_tool_call", "agent_artifact", "agent_run_credential", "emergency_stop"]
BOUNDARIES = ["8D", "10A", "PRODUCTION-CONNECTORS", "PRODUCTION-AI", "MANUAL", "RECONCILIATION-UI", "REL-FU-P7-01",
              "TEST-FU-P7-02"]
PARAMS = ["AGENT_RUNS_ACTIVE_MAX", "AGENT_RUN_RETRIES_MAX", "AGENT_RUN_EVENTS_MAX", "AGENT_RUN_EVENT_TEXT_MAX_CHARS",
          "AGENT_ARTIFACT_MAX_BYTES", "AGENT_RUN_OUTPUT_MAX_BYTES", "AGENT_RUN_CREDENTIAL_TTL_SECONDS",
          "AGENT_RUN_POLL_WAIT_SECONDS"]
ENVELOPES = ["agent_run", "agent_runs", "agent_run_preview", "agent_run_events", "agent_artifact", "agent_run_context",
             "agent_run_event_receipt", "agent_tool_result", "agent_artifact_receipt", "agent_run_result_receipt",
             "agent_health", "agent_emergency_stop"]
ACCEPTED_8B = "e51b3f19ecf215e296d08c12c14649a4e1b2565d"


def check_runtime():
    """Run the real state table, parsers, minter, and transport and check what they do."""
    errs = []
    try:
        out = subprocess.run(["node", "--conditions=@pm/source", P(PROBE)], cwd=P("."), capture_output=True,
                             text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return ["the run probe could not run (%s); run `pnpm install` first" % exc], ""
    if out.returncode != 0:
        return ["the run probe failed: %s" % (out.stderr.strip().splitlines() or ["?"])[-1]], ""
    try:
        d = json.loads(out.stdout)
    except ValueError:
        return ["the run probe printed no JSON"], ""
    if d["states"] != ["queued", "running", "waiting", "failed", "cancelled", "ready_for_review"]:
        errs.append("run states must be queued, running, waiting, failed, cancelled, ready_for_review (never accepted)")
    t = d["table"]
    if any(v["state"] == "accepted" for v in t.values()):
        errs.append("no operation state may map to accepted (8D)")
    expect = {"succeeded": "ready_for_review", "failed": "failed", "partial": "failed", "skipped": "failed",
              "cancelled": "cancelled", "queued": "queued", "running": "running",
              "waiting:external_confirmation": "running"}
    for op, state in expect.items():
        if t.get(op, {}).get("state") != state:
            errs.append("operation %s must show as %s (got %s)" % (op, state, t.get(op)))
    if t.get("paused") != {"state": "waiting", "waiting": "paused"}:
        errs.append("a paused operation must show as waiting (paused)")
    for r in ("authorization_changed", "approval", "reconciliation_required"):
        if t.get("waiting:%s" % r) != {"state": "waiting", "waiting": r}:
            errs.append("waiting for %s must be explained" % r)
    if d["controls"].get("retry") != ["failed", "partial"] or "succeeded" in sum(d["controls"].values(), []):
        errs.append("controls must never start from a finished run (and retry only from failures)")
    if d["destination"] != {"name": "agents.run_dispatch", "class": "unsafe"}:
        errs.append("the dispatch destination must be agents.run_dispatch (unsafe)")
    p = d["parsers"]
    for k in ("progress", "tool", "artifact", "result_ok"):
        if p[k] is not True:
            errs.append("the parser must accept a valid %s" % k)
    for k, code in (("completion_kind", "invalid_option"), ("too_long", "invalid_length"),
                    ("artifact_binary", "unsupported_media_type"), ("artifact_hash", "checksum_mismatch"),
                    ("artifact_large", "too_large"), ("result_accepted", "invalid_option")):
        if code not in p[k]:
            errs.append("the parser must refuse %s with %s (got %s)" % (k, code, p[k]))
    if d["credential"] != {"format": True, "prefix": True, "hash": True, "unique": True, "own_refused": True}:
        errs.append("run credentials must be par_ + 40, hashed, unique, and refused as connector secrets (%s)" % d["credential"])
    x = d["dispatch"]
    if x["private"] != {"ok": False, "sent": False, "code": "private_address", "calls": 0}:
        errs.append("a guarded refusal must be not sent, with no request (%s)" % x["private"])
    if x["acked"].get("ok") is not True:
        errs.append("a valid acknowledgment must be accepted")
    for k in ("bad_ack", "server_error", "reset"):
        if x[k].get("ok") is not False or x[k].get("sent") is not True:
            errs.append("after a request, %s must be sent or unknown, never not sent (%s)" % (k, x[k]))
    return errs, "%d operation states mapped, no accepted; parsers; par_ credentials; not-sent only before any request" % len(t)


def check_service():
    errs = []
    runs = read(P(RUNS))
    for rel in sorted(os.listdir(P(MODULE))):
        if not rel.endswith(".ts"):
            continue
        text = read(P("%s/%s" % (MODULE, rel)))
        if rel != "connectors.ts" and re.search(r"\bfetch\(", text):
            errs.append("%s must not call the network (only connectors.ts dispatches)" % rel)
        if re.search(r"(insertInto|updateTable|deleteFrom)\('(work|collab|relations|workflow)\.", text):
            errs.append("%s writes business tables directly" % rel)
        if re.search(r"\bsql\.raw\(", text):
            errs.append("%s builds raw SQL" % rel)
    if "export class AgentRunService extends AgentService" not in runs:
        errs.append("AgentRunService must extend the 8B AgentService")
    if "return new AgentRunService(" not in read(P("packages/work/src/factory.ts")):
        errs.append("the factory must return AgentRunService (the chain head)")
    for term, label in [
        ("this.agentAssignmentEligibility(", "the 8B shared eligibility handoff"),
        ("pg_advisory_xact_lock", "the open-run and stop locks"),
        ("token_hash", "hash-only credentials"),
        ("'approval_required'", "the 8D tool boundary"),
        ("accept: false", "no acceptance capability"),
        ("protected override async onAgentAssignmentWithdrawn(", "withdrawal ends open runs"),
        ("protected override async invokeAgentForAutomation(", "the AUTO-007 admission"),
        ("label: `reported by ${profile.name}`", "reported cost labelled"),
        ("caller.delegation", "session-only stop and health"),
    ]:
        if term not in runs:
            errs.append("runs.ts lacks %s" % label)
    if re.search(r"insertInto\('agents\.agent_run_credential'\)[^;]*\btoken:", runs, re.S):
        errs.append("the credential token must never be stored")
    if re.search(r"ctx\.step\([^)]*\)[^;]*credential", runs) and "token" in runs.split("ctx.step(")[1][:200]:
        errs.append("a checkpoint must never hold the credential")
    if "'accepted'" in read(P("packages/work/src/agents/run-states.ts")):
        errs.append("run-states.ts must not name an accepted state")
    reg = read(P("apps/worker/src/registry.ts"))
    if "agentRunHandler" not in reg or "AgentRunOutcomeConsumer" not in reg:
        errs.append("the worker must register the run handler and the outcome consumer")
    routes = read(P("apps/api/src/auth/routes.ts"))
    if "agents:execute" not in routes or "agent-(emergency-stop|health)" not in routes:
        errs.append("the bearer gate must require agents:execute and keep the stop session-only")
    web = read(P(WEB))
    if re.search(r">\s*(Accept|Approve|Mark done)\s*<", web):
        errs.append("the web app must not offer an accept control (8D)")
    if "au-chip-review" not in read(P("apps/web/src/styles.css")):
        errs.append("ready for review must use a neutral chip, never success")
    return errs, "one run service on the platform, hash-only credentials, 8D boundary, worker and gate wiring, no accept"


def check_migration():
    errs = []
    up, down = read(P(UP)), read(P(DOWN))
    for t in TABLES:
        if "CREATE TABLE agents.%s (" % t not in up:
            errs.append("0065 lacks agents.%s" % t)
        if "ALTER TABLE agents.%s FORCE ROW LEVEL SECURITY" % t not in up:
            errs.append("agents.%s must force row-level security" % t)
    for term in ("CREATE UNIQUE INDEX agent_run_open", "agent_artifact_immutable", "emergency_stop_immutable",
                 "agents.resolve_run_credential", "'agent'"):
        if term not in up:
            errs.append("0065 up lacks %s" % term)
    for term in ("Restores the exact 0064 catalog", "0065 cannot be rolled back"):
        if term not in down:
            errs.append("0065 down lacks %s" % term)
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    if names[-1] != "0065_agent_runs.up.sql":
        errs.append("0065_agent_runs must be the last migration")
    errs += phase1.check_boundaries([65])
    mt = read(P("packages/db/test/integration/migrations.test.ts"))
    if "65" not in re.findall(r"\b65\b", mt) or "0065 cannot be rolled back" not in mt:
        errs.append("the migration tests must cover the 0065 boundary and its guarded rollback")
    volume = read(P("packages/work/test/integration/agents-volume.test.ts"))
    for idx in ("agent_run_by_task", "agent_run_open", "agent_run_active", "agent_run_event_seq_unique",
                "agent_run_by_model_operation", "agent_run_credential_prefix_unique"):
        if idx not in volume or "EXPLAIN at 10,000 runs and 50,000 events" not in volume:
            errs.append("the volume EXPLAIN test must prove %s is used" % idx)
    for path in ("packages/platform/test/integration/rls.test.ts", "packages/db/test/integration/workspace-integrity.test.ts"):
        text = read(P(path))
        for t in TABLES:
            if "'agents.%s'" % t not in text:
                errs.append("%s must list agents.%s" % (path, t))
    return errs, "six forced-RLS tables, immutable artifacts and stops, guarded exact rollback, boundary 65, plans at volume"


def check_identifiers():
    errs = []
    t = load(P("docs/architecture/access/policy/threats.json"))
    tids = {x["id"] for x in t["threats"]}
    tests = {x["id"]: x for x in t["tests"]}
    seen = phase8w0.titles()
    adr = read(P(ADR))
    for th in THREATS:
        if th not in tids:
            errs.append("%s is not registered" % th)
    for at in TESTS:
        if at not in tests:
            errs.append("%s is not registered in 0C" % at)
        elif not set(tests[at]["threats"]) & set(THREATS):
            errs.append("%s must cover an 8C threat" % at)
        if len(seen.get(at, [])) != 1:
            errs.append("%s must title exactly one test (found %d)" % (at, len(seen.get(at, []))))
    for term in ("T-164–T-173", "AT-643–AT-667", "ADR-53, AZ-53, PL-55, UXD-34"):
        if term not in adr:
            errs.append("ADR-0048 must cite %s" % term)
    for path, anchor in (("docs/architecture/data/12-decisions.md", "adr-53"), ("docs/architecture/access/15-decisions.md", "az-53"),
                         ("docs/architecture/platform/19-decisions.md", "pl-55"), ("docs/ux/09-decisions-and-risks.md", "uxd-34")):
        if '<a id="%s"></a>' % anchor not in read(P(path)):
            errs.append("%s lacks the %s anchor" % (path, anchor))
    model = {e["name"]: e for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    for name in ("agent_run", "agent_run_event", "agent_tool_call", "artifact", "agent_run_credential", "emergency_stop"):
        if name not in model:
            errs.append("0B lacks the %s entity" % name)
        elif "ADR-53" not in model[name].get("notes", ""):
            errs.append("0B %s must cite ADR-53" % name)
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    if not any(o["kind"] == "agent_run" and o["detail_entity"] == "agents.agent_run" for o in registry["operation_kinds"]):
        errs.append("0D must register the agent_run operation kind")
    events = json.dumps(registry["events"])
    for ev in ("agents.agent_run.output_returned", "agents.agent_run.failed"):
        if ev not in events:
            errs.append("0D must register %s" % ev)
    params = {x["name"]: x for x in registry["parameters"]}
    envdoc = read(P("docs/engineering/environments.md"))
    server = read(P("packages/config/src/server.ts"))
    for name in PARAMS:
        if params.get(name, {}).get("owner") != "8C":
            errs.append("0D must register %s (owner 8C)" % name)
        if "| `%s` |" % name not in envdoc:
            errs.append("environments.md must document %s" % name)
        default = re.search(r"\n  %s: '(\d+)'," % name, server)
        rng = re.search(r"\n  %s: int\(([\d_]+), ([\d_]+)\)," % name, server)
        if not default or not rng:
            errs.append("configuration must give %s a default and a finite range" % name)
            continue
        lo, hi, d = int(rng.group(1).replace("_", "")), int(rng.group(2).replace("_", "")), int(default.group(1))
        documented = "default %d (%d–%d)" % (d, lo, hi)
        if documented not in envdoc.split("| `%s` |" % name, 1)[-1].split("\n", 1)[0]:
            errs.append("environments.md must state %s for %s" % (documented, name))
        if not lo <= d <= hi:
            errs.append("%s default %d is outside %d–%d" % (name, d, lo, hi))
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for ty in ENVELOPES:
        if "'%s'" % ty not in envelopes:
            errs.append("non-resource type %s is not registered" % ty)
    return errs, "T-164..T-173, AT-643..AT-667 titled once, ADR-53/AZ-53/PL-55/UXD-34, 0B entities, 8 limits, contracts"


def check_closure_and_boundaries(closure):
    errs = []
    if closure.get("adr") != "0048" or closure.get("status") != "candidate":
        errs.append("closure-8c.json must be the candidate 8C closure under ADR-0048 (never self-accepted)")
    if closure.get("base", {}).get("head") != ACCEPTED_8B:
        errs.append("the closure base must be the accepted 8B head e51b3f1")
    b8 = load(P("docs/engineering/phase8/closure-8b.json"))
    if b8.get("status") != "accepted" or b8.get("accepted", {}).get("ci_run") != "39502523692":
        errs.append("the 8B acceptance (run 39502523692) must be recorded before 8C builds on it")
    adr = read(P(ADR))
    status = next((l for l in adr.split("\n") if l.startswith("Status: ")), "")
    if not status.startswith("Status: **proposed**") or "not self-accepted" not in status or "not production" not in status:
        errs.append("ADR-0048 must be proposed, not self-accepted, and not production approval")
    for d in DECISIONS:
        if "\n| %s |" % d not in adr:
            errs.append("ADR-0048 lacks decision %s" % d)
    got = {b["id"] for b in closure.get("boundaries", [])}
    for b in BOUNDARIES:
        if b not in got:
            errs.append("the closure must record the %s boundary" % b)
    for term in ("**8D:**", "**Production connectors:**", "**Production AI:**", "**10A:**", "**Manual:**",
                 "**Reconciliation UI:**", "REL-FU-P7-01 and TEST-FU-P7-02", "`accepted` is never produced"):
        if term not in adr:
            errs.append("ADR-0048 must state %s" % term)
    reqs = {r["id"]: r for r in closure.get("requirements", [])}
    for rid in ("AGT-010", "AGT-013", "AGT-022"):
        if "8D" not in (reqs.get(rid, {}).get("enriched_by") or []):
            errs.append("%s must name 8D for acceptance or promotion" % rid)
    return errs, "candidate on e51b3f1; boundaries 8D/10A, production connectors and AI, manual, reconciliation UI, follow-ups"


def check_wiring():
    errs = []
    if "python3 docs/engineering/tools/phase8c.py" not in read(P("scripts/verify.sh")):
        errs.append("verify.sh (and so preflight) must run phase8c.py in the core gate")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase8c") != "python3 docs/engineering/tools/phase8c.py":
        errs.append("package.json lacks validate:phase8c")
    readme = read(P("docs/engineering/README.md"))
    for term in ("0048-durable-agent-runs.md", "phase8c.py", "agent-runs.md"):
        if term not in readme:
            errs.append("the engineering index must list %s" % term)
    if "## Phase 8C: agent runs" not in read(P("docs/engineering/database.md")):
        errs.append("docs/engineering/database.md must record migration 0065")
    if not os.path.isfile(P("docs/engineering/agent-runs.md")):
        errs.append("the agent run operator notes are missing")
    pages = read(P("apps/web/src/agents/pages.tsx"))
    if "<TaskAgentRuns" not in pages or "<AgentHealthCard" not in pages:
        errs.append("the task Agent section and the Agents page must show runs and health")
    e2e = read(P("e2e/agents.spec.ts"))
    if "'AT-664 " not in e2e or "'AT-665 " not in e2e:
        errs.append("the browser suite must run the 8C journeys")
    return errs, "verify.sh, package.json, the engineering index, database and operator notes, web, browser journeys"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P(CLOSURE))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 8C: requirement closure", phase2.check_closure(catalog, closure, subphases, SUBPHASE, DECISIONS)),
        ("phase 8C: closure, ADR status, and boundaries", check_closure_and_boundaries(closure)),
        ("phase 8C: runs at runtime", check_runtime()),
        ("phase 8C: one run service on the platform", check_service()),
        ("phase 8C: migration 0065", check_migration()),
        ("phase 8C: identifiers, contracts, and limits", check_identifiers()),
        ("phase 8C: wiring", check_wiring()),
        ("phase 8C: migration sequence", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: %s" % e)
        failed += bool(errs)
    print("PHASE 8C CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
