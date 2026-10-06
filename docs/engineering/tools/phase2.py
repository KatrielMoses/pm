#!/usr/bin/env python3
"""Phase 2 closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase2.py      # exit 1 on any failure

Checks that the Phase 2A closure map (docs/engineering/phase2/closure.json) covers every catalog
requirement 2A owns or contributes to and every architecture decision of the Phase 2A brief, that each
entry cites existing evidence, and that 2A runtime surfaces have not drifted from the decisions:
one collaborator authority (no project-member table), the five platform statuses, registered and
configured bounds, the one-type sharing registry, decision kinds and states, the append-only
verification fact, the reversible phase lifecycle, template layering, the lifecycle issuer boundary,
no followers, and event and error registration across the work, relations, templates, and planning
modules.

Phase 2B (docs/engineering/phase2/closure-2b.json) is checked by the same closure rules plus its own
drift checks: the six task statuses, task bounds and the depth ceiling 64, the two-type sharing
registry, history over the audit ledger (no history table), no follower rows, the brand-move
definer as the only brand change, and task and label event registration.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1  # noqa: E402  (shared helpers: read, load, adr_path, justifies, migrations, config)

P = phase1.P
read = phase1.read
load = phase1.load
SUBPHASE = "2A"
DISPOSITIONS = {"implemented", "foundation", "contributed"}
DECISION_IDS = ["D%d" % i for i in range(1, 19)]
# Pre-commit review 01: every reviewed item has exactly this disposition.
DISPOSITION_IDS = {"G1": "corrected", "G2": "accepted", "G3": "corrected", "G4": "accepted", "G5": "corrected",
                   "G6": "accepted", "G7": "accepted", "G8": "accepted", "G9": "accepted", "P17": "accepted"}
STATUSES = [("planned", "planned"), ("active", "active"), ("on_hold", "paused"), ("completed", "done"), ("cancelled", "cancelled")]
BOUNDS = {"PROJECT_DEPTH_MAX": ("projectDepthMax", 10), "TEMPLATE_ITEMS_MAX": ("templateItemsMax", 500), "RECURRENCE_CATCHUP_MAX": ("recurrenceCatchupMax", 12),
          "RECURRENCE_WORKSPACE_DISCOVERY_MAX": ("recurrenceWorkspaceDiscoveryMax", 200), "RECURRENCE_SERIES_DISCOVERY_MAX": ("recurrenceSeriesDiscoveryMax", 50)}
SECTIONS = ["overview", "tasks", "timeline", "calendar", "documents", "files", "activity", "time", "costs", "reports", "settings", "tests", "releases"]
MIGRATIONS = ["packages/db/migrations/0021_work_projects.up.sql", "packages/db/migrations/0022_project_relations_templates_recurrence.up.sql"]
ADR_STATUS = re.compile(r"^Status: \*\*(accepted and implemented|proposed)\*\*", re.M)


def adr_ref_ok(ref, candidate):
    """Like Phase 1, but the Phase 2A ADR may be `proposed` while the closure is a candidate."""
    m = re.fullmatch(r"adr:(\d{4})(?:#([A-Z]\d{1,2}))?", ref)
    if not m:
        return "malformed ADR reference"
    path = phase1.adr_path(m.group(1))
    if not path:
        return "no ADR %s" % m.group(1)
    text = read(path)
    accepted = re.search(r"^Status: (\*\*)?accepted", text, re.M)
    proposed = re.search(r"^Status: \*\*proposed\*\*", text, re.M)
    if not accepted and not (candidate and proposed):
        return "ADR %s is not accepted" % m.group(1)
    if m.group(2) and not re.search(r"^\| %s \|" % re.escape(m.group(2)), text, re.M):
        return "ADR %s has no row %s" % (m.group(1), m.group(2))
    return None


def check_evidence(owner, items, cache, errs):
    if not items:
        errs.append("%s: no evidence" % owner)
    for ev in items:
        path = P(ev["file"])
        if not os.path.isfile(path):
            errs.append("%s: evidence file missing: %s" % (owner, ev["file"]))
            continue
        text = cache.setdefault(path, read(path))
        if ev["contains"] not in text:
            errs.append("%s: %s does not contain %r" % (owner, ev["file"], ev["contains"]))


def check_closure(catalog, closure, subphases, SUBPHASE=SUBPHASE, DECISION_IDS=DECISION_IDS):
    errs = []
    candidate = closure.get("status") == "candidate"
    if closure.get("phase") != SUBPHASE:
        errs.append("closure phase must be %s" % SUBPHASE)
    if closure.get("status") not in ("candidate", "accepted"):
        errs.append("closure status must be candidate or accepted")
    reqs = {r["id"]: r for r in catalog["requirements"]}
    owned = {i for i, r in reqs.items() if r.get("owner_subphase") == SUBPHASE}
    contributing = {i for i, r in reqs.items() if i not in owned and SUBPHASE in r.get("contributing_subphases", [])}
    seen = {}
    for e in closure["requirements"]:
        if e["id"] in seen:
            errs.append("%s: listed twice" % e["id"])
        seen[e["id"]] = e
    for i in sorted(owned - set(seen)):
        errs.append("%s: %s-owned requirement has no closure entry" % (i, SUBPHASE))
    for i in sorted(contributing - set(seen)):
        errs.append("%s: %s contribution has no closure entry" % (i, SUBPHASE))
    for i in sorted(set(seen) - owned - contributing):
        errs.append("%s: closure entry for a requirement %s neither owns nor contributes to" % (i, SUBPHASE))
    cache = {}
    for e in closure["requirements"]:
        i, r = e["id"], reqs.get(e["id"])
        if r is None:
            continue
        disp = e.get("disposition")
        if disp not in DISPOSITIONS:
            errs.append("%s: unknown disposition %r" % (i, disp))
            continue
        role = "owned" if i in owned else "contributing"
        if e.get("role") != role:
            errs.append("%s: role %r, catalog says %s" % (i, e.get("role"), role))
        if role == "owned" and disp == "contributed":
            errs.append("%s: an owned requirement cannot be only 'contributed'" % i)
        if role == "contributing" and (disp != "contributed" or e.get("contribution") != SUBPHASE):
            errs.append("%s: a contribution must be 'contributed' with contribution %s" % (i, SUBPHASE))
        check_evidence(i, e.get("evidence"), cache, errs)
        later = (e.get("enriched_by") or []) + (e.get("deferred_to") or [])
        if disp == "foundation" and not e.get("deferred_to"):
            errs.append("%s: a foundation disposition needs deferred_to" % i)
        accepted = e.get("accepted_by") or []
        if later and not accepted:
            errs.append("%s: enriched_by/deferred_to need accepted_by" % i)
        for s in later:
            if s not in subphases:
                errs.append("%s: %s is not a BUILD_ROADMAP subphase" % (i, s))
            elif s == SUBPHASE:
                errs.append("%s: %s cannot be deferred to itself" % (i, s))
            elif not any(phase1.justifies(ref, s, r, reqs) for ref in accepted):
                errs.append("%s: no accepted_by source names %s" % (i, s))
        for ref in accepted:
            if ref.startswith("adr:"):
                bad = adr_ref_ok(ref, candidate)
                if bad:
                    errs.append("%s: %s: %s" % (i, ref, bad))
            elif ref != "catalog:contributing" and not ref.startswith(("requirement:", "roadmap:")):
                errs.append("%s: unknown accepted_by kind %r" % (i, ref))
    decisions = {d["id"]: d for d in closure.get("decisions", [])}
    if sorted(decisions, key=lambda x: int(x[1:])) != DECISION_IDS:
        errs.append("decisions must be exactly %s..%s (the Phase %s brief's architecture decisions)" % (DECISION_IDS[0], DECISION_IDS[-1], SUBPHASE))
    for d in decisions.values():
        check_evidence(d["id"] + " sources", d.get("sources"), cache, errs)
        check_evidence(d["id"], d.get("evidence"), cache, errs)
    counts = {}
    for e in closure["requirements"]:
        counts[e.get("disposition")] = counts.get(e.get("disposition"), 0) + 1
    detail = "%d owned, %d contributions, %d decisions; %s" % (
        len(owned), len(contributing), len(decisions), ", ".join("%s %d" % kv for kv in sorted(counts.items())))
    return errs, detail


def migrations_text():
    return "\n".join(read(P(m)) for m in MIGRATIONS)


def check_one_authority(model):
    errs = []
    names = {e["name"] for e in model["entities"]}
    if "project_member" in names:
        errs.append("model.json still has project_member (project-scoped role assignments are the only collaborator authority)")
    sql = migrations_text()
    if re.search(r"CREATE TABLE \w+\.project_member\b", sql):
        errs.append("a migration creates a project_member table")
    if "project_scope_id" not in sql or "project_manager_on_assignment" not in sql:
        errs.append("project-scoped role assignments or the last-manager guard are missing")
    for e in ("project_update", "project_update_verification", "scope_item", "decision_record", "phase"):
        if e not in names:
            errs.append("model.json lacks %s" % e)
    phase = next((e for e in model["entities"] if e["name"] == "phase"), {})
    if phase.get("lifecycle") != "full" or "archive" not in phase.get("purpose", ""):
        errs.append("phase must carry the full lifecycle with reversible archive (decision D8)")
    return errs, "role assignments only; structures registered"


def check_statuses():
    errs = []
    sql = read(P(MIGRATIONS[0]))
    m = re.search(r"INSERT INTO workflow\.platform_status \([^)]*\) VALUES(.*?);", sql, re.S)
    rows = re.findall(r"\('([0-9a-f-]{36})', 'project', '(\w+)', '[^']+', '(\w+)', (\d)\)", m.group(1)) if m else []
    if [(k, c) for _, k, c, _ in rows] != STATUSES:
        errs.append("platform statuses drifted from the five seeded defaults: %r" % [(k, c) for _, k, c, _ in rows])
    shell = read(P("packages/contracts/src/shell.ts"))
    for sid, key, cat, _ in rows:
        if not re.search(r"key: '%s'[^}]*category: '%s'" % (key, cat), shell) or sid not in read(P("packages/work/src/workflow/statuses.ts")):
            errs.append("status %s (%s) is not the same in contracts and the work service" % (key, sid))
    return errs, "%d platform statuses" % len(rows)


def check_bounds(registry):
    errs = []
    params = {p["name"] for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    env = read(P("docs/engineering/environments.md"))
    validation = read(P("packages/work/src/validation.ts"))
    for name, (field, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s is not a 0D parameter" % name)
        if not re.search(r"\b%s: '%d'" % (name, default), server):
            errs.append("%s default in the configuration is not %d" % (name, default))
        if name not in env:
            errs.append("%s is not documented in environments.md" % name)
        if not re.search(r"%s: %s\b" % (field, "{:_}".format(default).replace(",", "_")), validation) and not re.search(r"%s: %d\b" % (field, default), validation):
            errs.append("DEFAULT_WORK_SETTINGS.%s is not %d" % (field, default))
    if "PROJECT_DEPTH_CEILING = 32" not in validation or "CHECK (depth BETWEEN 0 AND 32)" not in read(P(MIGRATIONS[0])):
        errs.append("the depth ceiling 32 must match in the service and the database")
    if not re.search(r"item_count BETWEEN 1 AND 500|item_count <= 500", read(P(MIGRATIONS[1]))):
        errs.append("template_version.item_count is not bounded by 500 in the database")
    return errs, ", ".join(BOUNDS)


def check_sharing_registry():
    errs = []
    text = read(P("packages/tenancy/src/sharing.ts"))
    m = re.search(r"SHAREABLE_RECORD_TYPES[^=]*= new Map\(\[(.*?)\]\);", text, re.S)
    types = re.findall(r"\['(\w+)', \[", m.group(1)) if m else []
    if types != ["project", "task"]:
        errs.append("the shareability registry must hold exactly 'project' and 'task' (found %r)" % types)
    for t in types:
        if m and "['%s', ['read', 'comment', 'edit'] as const]" % t not in m.group(1):
            errs.append("%s share levels must be read (API view), comment, edit" % t)
    return errs, "shareable: %s" % ", ".join(types)


def check_decision_kinds():
    errs = []
    sql = read(P(MIGRATIONS[0]))
    if "kind IN ('decision', 'open_question')" not in sql:
        errs.append("decision_record kinds drifted")
    for state in ("proposed", "decided", "superseded", "open", "resolved"):
        if "'%s'" % state not in sql:
            errs.append("decision_record state %s missing" % state)
    if "decision_record_state_for_kind" not in sql:
        errs.append("cross-kind states are not refused by the database")
    if re.search(r"CREATE TABLE work\.decision\b", sql):
        errs.append("a parallel work.decision table exists (use work.decision_record)")
    return errs, "decision|open_question"


def check_append_only():
    """No role may update an update or a verification; only the worker's purge hook may delete them."""
    errs = []
    sql = migrations_text()
    for table in ("work.project_update", "work.project_update_verification"):
        for m in re.finditer(r"GRANT ([^;]*?) ON ([^;]*?) TO ([^;]+);", sql):
            privs, objs, role = m.group(1), m.group(2), m.group(3).strip()
            if not re.search(r"(^|[\s,])%s($|[\s,])" % re.escape(table), objs):
                continue
            if re.search(r"\b(UPDATE|ALL)\b", privs) or (re.search(r"\bDELETE\b", privs) and role != "app_worker"):
                errs.append("%s must stay append-only (found GRANT %s TO %s)" % (table, privs.strip(), role))
    return errs, "no UPDATE; DELETE only for purge"


