// Goals and automatic progress.
//
// Single source of truth: progress is never stored on goals. It is computed from the durable
// work records (topic_completions, completed tasks, finished study_sessions) each time.
//
// Counting rule (documented in README):
//  * A goal's progress = the DISTINCT work items covered by the goal itself or any of its
//    descendants, owned by the goal's owner, dated inside the goal's own start..deadline window.
//  * Because ancestors take the union of their subtree's items, one completed topic counts once
//    for the weekly goal, once for the monthly goal and once for the yearly goal — never three
//    times for any one of them.
//  * Allocation rule: a room or topic may only be linked to goals of the same owner whose
//    periods overlap if those goals are on one ancestor chain. Unrelated, overlapping goals cannot
//    both claim the same work, which prevents duplicate counting.
//  * count goals: each completed topic = 1, each completed task = its quantity (tasks count only
//    toward the goal they are explicitly assigned to, and that goal's ancestors).
//  * time goals: minutes of finished focus sessions on covered topics/rooms (or started from a
//    task assigned to the goal).
//  * completion goals: 1 when the owner marks the goal done, otherwise 0.
import { all, get, newId, placeholders, run, transaction, type DB } from '../db.ts';
import { badRequest, forbidden, notFound } from '../http.ts';
import type { Goal, GoalProgress } from '../../shared/types.ts';
import { areFriends, myRoomIds, recordActivity } from './core.ts';

interface GoalRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  period: Goal['period'];
  start_date: string;
  deadline: string;
  measure: Goal['measure'];
  target: number | null;
  unit: string;
  parent_id: string | null;
  visibility: Goal['visibility'];
  status: Goal['status'];
  done_at: number | null;
  created_at: number;
}

interface LinkRow {
  goal_id: string;
  room_id: string | null;
  topic_id: string | null;
  label: string;
}

function ownerGoals(db: DB, ownerId: string): GoalRow[] {
  return all<GoalRow>(db, 'SELECT * FROM goals WHERE owner_id = ? ORDER BY start_date, created_at', ownerId);
}

function linksFor(db: DB, goalIds: string[]): LinkRow[] {
  if (!goalIds.length) return [];
  return all<LinkRow>(
    db,
    `SELECT l.goal_id, l.room_id, l.topic_id, COALESCE(r.name, t.title) AS label
       FROM goal_links l LEFT JOIN rooms r ON r.id = l.room_id LEFT JOIN topics t ON t.id = l.topic_id
      WHERE l.goal_id IN (${placeholders(goalIds.length)})`,
    ...goalIds,
  );
}

function descendants(goals: GoalRow[], rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) for (const g of goals) if (g.parent_id === out[i]) out.push(g.id);
  return out;
}

function ancestors(goals: GoalRow[], id: string): string[] {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const out: string[] = [];
  let cur = byId.get(id)?.parent_id;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = byId.get(cur)?.parent_id;
  }
  return out;
}

