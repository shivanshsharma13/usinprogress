-- Us in Progress — Supabase schema: tables, helpers, row-level security, realtime.
--
-- The browser talks to Supabase directly. Reads go through row-level security (RLS) below; every write
-- goes through a SECURITY DEFINER function in the next migration, which checks auth.uid() and runs
-- atomically. Tables have no INSERT/UPDATE/DELETE policies except where noted, so those functions are
-- the only way to change data.
--
-- Timestamps are BIGINT milliseconds since the Unix epoch (database clock). Calendar dates are
-- 'YYYY-MM-DD' text in the owner's time zone.

-- ───────────────────────── Helpers ─────────────────────────

create or replace function now_ms() returns bigint language sql volatile as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint
$$;

-- Raise an error the client maps to an HTTP-like status: P0400 bad request, P0403 forbidden,
-- P0404 not found, P0409 conflict. `detail` may carry JSON for the client.
create or replace function app_error(code text, msg text, detail text default '') returns void language plpgsql as $$
begin
  raise exception using errcode = code, message = msg, detail = detail;
end $$;

-- ───────────────────────── Identity ─────────────────────────

create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text not null unique check (username ~ '^[a-z0-9_.]{3,24}$'),
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 40),
  profile_type  text not null check (profile_type in ('engineer', 'doctor', 'custom')),
  accent        text not null check (accent in ('blue', 'pink', 'lavender', 'sage', 'peach')),
  bio           text not null default '' check (char_length(bio) <= 200),
  avatar        jsonb not null default '{}',
  color_scheme  text not null default 'light' check (color_scheme in ('light', 'dark')),
  timezone      text not null default 'UTC',
  share_status  boolean not null default true,
  created_at    bigint not null default now_ms()
);

-- Time zones must be real ones (used for "today").
create or replace function check_timezone() returns trigger language plpgsql as $$
begin
  perform now() at time zone new.timezone;
  return new;
exception when others then
  raise exception using errcode = 'P0400', message = 'Unknown time zone.';
end $$;
create trigger profiles_timezone before insert or update of timezone on profiles for each row execute function check_timezone();

create or replace function local_date(p_user uuid, p_ms bigint) returns text language sql stable security definer set search_path = public as $$
  select to_char(to_timestamp(p_ms / 1000.0) at time zone coalesce((select timezone from profiles where id = p_user), 'UTC'), 'YYYY-MM-DD')
$$;

create or replace function today_for(p_user uuid) returns text language sql volatile security definer set search_path = public as $$
  select local_date(p_user, now_ms())
$$;

-- ───────────────────────── Friendship ─────────────────────────

create table friendships (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references profiles(id),
  recipient_id  uuid not null references profiles(id),
  user_low      uuid not null,
  user_high     uuid not null,
  status        text not null check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at    bigint not null,
  responded_at  bigint,
  check (requester_id <> recipient_id)
);
create unique index friendships_live_pair on friendships(user_low, user_high) where status in ('pending', 'accepted');

create or replace function is_friend(a uuid, b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from friendships where user_low = least(a, b) and user_high = greatest(a, b) and status = 'accepted')
$$;

-- ───────────────────────── Rooms & topics ─────────────────────────

create table rooms (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  description  text not null default '' check (char_length(description) <= 300),
  start_date   text not null,
  end_date     text not null,
  color        text not null default 'sage' check (color in ('blue', 'pink', 'lavender', 'sage', 'peach')),
  creator_id   uuid not null references profiles(id),
  status       text not null default 'active' check (status in ('active', 'archived')),
  created_at   bigint not null,
  updated_at   bigint not null,
  check (end_date >= start_date)
);

create table room_members (
  room_id    uuid not null references rooms(id),
  user_id    uuid not null references profiles(id),
  status     text not null default 'active' check (status in ('active', 'left')),
  joined_at  bigint not null,
  primary key (room_id, user_id)
);
create index room_members_user on room_members(user_id);

create or replace function room_members_max_two() returns trigger language plpgsql as $$
begin
  if (select count(*) from room_members where room_id = new.room_id) >= 2 then
    raise exception 'ROOM_FULL';
  end if;
  return new;
end $$;
create trigger room_members_max_two before insert on room_members for each row execute function room_members_max_two();

