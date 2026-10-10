#!/usr/bin/env python3
"""Phase 0C authorization policy tool (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/architecture/access/tools/accesspolicy.py validate   # policy, matrix, threats, tests, links; exit 1 on error
    python3 docs/architecture/access/tools/accesspolicy.py render     # regenerate docs/architecture/access/generated/*.md

policy/policy.json and policy/threats.json are authoritative.
"""
import json
import os
import re
import sys
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ACCESS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(ACCESS)))
POLICY = os.path.join(ACCESS, "policy", "policy.json")
THREATS = os.path.join(ACCESS, "policy", "threats.json")
GEN = os.path.join(ACCESS, "generated")
CATALOG = os.path.join(ROOT, "docs", "product", "requirements", "catalog.json")
MODEL = os.path.join(ROOT, "docs", "architecture", "data", "model", "model.json")
DATA_DIR = os.path.join(ROOT, "docs", "architecture", "data")
UX_DECISIONS = os.path.join(ROOT, "docs", "ux", "09-decisions-and-risks.md")
PRODUCT_DECISIONS = os.path.join(ROOT, "docs", "product", "open-decisions.md")

ROLES = ["owner", "administrator", "member", "limited_member", "read_only", "guest"]
LEVELS = ["view", "comment", "edit", "manage"]
KINDS = ["record", "admin", "execution", "personal"]
SCOPES = ["workspace", "brand", "project", "record", "personal", "field", "connection"]
REQUIRED_CATEGORIES = ["cross_workspace", "cross_brand_traversal", "inference", "restricted_project", "revocation", "team_change",
                       "field_leak", "staleness", "guest_escalation", "agent_scope", "spoofing", "support_misuse", "departure", "rls_leak"]
REQUIRED_ACTION_WORDS = ["create", "read", "update", "archive", "restore", "trash", "purge", "comment", "follow", "assign", "delegate",
                         "relate", "upload", "download", "share", "export", "invite", "membership", "ownership", "decide", "self_approve",
                         "verify", "release", "unlock", "workflow", "fields", "views", "templates", "notifications", "ai", "agents",
                         "automations", "integrations", "api_tokens", "webhooks", "security", "retention", "billing",
                         "feature_availability", "audit", "usage", "secrets_metadata", "health", "import", "tests", "production"]
DQ_REQUIRED = ["dq-01", "dq-02", "dq-03", "dq-04", "dq-05", "dq-06", "dq-07", "dq-08"]


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def load(path):
    return json.loads(read(path), object_pairs_hook=OrderedDict)


def rank(cell):
    if cell == "deny":
        return 0
    if cell.startswith("policy:"):
        return 1
    if cell == "own":
        return 2
    if cell.startswith("grant:"):
        return 3 + LEVELS.index(cell.split(":", 1)[1])
    if cell == "implicit":
        return 7
    raise ValueError(cell)


def valid_cell(cell):
    return cell in ("deny", "own", "implicit") or cell.startswith("policy:") or (cell.startswith("grant:") and cell[6:] in LEVELS)


