---
register: product
---

# PRODUCT.md

## Product Purpose

Companion is a Go control plane CLI for managing fleets of persistent "Hermes" AI agents and the tooling around them: agents deployed on Fly.io, durable "Granite" memory vaults shared between them, isolated runtimes, and access gated through a Tailscale VPN. The dashboard is the operator's fleet status surface. It is served locally during work and deployable as a tiny, stateless, Tailscale-only Fly app. Its single job is to make the live state of a fleet legible at a glance: which agents are up, which vaults they hold, what the planner intends, and what just changed. It is not a browser UI for Claude Code or Codex, and not a place to author or run prompts.

## Users

Fleet operators and developers running their own agent fleets. They are technical: they read TOML, run `plan`/`apply`, and live in a terminal. They reach the dashboard over Tailscale, often on a second monitor, glancing rather than studying. They want to confirm health and topology in seconds, then return to their work. The same surface serves a personal fleet, a client deployment, or a workspace someone else runs.

## Brand & Tone

Calm, precise, trustworthy, engineering-grade, understated. The reference points are Linear, Stripe, and Raycast: confident restraint, real data shown plainly, nothing shouting for attention. State the truth of the fleet without dressing it up. When something is healthy, it should feel quiet. When something is wrong, it should be unmistakable without alarm theater.

## Anti-references

- No marketing-hero dashboards: no big-number vanity metrics, no "welcome back" splash.
- No flashy gradients, film-grain, or decorative glass.
- No neon-on-black crypto/"command center" aesthetic.
- No generic AI-SaaS template: rounded purple cards, sparkle icons, gradient CTAs.

## Strategic principles

- **Clarity over decoration.** Every pixel reports state. If it isn't telling the operator something true, it doesn't ship.
- **Density when useful.** A fleet has many agents, vaults, and links. Show them compactly; don't pad one fact across a whole card.
- **Status legible at a glance.** Health, drift, and topology readable in under two seconds from across a room.
- **Familiarity is a feature.** Operators already know these patterns from their tools. Borrow the conventions; don't reinvent the table.
