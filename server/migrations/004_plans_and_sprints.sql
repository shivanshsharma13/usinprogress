-- Goals become personal plans split into sprints of days:  plan → sprints → days → tasks.
-- Days aren't stored: day N of a plan is start_date + N. A sprint is `sprint_days` consecutive days.
-- When a sprint is pulled into a shared room, each of its tasks gets a topic in that room, so the
-- timer, completions and the friend's view all work exactly as they do for any room topic.
--
-- The old room goals (`goals`, `topics.goal_id`) are no longer used; their topics stay in the room.

CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  start_date    TEXT NOT NULL,
  sprint_days   INTEGER NOT NULL CHECK (sprint_days BETWEEN 1 AND 60),
  sprint_count  INTEGER NOT NULL CHECK (sprint_count BETWEEN 1 AND 100),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX plans_owner ON plans(owner_id);

-- Only sprints that were pulled into a room or reviewed get a row.
CREATE TABLE plan_sprints (
  plan_id       TEXT NOT NULL REFERENCES plans(id),
  number        INTEGER NOT NULL,                       -- 1-based
  room_id       TEXT REFERENCES rooms(id),
  pulled_at     INTEGER,
  completed_at  INTEGER,                                -- set by "Review & complete"
  PRIMARY KEY (plan_id, number)
);
CREATE INDEX plan_sprints_room ON plan_sprints(room_id);

CREATE TABLE plan_tasks (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  day          INTEGER NOT NULL,                        -- 0-based day of the plan
  title        TEXT NOT NULL,
  est_minutes  INTEGER,
  position     REAL NOT NULL,
  starred      INTEGER NOT NULL DEFAULT 0,              -- on the revision list
  topic_id     TEXT REFERENCES topics(id),              -- set once its sprint is in a room
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX plan_tasks_plan_day ON plan_tasks(plan_id, day, position);
CREATE UNIQUE INDEX plan_tasks_topic ON plan_tasks(topic_id) WHERE topic_id IS NOT NULL;
