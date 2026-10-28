-- Us in Progress — initial schema.
-- All timestamps are integer milliseconds since the Unix epoch (server clock).
-- Calendar dates are 'YYYY-MM-DD' strings interpreted in the owner's time zone.

PRAGMA foreign_keys = ON;

-- ───────────────────────── Identity ─────────────────────────

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  profile_type  TEXT NOT NULL CHECK (profile_type IN ('engineer', 'doctor', 'custom')),
  accent        TEXT NOT NULL,                          -- identity colour key, see shared/theme.ts
  bio           TEXT NOT NULL DEFAULT '',
  avatar        TEXT NOT NULL DEFAULT '{}',             -- JSON: buddy customisation
  color_scheme  TEXT NOT NULL DEFAULT 'light' CHECK (color_scheme IN ('light', 'dark')),
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  share_status  INTEGER NOT NULL DEFAULT 1,             -- show live study status to friends
  created_at    INTEGER NOT NULL
);

-- Credentials live outside the application tables and are only touched by server/auth.ts.
CREATE TABLE auth_credentials (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash  TEXT NOT NULL,                         -- scrypt$N$r$p$salt$hash
  updated_at     INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash  TEXT PRIMARY KEY,                         -- sha256 of the cookie token
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

-- ───────────────────────── Friendship ─────────────────────────

CREATE TABLE friendships (
  id            TEXT PRIMARY KEY,
  requester_id  TEXT NOT NULL REFERENCES users(id),
  recipient_id  TEXT NOT NULL REFERENCES users(id),
  user_low      TEXT NOT NULL,                          -- min(requester, recipient)
  user_high     TEXT NOT NULL,                          -- max(requester, recipient)
  status        TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at    INTEGER NOT NULL,
  responded_at  INTEGER,
  CHECK (requester_id <> recipient_id)
);
-- At most one live (pending or accepted) relationship per pair, in either direction.
CREATE UNIQUE INDEX friendships_live_pair ON friendships(user_low, user_high)
  WHERE status IN ('pending', 'accepted');

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
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE room_members (
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user ON room_members(user_id);

-- A shared room has exactly two members in this version.
CREATE TRIGGER room_members_max_two BEFORE INSERT ON room_members
WHEN (SELECT COUNT(*) FROM room_members WHERE room_id = NEW.room_id) >= 2
BEGIN
  SELECT RAISE(ABORT, 'ROOM_FULL');
END;

CREATE TABLE topics (
  id                      TEXT PRIMARY KEY,
  room_id                 TEXT NOT NULL REFERENCES rooms(id),
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  category                TEXT NOT NULL DEFAULT '',
  estimated_minutes       INTEGER,
  session_target_minutes  INTEGER,
  deadline                TEXT,
  position                REAL NOT NULL,
  created_by              TEXT NOT NULL REFERENCES users(id),
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX topics_room ON topics(room_id, position);

-- One independent progress record per topic and member.
CREATE TABLE topic_progress (
  topic_id      TEXT NOT NULL REFERENCES topics(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'not_started'
                CHECK (status IN ('not_started', 'in_progress', 'completed', 'revising')),
  completed_at  INTEGER,                                -- latest completion
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (topic_id, user_id)
);

-- Single source of truth for completed topic work. Rows are never deleted; mistakes are revoked.
CREATE TABLE topic_completions (
  id            TEXT PRIMARY KEY,
  topic_id      TEXT NOT NULL REFERENCES topics(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('first', 'revision')),
  completed_at  INTEGER NOT NULL,
  local_date    TEXT NOT NULL,                          -- owner's calendar date at completion
  revoked_at    INTEGER
);
-- A topic can only be "first completed" once per member (prevents double counting).
CREATE UNIQUE INDEX topic_completions_first ON topic_completions(topic_id, user_id)
  WHERE kind = 'first' AND revoked_at IS NULL;

-- Audit trail: creation, edits, completion, reopening, archiving.
CREATE TABLE topic_events (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT NOT NULL REFERENCES topics(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
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
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  focused_ms          INTEGER,                          -- set when the session ends
  measured_ms         INTEGER,                          -- what the clock said, before any correction
  target_minutes      INTEGER,
  remind_after_hour   INTEGER NOT NULL DEFAULT 0,
  is_revision         INTEGER NOT NULL DEFAULT 0,
  note                TEXT NOT NULL DEFAULT '',         -- private to the owner
  local_date          TEXT NOT NULL,                    -- owner's calendar date at start
  created_at          INTEGER NOT NULL
);
-- Only one active (running or paused) session per user.
CREATE UNIQUE INDEX study_sessions_one_active ON study_sessions(user_id)
  WHERE state IN ('running', 'paused');
CREATE INDEX study_sessions_user_date ON study_sessions(user_id, local_date);
CREATE INDEX study_sessions_topic ON study_sessions(topic_id, user_id);

CREATE TABLE session_pauses (
  session_id  TEXT NOT NULL REFERENCES study_sessions(id),
  paused_at   INTEGER NOT NULL,
  resumed_at  INTEGER,
  PRIMARY KEY (session_id, paused_at)
);

-- Corrections never overwrite silently: every change of a recorded duration is logged here.
CREATE TABLE session_corrections (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES study_sessions(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  old_ms      INTEGER NOT NULL,
  new_ms      INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- ───────────────────────── Goals ─────────────────────────

CREATE TABLE goals (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  period       TEXT NOT NULL CHECK (period IN ('yearly', 'monthly', 'weekly', 'custom')),
  start_date   TEXT NOT NULL,
  deadline     TEXT NOT NULL,
  measure      TEXT NOT NULL CHECK (measure IN ('count', 'time', 'completion')),
  target       REAL,                                    -- count units, or minutes for 'time'
  unit         TEXT NOT NULL DEFAULT '',                -- e.g. "questions", "topics"
  parent_id    TEXT REFERENCES goals(id),
  visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'friends')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'archived')),
  done_at      INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX goals_owner ON goals(owner_id);

-- A goal can be linked to whole rooms or to individual topics.
CREATE TABLE goal_links (
  goal_id   TEXT NOT NULL REFERENCES goals(id),
  room_id   TEXT REFERENCES rooms(id),
  topic_id  TEXT REFERENCES topics(id),
  CHECK ((room_id IS NULL) <> (topic_id IS NULL))
);
CREATE UNIQUE INDEX goal_links_room ON goal_links(goal_id, room_id) WHERE room_id IS NOT NULL;
CREATE UNIQUE INDEX goal_links_topic ON goal_links(goal_id, topic_id) WHERE topic_id IS NOT NULL;

-- ───────────────────────── Tasks / calendar ─────────────────────────

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  date              TEXT NOT NULL,
  start_time        TEXT,                               -- 'HH:MM'
  duration_minutes  INTEGER,
  goal_id           TEXT REFERENCES goals(id),
  room_id           TEXT REFERENCES rooms(id),
  topic_id          TEXT REFERENCES topics(id),
  quantity          REAL NOT NULL DEFAULT 1,            -- contribution to a count goal
  shared            INTEGER NOT NULL DEFAULT 0,
  note              TEXT NOT NULL DEFAULT '',           -- private to the owner
  completed_at      INTEGER,
  completed_date    TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX tasks_owner_date ON tasks(owner_id, date);

CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
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
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);
CREATE INDEX activities_recipient ON activities(recipient_id, created_at);
CREATE INDEX activities_room ON activities(room_id, created_at);
CREATE INDEX activities_actor ON activities(actor_id, created_at);
