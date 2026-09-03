-- Chat attachment bytes have one fixed lifetime. Metadata stays on the transcript entry so an old
-- conversation remains understandable; only the object bytes are removed after thirty days.

ALTER TABLE public.companion_message_attachments
  ADD COLUMN uploaded_at timestamp with time zone,
  ADD COLUMN expires_at timestamp with time zone,
  ADD COLUMN bytes_deleted_at timestamp with time zone;
--> statement-breakpoint

UPDATE public.companion_message_attachments
SET uploaded_at = created_at,
    expires_at = created_at + interval '720 hours';
--> statement-breakpoint

ALTER TABLE public.companion_message_attachments
  ALTER COLUMN uploaded_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN uploaded_at SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '720 hours'),
  ALTER COLUMN expires_at SET NOT NULL,
  ADD CONSTRAINT companion_message_attachments_fixed_expiry_check
    CHECK (expires_at = uploaded_at + interval '720 hours'),
  ADD CONSTRAINT companion_message_attachments_bytes_deleted_check
    CHECK (bytes_deleted_at IS NULL OR bytes_deleted_at >= expires_at);
--> statement-breakpoint

CREATE FUNCTION public.companion_set_attachment_expiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.uploaded_at := COALESCE(NEW.uploaded_at, NEW.created_at, clock_timestamp());
  NEW.expires_at := NEW.uploaded_at + interval '720 hours';
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER companion_message_attachments_00_set_expiry
  BEFORE INSERT ON public.companion_message_attachments
  FOR EACH ROW EXECUTE FUNCTION public.companion_set_attachment_expiry();
--> statement-breakpoint

-- The generic object-deletion outbox already provides idempotent S3/MinIO cleanup. This nullable
-- pointer distinguishes scheduled attachment expiry from a Skill Database deletion without adding
-- another worker or queue. It deliberately has no foreign key: a thread cascade must leave cleanup
-- intent behind after the attachment row is gone.
ALTER TABLE public.skill_database_object_deletions
  ADD COLUMN companion_attachment_id uuid;
--> statement-breakpoint

CREATE UNIQUE INDEX skill_database_object_deletions_attachment_uq
  ON public.skill_database_object_deletions(companion_attachment_id)
  WHERE companion_attachment_id IS NOT NULL;
--> statement-breakpoint

CREATE FUNCTION public.companion_schedule_attachment_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.skill_database_object_deletions(
    storage_key, org_id, available_at, companion_attachment_id
  ) VALUES (
    NEW.storage_key, NEW.org_id, NEW.expires_at, NEW.id
  )
  ON CONFLICT (storage_key) DO UPDATE
  SET org_id = EXCLUDED.org_id,
      available_at = LEAST(
        public.skill_database_object_deletions.available_at,
        EXCLUDED.available_at
      ),
      companion_attachment_id = EXCLUDED.companion_attachment_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER companion_message_attachments_schedule_expiry
  AFTER INSERT ON public.companion_message_attachments
  FOR EACH ROW EXECUTE FUNCTION public.companion_schedule_attachment_expiry();
--> statement-breakpoint

-- Existing live objects enter the same fixed schedule. Already-old rows become immediately
-- claimable; no object is deleted by the migration itself.
INSERT INTO public.skill_database_object_deletions(
  storage_key, org_id, available_at, companion_attachment_id
)
SELECT storage_key, org_id, expires_at, id
FROM public.companion_message_attachments
WHERE bytes_deleted_at IS NULL
ON CONFLICT (storage_key) DO UPDATE
SET available_at = LEAST(
      public.skill_database_object_deletions.available_at,
      EXCLUDED.available_at
    ),
    companion_attachment_id = EXCLUDED.companion_attachment_id;
--> statement-breakpoint

-- Deleting a thread or Companion accelerates its queued object cleanup. Normal expiry never
-- deletes this row, so the transcript retains the filename/type/size and fixed deadline.
CREATE OR REPLACE FUNCTION public.companion_enqueue_attachment_object_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.bytes_deleted_at IS NULL THEN
    INSERT INTO public.skill_database_object_deletions(
      storage_key, org_id, available_at, companion_attachment_id
    ) VALUES (
      OLD.storage_key, OLD.org_id, clock_timestamp(), OLD.id
    )
    ON CONFLICT (storage_key) DO UPDATE
    SET org_id = EXCLUDED.org_id,
        available_at = LEAST(
          public.skill_database_object_deletions.available_at,
          EXCLUDED.available_at
        );
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint

-- A successful object DELETE closes the queue item and records when bytes actually disappeared.
-- The semantic expiry remains the immutable expires_at, even if a self-hosted worker was delayed.
CREATE OR REPLACE FUNCTION public.companion_complete_skill_database_object_deletion(
  p_storage_key text,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_attachment_id uuid;
BEGIN
  SELECT deletion.companion_attachment_id INTO v_attachment_id
  FROM public.skill_database_object_deletions deletion
  WHERE deletion.storage_key = p_storage_key
    AND deletion.claim_token = p_claim_token
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_attachment_id IS NOT NULL THEN
    UPDATE public.companion_message_attachments attachment
    SET bytes_deleted_at = COALESCE(attachment.bytes_deleted_at, clock_timestamp())
    WHERE attachment.id = v_attachment_id
      AND attachment.storage_key = p_storage_key
      AND attachment.expires_at <= clock_timestamp();
  END IF;

  DELETE FROM public.skill_database_object_deletions deletion
  WHERE deletion.storage_key = p_storage_key
    AND deletion.claim_token = p_claim_token;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

-- Reads keep their per-request ACL check, but an expired attachment never yields its storage key.
-- This makes read/download/wake/retry/restaging incapable of extending or bypassing retention.
DROP FUNCTION public.companion_api_read_attachment(uuid,uuid,uuid);
--> statement-breakpoint

CREATE FUNCTION public.companion_api_read_attachment(
  p_org_id uuid,
  p_companion_id uuid,
  p_attachment_id uuid
)
RETURNS TABLE (
  storage_key text,
  content_type text,
  byte_size integer,
  filename text,
  kind public.companion_attachment_kind,
  availability text,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  RETURN QUERY
  SELECT CASE
           WHEN attachment.expires_at <= clock_timestamp() THEN NULL
           ELSE attachment.storage_key
         END,
         attachment.content_type,
         attachment.byte_size,
         attachment.filename,
         attachment.kind,
         CASE
           WHEN attachment.expires_at <= clock_timestamp() THEN 'expired'
           ELSE 'available'
         END,
         attachment.expires_at
  FROM public.companion_message_attachments attachment
  WHERE attachment.org_id = p_org_id
    AND attachment.companion_id = p_companion_id
    AND attachment.id = p_attachment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion attachment not found' USING ERRCODE = 'P0002';
  END IF;
END
$$;
--> statement-breakpoint

-- All window, delta, and full-thread projections share this helper. The availability is computed
-- from the immutable deadline, so a delayed cleanup worker cannot make expired bytes look live.
CREATE OR REPLACE FUNCTION public.companion_api_thread_entry_json(
  p_entry public.companion_transcript_entries
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT jsonb_build_object(
    'event_id', (p_entry).event_id,
    'ordinal', (p_entry).ordinal,
    'role', (p_entry).role,
    'content', (p_entry).content,
    'reasoning', (p_entry).reasoning,
    'author_id', (p_entry).author_id,
    'author_name', author.name,
    'tool', (p_entry).tool,
    'decision', (p_entry).decision,
    'routine', CASE WHEN (p_entry).role = 'user' THEN (
      SELECT CASE WHEN origin.routine_name IS NULL THEN NULL ELSE jsonb_build_object(
        'id', COALESCE(origin.routine_snapshot_id, origin.routine_id),
        'name', origin.routine_name,
        'run_id', origin.id
      ) END
      FROM public.companion_turns origin
      WHERE origin.org_id = (p_entry).org_id
        AND origin.companion_id = (p_entry).companion_id
        AND origin.message_event_id = (p_entry).event_id
      LIMIT 1
    ) ELSE NULL END,
    'trigger', CASE WHEN (p_entry).role = 'user' THEN (
      SELECT CASE WHEN origin.trigger_name IS NULL THEN NULL ELSE jsonb_build_object(
        'id', origin.trigger_id,
        'name', origin.trigger_name
      ) END
      FROM public.companion_turns origin
      WHERE origin.org_id = (p_entry).org_id
        AND origin.companion_id = (p_entry).companion_id
        AND origin.message_event_id = (p_entry).event_id
      LIMIT 1
    ) ELSE NULL END,
    'turn_id', CASE WHEN (p_entry).role = 'user' THEN (
      SELECT origin.id
      FROM public.companion_turns origin
      WHERE origin.org_id = (p_entry).org_id
        AND origin.companion_id = (p_entry).companion_id
        AND origin.message_event_id = (p_entry).event_id
      LIMIT 1
    ) ELSE NULL END,
    'queued', COALESCE((
      SELECT origin.status = 'queued'
      FROM public.companion_turns origin
      WHERE origin.org_id = (p_entry).org_id
        AND origin.companion_id = (p_entry).companion_id
        AND origin.message_event_id = (p_entry).event_id
        AND (p_entry).role = 'user'
      LIMIT 1
    ), false),
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', attachment.id,
        'kind', attachment.kind,
        'content_type', attachment.content_type,
        'byte_size', attachment.byte_size,
        'filename', attachment.filename,
        'position', attachment.position,
        'availability', CASE
          WHEN attachment.expires_at <= clock_timestamp() THEN 'expired'
          ELSE 'available'
        END,
        'expires_at', to_char(
          attachment.expires_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      ) ORDER BY attachment.position)
      FROM public.companion_message_attachments attachment
      WHERE attachment.org_id = (p_entry).org_id
        AND attachment.companion_id = (p_entry).companion_id
        AND attachment.entry_event_id = (p_entry).event_id
    ), '[]'::jsonb),
    'created_at', to_char(
      (p_entry).created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )
  FROM (SELECT 1) singleton
  LEFT JOIN public.profiles author ON author.id = (p_entry).author_id
$$;
--> statement-breakpoint

-- Keep the two legacy full-thread projections aligned with the window/delta helper without
-- copying their long, independently evolved bodies into this migration.
DO $companion_attachment_legacy_projections$
DECLARE
  v_signature text;
  v_definition text;
  v_old text := $old$'position', attachment.position$old$;
  v_new text := $new$'position', attachment.position,
            'availability', CASE
              WHEN attachment.expires_at <= clock_timestamp() THEN 'expired'
              ELSE 'available'
            END,
            'expires_at', to_char(
              attachment.expires_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )$new$;
  v_count integer;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.companion_api_read_thread(uuid,uuid)',
    'public.companion_api_sync_thread(uuid,uuid)'
  ]
  LOOP
    v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
    IF v_definition IS NULL THEN
      RAISE EXCEPTION 'Companion thread projection % is missing', v_signature
        USING ERRCODE = '55000';
    END IF;
    v_count := (
      char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
    ) / char_length(v_old);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'attachment projection rewrite matched % times for %, expected 1',
        v_count, v_signature USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(v_definition, v_old, v_new);
  END LOOP;
