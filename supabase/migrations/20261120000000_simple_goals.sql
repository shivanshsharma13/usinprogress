-- Simple goals. A goal is a list of tasks that lives in one room; each task has a date or none. No sprints to
-- pull, review or extend: the sprint rows still exist underneath (the forest, calendar, streaks and what your
-- friend may see all read them), but they are now kept in step automatically:
--   * every sprint of a goal is in the goal's room and stays open,
--   * the sprints always cover every task's date (the goal stretches either way when needed),
--   * every task, dated or not, has a topic in the goal's room, so it can be studied there.

alter table plans add column room_id uuid references rooms(id);
create index plans_room on plans(room_id);

-- Gives a task its topic in the goal's room (creating, moving or restoring it). Undated tasks count too.
create or replace function attach_goal_task(p_task uuid) returns void language plpgsql security definer set search_path = public as $$
declare t plan_tasks; p plans; v_topic topics; v_new uuid;
begin
  select * into t from plan_tasks where id = p_task and status = 'active';
  if t.id is null then return; end if;
  select * into p from plans where id = t.plan_id;
  if p.room_id is null or not exists (select 1 from rooms where id = p.room_id and status = 'active') then return; end if;
  if t.topic_id is not null then
    select * into v_topic from topics where id = t.topic_id;
    if v_topic.room_id = p.room_id and v_topic.status = 'active' then return; end if;
    update topics set room_id = p.room_id, status = 'active', updated_at = now_ms() where id = t.topic_id;
    perform topic_event(t.topic_id, p.owner_id, 'restored');
    return;
  end if;
  insert into topics (room_id, title, estimated_minutes, position, created_by, created_at, updated_at)
  values (p.room_id, t.title, t.est_minutes, coalesce((select max(position) from topics where room_id = p.room_id), 0) + 1, p.owner_id, now_ms(), now_ms())
  returning id into v_new;
  perform ensure_progress(v_new, p.owner_id);
  perform topic_event(v_new, p.owner_id, 'created', jsonb_build_object('title', t.title));
  update plan_tasks set topic_id = v_new where id = p_task;
end $$;

-- Puts every sprint of a goal in its room (open), and every task in the room.
create or replace function sync_goal(p_plan uuid) returns void language plpgsql security definer set search_path = public as $$
declare p plans; t record;
begin
  select * into p from plans where id = p_plan;
  if p.room_id is null then return; end if;
  update plan_sprints set room_id = p.room_id, pulled_at = coalesce(pulled_at, now_ms()), completed_at = null
   where plan_id = p_plan and (room_id is distinct from p.room_id or completed_at is not null);
  for t in select id from plan_tasks where plan_id = p_plan and status = 'active' order by day nulls last, position loop
    perform attach_goal_task(t.id);
  end loop;
end $$;

-- The goal's day number for a date, stretching the goal to cover it: earlier dates move its start back
-- (adding days in front), later ones add days at the end. NULL date → NULL (no date).
create or replace function goal_day(p_plan uuid, p_date text) returns integer language plpgsql security definer set search_path = public as $$
declare p plans; v_day integer; v_shift integer; v_chunk integer; v_k integer := 0; v_last integer;
begin
  if p_date is null then return null; end if;
  if p_date !~ '^\d{4}-\d{2}-\d{2}$' then perform app_error('P0400', 'That date isn''t valid.'); end if;
  select * into p from plans where id = p_plan for update;
  v_day := p_date::date - p.start_date::date;
  if v_day < 0 then
    v_shift := -v_day;
    -- New days go in front as extra sprints (at most 60 days each); existing ones move up.
    update plan_sprints set number = number + 1000 where plan_id = p_plan;
    while v_shift > 0 loop
      v_chunk := least(v_shift, 60);
      v_k := v_k + 1;
      insert into plan_sprints (plan_id, number, days, room_id, pulled_at) values (p_plan, v_k, v_chunk, p.room_id, case when p.room_id is not null then now_ms() end);
      v_shift := v_shift - v_chunk;
    end loop;
    update plan_sprints set number = number - 1000 + v_k where plan_id = p_plan and number > 1000;
    update plan_tasks set day = day - v_day, planned_day = planned_day - v_day where plan_id = p_plan;
    update plans set start_date = p_date, updated_at = now_ms() where id = p_plan;
    v_day := 0;
  end if;
  select max(last_day) into v_last from plan_spans(p_plan);
  while coalesce(v_last, -1) < v_day loop
    insert into plan_sprints (plan_id, number, days, room_id, pulled_at)
    values (p_plan, coalesce((select max(number) from plan_sprints where plan_id = p_plan), 0) + 1, p.sprint_days, p.room_id, case when p.room_id is not null then now_ms() end);
    v_last := coalesce(v_last, -1) + p.sprint_days;
  end loop;
  return v_day;
