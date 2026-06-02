Codex protocol snapshot used by offline compatibility tests.

Source repository: `https://github.com/openai/codex`
Source commit: `8a94430bb273623be42b68f144f1ab1df343bb53`

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
