/**
 * Audio capture and playback utilities for Gemini Voice Control.
 *
 * - AudioCapture: captures microphone audio as base64-encoded PCM 16kHz 16-bit LE chunks
 * - AudioPlayback: plays base64-encoded PCM 24kHz 16-bit LE audio chunks with gapless queueing
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a Float32Array of samples (range -1..1) to Int16 LE and base64-encode. */
function float32ToBase64Pcm16(samples: Float32Array): string {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    // Clamp to [-1, 1] then scale to Int16 range
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); // little-endian
  }
  return uint8ArrayToBase64(new Uint8Array(buffer));
}

/** Decode base64 PCM 16-bit LE into a Float32Array of samples (range -1..1). */
function base64Pcm16ToFloat32(base64: string): Float32Array {
  const bytes = base64ToUint8Array(base64);
  const sampleCount = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true); // little-endian
    samples[i] = int16 / (int16 < 0 ? 0x8000 : 0x7fff);
  }
  return samples;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Downsample audio from `inputRate` to `outputRate` using simple linear interpolation.
 * Only downsamples (outputRate < inputRate). If rates match, returns input unchanged.
 */
function downsample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  if (outputRate > inputRate) return input; // Don't upsample
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, input.length - 1);
    const frac = srcIndex - srcFloor;
    output[i] = input[srcFloor] * (1 - frac) + input[srcCeil] * frac;
  }
  return output;
}

// ─── AudioCapture ────────────────────────────────────────────────────────────

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 100; // Send audio chunks every ~100ms

/**
 * Captures microphone audio and emits base64 PCM 16kHz 16-bit LE chunks.
 *
 * Usage:
 * ```ts
 * const capture = new AudioCapture();
 * capture.onAudioChunk = (base64) => sendToGemini(base64);
 * await capture.start();
 * // ... later
 * capture.stop();
 * ```
 */
export class AudioCapture {
  onAudioChunk: ((base64Pcm: string) => void) | null = null;

  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private _active = false;

  get active(): boolean {
    return this._active;
  }

  async start(): Promise<void> {
    if (this._active) return;

    // Request microphone — prefer 16kHz mono but accept whatever the browser gives
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: { ideal: TARGET_SAMPLE_RATE },
        channelCount: { exact: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: this.stream.getAudioTracks()[0].getSettings().sampleRate || 44100 });
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

    // ScriptProcessorNode is deprecated but universally supported.
    // AudioWorklet would be better but requires a separate module file.
    const bufferSize = Math.max(256, Math.round(
      (CHUNK_DURATION_MS / 1000) * this.audioContext.sampleRate,
    ));
    // Round to nearest power of 2 (required by ScriptProcessorNode)
    const powerOf2 = Math.pow(2, Math.round(Math.log2(bufferSize)));
    this.processorNode = this.audioContext.createScriptProcessor(
      Math.min(16384, Math.max(256, powerOf2)),
      1, // input channels
      1, // output channels
    );

    const nativeSampleRate = this.audioContext.sampleRate;

    this.processorNode.onaudioprocess = (e) => {
      if (!this._active || !this.onAudioChunk) return;
      const inputData = e.inputBuffer.getChannelData(0);
      // Downsample to 16kHz if needed
      const resampled = downsample(inputData, nativeSampleRate, TARGET_SAMPLE_RATE);
      const base64 = float32ToBase64Pcm16(resampled);
      this.onAudioChunk(base64);
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination); // Required for processing to work
    this._active = true;
  }

  stop(): void {
    this._active = false;
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }
}

// ─── AudioPlayback ───────────────────────────────────────────────────────────

const PLAYBACK_SAMPLE_RATE = 24000;

/**
 * Plays base64-encoded PCM 24kHz 16-bit LE audio chunks with gapless queueing.
 *
 * Usage:
 * ```ts
 * const playback = new AudioPlayback();
 * playback.play(base64PcmChunk);  // Queue chunk
 * playback.play(base64PcmChunk2); // Queued after first
 * playback.stop();                // Stop immediately
 * ```
 */
export class AudioPlayback {
  private audioContext: AudioContext | null = null;
  private nextStartTime = 0;
  private _isPlaying = false;
  private activeSourceCount = 0;

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /** Called when all queued audio has finished playing. */
  onPlaybackEnd: (() => void) | null = null;

  play(base64Pcm: string): void {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    }

    const samples = base64Pcm16ToFloat32(base64Pcm);
    if (samples.length === 0) return;

    const buffer = this.audioContext.createBuffer(1, samples.length, PLAYBACK_SAMPLE_RATE);
    buffer.copyToChannel(new Float32Array(samples), 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    // Schedule gaplessly: play immediately if no audio is queued,
    // otherwise start right after the previous buffer ends.
    const now = this.audioContext.currentTime;
    const startTime = Math.max(now, this.nextStartTime);
    this.nextStartTime = startTime + buffer.duration;

    this.activeSourceCount++;
    this._isPlaying = true;
    source.onended = () => {
      this.activeSourceCount--;
      if (this.activeSourceCount <= 0) {
        this.activeSourceCount = 0;
        this._isPlaying = false;
        this.onPlaybackEnd?.();
      }
    };
    source.start(startTime);
  }

  stop(): void {
    this._isPlaying = false;
    this.activeSourceCount = 0;
    this.nextStartTime = 0;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }
}
