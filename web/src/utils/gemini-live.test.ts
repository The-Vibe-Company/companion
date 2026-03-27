// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeminiLiveClient, type GeminiLiveCallbacks } from "./gemini-live.js";

const GEMINI_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Tracks every mock socket instance for assertions after `connect()`. */
const mockSockets: MockWebSocket[] = [];

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    mockSockets.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateError() {
    this.onerror?.();
  }

  simulateClose() {
    this.onclose?.();
  }
}

function getSocket(): MockWebSocket {
  const ws = mockSockets[mockSockets.length - 1];
  if (!ws) throw new Error("Expected a WebSocket to have been constructed");
  return ws;
}

function createCallbacks(overrides: Partial<GeminiLiveCallbacks> = {}): GeminiLiveCallbacks {
  return {
    onReady: vi.fn(),
    onAudio: vi.fn(),
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onError: vi.fn(),
    onDisconnect: vi.fn(),
    onInterrupted: vi.fn(),
    ...overrides,
  };
}

describe("GeminiLiveClient", () => {
  beforeEach(() => {
    mockSockets.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connect() creates a WebSocket whose URL includes the encoded API key", () => {
    const apiKey = "sk_test_abc+123&x";
    const client = new GeminiLiveClient(apiKey, createCallbacks());
    client.connect();

    const ws = getSocket();
    expect(ws.url).toBe(`${GEMINI_WS_BASE}?key=${encodeURIComponent(apiKey)}`);
  });

  it("on open, sends setup with model, generationConfig, systemInstruction, and tools", () => {
    const tools = [{ name: "get_weather", description: "Weather tool" }];
    const client = new GeminiLiveClient(
      "k",
      createCallbacks(),
      {
        model: "models/custom",
        systemInstruction: "You are a test assistant.",
        tools,
        voiceName: "Puck",
      },
    );
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    expect(ws.sent).toHaveLength(1);
    const payload = JSON.parse(ws.sent[0]!) as { setup: Record<string, unknown> };
    const { setup } = payload;

    expect(setup.model).toBe("models/custom");
    expect(setup.generationConfig).toEqual({
      responseModalities: ["AUDIO", "TEXT"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Puck" },
        },
      },
    });
    expect(setup.systemInstruction).toEqual({
      parts: [{ text: "You are a test assistant." }],
    });
    expect(setup.tools).toEqual([{ functionDeclarations: tools }]);
  });

  it("sendAudio() sends realtimeInput with mediaChunks (PCM 16kHz)", () => {
    const client = new GeminiLiveClient("k", createCallbacks());
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();
    ws.sent.length = 0;

    client.sendAudio("YmFzZTY0YXVkaW8=");

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: "YmFzZTY0YXVkaW8=",
          },
        ],
      },
    });
  });

  it("sendToolResponse() sends toolResponse with functionResponses", () => {
    const client = new GeminiLiveClient("k", createCallbacks());
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();
    ws.sent.length = 0;

    client.sendToolResponse("call-1", "get_weather", { tempF: 72 });

    expect(JSON.parse(ws.sent[0]!)).toEqual({
      toolResponse: {
        functionResponses: [
          {
            id: "call-1",
            name: "get_weather",
            response: { result: { tempF: 72 } },
          },
        ],
      },
    });
  });

  it("disconnect() invokes WebSocket close (and onDisconnect via handler)", () => {
    const onDisconnect = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onDisconnect }));
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    client.disconnect();

    expect(onDisconnect).toHaveBeenCalled();
    expect(mockSockets[mockSockets.length - 1]).toBe(ws);
  });

  it("connected reflects setupComplete and resets on close", () => {
    const client = new GeminiLiveClient("k", createCallbacks());
    expect(client.connected).toBe(false);

    client.connect();
    const ws = getSocket();
    expect(client.connected).toBe(false);

    ws.simulateOpen();
    expect(client.connected).toBe(false);

    ws.simulateMessage({ setupComplete: {} });
    expect(client.connected).toBe(true);

    ws.simulateClose();
    expect(client.connected).toBe(false);
  });

  it("incoming setupComplete triggers onReady", () => {
    const onReady = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onReady }));
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    ws.simulateMessage({ setupComplete: {} });

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("incoming serverContent.modelTurn.parts[].text triggers onText", () => {
    const onText = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onText }));
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    ws.simulateMessage({
      serverContent: {
        modelTurn: {
          parts: [{ text: "Hello from Gemini" }],
        },
      },
    });

    expect(onText).toHaveBeenCalledWith("Hello from Gemini");
  });

  it("incoming serverContent.modelTurn.parts[].inlineData triggers onAudio", () => {
    const onAudio = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onAudio }));
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    ws.simulateMessage({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/pcm",
                data: "cGNtZGF0YQ==",
              },
            },
          ],
        },
      },
    });

    expect(onAudio).toHaveBeenCalledWith("cGNtZGF0YQ==");
  });

  it("incoming toolCall.functionCalls invokes onToolCall once per call", () => {
    const onToolCall = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onToolCall }));
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    ws.simulateMessage({
      toolCall: {
        functionCalls: [
          { id: "a", name: "one", args: { x: 1 } },
          { id: "b", name: "two", args: {} },
          // Omitted `args` exercises the `fc.args || {}` default in the client.
          { id: "c", name: "three" },
        ],
      },
    });

    expect(onToolCall).toHaveBeenCalledTimes(3);
    expect(onToolCall).toHaveBeenNthCalledWith(1, { id: "a", name: "one", args: { x: 1 } });
    expect(onToolCall).toHaveBeenNthCalledWith(2, { id: "b", name: "two", args: {} });
    expect(onToolCall).toHaveBeenNthCalledWith(3, { id: "c", name: "three", args: {} });
  });

  it("incoming toolCallCancellation triggers onInterrupted", () => {
    const onInterrupted = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onInterrupted }));
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    ws.simulateMessage({ toolCallCancellation: { ids: ["a"] } });

    expect(onInterrupted).toHaveBeenCalledTimes(1);
  });

  it("incoming serverContent.interrupted triggers onInterrupted", () => {
    const onInterrupted = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onInterrupted }));
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    ws.simulateMessage({ serverContent: { interrupted: true } });

    expect(onInterrupted).toHaveBeenCalledTimes(1);
  });

  it("incoming error message triggers onError with API text or code fallback", () => {
    const onError = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onError }));
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    ws.simulateMessage({ error: { message: "quota exceeded", code: 429 } });
    expect(onError).toHaveBeenLastCalledWith("quota exceeded");

    ws.simulateMessage({ error: { code: 500 } });
    expect(onError).toHaveBeenLastCalledWith("Gemini error (code 500)");
  });

  it("WebSocket close event triggers onDisconnect", () => {
    const onDisconnect = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onDisconnect }));
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    ws.simulateClose();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("WebSocket error event triggers onError", () => {
    const onError = vi.fn();
    const client = new GeminiLiveClient("k", createCallbacks({ onError }));
    client.connect();
    const ws = getSocket();

    ws.simulateError();

    expect(onError).toHaveBeenCalledWith("WebSocket connection error");
  });

  it("invalid JSON in a message logs console.warn and does not throw", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new GeminiLiveClient("k", createCallbacks());
    client.connect();
    const ws = getSocket();
    ws.simulateOpen();

    expect(() => {
      ws.onmessage?.({ data: "not-json{{{ " });
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalled();
    const firstArg = warnSpy.mock.calls[0]![0] as string;
    expect(firstArg).toContain("[gemini-live] Failed to parse message:");

    warnSpy.mockRestore();
  });

  it("does not send audio or tool responses when the socket is not OPEN", () => {
    const client = new GeminiLiveClient("k", createCallbacks());
    client.connect();
    const ws = getSocket();

    client.sendAudio("abc");
    client.sendToolResponse("id", "fn", {});

    expect(ws.sent).toHaveLength(0);
  });

  it("second connect() does not create another WebSocket while the first is active", () => {
    const client = new GeminiLiveClient("k", createCallbacks());
    client.connect();
    expect(mockSockets).toHaveLength(1);
    client.connect();
    expect(mockSockets).toHaveLength(1);
  });
});
