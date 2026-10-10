#!/usr/bin/env python3
"""Phase 5A closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase5a.py      # exit 1 on any failure

Phase 5A (docs/engineering/phase5/closure-5a.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, decisions D1..D16 tied to
ADR-0028 rows S1..S16) plus drift checks: the search bounds are registered (owner 5A), configured, and
documented; the signals and the search envelopes are registered, and no action, prefix, or event is
added; migration 0041 keeps its tenant isolation, the registered-kind shape, no unusable full-text
index, and its exact rollback to 0040; every search runs the compiled visibility predicate inside the
query against the governing record before anything is matched, counted, or excerpted; the index holds
no permission copy; indexing is key-driven, bounded, retryable, and savepointed; paging is keyset
with signed cursors (no offsets); excerpts are data rendered as text; recent searches are personal;
the worker discovery is payload-free; no semantic, vector, analytics, or connector structures are
introduced; and the ADR stays proposed until acceptance.
"""
import re
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402
import phase2  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

BOUNDS = {
    "SEARCH_QUERY_MAX_CHARS": ("searchQueryMaxChars", 200),
    "SEARCH_TERMS_MAX": ("searchTermsMax", 12),
    "SEARCH_PAGE_SIZE_MAX": ("searchPageSizeMax", 50),
    "SEARCH_RESULTS_MAX": ("searchResultsMax", 200),
    "SEARCH_COUNT_MAX": ("searchCountMax", 1000),
    "SEARCH_SNIPPET_CHARS": ("searchSnippetChars", 220),
    "SEARCH_BODY_MAX_CHARS": ("searchBodyMaxChars", 100000),
    "SEARCH_INDEX_BATCH_MAX": ("searchIndexBatchMax", 200),
    "SEARCH_INDEX_DISCOVERY_MAX": ("searchIndexDiscoveryMax", 50),
    "SEARCH_INDEX_MAX_ATTEMPTS": ("searchIndexMaxAttempts", 5),
    "SEARCH_INDEX_BACKOFF_SECONDS": ("searchIndexBackoffSeconds", 30),
    "SEARCH_FAILED_RETRY_MINUTES": ("searchFailedRetryMinutes", 360),
    "SEARCH_RECENT_MAX": ("searchRecentMax", 25),
    "SEARCH_RECENT_RETENTION_DAYS": ("searchRecentRetentionDays", 90),
    "SEARCH_RATE_PER_MINUTE": ("searchRatePerMinute", 120),
}
SIGNALS = ["search.requests", "search.index.jobs", "search.query.duration"]
ENVELOPES = ["search_results", "search_status", "search_open", "search_recent"]
TABLES = ["search.search_document", "search.index_status", "search.recent_search"]
SOURCE_TABLES = ["work.task", "work.project", "work.milestone", "work.decision_record", "knowledge.document",
                 "collab.comment", "files.file", "files.deliverable", "files.deliverable_version"]
SERVICE = "packages/work/src/search/search-service.ts"
SOURCES = "packages/work/src/search/sources.ts"
SEMANTICS = "packages/work/src/search/semantics.ts"
JOB = "packages/work/src/search/index-job.ts"
ROUTES = "apps/api/src/work/search-routes.ts"
PAGE = "apps/web/src/pages/search-pages.tsx"
PALETTE = "apps/web/src/shell/palette.tsx"
MIGRATION = "packages/db/migrations/0041_permission_aware_search"
ADR_ID = "0028"


