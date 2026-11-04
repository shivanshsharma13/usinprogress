-- Undoes migrations/20261110000000_study_together.sql. Roll the app back first.
-- Sessions keep their time; only the "together" links and break records are removed.
begin;
drop function if exists together_break(uuid, boolean);
drop function if exists join_study(uuid, uuid, integer);
drop function if exists together_apply_break(uuid, boolean, bigint, bigint);
drop function if exists together_json(uuid);
drop function if exists together_live(uuid);
create or replace function active_session_json(p_session uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'roomId', s.room_id, 'roomName', r.name, 'topicId', s.topic_id, 'topicTitle', t.title,
    'state', s.state, 'startedAt', s.started_at, 'pauses', session_pauses_json(s.id), 'targetMinutes', s.target_minutes,
    'remindAfterHour', s.remind_after_hour, 'isRevision', s.is_revision, 'taskId', s.task_id)
    from study_sessions s join topics t on t.id = s.topic_id join rooms r on r.id = s.room_id where s.id = p_session
$$;
alter table study_sessions drop column if exists together_id;
alter publication supabase_realtime drop table together_sessions;
drop table if exists together_sessions;
commit;
