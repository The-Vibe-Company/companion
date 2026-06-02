/**
 * JWT token issuance for authenticating users to their Companion instances.
 *
 * The control plane issues short-lived tokens that the instance's managed-auth
 * middleware verifies using the shared COMPANION_AUTH_SECRET.
 *
 * NOTE: This duplicates the token logic from web/server/middleware/managed-auth.ts.
 * TODO: Extract shared token utilities into a common package (e.g. @companion/auth)
 * to maintain a single source of truth. Both the control plane and the managed
 * instance middleware need compatible token formats.
 */

export async function createInstanceToken(
  secret: string,
  ttlSeconds = 900,
): Promise<string> {
  const payload = { exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64),
  );

  return `${payloadB64}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
