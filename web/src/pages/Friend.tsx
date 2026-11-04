import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { RoomSummary } from '@shared/types';
import { useAction, useFriend, useMe, useRooms } from '../lib/queries';
import { api } from '../lib/api';
import { personVars } from '../lib/theme';
import { Avatar, ErrorNote, fmt, LiveDot, Menu, ProgressBar, Spinner, StatusLine, relativeTime } from '../components/ui';
import { ActivityFeed, EncourageButtons } from '../components/Encourage';
import { LeaveRoomModal, UnfriendModal } from '../components/Social';
import { ChevronLeft } from '../components/icons';
import { CreateRoomModal } from './Rooms';

export function FriendPage() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data, isLoading, error, refetch } = useFriend(id);
  const { data: allRooms } = useRooms();
  const [unfriending, setUnfriending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [leaving, setLeaving] = useState<RoomSummary | null>(null);
  const navigate = useNavigate();
  const archive = useAction(({ roomId, status }: { roomId: string; status: 'active' | 'archived' }) => api.patch(`/rooms/${roomId}`, { status }), {
    invalidate: [['friend'], ['rooms'], ['room']],
    success: (_r) => undefined,
  });
  if (isLoading || !me) return <Spinner />;
  if (error || !data) return <ErrorNote error={error} retry={refetch} />;
  const { user, status, recentCompletions, rooms, activity, stats } = data;

  return (
    <div className="stack-lg" style={personVars(user.accent)}>
      <Link to="/friends" className="row small muted" style={{ textDecoration: 'none' }}>
        <ChevronLeft width={18} /> Friends
      </Link>
      <div className="card social-hero">
        <div className="social-cover" aria-hidden="true" />
        <div className="social-hero-body">
          <Avatar user={user} size={88} />
          <div className="grow stack" style={{ gap: 4, minWidth: 0 }}>
            <div className="row">
              <h1>{user.displayName}</h1>
              <LiveDot status={status} accent={user.accent} />
            </div>
            <div className="small muted">@{user.username}</div>
            {user.bio && <p className="small">{user.bio}</p>}
            <div className="small">
              <StatusLine status={status} name={user.displayName} />
            </div>
          </div>
          <div className="social-actions">
            <button className="btn primary small" onClick={() => setCreating(true)}>
              New room
            </button>
            <Menu
              label={`More for ${user.displayName}`}
              items={[
                {
                  label: 'Create a room together',
                  onClick: () => setCreating(true),
                },
                {
                  label: 'Unfriend',
                  danger: true,
                  onClick: () => setUnfriending(true),
                },
              ]}
            />
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="stack-lg">
          <div className="card stack">
            <h2>Send some encouragement</h2>
            <EncourageButtons recipientId={user.id} name={user.displayName} withMessage />
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Today and this week</h2>
            </div>
            <div className="row wrap" style={{ gap: 24 }}>
              <div>
                <div className="num bold" style={{ fontSize: '1.5rem' }}>{fmt(stats.todayMs)}</div>
                <div className="small muted">today</div>
              </div>
              <div>
                <div className="num bold" style={{ fontSize: '1.5rem' }}>{fmt(stats.weekMs)}</div>
                <div className="small muted">this week</div>
              </div>
              <div>
                <div className="num bold" style={{ fontSize: '1.5rem' }}>{stats.completedTopics}</div>
                <div className="small muted">topics completed</div>
              </div>
            </div>
          </div>
        </div>
        <div className="stack-lg">
          <div className="card">
            <div className="card-head">
              <h2>Recently completed</h2>
            </div>
            {recentCompletions.length ? (
              <div className="list">
                {recentCompletions.map((c) => (
                  <div key={c.topicId} className="list-item">
                    <span>🌼</span>
                    <div className="grow">
                      <div className="bold small">{c.topicTitle}</div>
                      <div className="tiny muted">
                        {c.roomName} · {relativeTime(c.completedAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="small muted">Nothing completed in your shared rooms yet.</p>
            )}
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Your shared rooms</h2>
            </div>
            {rooms.length ? (
              <div className="stack">
                {rooms.map((r) => {
                  const them = r.members.find((m) => m.user.id === user.id);
                  const archived = r.status === 'archived';
                  return (
                    <div key={r.id} className="row top" style={{ gap: 8 }}>
                      <Link to={`/rooms/${r.id}`} className="stack grow" style={{ textDecoration: 'none', gap: 6, minWidth: 0 }}>
                        <b>
                          {r.name}
                          {archived && (
                            <span className="chip outline tiny" style={{ marginLeft: 6 }}>
                              Archived
                            </span>
                          )}
                        </b>
                        {them && <ProgressBar value={them.completed} max={them.total} accent={user.accent} thin />}
                        {them && (
                          <span className="tiny muted">
                            {user.displayName}: {them.completed} of {them.total} topics
                          </span>
                        )}
                      </Link>
                      <Menu
                        label={`More for ${r.name}`}
                        items={[
                          {
                            label: 'Open room',
                            onClick: () => navigate(`/rooms/${r.id}`),
                          },
                          {
                            label: 'Archive room',
                            onClick: () =>
                              archive.mutate({
                                roomId: r.id,
                                status: 'archived',
                              }),
                            hidden: archived,
                          },
                          {
                            label: 'Restore room',
                            onClick: () =>
                              archive.mutate({
                                roomId: r.id,
                                status: 'active',
                              }),
                            hidden: !archived,
                          },
                          {
                            label: 'Remove from my rooms',
                            danger: true,
                            onClick: () => setLeaving(r),
                          },
                        ]}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="small muted">No rooms together yet.</p>
            )}
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Between you two</h2>
            </div>
            <ActivityFeed items={activity} meId={me.id} />
          </div>
        </div>
      </div>

      {creating && <CreateRoomModal friendId={user.id} onClose={() => setCreating(false)} onCreated={(roomId) => navigate(`/rooms/${roomId}`)} />}
      {unfriending && <UnfriendModal friend={user} rooms={allRooms ?? rooms} onClose={() => setUnfriending(false)} onDone={() => navigate('/friends')} />}
      {leaving && <LeaveRoomModal room={leaving} meId={me.id} onClose={() => setLeaving(null)} />}
    </div>
  );
}
