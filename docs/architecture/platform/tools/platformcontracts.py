#!/usr/bin/env python3
"""Phase 0D platform contract tool (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/architecture/platform/tools/platformcontracts.py validate   # schemas, examples, registry, cross-phase refs, docs; exit 1 on error
    python3 docs/architecture/platform/tools/platformcontracts.py render     # regenerate docs/architecture/platform/generated/*.md

contracts/schemas/*.schema.json, contracts/examples/*.json and contracts/registry.json are authoritative.
The validator implements the JSON Schema 2020-12 keywords used by these schemas: type, enum, const, pattern,
required, properties, additionalProperties, items, minItems, minimum, maximum, minLength, maxLength,
minProperties, $ref (absolute $id with optional #/$defs/<name>), allOf, anyOf, not, if/then.
"""
import glob
import json
import os
import re
import sys
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
PLAT = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(PLAT)))
CONTRACTS = os.path.join(PLAT, "contracts")
GEN = os.path.join(PLAT, "generated")
CATALOG = os.path.join(ROOT, "docs", "product", "requirements", "catalog.json")
MODEL = os.path.join(ROOT, "docs", "architecture", "data", "model", "model.json")
DATA = os.path.join(ROOT, "docs", "architecture", "data")
ACCESS = os.path.join(ROOT, "docs", "architecture", "access")
POLICY = os.path.join(ACCESS, "policy", "policy.json")
THREATS = os.path.join(ACCESS, "policy", "threats.json")
CLASS_ORDER = ["C0", "C1", "C2", "C3", "C4"]
REQUIRED_ERRORS = ["validation_failed", "unauthenticated", "not_found", "conflict", "rate_limited", "idempotency_key_reuse",
                   "idempotency_in_progress", "approval_required", "step_up_required", "principal_suspended", "entitlement_required",
                   "usage_limit_reached", "dependency_unavailable", "partial_failure", "internal_error"]
REQUIRED_SCHEMAS = ["success-envelope", "error-envelope", "collection-page", "conflict", "idempotency-record", "operation", "attempt", "job",
                    "partial-result", "execution-context", "internal-event", "webhook-outbound", "webhook-delivery", "sse-notice",
                    "audit-event", "security-event", "notification", "usage-event", "usage-estimate", "entitlement-decision",
                    "upload-session", "file-reference", "approval-required", "step-up-challenge"]
RESOLUTIONS = ["dq-10", "dq-11", "dq-12", "dq-13", "dq-14", "dq-15", "dq-16", "dq-17", "aq-01", "aq-02", "aq-03", "aq-04", "aq-05"]
ZERO_A_PARAMS = {"TRASH_RECOVERY_PERIOD", "CANCELLATION_READ_ONLY_PERIOD", "PAYMENT_GRACE_PERIOD", "WORKSPACE_DELETION_GRACE_PERIOD",
                 "IMPORT_ROLLBACK_PERIOD", "EXPORT_LINK_LIFETIME"}


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def load(path):
    return json.loads(read(path), object_pairs_hook=OrderedDict)


# ------------------------------------------------------------------ JSON Schema subset
class Registry:
    def __init__(self, schemas):
        self.by_id = {s["$id"]: s for s in schemas.values()}

    def resolve(self, ref):
        base, _, frag = ref.partition("#")
        doc = self.by_id.get(base)
        if doc is None:
            raise KeyError(ref)
        if not frag:
            return doc
        node = doc
        for part in frag.strip("/").split("/"):
            node = node[part]
        return node


TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}


def is_type(v, t):
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return isinstance(v, TYPES[t])


