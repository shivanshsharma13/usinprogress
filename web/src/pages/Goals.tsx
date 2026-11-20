// Your goals: each one is a list of tasks in a room. Open one to add tasks and pick their days.
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAction, useMe, usePlans, useRooms } from '../lib/queries';
import { api } from '../lib/api';
import { Empty, ErrorNote, Field, Modal, Spinner } from '../components/ui';
import { PlanLine } from '../components/PlanBits';
import { RoomPicker } from './Plan';
import { Plant } from '../components/Plant';
import { PlusIcon } from '../components/icons';

export function GoalsPage() {
  const { data: me } = useMe();
  const { data: plans, isLoading, error, refetch } = usePlans();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [showArchived, setShowArchived] = useState(false);

  if (isLoading || !me) return <Spinner />;
  if (error || !plans) return <ErrorNote error={error} retry={refetch} />;
  const active = plans.filter((p) => p.status === 'active');
  const archived = plans.filter((p) => p.status === 'archived');

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Goals</h1>
          <p className="muted">A goal is a list of tasks, like a subject or a project. Its tasks show up in your room, next to your friend's.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <PlusIcon /> New goal
        </button>
      </div>

      {!active.length && (
        <div className="card">
          <Empty
            title="No goals yet"
            art={<Plant percent={10} size={96} />}
            action={
              <button className="btn primary big" onClick={() => setCreating(true)}>
                Make your first goal
              </button>
            }
          >
            For example “Obs & gynae” or “DSA”. Then add tasks with a day — today, tomorrow, any day, or none.
          </Empty>
        </div>
      )}

      <div className="grid-2">
        {active.map((p) => (
          <div key={p.id} className="card">
            <PlanLine plan={p} today={me.today} accent={me.accent} />
          </div>
        ))}
      </div>

      {archived.length > 0 && (
        <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowArchived((s) => !s)}>
          {showArchived ? 'Hide archived goals' : `Show archived goals (${archived.length})`}
        </button>
      )}
      {showArchived && (
        <div className="grid-2">
          {archived.map((p) => (
            <div key={p.id} className="card soft">
              <PlanLine plan={p} today={me.today} />
            </div>
          ))}
        </div>
      )}

      {creating && (
        <NewPlanModal
          onClose={() => {
            setCreating(false);
            if (params.get('new')) setParams({}, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function NewPlanModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { data: rooms } = useRooms();
  const open = (rooms ?? []).filter((r) => r.status === 'active');
  const [title, setTitle] = useState('');
  const [room, setRoom] = useState('');
  const roomId = room || (open.length === 1 ? open[0].id : '');
  const create = useAction(() => api.post<{ id: string }>('/plans', { title: title.trim(), roomId }), {
    invalidate: [['plans'], ['room'], ['rooms']],
    success: 'Goal created 🌱',
    onSuccess: (r) => {
      onClose();
      navigate(`/goals/${r.id}`);
    },
  });
  const valid = title.trim() && roomId;

  return (
    <Modal
      title="New goal"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || create.isPending} onClick={() => create.mutate(undefined)}>
            {create.isPending ? 'Creating…' : 'Create goal'}
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate(undefined);
        }}
      >
        <Field label="Goal">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Obs & gynae, or DSA" maxLength={140} autoFocus />
        </Field>
        {open.length !== 1 && (
          <Field label="Room">
            <RoomPicker value={roomId} onChange={setRoom} />
          </Field>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          Next, add tasks to it — each with a day, or none. They show up in {open.length === 1 ? `“${open[0].name}”` : 'the room'} next to your friend's.
        </p>
      </form>
    </Modal>
  );
}