END
$companion_attachment_legacy_projections$;
--> statement-breakpoint

-- The object upload completes before enqueue starts. Preserve that completion timestamp instead of
-- deriving retention from the later transaction clock; replay intent deliberately continues to
-- ignore it, so an accepted client_message_id can never slide its existing deadline.
DO $companion_attachment_enqueue_upload_time$
DECLARE
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
    'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text,uuid,text)'
  ));
  v_old_columns text := $old$content_type, byte_size, sha256, filename, position, created_at$old$;
  v_new_columns text := $new$content_type, byte_size, sha256, filename, position, uploaded_at, created_at$new$;
  v_old_values text := $old$part.value ->> 'filename', (part.ordinality - 1)::integer, v_now$old$;
  v_new_values text := $new$part.value ->> 'filename', (part.ordinality - 1)::integer,
      (part.value ->> 'uploaded_at')::timestamp with time zone, v_now$new$;
BEGIN
  IF v_definition IS NULL
     OR (char_length(v_definition) - char_length(replace(v_definition, v_old_columns, '')))
          / char_length(v_old_columns) <> 1
     OR (char_length(v_definition) - char_length(replace(v_definition, v_old_values, '')))
          / char_length(v_old_values) <> 1 THEN
    RAISE EXCEPTION 'Companion enqueue upload-time rewrite did not match the expected function'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(replace(v_definition, v_old_columns, v_new_columns), v_old_values, v_new_values);
