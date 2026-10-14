#!/usr/bin/env python3
"""Phase 6C closure validator."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402
import phase2  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

MIGRATION = "packages/db/migrations/0047_google_calendar"
ADR = "docs/engineering/adr/0034-google-calendar.md"


def check_migration():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for table in ("integrations.calendar_event", "integrations.connection_mapping"):
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("%s has no tenant_isolation policy" % table)
    if "Restores the exact 0046 catalog" not in down:
        errs.append("0047 down must restore 0046")
    return errs, "migration 0047"


def check_chain():
    errs = []
    factory = read(P("packages/work/src/factory.ts"))
    if not any(
        "return new %s(" % service in factory
        for service in ("CalendarService", "McpAccessService")
    ):
        errs.append("factory must return CalendarService or a later service-chain extension")
    if "export class CalendarService extends PublicApiService" not in read(
        P("packages/work/src/integrations/calendar-service.ts")
    ):
        errs.append("CalendarService must extend PublicApiService")
    return errs, "service chain"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P("docs/engineering/phase6/closure-6c.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        (
            "phase 6C: requirement closure",
            phase2.check_closure(catalog, closure, subphases, "6C", ["D%d" % i for i in range(1, 7)]),
        ),
        ("phase 6C: migration 0047", check_migration()),
        ("phase 6C: service chain", check_chain()),
        ("phase 6C: migrations contiguous", phase1.check_migrations()),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print(
            "%-72s %s%s"
            % (
                name,
                "PASS" if not errs else "FAIL (%d)" % len(errs),
                ("   [" + detail + "]") if detail and not errs else "",
            )
        )
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 6C CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