-- SECURITY DEFINER so RLS policies can use it without recursing into room_members' own policy.
create or replace function is_room_member(p_room uuid, p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from room_members where room_id = p_room and user_id = p_user and status = 'active')
$$;

create table topics (
  id                      uuid primary key default gen_random_uuid(),
  room_id                 uuid not null references rooms(id),
  title                   text not null check (char_length(btrim(title)) between 1 and 140),
  description             text not null default '' check (char_length(description) <= 1000),
  category                text not null default '' check (char_length(category) <= 60),
  estimated_minutes       integer check (estimated_minutes between 1 and 100000),
  session_target_minutes  integer check (session_target_minutes between 1 and 600),
  deadline                text,
  position                double precision not null,
  created_by              uuid not null references profiles(id),   -- the only person who can study or change it
  status                  text not null default 'active' check (status in ('active', 'archived')),
  created_at              bigint not null,
  updated_at              bigint not null
);
create index topics_room on topics(room_id, position);

create or replace function topic_room(p_topic uuid) returns uuid language sql stable security definer set search_path = public as $$
  select room_id from topics where id = p_topic
$$;

create table topic_progress (
  topic_id      uuid not null references topics(id),
  user_id       uuid not null references profiles(id),
  status        text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed', 'revising')),
  completed_at  bigint,
  updated_at    bigint not null,
  primary key (topic_id, user_id)
);

-- Single source of truth for completed work. Never deleted; mistakes are revoked.
create table topic_completions (
  id            uuid primary key default gen_random_uuid(),
  topic_id      uuid not null references topics(id),
  user_id       uuid not null references profiles(id),
  kind          text not null check (kind in ('first', 'revision')),
  completed_at  bigint not null,
  local_date    text not null,
  revoked_at    bigint
);
create unique index topic_completions_first on topic_completions(topic_id, user_id) where kind = 'first' and revoked_at is null;

create table topic_events (
  id          uuid primary key default gen_random_uuid(),
  topic_id    uuid not null references topics(id),
  user_id     uuid not null references profiles(id),
  type        text not null,
  detail      jsonb not null default '{}',
  created_at  bigint not null
);
create index topic_events_topic on topic_events(topic_id, created_at);

-- ───────────────────────── Study sessions ─────────────────────────

create table study_sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references profiles(id),
  room_id            uuid not null references rooms(id),
  topic_id           uuid not null references topics(id),
  task_id            uuid,
  state              text not null check (state in ('running', 'paused', 'finished', 'discarded')),
  started_at         bigint not null,
  ended_at           bigint,
  focused_ms         bigint,
  measured_ms        bigint,
  target_minutes     integer,
  remind_after_hour  boolean not null default false,
  is_revision        boolean not null default false,
  note               text not null default '',   -- private: sessions are only readable by their owner
  local_date         text not null,
  created_at         bigint not null
);
create unique index study_sessions_one_active on study_sessions(user_id) where state in ('running', 'paused');
create index study_sessions_user_date on study_sessions(user_id, local_date);
create index study_sessions_topic on study_sessions(topic_id, user_id);

create table session_pauses (
  session_id  uuid not null references study_sessions(id),
  paused_at   bigint not null,
  resumed_at  bigint,
  primary key (session_id, paused_at)
);

create table session_corrections (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references study_sessions(id),
  user_id     uuid not null references profiles(id),
  old_ms      bigint not null,
  new_ms      bigint not null,
  reason      text not null default '',
  created_at  bigint not null
);

-- A tiny row per person, touched whenever their study status or progress changes. Friends and room
-- partners can read it, so Supabase Realtime tells them to refresh without exposing session rows.
create table presence (
  user_id     uuid primary key references profiles(id) on delete cascade,
  updated_at  bigint not null
);

-- ───────────────────────── Goals: plan → sprints → days → tasks ─────────────────────────

create table plans (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references profiles(id),
  title        text not null check (char_length(btrim(title)) between 1 and 140),
  start_date   text not null,
  sprint_days  integer not null check (sprint_days between 1 and 60),
  status       text not null default 'active' check (status in ('active', 'archived')),
  created_at   bigint not null,
  updated_at   bigint not null
);
create index plans_owner on plans(owner_id);

