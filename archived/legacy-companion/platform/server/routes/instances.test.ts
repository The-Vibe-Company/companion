import { beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_USER_ID = "user-test-1";
const MOCK_ORG_ID = "org-test-1";

const provisionMock = vi.fn();
const deprovisionMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
const resizeMock = vi.fn();
const createInstanceTokenMock = vi.fn();
const provisionerCtorMock = vi.fn();

const findManyMock = vi.fn();
const findFirstMock = vi.fn();
const insertReturningMock = vi.fn();
const insertValuesMock = vi.fn(() => ({ returning: insertReturningMock }));
const insertMock = vi.fn(() => ({ values: insertValuesMock }));
const updateWhereMock = vi.fn();
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));
const deleteWhereMock = vi.fn();
const deleteMock = vi.fn(() => ({ where: deleteWhereMock }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn(async (c: any, next: any) => {
    c.set("auth", {
      userId: MOCK_USER_ID,
      user: { id: MOCK_USER_ID, email: "test@example.com", name: "Test" },
      activeOrganizationId: MOCK_ORG_ID,
    });
    await next();
  }),
  requireOrganization: vi.fn(async (c: any, next: any) => {
    c.set("organizationId", MOCK_ORG_ID);
    await next();
  }),
}));

vi.mock("../db/index.js", () => ({
  getDb: vi.fn(() => ({
    query: {
      instances: {
        findMany: findManyMock,
        findFirst: findFirstMock,
      },
    },
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
  })),
}));

vi.mock("../services/provisioner.js", () => ({
  Provisioner: class {
    constructor(...args: any[]) {
      provisionerCtorMock(...args);
    }
    provision = provisionMock;
    deprovision = deprovisionMock;
    start = startMock;
    stop = stopMock;
    resize = resizeMock;
  },
}));

vi.mock("../lib/token.js", () => ({
  createInstanceToken: createInstanceTokenMock,
}));

const { instances } = await import("./instances");

describe("instances routes (hetzner)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HETZNER_API_TOKEN = "hcloud-token";
    process.env.COMPANION_IMAGE = "docker.io/stangirard/the-companion-server:latest";
    delete process.env.HETZNER_SSH_KEY_ID;
    delete process.env.HETZNER_SERVER_TYPE_STARTER;
    delete process.env.HETZNER_SERVER_TYPE_PRO;
    delete process.env.HETZNER_SERVER_TYPE_ENTERPRISE;
    delete process.env.COMPANION_LOGIN_URL;

    findManyMock.mockResolvedValue([]);
    findFirstMock.mockResolvedValue(null);
    insertReturningMock.mockResolvedValue([]);
    updateWhereMock.mockResolvedValue(undefined);
    deleteWhereMock.mockResolvedValue(undefined);
    createInstanceTokenMock.mockResolvedValue("token-abc");
  });

  it("lists visible instances", async () => {
    findManyMock.mockResolvedValue([{ id: "inst-1" }]);
    const res = await instances.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instances).toEqual([{ id: "inst-1" }]);
  });

  it("provisions and persists an instance", async () => {
    provisionMock.mockResolvedValue({
      providerMachineId: "srv-123",
      providerVolumeId: "vol-123",
      authSecret: "secret-123",
      hostname: "1.2.3.4",
    });
    insertReturningMock.mockResolvedValue([{ id: "inst-1", hostname: "1.2.3.4" }]);

    const res = await instances.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "starter", ownerType: "shared" }),
    });

    expect(res.status).toBe(200);
    expect(provisionerCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hetznerToken: "hcloud-token",
        companionImage: "docker.io/stangirard/the-companion-server:latest",
      }),
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMachineId: "srv-123",
        providerVolumeId: "vol-123",
        config: { plan: "starter", provider: "hetzner", authMode: "static_token" },
      }),
    );
  });

  it("returns 500 when required env vars are missing", async () => {
    delete process.env.HETZNER_API_TOKEN;

    const res = await instances.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "starter" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("HETZNER_API_TOKEN");
  });

  it("streams create progress and done event", async () => {
    provisionMock.mockImplementation(async (input: any) => {
      input.onProgress?.("creating_volume", "Creating storage volume", "in_progress");
      input.onProgress?.("creating_volume", "Creating storage volume", "done");
      return {
        providerMachineId: "srv-123",
        providerVolumeId: "vol-123",
        authSecret: "secret-123",
        hostname: "1.2.3.4",
      };
    });
    insertReturningMock.mockResolvedValue([{ id: "inst-1", hostname: "1.2.3.4" }]);

    const res = await instances.request("/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "starter" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: progress");
    expect(text).toContain("event: done");
  });

  it("deletes owned instance and deprovisions resources", async () => {
    findFirstMock.mockResolvedValue({
      id: "inst-1",
      providerMachineId: "srv-1",
      providerVolumeId: "vol-1",
      config: { provider: "hetzner", plan: "starter" },
    });

    const res = await instances.request("/inst-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(deprovisionMock).toHaveBeenCalledWith("srv-1", "vol-1");
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
  });

  it("scales owned instance", async () => {
    findFirstMock.mockResolvedValue({
      id: "inst-1",
      providerMachineId: "srv-1",
      config: { provider: "hetzner", plan: "starter" },
    });

    const res = await instances.request("/inst-1/scale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    });

    expect(res.status).toBe(200);
    expect(resizeMock).toHaveBeenCalledWith("srv-1", "pro");
  });

  it("issues instance token", async () => {
    findFirstMock.mockResolvedValue({ id: "inst-1", authSecret: "secret-1" });

    const res = await instances.request("/inst-1/token", { method: "POST" });
    expect(res.status).toBe(200);
    expect(createInstanceTokenMock).toHaveBeenCalledWith("secret-1");
  });
});
