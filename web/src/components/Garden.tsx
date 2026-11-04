// Today's tree and the forest. The tree grows as today's tasks get done (seed → sprout → sapling →
// tree) and blossoms when all of today is finished. Each day you finish everything plants a tree in the
// forest, so the forest is the record of days you kept your plan.
import { useId } from 'react';

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const GROW = 'transform 1.2s cubic-bezier(.2,.8,.2,1), opacity .8s ease';

/** Today's tree. `percent` is the share of today's tasks done; `color` is the person's accent. */
export function GrowingTree({ percent, size = 220, color = 'var(--c)' }: { percent: number; size?: number; color?: string }) {
  const id = useId().replace(/:/g, '');
  const g = clamp(percent / 100);
  const full = percent >= 100;
  const trunkY = 0.14 + 0.86 * g; // trunk height share
  const trunkX = 0.4 + 0.6 * g;
  const canopy = g < 0.3 ? 0 : 0.35 + 0.65 * ((g - 0.3) / 0.7);
  const rise = 100 * (1 - trunkY); // how far below its full height the top of the trunk is

  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={full ? 'A tree in full bloom' : g === 0 ? 'A seed waiting to sprout' : `A tree, ${Math.round(percent)}% grown today`}>
      <defs>
        <radialGradient id={`${id}glow`} cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor={color} stopOpacity={full ? 0.35 : 0.16} />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}leaf`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9FD19A" />
          <stop offset="100%" stopColor="#5E9F62" />
        </linearGradient>
        <linearGradient id={`${id}hill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#A9CF8F" />
          <stop offset="100%" stopColor="#7FAE6B" />
        </linearGradient>
      </defs>

      <circle cx="100" cy="98" r="96" fill={`url(#${id}glow)`} style={{ transition: 'opacity 1s' }} />

      {/* hill */}
      <path d="M8 176 Q100 150 192 176 L192 200 L8 200Z" fill={`url(#${id}hill)`} />
      <path d="M40 170l3-7 3 7M150 168l3-6 3 6M70 174l2-5 2 5M128 173l2-5 2 5" stroke="#6E9B5E" strokeWidth="2" fill="none" strokeLinecap="round" />

      {g === 0 ? (
        <g className="tree-sway">
          <ellipse cx="100" cy="167" rx="18" ry="5.5" fill="#8C6E52" />
          <ellipse cx="100" cy="161" rx="7" ry="5" fill="#B38B62" />
          <path d="M100 157c0-5 2-8 5-10" stroke="#6E9B68" strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M105 147c4-3 9-2 10 1-4 2-8 2-10-1Z" fill="#8DC487" />
        </g>
      ) : (
        <g className="tree-sway">
          {/* trunk and branches, drawn full size and scaled to today's growth */}
          <g style={{ transformOrigin: '100px 168px', transformBox: 'view-box', transform: `scale(${trunkX}, ${trunkY})`, transition: GROW }}>
            <path d="M93 168 C95 130 96 100 98 68 L102 68 C104 100 105 130 107 168Z" fill="#8B6B4E" />
            <path d="M99 120 C88 110 80 100 74 88" stroke="#8B6B4E" strokeWidth="4" fill="none" strokeLinecap="round" style={{ opacity: g > 0.45 ? 1 : 0, transition: GROW }} />
            <path d="M101 108 C112 98 120 90 126 80" stroke="#8B6B4E" strokeWidth="4" fill="none" strokeLinecap="round" style={{ opacity: g > 0.55 ? 1 : 0, transition: GROW }} />
          </g>

          {/* first leaves, before there is a canopy */}
          <g style={{ transformOrigin: '100px 68px', transformBox: 'view-box', transform: `translateY(${rise}px) scale(${g < 0.3 ? 0.6 + g * 1.4 : 0.4})`, opacity: g < 0.3 ? 1 : 0, transition: GROW }}>
            <path d="M100 70c-14 0-20-9-20-17 12 0 20 6 20 17Z" fill="#8DC487" />
            <path d="M100 70c14 0 20-9 20-17-12 0-20 6-20 17Z" fill="#76B271" />
          </g>

          {/* canopy */}
          <g style={{ transformOrigin: '100px 72px', transformBox: 'view-box', transform: `translateY(${rise}px) scale(${canopy})`, opacity: canopy ? 1 : 0, transition: GROW }}>
            <circle cx="70" cy="82" r="28" fill="#5E9F62" />
            <circle cx="130" cy="82" r="28" fill="#5E9F62" />
            <circle cx="100" cy="72" r="40" fill={`url(#${id}leaf)`} />
            <circle cx="78" cy="56" r="24" fill="#8CC987" />
            <circle cx="124" cy="58" r="22" fill="#7DBB78" />
            <circle cx="96" cy="44" r="20" fill="#A6D8A0" />
            <ellipse cx="88" cy="40" rx="9" ry="5" fill="#fff" opacity="0.25" />

            {/* blossoms once today is complete */}
            <g style={{ transformOrigin: '100px 64px', transformBox: 'view-box', transform: `scale(${full ? 1 : 0.6})`, opacity: full ? 1 : 0, transition: 'transform .9s cubic-bezier(.3,1.6,.5,1) .3s, opacity .6s ease .3s' }}>
              {[
                [72, 60],
                [96, 40],
                [124, 52],
                [110, 84],
                [82, 92],
                [138, 80],
                [60, 80],
                [100, 66],
              ].map(([x, y], i) => (
                <g key={i} transform={`translate(${x} ${y}) rotate(${i * 23})`}>
                  {[0, 72, 144, 216, 288].map((r) => (
                    <ellipse key={r} cx="0" cy="-4.2" rx="3" ry="4.4" fill={color} transform={`rotate(${r})`} />
                  ))}
                  <circle r="2.3" fill="#F6D57A" />
                </g>
              ))}
            </g>
          </g>
        </g>
      )}

      {full && (
        <g className="twinkle" fill="#F6D57A">
          <path d="M34 54l2-6 2 6 6 2-6 2-2 6-2-6-6-2Z" />
          <path d="M164 40l1.6-4.5 1.6 4.5 4.5 1.6-4.5 1.6-1.6 4.5-1.6-4.5-4.5-1.6Z" />
          <path d="M160 112l1.3-3.6 1.3 3.6 3.6 1.3-3.6 1.3-1.3 3.6-1.3-3.6-3.6-1.3Z" />
        </g>
      )}
    </svg>
  );
}

