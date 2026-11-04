-- Weekly challenge between two friends (Settings → Motivation & focus): "N hours each" or "N days each on
-- which you finish everything planned", Monday to Sunday. It's won when both reach the target; each win
-- plants a golden sunflower in the forest of every room the two of you share.

create table challenges (
  id            uuid primary key default gen_random_uuid(),
  user_low      uuid not null references profiles(id),
  user_high     uuid not null references profiles(id),
  week_start    text not null check (week_start ~ '^\d{4}-\d{2}-\d{2}$'),   -- a Monday
  kind          text not null check (kind in ('hours', 'days')),
  target        integer not null check (target between 1 and 100),
  created_by    uuid not null references profiles(id),
  created_at    bigint not null,
  cancelled_at  bigint,
  won_at        bigint,
  check (user_low < user_high)
);
create unique index challenges_live on challenges(user_low, user_high, week_start) where cancelled_at is null;

alter table challenges enable row level security;
create policy challenges_read on challenges for select to authenticated using (auth.uid() in (user_low, user_high));
revoke insert, update, delete on challenges from anon, authenticated;
alter publication supabase_realtime add table challenges;

-- Someone's progress in a week: focused milliseconds ('hours') or days everything planned was done ('days').
create or replace function challenge_progress(p_user uuid, p_kind text, p_week text) returns bigint
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'hours' then coalesce((
      select sum(x.ms) from (
        select coalesce(focused_ms, 0) as ms from study_sessions
         where user_id = p_user and state = 'finished' and local_date between p_week and to_char(p_week::date + 6, 'YYYY-MM-DD')
        union all
        select session_focused_ms(id, now_ms()) from study_sessions
         where user_id = p_user and state in ('running', 'paused') and today_for(p_user) between p_week and to_char(p_week::date + 6, 'YYYY-MM-DD')
      ) x), 0)::bigint
    else full_days_between(p_user, p_user, p_week::date, p_week::date + 6)::bigint
  end
$$;

create or replace function challenge_reached(c challenges, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select challenge_progress(p_user, c.kind, c.week_start) >= case c.kind when 'hours' then c.target::bigint * 3600000 else c.target end
$$;

create or replace function challenge_label(c challenges) returns text language sql immutable as $$
  select case c.kind when 'hours' then c.target || ' hours each' else 'everything planned done on ' || c.target || case when c.target = 1 then ' day' else ' days' end || ' each' end
$$;

-- Sets (or replaces) the challenge for a week: this week or next. A won challenge stays.
create or replace function set_challenge(p_friend uuid, p_week text, p_kind text, p_target integer) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_this text := to_char(date_trunc('week', today_for(me())::date), 'YYYY-MM-DD'); c challenges;
  v_max integer := (array[100, 7])[(p_kind = 'days')::integer + 1];
begin
  if not is_friend(v_me, p_friend) then perform app_error('P0404', 'That person is not in your friends list.'); end if;
  if p_week is null or p_week not in (v_this, to_char(v_this::date + 7, 'YYYY-MM-DD')) then perform app_error('P0400', 'Choose this week or next week.'); end if;
  if p_kind is null or p_kind not in ('hours', 'days') or p_target is null or p_target < 1 or p_target > v_max then
    perform app_error('P0400', 'Choose a target the two of you can reach this week.');
  end if;
  select * into c from challenges where user_low = least(v_me, p_friend) and user_high = greatest(v_me, p_friend) and week_start = p_week and cancelled_at is null for update;
  if c.won_at is not null then perform app_error('P0409', 'You already won this week''s challenge. 🌻'); end if;
  if c.id is not null then update challenges set cancelled_at = now_ms() where id = c.id; end if;
  insert into challenges (user_low, user_high, week_start, kind, target, created_by, created_at)
  values (least(v_me, p_friend), greatest(v_me, p_friend), p_week, p_kind, p_target, v_me, now_ms()) returning * into c;
  perform record_activity(v_me, 'challenge_set', p_friend, null, c.id, null, challenge_label(c));
  perform touch_presence(v_me);
  perform touch_presence(p_friend);
  return c.id;
end $$;

create or replace function cancel_challenge(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); c challenges;
begin
  select * into c from challenges where id = p_id and v_me in (user_low, user_high) and cancelled_at is null for update;
  if c.id is null then perform app_error('P0404', 'That challenge could not be found.'); end if;
  if c.won_at is not null then perform app_error('P0409', 'A won challenge stays in your forest. 🌻'); end if;
  update challenges set cancelled_at = now_ms() where id = p_id;
  perform touch_presence(c.user_low);
  perform touch_presence(c.user_high);
end $$;

-- The challenge for a week with both people's progress. Also settles recent ones both of you reached
-- (including last week's, if nobody looked before it ended), so wins are never missed.
create or replace function current_challenge(p_friend uuid, p_week text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); c challenges;
begin
  if not is_friend(v_me, p_friend) then perform app_error('P0404', 'That person is not in your friends list.'); end if;
  for c in select * from challenges where user_low = least(v_me, p_friend) and user_high = greatest(v_me, p_friend)
              and cancelled_at is null and won_at is null and week_start between to_char(p_week::date - 14, 'YYYY-MM-DD') and p_week for update loop
    if challenge_reached(c, c.user_low) and challenge_reached(c, c.user_high) then
      update challenges set won_at = now_ms() where id = c.id;
      perform record_activity(v_me, 'challenge_won', p_friend, null, c.id, null, challenge_label(c));
    end if;
  end loop;
  select * into c from challenges where user_low = least(v_me, p_friend) and user_high = greatest(v_me, p_friend) and week_start = p_week and cancelled_at is null;
  return jsonb_build_object(
    'challenge', case when c.id is null then null else jsonb_build_object(
      'id', c.id, 'weekStart', c.week_start, 'kind', c.kind, 'target', c.target, 'createdBy', c.created_by, 'wonAt', c.won_at,
      'progress', jsonb_build_object(v_me::text, challenge_progress(v_me, c.kind, c.week_start), p_friend::text, challenge_progress(p_friend, c.kind, c.week_start))) end,
    'wins', (select count(*) from challenges where user_low = least(v_me, p_friend) and user_high = greatest(v_me, p_friend) and won_at is not null));
end $$;

-- Golden sunflowers in a room's forest: challenges its two members have won together.
create or replace function room_blooms(p_room uuid) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from challenges ch
   where ch.won_at is not null and is_room_member(p_room, auth.uid())
     and exists (select 1 from room_members m where m.room_id = p_room and m.user_id = ch.user_low)
     and exists (select 1 from room_members m where m.room_id = p_room and m.user_id = ch.user_high)
$$;

revoke execute on function challenge_progress(uuid, text, text), challenge_reached(challenges, uuid), challenge_label(challenges) from public, anon, authenticated;
revoke execute on function set_challenge(uuid, text, text, integer), cancel_challenge(uuid), current_challenge(uuid, text), room_blooms(uuid) from public, anon;
grant execute on function set_challenge(uuid, text, text, integer), cancel_challenge(uuid), current_challenge(uuid, text), room_blooms(uuid) to authenticated;
