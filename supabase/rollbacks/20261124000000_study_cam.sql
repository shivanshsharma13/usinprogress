-- Undo 20261124000000_study_cam.sql. Nothing lasting is lost: call messages only live for 10 minutes.
drop function if exists send_cam_signal(uuid, uuid, text, jsonb);
alter publication supabase_realtime drop table cam_signals;
drop table if exists cam_signals;
