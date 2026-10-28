-- migrate:foreign-keys-off
-- 1. Sprints are added one at a time and each has its own length, so every sprint gets a row with
--    `days`; plans keep only a default length for new sprints.
-- 2. Backlog: a task's `day` can be NULL (parked in the backlog), and `planned_day` remembers the day
--    it was planned for, so past days keep an honest history after a task is rescheduled.
-- Tables are rebuilt (SQLite can't change NOT NULL / drop columns in place).

CREATE TABLE plans_new (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  sprint_days  INTEGER NOT NULL CHECK (sprint_days BETWEEN 1 AND 60),   -- default length for new sprints
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
INSERT INTO plans_new (id, owner_id, title, start_date, sprint_days, status, created_at, updated_at)
SELECT id, owner_id, title, start_date, sprint_days, status, created_at, updated_at FROM plans;

CREATE TABLE plan_sprints_new (
  plan_id       TEXT NOT NULL REFERENCES plans(id),
  number        INTEGER NOT NULL,                       -- 1-based, consecutive
  days          INTEGER NOT NULL CHECK (days BETWEEN 1 AND 60),
  room_id       TEXT REFERENCES rooms(id),
  pulled_at     INTEGER,
  completed_at  INTEGER,
  PRIMARY KEY (plan_id, number)
);
INSERT INTO plan_sprints_new (plan_id, number, days, room_id, pulled_at, completed_at)
SELECT s.plan_id, s.number, p.sprint_days, s.room_id, s.pulled_at, s.completed_at
  FROM plan_sprints s JOIN plans p ON p.id = s.plan_id WHERE s.number <= p.sprint_count;
-- Every sprint a plan already had now gets its own row.
WITH RECURSIVE n(plan_id, k, cnt, len) AS (
  SELECT id, 1, sprint_count, sprint_days FROM plans
  UNION ALL SELECT plan_id, k + 1, cnt, len FROM n WHERE k < cnt
)
INSERT OR IGNORE INTO plan_sprints_new (plan_id, number, days) SELECT plan_id, k, len FROM n;

CREATE TABLE plan_tasks_new (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  day          INTEGER,                                 -- 0-based day of the plan; NULL = in the backlog
  planned_day  INTEGER,                                 -- the day it was planned for (history)
  title        TEXT NOT NULL,
  est_minutes  INTEGER,
  position     REAL NOT NULL,
  starred      INTEGER NOT NULL DEFAULT 0,
  topic_id     TEXT REFERENCES topics(id),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
INSERT INTO plan_tasks_new (id, plan_id, day, planned_day, title, est_minutes, position, starred, topic_id, status, created_at, updated_at)
SELECT id, plan_id, day, day, title, est_minutes, position, starred, topic_id, status, created_at, updated_at FROM plan_tasks;

DROP TABLE plan_tasks;
DROP TABLE plan_sprints;
DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;
ALTER TABLE plan_sprints_new RENAME TO plan_sprints;
ALTER TABLE plan_tasks_new RENAME TO plan_tasks;

CREATE INDEX plans_owner ON plans(owner_id);
CREATE INDEX plan_sprints_room ON plan_sprints(room_id);
CREATE INDEX plan_tasks_plan_day ON plan_tasks(plan_id, day, position);
CREATE UNIQUE INDEX plan_tasks_topic ON plan_tasks(topic_id) WHERE topic_id IS NOT NULL;
