---
version: beta
name: Companion
description: Operator-grade design system for Companion, a self-hostable Skills Hub with optional hosted Companions.
colors:
  primary: "oklch(0.27 0.021 265)"
  canvas: "oklch(0.975 0.004 265)"
  surface: "oklch(0.995 0.0015 265)"
  surface-raised: "oklch(0.955 0.006 265)"
  surface-sunken: "oklch(0.965 0.005 265)"
  line: "oklch(0.915 0.006 265)"
  line-strong: "oklch(0.855 0.008 265)"
  fg: "oklch(0.27 0.021 265)"
  muted: "oklch(0.475 0.018 265)"
  faint: "oklch(0.62 0.014 265)"
  accent: "oklch(0.81 0.166 88)"
  accent-hover: "oklch(0.75 0.166 88)"
  accent-muted: "oklch(0.75 0.166 88)"
  accent-fg: "oklch(0.27 0.04 88)"
  accent-ring: "oklch(0.66 0.166 88 / 0.55)"
  accent-tint: "oklch(0.955 0.05 88)"
  accent-line: "oklch(0.66 0.166 88 / 0.30)"
  accent-edge: "oklch(0.66 0.166 88)"
  accent-cloud: "oklch(0.585 0.142 242)"
  accent-cloud-hover: "oklch(0.52 0.142 242)"
  accent-cloud-fg: "oklch(0.99 0.012 242)"
  accent-cloud-tint: "oklch(0.585 0.142 242 / 0.1)"
  accent-cloud-line: "oklch(0.585 0.142 242 / 0.28)"
  ok: "oklch(0.55 0.13 156)"
  warn: "oklch(0.60 0.12 75)"
  danger: "oklch(0.55 0.20 25)"
  unknown: "oklch(0.62 0.012 265)"
  ok-tint: "oklch(0.55 0.13 156 / 0.12)"
  ok-line: "oklch(0.55 0.13 156 / 0.30)"
  warn-tint: "oklch(0.60 0.12 75 / 0.14)"
  warn-line: "oklch(0.60 0.12 75 / 0.32)"
  danger-tint: "oklch(0.55 0.20 25 / 0.10)"
  danger-line: "oklch(0.55 0.20 25 / 0.32)"
  scrim: "oklch(0.27 0.02 265 / 0.40)"
  brand-blue: "oklch(0.56 0.13 250)"
  brand-teal: "oklch(0.54 0.10 168)"
  brand-violet: "oklch(0.55 0.13 300)"
  brand-amber: "oklch(0.60 0.10 66)"
  brand-terracotta: "oklch(0.55 0.13 24)"
  brand-slate: "oklch(0.50 0.035 265)"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
    fontFeature: "'tnum' 1"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0em"
    fontFeature: "'tnum' 1"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
    fontFeature: "'tnum' 1"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
    fontFeature: "'tnum' 1"
  badge:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0em"
    fontFeature: "'tnum' 1"
  scale-xs: "0.75rem"
  scale-sm: "0.8125rem"
  scale-base: "0.875rem"
  scale-md: "1rem"
  scale-lg: "1.125rem"
  scale-xl: "1.375rem"
rounded:
  sm: "4px"
  md: "6px"
  lg: "10px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
  4xl: "64px"
shadows:
  xs: "0 1px 2px oklch(0.27 0.02 265 / 0.04)"
  sm: "0 1px 2px oklch(0.27 0.02 265 / 0.05), 0 1px 1px oklch(0.27 0.02 265 / 0.04)"
  md: "0 2px 6px oklch(0.27 0.02 265 / 0.06), 0 1px 2px oklch(0.27 0.02 265 / 0.05)"
  lg: "0 8px 28px oklch(0.27 0.02 265 / 0.12), 0 2px 6px oklch(0.27 0.02 265 / 0.06)"
motion:
  duration-fast: "120ms"
  duration-base: "180ms"
  duration-slow: "240ms"
  ease-out-quint: "cubic-bezier(0.22, 1, 0.36, 1)"
layout:
  sidebar-width: "244px"
  topbar-height: "56px"
  content-max: "1120px"
  drawer-width: "460px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "oklch(0.99 0.01 25)"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  badge-status:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.muted}"
    typography: "{typography.badge}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "16px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  row-selected:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  drawer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "24px"
    width: "460px"
  focus-ring:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
