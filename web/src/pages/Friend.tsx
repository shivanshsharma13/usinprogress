import { Link, useParams } from 'react-router';
import { useFriend, useMe } from '../lib/queries';
import { personVars } from '../lib/theme';
import { Avatar, ErrorNote, fmt, LiveDot, ProgressBar, Spinner, StatusLine, relativeTime } from '../components/ui';
import { ActivityFeed, EncourageButtons } from '../components/Encourage';
import { ChevronLeft } from '../components/icons';

export function FriendPage() {
  const { id } = useParams();
  const { data: me } = useMe();
  const { data, isLoading, error, refetch } = useFriend(id);
  if (isLoading || !me) return <Spinner />;
  if (error || !data) return <ErrorNote error={error} retry={refetch} />;
  const { user, status, recentCompletions, rooms, activity, stats } = data;

  return (
    <div className="stack-lg" style={personVars(user.accent)}>
      <Link to="/friends" className="row small muted" style={{ textDecoration: 'none' }}>
        <ChevronLeft width={18} /> Friends
      </Link>
      <div className="card tint row wrap">
        <Avatar user={user} size={72} />
        <div className="grow stack" style={{ gap: 4 }}>
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
                  return (
                    <Link key={r.id} to={`/rooms/${r.id}`} className="stack" style={{ textDecoration: 'none', gap: 6 }}>
                      <b>{r.name}</b>
                      {them && <ProgressBar value={them.completed} max={them.total} accent={user.accent} thin />}
                      {them && (
                        <span className="tiny muted">
                          {user.displayName}: {them.completed} of {them.total} topics
                        </span>
                      )}
                    </Link>
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
    </div>
  );
}
