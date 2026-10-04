# Phase 1 manual smoke checklist

For the product owner, before accepting Phase 1. About 30 minutes. Automated gates already cover
behavior, isolation, axe (zero serious or critical violations) at three widths, and the production
image. This list covers what automation cannot: real devices, real assistive technology, and
judgment.

Use a local or preview build with synthetic accounts only. Never enter real personal data.

## Journey (one desktop browser, one phone)

- [ ] Register, confirm the email from the captured mail, and sign in.
- [ ] Create a workspace and three brands. Mark one sensitive. Archive another and restore it.
- [ ] Switch the scope: one brand, two brands, then All. Reload, then use Back and Forward. The
      scope follows each time.
- [ ] Invite a member and a guest. In a second browser profile, accept both invitations.
- [ ] Give the member one brand. The review names only that brand, and the member then sees only
      that brand.
- [ ] Remove the member while their tab is open. Their next click goes to Sign in, not to an error.
- [ ] Sign out. Sign back in on the same browser. Your theme and saved list filters are still
      there; nothing typed in another tab is.

## Real devices and judgment

- [ ] Phone (portrait and landscape): the bottom bar, the More sheet, and dialogs are usable with
      one hand. Nothing hides behind the keyboard or the browser's own bars.
- [ ] Tablet or a narrow desktop window (600–1023 px): the rail's icons and short labels are clear.
- [ ] Browser zoom at 200% and 400%: no sideways scrolling, and nothing overlaps.
- [ ] The operating system's dark mode, high contrast (forced colors), and reduced motion are all
      respected.
- [ ] Copy reads plainly. Nothing promises features that are marked "not available yet".

## Assistive technology (known limitation, 11E)

Automated checks cannot replace a screen-reader pass. **No NVDA, JAWS, or VoiceOver pass has been
run for Phase 1.** That pass is scheduled for 11E (ADR-0012 F6; A11Y-KB-07 rule 5). Until it runs,
Phase 1 claims only:

- zero serious or critical axe violations at desktop, tablet, and mobile widths;
- keyboard operation;
- the documented focus behavior.

If you can, do a short spot check with VoiceOver (macOS or iOS) or NVDA:

- [ ] The skip link, the page heading announced on arrival, and the scope switcher's name and state.
- [ ] Dialogs announce their title, keep focus inside, and return focus when closed.
- [ ] Status messages ("Access given.", "Summit was restored.") are announced once.

Record findings as issues against 11E. They do not block Phase 1 unless a flow cannot be completed.
