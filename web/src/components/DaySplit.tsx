// Where your day goes (Settings → Motivation & focus → Day split). You tell us how much you sleep and when you
// work; every day is then split into sleep, work, study and timepass — the free time you didn't study. Your
// friend's split shows next to yours while they have it on.
import { useState } from 'react';
import type { PublicUser, Routine } from '@shared/types';
import { api } from '../lib/api';
import { usePref } from '../lib/prefs';
import { useAction, useProgress, useRoutine } from '../lib/queries';
import { fmt, Modal, Switch } from './ui';

const DAY_MIN = 24 * 60;
const INTRO_DISMISSED = 'us-in-progress-day-split-intro';
// Mon-first, as people think of a work week.
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PARTS = [
  { key: 'sleep', label: 'Sleep' },
  { key: 'work', label: 'Work' },
  { key: 'study', label: 'Study' },
  { key: 'timepass', label: 'Timepass' },
] as const;
type Part = (typeof PARTS)[number]['key'];
type Split = Record<Part, number>; // minutes

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const hours = (min: number) => fmt(Math.round(min) * 60_000);

/** Work minutes on a working day (an end before the start is a night shift). */
export function workMinutes(r: Routine): number {
  if (!r.workStart || !r.workEnd) return 0;
  const d = minutesOf(r.workEnd) - minutesOf(r.workStart);
  return d > 0 ? d : d + DAY_MIN;
}

/** One day: sleep and work from the routine, study from the timer, and the rest of the free time is timepass. */
export function splitDay(r: Routine, date: string, studyMs: number): Split {
  const sleep = r.sleepMinutes;
  const work = r.workDays.includes(weekday(date)) ? workMinutes(r) : 0;
  const study = Math.min(studyMs / 60_000, Math.max(0, DAY_MIN - sleep - work));
  return { sleep, work, study, timepass: Math.max(0, DAY_MIN - sleep - work - study) };
}

const sum = (list: Split[]): Split => list.reduce((a, s) => ({ sleep: a.sleep + s.sleep, work: a.work + s.work, study: a.study + s.study, timepass: a.timepass + s.timepass }), { sleep: 0, work: 0, study: 0, timepass: 0 });