end $$;

create or replace function require_goal_room(p_room uuid, p_user uuid) returns void language plpgsql stable security definer set search_path = public as $$
begin
  if p_room is null or not is_room_member(p_room, p_user) then perform app_error('P0404', 'That room could not be found.'); end if;
  if not exists (select 1 from rooms where id = p_room and status = 'active') then perform app_error('P0400', 'That room is archived.'); end if;
end $$;

create or replace function create_goal(p_title text, p_room uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_id uuid; v_now bigint := now_ms();
begin
  perform require_goal_room(p_room, v_me);
  insert into plans (owner_id, title, start_date, sprint_days, room_id, created_at, updated_at)
  values (v_me, btrim(p_title), today_for(v_me), 7, p_room, v_now, v_now) returning id into v_id;
  insert into plan_sprints (plan_id, number, days, room_id, pulled_at) values (v_id, 1, 7, p_room, v_now);
  perform touch_presence(v_me);
  return v_id;
end $$;

-- Moves a goal (and the topics of its tasks) to another room.
create or replace function set_goal_room(p_plan uuid, p_room uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := me();
begin
  perform own_plan(p_plan, v_me);
  perform require_goal_room(p_room, v_me);
  if exists (select 1 from plan_tasks pt join study_sessions s on s.topic_id = pt.topic_id
              where pt.plan_id = p_plan and s.state in ('running', 'paused')) then
    perform app_error('P0409', 'You''re studying a task from this goal right now. Finish that session first.');
  end if;
  update plans set room_id = p_room, updated_at = now_ms() where id = p_plan;
  perform sync_goal(p_plan);
  perform touch_presence(v_me);
end $$;

create or replace function add_goal_task(p_plan uuid, p_date text, p_title text, p_est integer default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); p plans; v_day integer; v_id uuid; v_now bigint := now_ms();
begin
  p := own_plan(p_plan, v_me);
  if p.room_id is null then perform app_error('P0400', 'Pick a room for this goal first.', '{"code": "GOAL_NO_ROOM"}'); end if;
  if coalesce(btrim(p_title), '') = '' then perform app_error('P0400', 'Give the task a name.'); end if;
  v_day := goal_day(p_plan, p_date);
  insert into plan_tasks (plan_id, day, planned_day, title, est_minutes, position, created_at, updated_at)
  values (p_plan, v_day, v_day, left(btrim(p_title), 140), p_est, next_task_position(p_plan, v_day), v_now, v_now) returning id into v_id;
  update plans set updated_at = v_now where id = p_plan;
  perform sync_goal(p_plan);
  perform touch_presence(v_me);
  return v_id;
end $$;

-- "Add a task" in a room: into the goal you pick, or your most recent goal here, or a new "My tasks" goal.
create or replace function add_room_task(p_room uuid, p_plan uuid, p_date text, p_title text, p_est integer default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_plan uuid := p_plan;
begin
  perform require_goal_room(p_room, v_me);
  if v_plan is null then
    select id into v_plan from plans where owner_id = v_me and room_id = p_room and status = 'active' order by updated_at desc limit 1;
    if v_plan is null then v_plan := create_goal('My tasks', p_room); end if;
  elsif not exists (select 1 from plans where id = v_plan and owner_id = v_me and room_id = p_room and status = 'active') then
    perform app_error('P0404', 'That goal isn''t in this room.');
  end if;
  return add_goal_task(v_plan, p_date, p_title, p_est);
end $$;

-- Edits a task. p_patch keys (all optional): title, estMinutes, date ("YYYY-MM-DD" or null for no date).
create or replace function edit_goal_task(p_task uuid, p_patch jsonb) returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); t plan_tasks; v_patch jsonb := p_patch - 'date';
begin
  select * into t from plan_tasks where id = p_task and status = 'active';
  if t.id is null then perform app_error('P0404', 'That task could not be found.'); end if;
  perform own_plan(t.plan_id, v_me);
  if p_patch ? 'date' then v_patch := v_patch || jsonb_build_object('day', goal_day(t.plan_id, p_patch->>'date')); end if;
  perform update_plan_task(p_task, v_patch);
  perform sync_goal(t.plan_id);
end $$;

-- Moves every task of one goal into another (dates, topics and progress kept) and archives the emptied goal.
create or replace function merge_goal_core(p_from uuid, p_into uuid) returns integer language plpgsql security definer set search_path = public as $$
declare src plans; dst plans; t plan_tasks; v_n integer := 0; v_day integer; v_planned integer;
begin
  select * into src from plans where id = p_from;
  select * into dst from plans where id = p_into;
  if src.id is null or dst.id is null or src.owner_id <> dst.owner_id or src.id = dst.id then perform app_error('P0400', 'Those goals can''t be merged.'); end if;
  for t in select * from plan_tasks where plan_id = p_from and status = 'active' order by day nulls last, position loop
    -- Cover both dates first (each may move the goal's start), then count days from the final start.
    if t.planned_day is not null then perform goal_day(p_into, to_char(src.start_date::date + t.planned_day, 'YYYY-MM-DD')); end if;
    if t.day is not null then perform goal_day(p_into, to_char(src.start_date::date + t.day, 'YYYY-MM-DD')); end if;
    select * into dst from plans where id = p_into;
    v_day := case when t.day is null then null else (src.start_date::date + t.day) - dst.start_date::date end;
    v_planned := case when t.planned_day is null then null else (src.start_date::date + t.planned_day) - dst.start_date::date end;
    update plan_tasks set plan_id = p_into, day = v_day, planned_day = v_planned, position = next_task_position(p_into, v_day), updated_at = now_ms() where id = t.id;
    v_n := v_n + 1;
  end loop;
  update plans set status = 'archived', updated_at = now_ms() where id = p_from;
  update plans set updated_at = now_ms() where id = p_into;
  perform sync_goal(p_into);
  return v_n;
end $$;

create or replace function merge_goal(p_from uuid, p_into uuid) returns integer language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_n integer;
begin
  perform own_plan(p_from, v_me);
  perform own_plan(p_into, v_me);
  v_n := merge_goal_core(p_from, p_into);
  perform touch_presence(v_me);
  return v_n;
end $$;

-- Room tasks for room members: every active goal in the room with its tasks' dates (your friend's undated
-- tasks show up through their topics).
create or replace function room_goals(p_room uuid) returns table (id uuid, title text, owner_id uuid, start_date text)
language sql stable security definer set search_path = public as $$
  select p.id, p.title, p.owner_id, p.start_date from plans p
   where p.room_id = p_room and p.status = 'active' and is_room_member(p_room, auth.uid())
   order by p.created_at
$$;

-- A goal made the older way gets its room the first time one of its sprints is pulled into one.
create or replace function goal_room_from_sprint() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.room_id is not null then update plans set room_id = new.room_id where id = new.plan_id and room_id is null; end if;
  return null;
end $$;
create trigger goal_room_from_sprint after insert or update of room_id on plan_sprints for each row execute function goal_room_from_sprint();

-- ── Existing goals: give each one its room and bring it fully into that room ──
-- The room its sprints were pulled into (the latest one); else the owner's only active room.
update plans p set room_id = (select s.room_id from plan_sprints s where s.plan_id = p.id and s.room_id is not null order by s.number desc limit 1);
update plans p set room_id = (select m.room_id from room_members m join rooms r on r.id = m.room_id where m.user_id = p.owner_id and r.status = 'active' limit 1)
 where p.room_id is null and p.status = 'active'
   and (select count(*) from room_members m join rooms r on r.id = m.room_id where m.user_id = p.owner_id and r.status = 'active') = 1;
do $$ declare g record; begin
  for g in select id from plans where status = 'active' and room_id is not null loop perform sync_goal(g.id); end loop;
end $$;

revoke execute on function goal_room_from_sprint() from public, anon, authenticated;
revoke execute on function attach_goal_task(uuid), sync_goal(uuid), goal_day(uuid, text), require_goal_room(uuid, uuid), merge_goal_core(uuid, uuid) from public, anon, authenticated;
revoke execute on function create_goal(text, uuid), set_goal_room(uuid, uuid), add_goal_task(uuid, text, text, integer), add_room_task(uuid, uuid, text, text, integer),
  edit_goal_task(uuid, jsonb), merge_goal(uuid, uuid), room_goals(uuid) from public, anon;
grant execute on function create_goal(text, uuid), set_goal_room(uuid, uuid), add_goal_task(uuid, text, text, integer), add_room_task(uuid, uuid, text, text, integer),
  edit_goal_task(uuid, jsonb), merge_goal(uuid, uuid), room_goals(uuid) to authenticated;