def validate(policy, threats, quiet=False):
    errors = []
    roles = {r["id"]: r for r in policy["roles"]}
    if list(roles) != ROLES:
        errors.append("roles must be exactly %s in order" % ROLES)
    principals = {p["id"] for p in policy["principals"]}
    invariants = {i["id"] for i in policy["invariants"]}
    risk = {r["id"] for r in policy["risk_classes"]}
    approvals = {a["id"] for a in policy["approval_classes"]}
    actions = OrderedDict()
    for a in policy["actions"]:
        if a["key"] in actions:
            errors.append("duplicate action %s" % a["key"])
        actions[a["key"]] = a

    for a in actions.values():
        k = a["key"]
        if a["kind"] not in KINDS:
            errors.append("%s: unknown kind %s" % (k, a["kind"]))
        for s in a["scopes"]:
            if s not in SCOPES:
                errors.append("%s: unknown scope %s" % (k, s))
        if a["risk_class"] not in risk:
            errors.append("%s: unknown risk class" % k)
        if a["approval_class"] not in approvals:
            errors.append("%s: unknown approval class" % k)
        if a["kind"] in ("record", "execution") and a["required_level"] not in LEVELS and a["kind"] == "record":
            errors.append("%s: record actions need a required_level" % k)
        cells = a["roles"]
        if list(cells) != ROLES:
            errors.append("%s: matrix row must define every default role in order" % k)
            continue
        for role, cell in cells.items():
            if not valid_cell(cell):
                errors.append("%s/%s: invalid cell %r" % (k, role, cell))
        g, ro, lm = cells["guest"], cells["read_only"], cells["limited_member"]
        # guest: only explicitly shared records; no implicit, no manage, no admin
        if g == "implicit" or g == "grant:manage":
            errors.append("%s: guest cannot hold implicit or manage access" % k)
        if a["kind"] == "admin" and g != "deny":
            errors.append("%s: guests have no administrative capabilities" % k)
        if g.startswith("grant:") and "record" not in a["scopes"]:
            errors.append("%s: guest grants exist only on records (shares)" % k)
        # read-only: capped at view for record/execution actions
        if a["kind"] in ("record", "execution") and rank(ro) > rank("grant:view"):
            errors.append("%s: read_only exceeds view cap" % k)
        if a["kind"] in ("record", "execution") and lm == "implicit":
            errors.append("%s: limited members have no implicit record access" % k)
        # non-delegable: owner only
        if a["non_delegable"]:
            if cells["owner"] == "deny":
                errors.append("%s: non-delegable action must be available to owner" % k)
            for role in ROLES[1:]:
                if cells[role] != "deny":
                    errors.append("%s: non-delegable action granted to %s" % (k, role))
        if a["risk_class"] == "R4" and not a["step_up"]:
            if k not in ("emergency_stop.trigger",):
                errors.append("%s: R4 actions require step-up authentication" % k)
        if a["entitlement"] is not None and not re.match(r"^[a-z_]+$", a["entitlement"]):
            errors.append("%s: malformed entitlement key" % k)

    # account-level commands (AZ-18): performed by a human account before any tenant context exists
    commands = policy.get("account_commands", [])
    command_actions = set()
    for c in commands:
        k = c["action"]
        command_actions.add(k)
        a = actions.get(k)
        if a is None:
            errors.append("account command %s is not a 0C action" % k)
            continue
        if a["kind"] != "personal" or a["scopes"] != ["personal"]:
            errors.append("%s: account commands are personal-kind and scoped to personal only" % k)
        if set(a["roles"].values()) != {"deny"}:
            errors.append("%s: no workspace role cell may grant an account command (no membership exists yet)" % k)
        if c["principals"] != ["account"]:
            errors.append("%s: account commands are exercisable only by the human account principal" % k)
        if a["non_delegable"] or a["second_approval"] or a["entitlement"]:
            errors.append("%s: account commands carry no delegation, approval, or entitlement semantics" % k)
        for gate in ("email_verified", "account_active", "rate_limit", "idempotency_key"):
            if gate not in c["gates"]:
                errors.append("%s: account command lacks mandatory gate %s" % (k, gate))
        if sorted(c["requirements"]) != sorted(a["requirements"]):
            errors.append("%s: account command requirements differ from the action row" % k)
        if not any(x["action"] == k and x["expected"] == "deny" and x["principal"] != "account" for x in threats["tests"]):
            errors.append("%s: account command needs denial tests for non-human principals" % k)
    for a in actions.values():
        if a["kind"] == "personal" and set(a["roles"].values()) == {"deny"} and a["key"] not in command_actions:
            errors.append("%s: an all-deny personal action must be a registered account command" % a["key"])

    # workspace policy fields (AZ-19): every 0B workspace_policy column has a type, a safe default, and
    # a governing action; no role can configure a policy field that gates its own matrix cells
    model_cols = None
    for e in load(MODEL)["entities"]:
        if e["module"] == "access" and e["name"] == "workspace_policy":
            model_cols = [c.split(" ", 1)[0] for c in e["key_columns"]]
    fields = policy.get("workspace_policy", [])
    if model_cols is not None and [f["field"] for f in fields] != model_cols:
        errors.append("workspace_policy fields %s differ from 0B access.workspace_policy %s" % ([f["field"] for f in fields], model_cols))
    for f in fields:
        g = actions.get(f["governed_by"])
        if g is None:
            errors.append("workspace_policy %s: unknown governing action %s" % (f["field"], f["governed_by"]))
            continue
        if f["field"] == "public_links_enabled" and f["default"] is not False:
            errors.append("workspace_policy public_links_enabled must default to false (OD-27)")
        gated = [r for r in ROLES if any(a["roles"][r] == "policy:%s" % f["field"] for a in actions.values())]
        for r in gated:
            if g["roles"][r] not in ("deny",) and not (f["owner_only"] and r != "owner"):
                errors.append("workspace_policy %s: role %s could configure the policy that gates its own cells" % (f["field"], r))
        if f["owner_only"] and g["roles"]["owner"] == "deny":
            errors.append("workspace_policy %s: owner-only field needs an owner-capable governing action" % f["field"])

    # required action vocabulary coverage
    blob = " ".join(actions)
    for w in REQUIRED_ACTION_WORDS:
        if w not in blob:
            errors.append("action vocabulary lacks %r" % w)

    # grantable authority: an assignable role never exceeds the assigner on any action
    for r in policy["roles"]:
        for target in r["can_assign_roles"]:
            if target not in roles:
                errors.append("role %s assigns unknown role %s" % (r["id"], target))
                continue
            for a in actions.values():
                if rank(a["roles"][target]) > rank(a["roles"][r["id"]]):
                    errors.append("grantable authority: %s can assign %s, which exceeds it on %s (%s > %s)"
                                  % (r["id"], target, a["key"], a["roles"][target], a["roles"][r["id"]]))

    # agent tool classes
    for tc in policy["agent_tool_classes"]:
        if tc["risk_class"] not in risk or tc["approval_class"] not in approvals:
            errors.append("tool class %s: unknown risk/approval class" % tc["id"])
        if tc["risk_class"] in ("R3", "R4") and tc["approval_class"] != "human_approval":
            errors.append("tool class %s: R3/R4 agent actions require human approval (AGT-016)" % tc["id"])

    # threats and tests
    cats = threats["categories"]
    for c in REQUIRED_CATEGORIES:
        if c not in cats:
            errors.append("threat category %s missing" % c)
    tids = OrderedDict((t["id"], t) for t in threats["threats"])
    for t in threats["threats"]:
        if t["category"] not in cats:
            errors.append("%s: unknown category" % t["id"])
        for m in t["mitigated_by"]:
            if m not in invariants:
                errors.append("%s: unknown invariant %s" % (t["id"], m))
    covered = Counter()
    shapes = threats["response_shapes"]
    surfaces = set(threats["surfaces"])
    test_ids = set()
    for x in threats["tests"]:
        if x["id"] in test_ids:
            errors.append("duplicate test %s" % x["id"])
        test_ids.add(x["id"])
        for t in x["threats"]:
            if t not in tids:
                errors.append("%s: unknown threat %s" % (x["id"], t))
            covered[t] += 1
        if x["principal"] not in principals and x["principal"] not in roles:
            errors.append("%s: unknown principal %s" % (x["id"], x["principal"]))
        if x["action"] not in actions:
            errors.append("%s: unknown action %s" % (x["id"], x["action"]))
        if x["surface"] not in surfaces:
            errors.append("%s: unknown surface %s" % (x["id"], x["surface"]))
        for s in x["silent_surfaces"]:
            if s not in surfaces:
                errors.append("%s: unknown silent surface %s" % (x["id"], s))
        if x["response_shape"] not in shapes:
            errors.append("%s: unknown response shape %s" % (x["id"], x["response_shape"]))
        if x["expected"] not in ("allow", "deny"):
            errors.append("%s: expected must be allow/deny" % x["id"])
        if x["expected"] == "deny" and x["response_shape"] in ("not_found", "omitted") and not x["silent_surfaces"]:
            errors.append("%s: hidden-data denial must list secondary surfaces that stay silent" % x["id"])
    for t in tids:
        if not covered[t]:
            errors.append("threat %s has no test" % t)
    for c in REQUIRED_CATEGORIES:
        if not any(tids[t]["category"] == c for t in covered):
            errors.append("category %s has no tested threat" % c)

    # requirement IDs, data-model entities
    req_ids = {r["id"] for r in load(CATALOG)["requirements"]}
    for a in actions.values():
        for rid in a["requirements"]:
            if rid not in req_ids:
                errors.append("%s references unknown requirement %s" % (a["key"], rid))
    model = load(MODEL)
    ents = {"%s.%s" % (e["module"], e["name"]) for e in model["entities"]}
    for p in policy["principals"]:
        if p["entity"] and p["entity"] not in ents:
            errors.append("principal %s references unknown entity %s" % (p["id"], p["entity"]))

    check_docs(errors, req_ids, ents, invariants, set(actions), set(tids), test_ids)

    for name, text in render_all(policy, threats).items():
        path = os.path.join(GEN, name)
        if not os.path.exists(path) or read(path) != text:
            errors.append("generated/%s is out of date; run `accesspolicy.py render`" % name)

    if not quiet:
        kinds = Counter(a["kind"] for a in actions.values())
        print("Invariants          : %d" % len(invariants))
        print("Principal types     : %d" % len(principals))
        print("Default roles       : %d" % len(roles))
        print("Actions             : %d (%s)" % (len(actions), ", ".join("%s %d" % kv for kv in sorted(kinds.items()))))
        print("Agent tool classes  : %d" % len(policy["agent_tool_classes"]))
        print("Matrix cells        : %d (%d roles x %d actions)" % (len(roles) * len(actions), len(roles), len(actions)))
        print("Flags               : non-delegable %d, step-up %d, second approval %d, entitlement-limited %d" % (
            sum(a["non_delegable"] for a in actions.values()), sum(a["step_up"] for a in actions.values()),
            sum(a["second_approval"] for a in actions.values()), sum(1 for a in actions.values() if a["entitlement"])))
        print("Threats / tests     : %d / %d (deny %d, allow %d) across %d categories" % (
            len(tids), len(threats["tests"]), sum(1 for x in threats["tests"] if x["expected"] == "deny"),
            sum(1 for x in threats["tests"] if x["expected"] == "allow"), len(cats)))
        for e in errors:
            print("ERROR: " + e)
        print("RESULT: %s" % ("PASS" if not errors else "FAIL (%d errors)" % len(errors)))
    return errors


