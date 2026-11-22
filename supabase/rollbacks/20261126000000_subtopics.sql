-- Undo 20261126000000_subtopics.sql. Sessions keep their time on the topic; only the subtopic labels go.
-- Topics already merged stay merged (the archived one can be restored from the room, but without its time).
drop function if exists merge_topic(uuid, uuid);
drop function if exists set_session_subtopic(uuid, uuid);
drop function if exists topic_subtopics(uuid);
drop function if exists delete_subtopic(uuid);
drop function if exists update_subtopic(uuid, jsonb);
drop function if exists add_subtopic(uuid, text);

-- Your active session now says whether it's part of a together session.
create or replace function active_session_json(p_session uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'roomId', s.room_id, 'roomName', r.name, 'topicId', s.topic_id, 'topicTitle', t.title,
    'state', s.state, 'startedAt', s.started_at, 'pauses', session_pauses_json(s.id), 'targetMinutes', s.target_minutes,
    'remindAfterHour', s.remind_after_hour, 'isRevision', s.is_revision, 'taskId', s.task_id, 'togetherId', s.together_id)
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
      select s.local_date, s.topic_id, s.room_id, coalesce(s.focused_ms, 0) as ms
        from study_sessions s
       where s.user_id = p_user and s.state = 'finished' and s.local_date between p_from and p_to
      union all
      -- The session running now counts towards today.
      select v_today, s.topic_id, s.room_id, session_focused_ms(s.id, now_ms())
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
        select jsonb_agg(jsonb_build_object('topicId', v.topic_id, 'title', t.title, 'roomId', v.room_id, 'roomName', r.name, 'ms', v.ms, 'sessions', v.n) order by v.ms desc)
          from (select topic_id, room_id, sum(ms) as ms, count(*) as n from visible where named group by topic_id, room_id) v
          join topics t on t.id = v.topic_id join rooms r on r.id = v.room_id), '[]'),
      'otherMs', coalesce((select sum(ms) from visible where not named), 0)
    )
  );
end $$;

revoke execute on function room_forest(uuid), hours_report(uuid, text, text) from public, anon;
grant execute on function room_forest(uuid), hours_report(uuid, text, text) to authenticated;

alter table study_sessions drop column if exists subtopic_id;
drop function if exists own_subtopic(uuid, uuid);
drop table if exists subtopics;
