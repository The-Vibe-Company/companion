import type { AppOAuthAdapterId } from "./definitions";

export interface AppOAuthAdapter {
  /** Verify the protected-resource metadata, then use the definition's pinned endpoints. */
  discovery: "resource-only";
  pkce: boolean;
  resourceIndicator: boolean;
  scopeSeparator: " " | ",";
  acceptedTokenTypes: readonly string[];
  enrichCredential?: "github-identity";
}

const oauthAdapters = {
  github: {
    discovery: "resource-only",
    pkce: true,
    resourceIndicator: false,
    scopeSeparator: " ",
    acceptedTokenTypes: ["bearer"],
    enrichCredential: "github-identity",
  },
} as const satisfies Record<AppOAuthAdapterId, AppOAuthAdapter>;

export function getAppOAuthAdapter(id: AppOAuthAdapterId): AppOAuthAdapter {
  return oauthAdapters[id];
}
