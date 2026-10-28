// Tasks / calendar items. A scheduled task is a plan; it is never treated as a recorded session.
import { all, get, newId, placeholders, run, transaction, type DB } from '../db.ts';
import { badRequest, notFound } from '../http.ts';
import { localDate } from '../../shared/dates.ts';
import type { Task } from '../../shared/types.ts';
import { friendIds, getUser, myRoomIds } from './core.ts';

interface TaskRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  date: string;
  start_time: string | null;
  duration_minutes: number | null;
  goal_id: string | null;
  room_id: string | null;
  topic_id: string | null;
  quantity: number;
  shared: number;
  note: string;
  completed_at: number | null;
  completed_date: string | null;
  status: 'active' | 'archived';
  goal_title: string | null;
  goal_visibility: string | null;
  room_name: string | null;
  topic_title: string | null;
}

const SELECT = `SELECT tk.*, g.title AS goal_title, g.visibility AS goal_visibility, r.name AS room_name, t.title AS topic_title
  FROM tasks tk
  LEFT JOIN goals g ON g.id = tk.goal_id
  LEFT JOIN rooms r ON r.id = tk.room_id
  LEFT JOIN topics t ON t.id = tk.topic_id`;

function toTask(row: TaskRow, viewerId: string, viewerRooms: Set<string>): Task {
  const mine = row.owner_id === viewerId;
  const roomVisible = mine || (row.room_id ? viewerRooms.has(row.room_id) : false);
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    description: mine ? row.description : '',
    date: row.date,
    startTime: row.start_time,
    durationMinutes: row.duration_minutes,
    goalId: mine || row.goal_visibility === 'friends' ? row.goal_id : null,
    goalTitle: mine || row.goal_visibility === 'friends' ? row.goal_title : null,
    roomId: roomVisible ? row.room_id : null,
    roomName: roomVisible ? row.room_name : null,
    topicId: roomVisible ? row.topic_id : null,
    topicTitle: roomVisible ? row.topic_title : null,
    quantity: row.quantity,
    shared: Boolean(row.shared),
    note: mine ? row.note : '', // private notes never leave the owner
    completed: row.completed_at !== null,
    completedAt: row.completed_at,
    status: row.status,
  };
}

/** My tasks plus friends' tasks they explicitly shared, within a date range. */
export function listTasks(db: DB, viewerId: string, from: string, to: string, opts: { includeFriends?: boolean } = {}): Task[] {
  const owners = [viewerId];
  if (opts.includeFriends !== false) owners.push(...friendIds(db, viewerId));
  const rows = all<TaskRow>(
    db,
    `${SELECT} WHERE tk.status = 'active' AND tk.date BETWEEN ? AND ? AND tk.owner_id IN (${placeholders(owners.length)})
       AND (tk.owner_id = ? OR tk.shared = 1)
     ORDER BY tk.date, tk.start_time IS NULL, tk.start_time, tk.created_at`,
    from,
    to,
    ...owners,
    viewerId,
  );
  const rooms = new Set(myRoomIds(db, viewerId));
  return rows.map((r) => toTask(r, viewerId, rooms));
}

export function getTask(db: DB, viewerId: string, taskId: string): Task {
  const row = get<TaskRow>(db, `${SELECT} WHERE tk.id = ?`, taskId);
  if (!row || (row.owner_id !== viewerId && !(row.shared && friendIds(db, viewerId).includes(row.owner_id)))) throw notFound('That task could not be found.');
  return toTask(row, viewerId, new Set(myRoomIds(db, viewerId)));
}

function ownTask(db: DB, userId: string, taskId: string): TaskRow {
  const row = get<TaskRow>(db, `${SELECT} WHERE tk.id = ? AND tk.owner_id = ?`, taskId, userId);
  if (!row) throw notFound('That task could not be found.');
  return row;
}

function validateRefs(db: DB, userId: string, refs: { goalId?: string | null; roomId?: string | null; topicId?: string | null }) {
  let roomId = refs.roomId ?? null;
  if (refs.goalId) {
    const g = get<{ status: string }>(db, 'SELECT status FROM goals WHERE id = ? AND owner_id = ?', refs.goalId, userId);
    if (!g) throw badRequest('That goal could not be found.');
  }
  if (refs.topicId) {
    const t = get<{ room_id: string }>(db, 'SELECT room_id FROM topics WHERE id = ?', refs.topicId);
    if (!t) throw badRequest('That topic could not be found.');
    if (roomId && roomId !== t.room_id) throw badRequest('That topic is not in the selected room.');
    roomId = t.room_id;
  }
  if (roomId && !myRoomIds(db, userId).includes(roomId)) throw badRequest('That room could not be found.');
  return roomId;
}

