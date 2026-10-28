// The interactive study timer. Every button writes a timestamp to the server; the clock shown
// here is always recomputed from those saved timestamps, so refreshes and tab switches never lose time.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { focusedMs, formatClock, formatCountdown, formatMinutes } from '@shared/timer';
import type { ActiveSession, SessionRecord, Topic } from '@shared/types';
import { useAction, useActiveSession, useMe, useRoom, useRooms } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/toast';
import { personVars } from '../lib/theme';
import { Empty, ErrorNote, Field, fmt, Modal, Spinner, Switch, useNow } from '../components/ui';
import { Plant } from '../components/Plant';
import { CheckIcon, ChevronLeft, NextIcon, PauseIcon, PlayIcon, StopIcon } from '../components/icons';

interface FinishResult {
  session: SessionRecord | null;
  completedTopic: boolean;
  nextTopic: { id: string; title: string } | null;
  roomId: string;
}

type Outcome = { kind: 'completed' | 'finished'; topicTitle: string; focusedMs: number | null; result: FinishResult };

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
    (body: { completeTopic?: boolean; confirmLong?: boolean; correctedMinutes?: number }) => api.post<FinishResult>(`/sessions/${session.id}/finish`, { ...body, note: note || undefined }),
    {
      invalidate: inv,
      onSuccess: (r, body) => {
        setLongSession(null);
        qc.setQueryData<any>(['session'], null);
        onOutcome({ kind: body.completeTopic ? 'completed' : 'finished', topicTitle: session.topicTitle, focusedMs: r.session?.focusedMs ?? null, result: r });
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
          busy={finish.isPending}
          onCancel={() => setLongSession(null)}
          onConfirm={() => finish.mutate({ completeTopic: longSession.completeTopic, confirmLong: true })}
          onCorrect={(m) => finish.mutate({ completeTopic: longSession.completeTopic, correctedMinutes: m })}
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

function LongSessionDialog({ measuredMs, busy, onCancel, onConfirm, onCorrect }: { measuredMs: number; busy: boolean; onCancel: () => void; onConfirm: () => void; onCorrect: (m: number) => void }) {
  const [minutes, setMinutes] = useState(String(Math.min(180, Math.round(measuredMs / 60_000))));
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
        <Field label="Or correct it to (minutes)" hint="The original reading is kept in your history.">
          <div className="row">
            <input className="input" type="number" min="0" max="1440" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            <button className="btn" disabled={busy || minutes === '' || Number(minutes) < 0} onClick={() => onCorrect(Math.round(Number(minutes)))}>
              Save
            </button>
          </div>
        </Field>
      </div>
    </Modal>
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
  const [, setParams] = useSearchParams();
  const { data: me } = useMe();
  const { data: rooms } = useRooms();
  const lookup = useTopicRoom(topicId);
  const [roomChoice, setRoomChoice] = useState<string | null>(null);
  const roomId = lookup.data?.roomId ?? roomChoice ?? outcome?.result.roomId ?? null;
  const { data: room, isLoading: roomLoading } = useRoom(roomId ?? undefined);
  const qc = useQueryClient();

  // Only your own topics can be studied; your friend's list is view-only.
  // Only your own topics; goal tasks only while they're scheduled for today or later (not the backlog).
  const myTopics = useMemo(() => {
    const scheduled = new Set((room?.sprints ?? []).flatMap((s) => s.days.filter((d) => d.date >= (me?.today ?? '')).flatMap((d) => d.tasks.map((t) => t.topicId))));
    return (room?.topics ?? []).filter((t) => t.createdBy === me?.id && (!t.planTaskId || scheduled.has(t.id)));
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
      api.post<{ session: ActiveSession }>('/sessions', {
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
      },
    },
  );

  const select = (id: string) => {
    clearOutcome();
    setParams({ topic: id }, { replace: true });
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
            <PlayIcon /> {start.isPending ? 'Starting…' : 'Start studying'}
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
    <div className="card tint stack" style={me ? personVars(me.accent) : undefined} role="status">
      <div className="row">
        <Plant percent={outcome.kind === 'completed' ? 100 : 50} size={56} color="var(--c)" />
        <div className="grow">
          <h2>{outcome.kind === 'completed' ? `🌼 “${outcome.topicTitle}” complete` : 'Session saved'}</h2>
          <p className="small muted">
            {outcome.focusedMs != null ? `${fmt(outcome.focusedMs)} focused this session. ` : ''}
            {outcome.kind === 'completed' ? 'Your room and goals are updated.' : 'The topic stays open for next time.'}
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
