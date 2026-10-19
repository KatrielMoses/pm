#!/usr/bin/env python3
"""Phase 4D closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase4d.py      # exit 1 on any failure

Phase 4D (docs/engineering/phase4/closure-4d.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, decisions D1..D13 tied to
ADR-0027 rows C1..C13) plus drift checks: the live-editing bounds are registered (owner 4D),
configured, and documented; the signal and the live_session and live_update envelopes are
registered, and no action, prefix, or event is added; migration 0040 keeps its tenant isolation,
the document file-host constraints, and its exact rollback to 0039; operations edit a draft and
never append a version, are never audited, and every call re-reads the document through its
compiled level; hidden references stay opaque; a plain save cannot overwrite live work; presence is
members-only; the lifecycle purges drafts, sessions, and the log; documents host and embed files
through 4E's authorities; no CRDT, WebSocket server, or external provider is introduced; and the
ADR stays proposed until acceptance.
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
    "LIVE_EDITING_ENABLED": ("liveEditingEnabled", 1),
    "LIVE_SESSION_TTL_SECONDS": ("liveSessionTtlSeconds", 45),
    "LIVE_SESSIONS_MAX": ("liveSessionsMax", 20),
    "LIVE_SESSIONS_PER_MEMBER_MAX": ("liveSessionsPerMemberMax", 5),
    "LIVE_OPS_BATCH_MAX": ("liveOpsBatchMax", 50),
    "LIVE_POLL_WAIT_SECONDS": ("livePollWaitSeconds", 20),
    "LIVE_OP_LOG_MAX": ("liveOpLogMax", 2000),
    "LIVE_RATE_PER_MINUTE": ("liveRatePerMinute", 1200),
}
SIGNALS = ["knowledge.live"]
ENVELOPES = ["live_session", "live_update"]
TABLES = ["knowledge.edit_draft", "knowledge.edit_session", "knowledge.edit_op"]
LIVE = "packages/work/src/docs/live-service.ts"
PURE = "packages/work/src/docs/live.ts"
SERVICE = "packages/work/src/docs/document-service.ts"
CORE = "packages/work/src/docs/document-core.ts"
ROUTES = "apps/api/src/work/document-routes.ts"
MIGRATION = "packages/db/migrations/0040_collaborative_editing"


# Actions added after this subphase, each held by the validator of the phase that added it
# (P8-W0: operation.reconcile_effect, phase8w0.py).
LATER_ACTIONS = {"operation.reconcile_effect"}

def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "4D":
            errs.append("%s: 0D owner must be 4D" % name)
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
    if len([a for a in policy["actions"] if a["key"] not in LATER_ACTIONS]) != 122:
        errs.append("4D adds no actions: expected 122, found %d" % len([a for a in policy["actions"] if a["key"] not in LATER_ACTIONS]))
    if "'document.live'" not in read(P("packages/work/src/factory.ts")):
        errs.append("the document.live rate policy must be registered")
    events = {e["type"] for e in registry["events"]}
    if any(e.startswith("knowledge.document.live") or e.startswith("knowledge.live") for e in events):
        errs.append("operations and presence must emit no events")
    od = read(P("docs/product/open-decisions.md"))
    seg = od[od.find("### OD-30"):od.find('<a id="od-31">')]
    if "**Status (Phase 4D" not in seg:
        errs.append("OD-30 must carry its Phase 4D status")
    return errs, "%d bounds, %d signal, %d envelopes, no new actions, prefixes, or events" % (
        len(BOUNDS), len(SIGNALS), len(ENVELOPES))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["edit_draft_content", "edit_session_key_unique", "edit_op_idempotency", "edit_op_pkey",
                   "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY", "file_host_kind_known",
                   "upload_session_host_kind_known", "host_kind = 'document'"]:
        if needle not in up:
            errs.append("0040 lacks %s" % needle)
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("0040: %s has no tenant_isolation policy" % table)
        if "'%s':" % table not in schema:
            errs.append("schema.ts lacks %s" % table)
    if "Restores the exact 0039 catalog" not in down:
        errs.append("0040 down must restore 0039")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    for m in re.finditer(r"GRANT ([A-Z, ()a-z_]+) ON ([^;]*?) TO app_rw", up):
        if "knowledge.edit_op" in m.group(2) and "UPDATE" in m.group(1):
            errs.append("operations are append-only to the application role")
    live = read(P(LIVE))
    svc = read(P(SERVICE)) + read(P(CORE))
    pure = read(P(PURE))
    for method in ["async liveJoin(", "async liveOps(", "async liveEvents(", "async liveHeartbeat(",
                   "async liveCheckpoint(", "async liveLeave("]:
        if method not in live:
            errs.append("the live service lacks %s" % method)
    for method in ["protected async checkpointDraft(", "protected async liveGuard(",
                   "protected async recoverLiveDraft(", "protected async checkFileEmbeds(",
                   "protected async embeddedFiles("]:
        if method not in svc:
            errs.append("document services lack %s" % method)
    # Every live call is authorized through the compiled level, now.
    for needle in ["this.loadDocument(", "this.editableDoc(", "this.requireDocActive(", "this.restoreRefs(",
                   "this.checkNewRefs(", "this.redact(", "this.liveLimit(", "this.inWorkspace("]:
        if needle not in live:
            errs.append("the live service must reuse %s" % needle)
    # Operations edit a draft and never a version; nothing is audited or emitted per operation.
    for forbidden in ["appendVersion(", "document_version", "workAudit(", "docAudit(", "workEvent(",
                      "docEvent(", "writeOutboxEvent(", "withWorkspaceBypass", "SECURITY DEFINER"]:
        if forbidden in live:
            errs.append("the live service must not use %s (operations are never versions, audited, or emitted)" % forbidden)
    if "appendVersion(" not in svc or "'document.saved'" not in svc:
        errs.append("a checkpoint must append an ordinary audited version")
    for needle in ["live_edit_in_progress", "this.liveGuard(", "this.recoverLiveDraft("]:
        if needle not in svc and needle not in read(P("packages/work/src/docs/suggestion-service.ts")):
            errs.append("plain saves must refuse or save live work first (%s)" % needle)
    if read(P("packages/work/src/docs/suggestion-service.ts")).count("this.liveGuard(") < 1:
        errs.append("a suggestion that applies must go through the live guard")
    if "p.kind === 'member'" not in live:
        errs.append("presence must be limited to members who may see people")
    if "m.state = 'active'" not in live:
        errs.append("presence must omit people whose membership is no longer active")
    # Pure operations: no I/O.
    for forbidden in ["@pm/db", "sql`", "fetch(", "node:fs"]:
        if forbidden in pure:
            errs.append("live.ts must stay pure (%s)" % forbidden)
    routes = read(P(ROUTES))
    for path in ["/live/session", "/live/operations", "/live/events", "/live/heartbeat", "/live/checkpoint",
                 "/live/leave"]:
        if path not in routes:
            errs.append("route %s missing" % path)
    lifecycle = read(P("packages/work/src/docs/lifecycle.ts"))
    for t in ["knowledge.edit_op", "knowledge.edit_session", "knowledge.edit_draft"]:
        if "deleteFrom('%s')" % t not in lifecycle:
            errs.append("document purge must delete %s" % t)
    if "purgeFileFacts(tx, ids)" not in lifecycle or "fileChildren(tx, parentIds)" not in lifecycle:
        errs.append("documents must carry and purge their files")
    if "export class FileService extends LiveService" not in read(P("packages/work/src/files/file-service.ts")):
        errs.append("FileService must extend LiveService (4C, 4D, then 4E in the service chain)")
    if "export class LiveService extends KnowledgeService" not in live:
        errs.append("LiveService must extend KnowledgeService")
    if "FILE_EMBED_ID" not in read(P("packages/work/src/docs/content.ts")):
        errs.append("file embeds must name a file by its public identifier")
    for path, needles in {
        "packages/work/test/integration/live-editing.test.ts": [
            "opens a draft from the current version and converges two editors on the server order",
            "refuses a conflicting operation with the current block and never merges or drops it silently",
            "sequences concurrent editors without gaps, and the replayed log equals the draft",
            "keeps hidden references opaque in snapshots and events, and restores them when a block is edited",
            "decides every call through the document level: viewers watch, outsiders and revoked editors are refused",
            "keeps versioned non-live editing safe: a live session blocks it, unsaved work is saved first, nothing is overwritten"],
        "packages/work/test/integration/documents-files.test.ts": [
            "embeds only files attached to the document, shows them by what the viewer may read, and exports honestly"],
        "apps/api/test/integration/live-editing-api.test.ts": [
            "runs a live session end to end: join, operate, poll, heartbeat, checkpoint, leave"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 41)))
    return errs, "migration guards, draft-only operations, redaction, per-call authorization, members-only presence"


def check_boundaries_kept():
    """4D builds no CRDT, WebSocket server, external provider, search index, or agent editing."""
    errs = []
    for path in [LIVE, PURE, SERVICE, CORE, ROUTES]:
        text = read(P(path)).lower()
        for forbidden in ["yjs", "automerge", "y-websocket", "liveblocks", "tiptap", "prosemirror", "hocuspocus",
                          "@fastify/websocket", "socket.io", "new websocket("]:
            if forbidden in text:
                errs.append("%s names %s: no CRDT, socket server, or external provider in 4D" % (path, forbidden))
    up = read(P(MIGRATION + ".up.sql"))
    for schema in ["search", "agents", "integrations"]:
        if re.search(r"CREATE (SCHEMA|TABLE) %s\b" % schema, up):
            errs.append("0040 creates %s structures (a later phase owns them)" % schema)
    for pkg in ["package.json", "apps/api/package.json", "apps/web/package.json", "packages/work/package.json"]:
        if os.path.isfile(P(pkg)) and re.search(
                r'"(yjs|automerge|y-websocket|ws|socket\.io|@fastify/websocket|@liveblocks/[^"]*)"\s*:', read(P(pkg))):
            errs.append("%s adds a CRDT, socket, or provider dependency" % pkg)
    return errs, "no CRDT, socket server, provider, search, or agent structures"


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0027")
    if not path:
        return ["no ADR-0027"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0027 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0027 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0027 has no row %s" % (d["id"], d.get("adr_row")))
    if "**Numbering.**" not in text:
        errs.append("ADR-0027 must record the integration of 4C and 4E and its identifiers")
    return errs, "ADR-0027 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase4/closure-4d.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 4D: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "4D", ["D%d" % i for i in range(1, 14)])),
        ("phase 4D: bounds, signal, envelopes, no new actions or events", check_contracts(registry, policy)),
        ("phase 4D: migration, authorization, and live-edit invariants", check_invariants()),
        ("phase 4D: later-phase and provider boundaries kept", check_boundaries_kept()),
        ("phase 4D: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 4D: configuration keys documented", phase1.check_config_documented()),
        ("phase 4D: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 4D CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
