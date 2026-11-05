// The interactive study timer. Every button writes a timestamp to the server; the clock shown
// here is always recomputed from those saved timestamps, so refreshes and tab switches never lose time.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { focusedMs, formatClock, formatCountdown, formatMinutes } from '@shared/timer';
import type { ActiveSession, RoomDetail, SessionRecord, Topic } from '@shared/types';
import { useAction, useActiveSession, useFriends, useMe, useRoom, useRooms } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/toast';
import { personVars } from '../lib/theme';
import { Empty, ErrorNote, Field, fmt, Modal, Spinner, Switch, useNow } from '../components/ui';
import { Plant } from '../components/Plant';
import { CheckIcon, ChevronLeft, NextIcon, PauseIcon, PlayIcon, StopIcon, XIcon } from '../components/icons';
import { TogetherPanel } from '../components/Together';
import { TodayPlant } from '../components/Garden';
import { celebrate, plantGrowth } from '../lib/celebrate';
import { usePref } from '../lib/prefs';

interface FinishResult {
  session: SessionRecord | null;
  completedTopic: boolean;
  nextTopic: { id: string; title: string } | null;
  roomId: string;
}

type Outcome = { kind: 'completed' | 'finished'; topicTitle: string; focusedMs: number | null; result: FinishResult; plant?: { percent: number; caption: string } };

export function StudyPage() {
  const [params, setParams] = useSearchParams();
  const topicParam = params.get('topic');
  const taskParam = params.get('task');
  const { data: session, isLoading } = useActiveSession();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (isLoading) return <Spinner />;

  if (session) {
    return (
      <ActiveTimer
        session={session}
        requestedTopic={topicParam && topicParam !== session.topicId ? topicParam : null}
        onOutcome={(o) => {
          setOutcome(o);
          setParams(o.result.nextTopic && o.kind === 'completed' ? { topic: o.result.nextTopic.id } : { topic: session.topicId }, { replace: true });
        }}
      />
    );
  }
  return <StartScreen topicId={topicParam} taskId={taskParam} outcome={outcome} clearOutcome={() => setOutcome(null)} />;
}

// ───────────── Running / paused ─────────────

