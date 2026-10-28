// Rooms, topics and independent per-member topic progress.
import { all, get, newId, placeholders, run, transaction, type DB } from '../db.ts';
import { badRequest, conflict, forbidden, notFound } from '../http.ts';
import { localDate } from '../../shared/dates.ts';
import type { RoomDetail, RoomSummary, Topic, TopicHistoryEntry, TopicMemberProgress } from '../../shared/types.ts';
import {
  areFriends,
  getUser,
  getUsers,
  liveStatus,
  listActivity,
  recordActivity,
  requireOwnTopic,
  requireRoomMember,
  requireTopicAccess,
  roomMemberIds,
  toPublicUser,
  type RoomRow,
  type TopicRow,
} from './core.ts';
import { nextPlanTopic, nextPlanTopicAfter, roomSprints } from './plans.ts';

// ───────────── Rooms ─────────────

export function createRoom(
  db: DB,
  userId: string,
  input: { friendId: string; name: string; description?: string; startDate: string; endDate: string; color?: string },
): string {
  if (input.friendId === userId) throw badRequest('Choose a friend to share this room with.');
  if (!areFriends(db, userId, input.friendId)) throw forbidden('You can only create rooms with accepted friends.');
  return transaction(db, () => {
    const id = newId();
    const now = Date.now();
    run(
      db,
      'INSERT INTO rooms (id, name, description, start_date, end_date, color, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.name,
      input.description ?? '',
      input.startDate,
      input.endDate,
      input.color ?? 'sage',
      userId,
      now,
      now,
    );
    run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', id, userId, now);
    run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', id, input.friendId, now);
    recordActivity(db, { actorId: userId, type: 'room_created', roomId: id, refId: id });
    return id;
  });
}

export function updateRoom(db: DB, userId: string, roomId: string, input: Partial<{ name: string; description: string; startDate: string; endDate: string; color: string; status: 'active' | 'archived' }>) {
  const room = requireRoomMember(db, roomId, userId);
  const start = input.startDate ?? room.start_date;
  const end = input.endDate ?? room.end_date;
  if (end < start) throw badRequest('The end date must be after the start date.');
  run(
    db,
    'UPDATE rooms SET name = ?, description = ?, start_date = ?, end_date = ?, color = ?, status = ?, updated_at = ? WHERE id = ?',
    input.name ?? room.name,
    input.description ?? room.description,
    start,
    end,
    input.color ?? room.color,
    input.status ?? room.status,
    Date.now(),
    roomId,
  );
}

interface ProgressRow {
  topic_id: string;
  user_id: string;
  status: TopicMemberProgress['status'];
  completed_at: number | null;
}

