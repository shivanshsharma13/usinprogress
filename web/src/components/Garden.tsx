// Today's plant and the forest. The plant grows heart-shaped leaves as today's tasks get done, and its
// face follows your day: sleepy before you start, smiling as you go, overjoyed (with a flower) when all
// of today is finished. Each day you finish everything plants a tree in the forest.
import { useId } from 'react';

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const GROW = 'transform 1.1s cubic-bezier(.3,1.4,.5,1), opacity .6s ease';

/** A heart, point at (0,0), lobes upward. Used for leaves, petals and floating hearts. */
const HEART = 'M0 0C-2-4-11-6-11-12.5C-11-18-4.5-19.5 0-14.5C4.5-19.5 11-18 11-12.5C11-6 2-4 0 0Z';

type Mood = 'sleepy' | 'calm' | 'happy' | 'joy';

/** Today's plant. `percent` is the share of today's tasks done; `color` is the person's accent. */
export function TodayPlant({ percent, size = 220, color = 'var(--c)' }: { percent: number; size?: number; color?: string }) {
  const id = useId().replace(/:/g, '');
  const g = clamp(percent / 100);
  const full = percent >= 100;
  const mood: Mood = g === 0 ? 'sleepy' : full ? 'joy' : g >= 0.5 ? 'happy' : 'calm';
  const stem = 16 + 88 * g; // stem height above the soil
  const top = 132 - stem;
  const spots = [0.16, 0.3, 0.43, 0.56, 0.68, 0.8, 0.9];
  const leaves = g === 0 ? 0 : Math.max(2, Math.ceil(g * spots.length));
  const leafSize = 1.15 + 0.6 * g;
  const label = { sleepy: 'A sleepy little plant waiting for today’s first task', calm: 'A little plant starting to grow', happy: 'A happy plant, more than halfway there', joy: 'A delighted plant in full bloom' }[mood];

  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={`${label} (${Math.round(percent)}% of today done)`}>
      <defs>
        <radialGradient id={`${id}glow`} cx="50%" cy="48%" r="55%">
          <stop offset="0%" stopColor={color} stopOpacity={full ? 0.4 : 0.18} />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}leaf`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#B5E3A6" />
          <stop offset="100%" stopColor="#62AE66" />
        </linearGradient>
        <linearGradient id={`${id}pot`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFD9C4" />
          <stop offset="100%" stopColor="#F4B89C" />
        </linearGradient>
      </defs>

      <circle cx="100" cy="104" r="94" fill={`url(#${id}glow)`} />

      {/* the plant: stem, heart leaves and the bud or flower on top, swaying gently */}
      <g className="plant-sway">
        <g style={{ transformOrigin: '100px 132px', transformBox: 'view-box', transform: `scaleY(${stem / 104})`, transition: GROW }}>
          <path d="M100 132C95 112 105 88 100 28" stroke="#5E9F5E" strokeWidth="4.5" fill="none" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </g>
        {spots.map((f, i) => {
          const side = i % 2 ? 1 : -1;
          const shown = i < leaves;
          return (
            <g key={i} style={{ transform: `translate(${100 + side * 1.5}px, ${132 - stem * f}px) rotate(${side * (64 - i * 5)}deg) scale(${shown ? leafSize * (1 - i * 0.06) : 0})`, opacity: shown ? 1 : 0, transition: GROW }}>
              <g className="leaf-flutter" style={{ animationDelay: `${i * -0.7}s` }}>
                <path d={HEART} fill={`url(#${id}leaf)`} />
                <path d="M0-1C0-5 0-9 0-13" stroke="#E6F6DE" strokeWidth="1.2" strokeLinecap="round" opacity=".8" />
              </g>
            </g>
          );
        })}
        {/* a bud from halfway, a flower when today is done */}
        <g style={{ transform: `translate(100px, ${top + 2}px) scale(${g >= 0.5 ? 1 : 0})`, opacity: g >= 0.5 ? 1 : 0, transition: GROW }}>
          {full ? (
            <g className="flower-pop">
              {[0, 60, 120, 180, 240, 300].map((r) => (
                <path key={r} d={HEART} fill={color} transform={`rotate(${r} 0 -12) translate(0 -12) scale(.8)`} />
              ))}
              <circle cx="0" cy="-12" r="7" fill="#FBD978" />
              <circle cx="-2.4" cy="-13" r="0.9" fill="#3B2F2F" />
              <circle cx="2.4" cy="-13" r="0.9" fill="#3B2F2F" />
              <path d="M-1.8-10.6q1.8 1.6 3.6 0" stroke="#3B2F2F" strokeWidth=".8" fill="none" strokeLinecap="round" />
            </g>
          ) : (
            <g>
              <path d="M0 0C-7-4-7-15 0-20C7-15 7-4 0 0Z" fill={color} />
              <path d="M0 0C-5-1-8-5-8-9 -4-8-1-5 0 0ZM0 0C5-1 8-5 8-9 4-8 1-5 0 0Z" fill="#62AE66" />
            </g>
          )}
        </g>
      </g>

      {/* pot with a face */}
      <ellipse cx="100" cy="134" rx="36" ry="5" fill="#7A5A44" />
      <path d="M64 140H136L130 182Q129 190 121 190H79Q71 190 70 182Z" fill={`url(#${id}pot)`} />
      <rect x="58" y="127" width="84" height="15" rx="7.5" fill="#F2AE8E" />
      <rect x="62" y="129" width="40" height="3" rx="1.5" fill="#fff" opacity=".35" />
      <Face mood={mood} />

      {g === 0 && (
        <g fill="#8C7BA8" fontWeight="800" fontFamily="inherit">
          <text className="float-up" x="128" y="118" fontSize="11">z</text>
          <text className="float-up" x="138" y="106" fontSize="9" style={{ animationDelay: '-1s' }}>z</text>
          <text className="float-up" x="146" y="96" fontSize="7" style={{ animationDelay: '-2s' }}>z</text>
        </g>
      )}
      {full && (
        <>
          <g fill={color}>
            {[
              [40, 108, 0.45, 0],
              [158, 96, 0.38, -1.2],
              [150, 128, 0.32, -2.2],
              [52, 74, 0.3, -0.6],
            ].map(([x, y, s, d], i) => (
              <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
                <path className="float-up" d={HEART} style={{ animationDelay: `${d}s` }} />
              </g>
            ))}
          </g>
          <g className="twinkle" fill="#F6D57A">
            <path d="M30 48l2-6 2 6 6 2-6 2-2 6-2-6-6-2Z" />
            <path d="M166 54l1.6-4.5 1.6 4.5 4.5 1.6-4.5 1.6-1.6 4.5-1.6-4.5-4.5-1.6Z" />
            <path d="M172 152l1.3-3.6 1.3 3.6 3.6 1.3-3.6 1.3-1.3 3.6-1.3-3.6-3.6-1.3Z" />
          </g>
        </>
      )}
    </svg>
  );
}

