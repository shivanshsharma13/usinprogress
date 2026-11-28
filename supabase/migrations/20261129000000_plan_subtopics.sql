-- Goals hold main topics, topics hold subtopics, and each subtopic is planned for a day with how long it takes.
-- The room shows what's planned by date ("Topic › Subtopic"); the day's plant, the forest and streaks count those.
--
-- * subtopics.planned_for: the day it's planned for (null = not planned yet); est_minutes: how long it takes.
-- * A topic without subtopics is still planned whole, by its task's date, as before.
-- * A topic's first subtopic takes over the topic's date, so what was planned stays planned.
-- * Existing dated topics with open subtopics hand their date to those subtopics.

alter table subtopics add column planned_for text check (planned_for ~ '^\d{4}-\d{2}-\d{2}$');
alter table subtopics add column est_minutes integer check (est_minutes between 1 and 1440);
create index subtopics_planned on subtopics(planned_for) where planned_for is not null;

-- The task's date (YYYY-MM-DD) from its goal's start and day, or null.
create or replace function goal_task_date(p_task uuid) returns text language sql stable security definer set search_path = public as $$
  select to_char(p.start_date::date + t.day, 'YYYY-MM-DD') from plan_tasks t join plans p on p.id = t.plan_id where t.id = p_task and t.day is not null
$$;

-- Moves a dated topic's date onto its open subtopics and clears the topic's own (it stays in history).
create or replace function hand_date_to_parts(p_topic uuid) returns void language plpgsql security definer set search_path = public as $$
declare t plan_tasks; v_date text;
begin
  select * into t from plan_tasks where topic_id = p_topic and status = 'active';
  if t.id is null or t.day is null then return; end if;
  if not exists (select 1 from subtopics where topic_id = p_topic and done_at is null) then return; end if;
  v_date := goal_task_date(t.id);
  update subtopics set planned_for = v_date, updated_at = now_ms() where topic_id = p_topic and done_at is null and planned_for is null;
  update plan_tasks set planned_day = coalesce(planned_day, day), day = null, updated_at = now_ms() where id = t.id;
end $$;

create or replace function check_plan_fields(p_date text, p_est integer) returns void language plpgsql immutable as $$
begin
  if p_date is not null and p_date !~ '^\d{4}-\d{2}-\d{2}$' then perform app_error('P0400', 'That date isn''t valid.'); end if;
  if p_est is not null and p_est not between 1 and 1440 then perform app_error('P0400', 'Use between 1 and 1440 minutes.'); end if;
end $$;

-- Patch keys: title, done, date (YYYY-MM-DD, or null for not planned) and estMinutes (or null).
create or replace function update_subtopic(p_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s subtopics; v_topic text;
begin
  s := own_subtopic(p_id, v_me);
  if p_patch ? 'title' and coalesce(char_length(btrim(p_patch->>'title')), 0) not between 1 and 140 then
    perform app_error('P0400', 'Give the subtopic a name (up to 140 characters).');
  end if;
  perform check_plan_fields(p_patch->>'date', (p_patch->>'estMinutes')::integer);
  update subtopics set
    title = case when p_patch ? 'title' then btrim(p_patch->>'title') else title end,
    done_at = case when p_patch ? 'done' then case when (p_patch->>'done')::boolean then coalesce(done_at, now_ms()) end else done_at end,
    planned_for = case when p_patch ? 'date' then p_patch->>'date' else planned_for end,
    est_minutes = case when p_patch ? 'estMinutes' then (p_patch->>'estMinutes')::integer else est_minutes end,
    updated_at = now_ms()
  where id = s.id;
  if p_patch ? 'done' then v_topic := sync_topic_parts(s.topic_id, v_me, 'undo'); end if;
  return jsonb_build_object('topic', v_topic);
end $$;

drop function if exists add_subtopic(uuid, text);
create function add_subtopic(p_topic uuid, p_title text, p_date text default null, p_est integer default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); t topics; v_id uuid; v_now bigint := now_ms();
begin
  t := require_own_topic(p_topic, v_me);
  if t.status <> 'active' then perform app_error('P0400', 'This topic is archived.'); end if;
  if coalesce(char_length(btrim(p_title)), 0) not between 1 and 140 then perform app_error('P0400', 'Give the subtopic a name (up to 140 characters).'); end if;
  perform check_plan_fields(p_date, p_est);
  if (select count(*) from subtopics where topic_id = p_topic) >= 100 then perform app_error('P0400', 'A topic can have up to 100 subtopics.'); end if;
  insert into subtopics (topic_id, title, position, planned_for, est_minutes, created_at, updated_at)
  values (p_topic, btrim(p_title), coalesce((select max(position) from subtopics where topic_id = p_topic), 0) + 1, p_date, p_est, v_now, v_now)
  returning id into v_id;
  perform topic_event(p_topic, v_me, 'subtopic_added', jsonb_build_object('title', btrim(p_title)));
  -- A new part on a finished topic: you're going over it again, so it's open for revision.
  perform sync_topic_parts(p_topic, v_me, 'revise');
  -- The first part of a topic planned for a day is what's planned for that day now (unless you gave it a day).
  if (select count(*) from subtopics where topic_id = p_topic) = 1 then perform hand_date_to_parts(p_topic); end if;
  return v_id;
end $$;

create or replace function topic_subtopics(p_topic uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'topicId', s.topic_id, 'title', s.title, 'doneAt', s.done_at, 'date', s.planned_for,
           'estMinutes', s.est_minutes, 'focusedMs', coalesce(x.ms, 0), 'sessions', coalesce(x.n, 0)) order by s.position), '[]')
    from subtopics s
    left join (select subtopic_id, sum(focused_ms)::bigint as ms, count(*) as n from study_sessions
                where topic_id = p_topic and state = 'finished' and subtopic_id is not null group by subtopic_id) x on x.subtopic_id = s.id
   where s.topic_id = p_topic and is_room_member(topic_room(p_topic), auth.uid())
