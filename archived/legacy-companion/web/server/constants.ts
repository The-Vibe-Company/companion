export const DEFAULT_PORT_DEV = 3457;
export const DEFAULT_PORT_PROD = 3456;

// Container port constants — shared between routes.ts and session-creation-service.ts
export const VSCODE_EDITOR_CONTAINER_PORT = 13337;
export const CODEX_APP_SERVER_CONTAINER_PORT = Number(process.env.COMPANION_CODEX_CONTAINER_WS_PORT || "4502");
export const NOVNC_CONTAINER_PORT = 6080;
