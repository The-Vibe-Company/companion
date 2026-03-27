// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks (browser audio APIs) ─────────────────────────────────────────────

class MockMediaStreamTrack {
  stop = vi.fn();
  getSettings() {
    return { sampleRate: 44100 };
  }
}

class MockMediaStream {
  private tracks = [new MockMediaStreamTrack()];
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class MockScriptProcessorNode {
  onaudioprocess: ((e: AudioProcessingEvent) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
}

class MockAudioBuffer {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {}
  copyToChannel = vi.fn();
  get duration() {
    return this.length / this.sampleRate;
  }
}

class MockMediaStreamAudioSourceNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioContext {
  sampleRate = 44100;
  currentTime = 0;
  destination = {};
  createScriptProcessor = vi.fn(
    (_bufferSize?: number, _inputChannels?: number, _outputChannels?: number) =>
      new MockScriptProcessorNode(),
  );
  createMediaStreamSource = vi.fn(() => new MockMediaStreamAudioSourceNode());
  createBuffer = vi.fn((channels: number, length: number, rate: number) => new MockAudioBuffer(channels, length, rate));
  createBufferSource = vi.fn(() => new MockAudioBufferSourceNode());
  close = vi.fn().mockResolvedValue(undefined);

  constructor(opts?: { sampleRate?: number }) {
    if (opts?.sampleRate != null) {
      this.sampleRate = opts.sampleRate;
    }
  }
}

let mockGetUserMedia: ReturnType<typeof vi.fn>;
let lastCaptureContext: MockAudioContext | null = null;
let lastPlaybackContext: MockAudioContext | null = null;

function installAudioMocks() {
  mockGetUserMedia = vi.fn().mockResolvedValue(new MockMediaStream());

  vi.stubGlobal(
    "navigator",
    {
      mediaDevices: {
        getUserMedia: mockGetUserMedia,
      },
    } as unknown as Navigator,
  );

  vi.stubGlobal(
    "AudioContext",
    vi.fn(function (this: unknown, opts?: { sampleRate?: number }) {
      const ctx = new MockAudioContext(opts);
      // Heuristic: playback uses 24000; capture reads track sample rate (mock returns 44100)
      if (opts?.sampleRate === 24000) {
        lastPlaybackContext = ctx;
      } else {
        lastCaptureContext = ctx;
      }
      return ctx;
    }) as unknown as typeof AudioContext,
  );
}

beforeEach(() => {
  vi.resetModules();
  lastCaptureContext = null;
  lastPlaybackContext = null;
  installAudioMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── AudioCapture ─────────────────────────────────────────────────────────────

describe("AudioCapture", () => {
  it("start() calls getUserMedia with audio constraints", async () => {
    const { AudioCapture } = await import("./voice-audio.js");
    const capture = new AudioCapture();
    await capture.start();

    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
    expect(mockGetUserMedia).toHaveBeenCalledWith({
      audio: {
        sampleRate: { ideal: 16000 },
        channelCount: { exact: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    capture.stop();
  });

  it("start() creates AudioContext and ScriptProcessorNode", async () => {
    const { AudioCapture } = await import("./voice-audio.js");
    const capture = new AudioCapture();
    await capture.start();

    expect(globalThis.AudioContext).toHaveBeenCalled();
    expect(lastCaptureContext).not.toBeNull();
    expect(lastCaptureContext!.createMediaStreamSource).toHaveBeenCalled();
    expect(lastCaptureContext!.createScriptProcessor).toHaveBeenCalled();
    const proc = lastCaptureContext!.createScriptProcessor.mock.results[0].value as MockScriptProcessorNode;
    expect(proc).toBeInstanceOf(MockScriptProcessorNode);
    capture.stop();
  });

  it("audio processing converts Float32 samples to base64 PCM and calls onAudioChunk", async () => {
    const { AudioCapture } = await import("./voice-audio.js");
    const capture = new AudioCapture();
    const chunks: string[] = [];
    capture.onAudioChunk = (b64) => chunks.push(b64);

    await capture.start();
    const proc = lastCaptureContext!.createScriptProcessor.mock.results[0].value as MockScriptProcessorNode;
    expect(proc.onaudioprocess).toBeTypeOf("function");

    const input = new Float32Array([0.25, -0.5, 1, -1]);
    proc.onaudioprocess!({
      inputBuffer: {
        getChannelData: (ch: number) => (ch === 0 ? input : new Float32Array(0)),
      },
    } as unknown as AudioProcessingEvent);

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Non-empty base64 payload for non-zero input after downsample
    expect(chunks[0].length).toBeGreaterThan(0);

    capture.stop();
  });

  it("stop() disconnects nodes, closes context, stops media tracks", async () => {
    const { AudioCapture } = await import("./voice-audio.js");
    const capture = new AudioCapture();
    await capture.start();

    const proc = lastCaptureContext!.createScriptProcessor.mock.results[0].value as MockScriptProcessorNode;
    const src = lastCaptureContext!.createMediaStreamSource.mock.results[0].value as MockMediaStreamAudioSourceNode;
    const stream = (await mockGetUserMedia.mock.results[0].value) as MockMediaStream;
    const track = stream.getTracks()[0] as MockMediaStreamTrack;

    capture.stop();

    expect(proc.disconnect).toHaveBeenCalled();
    expect(src.disconnect).toHaveBeenCalled();
    expect(lastCaptureContext!.close).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  it("stop() on non-active capture does not crash", async () => {
    const { AudioCapture } = await import("./voice-audio.js");
    const capture = new AudioCapture();
    expect(() => capture.stop()).not.toThrow();
  });

  it("active property reflects state correctly", async () => {
    const { AudioCapture } = await import("./voice-audio.js");
    const capture = new AudioCapture();
    expect(capture.active).toBe(false);
    await capture.start();
    expect(capture.active).toBe(true);
    capture.stop();
    expect(capture.active).toBe(false);
  });

  it("double start() is a no-op when already active", async () => {
    const { AudioCapture } = await import("./voice-audio.js");
    const capture = new AudioCapture();
    await capture.start();
    await capture.start();

    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
    expect(globalThis.AudioContext).toHaveBeenCalledTimes(1);
    capture.stop();
  });

  it("does not emit onAudioChunk after stop()", async () => {
    const { AudioCapture } = await import("./voice-audio.js");
    const capture = new AudioCapture();
    const chunks: string[] = [];
    capture.onAudioChunk = (b64) => chunks.push(b64);

    await capture.start();
    const proc = lastCaptureContext!.createScriptProcessor.mock.results[0].value as MockScriptProcessorNode;
    const handler = proc.onaudioprocess;
    expect(handler).toBeTypeOf("function");
    capture.stop();
    expect(proc.onaudioprocess).toBeNull();

    // Invoke the stale handler: implementation must no-op when inactive (clears callback on stop).
    const input = new Float32Array([0.1]);
    handler!({
      inputBuffer: {
        getChannelData: () => input,
      },
    } as unknown as AudioProcessingEvent);

    expect(chunks.length).toBe(0);
  });
});

// ─── AudioPlayback ────────────────────────────────────────────────────────────

describe("AudioPlayback", () => {
  /** Two Int16 LE samples: 0x0000, 0x1000 → minimal valid non-empty PCM base64 */
  function minimalPcmBase64(): string {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setInt16(0, 0, true);
    view.setInt16(2, 4096, true);
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  it("play() creates AudioContext if not existing", async () => {
    const { AudioPlayback } = await import("./voice-audio.js");
    const playback = new AudioPlayback();
    playback.play(minimalPcmBase64());

    expect(globalThis.AudioContext).toHaveBeenCalledTimes(1);
    expect(globalThis.AudioContext).toHaveBeenCalledWith({ sampleRate: 24000 });
    expect(lastPlaybackContext).not.toBeNull();
    playback.stop();
  });

  it("play() creates AudioBuffer and AudioBufferSourceNode", async () => {
    const { AudioPlayback } = await import("./voice-audio.js");
    const playback = new AudioPlayback();
    const b64 = minimalPcmBase64();
    playback.play(b64);

    expect(lastPlaybackContext!.createBuffer).toHaveBeenCalled();
    expect(lastPlaybackContext!.createBufferSource).toHaveBeenCalled();
    const buf = lastPlaybackContext!.createBuffer.mock.results[0].value as MockAudioBuffer;
    expect(buf.copyToChannel).toHaveBeenCalled();
    const source = lastPlaybackContext!.createBufferSource.mock.results[0].value as MockAudioBufferSourceNode;
    expect(source.connect).toHaveBeenCalledWith(lastPlaybackContext!.destination);
    expect(source.start).toHaveBeenCalled();
    playback.stop();
  });

  it("multiple play() calls schedule gaplessly (nextStartTime increases)", async () => {
    const { AudioPlayback } = await import("./voice-audio.js");
    const playback = new AudioPlayback();
    playback.play(minimalPcmBase64());
    lastPlaybackContext!.currentTime = 0;

    playback.play(minimalPcmBase64());

    const s0 = lastPlaybackContext!.createBufferSource.mock.results[0].value as MockAudioBufferSourceNode;
    const s1 = lastPlaybackContext!.createBufferSource.mock.results[1].value as MockAudioBufferSourceNode;

    const t0 = (s0.start as ReturnType<typeof vi.fn>).mock.calls[0][0] as number;
    const t1 = (s1.start as ReturnType<typeof vi.fn>).mock.calls[0][0] as number;

    const buf0 = lastPlaybackContext!.createBuffer.mock.results[0].value as MockAudioBuffer;
    expect(t1).toBeGreaterThanOrEqual(t0 + buf0.duration);
    playback.stop();
  });

  it("stop() closes context and resets state", async () => {
    const { AudioPlayback } = await import("./voice-audio.js");
    const playback = new AudioPlayback();
    playback.play(minimalPcmBase64());
    playback.stop();

    expect(lastPlaybackContext!.close).toHaveBeenCalled();
    playback.play(minimalPcmBase64());
    expect(globalThis.AudioContext).toHaveBeenCalledTimes(2);
    playback.stop();
  });

  it("isPlaying reflects state", async () => {
    const { AudioPlayback } = await import("./voice-audio.js");
    const playback = new AudioPlayback();
    expect(playback.isPlaying).toBe(false);

    playback.play(minimalPcmBase64());
    expect(playback.isPlaying).toBe(true);

    const source = lastPlaybackContext!.createBufferSource.mock.results[0].value as MockAudioBufferSourceNode;
    source.onended?.();
    expect(playback.isPlaying).toBe(false);
  });

  it("onPlaybackEnd callback fires when all sources end", async () => {
    const { AudioPlayback } = await import("./voice-audio.js");
    const playback = new AudioPlayback();
    const end = vi.fn();
    playback.onPlaybackEnd = end;

    playback.play(minimalPcmBase64());
    playback.play(minimalPcmBase64());

    const s0 = lastPlaybackContext!.createBufferSource.mock.results[0].value as MockAudioBufferSourceNode;
    const s1 = lastPlaybackContext!.createBufferSource.mock.results[1].value as MockAudioBufferSourceNode;

    s0.onended?.();
    expect(end).not.toHaveBeenCalled();
    s1.onended?.();
    expect(end).toHaveBeenCalledTimes(1);
    playback.stop();
  });

  it("empty base64 data does not crash", async () => {
    const { AudioPlayback } = await import("./voice-audio.js");
    const playback = new AudioPlayback();
    expect(() => playback.play("")).not.toThrow();
    // play() ensures AudioContext exists before decoding; empty PCM returns early with no buffers scheduled.
    expect(lastPlaybackContext).not.toBeNull();
    expect(lastPlaybackContext!.createBuffer).not.toHaveBeenCalled();
    expect(playback.isPlaying).toBe(false);
    playback.stop();
  });
});
