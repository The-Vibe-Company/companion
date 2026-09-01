# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
label strings used in this repo's issue tracker (Linear; see `issue-tracker.md`).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label
string from this table.

Linear notes:

- Labels are created lazily with `issueLabelCreate` in the confirmed team the first time a role is
  applied; check `issueLabels` first so an existing label is reused.
- `issueUpdate.labelIds` replaces the whole label set, so read the issue's current labels before
  adding or removing one.
- Applying `wontfix` also moves the issue to the team's `canceled` state.

Edit the right-hand column to match whatever vocabulary you actually use.