/** A 24-hour (or 7-day) bar: sleep · work · study · timepass, with the hours written underneath. */
function SplitBar({ split, label }: { split: Split; label: string }) {
  const total = PARTS.reduce((n, p) => n + split[p.key], 0) || 1;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="split-bar" role="img" aria-label={`${label}: ${PARTS.map((p) => `${p.label} ${hours(split[p.key])}`).join(', ')}`}>
        {PARTS.filter((p) => split[p.key] > 0).map((p) => (
          <span key={p.key} className={`seg ${p.key}`} style={{ flexGrow: split[p.key] / total }} title={`${p.label}: ${hours(split[p.key])}`} />
        ))}
      </div>
      <div className="split-legend">
        {PARTS.map((p) => (
          <span key={p.key}>
            <i className={`swatch ${p.key}`} aria-hidden="true" />
            {p.label} <b className="num">{hours(split[p.key])}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function PersonSplit({ user, isMe, routine, view, today }: { user: PublicUser; isMe: boolean; routine: Routine; view: 'today' | 'week'; today: string }) {
  const { data: stats } = useProgress(isMe ? undefined : user.id);
  if (!stats) return null;
  const name = isMe ? 'You' : user.displayName;
  const studiedToday = stats.daily.find((d) => d.date === today)?.ms ?? stats.todayMs;
  if (view === 'today') {
    const s = splitDay(routine, today, studiedToday);
    const free = s.study + s.timepass;
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="row between">
          <b className="small">{name}</b>
          <span className="tiny muted">{free ? `${Math.round((s.study / free) * 100)}% of free time studied` : 'No free time today'}</span>
        </div>
        <SplitBar split={s} label={`${name}, today`} />
        <p className="tiny muted" style={{ margin: 0 }}>
          {s.study === 0
            ? `${hours(s.timepass)} free today and nothing studied yet${isMe ? ' — even 25 minutes counts.' : '.'}`
            : `${hours(s.study)} studied, ${hours(s.timepass)} of free time left as timepass.`}
        </p>
      </div>
    );
  }
  // The last 7 full days (today isn't over yet).
  const days = stats.daily.filter((d) => d.date < today).slice(-7);
  const splits = days.map((d) => ({ date: d.date, s: splitDay(routine, d.date, d.ms) }));
  const week = sum(splits.map((x) => x.s));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <b className="small">{name}</b>
        <span className="tiny muted">
          {hours(week.timepass)} timepass in {days.length} days
        </span>
      </div>
      <SplitBar split={week} label={`${name}, last ${days.length} days`} />
      <div className="split-days">
        {splits.map(({ date, s }) => (
          <div key={date} className="split-day" title={`${SHORT[weekday(date)]}: studied ${hours(s.study)}, timepass ${hours(s.timepass)}`}>
            <span className="tiny muted">{SHORT[weekday(date)]}</span>
            <div className="split-bar thin" aria-hidden="true">
              {PARTS.filter((p) => s[p.key] > 0).map((p) => (
                <span key={p.key} className={`seg ${p.key}`} style={{ flexGrow: s[p.key] }} />
              ))}
            </div>
            <span className="tiny num">{hours(s.study)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** On Home: the day split, or a one-time question to set it up. */
export function DaySplitCard({ me, friend, today }: { me: PublicUser; friend: PublicUser | undefined; today: string }) {
  const [on, setOn] = usePref('daySplit');
  const { data: mine, isLoading } = useRoutine(on, me.id);
  const { data: theirs } = useRoutine(on, friend?.id);
  const [view, setView] = useState<'today' | 'week'>('today');
  const [editing, setEditing] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(INTRO_DISMISSED) === '1';
    } catch {
      return false;
    }
  });

  const editor = editing && <RoutineModal routine={mine ?? null} onClose={() => setEditing(false)} onSaved={() => setOn(true)} />;
  if (!on || (!isLoading && !mine)) {
    if (!on && dismissed) return null;
    return (
      <div className="card stack day-intro" style={{ gap: 8 }}>
        <b>⏰ Where does your day go?</b>
        <p className="small muted" style={{ margin: 0 }}>
          Tell us how much you sleep and your work or office hours. Every day then splits into sleep, work, study and timepass — the free time you
          didn't study.{friend ? ` ${friend.displayName} sees yours, and you see theirs.` : ''}
        </p>
        <div className="row">
          <button className="btn primary small" onClick={() => setEditing(true)}>
            Set it up
          </button>
          {!on && (
            <button
              className="btn ghost small"
              onClick={() => {
                setDismissed(true);
                try {
                  localStorage.setItem(INTRO_DISMISSED, '1');
                } catch {}
              }}
            >
              Not now
            </button>
          )}
        </div>
        {editor}
      </div>
    );
  }
  if (!mine) return null;

  return (
    <div className="card stack day-split">
      <div className="row between wrap" style={{ gap: 8 }}>
        <h2>Where your day goes</h2>
        <div className="tabs" role="tablist" aria-label="Period">
          {(['today', 'week'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'today' ? 'Today' : 'Past week'}
            </button>
          ))}
        </div>
      </div>
      <PersonSplit user={me} isMe routine={mine} view={view} today={today} />
      {friend && theirs && <PersonSplit user={friend} isMe={false} routine={theirs} view={view} today={today} />}
      {friend && !theirs && <p className="tiny muted">{friend.displayName} hasn't set up their day split yet.</p>}
      <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing(true)}>
        Edit my sleep and work hours
      </button>
      {editor}
    </div>
  );
}

/** How much you sleep, and when you work. */
export function RoutineModal({ routine, onClose, onSaved }: { routine: Routine | null; onClose: () => void; onSaved?: () => void }) {
  const [sleep, setSleep] = useState(routine?.sleepMinutes ?? 7 * 60);
  const [works, setWorks] = useState(routine ? Boolean(routine.workStart) : true);
  const [start, setStart] = useState(routine?.workStart ?? '09:30');
  const [end, setEnd] = useState(routine?.workEnd ?? '18:30');
  const [days, setDays] = useState<number[]>(routine?.workDays ?? [1, 2, 3, 4, 5]);
  const body: Routine = { sleepMinutes: sleep, workStart: works ? start : null, workEnd: works ? end : null, workDays: works ? days : [] };
  const save = useAction(() => api.put<{ routine: Routine }>('/routine', body), {
    invalidate: [['routine']],
    success: 'Saved ⏰',
    onSuccess: () => {
      onSaved?.();
      onClose();
    },
  });
  const valid = !works || (start && end && start !== end && days.length > 0);

  return (
    <Modal
      title="Your day"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!valid || save.isPending} onClick={() => save.mutate(undefined)}>
          Save
        </button>
      }
    >
      <div className="stack">
        <div className="row between">
          <span>How much do you sleep?</span>
          <span className="stepper big" role="group" aria-label="Sleep">
            <button className="btn icon small" disabled={sleep <= 180} onClick={() => setSleep(sleep - 30)} aria-label="30 minutes less">
              −
            </button>
            <span className="num" aria-live="polite">
              {hours(sleep)}
            </span>
            <button className="btn icon small" disabled={sleep >= 720} onClick={() => setSleep(sleep + 30)} aria-label="30 minutes more">
              +
            </button>
          </span>
        </div>
        <div className="divider" />
        <Switch checked={works} onChange={setWorks} label="I have office, work or college hours" />
        {works && (
          <>
            <div className="row wrap" style={{ gap: 10 }}>
              <label className="stack" style={{ gap: 4 }}>
                <span className="tiny muted">From</span>
                <input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="tiny muted">To</span>
                <input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
              {start && end && start !== end && <span className="small muted">= {hours(workMinutes(body))}</span>}
            </div>
            <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Work days">
              {WEEK.map((d) => (
                <button key={d} type="button" className={`chip-btn${days.includes(d) ? ' on' : ''}`} aria-pressed={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>
                  {SHORT[d]}
                </button>
              ))}
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              On days off, only sleep is taken out of the day.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
