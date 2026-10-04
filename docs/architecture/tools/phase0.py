#!/usr/bin/env python3
"""Phase 0 integration validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/architecture/tools/phase0.py          # run every package validator, then cross-package checks; exit 1 on any failure

Package validators are orchestrated as subprocesses (their own checks are not duplicated here). The cross-package
checks below cover what no single package can see: required 0C data additions in the 0B model, the 0D execution
context's representability, identifier/prefix/principal/action/scope/state/actor drift, public-surface leaks,
stale contradiction language, unresolved cross-phase blockers, and links in the Phase 0 summary documents.
"""
import json
import os
import re
import subprocess
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ARCH = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(ARCH))
P = lambda *x: os.path.join(ROOT, *x)

PACKAGE_VALIDATORS = [
    ("0A requirement catalog", ["docs/product/tools/reqcat.py", "validate"]),
    ("0E documentation", ["docs/ux/tools/check_docs.py"]),
    ("0E contrast", ["docs/ux/tools/check_contrast.py"]),
    ("0B data model", ["docs/architecture/data/tools/datamodel.py", "validate"]),
    ("0C authorization policy", ["docs/architecture/access/tools/accesspolicy.py", "validate"]),
    ("0D platform contracts", ["docs/architecture/platform/tools/platformcontracts.py", "validate"]),
]
SUMMARY_DOCS = ["docs/architecture/PHASE_0_DECISIONS.md", "docs/architecture/PHASE_0_EXIT_GATE.md", "docs/architecture/RELEASE_TOPOLOGY.md"]


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def load(path):
    return json.loads(read(path), object_pairs_hook=OrderedDict)


class Report:
    def __init__(self):
        self.sections = OrderedDict()

    def add(self, section, errors, detail=""):
        self.sections[section] = (errors, detail)