---

# Companion DESIGN.md

## Overview

Companion is an operator-grade, self-hostable Skills Hub with optional hosted Companions. The visual job is to make skill scope, ownership, validation, versions, dependencies, labels, secrets, databases, publication state, and durable Companion work legible at a glance. Skills remain the core workspace; a Companion is one named teammate with one thread, one Box, and one Pi daemon.

The interface is product software, not marketing. It should feel calm, dense, precise, trustworthy, and engineering-grade. Reference quality is Linear, Stripe, and Raycast: familiar controls, compact hierarchy, real data shown plainly, and no decorative drama. Healthy state should be quiet. Broken state should be unmistakable without alarm theater.

This document describes the Companion theme as implemented in `apps/web`. Light is the default; a full dark
theme and user-selectable accent presets are available (see Colors). CSS custom properties live in
`apps/web/src/styles/tokens.css`; the `cds-*` component layer is in `cds.css`; feature-specific layout and
styling extend those tokens in `auth.css`, `skills.css`, `onboarding.css`, `org.css`, `settings.css`, and
`upload.css`.

Native iOS has its own approved source of truth in `docs/ios-design.md`. Its Grok Bot-derived
character marks, neutral surfaces, navigation, and user journeys intentionally do not inherit this
web theme.

## Colors

Companion uses restrained tinted neutrals and a **signal yellow** accent by default. Every neutral is slightly
tinted toward the cool Companion hue (~265 in OKLCH). Never use pure `#000` or pure `#fff` for product UI
surfaces or text.

The page sits on `canvas`, with panels, cards, sidebars, topbars, drawers, and form controls using `surface`.
Hovered rows and active navigation use `surface-raised`; inset code blocks and quiet wells use `surface-sunken`.
Structure comes from `line` and `line-strong`, not heavy shadows.

`accent` is the primary chromatic action color. Use it for primary actions, links, selected row treatment, and
focus indication. Do not use accent as decoration, chart filler, page glow, or gradient material. Hovered primary
buttons use `accent-hover`; selected rows use `accent-tint` plus an inset accent edge (`accent-edge` or
`accent-line`). `accent-muted` is available for subdued accent treatments.

Three accent presets are user-selectable in Account › Preferences via a `data-accent` attribute on `<html>`
(persisted per-device in `localStorage`, applied before first paint by a no-FOUC inline script). Signal yellow
is the default with no attribute. `data-accent="cloud"` swaps in the canonical cloud-blue tokens
(`oklch(0.585 0.142 242)` family). `data-accent="evergreen"` swaps in a calm green (`oklch(0.58 0.115 162)`
family) and `data-accent="coral"` a warm red-orange (`oklch(0.66 0.165 30)` family); each redefines the full
`accent*` set so primary actions, focus rings, and selected-row tints stay coherent.

Account › Preferences also carries the member's personal IANA timezone. Unlike theme and accent it
is server-backed and shared by web and the native Apple clients across every workspace. With no stored value, the
picker proposes the browser or device timezone and asks the member to save it; `UTC` is the runtime
fallback until then.

A dark theme is available app-wide via `data-theme="dark"` on `<html>` (also chosen in Preferences — light,
dark, or follow-system — and applied before first paint to avoid a flash). It sets `color-scheme: dark` and
overrides the neutral ramp (`canvas`, `surface`, `surface-raised`, `surface-sunken`, `line`, `line-strong`,
`fg`, `muted`, `faint`), the `scrim`, and the `shadow-md`/`shadow-lg` elevations for a dark ground. Accent hues
are unchanged in dark mode; only `accent-tint` is lifted per accent (`data-theme="dark"` × `data-accent`) so
selected rows read against the darker surface. A one-frame `no-anim` class is toggled during a theme or accent
swap so background colors don't interpolate across the variable change.

During onboarding, org and team brand colors are chosen from a fixed six-color palette (`brand-blue`, `brand-teal`,
`brand-violet`, `brand-amber`, `brand-terracotta`, `brand-slate`). These are cosmetic only and stored per org/team;
they do not replace the product accent tokens.

Status colors are calm and slightly desaturated:

- `ok` means Healthy.
- `warn` means Degraded or Missing.
- `danger` means Down, destructive, or unrecoverable error.
- `unknown` means Unknown, pending, absent, or not yet observed.

