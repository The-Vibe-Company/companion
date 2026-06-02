#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/web/server/protocol/codex-upstream"
TMP_DIR="$(mktemp -d /tmp/codex-openai-XXXXXX)"

echo "[sync-codex-protocol] cloning openai/codex into $TMP_DIR"
git clone --depth 1 https://github.com/openai/codex.git "$TMP_DIR" >/dev/null

COMMIT_SHA="$(git -C "$TMP_DIR" rev-parse HEAD)"
echo "[sync-codex-protocol] source commit: $COMMIT_SHA"

mkdir -p "$TARGET_DIR/v2"

cp "$TMP_DIR/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts" "$TARGET_DIR/ClientRequest.ts.txt"
cp "$TMP_DIR/codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts" "$TARGET_DIR/ServerRequest.ts.txt"
cp "$TMP_DIR/codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts" "$TARGET_DIR/ServerNotification.ts.txt"
cp "$TMP_DIR/codex-rs/app-server-protocol/schema/typescript/ClientNotification.ts" "$TARGET_DIR/ClientNotification.ts.txt"
cp "$TMP_DIR/codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallParams.ts" "$TARGET_DIR/v2/DynamicToolCallParams.ts.txt"
cp "$TMP_DIR/codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallResponse.ts" "$TARGET_DIR/v2/DynamicToolCallResponse.ts.txt"

cat > "$TARGET_DIR/README.md" <<EOF
Codex protocol snapshot used by offline compatibility tests.

Source repository: \`https://github.com/openai/codex\`
Source commit: \`$COMMIT_SHA\`

Copied files (stored as \`.txt\` snapshots to avoid TypeScript import resolution in this repo):
- \`codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts\` -> \`ClientRequest.ts.txt\`
- \`codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts\` -> \`ServerRequest.ts.txt\`
- \`codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts\` -> \`ServerNotification.ts.txt\`
- \`codex-rs/app-server-protocol/schema/typescript/ClientNotification.ts\` -> \`ClientNotification.ts.txt\`
- \`codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallParams.ts\` -> \`v2/DynamicToolCallParams.ts.txt\`
- \`codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallResponse.ts\` -> \`v2/DynamicToolCallResponse.ts.txt\`

Refresh these files with:

\`\`\`bash
./scripts/sync-codex-protocol.sh
\`\`\`
EOF

echo "[sync-codex-protocol] snapshot updated in $TARGET_DIR"
