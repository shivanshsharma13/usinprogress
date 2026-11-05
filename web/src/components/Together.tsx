// Study together live (Settings → Motivation & focus). The nudge offers to join a friend who just started
// studying; the panel on the timer shows the shared clock and lets either of you call a break for both.
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { formatClock } from '@shared/timer';
import type { ActiveSession, Me } from '@shared/types';
import { usePref } from '../lib/prefs';
import { useAction, useActiveSession, useFriends, useTogether } from '../lib/queries';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { personVars } from '../lib/theme';
import { Avatar, useNow } from './ui';
import { XIcon } from './icons';
import { SendPhotoButton } from './PhotoCheers';

const FRESH_MS = 15 * 60_000; // "just started"
const SKIPPED = 'us-in-progress-together-skipped';

function skipped(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(SKIPPED) ?? '[]');
  } catch {
    return [];
  }
}

/** "Mira just started studying — join her?" Shown anywhere except the timer, while you're not studying. */
export function TogetherNudge() {
  const [on] = usePref('together');
  const { data } = useFriends();
  const { data: session } = useActiveSession(on);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(skipped);
  useNow(30_000); // re-check "just started" now and then

  if (!on || session || pathname.startsWith('/study')) return null;
  const f = data?.friends.find(
    (x) => x.status.state === 'studying' && x.status.startedAt && Date.now() - x.status.startedAt < FRESH_MS && !hidden.includes(`${x.user.id}:${x.status.startedAt}`),
  );
  if (!f) return null;
  const key = `${f.user.id}:${f.status.startedAt}`;
  const skip = () => {
    const next = [...hidden, key].slice(-20);
    setHidden(next);
    try {
      sessionStorage.setItem(SKIPPED, JSON.stringify(next));
    } catch {}
  };

  return (
    <div className="together-nudge" role="status" style={personVars(f.user.accent)}>
      <Avatar user={f.user} size={36} />
      <span className="grow small">
        <b>{f.user.displayName}</b> just started studying{f.status.topicTitle ? ` “${f.status.topicTitle}”` : ''}. Join {f.user.displayName}?
      </span>
      <button
        className="btn primary small"
        onClick={() => {
          skip();
          navigate(`/study?join=${f.user.id}`);
        }}
      >
        Study together
      </button>
      <button className="btn ghost icon small" onClick={skip} aria-label="Not now">
        <XIcon width={16} />
      </button>
    </div>
  );
}

/** On the timer while studying with a friend: shared clock, their topic, and a break for both. */
export function TogetherPanel({ session, me }: { session: ActiveSession; me: Me }) {
  const { data: g } = useTogether(session.togetherId);
  const { data: friends } = useFriends();
  const now = useNow(1000);
  const acted = useRef(0); // your own taps don't need a notice
  const brk = useAction(
    (on: boolean) => {
      acted.current = Date.now();
      return api.post(`/together/${g!.id}/break`, { on });
    },
    { invalidate: [['together'], ['session']] },
  );
  const partnerId = g ? (g.hostId === me.id ? g.guestId : g.hostId) : null;
  const partner = friends?.friends.find((f) => f.user.id === partnerId)?.user;
  const name = partner?.displayName ?? 'Your friend';

  // Say so when your friend calls (or ends) a break.
  const last = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!g) return;
    if (last.current !== undefined && g.breakStartedAt !== last.current && Date.now() - acted.current > 5000) {
      if (g.breakStartedAt) toast(`☕ ${name} called a break for both of you`, 'notice');
      else if (last.current) toast(`🌱 Break's over — back to it together`, 'notice');
    }
    last.current = g.breakStartedAt;
  });

  if (!g || !partnerId) return null;
  const theirs = g.people[partnerId];

  if (!g.live)
    return (
      <div className="card together-card small">
        {name} finished their session — you're studying on your own now. 🌱
      </div>
    );

  const onBreak = Boolean(g.breakStartedAt);
  const shared = now - g.startedAt - g.breakMs - (g.breakStartedAt ? now - g.breakStartedAt : 0);
  return (
    <div className={`card together-card stack${onBreak ? ' on-break' : ''}`} style={partner ? personVars(partner.accent) : undefined}>
      <div className="row between">
        <div className="row" style={{ gap: 8 }}>
          <span className="avatar-stack">
            <Avatar user={me} size={34} />
            {partner && <Avatar user={partner} size={34} />}
          </span>
          <div>
            <b className="small">Studying together with {name}</b>
            <div className="tiny muted">
              {theirs?.state === 'paused' ? `${name} is paused` : `${name} is focusing`}
              {theirs?.topicTitle ? ` · ${theirs.topicTitle}` : ''}
            </div>
          </div>
        </div>
        <div className="together-clock num" aria-label="Time together">
          {formatClock(Math.max(0, shared))}
        </div>
      </div>
      {onBreak ? (
        <div className="row between wrap">
          <span className="small">
            ☕ Break for both · {g.breakBy === me.id ? 'you called it' : `${name} called it`} · <span className="num">{formatClock(now - g.breakStartedAt!)}</span>
          </span>
          <button className="btn primary small" disabled={brk.isPending} onClick={() => brk.mutate(false)}>
            Back to studying
          </button>
        </div>
      ) : (
        <div className="row wrap">
          <button className="btn small" disabled={brk.isPending} onClick={() => brk.mutate(true)}>
            ☕ Break for both
          </button>
          <SendPhotoButton to={partner ?? { id: partnerId, displayName: name }} className="btn small" label={`📸 Photo for ${name}`} />
        </div>
      )}
    </div>
  );
}
