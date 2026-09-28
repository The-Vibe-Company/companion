# Production apps and triggers

Third-party apps and triggers come from [Composio](https://docs.composio.dev). Members connect any
Composio toolkit (Gmail, Linear, Notion, Slack, GitHub, Sentry, …) through Composio-hosted consent,
choose which connections each Companion may use, and subscribe a Companion to Composio triggers.
Custom HTTP and stdio MCP servers remain available and run only on the agent computer. A native
GitHub OAuth connection remains solely to give `git` credentials on the agent computer.

## Security model

- The Composio project key (`COMPOSIO_API_KEY`) lives only on the **api** and **executor** services.
  Composio's hosted MCP requires that key, so agents never receive a Composio MCP URL.
- The agent sees a Composio connection as `transport: "composio"` with no credential. Its
  `plugin_tools` and `plugin_call` requests travel through the durable control channel; the
  executor checks that the connection is selected for the Companion, that the tool belongs to the
  connection's toolkit, pins the connected account, and executes it with the tool's current
  version. A control command is claimed before execution, so a redelivered or interrupted call
  reports its recorded or unknown outcome instead of running twice.
- Each owner maps to one Composio user, `companions:<ownerId>`. A consent callback is accepted only
  when Composio reports the pending account `ACTIVE` for that user, toolkit and auth config.
- Trigger webhooks are accepted only with a valid Standard Webhooks signature
  (`webhook-id`, `webhook-timestamp`, `webhook-signature`, 5-minute tolerance). The payload is
  stored encrypted, staged to the task workspace as `trigger-event.json`, and never interpolated
  into the prompt or written to logs.

## Configuration

| Service | Variables |
| --- | --- |
| api, executor | `COMPOSIO_API_KEY`; optional `COMPOSIO_AUTH_CONFIGS` (JSON `{"toolkit":"ac_…"}`) |
| api | `COMPOSIO_WEBHOOK_SECRET` |
| api, executor | `COMPANION_MCP_GITHUB_CLIENT_ID`, `COMPANION_MCP_GITHUB_CLIENT_SECRET` for git access |

Without `COMPOSIO_AUTH_CONFIGS`, the server finds or creates a Composio-managed auth config per
toolkit. Toolkits without Composio-managed auth show as unavailable until an administrator creates
an auth config in the Composio dashboard and adds it to `COMPOSIO_AUTH_CONFIGS`; use the same map
to substitute your own OAuth apps for Composio's.

Register the trigger webhook once per Composio project and deployment:

```sh
COMPOSIO_API_KEY=… APP_URL=https://companions.build bun scripts/composio-setup.ts
```

It subscribes `https://<APP_URL>/api/composio/webhook` to `composio.trigger.message` and
`composio.connected_account.expired` (V3 payloads) and writes the signing secret to the owner-only,
ignored file `.local/composio-webhook-secret` instead of printing it. Set it as
`COMPOSIO_WEBHOOK_SECRET`, redeploy the API, then delete the file.

The GitHub git-access OAuth App returns to `https://companions.build/api/plugins/callback`
(or the deployment's `APP_URL` with the same path) and requests `repo`, `read:org`,
`read:user` and `user:email`. Static client secrets are removed from stored grants and reloaded
from the service environment on refresh. Composio consent returns to the same callback path.

## Triggers

A trigger belongs to one Companion and one Composio connection. Each delivery admits one
background task (`runs.source = 'event'`) with the trigger's instructions; a Composio retry of the
same delivery never admits a second task. Identical subscriptions (same connection, trigger type
and configuration) share one Composio trigger instance: disabling one keeps the shared instance
enabled while another Companion still uses it, and deletion removes the instance with its last
local subscription. Disconnecting a connection or retiring a Companion deletes its subscriptions.

## Acceptance

1. Verify the variables are nonempty and match on the running services without printing values.
2. From the Connections page, connect a Composio toolkit and complete consent with an authorized
   account; a consent URL alone is not a successful connection. Check its health.
3. Enable it on a test-owned Companion and ask for a read-only operation. The Companion must call
   `plugin_tools` then `plugin_call`; verify the result independently.
4. Add a trigger on that Companion, cause the provider event, and verify a background task starts
   with `trigger-event.json` in its inbox. Resending the same delivery must not start another task.
5. Connect GitHub git access and verify `git clone`/`git push` on the agent computer.
6. Disconnect the test connection and verify the Composio account and trigger instances are gone.

Report consent, health, tool access and trigger delivery separately.