Color never carries status alone. A dot, badge, or rail must always be paired with text such as `Healthy`, `Degraded`, `Down`, `Unknown`, `Present`, or `Missing`.

## Typography

Use system fonts only. No web fonts, no Google Fonts, no downloaded brand fonts. Companion must work offline and on private networks.

Use `body` (`scale-base`, 0.875rem) for most UI text, `heading` (`scale-lg`, 1.125rem) for page titles and card titles,
`label` (`scale-sm`, 0.8125rem) for metadata and form labels, `badge` (`scale-xs`, 0.75rem) for compact chips, and
`mono` for machine values. The full type scale also includes `scale-md` (1rem) and `scale-xl` (1.375rem) for auth titles
and onboarding headings. Typography hierarchy comes from size and weight, not from color saturation.

Machine values are load-bearing and must remain literal in monospace:

- skill ids and slugs such as `incident-summary`
- versions and checksums such as `1.4.0` and `sha256:…`
- scopes such as `personal` and `org`
- validation states such as `valid` and `invalid`
- env vars and secret names such as `GITHUB_TOKEN`
- label paths such as `engineering/incident-response`

Use sentence case for headings, labels, buttons, navigation, and empty states. Product and technology names keep their canonical casing: Companion, Hermès, Hermes, Granite, Tailscale, Fly, Kubernetes, Modal, OpenRouter, OpenClaw, MCP, `SKILL.md`, `SOUL.md`.

UI copy is terse and operational. Say what happened, what will happen next, or what the user can do. Avoid greeting copy, delight copy, mascot copy, and broad value propositions inside the app.

## Layout

Use a dense product layout. The primary shell is a fixed sidebar (244px) plus compact topbar, with the
main content constrained enough to scan but not padded into a landing page. Layout tokens:
`sidebar-width` 244px, `topbar-height` 56px, `content-max` 1120px, `drawer-width` 460px.

The product-owned Plugins catalog includes Linear, GitHub, Notion, Conductor, Slack, Gmail, and
Sentry. Slack uses
the same compact labeled-account, connect, attach, and disconnect patterns as every other catalog
entry; it is not presented as a separate messaging surface.

