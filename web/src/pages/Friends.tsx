import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Friend, FriendRequest, PublicUser, RoomSummary } from '@shared/types';
import { formatDate } from '@shared/dates';
import { useAction, useActivity, useFriends, useMe, useRooms, useUserSearch } from '../lib/queries';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { personVars } from '../lib/theme';
import { Avatar, Empty, ErrorNote, fmt, LiveDot, Menu, Spinner, StatusLine, relativeTime } from '../components/ui';
import { ActivityFeed, EncourageButtons } from '../components/Encourage';
import { UnfriendModal } from '../components/Social';
import { SearchIcon } from '../components/icons';
import { CreateRoomModal } from './Rooms';

type Tab = 'friends' | 'requests' | 'find' | 'activity';

const PROFILE_LABEL: Record<PublicUser['profileType'], string> = {
  engineer: 'Engineer',
  doctor: 'Doctor',
  custom: 'Custom',
};
const monthYear = (ms: number) =>
  formatDate(new Date(ms).toISOString().slice(0, 10), {
    month: 'short',
    year: 'numeric',
  });

export function FriendsPage() {
  const { data: me } = useMe();
  const { data, isLoading, error, refetch } = useFriends();
  const { data: rooms } = useRooms();
  const { data: activity } = useActivity();
  const [params, setParams] = useSearchParams();
  const welcome = params.get('welcome') === '1';
  const [roomWith, setRoomWith] = useState<string | null>(null);
  const [unfriending, setUnfriending] = useState<PublicUser | null>(null);
  const navigate = useNavigate();

  const markRead = useAction(() => api.post('/activity/read'), {
    invalidate: [['activity']],
  });
  const tabParam = params.get('tab') as Tab | null;
  useEffect(() => {
    if (tabParam === 'activity' && activity?.unread) markRead.mutate(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam, activity?.unread]);

  if (isLoading || !me) return <Spinner />;
  if (error || !data) return <ErrorNote error={error} retry={refetch} />;
  const incoming = data.requests.filter((r) => r.direction === 'incoming');
  const outgoing = data.requests.filter((r) => r.direction === 'outgoing');
  const activeRooms = (rooms ?? []).filter((r) => r.status === 'active');
  const tab: Tab = tabParam ?? (data.friends.length ? 'friends' : incoming.length ? 'requests' : 'find');
  const setTab = (t: Tab) => setParams(t === 'friends' ? {} : { tab: t }, { replace: true });
  const sharedWith = (id: string) => activeRooms.filter((r) => r.members.some((m) => m.user.id === id));

  const tabs: { key: Tab; label: string; count?: number; dot?: boolean }[] = [
    { key: 'friends', label: 'Friends', count: data.friends.length },
    {
      key: 'requests',
      label: 'Requests',
      count: incoming.length || undefined,
      dot: incoming.length > 0,
    },
    { key: 'find', label: 'Find people' },
    { key: 'activity', label: 'Activity', dot: Boolean(activity?.unread) },
  ];

  return (
    <div className="stack-lg">
      <ProfileHero me={me} friends={data.friends.length} rooms={activeRooms.length} />

      {welcome && !data.friends.length && (
        <div className="card tint stack" style={personVars(me.accent)}>
          <h2>Welcome, {me.displayName} 🌱</h2>
          <p>
            Step 1: find your friend by username and send a request. Step 2: when they accept, create a shared room together. Step 3: add a topic and press
            start.
          </p>
        </div>
      )}

      {incoming.length > 0 && tab !== 'requests' && (
        <button className="card tint row request-nudge" style={personVars(incoming[0].user.accent)} onClick={() => setTab('requests')}>
          <span className="avatar-stack">
            {incoming.slice(0, 3).map((r) => (
              <Avatar key={r.id} user={r.user} size={32} />
            ))}
          </span>
          <span className="grow small" style={{ textAlign: 'left' }}>
            <b>{incoming[0].user.displayName}</b>
            {incoming.length > 1 ? ` and ${incoming.length - 1} more want` : ' wants'} to be friends
          </span>
          <span className="btn primary small">See requests</span>
        </button>
      )}

      <div className="tabs social-tabs" role="tablist" aria-label="Friends sections">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
            {t.count !== undefined && <span className="tab-count num">{t.count}</span>}
            {t.dot && t.count === undefined && <span className="tab-dot" aria-label="new" />}
          </button>
        ))}
      </div>

      {tab === 'friends' &&
        (data.friends.length ? (
          <div className="friend-grid">
            {data.friends.map((f) => (
              <FriendCard
                key={f.user.id}
                friend={f}
                rooms={sharedWith(f.user.id)}
                onCreateRoom={() => setRoomWith(f.user.id)}
                onUnfriend={() => setUnfriending(f.user)}
              />
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty
              title="No friends yet"
              action={
                <button className="btn primary" onClick={() => setTab('find')}>
                  Find people
                </button>
              }
            >
              Search for your friend's username. When they accept, you'll be able to plan and study together.
            </Empty>
          </div>
        ))}

      {tab === 'requests' && <Requests incoming={incoming} outgoing={outgoing} />}
      {tab === 'find' && <FindPeople />}
      {tab === 'activity' && (
        <div className="card">
          <ActivityFeed items={activity?.activity ?? []} meId={me.id} empty="Reactions and little wins will show up here." />
        </div>
      )}

      {roomWith && <CreateRoomModal friendId={roomWith} onClose={() => setRoomWith(null)} onCreated={(id) => navigate(`/rooms/${id}`)} />}
      {unfriending && <UnfriendModal friend={unfriending} rooms={rooms ?? []} onClose={() => setUnfriending(null)} />}
    </div>
  );
}

function ProfileHero({ me, friends, rooms }: { me: PublicUser; friends: number; rooms: number }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`@${me.username}`);
      toast('Username copied — send it to your friend', 'success');
    } catch {
      toast(`Your username is @${me.username}`, 'notice');
    }
  };
  return (
    <div className="card social-hero" style={personVars(me.accent)}>
      <div className="social-cover" aria-hidden="true" />
      <div className="social-hero-body">
        <Avatar user={me} size={88} />
        <div className="grow stack" style={{ gap: 2, minWidth: 0 }}>
          <h1>{me.displayName}</h1>
          <div className="row wrap small muted" style={{ gap: 6 }}>
            <span>@{me.username}</span>
            <button className="btn ghost small" onClick={copy}>
              Copy
            </button>
          </div>
          {me.bio && <p className="small">{me.bio}</p>}
        </div>
        <div className="social-stats">
          <div>
            <b className="num">{friends}</b>
            <span>{friends === 1 ? 'friend' : 'friends'}</span>
          </div>
          <div>
            <b className="num">{rooms}</b>
            <span>{rooms === 1 ? 'room' : 'rooms'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FriendCard({
  friend: f,
  rooms,
  onCreateRoom,
  onUnfriend,
}: {
  friend: Friend;
  rooms: RoomSummary[];
  onCreateRoom: () => void;
  onUnfriend: () => void;
}) {
  const navigate = useNavigate();
  const profile = `/friends/${f.user.id}`;
  return (
    <article className="card friend-card" style={personVars(f.user.accent)}>
      <div className="social-cover small" aria-hidden="true" />
      <div className="friend-card-top">
        <Link to={profile} className="friend-avatar" aria-label={`${f.user.displayName}'s profile`}>
          <Avatar user={f.user} size={68} />
          <span className="friend-live">
            <LiveDot status={f.status} accent={f.user.accent} />
          </span>
        </Link>
        <Menu
          label={`More for ${f.user.displayName}`}
          items={[
            { label: 'View profile', onClick: () => navigate(profile) },
            { label: 'Create a room together', onClick: onCreateRoom },
            { label: 'Unfriend', danger: true, onClick: onUnfriend },
          ]}
        />
      </div>
      <div className="stack" style={{ gap: 2 }}>
        <Link to={profile} className="friend-name">
          <h2>{f.user.displayName}</h2>
        </Link>
        <div className="small muted">
          @{f.user.username} · <span className="chip c">{PROFILE_LABEL[f.user.profileType]}</span>
        </div>
        {f.user.bio && <p className="small friend-bio">{f.user.bio}</p>}
      </div>
      <div className="small">
        <StatusLine status={f.status} name={f.user.displayName} />
      </div>
      <div className="friend-stats">
        <div>
          <b className="num">{fmt(f.status.todayFocusedMs)}</b>
          <span>today</span>
        </div>
        <div>
          <b className="num">{rooms.length}</b>
          <span>{rooms.length === 1 ? 'room together' : 'rooms together'}</span>
        </div>
        <div>
          <b>{monthYear(f.since)}</b>
          <span>friends since</span>
        </div>
      </div>
      {f.recentCompletions.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {f.recentCompletions.slice(0, 3).map((c) => (
            <span key={c.topicId} className="chip done">
              🌼 {c.topicTitle}
            </span>
          ))}
        </div>
      )}
      <EncourageButtons recipientId={f.user.id} name={f.user.displayName} />
      <div className="row wrap">
        <Link className="btn grow" to={profile}>
          Profile
        </Link>
        <button className="btn primary grow" onClick={onCreateRoom}>
          New room
        </button>
      </div>
    </article>
  );
}

function Requests({ incoming, outgoing }: { incoming: FriendRequest[]; outgoing: FriendRequest[] }) {
  const respond = useAction(({ id, action }: { id: string; action: 'accept' | 'reject' | 'cancel' }) => api.post(`/friends/requests/${id}/${action}`), {
    invalidate: [['friends'], ['search'], ['rooms']],
    success: (_r) => undefined,
  });
  if (!incoming.length && !outgoing.length)
    return (
      <div className="card">
        <Empty title="No requests">When someone adds you, their request shows up here.</Empty>
      </div>
    );
  return (
    <div className="stack-lg">
      {incoming.length > 0 && (
        <div className="card stack">
          <h2>Want to be friends</h2>
          {incoming.map((r) => (
            <div key={r.id} className="row wrap" style={personVars(r.user.accent)}>
              <Avatar user={r.user} size={48} />
              <div className="grow">
                <b>{r.user.displayName}</b>
                <div className="small muted">
                  @{r.user.username} · {relativeTime(r.createdAt)}
                </div>
              </div>
              <button className="btn primary" disabled={respond.isPending} onClick={() => respond.mutate({ id: r.id, action: 'accept' })}>
                Accept
              </button>
              <button className="btn" disabled={respond.isPending} onClick={() => respond.mutate({ id: r.id, action: 'reject' })}>
                Decline
              </button>
            </div>
          ))}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="card stack">
          <h2>Sent</h2>
          {outgoing.map((r) => (
            <div key={r.id} className="row">
              <Avatar user={r.user} size={40} />
              <span className="grow small">
                <b>{r.user.displayName}</b>{' '}
                <span className="muted">
                  @{r.user.username} · {relativeTime(r.createdAt)}
                </span>
              </span>
              <button className="btn ghost small" disabled={respond.isPending} onClick={() => respond.mutate({ id: r.id, action: 'cancel' })}>
                Cancel request
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FindPeople() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const search = useUserSearch(debounced);
  const add = useAction((userId: string) => api.post<{ status: string }>('/friends/requests', { userId }), {
    invalidate: [['friends'], ['search']],
    success: (r) => (r.status === 'accepted' ? 'You are now friends 🌱' : 'Request sent 🌱'),
  });
  return (
    <div className="card stack">
      <label className="row input" style={{ padding: '0 12px' }}>
        <SearchIcon width={18} className="muted" />
        <span className="sr-only">Search by username</span>
        <input
          style={{
            border: 'none',
            outline: 'none',
            background: 'transparent',
            flex: 1,
            minHeight: 42,
          }}
          placeholder="Search by username"
          autoCapitalize="none"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {debounced.trim().length < 2 ? (
        <p className="small muted">Type at least two letters of their username.</p>
      ) : (
        <div className="list">
          {search.isLoading && <Spinner />}
          {search.data?.length === 0 && <p className="small muted">No one with that username yet.</p>}
          {search.data?.map((r) => (
            <div key={r.user.id} className="list-item" style={personVars(r.user.accent)}>
              <Avatar user={r.user} size={44} />
              <div className="grow">
                <b>{r.user.displayName}</b>
                <div className="small muted">
                  @{r.user.username} · <span className="chip c">{PROFILE_LABEL[r.user.profileType]}</span>
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
              {r.relation === 'friend' && (
                <Link className="btn small" to={`/friends/${r.user.id}`}>
                  Friends ✓
                </Link>
              )}
              {r.relation === 'self' && <span className="chip outline">You</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
