-- Undoes migrations/20261109000000_weekly_challenge.sql. Roll the app back first.
-- Challenges and their sunflowers are deleted; their feed entries stay.
begin;
drop function if exists room_blooms(uuid);
drop function if exists current_challenge(uuid, text);
drop function if exists cancel_challenge(uuid);
drop function if exists set_challenge(uuid, text, text, integer);
drop function if exists challenge_label(challenges);
drop function if exists challenge_reached(challenges, uuid);
drop function if exists challenge_progress(uuid, text, text);
alter publication supabase_realtime drop table challenges;
drop table if exists challenges;
commit;