def anchors_of(path, cache={}):
    if path not in cache:
        text = read(path)
        a = set(re.findall(r'<a id="([^"]+)"', text))
        for h in re.findall(r"^#+ (.+)$", text, re.M):
            a.add(re.sub(r"[^\w\- ]", "", h.strip().lower()).replace(" ", "-"))
        cache[path] = a
    return cache[path]


def check_docs(errors, req_ids, ents, invariants, actions, threat_ids, test_ids):
    prefixes = load(CATALOG)["section_prefixes"].values()
    req_re = re.compile(r"\b(%s)-(\d{3})\b" % "|".join(sorted(prefixes, key=len, reverse=True)))
    prod_od = set(re.findall(r'<a id="(od-\d+)"', read(PRODUCT_DECISIONS)))
    ux_ids = set(re.findall(r'<a id="(uxd-\d+)"', read(UX_DECISIONS)))
    data_adr = set(re.findall(r'<a id="(adr-\d+)"', read(os.path.join(DATA_DIR, "12-decisions.md"))))
    data_dq = set(re.findall(r'<a id="(dq-\d+)"', read(os.path.join(DATA_DIR, "13-open-questions.md"))))
    dec_text = read(os.path.join(ACCESS, "15-decisions.md"))
    az = set(re.findall(r'<a id="(az-\d+)"', dec_text))
    aq = set(re.findall(r'<a id="(aq-\d+)"', read(os.path.join(ACCESS, "16-open-questions.md"))))
    ac = set(re.findall(r'<a id="(ac-\d+)"', read(os.path.join(ACCESS, "16-open-questions.md"))))
    resolved = set(re.findall(r'<a id="resolve-(dq-\d+)"', dec_text))
    for d in DQ_REQUIRED:
        if d not in resolved:
            errors.append("15-decisions.md lacks an explicit resolution anchor for %s" % d.upper())
    for base, _d, files in os.walk(ACCESS):
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(base, name)
            rel = os.path.relpath(path, ROOT)
            text = read(path)
            for m in re.finditer(r"\]\(([^)\s]+)\)", text):
                url = m.group(1)
                if url.startswith(("http://", "https://", "mailto:")):
                    continue
                target, _, frag = url.partition("#")
                tpath = os.path.normpath(os.path.join(os.path.dirname(path), target)) if target else path
                if not os.path.exists(tpath):
                    errors.append("%s: broken link %s" % (rel, url))
                elif frag and tpath.endswith(".md") and frag not in anchors_of(tpath):
                    errors.append("%s: broken anchor %s" % (rel, url))
            for block in re.findall(r"```mermaid\n(.*?)```", text, re.S):
                lines = [l.strip() for l in block.split("\n") if l.strip()]
                if not lines or not lines[0].startswith("flowchart"):
                    errors.append("%s: mermaid block must be a flowchart" % rel)
                    continue
                node = r'[a-z][a-z0-9_]*(\["[^"]+"\])?'
                for l in lines[1:]:
                    if not re.match(r"^%s( --> %s)?$" % (node, node), l):
                        errors.append("%s: invalid flowchart line: %s" % (rel, l))
            checks = [
                (req_re, lambda m: m.group(0) in req_ids, "requirement"),
                (re.compile(r"\bOD-(\d+)\b"), lambda m: "od-%s" % m.group(1) in prod_od, "product decision"),
                (re.compile(r"\bUXD-(\d+)\b"), lambda m: "uxd-%s" % m.group(1) in ux_ids, "UX decision"),
                (re.compile(r"\bADR-(\d+)\b"), lambda m: "adr-%s" % m.group(1) in data_adr, "0B ADR"),
                (re.compile(r"\bDQ-(\d+)\b"), lambda m: "dq-%s" % m.group(1) in data_dq, "0B question"),
                (re.compile(r"\bAZ-(\d+)\b"), lambda m: "az-%s" % m.group(1) in az, "access ADR"),
                (re.compile(r"\bAQ-(\d+)\b"), lambda m: "aq-%s" % m.group(1) in aq, "access question"),
                (re.compile(r"\bAC-(\d+)\b"), lambda m: "ac-%s" % m.group(1) in ac, "access contradiction"),
                (re.compile(r"\bI-(\d\d)\b"), lambda m: m.group(0) in invariants, "invariant"),
                (re.compile(r"\bT-(\d\d)\b"), lambda m: m.group(0) in threat_ids, "threat"),
                (re.compile(r"\bAT-(\d{3})\b"), lambda m: m.group(0) in test_ids, "test"),
                (re.compile(r"`([a-z_]+\.[a-z_]+(?:\.[a-z_]+)?)` action"), lambda m: m.group(1) in actions, "action"),
                (re.compile(r"`([a-z_]+\.[a-z_]+)` entity"), lambda m: m.group(1) in ents, "entity"),
            ]
            for rx, ok, what in checks:
                for m in rx.finditer(text):
                    if not ok(m):
                        errors.append("%s: unknown %s %s" % (rel, what, m.group(0)))


