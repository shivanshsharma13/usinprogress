// Where your day goes (Settings → Motivation & focus → Day split). You tell us how much you sleep and when you
// work — each work day with its own hours, and any single day can be changed on its own; every day is then split into sleep, work, study and timepass — the free time you didn't study. Your
// friend's split shows next to yours while they have it on.
import { useState } from 'react';
import type { DayChange, PublicUser, Routine, WorkSlot } from '@shared/types';
import { api } from '../lib/api';
import { usePref } from '../lib/prefs';
import { useAction, useProgress, useRoutine } from '../lib/queries';
import { fmt, Modal, Switch } from './ui';

const DAY_MIN = 24 * 60;
const INTRO_DISMISSED = 'us-in-progress-day-split-intro';
// Mon-first, as people think of a work week.
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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

const DEFAULT_HOURS = { start: '09:30', end: '18:30' };

/** Minutes from start to end (an end before the start is a night shift). */
export function span(start: string, end: string): number {
  const d = minutesOf(end) - minutesOf(start);
  return d > 0 ? d : d + DAY_MIN;
}

/** Each work day with its hours. Routines saved before per-day hours had one set of hours for all work days. */
export function workSlots(r: Routine): WorkSlot[] {
  if (r.work) return r.work;
  return r.workStart && r.workEnd ? r.workDays.map((day) => ({ day, start: r.workStart!, end: r.workEnd! })) : [];
}

/** The work hours on a date: that day's own change if it has one, otherwise the usual hours for its weekday. */
export function hoursOn(r: Routine, date: string): { start: string; end: string } | null {
  const change = r.dayChanges?.[date];
  if (change) return 'off' in change ? null : change;
  return workSlots(r).find((s) => s.day === weekday(date)) ?? null;
}

const clock = (hhmm: string) => {
  const [h, m] = [Number(hhmm.slice(0, 2)), hhmm.slice(3)];
  return `${h % 12 || 12}${m === '00' ? '' : `:${m}`}${h < 12 ? 'am' : 'pm'}`;
};
const range = (h: { start: string; end: string }) => `${clock(h.start)}–${clock(h.end)}`;

/** One day: sleep and work from the routine, study from the timer, and the rest of the free time is timepass. */
export function splitDay(r: Routine, date: string, studyMs: number): Split {
  const sleep = r.sleepMinutes;
  const hrs = hoursOn(r, date);
  const work = hrs ? span(hrs.start, hrs.end) : 0;
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
  const [changing, setChanging] = useState(false);
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
        {isMe && (
          <div className="row wrap small" style={{ gap: 6 }}>
            <span className="muted">{workToday(routine, today)}</span>
            <button className="btn ghost small" style={{ padding: '0 4px', minHeight: 0 }} onClick={() => setChanging(true)}>
              Different today?
            </button>
          </div>
        )}
        {changing && <DayHoursModal routine={routine} date={today} onClose={() => setChanging(false)} />}
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
          <div key={date} className={`split-day${routine.dayChanges?.[date] ? ' changed' : ''}`} title={`${SHORT[weekday(date)]}${routine.dayChanges?.[date] ? ' (hours changed that day)' : ''}: studied ${hours(s.study)}, timepass ${hours(s.timepass)}`}>
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

function workToday(r: Routine, today: string): string {
  const hrs = hoursOn(r, today);
  const changed = Boolean(r.dayChanges?.[today]);
  if (!hrs) return changed ? 'No work today (changed for today).' : 'No work today.';
  return `Work today ${range(hrs)}${changed ? ' (changed for today)' : ''}.`;
}

/** "From … To …" for one set of hours. */
function HoursInputs({ value, onChange, label }: { value: { start: string; end: string }; onChange: (v: { start: string; end: string }) => void; label: string }) {
  return (
    <span className="hours-inputs" role="group" aria-label={label}>
      <input className="input" type="time" aria-label={`${label} from`} value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} />
      <span className="muted" aria-hidden="true">–</span>
      <input className="input" type="time" aria-label={`${label} to`} value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} />
    </span>
  );
}

const validHours = (h: { start: string; end: string }) => Boolean(h.start && h.end && h.start !== h.end);