function ActiveTimer({ session, requestedTopic, onOutcome }: { session: ActiveSession; requestedTopic: string | null; onOutcome: (o: Outcome) => void }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  useRoom(session.roomId); // the room plant, for the celebration when you complete the topic
  const now = useNow(250);
  const elapsed = focusedMs({ startedAt: session.startedAt, endedAt: null, pauses: session.pauses }, now);
  const [note, setNote] = useState('');
  const [longSession, setLongSession] = useState<{ measuredMs: number; completeTopic: boolean } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const target = session.targetMinutes;
  const paused = session.state === 'paused';

  const inv = [['session'], ['room', session.roomId], ['rooms'], ['plan'], ['plans'], ['progress'], ['sessions'], ['tasks']];
  const setSession = (s: ActiveSession) => qc.setQueryData<any>(['session'], s);

  const pause = useAction(() => api.post<{ session: ActiveSession }>(`/sessions/${session.id}/${paused ? 'resume' : 'pause'}`), {
    invalidate: [['session']],
    onSuccess: (r) => setSession(r.session),
  });

  const finish = useAction(
    ({ parts, ...body }: { completeTopic?: boolean; confirmLong?: boolean; correctedMinutes?: number; parts?: SplitPart[] }) =>
      parts
        ? api.post<FinishResult>(`/sessions/${session.id}/split`, { parts, completeTopic: body.completeTopic, note: note || undefined })
        : api.post<FinishResult>(`/sessions/${session.id}/finish`, { ...body, note: note || undefined }),
    {
      invalidate: inv,
      onSuccess: (r, body) => {
        setLongSession(null);
        if (body.parts && body.parts.length > 1) toast(`Saved as ${body.parts.length} tasks 🌱`);
        qc.setQueryData<any>(['session'], null);
        const plant = body.completeTopic && me ? plantGrowth(qc.getQueryData<RoomDetail>(['room', session.roomId]), me.id, session.topicId) : undefined;
        if (plant && r.completedTopic) celebrate({ topicTitle: session.topicTitle, roomName: session.roomName, accent: me!.accent, ...plant });
        onOutcome({
          kind: body.completeTopic ? 'completed' : 'finished',
          topicTitle: session.topicTitle,
          focusedMs: r.session?.focusedMs ?? null,
          result: r,
          plant: plant && { percent: plant.after, caption: plant.caption },
        });
      },
      onError: (e: ApiError, body) => {
        if (e.code === 'LONG_SESSION') {
          setLongSession({ measuredMs: e.data.measuredMs, completeTopic: Boolean(body.completeTopic) });
          return true;
        }
        if (e.code === 'SESSION_ENDED') qc.invalidateQueries({ queryKey: ['session'] });
      },
    },
  );

  const discard = useAction(() => api.post(`/sessions/${session.id}/discard`), {
    invalidate: inv,
    success: 'Session discarded. It no longer counts (kept in history).',
    onSuccess: () => qc.setQueryData<any>(['session'], null),
  });

  const reminder = useAction((on: boolean) => api.patch(`/sessions/${session.id}`, { remindAfterHour: on }), {
    invalidate: [['session']],
    onSuccess: (_r, on) => qc.setQueryData<any>(['session'], { ...session, remindAfterHour: on }),
  });

  // Keep the tab title useful while studying in another tab.
  useEffect(() => {
    const prev = document.title;
    document.title = `${paused ? '⏸' : '⏱'} ${formatClock(elapsed)} · ${session.topicTitle}`;
    return () => {
      document.title = prev;
    };
  }, [Math.floor(elapsed / 1000), paused]);

  const length = useAction((minutes: number | null) => api.patch(`/sessions/${session.id}`, { targetMinutes: minutes }), {
    invalidate: [['session']],
    onSuccess: (_r, minutes) => qc.setQueryData<any>(['session'], { ...session, targetMinutes: minutes }),
  });

  const busy = pause.isPending || finish.isPending || discard.isPending;
  const togglePause = () => !busy && pause.mutate(undefined);

  // Space pauses/resumes (unless you're typing in the note).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.code !== 'Space' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      e.preventDefault();
      togglePause();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // A gentle note the moment the chosen session length is reached (once per session and length).
  const reached = Boolean(target && elapsed >= target * 60_000);
  useEffect(() => {
    if (!reached || !target) return;
    const key = `uip-reached-${session.id}-${target}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {}
    toast(`🌼 ${target} minutes done. Keep going, or finish when you're ready.`, 'notice', 8000);
  }, [reached, target, session.id]);

  const progress = target ? Math.min(1, elapsed / (target * 60_000)) : (elapsed % 3_600_000) / 3_600_000;
  const R = 44;
  const C = 2 * Math.PI * R;
  const tip = { x: 50 + R * Math.cos(2 * Math.PI * progress), y: 50 + R * Math.sin(2 * Math.PI * progress) };
  const face = target ? formatCountdown(elapsed, target) : formatClock(elapsed);
  // The little plant grows through the session (over an hour when there's no set length).
  const growth = target ? progress * 100 : Math.min(100, (elapsed / 3_600_000) * 100);

  return (
    <div className="stack-lg" style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
      <Link to={`/rooms/${session.roomId}`} className="row small muted" style={{ textDecoration: 'none' }}>
        <ChevronLeft width={18} /> {session.roomName}
      </Link>

      {requestedTopic && (
        <div className="banner" role="status">
          You're already studying “{session.topicTitle}”. Finish or complete it first, then start the next topic.
        </div>
      )}

      {session.togetherId && me && <TogetherPanel session={session} me={me} />}

      <div className={`card stack focus-card${paused ? ' is-paused' : ''}${reached ? ' is-reached' : ''}`} style={{ alignItems: 'center', textAlign: 'center', ...(me ? personVars(me.accent) : {}) }}>
        <div className="row wrap" style={{ justifyContent: 'center' }}>
          <span className="chip c">{paused ? 'Paused' : reached ? 'Target reached' : 'Focusing'}</span>
          {session.isRevision && <span className="chip outline">Revision</span>}
        </div>
        <h1 className="focus-title">{session.topicTitle}</h1>

        <div className="timer-ring">
          <span className="halo" aria-hidden="true" />
          <span className="drift-leaves" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <svg key={i} viewBox="0 0 12 12" className={`drift-leaf l${i}`}>
                <path d="M6 1C9 3 10 7 6 11 2 7 3 3 6 1Z" />
              </svg>
            ))}
          </span>
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <defs>
              <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" style={{ stopColor: 'var(--me)' }} />
                <stop offset="1" style={{ stopColor: 'var(--leaf)' }} />
              </linearGradient>
            </defs>
            <circle cx="50" cy="50" r={R} fill="none" stroke="var(--mint)" strokeWidth="4" />
            <circle className="ring-progress" cx="50" cy="50" r={R} fill="none" stroke="url(#ring-grad)" strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />
            {progress > 0.002 && <circle className="ring-tip" cx={tip.x} cy={tip.y} r="2.6" />}
          </svg>
          <button className="timer-button" onClick={togglePause} disabled={busy} aria-label={paused ? 'Resume timer' : 'Pause timer'}>
            <span className={`timer-face${face.length > 6 ? ' long' : ''}`} role="timer" aria-live="off">
              {face}
            </span>
            <span className="timer-sub muted num">
              {target ? (reached ? `${formatClock(elapsed)} focused` : `of ${target}m · ${formatClock(elapsed)}`) : 'focused this session'}
            </span>
            <span className="timer-hint">{paused ? 'Tap to resume' : 'Tap to pause'}</span>
          </button>
        </div>

        <div className="focus-plant" aria-hidden="true">
          <Plant percent={growth} size={56} color="var(--me)" />
        </div>

        <div className="length-chips" role="group" aria-label="Session length">
          {[25, 45, 60].map((m) => (
            <button key={m} className={`chip-btn${target === m ? ' on' : ''}`} disabled={length.isPending} onClick={() => length.mutate(m)}>
              {m}m
            </button>
          ))}
          <button className={`chip-btn${!target ? ' on' : ''}`} disabled={length.isPending} onClick={() => length.mutate(null)} title="Just count up">
            Open
          </button>
          {reached && target && (
            <button className="chip-btn" disabled={length.isPending} onClick={() => length.mutate(target + 5)}>
              +5 min
            </button>
          )}
        </div>

        <div className="timer-controls" style={{ width: '100%' }}>
          <button className={`btn big wide ${paused ? 'primary' : ''}`} disabled={busy} onClick={togglePause}>
            {paused ? <PlayIcon /> : <PauseIcon />} {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn big" disabled={busy} onClick={() => finish.mutate({})}>
            <StopIcon /> Finish<span className="hide-narrow">&nbsp;session</span>
          </button>
          <button className="btn big leaf" disabled={busy} onClick={() => finish.mutate({ completeTopic: true })}>
            <CheckIcon /> Complete<span className="hide-narrow">&nbsp;topic</span>
          </button>
        </div>
        <p className="tiny muted">Tap the clock or press Space to pause. “Finish session” keeps the topic open; “Complete topic” ticks it off.</p>
      </div>

      <div className="card stack">
        <ReminderToggle on={session.remindAfterHour} onChange={(v) => reminder.mutate(v)} />
        <Field label="Private note (optional)" hint="Only you can see this.">
          <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you cover?" maxLength={1000} />
        </Field>
        <button className="btn ghost small danger wrap" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirmDiscard(true)}>
          Started by accident? Discard this session
        </button>
      </div>

      {longSession && (
        <LongSessionDialog
          measuredMs={longSession.measuredMs}
          session={session}
          topics={(qc.getQueryData<RoomDetail>(['room', session.roomId])?.topics ?? []).filter((t) => t.createdBy === me?.id && t.status === 'active')}
          busy={finish.isPending}
          onCancel={() => setLongSession(null)}
          onConfirm={() => finish.mutate({ completeTopic: longSession.completeTopic, confirmLong: true })}
          onSplit={(parts) => finish.mutate({ completeTopic: longSession.completeTopic, parts })}
        />
      )}
      {confirmDiscard && (
        <Modal
          title="Discard this session?"
          onClose={() => setConfirmDiscard(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDiscard(false)}>
                Keep it
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  setConfirmDiscard(false);
                  discard.mutate(undefined);
                }}
              >
                Discard
              </button>
            </>
          }
        >
          <p>This time won't count toward anything. A record stays in your history so nothing disappears silently.</p>
        </Modal>
      )}
    </div>
  );
}

function ReminderToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  return (
    <div className="stack" style={{ gap: 4 }}>
      <Switch checked={on} onChange={onChange} label="Remind me after 1 hour" />
      {on && (
        <p className="tiny muted">
          We'll show a gentle note here after an hour of focused time (pauses don't count) while this app is open.{' '}
          {perm === 'default' && (
            <button className="btn ghost small" onClick={async () => setPerm(await Notification.requestPermission())}>
              Also allow a browser notification
            </button>
          )}
          {perm === 'granted' && 'Browser notifications are on for when this tab is in the background.'}
        </p>
      )}
    </div>
  );
}

type SplitPart = { topicId: string; minutes: number } | { title: string; minutes: number };
type SplitTask = { key: number; topicId: string | null; title: string; minutes: number };
const STEP = 15;
const roundTo = (m: number, step: number) => Math.max(0, Math.round(m / step) * step);

/**
 * Over 4 hours: count it all, or say what you actually did. Set how long you really studied, then add tasks
 * with − / + buttons; the topic you were studying gets whatever is left, so nothing needs adding up.
 */
function LongSessionDialog({
  measuredMs,
  session,
  topics,
  busy,
  onCancel,
  onConfirm,
  onSplit,
}: {
  measuredMs: number;
  session: ActiveSession;
  topics: Topic[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onSplit: (parts: SplitPart[]) => void;
}) {
  const maxMin = Math.floor(measuredMs / 60_000);
  const [total, setTotal] = useState(Math.min(maxMin, 180));
  const [tasks, setTasks] = useState<SplitTask[]>([]);
  const [picking, setPicking] = useState(false);
  const others = tasks.reduce((n, t) => n + t.minutes, 0);
  const rest = total - others;
  const over = rest < 0;

  const setMinutes = (key: number, minutes: number) => setTasks((ts) => ts.map((t) => (t.key === key ? { ...t, minutes: Math.max(0, minutes) } : t)));
  const add = (topicId: string | null, title: string) => {
    setTasks((ts) => [...ts, { key: Date.now(), topicId, title, minutes: Math.min(30, roundTo(Math.max(0, rest), 5)) }]);
    setPicking(false);
  };
  const save = () =>
    onSplit([
      { topicId: session.topicId, minutes: Math.max(0, rest) },
      ...tasks.map((t) => (t.topicId ? { topicId: t.topicId, minutes: t.minutes } : { title: t.title, minutes: t.minutes })),
    ]);
  const taken = new Set([session.topicId, ...tasks.map((t) => t.topicId)]);

  return (
    <Modal title="That was a long session" onClose={onCancel}>
      <div className="stack">
        <p>
          The timer says <b className="num">{fmt(measuredMs)}</b> of focused time. Did you really study that long, or did the timer keep running?
        </p>
        <button className="btn primary" disabled={busy} onClick={onConfirm}>
          Yes, count {fmt(measuredMs)}
        </button>
        <div className="divider" />

        <div className="split-total">
          <span className="small">
            <b>Or I actually studied</b>
          </span>
          <Stepper value={total} max={maxMin} step={STEP} onChange={setTotal} label="Time you actually studied" big />
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {[60, 120, 180, 240].filter((m) => m <= maxMin).map((m) => (
            <button key={m} className={`chip-btn${total === m ? ' on' : ''}`} onClick={() => setTotal(m)}>
              {m / 60}h
            </button>
          ))}
        </div>

        <ul className="split-list" aria-label="What you worked on">
          <li className="split-row">
            <span className="split-name">
              <b>{session.topicTitle}</b>
              <span className="tiny muted">{tasks.length ? 'gets the rest' : 'gets it all'}</span>
            </span>
            <span className={`split-rest num${over ? ' danger-text' : ''}`}>{fmt(Math.max(0, rest) * 60_000)}</span>
          </li>
          {tasks.map((t) => (
            <li key={t.key} className="split-row">
              <span className="split-name">
                <b>{t.title}</b>
                {!t.topicId && <span className="tiny muted">new task</span>}
              </span>
              <Stepper value={t.minutes} max={total} step={STEP} onChange={(m) => setMinutes(t.key, m)} label={`Time on ${t.title}`} />
              <button className="btn ghost icon small" onClick={() => setTasks((ts) => ts.filter((x) => x.key !== t.key))} aria-label={`Remove ${t.title}`}>
                <XIcon width={16} />
              </button>
            </li>
          ))}
        </ul>
        {over && (
          <p className="small danger-text" role="alert" style={{ margin: 0 }}>
            These tasks take {fmt(-rest * 60_000)} more than the {fmt(total * 60_000)} you studied.
          </p>
        )}

        {picking ? (
          <TaskPicker topics={topics.filter((t) => !taken.has(t.id))} onPick={add} onCancel={() => setPicking(false)} />
        ) : (
          tasks.length < 11 && (
            <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setPicking(true)}>
              ＋ I also worked on something else
            </button>
          )
        )}

        <button className="btn" disabled={busy || over || total === 0} onClick={save}>
          Save {fmt(total * 60_000)}
        </button>
      </div>
    </Modal>
  );
}

