import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInstanceToken } from "./token";

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe("createInstanceToken", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Token format: two base64url parts separated by a dot
  it("returns a string in 'payload.signature' format", async () => {
    const token = await createInstanceToken("test-secret");
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  // 2. Default TTL is 900 seconds
  it("sets exp to now + 900s by default", async () => {
    const token = await createInstanceToken("test-secret");
    const [payloadB64] = token.split(".");
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64)),
    );
    const nowUnix = Math.floor(Date.now() / 1000);
    expect(payload.exp).toBe(nowUnix + 900);
  });

  // 3. Custom TTL works
  it("respects a custom ttlSeconds value", async () => {
    const token = await createInstanceToken("test-secret", 60);
    const [payloadB64] = token.split(".");
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64)),
    );
    const nowUnix = Math.floor(Date.now() / 1000);
    expect(payload.exp).toBe(nowUnix + 60);
  });

  // 4. Deterministic: same secret + same time = same token
  it("produces identical tokens for the same secret and timestamp", async () => {
    const a = await createInstanceToken("deterministic-secret");
    const b = await createInstanceToken("deterministic-secret");
    expect(a).toBe(b);
  });

  // 5. Different secrets produce different signatures
  it("produces different signatures for different secrets", async () => {
    const a = await createInstanceToken("secret-one");
    const b = await createInstanceToken("secret-two");
    const [payloadA, sigA] = a.split(".");
    const [payloadB, sigB] = b.split(".");
    // Payloads are identical (same time, same default TTL)
    expect(payloadA).toBe(payloadB);
    // Signatures differ because secrets differ
    expect(sigA).not.toBe(sigB);
  });

  // 6. Base64url encoding contains no +, /, or = characters
  it("uses base64url encoding with no +, /, or = characters", async () => {
    const token = await createInstanceToken("base64url-test-secret");
    expect(token).not.toMatch(/[+/=]/);
  });

  // 7. Payload decodes to valid JSON with an exp field
  it("payload decodes to valid JSON containing an exp number", async () => {
    const token = await createInstanceToken("json-test", 300);
    const [payloadB64] = token.split(".");
    const decoded = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const payload = JSON.parse(decoded);
    expect(payload).toHaveProperty("exp");
    expect(typeof payload.exp).toBe("number");
  });
});
