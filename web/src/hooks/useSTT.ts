import { useCallback, useEffect, useRef, useState } from "react";

export type STTStatus = "idle" | "loading-model" | "ready" | "recording" | "transcribing" | "error";

export interface UseSTTReturn {
  status: STTStatus;
  transcript: string;
  error: string | null;
  startRecording: () => void;
  stopRecording: () => void;
}

// Model can be overridden via VITE_STT_MODEL env variable.
// Options: onnx-community/whisper-tiny (~38MB multilingual), whisper-base (~74MB), whisper-small (~240MB)
// Use the .en suffix variants (e.g. whisper-tiny.en) for English-only with slightly better accuracy.
const STT_MODEL = import.meta.env.VITE_STT_MODEL ?? "onnx-community/whisper-tiny";

interface WorkerOutMessage {
  type: "loading" | "ready" | "result" | "error";
  text?: string;
  message?: string;
}

/**
 * Manages a Web Worker running Transformers.js v3 ASR (WASM) for offline speech-to-text.
 * The model is lazy-loaded on first recording and cached in browser IndexedDB.
 * Audio is captured via AudioContext and accumulated as Float32Array.
 */
export function useSTT(): UseSTTReturn {
  const [status, setStatus] = useState<STTStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // ScriptProcessorNode used for audio capture (deprecated but widely supported;
  // AudioWorklet would require a separate module file)
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const modelLoadedRef = useRef(false);
  // Whether audio capture is currently active (used in worker message handler)
  const isCapturingRef = useRef(false);
  // Timeout ID for auto-clearing error state; tracked to cancel on unmount
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialize worker on mount
  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/stt.worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
      const { type, text, message } = e.data;
      if (type === "loading") {
        setStatus("loading-model");
      } else if (type === "ready") {
        modelLoadedRef.current = true;
        // If audio capture started while model was loading, switch to recording
        setStatus(isCapturingRef.current ? "recording" : "ready");
      } else if (type === "result") {
        setTranscript(text ?? "");
        setStatus("ready");
      } else if (type === "error") {
        setError(message ?? "Unknown error");
        setStatus("error");
        // Reset to idle/ready after 3 seconds; cancel any pending reset first
        if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
        errorTimeoutRef.current = setTimeout(() => {
          errorTimeoutRef.current = null;
          setError(null);
          setStatus(modelLoadedRef.current ? "ready" : "idle");
        }, 3000);
      }
    };

    workerRef.current = worker;
    return () => {
      // Clean up any active recording resources if unmounting while recording
      if (processorRef.current) {
        processorRef.current.disconnect();
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        processorRef.current.onaudioprocess = null;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void audioContextRef.current?.close();
      processorRef.current = null;
      streamRef.current = null;
      audioContextRef.current = null;
      isCapturingRef.current = false;
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const startRecording = useCallback(async () => {
    if (!workerRef.current || isCapturingRef.current) return;

    setTranscript("");
    setError(null);

    // Lazy-load model on first use
    if (!modelLoadedRef.current) {
      workerRef.current.postMessage({ type: "load", model: STT_MODEL });
    }

    // Acquire mic first — then set the flag so stopRecording never acts on null refs
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDenied =
        msg.toLowerCase().includes("denied") ||
        msg.toLowerCase().includes("notallowed") ||
        msg.toLowerCase().includes("permission");
      setError(
        isDenied
          ? "Microphone access denied. Please allow mic access in your browser."
          : `Could not access microphone: ${msg}`,
      );
      setStatus("error");
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = setTimeout(() => {
        errorTimeoutRef.current = null;
        setError(null);
        setStatus(modelLoadedRef.current ? "ready" : "idle");
      }, 3000);
      return;
    }

    // Stream obtained — now mark as capturing so stopRecording can safely clean up
    isCapturingRef.current = true;
    streamRef.current = stream;

    try {
      const audioCtx = new AudioContext(); // use browser's native sample rate; Transformers.js resamples to 16kHz
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      chunksRef.current = [];

      // eslint-disable-next-line @typescript-eslint/no-deprecated
      processor.onaudioprocess = (ev: AudioProcessingEvent) => {
        chunksRef.current.push(ev.inputBuffer.getChannelData(0).slice());
      };

      source.connect(processor);
      // Connect to a silent destination so onaudioprocess fires without routing
      // mic audio to speakers (which would cause feedback/echo)
      processor.connect(audioCtx.createMediaStreamDestination());

      // If model is already ready, go straight to recording; otherwise wait for ready message
      setStatus(modelLoadedRef.current ? "recording" : "loading-model");
    } catch (err) {
      // Clean up stream and AudioContext if audio graph setup failed
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      void audioContextRef.current?.close();
      audioContextRef.current = null;
      isCapturingRef.current = false;
      setError(`Could not start recording: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("error");
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = setTimeout(() => {
        errorTimeoutRef.current = null;
        setError(null);
        setStatus(modelLoadedRef.current ? "ready" : "idle");
      }, 3000);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (!isCapturingRef.current || !workerRef.current) return;

    // Capture sample rate before closing the context
    const samplingRate = audioContextRef.current?.sampleRate ?? 16000;

    // Stop all audio infrastructure
    processorRef.current?.disconnect();
    if (processorRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      processorRef.current.onaudioprocess = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void audioContextRef.current?.close();

    processorRef.current = null;
    streamRef.current = null;
    audioContextRef.current = null;
    isCapturingRef.current = false;

    // Concatenate recorded chunks into a single Float32Array
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);

    if (totalLength === 0) {
      setStatus(modelLoadedRef.current ? "ready" : "idle");
      return;
    }

    const audio = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }

    setStatus("transcribing");
    // Transfer audio buffer ownership to worker to avoid copying; pass actual sample rate for resampling
    workerRef.current.postMessage({ type: "transcribe", audio, sampling_rate: samplingRate }, [
      audio.buffer,
    ]);
  }, []);

  return { status, transcript, error, startRecording, stopRecording };
}
