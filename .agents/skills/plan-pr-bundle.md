# Shared Plan PR workflow

All nine packages are committed in `.agents/skills/`. Codex discovers that directory;
Claude Code discovers the relative links in `.claude/skills/`. Both read the same files
after a normal clone, including in Linux cloud sandboxes. Prefer these repository copies
over global installations. No Skillpack account, token, setup script or package download
is needed to load the skills. Agents can also read each `SKILL.md` directly.

Ask the agent to use `plan-pr` with a prompt or ticket. It reads repository and tracker
context, proposes a plan for human approval, then the same agent implements and hands
off to `ship-pr-dev`. Use `ship-pr-dev` directly for an existing branch without a plan.
The six planning dependencies are conditional expertise, not six mandatory interviews.
Ship PR depends on `review-code-dev` and `capture-learning-tools`.

Repository instructions and existing test/launch procedures remain authoritative.
Optional team defaults belong in `docs/agents/plan-pr.md` with a validation-document
pointer; missing setup does not block planning. Keep credentials outside the repository.
Tracker access and authenticated GitHub CLI are needed only for their respective actions.
Full delivery needs Git, Python 3 and the repository's normal development prerequisites.
OCR's checksum-pinned bootstrap needs Git 2.41+, Python 3.9+, and first-run network access
on macOS or Linux; its host agent performs review without another LLM API key.

## Vendored versions

These packages were retrieved from the organization's Skillpack registry. Manifests retain
their upstream identities and dependency IDs; licenses and attribution are included.

| Skill | Version |
| --- | --- |
| `better-ui` | 1.1.0 |
| `capture-learning-tools` | 0.2.0 |
| `design-frontend-dev` | 3.2.0 |
| `emil-design-eng` | 1.1.0 |
| `grilling` | 1.1.0 |
| `plan-pr` | 1.1.0 |
| `review-code-dev` | 2.1.0 |
| `ship-pr-dev` | 1.6.0 |
| `tdd` | 1.1.0 |

## Updating

Update the complete dependency closure in `.agents/skills/`; preserve the relative Claude
links and unrelated skills. Review local adaptations before replacing a package, retain
licenses, and verify that every dependency ID resolves to the bundled manifest. Never
commit installer credentials, machine-local lockfiles, caches or generated run artifacts.

Local adaptation: Ship PR's artifact preparer retains the tested worktree-safe implementation
from the Companion repository: it checks tracked artifacts before writing, reuses existing
ignore rules, and resolves `info/exclude` with `git rev-parse --git-path` for linked worktrees.

The existing Review Code compatibility helpers, redaction/merge-base tests and documented
overlay are preserved, as are the frontend references’ whitespace fixes.

Vendored Markdown whitespace is normalized where needed for `git diff --check`.

## Activation reporting

The published `SKILL.md` files include Skillpack's generated activation-reporting block,
bound to each package's ID and version. It reports to `https://skillpack.app/v1/skill-usage`
without authentication, with optional declared identity. Set `SKILLPACK_TELEMETRY=0` or
tell the agent to disable telemetry to opt out. Reporting uses a maximum three-second
timeout, never reads credentials, and never blocks the task when unavailable.