# ------------------------------------------------------------------ render
HEADER = "<!-- GENERATED by docs/architecture/access/tools/accesspolicy.py render from policy/*.json. Do not edit by hand. -->\n\n"


def esc(s):
    return str(s).replace("|", "\\|")


def cell_md(c):
    return {"deny": "—", "implicit": "**all**", "own": "own"}.get(c, c.replace("grant:", "≥").replace("policy:", "if "))


def render_matrix(policy):
    out = [HEADER, "# Default permission matrix\n\n",
           "Rules and algorithm: [../04-effective-permissions.md](../04-effective-permissions.md). Legend: **all** = implicit across non-sensitive scopes "
           "(sensitive brands and restricted projects still require explicit grants or audited elevation); ≥level = allowed where the principal's effective "
           "access level on the target is at least that level; own = own personal items only; if X = only when workspace policy X is enabled; — = never. "
           "Flags: ND non-delegable (owner only, excluded from custom roles), SU step-up authentication, 2A second/independent approval when available, "
           "E plan entitlement required.\n"]
    for kind, title in (("record", "Record permissions"), ("execution", "Execution permissions"), ("admin", "Administrative capabilities"), ("personal", "Personal")):
        rows = [a for a in policy["actions"] if a["kind"] == kind]
        out.append("\n## %s (%d)\n\n| Action | Scopes | Level | Risk | Flags | %s |\n|---|---|---|---|---|%s\n" % (
            title, len(rows), " | ".join(ROLES), "---|" * len(ROLES)))
        for a in rows:
            flags = [f for f, on in (("ND", a["non_delegable"]), ("SU", a["step_up"]), ("2A", a["second_approval"])) if on]
            if a["entitlement"]:
                flags.append("E:%s" % a["entitlement"])
            out.append("| `%s` | %s | %s | %s | %s | %s |\n" % (a["key"], ", ".join(a["scopes"]), a["required_level"] or "—", a["risk_class"],
                                                         " ".join(flags) or "", " | ".join(cell_md(a["roles"][r]) for r in ROLES)))
    out.append("\n## Agent tool classes\n\n| Tool class | Risk | Approval | Description |\n|---|---|---|---|\n")
    for t in policy["agent_tool_classes"]:
        out.append("| `%s` | %s | %s | %s |\n" % (t["id"], t["risk_class"], t["approval_class"], esc(t["description"])))
    out.append("\n## Action descriptions\n\n| Action | Description | Approval class | Requirements | Notes |\n|---|---|---|---|---|\n")
    for a in policy["actions"]:
        out.append("| `%s` | %s | %s | %s | %s |\n" % (a["key"], esc(a["description"]), a["approval_class"], ", ".join(a["requirements"]), esc(a["notes"])))
    return "".join(out)


