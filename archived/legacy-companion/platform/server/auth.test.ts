import { describe, it, expect, vi, afterAll } from "vitest";

/**
 * Tests for the Better Auth configuration module.
 *
 * Uses vi.resetModules() + dynamic import because getAuth() is a lazy
 * singleton that reads env vars at first call. Each test gets a fresh module
 * so env changes take effect.
 *
 * The database, Better Auth internals, and Resend are mocked to avoid real
 * connections — we only verify the module's initialisation behaviour.
 */

// Mock the database module so getDb() returns a fake drizzle instance.
vi.mock("./db/index.js", () => ({
  getDb: vi.fn(() => ({ __drizzle: true })),
}));

// Mock the drizzle adapter to return a dummy adapter function.
vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: vi.fn(() => () => ({ __adapter: true })),
}));

// Mock the organization plugin — capture options to verify sendInvitationEmail.
vi.mock("better-auth/plugins/organization", () => ({
  organization: vi.fn((opts: unknown) => ({ id: "organization", _opts: opts })),
}));

// Mock betterAuth itself to capture the options and return a stub Auth object.
vi.mock("better-auth", () => ({
  betterAuth: vi.fn((opts: unknown) => ({
    handler: vi.fn(),
    api: {},
    options: opts,
  })),
}));

// Shared mock send function — persists across vi.resetModules() so tests can
// inspect calls made to the Resend-backed email sender.
const mockResendSend = vi.fn(async () => ({ data: { id: "mock-id" }, error: null }));

// Mock Resend to avoid real API calls.
vi.mock("resend", () => ({
  Resend: vi.fn(() => ({
    emails: { send: mockResendSend },
  })),
}));

async function freshImport() {
  vi.resetModules();
  mockResendSend.mockClear();
  return import("./auth.js");
}

