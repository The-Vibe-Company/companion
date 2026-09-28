import type { OAuthFetch } from "../../../packages/plugins/oauth";
import { describe, expect, it, mock } from "bun:test";
const vi = { fn: mock };
import {
  CompanionPluginOAuthError,
  CompanionPluginOAuthRevokedError,
  beginCompanionPluginOAuth,
  companionPluginOAuthCodeChallenge,
  completeCompanionPluginOAuth,
  refreshCompanionPluginOAuth,
} from "../../../packages/plugins/oauth";

const GITHUB = "io.github.github/github-mcp-server";
const GITHUB_ENV = {
  COMPANION_MCP_GITHUB_CLIENT_ID: "github-client",
  COMPANION_MCP_GITHUB_CLIENT_SECRET: "github-client-secret",
};

function jsonResponse<T>(value: T, status = 200): Response {
  return Response.json(value, { status });
}

function formBody(init: RequestInit | undefined): URLSearchParams {
  if (!(init?.body instanceof URLSearchParams)) {
    throw new Error("expected a URL-encoded OAuth request body");
  }
  return init.body;
}

function githubResourceMetadata(): Response {
  return jsonResponse({
    resource: "https://api.githubcopilot.com/mcp/",
    authorization_servers: ["https://github.com/login/oauth"],
  });
}

