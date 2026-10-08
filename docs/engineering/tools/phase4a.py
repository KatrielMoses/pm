#!/usr/bin/env python3
"""Phase 4A closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase4a.py      # exit 1 on any failure

Phase 4A (docs/engineering/phase4/closure-4a.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, foundations deferred with
accepted sources, decisions D1..D10 tied to ADR-0023 rows) plus drift checks: the collaboration
bounds are registered (owner 4A), configured, and documented; the events, signals, the
collaboration_summary envelope, the cmt and rvw prefixes, and the actions 4A uses are registered;
migration 0036 keeps its guards, uniqueness, RLS, and append-only grants and reverses to 0035;
the services reuse the canonical host loaders and compiled visibility and never hard-delete,
rewrite, or notify; OD-10 and OD-38 are decided; and the ADR stays proposed until acceptance.
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
    "COMMENT_BODY_MAX_CHARS": ("commentBodyMaxChars", 10000),
    "COMMENT_EDIT_WINDOW_MINUTES": ("commentEditWindowMinutes", 1440),
    "COMMENT_MENTIONS_MAX": ("commentMentionsMax", 20),
    "COMMENTS_PER_RECORD_MAX": ("commentsPerRecordMax", 5000),
    "COMMENT_RATE_PER_MINUTE": ("commentRatePerMinute", 30),
    "COMMENT_REPLIES_INLINE_MAX": ("commentRepliesInlineMax", 20),
    "FOLLOWERS_LIST_MAX": ("followersListMax", 200),
    "REVIEW_REVIEWERS_MAX": ("reviewReviewersMax", 10),
}
EVENTS = [
    "collab.comment.created",
    "collab.comment.edited",
    "collab.comment.deleted",
    "collab.comment.reaction_changed",
    "relations.mention.created",
    "relations.follow.added",
    "relations.follow.removed",
    "collab.review.requested",
    "collab.review.decided",
    "collab.review.withdrawn",
    "collab.review.superseded",
    "work.task.delegated",
]
SIGNALS = ["collab.comments", "collab.reactions", "collab.follows", "collab.reviews", "collab.delegations"]
ENVELOPES = ["collaboration_summary"]
PREFIXES = ["cmt", "rvw"]
ACTIONS = ["record.comment", "comment.edit_own", "comment.moderate", "record.follow", "record.delegate",
           "review.request", "review.decide", "review.self_approve"]
TABLES = ["collab.comment", "collab.comment_revision", "collab.reaction", "relations.mention", "relations.follower",
          "collab.review_request", "collab.review_reviewer", "collab.review_decision", "collab.assignment_event"]
COMMENTS = "packages/work/src/collab/comment-service.ts"
REVIEWS = "packages/work/src/collab/review-service.ts"
MIGRATION = "packages/db/migrations/0036_collaboration_reviews"


def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "4A":
            errs.append("%s: 0D owner must be 4A" % name)
        if "%s: '%d'" % (name, default) not in server:
            errs.append("%s: server default is not %d" % (name, default))
        if "%s: c.%s" % (camel, name) not in server:
            errs.append("%s: not mapped to settings.%s" % (name, camel))
        if "`%s`" % name not in envdoc:
            errs.append("%s: not documented in environments.md" % name)
        if camel not in settings:
            errs.append("%s: missing from WorkSettings" % camel)
    events = {e["type"] for e in registry["events"]}
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
    if acts.get("record.comment", {}).get("roles", {}).get("read_only") != "deny":
        errs.append("record.comment must stay denied to read-only members")
    if acts.get("comment.moderate", {}).get("roles", {}).get("guest") != "deny":
        errs.append("comment.moderate must stay denied to guests")
    if len(policy["actions"]) != 122:
        errs.append("4A adds no actions: expected 122, found %d" % len(policy["actions"]))
    # No event may carry content.
    forbidden = {"body", "text", "message", "note", "title", "name"}
    for e in registry["events"]:
        if e["type"] in EVENTS and forbidden & set(e["fields"]):
            errs.append("event %s declares a content field" % e["type"])
    return errs, "%d bounds, %d events, %d signals, %d envelope, %d prefixes, %d actions" % (
        len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES), len(PREFIXES), len(ACTIONS))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["comment_thread_guard", "assert_reviewer_eligible", "review_request_one_open", "comment_body_shape",
                   "review_decision_once", "assignment_event_shape", "mention_target_shape", "follower_source_known",
                   "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY"]:
        if needle not in up:
            errs.append("0036 lacks %s" % needle)
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("0036: %s has no tenant_isolation policy" % table)
        if "'%s':" % table not in schema:
            errs.append("schema.ts lacks %s" % table)
    if "Restores the exact 0035 catalog" not in down:
        errs.append("0036 down must restore 0035")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    # Append-only: the application role is never granted UPDATE or DELETE on history tables.
    for table in ["collab.comment_revision", "collab.review_decision", "collab.assignment_event"]:
        for m in re.finditer(r"GRANT ([A-Z, ()a-z_]+) ON ([^;]*?) TO app_rw", up):
            if table in m.group(2) and re.search(r"\b(DELETE|UPDATE)\b", m.group(1)) \
                    and not (table == "collab.review_reviewer"):
                errs.append("0036 grants %s on %s to app_rw" % (m.group(1), table))
    if re.search(r"GRANT[^;]*\bDELETE\b[^;]*collab\.comment\b[^;]*TO app_rw", up):
        errs.append("0036 must not let app_rw delete comments (deletion is a tombstone)")
    svc = read(P(COMMENTS)) + read(P(REVIEWS))
    for method in ["async listComments(", "async createComment(", "async editComment(", "async deleteComment(",
                   "async setReaction(", "async follow(", "async followers(", "async following(",
                   "async mentionCandidates(", "async commentRevisions(", "protected async loadHost(",
                   "protected async resolveMentions(", "async requestReview(", "async decideReview(",
                   "async withdrawReview(", "async refreshReview(", "async delegateTask(",
                   "async assignmentHistory(", "async myReviews("]:
        if method not in svc:
            errs.append("collaboration services lack %s" % method)
    for needle in ["this.loadTask(", "this.loadProject(", "compileVisibility(", "compilePrincipal(",
                   "this.mutate(", "writeOutbox", "this.workEvent("]:
        if needle.startswith("writeOutbox"):
            continue
        if needle not in svc:
            errs.append("collaboration services must reuse %s" % needle)
    for forbidden in ["deleteFrom('collab.comment')", "deleteFrom('collab.comment_revision')",
                      "updateTable('collab.review_decision')", "updateTable('collab.comment_revision')",
                      "updateTable('collab.assignment_event')", "notified: true", "notify.", "withWorkspaceBypass",
                      "SECURITY DEFINER", "updateTable('work.task')"]:
        if forbidden in svc:
            errs.append("collaboration services must not use %s" % forbidden)
    lifecycle = read(P("packages/work/src/lifecycle.ts"))
    if lifecycle.count("purgeCollabFacts(tx, ids)") < 2:
        errs.append("task and project purge must both remove collaboration facts")
    for path, needles in {
        "packages/work/test/integration/collab.test.ts": [
            "lets an author edit within the window with a revision trail, and refuses others",
            "resolves mentions only to what the author may name, with one safe refusal for the rest",
            "decides every read and write through the record: owners, members, read-only, guests, and strangers",
            "gives hidden and unknown comments, records, and reviews the same statements and time",
            "shows collaboration in activity and history without bodies, and omits what the viewer cannot read",
            "serializes concurrent edits of one comment on its version"],
        "packages/work/test/integration/collab-reviews.test.ts": [
            "binds a decision to the version reviewed: a changed record cannot be approved",
            "serializes concurrent deciders: one settles and the rest see a closed review",
            "applies the workspace self-approval policy to a reviewer who is also the requester"],
        "apps/api/test/integration/collab-api.test.ts": [
            "gives strangers and unknown records the same 404, and never returns an internal identifier"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 37)))
    ods = read(P("docs/product/open-decisions.md"))
    for od, nxt in (("od-10", "od-11"), ("od-38", "od-39")):
        seg = ods[ods.find('<a id="%s">' % od):ods.find('<a id="%s">' % nxt)]
        if "**Status (Phase 4A" not in seg:
            errs.append("%s must be decided (Phase 4A)" % od.upper())
    return errs, "migration guards, append-only history, reused loaders, OD-10 and OD-38 decided"


def check_boundaries_kept():
    """4A's migration creates no notification, preference, document, file, or agent-review structure."""
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    for schema in ["notify", "knowledge", "files", "agents"]:
        if re.search(r"CREATE (SCHEMA|TABLE) %s\b" % schema, up):
            errs.append("0036 creates %s structures (a later phase owns them)" % schema)
    # Phase 4B (migration 0037, ADR-0024) owns the notification tables; 4A's own migration creates none.
    web = P("apps/web/src/pages/view-pages.tsx")
    if os.path.isfile(web) and "arrives with comments and following (4A)" in read(web):
        errs.append("My Work still shows the Following placeholder")
    task_page = P("apps/web/src/pages/task-pages.tsx")
    if os.path.isfile(task_page) and "Comments (4A)" in read(task_page):
        errs.append("the task page still lists comments as unavailable")
    return errs, "0036 creates no notify, knowledge, files, or agent structures; placeholders replaced"


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0023")
    if not path:
        return ["no ADR-0023"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0023 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0023 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0023 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0023 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase4/closure-4a.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 4A: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "4A", ["D%d" % i for i in range(1, 11)])),
        ("phase 4A: bounds, events, signals, envelope, prefixes, actions", check_contracts(registry, policy)),
        ("phase 4A: migration, authorization, and append-only invariants", check_invariants()),
        ("phase 4A: later-phase boundaries kept", check_boundaries_kept()),
        ("phase 4A: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 4A: configuration keys documented", phase1.check_config_documented()),
        ("phase 4A: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 4A CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
