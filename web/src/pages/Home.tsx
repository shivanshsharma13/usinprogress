import { Link, useNavigate } from 'react-router';
import { formatDate } from '@shared/dates';
import { focusedMs, formatClock } from '@shared/timer';
import { useAction, useHome } from '../lib/queries';
import { api } from '../lib/api';
import { personVars } from '../lib/theme';
import { Avatar, Empty, ErrorNote, fmt, LiveDot, ProgressBar, Spinner, StatusLine, useNow } from '../components/ui';
import { EncourageButtons } from '../components/Encourage';
import { PlanLine } from '../components/PlanBits';
import { Buddy } from '../components/Buddy';
import { Plant } from '../components/Plant';
import { CheckIcon, PlayIcon } from '../components/icons';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function HomePage() {
  const { data, isLoading, error, refetch } = useHome();
  const navigate = useNavigate();
  const now = useNow();
  const completeTask = useAction((id: string) => api.patch(`/tasks/${id}`, { completed: true }), { invalidate: [['tasks'], ['plan'], ['plans']], success: 'Nice work — marked as done 🌼' });

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorNote error={error} retry={refetch} />;
  const { me, activeSession, primary, friends, today, plans, rooms, upcoming } = data;
  const friend = friends[0];
  const nothingYet = !rooms.length && !upcoming.length && !primary;

  return (
    <div className="stack-lg">
      {/* 1. Greeting */}
      <div className="hero-greet">
        <Buddy accent={me.accent} avatar={me.avatar} size={56} />
        <div>
          <h1>
            {greeting()}, {me.displayName}
          </h1>
          <p className="muted">{formatDate(me.today, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        </div>
      </div>

      <div className="home-grid">
        <div className="stack-lg">
          {/* 2–4. Primary task, Start Studying, active timer */}
          {activeSession ? (
            <div className="card primary-card stack">
              <span className="section-label">{activeSession.state === 'paused' ? 'Paused' : 'You are studying'}</span>
              <h2>{activeSession.topicTitle}</h2>
              <p className="muted small">{activeSession.roomName}</p>
              <div className="timer-face" style={{ fontSize: '3rem', textAlign: 'left' }}>
                {formatClock(focusedMs({ startedAt: activeSession.startedAt, endedAt: null, pauses: activeSession.pauses }, now))}
              </div>
              <Link to="/study" className="btn primary big">
                Open timer
              </Link>
            </div>
          ) : primary ? (
            <div className="card primary-card stack">
              <span className="section-label">Today's focus</span>
              {primary.kind === 'topic' ? (
                <>
                  <h2>{primary.topicTitle}</h2>
                  <p className="muted small">Next up in {primary.roomName}</p>
                  <button className="btn primary big" onClick={() => navigate(`/study?topic=${primary.topicId}`)}>
                    <PlayIcon /> Start studying
                  </button>
                </>
              ) : (
                <>
                  <h2>{primary.task.title}</h2>
                  <p className="muted small">
                    Planned for today{primary.task.startTime ? ` at ${primary.task.startTime}` : ''}
                    {primary.task.roomName ? ` · ${primary.task.roomName}` : ''}
                  </p>
                  <div className="row wrap">
                    {primary.task.topicId ? (
                      <button className="btn primary big grow" onClick={() => navigate(`/study?topic=${primary.task.topicId}&task=${primary.task.id}`)}>
                        <PlayIcon /> Start studying
                      </button>
                    ) : (
                      <button className="btn primary big grow" onClick={() => completeTask.mutate(primary.task.id)} disabled={completeTask.isPending}>
                        <CheckIcon /> Mark as done
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="card">
              <Empty
                title="Let's start small."
                action={
                  <Link className="btn primary big" to={friend ? (rooms.length ? `/rooms/${rooms[0].id}` : '/rooms?new=1') : '/friends'}>
                    {friend ? 'Add your first topic or task' : 'Find your friend'}
                  </Link>
                }
              >
                {friend
                  ? nothingYet
                    ? `Create a room with ${friend.user.displayName}, add a topic, and press start. We'll keep track of the rest.`
                    : 'Everything is done for now. Add a new topic or plan something on the calendar.'
                  : 'Us in Progress is better together. Find your friend by their username to begin.'}
              </Empty>
            </div>
          )}

          {/* 6. Today */}
          <div className="card">
            <div className="card-head">
              <h2>Today</h2>
              <Link to="/progress" className="small muted">
                See progress
              </Link>
            </div>
            <div className="row wrap" style={{ gap: 24 }}>
              <div>
                <div className="num bold" style={{ fontSize: '1.6rem' }}>{fmt(today.focusedMs)}</div>
                <div className="small muted">focused</div>
              </div>
              <div>
                <div className="num bold" style={{ fontSize: '1.6rem' }}>{today.completedTopics.length}</div>
                <div className="small muted">topics completed</div>
              </div>
              <div>
                <div className="num bold" style={{ fontSize: '1.6rem' }}>{today.completedTasks}</div>
                <div className="small muted">tasks done</div>
              </div>
            </div>
            {today.completedTopics.length > 0 && (
              <div className="row wrap" style={{ marginTop: 12 }}>
                {today.completedTopics.map((c) => (
                  <span key={c.topicId} className="chip done">
                    🌼 {c.topicTitle}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 8. Rooms */}
          {rooms.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Shared rooms</h2>
                <Link to="/rooms" className="small muted">
                  All rooms
                </Link>
              </div>
              <div className="stack">
                {rooms.slice(0, 3).map((r) => (
                  <Link key={r.id} to={`/rooms/${r.id}`} style={{ textDecoration: 'none' }} className="stack">
                    <div className="row between">
                      <b>{r.name}</b>
                      {r.nextTopic && <span className="tiny muted">Next: {r.nextTopic.title}</span>}
                    </div>
                    {r.members.map((m) => (
                      <div key={m.user.id} className="row" style={{ gap: 8 }}>
                        <span className="small" style={{ width: 88, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.user.id === me.id ? 'You' : m.user.displayName}</span>
                        <div className="grow">
                          <ProgressBar value={m.completed} max={m.total} accent={m.user.accent} thin label={`${m.user.displayName} progress`} />
                        </div>
                        <span className="tiny muted num">
                          {m.completed}/{m.total}
                        </span>
                      </div>
                    ))}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="stack-lg">
          {/* 5. Friend */}
          {friend ? (
            <div className="card tint stack" style={personVars(friend.user.accent)}>
              <div className="row">
                <Avatar user={friend.user} size={44} />
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <b>{friend.user.displayName}</b>
                    <LiveDot status={friend.status} accent={friend.user.accent} />
                  </div>
                  <div className="small">
                    <StatusLine status={friend.status} name={friend.user.displayName} />
                  </div>
                </div>
              </div>
              <div className="small muted">{fmt(friend.status.todayFocusedMs)} focused today</div>
              <EncourageButtons recipientId={friend.user.id} name={friend.user.displayName} />
            </div>
          ) : (
            <div className="card stack">
              <h3>Find your friend</h3>
              <p className="small muted">Search for their username and send a request. Once they accept, you can create rooms together.</p>
              <Link to="/friends" className="btn primary">
                Find a friend
              </Link>
            </div>
          )}

          {/* 7. Goals */}
          <div className="card">
            <div className="card-head">
              <h2>Your goals</h2>
              <Link to="/goals" className="small muted">
                All goals
              </Link>
            </div>
            {plans.length ? (
              <div className="stack">
                {plans.map((p) => (
                  <PlanLine key={p.id} plan={p} today={me.today} accent={me.accent} />
                ))}
              </div>
            ) : (
              <div className="row">
                <Plant percent={0} size={48} />
                <p className="small muted grow">
                  No goals yet. <Link to="/goals?new=1">Make a plan</Link> — split it into sprints and days, then pull a sprint into your room.
                </p>
              </div>
            )}
          </div>

          {/* 9. Upcoming */}
          <div className="card">
            <div className="card-head">
              <h2>Coming up</h2>
              <Link to="/calendar" className="small muted">
                Calendar
              </Link>
            </div>
            {upcoming.length ? (
              <div className="list">
                {upcoming.map((t) => (
                  <div key={t.id} className="list-item">
                    <span className="dot" style={personVars(me.accent)} />
                    <div className="grow">
                      <div className="bold small">{t.title}</div>
                      <div className="tiny muted">
                        {t.date === me.today ? 'Today' : formatDate(t.date!, { weekday: 'short', month: 'short', day: 'numeric' })}
                        {t.startTime ? ` · ${t.startTime}` : ''}
                        {t.topicTitle ? ` · ${t.topicTitle}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="small muted">
                Nothing planned. <Link to="/calendar?new=1">Plan a study task</Link>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