The sidebar presents the Skills libraries directly: My Skills, Organization, Installed, Companion skills, Archived, and Secrets. When `COMPANION_COMPANIONS_ENABLED=true` and the required email-domain allowlist is non-empty, a two-option Skills | Companions mode segment sits directly under the workspace switcher for authenticated users allowed by that list; the segment is absent by default, when the allowlist is empty, and for users outside the allowlist, and there is no separate top-level or bottom Companions entry. Skills mode keeps the libraries unchanged. Companions mode replaces them with the workspace Companion roster as a conversation list: each row carries the Companion's animated blob avatar plain — no tinted circle behind it — the name, when the thread last spoke, one truncated line of the last thing a member or the Companion said, and an accent dot while the reader's own unread watermark is behind the thread. The avatar breathes at rest and thinks only while a positively acknowledged Turn is replying — never for queued work — and all of it stops under `prefers-reduced-motion`. Presence is a dot on the corner of that avatar, and it is never colour alone: the status word stays in the row's accessible name and as text a screen reader reaches. Each row also hosts a hover-revealed "…" actions menu — Settings, Share, Pin, Mark as unread, Duplicate, Hide, and an Owner-only Delete behind the same irreversible confirmation settings uses — and the roster head carries the one New companion action. Hidden Companions live under a collapsed Hidden disclosure at the roster's tail. Tool runs and permission cards are never previewed, so no command, path, or unanswered question appears on a row outside the thread it belongs to; a routine fire previews as its `Routine: <name>` header rather than the prompt nobody typed. Read state is member-private, so a shared thread one member opens stays unread for everyone else. Companions mode keeps Secrets, Archived, Plugins, and Settings reachable, with Plugins and a footer row naming the signed-in reader — the settings entry — below the list. The sidebar is the only roster; there is no separate main-area Companion list and no dedicated Companion search. With no thread open the main pane is a short welcome — the workspace count, the New companion action, and on a phone the way into the roster drawer. Plugins is a first-party Companion surface that groups each MCP provider's member-private accounts into short labels such as `work` and `personal`; it offers the product-owned Linear, GitHub, Notion, Conductor, Slack, Gmail, and Sentry catalog plus manual custom MCP connection, and credentials are entered there and never in chat. Creating a Companion leads with its animated icon generator in place of a static dialog glyph, then asks for a name, one connected provider, and one model from that provider's live pi.dev list; persona lives in settings as instructions, and provider credentials and sharing stay in focused dialogs. Opening a Companion fills the main pane with its single chat thread: a back control, the Companion identity, its Box status chip, a settings action, a context-panel toggle for a runner, the conversation, and one composer. Nothing else belongs there — no Pi tools, no Skills, no plugins, no run chrome. The status chip is a dot plus one state word — `Online`, `Starting`, `Asleep`, or `Error` — and what it reports on, `Box · online` and its siblings, is its accessible name and tooltip rather than visible text, so the word itself never has to give way on a narrow header. It refreshes immediately on thread open and send, every three seconds while a send or lifecycle transition is active, then at the slower settled cadence; stale responses cannot move a newer state backward, and Viewer polling never contacts Box. For a runner whose Box is already running the same chip opens the Box desktop Lux drives in a new tab. Computer use has exactly two places and no third: that tab, and the screen preview in the context panel beside the conversation. The preview is the live Box desktop framed as a 16:10 card with pointer events stopped at it, so it is the screen to watch and the tab is the screen to drive; its caption carries the handoff, a Reconnect for a join that produced nothing, and guidance to send a message when the Box is asleep. Both are the same Lux desktop over the same route, each join mints its own stream and keeps none, and neither can start a Box; there is no settings page for computer use and no third surface for it. The rest of the context panel shows the library Skills this Companion stages on its Box as monospace chips with a Manage link into settings. The panel then lists this Companion's scheduled routines: name, cron, timezone, next fire, and a + for Owner/Editor to create one. A fired routine hides its prompt behind a compact Routine header; the reply is an ordinary assistant message. Owner/Editor approve asynchronous Companion control cards for models, OAuth, routines, triggers, and peer access directly in the thread. The panel is a runner surface, never a Viewer's; it is a sibling of the conversation on a wide screen and comes over it, dismissible by Esc and its scrim, below 1024px. A runner whose Box is asleep gets no lifecycle control in the header; sending a message is the normal way to start it, and typing alone never prewarms it. A Viewer gets the same transcript with the composer replaced by a read-only note and the same chip as text only, because reading a Companion must never start a Box. It must not render the Box/Pi harness, a full provider catalog, multi-Bot controls, or raw runtime chrome. External coding-agent access lives in Settings and is described explicitly as delegated Skills Hub access.

Asynchronous `companion-control` cards cover model, OAuth, routine, trigger, and peer-grant changes
inside the thread. Applied OAuth cards link into the matching provider flow and attach the account to
the requesting Companion. Delegation request/response markers name the peer and mode without adding
Group, Room, or orchestration chrome.

Routine history extends the compatibility marker without adding chat chrome. The routine row exposes
a History action, while a marker carrying `run_id` is a compact clickable control. Both open the same
right-side drawer: newest runs first, explicit terminal outcome, then the private transcript paged by
durable ordinal. An interrupted run explains that automatic cleanup terminates only its exact Pi
invocation, never replays the occurrence, and releases the lane without member action. Owner,
Editor, and Viewer see the same cleanup status; nobody gets Retry or Cancel controls for a terminal
interruption. The drawer polls while that exact cleanup is queued or running without discarding
transcript pages already loaded. It takes the full chat stage on a phone, traps focus, closes with
Esc or its scrim, and never contacts Box on reads. During the compatibility phase the ordinary
assistant reply stays in the thread and is referenced as the run's virtual notify result rather
than duplicated in history.

Routine creation uses the member's saved timezone as the default schedule zone on both responsive
web and the native Apple clients. Routine next-fire and trigger last-fire instants are displayed in that member
timezone, with the zone label visible; an existing routine's own cron timezone remains visible as
the authoritative schedule definition.

