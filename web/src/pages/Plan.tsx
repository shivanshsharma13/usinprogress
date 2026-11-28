// One goal: a list of tasks in a room. Add a task with a day (or none), tick it off, study it. The room it lives
// in shows the same tasks next to your friend's.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Plan, PlanSummary } from '@shared/types';
import { useAction, useMe, usePlan, usePlans, useRooms } from '../lib/queries';
import { api } from '../lib/api';
import { ErrorNote, Field, fmt, Menu, Modal, ProgressBar, Spinner } from '../components/ui';
import { AddTopicBox, TaskList, TopicList } from '../components/GoalTasks';
import { plannedItems } from '@shared/planView';
import { percent } from '../components/PlanBits';

export function PlanPage() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data: plan, isLoading, error, refetch } = usePlan(id);
  const [dialog, setDialog] = useState<'rename' | 'room' | 'merge' | null>(null);
  const navigate = useNavigate();
  const update = useAction((body: object) => api.patch(`/plans/${id}`, body), { invalidate: [['plan', id!], ['plans'], ['room'], ['rooms']] });

  if (isLoading || !me) return <Spinner />;
  if (error || !plan) return <ErrorNote error={error} retry={refetch} />;
  const active = plan.status === 'active';
  const planned = plannedItems(plan.tasks);

  return (
    <div className="stack-lg" style={{ maxWidth: 720, margin: '0 auto', width: '100%' }}>
      <div className="small muted">
        <Link to="/goals">Goals</Link> / {plan.title}
      </div>
      <div className="row between top">
        <div className="grow" style={{ minWidth: 0 }}>
          <h1>{plan.title}</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {plan.roomId ? (
              <>
                In <Link to={`/rooms/${plan.roomId}`}>{plan.roomName}</Link> · {plan.done} of {plan.total} topics done · {fmt(plan.focusedMs)} spent
              </>
            ) : (
              'Not in a room yet'
            )}
          </p>
        </div>
        <Menu
          items={[
            { label: 'Rename', onClick: () => setDialog('rename') },
            { label: 'Move to another room', onClick: () => setDialog('room'), hidden: !active },
            { label: 'Merge into another goal', onClick: () => setDialog('merge'), hidden: !active },
            { label: 'Archive goal', danger: true, onClick: () => confirm('Archive this goal? Its tasks and history are kept.') && update.mutate({ status: 'archived' }, { onSuccess: () => navigate('/goals') }), hidden: !active },
            { label: 'Restore goal', onClick: () => update.mutate({ status: 'active' }), hidden: active },
          ]}
        />
      </div>
      {plan.total > 0 && <ProgressBar value={plan.done} max={plan.total} accent={me.accent} label={`${plan.title}: ${percent(plan.done, plan.total)}%`} />}

      {active && !plan.roomId && (
        <div className="banner" role="status">
          Pick a room for this goal, so its tasks show up there and you can study them.{' '}
          <button className="btn small primary" onClick={() => setDialog('room')}>
            Pick a room
          </button>
        </div>
      )}
      {active && plan.roomId && <AddTopicBox planId={plan.id} existing={plan.tasks} />}

      {plan.tasks.length ? (
        <TopicList tasks={plan.tasks} today={me.today} active={active && Boolean(plan.roomId)} />
      ) : (
        <p className="small muted">No topics yet. Add your first one above, then open it to add subtopics.</p>
      )}

      {/* The same list as the room (what's planned by day), folded away at the end. */}
      <details className="card planned-card">
        <summary className="row between">
          <h2>Planned</h2>
          <span className="small muted">
            {planned.filter((t) => !t.done && t.date === me.today).length} today · {planned.filter((t) => !t.done && t.date !== null && t.date > me.today).length} coming up
          </span>
        </summary>
        <div style={{ marginTop: 12 }}>
          <TaskList
            tasks={planned}
            today={me.today}
            isMe
            active={active && Boolean(plan.roomId)}
            empty={<p className="small muted">Nothing planned yet. Open a topic above and give its subtopics a day; they show here and in {plan.roomName ?? 'the room'}.</p>}
          />
        </div>
      </details>

      {dialog === 'rename' && <RenameModal plan={plan} onClose={() => setDialog(null)} />}
      {dialog === 'room' && <RoomModal plan={plan} onClose={() => setDialog(null)} />}
      {dialog === 'merge' && <MergeModal plan={plan} onClose={() => setDialog(null)} />}
    </div>
  );
}

function RenameModal({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [title, setTitle] = useState(plan.title);
  const save = useAction(() => api.patch(`/plans/${plan.id}`, { title: title.trim() }), { invalidate: [['plan', plan.id], ['plans'], ['room']], success: 'Renamed', onSuccess: onClose });
  return (
    <Modal
      title="Rename goal"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!title.trim() || save.isPending} onClick={() => save.mutate(undefined)}>
          Save
        </button>
      }
    >
      <Field label="Goal">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} />
      </Field>
    </Modal>
  );
}

/** Which room a goal lives in. Moving it takes its tasks along. */
export function RoomPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data: rooms } = useRooms();
  const open = (rooms ?? []).filter((r) => r.status === 'active');
  if (rooms && !open.length)
    return (
      <p className="small muted">
        You don't have a room yet. <Link to="/rooms?new=1">Create one with your friend</Link> first.
      </p>
    );
  return (
    <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Room">
      {open.map((r) => (
        <button key={r.id} type="button" className={`chip-btn${value === r.id ? ' on' : ''}`} aria-pressed={value === r.id} onClick={() => onChange(r.id)}>
          {r.name}
        </button>
      ))}
    </div>
  );
}

function RoomModal({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [room, setRoom] = useState(plan.roomId ?? '');
  const save = useAction(() => api.patch(`/plans/${plan.id}`, { roomId: room }), { invalidate: [['plan', plan.id], ['plans'], ['room'], ['rooms']], success: 'Moved', onSuccess: onClose });
  return (
    <Modal
      title="Which room?"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!room || room === plan.roomId || save.isPending} onClick={() => save.mutate(undefined)}>
          Move here
        </button>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          The goal's tasks show up in this room, next to your friend's.
        </p>
        <RoomPicker value={room} onChange={setRoom} />
      </div>
    </Modal>
  );
}

function MergeModal({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: plans } = usePlans();
  const others = (plans ?? []).filter((p: PlanSummary) => p.status === 'active' && p.id !== plan.id);
  const [into, setInto] = useState('');
  const target = others.find((p) => p.id === into);
  const merge = useAction(() => api.post<{ moved: number }>(`/plans/${plan.id}/merge`, { into }), {
    invalidate: [['plan'], ['plans'], ['room'], ['rooms']],
    success: (r) => `Moved ${r.moved} ${r.moved === 1 ? 'task' : 'tasks'} into “${target?.title}”`,
    onSuccess: () => {
      onClose();
      navigate(`/goals/${into}`, { replace: true });
    },
  });
  return (
    <Modal
      title="Merge into another goal"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!into || merge.isPending} onClick={() => merge.mutate(undefined)}>
          Merge
        </button>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          All {plan.total} tasks of “{plan.title}” move over with their days, progress and study time. This goal is then archived.
        </p>
        {others.length ? (
          <div className="row wrap" style={{ gap: 6 }}>
            {others.map((p) => (
              <button key={p.id} className={`chip-btn${into === p.id ? ' on' : ''}`} aria-pressed={into === p.id} onClick={() => setInto(p.id)}>
                {p.title}
              </button>
            ))}
          </div>
        ) : (
          <p className="small">You have no other goal to merge into.</p>
        )}
      </div>
    </Modal>
  );
}