def check(v, s, reg, path, errs):
    if "$ref" in s:
        try:
            check(v, reg.resolve(s["$ref"]), reg, path, errs)
        except KeyError:
            errs.append("%s: unresolved $ref %s" % (path, s["$ref"]))
    t = s.get("type")
    if t and not any(is_type(v, x) for x in (t if isinstance(t, list) else [t])):
        errs.append("%s: expected %s" % (path, t))
        return
    if "const" in s and v != s["const"]:
        errs.append("%s: must equal %r" % (path, s["const"]))
    if "enum" in s and v not in s["enum"]:
        errs.append("%s: %r not in enum" % (path, v))
    if isinstance(v, str):
        if "pattern" in s and not re.search(s["pattern"], v):
            errs.append("%s: %r does not match %s" % (path, v, s["pattern"]))
        if "minLength" in s and len(v) < s["minLength"]:
            errs.append("%s: too short" % path)
        if "maxLength" in s and len(v) > s["maxLength"]:
            errs.append("%s: too long" % path)
    if is_type(v, "number"):
        if "minimum" in s and v < s["minimum"]:
            errs.append("%s: below minimum" % path)
        if "maximum" in s and v > s["maximum"]:
            errs.append("%s: above maximum" % path)
    if isinstance(v, dict):
        for r in s.get("required", []):
            if r not in v:
                errs.append("%s: missing required %r" % (path, r))
        if "minProperties" in s and len(v) < s["minProperties"]:
            errs.append("%s: too few properties" % path)
        props = s.get("properties", {})
        ap = s.get("additionalProperties", True)
        for k, x in v.items():
            if k in props:
                check(x, props[k], reg, path + "." + k, errs)
            elif ap is False:
                errs.append("%s: unexpected property %r" % (path, k))
            elif isinstance(ap, dict):
                check(x, ap, reg, path + "." + k, errs)
    if isinstance(v, list):
        if "minItems" in s and len(v) < s["minItems"]:
            errs.append("%s: too few items" % path)
        if "items" in s:
            for i, x in enumerate(v):
                check(x, s["items"], reg, "%s[%d]" % (path, i), errs)
    for sub in s.get("allOf", []):
        check(v, sub, reg, path, errs)
    if "anyOf" in s:
        if not any(not _errs(v, sub, reg) for sub in s["anyOf"]):
            errs.append("%s: matches none of anyOf" % path)
    if "not" in s and not _errs(v, s["not"], reg):
        errs.append("%s: must not match forbidden shape" % path)
    if "if" in s and not _errs(v, s["if"], reg) and "then" in s:
        check(v, s["then"], reg, path, errs)


def _errs(v, s, reg):
    e = []
    check(v, s, reg, "$", e)
    return e


def walk(node, fn, path="$"):
    fn(node, path)
    if isinstance(node, dict):
        for k, v in node.items():
            walk(v, fn, path + "/" + k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, fn, "%s[%d]" % (path, i))


def refs_closure(schema, reg, seen=None):
    seen = set() if seen is None else seen
    out = []

    def fn(n, _p):
        if isinstance(n, dict) and "$ref" in n and n["$ref"] not in seen:
            seen.add(n["$ref"])
            out.append(n["$ref"])
            try:
                out.extend(refs_closure(reg.resolve(n["$ref"]), reg, seen))
            except KeyError:
                pass
    walk(schema, fn)
    return out


# ------------------------------------------------------------------ validation
def load_all():
    schemas = OrderedDict()
    for p in sorted(glob.glob(os.path.join(CONTRACTS, "schemas", "*.schema.json"))):
        schemas[os.path.basename(p)[:-len(".schema.json")]] = load(p)
    examples = OrderedDict()
    for p in sorted(glob.glob(os.path.join(CONTRACTS, "examples", "*.json"))):
        examples[os.path.basename(p)] = load(p)
    return schemas, examples, load(os.path.join(CONTRACTS, "registry.json"))


