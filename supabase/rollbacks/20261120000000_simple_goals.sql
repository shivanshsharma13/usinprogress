-- Undo 20261120000000_simple_goals.sql. Sprints stay pulled into their rooms and open (they were reopened when
-- this ran); tasks given topics stay in their rooms. Merged goals stay merged.
drop trigger if exists goal_room_from_sprint on plan_sprints;
drop function if exists goal_room_from_sprint();
drop function if exists room_goals(uuid);
drop function if exists merge_goal(uuid, uuid);
drop function if exists merge_goal_core(uuid, uuid);
drop function if exists edit_goal_task(uuid, jsonb);
drop function if exists add_room_task(uuid, uuid, text, text, integer);
drop function if exists add_goal_task(uuid, text, text, integer);
drop function if exists set_goal_room(uuid, uuid);
drop function if exists create_goal(text, uuid);
drop function if exists require_goal_room(uuid, uuid);
drop function if exists goal_day(uuid, text);
drop function if exists sync_goal(uuid);
drop function if exists attach_goal_task(uuid);
drop index if exists plans_room;
alter table plans drop column if exists room_id;
