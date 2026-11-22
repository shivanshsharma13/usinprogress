-- Subtopics (Settings → Motivation & focus): the parts of a topic, like "Pascal's Triangle" → I, II, III.
-- Revising a topic or going deeper adds a subtopic instead of a second topic with the same name. A session can
-- be on one subtopic, so Progress can show which topics take longest and how many subtopics went into them.
-- Two topics that turned out to be the same can be merged: time, completions and subtopics move to one.
-- Like topics, only the topic's owner can change its subtopics; room members can see them.

create table subtopics (
  id          uuid primary key default gen_random_uuid(),
  topic_id    uuid not null references topics(id),
  title       text not null check (char_length(btrim(title)) between 1 and 140),
  done_at     bigint,
  position    double precision not null,
  created_at  bigint not null,
  updated_at  bigint not null
);
create index subtopics_topic on subtopics(topic_id, position);

alter table subtopics enable row level security;
create policy subtopics_read on subtopics for select to authenticated using (is_room_member(topic_room(topic_id)));
revoke insert, update, delete on subtopics from anon, authenticated;

-- What part of the topic a session was on. Removing a subtopic keeps the session's time on the topic.
alter table study_sessions add column subtopic_id uuid references subtopics(id) on delete set null;
create index study_sessions_subtopic on study_sessions(subtopic_id) where subtopic_id is not null;

-- Subtopic plus topic, for changes: only the topic's owner.
create or replace function own_subtopic(p_id uuid, p_user uuid) returns subtopics
language plpgsql security definer set search_path = public as $$
declare s subtopics;
begin
  select * into s from subtopics where id = p_id;
  if s.id is null then perform app_error('P0404', 'That subtopic could not be found.'); end if;
  perform require_own_topic(s.topic_id, p_user);
  return s;
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
  return v_id;
end $$;

-- p_patch keys (all optional): title, done.
create or replace function update_subtopic(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s subtopics;
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
end $$;

create or replace function delete_subtopic(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s subtopics;
begin
  s := own_subtopic(p_id, v_me);
  delete from subtopics where id = s.id;
  perform topic_event(s.topic_id, v_me, 'subtopic_removed', jsonb_build_object('title', s.title));
end $$;

-- A topic's subtopics with the owner's time on each.
create or replace function topic_subtopics(p_topic uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'topicId', s.topic_id, 'title', s.title, 'doneAt', s.done_at,
           'focusedMs', coalesce(x.ms, 0), 'sessions', coalesce(x.n, 0)) order by s.position), '[]')
    from subtopics s
    left join (select subtopic_id, sum(focused_ms)::bigint as ms, count(*) as n from study_sessions
                where topic_id = p_topic and state = 'finished' and subtopic_id is not null group by subtopic_id) x on x.subtopic_id = s.id
   where s.topic_id = p_topic and is_room_member(topic_room(p_topic), auth.uid())
$$;

-- Your active session now says which subtopic it's on.
create or replace function active_session_json(p_session uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'roomId', s.room_id, 'roomName', r.name, 'topicId', s.topic_id, 'topicTitle', t.title,
    'state', s.state, 'startedAt', s.started_at, 'pauses', session_pauses_json(s.id), 'targetMinutes', s.target_minutes,
    'remindAfterHour', s.remind_after_hour, 'isRevision', s.is_revision, 'taskId', s.task_id, 'togetherId', s.together_id,
    'subtopicId', s.subtopic_id, 'subtopicTitle', st.title)
    from study_sessions s join topics t on t.id = s.topic_id join rooms r on r.id = s.room_id
    left join subtopics st on st.id = s.subtopic_id
   where s.id = p_session
$$;

create or replace function session_record_json(p_session uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'roomId', s.room_id, 'roomName', r.name, 'topicId', s.topic_id, 'topicTitle', t.title,
    'subtopicTitle', st.title,
    'state', s.state, 'startedAt', s.started_at, 'endedAt', s.ended_at,
    'focusedMs', case when s.state in ('running', 'paused') then session_focused_ms(s.id, now_ms()) else coalesce(s.focused_ms, 0) end,
    'measuredMs', s.measured_ms, 'isRevision', s.is_revision, 'note', s.note,
    'corrections', coalesce((select jsonb_agg(jsonb_build_object('oldMs', c.old_ms, 'newMs', c.new_ms, 'reason', c.reason, 'createdAt', c.created_at) order by c.created_at)
                               from session_corrections c where c.session_id = s.id), '[]'))
    from study_sessions s join topics t on t.id = s.topic_id join rooms r on r.id = s.room_id
    left join subtopics st on st.id = s.subtopic_id
   where s.id = p_session
