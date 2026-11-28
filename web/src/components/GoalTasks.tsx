// Tasks, the simple way: a goal is a list of tasks in a room, each with a date or none. Rooms and goal pages
// both use these pieces: one "Add a task" box, and a list grouped into Missed / Today / Upcoming / No date / Done.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { addDays, formatDate } from '@shared/dates';
import { formatMinutes } from '@shared/timer';
import type { GoalRef, GoalTask, RoomDetail } from '@shared/types';
import { api } from '../lib/api';
import { celebrate, plantGrowth } from '../lib/celebrate';
import { getFocusSettings } from '../lib/focusSettings';
import { useAction, useMe } from '../lib/queries';
import { toast } from '../lib/toast';
import { Field, fmt, Menu, Modal } from './ui';
import { CheckIcon, ChevronDown, PlayIcon } from './icons';
import { announce, MergeTopicModal, PartsMeter, SameNameHint, SubtopicPanel, type TopicChange } from './Subtopics';

const INVALIDATE = [['room'], ['rooms'], ['plan'], ['plans'], ['home'], ['tasks'], ['progress']];
const EST = [15, 30, 45, 60, 90];

/** Planned for today, or something you studied, ticked a part of, or completed today. */
export const isToday = (t: GoalTask, today: string) => t.date === today || Boolean(t.activeToday);

