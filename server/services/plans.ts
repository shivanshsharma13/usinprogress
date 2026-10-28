// Plans (shown as "Goals"): a personal plan split into sprints of days, each day holding tasks.
//
//   plan → sprints → days → tasks
//
// Days are computed (day N = start_date + N); only tasks are stored. A task becomes studyable once
// its sprint is pulled into a shared room: it then gets a topic in that room, and its progress and
// time come from that topic (topic_completions and study_sessions stay the single record of work).
import { all, get, newId, placeholders, run, transaction, type DB } from '../db.ts';
import { badRequest, conflict, notFound } from '../http.ts';
import { addDays } from '../../shared/dates.ts';
import type { DayStatus, Plan, PlanDay, PlanSprint, PlanSummary, PlanTask, RoomSprint } from '../../shared/types.ts';
import { requireRoomMember, todayFor } from './core.ts';
import { archiveTopic, createTopic } from './rooms.ts';

interface PlanRow {
  id: string;
  owner_id: string;
  title: string;
  start_date: string;
  sprint_days: number;
  sprint_count: number;
  status: 'active' | 'archived';
  created_at: number;
}

interface TaskRow {
  id: string;
  plan_id: string;
  day: number;
  title: string;
  est_minutes: number | null;
  position: number;
  starred: number;
  topic_id: string | null;
}

interface SprintRow {
  plan_id: string;
  number: number;
  room_id: string | null;
  room_name: string | null;
  completed_at: number | null;
}

const sprintOf = (plan: PlanRow, day: number) => Math.floor(day / plan.sprint_days) + 1;
const totalDays = (plan: PlanRow) => plan.sprint_days * plan.sprint_count;

function ownPlan(db: DB, userId: string, planId: string): PlanRow {
  const p = get<PlanRow>(db, 'SELECT * FROM plans WHERE id = ? AND owner_id = ?', planId, userId);
  if (!p) throw notFound('That goal could not be found.');
  return p;
}

function dayStatus(date: string, today: string, tasks: PlanTask[]): DayStatus {
  if (date > today) return 'upcoming';
  if (date === today) return 'today';
  if (!tasks.length) return 'rest';
  const done = tasks.filter((t) => t.done).length;
  return done === tasks.length ? 'done' : done ? 'partial' : 'missed';
}

/** Tasks of the given plans with their done state and time, read from their room topics. */
function loadTasks(db: DB, plans: PlanRow[]): Map<string, PlanTask[]> {
  const byPlan = new Map<string, PlanTask[]>(plans.map((p) => [p.id, []]));
  if (!plans.length) return byPlan;
  const rows = all<TaskRow>(
    db,
    `SELECT * FROM plan_tasks WHERE status = 'active' AND plan_id IN (${placeholders(plans.length)}) ORDER BY day, position, created_at`,
    ...plans.map((p) => p.id),
  );
  const topicIds = rows.map((r) => r.topic_id).filter(Boolean) as string[];
  const done = new Set<string>();
  const time = new Map<string, number>();
  if (topicIds.length) {
    const ph = placeholders(topicIds.length);
    // Topics are only ever completed or studied by their owner (the plan owner).
    for (const r of all<{ topic_id: string }>(db, `SELECT topic_id FROM topic_completions WHERE kind = 'first' AND revoked_at IS NULL AND topic_id IN (${ph})`, ...topicIds)) done.add(r.topic_id);
    for (const r of all<{ topic_id: string; ms: number }>(db, `SELECT topic_id, SUM(focused_ms) AS ms FROM study_sessions WHERE state = 'finished' AND topic_id IN (${ph}) GROUP BY topic_id`, ...topicIds)) time.set(r.topic_id, r.ms);
  }
  for (const r of rows) {
    byPlan.get(r.plan_id)!.push({
      id: r.id,
      day: r.day,
      title: r.title,
      estMinutes: r.est_minutes,
      starred: Boolean(r.starred),
      topicId: r.topic_id,
      done: r.topic_id ? done.has(r.topic_id) : false,
      focusedMs: r.topic_id ? (time.get(r.topic_id) ?? 0) : 0,
    });
  }
  return byPlan;
}

function sprintRows(db: DB, planIds: string[]): SprintRow[] {
  if (!planIds.length) return [];
  return all<SprintRow>(
    db,
    `SELECT s.plan_id, s.number, s.room_id, r.name AS room_name, s.completed_at FROM plan_sprints s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.plan_id IN (${placeholders(planIds.length)})`,
    ...planIds,
  );
}

