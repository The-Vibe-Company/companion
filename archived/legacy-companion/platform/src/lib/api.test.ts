import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api";

function makeChunk(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("api.createInstanceStream", () => {
  const savedFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = savedFetch;
  });

  it("resolves as soon as the SSE done event arrives without waiting for stream close", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: makeChunk(
          [
            'event: progress',
            'data: {"step":"waiting_start","label":"Waiting for server to start","status":"in_progress"}',
            "",
            'event: done',
            'data: {"instance":{"id":"inst-1"}}',
            "",
            "",
          ].join("\r\n"),
        ),
      })
      .mockImplementationOnce(() => new Promise(() => {}));

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({ read, cancel }),
      },
    });

    const onProgress = vi.fn();
    const result = await Promise.race([
      api.createInstanceStream({ plan: "starter", region: "iad" }, onProgress),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 50)),
    ]);

    expect(result).toEqual({ instance: { id: "inst-1" } });
    expect(onProgress).toHaveBeenCalledWith({
      step: "waiting_start",
      label: "Waiting for server to start",
      status: "in_progress",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("throws immediately when the SSE stream emits an error event", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValueOnce({
      done: false,
      value: makeChunk([
        "event: error",
        'data: {"error":"boot failed"}',
        "",
        "",
      ].join("\n")),
    });

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({ read, cancel }),
      },
    });

    await expect(api.createInstanceStream({ plan: "starter", region: "iad" }, vi.fn())).rejects.toThrow("boot failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
