// Weekly challenge with a friend (Settings → Motivation & focus), on Home. Both of you reaching the target
// by Sunday wins it, and a golden sunflower blooms in the forest of every room you share.
import { useState } from 'react';
import { addDays, formatDate, startOfWeek, weekday } from '@shared/dates';
import type { Challenge, PublicUser } from '@shared/types';
import { usePref } from '../lib/prefs';
import { useAction, useChallenge } from '../lib/queries';
import { api } from '../lib/api';
import { personVars } from '../lib/theme';
import { fmt, Menu, ProgressBar } from './ui';

const HOURS = [5, 10, 15, 20];
const DAYS = [3, 5, 7];

export function ChallengeCard({ me, friend, today }: { me: PublicUser; friend: PublicUser | undefined; today: string }) {
  const [on] = usePref('challenge');
  const week = startOfWeek(today);
  const { data } = useChallenge(on, friend?.id, week);
  const [editing, setEditing] = useState(false);
  if (!on || !friend || !data) return null;
  const c = data.challenge;
  const daysLeft = 7 - weekday(today); // including today

  return (
    <div className="card challenge-card stack">
      <div className="row between top">
        <div>
          <span className="section-label">Weekly challenge · ends {formatDate(addDays(week, 6), { weekday: 'long' })}</span>
          <h2>{c && !editing ? title(c) : `A challenge with ${friend.displayName}`}</h2>
        </div>
        {data.wins > 0 && (
          <span className="chip sunflower" title="Challenges won together">
            🌻 {data.wins}
          </span>
        )}
      </div>
      {c && !editing ? (
        <Progress c={c} me={me} friend={friend} daysLeft={daysLeft} onChange={() => setEditing(true)} />
      ) : (
        <Picker friend={friend} week={week} onDone={() => setEditing(false)} onCancel={c ? () => setEditing(false) : undefined} />
      )}
    </div>
  );
}

const title = (c: Challenge) => (c.kind === 'hours' ? `${c.target} hours each` : `Everything planned, ${c.target} ${c.target === 1 ? 'day' : 'days'} each`);

function Progress({ c, me, friend, daysLeft, onChange }: { c: Challenge; me: PublicUser; friend: PublicUser; daysLeft: number; onChange: () => void }) {
  const cancel = useAction(() => api.post(`/challenge/${c.id}/cancel`), { invalidate: [['challenge']] });
  const goal = c.kind === 'hours' ? c.target * 3_600_000 : c.target;
  const show = (v: number) => (c.kind === 'hours' ? `${fmt(v)} of ${c.target}h` : `${v} of ${c.target} days`);
  const people = [me, friend];
  const done = people.filter((p) => (c.progress[p.id] ?? 0) >= goal).length;

  return (
    <>
      <div className="stack" style={{ gap: 10 }}>
        {people.map((p) => {
          const v = c.progress[p.id] ?? 0;
          return (
            <div key={p.id} className="stack" style={{ gap: 4, ...personVars(p.accent) }}>
              <div className="row between small">
                <b>{p.id === me.id ? 'You' : p.displayName}</b>
                <span className="num muted">
                  {show(v)} {v >= goal && '✓'}
                </span>
              </div>
              <ProgressBar value={Math.min(v, goal)} max={goal} accent={p.accent} label={`${p.displayName}: ${show(v)}`} />
            </div>
          );
        })}
      </div>
      <div className="row between">
        <p className="small" style={{ margin: 0 }}>
          {c.wonAt
            ? 'You did it together! A golden sunflower now blooms in your shared forest. 🌻'
            : done === 1
              ? `One of you is there. ${daysLeft === 1 ? 'Last day' : `${daysLeft} days left`} for the other — cheer them on.`
              : `${daysLeft === 1 ? 'Last day!' : `${daysLeft} days left.`} ${c.kind === 'days' ? 'Finish everything planned for a day to count it.' : 'Every focused minute counts.'}`}
        </p>
        {!c.wonAt && (
          <Menu
            label="Challenge options"
            items={[
              { label: 'Change the challenge', onClick: onChange },
              { label: 'Call it off', danger: true, onClick: () => confirm('Call off this week’s challenge?') && cancel.mutate(undefined) },
            ]}
          />
        )}
      </div>
    </>
  );
}

function Picker({ friend, week, onDone, onCancel }: { friend: PublicUser; week: string; onDone: () => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<'hours' | 'days'>('hours');
  const [target, setTarget] = useState(10);
  const start = useAction(() => api.post('/challenge', { friendId: friend.id, week, kind, target }), {
    invalidate: [['challenge'], ['activity']],
    success: `Challenge set — ${friend.displayName} can see it too 🎯`,
    onSuccess: onDone,
  });
  const options = kind === 'hours' ? HOURS : DAYS;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="small muted" style={{ margin: 0 }}>
        Pick a goal you both chase until Sunday. Win it together and a golden sunflower blooms in your forest.
      </p>
      <div className="tabs" role="tablist" aria-label="Kind of challenge" style={{ alignSelf: 'flex-start' }}>
        {(['hours', 'days'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            className={kind === k ? 'on' : ''}
            onClick={() => {
              setKind(k);
              setTarget(k === 'hours' ? 10 : 5);
            }}
          >
            {k === 'hours' ? 'Hours each' : 'Full days each'}
          </button>
        ))}
      </div>
      <div className="row wrap">
        {options.map((n) => (
          <button key={n} className={`chip-btn${target === n ? ' on' : ''}`} aria-pressed={target === n} onClick={() => setTarget(n)}>
            {kind === 'hours' ? `${n} hours` : `${n} ${n === 1 ? 'day' : 'days'}`}
          </button>
        ))}
      </div>
      <div className="row">
        <button className="btn primary" disabled={start.isPending} onClick={() => start.mutate(undefined)}>
          Start the challenge
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel}>
            Keep the current one
          </button>
        )}
      </div>
    </div>
  );
}
