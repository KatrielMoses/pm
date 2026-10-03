#!/usr/bin/env python3
"""Phase 0B logical data model tool (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/architecture/data/tools/datamodel.py validate   # model invariants, coverage, links, generated docs; exit 1 on error
    python3 docs/architecture/data/tools/datamodel.py render     # regenerate docs/architecture/data/generated/*.md

model/model.json is the authoritative machine-readable logical model.
"""
import json
import os
import re
import sys
from collections import Counter, OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(DATA)))
MODEL = os.path.join(DATA, "model", "model.json")
SCHEMA = os.path.join(DATA, "model", "model.schema.json")
GEN = os.path.join(DATA, "generated")
CATALOG = os.path.join(ROOT, "docs", "product", "requirements", "catalog.json")
PRODUCT_DECISIONS = os.path.join(ROOT, "docs", "product", "open-decisions.md")
UX_DECISIONS = os.path.join(ROOT, "docs", "ux", "09-decisions-and-risks.md")

NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
BRAND_SCOPES = {"brand"}
SCOPE_OK_PARENTS = {
    # child scope -> scopes a containment parent may have
    "brand": {"brand", "inherited"},
    "workspace_or_brand": {"brand", "workspace_or_brand", "inherited", "workspace"},
    "workspace": {"workspace", "platform", "inherited"},
    "personal": {"personal", "platform", "workspace", "workspace_or_brand", "inherited"},
    "personal_brand_optional": {"brand", "personal", "personal_brand_optional", "inherited"},
    "platform": {"platform"},
    "inherited": None,  # any; inherits from its parent
}


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def load(path):
    return json.loads(read(path), object_pairs_hook=OrderedDict)


# ------------------------------------------------------------ JSON Schema subset

def check_schema(value, schema, path, errors):
    t = schema.get("type")
    types = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool, "null": type(None)}
    if t:
        allowed = t if isinstance(t, list) else [t]
        if not any(isinstance(value, types[a]) and not (a == "integer" and isinstance(value, bool)) for a in allowed):
            errors.append("%s: expected %s" % (path, "/".join(allowed)))
            return
    if "enum" in schema and value not in schema["enum"]:
        errors.append("%s: %r not in %s" % (path, value, schema["enum"]))
    if isinstance(value, dict):
        for req in schema.get("required", []):
            if req not in value:
                errors.append("%s: missing %r" % (path, req))
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for k in value:
                if k not in props:
                    errors.append("%s: unexpected property %r" % (path, k))
        for k, sub in props.items():
            if k in value:
                check_schema(value[k], sub, "%s.%s" % (path, k), errors)
        if isinstance(schema.get("additionalProperties"), dict):
            for k, v in value.items():
                if k not in props:
                    check_schema(v, schema["additionalProperties"], "%s.%s" % (path, k), errors)
    if isinstance(value, list) and "items" in schema:
        for i, v in enumerate(value):
            check_schema(v, schema["items"], "%s[%d]" % (path, i), errors)


# ------------------------------------------------------------ validation

def module_cycles(modules):
    deps = {m["id"]: m["depends_on"] for m in modules}
    state, cycles = {}, []

    def visit(n, stack):
        state[n] = 1
        for d in deps.get(n, []):
            if state.get(d) == 1:
                cycles.append(" -> ".join(stack[stack.index(d):] + [d]) if d in stack else "%s -> %s" % (n, d))
            elif state.get(d) is None:
                visit(d, stack + [d])
        state[n] = 2

    for n in deps:
        if state.get(n) is None:
            visit(n, [n])
    return cycles


