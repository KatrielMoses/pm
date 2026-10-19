#!/usr/bin/env python3
"""Phase 6 aggregate closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase6.py      # exit 1 on any failure

Phase 6 integration review (docs/engineering/phase6/closure-6.json, ADR-0037): 6A (connections),
6B (public API and webhooks), 6C (Google Calendar, completed in this review), 6D (CSV portability)
and 6E (MCP access) were built in parallel pairs and accepted one at a time. This validator proves
the integrated product stays reconciled:
  - every Phase 0-6E validator passes;
  - migrations 0045-0051, engineering ADRs 0032-0037, 0B/0C/0D anchors, threats and tests have one
    owner each and stay contiguous, and every registered Phase 6 test id names a real test;
  - the service chain, routes, worker, and planning/capacity hooks compose as one system;
  - each requirement a Phase 6 subphase owns (derived from the catalog, never a hard-coded total)
    is closed exactly once by its owner, with substantive evidence and valid deferral ownership,
    and the recorded boundaries (OD-33, 7A/8A/8B, 10A, OD-29) are kept, not invented or dropped;
  - the 6C corrections hold: no calendar requirement is closed on a reserved column or prose.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402

P = phase1.P
read = phase1.read
load = phase1.load

SUBPHASES = ["6A", "6B", "6C", "6D", "6E"]
VALIDATORS = ["docs/architecture/tools/phase0.py"] + [
    "docs/engineering/tools/%s.py" % n for n in
    ["phase1", "phase2", "phase3", "phase3b", "phase3c", "phase3d", "phase3e", "phase4a", "phase4b",
     "phase4c", "phase4d", "phase4e", "phase5a", "phase5b", "phase5c", "phase5d", "phase5",
     "phase6a", "phase6b", "phase6c", "phase6d", "phase6e"]]
MIGRATIONS = {
    "0045": ("0045_integration_framework", "0044"),
    # 6B shipped its down migration without the header; the boundary walk proves its rollback.
    "0046": ("0046_public_api_webhooks", None),
    "0047": ("0047_google_calendar", "0046"),
    "0048": ("0048_mcp_access_foundation", "0047"),
    "0049": ("0049_mcp_provenance", None),
    "0050": ("0050_csv_portability", "0049"),
    "0051": ("0051_calendar_completion", "0050"),
    "0052": ("0052_webhook_delivery_controls", "0051"),
}
ADRS = {"0032": "integration-framework", "0033": "public-api-webhooks", "0034": "google-calendar",
        "0035": "mcp-access-foundation", "0036": "data-portability", "0037": "phase-6-integration"}
ANCHORS = {
    "docs/architecture/data/12-decisions.md": ["adr-%d" % n for n in (40, 41, 42, 43)],
    "docs/architecture/access/15-decisions.md": ["az-%d" % n for n in (40, 41, 42, 43)],
    "docs/architecture/platform/19-decisions.md": ["pl-%d" % n for n in (42, 43, 44, 45)],
}
FIRST_THREAT, FIRST_TEST = 73, 298
TEST_DIRS = ["packages", "apps", "e2e"]
# Evidence that names only a reserved column or decision prose cannot close behavior (6C correction).
HOLLOW = [("CAL-012", "linked_work_block_id"), ("CAL-008", "busy boolean"), ("CAL-005", "event_tz"),
          ("CAL-013", "deadline protection"), ("PLAN-004", "Today exposes meetings"),
          ("VIEW-003", "calendars arrive when they can be connected (6C)")]



def _ai_head(factory):
    """Phase 7A extends the 6E head: AiGatewayService extends McpAccessService."""
    path = P("packages/work/src/ai/ai-gateway-service.ts")
    return ("return new AiGatewayService(" in factory and os.path.isfile(path)
            and "export class AiGatewayService extends McpAccessService" in read(path))

def check_validators():
    errs = []
    for v in VALIDATORS:
        r = subprocess.run([sys.executable, P(v)], capture_output=True, text=True)
        if r.returncode != 0:
            tail = [l.strip() for l in r.stdout.splitlines() if "FAIL" in l or "ERROR" in l][:3]
            errs.append("%s fails: %s" % (v, "; ".join(tail) or "exit %d" % r.returncode))
    return errs, "%d validators" % len(VALIDATORS)


def test_titles():
    """Every `it('AT-…` / `test('AT-…` title in the repository's test files."""
    seen = {}
    for base in TEST_DIRS:
        for dirpath, dirs, files in os.walk(P(base)):
            dirs[:] = [d for d in dirs if d not in ("node_modules", "dist")]
            for f in files:
                if not re.search(r"\.(test|spec)\.tsx?$", f):
                    continue
                path = os.path.join(dirpath, f)
                for m in re.finditer(r"\b(?:it|test)\(\s*['\"`](AT-\d{3})\b", read(path)):
                    seen.setdefault(m.group(1), []).append(os.path.relpath(path, P(".")))
    return seen


