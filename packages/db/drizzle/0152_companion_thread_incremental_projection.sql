-- Long-lived Companion threads synchronize through a monotonic per-thread change stream. The
-- durable transcript remains complete; clients open a bounded recent window and fetch history
-- backwards without changing the member's unread watermark.

ALTER TABLE public.companion_threads
  ADD COLUMN projection_sequence bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE public.companion_transcript_entries
  ADD COLUMN projection_sequence bigint DEFAULT 1;
--> statement-breakpoint

UPDATE public.companion_transcript_entries entry
SET projection_sequence = entry.ordinal::bigint + 1;
--> statement-breakpoint

UPDATE public.companion_threads thread
SET projection_sequence = GREATEST(
  thread.next_ordinal::bigint,
  COALESCE((
    SELECT max(entry.projection_sequence)
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = thread.org_id AND entry.companion_id = thread.companion_id
  ), 0)
);
--> statement-breakpoint

ALTER TABLE public.companion_transcript_entries
  ALTER COLUMN projection_sequence SET NOT NULL,
  ADD CONSTRAINT companion_transcript_entries_projection_sequence_check
    CHECK (projection_sequence >= 1);
ALTER TABLE public.companion_threads
  ADD CONSTRAINT companion_threads_projection_sequence_check
    CHECK (projection_sequence >= 0);
--> statement-breakpoint

CREATE UNIQUE INDEX companion_transcript_entries_projection_sequence_uq
  ON public.companion_transcript_entries(companion_id, projection_sequence);
CREATE INDEX companion_transcript_entries_projection_changes_idx
  ON public.companion_transcript_entries(org_id, companion_id, projection_sequence);
--> statement-breakpoint