$$;

-- Subtopics (of these topics) their owner studied or ticked today, so they show under Today wherever they were planned.
create or replace function active_parts_today(p_topics uuid[]) returns setof uuid
language sql stable security definer set search_path = public as $$
  select p.id from subtopics p join topics t on t.id = p.topic_id
   where t.id = any(p_topics) and is_room_member(t.room_id)
     and ((p.done_at is not null and local_date(t.created_by, p.done_at) = local_date(t.created_by, now_ms()))
       or exists (select 1 from study_sessions s where s.subtopic_id = p.id and s.user_id = t.created_by and s.state <> 'discarded'
                   and s.local_date = local_date(t.created_by, now_ms())))
$$;

-- Everything planned for a day: subtopics by their day, topics without subtopics by their task's day (and, for past
-- days, the day they were first planned for). done_on is the day it was finished.
create or replace function planned_items() returns table (owner_id uuid, room_id uuid, on_date date, done_on date)
language sql stable security definer set search_path = public as $$
  select p.owner_id, p.room_id, p.start_date::date + dd.d, c.local_date::date
    from plans p
    join plan_tasks t on t.plan_id = p.id and t.status = 'active'
    cross join lateral (select t.day as d
                        union select t.planned_day where p.start_date::date + t.planned_day < today_for(p.owner_id)::date) dd
    left join topic_completions c on c.topic_id = t.topic_id and c.kind = 'first' and c.revoked_at is null
   where dd.d is not null and p.room_id is not null
     and not exists (select 1 from subtopics s where s.topic_id = t.topic_id)
  union all
  select tp.created_by, tp.room_id, s.planned_for::date, local_date(tp.created_by, s.done_at)::date
    from subtopics s join topics tp on tp.id = s.topic_id
   where s.planned_for is not null and tp.status = 'active'
$$;

-- A day counts (a tree in the forest, a streak day) when everything planned for it was finished by then.
create or replace function room_forest(p_room uuid) returns table (user_id uuid, full_days integer)
language sql stable security definer set search_path = public as $$
  select owner_id, (count(*) filter (where is_full))::integer
    from (select owner_id, on_date, bool_and(done_on is not null and done_on <= on_date) as is_full
            from planned_items() where room_id = p_room and on_date <= today_for(owner_id)::date
           group by owner_id, on_date) d
   where is_room_member(p_room, auth.uid())
   group by owner_id
$$;

create or replace function full_days_between(p_user uuid, p_viewer uuid, p_from date, p_to date) returns integer
language sql stable security definer set search_path = public as $$
  select (count(*) filter (where is_full))::integer
    from (select on_date, bool_and(done_on is not null and done_on <= on_date) as is_full
            from planned_items()
           where owner_id = p_user and is_room_member(room_id, p_viewer)
             and on_date between p_from and p_to and on_date <= today_for(p_user)::date
           group by on_date) d
$$;

-- Ticking the last thing planned for today by way of a subtopic also tells your friend the day is done.
create or replace function note_part_day_finished() returns trigger language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_today date;
begin
  select created_by into v_user from topics where id = new.topic_id;
  v_today := today_for(v_user)::date;
  if new.planned_for::date = v_today and full_days_between(v_user, v_user, v_today, v_today) = 1
     and not exists (select 1 from activities where actor_id = v_user and type = 'day_finished' and created_at > now_ms() - 20 * 3600000
                     and local_date(v_user, created_at) = v_today::text) then
    perform record_activity(v_user, 'day_finished');
  end if;
  return null;
exception when others then
  return null; -- a notification problem must never stop the action itself
end $$;
create trigger note_part_day_finished after update of done_at on subtopics
  for each row when (old.done_at is null and new.done_at is not null and new.planned_for is not null) execute function note_part_day_finished();

-- What's planned now stays planned: dated topics with open parts pass their date to those parts.
do $$ declare r record; begin
  for r in select t.topic_id from plan_tasks t where t.status = 'active' and t.day is not null and t.topic_id is not null
             and exists (select 1 from subtopics s where s.topic_id = t.topic_id and s.done_at is null) loop
    perform hand_date_to_parts(r.topic_id);
  end loop;
end $$;

revoke execute on function goal_task_date(uuid), hand_date_to_parts(uuid), planned_items(), note_part_day_finished() from public, anon, authenticated;
revoke execute on function check_plan_fields(text, integer) from public, anon, authenticated;
revoke execute on function add_subtopic(uuid, text, text, integer), active_parts_today(uuid[]) from public, anon;
grant execute on function add_subtopic(uuid, text, text, integer), active_parts_today(uuid[]) to authenticated;