/** A little seeded random, so the same forest always looks the same. */
function seeded(n: number) {
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

const MAX_TREES = 48;

/** One tree per finished day. */
export function Forest({ count, color = 'var(--c)' }: { count: number; color?: string }) {
  const shown = Math.min(count, MAX_TREES);
  const trees = Array.from({ length: shown }, (_, i) => {
    const row = i % 3; // 0 = back, 2 = front
    const kind = seeded(i + 1) < 0.34 ? 'pine' : seeded(i + 7) < 0.3 ? 'blossom' : 'round';
    return { i, kind, row, x: 16 + seeded(i + 3) * 288, y: 66 + row * 9, s: 0.95 + row * 0.18 + seeded(i + 5) * 0.15 };
  }).sort((a, b) => a.y - b.y);

  return (
    <svg viewBox="0 0 320 96" width="100%" role="img" aria-label={`${count} ${count === 1 ? 'tree' : 'trees'} in the forest`} style={{ display: 'block' }}>
      <path d="M0 66 Q80 56 160 64 T320 60 L320 96 L0 96Z" fill="#B9D9A2" />
      <path d="M0 80 Q90 72 180 79 T320 76 L320 96 L0 96Z" fill="#9CC787" />
      {trees.map((t) => (
        <g key={t.i} transform={`translate(${t.x} ${t.y}) scale(${t.s})`} opacity={0.75 + t.row * 0.12}>
          <rect x="-1.6" y="-10" width="3.2" height="12" rx="1.2" fill="#8B6B4E" />
          {t.kind === 'pine' ? (
            <g fill="#4F8A5A">
              <path d="M0 -38 L-10 -20 L10 -20Z" />
              <path d="M0 -30 L-12 -12 L12 -12Z" fill="#5E9A66" />
              <path d="M0 -22 L-13 -6 L13 -6Z" fill="#6AA971" />
            </g>
          ) : (
            <g>
              <circle cx="-6" cy="-16" r="8" fill="#5E9F62" />
              <circle cx="6" cy="-16" r="8" fill="#6AA56B" />
              <circle cx="0" cy="-24" r="10" fill="#86C281" />
              {t.kind === 'blossom' && (
                <g fill={color}>
                  <circle cx="-5" cy="-24" r="2" />
                  <circle cx="4" cy="-28" r="2" />
                  <circle cx="6" cy="-18" r="2" />
                  <circle cx="-7" cy="-15" r="2" />
                </g>
              )}
            </g>
          )}
        </g>
      ))}
      {count > MAX_TREES && (
        <text x="312" y="92" textAnchor="end" fontSize="10" fontWeight="700" fill="#4F7A45">
          +{count - MAX_TREES}
        </text>
      )}
      {count === 0 && (
        <g transform="translate(160 70)">
          <ellipse cx="0" cy="2" rx="7" ry="2.5" fill="#8C6E52" />
          <path d="M0 0v-8" stroke="#6E9B68" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M0 -6c-4 0-6-2-6-5 3 0 6 2 6 5Z" fill="#8DC487" />
        </g>
      )}
    </svg>
  );
}
