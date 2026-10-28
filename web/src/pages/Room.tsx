import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ROOM_COLORS } from '@shared/theme';
import { daysBetween, formatDate } from '@shared/dates';
import { formatMinutes } from '@shared/timer';
import type { MemberProgress, PlanDay, RoomDetail, RoomSprint, Topic, TopicMemberProgress } from '@shared/types';
import { useAction, useMe, useRoom, useTopicHistory } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { personVars } from '../lib/theme';
import { Avatar, Empty, ErrorNote, Field, fmt, LiveDot, Menu, Modal, ProgressBar, Spinner, StatusLine, relativeTime } from '../components/ui';
import { ActivityFeed } from '../components/Encourage';
import { Plant } from '../components/Plant';
import { DAY_STATUS_LABEL } from '../components/PlanBits';
import { CheckIcon, ChevronDown, ChevronLeft, ChevronRight, PlayIcon, PlusIcon } from '../components/icons';

// Each person owns the topics they add. Both lists are visible side by side, but only the owner
// can study, complete or change their own topics (enforced by the server too).
export function RoomPage() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data: room, isLoading, error, refetch } = useRoom(id);
  const [editing, setEditing] = useState(false);

  if (isLoading || !me) return <Spinner />;
  if (error || !room) return <ErrorNote error={error} retry={refetch} />;

  const daysLeft = daysBetween(me.today, room.endDate);
  const myArchived = room.archivedTopics.filter((t) => t.createdBy === me.id);

  return (
    <div className="stack-lg">
      <Link to="/rooms" className="row small muted" style={{ textDecoration: 'none' }}>
        <ChevronLeft width={18} /> Rooms
      </Link>

      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>{room.name}</h1>
          <p className="muted small">
            {formatDate(room.startDate)} – {formatDate(room.endDate, { month: 'short', day: 'numeric', year: 'numeric' })}
            {room.status === 'archived' ? ' · Archived' : daysLeft >= 0 ? ` · ${daysLeft} days left` : ' · Finished'}
          </p>
          {room.description && <p className="small">{room.description}</p>}
        </div>
        <button className="btn" onClick={() => setEditing(true)}>
          Edit room
        </button>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        {room.members.map((m) => (
          <PersonColumn key={m.user.id} room={room} member={m} isMe={m.user.id === me.id} />
        ))}
      </div>

      {myArchived.length > 0 && <ArchivedTopics roomId={room.id} topics={myArchived} />}

      <details className="card">
        <summary>Room activity</summary>
        <div style={{ marginTop: 12 }}>
          <ActivityFeed items={room.activity} meId={me.id} empty="Completed topics will show up here." />
        </div>
      </details>

      {editing && <EditRoomModal room={room} onClose={() => setEditing(false)} />}
    </div>
  );
}