# ------------------------------------------------------------------ package validators
def run_packages(rep):
    for name, cmd in PACKAGE_VALIDATORS:
        proc = subprocess.run([sys.executable] + [P(cmd[0])] + cmd[1:], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        lines = [l for l in proc.stdout.strip().splitlines() if l.strip()]
        last = lines[-1] if lines else ""
        rep.add("package: " + name, [] if proc.returncode == 0 else ["exit %d: %s" % (proc.returncode, last)], last)


# ------------------------------------------------------------------ helpers
def cols_of(e):
    return [c.split(" ")[0] for c in e["key_columns"]]


def has_col(e, name):
    return any(c == name or c.startswith(name + "/") or c.startswith(name) and c[len(name):len(name) + 1] in ("", "/") for c in cols_of(e))


def backticked(text, start_marker, end=r"\|"):
    m = re.search(start_marker + "(.*?)" + end, text, re.S)
    return re.findall(r"`([a-z_]+)`", m.group(1)) if m else None


# ------------------------------------------------------------------ cross-package checks
def check_required_0c_data(model, policy):
    errs = []
    E = {"%s.%s" % (e["module"], e["name"]): e for e in model["entities"]}
    for ent in ["access.share_group", "access.record_grant", "access.field_policy", "access.permission_epoch", "access.service_principal",
                "access.support_access_grant", "access.role_assignment", "access.workspace_policy", "files.upload_session",
                "identity.step_up_challenge", "transfer.export_file"]:
        if ent not in E:
            errs.append("0B model lacks required entity %s" % ent)
    if errs:
        return errs
    rg = E["access.record_grant"]
    for c in ("share_group_id", "grantee_key", "grantee_type", "grantee_id", "level", "expires_at"):
        if not has_col(rg, c):
            errs.append("access.record_grant lacks %s" % c)
    for c in ("include_children", "selected_child_ids"):
        if has_col(rg, c):
            errs.append("access.record_grant still has obsolete %s" % c)
    for ent in ("work.project", "knowledge.document"):
        for c in ("access_mode", "allow_record_shares"):
            if not has_col(E[ent], c):
                errs.append("%s lacks %s" % (ent, c))
    for c in ("elevated", "elevation_reason", "expires_at"):
        if not has_col(E["access.role_assignment"], c):
            errs.append("access.role_assignment lacks %s" % c)
    # every 0C policy:<key> cell must have a typed workspace_policy column
    keys = {cell.split(":", 1)[1] for a in policy["actions"] for cell in a["roles"].values() if cell.startswith("policy:")}
    wp = cols_of(E["access.workspace_policy"])
    for k in sorted(keys):
        col = "self_approval_mode" if k == "self_approval" else k
        if col not in wp:
            errs.append("access.workspace_policy lacks typed column for 0C policy key %s" % k)
    if any("jsonb" in c for c in E["access.workspace_policy"]["key_columns"]):
        errs.append("access.workspace_policy must not use an untyped jsonb settings bag")
    for ent in ("automation.automation", "integrations.connection", "integrations.webhook_subscription", "integrations.inbound_endpoint",
                "agents.agent_profile", "insights.report_definition", "access.service_principal"):
        for c in ("accountable_owner_membership_id", "suspended_reason"):
            if not has_col(E[ent], c):
                errs.append("%s lacks %s (owner-authority suspension)" % (ent, c))
    return errs


EXEC_CTX_MAP = OrderedDict([
    ("workspace_id", None), ("operation_id", None), ("attempt_id", None),  # standard / identity columns
    ("request_id", "request_id"), ("correlation_id", "correlation_id"), ("causation_id", "causation_id"), ("traceparent", "traceparent"),
    ("authenticated_principal", "authenticated_principal_type"), ("effective_principal", "effective_principal_type"),
    ("initiating_membership_id", "initiating_membership_id"), ("delegation_chain", "delegation_chain"), ("selected_scope", "selected_scope"),
    ("epochs", "workspace_epoch_at_enqueue"), ("risk", "risk_action_key"), ("data_class_limit", "data_class_limit"),
    ("locale", "locale"), ("timezone", "timezone"),
])


def check_exec_context(model):
    errs = []
    schema = load(P("docs/architecture/platform/contracts/schemas/execution-context.schema.json"))
    E = {"%s.%s" % (e["module"], e["name"]): e for e in model["entities"]}
    for prop in schema["properties"]:
        if prop not in EXEC_CTX_MAP:
            errs.append("execution-context property %s has no mapping to 0B columns (update phase0.py map and the model)" % prop)
            continue
        col = EXEC_CTX_MAP[prop]
        if col is None:
            continue
        for ent in ("execution.operation", "execution.job"):
            if not has_col(E[ent], col):
                errs.append("%s cannot represent execution-context.%s (missing %s)" % (ent, prop, col))
    for ent in ("execution.operation", "execution.job"):
        if not has_col(E[ent], "principal_epoch_at_enqueue") or not has_col(E[ent], "risk_class"):
            errs.append("%s lacks epoch/risk columns" % ent)
    return errs


def check_identifiers(model, policy, registry):
    errs = []
    E = {"%s.%s" % (e["module"], e["name"]): e for e in model["entities"]}
    modules = {m["id"] for m in model["modules"]}
    for p in policy["principals"]:
        if p["entity"]:
            if p["entity"] not in E:
                errs.append("0C principal %s references missing entity %s" % (p["id"], p["entity"]))
        elif not p.get("platform_only"):
            errs.append("0C principal %s has no data entity and is not marked platform-only" % p["id"])
    for x in registry["id_prefixes"]:
        if x["entity"] and x["entity"] not in E:
            errs.append("0D prefix %s → missing entity %s" % (x["prefix"], x["entity"]))
        if x["entity"] and x["entity"] in E and E[x["entity"]]["module"] != x.get("owner_module"):
            errs.append("0D prefix %s owner module mismatch" % x["prefix"])
        if not x["entity"] and not (x.get("platform_only") and x.get("owner_module") in modules and x.get("note")):
            errs.append("0D prefix %s lacks entity or documented platform-only owner" % x["prefix"])
        if x["entity"] in E and E[x["entity"]]["addressable"] and E[x["entity"]]["public_id_prefix"] != x["prefix"]:
            errs.append("0D prefix %s disagrees with 0B public_id_prefix %s for %s" % (x["prefix"], E[x["entity"]]["public_id_prefix"], x["entity"]))
    # every 0B public_id text (xxx_) note matches the registry
    reg = {x["prefix"]: x for x in registry["id_prefixes"]}
    for name, e in E.items():
        for c in e["key_columns"]:
            m = re.match(r"public_id text \(([a-z]{2,5})_\)", c)
            if m and (m.group(1) not in reg or reg[m.group(1)]["entity"] != name):
                errs.append("%s declares public prefix %s_ not registered to it in 0D" % (name, m.group(1)))
    actions = {a["key"] for a in policy["actions"]}
    principals = {p["id"] for p in policy["principals"]}
    for s in registry["scopes"]:
        for a in s["actions"]:
            if a not in actions:
                errs.append("0D scope %s → unknown 0C action %s" % (s["scope"], a))
        for pr in s["principals"]:
            if pr not in principals:
                errs.append("0D scope %s → unknown 0C principal %s" % (s["scope"], pr))
    threats = load(P("docs/architecture/access/policy/threats.json"))
    roles = {r["id"] for r in policy["roles"]}
    for t in threats["tests"]:
        if t["principal"] not in principals | roles:
            errs.append("0C test %s uses unknown principal %s" % (t["id"], t["principal"]))
    return errs


def check_vocabularies(model, policy, registry):
    errs = []
    lifecycle = read(P("docs/product/lifecycle-and-states.md"))
    b05 = read(P("docs/architecture/data/05-state-representation.md"))
    common = load(P("docs/architecture/platform/contracts/schemas/common.schema.json"))["$defs"]
    # execution states: 0A §5.1 table ↔ 0D registry ↔ 0D schema
    sec51 = lifecycle[lifecycle.index("### 5.1 Shared execution vocabulary"):lifecycle.index("### 5.2 Agent runs")]
    a_exec = re.findall(r"^\| `([a-z_]+)` \| (?:No|Yes) \|", sec51, re.M)
    if a_exec != registry["exec_states"]:
        errs.append("exec states drift: 0A %s vs 0D %s" % (a_exec, registry["exec_states"]))
    if common["exec_state"]["enum"] != registry["exec_states"]:
        errs.append("0D common exec_state enum differs from registry")
    # status categories: 0A §2 ↔ 0B 05
    sec2 = lifecycle[lifecycle.index("## 2. Status categories"):lifecycle.index("### Default task workflow")]
    a_cat = re.findall(r"^\| `([a-z_]+)` \|", sec2, re.M)
    b_cat = backticked(b05, r"Category enum `status_category`:")
    if a_cat != b_cat:
        errs.append("status categories drift: 0A %s vs 0B %s" % (a_cat, b_cat))
    # test outcomes: 0A §5.3 ↔ 0B 05
    sec53 = lifecycle[lifecycle.index("### 5.3 Test results"):lifecycle.index("### 5.4 Releases")]
    a_test = re.findall(r"^\| `([a-z_]+)` \|", sec53, re.M)
    b_test = backticked(b05, r"enum `test_outcome` \(", r"\)")
    if sorted(a_test) != sorted(b_test or []):
        errs.append("test outcomes drift: 0A %s vs 0B %s" % (a_test, b_test))
    # actor types: 0D registry ↔ 0D schema ↔ 0E DS-44 ↔ 0A glossary
    if common["actor_type"]["enum"] != registry["actor_types"]:
        errs.append("0D actor_type enum differs from registry")
    ds = read(P("docs/ux/05-design-system.md"))
    ds44 = ds[ds.index("### DS-44"):ds.index("###", ds.index("### DS-44") + 5)].lower()
    gl = read(P("docs/product/glossary.md"))
    for a in registry["actor_types"]:
        word = {"human": "person", "ai": "ai"}.get(a, a)
        if word not in ds44 and a not in ds44:
            errs.append("actor type %s not represented in 0E DS-44" % a)
        if "`%s`" % a not in gl:
            errs.append("actor type %s missing from 0A glossary" % a)
    # risk and data classes
    if common["risk_class"]["enum"] != [r["id"] for r in policy["risk_classes"]]:
        errs.append("risk classes drift between 0C and 0D")
    if common["data_class"]["enum"] != list(model["vocabulary"]["confidentiality"].keys()):
        errs.append("data classes drift between 0B and 0D")
    for k in ("R-AUDIT",):
        if k not in model["vocabulary"]["retention_classes"]:
            errs.append("retention class %s missing from 0B" % k)
    # operation kinds detail entities and job states
    E = {"%s.%s" % (e["module"], e["name"]) for e in model["entities"]}
    for o in registry["operation_kinds"]:
        if o["detail_entity"] and o["detail_entity"] not in E:
            errs.append("operation kind %s → missing entity" % o["kind"])
    job = [e for e in model["entities"] if e["name"] == "job"][0]
    state_col = [c for c in job["key_columns"] if c.startswith("state ")][0]
    for js in registry["job_states"]:
        if js not in state_col:
            errs.append("0D job state %s absent from 0B execution.job state column" % js)
    # named parameters used anywhere must be defined (0A table or 0D registry)
    zero_a = set(re.findall(r"^\| `([A-Z_]+)` \|", read(P("docs/product/deletion-retention-history.md")), re.M))
    params = zero_a | {p["name"] for p in registry["parameters"]}
    allowed_tokens = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "BYPASSRLS", "NOBYPASSRLS", "SECURITY", "FORCE",
                      "UPDATE", "SKIP", "LOCKED", "NOT_FOUND", "FORBIDDEN", "ALLOW", "DENY", "APPROVAL_REQUIRED", "STEP_UP_REQUIRED", "MATCH", "SIMPLE", "DEFERRABLE", "INITIALLY", "DEFERRED", "CHECK", "UNIQUE", "WHERE"}
    for base in ("docs/product", "docs/architecture"):
        for dirpath, _d, files in os.walk(P(base)):
            if "generated" in dirpath:
                continue
            for f in files:
                if f.endswith(".md"):
                    for tok in set(re.findall(r"`([A-Z][A-Z0-9_]{3,})`", read(os.path.join(dirpath, f)))):
                        if "_" in tok and tok not in params and tok not in allowed_tokens:
                            errs.append("%s uses undefined named parameter %s" % (os.path.relpath(os.path.join(dirpath, f), ROOT), tok))
    return errs


