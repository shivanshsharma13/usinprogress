import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { addDays, addMonths, endOfMonth, formatDate, startOfMonth, startOfWeek } from '@shared/dates';
import type { PublicUser, RoomDetail, Task } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { useAction, useFriends, useGoals, useMe, useRooms, useTasks } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { personVars } from '../lib/theme';
import { ErrorNote, Field, Menu, Modal, Spinner, Switch } from '../components/ui';
import { ChevronLeft, ChevronRight, PlayIcon, PlusIcon } from '../components/icons';

type View = 'month' | 'week' | 'agenda';
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function useIsNarrow() {
  const q = '(max-width: 720px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function CalendarPage() {
  const { data: me } = useMe();
  const { data: friends } = useFriends();
  const [params, setParams] = useSearchParams();
  const narrow = useIsNarrow();
  const today = me?.today ?? new Date().toISOString().slice(0, 10);
  const [view, setView] = useState<View>('month');
  const [cursor, setCursor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [editing, setEditing] = useState<Task | { date: string } | null>(params.get('new') ? { date: today } : null);
  const navigate = useNavigate();

  const range = useMemo(() => {
    if (view === 'week') {
      const s = startOfWeek(cursor);
      return { from: s, to: addDays(s, 6) };
    }
    if (view === 'agenda') return { from: cursor, to: addDays(cursor, 30) };
    const s = startOfWeek(startOfMonth(cursor));
    return { from: s, to: addDays(s, 41) };
  }, [view, cursor]);
  const { data: tasks, isLoading, error, refetch } = useTasks(range.from, range.to);

  const people = useMemo(() => {
    const map: Record<string, PublicUser> = {};
    if (me) map[me.id] = me;
    for (const f of friends?.friends ?? []) map[f.user.id] = f.user;
    return map;
  }, [me, friends]);

  const inv = [['tasks'], ['goals'], ['home']];
  const update = useAction(({ id, body }: { id: string; body: object }) => api.patch(`/tasks/${id}`, body), { invalidate: inv });
  const remove = useAction((id: string) => api.del(`/tasks/${id}`), { invalidate: inv, success: 'Task removed' });

  if (!me) return <Spinner />;
  const byDate = new Map<string, Task[]>();
  for (const t of tasks ?? []) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);

  const shift = (dir: number) => {
    if (view === 'month') setCursor(addMonths(startOfMonth(cursor), dir));
    else if (view === 'week') setCursor(addDays(cursor, 7 * dir));
    else setCursor(addDays(cursor, 30 * dir));
  };
  const title =
    view === 'month'
      ? formatDate(startOfMonth(cursor), { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${formatDate(range.from)} – ${formatDate(range.to)}`
        : `From ${formatDate(range.from)}`;

  const actions = {
    toggle: (t: Task) => update.mutate({ id: t.id, body: { completed: !t.completed } }),
    edit: (t: Task) => setEditing(t),
    move: (t: Task, date: string) => update.mutate({ id: t.id, body: { date } }),
    remove: (t: Task) => confirm(`Remove “${t.title}” from the calendar? Any study sessions stay recorded.`) && remove.mutate(t.id),
    study: (t: Task) => navigate(`/study?topic=${t.topicId}&task=${t.id}`),
  };

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="muted">A plan, not a record — time only counts when you study.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ date: selected })}>
          <PlusIcon /> Plan a task
        </button>
      </div>

      <div className="row between wrap">
        <div className="row">
          <button className="btn icon" aria-label="Previous" onClick={() => shift(-1)}>
            <ChevronLeft />
          </button>
          <button className="btn icon" aria-label="Next" onClick={() => shift(1)}>
            <ChevronRight />
          </button>
          <h2 style={{ minWidth: 0 }}>{title}</h2>
          <button
            className="btn small ghost"
            onClick={() => {
              setCursor(today);
              setSelected(today);
            }}
          >
            Today
          </button>
        </div>
        <div className="tabs" role="tablist">
          {(['month', 'week', 'agenda'] as View[]).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'month' ? 'Month' : v === 'week' ? 'Week' : 'Agenda'}
            </button>
          ))}
        </div>
      </div>

      <div className="legend" aria-label="Legend">
        {Object.values(people).map((p) => (
          <span key={p.id} style={personVars(p.accent)}>
            <span className="dot" /> {p.id === me.id ? `You (${p.displayName})` : p.displayName}
          </span>
        ))}
        <span className="muted">Line-through = done</span>
      </div>

      {error && <ErrorNote error={error} retry={refetch} />}
      {isLoading && !tasks ? (
        <Spinner />
      ) : view === 'month' && !narrow ? (
        <MonthGrid cursor={cursor} today={today} selected={selected} byDate={byDate} people={people} meId={me.id} onSelect={setSelected} onAdd={(d) => setEditing({ date: d })} onOpen={actions.edit} onDrop={(id, d) => update.mutate({ id, body: { date: d } })} />
      ) : view === 'month' && narrow ? (
        <MobileMonth cursor={cursor} today={today} selected={selected} byDate={byDate} people={people} onSelect={setSelected} />
      ) : view === 'week' && !narrow ? (
        <div className="week-grid">
          {Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((d) => (
            <div key={d} className={`week-col${d === today ? ' today' : ''}`}>
              <div className="row between">
                <b className="small">
                  {DOW[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]} {Number(d.slice(8))}
                </b>
                <button className="btn ghost icon small" aria-label={`Add task on ${d}`} onClick={() => setEditing({ date: d })}>
                  <PlusIcon />
                </button>
              </div>
              {(byDate.get(d) ?? []).map((t) => (
                <button key={t.id} className={`cal-pill${t.completed ? ' done' : ''}`} style={{ ...personVars(people[t.ownerId]?.accent), whiteSpace: 'normal', textAlign: 'left', border: 'none', cursor: 'pointer' }} onClick={() => actions.edit(t)}>
                  {t.startTime && <span className="num">{t.startTime} </span>}
                  {t.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* Agenda: the selected day on month view, the week on mobile, or the next 30 days */}
      {(view === 'agenda' || (view === 'month') || (view === 'week' && narrow)) && (
        <div className="stack">
          {view === 'month' ? (
            <DayAgenda date={selected} today={today} tasks={byDate.get(selected) ?? []} people={people} meId={me.id} actions={actions} onAdd={() => setEditing({ date: selected })} />
          ) : (
            Array.from({ length: view === 'week' ? 7 : 31 }, (_, i) => addDays(range.from, i))
              .filter((d) => view === 'week' || (byDate.get(d) ?? []).length)
              .map((d) => <DayAgenda key={d} date={d} today={today} tasks={byDate.get(d) ?? []} people={people} meId={me.id} actions={actions} onAdd={() => setEditing({ date: d })} compact />)
          )}
          {view === 'agenda' && !(tasks ?? []).length && <p className="muted">Nothing planned in the next 30 days.</p>}
        </div>
      )}

      {editing && (
        <TaskModal
          task={'id' in editing ? editing : null}
          date={'id' in editing ? editing.date : editing.date}
          meId={me.id}
          ownerName={'id' in editing ? people[editing.ownerId]?.displayName : undefined}
          onClose={() => {
            setEditing(null);
            if (params.get('new')) setParams({}, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function MonthGrid({
  cursor,
  today,
  selected,
  byDate,
  people,
  meId,
  onSelect,
  onAdd,
  onOpen,
  onDrop,
}: {
  cursor: string;
  today: string;
  selected: string;
  byDate: Map<string, Task[]>;
  people: Record<string, PublicUser>;
  meId: string;
  onSelect: (d: string) => void;
  onAdd: (d: string) => void;
  onOpen: (t: Task) => void;
  onDrop: (taskId: string, date: string) => void;
}) {
  const start = startOfWeek(startOfMonth(cursor));
  const month = cursor.slice(0, 7);
  return (
    <div className="cal-grid">
      {DOW.map((d) => (
        <div key={d} className="dow">
          {d}
        </div>
      ))}
      {Array.from({ length: 42 }, (_, i) => addDays(start, i)).map((d) => {
        const items = byDate.get(d) ?? [];
        return (
          <div
            key={d}
            className={`cal-cell${d.slice(0, 7) !== month ? ' other' : ''}${d === today ? ' today' : ''}${d === selected ? ' sel' : ''}`}
            onClick={() => onSelect(d)}
            onDoubleClick={() => onAdd(d)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const id = e.dataTransfer.getData('text/task');
              if (id) onDrop(id, d);
            }}
            role="button"
            tabIndex={0}
            aria-label={`${formatDate(d, { weekday: 'long', month: 'long', day: 'numeric' })}, ${items.length} items`}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(d)}
          >
            <span className="daynum">{Number(d.slice(8))}</span>
            {items.slice(0, 3).map((t) => (
              <span
                key={t.id}
                className={`cal-pill${t.completed ? ' done' : ''}`}
                style={personVars(people[t.ownerId]?.accent)}
                draggable={t.ownerId === meId}
                onDragStart={(e) => e.dataTransfer.setData('text/task', t.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(t);
                }}
                title={t.title}
              >
                {t.title}
              </span>
            ))}
            {items.length > 3 && <span className="tiny muted">+{items.length - 3} more</span>}
          </div>
        );
      })}
    </div>
  );
}

function MobileMonth({ cursor, today, selected, byDate, people, onSelect }: { cursor: string; today: string; selected: string; byDate: Map<string, Task[]>; people: Record<string, PublicUser>; onSelect: (d: string) => void }) {
  const first = startOfMonth(cursor);
  const last = endOfMonth(cursor);
  const start = startOfWeek(first);
  const weeks = Math.ceil((Date.parse(last) - Date.parse(start)) / (7 * 86_400_000) + 0.01);
  return (
    <div className="card" style={{ padding: 10 }}>
      <div className="strip" style={{ marginBottom: 4 }}>
        {DOW.map((d) => (
          <span key={d} className="tiny muted center">
            {d[0]}
          </span>
        ))}
      </div>
      {Array.from({ length: weeks }, (_, w) => (
        <div className="strip" key={w}>
          {Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)).map((d) => {
            const items = byDate.get(d) ?? [];
            const owners = [...new Set(items.map((t) => t.ownerId))];
            return (
              <button key={d} className={d === selected ? 'sel' : ''} style={{ opacity: d.slice(0, 7) === cursor.slice(0, 7) ? 1 : 0.4, color: d === today ? 'var(--me)' : undefined }} onClick={() => onSelect(d)} aria-label={`${d}, ${items.length} items`}>
                <span className="num">{Number(d.slice(8))}</span>
                <span className="dots">
                  {owners.slice(0, 2).map((o) => (
                    <i key={o} style={personVars(people[o]?.accent)} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface Actions {
  toggle: (t: Task) => void;
  edit: (t: Task) => void;
  move: (t: Task, date: string) => void;
  remove: (t: Task) => void;
  study: (t: Task) => void;
}

function DayAgenda({ date, today, tasks, people, meId, actions, onAdd, compact }: { date: string; today: string; tasks: Task[]; people: Record<string, PublicUser>; meId: string; actions: Actions; onAdd: () => void; compact?: boolean }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <h3>
          {date === today ? 'Today · ' : ''}
          {formatDate(date, { weekday: 'long', month: 'short', day: 'numeric' })}
        </h3>
        {!compact && (
          <button className="btn small" onClick={onAdd}>
            <PlusIcon /> Add
          </button>
        )}
      </div>
      {!tasks.length && <p className="small muted">Nothing planned.</p>}
      {tasks.map((t) => {
        const mine = t.ownerId === meId;
        const owner = people[t.ownerId];
        return (
          <div key={t.id} className={`task-item${t.completed ? ' done' : ''}`} style={personVars(owner?.accent)}>
            {mine ? (
              <input type="checkbox" checked={t.completed} onChange={() => actions.toggle(t)} aria-label={`Mark “${t.title}” ${t.completed ? 'not done' : 'done'}`} style={{ width: 22, height: 22, marginTop: 2, accentColor: 'var(--c)' }} />
            ) : (
              <span className="dot" style={{ marginTop: 6 }} />
            )}
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="bold title">{t.title}</div>
              <div className="tiny muted">
                {!mine && `${owner?.displayName ?? 'Friend'} · `}
                {t.startTime ? `${t.startTime}` : 'Any time'}
                {t.durationMinutes ? ` · ${t.durationMinutes}m` : ''}
                {t.topicTitle ? ` · ${t.topicTitle}` : ''}
                {t.goalTitle ? ` · Goal: ${t.goalTitle}` : ''}
                {mine && t.shared ? ' · Shared' : ''}
              </div>
              {mine && t.note && <div className="tiny" style={{ marginTop: 4 }}>📝 {t.note}</div>}
            </div>
            <div className="row" style={{ gap: 4 }}>
              {mine && t.topicId && !t.completed && (
                <button className="btn small" onClick={() => actions.study(t)} aria-label={`Start studying ${t.topicTitle}`}>
                  <PlayIcon />
                </button>
              )}
              {t.roomId && (
                <Link className="btn small ghost" to={`/rooms/${t.roomId}`}>
                  Room
                </Link>
              )}
              {mine && (
                <Menu
                  items={[
                    { label: 'Edit / move', onClick: () => actions.edit(t) },
                    { label: 'Move to tomorrow', onClick: () => actions.move(t, addDays(t.date, 1)) },
                    { label: 'Remove', danger: true, onClick: () => actions.remove(t) },
                  ]}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskModal({ task, date, meId, ownerName, onClose }: { task: Task | null; date: string; meId: string; ownerName?: string; onClose: () => void }) {
  const readOnly = Boolean(task && task.ownerId !== meId);
  const { data: rooms } = useRooms();
  const { data: goals } = useGoals();
  const [f, setF] = useState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    date: task?.date ?? date,
    startTime: task?.startTime ?? '',
    durationMinutes: task?.durationMinutes ? String(task.durationMinutes) : '',
    roomId: task?.roomId ?? '',
    topicId: task?.topicId ?? '',
    goalId: task?.goalId ?? '',
    quantity: String(task?.quantity ?? 1),
    shared: task?.shared ?? true,
    note: task?.note ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const room = useQuery({ queryKey: ['room', f.roomId], enabled: Boolean(f.roomId) && !readOnly, queryFn: () => api.get<RoomDetail>(`/rooms/${f.roomId}`) });

  const save = useAction(
    () => {
      const body = {
        title: f.title,
        description: f.description,
        date: f.date,
        startTime: f.startTime || null,
        durationMinutes: f.durationMinutes ? Number(f.durationMinutes) : null,
        roomId: f.roomId || null,
        topicId: f.topicId || null,
        goalId: f.goalId || null,
        quantity: Number(f.quantity) > 0 ? Number(f.quantity) : 1,
        shared: f.shared,
        note: f.note,
      };
      return task ? api.patch(`/tasks/${task.id}`, body) : api.post('/tasks', body);
    },
    {
      invalidate: [['tasks'], ['goals'], ['home']],
      success: task ? 'Saved' : 'Added to your calendar',
      onSuccess: onClose,
      onError: (e: ApiError) => {
        setErr(e.message);
        return true;
      },
    },
  );

  if (readOnly && task)
    return (
      <Modal title={task.title} onClose={onClose}>
        <div className="stack small">
          <p>
            <b>{ownerName}</b> planned this for {formatDate(task.date, { weekday: 'long', month: 'long', day: 'numeric' })}
            {task.startTime ? ` at ${task.startTime}` : ''}.
          </p>
          {task.topicTitle && <p>Topic: {task.topicTitle}</p>}
          {task.goalTitle && <p>Goal: {task.goalTitle}</p>}
          <p>{task.completed ? 'Done ✓' : 'Not done yet'}</p>
          {task.roomId && (
            <Link className="btn" to={`/rooms/${task.roomId}`} onClick={onClose}>
              Open room
            </Link>
          )}
        </div>
      </Modal>
    );

  const activeGoals = (goals ?? []).filter((g) => g.status === 'active');
  const selectedGoal = activeGoals.find((g) => g.id === f.goalId);

  return (
    <Modal
      title={task ? 'Edit task' : 'Plan a task'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!f.title.trim() || save.isPending} onClick={() => save.mutate(undefined)}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="What will you do?" full>
          <input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Solve 5 binary search questions" maxLength={140} />
        </Field>
        <Field label="Date">
          <input className="input" type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} />
        </Field>
        <Field label="Start time (optional)">
          <input className="input" type="time" value={f.startTime} onChange={(e) => set({ startTime: e.target.value })} />
        </Field>
        <Field label="Estimated minutes (optional)">
          <input className="input" type="number" min="1" inputMode="numeric" value={f.durationMinutes} onChange={(e) => set({ durationMinutes: e.target.value })} />
        </Field>
        <Field label="Room (optional)">
          <select className="input" value={f.roomId} onChange={(e) => set({ roomId: e.target.value, topicId: '' })}>
            <option value="">None</option>
            {(rooms ?? [])
              .filter((r) => r.status === 'active')
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </Field>
        {f.roomId && (
          <Field label="Topic (optional)" hint="You can start studying it right from the calendar." full>
            <select className="input" value={f.topicId} onChange={(e) => set({ topicId: e.target.value })}>
              <option value="">None</option>
              {(room.data?.topics ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Counts toward a goal (optional)" full>
          <select className="input" value={f.goalId} onChange={(e) => set({ goalId: e.target.value })}>
            <option value="">None</option>
            {activeGoals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </Field>
        {selectedGoal?.measure === 'count' && (
          <Field label={`How many ${selectedGoal.unit || 'units'} is this?`} hint="When you tick it off, this amount counts toward the goal (and its bigger goals) once.">
            <input className="input" type="number" min="1" inputMode="numeric" value={f.quantity} onChange={(e) => set({ quantity: e.target.value })} />
          </Field>
        )}
        <Field label="Private note (optional)" hint="Only you can see this." full>
          <textarea className="input" value={f.note} onChange={(e) => set({ note: e.target.value })} style={{ minHeight: 60 }} />
        </Field>
        <div className="full">
          <Switch checked={f.shared} onChange={(v) => set({ shared: v })} label="Show this on my friend's calendar" />
        </div>
        {err && (
          <div className="banner error full" role="alert">
            {err}
          </div>
        )}
      </div>
    </Modal>
  );
}
