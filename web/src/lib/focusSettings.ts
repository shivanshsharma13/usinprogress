// Focus preferences for this device. They live in this browser only, because notification permission
// belongs to the device, not the account. Everything is off until you turn it on in Settings, so the
// timer behaves exactly as before.
import { useSyncExternalStore } from 'react';

export interface FocusSettings {
  notificationControls: boolean;
}

const KEY = 'us-in-progress-focus';
const DEFAULTS: FocusSettings = { notificationControls: false };
const listeners = new Set<() => void>();
let current = read();

function read(): FocusSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved && typeof saved === 'object') return { notificationControls: saved.notificationControls === true };
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
