import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as contextModule from "./context";
import type { ApiVariables } from "./context";
import type { CompanionThread } from "@companion/contracts";
import {
  CompanionMcpBrokerAuthorizationError,
  CompanionTriggerDecisionUpdateError,
  CompanionTriggerNotFoundError,
  composeTriggerPrompt,
  triggerFireMessageId,
} from "@companion/core";
import * as coreModule from "@companion/core";
import * as dbModule from "@companion/db";
import * as storageModule from "@companion/storage";
import * as desktopModule from "./runtimeDesktopClient";

const COMPANION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const RETRY_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "66666666-6666-4666-8666-666666666666";
const INSTALLATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRIGGER_ID = "99999999-9999-4999-8999-999999999999";
const SECTION_ID = "77777777-7777-4777-8777-777777777777";
const TRIGGER_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = "2026-08-17T00:00:00.000Z";

type TestJsonValue = string | number | boolean | null | TestJsonValue[] | TestJsonObject;
interface TestJsonObject {
  [key: string]: TestJsonValue;
}

const contextMocks = {
  actorFromContext: vi.fn<typeof contextModule.actorFromContext>(),
  jsonError: vi.fn<typeof contextModule.jsonError>(),
  orgIdFromContext: vi.fn<typeof contextModule.orgIdFromContext>(),
};

const coreMocks = {
  answerCompanionConfigDecision: vi.fn<typeof coreModule.answerCompanionConfigDecision>(),
  answerCompanionDecision: vi.fn<typeof coreModule.answerCompanionDecision>(),
  readCompanionAttachment: vi.fn<typeof coreModule.readCompanionAttachment>(),
  cancelCompanionTurn: vi.fn<typeof coreModule.cancelCompanionTurn>(),
  createCompanionWithRuntime: vi.fn<typeof coreModule.createCompanionWithRuntime>(),
  duplicateCompanionWithRuntime: vi.fn<typeof coreModule.duplicateCompanionWithRuntime>(),
  desireCompanionLifecycleV3: vi.fn<typeof coreModule.desireCompanionLifecycleV3>(),
  enqueueCompanionTurn: vi.fn<typeof coreModule.enqueueCompanionTurn>(),
  getCompanionDecision: vi.fn<typeof coreModule.getCompanionDecision>(),
  getCompanionRoutineRun: vi.fn<typeof coreModule.getCompanionRoutineRun>(),
  getCompanionRuntimeView: vi.fn<typeof coreModule.getCompanionRuntimeView>(),
  listCompanionRuntimeViews: vi.fn<typeof coreModule.listCompanionRuntimeViews>(),
  listCompanionRoutines: vi.fn<typeof coreModule.listCompanionRoutines>(),
  listCompanionRoutineRuns: vi.fn<typeof coreModule.listCompanionRoutineRuns>(),
  createCompanionRoutine: vi.fn<typeof coreModule.createCompanionRoutine>(),
  updateCompanionRoutine: vi.fn<typeof coreModule.updateCompanionRoutine>(),
  deleteCompanionRoutine: vi.fn<typeof coreModule.deleteCompanionRoutine>(),
  answerCompanionRoutineDecision: vi.fn<typeof coreModule.answerCompanionRoutineDecision>(),
  listCompanionTriggers: vi.fn<typeof coreModule.listCompanionTriggers>(),
  listCompanionTriggerProviderAccounts: vi.fn<typeof coreModule.listCompanionTriggerProviderAccounts>(),
  saveCompanionTriggerProviderAccount: vi.fn<typeof coreModule.saveCompanionTriggerProviderAccount>(),
  disconnectCompanionTriggerProviderAccount: vi.fn<typeof coreModule.disconnectCompanionTriggerProviderAccount>(),
  ensureOAuthCompanionTriggerProviderAccount: vi.fn<typeof coreModule.ensureOAuthCompanionTriggerProviderAccount>(),
  listCompanionTriggerRuns: vi.fn<typeof coreModule.listCompanionTriggerRuns>(),
  getCompanionTriggerRun: vi.fn<typeof coreModule.getCompanionTriggerRun>(),
  createCompanionTrigger: vi.fn<typeof coreModule.createCompanionTrigger>(),
  updateCompanionTrigger: vi.fn<typeof coreModule.updateCompanionTrigger>(),
  deleteCompanionTrigger: vi.fn<typeof coreModule.deleteCompanionTrigger>(),
  rotateCompanionTriggerSecret: vi.fn<typeof coreModule.rotateCompanionTriggerSecret>(),
  answerCompanionTriggerDecision: vi.fn<typeof coreModule.answerCompanionTriggerDecision>(),
  registerCompanionTriggerWebhook: vi.fn<typeof coreModule.registerCompanionTriggerWebhook>(),
  unregisterCompanionTriggerWebhook: vi.fn<typeof coreModule.unregisterCompanionTriggerWebhook>(),
  getCompanionTriggerForWebhook: vi.fn<typeof coreModule.getCompanionTriggerForWebhook>(),
  fireCompanionTrigger: vi.fn<typeof coreModule.fireCompanionTrigger>(),
  failCompanionTriggerFire: vi.fn<typeof coreModule.failCompanionTriggerFire>(),
  readCompanionThreadChanges: vi.fn<typeof coreModule.readCompanionThreadChanges>(),
  readCompanionThreadProjectionSequence:
    vi.fn<typeof coreModule.readCompanionThreadProjectionSequence>(),
  readCompanionThreadWindow: vi.fn<typeof coreModule.readCompanionThreadWindow>(),
  readCompanionThread: vi.fn<typeof coreModule.readCompanionThread>(),
  syncCompanionThread: vi.fn<typeof coreModule.syncCompanionThread>(),
  setCompanionProvider: vi.fn<typeof coreModule.setCompanionProvider>(),
  setCompanionWorkspaceShare: vi.fn<typeof coreModule.setCompanionWorkspaceShare>(),
  updateCompanionMemberState: vi.fn<typeof coreModule.updateCompanionMemberState>(),
  updateCompanionWithRuntime: vi.fn<typeof coreModule.updateCompanionWithRuntime>(),
  resolveCompanionMcpBrokerAuthorization: vi.fn<typeof coreModule.resolveCompanionMcpBrokerAuthorization>(),
  resolveCompanionControlAuthorization: vi.fn<typeof coreModule.resolveCompanionControlAuthorization>(),
  getCompanionControlRequest: vi.fn<typeof coreModule.getCompanionControlRequest>(),
  decideCompanionControlRequest: vi.fn<typeof coreModule.decideCompanionControlRequest>(),
  finishCompanionControlRequest: vi.fn<typeof coreModule.finishCompanionControlRequest>(),
  enqueueCompanionControlContinuation: vi.fn<typeof coreModule.enqueueCompanionControlContinuation>(),
  grantCompanionPeerAccess: vi.fn<typeof coreModule.grantCompanionPeerAccess>(),
  listCompanionControlPeers: vi.fn<typeof coreModule.listCompanionControlPeers>(),
  revokeCompanionPeerAccess: vi.fn<typeof coreModule.revokeCompanionPeerAccess>(),
  updateCompanionControlPlugin: vi.fn<typeof coreModule.updateCompanionControlPlugin>(),
  issueCompanionMcpAccessToken: vi.fn<typeof coreModule.issueCompanionMcpAccessToken>(),
  registerCompanionNotificationDevice: vi.fn<typeof coreModule.registerCompanionNotificationDevice>(),
  unregisterCompanionNotificationDevice: vi.fn<typeof coreModule.unregisterCompanionNotificationDevice>(),
  listCompanionSections: vi.fn<typeof coreModule.listCompanionSections>(),
  createCompanionSection: vi.fn<typeof coreModule.createCompanionSection>(),
  updateCompanionSection: vi.fn<typeof coreModule.updateCompanionSection>(),
  deleteCompanionSection: vi.fn<typeof coreModule.deleteCompanionSection>(),
  reorderCompanionSections: vi.fn<typeof coreModule.reorderCompanionSections>(),
  assignCompanionSection: vi.fn<typeof coreModule.assignCompanionSection>(),
};

const desktopMocks = {
  mintCompanionDesktop: vi.fn<typeof desktopModule.mintCompanionDesktop>(),
};

const storageMocks = {
  putSkillArchive: vi.fn<typeof storageModule.putSkillArchive>(),
  getSkillArchive: vi.fn<typeof storageModule.getSkillArchive>(),
  deleteStorageObject: vi.fn<typeof storageModule.deleteStorageObject>(),
};

async function testWithTenantContext<T>(
  _input: { orgId: string; userId: string },
  fn: (database: typeof dbModule.db) => Promise<T>,
): Promise<T> {
  return await fn(dbModule.db);
}

const {
  registerCompanionRoutes: registerCompanionRoutesImpl,
  registerCompanionTriggerWebhookRoutes,
} = await import("./companionRoutes");

const owner = {
  id: "user-1",
  email: "owner@example.test",
  name: "Owner",
};

const companion = {
  id: COMPANION_ID,
  name: "Research",
  persona: "Check every source.",
  model_id: "claude-opus-4-8",
  selected_skill_ids: [],
  can_write_skills: false,
  selected_mcp_account_ids: [],
  owner_id: owner.id,
  access: "owner" as const,
  pinned: false,
  hidden: false,
  muted: false,
  unread: false,
  last_message: null,
  runtime: {
    generation: 7,
    state: "running" as const,
    daemon_state: "running" as const,
    box_id: "bx_runtime_v2",
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 14,
    desktop_available: true,
    replying: false,
    last_error: null,
    skills_revision: 1,
    skills_applied_revision: 1,
    skills_applied_at: NOW,
    skills_last_error: null,
    last_observed_at: NOW,
    last_started_at: NOW,
    last_stopped_at: null,
    latest_operation: null,
  },
  created_at: NOW,
  updated_at: NOW,
};

const section = {
  id: SECTION_ID,
  org_id: ORG_ID,
  owner_id: owner.id,
  name: "Work",
  position: 0,
  created_at: NOW,
  updated_at: NOW,
};

const triggerProviderAccount = {
  id: "88888888-8888-4888-8888-888888888888",
  provider: "github" as const,
  label: "GitHub",
  credential_source: "mcp_oauth" as const,
  mcp_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "connected" as const,
  dependent_trigger_count: 2,
  created_at: NOW,
  updated_at: NOW,
};

const proposedGithubTrigger = {
  id: TRIGGER_ID,
  companion_id: COMPANION_ID,
  name: "CI failed on main",
  prompt: "Investigate the failing workflow.",
  mode: "relay" as const,
  provider: "github" as const,
  provider_account_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  target: { repo: "acme/widgets", events: ["push"] },
  registration_status: "unregistered" as const,
  remote_hook_id: null,
  remote_hook_account_id: null,
  last_registration_error: null,
  enabled: true,
  webhook_url: `http://127.0.0.1:3000/v1/hooks/triggers/${TRIGGER_ID}/${TRIGGER_SECRET}`,
  last_fired_at: null,
  last_error_code: null,
  last_error_message: null,
  last_error_at: null,
  consecutive_failures: 0,
  created_at: NOW,
  updated_at: NOW,
};

