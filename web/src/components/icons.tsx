// Small stroke icon set (original, 24px grid).
import type { SVGProps } from 'react';

const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
type P = SVGProps<SVGSVGElement>;

export const HomeIcon = (p: P) => (<svg {...base} {...p}><path d="M4 11.5 12 5l8 6.5" /><path d="M6 10v9h12v-9" /><path d="M10 19v-5h4v5" /></svg>);
export const GoalIcon = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></svg>);
export const CalendarIcon = (p: P) => (<svg {...base} {...p}><rect x="4" y="5.5" width="16" height="14" rx="3" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /></svg>);
export const RoomIcon = (p: P) => (<svg {...base} {...p}><path d="M12 20c0-6 0-9 0-11" /><path d="M12 12c-4 0-6-2-6-5 3 0 6 1.5 6 5Z" /><path d="M12 9.5c0-3 2.5-5 6-5 0 3.5-2.5 5-6 5Z" /><path d="M7 20h10" /></svg>);
export const FriendsIcon = (p: P) => (<svg {...base} {...p}><circle cx="9" cy="9" r="3.2" /><circle cx="16.5" cy="10" r="2.6" /><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6" /><path d="M15 14.6c2.6-.3 4.8 1.1 5.4 3.9" /></svg>);
export const ChartIcon = (p: P) => (<svg {...base} {...p}><path d="M5 19V11M10 19V6M15 19v-5M20 19V9" /></svg>);
export const SettingsIcon = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></svg>);
export const PlayIcon = (p: P) => (<svg {...base} {...p}><path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" stroke="none" /></svg>);
export const PauseIcon = (p: P) => (<svg {...base} {...p}><rect x="7" y="5.5" width="3.5" height="13" rx="1" fill="currentColor" stroke="none" /><rect x="13.5" y="5.5" width="3.5" height="13" rx="1" fill="currentColor" stroke="none" /></svg>);
export const StopIcon = (p: P) => (<svg {...base} {...p}><rect x="6.5" y="6.5" width="11" height="11" rx="2" /></svg>);
export const CheckIcon = (p: P) => (<svg {...base} {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>);
export const PlusIcon = (p: P) => (<svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>);
export const XIcon = (p: P) => (<svg {...base} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>);
export const MoreIcon = (p: P) => (<svg {...base} {...p}><circle cx="6" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="18" cy="12" r="1.3" fill="currentColor" /></svg>);
export const ChevronLeft = (p: P) => (<svg {...base} {...p}><path d="m14.5 6-6 6 6 6" /></svg>);
export const ChevronRight = (p: P) => (<svg {...base} {...p}><path d="m9.5 6 6 6-6 6" /></svg>);
export const ChevronDown = (p: P) => (<svg {...base} {...p}><path d="m6 9.5 6 6 6-6" /></svg>);
export const SunIcon = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></svg>);
export const MoonIcon = (p: P) => (<svg {...base} {...p}><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" /></svg>);
export const BellIcon = (p: P) => (<svg {...base} {...p}><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15Z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg>);
export const SearchIcon = (p: P) => (<svg {...base} {...p}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>);
export const ArrowUp = (p: P) => (<svg {...base} {...p}><path d="M12 19V5M6 11l6-6 6 6" /></svg>);
export const ArrowDown = (p: P) => (<svg {...base} {...p}><path d="M12 5v14M6 13l6 6 6-6" /></svg>);
export const NextIcon = (p: P) => (<svg {...base} {...p}><path d="M6 5.5v13l9-6.5Z" fill="currentColor" stroke="none" /><path d="M18 5.5v13" /></svg>);
