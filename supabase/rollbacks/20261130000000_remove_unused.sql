-- Undo 20261130000000_remove_unused.sql: the calendar to-do tables come back empty (their rows are gone), and the
-- removed functions and study_sessions.task_id return.
create table tasks (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references profiles(id),
  title             text not null check (char_length(btrim(title)) between 1 and 140),
  description       text not null default '' check (char_length(description) <= 1000),
  date              text not null,
  start_time        text,
  duration_minutes  integer,
  room_id           uuid references rooms(id),
  topic_id          uuid references topics(id),
  shared            boolean not null default false,
  completed_at      bigint,
  completed_date    text,
  status            text not null default 'active' check (status in ('active', 'archived')),
  created_at        bigint not null,
  updated_at        bigint not null
);
create index tasks_owner_date on tasks(owner_id, date);

-- Private notes live apart from shared tasks so friends can never read them.
create table task_notes (
  task_id   uuid primary key references tasks(id),
  owner_id  uuid not null references profiles(id),
  note      text not null default '' check (char_length(note) <= 1000)
);

create table task_events (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id),
  user_id     uuid not null references profiles(id),
  type        text not null,
  detail      jsonb not null default '{}',
  created_at  bigint not null
);

alter table tasks enable row level security;
alter table task_notes enable row level security;
alter table task_events enable row level security;
create policy tasks_read on tasks for select to authenticated using (owner_id = auth.uid() or (shared and is_friend(owner_id, auth.uid())));
create policy task_notes_read_own on task_notes for select to authenticated using (owner_id = auth.uid());
create policy task_events_read_own on task_events for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on tasks, task_notes, task_events from anon, authenticated;

alter table study_sessions add column task_id uuid;

drop function if exists start_session(uuid, integer, boolean);
CREATE OR REPLACE FUNCTION public.start_session(p_topic uuid, p_target integer DEFAULT NULL::integer, p_remind boolean DEFAULT false, p_task uuid DEFAULT NULL::uuid)
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
  if p_task is not null and not exists (select 1 from tasks where id = p_task and owner_id = v_me) then
    perform app_error('P0404', 'That task could not be found.');
  end if;
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
  insert into study_sessions (user_id, room_id, topic_id, task_id, state, started_at, target_minutes, remind_after_hour, is_revision, local_date, created_at)
  values (v_me, t.room_id, p_topic, p_task, 'running', v_now, coalesce(p_target, t.session_target_minutes), coalesce(p_remind, false), v_rev,
          local_date(v_me, v_now), v_now)
  returning id into v_id;
  perform touch_presence(v_me);
  return active_session_json(v_id);
end $function$;

