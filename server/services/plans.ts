// Plans (shown as "Goals"): plan → sprints → days → tasks.
//
// Sprints are added one at a time and each has its own length; they run back to back, so day N of a
// plan is simply start_date + N. A task is scheduled on a day, or parked in the backlog (day NULL).
// A task left unfinished on a past day also counts as backlog; it never moves forward on its own.
//
// A task becomes studyable once its sprint is pulled into a shared room: it gets a topic there, and
// its done state and time come from that topic (topic_completions / study_sessions stay the single
// record of work). A room only shows tasks scheduled for today or later in sprints pulled into it.
import { all, get, newId, placeholders, run, transaction, type DB } from '../db.ts';
import { badRequest, conflict, notFound } from '../http.ts';
import { addDays } from '../../shared/dates.ts';
import type { CalendarPlanItem, DayStatus, Plan, PlanDay, PlanSprint, PlanSummary, PlanTask, RoomSprint, SprintMark } from '../../shared/types.ts';
import { myRoomIds, requireRoomMember, todayFor } from './core.ts';
import { archiveTopic, createTopic } from './rooms.ts';

interface PlanRow {
  id: string;
  owner_id: string;
  title: string;
  start_date: string;
  sprint_days: number;
  status: 'active' | 'archived';
  created_at: number;
}

interface TaskRow {
  id: string;
  plan_id: string;
  day: number | null;
  planned_day: number | null;
  title: string;
  est_minutes: number | null;
  position: number;
  starred: number;
  topic_id: string | null;
}

interface SprintRow {
  plan_id: string;
  number: number;
  days: number;
  room_id: string | null;
  room_name: string | null;
  completed_at: number | null;
}

/** A sprint with the plan days it covers (first..last, inclusive). */
interface SprintSpan extends SprintRow {
  first: number;
  last: number;
}

const dateOf = (plan: PlanRow, day: number) => addDays(plan.start_date, day);
/** The day a task belongs to for history and sprint totals. */
const homeDay = (t: { day: number | null; plannedDay: number | null }) => t.plannedDay ?? t.day;

function ownPlan(db: DB, userId: string, planId: string): PlanRow {
  const p = get<PlanRow>(db, 'SELECT * FROM plans WHERE id = ? AND owner_id = ?', planId, userId);
  if (!p) throw notFound('That goal could not be found.');
  return p;
}

function spans(db: DB, planIds: string[]): Map<string, SprintSpan[]> {
  const out = new Map<string, SprintSpan[]>(planIds.map((id) => [id, []]));
  if (!planIds.length) return out;
  const rows = all<SprintRow>(
    db,
    `SELECT s.plan_id, s.number, s.days, s.room_id, r.name AS room_name, s.completed_at
       FROM plan_sprints s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.plan_id IN (${placeholders(planIds.length)}) ORDER BY s.plan_id, s.number`,
    ...planIds,
  );
  for (const id of planIds) {
    let first = 0;
    for (const r of rows.filter((x) => x.plan_id === id)) {
      out.get(id)!.push({ ...r, first, last: first + r.days - 1 });
      first += r.days;
    }
  }
  return out;
}

const sprintFor = (list: SprintSpan[], day: number) => list.find((s) => day >= s.first && day <= s.last);