function Face({ mood }: { mood: Mood }) {
  const ink = '#4A3535';
  return (
    <g>
      <ellipse cx="80" cy="167" rx="6" ry="3.6" fill="#F49BB0" opacity={mood === 'joy' ? 0.95 : 0.65} />
      <ellipse cx="120" cy="167" rx="6" ry="3.6" fill="#F49BB0" opacity={mood === 'joy' ? 0.95 : 0.65} />
      {mood === 'sleepy' && (
        <g stroke={ink} strokeWidth="2.2" fill="none" strokeLinecap="round">
          <path d="M83 158q5 4 10 0M107 158q5 4 10 0" />
          <ellipse cx="100" cy="170" rx="2.2" ry="1.8" fill={ink} stroke="none" />
        </g>
      )}
      {(mood === 'calm' || mood === 'happy') && (
        <g>
          <g className="blink">
            <ellipse cx="88" cy="158" rx="3.4" ry="4" fill={ink} />
            <ellipse cx="112" cy="158" rx="3.4" ry="4" fill={ink} />
            <circle cx="89.3" cy="156.4" r="1.2" fill="#fff" />
            <circle cx="113.3" cy="156.4" r="1.2" fill="#fff" />
          </g>
          <path d={mood === 'calm' ? 'M95 167q5 4 10 0' : 'M92 166q8 7 16 0'} stroke={ink} strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </g>
      )}
      {mood === 'joy' && (
        <g>
          <path d="M83 160q5-7 10 0M107 160q5-7 10 0" stroke={ink} strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <path d="M91 165q9 12 18 0Z" fill={ink} />
          <path d="M96 170q4 3 8 0q-4-2-8 0Z" fill="#F07D93" />
        </g>
      )}
    </g>
  );
}

