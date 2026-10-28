import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { addDays, endOfMonth, formatDate, startOfMonth, startOfWeek } from '@shared/dates';
import type { Goal, RoomDetail } from '@shared/types';
import { useAction, useFriends, useGoals, useMe, useRooms, useSharedGoals } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { useQueries } from '@tanstack/react-query';
import { personVars } from '../lib/theme';
import { Empty, ErrorNote, Field, Menu, Modal, ProgressBar, Spinner } from '../components/ui';
import { goalValueText, PERIOD_LABEL } from '../components/GoalBits';
import { Plant } from '../components/Plant';
import { ChevronDown, ChevronRight, PlusIcon } from '../components/icons';

export function GoalsPage() {
  const { data: me } = useMe();
  const { data: goals, isLoading, error, refetch } = useGoals();
  const { data: friends } = useFriends();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Goal | 'new' | null>(params.get('new') ? 'new' : null);
  const [newParent, setNewParent] = useState<Goal | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  if (isLoading || !me) return <Spinner />;
  if (error || !goals) return <ErrorNote error={error} retry={refetch} />;

  const visible = goals.filter((g) => (showArchived ? true : g.status !== 'archived'));
  const byId = new Map(visible.map((g) => [g.id, g]));
  const roots = visible.filter((g) => !g.parentId || !byId.has(g.parentId));
  const sections: { title: string; period: Goal['period'] }[] = [
    { title: 'Yearly goals', period: 'yearly' },
    { title: 'Monthly goals', period: 'monthly' },
    { title: 'Weekly goals', period: 'weekly' },
    { title: 'Other goals', period: 'custom' },
  ];

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Goals</h1>
          <p className="muted">Yearly → monthly → weekly. Completed topics and tasks count automatically, once.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <PlusIcon /> New goal
        </button>
      </div>

      {!visible.length && (
        <div className="card">
          <Empty
            title="No goals yet"
            art={<Plant percent={10} size={96} />}
            action={
              <button className="btn primary big" onClick={() => setEditing('new')}>
                Add your first goal
              </button>
            }
          >
            Start with a big yearly goal like “Become confident with DSA” or “Finish the medical syllabus”. You can add monthly and weekly steps beneath it.
          </Empty>
        </div>
      )}

      {sections.map((s) => {
        const list = roots.filter((g) => g.period === s.period);
        if (!list.length) return null;
        return (
          <section key={s.period} className="stack">
            <h2>{s.title}</h2>
            {list.map((g) => (
              <GoalNode key={g.id} goal={g} byId={byId} accent={me.accent} today={me.today} onEdit={setEditing} onAddChild={(p) => (setNewParent(p), setEditing('new'))} depth={0} />
            ))}
          </section>
        );
      })}

      {goals.some((g) => g.status === 'archived') && (
        <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowArchived((s) => !s)}>
          {showArchived ? 'Hide archived goals' : 'Show archived goals'}
        </button>
      )}

      {friends?.friends.map((f) => <PartnerGoals key={f.user.id} userId={f.user.id} name={f.user.displayName} accent={f.user.accent} />)}

      {editing && (
        <GoalModal
          goal={editing === 'new' ? null : editing}
          parent={editing === 'new' ? newParent : null}
          goals={goals}
          today={me.today}
          onClose={() => {
            setEditing(null);
            setNewParent(null);
            if (params.get('new')) setParams({}, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function GoalNode({
  goal,
  byId,
  accent,
  today,
  depth,
  onEdit,
  onAddChild,
}: {
  goal: Goal;
  byId: Map<string, Goal>;
  accent: string;
  today: string;
  depth: number;
  onEdit: (g: Goal) => void;
  onAddChild: (g: Goal) => void;
}) {
  const children = goal.childIds.map((id) => byId.get(id)).filter(Boolean) as Goal[];
  const [open, setOpen] = useState(depth === 0);
  const inv = [['goals'], ['rooms'], ['room']];
  const update = useAction((body: object) => api.patch(`/goals/${goal.id}`, body), { invalidate: inv });
  const archive = useAction(() => api.del(`/goals/${goal.id}`), { invalidate: inv, success: 'Goal archived' });
  const p = goal.progress;
  const daysLeft = Math.round((Date.parse(goal.deadline) - Date.parse(today)) / 86_400_000);
  const childPeriod = goal.period === 'yearly' ? 'monthly' : goal.period === 'monthly' ? 'weekly' : null;

  return (
    <div className="goal-card" style={{ opacity: goal.status === 'archived' ? 0.6 : 1 }}>
      <div className="row top">
        {children.length > 0 ? (
          <button className="btn ghost icon small" aria-label={open ? 'Hide steps' : 'Show steps'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
        ) : (
          <span style={{ width: 34 }} />
        )}
        <div className="grow stack" style={{ gap: 6 }}>
          <div className="row between top">
            <div>
              <div className="bold">{goal.title}</div>
              <div className="tiny muted">
                {PERIOD_LABEL[goal.period]} · {formatDate(goal.startDate)} – {formatDate(goal.deadline)}
                {goal.status === 'active' && daysLeft >= 0 ? ` · ${daysLeft} days left` : ''}
                {goal.visibility === 'friends' ? ' · Shared' : ' · Private'}
              </div>
            </div>
            <div className="row" style={{ gap: 4 }}>
              {goal.status === 'done' && <span className="chip done">Done ✨</span>}
              <Menu
                items={[
                  { label: 'Edit goal', onClick: () => onEdit(goal) },
                  { label: `Add a ${childPeriod ?? 'smaller'} step`, onClick: () => onAddChild(goal) },
                  { label: 'Mark as done', onClick: () => update.mutate({ status: 'done' }), hidden: goal.status !== 'active' },
                  { label: 'Mark as not done', onClick: () => update.mutate({ status: 'active' }), hidden: goal.status !== 'done' },
                  { label: 'Restore', onClick: () => update.mutate({ status: 'active' }), hidden: goal.status !== 'archived' },
                  { label: 'Archive', danger: true, onClick: () => confirm('Archive this goal? Its history stays readable.') && archive.mutate(undefined), hidden: goal.status === 'archived' },
                ]}
              />
            </div>
          </div>
          {goal.description && <p className="small muted">{goal.description}</p>}
          {p.percent != null && <ProgressBar value={p.percent} max={100} accent={accent} label={goal.title} />}
          <div className="row between wrap">
            <span className="small num">
              {goalValueText(goal)}
              {p.percent != null && <span className="muted"> · {p.percent}%</span>}
            </span>
            {goal.measure === 'completion' && goal.status === 'active' && (
              <button className="btn small" onClick={() => update.mutate({ status: 'done' })}>
                Mark done
              </button>
            )}
          </div>
          {goal.links.length > 0 && (
            <div className="row wrap" style={{ gap: 6 }}>
              {goal.links.map((l) => (
                <Link key={l.roomId ?? l.topicId} to={l.roomId ? `/rooms/${l.roomId}` : '#'} className="chip outline">
                  {l.roomId ? '🌿 ' : '• '}
                  {l.label}
                </Link>
              ))}
            </div>
          )}
          {goal.status === 'active' && goal.measure !== 'completion' && !goal.links.length && !children.length && (
            <p className="tiny muted">Not linked to any room or topic yet — only tasks you assign to this goal will count. Edit to link a room.</p>
          )}
        </div>
      </div>
      {open && children.length > 0 && (
        <div className="goal-children">
          {children.map((c) => (
            <GoalNode key={c.id} goal={c} byId={byId} accent={accent} today={today} depth={depth + 1} onEdit={onEdit} onAddChild={onAddChild} />
          ))}
        </div>
      )}
    </div>
  );
}

function PartnerGoals({ userId, name, accent }: { userId: string; name: string; accent: string }) {
  const { data } = useSharedGoals(userId);
  const active = (data ?? []).filter((g) => g.status !== 'archived');
  return (
    <section className="stack" style={personVars(accent)}>
      <h2>
        <span className="dot" style={{ marginRight: 8 }} />
        {name}'s shared goals
      </h2>
      {active.length ? (
        <div className="grid-2">
          {active.map((g) => (
            <div key={g.id} className="card tint stack" style={{ gap: 6 }}>
              <div className="bold">{g.title}</div>
              <div className="tiny muted">
                {PERIOD_LABEL[g.period]} · until {formatDate(g.deadline)}
              </div>
              {g.progress.percent != null && <ProgressBar value={g.progress.percent} max={100} accent={accent} />}
              <div className="small num">{goalValueText(g)}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="small muted">{name} hasn't shared any goals yet. Goals are private unless their owner shares them.</p>
      )}
    </section>
  );
}

function defaultDates(period: Goal['period'], today: string) {
  if (period === 'yearly') return { startDate: `${today.slice(0, 4)}-01-01`, deadline: `${today.slice(0, 4)}-12-31` };
  if (period === 'monthly') return { startDate: startOfMonth(today), deadline: endOfMonth(today) };
  if (period === 'weekly') {
    const s = startOfWeek(today);
    return { startDate: s, deadline: addDays(s, 6) };
  }
  return { startDate: today, deadline: addDays(today, 30) };
}

function GoalModal({ goal, parent, goals, today, onClose }: { goal: Goal | null; parent: Goal | null; goals: Goal[]; today: string; onClose: () => void }) {
  const initialPeriod: Goal['period'] = goal?.period ?? (parent ? (parent.period === 'yearly' ? 'monthly' : parent.period === 'monthly' ? 'weekly' : 'custom') : 'yearly');
  const [f, setF] = useState({
    title: goal?.title ?? '',
    description: goal?.description ?? '',
    period: initialPeriod,
    ...(goal ? { startDate: goal.startDate, deadline: goal.deadline } : defaultDates(initialPeriod, today)),
    measure: goal?.measure ?? parent?.measure ?? ('count' as Goal['measure']),
    target: goal?.target != null ? String(goal.target) : '',
    unit: goal?.unit ?? parent?.unit ?? '',
    parentId: goal?.parentId ?? parent?.id ?? '',
    visibility: goal?.visibility ?? parent?.visibility ?? ('private' as Goal['visibility']),
    roomIds: goal?.links.filter((l) => l.roomId).map((l) => l.roomId!) ?? [],
    topicIds: goal?.links.filter((l) => l.topicId).map((l) => l.topicId!) ?? [],
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const { data: rooms } = useRooms();
  const roomDetails = useQueries({
    queries: (rooms ?? []).map((r) => ({ queryKey: ['room', r.id], queryFn: () => api.get<RoomDetail>(`/rooms/${r.id}`) })),
  });
  const { data: me } = useMe();
  // Only your own topics can count toward your goals.
  const topicsByRoom = useMemo(
    () => Object.fromEntries(roomDetails.filter((q) => q.data).map((q) => [q.data!.id, q.data!.topics.filter((t) => t.createdBy === me?.id)])),
    [roomDetails, me?.id],
  );
  const [pickTopicsIn, setPickTopicsIn] = useState<string | null>(null);

  // A goal can't be its own ancestor.
  const descendants = new Set<string>();
  if (goal) {
    const stack = [goal.id];
    while (stack.length) {
      const id = stack.pop()!;
      descendants.add(id);
      goals.filter((g) => g.parentId === id).forEach((g) => stack.push(g.id));
    }
  }
  const parentOptions = goals.filter((g) => g.status !== 'archived' && !descendants.has(g.id));

  const save = useAction(
    () => {
      const body = {
        title: f.title,
        description: f.description,
        period: f.period,
        startDate: f.startDate,
        deadline: f.deadline,
        measure: f.measure,
        target: f.measure === 'completion' || !f.target ? null : Number(f.target),
        unit: f.measure === 'count' ? f.unit : '',
        parentId: f.parentId || null,
        visibility: f.visibility,
        roomIds: f.roomIds,
        topicIds: f.topicIds,
      };
      return goal ? api.patch(`/goals/${goal.id}`, body) : api.post('/goals', body);
    },
    {
      invalidate: [['goals'], ['rooms'], ['room']],
      success: goal ? 'Goal saved' : 'Goal planted 🌱',
      onSuccess: onClose,
      onError: (e: ApiError) => {
        setErr(e.message);
        return true;
      },
    },
  );

  const toggle = (list: 'roomIds' | 'topicIds', id: string) => set({ [list]: f[list].includes(id) ? f[list].filter((x) => x !== id) : [...f[list], id] } as any);

  return (
    <Modal
      title={goal ? 'Edit goal' : parent ? `New step for “${parent.title}”` : 'New goal'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!f.title.trim() || save.isPending} onClick={() => save.mutate(undefined)}>
            {save.isPending ? 'Saving…' : 'Save goal'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Goal" full>
          <input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Solve 100 DSA questions in November" maxLength={140} />
        </Field>
        <Field label="Description (optional)" full>
          <textarea className="input" value={f.description} onChange={(e) => set({ description: e.target.value })} style={{ minHeight: 60 }} />
        </Field>
        <div className="field full">
          <span className="label">Time period</span>
          <div className="row wrap">
            {(['yearly', 'monthly', 'weekly', 'custom'] as const).map((p) => (
              <button type="button" key={p} className={`chip-btn${f.period === p ? ' on' : ''}`} onClick={() => set({ period: p, ...(goal ? {} : defaultDates(p, today)) })}>
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        <Field label="Start date">
          <input className="input" type="date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} />
        </Field>
        <Field label="Deadline">
          <input className="input" type="date" value={f.deadline} onChange={(e) => set({ deadline: e.target.value })} />
        </Field>
        <div className="field full">
          <span className="label">How will you measure it?</span>
          <div className="choice-grid">
            {(
              [
                ['count', 'A number', 'Questions, chapters, topics…'],
                ['time', 'Focused time', 'Minutes from study sessions'],
                ['completion', 'Done / not done', 'For qualitative goals'],
              ] as const
            ).map(([k, t, d]) => (
              <button type="button" key={k} className={`choice${f.measure === k ? ' on' : ''}`} onClick={() => set({ measure: k })}>
                <b>{t}</b>
                <span className="tiny muted">{d}</span>
              </button>
            ))}
          </div>
        </div>
        {f.measure === 'count' && (
          <>
            <Field label="Target (optional)">
              <input className="input" type="number" min="1" inputMode="numeric" value={f.target} onChange={(e) => set({ target: e.target.value })} placeholder="e.g. 100" />
            </Field>
            <Field label="Unit">
              <input className="input" value={f.unit} onChange={(e) => set({ unit: e.target.value })} placeholder="e.g. questions" maxLength={30} />
            </Field>
            <p className="tiny muted full">Each completed topic in a linked room counts as 1. A completed task assigned to this goal counts its own amount (e.g. “Solve 5 questions” counts 5).</p>
          </>
        )}
        {f.measure === 'time' && (
          <Field label="Target in minutes (optional)" hint="e.g. 1200 = 20 hours" full>
            <input className="input" type="number" min="1" inputMode="numeric" value={f.target} onChange={(e) => set({ target: e.target.value })} />
          </Field>
        )}
        <Field label="Part of a bigger goal" hint="Progress here also counts toward the bigger goal — once." full>
          <select className="input" value={f.parentId} onChange={(e) => set({ parentId: e.target.value })}>
            <option value="">None</option>
            {parentOptions.map((g) => (
              <option key={g.id} value={g.id}>
                {PERIOD_LABEL[g.period]}: {g.title}
              </option>
            ))}
          </select>
        </Field>
        {f.measure !== 'completion' && (
          <div className="field full">
            <span className="label">What counts toward it?</span>
            <span className="hint">Link whole rooms, or only specific topics. Your friend's progress never counts toward your goals.</span>
            {(rooms ?? []).length === 0 && <span className="small muted">No rooms yet.</span>}
            {(rooms ?? []).map((r) => (
              <div key={r.id} className="stack" style={{ gap: 4 }}>
                <div className="row between">
                  <label className="check">
                    <input type="checkbox" checked={f.roomIds.includes(r.id)} onChange={() => toggle('roomIds', r.id)} /> {r.name} <span className="muted small">(all your topics)</span>
                  </label>
                  {!f.roomIds.includes(r.id) && (
                    <button type="button" className="btn ghost small" onClick={() => setPickTopicsIn(pickTopicsIn === r.id ? null : r.id)}>
                      {pickTopicsIn === r.id ? 'Done' : 'Pick topics'}
                    </button>
                  )}
                </div>
                {pickTopicsIn === r.id &&
                  (topicsByRoom[r.id] ?? []).map((t) => (
                    <label key={t.id} className="check" style={{ marginLeft: 28 }}>
                      <input type="checkbox" checked={f.topicIds.includes(t.id)} onChange={() => toggle('topicIds', t.id)} /> {t.title}
                    </label>
                  ))}
                {pickTopicsIn !== r.id && f.topicIds.some((id) => (topicsByRoom[r.id] ?? []).some((t) => t.id === id)) && (
                  <span className="tiny muted" style={{ marginLeft: 28 }}>
                    {f.topicIds.filter((id) => (topicsByRoom[r.id] ?? []).some((t) => t.id === id)).length} topics selected
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="field full">
          <label className="check">
            <input type="checkbox" checked={f.visibility === 'friends'} onChange={(e) => set({ visibility: e.target.checked ? 'friends' : 'private' })} /> Share this goal with my friend
          </label>
          <span className="hint">Private goals are only visible to you.</span>
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