The focused model-provider dialog keeps API-key connection to one write-only field. Claude
subscription connection uses a browser authorization code and Codex uses a device code; neither
surface asks for `auth.json` or renders access and refresh tokens. Connected entries feed the first
step of the shared picker used by both creation and Companion settings; its second step shows only
the selected provider's server-owned model catalog. The server bounds the live pi.dev fetch, caches
the last-known catalog, supplements released models Pi has not published yet, and falls back to
bundled models so the picker never becomes empty.

Prefer tables and structured rows for resources. Companion lists skills, labels, versions, dependencies, members, scopes, comments, releases, databases, and audit events. These surfaces should be compact and sortable/filterable over time, not inflated into repeated marketing cards.

Summary metrics are inline counts, not hero cards. Use patterns like `Total 12 · Healthy 9 · Degraded 2 · Down 1`, with tabular numerals and status labels. Avoid large vanity numerals.

Rows should expose the operational facts in stable order: status, name or id, library, version, validation, creator, labels, dependencies, and last activity. Use truncation for long machine values, but keep copy affordances for ids and URLs.

Detail belongs in a right slide-over drawer. Do not make modal dialogs the default detail surface. The drawer should keep the list visible behind a flat scrim, support Esc and scrim close, and return focus to the originating row.

A selected row's summary is a lighter thing than a drawer: a persistent panel beside the list, not over it, with no scrim and nothing modal about it. It answers what one row is, who wrote it, whether it is installed, how its `SKILL.md` opens, and which Companions stage it, plus the one action that skill is for and an Open into the full page. Everything else — every tab, every secondary action — stays on the page. It sits inline where there is room and comes over the list below 1100px.

Forms are direct and compact. Use labels, concise helper text, and explicit consequences. For destructive or delayed lifecycle actions, explain the declared-state effect rather than hiding it behind vague confirmation copy.

## Elevation & Depth

Companion is flat and hairline-driven. Use 1px borders and subtle surface changes to separate layers. Cards, tables, sidebars, and topbars rely on `line`, not drop-shadow stacks.

Use shadows only for floating layers such as drawers, dropdowns, and dialogs. Shadow tokens are `xs`, `sm`, `md`, and `lg`; they should be soft and restrained; never use glow. Scrims are flat tinted overlays with no blur.

Web product surfaces do not use glassmorphism, backdrop blur, translucent panels pretending to be
glass, gradient depth, bokeh, grain, decorative textures, or atmospheric image backgrounds. The
native iOS 26 client is the deliberate exception: use Apple's system Liquid Glass for navigation
and interactive controls, system materials for content surfaces, and a restrained brand-colour
backdrop so those materials remain visible. Do not imitate Liquid Glass with custom shaders,
overlays, or third-party components. Reduce Transparency must fall back to the opaque canvas, and
message text must keep normal content contrast.

The native macOS client uses platform-standard sidebar, toolbar, popover, and window materials so
it belongs on the desktop. Vibrancy is structural rather than decorative: chat content stays on a
quiet readable surface, controls keep visible hover and keyboard focus states, and Reduce
Transparency replaces material-backed regions with opaque system backgrounds.

Motion is sparse and functional. Use `duration-fast` (120ms), `duration-base` (180ms), or `duration-slow` (240ms) with
`ease-out-quint` transitions. Allowed motion: drawer slide-in/out, scrim fade, hover color changes, selection color
changes, and short copy confirmation. Do not animate layout properties such as width, height, margin, or top. Respect
`prefers-reduced-motion` by removing drawer slide and scrim fade.

The Companion thread is the one surface where motion also reports state, because a conversation is the one place where
waiting is the message. It may animate a typing indicator only after Pi acknowledged the active attempt, a spinner on a tool run that is still
open, a short rise as a message arrives, and the height of a disclosure it opens. Nothing else in the thread moves: a
status dot stays static there as everywhere else, the small Companion face beside each assistant message is motionless — the thinking face
belongs to the replying trailer and the chrome around the thread — and every one of these stops under `prefers-reduced-motion`.

## Shapes

Radii are small and pragmatic:

- `sm` for badges, chips, icon buttons, and compact status containers.
- `md` for buttons, inputs, cards, rows, and error blocks.
- `lg` for drawers and larger panels.
- `full` only for status dots, toggle thumbs, and true pills.
- `2xl` (16px) only inside the Companion thread, for a member's message bubble and the composer field it is answered
  from. A bubble that reads as a bubble is what makes a two-sided conversation legible at a glance; nothing outside that
  thread may claim this radius.

