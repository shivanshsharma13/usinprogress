import { Link, useNavigate } from 'react-router';
import { formatDate } from '@shared/dates';
import { focusedMs, formatClock } from '@shared/timer';
import { useHome } from '../lib/queries';
import { personVars } from '../lib/theme';
import { Avatar, Empty, ErrorNote, fmt, LiveDot, ProgressBar, Spinner, StatusLine, useNow } from '../components/ui';
import { EncourageButtons } from '../components/Encourage';
import { PlanLine } from '../components/PlanBits';
import { Buddy } from '../components/Buddy';
import { Plant } from '../components/Plant';
import { RevisionsDue } from '../components/Revisions';
import { StreaksAndRecap } from '../components/Streaks';
import { DaySplitCard } from '../components/DaySplit';
import { PhotoWall } from '../components/PhotoCheers';
import { ChallengeCard } from '../components/Challenge';
import { PlayIcon } from '../components/icons';

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

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorNote error={error} retry={refetch} />;
  const { me, activeSession, primary, friends, today, plans, rooms, comingUp } = data;
  const studyLink = (t: { topicId: string | null; subtopicId?: string }) => `/study?topic=${t.topicId}${t.subtopicId ? `&sub=${t.subtopicId}` : ''}`;
  const friend = friends[0];
  const nothingYet = !rooms.length && !comingUp.length && !primary;

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

      <PhotoWall meId={me.id} />
      <DaySplitCard me={me} friend={friend?.user} today={me.today} />
      <StreaksAndRecap me={me} friends={friends.map((f) => f.user)} today={me.today} />

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
                  {primary.item.subtopicId && <span className="small muted">{primary.item.title} ›</span>}
                  <h2>{primary.item.subtopicTitle ?? primary.item.title}</h2>
                  <p className="muted small">
                    Planned for today · {primary.item.planTitle}
                    {primary.item.estMinutes ? ` · ~${primary.item.estMinutes}m` : ''}
                  </p>
                  <button className="btn primary big" onClick={() => navigate(studyLink(primary.item))}>
                    <PlayIcon /> Start studying
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="card">
              <Empty
                title="Let's start small."
                action={
                  <Link className="btn primary big" to={friend ? (rooms.length ? '/goals' : '/rooms?new=1') : '/friends'}>
                    {friend ? (rooms.length ? 'Plan today in your goals' : 'Create a room together') : 'Find your friend'}
                  </Link>
                }
              >
                {friend
                  ? nothingYet
                    ? rooms.length ? `Add topics and subtopics to a goal, give them a day, then press start. We'll keep track of the rest.` : `Create a room with ${friend.user.displayName}, add a task, and press start. We'll keep track of the rest.`
                    : 'Everything is done for now. Plan another subtopic for today, or one for tomorrow.'
                  : 'Us in Progress is better together. Find your friend by their username to begin.'}
              </Empty>
            </div>
          )}

          <RevisionsDue />
          <ChallengeCard me={me} friend={friend?.user} today={me.today} />

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
                <div className="num bold" style={{ fontSize: '1.6rem' }}>{today.partsDone}</div>
                <div className="small muted">subtopics done</div>
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
                  No goals yet. <Link to="/goals?new=1">Make one</Link> — a list of tasks, like a subject. Its tasks show up in your room.
                </p>
              </div>
            )}
          </div>

          {/* 9. Upcoming */}
          <div className="card">
            <div className="card-head">
              <h2>Coming up</h2>
              <Link to="/goals" className="small muted">
                Goals
              </Link>
            </div>
            {comingUp.length ? (
              <div className="list">
                {comingUp.map((t) => (
                  <div key={t.id} className="list-item">
                    <span className="dot ring" style={personVars(me.accent)} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      {t.subtopicId && <div className="tiny muted">{t.title} ›</div>}
                      <div className="bold small">{t.subtopicTitle ?? t.title}</div>
                      <div className="tiny muted">
                        {t.date === me.today ? 'Today' : formatDate(t.date!, { weekday: 'short', month: 'short', day: 'numeric' })} · {t.planTitle}
                        {t.estMinutes ? ` · ~${t.estMinutes}m` : ''}
                      </div>
                    </div>
                    {t.date === me.today && (
                      <button className="btn small" onClick={() => navigate(studyLink(t))} aria-label={`Study ${t.subtopicTitle ?? t.title}`}>
                        <PlayIcon />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="small muted">
                Nothing planned. Open a <Link to="/goals">goal</Link>, add subtopics to a topic and give them a day.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