/** − 1h 30m + : no typing, so no keyboard and no sums. */
function Stepper({ value, max, step, onChange, label, big }: { value: number; max: number; step: number; onChange: (m: number) => void; label: string; big?: boolean }) {
  // Snap to the step grid first, so 50 → 45 / 60 rather than 35 / 65.
  const down = () => onChange(value % step ? value - (value % step) : Math.max(0, value - step));
  const up = () => onChange(Math.min(max, value - (value % step) + step));
  return (
    <span className={`stepper${big ? ' big' : ''}`} role="group" aria-label={label}>
      <button className="btn icon small" onClick={down} disabled={value <= 0} aria-label={`${step} minutes less`}>
        −
      </button>
      <span className="num" aria-live="polite">
        {fmt(value * 60_000)}
      </span>
      <button className="btn icon small" onClick={up} disabled={value >= max} aria-label={`${step} minutes more`}>
        +
      </button>
    </span>
  );
}

/** Type to find one of your topics in this room, or to name a new task. */
function TaskPicker({ topics, onPick, onCancel }: { topics: Topic[]; onPick: (topicId: string | null, title: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const done = (t: Topic) => t.progress[t.createdBy]?.status === 'completed';
  // Unfinished topics first, in room order.
  const matches = topics
    .filter((t) => !query || t.title.toLowerCase().includes(query))
    .sort((a, b) => Number(done(a)) - Number(done(b)))
    .slice(0, 6);
  const exact = topics.some((t) => t.title.toLowerCase() === query);
  return (
    <div className="task-picker stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && query && (matches.length === 1 ? onPick(matches[0].id, matches[0].title) : !exact && onPick(null, q.trim()))}
          placeholder="Find a topic or name a new task"
          maxLength={140}
          aria-label="Find a topic or name a new task"
        />
        <button className="btn ghost icon small" onClick={onCancel} aria-label="Cancel">
          <XIcon width={16} />
        </button>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {query && !exact && (
          <button className="chip-btn on" onClick={() => onPick(null, q.trim())}>
            ＋ New: “{q.trim()}”
          </button>
        )}
        {matches.map((t) => (
          <button key={t.id} className="chip-btn" onClick={() => onPick(t.id, t.title)}>
            {t.title}
          </button>
        ))}
        {!matches.length && !query && <span className="tiny muted">Type the name of what you worked on.</span>}
      </div>
    </div>
  );
}

// ───────────── Choosing a topic ─────────────

function useTopicRoom(topicId: string | null) {
  return useQuery({
    queryKey: ['topicRoom', topicId],
    enabled: Boolean(topicId),
    queryFn: () => api.get<{ topicId: string; roomId: string; roomName: string }>(`/topics/${topicId}`),
    retry: false,
  });
}

function StartScreen({ topicId, taskId, outcome, clearOutcome }: { topicId: string | null; taskId: string | null; outcome: Outcome | null; clearOutcome: () => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data: me } = useMe();
  const { data: rooms } = useRooms();
  const lookup = useTopicRoom(topicId);
  const [roomChoice, setRoomChoice] = useState<string | null>(null);
  // Studying together: ?join=<friend id>, offered while a friend is studying (Settings → Motivation & focus).
  const [togetherOn] = usePref('together');
  const { data: friendsData } = useFriends();
  const studyingFriend = togetherOn ? friendsData?.friends.find((f) => f.status.state === 'studying' || f.status.state === 'paused') : undefined;
  const joinId = params.get('join');
  const joining = joinId && studyingFriend?.user.id === joinId ? studyingFriend : undefined;
  useEffect(() => {
    if (joining?.status.roomId && !topicId && !roomChoice) setRoomChoice(joining.status.roomId);
  }, [joining?.status.roomId, topicId, roomChoice]);
  const roomId = lookup.data?.roomId ?? roomChoice ?? outcome?.result.roomId ?? null;
  const { data: room, isLoading: roomLoading } = useRoom(roomId ?? undefined);
  const qc = useQueryClient();

  // Only your own topics can be studied; your friend's list is view-only.
  // Only your own topics; goal tasks only while they're scheduled for today or later (not the backlog),
  // or when you've reopened one to revise it.
  const myTopics = useMemo(() => {
    const scheduled = new Set((room?.sprints ?? []).flatMap((s) => s.days.filter((d) => d.date >= (me?.today ?? '')).flatMap((d) => d.tasks.map((t) => t.topicId))));
    const revising = (t: Topic) => t.progress[me?.id ?? '']?.status === 'revising';
    return (room?.topics ?? []).filter((t) => t.createdBy === me?.id && (!t.planTaskId || scheduled.has(t.id) || revising(t)));
  }, [room, me?.id, me?.today]);
  const selected: Topic | undefined = useMemo(() => myTopics.find((t) => t.id === topicId), [myTopics, topicId]);
  const partnersTopic = Boolean(topicId && room && !selected && room.topics.some((t) => t.id === topicId));
  const [targetText, setTargetText] = useState('');
  const [remind, setRemind] = useState(false);
  useEffect(() => {
    setTargetText(selected?.sessionTargetMinutes ? String(selected.sessionTargetMinutes) : '');
  }, [selected?.id]);

  const start = useAction(
    () =>
      joining
        ? api.post<{ session: ActiveSession }>('/together/join', {
            friendId: joining.user.id,
            topicId: selected!.id,
            targetMinutes: targetText ? Math.round(Number(targetText)) : null,
          })
        : api.post<{ session: ActiveSession }>('/sessions', {
            topicId: selected!.id,
            targetMinutes: targetText ? Math.round(Number(targetText)) : null,
            remindAfterHour: remind,
            taskId,
          }),
    {
      invalidate: [['session'], ['room', roomId ?? ''], ['rooms']],
      onSuccess: (r) => {
        clearOutcome();
        qc.setQueryData<any>(['session'], r.session);
      },
      onError: (e: ApiError) => {
        if (e.code === 'SESSION_ACTIVE') {
          qc.setQueryData<any>(['session'], e.data);
          toast('You already have a session running — here it is.', 'notice');
          return true;
        }
        if (e.code === 'FRIEND_NOT_STUDYING') void qc.invalidateQueries({ queryKey: ['friends'] });
      },
    },
  );

  const select = (id: string) => {
    clearOutcome();
    setParams(joinId ? { topic: id, join: joinId } : { topic: id }, { replace: true });
  };
  const setJoin = (friendId: string | null) => {
    const next = new URLSearchParams(params);
    if (friendId) next.set('join', friendId);
    else next.delete('join');
    setParams(next, { replace: true });
  };

  if (!me) return <Spinner />;
  if (topicId && lookup.isError) return <ErrorNote error={lookup.error} />;

  const activeRooms = (rooms ?? []).filter((r) => r.status === 'active');
  const myProgress = selected?.progress[me.id];

  return (
    <div className="stack-lg" style={{ maxWidth: 640, margin: '0 auto' }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Study</h1>
          <p className="muted">Pick a topic and press start. We'll keep track of the time.</p>
        </div>
      </div>

      {studyingFriend &&
        (joining ? (
          <div className="card tint row wrap together-join" style={personVars(joining.user.accent)}>
            <span className="grow small">
              🌱 <b>Studying together with {joining.user.displayName}</b>
              {joining.status.topicTitle ? ` (on “${joining.status.topicTitle}”)` : ''}. Pick your topic and start — you'll share a timer, and either of you can call a break for both.
            </span>
            <button className="btn ghost small" onClick={() => setJoin(null)}>
              Study alone
            </button>
          </div>
        ) : (
          <div className="card row wrap together-join">
            <span className="grow small">
              <b>{studyingFriend.user.displayName}</b> is studying right now.
            </span>
            <button className="btn small" onClick={() => setJoin(studyingFriend.user.id)}>
              Study together
            </button>
          </div>
        ))}

      {outcome && <OutcomeCard outcome={outcome} onStartNext={() => outcome.result.nextTopic && select(outcome.result.nextTopic.id)} />}

      {!roomId && (
        <div className="card stack">
          <h2>Which room?</h2>
          {activeRooms.length ? (
            activeRooms.map((r) => (
              <button key={r.id} className="btn block pick-row" onClick={() => setRoomChoice(r.id)}>
                <span className="bold">{r.name}</span>
                <span className="small muted">{r.nextTopic ? `Next: ${r.nextTopic.title}` : 'All done'}</span>
              </button>
            ))
          ) : (
            <Empty title="No rooms yet" action={<Link to="/rooms" className="btn primary">Go to rooms</Link>}>
              Create a room with your friend and add a topic to start studying.
            </Empty>
          )}
        </div>
      )}

      {roomId && roomLoading && <Spinner />}

      {partnersTopic && <div className="banner">That's your friend's topic — you can follow their progress, but only they can study it. Pick one of yours below.</div>}

      {room && selected && !outcome?.result.nextTopic && (
        <div className="card stack" style={personVars(me.accent)}>
          <div className="row between top">
            <div>
              <span className="section-label">{room.name}</span>
              <h2 style={{ marginTop: 4 }}>{selected.title}</h2>
            </div>
            <span className="chip c">{statusLabel(myProgress?.status)}</span>
          </div>
          {selected.description && <p className="small muted">{selected.description}</p>}
          <div className="grid-3" style={{ gap: 10 }}>
            <Stat label="Estimated to finish" value={selected.estimatedMinutes ? formatMinutes(selected.estimatedMinutes) : '—'} />
            <Stat label="Time spent so far" value={fmt(myProgress?.focusedMs ?? 0)} />
            <Stat label="Sessions" value={String(myProgress?.sessions ?? 0)} />
          </div>
          <div className="form-grid">
            <Field label="Session length (minutes, optional)" hint="Leave empty to just count up.">
              <input className="input" type="number" min="1" max="600" inputMode="numeric" value={targetText} onChange={(e) => setTargetText(e.target.value)} placeholder="e.g. 45" />
            </Field>
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <Switch checked={remind} onChange={setRemind} label="Remind me after 1 hour" />
            </div>
          </div>
          {myProgress?.status === 'completed' && <p className="small muted">You've completed this one. Starting again records a revision session — your completion stays.</p>}
          <button className="btn primary big block" disabled={start.isPending || room.status !== 'active'} onClick={() => start.mutate(undefined)}>
            <PlayIcon /> {start.isPending ? 'Starting…' : joining ? `Start with ${joining.user.displayName}` : 'Start studying'}
          </button>
        </div>
      )}

      {room && (
        <div className="card stack">
          <div className="row between">
            <h3>{selected ? 'Or choose another topic' : `Your topics in ${room.name}`}</h3>
            {!lookup.data && (
              <button className="btn ghost small" onClick={() => setRoomChoice(null)}>
                Change room
              </button>
            )}
          </div>
          {myTopics.length === 0 && (
            <p className="small muted">
              You have no topics here yet. <Link to={`/rooms/${room.id}`}>Add one in the room</Link>.
            </p>
          )}
          {myTopics.map((t, i) => {
            const p = t.progress[me.id];
            const done = p?.status === 'completed';
            return (
              <button key={t.id} className={`topic-row${t.id === topicId ? ' selected' : ''}`} style={{ cursor: 'pointer', textAlign: 'left', gridTemplateColumns: '34px 1fr auto' }} onClick={() => select(t.id)}>
                <span className={`idx${done ? ' done' : ''}`}>{done ? <CheckIcon width={16} /> : i + 1}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="bold" style={{ display: 'block' }}>{t.title}</span>
                  <span className="tiny muted">
                    {statusLabel(p?.status)} · {fmt(p?.focusedMs ?? 0)}
                    {t.estimatedMinutes ? ` of ~${formatMinutes(t.estimatedMinutes)}` : ''}
                  </span>
                </span>
                <span className="small muted">{t.id === topicId ? 'Selected' : ''}</span>
              </button>
            );
          })}
        </div>
      )}

      {outcome && !room && (
        <button className="btn" onClick={() => navigate('/')}>
          Back home
        </button>
      )}
    </div>
  );
}

function OutcomeCard({ outcome, onStartNext }: { outcome: Outcome; onStartNext: () => void }) {
  const { result } = outcome;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const start = useAction((topicId: string) => api.post<{ session: ActiveSession }>('/sessions', { topicId }), {
    invalidate: [['session'], ['rooms']],
    onSuccess: (r) => qc.setQueryData<any>(['session'], r.session),
  });
  return (
    <div className="card tint stack outcome-card" style={me ? personVars(me.accent) : undefined} role="status">
      <div className="row">
        {outcome.plant ? (
          <span className="outcome-plant">
            <TodayPlant percent={outcome.plant.percent} size={96} color="var(--c)" />
          </span>
        ) : (
          <Plant percent={outcome.kind === 'completed' ? 100 : 50} size={56} color="var(--c)" />
        )}
        <div className="grow">
          <h2>{outcome.kind === 'completed' ? `🌼 “${outcome.topicTitle}” complete` : 'Session saved'}</h2>
          <p className="small muted">
            {outcome.focusedMs != null ? `${fmt(outcome.focusedMs)} focused this session. ` : ''}
            {outcome.kind === 'completed' ? (outcome.plant?.caption ?? 'Your room and goals are updated.') : 'The topic stays open for next time.'}
          </p>
        </div>
      </div>
      {outcome.kind === 'completed' &&
        (result.nextTopic ? (
          <div className="card stack" style={{ gap: 8 }}>
            <span className="section-label">Up next</span>
            <b>{result.nextTopic.title}</b>
            <div className="row wrap">
              <button className="btn primary grow" disabled={start.isPending} onClick={() => start.mutate(result.nextTopic!.id)}>
                <NextIcon /> Start next topic
              </button>
              <button className="btn" onClick={onStartNext}>
                See details first
              </button>
            </div>
            <p className="tiny muted">The timer won't start until you press the button.</p>
          </div>
        ) : (
          <div className="stack">
            <p className="bold">You've completed every topic in this room 🌸</p>
            <div className="row wrap">
              <button className="btn primary" onClick={() => navigate(`/rooms/${result.roomId}`)}>
                Add more topics
              </button>
              <button className="btn" onClick={() => navigate(`/rooms/${result.roomId}`)}>
                Revisit a topic
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card soft" style={{ padding: 12 }}>
      <div className="tiny muted">{label}</div>
      <div className="bold num">{value}</div>
    </div>
  );
}

function statusLabel(s: string | undefined) {
  switch (s) {
    case 'completed':
      return 'Completed';
    case 'in_progress':
      return 'In progress';
    case 'revising':
      return 'Revising';
    default:
      return 'Not started';
  }
}
