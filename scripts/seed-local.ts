// Demo data for local development: two friends, a shared room, and a goal each of topics and planned subtopics.
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

// A goal each, in the room: main topics, each with subtopics planned for a day and how long they take.
// [topic, [subtopic, days from today, minutes][]] — a topic with no subtopics is planned whole for that day.
type Plan = [string, [string, number, number][]][];
const ashaPlan: Plan = [
  ['Arrays', [['Set Matrix Zeroes', -3, 30], ['Pascal’s Triangle', -3, 20], ['Next Permutation', -1, 30], ['Kadane’s Algorithm', 0, 25]]],
  ['Sorting tricks', [['Sort 0s, 1s and 2s', -1, 20], ['Merge Overlapping Intervals', 0, 30], ['Merge Sorted Arrays', 1, 25]]],
  ['Count Inversions', [['Brute force', 0, 15], ['Merge sort way', 0, 30], ['Edge cases', 2, 15]]],
  ['Hashing', [['Two Sum', 1, 15], ['4 Sum', 1, 30], ['Longest Consecutive Sequence', 3, 25], ['Subarrays with XOR K', 4, 30]]],
  ['Mock interview', []],
];
const miraPlan: Plan = [
  ['Enzymes', [['Enzyme kinetics', -2, 90], ['Michaelis–Menten questions', -2, 40], ['Inhibition', 0, 45]]],
  ['Carbohydrate metabolism', [['Glycolysis', -1, 80], ['TCA cycle', 0, 60], ['Revision', 2, 70]]],
  ['Lipid metabolism', [['Fatty acid oxidation', 1, 60], ['Ketone bodies', 3, 45]]],
  ['Pharmacology flashcards', []],
];

async function makeGoal(client: typeof asha, title: string, plan: Plan, wholeDay: number) {
  const goal = (await client.post('/plans', { title, roomId: room })).body.id as string;
  for (const [topic, parts] of plan) {
    const task = (await client.post(`/plans/${goal}/goal-tasks`, { title: topic, date: parts.length ? null : addDays(today, wholeDay), estMinutes: parts.length ? null : 45 })).body.id;
    const topicId = (await db.query('SELECT topic_id FROM plan_tasks WHERE id = ?', [task]))[0].topic_id as string;
    for (const [sub, day, minutes] of parts) await client.post(`/topics/${topicId}/subtopics`, { title: sub, date: addDays(today, day), estMinutes: minutes });
  }
  return goal;
}
await makeGoal(asha, 'GTFO 2026', ashaPlan, 2);
await makeGoal(mira, 'Medical syllabus 2026', miraPlan, 0);

// Some finished work, dated on the days it was planned for: a session on the subtopic, then it's ticked.
async function didIt(client: typeof asha, title: string, minutes: number) {
  const part = (await db.query('SELECT id, topic_id, planned_for FROM subtopics WHERE title = ?', [title]))[0];
  const s = (await client.post('/sessions', { topicId: part.topic_id, subtopicId: part.id })).body.session;
  await client.post(`/sessions/${s.id}/finish`, { completeTopic: true });
  const when = Date.parse(`${part.planned_for}T10:00:00Z`);
  await db.query('UPDATE study_sessions SET started_at = ?, ended_at = ?, focused_ms = ?, measured_ms = ?, local_date = ? WHERE id = ?', [when, when + minutes * 60_000, minutes * 60_000, minutes * 60_000, part.planned_for, s.id]);
  await db.query('UPDATE subtopics SET done_at = ? WHERE id = ?', [when + minutes * 60_000, part.id]);
}
for (const [title, minutes] of [['Set Matrix Zeroes', 35], ['Pascal’s Triangle', 22], ['Next Permutation', 28], ['Sort 0s, 1s and 2s', 18]] as const) await didIt(asha, title, minutes);
for (const [title, minutes] of [['Enzyme kinetics', 85], ['Michaelis–Menten questions', 40], ['Glycolysis', 70]] as const) await didIt(mira, title, minutes);

await mira.post('/encourage', { recipientId: a.id, reaction: 'proud' });

console.log('Seeded local demo: sign in as asha@example.com or mira@example.com with password "correct horse battery".');
await closeClients();
await srv.close();