/** Topics for the given rooms with each member's independent progress and recorded time. */
function loadTopics(db: DB, roomIds: string[], includeArchived: boolean): Topic[] {
  if (!roomIds.length) return [];
  const ph = placeholders(roomIds.length);
  const topics = all<TopicRow & { plan_task_id: string | null }>(
    db,
    `SELECT t.*, pt.id AS plan_task_id FROM topics t LEFT JOIN plan_tasks pt ON pt.topic_id = t.id AND pt.status = 'active'
      WHERE t.room_id IN (${ph}) ${includeArchived ? '' : "AND t.status = 'active'"} ORDER BY t.position, t.created_at`,
    ...roomIds,
  );
  if (!topics.length) return [];
  const progress = all<ProgressRow>(db, `SELECT p.* FROM topic_progress p JOIN topics t ON t.id = p.topic_id WHERE t.room_id IN (${ph})`, ...roomIds);
  const firsts = all<{ topic_id: string; user_id: string; completed_at: number }>(
    db,
    `SELECT c.topic_id, c.user_id, c.completed_at FROM topic_completions c JOIN topics t ON t.id = c.topic_id
      WHERE t.room_id IN (${ph}) AND c.kind = 'first' AND c.revoked_at IS NULL`,
    ...roomIds,
  );
  const time = all<{ topic_id: string; user_id: string; ms: number; n: number }>(
    db,
    `SELECT topic_id, user_id, SUM(focused_ms) AS ms, COUNT(*) AS n FROM study_sessions
      WHERE room_id IN (${ph}) AND state = 'finished' GROUP BY topic_id, user_id`,
    ...roomIds,
  );
  const key = (t: string, u: string) => `${t}:${u}`;
  const progressMap = new Map(progress.map((p) => [key(p.topic_id, p.user_id), p]));
  const firstMap = new Map(firsts.map((f) => [key(f.topic_id, f.user_id), f.completed_at]));
  const timeMap = new Map(time.map((t) => [key(t.topic_id, t.user_id), t]));

  return topics.map((t) => {
    // Progress is tracked for the topic's owner only.
    const prog: Record<string, TopicMemberProgress> = {};
    for (const uid of [t.created_by]) {
      const p = progressMap.get(key(t.id, uid));
      const tm = timeMap.get(key(t.id, uid));
      prog[uid] = {
        status: p?.status ?? 'not_started',
        completedAt: p?.completed_at ?? null,
        firstCompletedAt: firstMap.get(key(t.id, uid)) ?? null,
        focusedMs: tm?.ms ?? 0,
        sessions: tm?.n ?? 0,
      };
    }
    return {
      id: t.id,
      roomId: t.room_id,
      title: t.title,
      description: t.description,
      category: t.category,
      estimatedMinutes: t.estimated_minutes,
      sessionTargetMinutes: t.session_target_minutes,
      deadline: t.deadline,
      position: t.position,
      createdBy: t.created_by,
      planTaskId: t.plan_task_id,
      status: t.status,
      createdAt: t.created_at,
      progress: prog,
    };
  });
}

function isDone(p: TopicMemberProgress | undefined) {
  return Boolean(p && (p.status === 'completed' || p.firstCompletedAt));
}

function summarize(db: DB, viewerId: string, room: RoomRow, topics: Topic[]): RoomSummary {
  const memberIds = roomMemberIds(db, room.id);
  // The viewer first, then their partner, so "me" is always on the left.
  memberIds.sort((a, b) => (a === viewerId ? -1 : b === viewerId ? 1 : 0));
  const users = getUsers(db, memberIds);
  const active = topics.filter((t) => t.status === 'active');
  // Today's plan task comes first; otherwise the first of your open topics in this room.
  const mine = active.filter((t) => t.createdBy === viewerId);
  const next = nextPlanTopic(db, viewerId, room.id) ?? mine.find((t) => !t.planTaskId && (!isDone(t.progress[viewerId]) || t.progress[viewerId]?.status === 'revising'));
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    startDate: room.start_date,
    endDate: room.end_date,
    color: room.color,
    status: room.status,
    createdBy: room.creator_id,
    createdAt: room.created_at,
    members: memberIds.map((uid) => ({
      user: toPublicUser(users.get(uid)!),
      completed: active.filter((t) => t.createdBy === uid && isDone(t.progress[uid])).length,
      total: active.filter((t) => t.createdBy === uid).length,
      focusedMs: topics.reduce((sum, t) => sum + (t.progress[uid]?.focusedMs ?? 0), 0),
      status: liveStatus(db, viewerId, uid),
    })),
    nextTopic: next ? { id: next.id, title: next.title } : null,
  };
}

export function listRooms(db: DB, userId: string): RoomSummary[] {
  const rooms = all<RoomRow>(
    db,
    `SELECT r.* FROM rooms r JOIN room_members m ON m.room_id = r.id
      WHERE m.user_id = ? AND m.status = 'active' ORDER BY r.status, r.updated_at DESC`,
    userId,
  );
  const topics = loadTopics(db, rooms.map((r) => r.id), true);
  return rooms.map((r) => summarize(db, userId, r, topics.filter((t) => t.roomId === r.id)));
}

