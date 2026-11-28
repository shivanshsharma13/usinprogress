-- A topic with subtopics is complete exactly when all of them are done, and "today" covers what you did today.
--
-- * Ticking the last subtopic completes the topic; unticking one undoes that completion.
-- * Adding a subtopic to a finished topic reopens it for revision (its first completion date stays).
-- * Completing a topic any other way ticks its remaining subtopics.
-- * Finishing a timer on one subtopic with "Complete" ticks just that subtopic (and the topic if it was the last).
-- * active_today(): topics their owner studied, ticked a part of, or completed today, so today's list shows them.

-- Undo the latest completion of a topic (the same as "mark as not done").
create or replace function undo_completion_core(p_topic uuid, p_user uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_now bigint := now_ms(); v_last uuid;
begin
  select id into v_last from topic_completions where topic_id = p_topic and user_id = p_user and revoked_at is null order by completed_at desc limit 1;
  if v_last is null then return false; end if;
  update topic_completions set revoked_at = v_now where id = v_last;
  update topic_progress set completed_at = null, updated_at = v_now,
         status = case when exists (select 1 from topic_completions where topic_id = p_topic and user_id = p_user and revoked_at is null) then 'revising' else 'in_progress' end
   where topic_id = p_topic and user_id = p_user;
  perform topic_event(p_topic, p_user, 'completion_undone');
  return true;
end $$;

create or replace function complete_topic_core(p_topic uuid, p_user uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare t topics; v_status text; v_now bigint := now_ms(); v_kind text;
begin
  t := require_own_topic(p_topic, p_user);
  if t.status <> 'active' then perform app_error('P0400', 'This topic is archived.'); end if;
  perform ensure_progress(p_topic, p_user);
  select status into v_status from topic_progress where topic_id = p_topic and user_id = p_user for update;
  if v_status = 'completed' then return false; end if;
  v_kind := case when exists (select 1 from topic_completions where topic_id = p_topic and user_id = p_user and kind = 'first' and revoked_at is null)
                 then 'revision' else 'first' end;
  insert into topic_completions (topic_id, user_id, kind, completed_at, local_date) values (p_topic, p_user, v_kind, v_now, local_date(p_user, v_now));
  update topic_progress set status = 'completed', completed_at = v_now, updated_at = v_now where topic_id = p_topic and user_id = p_user;
  -- A complete topic has all its parts done.
  update subtopics set done_at = v_now, updated_at = v_now where topic_id = p_topic and done_at is null;
  perform topic_event(p_topic, p_user, case v_kind when 'first' then 'completed' else 'revision_completed' end);
  if v_kind = 'first' then perform record_activity(p_user, 'topic_completed', null, t.room_id, p_topic); end if;
  perform touch_presence(p_user);
  return true;
end $$;

-- After a part changes: all done → complete the topic; one open on a finished topic → undo or reopen.
create or replace function sync_topic_parts(p_topic uuid, p_user uuid, p_reopen text) returns text
language plpgsql security definer set search_path = public as $$
declare t topics; v_status text; v_total integer; v_open integer; v_now bigint := now_ms();
begin
  select * into t from topics where id = p_topic;
  if t.status <> 'active' then return null; end if;
  select count(*), count(*) filter (where done_at is null) into v_total, v_open from subtopics where topic_id = p_topic;
  perform ensure_progress(p_topic, p_user);
  select status into v_status from topic_progress where topic_id = p_topic and user_id = p_user;
  if v_total > 0 and v_open = 0 and v_status <> 'completed' then
    perform complete_topic_core(p_topic, p_user);
    return 'completed';
  elsif v_open > 0 and v_status = 'completed' then
    if p_reopen = 'undo' then
      perform undo_completion_core(p_topic, p_user);
      return 'undone';
    end if;
    update topic_progress set status = 'revising', updated_at = v_now where topic_id = p_topic and user_id = p_user;
    perform topic_event(p_topic, p_user, 'reopened_for_revision');
    return 'reopened';
  end if;
  return null;
end $$;

-- Now returns what happened to the topic: {"topic": "completed" | "undone" | null}.
drop function if exists update_subtopic(uuid, jsonb);
create function update_subtopic(p_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s subtopics; v_topic text;
begin
  s := own_subtopic(p_id, v_me);
  if p_patch ? 'title' and coalesce(char_length(btrim(p_patch->>'title')), 0) not between 1 and 140 then
    perform app_error('P0400', 'Give the subtopic a name (up to 140 characters).');
  end if;
  update subtopics set
    title = case when p_patch ? 'title' then btrim(p_patch->>'title') else title end,
    done_at = case when p_patch ? 'done' then case when (p_patch->>'done')::boolean then coalesce(done_at, now_ms()) end else done_at end,
    updated_at = now_ms()
  where id = s.id;
  if p_patch ? 'done' then v_topic := sync_topic_parts(s.topic_id, v_me, 'undo'); end if;
  return jsonb_build_object('topic', v_topic);
end $$;

create or replace function add_subtopic(p_topic uuid, p_title text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); t topics; v_id uuid; v_now bigint := now_ms();
begin
  t := require_own_topic(p_topic, v_me);
  if t.status <> 'active' then perform app_error('P0400', 'This topic is archived.'); end if;
  if coalesce(char_length(btrim(p_title)), 0) not between 1 and 140 then perform app_error('P0400', 'Give the subtopic a name (up to 140 characters).'); end if;
  if (select count(*) from subtopics where topic_id = p_topic) >= 100 then perform app_error('P0400', 'A topic can have up to 100 subtopics.'); end if;
  insert into subtopics (topic_id, title, position, created_at, updated_at)
  values (p_topic, btrim(p_title), coalesce((select max(position) from subtopics where topic_id = p_topic), 0) + 1, v_now, v_now)
  returning id into v_id;
  perform topic_event(p_topic, v_me, 'subtopic_added', jsonb_build_object('title', btrim(p_title)));
  -- A new part on a finished topic: you're going over it again, so it's open for revision.
  perform sync_topic_parts(p_topic, v_me, 'revise');
  return v_id;
end $$;

create or replace function delete_subtopic(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s subtopics;
begin
  s := own_subtopic(p_id, v_me);
  delete from subtopics where id = s.id;
  perform topic_event(s.topic_id, v_me, 'subtopic_removed', jsonb_build_object('title', s.title));
  perform sync_topic_parts(s.topic_id, v_me, 'undo');
end $$;

-- "Complete" on a timer that's on one part ticks that part; the topic completes when it was the last one open.
create or replace function finish_session(p_session uuid, p_complete boolean default false, p_confirm_long boolean default false,
                                          p_corrected integer default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s study_sessions; v_now bigint := now_ms(); v_measured bigint; v_focused bigint; v_done boolean := false; v_status text;
        v_part_only boolean := false;
begin
  s := own_session(p_session, v_me);
  if s.state in ('running', 'paused') then
    v_measured := session_focused_ms(s.id, v_now);
    if v_measured > 4 * 3600000 and not coalesce(p_confirm_long, false) and p_corrected is null then
      perform app_error('P0409', 'This session ran for a long time. Please confirm or correct it.', jsonb_build_object('code', 'LONG_SESSION', 'measuredMs', v_measured)::text);
    end if;
    v_focused := coalesce(p_corrected::bigint * 60000, v_measured);
    update session_pauses set resumed_at = v_now where session_id = s.id and resumed_at is null;
    update study_sessions set state = 'finished', ended_at = v_now, focused_ms = v_focused, measured_ms = v_measured, note = coalesce(p_note, note) where id = s.id;
    if v_focused <> v_measured then
      insert into session_corrections (session_id, user_id, old_ms, new_ms, reason, created_at) values (s.id, v_me, v_measured, v_focused, 'Corrected when finishing', v_now);
    end if;
    perform touch_presence(v_me);
  elsif s.state = 'discarded' then
    perform app_error('P0400', 'This session was discarded.', '{"code": "SESSION_ENDED"}');
  end if;
  if p_complete then
    v_part_only := s.subtopic_id is not null
      and exists (select 1 from subtopics where topic_id = s.topic_id and id <> s.subtopic_id and done_at is null);
    if v_part_only then
      update subtopics set done_at = coalesce(done_at, v_now), updated_at = v_now where id = s.subtopic_id;
    else
      v_done := complete_topic_core(s.topic_id, v_me);
    end if;
  end if;
  select status into v_status from topic_progress where topic_id = s.topic_id and user_id = v_me;
  return jsonb_build_object('session', session_record_json(s.id), 'completedTopic', v_done or v_status = 'completed', 'partDone', v_part_only,
    'nextTopic', case when p_complete and not v_part_only then next_topic(v_me, s.room_id, s.topic_id) end, 'roomId', s.room_id);
end $$;

-- Merging keeps the rule too.
CREATE OR REPLACE FUNCTION public.merge_topic(p_from uuid, p_into uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); f topics; i topics; v_now bigint := now_ms(); v_base double precision; v_sub uuid; v_first uuid;
begin
  if p_from = p_into then perform app_error('P0400', 'Pick a different topic to merge into.'); end if;
  f := require_own_topic(p_from, v_me);
  i := require_own_topic(p_into, v_me);
  if f.room_id <> i.room_id then perform app_error('P0400', 'Both topics need to be in the same room.'); end if;
  if f.status <> 'active' or i.status <> 'active' then perform app_error('P0400', 'Both topics need to be active.'); end if;
  if exists (select 1 from study_sessions where topic_id in (p_from, p_into) and state in ('running', 'paused')) then
    perform app_error('P0409', 'Finish your session first, then merge.');
  end if;

  v_base := coalesce((select max(position) from subtopics where topic_id = p_into), 0);
  if exists (select 1 from subtopics where topic_id = p_from) then
    update subtopics set topic_id = p_into, position = v_base + position, updated_at = v_now where topic_id = p_from;
  elsif lower(btrim(f.title)) <> lower(btrim(i.title)) then
    insert into subtopics (topic_id, title, done_at, position, created_at, updated_at)
    values (p_into, f.title,
            (select min(completed_at) from topic_completions where topic_id = p_from and user_id = v_me and revoked_at is null),
            v_base + 1, f.created_at, v_now)
    returning id into v_sub;
    update study_sessions set subtopic_id = v_sub where topic_id = p_from and subtopic_id is null;
  end if;
  update study_sessions set topic_id = p_into where topic_id = p_from;

  -- One first completion per person: when both were done, the later one counts as a revision.
  select id into v_first from topic_completions
   where topic_id in (p_from, p_into) and user_id = v_me and kind = 'first' and revoked_at is null
   order by completed_at desc limit 1;
  if (select count(*) from topic_completions where topic_id in (p_from, p_into) and user_id = v_me and kind = 'first' and revoked_at is null) = 2 then
    update topic_completions set kind = 'revision' where id = v_first;
  end if;
  update topic_completions set topic_id = p_into where topic_id = p_from;
  update topic_events set topic_id = p_into where topic_id = p_from;
  update tasks set topic_id = p_into where topic_id = p_from;

  perform ensure_progress(p_into, v_me);
  update topic_progress set
    status = case
      when status in ('not_started', 'in_progress')
       and exists (select 1 from topic_completions where topic_id = p_into and user_id = v_me and revoked_at is null) then 'completed'
      when status = 'not_started' and exists (select 1 from study_sessions where topic_id = p_into and user_id = v_me) then 'in_progress'
      else status end,
    completed_at = coalesce(completed_at, (select max(completed_at) from topic_completions where topic_id = p_into and user_id = v_me and revoked_at is null)),
    updated_at = v_now
   where topic_id = p_into and user_id = v_me;

  update plan_tasks set status = 'archived', updated_at = v_now where topic_id = p_from and status = 'active';
  update topics set status = 'archived', updated_at = v_now where id = p_from;
  perform topic_event(p_into, v_me, 'merged', jsonb_build_object('from', f.title));
  perform topic_event(p_from, v_me, 'archived', jsonb_build_object('mergedInto', i.title));
  -- Complete only while every part is done (a merged-in part may still be open).
  perform sync_topic_parts(p_into, v_me, 'revise');
  perform touch_presence(v_me);
end $function$;

-- Topics (of those given) that their owner studied, ticked a part of, or completed on their own today.
create or replace function active_today(p_topics uuid[]) returns setof uuid
language sql stable security definer set search_path = public as $$
  select t.id from topics t
   where t.id = any(p_topics) and is_room_member(t.room_id)
     and (exists (select 1 from study_sessions s where s.topic_id = t.id and s.user_id = t.created_by and s.state <> 'discarded'
                   and s.local_date = local_date(t.created_by, now_ms()))
       or exists (select 1 from topic_completions c where c.topic_id = t.id and c.user_id = t.created_by and c.revoked_at is null
                   and c.local_date = local_date(t.created_by, now_ms()))
       or exists (select 1 from subtopics p where p.topic_id = t.id and p.done_at is not null
                   and local_date(t.created_by, p.done_at) = local_date(t.created_by, now_ms())))
$$;

-- Finished topics that still have open parts: open them for revision (their completion date stays in history).
update topic_progress p set status = 'revising', updated_at = now_ms()
 where p.status = 'completed'
   and exists (select 1 from topics t where t.id = p.topic_id and t.created_by = p.user_id)
   and exists (select 1 from subtopics s where s.topic_id = p.topic_id and s.done_at is null);

revoke execute on function undo_completion_core(uuid, uuid), sync_topic_parts(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function update_subtopic(uuid, jsonb), active_today(uuid[]) from public, anon;
grant execute on function update_subtopic(uuid, jsonb), active_today(uuid[]) to authenticated;
