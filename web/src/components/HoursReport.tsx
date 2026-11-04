// Progress → Hours: focused time by day, by week and by topic, for you and your friend side by side.
// Totals only; a friend's topic names appear only for rooms you share.
import { useState } from 'react';
import { addDays, formatDate, startOfWeek } from '@shared/dates';
import type { HoursReport as Report, PublicUser } from '@shared/types';
import { useHoursReport } from '../lib/queries';
import { personVars } from '../lib/theme';
import { fmt, Spinner } from './ui';

type Period = 'week' | 'month' | 'quarter';
const PERIODS: { key: Period; label: string }[] = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: '4 weeks' },
  { key: 'quarter', label: '12 weeks' },
];

interface Person {
  user: PublicUser;
  name: string;
  report: Report | undefined;
  hatched: boolean; // the friend's bars are striped, so the two never differ by colour alone
}

function range(period: Period, today: string, weeksBack: number): { from: string; to: string } {
  const monday = startOfWeek(today);
  if (period === 'week') {
    const from = addDays(monday, -7 * weeksBack);
    return { from, to: addDays(from, 6) }; // the whole week, so days still to come show as empty
  }
  return { from: addDays(monday, period === 'month' ? -21 : -77), to: today };
}

const msOn = (r: Report | undefined, date: string) => r?.daily.find((d) => d.date === date)?.ms ?? 0;

