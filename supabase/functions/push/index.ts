// Sends phone notifications (Settings → Motivation & focus → Phone notifications). Only the database calls
// it, with a shared secret (see migrations/20261111000000_push_notifications.sql). It never reads the
// database: each call carries the browser subscriptions to deliver to and the notification itself.
//
// Secrets (supabase secrets set ...): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_WEBHOOK_SECRET, and
// optionally VAPID_SUBJECT (a mailto: or https: contact for the push services).
import { sendPush, type PushSubscriptionKeys, type VapidKeys } from './webpush.ts';

const env = (name: string) => Deno.env.get(name) ?? '';
const keys: VapidKeys = {
  publicKey: env('VAPID_PUBLIC_KEY'),
  privateKey: env('VAPID_PRIVATE_KEY'),
  subject: env('VAPID_SUBJECT') || 'https://shivanshsharma13.github.io/usinprogress/',
};

Deno.serve(async (req) => {
  const secret = env('PUSH_WEBHOOK_SECRET');
  if (req.method !== 'POST' || !secret || req.headers.get('x-push-secret') !== secret) return new Response('Forbidden', { status: 403 });
  if (!keys.publicKey || !keys.privateKey) return new Response('VAPID keys are not set', { status: 500 });
  const { subscriptions, notification } = (await req.json()) as { subscriptions: PushSubscriptionKeys[]; notification: Record<string, unknown> };
  const results = await Promise.allSettled((subscriptions ?? []).slice(0, 20).map((s) => sendPush(s, notification, keys)));
  const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value : 0));
  return Response.json({ statuses });
});
