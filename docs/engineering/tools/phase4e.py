#!/usr/bin/env python3
"""Phase 4E closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase4e.py      # exit 1 on any failure

Phase 4E (docs/engineering/phase4/closure-4e.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, foundations deferred with
accepted sources, decisions D1..D10 tied to ADR-0026 rows F1..F10) plus drift checks: the file
bounds are registered (owner 4E), configured, and documented; the events, signals, envelopes, the
file/fv/upl/dlv/dv prefixes, and the actions 4E uses are registered; migration 0039 keeps its key,
immutability, evidence-lock, and RLS guards and its exact rollback to 0038; the service extends the
notification service and is what createWorkService returns; downloads refuse anything not clean;
inline previews exclude SVG and HTML; object keys carry no identifiers; deliverables follow 4A
through the reviewSettled hook; storage and scanner absence is reported truthfully; and the ADR
stays proposed until acceptance.

Phase 4C runs in parallel and may claim the same numbers (0039, ADR-0026, ADR-34, AZ-34, PL-36,
T-52, AT-218 onward); the later integration renumbers deterministically and updates this file.
"""
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
    "SIGNED_URL_LIFETIME": ("signedUrlLifetimeSeconds", 300),
    "UPLOAD_SESSION_LIFETIME": ("uploadSessionLifetimeSeconds", 3600),
    "FILE_UPLOAD_MAX_BYTES": ("fileUploadMaxBytes", 104857600),
    "WORKSPACE_STORAGE_QUOTA_BYTES": ("workspaceStorageQuotaBytes", 10737418240),
    "FILE_COMPARE_MAX_BYTES": ("fileCompareMaxBytes", 262144),
    "FILE_SCAN_MAX_ATTEMPTS": ("fileScanMaxAttempts", 5),
    "FILE_VERSIONS_MAX": ("fileVersionsMax", 100),
    "FILES_LIST_MAX": ("filesListMax", 200),
    "DELIVERABLES_PER_TASK_MAX": ("deliverablesPerTaskMax", 50),
    "FILE_DISCOVERY_MAX": ("fileDiscoveryMax", 100),
    "FILE_EXPIRY_BATCH_MAX": ("fileExpiryBatchMax", 200),
}
EVENTS = ["files.file.added", "files.file.version_added", "files.file.scanned",
          "files.deliverable.version_submitted", "files.deliverable.state_changed"]
SIGNALS = ["files.requests", "files.jobs", "upload.completed", "file.scan.duration"]
ENVELOPES = ["storage_status", "file_url", "file_comparison", "file_trashed", "deliverable_list"]
PREFIXES = ["file", "fv", "upl", "dlv", "dv"]
ACTIONS = ["record.read", "record.upload", "record.download", "record.trash", "deliverable.submit",
           "review.decide"]
TABLES = ["files.file_object", "files.file", "files.file_version", "files.upload_session", "files.deliverable",
          "files.deliverable_version", "files.storage_usage"]