def validate(quiet=False):
    errors = []
    schemas, examples, reg_json = load_all()
    ids = Counter(s.get("$id") for s in schemas.values())
    for i, n in ids.items():
        if n > 1:
            errors.append("duplicate schema $id %s" % i)
    reg = Registry(schemas)
    for name in REQUIRED_SCHEMAS:
        if name not in schemas:
            errors.append("required schema missing: %s" % name)

    for name, s in schemas.items():
        for k in ("$schema", "$id", "title", "x-visibility", "x-max-class"):
            if k not in s:
                errors.append("%s: missing %s" % (name, k))
        if s.get("$id") != "urn:pm:schema:" + name:
            errors.append("%s: $id must be urn:pm:schema:%s" % (name, name))
        if s.get("x-visibility") not in ("public", "internal"):
            errors.append("%s: x-visibility must be public or internal" % name)
        maxc = s.get("x-max-class", "C0")
        closure = refs_closure(s, reg)
        for r in closure:
            try:
                reg.resolve(r)
            except KeyError:
                errors.append("%s: unresolved $ref %s" % (name, r))
        if s.get("x-visibility") == "public":
            for r in closure:
                if r.endswith("#/$defs/internal_uuid") or reg.by_id.get(r.partition("#")[0], {}).get("x-visibility") == "internal":
                    errors.append("%s: public schema reaches internal-only definition %s" % (name, r))

        def cls_check(n, p, name=name, maxc=maxc):
            if isinstance(n, dict) and "x-class" in n:
                c = n["x-class"]
                if c not in CLASS_ORDER:
                    errors.append("%s%s: unknown x-class %s" % (name, p, c))
                elif c == "C4":
                    errors.append("%s%s: C4 (secret) data is never allowed in a contract" % (name, p))
                elif CLASS_ORDER.index(c) > CLASS_ORDER.index(maxc):
                    errors.append("%s%s: x-class %s exceeds schema x-max-class %s" % (name, p, c, maxc))
        walk(s, cls_check)
        if name != "common" and not any(e.get("$schema_ref") == s.get("$id") for e in examples.values()):
            errors.append("%s: no example" % name)

    for fname, ex in examples.items():
        sid = ex.get("$schema_ref")
        if sid not in reg.by_id:
            errors.append("%s: unknown $schema_ref %s" % (fname, sid))
            continue
        for e in _errs(ex.get("example"), reg.by_id[sid], reg):
            errors.append("example %s: %s" % (fname, e))
        text = json.dumps(ex)
        if re.search(r"(?i)(password|secret|api[_-]?key|bearer)\"\s*:\s*\"[^\"]{6,}", text):
            errors.append("example %s: looks like it contains a secret value" % fname)

    errors += check_registry(reg_json)
    errors += check_docs(reg_json)

    for name, text in render_all(schemas, examples, reg_json).items():
        path = os.path.join(GEN, name)
        if not os.path.exists(path) or read(path) != text:
            errors.append("generated/%s is out of date; run `platformcontracts.py render`" % name)

    if not quiet:
        print("Schemas             : %d (%d public, %d internal)" % (len(schemas), sum(1 for s in schemas.values() if s.get("x-visibility") == "public"),
                                                                   sum(1 for s in schemas.values() if s.get("x-visibility") == "internal")))
        print("Examples validated  : %d" % len(examples))
        r = reg_json
        print("Registry            : %d ID prefixes, %d error codes, %d operation kinds, %d events (%d public webhook types), %d scopes, %d meters, "
              "%d notification types, %d telemetry signals, %d named parameters" % (
                  len(r["id_prefixes"]), len(r["error_codes"]), len(r["operation_kinds"]), len(r["events"]),
                  sum(1 for e in r["events"] if e["public_webhook"]), len(r["scopes"]), len(r["meters"]), len(r["notification_types"]),
                  len(r["telemetry"]), len(r["parameters"])))
        for e in errors:
            print("ERROR: " + e)
        print("RESULT: %s" % ("PASS" if not errors else "FAIL (%d errors)" % len(errors)))
    return errors


def dupes(items, key, what):
    c = Counter(i[key] for i in items)
    return ["duplicate %s %s" % (what, k) for k, n in c.items() if n > 1]


def parse_backticked_list(text, marker):
    m = re.search(marker, text)
    return re.findall(r"`([a-z_]+)`", m.group(1)) if m else None


