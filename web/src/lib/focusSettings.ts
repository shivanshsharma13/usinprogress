// Preferences for this device. They live in this browser only, because notification permission and the
// app's saved files belong to the device, not the account. Timer notifications are off until you turn
// them on in Settings, so the timer behaves exactly as before.
import { useSyncExternalStore } from 'react';

export interface FocusSettings {
  notificationControls: boolean;
  fastStart: boolean; // keep the app's files on this device (web/public/sw.js)
  celebrate: boolean; // the "Yay!" screen after completing a topic (components/Celebration.tsx)
}

const KEY = 'us-in-progress-focus';
const DEFAULTS: FocusSettings = { notificationControls: false, fastStart: true, celebrate: true };
const listeners = new Set<() => void>();
let current = read();

function read(): FocusSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved && typeof saved === 'object') return { notificationControls: saved.notificationControls === true, fastStart: saved.fastStart !== false, celebrate: saved.celebrate !== false };
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