const turn = {
  id: TURN_ID,
  companion_id: COMPANION_ID,
  client_message_id: MESSAGE_ID,
  status: "queued" as const,
  queue_sequence: 1,
  latest_attempt: null,
  replying: false,
  error: null,
  state_changed_at: NOW,
  settled_at: null,
  created_at: NOW,
  updated_at: NOW,
};

const cancelledTurn = {
  ...turn,
  status: "cancelled" as const,
  settled_at: NOW,
};

const thread = {
  companion_id: COMPANION_ID,
  viewer_id: owner.id,
  access: "owner" as const,
  read_only: false,
  can_send: true,
  entries: [],
  active_turn: null,
  queued_count: 1,
  interrupted_turn: null,
  last_message_at: NOW,
  last_read_ordinal: null,
};
const { entries: omittedThreadEntries, ...threadMetadata } = thread;
void omittedThreadEntries;

const projectedThread = {
  ...thread,
  transcription_available: true,
};

function threadEntry(
  eventId: string,
  ordinal: number,
  content: string,
  queued = false,
) {
  return {
    event_id: eventId,
    ordinal,
    role: "user" as const,
    content,
    reasoning: null,
    author_id: owner.id,
    author_name: owner.name,
    tool: null,
    decision: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued,
    attachments: [],
    created_at: NOW,
  };
}

const operatorTurnError = {
  code: "provider_account_revoked",
  message: "Provider account acct_internal_42 rejected credential generation 17.",
  action: "reconnect_provider" as const,
};

const operatorAttemptError = {
  code: "pi_process_crashed",
  message: "Pi exited after reading /root/.config/provider-private.json.",
  action: "restart_pi" as const,
};

const interruptedTurn = {
  ...turn,
  status: "interrupted" as const,
  latest_attempt: {
    id: "77777777-7777-4777-8777-777777777777",
    turn_id: TURN_ID,
    attempt_number: 1,
    retry_id: null,
    status: "interrupted" as const,
    dispatch_state: "ambiguous" as const,
    pi_invocation_id: "pi-invocation-operator-only",
    dispatch_accepted_at: null,
    error: operatorAttemptError,
    started_at: NOW,
    settled_at: NOW,
  },
  error: operatorTurnError,
  settled_at: NOW,
};

function threadWithInterruptedTurn(access: "owner" | "editor" | "viewer") {
  return {
    ...thread,
    access,
    read_only: access === "viewer",
    can_send: access !== "viewer",
    interrupted_turn: interruptedTurn,
  };
}

function registerCompanionRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  env: NodeJS.ProcessEnv = {},
  withTenantContext: typeof dbModule.withTenantContext = testWithTenantContext,
): void {
  registerCompanionRoutesImpl(app, {
    COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
    COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    COMPANION_GEMINI_TRANSCRIPTION_API_KEY: "google-global-transcription-key",
    ...env,
  }, {
    ...contextMocks,
    ...coreMocks,
    ...desktopMocks,
    ...storageMocks,
    withTenantContext,
  });
}

function appWithRoutes() {
  const app = new Hono<{ Variables: ApiVariables }>();
  registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });
  return app;
}