def check_layering(model):
    errs = []
    deps = {m["id"]: m["depends_on"] for m in model["modules"]}
    for mod in ("work", "planning", "relations", "workflow"):
        if "templates" in deps.get(mod, []):
            errs.append("module %s must not depend on templates (OD-14 layering)" % mod)
    if "work" not in deps.get("templates", []):
        errs.append("templates must depend on work")
    for m in re.finditer(r"CREATE TABLE (\w+)\.(\w+) \((.*?)\n\);", migrations_text(), re.S):
        if m.group(1) != "templates" and "REFERENCES templates." in m.group(3):
            errs.append("%s.%s references a templates table" % (m.group(1), m.group(2)))
    for f in ("service.ts", "jobs.ts", "recurrence.ts"):
        if re.search(r"templates\.(template|template_version)'", read(P("packages/work/src", f))):
            errs.append("packages/work/src/%s touches templates tables (only the template catalog may)" % f)
    return errs, "templates → work; work/planning ↛ templates"


def check_issuer():
    errs = []
    routes = read(P("apps/api/src/work/routes.ts"))
    if "@pm/lifecycle" in routes:
        errs.append("work routes import @pm/lifecycle directly")
    for dirpath, _dirs, files in os.walk(P("packages/work/src")):
        for n in files:
            text = read(os.path.join(dirpath, n))
            if "policy-issuer" in text or "issueLifecycleDecision(" in text:
                errs.append("packages/work/src/%s mints lifecycle decisions" % n)
    if "issueRecordLifecycleDecision" not in read(P("packages/tenancy/src/record-decisions.ts")):
        errs.append("tenancy no longer exports the record lifecycle issuer")
    return errs, "tenancy-issued decisions only"


