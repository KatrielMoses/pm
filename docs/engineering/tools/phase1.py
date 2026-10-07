#!/usr/bin/env python3
"""Phase 1 closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase1.py      # exit 1 on any failure

Checks that the Phase 1 closure map (docs/engineering/phase1/closure.json) covers every catalog requirement
Phase 1 owns or contributes to, that each disposition cites existing evidence and an accepted source, and that
Phase 1 runtime surfaces have not drifted from their authoritative registries: error codes, outbox event
types, configuration keys, migrations, and Phase 1 ADR status.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
P = lambda *x: os.path.join(ROOT, *x)
PHASE1 = re.compile(r"^1[A-F]$")
DISPOSITIONS = {"implemented", "foundation", "contributed"}
PHASE1_ADRS = ["0008", "0009", "0010", "0011", "0012"]
# Architect decisions at the Phase 1 integration review (2026-10-04). Hosting-dependent requirements
# stay accepted foundations with exactly these deferrals; they are never "implemented" in Phase 1.
APPROVED_DEFERRALS = {"SEC-001": ["11B"], "SEC-002": ["11B"], "SEC-017": ["11C"], "REL-007": ["11C", "11F"]}
# OD-04 (decided): cross-brand sharing is owned by 2A; 1D contributes the exact-record-grant foundation.
DECIDED_OWNERS = {"WSB-008": ("2A", "1D")}
ADR_ACCEPTED = re.compile(r"^Status: \*\*accepted and implemented\*\*", re.M)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def load(path):
    return json.loads(read(path))


def roadmap_subphases():
    return set(re.findall(r"^### (\d{1,2}[A-F])\. ", read(P("BUILD_ROADMAP.md")), re.M))


def adr_path(num):
    adr_dir = P("docs/engineering/adr")
    for name in os.listdir(adr_dir):
        if name.startswith(num + "-"):
            return os.path.join(adr_dir, name)
    return None


def adr_ref_ok(ref):
    """`adr:<nnnn>` or `adr:<nnnn>#<row>`: the ADR is accepted and, for a row, the row exists."""
    m = re.fullmatch(r"adr:(\d{4})(?:#([A-Z]\d{1,2}))?", ref)
    if not m:
        return "malformed ADR reference"
    path = adr_path(m.group(1))
    if not path:
        return "no ADR %s" % m.group(1)
    text = read(path)
    if not re.search(r"^Status: (\*\*)?accepted", text, re.M):
        return "ADR %s is not accepted" % m.group(1)
    if m.group(2) and not re.search(r"^\| %s \|" % re.escape(m.group(2)), text, re.M):
        return "ADR %s has no row %s" % (m.group(1), m.group(2))
    return None


def adr_row(ref):
    m = re.fullmatch(r"adr:(\d{4})#([A-Z]\d{1,2})", ref)
    path = m and adr_path(m.group(1))
    if not path:
        return ""
    row = re.search(r"^\| %s \|.*$" % re.escape(m.group(2)), read(path), re.M)
    return row.group(0) if row else ""


def justifies(ref, subphase, req, reqs):
    """A deferral target is justified by the catalog, the roadmap section, an ADR row naming it, or
    the requirement that owns the deferred capability."""
    if ref == "catalog:contributing":
        return subphase in req.get("contributing_subphases", [])
    if ref.startswith("requirement:"):
        owner = reqs.get(ref[12:], {}).get("owner_subphase")
        return owner == subphase
    if ref.startswith("roadmap:"):
        return ref[8:] == subphase
    return bool(re.search(r"\b%s\b" % re.escape(subphase), adr_row(ref)))


def check_closure(catalog, closure, subphases):
    errs = []
    reqs = {r["id"]: r for r in catalog["requirements"]}
    owned = {i for i, r in reqs.items() if PHASE1.match(r.get("owner_subphase") or "")}
    contributing = {
        i for i, r in reqs.items()
        if i not in owned and any(PHASE1.match(s) for s in r.get("contributing_subphases", []))
    }
    entries = closure["requirements"]
    seen = {}
    for e in entries:
        if e["id"] in seen:
            errs.append("%s: listed twice" % e["id"])
        seen[e["id"]] = e
    for i in sorted(owned - set(seen)):
        errs.append("%s: Phase 1-owned requirement has no closure entry" % i)
    for i in sorted(contributing - set(seen)):
        errs.append("%s: Phase 1 contribution has no closure entry" % i)
    for i in sorted(set(seen) - owned - contributing):
        errs.append("%s: closure entry for a requirement Phase 1 neither owns nor contributes to" % i)

    file_cache = {}
    for e in entries:
        i, r = e["id"], reqs.get(e["id"])
        if r is None:
            continue
        disp = e.get("disposition")
        if disp not in DISPOSITIONS:
            errs.append("%s: unknown disposition %r" % (i, disp))
            continue
        role = "owned" if i in owned else "contributing"
        if e.get("role") != role:
            errs.append("%s: role %r, catalog says %s" % (i, e.get("role"), role))
        if role == "owned" and disp == "contributed":
            errs.append("%s: an owned requirement cannot be only 'contributed'" % i)
        if role == "contributing":
            if disp != "contributed":
                errs.append("%s: a contribution must be 'contributed'" % i)
            if e.get("contribution") not in r.get("contributing_subphases", []) or not PHASE1.match(e.get("contribution", "")):
                errs.append("%s: contribution %r is not a Phase 1 contributing subphase in the catalog" % (i, e.get("contribution")))
        if not e.get("evidence"):
            errs.append("%s: no evidence" % i)
        for ev in e.get("evidence", []):
            path = P(ev["file"])
            if not os.path.isfile(path):
                errs.append("%s: evidence file missing: %s" % (i, ev["file"]))
                continue
            text = file_cache.setdefault(path, read(path))
            if ev["contains"] not in text:
                errs.append("%s: %s does not contain %r" % (i, ev["file"], ev["contains"]))
        if disp == "foundation":
            deferred = e.get("deferred_to")
            pending = e.get("pending_decisions") or []
            accepted = e.get("accepted_by") or []
            if deferred is None or (not deferred and not pending):
                errs.append("%s: a foundation disposition needs deferred_to subphases or a pending decision" % i)
            for s in deferred or []:
                if s not in subphases:
                    errs.append("%s: deferred_to %s is not a BUILD_ROADMAP subphase" % (i, s))
                elif PHASE1.match(s):
                    errs.append("%s: deferred_to %s is inside Phase 1" % (i, s))
            if not accepted:
                errs.append("%s: a foundation disposition needs accepted_by" % i)
            for s in deferred or []:
                if not any(justifies(ref, s, r, reqs) for ref in accepted):
                    errs.append("%s: no accepted_by source names deferred_to %s" % (i, s))
            for ref in accepted:
                if ref == "catalog:contributing":
                    pass
                elif ref.startswith("requirement:"):
                    if ref[12:] not in reqs:
                        errs.append("%s: %s is not a catalog requirement" % (i, ref))
                elif ref.startswith("roadmap:"):
                    if ref[8:] not in subphases:
                        errs.append("%s: %s is not a roadmap subphase" % (i, ref))
                elif ref.startswith("adr:"):
                    bad = adr_ref_ok(ref)
                    if bad:
                        errs.append("%s: %s: %s" % (i, ref, bad))
                else:
                    errs.append("%s: unknown accepted_by kind %r" % (i, ref))
            for d in pending:
                if not re.fullmatch(r"OD-\d{2}", d):
                    errs.append("%s: malformed pending decision %r" % (i, d))
    for i, targets in APPROVED_DEFERRALS.items():
        e = seen.get(i)
        if not e or e.get("disposition") != "foundation" or sorted(e.get("deferred_to") or []) != targets:
            errs.append("%s: must stay a foundation deferred to %s (architect decision)" % (i, ",".join(targets)))
        elif not set(targets) <= set(reqs[i].get("contributing_subphases", [])):
            errs.append("%s: catalog contributing_subphases must include %s" % (i, ",".join(targets)))
    for i, (owner, contribution) in DECIDED_OWNERS.items():
        r = reqs.get(i, {})
        if r.get("owner_subphase") != owner or contribution not in r.get("contributing_subphases", []):
            errs.append("%s: catalog must record owner %s with %s contributing (OD-04)" % (i, owner, contribution))
        if seen.get(i, {}).get("contribution") != contribution:
            errs.append("%s: closure must record the %s contribution" % (i, contribution))
    counts = {}
    for e in entries:
        counts[e.get("disposition")] = counts.get(e.get("disposition"), 0) + 1
    detail = "%d owned, %d contributions; %s" % (
        len(owned), len(contributing), ", ".join("%s %d" % kv for kv in sorted(counts.items())))
    return errs, detail


def check_error_codes(registry):
    errs = []
    codes = {c["code"] for c in registry["error_codes"]}
    files = ["packages/tenancy/src/errors.ts", "packages/identity/src/types.ts"]
    found = 0
    for f in files:
        text = read(P(f))
        for m in re.finditer(r"export type (\w+ErrorCode) =([^;]+);", text):
            for code in re.findall(r"'([a-z_]+)'", m.group(2)):
                found += 1
                if code not in codes:
                    errs.append("%s %s: %r is not a 0D registry error code" % (f, m.group(1), code))
    if not found:
        errs.append("no domain error-code unions found (validator out of date)")
    return errs, "%d codes in domain unions" % found


def runtime_ts():
    for base in ("packages", "apps"):
        for dirpath, dirnames, filenames in os.walk(P(base)):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", "dist", "test", "generated")]
            if os.sep + "src" not in dirpath:
                continue
            for n in filenames:
                if n.endswith((".ts", ".tsx")):
                    yield os.path.join(dirpath, n)


def check_outbox_events(registry):
    errs = []
    events = {e["type"] for e in registry["events"]}
    literal = 0
    for path in runtime_ts():
        text = read(path)
        if "writeOutboxEvent(" not in text and "type: 'tenancy." not in text:
            continue
        rel = os.path.relpath(path, ROOT)
        for m in re.finditer(r"writeOutboxEvent\(\w+, \{\s*type: '([a-z_.]+)'", text):
            literal += 1
            if m.group(1) not in events:
                errs.append("%s: outbox event %r is not registered in 0D" % (rel, m.group(1)))
        # Event types passed through variables are typed against the registry by TypeScript; any quoted
        # module.entity.verb literal that looks like an event must still be registered.
        for m in re.finditer(r"'((?:tenancy|core|execution|identity|views)\.[a-z_]+\.[a-z_]+)'", text):
            name = m.group(1)
            if name in events:
                literal += 1
            elif re.search(r"(type|event)\s*[:=]\s*'%s'" % re.escape(name), text):
                errs.append("%s: event-like literal %r is not registered in 0D" % (rel, name))
    return errs, "%d registered event literals" % literal


def check_config_documented():
    errs = []
    src = read(P("packages/config/src/server.ts"))
    m = re.search(r"const schema = z\.object\(\{(.*?)\n\}\);", src, re.S)
    if not m:
        return ["configuration schema not found (validator out of date)"], ""
    keys = re.findall(r"^  ([A-Z][A-Z0-9_]+):", m.group(1), re.M)
    doc = read(P("docs/engineering/environments.md"))
    prefixes = re.findall(r"`([A-Z][A-Z0-9_]*_)\*`", doc)
    for k in keys:
        if not re.search(r"\b%s\b" % k, doc) and not any(k.startswith(p) for p in prefixes):
            errs.append("configuration key %s is not documented in docs/engineering/environments.md" % k)
    return errs, "%d keys" % len(keys)


def migration_boundaries():
    """The integer list after `boundaries = [` in the migrations integration test (formatter-proof)."""
    text = read(P("packages/db/test/integration/migrations.test.ts"))
    m = re.search(r"boundaries\s*=\s*\[([^\]]*)\]", text, re.S)
    return [int(x) for x in re.findall(r"\d+", m.group(1))] if m else []


def check_boundaries(required):
    """Errors for every required migration boundary missing from the migrations integration test."""
    have = set(migration_boundaries())
    missing = [n for n in required if n not in have]
    return ["packages/db/test/integration/migrations.test.ts: boundaries lack %s" % ", ".join(map(str, missing))] if missing else []


def check_migrations():
    errs = []
    d = P("packages/db/migrations")
    names = sorted(os.listdir(d))
    ups = sorted(n for n in names if n.endswith(".up.sql"))
    downs = {n for n in names if n.endswith(".down.sql")}
    for idx, up in enumerate(ups, 1):
        num = up.split("_", 1)[0]
        if num != "%04d" % idx:
            errs.append("migration numbering gap or duplicate at %s (expected %04d)" % (up, idx))
        if up.replace(".up.sql", ".down.sql") not in downs:
            errs.append("%s has no down migration" % up)
    for dn in downs:
        if dn.replace(".down.sql", ".up.sql") not in ups:
            errs.append("%s has no up migration" % dn)
    return errs, "%d migrations" % len(ups)


def check_adrs():
    errs = []
    for num in PHASE1_ADRS:
        path = adr_path(num)
        if not path:
            errs.append("ADR-%s missing" % num)
            continue
        text = read(path)
        if not ADR_ACCEPTED.search(text):
            errs.append("ADR-%s status is not 'accepted and implemented'" % num)
        status = text.split("\n## ", 1)[0]
        if re.search(r"\b(pending|awaiting)\b", status, re.I):
            errs.append("ADR-%s status block still says pending/awaiting" % num)
        if "Disposition requested" in text and not re.search(r"\bF1[–-]F\d+ accepted", status):
            errs.append("ADR-%s lists requested dispositions but its status does not record them as accepted" % num)
    return errs, "ADR-%s" % ", ".join(PHASE1_ADRS)


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    closure = load(P("docs/engineering/phase1/closure.json"))
    subphases = roadmap_subphases()
    sections = [
        ("phase 1: requirement closure (owned and contributions)", check_closure(catalog, closure, subphases)),
        ("phase 1: domain error codes within the 0D registry", check_error_codes(registry)),
        ("phase 1: outbox event types within the 0D registry", check_outbox_events(registry)),
        ("phase 1: configuration keys documented", check_config_documented()),
        ("phase 1: migrations contiguous and reversible", check_migrations()),
        ("phase 1: ADR status (no pending decisions)", check_adrs()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs), ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 1 CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
