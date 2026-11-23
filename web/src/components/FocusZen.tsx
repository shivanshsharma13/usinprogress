// Full-screen focus (Settings → Motivation & focus): the timer fills the screen with only what you're working on
// above it, for when the phone or laptop sits to one side while you work. The controls stay hidden until the
// cursor reaches the top or bottom edge (a tap shows them on a phone). The screen is kept awake while it's open.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePref } from '../lib/prefs';
import { CheckIcon, CollapseIcon, PauseIcon, PlayIcon, StopIcon } from './icons';

export const useFullFocusOn = () => usePref('fullFocus')[0];

const SHOW_MS = 4000;

export function FocusZen({
  title,
  subtitle,
  face,
  sub,
  paused,
  busy,
  onTogglePause,
  onFinish,
  onComplete,
  onExit,
  style,
}: {
  title: string;
  subtitle?: string | null;
  face: string;
  sub: string;
  paused: boolean;
  busy: boolean;
  onTogglePause: () => void;
  onFinish: () => void;
  onComplete: () => void;
  onExit: () => void;
  style?: React.CSSProperties;
}) {
  const [show, setShow] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const rootRef = useRef<HTMLDivElement>(null);
  const exit = useRef(onExit);
  exit.current = onExit;

  // Real full screen where the browser allows it (not on iPhone); the view covers the page either way.
  // Leaving full screen with the browser's own Esc closes the view too.
  useEffect(() => {
    rootRef.current?.focus(); // so Space pauses right away, not presses the button that opened this
    const root = document.documentElement;
    let entered = false;
    if (root.requestFullscreen && !document.fullscreenElement)
      root
        .requestFullscreen({ navigationUI: 'hide' })
        .then(() => (entered = true))
        .catch(() => {});
    const onChange = () => entered && !document.fullscreenElement && exit.current();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && exit.current();
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      entered = false;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Keep the screen on while it sits to the side.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const take = () => {
      if (document.visibilityState === 'visible' && 'wakeLock' in navigator)
        navigator.wakeLock
          .request('screen')
          .then((l) => (lock = l))
          .catch(() => {});
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      document.removeEventListener('visibilitychange', take);
      void lock?.release().catch(() => {});
    };
  }, []);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // On touch screens there's no cursor: a tap (or click) on the empty space shows the controls for a few seconds.
  const reveal = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('zen-main')) return;
    setShow(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShow(false), SHOW_MS);
  };

  return createPortal(
    <div className={`zen${paused ? ' is-paused' : ''}${show ? ' show' : ''}`} role="dialog" aria-modal="true" aria-label="Full-screen focus" tabIndex={-1} ref={rootRef} style={style} onPointerUp={reveal}>
      <div className="zen-bar zen-top">
        <span className="chip c">{paused ? 'Paused' : 'Focusing'}</span>
        <button className="btn ghost small" onClick={onExit}>
          <CollapseIcon width={16} /> Exit full screen
        </button>
      </div>

      <div className="zen-main">
        <h1 className="zen-title">{title}</h1>
        {subtitle && <p className="zen-subtitle muted">› {subtitle}</p>}
        <button className="zen-clock" onClick={onTogglePause} disabled={busy} aria-label={paused ? 'Resume timer' : 'Pause timer'}>
          <span className={`timer-face${face.length > 6 ? ' long' : ''}`} role="timer" aria-live="off">
            {face}
          </span>
        </button>
        <span className="zen-sub muted num">{paused ? 'Paused · tap the clock or press Space to resume' : sub}</span>
      </div>

      <div className="zen-bar zen-bottom">
        <button className={`btn ${paused ? 'primary' : ''}`} disabled={busy} onClick={onTogglePause}>
          {paused ? <PlayIcon /> : <PauseIcon />} {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="btn" disabled={busy} onClick={onFinish}>
          <StopIcon /> Finish
        </button>
        <button className="btn leaf" disabled={busy} onClick={onComplete}>
          <CheckIcon /> Complete
        </button>
      </div>
    </div>,
    document.body,
  );
}
