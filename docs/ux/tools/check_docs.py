#!/usr/bin/env python3
"""Consistency checks for the docs/ux documentation set.

Checks:
  1. Every relative Markdown link resolves to an existing file, and every #anchor
     resolves to an explicit <a id> or a GitHub-style heading slug in the target.
  2. Every rule ID cited anywhere (P-, IA-, RS-, DS-, ST-, A11Y-, I18N-, UXD-, UXR-,
     DEP-0A-, J-) is defined somewhere in the set.
  3. Every navigation destination required by FEATURES.md and the 0E brief has a row
     in the destination coverage matrix (02 §9).
  4. All twelve required journeys exist.
  5. No placeholder markers (TODO, TBD, FIXME, lorem ipsum) remain.

Usage:  python3 docs/ux/tools/check_docs.py      Exit status 0 = all checks pass.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = sorted(ROOT.glob("*.md"))

REQUIRED_DESTINATIONS = [
    "All-brands home", "Brand-specific home", "Today", "Inbox", "My Work", "Assigned by Me",
    "Following", "Projects", "Calendar", "Knowledge", "Goals", "Reports", "Settings",
    "Recently Viewed", "Favorites / pins", "Search", "Command palette", "Notifications",
    "Breadcrumbs", "Browser history", "Create / capture",
    "Project › Overview", "Project › Tasks", "Project › Timeline", "Project › Calendar",
    "Project › Documents", "Project › Files", "Project › Activity", "Project › Time",
    "Project › Costs", "Project › Reports", "Project › Settings",
    "Admin › People and roles", "Admin › Workflow", "Admin › Templates", "Admin › Integrations",
    "Admin › Automations", "Admin › Agents", "Admin › AI", "Admin › Security", "Admin › Billing",
    "Admin › Storage and usage", "Admin › API and webhooks", "Admin › Audit",
    "Admin › Data and retention",
]
REQUIRED_JOURNEYS = 12

LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
ANCHOR = re.compile(r'<a id="([^"]+)"></a>')
HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
ID_REF = re.compile(r"\b((?:A11Y-[A-Z]{2}-\d+)|(?:DEP-0A-\d+)|(?:I18N-\d+)|(?:(?:UXD|UXR|IA|RS|DS|ST|P|J)-\d+[a-z]?))\b")
BOLD_DEF = re.compile(r"\*\*((?:IA|ST|RS|DS)-\d+[a-z]?) —")
PLACEHOLDER = re.compile(r"\b(TODO|TBD|FIXME|lorem ipsum)\b", re.IGNORECASE)


def slugify(text):
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[*_`]", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors_for(path, cache={}):
    if path not in cache:
        found, seen = set(), {}
        for line in path.read_text(encoding="utf-8").splitlines():
            found.update(ANCHOR.findall(line))
            if m := HEADING.match(line):
                slug = slugify(m.group(2))
                n = seen.get(slug, 0)
                found.add(slug if n == 0 else f"{slug}-{n}")
                seen[slug] = n + 1
        cache[path] = found
    return cache[path]


def main():
    errors = []
    texts = {p: p.read_text(encoding="utf-8") for p in DOCS}
    all_text = "\n".join(texts.values())

    # 1. links and anchors
    links = 0
    for path, text in texts.items():
        for target in LINK.findall(text):
            if re.match(r"^[a-z]+:", target):
                continue
            links += 1
            file_part, _, frag = target.partition("#")
            dest = (path.parent / file_part).resolve() if file_part else path
            if not dest.exists():
                errors.append(f"{path.name}: broken link -> {target}")
                continue
            if frag and dest.suffix == ".md" and frag not in anchors_for(dest):
                errors.append(f"{path.name}: missing anchor -> {target}")

    # 2. every cited ID is defined
    defined = set()
    for path in DOCS:
        defined.update(a.upper() for a in anchors_for(path))
    defined.update(BOLD_DEF.findall(all_text))
    defined.update(m.group(1).upper() for m in re.finditer(r"^## (J-\d+) ", all_text, re.M))
    cited = set(ID_REF.findall(all_text))
    undefined = sorted(i for i in cited if i.upper() not in defined)
    errors += [f"ID cited but never defined: {i}" for i in undefined]

    # 3. destination coverage matrix
    ia = texts[ROOT / "02-information-architecture.md"]
    matrix = ia.split("## 9. Destination coverage matrix", 1)[-1].split("\n## ", 1)[0]
    rows = {line.split("|")[1].strip() for line in matrix.splitlines() if line.startswith("| ")}
    missing = [d for d in REQUIRED_DESTINATIONS if d not in rows]
    errors += [f"Destination missing from coverage matrix: {d}" for d in missing]

    # 4. journeys
    journeys = re.findall(r"^## J-(\d+) ", texts[ROOT / "03-journeys.md"], re.M)
    if len(journeys) < REQUIRED_JOURNEYS:
        errors.append(f"Only {len(journeys)} journeys found; {REQUIRED_JOURNEYS} required")

    # 5. placeholders
    for path, text in texts.items():
        for n, line in enumerate(text.splitlines(), 1):
            if PLACEHOLDER.search(line):
                errors.append(f"{path.name}:{n}: placeholder marker")

    print(f"{len(DOCS)} documents · {links} internal links · {len(cited)} distinct IDs cited, "
          f"{len(defined)} anchors/definitions · {len(rows) - 2} matrix rows "
          f"({len(REQUIRED_DESTINATIONS)} required) · {len(journeys)} journeys")
    for e in errors:
        print("FAIL", e)
    print("All documentation checks passed." if not errors else f"{len(errors)} problem(s).")
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
