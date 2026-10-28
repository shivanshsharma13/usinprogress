-- Goals now live inside a room, and topics are studied under a goal:
--   room → goal (yearly → monthly → weekly) → topics.
-- A goal's progress is simply how many of its topics are done.

ALTER TABLE goals ADD COLUMN room_id TEXT REFERENCES rooms(id);
ALTER TABLE topics ADD COLUMN goal_id TEXT REFERENCES goals(id);

-- Goals that were linked to a room (or to a topic in one) move into that room.
UPDATE goals SET room_id = COALESCE(
  (SELECT l.room_id FROM goal_links l WHERE l.goal_id = goals.id AND l.room_id IS NOT NULL LIMIT 1),
  (SELECT t.room_id FROM goal_links l JOIN topics t ON t.id = l.topic_id WHERE l.goal_id = goals.id LIMIT 1)
);

-- Unlinked goals follow their parent (two passes covers yearly → monthly → weekly), otherwise
-- they go into the owner's first room. Goals of people with no room stay without one.
UPDATE goals SET room_id = (SELECT p.room_id FROM goals p WHERE p.id = goals.parent_id) WHERE room_id IS NULL;
UPDATE goals SET room_id = (SELECT p.room_id FROM goals p WHERE p.id = goals.parent_id) WHERE room_id IS NULL;
UPDATE goals SET room_id = (
  SELECT m.room_id FROM room_members m JOIN rooms r ON r.id = m.room_id
   WHERE m.user_id = goals.owner_id AND m.status = 'active' ORDER BY r.created_at LIMIT 1
) WHERE room_id IS NULL;

-- Topics that were linked to their owner's goal now sit under it.
UPDATE topics SET goal_id = (
  SELECT l.goal_id FROM goal_links l JOIN goals g ON g.id = l.goal_id
   WHERE l.topic_id = topics.id AND g.owner_id = topics.created_by LIMIT 1
);

-- Undated checklist tasks inside a goal become topics under that goal (keeping their ids and done state).
INSERT INTO topics (id, room_id, title, description, position, created_by, goal_id, created_at, updated_at)
SELECT tk.id, g.room_id, tk.title, tk.description,
       (SELECT COALESCE(MAX(position), 0) FROM topics WHERE room_id = g.room_id) + ROW_NUMBER() OVER (PARTITION BY g.room_id ORDER BY tk.created_at),
       tk.owner_id, g.id, tk.created_at, tk.updated_at
  FROM tasks tk JOIN goals g ON g.id = tk.goal_id
 WHERE tk.status = 'active' AND tk.date IS NULL AND g.room_id IS NOT NULL;

INSERT INTO topic_progress (topic_id, user_id, status, completed_at, updated_at)
SELECT tk.id, tk.owner_id, CASE WHEN tk.completed_at IS NULL THEN 'not_started' ELSE 'completed' END, tk.completed_at, tk.updated_at
  FROM tasks tk JOIN topics t ON t.id = tk.id;

INSERT INTO topic_completions (id, topic_id, user_id, kind, completed_at, local_date)
SELECT lower(hex(randomblob(16))), tk.id, tk.owner_id, 'first', tk.completed_at, tk.completed_date
  FROM tasks tk JOIN topics t ON t.id = tk.id
 WHERE tk.completed_at IS NOT NULL;

UPDATE tasks SET status = 'archived' WHERE id IN (SELECT id FROM topics);
UPDATE tasks SET goal_id = NULL;

DROP TABLE goal_links;

CREATE INDEX goals_room ON goals(room_id);
CREATE INDEX topics_goal ON topics(goal_id);