function PersonColumn({ room, member, isMe }: { room: RoomDetail; member: MemberProgress; isMe: boolean }) {
  const navigate = useNavigate();
  const ownerId = member.user.id;
  const name = isMe ? 'You' : member.user.displayName;
  const active = room.status === 'active';
  const topics = room.topics.filter((t) => t.createdBy === ownerId);
  const sprints = room.sprints.filter((s) => s.ownerId === ownerId);
  const inSprints = new Set(sprints.flatMap((s) => s.days.flatMap((d) => d.tasks.map((t) => t.topicId))));
  const loose = topics.filter((t) => !inSprints.has(t.id));
  const ctx: RowContext = { ownerId, isMe, active };

  return (
    <section className="stack" style={personVars(member.user.accent)} aria-label={`${name}'s plan`}>
      <div className="card tint stack" style={{ gap: 8 }}>
        <div className="row">
          <Avatar user={member.user} size={40} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 6 }}>
              <h2>{name}</h2>
              <LiveDot status={member.status} accent={member.user.accent} />
            </div>
            <div className="tiny">
              {isMe ? (member.status.state === 'idle' ? 'Not studying right now' : member.status.state === 'paused' ? 'Paused' : `Studying ${member.status.topicTitle ?? ''}`) : <StatusLine status={member.status} name={member.user.displayName} />}
            </div>
          </div>
          <Plant percent={member.total ? (member.completed / member.total) * 100 : 0} size={44} color="var(--c)" />
        </div>
        <ProgressBar value={member.completed} max={member.total} accent={member.user.accent} label={`${name}: ${member.completed} of ${member.total}`} />
        <div className="row between small">
          <span className="bold num">
            {member.completed} of {member.total} done
          </span>
          <span className="muted num">{fmt(member.focusedMs)} focused</span>
        </div>
        {isMe && active && room.nextTopic && (
          <button className="btn primary" onClick={() => navigate(`/study?topic=${room.nextTopic!.id}`)}>
            <PlayIcon /> Study next: {room.nextTopic.title}
          </button>
        )}
      </div>

      {!sprints.length && !topics.length && (
        <p className="small muted">
          {isMe ? (
            <>
              Nothing here yet. Open one of your <Link to="/goals">goals</Link> and pull its current sprint into this room.
            </>
          ) : (
            `${member.user.displayName} hasn’t brought a sprint into this room yet.`
          )}
        </p>
      )}

      {sprints.map((s) => (
        <SprintBlock key={`${s.planId}-${s.number}`} sprint={s} topics={topics} {...ctx} />
      ))}

      {(loose.length > 0 || (isMe && active && !sprints.length)) && (
        <div className="goal-block">
          <div className="goal-head">
            <b className="grow">{sprints.length ? 'Other topics' : 'Topics'}</b>
          </div>
          {loose.map((t, i) => (
            <TopicRow key={t.id} topic={t} index={i} siblings={loose} {...ctx} />
          ))}
          {isMe && active && <AddTopic roomId={room.id} />}
        </div>
      )}
    </section>
  );
}

/** Whose rows these are, and whether the viewer may act on them. */
interface RowContext {
  ownerId: string;
  isMe: boolean;
  active: boolean;
}

/** A sprint pulled into the room: its days, with today open. Tasks are studied as room topics. */
function SprintBlock({ sprint, topics, ...ctx }: { sprint: RoomSprint; topics: Topic[] } & RowContext) {
  const byId = new Map(topics.map((t) => [t.id, t]));
  return (
    <div className="goal-block">
      <div className="goal-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="bold">
            {sprint.planTitle} · Sprint {sprint.number}
          </div>
          <div className="tiny muted num">
            {sprint.done} of {sprint.total} tasks done · {formatDate(sprint.startDate)} – {formatDate(sprint.endDate)}
          </div>
        </div>
        {ctx.isMe && (
          <Link to={`/goals/${sprint.planId}`} className="btn ghost small">
            Open plan
          </Link>
        )}
      </div>
      <ProgressBar value={sprint.done} max={sprint.total} thin label={`Sprint ${sprint.number}`} />
      {sprint.days
        .filter((d) => d.tasks.length || d.status === 'today')
        .map((d) => (
          <SprintDay key={d.day} day={d} topics={d.tasks.map((t) => byId.get(t.topicId ?? '')).filter(Boolean) as Topic[]} {...ctx} />
        ))}
    </div>
  );
}

function SprintDay({ day, topics, ...ctx }: { day: PlanDay; topics: Topic[] } & RowContext) {
  const [open, setOpen] = useState(day.status === 'today');
  const label = DAY_STATUS_LABEL[day.status];
  return (
    <div className={`day-row${day.status === 'today' ? ' today' : ''}`}>
      {day.status === 'today' && <span className="today-tag">Today</span>}
      <button className="day-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={day.status === 'today' ? 'bold' : ''}>
          Day {day.number} · {formatDate(day.date, { weekday: 'short', day: 'numeric', month: 'short' })}
        </span>
        <span className="grow" />
        {day.status !== 'today' && label && <span className={`tiny day-status ${day.status}`}>{label}</span>}
        {open ? <ChevronDown width={16} /> : <ChevronRight width={16} />}
      </button>
      {open && (
        <div className="day-body" style={{ gap: 8 }}>
          {topics.length ? topics.map((t, i) => <TopicRow key={t.id} topic={t} index={i} siblings={topics} planned {...ctx} />) : <p className="small muted">Nothing planned.</p>}
        </div>
      )}
    </div>
  );
}

