-- Room forest and hours report. Both only read; neither changes any data.

-- How many days each member of a room finished everything they had planned, in sprints they pulled
-- into this room (open or completed). A day counts like a "done" day on the goal page: it had tasks and
-- each was completed by the end of that day. Today counts once everything for today is done.
-- Only counts are returned, never which tasks.
create or replace function room_forest(p_room uuid) returns table (user_id uuid, full_days integer)
language sql stable security definer set search_path = public as $$
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
$$;

-- Focused time per day and per topic between two dates (inclusive, at most a year), for yourself or a
-- friend. Totals only, never notes. For a friend, topic names are shown only for rooms you share; the
-- rest is added up as "otherMs".
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
