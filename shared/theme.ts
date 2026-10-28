// Identity colours. A member's accent is stored on their profile and used everywhere
// (cards, calendar, progress) so both people always see the same colour for the same person.

export type ProfileType = 'engineer' | 'doctor' | 'custom';

export interface Accent {
  key: string;
  label: string;
  solid: string;      // light-mode accent
  surface: string;    // light-mode pale surface
  solidDark: string;  // dark-mode accent (slightly softer)
  surfaceDark: string;
}

export const ACCENTS: Record<string, Accent> = {
  blue: { key: 'blue', label: 'Calm blue', solid: '#6B91D8', surface: '#EAF1FC', solidDark: '#86A6E2', surfaceDark: '#27303F' },
  pink: { key: 'pink', label: 'Soft pink', solid: '#D98EAE', surface: '#FBEAF1', solidDark: '#E3A3BE', surfaceDark: '#3A2A31' },
  lavender: { key: 'lavender', label: 'Lavender', solid: '#9C95D6', surface: '#EFEDFA', solidDark: '#B2ACE2', surfaceDark: '#2F2D3E' },
  sage: { key: 'sage', label: 'Sage', solid: '#7FA67A', surface: '#EAF2E6', solidDark: '#97BC92', surfaceDark: '#2A3529' },
  peach: { key: 'peach', label: 'Peach', solid: '#D9A07A', surface: '#FBEFE6', solidDark: '#E4B593', surfaceDark: '#3A3029' },
};

export const DEFAULT_ACCENT: Record<ProfileType, string> = {
  engineer: 'blue',
  doctor: 'pink',
  custom: 'lavender',
};

export function accentOf(key: string | undefined | null): Accent {
  return (key && ACCENTS[key]) || ACCENTS.sage;
}

export const ROOM_COLORS = ['sage', 'blue', 'pink', 'lavender', 'peach'] as const;

export interface AvatarConfig {
  accessory?: 'none' | 'glasses' | 'stethoscope' | 'headphones' | 'leaf' | 'bow';
  mood?: 'happy' | 'calm' | 'sleepy';
}

export const REACTIONS = {
  proud: { emoji: '❤️', label: 'Proud of you' },
  keep_going: { emoji: '💪', label: 'Keep going' },
  one_step: { emoji: '🌱', label: 'One step at a time' },
  you_got_this: { emoji: '✨', label: "You've got this" },
} as const;

export type ReactionKey = keyof typeof REACTIONS;