CREATE FUNCTION public.companion_thread_allocate_projection_sequence(
  p_org_id uuid,
  p_companion_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_sequence bigint;
BEGIN
  -- Runtime settlement functions predate the transcript change stream and do not all pin the
  -- diagnostic v2 mutation GUC themselves. This SECURITY DEFINER helper is reached before the
  -- aggregate's mutation-fence trigger (the entry trigger is deliberately named `00_…`), so pin
  -- the same narrow protocol marker for the rest of the transaction before touching the thread.
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  UPDATE public.companion_threads thread
  SET projection_sequence = thread.projection_sequence + 1,
      updated_at = clock_timestamp()
  WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
  RETURNING thread.projection_sequence INTO v_sequence;
  IF NOT FOUND THEN
    -- A Companion delete can cascade through the thread before older routine/turn cleanup
    -- triggers finish. There is no surviving client projection to notify in that case, and
    -- rejecting the cascade would make an otherwise valid Companion deletion impossible.
    IF NOT EXISTS (
      SELECT 1
      FROM public.companions companion
      WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
    ) THEN
      RETURN 0;
    END IF;
    RAISE EXCEPTION 'Companion thread projection sequence is unavailable' USING ERRCODE = '23503';
  END IF;
  RETURN v_sequence;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_thread_allocate_projection_sequence(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_thread_sequence_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  NEW.projection_sequence := public.companion_thread_allocate_projection_sequence(
    NEW.org_id, NEW.companion_id
  );
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_thread_sequence_entry() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_transcript_entries_00_projection_sequence
  BEFORE INSERT OR UPDATE ON public.companion_transcript_entries
  FOR EACH ROW EXECUTE FUNCTION public.companion_thread_sequence_entry();
--> statement-breakpoint

CREATE FUNCTION public.companion_thread_touch_turn_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_touched integer;
BEGIN
  UPDATE public.companion_transcript_entries entry
  SET projection_sequence = entry.projection_sequence
  WHERE entry.org_id = NEW.org_id
    AND entry.companion_id = NEW.companion_id
    AND entry.event_id = NEW.message_event_id;
  GET DIAGNOSTICS v_touched = ROW_COUNT;
  IF v_touched = 0 THEN
    PERFORM public.companion_thread_allocate_projection_sequence(NEW.org_id, NEW.companion_id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_thread_touch_turn_entry() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_turns_touch_thread_insert
  AFTER INSERT ON public.companion_turns
  FOR EACH ROW EXECUTE FUNCTION public.companion_thread_touch_turn_entry();
CREATE TRIGGER companion_turns_touch_thread_update
  AFTER UPDATE OF status, routine_id, routine_snapshot_id, routine_name,
    trigger_id, trigger_name, resolution
  ON public.companion_turns
  FOR EACH ROW EXECUTE FUNCTION public.companion_thread_touch_turn_entry();
--> statement-breakpoint

CREATE FUNCTION public.companion_thread_touch_attachment_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_org_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  v_companion_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.companion_id ELSE NEW.companion_id END;
  v_event_id text := CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_event_id ELSE NEW.entry_event_id END;
BEGIN
  UPDATE public.companion_transcript_entries entry
  SET projection_sequence = entry.projection_sequence
  WHERE entry.org_id = v_org_id
    AND entry.companion_id = v_companion_id
    AND entry.event_id = v_event_id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_thread_touch_attachment_entry() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_message_attachments_touch_thread
  AFTER INSERT OR UPDATE OR DELETE ON public.companion_message_attachments
  FOR EACH ROW EXECUTE FUNCTION public.companion_thread_touch_attachment_entry();
--> statement-breakpoint

CREATE FUNCTION public.companion_thread_touch_routine_return()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_org_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  v_companion_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.companion_id ELSE NEW.companion_id END;
  v_run_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  v_main_event_id text := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.main_entry_event_id ELSE NEW.main_entry_event_id
  END;
  v_relay_turn_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.relay_turn_id ELSE NEW.relay_turn_id END;
  v_touched integer;
BEGIN
  UPDATE public.companion_transcript_entries entry
  SET projection_sequence = entry.projection_sequence
  WHERE entry.org_id = v_org_id
    AND entry.companion_id = v_companion_id
    AND (
      entry.event_id = v_main_event_id
      OR entry.turn_id = v_run_id
      OR (v_relay_turn_id IS NOT NULL AND entry.turn_id = v_relay_turn_id)
    );
  GET DIAGNOSTICS v_touched = ROW_COUNT;
  IF v_touched = 0 THEN
    PERFORM public.companion_thread_allocate_projection_sequence(v_org_id, v_companion_id);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_thread_touch_routine_return() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_routine_returns_touch_thread
  AFTER INSERT OR UPDATE OR DELETE ON public.companion_routine_returns
  FOR EACH ROW EXECUTE FUNCTION public.companion_thread_touch_routine_return();
--> statement-breakpoint

CREATE FUNCTION public.companion_api_thread_entry_visible(
  p_entry public.companion_transcript_entries
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT NOT (
    (p_entry).role = 'user'
    AND (
      EXISTS (
        SELECT 1
        FROM public.companion_turns origin
        WHERE origin.org_id = (p_entry).org_id
          AND origin.companion_id = (p_entry).companion_id
          AND origin.message_event_id = (p_entry).event_id
          AND origin.status = 'cancelled'
          AND NOT EXISTS (
            SELECT 1 FROM public.companion_turn_attempts attempt
            WHERE attempt.org_id = origin.org_id
              AND attempt.companion_id = origin.companion_id
              AND attempt.turn_id = origin.id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.companion_routine_returns returned
        WHERE returned.org_id = (p_entry).org_id
          AND returned.companion_id = (p_entry).companion_id
          AND returned.relay_turn_id = (p_entry).turn_id
      )
    )
  )
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_thread_entry_json(
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
        'position', attachment.position
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

CREATE FUNCTION public.companion_api_routine_notify_returns_window(
  p_org_id uuid,
  p_companion_id uuid,
  p_event_ids text[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  WITH notify_returns AS (
    SELECT returned.run_id,
      COALESCE(run_turn.routine_snapshot_id, run_turn.routine_id) AS routine_id,
      run_turn.routine_name,
      returned.main_entry_event_id,
      main_entry.ordinal
    FROM public.companion_routine_returns returned
    JOIN public.companion_turns run_turn
      ON run_turn.org_id = returned.org_id
     AND run_turn.companion_id = returned.companion_id
     AND run_turn.id = returned.run_id
    JOIN public.companion_transcript_entries main_entry
      ON main_entry.org_id = returned.org_id
     AND main_entry.companion_id = returned.companion_id
     AND main_entry.event_id = returned.main_entry_event_id
    WHERE returned.org_id = p_org_id
      AND returned.companion_id = p_companion_id
      AND returned.mode = 'notify'
      AND returned.main_entry_event_id = ANY(COALESCE(p_event_ids, ARRAY[]::text[]))
      AND COALESCE(run_turn.routine_snapshot_id, run_turn.routine_id) IS NOT NULL
      AND run_turn.routine_name IS NOT NULL

    UNION ALL

    SELECT run_turn.id,
      COALESCE(run_turn.routine_snapshot_id, run_turn.routine_id),
      run_turn.routine_name,
      legacy_surface.event_id,
      legacy_surface.ordinal
    FROM public.companion_turns run_turn
    JOIN LATERAL (
      SELECT entry.event_id, entry.ordinal
      FROM public.companion_transcript_entries entry
      WHERE entry.org_id = run_turn.org_id
        AND entry.companion_id = run_turn.companion_id
        AND entry.turn_id = run_turn.id
        AND entry.role = 'assistant'
      ORDER BY entry.ordinal DESC, entry.event_id DESC
      LIMIT 1
    ) legacy_surface ON true
    WHERE run_turn.org_id = p_org_id
      AND run_turn.companion_id = p_companion_id
      AND legacy_surface.event_id = ANY(COALESCE(p_event_ids, ARRAY[]::text[]))
      AND run_turn.status = 'succeeded'
      AND COALESCE(run_turn.routine_snapshot_id, run_turn.routine_id) IS NOT NULL
      AND run_turn.routine_name IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.companion_routine_returns returned
        WHERE returned.org_id = run_turn.org_id
          AND returned.companion_id = run_turn.companion_id
          AND returned.run_id = run_turn.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.companion_routine_run_entries private_entry
        WHERE private_entry.org_id = run_turn.org_id
          AND private_entry.companion_id = run_turn.companion_id
          AND private_entry.run_id = run_turn.id
      )
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'run_id', notify_returns.run_id,
    'routine_id', notify_returns.routine_id,
    'routine_name', notify_returns.routine_name,
    'main_entry_event_id', notify_returns.main_entry_event_id
  ) ORDER BY notify_returns.ordinal, notify_returns.run_id), '[]'::jsonb)
  FROM notify_returns
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_thread_metadata(
  p_org_id uuid,
  p_companion_id uuid,
  p_mark_read boolean
)
RETURNS TABLE(
  access_role text,
  active_turn jsonb,
  queued_count integer,
  interrupted_turn jsonb,
  last_message_at timestamp with time zone,
  previous_last_read_ordinal integer,
  projection_sequence bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_access text;
  v_previous integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.companions companion
    WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  ) THEN
    RETURN;
  END IF;
  v_access := public.companion_api_require_access(p_org_id, p_companion_id, 'read');

  IF p_mark_read THEN
    SELECT marked.previous_last_read_ordinal
    INTO v_previous
    FROM public.companion_api_mark_thread_read(p_org_id, p_companion_id) marked;
  ELSE
    SELECT member_state.last_read_ordinal
    INTO v_previous
    FROM public.companion_member_state member_state
    WHERE member_state.org_id = p_org_id
      AND member_state.companion_id = p_companion_id
      AND member_state.user_id = public.companion_api_actor(p_org_id);
  END IF;

  RETURN QUERY
  SELECT v_access,
    (
      SELECT public.companion_api_turn_json(active.org_id, active.companion_id, active.id)
      FROM public.companion_turns active
      WHERE active.org_id = p_org_id AND active.companion_id = p_companion_id
        AND active.routine_snapshot_id IS NULL
        AND active.status IN ('starting', 'dispatching', 'running', 'needs_input')
      ORDER BY active.queue_sequence, active.id LIMIT 1
    ),
    (SELECT count(*)::integer FROM public.companion_turns queued
      WHERE queued.org_id = p_org_id AND queued.companion_id = p_companion_id
        AND queued.routine_snapshot_id IS NULL AND queued.status = 'queued'),
    (
      SELECT public.companion_api_turn_json(
        interrupted.org_id, interrupted.companion_id, interrupted.id
      )
      FROM public.companion_turns interrupted
      WHERE interrupted.org_id = p_org_id AND interrupted.companion_id = p_companion_id
        AND interrupted.routine_snapshot_id IS NULL
        AND interrupted.status = 'interrupted'
        AND interrupted.resolution IS NULL
      ORDER BY interrupted.queue_sequence, interrupted.id LIMIT 1
    ),
    (
      SELECT thread.last_message_at
      FROM public.companion_threads thread
      WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
    ),
    v_previous,
    COALESCE((
      SELECT thread.projection_sequence
      FROM public.companion_threads thread
      WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
    ), 0::bigint);
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_read_thread_window(
  p_org_id uuid,
  p_companion_id uuid,
  p_before_ordinal integer,
  p_limit integer,
  p_mark_read boolean
)
RETURNS TABLE(
  access_role text,
  entries jsonb,
  active_turn jsonb,
  queued_count integer,
  interrupted_turn jsonb,
  last_message_at timestamp with time zone,
  previous_last_read_ordinal integer,
  older_before_ordinal integer,
  sync_sequence bigint,
  routine_notify_returns jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR (p_before_ordinal IS NOT NULL AND p_before_ordinal < 0)
     OR p_mark_read IS NULL THEN
    RAISE EXCEPTION 'invalid Companion thread window' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH metadata AS MATERIALIZED (
    SELECT * FROM public.companion_api_thread_metadata(
      p_org_id, p_companion_id, p_mark_read
    )
  ), snapshot AS MATERIALIZED (
    -- This table read belongs to the same outer statement snapshot as `candidates`. Reading the
    -- sequence from the nested PL/pgSQL metadata function could observe a concurrent commit that
    -- the outer entry scan could not yet see, advancing the cursor past an undelivered entry. A
    -- brand-new Companion has no thread row until its first accepted message, so its sequence is 0.
    SELECT COALESCE(thread.projection_sequence, 0::bigint) AS projection_sequence
    FROM public.companions companion
    LEFT JOIN public.companion_threads thread
      ON thread.org_id = companion.org_id AND thread.companion_id = companion.id
    WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  ), candidates AS MATERIALIZED (
    SELECT entry.*,
      public.companion_api_thread_entry_json(entry) AS value,
      row_number() OVER (ORDER BY entry.ordinal DESC, entry.event_id DESC) AS page_row
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id
      AND entry.companion_id = p_companion_id
      AND (p_before_ordinal IS NULL OR entry.ordinal < p_before_ordinal)
      AND public.companion_api_thread_entry_visible(entry)
    ORDER BY entry.ordinal DESC, entry.event_id DESC
    LIMIT p_limit
  ), sized AS MATERIALIZED (
    SELECT candidates.*,
      sum(octet_length(candidates.value::text)) OVER (
        ORDER BY candidates.ordinal DESC, candidates.event_id DESC
      ) AS cumulative_bytes
    FROM candidates
  ), selected AS MATERIALIZED (
    SELECT * FROM sized
    WHERE sized.page_row = 1 OR sized.cumulative_bytes <= 1048576
  ), selected_ids AS (
    SELECT COALESCE(array_agg(selected.event_id), ARRAY[]::text[]) AS ids FROM selected
  )
  SELECT metadata.access_role,
    COALESCE(jsonb_agg(selected.value ORDER BY selected.ordinal, selected.event_id)
      FILTER (WHERE selected.event_id IS NOT NULL), '[]'::jsonb),
    metadata.active_turn,
    metadata.queued_count,
    metadata.interrupted_turn,
    metadata.last_message_at,
    metadata.previous_last_read_ordinal,
    CASE WHEN EXISTS (
      SELECT 1 FROM public.companion_transcript_entries older
      WHERE older.org_id = p_org_id
        AND older.companion_id = p_companion_id
        AND older.ordinal < (SELECT min(selected.ordinal) FROM selected)
        AND public.companion_api_thread_entry_visible(older)
    ) THEN (SELECT min(selected.ordinal) FROM selected) ELSE NULL END,
    snapshot.projection_sequence,
    public.companion_api_routine_notify_returns_window(
      p_org_id, p_companion_id, selected_ids.ids
    )
  FROM metadata
  CROSS JOIN snapshot
  CROSS JOIN selected_ids
  LEFT JOIN selected ON true
  GROUP BY metadata.access_role, metadata.active_turn, metadata.queued_count,
    metadata.interrupted_turn, metadata.last_message_at,
    metadata.previous_last_read_ordinal, snapshot.projection_sequence, selected_ids.ids;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_read_thread_projection_sequence(
  p_org_id uuid,
  p_companion_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT COALESCE(thread.projection_sequence, 0::bigint)
  FROM public.companions companion
  LEFT JOIN public.companion_threads thread
    ON thread.org_id = companion.org_id AND thread.companion_id = companion.id
  WHERE companion.org_id = p_org_id
    AND companion.id = p_companion_id
    AND public.companion_api_require_access(p_org_id, p_companion_id, 'read') IS NOT NULL
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_read_thread_changes(
  p_org_id uuid,
  p_companion_id uuid,
  p_after_sequence bigint,
  p_limit integer
)
RETURNS TABLE(
  access_role text,
  changed_entries jsonb,
  deleted_event_ids jsonb,
  active_turn jsonb,
  queued_count integer,
  interrupted_turn jsonb,
  last_message_at timestamp with time zone,
  last_read_ordinal integer,
  next_sequence bigint,
  has_more boolean,
  routine_notify_returns jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF p_after_sequence IS NULL OR p_after_sequence < 0
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid Companion thread change cursor' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH metadata AS MATERIALIZED (
    SELECT * FROM public.companion_api_thread_metadata(
      p_org_id, p_companion_id, false
    )
  ), snapshot AS MATERIALIZED (
    SELECT COALESCE(thread.projection_sequence, 0::bigint) AS projection_sequence
    FROM public.companions companion
    LEFT JOIN public.companion_threads thread
      ON thread.org_id = companion.org_id AND thread.companion_id = companion.id
    WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  ), page AS MATERIALIZED (
    SELECT entry AS transcript_entry,
      entry.event_id,
      entry.ordinal,
      entry.projection_sequence,
      public.companion_api_thread_entry_visible(entry) AS visible
    FROM public.companion_transcript_entries entry
    CROSS JOIN snapshot
    WHERE entry.org_id = p_org_id
      AND entry.companion_id = p_companion_id
      AND entry.projection_sequence > p_after_sequence
      AND entry.projection_sequence <= snapshot.projection_sequence
    ORDER BY entry.projection_sequence, entry.event_id
    LIMIT p_limit
  ), page_state AS MATERIALIZED (
    SELECT max(page.projection_sequence) AS page_sequence,
      EXISTS (
        SELECT 1
        FROM public.companion_transcript_entries remaining
        CROSS JOIN snapshot
        WHERE remaining.org_id = p_org_id
          AND remaining.companion_id = p_companion_id
          AND remaining.projection_sequence > COALESCE(
            (SELECT max(page.projection_sequence) FROM page), p_after_sequence
          )
          AND remaining.projection_sequence <= snapshot.projection_sequence
      ) AS more
    FROM page
  ), visible_ids AS (
    SELECT COALESCE(array_agg(page.event_id), ARRAY[]::text[]) AS ids
    FROM page WHERE page.visible
  )
  SELECT metadata.access_role,
    COALESCE(jsonb_agg(public.companion_api_thread_entry_json(page.transcript_entry)
      ORDER BY page.ordinal, page.event_id) FILTER (WHERE page.visible), '[]'::jsonb),
    COALESCE(jsonb_agg(to_jsonb(page.event_id) ORDER BY page.projection_sequence, page.event_id)
      FILTER (WHERE NOT page.visible), '[]'::jsonb),
    metadata.active_turn,
    metadata.queued_count,
    metadata.interrupted_turn,
    metadata.last_message_at,
    metadata.previous_last_read_ordinal,
    CASE WHEN page_state.more THEN page_state.page_sequence ELSE snapshot.projection_sequence END,
    page_state.more,
    public.companion_api_routine_notify_returns_window(
      p_org_id, p_companion_id, visible_ids.ids
    )
  FROM metadata
  CROSS JOIN snapshot
  CROSS JOIN page_state
  CROSS JOIN visible_ids
  LEFT JOIN page ON true
  GROUP BY metadata.access_role, metadata.active_turn, metadata.queued_count,
    metadata.interrupted_turn, metadata.last_message_at,
    metadata.previous_last_read_ordinal, snapshot.projection_sequence,
    page_state.page_sequence, page_state.more, visible_ids.ids;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_thread_entry_visible(public.companion_transcript_entries) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_thread_entry_json(public.companion_transcript_entries) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_routine_notify_returns_window(uuid,uuid,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_thread_metadata(uuid,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_read_thread_window(uuid,uuid,integer,integer,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_read_thread_projection_sequence(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_read_thread_changes(uuid,uuid,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

DO $companion_incremental_thread_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure('public.companion_api_read_thread(uuid,uuid)');
  v_grantee oid;
  v_role name;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT acl.grantee
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
    ) acl
    WHERE source_proc.oid = v_source
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> source_proc.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid = v_grantee;
    IF v_role IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.companion_api_read_thread_window(uuid,uuid,integer,integer,boolean) TO %I',
        v_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.companion_api_read_thread_projection_sequence(uuid,uuid) TO %I',
        v_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.companion_api_read_thread_changes(uuid,uuid,bigint,integer) TO %I',
        v_role
      );
    END IF;
  END LOOP;
END
$companion_incremental_thread_acl$;