/** Computes progress for every goal of one owner in a few queries. */
function computeProgress(db: DB, ownerId: string, goals: GoalRow[], links: LinkRow[]): Map<string, GoalProgress> {
  const completions = all<{ topic_id: string; room_id: string; local_date: string }>(
    db,
    `SELECT c.topic_id, t.room_id, c.local_date FROM topic_completions c JOIN topics t ON t.id = c.topic_id
      WHERE c.user_id = ? AND c.kind = 'first' AND c.revoked_at IS NULL`,
    ownerId,
  );
  const tasks = all<{ id: string; goal_id: string; quantity: number; completed_date: string }>(
    db,
    "SELECT id, goal_id, quantity, completed_date FROM tasks WHERE owner_id = ? AND goal_id IS NOT NULL AND completed_at IS NOT NULL AND status = 'active'",
    ownerId,
  );
  const sessions = all<{ id: string; topic_id: string; room_id: string; task_goal: string | null; local_date: string; focused_ms: number }>(
    db,
    `SELECT s.id, s.topic_id, s.room_id, tk.goal_id AS task_goal, s.local_date, s.focused_ms FROM study_sessions s
       LEFT JOIN tasks tk ON tk.id = s.task_id
      WHERE s.user_id = ? AND s.state = 'finished'`,
    ownerId,
  );

  const result = new Map<string, GoalProgress>();
  for (const goal of goals) {
    const subtree = new Set(descendants(goals, goal.id));
    const rooms = new Set<string>();
    const topics = new Set<string>();
    for (const l of links) {
      if (!subtree.has(l.goal_id)) continue;
      if (l.room_id) rooms.add(l.room_id);
      if (l.topic_id) topics.add(l.topic_id);
    }
    const inWindow = (d: string | null) => Boolean(d) && d! >= goal.start_date && d! <= goal.deadline;
    const covers = (topicId: string, roomId: string) => topics.has(topicId) || rooms.has(roomId);

    if (goal.measure === 'completion') {
      const done = goal.status === 'done' ? 1 : 0;
      result.set(goal.id, { value: done, target: 1, percent: done * 100, items: done });
      continue;
    }
    if (goal.measure === 'count') {
      const topicItems = new Set(completions.filter((c) => inWindow(c.local_date) && covers(c.topic_id, c.room_id)).map((c) => c.topic_id));
      const taskItems = tasks.filter((t) => subtree.has(t.goal_id) && inWindow(t.completed_date));
      const value = topicItems.size + taskItems.reduce((sum, t) => sum + t.quantity, 0);
      result.set(goal.id, {
        value,
        target: goal.target,
        percent: goal.target ? Math.min(100, Math.round((value / goal.target) * 100)) : null,
        items: topicItems.size + taskItems.length,
      });
      continue;
    }
    // time
    const eligible = sessions.filter((s) => inWindow(s.local_date) && (covers(s.topic_id, s.room_id) || (s.task_goal && subtree.has(s.task_goal))));
    const minutes = Math.round(eligible.reduce((sum, s) => sum + s.focused_ms, 0) / 60_000);
    result.set(goal.id, {
      value: minutes,
      target: goal.target,
      percent: goal.target ? Math.min(100, Math.round((minutes / goal.target) * 100)) : null,
      items: eligible.length,
    });
  }
  return result;
}

function toGoals(db: DB, ownerId: string, rows: GoalRow[], allOwnerGoals: GoalRow[]): Goal[] {
  const links = linksFor(db, allOwnerGoals.map((g) => g.id));
  const progress = computeProgress(db, ownerId, allOwnerGoals, links);
  return rows.map((g) => ({
    id: g.id,
    ownerId: g.owner_id,
    title: g.title,
    description: g.description,
    period: g.period,
    startDate: g.start_date,
    deadline: g.deadline,
    measure: g.measure,
    target: g.target,
    unit: g.unit,
    parentId: g.parent_id,
    visibility: g.visibility,
    status: g.status,
    doneAt: g.done_at,
    links: links.filter((l) => l.goal_id === g.id).map((l) => ({ roomId: l.room_id ?? undefined, topicId: l.topic_id ?? undefined, label: l.label ?? '' })),
    progress: progress.get(g.id)!,
    childIds: allOwnerGoals.filter((c) => c.parent_id === g.id).map((c) => c.id),
  }));
}

export function listMyGoals(db: DB, userId: string): Goal[] {
  const goals = ownerGoals(db, userId);
  return toGoals(db, userId, goals, goals);
}

/** A friend's goals that they chose to share. Progress is still computed from their records. */
export function listSharedGoals(db: DB, viewerId: string, ownerId: string): Goal[] {
  if (!areFriends(db, viewerId, ownerId)) throw forbidden();
  const goals = ownerGoals(db, ownerId);
  const shared = goals.filter((g) => g.visibility === 'friends' && g.status !== 'archived');
  // Links to rooms the viewer is not in are hidden from the label list.
  const rooms = new Set(myRoomIds(db, viewerId));
  return toGoals(db, ownerId, shared, goals).map((g) => ({
    ...g,
    description: g.description,
    links: g.links.filter((l) => {
      if (l.roomId) return rooms.has(l.roomId);
      const t = get<{ room_id: string }>(db, 'SELECT room_id FROM topics WHERE id = ?', l.topicId!);
      return t ? rooms.has(t.room_id) : false;
    }),
    childIds: g.childIds.filter((id) => shared.some((s) => s.id === id)),
    parentId: shared.some((s) => s.id === g.parentId) ? g.parentId : null,
  }));
}

