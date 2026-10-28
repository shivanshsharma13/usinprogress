// Goal plans, computed from raw rows: plan → sprints → days → tasks. Pure functions, no I/O.
//
// Sprints run back to back, so day N of a plan is start_date + N. A task is scheduled on a day or
// parked in the backlog (day null). An unfinished task on a past day also counts as backlog; it never
// moves forward on its own. A past day is judged by what was planned for it and done by that date.
import { addDays } from './dates.ts';
import type { DayStatus, Plan, PlanDay, PlanSprint, PlanSummary, PlanTask } from './types.ts';

export interface PlanRow {
  id: string;
  owner_id: string;
  title: string;
  start_date: string;
  sprint_days: number;
  status: 'active' | 'archived';
  created_at: number;
}

export interface SprintRow {
  plan_id: string;
  number: number;
  days: number;
  room_id: string | null;
  room_name: string | null;
  completed_at: number | null;
}

/** A sprint with the plan days it covers (first..last, inclusive). */
export interface SprintSpan extends SprintRow {
  first: number;
  last: number;
}

export const dateOf = (plan: Pick<PlanRow, 'start_date'>, day: number) => addDays(plan.start_date, day);
/** The day a task belongs to for history and sprint totals. */
const homeDay = (t: { day: number | null; plannedDay: number | null }) => t.plannedDay ?? t.day;

export function spansOf(rows: SprintRow[]): SprintSpan[] {
  let first = 0;
  return [...rows]
    .sort((a, b) => a.number - b.number)
    .map((r) => {
      const span = { ...r, first, last: first + r.days - 1 };
      first += r.days;
      return span;
    });
}

export const sprintFor = (list: SprintSpan[], day: number) => list.find((s) => day >= s.first && day <= s.last);

export const isBacklog = (plan: PlanRow, t: PlanTask, today: string) => !t.done && (t.day === null || dateOf(plan, t.day) < today);

export function buildDay(plan: PlanRow, day: number, tasks: PlanTask[], today: string): PlanDay {
  const date = dateOf(plan, day);
  if (date >= today) {
    return { day, number: day + 1, date, status: date === today ? 'today' : 'upcoming', tasks: tasks.filter((t) => t.day === day) };
  }
  const list = tasks.filter((t) => t.day === day || t.plannedDay === day);
  const onTime = list.filter((t) => t.doneDate !== null && t.doneDate <= date).length;
  const status: DayStatus = !list.length ? 'rest' : onTime === list.length ? 'done' : onTime ? 'partial' : 'missed';
  return { day, number: day + 1, date, status, tasks: list };
}

export function buildSprint(plan: PlanRow, s: SprintSpan, tasks: PlanTask[], today: string): PlanSprint {
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

export function summarizePlan(plan: PlanRow, sprints: SprintSpan[], tasks: PlanTask[], today: string): PlanSummary {
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

export function buildPlan(plan: PlanRow, sprints: SprintSpan[], tasks: PlanTask[], today: string): Plan {
  return {
    ...summarizePlan(plan, sprints, tasks, today),
    sprints: sprints.map((s) => buildSprint(plan, s, tasks, today)),
    backlogTasks: tasks.filter((t) => isBacklog(plan, t, today)).sort((a, b) => (homeDay(a) ?? Infinity) - (homeDay(b) ?? Infinity)),
  };
}
