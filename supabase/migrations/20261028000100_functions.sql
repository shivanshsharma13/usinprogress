-- Us in Progress — every write, plus the few reads friends may only see in summary.
-- Each function is SECURITY DEFINER, checks the caller with auth.uid(), and runs in one transaction.

-- ───────────────────────── Small helpers ─────────────────────────

create or replace function me() returns uuid language plpgsql stable as $$
begin
  if auth.uid() is null then perform app_error('P0401', 'Please sign in again.'); end if;
  return auth.uid();
end $$;

create or replace function touch_presence(p_user uuid) returns void language sql security definer set search_path = public as $$
  insert into presence (user_id, updated_at) values (p_user, now_ms())
  on conflict (user_id) do update set updated_at = excluded.updated_at
$$;

create or replace function record_activity(p_actor uuid, p_type text, p_recipient uuid default null, p_room uuid default null,
  p_ref uuid default null, p_reaction text default null, p_message text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into activities (actor_id, recipient_id, room_id, type, ref_id, reaction, message, created_at)
  values (p_actor, p_recipient, p_room, p_type, p_ref, p_reaction, nullif(p_message, ''), now_ms()) returning id into v_id;
  return v_id;
end $$;

create or replace function topic_event(p_topic uuid, p_user uuid, p_type text, p_detail jsonb default '{}') returns void
language sql security definer set search_path = public as $$
  insert into topic_events (topic_id, user_id, type, detail, created_at) values (p_topic, p_user, p_type, p_detail, now_ms())
$$;

-- Topic plus room, for changes: only the topic's owner, and only as a member of its room.
create or replace function require_own_topic(p_topic uuid, p_user uuid) returns topics
language plpgsql security definer set search_path = public as $$
declare t topics;
begin
  select * into t from topics where id = p_topic;
  if t.id is null or not is_room_member(t.room_id, p_user) then perform app_error('P0404', 'That topic could not be found.'); end if;
  if t.created_by <> p_user then
    perform app_error('P0403', 'This is your friend''s topic. You can follow their progress, but only they can change or study it.');
  end if;
  return t;
end $$;

-- ───────────────────────── Accounts ─────────────────────────

create or replace function username_available(p_username text) returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles where username = lower(btrim(p_username)))
$$;

-- A profile is created with every new Supabase Auth user, from the sign-up form's metadata.
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}');
  v_type text := coalesce(m->>'profile_type', 'custom');
begin
  insert into profiles (id, username, display_name, profile_type, accent, bio, avatar, timezone)
  values (
    new.id,
    lower(btrim(m->>'username')),
    btrim(coalesce(m->>'display_name', m->>'username')),
    v_type,
    coalesce(m->>'accent', case v_type when 'engineer' then 'blue' when 'doctor' then 'pink' else 'lavender' end),
    coalesce(m->>'bio', ''),
    coalesce(m->'avatar', jsonb_build_object('accessory', case v_type when 'doctor' then 'stethoscope' when 'engineer' then 'glasses' else 'leaf' end)),
    coalesce(nullif(m->>'timezone', ''), 'UTC'));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- ───────────────────────── Friends ─────────────────────────

create or replace function respond_friend_request(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); f friendships;
begin
  select * into f from friendships where id = p_id for update;
  if f.id is null or v_me not in (f.requester_id, f.recipient_id) then perform app_error('P0404', 'That request could not be found.'); end if;
  if f.recipient_id <> v_me then perform app_error('P0403', 'Only the person who received this request can answer it.'); end if;
  if f.status <> 'pending' then perform app_error('P0409', 'This request was already answered.'); end if;
  update friendships set status = case when p_accept then 'accepted' else 'rejected' end, responded_at = now_ms() where id = p_id;
  if p_accept then perform record_activity(v_me, 'friend_accepted', f.requester_id); end if;
  perform touch_presence(f.requester_id);
  perform touch_presence(f.recipient_id);
end $$;

-- Sends a request. If they already asked me, this accepts theirs instead of creating a duplicate.
create or replace function send_friend_request(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); f friendships; v_id uuid;
begin
  if p_user = v_me then perform app_error('P0400', 'That''s you! Search for your friend''s username.'); end if;
  if not exists (select 1 from profiles where id = p_user) then perform app_error('P0404', 'That person could not be found.'); end if;
  select * into f from friendships where user_low = least(v_me, p_user) and user_high = greatest(v_me, p_user) and status in ('pending', 'accepted');
  if f.status = 'accepted' then perform app_error('P0409', 'You are already friends.'); end if;
  if f.status = 'pending' then
    if f.requester_id = v_me then perform app_error('P0409', 'Your request is already waiting for them.'); end if;
    perform respond_friend_request(f.id, true);
    return jsonb_build_object('id', f.id, 'status', 'accepted');
  end if;
  insert into friendships (requester_id, recipient_id, user_low, user_high, status, created_at)
  values (v_me, p_user, least(v_me, p_user), greatest(v_me, p_user), 'pending', now_ms()) returning id into v_id;
  perform touch_presence(p_user);
  return jsonb_build_object('id', v_id, 'status', 'pending');
