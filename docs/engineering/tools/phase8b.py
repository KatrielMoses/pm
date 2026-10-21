#!/usr/bin/env python3
"""Phase 8B agent profiles, connectors, and scoped task assignments: closure validator (ADR-0047).

Usage (from the repository root, after `pnpm install`):
    python3 docs/engineering/tools/phase8b.py      # exit 1 on any failure

Runtime-backed: besides the closure, contracts, migration, and wiring checks, it runs the real
configuration compiler, endpoint guard, and manifest parser (phase8b-probe.ts under Node) and
checks their behavior: every starter template compiles to a conservative draft with its missing
configuration named, an empty scope means nothing, unregistered or weaker configuration is refused,
R3/R4 always need a human, unsafe endpoints and bad manifests are refused. The configured limits
are compared across the runtime defaults, the configuration ranges, the 0D registry, and the
environment contract.
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

SUBPHASE = "8B"
DECISIONS = ["D%d" % i for i in range(1, 20)]
ADR = "docs/engineering/adr/0047-agent-profiles-connectors.md"
CLOSURE = "docs/engineering/phase8/closure-8b.json"
SERVICE = "packages/work/src/agents/service.ts"
MODULE = "packages/work/src/agents"
UP = "packages/db/migrations/0064_agent_profiles_connectors.up.sql"
DOWN = "packages/db/migrations/0064_agent_profiles_connectors.down.sql"
PROBE = "docs/engineering/tools/phase8b-probe.ts"
THREATS = ["T-%d" % i for i in range(152, 164)]
TESTS = ["AT-%d" % i for i in range(595, 643)]
TABLES = ["agent_profile", "agent_profile_revision", "agent_scope_grant", "agent_tool_grant", "agent_connector",
          "agent_connector_test", "agent_assignment", "agent_assignment_revision"]
TEMPLATES = ["development", "research", "growth", "documentation", "testing"]
UNAVAILABLE_TOOLS = {"pm.tests.run": "9B", "github.pull_requests.open": "9A"}
BOUNDARIES = ["8C", "8D", "10A", "10B", "PRODUCTION-CONNECTORS", "PRODUCTION-AI", "MANUAL", "REL-FU-P7-01",
              "TEST-FU-P7-02"]
PARAMS = ["AGENT_PROFILES_PER_WORKSPACE_MAX", "AGENT_INSTRUCTIONS_MAX_CHARS", "AGENT_SCOPE_GRANTS_MAX",
          "AGENT_TOOL_GRANTS_MAX", "AGENT_CONFIG_BYTES_MAX", "AGENT_ASSIGNMENTS_PER_TASK_MAX", "AGENT_CONTEXT_REFS_MAX",
          "AGENT_CRITERIA_MAX", "AGENT_ASSIGNMENT_TEXT_MAX_CHARS", "AGENT_CONNECTOR_TIMEOUT_MS",
          "AGENT_CONNECTOR_RESPONSE_MAX_BYTES", "AGENT_CONNECTOR_TESTS_PER_HOUR"]
ENVELOPES = ["agent_profiles", "agent_templates", "agent_tools", "agent_profile_revisions", "agent_connector_test",
             "agent_assignment_preview", "agent_assignment", "agent_assignments"]


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
    """Run the real compiler, guard, and parser and check what they do."""
    errs = []
    try:
        out = subprocess.run(["node", "--conditions=@pm/source", P(PROBE)], cwd=P("."), capture_output=True,
                             text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return ["the configuration probe could not run (%s); run `pnpm install` first" % exc], ""
    if out.returncode != 0:
        return ["the configuration probe failed: %s" % (out.stderr.strip().splitlines() or ["?"])[-1]], ""
    try:
        d = json.loads(out.stdout)
    except ValueError:
        return ["the configuration probe printed no JSON"], ""
    if d.get("protocol") != "pm-agent/1":
        errs.append("the connector protocol must be pm-agent/1")
    if sorted(d["templates"]) != sorted(TEMPLATES):
        errs.append("the starter templates must be exactly %s (AGT-008)" % TEMPLATES)
    classes = d["classes"]
    for key, t in d["templates"].items():
        if not t.get("ok") or t.get("unavailable"):
            errs.append("starter template %s must compile with no unavailable tool (%s)" % (key, t.get("codes")))
            continue
        if any(t["scope"][k] for k in t["scope"]):
            errs.append("starter template %s must start with an empty scope" % key)
        need = ["scope", "model"] if t["kind"] == "internal" else ["scope", "connector"]
        if t.get("missing") != need:
            errs.append("starter template %s must name %s as missing (got %s)" % (key, need, t.get("missing")))
        for name, cls, approval in t["tools"]:
            if classes[cls]["risk"] not in ("R0", "R1"):
                errs.append("starter template %s grants %s (%s): templates stay conservative" % (key, name, cls))
            order = ["none", "low_impact_policy", "review_required", "human_approval"]
            if order.index(approval) < order.index(classes[cls]["minimum"]):
                errs.append("starter template %s weakens %s below its floor" % (key, cls))
    for cls, c in classes.items():
        if c["risk"] in ("R3", "R4") and c["minimum"] != "human_approval":
            errs.append("tool class %s (%s) must always need a human approval" % (cls, c["risk"]))
    unavailable = {t["name"]: t["owner"] for t in d["tools"] if t["status"] == "unavailable"}
    if unavailable != UNAVAILABLE_TOOLS:
        errs.append("unavailable tools must be %s (got %s)" % (UNAVAILABLE_TOOLS, unavailable))
    for t in d["tools"]:
        if t["class"] not in classes:
            errs.append("tool %s names an unknown class %s" % (t["name"], t["class"]))
    p = d["probes"]
    if not p["empty_scope"].get("ok") or "scope" not in p["empty_scope"].get("missing", []):
        errs.append("an empty scope must compile as nothing and be named missing (never all)")
    expect = {
        "unregistered_tool": "/tools/0:unregistered_tool",
        "wrong_version": "/tools/0:unregistered_tool",
        "weaker_approval": "/approval_policy/update_records:weaker_than_policy",
        "r3_weaker": "/approval_policy/publish:weaker_than_policy",
        "unknown_field": "/run:unknown_field",
        "everything_scope": "/scope/everything:unknown_field",
    }
    for name, code in expect.items():
        if p[name].get("ok") or code not in p[name].get("codes", []):
            errs.append("the compiler must refuse %s with %s (got %s)" % (name, code, p[name]))
    if p["unavailable_tool"].get("unavailable") != ["9B"]:
        errs.append("a later-phase tool must compile as an unavailable boundary (9B)")
    e = d["endpoints"]
    if not e["public_https"].get("ok"):
        errs.append("a public https endpoint must pass the guard")
    for k, code in (("plain_http", "invalid_url"), ("private", "private_address"), ("metadata", "private_address"),
                    ("loopback", "private_address"), ("credentials", "invalid_url"), ("own", "own_endpoint")):
        if e[k].get("ok") or e[k].get("code") != code:
            errs.append("the endpoint guard must refuse %s with %s (got %s)" % (k, code, e[k]))
    m = d["manifests"]
    if m["ok"] is not True:
        errs.append("a well-formed manifest must be accepted")
    for k, code in (("wrong_protocol", "protocol_unsupported"), ("wrong_version", "version_unsupported"),
                    ("wrong_nonce", "nonce_mismatch")):
        if m[k].get("code") != code:
            errs.append("the manifest parser must refuse %s with %s" % (k, code))
    if d["credentials"] != {"pm": True, "oac": True, "other": False}:
        errs.append("the product's own credentials must be recognized and refused as connector secrets")
    return errs, "%d templates conservative; floors; refusals; endpoint guard; manifests; own credentials" % len(d["templates"])


def check_service():
    errs = []
    src = module_sources()
    service = src.get(SERVICE, "")
    for rel, text in src.items():
        if re.search(r"\b(eval|new Function)\(", text):
            errs.append("%s must not evaluate code" % rel)
        if rel != "%s/connectors.ts" % MODULE and re.search(r"\bfetch\(", text):
            errs.append("%s must not call the network (only connectors.ts handshakes)" % rel)
        if re.search(r"(insertInto|updateTable|deleteFrom)\('(work|collab|relations|workflow)\.", text):
            errs.append("%s writes business tables directly" % rel)
        if re.search(r"\bsql\.raw\(", text):
            errs.append("%s builds raw SQL" % rel)
        if re.search(r"api_token|mcp_access_token|oauth.*token.*insert", text, re.I):
            errs.append("%s must not mint tokens or credentials" % rel)
    factory = read(P("packages/work/src/factory.ts"))
    if "return new AgentService(" not in factory or "export class AgentService extends AutomationService" not in service:
        errs.append("AgentService must extend the automation engine and be the chain head the factory returns")
    if ".register(agentProfileOwnerHook)" not in factory:
        errs.append("the factory must register the agent owner hook")
    for term, label in [
        ("export const AGENT_CONNECTOR_TEST_DESTINATION = defineEffectDestination(\n  'agents.connector_test',\n  'naturally_idempotent',",
         "the registered connector test destination"),
        ("#sessionOnly(caller", "session-only configuration"),
        ("#assignScope(caller", "the agents:execute check"),
        ("async startAgentRun(", "the refused run endpoint"),
        ("pg_advisory_xact_lock", "the profile limit lock"),
        ("'owner_authority'", "owner authority readiness"),
    ]:
        if term not in service:
            errs.append("the agent service lacks %s" % label)
    run = block(service, "  async startAgentRun(", "\n  }\n")
    if "execution_unavailable" not in run and "dependency_unavailable" not in run:
        errs.append("execution must be refused until 8C")
    for name in ("  async createAgentProfile(", "  async updateAgentProfile(", "  async activateAgentProfile(",
                 "  async reassignAgentProfile(", "  async configureAgentConnector(", "  async testAgentConnector(",
                 "  async disconnectAgentConnector(", "  async duplicateAgentProfile(", "  async agentProfileLifecycle(",
                 "  async disableAgentProfile("):
        body = block(service, name, "return this.mutate(")
        if not body or "this.#sessionOnly(caller);" not in body:
            errs.append("%s must refuse delegated callers before idempotency work" % name.strip())
    for name in ("  async previewAgentAssignment(", "  async assignAgent(", "  async updateAgentAssignment(",
                 "  async withdrawAgentAssignment("):
        body = service[service.find(name):service.find(name) + 600] if name in service else ""
        if "this.#assignScope(caller);" not in body:
            errs.append("%s must require agents:execute of a delegated caller" % name.strip())
    gate = read(P("apps/api/src/auth/routes.ts"))
    if "agent(s|-templates|-tools)" not in gate or "agents:execute" not in gate:
        errs.append("the bearer gate must refuse tokens on agent configuration and need agents:execute for assignment")
    worker = read(P("apps/worker/src/registry.ts"))
    if "agentConnectorTestHandler(" not in worker:
        errs.append("the worker must register the connector test handler")
    routes = read(P("apps/api/src/work/routes.ts"))
    if "registerAgents(app, work)" not in routes:
        errs.append("the API must register the agent routes")
    server = read(P("packages/config/src/server.ts"))
    if "AGENT_CONNECTOR_TRANSPORT: the agent connector fixture is refused in deployed environments" not in server:
        errs.append("deployed environments must refuse the fixture connector transport")
    return errs, "no code evaluation, network outside handshakes, or minted credentials; chain head; session-only; 8C refused"


def check_migration():
    errs = []
    up, down = read(P(UP)), read(P(DOWN))
    for t in TABLES:
        for term in ("CREATE TABLE agents.%s (" % t, "ALTER TABLE agents.%s FORCE ROW LEVEL SECURITY;" % t):
            if term not in up:
                errs.append("0064 lacks %s" % term)
    for term in ("-- migrate:phase expand", "CREATE TRIGGER agent_profile_revision_immutable",
                 "CREATE TRIGGER agent_scope_grant_immutable", "CREATE TRIGGER agent_tool_grant_immutable",
                 "CREATE TRIGGER agent_assignment_revision_immutable", "CREATE UNIQUE INDEX agent_assignment_active",
                 "REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)"):
        if term not in up:
            errs.append("0064 up lacks %s" % term)
    if re.search(r"secret\b(?!_ref)\s+text", up):
        errs.append("0064 must store secret references only, never secrets")
    for term in ("Restores the exact 0063 catalog", "0064 cannot be rolled back", "DROP SCHEMA agents"):
        if term not in down:
            errs.append("0064 down lacks %s" % term)
    names = sorted(n for n in os.listdir(P("packages/db/migrations")) if n.endswith(".up.sql"))
    if names[-1] != "0064_agent_profiles_connectors.up.sql":
        errs.append("0064_agent_profiles_connectors must be the last migration")
    errs += phase1.check_boundaries([64])
    mt = read(P("packages/db/test/integration/migrations.test.ts"))
    if "64" not in re.findall(r"\b64\b", mt) or "0064 cannot be rolled back" not in mt:
        errs.append("the migration tests must cover the 0064 boundary and its guarded rollback")
    volume = read(P("packages/work/test/integration/agents-volume.test.ts"))
    for idx in ("agent_assignment_by_task", "agent_assignment_by_profile", "agent_scope_grant_by_target",
                "agent_connector_test_by_connector"):
        if idx not in volume or "EXPLAIN at 2,000 profiles and 5,000 assignments" not in volume:
            errs.append("the volume EXPLAIN test must prove %s is used" % idx)
    for path in ("packages/platform/test/integration/rls.test.ts", "packages/db/test/integration/workspace-integrity.test.ts"):
        text = read(P(path))
        for t in TABLES:
            if "'agents.%s'" % t not in text:
                errs.append("%s must list agents.%s" % (path, t))
    return errs, "eight forced-RLS tables, immutable revisions, guarded exact rollback, boundary 64, plans at volume"


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
            errs.append("%s must cover an 8B threat" % at)
        if len(seen.get(at, [])) != 1:
            errs.append("%s must title exactly one test (found %d)" % (at, len(seen.get(at, []))))
    for term in ("T-152–T-163", "AT-595–AT-642", "ADR-52, AZ-52, PL-54, UXD-33"):
        if term not in adr:
            errs.append("ADR-0047 must cite %s" % term)
    for path, anchor in (("docs/architecture/data/12-decisions.md", "adr-52"), ("docs/architecture/access/15-decisions.md", "az-52"),
                         ("docs/architecture/platform/19-decisions.md", "pl-54"), ("docs/ux/09-decisions-and-risks.md", "uxd-33")):
        text = read(P(path))
        if '<a id="%s"></a>' % anchor not in text:
            errs.append("%s lacks the %s anchor" % (path, anchor))
    model = {e["name"]: e for e in load(P("docs/architecture/data/model/model.json"))["entities"]}
    for name in ("agent_profile", "agent_profile_revision", "agent_scope_grant", "agent_tool_grant", "agent_connector",
                 "agent_connector_test", "agent_assignment", "agent_assignment_revision"):
        if name not in model:
            errs.append("0B lacks the %s entity" % name)
        elif "ADR-52" not in model[name].get("notes", ""):
            errs.append("0B %s must cite ADR-52" % name)
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    if not any(o["kind"] == "agent_connector_test" and o["detail_entity"] == "agents.agent_connector_test"
               for o in registry["operation_kinds"]):
        errs.append("0D must register the agent_connector_test operation kind")
    params = {x["name"]: x for x in registry["parameters"]}
    envdoc = read(P("docs/engineering/environments.md"))
    server = read(P("packages/config/src/server.ts"))
    for name in PARAMS:
        if params.get(name, {}).get("owner") != "8B":
            errs.append("0D must register %s (owner 8B)" % name)
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
    if params.get("AGENT_CONNECTOR_TRANSPORT", {}).get("owner") != "8B" or "| `AGENT_CONNECTOR_TRANSPORT` |" not in envdoc:
        errs.append("AGENT_CONNECTOR_TRANSPORT must be registered (0D) and documented")
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for ty in ENVELOPES:
        if "'%s'," % ty not in envelopes:
            errs.append("non-resource type %s is not registered" % ty)
    policy = {a["key"]: a for a in load(P("docs/architecture/access/policy/policy.json"))["actions"]}
    for key in ("agents.configure", "agent.assign"):
        if "AZ-52" not in policy.get(key, {}).get("notes", ""):
            errs.append("0C %s must cite AZ-52" % key)
    tools = load(P("docs/architecture/platform/contracts/agent-tools.json"))
    if not tools:
        errs.append("the agent tool registry source is missing")
    return errs, "T-152..T-163, AT-595..AT-642 titled once, ADR-52/AZ-52/PL-54/UXD-33, 0B entities, 12 limits and the transport, contracts"


def check_closure_and_boundaries(closure):
    errs = []
    # The architect accepted 8B with review 01 (recorded by the 8C brief, never self-accepted):
    # engineering scope only; derived blocks are not stored suspensions.
    if closure.get("adr") != "0047" or closure.get("status") != "accepted":
        errs.append("closure-8b.json must be the accepted 8B closure under ADR-0047")
    acc = closure.get("accepted", {})
    if (acc.get("head") != "e51b3f19ecf215e296d08c12c14649a4e1b2565d" or acc.get("ci_run") != "39502523692"
            or acc.get("attempt") != 1 or acc.get("corrective_reviews_closed") != ["R1", "R2"]
            or acc.get("totals", {}).get("integration") != 1150 or acc.get("totals", {}).get("browser") != 291
            or "not stored suspensions" not in acc.get("boundaries", "")):
        errs.append("the closure must record the architect's acceptance (e51b3f1, run 39502523692, attempt 1, totals, R1-R2, boundaries)")
    adr = read(P(ADR))
    status = next((l for l in adr.split("\n") if l.startswith("Status: ")), "")
    if not (status.startswith("Status: **accepted** (engineering scope") and "e51b3f1" in status
            and "39502523692" in status and "not production" in status and "not stored suspensions" in status):
        errs.append("ADR-0047 must record the architect's acceptance at e51b3f1, run 39502523692, without production approval")
    for d in DECISIONS:
        if "\n| %s |" % d not in adr:
            errs.append("ADR-0047 lacks decision %s" % d)
    got = {b["id"] for b in closure.get("boundaries", [])}
    for b in BOUNDARIES:
        if b not in got:
            errs.append("the closure must record the %s boundary" % b)
    for term in ("**8C:**", "**8D:**", "**10A:**", "**10B:**", "**Production connectors:**", "**Production AI:**",
                 "**Manual:**", "REL-FU-P7-01 and TEST-FU-P7-02", "Assigned; execution available in Phase 8C"):
        if term not in adr:
            errs.append("ADR-0047 must state %s" % term)
    reqs = {r["id"]: r for r in closure.get("requirements", [])}
    for rid in ("AGT-003", "AGT-004", "AGT-006", "AGT-007", "TSK-008"):
        if "8C" not in (reqs.get(rid, {}).get("enriched_by") or []):
            errs.append("%s must name 8C for its runtime portion" % rid)
    if "10B" not in (reqs.get("AGT-008", {}).get("enriched_by") or []):
        errs.append("AGT-008 must name 10B for the catalog")
    a8 = load(P("docs/engineering/phase8/closure-8a.json"))
    if a8.get("status") != "accepted" or a8.get("accepted", {}).get("ci_run") != "39401581014":
        errs.append("the 8A acceptance (run 39401581014) must be recorded before 8B builds on it")
    if closure.get("base", {}).get("head") != "802c0265ca2a40e50fc5fea35b866c895c00fe10":
        errs.append("the closure base must be the accepted 8A head 802c026")
    web = read(P("apps/web/src/agents/pages.tsx"))
    if "Assigned; execution available in Phase 8C." not in web:
        errs.append("the task Agent section must say execution is available in Phase 8C")
    return errs, "accepted at e51b3f1 (run 39502523692); boundaries 8C/8D/10A/10B, production connectors and AI, manual, follow-ups"


def check_review01(closure):
    """8B-CR-01: hidden scope is omitted (R1); one assignment eligibility rule (R2)."""
    errs = []
    cache = {}
    service = read(P(SERVICE))
    scope = block(service, "  async #scopeView(", "\n  }\n")
    if not scope or "not_shown" in service or "hidden" in scope or "return { items: out };" not in scope:
        errs.append("R1: the scope renderer must omit hidden items with no count or flag")
    web = read(P("apps/web/src/agents/pages.tsx")) + read(P("apps/web/src/agents/client.ts"))
    if "not_shown" in web or "you cannot open." in web.replace("No items you can open.", ""):
        errs.append("R1: the web app must not render a hidden count")
    if "decision.reasons.map((r) => (ASSIGNMENT_REASONS.has(r) ? r : 'agent_not_ready'))" not in service:
        errs.append("R1: profile facts must collapse to agent_not_ready for readers who cannot configure")
    elig = block(service, "  async #assignerEligibility(", "\n  }\n")
    for term, label in [("this.loadTask(tx, assigner, rec.public_id)", "the task loaded as the original assigner"),
                        ("this.#requireAssignable(assigner, t)", "the shared agent.assign and lifecycle rule"),
                        ("rec.lifecycle_state !== 'active'", "task lifecycle eligibility")]:
        if term not in elig:
            errs.append("R2: assigner eligibility lacks %s" % label)
    decide = block(service, "  async #decide(", "\n  /**")
    if "this.#assignerEligibility(tx, assigner, a.task_id)" not in decide or "'scope_lost'" not in decide:
        errs.append("R2: readiness must use the shared eligibility rule and the live ceiling")
    for name in ("  async previewAgentAssignment(", "  async assignAgent(", "  async updateAgentAssignment("):
        body = service[service.find(name):service.find(name) + 900] if name in service else ""
        if "this.#requireAssignable(p, t);" not in body:
            errs.append("R2: %s must use the shared eligibility rule" % name.strip())
    if "protected async agentAssignmentEligibility(" not in service:
        errs.append("R2: the 8C handoff must be the shared decision")
    if "agentAssignmentEligibility(tx, task, profile)" not in read(P(ADR)):
        errs.append("ADR-0047 D18 must name the 8C handoff")
    crs = {r["id"]: r for r in closure.get("corrective_reviews", [])}
    cr = crs.get("8B-CR-01")
    if not cr or cr.get("reviewed_head") != "96f640dc20f114ad8d1de2c61bb33d9b7bf6ed85":
        errs.append("the closure must record corrective review 8B-CR-01 on 96f640d")
    else:
        groups = {g["id"]: g for g in cr.get("groups", [])}
        for gid in ("R1", "R2"):
            g = groups.get(gid)
            if not g:
                errs.append("8B-CR-01 lacks %s" % gid)
                continue
            phase2.check_evidence("8B-CR-01 %s" % gid, g.get("evidence"), cache, errs)
            if "fails on 96f640d" not in g.get("old_code", ""):
                errs.append("8B-CR-01 %s must record its observed old-code result" % gid)
    if "## Corrective review 01 (8B-CR-01)" not in read(P(ADR)):
        errs.append("ADR-0047 must record corrective review 01")
    # The accepted records describe omission: no decision row, UX rule, or operator note encodes a
    # hidden counter (the review table may name the old field when describing the finding).
    adr = read(P(ADR))
    rows = "\n".join(l for l in adr.split("\n") if re.match(r"^\| D\d+ \|", l))
    ux = block(read(P("docs/ux/09-decisions-and-risks.md")), '<a id="uxd-33"></a>', "## 4.")
    for label, text in (("ADR-0047 decisions", rows), ("UXD-33", ux), ("agents.md", read(P("docs/engineering/agents.md")))):
        if re.search(r"others (are )?counted|not_shown|\bmore items? you cannot open", text):
            errs.append("%s still encodes a hidden counter" % label)
    return errs, "R1 omission with no counter; R2 one eligibility rule for preview, save, edit, readiness, and the 8C handoff; old-code results"


def check_wiring():
    errs = []
    verify = read(P("scripts/verify.sh"))
    if "python3 docs/engineering/tools/phase8b.py" not in verify:
        errs.append("verify.sh (and so preflight) must run phase8b.py in the core gate")
    pkg = json.loads(read(P("package.json")))
    if pkg.get("scripts", {}).get("validate:phase8b") != "python3 docs/engineering/tools/phase8b.py":
        errs.append("package.json lacks validate:phase8b")
    readme = read(P("docs/engineering/README.md"))
    for term in ("0047-agent-profiles-connectors.md", "phase8b.py", "agents.md"):
        if term not in readme:
            errs.append("the engineering index must list %s" % term)
    if not re.search(r"\|agents[|)]", read(P("playwright.config.ts"))):
        errs.append("the tablet project must run the 8B journeys")
    if "## Phase 8B: agent profiles" not in read(P("docs/engineering/database.md")):
        errs.append("docs/engineering/database.md must record migration 0064")
    if not os.path.isfile(P("docs/engineering/agents.md")):
        errs.append("the agent operator notes are missing")
    web = read(P("apps/web/src/shell/registry.ts"))
    if "extraCommand: 'go.agents'" not in web:
        errs.append("Agents must be a navigation entry and palette command")
    setup = read(P("e2e/global-setup.ts"))
    if "startAgentConnectorFixture()" not in setup or "AGENT_CONNECTOR_TRANSPORT: 'fixture'" not in setup:
        errs.append("the browser suite must run against the synthetic connector fixture")
    gen = read(P("packages/work/scripts/generate-mcp-registry.mjs"))
    if "agent-tools.json" not in gen or "tool-registry.ts" not in gen:
        errs.append("the tool registry must be generated from agent-tools.json (checked by mcp:contracts:generate:check)")
    return errs, "verify.sh, package.json, the engineering index, the tablet project, database and operator notes, navigation, fixtures"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P(CLOSURE))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 8B: requirement closure", phase2.check_closure(catalog, closure, subphases, SUBPHASE, DECISIONS)),
        ("phase 8B: closure, ADR status, and boundaries", check_closure_and_boundaries(closure)),
        ("phase 8B: configuration and connectors at runtime", check_runtime()),
        ("phase 8B: one agent service on the platform", check_service()),
        ("phase 8B: migration 0064", check_migration()),
        ("phase 8B: identifiers, contracts, and limits", check_identifiers()),
        ("phase 8B: corrective review 01", check_review01(closure)),
        ("phase 8B: wiring", check_wiring()),
        ("phase 8B: migration sequence", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 8B CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
