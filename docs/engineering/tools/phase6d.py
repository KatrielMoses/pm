#!/usr/bin/env python3
"""Phase 6D candidate validator; open requirements remain visible until acceptance."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load
MIGRATION = "packages/db/migrations/0050_csv_portability"


def check_migration():
    up, down = read(P(MIGRATION + ".up.sql")), read(P(MIGRATION + ".down.sql"))
    errors = []
    for table in ("transfer.import_job", "transfer.import_row", "transfer.import_mapping"):
        if "CREATE TABLE %s" % table not in up:
            errors.append("0050 is missing %s" % table)
        if "ALTER TABLE %s ENABLE ROW LEVEL SECURITY" % table not in up:
            errors.append("%s has no RLS" % table)
        if "ALTER TABLE %s FORCE ROW LEVEL SECURITY" % table not in up:
            errors.append("%s does not force RLS" % table)
    if "Restores the exact 0049 catalog" not in down:
        errors.append("0050 rollback must restore the exact 0049 catalog")
    if "DROP TABLE transfer.import_mapping" not in down:
        errors.append("0050 rollback does not drop saved mappings")
    return errors


def check_candidate():
    closure = load(P("docs/engineering/phase6/closure-6d.json"))
    catalog = load(P("docs/product/requirements/catalog.json"))
    requirements = {row["id"]: row for row in closure["requirements"]}
    owned = {row["id"] for row in catalog["requirements"] if row.get("owner_subphase") == "6D"}
    errors = []
    if closure.get("phase") != "6D" or closure.get("status") != "candidate":
        errors.append("6D closure must remain candidate until acceptance")
    if not owned.issubset(requirements):
        errors.append("6D candidate omits owned requirements: " + ", ".join(sorted(owned - set(requirements))))
    if any(requirements[item].get("disposition") != "in_progress" for item in owned):
        errors.append("open 6D requirements must not be marked implemented")
    adr = read(P("docs/engineering/adr/0036-data-portability.md"))
    for decision in ("P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"):
        if "| %s |" % decision not in adr:
            errors.append("ADR-0035 is missing decision %s" % decision)
    return errors, len(owned)


def check_surfaces():
    errors = []
    csv = read(P("packages/work/src/portability/csv.ts"))
    service = read(P("packages/work/src/portability/portability-service.ts"))
    routes = read(P("apps/api/src/work/portability-routes.ts"))
    schema = read(P("packages/db/src/schema.ts"))
    web = read(P("apps/web/src/pages/integration-pages.tsx"))
    checks = [
        ("CSV byte bound", "bytes: 5 * 1024 * 1024" in csv),
        ("CSV formula neutralization", "Spreadsheet formula injection" in csv),
        ("portable record schemas", all("'" + e + "':" in csv or e + ": [" in csv for e in ("task", "project", "workflow", "field", "goal", "document", "file"))),
        ("saved mapping endpoints", "imports/mappings" in routes),
        ("import rollback endpoint", "rollbackPortabilityImport" in routes),
        ("configured rollback window", "IMPORT_ROLLBACK_WINDOW_MS" in service),
        ("transfer schema types", all("transfer." + t in schema for t in ("import_job", "import_row", "import_mapping"))),
        ("accessible import preview", 'aria-label="Row errors"' in web and "portability-file" in web),
    ]
    errors.extend(label + " is missing" for label, passed in checks if not passed)
    errors.extend(phase1.check_migrations()[0])
    return errors


def main():
    results = [
        ("phase 6D migration and rollback", check_migration()),
        ("phase 6D candidate and ADR", check_candidate()[0]),
        ("phase 6D implementation surfaces", check_surfaces()),
    ]
    failed = 0
    for name, errors in results:
        print("%-72s %s" % (name, "PASS" if not errors else "FAIL (%d)" % len(errors)))
        for error in errors:
            print("    ERROR: " + error)
        failed += bool(errors)
    closure = load(P("docs/engineering/phase6/closure-6d.json"))
    open_count = sum(r["disposition"] == "in_progress" for r in closure["requirements"] if r["role"] == "owned")
    print("PHASE 6D CANDIDATE: %s (%d owned requirements remain open)" % ("PASS" if not failed else "FAIL", open_count))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
