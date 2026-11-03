// Focus preferences for this device (sound, notification controls). They live in this browser only,
// because sound and notification permission belong to the device, not the account. Everything is off
// until you turn it on in Settings, so the timer behaves exactly as before.
import { useSyncExternalStore } from 'react';

export type FocusSound = 'off' | 'rain' | 'brown' | 'waves';

export interface FocusSettings {
  sound: FocusSound;
  volume: number; // 0–1
  notificationControls: boolean;
}

export const FOCUS_SOUNDS: { key: Exclude<FocusSound, 'off'>; label: string }[] = [
  { key: 'rain', label: 'Rain' },
  { key: 'brown', label: 'Brown noise' },
  { key: 'waves', label: 'Ocean waves' },
];

const KEY = 'us-in-progress-focus';
const DEFAULTS: FocusSettings = { sound: 'off', volume: 0.5, notificationControls: false };
const listeners = new Set<() => void>();
let current = read();

function read(): FocusSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULTS, ...saved };
  } catch {}
  return DEFAULTS;
}

export function getFocusSettings(): FocusSettings {
  return current;
}

export function setFocusSettings(patch: Partial<FocusSettings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {}
  for (const l of listeners) l();
}

export function useFocusSettings(): FocusSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