describe("Companion plugin OAuth broker", () => {
  it("builds a PKCE GitHub authorization URL for git access only, without repository webhook scope", async () => {
    const fetchImpl = vi.fn<OAuthFetch>(async () => githubResourceMetadata());
    const started = await beginCompanionPluginOAuth({
      serverName: GITHUB,
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      state: "signed-state",
      env: GITHUB_ENV,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/",
    );
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorization.searchParams.get("client_id")).toBe("github-client");
    expect(authorization.searchParams.get("state")).toBe("signed-state");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://companion.example/v1/companion-plugins/oauth/callback",
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.flow.codeVerifier).toEqual(expect.any(String));
    expect(authorization.searchParams.get("code_challenge")).toBe(
      companionPluginOAuthCodeChallenge(started.flow.codeVerifier!),
    );
    expect(authorization.searchParams.get("scope")).toBe("repo read:org read:user user:email");
    expect(authorization.searchParams.get("scope")).not.toContain("admin:repo_hook");
    expect(started.flow.tokenEndpoint).toBe("https://github.com/login/oauth/access_token");
    expect(started.flow.resource).toBe("https://api.githubcopilot.com/mcp/");
  });

  it("rejects an unknown server and discovery metadata that moves off the curated remote", async () => {
    await expect(beginCompanionPluginOAuth({
      serverName: "app.linear/linear",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: GITHUB_ENV,
      fetchImpl: vi.fn<OAuthFetch>(),
    })).rejects.toEqual(expect.objectContaining({ code: "oauth_not_supported" }));

    for (const metadata of [
      { resource: "https://api.githubcopilot.com/other-resource", authorization_servers: ["https://github.com/login/oauth"] },
      { resource: "https://evil.example/mcp/", authorization_servers: ["https://github.com/login/oauth"] },
      { resource: "https://api.githubcopilot.com/mcp/", authorization_servers: ["https://evil.example"] },
    ]) {
      await expect(beginCompanionPluginOAuth({
        serverName: GITHUB,
        redirectUri: "https://companion.example/callback",
        state: "state",
        env: GITHUB_ENV,
        fetchImpl: vi.fn<OAuthFetch>(async () => jsonResponse(metadata)),
      })).rejects.toEqual(expect.objectContaining({ code: "oauth_discovery_failed" }));
    }
  });

  it("exchanges and refreshes tokens without exposing provider response bodies", async () => {
    const started = await beginCompanionPluginOAuth({
      serverName: GITHUB,
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      state: "state",
      env: GITHUB_ENV,
      fetchImpl: vi.fn<OAuthFetch>(async () => githubResourceMetadata()),
    });
    const exchangeFetch = vi.fn<OAuthFetch>(async (url, init) => {
      if (String(url) === "https://api.github.com/user") return jsonResponse({ login: "stan" });
      const body = formBody(init);
      expect(body.get("code")).toBe("authorization-code");
      expect(body.get("code_verifier")).toBe(started.flow.codeVerifier);
      return jsonResponse({
        access_token: "access-one",
        refresh_token: "refresh-one",
        expires_in: 60,
        token_type: "bearer",
      });
    });
    const credential = await completeCompanionPluginOAuth({
      flow: started.flow,
      code: "authorization-code",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      fetchImpl: exchangeFetch,
    });
    expect(credential).toMatchObject({
      kind: "oauth",
      accessToken: "access-one",
      refreshToken: "refresh-one",
    });

    const refreshFetch = vi.fn<OAuthFetch>(async (url, init) => {
      if (String(url) === "https://api.github.com/user") return jsonResponse({ login: "stan" });
      const body = formBody(init);
      expect(body.get("refresh_token")).toBe("refresh-one");
      return jsonResponse({ access_token: "access-two", expires_in: 3600 });
    });
    await expect(refreshCompanionPluginOAuth({
      credential,
      env: GITHUB_ENV,
      fetchImpl: refreshFetch,
    })).resolves.toMatchObject({
      accessToken: "access-two",
      refreshToken: "refresh-one",
    });

    const rotatingFetch = vi.fn<OAuthFetch>(async (url) => String(url) === "https://api.github.com/user"
      ? jsonResponse({ login: "stan" })
      : jsonResponse({ access_token: "access-three", refresh_token: "refresh-two", expires_in: 3600 }));
    await expect(refreshCompanionPluginOAuth({
      credential,
      env: GITHUB_ENV,
      fetchImpl: rotatingFetch,
    })).resolves.toMatchObject({
      accessToken: "access-three",
      refreshToken: "refresh-two",
    });

    const failedFetch = vi.fn<OAuthFetch>(async () =>
      jsonResponse({ error: "invalid_grant", error_description: "secret provider detail" }, 400)
    );
    const failed = refreshCompanionPluginOAuth({ credential, env: GITHUB_ENV, fetchImpl: failedFetch });
    await expect(failed).rejects.toEqual(expect.objectContaining({
      code: "oauth_refresh_failed",
      message: expect.not.stringContaining("secret provider detail"),
    }));
    await expect(failed).rejects.not.toBeInstanceOf(CompanionPluginOAuthRevokedError);

    // GitHub reports token errors with HTTP 200 and an `error` body.
    const okErrorFetch = vi.fn<OAuthFetch>(async () =>
      jsonResponse({ error: "bad_refresh_token", error_description: "secret provider detail" })
    );
    await expect(refreshCompanionPluginOAuth({
      credential,
      env: GITHUB_ENV,
      fetchImpl: okErrorFetch,
    })).rejects.toEqual(expect.objectContaining({
      code: "oauth_refresh_failed",
      message: expect.not.stringContaining("secret provider detail"),
    }));

    const malformedSuccess = vi.fn<OAuthFetch>(async () => jsonResponse({
      refresh_token: "provider-secret-that-must-not-leak",
      expires_in: 3600,
    }));
    await expect(refreshCompanionPluginOAuth({
      credential,
      env: GITHUB_ENV,
      fetchImpl: malformedSuccess,
    })).rejects.toEqual(expect.objectContaining({
      code: "oauth_refresh_failed",
      stableCode: "mcp_oauth_refresh_failed",
      action: "retry",
      message: expect.not.stringContaining("provider-secret-that-must-not-leak"),
    }));

    const failedExchange = vi.fn<OAuthFetch>(async () =>
      jsonResponse({ error: "bad_verification_code", error_description: "secret provider detail" }, 400)
    );
    await expect(completeCompanionPluginOAuth({
      flow: started.flow,
      code: "authorization-code",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      fetchImpl: failedExchange,
    })).rejects.toEqual(expect.objectContaining({
      code: "oauth_exchange_failed",
      message: expect.not.stringContaining("secret provider detail"),
    }));
  });

  it("requires deployment-owned GitHub OAuth App credentials", async () => {
    const fetchImpl = vi.fn<OAuthFetch>(async () => jsonResponse({
      resource: "https://api.githubcopilot.com/mcp/",
      authorization_servers: ["https://github.com/login/oauth"],
    }));

    await expect(beginCompanionPluginOAuth({
      serverName: "io.github.github/github-mcp-server",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: {},
      fetchImpl,
    })).rejects.toBeInstanceOf(CompanionPluginOAuthError);
    await expect(beginCompanionPluginOAuth({
      serverName: "io.github.github/github-mcp-server",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: {},
      fetchImpl,
    })).rejects.toEqual(expect.objectContaining({ code: "oauth_not_configured" }));
  });

  it("uses GitHub's configured OAuth App without persisting its shared secret or sending resource", async () => {
    const discoveryFetch = vi.fn<OAuthFetch>(async () => jsonResponse({
      resource: "https://api.githubcopilot.com/mcp/",
      authorization_servers: ["https://github.com/login/oauth"],
    }));
    const started = await beginCompanionPluginOAuth({
      serverName: "io.github.github/github-mcp-server",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: {
        COMPANION_MCP_GITHUB_CLIENT_ID: "github-client",
        COMPANION_MCP_GITHUB_CLIENT_SECRET: "github-client-secret",
      },
      fetchImpl: discoveryFetch,
    });
    expect(new URL(started.authorizationUrl).searchParams.has("resource")).toBe(false);

    const exchangeFetch = vi.fn<OAuthFetch>(async (url, init) => {
      if (String(url) === "https://api.github.com/user") {
        return jsonResponse({ login: "stan", name: "Stan Girard", email: null });
      }
      const body = formBody(init);
      expect(body.has("resource")).toBe(false);
      expect(body.get("client_id")).toBe("github-client");
      expect(body.get("client_secret")).toBe("github-client-secret");
      return jsonResponse({
        access_token: "github-access",
        refresh_token: "github-refresh",
        expires_in: 60,
      });
    });
    const credential = await completeCompanionPluginOAuth({
      flow: started.flow,
      code: "github-code",
      redirectUri: "https://companion.example/callback",
      fetchImpl: exchangeFetch,
    });
    expect(credential.client).toEqual({
      clientId: "github-client",
      clientSecret: null,
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(credential.githubIdentity).toEqual({
      login: "stan",
      name: "Stan Girard",
      email: "stan@users.noreply.github.com",
    });
    expect(JSON.stringify(credential)).not.toContain("github-client-secret");

    const refreshFetch = vi.fn<OAuthFetch>(async (url, init) => {
      if (String(url) === "https://api.github.com/user") {
        return jsonResponse({ login: "stan", name: "Stan Girard", email: null });
      }
      const body = formBody(init);
      expect(body.has("resource")).toBe(false);
      expect(body.get("client_id")).toBe("github-client");
      expect(body.get("client_secret")).toBe("github-client-secret");
      return jsonResponse({ access_token: "github-access-two" });
    });
    await expect(refreshCompanionPluginOAuth({
      credential,
      env: {
        COMPANION_MCP_GITHUB_CLIENT_ID: "github-client",
        COMPANION_MCP_GITHUB_CLIENT_SECRET: "github-client-secret",
      },
      fetchImpl: refreshFetch,
    })).resolves.toMatchObject({
      accessToken: "github-access-two",
      githubIdentity: {
        login: "stan",
        name: "Stan Girard",
        email: "stan@users.noreply.github.com",
      },
    });

    const missingConfigFetch = vi.fn<OAuthFetch>();
    await expect(refreshCompanionPluginOAuth({
      credential,
      env: {},
      fetchImpl: missingConfigFetch,
    })).rejects.toEqual(expect.objectContaining({
      code: "oauth_refresh_failed",
      stableCode: "mcp_oauth_refresh_failed",
      action: "retry",
    }));
    expect(missingConfigFetch).not.toHaveBeenCalled();
  });

  it("keeps a GitHub grant when the profile lookup fails", async () => {
    const fetchImpl = vi.fn<OAuthFetch>(async (url) => {
      if (String(url).includes("oauth-protected-resource")) {
        return jsonResponse({
          resource: "https://api.githubcopilot.com/mcp/",
          authorization_servers: ["https://github.com/login/oauth"],
        });
      }
      if (String(url) === "https://api.github.com/user") return jsonResponse({ message: "nope" }, 401);
      return jsonResponse({
        access_token: "github-access",
        refresh_token: "github-refresh",
        expires_in: 60,
      });
    });
    const started = await beginCompanionPluginOAuth({
      serverName: "io.github.github/github-mcp-server",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: {
        COMPANION_MCP_GITHUB_CLIENT_ID: "github-client",
        COMPANION_MCP_GITHUB_CLIENT_SECRET: "github-client-secret",
      },
      fetchImpl,
    });
    const credential = await completeCompanionPluginOAuth({
      flow: started.flow,
      code: "github-code",
      redirectUri: "https://companion.example/callback",
      fetchImpl,
    });
    expect(credential.accessToken).toBe("github-access");
    expect(credential.githubIdentity).toBeUndefined();
  });
});
