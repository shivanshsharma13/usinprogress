import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ROOM_COLORS } from '@shared/theme';
import { daysBetween, formatDate } from '@shared/dates';
import type { GoalTask, MemberProgress, RoomDetail, Topic } from '@shared/types';
import { useAction, useMe, useRoom } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { personVars } from '../lib/theme';
import { Avatar, ErrorNote, Field, LiveDot, Menu, Modal, ProgressBar, Spinner, StatusLine } from '../components/ui';
import { ActivityFeed } from '../components/Encourage';
import { Forest, TodayPlant } from '../components/Garden';
import { LeaveRoomModal } from '../components/Social';
import { RevisionsDue } from '../components/Revisions';
import { AddTaskBox, TaskList } from '../components/GoalTasks';
import { CamCallButton } from '../components/StudyCam';
import { ChevronLeft, PlayIcon } from '../components/icons';

// Each person owns the tasks they add. Both lists are visible side by side, but only the owner can study,
// complete or change their own (enforced by the server too).
export function RoomPage() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data: room, isLoading, error, refetch } = useRoom(id);
  const [params] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const navigate = useNavigate();
  const setStatus = useAction((status: 'active' | 'archived') => api.patch(`/rooms/${id}`, { status }), {
    invalidate: [['room'], ['rooms'], ['friend']],
    success: (_r) => undefined,
  });

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
        <div className="row" style={{ gap: 6 }}>
          {room.status === 'active' &&
            room.members.filter((m) => m.user.id !== me.id).map((m) => <CamCallButton key={m.user.id} friend={m.user} className="btn" />)}
          <button className="btn" onClick={() => setEditing(true)}>
            Edit room
          </button>
          <Menu
            label="More for this room"
            items={[
              { label: 'Archive room', onClick: () => confirm('Archive this room? Everything is kept and you can reopen it.') && setStatus.mutate('archived'), hidden: room.status !== 'active' },
              { label: 'Restore room', onClick: () => setStatus.mutate('active'), hidden: room.status === 'active' },
              { label: 'Remove from my rooms', danger: true, onClick: () => setLeaving(true) },
            ]}
          />
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        {room.members.map((m) => (
          <PersonColumn key={m.user.id} room={room} member={m} isMe={m.user.id === me.id} today={me.today} autoAdd={m.user.id === me.id && params.get('add') === '1'} />
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
      {leaving && <LeaveRoomModal room={room} meId={me.id} onClose={() => setLeaving(false)} onDone={() => navigate('/rooms', { replace: true })} />}
    </div>
  );
}

/** A topic with no goal task you can see: your friend's undated tasks, or topics from before goals lived in rooms. */
function topicAsTask(t: Topic, ownerId: string): GoalTask {
  const p = t.progress[ownerId];
  return {
    id: `topic:${t.id}`,
    planId: '',
    planTitle: '',
    ownerId,
    title: t.title,
    date: null,
    estMinutes: t.estimatedMinutes,
    topicId: t.id,
    done: p?.status === 'completed',
    doneDate: p?.completedAt ? new Date(p.completedAt).toISOString().slice(0, 10) : null,
    focusedMs: p?.focusedMs ?? 0,
    description: t.description,
    parts: t.parts,
  };
}

/** One person's side of the room: today's plant, an "Add a task" box (yours), and their tasks by day. */
function PersonColumn({ room, member, isMe, today, autoAdd }: { room: RoomDetail; member: MemberProgress; isMe: boolean; today: string; autoAdd?: boolean }) {
  const navigate = useNavigate();
  const ownerId = member.user.id;
  const name = isMe ? 'You' : member.user.displayName;
  const active = room.status === 'active';
  const linked = new Set(room.tasks.map((t) => t.topicId));
  const tasks: GoalTask[] = [
    ...room.tasks.filter((t) => t.ownerId === ownerId),
    ...room.topics.filter((t) => t.createdBy === ownerId && !linked.has(t.id)).map((t) => topicAsTask(t, ownerId)),
  ];
  const goals = room.goals.filter((g) => g.ownerId === ownerId);
  const todays = tasks.filter((t) => t.date === today);
  const doneToday = todays.filter((t) => t.done).length;
  const allDone = todays.length > 0 && doneToday === todays.length;
  const trees = room.forest[ownerId] ?? 0;

  return (
    <section className="stack" style={personVars(member.user.accent)} aria-label={`${name}'s tasks`}>
      <div className="card tint stack" style={{ gap: 10 }}>
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
        </div>
        <div className="today-tree">
          <TodayPlant percent={todays.length ? (doneToday / todays.length) * 100 : 0} color="var(--c)" />
          <div className="stack" style={{ gap: 6, alignItems: 'center', textAlign: 'center' }}>
            <b className="num">{todays.length ? `${doneToday} of ${todays.length} done today` : 'Nothing planned today'}</b>
            <span className="tiny muted">
              {allDone
                ? `All done for today. A new tree is growing in ${isMe ? 'your' : 'the'} forest 🌳`
                : todays.length
                  ? `${isMe ? 'Your' : 'The'} plant grows a leaf with every task and blooms when today is finished.`
                  : isMe
                    ? 'Add a task for today below, and watch the plant grow.'
                    : 'A rest day. The plant is napping.'}
            </span>
          </div>
          {todays.length > 0 && <ProgressBar value={doneToday} max={todays.length} accent={member.user.accent} label={`${name}: ${doneToday} of ${todays.length} today`} />}
        </div>
        {isMe && active && room.nextTopic && (
          <button className="btn primary study-next" onClick={() => navigate(`/study?topic=${room.nextTopic!.id}`)}>
            <PlayIcon /> <span>Study next: {room.nextTopic.title}</span>
          </button>
        )}
      </div>

      {isMe && active && <RevisionsDue roomId={room.id} />}
      {isMe && active && <AddTaskBox roomId={room.id} goals={goals} today={today} autoFocus={autoAdd} existing={tasks} />}

      <TaskList
        tasks={tasks}
        today={today}
        isMe={isMe}
        active={active}
        showGoal={goals.length > 1}
        empty={<p className="small muted">{isMe ? 'No tasks yet. Add your first one above.' : `${member.user.displayName} hasn’t added any tasks here yet.`}</p>}
      />

      <div className="card forest-card">
        <div className="row between">
          <b>{isMe ? 'Your forest' : `${member.user.displayName}’s forest`}</b>
          <span className="tiny muted num">
            {trees} {trees === 1 ? 'tree' : 'trees'}
          </span>
        </div>
        <Forest count={trees} color="var(--c)" blooms={room.blooms} />
        <span className="tiny muted">
          {trees ? 'One tree for every day everything planned was finished.' : 'Finish everything planned for a day to plant the first tree.'}
          {room.blooms > 0 && ` 🌻 ${room.blooms === 1 ? 'A sunflower' : `${room.blooms} sunflowers`} for weekly challenges you won together.`}
        </span>
      </div>
    </section>
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

