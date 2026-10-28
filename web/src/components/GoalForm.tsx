import { useState } from 'react';
import { addDays, endOfMonth, startOfMonth, startOfWeek } from '@shared/dates';
import type { Goal, RoomSummary } from '@shared/types';
import { api, ApiError } from '../lib/api';
import { useAction } from '../lib/queries';
import { Field, Modal } from './ui';
import { PERIOD_LABEL } from './GoalBits';

function datesFor(period: Goal['period'], today: string) {
  if (period === 'yearly') return { startDate: `${today.slice(0, 4)}-01-01`, deadline: `${today.slice(0, 4)}-12-31` };
  if (period === 'monthly') return { startDate: startOfMonth(today), deadline: endOfMonth(today) };
  if (period === 'weekly') {
    const s = startOfWeek(today);
    return { startDate: s, deadline: addDays(s, 6) };
  }
  return { startDate: today, deadline: addDays(today, 30) };
}

const SMALLER: Record<Goal['period'], Goal['period']> = { yearly: 'monthly', monthly: 'weekly', weekly: 'weekly', custom: 'custom' };

/**
 * Create or edit one of your goals. A goal always lives in a room; it can sit under a bigger goal
 * of yours in the same room.
 */
export function GoalForm({
  goal,
  roomId: fixedRoom,
  parent,
  myGoals,
  rooms,
  today,
  onClose,
}: {
  goal?: Goal | null;
  roomId?: string;
  parent?: Goal | null;
  myGoals: Goal[];
  rooms?: RoomSummary[];
  today: string;
  onClose: () => void;
}) {
  const period = goal?.period ?? (parent ? SMALLER[parent.period] : 'yearly');
  const [f, setF] = useState({
    title: goal?.title ?? '',
    period,
    ...(goal ? { startDate: goal.startDate, deadline: goal.deadline } : datesFor(period, today)),
    roomId: goal?.roomId ?? fixedRoom ?? parent?.roomId ?? rooms?.[0]?.id ?? '',
    parentId: goal?.parentId ?? parent?.id ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  // Possible parents: your goals in the same room, never this goal or anything beneath it.
  const below = new Set<string>();
  if (goal) {
    const stack = [goal.id];
    while (stack.length) {
      const id = stack.pop()!;
      below.add(id);
      myGoals.filter((g) => g.parentId === id).forEach((g) => stack.push(g.id));
    }
  }
  const parents = myGoals.filter((g) => g.roomId === f.roomId && g.status !== 'archived' && !below.has(g.id));

  const save = useAction(
    () => {
      const body = { title: f.title, period: f.period, startDate: f.startDate, deadline: f.deadline, roomId: f.roomId, parentId: f.parentId || null };
      return goal ? api.patch(`/goals/${goal.id}`, body) : api.post('/goals', body);
    },
    {
      invalidate: [['goals'], ['room'], ['rooms']],
      success: goal ? 'Goal saved' : 'Goal added 🌱',
      onSuccess: onClose,
      onError: (e: ApiError) => {
        setErr(e.message);
        return true;
      },
    },
  );

  const chooseRoom = !fixedRoom && !parent && rooms && (!goal || !goal.roomId || goal.childIds.length === 0);

  return (
    <Modal
      title={goal ? 'Edit goal' : parent ? `A smaller goal for “${parent.title}”` : 'New goal'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!f.title.trim() || !f.roomId || save.isPending} onClick={() => save.mutate(undefined)}>
            {save.isPending ? 'Saving…' : 'Save goal'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Goal" full>
          <input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Finish biochemistry units 1–4" maxLength={140} />
        </Field>
        <div className="field full">
          <span className="label">For</span>
          <div className="row wrap">
            {(['yearly', 'monthly', 'weekly', 'custom'] as const).map((p) => (
              <button type="button" key={p} className={`chip-btn${f.period === p ? ' on' : ''}`} onClick={() => set({ period: p, ...(goal ? {} : datesFor(p, today)) })}>
                {p === 'custom' ? 'Custom dates' : `This ${p === 'yearly' ? 'year' : p === 'monthly' ? 'month' : 'week'}`}
              </button>
            ))}
          </div>
        </div>
        <Field label="Starts">
          <input className="input" type="date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} />
        </Field>
        <Field label="Ends">
          <input className="input" type="date" value={f.deadline} onChange={(e) => set({ deadline: e.target.value })} />
        </Field>
        {chooseRoom && (
          <Field label="Room" full>
            <select className="input" value={f.roomId} onChange={(e) => set({ roomId: e.target.value, parentId: '' })}>
              {!f.roomId && <option value="">Choose a room</option>}
              {rooms!.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {parents.length > 0 && (
          <Field label="Part of a bigger goal (optional)" hint="Topics done here also count toward the bigger goal." full>
            <select className="input" value={f.parentId} onChange={(e) => set({ parentId: e.target.value })}>
              <option value="">None</option>
              {parents.map((g) => (
                <option key={g.id} value={g.id}>
                  {PERIOD_LABEL[g.period]}: {g.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        {err && (
          <div className="banner error full" role="alert">
            {err}
          </div>
        )}
      </div>
    </Modal>
  );
}
