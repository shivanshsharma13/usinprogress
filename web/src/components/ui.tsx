import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LiveStatus, PublicUser } from '@shared/types';
import { focusedMs, formatClock, formatDuration } from '@shared/timer';
import { Buddy } from './Buddy';
import { TwoSprouts } from './Plant';
import { XIcon, MoreIcon } from './icons';
import { personVars } from '../lib/theme';
import { serverNow } from '../lib/api';
import { dismiss, useToasts } from '../lib/toast';

/** Re-renders every `ms` so timers tick. Time itself always comes from saved timestamps. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <div className="spin" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="banner error row between" role="alert">
      <span>{(error as Error)?.message ?? 'Something went wrong.'}</span>
      {retry && (
        <button className="btn small" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Avatar({ user, size = 40 }: { user: Pick<PublicUser, 'accent' | 'avatar' | 'displayName'>; size?: number }) {
  return (
    <span className="avatar" style={{ ...personVars(user.accent), width: size, height: size }}>
      <Buddy accent={user.accent} avatar={user.avatar} size={size * 0.92} title={user.displayName} />
    </span>
  );
}

export function PersonChip({ user, label }: { user: Pick<PublicUser, 'accent' | 'displayName'>; label?: ReactNode }) {
  return (
    <span className="chip c" style={personVars(user.accent)}>
      {label ?? user.displayName}
    </span>
  );
}

export function ProgressBar({ value, max, accent, thin, label }: { value: number; max: number; accent?: string; thin?: boolean; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      className={`bar${thin ? ' thin' : ''}`}
      style={accent ? personVars(accent) : undefined}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ title, children, action, art }: { title: string; children?: ReactNode; action?: ReactNode; art?: ReactNode }) {
  return (
    <div className="empty">
      {art ?? <TwoSprouts />}
      <h3>{title}</h3>
      {children && <p className="muted small" style={{ maxWidth: 380 }}>{children}</p>}
      {action}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.modal-close)');
    first?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={wide ? { width: 'min(720px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon modal-close" onClick={onClose} aria-label="Close">
            <XIcon />
          </button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, error, children, full }: { label: string; hint?: string; error?: string | null; children: ReactNode; full?: boolean }) {
  return (
    <div className={`field${full ? ' full' : ''}`}>
      <label>
        <span className="label">{label}</span>
      </label>
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="check">
      <span className="switch">
        <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
      {label}
    </label>
  );
}

export function Menu({ items, label = 'More actions' }: { items: { label: string; onClick: () => void; danger?: boolean; hidden?: boolean }[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="btn ghost icon small" aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreIcon />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items
            .filter((i) => !i.hidden)
            .map((i) => (
              <button
                key={i.label}
                role="menuitem"
                className={i.danger ? 'danger' : ''}
                onClick={() => {
                  setOpen(false);
                  i.onClick();
                }}
              >
                {i.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className="grow">{t.text}</span>
          <button className="btn ghost icon small" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <XIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

/** "Studying Biochemistry · 00:32:18" — a friend's live status in plain words. */
export function StatusLine({ status, name }: { status: LiveStatus; name: string }) {
  const now = useNow();
  if (status.state === 'hidden') return <span className="muted">{name} keeps their status private</span>;
  if (status.state === 'idle') return <span className="muted">{name} isn't studying right now</span>;
  const elapsed = status.startedAt ? focusedMs({ startedAt: status.startedAt, endedAt: null, pauses: status.pauses ?? [] }, now) : 0;
  const what = status.topicTitle ? <b>{status.topicTitle}</b> : 'something';
  return (
    <span>
      {name} {status.state === 'paused' ? 'paused' : 'is studying'} {what}
      <span className="muted num"> · {status.state === 'paused' ? 'on a break' : formatClock(elapsed)}</span>
    </span>
  );
}

export function LiveDot({ status, accent }: { status: LiveStatus; accent: string }) {
  const live = status.state === 'studying';
  return <span className={`dot${live ? ' live' : ''}`} style={{ ...personVars(accent), opacity: status.state === 'idle' || status.state === 'hidden' ? 0.35 : 1 }} aria-hidden="true" />;
}

export const fmt = formatDuration;

export function relativeTime(ms: number, now = Date.now()) {
  const diff = Math.round((now - ms) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
