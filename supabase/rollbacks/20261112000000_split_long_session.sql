-- Undo 20261112000000_split_long_session.sql. Sessions already saved from a split stay as they are.
drop function if exists finish_session_split(uuid, jsonb, boolean, text);