function jsonPost(path: string, body: TestJsonValue): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonPut(path: string, body: TestJsonValue): Request {
  return new Request(`http://localhost${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Companions Runtime v2 API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextMocks.actorFromContext.mockReturnValue(owner);
    contextMocks.orgIdFromContext.mockResolvedValue(ORG_ID);
    contextMocks.jsonError.mockImplementation((_context, error, status = 400) => {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, error: message }, { status });
    });
    coreMocks.listCompanionRuntimeViews.mockResolvedValue([companion]);
    coreMocks.listCompanionSections.mockResolvedValue([section]);
    coreMocks.createCompanionSection.mockResolvedValue(section);
    coreMocks.updateCompanionSection.mockResolvedValue(section);
    coreMocks.deleteCompanionSection.mockResolvedValue(2);
    coreMocks.reorderCompanionSections.mockResolvedValue([section]);
    coreMocks.assignCompanionSection.mockResolvedValue({ ...companion, section_id: SECTION_ID });
    coreMocks.getCompanionRuntimeView.mockResolvedValue(companion);
    coreMocks.readCompanionThread.mockResolvedValue(thread);
    coreMocks.syncCompanionThread.mockResolvedValue(thread);
    coreMocks.readCompanionThreadProjectionSequence.mockResolvedValue(0n);
    coreMocks.readCompanionThreadWindow.mockResolvedValue({
      thread: threadMetadata,
      entries: [],
      older_cursor: null,
      sync_cursor: coreModule.buildCompanionThreadSequenceCursor({
        orgId: ORG_ID,
        actorId: owner.id,
        companionId: COMPANION_ID,
        sequence: 0n,
      }),
      notify_returns: [],
    });
    coreMocks.readCompanionThreadChanges.mockResolvedValue({
      cursor: coreModule.buildCompanionThreadSequenceCursor({
        orgId: ORG_ID,
        actorId: owner.id,
        companionId: COMPANION_ID,
        sequence: 0n,
      }),
      reset_entries: false,
      changed_entries: [],
      deleted_event_ids: [],
      thread: threadMetadata,
      has_more: false,
      notify_returns: [],
    });
    coreMocks.createCompanionWithRuntime.mockResolvedValue(companion);
    coreMocks.duplicateCompanionWithRuntime.mockResolvedValue(companion);
    coreMocks.updateCompanionWithRuntime.mockResolvedValue(companion);
    coreMocks.updateCompanionMemberState.mockResolvedValue(companion);
    coreMocks.setCompanionProvider.mockResolvedValue(companion);
    coreMocks.setCompanionWorkspaceShare.mockResolvedValue({
      companion_id: COMPANION_ID,
      workspace_role: null,
    });
    coreMocks.enqueueCompanionTurn.mockResolvedValue({
      turn,
      replayed: false,
    });
    coreMocks.desireCompanionLifecycleV3.mockResolvedValue({
      intent: "delete",
      revision: "1",
    });
    coreMocks.cancelCompanionTurn.mockResolvedValue(cancelledTurn);
    coreMocks.answerCompanionDecision.mockResolvedValue(undefined);
    coreMocks.readCompanionAttachment.mockResolvedValue({
      storageKey: `companion-attachments/${ORG_ID}/${COMPANION_ID}/${MESSAGE_ID}/0-${"a".repeat(64)}`,
      contentType: "image/png",
      byteSize: 4,
      filename: "chart.png",
      kind: "user_upload",
      availability: "available",
      expiresAt: "2026-09-23T12:00:00.000Z",
    });
    storageMocks.putSkillArchive.mockResolvedValue(null);
    storageMocks.deleteStorageObject.mockResolvedValue(undefined);
    storageMocks.getSkillArchive.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    coreMocks.answerCompanionConfigDecision.mockResolvedValue(undefined);
    coreMocks.answerCompanionRoutineDecision.mockResolvedValue(null);
    coreMocks.listCompanionRoutines.mockResolvedValue([]);
    coreMocks.listCompanionRoutineRuns.mockResolvedValue({ runs: [], next_cursor: null });
    coreMocks.answerCompanionTriggerDecision.mockResolvedValue(undefined);
    coreMocks.listCompanionTriggers.mockResolvedValue([]);
    coreMocks.listCompanionTriggerProviderAccounts.mockResolvedValue([triggerProviderAccount]);
    coreMocks.saveCompanionTriggerProviderAccount.mockResolvedValue(triggerProviderAccount);
    coreMocks.disconnectCompanionTriggerProviderAccount.mockResolvedValue({
      ...triggerProviderAccount,
      status: "disconnected",
      mcp_account_id: null,
    });
    coreMocks.getCompanionDecision.mockResolvedValue({
      requestKey: "question-1",
      requestKind: "question",
      decisionStatus: "pending",
      proposal: null,
      expiresAt: NOW,
    });
    desktopMocks.mintCompanionDesktop.mockResolvedValue({
      desktop_url: "https://desktop.example.test/session",
      provisioning: false,
      automation: "lux",
      transport: "webrtc",
    });
    coreMocks.resolveCompanionMcpBrokerAuthorization.mockResolvedValue(null);
    coreMocks.resolveCompanionControlAuthorization.mockResolvedValue(null);
    coreMocks.getCompanionControlRequest.mockResolvedValue(null);
    coreMocks.listCompanionControlPeers.mockResolvedValue([]);
    coreMocks.issueCompanionMcpAccessToken.mockResolvedValue({
      access_token: "temporary-access",
      token_type: "Bearer",
      expires_at: "2026-08-17T00:15:00.000Z",
      credential_version: 4,
    });
  });

  it("lists, connects, and disconnects member-wide trigger provider accounts", async () => {
    const app = appWithRoutes();
    const listed = await app.request("/v1/companion-trigger-provider-accounts");
    const created = await app.request(jsonPost("/v1/companion-trigger-provider-accounts", {
      provider: "linear",
      label: "Linear",
      credential: "lin_api_test",
    }));
    const disconnected = await app.request(
      `/v1/companion-trigger-provider-accounts/${triggerProviderAccount.id}`,
      { method: "DELETE" },
    );

    expect([listed.status, created.status, disconnected.status]).toEqual([200, 201, 200]);
    await expect(listed.json()).resolves.toEqual({ accounts: [triggerProviderAccount] });
    expect(coreMocks.saveCompanionTriggerProviderAccount).toHaveBeenCalledWith(expect.objectContaining({
      account: { provider: "linear", label: "Linear", credential: "lin_api_test" },
    }));
    await expect(disconnected.json()).resolves.toEqual({
      account: { ...triggerProviderAccount, status: "disconnected", mcp_account_id: null },
    });
  });

  it("registers and unregisters an iOS notification installation without returning its token", async () => {
    const app = appWithRoutes();
    const deviceToken = "ab".repeat(32);
    const registration = {
      platform: "ios" as const,
      device_token: deviceToken,
      environment: "sandbox" as const,
      bundle_id: "dev.companion.mobile.dev" as const,
    };
    const put = await app.request(jsonPut(
      `/v1/notification-devices/${INSTALLATION_ID}`,
      registration,
    ));
    expect(put.status).toBe(204);
    expect(await put.text()).toBe("");
    expect(coreMocks.registerCompanionNotificationDevice).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      installationId: INSTALLATION_ID,
      registration,
    }));

    const deleted = await app.request(new Request(
      `http://localhost/v1/notification-devices/${INSTALLATION_ID}`,
      { method: "DELETE" },
    ));
    expect(deleted.status).toBe(204);
    expect(coreMocks.unregisterCompanionNotificationDevice).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      installationId: INSTALLATION_ID,
    }));
  });

  it("routes section CRUD, exact reorder, and Companion assignment through tenant capabilities", async () => {
    const app = appWithRoutes();
    const listed = await app.request("/v1/companion-sections");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ sections: [section] });

    const created = await app.request(jsonPost("/v1/companion-sections", { name: "Work" }));
    expect(created.status).toBe(201);
    expect(coreMocks.createCompanionSection).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      name: "Work",
    }));

    const reordered = await app.request(jsonPut("/v1/companion-sections/reorder", {
      section_ids: [SECTION_ID],
    }));
    expect(reordered.status).toBe(200);
    expect(coreMocks.reorderCompanionSections).toHaveBeenCalledWith(expect.objectContaining({
      sectionIds: [SECTION_ID],
    }));

    const assigned = await app.request(jsonPut(`/v1/companions/${COMPANION_ID}/section`, {
      section_id: SECTION_ID,
    }));
    expect(assigned.status).toBe(200);
    expect(coreMocks.assignCompanionSection).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      sectionId: SECTION_ID,
    }));

    const deleted = await app.request(`/v1/companion-sections/${SECTION_ID}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, unassigned_count: 2 });
  });

  it("treats a nullable section_id on the dedicated assignment route as an unassign", async () => {
    const app = appWithRoutes();
    coreMocks.assignCompanionSection.mockResolvedValue({ ...companion, section_id: null });

    const response = await app.request(jsonPut(`/v1/companions/${COMPANION_ID}/section`, {
      section_id: null,
    }));

    expect(response.status).toBe(200);
    expect(coreMocks.assignCompanionSection).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      sectionId: null,
    }));
  });

  it("rejects malformed and duplicate section reorder ids before database access", async () => {
    const response = await appWithRoutes().request(jsonPut("/v1/companion-sections/reorder", {
      section_ids: [SECTION_ID, SECTION_ID],
    }));
    expect(response.status).toBe(400);
    expect(coreMocks.reorderCompanionSections).not.toHaveBeenCalled();
  });

  it("rejects invalid tokens and mismatched APNs targets", async () => {
    const app = appWithRoutes();
    const invalidToken = await app.request(jsonPut(
      `/v1/notification-devices/${INSTALLATION_ID}`,
      {
        platform: "ios",
        device_token: "secret-token",
        environment: "sandbox",
        bundle_id: "dev.companion.mobile.dev",
      },
    ));
    expect(invalidToken.status).toBe(400);

    const mismatchedTarget = await app.request(jsonPut(
      `/v1/notification-devices/${INSTALLATION_ID}`,
      {
        platform: "ios",
        device_token: "cd".repeat(32),
        environment: "production",
        bundle_id: "dev.companion.mobile.dev",
      },
    ));
    expect(mismatchedTarget.status).toBe(400);
    expect(coreMocks.registerCompanionNotificationDevice).not.toHaveBeenCalled();
  });

  it("never reflects a notification token from a persistence failure", async () => {
    const deviceToken = "ef".repeat(32);
    coreMocks.registerCompanionNotificationDevice.mockRejectedValueOnce(
      new Error(`database rejected bound parameter ${deviceToken}`),
    );

    const response = await appWithRoutes().request(jsonPut(
      `/v1/notification-devices/${INSTALLATION_ID}`,
      {
        platform: "ios",
        device_token: deviceToken,
        environment: "sandbox",
        bundle_id: "dev.companion.mobile.dev",
      },
    ));
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toBe('{"error":"Notification device request failed"}');
    expect(body).not.toContain(deviceToken);
    expect(contextMocks.jsonError).not.toHaveBeenCalled();
  });

  it("vends MCP access only to the dedicated runtime capability and never to sessions or ordinary tokens", async () => {
    const app = appWithRoutes();
    const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const credentialGeneration = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const capability = `cmp_mcp_${"a".repeat(48)}`;
    const body = {
      account_id: accountId,
      credential_generation: credentialGeneration,
      force_refresh: false,
    };

    const deniedHeaders: Array<Record<string, string>> = [
      { cookie: "companion_session=session-value" },
      { authorization: "Bearer cmp_pat_ordinary" },
      { authorization: "Bearer cmp_agent_auth" },
    ];
    for (const headers of deniedHeaders) {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("content-type", "application/json");
      const denied = await app.request("/v1/runtime/mcp-access-token", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("cache-control")).toBe("private, no-store");
      expect(JSON.stringify(await denied.json())).not.toContain("temporary-access");
    }

    coreMocks.resolveCompanionMcpBrokerAuthorization.mockResolvedValue({
      orgId: ORG_ID,
      companionId: COMPANION_ID,
      actorId: owner.id,
      accountRefs: [{ account_id: accountId, credential_generation: credentialGeneration }],
    });
    const accepted = await app.request("/v1/runtime/mcp-access-token", {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store");
    expect(accepted.headers.get("pragma")).toBe("no-cache");
    expect(await accepted.json()).toEqual({
      access_token: "temporary-access",
      token_type: "Bearer",
      expires_at: "2026-08-17T00:15:00.000Z",
      credential_version: 4,
    });
    expect(coreMocks.issueCompanionMcpAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      accountId,
      credentialGeneration,
      forceRefresh: false,
    }));

    coreMocks.issueCompanionMcpAccessToken.mockRejectedValueOnce(
      new CompanionMcpBrokerAuthorizationError(),
    );
    const unselected = await app.request("/v1/runtime/mcp-access-token", {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, account_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    });
    expect(unselected.status).toBe(401);

    let transactionCommitted = false;
    const commitAfterCallback: typeof dbModule.withTenantContext = async (_input, action) => {
      const result = await action(dbModule.db);
      transactionCommitted = true;
      return result;
    };
    const revokedApp = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(
      revokedApp,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      commitAfterCallback,
    );
    coreMocks.issueCompanionMcpAccessToken.mockResolvedValueOnce(null);
    const revoked = await revokedApp.request("/v1/runtime/mcp-access-token", {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(transactionCommitted).toBe(true);
    expect(revoked.status).toBe(503);
    expect(revoked.headers.get("cache-control")).toBe("private, no-store");
    expect(await revoked.json()).toEqual({ error: "MCP authorization could not be refreshed" });
  });

  it("registers nothing unless both the feature flag and allowlist are configured", async () => {
    const flagOff = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(flagOff, {});
    expect((await flagOff.request("/v1/companions")).status).toBe(404);
    expect((await flagOff.request(`/v1/notification-devices/${INSTALLATION_ID}`)).status).toBe(404);

    const noAllowlist = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutesImpl(noAllowlist, { COMPANION_COMPANIONS_ENABLED: "true" });
    expect((await noAllowlist.request("/v1/companions")).status).toBe(404);
    expect((await noAllowlist.request(`/v1/notification-devices/${INSTALLATION_ID}`)).status).toBe(404);
    expect(contextMocks.actorFromContext).not.toHaveBeenCalled();
  });

  it("rejects a user outside the allowlist before resolving a tenant", async () => {
    contextMocks.actorFromContext.mockReturnValue({ ...owner, email: "owner@blocked.test" });
    const response = await appWithRoutes().request("/v1/companions");
    expect(response.status).toBe(403);
    expect(contextMocks.orgIdFromContext).not.toHaveBeenCalled();
    expect(coreMocks.listCompanionRuntimeViews).not.toHaveBeenCalled();
  });

  it("serves list, detail, thread, and runtime projections from PostgreSQL only", async () => {
    const app = appWithRoutes();

    const responses = await Promise.all([
      app.request("/v1/companions"),
      app.request(`/v1/companions/${COMPANION_ID}`),
      app.request(`/v1/companions/${COMPANION_ID}/thread`),
      app.request(`/v1/companions/${COMPANION_ID}/runtime`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    await expect(responses[2]!.json()).resolves.toEqual({
      thread: { ...thread, transcription_available: true },
    });
    expect(await responses[3]!.json()).toEqual({ companion });
    expect(coreMocks.listCompanionRuntimeViews).toHaveBeenCalledWith(expect.objectContaining({
      withLastMessage: true,
    }));
    expect(coreMocks.getCompanionRuntimeView).toHaveBeenCalledTimes(2);
    expect(coreMocks.readCompanionThread).toHaveBeenCalledOnce();
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("serves the complete roster initially and an empty replay-safe delta when unchanged", async () => {
    const app = appWithRoutes();
    const initialResponse = await app.request("/v1/companions/sync");
    // SAFETY: The route returns the object shape asserted by the local response fixture below.
    const initial = await initialResponse.json() as {
      cursor: string;
      changed_companions: typeof companion[];
      deleted_companion_ids: string[];
      changed_sections: typeof section[];
      deleted_section_ids: string[];
    };

    expect(initialResponse.status).toBe(200);
    expect(initial.changed_companions).toEqual([companion]);
    expect(initial.changed_sections).toEqual([section]);
    expect(initial.deleted_companion_ids).toEqual([]);
    expect(initial.deleted_section_ids).toEqual([]);
    expect(initialResponse.headers.get("cache-control")).toBe("private, no-store");

    const unchangedResponse = await app.request(
      `/v1/companions/sync?cursor=${encodeURIComponent(initial.cursor)}`,
    );
    expect(unchangedResponse.status).toBe(200);
    await expect(unchangedResponse.json()).resolves.toEqual({
      cursor: initial.cursor,
      changed_companions: [],
      deleted_companion_ids: [],
      companion_ids: [COMPANION_ID],
      changed_sections: [],
      deleted_section_ids: [],
      section_ids: [SECTION_ID],
    });
  });

  it("returns roster upserts and section/Companion tombstones from the cursor snapshot", async () => {
    const app = appWithRoutes();
    // SAFETY: The route's successful JSON response always carries the opaque cursor string.
    const initial = await (await app.request("/v1/companions/sync")).json() as { cursor: string };
    const updatedCompanion = {
      ...companion,
      name: "Research updated",
      updated_at: "2026-08-29T00:01:00.000Z",
    };
    coreMocks.listCompanionRuntimeViews.mockResolvedValue([updatedCompanion]);
    coreMocks.listCompanionSections.mockResolvedValue([]);

    const response = await app.request(
      `/v1/companions/sync?cursor=${encodeURIComponent(initial.cursor)}`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      changed_companions: [updatedCompanion],
      deleted_companion_ids: [],
      companion_ids: [COMPANION_ID],
      changed_sections: [],
      deleted_section_ids: [SECTION_ID],
      section_ids: [],
    });
  });

  it("rejects malformed and oversized roster cursors before reading projections", async () => {
    const app = appWithRoutes();
    const malformed = await app.request("/v1/companions/sync?cursor=not-a-cursor");
    expect(malformed.status).toBe(400);
    expect(coreMocks.listCompanionRuntimeViews).not.toHaveBeenCalled();
    expect(coreMocks.listCompanionSections).not.toHaveBeenCalled();

    const oversized = await app.request(
      `/v1/companions/sync?cursor=${"a".repeat(256 * 1024 + 1)}`,
    );
    expect(oversized.status).toBe(400);
    expect(coreMocks.listCompanionRuntimeViews).not.toHaveBeenCalled();
  });

  it("serves the API-projected routine notify group without flattening hidden history", async () => {
    const runId = "88888888-8888-4888-8888-888888888888";
    const groupedThread: CompanionThread = {
      ...thread,
      entries: [{
        event_id: `routine-return:${runId}`,
        ordinal: 3,
        role: "assistant",
        content: "Skills Hub: 1.87.0 → 1.88.0.",
        reasoning: null,
        author_id: null,
        author_name: null,
        tool: null,
        decision: null,
        routine: null,
        trigger: null,
        turn_id: null,
        queued: false,
        attachments: [],
        created_at: NOW,
        routine_notify_group: {
          routine_name: "Skills Hub",
          total_count: 2,
          hidden_entries: [
            {
              event_id: "msg:77777777-7777-4777-8777-777777777777",
              ordinal: 0,
              role: "user",
              content: "Check for Skills Hub updates.",
              reasoning: null,
              author_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              author_name: "Ada Lovelace",
              tool: null,
              decision: null,
              routine: {
                id: "99999999-9999-4999-8999-999999999999",
                name: "Skills Hub",
                run_id: "77777777-7777-4777-8777-777777777777",
              },
              trigger: null,
              turn_id: "77777777-7777-4777-8777-777777777777",
              queued: false,
              attachments: [],
              created_at: NOW,
            },
            {
              event_id: "routine-return:77777777-7777-4777-8777-777777777777",
              ordinal: 1,
              role: "assistant",
              content: "Skills Hub: 1.86.0 → 1.87.0.",
              reasoning: null,
              author_id: null,
              author_name: null,
              tool: null,
              decision: null,
              routine: null,
              trigger: null,
              turn_id: null,
              queued: false,
              attachments: [],
              created_at: NOW,
            },
          ],
        },
      }],
    };
    coreMocks.readCompanionThread.mockResolvedValue(groupedThread);

    const response = await appWithRoutes().request(`/v1/companions/${COMPANION_ID}/thread`);
    // SAFETY: This test controls the route mock and asserts the exact Companion thread response.
    const payload = await response.json() as { thread: CompanionThread };

    expect(response.status).toBe(200);
    expect(payload.thread.entries).toHaveLength(1);
    expect(payload.thread.entries[0]?.routine_notify_group).toMatchObject({
      routine_name: "Skills Hub",
      total_count: 2,
    });
    expect(payload.thread.entries[0]?.routine_notify_group?.hidden_entries[1]?.content)
      .toBe("Skills Hub: 1.86.0 → 1.87.0.");
  });

  it("projects transcription as unavailable when the deployment key is absent", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_GEMINI_TRANSCRIPTION_API_KEY: "   ",
    });

    const response = await app.request(`/v1/companions/${COMPANION_ID}/thread`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      thread: { ...thread, transcription_available: false },
    });
  });

  it("serves recent and historical thread windows from bounded cursor-scoped reads", async () => {
    const syncCursor = coreModule.buildCompanionThreadSequenceCursor({
      orgId: ORG_ID,
      actorId: owner.id,
      companionId: COMPANION_ID,
      sequence: 42n,
    });
    const olderCursor = coreModule.buildCompanionThreadWindowCursor({
      orgId: ORG_ID,
      actorId: owner.id,
      companionId: COMPANION_ID,
      beforeOrdinal: 1_950,
    });
    const { entries: omittedViewerEntries, ...viewerMetadata } = threadWithInterruptedTurn("viewer");
    void omittedViewerEntries;
    coreMocks.readCompanionThreadWindow.mockResolvedValue({
      thread: viewerMetadata,
      entries: [threadEntry("event:recent", 1_999, "recent")],
      older_cursor: olderCursor,
      sync_cursor: syncCursor,
      notify_returns: [],
    });
    const app = appWithRoutes();

    const recentResponse = await app.request(
      `/v1/companions/${COMPANION_ID}/thread-window?limit=50`,
    );
    expect(recentResponse.status).toBe(200);
    // SAFETY: This route fixture controls the bounded window response decoded below.
    const recent = await recentResponse.json() as {
      thread: Omit<CompanionThread, "entries">;
      entries: Array<{ event_id: string }>;
      older_cursor: string | null;
      sync_cursor: string;
    };
    expect(recent.entries.map((entry) => entry.event_id)).toEqual(["event:recent"]);
    expect(recent.older_cursor).toBe(olderCursor);
    expect(recent.sync_cursor).toBe(syncCursor);
    expect(recent.thread.interrupted_turn?.error).toEqual({
      code: "runtime_unavailable",
      message: "Companion runtime needs attention.",
      action: "none",
    });
    expect(coreMocks.readCompanionThreadWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ beforeOrdinal: null, limit: 50 }),
    );

    const historyResponse = await app.request(
      `/v1/companions/${COMPANION_ID}/thread-window?before=${encodeURIComponent(olderCursor)}&limit=50`,
    );
    expect(historyResponse.status).toBe(200);
    expect(coreMocks.readCompanionThreadWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ beforeOrdinal: 1_950, limit: 50 }),
    );
    expect(coreMocks.readCompanionThread).not.toHaveBeenCalled();
  });

  it("uses a v2 sequence cursor for one bounded change page without reading full history", async () => {
    const cursor = coreModule.buildCompanionThreadSequenceCursor({
      orgId: ORG_ID,
      actorId: owner.id,
      companionId: COMPANION_ID,
      sequence: 7n,
    });
    const nextCursor = coreModule.buildCompanionThreadSequenceCursor({
      orgId: ORG_ID,
      actorId: owner.id,
      companionId: COMPANION_ID,
      sequence: 8n,
    });
    coreMocks.readCompanionThreadChanges.mockResolvedValue({
      cursor: nextCursor,
      reset_entries: false,
      changed_entries: [threadEntry("event:changed", 8, "changed")],
      deleted_event_ids: [],
      thread: threadMetadata,
      has_more: true,
      notify_returns: [],
    });

    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/thread-delta?cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cursor: nextCursor,
      has_more: true,
      changed_entries: [{ event_id: "event:changed" }],
    });
    expect(coreMocks.readCompanionThreadChanges).toHaveBeenCalledWith(
      expect.objectContaining({ afterSequence: 7n }),
    );
    expect(coreMocks.syncCompanionThread).not.toHaveBeenCalled();
  });

  it("serves thread deltas with current metadata and deterministic entry ordering", async () => {
    const app = appWithRoutes();
    const firstThread: CompanionThread = {
      ...thread,
      entries: [
        threadEntry("event:one", 2, "one"),
        threadEntry("event:two", 4, "two"),
      ],
    };
    coreMocks.syncCompanionThread.mockResolvedValue(firstThread);
    const initialResponse = await app.request(`/v1/companions/${COMPANION_ID}/thread-delta`);
    // SAFETY: This test controls the route fixture and reads its successful JSON response shape.
    const initial = await initialResponse.json() as {
      cursor: string;
      reset_entries: boolean;
      changed_entries: unknown[];
      thread: object;
    };
    expect(initialResponse.status).toBe(200);
    expect(initial.reset_entries).toBe(true);
    expect(initial.changed_entries).toHaveLength(2);
    expect(initial.thread).not.toHaveProperty("entries");

    const nextThread: CompanionThread = {
      ...firstThread,
      last_message_at: "2026-08-29T00:02:00.000Z",
      entries: [
        threadEntry("event:one", 2, "one updated"),
        threadEntry("event:three", 1, "three"),
      ],
    };
    coreMocks.syncCompanionThread.mockResolvedValue(nextThread);
    const nextResponse = await app.request(
      `/v1/companions/${COMPANION_ID}/thread-delta?cursor=${encodeURIComponent(initial.cursor)}`,
    );
    expect(nextResponse.status).toBe(200);
    // SAFETY: This test controls the route fixture and reads its successful JSON response shape.
    const next = await nextResponse.json() as {
      reset_entries: boolean;
      changed_entries: Array<{ event_id: string; ordinal: number }>;
      deleted_event_ids: string[];
      thread: CompanionThread;
    };
    expect(next.reset_entries).toBe(false);
    expect(next.changed_entries.map((entry) => entry.event_id)).toEqual(["event:three", "event:one"]);
    expect(next.deleted_event_ids).toEqual(["event:two"]);
    expect(next.thread).not.toHaveProperty("entries");
    expect(next.thread.last_message_at).toBe("2026-08-29T00:02:00.000Z");

    const replayResponse = await app.request(
      `/v1/companions/${COMPANION_ID}/thread-delta?cursor=${encodeURIComponent(initial.cursor)}`,
    );
    await expect(replayResponse.json()).resolves.toEqual(next);
  });

  it("preserves queued entries that share ordinals across a thread cursor", async () => {
    const app = appWithRoutes();
    const initialThread: CompanionThread = {
      ...thread,
      entries: [threadEntry("event:initial", 1, "initial")],
    };
    coreMocks.syncCompanionThread.mockResolvedValue(initialThread);
    const initialResponse = await app.request(`/v1/companions/${COMPANION_ID}/thread-delta`);
    // SAFETY: Every successful thread-delta response carries the opaque cursor asserted here.
    const initial = await initialResponse.json() as { cursor: string };
    expect(initialResponse.status).toBe(200);

    const queuedThread: CompanionThread = {
      ...initialThread,
      entries: [
        threadEntry("event:initial", 1, "initial"),
        threadEntry("event:gamma", 2, "gamma", true),
        threadEntry("event:alpha", 2, "alpha", true),
        threadEntry("event:beta", 2, "beta"),
      ],
    };
    coreMocks.syncCompanionThread.mockResolvedValue(queuedThread);
    const response = await app.request(
      `/v1/companions/${COMPANION_ID}/thread-delta?cursor=${encodeURIComponent(initial.cursor)}`,
    );
    expect(response.status).toBe(200);
    // SAFETY: This test controls the successful route fixture and asserts its bounded delta shape.
    const next = await response.json() as {
      cursor: string;
      reset_entries: boolean;
      changed_entries: Array<{ event_id: string; queued: boolean; ordinal: number }>;
      deleted_event_ids: string[];
    };
    expect(next.reset_entries).toBe(false);
    expect(next.changed_entries.map((item) => item.event_id)).toEqual([
      "event:alpha",
      "event:beta",
      "event:gamma",
    ]);
    expect(new Set(next.changed_entries.map((item) => item.event_id)).size)
      .toBe(next.changed_entries.length);
    expect(next.changed_entries.map((item) => item.ordinal)).toEqual([2, 2, 2]);
    expect(next.changed_entries.filter((item) => item.queued).map((item) => item.event_id))
      .toEqual(["event:alpha", "event:gamma"]);
    expect(next.deleted_event_ids).toEqual([]);

    const replayResponse = await app.request(
      `/v1/companions/${COMPANION_ID}/thread-delta?cursor=${encodeURIComponent(next.cursor)}`,
    );
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toMatchObject({
      cursor: next.cursor,
      reset_entries: false,
      changed_entries: [],
      deleted_event_ids: [],
    });
  });

  it("replaces Viewer turn and attempt diagnostics with one generic non-actionable error", async () => {
    const viewerThread = threadWithInterruptedTurn("viewer");
    coreMocks.readCompanionThread.mockResolvedValue(viewerThread);

    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/thread`,
    );
    // SAFETY: this route serializes the fixture returned by readCompanionThread.
    const payload = await response.json() as { thread: typeof viewerThread };

    expect(response.status).toBe(200);
    expect(payload.thread.interrupted_turn.error).toEqual({
      code: "runtime_unavailable",
      message: "Companion runtime needs attention.",
      action: "none",
    });
    expect(payload.thread.interrupted_turn.latest_attempt?.error).toEqual({
      code: "runtime_unavailable",
      message: "Companion runtime needs attention.",
      action: "none",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(operatorTurnError.code);
    expect(serialized).not.toContain(operatorTurnError.message);
    expect(serialized).not.toContain(operatorAttemptError.code);
    expect(serialized).not.toContain(operatorAttemptError.message);
  });

  it.each(["owner", "editor"] as const)(
    "preserves full actionable thread diagnostics for %s access",
    async (access) => {
      const operatorThread = threadWithInterruptedTurn(access);
      coreMocks.readCompanionThread.mockResolvedValue(operatorThread);

      const response = await appWithRoutes().request(
        `/v1/companions/${COMPANION_ID}/thread`,
      );
      // SAFETY: this route serializes the fixture returned by readCompanionThread.
      const payload = await response.json() as { thread: typeof operatorThread };

      expect(response.status).toBe(200);
      expect(payload.thread.interrupted_turn.error).toEqual(operatorTurnError);
      expect(payload.thread.interrupted_turn.latest_attempt?.error).toEqual(operatorAttemptError);
    },
  );

  it("does not expose the retired thread sync route", async () => {
    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/thread/sync`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(coreMocks.readCompanionThread).not.toHaveBeenCalled();
    expect(coreMocks.syncCompanionThread).not.toHaveBeenCalled();
  });

  it("rejects a malformed thread delta cursor before contacting the thread projection", async () => {
    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/thread-delta?cursor=not-a-cursor`,
    );
    expect(response.status).toBe(400);
    expect(coreMocks.syncCompanionThread).not.toHaveBeenCalled();
  });

  it("persists a send through the v2 enqueue boundary and returns only a bounded 202 ACK", async () => {
    const app = appWithRoutes();
    const response = await app.request(jsonPost(`/v1/companions/${COMPANION_ID}/messages`, {
      content: "Summarize the incident",
      client_message_id: MESSAGE_ID,
      client_surface: "mobile_web",
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ turn });
    expect(coreMocks.enqueueCompanionTurn).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      clientMessageId: MESSAGE_ID,
      content: "Summarize the incident",
      clientSurface: "mobile_web",
    }));
    expect(coreMocks.readCompanionThread).not.toHaveBeenCalled();
  });

  it("stores a multipart send's files under their content address before the turn", async () => {
    const app = appWithRoutes();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([png], "Q3 chart.PNG", { type: "image/png" }));
    form.append("file", new File(["a,b\n1,2\n"], "rows.csv", { type: "text/csv" }));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(202);
    expect(storageMocks.putSkillArchive).toHaveBeenCalledTimes(2);
    const attachments = coreMocks.enqueueCompanionTurn.mock.calls[0]?.[0].attachments;
    expect(attachments).toEqual([
      expect.objectContaining({
        content_type: "image/png",
        filename: "Q3_chart.PNG",
        byte_size: png.byteLength,
        position: 0,
      }),
      expect.objectContaining({ content_type: "text/csv", filename: "rows.csv", position: 1 }),
    ]);
    // Content-addressed: the key ends in the digest of the exact bytes, so a retried send lands on
    // the same object instead of orphaning one.
    const firstAttachment = attachments?.[0];
    if (!firstAttachment) throw new Error("expected the first stored attachment");
    expect(new Date(firstAttachment.uploaded_at).toISOString()).toBe(firstAttachment.uploaded_at);
    expect(firstAttachment.storage_key).toBe(
      `companion-attachments/${ORG_ID}/${COMPANION_ID}/${MESSAGE_ID}/0-${firstAttachment.sha256}`,
    );
    expect(storageMocks.deleteStorageObject).not.toHaveBeenCalled();
  });

  it("refuses a file whose bytes are not the type it claims, before storing anything", async () => {
    const app = appWithRoutes();
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File(["not a png at all"], "fake.png", { type: "image/png" }));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(400);
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurn).not.toHaveBeenCalled();
  });

  it("removes the objects it just stored when the turn does not persist", async () => {
    const app = appWithRoutes();
    coreMocks.enqueueCompanionTurn.mockRejectedValueOnce(new Error("queue is closed"));
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(400);
    expect(storageMocks.deleteStorageObject).toHaveBeenCalledTimes(1);
  });

  it("refuses a Viewer's multipart send before it reads or stores a single byte", async () => {
    const app = appWithRoutes();
    coreMocks.getCompanionRuntimeView.mockResolvedValue({ ...companion, access: "viewer" });
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(403);
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurn).not.toHaveBeenCalled();
  });

  it("never deletes an object it did not create when the replay conflicts", async () => {
    const app = appWithRoutes();
    // The key is the digest of the bytes, so a conflicting replay computes the very same key as the
    // accepted turn that already owns it. Deleting it would destroy a live message's attachment.
    storageMocks.putSkillArchive.mockRejectedValueOnce(
      Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed" }),
    );
    coreMocks.enqueueCompanionTurn.mockRejectedValueOnce(
      Object.assign(new Error("client_message_id was reused with different message intent"), {
        code: "23505",
      }),
    );
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(409);
    expect(storageMocks.deleteStorageObject).not.toHaveBeenCalled();
  });

  it("leaves an accepted turn's objects alone even if the store ignores create-only", async () => {
    const app = appWithRoutes();
    // A self-hosted object store that ignores `If-None-Match: *` would let the PUT succeed and put
    // the key in the cleanup list. A replay conflict must still never delete it.
    storageMocks.putSkillArchive.mockResolvedValueOnce(null);
    coreMocks.enqueueCompanionTurn.mockRejectedValueOnce(
      Object.assign(new Error("client_message_id was reused with different message intent"), {
        code: "23505",
      }),
    );
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(409);
    expect(storageMocks.putSkillArchive).toHaveBeenCalled();
    expect(storageMocks.deleteStorageObject).not.toHaveBeenCalled();
  });

  it("removes bytes recreated by a replay after the accepted attachment expired", async () => {
    const app = appWithRoutes();
    storageMocks.putSkillArchive.mockResolvedValueOnce("expired-replay-etag");
    coreMocks.enqueueCompanionTurn.mockRejectedValueOnce(
      Object.assign(new Error("client_message_id attachment bytes expired; upload again"), {
        code: "23505",
        constraint_name: "companion_turn_attachments_expired",
      }),
    );
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    ], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(409);
    expect(storageMocks.deleteStorageObject).toHaveBeenCalledWith(expect.objectContaining({
      ifMatch: "expired-replay-etag",
    }));
  });

  it("stores each attachment create-only so a retry cannot overwrite accepted bytes", async () => {
    const app = appWithRoutes();
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(storageMocks.putSkillArchive).toHaveBeenCalledWith(
      expect.objectContaining({ preventOverwrite: true }),
    );
  });

  it("decides Companion access before the body-reading limit middleware runs", async () => {
    const app = appWithRoutes();
    coreMocks.getCompanionRuntimeView.mockResolvedValue({ ...companion, access: "viewer" });
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    // A chunked multipart request carries no Content-Length, so the body limit can only measure it
    // by buffering the whole 64 MB first. Refusing in the middleware ahead of it is what keeps an
    // unauthorized caller from costing this process that heap.
    expect(response.status).toBe(403);
    expect(coreMocks.getCompanionRuntimeView).toHaveBeenCalled();
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurn).not.toHaveBeenCalled();
  });

  it("refuses too many files and an empty file before storing anything", async () => {
    const app = appWithRoutes();
    const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf");

    for (const files of [
      [pdf(), pdf(), pdf(), pdf(), pdf(), pdf()],
      [new File([], "empty.pdf")],
    ]) {
      const form = new FormData();
      form.set("content", "Look at this");
      form.set("client_message_id", MESSAGE_ID);
      for (const file of files) form.append("file", file);
      const response = await app.request(new Request(
        `http://localhost/v1/companions/${COMPANION_ID}/messages`,
        { method: "POST", body: form },
      ));
      expect(response.status).toBe(400);
    }
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurn).not.toHaveBeenCalled();
  });

  it("refuses a file over the per-attachment ceiling without reading its bytes", async () => {
    const app = appWithRoutes();
    // A real body: the size the route checks is the one the multipart parser reports, so a stubbed
    // `size` on a File does not survive the round trip and would not exercise this bound at all.
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.bin"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(400);
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurn).not.toHaveBeenCalled();
  });

  it("lets a Viewer read an attachment without contacting the Box", async () => {
    const app = appWithRoutes();
    coreMocks.getCompanionRuntimeView.mockResolvedValue({ ...companion, access: "viewer" });

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/88888888-8888-4888-8888-888888888888`,
    );

    expect(response.status).toBe(200);
    expect(desktopMocks.mintCompanionDesktop).not.toHaveBeenCalled();
  });

  it("keeps the storage key out of the response when the object cannot be read", async () => {
    const app = appWithRoutes();
    storageMocks.getSkillArchive.mockRejectedValue(
      new Error("object not found: companion-attachments/org/companion/message/0-digest"),
    );

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/88888888-8888-4888-8888-888888888888`,
    );
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain("companion-attachments/");
  });

  it("serves an attachment after re-authorizing, and never lets it be cached past that", async () => {
    const app = appWithRoutes();
    const attachmentId = "88888888-8888-4888-8888-888888888888";

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/${attachmentId}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="chart.png"');
    expect(coreMocks.readCompanionAttachment).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      attachmentId,
    }));
  });

  it("offers a document as a download rather than rendering it in the thread", async () => {
    const app = appWithRoutes();
    coreMocks.readCompanionAttachment.mockResolvedValue({
      storageKey: "companion-attachments/org/companion/message/0-digest",
      contentType: "application/pdf",
      byteSize: 5,
      filename: "report.pdf",
      kind: "user_upload",
      availability: "available",
      expiresAt: "2026-09-23T12:00:00.000Z",
    });

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/88888888-8888-4888-8888-888888888888`,
    );

    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
  });

  it("returns explicit expiry without reading object storage", async () => {
    const app = appWithRoutes();
    coreMocks.readCompanionAttachment.mockResolvedValue({
      storageKey: null,
      contentType: "application/pdf",
      byteSize: 5,
      filename: "old-report.pdf",
      kind: "user_upload",
      availability: "expired",
      expiresAt: "2026-09-01T12:00:00.000Z",
    });

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/88888888-8888-4888-8888-888888888888`,
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "attachment expired" });
    expect(storageMocks.getSkillArchive).not.toHaveBeenCalled();
  });

  it("makes an unreadable thread and an unknown attachment indistinguishable", async () => {
    const app = appWithRoutes();
    coreMocks.readCompanionAttachment.mockRejectedValue(
      Object.assign(new Error("Companion not found"), { code: "P0002" }),
    );

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/88888888-8888-4888-8888-888888888888`,
    );

    expect(response.status).toBe(404);
    expect(storageMocks.getSkillArchive).not.toHaveBeenCalled();
  });

  it("delegates a repeated client_message_id unchanged and returns the same durable turn", async () => {
    const app = appWithRoutes();
    const body = {
      content: "Summarize the incident",
      client_message_id: MESSAGE_ID,
      client_surface: "web",
    };
    coreMocks.enqueueCompanionTurn
      .mockResolvedValueOnce({ turn, replayed: false })
      .mockResolvedValueOnce({ turn, replayed: true });

    const first = await app.request(jsonPost(`/v1/companions/${COMPANION_ID}/messages`, body));
    const replay = await app.request(jsonPost(`/v1/companions/${COMPANION_ID}/messages`, body));

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(await first.json());
    expect(coreMocks.enqueueCompanionTurn.mock.calls.map(([input]) => input.clientMessageId))
      .toEqual([MESSAGE_ID, MESSAGE_ID]);
  });

  it("maps a conflicting client_message_id replay SQLSTATE to 409", async () => {
    coreMocks.enqueueCompanionTurn.mockRejectedValueOnce(Object.assign(
      new Error("query failed"),
      { cause: Object.assign(new Error("message intent differs"), { code: "23505" }) },
    ));

    const response = await appWithRoutes().request(jsonPost(
      `/v1/companions/${COMPANION_ID}/messages`,
      { content: "Different intent", client_message_id: MESSAGE_ID },
    ));

    expect(response.status).toBe(409);
  });

  it("requires a client_message_id before any durable write", async () => {
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/messages`, { content: "No id" }),
    );
    expect(response.status).toBe(400);
    expect(coreMocks.enqueueCompanionTurn).not.toHaveBeenCalled();
  });

  it("routes Companion creation, settings, member state, provider, and sharing through v2", async () => {
    const app = appWithRoutes();
    const responses = await Promise.all([
      app.request(jsonPost("/v1/companions", {
        name: "Research",
        provider_id: "anthropic",
        model_id: "claude-opus-4-8",
      })),
      app.request(`/v1/companions/${COMPANION_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "Updated" }),
      }),
      app.request(`/v1/companions/${COMPANION_ID}/member-state`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ muted: true }),
      }),
      app.request(`/v1/companions/${COMPANION_ID}/provider`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider_id: "anthropic" }),
      }),
      app.request(`/v1/companions/${COMPANION_ID}/shares/workspace`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "editor" }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 200, 200, 200, 200]);
    expect(coreMocks.createCompanionWithRuntime).toHaveBeenCalledOnce();
    expect(coreMocks.updateCompanionWithRuntime).toHaveBeenCalledWith(expect.objectContaining({
      patch: { persona: "Updated" },
    }));
    expect(coreMocks.updateCompanionMemberState).toHaveBeenCalledOnce();
    expect(coreMocks.updateCompanionMemberState).toHaveBeenCalledWith(expect.objectContaining({
      patch: { muted: true },
    }));
    expect(coreMocks.setCompanionProvider).toHaveBeenCalledOnce();
    expect(coreMocks.setCompanionWorkspaceShare).toHaveBeenCalledOnce();
  });

  it("accepts a temporary Pi restart as a Runtime v3 lifecycle desire", async () => {
    coreMocks.desireCompanionLifecycleV3.mockResolvedValue({
      intent: "recycle_pi",
      revision: "1",
    });
    const app = appWithRoutes();
    const headers = new Headers({ "Idempotency-Key": RETRY_ID });
    headers.set("content-type", "application/json");
    const response = await app.request(`/v1/companions/${COMPANION_ID}/runtime/restart`, {
      method: "POST",
      headers,
      body: JSON.stringify({ target: "pi" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      lifecycle: { intent: "recycle_pi", revision: "1" },
    });
    expect(coreMocks.desireCompanionLifecycleV3).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      intent: "recycle_pi",
      requestId: RETRY_ID,
    }));
  });

  it.each([
    ["delete", `/v1/companions/${COMPANION_ID}`, "DELETE", "delete"],
    ["archive", `/v1/companions/${COMPANION_ID}/runtime/archive`, "POST", "archive"],
  ] as const)("accepts %s as a Runtime v3 lifecycle desire", async (_label, path, method, intent) => {
    coreMocks.desireCompanionLifecycleV3.mockResolvedValue({ intent, revision: "1" });
    const response = await appWithRoutes().request(path, {
      method,
      headers: { "Idempotency-Key": RETRY_ID },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ lifecycle: { intent, revision: "1" } });
    expect(coreMocks.desireCompanionLifecycleV3).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      intent,
      requestId: RETRY_ID,
    }));
  });

  it("rejects lifecycle work without a caller-owned idempotency key", async () => {
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/runtime/restart`, { target: "pi" }),
    );

    expect(response.status).toBe(400);
    expect(coreMocks.desireCompanionLifecycleV3).not.toHaveBeenCalled();
  });

  it("rejects the removed full-Box restart target", async () => {
    const response = await appWithRoutes().request(
      new Request(`http://localhost/v1/companions/${COMPANION_ID}/runtime/restart`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": RETRY_ID },
        body: JSON.stringify({ target: "box" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(coreMocks.desireCompanionLifecycleV3).not.toHaveBeenCalled();
  });

  it("cancels a turn durably and returns the refreshed thread", async () => {
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/turns/${TURN_ID}/cancel`, {}),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      turn: cancelledTurn,
      thread: projectedThread,
    });
    expect(coreMocks.cancelCompanionTurn).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      turnId: TURN_ID,
    }));
  });

  it.each([
    ["Retry", `/v1/companions/${COMPANION_ID}/turns/${TURN_ID}/retry`],
    ["Start", `/v1/companions/${COMPANION_ID}/runtime/start`],
    ["Stop", `/v1/companions/${COMPANION_ID}/runtime/stop`],
  ])("does not register the removed %s compatibility endpoint", async (_label, path) => {
    const response = await appWithRoutes().request(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": RETRY_ID },
        body: JSON.stringify({ retry_id: RETRY_ID }),
      }),
    );

    expect(response.status).toBe(404);
    expect(coreMocks.desireCompanionLifecycleV3).not.toHaveBeenCalled();
  });

  it("persists decision answers and lets Runtime deliver them", async () => {
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/question-1`, {
        action: "answer",
        answer: "Use the conservative option",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ thread: projectedThread });
    expect(coreMocks.answerCompanionDecision).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      requestId: "question-1",
      decision: "answer",
      text: "Use the conservative option",
    }));
    expect(coreMocks.answerCompanionConfigDecision).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionRoutineDecision).not.toHaveBeenCalled();
  });

  it("applies config proposals through the dedicated answer path", async () => {
    coreMocks.getCompanionDecision.mockResolvedValue({
      requestKey: "config-1",
      requestKind: "config_proposal",
      decisionStatus: "pending",
      proposal: {
        kind: "config",
        add_skill_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      },
      expiresAt: NOW,
    });
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/config-1`, {
        action: "allow",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ thread: projectedThread });
    expect(coreMocks.answerCompanionConfigDecision).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      requestId: "config-1",
      decision: "allow",
    }));
    expect(coreMocks.answerCompanionDecision).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionRoutineDecision).not.toHaveBeenCalled();
  });

  it("applies routine proposals through the dedicated answer path", async () => {
    coreMocks.getCompanionDecision.mockResolvedValue({
      requestKey: "routine-1",
      requestKind: "routine_proposal",
      decisionStatus: "pending",
      proposal: {
        kind: "routine",
        name: "Standup",
        prompt: "Write the standup.",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
      },
      expiresAt: NOW,
    });
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/routine-1`, {
        action: "allow",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ thread: projectedThread });
    expect(coreMocks.answerCompanionRoutineDecision).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      requestId: "routine-1",
      decision: "allow",
    }));
    expect(coreMocks.answerCompanionConfigDecision).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionDecision).not.toHaveBeenCalled();
  });

  it("bounds routine proposal persistence failures without reflecting SQL diagnostics", async () => {
    const leakedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    coreMocks.getCompanionDecision.mockResolvedValue({
      requestKey: "routine-failure",
      requestKind: "routine_proposal",
      decisionStatus: "pending",
      proposal: {
        kind: "routine",
        name: "Standup",
        prompt: "Write the standup.",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
      },
      expiresAt: NOW,
    });
    coreMocks.answerCompanionRoutineDecision.mockRejectedValueOnce(
      new Error(`Failed query with bound routine id ${leakedId}`),
    );

    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/routine-failure`, {
        action: "allow",
      }),
    );
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain('"code":"routine_update_failed"');
    expect(body).not.toContain("Failed query");
    expect(body).not.toContain(leakedId);
  });

  it("bounds decision preflight failures before the proposal kind is known", async () => {
    const leakedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    coreMocks.getCompanionDecision.mockRejectedValueOnce(
      new Error(`Failed query with bound decision id ${leakedId}`),
    );

    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/preflight-failure`, {
        action: "allow",
      }),
    );
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain('"code":"decision_update_failed"');
    expect(body).toContain("Unable to apply the decision. Please try again.");
    expect(body).not.toContain("Failed query");
    expect(body).not.toContain(leakedId);
  });

  it("treats deny as successful when expiry already closed the decision", async () => {
    coreMocks.getCompanionDecision.mockResolvedValue({
      requestKey: "routine-expired",
      requestKind: "routine_proposal",
      decisionStatus: "expired",
      proposal: {
        kind: "routine",
        name: "Standup",
        prompt: "Write the standup.",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
      },
      expiresAt: NOW,
    });
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/routine-expired`, {
        action: "deny",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ thread: projectedThread });
    expect(coreMocks.answerCompanionRoutineDecision).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionDecision).not.toHaveBeenCalled();
  });

  it("lists and creates Companion routines", async () => {
    const routine = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companion_id: COMPANION_ID,
      name: "Standup",
      prompt: "Write the standup.",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      enabled: true,
      next_fire_at: "2026-08-20T09:00:00.000Z",
      last_fired_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
      created_at: NOW,
      updated_at: NOW,
    };
    coreMocks.listCompanionRoutines.mockResolvedValue([routine]);
    coreMocks.createCompanionRoutine.mockResolvedValue(routine);
    const app = appWithRoutes();
    const listed = await app.request(`/v1/companions/${COMPANION_ID}/routines`);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ routines: [routine] });
    const created = await app.request(
      jsonPost(`/v1/companions/${COMPANION_ID}/routines`, {
        id: routine.id,
        name: routine.name,
        prompt: routine.prompt,
        cron: routine.cron,
        timezone: routine.timezone,
        enabled: true,
      }),
    );
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual({ routine });
  });

  it("lists routine runs and reads one private routine transcript", async () => {
    const routineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const summary = {
      run_id: runId,
      companion_id: COMPANION_ID,
      routine: { id: routineId, name: "Standup" },
      status: "succeeded" as const,
      outcome: "surfaced" as const,
      surface_mode: "notify" as const,
      main_entry_event_id: "routine-return:notice",
      relay_turn_id: null,
      created_at: NOW,
      started_at: NOW,
      settled_at: NOW,
      error: null,
    };
    const detail = {
      ...summary,
      internal_entries: [{
        event_id: "routine:work:1",
        ordinal: 0,
        role: "assistant" as const,
        content: "Checked the deployment.",
        reasoning: null,
        tool: null,
        decision: null,
        created_at: NOW,
      }],
      next_entry_cursor: null,
    };
    coreMocks.listCompanionRoutineRuns.mockResolvedValue({
      runs: [summary],
      next_cursor: null,
    });
    coreMocks.getCompanionRoutineRun.mockResolvedValue(detail);
    const app = appWithRoutes();

    const listed = await app.request(
      `/v1/companions/${COMPANION_ID}/routines/${routineId}/runs?limit=20`,
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    await expect(listed.json()).resolves.toEqual({ runs: [summary], next_cursor: null });
    expect(coreMocks.listCompanionRoutineRuns).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      routineId,
      limit: 20,
    }));

    const read = await app.request(
      `/v1/companions/${COMPANION_ID}/routine-runs/${runId}?entry_limit=20&entry_cursor=7`,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    await expect(read.json()).resolves.toEqual({ run: detail });
    expect(coreMocks.getCompanionRoutineRun).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      runId,
      entryLimit: 20,
      entryCursor: 7,
    }));
  });

  it("rejects an unbounded routine-run history request before the database", async () => {
    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/routines/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs?limit=101`,
    );
    expect(response.status).toBe(400);
    expect(coreMocks.listCompanionRoutineRuns).not.toHaveBeenCalled();

    const detailResponse = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/routine-runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?entry_limit=101`,
    );
    expect(detailResponse.status).toBe(400);
    expect(coreMocks.getCompanionRoutineRun).not.toHaveBeenCalled();
  });

  it("applies trigger proposals through the dedicated answer path", async () => {
    const createdTrigger = { ...proposedGithubTrigger };
    const registeredTrigger = {
      ...createdTrigger,
      registration_status: "registered" as const,
      remote_hook_id: "42",
      remote_hook_account_id: createdTrigger.provider_account_id,
    };
    coreMocks.getCompanionDecision.mockResolvedValue({
      requestKey: "trigger-1",
      requestKind: "trigger_proposal",
      decisionStatus: "pending",
      proposal: {
        kind: "trigger",
        name: "CI failed on main",
        prompt: "Investigate the failing workflow.",
        mode: "relay",
        provider: "github",
      },
      expiresAt: NOW,
    });
    coreMocks.answerCompanionTriggerDecision.mockResolvedValueOnce({ trigger_id: TRIGGER_ID });
    coreMocks.listCompanionTriggers
      .mockResolvedValueOnce([createdTrigger])
      .mockResolvedValueOnce([registeredTrigger]);
    coreMocks.registerCompanionTriggerWebhook.mockResolvedValueOnce({
      status: "registered",
      remote_hook_id: "42",
    });
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/trigger-1`, {
        action: "allow",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ thread: projectedThread });
    expect(coreMocks.answerCompanionTriggerDecision).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      requestId: "trigger-1",
      decision: "allow",
    }));
    expect(coreMocks.registerCompanionTriggerWebhook).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      triggerId: TRIGGER_ID,
    }));
    expect(coreMocks.answerCompanionConfigDecision).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionRoutineDecision).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionDecision).not.toHaveBeenCalled();
  });

  it("accepts a trigger proposal when provider registration is durably failed", async () => {
    const failedTrigger = {
      ...proposedGithubTrigger,
      registration_status: "failed" as const,
      remote_hook_account_id: proposedGithubTrigger.provider_account_id,
      last_registration_error: "github rejected the webhook (403)",
    };
    coreMocks.getCompanionDecision.mockResolvedValue({
      requestKey: "trigger-registration-failure",
      requestKind: "trigger_proposal",
      decisionStatus: "pending",
      proposal: {
        kind: "trigger",
        name: proposedGithubTrigger.name,
        prompt: proposedGithubTrigger.prompt,
        mode: proposedGithubTrigger.mode,
        provider: proposedGithubTrigger.provider,
      },
      expiresAt: NOW,
    });
    coreMocks.answerCompanionTriggerDecision.mockResolvedValueOnce({ trigger_id: TRIGGER_ID });
    coreMocks.listCompanionTriggers
      .mockResolvedValueOnce([proposedGithubTrigger])
      .mockResolvedValueOnce([failedTrigger]);
    coreMocks.registerCompanionTriggerWebhook.mockResolvedValueOnce({
      status: "failed",
      error: failedTrigger.last_registration_error,
    });

    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/trigger-registration-failure`, {
        action: "allow",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ thread: projectedThread });
    expect(coreMocks.listCompanionTriggers).toHaveBeenCalledTimes(2);
    expect(coreMocks.registerCompanionTriggerWebhook).toHaveBeenCalledWith(expect.objectContaining({
      triggerId: TRIGGER_ID,
    }));
  });

  it("bounds trigger proposal persistence failures without reflecting SQL diagnostics", async () => {
    const leakedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    coreMocks.getCompanionDecision.mockResolvedValue({
      requestKey: "trigger-failure",
      requestKind: "trigger_proposal",
      decisionStatus: "pending",
      proposal: {
        kind: "trigger",
        name: "CI failed on main",
        prompt: "Investigate the failing workflow.",
        mode: "relay",
        provider: "github",
      },
      expiresAt: NOW,
    });
    coreMocks.answerCompanionTriggerDecision.mockRejectedValueOnce(
      new CompanionTriggerDecisionUpdateError({
        cause: new Error(`Failed query with bound trigger id ${leakedId}`),
      }),
    );

    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/trigger-failure`, {
        action: "allow",
      }),
    );
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain('"code":"trigger_update_failed"');
    expect(body).not.toContain("Failed query");
    expect(body).not.toContain(leakedId);
  });

  it("refuses free text on a trigger proposal card", async () => {
    coreMocks.getCompanionDecision.mockResolvedValue({
      requestKey: "trigger-1",
      requestKind: "trigger_proposal",
      decisionStatus: "pending",
      proposal: {
        kind: "trigger",
        name: "CI failed on main",
        prompt: "Investigate the failing workflow.",
        mode: "relay",
        provider: "github",
      },
      expiresAt: NOW,
    });
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/trigger-1`, {
        action: "answer",
        answer: "Sure",
      }),
    );
    expect(response.status).toBe(400);
    expect(coreMocks.answerCompanionTriggerDecision).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionDecision).not.toHaveBeenCalled();
  });

  it("lists, creates, updates, rotates, and deletes Companion triggers", async () => {
    const trigger = {
      id: TRIGGER_ID,
      companion_id: COMPANION_ID,
      name: "CI failed on main",
      prompt: "Investigate the failing workflow.",
      mode: "relay" as const,
      provider: "github" as const,
      provider_account_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      target: { repo: "acme/widgets", events: ["workflow_run"] },
      registration_status: "registered" as const,
      remote_hook_id: "42",
      remote_hook_account_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      last_registration_error: null,
      enabled: true,
      webhook_url: `http://127.0.0.1:3000/v1/hooks/triggers/${TRIGGER_ID}/${TRIGGER_SECRET}`,
      last_fired_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
      created_at: NOW,
      updated_at: NOW,
    };
    coreMocks.listCompanionTriggers.mockResolvedValue([trigger]);
    coreMocks.createCompanionTrigger.mockResolvedValue(trigger);
    coreMocks.updateCompanionTrigger.mockResolvedValue({ ...trigger, enabled: false });
    coreMocks.rotateCompanionTriggerSecret.mockResolvedValue(trigger);
    coreMocks.deleteCompanionTrigger.mockResolvedValue(undefined);
    const app = appWithRoutes();

    const listed = await app.request(`/v1/companions/${COMPANION_ID}/triggers`);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ triggers: [trigger] });
    // The callback URL is secondary setup detail; a bare secret is never returned.
    expect(listed.headers.get("cache-control")).toBe("private, no-store");

    const created = await app.request(
      jsonPost(`/v1/companions/${COMPANION_ID}/triggers`, {
        id: trigger.id,
        name: trigger.name,
        prompt: trigger.prompt,
        provider: trigger.provider,
        target: trigger.target,
        enabled: true,
      }),
    );
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual({ trigger });
    expect(coreMocks.createCompanionTrigger).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      id: trigger.id,
      name: trigger.name,
      provider: "github",
      webhookBaseUrl: "http://127.0.0.1:3000",
    }));

    const updated = await app.request(`/v1/companions/${COMPANION_ID}/triggers/${TRIGGER_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual({ trigger: { ...trigger, enabled: false } });
    expect(coreMocks.updateCompanionTrigger).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      triggerId: TRIGGER_ID,
      enabled: false,
    }));

    const rotated = await app.request(
      `/v1/companions/${COMPANION_ID}/triggers/${TRIGGER_ID}/rotate-secret`,
      { method: "POST" },
    );
    expect(rotated.status).toBe(200);
    await expect(rotated.json()).resolves.toEqual({ trigger });
    expect(coreMocks.rotateCompanionTriggerSecret).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      triggerId: TRIGGER_ID,
    }));

    const deleted = await app.request(`/v1/companions/${COMPANION_ID}/triggers/${TRIGGER_ID}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(coreMocks.deleteCompanionTrigger).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      triggerId: TRIGGER_ID,
    }));
  });

  it("never persists a control-created trigger webhook secret in the approval result", async () => {
    const controlRequest = {
      id: RETRY_ID,
      companion_id: COMPANION_ID,
      kind: "trigger_change" as const,
      action: "create",
      summary: "Create deployment hook",
      payload: {
        action: "create",
        draft: {
          name: proposedGithubTrigger.name,
          prompt: proposedGithubTrigger.prompt,
          mode: proposedGithubTrigger.mode,
          provider: "webhook",
          enabled: true,
        },
      },
      status: "pending" as const,
      requested_by_id: owner.id,
      decided_by_id: null,
      result: null,
      error_code: null,
      error_message: null,
      expires_at: "2026-08-18T00:00:00.000Z",
      decided_at: null,
      applied_at: null,
      continuation_turn_id: null,
      created_at: NOW,
      updated_at: NOW,
    };
    const applying = {
      ...controlRequest,
      status: "applying" as const,
      decided_by_id: owner.id,
      decided_at: NOW,
    };
    coreMocks.getCompanionControlRequest.mockResolvedValue(controlRequest);
    coreMocks.decideCompanionControlRequest.mockResolvedValue(applying);
    coreMocks.createCompanionTrigger.mockResolvedValue({
      ...proposedGithubTrigger,
      provider: "webhook",
    });
    coreMocks.finishCompanionControlRequest.mockImplementation(async (input) => ({
      ...applying,
      status: "applied" as const,
      result: input.result ?? null,
      applied_at: NOW,
    }));

    const response = await appWithRoutes().request(jsonPost(
      `/v1/companions/${COMPANION_ID}/decisions/${RETRY_ID}`,
      { action: "allow" },
    ));

    expect(response.status).toBe(202);
    expect(coreMocks.finishCompanionControlRequest).toHaveBeenCalledWith(expect.objectContaining({
      result: {
        trigger: expect.objectContaining({
          id: TRIGGER_ID,
          webhook_url: null,
        }),
      },
    }));
    const finishInput = coreMocks.finishCompanionControlRequest.mock.calls[0]?.[0];
    expect(JSON.stringify(finishInput?.result)).not.toContain(TRIGGER_SECRET);
  });

  it("retries remote trigger registration and serves bounded trigger history", async () => {
    const failedTrigger = {
      id: TRIGGER_ID,
      companion_id: COMPANION_ID,
      name: "CI failed on main",
      prompt: "Investigate the failing workflow.",
      mode: "relay" as const,
      provider: "github" as const,
      provider_account_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      target: { repo: "acme/widgets", events: ["workflow_run"] },
      registration_status: "failed" as const,
      remote_hook_id: null,
      remote_hook_account_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      last_registration_error: "github rejected the webhook (403)",
      enabled: true,
      webhook_url: `http://127.0.0.1:3000/v1/hooks/triggers/${TRIGGER_ID}/${TRIGGER_SECRET}`,
      last_fired_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
      created_at: NOW,
      updated_at: NOW,
    };
    const registered = {
      ...failedTrigger,
      registration_status: "registered" as const,
      remote_hook_id: "43",
      last_registration_error: null,
    };
    coreMocks.listCompanionTriggers
      .mockResolvedValueOnce([failedTrigger])
      .mockResolvedValueOnce([registered]);
    coreMocks.registerCompanionTriggerWebhook.mockResolvedValueOnce({
      status: "registered",
      remote_hook_id: "43",
    });
    const app = appWithRoutes();
    const retried = await app.request(
      `/v1/companions/${COMPANION_ID}/triggers/${TRIGGER_ID}/registration`,
      { method: "POST" },
    );
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toEqual({ trigger: registered });

    const history = { runs: [], next_cursor: null };
    coreMocks.listCompanionTriggerRuns.mockResolvedValueOnce(history);
    const listed = await app.request(
      `/v1/companions/${COMPANION_ID}/triggers/${TRIGGER_ID}/runs?limit=25`,
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual(history);
    expect(coreMocks.listCompanionTriggerRuns).toHaveBeenCalledWith(expect.objectContaining({
      triggerId: TRIGGER_ID,
      limit: 25,
    }));

    // SAFETY: this route test only verifies transport passthrough; the core mock owns validation.
    const run = { run_id: TURN_ID, internal_entries: [], next_entry_cursor: null } as never;
    coreMocks.getCompanionTriggerRun.mockResolvedValueOnce(run);
    const detail = await app.request(
      `/v1/companions/${COMPANION_ID}/trigger-runs/${TURN_ID}?entry_limit=10`,
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual({ run });
  });

  it("maps trigger authorization, absence, and conflict failures onto their statuses", async () => {
    const app = appWithRoutes();
    // The SQL boundary refuses a Viewer write with SQLSTATE 42501; the route translates, only.
    coreMocks.createCompanionTrigger.mockRejectedValue(
      Object.assign(new Error("Companion editor access is required"), { code: "42501" }),
    );
    const forbidden = await app.request(
      jsonPost(`/v1/companions/${COMPANION_ID}/triggers`, {
        id: TRIGGER_ID,
        name: "CI failed on main",
        prompt: "Investigate.",
        provider: "github",
      }),
    );
    expect(forbidden.status).toBe(403);

    // The dedicated not-found error and the raw SQLSTATE both read as an absent trigger.
    coreMocks.updateCompanionTrigger.mockRejectedValue(new CompanionTriggerNotFoundError());
    const missingPatch = await app.request(
      `/v1/companions/${COMPANION_ID}/triggers/${TRIGGER_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(missingPatch.status).toBe(404);
    coreMocks.deleteCompanionTrigger.mockRejectedValue(
      Object.assign(new Error("Companion trigger not found"), { code: "P0002" }),
    );
    const missing = await app.request(`/v1/companions/${COMPANION_ID}/triggers/${TRIGGER_ID}`, {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);

    coreMocks.createCompanionTrigger.mockRejectedValue(
      Object.assign(new Error("trigger id was reused with different trigger intent"), {
        code: "23505",
      }),
    );
    const conflicted = await app.request(
      jsonPost(`/v1/companions/${COMPANION_ID}/triggers`, {
        id: TRIGGER_ID,
        name: "CI failed on main",
        prompt: "Investigate.",
        provider: "github",
      }),
    );
    expect(conflicted.status).toBe(409);

    // A malformed body never reaches the core layer at all.
    coreMocks.createCompanionTrigger.mockClear();
    const malformed = await app.request(
      jsonPost(`/v1/companions/${COMPANION_ID}/triggers`, {
        id: TRIGGER_ID,
        name: "CI failed on main",
        prompt: "Investigate.",
        provider: "slack",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(coreMocks.createCompanionTrigger).not.toHaveBeenCalled();
  });

  it("denies Viewer desktop access before calling the private Runtime service", async () => {
    coreMocks.getCompanionRuntimeView.mockResolvedValue({ ...companion, access: "viewer" });
    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/runtime/desktop`,
      { method: "POST" },
    );
    expect(response.status).toBe(403);
    expect(desktopMocks.mintCompanionDesktop).not.toHaveBeenCalled();
  });

  it("mints an Owner desktop through the private Runtime client only", async () => {
    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/runtime/desktop`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      desktop_url: "https://desktop.example.test/session",
      provisioning: false,
      automation: "lux",
      transport: "webrtc",
    });
    expect(desktopMocks.mintCompanionDesktop).toHaveBeenCalledWith(expect.objectContaining({
      actorId: owner.id,
      orgId: ORG_ID,
      companionId: COMPANION_ID,
    }));
  });
});

describe("Companion trigger webhook", () => {
  const webhookRow = {
    orgId: ORG_ID,
    companionId: COMPANION_ID,
    name: "CI failed on main",
    prompt: "Investigate the failing workflow.",
    provider: "github" as const,
    secret: TRIGGER_SECRET,
    enabled: true,
  };
  const firedTurn = {
    id: TURN_ID,
    companion_id: COMPANION_ID,
    client_message_id: MESSAGE_ID,
    status: "queued" as const,
    queue_sequence: 1,
    latest_attempt: null,
    replying: false,
    error: null,
    state_changed_at: NOW,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };

  function webhookApp(env: NodeJS.ProcessEnv = {
    COMPANION_COMPANIONS_ENABLED: "true",
    COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
  }) {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionTriggerWebhookRoutes(app, env, {
      jsonError: contextMocks.jsonError,
      getCompanionTriggerForWebhook: coreMocks.getCompanionTriggerForWebhook,
      fireCompanionTrigger: coreMocks.fireCompanionTrigger,
      failCompanionTriggerFire: coreMocks.failCompanionTriggerFire,
    });
    return app;
  }

  function fire(input: {
    triggerId?: string;
    secret?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {}): Request {
    return new Request(
      `http://localhost/v1/hooks/triggers/${input.triggerId ?? TRIGGER_ID}/${input.secret ?? TRIGGER_SECRET}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...input.headers },
        body: input.body ?? '{"action":"opened"}',
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // The webhook path is pre-session: no actor, no tenant resolution, only the URL secret.
    contextMocks.jsonError.mockImplementation((_context, error, status = 400) => {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, error: message }, { status });
    });
    coreMocks.getCompanionTriggerForWebhook.mockResolvedValue(webhookRow);
    coreMocks.fireCompanionTrigger.mockResolvedValue({
      outcome: "fired",
      turn: firedTurn,
      replayed: false,
    });
    coreMocks.failCompanionTriggerFire.mockResolvedValue(undefined);
  });

  it("does not exist at all while the Companions flag is off", async () => {
    const response = await webhookApp({}).request(fire());
    expect(response.status).toBe(404);
    expect(coreMocks.getCompanionTriggerForWebhook).not.toHaveBeenCalled();
    expect(coreMocks.fireCompanionTrigger).not.toHaveBeenCalled();
  });

  it("treats a malformed trigger id exactly like an unknown one", async () => {
    const response = await webhookApp().request(fire({ triggerId: "not-a-uuid" }));
    expect(response.status).toBe(404);
    expect(coreMocks.getCompanionTriggerForWebhook).not.toHaveBeenCalled();

    coreMocks.getCompanionTriggerForWebhook.mockResolvedValue(null);
    const unknown = await webhookApp().request(fire());
    expect(unknown.status).toBe(404);
    expect(coreMocks.fireCompanionTrigger).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret before anything fires and never echoes the stored one", async () => {
    const app = webhookApp();
    const wrongOfSameLength = `${TRIGGER_SECRET.slice(0, -1)}0`;
    for (const secret of [wrongOfSameLength, "deadbeef"]) {
      const response = await app.request(fire({ secret }));
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(TRIGGER_SECRET);
    }
    expect(coreMocks.fireCompanionTrigger).not.toHaveBeenCalled();
    expect(coreMocks.failCompanionTriggerFire).not.toHaveBeenCalled();
  });

  it("rejects an oversized payload before trigger lookup or isolated validation", async () => {
    const body = "x".repeat(1024 * 1024 + 1);
    const response = await webhookApp().request(fire({
      body,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "trigger payload exceeds the 1 MB limit",
    });
    expect(coreMocks.getCompanionTriggerForWebhook).not.toHaveBeenCalled();
    expect(coreMocks.fireCompanionTrigger).not.toHaveBeenCalled();
  });

  it("fires with the provider delivery id collapsed into a deterministic message id", async () => {
    const body = '{"action":"opened","number":7}';
    const response = await webhookApp().request(fire({
      body,
      headers: { "x-github-delivery": "gh-delivery-42" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      outcome: "fired",
      replayed: false,
    });
    expect(coreMocks.fireCompanionTrigger).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      triggerId: TRIGGER_ID,
      clientMessageId: triggerFireMessageId({
        triggerId: TRIGGER_ID,
        deliveryId: "gh-delivery-42",
      }),
      content: composeTriggerPrompt(webhookRow.prompt, body),
    }));
    expect(coreMocks.failCompanionTriggerFire).not.toHaveBeenCalled();
  });

  it("reports a replayed delivery without inventing a second turn", async () => {
    coreMocks.fireCompanionTrigger.mockResolvedValue({
      outcome: "replayed",
      turn: firedTurn,
      replayed: true,
    });
    const response = await webhookApp().request(fire());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      outcome: "replayed",
      replayed: true,
    });
  });

  it("answers 409 when the same delivery id arrives with a different payload", async () => {
    coreMocks.fireCompanionTrigger.mockRejectedValue(Object.assign(
      new Error("query failed"),
      { cause: Object.assign(new Error("message intent differs"), { code: "23505" }) },
    ));
    const response = await webhookApp().request(fire());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "a different payload already used this delivery id",
    });
    // A conflicting intent is the caller's fault, not the trigger failing.
    expect(coreMocks.failCompanionTriggerFire).not.toHaveBeenCalled();
  });

  it("books an expurgated failure and answers a fixed 500 on an unexpected error", async () => {
    coreMocks.fireCompanionTrigger.mockRejectedValue(
      new Error("provider exploded with token sk-secret-42"),
    );
    const response = await webhookApp().request(fire());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "trigger fire failed" });
    expect(coreMocks.failCompanionTriggerFire).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      triggerId: TRIGGER_ID,
      errorCode: "fire_failed",
    }));
  });

  it("still answers the fixed 500 when the failure bookkeeping itself fails", async () => {
    coreMocks.fireCompanionTrigger.mockRejectedValue(new Error("boom"));
    coreMocks.failCompanionTriggerFire.mockRejectedValue(new Error("bookkeeping down"));
    const response = await webhookApp().request(fire());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "trigger fire failed" });
  });

  it("answers a fixed 500 when the trigger lookup itself fails", async () => {
    coreMocks.getCompanionTriggerForWebhook.mockRejectedValue(new Error("database down"));
    const response = await webhookApp().request(fire());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "trigger fire failed" });
    expect(coreMocks.fireCompanionTrigger).not.toHaveBeenCalled();
  });
});