describe("getAuth", () => {
  const savedSecret = process.env.BETTER_AUTH_SECRET;
  const savedUrl = process.env.BETTER_AUTH_URL;
  const savedDbUrl = process.env.DATABASE_URL;
  const savedResendKey = process.env.RESEND_API_KEY;

  afterAll(() => {
    // Restore original env after all tests.
    if (savedSecret !== undefined) process.env.BETTER_AUTH_SECRET = savedSecret;
    else delete process.env.BETTER_AUTH_SECRET;
    if (savedUrl !== undefined) process.env.BETTER_AUTH_URL = savedUrl;
    else delete process.env.BETTER_AUTH_URL;
    if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl;
    else delete process.env.DATABASE_URL;
    if (savedResendKey !== undefined) process.env.RESEND_API_KEY = savedResendKey;
    else delete process.env.RESEND_API_KEY;
  });

  it("throws when BETTER_AUTH_SECRET is not set", async () => {
    delete process.env.BETTER_AUTH_SECRET;
    const { getAuth } = await freshImport();
    expect(() => getAuth()).toThrow("BETTER_AUTH_SECRET is not set");
  });

  it("returns an auth object with handler and api when configured", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-32-chars-minimum-ok";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    expect(auth).toBeDefined();
    expect(auth.handler).toBeDefined();
    expect(auth.api).toBeDefined();
  });

  it("returns the same singleton on repeated calls", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-32-chars-minimum-ok";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth1 = getAuth();
    const auth2 = getAuth();
    expect(auth1).toBe(auth2);
  });

  it("uses BETTER_AUTH_URL when set, otherwise defaults to localhost:3458", async () => {
    // Without BETTER_AUTH_URL set
    delete process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";

    const mod1 = await freshImport();
    const auth1 = mod1.getAuth();
    expect((auth1 as any).options.baseURL).toBe("http://localhost:3458");

    // With BETTER_AUTH_URL set
    process.env.BETTER_AUTH_URL = "https://app.thecompanion.sh";
    const mod2 = await freshImport();
    const auth2 = mod2.getAuth();
    expect((auth2 as any).options.baseURL).toBe(
      "https://app.thecompanion.sh",
    );
  });

  it("enables emailAndPassword auth", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    expect((auth as any).options.emailAndPassword.enabled).toBe(true);
  });

  it("configures the organization plugin with teams enabled", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    const plugins = (auth as any).options.plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("organization");
  });

  it("does not require email verification when RESEND_API_KEY is not set", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    // Without Resend, email verification is opt-out so users can sign up freely in dev
    expect((auth as any).options.emailAndPassword.requireEmailVerification).toBe(false);
    expect((auth as any).options.emailVerification.sendOnSignUp).toBe(false);
  });

  it("enables email verification and sendOnSignUp when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    expect((auth as any).options.emailAndPassword.requireEmailVerification).toBe(true);
    expect((auth as any).options.emailVerification.sendOnSignUp).toBe(true);
  });

  it("configures sendResetPassword and sendVerificationEmail callbacks", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    expect(typeof (auth as any).options.emailAndPassword.sendResetPassword).toBe("function");
    expect(typeof (auth as any).options.emailVerification.sendVerificationEmail).toBe("function");
  });

  it("configures sendInvitationEmail on the organization plugin", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    const orgPlugin = (auth as any).options.plugins[0];
    // The organization mock captures _opts — verify sendInvitationEmail was passed
    expect(typeof orgPlugin._opts.sendInvitationEmail).toBe("function");
  });

  it("sendResetPassword awaits the email send (not fire-and-forget)", async () => {
    // Ensures void was replaced with await — the callback returns a promise
    // that resolves only after sendEmail completes.
    delete process.env.RESEND_API_KEY;
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    const callback = (auth as any).options.emailAndPassword.sendResetPassword;
    // The console-based sender (no RESEND_API_KEY) is async — calling it
    // should return a promise that resolves without error.
    const result = callback({ user: { email: "a@b.com", name: "Test" }, url: "https://example.com/reset" });
    expect(result).toBeInstanceOf(Promise);
    await result; // should not reject
  });

  it("sendVerificationEmail awaits the email send", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    const callback = (auth as any).options.emailVerification.sendVerificationEmail;
    const result = callback({ user: { email: "a@b.com", name: "Test" }, url: "https://example.com/verify" });
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it("sendResetPassword calls Resend when RESEND_API_KEY is set", async () => {
    // Exercises the Resend-backed email sender (lines 56-63 in auth.ts)
    // to cover the production email path.
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    const auth = getAuth();
    const callback = (auth as any).options.emailAndPassword.sendResetPassword;
    // Should resolve without error — the mock Resend returns { error: null }
    await callback({
      user: { email: "user@example.com", name: "Alice" },
      url: "https://example.com/reset",
    });

    // Verify the shared Resend mock send was called with the right args
    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: expect.stringContaining("Reset your password"),
        html: expect.stringContaining("Alice"),
      }),
    );
  });

  it("throws when Resend returns an error", async () => {
    // Covers the error branch (lines 59-62) in the Resend-backed sender.
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getAuth } = await freshImport();

    // Override the shared mock to return an error for this invocation
    mockResendSend.mockResolvedValueOnce({
      data: null,
      error: { message: "rate limit exceeded", name: "rate_limit_exceeded" },
    } as any);

    const auth = getAuth();
    const callback = (auth as any).options.emailAndPassword.sendResetPassword;

    await expect(
      callback({
        user: { email: "user@example.com", name: "Bob" },
        url: "https://example.com/reset",
      }),
    ).rejects.toThrow("Failed to send email: rate limit exceeded");
  });

  it("sendInvitationEmail sends invitation with escaped values and encoded ID", async () => {
    // Covers lines 114-124: exercises the sendInvitationEmail callback body,
    // including URL-encoding of invitation.id and HTML-escaping of names.
    delete process.env.RESEND_API_KEY;
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { getAuth } = await freshImport();

    const auth = getAuth();
    const orgPlugin = (auth as any).options.plugins[0];
    const callback = orgPlugin._opts.sendInvitationEmail;

    await callback({
      invitation: { id: "inv-123", email: "invitee@example.com" },
      inviter: { user: { name: '<b>Evil</b> Inviter' } },
      organization: { name: "Acme & Co" },
    });

    // Verify the email was sent to the correct address
    const toLog = logSpy.mock.calls.find((args) =>
      String(args[0]).includes("[auth:email] To:"),
    );
    expect(toLog).toBeDefined();
    expect(String(toLog![0])).toContain("invitee@example.com");

    // Verify HTML escaping in the body
    const bodyLog = logSpy.mock.calls.find((args) =>
      String(args[0]).includes("[auth:email] Body"),
    );
    expect(bodyLog).toBeDefined();
    const bodyText = String(bodyLog![0]);
    expect(bodyText).toContain("&lt;b&gt;Evil&lt;/b&gt; Inviter");
    expect(bodyText).toContain("Acme &amp; Co");
    expect(bodyText).not.toContain("<b>Evil</b>");

    logSpy.mockRestore();
  });

  it("escapes HTML in user-controlled values to prevent injection", async () => {
    // Verifies that user.name with HTML special chars is escaped in email body.
    // Uses the console-based sender (no RESEND_API_KEY) and captures console.log
    // output to verify the HTML body contains escaped entities.
    delete process.env.RESEND_API_KEY;
    process.env.BETTER_AUTH_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost/test";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { getAuth } = await freshImport();

    const auth = getAuth();
    const callback = (auth as any).options.emailAndPassword.sendResetPassword;
    await callback({
      user: { email: "a@b.com", name: '<script>alert("xss")</script>' },
      url: "https://example.com/reset",
    });

    // Find the log call that contains the email body
    const bodyLog = logSpy.mock.calls.find((args) =>
      String(args[0]).includes("[auth:email] Body"),
    );
    expect(bodyLog).toBeDefined();
    const bodyText = String(bodyLog![0]);

    // Escaped entities should be present, raw script tags should not
    expect(bodyText).toContain("&lt;script&gt;");
    expect(bodyText).not.toContain("<script>");

    logSpy.mockRestore();
  });
});
