// @vitest-environment jsdom
//
// Tests for the stt.worker module.
//
// The worker module is a side-effect module: importing it sets self.onmessage to
// the message dispatcher. We call that function directly with crafted MessageEvents
// and assert on the self.postMessage calls it emits back.
//
// @huggingface/transformers is mocked so no model is ever downloaded.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock @huggingface/transformers ─────────────────────────────────────────
// Keep references so individual tests can control resolve/reject.
const mockPipeline = vi.fn();
vi.mock("@huggingface/transformers", () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
  // env is mutated at module load (allowLocalModels, useBrowserCache) — a plain
  // writable object is sufficient.
  env: { allowLocalModels: true, useBrowserCache: false },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Re-imports the worker module with a clean module registry (so that the
 * module-level `transcriber` variable starts as null) and returns a helper
 * that invokes the self.onmessage handler.
 */
async function loadFreshWorker() {
  vi.resetModules();
  await import("./stt.worker.js");
  type Handler = (e: { data: unknown }) => Promise<void>;
  return (data: unknown) =>
    (self as unknown as { onmessage: Handler }).onmessage({ data });
}

// ─── Setup ───────────────────────────────────────────────────────────────────

const mockPostMessage = vi.fn();

beforeEach(() => {
  mockPostMessage.mockClear();
  mockPipeline.mockClear();
  // Override self.postMessage (self === window in jsdom) so we can capture
  // messages the worker emits without hitting the real cross-window API.
  vi.stubGlobal("postMessage", mockPostMessage);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("stt.worker — load", () => {
  it("posts loading then ready on successful model load", async () => {
    // pipeline resolves to a mock transcriber function
    const fakeTranscriber = vi.fn();
    mockPipeline.mockResolvedValueOnce(fakeTranscriber);

    const send = await loadFreshWorker();
    await send({ type: "load", model: "onnx-community/whisper-tiny" });

    const types = mockPostMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("loading");
    expect(types).toContain("ready");
    // loading must come before ready
    expect(types.indexOf("loading")).toBeLessThan(types.indexOf("ready"));
  });

  it("skips re-initialization and posts only ready if model already loaded", async () => {
    // First load
    const fakeTranscriber = vi.fn();
    mockPipeline.mockResolvedValue(fakeTranscriber);

    const send = await loadFreshWorker();
    await send({ type: "load", model: "onnx-community/whisper-tiny" });

    mockPostMessage.mockClear();
    mockPipeline.mockClear();

    // Second load — pipeline must NOT be called again
    await send({ type: "load", model: "onnx-community/whisper-tiny" });

    expect(mockPipeline).not.toHaveBeenCalled();
    const types = mockPostMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(["ready"]);
  });

  it("posts error when pipeline throws", async () => {
    mockPipeline.mockRejectedValueOnce(new Error("network error"));

    const send = await loadFreshWorker();
    await send({ type: "load", model: "onnx-community/whisper-tiny" });

    const types = mockPostMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("error");
    const errorCall = mockPostMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "error",
    );
    expect((errorCall![0] as { message: string }).message).toMatch(/network error/);
  });
});

describe("stt.worker — transcribe", () => {
  it("posts error when transcribe arrives before model is loaded", async () => {
    // Do NOT call load — transcriber is null
    const send = await loadFreshWorker();
    const audio = new Float32Array([0.1, 0.2]);
    await send({ type: "transcribe", audio, sampling_rate: 16000 });

    const types = mockPostMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(["error"]);
  });

  it("posts error when audio is missing", async () => {
    const fakeTranscriber = vi.fn();
    mockPipeline.mockResolvedValueOnce(fakeTranscriber);

    const send = await loadFreshWorker();
    await send({ type: "load", model: "onnx-community/whisper-tiny" });
    mockPostMessage.mockClear();

    // send transcribe with no audio field
    await send({ type: "transcribe", sampling_rate: 16000 });

    const types = mockPostMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(["error"]);
  });

  it("posts result with trimmed text on successful transcription", async () => {
    const fakeTranscriber = vi.fn().mockResolvedValueOnce({ text: "  hello world  " });
    mockPipeline.mockResolvedValueOnce(fakeTranscriber);

    const send = await loadFreshWorker();
    await send({ type: "load", model: "onnx-community/whisper-tiny" });
    mockPostMessage.mockClear();

    const audio = new Float32Array([0.1, 0.2, 0.3]);
    await send({ type: "transcribe", audio, sampling_rate: 44100 });

    const resultCall = mockPostMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "result",
    );
    expect(resultCall).toBeTruthy();
    expect((resultCall![0] as { text: string }).text).toBe("hello world");
  });

  it("handles array result from pipeline (uses first element)", async () => {
    // Some pipeline configurations return an array of results
    const fakeTranscriber = vi
      .fn()
      .mockResolvedValueOnce([{ text: " first chunk " }, { text: " second " }]);
    mockPipeline.mockResolvedValueOnce(fakeTranscriber);

    const send = await loadFreshWorker();
    await send({ type: "load", model: "onnx-community/whisper-tiny" });
    mockPostMessage.mockClear();

    const audio = new Float32Array([0.1]);
    await send({ type: "transcribe", audio, sampling_rate: 44100 });

    const resultCall = mockPostMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "result",
    );
    expect((resultCall![0] as { text: string }).text).toBe("first chunk");
  });

  it("posts error when transcriber throws", async () => {
    const fakeTranscriber = vi.fn().mockRejectedValueOnce(new Error("OOM"));
    mockPipeline.mockResolvedValueOnce(fakeTranscriber);

    const send = await loadFreshWorker();
    await send({ type: "load", model: "onnx-community/whisper-tiny" });
    mockPostMessage.mockClear();

    const audio = new Float32Array([0.1]);
    await send({ type: "transcribe", audio, sampling_rate: 44100 });

    const types = mockPostMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(["error"]);
    const errorCall = mockPostMessage.mock.calls[0];
    expect((errorCall[0] as { message: string }).message).toMatch(/OOM/);
  });

  it("passes sampling_rate and task options to the transcriber", async () => {
    const fakeTranscriber = vi.fn().mockResolvedValueOnce({ text: "ok" });
    mockPipeline.mockResolvedValueOnce(fakeTranscriber);

    const send = await loadFreshWorker();
    await send({ type: "load", model: "onnx-community/whisper-tiny" });
    mockPostMessage.mockClear();

    const audio = new Float32Array([0.5]);
    await send({ type: "transcribe", audio, sampling_rate: 48000 });

    expect(fakeTranscriber).toHaveBeenCalledWith(
      audio,
      expect.objectContaining({ task: "transcribe", sampling_rate: 48000 }),
    );
  });
});
