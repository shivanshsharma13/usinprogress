import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ROOM_COLORS } from '@shared/theme';
import { daysBetween, formatDate } from '@shared/dates';
import { formatMinutes } from '@shared/timer';
import type { PublicUser, RoomDetail, Topic, TopicMemberProgress } from '@shared/types';
import { useAction, useMe, useRoom, useTopicHistory } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { personVars } from '../lib/theme';
import { Avatar, Empty, ErrorNote, Field, fmt, LiveDot, Menu, Modal, ProgressBar, Spinner, StatusLine, relativeTime } from '../components/ui';
import { ActivityFeed } from '../components/Encourage';
import { Plant } from '../components/Plant';
import { CheckIcon, ChevronLeft, PlayIcon, PlusIcon } from '../components/icons';

export function RoomPage() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data: room, isLoading, error, refetch } = useRoom(id);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [editTopic, setEditTopic] = useState<Topic | null>(null);
  const [historyFor, setHistoryFor] = useState<Topic | null>(null);
  const [adding, setAdding] = useState(false);

  const inv = [['room', id!], ['rooms'], ['goals'], ['progress'], ['session']];
  const complete = useAction((topicId: string) => api.post(`/topics/${topicId}/complete`), { invalidate: inv, success: 'Topic complete 🌼' });
  const reopen = useAction(({ topicId, mode }: { topicId: string; mode: 'revise' | 'undo' }) => api.post(`/topics/${topicId}/reopen`, { mode }), {
    invalidate: inv,
    success: (r) => (r ? 'Updated' : undefined),
  });
  const archive = useAction((topicId: string) => api.del(`/topics/${topicId}`), { invalidate: inv, success: 'Topic archived — its history is kept' });
  const restore = useAction((topicId: string) => api.patch(`/topics/${topicId}`, { status: 'active' }), { invalidate: inv, success: 'Topic restored' });
  const reorder = useAction((topicIds: string[]) => api.put(`/rooms/${id}/topics/order`, { topicIds }), { invalidate: inv });

  if (isLoading || !me) return <Spinner />;
  if (error || !room) return <ErrorNote error={error} retry={refetch} />;

  const [mine, partner] = room.members;
  const partnerUser = partner?.user;
  const daysLeft = daysBetween(me.today, room.endDate);
  const allDone = room.topics.length > 0 && room.topics.every((t) => isDone(t.progress[me.id]) && t.progress[me.id]?.status !== 'revising');
  const users: Record<string, PublicUser> = Object.fromEntries(room.members.map((m) => [m.user.id, m.user]));

  const move = (index: number, delta: number) => {
    const ids = room.topics.map((t) => t.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids);
  };

  return (
    <div className="stack-lg">
      <Link to="/rooms" className="row small muted" style={{ textDecoration: 'none' }}>
        <ChevronLeft width={18} /> Rooms
      </Link>

      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="row" style={personVars(room.color)}>
          <Plant percent={mine && mine.total ? (mine.completed / mine.total) * 100 : 0} size={60} color="var(--c)" />
          <div>
            <h1>{room.name}</h1>
            <p className="muted small">
              {formatDate(room.startDate)} – {formatDate(room.endDate, { month: 'short', day: 'numeric', year: 'numeric' })}
              {room.status === 'archived' ? ' · Archived' : daysLeft >= 0 ? ` · ${daysLeft} days left` : ' · Finished'}
            </p>
            {room.description && <p className="small">{room.description}</p>}
          </div>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => setEditing(true)}>
            Edit room
          </button>
          {room.nextTopic && room.status === 'active' && (
            <button className="btn primary" onClick={() => navigate(`/study?topic=${room.nextTopic!.id}`)}>
              <PlayIcon /> Start studying
            </button>
          )}
        </div>
      </div>

      {/* Each person's progress, kept separate and never combined into one number */}
      <div className="grid-2">
        {room.members.map((m) => (
          <div key={m.user.id} className="card tint stack" style={{ ...personVars(m.user.accent), gap: 8 }}>
            <div className="row">
              <Avatar user={m.user} size={36} />
              <div className="grow">
                <div className="row" style={{ gap: 6 }}>
                  <b>{m.user.id === me.id ? 'You' : m.user.displayName}</b>
                  <LiveDot status={m.status} accent={m.user.accent} />
                </div>
                <div className="tiny">
                  {m.user.id === me.id ? (m.status.state === 'idle' ? 'Not studying' : m.status.state === 'paused' ? 'Paused' : `Studying ${m.status.topicTitle ?? ''}`) : <StatusLine status={m.status} name={m.user.displayName} />}
                </div>
              </div>
            </div>
            <div className="num bold">
              {m.completed} of {m.total} topics completed
            </div>
            <ProgressBar value={m.completed} max={m.total} accent={m.user.accent} label={`${m.user.displayName} progress`} />
            <div className="small muted">{fmt(m.focusedMs)} focused in this room</div>
          </div>
        ))}
      </div>

      <div className="home-grid">
        <div className="stack">
          <div className="row between">
            <h2>Topics</h2>
            {room.status === 'active' && (
              <button className="btn small" onClick={() => setAdding((a) => !a)}>
                <PlusIcon /> Add topic
              </button>
            )}
          </div>

          {(adding || room.topics.length === 0) && room.status === 'active' && (
            <AddTopic roomId={room.id} firstTime={room.topics.length === 0} onDone={() => setAdding(false)} />
          )}

          {allDone && (
            <div className="card tint center stack" style={{ alignItems: 'center', ...personVars(me.accent) }}>
              <Plant percent={100} size={72} color="var(--c)" />
              <h3>You've completed every topic in this room 🌸</h3>
              <p className="small muted">Add more topics, or reopen one to revise it.</p>
              <button className="btn" onClick={() => setAdding(true)}>
                <PlusIcon /> Add more topics
              </button>
            </div>
          )}

          {room.topics.map((t, i) => {
            const my = t.progress[me.id];
            const theirs = partnerUser ? t.progress[partnerUser.id] : undefined;
            const done = isDone(my) && my?.status !== 'revising';
            return (
              <div key={t.id} className="topic-row">
                <span className={`idx${done ? ' done' : ''}`} aria-hidden="true">
                  {done ? <CheckIcon width={16} /> : i + 1}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="bold">{t.title}</div>
                  <div className="tiny muted">
                    {[t.category, t.estimatedMinutes ? `Est. ${formatMinutes(t.estimatedMinutes)}` : '', t.sessionTargetMinutes ? `${t.sessionTargetMinutes}m sessions` : '', t.deadline ? `Due ${formatDate(t.deadline)}` : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div className="member-status">
                    {my && <MemberStatus user={users[me.id]} you progress={my} />}
                    {theirs && partnerUser && <MemberStatus user={partnerUser} progress={theirs} />}
                  </div>
                </div>
                <div className="row actions" style={{ gap: 6 }}>
                  {room.status === 'active' && (
                    <button className="btn small" onClick={() => navigate(`/study?topic=${t.id}`)} aria-label={`Study ${t.title}`}>
                      <PlayIcon /> {done ? 'Revise' : 'Study'}
                    </button>
                  )}
                  {!done && room.status === 'active' && (
                    <button className="btn small" disabled={complete.isPending} onClick={() => complete.mutate(t.id)} aria-label={`Mark ${t.title} complete`}>
                      <CheckIcon /> Done
                    </button>
                  )}
                  <Menu
                    label={`More actions for ${t.title}`}
                    items={[
                      { label: 'Edit topic', onClick: () => setEditTopic(t) },
                      { label: 'Move up', onClick: () => move(i, -1), hidden: i === 0 },
                      { label: 'Move down', onClick: () => move(i, 1), hidden: i === room.topics.length - 1 },
                      { label: 'History', onClick: () => setHistoryFor(t) },
                      { label: 'Reopen to revise', onClick: () => reopen.mutate({ topicId: t.id, mode: 'revise' }), hidden: my?.status !== 'completed' },
                      {
                        label: 'Undo my completion',
                        onClick: () => confirm('Undo your completion? It will stop counting toward your goals. The record is kept in history.') && reopen.mutate({ topicId: t.id, mode: 'undo' }),
                        hidden: !my || (my.status !== 'completed' && my.status !== 'revising'),
                      },
                      { label: 'Archive topic', danger: true, onClick: () => confirm(`Archive “${t.title}”? Study sessions and history are kept.`) && archive.mutate(t.id) },
                    ]}
                  />
                </div>
              </div>
            );
          })}

          {room.archivedTopics.length > 0 && (
            <details>
              <summary className="small muted">Archived topics ({room.archivedTopics.length})</summary>
              <div className="stack" style={{ marginTop: 10 }}>
                {room.archivedTopics.map((t) => (
                  <div key={t.id} className="row card soft">
                    <span className="grow">{t.title}</span>
                    <button className="btn small ghost" onClick={() => setHistoryFor(t)}>
                      History
                    </button>
                    <button className="btn small" onClick={() => restore.mutate(t.id)}>
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        <div className="stack-lg">
          {room.linkedGoals.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>Counts toward</h3>
              </div>
              <div className="row wrap">
                {room.linkedGoals.map((g) => (
                  <Link key={g.id} to="/goals" className="chip c" style={personVars(users[g.ownerId]?.accent)}>
                    {g.title}
                  </Link>
                ))}
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-head">
              <h3>Room activity</h3>
            </div>
            <ActivityFeed items={room.activity} meId={me.id} empty="Completed topics will show up here." />
          </div>
        </div>
      </div>

      {editing && <EditRoomModal room={room} onClose={() => setEditing(false)} />}
      {editTopic && <TopicModal roomId={room.id} topic={editTopic} onClose={() => setEditTopic(null)} />}
      {historyFor && <HistoryModal topic={historyFor} users={users} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function isDone(p: TopicMemberProgress | undefined) {
  return Boolean(p && (p.status === 'completed' || p.firstCompletedAt));
}

function MemberStatus({ user, progress, you }: { user: PublicUser; progress: TopicMemberProgress; you?: boolean }) {
  const name = you ? 'You' : user.displayName;
  const label =
    progress.status === 'completed'
      ? `${name}: done${progress.completedAt ? ` ${formatDate(new Date(progress.completedAt).toISOString().slice(0, 10))}` : ''}`
      : progress.status === 'revising'
        ? `${name}: revising`
        : progress.status === 'in_progress'
          ? `${name}: in progress`
          : `${name}: not started`;
  return (
    <span className="chip c" style={personVars(user.accent)} title={`${progress.sessions} sessions`}>
      {progress.status === 'completed' ? '✓ ' : ''}
      {label}
      {progress.focusedMs > 0 && <span className="muted num"> · {fmt(progress.focusedMs)}</span>}
    </span>
  );
}

function AddTopic({ roomId, firstTime, onDone }: { roomId: string; firstTime: boolean; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [more, setMore] = useState(false);
  const [details, setDetails] = useState({ category: '', estimatedHours: '', target: '', deadline: '', description: '' });
  const add = useAction(
    () =>
      api.post(`/rooms/${roomId}/topics`, {
        title,
        category: details.category || undefined,
        description: details.description || undefined,
        estimatedMinutes: details.estimatedHours ? Math.round(Number(details.estimatedHours) * 60) : null,
        sessionTargetMinutes: details.target ? Number(details.target) : null,
        deadline: details.deadline || null,
      }),
    {
      invalidate: [['room', roomId], ['rooms']],
      onSuccess: () => {
        setTitle('');
        setDetails({ category: '', estimatedHours: '', target: '', deadline: '', description: '' });
      },
    },
  );
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) add.mutate(undefined);
      }}
    >
      {firstTime && (
        <div className="stack" style={{ gap: 4 }}>
          <h3>Add your first topic</h3>
          <p className="small muted">
            A topic is one thing to learn, like “Binary Search” or “Enzyme kinetics”. You'll each tick it off on your own. Add a few, then press Study.
          </p>
        </div>
      )}
      <div className="row">
        <input className="input grow" placeholder="Topic title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} aria-label="Topic title" />
        <button className="btn primary" disabled={!title.trim() || add.isPending}>
          Add
        </button>
      </div>
      <button type="button" className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setMore((m) => !m)}>
        {more ? 'Fewer details' : 'More details (optional)'}
      </button>
      {more && (
        <div className="form-grid">
          <Field label="Subject or category">
            <input className="input" value={details.category} onChange={(e) => setDetails({ ...details, category: e.target.value })} placeholder="e.g. Searching" />
          </Field>
          <Field label="Estimated time to finish (hours)" hint="Your guess for the whole topic.">
            <input className="input" type="number" min="0" step="0.5" inputMode="decimal" value={details.estimatedHours} onChange={(e) => setDetails({ ...details, estimatedHours: e.target.value })} />
          </Field>
          <Field label="Focus session length (minutes)" hint="e.g. 45 — one sitting.">
            <input className="input" type="number" min="1" max="600" inputMode="numeric" value={details.target} onChange={(e) => setDetails({ ...details, target: e.target.value })} />
          </Field>
          <Field label="Deadline">
            <input className="input" type="date" value={details.deadline} onChange={(e) => setDetails({ ...details, deadline: e.target.value })} />
          </Field>
          <Field label="Notes" full>
            <textarea className="input" value={details.description} onChange={(e) => setDetails({ ...details, description: e.target.value })} />
          </Field>
        </div>
      )}
      {!firstTime && (
        <button type="button" className="btn ghost small" style={{ alignSelf: 'flex-end' }} onClick={onDone}>
          Close
        </button>
      )}
    </form>
  );
}

function TopicModal({ roomId, topic, onClose }: { roomId: string; topic: Topic; onClose: () => void }) {
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
      invalidate: [['room', roomId], ['rooms']],
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
        <Field label="Subject or category">
          <input className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
        </Field>
        <Field label="Deadline">
          <input className="input" type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} />
        </Field>
        <Field label="Estimated time to finish (hours)" hint="Your estimate is kept separately from actual time.">
          <input className="input" type="number" min="0" step="0.5" value={f.estimatedHours} onChange={(e) => setF({ ...f, estimatedHours: e.target.value })} />
        </Field>
        <Field label="Focus session length (minutes)">
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
  created: 'added this topic',
  edited: 'edited this topic',
  completed: 'completed it',
  revision_completed: 'finished a revision',
  reopened_for_revision: 'reopened it to revise',
  completion_undone: 'undid a completion',
  archived: 'archived it',
  restored: 'restored it',
};

function HistoryModal({ topic, users, onClose }: { topic: Topic; users: Record<string, PublicUser>; onClose: () => void }) {
  const { data, isLoading } = useTopicHistory(topic.id);
  return (
    <Modal title={`History · ${topic.title}`} onClose={onClose}>
      <p className="small muted" style={{ marginBottom: 12 }}>
        Added {relativeTime(topic.createdAt)}
        {topic.estimatedMinutes ? ` · Estimated ${formatMinutes(topic.estimatedMinutes)}` : ''}
      </p>
      <div className="grid-2" style={{ marginBottom: 16 }}>
        {Object.entries(topic.progress).map(([uid, p]) => (
          <div key={uid} className="card tint" style={personVars(users[uid]?.accent)}>
            <b>{users[uid]?.displayName}</b>
            <div className="small">Actual focused time: {fmt(p.focusedMs)}</div>
            <div className="small">Sessions: {p.sessions}</div>
            <div className="small">Status: {p.status.replace('_', ' ')}</div>
            {p.firstCompletedAt && <div className="small">First completed {new Date(p.firstCompletedAt).toLocaleDateString()}</div>}
          </div>
        ))}
      </div>
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="list">
          {data?.events.map((e) => (
            <div key={e.id} className="list-item small">
              <span className="dot" style={personVars(users[e.userId]?.accent)} />
              <span className="grow">
                <b>{users[e.userId]?.displayName ?? 'Someone'}</b> {EVENT_LABEL[e.type] ?? e.type}
              </span>
              <span className="tiny muted">{new Date(e.createdAt).toLocaleString()}</span>
            </div>
          ))}
          {data?.sessions.map((s, i) => (
            <div key={i} className="list-item small">
              <span className="dot" style={personVars(users[s.userId]?.accent)} />
              <span className="grow">
                <b>{users[s.userId]?.displayName}</b> studied {fmt(s.focusedMs)}
                {s.isRevision ? ' (revision)' : ''}
              </span>
              <span className="tiny muted">{new Date(s.startedAt).toLocaleString()}</span>
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
