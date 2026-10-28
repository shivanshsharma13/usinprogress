// Goals live inside a room and belong to one person: room → goal (yearly → monthly → weekly) → topics.
//
// Progress is never stored. A goal's progress is the share of topics done in it and in every goal
// beneath it, counted from topic_completions (the single record of finished work). Each topic sits
// under at most one goal, so a completed topic counts once for its goal and once for each goal
// above it — never twice for the same goal. Marking a goal done shows it as 100%.
import { all, get, newId, placeholders, run, transaction, type DB } from '../db.ts';
import { badRequest, notFound } from '../http.ts';
import type { Goal } from '../../shared/types.ts';
import { myRoomIds, recordActivity, requireRoomMember } from './core.ts';

interface GoalRow {
  id: string;
  owner_id: string;
  room_id: string | null;
  room_name: string | null;
  title: string;
  description: string;
  period: Goal['period'];
  start_date: string;
  deadline: string;
  parent_id: string | null;
  status: Goal['status'];
  done_at: number | null;
}

const SELECT = 'SELECT g.*, r.name AS room_name FROM goals g LEFT JOIN rooms r ON r.id = g.room_id';

function descendants(goals: GoalRow[], rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) for (const g of goals) if (g.parent_id === out[i]) out.push(g.id);
  return out;
}

/** Goals of the given owners, with progress. `ownerGoals` must contain each owner's full goal tree. */
function toGoals(db: DB, rows: GoalRow[], ownerGoals: GoalRow[]): Goal[] {
  if (!rows.length) return [];
  const ids = ownerGoals.map((g) => g.id);
  const topics = all<{ goal_id: string; done: number }>(
    db,
    `SELECT t.goal_id,
            EXISTS (SELECT 1 FROM topic_completions c WHERE c.topic_id = t.id AND c.user_id = t.created_by
                     AND c.kind = 'first' AND c.revoked_at IS NULL) AS done
       FROM topics t WHERE t.status = 'active' AND t.goal_id IN (${placeholders(ids.length)})`,
    ...ids,
  );
  return rows.map((g) => {
    const subtree = new Set(descendants(ownerGoals, g.id));
    const mine = topics.filter((t) => subtree.has(t.goal_id));
    const done = mine.filter((t) => t.done).length;
    const total = mine.length;
    const percent = g.status === 'done' ? 100 : total ? Math.round((done / total) * 100) : 0;
    return {
      id: g.id,
      ownerId: g.owner_id,
      roomId: g.room_id,
      roomName: g.room_name,
      title: g.title,
      description: g.description,
      period: g.period,
      startDate: g.start_date,
      deadline: g.deadline,
      parentId: g.parent_id,
      status: g.status,
      doneAt: g.done_at,
      progress: { done, total, percent },
      childIds: ownerGoals.filter((c) => c.parent_id === g.id && c.status !== 'archived').map((c) => c.id),
    };
  });
}

function goalsOf(db: DB, ownerIds: string[]): GoalRow[] {
  if (!ownerIds.length) return [];
  return all<GoalRow>(db, `${SELECT} WHERE g.owner_id IN (${placeholders(ownerIds.length)}) ORDER BY g.start_date, g.created_at`, ...ownerIds);
}

export function listMyGoals(db: DB, userId: string): Goal[] {
  const goals = goalsOf(db, [userId]);
  return toGoals(db, goals, goals);
}

/** Both members' goals in a room — the room is where the two of you see each other's plans. */
export function listRoomGoals(db: DB, roomId: string, memberIds: string[]): Goal[] {
  const goals = goalsOf(db, memberIds);
  return toGoals(db, goals.filter((g) => g.room_id === roomId && g.status !== 'archived'), goals);
}

/** A friend's goals in rooms you share with them. */
export function listSharedGoals(db: DB, viewerId: string, ownerId: string): Goal[] {
  const shared = new Set(myRoomIds(db, viewerId));
  const goals = goalsOf(db, [ownerId]);
  return toGoals(db, goals.filter((g) => g.room_id && shared.has(g.room_id) && g.status !== 'archived'), goals);
}

function ownGoal(db: DB, userId: string, goalId: string): GoalRow {
  const g = get<GoalRow>(db, `${SELECT} WHERE g.id = ? AND g.owner_id = ?`, goalId, userId);
  if (!g) throw notFound('That goal could not be found.');
  return g;
}