function statusText(p: TopicMemberProgress | undefined) {
  if (!p) return 'Not started';
  const time = p.focusedMs > 0 ? ` · ${fmt(p.focusedMs)}` : '';
  if (p.status === 'completed') return `Done ${p.completedAt ? formatDate(new Date(p.completedAt).toISOString().slice(0, 10)) : ''}${time}`;
  if (p.status === 'revising') return `Revising${time}`;
  if (p.status === 'in_progress') return `In progress${time}`;
  return 'Not started';
}

/** `planned` rows come from a goal's sprint: they're edited on the goal page, not here. */
function TopicRow({ topic: t, index, siblings, ownerId, isMe, active, planned }: { topic: Topic; index: number; siblings: Topic[]; planned?: boolean } & RowContext) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const p = t.progress[ownerId];
  const done = p?.status === 'completed';

  const inv = [['room', t.roomId], ['rooms'], ['plan'], ['plans'], ['progress'], ['session']];
  const complete = useAction(() => api.post(`/topics/${t.id}/complete`), { invalidate: inv, success: 'Topic complete 🌼' });
  const reopen = useAction((mode: 'revise' | 'undo') => api.post(`/topics/${t.id}/reopen`, { mode }), { invalidate: inv });
  const archive = useAction(() => api.del(`/topics/${t.id}`), { invalidate: inv, success: 'Topic archived — its history is kept' });
  const reorder = useAction((topicIds: string[]) => api.put(`/rooms/${t.roomId}/topics/order`, { topicIds }), { invalidate: inv });
  const move = (delta: number) => {
    const ids = siblings.map((s) => s.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    reorder.mutate(ids);
  };

  const meta = [t.category, t.estimatedMinutes ? `~${formatMinutes(t.estimatedMinutes)}` : '', t.deadline ? `due ${formatDate(t.deadline)}` : ''].filter(Boolean).join(' · ');

  return (
    <div className="topic-row">
      <span className={`idx${done ? ' done' : ''}`} aria-hidden="true">
        {done ? <CheckIcon width={16} /> : index + 1}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="bold">{t.title}</div>
        <div className="tiny muted">
          {statusText(p)}
          {meta && ` · ${meta}`}
        </div>
      </div>
      {isMe && active && (
        <div className="row actions" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => navigate(`/study?topic=${t.id}`)} aria-label={`Study ${t.title}`}>
            <PlayIcon /> {done ? 'Revise' : 'Study'}
          </button>
          {!done && (
            <button className="btn small" disabled={complete.isPending} onClick={() => complete.mutate(undefined)} aria-label={`Mark ${t.title} done`}>
              <CheckIcon /> Done
            </button>
          )}
          <Menu
            label={`More actions for ${t.title}`}
            items={[
              { label: 'Edit', onClick: () => setEditing(true), hidden: planned },
              { label: 'Move up', onClick: () => move(-1), hidden: planned || index === 0 },
              { label: 'Move down', onClick: () => move(1), hidden: planned || index === siblings.length - 1 },
              { label: 'History', onClick: () => setHistory(true) },
              { label: 'Undo “done”', onClick: () => confirm('Undo this completion? It will stop counting toward your goals. The record stays in history.') && reopen.mutate('undo'), hidden: !done },
              { label: 'Archive', danger: true, onClick: () => confirm(`Archive “${t.title}”? Its study time and history are kept.`) && archive.mutate(undefined), hidden: planned },
            ]}
          />
        </div>
      )}
      {editing && <TopicModal topic={t} onClose={() => setEditing(false)} />}
      {history && <HistoryModal topic={t} onClose={() => setHistory(false)} />}
    </div>
  );
}