def check_numbering():
    errs = []
    names = sorted(os.listdir(P("packages/db/migrations")))
    by = {n.split("_", 1)[0]: n for n in names if n.endswith(".up.sql")}
    for num, (name, prior) in MIGRATIONS.items():
        if by.get(num) != name + ".up.sql":
            errs.append("migration %s must be %s" % (num, name))
            continue
        if prior and "Restores the exact %s catalog" % prior not in read(P("packages/db/migrations/%s.down.sql" % name)):
            errs.append("%s down must restore the exact %s catalog" % (name, prior))
    # 0052 closes Phase 6. Later migrations belong to later phases, each held by its own validator.
    later = [k for k in sorted(by) if k > "0052"]
    # Each later migration is held by the validator of the phase that added it.
    later_owned = {
        "0053": ("0053_ai_gateway.up.sql", "phase7a.py"),
        "0054": ("0054_ai_gateway_corrections.up.sql", "phase7a.py"),
        "0055": ("0055_ai_retrieval_citations.up.sql", "phase7b.py"),
        "0056": ("0056_ai_change_proposals.up.sql", "phase7d.py"),
        "0057": ("0057_ai_drafting_analysis.up.sql", "phase7c.py"),
        "0058": ("0058_ai_briefings.up.sql", "phase7e.py"),
        "0059": ("0059_planning_capture.up.sql", "phase7f.py"),
    }
    for k in later:
        name, validator = later_owned.get(k, (None, None))
        if by[k] != name or not os.path.isfile(P("docs/engineering/tools/%s" % validator)):
            errs.append("0052 must be the last Phase 6 migration; later ones must be held by a later-phase validator (%s)" % by[k])
    errs += phase1.check_migrations()[0]
    errs += phase1.check_boundaries([45, 46, 47, 48, 49, 50, 51, 52])
    adrs = os.listdir(P("docs/engineering/adr"))
    for num, slug in ADRS.items():
        if "%s-%s.md" % (num, slug) not in adrs:
            errs.append("ADR-%s-%s missing" % (num, slug))
        if len([a for a in adrs if a.startswith(num + "-")]) != 1:
            errs.append("ADR number %s must have exactly one file" % num)
    for path, anchors in ANCHORS.items():
        text = read(P(path))
        for a in anchors:
            if text.count('<a id="%s"></a>' % a) != 1:
                errs.append("%s must hold %s exactly once" % (path, a))
        last = max(int(x) for x in re.findall(r'<a id="[a-z]+-(\d+)"></a>', text))
        # Later phases add anchors held by their own validators: Phase 7A two per record (ADR-44/45,
        # AZ-44/45, PL-46/47), Phase 7B one (ADR-46, AZ-46, PL-48), Phase 7D one (ADR-47, AZ-47,
        # PL-49), Phase 7C one (ADR-48, AZ-48, PL-50), Phase 7E one (ADR-49, AZ-49, PL-51), and
        # Phase 7F one (ADR-50, AZ-50, PL-52).
        own = int(anchors[-1].split("-")[1])
        later_anchors = {"phase7a.py": 2, "phase7b.py": 1, "phase7d.py": 1, "phase7c.py": 1, "phase7e.py": 1,
                         "phase7f.py": 1}
        allowed = own + sum(n for v, n in later_anchors.items()
                            if os.path.isfile(P("docs/engineering/tools/%s" % v)))
        if last not in (own, allowed):
            errs.append("%s: %s must be the highest Phase 6 anchor (found %d)" % (path, anchors[-1], last))
    t = load(P("docs/architecture/access/policy/threats.json"))
    tids = [x["id"] for x in t["threats"]]
    aids = [x["id"] for x in t["tests"]]
    if len(set(tids)) != len(tids) or len(set(aids)) != len(aids):
        errs.append("threat and test identifiers must be unique")
    for ids, prefix, first in ((tids, "T-", FIRST_THREAT), (aids, "AT-", FIRST_TEST)):
        nums = [int(i[len(prefix):]) for i in ids]
        if nums != list(range(1, len(nums) + 1)):
            errs.append("%s identifiers must be contiguous from 1" % prefix)
        if max(nums) < first:
            errs.append("%s range for Phase 6 is missing" % prefix)
    known = set(tids)
    for x in t["tests"]:
        for th in x["threats"]:
            if th not in known:
                errs.append("%s names unknown threat %s" % (x["id"], th))
    titles = test_titles()
    for x in t["tests"]:
        n = int(x["id"][3:])
        if n >= 315 and x["id"] not in titles:
            errs.append("%s is registered but no test is titled with it" % x["id"])
    for at, where in titles.items():
        if int(at[3:]) >= 315 and at not in aids:
            errs.append("%s is used by %s but not registered in 0C" % (at, where[0]))
        if int(at[3:]) >= 315 and len(where) > 1:
            errs.append("%s titles more than one test (%s)" % (at, ", ".join(where)))
    return errs, "migrations 0045-0052, ADR-0032..0037, ADR-40..43, AZ-40..43, PL-42..45, T-%d..T-%s, AT-%d..%s" % (
        FIRST_THREAT, tids[-1][2:], FIRST_TEST, aids[-1][3:])