/** "Today", "Tomorrow", "Mon 24 Nov". */
export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  if (date === addDays(today, -1)) return 'Yesterday';
  return formatDate(date, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Today · Tomorrow · 📅 a date · No date. */
export function DateChoice({ value, onChange, today }: { value: string | null; onChange: (d: string | null) => void; today: string }) {
  const picker = useRef<HTMLInputElement>(null);
  const tomorrow = addDays(today, 1);
  const custom = value !== null && value !== today && value !== tomorrow;
  return (
    <div className="row wrap date-choice" role="group" aria-label="When" style={{ gap: 6 }}>
      <button type="button" className={`chip-btn${value === today ? ' on' : ''}`} aria-pressed={value === today} onClick={() => onChange(today)}>
        Today
      </button>
      <button type="button" className={`chip-btn${value === tomorrow ? ' on' : ''}`} aria-pressed={value === tomorrow} onClick={() => onChange(tomorrow)}>
        Tomorrow
      </button>
      <label className={`chip-btn date-pick${custom ? ' on' : ''}`}>
        📅 {custom ? dayLabel(value!, today) : 'Pick a day'}
        <input ref={picker} type="date" value={value ?? ''} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label="Pick a day" />
      </label>
      <button type="button" className={`chip-btn${value === null ? ' on' : ''}`} aria-pressed={value === null} onClick={() => onChange(null)}>
        No date
      </button>
    </div>
  );
}

/**
 * One box to add tasks. In a room, it goes into the goal you pick (your latest one by default; with no goal
 * yet, a "My tasks" goal is made for you). On a goal page, into that goal.
 */
export function AddTaskBox({ roomId, planId, goals = [], today, autoFocus, existing = [] }: { roomId?: string; planId?: string; goals?: GoalRef[]; today: string; autoFocus?: boolean; existing?: GoalTask[] }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState<string | null>(today);
  const [est, setEst] = useState<number | null>(null);
  const [goal, setGoal] = useState<string>(goals[0]?.id ?? '');
  const [open, setOpen] = useState(Boolean(autoFocus));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    if (!goals.some((g) => g.id === goal)) setGoal(goals[0]?.id ?? '');
  }, [goals.map((g) => g.id).join()]);

  const add = useAction(
    () =>
      planId
        ? api.post(`/plans/${planId}/goal-tasks`, { title: title.trim(), date, estMinutes: est })
        : api.post(`/rooms/${roomId}/tasks`, { title: title.trim(), date, estMinutes: est, planId: goal || null }),
    {
      invalidate: INVALIDATE,
      success: () => (date ? `Added for ${date === today || date === addDays(today, 1) ? dayLabel(date, today).toLowerCase() : dayLabel(date, today)} ✓` : 'Added ✓'),
      onSuccess: () => {
        setTitle('');
        input.current?.focus();
      },
    },
  );
  const submit = () => title.trim() && !add.isPending && add.mutate(undefined);

  return (
    <form
      className="card add-task stack"
      style={{ gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="row" style={{ gap: 8 }}>
        <input
          ref={input}
          className="input grow"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Add a task… e.g. Read chapter 4"
          maxLength={140}
          aria-label="New task"
        />
        <button className="btn primary" disabled={!title.trim() || add.isPending}>
          Add
        </button>
      </div>
      <SameNameHint title={title} existing={existing} onAdded={() => setTitle('')} />
      {open && (
        <>
          <DateChoice value={date} onChange={setDate} today={today} />
          <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="How long (optional)">
            {EST.map((m) => (
              <button key={m} type="button" className={`chip-btn small${est === m ? ' on' : ''}`} aria-pressed={est === m} onClick={() => setEst(est === m ? null : m)}>
                ~{formatMinutes(m)}
              </button>
            ))}
          </div>
          {!planId && goals.length > 1 && (
            <label className="row small" style={{ gap: 8 }}>
              <span className="muted">Goal</span>
              <select className="input" style={{ width: 'auto', minHeight: 36, padding: '4px 10px' }} value={goal} onChange={(e) => setGoal(e.target.value)}>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
    </form>
  );
}

type Group = { key: string; title: string; tasks: GoalTask[]; collapsed?: boolean; action?: React.ReactNode };

/** Your (or your friend's) tasks, grouped so today is always on top and nothing gets lost. */
export function TaskList({ tasks, today, isMe, active = true, showGoal, empty }: { tasks: GoalTask[]; today: string; isMe: boolean; active?: boolean; showGoal?: boolean; empty?: React.ReactNode }) {
  const elsewhere = tasks.filter((t) => !isToday(t, today));
  const missed = elsewhere.filter((t) => !t.done && t.date !== null && t.date < today);
  const todays = tasks.filter((t) => isToday(t, today)).sort((a, b) => Number(a.done) - Number(b.done));
  const upcoming = elsewhere.filter((t) => !t.done && t.date !== null && t.date > today).sort((a, b) => a.date!.localeCompare(b.date!));
  const soon = upcoming.filter((t) => t.date! <= addDays(today, 7));
  const later = upcoming.filter((t) => t.date! > addDays(today, 7));
  const undated = elsewhere.filter((t) => !t.done && t.date === null);
  const done = elsewhere.filter((t) => t.done).sort((a, b) => (b.doneDate ?? '').localeCompare(a.doneDate ?? ''));

  const groups: Group[] = [
    {
      key: 'missed',
      title: `Missed (${missed.length})`,
      tasks: missed,
      collapsed: missed.length > 5,
    },
    { key: 'today', title: 'Today', tasks: todays },
    { key: 'soon', title: 'Upcoming', tasks: soon },
    { key: 'later', title: `Later (${later.length})`, tasks: later, collapsed: true },
    { key: 'undated', title: 'No date', tasks: undated },
    { key: 'done', title: `Done (${done.length})`, tasks: done, collapsed: true },
  ].filter((g) => g.tasks.length || g.key === 'today');

  if (!tasks.length && empty) return <>{empty}</>;
  return (
    <div className="stack task-groups">
      {groups.map((g) => {
        const rows = (
          <div className="task-rows">
            {g.tasks.length ? (
              g.tasks.map((t) => <ItemRow key={t.id} item={t} today={today} isMe={isMe} active={active} showGoal={showGoal} showDate={g.key !== 'today'} />)
            ) : (
              <p className="small muted" style={{ margin: '4px 0' }}>
                Nothing planned for today.
              </p>
            )}
          </div>
        );
        return g.collapsed ? (
          <details key={g.key} className="task-group">
            <summary className="row between">
              <b className="small">{g.title}</b>
              {g.action}
            </summary>
            {rows}
          </details>
        ) : (
          <section key={g.key} className="task-group">
            <div className="row between">
              <b className="small">{g.title}</b>
              {g.action}
            </div>
            {rows}
          </section>
        );
      })}
    </div>
  );
}

function TaskRow({ task: t, siblings, today, isMe, active, showGoal, showDate }: { task: GoalTask; siblings: GoalTask[]; today: string; isMe: boolean; active: boolean; showGoal?: boolean; showDate: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [editing, setEditing] = useState(false);
  const openable = Boolean(t.topicId);
  const [expanded, setExpanded] = useState(false);
  const [merging, setMerging] = useState(false);
  const legacy = t.id.startsWith('topic:'); // a topic without a goal task (from before goals lived in rooms)
  const openParts = t.parts ? t.parts.total - t.parts.done : 0;
  const hasParts = Boolean(t.parts?.total);
  const complete = useAction(() => api.post(`/topics/${t.topicId}/complete`), {
    invalidate: INVALIDATE,
    onSuccess: () => {
      const room = qc.getQueriesData<RoomDetail>({ queryKey: ['room'] }).find(([, r]) => r?.tasks?.some((x) => x.topicId === t.topicId))?.[1];
      if (getFocusSettings().celebrate && me) celebrate({ topicTitle: t.title, roomName: room?.name ?? '', accent: me.accent, ...plantGrowth(room, me.id, me.today, t.topicId!) });
      else toast('Done 🌼', 'success');
    },
  });
  const undo = useAction(() => api.post(`/topics/${t.topicId}/reopen`, { mode: 'undo' }), { invalidate: INVALIDATE });
  const move = useAction((date: string | null) => api.patch(`/goal-tasks/${t.id}`, { date }), { invalidate: INVALIDATE });
  const remove = useAction(() => api.del(`/plan-tasks/${t.id}`), { invalidate: INVALIDATE, success: 'Task removed' });
  const canAct = isMe && active && Boolean(t.topicId);

  const meta = [
    showDate && t.date ? (t.date < today && !t.done ? `was ${dayLabel(t.date, today)}` : dayLabel(t.date, today)) : '',
    // In Today because of what you did, not because it was planned for today.
    t.activeToday && t.date !== today ? (t.done ? (t.doneDate === today ? 'done today' : 'revised today') : 'studied today') : '',
    showGoal && t.planTitle ? t.planTitle : '',
    t.estMinutes ? `~${formatMinutes(t.estMinutes)}` : '',
    t.focusedMs ? `${fmt(t.focusedMs)} spent` : '',
    t.description ? '📝' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="task-entry">
    <div className={`task-row${t.done ? ' done' : ''}`}>
      <button
        className="task-check"
        disabled={!canAct || complete.isPending || undo.isPending}
        onClick={() =>
          t.done
            ? confirm(t.parts?.total ? 'Mark this as not done? Its subtopics stay ticked; untick one to reopen it.' : 'Mark this as not done?') && undo.mutate(undefined)
            : (!openParts || confirm(`${openParts} of ${t.parts!.total} subtopics aren't done yet. Tick them all and complete “${t.title}”?`)) && complete.mutate(undefined)
        }
        aria-label={t.done ? `${t.title} is done. Mark as not done` : `Mark ${t.title} done`}
        aria-pressed={t.done}
      >
        {t.done && <CheckIcon width={15} />}
      </button>
      {openable ? (
        <button className="grow task-open" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={`${t.title}: ${expanded ? 'hide' : 'show'} description and subtopics`}>
          <span className="task-title">
            {t.title} <ChevronDown width={14} className="task-chevron" />
          </span>
          {meta && <span className="tiny muted">{meta}</span>}
          {t.parts?.total ? <PartsMeter done={t.parts.done} total={t.parts.total} /> : null}
        </button>
      ) : (
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="task-title">{t.title}</div>
          {meta && <div className="tiny muted">{meta}</div>}
        </div>
      )}
      {canAct && (
        <div className="row" style={{ gap: 4 }}>
          {!t.done && (
            <button className="btn small" onClick={() => navigate(`/study?topic=${t.topicId}`)} aria-label={`Study ${t.title}`}>
              <PlayIcon />
              <span className="hide-narrow">Study</span>
            </button>
          )}
          {(!legacy || openable) && (
            <Menu
              label={`More for ${t.title}`}
              items={[
                { label: 'Edit', onClick: () => setEditing(true), hidden: legacy },
                // A topic with subtopics is planned a subtopic at a time (open it to give each a day).
                { label: 'Do it today', onClick: () => move.mutate(today), hidden: legacy || t.date === today || t.done || hasParts },
                { label: 'Move to tomorrow', onClick: () => move.mutate(addDays(today, 1)), hidden: legacy || t.date === addDays(today, 1) || t.done || hasParts },
                { label: 'No date', onClick: () => move.mutate(null), hidden: legacy || t.date === null || t.done || hasParts },
                { label: 'Merge into another topic…', onClick: () => setMerging(true), hidden: !openable },
                { label: 'Remove', danger: true, onClick: () => confirm(`Remove “${t.title}”? Its study time stays in your history.`) && remove.mutate(undefined), hidden: legacy },
              ]}
            />
          )}
        </div>
      )}
      {editing && <EditTaskModal task={t} today={today} onClose={() => setEditing(false)} />}
      {merging && <MergeTopicModal task={t} candidates={siblings} onClose={() => setMerging(false)} />}
    </div>
    {openable && expanded && <SubtopicPanel topicId={t.topicId!} description={t.description ?? ''} canAct={canAct} />}
    </div>
  );
}

/** A goal's main topics, open ones first; open one to plan its subtopics. */
export function TopicList({ tasks, today, active }: { tasks: GoalTask[]; today: string; active: boolean }) {
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  return (
    <div className="stack task-groups">
      <section className="task-group">
        <b className="small">Topics ({open.length})</b>
        <div className="task-rows">
          {open.map((t) => (
            <TaskRow key={t.id} task={t} siblings={tasks} today={today} isMe active={active} showDate />
          ))}
          {!open.length && <p className="small muted" style={{ margin: '4px 0' }}>Every topic is done 🌼</p>}
        </div>
      </section>
      {done.length > 0 && (
        <details className="task-group">
          <summary>
            <b className="small">Done ({done.length})</b>
          </summary>
          <div className="task-rows">
            {done.map((t) => (
              <TaskRow key={t.id} task={t} siblings={tasks} today={today} isMe active={active} showDate />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** One planned item: a subtopic as "Topic › Subtopic", or a topic without subtopics. Tick it or start it. */
export function ItemRow({ item: t, today, isMe, active, showGoal, showDate, compact }: { item: GoalTask; today: string; isMe: boolean; active: boolean; showGoal?: boolean; showDate: boolean; compact?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canAct = isMe && active && Boolean(t.topicId);
  const inv = [...INVALIDATE, ['subtopics']];
  const tickPart = useAction(() => api.patch<{ topic: TopicChange }>(`/subtopics/${t.subtopicId}`, { done: !t.done }), { invalidate: inv, onSuccess: (r) => announce(r.topic) });
  const complete = useAction(() => api.post(`/topics/${t.topicId}/complete`), {
    invalidate: inv,
    onSuccess: () => {
      const room = qc.getQueriesData<RoomDetail>({ queryKey: ['room'] }).find(([, r]) => r?.tasks?.some((x) => x.topicId === t.topicId))?.[1];
      if (getFocusSettings().celebrate && me) celebrate({ topicTitle: t.title, roomName: room?.name ?? '', accent: me.accent, ...plantGrowth(room, me.id, me.today, t.topicId!) });
      else toast('Done 🌼', 'success');
    },
  });
  const undo = useAction(() => api.post(`/topics/${t.topicId}/reopen`, { mode: 'undo' }), { invalidate: inv });
  const busy = tickPart.isPending || complete.isPending || undo.isPending;
  const name = t.subtopicTitle ?? t.title;
  const tick = () => (t.subtopicId ? tickPart.mutate(undefined) : t.done ? confirm('Mark this as not done?') && undo.mutate(undefined) : complete.mutate(undefined));
  const meta = [
    showDate && t.date ? (t.date < today && !t.done ? `was ${dayLabel(t.date, today)}` : dayLabel(t.date, today)) : '',
    // In Today because of what you did, not because it was planned for today.
    t.activeToday && t.date !== today ? (t.done ? 'done today' : 'studied today') : '',
    showGoal && t.planTitle ? t.planTitle : '',
    t.estMinutes ? `~${formatMinutes(t.estMinutes)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="task-entry">
      <div className={`task-row${t.done ? ' done' : ''}${compact ? ' compact' : ''}`}>
        <button className="task-check" disabled={!canAct || busy} onClick={tick} aria-label={t.done ? `${name} is done. Mark as not done` : `Mark ${name} done`} aria-pressed={t.done}>
          {t.done && <CheckIcon width={15} />}
        </button>
        <div className="grow" style={{ minWidth: 0 }}>
          {t.subtopicId && <div className="tiny muted part-of">{t.title} ›</div>}
          <div className="task-title">{name}</div>
          {meta && <div className="tiny muted">{meta}</div>}
        </div>
        {canAct && !t.done && (
          <button className={`btn small${compact ? ' icon' : ''}`} onClick={() => navigate(`/study?topic=${t.topicId}${t.subtopicId ? `&sub=${t.subtopicId}` : ''}`)} aria-label={`Start ${name}`}>
            <PlayIcon />
            {!compact && <span className="hide-narrow">Start</span>}
          </button>
        )}
      </div>
    </div>
  );
}

function EditTaskModal({ task, today, onClose }: { task: GoalTask; today: string; onClose: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [date, setDate] = useState<string | null>(task.date);
  const [est, setEst] = useState(task.estMinutes ? String(task.estMinutes) : '');
  const save = useAction(() => api.patch(`/goal-tasks/${task.id}`, { title: title.trim(), date, estMinutes: est ? Number(est) : null }), {
    invalidate: INVALIDATE,
    success: 'Saved',
    onSuccess: onClose,
  });
  return (
    <Modal
      title="Edit task"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!title.trim() || save.isPending} onClick={() => save.mutate(undefined)}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Task">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} />
        </Field>
        <Field label="When">
          <DateChoice value={date} onChange={setDate} today={today} />
        </Field>
        <Field label="Minutes (optional)">
          <input className="input" type="number" min="1" max="1440" inputMode="numeric" value={est} onChange={(e) => setEst(e.target.value)} style={{ maxWidth: 140 }} />
        </Field>
      </div>
    </Modal>
  );
}