/** Tasks of the given plans with done state and time, read from their room topics. */
function loadTasks(db: DB, planIds: string[]): Map<string, PlanTask[]> {
  const byPlan = new Map<string, PlanTask[]>(planIds.map((id) => [id, []]));
  if (!planIds.length) return byPlan;
  const rows = all<TaskRow>(
    db,
    `SELECT * FROM plan_tasks WHERE status = 'active' AND plan_id IN (${placeholders(planIds.length)}) ORDER BY day IS NULL, day, position, created_at`,
    ...planIds,
  );
  const topicIds = rows.map((r) => r.topic_id).filter(Boolean) as string[];
  const doneOn = new Map<string, string>();
  const time = new Map<string, number>();
  if (topicIds.length) {
    const ph = placeholders(topicIds.length);
    // A plan's topics are only ever completed or studied by the plan's owner.
    for (const r of all<{ topic_id: string; local_date: string }>(db, `SELECT topic_id, local_date FROM topic_completions WHERE kind = 'first' AND revoked_at IS NULL AND topic_id IN (${ph})`, ...topicIds)) {
      doneOn.set(r.topic_id, r.local_date);
    }
    for (const r of all<{ topic_id: string; ms: number }>(db, `SELECT topic_id, SUM(focused_ms) AS ms FROM study_sessions WHERE state = 'finished' AND topic_id IN (${ph}) GROUP BY topic_id`, ...topicIds)) {
      time.set(r.topic_id, r.ms);
    }
  }
  for (const r of rows) {
    const doneDate = r.topic_id ? (doneOn.get(r.topic_id) ?? null) : null;
    byPlan.get(r.plan_id)!.push({
      id: r.id,
      day: r.day,
      plannedDay: r.planned_day,
      title: r.title,
      estMinutes: r.est_minutes,
      starred: Boolean(r.starred),
      topicId: r.topic_id,
      done: doneDate !== null,
      doneDate,
      focusedMs: r.topic_id ? (time.get(r.topic_id) ?? 0) : 0,
    });
  }
  return byPlan;
}

const isBacklog = (plan: PlanRow, t: PlanTask, today: string) => !t.done && (t.day === null || dateOf(plan, t.day) < today);

function buildDay(plan: PlanRow, day: number, tasks: PlanTask[], today: string): PlanDay {
  const date = dateOf(plan, day);
  if (date >= today) {
    return { day, number: day + 1, date, status: date === today ? 'today' : 'upcoming', tasks: tasks.filter((t) => t.day === day) };
  }
  // A past day shows what was planned for it (or done on it), judged by whether it was done in time.
  const list = tasks.filter((t) => t.day === day || t.plannedDay === day);
  const onTime = list.filter((t) => t.doneDate !== null && t.doneDate <= date).length;
  const status: DayStatus = !list.length ? 'rest' : onTime === list.length ? 'done' : onTime ? 'partial' : 'missed';
  return { day, number: day + 1, date, status, tasks: list };
}

function buildSprint(plan: PlanRow, s: SprintSpan, tasks: PlanTask[], today: string): PlanSprint {
  const days: PlanDay[] = [];
  for (let d = s.first; d <= s.last; d++) days.push(buildDay(plan, d, tasks, today));
  const mine = tasks.filter((t) => {
    const d = homeDay(t);
    return d !== null && d >= s.first && d <= s.last;
  });
  return {
    number: s.number,
    length: s.days,
    startDate: dateOf(plan, s.first),
    endDate: dateOf(plan, s.last),
    roomId: s.room_id,
    roomName: s.room_name,
    completedAt: s.completed_at,
    done: mine.filter((t) => t.done).length,
    total: mine.length,
    focusedMs: mine.reduce((sum, t) => sum + t.focusedMs, 0),
    estMinutes: mine.reduce((sum, t) => sum + (t.estMinutes ?? 0), 0),
    days,
  };
}

function summarize(plan: PlanRow, sprints: SprintSpan[], tasks: PlanTask[], today: string): PlanSummary {
  const total = sprints.length ? sprints[sprints.length - 1].last + 1 : 0;
  const todayIndex = Math.round((Date.parse(today) - Date.parse(plan.start_date)) / 86_400_000);
  return {
    id: plan.id,
    title: plan.title,
    startDate: plan.start_date,
    endDate: dateOf(plan, Math.max(0, total - 1)),
    sprintDays: plan.sprint_days,
    sprintCount: sprints.length,
    sprintsCompleted: sprints.filter((s) => s.completed_at).length,
    currentSprint: sprintFor(sprints, todayIndex)?.number ?? null,
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    backlog: tasks.filter((t) => isBacklog(plan, t, today)).length,
    focusedMs: tasks.reduce((sum, t) => sum + t.focusedMs, 0),
    status: plan.status,
  };
}