def check_no_followers(model):
    errs = []
    if any("follower" in e["name"] for e in model["entities"] if e.get("module") == "work"):
        errs.append("work registers a follower entity (followers are 4A)")
    if re.search(r"CREATE TABLE \w+\.\w*follower", migrations_text()):
        errs.append("a 2A migration creates a follower table")
    return errs, "none"


def check_sections():
    errs = []
    text = read(P("packages/contracts/src/shell.ts"))
    m = re.search(r"export const PROJECT_SECTIONS = \[(.*?)\] as const", text, re.S)
    rows = re.findall(r"key: '(\w+)'[^}]*conditional: (true|false)", m.group(1)) if m else []
    if [k for k, _ in rows] != SECTIONS:
        errs.append("project sections drifted from the fixed order: %r" % [k for k, _ in rows])
    if [k for k, c in rows if c == "true"] != ["tests", "releases"]:
        errs.append("only Tests and Releases may be conditional")
    return errs, "%d sections" % len(rows)


def check_error_codes(registry):
    codes = {c["code"] for c in registry["error_codes"]}
    errs, found = [], 0
    for dirpath, _dirs, files in os.walk(P("packages/work/src")):
        for n in files:
            text = read(os.path.join(dirpath, n))
            for m in re.finditer(r"TenancyError\('([a-z_]+)'", text):
                found += 1
                if m.group(1) not in codes:
                    errs.append("packages/work/src/%s: %r is not a 0D error code" % (n, m.group(1)))
    return errs, "%d error literals" % found


