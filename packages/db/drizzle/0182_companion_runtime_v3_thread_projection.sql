-- A Runtime v3 Turn is projected onto its durable user transcript entry by the API layer. Advance
-- that entry's existing thread-change sequence whenever the Turn leaves one visible state for
-- another, so incremental clients replace their cached `queued` bit instead of retaining it after
-- the assistant reply arrives.
CREATE TRIGGER companion_v3_turns_touch_thread_update
  AFTER UPDATE OF state ON public.companion_v3_turns
  FOR EACH ROW
  WHEN (NEW.lane = 'main' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION public.companion_thread_touch_turn_entry();
--> statement-breakpoint

-- Repair clients that cached a queued v3 entry before this trigger existed. The established entry
-- update trigger allocates a fresh per-thread projection sequence without changing transcript
-- content; the next ordinary delta read then overlays the current v3 Turn state.
UPDATE public.companion_transcript_entries entry
SET projection_sequence = entry.projection_sequence
FROM public.companion_v3_turns turn_row
WHERE turn_row.org_id = entry.org_id
  AND turn_row.companion_id = entry.companion_id
  AND turn_row.message_event_id = entry.event_id
  AND turn_row.lane = 'main'
  AND turn_row.state <> 'queued';
