-- Streaks and the weekly recap (Settings → Motivation & focus). Both only read existing data.

-- Days someone studied at least 5 focused minutes (in their own time zone), counting a session running now.
create or replace function study_days(p_user uuid) returns table (d date)
language sql stable security definer set search_path = public as $$
  select x.local_date::date from (
    select local_date, coalesce(focused_ms, 0) as ms from study_sessions where user_id = p_user and state = 'finished'
    union all
    select today_for(p_user), session_focused_ms(id, now_ms()) from study_sessions where user_id = p_user and state in ('running', 'paused')
  ) x group by x.local_date having sum(x.ms) >= 300000
$$;

-- Current and best run of consecutive study days. Today not studied yet doesn't break the run.
create or replace function streak_of(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with days as (select d from study_days(p_user)),
  runs as (
    select max(d) as last_day, count(*)::integer as len
      from (select d, d - (row_number() over (order by d))::integer as grp from days) x group by grp
  )
  select jsonb_build_object(
    'current', coalesce((select len from runs where last_day >= today_for(p_user)::date - 1 order by last_day desc limit 1), 0),
    'best', coalesce((select max(len) from runs), 0),
    'studiedToday', exists (select 1 from days where d = today_for(p_user)::date))
$$;

-- Days between two dates on which someone finished everything they had planned, in sprints pulled into
-- rooms the viewer is in (the same rule as the room forest, so these are the trees planted).
create or replace function full_days_between(p_user uuid, p_viewer uuid, p_from date, p_to date) returns integer
language sql stable security definer set search_path = public as $$
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
$$;

-- You and your friends between two dates (at most 31 days): streak, focused time, best day, topics
-- finished and trees planted. A friend's topics and trees count only in rooms you share.
create or replace function week_recap(p_from text, p_to text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := me();
begin
  if p_from !~ '^\d{4}-\d{2}-\d{2}$' or p_to !~ '^\d{4}-\d{2}-\d{2}$' or p_to < p_from or p_to::date - p_from::date > 31 then
    perform app_error('P0400', 'Choose a range of up to a month.');
  end if;
  return (
    with people as (
      select v_me as id
      union
      select case when requester_id = v_me then recipient_id else requester_id end
        from friendships where status = 'accepted' and v_me in (requester_id, recipient_id)
    ), daily as (
      select p.id, x.local_date, sum(x.ms)::bigint as ms
        from people p cross join lateral (
          select local_date, coalesce(focused_ms, 0) as ms from study_sessions
           where user_id = p.id and state = 'finished' and local_date between p_from and p_to
          union all
          select today_for(p.id), session_focused_ms(id, now_ms()) from study_sessions
           where user_id = p.id and state in ('running', 'paused') and today_for(p.id) between p_from and p_to
        ) x group by p.id, x.local_date
    )
    select jsonb_agg(jsonb_build_object(
             'userId', p.id,
             'streak', streak_of(p.id),
             'totalMs', coalesce((select sum(ms) from daily where daily.id = p.id), 0),
             'bestDay', (select jsonb_build_object('date', local_date, 'ms', ms) from daily where daily.id = p.id order by ms desc, local_date limit 1),
             'topicsDone', (select count(*) from topic_completions c join topics t on t.id = c.topic_id
                             where c.user_id = p.id and c.kind = 'first' and c.revoked_at is null and c.local_date between p_from and p_to
                               and (p.id = v_me or is_room_member(t.room_id, v_me))),
             'trees', full_days_between(p.id, v_me, p_from::date, p_to::date))
           order by p.id <> v_me)
      from people p
  );
end $$;

revoke execute on function study_days(uuid), streak_of(uuid), full_days_between(uuid, uuid, date, date) from public, anon, authenticated;
revoke execute on function week_recap(text, text) from public, anon;
grant execute on function week_recap(text, text) to authenticated;