export function listPlans(db: DB, userId: string): PlanSummary[] {
  const plans = all<PlanRow>(db, 'SELECT * FROM plans WHERE owner_id = ? ORDER BY status, start_date DESC', userId);
  const ids = plans.map((p) => p.id);
  const tasks = loadTasks(db, ids);
  const sprints = spans(db, ids);
  const today = todayFor(db, userId);
  return plans.map((p) => summarize(p, sprints.get(p.id)!, tasks.get(p.id)!, today));
}

export function getPlan(db: DB, userId: string, planId: string): Plan {
  const plan = ownPlan(db, userId, planId);
  const tasks = loadTasks(db, [plan.id]).get(plan.id)!;
  const sprints = spans(db, [plan.id]).get(plan.id)!;
  const today = todayFor(db, userId);
  return {
    ...summarize(plan, sprints, tasks, today),
    sprints: sprints.map((s) => buildSprint(plan, s, tasks, today)),
    backlogTasks: tasks.filter((t) => isBacklog(plan, t, today)).sort((a, b) => (homeDay(a) ?? Infinity) - (homeDay(b) ?? Infinity)),
  };
}

/** Open sprints pulled into a room, for both members — what the two of you see there. */
export function roomSprints(db: DB, roomId: string): RoomSprint[] {
  const pulled = all<{ plan_id: string; number: number }>(
    db,
    `SELECT s.plan_id, s.number FROM plan_sprints s JOIN plans p ON p.id = s.plan_id
      WHERE s.room_id = ? AND s.completed_at IS NULL AND p.status = 'active' ORDER BY p.created_at, s.number`,
    roomId,
  );
  if (!pulled.length) return [];
  const planIds = [...new Set(pulled.map((r) => r.plan_id))];
  const plans = all<PlanRow>(db, `SELECT * FROM plans WHERE id IN (${placeholders(planIds.length)})`, ...planIds);
  const tasks = loadTasks(db, planIds);
  const sprints = spans(db, planIds);
  return pulled.map((row) => {
    const plan = plans.find((p) => p.id === row.plan_id)!;
    const span = sprints.get(plan.id)!.find((s) => s.number === row.number)!;
    // Day status follows the owner's own calendar day.
    const built = buildSprint(plan, span, tasks.get(plan.id)!, todayFor(db, plan.owner_id));
    return { ...built, planId: plan.id, planTitle: plan.title, ownerId: plan.owner_id };
  });
}

/**
 * Goal tasks and sprints for a calendar range: all of yours that are scheduled, plus your friends'
 * from open sprints they pulled into rooms you share (what they've chosen to show you).
 */
