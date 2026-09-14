# companions.build — Atelier

The current visual reference is the owner-provided **Companions.build design système**
archive, retained Atelier direction in `DirectionA.dc.html` and `Discussions.dc.html`,
approved on 11 September 2026. It supersedes the former companion-only rail and specialist
screens. The nine reference views cover home, folders, mentions, delegation, discussion menu,
companion workbench, direct discussion and two mobile views.

Reference people, proposals, applications, counts, installation results and memories illustrate
the layout. They are not production fixtures or evidence of available backend capabilities.
The design export runtime is for preview only and is not a production dependency.

## Foundation

- Warm ivory canvas `oklch(.975 .01 85)` and rail `oklch(.955 .012 80)`.
- Dark warm ink `oklch(.25 .02 60)`, readable muted text `oklch(.5 .02 70)`,
  quiet borders `oklch(.9 .015 80)` and white composer/workbench surfaces.
- DM Sans for body text and controls; Instrument Serif for discussion and empty-state headings.
  Keep labels in sans, use fixed readable sizes and system fallbacks.
- Existing persisted companion avatars remain the expressive color system. The supplied favicon
  is the product mark. No appearance choices are overwritten by the reference characters.
- Rounded pills for recipients and participant presence, restrained outlines, circular send action.
  State animation follows real work and respects reduced motion.

## Navigation and conversation

A compact 264px desktop sidebar groups independent discussions by optional folders, shows
folder-authorized companions, and anchors named Companion rows with separate chat/settings actions above applications/account
access. Creation, archived discussions, folder editing and direct chats remain reachable.

The header pairs a serif discussion title and folder context with participant pills and discussion
controls. Invited and folder-authorized companions have different affordances. Mentions provide
an accessible picker; selecting a recipient persists the destination with an explicit return to
Central. Viewing a workbench alone must not silently address or send a message.

The common timeline uses aligned avatar/content rows, readable author/time labels and an
approximately 760px reading column. Invitation proposals, questions and task states are attached
to persisted work. An empty conversation offers editable starter prompts and direct-companion
shortcuts. The rounded white composer stays available while delegated work runs.

## Companion workspace

On wide screens, opening a participant creates a split view: conversation/composer on the left,
companion results and files on the right. Closing it returns space to the conversation. Render
actual file previews and task outputs, with downloads and machine controls where available.
A visual reference to three logo proposals does not authorize inventing proposals, comments,
selection state or an installed-tool inventory absent from the API.

Direct discussions retain the same conversation grammar and expose the companion's existing
identity, configuration, applications and machine controls. Durable memory remains the companion's
real behavior; do not display fictional memories or reversible-state controls without an API.

## Mobile and recovery

Use a drawer for the sidebar and a compact bottom navigation for the thread, participants and
navigation access. A companion workspace becomes full width; conversation and composer remain
reachable without losing the draft. Check narrow widths, long names, safe areas, keyboard focus,
scroll boundaries and reduced motion. Interactive targets must remain comfortably tappable.

Retain the existing invariants during visual changes: owner/discussion-scoped drafts, stable
message and upload identities/positions after partial failure, precision-safe history pagination,
real permission reconciliation, trusted OAuth completion and distinct chat/companion cancellation.
Archive and participant removal do not cancel already-accepted work.

## Validation

Compare the rendered reference and actual persisted application at 1440×900 and 390×844, plus a
narrow 320px layout. Exercise @ selection, split-view open/close, mobile navigation, direct chat,
folder controls, scrolling, file recovery and error states. Use focused web checks while iterating
and full verification before publishing. Reference preview fixtures remain in ignored artifacts;
production displays only real API state. No Box is required for this visual work.

## Consistent settings and interaction rules

Companion settings are available directly at `/companions/:id/settings`, without creating a
conversation. The dedicated page and contextual discussion settings share one configuration
form. Name and role come first; appearance, model selection and client sharing are disclosures.
Application accounts are connected globally and granted separately to each Companion.
Standalone navigation returns to the discussion that opened it, including its saved text draft.
The product mark navigates to an existing discussion; the plus action creates one.

The coordinator keeps the name Companion, with “Coordinates this discussion” in recipient
selection. Opening activity never changes the recipient. An accepted answer or stop request
is acknowledged separately from the next persisted task state. Background update failures keep
the last received messages visible. Loading archives and account data is distinct from emptiness.

Buttons use 120ms pointer press feedback at scale 0.96, with a `static` opt-out. Keyboard input
and reduced motion suppress movement. Modal sheets isolate background content, wrap focus,
close with Escape and restore focus, including nested desktop controls. Mobile navigation
applies the same focus behavior only at its drawer breakpoint.

Browser coverage includes standalone pages at 1440×900, 390×844 and 320×844, plus discussion
activity, draft preservation and modal keyboard behavior. CDP sets and asserts actual viewport
widths; Chrome's command-line window size alone can clamp the layout to 500px. Screenshots use
controlled test data and system font fallbacks, not live provider evidence. Set
`DISCUSSION_SCREENSHOTS` to an ignored artifact directory to retain captures.