function buildSprint(plan: PlanRow, n: number, tasks: PlanTask[], row: SprintRow | undefined, today: string): PlanSprint {
  const first = (n - 1) * plan.sprint_days;
  const days: PlanDay[] = [];
  for (let d = first; d < first + plan.sprint_days; d++) {
    const date = addDays(plan.start_date, d);
    const dayTasks = tasks.filter((t) => t.day === d);
    days.push({ day: d, number: d + 1, date, status: dayStatus(date, today, dayTasks), tasks: dayTasks });
  }
  const sprintTasks = days.flatMap((d) => d.tasks);
  return {
    number: n,
    startDate: days[0].date,
    endDate: days[days.length - 1].date,
    roomId: row?.room_id ?? null,
    roomName: row?.room_name ?? null,
    completedAt: row?.completed_at ?? null,
    done: sprintTasks.filter((t) => t.done).length,
    total: sprintTasks.length,
    days,
  };
}

function summarize(plan: PlanRow, tasks: PlanTask[], sprints: SprintRow[], today: string): PlanSummary {
  const dayIndex = Math.round((Date.parse(today) - Date.parse(plan.start_date)) / 86_400_000);
  return {
    id: plan.id,
    title: plan.title,
    startDate: plan.start_date,
    endDate: addDays(plan.start_date, totalDays(plan) - 1),
    sprintDays: plan.sprint_days,
    sprintCount: plan.sprint_count,
    sprintsCompleted: sprints.filter((s) => s.completed_at).length,
    currentSprint: dayIndex >= 0 && dayIndex < totalDays(plan) ? sprintOf(plan, dayIndex) : null,
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    focusedMs: tasks.reduce((sum, t) => sum + t.focusedMs, 0),
    status: plan.status,
  };
}

export function listPlans(db: DB, userId: string): PlanSummary[] {
  const plans = all<PlanRow>(db, 'SELECT * FROM plans WHERE owner_id = ? ORDER BY status, start_date DESC', userId);
  const tasks = loadTasks(db, plans);
  const sprints = sprintRows(db, plans.map((p) => p.id));
  const today = todayFor(db, userId);
  return plans.map((p) => summarize(p, tasks.get(p.id)!, sprints.filter((s) => s.plan_id === p.id), today));
}

export function getPlan(db: DB, userId: string, planId: string): Plan {
  const plan = ownPlan(db, userId, planId);
  const tasks = loadTasks(db, [plan]).get(plan.id)!;
  const rows = sprintRows(db, [plan.id]);
  const today = todayFor(db, userId);
  return {
    ...summarize(plan, tasks, rows, today),
    sprints: Array.from({ length: plan.sprint_count }, (_, i) => buildSprint(plan, i + 1, tasks, rows.find((r) => r.number === i + 1), today)),
  };
}

/** Sprints pulled into a room, for both members — this is what the two of you see there. */
export function roomSprints(db: DB, roomId: string): RoomSprint[] {
  const rows = all<SprintRow & { owner_id: string; title: string }>(
    db,
    `SELECT s.plan_id, s.number, s.room_id, r.name AS room_name, s.completed_at, p.owner_id, p.title
       FROM plan_sprints s JOIN plans p ON p.id = s.plan_id JOIN rooms r ON r.id = s.room_id
      WHERE s.room_id = ? AND s.completed_at IS NULL AND p.status = 'active' ORDER BY p.created_at, s.number`,
    roomId,
  );
  if (!rows.length) return [];
  const plans = all<PlanRow>(db, `SELECT * FROM plans WHERE id IN (${placeholders(rows.length)})`, ...rows.map((r) => r.plan_id));
  const tasks = loadTasks(db, plans);
  return rows.map((row) => {
    const plan = plans.find((p) => p.id === row.plan_id)!;
    // Day status follows the owner's own calendar day.
    const today = todayFor(db, row.owner_id);
    return { ...buildSprint(plan, row.number, tasks.get(plan.id)!, row, today), planId: plan.id, planTitle: row.title, ownerId: row.owner_id };
  });
}

// ───────────── Changes ─────────────

export function createPlan(db: DB, userId: string, input: { title: string; startDate: string; sprintDays: number; sprintCount: number }): string {
  const id = newId();
  const now = Date.now();
  run(
    db,
    'INSERT INTO plans (id, owner_id, title, start_date, sprint_days, sprint_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    userId,
    input.title,
    input.startDate,
    input.sprintDays,
    input.sprintCount,
    now,
    now,
  );
  return id;
}

