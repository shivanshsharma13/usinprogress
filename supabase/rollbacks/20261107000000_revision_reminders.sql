-- Undoes migrations/20261107000000_revision_reminders.sql. Roll the app back first. No data is lost.
drop function if exists due_revisions(integer);
