# Claude Upstream Snapshot

This folder contains an offline snapshot of the official Claude Agent SDK TypeScript
surface used by the bridge compatibility tests.

Source package:
- `@anthropic-ai/claude-agent-sdk@0.2.41`
- tarball: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.2.41.tgz`

Files:
- `sdk.d.ts.txt` — copied from `package/sdk.d.ts` in the npm tarball

Refresh command (example):
```bash
TARBALL=$(npm view @anthropic-ai/claude-agent-sdk dist.tarball)
curl -fsSL "$TARBALL" -o /tmp/claude-agent-sdk.tgz
tar -xzf /tmp/claude-agent-sdk.tgz -C /tmp package/sdk.d.ts
cp /tmp/package/sdk.d.ts web/server/protocol/claude-upstream/sdk.d.ts.txt
```