def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "5A":
            errs.append("%s: 0D owner must be 5A" % name)
        if "%s: '%d'" % (name, default) not in server:
            errs.append("%s: server default is not %d" % (name, default))
        if "%s: c.%s" % (camel, name) not in server:
            errs.append("%s: not mapped to settings.%s" % (name, camel))
        if "`%s`" % name not in envdoc:
            errs.append("%s: not documented in environments.md" % name)
        if camel not in settings:
            errs.append("%s: missing from WorkSettings" % camel)
    signals = {t["name"] for t in registry["telemetry"]}
    for s in SIGNALS:
        if s not in signals:
            errs.append("signal %s not registered" % s)
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for e in ENVELOPES:
        if "'%s'" % e not in envelopes:
            errs.append("envelope %s not registered" % e)
    if len(policy["actions"]) != 122:
        errs.append("5A adds no actions: expected 122, found %d" % len(policy["actions"]))
    if "'search.member'" not in read(P("packages/work/src/factory.ts")):
        errs.append("the search.member rate policy must be registered")
    events = {e["type"] for e in registry["events"]}
    if any(e.startswith("search.") for e in events):
        errs.append("search emits no events: indexing is driven by database keys")
    prefixes = {p["prefix"] for p in registry["id_prefixes"]}
    if any(p in prefixes for p in ("srch", "sdoc", "rsrch")):
        errs.append("search adds no identifier prefix")
    od = read(P("docs/product/open-decisions.md"))
    seg = od[od.find("### OD-31"):od.find('<a id="od-32">')]
    if "**Status (Phase 5A" not in seg:
        errs.append("OD-31 must carry its Phase 5A status")
    if "decided by 5A" not in read(P("docs/architecture/data/13-open-questions.md")):
        errs.append("DQ-24 must record that 5A decided the language configurations")
    return errs, "%d bounds, %d signals, %d envelopes, no new actions, prefixes, or events" % (
        len(BOUNDS), len(SIGNALS), len(ENVELOPES))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["search_document_kind_shape", "index_status_failure_shape", "recent_search_key",
                   "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY", "search_document_auth_fkey",
                   "tsv tsvector GENERATED ALWAYS AS", "to_tsvector('simple'::regconfig",
                   "to_tsvector('english'::regconfig", "FOR EACH ROW EXECUTE FUNCTION search.source_changed()",
                   "search.record_purged()", "exec_dispatch.discover_search_work"]:
        if needle not in up:
            errs.append("0041 lacks %s" % needle)
    # The backfill of records that predate the migration must really read them: the source tables force
    # row-level security even on the migration role, so each is un-forced for that one read and forced
    # again in the same migration; the deferred queue keys are checked before the tables are altered.
    for table in SOURCE_TABLES[:-2] + ["files.deliverable"]:
        if up.count("ALTER TABLE %s NO FORCE ROW LEVEL SECURITY;" % table) != 1 or up.count(
                "ALTER TABLE %s FORCE ROW LEVEL SECURITY;" % table) != 1:
            errs.append("0041 must lift and restore the forced row-level security of %s exactly once for the backfill" % table)
    if "SET CONSTRAINTS ALL IMMEDIATE" not in up or "ON CONFLICT DO NOTHING" not in up:
        errs.append("0041 backfill must be idempotent and check its deferred keys before the tables are altered")
    if up.find("NO FORCE ROW LEVEL SECURITY") > up.find("INSERT INTO search.index_status (workspace_id, source_kind, source_id, auth_record_id)\nSELECT"):
        errs.append("0041 must lift the force before it reads the source tables")
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("0041: %s has no tenant_isolation policy" % table)
        if "'%s':" % table not in schema:
            errs.append("schema.ts lacks %s" % table)
    for table in SOURCE_TABLES:
        if not re.search(r"CREATE TRIGGER search_changed AFTER[^;]*ON %s\b" % re.escape(table), up):
            errs.append("0041: %s has no search_changed trigger" % table)
    for table in SOURCE_TABLES[:-1]:
        if not re.search(r"CREATE TRIGGER search_removed AFTER DELETE ON %s\b" % re.escape(table), up):
            errs.append("0041: %s has no search_removed trigger" % table)
    if "Restores the exact 0040 catalog" not in down:
        errs.append("0041 down must restore 0040")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    # Under forced RLS a GIN index on tsv cannot be used (the match operator is not leakproof).
    if re.search(r"CREATE INDEX [^;]*USING\s+gin", up, re.I):
        errs.append("0041 must not create a GIN index (unusable under forced row-level security; ADR-0028 S14)")
    # The API never writes the projection or the queue; the worker is the only writer of both.
    for m in re.finditer(r"GRANT ([A-Z, ()a-z_]+) ON ([^;]*?) TO app_rw", up):
        if re.search(r"search\.(search_document|index_status)\b", m.group(2)) and re.search(
                r"INSERT|UPDATE|DELETE", m.group(1)):
            errs.append("the API role must only read the projection and the queue")
    # Triggers write keys and delete rows; nothing in 0041 returns content through a definer function.
    for fn in re.finditer(r"CREATE FUNCTION ([a-z_.]+)\(([^)]*)\) RETURNS (TABLE \(([^)]*)\)|[a-z]+)", up):
        name, ret = fn.group(1), fn.group(4) or fn.group(3)
        if name.startswith("exec_dispatch.") and ret.strip() != "workspace_id uuid":
            errs.append("%s must return workspace identifiers only" % name)
    svc = read(P(SERVICE))
    srcs = read(P(SOURCES))
    sem = read(P(SEMANTICS))
    job = read(P(JOB))
    for method in ["async search(caller: Caller", "async searchStatus(caller: Caller",
                   "async openResult(caller: Caller", "async recordRecentSearch(caller: Caller",
                   "async listRecentSearches(caller: Caller", "async clearRecentSearches(caller: Caller"]:
        if method not in svc:
            errs.append("the search service lacks %s" % method)
    # One authority, applied inside the query before anything is matched, counted, or excerpted.
    for needle in ["compileVisibility(", "vis.where('r')", "governingProject('r')", "readableBrandsByIds(",
                   "this.inWorkspace(", "WITH m AS MATERIALIZED", "this.searchLimit("]:
        if needle not in svc:
            errs.append("the search service must use %s" % needle)
    if "JOIN core.record r ON r.workspace_id = e.workspace_id AND r.id = e.auth_record_id" not in svc:
        errs.append("every search must join the entry to its governing record")
    if re.search(r"OFFSET \$\{(input|after|position)", svc) or re.search(r"\boffset\b\s*[:=]", svc):
        errs.append("search pages by keyset cursor, never by offset (0B 10.5)")
    for forbidden in ["ts_headline", "withWorkspaceBypass", "SECURITY DEFINER", "dangerouslySetInnerHTML",
                      "writeOutboxEvent(", "workAudit(", "set_config("]:
        if forbidden in svc or forbidden in srcs:
            errs.append("the search service and sources must not use %s" % forbidden)
    if "createHmac(" not in svc or "timingSafeEqual(" not in svc or "cursor_invalid" not in svc:
        errs.append("cursors must be signed for one person and one search")
    if "cursor_invalid" not in read(P("packages/contracts/src/generated/registry.ts")):
        errs.append("cursor_invalid must be a registered error code")
    # The projection holds no permission copy.
    for needle in ["brand_id", "project_id", "lifecycle_state", "grantee"]:
        if re.search(r"CREATE TABLE search\.search_document \(.*?\n\);", up, re.S) and needle in re.search(
                r"CREATE TABLE search\.search_document \(.*?\n\);", up, re.S).group(0).split("tsv")[0]:
            errs.append("search_document must hold no %s (a copied permission key cannot honour revocation)" % needle)
    # Live checks for sources whose own row carries state.
    for needle in ["live: (entry)", "c.deleted_at IS NULL", "o.lifecycle_state = ANY("]:
        if needle not in srcs:
            errs.append("sources lack the live check %s" % needle)
    # Pure semantics: no I/O.
    for forbidden in ["@pm/db", "sql`", "fetch(", "node:fs"]:
        if forbidden in sem:
            errs.append("semantics.ts must stay pure (%s)" % forbidden)
    # Indexing: key-driven, claimed without collisions, savepointed, bounded, never storing messages.
    for needle in ["FOR UPDATE SKIP LOCKED", "SAVEPOINT search_item", "ROLLBACK TO SAVEPOINT search_item",
                   "searchIndexBatchMax", "searchIndexMaxAttempts", "searchFailedRetryMinutes", "backoffSeconds(",
                   "discoverSearchWork("]:
        if needle not in job:
            errs.append("the index job must use %s" % needle)
    if "failure_code" not in job or "err.message" in job:
        errs.append("a failed key records a short code, never the error message")
    discovery = read(P("packages/db/src/discovery.ts"))
    if "exec_dispatch.discover_search_work" not in discovery:
        errs.append("discoverSearchWork must call the payload-free definer function")
    registry = read(P("apps/worker/src/registry.ts"))
    for needle in ["searchIndexHandler(m.search)", "...SEARCH_SCHEDULES"]:
        if needle not in registry:
            errs.append("the worker must register %s" % needle)
    routes = read(P(ROUTES))
    if "const ws = '/v1/workspaces/:ws/search'" not in routes:
        errs.append("the search routes must live under workspaces/{ws}/search")
    for path in ["`${ws}/status`", "`${ws}/open`", "`${ws}/recent`", "`${ws}/recent/:handle`"]:
        if path not in routes:
            errs.append("route %s missing" % path)
    if "private, no-store" not in routes:
        errs.append("search responses must be private and uncached")
    # Recent searches are personal data.
    if "'search.recent_search'" not in read(P("packages/tenancy/src/personal-data.ts")):
        errs.append("recent searches must be erased with a person's personal data")
    # Web: excerpts are data rendered as text; the page keeps its state in the address.
    page = read(P(PAGE))
    pal = read(P(PALETTE))
    for forbidden in ["dangerouslySetInnerHTML", "innerHTML", "ts_headline"]:
        if forbidden in page or forbidden in pal:
            errs.append("search UI must render text, not markup (%s)" % forbidden)
    for needle in ["<mark key=", "role=\"search\"", "aria-live", "searchApi.open(", "parseSearchParams("]:
        if needle not in page and needle.replace("aria-live", "role=\"status\"") not in page:
            errs.append("the search page lacks %s" % needle)
    for needle in ["Search everywhere for", "searchApi.remember(", "searchApi.recent("]:
        if needle not in pal:
            errs.append("the command palette lacks %s" % needle)
    registry_ts = read(P("apps/web/src/shell/registry.ts"))
    if "id: 'search'" not in registry_ts or "shortcut: '/'" not in registry_ts or "stateInQuery: true" not in registry_ts:
        errs.append("the search route, its / shortcut, and its stateInQuery flag must be registered")
    if "'go.search'" not in read(P("packages/contracts/src/shell.ts")):
        errs.append("go.search must be a registered shell command")
    # Class chain: search extends the file service, and the factory builds it.
    if "export class SearchService extends FileService" not in svc:
        errs.append("SearchService must extend FileService")
    factory = read(P("packages/work/src/factory.ts"))
    # 5B's goal services extend the SearchService, and the factory returns the top of that chain.
    if not re.search(r"\}\): (SearchService|PortfolioService|MetricService|ReportService|PublicApiService) \{", factory) or not re.search(
            r"return new (SearchService|PortfolioService|MetricService|ReportService|PublicApiService)\(", factory):
        errs.append("createWorkService must build and return the SearchService (or the 5B/5D chain on top of it)")
    for path, needles in {
        "packages/work/test/integration/search.test.ts": [
            "treats a hidden record exactly like one that does not exist: no result, count, facet, excerpt, or ranking",
            "checks access at request time: a share grants and a revoked share removes, with no reindex",
            "removes a deleted comment and a trashed file at once, before the index catches up",
            "reports a lagging index per result and for the workspace, never as complete",
            "retries a failing source with backoff, shows it as failed, isolates it, and recovers",
            "indexes concurrently without loss or duplication, and re-queues a change that lands mid-index",
            "opens a result only after checking access again, and never widens it"],
        "packages/work/test/integration/search-backfill.test.ts": [
            "queues every supported record that existed before the migration, exactly once, and no purged or deleted one",
            "says catching up until the backlog is indexed, then finds every record without any edit",
            "is idempotent: applying the migration again over an indexed database changes nothing, and a failure is shown and recovers"],
        "packages/work/test/integration/search-access.test.ts": [
            "shows each person exactly the records their own reads allow, for every role and a guest"],
        "apps/api/test/integration/search-api.test.ts": [
            "gives a hidden record and an unknown one the same answer"],
        "e2e/search.spec.ts": [
            "follows access: results are the person’s own, vanish when access is removed, and hidden looks like unknown",
            "reflows at 320 px and 200% zoom, with forced colours and reduced motion, and stays accessible",
            "reaches the search field and every filter with the keyboard alone"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 42)))
    return errs, "migration guards, governing-record authority, key-driven bounded indexing, keyset paging, personal recents"