SERVICE = "packages/work/src/files/file-service.ts"
SEMANTICS = "packages/work/src/files/semantics.ts"
JOBS = "packages/work/src/files/jobs.ts"
LIFECYCLE = "packages/work/src/files/lifecycle.ts"
MIGRATION = "packages/db/migrations/0039_files_deliverables"


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
        elif params[name].get("owner") != "4E":
            errs.append("%s: 0D owner must be 4E" % name)
        if "%s: '%d'" % (name, default) not in server:
            errs.append("%s: server default is not %d" % (name, default))
        if "%s: c.%s" % (camel, name) not in server:
            errs.append("%s: not mapped to settings.%s" % (name, camel))
        if "`%s`" % name not in envdoc:
            errs.append("%s: not documented in environments.md" % name)
        if camel not in settings:
            errs.append("%s: missing from WorkSettings" % camel)
    for key in ["OBJECT_STORAGE", "MALWARE_SCANNER", "CLAMAV_HOST"]:
        if "`%s`" % key not in envdoc:
            errs.append("%s: not documented in environments.md" % key)
    if "OBJECT_STORAGE: 'none'" not in server or "MALWARE_SCANNER: 'none'" not in server:
        errs.append("object storage and malware scanning must default to none")
    for needle in ["OBJECT_STORAGE: local is a development adapter; refused in deployed environments",
                   "MALWARE_SCANNER: test-signature is a development adapter; refused in deployed environments"]:
        if needle not in server:
            errs.append("server config must refuse the development adapter when deployed (%s)" % needle.split(":")[0])
    events = {e["type"]: e for e in registry["events"]}
    forbidden = {"name", "title", "url", "key", "storage_key", "signature", "filename", "file_name", "body"}
    for e in EVENTS:
        if e not in events:
            errs.append("event %s not registered" % e)
        elif forbidden & set(events[e]["fields"]):
            errs.append("event %s declares a name, URL, key, or signature field" % e)
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
        elif prefixes[pre]["owner_module"] != "files":
            errs.append("prefix %s must belong to the files module" % pre)
    acts = {a["key"]: a for a in policy["actions"]}
    for a in ACTIONS:
        if a not in acts:
            errs.append("action %s is not in the policy" % a)
    if len([a for a in policy["actions"] if a["key"] not in LATER_ACTIONS]) != 122:
        errs.append("4E adds no actions: expected 122, found %d" % len([a for a in policy["actions"] if a["key"] not in LATER_ACTIONS]))
    for a, req in [("record.upload", "FILE-001"), ("record.download", "FILE-012"), ("deliverable.submit", "FILE-007"),
                   ("record.read", "PRJ-023")]:
        if a in acts and req not in acts[a]["requirements"]:
            errs.append("action %s must list %s" % (a, req))
    readiness = read(P("apps/api/src/readiness.ts"))
    if "object_storage: 'not_configured'" not in readiness:
        errs.append("readiness must report object_storage as not_configured when no store is configured")
    return errs, "%d bounds, %d events, %d signals, %d envelopes, %d prefixes, %d actions" % (
        len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES), len(PREFIXES), len(ACTIONS))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["file_object_key_shape", "file_object_key_matches", "file_object_clean_promoted",
                   "file_object_signature_shape", "file_host_shape", "file_scope_key", "file_version_source_shape",
                   "CREATE TRIGGER file_version_guard", "CREATE TRIGGER deliverable_version_guard",
                   "deliverable_expected_known", "deliverable_accepted_shape", "deliverable_version_accepted_shape",
                   "upload_session_key_shape", "storage_usage_nonnegative", "discover_file_work",
                   "subject_kind IN ('task', 'project', 'document', 'deliverable')", "ENABLE ROW LEVEL SECURITY",
                   "FORCE ROW LEVEL SECURITY"]:
        if needle not in up:
            errs.append("0039 lacks %s" % needle)
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("0039: %s has no tenant_isolation policy" % table)
        if "'%s':" % table not in schema:
            errs.append("schema.ts lacks %s" % table)
    if "Restores the exact 0038 catalog" not in down:
        errs.append("0039 down must restore 0038")
    if "subject_kind IN ('task', 'project', 'document'));" not in down:
        errs.append("0039 down must restore the 0038 review subject check")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    # Rows never hold a signed URL.
    for col in ["signed_url", "download_url", "presigned"]:
        if col in up:
            errs.append("0039 must not store a signed URL (%s)" % col)
    svc = read(P(SERVICE))
    sem = read(P(SEMANTICS))
    if "export class FileService extends LiveService" not in svc:
        errs.append("FileService must extend LiveService (4C, then 4D, then 4E, in the service chain)")
    factory = read(P("packages/work/src/factory.ts"))
    # The factory builds the top of the chain, now including the 6E MCP access service.
    if not re.search(r"\}\): (FileService|SearchService|PortfolioService|MetricService|ReportService|PublicApiService|CalendarService|McpAccessService|AiGatewayService|AutomationService|AgentService) \{", factory) or not re.search(
            r"return new (FileService|SearchService|PortfolioService|MetricService|ReportService|PublicApiService|CalendarService|McpAccessService|AiGatewayService|AutomationService|AgentService)\(", factory):
        errs.append("createWorkService must build and return the FileService (or the 5A/5B/5D service chain on top of it)")
    elif ("PortfolioService" in factory or "MetricService" in factory or "ReportService" in factory) and "export class GoalCore extends SearchService" not in read(
            P("packages/work/src/goals/goal-core.ts")):
        errs.append("the 5B goal services must extend the SearchService (4C, 4D, 4E, 5A, then 5B in the service chain)")
    if "export class SearchService extends FileService" not in read(P("packages/work/src/search/search-service.ts")):
        errs.append("the SearchService must extend the FileService")
    for method in ["async storageStatus(", "async initiateUpload(", "async getUpload(", "async completeUpload(",
                   "async addFileLink(", "async listFiles(", "async getFile(", "async renameFile(",
                   "async trashFile(", "async fileUrl(", "async compareVersions(", "async createDeliverable(",
                   "async listDeliverables(", "async getDeliverable(", "async submitDeliverable(",
                   "protected override async reviewSettled("]:
        if method not in svc:
            errs.append("FileService lacks %s" % method)
    for needle in ["decideWorkspace(", "decideBrand(", "this.loadHost(", "host.decide('record.upload')",
                   "host.decide('record.download')", "host.decide('record.trash')", "'deliverable.submit'"]:
        if needle not in svc:
            errs.append("FileService must reuse %s" % needle)
    for forbidden in ["withWorkspaceBypass", "SECURITY DEFINER"]:
        if forbidden in svc:
            errs.append("FileService must not use %s" % forbidden)
    # Downloads refuse anything not clean: pending is file_not_ready, infected or failed is file_blocked.
    m = re.search(r"async fileUrl\((.*?)\n  async ", svc, re.S)
    body = m.group(1) if m else ""
    if "file_not_ready" not in body or "file_blocked" not in body:
        errs.append("fileUrl must refuse pending (file_not_ready) and blocked (file_blocked) versions")
    # Inline previews never include SVG or HTML.
    rules = re.search(r"export const CONTENT_TYPES(.*?)\n\};", sem, re.S)
    rules = rules.group(1) if rules else ""
    for t in ["image/svg+xml", "text/html"]:
        if not re.search(r"'%s': \{ preview: 'none'" % re.escape(t), rules):
            errs.append("%s must be download-only (preview 'none')" % t)
    if "rule.preview === 'none') return null" not in sem:
        errs.append("inlineType must refuse download-only formats")
    # Object keys carry no identifiers.
    if "export const quarantineKey = (randomHex: string) => `q.${randomHex}`" not in sem:
        errs.append("quarantine keys must be q.{random hex}")
    if "storage_key ~ '^[qo]\\.[0-9a-f]{64}$'" not in up:
        errs.append("0039 must constrain object keys to q./o. plus 64 hex")
    # Deliverables follow 4A through the reviewSettled hook.
    review = read(P("packages/work/src/collab/review-service.ts"))
    if review.count("await this.reviewSettled(") < 2:
        errs.append("4A decide and withdraw must both call reviewSettled")
    if "LEFT JOIN files.deliverable dl" not in review:
        errs.append("the 4A review queue must resolve deliverables through their task")
    if "export function stateAfterReview(" not in sem:
        errs.append("semantics must map 4A outcomes to deliverable states")
    # Honest absence of storage and scanner.
    for needle in ["storage_not_configured", "scanner_not_configured", "dependency_unavailable"]:
        if needle not in svc:
            errs.append("upload initiation must refuse with %s when unconfigured" % needle)
    jobs = read(P(JOBS))
    if "fileScanMaxAttempts" not in jobs:
        errs.append("the scan job must fail closed after FILE_SCAN_MAX_ATTEMPTS")
    lifecycle = read(P(LIFECYCLE))
    if "evidence_locked" not in lifecycle or "object:" not in read(P(SEMANTICS)):
        errs.append("purge must keep evidence-locked versions and record object effects")
    for path, needles in {
        "packages/work/test/integration/files.test.ts": [
            "uploads into quarantine, scans clean, then signs a short-lived download",
            "refuses type mismatches, checksum mismatches, and HTML/SVG inline previews",
            "blocks infected uploads, releases their bytes, and fails closed after the last scan attempt",
            "reviews deliverables through 4A and evidence-locks the accepted version",
            "makes hidden files the same not_found as unknown ones, and revokes access immediately",
            "is honest when storage or scanning is not configured"],
        "packages/work/test/integration/files-access.test.ts": [
            "decides upload, read, and download by role, share, and host",
            "lets only the comment author attach to a comment, under the comment host’s authority",
            "reserves quota atomically: concurrent uploads past the quota let one through",
            "purges files with their task and deletes the orphaned bytes once through the sweep"],
        "apps/api/test/integration/files-api.test.ts": [
            "gives strangers the same not_found everywhere and never returns internal UUIDs"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 39)))
    ods = read(P("docs/product/open-decisions.md"))
    seg = ods[ods.find('<a id="od-36">'):ods.find('<a id="od-37">')]
    if "**Status (Phase 4E" not in seg:
        errs.append("OD-36 must carry its Phase 4E status (open, no invented period)")
    return errs, "migration guards, clean-only downloads, no inline SVG/HTML, identifier-free keys, 4A hook, OD-36 open"