/** A little seeded random, so the same forest always looks the same. */
function seeded(n: number) {
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

const MAX_TREES = 48;

/** One tree per finished day, gently moving, under drifting clouds. */
export function Forest({ count, color = 'var(--c)' }: { count: number; color?: string }) {
  const id = useId().replace(/:/g, '');
  const shown = Math.min(count, MAX_TREES);
  const trees = Array.from({ length: shown }, (_, i) => {
    const row = i % 3; // 0 = back, 2 = front
    const kind = seeded(i + 1) < 0.34 ? 'pine' : seeded(i + 7) < 0.3 ? 'blossom' : 'round';
    return { i, kind, row, x: 16 + seeded(i + 3) * 288, y: 78 + row * 9, s: 0.95 + row * 0.18 + seeded(i + 5) * 0.15, delay: -seeded(i + 11) * 5, newest: i === shown - 1 };
  }).sort((a, b) => a.y - b.y);

  return (
    <svg viewBox="0 0 320 112" width="100%" role="img" aria-label={`${count} ${count === 1 ? 'tree' : 'trees'} in the forest`} style={{ display: 'block', overflow: 'hidden' }}>
      <defs>
        <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#CFE7F7" />
          <stop offset="100%" stopColor="#EEF7EA" />
        </linearGradient>
      </defs>
      <rect width="320" height="112" rx="10" fill={`url(#${id}sky)`} />
      {/* sky life */}
      <g fill="#fff" opacity=".9">
        <g className="cloud" style={{ animationDelay: '-12s' }}>
          <ellipse cx="0" cy="22" rx="16" ry="6" />
          <ellipse cx="9" cy="18" rx="10" ry="7" />
          <ellipse cx="-8" cy="19" rx="8" ry="5" />
        </g>
        <g className="cloud slow" style={{ animationDelay: '-48s' }}>
          <ellipse cx="0" cy="38" rx="12" ry="4.5" />
          <ellipse cx="6" cy="35" rx="8" ry="5" />
        </g>
      </g>
      <g stroke="#6B7A8C" strokeWidth="1.2" fill="none" strokeLinecap="round">
        <g className="bird" style={{ animationDelay: '-4s' }}>
          <path className="wing" d="M0 16q3-3 6 0q3-3 6 0" />
        </g>
        <g className="bird" style={{ animationDelay: '-13s' }}>
          <path className="wing" d="M0 30q2.4-2.4 4.8 0q2.4-2.4 4.8 0" />
        </g>
      </g>

      <path d="M0 76 Q80 66 160 74 T320 70 L320 112 L0 112Z" fill="#B9D9A2" />
      <path d="M0 92 Q90 84 180 91 T320 88 L320 112 L0 112Z" fill="#9CC787" />

      {trees.map((t) => (
        <g key={t.i} transform={`translate(${t.x} ${t.y}) scale(${t.s})`} opacity={0.78 + t.row * 0.11}>
          <g className="forest-sway" style={{ animationDelay: `${t.delay}s` }}>
            <rect x="-1.6" y="-10" width="3.2" height="12" rx="1.2" fill="#8B6B4E" />
            {t.kind === 'pine' ? (
              <g>
                <path d="M0 -38 L-10 -20 L10 -20Z" fill="#4F8A5A" />
                <path d="M0 -30 L-12 -12 L12 -12Z" fill="#5E9A66" />
                <path d="M0 -22 L-13 -6 L13 -6Z" fill="#6AA971" />
              </g>
            ) : (
              <g>
                <circle cx="-6" cy="-16" r="8" fill="#5E9F62" />
                <circle cx="6" cy="-16" r="8" fill="#6AA56B" />
                <circle cx="0" cy="-23" r="10" fill="#86C281" />
                {t.kind === 'blossom' && (
                  <g fill={color}>
                    <circle cx="-6" cy="-25" r="1.8" />
                    <circle cx="5" cy="-28" r="1.8" />
                    <circle cx="8" cy="-16" r="1.8" />
                    <circle cx="-9" cy="-14" r="1.8" />
                  </g>
                )}
                {/* a tiny face */}
                <circle cx="-3" cy="-19" r="1" fill="#2F4A33" />
                <circle cx="3" cy="-19" r="1" fill="#2F4A33" />
                <path d="M-1.8 -16.4q1.8 1.5 3.6 0" stroke="#2F4A33" strokeWidth=".8" fill="none" strokeLinecap="round" />
                <circle cx="-5" cy="-16.6" r="1.2" fill="#F49BB0" opacity=".6" />
                <circle cx="5" cy="-16.6" r="1.2" fill="#F49BB0" opacity=".6" />
              </g>
            )}
          </g>
          {t.newest && <path className="twinkle-one" d="M12 -34l1.2-3.4 1.2 3.4 3.4 1.2-3.4 1.2-1.2 3.4-1.2-3.4-3.4-1.2Z" fill="#F6D57A" />}
        </g>
      ))}
      {count > MAX_TREES && (
        <text x="312" y="108" textAnchor="end" fontSize="10" fontWeight="700" fill="#4F7A45">
          +{count - MAX_TREES}
        </text>
      )}
      {count === 0 && (
        <g transform="translate(160 80)">
          <g className="forest-sway">
            <ellipse cx="0" cy="2" rx="7" ry="2.5" fill="#8C6E52" />
            <path d="M0 0v-9" stroke="#6E9B68" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M0 -7C-1-9-6-10-6-13C-6-15.5-3-16 0-14C3-16 6-15.5 6-13C6-10 1-9 0-7Z" fill="#8DC487" transform="rotate(-30 0 -7)" />
          </g>
        </g>
      )}
    </svg>
  );
}
