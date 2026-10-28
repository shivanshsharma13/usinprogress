import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ROOM_COLORS } from '@shared/theme';
import { addDays, addMonths, formatDate } from '@shared/dates';
import { useAction, useFriends, useMe, useRooms } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { personVars } from '../lib/theme';
import { Avatar, Empty, ErrorNote, Field, fmt, LiveDot, Modal, ProgressBar, Spinner } from '../components/ui';
import { Plant } from '../components/Plant';
import { PlusIcon } from '../components/icons';

export function RoomsPage() {
  const { data: me } = useMe();
  const { data: rooms, isLoading, error, refetch } = useRooms();
  const { data: friends } = useFriends();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');
  const navigate = useNavigate();
  if (isLoading || !me) return <Spinner />;
  if (error || !rooms) return <ErrorNote error={error} retry={refetch} />;
  const hasFriend = Boolean(friends?.friends.length);
  const active = rooms.filter((r) => r.status === 'active');
  const archived = rooms.filter((r) => r.status === 'archived');

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Rooms</h1>
          <p className="muted">Shared study plans. Each of you keeps your own progress.</p>
        </div>
        {hasFriend && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <PlusIcon /> New room
          </button>
        )}
      </div>

      {!active.length && (
        <div className="card">
          <Empty
            title={hasFriend ? 'Plant your first room' : 'Rooms need a friend'}
            action={
              hasFriend ? (
                <button className="btn primary big" onClick={() => setCreating(true)}>
                  Create a room
                </button>
              ) : (
                <Link to="/friends" className="btn primary big">
                  Find your friend
                </Link>
              )
            }
          >
            {hasFriend
              ? 'A room is a shared plan like “DSA Roadmap” or “Biochemistry Revision”. Add topics, then study them at your own pace.'
              : 'Rooms are shared between two friends. Add a friend first, then create a room together.'}
          </Empty>
        </div>
      )}

      <div className="grid-2">
        {active.map((r) => {
          const total = r.members[0]?.total ?? 0;
          const together = r.members.reduce((s, m) => s + m.completed, 0);
          return (
            <Link key={r.id} to={`/rooms/${r.id}`} className="card stack" style={{ textDecoration: 'none', ...personVars(r.color) }}>
              <div className="row top">
                <div className="grow">
                  <h2>{r.name}</h2>
                  <div className="small muted">
                    {formatDate(r.startDate)} – {formatDate(r.endDate, { month: 'short', day: 'numeric', year: 'numeric' })} · {total} topics
                  </div>
                </div>
                <Plant percent={total ? (together / (total * Math.max(1, r.members.length))) * 100 : 0} size={52} color="var(--c)" />
              </div>
              {r.members.map((m) => (
                <div key={m.user.id} className="stack" style={{ gap: 4 }}>
                  <div className="row between small">
                    <span className="row" style={{ gap: 6 }}>
                      <LiveDot status={m.status} accent={m.user.accent} />
                      <b>{m.user.id === me.id ? 'You' : m.user.displayName}</b>
                    </span>
                    <span className="muted num">
                      {m.completed} of {m.total} · {fmt(m.focusedMs)}
                    </span>
                  </div>
                  <ProgressBar value={m.completed} max={m.total} accent={m.user.accent} label={`${m.user.displayName}: ${m.completed} of ${m.total}`} />
                </div>
              ))}
            </Link>
          );
        })}
      </div>

      {archived.length > 0 && (
        <details>
          <summary className="muted">Archived rooms ({archived.length})</summary>
          <div className="grid-2" style={{ marginTop: 12 }}>
            {archived.map((r) => (
              <Link key={r.id} to={`/rooms/${r.id}`} className="card soft" style={{ textDecoration: 'none' }}>
                <b>{r.name}</b>
                <div className="small muted">Archived · history kept</div>
              </Link>
            ))}
          </div>
        </details>
      )}

      {creating && (
        <CreateRoomModal
          onClose={() => {
            setCreating(false);
            if (params.get('new')) setParams({}, { replace: true });
          }}
          onCreated={(id) => navigate(`/rooms/${id}`)}
        />
      )}
    </div>
  );
}

