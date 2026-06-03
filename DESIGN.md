# DESIGN.md — Companion Fleet Dashboard

Register: **product**. This is an operator tool, not marketing. The bar is earned familiarity (Linear, Stripe, Raycast). The interface disappears into the task: glance at fleet health, spot a DOWN agent, click in for detail. Calm and precise. No marketing hero, no decoration.

Scene that forces the theme: an operator glancing at fleet health from a laptop at night, over a private Tailscale network, wanting to spot a DOWN agent at a glance. Dark, Linear-grade. Color strategy: **Restrained** (tinted neutrals + one indigo accent + the semantic status set).

## Color tokens (OKLCH)

Every neutral is tinted toward the accent hue (277), chroma ~0.005–0.01. Never `#000` or `#fff`.

```css
:root {
  /* Layered cool near-black surfaces, separated by 1px hairlines */
  --surface-canvas:   oklch(0.17 0.008 277);  /* page background        */
  --surface-raised:   oklch(0.21 0.009 277);  /* panels, top bar, drawer */
  --surface-hover:    oklch(0.25 0.010 277);  /* row hover               */
  --border-hairline:  oklch(0.30 0.010 277);  /* 1px separators          */

  /* Text */
  --text-primary: oklch(0.95 0.006 277);  /* agent names, headings      */
  --text-dim:     oklch(0.74 0.008 277);  /* secondary values, labels   */
  --text-faint:   oklch(0.56 0.008 277);  /* meta, timestamps, captions */

  /* Single accent — indigo/violet (~#5e6ad2). Selection, focus, primary action ONLY */
  --accent:          oklch(0.62 0.19 277);
  --accent-hover:    oklch(0.67 0.19 277);
  --accent-ring:     oklch(0.62 0.19 277 / 0.55);  /* focus ring          */
  --accent-selected: oklch(0.62 0.19 277 / 0.14);  /* selected row tint    */

  /* Status — calm, slightly desaturated. ALWAYS paired with a text label. Static. */
  --status-ok:      oklch(0.72 0.13 152);  /* green  — healthy   */
  --status-degraded:oklch(0.78 0.13 85);   /* amber  — degraded  */
  --status-down:    oklch(0.64 0.16 25);   /* red    — down      */
  --status-unknown: oklch(0.60 0.008 277); /* grey   — unknown   */

  --scrim: oklch(0.12 0.008 277 / 0.55);   /* drawer backdrop, no blur   */
}
```

Accent is never decorative: it appears only on the focus ring, the selected row, and the primary link/action. Status colors never carry meaning alone, the text label always rides with the dot.

## Typography

No web fonts, no Google Fonts. Must work offline on a tailnet. System stacks only.

```css
--font-ui:   -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
--font-mono: ui-monospace, "SF Mono", Menlo, monospace;  /* URLs, ids, codes, states */
```

Fixed rem scale, ratio ~1.2. Hierarchy comes from weight + size contrast, not color.

| Token        | Size      | Use                                  |
|--------------|-----------|--------------------------------------|
| `--text-xs`  | 0.75rem   | meta, timestamps, badge text         |
| `--text-sm`  | 0.875rem  | row secondary values, drawer labels  |
| `--text-base`| 1rem      | agent name, drawer values, body      |
| `--text-md`  | 1.2rem    | drawer header, section titles        |
| `--text-lg`  | 1.44rem   | wordmark (kept small)                |

Weights: `400` body/dim, `500` agent names and labels, `600` wordmark and drawer header. Line length capped 65–75ch in any prose (errors).

## Spacing rhythm

4px base. Vary padding for rhythm, dense rows breathe less than the drawer.

```css
--space-1: 4px;  --space-2: 8px;  --space-3: 12px;
--space-4: 16px; --space-5: 24px; --space-6: 32px;
```

Top bar: `--space-2` vertical, `--space-4` horizontal. Agent row: `--space-3` vertical, `--space-4` horizontal. Drawer body: `--space-5`.

## Border radius

```css
--radius-sm: 4px;   /* badges, pills, status dot container */
--radius-md: 6px;   /* rows, buttons, error block          */
--radius-lg: 10px;  /* drawer panel corners (left side)    */
```

## Component vocabulary

