// "Yay!" after completing a topic: a watering can waters your room plant, it grows, and the whole screen
// slides up out of the way to show what's next. Tap anywhere (or press Escape) to skip.
import { useEffect, useState } from 'react';
import { endCelebration, useCelebration, type Cheer } from '../lib/celebrate';
import { personVars } from '../lib/theme';
import { TodayPlant } from './Garden';

const POUR_MS = 1300; // the can tips and water falls
const GROWN_MS = 3200; // the plant has grown; time to go
const SLIDE_MS = 600;

export function CelebrationHost() {
  const cheer = useCelebration();
  // A new key per celebration restarts the animation even for two completions in a row.
  return cheer ? <Celebration key={`${cheer.topicTitle}:${cheer.after}`} cheer={cheer} /> : null;
}

function Celebration({ cheer }: { cheer: Cheer }) {
  const calm = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [percent, setPercent] = useState(calm ? cheer.after : cheer.before);
  const [phase, setPhase] = useState<'in' | 'leaving'>('in');

  useEffect(() => {
    const leave = () => {
      setPhase('leaving');
      timers.push(setTimeout(endCelebration, SLIDE_MS));
    };
    const timers = [setTimeout(() => setPercent(cheer.after), calm ? 0 : POUR_MS), setTimeout(leave, calm ? 1600 : GROWN_MS)];
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && leave();
    window.addEventListener('keydown', onKey);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', onKey);
    };
  }, [cheer, calm]);

  const skip = () => {
    if (phase === 'leaving') return;
    setPercent(cheer.after);
    setPhase('leaving');
    setTimeout(endCelebration, SLIDE_MS);
  };

  return (
    <div className={`celebrate${phase === 'leaving' ? ' leaving' : ''}${calm ? ' calm' : ''}`} style={personVars(cheer.accent)} onClick={skip} role="dialog" aria-label="Topic complete">
      <div className="confetti" aria-hidden="true">
        {Array.from({ length: 18 }, (_, i) => (
          <i key={i} style={{ left: `${(i * 53) % 100}%`, animationDelay: `${(i % 6) * 0.18}s`, rotate: `${i * 37}deg` }} className={`c${i % 4}`} />
        ))}
      </div>
      <div className="celebrate-body">
        <h1 className="yay">Yay!</h1>
        <p className="celebrate-topic">
          “{cheer.topicTitle}” is done <span aria-hidden="true">🌼</span>
        </p>
        <div className="celebrate-stage">
          <WateringCan />
          <TodayPlant percent={percent} size={240} color="var(--c)" />
        </div>
        <p className="small">{cheer.caption}</p>
        <p className="tiny muted">Tap anywhere to continue</p>
      </div>
    </div>
  );
}

function WateringCan() {
  return (
    <div className="watering" aria-hidden="true">
      <svg className="can" viewBox="0 0 120 80" width="120" height="80">
        <path d="M30 28h46a6 6 0 0 1 6 6v30a8 8 0 0 1-8 8H38a8 8 0 0 1-8-8Z" fill="#8FB8E8" />
        <path d="M30 34c-10 0-16 6-16 14s6 12 14 12" stroke="#6E9AD6" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path d="M82 40 110 22" stroke="#8FB8E8" strokeWidth="7" strokeLinecap="round" />
        <rect x="104" y="14" width="12" height="9" rx="3" fill="#6E9AD6" transform="rotate(-33 110 18)" />
        <path d="M40 28c4-10 24-10 28 0" stroke="#6E9AD6" strokeWidth="4" fill="none" />
        <circle cx="46" cy="46" r="3" fill="#fff" opacity=".7" />
      </svg>
      <span className="drops">
        {Array.from({ length: 7 }, (_, i) => (
          <i key={i} style={{ left: `${i * 7}px`, animationDelay: `${0.45 + (i % 4) * 0.12}s` }} />
        ))}
      </span>
    </div>
  );
}
