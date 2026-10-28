import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAction, useActivity, useFriends, useMe, useUserSearch } from '../lib/queries';
import { api } from '../lib/api';
import { personVars } from '../lib/theme';
import { Avatar, Empty, ErrorNote, fmt, LiveDot, Spinner, StatusLine, relativeTime } from '../components/ui';
import { ActivityFeed, EncourageButtons } from '../components/Encourage';
import { SearchIcon } from '../components/icons';
import { CreateRoomModal } from './Rooms';

export function FriendsPage() {
  const { data: me } = useMe();
  const { data, isLoading, error, refetch } = useFriends();
  const { data: activity } = useActivity();
  const [params] = useSearchParams();
  const welcome = params.get('welcome') === '1';
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [roomWith, setRoomWith] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const search = useUserSearch(debounced);

  const markRead = useAction(() => api.post('/activity/read'), { invalidate: [['activity']] });
  useEffect(() => {
    if (activity?.unread) markRead.mutate(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity?.unread]);

  const add = useAction((userId: string) => api.post<{ status: string }>('/friends/requests', { userId }), {
    invalidate: [['friends'], ['search']],
    success: (r) => (r.status === 'accepted' ? 'You are now friends 🌱' : 'Request sent 🌱'),
  });
  const respond = useAction(({ id, action }: { id: string; action: 'accept' | 'reject' | 'cancel' }) => api.post(`/friends/requests/${id}/${action}`), {
    invalidate: [['friends'], ['search'], ['rooms']],
    success: (_r) => undefined,
  });

  if (isLoading || !me) return <Spinner />;
  if (error || !data) return <ErrorNote error={error} retry={refetch} />;
  const incoming = data.requests.filter((r) => r.direction === 'incoming');
  const outgoing = data.requests.filter((r) => r.direction === 'outgoing');

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Friends</h1>
          <p className="muted">Private by default. Only people you accept can see your progress.</p>
        </div>
      </div>

      {welcome && !data.friends.length && (
        <div className="card tint stack" style={personVars(me.accent)}>
          <h2>Welcome, {me.displayName} 🌱</h2>
          <p>
            Step 1: search for your friend's username below and send a request. Step 2: when they accept, create a shared room together. Step 3: add a topic
            and press start.
          </p>
          <p className="small muted">
            Your username is <b>@{me.username}</b> — share it with them so they can find you too. You can explore the app anytime; nothing is required.
          </p>
        </div>
      )}

      {incoming.length > 0 && (
        <div className="card stack">
          <h2>Friend requests</h2>
          {incoming.map((r) => (
            <div key={r.id} className="row wrap">
              <Avatar user={r.user} size={44} />
              <div className="grow">
                <b>{r.user.displayName}</b>
                <div className="small muted">@{r.user.username} · {relativeTime(r.createdAt)}</div>
              </div>
              <button className="btn primary" disabled={respond.isPending} onClick={() => respond.mutate({ id: r.id, action: 'accept' })}>
                Accept
              </button>
              <button className="btn" disabled={respond.isPending} onClick={() => respond.mutate({ id: r.id, action: 'reject' })}>
                Not now
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="stack-lg">
          {data.friends.length ? (
            data.friends.map((f) => (
              <div key={f.user.id} className="card stack" style={personVars(f.user.accent)}>
                <div className="row">
                  <Avatar user={f.user} size={52} />
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <h2>{f.user.displayName}</h2>
                      <LiveDot status={f.status} accent={f.user.accent} />
                    </div>
                    <div className="small muted">
                      @{f.user.username} · <span className="chip c">{f.user.profileType === 'custom' ? 'Custom' : f.user.profileType === 'doctor' ? 'Doctor' : 'Engineer'}</span>
                    </div>
                  </div>
                </div>
                <div className="small">
                  <StatusLine status={f.status} name={f.user.displayName} />
                </div>
                <div className="small muted">{fmt(f.status.todayFocusedMs)} focused today</div>
                {f.recentCompletions.length > 0 && (
                  <div className="row wrap">
                    {f.recentCompletions.slice(0, 3).map((c) => (
                      <span key={c.topicId} className="chip done">
                        🌼 {c.topicTitle}
                      </span>
                    ))}
                  </div>
                )}
                <EncourageButtons recipientId={f.user.id} name={f.user.displayName} />
                <div className="row wrap">
                  <Link className="btn" to={`/friends/${f.user.id}`}>
                    Open profile
                  </Link>
                  <button className="btn primary" onClick={() => setRoomWith(f.user.id)}>
                    Create a room together
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="card">
              <Empty title="No friends yet">Search for your friend's username. When they accept, you'll be able to plan and study together.</Empty>
            </div>
          )}
        </div>

        <div className="stack-lg">
          <div className="card stack">
            <h2>Find a friend</h2>
            <label className="row input" style={{ padding: '0 12px' }}>
              <SearchIcon width={18} className="muted" />
              <span className="sr-only">Search by username</span>
              <input
                style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, minHeight: 42 }}
                placeholder="Search by username"
                autoCapitalize="none"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            {debounced.trim().length >= 2 && (
              <div className="list">
                {search.isLoading && <Spinner />}
                {search.data?.length === 0 && <p className="small muted">No one with that username yet.</p>}
                {search.data?.map((r) => (
                  <div key={r.user.id} className="list-item">
                    <Avatar user={r.user} size={40} />
                    <div className="grow">
                      <b>{r.user.displayName}</b>
                      <div className="small muted">
                        @{r.user.username} · <span className="chip c" style={personVars(r.user.accent)}>{r.user.profileType}</span>
                      </div>
                    </div>
                    {r.relation === 'none' && (
                      <button className="btn primary small" disabled={add.isPending} onClick={() => add.mutate(r.user.id)}>
                        Add friend
                      </button>
                    )}
                    {r.relation === 'pending_outgoing' && <span className="chip outline">Requested</span>}
                    {r.relation === 'pending_incoming' && (
                      <button className="btn primary small" onClick={() => add.mutate(r.user.id)}>
                        Accept
                      </button>
                    )}
                    {r.relation === 'friend' && <span className="chip done">Friends</span>}
                    {r.relation === 'self' && <span className="chip outline">You</span>}
                  </div>
                ))}
              </div>
            )}
            {outgoing.length > 0 && (
              <>
                <div className="divider" />
                <span className="section-label">Waiting for a reply</span>
                {outgoing.map((r) => (
                  <div key={r.id} className="row">
                    <Avatar user={r.user} size={32} />
                    <span className="grow small">
                      <b>{r.user.displayName}</b> <span className="muted">@{r.user.username}</span>
                    </span>
                    <button className="btn ghost small" onClick={() => respond.mutate({ id: r.id, action: 'cancel' })}>
                      Cancel
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Encouragement</h2>
            </div>
            <ActivityFeed items={activity?.activity ?? []} meId={me.id} empty="Reactions and little wins will show up here." />
          </div>
        </div>
      </div>

      {roomWith && <CreateRoomModal friendId={roomWith} onClose={() => setRoomWith(null)} onCreated={(id) => navigate(`/rooms/${id}`)} />}
    </div>
  );
}
