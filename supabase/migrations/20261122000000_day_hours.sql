-- Work or college hours that differ by day. Each work day now has its own hours (Mon 9–5, Sat 10–1…), and a single
-- day that went differently can be changed on its own ("No work today", "Only till 2 today"), kept for two weeks.
--
-- routine: { sleepMinutes, work: [{ day: 0–6, start: "HH:MM", end: "HH:MM" }], dayChanges: { "YYYY-MM-DD": { start, end } | { off: true } },
--            workStart, workEnd, workDays }   ← the last three are the old shape, still filled in for older app versions.

create or replace function is_clock(t text) returns boolean language sql immutable set search_path = public as $$
  select t is not null and t ~ '^([01]\d|2[0-3]):[0-5]\d$'
$$;

-- p: { sleepMinutes, work: [{ day, start, end }] } — or the old { sleepMinutes, workStart, workEnd, workDays }.
create or replace function set_routine(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_sleep integer := (p->>'sleepMinutes')::integer; v_work jsonb := p->'work'; v_slot jsonb;
        v_clean jsonb; v_first jsonb;
begin
  if v_sleep is null or v_sleep < 180 or v_sleep > 720 then perform app_error('P0400', 'Sleep should be between 3 and 12 hours.'); end if;
  if v_work is null then
    -- Old shape: the same hours on every work day.
    if (p->>'workStart' is null) <> (p->>'workEnd' is null) then perform app_error('P0400', 'Give both a start and an end for work.'); end if;
    if jsonb_typeof(coalesce(p->'workDays', '[]')) <> 'array' then perform app_error('P0400', 'Pick work days from Sunday to Saturday.'); end if;
    v_work := case when p->>'workStart' is null then '[]' else coalesce((
      select jsonb_agg(jsonb_build_object('day', d, 'start', p->>'workStart', 'end', p->>'workEnd')) from jsonb_array_elements(p->'workDays') d), '[]') end;
  end if;
  if jsonb_typeof(v_work) <> 'array' or jsonb_array_length(v_work) > 7 then perform app_error('P0400', 'Give hours for up to 7 days.'); end if;
  for v_slot in select * from jsonb_array_elements(v_work) loop
    if jsonb_typeof(v_slot->'day') <> 'number' or (v_slot->>'day')::numeric not in (0, 1, 2, 3, 4, 5, 6) then
      perform app_error('P0400', 'Pick work days from Sunday to Saturday.');
    end if;
    if not is_clock(v_slot->>'start') or not is_clock(v_slot->>'end') or v_slot->>'start' = v_slot->>'end' then
      perform app_error('P0400', 'Those work hours aren''t valid.');
    end if;
  end loop;
  -- One entry per day (the last one given wins), Sunday first.
  select coalesce(jsonb_agg(jsonb_build_object('day', wd, 'start', s->>'start', 'end', s->>'end') order by wd), '[]') into v_work
    from (select distinct on ((s->>'day')::integer) (s->>'day')::integer as wd, s
            from jsonb_array_elements(v_work) with ordinality e(s, n) order by (s->>'day')::integer, n desc) x;
  v_first := v_work->0;
  v_clean := jsonb_build_object('sleepMinutes', v_sleep, 'work', v_work,
    'dayChanges', coalesce((select routine->'dayChanges' from profiles where id = v_me), '{}'),
    'workStart', v_first->>'start', 'workEnd', v_first->>'end',
    'workDays', coalesce((select jsonb_agg(s->'day') from jsonb_array_elements(v_work) s), '[]'));
  update profiles set routine = v_clean where id = v_me;
  perform touch_presence(v_me);
  return v_clean;
end $$;

-- One day that went differently: p_hours { start, end }, { off: true } for no work, or null to go back to the usual hours.
create or replace function set_day_hours(p_date date, p_hours jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_today date := today_for(v_me); v_routine jsonb; v_changes jsonb; v_value jsonb;
begin
  select routine into v_routine from profiles where id = v_me;
  if v_routine is null then perform app_error('P0409', 'Set your usual sleep and work hours first.'); end if;
  if p_date is null or p_date < v_today - 13 or p_date > v_today + 7 then perform app_error('P0400', 'Pick a day in the last two weeks or the next week.'); end if;
  if p_hours is null or jsonb_typeof(p_hours) = 'null' then v_value := null;
  elsif (p_hours->>'off')::boolean is true then v_value := '{"off": true}';
  elsif is_clock(p_hours->>'start') and is_clock(p_hours->>'end') and p_hours->>'start' <> p_hours->>'end' then
    v_value := jsonb_build_object('start', p_hours->>'start', 'end', p_hours->>'end');
  else perform app_error('P0400', 'Those work hours aren''t valid.');
  end if;
  -- Keep two weeks of changes; older days fall out of every chart anyway.
  select coalesce(jsonb_object_agg(k, v), '{}') into v_changes
    from jsonb_each(coalesce(v_routine->'dayChanges', '{}')) e(k, v) where k::date >= v_today - 13 and k <> p_date::text;
  if v_value is not null then v_changes := v_changes || jsonb_build_object(p_date::text, v_value); end if;
  update profiles set routine = v_routine || jsonb_build_object('dayChanges', v_changes) where id = v_me returning routine into v_routine;
  return v_routine;
end $$;

-- Saved routines move to the new shape.
update profiles set routine = routine || jsonb_build_object('dayChanges', '{}', 'work', case when routine->>'workStart' is null then '[]' else coalesce((
    select jsonb_agg(jsonb_build_object('day', d::text::integer, 'start', routine->>'workStart', 'end', routine->>'workEnd') order by d::text::integer)
      from jsonb_array_elements(routine->'workDays') d), '[]') end)
  where routine is not null and routine->'work' is null;

revoke execute on function is_clock(text) from public, anon, authenticated;
revoke execute on function set_day_hours(date, jsonb) from public, anon;
grant execute on function set_day_hours(date, jsonb) to authenticated;
