-- Optional features you switch on in Settings → Motivation & focus, saved to your account so they follow
-- you between devices. Each key is a feature name; a missing key means "off".
alter table profiles add column prefs jsonb not null default '{}' check (jsonb_typeof(prefs) = 'object');
grant update (prefs) on profiles to authenticated;

-- A friend's settings are only read by the database itself (e.g. who wants which notification).
create or replace function pref_on(p_user uuid, p_key text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (prefs ->> p_key)::boolean from profiles where id = p_user), false)
$$;
revoke execute on function pref_on(uuid, text) from public, anon, authenticated;
