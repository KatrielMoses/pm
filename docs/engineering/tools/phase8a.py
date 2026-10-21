#!/usr/bin/env python3
"""Phase 8A versioned, permission-safe automation engine: closure validator (ADR-0046).

Usage (from the repository root, after `pnpm install`):
    python3 docs/engineering/tools/phase8a.py      # exit 1 on any failure

Runtime-backed: besides the closure, contracts, migration, and wiring checks, it runs the real
automation compiler (phase8a-probe.ts under Node) and checks its behavior: every starter template
compiles, the action and trigger matrices match ADR-0046, unsupported configuration is refused, and
future sources stay unavailable with their owning phase. The configured limits are compared across
the runtime defaults, the configuration ranges, the 0D registry, and the environment contract.
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

SUBPHASE = "8A"
DECISIONS = ["D%d" % i for i in range(1, 22)]
ADR = "docs/engineering/adr/0046-automation-engine.md"
CLOSURE = "docs/engineering/phase8/closure-8a.json"
SERVICE = "packages/work/src/automation/service.ts"
DEFINITION = "packages/work/src/automation/definition.ts"
MODULE = "packages/work/src/automation"
UP = "packages/db/migrations/0062_automation_engine.up.sql"
DOWN = "packages/db/migrations/0062_automation_engine.down.sql"
PROBE = "docs/engineering/tools/phase8a-probe.ts"
THREATS = ["T-%d" % i for i in range(142, 152)]
TESTS = ["AT-%d" % i for i in range(552, 595)]
TABLES = ["automation", "automation_revision", "automation_run", "automation_step_run", "standing_approval",
          "trigger_schedule", "usage_period"]
UNSUPPORTED = {"project.create", "project.assign", "project.move", "project.label", "project.relate"}
UNAVAILABLE_ACTIONS = {"agent.invoke": "8C"}
UNAVAILABLE_TRIGGERS = {"test.result": "9B", "agent.result": "8C"}
# 8C supplies the agent runtime: agent steps and agent-result triggers become real (phase8c.py).
RUNS_8C = "packages/work/src/agents/runs.ts"
BOUNDARIES = ["9B", "8C", "10A", "10B", "PRODUCTION-AI", "NO-EXACTLY-ONCE", "MANUAL", "REL-FU-P7-01", "TEST-FU-P7-02"]
PARAMS = ["AUTOMATIONS_PER_WORKSPACE_MAX", "AUTOMATION_DEFINITION_BYTES_MAX", "AUTOMATION_NODES_MAX",
          "AUTOMATION_CONDITION_DEPTH_MAX", "AUTOMATION_CONDITIONS_MAX", "AUTOMATION_TARGET_FANOUT_MAX",
          "AUTOMATION_CHAIN_DEPTH_MAX", "AUTOMATION_RUN_STEPS_MAX", "AUTOMATION_ACTIVE_RUNS_MAX",
          "AUTOMATION_DELAY_HORIZON_MINUTES", "AUTOMATION_RETRIES_MAX", "AUTOMATION_RUNS_PER_MONTH",
          "AUTOMATION_TRIGGER_FANOUT_MAX", "AUTOMATION_SWEEP_BATCH_MAX", "AUTOMATION_ALERT_FAILURE_THRESHOLD",
          "AUTOMATION_ALERT_INTERVAL_MINUTES"]


def block(text, start, end):
    i = text.find(start)
    j = text.find(end, i + 1) if i >= 0 else -1
    return text[i:j] if 0 <= i < j else ""


def module_sources():
    out = {}
    for f in sorted(os.listdir(P(MODULE))):
        if f.endswith(".ts"):
            out["%s/%s" % (MODULE, f)] = read(P("%s/%s" % (MODULE, f)))
    return out


def check_runtime():
    """Run the real compiler and check what it does."""
    errs = []
    try:
        out = subprocess.run(["node", "--conditions=@pm/source", P(PROBE)], cwd=P("."), capture_output=True,
                             text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return ["the compiler probe could not run (%s); run `pnpm install` first" % exc], ""
    if out.returncode != 0:
        return ["the compiler probe failed: %s" % (out.stderr.strip().splitlines() or ["?"])[-1]], ""
    try:
        d = json.loads(out.stdout)
    except ValueError:
        return ["the compiler probe printed no JSON"], ""
    for key, r in d["templates"].items():
        if not r.get("ok") or r.get("unavailable"):
            errs.append("starter template %s must compile with no unavailable node (%s)" % (key, r.get("codes")))
    if len(d["templates"]) < 3:
        errs.append("8A must ship real starter templates (found %d)" % len(d["templates"]))
    acts = d["actions"]
    unsupported = {k for k, v in acts.items() if v["status"] == "unsupported"}
    if unsupported != UNSUPPORTED:
        errs.append("unsupported actions must be exactly %s (got %s)" % (sorted(UNSUPPORTED), sorted(unsupported)))
    after_8c = os.path.isfile(P(RUNS_8C))
    want_actions = {} if after_8c else UNAVAILABLE_ACTIONS
    want_triggers = {"test.result": "9B"} if after_8c else UNAVAILABLE_TRIGGERS
    unavailable = {k: v["owner"] for k, v in acts.items() if v["status"] == "unavailable"}
    if unavailable != want_actions:
        errs.append("unavailable actions must be %s (got %s)" % (want_actions, unavailable))
    if after_8c and acts.get("agent.invoke", {}).get("status") != "supported":
        errs.append("agent.invoke must be supported once the 8C runtime exists")
    for verb in ("create", "update", "assign", "move", "label", "notify", "schedule", "archive", "relate"):
        if acts.get("task.%s" % verb, {}).get("status") != "supported":
            errs.append("task.%s must be supported (AUTO-005)" % verb)
    for verb in ("update", "notify", "schedule", "archive"):
        if acts.get("project.%s" % verb, {}).get("status") != "supported":
            errs.append("project.%s must be supported (AUTO-005)" % verb)
    trig = {k: v["owner"] for k, v in d["triggers"].items() if v["status"] == "unavailable"}
    if trig != want_triggers:
        errs.append("unavailable triggers must be %s (got %s)" % (want_triggers, trig))
    for kind in ("record.created", "record.field_changed", "record.status_changed", "comment.created",
                 "approval.decided", "integration.record_created", "schedule", "date", "manual"):
        if d["triggers"].get(kind, {}).get("status") != "available":
            errs.append("trigger %s must be available (AUTO-003)" % kind)
    p = d["probes"]
    expect = {
        "arbitrary_http": "/steps/0/action:invalid_option",
        "project_assign": "/steps/0/action:action_unsupported",
        "unknown_fallback": "/steps/0/fallback/on:invalid_option",
        "cycle": "/steps:cycle",
    }
    for name, code in expect.items():
        if p[name].get("ok") or code not in p[name].get("codes", []):
            errs.append("the compiler must refuse %s with %s (got %s)" % (name, code, p[name]))
    if p["script"].get("ok"):
        errs.append("an expression-like value must be refused, never evaluated")
    if p["test_trigger"].get("unavailable") != ["9B"]:
        errs.append("test-result triggers must compile as an unavailable boundary (9B)")
    if after_8c:
        if "8C" in (p["agent_step"].get("unavailable") or []):
            errs.append("agent steps must compile as real steps once the 8C runtime exists")
    elif p["agent_step"].get("unavailable") != ["8C"]:
        errs.append("agent steps must compile as an unavailable boundary (8C)")
    adr = read(P(ADR))
    if "| Project | update, notify, schedule, archive" not in adr or "create, assign, move, label, relate" not in adr:
        errs.append("ADR-0046 must publish the action matrix the compiler enforces")
    return errs, "%d templates compile; action and trigger matrices; refusals; unavailable 8C/9B" % len(d["templates"])


def check_engine():
    errs = []
    src = module_sources()
    service = src.get(SERVICE, "")
    definition = src.get(DEFINITION, "")
    for rel, text in src.items():
        if re.search(r"\b(eval|new Function)\(|\bfetch\(", text):
            errs.append("%s must not evaluate code or call the network directly" % rel)
        if re.search(r"(insertInto|updateTable|deleteFrom)\('(work|collab|relations|workflow)\.", text):
            errs.append("%s writes business tables directly (use the canonical commands)" % rel)
        if re.search(r"\bsql\.raw\(", text):
            errs.append("%s builds raw SQL" % rel)
    factory = read(P("packages/work/src/factory.ts"))
    # 8B extends the engine once (AgentService extends AutomationService, phase8b.py).
    agents = P("packages/work/src/agents/service.ts")
    head = "return new AutomationService(" in factory or (
        ("return new AgentService(" in factory or "return new AgentRunService(" in factory) and os.path.isfile(agents)
        and "export class AgentService extends AutomationService" in read(agents))
    if not head or "export class AutomationService extends AiGatewayService" not in service:
        errs.append("AutomationService must extend the gateway and be the chain head the factory returns")
    if ".register(automationOwnerHook)" not in factory:
        errs.append("the factory must register the automation ownership hook")
    for term, label in [
        ("export const AUTOMATION_WEBHOOK_DESTINATION = defineEffectDestination(\n  'automation.webhook',\n  'unsafe',",
         "the unsafe registered webhook destination"),
        ("await ctx.effect(a.logicalKey, AUTOMATION_WEBHOOK_DESTINATION,", "webhooks through the P8-W0 claim path"),
        ("async consumeTriggerEvent(", "the trigger consumer"),
        ("async consumeOperationState(", "terminal accounting"),
        ("async runTriggerSweep(", "the date and schedule sweep"),
        ("async previewAutomation(", "preview"),
        ("SAVEPOINT", "savepoint isolation"),
        ("loop_guard", "the loop guard"),
        ("const AUTOMATION_RUN_ACTION = 'automation.run_manual';", "the run risk label"),
    ]:
        if term not in service:
            errs.append("the automation service lacks %s" % label)
    preview = block(service, "  async previewAutomation(", "\n  }\n")
    if "ROLLBACK TO SAVEPOINT" not in preview and "rollback" not in preview.lower():
        errs.append("preview must roll back everything it tried")
    classes = block(definition, "export const FAILURE_CLASSES = [", "] as const;")
    if not classes or "'outcome_unknown'" in classes or "unknown" in classes:
        errs.append("fallbacks name typed failures only; an unknown external outcome is never one")
    outbox = read(P("packages/platform/src/outbox.ts"))
    if "input.context.effectivePrincipal.type === 'automation'" not in outbox:
        errs.append("the outbox must derive the automation actor from the trusted context")
    jobs = read(P("packages/platform/src/jobs.ts"))
    if "reason: 'delay'" not in jobs or "state: 'skipped'" not in jobs:
        errs.append("JobResult must carry the delay wait and the skipped outcome")
    worker = read(P("apps/worker/src/registry.ts"))
    for term in ("automationRunHandler(m.automations)", "automationSweepHandler(m.automations)",
                 "new AutomationTriggerConsumer(deps.automations)", "new AutomationOutcomeConsumer(deps.automations)"):
        if term not in worker:
            errs.append("the worker must register %s" % term)
    routes = read(P("apps/api/src/work/routes.ts"))
    if "registerAutomations(app, work)" not in routes:
        errs.append("the API must register the automation routes")
    gateway = read(P("packages/work/src/ai/ai-gateway-service.ts"))
    ai = block(gateway, "  protected async startAutomationAiRun(", "\n  }\n")
    if not ai or ai.find("#availability") < 0 or ai.find("#availability") > ai.find("#createRun"):
        errs.append("automation AI runs must check availability before creating anything")
    if "provider.complete(" in service or "new MessagesProvider(" in service:
        errs.append("the automation engine must never reach a provider directly")
    return errs, "no code evaluation or direct business writes; gateway chain; P8-W0 effects; consumers, jobs, routes"


def check_migration():
    errs = []
    up, down = read(P(UP)), read(P(DOWN))
    for t in TABLES:
        for term in ("CREATE TABLE automation.%s (" % t, "ALTER TABLE automation.%s FORCE ROW LEVEL SECURITY;" % t):
            if term not in up:
                errs.append("0062 lacks %s" % term)
    for term in ("-- migrate:phase expand", "CREATE TRIGGER automation_revision_immutable",
                 "CREATE UNIQUE INDEX automation_step_run_once", "DEFERRABLE",
                 "CREATE FUNCTION access.bump_permission_epoch(", "CREATE FUNCTION exec_dispatch.discover_automation_due(",
                 "'automation_notice'", "caller_kind IN ('ui', 'api', 'mcp', 'automation')"):
        if term not in up:
            errs.append("0062 up lacks %s" % term)
    if re.search(r"GRANT\s+(ALL|UPDATE)\s+ON\s+work\.task\b", up) or re.search(r"brand_id\s*[,)].*ON work\.task TO app_worker", up):
        errs.append("0062 must grant the worker only the columns the canonical commands write")
    for term in ("Restores the exact 0061 catalog", "0062 cannot be rolled back", "DROP SCHEMA automation"):
        if term not in down:
            errs.append("0062 down lacks %s" % term)
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    # Later migrations are held by later validators (8B adds 0064, held by phase8b.py).
    later_owned = {"0064_agent_profiles_connectors.up.sql": "phase8b.py",
                   "0065_agent_runs.up.sql": "phase8c.py"}
    tail = [n for n in names if n > "0063_automation_checkpoint_refs.up.sql"]
    if "0062_automation_engine.up.sql" not in names or "0063_automation_checkpoint_refs.up.sql" not in names or any(
            n not in later_owned or not os.path.isfile(P("docs/engineering/tools/%s" % later_owned[n])) for n in tail):
        errs.append("0062_automation_engine and 0063_automation_checkpoint_refs must be the last migrations (or held by a later validator)")
    up63 = read(P("packages/db/migrations/0063_automation_checkpoint_refs.up.sql"))
    down63 = read(P("packages/db/migrations/0063_automation_checkpoint_refs.down.sql"))
    for term in ("-- migrate:phase expand", "ALTER TABLE exec.job NO FORCE ROW LEVEL SECURITY;",
                 "- 'envelope' - 'subscriptionId' - 'fingerprint'", "WHERE j.kind = 'automation.run'",
                 "ALTER TABLE exec.job FORCE ROW LEVEL SECURITY;"):
        if term not in up63:
            errs.append("0063 up lacks %s" % term)
    if re.search(r"external_effect|attempt_count|DROP |GRANT |REVOKE ", up63):
        errs.append("0063 changes checkpoint content only (never effects, attempts, or the catalog)")
    if "Restores the exact 0062 catalog" not in down63:
        errs.append("0063 down must restore the exact 0062 catalog")
    errs += phase1.check_boundaries([62, 63])
    platform = read(P("packages/work/test/integration/automations-platform.test.ts"))
    for idx in ("automation_listening", "automation_run_occurrence_unique", "automation_run_by_automation",
                "automation_run_open", "trigger_schedule_due"):
        if idx not in platform or "EXPLAIN at 2,000 automations and 5,000 runs" not in platform:
            errs.append("the volume EXPLAIN test must prove %s is used" % idx)
    mt = read(P("packages/db/test/integration/migrations.test.ts"))
    if "62" not in re.findall(r"\b62\b", mt) or "63" not in re.findall(r"\b63\b", mt):
        errs.append("the migration tests must cover the 0062 and 0063 boundaries")
    if "0063 removes payload copies from automation checkpoints" not in mt:
        errs.append("the migration tests must prove the 0063 checkpoint cleanup")
    return errs, "seven forced-RLS tables, immutable revisions, guarded exact rollback, boundaries 62 and 63, plans at volume"


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
            errs.append("%s must cover an 8A threat" % at)
        if len(seen.get(at, [])) != 1:
            errs.append("%s must title exactly one test (found %d)" % (at, len(seen.get(at, []))))
    for term in ("T-142–T-151", "AT-552–AT-594", "ADR-51, AZ-51, PL-53, UXD-32"):
        if term not in adr:
            errs.append("ADR-0046 must cite %s" % term)
    for path, anchor in (("docs/architecture/data/12-decisions.md", "adr-51"), ("docs/architecture/access/15-decisions.md", "az-51"),
                         ("docs/architecture/platform/19-decisions.md", "pl-53"), ("docs/ux/09-decisions-and-risks.md", "uxd-32")):
        if '<a id="%s"></a>' % anchor not in read(P(path)):
            errs.append("%s lacks the %s anchor" % (path, anchor))
    model = {e["name"]: e for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    for name in ("automation", "automation_revision", "automation_run", "automation_step_run",
                 "automation_standing_approval", "automation_trigger_schedule", "automation_usage_period"):
        if name not in model:
            errs.append("0B lacks the %s entity" % name)
    if "automation_version" in model:
        errs.append("0B automation_version must be reconciled as automation_revision")
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    params = {x["name"]: x for x in registry["parameters"]}
    envdoc = read(P("docs/engineering/environments.md"))
    server = read(P("packages/config/src/server.ts"))
    for name in PARAMS:
        if params.get(name, {}).get("owner") != "8A":
            errs.append("0D must register %s (owner 8A)" % name)
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
    if not any(x["type"] == "automation_notice" for x in registry["notification_types"]):
        errs.append("0D must register the automation_notice notification type")
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for ty in ("automations", "automation_templates", "automation_revisions", "automation_preview", "automation_run",
               "automation_runs", "automation_usage", "automation_health"):
        if "'%s'," % ty not in envelopes:
            errs.append("non-resource type %s is not registered" % ty)
    return errs, "T-142..T-151, AT-552..AT-594 titled once, ADR-51/AZ-51/PL-53/UXD-32, 0B entities, 16 limits, contracts"


def check_closure_and_boundaries(closure):
    errs = []
    # The architect accepted 8A with review 01 (recorded by the 8B brief, never self-accepted):
    # engineering scope only, keeping the no-exactly-once, production, manual, and 0063 boundaries.
    if closure.get("adr") != "0046" or closure.get("status") != "accepted":
        errs.append("closure-8a.json must be the accepted 8A closure under ADR-0046")
    acc = closure.get("accepted", {})
    if (acc.get("head") != "802c0265ca2a40e50fc5fea35b866c895c00fe10" or acc.get("ci_run") != "39401581014"
            or acc.get("attempt") != 1 or acc.get("totals") != {"unit_component": 967, "integration": 1108,
                                                                 "process_smoke": 6, "browser": 286}
            or acc.get("corrective_reviews_closed") != ["R1", "R2", "R3"]
            or "exactly-once" not in acc.get("boundaries", "")
            or "pre-correction" not in acc.get("deployment_restriction", "")):
        errs.append("the closure must record the architect's acceptance (802c026, run 39401581014, attempt 1, totals, R1-R3, boundaries, the 0063 restriction)")
    adr = read(P(ADR))
    status = next((l for l in adr.split("\n") if l.startswith("Status: ")), "")
    if not (status.startswith("Status: **accepted** (engineering scope") and "802c026" in status
            and "39401581014" in status and "not production" in status and "exactly-once" in status
            and "pre-correction" in status):
        errs.append("ADR-0046 must record the architect's acceptance at 802c026, run 39401581014, without production approval, keeping the 0063 restriction")
    for d in DECISIONS:
        if "\n| %s |" % d not in adr:
            errs.append("ADR-0046 lacks decision %s" % d)
    got = {b["id"] for b in closure.get("boundaries", [])}
    for b in BOUNDARIES:
        if b not in got:
            errs.append("the closure must record the %s boundary" % b)
    for term in ("**9B, 8C:**", "**10A:**", "**10B:**", "**Production AI:**", "**No exactly-once delivery:**",
                 "**Manual:**", "REL-FU-P7-01 and TEST-FU-P7-02"):
        if term not in adr:
            errs.append("ADR-0046 must state %s" % term)
    reqs = {r["id"]: r for r in closure.get("requirements", [])}
    if reqs.get("AUTO-007", {}).get("disposition") != "foundation" or reqs.get("AUTO-007", {}).get("deferred_to") != ["8C"]:
        errs.append("AUTO-007 is a typed boundary only: foundation, deferred to 8C")
    for rid in ("AUTO-003", "AUTO-018"):
        if not reqs.get(rid, {}).get("enriched_by"):
            errs.append("%s must name the later phase that completes it" % rid)
    cache = {}
    hand = {h["id"]: h for h in closure.get("handoffs", [])}
    for hid in ("NTF-005", "DATA-013"):
        if hid not in hand:
            errs.append("the closure must record the %s hand-off from an earlier phase" % hid)
        else:
            phase2.check_evidence("hand-off %s" % hid, hand[hid].get("evidence"), cache, errs)
    p8 = load(P("docs/engineering/phase8/closure-p8w0.json"))
    if p8.get("status") != "accepted" or p8.get("accepted", {}).get("ci_run") != "39234366133":
        errs.append("the P8-W0 acceptance (run 39234366133) must be recorded before 8A builds on it")
    return errs, "accepted at 802c026 (run 39401581014); boundaries 9B/8C/10A/10B, production AI, no exactly-once, manual, 0063 restriction, follow-ups"


def check_review01(closure):
    """Corrective review 01: no status-only proof, reference-only checkpoints with authority at
    dispatch, and replays through current authority, each with its recorded old-code failure."""
    errs = []
    cache = {}
    api = read(P("packages/work/src/integrations/public-api-service.ts"))
    sender = block(api, "  protected async sendAutomationWebhook(", "\n  }\n")
    if not sender or "rejected_by_receiver" in sender or "result.status < 500" in sender:
        errs.append("R1: after dispatch, only a 2xx is sent; no status is proof of non-application")
    if "throw new EffectOutcomeUnknownError();" not in sender:
        errs.append("R1: any other answer must be an unknown outcome")
    service = read(P(SERVICE))
    advance = block(service, "type Advance =", "\n\n")
    if "envelope" in advance or "| { kind: 'effect'; node: string; logicalKey: string };" not in advance:
        errs.append("R2: the effect checkpoint must hold references only (step and logical key)")
    job = block(service, "  async runAutomationJob(", "\n  async #effectSent(")
    effect = block(job, "await ctx.effect(", "\n        });")
    if "this.#dispatchPlan(ctx, runId, a.node, a.logicalKey)" not in effect or "a.envelope" in job:
        errs.append("R2: the dispatch callback must re-decide authority and build the payload in memory")
    plan = block(service, "  async #dispatchPlan(", "\n  async #refuseDispatch(")
    for term, label in [("this.#runRow(tx, runId, true)", "the locked run"),
                        ("return refuse('automation_disabled');", "the automation's state"),
                        ("inflight.logical_key !== logicalKey", "the logical key binding"),
                        ("this.#runPrincipal(tx, run, revision)", "the owner's current authority"),
                        ("this.#targets(tx, authority.p, run, revision, node)", "the target through current authority"),
                        ("this.#webhookPlan(tx, authority.p, run, revision, node, t)", "the approval and destination")]:
        if term not in plan:
            errs.append("R2: the dispatch decision lacks %s" % label)
    life = block(service, "  async automationLifecycle(", "\n  async listAutomationRevisions(")
    render = life[life.find("// A completed key renders"):]
    if "this.#decideScope(tx, p, 'automations.configure', a.brand_id)" not in render or "executeTakeFirstOrThrow" in render:
        errs.append("R3: the lifecycle replay must decide current authority and stay opaque")
    for name in ("  async activateAutomation(", "  async reassignAutomation("):
        body = block(service, name, "return this.mutate(")
        if "this.#sessionOnly(caller);" not in body:
            errs.append("R3: %s must refuse delegated callers before idempotency work" % name.strip())
    if service.count("async (tx, p, ref) => this.#automationView(tx, p, await this.#visible(tx, p, ref.id))") or \
            service.count("async (tx, p, ref) => this.#runView(tx, p, ref.id),"):
        errs.append("R3: every renderer must decide the command's own authority")
    crs = {r["id"]: r for r in closure.get("corrective_reviews", [])}
    cr = crs.get("8A-CR-01")
    if not cr or cr.get("reviewed_head") != "6eefaee461d02df8897c1817a9e735feab53f91b":
        errs.append("the closure must record corrective review 8A-CR-01 on 6eefaee")
    else:
        groups = {g["id"]: g for g in cr.get("groups", [])}
        for gid in ("R1", "R2", "R3"):
            g = groups.get(gid)
            if not g:
                errs.append("8A-CR-01 lacks %s" % gid)
                continue
            phase2.check_evidence("8A-CR-01 %s" % gid, g.get("evidence"), cache, errs)
            if "fails on 6eefaee" not in g.get("old_code", ""):
                errs.append("8A-CR-01 %s must record its observed old-code result" % gid)
    if "## Corrective review 01 (8A-CR-01)" not in read(P(ADR)):
        errs.append("ADR-0046 must record corrective review 01")
    return errs, "R1 2xx-only acknowledgment, R2 reference checkpoints and dispatch-time authority, R3 replay authority; old-code results"


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase8a.py" not in verify:
        errs.append("verify.sh (and so preflight) must run phase8a.py in the core gate")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase8a") != "python3 docs/engineering/tools/phase8a.py":
        errs.append("package.json lacks validate:phase8a")
    readme = read(P("docs/engineering/README.md"))
    for term in ("0046-automation-engine.md", "phase8a.py", "automations.md"):
        if term not in readme:
            errs.append("the engineering index must list %s" % term)
    if not re.search(r"\|automations[|)]", read(P("playwright.config.ts"))):
        errs.append("the tablet project must run the 8A journeys")
    if "## Phase 8A: automation engine" not in read(P("docs/engineering/database.md")):
        errs.append("docs/engineering/database.md must record migration 0062")
    if not os.path.isfile(P("docs/engineering/automations.md")):
        errs.append("the automation operator notes are missing")
    web = read(P("apps/web/src/shell/registry.ts"))
    if "extraCommand: 'go.automations'" not in web:
        errs.append("Automations must be a navigation entry and palette command")
    return errs, "verify.sh, package.json, the engineering index, the tablet project, database and operator notes, navigation"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P(CLOSURE))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 8A: requirement closure", phase2.check_closure(catalog, closure, subphases, SUBPHASE, DECISIONS)),
        ("phase 8A: closure, ADR status, and boundaries", check_closure_and_boundaries(closure)),
        ("phase 8A: the compiler at runtime", check_runtime()),
        ("phase 8A: one engine on the platform", check_engine()),
        ("phase 8A: migration 0062", check_migration()),
        ("phase 8A: identifiers, contracts, and limits", check_identifiers()),
        ("phase 8A: corrective review 01", check_review01(closure)),
        ("phase 8A: wiring", check_wiring()),
        ("phase 8A: migration sequence", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 8A CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
