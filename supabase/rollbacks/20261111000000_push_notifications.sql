-- Undoes migrations/20261111000000_push_notifications.sql. Roll the app back first.
-- Saved device subscriptions are deleted; "finished today's plan" feed entries stay.
begin;
drop trigger if exists note_day_finished on topic_completions;
drop trigger if exists push_on_session on study_sessions;
drop trigger if exists push_on_activity on activities;
drop function if exists note_day_finished();
drop function if exists push_on_session();
drop function if exists push_on_activity();
drop function if exists display_name_of(uuid);
drop function if exists send_push(uuid[], text, text, text, text);
drop function if exists friends_of(uuid);
drop function if exists push_recipients(text, uuid[]);
drop function if exists delete_push_subscription(text);
drop function if exists save_push_subscription(text, text, text);
drop table if exists push_config;
drop table if exists push_subscriptions;
commit;