export function calendarPlanItems(db: DB, viewerId: string, from: string, to: string, opts: { friends: boolean }): { items: CalendarPlanItem[]; sprints: SprintMark[] } {
  const own = all<PlanRow>(db, "SELECT * FROM plans WHERE owner_id = ? AND status = 'active'", viewerId);
  const rooms = opts.friends ? myRoomIds(db, viewerId) : [];
  const shared = rooms.length
    ? all<{ plan_id: string; number: number }>(
        db,
        `SELECT s.plan_id, s.number FROM plan_sprints s JOIN plans p ON p.id = s.plan_id
          WHERE s.room_id IN (${placeholders(rooms.length)}) AND s.completed_at IS NULL AND p.status = 'active' AND p.owner_id != ?`,
        ...rooms,
        viewerId,
      )
    : [];
  const friendIds = [...new Set(shared.map((s) => s.plan_id))];
  const plans = [...own, ...(friendIds.length ? all<PlanRow>(db, `SELECT * FROM plans WHERE id IN (${placeholders(friendIds.length)})`, ...friendIds) : [])];
  const ids = plans.map((p) => p.id);
  const tasks = loadTasks(db, ids);
  const sprints = spans(db, ids);
  const items: CalendarPlanItem[] = [];
  const marks: SprintMark[] = [];
  for (const plan of plans) {
    const visible = (s: SprintSpan) => plan.owner_id === viewerId || shared.some((x) => x.plan_id === plan.id && x.number === s.number);
    const list = sprints.get(plan.id)!;
    for (const s of list) {
      const startDate = dateOf(plan, s.first);
      const endDate = dateOf(plan, s.last);
      if (visible(s) && startDate <= to && endDate >= from) marks.push({ planId: plan.id, planTitle: plan.title, ownerId: plan.owner_id, number: s.number, startDate, endDate, roomName: s.room_name });
    }
    for (const t of tasks.get(plan.id)!) {
      if (t.day === null) continue;
      const date = dateOf(plan, t.day);
      const s = sprintFor(list, t.day);
      if (date < from || date > to || !s || !visible(s)) continue;
      items.push({
        id: t.id,
        planId: plan.id,
        planTitle: plan.title,
        sprintNumber: s.number,
        ownerId: plan.owner_id,
        title: t.title,
        date,
        estMinutes: t.estMinutes,
        done: t.done,
        topicId: plan.owner_id === viewerId ? t.topicId : null,
        roomId: s.room_id,
        roomName: s.room_name,
      });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { items, sprints: marks };
}

// ───────────── Plans and sprints ─────────────

export function createPlan(db: DB, userId: string, input: { title: string; startDate: string; sprintDays: number }): string {
  const id = newId();
  const now = Date.now();
  transaction(db, () => {
    run(db, 'INSERT INTO plans (id, owner_id, title, start_date, sprint_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, userId, input.title, input.startDate, input.sprintDays, now, now);
    run(db, 'INSERT INTO plan_sprints (plan_id, number, days) VALUES (?, 1, ?)', id, input.sprintDays);
  });
  return id;
}

export function updatePlan(db: DB, userId: string, planId: string, input: { title?: string; status?: 'active' | 'archived' }) {
  const plan = ownPlan(db, userId, planId);
  run(db, 'UPDATE plans SET title = ?, status = ?, updated_at = ? WHERE id = ?', input.title ?? plan.title, input.status ?? plan.status, Date.now(), planId);
}

function ownSprint(db: DB, userId: string, planId: string, n: number): { plan: PlanRow; list: SprintSpan[]; sprint: SprintSpan } {
  const plan = ownPlan(db, userId, planId);
  const list = spans(db, [planId]).get(planId)!;
  const sprint = list.find((s) => s.number === n);
  if (!sprint) throw notFound('That sprint could not be found.');
  return { plan, list, sprint };
}

/** Adds the next sprint after the last one (default length unless given). */
export function addSprint(db: DB, userId: string, planId: string, days?: number): number {
  const plan = ownPlan(db, userId, planId);
  const n = get<{ n: number }>(db, 'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM plan_sprints WHERE plan_id = ?', planId)!.n;
  run(db, 'INSERT INTO plan_sprints (plan_id, number, days) VALUES (?, ?, ?)', planId, n, days ?? plan.sprint_days);
  return n;
}

function tasksBetween(db: DB, planId: string, from: number, to: number): number {
  return get<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM plan_tasks WHERE plan_id = ? AND status = 'active' AND (day BETWEEN ? AND ? OR planned_day BETWEEN ? AND ?)",
    planId,
    from,
    to,
    from,
    to,
  )!.n;
}

/**
 * Changes a sprint's length. Later sprints (and their tasks) shift with it. A sprint that has already
 * ended can't change, and days with tasks can't be cut off.
 */
export function resizeSprint(db: DB, userId: string, planId: string, n: number, days: number) {
  const { plan, sprint } = ownSprint(db, userId, planId, n);
  if (dateOf(plan, sprint.last) < todayFor(db, userId)) throw badRequest('This sprint has already ended, so its length stays as it was.');
  const delta = days - sprint.days;
  if (!delta) return;
  if (delta < 0 && tasksBetween(db, planId, sprint.last + delta + 1, sprint.last)) {
    throw badRequest(`Days ${sprint.last + delta + 2}–${sprint.last + 1} have tasks. Move them first, then shorten the sprint.`);
  }
  transaction(db, () => {
    run(db, 'UPDATE plan_sprints SET days = ? WHERE plan_id = ? AND number = ?', days, planId, n);
    run(db, 'UPDATE plan_tasks SET day = day + ? WHERE plan_id = ? AND day > ?', delta, planId, sprint.last);
    run(db, 'UPDATE plan_tasks SET planned_day = planned_day + ? WHERE plan_id = ? AND planned_day > ?', delta, planId, sprint.last);
  });
}

/** Removes the last sprint, if it has no tasks and isn't in a room. */
export function removeSprint(db: DB, userId: string, planId: string, n: number) {
  const { list, sprint } = ownSprint(db, userId, planId, n);
  if (list.length === 1) throw badRequest('A goal needs at least one sprint.');
  if (sprint.number !== list[list.length - 1].number) throw badRequest('Only the last sprint can be removed.');
  if (sprint.room_id) throw badRequest('Take this sprint out of its room first.');
  if (tasksBetween(db, planId, sprint.first, sprint.last)) throw badRequest('This sprint has tasks. Move or remove them first.');
  run(db, 'DELETE FROM plan_sprints WHERE plan_id = ? AND number = ?', planId, n);
}

/** Gives a scheduled task a topic in its sprint's room (moving or restoring an existing one). */
function attachToRoom(db: DB, userId: string, list: SprintSpan[], task: { id: string; day: number | null; title: string; est_minutes: number | null; topic_id: string | null }) {
  if (task.day === null) return;
  const roomId = sprintFor(list, task.day)?.room_id;
  if (!roomId) return;
  if (task.topic_id) {
    const topic = get<{ room_id: string; status: string }>(db, 'SELECT room_id, status FROM topics WHERE id = ?', task.topic_id)!;
    if (topic.room_id === roomId && topic.status === 'active') return;
    run(db, "UPDATE topics SET room_id = ?, status = 'active', updated_at = ? WHERE id = ?", roomId, Date.now(), task.topic_id);
    run(db, "INSERT INTO topic_events (id, topic_id, user_id, type, detail, created_at) VALUES (?, ?, ?, 'restored', '{}', ?)", newId(), task.topic_id, userId, Date.now());
    return;
  }
  const topicId = createTopic(db, userId, roomId, { title: task.title, estimatedMinutes: task.est_minutes });
  run(db, 'UPDATE plan_tasks SET topic_id = ? WHERE id = ?', topicId, task.id);
}

/** Pulls a sprint into a shared room: its scheduled tasks become topics you can study there. */
export function pullSprint(db: DB, userId: string, planId: string, n: number, roomId: string): string {
  const { sprint } = ownSprint(db, userId, planId, n);
  const room = requireRoomMember(db, roomId, userId);
  if (room.status !== 'active') throw badRequest('That room is archived.');
  if (sprint.room_id && sprint.room_id !== roomId) throw conflict('This sprint is already in another room. Take it out of that room first.', 'SPRINT_IN_ROOM');
  transaction(db, () => {
    run(db, 'UPDATE plan_sprints SET room_id = ?, pulled_at = COALESCE(pulled_at, ?) WHERE plan_id = ? AND number = ?', roomId, Date.now(), planId, n);
    const list = spans(db, [planId]).get(planId)!;
    const tasks = all<TaskRow>(db, "SELECT * FROM plan_tasks WHERE plan_id = ? AND status = 'active' AND day BETWEEN ? AND ? ORDER BY day, position", planId, sprint.first, sprint.last);
    for (const t of tasks) attachToRoom(db, userId, list, t);
  });
  return room.id;
}

/** Takes a sprint out of its room. Its topics are archived (history kept) and come back if it's pulled in again. */
export function unpullSprint(db: DB, userId: string, planId: string, n: number): string | null {
  const { sprint } = ownSprint(db, userId, planId, n);
  if (!sprint.room_id) return null;
  transaction(db, () => {
    const topics = all<{ topic_id: string }>(
      db,
      `SELECT pt.topic_id FROM plan_tasks pt JOIN topics t ON t.id = pt.topic_id
        WHERE pt.plan_id = ? AND pt.status = 'active' AND t.status = 'active' AND COALESCE(pt.day, pt.planned_day) BETWEEN ? AND ?`,
      planId,
      sprint.first,
      sprint.last,
    );
    for (const t of topics) archiveTopic(db, userId, t.topic_id);
    run(db, 'UPDATE plan_sprints SET room_id = NULL, pulled_at = NULL WHERE plan_id = ? AND number = ?', planId, n);
  });
  return sprint.room_id;
}

/** "Review & complete": closes the sprint. It leaves the room view; its history stays. */
export function setSprintCompleted(db: DB, userId: string, planId: string, n: number, completed: boolean) {
  ownSprint(db, userId, planId, n);
  run(db, 'UPDATE plan_sprints SET completed_at = ? WHERE plan_id = ? AND number = ?', completed ? Date.now() : null, planId, n);
}

// ───────────── Tasks ─────────────

function checkDay(list: SprintSpan[], day: number | null) {
  if (day !== null && !sprintFor(list, day)) throw badRequest('That day is outside this goal. Add a sprint first.');
}

const nextPosition = (db: DB, planId: string, day: number | null) =>
  (get<{ p: number | null }>(db, 'SELECT MAX(position) AS p FROM plan_tasks WHERE plan_id = ? AND day IS ?', planId, day)!.p ?? 0) + 1;

export function addTask(db: DB, userId: string, planId: string, input: { day: number | null; title: string; estMinutes?: number | null }): string {
  ownPlan(db, userId, planId);
  const list = spans(db, [planId]).get(planId)!;
  checkDay(list, input.day);
  return transaction(db, () => {
    const id = newId();
    const now = Date.now();
    run(
      db,
      'INSERT INTO plan_tasks (id, plan_id, day, planned_day, title, est_minutes, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      planId,
      input.day,
      input.day,
      input.title,
      input.estMinutes ?? null,
      nextPosition(db, planId, input.day),
      now,
      now,
    );
    attachToRoom(db, userId, list, { id, day: input.day, title: input.title, est_minutes: input.estMinutes ?? null, topic_id: null });
    return id;
  });
}

function ownTask(db: DB, userId: string, taskId: string): { task: TaskRow; plan: PlanRow } {
  const task = get<TaskRow>(db, "SELECT * FROM plan_tasks WHERE id = ? AND status = 'active'", taskId);
  if (!task) throw notFound('That task could not be found.');
  return { task, plan: ownPlan(db, userId, task.plan_id) };
}

/**
 * Edits a task or moves it (to a day, or to the backlog with `day: null`). Re-planning a task that
 * isn't overdue moves its planned day too; scheduling one from the backlog keeps the day it was first
 * planned for, so that day's history stays honest.
 */
export function updateTask(db: DB, userId: string, taskId: string, input: { day?: number | null; title?: string; estMinutes?: number | null; starred?: boolean }) {
  const { task, plan } = ownTask(db, userId, taskId);
  const list = spans(db, [plan.id]).get(plan.id)!;
  const day = input.day !== undefined ? input.day : task.day;
  checkDay(list, day);
  const onSchedule = task.day !== null && dateOf(plan, task.day) >= todayFor(db, userId);
  const plannedDay = day !== task.day && day !== null && (onSchedule || task.planned_day === null) ? day : task.planned_day;
  transaction(db, () => {
    const title = input.title ?? task.title;
    const est = input.estMinutes !== undefined ? input.estMinutes : task.est_minutes;
    run(
      db,
      'UPDATE plan_tasks SET day = ?, planned_day = ?, title = ?, est_minutes = ?, position = ?, starred = ?, updated_at = ? WHERE id = ?',
      day,
      plannedDay,
      title,
      est,
      day === task.day ? task.position : nextPosition(db, plan.id, day),
      input.starred === undefined ? task.starred : input.starred ? 1 : 0,
      Date.now(),
      taskId,
    );
    // Keep the room topic in step with the task.
    if (task.topic_id) run(db, 'UPDATE topics SET title = ?, estimated_minutes = ?, updated_at = ? WHERE id = ?', title, est, Date.now(), task.topic_id);
    if (day !== task.day) attachToRoom(db, userId, list, { ...task, day, title, est_minutes: est });
  });
}

/** Removes a task from the plan. Its room topic is archived, so study history is kept. */
export function removeTask(db: DB, userId: string, taskId: string) {
  const { task } = ownTask(db, userId, taskId);
  transaction(db, () => {
    if (task.topic_id && get(db, "SELECT 1 FROM topics WHERE id = ? AND status = 'active'", task.topic_id)) archiveTopic(db, userId, task.topic_id);
    run(db, "UPDATE plan_tasks SET status = 'archived', updated_at = ? WHERE id = ?", Date.now(), taskId);
  });
}

// ───────────── What to study next ─────────────

interface VisibleTask {
  topic_id: string;
  title: string;
  day: number;
  position: number;
  date: string;
}

/** Your open plan tasks shown in this room: scheduled today or later, in an open sprint pulled into it. */
function openRoomTasks(db: DB, userId: string, roomId: string): VisibleTask[] {
  const today = todayFor(db, userId);
  const rows = all<TaskRow & { start_date: string }>(
    db,
    `SELECT pt.*, p.start_date FROM plan_tasks pt
       JOIN plans p ON p.id = pt.plan_id
       JOIN topics tp ON tp.id = pt.topic_id
       LEFT JOIN topic_progress pr ON pr.topic_id = pt.topic_id AND pr.user_id = ?
      WHERE p.owner_id = ? AND p.status = 'active' AND pt.status = 'active' AND pt.day IS NOT NULL
        AND tp.room_id = ? AND tp.status = 'active' AND (pr.status IS NULL OR pr.status != 'completed')
      ORDER BY p.created_at, pt.day, pt.position`,
    userId,
    userId,
    roomId,
  );
  const lists = spans(db, [...new Set(rows.map((r) => r.plan_id))]);
  return rows
    .map((r) => ({ ...r, date: addDays(r.start_date, r.day!), sprint: sprintFor(lists.get(r.plan_id)!, r.day!) }))
    .filter((r) => r.date >= today && r.sprint?.room_id === roomId && !r.sprint.completed_at)
    .map((r) => ({ topic_id: r.topic_id!, title: r.title, day: r.day!, position: r.position, date: r.date }));
}

/** Today's first open task in this room, else the next upcoming one. */
export function nextPlanTopic(db: DB, userId: string, roomId: string): { id: string; title: string } | null {
  const today = todayFor(db, userId);
  const open = openRoomTasks(db, userId, roomId);
  const pick = open.find((t) => t.date === today) ?? open[0];
  return pick ? { id: pick.topic_id, title: pick.title } : null;
}

/** After finishing a plan task: the next open task that day, then the following days. */
export function nextPlanTopicAfter(db: DB, userId: string, roomId: string, topicId: string): { id: string; title: string } | null | undefined {
  const finished = get<{ day: number | null; position: number }>(db, "SELECT day, position FROM plan_tasks WHERE topic_id = ? AND status = 'active'", topicId);
  if (!finished) return undefined; // not a plan task
  const open = openRoomTasks(db, userId, roomId).filter((t) => t.topic_id !== topicId);
  const later = finished.day === null ? undefined : open.find((t) => t.day > finished.day! || (t.day === finished.day && t.position > finished.position));
  const pick = later ?? open[0];
  return pick ? { id: pick.topic_id, title: pick.title } : null;
}