def check_boundaries_kept():
    """4E builds no document, collaborative-editing, evidence-item, agent, or connector structure."""
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    for schema in ["knowledge", "agents", "integrations"]:
        if re.search(r"CREATE (SCHEMA|TABLE) %s\b" % schema, up):
            errs.append("0039 creates %s structures (a later phase owns them)" % schema)
    if re.search(r"CREATE TABLE files\.evidence_item\b", up):
        errs.append("0039 creates files.evidence_item (9B owns it)")
    for path in ["packages/work/src/files/s3-storage.ts", "packages/work/src/files/storage.ts",
                 "packages/work/src/files/scanner.ts"]:
        text = read(P(path))
        for forbidden in ["@aws-sdk", "aws-sdk", "@google-cloud", "@azure"]:
            if forbidden in text:
                errs.append("%s imports a provider SDK (%s): providers stay behind the neutral port" % (path, forbidden))
    svc = read(P(SERVICE)) + read(P(JOBS))
    if re.search(r"\bfetch\(", svc):
        errs.append("the file service must never fetch an external link (SSRF)")
    return errs, "no document, evidence-item, agent, or connector structures; no provider SDK; links never fetched"


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0026")
    if not path:
        return ["no ADR-0026"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0026 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0026 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0026 has no row %s" % (d["id"], d.get("adr_row")))
    if "**Numbering.**" not in text:
        errs.append("ADR-0026 must record the parallel 4C numbering and its deterministic renumbering")
    return errs, "ADR-0026 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase4/closure-4e.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 4E: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "4E", ["D%d" % i for i in range(1, 11)])),
        ("phase 4E: bounds, events, signals, envelopes, prefixes, actions", check_contracts(registry, policy)),
        ("phase 4E: migration, authorization, and content invariants", check_invariants()),
        ("phase 4E: later-phase boundaries kept", check_boundaries_kept()),
        ("phase 4E: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 4E: configuration keys documented", phase1.check_config_documented()),
        ("phase 4E: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 4E CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