def check_registry(r):
    errors = []
    model = load(MODEL)
    ents = {"%s.%s" % (e["module"], e["name"]): e for e in model["entities"]}
    modules = {m["id"] for m in model["modules"]}
    req_ids = {x["id"] for x in load(CATALOG)["requirements"]}
    policy, threats = load(POLICY), load(THREATS)
    actions = {a["key"] for a in policy["actions"]}
    principals = {p["id"] for p in policy["principals"]}
    risks = {x["id"] for x in policy["risk_classes"]}

    errors += dupes(r["id_prefixes"], "prefix", "ID prefix") + dupes(r["id_prefixes"], "resource", "ID resource")
    errors += dupes(r["error_codes"], "code", "error code") + dupes(r["events"], "type", "event type")
    errors += dupes([e for e in r["events"] if e["public_webhook"]], "public_webhook", "webhook type")
    errors += dupes(r["scopes"], "scope", "scope") + dupes(r["meters"], "meter", "meter") + dupes(r["operation_kinds"], "kind", "operation kind")
    errors += dupes(r["notification_types"], "type", "notification type") + dupes(r["telemetry"], "name", "telemetry signal")
    errors += dupes(r["parameters"], "name", "parameter")

    # ID prefixes vs 0B model
    reg_prefix = {p["prefix"]: p for p in r["id_prefixes"]}
    for e in model["entities"]:
        if e["addressable"] and e["public_id_prefix"] and e["public_id_prefix"] != "(per type)":
            p = reg_prefix.get(e["public_id_prefix"])
            if not p or p["entity"] != "%s.%s" % (e["module"], e["name"]):
                errors.append("ID prefix %s for %s.%s missing or mismatched in registry" % (e["public_id_prefix"], e["module"], e["name"]))
    for p in r["id_prefixes"]:
        if not re.match(r"^[a-z]{2,5}$", p["prefix"]):
            errors.append("prefix %r must be 2-5 lowercase letters" % p["prefix"])
        if p["entity"] and p["entity"] not in ents:
            errors.append("prefix %s references unknown entity %s" % (p["prefix"], p["entity"]))
        if p.get("owner_module") not in modules:
            errors.append("prefix %s has unknown owner module %s" % (p["prefix"], p.get("owner_module")))
        if p["entity"] and p.get("owner_module") != ents[p["entity"]]["module"] if p["entity"] in ents else False:
            errors.append("prefix %s owner module differs from its entity's module" % p["prefix"])
        if not p["entity"] and not (p.get("platform_only") and p.get("note")):
            errors.append("prefix %s has no data entity and no documented platform-only owner" % p["prefix"])

    # vocabularies vs 0B documents
    b02, b05 = read(os.path.join(DATA, "02-logical-model.md")), read(os.path.join(DATA, "05-state-representation.md"))
    actor = parse_backticked_list(b02, r"`created_by_actor_type`[^|]*\|[^|]*\|([^|]*)\|")
    if actor is None or set(actor) - {"actor_type"} != set(r["actor_types"]):
        errors.append("actor_types %s do not match 0B 02-logical-model (%s)" % (r["actor_types"], actor))
    exec_states = parse_backticked_list(b05, r"enum `exec_state`:([^+|]*)")
    if exec_states is None or exec_states != r["exec_states"]:
        errors.append("exec_states %s do not match 0B 05-state-representation (%s)" % (r["exec_states"], exec_states))
    reasons = parse_backticked_list(b05, r"`terminal_reason` \(([^)]*)\)")
    if reasons is None or set(reasons) != set(r["terminal_reasons"]):
        errors.append("terminal_reasons %s do not match 0B (%s)" % (r["terminal_reasons"], reasons))
    for js, es in r["job_states"].items():
        if es not in r["exec_states"]:
            errors.append("job state %s maps to unknown exec_state %s" % (js, es))

    # errors
    codes = {e["code"] for e in r["error_codes"]}
    for c in REQUIRED_ERRORS:
        if c not in codes:
            errors.append("required error code missing: %s" % c)
    for e in r["error_codes"]:
        st = e["http_status"]
        if st is not None and not (400 <= st <= 599):
            errors.append("error %s: http_status must be 4xx/5xx or null" % e["code"])
        if st is None and e["usage"] == "http":
            errors.append("error %s: http usage needs a status" % e["code"])
    nf = [e for e in r["error_codes"] if e["code"] == "not_found"]
    if not nf or "Uniform" not in nf[0]["disclosure_rule"]:
        errors.append("not_found must carry the uniform non-disclosure rule")
    # authz response shapes (0C) all mapped
    shapes = set(threats["response_shapes"])
    if set(r["authz_response_shapes"]) != shapes:
        errors.append("authz_response_shapes keys %s must equal 0C response shapes %s" % (sorted(r["authz_response_shapes"]), sorted(shapes)))
    for k, v in r["authz_response_shapes"].items():
        for part in re.findall(r"error:([a-z_]+)", v):
            if part not in codes:
                errors.append("shape %s maps to unknown error %s" % (k, part))

    # operation kinds
    for o in r["operation_kinds"]:
        if o["detail_entity"] and o["detail_entity"] not in ents:
            errors.append("operation kind %s: unknown entity %s" % (o["kind"], o["detail_entity"]))
        if o["risk_class"] not in risks:
            errors.append("operation kind %s: unknown risk class" % o["kind"])
        for s in o["supports"]:
            if s not in ("cancel", "pause", "resume", "retry", "rerun"):
                errors.append("operation kind %s: unknown control %s" % (o["kind"], s))

    # events
    for e in r["events"]:
        t = e["type"]
        if not re.match(r"^[a-z]+\.[a-z_]+\.[a-z_]+$", t):
            errors.append("event %s: name must be <module>.<entity>.<past_tense_verb>" % t)
        mod = t.split(".")[0]
        if mod not in modules:
            errors.append("event %s: unknown module %s" % (t, mod))
        if e["aggregate_entity"] not in ents:
            errors.append("event %s: unknown aggregate entity %s" % (t, e["aggregate_entity"]))
        elif ents[e["aggregate_entity"]]["module"] != mod:
            errors.append("event %s: published by %s but aggregate belongs to %s" % (t, mod, ents[e["aggregate_entity"]]["module"]))
        if CLASS_ORDER.index(e["max_class"]) > CLASS_ORDER.index("C2"):
            errors.append("event %s: payload class above C2 (C3 travels by reference only)" % t)
        if e["public_webhook"] and not re.match(r"^[a-z_]+\.[a-z_]+$", e["public_webhook"]):
            errors.append("event %s: bad public webhook type" % t)
        if e["public_webhook"] and (not isinstance(e.get("allow_list_version"), int) or e.get("delivery_authorization") != "subscription_owner_at_delivery"):
            errors.append("event %s: public webhook needs a versioned allow-list and authorization at delivery" % t)
        for rid in e["requirements"]:
            if rid not in req_ids:
                errors.append("event %s: unknown requirement %s" % (t, rid))

    # scopes vs 0C
    for s in r["scopes"]:
        if not re.match(r"^[a-z_]+:[a-z_]+$", s["scope"]):
            errors.append("scope %s: must be <family>:<access>" % s["scope"])
        for a in s["actions"]:
            if a not in actions:
                errors.append("scope %s: unknown 0C action %s" % (s["scope"], a))
        for p in s["principals"]:
            if p not in principals:
                errors.append("scope %s: unknown 0C principal %s" % (s["scope"], p))
    step_up_actions = {a["key"] for a in policy["actions"] if a["step_up"]}
    for s in r["scopes"]:
        for a in s["actions"]:
            if a in step_up_actions and set(s["principals"]) - {"api_token_personal", "oauth_client"}:
                errors.append("scope %s grants step-up action %s to non-human-backed principals" % (s["scope"], a))

    for n in r["notification_types"]:
        if n["requirement"] not in req_ids:
            errors.append("notification type %s: unknown requirement %s" % (n["type"], n["requirement"]))
    for t in r["telemetry"]:
        for l in t["labels"]:
            if l in r["forbidden_metric_labels"]:
                errors.append("telemetry %s uses forbidden high-cardinality/content label %s" % (t["name"], l))
    return errors