def render_threats(threats):
    tests_by = {}
    for x in threats["tests"]:
        for t in x["threats"]:
            tests_by.setdefault(t, []).append(x["id"])
    out = [HEADER, "# Threat register and authorization test matrix\n\nNarrative: [../14-threat-model.md](../14-threat-model.md).\n\n## Threats\n\n| Threat | Category | Description | Mitigated by | Tests |\n|---|---|---|---|---|\n"]
    for t in threats["threats"]:
        out.append("| %s | %s | %s | %s | %s |\n" % (t["id"], t["category"], esc(t["description"]), ", ".join(t["mitigated_by"]), ", ".join(tests_by.get(t["id"], []))))
    out.append("\n## Test matrix\n\n| Test | Threats | Principal | Setup / scope | Action | Surface | Expected | Response shape | Must stay silent |\n|---|---|---|---|---|---|---|---|---|\n")
    for x in threats["tests"]:
        out.append("| %s | %s | %s | %s — %s | `%s` | %s | **%s** | %s | %s |\n" % (
            x["id"], ", ".join(x["threats"]), x["principal"], esc(x["setup"]), esc(x["scope"]), x["action"], x["surface"],
            x["expected"], x["response_shape"], ", ".join(x["silent_surfaces"]) or "—"))
    out.append("\n## Response shapes\n\n| Shape | Meaning |\n|---|---|\n")
    for k, v in threats["response_shapes"].items():
        out.append("| `%s` | %s |\n" % (k, esc(v)))
    return "".join(out)