end $$;

create or replace function cancel_friend_request(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); f friendships;
begin
  select * into f from friendships where id = p_id;
  if f.id is null or f.requester_id <> v_me then perform app_error('P0404', 'That request could not be found.'); end if;
  if f.status <> 'pending' then perform app_error('P0409', 'This request was already answered.'); end if;
  update friendships set status = 'cancelled', responded_at = now_ms() where id = p_id;
  perform touch_presence(f.recipient_id);
end $$;

-- ───────────────────────── Rooms & topics ─────────────────────────

create or replace function create_room(p_friend uuid, p_name text, p_description text, p_start text, p_end text, p_color text default 'sage') returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_id uuid; v_now bigint := now_ms();
begin
  if p_friend = v_me then perform app_error('P0400', 'Choose a friend to share this room with.'); end if;
  if not is_friend(v_me, p_friend) then perform app_error('P0403', 'You can only create rooms with accepted friends.'); end if;
  if p_end < p_start then perform app_error('P0400', 'The end date must be after the start date.'); end if;
  insert into rooms (name, description, start_date, end_date, color, creator_id, created_at, updated_at)
  values (btrim(p_name), coalesce(p_description, ''), p_start, p_end, coalesce(p_color, 'sage'), v_me, v_now, v_now) returning id into v_id;
  insert into room_members (room_id, user_id, joined_at) values (v_id, v_me, v_now), (v_id, p_friend, v_now);
  perform record_activity(v_me, 'room_created', null, v_id, v_id);
  return v_id;
end $$;

create or replace function ensure_progress(p_topic uuid, p_user uuid) returns void language sql security definer set search_path = public as $$
  insert into topic_progress (topic_id, user_id, status, updated_at) values (p_topic, p_user, 'not_started', now_ms())
  on conflict (topic_id, user_id) do nothing
$$;