$$;

-- Which subtopic a session is on (null: the topic as a whole). Returns the session while it's running.
create or replace function set_session_subtopic(p_session uuid, p_subtopic uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s study_sessions;
begin
  s := own_session(p_session, v_me);
  if p_subtopic is not null and not exists (select 1 from subtopics where id = p_subtopic and topic_id = s.topic_id) then
    perform app_error('P0404', 'That subtopic isn''t part of this topic.');
  end if;
  update study_sessions set subtopic_id = p_subtopic where id = s.id;
  return case when s.state in ('running', 'paused') then active_session_json(s.id) end;
end $$;

-- Folds p_from into p_into (both yours, in the same room): its sessions, completions, history and subtopics
-- move across, and p_from is archived along with its goal task. A topic with no subtopics of its own and a
-- different name becomes one subtopic, so its time stays labelled.
create or replace function merge_topic(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = public as $$
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
  perform touch_presence(v_me);
end $$;

-- Hours by topic now include each topic's subtopics: how many there are, how many are done, and the time on
-- each one studied in the range.
create or replace function hours_report(p_user uuid, p_from text, p_to text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := me(); v_today text := today_for(p_user);
begin
  if p_user <> v_me and not is_friend(v_me, p_user) then perform app_error('P0404', 'That person is not in your friends list.'); end if;
  if p_from !~ '^\d{4}-\d{2}-\d{2}$' or p_to !~ '^\d{4}-\d{2}-\d{2}$' or p_to < p_from or p_to::date - p_from::date > 366 then
    perform app_error('P0400', 'Choose a range of up to a year.');
  end if;

  return (
    with sessions as (
      select s.local_date, s.topic_id, s.subtopic_id, s.room_id, coalesce(s.focused_ms, 0) as ms
        from study_sessions s
       where s.user_id = p_user and s.state = 'finished' and s.local_date between p_from and p_to
      union all
      -- The session running now counts towards today.
      select v_today, s.topic_id, s.subtopic_id, s.room_id, session_focused_ms(s.id, now_ms())
        from study_sessions s
       where s.user_id = p_user and s.state in ('running', 'paused') and v_today between p_from and p_to
    ), visible as (
      select x.*, (p_user = v_me or is_room_member(x.room_id, v_me)) as named from sessions x
    )
    select jsonb_build_object(
      'userId', p_user,
      'from', p_from,
      'to', p_to,
      'today', v_today,
      'daily', coalesce((
        select jsonb_agg(jsonb_build_object('date', d, 'ms', coalesce((select sum(ms) from visible where local_date = d), 0)) order by d)
          from (select to_char(g, 'YYYY-MM-DD') as d from generate_series(p_from::date, p_to::date, interval '1 day') g) days), '[]'),
      'topics', coalesce((
        select jsonb_agg(jsonb_build_object('topicId', v.topic_id, 'title', t.title, 'roomId', v.room_id, 'roomName', r.name, 'ms', v.ms, 'sessions', v.n,
                 'subtopicsTotal', (select count(*) from subtopics where topic_id = v.topic_id),
                 'subtopicsDone', (select count(*) from subtopics where topic_id = v.topic_id and done_at is not null),
                 'subtopics', coalesce((
                   select jsonb_agg(jsonb_build_object('id', st.id, 'title', st.title, 'ms', y.ms, 'done', st.done_at is not null) order by y.ms desc)
                     from (select subtopic_id, sum(ms) as ms from visible where named and topic_id = v.topic_id and subtopic_id is not null group by subtopic_id) y
                     join subtopics st on st.id = y.subtopic_id), '[]'))
                 order by v.ms desc)
          from (select topic_id, room_id, sum(ms) as ms, count(*) as n from visible where named group by topic_id, room_id) v
          join topics t on t.id = v.topic_id join rooms r on r.id = v.room_id), '[]'),
      'otherMs', coalesce((select sum(ms) from visible where not named), 0)
    )
  );
end $$;

revoke execute on function own_subtopic(uuid, uuid) from public, anon, authenticated;
revoke execute on function add_subtopic(uuid, text), update_subtopic(uuid, jsonb), delete_subtopic(uuid), topic_subtopics(uuid),
  set_session_subtopic(uuid, uuid), merge_topic(uuid, uuid) from public, anon;
grant execute on function add_subtopic(uuid, text), update_subtopic(uuid, jsonb), delete_subtopic(uuid), topic_subtopics(uuid),
  set_session_subtopic(uuid, uuid), merge_topic(uuid, uuid) to authenticated;
