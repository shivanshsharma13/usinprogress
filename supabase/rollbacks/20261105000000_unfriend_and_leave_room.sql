-- Undoes migrations/20261105000000_unfriend_and_leave_room.sql. Roll the app back first.
-- Unfriended pairs stay not-friends; rooms people left stay left (see README → Rolling back).
begin;
update friendships set status = 'cancelled' where status = 'removed';
alter table friendships drop constraint friendships_status_check;
alter table friendships add constraint friendships_status_check check (status in ('pending', 'accepted', 'rejected', 'cancelled'));
drop function if exists unfriend(uuid, boolean);
drop function if exists leave_room(uuid);
commit;