function ArchivedTopics({ roomId, topics }: { roomId: string; topics: Topic[] }) {
  const restore = useAction((topicId: string) => api.patch(`/topics/${topicId}`, { status: 'active' }), { invalidate: [['room', roomId], ['rooms']], success: 'Topic restored' });
  return (
    <details>
      <summary className="small muted">Your archived topics ({topics.length})</summary>
      <div className="stack" style={{ marginTop: 10 }}>
        {topics.map((t) => (
          <div key={t.id} className="row card soft">
            <span className="grow">{t.title}</span>
            <button className="btn small" onClick={() => restore.mutate(t.id)}>
              Restore
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}

function AddTopic({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [more, setMore] = useState(false);
  const [details, setDetails] = useState({ category: '', estimatedHours: '', target: '', deadline: '' });
  const add = useAction(
    () =>
      api.post(`/rooms/${roomId}/topics`, {
        title,
        category: details.category || undefined,
        estimatedMinutes: details.estimatedHours ? Math.round(Number(details.estimatedHours) * 60) : null,
        sessionTargetMinutes: details.target ? Number(details.target) : null,
        deadline: details.deadline || null,
      }),
    {
      invalidate: [['room', roomId], ['rooms'], ['plan'], ['plans']],
      onSuccess: () => {
        setTitle('');
        setDetails({ category: '', estimatedHours: '', target: '', deadline: '' });
      },
    },
  );
  if (!open)
    return (
      <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        <PlusIcon /> Add a topic
      </button>
    );
  return (
    <form
      className="stack"
      style={{ gap: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) add.mutate(undefined);
      }}
    >
      <div className="row">
        <input className="input grow" placeholder="e.g. Binary Search" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} aria-label="Topic title" autoFocus />
        <button className="btn primary" disabled={!title.trim() || add.isPending}>
          Add
        </button>
      </div>
      <div className="row between">
        <button type="button" className="btn ghost small" onClick={() => setMore((m) => !m)}>
          {more ? 'Fewer details' : 'More details'}
        </button>
        <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
          Done adding
        </button>
      </div>
      {more && (
        <div className="form-grid">
          <Field label="Subject">
            <input className="input" value={details.category} onChange={(e) => setDetails({ ...details, category: e.target.value })} placeholder="e.g. Searching" />
          </Field>
          <Field label="Estimated hours to finish">
            <input className="input" type="number" min="0" step="0.5" inputMode="decimal" value={details.estimatedHours} onChange={(e) => setDetails({ ...details, estimatedHours: e.target.value })} />
          </Field>
          <Field label="Session length (minutes)" hint="e.g. 45 — one sitting.">
            <input className="input" type="number" min="1" max="600" inputMode="numeric" value={details.target} onChange={(e) => setDetails({ ...details, target: e.target.value })} />
          </Field>
          <Field label="Deadline">
            <input className="input" type="date" value={details.deadline} onChange={(e) => setDetails({ ...details, deadline: e.target.value })} />
          </Field>
        </div>
      )}
    </form>
  );
}

function TopicModal({ topic, onClose }: { topic: Topic; onClose: () => void }) {
  const [f, setF] = useState({
    title: topic.title,
    description: topic.description,
    category: topic.category,
    estimatedHours: topic.estimatedMinutes ? String(topic.estimatedMinutes / 60) : '',
    target: topic.sessionTargetMinutes ? String(topic.sessionTargetMinutes) : '',
    deadline: topic.deadline ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const save = useAction(
    () =>
      api.patch(`/topics/${topic.id}`, {
        title: f.title,
        description: f.description,
        category: f.category,
        estimatedMinutes: f.estimatedHours ? Math.round(Number(f.estimatedHours) * 60) : null,
        sessionTargetMinutes: f.target ? Number(f.target) : null,
        deadline: f.deadline || null,
      }),
    {
      invalidate: [['room', topic.roomId], ['rooms'], ['plan'], ['plans']],
      success: 'Topic saved',
      onSuccess: onClose,
      onError: (e: ApiError) => {
        setErr(e.message);
        return true;
      },
    },
  );
  return (
    <Modal
      title="Edit topic"
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
        <Field label="Title" full>
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={140} />
        </Field>
        <Field label="Subject">
          <input className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
        </Field>
        <Field label="Deadline">
          <input className="input" type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} />
        </Field>
        <Field label="Estimated hours to finish" hint="Kept separate from your actual time.">
          <input className="input" type="number" min="0" step="0.5" value={f.estimatedHours} onChange={(e) => setF({ ...f, estimatedHours: e.target.value })} />
        </Field>
        <Field label="Session length (minutes)">
          <input className="input" type="number" min="1" max="600" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
        </Field>
        <Field label="Notes" full>
          <textarea className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        {err && <div className="banner error full">{err}</div>}
      </div>
    </Modal>
  );
}

const EVENT_LABEL: Record<string, string> = {
  created: 'Added',
  edited: 'Edited',
  completed: 'Completed',
  revision_completed: 'Finished a revision',
  reopened_for_revision: 'Reopened to revise',
  completion_undone: 'Undid a completion',
  archived: 'Archived',
  restored: 'Restored',
};

function HistoryModal({ topic, onClose }: { topic: Topic; onClose: () => void }) {
  const { data, isLoading } = useTopicHistory(topic.id);
  const p = topic.progress[topic.createdBy];
  return (
    <Modal title={topic.title} onClose={onClose}>
      <div className="row wrap" style={{ gap: 20, marginBottom: 16 }}>
        <div>
          <div className="tiny muted">Estimated</div>
          <b>{topic.estimatedMinutes ? formatMinutes(topic.estimatedMinutes) : '—'}</b>
        </div>
        <div>
          <div className="tiny muted">Actual focused time</div>
          <b>{fmt(p?.focusedMs ?? 0)}</b>
        </div>
        <div>
          <div className="tiny muted">Sessions</div>
          <b>{p?.sessions ?? 0}</b>
        </div>
      </div>
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="list">
          {[
            ...(data?.events ?? []).map((e) => ({ key: e.id, at: e.createdAt, text: EVENT_LABEL[e.type] ?? e.type })),
            ...(data?.sessions ?? []).map((s, i) => ({ key: `s${i}`, at: s.startedAt, text: `Studied ${fmt(s.focusedMs)}${s.isRevision ? ' (revision)' : ''}` })),
          ]
            .sort((a, b) => b.at - a.at)
            .map((row) => (
              <div key={row.key} className="list-item small">
                <span className="grow">{row.text}</span>
                <span className="tiny muted">{relativeTime(row.at)}</span>
              </div>
            ))}
          {!data?.events.length && !data?.sessions.length && <Empty title="No history yet" />}
        </div>
      )}
    </Modal>
  );
}

function EditRoomModal({ room, onClose }: { room: RoomDetail; onClose: () => void }) {
  const [f, setF] = useState({ name: room.name, description: room.description, startDate: room.startDate, endDate: room.endDate, color: room.color });
  const [err, setErr] = useState<string | null>(null);
  const save = useAction((body: object) => api.patch(`/rooms/${room.id}`, body), {
    invalidate: [['room', room.id], ['rooms']],
    success: 'Room saved',
    onSuccess: onClose,
    onError: (e: ApiError) => {
      setErr(e.message);
      return true;
    },
  });
  return (
    <Modal
      title="Edit room"
      onClose={onClose}
      footer={
        <>
          {room.status === 'active' ? (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => confirm('Archive this room? Everything is kept and you can reopen it.') && save.mutate({ status: 'archived' })}>
              Archive room
            </button>
          ) : (
            <button className="btn" style={{ marginRight: 'auto' }} onClick={() => save.mutate({ status: 'active' })}>
              Reopen room
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={save.isPending || !f.name.trim()} onClick={() => save.mutate(f)}>
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Room name" full>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} />
        </Field>
        <Field label="Description" full>
          <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={300} />
        </Field>
        <Field label="Start date">
          <input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </Field>
        <Field label="End date">
          <input className="input" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </Field>
        <div className="field full">
          <span className="label">Colour</span>
          <div className="row wrap">
            {ROOM_COLORS.map((c) => (
              <button key={c} className={`swatch${f.color === c ? ' on' : ''}`} style={{ background: `var(--acc-${c})` }} aria-label={c} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })} />
            ))}
          </div>
        </div>
        {err && <div className="banner error full">{err}</div>}
      </div>
    </Modal>
  );
}

