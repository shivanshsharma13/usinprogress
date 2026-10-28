-- migrate:foreign-keys-off
-- Tasks can now live inside a goal without being scheduled, so `date` becomes optional.
-- SQLite can't drop NOT NULL in place, so the table is rebuilt (official 12-step procedure;
-- the migration runner turns foreign keys off around it and runs foreign_key_check before commit).

CREATE TABLE tasks_new (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  date              TEXT,                               -- NULL = not scheduled on the calendar
  start_time        TEXT,
  duration_minutes  INTEGER,
  goal_id           TEXT REFERENCES goals(id),
  room_id           TEXT REFERENCES rooms(id),
  topic_id          TEXT REFERENCES topics(id),
  quantity          REAL NOT NULL DEFAULT 1,
  shared            INTEGER NOT NULL DEFAULT 0,
  note              TEXT NOT NULL DEFAULT '',
  completed_at      INTEGER,
  completed_date    TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

INSERT INTO tasks_new (id, owner_id, title, description, date, start_time, duration_minutes, goal_id, room_id, topic_id,
                       quantity, shared, note, completed_at, completed_date, status, created_at, updated_at)
SELECT id, owner_id, title, description, date, start_time, duration_minutes, goal_id, room_id, topic_id,
       quantity, shared, note, completed_at, completed_date, status, created_at, updated_at
  FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX tasks_owner_date ON tasks(owner_id, date);
CREATE INDEX tasks_goal ON tasks(goal_id);