def check_public_surfaces(registry):
    errs = []
    sdir = P("docs/architecture/platform/contracts/schemas")
    forbidden_props = {"acl", "permissions", "allowed_principals", "visible_to", "effective_level", "grants", "secret", "password", "api_key", "token_value"}

    def walk(n, path, name):
        if isinstance(n, dict):
            if n.get("x-class") in ("C3", "C4"):
                errs.append("public schema %s exposes %s data at %s" % (name, n["x-class"], path))
            for k, v in n.get("properties", {}).items():
                if k in forbidden_props:
                    errs.append("public schema %s has forbidden property %s (authorization decision or secret)" % (name, k))
            for k, v in n.items():
                walk(v, path + "/" + k, name)
        elif isinstance(n, list):
            for i, v in enumerate(n):
                walk(v, "%s[%d]" % (path, i), name)
    for f in sorted(os.listdir(sdir)):
        s = load(os.path.join(sdir, f))
        if s.get("x-visibility") == "public":
            walk(s, "$", f)
    # collections expose totals only with the labelled shape
    page = load(os.path.join(sdir, "collection-page.schema.json"))
    tot = page["properties"]["page"]["properties"]["total"]
    if set(tot["required"]) != {"value", "estimated", "capped"}:
        errs.append("collection totals must always be labelled estimated/capped")
    # public webhooks and SSE
    for e in registry["events"]:
        if e["public_webhook"]:
            mod = e["type"].split(".")[0]
            if not (e.get("allow_list_version") and e.get("delivery_authorization") == "subscription_owner_at_delivery" and mod and e["max_class"] in ("C0", "C1", "C2")):
                errs.append("public webhook %s lacks owner/allow-list/class/delivery-authorization" % e["public_webhook"])
    c04 = read(P("docs/architecture/access/04-effective-permissions.md"))
    for t in registry["sse_topics"]:
        for param in t["0c_context"]:
            if "`%s`" % param not in c04 and param not in c04:
                errs.append("SSE topic %s uses 0C context parameter %s not defined in 0C §4.5" % (t["topic"], param))
    sse = load(os.path.join(sdir, "sse-notice.schema.json"))
    if sse.get("x-max-class") != "C1":
        errs.append("SSE notices must be capped at C1")
    return errs