def validate(model, quiet=False):
    errors, warnings = [], []
    check_schema(model, load(SCHEMA), "model", errors)
    if errors:
        return report(errors, warnings, model, quiet)
    voc = model["vocabulary"]
    modules = {m["id"]: m for m in model["modules"]}
    ents = OrderedDict()
    for e in model["entities"]:
        if e["name"] in ents:
            errors.append("duplicate entity %s" % e["name"])
        ents[e["name"]] = e

    # modules
    for m in model["modules"]:
        for d in m["depends_on"]:
            if d not in modules:
                errors.append("module %s depends on unknown module %s" % (m["id"], d))
            elif modules[d]["layer"] > m["layer"]:
                errors.append("module %s (layer %d) depends on higher-layer module %s (layer %d)"
                              % (m["id"], m["layer"], d, modules[d]["layer"]))
    for c in module_cycles(model["modules"]):
        errors.append("module dependency cycle: %s" % c)
    owned = Counter(e["module"] for e in ents.values())
    for mid in modules:
        if not owned.get(mid):
            errors.append("module %s owns no entities" % mid)

    # entities
    prefixes = Counter(e["public_id_prefix"] for e in ents.values() if e["addressable"])
    for p, n in prefixes.items():
        if n > 1 and p != "(per type)":
            errors.append("public ID prefix %r used by %d entities" % (p, n))
    vocab_fields = [("scope", "scopes"), ("lifecycle", "lifecycles"), ("concurrency", "concurrency"),
                    ("retention_class", "retention_classes"), ("confidentiality", "confidentiality"),
                    ("export", "export"), ("search_ai", "search_ai"), ("may_contain_secrets", "secrets"), ("volume", "volume")]
    for e in ents.values():
        n = e["name"]
        if not NAME_RE.match(n):
            errors.append("entity name %r is not snake_case" % n)
        if e["module"] not in modules:
            errors.append("%s: unknown module %s" % (n, e["module"]))
            continue
        for field, vk in vocab_fields:
            if e[field] not in voc[vk]:
                errors.append("%s: %s %r not in vocabulary.%s" % (n, field, e[field], vk))
        mod = modules[e["module"]]
        refs = [("containment parent", r) for r in e["containment_parents"]] + [("association", r) for r in e["associations"]]
        if e.get("extends"):
            refs.append(("extends", e["extends"]))
        for kind, r in refs:
            if r not in ents:
                errors.append("%s: %s references unknown entity %s" % (n, kind, r))
                continue
            rm = ents[r]["module"]
            if rm != e["module"] and rm not in mod["depends_on"]:
                errors.append("%s (%s): %s %s belongs to module %s, which %s does not depend on"
                              % (n, e["module"], kind, r, rm, e["module"]))
        # containment never crosses brand boundaries
        allowed = SCOPE_OK_PARENTS.get(e["scope"])
        for r in e["containment_parents"]:
            if r not in ents or allowed is None:
                continue
            ps = ents[r]["scope"]
            if n == "brand" and r == "workspace":
                continue
            if ps not in allowed:
                errors.append("%s (scope %s): containment parent %s has incompatible scope %s" % (n, e["scope"], r, ps))
        if e["scope"] == "inherited" and not (e["containment_parents"] or e["associations"] or e.get("extends")):
            errors.append("%s: inherited scope needs a parent, host association, or extends" % n)
        if e["lifecycle"] == "full" and not e["addressable"] and n != "record":
            errors.append("%s: lifecycle 'full' requires an addressable record (core.record)" % n)
        if e["addressable"] and not e["public_id_prefix"]:
            errors.append("%s: addressable entity needs public_id_prefix" % n)
        if e["confidentiality"] == "C4" and (e["export"] != "never" or e["search_ai"] != "no"):
            errors.append("%s: C4 (secret) data must have export=never and search_ai=no" % n)
        if e["may_contain_secrets"] == "secret-ref" and e["export"] == "full":
            errors.append("%s: entities holding secret references are never in full exports" % n)
        if e["may_contain_secrets"] == "possible" and e["search_ai"] == "yes":
            errors.append("%s: content that may contain secrets cannot be search/AI eligible without redaction" % n)
        if e["confidentiality"] == "C3" and e["search_ai"] == "yes":
            errors.append("%s: C3 (sensitive) data may be at most metadata-eligible for search/AI" % n)
        if e["retention_class"] == "R-EVIDENCE" and e["lifecycle"] in ("mutable", "ephemeral"):
            errors.append("%s: evidence cannot be mutable or ephemeral" % n)
        if e["lifecycle"] == "append-only" and e["concurrency"] not in ("append-only", "locked"):
            errors.append("%s: append-only entities use append-only or locked concurrency" % n)

    # requirement traceability and feature coverage
    cat = load(CATALOG)
    ids = {r["id"] for r in cat["requirements"]}
    for e in ents.values():
        for rid in e["requirements"]:
            if rid not in ids:
                errors.append("%s references unknown requirement %s" % (e["name"], rid))
    covered = {s for m in model["modules"] for s in m["feature_sections"]}
    for section, pfx in cat["section_prefixes"].items():
        if pfx == "LA":
            continue
        if pfx not in covered:
            errors.append("FEATURES section %r (%s) is not covered by any module" % (section, pfx))
        traced = {e["name"] for e in ents.values() if any(r.startswith(pfx + "-") for r in e["requirements"])}
        if not traced:
            errors.append("no entity traces any %s requirement" % pfx)
    for m in model["modules"]:
        for s in m["feature_sections"]:
            if s not in cat["section_prefixes"].values():
                errors.append("module %s lists unknown feature section %s" % (m["id"], s))

    check_docs(model, ents, ids, errors)

    for name, text in render_all(model).items():
        path = os.path.join(GEN, name)
        if not os.path.exists(path) or read(path) != text:
            errors.append("generated/%s is out of date; run `datamodel.py render`" % name)

    return report(errors, warnings, model, quiet)