Do not use oversized rounded SaaS cards. Do not put cards inside cards. Page sections are not decorative floating cards; reserve cards for actual framed data groups, repeated resource items, and compact panels.

Selection uses a tinted row background plus an inset accent edge via box-shadow. Do not use colored side-stripe borders. Focus uses one visible accent ring with offset and must not shift layout.

## Components

**Topbar** is compact and single-line. It shows product/workspace/view context, connection state, and updated timestamp. Use middle-dot separators and mono timestamps. No tagline, greeting, or hero title.

**Sidebar** contains the Companion brand mark, wordmark, workspace context, primary navigation, counts where useful, and a quiet environment/footer indicator. Active nav uses `surface-raised` with foreground text; unread counts may use the accent fill. The brand mark tile uses the official transparent Companion mark on a tokenized `surface` tile with a `line` border, so it works across light, dark, and accent presets.

**Skills workspace** is the product core. The shell opens directly on the skill library. Skill detail uses Overview, Dependencies, Files, Database, History, and Activity only when those sections apply. Upload, browser creation, publishing, installation, public release management, comments, labels, secrets, and hosted database workflows stay close to the selected skill. The Skills surface never executes package scripts or launches generic agents; only the gated Companions surface may stage selected Skills for its one Pi runtime.

**External agent access** is an account setting for delegated clients that consume the Skills Hub. Describe capabilities such as skill read/write, database read/write, and secret read/write. Never present a connected external client as a Companion-hosted or Companion-launched agent.

**Summary counts** are slim inline rows. Use tabular numbers, muted labels, and status dot plus label. They are not cards.

**Resource rows** are the core component. Rows are dense, keyboard-focusable, and full-width. Default rows use surface plus hairline dividers; hover uses `surface-raised`; selected uses `accent-tint` and a 2px inset accent edge. Copy affordances can reveal on hover, but keyboard users must still reach them.

**Skills Rhythm list** applies only to My Skills and Organization. The default grouped mode creates one
flat section per root folder and uses a light icon/name/count/chevron header with no card, side stripe,
colored band, or nested subsection. Subfolders stay as quiet relative-path metadata on the row, limited
to two most-specific paths plus an accessible `+N`. Installed and Without folder are trailing utility
sections. Sections start open and may collapse; search temporarily reveals matches. A compact
Grouped/Flat control sits beside sort. Selecting a sidebar folder keeps descendant roll-up, but scopes
group sections, visible paths, and inherited folder icons to that selected branch; other roots assigned
to the same skill stay hidden. In that scoped view, sections advance to the immediate subfolder level;
skills filed directly in the selected folder render first as plain rows without a section header or
collapse control. In unscoped root sections, direct rows lead and remaining rows stay contiguous by
immediate subfolder, while the selected sort remains stable inside each block. Every grouped row keeps the same
horizontal inset regardless of subfolder depth; order and quiet path metadata carry the hierarchy rather
than extra indentation. Flat mode keeps the full folder chips within that scope. In both modes the literal slug
is the only visible row identity, set in monospace, and accessible labels repeat the slug rather than a
display title; one truncated line of the description rides beside it as quiet metadata, never as a
second name. The list is a dense table of four columns — Skill, Labels, People, Upd. — and rows carry
no controls of their own: Upd. gives way first on a narrow screen, then People, and the one action a
skill is currently for lives in the panel beside the list and on the skill's own page. A click selects
a row into that panel and a double click opens the page; Esc puts the panel away. Selection is
ephemeral and stays out of the URL, because a glance at a row is not a place to return to. Skill icons resolve from the package manifest, then the deepest custom folder icon and
color for that occurrence, then a neutral package glyph. Keep this rhythm dense on mobile by wrapping
controls and metadata, not by turning rows or groups into cards.

