// Original study-buddy mascot: a round seedling-sprite with a leaf tuft.
// Colour follows the person's identity accent; a small accessory hints at their interests.
import type { AvatarConfig } from '@shared/theme';
import { accentVar } from '../lib/theme';

interface Props {
  accent: string;
  avatar?: AvatarConfig;
  size?: number;
  title?: string;
}

export function Buddy({ accent, avatar = {}, size = 48, title }: Props) {
  const accessory = avatar.accessory ?? 'none';
  const mood = avatar.mood ?? 'happy';
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title ?? 'Study buddy'}>
      {/* leaf tuft */}
      <path d="M32 14c0-6 3-9 8-10-0.5 5-3 8.5-8 10Z" fill="#8DB487" />
      <path d="M32 14c-1-5-4-7.5-8.5-8 1 4.5 3.5 7 8.5 8Z" fill="#A6C89F" />
      {/* body */}
      <ellipse cx="32" cy="38" rx="21" ry="20" style={{ fill: accentVar(accent) }} />
      <ellipse cx="32" cy="44" rx="13" ry="10" fill="#fff" opacity="0.22" />
      {/* cheeks */}
      <circle cx="19.5" cy="41" r="3.2" fill="#fff" opacity="0.35" />
      <circle cx="44.5" cy="41" r="3.2" fill="#fff" opacity="0.35" />
      {/* eyes */}
      {mood === 'sleepy' ? (
        <g stroke="#2C3430" strokeWidth="2.2" strokeLinecap="round" fill="none">
          <path d="M22.5 35.5q3 2 6 0" />
          <path d="M35.5 35.5q3 2 6 0" />
        </g>
      ) : (
        <g fill="#2C3430">
          <ellipse cx="25.5" cy="35" rx="2.6" ry={mood === 'calm' ? 2 : 3} />
          <ellipse cx="38.5" cy="35" rx="2.6" ry={mood === 'calm' ? 2 : 3} />
          <circle cx="26.3" cy="34" r="0.9" fill="#fff" />
          <circle cx="39.3" cy="34" r="0.9" fill="#fff" />
        </g>
      )}
      {/* mouth */}
      <path d={mood === 'calm' ? 'M29 42h6' : 'M28.5 41.5q3.5 3.5 7 0'} stroke="#2C3430" strokeWidth="2" strokeLinecap="round" fill="none" />
      {accessory === 'glasses' && (
        <g stroke="#2C3430" strokeWidth="1.8" fill="none">
          <circle cx="25.5" cy="35" r="5.2" />
          <circle cx="38.5" cy="35" r="5.2" />
          <path d="M30.7 35h2.6" />
        </g>
      )}
      {accessory === 'stethoscope' && (
        <g stroke="#3C4A44" strokeWidth="2" fill="none" strokeLinecap="round">
          <path d="M22 48q2 8 10 8t10-8" />
          <circle cx="42" cy="47" r="2.6" fill="#E8EDE9" />
        </g>
      )}
      {accessory === 'headphones' && (
        <g>
          <path d="M14 34q0-17 18-17t18 17" stroke="#3C4A44" strokeWidth="2.6" fill="none" />
          <rect x="10.5" y="31" width="7" height="11" rx="3.5" fill="#3C4A44" />
          <rect x="46.5" y="31" width="7" height="11" rx="3.5" fill="#3C4A44" />
        </g>
      )}
      {accessory === 'leaf' && <path d="M45 24c4-1 7 1 8 4-4 1-7 0-8-4Z" fill="#7FA67A" />}
      {accessory === 'bow' && (
        <g fill="#C96A8E">
          <path d="M42 22l-6-4v8Z" />
          <path d="M42 22l6-4v8Z" />
          <circle cx="42" cy="22" r="2" />
        </g>
      )}
    </svg>
  );
}
