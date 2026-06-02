# Review Focus
Prioritize bugs, protocol regressions, state-loss risks, security flaws, and missing tests tied to changed behavior.
Avoid style-only nitpicks unless they hide correctness issues.

# Backend Testing
@scope web/server/**/*.ts
For backend behavior changes, require matching Vitest coverage in `web/server/*.test.ts` for success paths, failure paths, and edge cases.

# Frontend Testing
@scope web/src/**/*.ts web/src/**/*.tsx
For frontend behavior changes, require matching tests in `web/src/**/*.test.ts(x)` and avoid introducing client/server type drift.

# Playground Coverage
@scope web/src/components/**/*.tsx
When changing message/chat-flow components (`MessageBubble`, `ToolBlock`, `PermissionBanner`, `Composer`, `MessageFeed`, `ChatView`, streaming/tool states), ensure playground mocks are updated in `web/src/components/Playground.tsx`.

# WebSocket Contract Safety
@scope web/server/ws-bridge.ts web/server/session-types.ts web/src/ws.ts web/src/store.ts
Treat WebSocket message shapes and event semantics as a compatibility contract. Flag dropped or renamed fields, reordered state transitions, or reconnect behavior changes without explicit migration and tests.

# Session Persistence
@scope web/server/session-store.ts web/server/cli-launcher.ts web/server/ws-bridge.ts web/server/session-types.ts
Session persistence must remain backward compatible across restart and resume flows. New persisted fields need safe defaults, and old persisted data must still load.

# Security Baseline
@scope web/server/routes.ts web/server/cli-launcher.ts web/server/container-manager.ts web/server/path-resolver.ts web/server/git-utils.ts
Flag command injection, path traversal, unsafe shell interpolation, or unvalidated filesystem writes. Prefer explicit allowlists, path normalization, and argument-array process spawning.

# Codex and Claude Compatibility
@scope web/server/**/*.ts web/src/**/*.ts web/src/**/*.tsx
Features must work for both Codex and Claude Code. If implemented for only one backend, require clear UI gating and disabled or hidden incompatible actions.

# Additional Context
@scope web/server/**/*.ts
This backend bridges browser and CLI WebSockets with per-session state. Reconnection, permission pending state, and message history durability are critical.

@scope web/src/**/*.tsx web/src/**/*.ts
Frontend uses Zustand state keyed by session ID and relies on typed WebSocket events. Review for stale state, race conditions, and multi-session bleed-through.

@scope web/server/protocol/**/*.ts web/server/protocol/**/*.txt
Protocol snapshots represent upstream contracts. Prioritize drift detection and adapter safety over formatting concerns.