**Skill Tables** is a conditional detail tab shown only when hosted databases are enabled and the
selected Skill declares tables. Use one compact master-detail workspace, not a dashboard: the first
rail selects `My data`, `Shared with me`, or `Organization`; shared data adds an owner selector; the
second rail selects a table; and the main pane shows a 50-row page ordered by primary key. Keep schema
information and add/edit forms in the standard slide-over drawer. Primary keys are visible but
immutable during edit, mutations must report exactly one changed row, and tables without a primary key
are explicitly read-only. Typed controls cover text, numbers, booleans, JSON, and timestamps; optional
values can be omitted so SQLite defaults or `NULL` still apply. `Manage sharing` appears only for the
caller's `My data` realm and opens a searchable member checklist with an explicit Save action. Shared
and organization realms retain data editing but never expose sharing controls. Loading uses skeleton
rows; empty, revoked, conflicted, failed, and archived-read-only states explain the consequence and
offer Retry where useful. On narrow screens preserve every capability through progressive
table → rows → full-screen panel navigation rather than shrinking the grid or removing actions.

**Companion settings** is a separate page reached from each roster row's "…" menu in the
sidebar and from the open thread's header. It has one direct form leading with the icon generator, then name, instructions, and the same provider-then-model picker
used during creation, on the same flat hairline surface without stacking cards or adding
navigation. Owner and Editor also see a hairline-separated Runtime section. The temporary Restart
control asynchronously recycles Pi on the existing Box. Durable lifecycle intent survives navigation
or reload; the client does not retry provider calls itself. Controls are disabled during incompatible
lifecycle work or while settings have unsaved changes, but an existing Box in Error keeps Pi recycle
available so the error state cannot hide its own repair. Viewer sees none of them. The Owner alone sees a separate
permanent-delete action and an explicit irreversible confirmation; Editor can save but cannot delete,
and Viewer sees disabled read-only fields. Sending a message remains the only normal wake path: there
is no Wake button and saving settings never wakes an asleep Box. The thread, Box chip, Plugins, Lux,
and top-level navigation remain unchanged.

**Companion thread** is a two-sided conversation in one reading column narrower than the page. A
member's message is a right-aligned tinted bubble with `2xl` radius and no border; a Companion reply
is left-aligned, unboxed rich text with copyable markdown and code. One logical turn remains one
message however many reasoning, reply, tool, and question parts it produced. Reasoning is collapsed
and never substitutes for the answer. Ordinary assistant text is the user-facing answer, not a place
for tool selection, internal planning, progress narration, or self-talk. An assistant message that
contains a Pi tool call is not projected as chat text; the later no-tool message is the visible final
answer. Updates use one short sentence and acknowledgements may be one word, while the owner's persona
continues to own voice. A tool run is a hairline
card with arguments and result folded
until asked; a visual run may carry exactly one bounded stored Box frame. Pi runs shell and file
tools without approval. `ask_user` is the one interactive card: Owner/Editor may answer or deny it,
Viewer may only read its durable result.

The durable Turn state, not browser inference, owns waiting UI. `queued` and `admitted` may show
quiet operational copy, while only a positively acknowledged active Turn says “Companion is
replying…”; `needs_input` and every terminal state stop it. A
small queue count explains why later accepted messages have not started. A blocking human decision
pauses the inactivity clock and returns control to Pi after ten minutes without treating silence as
approval. A newer member message ends the wait sooner so Pi can finish safely before that ordinary
queued turn runs. Outside `needs_input`, ten minutes without correlated activity always becomes a
visible terminal outcome; the two-hour absolute ceiling remains authoritative everywhere.

An unresolved `interrupted` card explains that delivery became ambiguous and that previous external
effects may have succeeded. It states that the prompt will not be replayed and keeps the composer
and its draft available for the next FIFO message. Runtime invalidates `Prepared`, recycles only the
captured Pi invocation, and rebuilds current staging before later work. Stable, expurgated errors
may offer only actions that remain safe for their state, such as Restart Pi or Switch model.

The transcript keeps day boundaries and one member-private `New` divider, neither inside a turn.
Loading uses static skeleton lines. A reply keeps Copy as its one ordinary action, always reachable
without hover. The composer is one field with its send control, one attach control, and one hint line, with no
toolbar: dictation/voice, slash commands, mentions, model picker, tool controls, routines,
schedules, and multi-Bot handoffs do not belong here. Attaching is part of saying something, so the
attach control sits inside the field at its leading edge, opposite Send; staged files read as chips
above the field, and a refused file says why in one line directly beneath those chips rather than in
a dialog. The hint line below the field keeps its own job: it says why Send is unavailable,
including when a message carries files but no words. Sending is the only normal wake action; typing
does not prewarm. A Viewer gets the same PostgreSQL-backed transcript with a read-only note in place
of the composer. Empty threads state what happens next instead of greeting the reader, and the
workspace sidebar remains the conversation list.