/** How much you sleep, and when you work — each day with its own hours. */
export function RoutineModal({ routine, onClose, onSaved }: { routine: Routine | null; onClose: () => void; onSaved?: () => void }) {
  const saved = routine ? workSlots(routine) : null;
  const [sleep, setSleep] = useState(routine?.sleepMinutes ?? 7 * 60);
  const [works, setWorks] = useState(saved ? saved.length > 0 : true);
  // Every weekday keeps its hours while switched off, so turning a day back on brings them back.
  const [week, setWeek] = useState(() =>
    WEEK.map((day) => {
      const slot = saved?.find((s) => s.day === day);
      return { day, on: saved ? Boolean(slot) : day >= 1 && day <= 5, start: slot?.start ?? saved?.[0]?.start ?? DEFAULT_HOURS.start, end: slot?.end ?? saved?.[0]?.end ?? DEFAULT_HOURS.end };
    }),
  );
  const set = (day: number, patch: Partial<(typeof week)[number]>) => setWeek(week.map((d) => (d.day === day ? { ...d, ...patch } : d)));
  const onDays = week.filter((d) => d.on);
  const body = { sleepMinutes: sleep, work: works ? onDays.map(({ day, start, end }) => ({ day, start, end })) : [] };
  const save = useAction(() => api.put<{ routine: Routine }>('/routine', body), {
    invalidate: [['routine']],
    success: 'Saved ⏰',
    onSuccess: () => {
      onSaved?.();
      onClose();
    },
  });
  const valid = !works || (onDays.length > 0 && onDays.every(validHours));
  const first = onDays[0];
  const allSame = onDays.every((d) => first && d.start === first.start && d.end === first.end);

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
            <p className="tiny muted" style={{ margin: 0 }}>
              Tap a day to turn it on or off, and set its own hours.
            </p>
            <ul className="week-hours">
              {week.map((d) => (
                <li key={d.day} className={d.on ? '' : 'off'}>
                  <button type="button" className={`chip-btn${d.on ? ' on' : ''}`} aria-pressed={d.on} onClick={() => set(d.day, { on: !d.on })}>
                    {SHORT[d.day]}
                  </button>
                  {d.on ? (
                    <>
                      <HoursInputs label={SHORT[d.day]} value={d} onChange={(h) => set(d.day, h)} />
                      <span className="tiny muted num">{validHours(d) ? hours(span(d.start, d.end)) : ''}</span>
                    </>
                  ) : (
                    <span className="small muted">Off</span>
                  )}
                </li>
              ))}
            </ul>
            {first && onDays.length > 1 && !allSame && (
              <button
                type="button"
                className="btn ghost small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => setWeek(week.map((d) => (d.on ? { ...d, start: first.start, end: first.end } : d)))}
              >
                Use {SHORT[first.day]}'s hours for every day
              </button>
            )}
            <p className="tiny muted" style={{ margin: 0 }}>
              On days off, only sleep is taken out of the day. If one day goes differently, change just that day from Home.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Change one day's work hours without touching the usual ones. */
function DayHoursModal({ routine, date, onClose }: { routine: Routine; date: string; onClose: () => void }) {
  const change = routine.dayChanges?.[date];
  const usual = workSlots(routine).find((s) => s.day === weekday(date)) ?? null;
  const [off, setOff] = useState(Boolean(change && 'off' in change));
  const [hrs, setHrs] = useState(hoursOn(routine, date) ?? usual ?? workSlots(routine)[0] ?? DEFAULT_HOURS);
  const save = useAction((hours: DayChange | null) => api.put<{ routine: Routine }>('/routine/day', { date, hours }), {
    invalidate: [['routine']],
    success: (r) => (r.routine.dayChanges?.[date] ? 'Changed for today' : 'Back to your usual hours'),
    onSuccess: onClose,
  });

  return (
    <Modal
      title="Work hours today"
      onClose={onClose}
      footer={
        <>
          {change && (
            <button className="btn ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
              Back to usual
            </button>
          )}
          <button className="btn primary" disabled={(!off && !validHours(hrs)) || save.isPending} onClick={() => save.mutate(off ? { off: true } : hrs)}>
            Save for today
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Usually {usual ? range(usual) : 'no work'} on {LONG[weekday(date)]}s. This only changes today.
        </p>
        <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Today">
          <button type="button" className={`chip-btn${!off ? ' on' : ''}`} aria-pressed={!off} onClick={() => setOff(false)}>
            I worked or had class
          </button>
          <button type="button" className={`chip-btn${off ? ' on' : ''}`} aria-pressed={off} onClick={() => setOff(true)}>
            No work today
          </button>
        </div>
        {!off && (
          <div className="row wrap" style={{ gap: 10 }}>
            <HoursInputs label="Today" value={hrs} onChange={setHrs} />
            {validHours(hrs) && <span className="small muted">= {hours(span(hrs.start, hrs.end))}</span>}
          </div>
        )}
      </div>
    </Modal>
  );
}
