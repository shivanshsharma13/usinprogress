-- Undoes migrations/20261108000000_streaks_and_recap.sql. Roll the app back first. No data is lost.
drop function if exists week_recap(text, text);
drop function if exists full_days_between(uuid, uuid, date, date);
drop function if exists streak_of(uuid);
drop function if exists study_days(uuid);
