// Talking to the background worker (web/public/sw.js), which shows notifications. Phones (Android
// Chrome) only allow notifications through a worker, so even the one-hour reminder goes through it.
import type { ActiveSession } from '@shared/types';
import { supabase } from './supabase';

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;

let worker: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers the worker the first time a notification is needed. */
export function notificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!notificationsSupported()) return Promise.resolve(null);
  worker ??= navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
  return worker;
}

async function post(message: Record<string, unknown>) {
  const reg = await notificationWorker();
  reg?.active?.postMessage(message);
}

/** A one-off notice, e.g. the one-hour reminder. Quietly does nothing without permission. */
export async function notify(title: string, body: string, tag?: string) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  await post({ type: 'notify', title, body, tag });
}

export const showTimerNotification = (session: ActiveSession) => post({ type: 'show', session });
export const closeTimerNotification = () => (notificationsSupported() && worker ? post({ type: 'close' }) : Promise.resolve());

/**
 * Lets the worker pause/resume while the app's tab is frozen: it keeps the current short-lived access
 * token (never the refresh token), and forgets it on sign-out or when notification controls go off.
 */
export async function shareSignIn(on: boolean) {
  if (!notificationsSupported()) return;
  const token = on ? (await supabase.auth.getSession()).data.session?.access_token : null;
  await post({ type: 'auth', url: import.meta.env.VITE_SUPABASE_URL, key: import.meta.env.VITE_SUPABASE_ANON_KEY, token: token ?? null });
}
