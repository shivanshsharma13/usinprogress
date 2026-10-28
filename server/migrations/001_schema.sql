-- Us in Progress — Postgres schema (works on Supabase, any Postgres 14+, and PGlite).
-- All timestamps are BIGINT milliseconds since the Unix epoch (server clock).
-- Calendar dates are 'YYYY-MM-DD' text interpreted in the owner's time zone.
-- Booleans used as flags are stored as 0/1 integers.

-- ───────────────────────── Identity ─────────────────────────

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,                   -- always stored lowercase
  display_name  TEXT NOT NULL,
  profile_type  TEXT NOT NULL CHECK (profile_type IN ('engineer', 'doctor', 'custom')),
  accent        TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar        TEXT NOT NULL DEFAULT '{}',             -- JSON: buddy customisation
  color_scheme  TEXT NOT NULL DEFAULT 'light' CHECK (color_scheme IN ('light', 'dark')),
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  share_status  INTEGER NOT NULL DEFAULT 1,
  created_at    BIGINT NOT NULL,
  CHECK (username = lower(username))
);

-- Credentials live outside the application tables and are only touched by server/auth.ts.
CREATE TABLE auth_credentials (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash  TEXT NOT NULL,                         -- scrypt$N$r$p$salt$hash
  updated_at     BIGINT NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash  TEXT PRIMARY KEY,                         -- sha256 of the cookie token
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

-- ───────────────────────── Friendship ─────────────────────────

CREATE TABLE friendships (
  id            TEXT PRIMARY KEY,
  requester_id  TEXT NOT NULL REFERENCES users(id),
  recipient_id  TEXT NOT NULL REFERENCES users(id),
  user_low      TEXT NOT NULL,
  user_high     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at    BIGINT NOT NULL,
  responded_at  BIGINT,
  CHECK (requester_id <> recipient_id)
);
-- At most one live (pending or accepted) relationship per pair, in either direction.
CREATE UNIQUE INDEX friendships_live_pair ON friendships(user_low, user_high) WHERE status IN ('pending', 'accepted');

-- ───────────────────────── Rooms & topics ─────────────────────────

CREATE TABLE rooms (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT 'sage',
  creator_id   TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE TABLE room_members (
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  joined_at  BIGINT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user ON room_members(user_id);

-- A shared room has exactly two members.
CREATE FUNCTION room_members_max_two() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COUNT(*) FROM room_members WHERE room_id = NEW.room_id) >= 2 THEN
    RAISE EXCEPTION 'ROOM_FULL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER room_members_max_two BEFORE INSERT ON room_members FOR EACH ROW EXECUTE FUNCTION room_members_max_two();

CREATE TABLE topics (
  id                      TEXT PRIMARY KEY,
  room_id                 TEXT NOT NULL REFERENCES rooms(id),
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  category                TEXT NOT NULL DEFAULT '',
  estimated_minutes       INTEGER,
  session_target_minutes  INTEGER,
  deadline                TEXT,
  position                DOUBLE PRECISION NOT NULL,
  created_by              TEXT NOT NULL REFERENCES users(id),   -- the only person who can study or change it
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at              BIGINT NOT NULL,
  updated_at              BIGINT NOT NULL
);
CREATE INDEX topics_room ON topics(room_id, position);

CREATE TABLE topic_progress (
  topic_id      TEXT NOT NULL REFERENCES topics(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed', 'revising')),
  completed_at  BIGINT,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (topic_id, user_id)
);

-- Single source of truth for completed work. Rows are never deleted; mistakes are revoked.
CREATE TABLE topic_completions (
  id            TEXT PRIMARY KEY,
  topic_id      TEXT NOT NULL REFERENCES topics(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('first', 'revision')),
  completed_at  BIGINT NOT NULL,
  local_date    TEXT NOT NULL,
  revoked_at    BIGINT
);
CREATE UNIQUE INDEX topic_completions_first ON topic_completions(topic_id, user_id) WHERE kind = 'first' AND revoked_at IS NULL;

CREATE TABLE topic_events (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT NOT NULL REFERENCES topics(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  BIGINT NOT NULL
);
CREATE INDEX topic_events_topic ON topic_events(topic_id, created_at);

-- ───────────────────────── Study sessions ─────────────────────────

CREATE TABLE study_sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  room_id             TEXT NOT NULL REFERENCES rooms(id),
  topic_id            TEXT NOT NULL REFERENCES topics(id),
  task_id             TEXT,
  state               TEXT NOT NULL CHECK (state IN ('running', 'paused', 'finished', 'discarded')),
  started_at          BIGINT NOT NULL,
  ended_at            BIGINT,
  focused_ms          BIGINT,
  measured_ms         BIGINT,
  target_minutes      INTEGER,
  remind_after_hour   INTEGER NOT NULL DEFAULT 0,
  is_revision         INTEGER NOT NULL DEFAULT 0,
  note                TEXT NOT NULL DEFAULT '',
  local_date          TEXT NOT NULL,
  created_at          BIGINT NOT NULL
);
-- Only one active (running or paused) session per user.
CREATE UNIQUE INDEX study_sessions_one_active ON study_sessions(user_id) WHERE state IN ('running', 'paused');
CREATE INDEX study_sessions_user_date ON study_sessions(user_id, local_date);
CREATE INDEX study_sessions_topic ON study_sessions(topic_id, user_id);

CREATE TABLE session_pauses (
  session_id  TEXT NOT NULL REFERENCES study_sessions(id),
  paused_at   BIGINT NOT NULL,
  resumed_at  BIGINT,
  PRIMARY KEY (session_id, paused_at)
);

CREATE TABLE session_corrections (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES study_sessions(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  old_ms      BIGINT NOT NULL,
  new_ms      BIGINT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL
);

-- ───────────────────────── Goals: plan → sprints → days → tasks ─────────────────────────

CREATE TABLE plans (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  sprint_days  INTEGER NOT NULL CHECK (sprint_days BETWEEN 1 AND 60),   -- default length for new sprints
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);
CREATE INDEX plans_owner ON plans(owner_id);

CREATE TABLE plan_sprints (
  plan_id       TEXT NOT NULL REFERENCES plans(id),
  number        INTEGER NOT NULL,                       -- 1-based, consecutive, back to back
  days          INTEGER NOT NULL CHECK (days BETWEEN 1 AND 60),
  room_id       TEXT REFERENCES rooms(id),
  pulled_at     BIGINT,
  completed_at  BIGINT,
  PRIMARY KEY (plan_id, number)
);
CREATE INDEX plan_sprints_room ON plan_sprints(room_id);

CREATE TABLE plan_tasks (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  day          INTEGER,                                 -- 0-based day of the plan; NULL = in the backlog
  planned_day  INTEGER,                                 -- the day it was planned for (history)
  title        TEXT NOT NULL,
  est_minutes  INTEGER,
  position     DOUBLE PRECISION NOT NULL,
  starred      INTEGER NOT NULL DEFAULT 0,
  topic_id     TEXT REFERENCES topics(id),              -- set once its sprint is pulled into a room
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);
CREATE INDEX plan_tasks_plan_day ON plan_tasks(plan_id, day, position);
CREATE UNIQUE INDEX plan_tasks_topic ON plan_tasks(topic_id) WHERE topic_id IS NOT NULL;

-- ───────────────────────── Calendar tasks ─────────────────────────

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  date              TEXT NOT NULL,
  start_time        TEXT,
  duration_minutes  INTEGER,
  room_id           TEXT REFERENCES rooms(id),
  topic_id          TEXT REFERENCES topics(id),
  shared            INTEGER NOT NULL DEFAULT 0,
  note              TEXT NOT NULL DEFAULT '',            -- private to the owner
  completed_at      BIGINT,
  completed_date    TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);
CREATE INDEX tasks_owner_date ON tasks(owner_id, date);

CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  BIGINT NOT NULL
);

-- ───────────────────────── Activity & encouragement ─────────────────────────

CREATE TABLE activities (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES users(id),
  recipient_id  TEXT REFERENCES users(id),
  room_id       TEXT REFERENCES rooms(id),
  type          TEXT NOT NULL,
  ref_id        TEXT,
  reaction      TEXT,
  message       TEXT,
  created_at    BIGINT NOT NULL,
  read_at       BIGINT
);
CREATE INDEX activities_recipient ON activities(recipient_id, created_at);
CREATE INDEX activities_room ON activities(room_id, created_at);
CREATE INDEX activities_actor ON activities(actor_id, created_at);

-- The app talks to the database only from its own server with the connection string, never from the
-- browser. On Supabase, row-level security with no policies blocks the public Data API (anon /
-- authenticated keys) from these tables; the server's database role is unaffected.
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOREACH t IN ARRAY ARRAY['users','auth_credentials','auth_sessions','friendships','rooms','room_members','topics',
      'topic_progress','topic_completions','topic_events','study_sessions','session_pauses','session_corrections',
      'plans','plan_sprints','plan_tasks','tasks','task_events','activities','_migrations'] LOOP
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
  END IF;
END $$;
