-- Study together live (Settings → Motivation & focus). One friend is studying; the other joins with a topic
-- of their own. Both see a shared timer, and either can call a break that pauses both sessions (and
-- resumes both). Each person's own session, time and topics stay theirs.

create table together_sessions (
  id                uuid primary key default gen_random_uuid(),
  host_id           uuid not null references profiles(id),
  guest_id          uuid not null references profiles(id),
  started_at        bigint not null,
  break_started_at  bigint,
  break_by          uuid references profiles(id),
  break_ms          bigint not null default 0,
  ended_at          bigint,
  check (host_id <> guest_id)
);
alter table study_sessions add column together_id uuid references together_sessions(id);
create index study_sessions_together on study_sessions(together_id) where together_id is not null;

alter table together_sessions enable row level security;
create policy together_read on together_sessions for select to authenticated using (auth.uid() in (host_id, guest_id));
revoke insert, update, delete on together_sessions from anon, authenticated;
alter publication supabase_realtime add table together_sessions;

-- Your active session now says whether it's part of a together session.
create or replace function active_session_json(p_session uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'roomId', s.room_id, 'roomName', r.name, 'topicId', s.topic_id, 'topicTitle', t.title,
    'state', s.state, 'startedAt', s.started_at, 'pauses', session_pauses_json(s.id), 'targetMinutes', s.target_minutes,
    'remindAfterHour', s.remind_after_hour, 'isRevision', s.is_revision, 'taskId', s.task_id, 'togetherId', s.together_id)
    from study_sessions s join topics t on t.id = s.topic_id join rooms r on r.id = s.room_id where s.id = p_session
$$;

-- Still together while both linked sessions are running or paused.
create or replace function together_live(p_id uuid) returns boolean language sql stable security definer set search_path = public as $$
  select (select ended_at is null from together_sessions where id = p_id)
     and (select count(*) from study_sessions where together_id = p_id and state in ('running', 'paused')) = 2
$$;

create or replace function together_json(p_id uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', g.id, 'hostId', g.host_id, 'guestId', g.guest_id, 'startedAt', g.started_at,
    'breakStartedAt', g.break_started_at, 'breakBy', g.break_by, 'breakMs', g.break_ms, 'live', together_live(g.id),
    'people', coalesce((select jsonb_object_agg(s.user_id::text, jsonb_build_object('state', s.state,
                 'topicTitle', case when is_room_member(s.room_id, auth.uid()) then t.title end))
              from study_sessions s join topics t on t.id = s.topic_id where s.together_id = g.id), '{}'))
    from together_sessions g where g.id = p_id and auth.uid() in (g.host_id, g.guest_id)
$$;

-- Pauses (p_on) or resumes the linked sessions at one timestamp. Resuming only touches sessions the break
-- paused, so someone who had paused on their own before the break stays paused.
create or replace function together_apply_break(p_id uuid, p_on boolean, p_at bigint, p_since bigint) returns void
language plpgsql security definer set search_path = public as $$
declare s study_sessions;
begin
  for s in select * from study_sessions where together_id = p_id and state in ('running', 'paused') for update loop
    if p_on and s.state = 'running' then
      insert into session_pauses (session_id, paused_at) values (s.id, p_at);
      update study_sessions set state = 'paused' where id = s.id;
    elsif not p_on and s.state = 'paused' and exists (select 1 from session_pauses where session_id = s.id and resumed_at is null and paused_at >= p_since) then
      update session_pauses set resumed_at = p_at where session_id = s.id and resumed_at is null;
      update study_sessions set state = 'running' where id = s.id;
    end if;
    perform touch_presence(s.user_id);
  end loop;
end $$;

-- Joins a friend who is studying now: starts your session on your own topic, linked to theirs.
create or replace function join_study(p_friend uuid, p_topic uuid, p_target integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
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
end $$;

-- Either of you calls a break for both, or ends it.
create or replace function together_break(p_id uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); g together_sessions; v_now bigint := now_ms();
begin
  select * into g from together_sessions where id = p_id and v_me in (host_id, guest_id) for update;
  if g.id is null then perform app_error('P0404', 'That study-together session could not be found.'); end if;
  if not together_live(p_id) then perform app_error('P0409', 'Your friend has finished, so you''re studying on your own now.', '{"code": "TOGETHER_ENDED"}'); end if;
  if p_on and g.break_started_at is null then
    update together_sessions set break_started_at = v_now, break_by = v_me where id = p_id;
    perform together_apply_break(p_id, true, v_now, v_now);
  elsif not p_on and g.break_started_at is not null then
    update together_sessions set break_ms = break_ms + (v_now - break_started_at), break_started_at = null, break_by = null where id = p_id;
    perform together_apply_break(p_id, false, v_now, g.break_started_at);
  end if;
  return together_json(p_id);
end $$;

revoke execute on function together_live(uuid), together_apply_break(uuid, boolean, bigint, bigint) from public, anon, authenticated;
revoke execute on function together_json(uuid), join_study(uuid, uuid, integer), together_break(uuid, boolean) from public, anon;
grant execute on function together_json(uuid), join_study(uuid, uuid, integer), together_break(uuid, boolean) to authenticated;
