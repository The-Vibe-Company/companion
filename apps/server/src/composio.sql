-- Curated MCP Apps moved to Composio. Their stored grants cannot be reused, so owners reconnect.
-- Native GitHub stays for git credentials; custom MCP servers stay on the agent computer.
DELETE FROM plugin_accounts WHERE provider NOT IN ('custom','github','composio');
CREATE INDEX IF NOT EXISTS plugin_composio_account ON plugin_accounts((configuration->>'connectedAccountId')) WHERE provider='composio';
CREATE TABLE IF NOT EXISTS composio_triggers (
 id uuid PRIMARY KEY, owner_id text NOT NULL, companion_id uuid NOT NULL REFERENCES companions(id),
 account_id uuid NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
 trigger_slug text NOT NULL, trigger_name text NOT NULL, trigger_config jsonb NOT NULL DEFAULT '{}',
 instructions text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 20000),
 -- Composio may return one instance for identical subscriptions, so several rows can share it.
 composio_trigger_id text,
 status text NOT NULL DEFAULT 'registering' CHECK (status IN ('registering','active','disabled','error')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS composio_triggers_remote ON composio_triggers(composio_trigger_id);
CREATE INDEX IF NOT EXISTS composio_triggers_companion ON composio_triggers(companion_id,created_at);
CREATE TABLE IF NOT EXISTS composio_trigger_events (
 -- No foreign key: a queued task keeps its payload after its trigger is deleted.
 webhook_id text NOT NULL, trigger_id uuid NOT NULL,
 run_id uuid, payload_secret text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (webhook_id,trigger_id)
);
ALTER TABLE composio_trigger_events DROP CONSTRAINT IF EXISTS composio_trigger_events_trigger_id_fkey;
CREATE INDEX IF NOT EXISTS composio_trigger_events_run ON composio_trigger_events(run_id);
-- Serializes remote changes to one shared Composio subscription without holding a transaction open.
CREATE TABLE IF NOT EXISTS composio_subscription_leases (key text PRIMARY KEY, holder uuid NOT NULL, expires_at timestamptz NOT NULL);
