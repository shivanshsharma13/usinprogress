import { useState } from 'react';
import { Link } from 'react-router';
import { formatDate } from '@shared/dates';
import type { ProgressStats, PublicUser, SessionRecord } from '@shared/types';
import { useAction, useActivity, useFriends, useMe, usePlans, useProgress, useRooms, useSessions } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { personVars } from '../lib/theme';
import { ErrorNote, Field, fmt, Menu, Modal, ProgressBar, Spinner } from '../components/ui';
import { ActivityFeed } from '../components/Encourage';
import { PlanLine } from '../components/PlanBits';

export function ProgressPage() {
  const { data: me } = useMe();
  const { data: friends } = useFriends();
  const friend = friends?.friends[0]?.user;
  const mine = useProgress();
  const theirs = useProgress(friend?.id);
  const { data: plans } = usePlans();
  const { data: rooms } = useRooms();
  const { data: sessions } = useSessions();
  const { data: activity } = useActivity();
  const [correcting, setCorrecting] = useState<SessionRecord | null>(null);
  const discard = useAction((id: string) => api.post(`/sessions/${id}/discard`), { invalidate: [['sessions'], ['progress'], ['rooms'], ['plan'], ['plans']], success: 'Session discarded (kept in history)' });

  if (!me || mine.isLoading) return <Spinner />;
  if (mine.error || !mine.data) return <ErrorNote error={mine.error} retry={mine.refetch} />;

  const people: PublicUser[] = [me, ...(friend ? [friend] : [])];
  const statsBy: Record<string, ProgressStats | undefined> = { [me.id]: mine.data, ...(friend ? { [friend.id]: theirs.data } : {}) };
  const maxDay = Math.max(1, ...people.flatMap((p) => statsBy[p.id]?.daily.map((d) => d.ms) ?? [0]));

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Progress</h1>
          <p className="muted">Two gardens growing side by side — not a race.</p>
        </div>
      </div>

      <div className="grid-2">
        {people.map((p) => {
          const s = statsBy[p.id];
          return (
            <div key={p.id} className="card tint stack" style={personVars(p.accent)}>
              <h2>{p.id === me.id ? 'You' : p.displayName}</h2>
              {s ? (
                <div className="grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12 }}>
                  <Stat label="Today" value={fmt(s.todayMs)} />
                  <Stat label="This week" value={fmt(s.weekMs)} />
                  <Stat label="Topics completed" value={String(s.completedTopics)} />
                  <Stat label="Tasks done" value={String(s.completedTasks)} />
                  <Stat label="Study sessions" value={String(s.sessions)} />
                </div>
              ) : (
                <Spinner />
              )}
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Last 7 days</h2>
          <div className="legend">
            {people.map((p) => (
              <span key={p.id} style={personVars(p.accent)}>
                <span className="dot" /> {p.id === me.id ? 'You' : p.displayName}
              </span>
            ))}
          </div>
        </div>
        <div className="bars7" role="img" aria-label="Focused time per day for the last 7 days">
          {mine.data.daily.map((d, i) => (
            <div key={d.date} className="col">
              {people.map((p) => {
                const ms = statsBy[p.id]?.daily[i]?.ms ?? 0;
                return <i key={p.id} style={{ ...personVars(p.accent), height: `${(ms / maxDay) * 100}%` }} title={`${p.displayName}: ${fmt(ms)}`} />;
              })}
            </div>
          ))}
        </div>
        <div className="bars7-labels">
          {mine.data.daily.map((d) => (
            <span key={d.date}>{formatDate(d.date, { weekday: 'short' })}</span>
          ))}
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <h2>Your goals</h2>
            <Link to="/goals" className="small muted">
              Open goals
            </Link>
          </div>
          <div className="stack">
            {(plans ?? []).filter((p) => p.status === 'active').map((p) => (
              <PlanLine key={p.id} plan={p} today={me.today} accent={me.accent} />
            ))}
            {!(plans ?? []).some((p) => p.status === 'active') && <p className="small muted">No active goals.</p>}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Rooms</h2>
          </div>
          <div className="stack">
            {(rooms ?? []).filter((r) => r.status === 'active').map((r) => (
              <Link key={r.id} to={`/rooms/${r.id}`} className="stack" style={{ textDecoration: 'none', gap: 6 }}>
                <b>{r.name}</b>
                {r.members.map((m) => (
                  <div key={m.user.id} className="row small">
                    <span style={{ width: 80 }}>{m.user.id === me.id ? 'You' : m.user.displayName}</span>
                    <div className="grow">
                      <ProgressBar value={m.completed} max={m.total} accent={m.user.accent} thin />
                    </div>
                    <span className="muted num">
                      {m.completed}/{m.total}
                    </span>
                  </div>
                ))}
              </Link>
            ))}
            {!(rooms ?? []).length && <p className="small muted">No rooms yet.</p>}
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <h2>Your study sessions</h2>
            <span className="tiny muted">Only you can see these</span>
          </div>
          <div className="list">
            {(sessions ?? []).slice(0, 25).map((s) => (
              <div key={s.id} className="list-item" style={{ opacity: s.state === 'discarded' ? 0.55 : 1 }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="bold small">
                    {s.topicTitle}
                    {s.isRevision && <span className="chip outline" style={{ marginLeft: 6 }}>Revision</span>}
                  </div>
                  <div className="tiny muted">
                    {s.roomName} · {new Date(s.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {s.state === 'discarded' ? ' · Discarded' : s.state !== 'finished' ? ' · In progress' : ''}
                  </div>
                  {s.corrections.length > 0 && (
                    <div className="tiny muted">
                      Corrected: {s.corrections.map((c) => `${fmt(c.oldMs)} → ${fmt(c.newMs)}${c.reason ? ` (${c.reason})` : ''}`).join('; ')}
                    </div>
                  )}
                  {s.note && <div className="tiny">📝 {s.note}</div>}
                </div>
                <span className="num bold small">{fmt(s.focusedMs)}</span>
                {s.state === 'finished' && (
                  <Menu
                    items={[
                      { label: 'Correct the time', onClick: () => setCorrecting(s) },
                      { label: 'Discard (started by accident)', danger: true, onClick: () => confirm('Discard this session? It will stop counting but stays in your history.') && discard.mutate(s.id) },
                    ]}
                  />
                )}
              </div>
            ))}
            {!(sessions ?? []).length && <p className="small muted">No sessions yet. Press Start studying on any topic.</p>}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Recent activity</h2>
          </div>
          <ActivityFeed items={activity?.activity ?? []} meId={me.id} />
        </div>
      </div>

      {correcting && <CorrectModal session={correcting} onClose={() => setCorrecting(null)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="num bold" style={{ fontSize: '1.35rem' }}>{value}</div>
      <div className="tiny muted">{label}</div>
    </div>
  );
}

function CorrectModal({ session, onClose }: { session: SessionRecord; onClose: () => void }) {
  const [minutes, setMinutes] = useState(String(Math.round(session.focusedMs / 60_000)));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const save = useAction(() => api.post(`/sessions/${session.id}/correct`, { minutes: Math.round(Number(minutes)), reason }), {
    invalidate: [['sessions'], ['progress'], ['rooms'], ['room'], ['plan'], ['plans']],
    success: 'Session corrected — the original is kept in history',
    onSuccess: onClose,
    onError: (e: ApiError) => {
      setErr(e.message);
      return true;
    },
  });
  return (
    <Modal
      title="Correct session time"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={save.isPending || minutes === ''} onClick={() => save.mutate(undefined)}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">
          {session.topicTitle} · recorded {fmt(session.focusedMs)}
          {session.measuredMs != null && session.measuredMs !== session.focusedMs ? ` (timer measured ${fmt(session.measuredMs)})` : ''}
        </p>
        <Field label="Focused minutes">
          <input className="input" type="number" min="0" max="1440" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </Field>
        <Field label="Reason (optional)">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Forgot to pause during lunch" maxLength={200} />
        </Field>
        {err && <div className="banner error">{err}</div>}
      </div>
    </Modal>
  );
}
