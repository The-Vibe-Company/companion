export const DEFAULT_PORT_DEV = 6061;
export const DEFAULT_PORT_PROD = 6060;

// Container port constants — shared between routes.ts and session-orchestrator.ts
export const VSCODE_EDITOR_CONTAINER_PORT = 13337;
export const CODEX_APP_SERVER_CONTAINER_PORT = Number(process.env.AGENTHANGAR_CODEX_CONTAINER_WS_PORT || "4502");
export const NOVNC_CONTAINER_PORT = 6080;
