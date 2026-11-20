-- Undo 20261122000000_day_hours.sql. Everyone keeps one set of hours (their first work day's) for all work days; per-day
-- hours and single-day changes are dropped.
drop function if exists set_day_hours(date, jsonb);
update profiles set routine = routine - 'work' - 'dayChanges' where routine is not null;

create or replace function set_routine(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_sleep integer := (p->>'sleepMinutes')::integer; v_start text := p->>'workStart'; v_end text := p->>'workEnd';
        v_days jsonb := coalesce(p->'workDays', '[]'); v_clean jsonb;
begin
  if v_sleep is null or v_sleep < 180 or v_sleep > 720 then perform app_error('P0400', 'Sleep should be between 3 and 12 hours.'); end if;
  if (v_start is null) <> (v_end is null) then perform app_error('P0400', 'Give both a start and an end for work.'); end if;
  if v_start is not null and (v_start !~ '^([01]\d|2[0-3]):[0-5]\d$' or v_end !~ '^([01]\d|2[0-3]):[0-5]\d$' or v_start = v_end) then
    perform app_error('P0400', 'Those work hours aren''t valid.');
  end if;
  if jsonb_typeof(v_days) <> 'array' or exists (select 1 from jsonb_array_elements(v_days) d where jsonb_typeof(d) <> 'number' or d::text::integer not between 0 and 6) then
    perform app_error('P0400', 'Pick work days from Sunday to Saturday.');
  end if;
  v_clean := jsonb_build_object('sleepMinutes', v_sleep, 'workStart', v_start, 'workEnd', v_end,
    'workDays', coalesce((select jsonb_agg(distinct d::text::integer) from jsonb_array_elements(v_days) d), '[]'));
  update profiles set routine = v_clean where id = v_me;
  perform touch_presence(v_me);
  return v_clean;
end $$;

drop function if exists is_clock(text);
