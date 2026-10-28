// Every goal you have, grouped by the room it lives in. Topics are added and studied in the room;
// this page is the overview of how each goal is going.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatDate } from '@shared/dates';
import type { Goal } from '@shared/types';
import { useAction, useFriends, useGoals, useMe, useRooms, useSharedGoals } from '../lib/queries';
import { api } from '../lib/api';
import { personVars } from '../lib/theme';
import { Empty, ErrorNote, Menu, ProgressBar, Spinner } from '../components/ui';
import { goalValueText, PERIOD_LABEL, rootGoals } from '../components/GoalBits';
import { GoalForm } from '../components/GoalForm';
import { Plant } from '../components/Plant';
import { PlusIcon } from '../components/icons';

interface FormState {
  goal?: Goal;
  parent?: Goal;
}

export function GoalsPage() {
  const { data: me } = useMe();
  const { data: goals, isLoading, error, refetch } = useGoals();
  const { data: rooms } = useRooms();
  const { data: friends } = useFriends();
  const [params, setParams] = useSearchParams();
  const [form, setForm] = useState<FormState | null>(params.get('new') ? {} : null);

  if (isLoading || !me) return <Spinner />;
  if (error || !goals) return <ErrorNote error={error} retry={refetch} />;

  const activeRooms = (rooms ?? []).filter((r) => r.status === 'active');
  const visible = goals.filter((g) => g.status !== 'archived');
  const byRoom = new Map<string, Goal[]>();
  for (const g of visible) byRoom.set(g.roomId ?? '', [...(byRoom.get(g.roomId ?? '') ?? []), g]);

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Goals</h1>
          <p className="muted">Each goal lives in a room. Add topics to it there — every topic you finish fills it up.</p>
        </div>
        {activeRooms.length > 0 && (
          <button className="btn primary" onClick={() => setForm({})}>
            <PlusIcon /> New goal
          </button>
        )}
      </div>

      {!visible.length && (
        <div className="card">
          <Empty
            title="No goals yet"
            art={<Plant percent={10} size={96} />}
            action={
              activeRooms.length ? (
                <button className="btn primary big" onClick={() => setForm({})}>
                  Add your first goal
                </button>
              ) : (
                <Link to="/rooms" className="btn primary big">
                  Go to rooms
                </Link>
              )
            }
          >
            {activeRooms.length
              ? 'Start with something big for this year, then break it into monthly and weekly goals with topics under them.'
              : 'Goals live inside a room you share with your friend. Create a room first.'}
          </Empty>
        </div>
      )}

      {[...byRoom.entries()].map(([roomId, list]) => (
        <section key={roomId || 'none'} className="stack">
          <div className="row between">
            <h2>{list[0].roomName ?? 'Not in a room yet'}</h2>
            {roomId && (
              <Link to={`/rooms/${roomId}`} className="small muted">
                Open room
              </Link>
            )}
          </div>
          {!roomId && <p className="small muted">Edit these to choose a room, so you can add topics to them.</p>}
          {rootGoals(list).map((g) => (
            <GoalTree key={g.id} goal={g} all={list} accent={me.accent} onForm={setForm} />
          ))}
        </section>
      ))}

      {friends?.friends.map((f) => <FriendGoals key={f.user.id} userId={f.user.id} name={f.user.displayName} accent={f.user.accent} />)}

      {form && (
        <GoalForm
          goal={form.goal}
          parent={form.parent}
          myGoals={goals}
          rooms={activeRooms}
          today={me.today}
          onClose={() => {
            setForm(null);
            if (params.get('new')) setParams({}, { replace: true });
          }}
        />
      )}
    </div>
  );
}

/** A goal and the smaller goals under it. Without `onForm` it's read-only (a friend's goals). */
function GoalTree({ goal, all, accent, onForm }: { goal: Goal; all: Goal[]; accent: string; onForm?: (s: FormState) => void }) {
  const children = all.filter((g) => g.parentId === goal.id);
  const inv = [['goals'], ['room'], ['rooms']];
  const update = useAction((body: object) => api.patch(`/goals/${goal.id}`, body), { invalidate: inv });
  const archive = useAction(() => api.del(`/goals/${goal.id}`), { invalidate: inv, success: 'Goal archived — its topics moved up' });
  return (
    <div className="goal-card" style={personVars(accent)}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="row between top">
          <div>
            <div className="bold">{goal.title}</div>
            <div className="tiny muted">
              {PERIOD_LABEL[goal.period]} · {formatDate(goal.startDate)} – {formatDate(goal.deadline)}
            </div>
          </div>
          <div className="row" style={{ gap: 4 }}>
            <span className="small bold num">{goal.progress.percent}%</span>
            {onForm && (
              <Menu
                items={[
                  { label: 'Add a smaller goal', onClick: () => onForm({ parent: goal }), hidden: goal.period === 'weekly' || !goal.roomId },
                  { label: 'Edit goal', onClick: () => onForm({ goal }) },
                  { label: 'Mark goal done', onClick: () => update.mutate({ status: 'done' }), hidden: goal.status === 'done' },
                  { label: 'Mark not done', onClick: () => update.mutate({ status: 'active' }), hidden: goal.status !== 'done' },
                  { label: 'Archive goal', danger: true, onClick: () => confirm(`Archive “${goal.title}”? Its topics move to the goal above it.`) && archive.mutate(undefined) },
                ]}
              />
            )}
          </div>
        </div>
        <ProgressBar value={goal.progress.percent} max={100} label={goal.title} />
        <span className="small muted num">{goalValueText(goal)}</span>
      </div>
      {children.length > 0 && (
        <div className="goal-children">
          {children.map((c) => (
            <GoalTree key={c.id} goal={c} all={all} accent={accent} onForm={onForm} />
          ))}
        </div>
      )}
    </div>
  );
}

function FriendGoals({ userId, name, accent }: { userId: string; name: string; accent: string }) {
  const { data } = useSharedGoals(userId);
  const goals = data ?? [];
  return (
    <section className="stack">
      <h2 className="row" style={personVars(accent)}>
        <span className="dot" />
        {name}'s goals
      </h2>
      {goals.length ? (
        rootGoals(goals).map((g) => <GoalTree key={g.id} goal={g} all={goals} accent={accent} />)
      ) : (
        <p className="small muted">{name} hasn't added goals in your rooms yet.</p>
      )}
    </section>
  );
}
