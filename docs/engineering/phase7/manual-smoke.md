# Phase 7 manual smoke checklist

Automated acceptance (CI) runs every Phase 7 path against labelled deterministic fixtures: the
Anthropic Messages protocol fixture for generation and interpretation, the same fixture's
transcription endpoint with synthetic recordings, and the Google Calendar HTTP contract fixture.
Those prove the product's own behavior. They do not prove a real model's answers, real speech
recognition, a microphone, or a screen reader. The checks below need a person, a device, or
approvals the automated gates never use. None of them may be run against a deployed environment
until DQ-28 (secret store), OD-41 (provider data use), and OD-46 (workspace keys) are decided:
deployed configuration refuses the fixtures and no live provider is configured.

## Manual checks

### 1. Devices and assistive technology

- Record a note with a real microphone on desktop Chrome, Safari on iOS, and Chrome on Android:
  the permission prompt is the browser's own, the recording indicator and elapsed time are
  announced, Stop and Cancel work by keyboard, and a denied permission leaves typing available.
- With VoiceOver (macOS, iOS) and NVDA (Windows): the assist estimate and confirmation, the
  proposal review (every change heading, the assignment and label lines, Approve, Apply, and the
  stale-plan banner), the capture interpretation and transcript regions, and a briefing's
  statements, evidence links, and note form are announced in reading order with their state.
- At 400% zoom and with Windows High Contrast, the same screens keep every control reachable.

### 2. Live providers (only after DQ-28, OD-41, and OD-46 are decided)

- Transcription quality on accented, noisy, and long recordings; the transcript is always
  editable before use and the audio is gone after every outcome.
- A real model's draft plans, interpretations, and summaries: typed results, honest labels,
  verbatim excerpts, and refusal of anything outside the schema. Real input-token and cost bounds
  must be verified before any model is approved.
- Provider retention and training terms match what the product states.

### 3. Delivery

- A briefing email through a real provider carries only a link (no briefing content), and an
  in-app notice opens the briefing for its recipient only.

## What the fixtures prove

- Deterministic recordings prove upload, bounds, transcription transport, failure handling,
  editing, saving, triage, and deletion; they are not evidence of recognition quality.
- The Messages fixture proves budgets, confirmation, cancellation, unknown outcomes, validation,
  and provenance; it is not evidence of model quality or real cost.
