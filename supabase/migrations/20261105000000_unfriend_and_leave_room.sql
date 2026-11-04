-- Unfriending and removing a room from your list.

alter table friendships drop constraint friendships_status_check;
alter table friendships add constraint friendships_status_check check (status in ('pending', 'accepted', 'rejected', 'cancelled', 'removed'));

-- Leaves a room: it disappears from your list, your sprints come out of it and your own topics in it are
-- archived (history and study time are kept). Your friend keeps the room. Once nobody is left it's archived.
create or replace function leave_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); s record; t record;
begin
  if not is_room_member(p_room, v_me) then perform app_error('P0404', 'That room could not be found.'); end if;
  if exists (select 1 from study_sessions where user_id = v_me and room_id = p_room and state in ('running', 'paused')) then
    perform app_error('P0409', 'You''re studying in this room right now. Finish that session first.');
  end if;
  for s in select ps.plan_id, ps.number from plan_sprints ps join plans p on p.id = ps.plan_id where ps.room_id = p_room and p.owner_id = v_me loop
    perform unpull_sprint(s.plan_id, s.number);
  end loop;
  for t in select id from topics where room_id = p_room and created_by = v_me and status = 'active' loop
    update topics set status = 'archived', updated_at = now_ms() where id = t.id;
    perform topic_event(t.id, v_me, 'archived');
  end loop;
  update room_members set status = 'left' where room_id = p_room and user_id = v_me;
  update rooms set status = 'archived', updated_at = now_ms() where id = p_room and not exists (select 1 from room_members where room_id = p_room and status = 'active');
  perform touch_presence(v_me);
  perform touch_presence(m.user_id) from room_members m where m.room_id = p_room and m.status = 'active';
end $$;

-- Removes a friend. They aren't told, and can be added again later. Rooms you share are archived for both
-- of you (history kept); with p_leave_rooms you also take them off your own list.
create or replace function unfriend(p_user uuid, p_leave_rooms boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_id uuid; r record; v_rooms integer := 0;
begin
  select id into v_id from friendships where user_low = least(v_me, p_user) and user_high = greatest(v_me, p_user) and status = 'accepted' for update;
  if v_id is null then perform app_error('P0404', 'That person is not in your friends list.'); end if;
  for r in select a.room_id from room_members a join room_members b on b.room_id = a.room_id
            where a.user_id = v_me and b.user_id = p_user and a.status = 'active' and b.status = 'active' loop
    update rooms set status = 'archived', updated_at = now_ms() where id = r.room_id and status = 'active';
    if p_leave_rooms then perform leave_room(r.room_id); end if;
    v_rooms := v_rooms + 1;
  end loop;
  update friendships set status = 'removed', responded_at = now_ms() where id = v_id;
  perform touch_presence(v_me);
  perform touch_presence(p_user);
  return jsonb_build_object('rooms', v_rooms);
end $$;

revoke execute on function leave_room(uuid), unfriend(uuid, boolean) from public, anon;
grant execute on function leave_room(uuid), unfriend(uuid, boolean) to authenticated;
