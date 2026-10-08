#!/usr/bin/env python3
"""Phase 4C closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase4c.py      # exit 1 on any failure

Phase 4B (docs/engineering/phase4/closure-4c.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, foundations deferred with
accepted sources, decisions D1..D10 tied to ADR-0025 rows) plus drift checks: the document
bounds are registered (owner 4C), configured, and documented; the events, signals, the
document_export envelope, the doc, dcv, and dsg prefixes, and the actions 4C uses are registered;
migration 0038 keeps its constraints, immutability, RLS, and exact rollback to 0037; the services
reuse the canonical loaders and compiled visibility, never store a label beside a reference,
never send a reference identifier the viewer cannot read, and never overwrite a version; export is
Markdown and HTML only; the placeholders are replaced; and the ADR stays proposed until acceptance.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402
import phase2  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

BOUNDS = {
    "DOCUMENT_BODY_MAX_BYTES": ("documentBodyMaxBytes", 262144),
    "DOCUMENT_BLOCKS_MAX": ("documentBlocksMax", 2000),
    "DOCUMENT_BLOCK_TEXT_MAX_CHARS": ("documentBlockTextMaxChars", 20000),
    "DOCUMENT_TABLE_CELLS_MAX": ("documentTableCellsMax", 1000),
    "DOCUMENT_DEPTH_MAX": ("documentDepthMax", 6),
    "DOCUMENT_CHILDREN_MAX": ("documentChildrenMax", 200),
    "DOCUMENT_TREE_MAX": ("documentTreeMax", 1000),
    "DOCUMENT_VERSIONS_MAX": ("documentVersionsMax", 1000),
    "DOCUMENT_REFERENCES_MAX": ("documentReferencesMax", 500),
    "DOCUMENT_SUGGESTIONS_OPEN_MAX": ("documentSuggestionsOpenMax", 100),
    "DOCUMENT_EXPORT_PAGES_MAX": ("documentExportPagesMax", 100),
    "DOCUMENT_EXPORT_MAX_BYTES": ("documentExportMaxBytes", 5242880),
    "DOCUMENT_REVIEW_HORIZON_DAYS": ("documentReviewHorizonDays", 730),
    "DOCUMENT_SAVE_RATE_PER_MINUTE": ("documentSaveRatePerMinute", 60),
    "DOCUMENT_EMBED_URL_MAX_CHARS": ("documentEmbedUrlMaxChars", 2048),
}
EVENTS = ["knowledge.document.created", "knowledge.document.version_saved", "knowledge.document.updated",
          "knowledge.document.mention_added", "knowledge.document.suggestion_created",
          "knowledge.document.suggestion_decided", "knowledge.document.source_approved"]
SIGNALS = ["knowledge.documents", "knowledge.versions", "knowledge.suggestions", "knowledge.exports",
           "knowledge.references"]
ENVELOPES = ["document_export"]
PREFIXES = ["doc", "dcv", "dsg"]
ACTIONS = ["record.update", "record.create", "record.assign", "record.export", "record.comment", "record.share"]
TABLES = ["knowledge.document", "knowledge.document_version", "knowledge.document_reference",
          "knowledge.document_suggestion", "knowledge.source_approval"]
CORE = "packages/work/src/docs/document-core.ts"
SERVICE = "packages/work/src/docs/document-service.ts"
SUGGEST = "packages/work/src/docs/suggestion-service.ts"
CONTENT = "packages/work/src/docs/content.ts"
LIFECYCLE = "packages/work/src/docs/lifecycle.ts"
MIGRATION = "packages/db/migrations/0038_documents"


def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "4C":
            errs.append("%s: 0D owner must be 4C" % name)
        if "%s: '%d'" % (name, default) not in server:
            errs.append("%s: server default is not %d" % (name, default))
        if "%s: c.%s" % (camel, name) not in server:
            errs.append("%s: not mapped to settings.%s" % (name, camel))
        if "`%s`" % name not in envdoc:
            errs.append("%s: not documented in environments.md" % name)
        if camel not in settings:
            errs.append("%s: missing from WorkSettings" % camel)
    events = {e["type"]: e for e in registry["events"]}
    for e in EVENTS:
        if e not in events:
            errs.append("event %s not registered" % e)
    signals = {t["name"] for t in registry["telemetry"]}
    for s in SIGNALS:
        if s not in signals:
            errs.append("signal %s not registered" % s)
    envelopes = read(P("packages/contracts/src/envelopes.ts"))
    for e in ENVELOPES:
        if "'%s'" % e not in envelopes:
            errs.append("envelope %s not registered" % e)
    prefixes = {p["prefix"]: p for p in registry["id_prefixes"]}
    for pre in PREFIXES:
        if pre not in prefixes:
            errs.append("prefix %s not registered" % pre)
    acts = {a["key"]: a for a in policy["actions"]}
    for a in ACTIONS:
        if a not in acts:
            errs.append("action %s is not in the policy" % a)
    if len(policy["actions"]) != 122:
        errs.append("4C adds no actions: expected 122, found %d" % len(policy["actions"]))
    forbidden = {"body", "text", "message", "note", "title", "name", "email", "address", "subject", "content", "url"}
    for e in EVENTS:
        if e in events and forbidden & set(events[e]["fields"]):
            errs.append("event %s declares a content field" % e)
    if "document" not in read(P("packages/tenancy/src/sharing.ts")):
        errs.append("the document record type must be registered as shareable")
    if "'document'" not in read(P("packages/work/src/collab/semantics.ts")):
        errs.append("document must be a registered collaboration host")
    if "PDF" not in read(P("docs/product/open-decisions.md")):
        errs.append("OD-32 must state the PDF decision")
    return errs, "%d bounds, %d events, %d signals, %d envelope, %d prefixes, %d actions" % (
        len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES), len(PREFIXES), len(ACTIONS))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["document_version_immutable", "assert_document_placement", "document_version_number_key",
                   "document_reference_target_shape", "document_suggestion_decided_shape", "source_approval_kind_known",
                   "document_access_mode_known", "document_version_content", "document_version_hash_format",
                   "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY"]:
        if needle not in up:
            errs.append("0038 lacks %s" % needle)
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("0038: %s has no tenant_isolation policy" % table)
        if "'%s':" % table not in schema:
            errs.append("schema.ts lacks %s" % table)
    if "Restores the exact 0037 catalog" not in down:
        errs.append("0038 down must restore 0037")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    # Versions and approvals are append-only to the application role; references carry no label.
    for table in ["knowledge.document_version", "knowledge.source_approval"]:
        for m in re.finditer(r"GRANT ([A-Z, ()a-z_]+) ON ([^;]*?) TO app_rw", up):
            if table in m.group(2) and re.search(r"\b(DELETE|UPDATE)\b", m.group(1)):
                errs.append("0038 grants %s on %s to app_rw" % (m.group(1), table))
    ref = up[up.index("CREATE TABLE knowledge.document_reference"):up.index("CREATE TABLE knowledge.document_suggestion")]
    for col in ["label", "title", "name", "text"]:
        if re.search(r"^\s+%s\s" % col, ref, re.M):
            errs.append("knowledge.document_reference must not store a %s" % col)
    svc = read(P(CORE)) + read(P(SERVICE)) + read(P(SUGGEST))
    for method in ["async listDocuments(", "async getDocument(", "async listVersions(", "async getVersion(",
                   "async backlinks(", "async createDocument(", "async saveContent(", "async restoreVersion(",
                   "async updateDocument(", "async moveDocument(", "async setLinks(", "async documentLifecycle(",
                   "async exportDocument(", "async listSuggestions(", "async getSuggestion(",
                   "async createSuggestion(", "async decideSuggestion(", "async withdrawSuggestion(",
                   "approveSource(", "revokeSource(", "protected async loadDocument(",
                   "protected override async loadExtraHost(", "protected async checkNewRefs(",
                   "protected async syncReferences(", "protected restoreRefs(", "protected redact("]:
        if method not in svc:
            errs.append("document services lack %s" % method)
    for needle in ["this.mutate(", "this.inWorkspace(", "compileVisibility(", "decideRecord(", "recordLevel(",
                   "requireVersion(", "this.issueLifecycle("]:
        if needle not in svc:
            errs.append("document services must reuse %s" % needle)
    for forbidden in ["withWorkspaceBypass", "SECURITY DEFINER", "deleteFrom('knowledge.document_version')",
                      "updateTable('knowledge.document_version')", "updateTable('knowledge.source_approval')"]:
        if forbidden in svc:
            errs.append("document services must not use %s" % forbidden)
    # A viewer never receives the identifier of a reference they cannot read.
    if svc.count("this.redact(") < 2:
        errs.append("document and version views must redact unreadable references")
    content = read(P(CONTENT))
    for needle in ["unsupported_embed", "export const RESTRICTED_ID", "export function toMarkdown(", "export function htmlBody("]:
        if needle not in content:
            errs.append("content module lacks %s" % needle)
    if re.search(r"format.*['\"]pdf['\"]", read(P("packages/work/src/docs/validation.ts"))):
        errs.append("PDF export must not be offered (OD-32, ADR-0025 D9)")
    lifecycle = read(P("packages/work/src/lifecycle.ts"))
    if "attachedDocuments(" not in lifecycle or "purgeDocumentTargets(tx, ids)" not in lifecycle:
        errs.append("project and task lifecycle must carry and purge their documents")
    if "documentAdapter" not in lifecycle:
        errs.append("the document record type must be registered with the lifecycle")
    if "knowledge.document" not in read(P("packages/tenancy/src/projects.ts")):
        errs.append("the generic governing-project derivation must cover documents")
    if "documents_attached" not in read(P("packages/work/src/task-core.ts")):
        errs.append("a task with documents must stay in its brand")
    for path, needles in {
        "packages/work/test/integration/documents.test.ts": [
            "saves versions that never overwrite: a stale base conflicts, equal content is a no-op",
            "restores an earlier version as a new one and keeps the whole history",
            "decides every read and write through the placement: owners, members, read-only, outsiders, shares, and strangers",
            "links records by registered reference, re-checks every viewer, and shows no title they cannot read",
            "applies a suggestion to an unchanged block as a new version, and only an editor decides",
            "goes stale, with nothing applied, when the block changed since; rejects and withdraws without touching content",
            "approves the current version as an AI source, stops applying on the next save, and is append-only",
            "archives, trashes, restores, and purges a page with its subpages, and a project or task carries its documents",
            "exports Markdown and HTML for people who may, audits the fact and never the content, and is honest about what it cannot carry"],
        "packages/work/test/integration/documents-notify.test.ts": [
            "gives hidden and unknown documents, versions, suggestions, and backlinks the same statements and time",
            "serializes concurrent saves on one base version: one wins, the other conflicts, nothing is lost",
            "keeps titles, text, and addresses out of audit and events"],
        "apps/api/test/integration/documents-api.test.ts": [
            "saves content against the version loaded, conflicts on a stale one, lists versions, and restores"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 39)))
    ods = read(P("docs/product/open-decisions.md"))
    seg = ods[ods.find('<a id="od-32">'):ods.find('<a id="od-33">')]
    if "**Status (Phase 4C" not in seg:
        errs.append("OD-32 must carry its Phase 4C status")
    return errs, "migration guards, immutable versions, redacted references, canonical loaders, OD-32 decided"


def check_boundaries_kept():
    """4C builds no file storage, live editing, search index, or notification delivery."""
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    for schema in ["files", "agents", "integrations", "search"]:
        if re.search(r"CREATE (SCHEMA|TABLE) %s\b" % schema, up):
            errs.append("0038 creates %s structures (a later phase owns them)" % schema)
    for path in ["packages/work/src/docs/content.ts", "packages/work/src/docs/document-service.ts"]:
        text = read(P(path)).lower()
        for forbidden in ["yjs", "automerge", "prosemirror", "tiptap", "websocket", "s3://", "pdfkit", "puppeteer"]:
            if forbidden in text:
                errs.append("%s names %s: editing engines, storage, and PDF belong to later phases" % (path, forbidden))
    knowledge = P("apps/web/src/pages/knowledge-pages.tsx")
    if os.path.isfile(knowledge) is False and os.path.isdir(P("apps/web/src")):
        errs.append("the Knowledge destination still has no page")
    routes = P("apps/web/src/app-routes.tsx")
    if os.path.isfile(routes) and "knowledge: destination('knowledge')" in read(routes):
        errs.append("the Knowledge destination is still a placeholder")
    task_page = P("apps/web/src/pages/task-pages.tsx")
    if os.path.isfile(task_page) and "Documents (4C)" in read(task_page):
        errs.append("the task page still lists documents as unavailable")
    return errs, "no file, agent, connector, or search structures; no editing engine; placeholders replaced"


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0025")
    if not path:
        return ["no ADR-0025"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0025 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0025 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0025 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0025 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase4/closure-4c.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 4C: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "4C", ["D%d" % i for i in range(1, 11)])),
        ("phase 4C: bounds, events, signals, envelope, prefixes, actions", check_contracts(registry, policy)),
        ("phase 4C: migration, authorization, and version invariants", check_invariants()),
        ("phase 4C: later-phase boundaries kept", check_boundaries_kept()),
        ("phase 4C: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 4C: configuration keys documented", phase1.check_config_documented()),
        ("phase 4C: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 4C CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
