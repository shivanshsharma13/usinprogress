-- Undoes migrations/20261106000000_preferences.sql. Roll the app back first. Saved switches are lost.
begin;
drop function if exists pref_on(uuid, text);
alter table profiles drop column if exists prefs;
commit;