create table plan_sprints (
  plan_id       uuid not null references plans(id),
  number        integer not null,
  days          integer not null check (days between 1 and 60),
  room_id       uuid references rooms(id),
  pulled_at     bigint,
  completed_at  bigint,
  primary key (plan_id, number)
);
create index plan_sprints_room on plan_sprints(room_id);

create table plan_tasks (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references plans(id),
  day          integer,                  -- 0-based day of the plan; NULL = in the backlog
  planned_day  integer,                  -- the day it was planned for (history)
  title        text not null check (char_length(btrim(title)) between 1 and 140),
  est_minutes  integer check (est_minutes between 1 and 1440),
  position     double precision not null,
  starred      boolean not null default false,
  topic_id     uuid references topics(id),
  status       text not null default 'active' check (status in ('active', 'archived')),
  created_at   bigint not null,
  updated_at   bigint not null
);
create index plan_tasks_plan_day on plan_tasks(plan_id, day, position);
create unique index plan_tasks_topic on plan_tasks(topic_id) where topic_id is not null;

-- Sprints run back to back: each one's first/last plan day.
create or replace function plan_spans(p_plan uuid)
returns table (number integer, days integer, room_id uuid, completed_at bigint, first_day integer, last_day integer)
language sql stable security definer set search_path = public as $$
  select s.number, s.days, s.room_id, s.completed_at,
         (sum(s.days) over (order by s.number) - s.days)::integer,
         (sum(s.days) over (order by s.number) - 1)::integer
    from plan_sprints s where s.plan_id = p_plan order by s.number
$$;

-- A friend may see a plan's tasks only on days inside an open sprint pulled into a room they share.
create or replace function plan_day_shared(p_plan uuid, p_day integer) returns boolean
language sql stable security definer set search_path = public as $$
  select p_day is not null and exists (
    select 1 from plan_spans(p_plan) s
     where p_day between s.first_day and s.last_day and s.room_id is not null and s.completed_at is null
       and is_room_member(s.room_id))
$$;

create or replace function plan_owner(p_plan uuid) returns uuid language sql stable security definer set search_path = public as $$
  select owner_id from plans where id = p_plan
$$;

-- ───────────────────────── Calendar tasks ─────────────────────────

create table tasks (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references profiles(id),
  title             text not null check (char_length(btrim(title)) between 1 and 140),
  description       text not null default '' check (char_length(description) <= 1000),
  date              text not null,
  start_time        text,
  duration_minutes  integer,
  room_id           uuid references rooms(id),
  topic_id          uuid references topics(id),
  shared            boolean not null default false,
  completed_at      bigint,
  completed_date    text,
  status            text not null default 'active' check (status in ('active', 'archived')),
  created_at        bigint not null,
  updated_at        bigint not null
);
create index tasks_owner_date on tasks(owner_id, date);

-- Private notes live apart from shared tasks so friends can never read them.
create table task_notes (
  task_id   uuid primary key references tasks(id),
  owner_id  uuid not null references profiles(id),
  note      text not null default '' check (char_length(note) <= 1000)
);

create table task_events (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id),
  user_id     uuid not null references profiles(id),
  type        text not null,
  detail      jsonb not null default '{}',
  created_at  bigint not null
);

-- ───────────────────────── Activity & encouragement ─────────────────────────

create table activities (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid not null references profiles(id),
  recipient_id  uuid references profiles(id),
  room_id       uuid references rooms(id),
  type          text not null,
  ref_id        uuid,
  reaction      text,
  message       text check (char_length(message) <= 280),
  created_at    bigint not null,
  read_at       bigint
);
create index activities_recipient on activities(recipient_id, created_at);
create index activities_room on activities(room_id, created_at);
create index activities_actor on activities(actor_id, created_at);

-- ───────────────────────── Row-level security (reads) ─────────────────────────

