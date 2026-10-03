#!/usr/bin/env python3
"""Requirement catalog tool for FEATURES.md (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/product/tools/reqcat.py validate    # check catalog against sources; exit 1 on any error
    python3 docs/product/tools/reqcat.py render      # regenerate catalog.md and summary.md from catalog.json
    python3 docs/product/tools/reqcat.py relocate    # refresh source line/position after FEATURES.md is re-ordered
    python3 docs/product/tools/reqcat.py add-missing # append new FEATURES.md items with the next free IDs

catalog.json is the authoritative catalog. FEATURES.md remains the authoritative
requirement wording; the catalog only adds identity and mapping.
"""
import json
import os
import re
import sys
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
PRODUCT = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(PRODUCT))
FEATURES = os.path.join(ROOT, "FEATURES.md")
ROADMAP = os.path.join(ROOT, "BUILD_ROADMAP.md")
REQ_DIR = os.path.join(PRODUCT, "requirements")
CATALOG = os.path.join(REQ_DIR, "catalog.json")
CATALOG_MD = os.path.join(REQ_DIR, "catalog.md")
SUMMARY_MD = os.path.join(REQ_DIR, "summary.md")
DECISIONS = os.path.join(PRODUCT, "open-decisions.md")

LAUNCH_SECTION = "Launch acceptance requirements"
ID_RE = re.compile(r"^([A-Z0-9]+)-(\d{3})$")
FLAG_TYPES = ["conflict", "ambiguity", "duplication", "missing-decision", "roadmap-gap"]
CONCERNS = [
    "authorization", "audit", "notification", "accessibility", "reliability", "privacy",
    "usage-metering", "export", "degraded-mode", "brand-context", "actor-provenance",
    "time-semantics", "i18n", "launch-gate",
]
TBD = "TBD"


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def parse_features():
    """Return checklist items as dicts: section, position (1-based within section), line, text."""
    items, section, pos = [], None, 0
    for no, line in enumerate(read(FEATURES).split("\n"), 1):
        if line.startswith("## "):
            section, pos = line[3:].strip(), 0
            continue
        m = re.match(r"^\s*- \[[ xX]\] (.+?)\s*$", line)
        if m:
            pos += 1
            items.append({"section": section, "position": pos, "line": no, "text": m.group(1)})
    return items


def parse_subphases():
    return OrderedDict(re.findall(r"^### (\d+[A-Z])\. (.+)$", read(ROADMAP), re.M))


def parse_expected_counts():
    m = re.search(r"\((\d+) product requirements plus (\d+) launch acceptance requirements\)", read(ROADMAP))
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def parse_decisions():
    return OrderedDict(re.findall(r"^### (OD-\d+) — (.+)$", read(DECISIONS), re.M)) if os.path.exists(DECISIONS) else {}


def contract_docs():
    """Hand-written markdown under docs/product (generated files excluded)."""
    found = []
    for base, _dirs, files in os.walk(PRODUCT):
        for name in files:
            path = os.path.join(base, name)
            if name.endswith(".md") and path not in (CATALOG_MD, SUMMARY_MD):
                found.append(path)
    return sorted(found)


def load_catalog():
    return json.loads(read(CATALOG), object_pairs_hook=OrderedDict)