STALE_RULES = [
    (r"selected_child_ids|include_children", r"(?i)(amend|supersed|former|obsolete|removed|drop)", "obsolete share-array fields"),
    (r"exactly[- ]once", r"(?i)\b(never|no|not)\b", "exactly-once claim without negation"),
    (r"(?i)executed \*\*at most once\*\*|at-most-once external", None, "at-most-once external effect claim"),
    (r"BYPASSRLS", r"(?i)(never|no |not |NOBYPASSRLS|Alternatives)", "role granted BYPASSRLS"),
    (r"(?i)returns the stored response", None, "stored-response replay"),
]
HISTORY_FILES = {"docs/architecture/access/16-open-questions.md", "docs/architecture/platform/20-open-questions.md", "docs/architecture/data/13-open-questions.md",
                 "docs/architecture/tools/phase0.py"}


def check_stale_language():
    errs = []
    for base in ("docs/product", "docs/ux", "docs/architecture"):
        for dirpath, _d, files in os.walk(P(base)):
            if "generated" in dirpath:
                continue
            for f in files:
                if not f.endswith(".md"):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, f), ROOT)
                if rel in HISTORY_FILES:
                    continue
                for n, line in enumerate(read(os.path.join(dirpath, f)).splitlines(), 1):
                    for pat, allow, what in STALE_RULES:
                        if re.search(pat, line) and not (allow and re.search(allow, line)):
                            errs.append("%s:%d: %s" % (rel, n, what))
    return errs


