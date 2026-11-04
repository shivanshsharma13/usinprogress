-- Phone notifications from your friend (Settings → Motivation & focus), even with the app closed.
-- Each device that turns them on saves a browser push subscription here. When something happens, the
-- database works out who wants to hear about it and hands the message to the `push` edge function
-- (supabase/functions/push), which encrypts and delivers it. Until push_config has the function's
-- address, nothing is sent.
--   pushEncourage: your friend sends a reaction or a note
--   pushStudying:  your friend starts studying, or joins you (not while you're studying yourself)
--   pushDayDone:   your friend finishes everything planned for the day

create extension if not exists pg_net with schema extensions;

create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  endpoint    text not null unique check (endpoint ~ '^https://'),
  p256dh      text not null,
  auth        text not null,
  created_at  bigint not null
);
create index push_subscriptions_user on push_subscriptions(user_id);
alter table push_subscriptions enable row level security;
create policy push_subscriptions_read_own on push_subscriptions for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on push_subscriptions from anon, authenticated;

-- Where the edge function lives and the secret it expects. Nobody can read this through the API.
create table push_config (
  id      boolean primary key default true check (id),
  url     text not null,
  secret  text not null
);
alter table push_config enable row level security;
revoke all on push_config from anon, authenticated;

create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_endpoint !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then perform app_error('P0400', 'That notification subscription isn''t valid.'); end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, created_at) values (me(), p_endpoint, p_p256dh, p_auth, now_ms())
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function delete_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- Who should hear about an event: the people it's for, if they switched that kind on, have a device
-- subscribed, and (for "studying" news) aren't studying themselves right now.
create or replace function push_recipients(p_pref text, p_users uuid[]) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(u), '{}') from unnest(p_users) u
   where pref_on(u, p_pref)
     and exists (select 1 from push_subscriptions s where s.user_id = u)
     and (p_pref <> 'pushStudying' or not exists (select 1 from study_sessions s where s.user_id = u and s.state in ('running', 'paused')))
$$;

create or replace function friends_of(p_user uuid) returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(case when requester_id = p_user then recipient_id else requester_id end), '{}')
    from friendships where status = 'accepted' and p_user in (requester_id, recipient_id)
$$;

create or replace function send_push(p_users uuid[], p_title text, p_body text, p_path text, p_tag text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare cfg push_config; v_subs jsonb;
begin
  select * into cfg from push_config;
  if cfg.url is null or coalesce(array_length(p_users, 1), 0) = 0 then return; end if;
  select jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth)) into v_subs from push_subscriptions where user_id = any(p_users);
  if v_subs is null then return; end if;
  perform net.http_post(
    url := cfg.url,
    body := jsonb_build_object('subscriptions', v_subs, 'notification', jsonb_build_object('title', p_title, 'body', p_body, 'path', p_path, 'tag', p_tag)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.secret));
end $$;

create or replace function display_name_of(p_user uuid) returns text language sql stable security definer set search_path = public as $$
  select display_name from profiles where id = p_user
$$;

-- Encouragement, joining you, and finishing the day (activities are the app's event log).
create or replace function push_on_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := display_name_of(new.actor_id);
begin
  if new.type in ('reaction', 'message') and new.recipient_id is not null then
    perform send_push(push_recipients('pushEncourage', array[new.recipient_id]),
      case new.type when 'message' then '💌 ' || who else who || ' sent you some encouragement' end,
      case new.type when 'message' then new.message
        else (case new.reaction when 'proud' then '❤️ Proud of you' when 'keep_going' then '💪 Keep going' when 'one_step' then '🌱 One step at a time' else '✨ You''ve got this' end) end,
      'friends?tab=activity', 'encourage');
  elsif new.type = 'together_joined' and new.recipient_id is not null then
    perform send_push(push_recipients('pushEncourage', array[new.recipient_id]), '🌱 ' || who || ' joined you', 'You''re studying together now.', 'study', 'together');
  elsif new.type = 'day_finished' then
    perform send_push(push_recipients('pushDayDone', friends_of(new.actor_id)), '🌳 ' || who || ' finished today''s plan', 'Everything planned for today is done. Send some love?', 'friends', 'day-done');
  end if;
  return null;
exception when others then
  return null; -- a notification problem must never stop the action itself
end $$;
create trigger push_on_activity after insert on activities for each row execute function push_on_activity();

-- A friend starting to study (not a restart within 20 minutes, and only if they share their status).
create or replace function push_on_session() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.state = 'running' and (select share_status from profiles where id = new.user_id)
     and not exists (select 1 from study_sessions s where s.user_id = new.user_id and s.id <> new.id and s.started_at > new.started_at - 20 * 60000) then
    perform send_push(push_recipients('pushStudying', friends_of(new.user_id)), '📚 ' || display_name_of(new.user_id) || ' started studying',
      'Join them for a session together?', 'study?join=' || new.user_id, 'studying');
  end if;
  return null;
exception when others then
  return null; -- a notification problem must never stop the action itself
end $$;
create trigger push_on_session after insert on study_sessions for each row execute function push_on_session();

-- "Finished today's plan": the first time each day that everything planned for today is complete.
create or replace function note_day_finished() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_today date := today_for(new.user_id)::date;
begin
  if new.kind = 'first' and full_days_between(new.user_id, new.user_id, v_today, v_today) = 1
     and not exists (select 1 from activities where actor_id = new.user_id and type = 'day_finished' and created_at > now_ms() - 20 * 3600000
                     and local_date(new.user_id, created_at) = v_today::text) then
    perform record_activity(new.user_id, 'day_finished');
  end if;
  return null;
exception when others then
  return null; -- a notification problem must never stop the action itself
end $$;
create trigger note_day_finished after insert on topic_completions for each row execute function note_day_finished();

revoke execute on function push_recipients(text, uuid[]), friends_of(uuid), send_push(uuid[], text, text, text, text), display_name_of(uuid),
  push_on_activity(), push_on_session(), note_day_finished() from public, anon, authenticated;
revoke execute on function save_push_subscription(text, text, text), delete_push_subscription(text) from public, anon;
grant execute on function save_push_subscription(text, text, text), delete_push_subscription(text) to authenticated;