create or replace function create_topic(p_room uuid, p_title text, p_description text default '', p_category text default '',
  p_estimated integer default null, p_target integer default null, p_deadline text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_id uuid; v_now bigint := now_ms(); r rooms;
begin
  select * into r from rooms where id = p_room;
  if r.id is null or not is_room_member(p_room, v_me) then perform app_error('P0404', 'That room could not be found.'); end if;
  if r.status = 'archived' then perform app_error('P0400', 'This room is archived. Reopen it to add topics.'); end if;
  insert into topics (room_id, title, description, category, estimated_minutes, session_target_minutes, deadline, position, created_by, created_at, updated_at)
  values (p_room, btrim(p_title), coalesce(p_description, ''), coalesce(p_category, ''), p_estimated, p_target, p_deadline,
          coalesce((select max(position) from topics where room_id = p_room), 0) + 1, v_me, v_now, v_now)
  returning id into v_id;
  perform ensure_progress(v_id, v_me);
  perform topic_event(v_id, v_me, 'created', jsonb_build_object('title', p_title));
  return v_id;
end $$;

-- p_patch keys (all optional): title, description, category, estimatedMinutes, sessionTargetMinutes, deadline, status.
create or replace function update_topic(p_topic uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); t topics; n topics; v_changes jsonb := '{}';
begin
  t := require_own_topic(p_topic, v_me);
  n := t;
  if p_patch ? 'title' then n.title := btrim(p_patch->>'title'); end if;
  if p_patch ? 'description' then n.description := p_patch->>'description'; end if;
  if p_patch ? 'category' then n.category := p_patch->>'category'; end if;
  if p_patch ? 'estimatedMinutes' then n.estimated_minutes := (p_patch->>'estimatedMinutes')::integer; end if;
  if p_patch ? 'sessionTargetMinutes' then n.session_target_minutes := (p_patch->>'sessionTargetMinutes')::integer; end if;
  if p_patch ? 'deadline' then n.deadline := p_patch->>'deadline'; end if;
  if p_patch ? 'status' then n.status := p_patch->>'status'; end if;
  if n.status = 'archived' and t.status <> 'archived'
     and exists (select 1 from study_sessions where topic_id = p_topic and state in ('running', 'paused')) then
    perform app_error('P0409', 'Someone is studying this topic right now. Try again after their session.');
  end if;
  select coalesce(jsonb_object_agg(k, jsonb_build_object('from', to_jsonb(t) -> k, 'to', to_jsonb(n) -> k)), '{}') into v_changes
    from unnest(array['title', 'description', 'category', 'estimated_minutes', 'session_target_minutes', 'deadline', 'status']) k
   where (to_jsonb(t) -> k) is distinct from (to_jsonb(n) -> k);
  if v_changes = '{}' then return; end if;
  update topics set title = n.title, description = n.description, category = n.category, estimated_minutes = n.estimated_minutes,
         session_target_minutes = n.session_target_minutes, deadline = n.deadline, status = n.status, updated_at = now_ms()
   where id = p_topic;
  perform topic_event(p_topic, v_me,
    case when n.status <> t.status then case when n.status = 'archived' then 'archived' else 'restored' end else 'edited' end, v_changes);
end $$;

-- Reorders a group of your own topics among the positions they already hold.
create or replace function reorder_topics(p_room uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
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
end $$;

-- Marks a topic complete for its owner. Idempotent, so retries never double count.
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
  perform topic_event(p_topic, p_user, case v_kind when 'first' then 'completed' else 'revision_completed' end);
  if v_kind = 'first' then perform record_activity(p_user, 'topic_completed', null, t.room_id, p_topic); end if;
  perform touch_presence(p_user);
  return true;
end $$;

-- 'revise': study it again (the completion still counts). 'undo': revoke a mistaken completion (kept for audit).
create or replace function reopen_topic(p_topic uuid, p_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_now bigint := now_ms(); v_last uuid; v_status text;
begin
  perform require_own_topic(p_topic, v_me);
  perform ensure_progress(p_topic, v_me);
  if p_mode = 'undo' then
    select id into v_last from topic_completions where topic_id = p_topic and user_id = v_me and revoked_at is null order by completed_at desc limit 1;
    if v_last is null then perform app_error('P0400', 'This topic is not complete.'); end if;
    update topic_completions set revoked_at = v_now where id = v_last;
    update topic_progress set completed_at = null, updated_at = v_now,
           status = case when exists (select 1 from topic_completions where topic_id = p_topic and user_id = v_me and revoked_at is null) then 'revising' else 'in_progress' end
     where topic_id = p_topic and user_id = v_me;
    perform topic_event(p_topic, v_me, 'completion_undone');
  else
    select status into v_status from topic_progress where topic_id = p_topic and user_id = v_me;
    if v_status <> 'completed' then return; end if;
    update topic_progress set status = 'revising', updated_at = v_now where topic_id = p_topic and user_id = v_me;
    perform topic_event(p_topic, v_me, 'reopened_for_revision');
  end if;
  perform touch_presence(v_me);
end $$;

-- ───────────────────────── What to study next ─────────────────────────

-- Your open goal tasks shown in a room: scheduled today or later, in an open sprint pulled into it.
create or replace function open_room_tasks(p_user uuid, p_room uuid)
returns table (topic_id uuid, title text, day integer, pos double precision, date text)
language sql stable security definer set search_path = public as $$
  select pt.topic_id, pt.title, pt.day, pt.position, to_char(p.start_date::date + pt.day, 'YYYY-MM-DD')
    from plan_tasks pt
    join plans p on p.id = pt.plan_id
    join topics tp on tp.id = pt.topic_id
    left join topic_progress pr on pr.topic_id = pt.topic_id and pr.user_id = p_user
   where p.owner_id = p_user and p.status = 'active' and pt.status = 'active' and pt.day is not null
     and tp.room_id = p_room and tp.status = 'active' and (pr.status is null or pr.status <> 'completed')
     and to_char(p.start_date::date + pt.day, 'YYYY-MM-DD') >= today_for(p_user)
     and exists (select 1 from plan_spans(p.id) s where pt.day between s.first_day and s.last_day and s.room_id = p_room and s.completed_at is null)
   order by p.created_at, pt.day, pt.position
$$;

-- Today's first open goal task, else the next upcoming one; otherwise the first open loose topic.
-- After finishing p_after: the next task that day, then following days.
create or replace function next_topic(p_user uuid, p_room uuid, p_after uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today text := today_for(p_user); f record; r record; v_ids uuid[]; v_start integer; i integer; v_n integer;
begin
  if p_after is not null then
    select day, position into f from plan_tasks where topic_id = p_after and status = 'active';
    if found then
      select * into r from open_room_tasks(p_user, p_room) o
       where o.topic_id <> p_after and f.day is not null and (o.day > f.day or (o.day = f.day and o.pos > f.position)) limit 1;
      if r.topic_id is null then select * into r from open_room_tasks(p_user, p_room) o where o.topic_id <> p_after limit 1; end if;
      if r.topic_id is not null then return jsonb_build_object('id', r.topic_id, 'title', r.title); end if;
      return next_topic(p_user, p_room, null);
    end if;
  else
    select * into r from open_room_tasks(p_user, p_room) o order by (o.date = v_today) desc limit 1;
    if r.topic_id is not null then return jsonb_build_object('id', r.topic_id, 'title', r.title); end if;
  end if;
  -- Loose topics (not from a goal), in room order, wrapping around after p_after.
  select array_agg(t.id order by t.position, t.created_at) into v_ids from topics t
   left join topic_progress pr on pr.topic_id = t.id and pr.user_id = p_user
   where t.room_id = p_room and t.created_by = p_user and t.status = 'active'
     and not exists (select 1 from plan_tasks pt where pt.topic_id = t.id and pt.status = 'active');
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then return null; end if;
  v_start := coalesce(array_position(v_ids, p_after), 0);
  for i in 1 .. v_n loop
    select t.id, t.title, pr.status into r from topics t left join topic_progress pr on pr.topic_id = t.id and pr.user_id = p_user
     where t.id = v_ids[((v_start + i - 1) % v_n) + 1];
    if r.id <> coalesce(p_after, '00000000-0000-0000-0000-000000000000') and coalesce(r.status, '') <> 'completed' then
      return jsonb_build_object('id', r.id, 'title', r.title);
    end if;
  end loop;
  return null;
end $$;

create or replace function room_next_topic(p_room uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_room_member(p_room, me()) then return null; end if;
  return next_topic(me(), p_room, null);
end $$;

-- ───────────────────────── Timer ─────────────────────────

create or replace function session_focused_ms(p_session uuid, p_at bigint) returns bigint
language sql stable security definer set search_path = public as $$
  select greatest(0, coalesce(s.ended_at, p_at) - s.started_at - coalesce((
    select sum(greatest(0, least(coalesce(p.resumed_at, coalesce(s.ended_at, p_at)), coalesce(s.ended_at, p_at)) - greatest(p.paused_at, s.started_at)))
      from session_pauses p where p.session_id = s.id), 0))::bigint
    from study_sessions s where s.id = p_session
$$;

create or replace function session_pauses_json(p_session uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('pausedAt', paused_at, 'resumedAt', resumed_at) order by paused_at), '[]')
    from session_pauses where session_id = p_session
$$;

create or replace function active_session_json(p_session uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'roomId', s.room_id, 'roomName', r.name, 'topicId', s.topic_id, 'topicTitle', t.title,
    'state', s.state, 'startedAt', s.started_at, 'pauses', session_pauses_json(s.id), 'targetMinutes', s.target_minutes,
    'remindAfterHour', s.remind_after_hour, 'isRevision', s.is_revision, 'taskId', s.task_id)
    from study_sessions s join topics t on t.id = s.topic_id join rooms r on r.id = s.room_id where s.id = p_session
$$;

create or replace function session_record_json(p_session uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'roomId', s.room_id, 'roomName', r.name, 'topicId', s.topic_id, 'topicTitle', t.title,
    'state', s.state, 'startedAt', s.started_at, 'endedAt', s.ended_at,
    'focusedMs', case when s.state in ('running', 'paused') then session_focused_ms(s.id, now_ms()) else coalesce(s.focused_ms, 0) end,
    'measuredMs', s.measured_ms, 'isRevision', s.is_revision, 'note', s.note,
    'corrections', coalesce((select jsonb_agg(jsonb_build_object('oldMs', c.old_ms, 'newMs', c.new_ms, 'reason', c.reason, 'createdAt', c.created_at) order by c.created_at)
                               from session_corrections c where c.session_id = s.id), '[]'))
    from study_sessions s join topics t on t.id = s.topic_id join rooms r on r.id = s.room_id where s.id = p_session
$$;

create or replace function active_session() returns jsonb language sql stable security definer set search_path = public as $$
  select active_session_json(id) from study_sessions where user_id = auth.uid() and state in ('running', 'paused')
$$;

create or replace function own_session(p_session uuid, p_user uuid) returns study_sessions
language plpgsql security definer set search_path = public as $$
declare s study_sessions;
begin
  select * into s from study_sessions where id = p_session and user_id = p_user for update;
  if s.id is null then perform app_error('P0404', 'That study session could not be found.'); end if;
  return s;
end $$;

create or replace function start_session(p_topic uuid, p_target integer default null, p_remind boolean default false, p_task uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
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
end $$;

-- Pause and resume are idempotent so a repeated tap never corrupts the timeline.
create or replace function pause_session(p_session uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s study_sessions;
begin
  s := own_session(p_session, v_me);
  if s.state = 'running' then
    insert into session_pauses (session_id, paused_at) values (s.id, now_ms());
    update study_sessions set state = 'paused' where id = s.id;
    perform touch_presence(v_me);
  elsif s.state <> 'paused' then perform app_error('P0400', 'This session has already ended.', '{"code": "SESSION_ENDED"}');
  end if;
  return active_session_json(s.id);
end $$;

create or replace function resume_session(p_session uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s study_sessions;
begin
  s := own_session(p_session, v_me);
  if s.state = 'paused' then
    update session_pauses set resumed_at = now_ms() where session_id = s.id and resumed_at is null;
    update study_sessions set state = 'running' where id = s.id;
    perform touch_presence(v_me);
  elsif s.state <> 'running' then perform app_error('P0400', 'This session has already ended.', '{"code": "SESSION_ENDED"}');
  end if;
  return active_session_json(s.id);
end $$;

-- Ends a session and saves its time; optionally completes the topic and picks the next one (not started).
-- Sessions over 4 hours need p_confirm_long or a corrected length. Retrying a finished session adds nothing.
create or replace function finish_session(p_session uuid, p_complete boolean default false, p_confirm_long boolean default false,
  p_corrected integer default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s study_sessions; v_now bigint := now_ms(); v_measured bigint; v_focused bigint; v_done boolean := false; v_status text;
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
  if p_complete then v_done := complete_topic_core(s.topic_id, v_me); end if;
  select status into v_status from topic_progress where topic_id = s.topic_id and user_id = v_me;
  return jsonb_build_object('session', session_record_json(s.id), 'completedTopic', v_done or v_status = 'completed',
    'nextTopic', case when p_complete then next_topic(v_me, s.room_id, s.topic_id) end, 'roomId', s.room_id);
end $$;

-- Complete a topic; if a session is running on it, that session is ended and saved first.
create or replace function complete_topic(p_topic uuid, p_confirm_long boolean default false, p_corrected integer default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); t topics; ex study_sessions;
begin
  t := require_own_topic(p_topic, v_me);
  select * into ex from study_sessions where user_id = v_me and state in ('running', 'paused');
  if ex.id is not null and ex.topic_id = p_topic then
    return finish_session(ex.id, true, p_confirm_long, p_corrected, p_note);
  end if;
  perform complete_topic_core(p_topic, v_me);
  return jsonb_build_object('session', null, 'completedTopic', true, 'nextTopic', next_topic(v_me, t.room_id, p_topic), 'roomId', t.room_id);
end $$;

-- For an accidental session: kept for audit, but it no longer counts.
create or replace function discard_session(p_session uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s study_sessions; v_now bigint := now_ms(); v_measured bigint;
begin
  s := own_session(p_session, v_me);
  if s.state = 'discarded' then return; end if;
  v_measured := coalesce(s.measured_ms, session_focused_ms(s.id, v_now));
  update session_pauses set resumed_at = v_now where session_id = s.id and resumed_at is null;
  update study_sessions set state = 'discarded', ended_at = coalesce(ended_at, v_now), measured_ms = v_measured, focused_ms = 0 where id = s.id;
  insert into session_corrections (session_id, user_id, old_ms, new_ms, reason, created_at) values (s.id, v_me, coalesce(s.focused_ms, v_measured), 0, 'Discarded', v_now);
  perform touch_presence(v_me);
end $$;

create or replace function correct_session(p_session uuid, p_minutes integer, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s study_sessions;
begin
  s := own_session(p_session, v_me);
  if s.state <> 'finished' then perform app_error('P0400', 'Only finished sessions can be corrected.'); end if;
  if p_minutes < 0 or p_minutes > 1440 then perform app_error('P0400', 'Use between 0 and 1440 minutes.'); end if;
  insert into session_corrections (session_id, user_id, old_ms, new_ms, reason, created_at) values (s.id, v_me, coalesce(s.focused_ms, 0), p_minutes * 60000, coalesce(p_reason, ''), now_ms());
  update study_sessions set focused_ms = p_minutes * 60000 where id = s.id;
  perform touch_presence(v_me);
  return session_record_json(s.id);
end $$;

-- Note, one-hour reminder, or session length (keys optional: note, remindAfterHour, targetMinutes).
create or replace function update_session(p_session uuid, p_patch jsonb) returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s study_sessions;
begin
  s := own_session(p_session, v_me);
  update study_sessions set
    note = case when p_patch ? 'note' then left(p_patch->>'note', 1000) else note end,
    remind_after_hour = case when p_patch ? 'remindAfterHour' then (p_patch->>'remindAfterHour')::boolean else remind_after_hour end,
    target_minutes = case when p_patch ? 'targetMinutes' then (p_patch->>'targetMinutes')::integer else target_minutes end
  where id = s.id;
end $$;

-- ───────────────────────── What friends may see, in summary ─────────────────────────

create or replace function focused_today(p_user uuid) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce((select sum(focused_ms) from study_sessions where user_id = p_user and local_date = today_for(p_user) and state = 'finished'), 0)
       + coalesce((select session_focused_ms(id, now_ms()) from study_sessions where user_id = p_user and state in ('running', 'paused') and local_date = today_for(p_user)), 0)
$$;

-- Live status of yourself, friends or room partners. Topic/room names only if you share that room.
create or replace function live_statuses(p_users uuid[]) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := me(); u uuid; p profiles; s study_sessions; v_out jsonb := '{}'; v_st jsonb;
begin
  foreach u in array p_users loop
    if u <> v_me and not is_friend(u, v_me) and not exists (
      select 1 from room_members a join room_members b on a.room_id = b.room_id where a.user_id = v_me and b.user_id = u) then continue; end if;
    select * into p from profiles where id = u;
    v_st := jsonb_build_object('todayFocusedMs', focused_today(u));
    if u <> v_me and not p.share_status then
      v_st := v_st || '{"state": "hidden"}';
    else
      select * into s from study_sessions where user_id = u and state in ('running', 'paused');
      if s.id is null then
        v_st := v_st || '{"state": "idle"}';
      else
        v_st := v_st || jsonb_build_object('state', case s.state when 'running' then 'studying' else 'paused' end, 'startedAt', s.started_at, 'pauses', session_pauses_json(s.id));
        if is_room_member(s.room_id, v_me) then
          v_st := v_st || (select jsonb_build_object('topicTitle', t.title, 'roomName', r.name, 'roomId', r.id) from topics t join rooms r on r.id = t.room_id where t.id = s.topic_id);
        end if;
      end if;
    end if;
    v_out := v_out || jsonb_build_object(u::text, v_st);
  end loop;
  return v_out;
end $$;

-- Per-topic, per-member study time in a room (room members see each other's totals, not sessions).
create or replace function room_topic_time(p_room uuid) returns table (topic_id uuid, user_id uuid, ms bigint, n bigint)
language sql stable security definer set search_path = public as $$
  select s.topic_id, s.user_id, sum(s.focused_ms)::bigint, count(*) from study_sessions s
   where s.room_id = p_room and s.state = 'finished' and is_room_member(p_room, auth.uid())
   group by s.topic_id, s.user_id
$$;

-- Your own time on specific topics (goal tasks), wherever they are.
create or replace function my_topic_time(p_topics uuid[]) returns table (topic_id uuid, ms bigint, n bigint)
language sql stable security definer set search_path = public as $$
  select topic_id, sum(focused_ms)::bigint, count(*) from study_sessions
   where user_id = auth.uid() and state = 'finished' and topic_id = any(p_topics) group by topic_id
$$;

-- Totals for you or a friend (never their session list or notes).
create or replace function progress_stats(p_user uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
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
end $$;

-- Topics in a room that come from goal tasks (so they aren't shown as loose topics), for room members.
create or replace function room_plan_topics(p_room uuid) returns table (topic_id uuid, plan_task_id uuid)
language sql stable security definer set search_path = public as $$
  select pt.topic_id, pt.id from plan_tasks pt join topics t on t.id = pt.topic_id
   where t.room_id = p_room and pt.status = 'active' and is_room_member(p_room, auth.uid())
$$;

-- Open sprints pulled into rooms you belong to (optionally one room), with their day ranges.
create or replace function visible_sprints(p_room uuid default null)
returns table (plan_id uuid, plan_title text, owner_id uuid, start_date text, number integer, days integer,
               first_day integer, last_day integer, room_id uuid, room_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.title, p.owner_id, p.start_date, s.number, s.days, s.first_day, s.last_day, s.room_id, r.name
    from plans p cross join lateral plan_spans(p.id) s join rooms r on r.id = s.room_id
   where p.status = 'active' and s.completed_at is null and s.room_id is not null
     and is_room_member(s.room_id, auth.uid()) and (p_room is null or s.room_id = p_room)
   order by p.created_at, s.number
$$;

-- A topic's finished study sessions (who, when, how long — never notes), for members of its room.
create or replace function topic_sessions(p_topic uuid) returns table (user_id uuid, started_at bigint, focused_ms bigint, is_revision boolean)
language sql stable security definer set search_path = public as $$
  select s.user_id, s.started_at, s.focused_ms, s.is_revision from study_sessions s
   where s.topic_id = p_topic and s.state = 'finished' and is_room_member(topic_room(p_topic), auth.uid())
   order by s.started_at desc limit 100
$$;

create or replace function server_now() returns bigint language sql volatile as $$ select now_ms() $$;

-- ───────────────────────── Goals: plan → sprints → days → tasks ─────────────────────────

create or replace function own_plan(p_plan uuid, p_user uuid) returns plans language plpgsql security definer set search_path = public as $$
declare p plans;
begin
  select * into p from plans where id = p_plan and owner_id = p_user;
  if p.id is null then perform app_error('P0404', 'That goal could not be found.'); end if;
  return p;
end $$;

create or replace function create_plan(p_title text, p_start text, p_sprint_days integer) returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_id uuid; v_now bigint := now_ms();
begin
  insert into plans (owner_id, title, start_date, sprint_days, created_at, updated_at) values (v_me, btrim(p_title), p_start, p_sprint_days, v_now, v_now) returning id into v_id;
  insert into plan_sprints (plan_id, number, days) values (v_id, 1, p_sprint_days);
  return v_id;
end $$;

create or replace function update_plan(p_plan uuid, p_patch jsonb) returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); p plans;
begin
  p := own_plan(p_plan, v_me);
  update plans set title = coalesce(btrim(p_patch->>'title'), title), status = coalesce(p_patch->>'status', status), updated_at = now_ms() where id = p_plan;
  perform touch_presence(v_me);
end $$;

create or replace function add_sprint(p_plan uuid, p_days integer default null) returns integer language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); p plans; v_n integer;
begin
  p := own_plan(p_plan, v_me);
  select coalesce(max(number), 0) + 1 into v_n from plan_sprints where plan_id = p_plan;
  insert into plan_sprints (plan_id, number, days) values (p_plan, v_n, coalesce(p_days, p.sprint_days));
  return v_n;
end $$;

create or replace function sprint_span(p_plan uuid, p_n integer) returns record language plpgsql stable security definer set search_path = public as $$
declare s record;
begin
  select * into s from plan_spans(p_plan) x where x.number = p_n;
  if s.number is null then perform app_error('P0404', 'That sprint could not be found.'); end if;
  return s;
end $$;

create or replace function tasks_between(p_plan uuid, p_from integer, p_to integer) returns bigint language sql stable security definer set search_path = public as $$
  select count(*) from plan_tasks where plan_id = p_plan and status = 'active' and (day between p_from and p_to or planned_day between p_from and p_to)
$$;

-- Changes a sprint's length; later sprints and their tasks shift. Ended sprints and days with tasks are protected.
create or replace function resize_sprint(p_plan uuid, p_n integer, p_days integer) returns void language plpgsql security definer set search_path = public as $$
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
end $$;

create or replace function remove_sprint(p_plan uuid, p_n integer) returns void language plpgsql security definer set search_path = public as $$
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
end $$;

-- Gives a scheduled task a topic in its sprint's room (moving or restoring an existing one).
create or replace function attach_task(p_task uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare t plan_tasks; v_room uuid; v_topic topics; v_new uuid;
begin
  select * into t from plan_tasks where id = p_task;
  if t.day is null then return; end if;
  select s.room_id into v_room from plan_spans(t.plan_id) s where t.day between s.first_day and s.last_day;
  if v_room is null then return; end if;
  if t.topic_id is not null then
    select * into v_topic from topics where id = t.topic_id;
    if v_topic.room_id = v_room and v_topic.status = 'active' then return; end if;
    update topics set room_id = v_room, status = 'active', updated_at = now_ms() where id = t.topic_id;
    perform topic_event(t.topic_id, p_user, 'restored');
    return;
  end if;
  insert into topics (room_id, title, estimated_minutes, position, created_by, created_at, updated_at)
  values (v_room, t.title, t.est_minutes, coalesce((select max(position) from topics where room_id = v_room), 0) + 1, p_user, now_ms(), now_ms())
  returning id into v_new;
  perform ensure_progress(v_new, p_user);
  perform topic_event(v_new, p_user, 'created', jsonb_build_object('title', t.title));
  update plan_tasks set topic_id = v_new where id = p_task;
end $$;

-- Pulls a sprint into a shared room: its scheduled tasks become topics you can study there.
create or replace function pull_sprint(p_plan uuid, p_n integer, p_room uuid) returns uuid language plpgsql security definer set search_path = public as $$
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
end $$;

-- Takes a sprint out of its room: its topics are archived (history kept) and return if it's pulled in again.
create or replace function unpull_sprint(p_plan uuid, p_n integer) returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s record; t record;
begin
  perform own_plan(p_plan, v_me);
  s := sprint_span(p_plan, p_n);
  if s.room_id is null then return; end if;
  for t in select pt.topic_id from plan_tasks pt join topics tp on tp.id = pt.topic_id
            where pt.plan_id = p_plan and pt.status = 'active' and tp.status = 'active' and coalesce(pt.day, pt.planned_day) between s.first_day and s.last_day loop
    if exists (select 1 from study_sessions where topic_id = t.topic_id and state in ('running', 'paused')) then
      perform app_error('P0409', 'You''re studying a task from this sprint right now. Finish that session first.');
    end if;
    update topics set status = 'archived', updated_at = now_ms() where id = t.topic_id;
    perform topic_event(t.topic_id, v_me, 'archived');
  end loop;
  update plan_sprints set room_id = null, pulled_at = null where plan_id = p_plan and number = p_n;
  perform touch_presence(v_me);
end $$;

create or replace function set_sprint_completed(p_plan uuid, p_n integer, p_completed boolean) returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := me();
begin
  perform own_plan(p_plan, v_me);
  perform sprint_span(p_plan, p_n);
  update plan_sprints set completed_at = case when p_completed then now_ms() end where plan_id = p_plan and number = p_n;
  perform touch_presence(v_me);
end $$;

create or replace function check_plan_day(p_plan uuid, p_day integer) returns void language plpgsql stable security definer set search_path = public as $$
begin
  if p_day is not null and not exists (select 1 from plan_spans(p_plan) s where p_day between s.first_day and s.last_day) then
    perform app_error('P0400', 'That day is outside this goal. Add a sprint first.');
  end if;
end $$;

create or replace function next_task_position(p_plan uuid, p_day integer) returns double precision language sql stable security definer set search_path = public as $$
  select coalesce(max(position), 0) + 1 from plan_tasks where plan_id = p_plan and day is not distinct from p_day
$$;

create or replace function add_plan_task(p_plan uuid, p_day integer, p_title text, p_est integer default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_id uuid; v_now bigint := now_ms();
begin
  perform own_plan(p_plan, v_me);
  perform check_plan_day(p_plan, p_day);
  insert into plan_tasks (plan_id, day, planned_day, title, est_minutes, position, created_at, updated_at)
  values (p_plan, p_day, p_day, btrim(p_title), p_est, next_task_position(p_plan, p_day), v_now, v_now) returning id into v_id;
  perform attach_task(v_id, v_me);
  perform touch_presence(v_me);
  return v_id;
end $$;

-- Edits or moves a task (to a day, or to the backlog with "day": null). Re-planning a task that isn't
-- overdue moves its planned day too; scheduling one from the backlog keeps its original planned day.
create or replace function update_plan_task(p_task uuid, p_patch jsonb) returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); t plan_tasks; p plans; v_day integer; v_planned integer; v_on_schedule boolean; v_title text; v_est integer;
begin
  select * into t from plan_tasks where id = p_task and status = 'active';
  if t.id is null then perform app_error('P0404', 'That task could not be found.'); end if;
  p := own_plan(t.plan_id, v_me);
  v_day := case when p_patch ? 'day' then (p_patch->>'day')::integer else t.day end;
  perform check_plan_day(t.plan_id, v_day);
  v_on_schedule := t.day is not null and to_char(p.start_date::date + t.day, 'YYYY-MM-DD') >= today_for(v_me);
  v_planned := case when v_day is distinct from t.day and v_day is not null and (v_on_schedule or t.planned_day is null) then v_day else t.planned_day end;
  v_title := coalesce(btrim(p_patch->>'title'), t.title);
  v_est := case when p_patch ? 'estMinutes' then (p_patch->>'estMinutes')::integer else t.est_minutes end;
  update plan_tasks set day = v_day, planned_day = v_planned, title = v_title, est_minutes = v_est,
         position = case when v_day is not distinct from t.day then position else next_task_position(t.plan_id, v_day) end,
         starred = coalesce((p_patch->>'starred')::boolean, starred), updated_at = now_ms()
   where id = p_task;
  if t.topic_id is not null then
    update topics set title = v_title, estimated_minutes = v_est, updated_at = now_ms() where id = t.topic_id;
  end if;
  if v_day is distinct from t.day then perform attach_task(p_task, v_me); end if;
  perform touch_presence(v_me);
end $$;

create or replace function remove_plan_task(p_task uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); t plan_tasks;
begin
  select * into t from plan_tasks where id = p_task and status = 'active';
  if t.id is null then perform app_error('P0404', 'That task could not be found.'); end if;
  perform own_plan(t.plan_id, v_me);
  if t.topic_id is not null and exists (select 1 from topics where id = t.topic_id and status = 'active') then
    perform update_topic(t.topic_id, '{"status": "archived"}');
  end if;
  update plan_tasks set status = 'archived', updated_at = now_ms() where id = p_task;
  perform touch_presence(v_me);
end $$;

-- ───────────────────────── Calendar tasks ─────────────────────────

create or replace function task_refs(p_user uuid, p_room uuid, p_topic uuid) returns uuid language plpgsql stable security definer set search_path = public as $$
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
end $$;

-- p keys: title, description, date, startTime, durationMinutes, roomId, topicId, shared, note.
create or replace function create_task(p jsonb) returns uuid language plpgsql security definer set search_path = public as $$
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
end $$;

-- p keys as create_task, plus completed (boolean) and status.
create or replace function update_task(p_task uuid, p jsonb) returns void language plpgsql security definer set search_path = public as $$
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
end $$;

-- ───────────────────────── Encouragement ─────────────────────────

create or replace function encourage(p_recipient uuid, p_reaction text default null, p_message text default null, p_room uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me();
begin
  if p_reaction is null and coalesce(btrim(p_message), '') = '' then perform app_error('P0400', 'Pick a reaction or write a short message.'); end if;
  if p_reaction is not null and p_reaction not in ('proud', 'keep_going', 'one_step', 'you_got_this') then perform app_error('P0400', 'Unknown reaction.'); end if;
  if not is_friend(v_me, p_recipient) then perform app_error('P0404', 'That person is not in your friends list.'); end if;
  if p_room is not null and not (is_room_member(p_room, v_me) and is_room_member(p_room, p_recipient)) then
    perform app_error('P0400', 'That room is not shared with them.');
  end if;
  return record_activity(v_me, case when p_reaction is null then 'message' else 'reaction' end, p_recipient, p_room, null, p_reaction, btrim(p_message));
end $$;

create or replace function mark_activity_read() returns void language sql security definer set search_path = public as $$
  update activities set read_at = now_ms() where recipient_id = auth.uid() and read_at is null
$$;

-- ───────────────────────── Grants ─────────────────────────
-- Only signed-in people may call anything, except the username check used on the sign-up form.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function username_available(text) to anon;
-- Internal helpers aren't meant to be called directly.
revoke execute on function complete_topic_core(uuid, uuid), attach_task(uuid, uuid), record_activity(uuid, text, uuid, uuid, uuid, text, text),
  touch_presence(uuid), topic_event(uuid, uuid, text, jsonb), ensure_progress(uuid, uuid), own_session(uuid, uuid), own_plan(uuid, uuid),
  require_own_topic(uuid, uuid), next_topic(uuid, uuid, uuid), open_room_tasks(uuid, uuid), app_error(text, text, text)
  from authenticated;
