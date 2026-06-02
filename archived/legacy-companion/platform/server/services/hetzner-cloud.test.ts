import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HetznerCloudClient } from "./hetzner-cloud";

describe("HetznerCloudClient", () => {
  const TOKEN = "hcloud-test-token";
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("creates a volume with bearer auth and returns parsed payload", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ volume: { id: 42, name: "data", size: 100 } }),
    });

    const client = new HetznerCloudClient(TOKEN);
    const volume = await client.createVolume({ name: "data", size: 100, location: "ash" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.hetzner.cloud/v1/volumes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(volume).toEqual({ id: 42, name: "data", size: 100 });
  });

  it("throws a useful error body when api call fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid token"}',
    });

    const client = new HetznerCloudClient(TOKEN);

    await expect(client.getServer("1")).rejects.toThrow(
      "Hetzner API GET /servers/1 failed (401)",
    );
  });

  it("creates a server and returns server/action payload", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        server: { id: 10, name: "companion-1", status: "running" },
        action: { id: 99, status: "running", command: "create_server" },
      }),
    });

    const client = new HetznerCloudClient(TOKEN);
    const result = await client.createServer({
      name: "companion-1",
      server_type: "cpx11",
      location: "ash",
      image: "ubuntu-24.04",
    });

    expect(result.server.id).toBe(10);
    expect(result.action?.id).toBe(99);
  });

  it("supports power/reboot/delete wrappers", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ action: { id: 1, status: "running", command: "poweron" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ action: { id: 2, status: "running", command: "poweroff" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ action: { id: 3, status: "running", command: "reboot" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ action: { id: 4, status: "running", command: "change_type" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "",
      });

    const client = new HetznerCloudClient(TOKEN);
    await expect(client.powerOn(11)).resolves.toEqual(expect.objectContaining({ id: 1 }));
    await expect(client.powerOff(11)).resolves.toEqual(expect.objectContaining({ id: 2 }));
    await expect(client.reboot(11)).resolves.toEqual(expect.objectContaining({ id: 3 }));
    await expect(client.changeType(11, "cpx21")).resolves.toEqual(expect.objectContaining({ id: 4 }));
    await expect(client.deleteServer(11)).resolves.toBeUndefined();
    await expect(client.deleteVolume(12)).resolves.toBeUndefined();
  });

  it("waitForAction resolves when action becomes success", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ action: { id: 50, status: "running", command: "create_server" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ action: { id: 50, status: "success", command: "create_server" } }),
      });

    const client = new HetznerCloudClient(TOKEN);
    const result = await client.waitForAction(50, 5000);
    expect(result.status).toBe("success");
  });

  it("waitForAction throws on failed action", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ action: { id: 50, status: "error", command: "change_type" } }),
    });

    const client = new HetznerCloudClient(TOKEN);
    await expect(client.waitForAction(50, 5000)).rejects.toThrow("Hetzner action 50 failed");
  });

  it("waitForServerStatus resolves when expected status is reached", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ server: { id: 77, status: "starting" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ server: { id: 77, status: "running" } }),
      });

    const client = new HetznerCloudClient(TOKEN);
    const server = await client.waitForServerStatus(77, "running", 5000);
    expect(server.status).toBe("running");
  });
});
