# Discussions UI contract

The web app implements the approved contract in `docs/specs/discussions.md`.

- `/` opens the latest non-direct central discussion, creating one with a stable client ID when none exists.
- `/discussions/:id` renders PostgreSQL snapshots and polls the current page. Older message pages use the exclusive `before` cursor and remain ordered before the current page.
- `/companions/:id` is a compatibility route that opens the latest active direct discussion or creates one through `POST /api/discussions`.
- A per-discussion recipient preference addresses Central or one permanent companion. Choosing or mentioning a companion is explicit authorization for that message. The recipient control appears only in a group discussion; a direct discussion is already addressed.
- The discussion list carries the last non-system message of each discussion (`lastMessage`) so the roster can show a preview and a time without opening the thread.
- The thread shows one activity line per active run plus open questions, pending invitations and a failure that answers the last sent message. Completed work, previews and earlier delegated replies are read in the companion workbench, opened from the line's avatar.
- Composer text, request ID, target, attachment metadata, and upload IDs survive retry. File bytes must be reattached after a page reload.
- Central cancellation and per-companion cancellation are separate controls. Removing a participant and archiving a discussion never imply cancellation.
- The browser only renders persisted message, task, question, proposal, file, and run states returned by the discussion snapshot.

Global application accounts and permanent companion configuration remain available. Specialist, template, team, routine, and trigger interfaces are retired.