export function updatePlan(db: DB, userId: string, planId: string, input: { title?: string; sprintCount?: number; status?: 'active' | 'archived' }) {
  const plan = ownPlan(db, userId, planId);
  if (input.sprintCount !== undefined && input.sprintCount < plan.sprint_count) {
    const last = get<{ d: number | null }>(db, "SELECT MAX(day) AS d FROM plan_tasks WHERE plan_id = ? AND status = 'active'", planId)!.d;
    if (last !== null && sprintOf(plan, last) > input.sprintCount) throw badRequest(`Sprint ${sprintOf(plan, last)} still has tasks, so the goal needs at least that many sprints.`);
  }
  run(
    db,
    'UPDATE plans SET title = ?, sprint_count = ?, status = ?, updated_at = ? WHERE id = ?',
    input.title ?? plan.title,
    input.sprintCount ?? plan.sprint_count,
    input.status ?? plan.status,
    Date.now(),
    planId,
  );
}

function sprintRoom(db: DB, planId: string, n: number): string | null {
  return get<{ room_id: string | null }>(db, 'SELECT room_id FROM plan_sprints WHERE plan_id = ? AND number = ?', planId, n)?.room_id ?? null;
}

function topicRoom(db: DB, topicId: string): string {
  return get<{ room_id: string }>(db, 'SELECT room_id FROM topics WHERE id = ?', topicId)!.room_id;
}

/** Gives the task a topic in the room its sprint lives in (if the sprint is in a room). */
function attachToRoom(db: DB, userId: string, plan: PlanRow, task: { id: string; day: number; title: string; est_minutes: number | null; topic_id: string | null }) {
  const roomId = sprintRoom(db, plan.id, sprintOf(plan, task.day));
  if (!roomId) return;
  if (task.topic_id) {
    if (topicRoom(db, task.topic_id) !== roomId) throw badRequest('That sprint is in a different room from this task.');
    return;
  }
  const topicId = createTopic(db, userId, roomId, { title: task.title, estimatedMinutes: task.est_minutes });
  run(db, 'UPDATE plan_tasks SET topic_id = ? WHERE id = ?', topicId, task.id);
}

/** Pulls a sprint into a shared room: every task in it becomes a topic you can study there. */
export function pullSprint(db: DB, userId: string, planId: string, n: number, roomId: string): string {
  const plan = ownPlan(db, userId, planId);
  if (n < 1 || n > plan.sprint_count) throw notFound('That sprint could not be found.');
  const room = requireRoomMember(db, roomId, userId);
  if (room.status !== 'active') throw badRequest('That room is archived.');
  const current = sprintRoom(db, planId, n);
  if (current && current !== roomId) throw conflict('This sprint is already in another room.', 'SPRINT_IN_ROOM');
  transaction(db, () => {
    run(
      db,
      `INSERT INTO plan_sprints (plan_id, number, room_id, pulled_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (plan_id, number) DO UPDATE SET room_id = excluded.room_id, pulled_at = COALESCE(plan_sprints.pulled_at, excluded.pulled_at)`,
      planId,
      n,
      roomId,
      Date.now(),
    );
    const first = (n - 1) * plan.sprint_days;
    const tasks = all<TaskRow>(db, "SELECT * FROM plan_tasks WHERE plan_id = ? AND status = 'active' AND day BETWEEN ? AND ? ORDER BY day, position", planId, first, first + plan.sprint_days - 1);
    for (const t of tasks) attachToRoom(db, userId, plan, t);
  });
  return room.id;
}

/** "Review & complete": closes the sprint. It leaves the room view but its history stays. */
export function setSprintCompleted(db: DB, userId: string, planId: string, n: number, completed: boolean) {
  const plan = ownPlan(db, userId, planId);
  if (n < 1 || n > plan.sprint_count) throw notFound('That sprint could not be found.');
  run(
    db,
    `INSERT INTO plan_sprints (plan_id, number, completed_at) VALUES (?, ?, ?)
     ON CONFLICT (plan_id, number) DO UPDATE SET completed_at = excluded.completed_at`,
    planId,
    n,
    completed ? Date.now() : null,
  );
}

function checkDay(plan: PlanRow, day: number) {
  if (day < 0 || day >= totalDays(plan)) throw badRequest('That day is outside this goal.');
}

export function addTask(db: DB, userId: string, planId: string, input: { day: number; title: string; estMinutes?: number | null }): string {
  const plan = ownPlan(db, userId, planId);
  checkDay(plan, input.day);
  return transaction(db, () => {
    const id = newId();
    const now = Date.now();
    const last = get<{ p: number | null }>(db, 'SELECT MAX(position) AS p FROM plan_tasks WHERE plan_id = ? AND day = ?', planId, input.day)!.p;
    run(
      db,
      'INSERT INTO plan_tasks (id, plan_id, day, title, est_minutes, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      planId,
      input.day,
      input.title,
      input.estMinutes ?? null,
      (last ?? 0) + 1,
      now,
      now,
    );
    attachToRoom(db, userId, plan, { id, day: input.day, title: input.title, est_minutes: input.estMinutes ?? null, topic_id: null });
    return id;
  });
}

