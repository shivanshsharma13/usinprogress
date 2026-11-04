// Us in Progress background worker. It shows notifications (the timer notification, shown while you're
// away from the app with Pause/Resume, and the one-hour reminder) and, unless "Fast start" is off in
// Settings, keeps the app's own files on the device so it opens quickly on a weak connection. Your data
// never goes through this cache: it comes from Supabase, which the worker doesn't touch.
//
// Pause/Resume call the database directly with your current sign-in, so they work even when the
// phone has frozen the app's tab. If that sign-in has expired, the app opens and does it instead.

const TAG = 'uip-timer';
const scope = self.registration.scope;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);

// ───────────── sign-in, kept in IndexedDB so it survives the worker restarting ─────────────

function db() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('uip-worker', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function kv(key, value) {
  const store = (await db()).transaction('kv', value === undefined ? 'readonly' : 'readwrite').objectStore('kv');
  return new Promise((resolve, reject) => {
    const req = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ───────────── fast start ─────────────

const CACHE = 'uip-app-v1';
const SHELL = scope; // every page of the app is the same index.html
const STATIC = ['manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
const NETWORK_WAIT_MS = 3500; // after this, a slow network loses to the copy on the device

let fastStart = kv('fastStart').then((v) => v !== false, () => true);

function setFastStart(on) {
  fastStart = Promise.resolve(on);
  return Promise.all([kv('fastStart', on), on ? null : caches.delete(CACHE)]);
}

// Built files have a content hash in their name, so a copy never goes stale. Once a new index.html
// arrives, files it no longer mentions are dropped (others reload the next time they're needed).
async function keepShell(response) {
  const cache = await caches.open(CACHE);
  await cache.put(SHELL, response.clone());
  const html = await response.text();
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.includes('/assets/') && !html.includes(path.slice(path.lastIndexOf('/assets/') + 1))) await cache.delete(req);
  }
}

async function page(event) {
  const network = fetch(event.request).then((res) => {
    if (res.ok || res.status === 404) event.waitUntil(keepShell(res.clone())); // GitHub Pages serves app routes as 404 + index.html
    return res;
  });
  const saved = await caches.match(SHELL);
  if (!saved) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(saved), NETWORK_WAIT_MS));
  return Promise.race([network.catch(() => saved), timeout]);
}

async function file(event) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(event.request);
  if (saved && event.request.url.includes('/assets/')) return saved;
  const fresh = fetch(event.request).then((res) => {
    if (res.ok) event.waitUntil(cache.put(event.request, res.clone()));
    return res;
  });
  if (!saved) return fresh;
  fresh.catch(() => null); // icons and the manifest refresh in the background
  return saved;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(scope)) return;
  const rel = req.url.slice(scope.length).split(/[?#]/)[0];
  const isPage = req.mode === 'navigate';
  const isFile = rel.startsWith('assets/') || STATIC.includes(rel);
  if (!isPage && !isFile) return;
  event.respondWith(fastStart.then((on) => (on ? (isPage ? page(event) : file(event)) : fetch(req))));
});

// ───────────── the timer notification ─────────────

function focusedMs(s, now) {
  let paused = 0;
  for (const p of s.pauses || []) paused += (p.resumedAt ?? now) - p.pausedAt;
  return Math.max(0, now - s.startedAt - paused);
}

function minutes(ms) {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function showTimer(s) {
  const running = s.state === 'running';
  const focused = focusedMs(s, Date.now());
  await self.registration.showNotification(`${running ? 'Studying' : 'Paused'} · ${s.topicTitle}`, {
    tag: TAG,
    body: `${minutes(focused)} focused · ${s.roomName}${s.targetMinutes ? ` · goal ${s.targetMinutes} min` : ''}`,
    icon: `${scope}favicon.svg`,
    // Android shows this as "12m" and keeps it current, so the header roughly tracks focused time.
    timestamp: running ? Date.now() - focused : Date.now(),
    silent: true,
    renotify: false,
    requireInteraction: true,
    actions: [
      { action: running ? 'pause' : 'resume', title: running ? 'Pause' : 'Resume' },
      { action: 'open', title: 'Open timer' },
    ],
    data: s,
  });
}

async function closeTimer() {
  for (const n of await self.registration.getNotifications({ tag: TAG })) n.close();
}

async function tellPages(message) {
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage(message);
}

async function openApp(path) {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const page = pages.find((c) => c.url.startsWith(scope));
  if (page) {
    await page.focus();
    page.postMessage({ type: 'open', path });
    return;
  }
  await self.clients.openWindow(scope + path);
}

async function pauseOrResume(action, s) {
  const auth = await kv('auth').catch(() => null);
  if (auth?.token) {
    const res = await fetch(`${auth.url}/rest/v1/rpc/${action}_session`, {
      method: 'POST',
      headers: { apikey: auth.key, Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_session: s.id }),
    }).catch(() => null);
    if (res?.ok) {
      const session = await res.json();
      await showTimer(session);
      await tellPages({ type: 'session', session });
      return;
    }
    if (res && res.status !== 401) {
      // Already finished or changed elsewhere: let the app sort it out.
      await tellPages({ type: 'refresh' });
      return;
    }
  }
  await openApp(`study?timer=${action}`);
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  n.close();
  if (n.tag === TAG && (event.action === 'pause' || event.action === 'resume')) event.waitUntil(pauseOrResume(event.action, n.data));
  else event.waitUntil(openApp(n.tag === TAG ? 'study' : ''));
});

self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type === 'fastStart') event.waitUntil(setFastStart(m.on !== false));
  if (m.type === 'auth') event.waitUntil(kv('auth', m.token ? { url: m.url, key: m.key, token: m.token } : null));
  if (m.type === 'show') event.waitUntil(showTimer(m.session));
  if (m.type === 'close') event.waitUntil(closeTimer());
  if (m.type === 'notify') event.waitUntil(self.registration.showNotification(m.title, { body: m.body, icon: `${scope}favicon.svg`, tag: m.tag }));
});