/** A parent must be your own goal in the same room, and can't be the goal itself or one below it. */
function checkParent(db: DB, userId: string, goalId: string | null, roomId: string, parentId: string | null | undefined) {
  if (!parentId) return;
  const parent = ownGoal(db, userId, parentId);
  if (parent.room_id !== roomId) throw badRequest('A goal can only sit under another goal in the same room.');
  if (goalId && descendants(goalsOf(db, [userId]), goalId).includes(parentId)) throw badRequest('A goal cannot be placed under itself.');
}

interface GoalInput {
  roomId: string;
  title: string;
  description?: string;
  period: Goal['period'];
  startDate: string;
  deadline: string;
  parentId?: string | null;
}

export function createGoal(db: DB, userId: string, input: GoalInput): string {
  requireRoomMember(db, input.roomId, userId);
  if (input.deadline < input.startDate) throw badRequest('The deadline must be after the start date.');
  checkParent(db, userId, null, input.roomId, input.parentId);
  const id = newId();
  const now = Date.now();
  run(
    db,
    `INSERT INTO goals (id, owner_id, room_id, title, description, period, start_date, deadline, measure, parent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completion', ?, ?, ?)`,
    id,
    userId,
    input.roomId,
    input.title,
    input.description ?? '',
    input.period,
    input.startDate,
    input.deadline,
    input.parentId ?? null,
    now,
    now,
  );
  return id;
}

export function updateGoal(db: DB, userId: string, goalId: string, input: Partial<GoalInput> & { status?: Goal['status'] }) {
  const g = ownGoal(db, userId, goalId);
  const roomId = input.roomId ?? g.room_id;
  if (!roomId) throw badRequest('Choose a room for this goal.');
  if (roomId !== g.room_id) {
    // Only a goal without topics or smaller goals can move, so nothing ends up split across rooms.
    requireRoomMember(db, roomId, userId);
    const busy = get(db, "SELECT 1 FROM topics WHERE goal_id = ? AND status = 'active' UNION SELECT 1 FROM goals WHERE parent_id = ? AND status != 'archived'", goalId, goalId);
    if (busy) throw badRequest('This goal already has topics or smaller goals, so it stays in its room.');
  }
  const next = {
    title: input.title ?? g.title,
    description: input.description ?? g.description,
    period: input.period ?? g.period,
    startDate: input.startDate ?? g.start_date,
    deadline: input.deadline ?? g.deadline,
    parentId: input.parentId !== undefined ? input.parentId : roomId !== g.room_id ? null : g.parent_id,
    status: input.status ?? g.status,
  };
  if (next.deadline < next.startDate) throw badRequest('The deadline must be after the start date.');
  checkParent(db, userId, goalId, roomId, next.parentId);
  const now = Date.now();
  transaction(db, () => {
    run(
      db,
      `UPDATE goals SET room_id = ?, title = ?, description = ?, period = ?, start_date = ?, deadline = ?, parent_id = ?, status = ?, done_at = ?, updated_at = ?
        WHERE id = ?`,
      roomId,
      next.title,
      next.description,
      next.period,
      next.startDate,
      next.deadline,
      next.parentId,
      next.status,
      next.status === 'done' ? (g.done_at ?? now) : null,
      now,
      goalId,
    );
    if (next.status === 'done' && g.status !== 'done') recordActivity(db, { actorId: userId, type: 'goal_done', roomId, refId: goalId });
  });
}

/** Archiving keeps history: smaller goals and topics move up to this goal's parent. */
export function archiveGoal(db: DB, userId: string, goalId: string) {
  const g = ownGoal(db, userId, goalId);
  transaction(db, () => {
    run(db, "UPDATE goals SET status = 'archived', updated_at = ? WHERE id = ?", Date.now(), goalId);
    run(db, 'UPDATE goals SET parent_id = ? WHERE parent_id = ?', g.parent_id, goalId);
    run(db, 'UPDATE topics SET goal_id = ? WHERE goal_id = ?', g.parent_id, goalId);
  });
}

/** A topic can only go under one of its owner's goals in the topic's room. */
export function checkTopicGoal(db: DB, userId: string, roomId: string, goalId: string | null | undefined) {
  if (!goalId) return;
  const g = get<{ room_id: string; status: string }>(db, 'SELECT room_id, status FROM goals WHERE id = ? AND owner_id = ?', goalId, userId);
  if (!g || g.room_id !== roomId || g.status === 'archived') throw badRequest('Pick one of your goals in this room.');
}
