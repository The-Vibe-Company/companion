import type { CompanionAvatarValue } from "@/components/CompanionAvatar";

export type CompanionStatus = "new" | "preparing" | "ready" | "archived" | "error";
export type RunStatus = "queued" | "preparing" | "running" | "needs_input" | "succeeded" | "failed" | "interrupted" | "cancelled";
export interface Companion { id: string; name: string; instructions: string; provider: "local" | "box"; status: CompanionStatus; error: string | null; createdAt: string; avatar?: CompanionAvatarValue | null; desktopTaken?: boolean; desktopPausedAt?: string | null; prepareRequested?: boolean; runtimeVersion?: string | null; runtimeUpdateTarget?: string | null; runtimeUpdateStatus?: "pending" | "updating" | "current" | "deferred" | "failed" | "blocked"; runtimeUpdateError?: string | null; readyAt?: string | null; retiredAt?: string | null; modelId?: string | null; }
export interface AccountUser { id: string; email: string; name: string }
export interface AppConfig { localAvailable: boolean; defaultProvider?: "local" | "box"; boxAvailable: boolean; model: string; models?: Array<{ id: string; name: string; isDefault?: boolean }> }
export interface ThreadFile { id: string; runId: string; kind: "user_upload" | "agent_output"; name: string; mimeType: string; size: number; url: string }
export interface DiscussionPreview { role: "user" | "assistant"; companionId: string | null; createdAt: string; preview: string }
export interface Discussion { participantIds?: string[]; lastMessage?: DiscussionPreview | null; id: string; title: string; folderId: string | null; directCompanionId: string | null; archivedAt: string | null; createdAt: string; updatedAt: string }
export interface DiscussionFolder { id: string; name: string; companionIds: string[]; createdAt: string }
export interface DiscussionParticipant { companionId: string; removedAt: string | null; companion: Companion }
export interface DiscussionMessage { delegated?: boolean; id: string; sequence: string; role: "user" | "assistant"; content: string; companionId: string | null; runId: string; createdAt: string; complete: boolean; files: ThreadFile[] }
export interface DiscussionQuestion { id: string; question: string; options: string[]; answer: string | null }
export interface DiscussionTask { id: string; companionId: string; status: RunStatus; content: string; previewText: string | null; resultText: string | null; error: string | null; createdAt: string; finishedAt: string | null; questions: DiscussionQuestion[]; files: ThreadFile[] }
export interface CentralRun { id: string; status: RunStatus; previewText: string | null; error: string | null; createdAt: string; finishedAt: string | null }
export interface DiscussionProposal { id: string; companionId: string; reason: string; prompt: string; status: "pending" | "accepted" | "declined" }
export interface DiscussionSnapshot { discussion: Discussion; participants: DiscussionParticipant[]; messages: DiscussionMessage[]; tasks: DiscussionTask[]; centralRuns: CentralRun[]; proposals: DiscussionProposal[]; beforeCursor: string | null }

export class ApiError extends Error { constructor(message: string, public readonly status: number) { super(message); } }
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...(options?.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...options?.headers } });
  if (!response.ok) { const body = await response.json().catch(() => null) as { error?: string; message?: string } | null; throw new ApiError(body?.error || body?.message || `Request failed (${response.status})`, response.status); }
  return response.json() as Promise<T>;
}

