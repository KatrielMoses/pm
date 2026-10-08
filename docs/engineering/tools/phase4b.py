#!/usr/bin/env python3
"""Phase 4B closure validator (standard library only, Python 3.8+).

Usage (from the repository root):
    python3 docs/engineering/tools/phase4b.py      # exit 1 on any failure

Phase 4B (docs/engineering/phase4/closure-4b.json) is checked by the Phase 2 closure rules (every
owned and contributed catalog requirement closed with existing evidence, foundations deferred with
accepted sources, decisions D1..D10 tied to ADR-0024 rows) plus drift checks: the notification
bounds are registered (owner 4B), configured, and documented; the events, signals, envelopes, the
ndl prefix, and the actions 4B uses are registered; migration 0037 keeps its constraints, RLS,
discovery function, and exact rollback to 0036; the services reuse the canonical authorization,
never store a title, never mark a delivery delivered without an acknowledgement, and authorize
again at display and at send; readiness reports email truthfully; the 4A placeholders are
replaced; and the ADR stays proposed until acceptance.
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
    "NOTIFY_FANOUT_RECIPIENTS_MAX": ("notifyFanoutRecipientsMax", 500),
    "NOTIFY_DEDUPE_WINDOW_MINUTES": ("notifyDedupeWindowMinutes", 60),
    "NOTIFY_DELIVERY_BATCH_MAX": ("notifyDeliveryBatchMax", 100),
    "NOTIFY_DELIVERY_MAX_ATTEMPTS": ("notifyDeliveryMaxAttempts", 6),
    "NOTIFY_RETRY_BASE_SECONDS": ("notifyRetryBaseSeconds", 60),
    "NOTIFY_RETRY_MAX_SECONDS": ("notifyRetryMaxSeconds", 3600),
    "NOTIFY_DIGEST_ITEMS_MAX": ("notifyDigestItemsMax", 50),
    "NOTIFY_EMAIL_PER_HOUR_MAX": ("notifyEmailPerHourMax", 20),
    "NOTIFY_RETENTION_DAYS": ("notifyRetentionDays", 365),
    "NOTIFY_PREFERENCES_MAX": ("notifyPreferencesMax", 200),
    "NOTIFY_BROWSER_ACK_TTL_MINUTES": ("notifyBrowserAckTtlMinutes", 30),
    "NOTIFY_SEARCH_QUERY_MAX": ("notifySearchQueryMax", 100),
    "NOTIFY_DISCOVERY_MAX": ("notifyDiscoveryMax", 100),
    "NOTIFY_BULK_STATE_MAX": ("notifyBulkStateMax", 200),
    "NOTIFY_DEADLINES_BATCH_MAX": ("notifyDeadlinesBatchMax", 500),
    "NOTIFY_FACTS_MAX_BYTES": ("notifyFactsMaxBytes", 1024),
}
EVENTS = ["notify.notification.created", "notify.delivery.state_changed"]
SIGNALS = ["notify.fanout", "notify.deliveries", "notify.digests", "notify.reads"]
ENVELOPES = ["notification_counts", "notification_profile", "notification_preference", "notification_update",
             "notification_default"]
PREFIXES = ["ntf", "ndl"]
ACTIONS = ["notifications.configure_scope", "health.view", "workspace.configure"]
TABLES = ["notify.notification", "notify.digest", "notify.delivery", "notify.preference", "notify.profile",
          "notify.scope_default"]
SERVICE = "packages/work/src/notify/notification-service.ts"
FANOUT = "packages/work/src/notify/fanout.ts"
JOBS = "packages/work/src/notify/jobs.ts"
RENDER = "packages/work/src/notify/render.ts"
MIGRATION = "packages/db/migrations/0037_notifications"


def check_contracts(registry, policy):
    errs = []
    params = {p["name"]: p for p in registry["parameters"]}
    server = read(P("packages/config/src/server.ts"))
    envdoc = read(P("docs/engineering/environments.md"))
    settings = read(P("packages/work/src/validation.ts"))
    for name, (camel, default) in BOUNDS.items():
        if name not in params:
            errs.append("%s: not a registered 0D parameter" % name)
        elif params[name].get("owner") != "4B":
            errs.append("%s: 0D owner must be 4B" % name)
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
        errs.append("4B adds no actions: expected 122, found %d" % len(policy["actions"]))
    forbidden = {"body", "text", "message", "note", "title", "name", "email", "address", "subject"}
    for e in EVENTS:
        if e in events and forbidden & set(events[e]["fields"]):
            errs.append("event %s declares a content field" % e)
    routes = read(P("apps/api/src/readiness.ts"))
    if "email_delivery" not in routes or "'not_configured'" not in routes:
        errs.append("readiness must report email_delivery truthfully (ok or not_configured, never fail)")
    if re.search(r"email_delivery[^\n]*'fail'", routes):
        errs.append("email_delivery must never be reported as fail")
    return errs, "%d bounds, %d events, %d signals, %d envelopes, %d prefixes, %d actions" % (
        len(BOUNDS), len(EVENTS), len(SIGNALS), len(ENVELOPES), len(PREFIXES), len(ACTIONS))


def check_invariants():
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    down = read(P(MIGRATION + ".down.sql"))
    for needle in ["notification_dedupe_unique", "digest_unique", "delivery_state_known", "delivery_delivered_shape",
                   "delivery_ack_shape", "delivery_suppressed_shape", "delivery_sending_lease",
                   "notification_facts_shape", "preference_unique", "scope_default_unique",
                   "discover_notification_work", "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY"]:
        if needle not in up:
            errs.append("0037 lacks %s" % needle)
    schema = read(P("packages/db/src/schema.ts"))
    for table in TABLES:
        if "CREATE POLICY tenant_isolation ON %s" % table not in up:
            errs.append("0037: %s has no tenant_isolation policy" % table)
        if "'%s':" % table not in schema:
            errs.append("schema.ts lacks %s" % table)
    if "Restores the exact 0036 catalog" not in down:
        errs.append("0037 down must restore 0036")
    if "DISABLE ROW LEVEL SECURITY" in up:
        errs.append("RLS must stay enabled")
    # A notification row never holds a title or body column.
    table = up[up.index("CREATE TABLE notify.notification"):up.index("CREATE TABLE notify.digest")]
    for col in ["title", "body", "summary", "email", "subject"]:
        if re.search(r"^\s+%s\s" % col, table, re.M):
            errs.append("notify.notification must not store a %s" % col)
    svc = read(P(SERVICE)) + read(P(FANOUT)) + read(P(JOBS)) + read(P(RENDER)) + read(P("packages/work/src/notify/access.ts"))
    for method in ["async listNotifications(", "async notificationCounts(", "async getNotification(",
                   "async setNotificationState(", "async bulkNotificationState(", "async notificationProfile(",
                   "async setNotificationProfile(", "async notificationPreferences(",
                   "async setNotificationPreference(", "async removeNotificationPreference(",
                   "async browserPending(", "async acknowledgeBrowser(", "async myDeliveries(",
                   "async deliveryProblems(", "async retryDelivery(", "async scopeDefaults(",
                   "async setScopeDefault(", "async removeScopeDefault(", "export class NotificationFanOut",
                   "export async function viewNotifications(", "export async function externalLine(",
                   "async function sendOne(", "async function assembleDigests(", "async function deadlineNotices(",
                   "async function ageOut("]:
        if method not in svc:
            errs.append("notification services lack %s" % method)
    for needle in ["this.mutate(", "this.inWorkspace(", "compileVisibility(", "compilePrincipal(", "readableRecords(",
                   "decideWorkspace(p, 'health.view')", "decideWorkspace(p, 'workspace.configure')",
                   "notifications.configure_scope"]:
        if needle not in svc:
            errs.append("notification services must reuse %s" % needle)
    for forbidden in ["withWorkspaceBypass", "SECURITY DEFINER"]:
        if forbidden in read(P(SERVICE)) + read(P(FANOUT)) + read(P(JOBS)):
            errs.append("notification services must not use %s" % forbidden)
    # Delivered is only ever set after an acknowledgement (provider or the person's own browser).
    jobs = read(P(JOBS))
    for m in re.finditer(r"state: 'delivered'", jobs):
        window = jobs[max(0, m.start() - 600):m.start() + 200]
        if "ack_source: 'provider'" not in window and "await d.email.send" not in jobs[:m.start()]:
            errs.append("a delivery is marked delivered without a provider acknowledgement")
    if "ack_source: 'client'" not in read(P(SERVICE)):
        errs.append("browser delivery must be client-acknowledged")
    if "provider_unconfigured" not in jobs:
        errs.append("an unconfigured provider must suppress with provider_unconfigured")
    # Authorization again at send: access, mute, channel switch, quiet hours.
    for needle in ["access_lost", "email_disabled", "'muted'", "externalLine("]:
        if needle not in jobs:
            errs.append("the send path must recheck %s" % needle)
    lifecycle = read(P("packages/work/src/lifecycle.ts"))
    if lifecycle.count("purgeNotifyFacts(tx, ids)") < 2:
        errs.append("task and project purge must both remove notification facts")
    if "notify.notification" not in read(P("packages/tenancy/src/personal-data.ts")):
        errs.append("the personal-data eraser must remove a departed person's notifications")
    for path, needles in {
        "packages/work/test/integration/notify.test.ts": [
            "marks delivered only after the provider acknowledges, with standard content and a stable message id",
            "retries transient failures with backoff, then dead-letters; permanent failures stop at once",
            "never claims delivery without a provider: unconfigured email is suppressed with the reason",
            "rechecks access, choices, and the address when sending: nothing leaves for what the person lost",
            "reclaims a delivery whose sender crashed, under the same message id",
            "assembles one digest per slot, re-authorizes its items, and sends it once",
            "delivers to the browser only after the page reports it, and expires what nobody shows",
            "gives strangers, other people, and unknown notifications one answer, with the same statements and time",
            "removes notifications, deliveries, and choices about a purged record, keeping no title anywhere",
            "erases a departed person’s notifications, deliveries, choices, and profile, and nobody else’s"],
        "apps/api/test/integration/notify-api.test.ts": [
            "lists, counts, and reads only the caller’s own notifications, hiding others as unknown"],
    }.items():
        text = read(P(path))
        for n in needles:
            if n not in text:
                errs.append("%s lacks %r" % (path, n))
    errs += phase1.check_boundaries([9, 12, 16] + list(range(18, 38)))
    ods = read(P("docs/product/open-decisions.md"))
    seg = ods[ods.find('<a id="od-36">'):ods.find('<a id="od-37">')]
    if "**Status (Phase 4B" not in seg:
        errs.append("OD-36 must carry its Phase 4B status (open, bounded)")
    return errs, "migration guards, no stored titles, acknowledged delivery, send-time recheck, OD-36 bounded"


def check_boundaries_kept():
    """4B builds no document, file, collaborative-editing, agent-delivery, or connector structure."""
    errs = []
    up = read(P(MIGRATION + ".up.sql"))
    for schema in ["knowledge", "files", "agents", "integrations"]:
        if re.search(r"CREATE (SCHEMA|TABLE) %s\b" % schema, up):
            errs.append("0037 creates %s structures (a later phase owns them)" % schema)
    for path in ["packages/work/src/notify/transport.ts", "packages/work/src/notify/jobs.ts"]:
        text = read(P(path))
        for forbidden in ["web-push", "firebase", "sendgrid", "postmark", "ses.amazonaws", "twilio", "slack.com"]:
            if forbidden in text.lower():
                errs.append("%s names a provider SDK (%s): providers stay behind the neutral boundary" % (path, forbidden))
    shell = P("apps/web/src/shell/layout.tsx")
    if os.path.isfile(shell) and "Notifications aren't available yet" in read(shell):
        errs.append("the shell bell still shows the notifications placeholder")
    return errs, "no document, file, agent, or connector structures; provider-neutral; bell placeholder replaced"


def check_adr(closure):
    errs = []
    path = phase1.adr_path("0024")
    if not path:
        return ["no ADR-0024"], ""
    text = read(path)
    m = phase2.ADR_STATUS.search(text)
    if not m:
        errs.append("ADR-0024 status must be accepted and implemented or proposed")
    elif m.group(1) == "proposed" and closure.get("status") != "candidate":
        errs.append("ADR-0024 is proposed but the closure is not a candidate")
    for d in closure.get("decisions", []):
        if not re.search(r"^\| %s \|" % re.escape(d.get("adr_row", "")), text, re.M):
            errs.append("%s: ADR-0024 has no row %s" % (d["id"], d.get("adr_row")))
    return errs, "ADR-0024 %s" % (m.group(1) if m else "?")


def main():
    catalog = load(P("docs/product/requirements/catalog.json"))
    registry = load(P("docs/architecture/platform/contracts/registry.json"))
    policy = load(P("docs/architecture/access/policy/policy.json"))
    closure = load(P("docs/engineering/phase4/closure-4b.json"))
    subphases = phase1.roadmap_subphases()
    sections = [
        ("phase 4B: requirement and decision closure",
         phase2.check_closure(catalog, closure, subphases, "4B", ["D%d" % i for i in range(1, 11)])),
        ("phase 4B: bounds, events, signals, envelopes, prefixes, actions", check_contracts(registry, policy)),
        ("phase 4B: migration, authorization, and delivery invariants", check_invariants()),
        ("phase 4B: later-phase boundaries kept", check_boundaries_kept()),
        ("phase 4B: migrations contiguous and reversible", phase1.check_migrations()),
        ("phase 4B: configuration keys documented", phase1.check_config_documented()),
        ("phase 4B: ADR status and decision rows", check_adr(closure)),
    ]
    failed = 0
    for name, result in sections:
        errs, detail = result if isinstance(result, tuple) else (result, "")
        print("%-62s %s%s" % (name, "PASS" if not errs else "FAIL (%d)" % len(errs),
                              ("   [" + detail + "]") if detail and not errs else ""))
        for e in errs:
            print("    ERROR: " + e)
        failed += bool(errs)
    print("PHASE 4B CLOSURE: %s" % ("PASS" if not failed else "FAIL (%d sections)" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