def anchors_of(path, cache={}):
    if path not in cache:
        text = read(path)
        a = set(re.findall(r'<a id="([^"]+)"', text))
        for h in re.findall(r"^#+ (.+)$", text, re.M):
            s = re.sub(r"[^\w\- ]", "", h.strip().lower()).replace(" ", "-")
            a.add(s)
        cache[path] = a
    return cache[path]


def check_docs(model, ents, req_ids, errors):
    prod_od = set(re.findall(r'<a id="(od-\d+)"', read(PRODUCT_DECISIONS)))
    ux_ids = set(re.findall(r'<a id="(uxd-\d+)"', read(UX_DECISIONS))) if os.path.exists(UX_DECISIONS) else set()
    prefixes = load(CATALOG)["section_prefixes"].values()
    req_re = re.compile(r"\b(%s)-(\d{3})\b" % "|".join(sorted(prefixes, key=len, reverse=True)))
    adr_text = read(os.path.join(DATA, "12-decisions.md"))
    adrs = set(re.findall(r'<a id="(adr-\d+)"', adr_text))
    oqs = set(re.findall(r'<a id="(dq-\d+)"', read(os.path.join(DATA, "13-open-questions.md"))))
    for base, _d, files in os.walk(DATA):
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
            for m in req_re.finditer(text):
                if m.group(0) not in req_ids:
                    errors.append("%s: unknown requirement %s" % (rel, m.group(0)))
            for od in set(re.findall(r"\bOD-(\d+)\b", text)):
                if "od-%s" % od not in prod_od:
                    errors.append("%s: unknown product decision OD-%s" % (rel, od))
            for ux in set(re.findall(r"\bUXD-(\d+)\b", text)):
                if "uxd-%s" % ux not in ux_ids:
                    errors.append("%s: unknown UX decision UXD-%s" % (rel, ux))
            for a in set(re.findall(r"\bADR-(\d+)\b", text)):
                if "adr-%s" % a not in adrs:
                    errors.append("%s: unknown ADR-%s" % (rel, a))
            for q in set(re.findall(r"\bDQ-(\d+)\b", text)):
                if "dq-%s" % q not in oqs:
                    errors.append("%s: unknown open question DQ-%s" % (rel, q))
            for ent in set(re.findall(r"`([a-z][a-z0-9_]*)` entity", text)):
                if ent not in ents:
                    errors.append("%s: unknown entity `%s`" % (rel, ent))
            # Mermaid structural check
            for block in re.findall(r"```mermaid\n(.*?)```", text, re.S):
                check_mermaid(block, rel, errors)


MERMAID_ER_LINE = re.compile(r'^\s*[a-z][a-z0-9_]* (\|\||\}o|\|o|\}\|)(--|\.\.)(\|\||o\{|o\||\|\{) [a-z][a-z0-9_]* : "[^"]*"\s*$')
MERMAID_FLOW_EDGE = re.compile(r"^\s*[a-z][a-z0-9_]* --> [a-z][a-z0-9_]*\s*$")
MERMAID_FLOW_NODE = re.compile(r'^\s*[a-z][a-z0-9_]*\["[^"]+"\]\s*$')


def check_mermaid(block, rel, errors):
    lines = [l for l in block.split("\n") if l.strip() and not l.strip().startswith("%%")]
    if not lines:
        errors.append("%s: empty mermaid block" % rel)
        return
    head = lines[0].strip()
    if head == "erDiagram":
        for l in lines[1:]:
            if not MERMAID_ER_LINE.match(l):
                errors.append("%s: invalid erDiagram line: %s" % (rel, l.strip()))
    elif head.startswith("flowchart"):
        for l in lines[1:]:
            s = l.strip()
            if s.startswith(("subgraph", "end", "classDef", "class ", "direction")):
                continue
            if not (MERMAID_FLOW_EDGE.match(l) or MERMAID_FLOW_NODE.match(l)):
                errors.append("%s: invalid flowchart line: %s" % (rel, s))
    else:
        errors.append("%s: unsupported mermaid diagram type %r" % (rel, head))


