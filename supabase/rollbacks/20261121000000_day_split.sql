-- Undo 20261121000000_day_split.sql. Deletes everyone's saved sleep and work hours.
drop function if exists routine_of(uuid);
drop function if exists set_routine(jsonb);
alter table profiles drop column if exists routine;