REQUIRED_STATEMENTS = [
    ("docs/product/lifecycle-and-states.md", r"at least once", "external effects are at least once"),
    ("docs/architecture/data/12-decisions.md", r"provider-dependent external deduplication", "ADR-08 provider-dependent deduplication"),
    ("docs/architecture/platform/05-idempotency-and-effects.md", r"never claims exactly-once", "0D never promises exactly-once"),
    ("docs/architecture/data/09-concurrency-consistency.md", r"re-rendered through the caller's current authorization", "idempotent replay re-renders references (PC-02)"),
    ("docs/architecture/platform/05-idempotency-and-effects.md", r"re-rendered through the caller's \*\*current\*\* authorization", "0D replay contract"),
    ("docs/ux/06-interaction-states.md", r"current effective access", "Trash uses current permission (AC-02)"),
    ("docs/architecture/access/11-trash-archive-departure.md", r"\*\*Never\*\* see Trash", "guests never see Trash"),
    ("docs/architecture/data/03-tenancy-brand-sharing.md", r"use only record grants|only through explicit record grants", "guests use record grants only (AC-04)"),
    ("docs/product/deletion-retention-history.md", r"Administrators cannot export it", "departed-member personal data not exportable (AC-05)"),
    ("docs/architecture/data/10-postgresql-guidance.md", r"never receive `BYPASSRLS`", "no ordinary role bypasses RLS (AC-06)"),
    ("docs/architecture/data/03-tenancy-brand-sharing.md", r"Records created later are never included", "shares never include future children"),
    ("docs/product/hierarchy-and-scope.md", r"omit the relationship", "inaccessible relationships omitted"),
    ("docs/product/time-and-scheduling.md", r"off by default", "free/busy off by default"),
    ("docs/architecture/access/06-guests-sharing-public-links.md", r"may remain usable until", "signed URL bounded residual (PC-03)"),
    ("docs/architecture/platform/15-files.md", r"not durable authorization", "signed URL not durable authorization"),
]


def check_required_statements():
    errs = []
    for f, pat, what in REQUIRED_STATEMENTS:
        if not re.search(pat, read(P(f))):
            errs.append("%s no longer states: %s" % (f, what))
    return errs


def check_blockers():
    errs = []
    d13 = read(P("docs/architecture/data/13-open-questions.md"))
    for n in ["01", "02", "03", "04", "05", "06", "07", "08", "10", "11", "12", "13", "14", "15", "16", "17"]:
        m = re.search(r'<a id="dq-%s"></a>\n### DQ-%s:[^\n]*' % (n, n), d13)
        if not m or "resolved" not in m.group(0):
            errs.append("0B DQ-%s (blocker for 0C/0D) not marked resolved" % n)
    for c in ("01", "02", "03"):
        m = re.search(r'<a id="c-%s"></a>\n### C-%s[^\n]*' % (c, c), d13)
        if not m or "resolved" not in m.group(0):
            errs.append("0B C-%s not marked resolved" % c)
    a16 = read(P("docs/architecture/access/16-open-questions.md"))
    for n in range(1, 7):
        m = re.search(r'<a id="ac-%02d"></a>\n### AC-%02d:[^\n]*' % (n, n), a16)
        if not m or "resolved" not in m.group(0):
            errs.append("0C AC-%02d not marked resolved" % n)
    p20 = read(P("docs/architecture/platform/20-open-questions.md"))
    for n in range(1, 4):
        m = re.search(r'<a id="pc-%02d"></a>\n### PC-%02d:[^\n]*' % (n, n), p20)
        if not m or "resolved" not in m.group(0):
            errs.append("0D PC-%02d not marked resolved" % n)
    for n in range(1, 5):
        m = re.search(r'<a id="pq-%02d"></a>PQ-%02d[^\n]*' % (n, n), p20)
        if not m or "Resolved" not in m.group(0):
            errs.append("0D PQ-%02d (integration) not marked resolved" % n)
    ux = read(P("docs/ux/09-decisions-and-risks.md"))
    sect = ux[ux.index("### 2.1 Reconciliation"):ux.index("## 3. UX decision register")]
    for row in re.findall(r"^\| (?:DEP-0A-\d+|—) \|[^\n]*", sect, re.M):
        if "Aligned" not in row:
            errs.append("0E dependency not aligned: %s" % row[:80])
    gate = read(P("docs/architecture/PHASE_0_EXIT_GATE.md"))
    m = re.search(r"True architecture blockers remaining: \*\*(\d+)\*\*", gate)
    if not m:
        errs.append("PHASE_0_EXIT_GATE.md must state the count of true blockers")
    elif m.group(1) != "0":
        errs.append("exit gate reports %s true blockers" % m.group(1))
    return errs


