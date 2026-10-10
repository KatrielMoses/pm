#!/usr/bin/env python3
"""Phase 6B closure validator.

Usage (from the repository root):
    python3 docs/engineering/tools/phase6b.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402
import phase2  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load


def check_migration():
    errs = []
    up = read(P("packages/db/migrations/0046_public_api_webhooks.up.sql"))
    down = read(P("packages/db/migrations/0046_public_api_webhooks.down.sql"))
    for table in (
        "integrations.api_token",
        "integrations.webhook_subscription",
        "integrations.webhook_delivery",
        "integrations.inbound_endpoint",
        "integrations.inbound_message",
    ):
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("%s has no tenant_isolation policy" % table)
        if "ENABLE ROW LEVEL SECURITY" not in up or "FORCE ROW LEVEL SECURITY" not in up:
            errs.append("RLS is not forced")
    if "CREATE TABLE integrations.connection" in up:
        errs.append("0046 must not create provider connections (6A)")
    if "token_hash" not in up or "signing_secret_ref" not in up:
        errs.append("tokens must be hashed and webhook secrets referenced")
    if "DROP SCHEMA integrations" in down:
        errs.append("down migration must not drop the integrations schema (6A tables remain)")
    if "response_body" in up:
        errs.append("delivery rows must not store response bodies")
    return errs, "migration 0046"


def check_behavior():
    errs = []
    src = read(P("packages/work/src/integrations/public-api-service.ts"))
    for needle in ("tokenHash", "signaturesMatch", "assertPublicHttps", "receiveInbound", "createToken"):
        if needle not in src and needle not in read(P("packages/work/src/integrations/semantics.ts")):
            errs.append("missing %s" % needle)
    if "createHash('sha256')" not in read(P("packages/work/src/integrations/semantics.ts")):
        errs.append("API tokens must be SHA-256 hashed")
    return errs, "hash, signature, SSRF, capture"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P("docs/engineering/phase6/closure-6b.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        (
            "phase 6B: requirement and decision closure",
            phase2.check_closure(catalog, closure, subphases, "6B", ["D%d" % i for i in range(1, 13)]),
        ),
        ("phase 6B: migration 0046 and rollback", check_migration()),
        ("phase 6B: token and webhook behavior", check_behavior()),
        ("phase 6B: migrations contiguous", phase1.check_migrations()),
        ("phase 6B: configuration keys documented", phase1.check_config_documented()),
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
    print("PHASE 6B CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
