#!/usr/bin/env python3
"""Phase 6E MCP-compatible access foundation closure validator."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402
import phase2  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load


def check_boundary():
    errs = []
    registry = read(P("packages/work/src/integrations/mcp/registry.ts"))
    service = read(P("packages/work/src/integrations/mcp-access-service.ts"))
    routes = read(P("apps/api/src/mcp/routes.ts"))
    auth = read(P("apps/api/src/auth/routes.ts"))
    ui = read(P("apps/web/src/integrations/panel.tsx"))
    for term, text, label in [
        ("MCP_REGISTRY_VERSION", registry, "versioned static registry"),
        ("validateToolArguments", service, "runtime argument validation"),
        ("mcpToolResultMaxBytes", service, "bounded responses"),
        ("mcpToolCallTimeoutMs", service, "request timeout"),
        ("oauth_consent.revoked", service, "consent revocation"),
        ("actor_membership_id", service, "actor provenance"),
        ("mcp-protocol-version", routes, "protocol negotiation"),
        ("Origin", auth, "Origin validation"),
        ("aria-labelledby=\"mcp-heading\"", ui, "accessible settings/help UI"),
        ("Revoke my consent", ui, "browser consent revocation"),
    ]:
        if term not in text:
            errs.append("missing %s" % label)
    for term in ("agents.execute", "ai:execute", "prompt", "provider_secret"):
        if term in registry:
            errs.append("registry must not expose %s" % term)
    return errs, "registry, transport, limits, provenance, and browser boundary"


def check_migrations():
    errs = []
    up = read(P("packages/db/migrations/0048_mcp_access_foundation.up.sql"))
    down = read(P("packages/db/migrations/0048_mcp_access_foundation.down.sql"))
    provenance = read(P("packages/db/migrations/0049_mcp_provenance.up.sql"))
    rollback = read(P("packages/db/migrations/0049_mcp_provenance.down.sql"))
    for table in (
        "integrations.oauth_client",
        "integrations.oauth_consent",
        "integrations.oauth_access_token",
        "integrations.mcp_invocation",
    ):
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("%s lacks tenant RLS" % table)
    if "Restores the exact 0047 catalog" not in down:
        errs.append("0048 down migration does not identify exact 0047 rollback")
    if "source_kind_known" not in provenance or "Restores the exact source-kind constraints" not in rollback:
        errs.append("0049 provenance rollback is incomplete")
    return errs, "migrations 0048/0049 and rollback boundaries"


def check_chain():
    errs = []
    service = read(P("packages/work/src/integrations/mcp-access-service.ts"))
    calendar = read(P("packages/work/src/integrations/calendar-service.ts"))
    factory = read(P("packages/work/src/factory.ts"))
    if "export class McpAccessService extends PortabilityService" not in service:
        errs.append("McpAccessService must extend the 6D PortabilityService boundary")
    portability = read(P("packages/work/src/portability/portability-service.ts"))
    if "export class PortabilityService extends CalendarService" not in portability:
        errs.append("PortabilityService must retain the 6C CalendarService foundation")
    if "return new McpAccessService(" not in factory:
        errs.append("factory must return the 6E service-chain head")
    if "export class CalendarService extends PublicApiService" not in calendar:
        errs.append("CalendarService must retain the public API foundation")
    return errs, "service chain"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    closure = load(P("docs/engineering/phase6/closure-6e.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        (
            "phase 6E: requirement closure",
            phase2.check_closure(catalog, closure, subphases, "6E", ["D%d" % i for i in range(1, 8)]),
        ),
        ("phase 6E: access boundary", check_boundary()),
        ("phase 6E: migrations", check_migrations()),
        ("phase 6E: service chain", check_chain()),
        ("phase 6E: migration sequence", phase1.check_migrations()),
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
        for error in errs:
            print("    ERROR: " + error)
        failed += bool(errs)
    print("PHASE 6E CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