**Top bar** — compact, single line, `--surface-raised`, hairline bottom border. Left: wordmark `Companion` (600), then `·` separators in `--text-faint` to workspace name. Right: connection pill (live / stale), `updated HH:MM:SS` in mono `--text-faint`, auto-refresh note in `--text-xs`. No hero title, no tagline.

**Summary counts** — slim inline row, not stat cards. `Total 12 · Healthy 9 · Degraded 2 · Down 1`. Numbers in `--text-primary` 500, labels in `--text-dim`. Each count label carries its status dot. No gradient cards, no hero-metric template.

**Agent row** — the core. Each row is a `<button>` (full width, `text-align:left`), dense, keyboard-navigable. Visible contents in order: status dot + LABEL, agent name (`--text-base` 500), URL (mono, truncated with ellipsis, copy affordance), tailnet online, machine state, HTTP code, model. States:
- default: `--surface-canvas`, hairline bottom divider.
- hover: `--surface-hover`, copy affordance reveals.
- focus-visible: 2px `--accent-ring` inset ring, no layout shift.
- selected (drawer open from it): `--accent-selected` background, 2px `--accent` left inset via box-shadow (not a border-left side-stripe).
- active: `--surface-hover`, no transform.

**Status dot + label** — 8px static circle in the status color, paired with its text label (`ok` / `degraded` / `down` / `unknown`). No pulse, no glow, no animation ever.

**Kind badge** — small mono uppercase chip, `--surface-hover` background, `--text-dim`, `--radius-sm`. Identifies agent kind. No icon-card grid.

**Pills** — connection pill: `live` uses `--status-ok` dot + `--text-dim` label on `--surface-hover`; `stale` uses `--status-degraded`. Status pill (drawer header) mirrors the row dot+label in the matching status color at low tint.

**Copy affordance** — ghost icon button beside any mono URL/id. default `--text-faint`, hover `--text-dim`, focus accent ring, active confirms with a brief `Copied` swap (text only, no motion of layout).

**Slide-over drawer** — right panel ~420px (`100%` on narrow screens), `--surface-raised`, `--radius-lg` on left corners, hairline left border. Built 100% client-side from the clicked service object, no extra fetch. Backdrop `--scrim`, no blur.
- Header: agent name (600) + status pill + `×` close button.
- Body: definition list of ALL fields — URL as a real clickable `<a>` (accent link) + copy button, host, fly_app, machine_state, tailnet online, model, vault, http_status, health. `error`, when present, renders in a prominent tinted block (`--status-down` at low tint, full border, mono, `--radius-md`). Labels `--text-dim` `--text-sm`, values `--text-primary`, technical values in mono.
- Footer: primary `Open service` link (accent) to the url.
- A11y: `role="dialog" aria-modal="true"`. Move focus into the drawer on open, trap focus, close on Esc and on scrim click, RETURN focus to the originating row on close.

**Drift block** — kept, lower in the page, collapsible (`<details>`). Calm and monospace: hairline-bordered region on `--surface-raised`, mono `--text-dim` content, `--radius-md`. Not alarmist.

**Empty state** — `No services in this fleet yet.` centered, `--text-dim`, no illustration.

**Loading state** — skeleton rows (hairline-bordered, `--surface-raised` shimmer-free placeholders) under the caption `Waiting for first poll…`. Not a spinner.

## Motion

- Durations 150–250ms. Ease-out only, exponential. No bounce, no elastic.
- `--ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);`
- Drawer in/out: `transform: translateX()` over ~200ms `--ease-out-quint`, scrim opacity fades alongside.
- Allowed only to convey state: drawer in/out, row hover, selection, copy confirm. Never animate layout properties (width, height, top, margin).
- `prefers-reduced-motion`: drawer appears with no slide, scrim with no fade. All hover transitions drop to instant.

## Absolute bans honored

No side-stripe colored borders (selection uses inset box-shadow, not `border-left`). No gradient text (`background-clip:text`). No decorative glassmorphism (scrim is a flat tint, no blur). No hero-metric template. No identical icon+heading+text card grid. No modal as first thought (detail uses the slide-over drawer). No em dashes in UI copy. No pulsing/glowing status dots. No web fonts. Every word of copy earns its place.