def check_boundaries_kept():
    """5A builds no semantic search, vector store, analytics, connector, or attachment extraction."""
    errs = []
    paths = [SERVICE, SOURCES, SEMANTICS, JOB, ROUTES, PAGE]
    for path in paths:
        text = read(P(path)).lower()
        for forbidden in ["pgvector", "embedding", "openai", "anthropic", "pg_trgm", "tesseract", "pdf-parse",
                          "elasticsearch", "meilisearch", "typesense", "algolia"]:
            if forbidden in text:
                errs.append("%s names %s: no semantic, vector, OCR, or external search in 5A" % (path, forbidden))
    up = read(P(MIGRATION + ".up.sql"))
    if re.search(r"CREATE EXTENSION", up, re.I):
        errs.append("0041 creates an extension (none is needed)")
    for schema in ["insights", "integrations", "ai", "agents", "goals"]:
        if re.search(r"CREATE (SCHEMA|TABLE) %s\b" % schema, up):
            errs.append("0041 creates %s structures (a later phase owns them)" % schema)
    srcs = read(P(SOURCES))
    for forbidden in ["storage.read(", "files.file_object", "field_value", "edit_draft", "document_reference"]:
        if forbidden in srcs:
            errs.append("sources must not read %s (file bytes, field values, drafts, and reference labels are never indexed)" % forbidden)
    for pkg in ["package.json", "apps/api/package.json", "apps/web/package.json", "packages/work/package.json"]:
        if os.path.isfile(P(pkg)) and re.search(
                r'"(pgvector|openai|@anthropic-ai/[^"]*|elasticsearch|@elastic/[^"]*|meilisearch|typesense|algoliasearch)"\s*:',
                read(P(pkg))):
            errs.append("%s adds a vector, AI, or search-engine dependency" % pkg)
    return errs, "no semantic, vector, OCR, external search, analytics, or connector structures"


def check_adr(closure):
    errs = []
    path = phase1.adr_path(ADR_ID)
    if not path:
        return ["no ADR-%s" % ADR_ID], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-%s status must be accepted and implemented or proposed" % ADR_ID)
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-%s is proposed but the closure is not a candidate" % ADR_ID)
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-%s has no row %s" % (d["id"], ADR_ID, d.get("adr_row")))
    if "**Numbering.**" not in text:
        errs.append("ADR-%s must record its identifiers and the parallel 5B numbering" % ADR_ID)
    return errs, "ADR-%s %s" % (ADR_ID, m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase5/closure-5a.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 5A: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "5A", ["D%d" % i for i in range(1, 17)])),
        ("phase 5A: bounds, signals, envelopes, no new actions or events", check_contracts(registry, policy)),
        ("phase 5A: migration, authority, and indexing invariants", check_invariants()),
        ("phase 5A: later-phase and engine boundaries kept", check_boundaries_kept()),
        ("phase 5A: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 5A: configuration keys documented", phase1.check_config_documented()),
        ("phase 5A: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 5A CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
