// How slow does each screen feel on a real network? Runs the app's data layer against local Supabase,
// adding a fixed delay to every request, and reports requests and wall time per screen.
// Usage: npm run db:reset && npm run seed && node scripts/measure.ts [delayMs]
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { createBackend } from '../web/src/data/backend.ts';

const delay = Number(process.argv[2] ?? 300);
const local = JSON.parse(execSync('npx supabase status -o json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
let count = 0;
const slowFetch: typeof fetch = async (input, init) => {
  count++;
  await new Promise((r) => setTimeout(r, delay));
  return fetch(input, init);
};
const sb = createClient(local.API_URL, local.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: slowFetch } });
const api = createBackend(sb);

async function time(label: string, fn: () => Promise<unknown>) {
  count = 0;
  const t = performance.now();
  await fn();
  console.log(`${label.padEnd(28)} ${String(count).padStart(3)} requests  ${((performance.now() - t) / 1000).toFixed(2)}s`);
}

await time('sign in', () => api.request('POST', '/auth/signin', { email: 'asha@example.com', password: 'correct horse battery' }));
const rooms = (await api.request('GET', '/rooms')).rooms;
const plans = (await api.request('GET', '/plans')).plans;
const friends = (await api.request('GET', '/friends')).friends;
await time('GET /me', () => api.request('GET', '/me'));
await time('GET /home', () => api.request('GET', '/home'));
await time('GET /rooms', () => api.request('GET', '/rooms'));
await time('GET /rooms/:id', () => api.request('GET', `/rooms/${rooms[0].id}`));
await time('GET /plans', () => api.request('GET', '/plans'));
await time('GET /plans/:id', () => api.request('GET', `/plans/${plans[0].id}`));
await time('GET /friends', () => api.request('GET', '/friends'));
await time('GET /friends/:id', () => api.request('GET', `/friends/${friends[0].user.id}`));
await time('GET /tasks (month)', () => api.request('GET', '/tasks?from=2026-10-01&to=2026-10-31'));
await time('GET /progress', () => api.request('GET', '/progress'));
await time('GET /activity', () => api.request('GET', '/activity'));
await time('GET /sessions/active', () => api.request('GET', '/sessions/active'));
process.exit(0);
