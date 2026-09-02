import { afterEach, describe, expect, it, vi } from "vitest";

import { AsciiBoxMaintenanceClient } from "./boxMaintenanceClient";

function purgeClient(): AsciiBoxMaintenanceClient {
  return new AsciiBoxMaintenanceClient({
    COMPANION_BOX_API_KEY: "box_test",
    COMPANION_BOX_API_BASE: "https://box.test/v1/",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("named snapshot purge evidence", () => {
  it("returns the typed completed outcome after an accepted deletion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      type: "snapshot.named.deleted",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(purgeClient().deleteNamedSnapshot({
      name: "companion-l14-aaaaaaaaaaaa",
    })).resolves.toBe("completed");
  });

  it("returns the typed absent outcome only for provider not-found evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      code: "unknown_snapshot",
      message: "Named snapshot not found",
    }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })));

    await expect(purgeClient().deleteNamedSnapshot({
      name: "companion-l14-bbbbbbbbbbbb",
    })).resolves.toBe("absent");
  });
});
