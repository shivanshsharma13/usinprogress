// The room's plan by date: what each of you planned in your goals (subtopics as "Topic › Subtopic", topics without
// subtopics whole), shown for 7 days or a month. You tick and start your own from here; planning happens in the goal.
import { addDays, addMonths, endOfMonth, formatDate, startOfMonth, startOfWeek } from '@shared/dates';
import { formatMinutes } from '@shared/timer';
import { plannedItems } from '@shared/planView';
import type { GoalTask, MemberProgress, RoomDetail, Topic } from '@shared/types';
import { personVars } from '../lib/theme';
import { Avatar } from './ui';
import { ItemRow } from './GoalTasks';
import { ChevronLeft, ChevronRight } from './icons';

export type RoomView = 'day' | 'week' | 'month';

/** One person's planned items in this room: from their goals, plus topics not in a goal. */
export function memberItems(room: RoomDetail, ownerId: string, topicAsTask: (t: Topic, ownerId: string) => GoalTask): GoalTask[] {
  const linked = new Set(room.tasks.map((t) => t.topicId));
  return plannedItems([
    ...room.tasks.filter((t) => t.ownerId === ownerId),
    ...room.topics.filter((t) => t.createdBy === ownerId && !linked.has(t.id)).map((t) => topicAsTask(t, ownerId)),
  ]);
}

type Person = { member: MemberProgress; isMe: boolean; items: GoalTask[] };

const label = (date: string, today: string) =>
  date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : formatDate(date, { weekday: 'short', day: 'numeric', month: 'short' });

/** Seven days side by side (stacked on a phone), both of you in each day. */
export function WeekPlan({ people, today, active, start, onStart }: { people: Person[]; today: string; active: boolean; start: string; onStart: (d: string) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div className="stack">
      <div className="row between">
        <button className="btn ghost icon" onClick={() => onStart(addDays(start, -7))} aria-label="Previous 7 days">
          <ChevronLeft />
        </button>
        <b className="small">
          {formatDate(days[0], { day: 'numeric', month: 'short' })} – {formatDate(days[6], { day: 'numeric', month: 'short' })}
          {start !== today && (
            <button className="link-btn small" style={{ marginLeft: 8 }} onClick={() => onStart(today)}>
              Today
            </button>
          )}
        </b>
        <button className="btn ghost icon" onClick={() => onStart(addDays(start, 7))} aria-label="Next 7 days">
          <ChevronRight />
        </button>
      </div>
      <div className="week-plan">
        {days.map((d) => {
          const planned = people.flatMap((p) => p.items.filter((t) => t.date === d).map((t) => ({ t, p })));
          const minutes = planned.reduce((sum, { t }) => sum + (t.done ? 0 : (t.estMinutes ?? 0)), 0);
          return (
            <section key={d} className={`week-day card${d === today ? ' is-today' : ''}${d < today ? ' is-past' : ''}`} aria-label={label(d, today)}>
              <div className="week-day-head">
                <b className="small">{label(d, today)}</b>
                {minutes > 0 && <span className="tiny muted">~{formatMinutes(minutes)}</span>}
              </div>
              {planned.length ? (
                planned
                  .sort((a, b) => Number(a.t.done) - Number(b.t.done))
                  .map(({ t, p }) => (
                    <div key={t.id} className="week-item" style={personVars(p.member.user.accent)} title={p.isMe ? 'Yours' : p.member.user.displayName}>
                      <ItemRow item={t} today={today} isMe={p.isMe} active={active} showDate={false} compact />
                    </div>
                  ))
              ) : (
                <span className="tiny muted">Nothing planned</span>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** A month at a glance: how much each of you planned per day. Tap a day to see its week. */
export function MonthPlan({ people, today, month, onMonth, onPickDay }: { people: Person[]; today: string; month: string; onMonth: (m: string) => void; onPickDay: (d: string) => void }) {
  const first = startOfMonth(month);
  const last = endOfMonth(month);
  const gridStart = startOfWeek(first);
  const cells: string[] = [];
  for (let d = gridStart; d <= last || cells.length % 7; d = addDays(d, 1)) cells.push(d);
  return (
    <div className="stack">
      <div className="row between">
        <button className="btn ghost icon" onClick={() => onMonth(addMonths(first, -1))} aria-label="Previous month">
          <ChevronLeft />
        </button>
        <b className="small">{formatDate(first, { month: 'long', year: 'numeric' })}</b>
        <button className="btn ghost icon" onClick={() => onMonth(addMonths(first, 1))} aria-label="Next month">
          <ChevronRight />
        </button>
      </div>
      <div className="month-plan" role="grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => (
          <span key={w} className="tiny muted month-head">
            {w}
          </span>
        ))}
        {cells.map((d) => {
          const counts = people.map((p) => {
            const list = p.items.filter((t) => t.date === d);
            return { p, total: list.length, done: list.filter((t) => t.done).length };
          });
          const any = counts.some((c) => c.total);
          return (
            <button
              key={d}
              className={`month-cell${d === today ? ' is-today' : ''}${d < first || d > last ? ' other' : ''}`}
              onClick={() => onPickDay(d)}
              aria-label={`${formatDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}: ${counts.map((c) => `${c.p.isMe ? 'you' : c.p.member.user.displayName} ${c.done} of ${c.total}`).join(', ')}`}
            >
              <span className="num">{Number(d.slice(8))}</span>
              {any &&
                counts
                  .filter((c) => c.total)
                  .map((c) => (
                    <span key={c.p.member.user.id} className="month-count num" style={personVars(c.p.member.user.accent)}>
                      {c.done === c.total ? '✓' : `${c.done}/${c.total}`}
                    </span>
                  ))}
            </button>
          );
        })}
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        {people.map((p) => (
          <span key={p.member.user.id} className="row tiny" style={{ gap: 6, ...personVars(p.member.user.accent) }}>
            <Avatar user={p.member.user} size={18} /> {p.isMe ? 'You' : p.member.user.displayName}: done/planned
          </span>
        ))}
      </div>
    </div>
  );
}

export function ViewToggle({ value, onChange }: { value: RoomView; onChange: (v: RoomView) => void }) {
  return (
    <div className="row" style={{ gap: 6 }} role="group" aria-label="Show">
      {(['day', 'week', 'month'] as const).map((v) => (
        <button key={v} className={`chip-btn${value === v ? ' on' : ''}`} aria-pressed={value === v} onClick={() => onChange(v)}>
          {v === 'day' ? 'Day' : v === 'week' ? '7 days' : 'Month'}
        </button>
      ))}
    </div>
  );
}
