-- Where your day goes (Settings → Motivation & focus → Day split). You say how much you sleep and when you
-- work; the app splits each day into sleep, work, study and timepass (free time you didn't study). Your
-- friend sees your split too, while you have the switch on.

alter table profiles add column routine jsonb check (routine is null or jsonb_typeof(routine) = 'object');

-- p: { sleepMinutes: 180–720, workStart: "HH:MM" | null, workEnd: "HH:MM" | null, workDays: [0–6] (0 = Sunday) }
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

-- Your routine, or a friend's while they share their day split.
create or replace function routine_of(p_user uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select case when p_user = auth.uid() or (is_friend(auth.uid(), p_user) and pref_on(p_user, 'daySplit')) then routine end
    from profiles where id = p_user
$$;

revoke execute on function set_routine(jsonb), routine_of(uuid) from public, anon;
grant execute on function set_routine(jsonb), routine_of(uuid) to authenticated;