export function roomDetail(db: DB, userId: string, roomId: string): RoomDetail {
  const room = requireRoomMember(db, roomId, userId);
  const topics = loadTopics(db, [roomId], true);
  return {
    ...summarize(db, userId, room, topics),
    topics: topics.filter((t) => t.status === 'active'),
    archivedTopics: topics.filter((t) => t.status === 'archived'),
    activity: listActivity(db, userId, { roomId, limit: 15 }),
    sprints: roomSprints(db, roomId),
  };
}

// ───────────── Topics ─────────────

function topicEvent(db: DB, topicId: string, userId: string, type: string, detail: Record<string, unknown> = {}) {
  run(db, 'INSERT INTO topic_events (id, topic_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), topicId, userId, type, JSON.stringify(detail), Date.now());
}

export function ensureProgress(db: DB, topicId: string, userId: string) {
  run(db, "INSERT OR IGNORE INTO topic_progress (topic_id, user_id, status, updated_at) VALUES (?, ?, 'not_started', ?)", topicId, userId, Date.now());
}

export function createTopic(
  db: DB,
  userId: string,
  roomId: string,
  input: { title: string; description?: string; category?: string; estimatedMinutes?: number | null; sessionTargetMinutes?: number | null; deadline?: string | null },
): string {
  const room = requireRoomMember(db, roomId, userId);
  if (room.status === 'archived') throw badRequest('This room is archived. Reopen it to add topics.');
  return transaction(db, () => {
    const id = newId();
    const now = Date.now();
    const last = get<{ p: number | null }>(db, 'SELECT MAX(position) AS p FROM topics WHERE room_id = ?', roomId);
    run(
      db,
      `INSERT INTO topics (id, room_id, title, description, category, estimated_minutes, session_target_minutes, deadline, position, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      roomId,
      input.title,
      input.description ?? '',
      input.category ?? '',
      input.estimatedMinutes ?? null,
      input.sessionTargetMinutes ?? null,
      input.deadline ?? null,
      (last?.p ?? 0) + 1,
      userId,
      now,
      now,
    );
    ensureProgress(db, id, userId);
    topicEvent(db, id, userId, 'created', { title: input.title });
    return id;
  });
}

export function updateTopic(
  db: DB,
  userId: string,
  topicId: string,
  input: Partial<{ title: string; description: string; category: string; estimatedMinutes: number | null; sessionTargetMinutes: number | null; deadline: string | null; status: 'active' | 'archived' }>,
) {
  const { topic } = requireOwnTopic(db, topicId, userId);
  const changes: Record<string, unknown> = {};
  const next = {
    title: input.title ?? topic.title,
    description: input.description ?? topic.description,
    category: input.category ?? topic.category,
    estimated_minutes: input.estimatedMinutes !== undefined ? input.estimatedMinutes : topic.estimated_minutes,
    session_target_minutes: input.sessionTargetMinutes !== undefined ? input.sessionTargetMinutes : topic.session_target_minutes,
    deadline: input.deadline !== undefined ? input.deadline : topic.deadline,
    status: input.status ?? topic.status,
  };
  for (const [k, v] of Object.entries(next)) if ((topic as any)[k] !== v) changes[k] = { from: (topic as any)[k], to: v };
  if (!Object.keys(changes).length) return;
  transaction(db, () => {
    run(
      db,
      `UPDATE topics SET title = ?, description = ?, category = ?, estimated_minutes = ?, session_target_minutes = ?, deadline = ?, status = ?, updated_at = ? WHERE id = ?`,
      next.title,
      next.description,
      next.category,
      next.estimated_minutes,
      next.session_target_minutes,
      next.deadline,
      next.status,
      Date.now(),
      topicId,
    );
    const type = input.status && input.status !== topic.status ? (input.status === 'archived' ? 'archived' : 'restored') : 'edited';
    topicEvent(db, topicId, userId, type, changes);
  });
}

/** Archiving keeps every session, completion and event — topics are never hard-deleted. */
export function archiveTopic(db: DB, userId: string, topicId: string) {
  const { topic } = requireOwnTopic(db, topicId, userId);
  const active = get(db, "SELECT 1 FROM study_sessions WHERE topic_id = ? AND state IN ('running', 'paused')", topicId);
  if (active) throw conflict('Someone is studying this topic right now. Try again after their session.');
  if (topic.status !== 'archived') updateTopic(db, userId, topicId, { status: 'archived' });
}

export function reorderTopics(db: DB, userId: string, roomId: string, topicIds: string[]) {
  requireRoomMember(db, roomId, userId);
  // Reorders a group of your own topics (e.g. one goal's list) among the positions they already hold.
  const rows = topicIds.length
    ? all<{ id: string; position: number }>(
        db,
        `SELECT id, position FROM topics WHERE room_id = ? AND created_by = ? AND status = 'active' AND id IN (${placeholders(topicIds.length)})`,
        roomId,
        userId,
        ...topicIds,
      )
    : [];
  if (rows.length !== new Set(topicIds).size || rows.length !== topicIds.length) {
    throw badRequest('The topic list changed. Please refresh and try again.', 'STALE_ORDER');
  }
  const slots = rows.map((r) => r.position).sort((a, b) => a - b);
  transaction(db, () => {
    topicIds.forEach((id, i) => run(db, 'UPDATE topics SET position = ? WHERE id = ?', slots[i], id));
  });
}

/**
 * Marks a topic complete for this user only. Idempotent: completing an already-completed topic
 * changes nothing, so retries after a dropped connection never double count.
 */
export function completeTopic(db: DB, userId: string, topicId: string): { alreadyCompleted: boolean } {
  const { topic, room } = requireOwnTopic(db, topicId, userId);
  if (topic.status !== 'active') throw badRequest('This topic is archived.');
  return transaction(db, () => {
    ensureProgress(db, topicId, userId);
    const progress = get<{ status: string }>(db, 'SELECT status FROM topic_progress WHERE topic_id = ? AND user_id = ?', topicId, userId)!;
    if (progress.status === 'completed') return { alreadyCompleted: true };
    const now = Date.now();
    const hasFirst = get(db, "SELECT 1 FROM topic_completions WHERE topic_id = ? AND user_id = ? AND kind = 'first' AND revoked_at IS NULL", topicId, userId);
    const kind = hasFirst ? 'revision' : 'first';
    run(
      db,
      'INSERT INTO topic_completions (id, topic_id, user_id, kind, completed_at, local_date) VALUES (?, ?, ?, ?, ?, ?)',
      newId(),
      topicId,
      userId,
      kind,
      now,
      localDate(now, getUser(db, userId).timezone),
    );
    run(db, "UPDATE topic_progress SET status = 'completed', completed_at = ?, updated_at = ? WHERE topic_id = ? AND user_id = ?", now, now, topicId, userId);
    topicEvent(db, topicId, userId, kind === 'first' ? 'completed' : 'revision_completed');
    if (kind === 'first') recordActivity(db, { actorId: userId, type: 'topic_completed', roomId: room.id, refId: topicId });
    return { alreadyCompleted: false };
  });
}

/**
 * Reopen a completed topic.
 *  - 'revise': study it again; the original completion still counts toward goals.
 *  - 'undo':   it was marked complete by mistake; the completion is revoked (kept for audit).
 */
export function reopenTopic(db: DB, userId: string, topicId: string, mode: 'revise' | 'undo') {
  requireOwnTopic(db, topicId, userId);
  transaction(db, () => {
    ensureProgress(db, topicId, userId);
    const now = Date.now();
    if (mode === 'undo') {
      const last = get<{ id: string }>(db, 'SELECT id FROM topic_completions WHERE topic_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY completed_at DESC LIMIT 1', topicId, userId);
      if (!last) throw badRequest('This topic is not complete.');
      run(db, 'UPDATE topic_completions SET revoked_at = ? WHERE id = ?', now, last.id);
      const remaining = get(db, 'SELECT 1 FROM topic_completions WHERE topic_id = ? AND user_id = ? AND revoked_at IS NULL', topicId, userId);
      run(db, 'UPDATE topic_progress SET status = ?, completed_at = NULL, updated_at = ? WHERE topic_id = ? AND user_id = ?', remaining ? 'revising' : 'in_progress', now, topicId, userId);
      topicEvent(db, topicId, userId, 'completion_undone');
    } else {
      const p = get<{ status: string }>(db, 'SELECT status FROM topic_progress WHERE topic_id = ? AND user_id = ?', topicId, userId)!;
      if (p.status !== 'completed') return;
      run(db, "UPDATE topic_progress SET status = 'revising', updated_at = ? WHERE topic_id = ? AND user_id = ?", now, topicId, userId);
      topicEvent(db, topicId, userId, 'reopened_for_revision');
    }
  });
}

/**
 * What to study after `afterTopicId`. For a plan task: the next task that day, then the following
 * days. Otherwise the next of your own open topics in room order (wrapping around).
 */
export function nextIncompleteTopic(db: DB, userId: string, roomId: string, afterTopicId?: string): { id: string; title: string } | null {
  if (afterTopicId) {
    const fromPlan = nextPlanTopicAfter(db, userId, roomId, afterTopicId);
    if (fromPlan !== undefined) return fromPlan ?? nextIncompleteTopic(db, userId, roomId);
  } else {
    const fromPlan = nextPlanTopic(db, userId, roomId);
    if (fromPlan) return fromPlan;
  }
  const topics = all<{ id: string; title: string; status: string | null }>(
    db,
    `SELECT t.id, t.title, p.status FROM topics t
       LEFT JOIN topic_progress p ON p.topic_id = t.id AND p.user_id = ?
      WHERE t.room_id = ? AND t.created_by = ? AND t.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM plan_tasks pt WHERE pt.topic_id = t.id AND pt.status = 'active')
      ORDER BY t.position, t.created_at`,
    userId,
    roomId,
    userId,
  );
  const start = afterTopicId ? topics.findIndex((t) => t.id === afterTopicId) + 1 : 0;
  const ordered = [...topics.slice(start), ...topics.slice(0, start)];
  const next = ordered.find((t) => t.id !== afterTopicId && t.status !== 'completed');
  return next ? { id: next.id, title: next.title } : null;
}

export function topicHistory(db: DB, userId: string, topicId: string): { events: TopicHistoryEntry[]; sessions: { userId: string; startedAt: number; focusedMs: number; isRevision: boolean }[] } {
  const { room } = requireTopicAccess(db, topicId, userId);
  void room;
  const events = all<{ id: string; type: string; user_id: string; detail: string; created_at: number }>(
    db,
    'SELECT * FROM topic_events WHERE topic_id = ? ORDER BY created_at DESC LIMIT 100',
    topicId,
  ).map((e) => ({ id: e.id, type: e.type, userId: e.user_id, detail: JSON.parse(e.detail), createdAt: e.created_at }));
  // Room members share per-topic time; session notes stay private to their owner.
  const sessions = all<{ user_id: string; started_at: number; focused_ms: number; is_revision: number }>(
    db,
    "SELECT user_id, started_at, focused_ms, is_revision FROM study_sessions WHERE topic_id = ? AND state = 'finished' ORDER BY started_at DESC LIMIT 100",
    topicId,
  ).map((s) => ({ userId: s.user_id, startedAt: s.started_at, focusedMs: s.focused_ms, isRevision: Boolean(s.is_revision) }));
  return { events, sessions };
}

export function assertTopicInRoom(db: DB, topicId: string, roomId: string) {
  const t = get(db, 'SELECT 1 FROM topics WHERE id = ? AND room_id = ?', topicId, roomId);
  if (!t) throw notFound('That topic is not in this room.');
}
