-- Revision reminders: after you first finish a topic, revise it 1, 3, 7 and 21 days later. Nothing new is
-- stored; reviews are read from what you already do. A review is a day after the first finish on which you
-- completed it again or spent 5+ minutes in a revision session. Each review moves the topic to its next step.
create or replace function due_revisions(p_days_ahead integer default 0) returns jsonb
language sql stable security definer set search_path = public as $$
  with mine as (
    select c.topic_id, c.local_date::date as first_date
      from topic_completions c join topics t on t.id = c.topic_id join rooms r on r.id = t.room_id
     where c.user_id = auth.uid() and c.kind = 'first' and c.revoked_at is null
       and t.status = 'active' and r.status = 'active' and is_room_member(t.room_id, auth.uid())
  ), reviewed as (
    select m.topic_id, count(distinct x.d)::integer as n
      from mine m cross join lateral (
        select r.local_date::date as d from topic_completions r
         where r.topic_id = m.topic_id and r.user_id = auth.uid() and r.kind = 'revision' and r.revoked_at is null
        union
        select s.local_date::date from study_sessions s
         where s.topic_id = m.topic_id and s.user_id = auth.uid() and s.state = 'finished' and s.is_revision and coalesce(s.focused_ms, 0) >= 300000
      ) x
     where x.d > m.first_date
     group by m.topic_id
  ), steps as (
    select m.topic_id, m.first_date, coalesce(rv.n, 0) as n, m.first_date + (array[1, 3, 7, 21])[coalesce(rv.n, 0) + 1] as due
      from mine m left join reviewed rv using (topic_id)
     where coalesce(rv.n, 0) < 4
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'topicId', s.topic_id, 'title', t.title, 'roomId', t.room_id, 'roomName', r.name,
           'step', s.n + 1, 'dueDate', to_char(s.due, 'YYYY-MM-DD'), 'firstDoneDate', to_char(s.first_date, 'YYYY-MM-DD'))
         order by s.due, t.title), '[]')
    from steps s join topics t on t.id = s.topic_id join rooms r on r.id = t.room_id
   where s.due <= today_for(auth.uid())::date + greatest(0, least(coalesce(p_days_ahead, 0), 30))
$$;

revoke execute on function due_revisions(integer) from public, anon;
grant execute on function due_revisions(integer) to authenticated;