def render_principals(policy):
    out = [HEADER, "# Principals, roles, and invariants\n\n## Invariants\n\n| ID | Invariant |\n|---|---|\n"]
    for i in policy["invariants"]:
        out.append('| <a id="%s"></a>%s | %s |\n' % (i["id"].lower(), i["id"], esc(i["text"])))
    out.append("\n## Principal types\n\n| Principal | Class | Description | Data entity |\n|---|---|---|---|\n")
    for p in policy["principals"]:
        out.append("| `%s` | %s | %s | %s |\n" % (p["id"], p["class"], esc(p["description"]), "`%s`" % p["entity"] if p["entity"] else "—"))
    out.append("\n## Default roles\n\n| Role | Membership kind | Level cap | Can assign | Description |\n|---|---|---|---|---|\n")
    for r in policy["roles"]:
        out.append("| `%s` | %s | %s | %s | %s |\n" % (r["id"], r["membership_kind"], r["level_cap"] or "—", ", ".join(r["can_assign_roles"]) or "—", esc(r["description"])))
    out.append("\n## Access levels\n\n| Level | Includes |\n|---|---|\n")
    for l in policy["access_levels"]:
        out.append("| `%s` | %s |\n" % (l["id"], ", ".join(l["includes"])))
    out.append("\n## Risk classes\n\n| Class | Meaning | Default controls |\n|---|---|---|\n")
    for r in policy["risk_classes"]:
        out.append("| %s | %s | %s |\n" % (r["id"], esc(r["meaning"]), esc(r["default_controls"])))
    out.append("\n## Approval classes\n\n| Class | Meaning |\n|---|---|\n")
    for a in policy["approval_classes"]:
        out.append("| `%s` | %s |\n" % (a["id"], esc(a["meaning"])))
    return "".join(out)


def render_all(policy, threats):
    return OrderedDict([("permission-matrix.md", render_matrix(policy)), ("threats-and-tests.md", render_threats(threats)),
                        ("principals-roles.md", render_principals(policy))])


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "validate"
    policy, threats = load(POLICY), load(THREATS)
    if cmd == "validate":
        return 1 if validate(policy, threats) else 0
    if cmd == "render":
        os.makedirs(GEN, exist_ok=True)
        for name, text in render_all(policy, threats).items():
            with open(os.path.join(GEN, name), "w", encoding="utf-8") as fh:
                fh.write(text)
            print("wrote docs/architecture/access/generated/%s" % name)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
