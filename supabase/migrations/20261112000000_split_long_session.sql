-- A long session can be saved as what you actually did: a list of tasks, each with its own minutes.
-- p_parts: [{ "topicId": uuid } or { "title": text }, "minutes": int]. A part for the session's own topic sets
-- that session's time; every other part is saved as its own finished session in the same room (a new title
-- becomes a new topic there). Together they can't add up to more than the timer measured.
create or replace function finish_session_split(p_session uuid, p_parts jsonb, p_complete boolean default false, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := me(); s study_sessions; v_now bigint := now_ms(); v_measured bigint; part jsonb; t topics;
  v_topic uuid; v_minutes integer; v_own integer := 0; v_total bigint := 0; v_seen uuid[] := '{}'; v_status text; v_rev boolean;
begin
  s := own_session(p_session, v_me);
  -- Retrying after it was saved adds nothing.
  if s.state not in ('running', 'paused') then return finish_session(s.id, p_complete, true, null, p_note); end if;
  if jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0 then perform app_error('P0400', 'Add at least one task.'); end if;
  if jsonb_array_length(p_parts) > 12 then perform app_error('P0400', 'Use at most 12 tasks.'); end if;
  v_measured := session_focused_ms(s.id, v_now);

  for part in select * from jsonb_array_elements(p_parts) loop
    v_minutes := (part->>'minutes')::integer;
    if v_minutes is null or v_minutes < 0 or v_minutes > 1440 then perform app_error('P0400', 'Use between 0 and 1440 minutes for each task.'); end if;
    v_total := v_total + v_minutes * 60000;
  end loop;
  if v_total > v_measured + 60000 then
    perform app_error('P0400', 'Those tasks add up to more time than the timer measured.');
  end if;

  for part in select * from jsonb_array_elements(p_parts) loop
    v_minutes := (part->>'minutes')::integer;
    if part ? 'topicId' then
      t := require_own_topic((part->>'topicId')::uuid, v_me);
      if t.room_id <> s.room_id then perform app_error('P0400', 'Pick tasks from this room.'); end if;
      if t.status <> 'active' then perform app_error('P0400', 'That topic is archived.'); end if;
      v_topic := t.id;
    else
      if coalesce(btrim(part->>'title'), '') = '' then perform app_error('P0400', 'Give the new task a name.'); end if;
      if v_minutes = 0 then continue; end if;
      v_topic := create_topic(s.room_id, left(btrim(part->>'title'), 140));
    end if;
    if v_topic = any(v_seen) then perform app_error('P0400', 'Each task can only be listed once.'); end if;
    v_seen := v_seen || v_topic;

    if v_topic = s.topic_id then
      v_own := v_minutes;
    elsif v_minutes > 0 then
      perform ensure_progress(v_topic, v_me);
      select status into v_status from topic_progress where topic_id = v_topic and user_id = v_me;
      v_rev := v_status in ('revising', 'completed');
      if v_status = 'not_started' then
        update topic_progress set status = 'in_progress', updated_at = v_now where topic_id = v_topic and user_id = v_me;
      end if;
      insert into study_sessions (user_id, room_id, topic_id, state, started_at, ended_at, focused_ms, measured_ms, is_revision, local_date, created_at)
      values (v_me, s.room_id, v_topic, 'finished', s.started_at, v_now, v_minutes * 60000, v_minutes * 60000, v_rev, s.local_date, v_now);
    end if;
  end loop;

  -- The session's own topic only completes if it stayed on the list.
  return finish_session(s.id, p_complete and s.topic_id = any(v_seen), false, v_own, p_note)
    || jsonb_build_object('splitInto', cardinality(v_seen));
end $$;

revoke execute on function finish_session_split(uuid, jsonb, boolean, text) from public, anon;
grant execute on function finish_session_split(uuid, jsonb, boolean, text) to authenticated;