function ownGoal(db: DB, userId: string, goalId: string): GoalRow {
  const g = get<GoalRow>(db, 'SELECT * FROM goals WHERE id = ? AND owner_id = ?', goalId, userId);
  if (!g) throw notFound('That goal could not be found.');
  return g;
}

/** Validate room/topic links: the owner must be a member, and the allocation rule must hold. */
function validateLinks(db: DB, userId: string, goalId: string, startDate: string, deadline: string, roomIds: string[], topicIds: string[]) {
  const myRooms = new Set(myRoomIds(db, userId));
  for (const r of roomIds) if (!myRooms.has(r)) throw badRequest('You can only link rooms you belong to.');
  const topicRooms = new Map<string, string>();
  for (const t of topicIds) {
    const row = get<{ room_id: string }>(db, 'SELECT room_id FROM topics WHERE id = ?', t);
    if (!row || !myRooms.has(row.room_id)) throw badRequest('You can only link topics from your rooms.');
    topicRooms.set(t, row.room_id);
  }

  // The goal being saved is already written (inside the caller's transaction), so the tree is complete.
  const everyGoal = ownerGoals(db, userId);
  const related = new Set([...ancestors(everyGoal, goalId), ...descendants(everyGoal, goalId)]);
  const others = everyGoal.filter((g) => !related.has(g.id) && g.status !== 'archived' && g.start_date <= deadline && g.deadline >= startDate);
  if (!others.length) return;
  const otherLinks = linksFor(db, others.map((g) => g.id));
  for (const l of otherLinks) {
    const otherRoom = l.room_id ?? (l.topic_id ? get<{ room_id: string }>(db, 'SELECT room_id FROM topics WHERE id = ?', l.topic_id)?.room_id : undefined);
    const clash =
      (l.room_id && (roomIds.includes(l.room_id) || [...topicRooms.values()].includes(l.room_id))) ||
      (l.topic_id && (topicIds.includes(l.topic_id) || (otherRoom && roomIds.includes(otherRoom))));
    if (clash) {
      const other = others.find((g) => g.id === l.goal_id)!;
      throw badRequest(
        `“${l.label}” already counts toward “${other.title}” during these dates. To avoid counting the same work twice, link it to that goal's parent or child instead.`,
        'DOUBLE_COUNT',
      );
    }
  }
}

function validateParent(db: DB, userId: string, goalId: string | null, parentId: string | null | undefined) {
  if (!parentId) return;
  const parent = ownGoal(db, userId, parentId);
  if (goalId) {
    const goals = ownerGoals(db, userId);
    if (descendants(goals, goalId).includes(parent.id)) throw badRequest('A goal cannot be placed under itself.');
  }
}

type GoalInput = {
  title: string;
  description?: string;
  period: Goal['period'];
  startDate: string;
  deadline: string;
  measure: Goal['measure'];
  target?: number | null;
  unit?: string;
  parentId?: string | null;
  visibility?: Goal['visibility'];
  roomIds?: string[];
  topicIds?: string[];
};

function checkShape(input: { measure: Goal['measure']; target?: number | null; startDate: string; deadline: string }) {
  if (input.deadline < input.startDate) throw badRequest('The deadline must be after the start date.');
  if (input.measure === 'completion' && input.target) throw badRequest('Completion goals do not need a number.');
}

