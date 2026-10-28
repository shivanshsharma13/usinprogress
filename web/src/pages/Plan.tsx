// One goal: stats, its sprints (current / upcoming / completed), each sprint's days and tasks,
// and a side panel with what to start next and today's progress.
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

type Tab = 'current' | 'upcoming' | 'completed';

const dayTitle = (d: PlanDay) => `Day ${d.number} – ${formatDate(d.date, { day: 'numeric', month: 'short' })} (${formatDate(d.date, { weekday: 'long' })})`;

export function PlanPage() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data: plan, isLoading, error, refetch } = usePlan(id);
  const [tab, setTab] = useState<Tab>('current');
  const [renaming, setRenaming] = useState(false);
  const navigate = useNavigate();
  const update = useAction((body: object) => api.patch(`/plans/${id}`, body), { invalidate: [['plan', id!], ['plans']] });

  if (isLoading || !me) return <Spinner />;
  if (error || !plan) return <ErrorNote error={error} retry={refetch} />;

  const today = me.today;
  // The current sprint is the earliest started one you haven't reviewed yet.
  const current = plan.sprints.find((s) => !s.completedAt && s.startDate <= today) ?? null;
  const upcoming = plan.sprints.filter((s) => !s.completedAt && s !== current);
  const completed = plan.sprints.filter((s) => s.completedAt);
  const shown = tab === 'current' ? (current ? [current] : []) : tab === 'upcoming' ? upcoming : completed;

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
              { label: 'Add a sprint', onClick: () => update.mutate({ sprintCount: plan.sprintCount + 1 }) },
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

        <div className="tabs" role="tablist">
          {(
            [
              ['current', 'Current sprint'],
              ['upcoming', `Upcoming (${upcoming.length})`],
              ['completed', `Completed (${completed.length})`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'current' && !current && (
          <div className="card soft small muted">{today < plan.startDate ? `This goal starts on ${formatDate(plan.startDate, { day: 'numeric', month: 'long' })}. Plan its days under Upcoming.` : 'Every sprint so far is reviewed. Nice work 🌸'}</div>
        )}
        {tab !== 'current' && !shown.length && <p className="small muted">Nothing here yet.</p>}
        {shown.map((s) => (
          <SprintCard key={s.number} plan={plan} sprint={s} today={today} defaultOpen={tab === 'current'} />
        ))}
      </div>

      <TodayPanel plan={plan} today={today} />

      {renaming && <RenameModal plan={plan} onClose={() => setRenaming(false)} />}
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

function SprintCard({ plan, sprint, today, defaultOpen }: { plan: Plan; sprint: PlanSprint; today: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [pulling, setPulling] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const inv = [['plan', plan.id], ['plans']];
  const reopen = useAction(() => api.post(`/plans/${plan.id}/sprints/${sprint.number}/reopen`), { invalidate: inv });
  const daysDone = sprint.days.filter((d) => d.status === 'done').length;

  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row between wrap">
        <button className="row btn ghost" style={{ padding: '4px 6px', minHeight: 0 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown /> : <ChevronRight />}
          <h2>Sprint {sprint.number}</h2>
          <span className="small muted">
            {daysDone}/{sprint.days.length} days completed · {formatDate(sprint.startDate)} – {formatDate(sprint.endDate)}
          </span>
        </button>
        <div className="row wrap" style={{ gap: 6 }}>
          {sprint.roomId ? (
            <Link to={`/rooms/${sprint.roomId}`} className="chip c">
              In {sprint.roomName}
            </Link>
          ) : (
            <button className="btn small" onClick={() => setPulling(true)}>
              Pull into room
            </button>
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
        </div>
      </div>
      {open && sprint.days.map((d) => <DayRow key={d.day} plan={plan} day={d} pulled={Boolean(sprint.roomId)} today={today} />)}
      {pulling && <PullModal plan={plan} sprint={sprint} onClose={() => setPulling(false)} />}
      {reviewing && <ReviewModal plan={plan} sprint={sprint} onClose={() => setReviewing(false)} />}
    </div>
  );
}

function DayRow({ plan, day, pulled, today }: { plan: Plan; day: PlanDay; pulled: boolean; today: string }) {
  const [open, setOpen] = useState(day.date === today);
  const isToday = day.status === 'today';
  const label = DAY_STATUS_LABEL[day.status];
  return (
    <div className={`day-row${isToday ? ' today' : ''}`}>
      {isToday && <span className="today-tag">Today</span>}
      <button className="day-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <CalendarIcon width={16} />
        <span className={isToday ? 'bold' : ''}>{dayTitle(day)}</span>
        {day.tasks.length > 0 && <span className="tiny muted">· {day.tasks.length} {day.tasks.length === 1 ? 'task' : 'tasks'}</span>}
        <span className="grow" />
        {!isToday && label && <span className={`tiny day-status ${day.status}`}>{label}</span>}
        {open ? <ChevronDown width={16} /> : <ChevronRight width={16} />}
      </button>
      {open && (
        <div className="day-body">
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
            <TaskLine key={t.id} plan={plan} task={t} index={i} pulled={pulled} />
          ))}
          <AddTask planId={plan.id} day={day.day} />
        </div>
      )}
    </div>
  );
}

function TaskLine({ plan, task: t, index, pulled }: { plan: Plan; task: PlanTask; index: number; pulled: boolean }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const inv = [['plan', plan.id], ['plans'], ['room'], ['rooms']];
  const complete = useAction(() => api.post(`/topics/${t.topicId}/complete`), { invalidate: inv, success: 'Done 🌼' });
  const undo = useAction(() => api.post(`/topics/${t.topicId}/reopen`, { mode: 'undo' }), { invalidate: inv });
  const star = useAction(() => api.patch(`/plan-tasks/${t.id}`, { starred: !t.starred }), { invalidate: inv });
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
      <button className={`btn ghost icon small star${t.starred ? ' on' : ''}`} onClick={() => star.mutate(undefined)} aria-label={t.starred ? 'Remove from revision list' : 'Add to revision list'} aria-pressed={t.starred}>
        {t.starred ? '★' : '☆'}
      </button>
      <Menu
        label={`More actions for ${t.title}`}
        items={[
          { label: 'Study now', onClick: () => navigate(`/study?topic=${t.topicId}`), hidden: !t.topicId || t.done || !pulled },
          { label: 'Edit or move', onClick: () => setEditing(true) },
          { label: 'Remove', danger: true, onClick: () => confirm(`Remove “${t.title}”? Any study time stays in your history.`) && remove.mutate(undefined) },
        ]}
      />
      {editing && <TaskModal plan={plan} task={t} onClose={() => setEditing(false)} />}
    </div>
  );
}

function AddTask({ planId, day }: { planId: string; day: number }) {
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
      <input className="input grow" placeholder="Add a task…" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} aria-label="New task" />
      <input className="input" style={{ width: 86 }} type="number" min="1" inputMode="numeric" placeholder="min" value={est} onChange={(e) => setEst(e.target.value)} aria-label="Estimated minutes" />
      <button className="btn icon" disabled={!title.trim() || add.isPending} aria-label="Add task">
        <PlusIcon />
      </button>
    </form>
  );
}