END
$companion_attachment_enqueue_upload_time$;
--> statement-breakpoint

-- Preserve the current material function behind a non-callable implementation name, then put an
-- expiry guard at the published signature. Old and new runtime replicas therefore fail closed at
-- the same database boundary before they can read an object or contact Box.
ALTER FUNCTION public.companion_runtime_get_material(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer
) RENAME TO companion_runtime_get_material_before_attachment_retention;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_get_material_before_attachment_retention(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_get_material(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  turn_id uuid,
  attempt_id uuid,
  message_event_id text,
  prompt_text text,
  decision_request_kind public.companion_decision_request_kind,
  decision_response_payload jsonb,
  provider_material jsonb,
  skill_material jsonb,
  mcp_material jsonb,
  model_input jsonb,
  has_visible_output boolean,
  attachments jsonb,
  credential_snapshot_matches boolean,
  box_id text,
  agent_hosted_url text,
  agent_token_ciphertext text,
  agent_observed_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_material record;
BEGIN
  -- The implementation performs the ordinary fenced authorization first. Only an authorized live
  -- claim may learn that one of its own files expired.
  SELECT * INTO v_material
  FROM public.companion_runtime_get_material_before_attachment_retention(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  );
  IF NOT FOUND THEN RETURN; END IF;

  IF p_work_kind = 'attempt' AND EXISTS (
    SELECT 1
    FROM public.companion_turn_attempts attempt
    JOIN public.companion_turns turn_row
      ON turn_row.org_id = attempt.org_id
     AND turn_row.companion_id = attempt.companion_id
     AND turn_row.id = attempt.turn_id
    JOIN public.companion_message_attachments attachment
      ON attachment.org_id = turn_row.org_id
     AND attachment.companion_id = turn_row.companion_id
     AND attachment.entry_event_id = turn_row.message_event_id
     AND attachment.kind = 'user_upload'
    WHERE attempt.org_id = p_org_id
      AND attempt.companion_id = p_companion_id
      AND attempt.id = p_work_id
      AND attachment.expires_at <= clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'The files attached to this message have expired and must be uploaded again.'
      USING ERRCODE = 'P5220';
  END IF;

  turn_id := v_material.turn_id;
  attempt_id := v_material.attempt_id;
  message_event_id := v_material.message_event_id;
  prompt_text := v_material.prompt_text;
  decision_request_kind := v_material.decision_request_kind;
  decision_response_payload := v_material.decision_response_payload;
  provider_material := v_material.provider_material;
  skill_material := v_material.skill_material;
  mcp_material := v_material.mcp_material;
  model_input := v_material.model_input;
  has_visible_output := v_material.has_visible_output;
  attachments := v_material.attachments;
  credential_snapshot_matches := v_material.credential_snapshot_matches;
  box_id := v_material.box_id;
  agent_hosted_url := v_material.agent_hosted_url;
  agent_token_ciphertext := v_material.agent_token_ciphertext;
  agent_observed_at := v_material.agent_observed_at;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

-- Move every explicit caller grant from the hidden implementation to the guarded signature in the
-- same migration, so a rolling runtime cannot bypass retention between migration and grant repair.
DO $companion_attachment_material_acl$
DECLARE
  v_hidden oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_get_material_before_attachment_retention(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
  );
  v_grantee oid;
  v_role name;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT acl.grantee
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
    ) acl
    WHERE source_proc.oid = v_hidden
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> 0
      AND acl.grantee <> source_proc.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid = v_grantee;
    IF v_role IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',
        v_role
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.companion_runtime_get_material_before_attachment_retention(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) FROM %I',
        v_role
      );
    END IF;
  END LOOP;
END
$companion_attachment_material_acl$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_set_attachment_expiry() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_schedule_attachment_expiry() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_get_material(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer
) FROM PUBLIC;
