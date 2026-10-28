// Demo data for local development: two friends, a shared room and a sprint plan each.
// Usage: npm run db:reset && npm run seed   (local Supabase only — never your hosted project)
import { addDays } from '../shared/dates.ts';
import { closeClients, signUp, startServer } from '../tests/helpers.ts';

const srv = await startServer();
const db = srv.db;
if (!/127\.0\.0\.1|localhost/.test(srv.base)) {
  console.error('This seed only runs against a local Supabase.');
  process.exit(1);
}
if ((await db.query('SELECT 1 FROM profiles LIMIT 1')).length) {
  console.error('The local database already has people in it. Run `npm run db:reset` first.');
  process.exit(1);
}

const { client: asha, me: a } = await signUp(srv.base, 'asha', 'engineer');
const { client: mira, me: m } = await signUp(srv.base, 'mira', 'doctor');
const request = await asha.post('/friends/requests', { userId: m.id });
await mira.post(`/friends/requests/${request.body.id}/accept`);

const today = a.today;
const room = (await asha.post('/rooms', { friendId: m.id, name: 'Our 90-Day Growth Plan', description: 'DSA for Asha, medicine for Mira.', startDate: today, endDate: addDays(today, 90), color: 'sage' })).body.id;

// Asha: 12-day sprints, started 5 days ago, so today is Day 6.
const gtfo = (await asha.post('/plans', { title: 'GTFO 2026', startDate: addDays(today, -5), sprintDays: 12 })).body.id;
await asha.post(`/plans/${gtfo}/sprints`, {});
const ashaDays: [string, number][][] = [
  [['Set Matrix Zeroes', 30], ['Pascal’s Triangle', 20], ['Next Permutation (first try)', 30]],
  [['Kadane’s Algorithm', 25], ['Sort 0s, 1s and 2s', 20]],
  [['Stock Buy and Sell', 20], ['Rotate Matrix', 25]],
  [['Merge Overlapping Intervals', 30]],
  [['Merge Sorted Arrays', 25], ['Find the Duplicate', 20]],
  [['Next Permutation', 26], ['Majority Element II', 25], ['Find the repeating and missing number', 41], ['Count Inversions', 23], ['Reverse Pairs', 31], ['Maximum Product Subarray', 18]],
  [['Two Sum', 15], ['4 Sum', 30], ['Longest Consecutive Sequence', 25]],
  [['Largest Subarray with 0 Sum', 25], ['Subarrays with XOR K', 30]],
];
for (const [day, tasks] of ashaDays.entries()) for (const [title, estMinutes] of tasks) await asha.post(`/plans/${gtfo}/tasks`, { day, title, estMinutes });
await asha.post(`/plans/${gtfo}/sprints/1/pull`, { roomId: room });

// Mira: 14-day sprints, started 2 days ago.
const med = (await mira.post('/plans', { title: 'Medical syllabus 2026', startDate: addDays(today, -2), sprintDays: 14 })).body.id;
const miraDays: [string, number][][] = [
  [['Enzyme kinetics', 90], ['Michaelis–Menten questions', 40]],
  [['Glycolysis', 80], ['TCA cycle', 60]],
  [['Carbohydrate metabolism revision', 70], ['Lipid metabolism', 90], ['Pharmacology flashcards', 30]],
  [['Amino acid metabolism', 90]],
];
for (const [day, tasks] of miraDays.entries()) for (const [title, estMinutes] of tasks) await mira.post(`/plans/${med}/tasks`, { day, title, estMinutes });
await mira.post(`/plans/${med}/sprints/1/pull`, { roomId: room });

// Some finished work, dated on the days it was planned for.
const topicOf = async (planId: string, title: string) => (await db.query('SELECT topic_id FROM plan_tasks WHERE plan_id = ? AND title = ?', [planId, title]))[0].topic_id as string;
async function didIt(client: typeof asha, planId: string, title: string, daysAgo: number, minutes: number) {
  const topicId = await topicOf(planId, title);
  const s = (await client.post('/sessions', { topicId })).body.session;
  await client.post(`/sessions/${s.id}/finish`, { completeTopic: true });
  const when = Date.now() - daysAgo * 86_400_000;
  await db.query('UPDATE study_sessions SET started_at = ?, ended_at = ?, focused_ms = ?, measured_ms = ?, local_date = ? WHERE id = ?', [when, when + minutes * 60_000, minutes * 60_000, minutes * 60_000, addDays(today, -daysAgo), s.id]);
  await db.query('UPDATE topic_completions SET completed_at = ?, local_date = ? WHERE topic_id = ?', [when, addDays(today, -daysAgo), topicId]);
}
await didIt(asha, gtfo, 'Set Matrix Zeroes', 5, 35);
await didIt(asha, gtfo, 'Pascal’s Triangle', 5, 22);
await didIt(asha, gtfo, 'Merge Sorted Arrays', 1, 28);
for (const title of ['Count Inversions', 'Reverse Pairs']) {
  const id = (await db.query('SELECT id FROM plan_tasks WHERE plan_id = ? AND title = ?', [gtfo, title]))[0].id;
  await asha.patch(`/plan-tasks/${id}`, { starred: true });
}
await didIt(mira, med, 'Enzyme kinetics', 2, 85);
await didIt(mira, med, 'Michaelis–Menten questions', 2, 40);
await didIt(mira, med, 'Glycolysis', 1, 70);

await asha.post('/tasks', { title: 'Mock interview prep', date: addDays(today, 2), startTime: '19:00', durationMinutes: 60, shared: true });
await mira.post('/encourage', { recipientId: a.id, reaction: 'proud' });

console.log('Seeded local demo: sign in as asha@example.com or mira@example.com with password "correct horse battery".');
await closeClients();
await srv.close();
