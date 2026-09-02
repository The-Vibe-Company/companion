import { afterEach, describe, expect, it } from "vitest";

import { createBoxSimServer, type BoxSimServerHandle } from "../src/server";

const openServers: BoxSimServerHandle[] = [];

async function start(): Promise<BoxSimServerHandle> {
  const handle = createBoxSimServer({ apiKey: "fault-key", controlToken: "fault-control" });
  await handle.listen();
  openServers.push(handle);
  return handle;
}

function request(handle: BoxSimServerHandle, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${handle.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: "Bearer fault-key",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((handle) => handle.close()));
});

describe("deterministic Box faults", () => {
  it("distinguishes a failure before mutation from one after mutation", async () => {
    const handle = await start();
    handle.simulator.addFault({
      point: "box.create.before",
      action: { kind: "http", status: 503, code: "before_create" },
    });
    expect((await request(handle, "/boxes", { method: "POST", body: "{}" })).status).toBe(503);
    expect(handle.simulator.snapshot().boxes).toHaveLength(0);

    handle.simulator.addFault({
      point: "box.create.after",
      action: { kind: "http", status: 502, code: "lost_create_response" },
    });
    expect((await request(handle, "/boxes", { method: "POST", body: "{}" })).status).toBe(502);
    expect(handle.simulator.snapshot().boxes.map((box) => box.id)).toEqual(["bx_23456789"]);
  });

  it("fires a one-shot occurrence exactly once and resets identifiers", async () => {
    const handle = await start();
    handle.simulator.addFault({
      point: "box.create.before",
      occurrence: 2,
      action: { kind: "http", status: 429 },
    });
    expect((await request(handle, "/boxes", { method: "POST", body: "{}" })).status).toBe(202);
    expect((await request(handle, "/boxes", { method: "POST", body: "{}" })).status).toBe(429);
    expect((await request(handle, "/boxes", { method: "POST", body: "{}" })).status).toBe(202);
    expect(handle.simulator.snapshot().boxes.map((box) => box.id)).toEqual([
      "bx_23456789",
      "bx_2345678a",
    ]);
    expect(handle.simulator.snapshot().faults[0]).toMatchObject({ visits: 3, fired: 1 });

    await handle.simulator.reset();
    expect((await request(handle, "/boxes", { method: "POST", body: "{}" })).status).toBe(202);
    expect(handle.simulator.snapshot().boxes[0]?.id).toBe("bx_23456789");
  });

  it("injects command failures without interpreting the command", async () => {
    const handle = await start();
    const created = await (await request(handle, "/boxes", {
      method: "POST",
      body: "{}",
    })).json() as { box: { id: string } };
    await request(handle, `/boxes/${created.box.id}`);
    await request(handle, `/boxes/${created.box.id}`);
    handle.simulator.addFault({
      point: "box.command.before",
      action: { kind: "command", exitCode: 17, stderr: "synthetic command refusal" },
    });

    const response = await request(handle, `/boxes/${created.box.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ command: "touch should-never-exist" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "command.completed",
      success: false,
      exitCode: 17,
      stderr: "synthetic command refusal",
    });
    expect(handle.simulator.commandMachine(created.box.id).persistentFiles.size).toBe(0);
    expect(handle.simulator.commandMachine(created.box.id).unknownCommandDigests).toEqual([]);
  });

  it("can lose a response after persisting the provider-side effect", async () => {
    const handle = await start();
    handle.simulator.addFault({ point: "box.create.after", action: { kind: "disconnect" } });
    await expect(request(handle, "/boxes", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(handle.simulator.snapshot().boxes).toHaveLength(1);
  });
});