// ───────────── Side panel ─────────────

function TodayPanel({ plan, today }: { plan: Plan; today: string }) {
  const navigate = useNavigate();
  const [pulling, setPulling] = useState<PlanSprint | null>(null);
  const [revision, setRevision] = useState(false);
  const sprint = plan.sprints.find((s) => s.startDate <= today && s.endDate >= today);
  const day = sprint?.days.find((d) => d.date === today);
  const tasks = day?.tasks ?? [];
  const nextIndex = tasks.findIndex((t) => !t.done);
  const next = nextIndex >= 0 ? tasks[nextIndex] : null;
  const done = tasks.filter((t) => t.done).length;
  const starred = plan.sprints.flatMap((s) => s.days.flatMap((d) => d.tasks.filter((t) => t.starred).map((t) => ({ ...t, dayNumber: d.number }))));

  return (
    <aside className="plan-side stack">
      <div className="card stack" style={{ gap: 12 }}>
        {day && sprint ? (
          next ? (
            <>
              <span className="section-label">
                Start day {day.number} – task {nextIndex + 1}
              </span>
              {next.topicId ? (
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
            <p className="small muted">{tasks.length ? 'Everything for today is done 🌸' : `Nothing planned for day ${day.number}. Add tasks to today in the sprint.`}</p>
          )
        ) : (
          <p className="small muted">{today < plan.startDate ? `Starts ${formatDate(plan.startDate)}.` : 'This goal has ended.'}</p>
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
          <p className="small muted">Its tasks show up in your column of the room. You can study them there, and your friend sees your progress.</p>
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

function ReviewModal({ plan, sprint, onClose }: { plan: Plan; sprint: PlanSprint; onClose: () => void }) {
  const complete = useAction(() => api.post(`/plans/${plan.id}/sprints/${sprint.number}/complete`), {
    invalidate: [['plan', plan.id], ['plans'], ['room'], ['rooms']],
    success: `Sprint ${sprint.number} complete ✨`,
    onSuccess: onClose,
  });
  const count = (s: PlanDay['status']) => sprint.days.filter((d) => d.status === s).length;
  const open = sprint.days.flatMap((d) => d.tasks.filter((t) => !t.done));
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
          <Stat label="Days completed" value={String(count('done'))} />
          <Stat label="Partly done" value={String(count('partial'))} />
          <Stat label="Missed" value={String(count('missed'))} />
        </div>
        {open.length > 0 && (
          <p className="small muted">
            {open.length} task{open.length === 1 ? '' : 's'} not done. They stay in this sprint's history — move any you still want into the next sprint with “Edit or move”.
          </p>
        )}
        <p className="small muted">Completing the sprint takes it out of the room view. You can reopen it anytime.</p>
      </div>
    </Modal>
  );
}

function TaskModal({ plan, task, onClose }: { plan: Plan; task: PlanTask; onClose: () => void }) {
  const [f, setF] = useState({ title: task.title, est: task.estMinutes ? String(task.estMinutes) : '', day: String(task.day) });
  const [err, setErr] = useState<string | null>(null);
  const save = useAction(() => api.patch(`/plan-tasks/${task.id}`, { title: f.title, estMinutes: f.est ? Number(f.est) : null, day: Number(f.day) }), {
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
            {plan.sprints.map((s) => (
              <optgroup key={s.number} label={`Sprint ${s.number}`}>
                {s.days.map((d) => (
                  <option key={d.day} value={d.day}>
                    {dayTitle(d)}
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