CREATE OR REPLACE FUNCTION public.active_session_json(p_session uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object('id', s.id, 'roomId', s.room_id, 'roomName', r.name, 'topicId', s.topic_id, 'topicTitle', t.title,
    'state', s.state, 'startedAt', s.started_at, 'pauses', session_pauses_json(s.id), 'targetMinutes', s.target_minutes,
    'remindAfterHour', s.remind_after_hour, 'isRevision', s.is_revision, 'taskId', s.task_id, 'togetherId', s.together_id,
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
    'completedTasks', (select count(*) from tasks where owner_id = p_user and completed_at is not null and status = 'active'),
    'sessions', (select count(*) from study_sessions where user_id = p_user and state = 'finished'),
    'daily', (select jsonb_agg(jsonb_build_object('date', d, 'ms',
                case when d = v_today then v_today_ms
                     else coalesce((select sum(focused_ms) from study_sessions where user_id = p_user and state = 'finished' and local_date = d), 0) end) order by d)
                from (select to_char(v_today::date - g, 'YYYY-MM-DD') d from generate_series(0, 6) g) days));
end $function$;

CREATE OR REPLACE FUNCTION public.add_sprint(p_plan uuid, p_days integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); p plans; v_n integer;
begin
  p := own_plan(p_plan, v_me);
  select coalesce(max(number), 0) + 1 into v_n from plan_sprints where plan_id = p_plan;
  insert into plan_sprints (plan_id, number, days) values (p_plan, v_n, coalesce(p_days, p.sprint_days));
  return v_n;
end $function$;

CREATE OR REPLACE FUNCTION public.resize_sprint(p_plan uuid, p_n integer, p_days integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); p plans; s record; v_delta integer;
begin
  p := own_plan(p_plan, v_me);
  s := sprint_span(p_plan, p_n);
  if to_char(p.start_date::date + s.last_day, 'YYYY-MM-DD') < today_for(v_me) then perform app_error('P0400', 'This sprint has already ended, so its length stays as it was.'); end if;
  v_delta := p_days - s.days;
  if v_delta = 0 then return; end if;
  if v_delta < 0 and tasks_between(p_plan, s.last_day + v_delta + 1, s.last_day) > 0 then
    perform app_error('P0400', format('Days %s–%s have tasks. Move them first, then shorten the sprint.', s.last_day + v_delta + 2, s.last_day + 1));
  end if;
  update plan_sprints set days = p_days where plan_id = p_plan and number = p_n;
  update plan_tasks set day = day + v_delta where plan_id = p_plan and day > s.last_day;
  update plan_tasks set planned_day = planned_day + v_delta where plan_id = p_plan and planned_day > s.last_day;
end $function$;

CREATE OR REPLACE FUNCTION public.remove_sprint(p_plan uuid, p_n integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); s record; v_count integer;
begin
  perform own_plan(p_plan, v_me);
  s := sprint_span(p_plan, p_n);
  select count(*) into v_count from plan_sprints where plan_id = p_plan;
  if v_count = 1 then perform app_error('P0400', 'A goal needs at least one sprint.'); end if;
  if p_n <> v_count then perform app_error('P0400', 'Only the last sprint can be removed.'); end if;
  if s.room_id is not null then perform app_error('P0400', 'Take this sprint out of its room first.'); end if;
  if tasks_between(p_plan, s.first_day, s.last_day) > 0 then perform app_error('P0400', 'This sprint has tasks. Move or remove them first.'); end if;
  delete from plan_sprints where plan_id = p_plan and number = p_n;
end $function$;

CREATE OR REPLACE FUNCTION public.pull_sprint(p_plan uuid, p_n integer, p_room uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); s record; r rooms; t record;
begin
  perform own_plan(p_plan, v_me);
  s := sprint_span(p_plan, p_n);
  select * into r from rooms where id = p_room;
  if r.id is null or not is_room_member(p_room, v_me) then perform app_error('P0404', 'That room could not be found.'); end if;
  if r.status <> 'active' then perform app_error('P0400', 'That room is archived.'); end if;
  if s.room_id is not null and s.room_id <> p_room then perform app_error('P0409', 'This sprint is already in another room. Take it out of that room first.'); end if;
  update plan_sprints set room_id = p_room, pulled_at = coalesce(pulled_at, now_ms()) where plan_id = p_plan and number = p_n;
  for t in select id from plan_tasks where plan_id = p_plan and status = 'active' and day between s.first_day and s.last_day order by day, position loop
    perform attach_task(t.id, v_me);
  end loop;
  perform touch_presence(v_me);
  return p_room;
end $function$;

CREATE OR REPLACE FUNCTION public.set_sprint_completed(p_plan uuid, p_n integer, p_completed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me();
begin
  perform own_plan(p_plan, v_me);
  perform sprint_span(p_plan, p_n);
  update plan_sprints set completed_at = case when p_completed then now_ms() end where plan_id = p_plan and number = p_n;
  perform touch_presence(v_me);
end $function$;

CREATE OR REPLACE FUNCTION public.reorder_topics(p_room uuid, p_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); v_slots double precision[]; i integer;
begin
  if not is_room_member(p_room, v_me) then perform app_error('P0404', 'That room could not be found.'); end if;
  select array_agg(position order by position) into v_slots from topics
   where room_id = p_room and created_by = v_me and status = 'active' and id = any(p_ids);
  if coalesce(array_length(v_slots, 1), 0) <> array_length(p_ids, 1) or (select count(distinct x) from unnest(p_ids) x) <> array_length(p_ids, 1) then
    perform app_error('P0400', 'The topic list changed. Please refresh and try again.', '{"code": "STALE_ORDER"}');
  end if;
  for i in 1 .. array_length(p_ids, 1) loop
    update topics set position = v_slots[i] where id = p_ids[i];
  end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.tasks_between(p_plan uuid, p_from integer, p_to integer)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*) from plan_tasks where plan_id = p_plan and status = 'active' and (day between p_from and p_to or planned_day between p_from and p_to)
$function$;

CREATE OR REPLACE FUNCTION public.create_task(p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); v_id uuid; v_now bigint := now_ms(); v_room uuid;
begin
  v_room := task_refs(v_me, (p->>'roomId')::uuid, (p->>'topicId')::uuid);
  insert into tasks (owner_id, title, description, date, start_time, duration_minutes, room_id, topic_id, shared, created_at, updated_at)
  values (v_me, btrim(p->>'title'), coalesce(p->>'description', ''), p->>'date', nullif(p->>'startTime', ''), (p->>'durationMinutes')::integer,
          v_room, (p->>'topicId')::uuid, coalesce((p->>'shared')::boolean, false), v_now, v_now)
  returning id into v_id;
  insert into task_notes (task_id, owner_id, note) values (v_id, v_me, coalesce(p->>'note', ''));
  insert into task_events (task_id, user_id, type, detail, created_at) values (v_id, v_me, 'created', jsonb_build_object('date', p->>'date'), v_now);
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.update_task(p_task uuid, p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); t tasks; v_now bigint := now_ms(); v_room uuid; v_topic uuid; v_done_at bigint; v_done_date text;
begin
  select * into t from tasks where id = p_task and owner_id = v_me;
  if t.id is null then perform app_error('P0404', 'That task could not be found.'); end if;
  v_room := case when p ? 'roomId' then (p->>'roomId')::uuid else t.room_id end;
  v_topic := case when p ? 'topicId' then (p->>'topicId')::uuid when p ? 'roomId' and v_room is distinct from t.room_id then null else t.topic_id end;
  v_room := task_refs(v_me, v_room, v_topic);
  v_done_at := t.completed_at; v_done_date := t.completed_date;
  if (p->>'completed')::boolean is true and t.completed_at is null then
    v_done_at := v_now; v_done_date := local_date(v_me, v_now);
    insert into task_events (task_id, user_id, type, created_at) values (p_task, v_me, 'completed', v_now);
  elsif (p->>'completed')::boolean is false and t.completed_at is not null then
    v_done_at := null; v_done_date := null;
    insert into task_events (task_id, user_id, type, created_at) values (p_task, v_me, 'uncompleted', v_now);
  end if;
  if p ? 'date' and p->>'date' <> t.date then
    insert into task_events (task_id, user_id, type, detail, created_at) values (p_task, v_me, 'moved', jsonb_build_object('from', t.date, 'to', p->>'date'), v_now);
  end if;
  update tasks set title = coalesce(btrim(p->>'title'), title), description = coalesce(p->>'description', description), date = coalesce(p->>'date', date),
         start_time = case when p ? 'startTime' then nullif(p->>'startTime', '') else start_time end,
         duration_minutes = case when p ? 'durationMinutes' then (p->>'durationMinutes')::integer else duration_minutes end,
         room_id = v_room, topic_id = v_topic, shared = coalesce((p->>'shared')::boolean, shared),
         completed_at = v_done_at, completed_date = v_done_date, status = coalesce(p->>'status', status), updated_at = v_now
   where id = p_task;
  if p ? 'note' then update task_notes set note = p->>'note' where task_id = p_task; end if;
end $function$;

CREATE OR REPLACE FUNCTION public.task_refs(p_user uuid, p_room uuid, p_topic uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_room uuid := p_room; t topics;
begin
  if p_topic is not null then
    select * into t from topics where id = p_topic;
    if t.id is null then perform app_error('P0400', 'That topic could not be found.'); end if;
    if t.created_by <> p_user then perform app_error('P0400', 'You can only plan your own topics.'); end if;
    if v_room is not null and v_room <> t.room_id then perform app_error('P0400', 'That topic is not in the selected room.'); end if;
    v_room := t.room_id;
  end if;
  if v_room is not null and not is_room_member(v_room, p_user) then perform app_error('P0400', 'That room could not be found.'); end if;
  return v_room;
end $function$;

CREATE OR REPLACE FUNCTION public.add_plan_task(p_plan uuid, p_day integer, p_title text, p_est integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_me uuid := me(); v_id uuid; v_now bigint := now_ms();
begin
  perform own_plan(p_plan, v_me);
  perform check_plan_day(p_plan, p_day);
  insert into plan_tasks (plan_id, day, planned_day, title, est_minutes, position, created_at, updated_at)
  values (p_plan, p_day, p_day, btrim(p_title), p_est, next_task_position(p_plan, p_day), v_now, v_now) returning id into v_id;
  perform attach_task(v_id, v_me);
  perform touch_presence(v_me);
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.visible_sprints(p_room uuid DEFAULT NULL::uuid)
 RETURNS TABLE(plan_id uuid, plan_title text, owner_id uuid, start_date text, number integer, days integer, first_day integer, last_day integer, room_id uuid, room_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id, p.title, p.owner_id, p.start_date, s.number, s.days, s.first_day, s.last_day, s.room_id, r.name
    from plans p cross join lateral plan_spans(p.id) s join rooms r on r.id = s.room_id
   where p.status = 'active' and s.completed_at is null and s.room_id is not null
     and is_room_member(s.room_id, auth.uid()) and (p_room is null or s.room_id = p_room)
   order by p.created_at, s.number
$function$;

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
  v_mine := start_session(p_topic, p_target, false, null);
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

revoke execute on function start_session(uuid, integer, boolean, uuid) from public, anon;
grant execute on function start_session(uuid, integer, boolean, uuid) to authenticated;
revoke execute on function add_sprint(uuid, integer) from public, anon;
grant execute on function add_sprint(uuid, integer) to authenticated;
revoke execute on function resize_sprint(uuid, integer, integer) from public, anon;
grant execute on function resize_sprint(uuid, integer, integer) to authenticated;
revoke execute on function remove_sprint(uuid, integer) from public, anon;
grant execute on function remove_sprint(uuid, integer) to authenticated;
revoke execute on function pull_sprint(uuid, integer, uuid) from public, anon;
grant execute on function pull_sprint(uuid, integer, uuid) to authenticated;
revoke execute on function set_sprint_completed(uuid, integer, boolean) from public, anon;
grant execute on function set_sprint_completed(uuid, integer, boolean) to authenticated;
revoke execute on function reorder_topics(uuid, uuid[]) from public, anon;
grant execute on function reorder_topics(uuid, uuid[]) to authenticated;
revoke execute on function tasks_between(uuid, integer, integer) from public, anon;
grant execute on function tasks_between(uuid, integer, integer) to authenticated;
revoke execute on function create_task(jsonb) from public, anon;
grant execute on function create_task(jsonb) to authenticated;
revoke execute on function update_task(uuid, jsonb) from public, anon;
grant execute on function update_task(uuid, jsonb) to authenticated;
revoke execute on function task_refs(uuid, uuid, uuid) from public, anon;
grant execute on function task_refs(uuid, uuid, uuid) to authenticated;
revoke execute on function add_plan_task(uuid, integer, text, integer) from public, anon;
grant execute on function add_plan_task(uuid, integer, text, integer) to authenticated;
revoke execute on function visible_sprints(uuid) from public, anon;
grant execute on function visible_sprints(uuid) to authenticated;
