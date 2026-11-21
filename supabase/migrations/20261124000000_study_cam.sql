-- Study cam (Settings → Motivation & focus): a video call with a friend that stays quiet while you focus.
-- Before and after a session you talk normally; while either of you is focusing, mics are off and you just see
-- each other; on a break you talk again. Video and sound go straight between the two phones (WebRTC); the
-- database only passes the short setup messages ("calling", "answer", network details) between you.
-- Both people need the switch on. Messages are readable only by the two people in the call and are deleted
-- after 10 minutes.

create table cam_signals (
  id          bigint generated always as identity primary key,
  from_user   uuid not null references profiles(id) on delete cascade,
  to_user     uuid not null references profiles(id) on delete cascade,
  call_id     uuid not null,
  kind        text not null check (kind in ('ring', 'accept', 'decline', 'busy', 'offer', 'answer', 'ice', 'hangup')),
  payload     jsonb not null default '{}' check (length(payload::text) <= 20000),
  created_at  bigint not null,
  check (from_user <> to_user)
);
create index cam_signals_to on cam_signals(to_user, created_at);
create index cam_signals_from on cam_signals(from_user, created_at);

alter table cam_signals enable row level security;
create policy cam_signals_read on cam_signals for select to authenticated using (auth.uid() in (from_user, to_user));
revoke insert, update, delete on cam_signals from anon, authenticated;
alter publication supabase_realtime add table cam_signals;

create or replace function send_cam_signal(p_to uuid, p_call uuid, p_kind text, p_payload jsonb default '{}') returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_now bigint := now_ms();
begin
  if not is_friend(v_me, p_to) then perform app_error('P0404', 'You can only call friends.'); end if;
  if not pref_on(v_me, 'studyCam') then perform app_error('P0400', 'Turn on Study cam in Settings → Motivation & focus first.'); end if;
  if not pref_on(p_to, 'studyCam') then
    perform app_error('P0400', display_name_of(p_to) || ' hasn''t turned on Study cam yet.', '{"code": "CAM_OFF"}');
  end if;
  if p_call is null or p_kind is null or p_kind not in ('ring', 'accept', 'decline', 'busy', 'offer', 'answer', 'ice', 'hangup') then
    perform app_error('P0400', 'That call message isn''t valid.');
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 20000 then perform app_error('P0400', 'That call message is too big.'); end if;
  if (select count(*) from cam_signals where from_user = v_me and created_at > v_now - 3600000) >= 1000 then
    perform app_error('P0400', 'Too many calls for now. Try again in a bit.');
  end if;
  delete from cam_signals where created_at < v_now - 600000;
  insert into cam_signals (from_user, to_user, call_id, kind, payload, created_at) values (v_me, p_to, p_call, p_kind, p_payload, v_now);
  if p_kind = 'ring' then
    begin
      perform send_push(push_recipients('pushEncourage', array[p_to]), '📹 ' || display_name_of(v_me) || ' is calling',
        'Open the app to join the study cam.', '', 'cam');
    exception when others then null; -- a notification problem must never stop the call
    end;
  end if;
end $$;

revoke execute on function send_cam_signal(uuid, uuid, text, jsonb) from public, anon;
grant execute on function send_cam_signal(uuid, uuid, text, jsonb) to authenticated;