def check_events(registry):
    events = {e["type"] for e in registry["events"]}
    errs, found = [], 0
    pattern = re.compile(r"'((?:work|relations|templates|planning)\.[a-z_]+\.[a-z_]+)'")
    for base in ("packages/work/src", "apps/api/src/work", "apps/worker/src"):
        for dirpath, _dirs, files in os.walk(P(base)):
            for n in files:
                text = read(os.path.join(dirpath, n))
                rel = os.path.relpath(os.path.join(dirpath, n), phase1.ROOT)
                for m in pattern.finditer(text):
                    name = m.group(1)
                    if name.startswith(("work.project.", "work.phase.", "work.milestone.", "work.decision_record.",
                                        "work.project_update.", "relations.relationship.", "templates.template.",
                                        "planning.recurrence_series.", "planning.occurrence.")):
                        found += 1
                        if name not in events:
                            errs.append("%s: event %r is not registered in 0D" % (rel, name))
    return errs, "%d event literals" % found


def check_adr():
    path = phase1.adr_path("0013")
    if not path:
        return ["ADR-0013 missing"], ""
    text = read(path)
    m = ADR_STATUS.search(text)
    if not m:
        return ["ADR-0013 status must be **proposed** or **accepted and implemented**"], ""
    closure = load(P("docs/engineering/phase2/closure.json"))
    if closure.get("status") == "accepted" and m.group(1) != "accepted and implemented":
        return ["closure is accepted but ADR-0013 is not"], ""
    return [], "ADR-0013 %s" % m.group(1)


def check_dispositions(closure):
    """Each reviewed item carries the architect's disposition, stated in ADR-0013, with evidence."""
    errs, cache = [], {}
    adr = read(phase1.adr_path("0013"))
    got = {d["id"]: d for d in closure.get("dispositions", [])}
    if set(got) != set(DISPOSITION_IDS):
        errs.append("dispositions must be exactly %s" % ", ".join(sorted(DISPOSITION_IDS)))
    for i, want in DISPOSITION_IDS.items():
        d = got.get(i)
        if not d:
            continue
        if d.get("disposition") != want:
            errs.append("%s: disposition %r, review decided %r" % (i, d.get("disposition"), want))
        row = re.search(r"^\| %s \|.*$" % re.escape(i), adr[adr.find("## Dispositions"):], re.M)
        if not row or d.get("adr_contains", "\0") not in row.group(0):
            errs.append("%s: ADR-0013 dispositions row does not state %r" % (i, d.get("adr_contains")))
        check_evidence(i, d.get("evidence"), cache, errs)
    if re.search(r"^## Deviations", adr, re.M):
        errs.append("ADR-0013 still lists open deviations")
    return errs, "%d dispositions" % len(got)


def check_rich_description(registry):
    """G1: canonical rich storage, validated at the API and the database; no plain-text column."""
    errs = []
    sql = read(P(MIGRATIONS[0]))
    body = re.search(r"CREATE TABLE work\.project \((.*?)\n\);", sql, re.S)
    if not body or "description_rich jsonb" not in body.group(1) or re.search(r"^\s+description text", body.group(1), re.M):
        errs.append("work.project must store description_rich jsonb and no plain-text description")
    if "CHECK (tenancy.valid_rich_text(description_rich, 20000))" not in sql:
        errs.append("work.project.description_rich lacks the database rich-text check")
    if not os.path.isfile(P("docs/architecture/platform/contracts/schemas/rich-text.schema.json")):
        errs.append("0D rich-text schema missing")
    if "validateRichText" not in read(P("packages/work/src/validation.ts")):
        errs.append("the API does not validate rich text")
    for f in ("templates.ts", "instantiate.ts"):
        if "description_rich" not in read(P("packages/work/src", f)):
            errs.append("packages/work/src/%s does not carry description_rich" % f)
    return errs, "description_rich jsonb, version 1"


