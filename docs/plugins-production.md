# Production plugins

The production OAuth clients are dedicated to this product. Gmail uses Google Cloud project
`companions-build-prod`; its Gmail and Gmail MCP APIs are enabled. Configure Google consent
branding with `/about`, `/privacy` and `/terms`, which must remain public without signing in.
Publishing the application and Google verification are separate provider-controlled steps.

All curated OAuth connections return to `https://companions.build/api/plugins/callback`.
For another deployment, use its public `APP_URL` with the same path. Keep `APP_URL`
and `BETTER_AUTH_URL` consistent. Register the exact callback with each static
OAuth client; a callback belonging to the old Companion product does not configure this product.

## Provider setup

| Provider | API and executor configuration | Provider console configuration |
| --- | --- | --- |
| Linear, Notion, Conductor, Sentry, Railway | No static client secrets | Dynamic registration runs when a user starts connecting; each user still grants consent. |
| Skillpack | No static client secrets | Dynamic registration against `https://skillpack.app`. The consent screen carries a workspace picker: one connection acts in exactly one Skillpack workspace, with the connecting member's own rights. To reach a second workspace, connect Skillpack again and choose it. Revoke from Skillpack's own settings or by disconnecting here. |
| GitHub | `COMPANION_MCP_GITHUB_CLIENT_ID`, `COMPANION_MCP_GITHUB_CLIENT_SECRET` | Dedicated OAuth App, homepage `https://companions.build`, exact callback above. The broker requests `repo`, `read:org`, `read:user`, `user:email`, `admin:repo_hook`. |
| Slack | `COMPANION_MCP_SLACK_CLIENT_ID`, `COMPANION_MCP_SLACK_CLIENT_SECRET` | Dedicated Slack app with a bot, callback above, bot scope `chat:write`. Configure distribution for the intended workspaces. This plugin exposes message posting only. |
| Gmail | `COMPANION_MCP_GMAIL_CLIENT_ID`, `COMPANION_MCP_GMAIL_CLIENT_SECRET` | Web application OAuth client, callback above, consent screen with `gmail.readonly` and `gmail.compose`. Enable `gmail.googleapis.com` and `gmailmcp.googleapis.com` in the same project. |

Gmail MCP is in Google's Workspace Developer Preview. Confirm the project is eligible;
successful OAuth discovery does not prove access to the service. Configure the consent
audience and authorized test users for beta, or complete the applicable Google verification
for public access. Runtime limits Gmail to the read/draft tools declared in
`packages/plugins/oauth.ts`.

Put matching static client credentials on the Railway **api** and **executor** services.
Static client secrets are deliberately removed from stored account grants; refresh reloads
them from the service environment and checks that the client ID still matches.
Do not put static credentials in frontend configuration, Box or repository files.
Redeploy both services after changing their configuration.
Do not reuse or modify another product's clients without checking its existing callbacks and users.

Provider references:

- [GitHub OAuth app creation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [Slack installation with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
- [Slack app distribution](https://docs.slack.dev/app-management/distribution/)
- [Gmail MCP configuration](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)
- [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

## Parallel Search

Connect **Parallel Search** in **Applications**, then grant the connection in a Companion's
settings. The Companion can then search the public web and fetch public pages through
`https://mcp.parallel.ai/mcp`. The connection uses free, rate-limited access without a
Parallel account or API key. Search queries, requested URLs, and any context included
in a tool call go to Parallel. Remove the grant in that Companion's settings to stop tool access.

## Acceptance

1. Verify the six static variables are nonempty and match on the running API and executor
   without printing values.
2. Run `python3 scripts/bun.py scripts/probe-plugin-oauth.ts` for public discovery.
3. In the deployed application's Connections page, start each OAuth provider's flow and verify
   the consent screen. Complete consent with an authorized account; a consent URL alone
   is not successful integration.
4. Check each persisted account's health. Enable it on a test-owned Companion and discover
   its tools. Exercise a read-only operation where available; Slack health uses `auth.test`
   and does not require sending a message.
5. Connect Parallel Search in Applications, grant it to a test Companion, and run
   `web_search` and `web_fetch` with public inputs. Verify the results include source URLs.
6. Verify a refresh preserves the connection and independently selected accounts stay isolated.
7. Archive test-owned Boxes, verify provider state is archived, and stop owned local stacks.

Report discovery, consent, health and runtime tool access separately. Verify runtime
tool access before marking a provider working.
