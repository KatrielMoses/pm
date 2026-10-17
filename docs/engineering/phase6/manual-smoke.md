# Phase 6 manual smoke checklist

For the product owner, before accepting Phase 6. About 60 minutes. Automated gates already cover
behavior, authorization, isolation, recurrence, retries, the browser exit journey on three widths,
axe, the production image, and readiness. All of that runs against a deterministic Google OAuth and
Calendar contract fixture, never against Google. This list covers what automation cannot: a real
Google account, real devices, real assistive technology, and judgment.

Use a local or preview build with synthetic data only. Never connect a calendar that holds real
customer or personal events you are not willing to show in a test workspace.

**Production readiness gate (not met):** DQ-28 is unresolved. Calendar event titles and
integration credentials have no approved secret store or KMS. Do not connect a production Google
client or real customer calendars until DQ-28 is decided and implemented. This checklist does not
cover that gate, and passing it does not establish production readiness.

## 1. Live Google Calendar (needs credentials the automated gates never use)

Configure a Google Cloud OAuth client (type "Web application") for a test Google account, with the
redirect URI `<PUBLIC_BASE_URL>/v1/integrations/oauth/google_calendar/callback`. Set
`GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, and `GOOGLE_CALENDAR_REDIRECT_URI`.
Keep the endpoint defaults. Leave `GOOGLE_CALENDAR_LOOPBACK_ENABLED` unset.

- [ ] Before configuring: Integrations says Google Calendar is not configured, and offers no
      connect button.
- [ ] Connect Google Calendar with two-way on. Google's consent screen asks for calendar read and
      event write access only. After consent you land back on Integrations with a success message.
      The connection says Live, not Test double.
- [ ] In Google, untick event write access on the consent screen and connect again. The connection
      ends read-only, and two-way is not offered.
- [ ] Choose a second calendar and map one to a brand. Sync now. Events from both calendars appear
      in Today and the calendar view, with their calendar names.
- [ ] Create a weekly Google event that crosses a daylight-saving change in your zone. Its local
      time stays the same on both sides of the change.
- [ ] Delete one occurrence in Google and move another. Sync. The deleted one is gone and the moved
      one shows at its new time, marked as moved.
- [ ] On Today, add a block on a task with a due date to the two-way calendar. It appears in Google.
      Move it in Google to after the due date and sync. The block moves, shows "after due date",
      and the task's due date and deadline do not change.
- [ ] Move the block in the app; sync. Google shows the new time. Sync twice more: nothing moves.
- [ ] Move the event in Google and the block in the app before syncing. A conflict appears showing
      both times. "Keep my plan" puts the app's time into Google; "Use the calendar's time" moves the
      block; "Unlink" leaves both as they are.
- [ ] Revoke the app at https://myaccount.google.com/permissions, then Sync now. The connection asks
      for reauthorization and says so; nothing is reported as synchronized. Reauthorize and sync.
- [ ] Disconnect and keep data: past events stay visible to you as not synchronized. Disconnect and
      remove on another connection: its events are gone. Google's permissions page no longer lists
      the app.
- [ ] As a second member (administrator), open the first member's capacity and Today. No calendar
      events, busy time, titles, or counts appear (anonymous free/busy is off).

## 2. Tokens, webhooks, MCP, and CSV

- [ ] Create a personal API token. It is shown once. Revoke it; a request with it is refused.
- [ ] Add a webhook endpoint you control (for example a request bin on HTTPS). Send a test event.
      The signature header verifies with the shown secret, and the body names the real object
      (`data.object`) with the event's own time. Rotate the secret; the next delivery carries both
      signatures until the old one expires.
- [ ] Make the endpoint fail until a delivery is marked Failed, then use Retry: it is sent again
      once with the same Webhook-Id. Delivered and Not sent rows offer no Retry.
- [ ] Pause the endpoint from the settings page. Create an event: nothing arrives. Resume is refused
      until you send a test event that is delivered; then resume, and new events arrive (the paused
      period is not replayed).
- [ ] As the endpoint's owner, lose access to one restricted project but keep the brand. An event
      about a task in that project is shown as Not sent, with the reason, and never arrives.
- [ ] Register an MCP client, grant one scope, generate an access token, and call a read tool from
      an MCP-capable client. Revoke your consent; the next call is refused.
- [ ] Export a CSV and open it in a spreadsheet. A cell starting with `=` stays text. Import a small
      CSV, preview, apply, then roll it back.

## 3. Real devices and assistive technology

- [ ] Phone (portrait and landscape): the Integrations calendar section, the conflict choices, and
      Today's meetings are usable with one hand. Nothing hides behind the keyboard.
- [ ] Browser zoom at 200% and 400%: no sideways scrolling, and nothing overlaps.
- [ ] Forced colors (high contrast) and reduced motion are respected on every Phase 6 page.
- [ ] Screen reader (VoiceOver on macOS or iOS, or NVDA on Windows): the connection status, the
      calendar list, sync results, the conflict times, and the shown-once token and secret are all
      announced. Busy states say they are busy, and results are announced when they settle.
- [ ] Keyboard only: connect, choose calendars, sync, resolve a conflict, create and revoke a token,
      and run a CSV preview without a mouse. Focus is always visible.

Record anything that fails with the page, device, browser, and steps, and attach it to the
P6-IR1 review. This list does not replace the automated evidence in the exit report.