def check_discovery_bounds(registry):
    """G3: registered, configured, injected; no literal discovery batch sizes."""
    errs = []
    params = {p["name"] for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    for name, default, lo, hi in (("RECURRENCE_WORKSPACE_DISCOVERY_MAX", 200, 1, 1000), ("RECURRENCE_SERIES_DISCOVERY_MAX", 50, 1, 500)):
        if name not in params:
            errs.append("%s is not a 0D parameter" % name)
        if "%s: '%d'" % (name, default) not in server or "%s: int(%d, %d)" % (name, lo, hi) not in server:
            errs.append("%s must default to %d with range %d..%d" % (name, default, lo, hi))
        if name not in read(P("docs/engineering/environments.md")):
            errs.append("%s is not documented in environments.md" % name)
    jobs = read(P("packages/work/src/jobs.ts"))
    if re.search(r"discoverRecurrenceDue\([^)]*\b\d+\)|\.limit\(\d+\)", jobs):
        errs.append("recurrence discovery uses a literal batch size")
    for field in ("recurrenceWorkspaceDiscoveryMax", "recurrenceSeriesDiscoveryMax"):
        if "settings.%s" % field not in jobs:
            errs.append("the recurrence job does not use settings.%s" % field)
    if "orderBy('last_run_at')" not in jobs or "ORDER BY min(s.last_run_at)" not in read(P(MIGRATIONS[1])):
        errs.append("recurrence discovery is not oldest-waiting first at both layers")
    return errs, "workspace and series discovery bounds"


def check_recurrence_ui():
    """G5: the owned recurrence UI offers every frequency and the full rule."""
    errs = []
    ui = read(P("apps/web/src/pages/project-pages.tsx"))
    for f in ("daily", "weekly", "monthly", "yearly"):
        if "{ value: '%s'" % f not in ui:
            errs.append("recurrence UI does not offer %s" % f)
    for needle in ("rc-interval", "rc-weekdays", "rc-monthday", "rc-start", "rc-tz", "rc-count", "rc-until", "'pause'", "'generate'"):
        if needle not in ui:
            errs.append("recurrence UI lacks %s" % needle)
    return errs, "four frequencies, interval, days, zone, end condition"


def check_share_boundary():
    """G2: share-only readers get criteria, scope, and the latest verified update only."""
    errs = []
    st = read(P("packages/work/src/structures.ts"))
    if "{ id: latestVerified.public_id, body: latestVerified.body }" not in st:
        errs.append("share-only latest verified update is not limited to id and body")
    if "(own ? updates : [])" not in st:
        errs.append("share-only readers can see update history")
    if "opts.shares === false && project.ownLevel === null" not in read(P("packages/work/src/service.ts")):
        errs.append("share-excluded commands do not return not_found to share-only readers")
    return errs, "project, criteria, scope, latest verified update"


# ---- Phase 2B -----------------------------------------------------------------------------------

TASK_STATUSES = [("backlog", "planned"), ("todo", "planned"), ("in_progress", "active"), ("blocked", "paused"), ("done", "done"), ("cancelled", "cancelled")]
TASK_BOUNDS = {"TASK_DEPTH_MAX": ("taskDepthMax", 20), "TASK_SUBTREE_MAX": ("taskSubtreeMax", 500), "TASK_ITEMS_MAX": ("taskItemsMax", 200),
               "TASK_ASSIGNEES_MAX": ("taskAssigneesMax", 20), "TASK_LABELS_MAX": ("taskLabelsMax", 50), "BRAND_LABELS_MAX": ("brandLabelsMax", 1000),
               "TASK_ESTIMATE_MINUTES_MAX": ("taskEstimateMinutesMax", 100000)}
MIGRATIONS_2B = ["packages/db/migrations/0023_work_tasks.up.sql", "packages/db/migrations/0024_task_relationships_sharing.up.sql"]


def migrations_2b():
    return "\n".join(read(P(m)) for m in MIGRATIONS_2B)


def check_task_statuses():
    errs = []
    sql = read(P(MIGRATIONS_2B[0]))
    m = re.search(r"INSERT INTO workflow\.platform_status \([^)]*\) VALUES(.*?);", sql, re.S)
    rows = re.findall(r"\('([0-9a-f-]{36})', 'task', '(\w+)', '[^']+', '(\w+)', (\d)\)", m.group(1)) if m else []
    if [(k, c) for _, k, c, _ in rows] != TASK_STATUSES:
        errs.append("task statuses drifted from the six seeded defaults: %r" % [(k, c) for _, k, c, _ in rows])
    shell = read(P("packages/contracts/src/shell.ts"))
    core = read(P("packages/work/src/workflow/statuses.ts"))
    for sid, key, cat, _ in rows:
        if not re.search(r"key: '%s'[^}]*category: '%s'" % (key, cat), shell) or sid not in core:
            errs.append("task status %s (%s) is not the same in contracts and the task service" % (key, sid))
    return errs, "%d task statuses" % len(rows)


def check_task_bounds(registry):
    errs = []
    params = {p["name"] for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    env = read(P("docs/engineering/environments.md"))
    validation = read(P("packages/work/src/validation.ts"))
    for name, (field, default) in TASK_BOUNDS.items():
        if name not in params:
            errs.append("%s is not a 0D parameter" % name)
        if not re.search(r"\b%s: '%d'" % (name, default), server):
            errs.append("%s default in the configuration is not %d" % (name, default))
        if name not in env:
            errs.append("%s is not documented in environments.md" % name)
        if not re.search(r"%s: %s\b" % (field, "{:_}".format(default).replace(",", "_")), validation) and not re.search(r"%s: %d\b" % (field, default), validation):
            errs.append("DEFAULT_WORK_SETTINGS.%s is not %d" % (field, default))
    if "TASK_DEPTH_CEILING = 64" not in validation or "CHECK (depth BETWEEN 0 AND 64)" not in read(P(MIGRATIONS_2B[0])):
        errs.append("the task depth ceiling 64 must match in the service and the database")
    if "TASK_DEPTH_MAX: int(1, 64)" not in server:
        errs.append("TASK_DEPTH_MAX must never be configurable above the database ceiling 64")
    return errs, ", ".join(TASK_BOUNDS)


def check_task_history_and_followers(model):
    """History is the audit ledger (decision D14); followers are 4A (TSK-009 contribution only)."""
    errs = []
    sql = migrations_2b()
    if re.search(r"CREATE TABLE \w+\.\w*history", sql):
        errs.append("a 2B migration creates a history table (history is a projection of the audit ledger)")
    if re.search(r"CREATE TABLE \w+\.\w*follower", sql):
        errs.append("a 2B migration creates a follower table (followers are 4A)")
    if any("history" in e["name"] or "follower" in e["name"] for e in model["entities"] if e.get("module") == "work"):
        errs.append("work registers a history or follower entity")
    if "audit.audit_event" not in read(P("packages/work/src/task-items.ts")):
        errs.append("task history no longer reads the audit ledger")
    return errs, "audit projection; no followers"


def check_brand_move():
    """Only the definer changes a task's brand; the guard exception names it; links stay https-only."""
    errs = []
    sql = read(P(MIGRATIONS_2B[1]))
    if not re.search(r"CREATE FUNCTION work\.move_task_brand\(.*?SECURITY DEFINER", sql, re.S | re.I):
        errs.append("work.move_task_brand must be a security definer")
    if "CREATE OR REPLACE FUNCTION core.record_guard" not in sql:
        errs.append("0024 does not carry the record guard brand-move exception")
    if "CREATE OR REPLACE FUNCTION core.record_guard" in read(P(MIGRATIONS_2B[0])):
        errs.append("0023 must not change the record guard")
    if "https://" not in sql:
        errs.append("record_link must be https-only in the database")
    items = read(P("packages/work/src/task-items.ts"))
    if "LINK_TARGET_TYPES: ReadonlySet<string> = new Set<string>([])" not in items:
        errs.append("record-target link types changed; register them through an ADR first")
    return errs, "definer-only brand change; https links"


def check_task_events(registry):
    events = {e["type"] for e in registry["events"]}
    errs, found = [], 0
    pattern = re.compile(r"'((?:work)\.(?:task|label|task_label|checklist_item)\.[a-z_]+)'")
    for base in ("packages/work/src", "apps/api/src/work"):
        for dirpath, _dirs, files in os.walk(P(base)):
            for n in files:
                text = read(os.path.join(dirpath, n))
                rel = os.path.relpath(os.path.join(dirpath, n), phase1.ROOT)
                for m in pattern.finditer(text):
                    if m.group(1) in ("work.task.completions", "work.task.moves"):
                        continue
                    found += 1
                    if m.group(1) not in events:
                        errs.append("%s: event %r is not registered in 0D" % (rel, m.group(1)))
    for t in ("work.task.moves", "work.task.completions"):
        if t not in {x["name"] for x in registry["telemetry"]}:
            errs.append("%s is not registered telemetry" % t)
    return errs, "%d event literals" % found


def check_adr_2b(closure):
    path = phase1.adr_path("0014")
    if not path:
        return ["ADR-0014 missing"], ""
    text = read(path)
    m = ADR_STATUS.search(text)
    if not m:
        return ["ADR-0014 status must be **proposed** or **accepted and implemented**"], ""
    if closure.get("status") == "accepted" and m.group(1) != "accepted and implemented":
        return ["closure is accepted but ADR-0014 is not"], ""
    errs = []
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0014 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0014 %s" % m.group(1)

# ---- Phase 2C -----------------------------------------------------------------------------------

MIGRATIONS_2C = ["packages/db/migrations/0025_workflow_configuration.up.sql", "packages/db/migrations/0026_custom_fields.up.sql"]
WORKFLOW_BOUNDS = {"WORKFLOW_STATUSES_MAX": ("workflowStatusesMax", 50), "WORKFLOW_TRANSITIONS_MAX": ("workflowTransitionsMax", 400),
                   "TRANSITION_REQUIREMENTS_MAX": ("transitionRequirementsMax", 30), "TRANSITION_APPROVERS_MAX": ("transitionApproversMax", 10),
                   "APPROVAL_EXPIRY_HOURS": ("approvalExpiryHours", 168), "TRANSITION_PREVIEW_TTL_SECONDS": ("transitionPreviewTtlSeconds", 600),
                   "FIELD_DEFINITIONS_MAX": ("fieldDefinitionsMax", 200), "FIELD_OPTIONS_MAX": ("fieldOptionsMax", 200),
                   "FIELD_SETS_MAX": ("fieldSetsMax", 100), "FIELD_SET_ITEMS_MAX": ("fieldSetItemsMax", 100), "FIELD_TEXT_MAX": ("fieldTextMax", 5000),
                   "FIELD_PATTERN_MAX": ("fieldPatternMax", 200), "FORMULA_SOURCE_MAX": ("formulaSourceMax", 2000),
                   "FORMULA_AST_NODES_MAX": ("formulaAstNodesMax", 200), "FORMULA_DEPTH_MAX": ("formulaDepthMax", 8),
                   "FORMULA_REFS_MAX": ("formulaRefsMax", 20), "FIELD_VALUE_BULK_MAX": ("fieldValueBulkMax", 500)}
FIELD_TYPES = ["text", "number", "currency", "percentage", "date", "person", "label", "checkbox", "url", "email", "select", "formula"]


def migrations_2c():
    return "\n".join(read(P(m)) for m in MIGRATIONS_2C)


def check_one_workflow_system():
    """W1/W3: no second status table, platform statuses never copied, records' statuses guarded."""
    errs = []
    sql = migrations_2c()
    tables = re.findall(r"CREATE TABLE (\w+\.\w+)", sql)
    for t in tables:
        if "status" in t and t != "workflow.workflow_status":
            errs.append("a second status table: %s" % t)
    if "INSERT INTO workflow.platform_status" in sql:
        errs.append("2C migrations copy or add platform statuses")
    up = read(P(MIGRATIONS_2C[0]))
    for need in ("DROP CONSTRAINT task_status_id_fkey", "DROP CONSTRAINT project_status_id_fkey", "CREATE TRIGGER workflow_status_guard",
                 "workflow.status_offered('task'", "workflow.status_offered('project'", "workflow_one_active"):
        if need not in up:
            errs.append("0025 lacks %s" % need)
    return errs, "%d tables; statuses guarded" % len(tables)


def check_workflow_bounds(registry):
    errs = []
    params = {p["name"] for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    env = read(P("docs/engineering/environments.md"))
    validation = read(P("packages/work/src/validation.ts"))
    for name, (field, default) in WORKFLOW_BOUNDS.items():
        if name not in params:
            errs.append("%s is not a 0D parameter" % name)
        if not re.search(r"\b%s: '%d'" % (name, default), server):
            errs.append("%s default in the configuration is not %d" % (name, default))
        if name not in env:
            errs.append("%s is not documented in environments.md" % name)
        if not re.search(r"%s: %s\b" % (field, "{:_}".format(default).replace(",", "_")), validation) and not re.search(r"%s: %d\b" % (field, default), validation):
            errs.append("DEFAULT_WORK_SETTINGS.%s is not %d" % (field, default))
    return errs, "%d bounds" % len(WORKFLOW_BOUNDS)


def check_field_types():
    """W10: the twelve types agree in the database, the service, and the web client."""
    errs = []
    sql = read(P(MIGRATIONS_2C[1]))
    m = re.search(r"field_definition_type_known CHECK \(field_type IN \((.*?)\)\)", sql, re.S)
    db = re.findall(r"'(\w+)'", m.group(1)) if m else []
    if db != FIELD_TYPES:
        errs.append("database field types drifted: %r" % db)
    svc = read(P("packages/work/src/workflow/field-types.ts"))
    m2 = re.search(r"export const FIELD_TYPES = \[(.*?)\] as const", svc, re.S)
    if not m2 or re.findall(r"'(\w+)'", m2.group(1)) != FIELD_TYPES:
        errs.append("service field types drifted")
    web = read(P("apps/web/src/workflow/client.ts"))
    for t in FIELD_TYPES:
        if not re.search(r"\b%s: '" % t, web):
            errs.append("web client lacks a label for %s" % t)
    return errs, "%d types" % len(FIELD_TYPES)


def check_formula_safety():
    """W17: no dynamic code anywhere in the workflow engine; the registry is closed."""
    errs = []
    base = P("packages/work/src/workflow")
    for n in os.listdir(base):
        text = read(os.path.join(base, n))
        code = re.sub(r"//.*|/\*[\s\S]*?\*/", "", text)
        for bad in ("eval(", "new Function", "Function(", "import(", "vm.", "child_process", "fetch(", "Date.now()", "Math.random", "new RegExp(src"):
            if bad in code and not (n == "field-types.ts" and bad == "new RegExp(src"):
                errs.append("packages/work/src/workflow/%s uses %s" % (n, bad))
    f = read(os.path.join(base, "formula.ts"))
    if "export const FORMULA_AST_VERSION = 1;" not in f:
        errs.append("formula AST version is not 1")
    return errs, "no dynamic code"


def check_approval_immutability():
    """W7: decisions are append-only; requests change only by their one-time close."""
    errs = []
    sql = read(P(MIGRATIONS_2C[0]))
    if "GRANT SELECT, INSERT ON workflow.approval_request, workflow.approval_decision TO app_rw;" not in sql:
        errs.append("approval facts are not insert-only for app_rw")
    if "GRANT UPDATE (closed_at, closed_reason) ON workflow.approval_request TO app_rw;" not in sql:
        errs.append("the one-time close grant changed")
    for m in re.finditer(r"GRANT ([^;]*?) ON ([^;]*?) TO ([^;]+);", sql):
        if "workflow.approval_decision" in m.group(2) and re.search(r"\b(UPDATE|ALL)\b", m.group(1)):
            errs.append("approval decisions are updatable")
    if "CREATE TRIGGER approval_request_guard" not in sql:
        errs.append("approval request guard missing")
    return errs, "append-only"


def check_workflow_events(registry):
    events = {e["type"] for e in registry["events"]}
    errs, found = [], 0
    pattern = re.compile(r"'(workflow\.[a-z_]+\.[a-z_]+)'")
    for f in ("packages/work/src/workflow-service.ts", "packages/work/src/field-service.ts"):
        for m in pattern.finditer(read(P(f))):
            if m.group(1).startswith(("workflow.transitions", "workflow.transition.duration", "workflow.formula.")):
                continue
            if m.group(1).count(".") != 2 or m.group(1).split(".")[1] in ("workflow_status", "approval_request", "field_definition", "field_set", "field_value", "workflow", "status", "transition"):
                found += 1
                if m.group(1) not in events:
                    errs.append("%s: event %r is not registered in 0D" % (f, m.group(1)))
    return errs, "%d event literals" % found


def check_adr_2c(closure):
    path = phase1.adr_path("0015")
    if not path:
        return ["ADR-0015 missing"], ""
    text = read(path)
    m = ADR_STATUS.search(text)
    if not m:
        return ["ADR-0015 status must be **proposed** or **accepted and implemented**"], ""
    errs = []
    if closure.get("status") == "accepted" and m.group(1) != "accepted and implemented":
        errs.append("closure is accepted but ADR-0015 is not")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0015 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0015 %s" % m.group(1)


# ---- Phase 2C corrective review 01 ---------------------------------------------------------------

CONCURRENCY_PAIRS = [
    "workflow edit vs status reorder",
    "transition add/edit/archive and required-field changes",
    "a configuration change while a transition preview/apply is in flight",
    "field definitions, values, and set versions",
    "formula dependency edits racing toward a cycle",
    "approval policy, requests, decisions, and applies",
]
TIMING_SURFACES = ["record fields:", "formula explanations:", "required-field errors:", "audit projection:", "serialization and counts:"]


def check_review01(closure):
    """The three corrections: concurrency suite, configuration audit facts, timing evidence."""
    errs = []
    ids = {c["id"] for c in closure.get("corrections", [])}
    if ids != {"R01-C1", "R01-C2", "R01-C3"}:
        errs.append("closure-2c must record corrections R01-C1..C3")
    cache = {}
    for c in closure.get("corrections", []):
        check_evidence(c["id"], c.get("evidence"), cache, errs)
    ct = read(P("packages/work/test/integration/workflow-concurrency.test.ts"))
    for pair in CONCURRENCY_PAIRS:
        if pair not in ct:
            errs.append("concurrency suite lacks: %s" % pair)
    for need in ("contended(", "pg_stat_activity", "set_config('app.workspace_id'", "db.worker", "exec.outbox_event", "audit.audit_event"):
        if need not in ct:
            errs.append("concurrency suite does not use %s" % need)
    svc = read(P("packages/work/src/workflow-service.ts"))
    if "configChanges(" not in svc or "track('transition'" not in svc or "track('status'" not in svc:
        errs.append("workflow configuration commands do not record before/after snapshots")
    if re.search(r"change\.plain\('(status|transition)_(added|moved|state|deleted)'", svc):
        errs.append("ad hoc configuration audit changes remain (use configChanges)")
    tt = read(P("packages/work/test/integration/field-timing.test.ts"))
    for surface in TIMING_SURFACES:
        if surface not in tt:
            errs.append("timing suite lacks surface: %s" % surface)
    for need in ("statementShape", "measureClasses"):
        if need not in tt:
            errs.append("timing suite does not use %s" % need)
    harness = read(P("packages/test-support/src/timing.ts"))
    if "export const TIMING_DEFAULTS" not in harness or "absMs" not in harness or "rel:" not in harness:
        errs.append("the timing threshold is not documented in the harness")
    return errs, "concurrency, audit, timing"


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    model = load(P("docs/architecture/data/model/model.json"))
    closure = load(P("docs/engineering/phase2/closure.json"))
    closure_2b = load(P("docs/engineering/phase2/closure-2b.json"))
    subphases = phase1.roadmap_subphases()
    closure_2b_result = check_closure(catalog, closure_2b, subphases, "2B")
    closure_2c = load(P("docs/engineering/phase2/closure-2c.json"))
    closure_2c_result = check_closure(catalog, closure_2c, subphases, "2C", ["D%d" % i for i in range(1, 27)])
    if closure_2b.get("phase") != "2B":
        closure_2b_result[0].append("closure-2b phase must be 2B")
    sections = [
        ("phase 2A: requirement and decision closure", check_closure(catalog, closure, subphases)),
        ("phase 2A: one collaborator authority; structures registered", check_one_authority(model)),
        ("phase 2A: five platform-default statuses", check_statuses()),
        ("phase 2A: bounds registered, configured, and enforced", check_bounds(registry)),
        ("phase 2A/2B: shareability registry", check_sharing_registry()),
        ("phase 2A: decision kinds and states", check_decision_kinds()),
        ("phase 2A: updates and verifications append-only", check_append_only()),
        ("phase 2A: templates layering", check_layering(model)),
        ("phase 2A: lifecycle issuer boundary", check_issuer()),
        ("phase 2A: no followers", check_no_followers(model)),
        ("phase 2A: project section order", check_sections()),
        ("phase 2A: work error codes within the 0D registry", check_error_codes(registry)),
        ("phase 2A: work events within the 0D registry", check_events(registry)),
        ("phase 2A: configuration keys documented", phase1.check_config_documented()),
        ("phase 2A: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 2A: review dispositions (G1-G9, P17)", check_dispositions(closure)),
        ("phase 2A: rich description storage (G1)", check_rich_description(registry)),
        ("phase 2A: share-only boundary (G2)", check_share_boundary()),
        ("phase 2A: recurrence discovery bounds (G3)", check_discovery_bounds(registry)),
        ("phase 2A: recurrence UI (G5)", check_recurrence_ui()),
        ("phase 2A: ADR status", check_adr()),
        ("phase 2B: requirement and decision closure", closure_2b_result),
        ("phase 2B: six platform-default task statuses", check_task_statuses()),
        ("phase 2B: task bounds and the depth ceiling", check_task_bounds(registry)),
        ("phase 2B: history over the audit ledger; no followers", check_task_history_and_followers(model)),
        ("phase 2B: cross-brand move and links", check_brand_move()),
        ("phase 2B: task events and telemetry registered", check_task_events(registry)),
        ("phase 2B: ADR status and decision rows", check_adr_2b(closure_2b)),
        ("phase 2C: requirement and decision closure", closure_2c_result),
        ("phase 2C: one workflow system; statuses guarded", check_one_workflow_system()),
        ("phase 2C: workflow and field bounds", check_workflow_bounds(registry)),
        ("phase 2C: twelve field types agree", check_field_types()),
        ("phase 2C: formula engine has no dynamic code", check_formula_safety()),
        ("phase 2C: approval facts append-only", check_approval_immutability()),
        ("phase 2C: workflow events registered", check_workflow_events(registry)),
        ("phase 2C: ADR status and decision rows", check_adr_2c(closure_2c)),
        ("phase 2C: review 01 corrections evidenced", check_review01(closure_2c)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs), ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 2A/2B/2C CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