**Status dot plus label** is mandatory for health and lifecycle state. Dots are static 6px to 8px circles. No pulse, no glow, no animation.

**Badges** are compact chips for scope, lifecycle, role, validation, and status. Use mono only for machine-like values. Status badges use low-tint backgrounds and borders; neutral badges use raised surface and muted text.

**Buttons** are restrained. Primary uses signal yellow (`accent` / `accent-fg`) and appears only for the main action on the surface. Secondary buttons are hairline-bordered surface buttons. Ghost buttons are quiet utility actions. Danger buttons are reserved for destructive intent. Default control height is 36px (`cds-btn--md`); compact actions use 28px (`cds-btn--sm`); onboarding primary actions may use 40px (`cds-btn--lg`).

**Forms** use 36px controls, clear labels, one-line helper text, and visible error text. Technical inputs such as ids, env vars, paths, hosts, and resource addresses use monospace.

**Cards** are flat hairline panels on `surface` with `md` radius. Optional headers use title, description, and right-aligned actions separated by a hairline. Do not use colored decorative accents.

**Slide-over drawer** is the default detail surface. Width is about 460px on desktop and full-width on narrow screens. Header contains the resource name, status badge, and close button. Body uses definition lists, error blocks, code previews, and related resource chips. Footer contains the primary resource action and supporting actions.

**Error banners and blocks** reserve `danger-tint` and `danger-line` for failed validation or a failed
skill mutation. A recoverable synchronization problem uses `warn-tint` and keeps the safe retry or
download action visible. Put storage and validation diagnostics behind `Technical details`.
Machine output remains monospace and preserves line breaks.

**Empty states** are plain. Use a short title, one sentence of consequence, and one clear action when appropriate. No illustrations are required.

**Loading states** should be skeleton rows or quiet placeholders under text like `Waiting for first poll...`. Avoid full-screen spinners for data tables.

**Iconography** uses Lucide-style line icons: 24x24 viewBox, no fill, currentColor stroke, rounded caps and joins, around 1.75 stroke width. Icons are monochrome and support labels; they should not replace labels for unfamiliar actions. The brand mark may be a simple CSS mark or future official asset, but product UI should not invent mascots or illustrations.

## Do's and Don'ts

Do:

- Use the YAML tokens in this file as normative values.
- Build dense, scannable operator surfaces.
- Show real operational state plainly.
- Pair every status color with a text label.
- Use system fonts only.
- Render machine values literally in monospace.
- Use sentence case for UI copy.
- Use hairlines and flat surfaces for structure.
- Use slide-over drawers for resource detail.
- Keep focus states obvious and accessible.
- Keep motion short, functional, and reduceable.
- Derive Companion waiting state and exact automatic-cleanup progress from durable turns.
- Keep the composer available during automatic cleanup and state explicitly that ambiguous work is
  never replayed.
- Show Stop only for active work and Remove only for work that is truly queued. Terminal
  interruptions have no actions.

Don't:

- Do not create marketing hero dashboards.
- Do not use big-number vanity metric cards.
- Do not use gradients, gradient text, glassmorphism, backdrop blur, glow, bokeh, or decorative texture outside the native iOS 26 Liquid Glass exception above.
- Do not use emoji in product UI.
- Do not use em dashes in UI copy.
- Do not use web fonts.
- Do not use pulsing, glowing, or animated status dots.
- Do not make color the only carrier of meaning.
- Do not use modal-first detail flows when a drawer preserves context.
- Do not build generic AI SaaS visuals: purple gradient cards, sparkle icons, oversized rounded panels, or identical icon-heading-text card grids.
- Do not prettify ids, states, roles, scopes, env vars, hostnames, resource addresses, or model names.
- Do not let healthy state shout. Do not let broken state hide.
- Do not show a Wake action, keystroke prewarm, multi-Bot handoff, routine, schedule, voice,
  harness picker, or deployment control.
- Do not build a file library, a file manager, or any attachment surface outside the message it was
  sent with. Files belong to the message; there is no place to browse them. After their bytes expire,
  keep a quiet metadata-only card in that message and remove every download affordance.