function event(db: DB, taskId: string, userId: string, type: string, detail: Record<string, unknown> = {}) {
  run(db, 'INSERT INTO task_events (id, task_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), taskId, userId, type, JSON.stringify(detail), Date.now());
}

export function createTask(
  db: DB,
  userId: string,
  input: {
    title: string;
    description?: string;
    date: string;
    startTime?: string | null;
    durationMinutes?: number | null;
    goalId?: string | null;
    roomId?: string | null;
    topicId?: string | null;
    quantity?: number;
    shared?: boolean;
    note?: string;
  },
): string {
  const roomId = validateRefs(db, userId, input);
  const id = newId();
  const now = Date.now();
  transaction(db, () => {
    run(
      db,
      `INSERT INTO tasks (id, owner_id, title, description, date, start_time, duration_minutes, goal_id, room_id, topic_id, quantity, shared, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      input.title,
      input.description ?? '',
      input.date,
      input.startTime ?? null,
      input.durationMinutes ?? null,
      input.goalId ?? null,
      roomId,
      input.topicId ?? null,
      input.quantity ?? 1,
      input.shared ? 1 : 0,
      input.note ?? '',
      now,
      now,
    );
    event(db, id, userId, 'created', { date: input.date });
  });
  return id;
}

export function updateTask(
  db: DB,
  userId: string,
  taskId: string,
  input: Partial<{
    title: string;
    description: string;
    date: string;
    startTime: string | null;
    durationMinutes: number | null;
    goalId: string | null;
    roomId: string | null;
    topicId: string | null;
    quantity: number;
    shared: boolean;
    note: string;
    completed: boolean;
    status: 'active' | 'archived';
  }>,
) {
  const t = ownTask(db, userId, taskId);
  const refs = {
    goalId: input.goalId !== undefined ? input.goalId : t.goal_id,
    roomId: input.roomId !== undefined ? input.roomId : t.room_id,
    topicId: input.topicId !== undefined ? input.topicId : t.topic_id,
  };
  if (input.roomId !== undefined && input.topicId === undefined && input.roomId !== t.room_id) refs.topicId = null;
  const roomId = validateRefs(db, userId, refs);
  transaction(db, () => {
    const now = Date.now();
    let completedAt = t.completed_at;
    let completedDate = t.completed_date;
    if (input.completed === true && !t.completed_at) {
      completedAt = now;
      completedDate = localDate(now, getUser(db, userId).timezone);
      event(db, taskId, userId, 'completed');
    } else if (input.completed === false && t.completed_at) {
      completedAt = null;
      completedDate = null;
      event(db, taskId, userId, 'uncompleted');
    }
    if (input.date && input.date !== t.date) event(db, taskId, userId, 'moved', { from: t.date, to: input.date });
    run(
      db,
      `UPDATE tasks SET title = ?, description = ?, date = ?, start_time = ?, duration_minutes = ?, goal_id = ?, room_id = ?, topic_id = ?, quantity = ?,
              shared = ?, note = ?, completed_at = ?, completed_date = ?, status = ?, updated_at = ? WHERE id = ?`,
      input.title ?? t.title,
      input.description ?? t.description,
      input.date ?? t.date,
      input.startTime !== undefined ? input.startTime : t.start_time,
      input.durationMinutes !== undefined ? input.durationMinutes : t.duration_minutes,
      refs.goalId,
      roomId,
      refs.topicId,
      input.quantity ?? t.quantity,
      input.shared !== undefined ? (input.shared ? 1 : 0) : t.shared,
      input.note ?? t.note,
      completedAt,
      completedDate,
      input.status ?? t.status,
      now,
      taskId,
    );
  });
}

/** Removing a task archives it; any study sessions started from it are untouched. */
export function archiveTask(db: DB, userId: string, taskId: string) {
  ownTask(db, userId, taskId);
  run(db, "UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?", Date.now(), taskId);
  event(db, taskId, userId, 'archived');
}

export function completedTasksOn(db: DB, userId: string, date: string): number {
  return get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND completed_date = ? AND status = 'active'", userId, date)!.n;
}

export function isTaskShared(db: DB, taskId: string): boolean {
  return Boolean(get(db, 'SELECT 1 FROM tasks WHERE id = ? AND shared = 1', taskId));
}