def save_catalog(cat):
    with open(CATALOG, "w", encoding="utf-8") as fh:
        json.dump(cat, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def key(section, text):
    return (section, text)


# ---------------------------------------------------------------- validate

def validate(cat, quiet=False):
    errors, warnings = [], []
    src = parse_features()
    subphases = parse_subphases()
    decisions = parse_decisions()
    exp_product, exp_launch = parse_expected_counts()
    prefixes = cat.get("section_prefixes", {})
    reqs = cat.get("requirements", [])
    retired = {r["id"] for r in cat.get("retired", [])}

    # IDs: format, uniqueness, prefix/section agreement, not retired
    id_counts = Counter(r.get("id") for r in reqs)
    for rid, n in id_counts.items():
        if n > 1:
            errors.append("duplicate ID %s (%d entries)" % (rid, n))
    for r in reqs:
        rid = r.get("id", "")
        m = ID_RE.match(rid)
        if not m:
            errors.append("malformed ID %r" % rid)
            continue
        section = r["source"]["section"]
        if prefixes.get(section) != m.group(1):
            errors.append("%s: prefix does not match section %r (expected %s)" % (rid, section, prefixes.get(section)))
        if rid in retired:
            errors.append("%s: ID is both active and retired" % rid)

    # Source coverage: every FEATURES.md item exactly once, no extras
    src_keys = Counter(key(i["section"], i["text"]) for i in src)
    for k, n in src_keys.items():
        if n > 1:
            errors.append("FEATURES.md contains %d identical items in %r: %r (IDs cannot be disambiguated)" % (n, k[0], k[1]))
    cat_by_key = {}
    for r in reqs:
        k = key(r["source"]["section"], r["text"])
        if k in cat_by_key:
            errors.append("%s and %s map to the same source item %r" % (cat_by_key[k]["id"], r["id"], r["text"]))
        cat_by_key[k] = r
    missing = [i for i in src if key(i["section"], i["text"]) not in cat_by_key]
    extra = [r for r in reqs if key(r["source"]["section"], r["text"]) not in src_keys]
    for i in missing:
        errors.append("missing from catalog: FEATURES.md:%d [%s] %s" % (i["line"], i["section"], i["text"]))
    for r in extra:
        errors.append("extra catalog entry (no matching source text): %s %r" % (r["id"], r["text"]))

    # Source location drift
    drift = 0
    for i in src:
        r = cat_by_key.get(key(i["section"], i["text"]))
        if r and (r["source"].get("line") != i["line"] or r["source"].get("position") != i["position"]):
            drift += 1
    if drift:
        errors.append("%d entries have stale source line/position; run `reqcat.py relocate`" % drift)

    # Type, mapping, concerns, flags
    for r in reqs:
        rid = r["id"]
        want = "launch-acceptance" if r["source"]["section"] == LAUNCH_SECTION else "product"
        if r.get("type") != want:
            errors.append("%s: type %r should be %r" % (rid, r.get("type"), want))
        owner = r.get("owner_subphase")
        if owner == TBD:
            errors.append("%s: owner_subphase not yet assigned (unmapped)" % rid)
        elif owner not in subphases:
            errors.append("%s: unknown owner sub-phase %r" % (rid, owner))
        for c in r.get("contributing_subphases", []):
            if c not in subphases:
                errors.append("%s: unknown contributing sub-phase %r" % (rid, c))
            if c == owner:
                errors.append("%s: owner %s repeated as contributor" % (rid, c))
        for c in r.get("concerns", []):
            if c not in CONCERNS:
                errors.append("%s: unknown concern %r" % (rid, c))
        for f in r.get("flags", []):
            if f.get("type") not in FLAG_TYPES:
                errors.append("%s: unknown flag type %r" % (rid, f.get("type")))
            if f.get("decision") and f["decision"] not in decisions:
                errors.append("%s: flag references %s, which is not in open-decisions.md" % (rid, f["decision"]))

    # Counts
    n_product = sum(1 for r in reqs if r.get("type") == "product")
    n_launch = sum(1 for r in reqs if r.get("type") == "launch-acceptance")
    s_launch = sum(1 for i in src if i["section"] == LAUNCH_SECTION)
    s_product = len(src) - s_launch
    if (n_product, n_launch) != (s_product, s_launch):
        errors.append("catalog counts %d/%d do not match FEATURES.md %d/%d" % (n_product, n_launch, s_product, s_launch))
    if exp_product is None:
        warnings.append("BUILD_ROADMAP.md does not state expected counts; skipped roadmap count check")
    elif (s_product, s_launch) != (exp_product, exp_launch):
        errors.append("FEATURES.md has %d product + %d launch items; BUILD_ROADMAP.md states %d + %d"
                      % (s_product, s_launch, exp_product, exp_launch))

    # Requirement and decision references inside the contract documents
    ids = {r["id"] for r in reqs}
    ref_re = re.compile(r"\b(%s)-(\d{3})\b" % "|".join(sorted(prefixes.values(), key=len, reverse=True)))
    for path in contract_docs():
        rel = os.path.relpath(path, ROOT)
        text = read(path)
        for m in ref_re.finditer(text):
            if m.group(0) not in ids:
                errors.append("%s references unknown requirement %s" % (rel, m.group(0)))
        for od in set(re.findall(r"\bOD-\d+\b", text)):
            if od not in decisions:
                errors.append("%s references unknown decision %s" % (rel, od))

    # Generated documents up to date
    for path, text in ((CATALOG_MD, render_catalog(cat)), (SUMMARY_MD, render_summary(cat))):
        if not os.path.exists(path) or read(path) != text:
            errors.append("%s is out of date; run `reqcat.py render`" % os.path.relpath(path, ROOT))

    if not quiet:
        print("Source FEATURES.md : %d items (%d product, %d launch acceptance)" % (len(src), s_product, s_launch))
        print("Roadmap expects    : %s product, %s launch acceptance" % (exp_product, exp_launch))
        print("Catalog            : %d entries (%d product, %d launch acceptance), %d retired IDs"
              % (len(reqs), n_product, n_launch, len(retired)))
        print("Unique IDs         : %d" % len(id_counts))
        print("Missing / extra    : %d / %d" % (len(missing), len(extra)))
        print("Unmapped (TBD)     : %d" % sum(1 for r in reqs if r.get("owner_subphase") == TBD))
        print("Sub-phases known   : %d (from BUILD_ROADMAP.md)" % len(subphases))
        print("Flagged entries    : %d; open decisions referenced: %d of %d"
              % (sum(1 for r in reqs if r.get("flags")),
                 len({f["decision"] for r in reqs for f in r.get("flags", []) if f.get("decision")}), len(decisions)))
        for w in warnings:
            print("WARNING: " + w)
        for e in errors:
            print("ERROR: " + e)
        print("RESULT: %s" % ("PASS" if not errors else "FAIL (%d errors)" % len(errors)))
    return errors


# ---------------------------------------------------------------- render

def od_link(od, rel):
    return "[%s](%sopen-decisions.md#%s)" % (od, rel, od.lower())


def flag_cell(r):
    parts = []
    for f in r.get("flags", []):
        parts.append(f["type"] + (" " + od_link(f["decision"], "../") if f.get("decision") else ""))
    return "; ".join(parts)


def esc(s):
    return s.replace("|", "\\|")


HEADER = ("<!-- GENERATED by docs/product/tools/reqcat.py render from catalog.json. Do not edit by hand. -->\n\n")


def render_catalog(cat):
    out = [HEADER, "# Requirement catalog\n\n",
           "Source wording is copied verbatim from `FEATURES.md`. Owner = owning roadmap sub-phase; "
           "contributors are other sub-phases that must deliver part of the requirement. "
           "Flags and decisions are explained in [summary.md](summary.md) and "
           "[../open-decisions.md](../open-decisions.md).\n"]
    section = None
    for r in cat["requirements"]:
        if r["source"]["section"] != section:
            section = r["source"]["section"]
            out.append("\n## %s\n\n" % section)
            out.append("| ID | Requirement (verbatim) | Line | Owner | Contributors | Concerns | Flags |\n")
            out.append("|---|---|---|---|---|---|---|\n")
        out.append("| %s | %s | %d | %s | %s | %s | %s |\n" % (
            r["id"], esc(r["text"]), r["source"]["line"], r["owner_subphase"],
            ", ".join(r["contributing_subphases"]), ", ".join(r["concerns"]), flag_cell(r)))
    return "".join(out)


def render_summary(cat):
    reqs = cat["requirements"]
    subphases = parse_subphases()
    decisions = parse_decisions()
    out = [HEADER, "# Requirement catalog summary\n\n"]
    n_p = sum(1 for r in reqs if r["type"] == "product")
    n_l = sum(1 for r in reqs if r["type"] == "launch-acceptance")
    unmapped = [r["id"] for r in reqs if r["owner_subphase"] == TBD]
    out.append("| Measure | Count |\n|---|---|\n")
    out.append("| Total source requirements | %d |\n| Product requirements | %d |\n| Launch acceptance requirements | %d |\n"
               % (len(reqs), n_p, n_l))
    out.append("| Unmapped (no owning sub-phase) | %d |\n| Entries with at least one flag | %d |\n| Retired IDs | %d |\n\n"
               % (len(unmapped), sum(1 for r in reqs if r["flags"]), len(cat.get("retired", []))))

    out.append("## By source section\n\n| Prefix | Section | Count | Owning sub-phases |\n|---|---|---|---|\n")
    for section, pfx in cat["section_prefixes"].items():
        rs = [r for r in reqs if r["source"]["section"] == section]
        owners = Counter(r["owner_subphase"] for r in rs)
        out.append("| %s | %s | %d | %s |\n" % (pfx, section, len(rs),
                   ", ".join("%s (%d)" % (k, v) for k, v in sorted(owners.items(), key=lambda kv: (-kv[1], kv[0])))))

    out.append("\n## By roadmap sub-phase\n\n"
               "Owned = requirements whose owning sub-phase this is. Contributing = requirements where it delivers a part.\n\n"
               "| Sub-phase | Title | Owned | Contributing |\n|---|---|---|---|\n")
    for code, title in subphases.items():
        owned = sum(1 for r in reqs if r["owner_subphase"] == code)
        contrib = sum(1 for r in reqs if code in r["contributing_subphases"])
        out.append("| %s | %s | %d | %d |\n" % (code, title, owned, contrib))

    out.append("\n## Cross-cutting concerns\n\nConcern tags were seeded by keyword and section rules, then reviewed; "
               "they mark requirements whose implementation must satisfy the corresponding cross-cutting contract.\n\n"
               "| Concern | Requirements tagged |\n|---|---|\n")
    cc = Counter(c for r in reqs for c in r["concerns"])
    for c in CONCERNS:
        out.append("| %s | %d |\n" % (c, cc.get(c, 0)))

    out.append("\n## Flags\n\n| Flag type | Entries |\n|---|---|\n")
    fc = Counter(f["type"] for r in reqs for f in r["flags"])
    for t in FLAG_TYPES:
        out.append("| %s | %d |\n" % (t, fc.get(t, 0)))
    for t in FLAG_TYPES:
        rows = [(r, f) for r in reqs for f in r["flags"] if f["type"] == t]
        if not rows:
            continue
        out.append("\n### %s\n\n| ID | Requirement | Note | Decision |\n|---|---|---|---|\n" % t)
        for r, f in rows:
            out.append("| %s | %s | %s | %s |\n" % (r["id"], esc(r["text"]), esc(f["note"]),
                                                     od_link(f["decision"], "../") if f.get("decision") else ""))

    out.append("\n## Open decisions referenced by requirements\n\n| Decision | Title | Requirements |\n|---|---|---|\n")
    for od, title in decisions.items():
        ids = [r["id"] for r in reqs if any(f.get("decision") == od for f in r["flags"])]
        out.append("| %s | %s | %s |\n" % (od_link(od, "../"), esc(title), ", ".join(ids) if ids else "— (not requirement-specific)"))

    out.append("\n## Unmapped requirements\n\n%s\n" % (", ".join(unmapped) if unmapped else "None."))
    return "".join(out)


def render(cat):
    for path, text in ((CATALOG_MD, render_catalog(cat)), (SUMMARY_MD, render_summary(cat))):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("wrote " + os.path.relpath(path, ROOT))


# ---------------------------------------------------------------- maintenance

def relocate(cat):
    src = {key(i["section"], i["text"]): i for i in parse_features()}
    moved = 0
    for r in cat["requirements"]:
        i = src.get(key(r["source"]["section"], r["text"]))
        if i and (r["source"]["line"], r["source"]["position"]) != (i["line"], i["position"]):
            r["source"]["line"], r["source"]["position"] = i["line"], i["position"]
            moved += 1
    save_catalog(cat)
    print("updated source locations for %d entries" % moved)


def add_missing(cat):
    have = {key(r["source"]["section"], r["text"]) for r in cat["requirements"]}
    used = {r["id"] for r in cat["requirements"]} | {r["id"] for r in cat.get("retired", [])}
    added = 0
    for i in parse_features():
        if key(i["section"], i["text"]) in have:
            continue
        pfx = cat["section_prefixes"].get(i["section"])
        if not pfx:
            print("ERROR: new section %r has no prefix; add it to section_prefixes first" % i["section"])
            return 1
        n = 1 + max([int(ID_RE.match(u).group(2)) for u in used if u.startswith(pfx + "-")] or [0])
        rid = "%s-%03d" % (pfx, n)
        used.add(rid)
        cat["requirements"].append(OrderedDict([
            ("id", rid), ("type", "launch-acceptance" if i["section"] == LAUNCH_SECTION else "product"),
            ("text", i["text"]),
            ("source", OrderedDict([("file", "FEATURES.md"), ("section", i["section"]),
                                    ("position", i["position"]), ("line", i["line"])])),
            ("owner_subphase", TBD), ("contributing_subphases", []), ("concerns", []), ("flags", []),
        ]))
        added += 1
        print("added %s (owner TBD): %s" % (rid, i["text"]))
    order = {key(i["section"], i["text"]): n for n, i in enumerate(parse_features())}
    cat["requirements"].sort(key=lambda r: order.get(key(r["source"]["section"], r["text"]), 10 ** 9))
    print("added %d entries; assign owner_subphase before validation can pass" % added)
    relocate(cat)
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "validate"
    cat = load_catalog()
    if cmd == "validate":
        return 1 if validate(cat) else 0
    if cmd == "render":
        render(cat)
        return 0
    if cmd == "relocate":
        relocate(cat)
        return 0
    if cmd == "add-missing":
        return add_missing(cat)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