def anchors_of(path, cache={}):
    if path not in cache:
        t = read(path)
        a = set(re.findall(r'<a id="([^"]+)"', t))
        for h in re.findall(r"^#+ (.+)$", t, re.M):
            a.add(re.sub(r"[^\w\- ]", "", h.strip().lower()).replace(" ", "-"))
        cache[path] = a
    return cache[path]


def check_summary_docs():
    errs = []
    ids = {
        "OD": (P("docs/product/open-decisions.md"), "od"), "UXD": (P("docs/ux/09-decisions-and-risks.md"), "uxd"),
        "ADR": (P("docs/architecture/data/12-decisions.md"), "adr"), "DQ": (P("docs/architecture/data/13-open-questions.md"), "dq"),
        "AZ": (P("docs/architecture/access/15-decisions.md"), "az"), "AQ": (P("docs/architecture/access/16-open-questions.md"), "aq"),
        "AC": (P("docs/architecture/access/16-open-questions.md"), "ac"), "PL": (P("docs/architecture/platform/19-decisions.md"), "pl"),
        "PQ": (P("docs/architecture/platform/20-open-questions.md"), "pq"), "PC": (P("docs/architecture/platform/20-open-questions.md"), "pc"),
    }
    sets = {k: set(re.findall(r'<a id="%s-(\d+)"' % v[1], read(v[0]))) for k, v in ids.items()}
    for f in SUMMARY_DOCS:
        path = P(f)
        if not os.path.exists(path):
            errs.append("missing %s" % f)
            continue
        text = read(path)
        for m in re.finditer(r"\]\(([^)\s]+)\)", text):
            url = m.group(1)
            if url.startswith(("http://", "https://")):
                continue
            target, _, frag = url.partition("#")
            tp = os.path.normpath(os.path.join(os.path.dirname(path), target)) if target else path
            if not os.path.exists(tp):
                errs.append("%s: broken link %s" % (f, url))
            elif frag and tp.endswith(".md") and frag not in anchors_of(tp):
                errs.append("%s: broken anchor %s" % (f, url))
        for k, s in sets.items():
            for num in set(re.findall(r"\b%s-(\d+)\b" % k, text)):
                if num not in s:
                    errs.append("%s: unknown %s-%s" % (f, k, num))
    return errs


RUNTIME_DIRS = ["apps", "packages"]
RUNTIME_SKIP_DIRS = {"node_modules", "dist", "test", "generated"}


def runtime_sources():
    for base in RUNTIME_DIRS:
        for dirpath, dirs, files in os.walk(P(base)):
            dirs[:] = sorted(d for d in dirs if d not in RUNTIME_SKIP_DIRS)
            for f in sorted(files):
                if f.endswith((".ts", ".tsx")) and not f.endswith(".d.ts"):
                    yield os.path.join(dirpath, f)


def migrated_check_values(table, constraint, column="state"):
    """Last definition of `constraint` across the ordered up-migrations: the values of its IN (...) list."""
    values = None
    mig = P("packages/db/migrations")
    if not os.path.isdir(mig):
        return None
    pat = re.compile(r"CONSTRAINT %s\s+CHECK\s*\(\s*%s IN\s*\(([^)]*)\)" % (re.escape(constraint), re.escape(column)))
    for f in sorted(x for x in os.listdir(mig) if x.endswith(".up.sql")):
        text = read(os.path.join(mig, f))
        if table not in text:
            continue
        for m in pat.finditer(text):
            values = re.findall(r"'([a-z_]+)'", m.group(1))
    return values