export const api = {
  getMe: () => request<{ user: AccountUser }>("/api/me"),
  requestMagicLink: (email: string) => request<unknown>("/api/auth/sign-in/magic-link", { method: "POST", body: JSON.stringify({ email, callbackURL: "/" }) }),
  signOut: () => request<unknown>("/api/auth/sign-out", { method: "POST" }),
  getConfig: () => request<AppConfig>("/api/config"),
  getCompanions: () => request<{ companions: Companion[] }>("/api/companions"),
  getCompanion: (id: string) => request<{ companion: Companion }>(`/api/companions/${id}`),
  createCompanion: (input: Pick<Companion, "name" | "instructions" | "provider" | "avatar"> & { clientCreationId: string; prepare?: boolean }) => request<{ companion: Companion }>("/api/companions", { method: "POST", body: JSON.stringify(input) }),
  updateCompanion: (id: string, input: Partial<Pick<Companion, "name" | "instructions" | "avatar">> & { modelId?: string | null }) => request<{ companion: Companion }>(`/api/companions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteCompanion: (id: string) => request<{ deleted: true; companionIds?: string[] }>(`/api/companions/${id}`, { method: "DELETE" }),
  openDesktop: (id: string) => request<{ url?: string; preparing?: true }>(`/api/companions/${id}/desktop`, { method: "POST" }),
};

export const discussionApi = {
  list: (archived = false) => request<{ discussions: Discussion[]; folders: DiscussionFolder[] }>(`/api/discussions${archived ? "?archived=true" : ""}`),
  create: (input: { clientCreationId: string; title?: string; folderId?: string; directCompanionId?: string }) => request<{ discussion: Discussion }>("/api/discussions", { method: "POST", body: JSON.stringify(input) }),
  snapshot: (id: string, before?: string, signal?: AbortSignal) => request<DiscussionSnapshot>(`/api/discussions/${id}${before ? `?before=${encodeURIComponent(before)}` : ""}`, { signal }),
  update: (id: string, input: { title?: string; folderId?: string | null; archived?: boolean }) => request<{ discussion: Discussion }>(`/api/discussions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  directForCompanion: (id: string) => request<{ discussions: Discussion[] }>(`/api/companions/${id}/discussions`),
  createFolder: (input: { clientCreationId: string; name: string; companionIds: string[] }) => request<{ folder: DiscussionFolder }>("/api/discussion-folders", { method: "POST", body: JSON.stringify(input) }),
  updateFolder: (id: string, input: { name?: string; companionIds?: string[] }) => request<{ folder: DiscussionFolder }>(`/api/discussion-folders/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteFolder: (id: string) => request<{ ok: true }>(`/api/discussion-folders/${id}`, { method: "DELETE" }),
  addParticipant: (id: string, companionId: string) => request<{ ok: true }>(`/api/discussions/${id}/participants/${companionId}`, { method: "PUT" }),
  removeParticipant: (id: string, companionId: string) => request<{ ok: true }>(`/api/discussions/${id}/participants/${companionId}`, { method: "DELETE" }),
  sendMessage: async (id: string, input: { clientMessageId: string; content: string; targetCompanionId?: string | null; files: Array<{ file: File; id: string }> }) => {
    const result = await request<{ runId: string; discussionId: string; companionId: string | null }>(`/api/discussions/${id}/messages`, { method: "POST", body: JSON.stringify({ clientMessageId: input.clientMessageId, content: input.content, targetCompanionId: input.targetCompanionId, attachmentCount: input.files.length }) });
    for (const [position, attachment] of input.files.entries()) { const form = new FormData(); form.set("file", attachment.file); form.set("clientFileId", attachment.id); form.set("position", String(position)); await request<{ file: ThreadFile }>(`/api/discussions/${id}/runs/${result.runId}/files`, { method: "POST", body: form }); }
    return result;
  },
  cancel: (id: string) => request<{ ok: true }>(`/api/discussions/${id}/cancel`, { method: "POST" }),
  cancelCompanion: (id: string, companionId: string) => request<{ ok: true }>(`/api/discussions/${id}/participants/${companionId}/cancel`, { method: "POST" }),
  answerQuestion: (id: string, questionId: string, answer: string) => request<{ ok: true }>(`/api/discussions/${id}/questions/${questionId}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
  answerProposal: (id: string, proposalId: string, accept: boolean) => request<{ ok: true }>(`/api/discussions/${id}/proposals/${proposalId}`, { method: "POST", body: JSON.stringify({ accept }) }),
};

export interface PluginServer { id: string; name: string; description?: string; provider?: string; kind?: "oauth" | "remote" | "custom"; available: boolean }
export type PluginHealthCode = "authorization_required" | "connection_failed" | "configuration_invalid" | "agent_check_required";
export interface PluginAccount { usedBy?: Array<Pick<Companion, "id" | "name" | "avatar">>; id: string; serverId: string | null; label: string; provider?: string; healthStatus: "unchecked" | "ok" | "error" | "requires_agent"; healthCode: PluginHealthCode | null; checkedAt: string | null }
export type PluginHealthResult = Pick<PluginAccount, "id" | "healthStatus" | "healthCode" | "checkedAt">;
export interface PluginsResponse { catalog: PluginServer[]; accounts: PluginAccount[] }
export type CustomPluginInput = { label: string; transport: "http"; url: string; headers: Record<string, string> } | { label: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> };
export const workspaceApi = {
  createDelivery:(input:{clientDeliveryId:string;companionId:string;clientEmail:string;maintenanceRequested:boolean;includeSkills:boolean})=>request<{delivery:DeliverySent}>("/api/deliveries",{method:"POST",body:JSON.stringify(input)}),
  billing: () => request<BillingOverview>("/api/billing"),
  checkout: () => request<{ url: string }>("/api/billing/checkout", { method: "POST" }),
  billingPortal: () => request<{ url: string }>("/api/billing/portal", { method: "POST" }),
  deliveries: () => request<{ sent: DeliverySent[]; received: DeliveryReceived[] }>("/api/deliveries"),
  acceptDelivery: (id: string, grantMaintenance: boolean) => request<{ companionId: string; accepted: boolean }>(`/api/deliveries/${id}/accept`, { method: "POST", body: JSON.stringify({ grantMaintenance }) }),
  revokeDelivery: (id: string) => request<{ revoked: true }>(`/api/deliveries/${id}`, { method: "DELETE" }),
  revokeMaintenance: (id: string) => request<{ revoked: true }>(`/api/deliveries/${id}/maintenance`, { method: "DELETE" }),
  takeDesktop: (companionId: string) => request<unknown>(`/api/companions/${companionId}/desktop/takeover`, { method: "POST" }),
  releaseDesktop: (companionId: string) => request<unknown>(`/api/companions/${companionId}/desktop/release`, { method: "POST" }),
  maintenance: () => request<{ companions: MaintenanceCompanion[] }>("/api/maintenance"),
  maintenanceDetail: (id: string) => request<{ companion: MaintenanceDetail }>(`/api/maintenance/companions/${id}`),
  updateMaintenanceCompanion: (id: string, input: { name: string; instructions: string; modelId?: string | null }) => request<{ companion: MaintenanceDetail }>(`/api/maintenance/companions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  prepareMaintenanceCompanion: (id: string) => request<unknown>(`/api/maintenance/companions/${id}/prepare`, { method: "POST" }),
  createMaintenanceTask: (id: string, clientMessageId: string, prompt: string) => request<{ runId?: string }>(`/api/maintenance/companions/${id}/tasks`, { method: "POST", body: JSON.stringify({ clientMessageId, prompt }) }),
  maintenanceActions: (id: string) => request<{ actions: MaintenanceAction[] }>(`/api/maintenance/companions/${id}/actions`),
  plugins: () => request<PluginsResponse>("/api/plugins"),
  checkPlugin: (id: string) => request<{ account: PluginHealthResult }>(`/api/plugins/accounts/${id}/check`, { method: "POST" }),
  connectPlugin: (serverId: string, label: string) => request<{ url?: string; account?: PluginAccount }>("/api/plugins/connect", { method: "POST", body: JSON.stringify({ serverId, label }) }),
  renamePlugin: (id: string, label: string) => request<{ account: PluginAccount }>(`/api/plugins/${id}`, { method: "PATCH", body: JSON.stringify({ label }) }),
  addCustomPlugin: (input: CustomPluginInput) => request<{ id: string }>("/api/plugins/custom", { method: "POST", body: JSON.stringify(input) }),
  deletePlugin: (id: string) => request<{ ok: true }>(`/api/plugins/${id}`, { method: "DELETE" }),
  companionPlugins: (id: string) => request<{ accounts: PluginAccount[] }>(`/api/companions/${id}/plugins`),
  selectPlugin: (id: string, accountId: string) => request<{ ok: true }>(`/api/companions/${id}/plugins/${accountId}`, { method: "PUT" }),
  unselectPlugin: (id: string, accountId: string) => request<{ ok: true }>(`/api/companions/${id}/plugins/${accountId}`, { method: "DELETE" }),
};

export interface BillingOverview { configured: boolean; mode: "unconfigured" | "test" | "stripe" | "beta"; plan: "inactive" | "subscription" | "beta"; active: boolean; status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; portalAvailable: boolean; usage: Array<{ category: string; unit: string; quantity: string }> }
export type DeliverySkillsStatus = "pending" | "ready" | "error";
interface DeliveryState { status: "pending" | "accepted" | "revoked"; skillsStatus: DeliverySkillsStatus; skillsError: string | null; maintenanceRequested: boolean; expiresAt: string; acceptedAt: string | null; companionId: string | null }
export interface DeliverySent extends DeliveryState { id: string; clientEmail: string }
export interface DeliveryReceived extends DeliveryState { id: string; name: string }
export interface MaintenanceCompanion { id: string; name: string; avatar?: CompanionAvatarValue; status: string; error: string | null; grantId: string }
export interface MaintenanceDetail { id: string; name: string; instructions: string; avatar?: CompanionAvatarValue; modelId: string | null; status: string; error: string | null; readyAt: string | null }
export interface MaintenanceAction { id: string; operation: string; createdAt: string; status: string; error: string | null }
