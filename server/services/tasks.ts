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
  date: string | null;
  start_time: string | null;
  duration_minutes: number | null;
  room_id: string | null;
  topic_id: string | null;
  shared: number;
  note: string;
  completed_at: number | null;
  completed_date: string | null;
  status: 'active' | 'archived';
  room_name: string | null;
  topic_title: string | null;
}

const SELECT = `SELECT tk.*, r.name AS room_name, t.title AS topic_title
  FROM tasks tk
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
    roomId: roomVisible ? row.room_id : null,
    roomName: roomVisible ? row.room_name : null,
    topicId: roomVisible ? row.topic_id : null,
    topicTitle: roomVisible ? row.topic_title : null,
    shared: Boolean(row.shared),
    note: mine ? row.note : '', // private notes never leave the owner
    completed: row.completed_at !== null,
    completedAt: row.completed_at,
    status: row.status,
  };
}

/** My tasks plus friends' tasks they explicitly shared, within a date range. */
export async function listTasks(db: DB, viewerId: string, from: string, to: string, opts: { includeFriends?: boolean } = {}): Promise<Task[]> {
  const owners = [viewerId];
  if (opts.includeFriends !== false) owners.push(...await friendIds(db, viewerId));
  const rows = await all<TaskRow>(
    db,
    `${SELECT} WHERE tk.status = 'active' AND tk.date BETWEEN ? AND ? AND tk.owner_id IN (${placeholders(owners.length)})
       AND (tk.owner_id = ? OR tk.shared = 1)
     ORDER BY tk.date, tk.start_time IS NULL, tk.start_time, tk.created_at`,
    from,
    to,
    ...owners,
    viewerId,
  );
  const rooms = new Set(await myRoomIds(db, viewerId));
  return rows.map((r) => toTask(r, viewerId, rooms));
}

export async function getTask(db: DB, viewerId: string, taskId: string): Promise<Task> {
  const row = await get<TaskRow>(db, `${SELECT} WHERE tk.id = ?`, taskId);
  if (!row || (row.owner_id !== viewerId && !(row.shared && (await friendIds(db, viewerId)).includes(row.owner_id)))) throw notFound('That task could not be found.');
  return toTask(row, viewerId, new Set(await myRoomIds(db, viewerId)));
}

async function ownTask(db: DB, userId: string, taskId: string): Promise<TaskRow> {
  const row = await get<TaskRow>(db, `${SELECT} WHERE tk.id = ? AND tk.owner_id = ?`, taskId, userId);
  if (!row) throw notFound('That task could not be found.');
  return row;
}

async function validateRefs(db: DB, userId: string, refs: { roomId?: string | null; topicId?: string | null }) {
  let roomId = refs.roomId ?? null;
  if (refs.topicId) {
    const t = await get<{ room_id: string; created_by: string }>(db, 'SELECT room_id, created_by FROM topics WHERE id = ?', refs.topicId);
    if (!t) throw badRequest('That topic could not be found.');
    if (t.created_by !== userId) throw badRequest('You can only plan your own topics.');
    if (roomId && roomId !== t.room_id) throw badRequest('That topic is not in the selected room.');
    roomId = t.room_id;
  }
  if (roomId && !(await myRoomIds(db, userId)).includes(roomId)) throw badRequest('That room could not be found.');
  return roomId;
}

async function event(db: DB, taskId: string, userId: string, type: string, detail: Record<string, unknown> = {}) {
  await run(db, 'INSERT INTO task_events (id, task_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), taskId, userId, type, JSON.stringify(detail), Date.now());
}

export async function createTask(
  db: DB,
  userId: string,
  input: {
    title: string;
    description?: string;
    date: string;
    startTime?: string | null;
    durationMinutes?: number | null;
    roomId?: string | null;
    topicId?: string | null;
    shared?: boolean;
    note?: string;
  },
): Promise<string> {
  const roomId = await validateRefs(db, userId, input);
  const id = newId();
  const now = Date.now();
  await transaction(db, async () => {
    await run(
      db,
      `INSERT INTO tasks (id, owner_id, title, description, date, start_time, duration_minutes, room_id, topic_id, shared, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      input.title,
      input.description ?? '',
      input.date,
      input.startTime ?? null,
      input.durationMinutes ?? null,
      roomId,
      input.topicId ?? null,
      input.shared ? 1 : 0,
      input.note ?? '',
      now,
      now,
    );
    await event(db, id, userId, 'created', { date: input.date });
  });
  return id;
}

export async function updateTask(
  db: DB,
  userId: string,
  taskId: string,
  input: Partial<{
    title: string;
    description: string;
    date: string;
    startTime: string | null;
    durationMinutes: number | null;
    roomId: string | null;
    topicId: string | null;
    shared: boolean;
    note: string;
    completed: boolean;
    status: 'active' | 'archived';
  }>,
) {
  const t = await ownTask(db, userId, taskId);
  const refs = {
    roomId: input.roomId !== undefined ? input.roomId : t.room_id,
    topicId: input.topicId !== undefined ? input.topicId : t.topic_id,
  };
  if (input.roomId !== undefined && input.topicId === undefined && input.roomId !== t.room_id) refs.topicId = null;
  const roomId = await validateRefs(db, userId, refs);
  await transaction(db, async () => {
    const now = Date.now();
    let completedAt = t.completed_at;
    let completedDate = t.completed_date;
    if (input.completed === true && !t.completed_at) {
      completedAt = now;
      completedDate = localDate(now, (await getUser(db, userId)).timezone);
      await event(db, taskId, userId, 'completed');
    } else if (input.completed === false && t.completed_at) {
      completedAt = null;
      completedDate = null;
      await event(db, taskId, userId, 'uncompleted');
    }
    if (input.date && input.date !== t.date) await event(db, taskId, userId, 'moved', { from: t.date, to: input.date });
    await run(
      db,
      `UPDATE tasks SET title = ?, description = ?, date = ?, start_time = ?, duration_minutes = ?, room_id = ?, topic_id = ?,
              shared = ?, note = ?, completed_at = ?, completed_date = ?, status = ?, updated_at = ? WHERE id = ?`,
      input.title ?? t.title,
      input.description ?? t.description,
      input.date ?? t.date,
      input.startTime !== undefined ? input.startTime : t.start_time,
      input.durationMinutes !== undefined ? input.durationMinutes : t.duration_minutes,
      roomId,
      refs.topicId,
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
export async function archiveTask(db: DB, userId: string, taskId: string) {
  await ownTask(db, userId, taskId);
  await run(db, "UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?", Date.now(), taskId);
  await event(db, taskId, userId, 'archived');
}

export async function completedTasksOn(db: DB, userId: string, date: string): Promise<number> {
  return (await get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND completed_date = ? AND status = 'active'", userId, date))!.n;
}
