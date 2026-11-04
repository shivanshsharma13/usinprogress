// Streaks and the weekly recap (Settings → Motivation & focus). Both show on Home.
// A streak is consecutive days with at least 5 focused minutes. The recap appears on Sunday (this week so
// far) and Monday (last week), until you close it.
import { useState } from 'react';
import { addDays, formatDate, startOfWeek, weekday } from '@shared/dates';
import type { PublicUser, WeekRecap } from '@shared/types';
import { usePref } from '../lib/prefs';
import { useWeekRecap } from '../lib/queries';
import { personVars } from '../lib/theme';
import { Avatar, fmt } from './ui';
import { XIcon } from './icons';

const DISMISSED = 'us-in-progress-recap-closed';

/** Sunday shows this week so far; Monday looks back at last week. */
export function recapRange(today: string): { from: string; to: string; showRecap: boolean; lastWeek: boolean } {
  const day = weekday(today);
  if (day === 0) {
    const from = addDays(startOfWeek(today), -7);
    return { from, to: addDays(from, 6), showRecap: true, lastWeek: true };
  }
  return { from: startOfWeek(today), to: today, showRecap: day === 6, lastWeek: false };
}

export function StreaksAndRecap({ me, friends, today }: { me: PublicUser; friends: PublicUser[]; today: string }) {
  const [streaksOn] = usePref('streaks');
  const [recapOn] = usePref('recap');
  const range = recapRange(today);
  const { data } = useWeekRecap(streaksOn || recapOn, range.from, range.to);
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === range.from;
    } catch {
      return false;
    }
  });
  if (!data) return null;
  const users = new Map([me, ...friends].map((u) => [u.id, u]));
  const people = data.filter((p) => users.has(p.userId)).map((p) => ({ ...p, user: users.get(p.userId)! }));

  const close = () => {
    setClosed(true);
    try {
      localStorage.setItem(DISMISSED, range.from);
    } catch {}
  };

  return (
    <>
      {streaksOn && <StreakStrip people={people} meId={me.id} />}
      {recapOn && range.showRecap && !closed && <RecapCard people={people} meId={me.id} range={range} onClose={close} />}
    </>
  );
}

type Person = WeekRecap & { user: PublicUser };

function StreakStrip({ people, meId }: { people: Person[]; meId: string }) {
  const mine = people.find((p) => p.userId === meId);
  if (!mine) return null;
  const atRisk = mine.streak.current > 0 && !mine.streak.studiedToday;
  return (
    <div className="card streak-card">
      <div className="streak-people">
        {people.map((p) => (
          <div key={p.userId} className="streak-person" style={personVars(p.user.accent)}>
            <span className={`streak-flame${p.streak.current ? '' : ' out'}`} aria-hidden="true">
              🔥
            </span>
            <div>
              <b className="num">
                {p.streak.current} {p.streak.current === 1 ? 'day' : 'days'}
              </b>
              <div className="tiny muted">
                {p.userId === meId ? 'You' : p.user.displayName}
                {p.streak.best > p.streak.current ? ` · best ${p.streak.best}` : p.streak.current ? ' · your best yet' : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="tiny muted">
        {atRisk
          ? `Study 5 minutes today to keep your ${mine.streak.current}-day streak going.`
          : mine.streak.studiedToday
            ? 'Today counts. Nice.'
            : 'Study 5 minutes to start a streak.'}
      </p>
    </div>
  );
}

function RecapCard({ people, meId, range, onClose }: { people: Person[]; meId: string; range: { from: string; to: string; lastWeek: boolean }; onClose: () => void }) {
  const together = people.reduce((n, p) => n + p.totalMs, 0);
  const span = `${formatDate(range.from, { day: 'numeric', month: 'short' })} – ${formatDate(range.to, { day: 'numeric', month: 'short' })}`;
  return (
    <div className="card recap-card stack">
      <div className="row between top">
        <div>
          <span className="section-label">{range.lastWeek ? 'Last week' : 'Your week so far'}</span>
          <h2>{people.length > 1 ? 'Your week together' : 'Your week'}</h2>
          <p className="tiny muted">
            {span}
            {people.length > 1 ? ` · ${fmt(together)} together` : ''}
          </p>
        </div>
        <button className="btn ghost icon small" onClick={onClose} aria-label="Close the recap">
          <XIcon width={16} />
        </button>
      </div>
      <div className="recap-grid">
        {people.map((p) => (
          <div key={p.userId} className="recap-person" style={personVars(p.user.accent)}>
            <div className="row" style={{ gap: 8 }}>
              <Avatar user={p.user} size={32} />
              <b>{p.userId === meId ? 'You' : p.user.displayName}</b>
            </div>
            <dl className="recap-stats">
              <div>
                <dt>Focused</dt>
                <dd className="num">{fmt(p.totalMs)}</dd>
              </div>
              <div>
                <dt>Best day</dt>
                <dd>{p.bestDay?.ms ? `${formatDate(p.bestDay.date, { weekday: 'short' })} · ${fmt(p.bestDay.ms)}` : '—'}</dd>
              </div>
              <div>
                <dt>Topics finished</dt>
                <dd className="num">{p.topicsDone}</dd>
              </div>
              <div>
                <dt>Trees planted</dt>
                <dd className="num">{p.trees ? `${p.trees} 🌳` : '0'}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
      <p className="small">{cheer(people, meId)}</p>
    </div>
  );
}

function cheer(people: Person[], meId: string): string {
  const mine = people.find((p) => p.userId === meId);
  const total = people.reduce((n, p) => n + p.totalMs, 0);
  if (!total) return 'A quiet week. A fresh one starts Monday — 25 minutes is enough to begin. 🌱';
  if (people.length > 1 && people.every((p) => p.totalMs > 0)) return 'You both showed up this week. That’s the whole trick. 🌼';
  if (mine?.trees) return `${mine.trees === 1 ? 'A tree' : `${mine.trees} trees`} for days you finished everything. Lovely work. 🌳`;
  return 'Every hour here is one you chose. Keep going. 🌱';
}