alter table profiles enable row level security;
alter table friendships enable row level security;
alter table rooms enable row level security;
alter table room_members enable row level security;
alter table topics enable row level security;
alter table topic_progress enable row level security;
alter table topic_completions enable row level security;
alter table topic_events enable row level security;
alter table study_sessions enable row level security;
alter table session_pauses enable row level security;
alter table session_corrections enable row level security;
alter table presence enable row level security;
alter table plans enable row level security;
alter table plan_sprints enable row level security;
alter table plan_tasks enable row level security;
alter table tasks enable row level security;
alter table task_notes enable row level security;
alter table task_events enable row level security;
alter table activities enable row level security;

-- Profiles hold no secrets (no email, no password), so signed-in people can find each other by username.
create policy profiles_read on profiles for select to authenticated using (true);
create policy profiles_update_own on profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy friendships_read on friendships for select to authenticated using (auth.uid() in (requester_id, recipient_id));

create policy rooms_read on rooms for select to authenticated using (is_room_member(id));
create policy rooms_update on rooms for update to authenticated using (is_room_member(id)) with check (is_room_member(id));
create policy room_members_read on room_members for select to authenticated using (is_room_member(room_id));

create policy topics_read on topics for select to authenticated using (is_room_member(room_id));
create policy topic_progress_read on topic_progress for select to authenticated using (is_room_member(topic_room(topic_id)));
create policy topic_completions_read on topic_completions for select to authenticated using (is_room_member(topic_room(topic_id)));
create policy topic_events_read on topic_events for select to authenticated using (is_room_member(topic_room(topic_id)));

-- Session history (and its private notes) is the owner's alone; friends get live status via functions.
create policy sessions_read_own on study_sessions for select to authenticated using (user_id = auth.uid());
create policy pauses_read_own on session_pauses for select to authenticated
  using (exists (select 1 from study_sessions s where s.id = session_id and s.user_id = auth.uid()));
create policy corrections_read_own on session_corrections for select to authenticated using (user_id = auth.uid());

create policy presence_read on presence for select to authenticated using (
  user_id = auth.uid() or is_friend(user_id, auth.uid())
  or exists (select 1 from room_members a join room_members b on a.room_id = b.room_id
              where a.user_id = auth.uid() and b.user_id = presence.user_id and a.status = 'active' and b.status = 'active'));

create policy plans_read on plans for select to authenticated using (
  owner_id = auth.uid()
  or exists (select 1 from plan_sprints s where s.plan_id = id and s.room_id is not null and s.completed_at is null and is_room_member(s.room_id)));
create policy plan_sprints_read on plan_sprints for select to authenticated using (
  plan_owner(plan_id) = auth.uid() or (room_id is not null and completed_at is null and is_room_member(room_id)));
create policy plan_tasks_read on plan_tasks for select to authenticated using (
  plan_owner(plan_id) = auth.uid() or (status = 'active' and (plan_day_shared(plan_id, day) or plan_day_shared(plan_id, planned_day))));

create policy tasks_read on tasks for select to authenticated using (owner_id = auth.uid() or (shared and is_friend(owner_id, auth.uid())));
create policy task_notes_read_own on task_notes for select to authenticated using (owner_id = auth.uid());
create policy task_events_read_own on task_events for select to authenticated using (user_id = auth.uid());

create policy activities_read on activities for select to authenticated using (
  actor_id = auth.uid() or recipient_id = auth.uid() or (room_id is not null and is_room_member(room_id)));

-- Column-level limits on the two direct-update policies.
revoke update on profiles from authenticated, anon;
grant update (display_name, profile_type, accent, bio, avatar, color_scheme, timezone, share_status) on profiles to authenticated;
revoke update on rooms from authenticated, anon;
grant update (name, description, start_date, end_date, color, status, updated_at) on rooms to authenticated;
-- Nothing else is writable directly.
revoke insert, delete on all tables in schema public from anon, authenticated;
revoke update on friendships, room_members, topics, topic_progress, topic_completions, topic_events, study_sessions,
  session_pauses, session_corrections, presence, plans, plan_sprints, plan_tasks, tasks, task_notes, task_events, activities
  from anon, authenticated;
revoke all on all tables in schema public from anon;

-- ───────────────────────── Realtime ─────────────────────────
-- Realtime delivers a change only to subscribers whose RLS lets them read the row.

alter publication supabase_realtime add table presence, friendships, rooms, room_members, topics, topic_progress,
  topic_completions, plans, plan_sprints, plan_tasks, tasks, activities;
