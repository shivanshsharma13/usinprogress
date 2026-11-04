// Phone notifications (Settings → Motivation & focus). This device's browser push subscription is saved to
// your account so news from your friend reaches you even when the app is closed. Which news you get is
// an account setting (prefs); whether this device gets it is this subscription.
import { api } from './api';
import { notificationWorker, notificationsSupported } from './notifications';

const PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export const pushConfigured = () => Boolean(PUBLIC_KEY);
export const pushSupported = () => notificationsSupported() && 'PushManager' in window;

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function subscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await notificationWorker();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

const save = (sub: PushSubscription) => {
  const { endpoint, keys } = sub.toJSON();
  return api.post('/push/subscribe', { endpoint, p256dh: keys?.p256dh, auth: keys?.auth });
};

export async function pushOnHere(): Promise<boolean> {
  return pushSupported() && Notification.permission === 'granted' && Boolean(await subscription());
}

/** Asks for permission if needed and subscribes this device. */
export async function enablePush(): Promise<'on' | 'denied' | 'unavailable'> {
  if (!pushSupported() || !PUBLIC_KEY) return 'unavailable';
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return 'denied';
  const reg = await notificationWorker();
  if (!reg) return 'unavailable';
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUBLIC_KEY) }));
  await save(sub);
  return 'on';
}

/** Stops notifications on this device (also done when you sign out). */
export async function disablePush() {
  const sub = await subscription().catch(() => null);
  if (!sub) return;
  await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

/** On start: re-save this device's subscription so it belongs to whoever is signed in now. */
export async function refreshPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await subscription().catch(() => null);
  if (sub) await save(sub).catch(() => undefined);
}
