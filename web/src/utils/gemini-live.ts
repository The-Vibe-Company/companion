/**
 * Browser-side WebSocket client for the Gemini 2.5 Flash Live API.
 *
 * Connects directly to wss://generativelanguage.googleapis.com, sends
 * microphone audio as realtimeInput, and receives audio + text + tool calls.
 *
 * Protocol reference: https://ai.google.dev/api/live
 */

export interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiLiveCallbacks {
  /** Called when the Gemini session is set up and ready for audio. */
  onReady: () => void;
  /** Called with base64-encoded PCM 24kHz audio from Gemini. */
  onAudio: (base64Pcm: string) => void;
  /** Called with text content from Gemini (transcript or response). */
  onText: (text: string) => void;
  /** Called when Gemini requests a tool/function call. */
  onToolCall: (call: GeminiToolCall) => void;
  /** Called on connection or protocol error. */
  onError: (error: string) => void;
  /** Called when the WebSocket connection is closed. */
  onDisconnect: () => void;
  /** Called when Gemini interrupts its own output (e.g. user barge-in). */
  onInterrupted: () => void;
}

export interface GeminiLiveConfig {
  /** The Gemini model to use. */
  model?: string;
  /** System instruction for the Gemini session. */
  systemInstruction?: string;
  /** Function declarations for tool calling. */
  tools?: Record<string, unknown>[];
  /** Voice name for speech output. */
  voiceName?: string;
}

const DEFAULT_MODEL = "models/gemini-2.5-flash-preview-native-audio-dialog";
const DEFAULT_VOICE = "Kore";
const GEMINI_WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * WebSocket client for the Gemini Live API.
 *
 * Usage:
 * ```ts
 * const client = new GeminiLiveClient("API_KEY", callbacks, config);
 * client.connect();
 * // Send audio chunks from microphone:
 * client.sendAudio(base64PcmChunk);
 * // When Gemini calls a tool, execute it and respond:
 * client.sendToolResponse(toolCallId, result);
 * // Disconnect:
 * client.disconnect();
 * ```
 */
export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private _connected = false;
  private apiKey: string;
  private callbacks: GeminiLiveCallbacks;
  private config: GeminiLiveConfig;

  constructor(apiKey: string, callbacks: GeminiLiveCallbacks, config: GeminiLiveConfig = {}) {
    this.apiKey = apiKey;
    this.callbacks = callbacks;
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Open the WebSocket and send the setup message. */
  connect(): void {
    if (this.ws) return;

    const url = `${GEMINI_WS_BASE}?key=${encodeURIComponent(this.apiKey)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.sendSetup();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event);
    };

    this.ws.onerror = () => {
      this.callbacks.onError("WebSocket connection error");
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.ws = null;
      this.callbacks.onDisconnect();
    };
  }

  /** Send a base64-encoded PCM 16kHz audio chunk. */
  sendAudio(base64Pcm: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{
          mimeType: "audio/pcm;rate=16000",
          data: base64Pcm,
        }],
      },
    }));
  }

  /** Send a tool/function call response back to Gemini. */
  sendToolResponse(id: string, name: string, result: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{
          id,
          name,
          response: { result: result ?? { success: true } },
        }],
      },
    }));
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    this._connected = false;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private sendSetup(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const model = this.config.model || DEFAULT_MODEL;
    const voiceName = this.config.voiceName || DEFAULT_VOICE;

    const setup: Record<string, unknown> = {
      model,
      generationConfig: {
        responseModalities: ["AUDIO", "TEXT"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    };

    if (this.config.systemInstruction) {
      setup.systemInstruction = {
        parts: [{ text: this.config.systemInstruction }],
      };
    }

    if (this.config.tools && this.config.tools.length > 0) {
      setup.tools = [{ functionDeclarations: this.config.tools }];
    }

    this.ws.send(JSON.stringify({ setup }));
  }

  private handleMessage(event: MessageEvent): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(typeof event.data === "string" ? event.data : "{}");
    } catch {
      console.warn("[gemini-live] Failed to parse message:", String(event.data).substring(0, 120));
      return;
    }

    // Setup complete — session is ready
    if (data.setupComplete !== undefined) {
      this._connected = true;
      this.callbacks.onReady();
      return;
    }

    // Tool calls from the model
    if (data.toolCall) {
      const toolCall = data.toolCall as { functionCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> };
      if (toolCall.functionCalls) {
        for (const fc of toolCall.functionCalls) {
          this.callbacks.onToolCall({
            id: fc.id,
            name: fc.name,
            args: fc.args || {},
          });
        }
      }
      return;
    }

    // Tool call cancellation (barge-in interrupted a pending call)
    if (data.toolCallCancellation) {
      this.callbacks.onInterrupted();
      return;
    }

    // Server content (model response: audio + text)
    if (data.serverContent) {
      const serverContent = data.serverContent as {
        interrupted?: boolean;
        modelTurn?: {
          parts?: Array<{
            text?: string;
            inlineData?: { mimeType: string; data: string };
          }>;
        };
        turnComplete?: boolean;
      };

      // Barge-in: model output was interrupted by user speech
      if (serverContent.interrupted) {
        this.callbacks.onInterrupted();
        return;
      }

      // Extract audio and text from model turn parts
      if (serverContent.modelTurn?.parts) {
        for (const part of serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            this.callbacks.onAudio(part.inlineData.data);
          }
          if (part.text) {
            this.callbacks.onText(part.text);
          }
        }
      }

      return;
    }

    // Handle error messages from the API
    if (data.error) {
      const error = data.error as { message?: string; code?: number };
      this.callbacks.onError(error.message || `Gemini error (code ${error.code})`);
    }
  }
}
