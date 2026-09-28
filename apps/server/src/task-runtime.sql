ALTER TABLE runs ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'main';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'chat';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS response_root_id uuid REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS result_text text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS publish_to_chat boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS resume_requested_at timestamptz;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK(status IN ('queued','preparing','running','needs_input','succeeded','failed','interrupted','cancelled'));
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_lane_check;
ALTER TABLE runs ADD CONSTRAINT runs_lane_check CHECK(lane IN ('main','background'));
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_source_check;
ALTER TABLE runs ADD CONSTRAINT runs_source_check CHECK(source IN ('chat','background','delegation','event')) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_background_run ON runs(companion_id) WHERE lane='background' AND status IN ('preparing','running','needs_input');
CREATE INDEX IF NOT EXISTS runs_lane_queue ON runs(lane,status,created_at,id);
CREATE INDEX IF NOT EXISTS runs_search ON runs(companion_id,created_at,id);

-- Transitional columns let the discussion backfill distinguish former hidden
-- machines before the destructive legacy migration removes them.
ALTER TABLE companions ADD COLUMN IF NOT EXISTS specialist_draft_id uuid;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS template_id uuid;