const DURATIONS = [3, 4, 5, 6];

export function CreateRoomModal({ friendId, onClose, onCreated }: { friendId?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { data: me } = useMe();
  const { data: friends } = useFriends();
  const today = me?.today ?? new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    friendId: friendId ?? '',
    name: '',
    description: '',
    startDate: today,
    months: 3 as number | 'custom',
    endDate: addDays(addMonths(today, 3), -1),
    color: 'sage',
  });
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const chosenFriend = form.friendId || friends?.friends[0]?.user.id || '';
  const endDate = form.months === 'custom' ? form.endDate : addDays(addMonths(form.startDate, form.months), -1);

  const create = useAction(
    () =>
      api.post<{ id: string }>('/rooms', {
        friendId: chosenFriend,
        name: form.name,
        description: form.description || undefined,
        startDate: form.startDate,
        endDate,
        color: form.color,
      }),
    {
      invalidate: [['rooms']],
      success: 'Room created 🌱',
      onSuccess: (r) => {
        onClose();
        onCreated(r.id);
      },
      onError: (e: ApiError) => {
        setErr({ field: e.data?.field, message: e.message });
        return true;
      },
    },
  );


  return (
    <Modal
      title="New shared room"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={create.isPending || !form.name.trim() || !chosenFriend} onClick={() => create.mutate(undefined)}>
            {create.isPending ? 'Creating…' : 'Create room'}
          </button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined);
        }}
      >
        {!friendId && (friends?.friends.length ?? 0) > 1 && (
          <Field label="With" full>
            <select className="input" value={chosenFriend} onChange={(e) => set({ friendId: e.target.value })}>
              {friends!.friends.map((f) => (
                <option key={f.user.id} value={f.user.id}>
                  {f.user.displayName}
                </option>
              ))}
            </select>
          </Field>
        )}
        {friends?.friends.find((f) => f.user.id === chosenFriend) && (
          <div className="full row">
            <Avatar user={me!} size={32} />
            <Avatar user={friends.friends.find((f) => f.user.id === chosenFriend)!.user} size={32} />
            <span className="small muted">Private to you and {friends.friends.find((f) => f.user.id === chosenFriend)!.user.displayName}</span>
          </div>
        )}
        <Field label="Room name" full error={err?.field === 'name' ? err.message : null}>
          <input className="input" placeholder="e.g. DSA Roadmap" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} />
        </Field>
        <Field label="Description (optional)" full>
          <input className="input" placeholder="What is this room for?" value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} />
        </Field>
        <div className="field full">
          <span className="label">How long?</span>
          <div className="row wrap">
            {DURATIONS.map((m) => (
              <button type="button" key={m} className={`chip-btn${form.months === m ? ' on' : ''}`} onClick={() => set({ months: m })}>
                {m} months
              </button>
            ))}
            <button type="button" className={`chip-btn${form.months === 'custom' ? ' on' : ''}`} onClick={() => set({ months: 'custom', endDate })}>
              Custom dates
            </button>
          </div>
        </div>
        <Field label="Start date">
          <input className="input" type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} />
        </Field>
        <Field label="End date" error={err?.field === 'endDate' ? err.message : null}>
          <input className="input" type="date" value={endDate} disabled={form.months !== 'custom'} onChange={(e) => set({ endDate: e.target.value })} />
        </Field>
        <div className="field full">
          <span className="label">Colour</span>
          <div className="row wrap">
            {ROOM_COLORS.map((c) => (
              <button type="button" key={c} className={`swatch${form.color === c ? ' on' : ''}`} style={{ background: `var(--acc-${c})` }} aria-label={c} aria-pressed={form.color === c} onClick={() => set({ color: c })} />
            ))}
          </div>
        </div>
        
        {err && !err.field && (
          <div className="banner error full" role="alert">
            {err.message}
          </div>
        )}
      </form>
    </Modal>
  );
}