def check_step_up(policy, registry):
    """Step-up invariants across 0C/0D and the runtime (Phase 1B review 01): every runtime step-up
    action is a step-up action in 0C; own-account step-up actions are personal, human-only (no scope
    lists them), R3/R4, and implemented; the stored challenge states agree across 0D and the DB."""
    errs = []
    A = {a["key"]: a for a in policy["actions"]}
    scoped = {x for s in registry["scopes"] for x in s["actions"]}
    for a in A.values():
        if a["risk_class"] == "R4" and not a["step_up"] and a["key"] != "emergency_stop.trigger":
            errs.append("0C %s is R4 without step-up" % a["key"])
    personal = {k: a for k, a in A.items() if k.startswith("account.")}
    for k, a in personal.items():
        if a["kind"] != "personal" or not a["step_up"]:
            errs.append("0C own-account action %s must be personal and step-up protected" % k)
        if a["scopes"] != ["personal"]:
            errs.append("0C %s must be scoped to personal only" % k)
        if set(a["roles"].values()) != {"own"}:
            errs.append("0C %s must be 'own' for every role (never a tenant capability)" % k)
        if a["risk_class"] not in ("R3", "R4"):
            errs.append("0C %s: own-account security actions are R3 or R4" % k)
        if a["second_approval"] or a["entitlement"]:
            errs.append("0C %s: own-account security needs no approver or entitlement" % k)
        if k in scoped:
            errs.append("0D scope lists human-only step-up action %s" % k)
    # Runtime: #protected(...) action arguments and explicit step-up action keys.
    protected = re.compile(r"#protected\(\s*\w+\s*,\s*'([a-z_]+(?:\.[a-z_]+)+)'")
    account_literal = re.compile(r"(?:actionKey|action_key|stepUpAction)\s*[:=(]\s*'([a-z_]+(?:\.[a-z_]+)+)'")
    used = set()
    for f in runtime_sources():
        rel = os.path.relpath(f, ROOT)
        text = read(f)
        for m in protected.finditer(text):
            used.add(m.group(1))
            if m.group(1) not in A or not A[m.group(1)]["step_up"]:
                errs.append("%s: step-up protected action %s is not a 0C step-up action" % (rel, m.group(1)))
        for m in account_literal.finditer(text):
            if m.group(1) not in A or not A[m.group(1)]["step_up"]:
                errs.append("%s: step-up action key %s is not a 0C step-up action" % (rel, m.group(1)))
    if os.path.isdir(P("packages/identity/src")):
        for k in sorted(set(personal) - used):
            errs.append("0C step-up action %s has no runtime #protected(...) use" % k)
    # Challenge states: 0D schema ↔ last migrated DB constraint.
    schema = load(P("docs/architecture/platform/contracts/schemas/step-up-challenge.schema.json"))
    states = schema["properties"]["state"]["enum"]
    if "locked" not in states:
        errs.append("0D step-up challenge states lack the stored terminal state 'locked'")
    if not any(p["name"] == "STEP_UP_MAX_ATTEMPTS" for p in registry["parameters"]):
        errs.append("0D parameter STEP_UP_MAX_ATTEMPTS is not registered")
    db = migrated_check_values("identity.step_up_challenge", "step_up_challenge_state_known")
    if db is not None and sorted(db) != sorted(states):
        errs.append("DB step_up_challenge states %s differ from 0D %s" % (db, states))
    return errs


# Authorization call sites whose first quoted argument is a 0C action key.
AUTHZ_CALL = re.compile(
    r"((?:#|\.)requireWorkspace|(?:#|\.)requireBrand|decideWorkspace|decideBrand|decideRecord|issueLifecycleDecision|requireDecision|"
    r"testDecision|systemDecision|authorizeAccountCommand|(?:#|\.)stepUp)\([^'`)]*?'([a-z_]+\.[a-z_]+)'"
)


def check_runtime_actions(policy, registry):
    """Every runtime authorization action exists in the 0C catalog; account commands (AZ-18) are
    human-only, all-deny, unscoped, used through authorizeAccountCommand, and never reach tenant,
    lifecycle, step-up, or delegated evaluation."""
    errs = []
    A = {a["key"]: a for a in policy["actions"]}
    commands = {c["action"]: c for c in policy.get("account_commands", [])}
    scoped = {x for s in registry["scopes"] for x in s["actions"]}
    for k, c in commands.items():
        a = A.get(k)
        if a is None:
            errs.append("0C account command %s is not an action" % k)
            continue
        if set(a["roles"].values()) != {"deny"} or a["kind"] != "personal" or a["scopes"] != ["personal"]:
            errs.append("0C account command %s must be personal, personal-scoped, and deny for every role" % k)
        if c["principals"] != ["account"]:
            errs.append("0C account command %s must be human-account only" % k)
        if k in scoped:
            errs.append("0D scope lists account command %s (delegated principals cannot create tenants)" % k)
    used_commands = set()
    for f in runtime_sources():
        rel = os.path.relpath(f, ROOT)
        text = read(f)
        for m in AUTHZ_CALL.finditer(text):
            fn, key = m.group(1), m.group(2)
            if key not in A:
                errs.append("%s: %s uses %s, which is not a 0C action" % (rel, fn, key))
            elif key in commands and fn != "authorizeAccountCommand":
                errs.append("%s: account command %s reaches tenant/delegated evaluation via %s" % (rel, key, fn))
            elif fn == "authorizeAccountCommand":
                if key not in commands:
                    errs.append("%s: authorizeAccountCommand(%s) is not a registered account command" % (rel, key))
                used_commands.add(key)
    if os.path.isdir(P("packages/tenancy/src")):
        for k in sorted(set(commands) - used_commands):
            errs.append("0C account command %s has no runtime authorizeAccountCommand(...) use" % k)
    return errs


