-- Undo 20261113000000_photo_cheers.sql. Deletes every photo cheer.
drop function if exists my_photo_cheers();
drop function if exists send_photo_cheer(uuid, text, text, uuid);
drop function if exists seen_photo_cheer(uuid);
drop function if exists heart_photo_cheer(uuid);
drop function if exists photo_cheer_json(photo_cheers);
drop function if exists prune_photo_cheers();
drop table if exists photo_cheers;
