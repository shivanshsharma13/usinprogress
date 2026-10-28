// One goal: stats, its sprints (current / upcoming / completed), the backlog, each sprint's days and
// tasks, and a side panel with what to start next and today's progress.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatDate } from '@shared/dates';
import { formatMinutes } from '@shared/timer';
import type { Plan, PlanDay, PlanSprint, PlanTask } from '@shared/types';
import { useAction, useMe, usePlan, useRooms } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { ErrorNote, Field, fmt, Menu, Modal, ProgressBar, Spinner } from '../components/ui';
import { DAY_STATUS_LABEL, percent } from '../components/PlanBits';
import { CalendarIcon, CheckIcon, ChevronDown, ChevronRight, PlayIcon, PlusIcon } from '../components/icons';

type Tab = 'current' | 'upcoming' | 'completed' | 'backlog';

const dayTitle = (d: { number: number; date: string }) => `Day ${d.number} – ${formatDate(d.date, { day: 'numeric', month: 'short' })} (${formatDate(d.date, { weekday: 'long' })})`;
const timeVsEstimate = (ms: number, est: number) => `${fmt(ms)}${est ? ` / ~${formatMinutes(est)}` : ''}`;

export function PlanPage() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data: plan, isLoading, error, refetch } = usePlan(id);
  const [tab, setTab] = useState<Tab>('current');
  const [renaming, setRenaming] = useState(false);
  const [addingSprint, setAddingSprint] = useState(false);
  const navigate = useNavigate();
  const update = useAction((body: object) => api.patch(`/plans/${id}`, body), { invalidate: [['plan', id!], ['plans']] });

  if (isLoading || !me) return <Spinner />;
  if (error || !plan) return <ErrorNote error={error} retry={refetch} />;

  const today = me.today;
  // The current sprint is the earliest started one you haven't reviewed yet.
  const current = plan.sprints.find((s) => !s.completedAt && s.startDate <= today) ?? null;
  const upcoming = plan.sprints.filter((s) => !s.completedAt && s !== current);
  const completed = plan.sprints.filter((s) => s.completedAt);
  const last = plan.sprints[plan.sprints.length - 1];
  const shown = tab === 'current' ? (current ? [current] : []) : tab === 'upcoming' ? upcoming : tab === 'completed' ? completed : [];

  return (
    <div className="plan-layout">
      <div className="stack-lg" style={{ minWidth: 0 }}>
        <div className="small muted">
          <Link to="/goals">Goals</Link> / {plan.title}
        </div>
        <div className="row between">
          <h1>{plan.title}</h1>
          <Menu
            items={[
              { label: 'Rename', onClick: () => setRenaming(true) },
              { label: 'Archive goal', danger: true, onClick: () => confirm('Archive this goal? Its history stays.') && update.mutate({ status: 'archived' }, { onSuccess: () => navigate('/goals') }), hidden: plan.status === 'archived' },
              { label: 'Restore goal', onClick: () => update.mutate({ status: 'active' }), hidden: plan.status === 'active' },
            ]}
          />
        </div>

        <div className="plan-stats card">
          <Stat label="Sprints" value={`${plan.sprintsCompleted} / ${plan.sprintCount}`} />
          <Stat label="Time spent" value={fmt(plan.focusedMs)} />
          <Stat label="Started on" value={formatDate(plan.startDate, { day: 'numeric', month: 'short', year: 'numeric' })} />
          <Stat label="Est. completion" value={formatDate(plan.endDate, { day: 'numeric', month: 'short', year: 'numeric' })} />
        </div>

        <div className="row between wrap">
          <div className="tabs" role="tablist">
            {(
              [
                ['current', 'Current sprint'],
                ['upcoming', `Upcoming (${upcoming.length})`],
                ['completed', `Completed (${completed.length})`],
                ['backlog', `Backlog (${plan.backlog})`],
              ] as const
            ).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
          <button className="btn small" onClick={() => setAddingSprint(true)}>
            <PlusIcon /> Add sprint
          </button>
        </div>

        {tab === 'backlog' && <Backlog plan={plan} today={today} />}
        {tab === 'current' && !current && (
          <div className="card soft small muted">
            {today < plan.startDate
              ? `This goal starts on ${formatDate(plan.startDate, { day: 'numeric', month: 'long' })}. Plan its days under Upcoming.`
              : last && last.endDate < today
                ? 'You’ve reached the end of your last sprint. Add a sprint to keep going.'
                : 'Every sprint so far is reviewed. Nice work 🌸'}
          </div>
        )}
        {(tab === 'upcoming' || tab === 'completed') && !shown.length && <p className="small muted">Nothing here yet.</p>}
        {shown.map((s) => (
          <SprintCard key={s.number} plan={plan} sprint={s} isLast={s.number === last.number} today={today} defaultOpen={tab === 'current'} />
        ))}
      </div>

      <TodayPanel plan={plan} today={today} openBacklog={() => setTab('backlog')} />

      {renaming && <RenameModal plan={plan} onClose={() => setRenaming(false)} />}
      {addingSprint && <SprintLengthModal plan={plan} onClose={() => setAddingSprint(false)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tiny muted">{label}</div>
      <div className="bold num">{value}</div>
    </div>
  );
}

// ───────────── Sprints and days ─────────────

function SprintCard({ plan, sprint, isLast, today, defaultOpen }: { plan: Plan; sprint: PlanSprint; isLast: boolean; today: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [pulling, setPulling] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [resizing, setResizing] = useState(false);
  const inv = [['plan', plan.id], ['plans'], ['room'], ['rooms']];
  const reopen = useAction(() => api.post(`/plans/${plan.id}/sprints/${sprint.number}/reopen`), { invalidate: inv });
  const unpull = useAction(() => api.post(`/plans/${plan.id}/sprints/${sprint.number}/unpull`), { invalidate: inv, success: 'Sprint taken out of the room' });
  const remove = useAction(() => api.del(`/plans/${plan.id}/sprints/${sprint.number}`), { invalidate: inv, success: 'Sprint removed' });
  const daysDone = sprint.days.filter((d) => d.status === 'done').length;
  const hasTasks = sprint.total > 0;

  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row between wrap">
        <button className="row btn ghost" style={{ padding: '4px 6px', minHeight: 0 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown /> : <ChevronRight />}
          <h2>Sprint {sprint.number}</h2>
          <span className="small muted">
            {daysDone}/{sprint.length} days completed · {formatDate(sprint.startDate)} – {formatDate(sprint.endDate)}
          </span>
        </button>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="small muted num">{timeVsEstimate(sprint.focusedMs, sprint.estMinutes)}</span>
          {sprint.roomId ? (
            <Link to={`/rooms/${sprint.roomId}`} className="chip c">
              In {sprint.roomName}
            </Link>
          ) : (
            !sprint.completedAt && (
              <button className="btn small" onClick={() => setPulling(true)}>
                Pull into room
              </button>
            )
          )}
          {sprint.completedAt ? (
            <button className="btn small" onClick={() => reopen.mutate(undefined)}>
              Reopen
            </button>
          ) : (
            <button className="btn small" onClick={() => setReviewing(true)}>
              Review & complete
            </button>
          )}
          <Menu
            label={`More actions for sprint ${sprint.number}`}
            items={[
              { label: 'Change length', onClick: () => setResizing(true), hidden: sprint.endDate < today },
              { label: 'Remove from room', onClick: () => confirm(`Take sprint ${sprint.number} out of ${sprint.roomName}? Its topics are archived there and come back if you pull it in again.`) && unpull.mutate(undefined), hidden: !sprint.roomId },
              { label: 'Remove sprint', danger: true, onClick: () => remove.mutate(undefined), hidden: !isLast || hasTasks || Boolean(sprint.roomId) || plan.sprintCount === 1 },
            ]}
          />
        </div>
      </div>
      {open && sprint.days.map((d) => <DayRow key={d.day} plan={plan} day={d} pulled={Boolean(sprint.roomId)} today={today} />)}
      {pulling && <PullModal plan={plan} sprint={sprint} onClose={() => setPulling(false)} />}
      {reviewing && <ReviewModal plan={plan} sprint={sprint} onClose={() => setReviewing(false)} />}
      {resizing && <SprintLengthModal plan={plan} sprint={sprint} onClose={() => setResizing(false)} />}
    </div>
  );
}

function DayRow({ plan, day, pulled, today }: { plan: Plan; day: PlanDay; pulled: boolean; today: string }) {
  const [open, setOpen] = useState(day.date === today);
  const isToday = day.status === 'today';
  const past = day.date < today;
  const label = DAY_STATUS_LABEL[day.status];
  return (
    <div className={`day-row${isToday ? ' today' : ''}`}>
      {isToday && <span className="today-tag">Today</span>}
      <button className="day-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <CalendarIcon width={16} />
        <span className={isToday ? 'bold' : ''}>{dayTitle(day)}</span>
        {day.tasks.length > 0 && (
          <span className="tiny muted">
            · {day.tasks.length} {day.tasks.length === 1 ? 'task' : 'tasks'}
          </span>
        )}
        <span className="grow" />
        {!isToday && label && <span className={`tiny day-status ${day.status}`}>{label}</span>}
        {open ? <ChevronDown width={16} /> : <ChevronRight width={16} />}
      </button>
      {open && (
        <div className="day-body">
          {past ? (
            // Past days are history: what was planned, and whether it got done that day.
            day.tasks.length ? (
              day.tasks.map((t) => <HistoryLine key={t.id} plan={plan} task={t} day={day} />)
            ) : (
              <p className="small muted">Nothing was planned.</p>
            )
          ) : (
            <>
              {day.tasks.length > 0 && (
                <div className="task-line head tiny muted">
                  <span />
                  <span />
                  <span>Time spent</span>
                  <span>Est. time</span>
                  <span />
                  <span />
                </div>
              )}
              {day.tasks.map((t, i) => (
                <TaskLine key={t.id} plan={plan} task={t} index={i} pulled={pulled} today={today} />
              ))}
              <AddTask planId={plan.id} day={day.day} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A task as it stands for a past day: done that day, done later, moved, or waiting in the backlog. */
function HistoryLine({ plan, task: t, day }: { plan: Plan; task: PlanTask; day: PlanDay }) {
  const onTime = t.doneDate !== null && t.doneDate <= day.date;
  const movedTo = t.day !== null && t.day !== day.day ? plan.sprints.flatMap((s) => s.days).find((d) => d.day === t.day) : undefined;
  const note = onTime ? 'Done' : t.done ? `Done later (${formatDate(t.doneDate!)})` : movedTo ? `Moved to day ${movedTo.number}` : 'In backlog';
  return (
    <div className={`task-line${onTime ? ' done' : ''}`}>
      <span className={`check-dot${onTime ? ' on' : ''}`} aria-hidden="true">
        <CheckIcon width={12} />
      </span>
      <span className="title">{t.title}</span>
      <span className="num small muted">{t.focusedMs ? fmt(t.focusedMs) : '—'}</span>
      <span className="tiny muted" style={{ gridColumn: 'span 3' }}>
        {note}
      </span>
    </div>
  );
}

function TaskLine({ plan, task: t, index, pulled, today }: { plan: Plan; task: PlanTask; index: number; pulled: boolean; today: string }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const inv = [['plan', plan.id], ['plans'], ['room'], ['rooms']];
  const complete = useAction(() => api.post(`/topics/${t.topicId}/complete`), { invalidate: inv, success: 'Done 🌼' });
  const undo = useAction(() => api.post(`/topics/${t.topicId}/reopen`, { mode: 'undo' }), { invalidate: inv });
  const patch = useAction((body: object) => api.patch(`/plan-tasks/${t.id}`, body), { invalidate: inv });
  const remove = useAction(() => api.del(`/plan-tasks/${t.id}`), { invalidate: inv, success: 'Task removed' });
  const toggle = () => {
    if (!t.topicId) return;
    if (t.done) confirm('Mark this as not done?') && undo.mutate(undefined);
    else complete.mutate(undefined);
  };

  return (
    <div className={`task-line${t.done ? ' done' : ''}`}>
      <button
        className={`check-dot${t.done ? ' on' : ''}`}
        onClick={toggle}
        disabled={!t.topicId || complete.isPending || undo.isPending}
        aria-label={t.done ? `Mark “${t.title}” not done` : `Mark “${t.title}” done`}
        title={t.topicId ? '' : 'Pull this sprint into a room to study and tick it off'}
      >
        <CheckIcon width={12} />
      </button>
      <span className="title">
        {index + 1}. {t.title}
      </span>
      <span className="num small muted">{t.focusedMs ? fmt(t.focusedMs) : '—'}</span>
      <span className="num small">{t.estMinutes ? formatMinutes(t.estMinutes) : '—'}</span>
      <button className={`btn ghost icon small star${t.starred ? ' on' : ''}`} onClick={() => patch.mutate({ starred: !t.starred })} aria-label={t.starred ? 'Remove from revision list' : 'Add to revision list'} aria-pressed={t.starred}>
        {t.starred ? '★' : '☆'}
      </button>
      <Menu
        label={`More actions for ${t.title}`}
        items={[
          { label: 'Study now', onClick: () => navigate(`/study?topic=${t.topicId}`), hidden: !t.topicId || t.done || !pulled },
          { label: 'Edit or move', onClick: () => setEditing(true) },
          { label: 'Move to backlog', onClick: () => patch.mutate({ day: null }), hidden: t.done },
          { label: 'Remove', danger: true, onClick: () => confirm(`Remove “${t.title}”? Any study time stays in your history.`) && remove.mutate(undefined) },
        ]}
      />
      {editing && <TaskModal plan={plan} task={t} today={today} onClose={() => setEditing(false)} />}
    </div>
  );
}

function AddTask({ planId, day }: { planId: string; day: number | null }) {
  const [title, setTitle] = useState('');
  const [est, setEst] = useState('');
  const add = useAction(() => api.post(`/plans/${planId}/tasks`, { day, title, estMinutes: est ? Number(est) : null }), {
    invalidate: [['plan', planId], ['plans'], ['room'], ['rooms']],
    onSuccess: () => {
      setTitle('');
      setEst('');
    },
  });
  return (
    <form
      className="row"
      style={{ gap: 6, marginTop: 4 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) add.mutate(undefined);
      }}
    >
      <input className="input grow" placeholder={day === null ? 'Add to backlog…' : 'Add a task…'} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} aria-label="New task" />
      <input className="input" style={{ width: 86 }} type="number" min="1" inputMode="numeric" placeholder="min" value={est} onChange={(e) => setEst(e.target.value)} aria-label="Estimated minutes" />
      <button className="btn icon" disabled={!title.trim() || add.isPending} aria-label="Add task">
        <PlusIcon />
      </button>
    </form>
  );
}

// ───────────── Backlog ─────────────

/** Unfinished tasks from past days (or parked on purpose). Nothing leaves here until you schedule it. */
function Backlog({ plan, today }: { plan: Plan; today: string }) {
  const [moving, setMoving] = useState<PlanTask | null>(null);
  const days = plan.sprints.flatMap((s) => s.days);
  const todayDay = days.find((d) => d.date === today);
  const inv = [['plan', plan.id], ['plans'], ['room'], ['rooms']];
  const schedule = useAction(({ id, day }: { id: string; day: number }) => api.patch(`/plan-tasks/${id}`, { day }), { invalidate: inv, success: 'Scheduled' });

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <p className="small muted">Tasks you didn't finish on their day land here. They stay out of your room until you schedule them again.</p>
      {plan.backlogTasks.length === 0 && <p className="small">Your backlog is empty 🌱</p>}
      {plan.backlogTasks.map((t) => {
        const from = days.find((d) => d.day === (t.plannedDay ?? t.day));
        return (
          <div key={t.id} className="list-item" style={{ padding: '8px 0' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="bold small">{t.title}</div>
              <div className="tiny muted">
                {from ? `From day ${from.number} · ${formatDate(from.date)}` : 'Parked'}
                {t.estMinutes ? ` · ~${formatMinutes(t.estMinutes)}` : ''}
              </div>
            </div>
            {todayDay && (
              <button className="btn small" disabled={schedule.isPending} onClick={() => schedule.mutate({ id: t.id, day: todayDay.day })}>
                Do today
              </button>
            )}
            <button className="btn small ghost" onClick={() => setMoving(t)}>
              Pick a day
            </button>
          </div>
        );
      })}
      <AddTask planId={plan.id} day={null} />
      {moving && <TaskModal plan={plan} task={moving} today={today} onClose={() => setMoving(null)} />}
    </div>
  );
}

// ───────────── Side panel ─────────────

function TodayPanel({ plan, today, openBacklog }: { plan: Plan; today: string; openBacklog: () => void }) {
  const navigate = useNavigate();
  const [pulling, setPulling] = useState<PlanSprint | null>(null);
  const [revision, setRevision] = useState(false);
  const sprint = plan.sprints.find((s) => s.startDate <= today && s.endDate >= today);
  const day = sprint?.days.find((d) => d.date === today);
  const tasks = day?.tasks ?? [];
  const nextIndex = tasks.findIndex((t) => !t.done);
  const next = nextIndex >= 0 ? tasks[nextIndex] : null;
  const done = tasks.filter((t) => t.done).length;
  const starred = plan.sprints.flatMap((s) => s.days.flatMap((d) => d.tasks.filter((t) => t.starred && t.day === d.day).map((t) => ({ ...t, dayNumber: d.number }))));

  return (
    <aside className="plan-side stack">
      <div className="card stack" style={{ gap: 12 }}>
        {day && sprint ? (
          next ? (
            <>
              <span className="section-label">
                Start day {day.number} – task {nextIndex + 1}
              </span>
              {next.topicId && sprint.roomId ? (
                <button className="next-task" onClick={() => navigate(`/study?topic=${next.topicId}`)}>
                  <span className="bold">{next.title}</span>
                  <span className="go">
                    <PlayIcon width={16} />
                  </span>
                </button>
              ) : (
                <>
                  <div className="bold">{next.title}</div>
                  <button className="btn primary" onClick={() => setPulling(sprint)}>
                    Pull sprint {sprint.number} into a room to start
                  </button>
                </>
              )}
            </>
          ) : (
            <p className="small muted">{tasks.length ? 'Everything for today is done 🌸' : `Nothing planned for day ${day.number}. Add tasks to today, or bring some in from the backlog.`}</p>
          )
        ) : (
          <p className="small muted">{today < plan.startDate ? `Starts ${formatDate(plan.startDate)}.` : 'No sprint covers today. Add a sprint to keep going.'}</p>
        )}

        {day && (
          <div className="stack" style={{ gap: 8 }}>
            <span className="section-label">Today's progress</span>
            <Row label="Tasks" value={`${done} / ${tasks.length}`} />
            <Row label="Time spent" value={fmt(tasks.reduce((s, t) => s + t.focusedMs, 0))} />
            <Row label="Scheduled" value={formatMinutes(tasks.reduce((s, t) => s + (t.estMinutes ?? 0), 0)) || '—'} />
            <div className="row" style={{ gap: 10 }}>
              <span className="small muted grow">Progress</span>
              <div style={{ width: 90 }}>
                <ProgressBar value={done} max={tasks.length} thin />
              </div>
              <span className="small num">{percent(done, tasks.length)}%</span>
            </div>
          </div>
        )}
      </div>

      <div className="card row between">
        <span className="bold">Backlog</span>
        <button className="btn ghost small" onClick={openBacklog}>
          {plan.backlog ? `${plan.backlog} waiting` : 'Empty'}
        </button>
      </div>

      <div className="card row between">
        <span className="bold">★ Revision list</span>
        <button className="btn ghost small" onClick={() => setRevision(true)}>
          View all ({starred.length})
        </button>
      </div>

      {pulling && <PullModal plan={plan} sprint={pulling} onClose={() => setPulling(null)} />}
      {revision && (
        <Modal title="Revision list" onClose={() => setRevision(false)}>
          {starred.length ? (
            <div className="list">
              {starred.map((t) => (
                <div key={t.id} className="list-item">
                  <span className="grow">
                    <span className="bold small">{t.title}</span>
                    <span className="tiny muted"> · Day {t.dayNumber}</span>
                  </span>
                  {t.topicId && (
                    <button className="btn small" onClick={() => navigate(`/study?topic=${t.topicId}`)}>
                      <PlayIcon /> Revise
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="small muted">Star (☆) a task to keep it here for revision.</p>
          )}
        </Modal>
      )}
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between small">
      <span className="muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

// ───────────── Dialogs ─────────────

function PullModal({ plan, sprint, onClose }: { plan: Plan; sprint: PlanSprint; onClose: () => void }) {
  const { data: rooms } = useRooms();
  const active = (rooms ?? []).filter((r) => r.status === 'active');
  const [roomId, setRoomId] = useState('');
  const chosen = roomId || active[0]?.id || '';
  const [err, setErr] = useState<string | null>(null);
  const pull = useAction(() => api.post(`/plans/${plan.id}/sprints/${sprint.number}/pull`, { roomId: chosen }), {
    invalidate: [['plan', plan.id], ['plans'], ['room'], ['rooms']],
    success: `Sprint ${sprint.number} is in the room 🌱`,
    onSuccess: onClose,
    onError: (e: ApiError) => {
      setErr(e.message);
      return true;
    },
  });
  return (
    <Modal
      title={`Pull sprint ${sprint.number} into a room`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!chosen || pull.isPending} onClick={() => pull.mutate(undefined)}>
            Pull into room
          </button>
        </>
      }
    >
      {active.length ? (
        <div className="stack">
          <p className="small muted">Its tasks for today onwards show up in your column of the room. You study them there, and your friend sees your progress. Backlog tasks stay out until you schedule them.</p>
          <Field label="Room">
            <select className="input" value={chosen} onChange={(e) => setRoomId(e.target.value)}>
              {active.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          {err && <div className="banner error">{err}</div>}
        </div>
      ) : (
        <p className="small">
          You don't have a room yet. <Link to="/rooms?new=1">Create one with your friend</Link> first.
        </p>
      )}
    </Modal>
  );
}

/** Add a sprint (no `sprint`) or change an existing sprint's length. */
function SprintLengthModal({ plan, sprint, onClose }: { plan: Plan; sprint?: PlanSprint; onClose: () => void }) {
  const [days, setDays] = useState(String(sprint?.length ?? plan.sprintDays));
  const [err, setErr] = useState<string | null>(null);
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 60;
  const save = useAction(() => (sprint ? api.patch(`/plans/${plan.id}/sprints/${sprint.number}`, { days: n }) : api.post(`/plans/${plan.id}/sprints`, { days: n })), {
    invalidate: [['plan', plan.id], ['plans'], ['room'], ['rooms']],
    success: sprint ? 'Sprint updated' : 'Sprint added',
    onSuccess: onClose,
    onError: (e: ApiError) => {
      setErr(e.message);
      return true;
    },
  });
  return (
    <Modal
      title={sprint ? `Sprint ${sprint.number} length` : `Add sprint ${plan.sprintCount + 1}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || save.isPending} onClick={() => save.mutate(undefined)}>
            {sprint ? 'Save' : 'Add sprint'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Days in this sprint" hint={sprint ? 'Later sprints move with it.' : `It starts the day after ${formatDate(plan.endDate, { day: 'numeric', month: 'short' })}.`}>
          <input className="input" type="number" min="1" max="60" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} autoFocus />
        </Field>
        {err && <div className="banner error">{err}</div>}
      </div>
    </Modal>
  );
}

function ReviewModal({ plan, sprint, onClose }: { plan: Plan; sprint: PlanSprint; onClose: () => void }) {
  const complete = useAction(() => api.post(`/plans/${plan.id}/sprints/${sprint.number}/complete`), {
    invalidate: [['plan', plan.id], ['plans'], ['room'], ['rooms']],
    success: `Sprint ${sprint.number} complete ✨`,
    onSuccess: onClose,
  });
  const count = (s: PlanDay['status']) => sprint.days.filter((d) => d.status === s).length;
  return (
    <Modal
      title={`Review sprint ${sprint.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Not yet
          </button>
          <button className="btn primary" disabled={complete.isPending} onClick={() => complete.mutate(undefined)}>
            Complete sprint
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row wrap" style={{ gap: 20 }}>
          <Stat label="Tasks done" value={`${sprint.done} / ${sprint.total}`} />
          <Stat label="Time" value={timeVsEstimate(sprint.focusedMs, sprint.estMinutes)} />
          <Stat label="Days completed" value={String(count('done'))} />
          <Stat label="Missed" value={String(count('missed'))} />
        </div>
        {sprint.total > sprint.done && <p className="small muted">Unfinished tasks wait in the backlog until you schedule them.</p>}
        <p className="small muted">Completing the sprint takes it out of the room view. You can reopen it anytime.</p>
      </div>
    </Modal>
  );
}

function TaskModal({ plan, task, today, onClose }: { plan: Plan; task: PlanTask; today: string; onClose: () => void }) {
  const [f, setF] = useState({ title: task.title, est: task.estMinutes ? String(task.estMinutes) : '', day: task.day !== null && (plan.sprints.flatMap((s) => s.days).find((d) => d.day === task.day)?.date ?? '') >= today ? String(task.day) : '' });
  const [err, setErr] = useState<string | null>(null);
  const save = useAction(() => api.patch(`/plan-tasks/${task.id}`, { title: f.title, estMinutes: f.est ? Number(f.est) : null, day: f.day === '' ? null : Number(f.day) }), {
    invalidate: [['plan', plan.id], ['plans'], ['room'], ['rooms']],
    success: 'Saved',
    onSuccess: onClose,
    onError: (e: ApiError) => {
      setErr(e.message);
      return true;
    },
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
          <button className="btn primary" disabled={!f.title.trim() || save.isPending} onClick={() => save.mutate(undefined)}>
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Task" full>
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={140} />
        </Field>
        <Field label="Estimated minutes">
          <input className="input" type="number" min="1" value={f.est} onChange={(e) => setF({ ...f, est: e.target.value })} />
        </Field>
        <Field label="Day">
          <select className="input" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })}>
            <option value="">Backlog (not scheduled)</option>
            {plan.sprints
              .filter((s) => s.endDate >= today)
              .map((s) => (
                <optgroup key={s.number} label={`Sprint ${s.number}`}>
                  {s.days
                    .filter((d) => d.date >= today)
                    .map((d) => (
                      <option key={d.day} value={d.day}>
                        {d.date === today ? `Today – ${dayTitle(d)}` : dayTitle(d)}
                      </option>
                    ))}
                </optgroup>
              ))}
          </select>
        </Field>
        {err && <div className="banner error full">{err}</div>}
      </div>
    </Modal>
  );
}

function RenameModal({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [title, setTitle] = useState(plan.title);
  const save = useAction(() => api.patch(`/plans/${plan.id}`, { title }), { invalidate: [['plan', plan.id], ['plans']], onSuccess: onClose });
  return (
    <Modal
      title="Rename goal"
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
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} aria-label="Goal name" />
    </Modal>
  );
}
