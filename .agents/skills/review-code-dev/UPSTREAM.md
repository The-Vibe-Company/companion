# Upstream attribution and local changes

Source: https://github.com/alibaba/open-code-review/blob/v1.12.1/skills/open-code-review-delegate/SKILL.md
Release: v1.12.1
Commit: 1f5caf4d5b7d5324c6e4c836c971136e4010192e
Author: Alibaba / open-code-review contributors
License: Apache-2.0 (see LICENSE)

The upstream skill body is retained verbatim. Local modifications:
- Frontmatter name changed to review-code-dev to retain the existing package identity.
- Distribution setup section added before the upstream workflow: portable checksum-pinned installation and caller handoff compatibility.
- Local Python bootstrap/test files and Skillpack metadata included.
- Repository overlay added to SKILL.md for read-only operation, worktree-safe artifact preparation, redaction and explicit incomplete coverage.
- Repository compatibility helpers retained: scripts/prepare_review_run.py, scripts/collect_review_context.py and scripts/test_collect_review_context.py. These preserve tested ignore handling, credential redaction and merge-base diagnostics, not the retired v1 review workflow.

No Alibaba affiliation or endorsement is implied by this repackaging. Package version is independent of the upstream CLI and skill metadata versions.
