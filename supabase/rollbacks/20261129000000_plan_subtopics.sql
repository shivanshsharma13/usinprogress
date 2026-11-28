-- Undo 20261129000000_plan_subtopics.sql. Subtopics lose their days and times; topics that handed their date to
-- their subtopics stay undated (their planned day is kept in history). The forest and streaks count whole tasks again.
drop trigger if exists note_part_day_finished on subtopics;
drop function if exists note_part_day_finished();
drop function if exists active_parts_today(uuid[]);

CREATE OR REPLACE FUNCTION public.room_forest(p_room uuid)
 RETURNS TABLE(user_id uuid, full_days integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with spans as (
    select p.id as plan_id, p.owner_id, p.start_date::date as start_date, s.first_day, s.last_day, today_for(p.owner_id)::date as today
      from plans p cross join lateral plan_spans(p.id) s
     where s.room_id = p_room
  ), days as (
    select sp.plan_id, sp.owner_id, d, sp.start_date + d as on_date, sp.today
      from spans sp cross join generate_series(sp.first_day, sp.last_day) d
     where sp.start_date + d <= sp.today
  ), per_date as (
    select dy.owner_id, dy.on_date,
           count(t.id) as planned,
           count(t.id) filter (where c.local_date is not null and c.local_date::date <= dy.on_date) as done
      from days dy
      join plan_tasks t on t.plan_id = dy.plan_id and t.status = 'active'
                       and (t.day = dy.d or (t.planned_day = dy.d and dy.on_date < dy.today))
      left join topic_completions c on c.topic_id = t.topic_id and c.kind = 'first' and c.revoked_at is null
     group by dy.owner_id, dy.on_date
  )
  select owner_id, (count(*) filter (where done = planned))::integer
    from per_date
   where is_room_member(p_room, auth.uid())
   group by owner_id
$function$;

CREATE OR REPLACE FUNCTION public.full_days_between(p_user uuid, p_viewer uuid, p_from date, p_to date)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with spans as (
    select p.id as plan_id, p.start_date::date as start_date, s.first_day, s.last_day, today_for(p.owner_id)::date as today
      from plans p cross join lateral plan_spans(p.id) s
     where p.owner_id = p_user and s.room_id is not null and is_room_member(s.room_id, p_viewer)
  ), days as (
    select sp.plan_id, d, sp.start_date + d as on_date, sp.today
      from spans sp cross join generate_series(sp.first_day, sp.last_day) d
     where sp.start_date + d <= sp.today and sp.start_date + d between p_from and p_to
  ), per_date as (
    select dy.on_date, count(t.id) as planned,
           count(t.id) filter (where c.local_date is not null and c.local_date::date <= dy.on_date) as done
      from days dy
      join plan_tasks t on t.plan_id = dy.plan_id and t.status = 'active'
                       and (t.day = dy.d or (t.planned_day = dy.d and dy.on_date < dy.today))
      left join topic_completions c on c.topic_id = t.topic_id and c.kind = 'first' and c.revoked_at is null
     group by dy.on_date
  )
  select (count(*) filter (where done = planned))::integer from per_date
$function$;


drop function if exists planned_items();

create or replace function update_subtopic(p_id uuid, p_patch jsonb) returns jsonb
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

drop function if exists add_subtopic(uuid, text, text, integer);
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

create or replace function topic_subtopics(p_topic uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'topicId', s.topic_id, 'title', s.title, 'doneAt', s.done_at,
           'focusedMs', coalesce(x.ms, 0), 'sessions', coalesce(x.n, 0)) order by s.position), '[]')
    from subtopics s
    left join (select subtopic_id, sum(focused_ms)::bigint as ms, count(*) as n from study_sessions
                where topic_id = p_topic and state = 'finished' and subtopic_id is not null group by subtopic_id) x on x.subtopic_id = s.id
   where s.topic_id = p_topic and is_room_member(topic_room(p_topic), auth.uid())
$$;

drop function if exists check_plan_fields(text, integer);
drop function if exists hand_date_to_parts(uuid);
drop function if exists goal_task_date(uuid);
drop index if exists subtopics_planned;
alter table subtopics drop column if exists est_minutes;
alter table subtopics drop column if exists planned_for;

revoke execute on function add_subtopic(uuid, text), update_subtopic(uuid, jsonb) from public, anon;
grant execute on function add_subtopic(uuid, text), update_subtopic(uuid, jsonb) to authenticated;
