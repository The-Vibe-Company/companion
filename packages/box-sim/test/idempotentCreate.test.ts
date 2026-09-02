import { afterEach, describe, expect, it } from "vitest";

import { createBoxSimServer, type BoxSimServerHandle } from "../src/server";

let server: BoxSimServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("idempotent Box create", () => {
  it("replays a lost response without creating a second Box", async () => {
    server = createBoxSimServer({ apiKey: "fault-key", controlToken: "fault-control" });
    await server.listen();
    const handle = server;
    handle.simulator.addFault({
      point: "box.create.idempotent.after",
      action: { kind: "disconnect" },
    });
    const headers = new Headers({
      Authorization: "Bearer fault-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
    });
    const create = () => fetch(`${handle.baseUrl}/boxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ttlSeconds: 300, noEnv: true }),
    });

    await expect(create()).rejects.toThrow();
    const replay = await create();
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ box: { id: "bx_23456789" } });
    expect(handle.simulator.snapshot().boxes).toHaveLength(1);
  });
});
