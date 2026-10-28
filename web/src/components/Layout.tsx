import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Me } from '@shared/types';
import { focusedMs, formatClock, ONE_HOUR_MS } from '@shared/timer';
import { useActiveSession, useActivity, useAction } from '../lib/queries';
import { api } from '../lib/api';
import { useRealtime, type ConnectionState } from '../lib/realtime';
import { toast } from '../lib/toast';
import { applyScheme } from '../lib/theme';
import { Avatar, useNow } from './ui';
import { CalendarIcon, ChartIcon, FriendsIcon, GoalIcon, HomeIcon, MoonIcon, PauseIcon, PlayIcon, RoomIcon, SunIcon } from './icons';

const NAV = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/goals', label: 'Goals', icon: GoalIcon },
  { to: '/calendar', label: 'Calendar', icon: CalendarIcon },
  { to: '/rooms', label: 'Rooms', icon: RoomIcon },
  { to: '/friends', label: 'Friends', icon: FriendsIcon },
];

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const conn = useRealtime(qc, true);
  const { data: activity } = useActivity();
  const unread = activity?.unread ?? 0;
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <Link to="/" className="brand" style={{ textDecoration: 'none' }}>
          <img src="/favicon.svg" width={30} height={30} alt="" />
          <span>Us in Progress</span>
        </Link>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">
            <n.icon />
            <span className="label">{n.label}</span>
            {n.to === '/friends' && unread > 0 && <span className="chip label" style={{ marginLeft: 'auto' }}>{unread}</span>}
          </NavLink>
        ))}
        <NavLink to="/progress" className="nav-link">
          <ChartIcon />
          <span className="label">Progress</span>
        </NavLink>
        <div className="sidebar-foot">
          <ConnectionBadge state={conn} />
          <ThemeToggle me={me} />
          <NavLink to="/settings" className="nav-link">
            <Avatar user={me} size={26} />
            <span className="label">{me.displayName}</span>
          </NavLink>
        </div>
      </aside>

      <div className="grow" style={{ minWidth: 0 }}>
        <header className="topbar">
          <Link to="/" className="row" style={{ textDecoration: 'none', fontWeight: 800 }}>
            <img src="/favicon.svg" width={26} height={26} alt="" />
            Us in Progress
          </Link>
          <div className="row" style={{ gap: 4 }}>
            <ConnectionBadge state={conn} compact />
            <Link to="/progress" className="btn ghost icon" aria-label="Progress">
              <ChartIcon />
            </Link>
            <ThemeToggle me={me} compact />
            <Link to="/settings" className="btn ghost icon" aria-label="Profile and settings">
              <Avatar user={me} size={30} />
            </Link>
          </div>
        </header>
        <main className="main">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="Main navigation">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <n.icon />
            {n.label}
          </NavLink>
        ))}
      </nav>

      <SessionWatcher hideMini={pathname === '/study'} />
    </div>
  );
}

function ConnectionBadge({ state, compact }: { state: ConnectionState; compact?: boolean }) {
  if (state === 'online') return compact ? null : <span className="conn" style={{ padding: '0 12px' }}><span className="dot" />{<span className="label">Live</span>}</span>;
  return (
    <span className="conn" role="status" style={{ padding: compact ? 0 : '0 12px' }} title="Reconnecting… your timer keeps counting on the server.">
      <span className="dot" style={{ background: state === 'offline' ? 'var(--danger)' : 'var(--lavender)' }} />
      <span className={compact ? '' : 'label'}>{state === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>
    </span>
  );
}

function ThemeToggle({ me, compact }: { me: Me; compact?: boolean }) {
  const qc = useQueryClient();
  const dark = me.colorScheme === 'dark';
  const save = useAction((scheme: 'light' | 'dark') => api.patch<{ me: Me }>('/me', { colorScheme: scheme }), {
    invalidate: [['me']],
    onError: () => {
      applyScheme(me.colorScheme);
      return false;
    },
  });
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    applyScheme(next); // instant; the server copy makes it follow the person to other devices
    qc.setQueryData<any>(['me'], { ...me, colorScheme: next });
    save.mutate(next);
  };
  const Icon = dark ? SunIcon : MoonIcon;
  if (compact)
    return (
      <button className="btn ghost icon" onClick={toggle} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
        <Icon />
      </button>
    );
  return (
    <button className="nav-link" style={{ border: 'none', background: 'transparent', cursor: 'pointer', width: '100%' }} onClick={toggle}>
      <Icon />
      <span className="label">{dark ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}

const REMINDED_KEY = 'uip-reminded';

/** Floating mini timer + the optional one-hour reminder, visible on every page. */
function SessionWatcher({ hideMini }: { hideMini: boolean }) {
  const { data: session } = useActiveSession();
  const now = useNow();
  const elapsed = session ? focusedMs({ startedAt: session.startedAt, endedAt: null, pauses: session.pauses }, now) : 0;

  useEffect(() => {
    if (!session?.remindAfterHour || elapsed < ONE_HOUR_MS) return;
    let reminded: string | null = null;
    try {
      reminded = localStorage.getItem(REMINDED_KEY);
    } catch {}
    if (reminded === session.id) return;
    try {
      localStorage.setItem(REMINDED_KEY, session.id);
    } catch {}
    const text = `🌿 You've focused for an hour on “${session.topicTitle}”. Maybe stretch and drink some water?`;
    toast(text, 'notice', 15_000);
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      new Notification('Us in Progress', { body: text, icon: '/favicon.svg' });
    }
  }, [session?.id, session?.remindAfterHour, elapsed >= ONE_HOUR_MS]);

  if (!session || hideMini) return null;
  return (
    <Link to="/study" className="mini-timer" aria-label="Open the timer">
      <span className="dot live" style={{ ['--c' as any]: 'var(--me)', opacity: session.state === 'paused' ? 0.4 : 1 }} />
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="small muted" style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>
          {session.state === 'paused' ? 'Paused · ' : ''}
          {session.topicTitle}
        </span>
        <span className="num bold" style={{ fontSize: '1.15rem' }}>
          {formatClock(elapsed)}
        </span>
      </span>
      {session.state === 'paused' ? <PlayIcon width={20} /> : <PauseIcon width={20} />}
    </Link>
  );
}
