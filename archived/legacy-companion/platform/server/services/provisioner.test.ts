import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Provisioner } from "./provisioner";

const FAKE_AUTH_SECRET = "ab".repeat(32);
vi.mock("node:crypto", () => ({
  randomBytes: vi.fn((size?: number) => ({
    toString: (encoding: string) => {
      if (encoding !== "hex") return "mock";
      if (size === 32) return FAKE_AUTH_SECRET;
      if (size === 4) return "feedbeef";
      return "cd".repeat(size ?? 1);
    },
  })),
}));

function okResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

describe("Provisioner (hetzner)", () => {
  const HETZNER_BASE = "https://api.hetzner.cloud/v1";
  let fetchMock: ReturnType<typeof vi.fn>;
  let savedFetch: typeof global.fetch;
  let serverStatus = "running";

  function setupBaseFetch() {
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const method = opts.method ?? "GET";

      if (url === `${HETZNER_BASE}/volumes` && method === "POST") {
        return Promise.resolve(okResponse({ volume: { id: 901, name: "companion_test", size: 10 } }));
      }
      if (url === `${HETZNER_BASE}/servers` && method === "POST") {
        return Promise.resolve(okResponse({
          server: { id: 801, status: "starting", public_net: { ipv4: { ip: "1.2.3.4" } } },
          action: { id: 701, status: "running", command: "create_server" },
        }));
      }
      if (url === `${HETZNER_BASE}/actions/701` && method === "GET") {
        return Promise.resolve(okResponse({ action: { id: 701, status: "success", command: "create_server" } }));
      }
      if (url === `${HETZNER_BASE}/actions/702` && method === "GET") {
        return Promise.resolve(okResponse({ action: { id: 702, status: "success", command: "poweron" } }));
      }
      if (url === `${HETZNER_BASE}/actions/703` && method === "GET") {
        return Promise.resolve(okResponse({ action: { id: 703, status: "success", command: "poweroff" } }));
      }
      if (url === `${HETZNER_BASE}/actions/704` && method === "GET") {
        return Promise.resolve(okResponse({ action: { id: 704, status: "success", command: "change_type" } }));
      }
      if (url === `${HETZNER_BASE}/servers/801` && method === "GET") {
        return Promise.resolve(okResponse({
          server: { id: 801, status: serverStatus, public_net: { ipv4: { ip: "1.2.3.4" } } },
        }));
      }
      if (url === `${HETZNER_BASE}/servers/801/actions/poweron` && method === "POST") {
        serverStatus = "running";
        return Promise.resolve(okResponse({ action: { id: 702, status: "success", command: "poweron" } }));
      }
      if (url === `${HETZNER_BASE}/servers/801/actions/poweroff` && method === "POST") {
        serverStatus = "off";
        return Promise.resolve(okResponse({ action: { id: 703, status: "success", command: "poweroff" } }));
      }
      if (url === `${HETZNER_BASE}/servers/801/actions/change_type` && method === "POST") {
        serverStatus = "off";
        return Promise.resolve(okResponse({ action: { id: 704, status: "success", command: "change_type" } }));
      }
      if (url === `${HETZNER_BASE}/servers/801` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      if (url === `${HETZNER_BASE}/volumes/901` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }

      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(`Unexpected fetch: ${method} ${url}`),
      } as unknown as Response);
    });
  }

  function makeProvisioner() {
    return new Provisioner({
      hetznerToken: "hcloud-token",
      companionImage: "docker.io/stangirard/the-companion-server:latest",
      hetznerServerTypes: {
        starter: "cpx11",
        pro: "cpx21",
        enterprise: "cpx31",
      },
    });
  }

  beforeEach(() => {
    savedFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    serverStatus = "running";
    setupBaseFetch();
  });

  afterEach(() => {
    global.fetch = savedFetch;
  });

  it("provisions volume+server and returns IDs", async () => {
    const provisioner = makeProvisioner();
    const result = await provisioner.provision({
      organizationId: "org-1",
      plan: "starter",
      region: "iad",
      hostname: "demo",
      loginUrl: "https://example.com/login",
    });

    expect(result).toEqual({
      providerMachineId: "801",
      providerVolumeId: "901",
      authSecret: FAKE_AUTH_SECRET,
      hostname: "demo",
    });

    const serverCall = fetchMock.mock.calls.find((c: any[]) => c[0] === `${HETZNER_BASE}/servers`);
    const body = JSON.parse(serverCall![1].body);
    expect(body.server_type).toBe("cpx11");
    expect(body.user_data).toContain("COMPANION_AUTH_TOKEN=");
    expect(body.user_data).toContain("COMPANION_AUTH_ENABLED=0");

    const volumeCall = fetchMock.mock.calls.find((c: any[]) => c[0] === `${HETZNER_BASE}/volumes`);
    expect(JSON.parse(volumeCall![1].body).name).toBe("companion_demo_feedbeef");
    expect(body.name).toBe("companion-demo-feedbeef");
  });

  it("falls back to server ipv4 hostname when hostname is empty", async () => {
    const provisioner = makeProvisioner();
    const result = await provisioner.provision({
      organizationId: "org-1",
      plan: "starter",
      region: "iad",
      hostname: "",
      loginUrl: "",
    });
    expect(result.hostname).toBe("1.2.3.4");
  });

  it("supports start/stop/getStatus/deprovision", async () => {
    const provisioner = makeProvisioner();
    await expect(provisioner.start("801")).resolves.toBeUndefined();
    await expect(provisioner.stop("801")).resolves.toBeUndefined();
    await expect(provisioner.getStatus("801")).resolves.toBe("off");
    await expect(provisioner.deprovision("801", "901")).resolves.toBeUndefined();
  });

  it("resizes with required stop/change/start lifecycle", async () => {
    const provisioner = makeProvisioner();
    await expect(provisioner.resize("801", "pro")).resolves.toBeUndefined();

    const methods = fetchMock.mock.calls.map((c: any[]) => `${c[1].method} ${c[0]}`);
    expect(methods).toContain(`POST ${HETZNER_BASE}/servers/801/actions/poweroff`);
    expect(methods).toContain(`POST ${HETZNER_BASE}/servers/801/actions/change_type`);
    expect(methods).toContain(`POST ${HETZNER_BASE}/servers/801/actions/poweron`);

    const changeTypeCall = fetchMock.mock.calls.find(
      (c: any[]) => c[0] === `${HETZNER_BASE}/servers/801/actions/change_type`,
    );
    expect(JSON.parse(changeTypeCall![1].body).server_type).toBe("cpx21");
  });

  it("sanitizes loginUrl/tailscale values before embedding cloud-init", async () => {
    const provisioner = makeProvisioner();
    await provisioner.provision({
      organizationId: "org-1",
      plan: "starter",
      region: "iad",
      hostname: "demo",
      loginUrl: "https://ok.example.com\nMALICIOUS",
      tailscaleAuthKey: "tskey\nMALICIOUS",
    });

    const serverCall = fetchMock.mock.calls.find((c: any[]) => c[0] === `${HETZNER_BASE}/servers`);
    const body = JSON.parse(serverCall![1].body);
    expect(body.user_data).not.toContain("\nMALICIOUS");
  });

  it("falls back to next location when primary location is unavailable", async () => {
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const method = opts.method ?? "GET";
      if (url === `${HETZNER_BASE}/volumes` && method === "POST") {
        const body = JSON.parse(String(opts.body));
        if (body.location === "ash") {
          return Promise.resolve({
            ok: false,
            status: 422,
            text: () =>
              Promise.resolve(
                `{"error":{"code":"invalid_input","message":"invalid input in field 'location'"}}`,
              ),
          } as unknown as Response);
        }
        return Promise.resolve(okResponse({ volume: { id: 901, name: "companion_test", size: 10 } }));
      }
      if (url === `${HETZNER_BASE}/servers` && method === "POST") {
        return Promise.resolve(okResponse({
          server: { id: 801, status: "starting", public_net: { ipv4: { ip: "1.2.3.4" } } },
          action: { id: 701, status: "running", command: "create_server" },
        }));
      }
      if (url === `${HETZNER_BASE}/actions/701` && method === "GET") {
        return Promise.resolve(okResponse({ action: { id: 701, status: "success", command: "create_server" } }));
      }
      if (url === `${HETZNER_BASE}/servers/801` && method === "GET") {
        return Promise.resolve(okResponse({
          server: { id: 801, status: "running", public_net: { ipv4: { ip: "1.2.3.4" } } },
        }));
      }
      if (url === `${HETZNER_BASE}/servers/801` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      if (url === `${HETZNER_BASE}/volumes/901` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(`Unexpected fetch: ${method} ${url}`),
      } as unknown as Response);
    });

    const provisioner = makeProvisioner();
    await provisioner.provision({
      organizationId: "org-1",
      plan: "starter",
      region: "iad",
      hostname: "demo",
      loginUrl: "",
    });

    const createVolumeBodies = fetchMock.mock.calls
      .filter((c: any[]) => c[0] === `${HETZNER_BASE}/volumes` && c[1].method === "POST")
      .map((c: any[]) => JSON.parse(c[1].body));
    expect(createVolumeBodies[0].location).toBe("ash");
    expect(createVolumeBodies[1].location).toBe("hil");

    const serverCall = fetchMock.mock.calls.find((c: any[]) => c[0] === `${HETZNER_BASE}/servers`);
    expect(JSON.parse(serverCall![1].body).location).toBe("hil");
  });

  it("retries with another location when server type is unsupported in first location", async () => {
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const method = opts.method ?? "GET";
      if (url === `${HETZNER_BASE}/volumes` && method === "POST") {
        const body = JSON.parse(String(opts.body));
        if (body.location === "ash") {
          return Promise.resolve(okResponse({ volume: { id: 901, name: "companion_test_a", size: 10 } }));
        }
        return Promise.resolve(okResponse({ volume: { id: 902, name: "companion_test_b", size: 10 } }));
      }
      if (url === `${HETZNER_BASE}/servers` && method === "POST") {
        const body = JSON.parse(String(opts.body));
        if (body.location === "ash") {
          return Promise.resolve({
            ok: false,
            status: 422,
            text: () =>
              Promise.resolve(
                `{"error":{"code":"invalid_input","message":"unsupported location for server type"}}`,
              ),
          } as unknown as Response);
        }
        return Promise.resolve(okResponse({
          server: { id: 801, status: "starting", public_net: { ipv4: { ip: "1.2.3.4" } } },
          action: { id: 701, status: "running", command: "create_server" },
        }));
      }
      if (url === `${HETZNER_BASE}/actions/701` && method === "GET") {
        return Promise.resolve(okResponse({ action: { id: 701, status: "success", command: "create_server" } }));
      }
      if (url === `${HETZNER_BASE}/servers/801` && method === "GET") {
        return Promise.resolve(okResponse({
          server: { id: 801, status: "running", public_net: { ipv4: { ip: "1.2.3.4" } } },
        }));
      }
      if (url === `${HETZNER_BASE}/volumes/901` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      if (url === `${HETZNER_BASE}/servers/801` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      if (url === `${HETZNER_BASE}/volumes/902` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(`Unexpected fetch: ${method} ${url}`),
      } as unknown as Response);
    });

    const provisioner = makeProvisioner();
    const result = await provisioner.provision({
      organizationId: "org-1",
      plan: "starter",
      region: "iad",
      hostname: "demo",
      loginUrl: "",
    });

    expect(result.providerVolumeId).toBe("902");
    const createdServerBodies = fetchMock.mock.calls
      .filter((c: any[]) => c[0] === `${HETZNER_BASE}/servers` && c[1].method === "POST")
      .map((c: any[]) => JSON.parse(c[1].body));
    expect(createdServerBodies[0].location).toBe("ash");
    expect(createdServerBodies[1].location).toBe("hil");
  });

  it("falls back to another server type within the selected geography", async () => {
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const method = opts.method ?? "GET";
      if (url === `${HETZNER_BASE}/volumes` && method === "POST") {
        return Promise.resolve(okResponse({ volume: { id: 901, name: "companion_test_a", size: 10 } }));
      }
      if (url === `${HETZNER_BASE}/servers` && method === "POST") {
        const body = JSON.parse(String(opts.body));
        if (body.server_type === "cpx11") {
          return Promise.resolve({
            ok: false,
            status: 422,
            text: () =>
              Promise.resolve(
                `{"error":{"code":"invalid_input","message":"unsupported location for server type"}}`,
              ),
          } as unknown as Response);
        }
        return Promise.resolve(okResponse({
          server: { id: 801, status: "starting", public_net: { ipv4: { ip: "1.2.3.4" } } },
          action: { id: 701, status: "running", command: "create_server" },
        }));
      }
      if (url === `${HETZNER_BASE}/actions/701` && method === "GET") {
        return Promise.resolve(okResponse({ action: { id: 701, status: "success", command: "create_server" } }));
      }
      if (url === `${HETZNER_BASE}/servers/801` && method === "GET") {
        return Promise.resolve(okResponse({
          server: { id: 801, status: "running", public_net: { ipv4: { ip: "1.2.3.4" } } },
        }));
      }
      if (url === `${HETZNER_BASE}/volumes/901` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(`Unexpected fetch: ${method} ${url}`),
      } as unknown as Response);
    });

    const provisioner = new Provisioner({
      hetznerToken: "hcloud-token",
      companionImage: "docker.io/stangirard/the-companion-server:latest",
      hetznerServerTypes: {
        starter: "cpx11",
      },
    });

    await provisioner.provision({
      organizationId: "org-1",
      plan: "starter",
      region: "cdg",
      hostname: "demo",
      loginUrl: "",
    });

    const createdServerBodies = fetchMock.mock.calls
      .filter((c: any[]) => c[0] === `${HETZNER_BASE}/servers` && c[1].method === "POST")
      .map((c: any[]) => JSON.parse(c[1].body));

    expect(createdServerBodies.some((body: any) => body.server_type === "cpx11")).toBe(true);
    expect(createdServerBodies.some((body: any) => body.server_type === "cpx22")).toBe(true);
    expect(createdServerBodies.every((body: any) => ["fsn1", "nbg1", "hel1"].includes(body.location))).toBe(true);
  });

  it("retries with a fallback when the configured server type is deprecated", async () => {
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const method = opts.method ?? "GET";
      if (url === `${HETZNER_BASE}/volumes` && method === "POST") {
        return Promise.resolve(okResponse({ volume: { id: 901, name: "companion_test_a", size: 10 } }));
      }
      if (url === `${HETZNER_BASE}/servers` && method === "POST") {
        const body = JSON.parse(String(opts.body));
        if (body.server_type === "104") {
          return Promise.resolve({
            ok: false,
            status: 422,
            text: () =>
              Promise.resolve(
                `{"error":{"code":"invalid_input","message":"server type 104 is deprecated"}}`,
              ),
          } as unknown as Response);
        }
        return Promise.resolve(okResponse({
          server: { id: 801, status: "starting", public_net: { ipv4: { ip: "1.2.3.4" } } },
          action: { id: 701, status: "running", command: "create_server" },
        }));
      }
      if (url === `${HETZNER_BASE}/actions/701` && method === "GET") {
        return Promise.resolve(okResponse({ action: { id: 701, status: "success", command: "create_server" } }));
      }
      if (url === `${HETZNER_BASE}/servers/801` && method === "GET") {
        return Promise.resolve(okResponse({
          server: { id: 801, status: "running", public_net: { ipv4: { ip: "1.2.3.4" } } },
        }));
      }
      if (url === `${HETZNER_BASE}/volumes/901` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(`Unexpected fetch: ${method} ${url}`),
      } as unknown as Response);
    });

    const provisioner = new Provisioner({
      hetznerToken: "hcloud-token",
      companionImage: "docker.io/stangirard/the-companion-server:latest",
      hetznerServerTypes: {
        starter: "104",
      },
    });

    await provisioner.provision({
      organizationId: "org-1",
      plan: "starter",
      region: "cdg",
      hostname: "demo",
      loginUrl: "",
    });

    const createdServerBodies = fetchMock.mock.calls
      .filter((c: any[]) => c[0] === `${HETZNER_BASE}/servers` && c[1].method === "POST")
      .map((c: any[]) => JSON.parse(c[1].body));
    expect(createdServerBodies[0].server_type).toBe("104");
    expect(createdServerBodies.some((body: any) => body.server_type === "cpx11" || body.server_type === "cpx22")).toBe(true);
  });

  it("retries the next European location when a server location is disabled", async () => {
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const method = opts.method ?? "GET";
      if (url === `${HETZNER_BASE}/volumes` && method === "POST") {
        const body = JSON.parse(String(opts.body));
        if (body.location === "nbg1") {
          return Promise.resolve(okResponse({ volume: { id: 901, name: "companion_test_a", size: 10 } }));
        }
        return Promise.resolve(okResponse({ volume: { id: 902, name: "companion_test_b", size: 10 } }));
      }
      if (url === `${HETZNER_BASE}/servers` && method === "POST") {
        const body = JSON.parse(String(opts.body));
        if (body.location === "nbg1") {
          return Promise.resolve({
            ok: false,
            status: 412,
            text: () =>
              Promise.resolve(
                `{"error":{"code":"resource_unavailable","message":"server location disabled"}}`,
              ),
          } as unknown as Response);
        }
        return Promise.resolve(okResponse({
          server: { id: 801, status: "starting", public_net: { ipv4: { ip: "1.2.3.4" } } },
          action: { id: 701, status: "running", command: "create_server" },
        }));
      }
      if (url === `${HETZNER_BASE}/actions/701` && method === "GET") {
        return Promise.resolve(okResponse({ action: { id: 701, status: "success", command: "create_server" } }));
      }
      if (url === `${HETZNER_BASE}/servers/801` && method === "GET") {
        return Promise.resolve(okResponse({
          server: { id: 801, status: "running", public_net: { ipv4: { ip: "1.2.3.4" } } },
        }));
      }
      if (url === `${HETZNER_BASE}/volumes/901` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      if (url === `${HETZNER_BASE}/volumes/902` && method === "DELETE") {
        return Promise.resolve(okResponse({}));
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(`Unexpected fetch: ${method} ${url}`),
      } as unknown as Response);
    });

    const provisioner = new Provisioner({
      hetznerToken: "hcloud-token",
      companionImage: "docker.io/stangirard/the-companion-server:latest",
      hetznerServerTypes: {
        starter: "cpx22",
      },
    });

    await provisioner.provision({
      organizationId: "org-1",
      plan: "starter",
      region: "cdg",
      hostname: "demo",
      loginUrl: "",
    });

    const createdServerBodies = fetchMock.mock.calls
      .filter((c: any[]) => c[0] === `${HETZNER_BASE}/servers` && c[1].method === "POST")
      .map((c: any[]) => JSON.parse(c[1].body));
    expect(createdServerBodies[0].location).toBe("nbg1");
    expect(createdServerBodies[1].location).toBe("hel1");
  });

  it("does not cross from Europe selection into US locations", async () => {
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const method = opts.method ?? "GET";
      if (url === `${HETZNER_BASE}/volumes` && method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 422,
          text: () =>
            Promise.resolve(
              `{"error":{"code":"invalid_input","message":"invalid input in field 'location'"}}`,
            ),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(`Unexpected fetch: ${method} ${url}`),
      } as unknown as Response);
    });

    const provisioner = makeProvisioner();
    await expect(
      provisioner.provision({
        organizationId: "org-1",
        plan: "starter",
        region: "cdg",
        hostname: "demo",
        loginUrl: "",
      }),
    ).rejects.toThrow(/location/);

    const createVolumeBodies = fetchMock.mock.calls
      .filter((c: any[]) => c[0] === `${HETZNER_BASE}/volumes` && c[1].method === "POST")
      .map((c: any[]) => JSON.parse(c[1].body));
    const attemptedLocations = createVolumeBodies.map((b: any) => b.location);
    expect(new Set(attemptedLocations)).toEqual(new Set(["fsn1", "nbg1", "hel1"]));
    expect(attemptedLocations).not.toContain("ash");
  });
});