def check_composition():
    errs = []
    factory = read(P("packages/work/src/factory.ts"))
    if "return new McpAccessService(" not in factory and not _ai_head(factory):
        errs.append("createWorkService must return the top of the chain (McpAccessService or its 7A extension)")
    if "calendarProvider," not in factory or "new GoogleCalendarProvider(" not in factory:
        errs.append("the factory must build the configured calendar provider")
    chain = (("packages/work/src/integrations/service.ts", "export class IntegrationService extends ReportService"),
             ("packages/work/src/integrations/public-api-service.ts", "export class PublicApiService extends IntegrationService"),
             ("packages/work/src/integrations/calendar-service.ts", "export class CalendarService extends PublicApiService"),
             ("packages/work/src/portability/portability-service.ts", "export class PortabilityService extends CalendarService"),
             ("packages/work/src/integrations/mcp-access-service.ts", "export class McpAccessService extends PortabilityService"))
    for path, needle in chain:
        if needle not in read(P(path)):
            errs.append("%s must contain %s" % (path, needle))
    cal = read(P("packages/work/src/integrations/calendar-service.ts"))
    for hook in ("protected override async syncProviderData(", "protected override async externalBusy(",
                 "protected override async dayView(", "protected override async afterBlockMoved(",
                 "protected override async beforeBlockDeleted(", "protected override async resolveFieldConflict(",
                 "this.applyBlockMove("):
        if hook not in cal:
            errs.append("CalendarService lacks %s" % hook)
    routes = read(P("apps/api/src/work/routes.ts"))
    for n in ("registerPublicApi(app, work)", "registerIntegrations(app, work)", "registerCalendar(app, work)",
              "registerPortability(app, work)", "registerMcp(app, work)"):
        if n not in routes:
            errs.append("the API must register %s" % n)
    reg = read(P("apps/worker/src/registry.ts"))
    for n in ("integrationSyncHandler(m.integrations)", "webhookDeliveryHandler(m.integrations)",
              "new WebhookProjector(", "...INTEGRATION_SCHEDULES"):
        if n not in reg:
            errs.append("the worker must register %s" % n)
    # Corrective review 01: the webhook delivery boundary stays authorized at send, guarded, and
    # stoppable (ADR-0037 W1-W6).
    hooks = read(P("packages/work/src/integrations/public-api-service.ts"))
    for needle in ("const vis = await compileVisibility(", "WEBHOOK_TOMBSTONES.has(", "async pauseSubscription(",
                   "async resumeSubscription(", "const REPLAYABLE", "'test_required'", "#afterDelivery(",
                   "(sub.brand_id === null || sub.brand_id === (event.brand_id ?? null))"):
        if needle not in hooks:
            errs.append("webhook boundary lacks %s" % needle)
    # A completed key is rendered only through the command's own checks (corrective review 02).
    for needle in ("async #renderSubscription(", "async #renderDelivery("):
        if needle not in hooks:
            errs.append("webhook renderers lack %s" % needle)
    if "#subStateByPublic(" in hooks:
        errs.append("webhook renderers must not read state by public id without authority")
    if "if (row.aggregate_id) {" in hooks or "brandLevel(principal" in hooks:
        errs.append("webhook delivery must not authorize on brand access alone")
    public_routes = read(P("apps/api/src/public/routes.ts"))
    if "'pause', 'resume'" not in public_routes:
        errs.append("the API must route subscription pause and resume")
    server = read(P("packages/config/src/server.ts"))
    if "let calendar: CalendarProviderConfig = { provider: 'none' }" not in server:
        errs.append("calendar configuration must default to provider none")
    if "must use https outside local and test" not in server:
        errs.append("deployed calendar endpoints must be https only")
    verify = read(P("scripts/verify.sh"))
    pkg = read(P("package.json"))
    for v in ("phase6a.py", "phase6b.py", "phase6c.py", "phase6d.py", "phase6e.py", "phase6.py"):
        if "docs/engineering/tools/%s" % v not in verify:
            errs.append("verify.sh must run %s" % v)
    for v in ("validate:phase6a", "validate:phase6b", "validate:phase6c", "validate:phase6d", "validate:phase6e",
              'validate:phase6"'):
        if v not in pkg:
            errs.append("package.json lacks %s" % v)
    return errs, "service chain, hooks, routes, worker, configuration, wiring"


