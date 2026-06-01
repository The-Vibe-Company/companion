Codex protocol snapshot used by offline compatibility tests.

Source repository: `https://github.com/openai/codex`
Source commit: `cf0911076f234e0219bd8d61dd3bc2f80a2df287`

Copied files (stored as `.txt` snapshots to avoid TypeScript import resolution in this repo):
- `codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts` -> `ClientRequest.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts` -> `ServerRequest.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts` -> `ServerNotification.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/ClientNotification.ts` -> `ClientNotification.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallParams.ts` -> `v2/DynamicToolCallParams.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallResponse.ts` -> `v2/DynamicToolCallResponse.ts.txt`

Refresh these files with:

```bash
./scripts/sync-codex-protocol.sh
```