def report(errors, warnings, model, quiet):
    if not quiet:
        ents = model.get("entities", [])
        mods = model.get("modules", [])
        print("Modules             : %d" % len(mods))
        print("Entities            : %d (%d addressable via core.record)" % (len(ents), sum(1 for e in ents if e.get("addressable"))))
        by_scope = Counter(e.get("scope") for e in ents)
        print("Entities by scope   : " + ", ".join("%s %d" % kv for kv in sorted(by_scope.items())))
        print("Requirement traces  : %d IDs referenced" % len({r for e in ents for r in e.get("requirements", [])}))
        for w in warnings:
            print("WARNING: " + w)
        for e in errors:
            print("ERROR: " + e)
        print("RESULT: %s" % ("PASS" if not errors else "FAIL (%d errors)" % len(errors)))
    return errors


# ------------------------------------------------------------ rendering

HEADER = "<!-- GENERATED by docs/architecture/data/tools/datamodel.py render from model/model.json. Do not edit by hand. -->\n\n"


def esc(s):
    return str(s).replace("|", "\\|")


def anchor(name):
    return "entity-%s" % name.replace("_", "-")


def elink(name, ents, here_module=None):
    e = ents[name]
    return "[`%s`](logical-model.md#%s)" % (name, anchor(name))


def render_modules(model):
    ents = model["entities"]
    out = [HEADER, "# Module index\n\n", "Narrative and rules: [../01-module-map.md](../01-module-map.md).\n\n",
           "```mermaid\nflowchart BT\n"]
    for m in model["modules"]:
        out.append('  %s["%s (L%d)"]\n' % (m["id"], m["name"], m["layer"]))
    for m in model["modules"]:
        for d in m["depends_on"]:
            out.append("  %s --> %s\n" % (m["id"], d))
    out.append("```\n\n")
    out.append("| Module | Layer | Schema | Responsibilities | Depends on | Publishes | FEATURES sections | Entities |\n|---|---|---|---|---|---|---|---|\n")
    for m in model["modules"]:
        owned = [e["name"] for e in ents if e["module"] == m["id"]]
        out.append("| **%s** (`%s`) | %d | `%s` | %s | %s | %s | %s | %d |\n" % (
            m["name"], m["id"], m["layer"], m["schema"], esc(m["responsibilities"]), ", ".join(m["depends_on"]) or "—",
            ", ".join("`%s`" % p for p in m["publishes"]), ", ".join(m["feature_sections"]) or "—", len(owned)))
    return "".join(out)


def render_logical(model):
    ents = OrderedDict((e["name"], e) for e in model["entities"])
    out = [HEADER, "# Logical model reference\n\n",
           "Conventions (standard columns, IDs, scope keys) are in [../02-logical-model.md](../02-logical-model.md). "
           "Every entity also has the standard columns for its scope, lifecycle and concurrency class.\n"]
    for m in model["modules"]:
        members = [e for e in ents.values() if e["module"] == m["id"]]
        out.append("\n## %s (`%s`, schema `%s`)\n\n%s\n" % (m["name"], m["id"], m["schema"], m["responsibilities"]))
        for e in members:
            out.append('\n<a id="%s"></a>\n### `%s`\n\n%s\n\n' % (anchor(e["name"]), e["name"], e["purpose"]))
            rows = [
                ("Scope", "`%s`%s" % (e["scope"], " · addressable (`core.record`, public prefix `%s_`)" % e["public_id_prefix"] if e["addressable"] else "")),
                ("Contained by", ", ".join(elink(p, ents) for p in e["containment_parents"]) or "—"),
                ("Extends (1:1)", elink(e["extends"], ents) if e.get("extends") else "—"),
                ("Associations", ", ".join(elink(a, ents) for a in e["associations"]) or "—"),
                ("Lifecycle / concurrency", "`%s` / `%s`" % (e["lifecycle"], e["concurrency"])),
                ("Retention / confidentiality", "`%s` / `%s`" % (e["retention_class"], e["confidentiality"])),
                ("Volume / export / search-AI", "`%s` / `%s` / `%s`" % (e["volume"], e["export"], e["search_ai"])),
                ("Secrets / personal data", "`%s` / `%s`" % (e["may_contain_secrets"], e["personal_data"])),
                ("Uniqueness", "; ".join("`%s`" % u for u in e["uniqueness"]) or "—"),
                ("Key typed columns", "; ".join("`%s`" % c for c in e["key_columns"]) or "standard columns only"),
                ("Sensitive fields", ", ".join("`%s`" % s for s in e["sensitive_fields"]) or "—"),
                ("Requirements", ", ".join(e["requirements"]) or "—"),
            ]
            if e["notes"]:
                rows.append(("Notes", e["notes"]))
            out.append("| Property | Value |\n|---|---|\n")
            for k, v in rows:
                out.append("| %s | %s |\n" % (k, esc(v)))
    return "".join(out)


