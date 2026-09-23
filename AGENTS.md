# companions.build

This is a new product, independent of the old Companion Skills Hub. Product decisions are in
`docs/companions-build.md`; current implementation scope is in `docs/v0.md`.

- TypeScript, pinned Bun, Pi SDK, Box, PostgreSQL, React with shadcn/ui and AI Elements.
- Never install dependencies when waking an agent. Build the distribution before deployment.
- The API persists requests; the executor alone launches agents. Persist before external effects.
- An ambiguous execution must never be automatically replayed. Agent request IDs survive restart.
- PostgreSQL is the web source of truth; each agent owns its Pi transcript and local execution journal.
- Keep provider payloads and credentials out of logs, errors, docs and committed artifacts.
- Local agent shell tools run inside Docker Linux, never on the developer host.
- Use behavior tests for crash recovery, duplicate requests, cancellation and isolated histories.
- Worktree state and containers must be isolated. Never delete another workspace's resources.
- After live tests, archive every Box owned by those tests and verify its provider state is archived,
  preserving its disk. Stop owned local test stacks and tunnels when validation finishes; check
  cleanup after failures too. Keep other projects' machines untouched.
- Frontend must show real persisted states; no simulated success or cosmetic progress indicators.
- For local development, Herdr controls, service restart, scenarios or browser validation, follow
  `docs/dev-workflow.md`. Use `./dev status --json` for endpoints and current evidence, focused
  `./dev check` profiles while iterating, and full verification before integration.
- Drive browser validation with `agent-browser` (`./dev browser-test`), unless the agent is Codex,
  which uses its own browser tooling.
- Commit and PR titles use Commitizen style, e.g. `feat(chat): persist accepted messages`.
- For PR delivery, use the repository's [ship-pr-dev](.agents/skills/ship-pr-dev/SKILL.md)
  and its bundled dependencies in `.agents/skills/`, preferring these over global copies.
  Shared skill usage and prerequisites are in `docs/dev-workflow.md#shared-agent-skills`.
- Issues live in Linear project companions.build, team THE. GitHub is for code and PRs.

When parallel work helps, use independent worktrees with bounded ownership. The repository owner
requests Codex gpt-5.6-sol at medium effort for ordinary implementation tasks.