function ownTask(db: DB, userId: string, taskId: string): { task: TaskRow; plan: PlanRow } {
  const task = get<TaskRow>(db, "SELECT * FROM plan_tasks WHERE id = ? AND status = 'active'", taskId);
  if (!task) throw notFound('That task could not be found.');
  return { task, plan: ownPlan(db, userId, task.plan_id) };
}

export function updateTask(db: DB, userId: string, taskId: string, input: { day?: number; title?: string; estMinutes?: number | null; starred?: boolean }) {
  const { task, plan } = ownTask(db, userId, taskId);
  const day = input.day ?? task.day;
  checkDay(plan, day);
  transaction(db, () => {
    const title = input.title ?? task.title;
    const est = input.estMinutes !== undefined ? input.estMinutes : task.est_minutes;
    const position =
      day === task.day ? task.position : (get<{ p: number | null }>(db, 'SELECT MAX(position) AS p FROM plan_tasks WHERE plan_id = ? AND day = ?', plan.id, day)!.p ?? 0) + 1;
    run(
      db,
      'UPDATE plan_tasks SET day = ?, title = ?, est_minutes = ?, position = ?, starred = ?, updated_at = ? WHERE id = ?',
      day,
      title,
      est,
      position,
      input.starred === undefined ? task.starred : input.starred ? 1 : 0,
      Date.now(),
      taskId,
    );
    // Keep the room topic in step with the task.
    if (task.topic_id) run(db, 'UPDATE topics SET title = ?, estimated_minutes = ?, updated_at = ? WHERE id = ?', title, est, Date.now(), task.topic_id);
    if (day !== task.day) attachToRoom(db, userId, plan, { ...task, day, title, est_minutes: est });
  });
}

/** Removes a task from the plan. Its room topic is archived, so study history is kept. */
export function removeTask(db: DB, userId: string, taskId: string) {
  const { task } = ownTask(db, userId, taskId);
  transaction(db, () => {
    if (task.topic_id) archiveTopic(db, userId, task.topic_id);
    run(db, "UPDATE plan_tasks SET status = 'archived', updated_at = ? WHERE id = ?", Date.now(), taskId);
  });
}

// ───────────── What to study next ─────────────

interface OpenTask {
  topic_id: string;
  title: string;
  day: number;
  position: number;
  start_date: string;
}

function openPlanTopics(db: DB, userId: string, roomId: string): OpenTask[] {
  return all<OpenTask>(
    db,
    `SELECT t.topic_id, t.title, t.day, t.position, p.start_date FROM plan_tasks t
       JOIN plans p ON p.id = t.plan_id
       JOIN topics tp ON tp.id = t.topic_id
       LEFT JOIN topic_progress pr ON pr.topic_id = t.topic_id AND pr.user_id = ?
      WHERE p.owner_id = ? AND p.status = 'active' AND t.status = 'active' AND tp.room_id = ? AND tp.status = 'active'
        AND (pr.status IS NULL OR pr.status != 'completed')
      ORDER BY p.created_at, t.day, t.position`,
    userId,
    userId,
    roomId,
  );
}

/** Today's first open task, else the oldest overdue one, else the next upcoming one. */
export function nextPlanTopic(db: DB, userId: string, roomId: string): { id: string; title: string } | null {
  const today = todayFor(db, userId);
  const open = openPlanTopics(db, userId, roomId).map((t) => ({ ...t, date: addDays(t.start_date, t.day) }));
  const pick = open.find((t) => t.date === today) ?? open.find((t) => t.date < today) ?? open[0];
  return pick ? { id: pick.topic_id, title: pick.title } : null;
}

/** After finishing a plan task: the next open task that day, then the following days. */
export function nextPlanTopicAfter(db: DB, userId: string, roomId: string, topicId: string): { id: string; title: string } | null | undefined {
  const finished = get<{ plan_id: string; day: number; position: number }>(db, "SELECT plan_id, day, position FROM plan_tasks WHERE topic_id = ? AND status = 'active'", topicId);
  if (!finished) return undefined; // not a plan task
  const open = openPlanTopics(db, userId, roomId).filter((t) => t.topic_id !== topicId);
  const later = open.find((t) => t.day > finished.day || (t.day === finished.day && t.position > finished.position));
  const pick = later ?? open[0];
  return pick ? { id: pick.topic_id, title: pick.title } : null;
}
