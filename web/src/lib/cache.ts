import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';

// Opening the app shows the last screens you saw at once, then refreshes them. The copy stays in this
// browser, is deleted on sign-out, and is dropped after a day or when a new version is deployed.
// The running timer is never restored from it: it always comes fresh from the server.
const KEY = 'us-in-progress-cache';
export const CACHE_MAX_AGE = 24 * 60 * 60_000;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export const persistOptions = {
  persister: createSyncStoragePersister({ storage: storage(), key: KEY, throttleTime: 2000 }),
  maxAge: CACHE_MAX_AGE,
  buster: import.meta.env.VITE_BUILD_ID ?? 'dev',
  dehydrateOptions: {
    shouldDehydrateQuery: (q: { state: { status: string }; queryKey: readonly unknown[] }) => q.state.status === 'success' && !['session', 'sessions'].includes(String(q.queryKey[0])),
  },
};

/** Signing out: nothing from this account stays in the browser. */
export function forgetSavedScreens() {
  try {
    storage()?.removeItem(KEY);
  } catch {}
}