export function createGoal(db: DB, userId: string, input: GoalInput): string {
  checkShape(input);
  const id = newId();
  validateParent(db, userId, null, input.parentId);
  return transaction(db, () => {
    const now = Date.now();
    run(
      db,
      `INSERT INTO goals (id, owner_id, title, description, period, start_date, deadline, measure, target, unit, parent_id, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      input.title,
      input.description ?? '',
      input.period,
      input.startDate,
      input.deadline,
      input.measure,
      input.measure === 'completion' ? null : (input.target ?? null),
      input.unit ?? '',
      input.parentId ?? null,
      input.visibility ?? 'private',
      now,
      now,
    );
    setLinks(db, userId, id, input.startDate, input.deadline, input.roomIds ?? [], input.topicIds ?? []);
    return id;
  });
}

function setLinks(db: DB, userId: string, goalId: string, startDate: string, deadline: string, roomIds: string[], topicIds: string[]) {
  const rooms = [...new Set(roomIds)];
  const topics = [...new Set(topicIds)];
  validateLinks(db, userId, goalId, startDate, deadline, rooms, topics);
  run(db, 'DELETE FROM goal_links WHERE goal_id = ?', goalId);
  for (const r of rooms) run(db, 'INSERT INTO goal_links (goal_id, room_id) VALUES (?, ?)', goalId, r);
  for (const t of topics) run(db, 'INSERT INTO goal_links (goal_id, topic_id) VALUES (?, ?)', goalId, t);
}

export function updateGoal(db: DB, userId: string, goalId: string, input: Partial<GoalInput> & { status?: Goal['status'] }) {
  const g = ownGoal(db, userId, goalId);
  const next = {
    title: input.title ?? g.title,
    description: input.description ?? g.description,
    period: input.period ?? g.period,
    startDate: input.startDate ?? g.start_date,
    deadline: input.deadline ?? g.deadline,
    measure: input.measure ?? g.measure,
    target: input.target !== undefined ? input.target : g.target,
    unit: input.unit ?? g.unit,
    parentId: input.parentId !== undefined ? input.parentId : g.parent_id,
    visibility: input.visibility ?? g.visibility,
    status: input.status ?? g.status,
  };
  checkShape(next);
  validateParent(db, userId, goalId, next.parentId);
  transaction(db, () => {
    const now = Date.now();
    const becameDone = next.status === 'done' && g.status !== 'done';
    run(
      db,
      `UPDATE goals SET title = ?, description = ?, period = ?, start_date = ?, deadline = ?, measure = ?, target = ?, unit = ?, parent_id = ?,
              visibility = ?, status = ?, done_at = ?, updated_at = ? WHERE id = ?`,
      next.title,
      next.description,
      next.period,
      next.startDate,
      next.deadline,
      next.measure,
      next.measure === 'completion' ? null : next.target,
      next.unit,
      next.parentId,
      next.visibility,
      next.status,
      next.status === 'done' ? (g.done_at ?? now) : null,
      now,
      goalId,
    );
    if (input.roomIds || input.topicIds) {
      const current = linksFor(db, [goalId]);
      setLinks(
        db,
        userId,
        goalId,
        next.startDate,
        next.deadline,
        input.roomIds ?? current.filter((l) => l.room_id).map((l) => l.room_id!),
        input.topicIds ?? current.filter((l) => l.topic_id).map((l) => l.topic_id!),
      );
    } else if (input.startDate || input.deadline) {
      const current = linksFor(db, [goalId]);
      validateLinks(db, userId, goalId, next.startDate, next.deadline, current.filter((l) => l.room_id).map((l) => l.room_id!), current.filter((l) => l.topic_id).map((l) => l.topic_id!));
    }
    if (becameDone && next.visibility === 'friends') recordActivity(db, { actorId: userId, type: 'goal_done', refId: goalId });
  });
}

/** Goals are archived, not deleted, so history stays readable. Children move up a level. */
export function archiveGoal(db: DB, userId: string, goalId: string) {
  const g = ownGoal(db, userId, goalId);
  transaction(db, () => {
    run(db, "UPDATE goals SET status = 'archived', updated_at = ? WHERE id = ?", Date.now(), goalId);
    run(db, 'UPDATE goals SET parent_id = ? WHERE parent_id = ?', g.parent_id, goalId);
  });
}