def closure_entries(path):
    c = load(P(path))
    return c, {r["id"]: r for r in c.get("requirements", [])}


def evidence_ok(e):
    path = P(e["file"])
    return os.path.isfile(path) and e["contains"] in read(path)


def check_closure():
    errs = []
    agg = load(P("docs/engineering/phase6/closure-6.json"))
    catalog = load(P("docs/product/requirements/catalog.json"))
    reqs = {r["id"]: r for r in catalog["requirements"]}
    subphases = phase1.roadmap_subphases()
    decisions = read(P("docs/product/open-decisions.md"))
    if agg.get("phase") != "6":
        errs.append("closure-6.json phase must be 6")
    owned_total = 0
    contributions = 0
    closed = {}
    for sub in SUBPHASES:
        path = agg.get("members", {}).get(sub)
        if path != "docs/engineering/phase6/closure-%s.json" % sub.lower():
            errs.append("closure-6.json must name the %s closure" % sub)
            continue
        c, entries = closure_entries(path)
        if c.get("phase") != sub:
            errs.append("%s closure has phase %r" % (sub, c.get("phase")))
        owned = sorted(r for r, x in reqs.items() if x["owner_subphase"] == sub)
        contrib = sorted(r for r, x in reqs.items()
                         if x["owner_subphase"] != sub and sub in x.get("contributing_subphases", []))
        owned_total += len(owned)
        contributions += len(contrib)
        for rid in owned:
            e = entries.get(rid)
            if not e:
                errs.append("%s owns %s but does not close it" % (sub, rid))
                continue
            closed.setdefault(rid, []).append(sub)
            if e.get("disposition") not in ("implemented", "foundation"):
                errs.append("%s: owned %s must be implemented or a recorded foundation" % (sub, rid))
            if not e.get("evidence") or not all(evidence_ok(x) for x in e["evidence"]):
                errs.append("%s: %s evidence is missing or does not match" % (sub, rid))
            if e.get("disposition") == "foundation":
                later = e.get("deferred_to") or []
                if not later:
                    errs.append("%s: foundation %s needs a deferral owner" % (sub, rid))
                for target in later:
                    od = re.findall(r"OD-\d{2}", target)
                    if target in subphases:
                        continue
                    if od and all(('<a id="%s"></a>' % o.lower()) in decisions for o in od):
                        continue
                    errs.append("%s: %s defers to %r, which is neither a subphase nor a recorded decision" % (sub, rid, target))
        for rid in contrib:
            e = entries.get(rid)
            if not e:
                errs.append("%s contributes to %s but does not record it" % (sub, rid))
                continue
            if e.get("disposition") != "contributed":
                errs.append("%s: contribution %s must be 'contributed'" % (sub, rid))
            if not e.get("evidence") or not all(evidence_ok(x) for x in e["evidence"]):
                errs.append("%s: contribution %s evidence is missing or does not match" % (sub, rid))
        for rid in entries:
            if rid not in owned and rid not in contrib:
                errs.append("%s closes %s, which it neither owns nor contributes to" % (sub, rid))
    for rid, subs in closed.items():
        if len(subs) != 1:
            errs.append("%s is closed by %s; an owner closes it exactly once" % (rid, ", ".join(subs)))
    # Recorded boundaries: kept exactly as recorded, never invented or dropped.
    bounds = {b["id"]: b for b in agg.get("boundaries", [])}
    _, d6 = closure_entries("docs/engineering/phase6/closure-6d.json")
    if "OD-33" not in json.dumps(d6.get("DATA-010", {})) or bounds.get("DATA-010", {}).get("decision") != "OD-33":
        errs.append("DATA-010 must stay incremental under OD-33")
    if (d6.get("DATA-013", {}).get("deferred_to") or []) != ["7A", "8A", "8B"]:
        errs.append("DATA-013 must stay deferred to 7A/8A/8B")
    if "10A" not in d6.get("AUD-009", {}).get("note", ""):
        errs.append("AUD-009 must keep the commercial entitlement with 10A")
    od29 = decisions.split("### OD-29")[1][:900] if "### OD-29" in decisions else ""
    if "Still open" not in od29 or bounds.get("CAP-006", {}).get("decision") != "OD-29":
        errs.append("CAP-006 must stay unresolved under OD-29")
    if reqs["CAP-006"]["owner_subphase"] != "2E":
        errs.append("CAP-006 ownership changed; it is recorded under 2E")
    # 6C corrections: no behavior is closed on a reserved column or prose alone.
    _, c6 = closure_entries("docs/engineering/phase6/closure-6c.json")
    for rid, hollow in HOLLOW:
        ev = c6.get(rid, {}).get("evidence", [])
        if ev and all(hollow in x["contains"] for x in ev):
            errs.append("6C %s is closed only on %r" % (rid, hollow))
        if ev and not any(x["file"].endswith((".ts", ".tsx")) for x in ev):
            errs.append("6C %s needs code or test evidence" % rid)
    for e in agg.get("evidence", []):
        if not evidence_ok(e):
            errs.append("evidence missing: %s %r" % (e["file"], e["contains"]))
    if not agg.get("evidence"):
        errs.append("closure-6.json lists no evidence")
    return errs, "%d owned closed once, %d contributions, %d boundaries, %d evidence items" % (
        owned_total, contributions, len(bounds), len(agg.get("evidence", [])))


def main():
    sections = [
        ("phase 6: every Phase 0-6E validator passes", check_validators()),
        ("phase 6: one owner for every migration, ADR, and identifier", check_numbering()),
        ("phase 6: service chain and wiring compose", check_composition()),
        ("phase 6: aggregate closure, boundaries, and corrections", check_closure()),
    ]
    failed = 0
    for name, (errs, detail) in sections:
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 6 AGGREGATE CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
