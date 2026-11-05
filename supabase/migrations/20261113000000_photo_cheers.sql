-- Photo cheers (Settings → Motivation & focus): snap a selfie with the front camera and send it to a friend.
-- It floats around their study timer. Photos are small JPEGs (the frame is drawn in on the sender's device),
-- readable only by the sender and the recipient, and deleted after 24 hours.

create table photo_cheers (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references profiles(id) on delete cascade,
  recipient_id  uuid not null references profiles(id) on delete cascade,
  image         text not null check (image like 'data:image/jpeg;base64,%' and length(image) <= 200000),
  caption       text not null default '' check (char_length(caption) <= 80),
  reply_to      uuid references photo_cheers(id) on delete set null,
  created_at    bigint not null,
  seen_at       bigint,
  hearted_at    bigint,
  check (sender_id <> recipient_id)
);
create index photo_cheers_recipient on photo_cheers(recipient_id, created_at);
create index photo_cheers_sender on photo_cheers(sender_id, created_at);

alter table photo_cheers enable row level security;
create policy photo_cheers_read on photo_cheers for select to authenticated
  using (auth.uid() in (sender_id, recipient_id) and created_at > now_ms() - 86400000);
revoke insert, update, delete on photo_cheers from anon, authenticated;
alter publication supabase_realtime add table photo_cheers;

-- Photos are kept for a day. Anything older is deleted whenever someone sends, opens or lists photos.
create or replace function prune_photo_cheers() returns void language sql security definer set search_path = public as $$
  delete from photo_cheers where created_at < now_ms() - 86400000
$$;

create or replace function photo_cheer_json(p photo_cheers) returns jsonb language sql stable as $$
  select jsonb_build_object('id', p.id, 'senderId', p.sender_id, 'recipientId', p.recipient_id, 'image', p.image, 'caption', p.caption,
    'replyTo', p.reply_to, 'createdAt', p.created_at, 'seenAt', p.seen_at, 'heartedAt', p.hearted_at)
$$;

-- Your photos from the last day, sent and received, newest first.
create or replace function my_photo_cheers() returns jsonb language plpgsql security definer set search_path = public as $$
declare v_me uuid := me();
begin
  perform prune_photo_cheers();
  return coalesce((select jsonb_agg(photo_cheer_json(p) order by p.created_at desc) from photo_cheers p where v_me in (p.sender_id, p.recipient_id)), '[]');
end $$;

create or replace function send_photo_cheer(p_to uuid, p_image text, p_caption text default '', p_reply_to uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := me(); v_now bigint := now_ms(); p photo_cheers;
begin
  if not is_friend(v_me, p_to) then perform app_error('P0404', 'You can only send photos to friends.'); end if;
  if not pref_on(v_me, 'photoCheers') then perform app_error('P0400', 'Turn on Photo cheers in Settings → Motivation & focus first.'); end if;
  if not pref_on(p_to, 'photoCheers') then
    perform app_error('P0400', display_name_of(p_to) || ' hasn''t turned on Photo cheers yet.', '{"code": "PHOTOS_OFF"}');
  end if;
  if coalesce(p_image, '') not like 'data:image/jpeg;base64,%' or length(p_image) > 200000 then perform app_error('P0400', 'That photo couldn''t be sent. Try again?'); end if;
  if (select count(*) from photo_cheers where sender_id = v_me and created_at > v_now - 86400000) >= 50 then
    perform app_error('P0400', 'That''s a lot of photos for one day. Try again tomorrow. 📸');
  end if;
  if p_reply_to is not null and not exists (select 1 from photo_cheers where id = p_reply_to and sender_id = p_to and recipient_id = v_me) then
    p_reply_to := null;
  end if;
  perform prune_photo_cheers();
  insert into photo_cheers (sender_id, recipient_id, image, caption, reply_to, created_at)
  values (v_me, p_to, p_image, left(btrim(coalesce(p_caption, '')), 80), p_reply_to, v_now)
  returning * into p;
  begin
    perform send_push(push_recipients('pushEncourage', array[p_to]), '📸 ' || display_name_of(v_me) || ' sent you a photo',
      coalesce(nullif(p.caption, ''), 'Open the app to see it.'), '', 'photo');
  exception when others then null; -- a notification problem must never stop the photo
  end;
  return photo_cheer_json(p);
end $$;

-- The recipient saw it (it floated onto their timer, or they opened it from Home).
create or replace function seen_photo_cheer(p_id uuid) returns void language sql security definer set search_path = public as $$
  update photo_cheers set seen_at = now_ms() where id = p_id and recipient_id = auth.uid() and seen_at is null
$$;

-- 💗 back to the sender.
create or replace function heart_photo_cheer(p_id uuid) returns void language sql security definer set search_path = public as $$
  update photo_cheers set hearted_at = now_ms(), seen_at = coalesce(seen_at, now_ms()) where id = p_id and recipient_id = auth.uid() and hearted_at is null
$$;

revoke execute on function prune_photo_cheers() from public, anon, authenticated;
revoke execute on function photo_cheer_json(photo_cheers) from public, anon, authenticated;
revoke execute on function my_photo_cheers(), send_photo_cheer(uuid, text, text, uuid), seen_photo_cheer(uuid), heart_photo_cheer(uuid) from public, anon;
grant execute on function my_photo_cheers(), send_photo_cheer(uuid, text, text, uuid), seen_photo_cheer(uuid), heart_photo_cheer(uuid) to authenticated;
