// A little potted plant that grows with progress (0–100). Purely decorative.
interface Props {
  percent: number;
  size?: number;
  color?: string;
}

export function Plant({ percent, size = 64, color = '#D98EAE' }: Props) {
  const stage = percent >= 100 ? 4 : percent >= 66 ? 3 : percent >= 33 ? 2 : percent > 0 ? 1 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      {/* pot */}
      <path d="M20 44h24l-3 14H23Z" fill="#C9A68C" />
      <rect x="18" y="41" width="28" height="5" rx="2" fill="#B99379" />
      {/* soil */}
      <ellipse cx="32" cy="42" rx="12" ry="1.8" fill="#6E5848" />
      {stage === 0 && <ellipse cx="32" cy="40" rx="2.4" ry="1.6" fill="#8E7A5E" />}
      {stage >= 1 && <path d={`M32 41V${stage === 1 ? 34 : stage === 2 ? 26 : 18}`} stroke="#6E9B68" strokeWidth="2.4" strokeLinecap="round" />}
      {stage >= 1 && <path d="M32 36c-5 0-7-3-7-6 4 0 7 2 7 6Z" fill="#8DB487" />}
      {stage >= 2 && <path d="M32 31c5 0 7.5-3 7.5-6.5-4.5 0-7.5 2.5-7.5 6.5Z" fill="#7FA67A" />}
      {stage >= 3 && <path d="M32 24c-4.5 0-6.5-2.8-6.5-5.8 4 0 6.5 2 6.5 5.8Z" fill="#A6C89F" />}
      {stage === 3 && <circle cx="32" cy="16.5" r="2.6" fill={color} opacity="0.7" />}
      {stage === 4 && (
        <g>
          {[0, 72, 144, 216, 288].map((r) => (
            <ellipse key={r} cx="32" cy="11" rx="3" ry="4.5" fill={color} transform={`rotate(${r} 32 15.5)`} />
          ))}
          <circle cx="32" cy="15.5" r="2.6" fill="#F3D27A" />
        </g>
      )}
    </svg>
  );
}

/** Simple empty-state illustration: two sprouts side by side. */
export function TwoSprouts() {
  return (
    <svg viewBox="0 0 160 100" aria-hidden="true">
      <ellipse cx="80" cy="88" rx="70" ry="8" fill="var(--sage)" />
      <path d="M58 86V60" stroke="#6E9B68" strokeWidth="3" strokeLinecap="round" />
      <path d="M58 66c-9 0-13-6-13-12 8 0 13 4 13 12Z" fill="var(--blue)" opacity="0.85" />
      <path d="M58 62c8 0 12-5 12-11-7 0-12 4-12 11Z" fill="#8DB487" />
      <path d="M102 86V54" stroke="#6E9B68" strokeWidth="3" strokeLinecap="round" />
      <path d="M102 60c9 0 13-6 13-12-8 0-13 4-13 12Z" fill="var(--pink)" opacity="0.85" />
      <path d="M102 58c-8 0-12-5-12-11 7 0 12 4 12 11Z" fill="#8DB487" />
      <path d="M78 36l2-5 2 5 5 2-5 2-2 5-2-5-5-2Z" fill="#F3D27A" />
    </svg>
  );
}