def anchors_of(path, cache={}):
    if path not in cache:
        text = read(path)
        a = set(re.findall(r'<a id="([^"]+)"', text))
        for h in re.findall(r"^#+ (.+)$", text, re.M):
            a.add(re.sub(r"[^\w\- ]", "", h.strip().lower()).replace(" ", "-"))
        cache[path] = a
    return cache[path]


def check_docs(r):
    errors = []
    prefixes = load(CATALOG)["section_prefixes"].values()
    req_ids = {x["id"] for x in load(CATALOG)["requirements"]}
    req_re = re.compile(r"\b(%s)-(\d{3})\b" % "|".join(sorted(prefixes, key=len, reverse=True)))
    sets = {
        "OD": set(re.findall(r'<a id="od-(\d+)"', read(os.path.join(ROOT, "docs", "product", "open-decisions.md")))),
        "UXD": set(re.findall(r'<a id="uxd-(\d+)"', read(os.path.join(ROOT, "docs", "ux", "09-decisions-and-risks.md")))),
        "ADR": set(re.findall(r'<a id="adr-(\d+)"', read(os.path.join(DATA, "12-decisions.md")))),
        "DQ": set(re.findall(r'<a id="dq-(\d+)"', read(os.path.join(DATA, "13-open-questions.md")))),
        "AZ": set(re.findall(r'<a id="az-(\d+)"', read(os.path.join(ACCESS, "15-decisions.md")))),
        "AQ": set(re.findall(r'<a id="aq-(\d+)"', read(os.path.join(ACCESS, "16-open-questions.md")))),
        "AC": set(re.findall(r'<a id="ac-(\d+)"', read(os.path.join(ACCESS, "16-open-questions.md")))),
        "PL": set(re.findall(r'<a id="pl-(\d+)"', read(os.path.join(PLAT, "19-decisions.md")))),
        "PQ": set(re.findall(r'<a id="pq-(\d+)"', read(os.path.join(PLAT, "20-open-questions.md")))),
        "PC": set(re.findall(r'<a id="pc-(\d+)"', read(os.path.join(PLAT, "20-open-questions.md")))),
    }
    invariants = {i["id"] for i in load(POLICY)["invariants"]}
    actions = {a["key"] for a in load(POLICY)["actions"]}
    params = {p["name"] for p in r["parameters"]} | ZERO_A_PARAMS | {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
    codes = {e["code"] for e in r["error_codes"]}
    events = {e["type"] for e in r["events"]}
    dec = read(os.path.join(PLAT, "19-decisions.md"))
    for res in RESOLUTIONS:
        if '<a id="resolve-%s"></a>' % res not in dec:
            errors.append("19-decisions.md lacks resolution anchor for %s" % res.upper())
    for base, _d, files in os.walk(PLAT):
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
                tp = os.path.normpath(os.path.join(os.path.dirname(path), target)) if target else path
                if not os.path.exists(tp):
                    errors.append("%s: broken link %s" % (rel, url))
                elif frag and tp.endswith(".md") and frag not in anchors_of(tp):
                    errors.append("%s: broken anchor %s" % (rel, url))
            for m in req_re.finditer(text):
                if m.group(0) not in req_ids:
                    errors.append("%s: unknown requirement %s" % (rel, m.group(0)))
            for key, ids in sets.items():
                for num in set(re.findall(r"\b%s-(\d+)\b" % key, text)):
                    if num not in ids:
                        errors.append("%s: unknown %s-%s" % (rel, key, num))
            for inv in set(re.findall(r"\bI-\d\d\b", text)):
                if inv not in invariants:
                    errors.append("%s: unknown 0C invariant %s" % (rel, inv))
            for a in set(re.findall(r"`([a-z_]+\.[a-z_]+(?:\.[a-z_]+)?)` action", text)):
                if a not in actions:
                    errors.append("%s: unknown 0C action %s" % (rel, a))
            for p in set(re.findall(r"`([A-Z][A-Z0-9_]{3,})`", text)):
                if p not in params:
                    errors.append("%s: unknown named parameter %s" % (rel, p))
            for c in set(re.findall(r"`([a-z_]+)` error", text)):
                if c not in codes:
                    errors.append("%s: unknown error code %s" % (rel, c))
            for ev in set(re.findall(r"`([a-z]+\.[a-z_]+\.[a-z_]+)` event", text)):
                if ev not in events:
                    errors.append("%s: unknown event %s" % (rel, ev))
    return errors


# ------------------------------------------------------------------ rendering
HEADER = "<!-- GENERATED by docs/architecture/platform/tools/platformcontracts.py render. Do not edit by hand. -->\n\n"


def esc(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def type_of(p):
    if "$ref" in p:
        return "`%s`" % p["$ref"].replace("urn:pm:schema:", "").replace("#/$defs/", "#")
    t = p.get("type", "any")
    if t == "array" and "items" in p:
        return "array of %s" % type_of(p["items"])
    if "enum" in p:
        return "%s enum: %s" % (t, ", ".join("`%s`" % x for x in p["enum"]))
    if "const" in p:
        return "const `%s`" % p["const"]
    return str(t)


def render_schemas(schemas, examples):
    out = [HEADER, "# Contract schema reference\n\nNarrative: [../18-contract-catalog.md](../18-contract-catalog.md). Schemas: `contracts/schemas/`. "
           "Every example below is validated against its schema by the validator.\n"]
    for name, s in schemas.items():
        out.append("\n## `%s`\n\n%s · visibility **%s** · max class **%s**\n" % (s["$id"], s.get("title", ""), s.get("x-visibility"), s.get("x-max-class")))
        props = s.get("properties")
        if props:
            req = set(s.get("required", []))
            out.append("\n| Field | Type | Required | Class |\n|---|---|---|---|\n")
            for k, p in props.items():
                out.append("| `%s` | %s | %s | %s |\n" % (k, esc(type_of(p)), "yes" if k in req else "", p.get("x-class", "")))
        if "$defs" in s:
            out.append("\n| Definition | Type | Notes |\n|---|---|---|\n")
            for k, p in s["$defs"].items():
                out.append("| `%s` | %s | %s |\n" % (k, esc(type_of(p)), esc(p.get("description", "") or (("pattern `%s`" % p["pattern"]) if "pattern" in p else ""))))
        exs = [(f, e) for f, e in examples.items() if e["$schema_ref"] == s["$id"]]
        for f, e in exs:
            out.append("\n<details><summary>Example %s</summary>\n\n```json\n%s\n```\n</details>\n" % (f, json.dumps(e["example"], indent=2, ensure_ascii=False)))
    return "".join(out)


def table(rows, cols):
    out = "| %s |\n|%s\n" % (" | ".join(c[0] for c in cols), "---|" * len(cols))
    for r in rows:
        out += "| %s |\n" % " | ".join(esc(c[1](r)) for c in cols)
    return out


def render_registry(r):
    yn = lambda b: "yes" if b else ""
    out = [HEADER, "# Contract registries\n\nSource: `contracts/registry.json`.\n",
           "\n## Public ID prefixes\n\n", table(r["id_prefixes"], [("Prefix", lambda x: "`%s_`" % x["prefix"]), ("Resource", lambda x: x["resource"]), ("0B entity", lambda x: x["entity"] or "—"), ("Owner module", lambda x: x["owner_module"]), ("Platform-only note", lambda x: x["note"] or "")]),
           "\n## Error codes\n\n", table(r["error_codes"], [("Code", lambda x: "`%s`" % x["code"]), ("HTTP", lambda x: x["http_status"] or "—"), ("Category", lambda x: x["category"]),
                                                          ("Retryable", lambda x: yn(x["retryable"])), ("Safe message", lambda x: x["safe_message"]), ("Usage", lambda x: x["usage"]), ("Disclosure rule", lambda x: x["disclosure_rule"])]),
           "\n## 0C response shapes → platform responses\n\n", table(list(r["authz_response_shapes"].items()), [("0C shape", lambda x: "`%s`" % x[0]), ("Platform response", lambda x: x[1])]),
           "\n## States\n\n- exec states: %s\n- terminal reasons: %s\n- waiting reasons: %s\n- actor types: %s\n" % tuple(", ".join("`%s`" % v for v in r[k]) for k in ("exec_states", "terminal_reasons", "waiting_reasons", "actor_types")),
           "\n| Job state | Operation exec state |\n|---|---|\n" + "".join("| `%s` | `%s` |\n" % kv for kv in r["job_states"].items()),
           "\n## Operation kinds\n\n", table(r["operation_kinds"], [("Kind", lambda x: "`%s`" % x["kind"]), ("Detail entity", lambda x: x["detail_entity"] or "—"), ("Controls", lambda x: ", ".join(x["supports"]) or "—"), ("Risk", lambda x: x["risk_class"])]),
           "\n## Internal events\n\n", table(r["events"], [("Type", lambda x: "`%s` v%d" % (x["type"], x["schema_version"])), ("Aggregate", lambda x: x["aggregate_entity"]), ("Fields", lambda x: ", ".join(x["fields"])),
                                                         ("Max class", lambda x: x["max_class"]), ("Activity", lambda x: yn(x["consumers"]["activity"])), ("Notify", lambda x: yn(x["consumers"]["notification"])),
                                                         ("Metrics", lambda x: yn(x["consumers"]["metrics"])), ("Automation", lambda x: yn(x["consumers"]["automation_trigger"])), ("Index", lambda x: yn(x["consumers"]["search_index"])),
                                                         ("Public webhook", lambda x: "`%s`" % x["public_webhook"] if x["public_webhook"] else "—")]),
           "\n## SSE topics\n\n", table(r["sse_topics"], [("Topic", lambda x: "`%s`" % x["topic"]), ("Authorization", lambda x: x["authorization"]), ("0C context parameters", lambda x: ", ".join("`%s`" % c for c in x["0c_context"]))]),
           "\n## Token and OAuth scopes\n\n", table(r["scopes"], [("Scope", lambda x: "`%s`" % x["scope"]), ("Description", lambda x: x["description"]), ("0C actions", lambda x: ", ".join(x["actions"])), ("Principals", lambda x: ", ".join(x["principals"]))]),
           "\n## Meters\n\n", table(r["meters"], [("Meter", lambda x: "`%s`" % x["meter"]), ("Unit", lambda x: x["unit"]), ("Kind", lambda x: x["kind"]), ("Billing relevant", lambda x: yn(x["billing_relevant"]))]),
           "\n## Notification types\n\n", table(r["notification_types"], [("Type", lambda x: "`%s`" % x["type"]), ("Requirement", lambda x: x["requirement"])]),
           "\n## Telemetry signals\n\nForbidden metric labels: %s.\n\n" % ", ".join("`%s`" % l for l in r["forbidden_metric_labels"]),
           table(r["telemetry"], [("Signal", lambda x: "`%s`" % x["name"]), ("Type", lambda x: x["type"]), ("Labels", lambda x: ", ".join(x["labels"]) or "—"), ("Area", lambda x: x["area"])]),
           "\n## Named parameters (values are configuration, not promises)\n\n", table(r["parameters"], [("Parameter", lambda x: "`%s`" % x["name"]), ("Meaning", lambda x: x["meaning"]), ("Owner", lambda x: x["owner"])])]
    return "".join(out)


def render_all(schemas, examples, registry):
    return OrderedDict([("schema-reference.md", render_schemas(schemas, examples)), ("registries.md", render_registry(registry))])


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "validate"
    if cmd == "validate":
        return 1 if validate() else 0
    if cmd == "render":
        os.makedirs(GEN, exist_ok=True)
        schemas, examples, registry = load_all()
        for name, text in render_all(schemas, examples, registry).items():
            with open(os.path.join(GEN, name), "w", encoding="utf-8") as fh:
                fh.write(text)
            print("wrote docs/architecture/platform/generated/%s" % name)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
