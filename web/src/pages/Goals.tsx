// Your goals: each one is a plan split into sprints of days. Open one to plan its days, or pull a
// sprint into a shared room to study it there.
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { addDays, formatDate } from '@shared/dates';
import { planCreateSchema } from '@shared/validation';
import { useAction, useMe, usePlans } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { Empty, ErrorNote, Field, Modal, Spinner } from '../components/ui';
import { PlanLine } from '../components/PlanBits';
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
          <p className="muted">Plan a goal in sprints of days. Pull a sprint into a room when you're ready to study it together.</p>
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
                Make your first plan
              </button>
            }
          >
            For example “GTFO 2026”: 11 sprints of 12 days, with a few problems or chapters on each day.
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
          today={me.today}
          onClose={() => {
            setCreating(false);
            if (params.get('new')) setParams({}, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function NewPlanModal({ today, onClose }: { today: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [f, setF] = useState({ title: '', startDate: today, sprintDays: '12', sprintCount: '4' });
  const [err, setErr] = useState<string | null>(null);
  const body = { title: f.title, startDate: f.startDate, sprintDays: Number(f.sprintDays), sprintCount: Number(f.sprintCount) };
  const valid = planCreateSchema.safeParse(body).success;
  const days = body.sprintDays * body.sprintCount;
  const create = useAction(() => api.post<{ id: string }>('/plans', body), {
    invalidate: [['plans']],
    success: 'Goal created 🌱',
    onSuccess: (r) => {
      onClose();
      navigate(`/goals/${r.id}`);
    },
    onError: (e: ApiError) => {
      setErr(e.message);
      return true;
    },
  });

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
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate(undefined);
        }}
      >
        <Field label="Goal" full>
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. GTFO 2026" maxLength={140} />
        </Field>
        <Field label="Starts on" full>
          <input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </Field>
        <Field label="Days per sprint">
          <input className="input" type="number" min="1" max="60" inputMode="numeric" value={f.sprintDays} onChange={(e) => setF({ ...f, sprintDays: e.target.value })} />
        </Field>
        <Field label="Number of sprints">
          <input className="input" type="number" min="1" max="100" inputMode="numeric" value={f.sprintCount} onChange={(e) => setF({ ...f, sprintCount: e.target.value })} />
        </Field>
        {valid && (
          <p className="small muted full">
            {days} days in total, ending {formatDate(addDays(f.startDate, days - 1), { day: 'numeric', month: 'short', year: 'numeric' })}. You can add sprints later.
          </p>
        )}
        {err && (
          <div className="banner error full" role="alert">
            {err}
          </div>
        )}
      </form>
    </Modal>
  );
}
