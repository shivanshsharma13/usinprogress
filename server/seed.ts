// Development seed: two friends with a shared room, a sprint plan each, sessions and calendar tasks.
// Usage: npm run seed  (refuses to run in production or on a database that already has users)
import { Database, get, run, newId } from './db.ts';
import { hashPassword } from './auth.ts';
import { addDays, localDate } from '../shared/dates.ts';
import { createRoom, completeTopic } from './services/rooms.ts';
import { sendFriendRequest, respondToRequest, encourage } from './services/social.ts';
import { addSprint, addTask, createPlan, pullSprint } from './services/plans.ts';
import { createTask } from './services/tasks.ts';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

// Demo accounts don't belong in your real (e.g. Supabase) database, so a remote one needs an explicit opt-in.
const url = process.env.DATABASE_URL || './data/pglite';
if (/^postgres/.test(url) && process.env.SEED_ALLOW_REMOTE !== 'true') {
  console.error('DATABASE_URL points at a real Postgres database. Set SEED_ALLOW_REMOTE=true if you really want demo data there.');
  process.exit(1);
}
const db = await Database.open(url);
if (await get(db, 'SELECT 1 FROM users LIMIT 1')) {
  console.error('This database already has users. Delete ./data to start fresh, or point DATABASE_URL somewhere empty.');
  process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD ?? 'garden-demo-1';
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = localDate(Date.now(), tz);

async function user(username: string, displayName: string, profileType: 'engineer' | 'doctor', bio: string, accessory: string) {
  const id = newId();
  await run(
    db,
    'INSERT INTO users (id, username, display_name, profile_type, accent, bio, avatar, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    username,
    displayName,
    profileType,
    profileType === 'engineer' ? 'blue' : 'pink',
    bio,
    JSON.stringify({ accessory }),
    tz,
    Date.now(),
  );
  await run(db, 'INSERT INTO auth_credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)', id, hashPassword(PASSWORD), Date.now());
  return id;
}

const asha = await user('asha', 'Asha', 'engineer', 'Getting interview-ready, one problem at a time.', 'glasses');
const mira = await user('mira', 'Mira', 'doctor', 'Biochemistry, revision, and lots of tea.', 'stethoscope');

const req = await sendFriendRequest(db, asha, mira);
await respondToRequest(db, mira, req.id, true);

// One shared room. Each person pulls the current sprint of their own plan into it.
const room = await createRoom(db, asha, { friendId: mira, name: 'Our 90-Day Growth Plan', description: 'DSA for Asha, medicine for Mira.', startDate: today, endDate: addDays(today, 90), color: 'sage' });

// Asha's plan: sprints of 12 days, started 5 days ago, so today is Day 6. Sprints are added as needed.
const gtfo = await createPlan(db, asha, { title: 'GTFO 2026', startDate: addDays(today, -5), sprintDays: 12 });
await addSprint(db, asha, gtfo);
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
for (const [day, tasks] of ashaDays.entries()) for (const [title, est] of tasks) await addTask(db, asha, gtfo, { day, title, estMinutes: est });

// Mira's plan: 14-day sprints, started 2 days ago.
const med = await createPlan(db, mira, { title: 'Medical syllabus 2026', startDate: addDays(today, -2), sprintDays: 14 });
const miraDays: [string, number][][] = [
  [['Enzyme kinetics', 90], ['Michaelis–Menten questions', 40]],
  [['Glycolysis', 80], ['TCA cycle', 60]],
  [['Carbohydrate metabolism revision', 70], ['Lipid metabolism', 90], ['Pharmacology flashcards', 30]],
  [['Amino acid metabolism', 90]],
  [['Cardiovascular physiology', 120]],
];
for (const [day, tasks] of miraDays.entries()) for (const [title, est] of tasks) await addTask(db, mira, med, { day, title, estMinutes: est });

await pullSprint(db, asha, gtfo, 1, room);
await pullSprint(db, mira, med, 1, room);

const topicOf = async (planId: string, title: string) =>
  (await get<{ topic_id: string }>(db, 'SELECT topic_id FROM plan_tasks WHERE plan_id = ? AND title = ?', planId, title))!.topic_id;

// A few finished sessions so progress screens have something to show.
async function pastSession(userId: string, roomId: string, topicId: string, minutesAgo: number, minutes: number) {
  const start = Date.now() - minutesAgo * 60_000;
  await run(
    db,
    `INSERT INTO study_sessions (id, user_id, room_id, topic_id, state, started_at, ended_at, focused_ms, measured_ms, local_date, created_at)
     VALUES (?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?)`,
    newId(),
    userId,
    roomId,
    topicId,
    start,
    start + minutes * 60_000,
    minutes * 60_000,
    minutes * 60_000,
    localDate(start, tz),
    start,
  );
  await run(db, "UPDATE topic_progress SET status = 'in_progress', updated_at = ? WHERE topic_id = ? AND user_id = ? AND status = 'not_started'", Date.now(), topicId, userId);
}
// Day 1 and Day 5 partly done, days 2–4 missed, today not started.
await pastSession(asha, room, await topicOf(gtfo, 'Set Matrix Zeroes'), 5 * 24 * 60, 35);
await pastSession(asha, room, await topicOf(gtfo, 'Pascal’s Triangle'), 5 * 24 * 60 - 60, 22);
await pastSession(asha, room, await topicOf(gtfo, 'Merge Sorted Arrays'), 26 * 60, 28);
await completeTopic(db, asha, await topicOf(gtfo, 'Set Matrix Zeroes'));
await completeTopic(db, asha, await topicOf(gtfo, 'Pascal’s Triangle'));
await completeTopic(db, asha, await topicOf(gtfo, 'Merge Sorted Arrays'));
await run(db, 'UPDATE plan_tasks SET starred = 1 WHERE plan_id = ? AND title IN (?, ?)', gtfo, 'Count Inversions', 'Reverse Pairs');

await pastSession(mira, room, await topicOf(med, 'Enzyme kinetics'), 2 * 24 * 60, 85);
await pastSession(mira, room, await topicOf(med, 'Glycolysis'), 24 * 60, 70);
await completeTopic(db, mira, await topicOf(med, 'Enzyme kinetics'));
await completeTopic(db, mira, await topicOf(med, 'Michaelis–Menten questions'));
await completeTopic(db, mira, await topicOf(med, 'Glycolysis'));

await createTask(db, asha, { title: 'Mock interview prep', date: addDays(today, 2), startTime: '19:00', durationMinutes: 60, shared: true });
await createTask(db, mira, { title: 'Ward rounds — light study day', date: addDays(today, 1), shared: true });

await encourage(db, mira, { recipientId: asha, reaction: 'proud' });

console.log(`Seeded two friends. Sign in as "asha" or "mira" with password "${PASSWORD}" (development only).`);
await db.close();
