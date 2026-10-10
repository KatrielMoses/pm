#!/usr/bin/env python3
"""Phase 6A closure validator (standard library only).

Usage (from the repository root):
    python3 docs/engineering/tools/phase6a.py
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

BOUNDS = {
    "CONNECTIONS_PER_SCOPE_MAX": ("connectionsPerScopeMax", 50),
    "CONNECTION_SCOPES_MAX": ("connectionScopesMax", 16),
    "SYNC_BATCH_MAX": ("syncBatchMax", 100),
    "SYNC_MAX_ATTEMPTS": ("syncMaxAttempts", 5),
    "SYNC_BACKOFF_SECONDS": ("syncBackoffSeconds", 30),
    "SYNC_LEASE_SECONDS": ("syncLeaseSeconds", 120),
    "SYNC_HISTORY_RETENTION_DAYS": ("syncHistoryRetentionDays", 90),
    "SYNC_RATE_PER_MINUTE": ("syncRatePerMinute", 30),
}
EVENTS = [
    "integrations.connection.created",
    "integrations.connection.reauthorized",
    "integrations.connection.disconnected",
    "integrations.sync.completed",
    "integrations.conflict.detected",
    "integrations.conflict.resolved",
    "integrations.credential.rotated",
]
TABLES = [
    "integrations.connection",
    "integrations.sync_checkpoint",
    "integrations.external_identity",
    "integrations.sync_run",
    "integrations.sync_delivery",
    "integrations.sync_conflict",
]
TESTS = ["AT-%d" % i for i in range(298, 310)]
ADR = "docs/engineering/adr/0032-integration-framework.md"
MIGRATION = "packages/db/migrations/0045_integration_framework"


def check():
    errs = []
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase6/closure-6a.json"))
    if closure.get("phase") != "6A":
        errs.append("closure phase")
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params or params[name].get("owner") != "6A":
            errs.append("%s: 0D owner must be 6A" % name)
        if "%s: '%d'" % (name, default) not in server:
            errs.append("%s: server default is not %d" % (name, default))
        if "%s: c.%s" % (camel, name) not in server:
            errs.append("%s: not mapped" % name)
        if "`%s`" % name not in envdoc:
            errs.append("%s: not documented" % name)
        if camel not in settings:
            errs.append("%s: missing from WorkSettings" % camel)
        if "default %d" % default not in params.get(name, {}).get("meaning", ""):
            errs.append("%s: meaning lacks default %d" % (name, default))
    events = {e["type"]: e for e in registry["events"]}
    for t in EVENTS:
        if t not in events:
            errs.append("event %s missing" % t)
        elif events[t].get("max_class") != "C1":
            errs.append("event %s must be C1" % t)
    if len(policy["actions"]) != 122:
        errs.append("6A adds no actions: found %d" % len(policy["actions"]))
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("%s has no tenant_isolation" % table)
        if "ENABLE ROW LEVEL SECURITY" not in up or "FORCE ROW LEVEL SECURITY" not in up:
            errs.append("RLS not forced")
    for needle in ["credential_secret_ref", "sync_checkpoint", "discover_integration_work",
                   "connection_secret_ref", "sync_delivery_dedupe", "sync_conflict_open"]:
        if needle not in up:
            errs.append("0045 lacks %s" % needle)
    if re.search(r"^\s+(api_key|access_token|refresh_token)\s", up, re.M):
        errs.append("0045 names a secret column")
    if "Restores the exact 0044 catalog" not in down:
        errs.append("0044 rollback note missing")
    svc = read(P("packages/work/src/integrations/service.ts"))
    for needle in ["credential_secret_ref", "allowAtPlacement", "syncBackoffMs", "provider_unconfigured",
                   "owner_departed", "integration"]:
        if needle not in svc and needle != "integration":
            errs.append("service lacks %s" % needle)
    if "logger" in svc and re.search(r"logger\.\w+\([^)]*token", svc):
        errs.append("service logs a token")
    adr = read(P(ADR))
    rows = re.findall(r"^\| (AT-\d+) \| ([^|]+?) \| ([^|]+?) \|$", adr, re.M)
    named = {at: (path.strip(), title.strip()) for at, path, title in rows}
    for at in TESTS:
        if at not in named:
            errs.append("%s missing from ADR" % at)
            continue
        path, title = named[at]
        if title not in read(P(path)):
            errs.append("%s: %s has no test %r" % (at, path, title))
    for anchor in ["adr-40", "az-40", "pl-42"]:
        found = False
        for rel in ["docs/architecture/data/12-decisions.md", "docs/architecture/access/15-decisions.md",
                    "docs/architecture/platform/19-decisions.md"]:
            if '<a id="%s"></a>' % anchor in read(P(rel)):
                found = True
        if not found:
            errs.append("missing %s" % anchor)
    if "OD-29" not in read(P("docs/product/open-decisions.md")):
        errs.append("OD-29 missing")
    if "Still open" not in read(P("docs/product/open-decisions.md")).split("### OD-29")[1][:800]:
        errs.append("OD-29 must stay open")
    threats = load(P("docs/architecture/access/policy/threats.json"))
    have = {t["id"] for t in threats["threats"]}
    for i in range(73, 81):
        if "T-%d" % i not in have:
            errs.append("threat T-%d missing" % i)
    return errs


def main():
    errs = check()
    if errs:
        print("phase 6A: %d problems" % len(errs))
        for e in errs:
            print("  - %s" % e)
        return 1
    print("phase 6A: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