def render_er(model):
    ents = OrderedDict((e["name"], e) for e in model["entities"])
    out = [HEADER, "# Entity-relationship diagrams\n\n",
           "One diagram per module. `||--o{` is containment (parent owns children), `||--||` is a 1:1 extension, "
           "`}o..o{`/`}o..||` is a non-owning association (dotted). Entities from other modules appear where referenced.\n"]
    for m in model["modules"]:
        members = [e for e in ents.values() if e["module"] == m["id"]]
        lines = []
        for e in members:
            for p in e["containment_parents"]:
                lines.append('  %s ||--o{ %s : "contains"' % (p, e["name"]))
            if e.get("extends"):
                lines.append('  %s ||--|| %s : "extends"' % (e["extends"], e["name"]))
            for a in e["associations"]:
                lines.append('  %s }o..o{ %s : "references"' % (e["name"], a))
            if e["addressable"] and e["name"] != "record":
                lines.append('  record ||--|| %s : "envelope"' % e["name"])
        if not lines:
            continue
        out.append("\n## %s\n\n```mermaid\nerDiagram\n%s\n```\n" % (m["name"], "\n".join(sorted(set(lines), key=lines.index))))
    return "".join(out)


def authz_sensitivity(e):
    if e["confidentiality"] in ("C3", "C4") or e["name"] in ("record_grant", "role_assignment", "agent_scope_grant", "agent_tool_grant", "workspace_policy"):
        return "high"
    if e["confidentiality"] == "C2":
        return "standard (per-record)"
    return "low"


def audit_req(e):
    if e["lifecycle"] in ("append-only", "versioned-immutable"):
        return "is evidence / append-only"
    if e["lifecycle"] == "ephemeral":
        return "none (technical)"
    if e["confidentiality"] in ("C3", "C4"):
        return "all changes + access"
    if e["confidentiality"] == "C2":
        return "material changes"
    return "configuration changes"


def render_matrix(model):
    ents = model["entities"]
    out = [HEADER, "# Data classification and ownership matrix\n\n",
           "Class definitions and rules: [../11-data-classification.md](../11-data-classification.md). "
           "*Authorization sensitivity* and *audit requirement* are derived from class and lifecycle by the generator.\n\n",
           "## Entity families (by module)\n\n| Module | Entities | Highest class | Retention classes | Exportable | Search/AI eligible | May hold secrets | Personal data | Max volume |\n|---|---|---|---|---|---|---|---|---|\n"]
    vol_order = ["low", "medium", "high", "very-high"]
    for m in model["modules"]:
        es = [e for e in ents if e["module"] == m["id"]]
        out.append("| %s | %d | %s | %s | %s | %s | %s | %s | %s |\n" % (
            m["name"], len(es), max(e["confidentiality"] for e in es),
            ", ".join(sorted({e["retention_class"] for e in es})),
            ", ".join(sorted({e["export"] for e in es})),
            ", ".join(sorted({e["search_ai"] for e in es})),
            ", ".join(sorted({e["may_contain_secrets"] for e in es} - {"no"})) or "no",
            ", ".join(sorted({e["personal_data"] for e in es})),
            max((e["volume"] for e in es), key=vol_order.index)))
    out.append("\n## All entities\n\n| Entity | Module | Scope | Class | Authorization sensitivity | Audit requirement | Retention | Export | Volume | Search/AI | Secrets | Personal data |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n")
    for e in ents:
        out.append("| [`%s`](logical-model.md#%s) | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n" % (
            e["name"], anchor(e["name"]), e["module"], e["scope"], e["confidentiality"], authz_sensitivity(e), audit_req(e),
            e["retention_class"], e["export"], e["volume"], e["search_ai"], e["may_contain_secrets"], e["personal_data"]))
    return "".join(out)


def render_all(model):
    return OrderedDict([("module-index.md", render_modules(model)), ("logical-model.md", render_logical(model)),
                        ("er-diagrams.md", render_er(model)), ("classification-matrix.md", render_matrix(model))])


def render(model):
    os.makedirs(GEN, exist_ok=True)
    for name, text in render_all(model).items():
        with open(os.path.join(GEN, name), "w", encoding="utf-8") as fh:
            fh.write(text)
        print("wrote docs/architecture/data/generated/%s" % name)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "validate"
    model = load(MODEL)
    if cmd == "validate":
        return 1 if validate(model) else 0
    if cmd == "render":
        render(model)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