def check_brand_vocabulary(model):
    """0B brand vocabularies (ADR-19) == the migrated CHECK constraints == the runtime sources."""
    errs = []
    brand = next((e for e in model["entities"] if e["name"] == "brand"), None)
    if brand is None:
        return ["0B has no brand entity"]
    def vocab(column):
        for c in brand["key_columns"]:
            m = re.match(r"%s\b.*\(([a-z_|]+)\)\s*$" % re.escape(column), c)
            if m:
                return m.group(1).split("|")
        return None
    status = vocab("operational_status")
    modes = vocab("notification_content_mode")
    if status is None:
        errs.append("0B brand lacks the operational_status vocabulary (ADR-19)")
    if any(c.startswith("status ") for c in brand["key_columns"]):
        errs.append("0B brand still declares an undefined generic status column")
    if not os.path.isdir(P("packages/db/migrations")):
        return errs
    db_status = migrated_check_values("tenancy.brand", "brand_status_known", "operational_status")
    db_modes = migrated_check_values("tenancy.brand", "brand_notification_mode_known", "notification_content_mode")
    if status is not None and db_status != status:
        errs.append("DB brand operational_status %s differs from 0B %s" % (db_status, status))
    if modes is not None and db_modes != modes:
        errs.append("DB brand notification_content_mode %s differs from 0B %s" % (db_modes, modes))
    server = P("packages/tenancy/src/validation.ts")
    if os.path.exists(server) and "BRAND_OPERATIONAL_STATUSES" not in read(server):
        errs.append("packages/tenancy/src/validation.ts must take operational statuses from the generated 0B vocabulary")
    web = P("apps/web/src/tenancy/client.ts")
    if os.path.exists(web):
        m = re.search(r"export const OPERATIONAL_STATUSES = \[([^\]]*)\]", read(web))
        listed = re.findall(r"'([a-z_]+)'", m.group(1)) if m else None
        if listed != status:
            errs.append("apps/web/src/tenancy/client.ts OPERATIONAL_STATUSES %s differs from 0B %s" % (listed, status))
    return errs


def check_record_types(model):
    """The migrated core.record_type seed equals the 0B addressable entities (type, prefix, module)."""
    errs = []
    mig = P("packages/db/migrations")
    if not os.path.isdir(mig):
        return errs
    seeded = None
    for f in sorted(x for x in os.listdir(mig) if x.endswith(".up.sql")):
        m = re.search(r"INSERT INTO core\.record_type \(record_type, public_id_prefix, owner_module\) VALUES(.*?);", read(os.path.join(mig, f)), re.S)
        if m:
            seeded = set(re.findall(r"\('([a-z_]+)', '([a-z]+)', '([a-z_]+)'\)", m.group(1)))
    if seeded is None:
        return errs
    expected = {(e["name"], e["public_id_prefix"], e["module"]) for e in model["entities"] if e["addressable"]}
    for x in sorted(expected - seeded):
        errs.append("record type %s (%s_, %s) is addressable in 0B but not seeded in core.record_type" % x)
    for x in sorted(seeded - expected):
        errs.append("core.record_type seeds %s (%s_, %s), which is not an addressable 0B entity" % x)
    return errs


def main():
    rep = Report()
    run_packages(rep)
    model = load(P("docs/architecture/data/model/model.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    rep.add("cross: 0C-required data entities and fields in 0B", check_required_0c_data(model, policy))
    rep.add("cross: 0D execution context representable in 0B", check_exec_context(model))
    rep.add("cross: principals, prefixes, actions, scopes", check_identifiers(model, policy, registry))
    rep.add("cross: states, actors, classes, parameters", check_vocabularies(model, policy, registry))
    rep.add("cross: public surfaces (classes, decisions, webhooks, SSE)", check_public_surfaces(registry))
    rep.add("cross: stale contradiction language", check_stale_language())
    rep.add("cross: approved amendments present at source", check_required_statements())
    rep.add("cross: cross-phase blockers resolved", check_blockers())
    rep.add("cross: Phase 0 summary documents (links, references)", check_summary_docs())
    rep.add("cross: step-up actions and challenge states (0C/0D/runtime)", check_step_up(policy, registry))
    rep.add("cross: record types seeded from the 0B addressable entities", check_record_types(model))
    rep.add("cross: runtime authorization actions and account commands (0C)", check_runtime_actions(policy, registry))
    rep.add("cross: brand vocabularies (0B/DB/runtime)", check_brand_vocabulary(model))
    failed = 0
    for name, (errs, detail) in rep.sections.items():
        status = "PASS" if not errs else "FAIL (%d)" % len(errs)
        print("%-62s %s%s" % (name, status, ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 0 INTEGRATION: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
