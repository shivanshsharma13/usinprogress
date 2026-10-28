// Timer math shared by the server (source of truth) and the client (display).
// Elapsed time is always derived from saved timestamps — never from a running counter.

export interface PauseInterval {
  pausedAt: number;
  resumedAt: number | null;
}

export interface TimedSession {
  startedAt: number;
  endedAt: number | null;
  pauses: PauseInterval[];
}

export const ONE_HOUR_MS = 60 * 60 * 1000;
/** Sessions longer than this must be confirmed or corrected before they count. */
export const LONG_SESSION_MS = 4 * ONE_HOUR_MS;

/** Focused milliseconds: wall time between start and end minus every paused interval. */
export function focusedMs(session: TimedSession, now: number): number {
  const end = session.endedAt ?? now;
  let paused = 0;
  for (const p of session.pauses) {
    const from = Math.max(p.pausedAt, session.startedAt);
    const to = Math.min(p.resumedAt ?? end, end);
    if (to > from) paused += to - from;
  }
  return Math.max(0, end - session.startedAt - paused);
}

export function isPaused(session: TimedSession): boolean {
  return session.pauses.some((p) => p.resumedAt === null);
}

/** 00:32:18 style clock. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 45:00 style countdown, or "+03:12" once the target has passed. */
export function formatCountdown(ms: number, targetMinutes: number): string {
  const remaining = targetMinutes * 60_000 - ms;
  const abs = Math.abs(Math.floor(remaining / 1000));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${remaining < 0 ? '+' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** "2h 35m", "45m", "0m". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes === 0 && ms > 0) return '<1m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return '';
  return formatDuration(minutes * 60_000);
}
