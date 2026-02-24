/// <reference lib="webworker" />

import { pipeline, env } from "@huggingface/transformers";

// Cache model in browser IndexedDB so it survives page reloads (fully offline after first download)
env.allowLocalModels = false;
env.useBrowserCache = true;

// Use a loose type to avoid the overly complex union type from ReturnType<typeof pipeline>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Transcriber = (input: Float32Array, options?: Record<string, unknown>) => Promise<any>;
let transcriber: Transcriber | null = null;

interface WorkerInMessage {
  type: "load" | "transcribe";
  audio?: Float32Array;
  model?: string;
  sampling_rate?: number;
}

self.onmessage = async (e: MessageEvent<WorkerInMessage>) => {
  const { type, audio, model, sampling_rate } = e.data;

  if (type === "load") {
    // Already loaded — skip expensive re-initialization
    if (transcriber) {
      self.postMessage({ type: "ready" });
      return;
    }
    self.postMessage({ type: "loading" });
    try {
      // Cast via unknown to avoid TS2590 "Expression produces a union type that is too complex"
      // The @huggingface/transformers pipeline return type is an extremely large union
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pipelineFn = pipeline as (task: string, model: string, opts: Record<string, unknown>) => Promise<any>;
      transcriber = (await pipelineFn(
        "automatic-speech-recognition",
        model ?? "onnx-community/whisper-tiny",
        // q8 quantized runs well on CPU/WASM; device: "wasm" avoids WebGPU/WebNN fallbacks
        { device: "wasm", dtype: "q8" },
      )) as Transcriber;
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err) });
    }
  }

  if (type === "transcribe") {
    if (!transcriber) {
      self.postMessage({ type: "error", message: "Model not loaded yet — please wait and try again" });
      return;
    }
    if (!audio) {
      self.postMessage({ type: "error", message: "No audio data received" });
      return;
    }
    try {
      const result = await transcriber(audio, {
        // No language specified — model auto-detects the spoken language
        task: "transcribe",
        // Pass actual AudioContext sample rate so Transformers.js can resample if needed
        ...(sampling_rate ? { sampling_rate } : {}),
      });
      // pipeline returns an array or a single object depending on input type
      const text = Array.isArray(result)
        ? (result[0] as { text: string }).text
        : (result as { text: string }).text;
      self.postMessage({ type: "result", text: text.trim() });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err) });
    }
  }
};
