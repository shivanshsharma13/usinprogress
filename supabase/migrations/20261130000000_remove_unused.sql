-- Remove what the app no longer uses, now that goals plan subtopics by day and the room shows them:
-- * calendar to-dos (tasks, task_notes, task_events, and study_sessions.task_id): the Calendar page is gone;
-- * managing sprints by hand, adding plan tasks by day number, and reordering topics: no screen does these.
-- Sprints themselves stay: goals still keep them in step underneath (the forest, streaks and leaving a room use them).

CREATE OR REPLACE FUNCTION public.active_session_json(p_session uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object('id', s.id, 'roomId', s.room_id, 'roomName', r.name, 'topicId', s.topic_id, 'topicTitle', t.title,
    'state', s.state, 'startedAt', s.started_at, 'pauses', session_pauses_json(s.id), 'targetMinutes', s.target_minutes,
    'remindAfterHour', s.remind_after_hour, 'isRevision', s.is_revision, 'togetherId', s.together_id,
    'subtopicId', s.subtopic_id, 'subtopicTitle', st.title)
    from study_sessions s join topics t on t.id = s.topic_id join rooms r on r.id = s.room_id
    left join subtopics st on st.id = s.subtopic_id
   where s.id = p_session
$function$;

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

CREATE OR REPLACE FUNCTION public.progress_stats(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); v_today text := today_for(p_user); v_week text; v_from text; v_today_ms bigint;
begin
  if p_user <> v_me and not is_friend(v_me, p_user) then perform app_error('P0404', 'That person is not in your friends list.'); end if;
  v_week := to_char(v_today::date - ((extract(isodow from v_today::date)::integer) - 1), 'YYYY-MM-DD');
  v_from := least(v_week, to_char(v_today::date - 6, 'YYYY-MM-DD'));
  v_today_ms := focused_today(p_user);
  return jsonb_build_object(
    'userId', p_user,
    'todayMs', v_today_ms,
    'weekMs', coalesce((select sum(focused_ms) from study_sessions where user_id = p_user and state = 'finished' and local_date >= v_week and local_date < v_today), 0) + v_today_ms,
    'completedTopics', (select count(*) from topic_completions where user_id = p_user and kind = 'first' and revoked_at is null),
    'sessions', (select count(*) from study_sessions where user_id = p_user and state = 'finished'),
    'daily', (select jsonb_agg(jsonb_build_object('date', d, 'ms',
                case when d = v_today then v_today_ms
                     else coalesce((select sum(focused_ms) from study_sessions where user_id = p_user and state = 'finished' and local_date = d), 0) end) order by d)
                from (select to_char(v_today::date - g, 'YYYY-MM-DD') d from generate_series(0, 6) g) days));
end $function$;

drop function if exists start_session(uuid, integer, boolean, uuid);
CREATE FUNCTION public.start_session(p_topic uuid, p_target integer DEFAULT NULL::integer, p_remind boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); t topics; r rooms; ex study_sessions; v_status text; v_now bigint := now_ms(); v_rev boolean; v_id uuid;
begin
  t := require_own_topic(p_topic, v_me);
  select * into r from rooms where id = t.room_id;
  if t.status <> 'active' then perform app_error('P0400', 'This topic is archived.'); end if;
  if r.status <> 'active' then perform app_error('P0400', 'This room is archived.'); end if;
  select * into ex from study_sessions where user_id = v_me and state in ('running', 'paused');
  if ex.id is not null then
    -- Retrying the same start just returns the running session.
    if ex.topic_id = p_topic then return active_session_json(ex.id); end if;
    perform app_error('P0409', 'You already have a session running. Finish it before starting another.', jsonb_build_object('code', 'SESSION_ACTIVE', 'session', active_session_json(ex.id))::text);
  end if;
  perform ensure_progress(p_topic, v_me);
  select status into v_status from topic_progress where topic_id = p_topic and user_id = v_me;
  v_rev := v_status = 'revising';
  if v_status = 'completed' then
    v_rev := true;
    update topic_progress set status = 'revising', updated_at = v_now where topic_id = p_topic and user_id = v_me;
    perform topic_event(p_topic, v_me, 'reopened_for_revision');
  elsif v_status = 'not_started' then
    update topic_progress set status = 'in_progress', updated_at = v_now where topic_id = p_topic and user_id = v_me;
  end if;
  insert into study_sessions (user_id, room_id, topic_id, state, started_at, target_minutes, remind_after_hour, is_revision, local_date, created_at)
  values (v_me, t.room_id, p_topic, 'running', v_now, coalesce(p_target, t.session_target_minutes), coalesce(p_remind, false), v_rev,
          local_date(v_me, v_now), v_now)
  returning id into v_id;
  perform touch_presence(v_me);
  return active_session_json(v_id);
end $function$;
-- Studying together starts your session the same way.
CREATE OR REPLACE FUNCTION public.join_study(p_friend uuid, p_topic uuid, p_target integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); f study_sessions; g together_sessions; v_now bigint := now_ms(); v_mine jsonb;
begin
  if not is_friend(v_me, p_friend) then perform app_error('P0404', 'That person is not in your friends list.'); end if;
  select * into f from study_sessions where user_id = p_friend and state in ('running', 'paused') for update;
  if f.id is null or not (select share_status from profiles where id = p_friend) then
    perform app_error('P0409', 'They''re not studying right now. Start on your own — they''ll see you studying.', '{"code": "FRIEND_NOT_STUDYING"}');
  end if;
  if f.together_id is not null and together_live(f.together_id) then
    select * into g from together_sessions where id = f.together_id;
    if v_me not in (g.host_id, g.guest_id) then perform app_error('P0409', 'They''re already studying with someone else.'); end if;
  end if;
  v_mine := start_session(p_topic, p_target, false);
  if g.id is null then
    insert into together_sessions (host_id, guest_id, started_at) values (p_friend, v_me, v_now) returning * into g;
    update study_sessions set together_id = g.id where id = f.id;
  end if;
  update study_sessions set together_id = g.id where id = (v_mine ->> 'id')::uuid;
  if g.break_started_at is not null then perform together_apply_break(g.id, true, v_now, g.break_started_at); end if;
  perform record_activity(v_me, 'together_joined', p_friend, null, g.id);
  perform touch_presence(p_friend);
  return active_session_json((v_mine ->> 'id')::uuid);
end $function$;

revoke execute on function start_session(uuid, integer, boolean) from public, anon;
grant execute on function start_session(uuid, integer, boolean) to authenticated;

drop function if exists add_sprint(uuid, integer);
drop function if exists resize_sprint(uuid, integer, integer);
drop function if exists remove_sprint(uuid, integer);
drop function if exists pull_sprint(uuid, integer, uuid);
drop function if exists set_sprint_completed(uuid, integer, boolean);
drop function if exists reorder_topics(uuid, uuid[]);
drop function if exists tasks_between(uuid, integer, integer);
drop function if exists create_task(jsonb);
drop function if exists update_task(uuid, jsonb);
drop function if exists task_refs(uuid, uuid, uuid);
drop function if exists add_plan_task(uuid, integer, text, integer);
drop function if exists visible_sprints(uuid);

alter table study_sessions drop column if exists task_id;
drop table if exists task_events;
drop table if exists task_notes;
drop table if exists tasks;