export function HoursReport({ me, friend, today }: { me: PublicUser; friend: PublicUser | undefined; today: string }) {
  const [period, setPeriod] = useState<Period>('week');
  const [weeksBack, setWeeksBack] = useState(0);
  const [topicsOf, setTopicsOf] = useState<'me' | 'friend'>('me');
  const { from, to } = range(period, today, weeksBack);
  const mine = useHoursReport(me.id, from, to);
  const theirs = useHoursReport(friend?.id, from, to);

  const people: Person[] = [
    { user: me, name: 'You', report: mine.data, hatched: false },
    ...(friend ? [{ user: friend, name: friend.displayName, report: theirs.data, hatched: true }] : []),
  ];
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const elapsed = Math.max(1, days.filter((d) => d <= today).length);
  const weeks: string[] = [];
  for (let w = from; w <= to; w = addDays(w, 7)) weeks.push(w);

  const dayGroups = days.map((d) => ({ key: d, label: formatDate(d, period === 'week' ? { weekday: 'short' } : { day: 'numeric' }), title: formatDate(d, { weekday: 'short', day: 'numeric', month: 'short' }), values: people.map((p) => msOn(p.report, d)) }));
  const weekGroups = weeks.map((w) => ({
    key: w,
    label: formatDate(w, { day: 'numeric', month: 'short' }),
    title: `Week of ${formatDate(w, { day: 'numeric', month: 'short' })}`,
    values: people.map((p) => [0, 1, 2, 3, 4, 5, 6].reduce((n, i) => n + msOn(p.report, addDays(w, i)), 0)),
  }));

  const topicPerson = people.find((p) => (topicsOf === 'me' ? p.user.id === me.id : p.user.id !== me.id)) ?? people[0];

  return (
    <div className="card stack">
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h2>Hours</h2>
        <div className="tabs" role="tablist" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={period === p.key}
              className={period === p.key ? 'on' : ''}
              onClick={() => {
                setPeriod(p.key);
                setWeeksBack(0);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="row between small">
        {period === 'week' ? (
          <>
            <button className="btn ghost small" onClick={() => setWeeksBack((n) => n + 1)} aria-label="Previous week">
              ‹ Earlier
            </button>
            <b className="num">
              {weeksBack === 0 ? 'This week' : `${formatDate(from, { day: 'numeric', month: 'short' })} – ${formatDate(to, { day: 'numeric', month: 'short' })}`}
            </b>
            <button className="btn ghost small" disabled={weeksBack === 0} onClick={() => setWeeksBack((n) => Math.max(0, n - 1))} aria-label="Next week">
              Later ›
            </button>
          </>
        ) : (
          <b className="num">
            {formatDate(from, { day: 'numeric', month: 'short' })} – {formatDate(to, { day: 'numeric', month: 'short' })}
          </b>
        )}
      </div>

      {mine.isLoading ? (
        <Spinner />
      ) : (
        <>
          <div className="grid-2" style={{ gap: 12 }}>
            {people.map((p) => {
              const total = p.report?.daily.reduce((n, d) => n + d.ms, 0) ?? 0;
              const best = p.report?.daily.reduce((b, d) => (d.ms > b.ms ? d : b), { date: '', ms: 0 });
              return (
                <div key={p.user.id} className="hours-summary" style={personVars(p.user.accent)}>
                  <div className="row" style={{ gap: 6 }}>
                    <Swatch hatched={p.hatched} />
                    <b>{p.name}</b>
                  </div>
                  <div className="num bold" style={{ fontSize: '1.5rem' }}>{fmt(total)}</div>
                  <div className="tiny muted num">
                    {fmt(Math.round(total / elapsed))} a day on average
                    {best?.ms ? ` · best ${formatDate(best.date, { weekday: 'short', day: 'numeric' })} (${fmt(best.ms)})` : ''}
                  </div>
                </div>
              );
            })}
          </div>

          <Legend people={people} />

          {period !== 'quarter' && <Bars title="By day" groups={dayGroups} people={people} labelEvery={period === 'week' ? 1 : 7} />}
          {period !== 'week' && <Bars title="By week" groups={weekGroups} people={people} labelEvery={period === 'quarter' ? 2 : 1} />}

          <div className="stack" style={{ gap: 8 }}>
            <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
              <h3>By topic</h3>
              {friend && (
                <div className="tabs" role="tablist" aria-label="Whose topics">
                  <button role="tab" aria-selected={topicsOf === 'me'} className={topicsOf === 'me' ? 'on' : ''} onClick={() => setTopicsOf('me')}>
                    You
                  </button>
                  <button role="tab" aria-selected={topicsOf === 'friend'} className={topicsOf === 'friend' ? 'on' : ''} onClick={() => setTopicsOf('friend')}>
                    {friend.displayName}
                  </button>
                </div>
              )}
            </div>
            <TopicBars person={topicPerson} />
          </div>

          <details>
            <summary className="small muted">View as table</summary>
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table className="hours-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    {people.map((p) => (
                      <th key={p.user.id}>{p.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dayGroups.map((g) => (
                    <tr key={g.key}>
                      <td>{g.title}</td>
                      {g.values.map((v, i) => (
                        <td key={i} className="num">
                          {v ? fmt(v) : '–'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function Swatch({ hatched }: { hatched: boolean }) {
  return <span className={`swatch-mark${hatched ? ' hatched' : ''}`} aria-hidden="true" />;
}

function Legend({ people }: { people: Person[] }) {
  if (people.length < 2) return null;
  return (
    <div className="legend">
      {people.map((p) => (
        <span key={p.user.id} style={personVars(p.user.accent)}>
          <Swatch hatched={p.hatched} /> {p.name}
        </span>
      ))}
    </div>
  );
}

/** Grouped columns: one column per person in each group. Hover or tap a group for exact values. */
function Bars({ title, groups, people, labelEvery }: { title: string; groups: { key: string; label: string; title: string; values: number[] }[]; people: Person[]; labelEvery: number }) {
  const max = Math.max(1, ...groups.flatMap((g) => g.values));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row between">
        <h3>{title}</h3>
        <span className="tiny muted num">top {fmt(max)}</span>
      </div>
      <div className="hbars" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }} role="img" aria-label={`${title}: focused time`}>
        {groups.map((g) => (
          <div key={g.key} className="hbars-group" tabIndex={0} data-tip={`${g.title}\n${people.map((p, i) => `${p.name}: ${fmt(g.values[i])}`).join('\n')}`}>
            {people.map((p, i) => (
              <i key={p.user.id} className={p.hatched ? 'hatched' : ''} style={{ ...personVars(p.user.accent), height: g.values[i] ? `${Math.max(2, (g.values[i] / max) * 100)}%` : 0 }} />
            ))}
          </div>
        ))}
      </div>
      <div className="hbars-labels" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}>
        {groups.map((g, i) => (
          <span key={g.key}>{i % labelEvery === 0 ? g.label : ''}</span>
        ))}
      </div>
    </div>
  );
}

function TopicBars({ person }: { person: Person }) {
  const [all, setAll] = useState(false);
  const topics = person.report?.topics ?? [];
  const other = person.report?.otherMs ?? 0;
  if (!person.report) return <Spinner />;
  if (!topics.length && !other) return <p className="small muted">No study time in this period.</p>;
  const max = Math.max(1, ...topics.map((t) => t.ms), other);
  const shown = all ? topics : topics.slice(0, 8);
  return (
    <div className="stack" style={{ gap: 10, ...personVars(person.user.accent) }}>
      {shown.map((t) => (
        <div key={`${t.topicId}:${t.roomId}`} className="topic-bar">
          <div className="row between" style={{ gap: 8 }}>
            <span className="small bold" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.title}
            </span>
            <span className="small num" style={{ flexShrink: 0 }}>
              {fmt(t.ms)} <span className="muted">· {t.sessions} {t.sessions === 1 ? 'session' : 'sessions'}</span>
            </span>
          </div>
          <div className="topic-bar-track">
            <i className={person.hatched ? 'hatched' : ''} style={{ width: `${Math.max(2, (t.ms / max) * 100)}%` }} />
          </div>
          <span className="tiny muted">{t.roomName}</span>
        </div>
      ))}
      {other > 0 && (
        <div className="row between small muted">
          <span>In rooms you don’t share</span>
          <span className="num">{fmt(other)}</span>
        </div>
      )}
      {topics.length > 8 && (
        <button className="btn ghost small" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${topics.length} topics`}
        </button>
      )}
    </div>
  );
}
