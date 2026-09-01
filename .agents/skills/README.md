# Project skills

Skills in this folder are available to every contributor's coding agent. `.claude/skills/` holds
the same set for Claude Code; keep the two folders in sync.

## Vendored: Matt Pocock's engineering skills

The 25 skills listed in the `mattpocock-skills` plugin manifest (`ask-matt`, `code-review`,
`codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-me`, `grill-with-docs`, `grilling`,
`handoff`, `implement`, `improve-codebase-architecture`, `prototype`, `research`,
`resolving-merge-conflicts`, `setup-matt-pocock-skills`, `tdd`, `teach`, `to-questionnaire`,
`to-spec`, `to-tickets`, `triage`, `wait-what`, `wayfinder`, `wizard`, `writing-for-agents`) are
vendored from <https://github.com/mattpocock/skills>, version 1.2.3, MIT license. They read this
repo's configuration from `docs/agents/*.md`.

To update them, copy the skill folders from a newer release (or run
`npx skills@latest add mattpocock/skills`) into both `.agents/skills/` and `.claude/skills/`, then
bump the version here. If you also have the Claude Code plugin installed, disable one of the two to
avoid duplicate skill names.
